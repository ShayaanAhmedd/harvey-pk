/**
 * check-system-health.ts — Startup Diagnostics Script
 *
 * Validates:
 *   1. Required environment variables
 *   2. Supabase connectivity + auth
 *   3. OpenAI embedding API key
 *   4. Required database tables: legal_cases, precedent_nodes, precedent_edges
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed
 *
 * Usage:
 *   npx ts-node scripts/check-system-health.ts
 */

import path from "path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { validateEnvironment } from "../lib/utils/env-validator";
import { detectGatewayError, formatError } from "../lib/utils/network-errors";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

// ── Check result helpers ──────────────────────────────────────────────────────

interface CheckResult {
  label:   string;
  ok:      boolean;
  detail?: string;
}

function pass(label: string, detail?: string): CheckResult {
  return { label, ok: true, detail };
}

function fail(label: string, detail: string): CheckResult {
  return { label, ok: false, detail };
}

function printResult(r: CheckResult): void {
  const icon = r.ok ? "✓" : "✗";
  const line = `  ${icon}  ${r.label}`;
  console.log(r.detail ? `${line} — ${r.detail}` : line);
}

// ── Checks ────────────────────────────────────────────────────────────────────

async function checkEnvironment(): Promise<CheckResult> {
  try {
    const env = validateEnvironment();
    const extras: string[] = [];
    if (!env.anthropicApiKey) extras.push("ANTHROPIC_API_KEY missing (Claude calls will fail)");
    const detail = extras.length > 0 ? extras.join("; ") : undefined;
    return pass("Environment variables OK", detail);
  } catch (err) {
    return fail("Environment variables", formatError(err));
  }
}

async function checkSupabase(url: string, key: string): Promise<CheckResult> {
  try {
    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { error } = await client.from("legal_cases").select("id").limit(0);

    if (error) {
      const msg = error.message ?? String(error);
      const lower = msg.toLowerCase();
      if (
        lower.includes("jwt") ||
        lower.includes("unauthorized") ||
        lower.includes("invalid signature")
      ) {
        return fail("Supabase connection", `Auth failure — ${msg}`);
      }
      // Table not found is acceptable here (schema may be uninitialised)
      if (error.code === "42P01" || error.code === "PGRST116") {
        return pass("Supabase connection OK", "legal_cases table not yet created");
      }
      const gw = detectGatewayError(error);
      if (gw) return fail("Supabase connection", gw.message);
      return fail("Supabase connection", msg);
    }

    return pass("Supabase connection OK");
  } catch (err) {
    const gw = detectGatewayError(err);
    if (gw) return fail("Supabase connection", gw.message);
    return fail("Supabase connection", formatError(err));
  }
}

async function checkOpenAI(apiKey: string): Promise<CheckResult> {
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      method:  "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal:  AbortSignal.timeout(10_000),
    });

    if (res.status === 401) {
      return fail("OpenAI API key", "Invalid API key (401 Unauthorized)");
    }
    if (res.status === 429) {
      return pass("OpenAI API key OK", "Rate limited — key is valid");
    }
    if (!res.ok) {
      const gw = detectGatewayError(`${res.status}`);
      if (gw) return fail("OpenAI API key", gw.message);
      return fail("OpenAI API key", `HTTP ${res.status}`);
    }

    return pass("OpenAI (embedding) API key OK");
  } catch (err) {
    const gw = detectGatewayError(err);
    if (gw) return fail("OpenAI API key", gw.message);
    return fail("OpenAI API key", formatError(err));
  }
}

const REQUIRED_TABLES = ["legal_cases", "precedent_nodes", "precedent_edges"] as const;

async function checkDatabaseSchema(
  url:  string,
  key:  string,
): Promise<CheckResult> {
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const missing: string[] = [];

  for (const table of REQUIRED_TABLES) {
    try {
      const { error } = await client.from(table).select("id").limit(0);
      if (error) {
        if (error.code === "42P01" || error.code === "PGRST116") {
          missing.push(table);
        }
        // Auth errors are already caught in checkSupabase — ignore here
      }
    } catch {
      missing.push(table);
    }
  }

  if (missing.length > 0) {
    return fail(
      "Database schema",
      `Missing tables: ${missing.join(", ")}. Run migrations.`,
    );
  }

  return pass(`Database schema OK`, `Tables verified: ${REQUIRED_TABLES.join(", ")}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n══════════════════════════════════════════");
  console.log("  Harvey PK — System Health Check");
  console.log("══════════════════════════════════════════\n");

  const results: CheckResult[] = [];

  // 1. Environment variables (must pass before we can read the keys)
  const envResult = await checkEnvironment();
  results.push(envResult);
  printResult(envResult);

  if (!envResult.ok) {
    console.log("\n  Cannot proceed without valid environment — aborting.\n");
    process.exit(1);
  }

  // Re-read the validated env for the remaining checks
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
  const supabaseKey =
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const openaiKey = process.env.OPENAI_API_KEY || "";

  // 2. Supabase connection + auth
  const supabaseResult = await checkSupabase(supabaseUrl, supabaseKey);
  results.push(supabaseResult);
  printResult(supabaseResult);

  // 3. OpenAI API key validity
  const openaiResult = await checkOpenAI(openaiKey);
  results.push(openaiResult);
  printResult(openaiResult);

  // 4. Database schema (only if Supabase auth passed)
  const schemaResult = supabaseResult.ok
    ? await checkDatabaseSchema(supabaseUrl, supabaseKey)
    : fail("Database schema", "Skipped — Supabase connection failed");
  results.push(schemaResult);
  printResult(schemaResult);

  // ── Summary ──────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log("");

  if (failed.length === 0) {
    console.log("  All checks passed. System is ready.\n");
    process.exit(0);
  } else {
    console.log(`  ${failed.length} check(s) failed:\n`);
    for (const r of failed) {
      console.log(`    ✗  ${r.label}: ${r.detail ?? "unknown error"}`);
    }
    console.log("");
    process.exit(1);
  }
}

main().catch((err) => {
  const gw = detectGatewayError(err);
  if (gw) {
    console.error(`\n  ✗  Fatal: ${gw.message}`);
  } else {
    console.error(`\n  ✗  Fatal: ${formatError(err)}`);
  }
  process.exit(1);
});
