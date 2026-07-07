import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const root = process.cwd();
const cache = JSON.parse(await fs.readFile(path.join(root, "capsule-cache.json"), "utf8"));
const outputDir = path.join(root, "outputs");
const outputPath = path.join(outputDir, "missing-country-location-remaining.xlsx");

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

const proposals = [
  ["285187202", "Amplemarket HQ", "San Francisco", "United States", "media", "Empresa global/SaaS; nome no CRM indica HQ. Validar se deve usar HQ global ou presenca portuguesa.", "https://amplemarket.com/"],
  ["285203847", "Apex Ahead", "", "", "baixa", "Sem sinais suficientes no CRM nem resultado publico fiavel. Requer validacao manual.", "http://www.apexahead.com/"],
  ["285248653", "Bee Engineering ICT", "Lisboa", "Portugal", "media", "Dominio .pt e marca portuguesa; validar morada exata.", "http://www.bee-eng.pt/"],
  ["285150896", "Between Dialogues", "", "", "baixa", "Sem website/dominio no CRM. Requer pesquisa manual.", ""],
  ["285203816", "BizTarget", "", "", "baixa", "Dominio .com generico; sem evidencia suficiente para cidade/pais.", "http://www.biztarget.com/"],
  ["285227491", "BizTastic", "", "", "baixa", "Dominio .eu generico; sem evidencia suficiente para cidade/pais.", "http://www.biztastic.eu/"],
  ["285080342", "Brighten Consulting", "Lisboa", "Portugal", "alta", "Website oficial mostra localizacao no Polo Tecnologico de Lisboa, Rua Cupertino de Miranda.", "https://brightenconsulting.com/"],
  ["285138662", "Building Creative Machines", "Lisboa", "Portugal", "media", "Marca/website apontam para ecossistema criativo/tecnologico portugues; validar morada.", "http://www.buildingcreativemachines.com/"],
  ["284991053", "C.Inov", "", "Portugal", "baixa", "Nome sugere entidade portuguesa, mas falta website/dominio para cidade.", ""],
  ["284974483", "Comudel", "", "Portugal", "baixa", "Sem fonte suficiente para cidade; proposta de pais baseada em contexto CRM/Portugal.", "http://www.comudel.com/"],
  ["284942252", "CyberInspect", "Lisboa", "Portugal", "media", "Empresa associada ao contexto portugues; validar morada oficial.", "http://www.cyberinspect.com/"],
  ["285200018", "Cyient", "Hyderabad", "India", "alta", "Multinacional Cyient com sede global em Hyderabad. Validar se no CRM se pretende sede global ou contacto local.", "https://www.cyient.com/"],
  ["285287962", "Dynargie Portugal", "Lisboa", "Portugal", "media", "Nome contem Portugal e dominio .pt; validar cidade/morada oficial.", "http://www.dynargie.pt/"],
  ["285143981", "Emeis", "Paris", "France", "alta", "Grupo internacional de cuidados/saude com sede em Franca; validar unidade local se existir.", "https://emeis.com/"],
  ["285204020", "ENDIPREV", "Matosinhos", "Portugal", "alta", "Empresa portuguesa de energia/eolica conhecida por sede na zona do Porto/Matosinhos.", "https://www.endiprev.com/"],
  ["285080332", "ENDVR Sports", "Montreal", "Canada", "media", "ENDVR e uma empresa/produto associado ao Canada; validar entidade juridica correta.", "http://endvrsports.com/"],
  ["284991047", "GoTuk", "Lisboa", "Portugal", "media", "Dominio .pt e atividade turistica local; validar morada.", "http://www.gotuk.pt/"],
  ["285080139", "IN2ACTION - Engaging People & Business", "Lisboa", "Portugal", "media", "Dominio .pt e contexto portugues; validar cidade/morada.", "http://www.in2action.pt/"],
  ["285227336", "Indico Capital Partners", "Lisboa", "Portugal", "alta", "Fundo de VC portugues com presenca conhecida em Lisboa.", "http://www.indicocapital.com/"],
  ["285203936", "INFORM GmbH - Optimization Software", "Aachen", "Germany", "alta", "GmbH alema; sede conhecida em Aachen.", "http://www.inform-software.com/"],
  ["285282406", "Ireland Portugal Business Network", "Lisboa", "Portugal", "media", "Rede bilateral Ireland-Portugal; para CRM portugues sugere-se Lisboa/Portugal. Validar se preferem Dublin/Ireland.", "http://www.ireland-portugal.com/"],
  ["285200055", "LBC", "Lisboa", "Portugal", "media", "LBC Global associada a consultoria portuguesa; validar morada.", "http://lbc-global.com/"],
  ["285195485", "OutSystems", "Lisboa", "Portugal", "media", "Empresa fundada em Portugal com grande presenca em Lisboa; sede global tambem associada aos EUA. Validar criterio CRM.", "https://www.outsystems.com/"],
  ["285022075", "PEPData", "", "Portugal", "baixa", "Contexto CRM/Portugal, mas sem evidencia suficiente para cidade.", "http://www.pepdata.com/"],
  ["285186520", "Popdigit", "Lisboa", "Portugal", "media", "Dominio/empresa digital associada a Portugal; validar morada.", "http://www.popdigit.com/"],
  ["285138815", "Promethean", "Blackburn", "United Kingdom", "alta", "Promethean World e historicamente sediada em Blackburn, UK. Validar entidade local se aplicavel.", "http://prometheanworld.com/"],
  ["285203949", "Remote", "San Francisco", "United States", "media", "Empresa remote-first/global; sede/entidade principal frequentemente associada aos EUA. Validar criterio CRM.", "https://www.remote.com/"],
  ["284985752", "Soko", "", "", "baixa", "Sem sinais publicos suficientes a partir do CRM; requer validacao manual.", "https://www.soko.fyi/"],
  ["285281441", "StandOUT Technologies", "", "Portugal", "baixa", "Possivel empresa portuguesa/tecnologica; falta evidencia para cidade.", "http://www.standout-tech.com/"],
  ["285011300", "Strativae", "", "", "baixa", "Sem website/dominio no CRM. Requer pesquisa manual.", ""],
  ["285227330", "SYSPHERA", "", "Portugal", "baixa", "Nome/website sugerem empresa portuguesa, mas falta evidencia para cidade.", "http://www.sysphera.com/"],
  ["285049282", "Ten Twenty One", "", "Portugal", "baixa", "Possivel empresa portuguesa; website .io nao confirma cidade/pais.", "http://tentwentyone.io/en/"],
  ["285249797", "The Original Music Book", "", "", "baixa", "Sem evidencia suficiente para cidade/pais.", "http://www.theoriginalmusicbook.com/"],
  ["285199858", "ThePrePlan", "", "", "baixa", "Sem evidencia suficiente para cidade/pais.", "http://www.thepreplan.com/"],
  ["285203696", "UCO Network", "", "", "baixa", "Sem evidencia suficiente para cidade/pais.", "https://www.uco.network/"],
  ["285150919", "Vex Tech", "", "Portugal", "baixa", "Dominio .pt confirma sinal portugues, mas falta cidade.", "http://www.vextech.pt/"],
  ["285203889", "VIGION GROUP", "", "", "baixa", "Sem evidencia suficiente para cidade/pais.", "http://www.vigiongroup.com/"],
  ["285274318", "WFBS", "", "Portugal", "baixa", "Dominio .pt confirma sinal portugues, mas falta cidade.", "http://www.wfbs.pt/"],
  ["285204300", "Zetes Goods ID", "Brussels", "Belgium", "alta", "Zetes e grupo belga; validar se existe entidade local a usar.", "http://www.zetes.com/"],
];

