/**
 * Generic provincial code discovery.
 * Each province's website has a different structure, so we use a config
 * map. The crawler walks the province's "all acts" index, finds Act links,
 * extracts PDF URLs.
 *
 * Note: Provincial websites are MUCH less consistent than pakistancode.gov.pk.
 * This crawler uses heuristics — it will find SOME acts. The user can
 * supplement by manually adding rows to the CSV.
 */

import fs from "fs";
import path from "path";
import * as cheerio from "cheerio";
import { stringify } from "csv-stringify/sync";
import { politeFetch } from "./shared/http";

type ProvinceConfig = {
  province: string;
  indexUrls: string[];           // entry pages to crawl
  actLinkPattern: RegExp;        // links that look like Act pages
  pdfLinkSelector: string;       // CSS selector for PDF on Act page
  baseUrl: string;
};

const CONFIGS: Record<string, ProvinceConfig> = {
  Punjab: {
    province: "Punjab",
    indexUrls: [
      "https://punjabcode.punjab.gov.pk/",
      "https://punjabcode.punjab.gov.pk/laws",
      "https://punjabcode.punjab.gov.pk/public/legacy",
    ],
    actLinkPattern: /punjabcode\.punjab\.gov\.pk\/.*(act|ordinance|rule|regulation)/i,
    pdfLinkSelector: "a[href$='.pdf'], a[href*='.pdf?']",
    baseUrl: "https://punjabcode.punjab.gov.pk",
  },
  Sindh: {
    province: "Sindh",
    indexUrls: [
      "https://sindhcode.gos.pk/",
      "https://sindhcode.gos.pk/laws",
    ],
    actLinkPattern: /sindhcode\.gos\.pk\/.*(act|ordinance|rule|regulation)/i,
    pdfLinkSelector: "a[href$='.pdf'], a[href*='.pdf?']",
    baseUrl: "https://sindhcode.gos.pk",
  },
  KP: {
    province: "KP",
    indexUrls: [
      "https://kpcode.kp.gov.pk/",
      "http://kpcode.kp.gov.pk/",
    ],
    actLinkPattern: /kpcode\.kp\.gov\.pk\/.*(act|ordinance|rule|regulation)/i,
    pdfLinkSelector: "a[href$='.pdf'], a[href*='.pdf?']",
    baseUrl: "https://kpcode.kp.gov.pk",
  },
  Balochistan: {
    province: "Balochistan",
    indexUrls: [
      "https://balochistancode.gob.pk/",
      "https://balochistanlaws.gob.pk/",
    ],
    actLinkPattern: /balochistan(code|laws)\.gob\.pk\/.*(act|ordinance|rule|regulation)/i,
    pdfLinkSelector: "a[href$='.pdf'], a[href*='.pdf?']",
    baseUrl: "https://balochistancode.gob.pk",
  },
  ICT: {
    province: "ICT",
    indexUrls: [
      "https://ictadministration.gov.pk/",
    ],
    actLinkPattern: /ictadministration\.gov\.pk\/.*\.pdf$/i,
    pdfLinkSelector: "a[href$='.pdf']",
    baseUrl: "https://ictadministration.gov.pk",
  },
  AJK: {
    province: "AJK",
    indexUrls: [
      "https://ajk.gov.pk/",
      "https://ajklaw.gov.pk/",
    ],
    actLinkPattern: /ajk(law)?\.gov\.pk\/.*(act|ordinance|rule|regulation|\.pdf)/i,
    pdfLinkSelector: "a[href$='.pdf']",
    baseUrl: "https://ajk.gov.pk",
  },
  GB: {
    province: "GB",
    indexUrls: [
      "https://gilgitbaltistan.gov.pk/",
    ],
    actLinkPattern: /gilgitbaltistan\.gov\.pk\/.*(act|law|\.pdf)/i,
    pdfLinkSelector: "a[href$='.pdf']",
    baseUrl: "https://gilgitbaltistan.gov.pk",
  },
};

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
  const m = s.match(/\b(1[89]\d{2}|20\d{2})\b/);
  return m ? m[1] : "";
}

function guessDocType(title: string): string {
  const t = title.toLowerCase();
  if (t.includes("ordinance")) return "Ordinance";
  if (t.includes("rules")) return "Rule";
  if (t.includes("regulation")) return "Regulation";
  if (t.includes("notification")) return "Notification";
  if (t.includes("order")) return "Order";
  return "Act";
}

