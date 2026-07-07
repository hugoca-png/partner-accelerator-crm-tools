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

function ptPhone(value) {
  const digits = clean(value).replace(/\D/g, "");
  const national = digits.length === 12 && digits.startsWith("351")
    ? digits.slice(3)
    : digits.length === 9
      ? digits
      : "";
  if (!/^[29]\d{8}$/.test(national)) return null;
  return {
    key: `351${national}`,
    formatted: `+351 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`,
  };
}

function quality(phone) {
  const number = clean(phone.number);
  if (/^\+351 \d{3} \d{3} \d{3}$/.test(number)) return 4;
  if (number.startsWith("+351")) return 3;
  if (number.replace(/\D/g, "").startsWith("351")) return 2;
  return 1;
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

function buildPhonePatch(party) {
  const groups = new Map();
  for (const phone of party.phoneNumbers || []) {
    const ptPhoneValue = ptPhone(phone.number);
    if (!ptPhoneValue) continue;
    if (!groups.has(ptPhoneValue.key)) groups.set(ptPhoneValue.key, { ptPhoneValue, phones: [] });
    groups.get(ptPhoneValue.key).phones.push(phone);
  }

  const patch = [];
  const removed = [];
  const formatted = [];

  for (const { ptPhoneValue, phones } of groups.values()) {
    const sorted = [...phones].sort((a, b) => quality(b) - quality(a));
    const keep = sorted[0];
    if (keep.number !== ptPhoneValue.formatted) {
      patch.push({ id: keep.id, number: ptPhoneValue.formatted });
      formatted.push({ id: keep.id, from: keep.number, to: ptPhoneValue.formatted });
    }

    for (const phone of sorted.slice(1)) {
      patch.push({ id: phone.id, _delete: true });
      removed.push({ id: phone.id, number: phone.number, duplicateOf: ptPhoneValue.formatted });
    }
  }

  return { patch, removed, formatted };
}

const parties = await fetchAllParties();
const planned = [];
const updated = [];

for (const party of parties) {
  const { patch, removed, formatted } = buildPhonePatch(party);
  if (!patch.length) continue;

  planned.push({
    partyId: party.id,
    party: partyName(party),
    type: party.type,
    organisation: party.organisation?.name || "",
    formatted,
    removed,
  });

  if (APPLY) {
    try {
      await capsuleFetch(`/parties/${party.id}`, {
        method: "PUT",
        body: JSON.stringify({ party: { phoneNumbers: patch } }),
      });
      updated.push({
        partyId: party.id,
        party: partyName(party),
        status: "updated",
        formatted,
        removed,
      });
    } catch (error) {
      updated.push({
        partyId: party.id,
        party: partyName(party),
        status: "error",
        error: error.message || String(error),
        formatted,
        removed,
      });
    }
  }
}

const report = {
  mode: APPLY ? "apply" : "dry-run",
  partiesWithChanges: planned.length,
  numbersFormatted: planned.reduce((sum, item) => sum + item.formatted.length, 0),
  duplicatesRemoved: planned.reduce((sum, item) => sum + item.removed.length, 0),
  updatedParties: updated.filter((item) => item.status === "updated").length,
  errors: updated.filter((item) => item.status === "error").length,
  planned,
  updated,
};

await writeFile("mobile-phone-normalize-dedupe-report.json", JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({
  mode: report.mode,
  partiesWithChanges: report.partiesWithChanges,
  numbersFormatted: report.numbersFormatted,
  duplicatesRemoved: report.duplicatesRemoved,
  updatedParties: report.updatedParties,
  errors: report.errors,
  report: "mobile-phone-normalize-dedupe-report.json",
}, null, 2));
