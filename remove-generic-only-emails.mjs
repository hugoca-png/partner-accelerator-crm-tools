import { readFile, writeFile } from "node:fs/promises";

const targets = [
  { name: "Rui Serapicos", org: "Acumen Research Labs", emails: ["serapicos@gmail.com"] },
  { name: "Filipe Dias", org: "AdvanceWorks", emails: ["filipedias87@gmail.com"] },
  { name: "James Andrade", org: "AdvanceWorks", emails: ["edcleysonjames1@gmail.com"] },
  { name: "Joao Abrantes", org: "Alpaca Law", emails: ["jpiabrantes@gmail.com"] },
  { name: "Pedro da Rocha Pinto", org: "Anoto", emails: ["pedromdrp@msn.com"] },
  { name: "Andre Goncalves", org: "Bloq.it", emails: ["fortyeightkb@gmail.com"] },
  { name: "Andre Albuquerque", org: "Builders Camp", emails: ["albuquerque.a.andre@gmail.com"] },
  { name: "David Domingos", org: "C.Inov", emails: ["domingosdavid@gmail.com"] },
  { name: "Henrique Parente", org: "Card4B - Systems S.A.", emails: ["henrique.parente@gmail.com"] },
  { name: "Filipe Coutinho", org: "COCUS", emails: ["filipemiguelrato@hotmail.com"] },
  { name: "Rui Borges", org: "CyberInspect", emails: ["ruipedro.97@hotmail.com"] },
  { name: "Samuel Silva", org: "EasyEdge", emails: ["ssilva1@gmail.com"] },
  { name: "Nuno Silva", org: "EVOWARE", emails: ["nunoantunesdasilva@gmail.com"] },
  { name: "Rui Santos", org: "Fluid HR", emails: ["rui.santos96@gmail.com"] },
  { name: "Nuno Ferreira", org: "Grupo Três60", emails: ["njmf_007@hotmail.com"] },
  { name: "Ricardo Larrotta Prieto", org: "Indra Group", emails: ["ricardolarrotta@gmail.com"] },
  { name: "Vasco Almeida", org: "Indra Group", emails: ["vasco.malmeida@sapo.pt"] },
  { name: "Teresa Silveira", org: "Microsoft", emails: ["ana_zawerthal@hotmail.com", "teresa.zawerthal.mendonca@outlook.pt"] },
  { name: "Patricia Ribeiro", org: "Mobilize", emails: ["patricia.samira.ribeiro@gmail.com"] },
  { name: "Mario Amaral", org: "New Anderthal", emails: ["m_amaralpt@yahoo.com"] },
  { name: "Paulo Costa", org: "Porto Executive Academy", emails: ["pcosta71@gmail.com"] },
  { name: "Jorge Ferreira", org: "QART.PT", emails: ["seixas.ferreira@gmail.com"] },
  { name: "Ruben Severino", org: "Six-Factor", emails: ["rubenfranciscos@gmail.com"] },
  { name: "Mário Bessa", org: "Skrey", emails: ["mario.bessa@gmail.com"] },
  { name: "Rui Vas", org: "Techstars", emails: ["rui.vasconcelos.mail@gmail.com"] },
  { name: "Tiago Ribeiro", org: "Ten Twenty One", emails: ["tiago.lopes.silva.ribeiro@gmail.com"] },
  { name: "Rui Francisco", org: "The Sustainability Network", emails: ["blackmolly@gmail.com"] },
  { name: "Marcia Santos", org: "Universidade Lusófona - Centro Universitário Lisboa", emails: ["marcia_rafaela_10@hotmail.com"] },
];

const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN não encontrado.");

function clean(value) {
  return String(value || "").trim();
}

function normalize(value) {
  return clean(value)
    .toLocaleLowerCase("pt-PT")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}@.]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fullName(party) {
  return [party.title, party.firstName, party.lastName].map(clean).filter(Boolean).join(" ") || clean(party.name);
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
  if (!response.ok) throw new Error(`Capsule ${response.status}: ${text || response.statusText}`);
  return {
    data: text ? JSON.parse(text) : null,
    link: response.headers.get("link") || "",
  };
}

function nextLink(linkHeader) {
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/i);
  return match ? match[1] : null;
}

async function fetchAllPeople() {
  let url = "/parties?perPage=100&embed=organisation";
  const people = [];
  while (url) {
    const { data, link } = await capsuleFetch(url);
    people.push(...(data.parties || []).filter((party) => party.type === "person"));
    url = nextLink(link);
  }
  return people;
}

const people = await fetchAllPeople();
const removed = [];
const notFound = [];
const errors = [];

for (const target of targets) {
  const wantedName = normalize(target.name);
  const wantedOrg = normalize(target.org);
  const wantedEmails = new Set(target.emails.map((email) => normalize(email)));
  const matches = people.filter((person) =>
    normalize(fullName(person)) === wantedName &&
    normalize(person.organisation?.name) === wantedOrg
  );

  if (!matches.length) {
    notFound.push({ ...target, reason: "Pessoa/empresa não encontrada" });
    continue;
  }

  for (const person of matches) {
    const emailEntries = (person.emailAddresses || []).filter((entry) => wantedEmails.has(normalize(entry.address)));
    if (!emailEntries.length) {
      notFound.push({ ...target, partyId: person.id, reason: "Endereço já não existe no perfil" });
      continue;
    }

    try {
      await capsuleFetch(`/parties/${person.id}`, {
        method: "PUT",
        body: JSON.stringify({
          party: {
            emailAddresses: emailEntries.map((entry) => ({ id: entry.id, _delete: true })),
          },
        }),
      });
      for (const entry of emailEntries) {
        removed.push({
          partyId: String(person.id),
          name: fullName(person),
          organisation: person.organisation?.name || "",
          email: entry.address,
        });
      }
    } catch (error) {
      errors.push({
        partyId: String(person.id),
        name: fullName(person),
        organisation: person.organisation?.name || "",
        emails: emailEntries.map((entry) => entry.address),
        error: error.message || String(error),
      });
    }
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  criteria: "Remover emails genéricos/pessoais em contactos sem email da empresa atual, excluindo Fátima Caçador.",
  removedCount: removed.length,
  affectedPeople: new Set(removed.map((item) => item.partyId)).size,
  notFoundCount: notFound.length,
  errorCount: errors.length,
  removed,
  notFound,
  errors,
};

await writeFile("remove-generic-only-emails-report.json", JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({
  removedCount: report.removedCount,
  affectedPeople: report.affectedPeople,
  notFoundCount: report.notFoundCount,
  errorCount: report.errorCount,
  report: "remove-generic-only-emails-report.json",
}, null, 2));
