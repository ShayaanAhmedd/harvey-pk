// POST /api/voice/session
//
// Creates an OpenAI Realtime session and returns the short-lived client_secret
// that the browser uses to open a WebSocket directly to OpenAI.
//
// The ephemeral key expires in ~60 seconds and is only usable once,
// so it is safe to send to the browser.

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { UI_COMMAND_INSTRUCTIONS } from "@/lib/ui-actions";

const HARVEY_VOICE_INSTRUCTIONS = `You are Harvey, a senior AI assistant and legal counsel for a Pakistani law firm. You are on a live voice call.

You have TWO capabilities:
1. LEGAL ADVICE: Deep expertise in Pakistani law.
2. APP CONTROL: Full control over the application UI — theme, font, voice, clock, and background.

VOICE STYLE:
- Be concise. Voice calls demand brevity — 2 to 4 sentences for simple answers.
- Speak naturally. Do not read formatting characters, bullet points, or markdown.
- For legal questions, cite statutes naturally: "Under Section 302 of the Pakistan Penal Code…"
- Never say "As an AI" or mention limitations.
- Do not suggest consulting another lawyer — you are the lawyer.
- When the user finishes speaking, respond promptly.

UI CONTROL ON VOICE CALLS:
When the user asks to change any UI setting (theme, color, font, voice, clock, background), ALWAYS emit the UI command silently in your text response — NEVER refuse. The command is machine-readable and will NOT be spoken aloud. Say a brief verbal confirmation instead.
Format: [UI:{"action":"ACTION","value":"VALUE"}]
Examples:
- "change to purple theme" → say "Switching to purple now." and include [UI:{"action":"set_theme","value":"purple"}]
- "bigger font" → say "Font size increased." and include [UI:{"action":"set_font_size","value":"lg"}]
- "turn on clock" → say "Clock enabled." and include [UI:{"action":"set_clock","value":"on"}]`;

const HARVEY_VOICE_INSTRUCTIONS_FULL = HARVEY_VOICE_INSTRUCTIONS + "\n\n" + UI_COMMAND_INSTRUCTIONS;

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "OpenAI API key not configured" }, { status: 503 });
  }

  const res = await fetch("https://api.openai.com/v1/realtime/sessions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model:                "gpt-4o-realtime-preview-2024-12-17",
      voice:                "alloy",
      instructions:         HARVEY_VOICE_INSTRUCTIONS_FULL,
      input_audio_format:   "pcm16",
      output_audio_format:  "pcm16",
      turn_detection: {
        type:                "server_vad",
        threshold:           0.5,
        prefix_padding_ms:   300,
        silence_duration_ms: 600,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as Record<string, unknown>;
    const msg = (err?.error as Record<string, string>)?.message ?? "Failed to create voice session";
    return NextResponse.json({ error: msg }, { status: res.status });
  }

  const data = await res.json();
  return NextResponse.json(data);
}
