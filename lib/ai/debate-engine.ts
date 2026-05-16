// lib/ai/debate-engine.ts
//
// Legal Debate Engine — pure deterministic adversarial reasoning layer.
// No LLM calls, no DB access, no side effects. O(n) complexity.
//
// Synthesises two opposing legal arguments from a single ArgumentStructure,
// then applies a weighted scoring model to produce a deterministic
// arbitration result.
//
// Input:
//   argument_structure       — from lib/ai/argument-builder.ts
//   doctrine_analysis        — optional; from IracResponse
//   precedent_intelligence   — optional; from IracResponse
//
// Output:
//   plaintiff_argument       — strongest available case for the position
//   opposing_argument        — best available case against it
//   arbitration_result       — evaluative summary of both sides
//   winning_side             — "plaintiff" | "defendant" | "inconclusive"
//   reasoning                — deterministic explanation of the decision
//
// Constraints:
//   - Never modifies confidence_score, risk_level, or any probability field
//   - Purely additive / read-only over all inputs
//   - Gracefully handles all absent optional fields

import type { ArgumentStructure } from "./argument-builder";
import type { IracResponse } from "./irac";

// ── Public types ──────────────────────────────────────────────────────────────

export interface DebateResult {
  plaintiff_argument: string;
  opposing_argument:  string;
  arbitration_result: string;
  winning_side:       "plaintiff" | "defendant" | "inconclusive";
  reasoning:          string;
}

export interface DebateEngineInput {
  argument_structure:      ArgumentStructure;
  doctrine_analysis?:      IracResponse["doctrine_analysis"];
  precedent_intelligence?: IracResponse["precedent_intelligence"];
}

// ── Internal scoring model ────────────────────────────────────────────────────
//
// Each factor is an additive delta to plaintiff_score or defendant_score.
// No factor exceeds ±3 to prevent any single signal from dominating.
//
// Plaintiff factors:
//   Leading precedent pool          +influence_score each (capped at 3 precedents)
//   Analogous precedent pool        +influence_score × 0.5 each (capped at 3)
//   Governing law breadth           +0.4 per unique act (max +2.0)
//   Doctrine stability = stable     +2.0
//   Doctrine trend = strengthening  +1.5
//   Precedent strength score        +score × 3 (from precedent_intelligence)
//   Incoming citations signal       +0.5 if incoming_citations > 5
//
// Defendant factors:
//   Counterargument: strong         +2.0 each (max 3 counted)
//   Counterargument: moderate       +1.0 each (max 3 counted)
//   Counterargument: weak           +0.3 each (max 3 counted)
//   Doctrine stability = unstable   +2.0
//   Doctrine stability = weakening  +1.5
//   Doctrine trend = weakening      +1.0
//   Overruling risk > 0.6           +2.0
//   Overruling risk 0.3–0.6         +1.0
//   Negative treatment count ≥ 3    +1.5
//   Negative treatment count 1–2    +0.5
//   Doctrine instability flag       +1.0
//
// Decision threshold:
//   |plaintiff_score - defendant_score| ≥ 1.0 → clear winner
//   Otherwise → "inconclusive"

interface ScoreBreakdown {
  plaintiff_score: number;
  defendant_score: number;
  factors:         Array<{ label: string; delta: number; side: "plaintiff" | "defendant" }>;
}