const byId = new Map((cache.organisations || []).map((org) => [String(org.id), org]));
const rows = proposals
  .filter(([id]) => {
    const org = byId.get(String(id)) || {};
    return !clean(org.country);
  })
  .map(([id, name, suggestedCity, suggestedCountry, confidence, rationale, sourceUrl]) => {
  const org = byId.get(String(id)) || {};
  return {
    id,
    name: clean(org.name) || name,
    currentCity: clean(org.city),
    currentCountry: clean(org.country),
    suggestedCity,
    suggestedCountry,
    confidence,
    action: confidence === "alta" || confidence === "media" ? "Candidato a atualizar" : "Rever manualmente",
    rationale,
    sourceUrl: sourceUrl || clean(org.url),
    crmUrl: clean(org.url),
    domains: (org.domains || []).join(", "),
    contacts: (org.contacts || []).length,
    tags: [...(org.tags || []), ...(org.dataTags || [])].join(", "),
  };
});

const missingNow = (cache.organisations || []).filter((org) => !clean(org.country));
const expectedIds = new Set(proposals.map(([id]) => String(id)));
const notCovered = missingNow.filter((org) => !expectedIds.has(String(org.id)));
if (notCovered.length) {
  for (const org of notCovered) {
    rows.push({
      id: String(org.id),
      name: clean(org.name),
      currentCity: clean(org.city),
      currentCountry: clean(org.country),
      suggestedCity: "",
      suggestedCountry: "",
      confidence: "baixa",
      action: "Rever manualmente",
      rationale: "Nao estava coberta na tabela de propostas.",
      sourceUrl: clean(org.url),
      crmUrl: clean(org.url),
      domains: (org.domains || []).join(", "),
      contacts: (org.contacts || []).length,
      tags: [...(org.tags || []), ...(org.dataTags || [])].join(", "),
    });
  }
}

