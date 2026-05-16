// lib/ai/doctrine-influence.ts
//
// Doctrine Influence Engine — identifies influential precedents and cluster metrics
// for a set of related cases using the precedent graph.
//
// Safety (Task 5):
//   - Max 2 DB queries (edges + node metadata)
//   - Deterministic calculations only — no LLM calls
//   - Graceful null return when graph empty or query fails
//   - No queries inside loops

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface LeadingPrecedent {
  case_title:      string;
  authority_tier:  string;
  influence_score: number;
}

export interface DoctrineInfluenceResult {
  leading_precedents:          LeadingPrecedent[];
  doctrine_cluster_size:       number;
  precedent_network_density:   number;
}

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

// ── Internal row types ────────────────────────────────────────────────────────

type EdgeRow = {
  from_case_id: string;
  to_case_id:   string;
  weight:       number;
};

type NodeRow = {
  case_id:        string;
  case_title:     string | null;
  authority_tier: string | null;
};

// ── analyzeDoctrineInfluence ──────────────────────────────────────────────────
//
// Q1 — precedent_edges:  all edges touching the input caseIds
// Q2 — precedent_nodes:  metadata for every unique node ID found in Q1
//
// From these two queries all metrics are computed in-memory:
//   influence_score        = Σ authority_weight(citing_case) × edge.weight
//                            for each incoming edge to a case in caseIds
//   doctrine_cluster_size  = count of unique node IDs across all Q1 edges
//                            (represents the 1-hop reachable neighbourhood,
//                             a conservative lower-bound for the 2-hop cluster)
//   precedent_network_density = |edges| / (|nodes| × (|nodes| − 1)), clamped [0,1]

export async function analyzeDoctrineInfluence(
  caseIds:  string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
): Promise<DoctrineInfluenceResult | null> {
  if (caseIds.length === 0) return null;

  try {
    // ── Q1: all edges touching the input cases ────────────────────────────
    const { data: edgeData, error: edgeErr } = await supabase
      .from("precedent_edges")
      .select("from_case_id, to_case_id, weight")
      .or(`from_case_id.in.(${caseIds.join(",")}),to_case_id.in.(${caseIds.join(",")})`);

    if (edgeErr || !edgeData || edgeData.length === 0) return null;

    const edges      = edgeData as EdgeRow[];
    const caseIdSet  = new Set(caseIds);

    // Collect every unique node ID referenced in the edge set
    const allNodeIds = new Set<string>();
    for (const e of edges) {
      allNodeIds.add(e.from_case_id);
      allNodeIds.add(e.to_case_id);
    }

    // ── Q2: metadata for all nodes ────────────────────────────────────────
    const { data: nodeData } = await supabase
      .from("precedent_nodes")
      .select("case_id, case_title, authority_tier")
      .in("case_id", [...allNodeIds]);

    const nodeMap = new Map<string, NodeRow>();
    for (const n of ((nodeData ?? []) as NodeRow[])) {
      nodeMap.set(n.case_id, n);
    }

    // ── Influence score per input case ────────────────────────────────────
    // Incoming edges: edges where to_case_id ∈ caseIds (external cases citing ours)
    const influenceMap = new Map<string, number>();
    for (const id of caseIds) influenceMap.set(id, 0);

    for (const e of edges) {
      if (caseIdSet.has(e.to_case_id) && !caseIdSet.has(e.from_case_id)) {
        const tier   = nodeMap.get(e.from_case_id)?.authority_tier ?? null;
        const score  = authorityWeight(tier) * (e.weight ?? 1.0);
        influenceMap.set(e.to_case_id, (influenceMap.get(e.to_case_id) ?? 0) + score);
      }
    }

    // Build ranked leading_precedents (top 5 by influence_score)
    const leading_precedents: LeadingPrecedent[] = [...influenceMap.entries()]
      .map(([id, score]) => {
        const node = nodeMap.get(id);
        return {
          case_title:      node?.case_title ?? id.slice(0, 8),
          authority_tier:  node?.authority_tier ?? "lower",
          influence_score: Math.round(score * 1000) / 1000,
        };
      })
      .sort((a, b) => b.influence_score - a.influence_score)
      .slice(0, 5);

    // ── Cluster metrics ───────────────────────────────────────────────────
    const doctrine_cluster_size     = allNodeIds.size;
    const edgeCount                  = edges.length;
    const n                          = doctrine_cluster_size;
    const maxEdges                   = n > 1 ? n * (n - 1) : 1;
    const precedent_network_density  =
      Math.min(1, Math.max(0, Math.round((edgeCount / maxEdges) * 1000) / 1000));

    return { leading_precedents, doctrine_cluster_size, precedent_network_density };
  } catch {
    return null;
  }
}
