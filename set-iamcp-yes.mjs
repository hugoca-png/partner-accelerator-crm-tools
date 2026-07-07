import { readFile, writeFile } from "node:fs/promises";

const FIELD_DEFINITION_ID = 960239;
const FIELD_NAME = "Membership active";
const FIELD_VALUE = "Yes";
const TARGETS = `
APR Management Solutions Lda.
ARMIS SISTEMAS DE INFORMAÇÃO LDA
ARQUICONSULT - Sistemas de Informação, S.A.
ARROWECS PORTUGAL - Soc. Unipessoal, Lda.
AXIANSEU - DIGITAL SOLUTIONS, S.A.
Balwurk Consulting & Technology Lda
BE-CLOUD
BI4ALL CONSULTORES DE GESTÃO LDA
BIND Soluções Inf., Design Web e Gráfico, Lda.
Bliss Applications, LDA
BLOOM CAST Consulting Lda.
BOLDINT SA
BRAVANTIC EVOLVING TECHNOLOGY SA
BRIGHT PARTNERS - GESTÃO TEC. E CAPITAL S.A.
Browser – Serviços Internet, SA
BUILDING BRIDGES - SOLUÇÕES DE PROD. LDA
CLARANET II SOLUTIONS, S.A.
CLEVERTI, Tecnologias e Inovação, Lda.
CLOSER CONSULTORIA LDA
CLOUD365 LDA
CLOUDCOMPUTING.PT, LDA
CPCECHO, LDA
CPCIT4ALL - Compª Port. Comput. Iniv. Tecnologia, Lda
CRAYON SOFTWARE LICENSING UNIPESSOAL LDA
CREATE IT, Int. e Desenvol. Sistemas Inf. Lda.
DEVSCOPE Soluções de Sistemas e Tecno. de Inf. SA
Everyday Software SL.
GIANTSTEP LDA
Glintt Global SA
inCentea Core, Lda
INFOS, Informática e Serviços S.A.
InnoWave Technologies, S.A.
ITSECTOR – SISTEMAS DE INFORMAÇÃO, S.A.
KNOWLEDGE INSIDE LDA
Latourrette Consulting - Cons. Inov. Gestão Inf. Lda.
LINKCOM - Sistemas de Informação, S.A.
Luza
Magic Beans
MAIN HUB – INNOVATION, INCUBATION & DEVELOPMENT, Lda.
MAKE THE SHIFT LDA
MOONGY, S.A.
MYPARTNER - Consultoria Informática, S.A.
NEXER Enterprise Applications Unipessoal Lda
NEXTBITT
NOESIS PORTUGAL - Consult. em Sist. Informáticos, SA
Openlimits – Business Solutions, S.A.
PONTUAL – IT Business Solutions, SA
Proside SA
Quidgest – Consultores de Gestão, SA
Rita Pedrosa Unipessoal Lda
SOFTSTORE, S.A.
TDSYNNEX
Tech - Avanade Portugal, Unipessoal, Lda
Timestamp - Sistemas de Informação, SA
TORPEDO - Serviços de Informática, Lda
UMN Lda
UNIPARTNER IT SERVICES, S.A.
Visionware Sistemas de Informação S.A.
V-VALLEY ADV. SOLUTIONS PORTUGAL, UNIP. LDA
WARPCOM SERVICES, S.A.
Wegenblock Lda
XOLYD IBERICA LDA.
XPAND Solutions - Informática e Novas Tecnologias, Lda.
Bluetribe, Lda
N4IT, Lda
`;

const APPLY = process.argv.includes("--apply");

