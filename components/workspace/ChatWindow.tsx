"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import type { UIMode } from "./ChatInput";

// ── IRAC response type ───────────────────────────────────────────────────────
interface IracMessage {
  issue:       string;
  rule:        string;
  application: string;
  conclusion:  string;
  citation_warning?: string;
  litigation_brief?: { executive_summary: string };
}

function tryParseIrac(content: string): IracMessage | null {
  try {
    const obj = JSON.parse(content);
    if (obj && typeof obj.rule === "string" && typeof obj.application === "string") {
      return obj as IracMessage;
    }
  } catch { /* not JSON */ }
  return null;
}

function IracField({ label, text, accent }: { label: string; text: string; accent?: boolean }) {
  return (
    <div className="mb-5">
      <p className={`text-[10px] font-bold uppercase tracking-widest mb-1.5 ${
        accent ? "text-indigo-400" : "text-gray-400 dark:text-neutral-500"
      }`}>
        {label}
      </p>
      <p className="text-sm leading-7" style={{ whiteSpace: "pre-wrap", color: "var(--chat-text-color, #1f2937)" }}>
        {text}
      </p>
    </div>
  );
}

export type Source = {
  file_name:      string;
  similarity:     number;
  chunk_index?:   number;
  act_name?:      string | null;
  section_number?: string | null;
  title?:         string | null;
};

export type Message = {
  id:         string;
  role:       "user" | "assistant";
  content:    string;
  sources?:   Source[] | null;
  created_at: string;
  streaming?: boolean;
};

// ── Research Status Bar ───────────────────────────────────────────────────────
const DEEP_PHRASES = [
  "Reviewing case law…",
  "Checking PPC sections…",
  "Reading CrPC provisions…",
  "Analyzing judgment…",
  "Comparing precedents…",
  "Validating citation…",
  "Consulting legal database…",
  "Searching statutes…",
  "Verifying sources…",
  "Cross-referencing evidence…",
  "Consulting legal corpus…",
  "Building legal argument…",
  "Checking Qanoon-e-Shahadat…",
  "Reviewing Hudood ordinance…",
  "Analyzing appellate decision…",
];

const NORMAL_PHRASES = [
  "Thinking…",
  "Writing…",
  "Preparing answer…",
  "Analyzing…",
  "Drafting response…",
  "Finalizing…",
  "Checking facts…",
  "Refining reasoning…",
];

type StatusLine = { id: number; text: string; age: number };

function ResearchStatusBar({ active, isDeep }: { active: boolean; isDeep: boolean }) {
  const phrases = isDeep ? DEEP_PHRASES : NORMAL_PHRASES;
  const [trail, setTrail] = useState<StatusLine[]>([]);
  const counterRef = useRef(0);
  const lastPhraseRef = useRef("");

  useEffect(() => {
    if (!active) {
      const t = setTimeout(() => setTrail([]), 400);
      return () => clearTimeout(t);
    }

    function addPhrase() {
      // avoid repeating the same phrase twice in a row
      const pool = phrases.filter((p) => p !== lastPhraseRef.current);
      const text = pool[Math.floor(Math.random() * pool.length)];
      lastPhraseRef.current = text;
      counterRef.current++;
      const id = counterRef.current;
      setTrail((prev) => {
        const next = [...prev, { id, text, age: 0 }].slice(-3);
        return next.map((item, i, arr) => ({ ...item, age: arr.length - 1 - i }));
      });
    }

    addPhrase();
    const interval = setInterval(addPhrase, 1600);
    return () => clearInterval(interval);
  }, [active, isDeep]); // eslint-disable-line react-hooks/exhaustive-deps

  if (trail.length === 0) return null;

  return (
    <div className="research-status-bar" aria-live="polite" aria-label="Processing status">
      {trail.map((line) => (
        <div key={line.id} className={`status-phrase status-age-${line.age}`}>
          <span className="status-spark" aria-hidden="true">
            {line.age === 0 ? "✦" : "·"}
          </span>
          <span className="status-text">{line.text}</span>
        </div>
      ))}
    </div>
  );
}

interface Props {
  messages:       Message[];
  loading:        boolean;
  chatLoading:    boolean;
  activeChatId:   string | null;
  activeCaseName?: string | null;
  mode?:          UIMode;
  onModeSelect?:  (mode: UIMode) => void;
}

