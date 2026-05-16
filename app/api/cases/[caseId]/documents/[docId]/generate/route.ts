// POST /api/cases/[caseId]/documents/[docId]/generate
//
// Accepts { sources: string[], custom_prompt?: string } from the client.
// Only loads context for the sources the user selected:
//
//   "case_details" → case title, court, judge, description, client info
//   "chat_history" → messages from case-linked chats
//   "documents"    → text chunks from case-scoped RAG documents
//   "custom"       → custom_prompt string passed verbatim
//
// Falls back to case_details + chat_history when sources is omitted
// (e.g. auto-generate on first open).

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { callClaude } from "@/lib/claude";

export const runtime = "nodejs";

type Source = "case_details" | "chat_history" | "documents" | "custom";

const SYSTEM_PROMPT = `You are a professional litigation drafting assistant.

Generate a structured, court-ready legal document using the information provided.

STRICT FORMAT:

TITLE

PARTIES

FACTS

ISSUES FOR DETERMINATION

APPLICABLE LAW

LEGAL ANALYSIS

RELIEF SOUGHT

Rules:
- Formal tone
- No emojis
- No conversational phrases
- No disclaimers
- No mention of AI
- No mention of database
- No repetition
- Clear section headings in ALL CAPS
- Number legal issues properly

If information is missing, draft conservatively using neutral phrasing.
Produce output suitable for filing or internal strategy review.`;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ caseId: string; docId: string }> }
) {
  const { caseId, docId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: roleRow } = await supabase
    .from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
  if (roleRow?.role === "staff") {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  // ── Parse request body ────────────────────────────────────────────────────
  const body = await req.json().catch(() => ({})) as { sources?: unknown; custom_prompt?: unknown };
  const sources: Source[] = Array.isArray(body.sources) && body.sources.length > 0
    ? (body.sources as Source[])
    : ["case_details", "chat_history"]; // default fallback
  const customPrompt = typeof body.custom_prompt === "string" ? body.custom_prompt.trim() : "";

  const wantCaseDetails = sources.includes("case_details");
  const wantChatHistory = sources.includes("chat_history");
  const wantDocuments   = sources.includes("documents");
  const wantCustom      = sources.includes("custom");

  // ── Always fetch case (needed for 404 check + document title) ─────────────
  const { data: caseData } = await supabase
    .from("cases")
    .select("id, case_number, title, status, court, judge, filed_date, description, client_id")
    .eq("id", caseId)
    .maybeSingle();

  if (!caseData) return NextResponse.json({ error: "Case not found" }, { status: 404 });

  // ── Build context blocks ──────────────────────────────────────────────────
  const contextParts: string[] = [];

  // Case details + client
  if (wantCaseDetails) {
    contextParts.push([
      `Case Number: ${caseData.case_number}`,
      `Case Title: ${caseData.title}`,
      `Status: ${caseData.status}`,
      caseData.court       ? `Court: ${caseData.court}`             : null,
      caseData.judge       ? `Judge: ${caseData.judge}`             : null,
      caseData.filed_date  ? `Filed: ${caseData.filed_date}`        : null,
      caseData.description ? `Description: ${caseData.description}` : null,
    ].filter(Boolean).join("\n"));

    if (caseData.client_id) {
      const { data: client } = await supabase
        .from("clients")
        .select("full_name, cnic, phone, email, client_type, contact_name, address")
        .eq("id", caseData.client_id)
        .maybeSingle();

      if (client) {
        contextParts.push([
          `\nCLIENT INFORMATION:`,
          `Name: ${client.full_name}`,
          client.cnic         ? `CNIC: ${client.cnic}`            : null,
          client.client_type  ? `Type: ${client.client_type}`     : null,
          client.contact_name ? `Contact: ${client.contact_name}` : null,
          client.phone        ? `Phone: ${client.phone}`          : null,
          client.email        ? `Email: ${client.email}`          : null,
          client.address      ? `Address: ${client.address}`      : null,
        ].filter(Boolean).join("\n"));
      }
    }
  }

  // Chat history
  if (wantChatHistory) {
    const { data: chats } = await supabase
      .from("chats")
      .select("id")
      .eq("case_id", caseId)
      .limit(5);

    if (chats && chats.length > 0) {
      const { data: messages } = await supabase
        .from("messages")
        .select("role, content")
        .in("chat_id", chats.map((c) => c.id))
        .order("created_at", { ascending: true })
        .limit(40);

      if (messages && messages.length > 0) {
        contextParts.push(
          `\nCASE DISCUSSION NOTES:\n` +
          messages.map((m) => `[${m.role.toUpperCase()}]: ${m.content.slice(0, 600)}`).join("\n")
        );
      }
    }
  }

  // Uploaded documents (case-scoped RAG chunks)
  if (wantDocuments) {
    const { data: docChunks } = await supabase
      .from("documents")
      .select("file_name, content, chunk_index")
      .eq("case_id", caseId)
      .eq("scope", "case")
      .order("chunk_index", { ascending: true })
      .limit(20);

    if (docChunks && docChunks.length > 0) {
      const grouped: Record<string, string[]> = {};
      for (const c of docChunks) {
        if (!grouped[c.file_name]) grouped[c.file_name] = [];
        grouped[c.file_name].push(c.content);
      }
      const docsBlock = Object.entries(grouped)
        .map(([name, chunks]) => `[${name}]\n${chunks.join("\n")}`)
        .join("\n\n");
      contextParts.push(`\nUPLOADED DOCUMENTS:\n${docsBlock}`);
    }
  }

  // Custom prompt
  if (wantCustom && customPrompt) {
    contextParts.push(`\nADDITIONAL INSTRUCTIONS:\n${customPrompt}`);
  }

  if (contextParts.length === 0) {
    return NextResponse.json(
      { error: "No context available for the selected sources. Add case details, chat history, or uploaded documents first." },
      { status: 400 }
    );
  }

  const userContent = contextParts.join("\n");

  // ── Generate ─────────────────────────────────────────────────────────────
  const generatedContent = await callClaude(
    [{ role: "user", content: userContent }],
    { system: SYSTEM_PROMPT, temperature: 0.2, max_tokens: 4096 },
  );

  // ── Version existing content before overwriting ──────────────────────────
  const { data: existing } = await supabase
    .from("case_documents")
    .select("content")
    .eq("id", docId)
    .maybeSingle();

  if (existing?.content) {
    await supabase.from("case_document_versions").insert({
      document_id: docId,
      content:     existing.content,
      saved_by:    user.id,
    });
  }

  // ── Persist ──────────────────────────────────────────────────────────────
  const { data: updatedDoc, error } = await supabase
    .from("case_documents")
    .update({
      content: generatedContent,
      title:   `Legal Document — ${caseData.title}`,
    })
    .eq("id", docId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(updatedDoc);
}
