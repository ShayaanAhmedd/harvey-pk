/**
 * detect-drift.ts — Legal Outcome Drift Detection Script
 *
 * Detects three types of judicial drift from benchmark_cache + legal_cases:
 *   1. 5-year rate drop ≥ 15%  (success rate declining vs prior period)
 *   2. Surge in unfavorable SC  (Supreme Court unfavorable decisions up ≥ 20%)
 *   3. Rapid case volume spike  (≥ 2× average annual volume in last 12 months)
 *
 * Returns structured alerts to stdout and exits with code:
 *   0  — no drift detected
 *   1  — fatal error
 *   2  — drift detected (at least one alert)
 *
 * Usage:
 *   npx ts-node scripts/detect-drift.ts
 *   npx ts-node scripts/detect-drift.ts --act "Pakistan Penal Code"
 *   npx ts-node scripts/detect-drift.ts --min-cases 10   # skip acts with < N cases
 *
 * Required env vars (in .env.local):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 */

import path from "path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { validateEnvironment } from "../lib/utils/env-validator";
import { detectGatewayError } from "../lib/utils/network-errors";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

// Validate all required environment variables before any API client is created.
try {
  validateEnvironment();
} catch (err) {
  console.error("❌ ", err instanceof Error ? err.message : err);
  process.exit(1);
}

const SUPABASE_URL         = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("❌  Missing env vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Types ─────────────────────────────────────────────────────────────────────

export type DriftType =
  | "five_year_rate_drop"
  | "sc_unfavorable_surge"
  | "volume_spike";

export interface DriftAlert {
  type:           DriftType;
  act_name:       string;
  section_number: string;
  severity:       "warning" | "critical";
  detail:         string;
  /** Magnitude of the detected drift (e.g. delta in percentage points) */
  magnitude:      number;
  detected_at:    string; // ISO timestamp
}

// ── Thresholds ────────────────────────────────────────────────────────────────

const RATE_DROP_THRESHOLD     = 0.15;  // 15% absolute drop in success rate
const SC_SURGE_THRESHOLD      = 0.20;  // 20% increase in SC unfavorable share
const VOLUME_SPIKE_MULTIPLIER = 2.0;   // last-12-months volume ≥ 2× annual average

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseArgs(): Record<string, string> {
  const args   = process.argv.slice(2);
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
      result[key] = val;
    }
  }
  return result;
}

type CaseRow = {
  act_name:       string | null;
  section_number: string | null;
  authority_tier: string | null;
  outcome:        string | null;
  decision_year:  number | null;
  created_at:     string | null;
};

// ── Detection logic ───────────────────────────────────────────────────────────

function detectFiveYearRateDrop(
  rows:    CaseRow[],
  actName: string,
  section: string,
): DriftAlert | null {
  const currentYear = new Date().getFullYear();
  const cutoff      = currentYear - 5;

  const recent = rows.filter(
    (r) => r.decision_year != null && r.decision_year >= cutoff && r.outcome != null,
  );
  const prior  = rows.filter(
    (r) => r.decision_year != null && r.decision_year <  cutoff && r.outcome != null,
  );

  if (recent.length < 3 || prior.length < 3) return null; // insufficient data

  const recentRate = recent.filter((r) => r.outcome === "favorable").length / recent.length;
  const priorRate  = prior.filter((r)  => r.outcome === "favorable").length / prior.length;
  const drop       = priorRate - recentRate; // positive = rate fell

  if (drop < RATE_DROP_THRESHOLD) return null;

  return {
    type:           "five_year_rate_drop",
    act_name:       actName,
    section_number: section,
    severity:       drop >= 0.30 ? "critical" : "warning",
    detail:         `Success rate dropped ${(drop * 100).toFixed(1)}pp over last 5 years ` +
                    `(${(priorRate * 100).toFixed(1)}% → ${(recentRate * 100).toFixed(1)}%)`,
    magnitude:      Math.round(drop * 1000) / 1000,
    detected_at:    new Date().toISOString(),
  };
}

function detectScUnfavorableSurge(
  rows:    CaseRow[],
  actName: string,
  section: string,
): DriftAlert | null {
  const currentYear = new Date().getFullYear();
  const cutoff      = currentYear - 5;

  const scRows = rows.filter((r) => r.authority_tier === "supreme" && r.outcome != null);
  if (scRows.length < 3) return null;

  const recentSc = scRows.filter((r) => r.decision_year != null && r.decision_year >= cutoff);
  const priorSc  = scRows.filter((r) => r.decision_year != null && r.decision_year <  cutoff);

  if (recentSc.length < 2 || priorSc.length < 2) return null;

  const recentUnfavShare = recentSc.filter((r) => r.outcome === "unfavorable").length / recentSc.length;
  const priorUnfavShare  = priorSc.filter((r)  => r.outcome === "unfavorable").length / priorSc.length;
  const surge            = recentUnfavShare - priorUnfavShare;

  if (surge < SC_SURGE_THRESHOLD) return null;

  return {
    type:           "sc_unfavorable_surge",
    act_name:       actName,
    section_number: section,
    severity:       surge >= 0.40 ? "critical" : "warning",
    detail:         `SC unfavorable decisions surged by ${(surge * 100).toFixed(1)}pp over last 5 years ` +
                    `(${(priorUnfavShare * 100).toFixed(1)}% → ${(recentUnfavShare * 100).toFixed(1)}%)`,
    magnitude:      Math.round(surge * 1000) / 1000,
    detected_at:    new Date().toISOString(),
  };
}

