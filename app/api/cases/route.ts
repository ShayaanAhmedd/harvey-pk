// GET  /api/cases — list cases the caller is permitted to see
// POST /api/cases — create a new case (admin + lawyer only)
//
// GET response: Case[] (array, never null — empty array when no rows)
// RLS enforces visibility:
//   admin  → all cases
//   lawyer → cases WHERE assigned_to = auth.uid()
//   staff  → cases WHERE assigned_to = auth.uid()
//
// Columns requested are the stable, guaranteed-present subset
// (id, case_number, title, status, created_at).  updated_at and
// client_id are intentionally omitted here to avoid 500s when
// the live schema diverges from migrations.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// ── GET /api/cases ────────────────────────────────────────────
export async function GET() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("cases")
    // Select only guaranteed-present columns — avoids 500 if
    // updated_at or client_id are missing from the deployed schema.
    .select("id, case_number, title, status, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[GET /api/cases] query error:", JSON.stringify({
      message: error.message,
      code:    error.code,
      details: error.details,
      hint:    error.hint,
      user_id: user.id,
    }));
    // Return 200 + empty array so the UI degrades gracefully
    // (case selector shows "no cases", upload stays functional for Global KB)
    return NextResponse.json([]);
  }

  return NextResponse.json(data ?? []);
}

// ── POST /api/cases ───────────────────────────────────────────
export async function POST(req: Request) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check role — only admin and lawyer may create cases
  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (roleRow?.role === "staff") {
    return NextResponse.json(
      { error: "Staff accounts cannot create cases." },
      { status: 403 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const { case_number, title, client_id, court, judge, status, filed_date, description } = body;

  if (!case_number?.trim() || !title?.trim()) {
    return NextResponse.json(
      { error: "case_number and title are required" },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("cases")
    .insert({
      case_number: case_number.trim(),
      title:       title.trim(),
      client_id:   client_id   ?? null,
      court:       court       ?? null,
      judge:       judge       ?? null,
      status:      status      ?? "active",
      filed_date:  filed_date  ?? null,
      description: description ?? null,
      created_by:  user.id,
    })
    .select("id, case_number, title, status")
    .single();

  if (error) {
    console.error("[POST /api/cases] insert error:", JSON.stringify({
      message: error.message,
      code:    error.code,
      details: error.details,
      hint:    error.hint,
      user_id: user.id,
    }));
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}
