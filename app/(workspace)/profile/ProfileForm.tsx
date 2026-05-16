"use client";

import { useState } from "react";

interface Prefs {
  legal_role:     string;
  default_mode:   string;
  writing_style:  string;
  citation_style: string;
  output_density: string;
}

const FIELDS: {
  key: keyof Prefs;
  label: string;
  description: string;
  options: { value: string; label: string }[];
}[] = [
  {
    key: "legal_role",
    label: "Legal Role",
    description: "Your primary practice role. Used to tailor AI response framing and statutory emphasis.",
    options: [
      { value: "lawyer",    label: "Legal Counsel" },
      { value: "barrister", label: "Barrister" },
      { value: "judge",     label: "Judicial Officer" },
      { value: "staff",     label: "Support Staff" },
      { value: "student",   label: "Law Student" },
    ],
  },
  {
    key: "default_mode",
    label: "Default Response Mode",
    description: "The AI pipeline activated when no mode is explicitly selected in the chat interface.",
    options: [
      { value: "fast",      label: "Fast Mode (GPT-4o Mini)" },
      { value: "deep",      label: "Deep Research (Claude)" },
      { value: "web",       label: "Web Intelligence (Brave + GPT-4o)" },
      { value: "crosscheck",label: "Cross-Check (Gemini)" },
      { value: "draft",     label: "Draft Mode (Manus)" },
    ],
  },
  {
    key: "writing_style",
    label: "Writing Style",
    description: "Governs the register and formality of AI-generated analysis and correspondence.",
    options: [
      { value: "formal",      label: "Formal — Court Register" },
      { value: "analytical",  label: "Analytical — Academic" },
      { value: "plain",       label: "Plain Language" },
    ],
  },
  {
    key: "citation_style",
    label: "Citation Style",
    description: "Format applied when citing statutory provisions and case authority in responses.",
    options: [
      { value: "standard",    label: "Standard (Act Year, Section)" },
      { value: "bluebook",    label: "Bluebook" },
      { value: "oscola",      label: "OSCOLA" },
    ],
  },
  {
    key: "output_density",
    label: "Output Density",
    description: "Controls verbosity. Detailed includes full statutory extracts; concise returns summary analysis.",
    options: [
      { value: "detailed",  label: "Detailed — Full Extracts" },
      { value: "balanced",  label: "Balanced" },
      { value: "concise",   label: "Concise — Summary Only" },
    ],
  },
];

export default function ProfileForm({ defaults }: { defaults: Prefs }) {
  const [values, setValues] = useState<Prefs>(defaults);
  const [saving, setSaving]   = useState(false);
  const [saved,  setSaved]    = useState(false);
  const [error,  setError]    = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch("/api/preferences", {
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
        {FIELDS.map(({ key, label, description, options }) => (
          <div key={key} className="px-6 py-4 flex items-start justify-between gap-6">
            <div className="min-w-0">
              <p className="text-sm font-medium text-neutral-300">{label}</p>
              <p className="text-xs text-neutral-600 mt-1 leading-relaxed max-w-lg">{description}</p>
            </div>
            <select
              value={values[key]}
              onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
              className="flex-shrink-0 bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-neutral-500 transition-colors cursor-pointer"
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <div className="px-6 py-4 border-t border-neutral-800 flex items-center justify-between">
        <div className="text-xs">
          {error && <span className="text-red-400">{error}</span>}
          {saved && <span className="text-emerald-400">Preferences saved.</span>}
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 rounded-lg bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 disabled:cursor-not-allowed text-xs font-medium text-neutral-100 transition-colors"
        >
          {saving ? "Saving…" : "Save Preferences"}
        </button>
      </div>
    </div>
  );
}
