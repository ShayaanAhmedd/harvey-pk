// lib/ai/manus.ts
//
// Draft Mode provider — Manus API.
// Called when uiMode === "draft".
//
// Model: controlled by MANUS_MODEL env var.
//   Default: "manus-draft-1" — verify the correct model ID with Manus support
//   if the healthcheck returns model_not_found.
//
// Manus specialises in agentic document drafting. If the key is absent or the
// API call fails, the route falls back to Claude deep mode so the user always
// receives a drafted response.
//
// The response envelope follows the OpenAI-compatible shape that Manus exposes.
// If Manus changes its schema, only this file needs updating.

import { createProviderError } from "./types";

const MANUS_API_URL = "https://api.manus.im/v1/chat/completions";

function manusModel(): string {
  return process.env.MANUS_MODEL ?? "manus-draft-1";
}

const MANUS_SYSTEM = `You are a senior legal drafting expert specialising in Pakistani law.

Your role is to produce professional legal documents, arguments, pleadings, and formal correspondence.

Requirements:
1. Draft with precision and formal legal language appropriate to Pakistani courts.
2. Structure documents according to Pakistani legal practice and court conventions.
3. Include all applicable statutory citations, section numbers, and act years.
4. Cover: heading, parties (if applicable), facts, legal grounds, prayer/relief.
5. Maintain a professional, courtroom-ready tone throughout.
6. No emojis. No conversational language. No mention of system mechanics.
7. Do not fabricate section numbers or case citations.`;

export async function callManus(
  question:    string,
  contextText: string
): Promise<string> {
  const apiKey = process.env.MANUS_API_KEY;
  if (!apiKey) throw new Error("MANUS_API_KEY is not configured.");

  const model = manusModel();

  const userMessage = contextText
    ? `Drafting Request:\n${question}\n\nStatutory Context:\n${contextText}`
    : `Drafting Request:\n${question}`;

  const body = {
    model,
    messages: [
      { role: "system", content: MANUS_SYSTEM },
      { role: "user",   content: userMessage  },
    ],
    max_tokens:  4000,
    temperature: 0.3,
  };

  const res = await fetch(MANUS_API_URL, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${apiKey}`,
    },
    body:   JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    const err     = createProviderError("manus", res.status, errText);
    console.error("[manus] call failed:", JSON.stringify(err));
    throw new Error(`Manus API error ${res.status}: ${errText}`);
  }

  interface ManusMessage  { content?: string }
  interface ManusChoice   { message?: ManusMessage }
  interface ManusResponse { choices?: ManusChoice[]; content?: string; text?: string }

  const json = (await res.json()) as ManusResponse;

  // Accept OpenAI-compatible shape or a direct text/content field
  const text =
    json?.choices?.[0]?.message?.content ??
    json?.content                         ??
    json?.text                            ??
    "";

  if (!text) throw new Error("Manus returned no text content.");

  return text;
}
