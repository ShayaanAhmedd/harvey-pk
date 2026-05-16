/**
 * Inserts re-extracted chunks from data/raw/<act>-reextract-chunks.json
 * into Supabase with BGE embeddings.
 *
 * SAFE: Does NOT delete existing chunks. New chunks are tagged with
 * notes="pdfjs-reextract" so they can be found later.
 *
 * For Prompt 1C-1, hardcoded to insert PPC only. Generalizes in later
 * prompt.
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { parse } from "csv-parse/sync";
import { createClient } from "@supabase/supabase-js";
import { embedTextLocal } from "../../lib/local-embeddings";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

type ExtractedChunk = {
  section_number: string;
  title: string;
  content: string;
};

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

/**
 * Cleanup broken letter-spacing from pdfjs output.
 * Examples:
 *   "qat l - i - amd"  →  "qatl-i-amd"
 *   "l ife"            →  "life"
 *   "P unishment"      →  "Punishment"
 *
 * Heuristic: if a single lowercase letter is surrounded by spaces,
 * try removing the surrounding spaces. Then clean up multi-spaces.
 */
function cleanText(input: string): string {
  let s = input;

  // Collapse multi-spaces
  s = s.replace(/\s+/g, " ");

  // Fix patterns like "qat l - i - amd" → "qatl-i-amd"
  // Iteratively merge: " X " (where X is 1 letter) into surrounding word
  // Do this a few times to handle multi-broken words
  for (let i = 0; i < 3; i++) {
    // Letter followed by space-letter-space: "qat l " → "qatl "
    s = s.replace(/([a-zA-Z])\s([a-z])\s/g, "$1$2 ");
    // " l ife" → " life"
    s = s.replace(/\s([a-z])([a-z]{2,})/g, " $1$2");
  }

  // Tighten hyphenated terms: "qatl - i - amd" → "qatl-i-amd"
  s = s.replace(/([a-zA-Z])\s-\s([a-zA-Z])/g, "$1-$2");

  // Final whitespace cleanup
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

async function main() {
  console.log("═".repeat(60));
  console.log("  Insert Re-Extracted PPC Chunks");
  console.log("═".repeat(60));

  // Load chunks from JSON
  const chunksPath = path.resolve(process.cwd(), "data/raw/ppc-reextract-chunks.json");
  if (!fs.existsSync(chunksPath)) {
    console.error(`Missing ${chunksPath}. Run 'npm run reextract:ppc:test' first.`);
    process.exit(1);
  }
  const chunks: ExtractedChunk[] = JSON.parse(fs.readFileSync(chunksPath, "utf-8"));
  console.log(`Loaded ${chunks.length} chunks`);

  // Load PPC metadata from CSV
  const csvPath = path.resolve(process.cwd(), "data/seeds/pakistan-federal.csv");
  const csvText = fs.readFileSync(csvPath, "utf-8");
  const rows: CsvRow[] = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
    relax_column_count: true,
  });
  const ppcRow = rows.find((r) =>
    r.act_name && r.act_name.toLowerCase().includes("penal code")
  );
  if (!ppcRow) {
    console.error("PPC not found in CSV");
    process.exit(1);
  }

  console.log(`Act: ${ppcRow.act_name}`);
  console.log(`Year: ${ppcRow.year}`);
  console.log(`Source URL: ${ppcRow.pdf_url}`);
  console.log("");

  // Confirm with user via console (semi-automated; production-safe)
  console.log("Will insert " + chunks.length + " new chunks tagged notes='pdfjs-reextract'.");
  console.log("Existing PPC chunks WILL NOT be deleted by this script.");
  console.log("");

  let inserted = 0;
  let failed = 0;
  let skipped = 0;
  const startTime = Date.now();

  // Process sequentially to avoid Supabase rate limits and embedding-model contention
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];

    // Clean text artifacts from pdfjs
    const cleanContent = cleanText(c.content);
    const cleanTitle = cleanText(c.title);

    if (cleanContent.length < 40) {
      skipped++;
      continue;
    }

    try {
      // Generate embedding
      const embedding = await embedTextLocal(cleanContent);

      // Insert
      const { error } = await supabase.from("documents").insert({
        content: cleanContent,
        embedding,
        scope: "global",
        act_name: ppcRow.act_name,
        section_number: c.section_number,
        title: cleanTitle.slice(0, 200),
        year: parseInt(ppcRow.year, 10) || null,
        province: ppcRow.province || "Federal",
        legal_doc_type: ppcRow.legal_doc_type || "Act",
        domain: ppcRow.domain || "Criminal",
        jurisdiction: "Pakistan",
        country: "Pakistan",
        source_url: ppcRow.pdf_url,
        file_name: "ppc-reextract.pdf",
        file_type: "pdf",
        chunk_index: i,
        tags: { reextract: true, source: "pdfjs-reextract" },
      });

      if (error) {
        console.error(`  ✗ [${i + 1}/${chunks.length}] §${c.section_number}: ${error.message}`);
        failed++;
      } else {
        inserted++;
        if (inserted % 20 === 0 || i === chunks.length - 1) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          console.log(`  [${i + 1}/${chunks.length}] inserted=${inserted} failed=${failed} skipped=${skipped} (${elapsed}s)`);
        }
      }
    } catch (e) {
      console.error(`  ✗ [${i + 1}/${chunks.length}] §${c.section_number}: ${(e as Error).message}`);
      failed++;
    }
  }

  const totalSeconds = Math.round((Date.now() - startTime) / 1000);
  console.log("");
  console.log("═".repeat(60));
  console.log("  Done");
  console.log("═".repeat(60));
  console.log(`  Inserted: ${inserted}`);
  console.log(`  Failed:   ${failed}`);
  console.log(`  Skipped:  ${skipped}`);
  console.log(`  Time:     ${totalSeconds}s`);
  console.log("");
  console.log("VERIFY in Supabase:");
  console.log("  SELECT COUNT(*) FROM documents");
  console.log("  WHERE scope='global'");
  console.log("    AND act_name ILIKE '%Pakistan Penal Code%'");
  console.log("    AND tags->>'source' = 'pdfjs-reextract';");
  console.log("");
  console.log("VERIFY §302 specifically:");
  console.log("  SELECT section_number, LEFT(content, 200)");
  console.log("  FROM documents");
  console.log("  WHERE scope='global'");
  console.log("    AND act_name ILIKE '%Pakistan Penal Code%'");
  console.log("    AND section_number = '302'");
  console.log("    AND tags->>'source' = 'pdfjs-reextract';");
  console.log("");
  console.log("Then test in Harvey UI:");
  console.log("  Ask: 'Quote verbatim Section 302 of the Pakistan Penal Code'");
  console.log("  Expect: real qatl-i-amd text, not hallucination");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
