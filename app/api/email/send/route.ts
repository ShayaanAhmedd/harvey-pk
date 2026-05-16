// POST /api/email/send
//
// Sends an email using the authenticated user's saved SMTP settings.
// The AI CANNOT call this directly — it only drafts via [DRAFT_EMAIL] blocks.
// The user must confirm (and optionally edit) in EmailConfirmModal before this runs.
//
// Body: { to: string | string[], subject: string, body: string }
// `to` may be a comma-separated string or an array — both are normalised to an array.

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import nodemailer from "nodemailer";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Fetch SMTP settings — only the user can read their own row (RLS enforced)
  const { data: cfg, error: cfgErr } = await supabase
    .from("email_settings")
    .select("smtp_host, smtp_port, smtp_user, smtp_pass, from_email, from_name")
    .eq("user_id", user.id)
    .maybeSingle();

  if (cfgErr) return NextResponse.json({ error: cfgErr.message }, { status: 500 });
  if (!cfg)   return NextResponse.json({ error: "Email not configured. Connect your email in Profile → Email." }, { status: 422 });

  const body = await req.json().catch(() => null);
  const { to: rawTo, subject, body: text } = body ?? {};

  if (!rawTo || !subject || !text) {
    return NextResponse.json({ error: "to, subject and body are required" }, { status: 400 });
  }

  // Normalise `to` — accept string ("a@x.com, b@x.com") or array (["a@x.com","b@x.com"])
  const toList: string[] = (
    Array.isArray(rawTo)
      ? rawTo
      : String(rawTo).split(",")
  ).map((s: string) => s.trim()).filter(Boolean);

  if (toList.length === 0) {
    return NextResponse.json({ error: "At least one recipient is required" }, { status: 400 });
  }

  // Validate each address
  const invalid = toList.filter((addr) => !EMAIL_RE.test(addr));
  if (invalid.length > 0) {
    return NextResponse.json(
      { error: `Invalid email address${invalid.length > 1 ? "es" : ""}: ${invalid.join(", ")}` },
      { status: 400 }
    );
  }

  const transporter = nodemailer.createTransport({
    host:   cfg.smtp_host,
    port:   cfg.smtp_port,
    secure: cfg.smtp_port === 465,
    auth: {
      user: cfg.smtp_user,
      pass: cfg.smtp_pass,
    },
  });

  try {
    await transporter.sendMail({
      from:    cfg.from_name ? `"${cfg.from_name}" <${cfg.from_email}>` : cfg.from_email,
      to:      toList.join(", "),   // nodemailer accepts comma-separated list
      subject: String(subject).trim(),
      text:    String(text),
    });

    return NextResponse.json({ ok: true, sentTo: toList });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to send email";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
