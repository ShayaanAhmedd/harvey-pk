import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("user_preferences")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Return defaults if no row yet
  return NextResponse.json(data ?? {
    legal_role:     "lawyer",
    default_mode:   "fast",
    writing_style:  "formal",
    citation_style: "standard",
    output_density: "detailed",
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

  const allowed = new Set(["legal_role", "default_mode", "writing_style", "citation_style", "output_density"]);
  const patch: Record<string, unknown> = { user_id: user.id };
  for (const [k, v] of Object.entries(body)) {
    if (allowed.has(k)) patch[k] = v;
  }

  const { error } = await supabase
    .from("user_preferences")
    .upsert(patch, { onConflict: "user_id" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
