import { readFile, writeFile } from "node:fs/promises";

const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN nao encontrado.");

const freeDomains = new Set([
  "gmail.com", "googlemail.com",
  "hotmail.com", "hotmail.pt", "hotmail.co.uk",
  "outlook.com", "outlook.pt",
  "live.com", "live.pt", "live.com.pt",
  "msn.com",
  "sapo.pt",
  "yahoo.com", "yahoo.pt", "yahoo.co.uk",
  "icloud.com", "me.com",
  "aol.com",
  "proton.me", "protonmail.com",
  "fastmail.com",
  "gmx.com", "gmx.pt",
  "mail.com",
  "pobox.com",
]);

const businessExceptions = new Set([
  "fatima@sapo.pt",
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

function nextLink(linkHeader) {
  return clean(linkHeader).replace(/&amp;/g, "&").match(/<([^>]+)>;\s*rel="next"/i)?.[1] || "";
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

function partyName(party) {
  return clean(party.name) || [party.firstName, party.lastName].map(clean).filter(Boolean).join(" ") || `(sem nome: ${party.id})`;
}

const parties = await fetchAllParties();
const allEmails = [];

for (const party of parties) {
  for (const entry of party.emailAddresses || []) {
    const email = normalize(entry.address);
    if (!email) continue;
    const domain = domainOf(email);
    const isFreeDomain = freeDomains.has(domain);
    const isBusinessException = businessExceptions.has(email);
    allEmails.push({
      partyId: String(party.id),
      partyType: party.type,
      party: partyName(party),
      organisation: party.organisation?.name || (party.type === "organisation" ? partyName(party) : ""),
      jobTitle: clean(party.jobTitle),
      emailId: String(entry.id),
      email,
      domain,
      type: clean(entry.type),
      isFreeDomain,
      isBusinessException,
    });
  }
}

const homeCorporate = allEmails.filter((row) =>
  normalize(row.type) === "home" &&
  !row.isFreeDomain);

const freeNotHome = allEmails.filter((row) =>
  row.isFreeDomain &&
  !row.isBusinessException &&
  normalize(row.type) !== "home");

const freeHome = allEmails.filter((row) =>
  row.isFreeDomain &&
  !row.isBusinessException &&
  normalize(row.type) === "home");

const exceptions = allEmails.filter((row) => row.isBusinessException);
const emptyType = allEmails.filter((row) => !clean(row.type));

const report = {
  generatedAt: new Date().toISOString(),
  totals: {
    parties: parties.length,
    emails: allEmails.length,
    work: allEmails.filter((row) => normalize(row.type) === "work").length,
    home: allEmails.filter((row) => normalize(row.type) === "home").length,
    emptyType: emptyType.length,
    homeCorporate: homeCorporate.length,
    freeHome: freeHome.length,
    freeNotHome: freeNotHome.length,
    businessExceptions: exceptions.length,
  },
  criteria: {
    homeCorporate: "Email Home cujo dominio nao pertence à lista de fornecedores pessoais/free-mail.",
    freeNotHome: "Email Gmail/Hotmail/Outlook/Live/Sapo/Yahoo/iCloud/Proton e afins que nao esta classificado como Home, excluindo excecoes empresariais conhecidas.",
    note: "A classificacao por dominio e um indicador. Dominios proprios podem ser emails pessoais, e free-mail pode ser profissional em casos excecionais.",
  },
  homeCorporate,
  freeNotHome,
  exceptions,
  emptyType,
};

await writeFile("email-home-work-type-audit-report.json", JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({
  ...report.totals,
  report: "email-home-work-type-audit-report.json",
}, null, 2));
