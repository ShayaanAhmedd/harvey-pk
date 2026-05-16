/**
 * CSV-driven Pakistan extractor.
 *
 * Reads a seed CSV (one row = one document to ingest), downloads the
 * PDF/HTML, validates format, invokes scripts/ingest-law.ts for ingestion.
 *
 * Resumable: skips rows already in the tracker.
 *
 * Usage:
 *   npx tsx scripts/extractors/csv-driven.ts
 *     --seed data/seeds/pakistan-federal.csv
 *     [--limit 50]
 *     [--concurrency 3]
 */

import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import pLimit from "p-limit";
import { downloadToFile, detectFormat } from "./shared/http";
import { isIngested, markIngested } from "./shared/tracker";
import { runIngestLaw } from "./shared/pipeline";

type SeedRow = {
  act_name: string;
  year: string;
  province: string;
  legal_doc_type: string;
  domain: string;
  source_url: string;
  pdf_url: string;
  notes: string;
};

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

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

async function main() {
  const args = parseArgs();
  const seedPath = args["seed"];
  if (!seedPath) {
    console.error("Usage: --seed <csv path> [--limit N] [--concurrency N]");
    process.exit(1);
  }

  const absSeed = path.resolve(process.cwd(), seedPath);
  if (!fs.existsSync(absSeed)) {
    console.error(`Seed file not found: ${absSeed}`);
    process.exit(1);
  }

  const limit = args["limit"] ? parseInt(args["limit"], 10) : Infinity;
  const concurrency = parseInt(args["concurrency"] ?? "3", 10);

  const csvText = fs.readFileSync(absSeed, "utf-8");
  const rows: SeedRow[] = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });
  const todo = rows.slice(0, Math.min(rows.length, limit));

  console.log("═".repeat(60));
  console.log("  CSV-Driven Pakistan Extractor");
  console.log("═".repeat(60));
  console.log(`  Seed:        ${absSeed}`);
  console.log(`  Rows:        ${rows.length} total, processing ${todo.length}`);
  console.log(`  Concurrency: ${concurrency}`);
  console.log("═".repeat(60));

  // IMPORTANT: ingest-law.ts inside spawns a child process. We must NOT run
  // multiple ingest-law children in parallel because they all write to the
  // same documents table without coordination. Concurrency here only
  // parallelizes DOWNLOADS, then ingestion runs serially.
  //
  // To do that: pre-download all files at concurrency N, then ingest one by one.

  const downloadLimit = pLimit(concurrency);
  let ok = 0, skip = 0, fail = 0;

  type DownloadResult =
    | { status: "skip"; row: SeedRow }
    | { status: "fail"; row: SeedRow }
    | { status: "downloaded"; row: SeedRow; localPath: string };

  // Phase 1: download all files in parallel (polite delays still apply inside politeFetch)
  console.log("\n[Phase 1/2] Downloading...");
  const downloads: Promise<DownloadResult>[] = todo.map((row, idx) => downloadLimit(async (): Promise<DownloadResult> => {
    if (!row.pdf_url) return { row, status: "skip" };
    if (isIngested(row.pdf_url)) {
      console.log(`  [${idx + 1}/${todo.length}] ↪ Already done: ${row.act_name}`);
      return { row, status: "skip" };
    }

    const provinceFolder = (row.province || "Federal").toLowerCase();
    const ext = row.pdf_url.toLowerCase().endsWith(".pdf") ? "pdf" : "html";
    const filename = `${row.year || "xxxx"}-${slug(row.act_name)}.${ext}`;
    const localPath = path.resolve(process.cwd(), "data", "raw", "pakistan", provinceFolder, filename);

    try {
      console.log(`  [${idx + 1}/${todo.length}] ⬇  ${row.act_name}`);
      await downloadToFile(row.pdf_url, localPath, { delayMs: 2500 });
      return { row, status: "downloaded", localPath };
    } catch (e) {
      console.error(`  [${idx + 1}/${todo.length}] ✗ Download failed: ${(e as Error).message}`);
      return { row, status: "fail" };
    }
  }));

  const downloadResults = await Promise.all(downloads);

  // Phase 2: ingest each downloaded file SERIALLY through ingest-law.ts
  console.log("\n[Phase 2/2] Ingesting...");
  let idx = 0;
  for (const result of downloadResults) {
    idx++;
    if (result.status === "skip") { skip++; continue; }
    if (result.status === "fail") { fail++; continue; }

    const { row, localPath } = result;
    const format = detectFormat(localPath);
    if (format === "unknown") {
      console.error(`  [${idx}/${todo.length}] ✗ Unknown format: ${row.act_name}`);
      fail++; continue;
    }

    try {
      console.log(`  [${idx}/${todo.length}] ⚙  Ingesting (${format}): act_name="${row.act_name}", year=${row.year}`);
      const ingest = await runIngestLaw({
        file: localPath,
        act: row.act_name,
        year: row.year ? parseInt(row.year, 10) : undefined,
        jurisdiction: "Pakistan",
        sourceUrl: row.source_url || row.pdf_url,
      });
      if (ingest.success) {
        markIngested({
          url: row.pdf_url,
          jurisdiction: "Pakistan",
          act_name: row.act_name,
          ingested_at: new Date().toISOString(),
          file_path: localPath,
        });
        ok++;
      } else {
        fail++;
      }
    } catch (e) {
      console.error(`  [${idx}/${todo.length}] ✗ Ingest error: ${(e as Error).message}`);
      fail++;
    }
  }

  console.log("\n" + "═".repeat(60));
  console.log(`  Done. ok=${ok}  skip=${skip}  fail=${fail}  total=${todo.length}`);
  console.log("═".repeat(60));
}

main().catch((e) => {
  console.error("\nFatal:", e);
  process.exit(1);
});