rows.sort((a, b) => {
  const order = { alta: 0, media: 1, baixa: 2 };
  return (order[a.confidence] ?? 9) - (order[b.confidence] ?? 9) || a.name.localeCompare(b.name, "pt-PT");
});

const workbook = Workbook.create();
const summary = workbook.worksheets.add("Resumo");
const detail = workbook.worksheets.add("Propostas");
const methodology = workbook.worksheets.add("Criterios");
for (const sheet of [summary, detail, methodology]) sheet.showGridLines = false;

const count = (predicate) => rows.filter(predicate).length;
summary.getRange("A1:E1").values = [["Empresas sem pais - analise de cidade/pais", "", "", "", ""]];
summary.getRange("A1:E1").merge();
summary.getRange("A1").format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF", size: 16 } };
summary.getRange("A3:B11").values = [
  ["Snapshot CRM", clean(cache.refreshedAt)],
  ["Organizacoes no CRM", cache.organisationCount || (cache.organisations || []).length],
  ["Empresas sem pais", missingNow.length],
  ["Propostas cobertas", rows.length],
  ["Confianca alta", count((row) => row.confidence === "alta")],
  ["Confianca media", count((row) => row.confidence === "media")],
  ["Confianca baixa / rever", count((row) => row.confidence === "baixa")],
  ["Candidatas a atualizar", count((row) => row.action === "Candidato a atualizar")],
  ["Revisao manual", count((row) => row.action === "Rever manualmente")],
];
summary.getRange("A3:A11").format = { font: { bold: true }, fill: "#EAF2F8" };
summary.getRange("A3:B11").format.borders = { preset: "all", style: "thin", color: "#D5DEE8" };
summary.getRange("A:A").format.columnWidthPx = 230;
summary.getRange("B:B").format.columnWidthPx = 180;

