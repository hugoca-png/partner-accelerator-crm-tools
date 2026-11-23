import test from "node:test";
import assert from "node:assert/strict";
import { keyPeopleWithCrmStatus, onePagerFallback, publicBriefCss, renderPublicBrief, renderMicrosoftFit, renderUnregisteredKeyPeople } from "./one-pager-brief.mjs";

test("matches accents and unique first/last names against CRM contacts", () => {
  const people = [
    { name: "Goncalo Sousa", role: "Co-founder", sourceUrl: "https://example.com/goncalo" },
    { name: "José Manuel Calheiros", role: "CEO", sourceUrl: "https://example.com/jose" },
    { name: "Ana Costa", role: "CTO", sourceUrl: "https://example.com/ana" },
  ];
  const contacts = [{ name: "Gonçalo Sousa" }, { name: "José Calheiros" }];
  assert.deepEqual(keyPeopleWithCrmStatus(people, contacts).map((item) => item.registered), [true, true, false]);
});

test("does not merge ambiguous first/last names", () => {
  const people = [{ name: "Ana Costa", role: "CEO", sourceUrl: "https://example.com/ana" }];
  const contacts = [{ name: "Ana Maria Costa" }, { name: "Ana Joana Costa" }];
  assert.equal(keyPeopleWithCrmStatus(people, contacts)[0].registered, false);
});
test("does not treat unrelated unique names as CRM matches", () => {
  const people = [{ name: "Ana Costa", role: "CEO", sourceUrl: "https://example.com/ana" }];
  const contacts = [{ name: "Joao Silva" }];
  assert.equal(keyPeopleWithCrmStatus(people, contacts)[0].registered, false);
});


test("separates unregistered key people from the CRM section", () => {
  const brief = {
    summary: "Resumo",
    capabilities: [],
    recent: [],
    keyPeople: [
      { name: "Goncalo Sousa", role: "Co-founder", sourceUrl: "https://example.com/goncalo" },
      { name: "Ana Costa", role: "CTO", sourceUrl: "https://example.com/ana" },
    ],
  };
  const contacts = [{ name: "Gonçalo Sousa" }];
  const overview = renderPublicBrief(brief, contacts);
  const unregistered = renderUnregisteredKeyPeople(brief, contacts);
  assert.doesNotMatch(overview, /public-brief-person/);
  assert.doesNotMatch(overview, /Ana Costa/);
  assert.match(unregistered, /Pessoas-chave não registadas/);
  assert.match(unregistered, /class="contact public-brief-person unregistered"/);
  assert.doesNotMatch(unregistered, /Goncalo Sousa/);
  assert.match(unregistered, /public-brief-people-grid/);
  assert.match(publicBriefCss, /public-brief-sources \{ display: flex; flex-wrap: wrap;/);
  assert.match(unregistered, /não registados/);
  assert.match(unregistered, /https:\/\/example.com\/ana/);
});

test("keeps research notes out of the company overview and labels Microsoft fit as potential", () => {
  const brief = {
    summary: "Consultora de dados.",
    capabilities: [],
    recent: [],
    assessment: "Processo de análise.",
    unknowns: "Não confirmado.",
    microsoftFit: "Potencial Data & AI (Azure).",
    microsoftPathways: [
      { name: "Data & AI (Azure)", rationale: "Power BI e Fabric." },
      { name: "Digital & App Innovation (Azure)", rationale: "Automação." },
    ],
  };
  assert.doesNotMatch(renderPublicBrief(brief), /Processo de análise|Não confirmado/);
  assert.match(renderMicrosoftFit(brief), /Enquadramento potencial no programa Microsoft/);
  assert.match(renderMicrosoftFit(brief), /Potencial Data &amp; AI \(Azure\)/);
  assert.match(renderMicrosoftFit(brief), /<ul>/);
  assert.match(renderMicrosoftFit(brief), /<strong>Solutions Partner para Data &amp; AI \(Azure\)<\/strong>/);
  assert.match(renderMicrosoftFit(brief), /<strong>Solutions Partner para Digital &amp; App Innovation \(Azure\)<\/strong>/);
});

test("one-pager fallback prefers a verified cached profile, then official, curated and CRM data", () => {
  const org = { name: "Exemplo", description: "Descrição CRM." };
  const previous = { summary: "Perfil verificado.", researchStatus: "openai-web" };
  const official = { summary: "Website oficial.", researchStatus: "official-site" };
  const curated = { summary: "Análise guardada." };
  const error = new Error("OpenAI indisponível");
  const cached = onePagerFallback(org, { previous, official, curated, error });
  assert.equal(cached.summary, "Perfil verificado.");
  assert.match(cached.researchWarning, /último perfil web verificado/);
  assert.deepEqual(cached.recent, []);
  assert.equal(onePagerFallback(org, { official, curated, error }).summary, "Website oficial.");
  assert.equal(onePagerFallback(org, { curated, error }).summary, "Análise guardada.");
  const crm = onePagerFallback(org, { error });
  assert.equal(crm.summary, "Descrição CRM.");
  assert.match(crm.researchWarning, /apenas os dados do CRM/);
});
