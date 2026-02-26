// GET /api/clients/[id]
// Returns client details, linked cases, and linked chats.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, full_name, cnic, phone, email, address, client_type, contact_name, notes, created_at")
    .eq("id", id)
    .maybeSingle();

  if (clientError || !client) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  const { data: cases } = await supabase
    .from("cases")
    .select("id, case_number, title, status, court, judge, filed_date, created_at")
    .eq("client_id", id)
    .order("created_at", { ascending: false });

  const caseIds = (cases ?? []).map((c) => c.id);
  let chats: { id: string; title: string; case_id: string; created_at: string }[] = [];
  if (caseIds.length > 0) {
    const { data: chatData } = await supabase
      .from("chats")
      .select("id, title, case_id, created_at")
      .in("case_id", caseIds)
      .order("created_at", { ascending: false });
    chats = chatData ?? [];
  }

  return NextResponse.json({ client, cases: cases ?? [], chats });
}
