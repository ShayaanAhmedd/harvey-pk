/**
 * Backfills section_number metadata for existing chunks by parsing
 * the section header from chunk content.
 *
 * Targets chunks where:
 *   - scope = 'global'
 *   - act_name matches one of the partial Acts from completeness.json
 *   - section_number IS NULL or is generic
 *
 * SAFE: Does NOT delete chunks. Does NOT modify content or embeddings.
 * Only writes section_number column.
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

type CompletenessReport = Array<{
  label: string;
  pattern: string;
  actual_act_name: string | null;
  status: "complete" | "partial" | "missing";
}>;

/**
 * Extracts a section number from the START of a content chunk.
 * Common Pakistani statute formats:
 *   "302. Punishment for murder ..."         → "302"
 *   "489-F. Dishonor of cheque ..."          → "489-F"
 *   "489F. Dishonor ..."                     → "489F"
 *   "Section 302. ..."                       → "302"
 *   "§ 302. ..."                             → "302"
 *   "(1) Whoever ..." (subsection only)      → null
 *   "Article 199. ..."                       → "Article 199" (for Constitution)
 *
 * Returns null if no section header detected.
 */
function extractSectionNumber(content: string, isConstitution: boolean): string | null {
  if (!content) return null;
  const trimmed = content.trim();

  // Constitution uses "Article N"
  if (isConstitution) {
    const artMatch = trimmed.match(/^Article\s+(\d+[A-Z]?)/i);
    if (artMatch) return artMatch[1].toUpperCase();
  }

  // Standard section header: "302.", "489-F.", "489F."
  const stdMatch = trimmed.match(/^(\d+[A-Z]?(?:-[A-Z]{1,2})?)\.\s+/);
  if (stdMatch) return stdMatch[1].toUpperCase();

  // "Section 302" or "Sec. 302" or "§ 302"
  const labeled = trimmed.match(/^(?:Section|Sec\.?|§)\s*(\d+[A-Z]?(?:-[A-Z]{1,2})?)\b/i);
  if (labeled) return labeled[1].toUpperCase();

  return null;
}

type BackfillResult = {
  label: string;
  pattern: string;
  chunks_scanned: number;
  chunks_updated: number;
  chunks_skipped_no_match: number;
  chunks_skipped_already_set: number;
  unique_sections_extracted: number;
  failed: number;
};

async function backfillAct(label: string, pattern: string, dryRun: boolean): Promise<BackfillResult> {
  const isConstitution = /constitution/i.test(label);
  const result: BackfillResult = {
    label, pattern,
    chunks_scanned: 0, chunks_updated: 0,
    chunks_skipped_no_match: 0, chunks_skipped_already_set: 0,
    unique_sections_extracted: 0, failed: 0,
  };

  // Page through chunks for this Act in batches
  const PAGE_SIZE = 500;
  let from = 0;
  const sectionsFound = new Set<string>();

  while (true) {
    const { data, error } = await supabase
      .from("documents")
      .select("id, content, section_number")
      .eq("scope", "global")
      .ilike("act_name", `%${pattern}%`)
      .order("id")
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      console.error(`  ✗ Page error for ${label}: ${error.message}`);
      result.failed += 1;
      break;
    }
    if (!data || data.length === 0) break;

    for (const row of data) {
      result.chunks_scanned += 1;
      const current = row.section_number;

      // Skip if already has a real-looking section number
      if (current && /^\d+[A-Z]?(?:-[A-Z]{1,2})?$/i.test(String(current).trim())) {
        result.chunks_skipped_already_set += 1;
        sectionsFound.add(String(current).trim().toUpperCase());
        continue;
      }

      const extracted = extractSectionNumber(row.content ?? "", isConstitution);
      if (!extracted) {
        result.chunks_skipped_no_match += 1;
        continue;
      }

      sectionsFound.add(extracted);

      if (dryRun) {
        result.chunks_updated += 1;
        continue;
      }

      const { error: updErr } = await supabase
        .from("documents")
        .update({ section_number: extracted })
        .eq("id", row.id);

      if (updErr) {
        console.warn(`    ⚠ Update failed for id ${row.id}: ${updErr.message}`);
        result.failed += 1;
      } else {
        result.chunks_updated += 1;
      }
    }

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  result.unique_sections_extracted = sectionsFound.size;
  return result;
}

function parseArgs(): { dryRun: boolean } {
  const args = process.argv.slice(2);
  return { dryRun: args.includes("--dry-run") };
}

async function main() {
  const { dryRun } = parseArgs();

  const reportPath = path.resolve(process.cwd(), "data/audits/completeness.json");
  if (!fs.existsSync(reportPath)) {
    console.error(`Audit report missing: ${reportPath}`);
    console.error("Run 'npm run audit:completeness' first.");
    process.exit(1);
  }

  const report: CompletenessReport = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
  const partial = report.filter((r) => r.status === "partial");

  console.log("═".repeat(60));
  console.log(`  Section Number Backfill ${dryRun ? "(DRY RUN)" : ""}`);
  console.log("═".repeat(60));
  console.log(`  Targeting ${partial.length} partial Acts`);
  if (dryRun) console.log(`  DRY RUN — no UPDATEs will be sent to Supabase`);
  console.log("");

  const results: BackfillResult[] = [];
  for (const r of partial) {
    console.log(`  Backfilling ${r.label}...`);
    const res = await backfillAct(r.label, r.pattern, dryRun);
    results.push(res);
    const sym = res.failed > 0 ? "⚠" : "✓";
    console.log(`    ${sym} scanned=${res.chunks_scanned} updated=${res.chunks_updated} skipped_no_match=${res.chunks_skipped_no_match} skipped_existing=${res.chunks_skipped_already_set} unique_sections=${res.unique_sections_extracted}`);
  }

  console.log("");
  console.log("═".repeat(60));
  console.log("  Summary");
  console.log("═".repeat(60));

  const totalUpdated = results.reduce((a, r) => a + r.chunks_updated, 0);
  const totalScanned = results.reduce((a, r) => a + r.chunks_scanned, 0);
  const totalFailed = results.reduce((a, r) => a + r.failed, 0);

  console.log(`  Acts processed:  ${results.length}`);
  console.log(`  Chunks scanned:  ${totalScanned}`);
  console.log(`  Chunks updated:  ${totalUpdated} ${dryRun ? "(would be updated)" : ""}`);
  console.log(`  Failures:        ${totalFailed}`);
  console.log("");
  console.log(`  Next step: re-run 'npm run audit:completeness' to confirm improved coverage.`);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
