import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const root = process.cwd();
const cachePath = path.join(root, "capsule-cache.json");
const externalPath = path.join(root, "external-descriptions.json");
const outputDir = path.join(root, "outputs");
const outputPath = path.join(outputDir, "crm-ai-potential-enriched-purpose-100.xlsx");

const data = JSON.parse(await fs.readFile(cachePath, "utf8"));
const organisations = data.organisations || [];
let externalDescriptions = new Map();
try {
  const external = JSON.parse(await fs.readFile(externalPath, "utf8"));
  externalDescriptions = new Map((external.results || []).map((item) => [String(item.id), item]));
} catch {
  externalDescriptions = new Map();
}

const cLevelPattern =
  /\b(ceo|chief|cto|cio|cfo|coo|cmo|founder|co-founder|cofounder|managing director|general manager|country manager|director geral|administrador|administra[cç][aã]o|president|presidente|partner|s[oó]cio|socia|head of)\b/i;

const scoringSignals = [
  { re: /\b(llm|large language model|genai|generative ai|generative artificial intelligence|agentic|copilot|prompt|rag|retrieval augmented|foundation model)\b/i, points: 28, label: "LLM/GenAI" },
  { re: /\b(ai|artificial intelligence|intelig[eê]ncia artificial|machine learning|deep learning|ml|computer vision|nlp|natural language|chatbot|virtual assistant|autonomous|intelligent automation)\b/i, points: 22, label: "AI/ML" },
  { re: /\b(data science|data platform|data engineering|big data|analytics|anal[ií]tica|business intelligence|\bbi\b|power bi|predictive|prediction|forecast|modelos|modelling|synthetic data|data quality|data governance)\b/i, points: 18, label: "Data/Analytics" },
  { re: /\b(automation|automa[cç][aã]o|workflow|process mining|rpa|low-code|low code|no-code|digitalization|digitaliza[cç][aã]o)\b/i, points: 12, label: "Automation/Digitalization" },
  { re: /\b(azure|microsoft|power platform|dynamics|teams|sharepoint|m365|office 365|fabric|synapse|iamcp)\b/i, points: 10, label: "Microsoft ecosystem" },
  { re: /\b(cloud|infrastructure|infraestrutura|devops|kubernetes|managed services|platform|saas|software product|product development|api|integration|systems|sistemas)\b/i, points: 10, label: "Cloud/Software/Product" },
  { re: /\b(security|cyber|ciber|cybersecurity|compliance|identity|risk|fraud|aml|privacy|governance)\b/i, points: 8, label: "Security/Risk" },
  { re: /\b(health|finance|banking|insurance|retail|logistics|industry|industrial|energy|public sector|enterprise|b2b)\b/i, points: 5, label: "Enterprise/domain fit" },
  { re: /\b(consult|business solutions|solu[cç][oõ]es|technology|tecnologia|innovation|inova[cç][aã]o|digital transformation|transforma[cç][aã]o digital)\b/i, points: 5, label: "Technology services" },
];

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function sourceText(org) {
  const contacts = org.contacts || [];
  return [
    org.name,
    org.url,
    org.city,
    org.country,
    ...(org.tags || []),
    ...(org.dataTags || []),
    ...(org.filterTags || []),
    ...(org.filterDataTags || []),
    ...(org.domains || []),
    ...contacts.flatMap((contact) => [contact.name, ...(contact.jobTitles || []), ...(contact.tags || []), ...(contact.dataTags || [])]),
  ].join(" ");
}

