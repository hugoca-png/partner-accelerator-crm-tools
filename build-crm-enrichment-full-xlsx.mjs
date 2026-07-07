import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const root = process.cwd();
const cachePath = path.join(root, "capsule-cache.json");
const externalPath = path.join(root, "external-descriptions.json");
const waveFiles = [
  "crm-enrichment-pilot-20.json",
  "crm-enrichment-wave2-40.json",
  "crm-enrichment-wave3-24.json",
];
const outputDir = path.join(root, "outputs");
const outputPath = path.join(outputDir, "crm-enrichment-full-partners.xlsx");

const cache = JSON.parse(await fs.readFile(cachePath, "utf8"));
const organisations = cache.organisations || [];
const externalPayload = JSON.parse(await fs.readFile(externalPath, "utf8"));
const externalById = new Map((externalPayload.results || []).map((item) => [String(item.id), item]));
const reviewByName = new Map();

for (const file of waveFiles) {
  const payload = JSON.parse(await fs.readFile(path.join(root, file), "utf8"));
  const wave = file.includes("pilot") ? "Piloto 20" : file.includes("wave2") ? "Onda 2 - 40" : "Onda 3 - 24";
  for (const item of payload.items || []) {
    reviewByName.set(normalizeName(item.name), { ...item, wave, sourceFile: file });
  }
}

