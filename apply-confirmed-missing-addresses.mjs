import { readFile, writeFile } from "node:fs/promises";

const APPLY = process.argv.includes("--apply");
const updates = [
  {
    id: "285203816",
    name: "BizTarget",
    address: {
      type: "Office",
      street: "Campo Pequeno, 48",
      city: "Lisboa",
      zip: "1000-081",
      country: "Portugal",
    },
    source: "https://www.biztarget.com/",
  },
  {
    id: "284974483",
    name: "Comudel",
    address: {
      type: "Office",
      street: "Rua do Comercio, 93",
      city: "Lousa",
      zip: "3200-227",
      country: "Portugal",
    },
    source: "https://www.comudel.com/privacy-policy",
  },
  {
    id: "285022075",
    name: "PEPData",
    address: {
      type: "Office",
      street: "Avenida do Atlantico, Edificio Panoramic 16, 14 Piso, Escritorio 8, Parque das Nacoes",
      city: "Lisboa",
      zip: "1990-019",
      country: "Portugal",
    },
    source: "https://www.pepdata.com/contact",
  },
  {
    id: "285274318",
    name: "WFBS",
    address: {
      type: "Office",
      street: "Edificio Mar do Oriente, Alameda dos Oceanos, 61, 3.2, Parque das Nacoes",
      city: "Lisboa",
      zip: "1990-208",
      country: "Portugal",
    },
    source: "https://wfbs.pt/",
  },
  {
    id: "285049282",
    name: "Ten Twenty One",
    address: {
      type: "Office",
      street: "Rua da Manutencao, 71, Edificio A",
      city: "Lisboa",
      zip: "1900-500",
      country: "Portugal",
    },
    source: "http://tentwentyone.io/en/ redirects to https://claranet.pt/; https://claranet.pt/contactos/",
  },
  {
    id: "285227330",
    name: "SYSPHERA",
    address: {
      type: "Office",
      street: "Avenida Assis Brasil, 3982, Sala 1005, Jardim Lindoia",
      city: "Porto Alegre",
      state: "Rio Grande do Sul",
      zip: "91010-003",
      country: "Brazil",
    },
    source: "http://www.sysphera.com/ redirects to https://tech6group.com/; official contact footer",
  },
];

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

const report = {
  generatedAt: new Date().toISOString(),
  applied: APPLY,
  planned: updates.length,
  updated: [],
  skipped: [],
  errors: [],
};

for (const update of updates) {
  try {
    const party = (await capsuleFetch(`/parties/${update.id}`)).party;
    const addresses = party.addresses || [];
    const populated = addresses.find((address) => clean(address.city) || clean(address.country) || clean(address.street));
    if (populated) {
      report.skipped.push({
        id: update.id,
        name: party.name,
        reason: "endereco ja preenchido",
        currentAddress: populated,
      });
      continue;
    }

    const emptyAddress = addresses.find((address) => address.id);
    const payload = emptyAddress
      ? { ...update.address, id: emptyAddress.id, type: emptyAddress.type || "Office" }
      : update.address;

    if (APPLY) {
      await capsuleFetch(`/parties/${update.id}`, {
        method: "PUT",
        body: JSON.stringify({ party: { addresses: [payload] } }),
      });
    }

    report.updated.push({
      id: update.id,
      name: party.name,
      address: update.address,
      source: update.source,
      mode: APPLY ? "updated" : "planned",
    });
  } catch (error) {
    report.errors.push({
      id: update.id,
      name: update.name,
      error: error.message || String(error),
    });
  }
}

report.updatedCount = report.updated.length;
report.skippedCount = report.skipped.length;
report.errorCount = report.errors.length;
await writeFile("confirmed-missing-addresses-update-report.json", JSON.stringify(report, null, 2), "utf8");

console.log(JSON.stringify({
  applied: report.applied,
  planned: report.planned,
  updated: report.updatedCount,
  skipped: report.skippedCount,
  errors: report.errorCount,
  report: "confirmed-missing-addresses-update-report.json",
}, null, 2));
