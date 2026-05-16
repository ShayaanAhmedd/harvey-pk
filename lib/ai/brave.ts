// lib/ai/brave.ts
//
// Web Mode provider — Brave Search API.
// Called when uiMode === "web".
//
// Returns formatted search results as a plain string.
// The route synthesises a final answer by passing these results to
// OpenAI gpt-4o as additional context alongside the RAG corpus.
//
// Throws a controlled error on missing key or API failure so the
// route can fall back to the existing RAG-only pipeline.

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

export interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

export async function callBraveSearch(query: string): Promise<string> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) throw new Error("BRAVE_API_KEY is not configured.");

  const params = new URLSearchParams({
    q:                 query,
    count:             "5",
    text_decorations:  "false",
    search_lang:       "en",
    country:           "PK",
  });

  const res = await fetch(`${BRAVE_SEARCH_URL}?${params}`, {
    headers: {
      Accept:                   "application/json",
      "Accept-Encoding":        "gzip",
      "X-Subscription-Token":   apiKey,
    },
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Brave Search API error ${res.status}: ${errText}`);
  }

  interface BraveWebResult { title?: string; url?: string; description?: string }
  interface BraveResponse  { web?: { results?: BraveWebResult[] } }

  const json = (await res.json()) as BraveResponse;
  const raw  = json?.web?.results ?? [];

  const results: BraveSearchResult[] = raw.slice(0, 5).map((r) => ({
    title:       String(r.title       ?? "").trim(),
    url:         String(r.url         ?? "").trim(),
    description: String(r.description ?? "").trim(),
  }));

  if (results.length === 0) throw new Error("Brave Search returned no results.");

  return results
    .map((r, i) => `[${i + 1}] ${r.title}\nSource: ${r.url}\n${r.description}`)
    .join("\n\n");
}
