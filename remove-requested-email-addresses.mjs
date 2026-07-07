import { readFile, writeFile } from "node:fs/promises";

const APPLY = process.argv.includes("--apply");
const requestedEmails = [
  "rui.saraiva@atos.net",
  "tiago.severina@sqimi.com",
  "j.coelho@basicamente.io",
  "ana@circleconsultinggroup.com",
  "joana@circleconsultinggroup.com",
  "nuno.artilheiro@adnovum.com",
  "rita.matias@hays.com",
  "dgeneral@elcinfo.com",
  "carlos.regis@litthub.com",
  "tiagomartins@tiagocunhamartins.eu",
  "cassio.souza@foxit.pt",
  "leticia.neves@migso-pcubed.com",
  "paulo.silva@milesinthesky.education",
  "mcarvalho@boatcenter.pt",
  "francisco.caramujo@kantar.com",
  "isa.l@glinttglobal.com",
  "paulo.malta@diconium.com",
  "ana.marques@lindit.eu",
  "pedro.martins@lindit.eu",
  "nuno.guimaraes@kuehne-nagel.com",
  "afonso.pinheiro@importrust.com",
  "lautaro.arguelles@trypleez.com",
  "henrique.cota@eviden.com",
];

const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN nao encontrado.");

function normalize(value) {
  return String(value || "").trim().toLocaleLowerCase("pt-PT");
}

function nextLink(linkHeader) {
  return String(linkHeader || "").replace(/&amp;/g, "&").match(/<([^>]+)>;\s*rel="next"/i)?.[1] || "";
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
  return {
    data: text ? JSON.parse(text) : null,
    link: response.headers.get("link") || "",
  };
}

let url = "/parties?perPage=100&embed=organisation";
const parties = [];
while (url) {
  const { data, link } = await capsuleFetch(url);
  parties.push(...(data.parties || []));
  url = nextLink(link);
}

const targets = new Set(requestedEmails.map(normalize));
const matchedTargets = new Set();
const planned = [];

for (const party of parties) {
  if (party.type !== "person") continue;
  const remove = (party.emailAddresses || []).filter((entry) => {
    const address = normalize(entry.address);
    if (!targets.has(address)) return false;
    matchedTargets.add(address);
    return true;
  });
  if (!remove.length) continue;

  planned.push({
    partyId: String(party.id),
    person: party.name || [party.firstName, party.lastName].filter(Boolean).join(" "),
    organisation: party.organisation?.name || "",
    remove: remove.map((entry) => ({
      id: Number(entry.id),
      address: entry.address,
      type: entry.type || "",
    })),
    remainingEmails: (party.emailAddresses || [])
      .filter((entry) => !remove.some((item) => Number(item.id) === Number(entry.id)))
      .map((entry) => ({ address: entry.address, type: entry.type || "" })),
  });
}

const report = {
  generatedAt: new Date().toISOString(),
  applied: APPLY,
  requestedUnique: targets.size,
  matchedUnique: matchedTargets.size,
  unmatched: [...targets].filter((email) => !matchedTargets.has(email)).sort(),
  affectedProfiles: planned.length,
  planned,
  updated: [],
  errors: [],
};

if (APPLY) {
  for (const item of planned) {
    try {
      await capsuleFetch(`/parties/${item.partyId}`, {
        method: "PUT",
        body: JSON.stringify({
          party: {
            emailAddresses: item.remove.map((entry) => ({ id: entry.id, _delete: true })),
          },
        }),
      });
      report.updated.push({ ...item, status: "updated" });
    } catch (error) {
      report.errors.push({ ...item, error: error.message || String(error) });
    }
  }
}

report.removedEmails = APPLY
  ? report.updated.reduce((sum, item) => sum + item.remove.length, 0)
  : planned.reduce((sum, item) => sum + item.remove.length, 0);
report.updatedProfiles = report.updated.length;
report.errorCount = report.errors.length;

await writeFile("remove-requested-email-addresses-report.json", JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({
  applied: report.applied,
  requestedUnique: report.requestedUnique,
  matchedUnique: report.matchedUnique,
  unmatched: report.unmatched.length,
  affectedProfiles: report.affectedProfiles,
  removedEmails: report.removedEmails,
  updatedProfiles: report.updatedProfiles,
  errors: report.errorCount,
  report: "remove-requested-email-addresses-report.json",
}, null, 2));
