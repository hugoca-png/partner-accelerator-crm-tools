import { readFile, writeFile } from "node:fs/promises";

const cache = JSON.parse(await readFile("capsule-cache.json", "utf8"));

const requestedPersonalDomains = new Set([
  "gmail.com",
  "googlemail.com",
  "sapo.pt",
  "hotmail.com",
  "hotmail.pt",
  "outlook.com",
  "outlook.pt",
]);

const otherPersonalDomains = new Set([
  "live.com",
  "live.pt",
  "msn.com",
  "yahoo.com",
  "yahoo.pt",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "fastmail.com",
]);

function clean(value) {
  return String(value || "").trim();
}

function normalizeEmail(email) {
  return clean(email).toLocaleLowerCase("pt-PT");
}

function emailDomain(email) {
  return normalizeEmail(email).split("@")[1]?.replace(/^www\./i, "") || "";
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

function categoryFor(email, org) {
  const domain = emailDomain(email);
  const currentCompany = isCurrentCompanyEmail(email, org);
  if (currentCompany) return { category: "keep_current_company", reason: "email da empresa atual" };

  if (requestedPersonalDomains.has(domain)) {
    return { category: "personal_requested", reason: "email pessoal/free mail pedido para remover" };
  }

  if (otherPersonalDomains.has(domain)) {
    return { category: "personal_other", reason: "outro email pessoal/free mail provável" };
  }

  if (domain) {
    return { category: "old_employer_or_external", reason: "domínio corporativo não coincide com a empresa atual" };
  }

  return { category: "invalid_or_empty", reason: "email inválido ou sem domínio" };
}

const rows = [];

for (const org of cache.organisations || []) {
  for (const person of org.contacts || []) {
    for (const email of person.emails || []) {
      const normalizedEmail = normalizeEmail(email);
      if (!normalizedEmail) continue;
      const result = categoryFor(normalizedEmail, org);
      rows.push({
        organisationId: org.id,
        organisation: org.name,
        organisationDomains: org.domains || [],
        personId: person.id,
        person: person.name,
        jobTitles: person.jobTitles || [],
        email: normalizedEmail,
        emailDomain: emailDomain(normalizedEmail),
        category: result.category,
        reason: result.reason,
      });
    }
  }
}

const impactedCategories = new Set(["personal_requested", "personal_other", "old_employer_or_external"]);
const impacted = rows.filter((row) => impactedCategories.has(row.category));
const requestedScope = rows.filter((row) => row.category === "personal_requested" || row.category === "old_employer_or_external");

function uniqueCount(values) {
  return new Set(values.filter(Boolean)).size;
}

function summarize(list) {
  return {
    emailOccurrences: list.length,
    uniqueEmails: uniqueCount(list.map((row) => row.email)),
    people: uniqueCount(list.map((row) => row.personId || `${row.organisation}:${row.person}`)),
    organisations: uniqueCount(list.map((row) => row.organisationId || row.organisation)),
  };
}

function byCategory() {
  const output = {};
  for (const category of ["personal_requested", "personal_other", "old_employer_or_external", "keep_current_company", "invalid_or_empty"]) {
    output[category] = summarize(rows.filter((row) => row.category === category));
  }
  return output;
}

function topDomains(list, limit = 20) {
  const counts = new Map();
  for (const row of list) counts.set(row.emailDomain, (counts.get(row.emailDomain) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt-PT"))
    .slice(0, limit)
    .map(([domain, count]) => ({ domain, count }));
}

const sample = impacted
  .sort((a, b) =>
    a.organisation.localeCompare(b.organisation, "pt-PT") ||
    a.person.localeCompare(b.person, "pt-PT") ||
    a.email.localeCompare(b.email, "pt-PT"),
  )
  .slice(0, 80);

const oldEmployerRows = rows.filter((row) => row.category === "old_employer_or_external");
const oldEmployerKnownOrgDomain = oldEmployerRows.filter((row) => (row.organisationDomains || []).length > 0);
const oldEmployerMissingOrgDomain = oldEmployerRows.filter((row) => !(row.organisationDomains || []).length);

const removalSetRequested = new Set(requestedScope.map((row) => `${row.personId || `${row.organisation}:${row.person}`}|${row.email}`));
const removalSetExpanded = new Set(impacted.map((row) => `${row.personId || `${row.organisation}:${row.person}`}|${row.email}`));

function afterRemovalSummary(removalSet) {
  const people = new Map();
  for (const row of rows) {
    const personKey = row.personId || `${row.organisation}:${row.person}`;
    if (!people.has(personKey)) {
      people.set(personKey, {
        organisationId: row.organisationId,
        organisation: row.organisation,
        personId: row.personId,
        person: row.person,
        before: [],
        after: [],
        afterCurrentCompany: [],
      });
    }
    const item = people.get(personKey);
    item.before.push(row.email);
    if (!removalSet.has(`${personKey}|${row.email}`)) {
      item.after.push(row.email);
      if (row.category === "keep_current_company") item.afterCurrentCompany.push(row.email);
    }
  }

  const peopleWithoutAnyEmail = [...people.values()].filter((person) => person.before.length && !person.after.length);
  const peopleWithoutCurrentCompanyEmail = [...people.values()].filter((person) => person.before.length && !person.afterCurrentCompany.length);
  return {
    peopleWithoutAnyEmail: peopleWithoutAnyEmail.length,
    organisationsWithPeopleWithoutAnyEmail: uniqueCount(peopleWithoutAnyEmail.map((person) => person.organisationId || person.organisation)),
    peopleWithoutCurrentCompanyEmail: peopleWithoutCurrentCompanyEmail.length,
    organisationsWithPeopleWithoutCurrentCompanyEmail: uniqueCount(peopleWithoutCurrentCompanyEmail.map((person) => person.organisationId || person.organisation)),
    samplePeopleWithoutAnyEmail: peopleWithoutAnyEmail
      .sort((a, b) => a.organisation.localeCompare(b.organisation, "pt-PT") || a.person.localeCompare(b.person, "pt-PT"))
      .slice(0, 40)
      .map(({ organisation, person, before }) => ({ organisation, person, removedEmails: before })),
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  cacheRefreshedAt: cache.refreshedAt,
  totals: {
    organisations: cache.organisationCount || (cache.organisations || []).length,
    people: cache.personCount || uniqueCount(rows.map((row) => row.personId)),
    emailOccurrences: rows.length,
    uniqueEmails: uniqueCount(rows.map((row) => row.email)),
  },
  requestedRemovalScope: summarize(requestedScope),
  expandedPotentialScope: summarize(impacted),
  confidenceBreakdown: {
    highConfidencePersonalRequested: summarize(rows.filter((row) => row.category === "personal_requested")),
    optionalOtherPersonalDomains: summarize(rows.filter((row) => row.category === "personal_other")),
    mediumConfidenceOldEmployerKnownCompanyDomain: summarize(oldEmployerKnownOrgDomain),
    reviewOldEmployerMissingCompanyDomain: summarize(oldEmployerMissingOrgDomain),
  },
  afterRequestedRemoval: afterRemovalSummary(removalSetRequested),
  afterExpandedRemoval: afterRemovalSummary(removalSetExpanded),
  byCategory: byCategory(),
  topPersonalDomains: topDomains(rows.filter((row) => row.category === "personal_requested" || row.category === "personal_other")),
  topOldEmployerOrExternalDomains: topDomains(rows.filter((row) => row.category === "old_employer_or_external")),
  impactedRows: impacted.sort((a, b) =>
    a.organisation.localeCompare(b.organisation, "pt-PT") ||
    a.person.localeCompare(b.person, "pt-PT") ||
    a.email.localeCompare(b.email, "pt-PT"),
  ),
  sample,
};

await writeFile("email-cleanup-evaluation-report.json", JSON.stringify(report, null, 2), "utf8");

console.log(JSON.stringify({
  report: "email-cleanup-evaluation-report.json",
  totals: report.totals,
  requestedRemovalScope: report.requestedRemovalScope,
  expandedPotentialScope: report.expandedPotentialScope,
  confidenceBreakdown: report.confidenceBreakdown,
  afterRequestedRemoval: report.afterRequestedRemoval,
  afterExpandedRemoval: report.afterExpandedRemoval,
  byCategory: report.byCategory,
  topPersonalDomains: report.topPersonalDomains.slice(0, 10),
  topOldEmployerOrExternalDomains: report.topOldEmployerOrExternalDomains.slice(0, 10),
}, null, 2));
