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
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return {
    data: await response.json(),
    link: response.headers.get("link") || "",
  };
}

function nextLink(linkHeader) {
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/i);
  return match ? match[1] : null;
}

function nameOf(party) {
  return [party.title, party.firstName, party.lastName].filter(Boolean).join(" ") || party.name || `(sem nome: ${party.id})`;
}

let url = "/parties?perPage=100&embed=tags,fields,organisation";
const people = [];
while (url) {
  const { data, link } = await capsuleFetch(url);
  for (const party of data.parties || []) {
    if (party.type !== "person") continue;
    if (party.organisation?.id) continue;
    people.push({
      id: party.id,
      name: nameOf(party),
      emails: (party.emailAddresses || []).map((item) => item.address).filter(Boolean),
      phones: (party.phoneNumbers || []).map((item) => item.number).filter(Boolean),
      tags: (party.tags || []).map((tag) => tag.name).filter(Boolean),
      dataTags: [
        ...(party.tags || []).filter((tag) => tag.dataTag).map((tag) => tag.name),
        ...(party.fields || []).map((field) => field.definition?.tag?.name || "").filter(Boolean),
      ],
    });
  }
  url = nextLink(link);
}

people.sort((a, b) => a.name.localeCompare(b.name, "pt-PT"));
console.log(JSON.stringify({ count: people.length, people }, null, 2));
