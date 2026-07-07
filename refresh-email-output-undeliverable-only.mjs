import { readFile, writeFile } from "node:fs/promises";

const report = JSON.parse(await readFile("bouncer-email-validation-last.json", "utf8"));
const rows = (report.rows || []).filter((row) => row.bouncer?.status === "undeliverable");

const updated = {
  ...report,
  policy: "Email Risky e Email Catch-All são considerados OK. O output mantém apenas Email Undeliverable.",
  refreshedAgainstPolicyAt: new Date().toISOString(),
  previousRows: report.rows?.length || 0,
  rows,
};

await writeFile("bouncer-email-validation-last.json", JSON.stringify(updated, null, 2), "utf8");
console.log(JSON.stringify({
  output: "bouncer-email-validation-last.json",
  previousRows: updated.previousRows,
  currentRows: rows.length,
}, null, 2));
