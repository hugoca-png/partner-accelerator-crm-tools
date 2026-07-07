import { readFile, writeFile } from "node:fs/promises";

const APPLY = process.argv.includes("--apply");

const TARGET_EMAILS = `
aalbuquerque@ucp.pt
amandio.rego@bit-si.com
angel.mateos@bt.com
anovais@alter-solutions.com
diogo.correia@tribetech.pt
filipa.sequeira@joyn-group.com
frederico.sommer@veraib.com
hugo.d@joyn-group.com
hugo@joyngroup.com
hugop@cofinpro.pt
joana@ungapyear.com
joao.graca@replai.io
joao.saraiva@luzagroup.com
joao_c_costa@yahoo.com
jorge.azinheiro@softventure.pt
julio.kollter@migso-pcubed.com
livio_j@smartconsulting.pt
luis.lanca@pt.logicalis.com
miguelcarvalho@domatica.io
nina.urbancic@b2-bi.com
nuno.donato@thriving.pt
pedro@blisslead.com
pedro@collab.inc
pserrano@smartgovernance.com
rdbarone@hotmail.com
rodrigo.barone@pt.logicalis.com
rodrigo.povoa@arpa.tech
rui.soares@itsmf.pt
rui.vas@altar.io
rui.vas@techstars.com
salgas_salgas@hotmail.com
tiago@factorial.io
`;

const targets = new Set(
  TARGET_EMAILS.split(/\r?\n/)
    .map((email) => email.trim().toLocaleLowerCase("pt-PT"))
    .filter(Boolean),
);

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

function partyName(party) {
  return party.name || [party.firstName, party.lastName].filter(Boolean).join(" ") || `(sem nome: ${party.id})`;
}

async function fetchAllParties() {
  let url = "/parties?perPage=100&embed=organisation";
  const parties = [];
  while (url) {
    const { data, link } = await capsuleFetch(url);
    parties.push(...(data.parties || []));
    url = nextLink(link);
  }
  return parties;
}

const parties = await fetchAllParties();
const planned = [];
const unmatched = new Set(targets);

for (const party of parties) {
  const matches = (party.emailAddresses || []).filter((entry) => {
    const address = String(entry.address || "").trim().toLocaleLowerCase("pt-PT");
    if (!targets.has(address)) return false;
    unmatched.delete(address);
    return true;
  });
  if (!matches.length) continue;
  planned.push({
    partyId: String(party.id),
    type: party.type,
    party: partyName(party),
    organisation: party.organisation?.name || "",
    remove: matches.map((entry) => ({
      id: entry.id,
      address: entry.address,
      type: entry.type || "",
    })),
    remainingEmails: (party.emailAddresses || [])
      .filter((entry) => !matches.some((match) => String(match.id) === String(entry.id)))
      .map((entry) => entry.address)
      .filter(Boolean),
  });
}

const updated = [];
const errors = [];
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
      updated.push({ ...item, status: "updated" });
    } catch (error) {
      errors.push({ ...item, status: "error", error: error.message || String(error) });
    }
  }
}

const output = {
  applied: APPLY,
  requested: targets.size,
  matchedEmails: targets.size - unmatched.size,
  affectedProfiles: planned.length,
  removedProfiles: updated.length,
  unmatched: [...unmatched].sort(),
  planned,
  updated,
  errors,
};

await writeFile("remove-undeliverable-emails-report.json", JSON.stringify(output, null, 2), "utf8");
console.log(JSON.stringify({
  applied: output.applied,
  requested: output.requested,
  matchedEmails: output.matchedEmails,
  affectedProfiles: output.affectedProfiles,
  removedProfiles: output.removedProfiles,
  unmatched: output.unmatched,
  errors: output.errors.length,
  report: "remove-undeliverable-emails-report.json",
}, null, 2));
