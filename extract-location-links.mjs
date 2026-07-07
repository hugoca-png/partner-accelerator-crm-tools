const urls = [
  "https://apexahead.com/",
  "https://theoriginalmusicbook.com/",
  "https://soko.fyi/",
  "https://standout-tech.com/",
  "https://www.greentape.app/",
  "https://www.nauai.pt/",
];

for (const url of urls) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 Codex location research" },
      signal: AbortSignal.timeout(12000),
    });
    const html = await response.text();
    const links = [...html.matchAll(/href=["']([^"']+)["']/gi)]
      .map((match) => match[1])
      .map((href) => {
        try {
          return new URL(href, response.url).toString();
        } catch {
          return href;
        }
      })
      .filter((href) => /linkedin|facebook|instagram|mailto|maps|google|contact|about|privacy|terms|legal|calendly|book|company/i.test(href));
    console.log(`\n### ${url}`);
    console.log([...new Set(links)].slice(0, 80).join("\n"));
  } catch (error) {
    console.log(`\n### ${url} ERROR ${error.message || String(error)}`);
  }
}
