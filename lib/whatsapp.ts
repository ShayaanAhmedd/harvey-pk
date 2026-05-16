// lib/whatsapp.ts
//
// Stable singleton WhatsApp client for harvey-pk.
//
// Session persistence
// ───────────────────
// LocalAuth stores the session in  .wwebjs_auth/session-harvey/
// The folder must NOT be deleted between server restarts.
// On restart the client finds the saved session and reconnects without QR.
//
// Singleton guarantee
// ───────────────────
// All state lives on globalThis so it survives Next.js hot-reloads in dev
// and is shared across every API route in the same Node.js process.
//
// Initialisation lifecycle
// ────────────────────────
//   __waInitializing = false, __waReady = false  → not started
//   __waInitializing = true,  __waReady = false  → puppeteer launching / QR shown
//   __waInitializing = false, __waReady = true   → connected, ready to send
//
// IMPORTANT: __waInitializing is only cleared by the `ready` or `auth_failure`
// events — NOT by the return of initialize().  This prevents a second call to
// initWhatsApp() from creating a duplicate client during the window between
// initialize() resolving and the `ready` event firing.
//
// Public API
// ──────────
//   isWAReady()                              — true when connected
//   initWhatsApp()                           — start / resume (idempotent)
//   sendWhatsApp(phone, message)             — send text
//   sendWhatsAppFile(phone, path, caption?)  — send file
//   getLastQR()                              — current QR string (null when connected)
//   destroyWhatsApp()                        — disconnect, keep session folder
//   destroySession()                         — disconnect + wipe session (forces fresh QR)

import path from "path";
import { Client, LocalAuth, MessageMedia } from "whatsapp-web.js";

// ── Global state ──────────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __waClient:       Client | undefined;
  // eslint-disable-next-line no-var
  var __waReady:        boolean;
  // eslint-disable-next-line no-var
  var __waInitializing: boolean;
  // eslint-disable-next-line no-var
  var __waLastQR:       string | null;
}

// Use ?? so hot-reloads don't reset values that are already set
globalThis.__waClient       = globalThis.__waClient       ?? undefined;
globalThis.__waReady        = globalThis.__waReady        ?? false;
globalThis.__waInitializing = globalThis.__waInitializing ?? false;
globalThis.__waLastQR       = globalThis.__waLastQR       ?? null;

// ── Constants ─────────────────────────────────────────────────────────────────

// Absolute path — stable regardless of where `node` is invoked from
const AUTH_DATA_PATH = path.resolve(process.cwd(), ".wwebjs_auth");

// clientId gives a stable folder name: .wwebjs_auth/session-harvey/
const CLIENT_ID = "harvey";

// ── Client factory ────────────────────────────────────────────────────────────
// Called only when globalThis.__waClient is undefined.

