/**
 * Sindh statutes discovery via Playwright.
 *
 * Walks every year in sindhlaws.gov.pk's GazetteDetail.aspx archive,
 * extracts metadata per Act/Ordinance/Notification, saves to CSV.
 * Does NOT download PDFs yet (Phase 2).
 *
 * Verified from inspection:
 *   - Acts:        https://sindhlaws.gov.pk/GazetteDetail.aspx?X=ACT&Year=YYYY
 *   - Ordinances:  https://sindhlaws.gov.pk/GazetteDetail.aspx?X=ORDINANCE&Year=YYYY
 *   - Notifications: https://sindhlaws.gov.pk/Notification.aspx
 *   - Table columns: # | TITLE | ENGLISH | DATE
 *   - PDF host:    sindhlaws.gov.pk/setup/publications/PUB-YY-NNNNNN.pdf
 *   - No pagination within year (all docs on one page)
 *   - No bot block; plain HTML; Playwright works
 */

import fs from "fs";
import path from "path";
import { chromium, type Page } from "playwright";
import { stringify } from "csv-stringify/sync";

const BASE = "https://sindhlaws.gov.pk";

// Years extracted from inspection (from Gazette.aspx?pg=ACT dropdown)
const ACT_YEARS = [
  2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017,
  2016, 2015, 2014, 2013, 2012, 2011, 2010, 2009, 2008, 2007,
  2006, 2005, 2004, 2003, 1998, 1997, 1996, 1995, 1994, 1993,
  1992, 1991, 1990, 1989, 1988, 1987, 1986, 1985, 1977, 1976,
  1975, 1974, 1973, 1972, 1957, 1955, 1954, 1953, 1952, 1951,
  1950, 1949, 1948, 1947, 1946, 1944, 1943, 1942, 1941, 1940,
  1939, 1938, 1937, 1935, 1934, 1933, 1932, 1931, 1930, 1929,
  1928, 1926, 1925, 1923, 1922, 1920, 1915, 1912, 1906, 1905,
  1900, 1896, 1883, 1882, 1879, 1878, 1876, 1875, 1868, 1867,
  1866, 1865, 1864, 1863, 1838, 1827,
];

const ORDINANCE_YEARS = [
  2025, 2024, 2023, 2020, 2016, 2015, 2014, 2013, 2005, 2002,
  2001, 2000, 1999, 1984, 1983, 1982, 1981, 1980, 1979, 1978,
  1972, 1971, 1970, 1969, 1965, 1962, 1958, 1955,
];

type SindhDoc = {
  act_name: string;
  year: string;
  province: string;
  legal_doc_type: string;
  domain: string;
  source_url: string;
  pdf_url: string;
  notes: string;
  document_date: string;
  gazette_number: string;
};

function parseArgs(): Record<string, string> {
  const a = process.argv.slice(2);
  const o: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith("--")) {
      const k = a[i].slice(2);
      const v = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : "true";
      o[k] = v;
    }
  }
  return o;
}

/**
 * Parse row context like:
 *   "IFINANCE ACT, 2024DownloadJun 30, 2024"
 *   "II SINDH LOCAL GOVERNMENT (AMENDMENT) ACT, 2010DownloadFeb 17, 2010"
 * Returns: { gazette_number, title, date }
 */
