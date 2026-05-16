"use client";

// app/(workspace)/legal-intelligence/[chatId]/page.tsx
//
// Legal Intelligence Dashboard — displays IRAC pipeline analysis for a chat.
// Fetches from GET /api/legal-intelligence/:chatId.
//
// Sections:
//   1. Case Overview      — brief summary, probability, risk
//   2. Strategy           — strategy_simulation strategies
//   3. Precedent          — doctrine_influence, doctrine_analysis
//   4. Similar Cases      — precedent_intelligence.similar_cases
//   5. Forum Intelligence — forum_intelligence fields
//   6. Benchmark          — benchmark_assessment
//   7. Knowledge Graph    — knowledge_graph_insight

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

// ── API response types ────────────────────────────────────────────────────────

interface Meta {
  confidence_score: number;
  risk_level:       "low" | "moderate" | "high";
  issue_summary:    string;
}

interface LitigationBrief {
  executive_summary:       string;
  key_issues:              string[];
  governing_law:           string[];
  leading_precedents:      string[];
  risk_assessment: {
    success_probability: number;
    risk_level:          string;
  };
  strategy_recommendation: string;
  similar_cases: { case_title: string; similarity: number }[];
}

interface LitigationAssessment {
  success_probability: number;
  risk_band:           string;
  drivers:             string[];
}

interface DoctrineAnalysis {
  doctrine_stability:         "stable" | "weakening" | "unstable";
  overruling_risk_score:       number;
  negative_treatment_count:    number;
  supporting_precedent_count:  number;
  doctrine_trend:              "strengthening" | "neutral" | "weakening";
}

interface DoctrineInfluence {
  leading_precedents: {
    case_title:      string;
    authority_tier:  string;
    influence_score: number;
  }[];
  doctrine_cluster_size:     number;
  precedent_network_density: number;
}

interface PrecedentIntelligence {
  precedent_strength_score: number;
  incoming_citations:       number;
  doctrine_instability:     boolean;
  similar_cases: {
    case_title:     string | null;
    authority_tier: string | null;
    decision_year:  number | null;
    similarity:     number;
  }[];
}

interface Strategy {
  strategy_type:                string;
  description:                  string;
  adjusted_success_probability: number;
  adjusted_risk_level:          "low" | "moderate" | "high";
  reasoning_factors:            string[];
}

interface ForumIntelligence {
  court_name?:             string;
  forum_success_rate?:     number;
  judge_name?:             string;
  judge_success_rate?:     number;
  judge_strictness_index?: number;
  forum_trend?:            number;
}

interface BenchmarkAssessment {
  comparable_case_count:     number;
  historical_success_rate:   number;
  authority_alignment_score: number;
  trend_direction?:          "favorable" | "neutral" | "unfavorable";
}

interface KnowledgeGraphInsight {
  related_cases:         number;
  citing_cases:          number;
  overruling_cases:      number;
  doctrine_cluster_size: number;
}

interface IntelligenceData {
  has_intelligence:        true;
  message_id:              string;
  created_at:              string;
  meta:                    Meta;
  litigation_brief?:       LitigationBrief;
  litigation_assessment?:  LitigationAssessment;
  doctrine_analysis?:      DoctrineAnalysis;
  doctrine_influence?:     DoctrineInfluence;
  precedent_intelligence?: PrecedentIntelligence;
  forum_intelligence?:     ForumIntelligence;
  benchmark_assessment?:   BenchmarkAssessment;
  strategy_simulation?:    { strategies: Strategy[] };
  knowledge_graph_insight?: KnowledgeGraphInsight;
}

interface NoIntelligence {
  has_intelligence: false;
  reason:           string;
}

type ApiResponse = IntelligenceData | NoIntelligence;

// ── Utilities ─────────────────────────────────────────────────────────────────

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function riskColor(level: string): string {
  if (level === "low")      return "text-emerald-400";
  if (level === "moderate") return "text-amber-400";
  if (level === "high")     return "text-red-400";
  return "text-neutral-400";
}

function riskBg(level: string): string {
  if (level === "low")      return "bg-emerald-950 border-emerald-800 text-emerald-300";
  if (level === "moderate") return "bg-amber-950 border-amber-800 text-amber-300";
  if (level === "high")     return "bg-red-950 border-red-800 text-red-300";
  return "bg-neutral-900 border-neutral-700 text-neutral-400";
}

