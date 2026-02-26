// GET    /api/legal-corpus
//   Returns all ingested acts, grouped by act_name, with chunk count.
//   Available to all authenticated users (admins see it to manage,
//   lawyers/staff see it to know what's in the corpus).
//
// DELETE /api/legal-corpus?act=<act_name>
//   Deletes all document chunks for the named act (admin only).

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type ActEntry = {
  act_name: string;
  year: number | null;
  jurisdiction: string | null;
  storage_path: string | null;
  chunk_count: number;
  created_at: string;
};

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Fetch one representative row per (act_name) to get metadata,
  // plus count of all chunks per act.
  const { data, error } = await supabase
    .from("documents")
    .select("act_name, year, jurisdiction, storage_path, created_at")
    .eq("scope", "global")
    .not("act_name", "is", null)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Group by act_name in JS
  const actMap = new Map<string, ActEntry>();
  for (const row of data ?? []) {
    const key: string = row.act_name!;
    if (actMap.has(key)) {
      actMap.get(key)!.chunk_count += 1;
    } else {
      actMap.set(key, {
        act_name: key,
        year: row.year ?? null,
        jurisdiction: row.jurisdiction ?? null,
        storage_path: row.storage_path ?? null,
        chunk_count: 1,
        created_at: row.created_at,
      });
    }
  }

  return NextResponse.json(Array.from(actMap.values()));
}

export async function DELETE(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Admin only
  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (roleRow?.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const actName = searchParams.get("act");
  if (!actName) {
    return NextResponse.json({ error: "act query param is required" }, { status: 400 });
  }

  const { error } = await supabase
    .from("documents")
    .delete()
    .eq("scope", "global")
    .eq("act_name", actName);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return new NextResponse(null, { status: 204 });
}
