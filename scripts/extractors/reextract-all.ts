/**
 * Generalized re-extraction script.
 * For each Act marked partial/missing in completeness.json:
 *   1. Look up source_url + pdf_url from pakistan-federal.csv
 *   2. Download PDF (cache-busted if invalid)
 *   3. Extract with pdfjs-dist (OCR fallback)
 *   4. Split into sections
 *   5. Save chunks JSON
 *   6. Embed and insert into Supabase tagged 'pdfjs-reextract'
 *   7. Update progress in data/audits/reextract-progress.json
 *
 * Resumable: skips Acts marked done in progress file.
 * Sequential: processes one Act at a time to avoid overload.
 *
 * Function bodies for extractPdfWithPdfjs, splitIntoSections, downloadPdf,
 * ocrPage, and cleanText are COPIED verbatim from the proven PPC pipeline
 * (scripts/extractors/reextract-pdfjs.ts and insert-reextracted-chunks.ts).
 * Those source files are left untouched to preserve their separate main()s.
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { parse } from "csv-parse/sync";
import { createClient } from "@supabase/supabase-js";
import { embedTextLocal } from "../../lib/local-embeddings";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

type CompletenessReport = Array<{
  label: string;
  pattern: string;
  actual_act_name: string | null;
  chunks: number;
  unique_sections: number;
  expected_sections: number;
  coverage_pct: number;
  status: "complete" | "partial" | "missing";
}>;

type CsvRow = {
  act_name: string;
  year: string;
  province: string;
  legal_doc_type: string;
  domain: string;
  source_url: string;
  pdf_url: string;
  notes: string;
};

type ExtractedChunk = {
  section_number: string;
  title: string;
  content: string;
};

type ProgressEntry = {
  label: string;
  status: "pending" | "downloading" | "extracting" | "inserting" | "done" | "failed";
  started_at?: string;
  finished_at?: string;
  chunks_extracted?: number;
  chunks_inserted?: number;
  error?: string;
};

type ProgressFile = {
  started_at: string;
  last_updated: string;
  acts: Record<string, ProgressEntry>;
};

// ── extractPdfWithPdfjs (copied from reextract-pdfjs.ts) ─────────────────────

async function extractPdfWithPdfjs(pdfBuffer: Buffer): Promise<string> {
  // Use pdfjs-dist's legacy build for Node.js compatibility
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  // Disable worker (we run synchronously in Node)
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;

  const pageTexts: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    try {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const items = textContent.items as Array<{ str: string }>;
      const pageText = items.map(it => it.str).join(" ");

      if (pageText.trim().length < 100) {
        console.log(`    Page ${i}: only ${pageText.trim().length} chars from pdfjs, falling back to OCR`);
        const ocrText = await ocrPage(page);
        pageTexts.push(ocrText);
      } else {
        pageTexts.push(pageText);
      }
    } catch (e) {
      console.warn(`    Page ${i} extraction failed: ${(e as Error).message}`);
      pageTexts.push("");
    }
  }

  return pageTexts.join("\n\n");
}

async function ocrPage(page: any): Promise<string> {
  try {
    const viewport = page.getViewport({ scale: 2.0 });
    const { createCanvas } = await import("canvas");
    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext("2d");

    await page.render({ canvasContext: ctx as any, viewport }).promise;
    const imageBuffer = canvas.toBuffer("image/png");

    const tesseract = await import("tesseract.js");
    const { data } = await tesseract.recognize(imageBuffer, "eng");
    return data.text;
  } catch (e) {
    console.warn(`    OCR failed: ${(e as Error).message}`);
    return "";
  }
}

// ── splitIntoSections (copied from reextract-pdfjs.ts) ──────────────────────

function splitIntoSections(fullText: string): ExtractedChunk[] {
  // Section header anchor: start of string OR 2+ whitespace chars before number.
  // Tolerates footnote prefix like "1 [299. ..." (Pakistan statute amendment notation).
  // Section number can be plain (302), lettered (302A), or hyphen-lettered (489-F).
  // Followed by optional spaces, a period, then 1+ spaces, then a capital letter
  // (which indicates a title, not another section number — filters out cross-references).
  const headerRegex = /(?:^|\s{2,})(?:\d+\s*\[)?(\d{1,4}[A-Z]?(?:-[A-Z]{1,2})?)\s*\.\s+(?=[A-Z])/g;

  type Match = { section: string; startIdx: number; headerEndIdx: number };
  const allMatches: Match[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRegex.exec(fullText)) !== null) {
    allMatches.push({
      section: m[1].toUpperCase(),
      startIdx: m.index,
      headerEndIdx: m.index + m[0].length,
    });
  }

  if (allMatches.length === 0) {
    console.warn("    No section headers matched by regex");
    return [];
  }

  console.log(`    Raw header matches: ${allMatches.length}`);

  // Filter out TOC entries: if the gap to the next match is < 150 chars,
  // this header is likely in a list/index, not a real section body.
  const MIN_BODY_LENGTH = 150;
  const realSections: Match[] = [];
  for (let i = 0; i < allMatches.length; i++) {
    const cur = allMatches[i];
    const next = allMatches[i + 1];
    const bodyEnd = next ? next.startIdx : fullText.length;
    const bodyLength = bodyEnd - cur.headerEndIdx;
    if (bodyLength >= MIN_BODY_LENGTH) {
      realSections.push(cur);
    }
  }

  console.log(`    Real sections after TOC filter: ${realSections.length}`);

  // Extra filter: reject sections where the "body" is just a list of more
  // section numbers (TOC pages that exceeded MIN_BODY_LENGTH).
  const contentSections: Match[] = [];
  for (let i = 0; i < realSections.length; i++) {
    const cur = realSections[i];
    const next = realSections[i + 1];
    const body = fullText.slice(cur.headerEndIdx, next ? next.startIdx : Math.min(fullText.length, cur.headerEndIdx + 5000));

    const numberLikeMatches = body.match(/\b\d{1,4}[A-Z]?\.\s+[A-Z]/g) ?? [];
    const numberDensity = (numberLikeMatches.length * 8) / body.length;
    if (numberDensity > 0.30) {
      continue; // Skip — looks like TOC
    }

    contentSections.push(cur);
  }
  console.log(`    After content-density filter: ${contentSections.length}`);

  // Dedup: keep the longest body for each section_number.
  const bySection = new Map<string, ExtractedChunk>();
  for (let i = 0; i < contentSections.length; i++) {
    const cur = contentSections[i];
    const next = contentSections[i + 1];
    const body = fullText.slice(cur.startIdx, next ? next.startIdx : undefined).trim();

    const afterHeader = fullText.slice(cur.headerEndIdx, cur.headerEndIdx + 200);
    const titleMatch = afterHeader.match(/^([^.\n]{3,150})/);
    const title = titleMatch ? titleMatch[1].trim().replace(/\s+/g, " ") : "";

    const existing = bySection.get(cur.section);
    if (!existing || body.length > existing.content.length) {
      bySection.set(cur.section, {
        section_number: cur.section,
        title,
        content: body,
      });
    }
  }

  const chunks = Array.from(bySection.values());
  console.log(`    Final unique sections: ${chunks.length}`);

  return chunks;
}

// ── downloadPdf (copied from reextract-pdfjs.ts) ────────────────────────────

async function downloadPdf(url: string, dest: string): Promise<void> {
  if (fs.existsSync(dest)) {
    const cachedBuf = fs.readFileSync(dest);
    const isPdf = cachedBuf.length > 0 &&
                  cachedBuf[0] === 0x25 && cachedBuf[1] === 0x50 &&
                  cachedBuf[2] === 0x44 && cachedBuf[3] === 0x46;
    if (isPdf && cachedBuf.length > 200000) {
      console.log(`    Valid cached PDF (${cachedBuf.length} bytes) at ${dest}`);
      return;
    }
    console.log(`    Cached file is not a valid PDF or is too small (${cachedBuf.length} bytes) — re-downloading`);
    fs.unlinkSync(dest);
  }

  console.log(`    Downloading ${url}`);
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "application/pdf,*/*",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} when downloading ${url}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());

  const isPdf = buf.length > 0 &&
                buf[0] === 0x25 && buf[1] === 0x50 &&
                buf[2] === 0x44 && buf[3] === 0x46;
  if (!isPdf) {
    const preview = buf.slice(0, 200).toString("utf-8");
    throw new Error(
      `Downloaded file is not a PDF. First 200 bytes: ${preview}\n` +
      `URL: ${url}\n` +
      `Likely cause: URL returned HTML error page instead of PDF.`
    );
  }

  if (buf.length < 100000) {
    console.warn(`    ⚠ Downloaded PDF is suspiciously small (${buf.length} bytes). May be incomplete.`);
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  console.log(`    Saved ${buf.length} bytes to ${dest}`);
}

