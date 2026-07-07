import { readFile, writeFile } from "node:fs/promises";

const APPLY = process.argv.includes("--apply");

const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN não encontrado.");

const report = JSON.parse(await readFile("missing-contact-email-enrichment-realtime-report.json", "utf8"));
const targets = (report.rows || [])
  .filter((row) => row.bouncerStatus === "deliverable")
  .map((row) => ({
    partyId: String(row.personId || ""),
    person: row.person,
    organisation: row.organisation,
    email: row.candidateEmail,
    score: row.bouncerScore,
  }))
  .filter((row) => row.partyId && row.email);

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

const planned = [];
const skipped = [];
for (const target of targets) {
  const { data } = await capsuleFetch(`/parties/${target.partyId}`);
  const party = data.party;
  const existing = new Set((party.emailAddresses || []).map((entry) => String(entry.address || "").trim().toLocaleLowerCase("pt-PT")));
  if (existing.has(target.email.toLocaleLowerCase("pt-PT"))) {
    skipped.push({ ...target, reason: "email já existe no perfil" });
    continue;
  }
  planned.push(target);
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
            emailAddresses: [
              {
                address: item.email,
                type: "Work",
              },
            ],
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
  requested: targets.length,
  planned: planned.length,
  skipped,
  updated,
  errors,
};

await writeFile("add-deliverable-missing-contact-emails-report.json", JSON.stringify(output, null, 2), "utf8");
console.log(JSON.stringify({
  applied: output.applied,
  requested: output.requested,
  planned: output.planned,
  skipped: output.skipped.length,
  updated: output.updated.length,
  errors: output.errors.length,
  report: "add-deliverable-missing-contact-emails-report.json",
}, null, 2));
