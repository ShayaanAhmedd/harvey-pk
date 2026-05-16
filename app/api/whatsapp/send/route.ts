// POST /api/whatsapp/send
//
// Send a WhatsApp message directly by phone number.
// Body: { phone: string, message?: string, filePath?: string }
//
// phone    — recipient phone in any format (03xx, +92xx, 92xx)
// message  — plain-text message body (required unless filePath only)
// filePath — absolute server path to a file (PDF, DOCX, image, etc.)
//
// Returns: { ok: true } or { error: string }

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sendWhatsApp, sendWhatsAppFile, isWAReady } from "@/lib/whatsapp";

export async function POST(req: Request) {
  // ── Auth ────────────────────────────────────────────────────
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // ── WhatsApp ready check ─────────────────────────────────────
  if (!isWAReady()) {
    return NextResponse.json(
      { error: "WhatsApp is not connected. Visit /api/whatsapp/status to initialise, then scan the QR code in the server terminal." },
      { status: 503 }
    );
  }

  // ── Parse body ───────────────────────────────────────────────
  let body: { phone?: string; message?: string; filePath?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { phone, message, filePath } = body;

  console.log("[WhatsApp] /api/whatsapp/send called — phone:", phone, "hasFile:", !!filePath);

  if (!phone)              return NextResponse.json({ error: "phone is required" },                   { status: 400 });
  if (!message && !filePath) return NextResponse.json({ error: "message or filePath is required" }, { status: 400 });

  // ── Send ─────────────────────────────────────────────────────
  try {
    if (filePath) {
      await sendWhatsAppFile(phone, filePath, message);
    } else {
      await sendWhatsApp(phone, message!);
    }
    console.log("[WhatsApp] ✓ Message sent to", phone);
    return NextResponse.json({ ok: true, to: phone });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[WhatsApp] ✗ Send failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
