import { readFile, writeFile } from "node:fs/promises";

const env = await readFile(".env", "utf8");
const bouncerKey = env.match(/^BOUNCER_API_KEY=(.+)$/m)?.[1]?.trim() || process.env.BOUNCER_API_KEY || "";
if (!bouncerKey) throw new Error("BOUNCER_API_KEY não configurada.");

const previous = JSON.parse(await readFile("missing-contact-email-enrichment-report.json", "utf8"));
const candidates = previous.allCandidates || [];

async function bouncerCredits() {
  const response = await fetch("https://api.usebouncer.com/v1.1/credits", {
    headers: { "x-api-key": bouncerKey, Accept: "application/json" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Bouncer credits ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function verifyEmail(email) {
  const url = new URL("https://api.usebouncer.com/v1.1/email/verify");
  url.searchParams.set("email", email);
  url.searchParams.set("timeout", "30");
  const response = await fetch(url, {
    headers: { "x-api-key": bouncerKey, Accept: "application/json" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Bouncer realtime ${response.status} for ${email}: ${text}`);
  return JSON.parse(text);
}

function statusRecommendation(result) {
  const status = String(result.status || "").toLocaleLowerCase("pt-PT");
  const acceptAll = String(result.domain?.acceptAll || "").toLocaleLowerCase("pt-PT");
  if (status === "deliverable") return "candidato forte para atualizar CRM";
  if (status === "risky" && acceptAll === "yes") return "aceitável mas catch-all; rever antes de CRM";
  if (status === "risky") return "rever antes de CRM";
  if (status === "unknown") return "inconclusivo; rever ou tentar novamente";
  return "não atualizar";
}

const creditsBefore = await bouncerCredits();
const limit = Math.min(candidates.length, Number(creditsBefore.credits || 0));
const selected = candidates.slice(0, limit);
const rows = [];
const errors = [];

for (const candidate of selected) {
  try {
    const result = await verifyEmail(candidate.candidateEmail);
    rows.push({
      ...candidate,
      bouncerStatus: result.status || "",
      bouncerReason: result.reason || "",
      bouncerScore: result.score ?? null,
      bouncerAcceptAll: result.domain?.acceptAll || "",
      bouncerRole: result.account?.role || "",
      bouncerDisposable: result.domain?.disposable || "",
      bouncerFree: result.domain?.free || "",
      bouncerProvider: result.provider || "",
      recommendation: statusRecommendation(result),
      raw: result,
    });
  } catch (error) {
    errors.push({
      candidateEmail: candidate.candidateEmail,
      organisation: candidate.organisation,
      person: candidate.person,
      error: error.message || String(error),
    });
  }
}

const creditsAfter = await bouncerCredits();
const output = {
  generatedAt: new Date().toISOString(),
  method: "bouncer realtime",
  creditsBefore,
  creditsAfter,
  totalCandidates: candidates.length,
  selectedCount: selected.length,
  summary: {
    deliverable: rows.filter((row) => row.bouncerStatus === "deliverable").length,
    risky: rows.filter((row) => row.bouncerStatus === "risky").length,
    undeliverable: rows.filter((row) => row.bouncerStatus === "undeliverable").length,
    unknown: rows.filter((row) => row.bouncerStatus === "unknown" || !row.bouncerStatus).length,
    errors: errors.length,
  },
  rows,
  errors,
};

await writeFile("missing-contact-email-enrichment-realtime-report.json", JSON.stringify(output, null, 2), "utf8");
console.log(JSON.stringify({
  creditsBefore,
  creditsAfter,
  totalCandidates: output.totalCandidates,
  selectedCount: output.selectedCount,
  summary: output.summary,
  report: "missing-contact-email-enrichment-realtime-report.json",
}, null, 2));
