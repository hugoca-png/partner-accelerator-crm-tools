import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const root = process.cwd();
const cachePath = path.join(root, "capsule-cache.json");
const externalPath = path.join(root, "external-descriptions.json");
const planPath = path.join(root, "crm-enrichment-update-plan.json");
const outputDir = path.join(root, "outputs");
const outputPath = path.join(outputDir, "crm-business-segmentation.xlsx");

const cache = JSON.parse(await fs.readFile(cachePath, "utf8"));
const organisations = cache.organisations || [];

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

const externalPayload = await readJsonIfExists(externalPath, { results: [] });
const planPayload = await readJsonIfExists(planPath, { rows: [] });

const externalById = new Map((externalPayload.results || []).map((item) => [String(item.id), item]));
const planById = new Map((planPayload.rows || []).map((item) => [String(item.id), item]));

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function ascii(value) {
  return clean(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7F]/g, "");
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function locationFor(org) {
  return unique([org.city, org.country]).join(", ");
}

function cLevelsFor(org) {
  const cLevelPattern = /\b(ceo|chief|cto|cio|cfo|coo|cmo|founder|co-founder|cofounder|managing director|general manager|country manager|director geral|administrador|administracao|president|presidente|partner|socio|socia|head of|vp|vice president)\b/i;
  return unique(
    (org.contacts || [])
      .filter((contact) => (contact.jobTitles || []).some((title) => cLevelPattern.test(title)))
      .map((contact) => {
        const titles = unique(contact.jobTitles || []);
        return `${clean(contact.name)}${titles.length ? ` (${titles.join("; ")})` : ""}`;
      }),
  ).join(" | ");
}

function sourceText(org, description = "") {
  return ascii([
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
  ].join(" ")).toLowerCase();
}

const businessAreas = [
  {
    area: "Data & AI",
    tag: "Segmento: Data & AI",
    patterns: [
      /\b(data science|data engineering|data platform|analytics|analitica|business intelligence|\bbi\b|power bi|fabric|synapse|machine learning|artificial intelligence|inteligencia artificial|\bai\b|llm|genai|generative ai|agentic|chatbot|nlp|computer vision|predictive|modelos)\b/i,
    ],
  },
  {
    area: "Business Applications",
    tag: "Segmento: Business Applications",
    patterns: [
      /\b(erp|crm|dynamics|business applications|business solutions|power platform|low code|low-code|sharepoint|microsoft 365|m365|office 365|teams|process automation|workflow|rpa)\b/i,
    ],
  },
  {
    area: "Cloud & Infrastructure",
    tag: "Segmento: Cloud & Infrastructure",
    patterns: [
      /\b(cloud|azure|aws|infrastructure|infraestrutura|datacenter|data center|network|redes|managed services|servicos geridos|devops|kubernetes|containers|hosting|backup|disaster recovery|endpoint)\b/i,
    ],
  },
  {
    area: "Cybersecurity",
    tag: "Segmento: Cybersecurity",
    patterns: [
      /\b(cyber|ciber|security|seguranca|cybersecurity|ciberseguranca|soc|siem|identity|iam|compliance|risk|privacy|fraud|vulnerability|penetration|pentest)\b/i,
    ],
  },
  {
    area: "Software Development",
    tag: "Segmento: Software Development",
    patterns: [
      /\b(software development|desenvolvimento de software|custom software|app development|web development|mobile|api|integration|integracao|sistemas de informacao|nearshore development|engineering|dev team)\b/i,
    ],
  },
  {
    area: "Digital Consulting",
    tag: "Segmento: Digital Consulting",
    patterns: [
      /\b(consulting|consultoria|digital transformation|transformacao digital|innovation|inovacao|advisory|strategy|business consulting|technology consulting|gestao)\b/i,
    ],
  },
  {
    area: "Managed Services & Outsourcing",
    tag: "Segmento: Managed Services & Outsourcing",
    patterns: [
      /\b(outsourcing|nearshore|staff augmentation|talent|recruitment|managed team|dedicated team|servicos geridos|managed services|it support|suporte)\b/i,
    ],
  },
  {
    area: "Products & SaaS",
    tag: "Segmento: Products & SaaS",
    patterns: [
      /\b(product|produto|platform|plataforma|saas|software as a service|subscription|licensing|licenciamento|marketplace|solution provider|vendor|fabricante)\b/i,
    ],
  },
  {
    area: "Training & Adoption",
    tag: "Segmento: Training & Adoption",
    patterns: [
      /\b(training|formacao|academy|learning|adoption|capacitacao|workshop|certification|certificacao)\b/i,
    ],
  },
  {
    area: "Distribution & Resale",
    tag: "Segmento: Distribution & Resale",
    patterns: [
      /\b(distributor|distribuidor|reseller|revenda|licensing|licenciamento|v-valley|tdsynnex|softwareone|crayon|partner channel|canal)\b/i,
    ],
  },
];

