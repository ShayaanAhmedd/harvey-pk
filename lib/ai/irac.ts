// lib/ai/irac.ts
//
// IRAC (Issue–Rule–Application–Conclusion) enforcement engine — enterprise edition.
// Used exclusively by premium mode in app/api/chats/[chatId]/messages/route.ts.
//
// Execution pipeline:
//   1. Build system prompt that forces strict JSON output
//   2. callIrac → routeAIRequest("legal_deep") at temperature 0  (primary: Claude)
//   3. Parse + structurally validate the JSON response
//   4. Run in parallel:
//        a. validateCitations  — ILIKE lookup per (act_name, section_number) in Supabase
//        b. callArbitrator     — secondary provider ("crosscheck" → Gemini) verifies IRAC
//   5. If ALL citations invalid → regenerate once; arbitration → "unavailable"
//   6. checkTemporalValidity  — scan RAG chunk content for amendment/repeal markers
//   7. computeWeightedSimilarity — weight retrieval score by precedent authority tier
//   8. computeConfidence      — (valid/total) × weightedAvg × (1−conflict) × temporalFactor
//   9. Apply arbitration      — if "disagree": confidence −25%, risk++ one tier
//  10. computeRiskLevel       — rule table: high / moderate / low
//  11. Return enriched IracResponse
//
// Constraints honoured:
//   - router.ts unchanged (uses existing "legal_deep" and "crosscheck" task types)
//   - No new external dependencies
//   - Non-premium paths in route.ts are untouched
//   - IracResponse new fields are all optional (backward-compatible)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { SupabaseClient } from "@supabase/supabase-js";
import { routeAIRequest } from "./router";
import { embedText } from "../embeddings";
import { findSimilarCases, analyzePrecedentStrength } from "./precedent-graph";
import { simulateStrategies } from "./strategy-simulator";
import { analyzeDoctrine } from "./doctrine-engine";
import { queryKnowledgeGraphInsight } from "./legal-graph";
import { analyzeDoctrineInfluence } from "./doctrine-influence";
import { generateLitigationBrief } from "./brief-generator";
import type { LitigationBrief } from "./brief-generator";
import { formatParagraphs } from "../utils/paragraph-format";
import { buildArgumentStructure } from "./argument-builder";
import type { ArgumentStructure } from "./argument-builder";
import { extractJson } from "./extract-json";

// ── Public types ──────────────────────────────────────────────────────────────

export interface IracCitation {
  act_name:       string;
  section_number: string;
  excerpt:        string;
}

export interface IracResponse {
  issue:            string;
  rule:             string;         // may have temporal annotation appended
  application:      string;
  conclusion:       string;
  citations:        IracCitation[];
  confidence_score: number;         // [0, 1]
  risk_level:       "low" | "moderate" | "high";
  // Optional extended fields (all backward-compatible)
  arbitration_flag?:    boolean | "unavailable";
  arbitration_reason?:  string;
  precedent_weight?:    number;    // highest authority weight found [0.6–1.0]
  temporal_flags?:      string[];  // per-citation amendment/repeal annotations
  graph_expansion?:     {
    cross_references_followed: number;
    amendment_links_detected:  number;
  };
  // Jurisdiction scoping / historical reconstruction (Tasks 1, 5)
  jurisdiction_applied?: string;   // echoes the jurisdiction filter applied
  historical_mode?:      boolean;  // true when asOfDate was explicitly provided
  // Contradiction detection + argument strength
  argument_strength?:       number;    // [0, 1] composite advocacy score
  authority_tiers_present?: string[];  // e.g. ["supreme", "legislation"]
  contradiction_detected?:  boolean;   // true when tier content diverges
  // Litigation outcome probability
  litigation_assessment?: {
    success_probability: number;                                           // [0, 1]
    risk_band: "very_low" | "low" | "moderate" | "high" | "very_high";   // litigation exposure
    drivers: string[];                                                     // explanation factors
  };
  // Historical outcome benchmark — included only when comparable cases exist
  benchmark_assessment?: {
    comparable_case_count:     number;
    historical_success_rate:   number;   // 0–1
    authority_alignment_score: number;   // 0–1
    trend_direction?: "favorable" | "neutral" | "unfavorable";
  };
  // Enterprise audit trace — only present when prefDirectives includes "audit_mode=true"
  reasoning_trace?: {
    retrieval_summary: {
      total_chunks:              number;
      after_graph_expansion:     number;
      after_jurisdiction_filter?: number;
      after_date_filter?:         number;
    };
    authority_analysis: {
      tiers_present:          string[];
      highest_weight:         number;
      contradiction_detected: boolean;
    };
    arbitration?: {
      status:  "agree" | "disagree" | "unavailable";
      reason?: string;
    };
    temporal_analysis?: {
      amendment_detected: boolean;
      notes?: string[];
    };
    graph_analysis?: {
      cross_references_followed: number;
      amendment_links_detected:  number;
    };
  };
  // Structured litigation memorandum — only present when prefDirectives includes "memo_mode=true"
  litigation_memo?: LitigationMemo;
  // Judge & forum advisory intelligence — only when judgeName/courtName provided to pipeline
  forum_intelligence?: {
    court_name?:             string;
    forum_success_rate?:     number;  // overall_success_rate from forum_analytics
    judge_name?:             string;
    judge_success_rate?:     number;  // success_rate from judge_analytics
    judge_strictness_index?: number;  // unfavorable_count / total_cases
    forum_trend?:            number;  // five_year_trend delta (float, positive = improving)
  };
  // Precedent network intelligence — advisory only; never alters confidence_score/risk_level
  precedent_intelligence?: {
    precedent_strength_score: number;
    incoming_citations:       number;
    doctrine_instability:     boolean;
    similar_cases: {
      case_title:     string | null;
      authority_tier: string | null;
      decision_year:  number | null;
      similarity:     number;
    }[];
  };
  // Strategy simulation — advisory only; never alters existing probability outputs
  strategy_simulation?: {
    strategies: {
      strategy_type:                string;
      description:                  string;
      adjusted_success_probability: number;
      adjusted_risk_level:          "low" | "moderate" | "high";
      reasoning_factors:            string[];
    }[];
  };
  // Doctrine stability analysis — advisory; only success_probability may be adjusted
  doctrine_analysis?: {
    doctrine_stability:          "stable" | "weakening" | "unstable";
    overruling_risk_score:        number;
    negative_treatment_count:     number;
    supporting_precedent_count:   number;
    doctrine_trend:               "strengthening" | "neutral" | "weakening";
  };
  // Knowledge graph insight — purely advisory; no probability adjustments
  knowledge_graph_insight?: {
    related_cases:         number;
    citing_cases:          number;
    overruling_cases:      number;
    doctrine_cluster_size: number;
  };
  // Doctrine influence analysis — purely advisory; no probability adjustments
  doctrine_influence?: {
    leading_precedents: {
      case_title:      string;
      authority_tier:  string;
      influence_score: number;
    }[];
    doctrine_cluster_size:     number;
    precedent_network_density: number;
  };
  // Structured litigation brief — deterministic aggregation of all intelligence layers
  litigation_brief?: LitigationBrief;
  // Structured legal argument — purely additive; never modifies confidence or risk scores
  argument_structure?: ArgumentStructure;
  // Citation corpus warning — present when no citations could be verified in the DB
  citation_warning?: "citations_not_verified_in_corpus";
}

export type IracResult =
  | { ok: true;  data: IracResponse }
  | { ok: false; error: "insufficient_corpus_support" | "parse_failure" };

// Extended with optional fields used by Tasks 2 + 3.
// Backward-compatible: route.ts passes RagChunk[] which has all these fields,
// and TypeScript structural typing allows extra fields on the call site.
export interface IracRagChunk {
  act_name:       string | null;
  section_number: string | null;
  similarity:     number;
  content?:       string;       // for temporal validity scanning
  year?:          number | null;
  file_name?:     string;       // for precedent authority detection
  // Jurisdiction scoping + historical reconstruction (Task 1)
  jurisdiction?:   string | null;  // "federal" | "punjab" | "sindh" | etc.
  effective_from?: Date   | null;  // chunk not valid before this date
  effective_to?:   Date   | null;  // chunk not valid after this date
}

// ── Internal types ────────────────────────────────────────────────────────────

// IracCore is what the LLM returns — scoring fields are computed separately
type IracCore = Pick<IracResponse, "issue" | "rule" | "application" | "conclusion" | "citations">;

type ValidatedCitation = IracCitation & { db_verified: boolean };

interface ArbitrationVerdict {
  verdict:                "agree" | "disagree";
  reason:                 string;
  citation_discrepancies: string[];
}

interface WeightedSimMetrics {
  weightedAvg:       number;
  highestWeight:     number;   // highest authority weight in the chunk set
  hasCaseLaw:        boolean;  // true when any chunk is case law (not legislation)
  authorityConflict: boolean;  // true when chunks span more than one authority tier
}

// ── Graph node model (Task 1) ─────────────────────────────────────────────────

