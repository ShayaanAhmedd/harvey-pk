"use client";

import { useState, useEffect, useCallback } from "react";
import {
  type AppearancePrefs,
  DEFAULTS, STORAGE_KEY, PRESETS, FONTS, FONT_SIZES, ANIM_SPEEDS,
  loadPrefs, applyPrefs,
  hexToRgbStr, shadeColor, getContrastText, getContrastSecondary,
} from "@/lib/appearance";

export type { AppearancePrefs };


// ── Section ────────────────────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-6 py-5 border-b border-neutral-800/60 last:border-0">
      <p className="text-[11px] font-semibold uppercase tracking-widest text-neutral-600 mb-4">{title}</p>
      {children}
    </div>
  );
}

function Row({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div>
        <p className="text-sm font-medium text-neutral-300">{label}</p>
        {note && <p className="text-xs text-neutral-600 mt-0.5 leading-relaxed">{note}</p>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

// ── Color swatch + picker ──────────────────────────────────────────────────
function ColorPicker({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer group">
      <span
        className="w-7 h-7 rounded-lg border border-neutral-700 flex-shrink-0 transition-transform group-hover:scale-110"
        style={{ background: value }}
      />
      <span className="text-xs text-neutral-400 font-mono">{value}</span>
      <input
        type="color"
        value={value}
        onChange={e => onChange(e.target.value)}
        className="sr-only"
        aria-label={label}
      />
    </label>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
export default function AppearancePanel() {
  const [prefs, setPrefs] = useState<AppearancePrefs>(DEFAULTS);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const loaded = loadPrefs();
    setPrefs(loaded);
  }, []);

  const update = useCallback((patch: Partial<AppearancePrefs>) => {
    setPrefs(prev => {
      const next = { ...prev, ...patch };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      applyPrefs(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      return next;
    });
  }, []);

  function applyPreset(id: string) {
    const preset = PRESETS.find(p => p.id === id);
    if (preset) update(preset.prefs);
  }

  const currentFont = FONTS.find(f => f.id === prefs.fontFamily) ?? FONTS[0];

  return (
    <div className="bg-[#111111] rounded-2xl border border-neutral-800 overflow-hidden">

      {/* ── Presets ─────────────────────────────────────────────── */}
      <Section title="Theme Presets">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map(preset => {
            const isActive = prefs.accentColor === preset.prefs.accentColor &&
                             prefs.sidebarColor === preset.prefs.sidebarColor;
            return (
              <button
                key={preset.id}
                onClick={() => applyPreset(preset.id)}
                className={`flex flex-col items-center gap-2 px-3 py-3 rounded-xl border transition-all duration-200 ${
                  isActive
                    ? "border-indigo-500 bg-indigo-500/10"
                    : "border-neutral-800 hover:border-neutral-600 hover:bg-neutral-900/50"
                }`}
              >
                <span
                  className={`w-7 h-7 rounded-full ring-2 transition-all duration-200 ${
                    isActive ? "ring-indigo-400 ring-offset-2 ring-offset-[#111]" : "ring-transparent"
                  }`}
                  style={{ background: preset.prefs.accentColor }}
                />
                <span className="text-[10px] text-neutral-400">{preset.label}</span>
              </button>
            );
          })}
        </div>
      </Section>

      {/* ── Custom Colors ───────────────────────────────────────── */}
      <Section title="Custom Colors">
        <div className="space-y-4">
          <Row label="Accent / Primary" note="Buttons, links, active states">
            <ColorPicker
              label="Accent color"
              value={prefs.accentColor}
              onChange={v => update({ accentColor: v })}
            />
          </Row>
          <Row label="Sidebar Background" note="Left panel background">
            <ColorPicker
              label="Sidebar color"
              value={prefs.sidebarColor}
              onChange={v => update({ sidebarColor: v })}
            />
          </Row>
          <Row label="Sidebar Border">
            <ColorPicker
              label="Sidebar border color"
              value={prefs.sidebarBorder}
              onChange={v => update({ sidebarBorder: v })}
            />
          </Row>
          <Row label="Canvas Background" note="Main chat area">
            <ColorPicker
              label="Canvas background"
              value={prefs.canvasBg}
              onChange={v => update({
                canvasBg: v,
                canvas_bg_end: shadeColor(v, -4),
                textColor: getContrastText(v),
                chatTextColor: getContrastText(v),
                textSecondary: getContrastSecondary(v),
              } as Partial<AppearancePrefs>)}
            />
          </Row>
          <Row label="Text Color" note="Primary body text (auto from background)">
            <ColorPicker
              label="Text color"
              value={prefs.textColor ?? getContrastText(prefs.canvasBg)}
              onChange={v => update({ textColor: v })}
            />
          </Row>
          <Row label="Secondary Text" note="Labels, timestamps, hints">
            <ColorPicker
              label="Secondary text color"
              value={prefs.textSecondary ?? getContrastSecondary(prefs.canvasBg)}
              onChange={v => update({ textSecondary: v })}
            />
          </Row>
        </div>
      </Section>

      {/* ── Font Family ─────────────────────────────────────────── */}
      <Section title="Font Family">
        <div className="grid grid-cols-2 gap-2">
          {FONTS.map(font => (
            <button
              key={font.id}
              onClick={() => update({ fontFamily: font.id })}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-all duration-150 ${
                prefs.fontFamily === font.id
                  ? "border-indigo-500 bg-indigo-500/10"
                  : "border-neutral-800 hover:border-neutral-600 hover:bg-neutral-900/50"
              }`}
            >
              <span
                className="text-base font-medium text-neutral-200 select-none"
                style={{ fontFamily: font.stack }}
              >
                Aa
              </span>
              <span className="text-xs text-neutral-400">{font.label}</span>
              {prefs.fontFamily === font.id && (
                <span className="ml-auto text-indigo-400 text-xs">✓</span>
              )}
            </button>
          ))}
        </div>
        <div className="mt-4 px-4 py-3 rounded-xl bg-neutral-900/50 border border-neutral-800">
          <p
            className="text-sm text-neutral-300"
            style={{ fontFamily: currentFont.stack }}
          >
            The quick brown fox jumps over the lazy dog.
          </p>
          <p
            className="text-xs text-neutral-500 mt-1"
            style={{ fontFamily: currentFont.stack }}
          >
            AaBbCcDd 0123456789 — {currentFont.label}
          </p>
        </div>
      </Section>

      {/* ── Font Size ───────────────────────────────────────────── */}
      <Section title="Font Size">
        <Row label="Interface Text Size">
          <div className="flex items-center gap-1.5">
            {FONT_SIZES.map(f => (
              <button
                key={f.id}
                onClick={() => update({ fontSize: f.id })}
                className={`w-10 h-9 rounded-lg text-xs font-medium transition-all duration-150 ${
                  prefs.fontSize === f.id
                    ? "bg-indigo-600 text-white shadow-lg shadow-indigo-900/40"
                    : "bg-neutral-900 border border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </Row>
      </Section>

      {/* ── Animation Speed ─────────────────────────────────────── */}
      <Section title="Animation Speed">
        <Row label="Transition Duration">
          <div className="flex items-center gap-1.5">
            {ANIM_SPEEDS.map(a => (
              <button
                key={a.id}
                onClick={() => update({ animSpeed: a.id })}
                className={`px-3 h-9 rounded-lg text-xs font-medium transition-all duration-150 ${
                  prefs.animSpeed === a.id
                    ? "bg-indigo-600 text-white"
                    : "bg-neutral-900 border border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>
        </Row>
      </Section>

      {/* ── Chat Area Colors ────────────────────────────────────── */}
      <Section title="Chat Colors">
        <div className="space-y-4">
          <Row label="Background Style" note="Chat area visual style">
            <div className="flex gap-1.5 flex-wrap">
              {(["default", "solid", "gradient", "starlight"] as const).map(style => (
                <button
                  key={style}
                  onClick={() => update({ chatBgStyle: style })}
                  className={`px-2.5 h-8 rounded-lg text-[10px] font-semibold tracking-wide transition-all duration-150 ${
                    prefs.chatBgStyle === style
                      ? "bg-indigo-600 text-white shadow-lg shadow-indigo-900/40"
                      : "bg-neutral-900 border border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
                  }`}
                >
                  {style === "starlight" ? "✦ Starlight" : style.charAt(0).toUpperCase() + style.slice(1)}
                </button>
              ))}
            </div>
          </Row>
          <Row label="User Message Background">
            <ColorPicker
              label="User message background"
              value={prefs.userMsgBg ?? "#111827"}
              onChange={v => update({ userMsgBg: v, userMsgText: getContrastText(v) })}
            />
          </Row>
          <Row label="User Message Text" note="Auto from bubble background">
            <ColorPicker
              label="User message text color"
              value={prefs.userMsgText ?? getContrastText(prefs.userMsgBg ?? "#111827")}
              onChange={v => update({ userMsgText: v })}
            />
          </Row>
          <Row label="Chat Response Text" note="AI response text color">
            <ColorPicker
              label="Chat text color"
              value={prefs.chatTextColor ?? getContrastText(prefs.canvasBg)}
              onChange={v => update({ chatTextColor: v })}
            />
          </Row>
        </div>
      </Section>

      {/* ── Clock Widget ────────────────────────────────────────── */}
      <Section title="Clock Widget">
        <div className="space-y-4">
          <Row label="Show Clock">
            <button
              onClick={() => update({ showClock: !prefs.showClock })}
              className={`relative w-11 h-6 rounded-full transition-all duration-200 ${
                prefs.showClock ? "bg-indigo-600" : "bg-neutral-700"
              }`}
              role="switch"
              aria-checked={prefs.showClock}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
                prefs.showClock ? "translate-x-5" : "translate-x-0"
              }`} />
            </button>
          </Row>
          {prefs.showClock && (
            <>
              <Row label="Clock Type">
                <div className="flex gap-1.5">
                  {([
                    { value: "flip",   label: "Flip" },
                    { value: "analog", label: "Desk" },
                  ] as const).map(({ value, label }) => (
                    <button
                      key={value}
                      onClick={() => update({ clockType: value })}
                      className={`px-3 py-1.5 rounded-lg text-[10px] font-medium transition-all duration-150 ${
                        prefs.clockType === value
                          ? "bg-indigo-600 text-white"
                          : "bg-neutral-900 border border-neutral-700 text-neutral-400 hover:border-neutral-500"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </Row>
              <Row label="Size">
                <div className="flex gap-1.5">
                  {(["sm","md","lg"] as const).map(s => (
                    <button
                      key={s}
                      onClick={() => update({ clockSize: s })}
                      className={`px-3 py-1.5 rounded-lg text-[10px] font-medium transition-all duration-150 uppercase ${
                        prefs.clockSize === s
                          ? "bg-indigo-600 text-white"
                          : "bg-neutral-900 border border-neutral-700 text-neutral-400 hover:border-neutral-500"
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </Row>
              <Row label="Position">
                <div className="grid grid-cols-2 gap-1.5">
                  {(["top-left","top-right","bottom-left","bottom-right"] as const).map(pos => (
                    <button
                      key={pos}
                      onClick={() => update({ clockPosition: pos })}
                      className={`px-2.5 py-1.5 rounded-lg text-[10px] font-medium transition-all duration-150 capitalize ${
                        prefs.clockPosition === pos
                          ? "bg-indigo-600 text-white"
                          : "bg-neutral-900 border border-neutral-700 text-neutral-400 hover:border-neutral-500"
                      }`}
                    >
                      {pos.replace("-", " ")}
                    </button>
                  ))}
                </div>
              </Row>
            </>
          )}
        </div>
      </Section>

      {/* ── Voice ───────────────────────────────────────────────── */}
      <Section title="Voice">
        <Row label="Voice Type">
          <select
            value={prefs.voicePersona ?? "alloy"}
            onChange={e => update({ voicePersona: e.target.value as AppearancePrefs["voicePersona"] })}
            className="bg-neutral-900 border border-neutral-700 text-neutral-200 text-[11px] rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-indigo-500 transition-colors"
          >
            <option value="alloy">Young Male</option>
            <option value="shimmer">Young Female</option>
            <option value="echo">Deep Male</option>
            <option value="coral">Soft Female</option>
            <option value="verse">Neutral AI</option>
          </select>
        </Row>
        <p className="text-[10px] text-neutral-600 leading-relaxed">
          Applied to Live Voice calls. Changes take effect on the next call.
        </p>
      </Section>

      {/* ── Footer ──────────────────────────────────────────────── */}
      <div className="px-6 py-4 flex items-center justify-between bg-neutral-950/40">
        <p className="text-xs text-neutral-600">
          Changes apply instantly and persist across sessions.
        </p>
        <div className={`flex items-center gap-2 text-xs transition-all duration-300 ${saved ? "opacity-100" : "opacity-0"}`}>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          <span className="text-emerald-400">Saved</span>
        </div>
      </div>

    </div>
  );
}
