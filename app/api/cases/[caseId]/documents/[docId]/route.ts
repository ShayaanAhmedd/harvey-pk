// GET   /api/cases/[caseId]/documents/[docId] — fetch full document content
// PATCH /api/cases/[caseId]/documents/[docId] — update title/content (saves version first)

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ caseId: string; docId: string }> }
) {
  const { caseId, docId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("case_documents")
    .select("id, case_id, title, content, created_at, updated_at")
    .eq("id", docId)
    .eq("case_id", caseId)
    .maybeSingle();

  if (error || !data) return NextResponse.json({ error: "Document not found" }, { status: 404 });
  return NextResponse.json(data);
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ caseId: string; docId: string }> }
) {
  const { caseId, docId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: roleRow } = await supabase
    .from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
  if (roleRow?.role === "staff") {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const { title, content } = body;

  // Snapshot the current content before overwriting
  const { data: existing } = await supabase
    .from("case_documents")
    .select("content")
    .eq("id", docId)
    .maybeSingle();

  if (existing?.content) {
    await supabase.from("case_document_versions").insert({
      document_id: docId,
      content: existing.content,
      saved_by: user.id,
    });
  }

  const update: Record<string, unknown> = {};
  if (title !== undefined) update.title = title;
  if (content !== undefined) update.content = content;

  const { data, error } = await supabase
    .from("case_documents")
    .update(update)
    .eq("id", docId)
    .eq("case_id", caseId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
