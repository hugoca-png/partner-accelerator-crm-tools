import { readFile, writeFile } from "node:fs/promises";

const APPLY = process.argv.includes("--apply");

const highAndMediumUpdates = [
  {
    id: "285375536",
    name: "Beyond Vision",
    confidence: "alta",
    address: {
      type: "Office",
      street: "Rua da Boavista, 678",
      city: "Porto",
      zip: "4050-105",
      country: "Portugal",
    },
    source: "https://beyond-vision.com/contacts/",
  },
  {
    id: "285516321",
    name: "DeepL",
    confidence: "alta",
    address: {
      type: "Office",
      street: "Maarweg 165",
      city: "Cologne",
      zip: "50825",
      country: "Germany",
    },
    source: "https://www.deepl.com/en/publisher",
  },
  {
    id: "285517217",
    name: "Fyld",
    confidence: "alta",
    address: {
      type: "Office",
      street: "Rua Actor Taborda, 27, 3 piso",
      city: "Lisboa",
      zip: "1000-007",
      country: "Portugal",
    },
    source: "https://www.fyld.pt/",
  },
  {
    id: "285517141",
    name: "HMR - Health Market Research",
    confidence: "alta",
    address: {
      type: "Office",
      street: "Beloura Office Park, Edificio 10, Piso 2, Fraccao F, Quinta da Beloura",
      city: "Sintra",
      zip: "2710-693",
      country: "Portugal",
    },
    source: "https://hmr.co.com/",
  },
  {
    id: "285516078",
    name: "PULSAR Development International (UK)",
    confidence: "alta",
    address: {
      type: "Office",
      street: "11 Perrin's Lane",
      city: "London",
      zip: "NW3 1QY",
      country: "United Kingdom",
    },
    source: "https://www.pulsar-development.com/contact",
  },
  {
    id: "285281441",
    name: "StandOUT Technologies",
    confidence: "alta",
    address: {
      type: "Office",
      street: "Avenida Jose Malhoa, 16F, Piso 1, Bloco A, Edificio Europa",
      city: "Lisboa",
      zip: "1070-159",
      country: "Portugal",
    },
    source: "https://standout-tech.com/",
  },
  {
    id: "284985752",
    name: "Soko",
    confidence: "alta",
    address: {
      type: "Office",
      city: "Lisboa",
      country: "Portugal",
    },
    source: "https://soko.fyi/terms",
  },
  {
    id: "285725958",
    name: "GreenTape AI",
    confidence: "media",
    address: {
      type: "Office",
      city: "Lisboa",
      country: "Portugal",
    },
    source: "https://www.greentape.app/ public site bundle mentions team split between Lisbon and San Francisco; CRM contact has +351.",
  },
  {
    id: "285605303",
    name: "NAU AI",
    confidence: "media",
    address: {
      type: "Office",
      country: "Portugal",
    },
    source: "https://www.nauai.pt/; .pt domain, geral@nauai.pt and CRM contact has +351.",
  },
];

const lowConfidencePortugalByPhone = [
  { id: "285150896", name: "Between Dialogues" },
  { id: "285227491", name: "BizTastic" },
  { id: "284991053", name: "C.Inov" },
  { id: "285296591", name: "ProcurifAI" },
  { id: "285011300", name: "Strativae" },
  { id: "285249797", name: "The Original Music Book" },
  { id: "285203696", name: "UCO Network" },
  { id: "285605124", name: "Werinteraction" },
].map((item) => ({
  ...item,
  confidence: "baixa",
  address: {
    type: "Office",
    country: "Portugal",
  },
  source: "Baixa confianca: contacto associado no CRM tem telefone +351.",
}));

const updates = [...highAndMediumUpdates, ...lowConfidencePortugalByPhone];

const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN nao encontrado.");

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function hasLocation(address) {
  return Boolean(clean(address.street) || clean(address.city) || clean(address.country) || clean(address.zip));
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

const report = {
  generatedAt: new Date().toISOString(),
  applied: APPLY,
  planned: updates.length,
  updated: [],
  skipped: [],
  errors: [],
  leftBlank: [
    { name: "Apex Ahead", reason: "baixa confianca e sem telefone +351 registado no contacto" },
    { name: "Head of Engineering", reason: "parece registo mal classificado e sem telefone +351" },
    { name: "ThePrePlan", reason: "sem evidencia suficiente e sem telefone +351" },
  ],
};

for (const update of updates) {
  try {
    const party = (await capsuleFetch(`/parties/${update.id}`)).party;
    const addresses = party.addresses || [];
    const populated = addresses.find(hasLocation);
    if (populated) {
      report.skipped.push({
        id: update.id,
        name: party.name,
        confidence: update.confidence,
        reason: "morada/cidade/pais ja preenchidos",
        currentAddress: populated,
      });
      continue;
    }

    const emptyAddress = addresses.find((address) => address.id);
    const payload = emptyAddress
      ? { ...update.address, id: emptyAddress.id, type: emptyAddress.type || update.address.type || "Office" }
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
      confidence: update.confidence,
      address: update.address,
      source: update.source,
      mode: APPLY ? "updated" : "planned",
    });
  } catch (error) {
    report.errors.push({
      id: update.id,
      name: update.name,
      confidence: update.confidence,
      error: error.message || String(error),
    });
  }
}

report.updatedCount = report.updated.length;
report.skippedCount = report.skipped.length;
report.errorCount = report.errors.length;

await writeFile("missing-location-confidence-update-report.json", JSON.stringify(report, null, 2), "utf8");

console.log(JSON.stringify({
  applied: report.applied,
  planned: report.planned,
  updated: report.updatedCount,
  skipped: report.skippedCount,
  errors: report.errorCount,
  leftBlank: report.leftBlank.length,
  report: "missing-location-confidence-update-report.json",
}, null, 2));
