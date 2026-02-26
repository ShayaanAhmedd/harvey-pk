import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export default async function KnowledgeBasePage() {
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

  return (
    <div className="min-h-screen bg-gray-100 p-10">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 mb-6"
      >
        ← Back to workspace
      </Link>

      <div className="max-w-3xl">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Global Knowledge Base</h1>
        <p className="text-sm text-gray-500 mb-8">
          Documents uploaded here are available as context in every chat,
          regardless of which case is linked.
        </p>

        <div className="rounded-xl border border-dashed border-gray-300 bg-white px-6 py-10 text-center">
          <p className="text-3xl mb-3">📚</p>
          <p className="text-sm font-medium text-gray-700 mb-1">
            Upload from the chat workspace
          </p>
          <p className="text-xs text-gray-400 max-w-sm mx-auto">
            Open any chat, switch to the <strong>Global KB</strong> tab in the
            right panel, and use the upload button to add statutes, precedents,
            or template documents.
          </p>
        </div>
      </div>
    </div>
  );
}
