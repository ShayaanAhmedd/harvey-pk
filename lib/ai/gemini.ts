// lib/ai/gemini.ts
//
// Cross-Check Mode provider — Google Gemini (AI Studio REST API).
// Called when uiMode === "crosscheck".
//
// Model: controlled by GEMINI_MODEL env var.
//   Default: gemini-2.5-flash  (gemini-2.0-flash deprecated 2026-03)
//   Note: gemini-1.5-pro was deprecated Sept 2025 — do not use it.
//
// Uses the AI Studio endpoint (generativelanguage.googleapis.com), NOT Vertex AI.
// Vertex uses a completely different auth scheme (service account / ADC).
//
// Throws a controlled error on failure so the route falls back to Claude.

import { createProviderError } from "./types";

function geminiModel(): string {
  return process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
}

function geminiApiUrl(): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel()}:generateContent`;
}

const GEMINI_SYSTEM = `You are a senior legal cross-check analyst specialising in Pakistani law.

Your role is to independently validate legal analysis, identify errors or omissions, and provide a corroborating or dissenting opinion supported by citations.

Requirements:
1. Cross-reference the provided statutory context against your own knowledge of Pakistani law.
2. Flag any inaccuracies, outdated provisions, or missing citations.
3. Provide your independent legal analysis in the four-section structure: ISSUE, RELEVANT LAW, LEGAL ANALYSIS, PRACTICAL IMPLICATIONS.
4. Maintain a formal, authoritative tone throughout.
5. No emojis. No conversational language. No mention of system mechanics or data sources.
6. Do not hallucinate statutes or section numbers.`;

export async function callGemini(
  question:    string,
  contextText: string
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Gemini API key missing. Set GEMINI_API_KEY in environment variables.");

  const userMessage = contextText
    ? `Question:\n${question}\n\nStatutory Context:\n${contextText}`
    : `Question:\n${question}`;

  const body = {
    system_instruction: { parts: [{ text: GEMINI_SYSTEM }] },
    contents:           [{ role: "user", parts: [{ text: userMessage }] }],
    generationConfig:   { temperature: 0.2, maxOutputTokens: 4000 },
  };

  const res = await fetch(`${geminiApiUrl()}?key=${apiKey}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    // Gemini returns structured JSON errors even on failure
    interface GeminiErrBody { error?: { code?: number; message?: string; status?: string } }
    const errBody = await res.json().catch(() => ({})) as GeminiErrBody;
    const msg     = errBody?.error?.message ?? res.statusText;
    const err     = createProviderError("gemini", res.status, msg);
    console.error("[gemini] call failed:", JSON.stringify(err));
    throw new Error(`Gemini ${res.status}: ${msg}`);
  }

  interface GeminiPart      { text?: string }
  interface GeminiContent   { parts?: GeminiPart[] }
  interface GeminiCandidate { content?: GeminiContent; finishReason?: string }
  interface GeminiResponse  { candidates?: GeminiCandidate[] }

  const json = (await res.json()) as GeminiResponse;
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  if (!text) {
    const reason = json?.candidates?.[0]?.finishReason ?? "unknown";
    throw new Error(`Gemini returned no text content (finishReason: ${reason}).`);
  }

  return text;
}

// ── Model listing (used by healthcheck diagnostics) ───────────────────────────

export async function listGeminiModels(): Promise<string[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=50`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return [];
    interface GeminiModel     { name?: string }
    interface GeminiModelList { models?: GeminiModel[] }
    const json = await res.json() as GeminiModelList;
    return (json?.models ?? []).map((m) => m.name ?? "").filter(Boolean);
  } catch {
    return [];
  }
}
