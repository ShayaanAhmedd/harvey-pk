import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("user_platform_settings")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Return defaults if no row yet
  return NextResponse.json(data ?? {
    routing_strategy:     "auto",
    web_intelligence:     true,
    cross_validation:     false,
    draft_engine:         "manus",
    retrieval_strictness: "balanced",
  });
}

export async function PATCH(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const allowed = new Set([
    "routing_strategy",
    "web_intelligence",
    "cross_validation",
    "draft_engine",
    "retrieval_strictness",
  ]);
  const patch: Record<string, unknown> = { user_id: user.id };
  for (const [k, v] of Object.entries(body)) {
    if (allowed.has(k)) patch[k] = v;
  }

  const { error } = await supabase
    .from("user_platform_settings")
    .upsert(patch, { onConflict: "user_id" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