function buildClient(): Client {
  console.log("[WhatsApp] Building new client — session path:", `${AUTH_DATA_PATH}/session-${CLIENT_ID}`);

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: CLIENT_ID,
      dataPath:  AUTH_DATA_PATH,
    }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
      ],
    },
  });

  // QR code — only shown when no saved session exists
  client.on("qr", (qr: string) => {
    globalThis.__waLastQR = qr;
    console.log("\n[WhatsApp] ── Scan the QR code below with WhatsApp on your phone ──");
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const qrTerm = require("qrcode-terminal") as {
        generate: (text: string, opts: { small: boolean }) => void;
      };
      qrTerm.generate(qr, { small: true });
    } catch {
      console.log("[WhatsApp] QR (raw):", qr.slice(0, 60), "…");
    }
    console.log("[WhatsApp] Waiting for scan…\n");
  });

  // Authenticated — session is now saved to disk
  client.on("authenticated", () => {
    console.log("[WhatsApp] ✓ Authenticated — session saved");
  });

  // Ready — clear __waInitializing HERE (not in initWhatsApp finally block)
  // This prevents a second initWhatsApp() call from sneaking in between
  // initialize() resolving and the ready event firing.
  client.on("ready", () => {
    console.log("[WhatsApp] ✓ Ready — messages can now be sent");
    globalThis.__waReady        = true;
    globalThis.__waInitializing = false;
    globalThis.__waLastQR       = null;
  });

  // Auth failure — clear flags so a fresh attempt can be made
  client.on("auth_failure", (msg: string) => {
    console.error("[WhatsApp] ✗ Auth failure:", msg);
    globalThis.__waReady        = false;
    globalThis.__waClient       = undefined;
    globalThis.__waInitializing = false;
  });

  // Disconnected — schedule an automatic reconnect using the saved session
  client.on("disconnected", (reason: string) => {
    console.log("[WhatsApp] Disconnected:", reason, "— will reconnect in 6 s");
    globalThis.__waReady        = false;
    globalThis.__waClient       = undefined; // dead — buildClient() on next init
    globalThis.__waInitializing = false;

    // Reconnect automatically; LocalAuth reloads saved session — no QR needed
    setTimeout(() => {
      initWhatsApp().catch((err: unknown) =>
        console.error("[WhatsApp] Auto-reconnect failed:", err)
      );
    }, 6_000);
  });

  return client;
}

// ── Singleton accessor ────────────────────────────────────────────────────────

function getWAClient(): Client {
  if (!globalThis.__waClient) {
    globalThis.__waClient = buildClient();
  }
  return globalThis.__waClient;
}

// ── Public: state queries ─────────────────────────────────────────────────────

export function isWAReady(): boolean {
  return globalThis.__waReady === true;
}

/** Returns the most recent QR string, or null when connected / not yet generated. */
export function getLastQR(): string | null {
  return globalThis.__waLastQR ?? null;
}

// ── Public: lifecycle ─────────────────────────────────────────────────────────

/**
 * Start the WhatsApp client. Safe to call multiple times — fully idempotent.
 *
 * If a saved session exists in .wwebjs_auth/session-harvey/ the client will
 * restore it and emit `ready` without showing a QR code.
 *
 * NOTE: __waInitializing stays true until the `ready` or `auth_failure` event
 * fires, not until initialize() returns.  This is intentional — it prevents a
 * race condition where a second initWhatsApp() call creates a duplicate client.
 */
export async function initWhatsApp(): Promise<void> {
  if (globalThis.__waInitializing || globalThis.__waReady) {
    console.log("[WhatsApp] initWhatsApp — skipped (already initializing or ready)");
    return;
  }

  globalThis.__waInitializing = true;
  console.log("[WhatsApp] initWhatsApp — starting…");

  // Safety net: if `ready` never fires (e.g. puppeteer crash), unblock after 3 min
  const safetyTimer = setTimeout(() => {
    if (globalThis.__waInitializing) {
      console.warn("[WhatsApp] Init timeout — clearing __waInitializing after 3 min");
      globalThis.__waInitializing = false;
      globalThis.__waClient       = undefined;
    }
  }, 3 * 60 * 1_000);
  if (safetyTimer.unref) safetyTimer.unref(); // don't keep the process alive

  try {
    // initialize() resolves when puppeteer is running & page is loaded.
    // The `ready` event fires slightly later once WhatsApp auth completes.
    // We do NOT clear __waInitializing here — the event handlers do that.
    await getWAClient().initialize();
    console.log("[WhatsApp] initialize() returned — waiting for ready event…");
  } catch (err) {
    console.error("[WhatsApp] initialize() threw:", err);
    globalThis.__waClient       = undefined;
    globalThis.__waInitializing = false;
    clearTimeout(safetyTimer);
  }
}

/**
 * Gracefully destroy the client.
 * Session folder is preserved — next initWhatsApp() reconnects without QR.
 */
