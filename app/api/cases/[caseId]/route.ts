// GET /api/cases/[caseId] — fetch a single case by ID

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type Params = { params: Promise<{ caseId: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { caseId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("cases")
    .select("id, case_number, title, status")
    .eq("id", caseId)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Case not found" }, { status: 404 });

  return NextResponse.json(data);
}
