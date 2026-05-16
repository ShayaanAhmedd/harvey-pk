// GET  /api/email/settings — return user's SMTP config (password masked)
// PUT  /api/email/settings — upsert SMTP config
// DELETE /api/email/settings — remove config (disconnect)

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("email_settings")
    .select("smtp_host, smtp_port, smtp_user, from_email, from_name")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data)  return NextResponse.json({ connected: false });

  return NextResponse.json({ connected: true, ...data });
}

export async function PUT(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { smtp_host, smtp_port, smtp_user, smtp_pass, from_email, from_name } = body ?? {};

  if (!smtp_host || !smtp_user || !from_email) {
    return NextResponse.json({ error: "smtp_host, smtp_user and from_email are required" }, { status: 400 });
  }

  // Check if a row already exists for this user
  const { data: existing } = await supabase
    .from("email_settings")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  let dbError;

  if (existing) {
    // UPDATE — password is optional (omit to keep existing)
    const patch: Record<string, unknown> = {
      smtp_host:  smtp_host.trim(),
      smtp_port:  Number(smtp_port) || 587,
      smtp_user:  smtp_user.trim(),
      from_email: from_email.trim(),
      from_name:  from_name?.trim() ?? null,
    };
    if (smtp_pass) patch.smtp_pass = smtp_pass;

    const { error } = await supabase
      .from("email_settings")
      .update(patch)
      .eq("user_id", user.id);
    dbError = error;
  } else {
    // INSERT — password required for new rows
    if (!smtp_pass) {
      return NextResponse.json({ error: "smtp_pass is required when connecting for the first time" }, { status: 400 });
    }
    const { error } = await supabase.from("email_settings").insert({
      user_id:    user.id,
      smtp_host:  smtp_host.trim(),
      smtp_port:  Number(smtp_port) || 587,
      smtp_user:  smtp_user.trim(),
      smtp_pass,
      from_email: from_email.trim(),
      from_name:  from_name?.trim() ?? null,
    });
    dbError = error;
  }

  if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { error } = await supabase
    .from("email_settings")
    .delete()
    .eq("user_id", user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
