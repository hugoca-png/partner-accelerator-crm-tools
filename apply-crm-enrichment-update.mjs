import { readFile, writeFile } from "node:fs/promises";

const APPLY = process.argv.includes("--apply");
const PURPOSE_TAGS = {
  Produto: "Produto",
  Servicos: "Serviço",
  Serviços: "Serviço",
  Outsourcing: "Outsourcing",
};
const PURPOSE_TAG_NAMES = [...new Set(Object.values(PURPOSE_TAGS))];

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
  const text = await response.text();
  if (!response.ok) throw new Error(`Capsule ${response.status}: ${text}`);
  return {
    data: text ? JSON.parse(text) : null,
    link: response.headers.get("link") || "",
  };
}

function nextLink(linkHeader) {
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/i);
  return match ? match[1] : null;
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

async function ensurePurposeTags() {
  const tags = await fetchPartyTags();
  const byName = new Map(tags.map((tag) => [tag.name, tag]));
  const output = {};
  for (const name of PURPOSE_TAG_NAMES) {
    if (byName.has(name)) {
      output[name] = byName.get(name);
      continue;
    }
    if (!APPLY) {
      output[name] = { id: `dry-run:${name}`, name };
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

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function desiredPurposeTag(row) {
  return PURPOSE_TAGS[row.purpose] || "";
}

function tagPatch(currentTags, desiredName, tagDefinitions) {
  const currentPurposeTags = (currentTags || []).filter((tag) => PURPOSE_TAG_NAMES.includes(tag.name));
  const currentNames = new Set(currentPurposeTags.map((tag) => tag.name));
  const patch = [];

  for (const tag of currentPurposeTags) {
    if (tag.name !== desiredName) patch.push({ id: tag.id, _delete: true });
  }

  if (desiredName && !currentNames.has(desiredName)) {
    const tag = tagDefinitions[desiredName];
    if (tag?.id) patch.push({ id: tag.id });
  }

  return patch;
}

const plan = JSON.parse(await readFile("crm-enrichment-update-plan.json", "utf8"));
const tagDefinitions = await ensurePurposeTags();
const report = {
  mode: APPLY ? "apply" : "dry-run",
  source: plan.sourceXlsx,
  plannedRows: plan.totalRows,
  plannedDescriptionUpdates: plan.descriptionUpdates,
  plannedTagUpdates: plan.tagUpdates,
  purposeTags: tagDefinitions,
  updated: [],
  skipped: [],
  errors: [],
};

for (const row of plan.rows) {
  const desiredTag = desiredPurposeTag(row);
  if (!desiredTag) {
    report.skipped.push({ id: row.id, name: row.name, reason: "sem propósito" });
    continue;
  }

  try {
    const current = (await capsuleFetch(`/parties/${row.id}?embed=tags,fields`)).data.party;
    const aboutBefore = clean(current.about);
    const description = clean(row.description);
    const shouldUpdateDescription = row.descriptionUpdate && description && aboutBefore !== description;
    const tags = tagPatch(current.tags || [], desiredTag, tagDefinitions);
    const payload = {};
    if (shouldUpdateDescription) payload.about = description;
    if (tags.length) payload.tags = tags;

    if (!Object.keys(payload).length) {
      report.skipped.push({
        id: row.id,
        name: row.name,
        confidence: row.confidence,
        purpose: row.purpose,
        reason: "sem alterações",
      });
      continue;
    }

    if (APPLY) {
      await capsuleFetch(`/parties/${row.id}?embed=tags,fields`, {
        method: "PUT",
        body: JSON.stringify({ party: payload }),
      });
    }

    report.updated.push({
      id: row.id,
      name: row.name,
      confidence: row.confidence,
      purpose: row.purpose,
      purposeTag: desiredTag,
      descriptionUpdated: shouldUpdateDescription,
      tagChanges: tags.length,
      descriptionLength: description.length,
      mode: APPLY ? "updated" : "planned",
    });
  } catch (error) {
    report.errors.push({
      id: row.id,
      name: row.name,
      confidence: row.confidence,
      purpose: row.purpose,
      error: error.message || String(error),
    });
  }
}

report.updatedCount = report.updated.length;
report.skippedCount = report.skipped.length;
report.errorCount = report.errors.length;
report.descriptionUpdatedCount = report.updated.filter((item) => item.descriptionUpdated).length;
report.tagChangedCount = report.updated.filter((item) => item.tagChanges > 0).length;

await writeFile("crm-enrichment-update-report.json", JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({
  mode: report.mode,
  plannedRows: report.plannedRows,
  updatedCount: report.updatedCount,
  skippedCount: report.skippedCount,
  errorCount: report.errorCount,
  descriptionUpdatedCount: report.descriptionUpdatedCount,
  tagChangedCount: report.tagChangedCount,
  report: "crm-enrichment-update-report.json",
}, null, 2));
