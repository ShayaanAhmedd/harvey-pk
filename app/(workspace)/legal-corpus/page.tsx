import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import LegalCorpusClient from "./LegalCorpusClient";

export default async function LegalCorpusPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (roleRow?.role !== "admin") redirect("/");

  return <LegalCorpusClient />;
}
