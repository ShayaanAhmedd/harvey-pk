// Workspace page — the main AI chat experience at /.
//
// h-screen + overflow-hidden lives here (not in the layout) so
// sibling pages like /clients can scroll freely.

import { createClient } from "@/lib/supabase/server";
import WorkspaceShell from "@/components/workspace/WorkspaceShell";

export default async function WorkspacePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // user is guaranteed non-null — layout redirected if null
  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user!.id)
    .maybeSingle();

  return (
    <div className="h-screen overflow-hidden bg-slate-100 dark:bg-slate-900 transition-colors duration-300">
      <WorkspaceShell
        userId={user!.id}
        userEmail={user!.email ?? ""}
        role={roleRow?.role ?? null}
      />
    </div>
  );
}