function stabilityColor(s: string): string {
  if (s === "stable")    return "text-emerald-400";
  if (s === "weakening") return "text-amber-400";
  if (s === "unstable")  return "text-red-400";
  return "text-neutral-400";
}

function trendColor(t: string): string {
  if (t === "favorable" || t === "strengthening") return "text-emerald-400";
  if (t === "neutral")                            return "text-neutral-400";
  return "text-red-400";
}

function capitalize(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function tierBadge(tier: string | null): string {
  const t = (tier ?? "").toLowerCase();
  if (t === "supreme")    return "bg-violet-950 border-violet-800 text-violet-300";
  if (t === "high_court") return "bg-blue-950 border-blue-800 text-blue-300";
  if (t === "legislation") return "bg-sky-950 border-sky-800 text-sky-300";
  return "bg-neutral-900 border-neutral-700 text-neutral-400";
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({ index, title }: { index: string; title: string }) {
  return (
    <div className="flex items-center gap-3 mb-5">
      <span className="text-[10px] font-bold text-neutral-600 tracking-widest uppercase">{index}</span>
      <div className="flex-1 h-px bg-neutral-800" />
      <h2 className="text-xs font-semibold text-neutral-400 uppercase tracking-widest">{title}</h2>
    </div>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-[#111111] rounded-xl border border-neutral-800 px-5 py-5 ${className}`}>
      {children}
    </div>
  );
}

function StatRow({ label, value, valueClass = "text-neutral-200" }: {
  label:       string;
  value:       string | number;
  valueClass?: string;
}) {
  return (
    <div className="flex items-baseline justify-between py-2 border-b border-neutral-800/60 last:border-0">
      <span className="text-xs text-neutral-500">{label}</span>
      <span className={`text-xs font-semibold tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );
}

// ── Section: Case Overview ────────────────────────────────────────────────────

function CaseOverview({ data }: { data: IntelligenceData }) {
  const { meta, litigation_brief: brief, litigation_assessment: la } = data;

  return (
    <section>
      <SectionHeader index="01" title="Case Overview" />
      <div className="grid gap-4 sm:grid-cols-3">

        {/* Summary card */}
        <Card className="sm:col-span-2">
          <p className="text-[10px] font-semibold text-neutral-600 uppercase tracking-widest mb-2">
            Executive Summary
          </p>
          <p className="text-sm text-neutral-300 leading-relaxed" style={{ whiteSpace: "pre-wrap" }}>
            {brief?.executive_summary ?? meta.issue_summary}
          </p>
          {brief?.key_issues && brief.key_issues.length > 0 && (
            <ul className="mt-3 space-y-1">
              {brief.key_issues.map((issue, i) => (
                <li key={i} className="flex gap-2 text-xs text-neutral-500">
                  <span className="text-neutral-700 select-none">—</span>
                  {issue}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Stats card */}
        <Card>
          <p className="text-[10px] font-semibold text-neutral-600 uppercase tracking-widest mb-3">
            Assessment
          </p>
          <StatRow
            label="Confidence"
            value={pct(meta.confidence_score)}
            valueClass="text-neutral-200"
          />
          <StatRow
            label="Risk Level"
            value={capitalize(meta.risk_level)}
            valueClass={riskColor(meta.risk_level)}
          />
          {la && (
            <>
              <StatRow
                label="Success Probability"
                value={pct(la.success_probability)}
                valueClass="text-neutral-200"
              />
              <StatRow
                label="Litigation Exposure"
                value={capitalize(la.risk_band)}
                valueClass={riskColor(la.risk_band)}
              />
            </>
          )}
          {brief?.risk_assessment && (
            <StatRow
              label="Brief Risk"
              value={capitalize(brief.risk_assessment.risk_level)}
              valueClass={riskColor(brief.risk_assessment.risk_level)}
            />
          )}
        </Card>
      </div>

      {/* Governing law + strategy recommendation */}
      {brief && (
        <div className="grid gap-4 sm:grid-cols-2 mt-4">
          {brief.governing_law.length > 0 && (
            <Card>
              <p className="text-[10px] font-semibold text-neutral-600 uppercase tracking-widest mb-3">
                Governing Law
              </p>
              <ul className="space-y-1">
                {brief.governing_law.map((law, i) => (
                  <li key={i} className="text-xs text-neutral-400 flex gap-2">
                    <span className="text-neutral-700 select-none">§</span>
                    {law}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {brief.strategy_recommendation && (
            <Card>
              <p className="text-[10px] font-semibold text-neutral-600 uppercase tracking-widest mb-2">
                Recommended Action
              </p>
              <p className="text-xs text-neutral-400 leading-relaxed">
                {brief.strategy_recommendation}
              </p>
            </Card>
          )}
        </div>
      )}

      {/* Litigation drivers */}
      {la && la.drivers.length > 0 && (
        <Card className="mt-4">
          <p className="text-[10px] font-semibold text-neutral-600 uppercase tracking-widest mb-3">
            Outcome Drivers
          </p>
          <ul className="grid sm:grid-cols-2 gap-1.5">
            {la.drivers.map((d, i) => (
              <li key={i} className="text-xs text-neutral-500 flex gap-2">
                <span className="text-neutral-700 select-none mt-px">•</span>
                {d}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}

// ── Section: Strategy Comparison ──────────────────────────────────────────────

function StrategyComparison({ sim }: { sim: { strategies: Strategy[] } }) {
  const sorted = [...sim.strategies].sort(
    (a, b) => b.adjusted_success_probability - a.adjusted_success_probability
  );

  return (
    <section>
      <SectionHeader index="02" title="Strategy Comparison" />
      <div className="space-y-3">
        {sorted.map((s, i) => (
          <Card key={i}>
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-2.5">
                {i === 0 && (
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-950 border border-emerald-800 text-emerald-400 uppercase tracking-wider">
                    Recommended
                  </span>
                )}
                <h3 className="text-sm font-semibold text-neutral-200">
                  {capitalize(s.strategy_type)}
                </h3>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className={`text-xs font-bold tabular-nums ${riskColor(s.adjusted_risk_level)}`}>
                  {pct(s.adjusted_success_probability)}
                </span>
                <span className={`px-2 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wide ${riskBg(s.adjusted_risk_level)}`}>
                  {s.adjusted_risk_level}
                </span>
              </div>
            </div>
            <p className="text-xs text-neutral-500 mt-2 leading-relaxed">{s.description}</p>
            {s.reasoning_factors.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {s.reasoning_factors.map((f, j) => (
                  <li
                    key={j}
                    className="px-2 py-0.5 rounded bg-neutral-900 border border-neutral-800 text-[10px] text-neutral-500"
                  >
                    {f}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ))}
      </div>
    </section>
  );
}

// ── Section: Precedent Intelligence ──────────────────────────────────────────

function PrecedentSection({
  influence,
  analysis,
}: {
  influence?: DoctrineInfluence;
  analysis?:  DoctrineAnalysis;
}) {
  return (
    <section>
      <SectionHeader index="03" title="Precedent Intelligence" />
      <div className="grid gap-4 sm:grid-cols-2">

        {/* Doctrine stability */}
        {analysis && (
          <Card>
            <p className="text-[10px] font-semibold text-neutral-600 uppercase tracking-widest mb-3">
              Doctrine Stability
            </p>
            <StatRow
              label="Stability"
              value={capitalize(analysis.doctrine_stability)}
              valueClass={stabilityColor(analysis.doctrine_stability)}
            />
            <StatRow
              label="Overruling Risk"
              value={pct(analysis.overruling_risk_score)}
              valueClass={riskColor(analysis.overruling_risk_score > 0.5 ? "high" : analysis.overruling_risk_score > 0.25 ? "moderate" : "low")}
            />
            <StatRow
              label="Supporting Precedents"
              value={analysis.supporting_precedent_count}
            />
            <StatRow
              label="Negative Treatments"
              value={analysis.negative_treatment_count}
              valueClass={analysis.negative_treatment_count > 0 ? "text-red-400" : "text-neutral-200"}
            />
            <StatRow
              label="Trend"
              value={capitalize(analysis.doctrine_trend)}
              valueClass={trendColor(analysis.doctrine_trend)}
            />
          </Card>
        )}

        {/* Network metrics */}
        {influence && (
          <Card>
            <p className="text-[10px] font-semibold text-neutral-600 uppercase tracking-widest mb-3">
              Precedent Network
            </p>
            <StatRow
              label="Cluster Size"
              value={influence.doctrine_cluster_size}
            />
            <StatRow
              label="Network Density"
              value={influence.precedent_network_density.toFixed(3)}
            />
          </Card>
        )}
      </div>

      {/* Leading precedents */}
      {influence && influence.leading_precedents.length > 0 && (
        <Card className="mt-4">
          <p className="text-[10px] font-semibold text-neutral-600 uppercase tracking-widest mb-3">
            Leading Precedents
          </p>
          <div className="space-y-2">
            {influence.leading_precedents.map((p, i) => (
              <div
                key={i}
                className="flex items-center justify-between py-2 border-b border-neutral-800/60 last:border-0"
              >
                <span className="text-xs text-neutral-300 truncate pr-3">{p.case_title}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`px-1.5 py-0.5 rounded border text-[9px] font-semibold uppercase tracking-wide ${tierBadge(p.authority_tier)}`}>
                    {p.authority_tier.replace(/_/g, " ")}
                  </span>
                  <span className="text-[10px] text-neutral-600 tabular-nums w-12 text-right">
                    {(p.influence_score * 100).toFixed(0)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </section>
  );
}

// ── Section: Similar Cases ────────────────────────────────────────────────────

function SimilarCases({ pi }: { pi: PrecedentIntelligence }) {
  const cases = pi.similar_cases.filter((c) => c.case_title);

  return (
    <section>
      <SectionHeader index="04" title="Similar Cases" />
      <div className="grid gap-4 sm:grid-cols-2">
        {/* Strength metrics */}
        <Card>
          <p className="text-[10px] font-semibold text-neutral-600 uppercase tracking-widest mb-3">
            Precedent Strength
          </p>
          <StatRow
            label="Strength Score"
            value={pct(pi.precedent_strength_score)}
          />
          <StatRow
            label="Incoming Citations"
            value={pi.incoming_citations}
          />
          <StatRow
            label="Doctrine Instability"
            value={pi.doctrine_instability ? "Detected" : "None"}
            valueClass={pi.doctrine_instability ? "text-amber-400" : "text-emerald-400"}
          />
        </Card>

        {/* Top similar case */}
        {cases[0] && (
          <Card>
            <p className="text-[10px] font-semibold text-neutral-600 uppercase tracking-widest mb-3">
              Closest Match
            </p>
            <p className="text-sm font-medium text-neutral-200 leading-snug">
              {cases[0].case_title}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {cases[0].authority_tier && (
                <span className={`px-1.5 py-0.5 rounded border text-[9px] font-semibold uppercase tracking-wide ${tierBadge(cases[0].authority_tier)}`}>
                  {cases[0].authority_tier.replace(/_/g, " ")}
                </span>
              )}
              {cases[0].decision_year && (
                <span className="text-[10px] text-neutral-600">{cases[0].decision_year}</span>
              )}
              <span className="text-[10px] text-neutral-500 ml-auto tabular-nums">
                {pct(cases[0].similarity)} match
              </span>
            </div>
          </Card>
        )}
      </div>

      {/* Full cases list */}
      {cases.length > 1 && (
        <Card className="mt-4">
          <p className="text-[10px] font-semibold text-neutral-600 uppercase tracking-widest mb-3">
            All Similar Cases
          </p>
          <div className="space-y-0">
            {cases.map((c, i) => (
              <div
                key={i}
                className="flex items-center justify-between py-2.5 border-b border-neutral-800/60 last:border-0"
              >
                <div className="flex items-center gap-2.5 min-w-0 pr-3">
                  {c.authority_tier && (
                    <span className={`px-1.5 py-0.5 rounded border text-[9px] font-semibold uppercase tracking-wide shrink-0 ${tierBadge(c.authority_tier)}`}>
                      {c.authority_tier.replace(/_/g, " ")}
                    </span>
                  )}
                  <span className="text-xs text-neutral-300 truncate">{c.case_title}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {c.decision_year && (
                    <span className="text-[10px] text-neutral-600">{c.decision_year}</span>
                  )}
                  <span className="text-[10px] font-semibold text-neutral-400 tabular-nums w-14 text-right">
                    {pct(c.similarity)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </section>
  );
}

// ── Section: Forum Intelligence ───────────────────────────────────────────────

function ForumSection({ fi }: { fi: ForumIntelligence }) {
  const hasForum = fi.court_name || fi.forum_success_rate !== undefined;
  const hasJudge = fi.judge_name || fi.judge_success_rate !== undefined;

  return (
    <section>
      <SectionHeader index="05" title="Forum Intelligence" />
      <div className="grid gap-4 sm:grid-cols-2">
        {hasForum && (
          <Card>
            <p className="text-[10px] font-semibold text-neutral-600 uppercase tracking-widest mb-3">
              Court / Forum
            </p>
            {fi.court_name && (
              <p className="text-sm font-medium text-neutral-200 mb-3">{fi.court_name}</p>
            )}
            {fi.forum_success_rate !== undefined && (
              <StatRow label="Forum Success Rate" value={pct(fi.forum_success_rate)} />
            )}
            {fi.forum_trend !== undefined && (
              <StatRow
                label="5-Year Trend"
                value={fi.forum_trend > 0 ? `+${(fi.forum_trend * 100).toFixed(1)}pp` : `${(fi.forum_trend * 100).toFixed(1)}pp`}
                valueClass={fi.forum_trend > 0 ? "text-emerald-400" : fi.forum_trend < 0 ? "text-red-400" : "text-neutral-400"}
              />
            )}
          </Card>
        )}

        {hasJudge && (
          <Card>
            <p className="text-[10px] font-semibold text-neutral-600 uppercase tracking-widest mb-3">
              Judge Profile
            </p>
            {fi.judge_name && (
              <p className="text-sm font-medium text-neutral-200 mb-3">{fi.judge_name}</p>
            )}
            {fi.judge_success_rate !== undefined && (
              <StatRow label="Judge Success Rate" value={pct(fi.judge_success_rate)} />
            )}
            {fi.judge_strictness_index !== undefined && (
              <StatRow
                label="Strictness Index"
                value={fi.judge_strictness_index.toFixed(2)}
                valueClass={fi.judge_strictness_index > 0.6 ? "text-red-400" : fi.judge_strictness_index > 0.4 ? "text-amber-400" : "text-emerald-400"}
              />
            )}
          </Card>
        )}
      </div>
    </section>
  );
}

// ── Section: Benchmark Assessment ────────────────────────────────────────────

function BenchmarkSection({ bm }: { bm: BenchmarkAssessment }) {
  return (
    <section>
      <SectionHeader index="06" title="Historical Benchmark" />
      <Card>
        <div className="grid sm:grid-cols-2 gap-x-8">
          <StatRow label="Comparable Cases" value={bm.comparable_case_count} />
          <StatRow
            label="Historical Success Rate"
            value={pct(bm.historical_success_rate)}
          />
          <StatRow
            label="Authority Alignment"
            value={pct(bm.authority_alignment_score)}
          />
          {bm.trend_direction && (
            <StatRow
              label="Outcome Trend"
              value={capitalize(bm.trend_direction)}
              valueClass={trendColor(bm.trend_direction)}
            />
          )}
        </div>
      </Card>
    </section>
  );
}

// ── Section: Knowledge Graph ──────────────────────────────────────────────────

function KnowledgeGraphSection({ kg }: { kg: KnowledgeGraphInsight }) {
  return (
    <section>
      <SectionHeader index="07" title="Knowledge Graph" />
      <div className="grid gap-3 sm:grid-cols-4">
        {[
          { label: "Related Cases",   value: kg.related_cases         },
          { label: "Citing Cases",    value: kg.citing_cases          },
          { label: "Overruling Cases", value: kg.overruling_cases     },
          { label: "Cluster Size",    value: kg.doctrine_cluster_size },
        ].map(({ label, value }) => (
          <Card key={label} className="text-center py-6">
            <p className="text-2xl font-bold text-neutral-200 tabular-nums">{value}</p>
            <p className="text-[10px] text-neutral-600 uppercase tracking-widest mt-1">{label}</p>
          </Card>
        ))}
      </div>
    </section>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ reason, chatId }: { reason: string; chatId: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-14 h-14 rounded-full bg-neutral-900 border border-neutral-800 flex items-center justify-center mb-5">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6 text-neutral-600">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
      </div>
      <p className="text-sm font-medium text-neutral-300 mb-2">No Legal Intelligence Available</p>
      <p className="text-xs text-neutral-600 max-w-xs leading-relaxed">{reason}</p>
      <Link
        href={`/?chatId=${chatId}`}
        className="mt-6 px-4 py-2 rounded-lg bg-neutral-900 border border-neutral-800 text-xs text-neutral-400 hover:text-neutral-200 hover:border-neutral-600 transition-colors"
      >
        Open in Premium Mode
      </Link>
    </div>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="space-y-10 animate-pulse">
      {[1, 2, 3].map((i) => (
        <div key={i}>
          <div className="flex items-center gap-3 mb-5">
            <div className="h-2 w-6 rounded bg-neutral-800" />
            <div className="flex-1 h-px bg-neutral-800" />
            <div className="h-2 w-24 rounded bg-neutral-800" />
          </div>
          <div className={`grid gap-4 ${i === 1 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
            <div className={`bg-[#111111] rounded-xl border border-neutral-800 h-36 ${i === 1 ? "sm:col-span-2" : ""}`} />
            <div className="bg-[#111111] rounded-xl border border-neutral-800 h-36" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function LegalIntelligencePage() {
  const params = useParams<{ chatId: string }>();
  const chatId = params?.chatId ?? "";

  const [data,    setData]    = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    if (!chatId) return;

    setLoading(true);
    setError(null);

    fetch(`/api/legal-intelligence/${chatId}`)
      .then(async (res) => {
        if (res.status === 401) throw new Error("Unauthorized. Please sign in.");
        if (res.status === 404) throw new Error("Chat not found.");
        if (!res.ok)            throw new Error(`Request failed (${res.status}).`);
        return res.json() as Promise<ApiResponse>;
      })
      .then((json) => setData(json))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "An error occurred."))
      .finally(() => setLoading(false));
  }, [chatId]);

  return (
    <div className="min-h-screen bg-[#0a0a0a]">

      {/* Top nav */}
      <div className="bg-[#111111] border-b border-neutral-800 px-8 py-3 flex items-center gap-3 text-sm text-neutral-500">
        <Link href="/" className="hover:text-neutral-200 transition-colors">Workspace</Link>
        <span>/</span>
        <span className="text-neutral-200 font-medium">Legal Intelligence</span>
        {chatId && (
          <>
            <span>/</span>
            <span className="font-mono text-xs text-neutral-600 truncate max-w-[180px]">{chatId}</span>
          </>
        )}
      </div>

      <div className="max-w-4xl mx-auto px-6 py-10">

        {/* Page header */}
        <div className="mb-10">
          <h1 className="text-2xl font-semibold text-neutral-100 tracking-tight">Legal Intelligence</h1>
          <p className="mt-1.5 text-sm text-neutral-500">
            AI-generated litigation analysis from Premium mode.
          </p>
        </div>

        {/* States */}
        {loading && <Skeleton />}

        {error && (
          <div className="rounded-xl border border-red-900 bg-red-950/40 px-5 py-4 text-sm text-red-400">
            {error}
          </div>
        )}

        {!loading && !error && data && !data.has_intelligence && (
          <EmptyState reason={data.reason} chatId={chatId} />
        )}

        {!loading && !error && data?.has_intelligence && (() => {
          const d = data as IntelligenceData;
          return (
            <div className="space-y-12">

              {/* Meta ribbon */}
              <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-600">
                <span>Analysis generated</span>
                <span className="text-neutral-800">·</span>
                <span>{new Date(d.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</span>
                <span className="text-neutral-800">·</span>
                <span className="font-mono text-[10px]">msg:{d.message_id.slice(0, 8)}</span>
              </div>

              {/* 01 Case Overview — always shown */}
              <CaseOverview data={d} />

              {/* 02 Strategy Comparison */}
              {d.strategy_simulation && d.strategy_simulation.strategies.length > 0 && (
                <StrategyComparison sim={d.strategy_simulation} />
              )}

              {/* 03 Precedent Intelligence */}
              {(d.doctrine_influence || d.doctrine_analysis) && (
                <PrecedentSection
                  influence={d.doctrine_influence}
                  analysis={d.doctrine_analysis}
                />
              )}

              {/* 04 Similar Cases */}
              {d.precedent_intelligence && (
                <SimilarCases pi={d.precedent_intelligence} />
              )}

              {/* 05 Forum Intelligence */}
              {d.forum_intelligence && (
                <ForumSection fi={d.forum_intelligence} />
              )}

              {/* 06 Historical Benchmark */}
              {d.benchmark_assessment && (
                <BenchmarkSection bm={d.benchmark_assessment} />
              )}

              {/* 07 Knowledge Graph */}
              {d.knowledge_graph_insight && (
                <KnowledgeGraphSection kg={d.knowledge_graph_insight} />
              )}

              {/* Back link */}
              <div className="pt-4 border-t border-neutral-900">
                <Link
                  href={`/?chatId=${chatId}`}
                  className="text-xs text-neutral-600 hover:text-neutral-400 transition-colors"
                >
                  ← Return to chat
                </Link>
              </div>

            </div>
          );
        })()}

      </div>
    </div>
  );
}
