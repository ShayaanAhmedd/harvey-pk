// lib/claude.ts
//
// Server-side Anthropic client — never imported from client components.
// Uses ANTHROPIC_API_KEY (no NEXT_PUBLIC prefix — server only).

import Anthropic from "@anthropic-ai/sdk";

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env.local.");
}

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});
