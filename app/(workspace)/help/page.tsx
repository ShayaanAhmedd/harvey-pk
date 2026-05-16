import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ReportErrorForm from "./ReportErrorForm";
import HelpContactForm from "./HelpContactForm";

export default async function HelpPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="min-h-screen bg-[#0a0a0a]">

      {/* ── Top nav ── */}
      <div className="bg-[#111111] border-b border-neutral-800 px-8 py-3 flex items-center gap-3 text-sm text-neutral-500">
        <Link href="/" className="hover:text-neutral-200 transition-colors">Workspace</Link>
        <span>/</span>
        <span className="text-neutral-200 font-medium">Help &amp; Support</span>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-12 space-y-10">

        {/* ── Header ── */}
        <div>
          <h1 className="text-2xl font-semibold text-neutral-100 tracking-tight">Help &amp; Support</h1>
          <p className="mt-2 text-sm text-neutral-500 leading-relaxed max-w-xl">
            Platform architecture, usage guidance, legal policies, and support contact.
          </p>
        </div>

        {/* ── 01 Platform Architecture ── */}
        <section>
          <SectionHeader index="01" title="Platform Architecture" />
          <div className="space-y-3">
            {[
              {
                title: "Fast Mode",
                badge: "GPT-4o Mini",
                body: "Queries are embedded using text-embedding-3-small and compared against both the global legal corpus and case-specific documents via cosine similarity in pgvector. Up to 10 retrieved chunks are injected into the GPT-4o Mini context window. Designed for rapid statute lookups, procedural queries, and brief factual responses. Response is streamed token-by-token.",
              },
              {
                title: "Deep Research Mode",
                badge: "Claude Sonnet",
                body: "Routes to Anthropic Claude via the Messages API. The same RAG retrieval pipeline runs first; retrieved context is prepended to the prompt. Claude returns a structured four-section analysis: ISSUE, RELEVANT LAW, LEGAL ANALYSIS, and PRACTICAL IMPLICATIONS. Conservative hallucination policy — Claude refuses to fabricate section numbers or case citations. Response is returned as a single payload.",
              },
              {
                title: "Web Intelligence Mode",
                badge: "Brave Search + GPT-4o",
                body: "Issues a live search query to the Brave Search API filtered to Pakistani sources (country=PK, count=5). The top 5 results are formatted with title, URL, and description, then passed alongside RAG context to GPT-4o for synthesis. Falls back to RAG-only Fast Mode if the Brave API is unavailable. Response is streamed.",
              },
              {
                title: "Cross-Check Mode",
                badge: "Gemini 1.5 Pro + Claude",
                body: "Executes two independent analysis passes. First, the query and RAG context are sent to Google Gemini 1.5 Pro via the REST API with a structured legal system prompt. The Gemini response is then passed to Claude as a review layer with instructions to identify inaccuracies, outdated provisions, and missing citations. The final Claude output is returned. Falls back to Claude-only if Gemini is unavailable.",
              },
              {
                title: "Draft Mode",
                badge: "Manus / Claude",
                body: "Routes to the Manus drafting API (api.manus.im) with a Pakistani legal drafting system prompt. Manus is specialised for court-ready documents: heading, parties, facts, legal grounds, prayer/relief. Accepts OpenAI-compatible response format. Falls back to Claude deep mode automatically on Manus failure. Temperature is set to 0.3 to minimise hallucination in formal documents.",
              },
              {
                title: "Legal RAG Pipeline",
                badge: "pgvector",
                body: "All uploaded documents — case files and global legislation — are chunked, embedded, and stored in a PostgreSQL pgvector table. Queries are embedded at runtime and matched via two parallel RPC calls: match_documents_by_case (case scope) and match_global_documents (global scope). Results are merged, deduplicated by document ID and (act_name, section_number), and ranked by similarity. Up to 5 chunks from each scope are retained.",
              },
              {
                title: "Voice Transcription",
                badge: "Whisper",
                body: "Voice input is recorded in the browser using the MediaRecorder API and sent as a WAV blob to /api/transcribe. The server forwards the audio to OpenAI Whisper (whisper-1) via the Audio Transcriptions API. The transcription is returned as plain text and populated into the chat input. Voice recording is client-side only; no audio is stored on the platform.",
              },
            ].map((item) => (
              <ArchCard key={item.title} title={item.title} badge={item.badge} body={item.body} />
            ))}
          </div>
        </section>

        {/* ── 02 Using the Platform ── */}
        <section>
          <SectionHeader index="02" title="Using the Platform" />
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              {
                title: "Starting a Chat Session",
                body: "Select New Chat from the left sidebar. Each session is scoped to a single conversation thread. Messages within the session are retained as context for subsequent queries. Sessions persist across sign-ins.",
              },
              {
                title: "Linking Cases",
                body: "Navigate to Clients to view or create client profiles. Each client can have one or more cases. From the case detail view, documents can be uploaded and AI sessions can reference case-specific context alongside the global corpus.",
              },
              {
                title: "Uploading Documents",
                body: "Documents are uploaded from the case detail page or the Knowledge Base panel. Supported formats: PDF, TXT. Files are parsed, chunked, embedded, and stored. Case documents are scoped to their originating case; global uploads are accessible across all contexts.",
              },
              {
                title: "Generating Legal Documents",
                body: "From a case page, use Draft Mode to generate structured legal documents. Provide the document type and key facts in the chat input. The system produces a formatted draft which can be reviewed and exported.",
              },
              {
                title: "Exporting to PDF",
                body: "Case documents can be exported as court-formatted PDFs from the document editor. The export includes a case header, section formatting, and a platform attribution footer on every page.",
              },
              {
                title: "Switching AI Modes",
                body: "The mode selector in the chat toolbar controls which AI pipeline handles your query. Fast Mode is the default. Mode selection persists within a session but does not carry across new sessions unless a default is configured in Profile & Preferences.",
              },
            ].map((item) => (
              <DocCard key={item.title} title={item.title} body={item.body} />
            ))}
          </div>
        </section>

        {/* ── 03 Terms of Use ── */}
        <section>
          <SectionHeader index="03" title="Terms of Use" />
          <div className="bg-[#111111] rounded-xl border border-neutral-800 px-6 py-6 space-y-4 text-sm text-neutral-500 leading-relaxed">
            <p>
              By accessing this platform, you agree to use it solely for professional legal research,
              case management, and document drafting within the scope of your organisation&apos;s subscription.
              Unauthorised access, reproduction, or redistribution of platform outputs is prohibited.
            </p>
            <p>
              All outputs — including statutory extracts, document drafts, and analytical responses —
              are intended to assist qualified legal practitioners and do not constitute formal legal advice.
              The subscribing organisation bears sole responsibility for the accuracy and application of
              any materials produced.
            </p>
            <p>
              These terms are subject to amendment. Continued use following notification of changes
              constitutes acceptance. For the current version, contact your account administrator.
            </p>
            <p className="text-xs text-neutral-700">Last updated: February 2026</p>
          </div>
        </section>

        {/* ── 04 Privacy Policy ── */}
        <section>
          <SectionHeader index="04" title="Privacy Policy" />
          <div className="bg-[#111111] rounded-xl border border-neutral-800 px-6 py-6 space-y-4 text-sm text-neutral-500 leading-relaxed">
            <p>
              Data entered into this platform — including client details, case notes, uploaded documents,
              and chat sessions — is stored in a Supabase-managed PostgreSQL instance and is not shared
              with third parties except as required by applicable law.
            </p>
            <p>
              Queries submitted through the chat interface are processed by third-party language model
              providers (OpenAI, Anthropic, Google) under data processing agreements. No personally
              identifiable information is used to train external models. Voice recordings are not stored;
              only the transcription result is retained.
            </p>
            <p>
              Users may request deletion of their data at any time by contacting their account administrator.
              On subscription termination, all associated data is purged within 30 days in accordance with
              the data retention schedule agreed at onboarding.
            </p>
            <p className="text-xs text-neutral-700">Last updated: February 2026</p>
          </div>
        </section>

        {/* ── 05 Contact Support ── */}
        <section>
          <SectionHeader index="05" title="Contact Support" />
          <div className="bg-[#111111] rounded-xl border border-neutral-800 overflow-hidden">
            <div className="px-6 py-5 border-b border-neutral-800/60">
              <p className="text-sm text-neutral-500 leading-relaxed">
                For technical issues, access requests, or platform queries, contact the support team.
                Standard response time is within one business day. Critical issues affecting active
                matters are addressed within four hours.
              </p>
              <a
                href="mailto:support@harvey.pk"
                className="inline-flex items-center gap-2 mt-3 text-sm font-medium text-neutral-300 hover:text-neutral-100 transition-colors"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                  <polyline points="22,6 12,13 2,6" />
                </svg>
                support@harvey.pk
              </a>
            </div>
            <HelpContactForm />
          </div>
        </section>

        {/* ── 06 Report AI Error ── */}
        <section>
          <SectionHeader index="06" title="Report AI Error" />
          <div className="bg-[#111111] rounded-xl border border-neutral-800 overflow-hidden">
            <div className="px-6 py-5 border-b border-neutral-800/60">
              <p className="text-sm text-neutral-500 leading-relaxed">
                If an AI response contains a fabricated statute, incorrect section number, or materially
                misleading analysis, report it here. Include the Chat ID from the relevant session to
                allow the support team to retrieve the full context.
              </p>
              <p className="text-xs text-neutral-600 mt-2">
                Chat IDs are visible in the browser URL: <code className="text-neutral-500">/chat?id=&#x5B;chat-id&#x5D;</code>
              </p>
            </div>
            <ReportErrorForm />
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

function ArchCard({ title, badge, body }: { title: string; badge: string; body: string }) {
  return (
    <div className="bg-[#111111] rounded-xl border border-neutral-800 px-5 py-5">
      <div className="flex items-center gap-2.5 mb-2">
        <h3 className="text-sm font-semibold text-neutral-200">{title}</h3>
        <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-neutral-800 text-neutral-500 uppercase tracking-wide">
          {badge}
        </span>
      </div>
      <p className="text-xs text-neutral-500 leading-relaxed">{body}</p>
    </div>
  );
}

function DocCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="bg-[#111111] rounded-xl border border-neutral-800 px-5 py-5">
      <h3 className="text-sm font-semibold text-neutral-200 mb-2">{title}</h3>
      <p className="text-xs text-neutral-500 leading-relaxed">{body}</p>
    </div>
  );
}

