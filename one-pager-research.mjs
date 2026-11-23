function decode(value) {
  return String(value || "").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&(?:amp|quot|apos|lt|gt|nbsp);/gi, (part) => ({
      "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " ",
    })[part.toLowerCase()] || part);
}

function plain(value) {
  return decode(String(value || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function attr(tag, name) {
  return decode(tag.match(new RegExp(`\\b${name}\\s*=\\s*([\"'])(.*?)\\1`, "i"))?.[2] || "");
}

function meta(html, name) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    if ([attr(match[0], "name"), attr(match[0], "property")].some((x) => x.toLowerCase() === name)) {
      return plain(attr(match[0], "content"));
    }
  }
  return "";
}

function safeUrl(value, base) {
  try {
    const url = new URL(value, base);
    const host = url.hostname.toLowerCase();
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || host === "localhost"
      || host.endsWith(".local") || host.endsWith(".internal") || host === "[::1]"
      || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
    url.hash = "";
    return url;
  } catch { return null; }
}

async function fetchPage(url, fetchImpl) {
  let current = url;
  for (let hop = 0; hop < 3; hop++) {
    const response = await fetchImpl(current, {
      headers: { Accept: "text/html,application/xhtml+xml" },
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      current = safeUrl(response.headers.get("location"), current);
      if (!current) throw new Error("Redirecionamento não permitido.");
      continue;
    }
    if (!response.ok) throw new Error(`Website HTTP ${response.status}`);
    if (!/text\/html|application\/xhtml\+xml/i.test(response.headers.get("content-type") || "")) {
      throw new Error("O website não devolveu HTML.");
    }
    return { url: current.href, html: (await response.text()).slice(0, 450000) };
  }
  throw new Error("Demasiados redirecionamentos.");
}

function links(html, base, host) {
  const result = [];
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*([\"'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = safeUrl(decode(match[2]), base);
    if (!url || url.hostname.replace(/^www\./, "") !== host || result.some((x) => x.url === url.href)) continue;
    result.push({ url: url.href, label: plain(match[3]) });
  }
  return result;
}

function description(html) {
  const value = meta(html, "description") || meta(html, "og:description");
  if (value.length >= 35 && value.length <= 850) return value;
  return [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((x) => plain(x[1])).find((x) => x.length >= 70 && x.length <= 600) || "";
}

function articleDate(html) {
  const raw = meta(html, "article:published_time")
    || attr(html.match(/<time\b[^>]*>/i)?.[0] || "", "datetime");
  const date = new Date(raw);
  return raw && !Number.isNaN(date.getTime()) && date <= new Date() ? date.toISOString().slice(0, 10) : "";
}

export async function researchOrganisation(org, { fetchImpl = fetch } = {}) {
  const homepage = safeUrl(org.url);
  if (!homepage) throw new Error("Não existe um website oficial válido no CRM.");
  const home = await fetchPage(homepage, fetchImpl);
  const host = new URL(home.url).hostname.replace(/^www\./, "");
  const found = links(home.html, home.url, host);
  const relevant = found.filter((x) => /about|sobre|quem.somos|servi[cç]os|services|solu[cç][oõ]es|solutions|insights|blog|not[ií]cias|news/i.test(`${x.url} ${x.label}`));
  const pages = [{ ...home, label: "Website oficial", kind: "home" }];
  for (const link of relevant.slice(0, 3)) {
    try {
      const page = await fetchPage(new URL(link.url), fetchImpl);
      pages.push({ ...page, label: link.label || "Página oficial",
        kind: /insights|blog|not[ií]cias|news/i.test(`${link.url} ${link.label}`) ? "news" : "company" });
    } catch { /* Keep the verified homepage. */ }
  }
  if (!pages.some((page) => page.kind === "news")) {
    const candidates = ["/insights", "/blog", "/news"];
    const probed = await Promise.all(candidates.map(async (pathname) => {
      try {
        const url = new URL(pathname, home.url);
        const page = await fetchPage(url, fetchImpl);
        if (new URL(page.url).pathname.replace(/\/$/, "") !== pathname) return null;
        if (!/insights|blog|news|not[ií]cias/i.test(`${page.url} ${plain(page.html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1])}`)) return null;
        return { ...page, label: pathname.slice(1), kind: "news" };
      } catch { return null; }
    }));
    pages.push(...probed.filter(Boolean).slice(0, 1));
  }
  const described = pages.map((x) => ({ ...x, description: description(x.html) })).filter((x) => x.description);
  const summary = described.find((x) => /about|sobre|quem.somos/i.test(x.url))?.description
    || described.find((x) => x.kind === "home")?.description || described[0]?.description
    || String(org.description || "").trim();
  const recent = [];
  for (const page of pages.filter((x) => x.kind === "news")) {
    const articles = links(page.html, page.url, host)
      .filter((x) => /insights|blog|not[ií]cias|news/i.test(x.url) && x.url !== page.url).slice(0, 4);
    for (const item of articles) {
      try {
        const article = await fetchPage(new URL(item.url), fetchImpl);
        const date = articleDate(article.html);
        const title = plain(article.html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]) || item.label;
        if (date && title && !recent.some((x) => x.sourceUrl === article.url)) {
          recent.push({ date, text: title, sourceUrl: article.url });
        }
      } catch { /* Unconfirmed items are omitted. */ }
    }
  }
  return {
    reviewedAt: new Date().toISOString().slice(0, 10),
    summary: summary || "Sem descrição verificável no website oficial ou no CRM.",
    capabilities: described.filter((x) => x.kind !== "home").map((x) => `${x.label}: ${x.description}`).slice(0, 3),
    recent: recent.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3),
    unknowns: "A pesquisa automática consulta o website oficial. Clientes, resultados, morada pública e notícias externas exigem verificação adicional quando não constam das fontes citadas.",
    sources: pages.map((x) => ({ label: x.label, url: x.url })),
    researchStatus: described.length ? "official-site" : "limited",
  };
}