const headers = [
  "Capsule ID",
  "Empresa",
  "Cidade atual",
  "Pais atual",
  "Cidade sugerida",
  "Pais sugerido",
  "Confianca",
  "Acao sugerida",
  "Criterio / nota",
  "Fonte",
  "Website CRM",
  "Dominios",
  "Contactos",
  "Tags/Data-tags",
  "Atualizar CRM?",
];
detail.getRange("A1:O1").values = [headers];
detail.getRangeByIndexes(1, 0, rows.length, headers.length).values = rows.map((row) => [
  row.id,
  row.name,
  row.currentCity,
  row.currentCountry,
  row.suggestedCity,
  row.suggestedCountry,
  row.confidence,
  row.action,
  row.rationale,
  row.sourceUrl,
  row.crmUrl,
  row.domains,
  row.contacts,
  row.tags,
  "",
]);
detail.tables.add(`A1:O${rows.length + 1}`, true, "MissingCountryLocationAnalysis").style = "TableStyleMedium2";
detail.freezePanes.freezeRows(1);
detail.getRange("A1:O1").format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF" } };
detail.getRange(`A1:O${rows.length + 1}`).format.wrapText = true;
detail.getRange("A:A").format.columnWidthPx = 100;
detail.getRange("B:B").format.columnWidthPx = 240;
detail.getRange("C:F").format.columnWidthPx = 130;
detail.getRange("G:H").format.columnWidthPx = 135;
detail.getRange("I:I").format.columnWidthPx = 520;
detail.getRange("J:K").format.columnWidthPx = 250;
detail.getRange("L:L").format.columnWidthPx = 180;
detail.getRange("M:M").format.columnWidthPx = 80;
detail.getRange("N:N").format.columnWidthPx = 160;
detail.getRange("O:O").format.columnWidthPx = 110;
detail.getRange(`G2:G${rows.length + 1}`).conditionalFormats.add("containsText", {
  text: "baixa",
  format: { fill: "#FEE2E2", font: { bold: true, color: "#991B1B" } },
});
detail.getRange(`O2:O${rows.length + 1}`).dataValidation = {
  rule: { type: "list", values: ["Sim", "Nao", "Rever"] },
};

methodology.getRange("A1:B1").values = [["Criterio", "Descricao"]];
methodology.getRange("A1:B1").format = { fill: "#12354A", font: { bold: true, color: "#FFFFFF" } };
methodology.getRange("A2:B8").values = [
  ["Alta", "Fonte publica forte ou sede global amplamente conhecida. Ainda assim, validar se o CRM deve usar sede global ou entidade local."],
  ["Media", "Sinais fortes por dominio/nome/contexto, mas sem morada oficial confirmada nesta ronda."],
  ["Baixa", "Nao atualizar automaticamente. Requer pesquisa manual ou confirmacao junto da empresa."],
  ["Pais por .pt", "Dominio .pt e contexto portugues foram usados apenas como sinal, normalmente com confianca baixa/media."],
  ["Multinacionais", "Em empresas globais, a proposta pode ser HQ global; se o CRM for usado para parceiros locais, validar escritorio portugues."],
  ["Regra de escrita", "Atualizar no CRM apenas linhas com Atualizar CRM? = Sim."],
  ["Sem escrita no CRM", "Este ficheiro e apenas uma proposta de analise; nao altera o Capsule."],
];
methodology.getRange("A:B").format.wrapText = true;
methodology.getRange("A:A").format.columnWidthPx = 180;
methodology.getRange("B:B").format.columnWidthPx = 760;
methodology.getRange("A1:B8").format.borders = { preset: "all", style: "thin", color: "#D5DEE8" };

await fs.mkdir(outputDir, { recursive: true });
const preview = await workbook.render({ sheetName: "Resumo", autoCrop: "all", scale: 1, format: "png" });
await fs.writeFile(path.join(outputDir, "missing-country-location-remaining-preview.png"), new Uint8Array(await preview.arrayBuffer()));
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);

console.log(JSON.stringify({
  outputPath,
  missingCountry: missingNow.length,
  rows: rows.length,
  high: count((row) => row.confidence === "alta"),
  medium: count((row) => row.confidence === "media"),
  low: count((row) => row.confidence === "baixa"),
  candidates: count((row) => row.action === "Candidato a atualizar"),
}, null, 2));
