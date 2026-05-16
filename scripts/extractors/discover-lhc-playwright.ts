/**
 * Lahore High Court reported-judgments discovery via Playwright.
 *
 * Walks data.lhc.gov.pk/reported_judgments/judgments_approved_for_reporting,
 * parses each row's metadata, and writes a CSV. Does NOT download PDFs —
 * that's a separate extraction phase.
 *
 * Verified from earlier investigation:
 *   - PDF host: sys.lhc.gov.pk/appjudgments/<YEAR>LHC<NUMBER>.pdf
 *   - Pagination: ?page=N (0-indexed Drupal pager), 50 per page
 *   - Row text template:
 *       "<CASE_TYPE> <CASE_NUMBER> (<PARTIES>) by <JUDGE>
 *        [Tag Line: <TAGLINE>] uploaded on: DD-MM-YYYY"
 */

import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { stringify } from "csv-stringify/sync";

const BASE_URL = "https://data.lhc.gov.pk/reported_judgments/judgments_approved_for_reporting";

type LHCJudgment = {
  act_name: string;        // Display title: case type + case number + parties
  year: string;            // From PDF filename or judgment_date
  province: string;        // "Punjab"
  legal_doc_type: string;  // "Judgment"
  domain: string;          // Inferred from case type
  source_url: string;      // Listing page URL
  pdf_url: string;         // Direct PDF URL
  notes: string;           // "lhc-judgment"
  court: string;           // "LahoreHighCourt"
  case_citation: string;   // e.g. "2026 LHC 3047"
  case_type: string;       // e.g. "Civil Revision"
  case_number: string;     // e.g. "56442/21"
  parties: string;         // Extracted from parens
  judges: string;          // Extracted after "by"
  tagline: string;         // Optional, between "Tag Line:" and "uploaded on:"
  judgment_date: string;   // ISO YYYY-MM-DD
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

function extractCitation(pdfUrl: string): string {
  // sys.lhc.gov.pk/appjudgments/2026LHC3047.pdf → "2026 LHC 3047"
  const m = pdfUrl.match(/\/(\d{4})LHC(\d+)\.pdf$/i);
  return m ? `${m[1]} LHC ${m[2]}` : "";
}

function extractYearFromPdfUrl(pdfUrl: string): string {
  const m = pdfUrl.match(/\/(\d{4})LHC/i);
  return m ? m[1] : "";
}

function parseDate(text: string): string {
  // Look for "uploaded on: DD-MM-YYYY"
  const m = text.match(/uploaded\s+on:\s*(\d{2})-(\d{2})-(\d{4})/i);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return "";
}

function parseRowMetadata(rowText: string, _pdfUrl: string): Partial<LHCJudgment> {
  // Template: "<CASE_TYPE> <CASE_NUMBER> (<PARTIES>) by <JUDGE> [Tag Line: <TAGLINE>] uploaded on: DD-MM-YYYY"
  const out: Partial<LHCJudgment> = {};

  // Find ALL balanced-paren groups in order
  const parenGroups: { start: number; end: number; content: string }[] = [];
  let depth = 0;
  let parenStart = -1;
  for (let i = 0; i < rowText.length; i++) {
    if (rowText[i] === "(") {
      if (depth === 0) parenStart = i;
      depth++;
    } else if (rowText[i] === ")") {
      depth--;
      if (depth === 0 && parenStart >= 0) {
        parenGroups.push({
          start: parenStart,
          end: i,
          content: rowText.slice(parenStart + 1, i),
        });
        parenStart = -1;
      }
    }
  }

  // Find the parties group: the first group that either is long (>= 40 chars)
  // OR contains "Vs"/"VS" (party separator). Short, no-Vs groups are case-type
  // descriptions like "(Income Tax Reference)".
  let partiesGroup: typeof parenGroups[0] | null = null;
  for (const g of parenGroups) {
    if (g.content.length >= 40 || /\bvs?\b/i.test(g.content)) {
      partiesGroup = g;
      break;
    }
  }

  // Fallback: if no group looks like parties, use the first non-empty one
  if (!partiesGroup && parenGroups.length > 0) {
    partiesGroup = parenGroups[0];
  }

  out.parties = partiesGroup?.content.trim() ?? "";

  // Extract case_type + case_number: text BEFORE the parties paren group,
  // but cleaned of any earlier descriptive parens like "(Income Tax Reference)"
  if (partiesGroup) {
    const beforePartiesText = rowText.slice(0, partiesGroup.start).trim();

    // Find case_number: the LAST whitespace-separated token that contains a digit
    // (often slash-separated like "56442/21" or hyphenated like "6-26")
    const numMatch = beforePartiesText.match(/^(.+?)\s+(\S*\d\S*)\s*$/);
    if (numMatch) {
      out.case_type = numMatch[1].trim();
      out.case_number = numMatch[2].trim();
    } else {
      // No clear case number — entire pre-parties text is case_type
      out.case_type = beforePartiesText;
      out.case_number = "";
    }
  }

  // Extract judge: text after the first ") by " up to "Tag Line:" or "uploaded on:"
  const judgeMatch = rowText.match(/\)\s+by\s+(.+?)(?=\s*(?:Tag Line:|uploaded on:|$))/i);
  out.judges = judgeMatch ? judgeMatch[1].trim() : "";

  // Extract tagline: between "Tag Line:" and "uploaded on:"
  const taglineMatch = rowText.match(/Tag\s+Line:\s*(.+?)(?=\s*uploaded\s+on:|$)/i);
  out.tagline = taglineMatch ? taglineMatch[1].trim() : "";

  // Extract date
  out.judgment_date = parseDate(rowText);

  return out;
}

