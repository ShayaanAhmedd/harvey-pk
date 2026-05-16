// lib/ai/brief-generator.ts
//
// Litigation Brief Generator — pure deterministic aggregation.
// Combines all IRAC intelligence layers into a structured brief
// that lawyers can directly use.
//
// Safety constraints:
//   - No DB queries
//   - No LLM calls
//   - No randomness — identical inputs always produce identical output
//   - Advisory output only; never modifies confidence_score or risk_level

import type { IracCitation, IracResponse } from "./irac";

// ── Public types ──────────────────────────────────────────────────────────────

export interface LitigationBrief {
  executive_summary:       string;
  key_issues:              string[];
  governing_law:           string[];
  leading_precedents:      string[];
  risk_assessment: {
    success_probability: number;
    risk_level:          string;
  };
  strategy_recommendation: string;
  similar_cases: {
    case_title: string;
    similarity: number;
  }[];
}

export interface BriefParams {
  // Required core IRAC fields
  issue:       string;
  conclusion:  string;
  citations:   IracCitation[];
  risk_level:  "low" | "moderate" | "high";
  // Optional intelligence layers — all gracefully absent
  litigation_assessment?:  IracResponse["litigation_assessment"];
  doctrine_analysis?:      IracResponse["doctrine_analysis"];
  doctrine_influence?:     IracResponse["doctrine_influence"];
  benchmark_assessment?:   IracResponse["benchmark_assessment"];
  forum_intelligence?:     IracResponse["forum_intelligence"];
  strategy_simulation?:    IracResponse["strategy_simulation"];
  precedent_intelligence?: IracResponse["precedent_intelligence"];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Splits the IRAC issue field into discrete question sentences.
 * Handles full stops, semicolons, and "whether" sub-clauses.
 */
function extractKeyIssues(issue: string): string[] {
  const raw = issue
    .split(/(?<=[.;?])\s+|(?=\bwhether\b)/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);

  return raw.length > 0 ? raw : [issue.trim()];
}

/**
 * Builds deduplicated "Act Name, Section X" strings from citations.
 */
function buildGoverningLaw(citations: IracCitation[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const c of citations) {
    const key = `${c.act_name.trim()}, Section ${c.section_number.trim()}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(key);
    }
  }
  return result;
}

/**
 * Selects the best strategy description from strategy_simulation.
 * Returns a fallback string when simulation is absent.
 */
function pickBestStrategy(
  simulation: IracResponse["strategy_simulation"],
  risk_level: "low" | "moderate" | "high",
): string {
  if (!simulation || simulation.strategies.length === 0) {
    const fallbacks: Record<"low" | "moderate" | "high", string> = {
      low:      "Proceed with filing — legal position is strong.",
      moderate: "Strengthen factual basis before proceeding.",
      high:     "Consider settlement or seek higher appellate authority before filing.",
    };
    return fallbacks[risk_level];
  }

  // Highest adjusted_success_probability wins; tie-break by original order
  const best = [...simulation.strategies].sort(
    (a, b) => b.adjusted_success_probability - a.adjusted_success_probability,
  )[0];

  return best.description;
}

/**
 * Builds the executive summary from conclusion + probability + doctrine stability.
 * Format (single paragraph, ≤ 3 sentences):
 *   [Conclusion]. [Probability context]. [Doctrine stability note if applicable].
 */
function buildExecutiveSummary(params: {
  conclusion:          string;
  litigation_assessment?: IracResponse["litigation_assessment"];
  doctrine_analysis?:    IracResponse["doctrine_analysis"];
  benchmark_assessment?: IracResponse["benchmark_assessment"];
}): string {
  const { conclusion, litigation_assessment, doctrine_analysis, benchmark_assessment } = params;

  const sentences: string[] = [];

  // Sentence 1: Conclusion (trimmed, ensure it ends with a full stop)
  const conclusionText = conclusion.trim().replace(/[.!?]$/, "");
  sentences.push(`${conclusionText}.`);

  // Sentence 2: Probability context
  if (litigation_assessment) {
    const pct      = Math.round(litigation_assessment.success_probability * 100);
    const bandMap: Record<string, string> = {
      very_low:  "very low litigation exposure",
      low:       "low litigation exposure",
      moderate:  "moderate litigation exposure",
      high:      "high litigation exposure",
      very_high: "very high litigation exposure",
    };
    const band    = bandMap[litigation_assessment.risk_band] ?? litigation_assessment.risk_band;
    const history = benchmark_assessment
      ? ` Historical comparable cases show a ${Math.round(benchmark_assessment.historical_success_rate * 100)}% success rate.`
      : "";
    sentences.push(`Estimated litigation success probability is ${pct}% (${band}).${history}`);
  }

  // Sentence 3: Doctrine stability note (only when meaningful)
  if (doctrine_analysis) {
    const stabilityNote: Record<string, string> = {
      stable:    "The governing doctrine is stable with strong precedential support.",
      weakening: "Caution: the governing doctrine shows signs of weakening — recent negative treatment detected.",
      unstable:  "Warning: the governing doctrine is currently unstable with significant overruling risk.",
    };
    const note = stabilityNote[doctrine_analysis.doctrine_stability];
    if (note) sentences.push(note);
  }

  return sentences.join(" ");
}

// ── Main export ───────────────────────────────────────────────────────────────

export function generateLitigationBrief(params: BriefParams): LitigationBrief {
  const {
    issue,
    conclusion,
    citations,
    risk_level,
    litigation_assessment,
    doctrine_analysis,
    doctrine_influence,
    benchmark_assessment,
    strategy_simulation,
    precedent_intelligence,
  } = params;

  // 1. Executive summary
  const executive_summary = buildExecutiveSummary({
    conclusion,
    litigation_assessment,
    doctrine_analysis,
    benchmark_assessment,
  });

  // 2. Key issues — sentence-level extraction from issue field
  const key_issues = extractKeyIssues(issue);

  // 3. Governing law — unique act + section strings from verified citations
  const governing_law = buildGoverningLaw(citations);

  // 4. Leading precedents — from doctrine_influence; fall back to similar_cases titles
  let leading_precedents: string[];
  if (doctrine_influence && doctrine_influence.leading_precedents.length > 0) {
    leading_precedents = doctrine_influence.leading_precedents.map(
      (p) => p.case_title,
    );
  } else if (precedent_intelligence && precedent_intelligence.similar_cases.length > 0) {
    leading_precedents = precedent_intelligence.similar_cases
      .map((c) => c.case_title)
      .filter((t): t is string => t !== null && t.length > 0);
  } else {
    leading_precedents = [];
  }

  // 5. Risk assessment — from litigation_assessment; fall back to pipeline risk_level
  const risk_assessment = {
    success_probability: litigation_assessment?.success_probability ?? 0,
    risk_level:          litigation_assessment?.risk_band ?? risk_level,
  };

  // 6. Strategy recommendation — highest-probability strategy description
  const strategy_recommendation = pickBestStrategy(strategy_simulation, risk_level);

  // 7. Similar cases — from precedent_intelligence, null titles filtered out
  const similar_cases: LitigationBrief["similar_cases"] =
    (precedent_intelligence?.similar_cases ?? [])
      .filter((c) => c.case_title !== null && c.case_title.length > 0)
      .map((c) => ({
        case_title: c.case_title as string,
        similarity: Math.round(c.similarity * 1000) / 1000,
      }));

  return {
    executive_summary,
    key_issues,
    governing_law,
    leading_precedents,
    risk_assessment,
    strategy_recommendation,
    similar_cases,
  };
}
