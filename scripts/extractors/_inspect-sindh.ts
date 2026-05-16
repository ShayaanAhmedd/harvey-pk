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

  const detailUrls = [
    "https://sindhlaws.gov.pk/GazetteDetail.aspx?X=ACT&Year=2024",
    "https://sindhlaws.gov.pk/GazetteDetail.aspx?X=ACT&Year=2010",
    "https://sindhlaws.gov.pk/GazetteDetail.aspx?X=ACT&Year=1975",
    "https://sindhlaws.gov.pk/GazetteDetail.aspx?X=ORDINANCE&Year=2024",
  ];

  for (const url of detailUrls) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`DETAIL INSPECTION: ${url}`);
    console.log("=".repeat(60));

    try {
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await new Promise(r => setTimeout(r, 3000));

      const status = res?.status();
      const title = await page.title();
      const html = await page.content();
      console.log(`  Status: ${status}`);
      console.log(`  Title: ${title}`);
      console.log(`  HTML length: ${html.length}`);

      // PDFs
      const pdfLinks = await page.$$eval('a[href*=".pdf"]', els =>
        els.map(e => ({
          text: (e.textContent ?? "").trim().slice(0, 200),
          href: (e as HTMLAnchorElement).href,
          parent_text: (e.parentElement?.parentElement?.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 400),
        }))
      );
      console.log(`\nPDF LINKS: ${pdfLinks.length}`);
      pdfLinks.slice(0, 8).forEach((l, i) => {
        console.log(`  [${i}] text: "${l.text.slice(0, 100)}"`);
        console.log(`      href: ${l.href}`);
        console.log(`      row context: ${l.parent_text.slice(0, 200)}`);
      });
      if (pdfLinks.length > 8) {
        console.log(`  ... and ${pdfLinks.length - 8} more`);
      }

      // Tables
      const tables = await page.$$eval('table', tables =>
        tables.map((t, i) => ({
          index: i,
          rows: t.querySelectorAll('tr').length,
          headers: Array.from(t.querySelectorAll('th')).map(h => (h.textContent ?? "").trim()),
          firstRowText: (t.querySelector('tr:nth-child(2)')?.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 300),
        }))
      );
      console.log(`\nTABLES: ${tables.length}`);
      tables.forEach(t => {
        console.log(`  Table[${t.index}]: ${t.rows} rows`);
        console.log(`    Headers: ${t.headers.join(" | ").slice(0, 200)}`);
        console.log(`    First data row: ${t.firstRowText.slice(0, 200)}`);
      });

      // Look for pagination
      const pagerCandidates = await page.$$eval('a, span', els =>
        els
          .filter(e => /^(next|prev|first|last|»|‹|›|«|page\s*\d+|\d+\s*of\s*\d+)$/i.test((e.textContent ?? "").trim()))
          .slice(0, 10)
          .map(e => ({ text: (e.textContent ?? "").trim(), href: (e as HTMLAnchorElement).href ?? "" }))
      );
      console.log(`\nPAGINATION: ${pagerCandidates.length}`);
      pagerCandidates.forEach(p => console.log(`  "${p.text}" → ${p.href.slice(0, 100)}`));

      // Body sample
      const bodyText = await page.evaluate(() => {
        const content = document.querySelector('#main, main, .content, #content, body');
        return (content?.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 1500);
      });
      console.log(`\n--- BODY SAMPLE ---`);
      console.log(bodyText.slice(0, 1500));

      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      console.log(`  Error: ${(e as Error).message}`);
    }
  }

  await browser.close();
}

main().catch(console.error);
