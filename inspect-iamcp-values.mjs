import { readFile } from "node:fs/promises";

const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN não encontrado.");

async function capsuleFetch(path) {
  const response = await fetch(`https://api.capsulecrm.com/api/v2${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return response.json();
}

const mode = process.argv.includes("--definitions") ? "definitions" : "used-values";

function nextLink(linkHeader) {
  const match = linkHeader?.match(/<([^>]+)>;\s*rel="next"/i);
  return match ? match[1] : null;
}

async function capsuleFetchWithHeaders(path) {
  const url = path.startsWith("http") ? path : `https://api.capsulecrm.com/api/v2${path}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return {
    data: await response.json(),
    link: response.headers.get("link"),
  };
}

if (mode === "definitions") {
  let definitionsUrl = "/parties/fields/definitions?perPage=100";
  const definitions = [];
  while (definitionsUrl) {
    const { data, link } = await capsuleFetchWithHeaders(definitionsUrl);
    definitions.push(...(data.definitions || []));
    definitionsUrl = nextLink(link);
  }
  const iamcpDefinitions = definitions.filter((definition) =>
    (definition.tag?.name || "").toLocaleLowerCase("pt-PT") === "iamcp",
  );
  console.log(JSON.stringify(iamcpDefinitions, null, 2));
  process.exit(0);
}

let url = "/parties?perPage=100&embed=fields,tags,organisation";
const values = new Map();
while (url) {
  const { data, link } = await capsuleFetchWithHeaders(url);
  for (const party of data.parties || []) {
    for (const field of party.fields || []) {
      const tagName = field.definition?.tag?.name || field.tag?.name || "";
      if (tagName.toLocaleLowerCase("pt-PT") !== "iamcp") continue;
      const fieldName = field.definition?.name || field.name || "(sem nome do campo)";
      const value = field.value ?? field.text ?? field.date ?? field.number ?? field.boolean ?? field.option ?? "";
      const key = `${fieldName}||${String(value)}`;
      if (!values.has(key)) {
        values.set(key, {
          field: fieldName,
          value,
          count: 0,
          examples: [],
        });
      }
      const entry = values.get(key);
      entry.count += 1;
      if (entry.examples.length < 5) {
        entry.examples.push({
          party: party.name || [party.firstName, party.lastName].filter(Boolean).join(" "),
          type: party.type,
        });
      }
    }
  }
  url = nextLink(link);
}

const output = [...values.values()].sort((a, b) =>
  String(a.field).localeCompare(String(b.field), "pt-PT") ||
  String(a.value).localeCompare(String(b.value), "pt-PT"),
);
console.log(JSON.stringify(output, null, 2));
