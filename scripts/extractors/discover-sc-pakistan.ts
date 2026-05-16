/**
 * Supreme Court of Pakistan judgments discovery.
 * Site: https://www.supremecourt.gov.pk/judgements/
 * Strategy: walk recent judgments listing, capture each judgment's PDF + metadata.
 *
 * NOTE: This crawler is best-effort. SC site structure changes occasionally;
 * if the crawler finds 0 results, it's likely a structural change. The user
 * should report back and we'll adjust the selector.
 */

import fs from "fs";
import path from "path";
import * as cheerio from "cheerio";
import { stringify } from "csv-stringify/sync";
import { politeFetch } from "./shared/http";

const BASE = "https://www.supremecourt.gov.pk";
const LISTING_URLS = [
  `${BASE}/judgements/`,
  `${BASE}/recent-judgments/`,
  `${BASE}/latest-judgements/`,
];

type JudgmentRow = {
  act_name: string;       // we reuse act_name as "case title"
  year: string;
  province: string;
  legal_doc_type: string; // always "Judgment"
  domain: string;         // best-guess from title
  source_url: string;
  pdf_url: string;
  notes: string;          // includes citation, parties, date if extractable
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

function guessDomain(title: string): string {
  const t = title.toLowerCase();
  if (t.match(/tax|income|customs|revenue/)) return "Tax";
  if (t.match(/criminal|murder|theft|fraud|narcotic|terror/)) return "Criminal";
  if (t.match(/civil|contract|property|land/)) return "Civil";
  if (t.match(/famil|marri|divorce|custody/)) return "Family";
  if (t.match(/labour|employ|service/)) return "Labour";
  if (t.match(/bank|financ/)) return "Banking";
  if (t.match(/constitu|fundamental|article 199|article 184/)) return "Constitutional";
  if (t.match(/election/)) return "Constitutional";
  if (t.match(/compan|corporat/)) return "Corporate";
  return "General";
}

function extractYear(s: string): string {
  const m = s.match(/\b(19\d{2}|20\d{2})\b/);
  return m ? m[1] : "";
}

async function crawlListings(): Promise<Set<{ url: string; title: string }>> {
  const found = new Map<string, string>();
  for (const listing of LISTING_URLS) {
    try {
      console.log(`  Crawling ${listing}`);
      const res = await politeFetch(listing, { delayMs: 3000 });
      const html = await res.text();
      const $ = cheerio.load(html);
      $("a[href]").each((_, el) => {
        const href = ($(el).attr("href") ?? "").trim();
        const text = $(el).text().trim();
        if (!href || !text || text.length < 5) return;
        let full = href.startsWith("http") ? href : (href.startsWith("/") ? `${BASE}${href}` : `${BASE}/${href}`);
        // We want links that lead to judgment detail pages or direct PDFs
        if (full.toLowerCase().endsWith(".pdf") || /judgement|judgment|case/i.test(full)) {
          if (!found.has(full)) found.set(full, text);
        }
      });
    } catch (e) {
      console.warn(`  ⚠ ${(e as Error).message}`);
    }
  }
  return new Set(Array.from(found.entries()).map(([url, title]) => ({ url, title })));
}

async function extractPdfFromDetail(detailUrl: string): Promise<string | null> {
  if (detailUrl.toLowerCase().endsWith(".pdf")) return detailUrl;
  try {
    const res = await politeFetch(detailUrl, { delayMs: 2500 });
    const html = await res.text();
    const $ = cheerio.load(html);
    let pdfUrl: string | null = null;
    $("a[href$='.pdf']").each((_, el) => {
      if (pdfUrl) return;
      const href = ($(el).attr("href") ?? "").trim();
      pdfUrl = href.startsWith("http") ? href : (href.startsWith("/") ? `${BASE}${href}` : `${BASE}/${href}`);
    });
    return pdfUrl;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs();
  const outPath = path.resolve(process.cwd(), args["out"] ?? "data/seeds/pakistan-sc-judgments.csv");
  const limit = parseInt(args["limit"] ?? "1000", 10);

  console.log("═".repeat(60));
  console.log("  Supreme Court of Pakistan — Judgment Discovery");
  console.log("═".repeat(60));

  const candidates = await crawlListings();
  console.log(`\n  Found ${candidates.size} judgment candidates\n`);

  const rows: JudgmentRow[] = [];
  let i = 0;
  for (const { url, title } of candidates) {
    if (rows.length >= limit) break;
    i++;
    console.log(`  [${i}/${candidates.size}] ${title.slice(0, 60)}`);
    const pdfUrl = await extractPdfFromDetail(url);
    if (!pdfUrl) continue;
    rows.push({
      act_name: title,
      year: extractYear(title),
      province: "Federal",
      legal_doc_type: "Judgment",
      domain: guessDomain(title),
      source_url: url,
      pdf_url: pdfUrl,
      notes: "court=SupremeCourt",
    });
    if (rows.length % 20 === 0) writeCsv(outPath, rows);
  }
  writeCsv(outPath, rows);
  console.log(`\n  Done. ${rows.length} SC judgments → ${outPath}`);
}

function writeCsv(outPath: string, rows: JudgmentRow[]) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, stringify(rows, {
    header: true,
    columns: ["act_name", "year", "province", "legal_doc_type", "domain", "source_url", "pdf_url", "notes"],
  }));
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