const ALIASES = new Map([
  ["APR Management Solutions Lda.", "APR - Technology Solutions"],
  ["ARMIS SISTEMAS DE INFORMAÇÃO LDA", "ARMIS Group"],
  ["ARROWECS PORTUGAL - Soc. Unipessoal, Lda.", "Arrow ECS Portugal"],
  ["AXIANSEU - DIGITAL SOLUTIONS, S.A.", "Axians Portugal"],
  ["Balwurk Consulting & Technology Lda", "Balwurk - Cyber Security Consulting Services"],
  ["BE-CLOUD", "Be-CSP Portugal"],
  ["BIND Soluções Inf., Design Web e Gráfico, Lda.", "BindTuning"],
  ["BLOOM CAST Consulting Lda.", "BloomCast Consulting"],
  ["BOLDINT SA", "Devoteam"],
  ["CLEVERTI, Tecnologias e Inovação, Lda.", "99x Portugal"],
  ["CLOSER CONSULTORIA LDA", "Closer Consulting"],
  ["CLOUDCOMPUTING.PT, LDA", "Cloudcomputing"],
  ["CRAYON SOFTWARE LICENSING UNIPESSOAL LDA", "SoftwareOne"],
  ["GIANTSTEP LDA", "Gstep"],
  ["Latourrette Consulting - Cons. Inov. Gestão Inf. Lda.", "Latourrette.ai"],
  ["LINKCOM - Sistemas de Informação, S.A.", "Linkcom"],
  ["Magic Beans", "MagicBeans"],
  ["MAKE THE SHIFT LDA", "SHIFT Management Consulting"],
  ["TDSYNNEX", "TD SYNNEX North America"],
  ["UMN Lda", "UMN - AI, Data & Automation Solutions"],
  ["XPAND Solutions - Informática e Novas Tecnologias, Lda.", "Xpand IT"],
]);