function parseRowContext(rowText: string): { gazette_number: string; title: string; date: string } {
  // Strip "Download" out
  const cleaned = rowText.replace(/Download/gi, "|").replace(/\s+/g, " ").trim();
  // Format: "<ROMAN><TITLE>|<DATE>"
  const parts = cleaned.split("|").map(s => s.trim()).filter(Boolean);

  let gazette_number = "";
  let title = "";
  let date = "";

  if (parts.length >= 2) {
    // First part: roman numeral + title
    const firstPart = parts[0];

    // Real gazette numerals are short (max ~6 chars: I, II, III, IV, V,
    // VI, VII, VIII, IX, X, XI, XII, ..., XXX, XL, L, LX, LXX, LXXX).
    // The standard format is "<numeral><TITLE_STARTING_WITH_LETTER>" where
    // TITLE starts with an A-Z letter (case 1) OR a digit (case 2 — some
    // years start titles with "1ST" etc.).
    //
    // Heuristic: try standard roman numerals (I, II, III, IV, V, VI, VII,
    // VIII, IX, X) and their hundreds/tens variants up to ~6 chars, prefer
    // shorter matches.
    let romanMatch: RegExpMatchArray | null = null;

    // Try longest valid roman first (up to 6 chars), then progressively shorter.
    // This avoids matching "IC" as a roman when "I" is correct.
    // Standard gazette numerals: I, II, III, IV, V, VI, VII, VIII, IX, X,
    // XI..XX, XXX, XL, L, LX..LXXX, XC, C, CI..CCC, CD, D, DC..DCCC, CM, M
    const knownRomans = [
      // 1-100, then jumps. Most gazette numbers are 1-50, occasionally up to 80-100.
      "LXXXVIII","LXXXVII","LXXXVI","LXXXIV","LXXXIII","LXXXII","LXXXI","LXXX",
      "LXXIX","LXXVIII","LXXVII","LXXVI","LXXIV","LXXIII","LXXII","LXXI","LXX",
      "LXIX","LXVIII","LXVII","LXVI","LXIV","LXIII","LXII","LXI","LX",
      "XLIX","XLVIII","XLVII","XLVI","XLIV","XLIII","XLII","XLI","XL",
      "XXXIX","XXXVIII","XXXVII","XXXVI","XXXIV","XXXIII","XXXII","XXXI","XXX",
      "XXIX","XXVIII","XXVII","XXVI","XXIV","XXIII","XXII","XXI","XX",
      "XIX","XVIII","XVII","XVI","XIV","XIII","XII","XI","X",
      "IX","VIII","VII","VI","IV","III","II","I",
      "L","C","D","M",
    ];

    for (const roman of knownRomans) {
      if (firstPart.startsWith(roman)) {
        const rest = firstPart.slice(roman.length);
        // The character right after the roman should be a letter or space,
        // NOT another roman character (else it'd be a longer roman or a
        // word starting with C/D/I/L/M/V/X).
        if (rest.length === 0 || /^[A-Z\s(]/.test(rest)) {
          // Additional check: if rest starts with a single roman character
          // followed by a non-roman character (like "IC"→"CONSTITUTIONAL"),
          // the C is part of CONSTITUTIONAL not the numeral.
          romanMatch = ["", roman, rest] as unknown as RegExpMatchArray;
          break;
        }
      }
    }

    if (romanMatch) {
      gazette_number = romanMatch[1];
      title = romanMatch[2].trim();
    } else {
      title = firstPart;
    }
    // Last part: date
    date = parts[parts.length - 1];
  }

  return { gazette_number, title, date };
}

function parseDateToIso(dateStr: string): string {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  } catch {}
  return "";
}

function guessDomain(title: string): string {
  const t = title.toLowerCase();
  if (/tax|customs|revenue|finance|excise/.test(t)) return "Tax";
  if (/criminal|narcotic|terror|crime|police/.test(t)) return "Criminal";
  if (/family|marriage|divorce|guardian/.test(t)) return "Family";
  if (/civil servant|service|tribunal|employment/.test(t)) return "Service";
  if (/local govern|municipal|district|city/.test(t)) return "LocalGovernment";
  if (/education|university|institute|college/.test(t)) return "Education";
  if (/health|hospital|medical/.test(t)) return "Health";
  if (/agricultur|forest|fish|wildlife|irrigation/.test(t)) return "Agriculture";
  if (/industri|business|company|partnership/.test(t)) return "Commercial";
  if (/property|land|registration|tenancy/.test(t)) return "Property";
  if (/electricity|power|energy|water/.test(t)) return "Utilities";
  if (/transport|vehicle|motor/.test(t)) return "Transport";
  return "General";
}

