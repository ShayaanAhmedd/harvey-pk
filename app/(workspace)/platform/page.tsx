import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import PlatformForm from "./PlatformForm";

export default async function PlatformPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: settings } = await supabase
    .from("user_platform_settings")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  const defaults = {
    routing_strategy:     settings?.routing_strategy     ?? "auto",
    web_intelligence:     settings?.web_intelligence     ?? true,
    cross_validation:     settings?.cross_validation     ?? false,
    draft_engine:         settings?.draft_engine         ?? "manus",
    retrieval_strictness: settings?.retrieval_strictness ?? "balanced",
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a]">

      {/* ── Top nav ── */}
      <div className="bg-[#111111] border-b border-neutral-800 px-8 py-3 flex items-center gap-3 text-sm text-neutral-500">
        <Link href="/" className="hover:text-neutral-200 transition-colors">Workspace</Link>
        <span>/</span>
        <span className="text-neutral-200 font-medium">Platform Settings</span>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-12 space-y-10">

        {/* ── Header ── */}
        <div>
          <h1 className="text-2xl font-semibold text-neutral-100 tracking-tight">Platform Settings</h1>
          <p className="mt-2 text-sm text-neutral-500 leading-relaxed max-w-xl">
            Control AI routing behaviour, retrieval parameters, and supplementary intelligence pipelines.
            Settings take effect on your next chat session.
          </p>
        </div>

        {/* ── 01 AI Routing ── */}
        <section>
          <SectionHeader index="01" title="AI Routing" />
          <PlatformForm defaults={defaults} />
        </section>

        {/* ── 02 Routing Architecture ── */}
        <section>
          <SectionHeader index="02" title="Routing Architecture" />
          <div className="bg-[#111111] rounded-xl border border-neutral-800 divide-y divide-neutral-800/60">
            <ArchRow
              label="Fast Mode"
              badge="GPT-4o Mini"
              description="Routes to OpenAI gpt-4o-mini with RAG context injection. Optimised for concise, low-latency legal Q&A. Suitable for statute lookups and brief procedural queries."
            />
            <ArchRow
              label="Deep Research"
              badge="Claude Sonnet"
              description="Routes to Anthropic Claude via the Messages API. Returns structured four-section analysis: ISSUE, RELEVANT LAW, LEGAL ANALYSIS, PRACTICAL IMPLICATIONS. Suitable for complex constitutional or multi-statute questions."
            />
            <ArchRow
              label="Web Intelligence"
              badge="Brave + GPT-4o"
              description="Queries Brave Search API filtered to Pakistani sources, then synthesises results through GPT-4o with RAG fallback. Suitable for live-sourced regulatory updates or recent case developments."
            />
            <ArchRow
              label="Cross-Check"
              badge="Gemini 1.5 Pro"
              description="Independently validates prior analysis through Google Gemini, then layers a Claude review pass. Flags divergences, outdated provisions, and missing citations. Suitable for final review before submissions."
            />
            <ArchRow
              label="Draft Mode"
              badge="Manus / Claude"
              description="Routes to Manus drafting API for court-ready document generation. Falls back to Claude on Manus unavailability. Produces structured pleadings, applications, and formal correspondence."
            />
          </div>
        </section>

        {/* ── 03 Retrieval Configuration ── */}
        <section>
          <SectionHeader index="03" title="Retrieval Configuration" />
          <div className="bg-[#111111] rounded-xl border border-neutral-800 divide-y divide-neutral-800/60">
            <InfoRow label="Embedding Model"    value="text-embedding-3-small" description="Used for both document indexing and query encoding at query time." />
            <InfoRow label="Similarity Metric"  value="Cosine Distance"        description="pgvector cosine similarity. Higher strictness raises the threshold, returning fewer but more precise chunks." />
            <InfoRow label="Chunk Retrieval"    value="Up to 10 per query"     description="Up to 5 from the global legal corpus and up to 5 from case-specific documents, merged and deduplicated by document ID and section." />
            <InfoRow label="Context Window"     value="4,000 tokens"           description="Retrieved chunks are concatenated up to this token budget before injection into the AI prompt." />
            <InfoRow label="Deduplication"      value="By document ID and (act, section)"  description="Duplicate chunks from the same document or same statutory section are removed before context injection." />
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

function ArchRow({
  label,
  badge,
  description,
}: {
  label: string;
  badge: string;
  description: string;
}) {
  return (
    <div className="px-6 py-4">
      <div className="flex items-center gap-3 mb-1.5">
        <p className="text-sm font-medium text-neutral-300">{label}</p>
        <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-neutral-800 text-neutral-500 uppercase tracking-wide">
          {badge}
        </span>
      </div>
      <p className="text-xs text-neutral-600 leading-relaxed max-w-lg">{description}</p>
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
