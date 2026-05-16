// GET /api/documents?caseId=<uuid>  — case documents for the given case
// GET /api/documents?scope=global   — global KB documents (all authed users)
//
// Returns one row per distinct file (chunk_index = 0), ordered newest first.
// Fields: id, case_id, file_name, file_type, scope, created_at

import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const caseId = searchParams.get("caseId");
  const scope = searchParams.get("scope") ?? "case";

  if (scope !== "global" && !caseId) {
    return NextResponse.json(
      { error: "caseId is required when scope is not global" },
      { status: 400 }
    );
  }

  let query = supabase
    .from("documents")
    .select("id, case_id, file_name, file_type, scope, created_at")
    .eq("chunk_index", 0) // one representative row per file
    .order("created_at", { ascending: false });

  if (scope === "global") {
    query = query.eq("scope", "global");
  } else {
    query = query.eq("scope", "case").eq("case_id", caseId!);
  }

  const { data, error } = await query;

  if (error) {
    console.error("[documents API] Supabase query error:", error.message, "| scope:", scope, "| caseId:", caseId);
    return NextResponse.json([]);
  }

  console.log("[documents API] returning", (data ?? []).length, "docs | scope:", scope);
  return NextResponse.json(data ?? []);
}
