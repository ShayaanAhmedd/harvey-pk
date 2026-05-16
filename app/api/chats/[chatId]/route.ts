// GET    /api/chats/[chatId] — fetch a chat and its messages
// PATCH  /api/chats/[chatId] — update title or case_id
// DELETE /api/chats/[chatId] — delete chat (cascades to messages)

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type Params = { params: Promise<{ chatId: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { chatId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Fetch chat (RLS ensures user owns it)
  const { data: chat, error: chatError } = await supabase
    .from("chats")
    .select("id, title, case_id, created_at")
    .eq("id", chatId)
    .maybeSingle();

  if (chatError) {
    return NextResponse.json({ error: chatError.message }, { status: 500 });
  }
  if (!chat) {
    return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  }

  // Fetch messages in chronological order
  const { data: messages, error: msgError } = await supabase
    .from("messages")
    .select("id, role, content, sources, created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true });

  if (msgError) {
    return NextResponse.json({ error: msgError.message }, { status: 500 });
  }

  return NextResponse.json({ chat, messages: messages ?? [] });
}

export async function PATCH(request: Request, { params }: Params) {
  const { chatId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const updates: Record<string, unknown> = {};

  if (typeof body.title === "string") updates.title = body.title.trim();
  if ("case_id" in body) updates.case_id = body.case_id;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("chats")
    .update(updates)
    .eq("id", chatId)
    .eq("user_id", user.id)   // double-check ownership (RLS is the primary guard)
    .select("id, title, case_id, created_at")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  }

  return NextResponse.json(data);
}

export async function DELETE(_req: Request, { params }: Params) {
  const { chatId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { error } = await supabase
    .from("chats")
    .delete()
    .eq("id", chatId)
    .eq("user_id", user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return new NextResponse(null, { status: 204 });
}
