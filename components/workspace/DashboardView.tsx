"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { playClick } from "@/lib/sounds";
import type { Chat } from "./ChatSidebar";
import type { UploadedDocument } from "./DocumentBar";

interface Props {
  chats:        Chat[];
  documents:    UploadedDocument[];
  onSelectChat: (chatId: string) => void;
  onEnterChat:  () => void;
}

function TimeAgo({ iso }: { iso: string }) {
  const diff  = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins  < 1)  return <span>just now</span>;
  if (mins  < 60) return <span>{mins}m ago</span>;
  if (hours < 24) return <span>{hours}h ago</span>;
  if (days  < 7)  return <span>{days}d ago</span>;
  return <span>{new Date(iso).toLocaleDateString()}</span>;
}

// Shared easing
const ease = [0.16, 1, 0.3, 1] as const;

const fadeUp = {
  hidden:  { opacity: 0, y: 18 },
  visible: { opacity: 1, y: 0 },
};

const fadeIn = {
  hidden:  { opacity: 0 },
  visible: { opacity: 1 },
};

const logoVariant = {
  hidden:  { opacity: 0, scale: 0.88 },
  visible: { opacity: 1, scale: 1 },
};

export default function DashboardView({ chats, documents, onSelectChat, onEnterChat }: Props) {
  const [showRecent, setShowRecent] = useState(true);
  const recentChats = chats.slice(0, 8);
  const recentDocs  = documents.slice(0, 4);

  return (
    <motion.div
      className="flex-1 overflow-y-auto chat-canvas relative"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
    >
      <div className="min-h-full flex flex-col items-center justify-center px-8 py-20">

        {/* ── Brand Hero ─────────────────────────────────────── */}
        <div className="text-center mb-10">

          {/* Shield icon */}
          <motion.div
            className="w-14 h-14 rounded-[18px] flex items-center justify-center mx-auto mb-8 shadow-2xl"
            style={{
              background: "linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 65%, #7c3aed))",
              boxShadow: "0 12px 40px color-mix(in srgb, var(--accent) 30%, transparent)",
            }}
            variants={logoVariant}
            initial="hidden"
            animate="visible"
            transition={{ duration: 0.7, ease, delay: 0.1 }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-7 h-7">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </motion.div>

          <motion.h1
            className="text-5xl font-black tracking-tighter leading-none mb-3"
            style={{ color: "var(--text-color)" }}
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            transition={{ duration: 0.65, ease, delay: 0.25 }}
          >
            HARVEY PK
          </motion.h1>

          <motion.p
            className="text-[11px] font-semibold uppercase tracking-[0.3em]"
            style={{ color: "var(--text-secondary)" }}
            variants={fadeIn}
            initial="hidden"
            animate="visible"
            transition={{ duration: 0.6, ease: "easeOut", delay: 0.42 }}
          >
            Your Legal Assistant
          </motion.p>
        </div>

        {/* ── Accent rule ─────────────────────────────────────── */}
        <motion.div
          className="w-10 h-px mb-10 rounded-full"
          style={{ background: "var(--accent)", opacity: 0.4 }}
          variants={fadeIn}
          initial="hidden"
          animate="visible"
          transition={{ duration: 0.5, ease: "easeOut", delay: 0.54 }}
        />

        {/* ── Primary CTA ─────────────────────────────────────── */}
        <motion.button
          onClick={() => { playClick(); onEnterChat(); }}
          className="btn-accent flex items-center gap-2.5 px-10 py-3.5 rounded-2xl text-sm font-bold tracking-widest uppercase mb-16 shadow-xl"
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          transition={{ duration: 0.6, ease, delay: 0.62 }}
          whileHover={{
            scale: 1.03,
            boxShadow: "0 0 28px color-mix(in srgb, var(--accent) 45%, transparent), 0 8px 24px rgba(0,0,0,0.18)",
          }}
          whileTap={{ scale: 0.98 }}
        >
          Start Research
          <svg
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className="w-4 h-4"
          >
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </motion.button>

        {/* ── Recent chats (collapsible) ───────────────────────── */}
        {recentChats.length > 0 && (
          <motion.div
            className="w-full max-w-md"
            variants={fadeIn}
            initial="hidden"
            animate="visible"
            transition={{ duration: 0.7, ease: "easeOut", delay: 0.78 }}
          >

            {/* Section header with toggle */}
            <div className="flex items-center gap-3 mb-3">
              <div className="flex-1 h-px" style={{ background: "var(--text-secondary)", opacity: 0.1 }} />
              <button
                onClick={() => setShowRecent(v => !v)}
                className="flex items-center gap-1.5 transition-opacity hover:opacity-70"
                style={{ color: "var(--text-secondary)" }}
              >
                <span className="text-[9px] font-black uppercase tracking-[0.22em]">Recent</span>
                <svg
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                  className={`w-3 h-3 transition-transform duration-200 ${showRecent ? "" : "-rotate-90"}`}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              <div className="flex-1 h-px" style={{ background: "var(--text-secondary)", opacity: 0.1 }} />
            </div>

            {showRecent && (
              <div className="space-y-0.5">
                {recentChats.map((chat, i) => (
                  <motion.button
                    key={chat.id}
                    onClick={() => onSelectChat(chat.id)}
                    className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-left
                      transition-colors duration-150 active:scale-[0.99]"
                    style={{ color: "var(--text-color)" }}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.4, ease, delay: 0.82 + i * 0.04 }}
                    onMouseEnter={e => (e.currentTarget.style.background = "color-mix(in srgb, var(--text-color) 5%, transparent)")}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <span
                        className="w-1 h-1 rounded-full flex-shrink-0"
                        style={{ background: "var(--accent)", opacity: 0.5 }}
                      />
                      <span className="text-xs font-medium truncate" style={{ color: "var(--text-color)" }}>
                        {chat.title}
                      </span>
                    </div>
                    <span
                      className="text-[10px] flex-shrink-0 ml-4 tabular-nums"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      <TimeAgo iso={chat.created_at} />
                    </span>
                  </motion.button>
                ))}
              </div>
            )}

            {/* Indexed docs (if any) */}
            {recentDocs.length > 0 && showRecent && (
              <div className="mt-4">
                <div className="flex items-center gap-3 mb-2">
                  <div className="flex-1 h-px" style={{ background: "var(--text-secondary)", opacity: 0.08 }} />
                  <span className="text-[9px] font-black uppercase tracking-[0.22em]" style={{ color: "var(--text-secondary)", opacity: 0.5 }}>
                    Documents
                  </span>
                  <div className="flex-1 h-px" style={{ background: "var(--text-secondary)", opacity: 0.08 }} />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {recentDocs.map(doc => (
                    <span
                      key={doc.file_name}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium"
                      style={{
                        background: "color-mix(in srgb, var(--accent) 8%, transparent)",
                        border: "1px solid color-mix(in srgb, var(--accent) 20%, transparent)",
                        color: "var(--accent)",
                      }}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-2.5 h-2.5 flex-shrink-0">
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      {doc.file_name.length > 22 ? doc.file_name.slice(0, 22) + "…" : doc.file_name}
                    </span>
                  ))}
                </div>
              </div>
            )}

          </motion.div>
        )}

        {/* ── Empty state ──────────────────────────────────────── */}
        {chats.length === 0 && (
          <motion.p
            className="text-xs mt-4"
            style={{ color: "var(--text-secondary)", opacity: 0.5 }}
            variants={fadeIn}
            initial="hidden"
            animate="visible"
            transition={{ duration: 0.6, ease: "easeOut", delay: 0.78 }}
          >
            Your research history will appear here.
          </motion.p>
        )}

      </div>
    </motion.div>
  );
}
