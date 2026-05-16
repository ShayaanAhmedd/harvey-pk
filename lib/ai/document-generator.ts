// lib/ai/document-generator.ts
//
// Legal Document Generator — pure deterministic formatting layer.
// No LLM calls, no DB access, no side effects. O(1) complexity.
//
// Transforms an ArgumentStructure into a titled, sectioned legal document
// suitable for display, PDF export, or downstream processing.
//
// Supported document_type values:
//   "legal_memo"      — internal memorandum format (6 sections)
//   "court_argument"  — adversarial argument brief (4 sections)
//   "legal_opinion"   — formal legal opinion letter (4 sections)
//
// All section content is built deterministically from argument_structure
// fields. Missing optional fields degrade gracefully to placeholder text.

import type { ArgumentStructure } from "./argument-builder";

// ── Public types ──────────────────────────────────────────────────────────────

export type DocumentType = "legal_memo" | "court_argument" | "legal_opinion";

export interface DocumentSection {
  heading: string;
  content: string;
}

export interface GeneratedLegalDocument {
  title:    string;
  sections: DocumentSection[];
}

// ── Input type ────────────────────────────────────────────────────────────────

export interface DocumentGeneratorInput {
  argument_structure: ArgumentStructure;
  document_type:      DocumentType;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Indent each line of a block with two spaces. */
function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => (l.trim() ? "  " + l : l))
    .join("\n");
}

/** Format a governing_law entry as a citation line. */
function formatCitation(entry: ArgumentStructure["governing_law"][number]): string {
  return `${entry.act_name}, Section ${entry.section_number} — "${entry.excerpt.trimEnd()}"`;
}

/** Format a precedent_support entry as a support line. */
function formatPrecedent(entry: ArgumentStructure["precedent_support"][number]): string {
  const tier   = entry.authority_tier
    ? entry.authority_tier.charAt(0).toUpperCase() + entry.authority_tier.slice(1) + " Court"
    : "Court";
  const role   = entry.role === "leading" ? "Leading Authority" : "Analogous Case";
  const score  = Math.round(entry.influence_score * 100);
  return `${entry.case_title} (${tier}) [${role} — influence: ${score}%]`;
}

/** Format a counterargument entry as a labelled block. */
function formatCounterargument(
  entry: ArgumentStructure["counterarguments"][number],
  index: number,
): string {
  const strengthLabel =
    entry.strength === "strong"   ? "Strong"   :
    entry.strength === "moderate" ? "Moderate" : "Weak";

  return [
    `${index + 1}. ${entry.basis}`,
    `   Strength: ${strengthLabel}`,
    `   Rebuttal: ${entry.rebuttal}`,
  ].join("\n");
}

/** Join reasoning_chain steps as a numbered prose block. */
function formatReasoningChain(chain: string[]): string {
  if (chain.length === 0) return "(No reasoning steps available.)";
  return chain.map((step, i) => `${i + 1}. ${step}`).join("\n");
}

// ── Document builders ─────────────────────────────────────────────────────────

// ── legal_memo ────────────────────────────────────────────────────────────────
//
// Sections:
//   1. Executive Summary   — issue + conclusion + precedent count headline
//   2. Issue               — full issue statement
//   3. Governing Law       — formatted citation list
//   4. Analysis            — reasoning_chain as numbered steps
//   5. Counterarguments    — each entry labelled by strength with rebuttal
//   6. Conclusion          — full conclusion text