const secondarySignals = [
  { label: "Microsoft", re: /\b(microsoft|azure|dynamics|power platform|power bi|fabric|m365|office 365|teams|sharepoint|copilot|iamcp)\b/i },
  { label: "AI/LLM", re: /\b(ai|artificial intelligence|inteligencia artificial|llm|genai|generative ai|agentic|machine learning|nlp)\b/i },
  { label: "Analytics", re: /\b(data|analytics|analitica|business intelligence|\bbi\b|power bi|fabric|data science|data engineering)\b/i },
  { label: "Cloud", re: /\b(cloud|azure|aws|infrastructure|devops|kubernetes|hosting)\b/i },
  { label: "Security", re: /\b(cyber|ciber|security|seguranca|identity|risk|compliance|privacy)\b/i },
  { label: "ERP/CRM", re: /\b(erp|crm|dynamics|salesforce|business applications)\b/i },
  { label: "Automation", re: /\b(automation|automacao|workflow|rpa|low code|low-code|power platform)\b/i },
  { label: "Software Engineering", re: /\b(software|development|desenvolvimento|engineering|api|integration|mobile|web)\b/i },
  { label: "Managed Services", re: /\b(managed services|servicos geridos|support|suporte|outsourcing)\b/i },
];

function classifyArea(text) {
  const scores = businessAreas.map((area) => ({
    ...area,
    score: area.patterns.reduce((sum, pattern) => sum + (pattern.test(text) ? 1 : 0), 0),
  }));
  scores.sort((a, b) => b.score - a.score || a.area.localeCompare(b.area, "pt-PT"));
  const top = scores[0];
  if (!top || top.score === 0) return { primaryArea: "Nao classificado", recommendedTag: "Segmento: A rever", confidenceHint: "baixa" };
  return {
    primaryArea: top.area,
    recommendedTag: top.tag,
    confidenceHint: top.score >= 2 ? "alta" : "media",
  };
}

function secondaryAreas(text, primaryArea) {
  return unique(
    secondarySignals
      .filter((signal) => signal.re.test(text))
      .map((signal) => signal.label)
      .filter((label) => label !== primaryArea),
  ).join(", ");
}

function purposeFor(org, description, plan) {
  if (plan?.purpose) {
    const p = ascii(plan.purpose).toLowerCase();
    if (p.includes("produto")) return "Produto";
    if (p.includes("outsourcing")) return "Outsourcing";
    return "Servicos";
  }
  const text = sourceText(org, description);
  const product = /\b(product|produto|platform|plataforma|saas|software as a service|subscription|licensing|licenciamento|vendor|fabricante)\b/i.test(text);
  const outsourcing = /\b(outsourcing|nearshore|staff augmentation|talent|recruitment|managed team|dedicated team)\b/i.test(text);
  if (product && !outsourcing) return "Produto";
  if (outsourcing) return "Outsourcing";
  return "Servicos";
}

function confidenceFor(plan, external, classification) {
  const planConfidence = ascii(plan?.confidence || "").toLowerCase();
  if (planConfidence.includes("alta")) return "alta";
  if (planConfidence.includes("media")) return "media";
  if (planConfidence.includes("baixa")) return "baixa";
  const externalConfidence = ascii(external?.confidence || "").toLowerCase();
  if (externalConfidence.includes("alta")) return "alta";
  if (externalConfidence.includes("media")) return "media";
  if (classification.confidenceHint === "alta") return "media";
  return classification.confidenceHint;
}

