import { readFile } from "node:fs/promises";

const id = process.argv[2];
if (!id) throw new Error("Uso: node inspect-party-addresses.mjs <partyId>");

const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN nao encontrado.");

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

const data = await capsuleFetch(`/parties/${id}`);
const party = data.party;
console.log(JSON.stringify({
  id: party.id,
  name: party.name,
  addresses: party.addresses || [],
}, null, 2));
