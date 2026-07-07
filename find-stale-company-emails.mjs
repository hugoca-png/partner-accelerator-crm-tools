import { readFile, writeFile } from "node:fs/promises";

const cache = JSON.parse(await readFile("capsule-cache.json", "utf8"));

const freeDomains = new Set([
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

const ignoreDomains = new Set([
  "linkedin.com",
  "facebook.com",
  "twitter.com",
  "x.com",
]);

function domainOf(email) {
  return String(email || "")
    .trim()
    .toLocaleLowerCase("pt-PT")
    .split("@")[1]
    ?.replace(/^www\./, "") || "";
}

function baseDomain(domain) {
  const parts = String(domain || "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const twoLevelTlds = new Set(["co.uk", "com.br", "com.au"]);
  const lastTwo = parts.slice(-2).join(".");
  if (twoLevelTlds.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join(".");
  return lastTwo;
}

function similarToken(value) {
  return String(value || "")
    .toLocaleLowerCase("pt-PT")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function orgTokens(org) {
  return [
    org.name,
    ...(org.domains || []),
    org.url,
  ].map(similarToken).filter(Boolean);
}

function isLikelySameCompany(emailDomain, org) {
  const orgDomains = new Set((org.domains || []).map((domain) => String(domain).toLocaleLowerCase("pt-PT")));
  if (orgDomains.has(emailDomain)) return true;

  const emailBase = baseDomain(emailDomain);
  if ([...orgDomains].some((domain) => baseDomain(domain) === emailBase)) return true;

  const emailToken = similarToken(emailBase.split(".")[0]);
  if (!emailToken || emailToken.length < 4) return false;
  return orgTokens(org).some((token) => token.includes(emailToken) || emailToken.includes(token));
}

const cases = [];

for (const org of cache.organisations || []) {
  for (const person of org.contacts || []) {
    for (const email of person.emails || []) {
      const domain = domainOf(email);
      if (!domain || freeDomains.has(domain) || ignoreDomains.has(domain)) continue;
      if (isLikelySameCompany(domain, org)) continue;
      cases.push({
        empresaAtual: org.name,
        dominiosEmpresaAtual: org.domains || [],
        pessoa: person.name,
        email,
        dominioEmail: domain,
        cargo: (person.jobTitles || []).join(", "),
        tags: person.tags || [],
        dataTags: person.dataTags || [],
      });
    }
  }
}

cases.sort((a, b) =>
  a.empresaAtual.localeCompare(b.empresaAtual, "pt-PT") ||
  a.pessoa.localeCompare(b.pessoa, "pt-PT") ||
  a.email.localeCompare(b.email, "pt-PT"),
);

await writeFile("stale-company-emails-report.json", JSON.stringify({
  generatedAt: new Date().toISOString(),
  criteria: [
    "Email de domínio corporativo, excluindo fornecedores pessoais/free mail comuns.",
    "Domínio do email não coincide com os domínios web da organização atual.",
    "Também foram aceites matches por domínio base e semelhança textual clara com o nome/domínio da organização.",
  ],
  count: cases.length,
  cases,
}, null, 2), "utf8");

console.log(JSON.stringify({ count: cases.length, report: "stale-company-emails-report.json" }, null, 2));