function guessDomain(title: string): string {
  const t = title.toLowerCase();
  if (t.match(/tax|revenue|excise/)) return "Tax";
  if (t.match(/labour|wage/)) return "Labour";
  if (t.match(/land|tenancy|property/)) return "Land";
  if (t.match(/local govt|municip|district/)) return "LocalGovt";
  if (t.match(/famil|marri/)) return "Family";
  if (t.match(/criminal|penal/)) return "Criminal";
  if (t.match(/civil/)) return "Civil";
  if (t.match(/health|medical/)) return "Health";
  if (t.match(/educat|school/)) return "Education";
  if (t.match(/environ|forest/)) return "Environment";
  return "General";
}

async function crawlIndex(config: ProvinceConfig): Promise<Set<string>> {
  const actPages = new Set<string>();
  for (const indexUrl of config.indexUrls) {
    try {
      console.log(`  Crawling index: ${indexUrl}`);
      const res = await politeFetch(indexUrl, { delayMs: 2500 });
      const html = await res.text();
      const $ = cheerio.load(html);
      $("a[href]").each((_, el) => {
        let href = ($(el).attr("href") ?? "").trim();
        if (!href) return;
        if (href.startsWith("/")) href = config.baseUrl + href;
        if (!href.startsWith("http")) return;
        if (config.actLinkPattern.test(href) || href.toLowerCase().endsWith(".pdf")) {
          actPages.add(href);
        }
      });
    } catch (e) {
      console.warn(`  ⚠ Index fetch failed: ${(e as Error).message}`);
    }
  }
  return actPages;
}

async function extractFromActPage(actUrl: string, config: ProvinceConfig): Promise<Row | null> {
  // If the URL is already a PDF, return it directly
  if (actUrl.toLowerCase().endsWith(".pdf")) {
    const name = decodeURIComponent(actUrl.split("/").pop() || "").replace(/\.pdf$/i, "").replace(/[-_]/g, " ");
    return {
      act_name: name || "Unknown",
      year: extractYear(name),
      province: config.province,
      legal_doc_type: guessDocType(name),
      domain: guessDomain(name),
      source_url: actUrl,
      pdf_url: actUrl,
      notes: "direct-pdf-link",
    };
  }

  try {
    const res = await politeFetch(actUrl, { delayMs: 2500 });
    const html = await res.text();
    const $ = cheerio.load(html);
    const title = ($("title").text() || $("h1").first().text() || $("h2").first().text()).trim();
    if (!title || title.length < 3) return null;
    const pdfHref = $(config.pdfLinkSelector).first().attr("href") ?? "";
    if (!pdfHref) return null;
    const pdfUrl = pdfHref.startsWith("http") ? pdfHref : config.baseUrl + (pdfHref.startsWith("/") ? "" : "/") + pdfHref;
    return {
      act_name: title.replace(/\s*[-|]\s*.*$/, "").trim(),
      year: extractYear(title),
      province: config.province,
      legal_doc_type: guessDocType(title),
      domain: guessDomain(title),
      source_url: actUrl,
      pdf_url: pdfUrl,
      notes: "",
    };
  } catch (e) {
    console.warn(`  ⚠ Act page failed: ${(e as Error).message}`);
    return null;
  }
}

async function main() {
  const args = parseArgs();
  const provinceKey = args["province"];
  if (!provinceKey || !CONFIGS[provinceKey]) {
    console.error("Usage: --province <Punjab|Sindh|KP|Balochistan|ICT|AJK|GB> [--out <path>]");
    process.exit(1);
  }
  const config = CONFIGS[provinceKey];
  const outPath = path.resolve(process.cwd(), args["out"] ?? `data/seeds/pakistan-${provinceKey.toLowerCase()}.csv`);

  console.log("═".repeat(60));
  console.log(`  Provincial Discovery — ${config.province}`);
  console.log("═".repeat(60));

  const actPages = await crawlIndex(config);
  console.log(`\n  Found ${actPages.size} candidate pages\n`);

  const rows: Row[] = [];
  const seenPdfs = new Set<string>();
  for (const url of actPages) {
    const row = await extractFromActPage(url, config);
    if (!row) continue;
    if (seenPdfs.has(row.pdf_url)) continue;
    seenPdfs.add(row.pdf_url);
    rows.push(row);
    console.log(`    ✓ ${row.act_name.slice(0, 70)}`);
    // Save progressively
    if (rows.length % 20 === 0) writeCsv(outPath, rows);
  }
  writeCsv(outPath, rows);
  console.log(`\n  Done. ${rows.length} docs → ${outPath}`);
}

function writeCsv(outPath: string, rows: Row[]) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, stringify(rows, {
    header: true,
    columns: ["act_name", "year", "province", "legal_doc_type", "domain", "source_url", "pdf_url", "notes"],
  }));
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
