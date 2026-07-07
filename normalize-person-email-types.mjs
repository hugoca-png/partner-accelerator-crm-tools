import { readFile, writeFile } from "node:fs/promises";

const APPLY = process.argv.includes("--apply");

const cache = JSON.parse(await readFile("capsule-cache.json", "utf8"));
const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN não encontrado.");

const personalDomains = new Set([
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "hotmail.pt",
  "outlook.com",
  "outlook.pt",
  "live.com",
  "live.pt",
  "msn.com",
  "sapo.pt",
  "yahoo.com",
  "yahoo.pt",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "fastmail.com",
]);

const orgById = new Map((cache.organisations || []).map((org) => [String(org.id), org]));

function clean(value) {
  return String(value || "").trim();
}

function emailDomain(email) {
  return clean(email).toLocaleLowerCase("pt-PT").split("@")[1]?.replace(/^www\./i, "") || "";
}

function baseDomain(domain) {
  const parts = clean(domain).toLocaleLowerCase("pt-PT").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const twoLevelTlds = new Set(["co.uk", "com.br", "com.au"]);
  const lastTwo = parts.slice(-2).join(".");
  if (twoLevelTlds.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join(".");
  return lastTwo;
}

function compactToken(value) {
  return clean(value)
    .toLocaleLowerCase("pt-PT")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function isCurrentCompanyEmail(email, org) {
  const domain = emailDomain(email);
  if (!domain || !org) return false;
  const domains = (org.domains || []).map((item) => clean(item).toLocaleLowerCase("pt-PT")).filter(Boolean);
  if (domains.includes(domain)) return true;
  if (domains.some((item) => baseDomain(item) === baseDomain(domain))) return true;
  const emailToken = compactToken(baseDomain(domain).split(".")[0]);
  if (emailToken.length < 4) return false;
  const orgTokens = [org.name, org.url, ...domains].map(compactToken).filter(Boolean);
  return orgTokens.some((token) => token.includes(emailToken) || emailToken.includes(token));
}

function desiredType(email, org) {
  if (isCurrentCompanyEmail(email, org)) return "Work";
  const domain = emailDomain(email);
  if (personalDomains.has(domain)) return "Home";
  return "Work";
}

async function capsuleFetch(path, options = {}) {
  const url = path.startsWith("http") ? path : `https://api.capsulecrm.com/api/v2${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`Capsule ${response.status}: ${await response.text()}`);
  return {
    data: response.status === 204 ? null : await response.json(),
    link: response.headers.get("link") || "",
  };
}

function nextLink(linkHeader) {
  const match = linkHeader.replace(/&amp;/g, "&").match(/<([^>]+)>;\s*rel="next"/i);
  return match ? match[1] : null;
}

function partyName(party) {
  return party.name || [party.firstName, party.lastName].filter(Boolean).join(" ") || `(sem nome: ${party.id})`;
}

async function fetchAllParties() {
  let url = "/parties?perPage=100&embed=organisation";
  const parties = [];
  while (url) {
    const { data, link } = await capsuleFetch(url);
    parties.push(...(data.parties || []));
    url = nextLink(link);
  }
  return parties;
}

const parties = await fetchAllParties();
const planned = [];
const alreadyCorrect = [];

for (const party of parties.filter((item) => item.type === "person")) {
  const org = orgById.get(String(party.organisation?.id || ""));
  const changes = [];
  for (const entry of party.emailAddresses || []) {
    const address = clean(entry.address);
    if (!address || !entry.id) continue;
    const wanted = desiredType(address, org);
    const current = clean(entry.type);
    const classification = wanted === "Home" ? "personal" : "professional";
    const row = {
      id: entry.id,
      address,
      currentType: current,
      desiredType: wanted,
      classification,
      domain: emailDomain(address),
    };
    if (current !== wanted) changes.push(row);
    else alreadyCorrect.push(row);
  }
  if (changes.length) {
    planned.push({
      partyId: String(party.id),
      party: partyName(party),
      organisation: party.organisation?.name || "",
      changes,
    });
  }
}

const updated = [];
const errors = [];
if (APPLY) {
  for (const item of planned) {
    try {
      await capsuleFetch(`/parties/${item.partyId}`, {
        method: "PUT",
        body: JSON.stringify({
          party: {
            emailAddresses: item.changes.map((change) => ({
              id: change.id,
              type: change.desiredType,
            })),
          },
        }),
      });
      updated.push({ ...item, status: "updated" });
    } catch (error) {
      errors.push({ ...item, status: "error", error: error.message || String(error) });
    }
  }
}

const output = {
  generatedAt: new Date().toISOString(),
  applied: APPLY,
  totalPersonEmails: alreadyCorrect.length + planned.reduce((sum, item) => sum + item.changes.length, 0),
  alreadyCorrect: alreadyCorrect.length,
  plannedProfiles: planned.length,
  plannedChanges: planned.reduce((sum, item) => sum + item.changes.length, 0),
  plannedProfessionalToWork: planned.flatMap((item) => item.changes).filter((item) => item.desiredType === "Work").length,
  plannedPersonalToHome: planned.flatMap((item) => item.changes).filter((item) => item.desiredType === "Home").length,
  updatedProfiles: updated.length,
  updatedChanges: updated.reduce((sum, item) => sum + item.changes.length, 0),
  errors,
  planned,
  updated,
};

await writeFile("normalize-person-email-types-report.json", JSON.stringify(output, null, 2), "utf8");
console.log(JSON.stringify({
  applied: output.applied,
  totalPersonEmails: output.totalPersonEmails,
  alreadyCorrect: output.alreadyCorrect,
  plannedProfiles: output.plannedProfiles,
  plannedChanges: output.plannedChanges,
  plannedProfessionalToWork: output.plannedProfessionalToWork,
  plannedPersonalToHome: output.plannedPersonalToHome,
  updatedProfiles: output.updatedProfiles,
  updatedChanges: output.updatedChanges,
  errors: output.errors.length,
  report: "normalize-person-email-types-report.json",
}, null, 2));
