import { readFile } from "node:fs/promises";

const audit = JSON.parse(await readFile("stale-work-emails-audit-report.json", "utf8"));
const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN nao encontrado.");

async function capsuleFetch(id) {
  const response = await fetch(`https://api.capsulecrm.com/api/v2/parties/${id}?embed=organisation,tags`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Capsule ${response.status}: ${text}`);
  return JSON.parse(text).party;
}

const ids = [...new Set((audit.highConfidence || []).map((item) => item.partyId))];
const rows = [];
for (const id of ids) {
  const party = await capsuleFetch(id);
  rows.push({
    id: String(party.id),
    name: party.name || [party.firstName, party.lastName].filter(Boolean).join(" "),
    jobTitle: party.jobTitle || "",
    organisation: party.organisation?.name || "",
    emails: (party.emailAddresses || []).map((entry) => ({
      id: String(entry.id),
      address: entry.address,
      type: entry.type || "",
    })),
    tags: (party.tags || []).map((tag) => tag.name),
    createdAt: party.createdAt || "",
    updatedAt: party.updatedAt || "",
  });
}
console.log(JSON.stringify(rows, null, 2));
