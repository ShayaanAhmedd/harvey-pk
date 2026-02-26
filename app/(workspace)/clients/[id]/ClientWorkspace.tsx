"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import CreateCaseForm from "@/components/cases/CreateCaseForm";

// ── Types ─────────────────────────────────────────────────────────────────────
type Client = {
  id: string;
  full_name: string;
  cnic: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  client_type: "individual" | "company";
  contact_name: string | null;
  notes: string | null;
  created_at: string;
};

type Case = {
  id: string;
  case_number: string;
  title: string;
  status: "active" | "adjourned" | "settled" | "closed";
  court: string | null;
  judge: string | null;
  filed_date: string | null;
  created_at: string;
};

type Chat = {
  id: string;
  title: string;
  case_id: string;
  created_at: string;
};

interface Props {
  client: Client;
  cases: Case[];
  chats: Chat[];
  role: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const STATUS_STYLES: Record<string, string> = {
  active:    "bg-emerald-50 text-emerald-700 border border-emerald-200",
  adjourned: "bg-amber-50  text-amber-700  border border-amber-200",
  settled:   "bg-blue-50   text-blue-700   border border-blue-200",
  closed:    "bg-gray-100  text-gray-600   border border-gray-200",
};

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="w-28 flex-shrink-0 text-gray-400 font-medium">{label}</span>
      <span className="text-gray-800">{value}</span>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function ClientWorkspace({ client, cases, chats, role }: Props) {
  const router = useRouter();
  const canEdit = role === "admin" || role === "lawyer";
  const [generating, setGenerating] = useState<string | null>(null); // caseId being generated
  const [genError, setGenError] = useState<string | null>(null);

  async function handleGenerateDocument(caseId: string) {
    setGenerating(caseId);
    setGenError(null);
    try {
      // 1. Create a blank document shell
      const createRes = await fetch(`/api/cases/${caseId}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Generating…" }),
      });
      if (!createRes.ok) throw new Error("Failed to create document");
      const doc = await createRes.json();

      // 2. Navigate to editor — generation happens from there
      router.push(`/cases/${caseId}/documents/${doc.id}?generate=1`);
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Generation failed");
      setGenerating(null);
    }
  }

  const initials = client.full_name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ── Top nav ──────────────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-gray-200 px-8 py-3 flex items-center gap-3 text-sm text-gray-500">
        <Link href="/" className="hover:text-gray-800 transition-colors">Workspace</Link>
        <span>/</span>
        <Link href="/clients" className="hover:text-gray-800 transition-colors">Clients</Link>
        <span>/</span>
        <span className="text-gray-900 font-medium">{client.full_name}</span>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">

        {/* ── Client Info Card ─────────────────────────────────────────────── */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-5 flex items-start gap-5">
            {/* Avatar */}
            <div className="w-14 h-14 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center text-xl font-bold flex-shrink-0 select-none">
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-xl font-semibold text-gray-900">{client.full_name}</h1>
                <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize bg-gray-100 text-gray-600 border border-gray-200">
                  {client.client_type}
                </span>
              </div>
              {client.contact_name && (
                <p className="text-sm text-gray-500 mt-0.5">c/o {client.contact_name}</p>
              )}
            </div>
            <div className="text-xs text-gray-400">
              Added {new Date(client.created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
            </div>
          </div>

          <div className="border-t border-gray-100 px-6 py-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <InfoRow label="CNIC"    value={client.cnic} />
            <InfoRow label="Phone"   value={client.phone} />
            <InfoRow label="Email"   value={client.email} />
            <InfoRow label="Address" value={client.address} />
            {client.notes && (
              <div className="sm:col-span-2">
                <InfoRow label="Notes" value={client.notes} />
              </div>
            )}
          </div>
        </div>

        {/* ── Cases ────────────────────────────────────────────────────────── */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-semibold text-gray-900">Cases</h2>
              <p className="text-xs text-gray-400 mt-0.5">{cases.length} matter{cases.length !== 1 ? "s" : ""} on record</p>
            </div>
            {canEdit && <CreateCaseForm clientId={client.id} clientName={client.full_name} />}
          </div>

          {genError && (
            <div className="mb-3 rounded-lg bg-red-50 border border-red-200 px-4 py-2 text-sm text-red-700">
              {genError}
            </div>
          )}

          {cases.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-300 bg-white px-6 py-10 text-center">
              <p className="text-gray-400 text-sm">No cases linked to this client.</p>
              {canEdit && <p className="text-gray-300 text-xs mt-1">Use "New Case" above to add the first matter.</p>}
            </div>
          ) : (
            <div className="space-y-3">
              {cases.map((c) => {
                const caseChats = chats.filter((ch) => ch.case_id === c.id);
                return (
                  <div key={c.id} className="bg-white rounded-xl border border-gray-200 shadow-sm hover:shadow transition-shadow">
                    <div className="px-5 py-4 flex items-start gap-4">
                      {/* Case info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 flex-wrap mb-1">
                          <span className="text-xs font-mono text-gray-400">{c.case_number}</span>
                          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[c.status] ?? STATUS_STYLES.closed}`}>
                            {c.status}
                          </span>
                        </div>
                        <p className="font-medium text-gray-900 text-sm leading-snug">{c.title}</p>
                        <div className="flex items-center gap-4 mt-2 text-xs text-gray-400 flex-wrap">
                          {c.court && <span>Court: {c.court}</span>}
                          {c.judge && <span>Judge: {c.judge}</span>}
                          {c.filed_date && <span>Filed: {c.filed_date}</span>}
                        </div>
                      </div>

                      {/* Actions */}
                      {canEdit && (
                        <div className="flex flex-col gap-2 flex-shrink-0">
                          <button
                            onClick={() => handleGenerateDocument(c.id)}
                            disabled={generating === c.id}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 transition-colors whitespace-nowrap"
                          >
                            {generating === c.id ? (
                              <>
                                <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                                </svg>
                                Opening…
                              </>
                            ) : (
                              <>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
                                  <path d="M9 12h6M9 16h6M17 21H7a2 2 0 01-2-2V5a2 2 0 012-2h7l5 5v11a2 2 0 01-2 2z" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                                Generate Document
                              </>
                            )}
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Linked chats */}
                    {caseChats.length > 0 && (
                      <div className="border-t border-gray-100 px-5 py-3">
                        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-2">Linked Chats</p>
                        <div className="flex flex-wrap gap-2">
                          {caseChats.map((ch) => (
                            <Link
                              key={ch.id}
                              href={`/?chat=${ch.id}`}
                              className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors"
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3 flex-shrink-0">
                                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                              {ch.title}
                            </Link>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

      </div>
    </div>
  );
}
