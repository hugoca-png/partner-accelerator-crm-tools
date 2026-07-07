import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const root = process.cwd();
const baseReport = JSON.parse(await fs.readFile(path.join(root, "missing-contact-email-enrichment-report.json"), "utf8"));
const realtimePath = path.join(root, "missing-contact-email-enrichment-realtime-report.json");
const realtimeReport = JSON.parse(await fs.readFile(realtimePath, "utf8").catch(() => "null"));
const report = realtimeReport || baseReport;
const outputDir = path.join(root, "outputs");
const outputPath = path.join(outputDir, "missing-contact-email-enrichment.xlsx");

const summary = [
  ["Métrica", "Valor"],
  ["Contactos sem email", baseReport.contactsWithoutEmail],
  ["Candidatos por padrão interno", report.totalCandidates || baseReport.candidateCount],
  ["Candidatos validados no Bouncer", report.selectedCount],
  ["Créditos Bouncer antes", report.creditsBefore?.credits ?? ""],
  ["Créditos Bouncer depois", report.creditsAfter?.credits ?? ""],
  ["Deliverable", report.summary?.deliverable ?? 0],
  ["Risky", report.summary?.risky ?? 0],
  ["Undeliverable", report.summary?.undeliverable ?? 0],
  ["Validação inconclusiva/por validar", report.summary?.unknown ?? 0],
  ["Nota", realtimeReport ? "Validação realizada pelo endpoint real-time do Bouncer." : "Validação por validar ou inconclusiva."],
];

const headers = [
  "Empresa",
  "Pessoa",
  "Cargo",
  "Cidade",
  "País",
  "Email candidato",
  "Padrão",
  "Exemplos do padrão",
  "Domínio",
  "Confiança padrão",
  "Fonte",
  "Bouncer status",
  "Bouncer score",
  "Recomendação",
  "Exemplos CRM",
];

function rowValues(row) {
  return [
    row.organisation,
    row.person,
    row.job,
    row.city,
    row.country,
    row.candidateEmail,
    row.pattern,
    row.patternExamples,
    row.domain,
    row.confidence,
    row.source,
    row.bouncerStatus || "",
    row.bouncerScore ?? "",
    row.recommendation || "por validar",
    (row.examples || []).map((item) => `${item.person}: ${item.email}`).join(" | "),
  ];
}

const selectedRows = (report.rows || []).map(rowValues);
const allRows = realtimeReport
  ? (report.rows || []).map(rowValues)
  : (report.allCandidates || []).map((row) => rowValues({ ...row, recommendation: "por validar" }));

const workbook = Workbook.create();
workbook.worksheets.add("Resumo");
workbook.worksheets.add("Validados");
workbook.worksheets.add("Todos candidatos");

await workbook.apply([
  { op: "range.values.set", target: { sheet: "Resumo", range: "A1:B1" }, values: [["Enriquecimento de emails em falta", ""]] },
  { op: "range.merge", target: { sheet: "Resumo", range: "A1:B1" } },
  { op: "range.values.set", target: { sheet: "Resumo", range: `A3:B${summary.length + 2}` }, values: summary },
  { op: "range.values.set", target: { sheet: "Validados", range: "A1:O1" }, values: [headers] },
  { op: "range.values.set", target: { sheet: "Validados", range: `A2:O${selectedRows.length + 1}` }, values: selectedRows },
  { op: "range.values.set", target: { sheet: "Todos candidatos", range: "A1:O1" }, values: [headers] },
  { op: "range.values.set", target: { sheet: "Todos candidatos", range: `A2:O${allRows.length + 1}` }, values: allRows },
  { op: "table.add", props: { range: { sheet: "Validados", range: `A1:O${Math.max(selectedRows.length + 1, 2)}` }, hasHeaders: true, name: "EmailsTentadosBouncer" } },
  { op: "table.add", props: { range: { sheet: "Todos candidatos", range: `A1:O${Math.max(allRows.length + 1, 2)}` }, hasHeaders: true, name: "TodosEmailsCandidatos" } },
  { op: "range.format.set", target: { sheet: "Resumo", range: "A1:B1" }, props: { fill: "#1f4e78", font: { bold: true, color: "#ffffff", size: 16 } } },
  { op: "range.format.set", target: { sheet: "Resumo", range: `A3:A${summary.length + 2}` }, props: { fill: "#dbeafe", font: { bold: true } } },
  { op: "range.format.set", target: { sheet: "Validados", range: "A1:O1" }, props: { fill: "#1f4e78", font: { bold: true, color: "#ffffff" } } },
  { op: "range.format.set", target: { sheet: "Todos candidatos", range: "A1:O1" }, props: { fill: "#1f4e78", font: { bold: true, color: "#ffffff" } } },
  { op: "range.format.set", target: { sheet: "Validados", range: `A1:O${Math.max(selectedRows.length + 1, 2)}` }, props: { font: { name: "Aptos", size: 10 }, wrapText: true, verticalAlignment: "top" } },
  { op: "range.format.set", target: { sheet: "Todos candidatos", range: `A1:O${Math.max(allRows.length + 1, 2)}` }, props: { font: { name: "Aptos", size: 10 }, wrapText: true, verticalAlignment: "top" } },
]);

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 100 },
});

await fs.mkdir(outputDir, { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);

console.log(JSON.stringify({
  output: outputPath,
  selectedRows: selectedRows.length,
  allRows: allRows.length,
  formulaErrors: errors?.matches?.length || 0,
}, null, 2));