function scoreDebate(
  a:          ArgumentStructure,
  docAnalysis?:   IracResponse["doctrine_analysis"],
  precedent?:     IracResponse["precedent_intelligence"],
): ScoreBreakdown {
  const factors: ScoreBreakdown["factors"] = [];
  let plaintiff_score = 0;
  let defendant_score = 0;

  const add = (label: string, delta: number, side: "plaintiff" | "defendant") => {
    factors.push({ label, delta, side });
    if (side === "plaintiff") plaintiff_score += delta;
    else                      defendant_score += delta;
  };

  // ── Plaintiff: precedent weight ──
  const leading   = a.precedent_support.filter((p) => p.role === "leading").slice(0, 3);
  const analogous = a.precedent_support.filter((p) => p.role === "analogous").slice(0, 3);

  for (const p of leading) {
    const delta = Math.min(p.influence_score, 1.5);
    add(`Leading precedent: ${p.case_title}`, delta, "plaintiff");
  }
  for (const p of analogous) {
    const delta = Math.min(p.influence_score * 0.5, 0.75);
    add(`Analogous case: ${p.case_title}`, delta, "plaintiff");
  }

  // ── Plaintiff: governing law breadth ──
  const uniqueActs = new Set(a.governing_law.map((g) => g.act_name.toLowerCase())).size;
  if (uniqueActs > 0) {
    const delta = Math.min(uniqueActs * 0.4, 2.0);
    add(`Statutory basis (${uniqueActs} act${uniqueActs > 1 ? "s" : ""})`, delta, "plaintiff");
  }

  // ── Plaintiff: doctrine stability (stable) ──
  if (docAnalysis?.doctrine_stability === "stable") {
    add("Doctrine stability: stable", 2.0, "plaintiff");
  }
  if (docAnalysis?.doctrine_trend === "strengthening") {
    add("Doctrine trend: strengthening", 1.5, "plaintiff");
  }

  // ── Plaintiff: precedent network strength ──
  if (precedent?.precedent_strength_score != null) {
    const delta = Math.min(precedent.precedent_strength_score * 3, 3.0);
    add(`Precedent network strength: ${Math.round(precedent.precedent_strength_score * 100)}%`, delta, "plaintiff");
  }
  if (precedent?.incoming_citations != null && precedent.incoming_citations > 5) {
    add(`Incoming citations: ${precedent.incoming_citations}`, 0.5, "plaintiff");
  }

  // ── Defendant: counterargument weight ──
  let caCounted = 0;
  for (const ca of a.counterarguments) {
    if (caCounted >= 3) break;
    const delta =
      ca.strength === "strong"   ? 2.0 :
      ca.strength === "moderate" ? 1.0 : 0.3;
    add(`Counterargument (${ca.strength}): ${ca.basis.slice(0, 60)}…`, delta, "defendant");
    caCounted++;
  }

  // ── Defendant: doctrine instability ──
  if (docAnalysis?.doctrine_stability === "unstable") {
    add("Doctrine stability: unstable", 2.0, "defendant");
  } else if (docAnalysis?.doctrine_stability === "weakening") {
    add("Doctrine stability: weakening", 1.5, "defendant");
  }
  if (docAnalysis?.doctrine_trend === "weakening") {
    add("Doctrine trend: weakening", 1.0, "defendant");
  }

  // ── Defendant: overruling risk ──
  if (docAnalysis?.overruling_risk_score != null) {
    if (docAnalysis.overruling_risk_score >= 0.6) {
      add(`Overruling risk: ${Math.round(docAnalysis.overruling_risk_score * 100)}%`, 2.0, "defendant");
    } else if (docAnalysis.overruling_risk_score >= 0.3) {
      add(`Overruling risk: ${Math.round(docAnalysis.overruling_risk_score * 100)}%`, 1.0, "defendant");
    }
  }

  // ── Defendant: negative treatment ──
  if (docAnalysis?.negative_treatment_count != null && docAnalysis.negative_treatment_count > 0) {
    const n     = docAnalysis.negative_treatment_count;
    const delta = n >= 3 ? 1.5 : 0.5;
    add(`Negative treatment: ${n} case${n > 1 ? "s" : ""}`, delta, "defendant");
  }

  // ── Defendant: precedent network instability ──
  if (precedent?.doctrine_instability === true) {
    add("Doctrine instability flag (precedent network)", 1.0, "defendant");
  }

  return { plaintiff_score, defendant_score, factors };
}

// ── Plaintiff argument builder ────────────────────────────────────────────────
//
// Sections:
//   1. Opening — legal question + summary of statutory basis
//   2. Statutory propositions — one line per governing law entry
//   3. Logical chain — reasoning_chain steps numbered
//   4. Precedent support — leading cases + analogous cases
//   5. Closing — conclusion restated as submission

