// DELETE /api/whatsapp/disconnect
// Destroys the WhatsApp client and deletes the saved session folder.
// The next connect will show a fresh QR code for re-linking.

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { destroySession } from "@/lib/whatsapp";

export async function DELETE() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    await destroySession(); // wipes client + session folder → next init shows fresh QR
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
