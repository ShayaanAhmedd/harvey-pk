"use client";

import type { UploadedDocument } from "./DocumentBar";

interface Props {
  document:  UploadedDocument;
  onAskAbout: () => void;
}

function Check({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-5 h-5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className="w-3 h-3 text-emerald-600 dark:text-emerald-400">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
      <span className="text-sm text-gray-700 dark:text-neutral-300">{label}</span>
    </div>
  );
}

export default function DocumentInfoCard({ document: doc, onAskAbout }: Props) {
  const ext   = doc.file_name.split(".").pop()?.toUpperCase() ?? "FILE";
  const isGlobal = doc.scope === "global";

  return (
    <div className="flex-1 flex items-center justify-center px-6 py-12 chat-canvas">
      <div className="w-full max-w-md success-pop">

        {/* ── File header ──────────────────────────────────── */}
        <div className="flex items-center gap-4 mb-7">
          <div className="relative flex-shrink-0">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-50 to-violet-50 dark:from-indigo-900/20 dark:to-violet-900/20
              border border-indigo-100 dark:border-indigo-900/40
              flex flex-col items-center justify-center
              shadow-lg shadow-indigo-100/50 dark:shadow-indigo-900/20">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                className="w-6 h-6 text-indigo-500 dark:text-indigo-400">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span className="text-[9px] font-bold text-indigo-400 dark:text-indigo-500 mt-0.5 tracking-widest">{ext}</span>
            </div>
            {/* Success indicator */}
            <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-emerald-500 border-2 border-white dark:border-neutral-950 flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="w-2.5 h-2.5">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
          </div>

          <div className="min-w-0">
            <p className="text-base font-semibold text-gray-900 dark:text-neutral-50 truncate leading-tight">
              {doc.file_name}
            </p>
            <p className="text-sm text-gray-500 dark:text-neutral-500 mt-1">
              {doc.totalChunks.toLocaleString()} section{doc.totalChunks !== 1 ? "s" : ""} indexed
            </p>
            <span className={`inline-flex items-center mt-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
              isGlobal
                ? "bg-violet-100 dark:bg-violet-900/20 text-violet-700 dark:text-violet-400"
                : "bg-indigo-100 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-400"
            }`}>
              {isGlobal ? "Global KB" : "Case Document"}
            </span>
          </div>
        </div>

        {/* ── Status checklist ─────────────────────────────── */}
        <div className="bg-white/80 dark:bg-neutral-900/80 backdrop-blur-sm rounded-2xl border border-gray-100 dark:border-neutral-800 px-5 py-4 space-y-3 mb-5 shadow-sm">
          <Check label="Document processed" />
          <Check label="Embeddings created" />
          <Check label="Ready for AI queries" />
        </div>

        {/* ── CTA ──────────────────────────────────────────── */}
        <button
          onClick={onAskAbout}
          className="btn-accent w-full flex items-center justify-center gap-2 px-4 py-3.5 rounded-2xl
            text-white text-sm font-semibold
            shadow-lg shadow-indigo-500/25"
          style={{ background: "var(--accent)" }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
          </svg>
          Ask about this document
        </button>

        <p className="text-center text-xs text-gray-400 dark:text-neutral-600 mt-3">
          Or type your question in the chat box below.
        </p>

      </div>
    </div>
  );
}