interface StatuteNode {
  act_name:       string;
  section_number: string;
  references:     string[];  // cross-referenced section numbers extracted from content
  amendments:     string[];  // "amended by X" match captures
  repeals:        string[];  // "repealed by X" match captures
}

interface GraphExpansionResult {
  expandedChunks:      IracRagChunk[];  // baseChunks + newly fetched cross-ref chunks
  crossReferenceCount: number;          // unique new sections fetched and appended
  amendmentLinks:      number;          // chunks (base + expanded) with amendment/repeal markers
}

// ── IRAC JSON schema (embedded in primary system prompt) ──────────────────────

const IRAC_SCHEMA = `{
  "issue": "<precise legal question — jurisdiction, legislative framework, statutory proposition>",
  "rule":  "<all applicable statutes quoted verbatim — never paraphrase operative text>",
  "application": "<apply rule to facts — depth of a published law journal memorandum>",
  "conclusion":  "<definitive legal position — no hedging — senior counsel standard>",
  "citations": [
    {
      "act_name":       "<exact Act name as it appears in STATUTORY CONTEXT>",
      "section_number": "<exact section number as it appears in STATUTORY CONTEXT>",
      "excerpt":        "<verbatim operative text of the provision>"
    }
  ]
}`;

// ── System prompt builder ─────────────────────────────────────────────────────

export function buildIracSystemPrompt(contextText: string, prefDirectives = ""): string {
  return `You are Harvey — a senior legal counsel specialising in Pakistani law.

CRITICAL: Respond with ONLY valid JSON. No markdown, no prose, no preamble, no text outside the JSON object.

Your entire response must conform to this schema — nothing else:
${IRAC_SCHEMA}

FIELD RULES:
- issue:       Precise legal question with jurisdiction and legislative framework identified.
- rule:        Every applicable statute, quoted verbatim and in full. Cite as: Act Name, Section Number (Year).
- application: Apply rule to facts. Analytical rigour of a published law journal memorandum.
- conclusion:  Definitive legal position synthesising rule and application. No hedging.
- citations:   EVERY provision relied upon in rule/application.
               ONLY cite provisions present in the STATUTORY CONTEXT below.
               Do NOT invent or hallucinate act names or section numbers.${prefDirectives}

STATUTORY CONTEXT:
${contextText || "(none — reason from Pakistani law knowledge; cite only provisions you are certain exist)"}`;
}

// ── IRAC response parser ──────────────────────────────────────────────────────

function parseIrac(raw: string): IracCore | null {
  try {
    const parsed = JSON.parse(extractJson(raw)) as Record<string, unknown>;

    if (
      typeof parsed.issue       !== "string" ||
      typeof parsed.rule        !== "string" ||
      typeof parsed.application !== "string" ||
      typeof parsed.conclusion  !== "string" ||
      !Array.isArray(parsed.citations)
    ) return null;

    const citations: IracCitation[] = (parsed.citations as unknown[]).filter(
      (c): c is IracCitation =>
        typeof (c as Record<string, unknown>)?.act_name       === "string" &&
        typeof (c as Record<string, unknown>)?.section_number === "string" &&
        typeof (c as Record<string, unknown>)?.excerpt        === "string"
    );

    return {
      issue:       String(parsed.issue),
      rule:        String(parsed.rule),
      application: String(parsed.application),
      conclusion:  String(parsed.conclusion),
      citations,
    };
  } catch {
    console.error("[IRAC parse failure]", raw?.slice(0, 500));
    return null;
  }
}

// ── Primary LLM call ──────────────────────────────────────────────────────────

async function callIrac(
  question:     string,
  contextText:  string,
  systemPrompt: string,
): Promise<IracCore | null> {
  try {
    const res = await routeAIRequest("legal_deep", {
      question,
      contextText,
      systemPrompt,
      maxTokens:   2000,
      temperature: 0,   // deterministic — no creative variation
    });
    return parseIrac(res.result);
  } catch {
    return null;
  }
}

// ── Task 1: Multi-model arbitration ───────────────────────────────────────────
//
// Uses routeAIRequest("crosscheck") which routes primary to Gemini, falling
// back to Claude. This provides a model-independent second opinion on the
// primary IRAC (produced by Claude via "legal_deep").
//
// The full arbitration prompt is embedded in the `question` parameter so it
// works correctly with the Gemini adapter, which does not accept systemPrompt.
//
// On any failure (network, parse error, rate limit) → returns "unavailable".
// Caller: promise.all with citation validation — net latency = 1 extra call.

function buildArbitrationPrompt(irac: IracCore, originalQuestion: string): string {
  return `You are a senior legal reviewer at a Pakistani law firm.

A legal analysis has been produced for the following question. Independently verify whether the analysis is legally sound and the citations are accurate.

ORIGINAL QUESTION:
${originalQuestion}

IRAC ANALYSIS TO VERIFY:
${JSON.stringify(irac, null, 2)}

Return ONLY valid JSON matching this exact schema:
{
  "verdict": "agree" | "disagree",
  "reason": string,
  "citation_discrepancies": string[]
}

verdict: "agree"    — analysis is legally sound; citations are accurate; conclusion is defensible.
verdict: "disagree" — there are legal errors, incorrect citations, or a faulty conclusion.
reason:             — one to three sentences explaining your verdict.
citation_discrepancies: — specific issues with cited provisions (empty array when verdict is "agree").

Return ONLY the JSON object. No prose, no markdown.`;
}

function parseArbitrationVerdict(raw: string): ArbitrationVerdict | null {
  try {
    const parsed = JSON.parse(extractJson(raw)) as Record<string, unknown>;

    if (
      (parsed.verdict !== "agree" && parsed.verdict !== "disagree") ||
      typeof parsed.reason !== "string"                             ||
      !Array.isArray(parsed.citation_discrepancies)
    ) return null;

    return {
      verdict:                parsed.verdict as "agree" | "disagree",
      reason:                 String(parsed.reason),
      citation_discrepancies: (parsed.citation_discrepancies as unknown[]).map(String),
    };
  } catch {
    return null;
  }
}

async function callArbitrator(
  irac:             IracCore,
  originalQuestion: string,
): Promise<ArbitrationVerdict | "unavailable"> {
  try {
    const res = await routeAIRequest("crosscheck", {
      question:    buildArbitrationPrompt(irac, originalQuestion),
      contextText: "",
      maxTokens:   500,
      temperature: 0,
    });
    return parseArbitrationVerdict(res.result) ?? "unavailable";
  } catch {
    return "unavailable";
  }
}

// ── Task 2: Precedent authority weighting ─────────────────────────────────────
//
// Pakistani law reporter identifiers map to court hierarchy tiers:
//   Supreme Court  — SCMR, SCJ, "Supreme Court"           → weight 1.0
//   High Court     — PCrLJ, CLC, MLD, PLJ, "High Court"  → weight 0.8
//   Lower court    — PLD without SC/HC label, unspecified → weight 0.6
//   Legislation    — Acts, Ordinances, Rules, Codes       → weight 1.0
//
// Legislation receives 1.0 because it is primary law — not subject to vertical
// stare decisis hierarchy. Case law interprets legislation; it does not supersede it.
//
// authorityConflict: true when the chunk set spans more than one case-law tier
// (e.g., SC and HC chunks together, suggesting unsettled interpretation).

const SC_PATTERN  = /\b(?:SCMR|SCJ|Supreme\s+Court)\b/i;
const HC_PATTERN  = /\b(?:PCrLJ|CLC|MLD|PLJ|High\s+Court)\b/i;
const PLD_PATTERN = /\bPLD\b/i;
const LEG_PATTERN = /\b(?:Act|Ordinance|Rules?|Code|Regulation)\b/i;

function chunkAuthorityWeight(chunk: IracRagChunk): number {
  const text = `${chunk.act_name ?? ""} ${chunk.file_name ?? ""}`;
  if (SC_PATTERN.test(text))                              return 1.0;
  if (HC_PATTERN.test(text))                              return 0.8;
  if (PLD_PATTERN.test(text) && !LEG_PATTERN.test(text)) return 0.6; // case law PLD
  return 1.0; // legislation or unclassified → full statutory weight
}

function isCaseLaw(chunk: IracRagChunk): boolean {
  const text = `${chunk.act_name ?? ""} ${chunk.file_name ?? ""}`;
  return SC_PATTERN.test(text) || HC_PATTERN.test(text) ||
    (PLD_PATTERN.test(text) && !LEG_PATTERN.test(text));
}

function computeWeightedSimilarity(chunks: IracRagChunk[]): WeightedSimMetrics {
  if (chunks.length === 0) {
    return { weightedAvg: 0.5, highestWeight: 1.0, hasCaseLaw: false, authorityConflict: false };
  }

  const weights      = chunks.map(chunkAuthorityWeight);
  const caseLawTiers = new Set(
    chunks.filter(isCaseLaw).map((_, i) => weights[i])
  );

  const weightedSum   = chunks.reduce((sum, c, i) => sum + c.similarity * weights[i], 0);
  const weightSum     = weights.reduce((s, w) => s + w, 0);
  const weightedAvg   = weightedSum / weightSum;
  const highestWeight = Math.max(...weights);
  const hasCaseLaw    = chunks.some(isCaseLaw);
  // Conflict: case-law chunks span more than one authority tier
  const authorityConflict = caseLawTiers.size > 1;

  return { weightedAvg, highestWeight, hasCaseLaw, authorityConflict };
}