const WELCOME_CARDS: { mode: UIMode; label: string; description: string; color: string; icon: React.ReactNode }[] = [
  {
    mode: "deep",
    label: "Deep Research",
    description: "Thorough IRAC analysis & statute reasoning",
    color: "indigo",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
        <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
      </svg>
    ),
  },
  {
    mode: "documents",
    label: "Case Analysis",
    description: "Analyze judgments & precedents",
    color: "violet",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
        <path d="M3 6l9-4 9 4v6c0 5.25-3.75 10.15-9 11.25C6.75 22.15 3 17.25 3 12V6z" />
      </svg>
    ),
  },
  {
    mode: "fast",
    label: "Quick Answer",
    description: "Fast legal summaries & Q&A",
    color: "amber",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
        <polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    ),
  },
  {
    mode: "premium",
    label: "Study Mode",
    description: "Study acts, sections & legal concepts",
    color: "emerald",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
        <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" /><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" />
      </svg>
    ),
  },
];

const COLOR_MAP: Record<string, string> = {
  indigo:  "bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 group-hover:bg-indigo-100 dark:group-hover:bg-indigo-900/40",
  violet:  "bg-violet-50 dark:bg-violet-900/20 text-violet-600 dark:text-violet-400 group-hover:bg-violet-100 dark:group-hover:bg-violet-900/40",
  amber:   "bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 group-hover:bg-amber-100 dark:group-hover:bg-amber-900/40",
  emerald: "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 group-hover:bg-emerald-100 dark:group-hover:bg-emerald-900/40",
};

const BORDER_MAP: Record<string, string> = {
  indigo:  "hover:border-indigo-300/70 dark:hover:border-indigo-800",
  violet:  "hover:border-violet-300/70 dark:hover:border-violet-800",
  amber:   "hover:border-amber-300/70 dark:hover:border-amber-800",
  emerald: "hover:border-emerald-300/70 dark:hover:border-emerald-800",
};

// ── Starlight background ──────────────────────────────────────────────────────
function rndStars(count: number): string {
  return Array.from({ length: count }, () =>
    `${Math.floor(Math.random() * 2500)}px ${Math.floor(Math.random() * 2500)}px rgba(255,255,255,${(0.35 + Math.random() * 0.65).toFixed(2)})`
  ).join(", ");
}
// Generated once at module load (stable, no re-render cost)
const STAR_SM = rndStars(400);
const STAR_MD = rndStars(100);
const STAR_LG = rndStars(40);

function StarlightBackground() {
  return (
    <div className="starlight-bg-layer" aria-hidden="true">
      <div className="star-layer star-layer-sm" style={{ boxShadow: STAR_SM }} />
      <div className="star-layer star-layer-md" style={{ boxShadow: STAR_MD }} />
      <div className="star-layer star-layer-lg" style={{ boxShadow: STAR_LG }} />
      {/* Nebula glow layers */}
      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        background:
          "radial-gradient(ellipse 55% 35% at 28% 38%, rgba(99,102,241,0.09) 0%, transparent 70%), " +
          "radial-gradient(ellipse 40% 25% at 72% 68%, rgba(139,92,246,0.06) 0%, transparent 60%), " +
          "radial-gradient(ellipse 30% 20% at 60% 18%, rgba(59,130,246,0.05) 0%, transparent 55%)",
      }} />
    </div>
  );
}

// ── Markdown-aware text renderer ─────────────────────────────────────────────
// Legal term pattern — underlined in accent color
const LEGAL_REF_RE = /(\*\*[^*]+\*\*|\*[^*]+\*|(?:Section|Article|Clause|Sec\.?)\s+\d+[A-Za-z]?(?:[(\d)]*)?|(?:\bCrPC\b|\bPPC\b|\bBNS\b|\bIPC\b|\bPMDA\b|\bQatl\b|\bDiyat\b|\bArsh\b|\bQisas\b|\bTazir\b|\bHadd\b))/g;

