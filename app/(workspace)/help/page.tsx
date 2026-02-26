import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function HelpPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="min-h-screen bg-gray-50">

      {/* ── Top nav ──────────────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-gray-200 px-8 py-3 flex items-center gap-3 text-sm text-gray-500">
        <Link href="/" className="hover:text-gray-800 transition-colors">Workspace</Link>
        <span>/</span>
        <span className="text-gray-900 font-medium">Help &amp; Support</span>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-12 space-y-10">

        {/* ── Header ───────────────────────────────────────────────────────────── */}
        <div>
          <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Help &amp; Support</h1>
          <p className="mt-3 text-base text-gray-500 leading-relaxed max-w-xl">
            This page contains platform guidance, legal policies, and support
            contact information. If you require assistance that is not addressed
            here, please reach out via the contact form below.
          </p>
        </div>

        {/* ── 1. Documentation ──────────────────────────────────────────────────── */}
        <section>
          <SectionHeader index="01" title="Documentation" />
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              {
                title: "Using the Chat Interface",
                body: "Open a new chat from the left panel to begin a session. Each conversation is scoped to a case or opened as a general inquiry. The assistant processes your query and returns a structured response. Prior messages within the session are retained for context.",
              },
              {
                title: "Linking Clients and Cases",
                body: "Navigate to the Clients section to view or create client profiles. Each client can have one or more cases attached. From the client detail page, create a new case using the New Case button. Cases are automatically linked to the originating client and can be reassigned at any time.",
              },
              {
                title: "Generating Legal Documents",
                body: "From a client's case page, select Generate Document. The system will draft a structured legal document based on case details, client information, and prior session notes. The document is presented in an editable format and saved automatically.",
              },
              {
                title: "Exporting to PDF",
                body: "Any case document can be exported as a court-ready PDF. Open the document editor and select Export PDF from the toolbar. The download includes a case header, structured section formatting, and a platform footer on every page.",
              },
            ].map((item) => (
              <DocCard key={item.title} title={item.title} body={item.body} />
            ))}
          </div>
        </section>

        {/* ── 2. Terms of Service ───────────────────────────────────────────────── */}
        <section>
          <SectionHeader index="02" title="Terms of Service" />
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-6 py-6 space-y-4 text-sm text-gray-700 leading-relaxed">
            <p>
              By accessing and using this platform, you agree to be bound by
              these Terms of Service. This platform is intended for use by
              authorised legal professionals within the subscribing organisation.
              Unauthorised access, reproduction, or distribution of any materials
              generated through this platform is strictly prohibited.
            </p>
            <p>
              All documents, analyses, and outputs produced through this platform
              are intended to assist qualified legal practitioners and do not
              constitute formal legal advice. The subscribing organisation is
              solely responsible for the accuracy and use of any materials
              produced.
            </p>
            <p>
              These terms are subject to change. Continued use of the platform
              following notification of any amendments constitutes acceptance of
              the revised terms. For the most current version of these terms,
              contact your account administrator.
            </p>
            <p className="text-xs text-gray-400">Last updated: February 2026</p>
          </div>
        </section>

        {/* ── 3. Privacy Policy ─────────────────────────────────────────────────── */}
        <section>
          <SectionHeader index="03" title="Privacy Policy" />
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-6 py-6 space-y-4 text-sm text-gray-700 leading-relaxed">
            <p>
              This platform processes data provided by users solely for the
              purpose of delivering legal case management and document drafting
              services. Data entered into the system — including client details,
              case notes, and chat sessions — is stored securely and is not shared
              with third parties except as required by applicable law.
            </p>
            <p>
              Queries submitted through the chat interface are processed by a
              third-party language model provider under a data processing
              agreement. No personally identifiable information is used to train
              external models. Session data may be retained for the duration of
              the subscription to maintain continuity of service.
            </p>
            <p>
              Users have the right to request deletion of their data at any time
              by contacting their account administrator. Upon subscription
              termination, all associated data is purged in accordance with the
              data retention schedule agreed at onboarding.
            </p>
            <p className="text-xs text-gray-400">Last updated: February 2026</p>
          </div>
        </section>

        {/* ── 4. Contact Support ────────────────────────────────────────────────── */}
        <section>
          <SectionHeader index="04" title="Contact Support" />
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-6 py-5 border-b border-gray-100">
              <p className="text-sm text-gray-600 leading-relaxed">
                For technical issues, billing enquiries, or access requests,
                contact the support team directly. Response times are within one
                business day for standard enquiries and within four hours for
                critical issues affecting active matters.
              </p>
              <a
                href="mailto:support@harvey.pk"
                className="inline-flex items-center gap-2 mt-3 text-sm font-medium text-indigo-600 hover:text-indigo-800 transition-colors"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                  <polyline points="22,6 12,13 2,6" />
                </svg>
                support@harvey.pk
              </a>
            </div>

            <ContactForm />
          </div>
        </section>

      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({ index, title }: { index: string; title: string }) {
  return (
    <div className="flex items-center gap-3 mb-5">
      <span className="text-[10px] font-bold text-gray-400 tracking-widest uppercase">{index}</span>
      <div className="flex-1 h-px bg-gray-200" />
      <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-widest">{title}</h2>
    </div>
  );
}

function DocCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-5 py-5">
      <h3 className="text-sm font-semibold text-gray-900 mb-2">{title}</h3>
      <p className="text-sm text-gray-500 leading-relaxed">{body}</p>
    </div>
  );
}

function ContactForm() {
  return (
    <form
      onSubmit={(e) => e.preventDefault()}
      className="px-6 py-5 space-y-4"
    >
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Full Name</label>
          <input
            type="text"
            placeholder="Your name"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black/10 focus:border-black transition-colors"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Email Address</label>
          <input
            type="email"
            placeholder="you@firm.com"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black/10 focus:border-black transition-colors"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Subject</label>
        <select className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-black/10 focus:border-black transition-colors bg-white">
          <option value="">Select a category</option>
          <option value="technical">Technical Issue</option>
          <option value="access">Access &amp; Permissions</option>
          <option value="billing">Billing &amp; Subscription</option>
          <option value="feature">Feature Request</option>
          <option value="other">Other</option>
        </select>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Message</label>
        <textarea
          rows={4}
          placeholder="Describe your issue or enquiry in detail…"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black/10 focus:border-black transition-colors resize-none"
        />
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          className="rounded-lg bg-black px-5 py-2 text-sm font-semibold text-white hover:bg-gray-800 transition-colors"
        >
          Submit Request
        </button>
      </div>
    </form>
  );
}
