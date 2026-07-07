import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const root = process.cwd();
const cachePath = path.join(root, "capsule-cache.json");
const externalPath = path.join(root, "external-descriptions.json");
const planPath = path.join(root, "crm-enrichment-update-plan.json");
const outputDir = path.join(root, "outputs");
const outputPath = path.join(outputDir, "crm-activity-sector-classification.xlsx");

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

const cache = JSON.parse(await fs.readFile(cachePath, "utf8"));
const externalPayload = await readJsonIfExists(externalPath, { results: [] });
const planPayload = await readJsonIfExists(planPath, { rows: [] });
const organisations = cache.organisations || [];

const externalById = new Map((externalPayload.results || []).map((item) => [String(item.id), item]));
const planById = new Map((planPayload.rows || []).map((item) => [String(item.id), item]));

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function strip(value) {
  return clean(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase();
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function locationFor(org) {
  return unique([org.city, org.country]).join(", ");
}

function descriptionFor(org, plan, external) {
  if (clean(plan?.description)) return clean(plan.description);
  if (clean(external?.externalDescription)) return clean(external.externalDescription);
  const tags = unique([...(org.tags || []), ...(org.dataTags || []), ...(org.filterTags || []), ...(org.filterDataTags || [])]);
  return tags.length ? `Sinais CRM: ${tags.join(", ")}.` : "Descricao insuficiente no CRM; requer enriquecimento externo.";
}

function textFor(org, description) {
  return strip([
    org.name,
    org.url,
    org.city,
    org.country,
    description,
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
  ].join(" "));
}

function sectorTextFor(org, description) {
  return strip([
    org.name,
    org.url,
    org.city,
    org.country,
    description,
    ...(org.domains || []),
  ].join(" "));
}

const sectors = [
  {
    sector: "Saude e Life Sciences",
    sub: "Saude, hospitais, clinicas, farmacia, biotech, medical devices ou bem-estar",
    re: /\b(health|saude|hospital|clinic|clinica|pharma|farmaceutica|biotech|life sciences|medical|medico|patient|paciente|wellbeing|bem-estar|elderly|senior care|cuidados|emeis)\b/i,
  },
  {
    sector: "Industria e Manufacturing",
    sub: "Producao industrial, engenharia, fabricacao, automacao industrial ou bens fisicos",
    re: /\b(industry|industrial|manufacturing|manufactura|fabricacao|factory|fabrica|engineering|engenharia|automation industrial|automacao industrial|electronics|eletronica|mechanical|mecanica|materials|materiais|packaging|impressao|printing|production|producao)\b/i,
  },
  {
    sector: "Energia, Ambiente e Sustentabilidade",
    sub: "Energia, renovaveis, mobilidade eletrica, sustentabilidade, ambiente ou utilities",
    re: /\b(energy|energia|renewable|renovavel|solar|wind|eolica|electric|eletrico|battery|bateria|sustainability|sustentabilidade|environment|ambiente|waste|residuos|water|agua|utilities|clean energy|emissions|emissoes)\b/i,
  },
  {
    sector: "Transportes, Logistica e Mobilidade",
    sub: "Transportes, logistica, supply chain, mobilidade, shipping ou frota",
    re: /\b(transport|transporte|logistics|logistica|supply chain|shipping|fleet|frota|mobility|mobilidade|vehicle|veiculo|rail|metro|aviation|aero|maritime|maersk|cold chain)\b/i,
  },
  {
    sector: "Servicos Financeiros e Seguros",
    sub: "Banca, pagamentos, seguros, fintech, investimento ou risco financeiro",
    re: /\b(bank|banco|banking|banca|finance|financial|financeiro|fintech|payment|pagamento|insurance|seguro|investment|investimento|asset management|credit|credito|risk|risco financeiro|aml|fraud|fraude)\b/i,
  },
  {
    sector: "Retalho, E-commerce e Consumo",
    sub: "Retalho, comercio, e-commerce, marcas de consumo, turismo ou restauracao",
    re: /\b(retail|retalho|commerce|comercio|e-commerce|ecommerce|store|loja|consumer|consumo|brand|marca|tourism|turismo|hotel|hospitality|restaurante|food|alimentar|fashion|moda|marketplace)\b/i,
  },
  {
    sector: "Educacao, Investigacao e Conhecimento",
    sub: "Educacao, universidades, investigacao, formacao tecnica ou conhecimento",
    re: /\b(education|educacao|university|universidade|school|escola|research|investigacao|academy|academia|learning|training|formacao|knowledge|conhecimento|certification|certificacao)\b/i,
  },
  {
    sector: "Setor Publico, Associativo e Institucional",
    sub: "Administracao publica, municipios, associacoes, instituicoes ou organismos",
    re: /\b(public sector|setor publico|municipio|municipal|government|governo|associacao|association|institution|instituicao|fundacao|foundation|agency|agencia publica|authority|autoridade)\b/i,
  },
  {
    sector: "Media, Criatividade e Conteudos",
    sub: "Media, conteudos, design, audiovisual, jogos, publicidade ou experiencias digitais",
    re: /\b(media|content|conteudo|creative|criatividade|design|audiovisual|video|games|gaming|studio|estudio|advertising|publicidade|brand experience|ux|ui|digital agency)\b/i,
  },
  {
    sector: "Imobiliario, Construcao e Infraestruturas Fisicas",
    sub: "Construcao, imobiliario, arquitetura, facilities ou infraestruturas fisicas",
    re: /\b(real estate|imobiliario|construction|construcao|architecture|arquitetura|facility|facilities|building|edificio|infrastructure fisica|civil engineering|engenharia civil)\b/i,
  },
  {
    sector: "Distribuicao e Canal Tecnologico",
    sub: "Distribuicao, revenda, licenciamento, canal e grossistas de tecnologia",
    re: /\b(distributor|distribuidor|distribution|distribuicao|reseller|revenda|licensing|licenciamento|software licensing|channel|canal|tdsynnex|v-valley|crayon|softwareone)\b/i,
  },
  {
    sector: "Tecnologia e Software",
    sub: "Software, IT services, dados, cloud, ciberseguranca, integracao ou produtos digitais",
    re: /\b(software|saas|it services|tecnologias de informacao|information technology|sistemas de informacao|cloud|azure|data analytics|business intelligence|power bi|artificial intelligence|inteligencia artificial|machine learning|cybersecurity|ciberseguranca|devops|api|systems integration|integracao de sistemas|digital solutions|solucoes digitais|erp|crm|dynamics|power platform|web development|mobile development|managed it services|outsourcing tecnologico|technology solutions|solucoes tecnologicas|digital services|servicos digitais|sap|salesforce)\b/i,
  },
  {
    sector: "Consultoria e Servicos Profissionais",
    sub: "Consultoria de gestao, estrategia, processos, recursos humanos ou servicos B2B",
    re: /\b(consulting|consultoria|advisory|strategy|estrategia|management consulting|gestao|business consulting|recursos humanos|human resources|coaching|training|formacao|legal|law|accounting|auditoria|marketing agency|communication agency|agencia)\b/i,
  },
];

const techSignals = [
  { label: "Microsoft", re: /\b(microsoft|azure|dynamics|power platform|power bi|fabric|m365|office 365|teams|sharepoint|copilot|iamcp)\b/i },
  { label: "AI/Data", re: /\b(ai|artificial intelligence|inteligencia artificial|machine learning|llm|genai|data|analytics|business intelligence|power bi)\b/i },
  { label: "Cloud/Infra", re: /\b(cloud|azure|aws|infrastructure|infraestrutura|devops|kubernetes|managed services)\b/i },
  { label: "Cybersecurity", re: /\b(cyber|ciber|security|seguranca|identity|compliance|privacy)\b/i },
  { label: "Software", re: /\b(software|app|api|integration|sistemas|systems|development|desenvolvimento)\b/i },
];

function classifySector(text) {
  const scored = sectors.map((sector, index) => {
    const globalRe = new RegExp(sector.re.source, sector.re.flags.includes("g") ? sector.re.flags : `${sector.re.flags}g`);
    const matches = [...text.matchAll(globalRe)];
    return { ...sector, index, score: matches.length };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const top = scored[0];
  if (!top || top.score === 0) {
    return {
      sector: "Nao classificado",
      subsector: "Informacao insuficiente",
      confidence: "baixa",
      notes: "Sem sinais suficientes no CRM ou nas descricoes existentes.",
    };
  }
  const close = scored.filter((item) => item.score > 0 && item.sector !== top.sector && item.score >= top.score * 0.7);
  return {
    sector: top.sector,
    subsector: top.sub,
    confidence: top.score >= 3 ? "alta" : top.score >= 2 ? "media" : "baixa",
    notes: close.length ? `Possivel setor alternativo: ${close.map((item) => item.sector).join(", ")}.` : "",
  };
}

function techAffinity(text, sector) {
  const signals = techSignals.filter((signal) => signal.re.test(text)).map((signal) => signal.label);
  let level = "Baixa";
  if (signals.length >= 3 || sector === "Tecnologia e Software") level = "Alta";
  else if (signals.length >= 1) level = "Media";
  return { level, signals: signals.join(", ") };
}

function cLevelsFor(org) {
  const re = /\b(ceo|chief|cto|cio|cfo|coo|cmo|founder|co-founder|managing director|general manager|country manager|director geral|administrador|president|presidente|partner|socio|socia|head of|vp|vice president)\b/i;
  return unique(
    (org.contacts || [])
      .filter((contact) => (contact.jobTitles || []).some((title) => re.test(title)))
      .map((contact) => {
        const titles = unique(contact.jobTitles || []);
        return `${clean(contact.name)}${titles.length ? ` (${titles.join("; ")})` : ""}`;
      }),
  ).join(" | ");
}

const rows = organisations.map((org) => {
  const plan = planById.get(String(org.id));
  const external = externalById.get(String(org.id));
  const description = descriptionFor(org, plan, external);
  const text = textFor(org, description);
  const sector = classifySector(sectorTextFor(org, description));
  const tech = techAffinity(text, sector.sector);
  const source = plan ? "Descricao enriquecida/CRM" : clean(external?.externalDescription) ? "Descricao externa existente" : "CRM";
  return {
    id: String(org.id),
    name: clean(org.name),
    sector: sector.sector,
    subsector: sector.subsector,
    confidence: sector.confidence,
    flag: sector.confidence === "baixa" ? "REVER" : "",
    techAffinity: tech.level,
    techSignals: tech.signals,
    location: locationFor(org),
    city: clean(org.city),
    country: clean(org.country),
    website: clean(org.url),
    contacts: (org.contacts || []).length,
    cLevels: cLevelsFor(org) || "Nao identificado no CRM",
    currentTags: unique([...(org.tags || []), ...(org.dataTags || [])]).join(", "),
    description,
    source,
    sourceUrl: clean(plan?.sourceUrl) || clean(external?.sourceUrl) || clean(org.url),
    recommendedCrmField: "Campo customizado/Data tag: Area de atividade",
    recommendedCampaignTag: sector.sector === "Nao classificado" ? "Atividade: A rever" : `Atividade: ${sector.sector}`,
    notes: sector.notes || (sector.confidence === "baixa" ? "Validar manualmente antes de atualizar CRM." : ""),
  };
});

rows.sort((a, b) => a.sector.localeCompare(b.sector, "pt-PT") || a.name.localeCompare(b.name, "pt-PT"));

const countBy = (field) => {
  const map = new Map();
  for (const row of rows) map.set(row[field], (map.get(row[field]) || 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt-PT"));
};

const sectorCounts = countBy("sector");
const confidenceCounts = countBy("confidence");
const techCounts = countBy("techAffinity");

const workbook = Workbook.create();
const summary = workbook.worksheets.add("Resumo");
const detail = workbook.worksheets.add("Classificacao");
const model = workbook.worksheets.add("Modelo CRM");
for (const sheet of [summary, detail, model]) sheet.showGridLines = false;

summary.getRange("A1:H1").values = [["Classificacao por area de atividade", "", "", "", "", "", "", ""]];
summary.getRange("A1:H1").merge();
summary.getRange("A1").format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF", size: 16 } };
summary.getRange("A3:B8").values = [
  ["Empresas classificadas", rows.length],
  ["Snapshot CRM", clean(cache.refreshedAt)],
  ["Setores identificados", sectorCounts.filter(([name]) => name !== "Nao classificado").length],
  ["A rever", rows.filter((row) => row.confidence === "baixa").length],
  ["Afinidade tech alta", rows.filter((row) => row.techAffinity === "Alta").length],
  ["Nao tecnologia", rows.filter((row) => row.sector !== "Tecnologia e Software").length],
];
summary.getRange("A3:A8").format = { font: { bold: true }, fill: "#EAF2F8" };
summary.getRange("A3:B8").format.borders = { preset: "all", style: "thin", color: "#D5DEE8" };
summary.getRangeByIndexes(2, 3, sectorCounts.length + 1, 2).values = [["Area de atividade", "Empresas"], ...sectorCounts];
summary.getRangeByIndexes(2, 3, 1, 2).format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF" } };
summary.getRangeByIndexes(2, 3, sectorCounts.length + 1, 2).format.borders = { preset: "all", style: "thin", color: "#D5DEE8" };
const chart = summary.charts.add("bar", summary.getRangeByIndexes(2, 3, sectorCounts.length + 1, 2));
chart.title = "Empresas por area de atividade";
chart.hasLegend = false;
chart.setPosition("G3", "N24");

const secondBlockRow = 13;
summary.getRangeByIndexes(secondBlockRow, 0, confidenceCounts.length + 1, 2).values = [["Confianca", "Empresas"], ...confidenceCounts];
summary.getRangeByIndexes(secondBlockRow, 0, 1, 2).format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF" } };
summary.getRangeByIndexes(secondBlockRow, 0, confidenceCounts.length + 1, 2).format.borders = { preset: "all", style: "thin", color: "#D5DEE8" };
summary.getRangeByIndexes(secondBlockRow, 3, techCounts.length + 1, 2).values = [["Afinidade tecnologica", "Empresas"], ...techCounts];
summary.getRangeByIndexes(secondBlockRow, 3, 1, 2).format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF" } };
summary.getRangeByIndexes(secondBlockRow, 3, techCounts.length + 1, 2).format.borders = { preset: "all", style: "thin", color: "#D5DEE8" };
summary.getRange("A:A").format.columnWidthPx = 230;
summary.getRange("B:B").format.columnWidthPx = 130;
summary.getRange("D:D").format.columnWidthPx = 310;
summary.getRange("E:E").format.columnWidthPx = 120;

const headers = [
  "Capsule ID",
  "Empresa",
  "Area de atividade",
  "Subarea / criterio",
  "Confianca",
  "Flag",
  "Afinidade tecnologica",
  "Sinais tecnologicos",
  "Localizacao",
  "Cidade",
  "Pais",
  "Website",
  "Contactos",
  "C-level identificados",
  "Tags/Data-tags atuais",
  "Descricao usada",
  "Fonte",
  "URL fonte",
  "Campo CRM recomendado",
  "Tag campanha sugerida",
  "Atualizar CRM?",
  "Notas",
];
detail.getRange("A1:V1").values = [headers];
detail.getRangeByIndexes(1, 0, rows.length, headers.length).values = rows.map((row) => [
  row.id,
  row.name,
  row.sector,
  row.subsector,
  row.confidence,
  row.flag,
  row.techAffinity,
  row.techSignals,
  row.location,
  row.city,
  row.country,
  row.website,
  row.contacts,
  row.cLevels,
  row.currentTags,
  row.description,
  row.source,
  row.sourceUrl,
  row.recommendedCrmField,
  row.recommendedCampaignTag,
  "",
  row.notes,
]);
detail.tables.add(`A1:V${rows.length + 1}`, true, "ActivitySectorClassification").style = "TableStyleMedium2";
detail.freezePanes.freezeRows(1);
detail.getRange("A1:V1").format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF" } };
detail.getRange(`A1:V${rows.length + 1}`).format.wrapText = true;
detail.getRange("A:A").format.columnWidthPx = 100;
detail.getRange("B:B").format.columnWidthPx = 230;
detail.getRange("C:D").format.columnWidthPx = 260;
detail.getRange("E:F").format.columnWidthPx = 90;
detail.getRange("G:H").format.columnWidthPx = 170;
detail.getRange("I:K").format.columnWidthPx = 140;
detail.getRange("L:L").format.columnWidthPx = 230;
detail.getRange("M:M").format.columnWidthPx = 90;
detail.getRange("N:N").format.columnWidthPx = 360;
detail.getRange("O:O").format.columnWidthPx = 250;
detail.getRange("P:P").format.columnWidthPx = 560;
detail.getRange("Q:R").format.columnWidthPx = 190;
detail.getRange("S:T").format.columnWidthPx = 240;
detail.getRange("U:U").format.columnWidthPx = 110;
detail.getRange("V:V").format.columnWidthPx = 260;
detail.getRange(`F2:F${rows.length + 1}`).conditionalFormats.add("containsText", {
  text: "REVER",
  format: { fill: "#DC2626", font: { bold: true, color: "#FFFFFF" } },
});
detail.getRange(`U2:U${rows.length + 1}`).dataValidation = {
  rule: { type: "list", values: ["Sim", "Nao", "Rever"] },
};

model.getRange("A1:C1").values = [["Campo", "Recomendacao", "Notas"]];
model.getRange("A1:C1").format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF" } };
model.getRange("A2:C9").values = [
  ["Area de atividade", "Campo customizado/Data tag controlado", "Esta deve ser a classificacao principal: tecnologia, saude, industria, energia, logistica, etc."],
  ["Subarea / criterio", "Campo de texto ou lista secundaria", "Explica a razao da classificacao e ajuda revisao humana."],
  ["Afinidade tecnologica", "Campo separado", "Nao confundir setor real da empresa com interesse tecnologico ou uso de Microsoft/AI."],
  ["Tags de campanha", "Tags com prefixo Atividade:", "Criar apenas depois de validares a taxonomia, para segmentacao de newsletters."],
  ["Confianca", "Campo operacional", "Permite atualizar CRM apenas nas classificacoes alta/media."],
  ["Regra de escrita", "Atualizar apenas linhas com Atualizar CRM? = Sim", "Evita gravar inferencias fracas."],
  ["Nao classificado", "Revisao manual", "Pode exigir website/descricoes externas adicionais."],
  ["Tecnologia", "Nao assumir por defeito", "Uma empresa so deve ser tecnologia se a atividade principal for produto/servico tecnologico."],
];
model.getRange("A:C").format.wrapText = true;
model.getRange("A:A").format.columnWidthPx = 210;
model.getRange("B:B").format.columnWidthPx = 310;
model.getRange("C:C").format.columnWidthPx = 620;
model.getRange("A1:C9").format.borders = { preset: "all", style: "thin", color: "#D5DEE8" };

await fs.mkdir(outputDir, { recursive: true });
const preview = await workbook.render({ sheetName: "Resumo", autoCrop: "all", scale: 1, format: "png" });
await fs.writeFile(path.join(outputDir, "crm-activity-sector-classification-preview.png"), new Uint8Array(await preview.arrayBuffer()));
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);

console.log(JSON.stringify({
  outputPath,
  organisations: rows.length,
  sectors: Object.fromEntries(sectorCounts),
  confidence: Object.fromEntries(confidenceCounts),
  techAffinity: Object.fromEntries(techCounts),
}, null, 2));