// ── Task 3: Temporal validity check ──────────────────────────────────────────
//
// Scans the `content` field of RAG chunks that match each citation's
// (act_name, section_number) for amendment and repeal markers that were
// preserved during PDF text extraction.
//
// Detection patterns:
//   Amendment: "amended by X", "substituted by X", "inserted by X"
//   Repeal:    "repealed by X", "omitted by X"
//
// When markers are found:
//   - A human-readable flag is recorded per affected citation
//   - A bracketed note is appended to the rule field
//   - confidence_score is multiplied by 0.90 (10% reduction)
//
// asOfDate is accepted for API symmetry and future use (e.g., comparing
// against amendment year). Currently the presence of the marker itself
// is sufficient signal — effective date is not stored in the schema.

const AMEND_RE = /(?:amended|substituted|inserted)\s+by\s+([A-Z][^\n.]{3,60})/gi;
const REPEAL_RE = /(?:repealed|omitted)\s+by\s+([A-Z][^\n.]{3,60})/gi;

interface TemporalResult {
  flags:         string[];  // per-citation human-readable annotations
  ruleSuffix:    string;    // block appended to IracCore.rule
  penaltyFactor: number;    // 0.9 if any flags; 1.0 otherwise
}

function checkTemporalValidity(
  citations: IracCitation[],
  ragChunks: IracRagChunk[],
  _asOfDate: Date,
): TemporalResult {
  const flags: string[] = [];

  for (const citation of citations) {
    const chunk = ragChunks.find(
      (c) =>
        c.act_name?.toLowerCase()       === citation.act_name.toLowerCase()       &&
        c.section_number?.toLowerCase() === citation.section_number.toLowerCase()
    );
    if (!chunk?.content) continue;

    const amendMatches  = [...chunk.content.matchAll(AMEND_RE)].map((m) => m[1].trim());
    const repealMatches = [...chunk.content.matchAll(REPEAL_RE)].map((m) => m[1].trim());

    for (const ref of amendMatches) {
      flags.push(
        `${citation.act_name} — Section ${citation.section_number}: amended by ${ref}`
      );
    }
    for (const ref of repealMatches) {
      flags.push(
        `${citation.act_name} — Section ${citation.section_number}: repealed/omitted by ${ref}`
      );
    }
  }

  if (flags.length === 0) return { flags: [], ruleSuffix: "", penaltyFactor: 1.0 };

  const ruleSuffix =
    "\n\n[TEMPORAL NOTE: The following cited provisions carry amendment or repeal markers " +
    "in the corpus. Verify current operative text before reliance:\n" +
    flags.map((f) => `  • ${f}`).join("\n") + "]";

  return { flags, ruleSuffix, penaltyFactor: 0.9 };
}

// ── Statute Graph Engine ──────────────────────────────────────────────────────
//
// Tasks 2–5: Graph-aware context enrichment.
//
// buildContextText    — formats IracRagChunk[] into the STATUTORY CONTEXT block
// extractCrossReferences — extracts "section X" references from statutory text
// expandStatuteGraph  — fetches cross-referenced sections from Supabase (depth 1)
//
// Cross-reference patterns matched (case-insensitive):
//   "section 23"       "Section 45A"     "see section 7"
//   "read with section 9"                "under section 12"
//
// Non-global test regexes for boolean checks (avoid lastIndex state with /g flag):
const AMEND_TEST_RE  = /(?:amended|substituted|inserted)\s+by\s+[A-Z]/i;
const REPEAL_TEST_RE = /(?:repealed|omitted)\s+by\s+[A-Z]/i;

// Similarity score assigned to graph-expanded chunks (cross-referenced, not vector-matched)
const GRAPH_CHUNK_SIMILARITY = 0.70;

function buildContextText(chunks: IracRagChunk[]): string {
  return chunks
    .map((c) => {
      const header =
        c.act_name && c.section_number
          ? `${c.act_name} — Section ${c.section_number}`
          : (c.file_name ?? "Reference");
      return `[${header}]\n${c.content ?? ""}`;
    })
    .join("\n\n---\n\n");
}

// Task 2: Cross-reference extraction
function extractCrossReferences(text: string): string[] {
  // Matches: "section 23", "Section 45A", "see section 7", "read with section 9",
  //          "under section 12", "per section 3A", "section 302-A"
  const XREF_RE = /\b(?:(?:see|read\s+with|under|per)\s+)?section\s+(\d{1,3}(?:[A-Z]{1,2}|-[A-Z]{1,2})?)/gi;
  const refs    = new Set<string>();
  for (const m of text.matchAll(XREF_RE)) {
    refs.add(m[1].toUpperCase());
  }
  return [...refs];
}

// Task 3: Graph expansion — fetches cross-referenced sections from Supabase
//
// Execution:
//   1. Build StatuteNodes from baseChunks (extract refs, amendments, repeals)
//   2. Collect unique (sectionNumber, actName) pairs not already in baseChunks
//   3. Parallel Supabase query per unique reference (one query each — O(refs))
//   4. Append results as new IracRagChunk entries (similarity = GRAPH_CHUNK_SIMILARITY)
//   5. Count amendmentLinks across ALL chunks (base + expanded)
//
// depth > 1 is reserved for future recursive expansion; currently a no-op guard.
// Deduplication: keyed on lower(act_name)|||upper(section_number).

async function expandStatuteGraph(
  baseChunks: IracRagChunk[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase:   SupabaseClient<any>,
  depth       = 1,
): Promise<GraphExpansionResult> {
  if (depth < 1) {
    return { expandedChunks: baseChunks, crossReferenceCount: 0, amendmentLinks: 0 };
  }

  // Build known-key set for deduplication
  const knownKeys = new Set<string>(
    baseChunks
      .filter((c) => c.act_name && c.section_number)
      .map((c) => `${c.act_name!.toLowerCase()}|||${c.section_number!.toUpperCase()}`)
  );

  // Build StatuteNodes and collect pending cross-reference queries
  type PendingRef = { sectionNumber: string; actName: string | null };
  const pendingRefs: PendingRef[] = [];
  const seenRefKeys = new Set<string>();

  for (const chunk of baseChunks) {
    if (!chunk.content || !chunk.act_name || !chunk.section_number) continue;

    const refs       = extractCrossReferences(chunk.content);
    const amendments = [...chunk.content.matchAll(AMEND_RE)].map((m) => m[1].trim());
    const repeals    = [...chunk.content.matchAll(REPEAL_RE)].map((m) => m[1].trim());

    // StatuteNode — built for each chunk (used internally; drives the ref query list)
    const _node: StatuteNode = {
      act_name:       chunk.act_name,
      section_number: chunk.section_number,
      references:     refs,
      amendments,
      repeals,
    };
    void _node; // consumed via pendingRefs below

    for (const ref of refs) {
      // Query within the same act when possible — "section X" in a statute
      // almost always references another section of the same statute.
      const refKey = `${chunk.act_name.toLowerCase()}|||${ref}`;
      if (knownKeys.has(refKey) || seenRefKeys.has(refKey)) continue;
      seenRefKeys.add(refKey);
      pendingRefs.push({ sectionNumber: ref, actName: chunk.act_name });
    }
  }

  if (pendingRefs.length === 0) {
    const amendmentLinks = baseChunks.filter(
      (c) => c.content && (AMEND_TEST_RE.test(c.content) || REPEAL_TEST_RE.test(c.content))
    ).length;
    return { expandedChunks: baseChunks, crossReferenceCount: 0, amendmentLinks };
  }

  // Parallel Supabase queries — one per unique (sectionNumber, actName) pair
  type DbRow = { act_name: string | null; section_number: string | null; content: string | null; file_name: string | null; year: number | null };

  const fetchedRows = await Promise.all(
    pendingRefs.map(async ({ sectionNumber, actName }): Promise<DbRow[]> => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let q: any = supabase
          .from("documents")
          .select("act_name, section_number, content, file_name, year")
          .eq("scope", "global")
          .ilike("section_number", sectionNumber);
        if (actName) q = q.ilike("act_name", actName);
        const { data } = await q.limit(2);
        return (data ?? []) as DbRow[];
      } catch {
        return [];
      }
    })
  );

  // Append new chunks, deduplicating by (act_name, section_number)
  const expandedChunks: IracRagChunk[] = [...baseChunks];
  let crossReferenceCount = 0;

  for (const rows of fetchedRows) {
    for (const row of rows) {
      if (!row.act_name || !row.section_number) continue;
      const key = `${row.act_name.toLowerCase()}|||${row.section_number.toUpperCase()}`;
      if (knownKeys.has(key)) continue;
      knownKeys.add(key);
      crossReferenceCount++;
      expandedChunks.push({
        act_name:       row.act_name,
        section_number: row.section_number,
        content:        row.content    ?? undefined,
        file_name:      row.file_name  ?? undefined,
        year:           row.year       ?? null,
        similarity:     GRAPH_CHUNK_SIMILARITY,
      });
    }
  }

  // Count amendment/repeal markers across ALL chunks (base + expanded)
  const amendmentLinks = expandedChunks.filter(
    (c) => c.content && (AMEND_TEST_RE.test(c.content) || REPEAL_TEST_RE.test(c.content))
  ).length;

  return { expandedChunks, crossReferenceCount, amendmentLinks };
}