const env = await readFile(".env", "utf8");
const token = env.match(/^CAPSULE_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("CAPSULE_TOKEN não encontrado.");

function cleanText(value) {
  return String(value || "").trim();
}

function normalize(value) {
  return cleanText(value)
    .toLocaleLowerCase("pt-PT")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " e ")
    .replace(/[ªº]/g, "")
    .replace(/[^\p{L}\p{N}.]+/gu, " ")
    .replace(/\b(companhia|comp|port|portugal|sociedade|soc|unipessoal|unip|lda|ltda|sa|s\.a|s\.a\.|sl|l\.da|limitada)\b/g, " ")
    .replace(/\b(sistemas?|informacao|informatica|consultoria|consultores?|gestao|solucoes?|servicos?|tecnologias?|technology|digital|solutions?|business|software)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function exactNormalize(value) {
  return cleanText(value)
    .toLocaleLowerCase("pt-PT")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " e ")
    .replace(/[ªº]/g, "")
    .replace(/[^\p{L}\p{N}.]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value) {
  return normalize(value).split(" ").filter((token) => token.length > 1);
}

function jaccard(a, b) {
  const left = new Set(tokens(a));
  const right = new Set(tokens(b));
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((item) => right.has(item)).length;
  const union = new Set([...left, ...right]).size;
  return intersection / union;
}

function acronym(value) {
  return normalize(value)
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .join("");
}

async function capsuleFetch(path, options = {}) {
  const url = path.startsWith("http") ? path : `https://api.capsulecrm.com/api/v2${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return {
    data: response.status === 204 ? null : await response.json(),
    link: response.headers.get("link") || "",
  };
}

function nextLink(linkHeader) {
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/i);
  return match ? match[1] : null;
}

async function fetchOrganisations() {
  let url = "/parties?perPage=100&embed=fields,tags";
  const organisations = [];
  while (url) {
    const { data, link } = await capsuleFetch(url);
    organisations.push(...(data.parties || []).filter((party) => party.type === "organisation"));
    url = nextLink(link);
  }
  return organisations;
}

function iamcpValue(org) {
  const field = (org.fields || []).find((item) => item.definition?.id === FIELD_DEFINITION_ID || item.definition?.name === FIELD_NAME);
  return {
    id: field?.id || null,
    value: field?.value || "",
  };
}

function findMatch(target, organisations) {
  const alias = ALIASES.get(target);
  if (alias) {
    const aliasMatches = organisations.filter((org) => exactNormalize(org.name) === exactNormalize(alias));
    if (aliasMatches.length === 1) return { status: "matched", method: "alias", org: aliasMatches[0], score: 1 };
    if (aliasMatches.length > 1) return { status: "ambiguous", method: "alias", candidates: aliasMatches };
  }

  const targetExact = exactNormalize(target);
  const targetNorm = normalize(target);
  const targetAcronym = acronym(target);

  const exact = organisations.filter((org) => exactNormalize(org.name) === targetExact);
  if (exact.length === 1) return { status: "matched", method: "exact", org: exact[0], score: 1 };
  if (exact.length > 1) return { status: "ambiguous", method: "exact", candidates: exact };

  const normalized = organisations.filter((org) => normalize(org.name) === targetNorm);
  if (normalized.length === 1) return { status: "matched", method: "normalized", org: normalized[0], score: 0.98 };
  if (normalized.length > 1) return { status: "ambiguous", method: "normalized", candidates: normalized };

  const candidates = organisations
    .map((org) => ({
      org,
      score: Math.max(
        jaccard(target, org.name),
        targetNorm && normalize(org.name).includes(targetNorm) ? 0.92 : 0,
        normalize(org.name) && targetNorm.includes(normalize(org.name)) ? 0.9 : 0,
        targetAcronym.length >= 3 && acronym(org.name) === targetAcronym ? 0.88 : 0,
      ),
    }))
    .filter((item) => item.score >= 0.72)
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) return { status: "unmatched", candidates: [] };
  if (candidates.length === 1 || candidates[0].score - candidates[1].score >= 0.12) {
    return { status: "matched", method: "fuzzy", org: candidates[0].org, score: candidates[0].score };
  }
  return { status: "ambiguous", method: "fuzzy", candidates: candidates.slice(0, 5).map((item) => item.org) };
}

async function updateOrg(org) {
  const current = iamcpValue(org);
  const fieldPayload = current.id
    ? { id: current.id, value: FIELD_VALUE }
    : { definition: { id: FIELD_DEFINITION_ID }, value: FIELD_VALUE };
  const { data } = await capsuleFetch(`/parties/${org.id}?embed=fields,tags`, {
    method: "PUT",
    body: JSON.stringify({ party: { fields: [fieldPayload] } }),
  });
  return data.party;
}

const targets = TARGETS.split(/\r?\n/).map(cleanText).filter(Boolean);
const organisations = await fetchOrganisations();
const matched = [];
const ambiguous = [];
const unmatched = [];

for (const target of targets) {
  const result = findMatch(target, organisations);
  if (result.status === "matched") {
    const current = iamcpValue(result.org);
    matched.push({
      target,
      id: result.org.id,
      crmName: result.org.name,
      method: result.method,
      score: Number(result.score.toFixed(2)),
      currentValue: current.value || "(vazio)",
      fieldValueId: current.id,
      action: current.value === FIELD_VALUE ? "already_yes" : "set_yes",
    });
  } else if (result.status === "ambiguous") {
    ambiguous.push({
      target,
      candidates: result.candidates.map((org) => ({ id: org.id, name: org.name, currentValue: iamcpValue(org).value || "(vazio)" })),
    });
  } else {
    unmatched.push({ target });
  }
}

const report = {
  mode: APPLY ? "apply" : "dry-run",
  requested: targets.length,
  matched: matched.length,
  toUpdate: matched.filter((item) => item.action === "set_yes").length,
  alreadyYes: matched.filter((item) => item.action === "already_yes").length,
  ambiguous: ambiguous.length,
  unmatched: unmatched.length,
  matchedItems: matched,
  ambiguousItems: ambiguous,
  unmatchedItems: unmatched,
  updatedItems: [],
};

if (APPLY) {
  if (ambiguous.length) {
    throw new Error(`Aplicação interrompida: ${ambiguous.length} ambíguos.`);
  }
  for (const item of matched.filter((entry) => entry.action === "set_yes")) {
    const org = organisations.find((candidate) => String(candidate.id) === String(item.id));
    try {
      const updated = await updateOrg(org);
      report.updatedItems.push({
        id: updated.id,
        name: updated.name,
        value: iamcpValue(updated).value,
        status: "updated",
      });
    } catch (error) {
      report.updatedItems.push({
        id: item.id,
        name: item.crmName,
        status: "error",
        error: error.message || String(error),
      });
    }
  }
}

await writeFile("iamcp-yes-report.json", JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({
  mode: report.mode,
  requested: report.requested,
  matched: report.matched,
  toUpdate: report.toUpdate,
  alreadyYes: report.alreadyYes,
  ambiguous: report.ambiguous,
  unmatched: report.unmatched,
  report: "iamcp-yes-report.json",
}, null, 2));
