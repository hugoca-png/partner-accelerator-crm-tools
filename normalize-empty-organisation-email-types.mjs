import { readFile, writeFile } from "node:fs/promises";

const APPLY = process.argv.includes("--apply");
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
  return { data: response.status === 204 ? null : await response.json(), link: response.headers.get("link") || "" };
}

function nextLink(linkHeader) {
  const match = linkHeader.replace(/&amp;/g, "&").match(/<([^>]+)>;\s*rel="next"/i);
  return match ? match[1] : null;
}

let url = "/parties?perPage=100";
const planned = [];

while (url) {
  const { data, link } = await capsuleFetch(url);
  for (const party of data.parties || []) {
    if (party.type !== "organisation") continue;
    const changes = (party.emailAddresses || [])
      .filter((entry) => entry.id && entry.address && !entry.type)
      .map((entry) => ({
        id: entry.id,
        address: entry.address,
        currentType: entry.type || "",
        desiredType: "Work",
      }));
    if (changes.length) {
      planned.push({
        partyId: String(party.id),
        organisation: party.name || "",
        changes,
      });
    }
  }
  url = nextLink(link);
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
            emailAddresses: item.changes.map((change) => ({ id: change.id, type: "Work" })),
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
  plannedProfiles: planned.length,
  plannedChanges: planned.reduce((sum, item) => sum + item.changes.length, 0),
  updatedProfiles: updated.length,
  updatedChanges: updated.reduce((sum, item) => sum + item.changes.length, 0),
  planned,
  updated,
  errors,
};

await writeFile("normalize-empty-organisation-email-types-report.json", JSON.stringify(output, null, 2), "utf8");
console.log(JSON.stringify({
  applied: output.applied,
  plannedProfiles: output.plannedProfiles,
  plannedChanges: output.plannedChanges,
  updatedProfiles: output.updatedProfiles,
  updatedChanges: output.updatedChanges,
  errors: output.errors.length,
  report: "normalize-empty-organisation-email-types-report.json",
}, null, 2));
