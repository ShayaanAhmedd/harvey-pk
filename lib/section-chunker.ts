/**
 * section-chunker.ts
 *
 * Production-grade section chunker for Pakistani legal documents (PPC, etc.)
 *
 * Handles real-world pdf-parse output with:
 *  - Leading whitespace before section numbers
 *  - Split-line section headers (number on one line, title on next)
 *  - Inline section headers: "302. Title.—Body text all on one line"
 *  - Footnote/page numbers (ignored)
 *  - Amendment markers like [174], [] (ignored)
 *  - Chapter headings → propagated as chunk metadata
 *  - Section numbers with letter/hyphen suffixes: 55-A, 366B, 302-AA
 */

export type LegalChunk = {
  content: string;
  chunk_index: number;
  section_number: string | null;
  title: string | null;
  chapter: string | null;
};

const MAX_CHUNK_CHARS = 2000;

// ─────────────────────────────────────────────────────────────
// REGEXES
// ─────────────────────────────────────────────────────────────

/**
 * Chapter / Part / Schedule heading.
 * Matches the full trimmed line.
 * Examples: "CHAPTER XIX", "CHAPTER I OF PUNISHMENTS", "PART III"
 */
const CHAPTER_RE =
  /^((?:CHAPTER|PART|SCHEDULE)\s+(?:[IVXLCDM]+|\d+)(?:\s+.{0,80})?)\s*$/i;

/**
 * Section header line.
 * - Leading whitespace: 0–8 chars (common in PDF column extraction)
 * - Section number: 1–3 digits + optional uppercase letter or "-LETTER"
 *   Examples: 1, 302, 55-A, 366B, 302-AA
 * - Literal period
 * - Either: whitespace + rest-of-line title, or end of line (title on next line)
 */
const SECTION_RE =
  /^\s{0,8}(\d{1,3}(?:[A-Z]{1,2}|-[A-Z]{1,2})?)\.(?:[ \t]+(.+?)[ \t]*|\s*)$/;

/**
 * Noise lines to discard entirely:
 *  - Standalone digits            e.g. 173
 *  - Bracketed references         e.g. [174], [Ins. by Act...], []
 *  - Asterisk sequences           e.g. **, ***
 *  - Decorative horizontal rules  e.g. ----, ====, ____
 */
const NOISE_RE =
  /^\s*(?:\d+|\[[\w\s,.*\-–—]*?\]|\*{1,6}|[-_=]{3,})\s*$/;

// PPC uses ".—" or ".–" to separate a section title from its body.
// We strip from this delimiter to extract a clean title.
const TITLE_DASH_RE = /\.[\-–—]/;

// ─────────────────────────────────────────────────────────────
// TOKENISER
// ─────────────────────────────────────────────────────────────

type TChapter = { kind: "chapter"; text: string };
type TSection = { kind: "section"; num: string; title: string | null };
type TContent = { kind: "content"; text: string };
type TBlank   = { kind: "blank" };
type Token    = TChapter | TSection | TContent | TBlank;

function tokenize(lines: string[]): Token[] {
  const tokens: Token[] = [];

  for (const raw of lines) {
    // 1. Discard noise lines
    if (NOISE_RE.test(raw)) continue;

    const trimmed = raw.trim();

    // 2. Blank line — collapse consecutive blanks
    if (!trimmed) {
      const last = tokens[tokens.length - 1];
      if (!last || last.kind !== "blank") tokens.push({ kind: "blank" });
      continue;
    }

    // 3. Chapter heading
    const cm = trimmed.match(CHAPTER_RE);
    if (cm) {
      tokens.push({ kind: "chapter", text: normaliseSpace(cm[1]) });
      continue;
    }

    // 4. Section header — accepted only when preceded by a blank line,
    //    chapter heading, another section header, or at start of document.
    //    This prevents numbered list items mid-section from being misidentified.
    const sm = raw.match(SECTION_RE);
    if (sm) {
      const last = tokens[tokens.length - 1];
      const afterBreak =
        !last ||
        last.kind === "blank" ||
        last.kind === "chapter" ||
        last.kind === "section";

      if (afterBreak) {
        const rawTitle = sm[2] ? normaliseSpace(sm[2]) : null;
        tokens.push({ kind: "section", num: sm[1], title: rawTitle });
        continue;
      }
    }

    // 5. Regular content
    tokens.push({ kind: "content", text: trimmed });
  }

  return tokens;
}

