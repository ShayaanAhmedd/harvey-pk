// GET  /api/memory        — list the authenticated user's imported memories
// POST /api/memory        — create a new memory entry

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("imported_memory")
    .select("id, title, content, case_id, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { title?: string; content?: string; case_id?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { title, content, case_id } = body;
  if (!content?.trim()) return NextResponse.json({ error: "content is required" }, { status: 400 });

  const { data, error } = await supabase
    .from("imported_memory")
    .insert({
      user_id: user.id,
      title:   (title?.trim() || "Imported Memory"),
      content: content.trim(),
      case_id: case_id ?? null,
    })
    .select("id, title, content, case_id, created_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