export async function destroyWhatsApp(): Promise<void> {
  clearFlags();
  const client = globalThis.__waClient;
  globalThis.__waClient = undefined;
  try {
    if (client) await client.destroy();
  } catch {
    // ignore — client may already be dead
  }
}

/**
 * Destroy client AND wipe the session folder.
 * Next initWhatsApp() will show a fresh QR code.
 * Only call this on explicit user logout / re-link.
 */
export async function destroySession(): Promise<void> {
  await destroyWhatsApp();
  try {
    const fs  = await import("fs");
    const dir = path.join(AUTH_DATA_PATH, `session-${CLIENT_ID}`);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log("[WhatsApp] Session folder wiped — next connect will show new QR");
    }
  } catch (err) {
    console.error("[WhatsApp] Could not wipe session folder:", err);
  }
}

function clearFlags() {
  globalThis.__waReady        = false;
  globalThis.__waInitializing = false;
  globalThis.__waLastQR       = null;
}

// ── Public: phone normalisation ───────────────────────────────────────────────
//
//   +92 300 123 4567  → 923001234567@c.us
//   +923001234567     → 923001234567@c.us
//   923001234567      → 923001234567@c.us   (already correct)
//   03001234567       → 923001234567@c.us
//   3001234567        → 923001234567@c.us   (10 digits assumed PK local)

export function formatPhone(phone: string): string {
  if (phone.includes("@c.us")) return phone;                  // already formatted

  const digits = phone.replace(/\D/g, "");                    // strip non-digits
  if (!digits) throw new Error(`Invalid phone number: "${phone}"`);

  let normalized: string;
  if (digits.startsWith("92") && digits.length >= 12) {
    normalized = digits;                                       // already 92xxxxxxxxxx
  } else if (digits.startsWith("0") && digits.length >= 10) {
    normalized = `92${digits.slice(1)}`;                      // 0300… → 9200300…
  } else if (digits.length >= 9) {
    normalized = `92${digits}`;                               // 300… → 92300…
  } else {
    throw new Error(`Phone number too short: "${digits}" (need ≥ 9 digits)`);
  }

  return `${normalized}@c.us`;
}

// ── Public: send ──────────────────────────────────────────────────────────────

/** Send a plain-text WhatsApp message. */
export async function sendWhatsApp(phone: string, message: string): Promise<void> {
  if (!isWAReady()) {
    throw new Error("WhatsApp is not connected. Check the server terminal for the QR code.");
  }
  const chatId = formatPhone(phone);
  console.log("[WhatsApp] sendWhatsApp → chatId:", chatId);
  await getWAClient().sendMessage(chatId, message);
  console.log("[WhatsApp] sendWhatsApp ✓ sent");
}

/**
 * Send a file via WhatsApp.
 * filePath must be an absolute path on the server filesystem.
 */
export async function sendWhatsAppFile(
  phone:    string,
  filePath: string,
  caption?: string,
): Promise<void> {
  if (!isWAReady()) {
    throw new Error("WhatsApp is not connected. Check the server terminal for the QR code.");
  }
  const chatId = formatPhone(phone);
  console.log("[WhatsApp] sendWhatsAppFile → chatId:", chatId, "file:", filePath);
  const media = MessageMedia.fromFilePath(filePath);
  await getWAClient().sendMessage(chatId, media, { caption });
  console.log("[WhatsApp] sendWhatsAppFile ✓ sent");
}

// ── Auto-init on server startup ───────────────────────────────────────────────
// When this module is first imported by a Node.js API route, kick off init
// immediately via setImmediate (keeps module loading synchronous).
// If a saved session exists in .wwebjs_auth/session-harvey/ it reconnects
// silently — no QR code needed.

if (typeof window === "undefined") {
  setImmediate(() => {
    if (!globalThis.__waInitializing && !globalThis.__waReady) {
      initWhatsApp().catch((err: unknown) =>
        console.error("[WhatsApp] Startup init error:", err)
      );
    }
  });
}
