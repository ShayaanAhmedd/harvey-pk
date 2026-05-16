// lib/ai/precedent-graph.ts
//
// Precedent Network Graph + Case Similarity Engine.
//
// Exported functions:
//   findSimilarCases()        — vector ANN search over precedent_nodes
//   analyzePrecedentStrength() — edge-based strength + instability scoring
//
// Safety constraints (Task 6):
//   - No DB queries inside loops
//   - Max 2 queries per call to analyzePrecedentStrength
//   - Graceful null/empty return when tables are empty or query fails
//   - Deterministic logic only — no LLM calls

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Authority weights ─────────────────────────────────────────────────────────

const AUTHORITY_WEIGHT: Record<string, number> = {
  supreme:     1.0,
  high:        0.8,
  lower:       0.6,
  legislation: 0.5,
};

function authorityWeight(tier: string | null | undefined): number {
  return AUTHORITY_WEIGHT[tier ?? ""] ?? 0.5;
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface SimilarCase {
  case_id:        string;
  case_title:     string | null;
  authority_tier: string | null;
  decision_year:  number | null;
  similarity:     number;
}

export interface PrecedentStrengthResult {
  precedent_strength_score: number;   // sum(authority_weight of citing cases)
  incoming_citations:       number;   // count of edges pointing INTO caseIds
  doctrine_instability:     boolean;  // true if any edge from caseIds has type "overrules"
}

// ── Internal row types ────────────────────────────────────────────────────────

type EdgeRow = {
  from_case_id:  string;
  to_case_id:    string;
  relation_type: string;
  weight:        number;
};

type NodeRow = {
  case_id:        string;
  authority_tier: string | null;
};

// ── findSimilarCases ──────────────────────────────────────────────────────────
//
// Calls the match_precedent_nodes RPC (IVFFlat ANN, cosine distance).
// Returns empty array on any failure.

export async function findSimilarCases(
  embedding: number[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase:  SupabaseClient<any>,
  limit = 5,
): Promise<SimilarCase[]> {
  try {
    const { data, error } = await supabase.rpc("match_precedent_nodes", {
      query_embedding: embedding,
      match_count:     limit,
    });

    if (error || !data) return [];

    return (data as SimilarCase[]).map((r) => ({
      case_id:        r.case_id,
      case_title:     r.case_title ?? null,
      authority_tier: r.authority_tier ?? null,
      decision_year:  r.decision_year ?? null,
      similarity:     Math.round((r.similarity as unknown as number) * 1000) / 1000,
    }));
  } catch {
    return [];
  }
}

// ── analyzePrecedentStrength ──────────────────────────────────────────────────
//
// 2 queries total:
//   Q1 — all edges where from_case_id OR to_case_id is in caseIds
//   Q2 — authority_tier for every unique case ID referenced in those edges
//        (needed to weight incoming citations)
//
// precedent_strength_score = Σ authority_weight(citing_case) × edge.weight
//   for each edge where to_case_id ∈ caseIds  (incoming citations)
//
// doctrine_instability = true if any edge where
//   from_case_id ∈ caseIds AND relation_type = "overrules"

export async function analyzePrecedentStrength(
  caseIds:  string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
): Promise<PrecedentStrengthResult> {
  const empty: PrecedentStrengthResult = {
    precedent_strength_score: 0,
    incoming_citations:       0,
    doctrine_instability:     false,
  };

  if (caseIds.length === 0) return empty;

  try {
    // ── Q1: fetch all edges touching our case IDs ──────────────────────────
    const { data: edgeData, error: edgeErr } = await supabase
      .from("precedent_edges")
      .select("from_case_id, to_case_id, relation_type, weight")
      .or(`from_case_id.in.(${caseIds.join(",")}),to_case_id.in.(${caseIds.join(",")})`);

    if (edgeErr || !edgeData || edgeData.length === 0) return empty;

    const edges = edgeData as EdgeRow[];
    const caseIdSet = new Set(caseIds);

    // Doctrine instability: any outgoing edge from our cases with type "overrules"
    const doctrine_instability = edges.some(
      (e) => caseIdSet.has(e.from_case_id) && e.relation_type === "overrules"
    );

    // Incoming edges: edges pointing TO our cases from external cases
    const incomingEdges = edges.filter(
      (e) => caseIdSet.has(e.to_case_id) && !caseIdSet.has(e.from_case_id)
    );
    const incoming_citations = incomingEdges.length;

    if (incoming_citations === 0) {
      return { precedent_strength_score: 0, incoming_citations: 0, doctrine_instability };
    }

    // ── Q2: authority tiers for all citing cases (from_case_id in incoming) ─
    const citingIds = [...new Set(incomingEdges.map((e) => e.from_case_id))];

    const { data: nodeData, error: nodeErr } = await supabase
      .from("precedent_nodes")
      .select("case_id, authority_tier")
      .in("case_id", citingIds);

    // Build lookup map; fall back to weight 0.5 if node not found
    const tierMap = new Map<string, string | null>();
    if (!nodeErr && nodeData) {
      for (const n of nodeData as NodeRow[]) {
        tierMap.set(n.case_id, n.authority_tier);
      }
    }

    // precedent_strength_score = Σ authority_weight(citing) × edge.weight
    let precedent_strength_score = 0;
    for (const e of incomingEdges) {
      const tier = tierMap.get(e.from_case_id) ?? null;
      precedent_strength_score += authorityWeight(tier) * (e.weight ?? 1.0);
    }

    return {
      precedent_strength_score: Math.round(precedent_strength_score * 1000) / 1000,
      incoming_citations,
      doctrine_instability,
    };
  } catch {
    return empty;
  }
}
