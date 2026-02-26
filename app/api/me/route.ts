// GET /api/me
//
// Returns the authenticated user's role from the user_roles table.
// Uses the session-aware server Supabase client (reads auth cookies),
// so auth.uid() resolves correctly and RLS policies are satisfied.
//
// This endpoint exists specifically so client components (e.g. AuthContext)
// can fetch the role without making a direct Supabase REST call from the
// browser — a pattern that bypasses cookie-based auth and causes 500s.
//
// Response shapes:
//   200  { role: "admin" | "lawyer" | "staff" }
//   200  { role: null }   — authenticated but no role row yet
//   401  { error: "Unauthorized" }

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError) {
    console.error("[GET /api/me] auth error:", JSON.stringify({
      message: authError.message,
      status: authError.status,
    }));
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error("[GET /api/me] user_roles query error:", JSON.stringify({
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
      user_id: user.id,
    }));
    // Return null role rather than 500 — caller degrades gracefully
    return NextResponse.json({ role: null });
  }

  return NextResponse.json({ role: data?.role ?? null });
}
