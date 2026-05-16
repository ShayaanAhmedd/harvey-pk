// Public embedding API. Now uses local self-hosted model.
// The OpenAI version is kept commented out for emergency fallback.

import { embedTextLocal } from "./local-embeddings";

export async function embedText(text: string): Promise<number[]> {
  return embedTextLocal(text);
}

// Legacy OpenAI version (commented out, kept for reference):
// import OpenAI from "openai";
// const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// export async function embedText(text: string) {
//   const response = await openai.embeddings.create({
//     model: "text-embedding-3-small",
//     input: text,
//   });
//   return response.data[0].embedding;
// }
