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
import { chunkBySections } from "../lib/section-chunker";

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

  return buffer.toString("utf-8");
}

// ─────────────────────────────────────────────────────────────
// EMBEDDING
// ─────────────────────────────────────────────────────────────

async function embed(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });

  return response.data[0].embedding;
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
// MAIN
// ─────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  const fileArg = args["file"];
  const actName = args["act"];
  const yearStr = args["year"];
  const jurisdiction = args["jurisdiction"] ?? "Pakistan";
  const sourceUrl = args["source-url"] ?? null;

  if (!fileArg || !actName) {
    console.error("Usage: --file <path> --act <name> [--year N]");
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
  const chunks = chunkBySections(cleanedText);
  console.log(`Found ${chunks.length} chunks.`);

  // ─────────────────────────────────────────────────────────
  // EMBED + INSERT
  // ─────────────────────────────────────────────────────────

  const BATCH_SIZE = 20;
  let inserted = 0;

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);

    const embeddings = await Promise.all(
      batch.map((c) => embed(c.content))
    );

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
}

main().catch((err) => {
  console.error("\nFatal:", err);
  process.exit(1);
});