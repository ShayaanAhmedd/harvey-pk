import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import DocumentEditor from "./DocumentEditor";

export default async function DocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ caseId: string; docId: string }>;
  searchParams: Promise<{ generate?: string }>;
}) {
  const { caseId, docId } = await params;
  const { generate } = await searchParams;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: roleRow } = await supabase
    .from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
  const role = roleRow?.role ?? null;

  const { data: doc } = await supabase
    .from("case_documents")
    .select("id, case_id, title, content, created_at, updated_at")
    .eq("id", docId)
    .eq("case_id", caseId)
    .maybeSingle();

  if (!doc) redirect("/clients");

  const { data: caseData } = await supabase
    .from("cases")
    .select("id, case_number, title, client_id")
    .eq("id", caseId)
    .maybeSingle();

  return (
    <DocumentEditor
      doc={doc}
      caseData={caseData}
      role={role}
      autoGenerate={generate === "1"}
    />
  );
}
