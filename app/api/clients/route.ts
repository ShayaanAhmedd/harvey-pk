// /api/clients — GET (list) and POST (create)
//
// Uses the session-aware server Supabase client so:
//   • RLS policies automatically filter rows by the caller's role
//   • Unauthenticated requests are rejected before hitting the DB

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// ── GET /api/clients ──────────────────────────────────────────
// Returns all clients the caller is allowed to see.
// RLS on the `clients` table handles filtering per role:
//   admin  → all clients
//   lawyer → all clients
//   staff  → all clients (read-only enforced at POST level + RLS)
export async function GET() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("clients")
    .select("id, full_name, cnic, phone, email, client_type, contact_name, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}

// ── POST /api/clients ─────────────────────────────────────────
// Creates a new client.
// Restricted to admin and lawyer — staff receive 403.
// RLS on the `clients` table is a second enforcement layer.
export async function POST(request: Request) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Fetch role for explicit application-level check
  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (roleRow?.role === "staff") {
    return NextResponse.json(
      { error: "Staff accounts cannot create clients." },
      { status: 403 }
    );
  }

  const body = await request.json();
  const { full_name, cnic, phone, email, address, client_type, contact_name, notes } =
    body;

  if (!full_name?.trim()) {
    return NextResponse.json(
      { error: "full_name is required" },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("clients")
    .insert({
      full_name: full_name.trim(),
      cnic: cnic?.trim() || null,
      phone: phone?.trim() || null,
      email: email?.trim() || null,
      address: address?.trim() || null,
      client_type: client_type || "individual",
      contact_name: contact_name?.trim() || null,
      notes: notes?.trim() || null,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}
