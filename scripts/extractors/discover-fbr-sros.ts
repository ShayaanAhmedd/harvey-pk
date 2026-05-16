/**
 * FBR SRO (Statutory Regulatory Order) discovery.
 * Site: https://www.fbr.gov.pk/categ/sros/...
 * Strategy: walk SRO listing pages, capture each SRO's PDF URL + year.
 */

import fs from "fs";
import path from "path";
import * as cheerio from "cheerio";
import { stringify } from "csv-stringify/sync";
import { politeFetch } from "./shared/http";

const BASE = "https://www.fbr.gov.pk";
const LISTING_URLS = [
  `${BASE}/categ/sros/51149/131178/`,
  `${BASE}/categ/sros/`,
  `${BASE}/sros`,
];

type Row = {
  act_name: string;
  year: string;
  province: string;
  legal_doc_type: string;
  domain: string;
  source_url: string;
  pdf_url: string;
  notes: string;
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

function extractYear(s: string): string {
  const m = s.match(/\b(19\d{2}|20\d{2})\b/);
  return m ? m[1] : "";
}

async function crawlListing(url: string): Promise<Row[]> {
  const rows: Row[] = [];
  try {
    const res = await politeFetch(url, { delayMs: 3000 });
    const html = await res.text();
    const $ = cheerio.load(html);
    $("a[href]").each((_, el) => {
      const href = ($(el).attr("href") ?? "").trim();
      const text = $(el).text().trim();
      if (!href || !text) return;
      const full = href.startsWith("http") ? href : (href.startsWith("/") ? `${BASE}${href}` : `${BASE}/${href}`);
      if (full.toLowerCase().endsWith(".pdf")) {
        rows.push({
          act_name: text || `SRO ${full.split("/").pop()}`,
          year: extractYear(text || full),
          province: "Federal",
          legal_doc_type: "SRO",
          domain: "Tax",
          source_url: url,
          pdf_url: full,
          notes: "fbr-sro",
        });
      }
    });
  } catch (e) {
    console.warn(`  ⚠ ${(e as Error).message}`);
  }
  return rows;
}

async function main() {
  const args = parseArgs();
  const outPath = path.resolve(process.cwd(), args["out"] ?? "data/seeds/pakistan-fbr-sros.csv");
  const limit = parseInt(args["limit"] ?? "5000", 10);

  console.log("═".repeat(60));
  console.log("  FBR SRO Discovery");
  console.log("═".repeat(60));

  const all = new Map<string, Row>();
  for (const listingUrl of LISTING_URLS) {
    console.log(`\n  Crawling ${listingUrl}`);
    const rows = await crawlListing(listingUrl);
    for (const r of rows) {
      if (!all.has(r.pdf_url)) all.set(r.pdf_url, r);
      if (all.size >= limit) break;
    }
    if (all.size >= limit) break;
  }

  const finalRows = Array.from(all.values());
  writeCsv(outPath, finalRows);
  console.log(`\n  Done. ${finalRows.length} FBR SROs → ${outPath}`);
}

function writeCsv(outPath: string, rows: Row[]) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, stringify(rows, {
    header: true,
    columns: ["act_name", "year", "province", "legal_doc_type", "domain", "source_url", "pdf_url", "notes"],
  }));
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
