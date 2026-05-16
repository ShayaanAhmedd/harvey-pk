"use client";

// Client component — rendered by the server page after auth is verified.
// Handles all interactive state: upload form, corpus index, re-index, delete.

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";

type ActEntry = {
  act_name: string;
  year: number | null;
  jurisdiction: string | null;
  storage_path: string | null;
  chunk_count: number;
  created_at: string;
};

export default function LegalCorpusClient() {
  // ── Upload form state ──────────────────────────────────────
  const [files, setFiles] = useState<File[]>([]);
  const [actName, setActName] = useState("");
  const [year, setYear] = useState("");
  const [jurisdiction, setJurisdiction] = useState("Pakistan");
  const [sourceUrl, setSourceUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Hidden file inputs — one for individual files, one for folder (webkitdirectory)
  const fileInputRef   = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Set webkitdirectory via ref after mount (not a standard React prop)
  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute("webkitdirectory", "");
      folderInputRef.current.setAttribute("multiple", "");
    }
  }, []);

  // ── Corpus index state ─────────────────────────────────────
  const [acts, setActs] = useState<ActEntry[]>([]);
  const [loadingActs, setLoadingActs] = useState(false);
  const [reindexingAct, setReindexingAct] = useState<string | null>(null);
  const [deletingAct, setDeletingAct] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ act: string; ok: boolean; text: string } | null>(
    null
  );

  const fetchActs = useCallback(async () => {
    setLoadingActs(true);
    try {
      const res = await fetch("/api/legal-corpus");
      if (res.ok) setActs(await res.json());
    } finally {
      setLoadingActs(false);
    }
  }, []);

  useEffect(() => { fetchActs(); }, [fetchActs]);

  // ── Upload handler ─────────────────────────────────────────
  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (files.length === 0 || !actName.trim()) return;
    setUploading(true);
    setUploadMsg(null);

    const fd = new FormData();
    fd.append("scope", "global");
    fd.append("act_name", actName.trim());
    if (year) fd.append("year", year);
    if (jurisdiction) fd.append("jurisdiction", jurisdiction);
    if (sourceUrl) fd.append("source_url", sourceUrl);

    if (files.length === 1) {
      // Single file — use "file" key (backwards compatible)
      fd.append("file", files[0]);
    } else {
      // Multiple files — use "files" key
      for (const f of files) fd.append("files", f);
    }

    try {
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (res.ok) {
        const label = files.length === 1
          ? `Uploaded ${data.totalChunks} sections from "${actName}"`
          : `Uploaded ${data.totalChunks} sections from ${data.fileCount ?? files.length} files into "${actName}"`;
        setUploadMsg({ ok: true, text: label });
        setFiles([]);
        setActName("");
        setYear("");
        setSourceUrl("");
        fetchActs();
      } else {
        setUploadMsg({ ok: false, text: data.error ?? `Error ${res.status}` });
      }
    } catch (err: unknown) {
      setUploadMsg({ ok: false, text: err instanceof Error ? err.message : "Network error" });
    } finally {
      setUploading(false);
    }
  }

  // ── Reindex handler ────────────────────────────────────────
  async function handleReindex(act: ActEntry) {
    if (!act.storage_path) {
      setActionMsg({ act: act.act_name, ok: false, text: "No stored file — re-upload the document first." });
      return;
    }
    setReindexingAct(act.act_name);
    setActionMsg(null);
    try {
      const res = await fetch("/api/legal-corpus/reindex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ act_name: act.act_name }),
      });
      const data = await res.json();
      if (res.ok) {
        setActionMsg({ act: act.act_name, ok: true, text: `Re-indexed: ${data.new_chunk_count} sections` });
        fetchActs();
      } else {
        setActionMsg({ act: act.act_name, ok: false, text: data.error ?? `Error ${res.status}` });
      }
    } catch (err: unknown) {
      setActionMsg({ act: act.act_name, ok: false, text: err instanceof Error ? err.message : "Network error" });
    } finally {
      setReindexingAct(null);
    }
  }

  // ── Delete handler ─────────────────────────────────────────
  async function handleDelete(name: string) {
    if (!confirm(`Delete all chunks for "${name}"? This cannot be undone.`)) return;
    setDeletingAct(name);
    setActionMsg(null);
    try {
      const res = await fetch(`/api/legal-corpus?act=${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setActionMsg({ act: name, ok: true, text: "Deleted from corpus" });
        fetchActs();
      } else {
        const data = await res.json().catch(() => ({}));
        setActionMsg({ act: name, ok: false, text: data.error ?? `Error ${res.status}` });
      }
    } catch (err: unknown) {
      setActionMsg({ act: name, ok: false, text: err instanceof Error ? err.message : "Network error" });
    } finally {
      setDeletingAct(null);
    }
  }

  // ── Render ─────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-zinc-100 text-zinc-900 p-10">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 mb-6"
      >
        ← Back to workspace
      </Link>

      <div className="max-w-4xl space-y-10">

        <div>
          <h1 className="text-2xl font-bold text-zinc-900 mb-1">Legal Corpus</h1>
          <p className="text-sm text-zinc-500">
            Pakistani statutes indexed here are automatically used in every chat as global knowledge.
            Law is hierarchical — each section is stored as a separate embedding.
          </p>
        </div>

        {/* ── Upload Act ── */}
        <section className="bg-white rounded-xl border border-zinc-300 p-6">
          <h2 className="text-base font-semibold text-zinc-900 mb-4">Upload Act</h2>
          <form onSubmit={handleUpload} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">
                  Act Name <span className="text-red-500">*</span>
                </label>
                <input
                  value={actName}
                  onChange={(e) => setActName(e.target.value)}
                  placeholder="e.g. Pakistan Penal Code"
                  required
                  className="w-full rounded-lg border border-zinc-300 bg-white text-black px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Year</label>
                <input
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                  placeholder="e.g. 1860"
                  type="number"
                  min="1800"
                  max="2100"
                  className="w-full rounded-lg border border-zinc-300 bg-white text-black px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Jurisdiction</label>
                <input
                  value={jurisdiction}
                  onChange={(e) => setJurisdiction(e.target.value)}
                  placeholder="Pakistan"
                  className="w-full rounded-lg border border-zinc-300 bg-white text-black px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Source URL</label>
                <input
                  value={sourceUrl}
                  onChange={(e) => setSourceUrl(e.target.value)}
                  placeholder="https://pakistancode.gov.pk/..."
                  type="url"
                  className="w-full rounded-lg border border-zinc-300 bg-white text-black px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-2">
                Document File(s) <span className="text-red-500">*</span>
              </label>

              {/* Hidden inputs — triggered by buttons below */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.txt,.docx"
                multiple
                className="hidden"
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? []);
                  setFiles(picked);
                  e.target.value = "";
                }}
              />
              <input
                ref={folderInputRef}
                type="file"
                accept=".pdf,.txt,.docx"
                className="hidden"
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? []).filter((f) =>
                    /\.(pdf|txt|docx)$/i.test(f.name)
                  );
                  setFiles(picked);
                  e.target.value = "";
                }}
              />

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex-1 px-3 py-2 rounded-lg border border-zinc-300 bg-white text-sm text-zinc-700 hover:bg-zinc-50 hover:border-zinc-400 transition-colors text-left"
                >
                  Choose Files
                  <span className="block text-[10px] text-zinc-400 mt-0.5">Select one or more .pdf / .txt / .docx</span>
                </button>
                <button
                  type="button"
                  onClick={() => folderInputRef.current?.click()}
                  className="flex-1 px-3 py-2 rounded-lg border border-zinc-300 bg-white text-sm text-zinc-700 hover:bg-zinc-50 hover:border-zinc-400 transition-colors text-left"
                >
                  Choose Folder
                  <span className="block text-[10px] text-zinc-400 mt-0.5">Recursively picks all .pdf / .txt / .docx</span>
                </button>
              </div>

              {files.length > 0 ? (
                <div className="mt-2 flex items-center justify-between bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2">
                  <span className="text-xs text-zinc-600 font-medium">
                    {files.length === 1 ? files[0].name : `${files.length} files selected`}
                  </span>
                  <button
                    type="button"
                    onClick={() => setFiles([])}
                    className="text-xs text-red-500 hover:text-red-700 ml-3 flex-shrink-0"
                  >
                    × Clear
                  </button>
                </div>
              ) : (
                <p className="mt-2 text-xs text-zinc-400">No files selected</p>
              )}
            </div>

            {uploadMsg && (
              <p className={`text-sm ${uploadMsg.ok ? "text-green-700" : "text-red-600"}`}>
                {uploadMsg.ok ? "✓" : "⚠"} {uploadMsg.text}
              </p>
            )}

            <button
              type="submit"
              disabled={uploading || files.length === 0 || !actName.trim()}
              className="px-4 py-2 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {uploading ? "Processing…" : "Upload & Index"}
            </button>
          </form>
        </section>

        {/* ── Corpus Index ── */}
        <section className="bg-white rounded-xl border border-zinc-300 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-zinc-900">Corpus Index</h2>
            <button
              onClick={fetchActs}
              disabled={loadingActs}
              className="text-xs text-zinc-500 hover:text-zinc-800 disabled:opacity-50"
            >
              {loadingActs ? "Loading…" : "↻ Refresh"}
            </button>
          </div>

          {acts.length === 0 && !loadingActs && (
            <p className="text-sm text-zinc-400 text-center py-8">
              No acts in corpus yet. Upload a document above.
            </p>
          )}

          {acts.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-left">
                    <th className="pb-2 pr-4 font-medium text-zinc-600 text-xs">Act</th>
                    <th className="pb-2 pr-4 font-medium text-zinc-600 text-xs">Year</th>
                    <th className="pb-2 pr-4 font-medium text-zinc-600 text-xs">Sections</th>
                    <th className="pb-2 pr-4 font-medium text-zinc-600 text-xs">Storage</th>
                    <th className="pb-2 font-medium text-zinc-600 text-xs">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {acts.map((act) => (
                    <tr key={act.act_name} className="group">
                      <td className="py-3 pr-4">
                        <span className="font-medium text-zinc-900">{act.act_name}</span>
                        {act.jurisdiction && act.jurisdiction !== "Pakistan" && (
                          <span className="ml-2 text-xs text-zinc-400">{act.jurisdiction}</span>
                        )}
                      </td>
                      <td className="py-3 pr-4 text-zinc-500">{act.year ?? "—"}</td>
                      <td className="py-3 pr-4 text-zinc-500">{act.chunk_count}</td>
                      <td className="py-3 pr-4">
                        {act.storage_path ? (
                          <span className="text-xs text-green-600">✓ stored</span>
                        ) : (
                          <span className="text-xs text-zinc-400">no file</span>
                        )}
                      </td>
                      <td className="py-3">
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => handleReindex(act)}
                            disabled={reindexingAct === act.act_name || !act.storage_path}
                            className="text-xs text-blue-600 hover:text-blue-800 disabled:opacity-40 disabled:cursor-not-allowed"
                            title={act.storage_path ? "Re-embed all sections" : "No stored file"}
                          >
                            {reindexingAct === act.act_name ? "Indexing…" : "Re-index"}
                          </button>
                          <button
                            onClick={() => handleDelete(act.act_name)}
                            disabled={deletingAct === act.act_name}
                            className="text-xs text-red-500 hover:text-red-700 disabled:opacity-40"
                          >
                            {deletingAct === act.act_name ? "Deleting…" : "Delete"}
                          </button>
                        </div>

                        {actionMsg?.act === act.act_name && (
                          <p
                            className={`text-xs mt-1 ${
                              actionMsg.ok ? "text-green-600" : "text-red-500"
                            }`}
                          >
                            {actionMsg.ok ? "✓" : "⚠"} {actionMsg.text}
                          </p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

      </div>
    </div>
  );
}