function buildLegalMemo(a: ArgumentStructure): DocumentSection[] {
  // 1. Executive Summary
  const leadingCount  = a.precedent_support.filter((p) => p.role === "leading").length;
  const analogCount   = a.precedent_support.filter((p) => p.role === "analogous").length;
  const precedentNote =
    leadingCount > 0
      ? `Supported by ${leadingCount} leading authorit${leadingCount > 1 ? "ies" : "y"}` +
        (analogCount > 0 ? ` and ${analogCount} analogous case${analogCount > 1 ? "s" : ""}` : "") + "."
      : "No precedent support identified in the current corpus.";

  const executiveSummary =
    `This memorandum addresses the following legal question:\n\n` +
    indent(a.issue) + "\n\n" +
    `${precedentNote}\n\n` +
    `Conclusion: ${a.conclusion}`;

  // 2. Issue
  const issueContent = a.issue;

  // 3. Governing Law
  const governingLawContent =
    a.governing_law.length > 0
      ? a.governing_law.map(formatCitation).join("\n\n")
      : "(No governing provisions identified.)";

  // 4. Analysis (reasoning chain)
  const analysisContent = formatReasoningChain(a.reasoning_chain);

  // 5. Counterarguments
  const counterContent =
    a.counterarguments.length > 0
      ? a.counterarguments.map(formatCounterargument).join("\n\n")
      : "No significant counterarguments identified.";

  // 6. Conclusion
  const conclusionContent = a.conclusion;

  return [
    { heading: "Executive Summary",  content: executiveSummary   },
    { heading: "Issue",              content: issueContent        },
    { heading: "Governing Law",      content: governingLawContent },
    { heading: "Analysis",           content: analysisContent     },
    { heading: "Counterarguments",   content: counterContent      },
    { heading: "Conclusion",         content: conclusionContent   },
  ];
}

// ── court_argument ────────────────────────────────────────────────────────────
//
// Sections:
//   1. Issue               — formal statement of the legal question before the court
//   2. Authorities         — governing law + precedent support, ranked by authority tier
//   3. Argument            — reasoning_chain as numbered propositions, then counter-rebuttals
//   4. Relief Requested    — derived from conclusion + standard closing prayer

function buildCourtArgument(a: ArgumentStructure): DocumentSection[] {
  // 1. Issue
  const issueContent =
    `The question before this Honourable Court is:\n\n` +
    indent(a.issue);

  // 2. Authorities — statute citations first, then precedents
  const statuteLines =
    a.governing_law.length > 0
      ? "STATUTORY AUTHORITIES:\n" + a.governing_law.map(formatCitation).join("\n\n")
      : "";

  const precedentLines =
    a.precedent_support.length > 0
      ? "PRECEDENT AUTHORITIES:\n" + a.precedent_support.map(formatPrecedent).join("\n")
      : "";

  const authoritiesContent =
    [statuteLines, precedentLines].filter(Boolean).join("\n\n") ||
    "(No authorities on record.)";

  // 3. Argument — reasoning chain as numbered propositions, then counterargument rebuttals
  const propositions = formatReasoningChain(a.reasoning_chain);

  const rebuttalLines =
    a.counterarguments.length > 0
      ? "\n\nANSWER TO ANTICIPATED OBJECTIONS:\n\n" +
        a.counterarguments
          .map((ca, i) => {
            const label = `${i + 1}. Objection: ${ca.basis}`;
            const reply = `   Response: ${ca.rebuttal}`;
            return label + "\n" + reply;
          })
          .join("\n\n")
      : "";

  const argumentContent = propositions + rebuttalLines;

  // 4. Relief Requested — standard adversarial prayer derived from conclusion
  const reliefContent =
    `In light of the foregoing, the Petitioner/Appellant respectfully prays that ` +
    `this Honourable Court be pleased to:\n\n` +
    `  (i)  Accept the arguments advanced herein;\n` +
    `  (ii) Hold that: ${a.conclusion.trimEnd()};\n` +
    `  (iii) Grant such further relief as this Court deems just and equitable in the circumstances.`;

  return [
    { heading: "Issue",            content: issueContent      },
    { heading: "Authorities",      content: authoritiesContent },
    { heading: "Argument",         content: argumentContent    },
    { heading: "Relief Requested", content: reliefContent      },
  ];
}

// ── legal_opinion ─────────────────────────────────────────────────────────────
//
// Sections:
//   1. Question Presented  — the precise legal question, restated in opinion form
//   2. Applicable Law      — governing provisions + leading precedents
//   3. Analysis            — reasoning_chain as structured paragraphs;
//                            counterarguments noted as risk qualifications
//   4. Opinion             — authoritative statement of the legal position

