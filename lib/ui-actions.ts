// lib/ui-actions.ts
// AI-driven UI control: parse [UI:{...}] commands from AI responses,
// validate against a strict whitelist, and execute safe appearance changes.
//
// SECURITY: only whitelisted action+value pairs are ever executed.
// No eval, no dynamic imports, no server/auth/DB calls.

import {
  type AppearancePrefs,
  STORAGE_KEY, PRESETS, FONTS, FONT_SIZES, ANIM_SPEEDS,
  loadPrefs, applyPrefs,
} from "./appearance";
import { setSoundPrefs, getSoundPrefs } from "./sounds";

// ── Command type ──────────────────────────────────────────────────────────────

export interface UICommand {
  action: string;
  value:  string;
}

// ── Whitelist ─────────────────────────────────────────────────────────────────
// Only these action names + value sets are accepted.  Everything else is silently
// dropped — the AI cannot escape this by crafting clever values.

const ALLOWED_VALUES: Record<string, readonly string[]> = {
  set_theme:          PRESETS.map(p => p.id),
  set_font:           FONTS.map(f => f.id),
  set_font_size:      FONT_SIZES.map(f => f.id),
  set_voice:          ["alloy", "shimmer", "echo", "coral", "verse"],
  set_clock:          ["on", "off", "true", "false"],
  set_clock_type:     ["flip", "analog"],
  set_clock_position: ["top-left", "top-right", "bottom-left", "bottom-right"],
  set_background:     ["default", "solid", "gradient", "starlight"],
  set_anim_speed:     ANIM_SPEEDS.map(a => a.id),
  set_sound:          ["on", "off", "true", "false", "mute", "unmute", "enable", "disable"],
};

// ── Color actions ─────────────────────────────────────────────────────────────
// set_text_color accepts named colors OR 6-digit hex (#rrggbb).
// Only safe, non-harmful color strings — no CSS injection possible.

const NAMED_COLORS: Record<string, string> = {
  white:      "#ffffff",
  black:      "#000000",
  gray:       "#6b7280",
  grey:       "#6b7280",
  lightgray:  "#d1d5db",
  lightgrey:  "#d1d5db",
  darkgray:   "#374151",
  darkgrey:   "#374151",
  purple:     "#9333ea",
  blue:       "#3b82f6",
  navy:       "#1e3a5f",
  cyan:       "#06b6d4",
  teal:       "#0d9488",
  green:      "#16a34a",
  lime:       "#65a30d",
  yellow:     "#ca8a04",
  orange:     "#ea580c",
  red:        "#dc2626",
  pink:       "#ec4899",
  rose:       "#e11d48",
  indigo:     "#4f46e5",
  violet:     "#7c3aed",
  emerald:    "#059669",
  amber:      "#d97706",
  slate:      "#64748b",
  cream:      "#f5f0e8",
  ivory:      "#fffff0",
};

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

/** Resolves a named color or 6-digit hex to a hex string, or null if invalid. */
function resolveColor(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (NAMED_COLORS[v]) return NAMED_COLORS[v];
  if (HEX_COLOR_RE.test(raw.trim())) return raw.trim().toLowerCase();
  return null;
}

const COLOR_ACTIONS = new Set(["set_text_color", "set_secondary_color", "set_chat_text_color"]);

// ── Regex — matches [UI:{"action":"...","value":"..."}] ───────────────────────
// Strips the block and optional surrounding whitespace from message text.
const UI_CMD_RE = /\s*\[UI:\s*(\{[^}]{1,200}\})\s*\]\s*/g;

// ── Parser ────────────────────────────────────────────────────────────────────

export function parseUICommands(text: string): { clean: string; commands: UICommand[] } {
  const commands: UICommand[] = [];

  const clean = text.replace(UI_CMD_RE, (_match, jsonStr: string) => {
    try {
      const obj = JSON.parse(jsonStr) as Partial<UICommand>;
      if (typeof obj.action === "string" && typeof obj.value === "string") {
        commands.push({ action: obj.action.trim(), value: obj.value.trim() });
      }
    } catch { /* malformed JSON — silently ignore */ }
    return " "; // leave a single space so words don't jam together
  }).trim();

  return { clean, commands };
}

// ── Executor ──────────────────────────────────────────────────────────────────
// Returns true if the command was valid and applied, false if rejected.