function buildPlaintiffArgument(a: ArgumentStructure): string {
  const parts: string[] = [];

  // 1. Opening
  const actList = [...new Set(a.governing_law.map((g) => g.act_name))].join(", ");
  const actNote = actList
    ? `grounded in ${actList}`
    : "grounded in the governing statutory framework";

  parts.push(
    `PLAINTIFF'S SUBMISSION\n` +
    `${"─".repeat(60)}\n\n` +
    `The Plaintiff advances the following legal position, ${actNote}:\n\n` +
    `Issue: ${a.issue}`
  );

  // 2. Statutory propositions
  if (a.governing_law.length > 0) {
    const lines = a.governing_law
      .map((g, i) => `  ${i + 1}. ${g.act_name}, Section ${g.section_number}:\n     "${g.excerpt.trimEnd()}"`)
      .join("\n\n");
    parts.push(`STATUTORY BASIS\n\n${lines}`);
  }

  // 3. Logical reasoning chain
  if (a.reasoning_chain.length > 0) {
    const lines = a.reasoning_chain
      .map((step, i) => `  ${i + 1}. ${step}`)
      .join("\n");
    parts.push(`LEGAL REASONING\n\n${lines}`);
  }

  // 4. Precedent support
  const leading   = a.precedent_support.filter((p) => p.role === "leading");
  const analogous = a.precedent_support.filter((p) => p.role === "analogous");

  if (leading.length > 0 || analogous.length > 0) {
    const precedentLines: string[] = [];
    if (leading.length > 0) {
      precedentLines.push("Leading authorities:");
      for (const p of leading) {
        const tier  = p.authority_tier
          ? p.authority_tier.charAt(0).toUpperCase() + p.authority_tier.slice(1) + " Court"
          : "Court";
        const score = Math.round(p.influence_score * 100);
        precedentLines.push(`  • ${p.case_title} (${tier}) — influence: ${score}%`);
      }
    }
    if (analogous.length > 0) {
      precedentLines.push("Analogous authorities:");
      for (const p of analogous) {
        const score = Math.round(p.influence_score * 100);
        precedentLines.push(`  • ${p.case_title} — similarity: ${score}%`);
      }
    }
    parts.push(`PRECEDENT SUPPORT\n\n${precedentLines.join("\n")}`);
  }

  // 5. Closing submission
  parts.push(
    `SUBMISSION\n\n` +
    `On the basis of the statutory authority, logical reasoning, and judicial ` +
    `precedent set out above, the Plaintiff respectfully submits that:\n\n` +
    `  ${a.conclusion}`
  );

  return parts.join("\n\n");
}

// ── Opposing argument builder ─────────────────────────────────────────────────
//
// Sections:
//   1. Opening challenge — disputes the plaintiff's framing
//   2. Counterarguments — each with strength label and basis
//   3. Doctrine instability — weakening / unstable trend signals
//   4. Negative precedent — overruling risk + negative treatment
//   5. Closing — calls for dismissal

