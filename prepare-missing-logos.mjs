import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outputDir = "prepared-logos";
const cache = JSON.parse(await readFile("capsule-cache.json", "utf8"));

const manualOverrides = new Map([
  ["devlop", {
    manualLogo: "https://devlop.systems/wp-content/uploads/Favicon-Devlop-Leviahub-1.png",
    manualNote: "Icon oficial do dominio. O website nao expoe um wordmark limpo; rejeitado o candidato Portugal 2020.",
  }],
  ["first-solutions-sistemas-de-informacao", {
    manualLogo: "https://framerusercontent.com/images/5iV2D3JW3EoNdVafGEWvUz5V48U.png",
    manualNote: "Icon oficial do site. Rejeitado o banner social de 25 anos por nao ser logo limpo.",
  }],
]);

function slug(value) {
  return String(value)
    .toLocaleLowerCase("pt-PT")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function absolutize(value, base) {
  if (!value) return "";
  try {
    return new URL(value, base).href;
  } catch {
    return "";
  }
}

function getAttr(tag, name) {
  return tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"))?.[1] || "";
}

function extFromContentType(type, url) {
  if (/png/i.test(type) || /\.png(\?|$)/i.test(url)) return ".png";
  if (/jpeg|jpg/i.test(type) || /\.jpe?g(\?|$)/i.test(url)) return ".jpg";
  if (/gif/i.test(type) || /\.gif(\?|$)/i.test(url)) return ".gif";
  return "";
}

function isDefaultOrganisationLogo(value) {
  return /public-assets\/images\/organisation\.svg/i.test(clean(value));
}

function isLikelyWrongLogo(company, candidate) {
  const text = `${candidate.url} ${candidate.source}`.toLocaleLowerCase("pt-PT");
  const badFragments = [
    "portugal_2020",
    "og-default",
    "gdpr",
    "cookie",
    "customer-stories",
    "case-stories",
    "case-studies",
    "trust-symbol",
    "trustpilot",
    "capterra",
    "g2-reviews",
    "reviews-book-demo",
    "certified",
    "certificada",
    "certificacao",
    "certification",
    "iso-",
    "iso_",
    "27001",
    "9001",
    "award",
    "badge",
    "seal",
    "selo",
    "seloid",
    "partner",
    "partners",
    "cliente",
    "client",
    "bureau-veritas",
    "empresa-certificada",
    "esg-registered",
    "germany",
    "windows logo",
    "apple logo",
    "android logo",
    "chrome logo",
    "firefox logo",
    "google workspace logo",
    "word logo",
    "powerpoint logo",
    "outlook logo",
  ];
  if (badFragments.some((fragment) => text.includes(fragment))) return true;
  if (company.name === "Soko" && /\.svg(\?|$)/i.test(candidate.url)) return true;
  return false;
}

function companyTokens(company) {
  const raw = [
    company.name,
    ...(company.domains || []).map((domain) => domain.split(".")[0]),
  ].join(" ");
  const ignored = new Set([
    "lda",
    "ltd",
    "sa",
    "s",
    "a",
    "pt",
    "com",
    "www",
    "the",
    "and",
    "consulting",
    "solutions",
    "systems",
    "sistemas",
    "informacao",
    "portugal",
    "international",
    "development",
  ]);
  return slug(raw)
    .split("-")
    .filter((token) => token.length >= 3 && !ignored.has(token));
}

function candidateHasCompanySignal(company, candidate) {
  let urlText = candidate.url;
  try {
    const parsed = new URL(candidate.url);
    urlText = `${parsed.pathname} ${parsed.search}`;
  } catch {
    urlText = candidate.url;
  }
  const text = slug(`${urlText} ${candidate.source}`);
  return companyTokens(company).some((token) => text.includes(token));
}

function isIconCandidate(candidate) {
  return /icon|favicon|apple-touch-icon|well-known/i.test(`${candidate.source} ${candidate.url}`);
}

function isCredibleLogoCandidate(company, candidate) {
  if (isLikelyWrongLogo(company, candidate)) return false;
  if (candidate.source === "manual official asset") return true;

  const text = `${candidate.url} ${candidate.source}`.toLocaleLowerCase("pt-PT");
  const hasCompanySignal = candidateHasCompanySignal(company, candidate);

  if (isIconCandidate(candidate)) {
    if (/\.jpe?g(\?|$)/i.test(candidate.url) && !/(favicon|icon|logo)/i.test(candidate.url)) return false;
    return true;
  }
  if (hasCompanySignal && /logo|brand|wordmark|logotipo|logotype/i.test(text)) return true;
  if (hasCompanySignal && /(og:image|twitter:image)/i.test(candidate.source)) return true;

  return false;
}

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 logo-prep",
      accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) throw new Error(`Conteudo nao HTML: ${contentType || "desconhecido"}`);
  return { html: await response.text(), finalUrl: response.url };
}

