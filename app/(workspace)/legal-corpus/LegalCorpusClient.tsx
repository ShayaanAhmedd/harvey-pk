"use client";

// Client component — rendered by the server page after auth is verified.
// Handles all interactive state: upload form, corpus index, re-index, delete.

import { useState, useEffect, useCallback } from "react";
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
  const [file, setFile] = useState<File | null>(null);
  const [actName, setActName] = useState("");
  const [year, setYear] = useState("");
  const [jurisdiction, setJurisdiction] = useState("Pakistan");
  const [sourceUrl, setSourceUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<{ ok: boolean; text: string } | null>(null);

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
    if (!file || !actName.trim()) return;
    setUploading(true);
    setUploadMsg(null);

    const fd = new FormData();
    fd.append("file", file);
    fd.append("scope", "global");
    fd.append("act_name", actName.trim());
    if (year) fd.append("year", year);
    if (jurisdiction) fd.append("jurisdiction", jurisdiction);
    if (sourceUrl) fd.append("source_url", sourceUrl);

    try {
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (res.ok) {
        setUploadMsg({ ok: true, text: `Uploaded ${data.totalChunks} sections from "${actName}"` });
        setFile(null);
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
    <div className="min-h-screen bg-gray-100 p-10">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 mb-6"
      >
        ← Back to workspace
      </Link>

      <div className="max-w-4xl space-y-10">

        <div>
          <h1 className="text-2xl font-bold text-gray-900 mb-1">Legal Corpus</h1>
          <p className="text-sm text-gray-500">
            Pakistani statutes indexed here are automatically used in every chat as global knowledge.
            Law is hierarchical — each section is stored as a separate embedding.
          </p>
        </div>

        {/* ── Upload Act ── */}
        <section className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-base font-semibold text-gray-800 mb-4">Upload Act</h2>
          <form onSubmit={handleUpload} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Act Name <span className="text-red-500">*</span>
                </label>
                <input
                  value={actName}
                  onChange={(e) => setActName(e.target.value)}
                  placeholder="e.g. Pakistan Penal Code"
                  required
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-gray-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Year</label>
                <input
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                  placeholder="e.g. 1860"
                  type="number"
                  min="1800"
                  max="2100"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-gray-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Jurisdiction</label>
                <input
                  value={jurisdiction}
                  onChange={(e) => setJurisdiction(e.target.value)}
                  placeholder="Pakistan"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-gray-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Source URL</label>
                <input
                  value={sourceUrl}
                  onChange={(e) => setSourceUrl(e.target.value)}
                  placeholder="https://pakistancode.gov.pk/..."
                  type="url"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-gray-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Document File <span className="text-red-500">*</span>
              </label>
              <input
                type="file"
                accept=".pdf,.txt,.docx"
                required
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border file:border-gray-300 file:text-xs file:font-medium file:bg-white file:text-gray-700 hover:file:bg-gray-50"
              />
              <p className="text-xs text-gray-400 mt-1">Accepted: .pdf, .txt, .docx</p>
            </div>

            {uploadMsg && (
              <p className={`text-sm ${uploadMsg.ok ? "text-green-700" : "text-red-600"}`}>
                {uploadMsg.ok ? "✓" : "⚠"} {uploadMsg.text}
              </p>
            )}

            <button
              type="submit"
              disabled={uploading || !file || !actName.trim()}
              className="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm font-medium hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {uploading ? "Processing…" : "Upload & Index"}
            </button>
          </form>
        </section>

        {/* ── Corpus Index ── */}
        <section className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-gray-800">Corpus Index</h2>
            <button
              onClick={fetchActs}
              disabled={loadingActs}
              className="text-xs text-gray-500 hover:text-gray-800 disabled:opacity-50"
            >
              {loadingActs ? "Loading…" : "↻ Refresh"}
            </button>
          </div>

          {acts.length === 0 && !loadingActs && (
            <p className="text-sm text-gray-400 text-center py-8">
              No acts in corpus yet. Upload a document above.
            </p>
          )}

          {acts.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left">
                    <th className="pb-2 pr-4 font-medium text-gray-600 text-xs">Act</th>
                    <th className="pb-2 pr-4 font-medium text-gray-600 text-xs">Year</th>
                    <th className="pb-2 pr-4 font-medium text-gray-600 text-xs">Sections</th>
                    <th className="pb-2 pr-4 font-medium text-gray-600 text-xs">Storage</th>
                    <th className="pb-2 font-medium text-gray-600 text-xs">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {acts.map((act) => (
                    <tr key={act.act_name} className="group">
                      <td className="py-3 pr-4">
                        <span className="font-medium text-gray-800">{act.act_name}</span>
                        {act.jurisdiction && act.jurisdiction !== "Pakistan" && (
                          <span className="ml-2 text-xs text-gray-400">{act.jurisdiction}</span>
                        )}
                      </td>
                      <td className="py-3 pr-4 text-gray-500">{act.year ?? "—"}</td>
                      <td className="py-3 pr-4 text-gray-500">{act.chunk_count}</td>
                      <td className="py-3 pr-4">
                        {act.storage_path ? (
                          <span className="text-xs text-green-600">✓ stored</span>
                        ) : (
                          <span className="text-xs text-gray-400">no file</span>
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
