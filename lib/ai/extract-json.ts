// lib/ai/extract-json.ts
//
// Shared JSON extraction utility for the AI pipeline.
//
// LLM providers frequently prefix or suffix JSON with prose explanations or
// wrap it in markdown fences. This utility strips both before parsing so that
// `JSON.parse(extractJson(raw))` is resilient to all three common formats:
//
//   1. Pure JSON                         — returned as-is
//   2. Fenced JSON (```json … ```)       — inner block extracted
//   3. JSON embedded in prose            — first { … last } slice extracted
//
// Throws Error("parse_failure") when no JSON object markers are found at all,
// so callers can distinguish "bad JSON structure" from "SyntaxError in valid-
// looking JSON". Callers should wrap usage in try/catch.

export function extractJson(text: string): string {
  if (!text) throw new Error("parse_failure");

  const trimmed = text.trim();

  // 1. Markdown fence: ```json … ```, ```JSON … ```, ``` … ```, etc.
  const fenced = trimmed.match(/```\w*\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();

  // 2. First { … last } slice (handles prose before/after)
  const start = trimmed.indexOf("{");
  const end   = trimmed.lastIndexOf("}");

  if (start === -1 || end === -1 || end < start) {
    throw new Error("parse_failure");
  }

  return trimmed.slice(start, end + 1).trim();
}
