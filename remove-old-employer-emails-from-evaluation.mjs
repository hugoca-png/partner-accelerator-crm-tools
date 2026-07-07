import { readFile, writeFile } from "node:fs/promises";

const APPLY = process.argv.includes("--apply");
const report = JSON.parse(await readFile("email-cleanup-evaluation-report.json", "utf8"));

const targets = new Set(
  (report.impactedRows || [])
    .filter((item) => item.category === "old_employer_or_external")
    .map((item) => String(item.email || "").trim().toLocaleLowerCase("pt-PT"))
    .filter(Boolean),
);

if (targets.size !== report.byCategory?.old_employer_or_external?.uniqueEmails) {
  throw new Error(
    `O relatório atual expõe ${targets.size} emails, mas a categoria tem ${report.byCategory?.old_employer_or_external?.uniqueEmails}. Regenera o relatório com lista completa antes de aplicar.`,
  );
}

const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN não encontrado.");

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

function nextLink(linkHeader) {
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/i);
  return match ? match[1] : null;
}

function partyName(party) {
  return party.name || [party.firstName, party.lastName].filter(Boolean).join(" ") || `(sem nome: ${party.id})`;
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

const parties = await fetchAllParties();
const unmatched = new Set(targets);
const planned = [];

for (const party of parties.filter((item) => item.type === "person")) {
  const remove = (party.emailAddresses || []).filter((entry) => {
    const address = String(entry.address || "").trim().toLocaleLowerCase("pt-PT");
    if (!targets.has(address)) return false;
    unmatched.delete(address);
    return true;
  });
  if (!remove.length) continue;
  planned.push({
    partyId: String(party.id),
    party: partyName(party),
    organisation: party.organisation?.name || "",
    remove: remove.map((entry) => ({
      id: entry.id,
      address: entry.address,
      type: entry.type || "",
    })),
    remainingEmails: (party.emailAddresses || [])
      .filter((entry) => !remove.some((item) => String(item.id) === String(entry.id)))
      .map((entry) => entry.address)
      .filter(Boolean),
  });
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
            emailAddresses: item.remove.map((entry) => ({ id: entry.id, _delete: true })),
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
  requestedEmails: targets.size,
  matchedEmails: targets.size - unmatched.size,
  affectedProfiles: planned.length,
  updatedProfiles: updated.length,
  removedEmailOccurrences: updated.reduce((sum, item) => sum + item.remove.length, 0),
  unmatched: [...unmatched].sort((a, b) => a.localeCompare(b, "pt-PT")),
  planned,
  updated,
  errors,
};

await writeFile("remove-old-employer-emails-from-evaluation-report.json", JSON.stringify(output, null, 2), "utf8");
console.log(JSON.stringify({
  applied: output.applied,
  requestedEmails: output.requestedEmails,
  matchedEmails: output.matchedEmails,
  affectedProfiles: output.affectedProfiles,
  updatedProfiles: output.updatedProfiles,
  removedEmailOccurrences: output.removedEmailOccurrences,
  unmatched: output.unmatched.length,
  errors: output.errors.length,
  report: "remove-old-employer-emails-from-evaluation-report.json",
}, null, 2));
