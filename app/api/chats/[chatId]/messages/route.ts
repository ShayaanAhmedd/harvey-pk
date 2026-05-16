// POST /api/chats/[chatId]/messages
//
// Streams the assistant response as Server-Sent Events (SSE):
//
//   data: {"type":"chunk","content":"token text"}  — one per OpenAI token
//   data: {"type":"done","message":{id,sources,created_at}}  — after DB save
//   data: [DONE]
//
// Retrieval strategy (in order):
//   1. DETERMINISTIC: if question names "Section X", direct SQL lookup by
//      (section_number, act_name) — no embedding, no threshold guessing.
//   2. VECTOR: parallel case + global RPC search, threshold 0.40, top 8.
//   3. NO MATCH: model answers from training knowledge (no corpus mention).
//
// Mode resolution (in order):
//   1. Explicit valid mode from client → used as-is.
//   2. Auto-route: keyword + length analysis of the question.
//   3. User's saved default_mode preference from user_preferences table.
//   4. Hard fallback: "fast".
//
// User preferences (fetched in parallel with chat ownership check):
//   writing_style   → injected into system prompt
//   citation_style  → injected into system prompt
//   output_density  → injected into system prompt
//   default_mode    → used in mode resolution (#3 above)
//
// Platform settings (fetched in parallel):
//   web_intelligence → false disables Brave; web mode falls back to RAG
//   draft_engine     → "claude" skips Manus in draft mode
//
// No console.log / console.error / console.warn in this file.
// All errors are caught and handled via fallback chains or error SSE events.

// Explicit Node.js runtime — required for Anthropic SDK (uses Node fetch internals).
// Never allow this route to run on the Edge runtime.
export const runtime = "nodejs";

import OpenAI from "openai";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { embedText } from "@/lib/embeddings";
import { callBraveSearch } from "@/lib/ai/brave";
import { routeAIRequest, type TaskType } from "@/lib/ai/router";
import { runIracPipeline, buildIracSystemPrompt } from "@/lib/ai/irac";
import { UI_COMMAND_INSTRUCTIONS } from "@/lib/ui-actions";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// ── System prompt for Claude deep-research mode ──────────────────────────────

const CLAUDE_SYSTEM = `You are Harvey — a senior AI assistant and legal counsel for a Pakistani law firm. You have two capabilities:

1. LEGAL COUNSEL: Deep expertise in Pakistani law. You give authoritative legal advice.
2. APP CONTROL: You can fully control the application UI — theme, font, voice, clock, background, and settings. When asked to change any setting, you MUST do it immediately using the UI command system described below.

────────────────────────────────────────────────────────
RESPONSE PROTOCOL — assess query intent before responding
────────────────────────────────────────────────────────

UI / SETTINGS REQUEST ("change theme", "bigger font", "turn on clock", "change voice", "white background", etc.):
→ ALWAYS emit the UI command immediately. NEVER refuse. NEVER say "I cannot change that."
→ Use the UI_CONTROL instructions at the end of this prompt.

CASUAL (greeting, small talk, meta-question, general chat, thanks, yes/no, "who are you", "how are you", "what can you do"):
→ Respond naturally, warmly, and briefly. No formal structure required.
→ Match the energy of the message: a simple hello deserves a simple hello back.

SUBSTANTIVE LEGAL QUERY (statute, offence, rights, procedure, contract, constitutional issue, legal analysis, case strategy):
→ Apply the full juridical memorandum structure below.
→ This is your standard for any genuine legal question.

When a legal issue is presented, your analysis must meet the standard of a published law journal memorandum or senior counsel brief.

────────────────────────────────────────────────────────
MEMORANDUM STRUCTURE (legal queries only)
────────────────────────────────────────────────────────

**ISSUE**
State the precise legal question with particularity. Identify the jurisdiction, the applicable legislative framework, and the specific legal proposition under examination.

**RELEVANT LAW**
Identify all applicable statutes, ordinances, rules, and judicial precedents.
Quote every relevant statutory provision verbatim and in full — do not paraphrase.
Cite each provision as: Act Name, Section Number (Year).

**DOCTRINAL STRUCTURE**
Analyse the internal architecture of the relevant legal provisions.
Identify operative elements, evidentiary thresholds, fault standards, and definitional parameters.
Examine the statutory text for ambiguity, legislative intent, and interpretive precision.
Where multiple provisions interact, map their relationship explicitly.

**JURISPRUDENTIAL ANALYSIS**
Engage with the established judicial interpretation of the provision.
Apply the governing doctrine with specificity.
Analyse judicial discretion, the applicable standard of proof, and procedural constraints.
Where conflicting lines of authority exist, identify, address, and resolve them.

**COMPARATIVE INTERPRETATION** *(include where the provision derives from English common law, Indian jurisprudence, or international legal standards)*
Identify the doctrinal derivation and any divergence in Pakistani courts.
Analyse the development of the doctrine in the source jurisdiction and its reception in Pakistan.

**CONSTITUTIONAL / POLICY DIMENSION** *(include where the issue engages fundamental rights or legislative policy)*
Examine whether any fundamental right under the Constitution of Pakistan 1973 is engaged.
Identify any conflict between the statutory provision and constitutional guarantees.
Address the legislative policy objective and evaluate whether the provision serves it proportionately.

**PRACTICAL IMPLICATIONS**
Analyse the procedural, evidentiary, and strategic consequences.
Address burden of proof, available defences, procedural requirements, and the scope of available remedies.
Identify tactical considerations for counsel.

**CONCLUSION**
Synthesise the foregoing analysis into a tightly reasoned legal position.
State the most defensible interpretation of the law as applied to the issue.
Do not hedge. Conclude with the authority appropriate to senior counsel.

────────────────────────────────────────────────────────
MANDATORY DRAFTING RULES (legal memos only)
────────────────────────────────────────────────────────

1. Format matches content: casual query → casual reply; legal query → memorandum.
2. No emojis, hedging language, or softening qualifiers in legal memos.
3. Do not mention AI, training, knowledge cutoffs, or system limitations.
4. Do not refer to any database, corpus, or indexing system.
5. Do not suggest consulting a lawyer — you are the lawyer.
6. Never write "As an AI" or any variant thereof.
7. Never write "No relevant statutory provision found" — reason from first principles.
8. No disclaimers of any kind.
9. Quote statutes verbatim and completely — never paraphrase the operative text.
10. Target minimum 900 words for legal memos. Complex matters warrant 1,200–1,500 words.
11. Write with the density and analytical rigour of a published legal memorandum.`;

// ── Constants ────────────────────────────────────────────────────────────────

const HISTORY_WINDOW = 12;
const RAG_TOP_K      = 8;
// 0.25 calibrated for Xenova/bge-small-en-v1.5 (384-dim).
// The earlier 0.40 was tuned for text-embedding-3-small (1536-dim).
const RAG_THRESHOLD  = 0.25;

type UIMode = "deep" | "fast" | "documents" | "premium" | "web" | "crosscheck" | "draft";

const VALID_MODES = [
  "deep", "fast", "documents", "premium", "web", "crosscheck", "draft",
] as const;

