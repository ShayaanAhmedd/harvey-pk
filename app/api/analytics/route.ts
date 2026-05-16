// GET /api/analytics
//
// Returns corpus-level statistics from the documents table.
// Available to all authenticated users.
//
// Response:
//   {
//     totalActs:            number  — distinct act_name values (scope='global')
//     totalSections:        number  — rows WHERE scope='global' AND act_name IS NOT NULL
//     totalEmbeddings:      number  — rows WHERE embedding IS NOT NULL
//     totalGlobalDocuments: number  — rows WHERE scope='global'
//   }

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Run count queries in parallel — all use head:true so no rows are returned
  const [sectionsRes, embeddingsRes, globalDocsRes, actNamesRes] = await Promise.all([
    // Rows that are structured legal sections (have act_name)
    supabase
      .from("documents")
      .select("*", { count: "exact", head: true })
      .eq("scope", "global")
      .not("act_name", "is", null),

    // All rows with a computed embedding
    supabase
      .from("documents")
      .select("*", { count: "exact", head: true })
      .not("embedding", "is", null),

    // All global-scope rows
    supabase
      .from("documents")
      .select("*", { count: "exact", head: true })
      .eq("scope", "global"),

    // Fetch distinct act_names to count unique acts
    // (Supabase JS doesn't support COUNT DISTINCT directly)
    supabase
      .from("documents")
      .select("act_name")
      .eq("scope", "global")
      .not("act_name", "is", null),
  ]);

  const totalActs = new Set(
    (actNamesRes.data ?? []).map((r) => r.act_name as string)
  ).size;

  return NextResponse.json({
    totalActs,
    totalSections: sectionsRes.count ?? 0,
    totalEmbeddings: embeddingsRes.count ?? 0,
    totalGlobalDocuments: globalDocsRes.count ?? 0,
  });
}