// ─────────────────────────────────────────────────────────────
// CHUNK ASSEMBLER
// ─────────────────────────────────────────────────────────────

function assembleChunks(tokens: Token[]): LegalChunk[] {
  const chunks: LegalChunk[] = [];
  let chunkIndex = 0;

  let currentChapter: string | null = null;
  let currentSection: string | null = null;
  let currentTitle: string | null = null;
  let buffer: string[] = [];

  function flush() {
    const raw = buffer
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    buffer = [];
    if (!raw) return;

    for (const part of splitLong(raw)) {
      chunks.push({
        content: part,
        chunk_index: chunkIndex++,
        section_number: currentSection,
        title: currentTitle,
        chapter: currentChapter,
      });
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    // ── Chapter ───────────────────────────────────────────
    if (tok.kind === "chapter") {
      flush();
      currentChapter = tok.text;
      continue;
    }

    // ── Section ───────────────────────────────────────────
    if (tok.kind === "section") {
      flush();
      currentSection = tok.num;

      // The raw title captured from the header line (may include body text
      // in inline format: "302. Punishment.—Whoever commits...")
      let inlineTitle = tok.title;

      // Title on next line: if no inline title, peek ahead for a content
      // token that looks like a title (short, not a subsection indicator).
      if (!inlineTitle) {
        let peek = i + 1;
        while (peek < tokens.length && tokens[peek].kind === "blank") peek++;

        const next = tokens[peek];
        if (
          next &&
          next.kind === "content" &&
          next.text.length <= 180 &&
          !/^\(/.test(next.text) // not "(1)", "(a)" subsection syntax
        ) {
          inlineTitle = next.text;
          i = peek; // consume the title token
        }
      }

      // Extract clean title: strip body text after ".—" delimiter
      currentTitle = extractTitle(inlineTitle);

      // The buffer begins with the full header line so the section number
      // appears in the chunk content for RAG context.
      const headerLine =
        inlineTitle ? `${tok.num}. ${inlineTitle}` : `${tok.num}.`;
      buffer.push(headerLine.trimEnd());
      continue;
    }

    // ── Blank ─────────────────────────────────────────────
    if (tok.kind === "blank") {
      if (buffer.length > 0 && buffer[buffer.length - 1] !== "") {
        buffer.push("");
      }
      continue;
    }

    // ── Content ───────────────────────────────────────────
    buffer.push(tok.text);
  }

  flush();
  return chunks;
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * From "Punishment for qatl-i-amd.—Whoever commits..."
 * extract "Punishment for qatl-i-amd".
 *
 * Strips everything from the first ".—" / ".–" / ".-" onwards.
 * If no delimiter is found, returns the original string.
 */
function extractTitle(raw: string | null): string | null {
  if (!raw) return null;
  const idx = raw.search(TITLE_DASH_RE);
  const clean = idx > 0 ? raw.slice(0, idx) : raw;
  return clean.trim() || null;
}

function normaliseSpace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Split a long section body at paragraph boundaries.
 * Falls back to hard character splits if a single paragraph exceeds limit.
 */
function splitLong(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];

  const paragraphs = text.split(/\n\s*\n/);
  const result: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const p = para.trim();
    if (!p) continue;

    if (current && current.length + p.length + 2 > MAX_CHUNK_CHARS) {
      result.push(current.trim());
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current.trim()) result.push(current.trim());

  // Hard-split any remaining over-long block
  return result.flatMap((s) => {
    if (s.length <= MAX_CHUNK_CHARS) return [s];
    const parts: string[] = [];
    for (let i = 0; i < s.length; i += MAX_CHUNK_CHARS) {
      parts.push(s.slice(i, i + MAX_CHUNK_CHARS));
    }
    return parts;
  });
}

/** Character-based fallback when no legal structure is detected. */
function fallbackChunks(text: string, size = 1000): LegalChunk[] {
  const result: LegalChunk[] = [];
  for (let i = 0; i < text.length; i += size) {
    result.push({
      content: text.slice(i, i + size),
      chunk_index: result.length,
      section_number: null,
      title: null,
      chapter: null,
    });
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────

export function chunkBySections(text: string): LegalChunk[] {
  const lines = text.split("\n");
  const tokens = tokenize(lines);
  const chunks = assembleChunks(tokens);

  return chunks.length > 0 ? chunks : fallbackChunks(text);
}
