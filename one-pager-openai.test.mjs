import test from "node:test";
import assert from "node:assert/strict";
import { researchOrganisationWithOpenAI } from "./one-pager-openai.mjs";

const org = { name: "Example Co", url: "https://example.com", city: "Lisboa", country: "Portugal" };

test("accepts only sources returned by web search", async () => {
  const draft = {
    identityVerified: true,
    summary: "Empresa de software. ".repeat(60),
    capabilities: ["Desenvolvimento de software."],
    recent: [
      { date: "2026-10-01", text: "Novo produto.", sourceUrl: "https://example.com/news" },
      { date: "2026-09-01", text: "Inventado.", sourceUrl: "https://other.example/news" },
    ],
    assessment: "Potencial de colaboração.",
    unknowns: "Faturação não confirmada.",
    microsoftFit: "Alinhamento potencial com Data & AI (Azure); não confirma designação obtida.",
    microsoftPathways: [
      { name: "Data & AI (Azure)", rationale: "Power BI e Fabric." },
      { name: "Invented designation", rationale: "Sem base." },
    ],
    keyPeople: [
      { name: "Maria Costa", role: "Co-founder", sourceUrl: "https://example.com/news" },
      { name: "João Silva", role: "CEO", sourceUrl: "https://other.example/news" },
      { name: "Ana Lopes", role: "Cloud Architect", sourceUrl: "https://example.com/news" },
    ],
    sources: [
      { label: "Website", url: "https://example.com/news" },
      { label: "Desconhecido", url: "https://other.example/news" },
    ],
  };
  const brief = await researchOrganisationWithOpenAI(org, {
    apiKey: "mock-key",
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.tools[0].type, "web_search");
      assert.equal(request.store, false);
      assert.equal(request.input[1].content.includes("Example Co"), true);
      return {
        ok: true,
        json: async () => ({
          output: [
            { type: "web_search_call", action: { sources: [{ url: "https://example.com/news", title: "Official news" }] } },
            { type: "message", content: [{ type: "output_text", text: JSON.stringify(draft) }] },
          ],
        }),
      };
    },
  });
  assert.equal(brief.researchStatus, "openai-web");
  assert.deepEqual(brief.sources.map((item) => item.url), ["https://example.com/news"]);
  assert.deepEqual(brief.recent.map((item) => item.text), ["Novo produto."]);
  assert.equal(brief.summary, draft.summary.trim());
  assert.equal(brief.microsoftFit, draft.microsoftFit);
  assert.deepEqual(brief.microsoftPathways, [{ name: "Data & AI (Azure)", rationale: "Power BI e Fabric." }]);
  assert.deepEqual(brief.keyPeople.map((person) => person.name), ["Maria Costa"]);
});

test("reports confirmed credit exhaustion without exposing the key", async () => {
  await assert.rejects(
    researchOrganisationWithOpenAI(org, {
      apiKey: "mock-key",
      fetchImpl: async () => ({
        ok: false, status: 429,
        json: async () => ({ error: { type: "insufficient_quota", code: "credit_balance_exhausted" } }),
      }),
    }),
    (error) => error.status === 429 && error.code === "credit_balance_exhausted"
      && /créditos esgotado/.test(error.message) && !error.message.includes("mock-key"),
  );
});

test("retries a temporary rate limit once without calling it exhausted credits", async () => {
  let calls = 0;
  await assert.rejects(
    researchOrganisationWithOpenAI(org, {
      apiKey: "mock-key",
      fetchImpl: async () => {
        calls++;
        return {
          ok: false, status: 429, headers: { get: () => "0" },
          json: async () => ({ error: { type: "rate_limit_error", code: "rate_limit_exceeded" } }),
        };
      },
    }),
    (error) => error.status === 429 && /limite temporário/.test(error.message)
      && !/créditos/.test(error.message),
  );
  assert.equal(calls, 2);
});


test("rejects a namesake without an official-domain citation", async () => {
  const draft = {
    identityVerified: true,
    summary: "Another company.",
    capabilities: [],
    recent: [],
    assessment: "",
    unknowns: "",
    keyPeople: [],
    microsoftFit: "",
    microsoftPathways: [],
    sources: [{ label: "Namesake", url: "https://other.example/news" }],
  };
  await assert.rejects(researchOrganisationWithOpenAI(org, {
    apiKey: "mock-key",
    officialBrief: { summary: "Example Co software.", sources: [{ label: "Official", url: "https://example.com/" }] },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        output: [
          { type: "web_search_call", action: { sources: [{ url: "https://other.example/news" }] } },
          { type: "message", content: [{ type: "output_text", text: JSON.stringify(draft) }] },
        ],
      }),
    }),
  }), /website oficial/);
});