// ── cleanText (copied from insert-reextracted-chunks.ts) ────────────────────

function cleanText(input: string): string {
  let s = input;
  s = s.replace(/\s+/g, " ");
  for (let i = 0; i < 3; i++) {
    s = s.replace(/([a-zA-Z])\s([a-z])\s/g, "$1$2 ");
    s = s.replace(/\s([a-z])([a-z]{2,})/g, " $1$2");
  }
  s = s.replace(/([a-zA-Z])\s-\s([a-zA-Z])/g, "$1-$2");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

// ── Priority order ─────────────────────────────────────────────────────────
// Run high-value Acts first so if extraction is interrupted, the most
// important ones are done.

const PRIORITY_ORDER = [
  "CrPC 1898",
  "CPC 1908",
  "Constitution 1973",
  "Companies Ord 1984",
  "Contract Act 1872",
  "Customs 1969",
  "ATA 1997",
  "Securities 2015",
  "NIA 1881",
  "Arbitration 1940",
  "Federal Excise",
  "TPA 1882",
  "MFLO 1961",
  "SRA 1877",
  "SGA 1930",
  "DMMA 1939",
];

// ── Progress checkpoint ────────────────────────────────────────────────────

async function loadProgress(): Promise<ProgressFile> {
  const progressPath = path.resolve(process.cwd(), "data/audits/reextract-progress.json");
  if (fs.existsSync(progressPath)) {
    return JSON.parse(fs.readFileSync(progressPath, "utf-8"));
  }
  return {
    started_at: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    acts: {},
  };
}

function saveProgress(progress: ProgressFile) {
  progress.last_updated = new Date().toISOString();
  const dir = path.resolve(process.cwd(), "data/audits");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "reextract-progress.json"),
    JSON.stringify(progress, null, 2)
  );
}

