// GET  /api/voice/calls?case_id=X  → list calls for a case (latest first)
// POST /api/voice/calls            → save transcript + generate summary

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { callClaude } from "@/lib/claude";

interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  time: string;
}

const SUMMARY_SYSTEM = `You are summarising a voice conversation between a Pakistani lawyer and Harvey, an AI legal counsel specialising in Pakistani law.

Write a concise professional summary (3–6 sentences) covering:
- The legal topic or issue discussed
- Key advice or analysis given
- Statutes, sections, or cases cited (if any)
- Any conclusions or action items

Be factual. Do not invent information. Do not use bullet points — write in prose.`;

export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const caseId = searchParams.get("case_id");
  if (!caseId) return NextResponse.json({ error: "case_id required" }, { status: 400 });

  const { data, error } = await supabase
    .from("voice_calls")
    .select("id, summary, transcript, created_at")
    .eq("case_id", caseId)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({})) as {
    transcript?: TranscriptEntry[];
    chat_id?:   string;
    case_id?:   string;
  };

  const transcript: TranscriptEntry[] = Array.isArray(body.transcript) ? body.transcript : [];
  if (transcript.length === 0) {
    return NextResponse.json({ error: "Empty transcript" }, { status: 400 });
  }

  // Format for Claude
  const transcriptText = transcript
    .map(e => `[${e.time}] ${e.role === "user" ? "Lawyer" : "Harvey"}: ${e.text}`)
    .join("\n");

  // Generate summary
  let summary = "Summary unavailable.";
  try {
    summary = await callClaude(
      [{ role: "user", content: `TRANSCRIPT:\n\n${transcriptText}` }],
      { system: SUMMARY_SYSTEM, temperature: 0.3, max_tokens: 512 },
    );
  } catch {
    // non-fatal — save with fallback summary
  }

  // Persist
  const { data, error } = await supabase
    .from("voice_calls")
    .insert({
      user_id:    user.id,
      chat_id:    body.chat_id ?? null,
      case_id:    body.case_id ?? null,
      transcript,
      summary,
    })
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ id: data.id, summary });
}
