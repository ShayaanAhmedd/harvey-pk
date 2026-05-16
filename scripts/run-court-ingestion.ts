/**
 * run-court-ingestion.ts — Continuous Court Intelligence Ingestion Runner
 *
 * Orchestrates the full pipeline:
 *   scrape → parse → deduplicate → embed → insert → analytics
 *
 * Usage:
 *   npx ts-node scripts/run-court-ingestion.ts URL1 URL2 ...
 *   npx ts-node scripts/run-court-ingestion.ts --config data/court-sources.json
 *   npx ts-node scripts/run-court-ingestion.ts --dry-run --max 5 URL1
 *
 * court-sources.json format:
 *   [{ "url": "https://...", "court_name": "Supreme Court of Pakistan" }]
 *
 * Required env vars (in .env.local):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   OPENAI_API_KEY
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import OpenAI from "openai";

import { validateEnvironment } from "../lib/utils/env-validator";
import { detectGatewayError, formatError, withGatewayErrorHandling } from "../lib/utils/network-errors";
import { fetchCourtDecisions } from "../lib/scrapers/court-scraper";
import {
  parseJudgment,
  normaliseText,
  sha256,
  extractCaseCitations,
} from "../lib/parsers/judgment-parser";

// ── Env ───────────────────────────────────────────────────────────────────────

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

// Validate before touching any API — throws with a clear message if missing
validateEnvironment();

const SUPABASE_URL        = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL)!;
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)!;
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ── Types ─────────────────────────────────────────────────────────────────────

interface CourtSource {
  url:        string;
  court_name?: string; // optional override for scraped court_name
}

interface IngestionOptions {
  dryRun:      boolean;
  maxPerSource: number;
}

interface RunStats {
  fetched:  number;
  skipped:  number; // duplicates
  inserted: number;
  failed:   number;
}

// ── CLI arg parser ────────────────────────────────────────────────────────────

function parseArgs(): { sources: CourtSource[]; options: IngestionOptions } {
  const argv = process.argv.slice(2);
  const result: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      result[key] = val;
    } else {
      positional.push(a);
    }
  }

  const options: IngestionOptions = {
    dryRun:       result["dry-run"] === "true",
    maxPerSource: result["max"] ? parseInt(result["max"], 10) : 20,
  };

  // Sources from --config file
  if (result["config"]) {
    const configPath = path.resolve(result["config"]);
    if (!fs.existsSync(configPath)) {
      console.error(`❌  Config file not found: ${configPath}`);
      process.exit(1);
    }
    try {
      const sources = JSON.parse(fs.readFileSync(configPath, "utf-8")) as CourtSource[];
      return { sources, options };
    } catch (err) {
      console.error(`❌  Failed to parse config: ${formatError(err)}`);
      process.exit(1);
    }
  }

  // Sources from positional URL arguments
  const sources: CourtSource[] = positional
    .filter((u) => u.startsWith("http"))
    .map((url) => ({ url }));

  if (sources.length === 0) {
    console.error(
      "Usage: npx ts-node scripts/run-court-ingestion.ts [--dry-run] [--max N] URL1 URL2 ...\n" +
      "       npx ts-node scripts/run-court-ingestion.ts --config data/court-sources.json",
    );
    process.exit(1);
  }

  return { sources, options };
}

// ── Embedding ─────────────────────────────────────────────────────────────────

async function embedText(text: string): Promise<number[]> {
  return withGatewayErrorHandling("embedText", async () => {
    const res = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text.slice(0, 8000),
    });
    return res.data[0].embedding;
  });
}

// ── Deduplication ─────────────────────────────────────────────────────────────

async function isAlreadyIngested(
  hash: string,
): Promise<{ id: string; case_title: string | null } | null> {
  try {
    const { data } = await supabase
      .from("legal_cases")
      .select("id, case_title")
      .eq("hash", hash)
      .maybeSingle();
    return data ?? null;
  } catch {
    return null;
  }
}

// ── Precedent graph helpers (mirrors ingest-case.ts, accepts explicit client) ─

async function insertPrecedentNode(
  db:           SupabaseClient,
  caseId:       string,
  caseTitle:    string | null,
  decisionYear: number | null,
  authorityTier: string,
  courtName:    string | null,
  embedding:    number[],
): Promise<void> {
  await db.from("precedent_nodes").upsert(
    { case_id: caseId, case_title: caseTitle, decision_year: decisionYear,
      authority_tier: authorityTier, court_name: courtName, embedding },
    { onConflict: "case_id" },
  );
}

async function insertPrecedentEdges(
  db:           SupabaseClient,
  fromCaseId:   string,
  caseCitations: string[],
): Promise<string[]> {
  const nameCites = caseCitations.filter((c) => /v\./.test(c));
  if (nameCites.length === 0) return [];

  const orFilter = nameCites.map((c) => `case_title.ilike.%${c}%`).join(",");
  const { data } = await db
    .from("precedent_nodes")
    .select("case_id, case_title")
    .or(orFilter);

  if (!data || data.length === 0) return [];

  const matched = (data as { case_id: string }[]).filter((n) => n.case_id !== fromCaseId);
  const edges = matched.map((n) => ({
    from_case_id: fromCaseId, to_case_id: n.case_id,
    relation_type: "cites", weight: 1.0,
  }));

  if (edges.length > 0) {
    await db.from("precedent_edges").upsert(edges, {
      onConflict: "from_case_id,to_case_id,relation_type",
      ignoreDuplicates: true,
    });
  }

  return matched.map((n) => n.case_id);
}

// ── Benchmark / analytics updates (mirrors ingest-case.ts) ───────────────────

async function updateBenchmarkStats(
  db:      SupabaseClient,
  actName: string,
  section: string,
): Promise<void> {
  const { data } = await db
    .from("legal_cases")
    .select("outcome, authority_tier, decision_year")
    .eq("act_name", actName)
    .eq("section_number", section);

  if (!data || data.length === 0) return;

  const rows    = data as { outcome: string | null; authority_tier: string | null; decision_year: number | null }[];
  const total   = rows.length;
  const fav     = rows.filter((r) => r.outcome === "favorable").length;
  const supRows = rows.filter((r) => r.authority_tier === "supreme");
  const supFav  = supRows.filter((r) => r.outcome === "favorable").length;

  const currentYear = new Date().getFullYear();
  const cutoff      = currentYear - 5;
  const recent      = rows.filter((r) => r.decision_year != null && r.decision_year >= cutoff);
  const prior       = rows.filter((r) => r.decision_year != null && r.decision_year < cutoff);
  let trend: "favorable" | "neutral" | "unfavorable" | null = null;
  if (recent.length > 0 && prior.length > 0) {
    const d = (recent.filter((r) => r.outcome === "favorable").length / recent.length) -
              (prior.filter((r)  => r.outcome === "favorable").length / prior.length);
    trend = d > 0.1 ? "favorable" : d < -0.1 ? "unfavorable" : "neutral";
  }

  await db.from("benchmark_cache").upsert(
    {
      act_name:       actName,
      section_number: section,
      total_cases:    total,
      success_rate:   total > 0 ? Math.round((fav / total) * 10000) / 10000 : null,
      supreme_alignment: supRows.length > 0 ? Math.round((supFav / supRows.length) * 10000) / 10000 : null,
      ...(trend && { five_year_trend: trend }),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "act_name,section_number" },
  );
}

async function updateJudgeAnalytics(
  db:        SupabaseClient,
  judgeName: string,
  courtName: string | null,
  actName:   string | null,
  outcome:   string,
): Promise<void> {
  const { data: ex } = await db
    .from("judge_analytics")
    .select("total_cases, favorable_count, unfavorable_count, act_specialization")
    .eq("judge_name", judgeName)
    .maybeSingle();

  const prev = (ex ?? { total_cases: 0, favorable_count: 0, unfavorable_count: 0, act_specialization: {} }) as {
    total_cases: number; favorable_count: number; unfavorable_count: number; act_specialization: Record<string, number>;
  };

  const newTotal = prev.total_cases + 1;
  const newFav   = prev.favorable_count   + (outcome === "favorable"   ? 1 : 0);
  const newUnfav = prev.unfavorable_count + (outcome === "unfavorable" ? 1 : 0);
  const actSpec  = { ...prev.act_specialization };

  if (actName) {
    const oldFrac  = actSpec[actName] ?? 0;
    const oldCount = Math.round(oldFrac * prev.total_cases);
    actSpec[actName] = newTotal > 0 ? (oldCount + 1) / newTotal : 0;
    for (const k of Object.keys(actSpec)) {
      if (k === actName) continue;
      const cnt = Math.round((actSpec[k] ?? 0) * prev.total_cases);
      actSpec[k] = newTotal > 0 ? cnt / newTotal : 0;
    }
  }

  await db.from("judge_analytics").upsert(
    {
      judge_name: judgeName,
      ...(courtName && { court_name: courtName }),
      total_cases:       newTotal,
      favorable_count:   newFav,
      unfavorable_count: newUnfav,
      success_rate:      newTotal > 0 ? Math.round((newFav   / newTotal) * 10000) / 10000 : null,
      strictness_index:  newTotal > 0 ? Math.round((newUnfav / newTotal) * 10000) / 10000 : null,
      act_specialization: actSpec,
      last_updated:      new Date().toISOString(),
    },
    { onConflict: "judge_name" },
  );
}

async function updateForumAnalytics(
  db:        SupabaseClient,
  courtName: string,
): Promise<void> {
  const { data } = await db
    .from("legal_cases")
    .select("outcome, authority_tier, decision_year, created_at")
    .eq("court_name", courtName);

  if (!data || data.length === 0) return;

  const rows  = data as { outcome: string | null; authority_tier: string | null; decision_year: number | null; created_at: string | null }[];
  const total = rows.length;
  const fav   = rows.filter((r) => r.outcome === "favorable").length;

  const scRows  = rows.filter((r) => r.authority_tier === "supreme");
  const scFav   = scRows.filter((r) => r.outcome === "favorable").length;
  const scAlign = scRows.length > 0 ? Math.round((scFav / scRows.length) * 10000) / 10000 : null;

  const currentYear = new Date().getFullYear();
  const cutoff      = currentYear - 5;
  const recent      = rows.filter((r) => r.decision_year != null && r.decision_year >= cutoff);
  const prior       = rows.filter((r) => r.decision_year != null && r.decision_year < cutoff);
  let trend: number | null = null;
  if (recent.length > 0 && prior.length > 0) {
    trend = Math.round(
      ((recent.filter((r) => r.outcome === "favorable").length / recent.length) -
       (prior.filter((r)  => r.outcome === "favorable").length / prior.length)) * 10000
    ) / 10000;
  }

  const cutoffDate  = new Date(); cutoffDate.setFullYear(cutoffDate.getFullYear() - 1);
  const vol12       = rows.filter((r) => r.created_at && new Date(r.created_at) >= cutoffDate).length;

  await db.from("forum_analytics").upsert(
    {
      court_name:            courtName,
      total_cases:           total,
      overall_success_rate:  Math.round((fav / total) * 10000) / 10000,
      supreme_alignment_rate: scAlign,
      ...(trend !== null && { five_year_trend: trend }),
      volume_last_12_months: vol12,
      last_updated:          new Date().toISOString(),
    },
    { onConflict: "court_name" },
  );
}

// ── Single decision ingestion ─────────────────────────────────────────────────

async function ingestDecision(
  fullText:   string,
  sourceUrl:  string,
  titleHint?: string | null,
  dryRun?:    boolean,
): Promise<"inserted" | "skipped" | "failed"> {
  const normText = normaliseText(fullText);
  const hash     = sha256(normText);

  // Deduplication
  const existing = await isAlreadyIngested(hash);
  if (existing) {
    console.log(`  ⚠️   Duplicate: "${existing.case_title ?? "(untitled)"}" — skipping`);
    return "skipped";
  }

  try {
    const meta       = parseJudgment(normText);
    const caseTitle  = titleHint ?? meta.case_title;
    const primaryAct = meta.act_names[0] ?? null;
    const primarySec = meta.sections[0]  ?? null;

    console.log(`  📄  Title:    ${caseTitle ?? "(unknown)"}`);
    console.log(`      Authority: ${meta.authority_tier} | Court: ${meta.court_name ?? "?"} | Year: ${meta.decision_year ?? "?"}`);
    console.log(`      Outcome:   ${meta.outcome} | Acts: ${meta.act_names.slice(0, 3).join(", ") || "(none)"}`);
    console.log(`      parse_confidence: ${meta.parse_confidence}`);

    if (dryRun) {
      console.log(`  🔍  Dry-run: would insert. Skipping DB writes.`);
      return "inserted"; // count as "would insert"
    }

    // Embed
    const embedding = await embedText(normText);

    // Insert legal_cases
    const { data: inserted, error: insertErr } = await supabase
      .from("legal_cases")
      .insert({
        case_title:       caseTitle    ?? null,
        act_name:         primaryAct,
        section_number:   primarySec,
        authority_tier:   meta.authority_tier,
        court_name:       meta.court_name,
        judge_name:       meta.judge_name,
        decision_year:    meta.decision_year,
        outcome:          meta.outcome,
        jurisdiction:     meta.jurisdiction ?? "Pakistan",
        citation_count:   meta.citation_count,
        full_text:        normText,
        embedding,
        hash,
        parse_confidence: meta.parse_confidence,
        source_url:       sourceUrl,
      })
      .select("id")
      .single();

    if (insertErr) {
      const gw = detectGatewayError(insertErr.message);
      if (gw) {
        console.error(`  ❌  Insert failed: ${gw.message}`);
      } else {
        console.error(`  ❌  Insert failed: ${insertErr.message}`);
      }
      return "failed";
    }

    const caseId = inserted.id as string;
    console.log(`  ✅  Inserted case id: ${caseId}`);

    // Precedent node
    await insertPrecedentNode(
      supabase, caseId, caseTitle ?? null, meta.decision_year,
      meta.authority_tier, meta.court_name, embedding,
    ).catch(() => { /* non-fatal */ });

    // Precedent edges
    const citations = extractCaseCitations(normText);
    let citedIds: string[] = [];
    if (citations.length > 0) {
      citedIds = await insertPrecedentEdges(supabase, caseId, citations)
        .catch(() => []);
    }

    // Knowledge graph (minimal — case entity only to avoid blocking)
    await supabase.from("legal_entities").upsert(
      {
        id:          caseId,
        entity_type: "case",
        name:        caseTitle ?? `Case ${caseId.slice(0, 8)}`,
        metadata:    { authority_tier: meta.authority_tier, court_name: meta.court_name },
      },
      { onConflict: "id" },
    ).catch(() => { /* non-fatal */ });

    void citedIds; // used by full knowledge graph (insertKnowledgeGraph in ingest-case.ts)

    // Benchmark cache
    if (primaryAct && primarySec) {
      await updateBenchmarkStats(supabase, primaryAct, primarySec).catch(() => {});
    }
    if (primaryAct) {
      await updateBenchmarkStats(supabase, primaryAct, "*").catch(() => {});
    }

    // Judge + forum analytics
    if (meta.judge_name) {
      await updateJudgeAnalytics(supabase, meta.judge_name, meta.court_name, primaryAct, meta.outcome)
        .catch(() => {});
    }
    if (meta.court_name) {
      await updateForumAnalytics(supabase, meta.court_name).catch(() => {});
    }

    return "inserted";
  } catch (err) {
    const gw = detectGatewayError(err);
    if (gw) {
      console.error(`  ❌  ${gw.message}`);
    } else {
      console.error(`  ❌  API request failed: ${formatError(err)}`);
    }
    return "failed";
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { sources, options } = parseArgs();
  const { dryRun, maxPerSource } = options;

  if (dryRun) console.log("  ⚠️   DRY-RUN mode — no database writes will occur\n");

  const totals: RunStats = { fetched: 0, skipped: 0, inserted: 0, failed: 0 };

  for (const source of sources) {
    console.log(`\n🌐  Source: ${source.url}`);

    let decisions;
    try {
      decisions = await withGatewayErrorHandling("fetchCourtDecisions", () =>
        fetchCourtDecisions(source.url, { maxDecisions: maxPerSource }),
      );
    } catch (err) {
      console.error(`  ❌  Scrape failed: ${formatError(err)}`);
      totals.failed++;
      continue;
    }

    console.log(`  📥  Fetched ${decisions.length} decision(s)\n`);
    totals.fetched += decisions.length;

    for (const [i, decision] of decisions.entries()) {
      console.log(`  [${i + 1}/${decisions.length}] ${decision.source_url}`);

      const result = await ingestDecision(
        decision.full_text,
        decision.source_url,
        decision.title,
        dryRun,
      );

      if (result === "inserted") totals.inserted++;
      else if (result === "skipped") totals.skipped++;
      else totals.failed++;

      console.log("");
    }
  }

  console.log("══════════════════════════════════════════");
  console.log("  Ingestion complete");
  console.log(`  Fetched:  ${totals.fetched}`);
  console.log(`  Inserted: ${totals.inserted}${dryRun ? " (dry-run)" : ""}`);
  console.log(`  Skipped:  ${totals.skipped} (duplicates)`);
  console.log(`  Failed:   ${totals.failed}`);
  console.log("══════════════════════════════════════════\n");

  process.exit(totals.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  const gw = detectGatewayError(err);
  if (gw) {
    console.error(`❌  Fatal: ${gw.message}`);
  } else {
    console.error(`❌  Fatal: ${formatError(err)}`);
  }
  process.exit(1);
});
