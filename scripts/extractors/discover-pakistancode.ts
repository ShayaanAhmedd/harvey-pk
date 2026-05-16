/**
 * Pakistani federal Acts discovery crawler.
 * URL pattern (verified):
 *   - Alphabetical index: /english/LGu0xAD.php?alp=<LETTER>&page=<N>&action=<primary|secondary>
 *   - Act detail page:    /english/UY2FqaJw1-...-sg-jjjjjjjjjjjjj
 *   - PDF download:       /pdffiles/administrator<hash>.pdf
 */

import fs from "fs";
import path from "path";
import * as cheerio from "cheerio";
import { stringify } from "csv-stringify/sync";
import { politeFetch } from "./shared/http";

const BASE = "https://pakistancode.gov.pk";
const ALPHA_INDEX = `${BASE}/english/LGu0xAD.php`;

type DiscoveredAct = {
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
  const m = s.match(/\b(1[89]\d{2}|20\d{2})\b/);
  return m ? m[1] : "";
}

function guessDocType(title: string, action: string): string {
  const t = title.toLowerCase();
  if (action === "secondary") {
    if (t.includes("rules")) return "Rule";
    if (t.includes("regulation")) return "Regulation";
    if (t.includes("notification")) return "Notification";
    if (t.includes("order")) return "Order";
    return "Regulation";
  }
  if (t.includes("ordinance")) return "Ordinance";
  if (t.includes("constitution")) return "Constitutional";
  return "Act";
}

function guessDomain(title: string): string {
  const t = title.toLowerCase();
  if (t.match(/tax|income|customs|excise|fbr|revenue|federal board/)) return "Tax";
  if (t.match(/compan|corporat|securit/)) return "Corporate";
  if (t.match(/labour|labor|employ|workman|wage|industrial relations/)) return "Labour";
  if (t.match(/penal|criminal|cr\.?p\.?c|crime|anti-terror|narcotic/)) return "Criminal";
  if (t.match(/civil procedure|c\.?p\.?c|contract|sale of goods|specific relief/)) return "Civil";
  if (t.match(/land|tenancy|property|registration|stamp/)) return "Land";
  if (t.match(/famil|marri|guardian|divorce|dissolution|hudood|qisas|diyat/)) return "Family";
  if (t.match(/bank|financ|monetary|loan|state bank/)) return "Banking";
  if (t.match(/health|medical|drug|pharma|hospital/)) return "Health";
  if (t.match(/educat|school|universit|college/)) return "Education";
  if (t.match(/election|constitu|representation/)) return "Constitutional";
  if (t.match(/environ|pollut|forest|wildlife/)) return "Environment";
  if (t.match(/local govt|municip|district|cantonment/)) return "LocalGovt";
  if (t.match(/telecom|media|broadcast|pemra|electronic crime|peca/)) return "TechMedia";
  return "General";
}

async function fetchIndexPage(letter: string, page: number, action: string): Promise<string> {
  const url = `${ALPHA_INDEX}?alp=${letter}&page=${page}&action=${action}`;
  const res = await politeFetch(url, { delayMs: 2500 });
  return res.text();
}

function extractActLinksFromIndex($: cheerio.CheerioAPI): { url: string; title: string }[] {
  const out: { url: string; title: string }[] = [];
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    const text = $(el).text().trim();
    if (!href) return;
    if (!/-sg-j+$/i.test(href)) return;
    const full = href.startsWith("http") ? href : `${BASE}${href.startsWith("/") ? "" : "/english/"}${href}`;
    if (text.length > 3) out.push({ url: full, title: text });
  });
  return out;
}

async function extractPdfUrl(actPageUrl: string): Promise<string | null> {
  try {
    const res = await politeFetch(actPageUrl, { delayMs: 2500 });
    const html = await res.text();
    const $ = cheerio.load(html);
    let pdfUrl: string | null = null;
    $("a[href]").each((_, el) => {
      if (pdfUrl) return;
      const href = ($(el).attr("href") ?? "").trim();
      if (/\.pdf(\?|$)/i.test(href) && href.includes("/pdffiles/")) {
        pdfUrl = href.startsWith("http") ? href : `${BASE}${href.startsWith("/") ? "" : "/"}${href}`;
      }
    });
    return pdfUrl;
  } catch (e) {
    console.warn(`    ⚠ Detail fetch failed: ${(e as Error).message}`);
    return null;
  }
}

async function crawlLetter(letter: string, action: string, maxPerLetter: number): Promise<DiscoveredAct[]> {
  const found: DiscoveredAct[] = [];
  let page = 1, emptyStreak = 0;
  while (page <= 20 && emptyStreak < 2 && found.length < maxPerLetter) {
    console.log(`  📄 [${letter}/${action}] page ${page}`);
    let html: string;
    try { html = await fetchIndexPage(letter, page, action); }
    catch (e) { console.warn(`    ⚠ ${(e as Error).message}`); break; }
    const $ = cheerio.load(html);
    const links = extractActLinksFromIndex($);
    if (links.length === 0) { emptyStreak++; page++; continue; }
    emptyStreak = 0;
    for (const { url, title } of links) {
      if (found.length >= maxPerLetter) break;
      const pdfUrl = await extractPdfUrl(url);
      if (!pdfUrl) continue;
      found.push({
        act_name: title,
        year: extractYear(title),
        province: "Federal",
        legal_doc_type: guessDocType(title, action),
        domain: guessDomain(title),
        source_url: url,
        pdf_url: pdfUrl,
        notes: action === "secondary" ? "subordinate-legislation" : "",
      });
      console.log(`    ✓ ${title.slice(0, 70)}${title.length > 70 ? "..." : ""}`);
    }
    page++;
  }
  return found;
}

function writeCsv(outPath: string, rows: DiscoveredAct[]) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, stringify(rows, {
    header: true,
    columns: ["act_name", "year", "province", "legal_doc_type", "domain", "source_url", "pdf_url", "notes"],
  }));
}

async function main() {
  const args = parseArgs();
  const outPath = path.resolve(process.cwd(), args["out"] ?? "data/seeds/pakistan-federal.csv");
  const letters = (args["letters"] ?? "ABCDEFGHIJKLMNOPQRSTUVWXYZ").toUpperCase().split("");
  const actions = (args["actions"] ?? "primary,secondary").split(",");
  const maxPerLetter = parseInt(args["max-per-letter"] ?? "300", 10);

  console.log("═".repeat(60));
  console.log("  Pakistan Federal Discovery v2");
  console.log("═".repeat(60));
  const all: DiscoveredAct[] = [];
  const seen = new Set<string>();
  for (const action of actions) {
    console.log(`\n▶ action=${action}`);
    for (const letter of letters) {
      console.log(`\n[Letter ${letter}/${action}]`);
      const found = await crawlLetter(letter, action, maxPerLetter);
      for (const f of found) {
        if (seen.has(f.source_url)) continue;
        seen.add(f.source_url);
        all.push(f);
      }
      writeCsv(outPath, all);
      console.log(`  ↳ +${found.length} this letter, total: ${all.length}`);
    }
  }
  console.log("\n" + "═".repeat(60));
  console.log(`  Done. ${all.length} federal docs discovered → ${outPath}`);
}
main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