// ── Task 2: Jurisdiction filter ──────────────────────────────────────────────
//
// Retains chunks that match the requested jurisdiction OR have no jurisdiction
// set (null = federal default, applicable everywhere).
// When jurisdiction is undefined, filtering is skipped entirely.

function filterByJurisdiction(
  chunks:        IracRagChunk[],
  jurisdiction?: string,
): { validChunks: IracRagChunk[]; filteredOutCount: number } {
  if (!jurisdiction) return { validChunks: chunks, filteredOutCount: 0 };
  const norm       = jurisdiction.toLowerCase().trim();
  const validChunks = chunks.filter(
    (c) => c.jurisdiction == null || c.jurisdiction.toLowerCase().trim() === norm
  );
  return { validChunks, filteredOutCount: chunks.length - validChunks.length };
}

// ── Task 3: Historical validity filter ────────────────────────────────────────
//
// Excludes chunks whose effective date range does not cover asOfDate.
// Null dates are treated as "always valid" — no boundary enforcement.

function filterByEffectiveDate(
  chunks:   IracRagChunk[],
  asOfDate: Date,
): { validChunks: IracRagChunk[]; excludedCount: number } {
  const t = asOfDate.getTime();
  const validChunks = chunks.filter((c) => {
    if (c.effective_from != null && t < c.effective_from.getTime()) return false;
    if (c.effective_to   != null && t > c.effective_to.getTime())   return false;
    return true;
  });
  return { validChunks, excludedCount: chunks.length - validChunks.length };
}

// ── Citation validation ───────────────────────────────────────────────────────
//
// Each citation's (act_name, section_number) is checked against the global
// documents table using ILIKE for case-insensitive matching.

async function validateCitations(
  citations: IracCitation[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase:  SupabaseClient<any>,
): Promise<ValidatedCitation[]> {
  if (citations.length === 0) return [];

  return Promise.all(
    citations.map(async (c): Promise<ValidatedCitation> => {
      try {
        const { data } = await supabase
          .from("documents")
          .select("id")
          .eq("scope", "global")
          .ilike("act_name",       c.act_name)
          .ilike("section_number", c.section_number)
          .limit(1)
          .maybeSingle();
        return { ...c, db_verified: !!data };
      } catch {
        return { ...c, db_verified: false };
      }
    })
  );
}

// ── Conflict detection ────────────────────────────────────────────────────────
//
// Statutory conflicts:
//   (a) Same section_number cited by two or more different act_names in RAG
//   (b) 4+ distinct acts in the chunk set — inherent multi-framework ambiguity

function detectStatutoryConflict(chunks: IracRagChunk[]): boolean {
  const sectionActMap = new Map<string, Set<string>>();
  for (const c of chunks) {
    if (!c.section_number) continue;
    const key = c.section_number.toUpperCase();
    if (!sectionActMap.has(key)) sectionActMap.set(key, new Set());
    if (c.act_name) sectionActMap.get(key)!.add(c.act_name);
  }
  for (const acts of sectionActMap.values()) {
    if (acts.size > 1) return true;
  }
  const distinctActs = new Set(chunks.map((c) => c.act_name).filter(Boolean));
  return distinctActs.size >= 4;
}

// ── Confidence score ──────────────────────────────────────────────────────────
//
// confidence = (valid / total) × weightedSimAvg × (1 − conflictFlag) × temporalFactor
//
// temporalFactor: 0.9 when amendment/repeal markers detected; 1.0 otherwise
// conflict drives the whole product to 0, forcing risk_level to "high"

function computeConfidence(
  validCount:     number,
  totalCount:     number,
  weightedSimAvg: number,
  conflict:       boolean,
  temporalFactor: number,
): number {
  if (totalCount === 0) return 0;
  const raw = (validCount / totalCount) * weightedSimAvg * (conflict ? 0 : 1) * temporalFactor;
  return Math.min(1, Math.max(0, raw));
}

// ── Risk level ────────────────────────────────────────────────────────────────
//
// High:     conflict, OR confidence < 0.7, OR ≤1 valid citation
// Moderate: exactly 2 valid citations, OR confidence in [0.7, 0.85)
// Low:      3+ valid citations AND confidence ≥ 0.85 AND no conflict

function computeRiskLevel(
  validCount: number,
  confidence: number,
  conflict:   boolean,
): "low" | "moderate" | "high" {
  if (conflict || confidence < 0.7 || validCount <= 1) return "high";
  if (validCount === 2 || confidence < 0.85)           return "moderate";
  return "low";
}

// ── Risk escalation ───────────────────────────────────────────────────────────
// Bumps risk one tier (low→moderate→high). Already "high" stays "high".

function escalateRisk(risk: "low" | "moderate" | "high"): "low" | "moderate" | "high" {
  if (risk === "low")      return "moderate";
  if (risk === "moderate") return "high";
  return "high";
}

// ── Task 1: Authority tier grouping ──────────────────────────────────────────
//
// Partitions chunks into four mutually exclusive authority tiers using the
// same reporter-pattern logic as chunkAuthorityWeight / isCaseLaw.
// "legislation" is the default bucket for unclassified chunks.

function groupByAuthorityTier(chunks: IracRagChunk[]): {
  supreme:     IracRagChunk[];
  high:        IracRagChunk[];
  lower:       IracRagChunk[];
  legislation: IracRagChunk[];
} {
  const result = {
    supreme:     [] as IracRagChunk[],
    high:        [] as IracRagChunk[],
    lower:       [] as IracRagChunk[],
    legislation: [] as IracRagChunk[],
  };
  for (const chunk of chunks) {
    const text = `${chunk.act_name ?? ""} ${chunk.file_name ?? ""}`;
    if      (SC_PATTERN.test(text))                              result.supreme.push(chunk);
    else if (HC_PATTERN.test(text))                              result.high.push(chunk);
    else if (PLD_PATTERN.test(text) && !LEG_PATTERN.test(text)) result.lower.push(chunk);
    else                                                         result.legislation.push(chunk);
  }
  return result;
}

// ── Task 2: Interpretation conflict detection ─────────────────────────────────
//
// Heuristic: two authority tiers conflict when their content word sets have a
// Jaccard similarity < 0.4 — i.e. they discuss materially different provisions,
// suggesting interpretive divergence rather than harmony.
//
// Jaccard(A, B) = |A ∩ B| / |A ∪ B|
// Words shorter than 4 characters are excluded to reduce noise.
// Complexity: O(T² × W) where T = tier count (≤4) and W = unique word count.

interface InterpretationConflictResult {
  contradiction:   boolean;
  tiersInConflict: string[];
}

function buildWordSet(chunks: IracRagChunk[]): Set<string> {
  const words = new Set<string>();
  for (const c of chunks) {
    if (!c.content) continue;
    for (const w of c.content.toLowerCase().split(/\W+/)) {
      if (w.length > 3) words.add(w);
    }
  }
  return words;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const w of a) { if (b.has(w)) intersection++; }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

function detectInterpretationConflict(chunks: IracRagChunk[]): InterpretationConflictResult {
  const tiers = groupByAuthorityTier(chunks);
  const entries: Array<{ name: string; words: Set<string> }> = [
    { name: "supreme",     words: buildWordSet(tiers.supreme) },
    { name: "high",        words: buildWordSet(tiers.high) },
    { name: "lower",       words: buildWordSet(tiers.lower) },
    { name: "legislation", words: buildWordSet(tiers.legislation) },
  ].filter((e) => e.words.size > 0);

  if (entries.length < 2) return { contradiction: false, tiersInConflict: [] };

  const flagged = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (jaccardSimilarity(entries[i].words, entries[j].words) < 0.4) {
        flagged.add(entries[i].name);
        flagged.add(entries[j].name);
      }
    }
  }
  return { contradiction: flagged.size > 0, tiersInConflict: [...flagged] };
}

// ── Task 3: Argument strength score ──────────────────────────────────────────
//
// Composite advocacy score: confidence × authority weight, penalised by
// contradiction, boosted by citation density. Clamped [0, 1].

function computeArgumentStrength(
  confidence:      number,
  authorityWeight: number,
  contradiction:   boolean,
  citationCount:   number,
): number {
  let base = confidence * authorityWeight;
  if (contradiction)      base *= 0.75;
  if (citationCount >= 3) base *= 1.05;
  return Math.min(1, Math.max(0, base));
}

