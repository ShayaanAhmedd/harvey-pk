// POST /api/tts
//
// Body: { text: string; voice?: string }
//
// Streams an MP3 audio response using OpenAI TTS.
// Caller should play it via the Web Audio API or an <audio> element.
//
// Voices: alloy | echo | fable | onyx | nova | shimmer (default: onyx)
// Max input: 4096 characters

import OpenAI from "openai";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const VALID_VOICES = new Set(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]);
const MAX_CHARS = 4096;

export async function POST(req: Request) {
  // Auth check
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { text?: string; voice?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const text = (body.text ?? "").trim();
  if (!text) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }
  if (text.length > MAX_CHARS) {
    return NextResponse.json({ error: `Text exceeds ${MAX_CHARS} character limit` }, { status: 400 });
  }

  const voice = VALID_VOICES.has(body.voice ?? "") ? (body.voice as "onyx") : "onyx";

  try {
    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      voice,
      input: text,
      response_format: "mp3",
    });

    const audioBuffer = await mp3.arrayBuffer();

    return new Response(audioBuffer, {
      headers: {
        "Content-Type":   "audio/mpeg",
        "Content-Length": String(audioBuffer.byteLength),
        "Cache-Control":  "no-store",
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "TTS failed";
    console.error("[tts] OpenAI error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
