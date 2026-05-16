// POST /api/upload
//
// Accepts multipart/form-data:
//   file         — single document (docx, pdf, txt)
//   files[]      — multiple documents (folder / bulk upload)
//   caseId       — (optional) UUID of the case; omit for global uploads
//   scope        — (optional) 'case' | 'global'; inferred from caseId if omitted
//
// For global uploads, additional legal metadata fields:
//   act_name, year, jurisdiction, source_url, tags
//
// Multipart parsing: uses busboy (streaming) instead of req.formData() so that
// large folder uploads (many PDFs) never hit Next.js's buffering limit.
//
// Two Supabase clients are used:
//   • userClient  — anon key + user session → auth checks + document inserts (RLS applies)
//   • adminClient — service role key        → storage uploads (bypasses storage RLS)

export const runtime    = "nodejs";
export const maxDuration = 300; // folder uploads can take several minutes

import Busboy from "busboy";
import { Readable } from "stream";
import { chunkText } from "@/lib/chunker";
import { chunkBySections } from "@/lib/section-chunker";
import { embedText } from "@/lib/embeddings";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import mammoth from "mammoth";
import { extractTextWithOCR } from "@/lib/utils/ocr";

// ── Types ────────────────────────────────────────────────────────────────────

type ParsedFile = {
  fieldname: string;
  filename:  string;
  buffer:    Buffer;
  mimetype:  string;
};

type ParsedForm = {
  fields: Record<string, string>;
  files:  ParsedFile[];
};

// ── Multipart parser (busboy streaming) ──────────────────────────────────────
//
// Replaces req.formData() which buffers the entire body before parsing and
// throws on large uploads. Busboy parses the multipart stream incrementally,
// so it handles any number of files of any size.

async function parseMultipart(req: Request): Promise<ParsedForm> {
  const contentType = req.headers.get("content-type") ?? "";

  if (!contentType.includes("multipart/form-data")) {
    throw new Error(`Expected multipart/form-data, got: ${contentType}`);
  }

  const fields: Record<string, string> = {};
  const files:  ParsedFile[]           = [];

  await new Promise<void>((resolve, reject) => {
    const busboy = Busboy({ headers: { "content-type": contentType } });

    busboy.on("file", (fieldname, stream, info) => {
      const chunks: Buffer[] = [];

      stream.on("data",  (chunk: Buffer) => chunks.push(chunk));
      stream.on("error", reject);
      stream.on("end", () => {
        // Skip zero-byte entries (browser sometimes sends empty slots)
        const buffer = Buffer.concat(chunks);
        if (buffer.length > 0 && info.filename) {
          files.push({
            fieldname,
            filename: info.filename,
            buffer,
            mimetype: info.mimeType || "application/octet-stream",
          });
        }
      });
    });

    busboy.on("field", (name, value) => {
      fields[name] = value;
    });

    busboy.on("finish", resolve);
    busboy.on("error",  reject);

    if (!req.body) {
      reject(new Error("Request body is empty"));
      return;
    }

    // Bridge Web ReadableStream → Node.js Readable → busboy
    Readable.fromWeb(req.body as import("stream/web").ReadableStream<Uint8Array>).pipe(busboy);
  });

  return { fields, files };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("SUPABASE_SERVICE_KEY is not set in .env.local");
  return createSupabaseClient(url, key);
}

const SUPPORTED_EXTS = new Set(["pdf", "txt", "docx"]);

// ── Per-file processor ────────────────────────────────────────────────────────

