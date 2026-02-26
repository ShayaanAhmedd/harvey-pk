// POST /api/upload
//
// Accepts multipart/form-data:
//   file         — the document (docx, pdf, txt)
//   caseId       — (optional) UUID of the case; omit for global uploads
//   scope        — (optional) 'case' | 'global'; inferred from caseId if omitted
//
// For global uploads, additional legal metadata fields:
//   act_name, year, jurisdiction, source_url, tags
//
// Two Supabase clients are used:
//   • userClient  — anon key + user session → auth checks + document inserts (RLS applies)
//   • adminClient — service role key        → storage uploads (bypasses storage RLS)

import { chunkText } from "@/lib/chunker";
import { chunkBySections } from "@/lib/section-chunker";
import { embedText } from "@/lib/embeddings";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import mammoth from "mammoth";

/** Slugify an act name for use as a storage folder path. */
function toSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Service-role client — bypasses RLS, used only for storage uploads. */
function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("SUPABASE_SERVICE_KEY is not set in .env.local");
  return createSupabaseClient(url, key);
}

export async function POST(req: Request) {
  // ── Auth (user session client) ────────────────────────────────
  const userSupabase = await createClient();
  const { data: { user } } = await userSupabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // ── Parse form data ───────────────────────────────────────────
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[upload] formData parse error:", msg);
    return NextResponse.json({ error: "Invalid multipart form data", details: msg }, { status: 400 });
  }

  const file       = formData.get("file") as File | null;
  const caseId     = (formData.get("caseId") as string | null) || null;
  const scopeParam = formData.get("scope") as string | null;

  if (!file || !(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "A non-empty 'file' field is required" }, { status: 400 });
  }

  // Legal metadata (global uploads only)
  const actName    = (formData.get("act_name") as string | null) || null;
  const yearRaw    = formData.get("year") as string | null;
  const yearInt    = yearRaw ? (parseInt(yearRaw, 10) || null) : null;
  const jurisdiction = (formData.get("jurisdiction") as string | null) || "Pakistan";
  const sourceUrl  = (formData.get("source_url") as string | null) || null;
  const tagsRaw    = formData.get("tags") as string | null;
  let   tagsJson: unknown[] | null = null;
  if (tagsRaw) { try { tagsJson = JSON.parse(tagsRaw); } catch { tagsJson = null; } }

  // ── Scope ─────────────────────────────────────────────────────
  const scope: "case" | "global" = caseId ? "case" : scopeParam === "global" ? "global" : "case";

  if (scope === "case" && !caseId) {
    return NextResponse.json({ error: "caseId is required for case-scoped uploads" }, { status: 400 });
  }

  // ── Admin gate for global uploads ────────────────────────────
  if (scope === "global") {
    const { data: roleRow } = await userSupabase
      .from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
    if (roleRow?.role !== "admin") {
      return NextResponse.json({ error: "Only admins can upload to the global knowledge base" }, { status: 403 });
    }
  }

  // ── Buffer + extension ────────────────────────────────────────
  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[upload] arrayBuffer error:", msg);
    return NextResponse.json({ error: "Could not read file buffer", details: msg }, { status: 400 });
  }

  const ext = file.name.toLowerCase().split(".").pop() ?? "";

  // ── Text extraction ───────────────────────────────────────────
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
    } else {
      text = buffer.toString("utf-8");
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[upload] text extraction error:", msg);
    return NextResponse.json({ error: "Text extraction failed", details: msg }, { status: 500 });
  }

  const cleanedText = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!cleanedText || cleanedText.length < 20) {
    return NextResponse.json({ error: "No usable text found in file. PDF may be scanned/image-based." }, { status: 400 });
  }

  // ── Storage upload (global only) ─────────────────────────────
  // Uses service role client to bypass storage RLS.
  let storagePath: string | null = null;
  if (scope === "global") {
    try {
      const folder = actName ? toSlug(actName) : "uncategorised";
      storagePath  = `${folder}/${file.name}`;
      const { error: storageErr } = await adminClient()
        .storage.from("legal-documents")
        .upload(storagePath, buffer, {
          contentType: file.type || "application/octet-stream",
          upsert: true,
        });
      if (storageErr) {
        console.warn("[upload] Storage upload failed (non-fatal):", storageErr.message);
        storagePath = null; // chunks still get inserted; re-index won't be available
      }
    } catch (e: unknown) {
      console.warn("[upload] adminClient error:", e instanceof Error ? e.message : e);
      storagePath = null;
    }
  }

  // ── Chunking + embedding + insert ────────────────────────────
  const fileTypeMap: Record<string, string> = { docx: "docx", pdf: "pdf", txt: "txt" };
  const file_type = fileTypeMap[ext] ?? "other";

  try {
    if (scope === "global") {
      const legalChunks = chunkBySections(cleanedText);

      // Batch embeddings in groups of 20 to avoid rate-limit spikes
      const BATCH = 20;
      const embeddings: number[][] = [];
      for (let i = 0; i < legalChunks.length; i += BATCH) {
        const batch = await Promise.all(legalChunks.slice(i, i + BATCH).map((c) => embedText(c.content)));
        embeddings.push(...batch);
      }

      const rows = legalChunks.map((chunk, i) => ({
        case_id:        null,
        file_name:      file.name,
        file_type,
        chunk_index:    chunk.chunk_index,
        content:        chunk.content,
        embedding:      embeddings[i],
        scope:          "global",
        uploaded_by:    user.id,
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

      const { error: insertError } = await userSupabase.from("documents").insert(rows);
      if (insertError) {
        console.error("[upload] insert error:", insertError.message);
        return NextResponse.json({ error: "Database insert failed", details: insertError.message }, { status: 500 });
      }

      return NextResponse.json({
        message:      "Law document stored successfully",
        totalChunks:  rows.length,
        scope:        "global",
        act_name:     actName,
        storage_path: storagePath,
      });

    } else {
      const chunks = chunkText(cleanedText, 1000);

      const BATCH = 20;
      const embeddings: number[][] = [];
      for (let i = 0; i < chunks.length; i += BATCH) {
        const batch = await Promise.all(chunks.slice(i, i + BATCH).map((c) => embedText(c)));
        embeddings.push(...batch);
      }

      const rows = chunks.map((chunk, index) => ({
        case_id:     caseId,
        file_name:   file.name,
        file_type,
        chunk_index: index,
        content:     chunk,
        embedding:   embeddings[index],
        scope:       "case",
        uploaded_by: user.id,
      }));

      const { error: insertError } = await userSupabase.from("documents").insert(rows);
      if (insertError) {
        console.error("[upload] insert error:", insertError.message);
        return NextResponse.json({ error: "Database insert failed", details: insertError.message }, { status: 500 });
      }

      return NextResponse.json({
        message:     "Document stored successfully",
        totalChunks: chunks.length,
        scope:       "case",
      });
    }

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[upload] unhandled error:", msg);
    return NextResponse.json({ error: "Upload failed", details: msg }, { status: 500 });
  }
}