function buildLegalOpinion(a: ArgumentStructure): DocumentSection[] {
  // 1. Question Presented
  const questionContent =
    `We have been requested to advise on the following question of law:\n\n` +
    indent(a.issue);

  // 2. Applicable Law
  const statutoryBlock =
    a.governing_law.length > 0
      ? "The following statutory provisions govern the matter:\n\n" +
        a.governing_law.map((g) => `  • ${formatCitation(g)}`).join("\n")
      : "(No statutory provisions identified.)";

  const leading   = a.precedent_support.filter((p) => p.role === "leading");
  const analogous = a.precedent_support.filter((p) => p.role === "analogous");

  const precedentBlock =
    leading.length > 0
      ? "\n\nThe following judicial authorities are directly applicable:\n\n" +
        leading.map((p) => `  • ${formatPrecedent(p)}`).join("\n") +
        (analogous.length > 0
          ? "\n\nThe following cases are analogous:\n\n" +
            analogous.map((p) => `  • ${formatPrecedent(p)}`).join("\n")
          : "")
      : "";

  const applicableLawContent = statutoryBlock + precedentBlock;

  // 3. Analysis — reasoning chain as lettered paragraphs + risk qualifications
  const analysisParas =
    a.reasoning_chain.length > 0
      ? a.reasoning_chain
          .map((step, i) => {
            const letter = String.fromCharCode(97 + i); // a, b, c …
            return `(${letter}) ${step}`;
          })
          .join("\n\n")
      : "(No analytical steps available.)";

  const riskQualifications =
    a.counterarguments.length > 0
      ? "\n\nRisk qualifications:\n\n" +
        a.counterarguments
          .map((ca) => `  — [${ca.strength.toUpperCase()}] ${ca.basis}`)
          .join("\n")
      : "";

  const analysisContent = analysisParas + riskQualifications;

  // 4. Opinion
  const strongCount = a.counterarguments.filter((c) => c.strength === "strong").length;
  const qualificationNote =
    strongCount > 0
      ? ` Subject to the ${strongCount} strong counterargument${strongCount > 1 ? "s" : ""} ` +
        `noted in the Analysis section above, this opinion may require qualification ` +
        `if those arguments are raised before the Court.`
      : "";

  const opinionContent =
    `Based on the foregoing analysis, it is our opinion that:\n\n` +
    indent(a.conclusion) + "\n\n" +
    `This opinion is furnished solely for the purpose of the matter described above ` +
    `and may not be relied upon for any other purpose.` +
    qualificationNote;

  return [
    { heading: "Question Presented", content: questionContent      },
    { heading: "Applicable Law",     content: applicableLawContent },
    { heading: "Analysis",           content: analysisContent      },
    { heading: "Opinion",            content: opinionContent       },
  ];
}

// ── Title builders ────────────────────────────────────────────────────────────

function buildTitle(a: ArgumentStructure, type: DocumentType): string {
  // Extract a short subject from the issue (first ~8 words)
  const subject = a.issue
    .trim()
    .split(/\s+/)
    .slice(0, 8)
    .join(" ")
    .replace(/[?.,;:]+$/, "");

  switch (type) {
    case "legal_memo":
      return `Legal Memorandum — ${subject}`;
    case "court_argument":
      return `Written Arguments — ${subject}`;
    case "legal_opinion":
      return `Legal Opinion — ${subject}`;
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

export function generateLegalDocument(
  input: DocumentGeneratorInput,
): GeneratedLegalDocument {
  const { argument_structure: a, document_type } = input;

  const title = buildTitle(a, document_type);

  let sections: DocumentSection[];
  switch (document_type) {
    case "legal_memo":
      sections = buildLegalMemo(a);
      break;
    case "court_argument":
      sections = buildCourtArgument(a);
      break;
    case "legal_opinion":
      sections = buildLegalOpinion(a);
      break;
    default: {
      // TypeScript exhaustiveness guard — unreachable at runtime
      const _exhaustive: never = document_type;
      void _exhaustive;
      sections = buildLegalMemo(a);
    }
  }

  return { title, sections };
}