const scoringSignals = [
  { re: /\b(llm|large language model|genai|generative ai|agentic|copilot|prompt|rag|foundation model)\b/i, points: 28, label: "LLM/GenAI" },
  { re: /\b(ai|artificial intelligence|inteligencia artificial|machine learning|deep learning|computer vision|nlp|chatbot|virtual assistant|intelligent automation)\b/i, points: 22, label: "AI/ML" },
  { re: /\b(data science|data platform|data engineering|big data|analytics|analitica|business intelligence|\bbi\b|power bi|predictive|forecast|modelos|synthetic data|data quality|data governance)\b/i, points: 18, label: "Data/Analytics" },
  { re: /\b(automation|automacao|workflow|process mining|rpa|low-code|low code|no-code|digitalization|digitalizacao)\b/i, points: 12, label: "Automation/Digitalization" },
  { re: /\b(azure|microsoft|power platform|dynamics|teams|sharepoint|m365|office 365|fabric|synapse|iamcp)\b/i, points: 10, label: "Microsoft ecosystem" },
  { re: /\b(cloud|infrastructure|infraestrutura|devops|kubernetes|managed services|platform|saas|software product|product development|api|integration|systems|sistemas)\b/i, points: 10, label: "Cloud/Software/Product" },
  { re: /\b(security|cyber|ciber|cybersecurity|compliance|identity|risk|fraud|aml|privacy|governance)\b/i, points: 8, label: "Security/Risk" },
  { re: /\b(health|finance|banking|insurance|retail|logistics|industry|industrial|energy|public sector|enterprise|b2b)\b/i, points: 5, label: "Enterprise/domain fit" },
  { re: /\b(consult|business solutions|solucoes|technology|tecnologia|innovation|inovacao|digital transformation|transformacao digital)\b/i, points: 5, label: "Technology services" },
];

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeName(value) {
  return clean(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function sourceText(org, description = "") {
  return [
    description,
    org.name,
    org.url,
    org.city,
    org.country,
    ...(org.tags || []),
    ...(org.dataTags || []),
    ...(org.filterTags || []),
    ...(org.filterDataTags || []),
    ...(org.domains || []),
    ...(org.contacts || []).flatMap((contact) => [
      contact.name,
      ...(contact.jobTitles || []),
      ...(contact.tags || []),
      ...(contact.dataTags || []),
    ]),
  ].join(" ");
}

function fallbackDescription(org, matched) {
  const text = sourceText(org);
  const parts = [];
  if (/\b(ai|artificial intelligence|inteligencia artificial|llm|machine learning|computer vision|nlp|agentic|chatbot)\b/i.test(text)) {
    parts.push("solucoes de inteligencia artificial, automacao inteligente e modelos avancados");
  }
  if (/\b(data|dados|analytics|analitica|business intelligence|\bbi\b|big data|data science|predictive)\b/i.test(text)) {
    parts.push("dados, analytics e business intelligence");
  }
  if (/\b(cloud|azure|microsoft|m365|office 365|dynamics|power platform|sharepoint|teams)\b/i.test(text)) {
    parts.push("cloud e ecossistema Microsoft");
  }
  if (/\b(security|cyber|ciber|risk|compliance)\b/i.test(text)) {
    parts.push("ciberseguranca, risco e compliance");
  }
  if (/\b(infra|infrastructure|infraestrutura|network|rede|devops|managed services)\b/i.test(text)) {
    parts.push("infraestrutura, redes e servicos geridos");
  }
  if (/\b(software|sistemas|systems|development|desenvolvimento|app|digital)\b/i.test(text)) {
    parts.push("desenvolvimento de software e transformacao digital");
  }
  if (!parts.length && /\b(consult|business|solucoes|tecnologia|technology)\b/i.test(text)) {
    parts.push("consultoria tecnologica e solucoes empresariais");
  }
  const activity = parts.length ? unique(parts).join("; ") : "atividade nao suficientemente descrita no CRM; requer enriquecimento externo";
  const note = matched.length ? `Sinais usados: ${matched.join(", ")}.` : "Sem sinais tecnologicos fortes no CRM.";
  return `${clean(org.name)}: ${activity}. ${note}`;
}

function purposeFor(org, description) {
  const text = sourceText(org, description);
  const productSignals = [
    /\b(product|produto|platform|plataforma|saas|software as a service|app|application|tool|ferramenta|marketplace|scanner|sensor|device|hardware|license|licenca|subscription|subscricao)\b/i,
    /\b(our platform|nossa plataforma|our product|o nosso produto|software para|software de)\b/i,
  ].filter((re) => re.test(text)).length;
  const outsourcingSignals = [
    /\b(outsourcing|nearshore|staff augmentation|managed team|dedicated team|talent|recruitment|consultants|consultores|body shopping|equipa dedicada|alocacao)\b/i,
    /\b(it professionals|technology professionals|profissionais de tecnologia|recursos humanos|staffing)\b/i,
  ].filter((re) => re.test(text)).length;
  const servicesSignals = [
    /\b(services|servicos|consulting|consultoria|implementation|implementacao|integration|integracao|development|desenvolvimento|custom|bespoke|projects|projetos|solucoes)\b/i,
    /\b(digital transformation|transformacao digital|business solutions|advisory)\b/i,
  ].filter((re) => re.test(text)).length;

  if (productSignals >= Math.max(servicesSignals, outsourcingSignals) && productSignals > 0) return "Produto";
  if (outsourcingSignals >= Math.max(productSignals, servicesSignals) && outsourcingSignals > 0) return "Outsourcing";
  return "Servicos";
}

function scoreFor(org, description) {
  const text = sourceText(org, description);
  let score = 8;
  const matched = [];
  for (const signal of scoringSignals) {
    if (signal.re.test(text)) {
      score += signal.points;
      matched.push(signal.label);
    }
  }
  if (description.length >= 100) score += 8;
  if ((org.contacts || []).some((contact) => (contact.jobTitles || []).some((title) => /\b(cto|cio|chief technology|chief information|chief data|chief ai|data|ai|innovation|digital|technology|tecnologia)\b/i.test(title)))) {
    score += 8;
    matched.push("Leadership tech signal");
  }
  if ((org.contacts || []).length >= 3) score += 4;
  if ((org.contacts || []).length === 0) score -= 6;
  return { score: Math.max(1, Math.min(100, score)), matched: unique(matched) };
}

function cLevelsFor(org) {
  const cLevelPattern = /\b(ceo|chief|cto|cio|cfo|coo|cmo|founder|co-founder|cofounder|managing director|general manager|country manager|director geral|administrador|administracao|president|presidente|partner|socio|socia|head of)\b/i;
  const people = [];
  for (const contact of org.contacts || []) {
    const titles = unique(contact.jobTitles || []);
    if (titles.some((title) => cLevelPattern.test(title))) {
      people.push(`${clean(contact.name)}${titles.length ? ` (${titles.join("; ")})` : ""}`);
    }
  }
  return unique(people).join(" | ");
}

function locationFor(org) {
  return unique([org.city, org.country]).join(", ");
}

function confidenceFromExternal(external, description) {
  if (!description || /atividade nao suficientemente descrita/i.test(description)) return "baixa";
  if (external?.confidence === "alta") return "alta";
  if (external?.confidence === "média" || external?.confidence === "media") return "media";
  if (description.length >= 140) return "media";
  return "baixa";
}

const rows = organisations.map((org) => {
  const review = reviewByName.get(normalizeName(org.name));
  const external = externalById.get(String(org.id)) || {};
  let descriptionSource = "Inferida do CRM";
  let confidence = "baixa";
  let action = "Rever";
  let sourceUrl = clean(org.url);
  let notes = "";
  let purpose;
  let score;
  let matched;
  let description;
  let wave = "";

  if (review) {
    description = clean(review.description);
    purpose = review.purpose;
    score = Number(review.aiPotentialScore || 0);
    confidence = review.confidence === "média" ? "media" : review.confidence;
    sourceUrl = clean(review.sourceUrl) || sourceUrl;
    notes = clean(review.notes);
    wave = review.wave;
    descriptionSource = "Revisao manual assistida";
    matched = scoreFor(org, description).matched;
  } else {
    const baseScore = scoreFor(org, clean(external.externalDescription));
    description = clean(external.externalDescription) || fallbackDescription(org, baseScore.matched);
    purpose = purposeFor(org, description);
    const recalculated = scoreFor(org, description);
    score = recalculated.score;
    matched = recalculated.matched;
    confidence = confidenceFromExternal(external, description);
    sourceUrl = clean(external.sourceUrl) || sourceUrl;
    notes = clean(external.error);
    descriptionSource = clean(external.externalDescription) ? "Website/metadados" : "Inferida do CRM";
  }

  if (confidence === "alta") action = "Candidato a atualizar";
  else if (confidence === "media") action = "Rever";
  else action = "Matching manual";

  return {
    name: clean(org.name),
    score,
    location: locationFor(org),
    purpose,
    description,
    confidence,
    flag: confidence === "baixa" ? "BAIXA CONFIANCA" : "",
    action,
    sourceUrl,
    descriptionSource,
    wave,
    cLevels: cLevelsFor(org) || "Nao identificado no CRM",
    employees: "Nao disponivel no CRM",
    website: clean(org.url),
    tags: unique([...(org.tags || []), ...(org.dataTags || [])]).join(", "),
    contacts: (org.contacts || []).length,
    signals: matched.join(", "),
    notes,
  };
});

rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "pt-PT"));

