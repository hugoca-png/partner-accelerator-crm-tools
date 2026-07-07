import { readFile, writeFile } from "node:fs/promises";

const VALIDATE = process.argv.includes("--validate");
const LIMIT = Number(process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1] || 50);

const cache = JSON.parse(await readFile("capsule-cache.json", "utf8"));
const env = await readFile(".env", "utf8").catch(() => "");
const bouncerKey = env.match(/^BOUNCER_API_KEY=(.+)$/m)?.[1]?.trim() || process.env.BOUNCER_API_KEY || "";

const particles = new Set(["de", "da", "do", "das", "dos", "e", "a", "o"]);

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalize(value) {
  return clean(value)
    .toLocaleLowerCase("pt-PT")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s.-]+/g, "")
    .trim();
}

function nameParts(name) {
  const parts = normalize(name).split(/\s+/).filter(Boolean).filter((part) => !particles.has(part));
  if (!parts.length) return null;
  return {
    first: parts[0],
    last: parts[parts.length - 1],
    parts,
  };
}

function emailDomain(email) {
  return clean(email).toLocaleLowerCase("pt-PT").split("@")[1]?.replace(/^www\./i, "") || "";
}

function emailLocal(email) {
  return clean(email).toLocaleLowerCase("pt-PT").split("@")[0] || "";
}

function candidatesForName(name, domain) {
  const parsed = nameParts(name);
  if (!parsed || !domain) return {};
  const { first, last, parts } = parsed;
  const middle = parts.slice(1, -1);
  const initials = parts.map((part) => part[0]).join("");
  return {
    "first.last": `${first}.${last}@${domain}`,
    first: `${first}@${domain}`,
    "f.last": `${first[0]}.${last}@${domain}`,
    flast: `${first[0]}${last}@${domain}`,
    firstlast: `${first}${last}@${domain}`,
    "first_last": `${first}_${last}@${domain}`,
    "first-last": `${first}-${last}@${domain}`,
    initials: `${initials}@${domain}`,
    "first.middle.last": middle.length ? `${[first, ...middle, last].join(".")}@${domain}` : `${first}.${last}@${domain}`,
  };
}

