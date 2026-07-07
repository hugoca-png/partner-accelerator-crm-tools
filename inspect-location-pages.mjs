const urls = [
  "https://www.greentape.app/",
  "https://www.nauai.pt/",
  "https://www.thepreplan.com/",
  "https://werinteraction.com/",
  "https://www.standout-tech.com/",
  "https://standout-tech.com/",
];

for (const url of urls) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 Codex location research" },
      signal: AbortSignal.timeout(12000),
    });
    const html = await response.text();
    console.log(`\n### ${url} ${response.status} ${response.url} len ${html.length}`);
    for (const match of html.matchAll(/<meta[^>]+(?:name|property)=["']([^"']+)["'][^>]+content=["']([^"']*)["']/gi)) {
      console.log("META", match[1], match[2].slice(0, 250));
    }
    for (const match of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
      console.log("SCRIPT", new URL(match[1], response.url).toString());
    }
    const terms = ["lisboa", "lisbon", "portugal", "porto", "address", "morada", "location", "sede"];
    const lower = html.toLocaleLowerCase("pt-PT");
    for (const term of terms) {
      const index = lower.indexOf(term);
      if (index < 0) continue;
      console.log(`TERM ${term}`, html.slice(Math.max(0, index - 120), index + 250).replace(/\s+/g, " "));
    }
  } catch (error) {
    console.log(`\n### ${url} ERROR ${error.message || String(error)}`);
  }
}
