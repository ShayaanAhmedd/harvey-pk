// lib/ai/argument-builder.ts
//
// Legal Argument Builder — pure deterministic transformation layer.
// No LLM calls, no DB access, no side effects. O(1) complexity.
//
// Takes the fully-assembled IracResponse (after all upstream pipeline steps)
// and synthesises it into a structured legal argument ready for display or
// downstream processing.
//
// Input:
//   IracResponse fields consumed:
//     irac.issue, irac.rule, irac.application, irac.conclusion, irac.citations
//     doctrine_analysis     — stability, overruling risk, treatment counts
//     doctrine_influence    — leading_precedents with influence scores
//     precedent_intelligence — precedent strength, doctrine_instability, similar_cases
//     knowledge_graph_insight — overruling_cases, citing_cases counts
//
// Output:
//   ArgumentStructure — suitable for attaching to IracResponse.argument_structure
//
// Constraints:
//   - Never modifies confidence_score or risk_level
//   - Purely additive — caller attaches result to existing response
//   - Gracefully handles absent optional fields (all inputs are optional)

import type { IracResponse, IracCitation } from "./irac";

// ── Public output types ───────────────────────────────────────────────────────

export interface GoverningLawEntry {
  act_name:       string;
  section_number: string;
  excerpt:        string;
}

export interface PrecedentSupportEntry {
  case_title:      string;
  authority_tier:  string;
  influence_score: number;
  role:            "leading" | "analogous";
}

export interface CounterargumentEntry {
  basis:    string;
  strength: "weak" | "moderate" | "strong";
  rebuttal: string;
}

export interface ArgumentStructure {
  issue:             string;
  governing_law:     GoverningLawEntry[];
  precedent_support: PrecedentSupportEntry[];
  reasoning_chain:   string[];
  counterarguments:  CounterargumentEntry[];
  conclusion:        string;
}

// ── Internal input shape ──────────────────────────────────────────────────────
//
// We accept a subset of IracResponse so callers can pass the full response
// without destructuring. TypeScript structural typing ensures compatibility.

type ArgumentInput = Pick<
  IracResponse,
  | "issue"
  | "rule"
  | "application"
  | "conclusion"
  | "citations"
> & {
  doctrine_analysis?:      IracResponse["doctrine_analysis"];
  doctrine_influence?:     IracResponse["doctrine_influence"];
  precedent_intelligence?: IracResponse["precedent_intelligence"];
  knowledge_graph_insight?: IracResponse["knowledge_graph_insight"];
};

// ── Helper: truncate to N words ───────────────────────────────────────────────

function firstWords(text: string, n: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= n) return text.trim();
  return words.slice(0, n).join(" ") + "…";
}

// ── 1. governing_law ──────────────────────────────────────────────────────────
//
// One entry per unique (act_name, section_number) citation from the IRAC core.
// Deduplicates on the compound key; first occurrence wins (preserves LLM order).

