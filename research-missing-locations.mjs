import { readFile, writeFile } from "node:fs/promises";

const cache = JSON.parse(await readFile("capsule-cache.json", "utf8"));
const missing = (cache.organisations || []).filter((org) => !String(org.city || "").trim() && !String(org.country || "").trim());

const paths = [
  "",
  "contact",
  "contacts",
  "contact-us",
  "contactos",
  "contacto",
  "about",
  "about-us",
  "sobre",
  "sobre-nos",
  "company",
  "offices",
  "locations",
  "privacy",
  "privacy-policy",
  "politica-de-privacidade",
  "terms",
  "terms-and-conditions",
  "termos-e-condicoes",
  "legal",
  "imprint",
  "impressum",
  "cookies",
];

const cityHints = [
  "Lisboa",
  "Lisbon",
  "Porto",
  "Oeiras",
  "Cascais",
  "Sintra",
  "Amadora",
  "Almada",
  "Braga",
  "Coimbra",
  "Aveiro",
  "Leiria",
  "Marinha Grande",
  "Funchal",
  "Ponta Delgada",
  "Madrid",
  "Barcelona",
  "London",
  "Cologne",
  "Köln",
  "Berlin",
  "Brussels",
  "Paris",
  "Dublin",
  "New York",
  "San Francisco",
  "São Paulo",
  "Rio de Janeiro",
  "Porto Alegre",
  "Portugal",
  "Germany",
  "Deutschland",
  "United Kingdom",
  "England",
  "Belgium",
  "Brazil",
  "Brasil",
  "Spain",
  "España",
];

function cleanHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function baseUrl(raw) {
  const url = new URL(raw);
  return `${url.protocol}//${url.host}/`;
}

function safeUrls(org) {
  if (!org.url) return [];
  try {
    const root = baseUrl(org.url);
    return paths.map((suffix) => new URL(suffix, root).toString());
  } catch {
    return [];
  }
}

function titleFrom(html) {
  return cleanHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
}

function extractJsonLd(html) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const results = [];
  for (const [, raw] of blocks) {
    try {
      const parsed = JSON.parse(raw.trim());
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const address = item.address || item.location?.address;
        if (address) results.push({ name: item.name || "", address });
      }
    } catch {
      // Ignore malformed structured data.
    }
  }
  return results;
}

function snippetsFor(text) {
  const patterns = [
    /\b\d{4}-\d{3}\b/g,
    /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi,
    /\b(address|morada|sede|headquarters|registered office|office|offices|visit us|contact us|contactos|impressum|legal notice)\b/gi,
    new RegExp(`\\b(${cityHints.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "gi"),
  ];
  const positions = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) positions.add(match.index || 0);
  }
  return [...positions]
    .sort((a, b) => a - b)
    .slice(0, 18)
    .map((position) => text.slice(Math.max(0, position - 180), position + 360))
    .filter((value, index, array) => array.indexOf(value) === index);
}

async function fetchPage(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 Codex location research",
      accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(15000),
  });
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !contentType.includes("text/html")) return null;
  const html = await response.text();
  const text = cleanHtml(html);
  const snippets = snippetsFor(text);
  const jsonLd = extractJsonLd(html);
  if (!snippets.length && !jsonLd.length) return null;
  return {
    requestedUrl: url,
    finalUrl: response.url,
    title: titleFrom(html),
    jsonLd,
    snippets,
  };
}

const organisations = [];
for (const org of missing) {
  const pages = [];
  const tried = new Set();
  for (const url of safeUrls(org)) {
    if (tried.has(url)) continue;
    tried.add(url);
    try {
      const page = await fetchPage(url);
      if (page) pages.push(page);
    } catch {
      // Keep trying likely pages.
    }
  }
  organisations.push({
    id: org.id,
    name: org.name,
    website: org.url,
    domains: org.domains || [],
    contacts: (org.contacts || []).map((contact) => contact.name),
    pages,
  });
}

const report = {
  generatedAt: new Date().toISOString(),
  count: organisations.length,
  organisations,
};

await writeFile("missing-location-research.json", JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({
  count: organisations.length,
  withEvidence: organisations.filter((org) => org.pages.length).length,
  report: "missing-location-research.json",
}, null, 2));
