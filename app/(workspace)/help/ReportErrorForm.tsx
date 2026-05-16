"use client";

import { useState } from "react";

export default function ReportErrorForm() {
  const [chatId,  setChatId]  = useState("");
  const [desc,    setDesc]    = useState("");
  const [submitted, setSubmitted] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Client-side only — opens a mailto with prefilled body
    const subject = encodeURIComponent("AI Error Report");
    const body    = encodeURIComponent(
      `Chat ID: ${chatId || "not provided"}\n\nDescription:\n${desc}`
    );
    window.location.href = `mailto:support@harvey.pk?subject=${subject}&body=${body}`;
    setSubmitted(true);
    setTimeout(() => setSubmitted(false), 4000);
  }

  return (
    <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
      <div>
        <label className="block text-xs font-medium text-neutral-500 mb-1">Chat ID</label>
        <input
          type="text"
          value={chatId}
          onChange={(e) => setChatId(e.target.value)}
          placeholder="Paste the chat ID from the browser URL"
          className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-neutral-500 transition-colors font-mono"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-neutral-500 mb-1">Error Description</label>
        <textarea
          rows={4}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="Describe the AI response that was incorrect. Include the query you sent and what was wrong with the response — e.g. fabricated statute, incorrect section number, misleading analysis."
          className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-neutral-500 transition-colors resize-none"
          required
        />
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs text-neutral-600">
          {submitted ? "Opening your mail client…" : "This will open your mail client with a pre-filled report."}
        </p>
        <button
          type="submit"
          className="rounded-lg bg-neutral-700 hover:bg-neutral-600 px-5 py-2 text-sm font-medium text-neutral-100 transition-colors"
        >
          Send Report
        </button>
      </div>
    </form>
  );
}
