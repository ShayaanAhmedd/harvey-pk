/**
 * ingest-folder.ts — Bulk folder ingestion for Pakistani Legal Corpus
 *
 * Usage:
 *   npm run ingest-folder <folder-path>
 *   npm run ingest-folder data/pakistan_laws
 *
 * - Walks folder recursively
 * - Supports .pdf, .txt, .docx
 * - Skips files already in Supabase (by storage_path)
 * - Batch embeds + inserts into `documents` table
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import mammoth from "mammoth";
import { chunkBySections } from "../lib/section-chunker";

// ─────────────────────────────────────────────────────────────
// ENV
// ─────────────────────────────────────────────────────────────

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !OPENAI_API_KEY) {
  console.error("Missing required env vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENAI_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const SUPPORTED_EXTENSIONS = new Set([".pdf", ".txt", ".docx"]);
const EMBED_BATCH_SIZE = 20;
const INSERT_BATCH_SIZE = 100;

// ─────────────────────────────────────────────────────────────
// FILE DISCOVERY
// ─────────────────────────────────────────────────────────────

function walkDir(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_EXTENSIONS.has(ext)) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────
// SKIP CHECK
// ─────────────────────────────────────────────────────────────

async function alreadyIngested(storagePath: string): Promise<boolean> {
  const { count, error } = await supabase
    .from("documents")
    .select("id", { count: "exact", head: true })
    .eq("storage_path", storagePath)
    .eq("scope", "global");

  if (error) {
    console.warn(`  [warn] Skip-check failed for ${storagePath}: ${error.message}`);
    return false;
  }

  return (count ?? 0) > 0;
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
    const pdfParse = require("pdf-parse");
    const result = await pdfParse(buffer);
    return result.text;
  }

  return buffer.toString("utf-8");
}

// ─────────────────────────────────────────────────────────────
// EMBEDDING
// ─────────────────────────────────────────────────────────────

async function embedBatch(texts: string[]): Promise<number[][]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: texts,
  });
  return response.data.map((d) => d.embedding);
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function toActName(filename: string): string {
  return path
    .basename(filename, path.extname(filename))
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function toFileType(ext: string): string {
  const map: Record<string, string> = { pdf: "pdf", txt: "txt", docx: "docx" };
  return map[ext.slice(1)] ?? "other";
}

// ─────────────────────────────────────────────────────────────
// PROCESS SINGLE FILE
// ─────────────────────────────────────────────────────────────

async function processFile(
  filePath: string,
  rootDir: string,
  fileIndex: number,
  total: number
): Promise<{ skipped: boolean; chunks: number }> {
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const relFolder = path.relative(rootDir, path.dirname(filePath));
  const storagePath = path
    .join(relFolder || ".", fileName)
    .replace(/\\/g, "/");
  const actName = toActName(fileName);
  const fileType = toFileType(ext);

  const prefix = `[${fileIndex}/${total}]`;

  // ── Skip check ────────────────────────────────────────────
  const exists = await alreadyIngested(storagePath);
  if (exists) {
    console.log(`${prefix} SKIP  ${storagePath} (already ingested)`);
    return { skipped: true, chunks: 0 };
  }

  console.log(`${prefix} START ${storagePath}`);

  // ── Storage upload ─────────────────────────────────────────
  const rawBuffer = fs.readFileSync(filePath);
  const contentType = ext === ".pdf" ? "application/pdf" : "application/octet-stream";
  const { error: storageErr } = await supabase.storage
    .from("legal-documents")
    .upload(storagePath, rawBuffer, { contentType, upsert: true });

  if (storageErr) {
    console.warn(`  [warn] Storage upload failed: ${storageErr.message}`);
  }

  // ── Text extraction ────────────────────────────────────────
  let rawText: string;
  try {
    rawText = await extractText(filePath);
  } catch (err: any) {
    console.error(`  [error] Text extraction failed: ${err.message}`);
    return { skipped: false, chunks: 0 };
  }

  const cleanedText = rawText.replace(/\n{3,}/g, "\n\n").trim();
  if (!cleanedText || cleanedText.length < 50) {
    console.warn(`  [warn] No usable text extracted (possibly scanned PDF). Skipping.`);
    return { skipped: false, chunks: 0 };
  }

  // ── Chunking ───────────────────────────────────────────────
  const chunks = chunkBySections(cleanedText);
  console.log(`  chunks: ${chunks.length}`);

  // ── Embed + insert in batches ──────────────────────────────
  let inserted = 0;

  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const embedBatchItems = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const embeddings = await embedBatch(embedBatchItems.map((c) => c.content));

    const rows = embedBatchItems.map((chunk, j) => ({
      case_id: null,
      file_name: fileName,
      file_type: fileType,
      chunk_index: chunk.chunk_index,
      content: chunk.content,
      embedding: embeddings[j],
      scope: "global",
      storage_path: storageErr ? null : storagePath,
      act_name: actName,
      title: chunk.title,
      section_number: chunk.section_number,
      chapter: chunk.chapter,
      year: null,
      jurisdiction: "Pakistan",
      source_url: null,
      // extended metadata
      document_name: actName,
      folder: relFolder || ".",
    }));

    // Flush rows in INSERT_BATCH_SIZE chunks
    for (let r = 0; r < rows.length; r += INSERT_BATCH_SIZE) {
      const batch = rows.slice(r, r + INSERT_BATCH_SIZE);
      const { error } = await supabase.from("documents").insert(batch);
      if (error) {
        console.error(`  [error] Insert failed at chunk ${i + r}: ${error.message}`);
        throw new Error(error.message);
      }
    }

    inserted += embedBatchItems.length;
    process.stdout.write(
      `\r  progress: ${inserted}/${chunks.length} (${Math.round((inserted / chunks.length) * 100)}%)   `
    );
  }

  process.stdout.write("\n");
  console.log(`  DONE  ${inserted} sections inserted for "${actName}"`);

  return { skipped: false, chunks: inserted };
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────

async function main() {
  const folderArg = process.argv[2];

  if (!folderArg) {
    console.error("Usage: npm run ingest-folder <folder-path>");
    console.error("Example: npm run ingest-folder data/pakistan_laws");
    process.exit(1);
  }

  const rootDir = path.resolve(process.cwd(), folderArg);

  if (!fs.existsSync(rootDir)) {
    console.error(`Folder not found: ${rootDir}`);
    process.exit(1);
  }

  if (!fs.statSync(rootDir).isDirectory()) {
    console.error(`Not a directory: ${rootDir}`);
    process.exit(1);
  }

  console.log(`\nScanning: ${rootDir}`);
  const files = walkDir(rootDir);

  if (files.length === 0) {
    console.log("No supported files found (.pdf, .txt, .docx).");
    process.exit(0);
  }

  console.log(`Found ${files.length} file(s).\n`);

  let totalSkipped = 0;
  let totalProcessed = 0;
  let totalChunks = 0;
  let totalErrors = 0;

  for (let i = 0; i < files.length; i++) {
    try {
      const result = await processFile(files[i], rootDir, i + 1, files.length);
      if (result.skipped) {
        totalSkipped++;
      } else {
        totalProcessed++;
        totalChunks += result.chunks;
      }
    } catch (err: any) {
      console.error(`  [fatal] ${files[i]}: ${err.message}`);
      totalErrors++;
    }
  }

  console.log("\n═══════════════════════════════════════");
  console.log(`  Files found:     ${files.length}`);
  console.log(`  Processed:       ${totalProcessed}`);
  console.log(`  Skipped:         ${totalSkipped}`);
  console.log(`  Errors:          ${totalErrors}`);
  console.log(`  Total chunks:    ${totalChunks}`);
  console.log("═══════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("\nFatal:", err);
  process.exit(1);
});