async function scrapeYearPage(
  page: Page,
  docType: "ACT" | "ORDINANCE",
  year: number
): Promise<SindhDoc[]> {
  const url = `${BASE}/GazetteDetail.aspx?X=${docType}&Year=${year}`;
  console.log(`  ${docType} ${year}: fetching ${url}`);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, 2500));

    const rows = await page.$$eval('a[href*=".pdf"]', els =>
      els.map(e => {
        // Walk up to find the row that contains the metadata
        let parent = e.parentElement;
        for (let i = 0; i < 5 && parent; i++) {
          const text = (parent.textContent ?? "").trim();
          if (text.length > 30 && /\d{4}/.test(text)) {
            return {
              href: (e as HTMLAnchorElement).href,
              rowText: text.replace(/\s+/g, " ").slice(0, 500),
            };
          }
          parent = parent.parentElement;
        }
        return {
          href: (e as HTMLAnchorElement).href,
          rowText: (e.textContent ?? "").trim(),
        };
      })
    );

    const docs: SindhDoc[] = [];
    for (const r of rows) {
      // Skip the "Latest News" PDF that appears on every page
      if (r.rowText.toLowerCase().includes("latest news")) continue;
      // Skip if href doesn't look like a real publication PDF
      if (!/\/setup\/publications\/PUB-\d+-\d+\.pdf$/i.test(r.href)) continue;

      const meta = parseRowContext(r.rowText);
      if (!meta.title) continue;

      docs.push({
        act_name: meta.title.slice(0, 250),
        year: year.toString(),
        province: "Sindh",
        legal_doc_type: docType === "ACT" ? "Act" : "Ordinance",
        domain: guessDomain(meta.title),
        source_url: url,
        pdf_url: r.href,
        notes: "sindh-statute",
        document_date: parseDateToIso(meta.date),
        gazette_number: meta.gazette_number,
      });
    }

    console.log(`    Found ${docs.length} docs`);
    return docs;
  } catch (e) {
    console.error(`    Error: ${(e as Error).message}`);
    return [];
  }
}

async function scrapeNotifications(page: Page): Promise<SindhDoc[]> {
  const url = `${BASE}/Notification.aspx`;
  console.log(`\nNOTIFICATIONS: fetching ${url}`);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    const rows = await page.$$eval('a[href*=".pdf"]', els =>
      els.map(e => {
        let parent = e.parentElement;
        for (let i = 0; i < 5 && parent; i++) {
          const text = (parent.textContent ?? "").trim();
          if (text.length > 30 && /\d{4}/.test(text)) {
            return {
              href: (e as HTMLAnchorElement).href,
              rowText: text.replace(/\s+/g, " ").slice(0, 500),
            };
          }
          parent = parent.parentElement;
        }
        return {
          href: (e as HTMLAnchorElement).href,
          rowText: (e.textContent ?? "").trim(),
        };
      })
    );

    const docs: SindhDoc[] = [];
    for (const r of rows) {
      if (!/\/setup\/publications\/PUB-\d+-\d+\.pdf$/i.test(r.href)) continue;

      // Notifications row format may differ; just capture the row text as title
      const text = r.rowText;
      const dateMatch = text.match(/(\d{1,2}\s+\w{3}\s+\d{4})/);
      const date = dateMatch ? parseDateToIso(dateMatch[1]) : "";

      // Title is text before "Download" or first date
      const title = text.split(/Download|\d{1,2}\s+\w{3}\s+\d{4}/)[0].trim().slice(0, 250);
      if (!title || title.toLowerCase().includes("latest news")) continue;

      // Year from date OR from PDF filename (PUB-YY-NNNN)
      let year = date ? date.slice(0, 4) : "";
      if (!year) {
        const pubMatch = r.href.match(/PUB-(\d{2})-/);
        if (pubMatch) year = `20${pubMatch[1]}`;
      }

      docs.push({
        act_name: title || "Notification",
        year,
        province: "Sindh",
        legal_doc_type: "Notification",
        domain: guessDomain(title),
        source_url: url,
        pdf_url: r.href,
        notes: "sindh-notification",
        document_date: date,
        gazette_number: "",
      });
    }

    console.log(`  Found ${docs.length} notifications`);
    return docs;
  } catch (e) {
    console.error(`  Error: ${(e as Error).message}`);
    return [];
  }
}