function buildGoverningLaw(citations: IracCitation[]): GoverningLawEntry[] {
  const seen = new Set<string>();
  const entries: GoverningLawEntry[] = [];

  for (const c of citations) {
    const key = `${c.act_name.toLowerCase()}|||${c.section_number.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      act_name:       c.act_name,
      section_number: c.section_number,
      excerpt:        c.excerpt,
    });
  }

  return entries;
}

// ── 2. precedent_support ──────────────────────────────────────────────────────
//
// Primary: doctrine_influence.leading_precedents → role = "leading"
// Secondary: precedent_intelligence.similar_cases → role = "analogous"
//   - Only cases not already in leading_precedents (dedup by case_title)
//   - Use similarity as influence_score proxy
//   - Skip entries with null case_title or null authority_tier
//
// Sorted: leading first (desc influence_score), then analogous (desc similarity)

function buildPrecedentSupport(
  influence?:   IracResponse["doctrine_influence"],
  precedent?:   IracResponse["precedent_intelligence"],
): PrecedentSupportEntry[] {
  const entries: PrecedentSupportEntry[] = [];
  const seenTitles = new Set<string>();

  // Leading precedents from doctrine_influence
  for (const p of (influence?.leading_precedents ?? [])) {
    if (!p.case_title) continue;
    const key = p.case_title.toLowerCase();
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    entries.push({
      case_title:      p.case_title,
      authority_tier:  p.authority_tier,
      influence_score: Math.round(p.influence_score * 1000) / 1000,
      role:            "leading",
    });
  }

  // Analogous cases from precedent_intelligence (top 3, deduplicated)
  const similar = (precedent?.similar_cases ?? [])
    .filter((c) => c.case_title && c.authority_tier)
    .slice(0, 3);

  for (const c of similar) {
    if (!c.case_title || !c.authority_tier) continue;
    const key = c.case_title.toLowerCase();
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    entries.push({
      case_title:      c.case_title,
      authority_tier:  c.authority_tier,
      influence_score: Math.round(c.similarity * 1000) / 1000,
      role:            "analogous",
    });
  }

  return entries;
}

// ── 3. reasoning_chain ────────────────────────────────────────────────────────
//
// Ordered logical steps combining:
//   (a) Issue framing
//   (b) Governing provisions — one step per citation
//   (c) Application summary
//   (d) Leading precedent support — one step per leading precedent
//   (e) Precedent network signal (when strength score is available)
//   (f) Doctrine trend (when available)

function buildReasoningChain(
  input: Pick<ArgumentInput, "issue" | "application" | "citations">,
  precedentSupport: PrecedentSupportEntry[],
  precedent?:       IracResponse["precedent_intelligence"],
  docAnalysis?:     IracResponse["doctrine_analysis"],
): string[] {
  const chain: string[] = [];

  // (a) Issue framing
  chain.push(`Legal question: ${firstWords(input.issue, 40)}`);

  // (b) Governing provisions — one concise step per citation
  for (const c of input.citations) {
    chain.push(
      `${c.act_name} §${c.section_number} provides: "${firstWords(c.excerpt, 25)}"`
    );
  }

  // (c) Application summary
  if (input.application.trim().length > 0) {
    chain.push(`Application to facts: ${firstWords(input.application, 50)}`);
  }

  // (d) Leading precedent support
  const leading = precedentSupport.filter((p) => p.role === "leading");
  for (const p of leading.slice(0, 3)) {
    chain.push(
      `${p.case_title} (${p.authority_tier}) supports this position ` +
      `[influence score: ${p.influence_score}]`
    );
  }

  // Analogous cases summary (abbreviated)
  const analogous = precedentSupport.filter((p) => p.role === "analogous");
  if (analogous.length > 0) {
    chain.push(
      `${analogous.length} analogous case${analogous.length > 1 ? "s" : ""} identified: ` +
      analogous.map((a) => a.case_title).join("; ")
    );
  }

  // (e) Precedent network signal
  if (precedent?.precedent_strength_score != null) {
    const pct = Math.round(precedent.precedent_strength_score * 100);
    chain.push(
      `Precedent network strength: ${pct}% ` +
      `(${precedent.incoming_citations} incoming citation${precedent.incoming_citations !== 1 ? "s" : ""})`
    );
  }

  // (f) Doctrine trend signal
  if (docAnalysis?.doctrine_trend === "strengthening") {
    chain.push("Doctrine trend: strengthening — precedent is gaining judicial acceptance.");
  } else if (docAnalysis?.doctrine_trend === "weakening") {
    chain.push("Doctrine trend: weakening — recent courts moving away from this position.");
  }

  return chain;
}

// ── 4. counterarguments ───────────────────────────────────────────────────────
//
// Derived from doctrine instability signals. Each entry carries:
//   basis    — what the opposing argument rests on
//   strength — calibrated from the severity of the underlying signal
//   rebuttal — suggested response from the advocate's perspective
//
// Sources checked (in priority order):
//   (a) knowledge_graph_insight.overruling_cases > 0
//   (b) doctrine_analysis.doctrine_stability
//   (c) doctrine_analysis.overruling_risk_score
//   (d) doctrine_analysis.negative_treatment_count
//   (e) precedent_intelligence.doctrine_instability
//   (f) precedent_intelligence.incoming_citations (low count → weak precedent signal)

function buildCounterarguments(
  docAnalysis?: IracResponse["doctrine_analysis"],
  precedent?:   IracResponse["precedent_intelligence"],
  graph?:       IracResponse["knowledge_graph_insight"],
): CounterargumentEntry[] {
  const args: CounterargumentEntry[] = [];

  // (a) Overruling cases in knowledge graph
  if (graph?.overruling_cases && graph.overruling_cases > 0) {
    const n = graph.overruling_cases;
    args.push({
      basis:
        `${n} overruling case${n > 1 ? "s" : ""} exist in the knowledge graph that may ` +
        "directly undermine reliance on this precedent.",
      strength: n >= 3 ? "strong" : "moderate",
      rebuttal:
        "Distinguish the overruling cases on their specific facts; argue that the precedent " +
        "remains good law for the present factual matrix.",
    });
  }

  // (b) Doctrine stability
  if (docAnalysis?.doctrine_stability === "unstable") {
    args.push({
      basis:
        "The governing doctrine is currently classified as unstable — courts have been " +
        "inconsistent in applying this legal principle.",
      strength: "strong",
      rebuttal:
        "Anchor the argument to the most recent Supreme Court pronouncement on the issue. " +
        "If none, argue from first principles of the statute.",
    });
  } else if (docAnalysis?.doctrine_stability === "weakening") {
    args.push({
      basis:
        "The doctrine shows a weakening trend — recent judicial treatment indicates " +
        "decreasing support for this legal position.",
      strength: "moderate",
      rebuttal:
        "Demonstrate that the weakening trend does not apply to the specific factual " +
        "context of this matter; cite distinguishing factors.",
    });
  }

  // (c) Overruling risk score
  if (docAnalysis?.overruling_risk_score != null && docAnalysis.overruling_risk_score > 0.3) {
    const score = docAnalysis.overruling_risk_score;
    const pct   = Math.round(score * 100);
    args.push({
      basis:
        `Overruling risk score of ${pct}% — there is a material probability that a ` +
        "higher court may overrule or significantly limit the cited precedents.",
      strength: score >= 0.6 ? "strong" : "moderate",
      rebuttal:
        "Emphasise legislative intent and the statutory text to ground the argument " +
        "independently of judicial precedent, reducing exposure to overruling risk.",
    });
  }

  // (d) Negative treatment count
  if (docAnalysis?.negative_treatment_count != null && docAnalysis.negative_treatment_count > 0) {
    const n = docAnalysis.negative_treatment_count;
    args.push({
      basis:
        `${n} case${n > 1 ? "s" : ""} ha${n > 1 ? "ve" : "s"} treated the cited precedent ` +
        "negatively (disapproval, criticism, or adverse distinction).",
      strength: n >= 3 ? "moderate" : "weak",
      rebuttal:
        "Address the negatively-treating cases directly — either distinguish them on facts " +
        "or demonstrate that they represent a minority judicial view.",
    });
  }

  // (e) Doctrine instability flag from precedent network
  if (precedent?.doctrine_instability === true && args.every((a) => a.basis.indexOf("unstable") === -1)) {
    args.push({
      basis:
        "The precedent network analysis indicates doctrine instability — conflicting " +
        "judicial interpretations exist within the relevant case cluster.",
      strength: "moderate",
      rebuttal:
        "Select the highest-authority binding precedent and present it as the controlling " +
        "authority; treat conflicting decisions as non-binding or distinguishable.",
    });
  }

  // (f) Low incoming citation count (weak precedent footprint)
  if (
    precedent?.incoming_citations != null &&
    precedent.incoming_citations === 0 &&
    precedent.precedent_strength_score < 0.3
  ) {
    args.push({
      basis:
        "The identified precedents have not been cited by subsequent cases, suggesting " +
        "limited judicial acceptance or niche applicability.",
      strength: "weak",
      rebuttal:
        "Argue that novelty of the precedent reflects an evolving area of law rather than " +
        "judicial rejection; rely on the statute text as primary authority.",
    });
  }

  return args;
}

// ── Public entry point ────────────────────────────────────────────────────────

export function buildArgumentStructure(input: ArgumentInput): ArgumentStructure {
  const governingLaw   = buildGoverningLaw(input.citations);
  const precedentSupport = buildPrecedentSupport(
    input.doctrine_influence,
    input.precedent_intelligence,
  );
  const counterarguments = buildCounterarguments(
    input.doctrine_analysis,
    input.precedent_intelligence,
    input.knowledge_graph_insight,
  );
  const reasoningChain = buildReasoningChain(
    { issue: input.issue, application: input.application, citations: input.citations },
    precedentSupport,
    input.precedent_intelligence,
    input.doctrine_analysis,
  );

  return {
    issue:             input.issue,
    governing_law:     governingLaw,
    precedent_support: precedentSupport,
    reasoning_chain:   reasoningChain,
    counterarguments,
    conclusion:        input.conclusion,
  };
}
