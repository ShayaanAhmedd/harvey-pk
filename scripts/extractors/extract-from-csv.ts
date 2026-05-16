/**
 * Universal Phase 2 PDF extractor.
 *
 * Reads any discovery CSV (Sindh / Punjab / KP / Balochistan / LHC / FBR / etc.),
 * downloads each PDF, extracts text with pdfjs-dist (+ OCR fallback),
 * chunks on section boundaries, embeds with local BGE, and INSERTs into
 * Supabase. Every chunk is tagged with `tags.source = <--tag>` for later
 * identification.
 *
 * Function bodies for extractPdfWithPdfjs, splitIntoSections, downloadPdf,
 * ocrPage, and cleanText are COPIED verbatim from the proven PPC pipeline
 * (scripts/extractors/reextract-pdfjs.ts and insert-reextracted-chunks.ts).
 * Each source script has its own main(), so we copy rather than import.
 *
 * Usage:
 *   tsx scripts/extractors/extract-from-csv.ts \
 *     --seed <csv-path> --tag <source-tag> [--concurrency N] [--limit N]
 *
 * Resumable: writes data/audits/extract-progress-<slug>.json after every
 * 10 documents; re-run skips already-done pdf_urls.
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

type ExtractedChunk = {
  section_number: string;
  title: string;
  content: string;
};

type CsvRow = {
  act_name: string;
  year: string;
  province?: string;
  legal_doc_type: string;
  domain: string;
  source_url: string;
  pdf_url: string;
  notes: string;
  // Optional fields varying by source:
  court?: string;
  case_citation?: string;
  case_type?: string;
  case_number?: string;
  parties?: string;
  judges?: string;
  judgment_date?: string;
  document_date?: string;
  gazette_number?: string;
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
    return [];
  }

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

  return Array.from(bySection.values());
}

// ── downloadPdf (copied from reextract-pdfjs.ts) ────────────────────────────

async function downloadPdf(url: string, dest: string): Promise<void> {
  if (fs.existsSync(dest)) {
    const cachedBuf = fs.readFileSync(dest);
    const isPdf = cachedBuf.length > 0 &&
                  cachedBuf[0] === 0x25 && cachedBuf[1] === 0x50 &&
                  cachedBuf[2] === 0x44 && cachedBuf[3] === 0x46;
    if (isPdf && cachedBuf.length > 200000) {
      return; // cached PDF is valid
    }
    fs.unlinkSync(dest);
  }

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

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
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

// ── CLI args + progress checkpoint ──────────────────────────────────────────

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

async function loadProgress(progressPath: string): Promise<Set<string>> {
  if (!fs.existsSync(progressPath)) return new Set();
  try {
    const data = JSON.parse(fs.readFileSync(progressPath, "utf-8"));
    return new Set(data.done || []);
  } catch {
    return new Set();
  }
}

async function saveProgress(progressPath: string, done: Set<string>) {
  fs.mkdirSync(path.dirname(progressPath), { recursive: true });
  fs.writeFileSync(progressPath, JSON.stringify({
    done: Array.from(done),
    last_updated: new Date().toISOString(),
  }, null, 2));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  const seedPath = args["seed"];
  const sourceTag = args["tag"];
  const limit = args["limit"] ? parseInt(args["limit"], 10) : Infinity;

  if (!seedPath || !sourceTag) {
    console.error("Usage: extract-from-csv.ts --seed <csv-path> --tag <source-tag> [--concurrency N] [--limit N]");
    console.error("");
    console.error("Examples:");
    console.error("  --seed data/seeds/pakistan-sindh.csv --tag sindh-statute");
    console.error("  --seed data/seeds/pakistan-punjab.csv --tag punjab-statute");
    console.error("  --seed data/seeds/pakistan-lhc.csv --tag lhc-judgment");
    process.exit(1);
  }

  const slug = sourceTag.replace(/[^a-z0-9]/gi, "-").toLowerCase();
  const progressPath = path.resolve(process.cwd(), `data/audits/extract-progress-${slug}.json`);
  const cacheDir = path.resolve(process.cwd(), `data/raw/${slug}`);
  fs.mkdirSync(cacheDir, { recursive: true });

  console.log("═".repeat(60));
  console.log(`  Phase 2 Extractor — Tag: ${sourceTag}`);
  console.log("═".repeat(60));
  console.log(`  Seed:      ${seedPath}`);
  console.log(`  Cache:     ${cacheDir}`);
  console.log(`  Progress:  ${progressPath}`);
  console.log(`  Limit:     ${limit === Infinity ? "all" : limit}`);

  // Load CSV
  const csvText = fs.readFileSync(seedPath, "utf-8");
  const allRows: CsvRow[] = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
    relax_column_count: true,
  });
  console.log(`  CSV rows:  ${allRows.length}`);

  // Load progress (deduplication by pdf_url)
  const done = await loadProgress(progressPath);
  console.log(`  Already done: ${done.size}`);

  const remaining = allRows.filter(r => r.pdf_url && !done.has(r.pdf_url)).slice(0, limit);
  console.log(`  Remaining to process: ${remaining.length}`);
  console.log("");

  let inserted = 0;
  let failed = 0;
  let skipped = 0;
  const startTime = Date.now();

  for (let i = 0; i < remaining.length; i++) {
    const row = remaining[i];
    const slugId = (row.pdf_url.match(/([^/]+)\.pdf$/i)?.[1] ?? `doc-${i}`).toLowerCase();
    const pdfDest = path.join(cacheDir, `${slugId}.pdf`);

    console.log(`\n[${i + 1}/${remaining.length}] ${row.act_name?.slice(0, 80) ?? "Untitled"}`);
    console.log(`  PDF: ${row.pdf_url}`);

    try {
      // Download PDF (skip if cached and valid)
      await downloadPdf(row.pdf_url, pdfDest);
      const pdfBuffer = fs.readFileSync(pdfDest);

      // Extract text
      const cachedTextPath = path.join(cacheDir, `${slugId}.txt`);
      let fullText: string;
      if (fs.existsSync(cachedTextPath)) {
        fullText = fs.readFileSync(cachedTextPath, "utf-8");
      } else {
        fullText = await extractPdfWithPdfjs(pdfBuffer);
        fs.writeFileSync(cachedTextPath, fullText);
      }

      if (fullText.length < 200) {
        console.log(`  ⚠ Text too short (${fullText.length} chars). Skipping.`);
        skipped++;
        done.add(row.pdf_url);
        await saveProgress(progressPath, done);
        continue;
      }

      // Split into sections
      const chunks = splitIntoSections(fullText);
      if (chunks.length === 0) {
        // Fallback: treat the whole document as one chunk
        chunks.push({
          section_number: "1",
          title: row.act_name?.slice(0, 200) ?? "",
          content: fullText.slice(0, 20000), // Cap at ~20K chars per chunk
        });
        console.log(`  No sections detected, using whole-document chunk`);
      } else {
        console.log(`  Sections: ${chunks.length}`);
      }

      // Insert each chunk
      let rowInserted = 0;
      let rowFailed = 0;
      for (let j = 0; j < chunks.length; j++) {
        const c = chunks[j];
        const cleanContent = cleanText(c.content);
        const cleanTitle = cleanText(c.title);

        if (cleanContent.length < 40) continue;

        try {
          const embedding = await embedTextLocal(cleanContent);
          const { error } = await supabase.from("documents").insert({
            content: cleanContent,
            embedding,
            scope: "global",
            act_name: row.act_name,
            section_number: c.section_number,
            title: cleanTitle.slice(0, 200),
            year: parseInt(row.year, 10) || null,
            province: row.province || "Federal",
            legal_doc_type: row.legal_doc_type || "Act",
            domain: row.domain || "General",
            jurisdiction: "Pakistan",
            country: "Pakistan",
            source_url: row.pdf_url,
            file_name: `${slugId}.pdf`,
            file_type: "pdf",
            chunk_index: j,
            tags: {
              reextract: true,
              source: sourceTag,
              // Include extra fields from CSV if present
              ...(row.court ? { court: row.court } : {}),
              ...(row.case_citation ? { case_citation: row.case_citation } : {}),
              ...(row.judgment_date ? { judgment_date: row.judgment_date } : {}),
              ...(row.parties ? { parties: row.parties } : {}),
              ...(row.judges ? { judges: row.judges } : {}),
              ...(row.gazette_number ? { gazette_number: row.gazette_number } : {}),
            },
          });

          if (error) {
            rowFailed++;
          } else {
            rowInserted++;
            inserted++;
          }
        } catch {
          rowFailed++;
        }
      }

      console.log(`  Inserted ${rowInserted}/${chunks.length} chunks (failed: ${rowFailed})`);
      if (rowFailed > 0) failed++;

      done.add(row.pdf_url);

      // Save progress every 10 documents
      if ((i + 1) % 10 === 0 || i === remaining.length - 1) {
        await saveProgress(progressPath, done);
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const rate = (i + 1) / (elapsed / 60);
        const eta = Math.round((remaining.length - i - 1) / rate);
        console.log(`  --- Progress: ${i + 1}/${remaining.length} docs, ${inserted} chunks inserted, ${elapsed}s elapsed, ETA ${eta}min ---`);
      }

    } catch (e) {
      const msg = (e as Error).message;
      console.error(`  ✗ Error: ${msg}`);
      failed++;
    }
  }

  await saveProgress(progressPath, done);

  const totalSeconds = Math.round((Date.now() - startTime) / 1000);
  console.log("\n" + "═".repeat(60));
  console.log("  Phase 2 Complete");
  console.log("═".repeat(60));
  console.log(`  Documents processed: ${remaining.length}`);
  console.log(`  Chunks inserted:     ${inserted}`);
  console.log(`  Failed documents:    ${failed}`);
  console.log(`  Skipped (empty PDF): ${skipped}`);
  console.log(`  Total time:          ${Math.floor(totalSeconds / 60)}min ${totalSeconds % 60}s`);
  console.log("");
  console.log(`  Verify in Supabase:`);
  console.log(`    SELECT COUNT(*) FROM documents WHERE tags->>'source' = '${sourceTag}';`);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
