// lib/appearance.ts
// Shared appearance constants and pure functions used by AppearancePanel
// and lib/ui-actions (AI-driven UI control).

export const STORAGE_KEY = "harvey_appearance";

export interface AppearancePrefs {
  accentColor:   string;
  sidebarColor:  string;
  sidebarBorder: string;
  canvasBg:      string;
  userMsgBg:     string;
  userMsgText:   string;
  textColor:     string;
  textSecondary: string;
  chatTextColor: string;
  chatBgStyle:   "default" | "solid" | "gradient" | "starlight";
  fontFamily:    string;
  fontSize:      "sm" | "md" | "lg" | "xl";
  animSpeed:     "fast" | "normal" | "slow";
  showClock:     boolean;
  clockType:     "flip" | "analog";
  clockSize:     "sm" | "md" | "lg";
  clockPosition: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  voicePersona:  "alloy" | "shimmer" | "echo" | "coral" | "verse";
}

export const DEFAULTS: AppearancePrefs = {
  accentColor:   "#6b6bff",
  sidebarColor:  "#111113",
  sidebarBorder: "#2a2a2e",
  canvasBg:      "#0b0b0c",
  userMsgBg:     "#1e1e21",
  userMsgText:   "#e5e5e7",
  textColor:     "#e5e5e7",
  textSecondary: "#8e8e93",
  chatTextColor: "#e5e5e7",
  chatBgStyle:   "default",
  fontFamily:    "Inter",
  fontSize:      "md",
  animSpeed:     "normal",
  showClock:     false,
  clockType:     "flip",
  clockSize:     "md",
  clockPosition: "bottom-right",
  voicePersona:  "alloy",
};

export const PRESETS: { id: string; label: string; dot: string; prefs: Partial<AppearancePrefs> }[] = [
  { id: "slate",    label: "Slate",    dot: "bg-slate-500",   prefs: { accentColor: "#4f46e5", sidebarColor: "#e2e8f0", sidebarBorder: "#cbd5e1", canvasBg: "#ffffff" } },
  { id: "midnight", label: "Midnight", dot: "bg-gray-900",    prefs: { accentColor: "#6366f1", sidebarColor: "#0d0d0d", sidebarBorder: "#1a1a1a", canvasBg: "#0a0a0a" } },
  { id: "emerald",  label: "Emerald",  dot: "bg-emerald-600", prefs: { accentColor: "#059669", sidebarColor: "#d1fae5", sidebarBorder: "#6ee7b7", canvasBg: "#f0fdf4" } },
  { id: "ocean",    label: "Ocean",    dot: "bg-cyan-600",    prefs: { accentColor: "#0891b2", sidebarColor: "#cffafe", sidebarBorder: "#67e8f9", canvasBg: "#f0f9ff" } },
  { id: "sunset",   label: "Sunset",   dot: "bg-orange-500",  prefs: { accentColor: "#ea580c", sidebarColor: "#fff7ed", sidebarBorder: "#fdba74", canvasBg: "#fffbf5" } },
  { id: "purple",   label: "Purple",   dot: "bg-purple-600",  prefs: { accentColor: "#9333ea", sidebarColor: "#f3e8ff", sidebarBorder: "#c084fc", canvasBg: "#fdf4ff" } },
  { id: "rose",     label: "Rose",     dot: "bg-rose-500",    prefs: { accentColor: "#e11d48", sidebarColor: "#fff1f2", sidebarBorder: "#fda4af", canvasBg: "#fff5f5" } },
];

export const FONTS: { id: string; label: string; stack: string }[] = [
  { id: "Inter",            label: "Inter",    stack: "'Inter', system-ui, sans-serif" },
  { id: "Poppins",          label: "Poppins",  stack: "'Poppins', sans-serif" },
  { id: "Roboto",           label: "Roboto",   stack: "'Roboto', sans-serif" },
  { id: "Montserrat",       label: "Montserrat", stack: "'Montserrat', sans-serif" },
  { id: "Playfair Display", label: "Playfair", stack: "'Playfair Display', Georgia, serif" },
  { id: "Georgia",          label: "Georgia",  stack: "Georgia, 'Times New Roman', serif" },
  { id: "system-ui",        label: "System",   stack: "system-ui, -apple-system, sans-serif" },
];

