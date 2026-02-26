"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { UIMode } from "./ChatInput";

export type Source = {
  file_name: string;
  similarity: number;
  chunk_index?: number;
  act_name?: string | null;
  section_number?: string | null;
  title?: string | null;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[] | null;
  created_at: string;
  streaming?: boolean;
};

interface Props {
  messages: Message[];
  loading: boolean;
  chatLoading: boolean;
  activeChatId: string | null;
  onModeSelect?: (mode: UIMode) => void;
}

const WELCOME_CARDS: {
  mode: UIMode;
  icon: string;
  label: string;
  description: string;
}[] = [
  { mode: "deep",      icon: "🔍", label: "Deep Research", description: "Advanced legal reasoning & statute analysis" },
  { mode: "documents", icon: "⚖️", label: "Case Studies",  description: "Analyze past judgments & precedents" },
  { mode: "fast",      icon: "⚡", label: "Fast Think",    description: "Quick legal summaries & answers" },
  { mode: "premium",   icon: "📖", label: "Learning",      description: "Study acts, sections & legal concepts" },
];

export default function ChatWindow({
  messages,
  chatLoading,
  activeChatId,
  onModeSelect,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [userScrolled, setUserScrolled] = useState(false);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setUserScrolled(distFromBottom > 80);
  }, []);

  useEffect(() => {
    if (!userScrolled) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, userScrolled]);

  const lastRole = messages[messages.length - 1]?.role;
  useEffect(() => {
    if (lastRole === "user") setUserScrolled(false);
  }, [lastRole]);

  // ── Welcome screen ────────────────────────────────────────
  if (!activeChatId) {
    return (
      <div className="chat-canvas flex-1 flex flex-col items-center justify-center px-6 py-12 overflow-y-auto transition-colors duration-300">
        <div className="w-full max-w-lg">
          <h1
            className="text-2xl font-semibold text-gray-800 dark:text-neutral-100 text-center mb-8 tracking-tight fade-in-up"
            style={{ animationDelay: "0ms" }}
          >
            What case are you working on?
          </h1>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {WELCOME_CARDS.map((card, i) => (
              <button
                key={card.mode}
                onClick={() => onModeSelect?.(card.mode)}
                className="group text-left rounded-xl border px-4 py-4
                  bg-white dark:bg-[#1a1a1a]
                  border-gray-200 dark:border-neutral-800
                  hover:border-gray-300 dark:hover:border-neutral-700
                  hover:shadow-md dark:hover:shadow-black/40
                  hover:scale-[1.02]
                  transition-all duration-200 ease-out
                  fade-in-up"
                style={{ animationDelay: `${i * 80 + 100}ms` }}
              >
                <div className="text-xl mb-2">{card.icon}</div>
                <p className="text-sm font-medium text-gray-800 dark:text-neutral-200 group-hover:text-gray-900 dark:group-hover:text-neutral-100 transition-colors duration-200">
                  {card.label}
                </p>
                <p className="text-xs text-gray-400 dark:text-neutral-600 mt-0.5 leading-snug">
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
      <div className="chat-canvas flex-1 flex items-center justify-center transition-colors duration-300">
        <div className="flex flex-col items-center gap-3">
          <svg className="animate-spin w-5 h-5 text-indigo-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
          </svg>
          <p className="text-gray-400 dark:text-neutral-600 text-sm">Loading messages…</p>
        </div>
      </div>
    );
  }

  // ── Empty active chat ─────────────────────────────────────
  if (messages.length === 0) {
    return (
      <div className="chat-canvas flex-1 flex items-center justify-center transition-colors duration-300">
        <p className="text-gray-400 dark:text-neutral-500 text-sm">
          Ask Harvey anything about Pakistani law or your case documents.
        </p>
      </div>
    );
  }

  // ── Canvas message list ───────────────────────────────────
  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="chat-canvas flex-1 overflow-y-auto px-6 py-10 transition-colors duration-300"
    >
      <div className="mx-auto max-w-3xl">
        {messages.map((msg, idx) => (
          <div key={msg.id} className={`msg-in ${idx > 0 ? "mt-6" : ""}`}>

            {msg.role === "user" ? (
              /* ── User bubble ─────────────────────────── */
              <div className="flex justify-end">
                <div className="max-w-[60%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap
                  bg-gray-200 dark:bg-[#1f1f1f]
                  text-gray-900 dark:text-neutral-100">
                  {msg.content}
                </div>
              </div>

            ) : (
              /* ── Assistant canvas text ───────────────── */
              <div className="max-w-[800px]">

                {msg.streaming && !msg.content ? (
                  /* Thinking dots */
                  <div className="flex gap-1 items-center py-2">
                    <span className="w-1.5 h-1.5 bg-gray-400 dark:bg-neutral-500 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="w-1.5 h-1.5 bg-gray-400 dark:bg-neutral-500 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="w-1.5 h-1.5 bg-gray-400 dark:bg-neutral-500 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                ) : (
                  <div className="text-sm leading-7 text-gray-800 dark:text-neutral-200">
                    {msg.content.split(/\n\n+/).map((para, pi) => (
                      <p key={pi} className={pi > 0 ? "mt-3" : ""}>
                        {para.split("\n").map((line, li) => (
                          <span key={li}>
                            {li > 0 && <br />}
                            {line}
                          </span>
                        ))}
                      </p>
                    ))}

                    {/* Blinking cursor while streaming */}
                    {msg.streaming && (
                      <span
                        className="inline-block w-[2px] h-[1em] bg-indigo-400 ml-0.5 align-middle animate-pulse"
                        aria-hidden="true"
                      />
                    )}
                  </div>
                )}

                {/* Sources */}
                {!msg.streaming && msg.sources && msg.sources.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-gray-200 dark:border-neutral-800 space-y-1.5">
                    <p className="text-[10px] font-semibold text-gray-400 dark:text-neutral-600 uppercase tracking-wider">
                      Sources
                    </p>
                    {msg.sources.map((src, i) => (
                      <div
                        key={i}
                        className="flex items-start gap-2 text-xs text-gray-600 dark:text-neutral-400
                          bg-white/60 dark:bg-neutral-900/60
                          border border-gray-200 dark:border-neutral-800
                          rounded-xl px-3 py-2"
                      >
                        <span className="text-gray-400 dark:text-neutral-600 mt-0.5 flex-shrink-0">📄</span>
                        <div className="min-w-0 flex-1">
                          {src.act_name && src.section_number ? (
                            <span>
                              <span className="font-medium text-gray-700 dark:text-neutral-300">{src.act_name}</span>
                              {", §"}{src.section_number}
                              {src.title && (
                                <span className="text-gray-500 dark:text-neutral-500"> — {src.title}</span>
                              )}
                            </span>
                          ) : (
                            <span className="truncate">{src.file_name}</span>
                          )}
                        </div>
                        <span className="ml-auto flex-shrink-0 text-gray-400 dark:text-neutral-600 tabular-nums">
                          {(src.similarity * 100).toFixed(0)}%
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

          </div>
        ))}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