function detectVolumeSpike(
  rows:    CaseRow[],
  actName: string,
  section: string,
): DriftAlert | null {
  const now    = new Date();
  const cutoff = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());

  const recentRows = rows.filter((r) => r.created_at && new Date(r.created_at) >= cutoff);
  const olderRows  = rows.filter((r) => r.created_at && new Date(r.created_at) <  cutoff);

  if (olderRows.length < 5) return null; // not enough history to establish baseline

  // Average annual volume from older rows
  const oldestDate = olderRows
    .map((r) => new Date(r.created_at!))
    .reduce((min, d) => d < min ? d : min, new Date());

  const yearsOfHistory = Math.max(
    (cutoff.getTime() - oldestDate.getTime()) / (365.25 * 24 * 3600 * 1000),
    1,
  );
  const annualAvg = olderRows.length / yearsOfHistory;
  const ratio     = annualAvg > 0 ? recentRows.length / annualAvg : 0;

  if (ratio < VOLUME_SPIKE_MULTIPLIER) return null;

  return {
    type:           "volume_spike",
    act_name:       actName,
    section_number: section,
    severity:       ratio >= 4 ? "critical" : "warning",
    detail:         `Case volume in last 12 months (${recentRows.length}) is ${ratio.toFixed(1)}× ` +
                    `the historical annual average (${annualAvg.toFixed(1)})`,
    magnitude:      Math.round(ratio * 10) / 10,
    detected_at:    new Date().toISOString(),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args      = parseArgs();
  const filterAct = args["act"] ?? null;
  const minCases  = parseInt(args["min-cases"] ?? "5", 10);

  console.log("🔍  Loading case data…");

  let query = supabase
    .from("legal_cases")
    .select("act_name, section_number, authority_tier, outcome, decision_year, created_at");

  if (filterAct) {
    query = query.eq("act_name", filterAct);
  }

  const { data, error } = await query;

  if (error) {
    const gateway = detectGatewayError(error.message);
    if (gateway) {
      console.error("❌  Query failed:", gateway.message);
    } else {
      console.error("❌  Query failed:", error.message);
    }
    process.exit(1);
  }

  const rows = (data ?? []) as CaseRow[];
  console.log(`    Loaded ${rows.length} cases.`);

  if (rows.length === 0) {
    console.log("ℹ️   No cases found. Exiting.");
    process.exit(0);
  }

  // Group by (act_name, section_number)
  const groups = new Map<string, CaseRow[]>();
  for (const row of rows) {
    if (!row.act_name || !row.section_number) continue;
    const key = `${row.act_name}|||${row.section_number}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  console.log(`    Analysing ${groups.size} (act, section) groups…\n`);

  const alerts: DriftAlert[] = [];

  for (const [key, groupRows] of groups) {
    if (groupRows.length < minCases) continue;

    const [actName, section] = key.split("|||");

    const a1 = detectFiveYearRateDrop(groupRows, actName, section);
    const a2 = detectScUnfavorableSurge(groupRows, actName, section);
    const a3 = detectVolumeSpike(groupRows, actName, section);

    if (a1) alerts.push(a1);
    if (a2) alerts.push(a2);
    if (a3) alerts.push(a3);
  }

  // ── Report ────────────────────────────────────────────────────────────────

  if (alerts.length === 0) {
    console.log("✅  No drift detected.");
    process.exit(0);
  }

  const critical = alerts.filter((a) => a.severity === "critical");
  const warnings = alerts.filter((a) => a.severity === "warning");

  console.log(`⚠️   Drift detected: ${critical.length} critical, ${warnings.length} warning(s)\n`);

  for (const alert of alerts) {
    const icon = alert.severity === "critical" ? "🔴" : "🟡";
    console.log(
      `${icon}  [${alert.type}] ${alert.act_name} § ${alert.section_number}\n` +
      `      ${alert.detail}\n` +
      `      magnitude: ${alert.magnitude}  |  detected_at: ${alert.detected_at}\n`,
    );
  }

  // Machine-readable JSON on stdout (last line for easy pipe/parse)
  console.log("JSON_OUTPUT:", JSON.stringify(alerts));

  process.exit(2); // exit 2 = drift found
}

main().catch((err) => {
  console.error("❌  Fatal:", err);
  process.exit(1);
});