function scoreOrg(org) {
  const external = externalDescriptions.get(String(org.id)) || {};
  const externalText = [external.externalDescription, external.title].filter(Boolean).join(" ");
  const text = [externalText, sourceText(org)].join(" ");
  let score = 8;
  const matched = [];
  for (const signal of scoringSignals) {
    if (signal.re.test(text)) {
      score += signal.points;
      matched.push(signal.label);
    }
  }
  if (externalText.length >= 80) score += 8;
  if ((org.contacts || []).some((contact) => (contact.jobTitles || []).some((title) => /\b(cto|cio|chief technology|chief information|chief data|chief ai|data|ai|innovation|digital|technology|tecnologia)\b/i.test(title)))) {
    score += 8;
    matched.push("Leadership tech signal");
  }
  if ((org.contacts || []).length >= 3) score += 4;
  if ((org.contacts || []).length === 0) score -= 6;
  return {
    score: Math.max(1, Math.min(100, score)),
    matched: unique(matched),
  };
}

function descriptionFor(org, matched) {
  const name = clean(org.name);
  const text = sourceText(org);
  const parts = [];

  if (/\b(ai|artificial intelligence|intelig[eê]ncia artificial|llm|machine learning|computer vision|nlp|agentic|chatbot)\b/i.test(text)) {
    parts.push("soluções de inteligência artificial, automação inteligente e modelos avançados");
  }
  if (/\b(data|dados|analytics|anal[ií]tica|business intelligence|\bbi\b|big data|data science|predictive)\b/i.test(text)) {
    parts.push("dados, analytics e business intelligence");
  }
  if (/\b(cloud|azure|microsoft|m365|office 365|dynamics|power platform|sharepoint|teams)\b/i.test(text)) {
    parts.push("cloud e ecossistema Microsoft");
  }
  if (/\b(security|cyber|ciber|risk|compliance)\b/i.test(text)) {
    parts.push("cibersegurança, risco e compliance");
  }
  if (/\b(infra|infrastructure|infraestrutura|network|rede|devops|managed services)\b/i.test(text)) {
    parts.push("infraestrutura, redes e serviços geridos");
  }
  if (/\b(software|sistemas|systems|development|desenvolvimento|app|digital)\b/i.test(text)) {
    parts.push("desenvolvimento de software e transformação digital");
  }
  if (parts.length === 0 && /\b(consult|business|solu[cç][oõ]es|tecnologia|technology)\b/i.test(text)) {
    parts.push("consultoria tecnológica e soluções empresariais");
  }

  const activity = parts.length ? unique(parts).join("; ") : "atividade não suficientemente descrita no CRM; requer enriquecimento externo";
  const sourceNote = matched.length ? `Sinais usados: ${matched.join(", ")}.` : "Sem sinais tecnológicos fortes no CRM.";
  return `${name}: ${activity}. ${sourceNote}`;
}

function purposeFor(org, description) {
  const text = [description, sourceText(org)].join(" ");
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

function cLevelsFor(org) {
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

const rows = organisations.map((org) => {
  const scoring = scoreOrg(org);
  const external = externalDescriptions.get(String(org.id)) || {};
  const inferredDescription = descriptionFor(org, scoring.matched);
  const externalDescription = clean(external.externalDescription);
  const description = externalDescription || inferredDescription;
  return {
    name: clean(org.name),
    score: scoring.score,
    location: locationFor(org),
    city: clean(org.city),
    country: clean(org.country),
    description,
    inferredDescription,
    purpose: purposeFor(org, description),
    externalDescription,
    externalSource: clean(external.sourceUrl),
    externalConfidence: clean(external.confidence) || (externalDescriptions.size ? "baixa" : "não recolhida"),
    externalStatus: clean(external.status),
    externalError: clean(external.error),
    cLevels: cLevelsFor(org) || "Não identificado no CRM",
    employees: "Não disponível no CRM",
    website: clean(org.url),
    tags: unique([...(org.tags || []), ...(org.dataTags || [])]).join(", "),
    contacts: (org.contacts || []).length,
    scoringSignals: scoring.matched.join(", "),
  };
});

rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "pt-PT"));

const workbook = Workbook.create();
const sheet = workbook.worksheets.add("Empresas");
sheet.showGridLines = false;

