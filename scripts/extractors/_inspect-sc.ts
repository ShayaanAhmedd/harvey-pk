import { chromium } from "playwright";

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
  });
  const page = await ctx.newPage();

  const urls = [
    "https://www.supremecourt.gov.pk/",
    "https://www.supremecourt.gov.pk/judgements/",
    "https://www.supremecourt.gov.pk/recent-judgments/",
    "https://www.supremecourt.gov.pk/latest-judgements/",
    "https://www.supremecourt.gov.pk/judgments-orders/",
    "https://www.supremecourt.gov.pk/orders-of-the-week/",
  ];

  for (const url of urls) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Fetching: ${url}`);
    try {
      const res = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      const status = res?.status();
      const title = await page.title();
      console.log(`  Status:        ${status}`);
      console.log(`  Title:         ${title}`);
      const html = await page.content();
      console.log(`  HTML length:   ${html.length}`);

      // Look for PDF links
      const pdfLinks = await page.$$eval('a[href*=".pdf"]', els =>
        els.slice(0, 10).map(e => ({
          text: (e.textContent ?? "").trim().slice(0, 80),
          href: (e as HTMLAnchorElement).href,
        }))
      );
      console.log(`  PDF link count: ${pdfLinks.length}`);
      if (pdfLinks.length > 0) {
        console.log(`  First 3 PDFs:`);
        pdfLinks.slice(0, 3).forEach(l => console.log(`    - ${l.text.slice(0, 50)}: ${l.href}`));
      }

      // Look for "judgment" or "decision" related links
      const judgmentLinks = await page.$$eval('a', els =>
        els
          .filter(e => /judg|decision|order|recent|latest/i.test((e.textContent ?? "")))
          .slice(0, 10)
          .map(e => ({
            text: (e.textContent ?? "").trim().slice(0, 80),
            href: (e as HTMLAnchorElement).href,
          }))
      );
      console.log(`  Judgment-related links found: ${judgmentLinks.length}`);
      if (judgmentLinks.length > 0) {
        console.log(`  First 5:`);
        judgmentLinks.slice(0, 5).forEach(l => console.log(`    - "${l.text}" → ${l.href}`));
      }

      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      console.log(`  Error: ${(e as Error).message}`);
    }
  }

  await browser.close();
}

main().catch(console.error);
