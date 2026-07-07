import { readFile, writeFile } from "node:fs/promises";

const APPLY = process.argv.includes("--apply");

const protectedNames = new Set([
  "Be-CSP Portugal",
  "Bliss Applications",
  "CPCECHO",
  "Latourrette.ai",
  "Rita Pedrosa Unipessoal Lda",
  "Softstore",
]);

const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN nao encontrado.");

const cache = JSON.parse(await readFile("capsule-cache.json", "utf8"));

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
  if (!response.ok) throw new Error(`Capsule ${response.status}: ${text || response.statusText}`);
  return text ? JSON.parse(text) : null;
}

function hasIamcp(partyOrOrg) {
  const tags = [
    ...(partyOrOrg.tags || []),
    ...(partyOrOrg.dataTags || []),
  ].map((tag) => typeof tag === "string" ? tag : tag.name || tag.label || tag.value || "");
  return tags.some((tag) => String(tag).toLocaleLowerCase("pt-PT").includes("iamcp"));
}

async function countPeopleForOrganisation(orgId) {
  let url = `/parties?perPage=100&embed=organisation&organisationId=${encodeURIComponent(orgId)}`;
  let count = 0;
  while (url) {
    const { parties = [] } = await capsuleFetch(url);
    count += parties.filter((party) => party.type === "person" && String(party.organisation?.id || "") === String(orgId)).length;
    break;
  }
  return count;
}

const candidates = (cache.organisations || [])
  .filter((org) => !(org.contacts || []).length)
  .map((org) => ({
    id: String(org.id),
    name: org.name,
    city: org.city || "",
    country: org.country || "",
    tags: org.tags || [],
    dataTags: org.dataTags || [],
  }));

const report = {
  generatedAt: new Date().toISOString(),
  applied: APPLY,
  candidatesFromCache: candidates.length,
  deleted: [],
  skipped: [],
  errors: [],
};

for (const candidate of candidates) {
  try {
    if (protectedNames.has(candidate.name) || hasIamcp(candidate)) {
      report.skipped.push({ ...candidate, reason: "protegida por IAMCP/lista de excecoes" });
      continue;
    }

    const current = (await capsuleFetch(`/parties/${candidate.id}?embed=tags`)).party;
    if (!current) {
      report.skipped.push({ ...candidate, reason: "nao encontrada" });
      continue;
    }
    if (current.type !== "organisation") {
      report.skipped.push({ ...candidate, reason: `nao e organizacao: ${current.type}` });
      continue;
    }
    if (protectedNames.has(current.name) || hasIamcp(current)) {
      report.skipped.push({ ...candidate, currentName: current.name, reason: "protegida por IAMCP/lista de excecoes no CRM" });
      continue;
    }

    const peopleCount = await countPeopleForOrganisation(candidate.id);
    if (peopleCount > 0) {
      report.skipped.push({ ...candidate, currentName: current.name, reason: `tem ${peopleCount} contacto(s) no CRM` });
      continue;
    }

    if (APPLY) {
      await capsuleFetch(`/parties/${candidate.id}`, { method: "DELETE" });
    }

    report.deleted.push({
      ...candidate,
      currentName: current.name,
      mode: APPLY ? "deleted" : "planned",
    });
  } catch (error) {
    report.errors.push({
      ...candidate,
      error: error.message || String(error),
    });
  }
}

report.deletedCount = report.deleted.length;
report.skippedCount = report.skipped.length;
report.errorCount = report.errors.length;

await writeFile("delete-empty-organisations-except-iamcp-report.json", JSON.stringify(report, null, 2), "utf8");

console.log(JSON.stringify({
  applied: report.applied,
  candidatesFromCache: report.candidatesFromCache,
  deleted: report.deletedCount,
  skipped: report.skippedCount,
  errors: report.errorCount,
  report: "delete-empty-organisations-except-iamcp-report.json",
}, null, 2));