function candidatesFromHtml(html, pageUrl, company) {
  const candidates = [];

  for (const tagMatch of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = tagMatch[0];
    const key = `${getAttr(tag, "property")} ${getAttr(tag, "name")}`.toLocaleLowerCase("pt-PT");
    const content = getAttr(tag, "content");
    if (/^(og:image|twitter:image|twitter:image:src)$/i.test(key)) {
      candidates.push({ url: absolutize(content, pageUrl), source: key.trim() || "meta image", score: 60 });
    }
  }

  for (const tagMatch of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = tagMatch[0];
    const rel = getAttr(tag, "rel");
    const href = getAttr(tag, "href");
    if (/icon|apple-touch-icon/i.test(rel)) {
      candidates.push({ url: absolutize(href, pageUrl), source: rel, score: /apple/i.test(rel) ? 72 : 66 });
    }
  }

  for (const tagMatch of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = tagMatch[0];
    const src = getAttr(tag, "src") || getAttr(tag, "data-src") || getAttr(tag, "data-lazy-src");
    const srcset = getAttr(tag, "srcset");
    const alt = getAttr(tag, "alt");
    const cls = getAttr(tag, "class");
    const width = Number(getAttr(tag, "width") || 0);
    const combined = `${src} ${srcset} ${alt} ${cls}`.toLocaleLowerCase("pt-PT");
    let score = 20;
    if (combined.includes("logo")) score += 75;
    if (combined.includes("brand")) score += 25;
    if (combined.includes("header")) score += 12;
    if (combined.includes(slug(company.name))) score += 15;
    if (width && width <= 500) score += 4;
    const bestSrc = src || srcset.split(",").map((part) => part.trim().split(/\s+/)[0]).find(Boolean) || "";
    if (bestSrc && score >= 55) candidates.push({ url: absolutize(bestSrc, pageUrl), source: `img alt="${alt}"`, score });
  }

  const base = new URL(pageUrl);
  for (const iconPath of ["/favicon.png", "/favicon.ico", "/apple-touch-icon.png", "/android-chrome-192x192.png", "/android-chrome-512x512.png"]) {
    candidates.push({ url: new URL(iconPath, base.origin).href, source: "well-known icon path", score: 45 });
  }

  const seen = new Set();
  return candidates
    .filter((item) => item.url && !seen.has(item.url) && seen.add(item.url))
    .sort((a, b) => b.score - a.score)
    .slice(0, 14);
}