function buildOpposingArgument(
  a:            ArgumentStructure,
  docAnalysis?: IracResponse["doctrine_analysis"],
  precedent?:   IracResponse["precedent_intelligence"],
): string {
  const parts: string[] = [];

  // 1. Opening challenge
  parts.push(
    `DEFENDANT'S RESPONSE\n` +
    `${"─".repeat(60)}\n\n` +
    `The Defendant contests the Plaintiff's position on the following grounds:\n\n` +
    `Issue (restated): ${a.issue}`
  );

  // 2. Counterarguments
  if (a.counterarguments.length > 0) {
    const lines = a.counterarguments
      .map((ca, i) => {
        const strength =
          ca.strength === "strong"   ? "[STRONG]"   :
          ca.strength === "moderate" ? "[MODERATE]" : "[WEAK]";
        return (
          `  ${i + 1}. ${strength} ${ca.basis}\n` +
          `     Challenge: The above objection cannot be overcome by the Plaintiff's ` +
          `proposed rebuttal ("${ca.rebuttal.slice(0, 80)}…") ` +
          `because it fails to address the underlying doctrinal tension.`
        );
      })
      .join("\n\n");
    parts.push(`LEGAL OBJECTIONS\n\n${lines}`);
  } else {
    parts.push(`LEGAL OBJECTIONS\n\n  No formal counterarguments identified in the corpus. ` +
      `Defendant reserves the right to raise objections at hearing.`);
  }

  // 3. Doctrine instability
  const docInstabilityLines: string[] = [];
  if (docAnalysis?.doctrine_stability === "unstable") {
    docInstabilityLines.push(
      "• The governing doctrine has been classified as UNSTABLE. Courts have applied " +
      "this principle inconsistently, making reliance upon it inherently precarious."
    );
  } else if (docAnalysis?.doctrine_stability === "weakening") {
    docInstabilityLines.push(
      "• The doctrine exhibits a WEAKENING trend. Recent judicial treatment indicates " +
      "that courts are moving away from the position advanced by the Plaintiff."
    );
  }
  if (docAnalysis?.doctrine_trend === "weakening") {
    docInstabilityLines.push(
      "• Trend analysis confirms the doctrine is losing ground in recent jurisprudence."
    );
  }
  if (precedent?.doctrine_instability === true) {
    docInstabilityLines.push(
      "• Precedent network analysis reveals conflicting interpretations within the " +
      "relevant judicial cluster — no single authoritative line of cases supports the Plaintiff."
    );
  }
  if (docInstabilityLines.length > 0) {
    parts.push(`DOCTRINE INSTABILITY\n\n${docInstabilityLines.join("\n\n")}`);
  }

  // 4. Negative precedent signals
  const negativeLines: string[] = [];
  if (docAnalysis?.overruling_risk_score != null && docAnalysis.overruling_risk_score > 0.3) {
    const pct = Math.round(docAnalysis.overruling_risk_score * 100);
    negativeLines.push(
      `• Overruling risk: ${pct}% — there exists a material probability that the ` +
      `precedents relied upon by the Plaintiff may be overruled or distinguished by ` +
      `a superior court.`
    );
  }
  if (docAnalysis?.negative_treatment_count != null && docAnalysis.negative_treatment_count > 0) {
    const n = docAnalysis.negative_treatment_count;
    negativeLines.push(
      `• ${n} case${n > 1 ? "s have" : " has"} treated the Plaintiff's cited precedent ` +
      `negatively — through disapproval, adverse distinction, or express criticism.`
    );
  }
  if (
    precedent?.incoming_citations != null &&
    precedent.incoming_citations === 0 &&
    precedent?.precedent_strength_score != null &&
    precedent.precedent_strength_score < 0.3
  ) {
    negativeLines.push(
      "• The precedents relied upon have attracted zero subsequent citations, " +
      "indicating negligible judicial acceptance of the Plaintiff's legal theory."
    );
  }
  if (negativeLines.length > 0) {
    parts.push(`NEGATIVE PRECEDENT SIGNALS\n\n${negativeLines.join("\n\n")}`);
  }

  // 5. Closing
  parts.push(
    `SUBMISSION\n\n` +
    `The Defendant respectfully submits that the Plaintiff's position is not ` +
    `sustainable on the law as it currently stands. The objections set out above ` +
    `collectively undermine the foundational premises of the claim. The Defendant ` +
    `therefore prays that this matter be dismissed and costs awarded accordingly.`
  );

  return parts.join("\n\n");
}

// ── Arbitration result builder ────────────────────────────────────────────────
//
// Sections:
//   1. Position summary — one line each side
//   2. Precedent weight assessment
//   3. Doctrine stability assessment
//   4. Litigation probability assessment
//   5. Decision

