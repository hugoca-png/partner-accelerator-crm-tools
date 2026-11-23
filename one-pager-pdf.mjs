import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

function browserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  ];
  return candidates.find((path) => path && existsSync(path));
}

export async function renderOnePagerPdf(html) {
  const executablePath = browserExecutable();
  if (!executablePath) throw new Error("Chrome ou Edge não encontrado para gerar o PDF. Define CHROME_PATH no ambiente.");
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 794, height: 1123 } });
    await page.setContent(html, { waitUntil: "load", timeout: 20000 });
    return await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
}