function aiPotential(org, description) {
  const text = sourceText(org, description);
  let score = 8;
  const signals = [];
  const checks = [
    [/\b(llm|genai|generative ai|agentic|copilot|rag|prompt)\b/i, 30, "LLM/GenAI"],
    [/\b(ai|artificial intelligence|inteligencia artificial|machine learning|computer vision|nlp|chatbot)\b/i, 22, "AI/ML"],
    [/\b(data science|data platform|data engineering|analytics|business intelligence|\bbi\b|power bi|fabric|predictive)\b/i, 18, "Data/Analytics"],
    [/\b(automation|automacao|workflow|rpa|low code|low-code|process mining)\b/i, 12, "Automation"],
    [/\b(azure|microsoft|power platform|dynamics|m365|office 365|fabric|synapse|iamcp)\b/i, 10, "Microsoft"],
    [/\b(cloud|software|api|integration|platform|saas|devops)\b/i, 8, "Cloud/Software"],
    [/\b(cyber|security|compliance|risk|privacy|identity)\b/i, 6, "Security/Risk"],
  ];
  for (const [re, points, label] of checks) {
    if (re.test(text)) {
      score += points;
      signals.push(label);
    }
  }
  if ((org.contacts || []).length >= 3) score += 4;
  return { score: Math.max(1, Math.min(100, score)), signals: unique(signals) };
}

function descriptionFor(org, plan, external) {
  if (clean(plan?.description)) return clean(plan.description);
  if (clean(external?.externalDescription)) return clean(external.externalDescription);
  const tags = unique([...(org.tags || []), ...(org.dataTags || []), ...(org.filterTags || []), ...(org.filterDataTags || [])]);
  const activity = tags.length ? `Sinais CRM: ${tags.join(", ")}.` : "Descricao insuficiente no CRM; requer enriquecimento externo.";
  return `${clean(org.name)}. ${activity}`;
}

const rows = organisations.map((org) => {
  const plan = planById.get(String(org.id));
  const external = externalById.get(String(org.id));
  const description = descriptionFor(org, plan, external);
  const text = sourceText(org, description);
  const classification = classifyArea(text);
  const purpose = purposeFor(org, description, plan);
  const confidence = confidenceFor(plan, external, classification);
  const ai = aiPotential(org, description);
  const secondary = secondaryAreas(text, classification.primaryArea);
  const crmFieldRecommendation = "Campo customizado/Data tag: Area de negocio principal; Tags: apenas para campanhas";
  return {
    id: String(org.id),
    name: clean(org.name),
    primaryArea: classification.primaryArea,
    secondaryAreas: secondary,
    purpose,
    aiScore: ai.score,
    confidence,
    flag: confidence === "baixa" ? "REVER" : "",
    recommendedCrmField: crmFieldRecommendation,
    recommendedTag: classification.recommendedTag,
    location: locationFor(org),
    city: clean(org.city),
    country: clean(org.country),
    website: clean(org.url),
    contacts: (org.contacts || []).length,
    cLevels: cLevelsFor(org) || "Nao identificado no CRM",
    currentTags: unique([...(org.tags || []), ...(org.dataTags || [])]).join(", "),
    description,
    signals: ai.signals.join(", "),
    source: plan ? "Enriquecimento CRM ja preparado" : clean(external?.externalDescription) ? "Descricao externa existente" : "Inferido do CRM",
    sourceUrl: clean(plan?.sourceUrl) || clean(external?.sourceUrl) || clean(org.url),
    notes: confidence === "baixa" ? "Validar manualmente antes de escrever no CRM." : "",
  };
});

rows.sort((a, b) => a.primaryArea.localeCompare(b.primaryArea, "pt-PT") || b.aiScore - a.aiScore || a.name.localeCompare(b.name, "pt-PT"));

const workbook = Workbook.create();
const summary = workbook.worksheets.add("Resumo");
summary.showGridLines = false;
const detail = workbook.worksheets.add("Segmentacao");
detail.showGridLines = false;
const methodology = workbook.worksheets.add("Modelo CRM");
methodology.showGridLines = false;

