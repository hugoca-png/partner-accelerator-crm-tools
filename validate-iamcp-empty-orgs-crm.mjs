import { readFile } from "node:fs/promises";

const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN nao encontrado.");

const names = new Set([
  "Be-CSP Portugal",
  "Bliss Applications",
  "CPCECHO",
  "Latourrette.ai",
  "Rita Pedrosa Unipessoal Lda",
  "Softstore",
]);

async function capsuleFetch(path) {
  const url = path.startsWith("http") ? path : `https://api.capsulecrm.com/api/v2${path}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Capsule ${response.status}: ${text || response.statusText}`);
  return {
    data: JSON.parse(text),
    link: response.headers.get("link") || "",
  };
}

function nextLink(linkHeader) {
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/i);
  return match ? match[1] : null;
}

function tagNames(party) {
  return (party.tags || [])
    .map((tag) => tag.name || tag.label || tag.value || tag)
    .filter(Boolean);
}

function fullName(person) {
  return [person.firstName, person.lastName].filter(Boolean).join(" ").trim() || person.name || "";
}

let url = "/parties?perPage=100&embed=tags,fields,organisation";
const byId = new Map();
while (url) {
  const { data, link } = await capsuleFetch(url);
  for (const party of data.parties || []) byId.set(String(party.id), party);
  url = nextLink(link);
}

const organisations = [...byId.values()]
  .filter((party) => party.type === "organisation" && names.has(party.name))
  .sort((a, b) => a.name.localeCompare(b.name, "pt-PT"));

const people = [...byId.values()].filter((party) => party.type === "person");
const rows = organisations.map((organisation) => {
  const contacts = people
    .filter((person) => String(person.organisation?.id || "") === String(organisation.id))
    .map((person) => ({
      id: String(person.id),
      name: fullName(person),
      emails: (person.emailAddresses || []).map((email) => email.address).filter(Boolean),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-PT"));

  return {
    empresa: organisation.name,
    id: String(organisation.id),
    tags: tagNames(organisation),
    hasIamcp: tagNames(organisation).some((tag) => String(tag).toLocaleLowerCase("pt-PT").includes("iamcp")),
    contactCount: contacts.length,
    contactsWithoutEmail: contacts.filter((contact) => !contact.emails.length).length,
    contacts,
  };
});

console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  partyCount: byId.size,
  rows,
}, null, 2));
