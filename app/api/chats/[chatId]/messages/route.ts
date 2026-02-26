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
//   3. NO MATCH: model is instructed to refuse with a fixed phrase.

import OpenAI from "openai";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { embedText } from "@/lib/embeddings";
import { anthropic } from "@/lib/claude";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// ── Claude: deep research mode ───────────────────────────────────────────────
//
// callClaude is called ONLY when uiMode === "deep".
// All retrieval logic (deterministic lookup, vector search, deduplication) runs
// identically for every mode — only the final reasoning step is swapped.
//
// contextText   — formatted RAG chunks; empty string when no chunks matched.
// question      — the raw user message.
//
// Failsafe: if contextText is empty Claude answers from general legal reasoning;
// it never mentions a missing corpus or database.

const CLAUDE_SYSTEM = `You are a senior litigation research counsel.

Provide structured, analytical legal reasoning in a professional tone.

Structure your response as follows:

1. ISSUE
Identify the precise legal question raised.

2. RELEVANT LAW
Quote the applicable statutory provision(s) directly within your explanation where necessary.

3. LEGAL ANALYSIS
Analyze the elements of the provision.
Interpret operative phrases.
Explain legislative intent where relevant.
Apply the statute to the issue raised.

4. PRACTICAL IMPLICATIONS
Discuss procedural, evidentiary, or strategic considerations where appropriate.

Rules:
- Formal tone.
- No emojis.
- No conversational language.
- No mention of system mechanics.
- Do not hallucinate statutes.
- If context is limited, reason conservatively.`;

async function callClaude(question: string, contextText: string): Promise<string> {
  const userMessage = contextText
    ? `Question:\n${question}\n\nStatutory Context:\n${contextText}`
    : `Question:\n${question}`;

  try {
    const response = await anthropic.messages.create({
      model:       "claude-3-5-sonnet-20241022",
      max_tokens:  4000,
      temperature: 0.2,
      system:      CLAUDE_SYSTEM,
      messages:    [{ role: "user", content: userMessage }],
    });

    const textBlock = response.content.find((c) => c.type === "text");
    const resultText = textBlock?.type === "text" ? textBlock.text : "";

    if (!resultText) {
      console.error("[Claude] returned no text block:", JSON.stringify(response.content));
      return "";
    }

    return resultText;
  } catch (error: unknown) {
    console.error("[Claude] API error:", error);
    throw error;
  }
}

const HISTORY_WINDOW = 12;
const RAG_TOP_K      = 8;
const RAG_THRESHOLD  = 0.40;

type UIMode = "deep" | "fast" | "documents" | "premium";

const MODE_CONFIG: Record<UIMode, { model: string; maxTokens: number }> = {
  deep:      { model: "gpt-4o",      maxTokens: 2048 },
  fast:      { model: "gpt-4o-mini", maxTokens: 1024 },
  documents: { model: "gpt-4o-mini", maxTokens: 1024 },
  premium:   { model: "gpt-4o",      maxTokens: 4096 },
};

async function generateChatTitle(question: string): Promise<string> {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{
      role: "user",
      content: `Generate a 4-6 word title for a chat about: "${question.slice(0, 200)}". No punctuation, no emojis, capitalize each word. Reply with ONLY the title.`,
    }],
    max_tokens: 20,
    temperature: 0.3,
  });
  return res.choices[0]?.message?.content?.trim() || question.slice(0, 40);
}

type Params = { params: Promise<{ chatId: string }> };

type RagChunk = {
  id: string;
  file_name: string;
  chunk_index: number;
  content: string;
  similarity: number;
  source: "case" | "global";
  section_number: string | null;
  act_name: string | null;
  title?: string | null;
  chapter?: string | null;
  year?: number | null;
};

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

function detectActFilter(question: string): string | null {
  for (const rule of ACT_RULES) {
    if (rule.patterns.some((re) => re.test(question))) return rule.actName;
  }
  return null;
}

// ── Message classifier ───────────────────────────────────────────────────────
//
// Returns true if the message is legal in nature → RAG pipeline.
// Returns false for greetings, casual chat, jokes, etc. → conversational mode.
//
// Deliberately lightweight: pure keyword regex, zero latency, no extra API call.

