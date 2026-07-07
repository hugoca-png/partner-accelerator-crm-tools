import { readFile, writeFile } from "node:fs/promises";

const APPLY = process.argv.includes("--apply");

const candidates = [
  ["285187202", "Amplemarket HQ", "San Francisco", "United States", "media"],
  ["285248653", "Bee Engineering ICT", "Lisboa", "Portugal", "media"],
  ["285080342", "Brighten Consulting", "Lisboa", "Portugal", "alta"],
  ["285138662", "Building Creative Machines", "Lisboa", "Portugal", "media"],
  ["284942252", "CyberInspect", "Lisboa", "Portugal", "media"],
  ["285200018", "Cyient", "Hyderabad", "India", "alta"],
  ["285287962", "Dynargie Portugal", "Lisboa", "Portugal", "media"],
  ["285143981", "Emeis", "Paris", "France", "alta"],
  ["285204020", "ENDIPREV", "Matosinhos", "Portugal", "alta"],
  ["285080332", "ENDVR Sports", "Montreal", "Canada", "media"],
  ["284991047", "GoTuk", "Lisboa", "Portugal", "media"],
  ["285080139", "IN2ACTION - Engaging People & Business", "Lisboa", "Portugal", "media"],
  ["285227336", "Indico Capital Partners", "Lisboa", "Portugal", "alta"],
  ["285203936", "INFORM GmbH - Optimization Software", "Aachen", "Germany", "alta"],
  ["285282406", "Ireland Portugal Business Network", "Lisboa", "Portugal", "media"],
  ["285200055", "LBC", "Lisboa", "Portugal", "media"],
  ["285195485", "OutSystems", "Lisboa", "Portugal", "media"],
  ["285186520", "Popdigit", "Lisboa", "Portugal", "media"],
  ["285138815", "Promethean", "Blackburn", "United Kingdom", "alta"],
  ["285203949", "Remote", "San Francisco", "United States", "media"],
  ["285204300", "Zetes Goods ID", "Brussels", "Belgium", "alta"],
].map(([id, name, city, country, confidence]) => ({ id, name, city, country, confidence }));

const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN nao encontrado.");

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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
  if (!response.ok) throw new Error(`Capsule ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function chooseAddress(addresses) {
  return (
    addresses.find((address) => clean(address.city) || clean(address.country)) ||
    addresses.find((address) => address.id) ||
    null
  );
}

const report = {
  generatedAt: new Date().toISOString(),
  applied: APPLY,
  plannedCount: candidates.length,
  updated: [],
  skipped: [],
  errors: [],
};

for (const candidate of candidates) {
  try {
    const data = await capsuleFetch(`/parties/${candidate.id}`);
    const party = data.party;
    const addresses = party.addresses || [];
    const address = chooseAddress(addresses);
    const currentCountry = clean(address?.country);
    const currentCity = clean(address?.city);

    if (currentCountry) {
      report.skipped.push({
        ...candidate,
        partyName: party.name,
        reason: "pais ja preenchido no CRM",
        currentCity,
        currentCountry,
      });
      continue;
    }

    const patchAddress = address?.id
      ? {
          id: address.id,
          type: address.type || "Office",
          city: candidate.city,
          country: candidate.country,
        }
      : {
          type: "Office",
          city: candidate.city,
          country: candidate.country,
        };

    if (APPLY) {
      await capsuleFetch(`/parties/${candidate.id}`, {
        method: "PUT",
        body: JSON.stringify({
          party: {
            addresses: [patchAddress],
          },
        }),
      });
    }

    report.updated.push({
      ...candidate,
      partyName: party.name,
      previousCity: currentCity,
      previousCountry: currentCountry,
      addressMode: address?.id ? "updated-existing-address" : "created-work-address",
      addressId: address?.id || "",
      mode: APPLY ? "updated" : "planned",
    });
  } catch (error) {
    report.errors.push({
      ...candidate,
      error: error.message || String(error),
    });
  }
}

report.updatedCount = report.updated.length;
report.skippedCount = report.skipped.length;
report.errorCount = report.errors.length;

await writeFile("missing-country-location-update-report.json", JSON.stringify(report, null, 2), "utf8");

console.log(JSON.stringify({
  applied: report.applied,
  plannedCount: report.plannedCount,
  updatedCount: report.updatedCount,
  skippedCount: report.skippedCount,
  errorCount: report.errorCount,
  report: "missing-country-location-update-report.json",
}, null, 2));
