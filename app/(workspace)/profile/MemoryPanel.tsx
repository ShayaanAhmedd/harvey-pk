"use client";

// MemoryPanel — import conversation history from other LLMs (ChatGPT, Claude, etc.)
// Supports: paste text, upload .txt/.md/.json files.
// Saved memories are injected into Harvey's system prompt as context.

import { useState, useEffect, useRef, useCallback } from "react";

interface MemoryItem {
  id:         string;
  title:      string;
  content:    string;
  case_id:    string | null;
  created_at: string;
}

type View = "list" | "import" | "edit";

export default function MemoryPanel() {
  const [memories,  setMemories]  = useState<MemoryItem[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [view,      setView]      = useState<View>("list");
  const [editTarget, setEditTarget] = useState<MemoryItem | null>(null);

  const [title,   setTitle]   = useState("");
  const [content, setContent] = useState("");
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchMemories = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/memory");
      if (res.ok) setMemories(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchMemories(); }, [fetchMemories]);

  // ── File upload ────────────────────────────────────────────────────────────
  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const text = await file.text();
    const baseName = file.name.replace(/\.[^.]+$/, "");

    if (file.name.endsWith(".json")) {
      try {
        const parsed = extractConversation(JSON.parse(text));
        setTitle(parsed.title || baseName);
        setContent(parsed.body);
      } catch {
        setTitle(baseName);
        setContent(text);
      }
    } else {
      setTitle(baseName);
      setContent(text);
    }

    setView("import");
    e.target.value = "";
  }

  // Parse common LLM export formats into readable text
  function extractConversation(json: unknown): { title: string; body: string } {
    if (typeof json !== "object" || json === null) return { title: "", body: JSON.stringify(json, null, 2) };

    const obj = json as Record<string, unknown>;

    // ChatGPT export: { title, mapping: { uuid: { message: { author, content } } } }
    if (obj.mapping && typeof obj.mapping === "object") {
      const lines: string[] = [];
      const mapping = obj.mapping as Record<string, {
        message?: { author?: { role?: string }; content?: { parts?: unknown[] } };
      }>;
      for (const node of Object.values(mapping)) {
        const msg = node.message;
        if (!msg?.author?.role || !msg.content?.parts) continue;
        const role    = msg.author.role === "user" ? "User" : "Assistant";
        const content = (msg.content.parts as unknown[])
          .filter((p): p is string => typeof p === "string")
          .join("");
        if (content.trim()) lines.push(`**${role}:** ${content}`);
      }
      return { title: String(obj.title ?? ""), body: lines.join("\n\n") };
    }

    // { messages: [{role, content}] }
    if (Array.isArray(obj.messages)) {
      const lines = (obj.messages as Record<string, unknown>[])
        .map(m => `**${String(m.role ?? "Unknown")}:** ${String(m.content ?? "")}`);
      return { title: String(obj.title ?? obj.name ?? ""), body: lines.join("\n\n") };
    }

    // Array of [{role, content}]
    if (Array.isArray(obj)) {
      const lines = (obj as Record<string, unknown>[])
        .map(m => `**${String(m.role ?? "Unknown")}:** ${String(m.content ?? "")}`);
      return { title: "", body: lines.join("\n\n") };
    }

    return { title: "", body: JSON.stringify(json, null, 2) };
  }

  // ── Save (create or update) ────────────────────────────────────────────────
  async function handleSave() {
    if (!content.trim()) { setError("Content cannot be empty."); return; }
    setSaving(true);
    setError(null);
    try {
      const isEdit = view === "edit" && editTarget;
      const res = await fetch(isEdit ? `/api/memory/${editTarget!.id}` : "/api/memory", {
        method:  isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ title: title.trim() || "Imported Memory", content: content.trim() }),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Failed to save.");
        return;
      }
      await fetchMemories();
      resetForm();
    } catch {
      setError("Network error.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this memory? Harvey will no longer use it as context.")) return;
    await fetch(`/api/memory/${id}`, { method: "DELETE" });
    setMemories(prev => prev.filter(m => m.id !== id));
    if (editTarget?.id === id) resetForm();
  }

  function startEdit(m: MemoryItem) {
    setEditTarget(m);
    setTitle(m.title);
    setContent(m.content);
    setError(null);
    setView("edit");
  }

  function startImport() {
    setEditTarget(null);
    setTitle("");
    setContent("");
    setError(null);
    setView("import");
  }

  function resetForm() {
    setView("list");
    setEditTarget(null);
    setTitle("");
    setContent("");
    setError(null);
  }

  // ── List view ─────────────────────────────────────────────────────────────
  if (view === "list") {
    return (
      <div className="bg-[#111111] rounded-xl border border-neutral-800 overflow-hidden">

        {/* Header row */}
        <div className="px-6 py-4 flex items-center justify-between border-b border-neutral-800">
          <div>
            <p className="text-sm font-medium text-neutral-200">Imported Memory</p>
            <p className="text-xs text-neutral-500 mt-0.5">
              Harvey uses these as context in every conversation.
            </p>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-300 transition-colors"
            >
              Upload file
            </button>
            <button
              onClick={startImport}
              className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-300 transition-colors"
            >
              Paste text
            </button>
          </div>
        </div>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.md,.json"
          className="hidden"
          onChange={handleFile}
        />

        {/* Memory list */}
        {loading ? (
          <div className="px-6 py-8 text-center">
            <div className="w-4 h-4 border-2 border-neutral-700 border-t-neutral-400 rounded-full animate-spin mx-auto" />
          </div>
        ) : memories.length === 0 ? (
          <div className="px-6 py-8 text-center">
            <p className="text-sm text-neutral-600">No imported memories yet.</p>
            <p className="text-xs text-neutral-700 mt-1">
              Paste a ChatGPT conversation, upload a .txt / .json export, and Harvey will use it as context.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-neutral-800/60">
            {memories.map((m) => (
              <li key={m.id} className="px-6 py-4 flex items-start justify-between gap-4 group">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-neutral-200 truncate">{m.title}</p>
                  <p className="text-xs text-neutral-600 mt-0.5 leading-relaxed line-clamp-2">
                    {m.content.slice(0, 140)}…
                  </p>
                  <p className="text-[11px] text-neutral-700 mt-1">
                    {new Date(m.created_at).toLocaleDateString("en-PK", { day: "numeric", month: "short", year: "numeric" })}
                  </p>
                </div>
                <div className="flex gap-2 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => startEdit(m)}
                    className="px-2.5 py-1 rounded text-xs text-neutral-400 hover:text-neutral-200 bg-neutral-800 hover:bg-neutral-700 transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(m.id)}
                    className="px-2.5 py-1 rounded text-xs text-red-500 hover:text-red-300 bg-neutral-800 hover:bg-red-900/40 transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // ── Import / Edit form ─────────────────────────────────────────────────────
  return (
    <div className="bg-[#111111] rounded-xl border border-neutral-800 overflow-hidden">

      {/* Form header */}
      <div className="px-6 py-4 border-b border-neutral-800 flex items-center justify-between">
        <p className="text-sm font-medium text-neutral-200">
          {view === "edit" ? `Editing: ${editTarget?.title}` : "Import Memory"}
        </p>
        <button
          onClick={resetForm}
          className="text-neutral-500 hover:text-neutral-200 text-lg leading-none transition-colors"
        >
          ×
        </button>
      </div>

      <div className="px-6 py-5 space-y-4">

        {/* Title */}
        <div>
          <label className="block text-[11px] font-semibold text-neutral-500 uppercase tracking-wide mb-1.5">
            Title
          </label>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="e.g. ChatGPT contract negotiation"
            className="w-full bg-neutral-900 border border-neutral-700 focus:border-indigo-500 rounded-lg px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 outline-none transition-colors"
          />
        </div>

        {/* Content */}
        <div>
          <label className="block text-[11px] font-semibold text-neutral-500 uppercase tracking-wide mb-1.5">
            Conversation / Text
          </label>
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder="Paste your conversation here — plain text, markdown, or any format…"
            rows={12}
            className="w-full bg-neutral-900 border border-neutral-700 focus:border-indigo-500 rounded-lg px-3 py-2.5 text-sm text-neutral-200 placeholder-neutral-600 outline-none transition-colors resize-y font-mono leading-relaxed"
          />
          <p className="text-[11px] text-neutral-700 mt-1">
            {content.length.toLocaleString()} characters
          </p>
        </div>

        {error && (
          <p className="text-xs text-red-400 bg-red-950/40 border border-red-900/60 rounded-lg px-3 py-2">
            {error}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="px-6 pb-5 flex items-center justify-end gap-3 border-t border-neutral-800 pt-4">
        <button
          onClick={resetForm}
          className="text-sm px-4 py-2 rounded-lg border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-600 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving || !content.trim()}
          className="text-sm font-semibold px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
        >
          {saving ? (
            <>
              <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Saving…
            </>
          ) : (
            view === "edit" ? "Save Changes" : "Save to Memory"
          )}
        </button>
      </div>
    </div>
  );
}
