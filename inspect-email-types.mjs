import { readFile } from "node:fs/promises";

const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN não encontrado.");

async function capsuleFetch(path) {
  const url = path.startsWith("http") ? path : `https://api.capsulecrm.com/api/v2${path}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) throw new Error(`Capsule ${response.status}: ${await response.text()}`);
  return {
    data: await response.json(),
    link: response.headers.get("link") || "",
  };
}

function nextLink(linkHeader) {
  const match = linkHeader.replace(/&amp;/g, "&").match(/<([^>]+)>;\s*rel="next"/i);
  return match ? match[1] : null;
}

let url = "/parties?perPage=100&embed=organisation";
const counts = {};
const samples = [];

while (url) {
  const { data, link } = await capsuleFetch(url);
  for (const party of data.parties || []) {
    for (const email of party.emailAddresses || []) {
      const type = email.type || "(empty)";
      counts[type] = (counts[type] || 0) + 1;
      if (samples.length < 40) {
        samples.push({
          partyId: String(party.id),
          party: party.name || [party.firstName, party.lastName].filter(Boolean).join(" "),
          organisation: party.organisation?.name || "",
          email: email.address,
          type: email.type || "",
        });
      }
    }
  }
  url = nextLink(link);
}

console.log(JSON.stringify({ counts, samples }, null, 2));
