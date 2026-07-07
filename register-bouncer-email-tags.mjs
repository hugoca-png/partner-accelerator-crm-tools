import { readFile, writeFile } from "node:fs/promises";

const TAGS = {
  deliverable: "Email Deliverable",
  risky: "Email Risky",
  undeliverable: "Email Undeliverable",
  catchAll: "Email Catch-All",
};

const APPLY = process.argv.includes("--apply");
const LIMIT = Number(process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1] || 70);

const env = await readFile(".env", "utf8");
const capsuleToken = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
const bouncerKey = process.env.BOUNCER_API_KEY;

if (!capsuleToken) throw new Error("CAPSULE_TOKEN não encontrado em .env.");
if (!bouncerKey) throw new Error("Define BOUNCER_API_KEY no ambiente.");

async function capsuleFetch(path, options = {}) {
  const url = path.startsWith("http") ? path : `https://api.capsulecrm.com/api/v2${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${capsuleToken}`,
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

async function fetchPartyTags() {
  let url = "/parties/tags?perPage=100";
  const tags = [];
  while (url) {
    const { data, link } = await capsuleFetch(url);
    tags.push(...(data.tags || []));
    url = nextLink(link);
  }
  return tags;
}

async function ensureTags() {
  const existing = new Map((await fetchPartyTags()).map((tag) => [tag.name, tag]));
  const output = {};
  for (const name of Object.values(TAGS)) {
    if (existing.has(name)) {
      output[name] = existing.get(name);
      continue;
    }
    if (!APPLY) {
      output[name] = { id: null, name, status: "would_create" };
      continue;
    }
    const { data } = await capsuleFetch("/parties/tags", {
      method: "POST",
      body: JSON.stringify({ tag: { name, dataTag: false } }),
    });
    output[name] = data.tag;
  }
  return output;
}

function partyName(party) {
  return party.name || [party.firstName, party.lastName].filter(Boolean).join(" ") || `(sem nome: ${party.id})`;
}

function emailAddresses(party) {
  return (party.emailAddresses || []).map((entry) => String(entry.address || "").trim()).filter(Boolean);
}

function domainsForOrg(org) {
  return (org.websites || [])
    .map((site) => site.url || site.address || "")
    .map((url) => {
      try {
        return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./i, "");
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

function genericEmail(email) {
  return /^(info|geral|contact|contacts|hello|sales|comercial|admin|support|marketing|office)@/i.test(email);
}

function selectSample(parties) {
  const organisations = new Map(parties.filter((party) => party.type === "organisation").map((party) => [String(party.id), party]));
  const rows = [];
  for (const person of parties.filter((party) => party.type === "person")) {
    const org = organisations.get(String(person.organisation?.id || ""));
    const domains = new Set(domainsForOrg(org || {}).map((domain) => domain.toLowerCase()));
    for (const email of emailAddresses(person)) {
      const domain = String(email.split("@")[1] || "").toLowerCase();
      rows.push({
        id: String(person.id),
        name: partyName(person),
        organisation: org ? partyName(org) : "",
        email,
        domainMatch: domains.has(domain),
        generic: genericEmail(email),
      });
    }
  }

  const seen = new Set();
  return rows
    .filter((row) => {
      const key = row.email.toLowerCase();
      if (!key.includes("@") || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((row) => ({
      ...row,
      scorePick: 4 + (row.domainMatch ? 4 : 0) - (row.generic ? 2 : 0),
    }))
    .sort((a, b) =>
      b.scorePick - a.scorePick ||
      a.organisation.localeCompare(b.organisation, "pt-PT") ||
      a.email.localeCompare(b.email, "pt-PT"),
    )
    .slice(0, LIMIT);
}

async function verifyEmails(emails) {
  const response = await fetch("https://api.usebouncer.com/v1.1/email/verify/batch/sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": bouncerKey,
    },
    body: JSON.stringify(emails),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Bouncer ${response.status}: ${text}`);
  return JSON.parse(text);
}

function tagNamesForResult(result) {
  const names = [];
  if (result.status === "deliverable") names.push(TAGS.deliverable);
  if (result.status === "risky") names.push(TAGS.risky);
  if (result.status === "undeliverable") names.push(TAGS.undeliverable);
  if (result.domain?.acceptAll === "yes") names.push(TAGS.catchAll);
  return names;
}

async function updatePersonTags(personId, tagNames, tagDefinitions) {
  const tags = tagNames
    .map((name) => tagDefinitions[name])
    .filter((tag) => tag?.id)
    .map((tag) => ({ id: tag.id }));
  if (!tags.length) return null;
  const { data } = await capsuleFetch(`/parties/${personId}?embed=tags`, {
    method: "PUT",
    body: JSON.stringify({ party: { tags } }),
  });
  return data.party;
}

const parties = await fetchAllParties();
const sample = selectSample(parties);
const results = await verifyEmails(sample.map((row) => row.email));
const byEmail = new Map(results.map((result) => [String(result.email).toLowerCase(), result]));
const tagDefinitions = await ensureTags();

const rows = [];
for (const item of sample) {
  const result = byEmail.get(item.email.toLowerCase()) || {};
  const tagNames = tagNamesForResult(result);
  let status = APPLY ? "no_tags" : "would_update";
  let updatedTags = [];
  if (tagNames.length) {
    if (APPLY) {
      const updated = await updatePersonTags(item.id, tagNames, tagDefinitions);
      status = updated ? "updated" : "no_tags";
      updatedTags = (updated?.tags || []).map((tag) => tag.name).filter(Boolean);
    }
  }
  rows.push({
    id: item.id,
    name: item.name,
    organisation: item.organisation,
    email: item.email,
    bouncer: {
      status: result.status || "",
      reason: result.reason || "",
      score: result.score ?? null,
      acceptAll: result.domain?.acceptAll || "",
      role: result.account?.role || "",
      disposable: result.domain?.disposable || "",
      free: result.domain?.free || "",
      provider: result.provider || "",
    },
    tagNames,
    status,
    updatedTags,
  });
}

const output = {
  applied: APPLY,
  limit: LIMIT,
  checked: rows.length,
  counts: rows.reduce((acc, row) => {
    const key = row.bouncer.status || "missing";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {}),
  tagDefinitions,
  updated: rows.filter((row) => row.status === "updated").length,
  rows,
};

await writeFile("bouncer-email-tags-report.json", JSON.stringify(output, null, 2), "utf8");
console.log(JSON.stringify({
  applied: output.applied,
  checked: output.checked,
  counts: output.counts,
  updated: output.updated,
  report: "bouncer-email-tags-report.json",
}, null, 2));
