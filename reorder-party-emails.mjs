import { readFile } from "node:fs/promises";

const partyId = process.argv[2];
if (!partyId) throw new Error("Uso: node reorder-party-emails.mjs <partyId>");

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

function priority(type) {
  if (type === "Work") return 0;
  if (type === "Home") return 2;
  return 1;
}

function snapshot(party) {
  return (party.emailAddresses || []).map((entry) => ({
    id: Number(entry.id),
    address: entry.address,
    type: entry.type || "",
  }));
}

const beforeParty = (await capsuleFetch(`/parties/${partyId}`)).party;
const before = snapshot(beforeParty);
const ordered = before
  .map((entry, index) => ({ ...entry, index }))
  .sort((a, b) => priority(a.type) - priority(b.type) || a.index - b.index)
  .map(({ id, address, type }) => ({ id, address, type }));

await capsuleFetch(`/parties/${partyId}`, {
  method: "PUT",
  body: JSON.stringify({ party: { emailAddresses: ordered } }),
});

const afterParty = (await capsuleFetch(`/parties/${partyId}`)).party;
const after = snapshot(afterParty);
console.log(JSON.stringify({
  partyId,
  party: afterParty.name || [afterParty.firstName, afterParty.lastName].filter(Boolean).join(" "),
  before,
  requested: ordered,
  after,
  orderConfirmed: JSON.stringify(ordered) === JSON.stringify(after),
}, null, 2));
