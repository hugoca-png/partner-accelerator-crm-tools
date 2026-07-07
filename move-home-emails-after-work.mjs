import { readFile, writeFile } from "node:fs/promises";

const APPLY = process.argv.includes("--apply");
const ONLY_ID = process.argv.find((arg) => arg.startsWith("--party="))?.split("=")[1] || "";

const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN nao encontrado.");

function clean(value) {
  return String(value || "").trim();
}

function nextLink(linkHeader) {
  return clean(linkHeader).replace(/&amp;/g, "&").match(/<([^>]+)>;\s*rel="next"/i)?.[1] || "";
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

async function fetchParties() {
  if (ONLY_ID) return [(await capsuleFetch(`/parties/${ONLY_ID}?embed=organisation`)).data.party];
  let url = "/parties?perPage=100&embed=organisation";
  const parties = [];
  while (url) {
    const { data, link } = await capsuleFetch(url);
    parties.push(...(data.parties || []));
    url = nextLink(link);
  }
  return parties;
}

function snapshot(party) {
  return (party.emailAddresses || []).map((entry) => ({
    id: Number(entry.id),
    address: entry.address,
    type: entry.type || "",
  }));
}

function homesBeforeWork(emails) {
  const firstWork = emails.findIndex((entry) => entry.type === "Work");
  if (firstWork < 0) return [];
  return emails.slice(0, firstWork).filter((entry) => entry.type === "Home");
}

const parties = await fetchParties();
const planned = parties
  .map((party) => ({ party, emails: snapshot(party) }))
  .map(({ party, emails }) => ({ party, emails, move: homesBeforeWork(emails) }))
  .filter((item) => item.move.length);

const report = {
  generatedAt: new Date().toISOString(),
  applied: APPLY,
  plannedProfiles: planned.length,
  plannedHomeEmails: planned.reduce((sum, item) => sum + item.move.length, 0),
  updated: [],
  errors: [],
};

for (const item of planned) {
  const partyId = String(item.party.id);
  const name = item.party.name || [item.party.firstName, item.party.lastName].filter(Boolean).join(" ");
  if (!APPLY) {
    report.updated.push({
      partyId,
      party: name,
      organisation: item.party.organisation?.name || "",
      before: item.emails,
      move: item.move,
      mode: "planned",
    });
    continue;
  }

  try {
    await capsuleFetch(`/parties/${partyId}`, {
      method: "PUT",
      body: JSON.stringify({
        party: {
          emailAddresses: item.move.map((entry) => ({ id: entry.id, _delete: true })),
        },
      }),
    });

    await capsuleFetch(`/parties/${partyId}`, {
      method: "PUT",
      body: JSON.stringify({
        party: {
          emailAddresses: item.move.map((entry) => ({
            address: entry.address,
            type: "Home",
          })),
        },
      }),
    });

    const afterParty = (await capsuleFetch(`/parties/${partyId}`)).data.party;
    const after = snapshot(afterParty);
    const stillWrong = homesBeforeWork(after);
    report.updated.push({
      partyId,
      party: name,
      organisation: item.party.organisation?.name || "",
      before: item.emails,
      moved: item.move,
      after,
      orderConfirmed: stillWrong.length === 0,
      mode: "updated",
    });
  } catch (error) {
    report.errors.push({
      partyId,
      party: name,
      move: item.move,
      error: error.message || String(error),
      recovery: "Os emails Home a recriar constam no campo move deste erro.",
    });
  }
}

report.updatedProfiles = report.updated.filter((item) => item.mode === "updated").length;
report.confirmedProfiles = report.updated.filter((item) => item.orderConfirmed).length;
report.errorCount = report.errors.length;
await writeFile("email-order-update-report.json", JSON.stringify(report, null, 2), "utf8");

console.log(JSON.stringify({
  applied: report.applied,
  plannedProfiles: report.plannedProfiles,
  plannedHomeEmails: report.plannedHomeEmails,
  updatedProfiles: report.updatedProfiles,
  confirmedProfiles: report.confirmedProfiles,
  errors: report.errorCount,
  report: "email-order-update-report.json",
}, null, 2));
