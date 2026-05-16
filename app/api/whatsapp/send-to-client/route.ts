// POST /api/whatsapp/send-to-client
//
// Unified WhatsApp send endpoint — accepts a phone number OR a client name.
// Used by the AI agent's send_whatsapp UI command and direct API calls.
//
// Body:
//   phone?       — phone number in any format (+923xx, 923xx, 03xx, 3xx…)
//   client_name? — partial name to look up from the `clients` table
//   message      — text to send (required unless filePath only)
//   filePath?    — absolute server path to attach as a file
//
// Resolution order:
//   1. If `phone` is provided → use it directly (no DB lookup)
//   2. If `client_name` looks like a phone number → treat it as a phone
//   3. Otherwise → look up client by name in DB
//
// Returns: { ok: true, to: string } or { error: string }

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sendWhatsApp, sendWhatsAppFile, isWAReady } from "@/lib/whatsapp";
import { findClientByName } from "@/lib/utils/find-client";

// Matches strings that are clearly phone numbers:
//   +923001234567 / 923001234567 / 03001234567 / 3001234567
// Must have at least 7 digits after stripping non-digit chars.
const PHONE_RE = /^[+\d\s\-().]{7,}$/;

function looksLikePhone(s: string): boolean {
  return PHONE_RE.test(s.trim()) && (s.replace(/\D/g, "").length >= 7);
}

export async function POST(req: Request) {
  // ── Auth ────────────────────────────────────────────────────
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // ── WhatsApp ready check ─────────────────────────────────────
  if (!isWAReady()) {
    return NextResponse.json(
      { error: "WhatsApp is not connected. Visit /api/whatsapp/status to initialise, then scan the QR code." },
      { status: 503 }
    );
  }

  // ── Parse body ───────────────────────────────────────────────
  let body: { phone?: string; client_name?: string; message?: string; filePath?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { phone, client_name, message, filePath } = body;

  console.log("[WhatsApp] /api/whatsapp/send-to-client called — phone:", phone, "client_name:", client_name);

  if (!phone && !client_name) {
    return NextResponse.json({ error: "phone or client_name is required" }, { status: 400 });
  }
  if (!message && !filePath) {
    return NextResponse.json({ error: "message or filePath is required" }, { status: 400 });
  }

  // ── Resolve recipient phone ───────────────────────────────────
  let resolvedPhone: string;
  let resolvedLabel: string; // for the response / logging

  if (phone) {
    // Explicit phone number — use directly
    resolvedPhone = phone;
    resolvedLabel = phone;
  } else if (looksLikePhone(client_name!)) {
    // client_name field contains a phone number
    resolvedPhone = client_name!;
    resolvedLabel = client_name!;
  } else {
    // Name → DB lookup
    const clientRow = await findClientByName(client_name!);
    if (!clientRow) {
      return NextResponse.json(
        { error: `No client found matching "${client_name}". Check the name or add them to the clients table.` },
        { status: 404 }
      );
    }
    if (!clientRow.phone) {
      return NextResponse.json(
        { error: `Client "${clientRow.name}" has no phone number on record.` },
        { status: 422 }
      );
    }
    resolvedPhone = clientRow.phone;
    resolvedLabel = clientRow.name;
  }

  // ── Send ─────────────────────────────────────────────────────
  console.log("[WhatsApp] Sending to resolved phone:", resolvedPhone, "label:", resolvedLabel);
  try {
    if (filePath) {
      await sendWhatsAppFile(resolvedPhone, filePath, message);
    } else {
      await sendWhatsApp(resolvedPhone, message!);
    }
    console.log("[WhatsApp] ✓ Message delivered to", resolvedLabel);
    return NextResponse.json({ ok: true, to: resolvedLabel });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[WhatsApp] ✗ Send failed for", resolvedLabel, ":", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
