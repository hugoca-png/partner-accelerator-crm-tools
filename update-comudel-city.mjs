import { readFile } from "node:fs/promises";

const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN nao encontrado.");

async function capsuleFetch(path, options = {}) {
  const response = await fetch(`https://api.capsulecrm.com/api/v2${path}`, {
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

const partyId = "284974483";
const before = (await capsuleFetch(`/parties/${partyId}`)).party;
const address = (before.addresses || []).find((item) => item.id);
if (!address) throw new Error("Comudel nao tem endereco para atualizar.");

await capsuleFetch(`/parties/${partyId}`, {
  method: "PUT",
  body: JSON.stringify({
    party: {
      addresses: [{
        id: address.id,
        type: address.type || "Office",
        street: address.street || "",
        city: "Lousã",
        state: address.state || "",
        zip: address.zip || "",
        country: address.country || "Portugal",
      }],
    },
  }),
});

const after = (await capsuleFetch(`/parties/${partyId}`)).party;
console.log(JSON.stringify({
  id: after.id,
  name: after.name,
  address: after.addresses || [],
}, null, 2));
