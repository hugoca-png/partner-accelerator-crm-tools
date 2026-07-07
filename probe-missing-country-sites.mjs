import { readFile, writeFile } from "node:fs/promises";

const cache = JSON.parse(await readFile("capsule-cache.json", "utf8"));
const organisations = (cache.organisations || []).filter((org) => !String(org.country || "").trim() && org.url);
const paths = ["", "contact", "contacts", "contactos", "about", "sobre", "privacy", "privacy-policy", "terms", "terms-and-conditions", "legal"];

function cleanHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function baseUrl(raw) {
  const url = new URL(raw);
  return `${url.protocol}//${url.host}/`;
}

function relevantSnippets(text) {
  const patterns = [
    /\b\d{4}-\d{3}\b/g,
    /\b(address|address:|morada|sede|headquarters|office|offices|contact us|contactos|registered office)\b/gi,
    /\b(Lisboa|Lisbon|Porto|Oeiras|Cascais|Sintra|Braga|Coimbra|Aveiro|Portugal|Spain|United States|Brazil|Brasil|London|Dublin|Madrid|Barcelona)\b/gi,
  ];
  const positions = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) positions.add(match.index || 0);
  }
  return [...positions]
    .sort((a, b) => a - b)
    .slice(0, 30)
    .map((position) => text.slice(Math.max(0, position - 180), position + 320))
    .filter((value, index, array) => array.indexOf(value) === index);
}

const output = [];
for (const org of organisations) {
  const root = baseUrl(org.url);
  const pages = [];
  for (const suffix of paths) {
    const url = new URL(suffix, root).toString();
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": "Mozilla/5.0 Codex location research" },
        signal: AbortSignal.timeout(12000),
      });
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !contentType.includes("text/html")) continue;
      const html = await response.text();
      const text = cleanHtml(html);
      const snippets = relevantSnippets(text);
      if (snippets.length) {
        pages.push({
          requestedUrl: url,
          finalUrl: response.url,
          title: cleanHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ""),
          snippets,
        });
      }
    } catch {
      // Keep probing other likely pages.
    }
  }
  output.push({ id: String(org.id), name: org.name, website: org.url, pages });
}

await writeFile("missing-country-site-probe.json", JSON.stringify({
  generatedAt: new Date().toISOString(),
  organisations: output,
}, null, 2), "utf8");

console.log(JSON.stringify({
  organisations: output.length,
  withUsefulPages: output.filter((org) => org.pages.length).length,
  report: "missing-country-site-probe.json",
}, null, 2));
