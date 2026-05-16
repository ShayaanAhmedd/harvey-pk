/**
 * Re-ingest incomplete Pakistani federal Acts with a section-boundary chunker.
 *
 * Plan:
 *   1. Read data/audits/completeness.json (produced by audit-completeness.ts)
 *   2. For each row marked "incomplete":
 *      a. Resolve source_url → pdf_url from data/seeds/pakistan-federal.csv
 *      b. Download the PDF (cache-busting headers; skip on failure)
 *      c. Extract text via pdf-parse
 *      d. Re-chunk on section boundaries (NOT char count / page breaks)
 *      e. Embed each chunk via lib/embeddings.embedText
 *      f. INSERT new chunks (captures the start timestamp)
 *      g. DELETE old chunks for that Act with created_at < startTimestamp
 *         (INSERT-then-DELETE = no moment with zero rows for the Act)
 *      h. Update data/tracker.json
 *
 *   --dry-run prints the plan and chunk preview without touching Supabase.
 *
 * Hard rules (from spec):
 *   - Section-aware chunker, never char/page splits.
 *   - On download failure: log and skip, never delete existing chunks.
 *   - INSERT-then-DELETE order so the Act always has at least one usable row.
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { parse as parseCsv } from "csv-parse/sync";
import { createClient } from "@supabase/supabase-js";
import { embedText } from "@/lib/embeddings";
import { politeFetch } from "./shared/http";
import { markIngested } from "./shared/tracker";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE env vars in .env.local");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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

type AuditRow = {
  act_name:          string;
  chunks:            number;
  unique_sections:   number;
  expected_sections: number;
  coverage_pct:      number;
  sample_source_url: string | null;
  status:            "complete" | "incomplete" | "missing";
  expected_pattern:  string;
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

type SectionChunk = {
  section_number: string;
  content:        string;
  chunk_index:    number;
};

// ── Section-boundary chunker ────────────────────────────────────────────────
//
// Splits on lines that begin with `<digits>[<letter-suffix>]. ` — the
// canonical Pakistani statute section-header pattern. The captured group
// is the section_number ("1", "302", "302A", "302-A", "302-AA").
//
// Each chunk = section header + body, ending just before the next header.
// Tiny chunks (< 20 chars) are dropped to filter out spurious matches
// (page numbers, footnotes, list markers).

const SECTION_RE = /^[ \t]{0,8}(\d{1,4}(?:[A-Z]{1,2}|-[A-Z]{1,2})?)\.[ \t]+/gm;

function chunkBySections(text: string): SectionChunk[] {
  type Hit = { section: string; start: number };
  const hits: Hit[] = [];

  // Reset lastIndex defensively (regex is module-level with /g)
  SECTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SECTION_RE.exec(text)) !== null) {
    hits.push({ section: m[1], start: m.index });
  }

  const chunks: SectionChunk[] = [];
  for (let i = 0; i < hits.length; i++) {
    const startIdx = hits[i].start;
    const endIdx   = i + 1 < hits.length ? hits[i + 1].start : text.length;
    const content  = text.slice(startIdx, endIdx).trim();
    if (content.length < 20) continue;
    chunks.push({
      section_number: hits[i].section,
      content,
      chunk_index:    chunks.length,
    });
  }
  return chunks;
}

// ── PDF text extraction ─────────────────────────────────────────────────────

async function extractPdfText(buffer: Buffer): Promise<string> {
  // pdf-parse is loaded lazily (matches lib/ingest-law.ts pattern; avoids the
  // ENOENT-on-boot caused by its index.js test-fixture require).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse");
  const result = await pdfParse(buffer);
  return String(result?.text ?? "");
}

// ── Seed CSV loader ────────────────────────────────────────────────────────

function loadSeedRows(): SeedRow[] {
  const csvPath = path.resolve(process.cwd(), "data", "seeds", "pakistan-federal.csv");
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Seed CSV not found: ${csvPath} (run discover:pk:federal first)`);
  }
  const text = fs.readFileSync(csvPath, "utf-8");
  return parseCsv(text, { columns: true, skip_empty_lines: true, trim: true }) as SeedRow[];
}

function findSeedRow(seedRows: SeedRow[], act: AuditRow): SeedRow | null {
  // Try source_url first — it's the strongest match.
  if (act.sample_source_url) {
    const byUrl = seedRows.find((r) => r.source_url === act.sample_source_url);
    if (byUrl) return byUrl;
  }
  // Fall back to act_name substring match
  const needle = act.act_name.toLowerCase();
  const byName = seedRows.find((r) =>
    needle.includes(r.act_name.toLowerCase()) ||
    r.act_name.toLowerCase().includes(needle)
  );
  return byName ?? null;
}

// ── Re-ingest one Act ───────────────────────────────────────────────────────

type RowStatus = "ok" | "skip-nourl" | "skip-download" | "skip-empty" | "skip-tooFew" | "dryrun" | "fail-insert" | "fail-embed";

async function reingestOne(
  act:    AuditRow,
  seed:   SeedRow | null,
  dryRun: boolean,
): Promise<{ status: RowStatus; chunks?: number; detail?: string }> {
  if (!seed || !seed.pdf_url) {
    return { status: "skip-nourl", detail: "no seed row or no pdf_url" };
  }

  // ── 1. Download the PDF ────────────────────────────────────────────────
  let buffer: Buffer;
  try {
    const res = await politeFetch(seed.pdf_url, {
      delayMs:    2500,
      acceptType: "application/pdf,application/octet-stream",
    });
    buffer = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return { status: "skip-download", detail: (e as Error).message };
  }

  // ── 2. Extract text ────────────────────────────────────────────────────
  let text: string;
  try {
    text = await extractPdfText(buffer);
  } catch (e) {
    return { status: "skip-empty", detail: `pdf-parse failed: ${(e as Error).message}` };
  }
  if (!text || text.trim().length < 200) {
    return { status: "skip-empty", detail: `extracted text too short (${text?.length ?? 0} chars)` };
  }

  // ── 3. Chunk on section boundaries ─────────────────────────────────────
  const chunks = chunkBySections(text);
  if (chunks.length < 10) {
    return { status: "skip-tooFew", detail: `only ${chunks.length} section chunks found — likely a malformed PDF, skipping to preserve existing rows`, chunks: chunks.length };
  }

  // ── 4. Dry-run summary ─────────────────────────────────────────────────
  if (dryRun) {
    const preview = chunks.slice(0, 3).map((c) => `      §${c.section_number}: ${c.content.slice(0, 70).replace(/\s+/g, " ")}…`).join("\n");
    return {
      status: "dryrun",
      chunks: chunks.length,
      detail: `would re-ingest ${chunks.length} section chunks (was ${act.chunks}). Preview:\n${preview}`,
    };
  }

  // ── 5. Embed + INSERT (then DELETE old) ────────────────────────────────
  const year = seed.year ? parseInt(seed.year, 10) || null : null;
  const fileName = `${act.act_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}.pdf`;

  // INSERT all new chunks first. Pull the existing storage_path (if any) so
  // we don't lose the Storage reference; if there's none, leave null.
  const { data: priorRow } = await supabase
    .from("documents")
    .select("storage_path")
    .eq("scope", "global")
    .eq("act_name", act.act_name)
    .not("storage_path", "is", null)
    .limit(1)
    .maybeSingle();
  const storagePath: string | null = priorRow?.storage_path ?? null;

  // Capture the cutoff timestamp BEFORE any inserts. Old rows are everything
  // with created_at < this timestamp under the same act_name.
  const cutoffIso = new Date().toISOString();

  // Embed + insert in batches of 20 to keep payload size reasonable
  const BATCH_SIZE = 20;
  let inserted = 0;
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);

    let embeddings: number[][];
    try {
      embeddings = [];
      for (const c of batch) embeddings.push(await embedText(c.content));
    } catch (e) {
      return {
        status:  "fail-embed",
        detail:  `embedding failed at chunk ${i}: ${(e as Error).message}. NO rows deleted, existing data intact.`,
        chunks:  inserted,
      };
    }

    const rows = batch.map((c, j) => ({
      case_id:        null,
      file_name:      fileName,
      file_type:      "pdf",
      chunk_index:    c.chunk_index,
      content:        c.content,
      embedding:      embeddings[j],
      scope:          "global",
      storage_path:   storagePath,
      act_name:       act.act_name,
      title:          null,
      section_number: c.section_number,
      chapter:        null,
      year,
      jurisdiction:   "Pakistan",
      source_url:     seed.source_url || seed.pdf_url,
      province:       seed.province       || "Federal",
      legal_doc_type: seed.legal_doc_type || "Act",
      domain:         seed.domain         || "General",
    }));

    const { error } = await supabase.from("documents").insert(rows);
    if (error) {
      return {
        status:  "fail-insert",
        detail:  `insert failed at chunk ${i}: ${error.message}. NO rows deleted, existing data intact.`,
        chunks:  inserted,
      };
    }
    inserted += batch.length;
    process.stdout.write(`\r      inserted ${inserted}/${chunks.length}`);
  }
  console.log();

  // ── 6. DELETE old chunks (everything inserted before cutoffIso) ────────
  // Safe at this point: new chunks are already in place. If DELETE fails,
  // we have duplicates (recoverable) rather than missing rows (not recoverable).
  const { error: delError, count: deletedCount } = await supabase
    .from("documents")
    .delete({ count: "exact" })
    .eq("scope", "global")
    .eq("act_name", act.act_name)
    .lt("created_at", cutoffIso);
  if (delError) {
    return {
      status:  "ok",
      chunks:  inserted,
      detail:  `inserted ${inserted} new chunks but DELETE of old rows failed: ${delError.message}. Duplicates present — re-run will not re-delete (idempotent), please clean up manually.`,
    };
  }

  // ── 7. Mark tracker ────────────────────────────────────────────────────
  markIngested({
    url:          seed.pdf_url,
    jurisdiction: "Pakistan",
    act_name:     act.act_name,
    ingested_at:  new Date().toISOString(),
    file_path:    "(re-ingested in-place)",
  });

  return {
    status:  "ok",
    chunks:  inserted,
    detail:  `replaced ${deletedCount ?? "?"} old chunks with ${inserted} new section-aware chunks`,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args   = parseArgs();
  const dryRun = args["dry-run"] === "true";

  console.log("═".repeat(72));
  console.log(`  Re-ingest Incomplete Acts (Pakistan Federal)${dryRun ? "  [DRY-RUN]" : ""}`);
  console.log("═".repeat(72));

  const auditPath = path.resolve(process.cwd(), "data", "audits", "completeness.json");
  if (!fs.existsSync(auditPath)) {
    console.error(`Audit JSON not found: ${auditPath}`);
    console.error("Run: npm run audit:completeness first.");
    process.exit(1);
  }

  const audit: AuditRow[] = JSON.parse(fs.readFileSync(auditPath, "utf-8"));
  const incomplete = audit.filter((r) => r.status === "incomplete");

  console.log(`  Audit entries: ${audit.length}`);
  console.log(`  Incomplete:    ${incomplete.length}`);
  console.log(`  Dry-run:       ${dryRun}`);
  console.log("═".repeat(72));

  if (incomplete.length === 0) {
    console.log("\nNothing to do.");
    return;
  }

  const seedRows = loadSeedRows();
  let ok = 0, skipped = 0, failed = 0;

  for (let i = 0; i < incomplete.length; i++) {
    const act  = incomplete[i];
    const seed = findSeedRow(seedRows, act);
    console.log(`\n[${i + 1}/${incomplete.length}] ${act.act_name}`);
    console.log(`        coverage=${(act.coverage_pct * 100).toFixed(1)}%   chunks=${act.chunks}   expected=${act.expected_sections}`);
    if (!seed) {
      console.log(`        ⚠ no matching seed row, skipping`);
      skipped++;
      continue;
    }
    console.log(`        seed pdf_url=${seed.pdf_url.slice(0, 80)}`);

    const result = await reingestOne(act, seed, dryRun);
    switch (result.status) {
      case "ok":            ok++;      console.log(`        ✓ ${result.detail}`); break;
      case "dryrun":        ok++;      console.log(`        ✓ ${result.detail}`); break;
      case "skip-nourl":    skipped++; console.log(`        ↪ skip: ${result.detail}`); break;
      case "skip-download": skipped++; console.log(`        ↪ skip: download failed (${result.detail}) — existing chunks preserved`); break;
      case "skip-empty":    skipped++; console.log(`        ↪ skip: ${result.detail} — existing chunks preserved`); break;
      case "skip-tooFew":   skipped++; console.log(`        ↪ skip: ${result.detail} — existing chunks preserved`); break;
      case "fail-insert":   failed++;  console.log(`        ✗ ${result.detail}`); break;
      case "fail-embed":    failed++;  console.log(`        ✗ ${result.detail}`); break;
    }
  }

  console.log("\n" + "═".repeat(72));
  console.log(`  Done. ok=${ok}  skipped=${skipped}  failed=${failed}  total=${incomplete.length}`);
  console.log("═".repeat(72));
  if (!dryRun && ok > 0) {
    console.log("\nVerify: npm run audit:completeness  (coverage should now be ≥ 80% for re-ingested Acts)");
  }
}

main().catch((e) => {
  console.error("\nFatal:", e);
  process.exit(1);
});
