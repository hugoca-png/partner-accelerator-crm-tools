import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const root = process.cwd();
const inputArg = process.argv[2] || "crm-enrichment-wave2-40.json";
const inputPath = path.resolve(root, inputArg);
const baseName = path.basename(inputPath, ".json");
const outputDir = path.join(root, "outputs");
const outputPath = path.join(outputDir, `${baseName}.xlsx`);

const payload = JSON.parse(await fs.readFile(inputPath, "utf8"));
const items = payload.items || [];

const workbook = Workbook.create();
const sheet = workbook.worksheets.add("Revisao");
sheet.showGridLines = false;

const headers = [
  "Empresa",
  "Descricao enriquecida proposta",
  "Proposito principal",
  "Score AI/LLM sugerido",
  "Confianca",
  "Fonte",
  "Notas",
  "Atualizar CRM?",
];

sheet.getRange("A1:H1").values = [headers];
sheet.getRangeByIndexes(1, 0, items.length, headers.length).values = items.map((item) => [
  item.name,
  item.description,
  item.purpose,
  item.aiPotentialScore,
  item.confidence,
  item.sourceUrl,
  item.notes,
  "",
]);
sheet.tables.add(`A1:H${items.length + 1}`, true, "EnrichmentReview").style = "TableStyleMedium2";
sheet.freezePanes.freezeRows(1);
sheet.getRange("A1:H1").format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF" } };
sheet.getRange(`A1:H${items.length + 1}`).format.wrapText = true;
sheet.getRange("A:A").format.columnWidthPx = 230;
sheet.getRange("B:B").format.columnWidthPx = 600;
sheet.getRange("C:C").format.columnWidthPx = 130;
sheet.getRange("D:D").format.columnWidthPx = 120;
sheet.getRange("E:E").format.columnWidthPx = 100;
sheet.getRange("F:F").format.columnWidthPx = 260;
sheet.getRange("G:G").format.columnWidthPx = 430;
sheet.getRange("H:H").format.columnWidthPx = 110;
sheet.getRange(`D2:D${items.length + 1}`).format.numberFormat = "0";
sheet.getRange(`D2:D${items.length + 1}`).conditionalFormats.add("colorScale", {
  criteria: [
    { type: "num", value: 1, color: "#FEE2E2" },
    { type: "num", value: 50, color: "#FEF3C7" },
    { type: "num", value: 100, color: "#DCFCE7" },
  ],
});
sheet.getRange(`H2:H${items.length + 1}`).dataValidation = {
  rule: { type: "list", values: ["Sim", "Nao", "Rever"] },
};

const summary = workbook.worksheets.add("Resumo");
summary.showGridLines = false;
const avg = items.reduce((sum, item) => sum + Number(item.aiPotentialScore || 0), 0) / Math.max(1, items.length);
const count = (field, value) => items.filter((item) => item[field] === value).length;
summary.getRange("A1:D1").values = [[payload.scope || "CRM enrichment wave", "", "", ""]];
summary.getRange("A1:D1").merge();
summary.getRange("A1").format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF", size: 16 } };
summary.getRange("A3:B12").values = [
  ["Empresas", items.length],
  ["Score medio sugerido", Number(avg.toFixed(1))],
  ["Confianca alta", count("confidence", "alta")],
  ["Confianca media", count("confidence", "media")],
  ["Confianca baixa", count("confidence", "baixa")],
  ["Produto", count("purpose", "Produto")],
  ["Servicos", count("purpose", "Servicos")],
  ["Outsourcing", count("purpose", "Outsourcing")],
  ["Criado em", payload.createdAt || ""],
  ["Ficheiro fonte", path.basename(inputPath)],
];
summary.getRange("A3:A12").format = { font: { bold: true }, fill: "#EAF2F8" };
summary.getRange("A3:B12").format.borders = { preset: "all", style: "thin", color: "#D5DEE8" };
summary.getRange("A:A").format.columnWidthPx = 220;
summary.getRange("B:B").format.columnWidthPx = 260;

const methodology = workbook.worksheets.add("Metodologia");
methodology.showGridLines = false;
methodology.getRange("A1:B1").values = [["Criterios", "Descricao"]];
methodology.getRange("A1:B1").format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF" } };
methodology.getRange("A2:B8").values = [
  ["Objetivo", "Melhorar descricoes insuficientes antes de qualquer atualizacao no Capsule CRM."],
  ["Fontes", "Website oficial, paginas publicas acessiveis, e fontes publicas secundarias quando o website bloqueia ou nao expoe texto."],
  ["Confianca alta", "Fonte oficial clara ou atividade publica muito verificavel."],
  ["Confianca media", "Fonte oficial parcial, bloqueio parcial, ou inferencia apoiada por sinais publicos fortes."],
  ["Confianca baixa", "Website pobre/bloqueado, empresa ambigua ou sem URL; deve ser revista manualmente."],
  ["Atualizar CRM?", "Marcar Sim, Nao ou Rever antes de qualquer escrita no CRM."],
  ["Regra operacional", "Apenas Confianca alta ou aprovacao explicita devem seguir para atualizacao automatica."],
];
methodology.getRange("A:B").format.wrapText = true;
methodology.getRange("A:A").format.columnWidthPx = 190;
methodology.getRange("B:B").format.columnWidthPx = 720;
methodology.getRange("A1:B8").format.borders = { preset: "all", style: "thin", color: "#D5DEE8" };

await fs.mkdir(outputDir, { recursive: true });
const preview = await workbook.render({ sheetName: "Resumo", autoCrop: "all", scale: 1, format: "png" });
await fs.writeFile(path.join(outputDir, `${baseName}-preview.png`), new Uint8Array(await preview.arrayBuffer()));
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(outputPath);
