// lib/ai/doctrine-engine.ts
//
// Doctrine Stability & Overruling Cascade Engine.
// Determines whether a doctrine represented by a set of precedent cases is
// stable, weakening, or collapsing using existing precedent_edges/nodes tables.
//
// Safety (Task 7):
//   - Max 2 DB queries (edges + treating-node years)
//   - Deterministic logic only — no LLM calls
//   - Graceful empty return when graph tables are absent or empty
//   - No loops that issue queries

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Public types ──────────────────────────────────────────────────────────────

export type DoctrineStability = "stable" | "weakening" | "unstable";
export type DoctrineTrend     = "strengthening" | "neutral" | "weakening";

export interface DoctrineAnalysisResult {
  doctrine_stability:          DoctrineStability;
  overruling_risk_score:        number;
  negative_treatment_count:     number;
  supporting_precedent_count:   number;
  doctrine_trend:               DoctrineTrend;
}

// ── Internal row types ────────────────────────────────────────────────────────

type EdgeRow = {
  from_case_id:  string;
  to_case_id:    string;
  relation_type: string;
};

type NodeYearRow = {
  case_id:       string;
  decision_year: number | null;
};

const NEGATIVE_TYPES = new Set(["distinguishes", "overrules"]);
const POSITIVE_TYPE  = "follows";

// ── Helpers ───────────────────────────────────────────────────────────────────

function stabilityFromScore(score: number): DoctrineStability {
  if (score < 0.25) return "stable";
  if (score <= 0.5) return "weakening";
  return "unstable";
}

// ── Main analyzer ─────────────────────────────────────────────────────────────

export async function analyzeDoctrine(
  caseIds:  string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
): Promise<DoctrineAnalysisResult | null> {
  if (caseIds.length === 0) return null;

  try {
    // ── Q1: all edges touching the doctrine case IDs ───────────────────────
    const { data: edgeData, error: edgeErr } = await supabase
      .from("precedent_edges")
      .select("from_case_id, to_case_id, relation_type")
      .or(`from_case_id.in.(${caseIds.join(",")}),to_case_id.in.(${caseIds.join(",")})`);

    if (edgeErr || !edgeData || edgeData.length === 0) return null;

    const edges      = edgeData as EdgeRow[];
    const caseIdSet  = new Set(caseIds);

    // Incoming negative treatment: external cases distinguishing/overruling ours
    const negEdges = edges.filter(
      (e) => NEGATIVE_TYPES.has(e.relation_type) && !caseIdSet.has(e.from_case_id)
    );
    // Incoming positive support: external cases following ours
    const posEdges = edges.filter(
      (e) => e.relation_type === POSITIVE_TYPE && !caseIdSet.has(e.from_case_id)
    );

    const negative_treatment_count   = negEdges.length;
    const supporting_precedent_count  = posEdges.length;
    const totalTreatment              = negative_treatment_count + supporting_precedent_count;

    const overruling_risk_score =
      totalTreatment > 0
        ? Math.round((negative_treatment_count / totalTreatment) * 1000) / 1000
        : 0;

    const doctrine_stability = stabilityFromScore(overruling_risk_score);

    // ── Q2: decision_year for treating cases (trend analysis) ─────────────
    // Only needed when there is treatment to analyse.
    let doctrine_trend: DoctrineTrend = "neutral";

    const treatingIds = [
      ...new Set([...negEdges, ...posEdges].map((e) => e.from_case_id)),
    ];

    if (treatingIds.length > 0) {
      const { data: nodeData } = await supabase
        .from("precedent_nodes")
        .select("case_id, decision_year")
        .in("case_id", treatingIds);

      if (nodeData && nodeData.length > 0) {
        const yearMap = new Map<string, number | null>();
        for (const n of nodeData as NodeYearRow[]) {
          yearMap.set(n.case_id, n.decision_year);
        }

        const currentYear = new Date().getFullYear();
        const cutoff      = currentYear - 5;

        // Partition negative treatments by recency
        const recentNeg = negEdges.filter((e) => {
          const y = yearMap.get(e.from_case_id);
          return y != null && y >= cutoff;
        }).length;
        const olderNeg = negEdges.filter((e) => {
          const y = yearMap.get(e.from_case_id);
          return y != null && y < cutoff;
        }).length;

        // Recent positive treatments
        const recentPos = posEdges.filter((e) => {
          const y = yearMap.get(e.from_case_id);
          return y != null && y >= cutoff;
        }).length;

        if (recentNeg > olderNeg) {
          doctrine_trend = "weakening";
        } else if (recentPos > recentNeg) {
          doctrine_trend = "strengthening";
        }
        // else remains "neutral"
      }
    }

    return {
      doctrine_stability,
      overruling_risk_score,
      negative_treatment_count,
      supporting_precedent_count,
      doctrine_trend,
    };
  } catch {
    return null; // graceful fallback
  }
}
