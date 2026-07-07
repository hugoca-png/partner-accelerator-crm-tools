import { readFile, writeFile } from "node:fs/promises";

const APPLY = process.argv.includes("--apply");

const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN nao encontrado.");

const cache = JSON.parse(await readFile("capsule-cache.json", "utf8"));

function hasEmail(contactOrParty) {
  const emails = contactOrParty.emailAddresses
    ? contactOrParty.emailAddresses.map((entry) => entry.address)
    : contactOrParty.emails || [];
  return emails.some((email) => String(email || "").trim().includes("@"));
}

function fullName(party) {
  return [party.firstName, party.lastName].filter(Boolean).join(" ").trim() || party.name || "";
}

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
  if (!response.ok) throw new Error(`Capsule ${response.status}: ${text || response.statusText}`);
  return text ? JSON.parse(text) : null;
}

const candidates = [];
for (const org of cache.organisations || []) {
  for (const contact of org.contacts || []) {
    if (hasEmail(contact)) continue;
    for (const id of contact.ids || []) {
      candidates.push({
        id: String(id),
        name: contact.name,
        organisation: org.name,
      });
    }
  }
}

const byId = new Map(candidates.map((item) => [item.id, item]));

const report = {
  generatedAt: new Date().toISOString(),
  applied: APPLY,
  plannedFromCache: candidates.length,
  deleted: [],
  skipped: [],
  errors: [],
};

for (const candidate of byId.values()) {
  try {
    const current = (await capsuleFetch(`/parties/${candidate.id}`)).party;
    if (!current) {
      report.skipped.push({ ...candidate, reason: "nao encontrado" });
      continue;
    }
    if (current.type !== "person") {
      report.skipped.push({ ...candidate, reason: `nao e pessoa: ${current.type}` });
      continue;
    }
    if (hasEmail(current)) {
      report.skipped.push({
        ...candidate,
        currentName: fullName(current),
        reason: "ja tem email no CRM",
        emails: (current.emailAddresses || []).map((entry) => entry.address).filter(Boolean),
      });
      continue;
    }

    if (APPLY) {
      await capsuleFetch(`/parties/${candidate.id}`, { method: "DELETE" });
    }

    report.deleted.push({
      ...candidate,
      currentName: fullName(current),
      mode: APPLY ? "deleted" : "planned",
    });
  } catch (error) {
    report.errors.push({
      ...candidate,
      error: error.message || String(error),
    });
  }
}

report.deletedCount = report.deleted.length;
report.skippedCount = report.skipped.length;
report.errorCount = report.errors.length;

await writeFile("delete-no-email-contacts-report.json", JSON.stringify(report, null, 2), "utf8");

console.log(JSON.stringify({
  applied: report.applied,
  plannedFromCache: report.plannedFromCache,
  deleted: report.deletedCount,
  skipped: report.skippedCount,
  errors: report.errorCount,
  report: "delete-no-email-contacts-report.json",
}, null, 2));
