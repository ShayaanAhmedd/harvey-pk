/**
 * UI Sound System — Web Audio API synthesized sounds.
 * No audio files. No latency. Zero bundle cost.
 */

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

// ── Preferences ────────────────────────────────────────────────────────────────
export interface SoundPrefs {
  enabled:      boolean;
  typing:       boolean;
  uiClick:      boolean;
  notification: boolean;
  clock:        boolean;
}

const DEFAULTS: SoundPrefs = {
  enabled:      true,
  typing:       true,
  uiClick:      true,
  notification: true,
  clock:        true,
};

export function getSoundPrefs(): SoundPrefs {
  try {
    const raw = typeof window !== "undefined" && localStorage.getItem("soundPrefs");
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function setSoundPrefs(prefs: Partial<SoundPrefs>) {
  const next = { ...getSoundPrefs(), ...prefs };
  localStorage.setItem("soundPrefs", JSON.stringify(next));
}

function prefs() { return getSoundPrefs(); }

// ── Core oscillator helper ─────────────────────────────────────────────────────
function beep(opts: {
  freq:     number;
  freq2?:   number;
  type?:    OscillatorType;
  attack?:  number;
  hold?:    number;
  release?: number;
  vol?:     number;
}) {
  const ac = getCtx();
  if (!ac) return;

  const { freq, freq2, type = "sine", attack = 0.004, hold = 0.04, release = 0.1, vol = 0.18 } = opts;

  const osc    = ac.createOscillator();
  const gain   = ac.createGain();
  const filter = ac.createBiquadFilter();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, ac.currentTime);
  if (freq2 !== undefined) {
    osc.frequency.linearRampToValueAtTime(freq2, ac.currentTime + attack + hold);
  }

  filter.type = "lowpass";
  filter.frequency.value = 6000;

  gain.gain.setValueAtTime(0, ac.currentTime);
  gain.gain.linearRampToValueAtTime(vol, ac.currentTime + attack);
  gain.gain.setValueAtTime(vol, ac.currentTime + attack + hold);
  gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + attack + hold + release);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(ac.destination);

  osc.start(ac.currentTime);
  osc.stop(ac.currentTime + attack + hold + release + 0.05);
}

// ── Sound definitions ──────────────────────────────────────────────────────────

/** Soft click — sending a message / button presses */
export function playClick() {
  if (!prefs().enabled || !prefs().uiClick) return;
  beep({ freq: 880, freq2: 780, type: "sine", attack: 0.003, hold: 0.01, release: 0.07, vol: 0.14 });
}

/** Subtle tick — AI starts responding */
export function playAiStart() {
  if (!prefs().enabled || !prefs().notification) return;
  beep({ freq: 660, freq2: 880, type: "sine", attack: 0.005, hold: 0.02, release: 0.12, vol: 0.12 });
}

/** Very soft tick — optional, while AI is typing */
export function playTypingTick() {
  if (!prefs().enabled || !prefs().typing) return;
  beep({ freq: 1200, type: "sine", attack: 0.002, hold: 0.005, release: 0.04, vol: 0.05 });
}

/** Soft confirm — research/response finished */
export function playSuccess() {
  if (!prefs().enabled || !prefs().notification) return;
  const ac = getCtx();
  if (!ac) return;
  // Two-note ascending chime
  [
    { freq: 660, delay: 0 },
    { freq: 880, delay: 0.12 },
  ].forEach(({ freq, delay }) => {
    setTimeout(() =>
      beep({ freq, type: "sine", attack: 0.005, hold: 0.04, release: 0.2, vol: 0.13 }),
      delay * 1000
    );
  });
}

/** Soft low tone — error */
export function playError() {
  if (!prefs().enabled || !prefs().notification) return;
  beep({ freq: 220, freq2: 180, type: "sine", attack: 0.008, hold: 0.06, release: 0.2, vol: 0.13 });
}

/** Flip clock tick — only when digit changes */
export function playClockTick() {
  if (!prefs().enabled || !prefs().clock) return;
  beep({ freq: 1400, type: "triangle", attack: 0.001, hold: 0.003, release: 0.03, vol: 0.07 });
}

/** Sidebar nav / toggle click */
export function playNavClick() {
  if (!prefs().enabled || !prefs().uiClick) return;
  beep({ freq: 740, type: "sine", attack: 0.003, hold: 0.008, release: 0.06, vol: 0.1 });
}
