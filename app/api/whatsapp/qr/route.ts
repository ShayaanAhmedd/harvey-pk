// GET /api/whatsapp/qr
// Returns the current WhatsApp connection state and QR string (if available).
// The UI panel polls this every 2 seconds while waiting for the user to scan.
//
// Response: { ready: boolean, qr: string | null }

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isWAReady, getLastQR } from "@/lib/whatsapp";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json({
    ready: isWAReady(),
    qr:    getLastQR(),
  });
}