async function main() {
  const args = parseArgs();
  const outPath = path.resolve(process.cwd(), args["out"] ?? "data/seeds/pakistan-sindh.csv");
  const yearLimit = args["max-years"] ? parseInt(args["max-years"], 10) : ACT_YEARS.length;
  const resume = args["resume"] === "true";

  console.log("═".repeat(60));
  console.log("  Sindh Statutes — Discovery");
  console.log("═".repeat(60));
  console.log(`  Output:    ${outPath}`);
  console.log(`  Max years: ${yearLimit}`);
  console.log(`  Resume:    ${resume}`);

  const all: SindhDoc[] = [];
  const seenPdfs = new Set<string>();

  // Load existing CSV if resuming
  if (resume && fs.existsSync(outPath)) {
    const existing = fs.readFileSync(outPath, "utf-8").split("\n").slice(1);
    console.log(`  Resuming from ${existing.length} existing rows`);
    for (const line of existing) {
      const m = line.match(/PUB-\d+-\d+\.pdf/);
      if (m) seenPdfs.add(m[0]);
    }
  }

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

  try {
    // 1. Acts — loop over all years
    console.log(`\n${"━".repeat(60)}`);
    console.log("  Phase 1: Acts");
    console.log("━".repeat(60));

    const actYears = ACT_YEARS.slice(0, yearLimit);
    for (const year of actYears) {
      const docs = await scrapeYearPage(page, "ACT", year);
      let added = 0;
      for (const d of docs) {
        const key = d.pdf_url.match(/PUB-\d+-\d+\.pdf/)?.[0];
        if (key && seenPdfs.has(key)) continue;
        if (key) seenPdfs.add(key);
        all.push(d);
        added++;
      }
      if (added > 0) {
        // Save after each year so partial discovery isn't lost
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, stringify(all, {
          header: true,
          columns: [
            "act_name", "year", "province", "legal_doc_type", "domain",
            "source_url", "pdf_url", "notes", "document_date", "gazette_number",
          ],
        }));
      }
      await new Promise(r => setTimeout(r, 1500));
    }

    console.log(`\n  Acts subtotal: ${all.length}`);

    // 2. Ordinances
    console.log(`\n${"━".repeat(60)}`);
    console.log("  Phase 2: Ordinances");
    console.log("━".repeat(60));

    for (const year of ORDINANCE_YEARS) {
      const docs = await scrapeYearPage(page, "ORDINANCE", year);
      let added = 0;
      for (const d of docs) {
        const key = d.pdf_url.match(/PUB-\d+-\d+\.pdf/)?.[0];
        if (key && seenPdfs.has(key)) continue;
        if (key) seenPdfs.add(key);
        all.push(d);
        added++;
      }
      if (added > 0) {
        fs.writeFileSync(outPath, stringify(all, {
          header: true,
          columns: [
            "act_name", "year", "province", "legal_doc_type", "domain",
            "source_url", "pdf_url", "notes", "document_date", "gazette_number",
          ],
        }));
      }
      await new Promise(r => setTimeout(r, 1500));
    }

    // 3. Notifications
    console.log(`\n${"━".repeat(60)}`);
    console.log("  Phase 3: Notifications");
    console.log("━".repeat(60));

    const notifs = await scrapeNotifications(page);
    for (const d of notifs) {
      const key = d.pdf_url.match(/PUB-\d+-\d+\.pdf/)?.[0];
      if (key && seenPdfs.has(key)) continue;
      if (key) seenPdfs.add(key);
      all.push(d);
    }

    // Final write
    fs.writeFileSync(outPath, stringify(all, {
      header: true,
      columns: [
        "act_name", "year", "province", "legal_doc_type", "domain",
        "source_url", "pdf_url", "notes", "document_date", "gazette_number",
      ],
    }));

  } finally {
    await browser.close();
  }

  console.log("\n" + "═".repeat(60));
  console.log("  Discovery Complete");
  console.log("═".repeat(60));
  console.log(`  Total Sindh documents: ${all.length}`);
  console.log(`    Acts:          ${all.filter(d => d.legal_doc_type === "Act").length}`);
  console.log(`    Ordinances:    ${all.filter(d => d.legal_doc_type === "Ordinance").length}`);
  console.log(`    Notifications: ${all.filter(d => d.legal_doc_type === "Notification").length}`);
  console.log(`  CSV:           ${outPath}`);
  console.log("");
  console.log("  Sample (first 3):");
  all.slice(0, 3).forEach((d, i) => {
    console.log(`\n  [${i + 1}] ${d.act_name}`);
    console.log(`      Type:  ${d.legal_doc_type} | Year: ${d.year} | Domain: ${d.domain}`);
    console.log(`      Date:  ${d.document_date}`);
    console.log(`      PDF:   ${d.pdf_url}`);
  });
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