async function downloadCandidate(company, candidate) {
  const response = await fetch(candidate.url, {
    redirect: "follow",
    headers: { "user-agent": "Mozilla/5.0 logo-prep" },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const contentType = response.headers.get("content-type") || "";
  const ext = extFromContentType(contentType, response.url || candidate.url);
  if (!ext) throw new Error(`Formato nao aceite: ${contentType || candidate.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error("Ficheiro vazio.");
  const fileName = `${slug(company.name)}${ext}`;
  const path = join(outputDir, fileName);
  await writeFile(path, bytes);
  return { path, contentType, bytes: bytes.length, finalUrl: response.url };
}

function missingLogoCompanies() {
  const organisations = (cache.organisations || [])
    .filter((org) => !clean(org.logo) || isDefaultOrganisationLogo(org.logo))
    .map((org) => {
      const override = manualOverrides.get(slug(org.name)) || {};
      return {
        id: org.id,
        name: org.name,
        url: org.url || "",
        city: org.city || "",
        country: org.country || "",
        domains: org.domains || [],
        ...override,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "pt-PT"));
  return organisations;
}

await mkdir(outputDir, { recursive: true });
for (const fileName of await readdir(outputDir)) {
  if (/\.(gif|jpe?g|png)$/i.test(fileName)) {
    await unlink(join(outputDir, fileName));
  }
}

const companies = missingLogoCompanies();
const results = [];
for (const company of companies) {
  const result = { ...company, candidates: [], selected: null, error: "" };
  try {
    if (!company.url) {
      result.error = "Sem website no CRM; precisa de selecao manual.";
      results.push(result);
      continue;
    }
    const { html, finalUrl } = await fetchText(company.url);
    result.finalWebsiteUrl = finalUrl;
    result.candidates = candidatesFromHtml(html, finalUrl, company);
    if (company.manualLogo) {
      result.candidates.unshift({ url: company.manualLogo, source: "manual official asset", score: 100 });
    }

    for (const candidate of result.candidates) {
      if (!isCredibleLogoCandidate(company, candidate)) {
        candidate.skipped = "Candidato rejeitado por baixa confianca.";
        continue;
      }
      try {
        result.selected = { ...candidate, ...(await downloadCandidate(company, candidate)) };
        break;
      } catch (error) {
        candidate.error = error.message || String(error);
      }
    }

    if (!result.selected) {
      result.error = "Nao foi encontrado candidato obvio em formato aceite: gif, jpg ou png.";
    }
    if (company.manualNote) result.note = company.manualNote;
  } catch (error) {
    result.error = error.message || String(error);
  }
  results.push(result);
}

function escapeHtml(value) {
  return clean(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

const generatedAt = new Date().toISOString();
const html = `<!doctype html>
<html lang="pt">
<head>
  <meta charset="utf-8" />
  <title>Logos preparados</title>
  <style>
    body { font-family: Segoe UI, Arial, sans-serif; margin: 24px; color: #111827; }
    .meta { color: #6b7280; margin-bottom: 18px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #dfe5ee; padding: 8px; vertical-align: top; }
    th { background: #1e2761; color: white; text-align: left; }
    img { max-width: 140px; max-height: 80px; object-fit: contain; background: #f5f7fb; }
    .error { color: #b91c1c; font-weight: 700; }
    .ok { color: #12743b; font-weight: 700; }
    code { font-size: 12px; }
    small { color: #6b7280; }
  </style>
</head>
<body>
  <h1>Logos preparados para upload manual no Capsule</h1>
  <p class="meta">Gerado em ${escapeHtml(new Date(generatedAt).toLocaleString("pt-PT"))}. Fonte: empresas sem logo em capsule-cache.json. Criterio: website oficial; apenas formatos aceites: GIF, JPG ou PNG. SVG e WebP ficam pendentes.</p>
  <table>
    <thead><tr><th>Empresa</th><th>Pre-visualizacao</th><th>Ficheiro</th><th>Fonte</th><th>Notas</th></tr></thead>
    <tbody>
      ${results.map((item) => `
        <tr>
          <td><strong>${escapeHtml(item.name)}</strong><br><small>${escapeHtml([item.city, item.country].filter(Boolean).join(", "))}</small><br><a href="${escapeHtml(item.url)}">${escapeHtml(item.url)}</a></td>
          <td>${item.selected ? `<img src="${escapeHtml(item.selected.path.replace(/^prepared-logos[\\/]/, "").replaceAll("\\", "/"))}" alt="">` : ""}</td>
          <td>${item.selected ? `<code>${escapeHtml(item.selected.path)}</code><br><small>${escapeHtml(item.selected.contentType)} · ${escapeHtml(item.selected.bytes)} bytes</small>` : ""}</td>
          <td>${item.selected ? `<a href="${escapeHtml(item.selected.finalUrl || item.selected.url)}">${escapeHtml(item.selected.source)}</a><br>score ${escapeHtml(item.selected.score)}` : ""}</td>
          <td class="${item.selected ? "ok" : "error"}">${item.selected ? `Candidato preparado. Confirmar visualmente antes de upload.${item.note ? `<br><small>${escapeHtml(item.note)}</small>` : ""}` : escapeHtml(item.error)}</td>
        </tr>
      `).join("")}
    </tbody>
  </table>
</body>
</html>`;

await writeFile(join(outputDir, "index.html"), html, "utf8");
await writeFile(join(outputDir, "logos-report.json"), JSON.stringify({
  generatedAt,
  sourceRefreshedAt: cache.refreshedAt || "",
  totalMissingLogos: companies.length,
  prepared: results.filter((item) => item.selected).length,
  pending: results.filter((item) => !item.selected).length,
  results,
}, null, 2), "utf8");

console.log(JSON.stringify({
  prepared: results.filter((item) => item.selected).length,
  pending: results.filter((item) => !item.selected).length,
  totalMissingLogos: companies.length,
  folder: outputDir,
  report: join(outputDir, "index.html"),
}, null, 2));
