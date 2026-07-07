import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const root = process.cwd();
const files = [
  "crm-enrichment-pilot-20.json",
  "crm-enrichment-wave2-40.json",
  "crm-enrichment-wave3-24.json",
];
const outputDir = path.join(root, "outputs");
const outputPath = path.join(outputDir, "crm-enrichment-consolidated-84.xlsx");

const waves = [];
for (const file of files) {
  const payload = JSON.parse(await fs.readFile(path.join(root, file), "utf8"));
  waves.push({ file, payload });
}

const items = waves.flatMap(({ file, payload }) =>
  (payload.items || []).map((item) => ({
    ...item,
    wave: file.includes("pilot") ? "Piloto 20" : file.includes("wave2") ? "Onda 2 - 40" : "Onda 3 - 24",
    sourceFile: file,
    lowConfidenceFlag: item.confidence === "baixa" ? "BAIXA CONFIANCA" : "",
    suggestedAction: item.confidence === "alta" ? "Candidato a atualizar" : item.confidence === "media" ? "Rever" : "Matching manual",
  })),
);

items.sort((a, b) => {
  const confidenceOrder = { baixa: 0, media: 1, alta: 2 };
  return (
    confidenceOrder[a.confidence] - confidenceOrder[b.confidence] ||
    String(a.name).localeCompare(String(b.name), "pt-PT")
  );
});

const workbook = Workbook.create();
const sheet = workbook.worksheets.add("Consolidado");
sheet.showGridLines = false;

const headers = [
  "Empresa",
  "Descricao enriquecida proposta",
  "Proposito principal",
  "Score AI/LLM sugerido",
  "Confianca",
  "Flag",
  "Acao sugerida",
  "Fonte",
  "Notas",
  "Onda",
  "Atualizar CRM?",
];

sheet.getRange("A1:K1").values = [headers];
sheet.getRangeByIndexes(1, 0, items.length, headers.length).values = items.map((item) => [
  item.name,
  item.description,
  item.purpose,
  item.aiPotentialScore,
  item.confidence,
  item.lowConfidenceFlag,
  item.suggestedAction,
  item.sourceUrl,
  item.notes,
  item.wave,
  "",
]);

sheet.tables.add(`A1:K${items.length + 1}`, true, "ConsolidatedEnrichment").style = "TableStyleMedium2";
sheet.freezePanes.freezeRows(1);
sheet.getRange("A1:K1").format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF" } };
sheet.getRange(`A1:K${items.length + 1}`).format.wrapText = true;
sheet.getRange("A:A").format.columnWidthPx = 230;
sheet.getRange("B:B").format.columnWidthPx = 620;
sheet.getRange("C:C").format.columnWidthPx = 130;
sheet.getRange("D:D").format.columnWidthPx = 120;
sheet.getRange("E:E").format.columnWidthPx = 100;
sheet.getRange("F:F").format.columnWidthPx = 150;
sheet.getRange("G:G").format.columnWidthPx = 150;
sheet.getRange("H:H").format.columnWidthPx = 260;
sheet.getRange("I:I").format.columnWidthPx = 430;
sheet.getRange("J:J").format.columnWidthPx = 120;
sheet.getRange("K:K").format.columnWidthPx = 110;
sheet.getRange(`D2:D${items.length + 1}`).format.numberFormat = "0";
sheet.getRange(`D2:D${items.length + 1}`).conditionalFormats.add("colorScale", {
  criteria: [
    { type: "num", value: 1, color: "#FEE2E2" },
    { type: "num", value: 50, color: "#FEF3C7" },
    { type: "num", value: 100, color: "#DCFCE7" },
  ],
});
sheet.getRange(`F2:F${items.length + 1}`).conditionalFormats.add("containsText", {
  text: "BAIXA CONFIANCA",
  format: {
    fill: "#DC2626",
    font: { bold: true, color: "#FFFFFF" },
  },
});
sheet.getRange(`E2:E${items.length + 1}`).conditionalFormats.add("containsText", {
  text: "baixa",
  format: { fill: "#FEE2E2", font: { bold: true, color: "#991B1B" } },
});
sheet.getRange(`K2:K${items.length + 1}`).dataValidation = {
  rule: { type: "list", values: ["Sim", "Nao", "Rever"] },
};