const headers = [
  "Nome",
  "Classificacao AI/LLM (1-100)",
  "Localizacao",
  "Descricao enriquecida para revisao",
  "Proposito principal",
  "Descricao inferida do CRM",
  "Fonte externa",
  "Confianca fonte",
  "C-level identificados",
  "Numero de empregados",
  "Website",
  "Tags/Data-tags",
  "Contactos no CRM",
  "Sinais de classificacao",
  "Estado enriquecimento",
  "Aviso enriquecimento",
];

sheet.getRange("A1:P1").values = [headers];
sheet.getRangeByIndexes(1, 0, rows.length, headers.length).values = rows.map((row) => [
  row.name,
  row.score,
  row.location,
  row.description,
  row.purpose,
  row.inferredDescription,
  row.externalSource,
  row.externalConfidence,
  row.cLevels,
  row.employees,
  row.website,
  row.tags,
  row.contacts,
  row.scoringSignals,
  row.externalStatus,
  row.externalError,
]);

sheet.tables.add(`A1:P${rows.length + 1}`, true, "EmpresasAI").style = "TableStyleMedium2";
sheet.freezePanes.freezeRows(1);
sheet.getRange("A1:P1").format = {
  fill: "#12354A",
  font: { bold: true, color: "#FFFFFF" },
};
sheet.getRange(`B2:B${rows.length + 1}`).format.numberFormat = "0";
sheet.getRange(`A1:P${rows.length + 1}`).format.wrapText = true;
sheet.getRange("A:A").format.columnWidthPx = 230;
sheet.getRange("B:B").format.columnWidthPx = 120;
sheet.getRange("C:C").format.columnWidthPx = 160;
sheet.getRange("D:D").format.columnWidthPx = 520;
sheet.getRange("E:E").format.columnWidthPx = 130;
sheet.getRange("F:F").format.columnWidthPx = 430;
sheet.getRange("G:G").format.columnWidthPx = 260;
sheet.getRange("H:H").format.columnWidthPx = 110;
sheet.getRange("I:I").format.columnWidthPx = 360;
sheet.getRange("J:J").format.columnWidthPx = 160;
sheet.getRange("K:K").format.columnWidthPx = 230;
sheet.getRange("L:L").format.columnWidthPx = 220;
sheet.getRange("M:P").format.columnWidthPx = 170;

sheet.getRange(`B2:B${rows.length + 1}`).conditionalFormats.add("colorScale", {
  criteria: [
    { type: "num", value: 1, color: "#FEE2E2" },
    { type: "num", value: 50, color: "#FEF3C7" },
    { type: "num", value: 100, color: "#DCFCE7" },
  ],
});

const summary = workbook.worksheets.add("Resumo");
summary.showGridLines = false;
const refreshed = clean(data.refreshedAt);
const avg = rows.reduce((sum, row) => sum + row.score, 0) / Math.max(1, rows.length);
const high = rows.filter((row) => row.score >= 75).length;
const medium = rows.filter((row) => row.score >= 40 && row.score < 75).length;
const low = rows.filter((row) => row.score < 40).length;
const externallyEnriched = rows.filter((row) => row.externalDescription).length;
const productCount = rows.filter((row) => row.purpose === "Produto").length;
const servicesCount = rows.filter((row) => row.purpose === "Servicos").length;
const outsourcingCount = rows.filter((row) => row.purpose === "Outsourcing").length;
summary.getRange("A1:D1").values = [["CRM AI/LLM Potential", "", "", ""]];
summary.getRange("A1:D1").merge();
summary.getRange("A1").format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF", size: 16 } };
summary.getRange("A3:B12").values = [
  ["Organizacoes analisadas", rows.length],
  ["Score medio", Number(avg.toFixed(1))],
  ["Potencial alto (75-100)", high],
  ["Potencial medio (40-74)", medium],
  ["Potencial baixo (1-39)", low],
  ["Descricoes externas recolhidas", externallyEnriched],
  ["Proposito Produto", productCount],
  ["Proposito Servicos", servicesCount],
  ["Proposito Outsourcing", outsourcingCount],
  ["Snapshot CRM", refreshed],
];
summary.getRange("A3:A12").format = { font: { bold: true }, fill: "#EAF2F8" };
summary.getRange("A3:B12").format.borders = { preset: "all", style: "thin", color: "#D5DEE8" };
summary.getRange("A:A").format.columnWidthPx = 230;
summary.getRange("B:B").format.columnWidthPx = 220;

