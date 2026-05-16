/**
 * ingest-law.ts — Production-stable ingestion script
 * Pakistani Legal Corpus → Supabase (pgvector) + Storage
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import mammoth from "mammoth";
import { chunkBySections, type LegalChunk } from "../lib/section-chunker";
import { embedTextLocal } from "../lib/local-embeddings";

// ─────────────────────────────────────────────────────────────
// ENV
// ─────────────────────────────────────────────────────────────

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !OPENAI_API_KEY) {
  console.error("Missing required env vars.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ─────────────────────────────────────────────────────────────
// ARG PARSER
// ─────────────────────────────────────────────────────────────

function parseArgs(): Record<string, string> {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const value =
        args[i + 1] && !args[i + 1].startsWith("--")
          ? args[++i]
          : "true";
      result[key] = value;
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// TEXT EXTRACTION
// ─────────────────────────────────────────────────────────────

async function extractText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const buffer = fs.readFileSync(filePath);

  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (ext === ".pdf") {
    const pdfParse = require("pdf-parse"); // using v1.1.1
    const result = await pdfParse(buffer);
    return result.text;
  }

  if (ext === ".html" || ext === ".htm" || ext === ".xml") {
    const cheerio = require("cheerio");
    const $ = cheerio.load(buffer.toString("utf-8"));
    // Strip noise
    $("script, style, nav, header, footer, .footer, .header, .skip-link").remove();
    // Prefer the main content container if legislation.gov.uk uses one
    const main = $("#viewLegContents, #content, main, article").first();
    const root = main.length > 0 ? main : $("body");
    // Get text with paragraph breaks preserved
    const text = root
      .find("p, h1, h2, h3, h4, h5, h6, li")
      .map((_: number, el: any) => $(el).text().trim())
      .get()
      .filter((t: string) => t.length > 0)
      .join("\n\n");
    return text || $("body").text();
  }

  return buffer.toString("utf-8");
}

// ─────────────────────────────────────────────────────────────
// EMBEDDING
// ─────────────────────────────────────────────────────────────

async function embed(text: string): Promise<number[]> {
  return embedTextLocal(text);
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function toSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ─────────────────────────────────────────────────────────────
// SECTION-BOUNDARY CHUNKER (--reingest mode only)
// ─────────────────────────────────────────────────────────────
//
// Splits the full extracted text on canonical Pakistani statute section
// headers: "<digits>[<letter-suffix>]. <Title text>". Each chunk runs
// from one header to the next.
//
// Returns null if fewer than 10 headers are found — signals the caller
// to fall back to the default chunker rather than degrade output.

const SECTION_BOUNDARY_RE = /\n\s*(\d+[A-Z]?(?:-[A-Z])?)\.\s+([^\n]+)/g;

function chunkBySectionBoundary(text: string): LegalChunk[] | null {
  // Prefix with \n so a section header at offset 0 also matches.
  const t = "\n" + text;
  type Hit = { sectionNumber: string; title: string; start: number };
  const hits: Hit[] = [];
  SECTION_BOUNDARY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SECTION_BOUNDARY_RE.exec(t)) !== null) {
    hits.push({
      sectionNumber: m[1],
      title:         (m[2] ?? "").trim(),
      start:         m.index,
    });
  }
  if (hits.length < 10) return null;

  const out: LegalChunk[] = [];
  for (let i = 0; i < hits.length; i++) {
    const startIdx = hits[i].start;
    const endIdx   = i + 1 < hits.length ? hits[i + 1].start : t.length;
    const content  = t.slice(startIdx, endIdx).trim();
    if (content.length < 20) continue;
    out.push({
      content,
      chunk_index:    out.length,
      section_number: hits[i].sectionNumber,
      title:          hits[i].title || null,
      chapter:        null,
    });
  }
  return out.length >= 10 ? out : null;
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  const fileArg = args["file"];
  const actName = args["act"];
  const yearStr = args["year"];
  const jurisdiction = args["jurisdiction"] ?? "Pakistan";
  const sourceUrl = args["source-url"] ?? null;
  const reingestMode = args["reingest"] === "true";

  if (!fileArg || !actName) {
    console.error("Usage: --file <path> --act <name> [--year N] [--source-url URL] [--reingest]");
    process.exit(1);
  }

  if (reingestMode && !sourceUrl) {
    console.error("--reingest requires --source-url (used as the DELETE key for old chunks).");
    process.exit(1);
  }

  const filePath = path.resolve(process.cwd(), fileArg);

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const yearInt = yearStr ? parseInt(yearStr, 10) || null : null;
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase().slice(1);

  const fileTypeMap: Record<string, string> = {
    docx: "docx",
    pdf: "pdf",
    txt: "txt",
    html: "html",
    htm: "html",
    xml: "xml",
  };

  const file_type = fileTypeMap[ext] ?? "other";

  console.log(`\nIngesting: ${actName}`);
  console.log(`File: ${filePath}`);

  // ─────────────────────────────────────────────────────────
  // STORAGE UPLOAD
  // ─────────────────────────────────────────────────────────

  const folder = toSlug(actName);
  const storagePath = `${folder}/${fileName}`;
  const rawBuffer = fs.readFileSync(filePath);

  const { error: storageErr } = await supabase.storage
    .from("legal-documents")
    .upload(storagePath, rawBuffer, {
      contentType:
        ext === "pdf"
          ? "application/pdf"
          : "application/octet-stream",
      upsert: true,
    });

  if (storageErr) {
    console.warn("Storage upload failed:", storageErr.message);
  } else {
    console.log("Storage upload successful.");
  }

  // ─────────────────────────────────────────────────────────
  // TEXT EXTRACTION
  // ─────────────────────────────────────────────────────────

  console.log("Extracting text...");
  const rawText = await extractText(filePath);
  const cleanedText = rawText.replace(/\n{3,}/g, "\n\n").trim();

  if (!cleanedText || cleanedText.length < 50) {
    console.error("No usable text extracted. PDF may be scanned.");
    process.exit(1);
  }

  // ─────────────────────────────────────────────────────────
  // CHUNKING
  // ─────────────────────────────────────────────────────────

  console.log("Chunking...");
  let chunks: LegalChunk[] = chunkBySections(cleanedText);
  if (reingestMode) {
    const boundary = chunkBySectionBoundary(cleanedText);
    if (boundary && boundary.length >= 10) {
      console.log(`[reingest] Section-boundary chunker: ${boundary.length} chunks (default chunker would yield ${chunks.length}).`);
      chunks = boundary;
    } else {
      console.log(`[reingest] Section-boundary chunker found insufficient matches; falling back to default chunker (${chunks.length} chunks).`);
    }
  }
  console.log(`Found ${chunks.length} chunks.`);

  // Cutoff timestamp for --reingest mode. Captured BEFORE the first insert
  // so we can DELETE rows with created_at < cutoff (i.e. the old chunks)
  // only after every new chunk has been successfully written.
  const reingestCutoffIso = reingestMode ? new Date().toISOString() : null;

  // ─────────────────────────────────────────────────────────
  // EMBED + INSERT
  // ─────────────────────────────────────────────────────────

  const BATCH_SIZE = 20;
  let inserted = 0;

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);

    // CPU-bound: embed sequentially. Parallelism via Promise.all on a
    // single CPU core doesn't help and can hurt (context-switching).
    const embeddings: number[][] = [];
    for (const c of batch) {
      embeddings.push(await embed(c.content));
    }

    const rows = batch.map((chunk, j) => ({
      case_id: null,
      file_name: fileName,
      file_type,
      chunk_index: chunk.chunk_index,
      content: chunk.content,
      embedding: embeddings[j],
      scope: "global",
      storage_path: storageErr ? null : storagePath,
      act_name: actName,
      title: chunk.title,
      section_number: chunk.section_number,
      chapter: chunk.chapter,
      year: yearInt,
      jurisdiction,
      source_url: sourceUrl,
    }));

    const { error } = await supabase.from("documents").insert(rows);

    if (error) {
      console.error("Insert failed:", error.message);
      process.exit(1);
    }

    inserted += batch.length;
    process.stdout.write(
      `\r[${inserted}/${chunks.length}] ${Math.round(
        (inserted / chunks.length) * 100
      )}%`
    );
  }

  console.log(`\n\nDone. Ingested ${inserted} sections for "${actName}".`);

  // ─────────────────────────────────────────────────────────
  // REINGEST MODE — DELETE old chunks (only after every insert succeeded)
  // ─────────────────────────────────────────────────────────
  //
  // Safety invariants:
  //   - INSERTs above run first; if any failed the script exits before
  //     reaching here, leaving old chunks untouched (better than zero).
  //   - "Old" = same scope+source_url with created_at < the cutoff we
  //     captured BEFORE the first INSERT. Newly inserted chunks have
  //     created_at >= cutoff so they're never matched.
  //   - DELETE failure is logged as a warning, not fatal: at worst we
  //     get duplicates which can be cleaned up manually.
  if (reingestMode && reingestCutoffIso && inserted > 0 && sourceUrl) {
    console.log(`[reingest] Removing old chunks where source_url=${sourceUrl} AND created_at<${reingestCutoffIso}...`);
    const { error: delErr, count: delCount } = await supabase
      .from("documents")
      .delete({ count: "exact" })
      .eq("scope", "global")
      .eq("source_url", sourceUrl)
      .lt("created_at", reingestCutoffIso);
    if (delErr) {
      console.warn(`[reingest] DELETE failed: ${delErr.message}. New chunks are in place; duplicates remain for manual cleanup.`);
    } else {
      console.log(`[reingest] Deleted ${delCount ?? 0} old chunks.`);
    }
  }
}

main().catch((err) => {
  console.error("\nFatal:", err);
  process.exit(1);
});