function buildArbitrationResult(
  a:          ArgumentStructure,
  breakdown:  ScoreBreakdown,
  winning:    "plaintiff" | "defendant" | "inconclusive",
  docAnalysis?:   IracResponse["doctrine_analysis"],
  precedent?:     IracResponse["precedent_intelligence"],
): string {
  const ps = breakdown.plaintiff_score.toFixed(2);
  const ds = breakdown.defendant_score.toFixed(2);

  const parts: string[] = [];

  // 1. Summary
  parts.push(
    `ARBITRATION ASSESSMENT\n` +
    `${"═".repeat(60)}\n\n` +
    `This assessment evaluates the relative strength of both legal positions ` +
    `on a deterministic multi-factor model.\n\n` +
    `Plaintiff score: ${ps} pts\n` +
    `Defendant score: ${ds} pts`
  );

  // 2. Precedent weight
  const leadingCount   = a.precedent_support.filter((p) => p.role === "leading").length;
  const analogousCount = a.precedent_support.filter((p) => p.role === "analogous").length;
  const totalPrecWeight = a.precedent_support
    .filter((p) => p.role === "leading")
    .reduce((sum, p) => sum + p.influence_score, 0);

  const precedentAssessment =
    leadingCount > 0
      ? `${leadingCount} leading authorit${leadingCount > 1 ? "ies" : "y"} identified ` +
        `(aggregate influence weight: ${totalPrecWeight.toFixed(3)}). ` +
        (analogousCount > 0 ? `Additionally, ${analogousCount} analogous case${analogousCount > 1 ? "s" : ""} corroborate the position. ` : "") +
        (totalPrecWeight >= 1.5
          ? "Precedent weight is STRONG in favour of the Plaintiff."
          : totalPrecWeight >= 0.5
          ? "Precedent weight is MODERATE."
          : "Precedent weight is WEAK.")
      : "No leading precedent identified. Plaintiff's position rests on statutory text alone.";

  parts.push(`PRECEDENT WEIGHT ASSESSMENT\n\n${precedentAssessment}`);

  // 3. Doctrine stability
  const stability = docAnalysis?.doctrine_stability ?? "unknown";
  const trend     = docAnalysis?.doctrine_trend ?? null;
  const overruleRisk = docAnalysis?.overruling_risk_score ?? null;

  const stabilityLines = [
    `Doctrine stability: ${stability.toUpperCase()}`,
    trend ? `Doctrine trend:    ${trend.toUpperCase()}` : null,
    overruleRisk != null
      ? `Overruling risk:   ${Math.round(overruleRisk * 100)}%`
      : null,
    docAnalysis?.negative_treatment_count != null && docAnalysis.negative_treatment_count > 0
      ? `Negative treatment cases: ${docAnalysis.negative_treatment_count}`
      : null,
  ].filter(Boolean).join("\n");

  const stabilityVerdict =
    stability === "stable"    ? "Doctrine is STABLE — favours the Plaintiff." :
    stability === "unstable"  ? "Doctrine is UNSTABLE — favours the Defendant." :
    stability === "weakening" ? "Doctrine is WEAKENING — partial advantage to the Defendant." :
    "Doctrine stability is UNKNOWN — outcome is inherently uncertain.";

  parts.push(`DOCTRINE STABILITY ASSESSMENT\n\n${stabilityLines}\n\n${stabilityVerdict}`);

  // 4. Litigation probability
  const strengthScore = precedent?.precedent_strength_score;
  const incomingCites  = precedent?.incoming_citations;

  const litLines: string[] = [];
  if (strengthScore != null) {
    const pct = Math.round(strengthScore * 100);
    const label =
      pct >= 70 ? "HIGH"   :
      pct >= 40 ? "MEDIUM" : "LOW";
    litLines.push(`Precedent network strength: ${pct}% (${label})`);
  }
  if (incomingCites != null) {
    litLines.push(`Incoming citations to identified cases: ${incomingCites}`);
  }
  const netInstability = precedent?.doctrine_instability === true
    ? "Precedent network instability flag: YES — conflicting cluster detected."
    : null;
  if (netInstability) litLines.push(netInstability);

  if (litLines.length === 0) {
    litLines.push("No precedent network data available — litigation probability is indeterminate.");
  }

  parts.push(`LITIGATION PROBABILITY ASSESSMENT\n\n${litLines.join("\n")}`);

  // 5. Factor scorecard
  const scorecardLines = breakdown.factors.map((f) => {
    const sign  = f.side === "plaintiff" ? "+" : "−";
    const label = f.side === "plaintiff" ? "Plaintiff" : "Defendant";
    return `  ${sign}${f.delta.toFixed(2)}  [${label}]  ${f.label}`;
  });
  parts.push(`SCORING FACTORS\n\n${scorecardLines.join("\n")}`);

  // 6. Decision
  const decisionText =
    winning === "plaintiff"
      ? `DECISION: PLAINTIFF PREVAILS (score advantage: +${(breakdown.plaintiff_score - breakdown.defendant_score).toFixed(2)})`
      : winning === "defendant"
      ? `DECISION: DEFENDANT PREVAILS (score advantage: +${(breakdown.defendant_score - breakdown.plaintiff_score).toFixed(2)})`
      : `DECISION: INCONCLUSIVE — neither side has a decisive advantage (margin: ${Math.abs(breakdown.plaintiff_score - breakdown.defendant_score).toFixed(2)})`;

  parts.push(`${"═".repeat(60)}\n${decisionText}`);

  return parts.join("\n\n");
}