function patternFor(personName, email, orgDomains) {
  const domain = emailDomain(email);
  if (!domain || !orgDomains.includes(domain)) return null;
  const generated = candidatesForName(personName, domain);
  const local = emailLocal(email);
  for (const [pattern, candidate] of Object.entries(generated)) {
    if (emailLocal(candidate) === local) return { pattern, domain };
  }
  return null;
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function analyseOrg(org) {
  const domains = unique(org.domains || []).map((domain) => domain.toLocaleLowerCase("pt-PT"));
  const patternCounts = new Map();
  const domainCounts = new Map();
  const examples = [];

  for (const person of org.contacts || []) {
    for (const email of person.emails || []) {
      const found = patternFor(person.name, email, domains);
      if (!found) continue;
      const key = `${found.pattern}|${found.domain}`;
      patternCounts.set(key, (patternCounts.get(key) || 0) + 1);
      domainCounts.set(found.domain, (domainCounts.get(found.domain) || 0) + 1);
      examples.push({ person: person.name, email, pattern: found.pattern, domain: found.domain });
    }
  }

  const ranked = [...patternCounts.entries()]
    .map(([key, count]) => {
      const [pattern, domain] = key.split("|");
      return { pattern, domain, count };
    })
    .sort((a, b) => b.count - a.count || (domainCounts.get(b.domain) || 0) - (domainCounts.get(a.domain) || 0));

  return { domains, ranked, examples };
}

const orgAnalysis = new Map((cache.organisations || []).map((org) => [String(org.id), analyseOrg(org)]));
const rows = [];

for (const org of cache.organisations || []) {
  const analysis = orgAnalysis.get(String(org.id));
  if (!analysis?.ranked.length) continue;
  for (const person of org.contacts || []) {
    if ((person.emails || []).length) continue;
    const generated = candidatesForName(person.name, analysis.ranked[0].domain);
    if (!generated[analysis.ranked[0].pattern]) continue;
    const pattern = analysis.ranked[0];
    const candidate = generated[pattern.pattern];
    const confidence =
      pattern.count >= 3 ? "alta" :
      pattern.count >= 2 ? "media" :
      "baixa";
    rows.push({
      orgId: String(org.id),
      organisation: org.name,
      personId: String(person.ids?.[0] || person.id || ""),
      person: person.name,
      job: unique(person.jobTitles || []).join("; "),
      city: org.city || "",
      country: org.country || "",
      candidateEmail: candidate,
      pattern: pattern.pattern,
      patternExamples: pattern.count,
      domain: pattern.domain,
      confidence,
      source: "padrão interno CRM",
      examples: analysis.examples
        .filter((example) => example.pattern === pattern.pattern && example.domain === pattern.domain)
        .slice(0, 5),
    });
  }
}

rows.sort((a, b) => {
  const confidenceScore = { alta: 3, media: 2, baixa: 1 };
  return (confidenceScore[b.confidence] || 0) - (confidenceScore[a.confidence] || 0) ||
    b.patternExamples - a.patternExamples ||
    a.organisation.localeCompare(b.organisation, "pt-PT") ||
    a.person.localeCompare(b.person, "pt-PT");
});

const selected = rows.slice(0, LIMIT);

async function bouncerCredits() {
  if (!bouncerKey) return null;
  const response = await fetch("https://api.usebouncer.com/v1.1/credits", {
    headers: { "x-api-key": bouncerKey, Accept: "application/json" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Bouncer credits ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function verifyEmails(emails) {
  if (!emails.length) return [];
  if (!bouncerKey) throw new Error("BOUNCER_API_KEY não configurada.");
  const response = await fetch("https://api.usebouncer.com/v1.1/email/verify/batch/sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": bouncerKey,
    },
    body: JSON.stringify(emails),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Bouncer verify ${response.status}: ${text}`);
  return JSON.parse(text);
}

let creditsBefore = null;
let creditsAfter = null;
let validationResults = [];

if (VALIDATE && selected.length) {
  creditsBefore = await bouncerCredits();
  validationResults = await verifyEmails(unique(selected.map((row) => row.candidateEmail)));
  creditsAfter = await bouncerCredits();
}

const byEmail = new Map(validationResults.map((result) => [clean(result.email).toLocaleLowerCase("pt-PT"), result]));
const outputRows = selected.map((row) => {
  const result = byEmail.get(row.candidateEmail.toLocaleLowerCase("pt-PT"));
  return {
    ...row,
    bouncerStatus: result?.status || "",
    bouncerReason: result?.reason || "",
    bouncerScore: result?.score ?? null,
    bouncerAcceptAll: result?.domain?.acceptAll || "",
    bouncerRole: result?.account?.role || "",
    bouncerDisposable: result?.domain?.disposable || "",
    recommendation: !result
      ? "por validar"
      : result.status === "deliverable"
        ? "candidato forte para atualizar CRM"
        : result.status === "risky" && result.domain?.acceptAll === "yes"
          ? "aceitável mas catch-all; rever antes de CRM"
          : "não atualizar sem revisão",
  };
});

const report = {
  generatedAt: new Date().toISOString(),
  validate: VALIDATE,
  limit: LIMIT,
  contactsWithoutEmail: (cache.organisations || []).flatMap((org) => (org.contacts || []).filter((p) => !(p.emails || []).length)).length,
  candidateCount: rows.length,
  selectedCount: selected.length,
  creditsBefore,
  creditsAfter,
  summary: {
    deliverable: outputRows.filter((row) => row.bouncerStatus === "deliverable").length,
    risky: outputRows.filter((row) => row.bouncerStatus === "risky").length,
    undeliverable: outputRows.filter((row) => row.bouncerStatus === "undeliverable").length,
    unknown: outputRows.filter((row) => !row.bouncerStatus).length,
  },
  rows: outputRows,
  allCandidates: rows,
};

await writeFile("missing-contact-email-enrichment-report.json", JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({
  validate: report.validate,
  contactsWithoutEmail: report.contactsWithoutEmail,
  candidateCount: report.candidateCount,
  selectedCount: report.selectedCount,
  summary: report.summary,
  creditsBefore: report.creditsBefore,
  creditsAfter: report.creditsAfter,
  report: "missing-contact-email-enrichment-report.json",
}, null, 2));
