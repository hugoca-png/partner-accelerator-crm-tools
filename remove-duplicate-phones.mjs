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
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return {
    data: response.status === 204 ? null : await response.json(),
    link: response.headers.get("link") || "",
  };
}

function nextLink(linkHeader) {
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/i);
  return match ? match[1] : null;
}

function clean(value) {
  return String(value || "").trim();
}

function partyName(party) {
  return party.name || [party.firstName, party.lastName].filter(Boolean).join(" ") || `(sem nome: ${party.id})`;
}

function canonicalPhone(value) {
  const digits = clean(value).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("351") && digits.length === 12) return digits;
  return digits;
}

function payloadPhone(entry) {
  const output = { ...entry };
  delete output.id;
  return output;
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

async function updatePartyPhones(party, keptPhones) {
  const { data } = await capsuleFetch(`/parties/${party.id}`, {
    method: "PUT",
    body: JSON.stringify({
      party: {
        phoneNumbers: keptPhones.map(payloadPhone),
      },
    }),
  });
  return data.party;
}

const normalizationReport = JSON.parse(await readFile("mobile-phone-normalization-report.json", "utf8"));
const affectedIds = new Set((normalizationReport.updated || normalizationReport.planned || [])
  .map((item) => String(item.partyId))
  .filter(Boolean));

const parties = (await fetchAllParties()).filter((party) => affectedIds.has(String(party.id)));
const planned = [];
const updated = [];

for (const party of parties) {
  const seen = new Map();
  const kept = [];
  const removed = [];

  for (const phone of party.phoneNumbers || []) {
    const key = canonicalPhone(phone.number);
    if (!key) {
      kept.push(phone);
      continue;
    }

    if (!seen.has(key)) {
      seen.set(key, phone);
      kept.push(phone);
      continue;
    }

    removed.push({
      id: phone.id,
      number: phone.number,
      type: phone.type || "",
      label: phone.label || "",
      duplicateOf: seen.get(key).number,
    });
  }

  if (!removed.length) continue;

  planned.push({
    partyId: party.id,
    party: partyName(party),
    type: party.type,
    organisation: party.organisation?.name || "",
    keptCount: kept.length,
    removed,
  });

  if (APPLY) {
    try {
      await updatePartyPhones(party, kept);
      updated.push({
        partyId: party.id,
        party: partyName(party),
        status: "updated",
        removed,
      });
    } catch (error) {
      updated.push({
        partyId: party.id,
        party: partyName(party),
        status: "error",
        error: error.message || String(error),
        removed,
      });
    }
  }
}

const report = {
  mode: APPLY ? "apply" : "dry-run",
  affectedPartiesChecked: parties.length,
  partiesWithDuplicates: planned.length,
  duplicatePhones: planned.reduce((sum, item) => sum + item.removed.length, 0),
  updatedParties: updated.filter((item) => item.status === "updated").length,
  errors: updated.filter((item) => item.status === "error").length,
  planned,
  updated,
};

await writeFile("duplicate-phone-removal-report.json", JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({
  mode: report.mode,
  affectedPartiesChecked: report.affectedPartiesChecked,
  partiesWithDuplicates: report.partiesWithDuplicates,
  duplicatePhones: report.duplicatePhones,
  updatedParties: report.updatedParties,
  errors: report.errors,
  report: "duplicate-phone-removal-report.json",
}, null, 2));
