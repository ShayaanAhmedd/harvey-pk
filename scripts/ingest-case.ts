/**
 * ingest-case.ts — Continuous Court Intelligence ingestion pipeline
 *
 * Ingests a court decision (plain text or PDF), extracts structured metadata
 * via pure regex (no LLM), deduplicates by SHA-256 hash, embeds the full text,
 * inserts into `legal_cases`, and incrementally updates `benchmark_cache`.
 *
 * Usage:
 *   npx ts-node scripts/ingest-case.ts \
 *     --file "data/2023-sc-100.txt" \
 *     --title "Appellant v. State" \   # optional override
 *     --year 2023                       # optional override
 *
 * Required env vars (in .env.local):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_KEY    (bypasses RLS — server-side only)
 *   OPENAI_API_KEY
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { validateEnvironment } from "../lib/utils/env-validator";
import { detectGatewayError } from "../lib/utils/network-errors";

// ── Env ───────────────────────────────────────────────────────────────────────

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

// Validate all required environment variables before any API client is created.
try {
  validateEnvironment();
} catch (err) {
  console.error("❌ ", err instanceof Error ? err.message : err);
  process.exit(1);
}

const SUPABASE_URL        = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !OPENAI_API_KEY) {
  console.error("❌  Missing required env vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENAI_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY });

// ── Authority classification ──────────────────────────────────────────────────
// Mirrors the constants in lib/ai/irac.ts — kept inline so this script has
// zero runtime dependency on Next.js modules.

const SC_PATTERN  = /\b(?:SCMR|SCJ|Supreme\s+Court|SC\b)/i;
const HC_PATTERN  = /\b(?:PCrLJ|CLC|MLD|PLJ|High\s+Court|HC\b)/i;
const LEG_PATTERN = /\b(?:Act|Ordinance|Rules?|Code|Regulation)\b/i;

/**
 * Classifies the authority tier of a court decision from its text.
 * Returns "supreme" | "high" | "lower" | "legislation".
 * Pure regex — no LLM.
 */
export function classifyAuthority(
  text: string,
): "supreme" | "high" | "lower" | "legislation" {
  if (SC_PATTERN.test(text))  return "supreme";
  if (HC_PATTERN.test(text))  return "high";
  if (LEG_PATTERN.test(text)) return "legislation";
  return "lower";
}

// ── Text extraction ───────────────────────────────────────────────────────────

async function extractText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") {
    // Dynamic require to avoid ENOENT at module init
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
    const buf = fs.readFileSync(filePath);
    const result = await pdfParse(buf);
    return result.text;
  }
  return fs.readFileSync(filePath, "utf-8");
}

// ── Normalisation + hashing ───────────────────────────────────────────────────

function normaliseText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")       // CRLF → LF
    .replace(/\r/g,   "\n")
    .replace(/[ \t]+/g, " ")      // collapse horizontal whitespace
    .replace(/\n{3,}/g, "\n\n")   // max two blank lines
    .trim();
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// ── Metadata extraction ───────────────────────────────────────────────────────
// All extraction is pure regex. parse_confidence is the fraction of optional
// fields successfully extracted (0 = none, 1 = all).

interface ExtractedMeta {
  case_title:      string | null;
  act_names:       string[];        // may be multiple
  sections:        string[];
  authority_tier:  "supreme" | "high" | "lower" | "legislation";
  court_name:      string | null;
  judge_name:      string | null;
  decision_year:   number | null;
  outcome:         "favorable" | "unfavorable" | "neutral" | "mixed" | "unknown";
  citation_count:  number;
  parse_confidence: number;         // 0.000 – 1.000
}

