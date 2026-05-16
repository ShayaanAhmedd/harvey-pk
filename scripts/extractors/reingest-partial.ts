/**
 * Re-ingests Acts marked "partial" in data/audits/completeness.json using
 * the new section-boundary chunker (ingest-law.ts --reingest mode).
 *
 * Strategy:
 *   1. Load data/audits/completeness.json
 *   2. Filter status === "partial"
 *   3. For each Act: find the seed-CSV row by source_url (match
 *      sample_source_url), download the PDF
 *   4. Spawn ingest-law.ts with --reingest --source-url <url>
 *      ingest-law.ts is responsible for: section-boundary chunking,
 *      fallback to default chunker if <10 matches, INSERT-then-DELETE
 *      on the same source_url.
 *   5. Mark tracker on success.
 *
 * Sequential — never parallel — to avoid concurrent rewrites of the same
 * source_url.
 *
 * Usage:
 *   npx tsx scripts/extractors/reingest-partial.ts            # do the work
 *   npx tsx scripts/extractors/reingest-partial.ts --dry-run  # preview only
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { parse as parseCsv } from "csv-parse/sync";
import { downloadToFile } from "./shared/http";
import { markIngested } from "./shared/tracker";

// ── Args ────────────────────────────────────────────────────────────────────

function parseArgs(): Record<string, string> {
  const a = process.argv.slice(2);
  const o: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith("--")) {
      const k = a[i].slice(2);
      const v = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : "true";
      o[k] = v;
    }
  }
  return o;
}

// ── Types ───────────────────────────────────────────────────────────────────

type ActReport = {
  label: string;
  pattern: string;
  actual_act_name: string | null;
  chunks: number;
  unique_sections: number;
  expected_sections: number;
  coverage_pct: number;
  sample_source_url: string | null;
  status: "complete" | "partial" | "missing";
};

type SeedRow = {
  act_name:       string;
  year:           string;
  province:       string;
  legal_doc_type: string;
  domain:         string;
  source_url:     string;
  pdf_url:        string;
  notes:          string;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function findSeedRow(seedRows: SeedRow[], report: ActReport): SeedRow | null {
  // Primary key: source_url match (the audit took the first source_url it saw).
  if (report.sample_source_url) {
    const byUrl = seedRows.find((r) => r.source_url === report.sample_source_url);
    if (byUrl) return byUrl;
  }
  // Fallback: substring match on act_name vs CSV act_name.
  if (report.actual_act_name) {
    const needle = report.actual_act_name.toLowerCase();
    const byName = seedRows.find((r) =>
      needle.includes(r.act_name.toLowerCase()) ||
      r.act_name.toLowerCase().includes(needle)
    );
    if (byName) return byName;
  }
  // Last resort: pattern substring on CSV act_name.
  const pat = report.pattern.toLowerCase();
  return seedRows.find((r) => r.act_name.toLowerCase().includes(pat)) ?? null;
}

async function runIngestLawReingest(params: {
  file:         string;
  act:          string;
  year?:        number;
  jurisdiction: string;
  sourceUrl:    string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const tsxPath = path.resolve(
      process.cwd(), "node_modules", ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx",
    );
    const scriptPath = path.resolve(process.cwd(), "scripts", "ingest-law.ts");

    const args = [
      scriptPath,
      "--file",         params.file,
      "--act",          params.act,
      "--jurisdiction", params.jurisdiction,
      "--source-url",   params.sourceUrl,
      "--reingest",
    ];
    if (params.year) args.push("--year", String(params.year));

    const child = spawn(tsxPath, args, {
      cwd:   process.cwd(),
      shell: false,
      env:   { ...process.env },
      windowsVerbatimArguments: false,
    });
    child.stdout.on("data", (c) => process.stdout.write(c));
    child.stderr.on("data", (c) => process.stderr.write(c));
    child.on("close", (code) => resolve(code === 0));
    child.on("error", (err) => {
      console.error(`Spawn error: ${err.message}`);
      resolve(false);
    });
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args   = parseArgs();
  const dryRun = args["dry-run"] === "true";

  console.log("═".repeat(72));
  console.log(`  Re-ingest Partial Acts (Pakistan Federal)${dryRun ? "  [DRY-RUN]" : ""}`);
  console.log("═".repeat(72));

  const auditPath = path.resolve(process.cwd(), "data", "audits", "completeness.json");
  if (!fs.existsSync(auditPath)) {
    console.error(`Audit JSON not found: ${auditPath}`);
    console.error("Run: npm run audit:completeness first.");
    process.exit(1);
  }

  const audit: ActReport[] = JSON.parse(fs.readFileSync(auditPath, "utf-8"));
  const partial = audit.filter((r) => r.status === "partial");

  console.log(`  Audit entries: ${audit.length}`);
  console.log(`  Partial:       ${partial.length}`);
  console.log(`  Dry-run:       ${dryRun}`);
  console.log("═".repeat(72));

  if (partial.length === 0) {
    console.log("\nNothing to do.");
    return;
  }

  const seedPath = path.resolve(process.cwd(), "data", "seeds", "pakistan-federal.csv");
  if (!fs.existsSync(seedPath)) {
    console.error(`Seed CSV not found: ${seedPath} (run discover:pk:federal first)`);
    process.exit(1);
  }
  const seedRows: SeedRow[] = parseCsv(fs.readFileSync(seedPath, "utf-8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  let ok = 0, skipped = 0, failed = 0;

  // ── Sequential processing — never concurrent for same source_url ────────
  for (let i = 0; i < partial.length; i++) {
    const r    = partial[i];
    const seed = findSeedRow(seedRows, r);
    const label = r.actual_act_name ?? r.label;
    console.log(`\n[${i + 1}/${partial.length}] ${label}`);
    console.log(`        coverage=${r.coverage_pct}%   chunks=${r.chunks}   expected_sections=${r.expected_sections}`);

    if (!seed) {
      console.log(`        ↪ skip: no matching seed row for source_url=${r.sample_source_url ?? "(none)"}`);
      skipped++;
      continue;
    }
    if (!seed.pdf_url) {
      console.log(`        ↪ skip: seed row has no pdf_url`);
      skipped++;
      continue;
    }
    console.log(`        seed pdf_url=${seed.pdf_url.slice(0, 80)}`);

    if (dryRun) {
      console.log(`        ✓ would re-ingest via ingest-law.ts --reingest --source-url ${seed.source_url || seed.pdf_url}`);
      ok++;
      continue;
    }

    // Download the PDF first (same pattern as csv-driven.ts)
    const filename  = `${seed.year || "xxxx"}-${slug(seed.act_name)}.pdf`;
    const localPath = path.resolve(process.cwd(), "data", "raw", "pakistan", "federal", filename);
    try {
      console.log(`        ⬇  downloading...`);
      await downloadToFile(seed.pdf_url, localPath, { delayMs: 2500 });
    } catch (e) {
      console.log(`        ↪ skip: download failed (${(e as Error).message}) — existing chunks preserved`);
      skipped++;
      continue;
    }

    // Spawn ingest-law.ts --reingest
    console.log(`        ⚙  spawning ingest-law.ts --reingest...`);
    const success = await runIngestLawReingest({
      file:         localPath,
      act:          seed.act_name,
      year:         seed.year ? parseInt(seed.year, 10) || undefined : undefined,
      jurisdiction: "Pakistan",
      sourceUrl:    seed.source_url || seed.pdf_url,
    });

    if (success) {
      markIngested({
        url:          seed.pdf_url,
        jurisdiction: "Pakistan",
        act_name:     seed.act_name,
        ingested_at:  new Date().toISOString(),
        file_path:    localPath,
      });
      console.log(`        ✓ re-ingest succeeded`);
      ok++;
    } else {
      console.log(`        ✗ re-ingest FAILED — existing chunks preserved (ingest-law.ts only deletes after successful insert)`);
      failed++;
    }
  }

  console.log("\n" + "═".repeat(72));
  console.log(`  Done. ok=${ok}  skipped=${skipped}  failed=${failed}  total=${partial.length}`);
  console.log("═".repeat(72));
  if (!dryRun && ok > 0) {
    console.log("\nVerify: npm run audit:completeness   (coverage should now be ≥ 85% for re-ingested Acts)");
  }
}

main().catch((e) => {
  console.error("\nFatal:", e);
  process.exit(1);
});
