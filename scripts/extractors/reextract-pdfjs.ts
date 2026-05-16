/**
 * Better PDF re-extractor using pdfjs-dist with tesseract.js OCR fallback.
 *
 * Strategy:
 *  1. Download PDF from source_url (or read from existing cache).
 *  2. Extract text page-by-page using pdfjs-dist.
 *  3. For any page that yields <100 chars of text, run tesseract OCR.
 *  4. Concatenate all page text into one long string.
 *  5. Split on section-boundary regex (handles "302.", "489-F.", etc.).
 *  6. Each section = one chunk with its section_number populated.
 *  7. Generate embeddings via existing embedTextLocal().
 *  8. Insert as NEW chunks (do NOT delete existing chunks yet).
 *  9. Tag new chunks with source="pdfjs-reextract" so we can find/remove them.
 *
 * For Prompt 1A, ONLY runs on PPC (single Act). Prompt 1B will generalize.
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { parse } from "csv-parse/sync";
import { createClient } from "@supabase/supabase-js";
import { embedTextLocal } from "../../lib/local-embeddings";

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

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

// PPC source URL from data/seeds/pakistan-federal.csv
// (Hardcoded for Prompt 1A — Prompt 1B will load from completeness.json)
const PPC_SOURCE_URL = "https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-apaUY2Nnk%3D-sg-jjjjjjjjjjjjj";
const PPC_ACT_NAME = "Pakistan Penal Code (PPC), 1860";
const PPC_YEAR = 1860;
// ↑ User should verify these by checking data/seeds/pakistan-federal.csv
//   for the actual PPC row. The CSV may have the literal pdf_url which
//   is what we want.

type ExtractedChunk = {
  section_number: string;
  title: string;
  content: string;
};

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

function splitIntoSections(fullText: string): ExtractedChunk[] {
  // Normalize whitespace: collapse multi-spaces, fix broken-letter words
  // pdfjs sometimes inserts spaces between letters: "qat l - i - amd"
  // We don't fix this in source text (lose info) but match flexibly.

  // Section header pattern. Accepts:
  //   "302."     (standard)
  //   "302A."    (lettered)
  //   "489-F."   (hyphen-lettered)
  //   "337-A."   (alternate hyphen-lettered)
  // Optionally prefixed with footnote marker like "1 ["
  //
  // Followed by 1+ spaces and the title (1+ words).
  //
  // The header anchor is the section number plus its trailing period.

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
  // Real section bodies are hundreds to thousands of chars.
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
  // section numbers (TOC pages that exceeded MIN_BODY_LENGTH). A real legal
  // section body has actual words, not just numbered bullets.
  const contentSections: Match[] = [];
  for (let i = 0; i < realSections.length; i++) {
    const cur = realSections[i];
    const next = realSections[i + 1];
    const body = fullText.slice(cur.headerEndIdx, next ? next.startIdx : Math.min(fullText.length, cur.headerEndIdx + 5000));

    // Count how many section-number-like patterns are in the body
    const numberLikeMatches = body.match(/\b\d{1,4}[A-Z]?\.\s+[A-Z]/g) ?? [];

    // If more than 30% of body length is just section-number references,
    // it's TOC text. Real sections have lots of prose words.
    const numberDensity = (numberLikeMatches.length * 8) / body.length;
    if (numberDensity > 0.30) {
      continue; // Skip — looks like TOC
    }

    contentSections.push(cur);
  }
  console.log(`    After content-density filter: ${contentSections.length}`);

  // Dedup: pakistancode PDFs sometimes have repeated sections (amendments
  // listed alongside originals). Keep the longest body for each section_number.
  const bySection = new Map<string, ExtractedChunk>();
  for (let i = 0; i < contentSections.length; i++) {
    const cur = contentSections[i];
    const next = contentSections[i + 1];
    const body = fullText.slice(cur.startIdx, next ? next.startIdx : undefined).trim();

    // Extract title: from after the section number period to the next period
    // or newline, whichever comes first, capped at 200 chars.
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

async function downloadPdf(url: string, dest: string): Promise<void> {
  if (fs.existsSync(dest)) {
    // Validate cached file is a real PDF
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

  // Validate downloaded bytes are a real PDF
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

async function main() {
  console.log("═".repeat(60));
  console.log("  PPC Re-Extraction Test (Prompt 1A)");
  console.log("═".repeat(60));

  // Force fresh download by removing any prior cached PDF
  const cachedPath = path.resolve(process.cwd(), "data/raw/ppc-reextract.pdf");
  if (fs.existsSync(cachedPath)) {
    const sz = fs.statSync(cachedPath).size;
    if (sz < 100000) {
      console.log(`Removing suspiciously small cached PDF (${sz} bytes) to force fresh download`);
      fs.unlinkSync(cachedPath);
    }
  }

  // STEP 1: Find PPC's source_url from the existing CSV
  const csvPath = path.resolve(process.cwd(), "data/seeds/pakistan-federal.csv");
  if (!fs.existsSync(csvPath)) {
    console.error("Missing data/seeds/pakistan-federal.csv");
    process.exit(1);
  }

  const csvText = fs.readFileSync(csvPath, "utf-8");

  const rows: CsvRow[] = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
    relax_column_count: true,
  });

  const ppcRow = rows.find(r =>
    r.act_name && r.act_name.toLowerCase().includes("penal code")
  );

  if (!ppcRow) {
    console.error("PPC row not found in CSV");
    process.exit(1);
  }

  console.log(`\nFound PPC: ${ppcRow.act_name}`);
  console.log(`  source_url: ${ppcRow.source_url}`);
  console.log(`  pdf_url:    ${ppcRow.pdf_url}`);

  // STEP 2: Download PDF
  // pdf_url is the direct .pdf file; source_url is the HTML landing page.
  // Prefer pdf_url, fallback to source_url only if pdf_url is empty.
  const pdfDest = path.resolve(process.cwd(), "data/raw/ppc-reextract.pdf");
  const downloadUrl = ppcRow.pdf_url || ppcRow.source_url;
  await downloadPdf(downloadUrl, pdfDest);
  const pdfBuffer = fs.readFileSync(pdfDest);

  // STEP 3: Extract with pdfjs + OCR fallback (or load from cache)
  let fullText: string;
  const cachedTextPath = path.resolve(process.cwd(), "data/raw/ppc-reextract-text.txt");
  if (fs.existsSync(cachedTextPath)) {
    console.log(`\nUsing cached extracted text from ${cachedTextPath}`);
    fullText = fs.readFileSync(cachedTextPath, "utf-8");
    console.log(`  Loaded ${fullText.length} chars`);
  } else {
    console.log("\nExtracting text with pdfjs-dist...");
    fullText = await extractPdfWithPdfjs(pdfBuffer);
    console.log(`  Total extracted: ${fullText.length} chars`);
    fs.writeFileSync(cachedTextPath, fullText);
    console.log(`  Raw text saved to ${cachedTextPath}`);
  }

  // STEP 4: Check if §302 text appears in extracted output
  const has302 = /\b302\.\s+/i.test(fullText) || /qatl-i-amd/i.test(fullText);
  console.log(`\n  §302 detected in extracted text? ${has302 ? "✓ YES" : "✗ NO"}`);
  if (!has302) {
    console.log("  ⚠ WARNING: §302 not found in extracted text. The source PDF may not contain it.");
    console.log("  Continuing with extraction anyway — will report final coverage.");
  }

  // STEP 5: Split into sections
  const chunks = splitIntoSections(fullText);
  console.log(`\n  Sections extracted: ${chunks.length}`);
  console.log(`  Sample sections: ${chunks.slice(0, 5).map(c => c.section_number).join(", ")}`);

  const sections302 = chunks.filter(c => c.section_number === "302");
  if (sections302.length > 0) {
    console.log(`\n  ✓ §302 chunk found:`);
    console.log(`    Title: ${sections302[0].title}`);
    console.log(`    Body length: ${sections302[0].content.length} chars`);
    console.log(`    Preview (first 500 chars):`);
    console.log(`    ${sections302[0].content.slice(0, 500).replace(/\s+/g, " ")}`);
  } else {
    console.log(`\n  ✗ §302 NOT in extracted sections.`);
    // Debug: show what nearby sections we did find
    const nearby = chunks
      .filter(c => /^(29[5-9]|30[0-8])$/.test(c.section_number))
      .map(c => c.section_number);
    console.log(`    Sections 295-308 found: ${nearby.join(", ") || "(none)"}`);
  }

  // STEP 6: Save chunks to disk for review (do NOT insert into Supabase yet)
  const chunksPath = path.resolve(process.cwd(), "data/raw/ppc-reextract-chunks.json");
  fs.writeFileSync(chunksPath, JSON.stringify(chunks, null, 2));
  console.log(`\n  Chunks saved to ${chunksPath}`);
  console.log("  (Not inserted to Supabase — review first.)");

  console.log("\n" + "═".repeat(60));
  console.log("  Done. Review the output and decide whether to proceed.");
  console.log("═".repeat(60));
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