function parseInline(text: string): React.ReactNode {
  const parts = text.split(LEGAL_REF_RE);
  return (
    <>
      {parts.map((seg, i) => {
        if (!seg) return null;
        if (seg.startsWith("**") && seg.endsWith("**"))
          return <strong key={i} className="font-semibold">{seg.slice(2, -2)}</strong>;
        if (seg.startsWith("*") && seg.endsWith("*"))
          return <em key={i}>{seg.slice(1, -1)}</em>;
        if (LEGAL_REF_RE.test(seg)) {
          LEGAL_REF_RE.lastIndex = 0;
          return (
            <span
              key={i}
              className="font-medium underline decoration-dotted underline-offset-2"
              style={{ color: "var(--accent)", textDecorationColor: "color-mix(in srgb, var(--accent) 55%, transparent)" }}
            >
              {seg}
            </span>
          );
        }
        LEGAL_REF_RE.lastIndex = 0;
        return <span key={i}>{seg}</span>;
      })}
    </>
  );
}

function FormattedText({ content, streaming }: { content: string; streaming?: boolean }) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  const listItems: string[] = [];
  let key = 0;

  function flushList() {
    if (listItems.length === 0) return;
    elements.push(
      <ul key={`ul-${key++}`} className="mt-2 mb-3 space-y-1.5 ml-1">
        {listItems.splice(0).map((item, i) => (
          <li key={i} className="flex gap-2 items-start text-sm leading-relaxed" style={{ color: "var(--chat-text-color, #1f2937)" }}>
            <span className="mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: "var(--accent)" }} />
            <span>{parseInline(item)}</span>
          </li>
        ))}
      </ul>
    );
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("### ")) {
      flushList();
      elements.push(
        <p key={key++}
          className="mt-5 mb-2 first:mt-0 text-[11px] tracking-[0.12em] leading-snug"
          style={{ color: "var(--accent)", fontWeight: 700, textTransform: "uppercase" }}
        >
          {line.slice(4)}
        </p>
      );
    } else if (line.startsWith("## ")) {
      flushList();
      elements.push(
        <p key={key++}
          className="mt-4 mb-1 first:mt-0 text-sm leading-snug"
          style={{ color: "var(--chat-text-color, #1f2937)", fontWeight: 600, textTransform: "capitalize" }}
        >
          {parseInline(line.slice(3))}
        </p>
      );
    } else if (line.startsWith("# ")) {
      flushList();
      elements.push(
        <p key={key++}
          className="mt-4 mb-1 first:mt-0 text-sm leading-snug font-semibold"
          style={{ color: "var(--chat-text-color, #1f2937)" }}
        >
          {parseInline(line.slice(2))}
        </p>
      );
    } else if (line.startsWith("> ")) {
      flushList();
      elements.push(
        <blockquote key={key++}
          className="mt-3 mb-2 pl-3 text-sm leading-7 italic"
          style={{ borderLeft: "2px solid var(--accent)", color: "var(--chat-text-color)", opacity: 0.8 }}
        >
          {parseInline(line.slice(2))}
        </blockquote>
      );
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      listItems.push(line.slice(2));
    } else if (line.trim() === "") {
      flushList();
    } else {
      flushList();
      elements.push(
        <p key={key++}
          className={`text-sm leading-7 ${i > 0 ? "mt-3" : ""}`}
          style={{ color: "var(--chat-text-color, #1f2937)" }}
        >
          {parseInline(line)}
        </p>
      );
    }
  }
  flushList();

  return (
    <div>
      {elements}
      {streaming && (
        <span
          className="inline-block w-[2px] h-[1.1em] ml-0.5 align-middle animate-pulse rounded-sm"
          style={{ background: "var(--accent)" }}
          aria-hidden
        />
      )}
    </div>
  );
}