const workbook = Workbook.create();
const sheet = workbook.worksheets.add("Parceiros");
sheet.showGridLines = false;

const headers = [
  "Empresa",
  "Classificacao AI/LLM (1-100)",
  "Localizacao",
  "Proposito principal",
  "Descricao consolidada",
  "Confianca",
  "Flag",
  "Acao sugerida",
  "Fonte descricao",
  "URL fonte",
  "Onda revisao",
  "C-level identificados",
  "Numero de empregados",
  "Website CRM",
  "Tags/Data-tags",
  "Contactos no CRM",
  "Sinais de classificacao",
  "Notas",
  "Atualizar CRM?",
];

sheet.getRange("A1:S1").values = [headers];
sheet.getRangeByIndexes(1, 0, rows.length, headers.length).values = rows.map((row) => [
  row.name,
  row.score,
  row.location,
  row.purpose,
  row.description,
  row.confidence,
  row.flag,
  row.action,
  row.descriptionSource,
  row.sourceUrl,
  row.wave,
  row.cLevels,
  row.employees,
  row.website,
  row.tags,
  row.contacts,
  row.signals,
  row.notes,
  "",
]);

sheet.tables.add(`A1:S${rows.length + 1}`, true, "FullPartnerEnrichment").style = "TableStyleMedium2";
sheet.freezePanes.freezeRows(1);
sheet.getRange("A1:S1").format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF" } };
sheet.getRange(`A1:S${rows.length + 1}`).format.wrapText = true;
sheet.getRange("A:A").format.columnWidthPx = 230;
sheet.getRange("B:B").format.columnWidthPx = 120;
sheet.getRange("C:C").format.columnWidthPx = 160;
sheet.getRange("D:D").format.columnWidthPx = 130;
sheet.getRange("E:E").format.columnWidthPx = 620;
sheet.getRange("F:F").format.columnWidthPx = 100;
sheet.getRange("G:G").format.columnWidthPx = 150;
sheet.getRange("H:H").format.columnWidthPx = 150;
sheet.getRange("I:I").format.columnWidthPx = 150;
sheet.getRange("J:J").format.columnWidthPx = 250;
sheet.getRange("K:K").format.columnWidthPx = 120;
sheet.getRange("L:L").format.columnWidthPx = 360;
sheet.getRange("M:M").format.columnWidthPx = 150;
sheet.getRange("N:N").format.columnWidthPx = 230;
sheet.getRange("O:R").format.columnWidthPx = 180;
sheet.getRange("S:S").format.columnWidthPx = 110;
sheet.getRange(`B2:B${rows.length + 1}`).format.numberFormat = "0";
sheet.getRange(`B2:B${rows.length + 1}`).conditionalFormats.add("colorScale", {
  criteria: [
    { type: "num", value: 1, color: "#FEE2E2" },
    { type: "num", value: 50, color: "#FEF3C7" },
    { type: "num", value: 100, color: "#DCFCE7" },
  ],
});
sheet.getRange(`G2:G${rows.length + 1}`).conditionalFormats.add("containsText", {
  text: "BAIXA CONFIANCA",
  format: { fill: "#DC2626", font: { bold: true, color: "#FFFFFF" } },
});
sheet.getRange(`F2:F${rows.length + 1}`).conditionalFormats.add("containsText", {
  text: "baixa",
  format: { fill: "#FEE2E2", font: { bold: true, color: "#991B1B" } },
});
sheet.getRange(`S2:S${rows.length + 1}`).dataValidation = {
  rule: { type: "list", values: ["Sim", "Nao", "Rever"] },
};

