import { readFile, writeFile } from "node:fs/promises";

const cache = JSON.parse(await readFile("capsule-cache.json", "utf8"));
const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN nao encontrado.");

const freeDomains = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.pt", "outlook.com", "outlook.pt",
  "live.com", "live.pt", "msn.com", "sapo.pt", "yahoo.com", "yahoo.pt", "icloud.com",
  "me.com", "aol.com", "proton.me", "protonmail.com", "fastmail.com",
]);

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalize(value) {
  return clean(value).toLocaleLowerCase("pt-PT");
}

function domainOf(email) {
  return normalize(email).split("@")[1]?.replace(/^www\./, "") || "";
}

function baseDomain(domain) {
  const parts = normalize(domain).split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const compound = new Set(["co.uk", "com.br", "com.au", "co.za"]);
  const lastTwo = parts.slice(-2).join(".");
  return compound.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

async function capsuleFetch(path) {
  const url = path.startsWith("http") ? path : `https://api.capsulecrm.com/api/v2${path}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Capsule ${response.status}: ${text}`);
  return { data: text ? JSON.parse(text) : null, link: response.headers.get("link") || "" };
}

function nextLink(linkHeader) {
  return clean(linkHeader).replace(/&amp;/g, "&").match(/<([^>]+)>;\s*rel="next"/i)?.[1] || "";
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

const orgById = new Map((cache.organisations || []).map((org) => [String(org.id), org]));
const ownersByDomain = new Map();
for (const org of cache.organisations || []) {
  for (const rawDomain of org.domains || []) {
    const domain = baseDomain(rawDomain);
    if (!domain) continue;
    if (!ownersByDomain.has(domain)) ownersByDomain.set(domain, []);
    ownersByDomain.get(domain).push({ id: String(org.id), name: org.name });
  }
}

const parties = await fetchAllParties();
const highConfidence = [];
const review = [];

for (const party of parties) {
  if (party.type !== "person" || !party.organisation?.id) continue;
  const currentOrg = orgById.get(String(party.organisation.id));
  if (!currentOrg) continue;
  const currentDomains = new Set((currentOrg.domains || []).map(baseDomain).filter(Boolean));

  for (const entry of party.emailAddresses || []) {
    if (normalize(entry.type) !== "work") continue;
    const email = clean(entry.address);
    const domain = domainOf(email);
    if (!email || !domain || freeDomains.has(domain)) continue;
    const emailBase = baseDomain(domain);
    if (currentDomains.has(emailBase)) continue;

    const otherOwners = (ownersByDomain.get(emailBase) || [])
      .filter((owner) => owner.id !== String(currentOrg.id));
    const item = {
      partyId: String(party.id),
      person: party.name || [party.firstName, party.lastName].filter(Boolean).join(" "),
      jobTitle: clean(party.jobTitle),
      currentOrganisationId: String(currentOrg.id),
      currentOrganisation: currentOrg.name,
      currentDomains: [...currentDomains],
      emailId: String(entry.id),
      email,
      emailDomain: domain,
      type: entry.type,
      matchedOtherOrganisations: otherOwners,
    };

    if (currentDomains.size && otherOwners.length === 1) highConfidence.push(item);
    else review.push({
      ...item,
      reason: !currentDomains.size
        ? "empresa atual sem dominio confirmado"
        : otherOwners.length > 1
          ? "dominio associado a varias organizacoes"
          : "dominio diferente, mas sem empresa anterior identificada no CRM",
    });
  }
}

const sortRows = (rows) => rows.sort((a, b) =>
  a.currentOrganisation.localeCompare(b.currentOrganisation, "pt-PT") ||
  a.person.localeCompare(b.person, "pt-PT") ||
  a.email.localeCompare(b.email, "pt-PT"));
sortRows(highConfidence);
sortRows(review);

const report = {
  generatedAt: new Date().toISOString(),
  cacheRefreshedAt: cache.refreshedAt,
  criteria: {
    automatic: "Email marcado Work, dominio diferente da empresa atual, empresa atual com dominio conhecido e dominio do email associado exatamente a uma unica outra empresa no CRM.",
    review: "Mismatch sem correspondencia inequivoca com outra empresa do CRM.",
  },
  totals: {
    parties: parties.length,
    highConfidence: highConfidence.length,
    review: review.length,
  },
  highConfidence,
  review,
};

await writeFile("stale-work-emails-audit-report.json", JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({
  highConfidence: highConfidence.length,
  review: review.length,
  report: "stale-work-emails-audit-report.json",
}, null, 2));
