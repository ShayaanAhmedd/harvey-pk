import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ClientWorkspace from "./ClientWorkspace";

export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: roleRow } = await supabase
    .from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
  const role = roleRow?.role ?? null;

  const { data: client } = await supabase
    .from("clients")
    .select("id, full_name, cnic, phone, email, address, client_type, contact_name, notes, created_at")
    .eq("id", id)
    .maybeSingle();

  if (!client) redirect("/clients");

  const { data: cases } = await supabase
    .from("cases")
    .select("id, case_number, title, status, court, judge, filed_date, created_at")
    .eq("client_id", id)
    .order("created_at", { ascending: false });

  const caseIds = (cases ?? []).map((c) => c.id);
  let chats: { id: string; title: string; case_id: string; created_at: string }[] = [];
  if (caseIds.length > 0) {
    const { data: chatData } = await supabase
      .from("chats")
      .select("id, title, case_id, created_at")
      .in("case_id", caseIds)
      .order("created_at", { ascending: false });
    chats = chatData ?? [];
  }

  return (
    <ClientWorkspace
      client={client}
      cases={cases ?? []}
      chats={chats}
      role={role}
    />
  );
}