async function processOneFile(
  parsed: ParsedFile,
  opts: {
    scope:        "case" | "global";
    userId:       string;
    caseId:       string | null;
    actName:      string | null;
    yearInt:      number | null;
    jurisdiction: string;
    sourceUrl:    string | null;
    tagsJson:     unknown[] | null;
    supabase:     Awaited<ReturnType<typeof createClient>>;
  }
): Promise<{ fileName: string; chunks: number; storagePath: string | null; error?: string }> {
  const { scope, userId, caseId, actName, yearInt, jurisdiction, sourceUrl, tagsJson, supabase } = opts;
  const { filename, buffer, mimetype } = parsed;

  const ext      = filename.toLowerCase().split(".").pop() ?? "";
  const fileType = ({ docx: "docx", pdf: "pdf", txt: "txt" } as Record<string, string>)[ext] ?? "other";

  // Text extraction
  let text = "";
  try {
    if (ext === "docx") {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } else if (ext === "pdf") {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
      const result = await pdfParse(buffer);
      text = result.text;
      if (!text || text.trim().length < 500) {
        try { text = await extractTextWithOCR(buffer); } catch { /* keep partial text */ }
      }
    } else {
      text = buffer.toString("utf-8");
    }
  } catch {
    return { fileName: filename, chunks: 0, storagePath: null, error: "Text extraction failed" };
  }

  const cleanedText = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!cleanedText || cleanedText.length < 20) {
    return { fileName: filename, chunks: 0, storagePath: null, error: "No usable text found" };
  }

  // Storage upload (global only)
  let storagePath: string | null = null;
  if (scope === "global") {
    try {
      const folder = actName ? toSlug(actName) : "uncategorised";
      storagePath  = `${folder}/${filename}`;
      const { error: storageErr } = await adminClient()
        .storage.from("legal-documents")
        .upload(storagePath, buffer, {
          contentType: mimetype,
          upsert: true,
        });
      if (storageErr) storagePath = null;
    } catch { storagePath = null; }
  }

  // Chunking + embedding + insert
  const BATCH = 20;

  if (scope === "global") {
    const legalChunks = chunkBySections(cleanedText);
    console.log(`[UPLOAD] ${filename}: ${legalChunks.length} chunks`);

    const embeddings: number[][] = [];
    for (let i = 0; i < legalChunks.length; i += BATCH) {
      const batch = await Promise.all(
        legalChunks.slice(i, i + BATCH).map((c) => embedText(c.content))
      );
      embeddings.push(...batch);
    }

    const rows = legalChunks.map((chunk, i) => ({
      case_id:        null,
      file_name:      filename,
      file_type:      fileType,
      chunk_index:    chunk.chunk_index,
      content:        chunk.content,
      embedding:      embeddings[i],
      scope:          "global",
      uploaded_by:    userId,
      storage_path:   storagePath,
      act_name:       actName,
      title:          chunk.title,
      section_number: chunk.section_number,
      chapter:        chunk.chapter,
      year:           yearInt,
      jurisdiction,
      source_url:     sourceUrl,
      tags:           tagsJson,
    }));

    const { error: insertError } = await supabase.from("documents").insert(rows);
    if (insertError) {
      return { fileName: filename, chunks: 0, storagePath, error: insertError.message };
    }
    return { fileName: filename, chunks: rows.length, storagePath };

  } else {
    const chunks = chunkText(cleanedText, 1000);

    const embeddings: number[][] = [];
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = await Promise.all(chunks.slice(i, i + BATCH).map((c) => embedText(c)));
      embeddings.push(...batch);
    }

    const rows = chunks.map((chunk, index) => ({
      case_id:     caseId,
      file_name:   filename,
      file_type:   fileType,
      chunk_index: index,
      content:     chunk,
      embedding:   embeddings[index],
      scope:       "case",
      uploaded_by: userId,
    }));

    const { error: insertError } = await supabase.from("documents").insert(rows);
    if (insertError) {
      return { fileName: filename, chunks: 0, storagePath: null, error: insertError.message };
    }
    return { fileName: filename, chunks: rows.length, storagePath: null };
  }
}

