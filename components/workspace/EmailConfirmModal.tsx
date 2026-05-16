"use client";

// EmailConfirmModal — shown when the AI drafts an email via [DRAFT_EMAIL].
// All fields (To, Subject, Body) are editable before the user confirms.
// Multiple recipients are supported — comma-separated in the To field.
// The AI CANNOT send without this confirmation step.

import { useState } from "react";
import type { EmailDraft } from "@/lib/email-draft";

interface Props {
  draft:   EmailDraft;
  onClose: () => void;
}

export default function EmailConfirmModal({ draft, onClose }: Props) {
  // Editable local state — initialised from the AI draft
  const [editTo,      setEditTo]      = useState(draft.to.join(", "));
  const [editSubject, setEditSubject] = useState(draft.subject);
  const [editBody,    setEditBody]    = useState(draft.body);

  const [sending, setSending] = useState(false);
  const [result,  setResult]  = useState<{ ok: boolean; msg: string } | null>(null);

  async function handleSend() {
    setSending(true);
    setResult(null);

    // Split and trim recipients from the To field
    const toList = editTo.split(",").map((s) => s.trim()).filter(Boolean);

    try {
      const res = await fetch("/api/email/send", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to:      toList,
          subject: editSubject.trim(),
          body:    editBody.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        const count = (data.sentTo as string[] | undefined)?.length ?? toList.length;
        setResult({ ok: true, msg: `Email sent to ${count} recipient${count !== 1 ? "s" : ""}.` });
        setTimeout(onClose, 1800);
      } else {
        setResult({ ok: false, msg: data.error ?? "Failed to send." });
      }
    } catch {
      setResult({ ok: false, msg: "Network error." });
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget && !sending) onClose(); }}
    >
      <div className="w-full max-w-lg mx-4 bg-[#111111] border border-neutral-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="px-6 py-4 border-b border-neutral-800 flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-neutral-100">Review &amp; Send Email</h2>
            <p className="text-[11px] text-neutral-500 mt-0.5">Edit the draft, then click Send.</p>
          </div>
          {!sending && (
            <button
              onClick={onClose}
              className="text-neutral-500 hover:text-neutral-200 text-xl leading-none transition-colors"
            >
              ×
            </button>
          )}
        </div>

        {/* Editable fields */}
        <div className="px-6 py-5 space-y-4 overflow-y-auto flex-1">

          {/* To */}
          <div>
            <label className="block text-[11px] font-semibold text-neutral-500 uppercase tracking-wide mb-1.5">
              To
              <span className="ml-1.5 normal-case font-normal text-neutral-600">(comma-separate multiple addresses)</span>
            </label>
            <input
              type="text"
              value={editTo}
              onChange={(e) => setEditTo(e.target.value)}
              disabled={sending}
              placeholder="a@example.com, b@example.com"
              className="w-full bg-neutral-900 border border-neutral-700 focus:border-indigo-500 rounded-lg px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 outline-none transition-colors disabled:opacity-50"
            />
          </div>

          {/* Subject */}
          <div>
            <label className="block text-[11px] font-semibold text-neutral-500 uppercase tracking-wide mb-1.5">
              Subject
            </label>
            <input
              type="text"
              value={editSubject}
              onChange={(e) => setEditSubject(e.target.value)}
              disabled={sending}
              placeholder="Subject line"
              className="w-full bg-neutral-900 border border-neutral-700 focus:border-indigo-500 rounded-lg px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 outline-none transition-colors disabled:opacity-50"
            />
          </div>

          {/* Body */}
          <div>
            <label className="block text-[11px] font-semibold text-neutral-500 uppercase tracking-wide mb-1.5">
              Message
            </label>
            <textarea
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              disabled={sending}
              rows={8}
              placeholder="Email body…"
              className="w-full bg-neutral-900 border border-neutral-700 focus:border-indigo-500 rounded-lg px-3 py-2.5 text-sm text-neutral-200 placeholder-neutral-600 outline-none transition-colors resize-y disabled:opacity-50 font-sans leading-relaxed"
            />
          </div>

        </div>

        {/* Result */}
        {result && (
          <div className={`mx-6 mb-3 px-4 py-2.5 rounded-lg text-sm font-medium flex-shrink-0 ${
            result.ok
              ? "bg-emerald-950 text-emerald-300 border border-emerald-800"
              : "bg-red-950 text-red-300 border border-red-900"
          }`}>
            {result.msg}
          </div>
        )}

        {/* Actions */}
        <div className="px-6 pb-5 flex items-center justify-end gap-3 flex-shrink-0 border-t border-neutral-800 pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="text-sm px-4 py-2 rounded-lg border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-600 disabled:opacity-40 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSend}
            disabled={sending || result?.ok === true}
            className="text-sm font-semibold px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            {sending ? (
              <>
                <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Sending…
              </>
            ) : (
              "Send Email"
            )}
          </button>
        </div>

      </div>
    </div>
  );
}