const summary = workbook.worksheets.add("Resumo");
summary.showGridLines = false;
const avg = items.reduce((sum, item) => sum + Number(item.aiPotentialScore || 0), 0) / Math.max(1, items.length);
const count = (field, value) => items.filter((item) => item[field] === value).length;
summary.getRange("A1:D1").values = [["Consolidado de enriquecimento CRM", "", "", ""]];
summary.getRange("A1:D1").merge();
summary.getRange("A1").format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF", size: 16 } };
summary.getRange("A3:B16").values = [
  ["Empresas", items.length],
  ["Score medio sugerido", Number(avg.toFixed(1))],
  ["Confianca alta", count("confidence", "alta")],
  ["Confianca media", count("confidence", "media")],
  ["Confianca baixa", count("confidence", "baixa")],
  ["Produto", count("purpose", "Produto")],
  ["Servicos", count("purpose", "Servicos")],
  ["Outsourcing", count("purpose", "Outsourcing")],
  ["Piloto 20", count("wave", "Piloto 20")],
  ["Onda 2 - 40", count("wave", "Onda 2 - 40")],
  ["Onda 3 - 24", count("wave", "Onda 3 - 24")],
  ["Candidatos a atualizar", count("suggestedAction", "Candidato a atualizar")],
  ["A rever", count("suggestedAction", "Rever")],
  ["Matching manual", count("suggestedAction", "Matching manual")],
];
summary.getRange("A3:A16").format = { font: { bold: true }, fill: "#EAF2F8" };
summary.getRange("A3:B16").format.borders = { preset: "all", style: "thin", color: "#D5DEE8" };
summary.getRange("A:A").format.columnWidthPx = 230;
summary.getRange("B:B").format.columnWidthPx = 220;

summary.getRange("D3:E6").values = [
  ["Confianca", "Empresas"],
  ["alta", count("confidence", "alta")],
  ["media", count("confidence", "media")],
  ["baixa", count("confidence", "baixa")],
];
summary.getRange("D3:E3").format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF" } };
const chart = summary.charts.add("bar", summary.getRange("D3:E6"));
chart.title = "Distribuicao por confianca";
chart.hasLegend = false;
chart.setPosition("D8", "J24");

const methodology = workbook.worksheets.add("Metodologia");
methodology.showGridLines = false;
methodology.getRange("A1:B1").values = [["Criterios", "Descricao"]];
methodology.getRange("A1:B1").format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF" } };
methodology.getRange("A2:B8").values = [
  ["Objetivo", "Consolidar as 84 empresas com descricoes fracas em uma lista unica para revisao antes de atualizar o Capsule CRM."],
  ["Baixa confianca", "Assinalada com flag vermelha BAIXA CONFIANCA. Deve passar por matching/revisao manual."],
  ["Media confianca", "Boa candidata a revisao humana; nao atualizar automaticamente sem confirmacao."],
  ["Alta confianca", "Candidata a atualizacao no CRM se a descricao estiver alinhada com o criterio editorial."],
  ["Atualizar CRM?", "Preencher Sim, Nao ou Rever. Apenas Sim deve ser usado por scripts futuros de escrita no Capsule."],
  ["Fontes", "Website oficial, paginas publicas e fontes secundarias quando a fonte oficial bloqueou ou era insuficiente."],
  ["Seguranca operacional", "Nenhuma informacao foi escrita no CRM por este processo."],
];
methodology.getRange("A:B").format.wrapText = true;
methodology.getRange("A:A").format.columnWidthPx = 190;
methodology.getRange("B:B").format.columnWidthPx = 760;
methodology.getRange("A1:B8").format.borders = { preset: "all", style: "thin", color: "#D5DEE8" };

await fs.mkdir(outputDir, { recursive: true });
const preview = await workbook.render({ sheetName: "Resumo", autoCrop: "all", scale: 1, format: "png" });
await fs.writeFile(path.join(outputDir, "crm-enrichment-consolidated-84-preview.png"), new Uint8Array(await preview.arrayBuffer()));
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(outputPath);
