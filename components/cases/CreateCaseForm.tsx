"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  clientId: string;
  clientName: string;
}

export default function CreateCaseForm({ clientId, clientName }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function close() { setOpen(false); setError(null); }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const fd = new FormData(e.currentTarget);
    const payload = {
      case_number: fd.get("case_number"),
      title:       fd.get("title"),
      court:       fd.get("court")  || null,
      judge:       fd.get("judge")  || null,
      filed_date:  fd.get("filed_date") || null,
      description: fd.get("description") || null,
      status:      "active",
      client_id:   clientId,
    };

    const res = await fetch("/api/cases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (!res.ok) { setError(data.error ?? "Failed to create case."); setLoading(false); return; }

    router.refresh();
    close();
    setLoading(false);
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg bg-black px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800 transition-colors"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-4 h-4">
          <path d="M12 5v14M5 12h14" strokeLinecap="round" />
        </svg>
        New Case
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg bg-white rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-900">New Case</h2>
            <p className="text-xs text-gray-400 mt-0.5">Client: {clientName}</p>
          </div>
          <button onClick={close} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Case Number <span className="text-red-500">*</span>
              </label>
              <input
                name="case_number" required
                placeholder="2024-LHC-1234"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/20 focus:border-black"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Filed Date</label>
              <input
                name="filed_date" type="date"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/20 focus:border-black"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Case Title <span className="text-red-500">*</span>
            </label>
            <input
              name="title" required
              placeholder="e.g. Khan v. State — Murder Under Section 302"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/20 focus:border-black"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Court</label>
              <input
                name="court"
                placeholder="Lahore High Court"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/20 focus:border-black"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Judge</label>
              <input
                name="judge"
                placeholder="Hon. Justice Ahmed"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/20 focus:border-black"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Description</label>
            <textarea
              name="description" rows={3}
              placeholder="Brief description of the matter…"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/20 focus:border-black resize-none"
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          )}

          <div className="flex justify-end gap-3 pt-1">
            <button type="button" onClick={close}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={loading}
              className="rounded-lg bg-black px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50 transition-colors">
              {loading ? "Creating…" : "Create Case"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