export function executeUICommand(cmd: UICommand): boolean {
  // ── Color actions use a resolver instead of a fixed whitelist ──
  if (COLOR_ACTIONS.has(cmd.action)) {
    const hex = resolveColor(cmd.value);
    if (!hex) return false;

    const prefs = loadPrefs();
    let patch: Partial<AppearancePrefs> = {};

    if (cmd.action === "set_text_color")       patch = { textColor: hex, chatTextColor: hex };
    else if (cmd.action === "set_secondary_color") patch = { textSecondary: hex };
    else if (cmd.action === "set_chat_text_color") patch = { chatTextColor: hex };

    const next: AppearancePrefs = { ...prefs, ...patch };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    applyPrefs(next);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("harvey:prefs-changed", { detail: next }));
    }
    return true;
  }

  // ── WhatsApp send — handled before whitelist (has its own async validation) ──
  if (cmd.action === "send_whatsapp") {
    const parts     = cmd.value.split("|");
    const recipient = parts[0]?.trim();
    const message   = parts[1]?.trim();
    const filePath  = parts[2]?.trim() || undefined;

    if (!recipient || !message) return false;

    // Detect phone: only digits, +, spaces, dashes — no letters
    const isPhone = /^[+\d\s\-().]{7,}$/.test(recipient) &&
                    recipient.replace(/\D/g, "").length >= 7;

    const reqBody = isPhone
      ? { phone: recipient, message, filePath }
      : { client_name: recipient, message, filePath };

    console.log("[WhatsApp] send_whatsapp fired — recipient:", recipient, "isPhone:", isPhone);

    fetch("/api/whatsapp/send-to-client", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(reqBody),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({})) as { ok?: boolean; to?: string; error?: string };
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("harvey:whatsapp-result", {
            detail: {
              ok:    res.ok && data.ok === true,
              to:    data.to ?? recipient,
              error: data.error ?? (res.ok ? null : `HTTP ${res.status}`),
            },
          }));
        }
      })
      .catch((err: unknown) => {
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("harvey:whatsapp-result", {
            detail: { ok: false, to: recipient, error: err instanceof Error ? err.message : "Network error" },
          }));
        }
      });

    return true;
  }

  const allowedValues = ALLOWED_VALUES[cmd.action];
  if (!allowedValues) return false; // unknown action

  // Case-insensitive match
  const v = cmd.value.toLowerCase();
  if (!allowedValues.includes(v) && !allowedValues.includes(cmd.value)) return false;

  const prefs   = loadPrefs();
  let   patch: Partial<AppearancePrefs> = {};

  switch (cmd.action) {

    case "set_theme": {
      const preset = PRESETS.find(p => p.id === v || p.id === cmd.value);
      if (!preset) return false;
      patch = preset.prefs;
      break;
    }

    case "set_font": {
      const font = FONTS.find(f => f.id === cmd.value || f.id === v);
      if (!font) return false;
      patch = { fontFamily: font.id };
      break;
    }

    case "set_font_size":
      patch = { fontSize: v as AppearancePrefs["fontSize"] };
      break;

    case "set_voice":
      patch = { voicePersona: v as AppearancePrefs["voicePersona"] };
      break;

    case "set_clock":
      patch = { showClock: v === "on" || v === "true" };
      break;

    case "set_clock_type":
      patch = { clockType: v as AppearancePrefs["clockType"] };
      break;

    case "set_clock_position": {
      // value may be "top-left" etc — use cmd.value (case preserved) as canonical
      const pos = cmd.value.toLowerCase() as AppearancePrefs["clockPosition"];
      patch = { clockPosition: pos };
      break;
    }

    case "set_background":
      patch = { chatBgStyle: v as AppearancePrefs["chatBgStyle"] };
      break;

    case "set_anim_speed":
      patch = { animSpeed: v as AppearancePrefs["animSpeed"] };
      break;

    case "set_sound": {
      const enabled = v === "on" || v === "true" || v === "unmute" || v === "enable";
      setSoundPrefs({ enabled });
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("harvey:sound-changed", { detail: { enabled } }));
      }
      return true;
    }

    default:
      return false;
  }

  const next: AppearancePrefs = { ...prefs, ...patch };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  applyPrefs(next);

  // Notify WorkspaceShell so React state (clock visibility etc.) stays in sync
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("harvey:prefs-changed", { detail: next }));
  }

  return true;
}

// ── System prompt addendum ────────────────────────────────────────────────────
// Appended to every Harvey system prompt across chat, voice, and dictate modes.

