import { readFile, writeFile } from "node:fs/promises";

const env = await readFile(".env", "utf8");
const bouncerKey = env.match(/^BOUNCER_API_KEY=(.+)$/m)?.[1]?.trim() || process.env.BOUNCER_API_KEY || "";
if (!bouncerKey) throw new Error("BOUNCER_API_KEY não configurada.");

const prior = JSON.parse(await readFile("missing-contact-email-enrichment-report.json", "utf8"));
const allCandidates = prior.allCandidates || [];
const alreadyAttempted = new Set((prior.rows || []).map((row) => String(row.candidateEmail || "").toLocaleLowerCase("pt-PT")));
const remaining = allCandidates.filter((row) => !alreadyAttempted.has(String(row.candidateEmail || "").toLocaleLowerCase("pt-PT")));

async function bouncerCredits() {
  const response = await fetch("https://api.usebouncer.com/v1.1/credits", {
    headers: { "x-api-key": bouncerKey, Accept: "application/json" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Bouncer credits ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function verifyEmails(emails) {
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

function clean(value) {
  return String(value || "").trim();
}

function resultEmail(result) {
  return clean(result.email || result.input || result.address || result.originalEmail || result.requestedEmail).toLocaleLowerCase("pt-PT");
}

function normalizeResult(result = {}) {
  const status =
    result.status ||
    result.deliverability ||
    result.result ||
    result.state ||
    result.verdict ||
    "";
  return {
    raw: result,
    status,
    reason: result.reason || result.reasonCode || result.message || "",
    score: result.score ?? result.qualityScore ?? result.confidence ?? null,
    acceptAll: result.domain?.acceptAll || result.acceptAll || result.isCatchAll || "",
    role: result.account?.role || result.role || "",
    disposable: result.domain?.disposable || result.disposable || "",
    free: result.domain?.free || result.free || "",
    provider: result.provider || result.domain?.provider || "",
  };
}

const creditsBefore = await bouncerCredits();
const available = Number(creditsBefore.credits || 0);
const selected = remaining.slice(0, available);

if (!selected.length) {
  const empty = {
    generatedAt: new Date().toISOString(),
    creditsBefore,
    creditsAfter: creditsBefore,
    remainingCandidates: remaining.length,
    selectedCount: 0,
    rows: [],
    rawResults: [],
  };
  await writeFile("missing-contact-email-enrichment-validation-rest-report.json", JSON.stringify(empty, null, 2), "utf8");
  console.log(JSON.stringify({
    selectedCount: 0,
    remainingCandidates: remaining.length,
    creditsBefore,
    report: "missing-contact-email-enrichment-validation-rest-report.json",
  }, null, 2));
  process.exit(0);
}

const rawResults = await verifyEmails(selected.map((row) => row.candidateEmail));
const resultList = Array.isArray(rawResults) ? rawResults : rawResults.results || rawResults.data || [];
const byEmail = new Map(resultList.map((result) => [resultEmail(result), normalizeResult(result)]));
const creditsAfter = await bouncerCredits();

const rows = selected.map((row) => {
  const result = byEmail.get(String(row.candidateEmail || "").toLocaleLowerCase("pt-PT")) || normalizeResult();
  const status = clean(result.status).toLocaleLowerCase("pt-PT");
  return {
    ...row,
    bouncerStatus: result.status,
    bouncerReason: result.reason,
    bouncerScore: result.score,
    bouncerAcceptAll: result.acceptAll,
    bouncerRole: result.role,
    bouncerDisposable: result.disposable,
    bouncerFree: result.free,
    bouncerProvider: result.provider,
    recommendation: status === "deliverable"
      ? "candidato forte para atualizar CRM"
      : status === "risky" && String(result.acceptAll).toLocaleLowerCase("pt-PT") === "yes"
        ? "aceitável mas catch-all; rever antes de CRM"
        : status
          ? "não atualizar sem revisão"
          : "validação inconclusiva",
  };
});

const output = {
  generatedAt: new Date().toISOString(),
  creditsBefore,
  creditsAfter,
  totalCandidates: allCandidates.length,
  priorAttempted: alreadyAttempted.size,
  remainingCandidatesBeforeRun: remaining.length,
  selectedCount: selected.length,
  summary: {
    deliverable: rows.filter((row) => String(row.bouncerStatus).toLocaleLowerCase("pt-PT") === "deliverable").length,
    risky: rows.filter((row) => String(row.bouncerStatus).toLocaleLowerCase("pt-PT") === "risky").length,
    undeliverable: rows.filter((row) => String(row.bouncerStatus).toLocaleLowerCase("pt-PT") === "undeliverable").length,
    unknown: rows.filter((row) => !row.bouncerStatus).length,
  },
  rows,
  rawResults,
};

await writeFile("missing-contact-email-enrichment-validation-rest-report.json", JSON.stringify(output, null, 2), "utf8");
console.log(JSON.stringify({
  creditsBefore,
  creditsAfter,
  totalCandidates: output.totalCandidates,
  priorAttempted: output.priorAttempted,
  selectedCount: output.selectedCount,
  summary: output.summary,
  report: "missing-contact-email-enrichment-validation-rest-report.json",
}, null, 2));