const MODE_CONFIG: Record<UIMode, { model: string; maxTokens: number }> = {
  deep:       { model: "gpt-4o",      maxTokens: 2048 },
  fast:       { model: "gpt-4o-mini", maxTokens: 1024 },
  documents:  { model: "gpt-4o-mini", maxTokens: 1024 },
  premium:    { model: "gpt-4o",      maxTokens: 4096 },
  web:        { model: "gpt-4o",      maxTokens: 2048 },
  crosscheck: { model: "gpt-4o",      maxTokens: 2048 },
  draft:      { model: "gpt-4o",      maxTokens: 4096 },
};

// ── Auto-routing ─────────────────────────────────────────────────────────────
//
// Applied when client sends no explicit mode. Analyses question signals
// in priority order. Falls back to the user's saved default_mode, then
// to "fast".

function resolveMode(
  requestedMode: unknown,
  question: string,
  userDefaultMode: string
): UIMode {
  // 1. Explicit valid mode from client
  if (
    typeof requestedMode === "string" &&
    (VALID_MODES as readonly string[]).includes(requestedMode)
  ) {
    return requestedMode as UIMode;
  }

  const q = question.toLowerCase();

  // 2. Auto-route by signal — draft and recency checked first (more specific)
  if (/\b(?:draft|write|prepare|compose|pleading|petition|bail\s+application|notice|formal\s+letter|agreement|deed|affidavit)\b/.test(q)) {
    return "draft";
  }
  if (/\b(?:latest|recent|amendment|notification|gazette|circular|2025|2026)\b/.test(q)) {
    return "web";
  }

  // Deep mode: explicit analytical keywords (any length), OR long questions with doctrinal signals
  const deepKeywords =
    /\b(?:analys[ei]s?|analyse|analyze|jurisprudence|doctrinal|doctrine|distinction|interpretation|constitutional|policy|implication|mens\s+rea|actus\s+reus|vicarious\s+liabilit|ultra\s+vires|res\s+judicata|ratio\s+decidendi|locus\s+standi|stare\s+decisis|audi\s+alteram|natural\s+justice|legitimate\s+expectation)\b/i;

  if (
    deepKeywords.test(question) ||
    (question.length > 200 &&
      /\b(?:argue|explain|distinguish|compare|assess|evaluate|examine|review|consider|discuss|elaborate)\b/i.test(question))
  ) {
    return "deep";
  }

  // 3. User's saved default
  if ((VALID_MODES as readonly string[]).includes(userDefaultMode)) {
    return userDefaultMode as UIMode;
  }

  // 4. Hard fallback
  return "fast";
}

// ── Preference directives ────────────────────────────────────────────────────
//
// Appended to system prompts when user has non-default preferences.

interface UserPrefs {
  legal_role:     string;
  default_mode:   string;
  writing_style:  string;
  citation_style: string;
  output_density: string;
}

// forDeepMode: when true, forces high-density output regardless of user preference,
// and suppresses "plain" writing style (deep mode always uses formal academic register).
function buildPreferenceDirectives(prefs: UserPrefs | null, forDeepMode = false): string {
  if (!prefs) return "";
  const parts: string[] = [];

  if (!forDeepMode && prefs.writing_style === "plain") {
    parts.push("Write in plain, accessible language. Minimise legal jargon. Explain technical terms when used.");
  } else if (prefs.writing_style === "analytical") {
    parts.push("Write in an analytical, academic register. Include jurisprudential context and comparative analysis where relevant.");
  }
  // "formal" is the default register — no additional directive needed

  if (prefs.citation_style === "bluebook") {
    parts.push("Format all citations in Bluebook style: Act Name § Section (Year).");
  } else if (prefs.citation_style === "oscola") {
    parts.push("Format all citations in OSCOLA style: Act Name YEAR, s Section.");
  }

  // Deep mode always uses full statutory extracts — density preference is ignored
  if (!forDeepMode) {
    if (prefs.output_density === "concise") {
      parts.push("Be concise. Provide summary analysis only. Avoid lengthy statutory quotations — cite the provision and summarise it.");
    } else if (prefs.output_density === "balanced") {
      parts.push("Balance thoroughness and conciseness. Include key statutory text but avoid extensive verbatim extracts.");
    }
  }

  return parts.length > 0 ? "\n\nUSER PREFERENCES:\n" + parts.join("\n") : "";
}

// ── Act-aware keyword → act_name mapping ────────────────────────────────────

type ActRule = { patterns: RegExp[]; actName: string };

const ACT_RULES: ActRule[] = [
  {
    patterns: [
      /\bcompan(?:y|ies)\b/i,
      /\bcompanies act\b/i,
      /\bprivate limited\b/i,
      /\bpublic limited\b/i,
      /\bsecp\b/i,
      /\bincorporat/i,
      /\bshareholder/i,
      /\bdirector(?:s)?\b/i,
      /\bregistrar of companies\b/i,
    ],
    actName: "Companies Act 2017",
  },
  {
    patterns: [
      /\bmurder\b/i,
      /\bqatl\b/i,
      /\bqisas\b/i,
      /\bdiyat\b/i,
      /\bpenal code\b/i,
      /\bppc\b/i,
      /\btheft\b/i,
      /\brobbery\b/i,
      /\bburglar/i,
      /\bextortion\b/i,
      /\bbribery\b/i,
      /\bfraud\b/i,
      /\bforgery\b/i,
      /\bcheating\b/i,
      /\bassault\b/i,
      /\bkidnap/i,
      /\brape\b/i,
      /\bzina\b/i,
      /\bdefamation\b/i,
      /\bcriminal\b/i,
    ],
    actName: "Pakistan Penal Code",
  },
];

/**
 * Detects which Pakistani Act the user is asking about. Returns a string
 * that will be used as an ilike prefix match against documents.act_name.
 *
 * Order matters: more specific patterns first (longer keywords before
 * shorter so "Code of Criminal Procedure" wins over "Code").
 */
