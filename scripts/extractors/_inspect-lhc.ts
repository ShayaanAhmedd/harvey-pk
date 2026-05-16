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

  const BASE = "https://data.lhc.gov.pk/reported_judgments/judgments_approved_for_reporting";

  // First, discover what year options the dropdown actually has
  console.log("═".repeat(60));
  console.log("STEP 1: Discover year dropdown options");
  console.log("═".repeat(60));

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  const yearOptions = await page.$$eval('select[name="year"] option', els =>
    els.map(e => ({
      value: (e as HTMLOptionElement).value,
      text: (e.textContent ?? "").trim(),
    }))
  );

  console.log(`Year dropdown has ${yearOptions.length} options:`);
  yearOptions.forEach(y => console.log(`  value="${y.value}" text="${y.text}"`));

  // Pick a specific year to test (e.g., 2024 — old enough to have full data)
  const testYear = yearOptions.find(y => /^2024$/.test(y.text) || /^2024$/.test(y.value))?.value
                 ?? yearOptions.find(y => /^2025$/.test(y.text) || /^2025$/.test(y.value))?.value
                 ?? yearOptions[yearOptions.length - 2]?.value;

  if (!testYear) {
    console.log("Could not find a test year. Aborting.");
    await browser.close();
    return;
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`STEP 2: Submit form with year=${testYear}`);
  console.log("═".repeat(60));

  // Re-load the page to get a fresh form
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  // Select the year and submit
  await page.selectOption('select[name="year"]', testYear);

  // Find the submit button — scope to the year-filter form to avoid the
  // hidden Drupal site-wide-search submit (which is invisible and times out).
  const filterForm = 'form[action*="judgments_approved_for_reporting"]';
  const submitButton = await page.$(`${filterForm} button[type="submit"], ${filterForm} input[type="submit"]`);
  if (!submitButton) {
    console.log("No submit button found inside year-filter form. Trying Enter on the select.");
    await page.press('select[name="year"]', "Enter");
  } else {
    await submitButton.click();
  }

  await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  const filteredUrl = page.url();
  console.log(`After submit, URL is: ${filteredUrl}`);

  const pdfCount = await page.$$eval('a[href*="sys.lhc.gov.pk/appjudgments"]', els => els.length);
  console.log(`PDF count on filtered page: ${pdfCount}`);

  // Sample first 5 PDF URLs to confirm they match the filter year
  const samplePdfs = await page.$$eval('a[href*="sys.lhc.gov.pk/appjudgments"]', els =>
    els.slice(0, 5).map(e => (e as HTMLAnchorElement).href)
  );
  console.log("First 5 PDF URLs:");
  samplePdfs.forEach(p => console.log(`  ${p}`));

  // Check pagination presence
  console.log("\nLooking for pagination...");
  const pagerLinks = await page.$$eval('ul.pager a, .pager a, .pagination a', els =>
    els.map(e => ({
      text: (e.textContent ?? "").trim(),
      href: (e as HTMLAnchorElement).href,
    }))
  );
  console.log(`Pager links found: ${pagerLinks.length}`);
  pagerLinks.slice(0, 15).forEach(p => console.log(`  "${p.text}" → ${p.href}`));

  console.log(`\n${"═".repeat(60)}`);
  console.log(`STEP 3: Try paginating WITHIN the year filter`);
  console.log("═".repeat(60));

  // Construct page-2 URL by appending ?page=1 or &page=1 to filtered URL
  const sep = filteredUrl.includes("?") ? "&" : "?";
  const page2Url = `${filteredUrl}${sep}page=1`;
  console.log(`Trying: ${page2Url}`);
  await page.goto(page2Url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  const page2Pdfs = await page.$$eval('a[href*="sys.lhc.gov.pk/appjudgments"]', els =>
    els.slice(0, 5).map(e => (e as HTMLAnchorElement).href)
  );
  console.log(`Page 2 PDF count: ${page2Pdfs.length} (sample)`);
  console.log("First 5 PDF URLs on page 2:");
  page2Pdfs.forEach(p => console.log(`  ${p}`));

  // Check if same as page 1
  if (page2Pdfs.length > 0 && samplePdfs.length > 0) {
    if (page2Pdfs[0] === samplePdfs[0]) {
      console.log("⚠ Page 2 first PDF = Page 1 first PDF → year-filter pagination ALSO BROKEN");
    } else {
      console.log("✓ Page 2 has DIFFERENT PDFs → year-filter pagination WORKS!");
    }
  }

  await browser.close();
}

main().catch(console.error);