// ── POST handler ──────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  // ── Auth ─────────────────────────────────────────────────────────
  const userSupabase = await createClient();
  const { data: { user } } = await userSupabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // ── Parse multipart form data (streaming via busboy) ─────────────
  let parsed: ParsedForm;
  try {
    parsed = await parseMultipart(req);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[UPLOAD] multipart parse failed:", msg);
    return NextResponse.json({ error: "Could not parse upload", details: msg }, { status: 400 });
  }

  const { fields, files: parsedFiles } = parsed;

  // ── Extract fields ────────────────────────────────────────────────
  const caseId      = fields["caseId"] || null;
  const scopeParam  = fields["scope"]  || null;
  const actName     = fields["act_name"] || null;
  const yearInt     = fields["year"] ? (parseInt(fields["year"], 10) || null) : null;
  const jurisdiction = fields["jurisdiction"] || "Pakistan";
  const sourceUrl   = fields["source_url"] || null;
  let   tagsJson: unknown[] | null = null;
  if (fields["tags"]) {
    try { tagsJson = JSON.parse(fields["tags"]); } catch { tagsJson = null; }
  }

  // ── Collect files — accepts both "file" (single) and "files" (array) ─
  // Also filters out any unsupported extensions from folder uploads
  const files = parsedFiles.filter(
    (f) => (f.fieldname === "file" || f.fieldname === "files") &&
           SUPPORTED_EXTS.has(f.filename.toLowerCase().split(".").pop() ?? "")
  );

  if (files.length === 0) {
    return NextResponse.json(
      { error: "No supported files received. Use field name 'file' or 'files[]', formats: pdf, txt, docx" },
      { status: 400 }
    );
  }

  // ── Scope ─────────────────────────────────────────────────────────
  const scope: "case" | "global" = caseId
    ? "case"
    : scopeParam === "global"
      ? "global"
      : "case";

  if (scope === "case" && !caseId) {
    return NextResponse.json({ error: "caseId is required for case-scoped uploads" }, { status: 400 });
  }

  // ── Admin gate for global uploads ─────────────────────────────────
  if (scope === "global") {
    const { data: roleRow } = await userSupabase
      .from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
    if (roleRow?.role !== "admin") {
      return NextResponse.json(
        { error: "Only admins can upload to the global knowledge base" },
        { status: 403 }
      );
    }
  }

  // ── Process files sequentially (avoids memory spikes) ────────────
  const commonOpts = {
    scope,
    userId:      user.id,
    caseId,
    actName,
    yearInt,
    jurisdiction,
    sourceUrl,
    tagsJson,
    supabase:    userSupabase,
  };

  try {
    const results: { fileName: string; chunks: number; storagePath: string | null; error?: string }[] = [];

    for (const file of files) {
      const result = await processOneFile(file, commonOpts);
      results.push(result);
      console.log(
        `[UPLOAD] processed ${file.filename}: ${result.chunks} chunks` +
        (result.error ? ` (error: ${result.error})` : "")
      );
    }

    const totalChunks = results.reduce((sum, r) => sum + r.chunks, 0);
    const failures    = results.filter((r) => r.error);
    const successes   = results.filter((r) => !r.error);

    if (successes.length === 0) {
      return NextResponse.json(
        { error: "All files failed to process", details: failures.map((f) => `${f.fileName}: ${f.error}`).join("; ") },
        { status: 500 }
      );
    }

    // Single-file: keep original response shape for backwards compat
    if (files.length === 1) {
      const r = results[0];
      if (r.error) return NextResponse.json({ error: r.error }, { status: 500 });
      return NextResponse.json({
        message:      scope === "global" ? "Law document stored successfully" : "Document stored successfully",
        totalChunks:  r.chunks,
        scope,
        act_name:     actName,
        storage_path: r.storagePath,
        file_name:    r.fileName,
      });
    }

    // Multi-file: aggregated result
    return NextResponse.json({
      message:    `${successes.length} of ${files.length} files processed successfully`,
      totalChunks,
      fileCount:  successes.length,
      scope,
      act_name:   actName,
      files:      results.map((r) => ({
        file_name:    r.fileName,
        chunks:       r.chunks,
        storage_path: r.storagePath,
        error:        r.error ?? null,
      })),
      ...(failures.length > 0 && {
        warnings: failures.map((f) => `${f.fileName}: ${f.error}`),
      }),
    });

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "Upload failed", details: msg }, { status: 500 });
  }
}
