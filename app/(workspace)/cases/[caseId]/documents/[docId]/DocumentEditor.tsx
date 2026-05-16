"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "next/link";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Doc {
  id: string;
  case_id: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
}

interface CaseData {
  id: string;
  case_number: string;
  title: string;
  client_id: string | null;
}

interface Props {
  doc: Doc;
  caseData: CaseData | null;
  role: string | null;
  autoGenerate: boolean;
}

type Source = "case_details" | "chat_history" | "documents" | "custom";

const SOURCE_OPTIONS: { id: Source; label: string; description: string; icon: string }[] = [
  {
    id: "case_details",
    label: "Case Details",
    description: "Case title, court, judge, description, and client information.",
    icon: "M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2z M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16",
  },
  {
    id: "chat_history",
    label: "Chat History",
    description: "Conversations and legal analysis from this case's chats.",
    icon: "M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z",
  },
  {
    id: "documents",
    label: "Uploaded Documents",
    description: "Text extracted from documents indexed to this case.",
    icon: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6",
  },
  {
    id: "custom",
    label: "Custom Prompt",
    description: "Provide your own instructions for what to draft.",
    icon: "M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7 M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z",
  },
];

// ── Voice Calls Panel ─────────────────────────────────────────────────────────

interface VoiceCall {
  id: string;
  summary: string | null;
  transcript: { role: "user" | "assistant"; text: string; time: string }[];
  created_at: string;
}

function VoiceCallsPanel({ caseId }: { caseId: string }) {
  const [calls, setCalls]         = useState<VoiceCall[]>([]);
  const [loading, setLoading]     = useState(true);
  const [expanded, setExpanded]   = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/voice/calls?case_id=${caseId}`)
      .then(r => r.ok ? r.json() : [])
      .then((data: VoiceCall[]) => setCalls(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [caseId]);

  if (loading) return (
    <div className="flex items-center gap-2 text-xs text-gray-400 py-6">
      <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
      </svg>
      Loading voice calls…
    </div>
  );

  if (calls.length === 0) return (
    <p className="text-xs text-gray-400 py-6">No voice calls recorded for this case yet.</p>
  );

  return (
    <div className="space-y-3">
      {calls.map(call => {
        const isOpen = expanded === call.id;
        const date = new Date(call.created_at).toLocaleString("en-GB", {
          dateStyle: "medium", timeStyle: "short",
        });
        return (
          <div key={call.id} className="border border-gray-200 rounded-xl overflow-hidden">
            {/* Row header */}
            <button
              onClick={() => setExpanded(isOpen ? null : call.id)}
              className="w-full flex items-center justify-between px-4 py-3 bg-white hover:bg-gray-50 transition-colors text-left"
            >
              <div className="flex items-center gap-3">
                <span className="w-7 h-7 rounded-full bg-indigo-50 flex items-center justify-center flex-shrink-0">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                    strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 text-indigo-500">
                    <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.8 19.79 19.79 0 01.04 1.18 2 2 0 012 0h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 14h-.08z"/>
                  </svg>
                </span>
                <div>
                  <p className="text-xs font-medium text-gray-800">{date}</p>
                  {call.summary && (
                    <p className="text-xs text-gray-400 mt-0.5 line-clamp-1 max-w-md">{call.summary}</p>
                  )}
                </div>
              </div>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                className={`w-3.5 h-3.5 text-gray-400 flex-shrink-0 transition-transform ${isOpen ? "rotate-180" : ""}`}>
                <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>

            {/* Expanded detail */}
            {isOpen && (
              <div className="px-4 pb-4 bg-gray-50 border-t border-gray-100 space-y-4">
                {call.summary && (
                  <div className="pt-4">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-1.5">Summary</p>
                    <p className="text-sm text-gray-700 leading-relaxed">{call.summary}</p>
                  </div>
                )}
                <div className={call.summary ? "" : "pt-4"}>
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-2">Transcript</p>
                  <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                    {call.transcript.map((entry, i) => (
                      <div key={i} className={`flex gap-2.5 ${entry.role === "user" ? "flex-row-reverse" : ""}`}>
                        <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded flex-shrink-0 mt-0.5 ${
                          entry.role === "user"
                            ? "bg-indigo-100 text-indigo-600"
                            : "bg-emerald-100 text-emerald-700"
                        }`}>
                          {entry.role === "user" ? "You" : "Harvey"}
                        </span>
                        <div className={`text-xs text-gray-700 leading-relaxed flex-1 ${entry.role === "user" ? "text-right" : ""}`}>
                          <span className="text-gray-400 text-[9px] mr-1">({entry.time})</span>
                          {entry.text}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function plainToHtml(text: string): string {
  if (!text) return "<p></p>";
  if (text.trim().startsWith("<")) return text;
  return text
    .split(/\n\n+/)
    .map((block) => {
      const t = block.trim();
      if (!t) return "";
      const isHeading = t === t.toUpperCase() && t.length > 3 && !/^\d+[.)]\s/.test(t);
      if (isHeading) return `<h2>${t}</h2>`;
      return `<p>${t.replace(/\n/g, "<br>")}</p>`;
    })
    .filter(Boolean)
    .join("");
}

