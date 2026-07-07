import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const cachePath = path.join(root, "capsule-cache.json");
const outputPath = path.join(root, "external-descriptions.json");
const data = JSON.parse(await fs.readFile(cachePath, "utf8"));
const organisations = data.organisations || [];

const userAgent =
  "Mozilla/5.0 (compatible; PartnerAcceleratorEnrichment/1.0; +https://partner-accelerator.capsulecrm.com)";

function clean(value) {
  let text = String(value || "");
  if (/[ÃÂâ€]/.test(text)) {
    try {
      const repaired = Buffer.from(text, "latin1").toString("utf8");
      if ((repaired.match(/[çãõáéíóúâêôà]/gi) || []).length > (text.match(/[çãõáéíóúâêôà]/gi) || []).length) {
        text = repaired;
      }
    } catch {
      // Keep original text if repair fails.
    }
  }
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function extractMeta(html, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re1 = new RegExp(`<meta\\b[^>]*(?:name|property)=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i");
    const re2 = new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*(?:name|property)=["']${escaped}["'][^>]*>`, "i");
    const match = html.match(re1) || html.match(re2);
    if (match?.[1]) return clean(match[1]);
  }
  return "";
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? clean(match[1]) : "";
}

function stripHtml(html) {
  return clean(
    html
      .replace(/<header[\s\S]*?<\/header>/gi, " ")
      .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " "),
  );
}

function meaningfulTextDescription(html) {
  const text = stripHtml(html)
    .replace(/\b(cookie|cookies|privacy policy|política de privacidade|termos e condições|all rights reserved|todos os direitos reservados)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";

  const keywordRe =
    /\b(ai|artificial intelligence|inteligência artificial|data|dados|analytics|business intelligence|software|cloud|microsoft|azure|cyber|security|consulting|consultoria|solutions|soluções|technology|tecnologia|digital|automation|automação|outsourcing|nearshore|product|produto|platform|plataforma|infrastructure|infraestrutura)\b/i;
  const chunks = text
    .split(/(?<=[.!?])\s+|\s{2,}/)
    .map((chunk) => clean(chunk))
    .filter((chunk) => chunk.length >= 45 && chunk.length <= 420);

  const selected = chunks.filter((chunk) => keywordRe.test(chunk)).slice(0, 3);
  const fallback = chunks.slice(0, 2);
  const description = (selected.length ? selected : fallback).join(" ");
  return description.slice(0, 900);
}

function aboutLinks(html, baseUrl) {
  const links = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html))) {
    const href = clean(match[1]);
    const label = clean(match[2]);
    const haystack = `${href} ${label}`;
    if (!/\b(about|sobre|quem-somos|quem somos|company|empresa|what-we-do|o-que-fazemos|services|servi[cç]os|solutions|solu[cç][oõ]es)\b/i.test(haystack)) {
      continue;
    }
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    try {
      const url = new URL(href, baseUrl);
      if (url.origin === new URL(baseUrl).origin) links.push(url.href);
    } catch {
      // Ignore invalid links.
    }
  }
  return [...new Set(links)].slice(0, 3);
}

function extractJsonLdDescription(html) {
  const scripts = html.match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const script of scripts) {
    const body = script.replace(/^<script\b[^>]*>/i, "").replace(/<\/script>$/i, "");
    try {
      const parsed = JSON.parse(body);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const description = item?.description || item?.["@graph"]?.find?.((entry) => entry.description)?.description;
        if (description) return clean(description);
      }
    } catch {
      // Ignore malformed JSON-LD.
    }
  }
  return "";
}

function bestDescription(html) {
  const candidates = [
    extractMeta(html, ["og:description"]),
    extractMeta(html, ["description"]),
    extractMeta(html, ["twitter:description"]),
    extractJsonLdDescription(html),
    meaningfulTextDescription(html),
  ].filter(Boolean);
  const description = candidates.find((candidate) => candidate.length >= 50) || candidates[0] || "";
  return description.slice(0, 900);
}

async function fetchWithTimeout(url, timeoutMs = 6500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": userAgent,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    const contentType = response.headers.get("content-type") || "";
    const text = contentType.includes("text") || contentType.includes("html") ? await response.text() : "";
    return { ok: response.ok, status: response.status, finalUrl: response.url, html: text, contentType };
  } finally {
    clearTimeout(timeout);
  }
}

async function enrichOrg(org) {
  const url = normalizeUrl(org.url);
  if (!url) {
    return {
      id: org.id,
      name: org.name,
      status: "no_url",
      sourceUrl: "",
      title: "",
      externalDescription: "",
      confidence: "baixa",
      error: "Empresa sem URL no CRM",
    };
  }

  try {
    const result = await fetchWithTimeout(url);
    const title = extractTitle(result.html);
    let description = bestDescription(result.html);
    let sourceUrl = result.finalUrl || url;
    let sourceType = description ? "website_homepage" : "";

    if (description.length < 90) {
      for (const aboutUrl of aboutLinks(result.html, sourceUrl)) {
        try {
          const about = await fetchWithTimeout(aboutUrl, 5500);
          const aboutDescription = bestDescription(about.html);
          if (aboutDescription.length > description.length) {
            description = aboutDescription;
            sourceUrl = about.finalUrl || aboutUrl;
            sourceType = "website_about_or_services";
          }
          if (description.length >= 120) break;
        } catch {
          // Keep homepage description if about page fails.
        }
      }
    }

    const confidence = description.length >= 120 ? "alta" : description.length >= 70 ? "média" : "baixa";
    return {
      id: org.id,
      name: org.name,
      status: result.ok ? "ok" : `http_${result.status}`,
      sourceUrl,
      sourceType,
      title,
      externalDescription: description,
      confidence,
      error: description ? "" : "Sem descrição pública detetada nos metadados",
    };
  } catch (error) {
    return {
      id: org.id,
      name: org.name,
      status: "fetch_error",
      sourceUrl: url,
      title: "",
      externalDescription: "",
      confidence: "baixa",
      error: error?.name === "AbortError" ? "Timeout ao contactar website" : String(error?.message || error),
    };
  }
}

const results = [];
const concurrency = 14;
let index = 0;
let lastSave = Date.now();

async function saveProgress() {
  const sorted = [...results].sort((a, b) => String(a.name).localeCompare(String(b.name), "pt-PT"));
  await fs.writeFile(
    outputPath,
    JSON.stringify(
      {
        refreshedAt: new Date().toISOString(),
        source: "Company websites from Capsule CRM URLs",
        total: sorted.length,
        expectedTotal: organisations.length,
        ok: sorted.filter((item) => item.externalDescription).length,
        partial: sorted.length < organisations.length,
        results: sorted,
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function worker() {
  while (index < organisations.length) {
    const current = organisations[index++];
    const enriched = await enrichOrg(current);
    results.push(enriched);
    if (Date.now() - lastSave > 10000) {
      lastSave = Date.now();
      await saveProgress();
    }
    process.stdout.write(
      `\r${String(results.length).padStart(3, " ")}/${organisations.length} ${enriched.name}`.slice(0, 120),
    );
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
process.stdout.write("\n");
await saveProgress();

console.log(outputPath);
process.exit(0);
