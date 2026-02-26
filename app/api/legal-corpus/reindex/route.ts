// POST /api/legal-corpus/reindex
//
// Body: { act_name: string }
//
// Admin-only. Re-embeds an entire act from its stored file in Supabase Storage:
//   1. Look up one chunk to get storage_path + metadata
//   2. Download the file from the "legal-documents" bucket
//   3. Extract text (pdf-parse or UTF-8)
//   4. Re-chunk with chunkBySections()
//   5. Re-embed all chunks
//   6. Delete old chunks for the act
//   7. Insert new chunks
//
// This is useful after updating the section-chunker logic or the embeddings model.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { chunkBySections } from "@/lib/section-chunker";
import { embedText } from "@/lib/embeddings";
import mammoth from "mammoth";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Admin only
  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (roleRow?.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const actName: string | undefined = body.act_name;
  if (!actName) {
    return NextResponse.json({ error: "act_name is required" }, { status: 400 });
  }

  // ── 1. Fetch representative chunk to get storage_path + metadata ──
  const { data: seedRow, error: seedErr } = await supabase
    .from("documents")
    .select(
      "storage_path, file_name, file_type, year, jurisdiction, source_url, tags, uploaded_by"
    )
    .eq("scope", "global")
    .eq("act_name", actName)
    .not("storage_path", "is", null)
    .limit(1)
    .maybeSingle();

  if (seedErr || !seedRow) {
    return NextResponse.json(
      {
        error: "No stored file found for this act. Re-upload via the Legal Corpus page.",
      },
      { status: 404 }
    );
  }

  const { storage_path, file_name, file_type, year, jurisdiction, source_url, tags, uploaded_by } =
    seedRow;

  // ── 2. Download file from Storage ────────────────────────────
  const { data: fileData, error: downloadErr } = await supabase.storage
    .from("legal-documents")
    .download(storage_path!);

  if (downloadErr || !fileData) {
    return NextResponse.json(
      { error: "Could not download stored file: " + (downloadErr?.message ?? "unknown") },
      { status: 500 }
    );
  }

  const buffer = Buffer.from(await fileData.arrayBuffer());

  // ── 3. Extract text ───────────────────────────────────────────
  let text = "";
  const ext = (file_name ?? "").toLowerCase().split(".").pop() ?? "";
  if (ext === "docx" || file_type === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    text = result.value;
  } else if (ext === "pdf" || file_type === "pdf") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
    const result = await pdfParse(buffer);
    text = result.text;
  } else {
    text = buffer.toString("utf-8");
  }

  const cleanedText = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!cleanedText) {
    return NextResponse.json({ error: "No text content found in stored file" }, { status: 400 });
  }

  // ── 4. Re-chunk ───────────────────────────────────────────────
  const legalChunks = chunkBySections(cleanedText);

  // ── 5. Re-embed ───────────────────────────────────────────────
  const embeddings = await Promise.all(
    legalChunks.map((c) => embedText(c.content))
  );

  // ── 6. Delete old chunks ──────────────────────────────────────
  const { error: deleteErr } = await supabase
    .from("documents")
    .delete()
    .eq("scope", "global")
    .eq("act_name", actName);

  if (deleteErr) {
    return NextResponse.json({ error: "Delete failed: " + deleteErr.message }, { status: 500 });
  }

  // ── 7. Insert new chunks ──────────────────────────────────────
  const rows = legalChunks.map((chunk, i) => ({
    case_id: null,
    file_name,
    file_type: file_type ?? "other",
    chunk_index: chunk.chunk_index,
    content: chunk.content,
    embedding: embeddings[i],
    scope: "global",
    uploaded_by,
    storage_path,
    act_name: actName,
    title: chunk.title,
    section_number: chunk.section_number,
    chapter: chunk.chapter,
    year,
    jurisdiction: jurisdiction ?? "Pakistan",
    source_url,
    tags,
  }));

  const { error: insertErr } = await supabase.from("documents").insert(rows);
  if (insertErr) {
    return NextResponse.json({ error: "Insert failed: " + insertErr.message }, { status: 500 });
  }

  return NextResponse.json({
    message: `Re-indexed successfully`,
    act_name: actName,
    new_chunk_count: rows.length,
  });
}