const LEGAL_SIGNALS = [
  // Explicit statute references
  /\bsection\b/i, /\bsec\.\s*\d/i, /§\s*\d/i,
  /\bact\b/i, /\bstatut/i, /\bordinance\b/i, /\brule\s+\d/i,
  // Legal terms
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
  // Pakistani-specific
  /\bppc\b/i, /\bcrpc\b/i, /\bsecp\b/i, /\bsro\b/i,
  /\bqisas\b/i, /\bdiyat\b/i, /\bqatl\b/i, /\bzina\b/i,
  /\bhudood\b/i, /\bfata\b/i,
  // Common legal question phrases
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

  // Short exact matches → always casual
  if (trimmed.length < 12 && CASUAL_OVERRIDES.some((re) => re.test(trimmed))) return false;

  // Explicit casual patterns win regardless of length
  if (CASUAL_OVERRIDES.some((re) => re.test(trimmed))) return false;

  // Any legal signal → legal
  return LEGAL_SIGNALS.some((re) => re.test(trimmed));
}

// Encode an SSE event line
function sseEvent(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(request: Request, { params }: Params) {
  const { chatId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const userContent: string = body.content?.trim();
  const uiMode: UIMode = (["deep", "fast", "documents", "premium"] as UIMode[]).includes(body.mode)
    ? (body.mode as UIMode)
    : "fast";
  const { model: llmModel, maxTokens } = MODE_CONFIG[uiMode];

  if (!userContent) {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }

  // ── 1. Verify chat ownership ─────────────────────────────────
  const { data: chat, error: chatError } = await supabase
    .from("chats")
    .select("id, title, case_id")
    .eq("id", chatId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (chatError) {
    console.error("[messages] chat fetch error:", chatError.message);
    return NextResponse.json({ error: chatError.message }, { status: 500 });
  }
  if (!chat) {
    return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  }

  // ── 2. Persist user message ──────────────────────────────────
  const { error: insertUserErr } = await supabase
    .from("messages")
    .insert({ chat_id: chatId, role: "user", content: userContent });

  if (insertUserErr) {
    return NextResponse.json({ error: insertUserErr.message }, { status: 500 });
  }

  // ── 3. Route: casual vs. legal ───────────────────────────────
  const legalQuery = isLegalQuery(userContent);

  // ── 3. RAG retrieval (legal path only) ───────────────────────
  let ragChunks: RagChunk[] = [];
  const actFilter = legalQuery ? detectActFilter(userContent) : null;

  if (legalQuery) {
  // ── 3a. DETERMINISTIC PATH ───────────────────────────────────
  // If the question explicitly names "Section 302" / "sec. 17-A" / "§ 55-A",
  // do a direct SQL lookup — no embedding needed, no threshold guessing.
  const sectionMatch = userContent.match(
    /(?:section|sec\.?|§)\s*(\d{1,3}(?:[A-Z]{1,2}|-[A-Z]{1,2})?)/i
  );

  if (sectionMatch) {
    const sectionNumber = sectionMatch[1].toUpperCase();

    let q = supabase
      .from("documents")
      .select("id, file_name, chunk_index, content, section_number, act_name, title, chapter, year")
      .eq("scope", "global")
      .ilike("section_number", sectionNumber)
      .limit(RAG_TOP_K);

    if (actFilter) q = q.eq("act_name", actFilter);

    const { data: sectionRows, error: sectionErr } = await q;

    if (sectionErr) {
      console.error("[messages] deterministic lookup error:", sectionErr.message);
    }

    if (sectionRows && sectionRows.length > 0) {
      ragChunks = sectionRows.map((r: any) => ({
        id:             r.id,
        file_name:      r.file_name,
        chunk_index:    r.chunk_index,
        content:        r.content,
        similarity:     1.0,           // exact match
        source:         "global" as const,
        section_number: r.section_number ?? null,
        act_name:       r.act_name     ?? null,
        title:          r.title        ?? null,
        chapter:        r.chapter      ?? null,
        year:           r.year         ?? null,
      }));
    }
  }

  // ── 3b. VECTOR PATH (fallback) ───────────────────────────────
  if (ragChunks.length === 0) {

    try {
      const embedding = await embedText(userContent);
      const shouldSearchCase = !!chat.case_id;

      const globalQuery = actFilter
        ? supabase
            .rpc("match_global_documents", {
              query_embedding: embedding,
              match_count:     RAG_TOP_K * 2,
              match_threshold: RAG_THRESHOLD,
            })
            .eq("act_name", actFilter)
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

      if (caseResult.error) {
        console.error("[messages] match_documents_by_case error:", caseResult.error.message);
      }
      if (globalResult.error) {
        console.error("[messages] match_global_documents error:", globalResult.error.message);
      }

      const caseChunks: RagChunk[] = (caseResult.data ?? []).map((r: any) => ({
        id:             r.id,
        file_name:      r.file_name,
        chunk_index:    r.chunk_index,
        content:        r.content,
        similarity:     r.similarity,
        source:         "case" as const,
        section_number: r.section_number ?? null,
        act_name:       r.act_name       ?? null,
      }));

      const globalChunks: RagChunk[] = (globalResult.data ?? []).map((r: any) => ({
        id:             r.id,
        file_name:      r.file_name,
        chunk_index:    r.chunk_index,
        content:        r.content,
        similarity:     r.similarity,
        source:         "global" as const,
        section_number: r.section_number ?? null,
        act_name:       r.act_name       ?? null,
        title:          r.title          ?? null,
        chapter:        r.chapter        ?? null,
        year:           r.year           ?? null,
      }));

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
    } catch (ragErr: unknown) {
      console.error("[messages] vector search error:", ragErr instanceof Error ? ragErr.message : ragErr);
    }
  }
  } // end: if (legalQuery)

  // ── 4. Fetch conversation history ────────────────────────────
  const { data: history } = await supabase
    .from("messages")
    .select("role, content")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_WINDOW);

  const conversationHistory = (history ?? []).reverse();

  // ── 5. Build system prompt ────────────────────────────────────
  let systemContent: string;

  const BASE_IDENTITY =
    "You are Harvey, a professional AI legal assistant specialising in Pakistani law. " +
    "You serve practicing lawyers. Be precise, structured, and authoritative.";

  if (!legalQuery) {
    // ── CASUAL path ───────────────────────────────────────────
    systemContent =
      "You are Harvey, a friendly and professional AI assistant for a Pakistani law firm. " +
      "You help lawyers and clients with legal questions and everyday conversation. " +
      "When users greet you or ask non-legal questions, respond naturally and warmly. " +
      "Keep casual replies brief. When the conversation turns legal, bring your full expertise.";

  } else if (ragChunks.length > 0) {
    // ── LEGAL path WITH corpus context ────────────────────────
    const contextText = ragChunks
      .map((c) => {
        const header =
          c.act_name && c.section_number
            ? `${c.act_name} — Section ${c.section_number}` +
              `${c.title ? ` — ${c.title}` : ""}` +
              `${c.year  ? ` [${c.year}]`  : ""}`
            : c.file_name;
        return `[${header}]\n${c.content}`;
      })
      .join("\n\n---\n\n");

    systemContent =
`${BASE_IDENTITY}

You have been provided with statutory excerpts directly relevant to this question.

OUTPUT STRUCTURE (follow exactly):

**Step 1 — Statutory Provision (Verbatim Extract)**
State: Act Name — Section Number — Section Title (if available)
Quote the exact relevant text in quotation marks. Do NOT paraphrase here.

**Step 2 — Legal Analysis**
Concise explanation (5–8 lines). Legal effect, practical meaning, application.
No unnecessary theory.

**Step 3 — Citation**
📄 Act Name, §Section Number

STATUTORY CONTEXT:
${contextText}`;

  } else {
    // ── LEGAL path WITHOUT corpus context ─────────────────────
    // No uploaded documents matched — answer from training knowledge.
    // Do NOT mention the corpus, database, or indexing.
    systemContent =
`${BASE_IDENTITY}

Answer the user's legal question using your knowledge of Pakistani law.

RULES:
- Cite the Act name, Section number, and Year for every legal point.
- Format citations as: (Act Name, Section X, Year) e.g. (Pakistan Penal Code, Section 302, 1860).
- If you are uncertain about a specific provision, say so clearly.
- Do NOT fabricate section numbers.
- Do NOT reference any document database or uploaded files.
- Structure your answer clearly. Assume the reader is a practicing lawyer.`;
  }

  // Sources for DB storage — only chunks that were actually used as context
  const sources =
    ragChunks.length > 0
      ? ragChunks.map((c) => ({
          file_name:      c.file_name,
          similarity:     c.similarity,
          chunk_index:    c.chunk_index,
          act_name:       c.act_name       ?? null,
          section_number: c.section_number ?? null,
          title:          c.title          ?? null,
        }))
      : null;

  const llmMessages = [
    { role: "system" as const, content: systemContent },
    ...conversationHistory.map((m) => ({
      role:    m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

  const isFirstMessage = conversationHistory.length === 1;

  // ── 6–8. LLM → SSE, then save to DB ─────────────────────────
  //
  // deep  → Claude 3.5 Sonnet via callClaude() (full response, single SSE chunk)
  // fast / documents / premium → OpenAI streaming (token-by-token SSE)
  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      let fullContent = "";

      // ── Build shared Claude context string ────────────────────
        // (used by deep path; built once, costs nothing if not needed)
        const claudeContextText = ragChunks
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

        if (uiMode === "deep") {
          // ── Claude path ────────────────────────────────────────
          // Attempt Claude; on any error fall back to OpenAI gpt-4o
          // so the user always receives a response.
          try {
            fullContent = await callClaude(userContent, claudeContextText);

            if (!fullContent) throw new Error("Claude returned empty content");

            controller.enqueue(encoder.encode(sseEvent({ type: "chunk", content: fullContent })));

          } catch (claudeErr: unknown) {
            console.error("[messages] Claude failed, falling back to OpenAI gpt-4o:", claudeErr instanceof Error ? claudeErr.message : claudeErr);

            // Fallback: stream gpt-4o with the same system prompt + history
            const fallbackStream = await openai.chat.completions.create({
              model:       "gpt-4o",
              messages:    llmMessages,
              temperature: 0.2,
              max_tokens:  2048,
              stream:      true,
            });

            for await (const chunk of fallbackStream) {
              const delta = chunk.choices[0]?.delta?.content ?? "";
              if (delta) {
                fullContent += delta;
                controller.enqueue(encoder.encode(sseEvent({ type: "chunk", content: delta })));
              }
            }
          }

        } else {
          // ── OpenAI path (fast / documents / premium) ───────────
          try {
            const stream = await openai.chat.completions.create({
              model:       llmModel,
              messages:    llmMessages,
              temperature: 0.2,
              max_tokens:  maxTokens,
              stream:      true,
            });

            for await (const chunk of stream) {
              const delta = chunk.choices[0]?.delta?.content ?? "";
              if (delta) {
                fullContent += delta;
                controller.enqueue(encoder.encode(sseEvent({ type: "chunk", content: delta })));
              }
            }
          } catch (openaiErr: unknown) {
            console.error("[messages] OpenAI error:", openaiErr instanceof Error ? openaiErr.message : openaiErr);
            fullContent = "An error occurred. Please try again.";
            controller.enqueue(encoder.encode(sseEvent({ type: "chunk", content: fullContent })));
          }
        }

      // Persist assistant message
      const { data: assistantMsg, error: insertErr } = await supabase
        .from("messages")
        .insert({ chat_id: chatId, role: "assistant", content: fullContent, sources })
        .select("id, role, content, sources, created_at")
        .single();

      if (insertErr) {
        console.error("[messages] insert assistant error:", insertErr.message);
      }

      // Auto-title on first message (AI-generated, non-blocking)
      if (isFirstMessage && (chat.title === "New Chat" || !chat.title)) {
        generateChatTitle(userContent).then((title) =>
          supabase.from("chats").update({ title }).eq("id", chatId)
        ).catch(() => {/* silently ignore title failures */});
      }

      controller.enqueue(encoder.encode(sseEvent({ type: "done", message: assistantMsg ?? null })));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type":    "text/event-stream",
      "Cache-Control":   "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection:        "keep-alive",
    },
  });
}