// ── Litigation outcome probability engine ────────────────────────────────────
//
// Deterministic model — O(1), no randomness, no additional LLM calls.
// risk_band describes litigation exposure (inverse of probability):
//   very_low  ≥ 0.85  → strong position, low exposure
//   low       0.70–0.84
//   moderate  0.50–0.69
//   high      0.30–0.49
//   very_high < 0.30  → weak position, high exposure

interface LitigationProbabilityResult {
  probability: number;
  drivers:     string[];
}

function probabilityToRiskBand(
  p: number,
): "very_low" | "low" | "moderate" | "high" | "very_high" {
  if (p >= 0.85) return "very_low";
  if (p >= 0.70) return "low";
  if (p >= 0.50) return "moderate";
  if (p >= 0.30) return "high";
  return "very_high";
}

function computeLitigationProbability(params: {
  confidence:       number;
  argumentStrength: number;
  riskLevel:        "low" | "moderate" | "high";
  contradiction:    boolean;
  authorityWeight:  number;
}): LitigationProbabilityResult {
  const { confidence, argumentStrength, riskLevel, contradiction, authorityWeight } = params;
  const drivers: string[] = [];

  let base = (confidence * 0.4) + (argumentStrength * 0.6);

  if (authorityWeight < 1.0) {
    base *= 0.9;
    drivers.push("non_supreme_authority");
  }
  if (contradiction) {
    base *= 0.8;
    drivers.push("conflicting_authorities");
  }
  if (riskLevel === "high") {
    base *= 0.75;
    drivers.push("elevated_legal_risk");
  } else if (riskLevel === "moderate") {
    base *= 0.9;
  }

  return { probability: Math.min(1, Math.max(0, base)), drivers };
}

// ── Historical benchmark assessment ──────────────────────────────────────────
//
// Single batched query against the documents table.
// Assumes optional columns: outcome, authority_tier, decision_year.
// Rows with null outcome are ignored; nulls in authority_tier / decision_year
// degrade gracefully (skipped in subset calculations).
//
// Strategy (two-tier):
//   Tier 1 — benchmark_cache: single IN query on pre-aggregated table; sub-ms.
//            Returns immediately if all citations are covered.
//   Tier 2 — raw fallback: query legal_cases directly for any uncovered pairs,
//            then client-side compute. Covers newly-ingested cases not yet in
//            cache and acts with no cache entry.
// Both tiers are additive — results are merged before returning.

interface BenchmarkResult {
  comparable_case_count:     number;
  historical_success_rate:   number;
  authority_alignment_score: number;
  trend_direction?:          "favorable" | "neutral" | "unfavorable";
}

type CacheRow = {
  act_name:          string;
  section_number:    string;
  total_cases:       number | null;
  success_rate:      number | null;
  supreme_alignment: number | null;
  five_year_trend:   string | null;
};

