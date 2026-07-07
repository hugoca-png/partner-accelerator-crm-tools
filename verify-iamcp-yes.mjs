import { readFile } from "node:fs/promises";

const FIELD_DEFINITION_ID = 960239;
const FIELD_NAME = "Membership active";

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
  return response.json();
}

const report = JSON.parse(await readFile("iamcp-yes-report.json", "utf8"));
const rows = [];
for (const item of report.matchedItems || []) {
  const data = await capsuleFetch(`/parties/${item.id}?embed=fields,tags`);
  const party = data.party;
  const field = (party.fields || []).find((entry) =>
    entry.definition?.id === FIELD_DEFINITION_ID ||
    entry.definition?.name === FIELD_NAME ||
    entry.name === FIELD_NAME,
  );
  const iamcpTag = (party.tags || []).find((tag) => tag.name === "IAMCP");
  rows.push({
    id: party.id,
    name: party.name,
    fieldId: field?.id || null,
    definitionId: field?.definition?.id || null,
    definitionName: field?.definition?.name || field?.name || null,
    value: field?.value ?? null,
    rawField: field || null,
    hasIamcpTag: Boolean(iamcpTag),
  });
}

const summary = {
  checked: rows.length,
  yes: rows.filter((row) => row.value === "Yes" || row.value === true || row.value === "true").length,
  missingOrOther: rows.filter((row) => !(row.value === "Yes" || row.value === true || row.value === "true")).length,
  missingTag: rows.filter((row) => !row.hasIamcpTag).length,
  sample: rows.slice(0, 5),
  missingOrOtherRows: rows.filter((row) => !(row.value === "Yes" || row.value === true || row.value === "true")).map((row) => ({
    id: row.id,
    name: row.name,
    value: row.value,
    fieldId: row.fieldId,
    hasIamcpTag: row.hasIamcpTag,
  })),
};

console.log(JSON.stringify(summary, null, 2));
