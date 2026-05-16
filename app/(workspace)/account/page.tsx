import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function AccountPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  const role        = roleRow?.role ?? "lawyer";
  const email       = user.email ?? "";
  const createdAt   = new Date(user.created_at).toLocaleDateString("en-PK", {
    year: "numeric", month: "long", day: "numeric",
  });
  const lastSignIn  = user.last_sign_in_at
    ? new Date(user.last_sign_in_at).toLocaleString("en-PK", {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
      })
    : "—";

  // Document counts
  const { count: docCount } = await supabase
    .from("documents")
    .select("*", { count: "exact", head: true })
    .eq("uploaded_by", user.id);

  const { count: chatCount } = await supabase
    .from("chats")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id);

  const { count: globalChunkCount } = await supabase
    .from("documents")
    .select("*", { count: "exact", head: true })
    .eq("scope", "global");

  const ROLE_LABELS: Record<string, string> = {
    admin:  "Administrator",
    lawyer: "Legal Counsel",
    staff:  "Support Staff",
  };
  const roleLabel = ROLE_LABELS[role] ?? "Legal Counsel";

  return (
    <div className="min-h-screen bg-[#0a0a0a]">

      {/* ── Top nav ── */}
      <div className="bg-[#111111] border-b border-neutral-800 px-8 py-3 flex items-center gap-3 text-sm text-neutral-500">
        <Link href="/" className="hover:text-neutral-200 transition-colors">Workspace</Link>
        <span>/</span>
        <span className="text-neutral-200 font-medium">Account</span>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-12 space-y-10">

        {/* ── Header ── */}
        <div>
          <h1 className="text-2xl font-semibold text-neutral-100 tracking-tight">Account</h1>
          <p className="mt-2 text-sm text-neutral-500 leading-relaxed max-w-xl">
            Security information, session history, and usage metrics for your account.
          </p>
        </div>

        {/* ── 01 Security & Access ── */}
        <section>
          <SectionHeader index="01" title="Security & Access" />
          <div className="bg-[#111111] rounded-xl border border-neutral-800 divide-y divide-neutral-800/60">

            <div className="px-6 py-5 flex items-center gap-4">
              <div className="w-12 h-12 rounded-full bg-neutral-800 text-neutral-300 flex items-center justify-center text-sm font-bold flex-shrink-0 select-none">
                {email.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <p className="text-sm font-medium text-neutral-100">{email}</p>
                <span className="inline-flex items-center mt-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-neutral-800 text-neutral-400 uppercase tracking-wide">
                  {roleLabel}
                </span>
              </div>
            </div>

            <DataRow label="Account ID"      value={user.id} mono />
            <DataRow label="Email Address"   value={email} />
            <DataRow label="Access Role"     value={roleLabel} />
            <DataRow label="Account Created" value={createdAt} />
            <DataRow label="Last Sign-In"    value={lastSignIn} />
            <DataRow label="Auth Provider"   value="Email / Password" />
            <DataRow label="Account Status"  value="Active" highlight />
          </div>
        </section>

        {/* ── 02 Session Information ── */}
        <section>
          <SectionHeader index="02" title="Session Information" />
          <div className="bg-[#111111] rounded-xl border border-neutral-800 divide-y divide-neutral-800/60">
            <DataRow label="Current Session" value="Active — this device" highlight />
            <DataRow label="Session Scope"   value="Full platform access" />
            <DataRow
              label="Session Persistence"
              value="Sessions are preserved across sign-ins. Your last active workspace state is restored on return."
              description
            />
            <DataRow
              label="Revoke Access"
              value="To revoke all active sessions, sign out and contact your administrator to invalidate your credentials."
              description
            />
          </div>
        </section>

        {/* ── 03 AI Usage ── */}
        <section>
          <SectionHeader index="03" title="AI Usage" />
          <div className="bg-[#111111] rounded-xl border border-neutral-800 divide-y divide-neutral-800/60">
            <DataRow label="Chat Sessions Created" value={String(chatCount ?? 0)} />
            <DataRow label="Documents Indexed (Your Uploads)" value={String(docCount ?? 0)} />
            <DataRow label="Global Corpus Chunks" value={String(globalChunkCount ?? 0)} />
            <DataRow
              label="Retrieval Model"
              value="text-embedding-3-small (OpenAI)"
            />
            <DataRow
              label="Context Window"
              value="Up to 10 relevant chunks retrieved per query across case and global scopes."
              description
            />
            <DataRow
              label="Usage Metering"
              value="Token usage is aggregated at the organisation level. Per-session breakdown is not exposed at this tier."
              description
            />
          </div>
        </section>

        {/* ── 04 Data & Storage ── */}
        <section>
          <SectionHeader index="04" title="Data & Storage" />
          <div className="bg-[#111111] rounded-xl border border-neutral-800 divide-y divide-neutral-800/60">
            <DataRow label="Storage Provider"   value="Supabase Storage (eu-west-1)" />
            <DataRow label="Embedding Store"    value="pgvector — PostgreSQL 15" />
            <DataRow
              label="Case Documents"
              value="Uploaded case files are chunked, embedded, and stored per-case. They are only accessible within the originating case context."
              description
            />
            <DataRow
              label="Global Legal Corpus"
              value="Acts and legislation uploaded by administrators are indexed globally and made available across all case contexts."
              description
            />
            <DataRow
              label="Data Retention"
              value="All case data, chat history, and uploaded documents are retained for the duration of the active subscription. Data is purged within 30 days of subscription termination."
              description
            />
            <DataRow
              label="Data Deletion"
              value="To request deletion of personal data or session history, contact your account administrator."
              description
            />
          </div>
        </section>

      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SectionHeader({ index, title }: { index: string; title: string }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <span className="text-[10px] font-bold text-neutral-600 tracking-widest uppercase">{index}</span>
      <div className="flex-1 h-px bg-neutral-800" />
      <h2 className="text-xs font-semibold text-neutral-400 uppercase tracking-widest">{title}</h2>
    </div>
  );
}

function DataRow({
  label,
  value,
  mono,
  highlight,
  description,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
  description?: boolean;
}) {
  return (
    <div className="px-6 py-4 flex items-start justify-between gap-6">
      <p className="text-xs font-medium text-neutral-500 flex-shrink-0 w-48">{label}</p>
      <p className={`text-sm text-right leading-relaxed ${
        mono        ? "font-mono text-[11px] text-neutral-500 break-all" :
        highlight   ? "text-emerald-400 font-medium" :
        description ? "text-xs text-neutral-500 text-left" :
                      "text-neutral-300"
      }`}>
        {value}
      </p>
    </div>
  );
}
