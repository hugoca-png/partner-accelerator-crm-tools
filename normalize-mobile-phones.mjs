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

function formatPortugueseMobile(value) {
  const raw = clean(value);
  const digits = raw.replace(/\D/g, "");
  if (!digits.startsWith("351")) return null;
  if (digits.length !== 12) return null;
  const national = digits.slice(3);
  if (!/^[29]\d{8}$/.test(national)) return null;
  return `+351 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
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

function payloadPhone(entry, number) {
  const output = { ...entry, number };
  delete output.id;
  return output;
}

async function updatePartyPhones(party, updatedPhones) {
  const { data } = await capsuleFetch(`/parties/${party.id}`, {
    method: "PUT",
    body: JSON.stringify({
      party: {
        phoneNumbers: updatedPhones.map((entry) => payloadPhone(entry, entry.number)),
      },
    }),
  });
  return data.party;
}

const parties = await fetchAllParties();
const planned = [];
const skipped = [];
const updated = [];

for (const party of parties) {
  const phoneNumbers = party.phoneNumbers || [];
  const changes = [];
  const nextPhones = phoneNumbers.map((entry) => {
    const formatted = formatPortugueseMobile(entry.number);
    if (!formatted) {
      const digits = clean(entry.number).replace(/\D/g, "");
      if (digits.startsWith("351") || clean(entry.number).startsWith("+351")) {
        skipped.push({
          partyId: party.id,
          party: partyName(party),
          type: party.type,
          phoneId: entry.id,
          current: entry.number,
          reason: "Não tem exatamente prefixo 351 + 9 dígitos nacionais começados por 2 ou 9.",
        });
      }
      return entry;
    }
    if (formatted === entry.number) return entry;
    changes.push({
      phoneId: entry.id,
      type: entry.type,
      label: entry.label,
      current: entry.number,
      next: formatted,
    });
    return { ...entry, number: formatted };
  });

  if (!changes.length) continue;
  planned.push({
    partyId: party.id,
    party: partyName(party),
    type: party.type,
    organisation: party.organisation?.name || "",
    changes,
  });

  if (APPLY) {
    try {
      await updatePartyPhones(party, nextPhones);
      updated.push({
        partyId: party.id,
        party: partyName(party),
        status: "updated",
        changes,
      });
    } catch (error) {
      updated.push({
        partyId: party.id,
        party: partyName(party),
        status: "error",
        error: error.message || String(error),
        changes,
      });
    }
  }
}

const report = {
  mode: APPLY ? "apply" : "dry-run",
  plannedParties: planned.length,
  plannedPhones: planned.reduce((sum, item) => sum + item.changes.length, 0),
  updatedParties: updated.filter((item) => item.status === "updated").length,
  errors: updated.filter((item) => item.status === "error").length,
  skipped,
  planned,
  updated,
};

await writeFile("mobile-phone-normalization-report.json", JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({
  mode: report.mode,
  plannedParties: report.plannedParties,
  plannedPhones: report.plannedPhones,
  updatedParties: report.updatedParties,
  errors: report.errors,
  skipped: report.skipped.length,
  report: "mobile-phone-normalization-report.json",
}, null, 2));