// ── Per-Act runner ─────────────────────────────────────────────────────────

async function reextractOneAct(
  label: string,
  pattern: string,
  expectedSections: number,
  csvRows: CsvRow[],
  progress: ProgressFile
): Promise<void> {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  console.log(`\n${"━".repeat(60)}`);
  console.log(`  Processing: ${label}`);
  console.log("━".repeat(60));

  progress.acts[label] = {
    label,
    status: "downloading",
    started_at: new Date().toISOString(),
  };
  saveProgress(progress);

  try {
    const actRow = csvRows.find((r) =>
      r.act_name && r.act_name.toLowerCase().includes(pattern.toLowerCase())
    );
    if (!actRow) {
      throw new Error(`Act not found in CSV for pattern "${pattern}"`);
    }

    console.log(`  Act: ${actRow.act_name}`);
    console.log(`  pdf_url: ${actRow.pdf_url}`);

    const pdfDest = path.resolve(process.cwd(), `data/raw/${slug}-reextract.pdf`);
    const downloadUrl = actRow.pdf_url || actRow.source_url;
    if (!downloadUrl) {
      throw new Error("No pdf_url or source_url for this Act");
    }

    // Force fresh download if cached file too small
    if (fs.existsSync(pdfDest) && fs.statSync(pdfDest).size < 100000) {
      fs.unlinkSync(pdfDest);
    }

    await downloadPdf(downloadUrl, pdfDest);
    const pdfBuffer = fs.readFileSync(pdfDest);

    // Extract
    progress.acts[label].status = "extracting";
    saveProgress(progress);

    const cachedTextPath = path.resolve(process.cwd(), `data/raw/${slug}-reextract-text.txt`);
    let fullText: string;
    if (fs.existsSync(cachedTextPath)) {
      console.log(`  Using cached extracted text`);
      fullText = fs.readFileSync(cachedTextPath, "utf-8");
    } else {
      console.log(`  Extracting text with pdfjs-dist...`);
      fullText = await extractPdfWithPdfjs(pdfBuffer);
      fs.writeFileSync(cachedTextPath, fullText);
    }
    console.log(`  Extracted ${fullText.length} chars`);

    // Split
    const chunks = splitIntoSections(fullText);
    console.log(`  Sections extracted: ${chunks.length} (expected ~${expectedSections})`);

    if (chunks.length === 0) {
      throw new Error("Zero sections extracted — regex may not match this Act's format");
    }

    // Save chunks JSON
    const chunksPath = path.resolve(process.cwd(), `data/raw/${slug}-reextract-chunks.json`);
    fs.writeFileSync(chunksPath, JSON.stringify(chunks, null, 2));

    progress.acts[label].chunks_extracted = chunks.length;
    progress.acts[label].status = "inserting";
    saveProgress(progress);

    // Insert into Supabase
    console.log(`  Inserting ${chunks.length} chunks into Supabase...`);
    let inserted = 0;
    let failed = 0;
    const startTime = Date.now();

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const cleanContent = cleanText(c.content);
      const cleanTitle = cleanText(c.title);

      if (cleanContent.length < 40) continue;

      try {
        const embedding = await embedTextLocal(cleanContent);
        const { error } = await supabase.from("documents").insert({
          content: cleanContent,
          embedding,
          scope: "global",
          act_name: actRow.act_name,
          section_number: c.section_number,
          title: cleanTitle.slice(0, 200),
          year: parseInt(actRow.year, 10) || null,
          province: actRow.province || "Federal",
          legal_doc_type: actRow.legal_doc_type || "Act",
          domain: actRow.domain || "General",
          jurisdiction: "Pakistan",
          country: "Pakistan",
          source_url: actRow.pdf_url,
          file_name: `${slug}-reextract.pdf`,
          file_type: "pdf",
          chunk_index: i,
          tags: { reextract: true, source: "pdfjs-reextract" },
        });

        if (error) {
          console.error(`    ✗ [${i + 1}/${chunks.length}] §${c.section_number}: ${error.message}`);
          failed++;
        } else {
          inserted++;
          if (inserted % 50 === 0) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            console.log(`    [${i + 1}/${chunks.length}] inserted=${inserted} failed=${failed} (${elapsed}s)`);
          }
        }
      } catch (e) {
        console.error(`    ✗ §${c.section_number}: ${(e as Error).message}`);
        failed++;
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`  ✓ Done: inserted=${inserted} failed=${failed} in ${elapsed}s`);

    progress.acts[label].chunks_inserted = inserted;
    progress.acts[label].status = "done";
    progress.acts[label].finished_at = new Date().toISOString();
    saveProgress(progress);

  } catch (err) {
    const msg = (err as Error).message;
    console.error(`  ✗ FAILED: ${msg}`);
    progress.acts[label].status = "failed";
    progress.acts[label].error = msg;
    progress.acts[label].finished_at = new Date().toISOString();
    saveProgress(progress);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═".repeat(60));
  console.log("  Re-extract All Partial/Missing Federal Acts");
  console.log("═".repeat(60));

  const reportPath = path.resolve(process.cwd(), "data/audits/completeness.json");
  if (!fs.existsSync(reportPath)) {
    console.error("Missing completeness.json. Run 'npm run audit:completeness' first.");
    process.exit(1);
  }

  const report: CompletenessReport = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
  const toProcess = report.filter((r) => r.status === "partial" || r.status === "missing");

  // Skip PPC — already done
  const filtered = toProcess.filter((r) => !r.label.toLowerCase().includes("ppc"));

  console.log(`  Acts to process: ${filtered.length}`);
  console.log("");

  const csvPath = path.resolve(process.cwd(), "data/seeds/pakistan-federal.csv");
  const csvText = fs.readFileSync(csvPath, "utf-8");
  const csvRows: CsvRow[] = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
    relax_column_count: true,
  });

  const progress = await loadProgress();

  // Sort by PRIORITY_ORDER
  const sorted = filtered.slice().sort((a, b) => {
    const aIdx = PRIORITY_ORDER.indexOf(a.label);
    const bIdx = PRIORITY_ORDER.indexOf(b.label);
    return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
  });

  for (const r of sorted) {
    const existing = progress.acts[r.label];
    if (existing && existing.status === "done") {
      console.log(`  ⊙ Skip ${r.label} (already done)`);
      continue;
    }
    await reextractOneAct(r.label, r.pattern, r.expected_sections, csvRows, progress);
  }

  console.log("\n" + "═".repeat(60));
  console.log("  Final Summary");
  console.log("═".repeat(60));

  const done = Object.values(progress.acts).filter((a) => a.status === "done");
  const failed = Object.values(progress.acts).filter((a) => a.status === "failed");
  const totalInserted = done.reduce((s, a) => s + (a.chunks_inserted ?? 0), 0);

  console.log(`  Done:   ${done.length}`);
  console.log(`  Failed: ${failed.length}`);
  console.log(`  Total chunks inserted: ${totalInserted}`);

  if (failed.length > 0) {
    console.log("\n  Failed Acts:");
    for (const f of failed) {
      console.log(`    ${f.label}: ${f.error}`);
    }
  }

  console.log("\n  Run 'npm run audit:completeness' to verify improved coverage.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
