import { readFile, writeFile } from "node:fs/promises";

const APPLY = process.argv.includes("--apply");
const audit = JSON.parse(await readFile("name-accent-audit-report.json", "utf8"));
const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN nao encontrado.");

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
  const text = await response.text();
  if (!response.ok) throw new Error(`Capsule ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const report = {
  generatedAt: new Date().toISOString(),
  applied: APPLY,
  requested: audit.automatic.length,
  updated: [],
  skipped: [],
  errors: [],
  ambiguousNotChanged: audit.review || [],
};

for (const row of audit.automatic) {
  try {
    const current = (await capsuleFetch(`/parties/${row.id}?embed=organisation`)).party;
    const currentFirstName = String(current.firstName || "").trim();
    const currentLastName = String(current.lastName || "").trim();

    if (currentFirstName === row.after.firstName && currentLastName === row.after.lastName) {
      report.skipped.push({ ...row, reason: "ja corrigido" });
      continue;
    }

    if (currentFirstName !== row.before.firstName || currentLastName !== row.before.lastName) {
      report.skipped.push({
        ...row,
        reason: "nome alterado entretanto; atualizacao cancelada",
        current: { firstName: currentFirstName, lastName: currentLastName },
      });
      continue;
    }

    if (APPLY) {
      await capsuleFetch(`/parties/${row.id}`, {
        method: "PUT",
        body: JSON.stringify({
          party: {
            firstName: row.after.firstName,
            lastName: row.after.lastName,
          },
        }),
      });
    }

    report.updated.push({
      id: row.id,
      organisation: current.organisation?.name || row.organisation,
      before: row.before,
      after: row.after,
      replacements: row.replacements,
      mode: APPLY ? "updated" : "planned",
    });
  } catch (error) {
    report.errors.push({
      ...row,
      error: error.message || String(error),
    });
  }
}

report.updatedCount = report.updated.length;
report.skippedCount = report.skipped.length;
report.errorCount = report.errors.length;
await writeFile("name-accent-update-report.json", JSON.stringify(report, null, 2), "utf8");

console.log(JSON.stringify({
  applied: report.applied,
  requested: report.requested,
  updated: report.updatedCount,
  skipped: report.skippedCount,
  errors: report.errorCount,
  ambiguousNotChanged: report.ambiguousNotChanged.length,
  report: "name-accent-update-report.json",
}, null, 2));