// ── Source Selection Modal ─────────────────────────────────────────────────────
interface ModalProps {
  onGenerate: (sources: Source[], customPrompt: string) => void;
  onClose: () => void;
  generating: boolean;
}

function SourceModal({ onGenerate, onClose, generating }: ModalProps) {
  const [selected, setSelected] = useState<Set<Source>>(new Set(["case_details"]));
  const [customPrompt, setCustomPrompt] = useState("");

  function toggle(id: Source) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const canGenerate =
    selected.size > 0 &&
    (!selected.has("custom") || customPrompt.trim().length > 0);

  function handleGenerate() {
    if (!canGenerate || generating) return;
    onGenerate(Array.from(selected), customPrompt.trim());
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-gray-100">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-base font-semibold text-gray-900">Generate Document</h2>
              <p className="text-xs text-gray-400 mt-0.5">Select what context to use. AI drafts from your selection only.</p>
            </div>
            <button
              onClick={onClose}
              className="text-gray-300 hover:text-gray-500 transition-colors ml-4 mt-0.5 flex-shrink-0"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Source options */}
        <div className="px-6 py-4 space-y-2">
          {SOURCE_OPTIONS.map((opt) => {
            const active = selected.has(opt.id);
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => toggle(opt.id)}
                className={`w-full flex items-start gap-3 px-4 py-3 rounded-xl border text-left transition-all duration-150 ${
                  active
                    ? "border-indigo-300 bg-indigo-50"
                    : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                }`}
              >
                {/* Checkbox */}
                <div className={`mt-0.5 w-4 h-4 rounded flex-shrink-0 border-2 flex items-center justify-center transition-colors ${
                  active ? "border-indigo-600 bg-indigo-600" : "border-gray-300"
                }`}>
                  {active && (
                    <svg viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                      <polyline points="2 6 5 9 10 3" />
                    </svg>
                  )}
                </div>

                {/* Icon */}
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors ${
                  active ? "bg-indigo-100" : "bg-gray-100"
                }`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
                    className={`w-4 h-4 ${active ? "text-indigo-600" : "text-gray-500"}`}>
                    {opt.icon.split(" M").map((d, i) => (
                      <path key={i} d={i === 0 ? d : `M${d}`} />
                    ))}
                  </svg>
                </div>

                {/* Text */}
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium ${active ? "text-indigo-900" : "text-gray-800"}`}>
                    {opt.label}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{opt.description}</p>
                </div>
              </button>
            );
          })}

          {/* Custom prompt textarea */}
          {selected.has("custom") && (
            <div className="pt-1">
              <textarea
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                placeholder="Describe what document to draft, specific instructions, or additional context…"
                rows={3}
                className="w-full text-sm border border-gray-200 rounded-xl px-4 py-3 text-gray-800 placeholder-gray-300 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 resize-none transition-all"
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 pb-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-gray-500 hover:text-gray-700 px-4 py-2 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={!canGenerate || generating}
            className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-5 py-2 rounded-xl transition-colors"
          >
            {generating ? (
              <>
                <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                Generating…
              </>
            ) : (
              "Generate Document"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Editor component ──────────────────────────────────────────────────────────
export default function DocumentEditor({ doc, caseData, role, autoGenerate }: Props) {
  const canEdit = role === "admin" || role === "lawyer";

  const [title, setTitle] = useState(doc.title);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "unsaved">("saved");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [showSourceModal, setShowSourceModal] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestContent = useRef<string>(doc.content);
  const latestTitle = useRef<string>(doc.title);

  // ── TipTap editor ──────────────────────────────────────────────────────────
  const editor = useEditor({
    extensions: [StarterKit],
    content: plainToHtml(doc.content),
    editable: canEdit,
    editorProps: {
      attributes: {
        class: "outline-none min-h-[600px] text-gray-900 leading-relaxed",
      },
    },
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      latestContent.current = html;
      setSaveState("unsaved");
      scheduleSave();
    },
  });

  // ── Debounced autosave ─────────────────────────────────────────────────────
  const save = useCallback(async (titleOverride?: string) => {
    setSaveState("saving");
    try {
      await fetch(`/api/cases/${doc.case_id}/documents/${doc.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: titleOverride ?? latestTitle.current,
          content: latestContent.current,
        }),
      });
      setSaveState("saved");
    } catch {
      setSaveState("unsaved");
    }
  }, [doc.case_id, doc.id]);

  function scheduleSave() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save(), 1500);
  }

  // ── Auto-generate on mount if flagged ─────────────────────────────────────
  // Uses default sources (case_details + chat_history) without showing modal
  useEffect(() => {
    if (autoGenerate && canEdit) {
      generateDocument(["case_details", "chat_history"], "");
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function generateDocument(sources: Source[], customPrompt: string) {
    setShowSourceModal(false);
    setGenerating(true);
    setGenError(null);
    try {
      const res = await fetch(`/api/cases/${doc.case_id}/documents/${doc.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sources, custom_prompt: customPrompt }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `Error ${res.status}`);
      }
      const updated = await res.json();
      const html = plainToHtml(updated.content);
      editor?.commands.setContent(html);
      latestContent.current = html;
      setTitle(updated.title);
      latestTitle.current = updated.title;
      setSaveState("saved");
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  async function handleExportPdf() {
    setExporting(true);
    if (saveTimer.current) { clearTimeout(saveTimer.current); await save(); }
    try {
      const res = await fetch(`/api/cases/${doc.case_id}/documents/${doc.id}/export`);
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${title.replace(/\s+/g, "-").toLowerCase()}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  function handleTitleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setTitle(e.target.value);
    latestTitle.current = e.target.value;
    setSaveState("unsaved");
    scheduleSave();
  }

  const saveLabel = saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : "Unsaved";
  const saveDot   = saveState === "saving" ? "bg-amber-400" : saveState === "saved" ? "bg-emerald-400" : "bg-red-400";

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">

      {/* ── Source selection modal ────────────────────────────────────────────── */}
      {showSourceModal && (
        <SourceModal
          onGenerate={generateDocument}
          onClose={() => setShowSourceModal(false)}
          generating={generating}
        />
      )}

      {/* ── Toolbar ──────────────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        {/* Breadcrumb */}
        <div className="px-6 py-2 flex items-center gap-2 text-xs text-gray-400 border-b border-gray-100">
          <Link href="/" className="hover:text-gray-700 transition-colors">Workspace</Link>
          <span>/</span>
          <Link href="/clients" className="hover:text-gray-700 transition-colors">Clients</Link>
          {caseData && (
            <>
              <span>/</span>
              <span className="text-gray-600">{caseData.case_number}</span>
            </>
          )}
          <span>/</span>
          <span className="text-gray-900">{title}</span>
        </div>

        {/* Actions bar */}
        <div className="px-6 py-3 flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-gray-400 mr-auto">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${saveDot}`} />
            {saveLabel}
          </div>

          {canEdit && (
            <button
              onClick={() => setShowSourceModal(true)}
              disabled={generating}
              className="inline-flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 transition-colors"
            >
              {generating ? (
                <>
                  <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                  Generating…
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
                    <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9l-7-7z" strokeLinecap="round" strokeLinejoin="round" />
                    <polyline points="13 2 13 9 20 9" />
                  </svg>
                  Generate Document
                </>
              )}
            </button>
          )}

          <button
            onClick={handleExportPdf}
            disabled={exporting}
            className="inline-flex items-center gap-2 rounded-lg bg-black px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-50 transition-colors"
          >
            {exporting ? (
              <>
                <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                Exporting…
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Export PDF
              </>
            )}
          </button>
        </div>
      </div>

      {/* ── Document area ────────────────────────────────────────────────────── */}
      <div className="flex-1 py-10 px-4">
        <div className="max-w-[720px] mx-auto space-y-6">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          {/* Generation overlay */}
          {generating && (
            <div className="flex flex-col items-center justify-center py-24 gap-4">
              <svg className="animate-spin w-8 h-8 text-indigo-500" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              <p className="text-sm text-gray-500">Drafting legal document…</p>
            </div>
          )}

          {!generating && (
            <div className="px-12 py-10">
              {canEdit ? (
                <input
                  value={title}
                  onChange={handleTitleChange}
                  placeholder="Document Title"
                  className="w-full text-2xl font-bold text-gray-900 bg-transparent border-none outline-none placeholder-gray-300 mb-2"
                />
              ) : (
                <h1 className="text-2xl font-bold text-gray-900 mb-2">{title}</h1>
              )}

              <div className="flex items-center gap-4 mb-8 text-xs text-gray-400">
                {caseData && <span>{caseData.case_number}</span>}
                <span>Last saved {new Date(doc.updated_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</span>
              </div>

              <div className="border-t border-gray-100 pt-8">
                {genError && (
                  <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-2 text-sm text-red-700">
                    {genError}
                  </div>
                )}

                {!generating && !editor?.getText()?.trim() && canEdit && (
                  <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
                    <div className="w-12 h-12 rounded-xl bg-indigo-50 flex items-center justify-center">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-6 h-6 text-indigo-500">
                        <path d="M9 12h6M9 16h6M17 21H7a2 2 0 01-2-2V5a2 2 0 012-2h7l5 5v11a2 2 0 01-2 2z" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-700">Document is empty</p>
                      <p className="text-xs text-gray-400 mt-1">
                        Click &ldquo;Generate Document&rdquo; to draft with AI, or start typing below.
                      </p>
                    </div>
                  </div>
                )}

                <div className="prose prose-sm max-w-none prose-headings:font-bold prose-headings:text-gray-900 prose-headings:uppercase prose-headings:tracking-wide prose-p:text-gray-800 prose-p:leading-relaxed">
                  <EditorContent editor={editor} />
                </div>
              </div>
            </div>
          )}
        </div>
        </div>

        {/* ── Voice Calls ──────────────────────────────────────────────────────── */}
        {doc.case_id && (
          <div className="max-w-[720px] mx-auto mt-6">
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-6 py-5">
              <div className="flex items-center gap-2 mb-4">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                  strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-indigo-500">
                  <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.8 19.79 19.79 0 01.04 1.18 2 2 0 012 0h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 14h-.08z"/>
                </svg>
                <h2 className="text-sm font-semibold text-gray-900">Voice Calls</h2>
              </div>
              <VoiceCallsPanel caseId={doc.case_id} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