// ── Deterministic reasoning summary ──────────────────────────────────────────

function buildReasoning(
  a:          ArgumentStructure,
  breakdown:  ScoreBreakdown,
  winning:    "plaintiff" | "defendant" | "inconclusive",
): string {
  const lines: string[] = [];

  lines.push(
    `The arbitration model evaluated ${breakdown.factors.length} weighted factor${breakdown.factors.length !== 1 ? "s" : ""} ` +
    `across precedent weight, doctrine stability, and litigation risk.`
  );

  // Plaintiff strength summary
  const pFactors = breakdown.factors.filter((f) => f.side === "plaintiff");
  if (pFactors.length > 0) {
    lines.push(
      `Plaintiff's position derives primary strength from: ` +
      pFactors
        .sort((a, b) => b.delta - a.delta)
        .slice(0, 3)
        .map((f) => f.label)
        .join("; ") +
      "."
    );
  }

  // Defendant strength summary
  const dFactors = breakdown.factors.filter((f) => f.side === "defendant");
  if (dFactors.length > 0) {
    lines.push(
      `Defendant's position derives primary strength from: ` +
      dFactors
        .sort((a, b) => b.delta - a.delta)
        .slice(0, 3)
        .map((f) => f.label)
        .join("; ") +
      "."
    );
  }

  // Governing law note
  if (a.governing_law.length > 0) {
    const acts = [...new Set(a.governing_law.map((g) => g.act_name))].join(" and ");
    lines.push(`The statutory framework (${acts}) provides the textual anchor for the Plaintiff's case.`);
  } else {
    lines.push("No statutory citations were identified — both sides rely on common law reasoning alone.");
  }

  // Decision rationale
  const margin = Math.abs(breakdown.plaintiff_score - breakdown.defendant_score);
  if (winning === "plaintiff") {
    lines.push(
      `On balance, the Plaintiff's case is the stronger of the two. ` +
      `The precedent support and statutory grounding outweigh the counterarguments ` +
      `raised by the opposing side (margin: ${margin.toFixed(2)} pts).`
    );
  } else if (winning === "defendant") {
    lines.push(
      `On balance, the Defendant's objections prevail. ` +
      `The doctrine instability and negative precedent signals collectively undermine ` +
      `the Plaintiff's position (margin: ${margin.toFixed(2)} pts).`
    );
  } else {
    lines.push(
      `Neither side achieves a decisive advantage (margin: ${margin.toFixed(2)} pts). ` +
      `The outcome would turn heavily on the facts presented at hearing ` +
      `and the persuasion of the presiding bench.`
    );
  }

  return lines.join(" ");
}

// ── Public entry point ────────────────────────────────────────────────────────

export function runDebateEngine(input: DebateEngineInput): DebateResult {
  const { argument_structure: a, doctrine_analysis, precedent_intelligence } = input;

  // Score both sides
  const breakdown = scoreDebate(a, doctrine_analysis, precedent_intelligence);

  // Determine winner (threshold: ≥ 1.0 advantage)
  const margin = breakdown.plaintiff_score - breakdown.defendant_score;
  const winning: "plaintiff" | "defendant" | "inconclusive" =
    margin >=  1.0 ? "plaintiff" :
    margin <= -1.0 ? "defendant" :
    "inconclusive";

  return {
    plaintiff_argument: buildPlaintiffArgument(a),
    opposing_argument:  buildOpposingArgument(a, doctrine_analysis, precedent_intelligence),
    arbitration_result: buildArbitrationResult(a, breakdown, winning, doctrine_analysis, precedent_intelligence),
    winning_side:       winning,
    reasoning:          buildReasoning(a, breakdown, winning),
  };
}