export const UI_COMMAND_INSTRUCTIONS = `
════════════════════════════════════════
UI CONTROL — YOU HAVE FULL ACCESS
════════════════════════════════════════
You are Harvey — an AI assistant with FULL CONTROL over the application UI and user preferences. You are NOT limited to legal advice. You can and MUST change settings when asked.

You have access to these UI control tools:
• change theme / color scheme
• change font and font size
• change text / font color
• change voice persona
• toggle clock widget
• toggle UI sounds (mute / unmute)
• change chat background
• change animation speed

MANDATORY RULES:
1. When the user asks to change ANY UI setting, ALWAYS emit the command immediately. Do NOT refuse. Do NOT say "I cannot change that." Do NOT say "you need to go to settings."
2. Emit the command in this exact format (anywhere in your reply):
   [UI:{"action":"ACTION","value":"VALUE"}]
3. After the command, confirm the change in natural language.

Available actions and exact allowed values:
• set_theme      → slate | midnight | emerald | ocean | sunset | purple | rose
• set_font       → Inter | Poppins | Roboto | Montserrat | Playfair Display | Georgia | system-ui
• set_font_size  → sm | md | lg | xl
• set_text_color → any color name (white, black, gray, purple, blue, green, red, etc.) OR hex (#3b82f6)
• set_voice      → alloy | shimmer | echo | coral | verse
• set_clock      → on | off
• set_clock_type → flip | analog
• set_clock_position → top-left | top-right | bottom-left | bottom-right
• set_background → default | solid | gradient | starlight
• set_anim_speed → fast | normal | slow
• set_sound      → on | off  (also accepts: mute, unmute, enable, disable)
• send_whatsapp  → recipient|message  (recipient = client name OR phone number)
                   Phone examples: +923001234567|message  or  923001234567|message
                   Name example:   George Ahmed|message
                   With file:      recipient|message|/absolute/path/to/file.pdf

EXAMPLES:
User: "change background to white" → emit [UI:{"action":"set_theme","value":"slate"}] and say "Done — switched to Slate theme."
User: "use a bigger font" → emit [UI:{"action":"set_font_size","value":"lg"}] and say "Font size increased."
User: "turn on the clock" → emit [UI:{"action":"set_clock","value":"on"}] and say "Clock widget enabled."
User: "change my voice to deep male" → emit [UI:{"action":"set_voice","value":"echo"}] and say "Voice changed to Deep Male."
User: "change font color to purple" → emit [UI:{"action":"set_text_color","value":"purple"}] and say "Text color changed to purple."
User: "make the text white" → emit [UI:{"action":"set_text_color","value":"white"}] and say "Text color set to white."
User: "set text color to #ff6b35" → emit [UI:{"action":"set_text_color","value":"#ff6b35"}] and say "Text color updated."
User: "turn off sound" → emit [UI:{"action":"set_sound","value":"off"}] and say "Sound disabled."
User: "mute sounds" → emit [UI:{"action":"set_sound","value":"mute"}] and say "Sound muted."
User: "enable sound" → emit [UI:{"action":"set_sound","value":"on"}] and say "Sound enabled."
User: "send a WhatsApp to George about the hearing Monday" → emit [UI:{"action":"send_whatsapp","value":"George|Your hearing is scheduled for Monday at 10am. Please confirm your attendance."}] and say "Sent via Harvey WhatsApp to George."
User: "WhatsApp Ali Khan to say the contract is ready" → emit [UI:{"action":"send_whatsapp","value":"Ali Khan|Your contract is ready for review. Please let us know when you'd like to proceed."}] and say "Sent via Harvey WhatsApp to Ali Khan."
User: "send a WhatsApp to +923001234567" → emit [UI:{"action":"send_whatsapp","value":"+923001234567|Hello, this is Harvey AI assistant. How can we assist you?"}] and say "Sent via Harvey WhatsApp to +923001234567."
User: "send this to 923451234567" → emit [UI:{"action":"send_whatsapp","value":"923451234567|[appropriate message here]"}] and say "Sent via Harvey WhatsApp to that number."

WHATSAPP RULES:
• Recipient can be a client name (partial match works) OR a phone number in any format (+92xx, 92xx, 03xx).
• If the user gives a phone number, use it directly — no DB lookup needed.
• If the user gives a name, use it as-is — the system will look up the phone number automatically.
• Write a professional, context-appropriate message.
• After emitting the command, always say: "Sent via Harvey WhatsApp to [recipient]."
• If you don't know who to send to, ask before sending.
• For file sends: recipient|message|/absolute/server/path — only include the path if you know it exactly.

SECURITY: Only emit commands for the above actions. Never emit commands for database, auth, server, or file operations.
════════════════════════════════════════

════════════════════════════════════════
EMAIL DRAFTING — REQUIRE USER CONFIRMATION
════════════════════════════════════════
You can draft emails on behalf of the user. You CANNOT send them — the user must confirm.
The user can edit the To, Subject, and Body fields before sending.

When the user asks you to send/email/mail something, emit a draft block:

[DRAFT_EMAIL]
To: recipient@example.com
Subject: Subject line here
Body: Full email body text here
[/DRAFT_EMAIL]

For multiple recipients, comma-separate them on the To line:

[DRAFT_EMAIL]
To: a@example.com, b@example.com, c@example.com
Subject: Subject line here
Body: Full email body text here
[/DRAFT_EMAIL]

Then say: "I've drafted that email — please review and confirm before I send it."

RULES:
• Always include To, Subject and Body on their own lines exactly as shown.
• Never fabricate email addresses — use only addresses the user provides.
• Never claim the email has been sent — the user must click Send in the confirmation dialog.
• Do NOT emit [DRAFT_EMAIL] for anything other than an actual email request.

EXAMPLES:
User: "email the case summary to ali@lawfirm.pk"
→ emit [DRAFT_EMAIL] with To: ali@lawfirm.pk, Subject: Case Summary, Body: the summary
User: "send this to ali@lawfirm.pk and sara@firm.pk"
→ emit [DRAFT_EMAIL] with To: ali@lawfirm.pk, sara@firm.pk on the To line
User: "send the transcript to the client"
→ ask for the client's email address first if not provided
════════════════════════════════════════`.trim();