function detectActFilter(text: string): string | null {
  const t = text.toLowerCase();

  // === CRIMINAL ===
  // CrPC (Code of Criminal Procedure)
  if (/\b(crpc|cr\.p\.c|cr\.\s*p\.\s*c|code\s+of\s+criminal\s+procedure|criminal\s+procedure\s+code)\b/.test(t)) {
    return "Code of Criminal Procedure";
  }
  // Anti-Terrorism Act
  if (/\b(ata|anti[\s-]?terrorism\s+act)\b/i.test(text)) {
    return "Anti-Terrorism Act";
  }
  // PPC (Pakistan Penal Code) — keep AFTER CrPC so "Code of Criminal Procedure" doesn't match this
  if (/\b(ppc|p\.p\.c|p\.\s*p\.\s*c|pakistan\s+penal\s+code|penal\s+code)\b/.test(t)) {
    return "Pakistan Penal Code";
  }

  // === CIVIL ===
  // CPC (Code of Civil Procedure)
  if (/\b(cpc|c\.p\.c|c\.\s*p\.\s*c|code\s+of\s+civil\s+procedure|civil\s+procedure\s+code)\b/.test(t)) {
    return "Code of Civil Procedure";
  }
  // Contract Act
  if (/\bcontract\s+act\b/.test(t)) {
    return "Contract Act";
  }
  // Specific Relief Act
  if (/\b(sra|specific\s+relief\s+act)\b/.test(t)) {
    return "Specific Relief Act";
  }
  // Sale of Goods Act
  if (/\b(sga|sale\s+of\s+goods\s+act)\b/.test(t)) {
    return "Sale of Goods Act";
  }
  // Limitation Act
  if (/\blimitation\s+act\b/.test(t)) {
    return "Limitation Act";
  }
  // Transfer of Property Act
  if (/\b(tpa|transfer\s+of\s+property\s+act)\b/.test(t)) {
    return "Transfer of Property Act";
  }

  // === FAMILY ===
  // Muslim Family Laws Ordinance
  if (/\b(mflo|muslim\s+family\s+laws?\s+ordinance)\b/.test(t)) {
    return "Muslim Family Laws Ordinance";
  }
  // Dissolution of Muslim Marriages
  if (/\b(dmma|dissolution\s+of\s+muslim\s+marriages?)\b/.test(t)) {
    return "Dissolution of Muslim Marriages";
  }
  // Family Courts Act
  if (/\bfamily\s+courts?\s+act\b/.test(t)) {
    return "Family Courts Act";
  }

  // === CONSTITUTIONAL ===
  // Constitution
  if (/\b(constitution\s+of\s+(?:the\s+)?(?:islamic\s+republic\s+of\s+)?pakistan|constitution|article\s+\d)/.test(t)) {
    return "Constitution of the Islamic";
  }

  // === FINANCIAL / TAX ===
  // Income Tax Ordinance
  if (/\b(ito|income\s+tax\s+ordinance)\b/.test(t)) {
    return "Income Tax Ordinance";
  }
  // Sales Tax Act
  if (/\bsales\s+tax\s+act\b/.test(t)) {
    return "Sales Tax Act";
  }
  // Federal Excise
  if (/\bfederal\s+excise\b/.test(t)) {
    return "Federal Excise";
  }
  // Customs Act
  if (/\bcustoms\s+act\b/.test(t)) {
    return "Customs Act";
  }

  // === COMMERCIAL ===
  // Companies Act 2017
  if (/\bcompanies\s+act,?\s*2017\b/.test(t)) {
    return "Companies Act, 2017";
  }
  // Companies Ordinance 1984
  if (/\bcompanies\s+ordinance,?\s*1984\b/.test(t)) {
    return "Companies Ordinance, 1984";
  }
  // Companies Act (general, no year) — keep AFTER specific years
  if (/\bcompanies\s+act\b/.test(t)) {
    return "Companies Act";
  }
  // Negotiable Instruments Act
  if (/\b(nia|negotiable\s+instruments?\s+act)\b/.test(t)) {
    return "Negotiable Instruments Act";
  }
  // Partnership Act
  if (/\bpartnership\s+act\b/.test(t)) {
    return "Partnership Act";
  }
  // Arbitration Act
  if (/\barbitration\s+act\b/.test(t)) {
    return "Arbitration Act";
  }
  // Securities Act
  if (/\bsecurities\s+act\b/.test(t)) {
    return "Securities Act";
  }

  // === EVIDENCE / OTHER ===
  // Qanun-e-Shahadat
  if (/\b(qso|qanun[\s-]?e[\s-]?shahadat)\b/i.test(text)) {
    return "Qanun-e-Shahadat";
  }
  // PECA
  if (/\b(peca|prevention\s+of\s+electronic\s+crimes?)\b/.test(t)) {
    return "Prevention of Electronic Crimes Act";
  }
  // Elections Act
  if (/\belections?\s+act\b/.test(t)) {
    return "Elections Act";
  }

  return null;
}

function isCaseLawQuery(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\b(case|judgment|judgement|ruling|verdict|decision)\b/.test(t) &&
    /\b(court|sc|hc|tribunal|justice|hon'?ble|pld|plj|mld|ylr|cld|supreme|high court|federal shariat|federal sharia)\b/.test(t)
  ) ||
  /\bv\.\s*[A-Z]/.test(text) ||                  // "X v. Y" pattern
  /\b(asghar khan|panama|reko diq|memogate|nro)\b/i.test(text) ||  // famous case names
  /\bArticle 184\(3\)\b/i.test(text);             // suo motu jurisdiction
}

// ── Legal query classifier ───────────────────────────────────────────────────

const LEGAL_SIGNALS = [
  /\bsection\b/i, /\bsec\.\s*\d/i, /§\s*\d/i,
  /\bact\b/i, /\bstatut/i, /\bordinance\b/i, /\brule\s+\d/i,
  /\blaw\b/i, /\blegal\b/i, /\bliabilit/i, /\boffenc?e\b/i,
  /\bpunishment\b/i, /\bpenalt/i, /\bconvict/i, /\bsentenc/i,
  /\bcourt\b/i, /\bjudg(?:e|ment|ment)\b/i, /\btribunal\b/i,
  /\bjurisdiction\b/i, /\bappeal\b/i, /\bpetition\b/i,
  /\baccused\b/i, /\bdefendant\b/i, /\bplaintiff\b/i,
  /\bproscut/i, /\bindictment\b/i, /\bcharge\b/i,
  /\bcontract\b/i, /\btort\b/i, /\bnegligenc/i,
  /\bwrit\b/i, /\binjunction\b/i, /\bremedy\b/i,
  /\brights?\b/i, /\bduty\b/i, /\bobligat/i,
  /\bfir\b/i, /\bpolice\b/i, /\barrest\b/i, /\bbail\b/i,
  /\bhereditar/i, /\binherit/i, /\bwill\b.*\bestate\b/i,
  /\bppc\b/i, /\bcrpc\b/i, /\bsecp\b/i, /\bsro\b/i,
  /\bqisas\b/i, /\bdiyat\b/i, /\bqatl\b/i, /\bzina\b/i,
  /\bhudood\b/i, /\bfata\b/i,
  /\bwhat (?:is|are) the (?:law|rule|punishment|penalty|provision)\b/i,
  /\bunder (?:the )?(?:law|act|section|ppc|crpc)\b/i,
  /\blegally\b/i, /\bconstitution(?:al)?\b/i,
  /\bhow (?:do|does|can|is|are) (?:\w+ )?(?:sue|prosecut|appeal|file|claim|defend)\b/i,
];

const CASUAL_OVERRIDES = [
  /^h(?:i|ello|ey|owdy)[!.,]?\s*$/i,
  /^good\s+(?:morning|afternoon|evening|night)[!.,]?\s*$/i,
  /^(?:thanks?|thank you|thx|ty)[!.,]?\s*$/i,
  /^(?:ok(?:ay)?|sure|got it|sounds good|great|perfect)[!.,]?\s*$/i,
  /^(?:bye|goodbye|see you|cya)[!.,]?\s*$/i,
  /^(?:yes|no|yeah|nope|yep)[!.,]?\s*$/i,
  /^(?:tell me a joke|make me laugh|something funny)/i,
  /^(?:who are you|what are you|what can you do)[?!.,]?\s*$/i,
  /^(?:how are you|how's it going|how do you do)[?!.,]?\s*$/i,
];

function isLegalQuery(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 12 && CASUAL_OVERRIDES.some((re) => re.test(trimmed))) return false;
  if (CASUAL_OVERRIDES.some((re) => re.test(trimmed))) return false;
  return LEGAL_SIGNALS.some((re) => re.test(trimmed));
}

