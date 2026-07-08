import { readFile, writeFile } from "node:fs/promises";

const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN nao encontrado.");

const replacements = new Map([
  ["Aragao", "Aragão"],
  ["Armenio", "Arménio"],
  ["Vania", "Vânia"],
  ["Aderito", "Adérito"],
  ["Americo", "Américo"],
  ["Andre", "André"],
  ["Antonio", "António"],
  ["Araujo", "Araújo"],
  ["Bailao", "Bailão"],
  ["Bras", "Brás"],
  ["Calo", "Caló"],
  ["Catia", "Cátia"],
  ["Charreu", "Charréu"],
  ["Claudia", "Cláudia"],
  ["Custodio", "Custódio"],
  ["Felix", "Félix"],
  ["Frazao", "Frazão"],
  ["Gloria", "Glória"],
  ["Goncalo", "Gonçalo"],
  ["Goncalves", "Gonçalves"],
  ["Graca", "Graça"],
  ["Helder", "Hélder"],
  ["Helio", "Hélio"],
  ["Hilario", "Hilário"],
  ["Inacio", "Inácio"],
  ["Ines", "Inês"],
  ["Joao", "João"],
  ["Jose", "José"],
  ["Licinio", "Licínio"],
  ["Lidia", "Lídia"],
  ["Luis", "Luís"],
  ["Magalhaes", "Magalhães"],
  ["Mario", "Mário"],
  ["Mertola", "Mértola"],
  ["Nidia", "Nídia"],
  ["Osorio", "Osório"],
  ["Perdigao", "Perdigão"],
  ["Pincao", "Pinção"],
  ["Quiterio", "Quitério"],
  ["Ruben", "Rúben"],
  ["Sergio", "Sérgio"],
  ["Setubal", "Setúbal"],
  ["Silverio", "Silvério"],
  ["Simoes", "Simões"],
  ["Sonia", "Sónia"],
  ["Tania", "Tânia"],
  ["Tomas", "Tomás"],
  ["Vitor", "Vítor"],
]);

const ambiguous = new Map([
  ["Braz", ["Brás", "Bráz"]],
  ["Victor", ["Víctor", "Vítor"]],
]);

function clean(value) {
  return String(value || "").trim();
}

function nextLink(linkHeader) {
  return clean(linkHeader).replace(/&amp;/g, "&").match(/<([^>]+)>;\s*rel="next"/i)?.[1] || "";
}

async function capsuleFetch(path) {
  const url = path.startsWith("http") ? path : `https://api.capsulecrm.com/api/v2${path}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Capsule ${response.status}: ${text}`);
  return { data: text ? JSON.parse(text) : null, link: response.headers.get("link") || "" };
}

let url = "/parties?perPage=100&embed=organisation";
const people = [];
while (url) {
  const { data, link } = await capsuleFetch(url);
  people.push(...(data.parties || []).filter((party) => party.type === "person"));
  url = nextLink(link);
}

function correctedValue(value) {
  return clean(value)
    .split(/(\s+|-|')/)
    .map((part) => replacements.get(part) || part)
    .join("");
}

function matchedTokens(value, dictionary) {
  const tokens = clean(value).split(/[\s\-']+/).filter(Boolean);
  return tokens.filter((token) => dictionary.has(token));
}

const automatic = [];
const review = [];
for (const person of people) {
  const firstMatches = matchedTokens(person.firstName, replacements);
  const lastMatches = matchedTokens(person.lastName, replacements);
  const firstAmbiguous = matchedTokens(person.firstName, ambiguous);
  const lastAmbiguous = matchedTokens(person.lastName, ambiguous);

  if (firstMatches.length || lastMatches.length) {
    automatic.push({
      id: String(person.id),
      organisation: person.organisation?.name || "",
      before: {
        firstName: clean(person.firstName),
        lastName: clean(person.lastName),
      },
      after: {
        firstName: correctedValue(person.firstName),
        lastName: correctedValue(person.lastName),
      },
      replacements: [...firstMatches, ...lastMatches].map((token) => `${token} -> ${replacements.get(token)}`),
    });
  }

  if (firstAmbiguous.length || lastAmbiguous.length) {
    review.push({
      id: String(person.id),
      organisation: person.organisation?.name || "",
      firstName: clean(person.firstName),
      lastName: clean(person.lastName),
      ambiguous: [...firstAmbiguous, ...lastAmbiguous].map((token) => ({
        token,
        options: ambiguous.get(token),
      })),
    });
  }
}

automatic.sort((a, b) =>
  a.organisation.localeCompare(b.organisation, "pt-PT") ||
  `${a.before.firstName} ${a.before.lastName}`.localeCompare(`${b.before.firstName} ${b.before.lastName}`, "pt-PT"));
review.sort((a, b) =>
  a.organisation.localeCompare(b.organisation, "pt-PT") ||
  `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`, "pt-PT"));

const report = {
  generatedAt: new Date().toISOString(),
  people: people.length,
  automaticCount: automatic.length,
  reviewCount: review.length,
  automatic,
  review,
};
await writeFile("name-accent-audit-report.json", JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({
  people: report.people,
  automaticCount: report.automaticCount,
  reviewCount: report.reviewCount,
  report: "name-accent-audit-report.json",
}, null, 2));
