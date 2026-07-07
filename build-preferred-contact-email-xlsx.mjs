import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const root = process.cwd();
const outputDir = path.join(root, "outputs");
const outputPath = path.join(outputDir, "preferred-contact-email-audit.xlsx");
const cache = JSON.parse(await fs.readFile(path.join(root, "capsule-cache.json"), "utf8"));

const personalDomains = new Set([
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "hotmail.pt",
  "outlook.com",
  "outlook.pt",
  "live.com",
  "live.pt",
  "msn.com",
  "sapo.pt",
  "yahoo.com",
  "yahoo.pt",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "fastmail.com",
]);

const genericPrefixes = new Set(["geral", "info", "contacto", "contact", "hello", "admin", "office", "sales"]);

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function emailDomain(email) {
  return clean(email).toLocaleLowerCase("pt-PT").split("@")[1]?.replace(/^www\./i, "") || "";
}

function baseDomain(domain) {
  const parts = clean(domain).toLocaleLowerCase("pt-PT").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const twoLevelTlds = new Set(["co.uk", "com.br", "com.au"]);
  const lastTwo = parts.slice(-2).join(".");
  if (twoLevelTlds.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join(".");
  return lastTwo;
}

function compactToken(value) {
  return clean(value)
    .toLocaleLowerCase("pt-PT")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function isCurrentCompanyEmail(email, org) {
  const domain = emailDomain(email);
  if (!domain || !org) return false;
  const domains = (org.domains || []).map((item) => clean(item).toLocaleLowerCase("pt-PT")).filter(Boolean);
  if (domains.includes(domain)) return true;
  if (domains.some((item) => baseDomain(item) === baseDomain(domain))) return true;
  const emailToken = compactToken(baseDomain(domain).split(".")[0]);
  if (emailToken.length < 4) return false;
  const orgTokens = [org.name, org.url, ...domains].map(compactToken).filter(Boolean);
  return orgTokens.some((token) => token.includes(emailToken) || emailToken.includes(token));
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function genericCompanyEmails(org) {
  return unique([...(org.genericEmails || []), ...(org.emails || [])])
    .filter((email) => {
      const prefix = clean(email).split("@")[0].toLocaleLowerCase("pt-PT");
      return genericPrefixes.has(prefix) && isCurrentCompanyEmail(email, org);
    });
}

function chooseEmail(org, person) {
  const emails = unique(person.emails || []).map((email) => email.toLocaleLowerCase("pt-PT"));
  const company = emails.filter((email) => isCurrentCompanyEmail(email, org));
  if (company.length) {
    return {
      selectedEmail: company[0],
      selectionType: "Profissional próprio",
      selectionRank: 1,
      confidence: "alta",
      note: "Email da pessoa coincide com o domínio da empresa atual.",
    };
  }

  const orgGeneric = genericCompanyEmails(org);
  if (orgGeneric.length) {
    return {
      selectedEmail: orgGeneric[0],
      selectionType: "Genérico da empresa",
      selectionRank: 2,
      confidence: "media",
      note: "Pessoa sem email próprio profissional; usar email geral da empresa.",
    };
  }

  const professionalOther = emails.filter((email) => {
    const domain = emailDomain(email);
    return domain && !personalDomains.has(domain);
  });
  if (professionalOther.length) {
    return {
      selectedEmail: professionalOther[0],
      selectionType: "Profissional externo/rever",
      selectionRank: 3,
      confidence: "baixa",
      note: "Email profissional, mas domínio não coincide com a empresa atual. Rever antes de usar.",
    };
  }

  const personal = emails.filter((email) => personalDomains.has(emailDomain(email)));
  if (personal.length) {
    return {
      selectedEmail: personal[0],
      selectionType: "Pessoal fallback",
      selectionRank: 4,
      confidence: "baixa",
      note: "Sem opção profissional; email pessoal apenas como último recurso.",
    };
  }

  return {
    selectedEmail: "",
    selectionType: "Sem email",
    selectionRank: 5,
    confidence: "baixa",
    note: "Contacto sem email utilizável.",
  };
}

const rows = [];
for (const org of cache.organisations || []) {
  for (const person of org.contacts || []) {
    const choice = chooseEmail(org, person);
    const allEmails = unique(person.emails || []);
    const currentCompanyEmails = allEmails.filter((email) => isCurrentCompanyEmail(email, org));
    const personalEmails = allEmails.filter((email) => personalDomains.has(emailDomain(email)));
    const externalEmails = allEmails.filter((email) => emailDomain(email) && !personalDomains.has(emailDomain(email)) && !isCurrentCompanyEmail(email, org));
    rows.push({
      empresa: clean(org.name),
      pessoa: clean(person.name),
      cargo: unique(person.jobTitles || []).join("; "),
      cidade: clean(org.city),
      pais: clean(org.country),
      dominiosEmpresa: unique(org.domains || []).join("; "),
      emailEscolhido: choice.selectedEmail,
      tipo: choice.selectionType,
      confianca: choice.confidence,
      nota: choice.note,
      emailsProfissionaisEmpresa: currentCompanyEmails.join("; "),
      emailsPessoais: personalEmails.join("; "),
      emailsExternosRever: externalEmails.join("; "),
      todosEmails: allEmails.join("; "),
      tagsPessoa: unique([...(person.tags || []), ...(person.dataTags || [])]).join("; "),
      tagsEmpresa: unique([...(org.tags || []), ...(org.dataTags || [])]).join("; "),
      sortRank: choice.selectionRank,
    });
  }
}

rows.sort((a, b) => a.sortRank - b.sortRank || a.empresa.localeCompare(b.empresa, "pt-PT") || a.pessoa.localeCompare(b.pessoa, "pt-PT"));

const summary = [
  ["Métrica", "Valor"],
  ["Empresas", cache.organisationCount || (cache.organisations || []).length],
  ["Pessoas", cache.personCount || rows.length],
  ["Contactos com email profissional próprio", rows.filter((row) => row.tipo === "Profissional próprio").length],
  ["Contactos com email genérico da empresa", rows.filter((row) => row.tipo === "Genérico da empresa").length],
  ["Contactos com email profissional externo a rever", rows.filter((row) => row.tipo === "Profissional externo/rever").length],
  ["Contactos só com email pessoal fallback", rows.filter((row) => row.tipo === "Pessoal fallback").length],
  ["Contactos sem email", rows.filter((row) => row.tipo === "Sem email").length],
  ["Gerado em", new Date().toISOString()],
  ["Cache CRM", cache.refreshedAt || ""],
];

const detailHeaders = [
  "Empresa",
  "Pessoa",
  "Cargo",
  "Cidade",
  "País",
  "Domínios empresa",
  "Email escolhido",
  "Tipo",
  "Confiança",
  "Nota",
  "Emails profissionais da empresa",
  "Emails pessoais",
  "Emails externos/rever",
  "Todos os emails no CRM",
  "Tags pessoa",
  "Tags empresa",
];

const detailValues = rows.map((row) => [
  row.empresa,
  row.pessoa,
  row.cargo,
  row.cidade,
  row.pais,
  row.dominiosEmpresa,
  row.emailEscolhido,
  row.tipo,
  row.confianca,
  row.nota,
  row.emailsProfissionaisEmpresa,
  row.emailsPessoais,
  row.emailsExternosRever,
  row.todosEmails,
  row.tagsPessoa,
  row.tagsEmpresa,
]);

const exceptions = rows
  .filter((row) => row.tipo !== "Profissional próprio")
  .map((row) => [
    row.empresa,
    row.pessoa,
    row.emailEscolhido,
    row.tipo,
    row.confianca,
    row.nota,
    row.todosEmails,
  ]);

const workbook = Workbook.create();
workbook.worksheets.add("Resumo");
workbook.worksheets.add("Contactos");
workbook.worksheets.add("Revisão");

await workbook.apply([
  { op: "range.values.set", target: { sheet: "Resumo", range: "A1:B1" }, values: [["Auditoria de email preferencial", ""]] },
  { op: "range.merge", target: { sheet: "Resumo", range: "A1:B1" } },
  { op: "range.values.set", target: { sheet: "Resumo", range: `A3:B${summary.length + 2}` }, values: summary },
  { op: "range.values.set", target: { sheet: "Contactos", range: "A1:P1" }, values: [detailHeaders] },
  { op: "range.values.set", target: { sheet: "Contactos", range: `A2:P${detailValues.length + 1}` }, values: detailValues },
  { op: "range.values.set", target: { sheet: "Revisão", range: "A1:G1" }, values: [["Empresa", "Pessoa", "Email escolhido", "Tipo", "Confiança", "Nota", "Todos os emails no CRM"]] },
  { op: "range.values.set", target: { sheet: "Revisão", range: `A2:G${exceptions.length + 1}` }, values: exceptions },
  { op: "table.add", props: { range: { sheet: "Contactos", range: `A1:P${detailValues.length + 1}` }, hasHeaders: true, name: "ContactosEmailPreferencial" } },
  { op: "table.add", props: { range: { sheet: "Revisão", range: `A1:G${exceptions.length + 1}` }, hasHeaders: true, name: "ContactosRevisaoEmail" } },
  { op: "range.format.set", target: { sheet: "Resumo", range: "A1:B1" }, props: { fill: "#1f4e78", font: { bold: true, color: "#ffffff", size: 16 } } },
  { op: "range.format.set", target: { sheet: "Resumo", range: `A3:A${summary.length + 2}` }, props: { font: { bold: true }, fill: "#dbeafe" } },
  { op: "range.format.set", target: { sheet: "Contactos", range: "A1:P1" }, props: { fill: "#1f4e78", font: { bold: true, color: "#ffffff" } } },
  { op: "range.format.set", target: { sheet: "Revisão", range: "A1:G1" }, props: { fill: "#1f4e78", font: { bold: true, color: "#ffffff" } } },
  { op: "range.format.set", target: { sheet: "Contactos", range: `A1:P${detailValues.length + 1}` }, props: { font: { name: "Aptos", size: 10 }, verticalAlignment: "top", wrapText: true } },
  { op: "range.format.set", target: { sheet: "Revisão", range: `A1:G${exceptions.length + 1}` }, props: { font: { name: "Aptos", size: 10 }, verticalAlignment: "top", wrapText: true } },
]);

await fs.mkdir(outputDir, { recursive: true });
const summaryInspect = await workbook.inspect({
  kind: "table",
  range: "Resumo!A1:B12",
  include: "values",
  tableMaxRows: 12,
  tableMaxCols: 2,
});
const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 100 },
  summary: "formula error scan",
});
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);

console.log(JSON.stringify({
  output: outputPath,
  rows: rows.length,
  summary: Object.fromEntries(summary.slice(1, 8)),
  inspected: Boolean(summaryInspect?.ndjson),
  formulaErrors: errors?.matches?.length || 0,
}, null, 2));
