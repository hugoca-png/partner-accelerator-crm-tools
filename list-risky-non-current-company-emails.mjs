import { readFile } from "node:fs/promises";

const cache = JSON.parse(await readFile("capsule-cache.json", "utf8"));
const report = JSON.parse(await readFile("bouncer-email-validation-last.json", "utf8"));

function emailDomain(email) {
  return String(email || "")
    .trim()
    .toLocaleLowerCase("pt-PT")
    .split("@")[1]
    ?.replace(/^www\./, "") || "";
}

function baseDomain(domain) {
  const parts = String(domain || "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  return parts.slice(-2).join(".");
}

function normalize(value) {
  return String(value || "")
    .toLocaleLowerCase("pt-PT")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function isCurrentCompanyEmail(email, org) {
  const domain = emailDomain(email);
  if (!domain) return false;
  const orgDomains = (org.domains || []).map((item) => String(item).toLocaleLowerCase("pt-PT"));
  if (orgDomains.includes(domain)) return true;
  if (orgDomains.some((item) => baseDomain(item) === baseDomain(domain))) return true;
  const emailToken = normalize(baseDomain(domain).split(".")[0]);
  const orgTokens = [org.name, org.url, ...orgDomains].map(normalize).filter(Boolean);
  return emailToken.length >= 4 && orgTokens.some((token) => token.includes(emailToken) || emailToken.includes(token));
}

const current = new Map();
for (const org of cache.organisations || []) {
  for (const person of org.contacts || []) {
    for (const email of person.emails || []) {
      current.set(String(email).toLocaleLowerCase("pt-PT"), { org, person });
    }
  }
}

const rows = [];
const seen = new Set();
for (const row of report.rows || []) {
  if (row.bouncer?.status !== "risky") continue;
  const key = String(row.email || "").toLocaleLowerCase("pt-PT");
  if (seen.has(key)) continue;
  seen.add(key);
  const entry = current.get(key);
  if (!entry) continue;
  if (isCurrentCompanyEmail(row.email, entry.org)) continue;
  rows.push({
    empresaAtual: entry.org.name,
    dominiosEmpresaAtual: entry.org.domains || [],
    pessoa: entry.person.name,
    email: row.email,
    dominioEmail: emailDomain(row.email),
    reason: row.bouncer.reason,
    score: row.bouncer.score,
    acceptAll: row.bouncer.acceptAll,
  });
}

rows.sort((a, b) =>
  a.empresaAtual.localeCompare(b.empresaAtual, "pt-PT") ||
  a.pessoa.localeCompare(b.pessoa, "pt-PT") ||
  a.email.localeCompare(b.email, "pt-PT"),
);

console.log(JSON.stringify(rows, null, 2));
console.error(`count ${rows.length}`);
