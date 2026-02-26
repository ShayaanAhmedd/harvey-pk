"use client";

// /legal-library — Admin-only Pakistani Legal Library viewer.
//
// Displays all indexed acts with year, section count, and per-act management
// actions (Re-index, Delete). Upload remains in /legal-corpus.

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type ActEntry = {
  act_name: string;
  year: number | null;
  jurisdiction: string | null;
  storage_path: string | null;
  chunk_count: number;
  created_at: string;
};

export default function LegalLibraryPage() {
  const router = useRouter();

  const [acts, setActs] = useState<ActEntry[]>([]);
  const [loadingActs, setLoadingActs] = useState(false);
  const [reindexingAct, setReindexingAct] = useState<string | null>(null);
  const [deletingAct, setDeletingAct] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{
    act: string;
    ok: boolean;
    text: string;
  } | null>(null);

  // Auth guard — redirect non-admins
  useEffect(() => {
    fetch("/api/me").then(async (r) => {
      if (!r.ok) { router.push("/"); return; }
      const { role } = await r.json();
      if (role !== "admin") router.push("/");
    });
  }, [router]);

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

  async function handleReindex(act: ActEntry) {
    if (!act.storage_path) {
      setActionMsg({
        act: act.act_name,
        ok: false,
        text: "No stored file — re-upload via Legal Corpus first.",
      });
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
        setActionMsg({
          act: act.act_name,
          ok: true,
          text: `Re-indexed: ${data.new_chunk_count} sections`,
        });
        fetchActs();
      } else {
        setActionMsg({
          act: act.act_name,
          ok: false,
          text: data.error ?? `Error ${res.status}`,
        });
      }
    } catch (err: unknown) {
      setActionMsg({
        act: act.act_name,
        ok: false,
        text: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setReindexingAct(null);
    }
  }

  async function handleDelete(actName: string) {
    if (!confirm(`Delete all indexed sections for "${actName}"? This cannot be undone.`)) return;
    setDeletingAct(actName);
    setActionMsg(null);
    try {
      const res = await fetch(
        `/api/legal-corpus?act=${encodeURIComponent(actName)}`,
        { method: "DELETE" }
      );
      if (res.ok) {
        setActionMsg({ act: actName, ok: true, text: "Removed from library" });
        fetchActs();
      } else {
        const data = await res.json().catch(() => ({}));
        setActionMsg({
          act: actName,
          ok: false,
          text: data.error ?? `Error ${res.status}`,
        });
      }
    } catch (err: unknown) {
      setActionMsg({
        act: actName,
        ok: false,
        text: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setDeletingAct(null);
    }
  }

  const totalSections = acts.reduce((sum, a) => sum + a.chunk_count, 0);

  return (
    <div className="min-h-screen bg-gray-100 p-10">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 mb-6"
      >
        ← Back to workspace
      </Link>

      <div className="max-w-4xl space-y-8">

        {/* ── Header ── */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 mb-1">Legal Library</h1>
            <p className="text-sm text-gray-500">
              All indexed Pakistani statutes used as global knowledge in every chat.
              Upload new acts via{" "}
              <Link href="/legal-corpus" className="text-blue-600 hover:underline">
                Legal Corpus
              </Link>
              .
            </p>
          </div>
          <button
            onClick={fetchActs}
            disabled={loadingActs}
            className="text-sm text-gray-500 hover:text-gray-800 disabled:opacity-50 border border-gray-200 rounded-lg px-3 py-1.5 bg-white"
          >
            {loadingActs ? "Loading…" : "↻ Refresh"}
          </button>
        </div>

        {/* ── Summary stats ── */}
        {acts.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div className="bg-white rounded-xl border border-gray-200 px-5 py-4">
              <p className="text-2xl font-bold text-gray-900">{acts.length}</p>
              <p className="text-xs text-gray-500 mt-0.5">Acts indexed</p>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 px-5 py-4">
              <p className="text-2xl font-bold text-gray-900">{totalSections.toLocaleString()}</p>
              <p className="text-xs text-gray-500 mt-0.5">Total sections</p>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 px-5 py-4">
              <p className="text-2xl font-bold text-gray-900">
                {acts.filter((a) => a.storage_path).length}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">With stored file</p>
            </div>
          </div>
        )}

        {/* ── Act table ── */}
        <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {acts.length === 0 && !loadingActs && (
            <div className="px-6 py-12 text-center">
              <p className="text-gray-400 text-sm">
                No acts indexed yet.{" "}
                <Link href="/legal-corpus" className="text-blue-600 hover:underline">
                  Upload one in Legal Corpus
                </Link>
                .
              </p>
            </div>
          )}

          {loadingActs && acts.length === 0 && (
            <div className="px-6 py-12 text-center">
              <p className="text-gray-400 text-sm">Loading…</p>
            </div>
          )}

          {acts.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr className="text-left">
                    <th className="px-5 py-3 font-medium text-gray-600 text-xs">Act</th>
                    <th className="px-5 py-3 font-medium text-gray-600 text-xs">Year</th>
                    <th className="px-5 py-3 font-medium text-gray-600 text-xs">Sections</th>
                    <th className="px-5 py-3 font-medium text-gray-600 text-xs">File</th>
                    <th className="px-5 py-3 font-medium text-gray-600 text-xs">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {acts.map((act) => (
                    <tr key={act.act_name} className="hover:bg-gray-50 transition-colors">
                      <td className="px-5 py-3">
                        <span className="font-medium text-gray-800">{act.act_name}</span>
                        {act.jurisdiction && act.jurisdiction !== "Pakistan" && (
                          <span className="ml-2 text-xs text-gray-400">{act.jurisdiction}</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-gray-500 tabular-nums">
                        {act.year ?? "—"}
                      </td>
                      <td className="px-5 py-3 text-gray-700 font-medium tabular-nums">
                        {act.chunk_count.toLocaleString()}
                      </td>
                      <td className="px-5 py-3">
                        {act.storage_path ? (
                          <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-50 border border-green-100 rounded-full px-2 py-0.5">
                            ✓ stored
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">no file</span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => handleReindex(act)}
                            disabled={reindexingAct === act.act_name || !act.storage_path}
                            className="text-xs text-blue-600 hover:text-blue-800 disabled:opacity-40 disabled:cursor-not-allowed"
                            title={act.storage_path ? "Re-embed all sections" : "No stored file — upload first"}
                          >
                            {reindexingAct === act.act_name ? "Re-indexing…" : "Re-index"}
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
