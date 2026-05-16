// GET  /api/chats — list the caller's chats (newest first)
// POST /api/chats — create a new chat

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** Serialise a Supabase error with every diagnostic field. */
function dbError(label: string, err: any) {
  return {
    at: label,
    message: err?.message ?? null,
    code: err?.code ?? null,
    details: err?.details ?? null,
    hint: err?.hint ?? null,
  };
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError) {
    return NextResponse.json({ error: "Auth error", details: authError.message }, { status: 401 });
  }
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("chats")
    .select("id, title, case_id, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    const detail = dbError("chats.select", error);
    return NextResponse.json({ error: "Database query failed", detail }, { status: 500 });
  }

  return NextResponse.json(data);
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError) {
    return NextResponse.json({ error: "Auth error", details: authError.message }, { status: 401 });
  }
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const case_id = body.case_id ?? null;

  const { data, error } = await supabase
    .from("chats")
    .insert({ user_id: user.id, case_id, title: "New Chat" })
    .select()
    .single();

  if (error) {
    const detail = dbError("chats.insert", error);
    return NextResponse.json({ error: "Database query failed", detail }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}