// ── SSE helper ───────────────────────────────────────────────────────────────

function sseEvent(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

// ── Route types ──────────────────────────────────────────────────────────────

type Params = { params: Promise<{ chatId: string }> };

type RagChunk = {
  id:             string;
  file_name:      string;
  chunk_index:    number;
  content:        string;
  similarity:     number;
  source:         "case" | "global";
  section_number: string | null;
  act_name:       string | null;
  title?:         string | null;
  chapter?:       string | null;
  year?:          number | null;
};

// ── POST handler ─────────────────────────────────────────────────────────────

export async function POST(request: Request, { params }: Params) {
  const { chatId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { content?: string; mode?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request body" }, { status: 400 });
  }

  const userContent: string = (body.content ?? "").trim();
  if (!userContent) {
    return NextResponse.json({ success: false, error: "content is required" }, { status: 400 });
  }

  // ── 1. Parallel DB lookups: chat ownership + user preferences + platform settings + memory ──
  const [chatResult, prefsResult, platformResult, memoryResult] = await Promise.all([
    supabase
      .from("chats")
      .select("id, title, case_id")
      .eq("id", chatId)
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("user_preferences")
      .select("legal_role, default_mode, writing_style, citation_style, output_density")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("user_platform_settings")
      .select("routing_strategy, web_intelligence, cross_validation, draft_engine")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("imported_memory")
      .select("title, content, case_id")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(8),
  ]);

  if (chatResult.error) {
    return NextResponse.json({ success: false, error: "Failed to load chat session" }, { status: 500 });
  }
  if (!chatResult.data) {
    return NextResponse.json({ success: false, error: "Chat not found" }, { status: 404 });
  }

  const chat            = chatResult.data;
  const prefs           = prefsResult.data  as UserPrefs | null;
  const platform        = platformResult.data;
  const userDefaultMode = prefs?.default_mode ?? "fast";

  // Build memory context block — global memories + case-specific if we have a case
  const rawMemories = memoryResult.data ?? [];
  const caseMemories   = chat.case_id ? rawMemories.filter(m => m.case_id === chat.case_id) : [];
  const globalMemories = rawMemories.filter(m => m.case_id === null);
  const memoryItems    = [...caseMemories, ...globalMemories];

  const memorySection = memoryItems.length > 0
    ? "\n\n════ IMPORTED MEMORY (PREVIOUS CONVERSATIONS) ════\n" +
      "The user has imported the following conversation history from other AI assistants. " +
      "Use this as background context when relevant — do not quote it verbatim unless asked.\n\n" +
      memoryItems.map(m => `### ${m.title}\n${m.content}`).join("\n\n---\n\n") +
      "\n════ END IMPORTED MEMORY ════"
    : "";
  const webEnabled      = platform?.web_intelligence !== false;
  const draftEngine     = platform?.draft_engine ?? "manus";

  // ── 2. Resolve mode ──────────────────────────────────────────────────────────
  const uiMode = resolveMode(body.mode, userContent, userDefaultMode);
  const { model: llmModel, maxTokens } = MODE_CONFIG[uiMode];

  // ── 3. Persist user message ──────────────────────────────────────────────────
  const { error: insertUserErr } = await supabase
    .from("messages")
    .insert({ chat_id: chatId, role: "user", content: userContent });

  if (insertUserErr) {
    return NextResponse.json({ success: false, error: "Failed to save message" }, { status: 500 });
  }

  // ── 4. Legal classification + RAG retrieval ──────────────────────────────────
  const legalQuery = isLegalQuery(userContent);
  const actFilter  = legalQuery ? detectActFilter(userContent) : null;
  let   ragChunks: RagChunk[] = [];
  let   sectionNumber: string | null = null;

  if (legalQuery) {
    // ── 4a. DETERMINISTIC: explicit section reference ──────────────────────────
    const sectionMatch = userContent.match(
      /(?:section|sec\.?|§|article|art\.?)\s*(\d+(?:-?[A-Z]+)?)/i
    );

    if (sectionMatch) {
      sectionNumber = sectionMatch[1].toUpperCase();

      // Search global KB
      let globalQ = supabase
        .from("documents")
        .select("id, file_name, chunk_index, content, section_number, act_name, title, chapter, year")
        .eq("scope", "global")
        .ilike("section_number", sectionNumber)
        .limit(RAG_TOP_K);
      if (actFilter) globalQ = globalQ.ilike("act_name", `${actFilter}%`);

      // Search case docs in parallel (if chat is linked to a case)
      const caseQ = chat.case_id
        ? supabase
            .from("documents")
            .select("id, file_name, chunk_index, content, section_number, act_name, title, chapter, year")
            .eq("scope", "case")
            .eq("case_id", chat.case_id)
            .ilike("section_number", sectionNumber)
            .limit(RAG_TOP_K)
        : Promise.resolve({ data: null });

      let [{ data: globalRows }, { data: caseRows }] = await Promise.all([globalQ, caseQ]);

      // If act-filter narrowed to zero, retry deterministic query WITHOUT act_name
      // — broader match, still scoped by section_number
      if (actFilter && (!globalRows || globalRows.length === 0) && sectionNumber) {
        const { data: retryRows } = await supabase
          .from("documents")
          .select("id, file_name, chunk_index, content, section_number, act_name, title, chapter, year, source_url")
          .eq("scope", "global")
          .ilike("section_number", sectionNumber)
          .limit(RAG_TOP_K);
        if (retryRows && retryRows.length > 0) {
          globalRows = retryRows;
          console.log(`[RAG] Act-filter retry succeeded: ${retryRows.length} chunks for section ${sectionNumber} (act filter dropped)`);
        }
      }

      // Retry without hyphens if section number has them and zero rows came back.
      // Pakistani amendment-inserted sections may be stored as "489F" instead
      // of "489-F" depending on how the PDF was chunked.
      if (sectionNumber && sectionNumber.includes("-") && (!globalRows || globalRows.length === 0)) {
        const stripped = sectionNumber.replace(/-/g, "");
        console.log(`[RAG] Hyphen-strip retry: section "${sectionNumber}" → "${stripped}"`);

        let retryQ = supabase
          .from("documents")
          .select("id, file_name, chunk_index, content, section_number, act_name, title, chapter, year, source_url")
          .eq("scope", "global")
          .ilike("section_number", stripped)
          .limit(RAG_TOP_K);

        if (actFilter) {
          retryQ = retryQ.ilike("act_name", `${actFilter}%`);
        }

        const { data: hyphenRetryRows } = await retryQ;
        if (hyphenRetryRows && hyphenRetryRows.length > 0) {
          globalRows = hyphenRetryRows;
          console.log(`[RAG] Hyphen-strip retry succeeded: ${hyphenRetryRows.length} chunks`);
        }
      }

      // ALSO try the inverse: if section_number has no hyphen but is digits+letter,
      // try inserting a hyphen (e.g., "489F" → "489-F"). This handles the case
      // where corpus has hyphenated stored but query came without.
      if (sectionNumber && !sectionNumber.includes("-") && (!globalRows || globalRows.length === 0)) {
        const withHyphen = sectionNumber.replace(/^(\d+)([A-Z]+)$/, "$1-$2");
        if (withHyphen !== sectionNumber) {
          console.log(`[RAG] Hyphen-insert retry: section "${sectionNumber}" → "${withHyphen}"`);

          let retryQ2 = supabase
            .from("documents")
            .select("id, file_name, chunk_index, content, section_number, act_name, title, chapter, year, source_url")
            .eq("scope", "global")
            .ilike("section_number", withHyphen)
            .limit(RAG_TOP_K);

          if (actFilter) {
            retryQ2 = retryQ2.ilike("act_name", `${actFilter}%`);
          }

          const { data: hyphenInsertRows } = await retryQ2;
          if (hyphenInsertRows && hyphenInsertRows.length > 0) {
            globalRows = hyphenInsertRows;
            console.log(`[RAG] Hyphen-insert retry succeeded: ${hyphenInsertRows.length} chunks`);
          }
        }
      }

      const mapRow = (r: Record<string, unknown>, source: "case" | "global"): RagChunk => ({
        id:             String(r.id),
        file_name:      String(r.file_name),
        chunk_index:    Number(r.chunk_index),
        content:        String(r.content),
        similarity:     1.0,
        source,
        section_number: r.section_number ? String(r.section_number) : null,
        act_name:       r.act_name       ? String(r.act_name)       : null,
        title:          r.title          ? String(r.title)          : null,
        chapter:        r.chapter        ? String(r.chapter)        : null,
        year:           r.year           ? Number(r.year)           : null,
      });

      const combined = [
        ...((caseRows   ?? []) as Record<string, unknown>[]).map((r) => mapRow(r, "case")),
        ...((globalRows ?? []) as Record<string, unknown>[]).map((r) => mapRow(r, "global")),
      ];

      // Dedup by id
      const seen = new Set<string>();
      ragChunks = combined.filter((c) => { if (seen.has(c.id)) return false; seen.add(c.id); return true; });
    }

    // ── 4b. VECTOR: fallback when no deterministic match ──────────────────────
    if (ragChunks.length === 0) {
      try {
        const embedding        = await embedText(userContent);
        const shouldSearchCase = !!chat.case_id;

        const globalQuery = actFilter
          ? supabase
              .rpc("match_global_documents", {
                query_embedding: embedding,
                match_count:     RAG_TOP_K * 2,
                match_threshold: RAG_THRESHOLD,
              })
              .ilike("act_name", `${actFilter}%`)
          : supabase.rpc("match_global_documents", {
              query_embedding: embedding,
              match_count:     RAG_TOP_K * 2,
              match_threshold: RAG_THRESHOLD,
            });

        const [caseResult, globalResult] = await Promise.all([
          shouldSearchCase
            ? supabase.rpc("match_documents_by_case", {
                query_embedding: embedding,
                match_count:     RAG_TOP_K,
                target_case:     chat.case_id,
                match_threshold: RAG_THRESHOLD,
              })
            : Promise.resolve({ data: null, error: null }),
          globalQuery,
        ]);

        const mapChunk = (r: Record<string, unknown>, source: "case" | "global"): RagChunk => ({
          id:             String(r.id),
          file_name:      String(r.file_name),
          chunk_index:    Number(r.chunk_index),
          content:        String(r.content),
          similarity:     Number(r.similarity),
          source,
          section_number: r.section_number ? String(r.section_number) : null,
          act_name:       r.act_name       ? String(r.act_name)       : null,
          title:          r.title          ? String(r.title)          : null,
          chapter:        r.chapter        ? String(r.chapter)        : null,
          year:           r.year           ? Number(r.year)           : null,
        });

        const caseChunks: RagChunk[]   = ((caseResult.data   ?? []) as Record<string, unknown>[]).map((r) => mapChunk(r, "case"));
        const globalChunks: RagChunk[] = ((globalResult.data ?? []) as Record<string, unknown>[]).map((r) => mapChunk(r, "global"));

        // Dedup by id, then by (act_name, section_number) keeping highest similarity
        const byId         = new Map<string, RagChunk>();
        const byActSection = new Map<string, RagChunk>();

        for (const chunk of [...caseChunks, ...globalChunks]) {
          if (byId.has(chunk.id)) continue;
          byId.set(chunk.id, chunk);

          if (chunk.act_name && chunk.section_number) {
            const key      = `${chunk.act_name}|||${chunk.section_number}`;
            const existing = byActSection.get(key);
            if (!existing || chunk.similarity > existing.similarity) {
              byActSection.set(key, chunk);
            }
          }
        }

        ragChunks = Array.from(byId.values())
          .filter((chunk) => {
            if (!chunk.act_name || !chunk.section_number) return true;
            const key = `${chunk.act_name}|||${chunk.section_number}`;
            return byActSection.get(key)?.id === chunk.id;
          })
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, RAG_TOP_K);
      } catch {
        // Vector search failure is non-fatal; continue with empty context
      }
    }
  }

  // Quality gate: even if chunks were retrieved, demote to no-context if
  // the top result is weakly related. Prevents hallucination from low-quality
  // matches that the LLM might use as a stylistic template.
  const STRONG_MATCH_THRESHOLD = 0.50;
  const topSimilarity = ragChunks[0]?.similarity ?? 0;
  const hasStrongMatch = ragChunks.length > 0 && topSimilarity >= STRONG_MATCH_THRESHOLD;

  // Deterministic-path chunks (from ilike on section_number) don't carry a
  // similarity score — those are exact-match by design, treat as strong.
  const hasDeterministicMatch = ragChunks.some(
    (c) => c.section_number && sectionNumber && c.section_number.toString().trim() === sectionNumber.trim()
  );

  const useRagContext = ragChunks.length > 0 && (hasStrongMatch || hasDeterministicMatch);

  if (!useRagContext && ragChunks.length > 0) {
    console.log(`[RAG] DEMOTED to no-context: ${ragChunks.length} chunks retrieved but top similarity ${topSimilarity.toFixed(3)} < ${STRONG_MATCH_THRESHOLD} and no deterministic match`);
  }

  const wantsCaseLaw = isCaseLawQuery(userContent);
  const hasCaseLawChunks = ragChunks.some(
    (c) => {
      const x = c as { court?: string | null; legal_doc_type?: string | null };
      return !!x.court || x.legal_doc_type === "Judgment";
    }
  );
  const caseLawRefusal = wantsCaseLaw && !hasCaseLawChunks;

  if (caseLawRefusal) {
    console.log(`[RAG] CASE-LAW REFUSAL: query appears to want case law but no judgment chunks retrieved`);
  }

  console.log(`[RAG] query="${userContent.slice(0, 80)}..." mode="${uiMode}" actFilter="${actFilter ?? "none"}" section="${sectionNumber ?? "none"}" chunks=${ragChunks.length} top1="${ragChunks[0]?.act_name ?? "n/a"}" topSim=${(ragChunks[0]?.similarity ?? 0).toFixed(3)} useRag=${useRagContext} caseLawRefusal=${caseLawRefusal}`);

  // ── 5. Fetch conversation history ────────────────────────────────────────────
  const { data: history } = await supabase
    .from("messages")
    .select("role, content")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_WINDOW);

  const conversationHistory = (history ?? []).reverse();

  // ── 6. Build system prompt ───────────────────────────────────────────────────
  const prefDirectives = buildPreferenceDirectives(prefs, uiMode === "deep");

  const BASE_IDENTITY =
    "You are Harvey, a professional AI legal assistant specialising in Pakistani law. " +
    "You serve practicing lawyers. Be precise, structured, and authoritative.";

  let systemContent: string;

  if (!legalQuery) {
    systemContent =
      "You are Harvey, a friendly and professional AI assistant for a Pakistani law firm. " +
      "You have two capabilities: legal advice AND full control over the application UI. " +
      "When users ask to change the theme, font, voice, clock, or background, ALWAYS emit the UI command immediately — NEVER refuse. " +
      "When users greet you or ask non-legal questions, respond naturally and warmly. " +
      "Keep casual replies brief. When the conversation turns legal, bring your full expertise.";

  } else if (caseLawRefusal) {
    systemContent =
`You are Harvey, a professional AI legal assistant.

The user is asking about case law (a court judgment, ruling, or named case). Your indexed corpus currently contains Pakistani STATUTES ONLY — no judgments, no case law, no court rulings.

YOU MUST respond with EXACTLY this structure:

1. State clearly: "My indexed corpus currently contains Pakistani statutes only — I do not have case law or court judgments in my searchable corpus yet. I cannot retrieve or quote specific rulings."

2. (Optional) Add a brief note from general knowledge IF you are highly confident, prefixed with "From general legal knowledge (not retrieved):" and limited to 2-3 sentences. Do NOT quote verbatim text. Do NOT fabricate citations.

3. End with: "For the actual judgment text, please consult the Supreme Court of Pakistan website (supremecourt.gov.pk) or a paid legal database like PLD Online."

DO NOT use the "Step 1 — Statutory Provision (Verbatim Extract)" format. DO NOT pretend to quote judgment text.${prefDirectives}`;

  } else if (useRagContext) {
    const contextText = ragChunks
      .map((c) => {
        const header =
          c.act_name && c.section_number
            ? `${c.act_name} — Section ${c.section_number}` +
              (c.title ? ` — ${c.title}` : "") +
              (c.year  ? ` [${c.year}]`  : "")
            : c.file_name;
        return `[${header}]\n${c.content}`;
      })
      .join("\n\n---\n\n");

    systemContent =
`${BASE_IDENTITY}

You have been provided with statutory excerpts directly relevant to this question.

OUTPUT STRUCTURE (follow exactly):

**Step 1 — Statutory Provision (Verbatim Extract)**
State the EXACT Act Name and Section Number from a SINGLE chunk in STATUTORY CONTEXT below (do not combine fields from different chunks). Format: Act Name — Section Number — Section Title (if available in the same chunk).
Then quote the exact relevant text in quotation marks, copying verbatim from that single chunk. Do NOT paraphrase. Do NOT abbreviate. Do NOT combine text from multiple chunks into one quotation.

**Step 2 — Legal Analysis**
Concise explanation (5–8 lines). Legal effect, practical meaning, application.
No unnecessary theory.

**Step 3 — Citation**
Act Name, §Section Number${prefDirectives}

EXACT-MATCH DEFINITION:

An EXACT match exists when a chunk in STATUTORY CONTEXT has BOTH:
  (a) an act_name that contains (or is contained in) the Act the user asked about (e.g., user asks "Pakistan Penal Code" and chunk's act_name is "Pakistan Penal Code (PPC),1860 (Under Review)" → match), AND
  (b) a section_number that matches the section the user asked about (e.g., user asks "Section 302" and chunk's section_number is "302" → match).

When an EXACT match exists, you MUST quote from that chunk using the Step 1 / Step 2 / Step 3 format. Rule 3 below does NOT apply when an exact match exists.

Only use the Rule 3 fallback when NO chunk in context is an exact match for what the user asked.

CRITICAL RULES (follow these to avoid hallucination):

1. Every quotation in Step 1 must appear verbatim in STATUTORY CONTEXT below. Before quoting, locate the exact substring in the context. If you cannot find it, you MUST NOT quote anything in quotation marks.

2. NEVER combine the Act name from one chunk with the section number from another chunk. Each citation must come from a SINGLE chunk where both the Act name AND section number appear together.

3. If NO chunk in STATUTORY CONTEXT is an exact match per the EXACT-MATCH DEFINITION above, AND the user asked about a specific Act + Section, respond instead with:

   "My corpus contains related provisions but not the exact provision you asked for. The closest matches are: [list act_name and section_number from chunks in STATUTORY CONTEXT]. Would you like me to summarize one of these instead?"

4. NEVER invent a section number. If a section number is not present verbatim in STATUTORY CONTEXT, you cannot cite it.

5. NEVER invent statutory text. If you find yourself writing legal text that "sounds right" but isn't in the context, STOP and use the fallback response from Rule 3.

6. If STATUTORY CONTEXT contains chunks but they are off-topic from the user's question (e.g., user asks about online defamation but context contains general defamation provisions from a different Act), follow Rule 3 — explicitly state the mismatch and offer the closest matches.

7. The Step 1 / Step 2 / Step 3 format is reserved for grounded answers ONLY. If you cannot ground in retrieved chunks, you MUST switch to the Rule 3 fallback response without the formatted structure.

STATUTORY CONTEXT:
${contextText}`;

  } else {
    systemContent =
`You are Harvey, a professional AI legal assistant specialising in Pakistani law. You serve practicing lawyers.

No statutory excerpts were retrieved from your indexed Pakistani legal corpus for this specific query.

YOU MUST FOLLOW THIS PROTOCOL:

1. DO NOT use the "Step 1 — Statutory Provision (Verbatim Extract)" format. That format is reserved ONLY for text retrieved from the corpus.

2. Begin your answer with this exact disclosure:
   "I do not have a directly relevant provision in my indexed Pakistani legal corpus for this query."

3. After the disclosure, you may provide general legal information from your training, but:
   - DO NOT quote any text in quotation marks (you are not retrieving text)
   - DO NOT use the word "verbatim"
   - DO NOT invent section numbers
   - DO NOT include "Sources" or citation blocks formatted as if retrieved
   - Phrase everything as general guidance: "Under Pakistani law, generally..."
   - End with: "For the exact statutory text, please verify with the official Pakistan Code at pakistancode.gov.pk."

4. If you are uncertain, say so directly. Do not fabricate plausible-sounding legal text.${prefDirectives}`;
  }

  // Append imported memory context (if any) then UI control instructions
  if (memorySection) systemContent += memorySection;
  systemContent += `\n\n${UI_COMMAND_INSTRUCTIONS}`;

  // Sources saved to DB (only chunks that contributed to context).
  // Gated by useRagContext: if chunks were demoted (weak similarity) we did
  // not feed them to the LLM, so we must not surface them as sources either.
  // Also suppressed during case-law refusal — the assistant is explicitly
  // declining to use any retrieved chunks for that branch.
  const sources =
    useRagContext && !caseLawRefusal
      ? ragChunks.map((c) => ({
          file_name:      c.file_name,
          similarity:     c.similarity,
          chunk_index:    c.chunk_index,
          act_name:       c.act_name       ?? null,
          section_number: c.section_number ?? null,
          title:          c.title          ?? null,
        }))
      : null;

  // claudeContextText feeds deep/web/crosscheck/draft modes via routeAIRequest.
  // Gate it the same way so downstream LLMs don't see demoted chunks.
  // Also suppress during case-law refusal — deep/web/draft must not see any
  // chunks when the user is asking about case law we don't have.
  const claudeContextText = useRagContext && !caseLawRefusal
    ? ragChunks
        .map((c) => {
          const header =
            c.act_name && c.section_number
              ? `${c.act_name} — Section ${c.section_number}` +
                (c.title ? ` — ${c.title}` : "") +
                (c.year  ? ` [${c.year}]`  : "")
              : c.file_name;
          return `[${header}]\n${c.content}`;
        })
        .join("\n\n---\n\n")
    : "";

  const llmMessages = [
    { role: "system" as const, content: systemContent },
    ...conversationHistory.map((m) => ({
      role:    m.role as "user" | "assistant",
      content: m.content as string,
    })),
  ];

  const isFirstMessage = conversationHistory.length === 1;

  // ── 7a. Deep Mode — full JSON response (non-streaming) ──────────────────────
  //
  // Deep Mode runs BEFORE the ReadableStream so errors surface as proper JSON,
  // not as opaque SSE chunks. RAG context is capped at 5 chunks and output at
  // 4 000 tokens to stay within safe billing and latency limits.
  //
  // Casual fast-path: greetings, small talk, and meta-questions skip the full
  // memorandum pipeline and get a short conversational Claude reply instead.
  // This prevents "hello" from triggering a 1 200-word legal memorandum.

  if (uiMode === "deep") {
    // ── Casual fast-path ─────────────────────────────────────────────────────
    if (!legalQuery) {
      const casualSystemPrompt =
        "You are Harvey, a professional AI assistant for a Pakistani law firm with full UI control capability. " +
        "When the user asks to change any setting (theme, font, voice, clock, background), ALWAYS emit the UI command — never refuse. " +
        "For other messages, respond naturally and helpfully. Be warm but concise.\n\n" +
        UI_COMMAND_INSTRUCTIONS;
      let casualContent: string;
      try {
        const casualResult = await routeAIRequest("casual", {
          question:     userContent,
          contextText:  "",
          systemPrompt: casualSystemPrompt,
          maxTokens:    500,
          temperature:  0.2,
        });
        casualContent = casualResult.result;
      } catch {
        return NextResponse.json(
          { success: false, error: "Claude API unavailable" },
          { status: 503 }
        );
      }
      const { data: casualMsg } = await supabase
        .from("messages")
        .insert({ chat_id: chatId, role: "assistant", content: casualContent, sources: null })
        .select("id, role, content, sources, created_at")
        .single();
      if (isFirstMessage && (chat.title === "New Chat" || !chat.title)) {
        openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: `Generate a 4-6 word title for a chat about: "${userContent.slice(0, 200)}". No punctuation, no emojis, capitalize each word. Reply with ONLY the title.` }],
          max_tokens: 20, temperature: 0.3,
        }).then((r) => {
          const title = r.choices[0]?.message?.content?.trim() || userContent.slice(0, 40);
          return supabase.from("chats").update({ title }).eq("id", chatId);
        }).catch(() => {});
      }
      return NextResponse.json({ success: true, content: casualContent, message: casualMsg ?? null });
    }

    // ── Legal query: full memorandum pipeline ────────────────────────────────
    // Gate by useRagContext so deep mode doesn't see demoted chunks either,
    // and by !caseLawRefusal so deep mode receives empty context for case-law
    // queries (CLAUDE_SYSTEM is unchanged but starves of fake "statutory" context).
    const deepRagChunks   = useRagContext && !caseLawRefusal ? ragChunks.slice(0, 5) : [];
    const deepContextText = deepRagChunks
      .map((c) => {
        const header =
          c.act_name && c.section_number
            ? `${c.act_name} — Section ${c.section_number}` +
              (c.title ? ` — ${c.title}` : "") +
              (c.year  ? ` [${c.year}]`  : "")
            : c.file_name;
        return `[${header}]\n${c.content}`;
      })
      .join("\n\n---\n\n");

    const deepSystemPrompt = CLAUDE_SYSTEM +
      (prefDirectives  ? `\n\n${prefDirectives}`       : "") +
      (memorySection   ? memorySection                 : "") +
      `\n\n${UI_COMMAND_INSTRUCTIONS}`;

    let deepContent: string;
    try {
      const deepResult = await routeAIRequest("legal_deep", {
        question:     userContent,
        contextText:  deepContextText,
        systemPrompt: deepSystemPrompt,
        maxTokens:    4000,
        temperature:  0.2,
      });
      deepContent = deepResult.result;
    } catch {
      return NextResponse.json(
        { success: false, error: "Claude API unavailable" },
        { status: 503 }
      );
    }

    const deepSources = deepRagChunks.length > 0
      ? deepRagChunks.map((c) => ({
          file_name:      c.file_name,
          similarity:     c.similarity,
          chunk_index:    c.chunk_index,
          act_name:       c.act_name       ?? null,
          section_number: c.section_number ?? null,
          title:          c.title          ?? null,
        }))
      : null;

    const { data: deepMsg } = await supabase
      .from("messages")
      .insert({ chat_id: chatId, role: "assistant", content: deepContent, sources: deepSources })
      .select("id, role, content, sources, created_at")
      .single();

    if (isFirstMessage && (chat.title === "New Chat" || !chat.title)) {
      openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{
          role:    "user",
          content: `Generate a 4-6 word title for a chat about: "${userContent.slice(0, 200)}". No punctuation, no emojis, capitalize each word. Reply with ONLY the title.`,
        }],
        max_tokens:  20,
        temperature: 0.3,
      }).then((res) => {
        const title = res.choices[0]?.message?.content?.trim() || userContent.slice(0, 40);
        return supabase.from("chats").update({ title }).eq("id", chatId);
      }).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      content: deepContent,
      message: deepMsg ?? null,
    });
  }

  // ── 7b. Premium Mode — IRAC deterministic pipeline (legal queries only) ───────
  //
  // Non-streaming. Forces structured IRAC JSON, validates all citations against
  // Supabase, computes confidence_score and risk_level.
  // Premium mode with non-legal queries falls through to the SSE block below.

  if (uiMode === "premium" && legalQuery) {
    // Gate premium IRAC context by useRagContext so demoted chunks don't flow
    // into the IRAC pipeline either, and by !caseLawRefusal so the IRAC
    // pipeline doesn't see fabricated "statutory" matches for case-law queries.
    const premiumChunks      = useRagContext && !caseLawRefusal ? ragChunks : [];
    const premiumContextText = premiumChunks
      .map((c) => {
        const header =
          c.act_name && c.section_number
            ? `${c.act_name} — Section ${c.section_number}` +
              (c.title ? ` — ${c.title}` : "") +
              (c.year  ? ` [${c.year}]`  : "")
            : c.file_name;
        return `[${header}]\n${c.content}`;
      })
      .join("\n\n---\n\n");

    const iracPrompt = buildIracSystemPrompt(premiumContextText, prefDirectives);

    const iracResult = await runIracPipeline(
      userContent,
      premiumContextText,
      premiumChunks,
      supabase,
      iracPrompt,
    );

    if (iracResult.ok === false) {
      console.error("[IRAC route failure]", iracResult);
      await supabase.from("messages").insert({
        chat_id: chatId,
        role:    "assistant",
        content: JSON.stringify({ error: iracResult.error }),
        sources: null,
      });
      return NextResponse.json({ success: false, error: iracResult.error }, { status: 422 });
    }

    const premiumSources = premiumChunks.length > 0
      ? premiumChunks.map((c) => ({
          file_name:      c.file_name,
          similarity:     c.similarity,
          chunk_index:    c.chunk_index,
          act_name:       c.act_name       ?? null,
          section_number: c.section_number ?? null,
          title:          c.title          ?? null,
        }))
      : null;

    const { data: premiumMsg } = await supabase
      .from("messages")
      .insert({
        chat_id: chatId,
        role:    "assistant",
        content: JSON.stringify(iracResult.data),
        sources: premiumSources,
      })
      .select("id, role, content, sources, created_at")
      .single();

    if (isFirstMessage && (chat.title === "New Chat" || !chat.title)) {
      openai.chat.completions.create({
        model:    "gpt-4o-mini",
        messages: [{
          role:    "user",
          content: `Generate a 4-6 word title for a chat about: "${userContent.slice(0, 200)}". No punctuation, no emojis, capitalize each word. Reply with ONLY the title.`,
        }],
        max_tokens:  20,
        temperature: 0.3,
      }).then((res) => {
        const title = res.choices[0]?.message?.content?.trim() || userContent.slice(0, 40);
        return supabase.from("chats").update({ title }).eq("id", chatId);
      }).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      irac:    iracResult.data,
      message: premiumMsg ?? null,
    });
  }

  // ── 7c. LLM → SSE stream (all remaining modes) ───────────────────────────────
  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      let fullContent = "";

      const emit = (chunk: string) => {
        fullContent += chunk;
        controller.enqueue(encoder.encode(sseEvent({ type: "chunk", content: chunk })));
      };

      const emitSingle = (text: string) => {
        fullContent = text;
        controller.enqueue(encoder.encode(sseEvent({ type: "chunk", content: text })));
      };

      const emitError = () => {
        fullContent = "An error occurred. Please try again.";
        controller.enqueue(encoder.encode(sseEvent({ type: "chunk", content: fullContent })));
      };

      // ── web ───────────────────────────────────────────────────────────────────
      if (uiMode === "web") {
        if (!webEnabled) {
          try {
            const fb = await openai.chat.completions.create({
              model: MODE_CONFIG.fast.model, messages: llmMessages, temperature: 0.2,
              max_tokens: MODE_CONFIG.fast.maxTokens, stream: true,
            });
            for await (const chunk of fb) {
              const delta = chunk.choices[0]?.delta?.content ?? "";
              if (delta) emit(delta);
            }
          } catch {
            emitError();
          }
        } else {
          try {
            const webResults = await callBraveSearch(userContent);
            const webSystem =
              `${BASE_IDENTITY}\n\n` +
              `You have access to live web search results. Use them alongside any statutory ` +
              `context to provide a current, well-sourced legal analysis. Cite sources by number.` +
              `\n\nWEB SEARCH RESULTS:\n${webResults}` +
              (claudeContextText ? `\n\nSTATUTORY CONTEXT:\n${claudeContextText}` : "") +
              prefDirectives;
            const webMessages = [
              { role: "system" as const, content: webSystem },
              ...conversationHistory.map((m) => ({ role: m.role as "user" | "assistant", content: m.content as string })),
            ];
            const webStream = await openai.chat.completions.create({
              model: "gpt-4o", messages: webMessages, temperature: 0.2, max_tokens: 2048, stream: true,
            });
            for await (const chunk of webStream) {
              const delta = chunk.choices[0]?.delta?.content ?? "";
              if (delta) emit(delta);
            }
          } catch {
            try {
              const fb = await openai.chat.completions.create({
                model: MODE_CONFIG.fast.model, messages: llmMessages, temperature: 0.2,
                max_tokens: MODE_CONFIG.fast.maxTokens, stream: true,
              });
              for await (const chunk of fb) {
                const delta = chunk.choices[0]?.delta?.content ?? "";
                if (delta) emit(delta);
              }
            } catch {
              emitError();
            }
          }
        }

      // ── crosscheck ────────────────────────────────────────────────────────────
      } else if (uiMode === "crosscheck") {
        try {
          const r = await routeAIRequest("crosscheck", {
            question:    userContent,
            contextText: claudeContextText,
            maxTokens:   4000,
            temperature: 0.2,
          });
          emitSingle(r.result);
        } catch {
          emitError();
        }

      // ── draft ─────────────────────────────────────────────────────────────────
      } else if (uiMode === "draft") {
        try {
          const taskType: TaskType = draftEngine === "claude" ? "legal_deep" : "draft";
          const r = await routeAIRequest(taskType, {
            question:    userContent,
            contextText: claudeContextText,
            maxTokens:   4000,
            temperature: 0.2,
          });
          emitSingle(r.result);
        } catch {
          emitError();
        }

      // ── fast / documents / premium (OpenAI streaming) ─────────────────────────
      } else {
        try {
          const stream = await openai.chat.completions.create({
            model: llmModel, messages: llmMessages, temperature: 0.2, max_tokens: maxTokens, stream: true,
          });
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content ?? "";
            if (delta) emit(delta);
          }
        } catch {
          emitError();
        }
      }

      // ── Persist assistant message ─────────────────────────────────────────────
      const { data: assistantMsg } = await supabase
        .from("messages")
        .insert({ chat_id: chatId, role: "assistant", content: fullContent, sources })
        .select("id, role, content, sources, created_at")
        .single();

      // ── Auto-title on first message (non-blocking) ────────────────────────────
      if (isFirstMessage && (chat.title === "New Chat" || !chat.title)) {
        openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{
            role: "user",
            content: `Generate a 4-6 word title for a chat about: "${userContent.slice(0, 200)}". No punctuation, no emojis, capitalize each word. Reply with ONLY the title.`,
          }],
          max_tokens:  20,
          temperature: 0.3,
        }).then((res) => {
          const title = res.choices[0]?.message?.content?.trim() || userContent.slice(0, 40);
          return supabase.from("chats").update({ title }).eq("id", chatId);
        }).catch(() => { /* title failure is silent and non-fatal */ });
      }

      controller.enqueue(encoder.encode(sseEvent({ type: "done", message: assistantMsg ?? null })));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type":      "text/event-stream",
      "Cache-Control":     "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection:          "keep-alive",
    },
  });
}
