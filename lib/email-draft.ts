// lib/email-draft.ts
// Parses [DRAFT_EMAIL]...[/DRAFT_EMAIL] blocks from AI responses.
// Used by WorkspaceShell and VoiceMode to detect email draft requests.
//
// AI writes:
//   [DRAFT_EMAIL]
//   To: a@example.com, b@example.com
//   Subject: Subject line
//   Body: Email body text here
//   [/DRAFT_EMAIL]
//
// The block is stripped from the displayed message; the draft is shown in a
// confirmation modal where the user can edit fields before sending.
// The AI CANNOT send without user approval.

export interface EmailDraft {
  to:      string[];   // one or more recipient addresses
  subject: string;
  body:    string;
}

// Matches [DRAFT_EMAIL] ... [/DRAFT_EMAIL] with optional whitespace around field names.
// Uses [\s\S] so body can span multiple lines.
const DRAFT_EMAIL_RE =
  /\[DRAFT_EMAIL\]\s*\nTo:\s*(.+?)\nSubject:\s*(.+?)\nBody:\s*([\s\S]+?)\[\/DRAFT_EMAIL\]/;

export function parseEmailDraft(text: string): { clean: string; draft: EmailDraft | null } {
  const match = text.match(DRAFT_EMAIL_RE);
  if (!match) return { clean: text, draft: null };

  const [fullMatch, rawTo, subject, body] = match;
  const clean = text.replace(fullMatch, " ").replace(/\s{2,}/g, " ").trim();

  // Split comma-separated addresses and trim each one
  const to = rawTo.split(",").map((s) => s.trim()).filter(Boolean);

  return {
    clean,
    draft: {
      to,
      subject: subject.trim(),
      body:    body.trim(),
    },
  };
}