function guessDomain(caseType: string, parties: string): string {
  const t = `${caseType} ${parties}`.toLowerCase();
  if (/tax|customs|revenue|sales|excise|inland/.test(t)) return "Tax";
  if (/criminal|murder|narcotic|terror|ata|crpc|qatl/.test(t)) return "Criminal";
  if (/civil|contract|property|specific relief|tenancy/.test(t)) return "Civil";
  if (/famil|marri|divorce|nikah|guardian/.test(t)) return "Family";
  if (/constitu|writ|article 199|fundamental right/.test(t)) return "Constitutional";
  if (/service|civil servant|tribunal/.test(t)) return "Service";
  if (/banking|company|finance|securities/.test(t)) return "Commercial";
  return "General";
}

async function main() {
  const args = parseArgs();
  const outPath = path.resolve(process.cwd(), args["out"] ?? "data/seeds/pakistan-lhc.csv");
  const maxPages = args["max-pages"] ? parseInt(args["max-pages"], 10) : 1000;
  const resume = args["resume"] === "true";

  console.log("═".repeat(60));
  console.log("  Lahore High Court — Reported Judgments Discovery");
  console.log("═".repeat(60));
  console.log(`  Listing URL: ${BASE_URL}`);
  console.log(`  Max pages:   ${maxPages}`);
  console.log(`  Output CSV:  ${outPath}`);
  console.log(`  Resume:      ${resume}`);

  // Load existing CSV if resuming
  const all: LHCJudgment[] = [];
  const seenPdfs = new Set<string>();

  if (resume && fs.existsSync(outPath)) {
    const existing = fs.readFileSync(outPath, "utf-8").split("\n").slice(1);
    console.log(`  Resuming with ${existing.length} existing rows`);
    for (const line of existing) {
      const m = line.match(/https:\/\/sys\.lhc\.gov\.pk\/appjudgments\/(\d{4}LHC\d+)\.pdf/);
      if (m) seenPdfs.add(m[1]);
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

  // Warm up the session by visiting the bare archive URL first.
  // This sets any session cookies Drupal needs for pagination.
  console.log("Warming up session...");
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  let lastFirstPdf: string = "";

  try {
    for (let pageNum = 0; pageNum < maxPages; pageNum++) {
      // Force a hard navigation to a known-fresh URL pattern.
      // Use ?page=N format consistently (page=0 is also valid in Drupal pager,
      // not just the bare URL).
      const pageUrl = `${BASE_URL}?page=${pageNum}`;
      console.log(`\n[Page ${pageNum + 1}] ${pageUrl}`);

      try {
        await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await new Promise(r => setTimeout(r, 2500));

        // Extract PDF rows. Each PDF anchor's parent has the metadata text.
        const rows = await page.$$eval('a[href*="sys.lhc.gov.pk/appjudgments"]', els =>
          els.map(e => {
            // Walk up to find the parent that contains both the anchor AND the metadata
            let parent = e.parentElement;
            for (let i = 0; i < 5 && parent; i++) {
              const text = (parent.textContent ?? "").trim();
              if (text.length > 50 && /uploaded\s+on:|by\s+/i.test(text)) {
                return {
                  href: (e as HTMLAnchorElement).href,
                  rowText: text.replace(/\s+/g, " ").slice(0, 1000),
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

        if (rows.length === 0) {
          console.log(`  No PDF rows found — end of archive`);
          break;
        }

        // Fingerprint check: compare this page's first PDF URL to the previous
        // page's first PDF URL. If they match, pagination is broken — abort.
        const firstPdfThisPage = rows[0]?.href ?? "";
        if (lastFirstPdf && firstPdfThisPage === lastFirstPdf) {
          console.log(`  ⚠ Same first PDF as previous page (${firstPdfThisPage})`);
          console.log(`  ⚠ Pagination appears broken. Stopping.`);
          break;
        }
        lastFirstPdf = firstPdfThisPage;

        let added = 0;
        let skipped = 0;
        for (const r of rows) {
          const m = r.href.match(/\/(\d{4}LHC\d+)\.pdf$/i);
          if (!m) continue;
          const key = m[1];

          if (seenPdfs.has(key)) {
            skipped++;
            continue;
          }
          seenPdfs.add(key);

          const meta = parseRowMetadata(r.rowText, r.href);
          const citation = extractCitation(r.href);
          const year = extractYearFromPdfUrl(r.href) || (meta.judgment_date?.slice(0, 4) ?? "");

          const displayTitle = [
            meta.case_type,
            meta.case_number,
            meta.parties ? `(${meta.parties})` : "",
          ].filter(Boolean).join(" ").slice(0, 250);

          all.push({
            act_name: displayTitle,
            year,
            province: "Punjab",
            legal_doc_type: "Judgment",
            domain: guessDomain(meta.case_type ?? "", meta.parties ?? ""),
            source_url: pageUrl,
            pdf_url: r.href,
            notes: "lhc-judgment",
            court: "LahoreHighCourt",
            case_citation: citation,
            case_type: meta.case_type ?? "",
            case_number: meta.case_number ?? "",
            parties: meta.parties ?? "",
            judges: meta.judges ?? "",
            tagline: meta.tagline ?? "",
            judgment_date: meta.judgment_date ?? "",
          });
          added++;
        }

        console.log(`  + ${added} new, ${skipped} already seen. Total: ${all.length}`);

        // Save progress every page
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, stringify(all, {
          header: true,
          columns: [
            "act_name", "year", "province", "legal_doc_type", "domain",
            "source_url", "pdf_url", "notes", "court", "case_citation",
            "case_type", "case_number", "parties", "judges", "tagline",
            "judgment_date",
          ],
        }));

        // Stop if this page had no new rows (we've crawled the entire archive)
        if (added === 0 && skipped > 0) {
          console.log(`  All rows on this page already seen — likely end of archive (or duplicates)`);
          break;
        }

        // Polite delay between pages
        await new Promise(r => setTimeout(r, 2500));

      } catch (e) {
        console.error(`  Error on page ${pageNum + 1}: ${(e as Error).message}`);
        // Save what we have and continue
        continue;
      }
    }
  } finally {
    await browser.close();
  }

  console.log("\n" + "═".repeat(60));
  console.log("  Discovery Complete");
  console.log("═".repeat(60));
  console.log(`  Total judgments discovered: ${all.length}`);
  console.log(`  CSV saved to: ${outPath}`);
  console.log("");
  console.log("  Sample (first 3 rows):");
  all.slice(0, 3).forEach((j, i) => {
    console.log(`\n  [${i + 1}] ${j.case_citation}`);
    console.log(`      Case Type: ${j.case_type}`);
    console.log(`      Case No:   ${j.case_number}`);
    console.log(`      Parties:   ${j.parties.slice(0, 100)}`);
    console.log(`      Judge:     ${j.judges}`);
    console.log(`      Date:      ${j.judgment_date}`);
    console.log(`      Domain:    ${j.domain}`);
    console.log(`      PDF:       ${j.pdf_url}`);
  });
  console.log("");
  console.log("Next: Review CSV, then run extraction phase.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
