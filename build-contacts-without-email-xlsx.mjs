import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const root = process.cwd();
const cache = JSON.parse(await fs.readFile(path.join(root, "capsule-cache.json"), "utf8"));
const outputDir = path.join(root, "outputs");
const outputPath = path.join(outputDir, "contacts-without-email.xlsx");

const rows = [];
for (const org of cache.organisations || []) {
  for (const person of org.contacts || []) {
    if ((person.emails || []).length) continue;
    rows.push({
      empresa: org.name || "",
      pessoa: person.name || "",
      cargo: (person.jobTitles || []).join("; "),
      cidade: org.city || "",
      pais: org.country || "",
      website: org.url || "",
      dominios: (org.domains || []).join("; "),
      tagsEmpresa: [...(org.tags || []), ...(org.dataTags || [])].join("; "),
      tagsPessoa: [...(person.tags || []), ...(person.dataTags || [])].join("; "),
      notas: "",
      emailValidado: "",
    });
  }
}

rows.sort((a, b) => a.empresa.localeCompare(b.empresa, "pt-PT") || a.pessoa.localeCompare(b.pessoa, "pt-PT"));

const summary = [
  ["Métrica", "Valor"],
  ["Empresas", cache.organisationCount || (cache.organisations || []).length],
  ["Pessoas", cache.personCount || ""],
  ["Contactos sem email", rows.length],
  ["Empresas sem contacto", (cache.dataQuality?.organisationsWithoutContacts || []).length],
  ["Cache CRM", cache.refreshedAt || ""],
  ["Gerado em", new Date().toISOString()],
];

const headers = [
  "Empresa",
  "Pessoa",
  "Cargo",
  "Cidade",
  "País",
  "Website",
  "Domínios",
  "Tags empresa",
  "Tags pessoa",
  "Email validado",
  "Notas validação",
];

const values = rows.map((row) => [
  row.empresa,
  row.pessoa,
  row.cargo,
  row.cidade,
  row.pais,
  row.website,
  row.dominios,
  row.tagsEmpresa,
  row.tagsPessoa,
  row.emailValidado,
  row.notas,
]);

const workbook = Workbook.create();
workbook.worksheets.add("Resumo");
workbook.worksheets.add("Contactos sem email");

await workbook.apply([
  { op: "range.values.set", target: { sheet: "Resumo", range: "A1:B1" }, values: [["Contactos sem email", ""]] },
  { op: "range.merge", target: { sheet: "Resumo", range: "A1:B1" } },
  { op: "range.values.set", target: { sheet: "Resumo", range: `A3:B${summary.length + 2}` }, values: summary },
  { op: "range.values.set", target: { sheet: "Contactos sem email", range: "A1:K1" }, values: [headers] },
  { op: "range.values.set", target: { sheet: "Contactos sem email", range: `A2:K${values.length + 1}` }, values },
  { op: "table.add", props: { range: { sheet: "Contactos sem email", range: `A1:K${Math.max(values.length + 1, 2)}` }, hasHeaders: true, name: "ContactosSemEmail" } },
  { op: "range.format.set", target: { sheet: "Resumo", range: "A1:B1" }, props: { fill: "#1f4e78", font: { bold: true, color: "#ffffff", size: 16 } } },
  { op: "range.format.set", target: { sheet: "Resumo", range: `A3:A${summary.length + 2}` }, props: { fill: "#dbeafe", font: { bold: true } } },
  { op: "range.format.set", target: { sheet: "Contactos sem email", range: "A1:K1" }, props: { fill: "#1f4e78", font: { bold: true, color: "#ffffff" } } },
  { op: "range.format.set", target: { sheet: "Contactos sem email", range: `A1:K${Math.max(values.length + 1, 2)}` }, props: { font: { name: "Aptos", size: 10 }, wrapText: true, verticalAlignment: "top" } },
]);

const inspect = await workbook.inspect({
  kind: "table",
  range: "Resumo!A1:B10",
  include: "values",
  tableMaxRows: 10,
  tableMaxCols: 2,
});
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
  rows: rows.length,
  inspected: Boolean(inspect?.ndjson),
  formulaErrors: errors?.matches?.length || 0,
}, null, 2));
