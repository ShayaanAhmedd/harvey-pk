/**
 * Verify what has been extracted into the documents table.
 *
 * Reports:
 *   - Local tracker count (what the extractor THINKS it ingested)
 *   - Supabase row count (what actually landed in the documents table)
 *   - Per-Act chunk counts, top 20 by size
 *
 * Usage:
 *   npx tsx scripts/extractors/verify.ts
 *     [--jurisdiction Pakistan|UK|all]
 *     [--province Federal|Punjab|...]
 */

import path from "path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { listIngested } from "./shared/tracker";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE env vars in .env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function parseArgs(): Record<string, string> {
  const args = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const k = args[i].slice(2);
      const v = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
      out[k] = v;
    }
  }
  return out;
}

async function fetchAll<T>(query: any): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function main() {
  const args = parseArgs();
  const jurisdiction = args["jurisdiction"] ?? "all";
  const province = args["province"];

  console.log("═".repeat(60));
  console.log("  Extractor Verification");
  console.log("═".repeat(60));
  console.log(`  Jurisdiction filter: ${jurisdiction}`);
  if (province) console.log(`  Province filter:     ${province}`);
  console.log("═".repeat(60));

  // ── Local tracker ────────────────────────────────────────────
  const tracked = listIngested(jurisdiction === "all" ? undefined : jurisdiction);
  console.log(`\n[Tracker]  ${tracked.length} URLs marked as ingested locally.`);
  if (tracked.length > 0 && tracked.length <= 10) {
    for (const t of tracked) {
      console.log(`    - ${t.act_name}`);
    }
  }

  // ── Supabase totals ──────────────────────────────────────────
  console.log("\n[Supabase] Querying documents table...");

  let query = supabase
    .from("documents")
    .select("act_name, jurisdiction, province, year, scope, embedding")
    .eq("scope", "global");

  if (jurisdiction !== "all") {
    query = query.eq("jurisdiction", jurisdiction);
  }
  if (province) {
    query = query.eq("province", province);
  }

  const rows = await fetchAll<{
    act_name: string | null;
    jurisdiction: string | null;
    province: string | null;
    year: number | null;
    scope: string | null;
    embedding: unknown;
  }>(query);

  const total = rows.length;
  const withEmbedding = rows.filter((r) => r.embedding !== null).length;
  const withoutEmbedding = total - withEmbedding;

  console.log(`           Total chunks (scope=global): ${total}`);
  console.log(`           With embedding:              ${withEmbedding}`);
  console.log(`           Without embedding (NULL):    ${withoutEmbedding}`);

  // ── Per-Act breakdown ────────────────────────────────────────
  const byAct = new Map<string, { chunks: number; year: number | null; province: string | null }>();
  for (const r of rows) {
    const key = r.act_name ?? "(unknown)";
    const cur = byAct.get(key) ?? { chunks: 0, year: r.year, province: r.province };
    cur.chunks++;
    byAct.set(key, cur);
  }

  const acts = Array.from(byAct.entries()).sort((a, b) => b[1].chunks - a[1].chunks);

  console.log(`\n           Unique Acts:                 ${acts.length}`);
  console.log(`\n[Top 20 Acts by chunk count]`);
  console.log("  chunks  year  province     act_name");
  console.log("  ------  ----  -----------  --------");
  for (const [name, info] of acts.slice(0, 20)) {
    const c = String(info.chunks).padStart(6);
    const y = String(info.year ?? "-").padStart(4);
    const p = (info.province ?? "-").padEnd(11).slice(0, 11);
    console.log(`  ${c}  ${y}  ${p}  ${name}`);
  }

  // ── Jurisdiction breakdown if 'all' ──────────────────────────
  if (jurisdiction === "all") {
    const byJ = new Map<string, number>();
    for (const r of rows) {
      const k = r.jurisdiction ?? "(null)";
      byJ.set(k, (byJ.get(k) ?? 0) + 1);
    }
    console.log("\n[Chunks by jurisdiction]");
    for (const [j, n] of Array.from(byJ.entries()).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${j.padEnd(20)} ${n}`);
    }
  }

  console.log("\n" + "═".repeat(60));
  console.log("  Done.");
  console.log("═".repeat(60));
}

main().catch((e) => {
  console.error("\nFatal:", e);
  process.exit(1);
});
