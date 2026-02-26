// POST /api/cases/[caseId]/documents/[docId]/generate
//
// Gathers case + client context, calls OpenAI gpt-4o to produce a
// litigation-ready legal document, saves a version of any existing
// content, then updates the document in place.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

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
  _req: Request,
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

  // ── Gather case context ──────────────────────────────────────────────────
  const { data: caseData } = await supabase
    .from("cases")
    .select("id, case_number, title, status, court, judge, filed_date, description, client_id")
    .eq("id", caseId)
    .maybeSingle();

  if (!caseData) return NextResponse.json({ error: "Case not found" }, { status: 404 });

  let clientBlock = "";
  if (caseData.client_id) {
    const { data: client } = await supabase
      .from("clients")
      .select("full_name, cnic, phone, email, client_type, contact_name, address")
      .eq("id", caseData.client_id)
      .maybeSingle();

    if (client) {
      clientBlock = [
        `\nCLIENT INFORMATION:`,
        `Name: ${client.full_name}`,
        client.cnic        ? `CNIC: ${client.cnic}` : null,
        client.client_type ? `Type: ${client.client_type}` : null,
        client.contact_name ? `Contact: ${client.contact_name}` : null,
        client.phone       ? `Phone: ${client.phone}` : null,
        client.email       ? `Email: ${client.email}` : null,
        client.address     ? `Address: ${client.address}` : null,
      ].filter(Boolean).join("\n");
    }
  }

  // ── Gather chat context ──────────────────────────────────────────────────
  const { data: chats } = await supabase
    .from("chats")
    .select("id")
    .eq("case_id", caseId)
    .limit(5);

  let chatBlock = "";
  if (chats && chats.length > 0) {
    const chatIds = chats.map((c) => c.id);
    const { data: messages } = await supabase
      .from("messages")
      .select("role, content")
      .in("chat_id", chatIds)
      .order("created_at", { ascending: true })
      .limit(40);

    if (messages && messages.length > 0) {
      chatBlock = `\nCASE DISCUSSION NOTES:\n` +
        messages.map((m) => `[${m.role.toUpperCase()}]: ${m.content.slice(0, 600)}`).join("\n");
    }
  }

  const userContent = [
    `Case Number: ${caseData.case_number}`,
    `Case Title: ${caseData.title}`,
    `Status: ${caseData.status}`,
    caseData.court      ? `Court: ${caseData.court}` : null,
    caseData.judge      ? `Judge: ${caseData.judge}` : null,
    caseData.filed_date ? `Filed: ${caseData.filed_date}` : null,
    caseData.description ? `Description: ${caseData.description}` : null,
    clientBlock,
    chatBlock,
  ].filter(Boolean).join("\n");

  // ── Generate ─────────────────────────────────────────────────────────────
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: userContent },
    ],
    temperature: 0.2,
    max_tokens: 4096,
  });

  const generatedContent = completion.choices[0]?.message?.content?.trim() ?? "";

  // ── Version existing content before overwriting ──────────────────────────
  const { data: existing } = await supabase
    .from("case_documents")
    .select("content")
    .eq("id", docId)
    .maybeSingle();

  if (existing?.content) {
    await supabase.from("case_document_versions").insert({
      document_id: docId,
      content: existing.content,
      saved_by: user.id,
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