export default function ChatWindow({
  messages,
  chatLoading,
  activeChatId,
  activeCaseName,
  mode,
  onModeSelect,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef    = useRef<HTMLDivElement>(null);
  const [userScrolled, setUserScrolled] = useState(false);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setUserScrolled(el.scrollHeight - el.scrollTop - el.clientHeight > 80);
  }, []);

  useEffect(() => {
    if (!userScrolled) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, userScrolled]);

  const lastRole = messages[messages.length - 1]?.role;
  useEffect(() => {
    if (lastRole === "user") setUserScrolled(false);
  }, [lastRole]);

  const isStreaming = useMemo(
    () => messages.some((m) => m.streaming),
    [messages]
  );

  // ── Welcome screen ─────────────────────────────────────────
  if (!activeChatId) {
    return (
      <div className="chat-canvas flex-1 flex flex-col items-center justify-center px-6 py-12 overflow-y-auto relative">
        <StarlightBackground />
        <div className="w-full max-w-xl relative z-10">
          <p
            className="text-2xl font-semibold text-center mb-2 tracking-tight fade-in-up"
            style={{ color: "var(--text-color)", animationDelay: "0ms" }}
          >
            What can I help you with?
          </p>
          <p
            className="text-sm text-center mb-10 fade-in-up"
            style={{ animationDelay: "60ms", color: "var(--text-secondary)" }}
          >
            Ask about Pakistani law, analyze a case, or upload a document.
          </p>

          <div className="grid grid-cols-2 gap-3">
            {WELCOME_CARDS.map((card, i) => (
              <button
                key={card.mode}
                onClick={() => onModeSelect?.(card.mode)}
                className={`group text-left rounded-2xl border px-4 py-4
                  bg-white dark:bg-neutral-900/80
                  border-gray-200/80 dark:border-neutral-800
                  ${BORDER_MAP[card.color]}
                  hover:shadow-lg active:scale-[0.98]
                  transition-all duration-200 ease-out
                  fade-in-up`}
                style={{ animationDelay: `${i * 70 + 140}ms` }}
              >
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center mb-3 transition-all duration-200 ${COLOR_MAP[card.color]}`}>
                  {card.icon}
                </div>
                <p className="text-sm font-semibold text-gray-800 dark:text-neutral-200 group-hover:text-gray-900 dark:group-hover:text-neutral-100 transition-colors">
                  {card.label}
                </p>
                <p className="text-xs text-gray-400 dark:text-neutral-500 mt-1 leading-snug">
                  {card.description}
                </p>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── Loading ───────────────────────────────────────────────
  if (chatLoading) {
    return (
      <div className="chat-canvas flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="flex gap-1.5">
            {[0,1,2].map(i => (
              <span
                key={i}
                className="w-2 h-2 rounded-full bg-indigo-400 dark:bg-indigo-500"
                style={{ animation: `thinking-dot 1.2s ease-in-out ${i * 200}ms infinite` }}
              />
            ))}
          </div>
          <p className="text-gray-400 dark:text-neutral-500 text-xs">Loading messages…</p>
        </div>
      </div>
    );
  }

  // ── Empty active chat ─────────────────────────────────────
  if (messages.length === 0) {
    return (
      <div className="chat-canvas flex-1 flex items-center justify-center">
        <div className="text-center fade-in-up">
          <div className="w-10 h-10 rounded-2xl bg-indigo-50 dark:bg-indigo-900/20 flex items-center justify-center mx-auto mb-3">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5 text-indigo-400">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            </svg>
          </div>
          {activeCaseName ? (
            <>
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] mb-1" style={{ color: "var(--accent)", opacity: 0.8 }}>
                Case
              </p>
              <p className="text-sm font-medium mb-1" style={{ color: "var(--text-color)" }}>
                {activeCaseName}
              </p>
              <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
                Documents from this case will be used in answers.
              </p>
            </>
          ) : (
            <p className="text-sm text-gray-400 dark:text-neutral-500">
              Ask Harvey anything about Pakistani law.
            </p>
          )}
        </div>
      </div>
    );
  }

  // ── Message list ──────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="chat-canvas flex-1 overflow-y-auto px-4 py-10 sm:px-6 relative"
    >
      <StarlightBackground />
      <div className="chat-messages-inner mx-auto max-w-3xl space-y-6">
        {activeCaseName && (
          <div className="flex items-center gap-2 mb-2">
            <span
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold"
              style={{
                background: "color-mix(in srgb, var(--accent) 10%, transparent)",
                border: "1px solid color-mix(in srgb, var(--accent) 25%, transparent)",
                color: "var(--accent)",
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-2.5 h-2.5 flex-shrink-0">
                <path d="M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2z" />
                <path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" />
              </svg>
              {activeCaseName}
            </span>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className="msg-in">

            {msg.role === "user" ? (
              // ── User bubble ──────────────────────────────
              <div className="flex justify-end">
                <div className="max-w-[65%] relative">
                  <div
                    className="user-bubble px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap"
                    style={{
                      background: "var(--user-msg-bg, #111827)",
                      color: "var(--user-msg-text, #ffffff)",
                      borderRadius: "18px 18px 6px 18px",
                      boxShadow: "0 2px 12px rgba(0,0,0,0.15), 0 1px 3px rgba(0,0,0,0.1)",
                    }}
                  >
                    {msg.content}
                  </div>
                </div>
              </div>

            ) : (
              // ── Assistant response ───────────────────────
              <div className="flex gap-3 max-w-[800px]">

                {/* Avatar dot */}
                <div className="assistant-avatar-dot w-6 h-6 rounded-full flex-shrink-0 mt-0.5 flex items-center justify-center" style={{ background: "linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 70%, #7c3aed))" }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                    <path d="M12 2L2 7l10 5 10-5-10-5z" />
                    <path d="M2 17l10 5 10-5" />
                    <path d="M2 12l10 5 10-5" />
                  </svg>
                </div>

                <div className="assistant-content flex-1 min-w-0">
                  {msg.streaming && !msg.content ? (
                    // Thinking dots
                    <div className="flex gap-1.5 items-center py-2">
                      {[0,1,2].map(i => (
                        <span
                          key={i}
                          className="w-2 h-2 rounded-full bg-gray-300 dark:bg-neutral-600"
                          style={{ animation: `thinking-dot 1.2s ease-in-out ${i * 200}ms infinite` }}
                        />
                      ))}
                    </div>
                  ) : (() => {
                    const content =
                      typeof msg.content === "string"
                        ? msg.content
                        : JSON.stringify(msg.content ?? "", null, 2);
                    const irac = tryParseIrac(content);

                    if (irac) {
                      return (
                        <div>
                          {irac.citation_warning && (
                            <div className="flex items-start gap-2.5 mb-4 px-3.5 py-2.5 rounded-xl
                              bg-amber-50 dark:bg-amber-900/10
                              border border-amber-200 dark:border-amber-900/40">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                                className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5">
                                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                                <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                              </svg>
                              <p className="text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
                                Citations not verified against statutory corpus. Analysis provided at reduced confidence.
                              </p>
                            </div>
                          )}
                          <IracField label="Issue"       text={irac.issue} />
                          <IracField label="Rule"        text={irac.rule} />
                          <IracField label="Application" text={irac.application} />
                          <IracField label="Conclusion"  text={irac.conclusion} accent />
                          {irac.litigation_brief?.executive_summary && (
                            <IracField label="Executive Summary" text={irac.litigation_brief.executive_summary} />
                          )}
                        </div>
                      );
                    }

                    return (
                      <FormattedText content={content} streaming={msg.streaming} />
                    );
                  })()}

                  {/* Sources — tag-style pills */}
                  {!msg.streaming && msg.sources && msg.sources.length > 0 && (
                    <div className="mt-4">
                      <p className="text-[9px] font-black uppercase tracking-[0.18em] mb-2" style={{ color: "var(--text-secondary)", opacity: 0.6 }}>
                        Sources
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {msg.sources.map((src, i) => {
                          const label = src.act_name && src.section_number
                            ? `§${src.section_number} — ${src.act_name}`
                            : src.file_name.replace(/\.[^.]+$/, "");
                          const short = label.length > 34 ? label.slice(0, 34) + "…" : label;
                          return (
                            <span
                              key={i}
                              title={label}
                              className="source-tag inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium cursor-default select-none transition-all duration-150"
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-2.5 h-2.5 flex-shrink-0">
                                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                                <polyline points="14 2 14 8 20 8" />
                              </svg>
                              {short}
                              <span className="opacity-50 tabular-nums font-mono text-[9px]">
                                {(src.similarity * 100).toFixed(0)}%
                              </span>
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

          </div>
        ))}

        {isStreaming && (
          <ResearchStatusBar active={isStreaming} isDeep={mode === "deep"} />
        )}

        <div ref={bottomRef} className="h-4" />
      </div>
    </div>
  );
}
