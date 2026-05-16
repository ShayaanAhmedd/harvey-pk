// Logical connectives that signal a good paragraph break point.
const BREAK_PHRASES = [
  "However,",
  "Furthermore,",
  "Therefore,",
  "Under the pre-amendment framework",
  "Following the amendments",
];

// Build a regex that matches any break phrase at a word boundary.
const BREAK_RE = new RegExp(
  `(?<=[.!?]\\s)(?=${BREAK_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`
);

/**
 * Split a long legal text into multiple paragraphs for readability.
 * Paragraphs are separated by "\n\n". Wording is never altered.
 */
export function formatParagraphs(text: string): string {
  if (!text) return text;

  // First split on explicit break phrases (after sentence-ending punctuation).
  const segments = text.split(BREAK_RE).filter(Boolean);

  const result: string[] = [];

  for (const segment of segments) {
    // Further split long segments at sentence boundaries when a sentence
    // pushes the running paragraph past ~25 words.
    const sentences = segment.match(/[^.!?]+[.!?]+["']?/g) ?? [segment];
    let paragraph = "";
    let wordCount  = 0;

    for (const sentence of sentences) {
      const words = sentence.trim().split(/\s+/).length;

      if (wordCount > 0 && wordCount + words > 25) {
        result.push(paragraph.trim());
        paragraph  = sentence;
        wordCount  = words;
      } else {
        paragraph  = paragraph ? `${paragraph} ${sentence.trim()}` : sentence.trim();
        wordCount += words;
      }
    }

    if (paragraph.trim()) result.push(paragraph.trim());
  }

  return result.join("\n\n");
}
