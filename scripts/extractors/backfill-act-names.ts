/**
 * Backfill correct act_name values for chunks that were ingested with
 * the truncation bug. Joins documents.source_url against the
 * pakistan-federal.csv to recover the full act_name.
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { parse } from "csv-parse/sync";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

type CsvRow = {
  act_name: string;
  year: string;
  province: string;
  legal_doc_type: string;
  domain: string;
  source_url: string;
  pdf_url: string;
  notes: string;
};

async function main() {
  const csvPath = path.resolve(process.cwd(), "data/seeds/pakistan-federal.csv");
  if (!fs.existsSync(csvPath)) {
    console.error("Seed CSV not found:", csvPath);
    process.exit(1);
  }

  const text = fs.readFileSync(csvPath, "utf-8");
  const rows: CsvRow[] = parse(text, { columns: true, skip_empty_lines: true, trim: true });
  console.log(`Loaded ${rows.length} rows from ${csvPath}`);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.source_url || !r.act_name) { skipped++; continue; }

    const { data: existing, error: selErr } = await supabase
      .from("documents")
      .select("id, act_name")
      .eq("source_url", r.source_url)
      .eq("scope", "global")
      .limit(1);

    if (selErr) { console.warn(`Select error for ${r.source_url}: ${selErr.message}`); failed++; continue; }
    if (!existing || existing.length === 0) { skipped++; continue; }

    // If existing act_name is already a long string (>40 chars), assume it's correct
    const currentName = existing[0].act_name ?? "";
    if (currentName.length >= 40) { skipped++; continue; }

    const { error: updErr } = await supabase
      .from("documents")
      .update({
        act_name: r.act_name,
        year: r.year ? parseInt(r.year, 10) : null,
        province: r.province || "Federal",
        legal_doc_type: r.legal_doc_type || "Act",
        domain: r.domain || "General",
      })
      .eq("source_url", r.source_url)
      .eq("scope", "global");

    if (updErr) {
      console.warn(`Update error: ${updErr.message}`);
      failed++;
      continue;
    }

    updated++;
    if (updated % 20 === 0) {
      process.stdout.write(`\r  Updated ${updated} acts, scanned ${i + 1}/${rows.length}`);
    }
  }

  console.log(`\n\nDone. Updated=${updated}, Skipped=${skipped}, Failed=${failed}`);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
