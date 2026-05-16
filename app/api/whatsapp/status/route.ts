// GET /api/whatsapp/status
// Returns whether the WhatsApp client is connected and ready to send.
// Also triggers lazy initialisation so the QR appears in the terminal.
// Admin-only — requires a valid user session.

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isWAReady, initWhatsApp } from "@/lib/whatsapp";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Lazy-init: start Puppeteer + show QR in terminal on first call
  if (!isWAReady()) {
    initWhatsApp().catch((err) =>
      console.error("[WhatsApp] Background init error:", err)
    );
  }

  return NextResponse.json({
    ready:   isWAReady(),
    message: isWAReady()
      ? "WhatsApp is connected and ready."
      : "WhatsApp is initialising — check the server terminal for the QR code to scan.",
  });
}
