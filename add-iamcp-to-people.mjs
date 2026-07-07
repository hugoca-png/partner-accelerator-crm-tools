import { readFile, writeFile } from "node:fs/promises";

const IAMCP_TAG_ID = 5809359;
const IAMCP_TAG_NAME = "IAMCP";

const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN não encontrado.");

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
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return {
    data: response.status === 204 ? null : await response.json(),
    link: response.headers.get("link") || "",
  };
}

function nextLink(linkHeader) {
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/i);
  return match ? match[1] : null;
}

function hasIamcpTag(party) {
  const tags = party.tags || [];
  const fields = party.fields || [];
  return tags.some((tag) =>
    String(tag.id) === String(IAMCP_TAG_ID) ||
    String(tag.name).toLocaleLowerCase("pt-PT") === IAMCP_TAG_NAME.toLocaleLowerCase("pt-PT"),
  ) || fields.some((field) =>
    String(field.tagId) === String(IAMCP_TAG_ID) ||
    String(field.definition?.tag?.id) === String(IAMCP_TAG_ID) ||
    String(field.definition?.tag?.name).toLocaleLowerCase("pt-PT") === IAMCP_TAG_NAME.toLocaleLowerCase("pt-PT"),
  );
}

function partyName(party) {
  return party.name || [party.firstName, party.lastName].filter(Boolean).join(" ") || `(sem nome: ${party.id})`;
}

async function fetchAllParties() {
  let url = "/parties?perPage=100&embed=tags,fields,organisation";
  const parties = [];
  while (url) {
    const { data, link } = await capsuleFetch(url);
    parties.push(...(data.parties || []));
    url = nextLink(link);
  }
  return parties;
}

async function addIamcpTagToPerson(person) {
  const { data } = await capsuleFetch(`/parties/${person.id}?embed=tags,fields,organisation`, {
    method: "PUT",
    body: JSON.stringify({
      party: {
        tags: [{ id: IAMCP_TAG_ID }],
      },
    }),
  });
  return data.party;
}

const apply = process.argv.includes("--apply");
const parties = await fetchAllParties();
const iamcpOrgIds = new Set(
  parties
    .filter((party) => party.type === "organisation" && hasIamcpTag(party))
    .map((party) => String(party.id)),
);
const orgNameById = new Map(
  parties
    .filter((party) => party.type === "organisation")
    .map((party) => [String(party.id), partyName(party)]),
);

const linkedPeople = parties.filter((party) =>
  party.type === "person" &&
  party.organisation?.id &&
  iamcpOrgIds.has(String(party.organisation.id)),
);

const toTag = linkedPeople.filter((person) => !hasIamcpTag(person));
const alreadyTagged = linkedPeople.filter((person) => hasIamcpTag(person));
const updates = [];

if (apply) {
  for (const person of toTag) {
    try {
      const updated = await addIamcpTagToPerson(person);
      updates.push({
        id: updated.id,
        name: partyName(updated),
        organisation: orgNameById.get(String(person.organisation.id)) || "",
        status: hasIamcpTag(updated) ? "tagged" : "updated_but_not_visible",
      });
    } catch (error) {
      updates.push({
        id: person.id,
        name: partyName(person),
        organisation: orgNameById.get(String(person.organisation.id)) || "",
        status: "error",
        error: error.message || String(error),
      });
    }
  }
}

const report = {
  mode: apply ? "apply" : "dry-run",
  iamcpOrganisations: iamcpOrgIds.size,
  linkedPeople: linkedPeople.length,
  alreadyTagged: alreadyTagged.length,
  toTag: toTag.length,
  tagged: updates.filter((row) => row.status === "tagged").length,
  errors: updates.filter((row) => row.status === "error").length,
  notVisible: updates.filter((row) => row.status === "updated_but_not_visible").length,
  peopleToTag: toTag.map((person) => ({
    id: person.id,
    name: partyName(person),
    organisation: orgNameById.get(String(person.organisation.id)) || "",
  })),
  updates,
};

await writeFile("iamcp-people-report.json", JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({
  mode: report.mode,
  iamcpOrganisations: report.iamcpOrganisations,
  linkedPeople: report.linkedPeople,
  alreadyTagged: report.alreadyTagged,
  toTag: report.toTag,
  tagged: report.tagged,
  errors: report.errors,
  notVisible: report.notVisible,
  report: "iamcp-people-report.json",
}, null, 2));
