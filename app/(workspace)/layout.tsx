// Workspace layout — authenticated shell for every route under /.
//
// Responsibilities:
//   1. Server-side auth guard — redirect to /login if no session.
//   2. Transparent wrapper — no visual chrome here.
//
// NOTE: This layout does NOT use h-screen or overflow-hidden.
// The workspace page (/) adds those constraints directly around
// WorkspaceShell.  Content pages (/clients, /cases, etc.) scroll
// freely and must not be clipped by the layout.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  return <>{children}</>;
}
