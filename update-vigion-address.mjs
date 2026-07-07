import { readFile, writeFile } from "node:fs/promises";

const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN nao encontrado.");

const partyId = "285203889";
const address = {
  type: "Office",
  street: "Avenida Vasco da Gama, 2247, Pavilhao D",
  city: "Vila Nova de Gaia",
  zip: "4430-249",
  country: "Portugal",
};

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

const before = (await capsuleFetch(`/parties/${partyId}`)).party;
if ((before.addresses || []).length) {
  throw new Error("O registo ja tem endereco. Atualizacao cancelada para evitar sobrescrita.");
}

await capsuleFetch(`/parties/${partyId}`, {
  method: "PUT",
  body: JSON.stringify({ party: { addresses: [address] } }),
});

const after = (await capsuleFetch(`/parties/${partyId}`)).party;
const report = {
  generatedAt: new Date().toISOString(),
  partyId,
  name: after.name,
  address: after.addresses || [],
  source: "https://www.vigiongroup.com/; https://vigion.com/",
};

await writeFile("vigion-address-update-report.json", JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