export const FONT_SIZES: { id: "sm"|"md"|"lg"|"xl"; label: string; px: string }[] = [
  { id: "sm", label: "S",  px: "13px" },
  { id: "md", label: "M",  px: "14px" },
  { id: "lg", label: "L",  px: "15px" },
  { id: "xl", label: "XL", px: "16px" },
];

export const ANIM_SPEEDS: { id: "fast"|"normal"|"slow"; label: string; dur: string }[] = [
  { id: "fast",   label: "Fast",   dur: "0.5" },
  { id: "normal", label: "Normal", dur: "1" },
  { id: "slow",   label: "Slow",   dur: "1.8" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

export function hexToRgbStr(hex: string): string {
  try {
    const n = parseInt(hex.replace("#", ""), 16);
    return `${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}`;
  } catch { return "79, 70, 229"; }
}

export function shadeColor(hex: string, percent: number): string {
  try {
    const n = parseInt(hex.replace("#", ""), 16);
    const r = Math.max(0, Math.min(255, (n >> 16) + percent * 2));
    const g = Math.max(0, Math.min(255, ((n >> 8) & 0xff) + percent * 2));
    const b = Math.max(0, Math.min(255, (n & 0xff) + percent * 2));
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
  } catch { return hex; }
}

export function getContrastText(hex: string): string {
  try {
    const n = parseInt(hex.replace("#", ""), 16);
    const brightness = (((n >> 16) & 0xff) * 299 + ((n >> 8) & 0xff) * 587 + (n & 0xff) * 114) / 1000;
    return brightness < 128 ? "#ffffff" : "#111827";
  } catch { return "#111827"; }
}

export function getContrastSecondary(hex: string): string {
  try {
    const n = parseInt(hex.replace("#", ""), 16);
    const brightness = (((n >> 16) & 0xff) * 299 + ((n >> 8) & 0xff) * 587 + (n & 0xff) * 114) / 1000;
    return brightness < 128 ? "#9ca3af" : "#6b7280";
  } catch { return "#6b7280"; }
}

// ── Load / apply ──────────────────────────────────────────────────────────────

export function loadPrefs(): AppearancePrefs {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return DEFAULTS;
}

export function applyPrefs(prefs: AppearancePrefs): void {
  if (typeof document === "undefined") return;
  const r = document.documentElement;

  r.style.setProperty("--accent",          prefs.accentColor);
  r.style.setProperty("--accent-hover",    shadeColor(prefs.accentColor, -15));
  r.style.setProperty("--accent-rgb",      hexToRgbStr(prefs.accentColor));

  r.style.setProperty("--sidebar-bg",      prefs.sidebarColor);
  r.style.setProperty("--sidebar-border",  prefs.sidebarBorder);
  r.style.setProperty("--sidebar-text",    getContrastText(prefs.sidebarColor));

  r.style.setProperty("--canvas-bg",       prefs.canvasBg);
  r.style.setProperty("--text-color",      prefs.textColor     ?? getContrastText(prefs.canvasBg));
  r.style.setProperty("--text-secondary",  prefs.textSecondary ?? getContrastSecondary(prefs.canvasBg));
  r.style.setProperty("--chat-text-color", prefs.chatTextColor ?? getContrastText(prefs.canvasBg));
  r.style.setProperty("--user-msg-bg",     prefs.userMsgBg   ?? "#111827");
  r.style.setProperty("--user-msg-text",   prefs.userMsgText ?? getContrastText(prefs.userMsgBg ?? "#111827"));

  r.setAttribute("data-chat-bg", prefs.chatBgStyle ?? "default");

  const font = FONTS.find(f => f.id === prefs.fontFamily);
  r.style.setProperty("--font-family", font?.stack ?? FONTS[0].stack);

  const fs = FONT_SIZES.find(f => f.id === prefs.fontSize);
  r.style.setProperty("--font-size-base", fs?.px ?? "14px");

  const anim = ANIM_SPEEDS.find(a => a.id === prefs.animSpeed);
  const dur  = parseFloat(anim?.dur ?? "1");
  r.style.setProperty("--dur-fast", `${Math.round(150 * dur)}ms`);
  r.style.setProperty("--dur-mid",  `${Math.round(250 * dur)}ms`);
  r.style.setProperty("--dur-slow", `${Math.round(400 * dur)}ms`);

  r.setAttribute("data-theme", prefs.accentColor);
}
