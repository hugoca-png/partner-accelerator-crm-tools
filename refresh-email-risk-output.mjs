import { readFile, writeFile } from "node:fs/promises";

const report = JSON.parse(await readFile("bouncer-email-validation-last.json", "utf8"));
const cache = JSON.parse(await readFile("capsule-cache.json", "utf8"));

const currentEmails = new Set();
for (const org of cache.organisations || []) {
  for (const person of org.contacts || []) {
    for (const email of person.emails || []) {
      currentEmails.add(String(email).toLocaleLowerCase("pt-PT"));
    }
  }
}

const before = report.rows || [];
const rows = before.filter((row) => currentEmails.has(String(row.email).toLocaleLowerCase("pt-PT")));
const removed = before
  .filter((row) => !currentEmails.has(String(row.email).toLocaleLowerCase("pt-PT")))
  .map((row) => ({
    email: row.email,
    name: row.name,
    organisation: row.organisation,
    status: row.bouncer?.status || "",
  }));

const updated = {
  ...report,
  refreshedAgainstCacheAt: new Date().toISOString(),
  previousRows: before.length,
  removedRows: removed.length,
  rows,
  removed,
};

await writeFile("bouncer-email-validation-last.json", JSON.stringify(updated, null, 2), "utf8");

console.log(JSON.stringify({
  output: "bouncer-email-validation-last.json",
  previousRows: before.length,
  currentRows: rows.length,
  removedRows: removed.length,
  removedUndeliverable: removed.filter((row) => row.status === "undeliverable").length,
}, null, 2));