// Patterns for Pakistani law
const CASE_TITLE_RE = /^(.{10,120})\s*(?:v\.?|versus)\s*(.{3,80})/im;
const JUDGE_RE      = /(?:Justice|Hon(?:ourable)?\.?|J\.)\s+([A-Z][a-zA-Z\s.]{2,40})/;
const YEAR_RE       = /\b(19[6-9]\d|20[0-3]\d)\b/g;
const SECTION_RE    = /\bsection\s+(\d{1,3}[A-Za-z]?(?:-[A-Za-z])?)/gi;
const COURT_RE      = /\b(Supreme\s+Court|High\s+Court|Sessions?\s+Court|Magistrate(?:'s)?\s+Court|Federal\s+Shariat\s+Court)\b/i;
const CITATION_RE   = /\b(?:PLD|SCMR|PCrLJ|CLC|MLD|PLJ|SCJ)\s+\d{4}\b/gi;
const ACT_EXTRACT_RE = /\b([A-Z][A-Za-z\s]{3,50}(?:Act|Ordinance|Code|Rules?|Regulation))\s+(?:of\s+)?\d{4}\b/g;

// Outcome keywords — scoped to the last 20% of text (conclusion section)
const FAVORABLE_RE   = /\b(?:allowed|granted|upheld|succeeded|in\s+favour\s+of\s+(?:the\s+)?(?:petitioner|appellant|plaintiff))\b/i;
const UNFAVORABLE_RE = /\b(?:dismissed|rejected|denied|failed|in\s+favour\s+of\s+(?:the\s+)?(?:respondent|defendant|state))\b/i;
const MIXED_RE       = /\b(?:partly\s+allowed|partially\s+(?:allowed|granted)|remanded)\b/i;

function detectOutcome(
  text: string,
): "favorable" | "unfavorable" | "neutral" | "mixed" | "unknown" {
  // Focus on conclusion (last ~25% of document for efficiency)
  const tail = text.slice(Math.max(0, text.length - Math.floor(text.length * 0.25)));
  if (MIXED_RE.test(tail))       return "mixed";
  if (FAVORABLE_RE.test(tail))   return "favorable";
  if (UNFAVORABLE_RE.test(tail)) return "unfavorable";
  // Broaden to full text if no signal in tail
  if (MIXED_RE.test(text))       return "mixed";
  if (FAVORABLE_RE.test(text))   return "favorable";
  if (UNFAVORABLE_RE.test(text)) return "unfavorable";
  return "unknown";
}

function extractYears(text: string): number[] {
  const years: number[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(YEAR_RE.source, "g");
  while ((m = re.exec(text)) !== null) years.push(parseInt(m[1], 10));
  return years;
}

function extractMeta(text: string): ExtractedMeta {
  // Case title
  const titleMatch = CASE_TITLE_RE.exec(text);
  const case_title = titleMatch
    ? `${titleMatch[1].trim()} v. ${titleMatch[2].trim()}`
    : null;

  // Acts
  const actSet = new Set<string>();
  let am: RegExpExecArray | null;
  const actRe = new RegExp(ACT_EXTRACT_RE.source, "g");
  while ((am = actRe.exec(text)) !== null) actSet.add(am[1].trim());
  const act_names = [...actSet];

  // Sections
  const sectionSet = new Set<string>();
  let sm: RegExpExecArray | null;
  const sRe = new RegExp(SECTION_RE.source, "gi");
  while ((sm = sRe.exec(text)) !== null) sectionSet.add(sm[1]);
  const sections = [...sectionSet];

  // Authority
  const authority_tier = classifyAuthority(text);

  // Court name
  const courtMatch = COURT_RE.exec(text);
  const court_name = courtMatch ? courtMatch[1] : null;

  // Judge
  const judgeMatch = JUDGE_RE.exec(text);
  const judge_name = judgeMatch ? judgeMatch[1].trim() : null;

  // Decision year (most frequent year in text, biased toward recency)
  const years = extractYears(text);
  const yearFreq: Record<number, number> = {};
  for (const y of years) yearFreq[y] = (yearFreq[y] ?? 0) + 1;
  const sortedYears = Object.entries(yearFreq)
    .sort((a, b) => b[1] - a[1] || parseInt(b[0]) - parseInt(a[0]));
  const decision_year = sortedYears.length > 0 ? parseInt(sortedYears[0][0]) : null;

  // Outcome
  const outcome = detectOutcome(text);

  // Citation count
  const citations = text.match(CITATION_RE) ?? [];
  const citation_count = citations.length;

  // parse_confidence: fraction of optional fields extracted (5 optional: title, act, judge, year, court)
  const fieldHits = [case_title, act_names[0] ?? null, judge_name, decision_year, court_name]
    .filter(Boolean).length;
  const parse_confidence = Math.round((fieldHits / 5) * 1000) / 1000;

  return {
    case_title, act_names, sections, authority_tier, court_name,
    judge_name, decision_year, outcome, citation_count, parse_confidence,
  };
}

// ── Case citation extraction ──────────────────────────────────────────────────
// Pure regex — no LLM. Returns deduplicated citation strings.
// Patterns cover: case names, PLD, SCMR, CLC reporter citations.

const CASE_NAME_CITE_RE = /[A-Z][a-z]+\s+v\.\s+[A-Z][a-z]+/g;
const PLD_CITE_RE       = /\bPLD\s+\d{4}\s+[A-Z]+\s+\d+/g;
const SCMR_CITE_RE      = /\b\d{4}\s+SCMR\s+\d+/g;
const CLC_CITE_RE       = /\b\d{4}\s+CLC\s+\d+/g;

export function extractCaseCitations(text: string): string[] {
  const found = new Set<string>();
  for (const re of [CASE_NAME_CITE_RE, PLD_CITE_RE, SCMR_CITE_RE, CLC_CITE_RE]) {
    const matches = text.match(new RegExp(re.source, re.flags)) ?? [];
    for (const m of matches) found.add(m.trim());
  }
  return [...found];
}

// ── Precedent graph helpers ───────────────────────────────────────────────────

async function insertPrecedentNode(
  caseId:        string,
  case_title:    string | null,
  decision_year: number | null,
  authority_tier: string,
  court_name:    string | null,
  embedding:     number[],
): Promise<void> {
  await supabase.from("precedent_nodes").upsert(
    {
      case_id:        caseId,
      case_title,
      decision_year,
      authority_tier,
      court_name,
      embedding,
    },
    { onConflict: "case_id" },
  );
}

// Returns the list of matched cited case IDs so knowledge graph can reuse them.
async function insertPrecedentEdges(
  fromCaseId:    string,
  caseCitations: string[],
): Promise<string[]> {
  if (caseCitations.length === 0) return [];

  // Batch-match candidate nodes by case_title — name-pattern citations only
  // (reporter-style citations like "PLD 2019 SC 45" won't match case_title)
  const nameCites = caseCitations.filter((c) => /v\./.test(c));
  if (nameCites.length === 0) return [];

  // Build OR filter: case_title ilike %cite% for each name citation
  const orFilter = nameCites.map((c) => `case_title.ilike.%${c}%`).join(",");

  const { data } = await supabase
    .from("precedent_nodes")
    .select("case_id, case_title")
    .or(orFilter);

  if (!data || data.length === 0) return [];

  // Insert edges — UNIQUE constraint (from, to, relation_type) handles idempotency
  const matched = (data as { case_id: string }[]).filter((n) => n.case_id !== fromCaseId);
  const edges   = matched.map((n) => ({
    from_case_id:  fromCaseId,
    to_case_id:    n.case_id,
    relation_type: "cites",
    weight:        1.0,
  }));

  if (edges.length > 0) {
    await supabase
      .from("precedent_edges")
      .upsert(edges, { onConflict: "from_case_id,to_case_id,relation_type", ignoreDuplicates: true });
  }

  return matched.map((n) => n.case_id);
}

// ── Knowledge graph population ────────────────────────────────────────────────
// Populates legal_entities + legal_relationships for a newly inserted case.
// Strategy: 2 upsert queries (case entity by ID; all others by entity_type+name)
//           + 1 relationship insert = 3 queries total.

type EntityRow = { id: string; entity_type: string; name: string };

async function insertKnowledgeGraph(params: {
  caseId:        string;
  caseTitle:     string | null;
  authorityTier: string;
  judgeName:     string | null;
  courtName:     string | null;
  actNames:      string[];
  sections:      string[];      // section numbers
  primaryAct:    string | null; // for section → act mapping
  citedCaseIds:  string[];      // from precedent edge insertion
}): Promise<void> {
  const {
    caseId, caseTitle, authorityTier, judgeName, courtName,
    actNames, sections, primaryAct, citedCaseIds,
  } = params;

  // ── Q1: upsert case entity using legal_cases.id as entity ID ─────────────
  await supabase
    .from("legal_entities")
    .upsert(
      {
        id:          caseId,
        entity_type: "case",
        name:        caseTitle ?? `Case ${caseId.slice(0, 8)}`,
        metadata:    { authority_tier: authorityTier, court_name: courtName },
      },
      { onConflict: "id" },
    );

  // ── Q2: upsert all non-case entities (judge, court, acts, sections) ───────
  const otherEntities: { entity_type: string; name: string; metadata: object }[] = [];

  if (judgeName) {
    otherEntities.push({ entity_type: "judge", name: judgeName, metadata: { court_name: courtName } });
  }
  if (courtName) {
    otherEntities.push({ entity_type: "court", name: courtName, metadata: {} });
  }
  for (const act of actNames) {
    otherEntities.push({ entity_type: "act", name: act, metadata: {} });
  }
  for (const sec of sections) {
    const compoundName = primaryAct ? `${primaryAct}:::${sec}` : sec;
    otherEntities.push({
      entity_type: "section",
      name:        compoundName,
      metadata:    { act_name: primaryAct ?? null, section_number: sec },
    });
  }

  if (otherEntities.length === 0 && citedCaseIds.length === 0) return;

  let idMap: Map<string, string> = new Map(); // "entity_type:::name" → id

  if (otherEntities.length > 0) {
    const { data: upserted } = await supabase
      .from("legal_entities")
      .upsert(otherEntities, { onConflict: "entity_type,name" })
      .select("id, entity_type, name");

    if (upserted) {
      for (const row of upserted as EntityRow[]) {
        idMap.set(`${row.entity_type}:::${row.name}`, row.id);
      }
    }
  }

  // ── Q3: batch insert relationships ────────────────────────────────────────
  const rels: { from_entity: string; to_entity: string; relationship_type: string; weight: number }[] = [];

  const judgeId  = judgeName  ? idMap.get(`judge:::${judgeName}`)  : undefined;
  const courtId  = courtName  ? idMap.get(`court:::${courtName}`)  : undefined;

  if (judgeId) {
    rels.push({ from_entity: caseId, to_entity: judgeId, relationship_type: "decided_by", weight: 1.0 });
  }
  if (courtId) {
    rels.push({ from_entity: caseId, to_entity: courtId, relationship_type: "heard_in", weight: 1.0 });
  }

  // case → section (interprets) + section → act (contains)
  for (const sec of sections) {
    const compoundName = primaryAct ? `${primaryAct}:::${sec}` : sec;
    const sectionId    = idMap.get(`section:::${compoundName}`);
    const actId        = primaryAct ? idMap.get(`act:::${primaryAct}`) : undefined;

    if (sectionId) {
      rels.push({ from_entity: caseId,     to_entity: sectionId, relationship_type: "interprets", weight: 1.0 });
    }
    if (sectionId && actId) {
      rels.push({ from_entity: sectionId, to_entity: actId,      relationship_type: "contains",   weight: 1.0 });
    }
  }

  // case → cited cases (cites) — reuses IDs from precedent edge insertion
  for (const citedId of citedCaseIds) {
    rels.push({ from_entity: caseId, to_entity: citedId, relationship_type: "cites", weight: 1.0 });
  }

  if (rels.length > 0) {
    await supabase
      .from("legal_relationships")
      .upsert(rels, { onConflict: "from_entity,to_entity,relationship_type", ignoreDuplicates: true });
  }
}

// ── Judge analytics update ────────────────────────────────────────────────────
// Incremental upsert — reads current row and adjusts counters by +1.
// act_specialization JSONB stores fractions (act_count / total_cases).
// O(2 queries): one SELECT + one UPSERT.

type JudgeRow = {
  total_cases:        number;
  favorable_count:    number;
  unfavorable_count:  number;
  act_specialization: Record<string, number>;
};

export async function updateJudgeAnalytics(
  judge_name: string,
  court_name: string | null,
  act_name:   string | null,
  outcome:    string,
): Promise<void> {
  if (!judge_name) return;

  const { data: existing } = await supabase
    .from("judge_analytics")
    .select("total_cases, favorable_count, unfavorable_count, act_specialization")
    .eq("judge_name", judge_name)
    .maybeSingle();

  const prev = (existing ?? {
    total_cases: 0, favorable_count: 0, unfavorable_count: 0, act_specialization: {},
  }) as JudgeRow;

  const newTotal     = prev.total_cases       + 1;
  const newFavorable = prev.favorable_count   + (outcome === "favorable"   ? 1 : 0);
  const newUnfav     = prev.unfavorable_count + (outcome === "unfavorable" ? 1 : 0);

  // act_specialization: back-calculate count, increment, recompute fraction
  const actSpec: Record<string, number> = { ...prev.act_specialization };
  if (act_name) {
    const oldFraction = actSpec[act_name] ?? 0;
    const oldCount    = Math.round(oldFraction * prev.total_cases);
    const newCount    = oldCount + 1;
    actSpec[act_name] = newTotal > 0 ? Math.round((newCount / newTotal) * 10000) / 10000 : 0;
    // Recalibrate all other act fractions against new total
    for (const key of Object.keys(actSpec)) {
      if (key === act_name) continue;
      const oldFrac  = actSpec[key] ?? 0;
      const cnt      = Math.round(oldFrac * prev.total_cases);
      actSpec[key]   = newTotal > 0 ? Math.round((cnt / newTotal) * 10000) / 10000 : 0;
    }
  }

  await supabase.from("judge_analytics").upsert(
    {
      judge_name,
      ...(court_name && { court_name }),
      total_cases:       newTotal,
      favorable_count:   newFavorable,
      unfavorable_count: newUnfav,
      success_rate:      newTotal > 0 ? Math.round((newFavorable / newTotal) * 10000) / 10000 : null,
      strictness_index:  newTotal > 0 ? Math.round((newUnfav    / newTotal) * 10000) / 10000 : null,
      act_specialization: actSpec,
      last_updated:      new Date().toISOString(),
    },
    { onConflict: "judge_name" },
  );
}

// ── Forum analytics update ────────────────────────────────────────────────────
// Single query to legal_cases filtered by court_name → recompute all stats.
// Called once per inserted case. O(1 SELECT from legal_cases + 1 UPSERT).

type ForumCaseRow = {
  outcome:        string | null;
  authority_tier: string | null;
  decision_year:  number | null;
  created_at:     string | null;
};

export async function updateForumAnalytics(court_name: string | null): Promise<void> {
  if (!court_name) return;

  const { data, error } = await supabase
    .from("legal_cases")
    .select("outcome, authority_tier, decision_year, created_at")
    .eq("court_name", court_name);

  if (error || !data || data.length === 0) return;

  const rows  = data as ForumCaseRow[];
  const total = rows.length;

  const favorable         = rows.filter((r) => r.outcome === "favorable").length;
  const overall_success   = Math.round((favorable / total) * 10000) / 10000;

  // Supreme alignment: favorable SC decisions / total SC decisions in this court
  const scRows            = rows.filter((r) => r.authority_tier === "supreme");
  const scFavorable       = scRows.filter((r) => r.outcome === "favorable").length;
  const supreme_alignment = scRows.length > 0
    ? Math.round((scFavorable / scRows.length) * 10000) / 10000
    : null;

  // 5-year trend: delta between recent and prior success rates
  const currentYear   = new Date().getFullYear();
  const cutoff        = currentYear - 5;
  const recentRows    = rows.filter((r) => r.decision_year != null && r.decision_year >= cutoff);
  const priorRows     = rows.filter((r) => r.decision_year != null && r.decision_year <  cutoff);
  let five_year_trend: number | null = null;
  if (recentRows.length > 0 && priorRows.length > 0) {
    const recentRate    = recentRows.filter((r) => r.outcome === "favorable").length / recentRows.length;
    const priorRate     = priorRows.filter((r)  => r.outcome === "favorable").length / priorRows.length;
    five_year_trend     = Math.round((recentRate - priorRate) * 10000) / 10000;
  }

  // Volume last 12 months
  const cutoffDate        = new Date();
  cutoffDate.setFullYear(cutoffDate.getFullYear() - 1);
  const volume_last_12    = rows.filter(
    (r) => r.created_at && new Date(r.created_at) >= cutoffDate,
  ).length;

  await supabase.from("forum_analytics").upsert(
    {
      court_name,
      total_cases:             total,
      overall_success_rate:    overall_success,
      supreme_alignment_rate:  supreme_alignment,
      ...(five_year_trend !== null && { five_year_trend }),
      volume_last_12_months:   volume_last_12,
      last_updated:            new Date().toISOString(),
    },
    { onConflict: "court_name" },
  );
}

// ── Benchmark cache update ────────────────────────────────────────────────────
// Incremental upsert — recomputes aggregates from raw `legal_cases` data
// for every (act_name, section_number) pair affected by the new case.
// Called once per inserted case; runs within the same supabase client session.

type BenchRow = {
  outcome:        string | null;
  authority_tier: string | null;
  decision_year:  number | null;
};

export async function updateBenchmarkStats(
  act_name:       string,
  section_number: string,
): Promise<void> {
  // Pull raw aggregate data for this (act, section) pair
  const { data, error } = await supabase
    .from("legal_cases")
    .select("outcome, authority_tier, decision_year")
    .eq("act_name", act_name)
    .eq("section_number", section_number);

  if (error || !data || data.length === 0) return;

  const rows = data as BenchRow[];
  const total = rows.length;
  const favorable = rows.filter((r) => r.outcome === "favorable").length;
  const success_rate = total > 0 ? favorable / total : null;

  // Supreme alignment
  const supremeRows      = rows.filter((r) => r.authority_tier === "supreme");
  const supremeFavorable = supremeRows.filter((r) => r.outcome === "favorable").length;
  const supreme_alignment =
    supremeRows.length > 0 ? supremeFavorable / supremeRows.length : null;

  // 5-year trend
  const currentYear = new Date().getFullYear();
  const cutoff      = currentYear - 5;
  const recentRows  = rows.filter((r) => r.decision_year != null && r.decision_year >= cutoff);
  const priorRows   = rows.filter((r) => r.decision_year != null && r.decision_year < cutoff);

  let five_year_trend: "favorable" | "neutral" | "unfavorable" | null = null;
  if (recentRows.length > 0 && priorRows.length > 0) {
    const recentRate = recentRows.filter((r) => r.outcome === "favorable").length / recentRows.length;
    const priorRate  = priorRows.filter((r)  => r.outcome === "favorable").length / priorRows.length;
    const delta      = recentRate - priorRate;
    five_year_trend  = delta > 0.1 ? "favorable" : delta < -0.1 ? "unfavorable" : "neutral";
  }

  await supabase.from("benchmark_cache").upsert(
    {
      act_name,
      section_number,
      total_cases:       total,
      success_rate:      success_rate   != null ? Math.round(success_rate   * 10000) / 10000 : null,
      supreme_alignment: supreme_alignment != null ? Math.round(supreme_alignment * 10000) / 10000 : null,
      five_year_trend,
      updated_at:        new Date().toISOString(),
    },
    { onConflict: "act_name,section_number" },
  );
}

// ── Embedding ─────────────────────────────────────────────────────────────────

async function embedText(text: string): Promise<number[]> {
  try {
    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text.slice(0, 8000), // stay within token limit
    });
    return response.data[0].embedding;
  } catch (error) {
    const gateway = detectGatewayError(error);
    if (gateway) {
      console.error(gateway.message);
    } else {
      console.error("API request failed:", error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}

// ── Arg parser ────────────────────────────────────────────────────────────────

function parseArgs(): Record<string, string> {
  const args   = process.argv.slice(2);
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
      result[key] = val;
    }
  }
  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  if (!args["file"]) {
    console.error("Usage: npx ts-node scripts/ingest-case.ts --file <path> [--title <...>] [--year <YYYY>]");
    process.exit(1);
  }

  const filePath = path.resolve(args["file"]);
  if (!fs.existsSync(filePath)) {
    console.error(`❌  File not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`📄  Reading: ${filePath}`);
  const rawText  = await extractText(filePath);
  const normText = normaliseText(rawText);
  const hash     = sha256(normText);

  // ── Deduplication check ──────────────────────────────────────────────────
  const { data: existing } = await supabase
    .from("legal_cases")
    .select("id, case_title")
    .eq("hash", hash)
    .maybeSingle();

  if (existing) {
    console.log(`⚠️   Already ingested: "${existing.case_title}" (id: ${existing.id}). Skipping.`);
    process.exit(0);
  }

  // ── Extract metadata (pure regex — no LLM) ───────────────────────────────
  console.log("🔍  Extracting metadata…");
  const meta = extractMeta(normText);

  // CLI overrides
  const case_title   = args["title"]  ?? meta.case_title;
  const decision_year = args["year"]  ? parseInt(args["year"], 10) : meta.decision_year;

  console.log(`    Title:          ${case_title ?? "(unknown)"}`);
  console.log(`    Authority:      ${meta.authority_tier}`);
  console.log(`    Court:          ${meta.court_name ?? "(unknown)"}`);
  console.log(`    Year:           ${decision_year ?? "(unknown)"}`);
  console.log(`    Outcome:        ${meta.outcome}`);
  console.log(`    Acts detected:  ${meta.act_names.join(", ") || "(none)"}`);
  console.log(`    Sections:       ${meta.sections.slice(0, 10).join(", ") || "(none)"}${meta.sections.length > 10 ? " …" : ""}`);
  console.log(`    Citations:      ${meta.citation_count}`);
  console.log(`    parse_confidence: ${meta.parse_confidence}`);

  // ── Embed full text ───────────────────────────────────────────────────────
  console.log("🧮  Generating embedding…");
  const embedding = await embedText(normText);

  // ── Build row (single insert — atomic) ───────────────────────────────────
  // We insert one row per case (not per section).
  // act_name / section_number store the *primary* extracted value.
  const primaryAct     = meta.act_names[0] ?? null;
  const primarySection = meta.sections[0]  ?? null;

  const row = {
    case_title:       case_title    ?? null,
    act_name:         primaryAct,
    section_number:   primarySection,
    authority_tier:   meta.authority_tier,
    court_name:       meta.court_name,
    judge_name:       meta.judge_name,
    decision_year,
    outcome:          meta.outcome,
    jurisdiction:     "Pakistan",
    citation_count:   meta.citation_count,
    full_text:        normText,
    embedding,
    hash,
    parse_confidence: meta.parse_confidence,
  };

  console.log("💾  Inserting into legal_cases…");
  const { data: inserted, error: insertError } = await supabase
    .from("legal_cases")
    .insert(row)
    .select("id")
    .single();

  if (insertError) {
    console.error("❌  Insert failed:", insertError.message);
    process.exit(1);
  }

  console.log(`✅  Inserted case id: ${inserted.id}`);

  // ── Insert precedent node ─────────────────────────────────────────────────
  console.log("🔗  Inserting precedent node…");
  await insertPrecedentNode(
    inserted.id,
    case_title ?? null,
    decision_year,
    meta.authority_tier,
    meta.court_name,
    embedding,
  );

  // ── Extract + store case citations as graph edges ─────────────────────────
  const caseCitations = extractCaseCitations(normText);
  let citedCaseIds: string[] = [];
  if (caseCitations.length > 0) {
    console.log(`🔗  Extracted ${caseCitations.length} case citation(s). Inserting edges…`);
    citedCaseIds = await insertPrecedentEdges(inserted.id, caseCitations);
  }

  // ── Populate knowledge graph ──────────────────────────────────────────────
  console.log("🌐  Populating knowledge graph…");
  await insertKnowledgeGraph({
    caseId:        inserted.id,
    caseTitle:     case_title ?? null,
    authorityTier: meta.authority_tier,
    judgeName:     meta.judge_name,
    courtName:     meta.court_name,
    actNames:      meta.act_names,
    sections:      meta.sections,
    primaryAct,
    citedCaseIds,
  });

  // ── Update benchmark cache for all extracted (act, section) pairs ─────────
  if (primaryAct && primarySection) {
    console.log(`📊  Updating benchmark_cache for ${primaryAct} § ${primarySection}…`);
    await updateBenchmarkStats(primaryAct, primarySection);
  }

  // Also update wildcard (act-level) aggregate if we have an act
  if (primaryAct) {
    console.log(`📊  Updating benchmark_cache for ${primaryAct} (act-level)…`);
    await updateBenchmarkStats(primaryAct, "*");
  }

  // ── Update judge + forum analytics ───────────────────────────────────────
  if (meta.judge_name) {
    console.log(`👨‍⚖️  Updating judge_analytics for ${meta.judge_name}…`);
    await updateJudgeAnalytics(meta.judge_name, meta.court_name, primaryAct, meta.outcome);
  }

  if (meta.court_name) {
    console.log(`🏛️  Updating forum_analytics for ${meta.court_name}…`);
    await updateForumAnalytics(meta.court_name);
  }

  console.log("✅  Done.");
}

main().catch((err) => {
  console.error("❌  Fatal:", err);
  process.exit(1);
});