async function computeBenchmarkAssessment(
  citations: IracCitation[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase:  SupabaseClient<any>,
): Promise<BenchmarkResult | null> {
  if (citations.length === 0) return null;

  try {
    const actNames     = [...new Set(citations.map((c) => c.act_name))];
    const citationKeys = new Set(
      citations.map((c) =>
        `${c.act_name.toLowerCase()}|||${c.section_number.toLowerCase()}`
      )
    );

    // ── Tier 1: benchmark_cache ────────────────────────────────────────────
    const { data: cacheData } = await supabase
      .from("benchmark_cache")
      .select("act_name, section_number, total_cases, success_rate, supreme_alignment, five_year_trend")
      .in("act_name", actNames);

    const cacheRows = ((cacheData ?? []) as CacheRow[]).filter(
      (r) =>
        r.section_number === "*" ||          // act-level wildcard
        citationKeys.has(
          `${r.act_name.toLowerCase()}|||${r.section_number.toLowerCase()}`
        )
    );

    // Track which citation keys were satisfied by cache
    const cachedKeys = new Set(
      cacheRows
        .filter((r) => r.section_number !== "*")
        .map((r) => `${r.act_name.toLowerCase()}|||${r.section_number.toLowerCase()}`)
    );
    const uncoveredCitations = citations.filter(
      (c) =>
        !cachedKeys.has(`${c.act_name.toLowerCase()}|||${c.section_number.toLowerCase()}`)
    );

    // ── Tier 2: raw fallback for uncovered citations ───────────────────────
    type RawRow = {
      act_name:       string | null;
      section_number: string | null;
      outcome:        string | null;
      authority_tier: string | null;
      decision_year:  number | null;
    };

    let rawRows: RawRow[] = [];
    if (uncoveredCitations.length > 0) {
      const uncoveredActs = [...new Set(uncoveredCitations.map((c) => c.act_name))];
      const uncoveredKeys = new Set(
        uncoveredCitations.map((c) =>
          `${c.act_name.toLowerCase()}|||${c.section_number.toLowerCase()}`
        )
      );
      const { data: rawData } = await supabase
        .from("legal_cases")
        .select("act_name, section_number, outcome, authority_tier, decision_year")
        .in("act_name", uncoveredActs);

      rawRows = ((rawData ?? []) as RawRow[]).filter(
        (r) =>
          r.act_name && r.section_number &&
          uncoveredKeys.has(
            `${r.act_name.toLowerCase()}|||${r.section_number.toLowerCase()}`
          ) &&
          r.outcome != null
      );
    }

    // ── Merge results ──────────────────────────────────────────────────────

    // Aggregate cache rows into totals
    let cacheTotal    = 0;
    let cacheFavSum   = 0;        // success_rate × total_cases
    let cacheSupSum   = 0;        // supreme_alignment × total_cases (approximation)
    let cacheSupCount = 0;        // rows with valid supreme_alignment
    const cacheTrends: string[] = [];

    for (const r of cacheRows) {
      const n = r.total_cases ?? 0;
      cacheTotal += n;
      if (r.success_rate != null)      cacheFavSum   += r.success_rate      * n;
      if (r.supreme_alignment != null) { cacheSupSum += r.supreme_alignment * n; cacheSupCount += n; }
      if (r.five_year_trend)           cacheTrends.push(r.five_year_trend);
    }

    // Aggregate raw rows
    const rawTotal           = rawRows.length;
    const rawFavorable       = rawRows.filter((r) => r.outcome === "favorable").length;
    const rawSupremeRows     = rawRows.filter((r) => r.authority_tier === "supreme");
    const rawFavorableSupreme = rawSupremeRows.filter((r) => r.outcome === "favorable").length;

    // 5-year trend from raw fallback rows
    let rawTrend: "favorable" | "neutral" | "unfavorable" | undefined;
    if (rawRows.length > 0) {
      const currentYear = new Date().getFullYear();
      const cutoff      = currentYear - 5;
      const recentRaw   = rawRows.filter((r) => r.decision_year != null && r.decision_year >= cutoff);
      const priorRaw    = rawRows.filter((r) => r.decision_year != null && r.decision_year <  cutoff);
      if (recentRaw.length > 0 && priorRaw.length > 0) {
        const recentRate = recentRaw.filter((r) => r.outcome === "favorable").length / recentRaw.length;
        const priorRate  = priorRaw.filter((r)  => r.outcome === "favorable").length / priorRaw.length;
        const delta      = recentRate - priorRate;
        rawTrend = delta > 0.1 ? "favorable" : delta < -0.1 ? "unfavorable" : "neutral";
      }
    }

    const totalCount = cacheTotal + rawTotal;
    if (totalCount === 0) return null;

    // Weighted success rate
    const historical_success_rate =
      (cacheFavSum + rawFavorable) / totalCount;

    // Weighted supreme alignment
    const totalSupremeWeight = cacheSupCount + rawSupremeRows.length;
    const authority_alignment_score =
      totalSupremeWeight > 0
        ? (cacheSupSum + rawFavorableSupreme) / totalSupremeWeight
        : historical_success_rate;

    // Trend consensus: merge cache trends + raw trend
    const allTrends = [...cacheTrends, ...(rawTrend ? [rawTrend] : [])];
    let trend_direction: "favorable" | "neutral" | "unfavorable" | undefined;
    if (allTrends.length > 0) {
      const favCount  = allTrends.filter((t) => t === "favorable").length;
      const unfavCount = allTrends.filter((t) => t === "unfavorable").length;
      trend_direction =
        favCount > unfavCount   ? "favorable"   :
        unfavCount > favCount   ? "unfavorable" : "neutral";
    }

    return {
      comparable_case_count:     totalCount,
      historical_success_rate:   Math.round(historical_success_rate   * 1000) / 1000,
      authority_alignment_score: Math.round(authority_alignment_score * 1000) / 1000,
      ...(trend_direction !== undefined && { trend_direction }),
    };
  } catch {
    return null;
  }
}

// ── Forum Intelligence Engine ─────────────────────────────────────────────────
//
// Advisory intelligence layer — O(1) complexity, single query per table max.
// Queries judge_analytics and forum_analytics independently; both are optional.
// No side effects; graceful null return on any DB failure.
// Does NOT touch confidence_score or risk_level.

type JudgeAnalyticsRow = {
  success_rate:     number | null;
  strictness_index: number | null;
};

type ForumAnalyticsRow = {
  overall_success_rate: number | null;
  five_year_trend:      number | null;
};

async function computeForumIntelligence(
  judgeName?: string,
  courtName?: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase?: SupabaseClient<any>,
): Promise<IracResponse["forum_intelligence"]> {
  if ((!judgeName && !courtName) || !supabase) return undefined;

  try {
    // Single parallel fetch — one query per table, both optional
    const [judgeRes, forumRes] = await Promise.all([
      judgeName
        ? supabase
            .from("judge_analytics")
            .select("success_rate, strictness_index")
            .eq("judge_name", judgeName)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      courtName
        ? supabase
            .from("forum_analytics")
            .select("overall_success_rate, five_year_trend")
            .eq("court_name", courtName)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const judgeRow = judgeRes.data as JudgeAnalyticsRow | null;
    const forumRow = forumRes.data as ForumAnalyticsRow | null;

    const result: IracResponse["forum_intelligence"] = {
      ...(judgeName  && { judge_name:  judgeName }),
      ...(courtName  && { court_name:  courtName }),
      ...(judgeRow?.success_rate     != null && { judge_success_rate:     judgeRow.success_rate }),
      ...(judgeRow?.strictness_index != null && { judge_strictness_index: judgeRow.strictness_index }),
      ...(forumRow?.overall_success_rate != null && { forum_success_rate: forumRow.overall_success_rate }),
      ...(forumRow?.five_year_trend      != null && { forum_trend:        forumRow.five_year_trend }),
    };

    // Only return if we have at least one analytic value (not just names)
    const hasData =
      result.judge_success_rate     != null ||
      result.judge_strictness_index != null ||
      result.forum_success_rate     != null ||
      result.forum_trend            != null;

    return hasData ? result : undefined;
  } catch {
    return undefined; // graceful fallback — never throws
  }
}

// ── Litigation Memo Engine ────────────────────────────────────────────────────
//
// Pure transformation layer — no LLM calls, no DB access, O(1) complexity.
// Constructs a structured litigation memorandum from existing IRAC + scoring
// signals. Only produced when prefDirectives includes "memo_mode=true".

interface LitigationMemo {
  executive_summary:      string;
  issues_identified:      string[];
  governing_authorities:  {
    primary:    string[];
    secondary?: string[];
  };
  risk_analysis: {
    risk_level:             string;
    probability_of_success: number;
    key_drivers:            string[];
  };
  strategic_considerations: string[];
  recommended_next_steps:   string[];
}

function buildLitigationMemo(params: {
  irac:             IracCore;
  riskLevel:        string;
  probability:      number;
  drivers:          string[];
  authorityTiers?:  string[];
  authorityWeight?: number;
  contradiction?:   boolean;
}): LitigationMemo {
  const {
    irac, riskLevel, probability, drivers,
    authorityTiers  = [],
    authorityWeight = 1.0,
    contradiction   = false,
  } = params;

  // executive_summary: 3–4 sentence synthesis
  const pct      = Math.round(probability * 100);
  const bandText = probabilityToRiskBand(probability).replace(/_/g, " ");
  const contraNote = contradiction
    ? " Conflicting judicial interpretations introduce additional uncertainty."
    : "";
  const executive_summary =
    `This analysis addresses the following legal question: ${irac.issue.slice(0, 200).trimEnd()}. ` +
    `${irac.conclusion} ` +
    `The estimated probability of litigation success is ${pct}% (${bandText} risk band).` +
    contraNote;

  // issues_identified: sentence-level fragments of the issue field
  const issues_identified = irac.issue
    .split(/(?<=[.;])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // governing_authorities: partition tiersPresent into primary / secondary
  const primary   = authorityTiers.filter((t) => t === "supreme" || t === "legislation");
  const secondary = authorityTiers.filter((t) => t === "high"    || t === "lower");

  // strategic_considerations: deterministic signal-driven strings
  const strategic_considerations: string[] = [];
  if (contradiction) {
    strategic_considerations.push(
      "Conflicting judicial interpretations require forum-sensitive strategy."
    );
  }
  if (probability < 0.5) {
    strategic_considerations.push("Adverse precedent risk significant.");
  }
  if (authorityWeight < 1.0) {
    strategic_considerations.push("Absence of binding Supreme Court authority.");
  }

  // recommended_next_steps: deterministic rule set
  const recommended_next_steps: string[] = [];
  if (contradiction) {
    recommended_next_steps.push("Seek clarification via higher appellate authority.");
  }
  recommended_next_steps.push("Gather factual strengthening evidence.");
  if (probability < 0.4) {
    recommended_next_steps.push("Consider settlement posture.");
  }
  if (probability >= 0.7) {
    recommended_next_steps.push("Proceed with filing.");
  }

  return {
    executive_summary,
    issues_identified,
    governing_authorities: {
      primary,
      ...(secondary.length > 0 && { secondary }),
    },
    risk_analysis: {
      risk_level:             riskLevel,
      probability_of_success: Math.round(probability * 1000) / 1000,
      key_drivers:            drivers,
    },
    strategic_considerations,
    recommended_next_steps,
  };
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function runIracPipeline(
  question:        string,
  contextText:     string,
  ragChunks:       IracRagChunk[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase:        SupabaseClient<any>,
  systemPrompt:    string,
  asOfDate?:       Date,    // defaults to today
  prefDirectives?: string,  // passed to buildIracSystemPrompt when context is enriched
  jurisdiction?:   string,  // "federal" | "punjab" | "sindh" | etc.
  judgeName?:      string,  // optional — enables judge_analytics lookup
  courtName?:      string,  // optional — enables forum_analytics lookup
): Promise<IracResult> {
  const effectiveDate = asOfDate ?? new Date();

  // ── Step 0: Graph expansion ───────────────────────────────────────────────
  // Fetches cross-referenced sections from Supabase (depth 1).
  // If new chunks are found, rebuilds the context text and system prompt so
  // the LLM sees the enriched statutory context.
  const graphResult    = await expandStatuteGraph(ragChunks, supabase);
  const enrichedChunks = graphResult.expandedChunks;

  let effectiveContextText  = contextText;
  let effectiveSystemPrompt = systemPrompt;
  if (enrichedChunks.length > ragChunks.length) {
    effectiveContextText  = buildContextText(enrichedChunks);
    effectiveSystemPrompt = buildIracSystemPrompt(effectiveContextText, prefDirectives ?? "");
  }

  // ── Step 0a: Jurisdiction filter ──────────────────────────────────────────
  const jurResult        = filterByJurisdiction(enrichedChunks, jurisdiction);
  // ── Step 0b: Effective date filter ────────────────────────────────────────
  const dateResult       = filterByEffectiveDate(jurResult.validChunks, effectiveDate);
  const scopedChunks     = dateResult.validChunks;
  const totalFilteredOut = jurResult.filteredOutCount + dateResult.excludedCount;
  const historicalMode   = asOfDate != null;

  // Rebuild context/prompt when filters removed chunks from the enriched set
  if (scopedChunks.length < enrichedChunks.length) {
    effectiveContextText  = buildContextText(scopedChunks);
    effectiveSystemPrompt = buildIracSystemPrompt(effectiveContextText, prefDirectives ?? "");
  }

  // ── Step 1: Primary IRAC call ─────────────────────────────────────────────
  let irac = await callIrac(question, effectiveContextText, effectiveSystemPrompt);
  if (!irac) {
    console.error("[IRAC failure]", { stage: "parse", message: "Primary IRAC call returned null — LLM response could not be parsed as IracResponse" });
    return { ok: false, error: "parse_failure" };
  }

  // ── Step 2: Citation validation + arbitration in parallel ─────────────────
  // Normal path (no regen): both run concurrently.
  // Net latency = max(validation_time, arbitration_time) — satisfies the
  // "1 additional call" latency constraint.
  const [rawValidated, rawArbitration] = await Promise.all([
    validateCitations(irac.citations, supabase),
    callArbitrator(irac, question),
  ]);

  let validated   = rawValidated;
  let arbitration = rawArbitration;

  // ── Step 3: Handle unverified citations — warn and continue ──────────────
  // Previously: aborted with { ok:false, error:"insufficient_corpus_support" }
  // Now: degrade confidence/risk, attach warning, and continue all advisory stages.
  const allInvalid = validated.length === 0 || validated.every((c) => !c.db_verified);
  let citationWarning: "citations_not_verified_in_corpus" | undefined;

  if (allInvalid) {
    console.warn("[IRAC warning] citations not found in corpus");
    citationWarning = "citations_not_verified_in_corpus";
    // Cap confidence and force risk to high — overrides later computations via clamp below
    irac = {
      ...irac,
      confidence_score: Math.min(irac.confidence_score, 0.4),
      risk_level:       "high",
    };
    arbitration = "unavailable"; // cannot re-arbitrate without valid corpus citations
  }

  // ── Step 4: Temporal validity check (uses scopedChunks for content scan) ───
  const temporal = checkTemporalValidity(irac.citations, scopedChunks, effectiveDate);

  // ── Step 5: Weighted similarity + conflict detection (scopedChunks) ─────────
  const simMetrics        = computeWeightedSimilarity(scopedChunks);
  const statutoryConflict = detectStatutoryConflict(scopedChunks);
  // Authority conflict (Task 2) + statutory conflict (original) are OR-combined
  const conflict = statutoryConflict || simMetrics.authorityConflict;

  // ── Step 6: Base confidence score ────────────────────────────────────────
  const validCount = validated.filter((c) => c.db_verified).length;
  const totalCount = validated.length;
  let confidence   = computeConfidence(
    validCount, totalCount, simMetrics.weightedAvg, conflict, temporal.penaltyFactor
  );

  // ── Step 6a: Graph expansion confidence bonus (Task 5) ───────────────────
  // Bonus: +0.05 when cross-references were successfully followed.
  // Suppressed: if amendment links exist AND temporal penalty is active
  // (cross-reference graph confirmed an already-flagged amendment — no extra credit).
  const canAddGraphBonus =
    graphResult.crossReferenceCount > 0 &&
    !(graphResult.amendmentLinks > 0 && temporal.penaltyFactor < 1.0);
  if (canAddGraphBonus) {
    confidence = Math.min(1, confidence + 0.05);
  }

  // ── Step 6b: Filter attrition penalty ────────────────────────────────────
  // If jurisdiction or date filters removed >50% of the enriched chunk set,
  // reduce confidence by 10% — corpus coverage after scoping may be thin.
  if (enrichedChunks.length > 0 && totalFilteredOut / enrichedChunks.length > 0.5) {
    confidence = Math.max(0, confidence * 0.9);
  }

  // ── Step 7: Arbitration adjustment ───────────────────────────────────────
  let risk_level = computeRiskLevel(validCount, confidence, conflict);

  let arbitration_flag:   boolean | "unavailable" | undefined;
  let arbitration_reason: string | undefined;

  if (arbitration === "unavailable") {
    arbitration_flag = "unavailable";
  } else if (arbitration.verdict === "disagree") {
    confidence       = Math.max(0, confidence * 0.75);  // −25%
    risk_level       = escalateRisk(risk_level);
    arbitration_flag   = true;
    arbitration_reason = arbitration.reason;
  }
  // "agree": no penalty; omit arbitration_flag from response entirely

  // ── Step 7b: Contradiction detection + argument strength ─────────────────
  // Task 4: escalate risk one tier when interpretive contradiction found.
  const conflictResult   = detectInterpretationConflict(scopedChunks);
  const argumentStrength = computeArgumentStrength(
    confidence,
    simMetrics.highestWeight,
    conflictResult.contradiction,
    validCount,
  );
  if (conflictResult.contradiction) {
    risk_level = escalateRisk(risk_level);
  }

  // Collect non-empty authority tiers for response metadata
  const tierGroups   = groupByAuthorityTier(scopedChunks);
  const tiersPresent = (["supreme", "high", "lower", "legislation"] as const).filter(
    (t) => tierGroups[t].length > 0
  );
  const multiTier = tiersPresent.length > 1;

  // ── Step 7c: Litigation outcome probability ───────────────────────────────
  const litigationResult = computeLitigationProbability({
    confidence,
    argumentStrength,
    riskLevel:       risk_level,
    contradiction:   conflictResult.contradiction,
    authorityWeight: simMetrics.highestWeight,
  });

  // ── Step 8: Assemble response ────────────────────────────────────────────
  const cleanCitations: IracCitation[] = validated.map((vc) => ({
    act_name:       vc.act_name,
    section_number: vc.section_number,
    excerpt:        vc.excerpt,
  }));

  const response: IracResponse = {
    ...irac,
    rule:             formatParagraphs(irac.rule + temporal.ruleSuffix),
    application:      formatParagraphs(irac.application),
    conclusion:       formatParagraphs(irac.conclusion),
    citations:        cleanCitations,
    confidence_score: Math.round((citationWarning ? Math.min(confidence, 0.4) : confidence) * 1000) / 1000,
    risk_level:       citationWarning ? "high" : risk_level,
    // Optional extended fields — only included when meaningful
    ...(citationWarning    !== undefined && { citation_warning: citationWarning }),
    ...(arbitration_flag   !== undefined && { arbitration_flag }),
    ...(arbitration_reason               && { arbitration_reason }),
    ...(simMetrics.hasCaseLaw            && { precedent_weight: simMetrics.highestWeight }),
    ...(temporal.flags.length > 0        && { temporal_flags: temporal.flags }),
    // Task 6: graph_expansion — included only when at least one metric is non-zero
    ...((graphResult.crossReferenceCount > 0 || graphResult.amendmentLinks > 0) && {
      graph_expansion: {
        cross_references_followed: graphResult.crossReferenceCount,
        amendment_links_detected:  graphResult.amendmentLinks,
      },
    }),
    // Task 5: jurisdiction / historical — included only when filters were active
    ...(jurisdiction   && { jurisdiction_applied: jurisdiction }),
    ...(historicalMode && { historical_mode: true }),
    // Contradiction detection + argument strength — included when multi-tier or contradiction
    ...((conflictResult.contradiction || multiTier) && {
      argument_strength:       Math.round(argumentStrength * 1000) / 1000,
      authority_tiers_present: tiersPresent,
    }),
    ...(conflictResult.contradiction && { contradiction_detected: true }),
    // Litigation assessment — included when argument/contradiction signals are present
    ...((conflictResult.contradiction || multiTier) && {
      litigation_assessment: {
        success_probability: Math.round(litigationResult.probability * 1000) / 1000,
        risk_band:           probabilityToRiskBand(litigationResult.probability),
        drivers:             litigationResult.drivers,
      },
    }),
  };

  // ── Audit reasoning trace (Task 3: only when audit_mode=true in prefDirectives) ──
  if (prefDirectives?.includes("audit_mode=true")) {
    const arbitrationStatus: "agree" | "disagree" | "unavailable" =
      arbitration === "unavailable" ? "unavailable" : arbitration.verdict;
    const arbitrationReason =
      arbitration !== "unavailable" && arbitration.verdict === "disagree"
        ? arbitration.reason
        : undefined;

    response.reasoning_trace = {
      retrieval_summary: {
        total_chunks:          ragChunks.length,
        after_graph_expansion: enrichedChunks.length,
        ...(jurResult.filteredOutCount > 0  && { after_jurisdiction_filter: jurResult.validChunks.length }),
        ...(dateResult.excludedCount   > 0  && { after_date_filter:         dateResult.validChunks.length }),
      },
      authority_analysis: {
        tiers_present:          tiersPresent,
        highest_weight:         simMetrics.highestWeight,
        contradiction_detected: conflictResult.contradiction,
      },
      arbitration: {
        status: arbitrationStatus,
        ...(arbitrationReason && { reason: arbitrationReason }),
      },
      ...(temporal.flags.length > 0 && {
        temporal_analysis: {
          amendment_detected: true,
          notes:              temporal.flags,
        },
      }),
      ...((graphResult.crossReferenceCount > 0 || graphResult.amendmentLinks > 0) && {
        graph_analysis: {
          cross_references_followed: graphResult.crossReferenceCount,
          amendment_links_detected:  graphResult.amendmentLinks,
        },
      }),
    };
  }

  // ── Litigation memo (only when memo_mode=true in prefDirectives) ──────────
  if (prefDirectives?.includes("memo_mode=true")) {
    response.litigation_memo = buildLitigationMemo({
      irac,
      riskLevel:       risk_level,
      probability:     litigationResult.probability,
      drivers:         litigationResult.drivers,
      authorityTiers:  tiersPresent,
      authorityWeight: simMetrics.highestWeight,
      contradiction:   conflictResult.contradiction,
    });
  }

  // ── Step 8c: Historical benchmark assessment ──────────────────────────────
  // Single additional Supabase query. Runs after all confidence/risk calculations
  // to avoid influencing them. Only litigation_assessment.success_probability
  // is adjusted — confidence_score and risk_level are left untouched.
  const benchmarkResult = await computeBenchmarkAssessment(cleanCitations, supabase);
  if (benchmarkResult && benchmarkResult.comparable_case_count > 0) {
    // Task 3: adjust litigation probability using historical signal
    if (response.litigation_assessment) {
      let adjProb = response.litigation_assessment.success_probability;
      if      (benchmarkResult.historical_success_rate < 0.4) adjProb *= 0.9;
      else if (benchmarkResult.historical_success_rate > 0.7) adjProb *= 1.05;
      adjProb = Math.min(1, Math.max(0, adjProb));
      response.litigation_assessment = {
        ...response.litigation_assessment,
        success_probability: Math.round(adjProb * 1000) / 1000,
        risk_band:           probabilityToRiskBand(adjProb),
      };
    }
    response.benchmark_assessment = {
      comparable_case_count:     benchmarkResult.comparable_case_count,
      historical_success_rate:   benchmarkResult.historical_success_rate,
      authority_alignment_score: benchmarkResult.authority_alignment_score,
      ...(benchmarkResult.trend_direction !== undefined && {
        trend_direction: benchmarkResult.trend_direction,
      }),
    };
  }

  // ── Step 8d: Forum & judge intelligence ──────────────────────────────────
  // Advisory only — single parallel query per table, O(1). Runs last so all
  // prior scoring (confidence, risk, benchmark) is already finalised.
  // Only litigation_assessment.success_probability is adjusted (Task 5);
  // confidence_score and risk_level are never touched here.
  const forumIntelligence = await computeForumIntelligence(judgeName, courtName, supabase);
  if (forumIntelligence) {
    response.forum_intelligence = forumIntelligence;

    if (response.litigation_assessment) {
      let adjProb = response.litigation_assessment.success_probability;

      // Judge strictness penalty: strict judges (>60% unfavorable) reduce probability by 5%
      if (
        forumIntelligence.judge_strictness_index !== undefined &&
        forumIntelligence.judge_strictness_index > 0.6
      ) {
        adjProb *= 0.95;
      }

      // Forum advantage bonus: if forum success rate exceeds national rate by >10%, +3%
      // National rate proxy: benchmark historical_success_rate, fallback to 0.5
      const nationalRate = benchmarkResult?.historical_success_rate ?? 0.5;
      if (
        forumIntelligence.forum_success_rate !== undefined &&
        forumIntelligence.forum_success_rate - nationalRate > 0.1
      ) {
        adjProb *= 1.03;
      }

      adjProb = Math.min(1, Math.max(0, adjProb));
      response.litigation_assessment = {
        ...response.litigation_assessment,
        success_probability: Math.round(adjProb * 1000) / 1000,
        risk_band:           probabilityToRiskBand(adjProb),
      };
    }
  }

  // ── Steps 8e + 8g: Precedent network + doctrine analysis ─────────────────
  // precedentCaseIds is hoisted so Step 8g can reuse the ANN results from
  // Step 8e without a second embedding call.
  let precedentCaseIds: string[] = [];

  // ── Step 8e: Precedent network intelligence ───────────────────────────────
  // 1. Embed the question (reuses existing embedding service — no new dependency).
  // 2. findSimilarCases → top-5 ANN hits from precedent_nodes.
  // 3. analyzePrecedentStrength → 2 DB queries max (edges + node tiers).
  // 4. Attach precedent_intelligence.
  // Only litigation_assessment.success_probability is adjusted — never confidence/risk.
  try {
    const questionEmbedding = await embedText(question);
    const similarCases      = await findSimilarCases(questionEmbedding, supabase, 5);

    if (similarCases.length > 0) {
      precedentCaseIds      = similarCases.map((c) => c.case_id);
      const strength        = await analyzePrecedentStrength(precedentCaseIds, supabase);

      response.precedent_intelligence = {
        precedent_strength_score: strength.precedent_strength_score,
        incoming_citations:       strength.incoming_citations,
        doctrine_instability:     strength.doctrine_instability,
        similar_cases: similarCases.map((c) => ({
          case_title:     c.case_title,
          authority_tier: c.authority_tier,
          decision_year:  c.decision_year,
          similarity:     c.similarity,
        })),
      };

      // Doctrine instability penalty: −10% on success_probability only
      if (strength.doctrine_instability && response.litigation_assessment) {
        const adjProb = Math.min(
          1,
          Math.max(0, response.litigation_assessment.success_probability * 0.9),
        );
        response.litigation_assessment = {
          ...response.litigation_assessment,
          success_probability: Math.round(adjProb * 1000) / 1000,
          risk_band:           probabilityToRiskBand(adjProb),
        };
      }
    }
  } catch {
    // Graceful degradation — precedent graph tables may be empty on fresh deploy
  }

  // ── Step 8f: Strategy simulation ─────────────────────────────────────────
  // Pure deterministic math — no DB queries, no LLM calls, O(1).
  // Requires at least litigation_assessment to be present.
  // All inputs gracefully default to neutral values if upstream steps were skipped.
  if (response.litigation_assessment) {
    const simResult = simulateStrategies({
      baseProbability:      response.litigation_assessment.success_probability,
      riskLevel:            response.risk_level,
      precedentStrength:    response.precedent_intelligence?.precedent_strength_score  ?? 0,
      doctrineInstability:  response.precedent_intelligence?.doctrine_instability      ?? false,
      judgeStrictness:      response.forum_intelligence?.judge_strictness_index        ?? 0,
      forumSuccessRate:     response.forum_intelligence?.forum_success_rate            ?? 0,
      benchmarkSuccessRate: response.benchmark_assessment?.historical_success_rate     ?? 0.5,
    });
    response.strategy_simulation = simResult;
  }

  // ── Step 8g: Doctrine stability analysis ─────────────────────────────────
  // Reuses precedentCaseIds from Step 8e — no extra embedding call.
  // Max 2 DB queries inside analyzeDoctrine. Graceful null if graph empty.
  // Only litigation_assessment.success_probability is adjusted; never confidence/risk.
  if (precedentCaseIds.length > 0) {
    try {
      const docResult = await analyzeDoctrine(precedentCaseIds, supabase);
      if (docResult) {
        response.doctrine_analysis = docResult;

        if (response.litigation_assessment) {
          let adjProb = response.litigation_assessment.success_probability;
          if (docResult.doctrine_stability === "unstable") {
            adjProb *= 0.9;
          } else if (docResult.doctrine_stability === "stable") {
            adjProb *= 1.02;
          }
          adjProb = Math.min(1, Math.max(0, adjProb));
          response.litigation_assessment = {
            ...response.litigation_assessment,
            success_probability: Math.round(adjProb * 1000) / 1000,
            risk_band:           probabilityToRiskBand(adjProb),
          };
        }
      }
    } catch {
      // Graceful degradation
    }
  }

  // ── Step 8h: Knowledge graph insight ─────────────────────────────────────
  // Purely advisory — no probability or risk adjustments.
  // Max 2 DB queries inside queryKnowledgeGraphInsight.
  // Uses the same cleanCitations built in Step 8.
  if (cleanCitations.length > 0) {
    try {
      const sectionNames = cleanCitations.map(
        (c) => `${c.act_name}:::${c.section_number}`,
      );
      const graphInsight = await queryKnowledgeGraphInsight(sectionNames, supabase);
      if (graphInsight) {
        response.knowledge_graph_insight = graphInsight;
      }
    } catch {
      // Graceful degradation
    }
  }

  // ── Step 8i: Doctrine influence analysis ─────────────────────────────────
  // Purely advisory — no probability or risk adjustments.
  // Max 2 DB queries inside analyzeDoctrineInfluence.
  // Reuses precedentCaseIds hoisted from Step 8e.
  if (precedentCaseIds.length > 0) {
    try {
      const influenceResult = await analyzeDoctrineInfluence(precedentCaseIds, supabase);
      if (influenceResult) {
        response.doctrine_influence = influenceResult;
      }
    } catch {
      // Graceful degradation
    }
  }

  // ── Step 8j: Litigation brief generation ─────────────────────────────────
  // Pure deterministic aggregation — no DB queries, no LLM calls, O(1).
  // Synthesises all available intelligence layers (Steps 8c–8i) into a
  // structured brief. Always produced when a valid IRAC response exists;
  // absent layers degrade gracefully to sensible fallbacks.
  try {
    response.litigation_brief = generateLitigationBrief({
      issue:                   irac.issue,
      conclusion:              irac.conclusion,
      citations:               cleanCitations,
      risk_level:              response.risk_level,
      litigation_assessment:   response.litigation_assessment,
      doctrine_analysis:       response.doctrine_analysis,
      doctrine_influence:      response.doctrine_influence,
      benchmark_assessment:    response.benchmark_assessment,
      forum_intelligence:      response.forum_intelligence,
      strategy_simulation:     response.strategy_simulation,
      precedent_intelligence:  response.precedent_intelligence,
    });
  } catch {
    // Graceful degradation — brief is advisory and must never block the response
  }

  // ── Step 8k: Legal argument structure ────────────────────────────────────
  // Pure transformation — no DB queries, no LLM calls, O(1).
  // Synthesises IRAC core + precedent/doctrine signals into a structured
  // argument. Purely additive: never touches confidence_score or risk_level.
  try {
    response.argument_structure = buildArgumentStructure({
      issue:                   irac.issue,
      rule:                    irac.rule,
      application:             irac.application,
      conclusion:              irac.conclusion,
      citations:               cleanCitations,
      doctrine_analysis:       response.doctrine_analysis,
      doctrine_influence:      response.doctrine_influence,
      precedent_intelligence:  response.precedent_intelligence,
      knowledge_graph_insight: response.knowledge_graph_insight,
    });
  } catch {
    // Graceful degradation — argument structure is advisory; must never block the response
  }

  return { ok: true, data: response };
}
