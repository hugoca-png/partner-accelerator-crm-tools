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
  return response.status === 204 ? null : response.json();
}

function hasIamcpTag(party) {
  return (party.tags || []).some((tag) =>
    String(tag.id) === String(IAMCP_TAG_ID) ||
    String(tag.name).toLocaleLowerCase("pt-PT") === IAMCP_TAG_NAME.toLocaleLowerCase("pt-PT"),
  );
}

const report = JSON.parse(await readFile("iamcp-yes-report.json", "utf8"));
const rows = [];

for (const item of report.matchedItems || []) {
  const before = (await capsuleFetch(`/parties/${item.id}?embed=tags,fields`)).party;
  if (hasIamcpTag(before)) {
    rows.push({ id: before.id, name: before.name, status: "already_tagged" });
    continue;
  }

  try {
    const updated = (await capsuleFetch(`/parties/${item.id}?embed=tags,fields`, {
      method: "PUT",
      body: JSON.stringify({
        party: {
          tags: [{ id: IAMCP_TAG_ID }],
        },
      }),
    })).party;
    rows.push({
      id: updated.id,
      name: updated.name,
      status: hasIamcpTag(updated) ? "tagged" : "updated_but_not_visible",
      tags: (updated.tags || []).map((tag) => ({ id: tag.id, name: tag.name, dataTag: tag.dataTag })),
    });
  } catch (error) {
    rows.push({ id: item.id, name: item.crmName, status: "error", error: error.message || String(error) });
  }
}

const output = {
  checked: rows.length,
  tagged: rows.filter((row) => row.status === "tagged").length,
  alreadyTagged: rows.filter((row) => row.status === "already_tagged").length,
  errors: rows.filter((row) => row.status === "error").length,
  notVisible: rows.filter((row) => row.status === "updated_but_not_visible").length,
  rows,
};

await writeFile("iamcp-datatag-report.json", JSON.stringify(output, null, 2), "utf8");
console.log(JSON.stringify({
  checked: output.checked,
  tagged: output.tagged,
  alreadyTagged: output.alreadyTagged,
  errors: output.errors,
  notVisible: output.notVisible,
  report: "iamcp-datatag-report.json",
}, null, 2));
