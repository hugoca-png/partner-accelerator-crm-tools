import { readFile, writeFile } from "node:fs/promises";

const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN nao encontrado.");

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
const parties = [];
while (url) {
  const { data, link } = await capsuleFetch(url);
  parties.push(...(data.parties || []));
  url = nextLink(link);
}

const affected = [];
for (const party of parties) {
  const emails = (party.emailAddresses || []).map((entry, index) => ({
    id: String(entry.id),
    address: entry.address,
    type: entry.type || "",
    index,
  }));
  const firstWork = emails.findIndex((entry) => entry.type === "Work");
  const firstHome = emails.findIndex((entry) => entry.type === "Home");
  if (firstWork >= 0 && firstHome >= 0 && firstHome < firstWork) {
    affected.push({
      partyId: String(party.id),
      partyType: party.type,
      party: party.name || [party.firstName, party.lastName].filter(Boolean).join(" "),
      organisation: party.organisation?.name || "",
      emails,
    });
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  parties: parties.length,
  partiesWithEmails: parties.filter((party) => (party.emailAddresses || []).length).length,
  affectedProfiles: affected.length,
  affected,
};
await writeFile("email-order-audit-report.json", JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({
  parties: report.parties,
  partiesWithEmails: report.partiesWithEmails,
  affectedProfiles: report.affectedProfiles,
  report: "email-order-audit-report.json",
}, null, 2));
