import { readFile } from "node:fs/promises";

const query = process.argv.slice(2).join(" ").trim();
if (!query) throw new Error("Indica o nome a procurar.");

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
  return party.name || [party.firstName, party.lastName].filter(Boolean).join(" ");
}

let url = "/parties?perPage=100&embed=organisation";
const matches = [];
while (url) {
  const { data, link } = await capsuleFetch(url);
  for (const party of data.parties || []) {
    if (nameOf(party).toLocaleLowerCase("pt-PT").includes(query.toLocaleLowerCase("pt-PT"))) {
      matches.push({
        id: party.id,
        type: party.type,
        name: nameOf(party),
        organisation: party.organisation?.name || "",
        phoneNumbers: party.phoneNumbers || [],
      });
    }
  }
  url = nextLink(link);
}

console.log(JSON.stringify(matches, null, 2));
