"use client";

import { useState } from "react";

interface Settings {
  routing_strategy:     string;
  web_intelligence:     boolean;
  cross_validation:     boolean;
  draft_engine:         string;
  retrieval_strictness: string;
}

export default function PlatformForm({ defaults }: { defaults: Settings }) {
  const [values, setValues] = useState<Settings>(defaults);
  const [saving, setSaving]   = useState(false);
  const [saved,  setSaved]    = useState(false);
  const [error,  setError]    = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch("/api/platform-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? "Save failed");
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-[#111111] rounded-xl border border-neutral-800 overflow-hidden">
      <div className="divide-y divide-neutral-800/60">

        {/* Routing Strategy */}
        <div className="px-6 py-4 flex items-start justify-between gap-6">
          <div className="min-w-0">
            <p className="text-sm font-medium text-neutral-300">AI Routing Strategy</p>
            <p className="text-xs text-neutral-600 mt-1 leading-relaxed max-w-lg">
              Auto selects the most appropriate model based on query complexity. Manual locks to your default mode preference.
            </p>
          </div>
          <select
            value={values.routing_strategy}
            onChange={(e) => setValues((v) => ({ ...v, routing_strategy: e.target.value }))}
            className="flex-shrink-0 bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-neutral-500 transition-colors cursor-pointer"
          >
            <option value="auto">Auto</option>
            <option value="manual">Manual</option>
          </select>
        </div>

        {/* Web Intelligence */}
        <div className="px-6 py-4 flex items-start justify-between gap-6">
          <div className="min-w-0">
            <p className="text-sm font-medium text-neutral-300">Web Intelligence</p>
            <p className="text-xs text-neutral-600 mt-1 leading-relaxed max-w-lg">
              Enables Brave Search API integration in Web Mode. When disabled, Web Mode falls back to RAG-only retrieval without live sources.
            </p>
          </div>
          <Toggle
            enabled={values.web_intelligence}
            onChange={(v) => setValues((s) => ({ ...s, web_intelligence: v }))}
          />
        </div>

        {/* Cross-Validation */}
        <div className="px-6 py-4 flex items-start justify-between gap-6">
          <div className="min-w-0">
            <p className="text-sm font-medium text-neutral-300">Cross-Validation</p>
            <p className="text-xs text-neutral-600 mt-1 leading-relaxed max-w-lg">
              When enabled, Cross-Check Mode routes through both Gemini and Claude before returning a final answer. Increases latency; recommended for high-stakes submissions.
            </p>
          </div>
          <Toggle
            enabled={values.cross_validation}
            onChange={(v) => setValues((s) => ({ ...s, cross_validation: v }))}
          />
        </div>

        {/* Draft Engine */}
        <div className="px-6 py-4 flex items-start justify-between gap-6">
          <div className="min-w-0">
            <p className="text-sm font-medium text-neutral-300">Draft Engine</p>
            <p className="text-xs text-neutral-600 mt-1 leading-relaxed max-w-lg">
              Primary engine used in Draft Mode. Manus is optimised for court-ready Pakistani legal documents. Claude fallback is activated automatically on Manus failure.
            </p>
          </div>
          <select
            value={values.draft_engine}
            onChange={(e) => setValues((v) => ({ ...v, draft_engine: e.target.value }))}
            className="flex-shrink-0 bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-neutral-500 transition-colors cursor-pointer"
          >
            <option value="manus">Manus (Recommended)</option>
            <option value="claude">Claude Sonnet</option>
          </select>
        </div>

        {/* Retrieval Strictness */}
        <div className="px-6 py-4 flex items-start justify-between gap-6">
          <div className="min-w-0">
            <p className="text-sm font-medium text-neutral-300">Retrieval Strictness</p>
            <p className="text-xs text-neutral-600 mt-1 leading-relaxed max-w-lg">
              Controls the cosine similarity threshold for RAG chunk retrieval. Strict returns only high-confidence matches; Broad returns more results with lower precision.
            </p>
          </div>
          <select
            value={values.retrieval_strictness}
            onChange={(e) => setValues((v) => ({ ...v, retrieval_strictness: e.target.value }))}
            className="flex-shrink-0 bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-neutral-500 transition-colors cursor-pointer"
          >
            <option value="strict">Strict</option>
            <option value="balanced">Balanced</option>
            <option value="broad">Broad</option>
          </select>
        </div>

      </div>

      <div className="px-6 py-4 border-t border-neutral-800 flex items-center justify-between">
        <div className="text-xs">
          {error && <span className="text-red-400">{error}</span>}
          {saved && <span className="text-emerald-400">Settings saved.</span>}
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 rounded-lg bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 disabled:cursor-not-allowed text-xs font-medium text-neutral-100 transition-colors"
        >
          {saving ? "Saving…" : "Save Settings"}
        </button>
      </div>
    </div>
  );
}

function Toggle({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!enabled)}
      className={`relative flex-shrink-0 inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none ${
        enabled ? "bg-neutral-400" : "bg-neutral-700"
      }`}
      aria-pressed={enabled}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transform transition-transform duration-200 ${
          enabled ? "translate-x-4" : "translate-x-1"
        }`}
      />
    </button>
  );
}
