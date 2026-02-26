// POST /api/transcribe
//
// Accepts multipart/form-data with an "audio" field.
// Returns { text: string }.
//
// No MIME-type gatekeeping — OpenAI validates the file on its end.
// Do NOT set Content-Type on the fetch call from the browser;
// let the browser set the multipart boundary automatically.

import { NextResponse } from "next/server";
import OpenAI from "openai";
import { createClient } from "@/lib/supabase/server";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — OpenAI limit

// Strip codec parameters ("audio/webm;codecs=opus" → "audio/webm")
// so the extension map always gets a clean base MIME type.
function baseMime(raw: string): string {
  return raw.split(";")[0].trim().toLowerCase();
}

// Map base MIME → file extension OpenAI accepts
const EXT_MAP: Record<string, string> = {
  "audio/webm":  "webm",
  "video/webm":  "webm", // Chrome sometimes labels it video/webm
  "audio/mp4":   "mp4",
  "audio/m4a":   "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav":   "wav",
  "audio/wave":  "wav",
  "audio/mp3":   "mp3",
  "audio/mpeg":  "mp3",
  "audio/ogg":   "ogg",
  "audio/opus":  "opus",
};

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const audioField = formData.get("audio");
  if (!audioField || !(audioField instanceof File)) {
    return NextResponse.json({ error: "'audio' file field is required" }, { status: 400 });
  }

  if (audioField.size > MAX_BYTES) {
    return NextResponse.json({ error: "Audio too large (max 25 MB)" }, { status: 413 });
  }

  // Derive a clean extension for the filename OpenAI receives
  const raw  = audioField.type || "audio/webm";
  const base = baseMime(raw);
  const ext  = EXT_MAP[base] ?? "webm";

  // Build a proper File object — OpenAI SDK requires .name to infer format
  const arrayBuffer = await audioField.arrayBuffer();
  const file = new File([arrayBuffer], `recording.${ext}`, { type: base });

  try {
    const result = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file,
      response_format: "json",
    });

    return NextResponse.json({ text: result.text ?? "" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Transcription failed";
    console.error("[transcribe]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
