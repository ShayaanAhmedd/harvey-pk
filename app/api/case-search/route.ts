// app/api/case-search/route.ts
//
// POST /api/case-search
//
// Semantic case-analog search: embeds the caller's query and finds
// precedent_nodes with the highest cosine similarity, then enriches
// each result with the `outcome` field from legal_cases.
//
// Request body:
//   { "query": "text describing a legal situation" }
//
// Response (200):
//   { "results": CaseSearchResult[] }
//
// Each result includes only cases with similarity ≥ 0.5 (below that
// the embedding match is too weak to be legally meaningful).
//
// Auth: authenticated users only (RLS on precedent_nodes + legal_cases
// allows SELECT for authenticated role; no admin requirement).

export const runtime = "nodejs";

import { NextResponse }  from "next/server";
import { createClient }  from "@/lib/supabase/server";
import { embedText }     from "@/lib/embeddings";

// ── Types ─────────────────────────────────────────────────────────────────────

interface CaseSearchResult {
  case_title:     string | null;
  authority_tier: string | null;
  decision_year:  number | null;
  similarity:     number;
  outcome:        string | null;
}

// Rows returned by the match_precedent_nodes RPC
interface PrecedentRow {
  case_id:        string;
  case_title:     string | null;
  authority_tier: string | null;
  decision_year:  number | null;
  similarity:     number;
}

// Outcome lookup from legal_cases
interface OutcomeRow {
  id:      string;
  outcome: string | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SIMILARITY_THRESHOLD = 0.5;
const MATCH_COUNT          = 10;   // fetch 10 from DB; filter below threshold client-side

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  // ── 1. Auth ───────────────────────────────────────────────────────────────
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── 2. Parse + validate body ──────────────────────────────────────────────
  let query: string;
  try {
    const body = await req.json() as Record<string, unknown>;
    if (typeof body.query !== "string" || body.query.trim().length === 0) {
      return NextResponse.json(
        { error: "query must be a non-empty string" },
        { status: 400 }
      );
    }
    query = body.query.trim();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── 3. Embed the query ────────────────────────────────────────────────────
  let embedding: number[];
  try {
    embedding = await embedText(query);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Embedding service error";
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // ── 4. Vector similarity search via RPC ───────────────────────────────────
  const { data: rpcRows, error: rpcError } = await supabase.rpc(
    "match_precedent_nodes",
    { query_embedding: embedding, match_count: MATCH_COUNT }
  );

  if (rpcError) {
    return NextResponse.json({ error: rpcError.message }, { status: 500 });
  }

  const rows = (rpcRows ?? []) as PrecedentRow[];

  if (rows.length === 0) {
    return NextResponse.json({ results: [] });
  }

  // ── 5. Filter by similarity threshold ────────────────────────────────────
  const passing = rows.filter((r) => r.similarity >= SIMILARITY_THRESHOLD);

  if (passing.length === 0) {
    return NextResponse.json({ results: [] });
  }

  // ── 6. Fetch outcome from legal_cases (single IN query) ───────────────────
  const caseIds = passing.map((r) => r.case_id);

  const { data: outcomeRows, error: outcomeError } = await supabase
    .from("legal_cases")
    .select("id, outcome")
    .in("id", caseIds);

  if (outcomeError) {
    // Non-fatal: return results without outcome rather than failing
    console.error("[case-search] outcome lookup failed:", outcomeError.message);
  }

  const outcomeMap = new Map<string, string | null>();
  for (const row of ((outcomeRows ?? []) as OutcomeRow[])) {
    outcomeMap.set(row.id, row.outcome ?? null);
  }

  // ── 7. Build + return response ────────────────────────────────────────────
  const results: CaseSearchResult[] = passing.map((r) => ({
    case_title:     r.case_title     ?? null,
    authority_tier: r.authority_tier ?? null,
    decision_year:  r.decision_year  ?? null,
    similarity:     Math.round(r.similarity * 1000) / 1000,
    outcome:        outcomeMap.get(r.case_id) ?? null,
  }));

  return NextResponse.json({ results });
}