const summary = workbook.worksheets.add("Resumo");
summary.showGridLines = false;
const avg = rows.reduce((sum, row) => sum + row.score, 0) / Math.max(1, rows.length);
const count = (field, value) => rows.filter((row) => row[field] === value).length;
summary.getRange("A1:D1").values = [["Consolidado completo de parceiros", "", "", ""]];
summary.getRange("A1:D1").merge();
summary.getRange("A1").format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF", size: 16 } };
summary.getRange("A3:B20").values = [
  ["Parceiros", rows.length],
  ["Score medio", Number(avg.toFixed(1))],
  ["Confianca alta", count("confidence", "alta")],
  ["Confianca media", count("confidence", "media")],
  ["Confianca baixa", count("confidence", "baixa")],
  ["Produto", count("purpose", "Produto")],
  ["Servicos", count("purpose", "Servicos")],
  ["Outsourcing", count("purpose", "Outsourcing")],
  ["Revisao manual assistida", count("descriptionSource", "Revisao manual assistida")],
  ["Website/metadados", count("descriptionSource", "Website/metadados")],
  ["Inferida do CRM", count("descriptionSource", "Inferida do CRM")],
  ["Candidatos a atualizar", count("action", "Candidato a atualizar")],
  ["A rever", count("action", "Rever")],
  ["Matching manual", count("action", "Matching manual")],
  ["Snapshot CRM", clean(cache.refreshedAt)],
  ["Organizacoes no cache", cache.organisationCount || organisations.length],
  ["Descricoes externas originais", externalPayload.ok || ""],
  ["Ondas revistas", reviewByName.size],
];
summary.getRange("A3:A20").format = { font: { bold: true }, fill: "#EAF2F8" };
summary.getRange("A3:B20").format.borders = { preset: "all", style: "thin", color: "#D5DEE8" };
summary.getRange("A:A").format.columnWidthPx = 240;
summary.getRange("B:B").format.columnWidthPx = 220;

summary.getRange("D3:E6").values = [
  ["Confianca", "Parceiros"],
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
methodology.getRange("A2:B9").values = [
  ["Objetivo", "Unificar todos os parceiros do CRM num unico ficheiro de enriquecimento e classificacao."],
  ["Prioridade de descricao", "Primeiro usa as 84 descricoes revistas; depois descricoes externas recolhidas; por fim descricao inferida do CRM."],
  ["Baixa confianca", "Assinalada com BAIXA CONFIANCA e acao Matching manual."],
  ["Media confianca", "Deve ser revista antes de escrita automatica."],
  ["Alta confianca", "Candidata a atualizacao no CRM se o texto estiver alinhado editorialmente."],
  ["Atualizar CRM?", "Preencher Sim, Nao ou Rever. Scripts futuros devem escrever apenas linhas com Sim."],
  ["Numero de empregados", "Nao esta disponivel no snapshot local; coluna mantida para futuro enriquecimento."],
  ["Seguranca operacional", "Nenhuma informacao foi escrita no CRM por este processo."],
];
methodology.getRange("A:B").format.wrapText = true;
methodology.getRange("A:A").format.columnWidthPx = 190;
methodology.getRange("B:B").format.columnWidthPx = 760;
methodology.getRange("A1:B9").format.borders = { preset: "all", style: "thin", color: "#D5DEE8" };

await fs.mkdir(outputDir, { recursive: true });
const preview = await workbook.render({ sheetName: "Resumo", autoCrop: "all", scale: 1, format: "png" });
await fs.writeFile(path.join(outputDir, "crm-enrichment-full-partners-preview.png"), new Uint8Array(await preview.arrayBuffer()));
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(outputPath);
