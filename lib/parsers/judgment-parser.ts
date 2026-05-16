// lib/parsers/judgment-parser.ts
//
// Pure judgment metadata extractor — no I/O, no LLM, no side effects.
// Used by scripts/run-court-ingestion.ts and available for any other consumer.
//
// Safety:
//   - Pure regex only
//   - Deterministic output for identical input
//   - No external dependencies beyond Node.js built-ins (crypto)

import crypto from "crypto";

// ── Public types ──────────────────────────────────────────────────────────────

export type AuthorityTier = "supreme" | "high" | "lower" | "legislation";
export type Outcome       = "favorable" | "unfavorable" | "neutral" | "mixed" | "unknown";

export interface ParsedJudgment {
  case_title:       string | null;
  act_names:        string[];      // all acts detected in the text
  sections:         string[];      // all section numbers detected
  authority_tier:   AuthorityTier;
  court_name:       string | null;
  judge_name:       string | null; // primary (first) judge
  bench:            string | null; // all judges, comma-separated
  decision_year:    number | null;
  outcome:          Outcome;
  citation_count:   number;        // reporter-style citation count
  jurisdiction:     string | null; // "Federal" | "Punjab" | "Sindh" | etc.
  parse_confidence: number;        // 0.000 – 1.000
}

// ── Authority classification ──────────────────────────────────────────────────
// Mirrors the constants in scripts/ingest-case.ts — kept separate so this
// module has zero dependency on Next.js or Supabase.

const SC_PATTERN  = /\b(?:SCMR|SCJ|Supreme\s+Court|SC\b)/i;
const HC_PATTERN  = /\b(?:PCrLJ|CLC|MLD|PLJ|High\s+Court|HC\b)/i;
const LEG_PATTERN = /\b(?:Act|Ordinance|Rules?|Code|Regulation)\b/i;

export function classifyAuthority(text: string): AuthorityTier {
  if (SC_PATTERN.test(text))  return "supreme";
  if (HC_PATTERN.test(text))  return "high";
  if (LEG_PATTERN.test(text)) return "legislation";
  return "lower";
}

// ── Case citation extraction ──────────────────────────────────────────────────

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

// ── Metadata patterns ─────────────────────────────────────────────────────────

