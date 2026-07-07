import { readFile, writeFile } from "node:fs/promises";

const APPLY = process.argv.includes("--apply");
const targets = [
  {
    partyId: "285207777",
    person: "Bruno Monteiro",
    currentOrganisation: "Celfocus",
    emailId: "629332064",
    email: "b.m@linkconsulting.com",
    previousOrganisation: "Link",
  },
  {
    partyId: "285307006",
    person: "Bernardo Januario",
    currentOrganisation: "Qevo",
    emailId: "629518099",
    email: "bernardo.januario@linkconsulting.com",
    previousOrganisation: "Link",
  },
  {
    partyId: "285274142",
    person: "Francisco Marques",
    currentOrganisation: "team.it",
    emailId: "629459915",
    email: "francisco.marques@adentis.pt",
    previousOrganisation: "Adentis Portugal",
  },
];

const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN nao encontrado.");

function normalize(value) {
  return String(value || "").trim().toLocaleLowerCase("pt-PT");
}

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
  return text ? JSON.parse(text) : null;
}

const report = {
  generatedAt: new Date().toISOString(),
  applied: APPLY,
  requested: targets.length,
  removed: [],
  skipped: [],
  errors: [],
};

for (const target of targets) {
  try {
    const party = (await capsuleFetch(`/parties/${target.partyId}?embed=organisation`)).party;
    const entry = (party.emailAddresses || []).find((email) =>
      String(email.id) === target.emailId &&
      normalize(email.address) === normalize(target.email) &&
      normalize(email.type) === "work");

    if (!entry) {
      report.skipped.push({ ...target, reason: "email Work ja nao existe ou foi alterado" });
      continue;
    }

    if (party.organisation?.name !== target.currentOrganisation) {
      report.skipped.push({
        ...target,
        reason: "empresa atual mudou; remocao cancelada",
        organisationNow: party.organisation?.name || "",
      });
      continue;
    }

    if (APPLY) {
      await capsuleFetch(`/parties/${target.partyId}`, {
        method: "PUT",
        body: JSON.stringify({
          party: {
            emailAddresses: [{ id: entry.id, _delete: true }],
          },
        }),
      });
    }

    report.removed.push({ ...target, mode: APPLY ? "removed" : "planned" });
  } catch (error) {
    report.errors.push({ ...target, error: error.message || String(error) });
  }
}

report.removedCount = report.removed.length;
report.skippedCount = report.skipped.length;
report.errorCount = report.errors.length;
await writeFile("remove-confirmed-stale-work-emails-report.json", JSON.stringify(report, null, 2), "utf8");

console.log(JSON.stringify({
  applied: report.applied,
  requested: report.requested,
  removed: report.removedCount,
  skipped: report.skippedCount,
  errors: report.errorCount,
  report: "remove-confirmed-stale-work-emails-report.json",
}, null, 2));