const countBy = (field) => {
  const map = new Map();
  for (const row of rows) map.set(row[field], (map.get(row[field]) || 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt-PT"));
};

const areaCounts = countBy("primaryArea");
const confidenceCounts = countBy("confidence");
const purposeCounts = countBy("purpose");
const avgScore = rows.reduce((sum, row) => sum + row.aiScore, 0) / Math.max(1, rows.length);

summary.getRange("A1:H1").values = [["Segmentacao de parceiros CRM", "", "", "", "", "", "", ""]];
summary.getRange("A1:H1").merge();
summary.getRange("A1").format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF", size: 16 } };
summary.getRange("A3:B8").values = [
  ["Empresas classificadas", rows.length],
  ["Snapshot CRM", clean(cache.refreshedAt)],
  ["Score AI medio", Number(avgScore.toFixed(1))],
  ["Confianca alta", rows.filter((r) => r.confidence === "alta").length],
  ["Confianca media", rows.filter((r) => r.confidence === "media").length],
  ["A rever", rows.filter((r) => r.confidence === "baixa").length],
];
summary.getRange("A3:A8").format = { font: { bold: true }, fill: "#EAF2F8" };
summary.getRange("A3:B8").format.borders = { preset: "all", style: "thin", color: "#D5DEE8" };

summary.getRangeByIndexes(2, 3, areaCounts.length + 1, 2).values = [["Area principal", "Empresas"], ...areaCounts];
summary.getRangeByIndexes(2, 3, 1, 2).format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF" } };
summary.getRangeByIndexes(2, 3, areaCounts.length + 1, 2).format.borders = { preset: "all", style: "thin", color: "#D5DEE8" };
const areaChart = summary.charts.add("bar", summary.getRangeByIndexes(2, 3, areaCounts.length + 1, 2));
areaChart.title = "Empresas por area principal";
areaChart.hasLegend = false;
areaChart.setPosition("G3", "N22");

const startPurpose = 12;
summary.getRangeByIndexes(startPurpose, 0, purposeCounts.length + 1, 2).values = [["Proposito", "Empresas"], ...purposeCounts];
summary.getRangeByIndexes(startPurpose, 0, 1, 2).format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF" } };
summary.getRangeByIndexes(startPurpose, 0, purposeCounts.length + 1, 2).format.borders = { preset: "all", style: "thin", color: "#D5DEE8" };
summary.getRangeByIndexes(startPurpose, 3, confidenceCounts.length + 1, 2).values = [["Confianca", "Empresas"], ...confidenceCounts];
summary.getRangeByIndexes(startPurpose, 3, 1, 2).format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF" } };
summary.getRangeByIndexes(startPurpose, 3, confidenceCounts.length + 1, 2).format.borders = { preset: "all", style: "thin", color: "#D5DEE8" };
summary.getRange("A:A").format.columnWidthPx = 210;
summary.getRange("B:B").format.columnWidthPx = 140;
summary.getRange("D:D").format.columnWidthPx = 240;
summary.getRange("E:E").format.columnWidthPx = 110;

const headers = [
  "Capsule ID",
  "Empresa",
  "Area principal",
  "Areas secundarias",
  "Proposito",
  "Score AI/LLM",
  "Confianca",
  "Flag",
  "Campo CRM recomendado",
  "Tag campanha sugerida",
  "Localizacao",
  "Cidade",
  "Pais",
  "Website",
  "Contactos",
  "C-level identificados",
  "Tags/Data-tags atuais",
  "Descricao usada",
  "Sinais",
  "Fonte",
  "URL fonte",
  "Atualizar CRM?",
  "Notas",
];
detail.getRange("A1:W1").values = [headers];
detail.getRangeByIndexes(1, 0, rows.length, headers.length).values = rows.map((row) => [
  row.id,
  row.name,
  row.primaryArea,
  row.secondaryAreas,
  row.purpose,
  row.aiScore,
  row.confidence,
  row.flag,
  row.recommendedCrmField,
  row.recommendedTag,
  row.location,
  row.city,
  row.country,
  row.website,
  row.contacts,
  row.cLevels,
  row.currentTags,
  row.description,
  row.signals,
  row.source,
  row.sourceUrl,
  "",
  row.notes,
]);
detail.tables.add(`A1:W${rows.length + 1}`, true, "BusinessSegmentation").style = "TableStyleMedium2";
detail.freezePanes.freezeRows(1);
detail.getRange("A1:W1").format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF" } };
detail.getRange(`A1:W${rows.length + 1}`).format.wrapText = true;
detail.getRange("A:A").format.columnWidthPx = 100;
detail.getRange("B:B").format.columnWidthPx = 230;
detail.getRange("C:D").format.columnWidthPx = 210;
detail.getRange("E:E").format.columnWidthPx = 115;
detail.getRange("F:F").format.columnWidthPx = 90;
detail.getRange("G:H").format.columnWidthPx = 95;
detail.getRange("I:I").format.columnWidthPx = 310;
detail.getRange("J:J").format.columnWidthPx = 230;
detail.getRange("K:M").format.columnWidthPx = 145;
detail.getRange("N:N").format.columnWidthPx = 230;
detail.getRange("O:O").format.columnWidthPx = 90;
detail.getRange("P:P").format.columnWidthPx = 360;
detail.getRange("Q:Q").format.columnWidthPx = 260;
detail.getRange("R:R").format.columnWidthPx = 560;
detail.getRange("S:U").format.columnWidthPx = 190;
detail.getRange("V:V").format.columnWidthPx = 110;
detail.getRange("W:W").format.columnWidthPx = 230;
detail.getRange(`F2:F${rows.length + 1}`).format.numberFormat = "0";
detail.getRange(`F2:F${rows.length + 1}`).conditionalFormats.add("colorScale", {
  criteria: [
    { type: "num", value: 1, color: "#FEE2E2" },
    { type: "num", value: 50, color: "#FEF3C7" },
    { type: "num", value: 100, color: "#DCFCE7" },
  ],
});
detail.getRange(`H2:H${rows.length + 1}`).conditionalFormats.add("containsText", {
  text: "REVER",
  format: { fill: "#DC2626", font: { bold: true, color: "#FFFFFF" } },
});
detail.getRange(`V2:V${rows.length + 1}`).dataValidation = {
  rule: { type: "list", values: ["Sim", "Nao", "Rever"] },
};

methodology.getRange("A1:C1").values = [["Decisao CRM", "Recomendacao", "Notas"]];
methodology.getRange("A1:C1").format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF" } };
methodology.getRange("A2:C10").values = [
  ["Area principal", "Campo customizado / Data tag controlado", "Melhor para governanca: um valor unico por empresa, facil de auditar e evitar variantes."],
  ["Areas secundarias", "Campo customizado multi-valor ou notas de enriquecimento", "Pode ter varios valores. Evitar dezenas de tags se ainda estiver em revisao."],
  ["Tags de campanha", "Tags simples com prefixo Segmento:", "Usar apenas quando a classificacao estiver validada e for util para filtros/campanhas."],
  ["Proposito", "Tags existentes Produto, Servico, Outsourcing", "Ja existem no CRM; manter para leitura rapida e compatibilidade com filtros atuais."],
  ["Score AI/LLM", "Campo numerico customizado", "Nao deve ser tag. Valor numerico permite ranking e cortes por threshold."],
  ["Confianca", "Campo customizado ou tag operacional", "Usar para decidir o que pode ser escrito automaticamente e o que exige revisao."],
  ["Regra de escrita", "Atualizar apenas linhas com Atualizar CRM? = Sim", "Evita gravar classificacoes fracas no CRM."],
  ["Baixa confianca", "Nao escrever automaticamente", "Validar website/descricao antes de classificar."],
  ["Fonte", "Guardar URL fonte quando existir", "Ajuda auditoria futura."],
];
methodology.getRange("A:C").format.wrapText = true;
methodology.getRange("A:A").format.columnWidthPx = 180;
methodology.getRange("B:B").format.columnWidthPx = 320;
methodology.getRange("C:C").format.columnWidthPx = 560;
methodology.getRange("A1:C10").format.borders = { preset: "all", style: "thin", color: "#D5DEE8" };

await fs.mkdir(outputDir, { recursive: true });
const preview = await workbook.render({ sheetName: "Resumo", autoCrop: "all", scale: 1, format: "png" });
await fs.writeFile(path.join(outputDir, "crm-business-segmentation-preview.png"), new Uint8Array(await preview.arrayBuffer()));
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);

console.log(JSON.stringify({
  outputPath,
  organisations: rows.length,
  areas: Object.fromEntries(areaCounts),
  confidence: Object.fromEntries(confidenceCounts),
  purpose: Object.fromEntries(purposeCounts),
}, null, 2));
