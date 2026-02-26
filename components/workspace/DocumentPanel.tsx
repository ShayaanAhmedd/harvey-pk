"use client";

import { useState, useEffect, useRef } from "react";

type DocumentFile = {
  id: string;
  file_name: string;
  file_type: string;
  scope: string;
  created_at: string;
};

export type CaseSummary = {
  id: string;
  case_number: string;
  title: string;
};

interface Props {
  activeChatId: string | null;
  caseId: string | null;
  role: string | null;
  cases: CaseSummary[];
  casesLoading: boolean;
  onLinkCase: (caseId: string | null) => void;
}

export default function DocumentPanel({
  activeChatId,
  caseId,
  role,
  cases,
  casesLoading,
  onLinkCase,
}: Props) {
  const [activeTab, setActiveTab] = useState<"case" | "global">("case");
  const [documents, setDocuments] = useState<DocumentFile[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch document list when tab, caseId, or activeChatId changes
  useEffect(() => {
    if (!activeChatId) {
      setDocuments([]);
      return;
    }
    if (activeTab === "case" && !caseId) {
      setDocuments([]);
      return;
    }

    let cancelled = false;

    async function fetchDocuments() {
      setLoadingDocs(true);
      try {
        const url =
          activeTab === "global"
            ? "/api/documents?scope=global"
            : `/api/documents?scope=case&caseId=${caseId}`;

        const res = await fetch(url);
        if (res.ok && !cancelled) {
          setDocuments(await res.json());
        }
      } finally {
        if (!cancelled) setLoadingDocs(false);
      }
    }

    fetchDocuments();
    return () => { cancelled = true; };
  }, [activeChatId, caseId, activeTab]);

  async function handleUpload(file: File) {
    setUploading(true);
    setUploadError(null);

    const formData = new FormData();
    formData.append("file", file);

    if (activeTab === "global") {
      formData.append("scope", "global");
    } else if (caseId) {
      formData.append("caseId", caseId);
      formData.append("scope", "case");
    }

    const res = await fetch("/api/upload", { method: "POST", body: formData });

    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setUploadError(json.error ?? "Upload failed");
    } else {
      // Refresh list
      const url =
        activeTab === "global"
          ? "/api/documents?scope=global"
          : `/api/documents?scope=case&caseId=${caseId}`;
      const listRes = await fetch(url);
      if (listRes.ok) setDocuments(await listRes.json());
    }

    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const canUpload = activeTab === "global" ? role === "admin" : !!caseId;

  return (
    <aside className="w-80 flex-shrink-0 border-l border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 flex flex-col h-full transition-colors duration-300">

      {/* ── Panel header ─────────────────────────────────── */}
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Documents</h2>
        {caseId ? (
          <p className="text-xs text-green-600 dark:text-green-400 mt-0.5">Case linked</p>
        ) : (
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">No case selected</p>
        )}
      </div>

      {/* ── Case selector ─────────────────────────────────── */}
      {activeChatId && (
        <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-700">
          <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">
            Link to case
          </label>
          {casesLoading ? (
            <p className="text-xs text-gray-400 dark:text-gray-500 py-1">Loading cases…</p>
          ) : (
            <select
              value={caseId ?? ""}
              onChange={(e) => onLinkCase(e.target.value || null)}
              className="w-full text-xs rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1.5 text-gray-700 dark:text-gray-200 focus:outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors duration-300"
            >
              <option value="">— No case —</option>
              {cases.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.case_number} — {c.title}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* ── Scope toggle ─────────────────────────────────── */}
      <div className="flex border-b border-gray-200 dark:border-gray-700">
        <button
          onClick={() => setActiveTab("case")}
          className={`flex-1 py-2 text-xs font-medium transition-colors duration-300 ${
            activeTab === "case"
              ? "text-gray-900 dark:text-gray-100 border-b-2 border-gray-900 dark:border-gray-100"
              : "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
          }`}
        >
          Case Docs
        </button>
        <button
          onClick={() => setActiveTab("global")}
          className={`flex-1 py-2 text-xs font-medium transition-colors duration-300 ${
            activeTab === "global"
              ? "text-gray-900 dark:text-gray-100 border-b-2 border-gray-900 dark:border-gray-100"
              : "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
          }`}
        >
          Global KB
        </button>
      </div>

      {/* ── Document list ─────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-4">
        {!activeChatId ? (
          <p className="text-xs text-gray-400 dark:text-gray-500 text-center mt-8">
            Start a chat to manage documents.
          </p>
        ) : activeTab === "case" && !caseId ? (
          <p className="text-xs text-gray-400 dark:text-gray-500 text-center mt-8">
            Link this chat to a case to see case documents.
          </p>
        ) : loadingDocs ? (
          <p className="text-xs text-gray-400 dark:text-gray-500 text-center mt-8">Loading…</p>
        ) : documents.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-600 px-3 py-4 text-center">
            <p className="text-xs text-gray-400 dark:text-gray-500">No documents yet.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {documents.map((doc) => (
              <div
                key={doc.id}
                className="flex items-start gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 transition-colors duration-300"
              >
                <span className="text-gray-400 mt-0.5 flex-shrink-0">📄</span>
                <div className="min-w-0">
                  <p className="text-xs text-gray-700 dark:text-gray-200 font-medium truncate">
                    {doc.file_name}
                  </p>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5 uppercase">
                    {doc.file_type}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Upload section ───────────────────────────────── */}
      <div className="border-t border-gray-200 dark:border-gray-700 p-4">
        {uploadError && (
          <p className="text-xs text-red-500 dark:text-red-400 mb-2 text-center">{uploadError}</p>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept=".docx,.txt,.pdf"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleUpload(file);
          }}
        />

        <button
          disabled={!canUpload || uploading}
          onClick={() => fileInputRef.current?.click()}
          className="w-full flex items-center justify-center gap-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 px-3 py-3 text-sm text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-300"
        >
          {uploading ? (
            <>
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              Uploading…
            </>
          ) : (
            <>
              <span>↑</span>
              {activeTab === "global" ? "Add to Global KB" : "Upload document"}
            </>
          )}
        </button>

        {activeTab === "case" && !caseId && (
          <p className="text-xs text-gray-400 dark:text-gray-500 text-center mt-2">
            Link a case to enable uploads
          </p>
        )}
        {activeTab === "global" && role !== "admin" && (
          <p className="text-xs text-gray-400 dark:text-gray-500 text-center mt-2">
            Admin access required for Global KB
          </p>
        )}
      </div>

    </aside>
  );
}
