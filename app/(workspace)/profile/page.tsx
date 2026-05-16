import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ProfileForm from "./ProfileForm";
import AppearancePanel from "./AppearancePanel";
import SoundPanel from "./SoundPanel";
import EmailPanel from "./EmailPanel";
import WhatsAppPanel from "./WhatsAppPanel";
import MemoryPanel from "./MemoryPanel";

export default async function ProfilePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  const { data: prefs } = await supabase
    .from("user_preferences")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  const role       = roleRow?.role ?? "lawyer";
  const email      = user.email ?? "";
  const memberSince = new Date(user.created_at).toLocaleDateString("en-PK", {
    year: "numeric", month: "long", day: "numeric",
  });

  const ROLE_LABELS: Record<string, string> = {
    admin:  "Administrator",
    lawyer: "Legal Counsel",
    staff:  "Support Staff",
  };
  const roleLabel = ROLE_LABELS[role] ?? "Legal Counsel";

  const defaults = {
    legal_role:     prefs?.legal_role     ?? "lawyer",
    default_mode:   prefs?.default_mode   ?? "fast",
    writing_style:  prefs?.writing_style  ?? "formal",
    citation_style: prefs?.citation_style ?? "standard",
    output_density: prefs?.output_density ?? "detailed",
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a]">

      {/* ── Top nav ── */}
      <div className="bg-[#111111] border-b border-neutral-800 px-8 py-3 flex items-center gap-3 text-sm text-neutral-500">
        <Link href="/" className="hover:text-neutral-200 transition-colors">Workspace</Link>
        <span>/</span>
        <span className="text-neutral-200 font-medium">Profile &amp; Preferences</span>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-12 space-y-10">

        {/* ── Header ── */}
        <div>
          <h1 className="text-2xl font-semibold text-neutral-100 tracking-tight">Profile &amp; Preferences</h1>
          <p className="mt-2 text-sm text-neutral-500 leading-relaxed max-w-xl">
            Configure your legal role, default AI mode, and output preferences.
            Changes are saved immediately to your account.
          </p>
        </div>

        {/* ── 01 Your Profile ── */}
        <section>
          <SectionHeader index="01" title="Your Profile" />
          <div className="bg-[#111111] rounded-xl border border-neutral-800 divide-y divide-neutral-800/60">

            <div className="px-6 py-5 flex items-center gap-4">
              <div className="w-12 h-12 rounded-full bg-neutral-800 text-neutral-300 flex items-center justify-center text-sm font-bold flex-shrink-0 select-none">
                {email.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <p className="text-sm font-medium text-neutral-100 capitalize">
                  {email.split("@")[0].replace(/[._-]/g, " ")}
                </p>
                <p className="text-xs text-neutral-500 mt-0.5">{email}</p>
                <span className="inline-flex items-center mt-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-neutral-800 text-neutral-400 uppercase tracking-wide">
                  {roleLabel}
                </span>
              </div>
            </div>

            <StaticRow label="Email Address"  value={email} />
            <StaticRow label="Access Role"    value={roleLabel} note="Role assigned at onboarding. Contact admin to change." />
            <StaticRow label="Member Since"   value={memberSince} />
            <StaticRow label="Account Status" value="Active" highlight />
          </div>
        </section>

        {/* ── 02 Preferences Form ── */}
        <section>
          <SectionHeader index="02" title="Legal Preferences" />
          <ProfileForm defaults={defaults} />
        </section>

        {/* ── 03 Appearance ── */}
        <section>
          <SectionHeader index="03" title="Appearance" />
          <AppearancePanel />
        </section>

        {/* ── 04 Sound ── */}
        <section>
          <SectionHeader index="04" title="Sound" />
          <SoundPanel />
        </section>

        {/* ── 05 Email Integration ── */}
        <section>
          <SectionHeader index="05" title="Email Integration" />
          <EmailPanel />
        </section>

        {/* ── 06 WhatsApp Integration ── */}
        <section>
          <SectionHeader index="06" title="WhatsApp Integration" />
          <WhatsAppPanel />
        </section>

        {/* ── 07 Imported Memory ── */}
        <section>
          <SectionHeader index="07" title="Imported Memory" />
          <MemoryPanel />
        </section>

        {/* ── 08 Output Behaviour ── */}
        <section>
          <SectionHeader index="08" title="Output Behaviour" />
          <div className="bg-[#111111] rounded-xl border border-neutral-800 divide-y divide-neutral-800/60">
            <InfoRow
              label="Response Language"
              value="English"
              description="All AI responses are produced in English. Urdu statutory text is quoted verbatim and translated inline where present in the corpus."
            />
            <InfoRow
              label="Statutory Jurisdiction"
              value="Pakistan (Federal)"
              description="Legal analysis defaults to federal Pakistani law. Provincial or international references are flagged when raised."
            />
            <InfoRow
              label="Hallucination Policy"
              value="Conservative"
              description="The system refuses to fabricate section numbers or case citations. Where authority is uncertain, it is flagged explicitly."
            />
            <InfoRow
              label="Source Attribution"
              value="Enabled"
              description="Responses include source references from the legal corpus and case documents where retrieved chunks were used in the answer."
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

function StaticRow({
  label,
  value,
  note,
  highlight,
}: {
  label: string;
  value: string;
  note?: string;
  highlight?: boolean;
}) {
  return (
    <div className="px-6 py-4 flex items-start justify-between gap-6">
      <div className="min-w-0">
        <p className="text-xs font-medium text-neutral-500 uppercase tracking-wide">{label}</p>
        {note && <p className="text-xs text-neutral-600 mt-0.5 leading-relaxed">{note}</p>}
      </div>
      <p className={`text-sm flex-shrink-0 ${highlight ? "text-emerald-400 font-medium" : "text-neutral-300"}`}>
        {value}
      </p>
    </div>
  );
}

function InfoRow({
  label,
  value,
  description,
}: {
  label: string;
  value: string;
  description: string;
}) {
  return (
    <div className="px-6 py-4 flex items-start justify-between gap-6">
      <div className="min-w-0">
        <p className="text-sm font-medium text-neutral-300">{label}</p>
        <p className="text-xs text-neutral-600 mt-1 leading-relaxed max-w-lg">{description}</p>
      </div>
      <span className="flex-shrink-0 inline-flex items-center px-2.5 py-1 rounded text-xs font-medium bg-neutral-800 text-neutral-400 whitespace-nowrap">
        {value}
      </span>
    </div>
  );
}
