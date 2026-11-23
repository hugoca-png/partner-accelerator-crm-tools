function escape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[char]);
}

function sourceLink(url, label) {
  return /^https:\/\//i.test(url || "")
    ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(label)}</a>`
    : "";
}

export const publicBriefCss = `
  .public-brief { border-top: 2px solid var(--teal); padding-top: 12px; }
  .public-brief-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .public-brief h2 { margin: 0; color: var(--navy); font-size: 16px; }
  .public-brief-date { color: var(--muted); font-size: 10px; white-space: nowrap; }
  .public-brief-summary { margin: 7px 0 10px; font-size: 12px; line-height: 1.48; }
  .microsoft-fit { border-left: 3px solid var(--teal); background: #f3faf9; padding: 10px 12px; }
  .microsoft-fit h2 { margin: 0 0 6px; color: var(--navy); font-size: 13px; }
  .microsoft-fit p { margin: 0; font-size: 11.5px; line-height: 1.5; }
  .microsoft-fit ul { margin: 0; padding-left: 18px; font-size: 11.5px; line-height: 1.45; }
  .microsoft-fit li + li { margin-top: 6px; }
  .microsoft-fit li { break-inside: avoid; }
  .microsoft-fit li strong { color: var(--navy); }
  .microsoft-fit ul + p { margin-top: 8px; }
  .microsoft-fit a { display: inline-block; margin-top: 5px; font-size: 9px; }
  .public-brief-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .public-brief h3 { margin: 0 0 5px; font-size: 11px; color: var(--navy); text-transform: uppercase; }
  .public-brief ul { margin: 0; padding-left: 16px; font-size: 10.5px; line-height: 1.38; }
  .public-brief li + li { margin-top: 5px; }
  .public-brief li { break-inside: avoid; }
  .public-brief-placeholder { color: var(--muted); list-style: none; margin-left: -16px; }
  .public-brief-note { margin: 9px 0 0; font-size: 10.5px; line-height: 1.4; }
  .public-brief-note strong { color: var(--navy); }
  .public-brief-sources { display: flex; flex-wrap: wrap; gap: 2px 9px; margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--line); color: var(--muted); font-size: 9px; line-height: 1.4; }
  .public-brief-warning { margin: 8px 0; padding: 7px 9px; border-left: 3px solid var(--gold); background: #fff9e8; font-size: 10.5px; }
  .public-brief-people { margin-top: 10px; }
  .public-brief-unregistered .section-title { margin-bottom: 9px; }
  .public-brief-people-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .public-brief-person { min-width: 0; border-left: 3px solid var(--teal); background: #f3faf9; }
  .public-brief-person.unregistered { border-color: #c15d46; background: #fff7f3; }
  .public-brief-person-body { min-width: 0; }
  .public-brief-person h3 { display: flex; flex-wrap: wrap; align-items: baseline; gap: 3px 7px; margin: 0; font-size: 12px; }
  .public-brief-person-status { color: var(--teal); font-size: 9px; font-weight: 700; }
  .public-brief-person.unregistered .public-brief-person-status { color: #a44330; }
  .public-brief-person .role { margin-top: 3px; }
  .public-brief-person a { display: inline-block; margin-top: 4px; font-size: 9px; }
  .public-brief-sources a { max-width: 100%; overflow-wrap: anywhere; }
  @media print {
    .public-brief p, .public-brief-grid > div, .public-brief-sources, .microsoft-fit, .public-brief-unregistered { break-inside: avoid; }
    .public-brief h2, .public-brief h3 { break-after: avoid; }
    .public-brief p, .microsoft-fit p { orphans: 3; widows: 3; }
  }
  @media (max-width: 650px) { .public-brief-grid, .public-brief-people-grid { grid-template-columns: 1fr; } }
`;

export function briefForOrganisation(org, researchedBrief) {
  if (researchedBrief?.summary) return researchedBrief;
  return {
    summary: String(org.description || "").trim() || "Sem descrição de atividade registada no CRM.",
    capabilities: [],
    recent: [],
    unknowns: "Atividade, notícias e dados públicos ainda não foram revistos para esta empresa.",
    researchStatus: "pending",
  };
}

export function onePagerFallback(org, { previous, curated, official, error } = {}) {
  const candidates = [
    [previous?.researchStatus === "openai-web" ? previous : null, "Mantido o último perfil web verificado."],
    [official, "Usados dados do website oficial."],
    [previous, "Mantidos os últimos dados públicos guardados."],
    [curated, "Usada a análise pública guardada."],
    [briefForOrganisation(org), "Usados apenas os dados do CRM."],
  ];
  const [brief, note] = candidates.find(([item]) => item?.summary);
  const reason = String(error?.message || "Pesquisa pública indisponível").slice(0, 180);
  return {
    ...brief,
    capabilities: brief.capabilities || [],
    recent: brief.recent || [],
    sources: brief.sources || [],
    researchWarning: `${reason} ${note}`,
  };
}

function nameParts(value) {
  return String(value || "").normalize("NFD").replace(/\p{M}/gu, "")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);
}

function firstLast(parts) {
  return parts.length >= 2 ? `${parts[0]}|${parts.at(-1)}` : "";
}

export function keyPeopleWithCrmStatus(people = [], contacts = []) {
  const publicNames = people.map((person) => nameParts(person.name));
  const crmNames = contacts.map((contact) => nameParts(contact.name));
  return people.map((person, index) => {
    const parts = publicNames[index];
    const exact = crmNames.some((candidate) => candidate.join(" ") === parts.join(" "));
    const shortName = firstLast(parts);
    const uniqueMatch = shortName
      && publicNames.filter((candidate) => firstLast(candidate) === shortName).length === 1
      && crmNames.filter((candidate) => firstLast(candidate) === shortName).length === 1;
    return { ...person, registered: Boolean(exact || uniqueMatch) };
  });
}
function renderKeyPeopleCards(brief, contacts, registered) {
  return keyPeopleWithCrmStatus(brief?.keyPeople || [], contacts)
    .filter((person) => person.registered === registered && person.name && person.role && /^https:\/\//i.test(person.sourceUrl || ""))
    .map((person) => `<article class="contact public-brief-person${registered ? "" : " unregistered"}">
      <div class="avatar fallback">${escape(nameParts(person.name).map((part) => part[0]).slice(0, 2).join("").toUpperCase())}</div>
      <div class="public-brief-person-body"><h3>${escape(person.name)}
        <span class="public-brief-person-status">${registered ? "registado no CRM" : "não registados"}</span></h3>
        <p class="role">${escape(person.role)}</p>${sourceLink(person.sourceUrl, "Fonte pública")}</div>
    </article>`).join("");
}

export function renderUnregisteredKeyPeople(brief, contacts = []) {
  const cards = renderKeyPeopleCards(brief, contacts, false);
  return cards ? `<section class="public-brief-unregistered">
    <h2 class="section-title">Pessoas-chave não registadas</h2>
    <div class="public-brief-people-grid">${cards}</div>
  </section>` : "";
}
export function renderPublicBrief(brief, contacts = []) {
  if (!brief?.summary) return "";
  const reviewedAt = /^\d{4}-\d{2}-\d{2}$/.test(brief.reviewedAt || "")
    ? brief.reviewedAt.split("-").reverse().join("/")
    : "";
  const checkedAt = /^\d{4}-\d{2}-\d{2}$/.test(brief.checkedAt || "")
    ? brief.checkedAt.split("-").reverse().join("/")
    : "";
  const capabilities = (brief.capabilities || [])
    .map((item) => `<li>${escape(item)}</li>`).join("");
  const recent = (brief.recent || [])
    .map((item) => `<li><strong>${escape(item.date)}</strong> · ${escape(item.text)} ${sourceLink(item.sourceUrl, "Fonte")}</li>`).join("");
  const sources = (brief.sources || [])
    .map((item) => sourceLink(item.url, item.label)).filter(Boolean).join("");
  return `<section class="public-brief">
    <div class="public-brief-head"><h2>Visão geral</h2>${checkedAt || reviewedAt ? `<span class="public-brief-date">Atualizado em ${escape(checkedAt || reviewedAt)}</span>` : ""}</div>
    <p class="public-brief-summary">${escape(brief.summary)}</p>
    <div class="public-brief-grid">
      <div><h3>Oferta e mercado</h3><ul>${capabilities || `<li class="public-brief-placeholder">Ainda sem análise pública verificada.</li>`}</ul></div>
      <div><h3>Sinais recentes</h3><ul>${recent || `<li class="public-brief-placeholder">Sem notícias verificadas para este one-pager.</li>`}</ul></div>
    </div>
    ${sources ? `<div class="public-brief-sources"><strong>Fontes: </strong>${sources}</div>` : ""}
  </section>`;
}

export function renderMicrosoftFit(brief) {
  const pathways = (brief?.microsoftPathways || [])
    .filter((item) => item?.name && item?.rationale)
    .map((item) => `<li><strong>Solutions Partner para ${escape(item.name)}</strong>: ${escape(item.rationale)}</li>`).join("");
  if (!pathways && !brief?.microsoftFit) return "";
  return `<section class="microsoft-fit">
    <h2>Enquadramento potencial no programa Microsoft</h2>
    ${pathways ? `<ul>${pathways}</ul>` : ""}
    ${brief.microsoftFit ? `<p>${escape(brief.microsoftFit)}</p>` : ""}
    ${sourceLink("https://learn.microsoft.com/en-us/partner-center/membership/introduction-to-pcs", "Percursos e designações Microsoft")}
  </section>`;
}