summary.getRange("D3:E8").values = [
  ["Faixa", "N empresas"],
  ["75-100", high],
  ["40-74", medium],
  ["1-39", low],
  ["", ""],
  ["", ""],
];
summary.getRange("D3:E3").format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF" } };
const chart = summary.charts.add("bar", summary.getRange("D3:E6"));
chart.title = "Distribuicao por potencial AI/LLM";
chart.hasLegend = false;
chart.setPosition("D10", "J26");

const methodology = workbook.worksheets.add("Metodologia");
methodology.showGridLines = false;
methodology.getRange("A1:D1").values = [["Metodologia e limitacoes", "", "", ""]];
methodology.getRange("A1:D1").merge();
methodology.getRange("A1").format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF", size: 14 } };
methodology.getRange("A3:B15").values = [
  ["Fonte principal", "capsule-cache.json gerado a partir do CRM local."],
  ["Descricao enriquecida", "Preferencialmente extraida dos websites publicos registados no CRM, usando title/meta description/og description/JSON-LD, texto da homepage e paginas about/services quando disponiveis."],
  ["Descricao inferida", "Inferida a partir de nome, website, tags, data-tags e cargos dos contactos existentes no CRM."],
  ["Proposito principal", "Classificacao heuristica entre Produto, Servicos e Outsourcing, usando a descricao enriquecida e sinais do CRM."],
  ["Classificacao 1-100", "Score heuristico recalculado com prioridade a descricao externa enriquecida. A escala aberta distingue melhor empresas com sinais fortes de AI/LLM, data, produto tecnologico e maturidade enterprise."],
  ["C-level", "Extraido dos contactos no CRM quando o cargo contem CEO, CTO, CIO, CFO, COO, Founder, Managing Director, Country Manager, Administrador, Partner ou Head of."],
  ["Numero de empregados", "Nao esta disponivel no snapshot do CRM; coluna mantida para enriquecimento posterior."],
  ["Validacao", "Nao substitui uma pesquisa externa/LinkedIn. Serve como triagem inicial para priorizar prospecao e enriquecimento."],
  ["Sinais LLM/GenAI", "+28 pontos quando ha LLM, GenAI, Copilot, RAG, agentic ou foundation models."],
  ["Sinais AI/ML", "+22 pontos por AI, ML, computer vision, NLP, chatbots ou intelligent automation."],
  ["Sinais Data/Analytics", "+18 pontos por data science, data engineering, analytics, BI, predictive, data governance ou synthetic data."],
  ["Sinais Microsoft", "+10 pontos quando ha Azure, Microsoft, Power Platform, Power BI, Dynamics, Teams, SharePoint, M365, Fabric, Synapse ou IAMCP."],
  ["Sinais complementares", "+5 a +12 pontos por automacao, cloud/software/produto, seguranca/risco, fit enterprise/setorial e servicos tecnologicos."],
];
methodology.getRange("A3:A15").format = { font: { bold: true }, fill: "#EAF2F8" };
methodology.getRange("A3:B15").format.wrapText = true;
methodology.getRange("A3:B15").format.borders = { preset: "all", style: "thin", color: "#D5DEE8" };
methodology.getRange("A:A").format.columnWidthPx = 230;
methodology.getRange("B:B").format.columnWidthPx = 760;

await fs.mkdir(outputDir, { recursive: true });

const preview = await workbook.render({ sheetName: "Resumo", autoCrop: "all", scale: 1, format: "png" });
await fs.writeFile(path.join(outputDir, "crm-ai-potential-preview.png"), new Uint8Array(await preview.arrayBuffer()));

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 50 },
  summary: "formula error scan",
});
console.log(errors.ndjson);

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(outputPath);
