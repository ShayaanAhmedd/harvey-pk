"use client";

import { useState, useEffect } from "react";
import { getSoundPrefs, setSoundPrefs, type SoundPrefs, playClick, playSuccess } from "@/lib/sounds";

interface ToggleRowProps {
  label:       string;
  description: string;
  checked:     boolean;
  onChange:    (v: boolean) => void;
  disabled?:   boolean;
}

function ToggleRow({ label, description, checked, onChange, disabled }: ToggleRowProps) {
  return (
    <label className={`flex items-start justify-between gap-4 px-5 py-4 cursor-pointer select-none transition-colors duration-150 ${disabled ? "opacity-40 cursor-not-allowed" : "hover:bg-white/[0.02]"}`}>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-neutral-100 leading-snug">{label}</p>
        <p className="text-[11px] text-neutral-500 mt-0.5 leading-relaxed">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => { if (!disabled) { onChange(!checked); playClick(); } }}
        className={`relative flex-shrink-0 mt-0.5 w-10 h-5.5 rounded-full transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
          checked
            ? "bg-indigo-600 focus-visible:ring-indigo-500"
            : "bg-neutral-700 focus-visible:ring-neutral-500"
        }`}
        style={{ width: 40, height: 22 }}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-[18px] h-[18px] rounded-full bg-white shadow transition-transform duration-200 ${checked ? "translate-x-[18px]" : "translate-x-0"}`}
        />
      </button>
    </label>
  );
}

export default function SoundPanel() {
  const [prefs, setPrefs] = useState<SoundPrefs>({
    enabled:      true,
    typing:       true,
    uiClick:      true,
    notification: true,
    clock:        true,
  });

  useEffect(() => {
    setPrefs(getSoundPrefs());
  }, []);

  function update(patch: Partial<SoundPrefs>) {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    setSoundPrefs(next);
  }

  function handleTestSound() {
    playSuccess();
  }

  return (
    <div className="bg-[#111111] rounded-xl border border-neutral-800 divide-y divide-neutral-800/60">

      <ToggleRow
        label="Sound Effects"
        description="Master switch — disabling this silences all UI sounds."
        checked={prefs.enabled}
        onChange={(v) => update({ enabled: v })}
      />

      <ToggleRow
        label="UI Click Sounds"
        description="Soft click when pressing buttons, sending messages, toggling options."
        checked={prefs.uiClick}
        onChange={(v) => update({ uiClick: v })}
        disabled={!prefs.enabled}
      />

      <ToggleRow
        label="Typing Sounds"
        description="Very subtle tick while AI is generating a response."
        checked={prefs.typing}
        onChange={(v) => update({ typing: v })}
        disabled={!prefs.enabled}
      />

      <ToggleRow
        label="Notification Sounds"
        description="Soft chime when a response completes or an error occurs."
        checked={prefs.notification}
        onChange={(v) => update({ notification: v })}
        disabled={!prefs.enabled}
      />

      <ToggleRow
        label="Clock Tick"
        description="Subtle tick when the flip clock digit changes."
        checked={prefs.clock}
        onChange={(v) => update({ clock: v })}
        disabled={!prefs.enabled}
      />

      <div className="px-5 py-4 flex items-center justify-between">
        <p className="text-[11px] text-neutral-500">Test the current sound configuration.</p>
        <button
          type="button"
          onClick={handleTestSound}
          disabled={!prefs.enabled}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-neutral-700 text-neutral-300 hover:bg-neutral-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors duration-150"
        >
          Play test sound
        </button>
      </div>

    </div>
  );
}
