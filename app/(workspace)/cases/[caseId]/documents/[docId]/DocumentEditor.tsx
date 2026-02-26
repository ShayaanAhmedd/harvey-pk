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

// ── Helpers ───────────────────────────────────────────────────────────────────
function plainToHtml(text: string): string {
  if (!text) return "<p></p>";
  // Already HTML — leave as-is
  if (text.trim().startsWith("<")) return text;
  // Convert plain text with ALL-CAPS headings
  return text
    .split(/\n\n+/)
    .map((block) => {
      const t = block.trim();
      if (!t) return "";
      const isHeading = t === t.toUpperCase() && t.length > 3 && !/^\d+[.)]\s/.test(t);
      if (isHeading) return `<h2>${t}</h2>`;
      // Numbered points
      return `<p>${t.replace(/\n/g, "<br>")}</p>`;
    })
    .filter(Boolean)
    .join("");
}

// ── Editor component ──────────────────────────────────────────────────────────
export default function DocumentEditor({ doc, caseData, role, autoGenerate }: Props) {
  const canEdit = role === "admin" || role === "lawyer";

  const [title, setTitle] = useState(doc.title);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "unsaved">("saved");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

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
  useEffect(() => {
    if (autoGenerate && canEdit) {
      generateDocument();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function generateDocument() {
    setGenerating(true);
    setGenError(null);
    try {
      const res = await fetch(`/api/cases/${doc.case_id}/documents/${doc.id}/generate`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(await res.text());
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
    // Flush any pending save first
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
          {/* Auto-save indicator */}
          <div className="flex items-center gap-1.5 text-xs text-gray-400 mr-auto">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${saveDot}`} />
            {saveLabel}
          </div>

          {canEdit && (
            <button
              onClick={generateDocument}
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
                  Regenerate
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
        <div className="max-w-[720px] mx-auto bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
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
              {/* Title */}
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

                {/* Empty state prompt */}
                {!generating && !editor?.getText()?.trim() && canEdit && (
                  <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
                    <div className="w-12 h-12 rounded-xl bg-indigo-50 flex items-center justify-center">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-6 h-6 text-indigo-500">
                        <path d="M9 12h6M9 16h6M17 21H7a2 2 0 01-2-2V5a2 2 0 012-2h7l5 5v11a2 2 0 01-2 2z" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-700">Document is empty</p>
                      <p className="text-xs text-gray-400 mt-1">Click "Regenerate" to draft with AI, or start typing below.</p>
                    </div>
                  </div>
                )}

                {/* TipTap editor */}
                <div className="prose prose-sm max-w-none prose-headings:font-bold prose-headings:text-gray-900 prose-headings:uppercase prose-headings:tracking-wide prose-p:text-gray-800 prose-p:leading-relaxed">
                  <EditorContent editor={editor} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