const CASE_TITLE_RE  = /^(.{10,120})\s*(?:v\.?|versus)\s*(.{3,80})/im;
// JUDGE_RE uses global flag — callers must reset lastIndex or clone the regex
const JUDGE_PATTERN  = /(?:Justice|Hon(?:ourable)?\.?|J\.)\s+([A-Z][a-zA-Z\s.]{2,40})/g;
const YEAR_PATTERN   = /\b(19[6-9]\d|20[0-3]\d)\b/g;
const SECTION_PATTERN = /\bsection\s+(\d{1,3}[A-Za-z]?(?:-[A-Za-z])?)/gi;
const COURT_RE       = /\b(Supreme\s+Court|High\s+Court|Sessions?\s+Court|Magistrate(?:'s)?\s+Court|Federal\s+Shariat\s+Court)\b/i;
const CITATION_COUNT_RE = /\b(?:PLD|SCMR|PCrLJ|CLC|MLD|PLJ|SCJ)\s+\d{4}\b/gi;
const ACT_PATTERN    = /\b([A-Z][A-Za-z\s]{3,50}(?:Act|Ordinance|Code|Rules?|Regulation))\s+(?:of\s+)?\d{4}\b/g;

// ── Jurisdiction detection ────────────────────────────────────────────────────

const JURISDICTION_PATTERNS: [RegExp, string][] = [
  [/\b(?:Supreme\s+Court\s+of\s+Pakistan|Federal\s+Shariat|Islamabad\s+High)\b/i, "Federal"],
  [/\bLahore\b/i,                                                                   "Punjab"],
  [/\b(?:Sindh|Karachi)\b/i,                                                        "Sindh"],
  [/\b(?:Peshawar|KPK|KPk|Khyber\s+Pakhtunkhwa)\b/i,                              "KPK"],
  [/\bBalochistan\b/i,                                                               "Balochistan"],
  [/\b(?:AJK|Azad\s+(?:Jammu|Kashmir))\b/i,                                        "AJK"],
  [/\b(?:Gilgit|Baltistan)\b/i,                                                      "GB"],
];

function detectJurisdiction(text: string): string | null {
  for (const [re, label] of JURISDICTION_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

// ── Outcome detection ─────────────────────────────────────────────────────────

const FAVORABLE_RE   = /\b(?:allowed|granted|upheld|succeeded|in\s+favour\s+of\s+(?:the\s+)?(?:petitioner|appellant|plaintiff))\b/i;
const UNFAVORABLE_RE = /\b(?:dismissed|rejected|denied|failed|in\s+favour\s+of\s+(?:the\s+)?(?:respondent|defendant|state))\b/i;
const MIXED_RE       = /\b(?:partly\s+allowed|partially\s+(?:allowed|granted)|remanded)\b/i;

export function detectOutcome(text: string): Outcome {
  // Focus on conclusion (last ~25% of document)
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

// ── Normalisation + hashing ───────────────────────────────────────────────────

export function normaliseText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g,   "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// ── Main parse function ───────────────────────────────────────────────────────

export function parseJudgment(text: string): ParsedJudgment {
  // Case title
  const titleMatch = CASE_TITLE_RE.exec(text);
  const case_title = titleMatch
    ? `${titleMatch[1].trim()} v. ${titleMatch[2].trim()}`
    : null;

  // Acts — scan full text
  const actSet = new Set<string>();
  for (const m of text.matchAll(new RegExp(ACT_PATTERN.source, "g"))) {
    actSet.add(m[1].trim());
  }
  const act_names = [...actSet];

  // Sections
  const sectionSet = new Set<string>();
  for (const m of text.matchAll(new RegExp(SECTION_PATTERN.source, "gi"))) {
    sectionSet.add(m[1]);
  }
  const sections = [...sectionSet];

  // Authority tier
  const authority_tier = classifyAuthority(text);

  // Court name
  const courtMatch = COURT_RE.exec(text);
  const court_name = courtMatch ? courtMatch[1] : null;

  // Judges — extract all mentions, deduplicated, capped at bench of 7
  const judgeNames: string[] = [];
  for (const m of text.matchAll(new RegExp(JUDGE_PATTERN.source, "g"))) {
    const name = m[1].trim().replace(/\s+/g, " ");
    if (name.length > 2 && !judgeNames.includes(name)) judgeNames.push(name);
    if (judgeNames.length >= 7) break;
  }
  const judge_name = judgeNames[0] ?? null;
  const bench      = judgeNames.length > 0 ? judgeNames.join(", ") : null;

  // Decision year — most frequent year, tie-broken by recency
  const yearFreq: Record<number, number> = {};
  for (const m of text.matchAll(new RegExp(YEAR_PATTERN.source, "g"))) {
    const y = parseInt(m[1], 10);
    yearFreq[y] = (yearFreq[y] ?? 0) + 1;
  }
  const sortedYears = Object.entries(yearFreq)
    .sort((a, b) => b[1] - a[1] || parseInt(b[0]) - parseInt(a[0]));
  const decision_year = sortedYears.length > 0 ? parseInt(sortedYears[0][0]) : null;

  // Outcome
  const outcome = detectOutcome(text);

  // Citation count (reporter-style)
  const citation_count = (text.match(CITATION_COUNT_RE) ?? []).length;

  // Jurisdiction
  const jurisdiction = detectJurisdiction(text);

  // parse_confidence: fraction of 6 optional fields extracted
  const fieldHits = [
    case_title,
    act_names[0]  ?? null,
    judge_name,
    decision_year !== null ? decision_year : null,
    court_name,
    jurisdiction,
  ].filter((v) => v !== null && v !== undefined).length;
  const parse_confidence = Math.round((fieldHits / 6) * 1000) / 1000;

  return {
    case_title, act_names, sections, authority_tier, court_name,
    judge_name, bench, decision_year, outcome, citation_count,
    jurisdiction, parse_confidence,
  };
}
