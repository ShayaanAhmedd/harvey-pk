/**
 * Audits each ingested Pakistani Act for section coverage completeness.
 * Compares actual chunk/section counts in Supabase against expected
 * ground-truth values for well-known Acts.
 * Writes report to data/audits/completeness.json.
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

// Conservative estimates of expected sections per Act
const EXPECTED: Array<{ pattern: string; expected: number; label: string }> = [
  { pattern: "Pakistan Penal Code", expected: 511, label: "PPC 1860" },
  { pattern: "Code of Criminal Procedure", expected: 565, label: "CrPC 1898" },
  { pattern: "Code of Civil Procedure", expected: 158, label: "CPC 1908" },
  { pattern: "Constitution of", expected: 280, label: "Constitution 1973" },
  { pattern: "Contract Act", expected: 238, label: "Contract Act 1872" },
  { pattern: "Companies Act, 2017", expected: 515, label: "Companies Act 2017" },
  { pattern: "Companies Ordinance, 1984", expected: 510, label: "Companies Ord 1984" },
  { pattern: "Income Tax Ordinance, 2001", expected: 240, label: "ITO 2001" },
  { pattern: "Specific Relief Act", expected: 57, label: "SRA 1877" },
  { pattern: "Sale of Goods Act", expected: 66, label: "SGA 1930" },
  { pattern: "Limitation Act", expected: 32, label: "Limitation 1908" },
  { pattern: "Transfer of Property Act", expected: 137, label: "TPA 1882" },
  { pattern: "Qanun-e-Shahadat", expected: 166, label: "QSO 1984" },
  { pattern: "Anti-Terrorism Act", expected: 39, label: "ATA 1997" },
  { pattern: "Prevention of Electronic Crimes Act", expected: 51, label: "PECA 2016" },
  { pattern: "Family Courts Act", expected: 25, label: "Family Courts" },
  { pattern: "Muslim Family Laws Ordinance", expected: 17, label: "MFLO 1961" },
  { pattern: "Dissolution of Muslim Marriages Act", expected: 6, label: "DMMA 1939" },
  { pattern: "Customs Act, 1969", expected: 224, label: "Customs 1969" },
  { pattern: "Sales Tax Act, 1990", expected: 76, label: "Sales Tax 1990" },
  { pattern: "Federal Excise Act", expected: 49, label: "Federal Excise" },
  { pattern: "Negotiable Instruments Act", expected: 138, label: "NIA 1881" },
  { pattern: "Partnership Act", expected: 73, label: "Partnership 1932" },
  { pattern: "Arbitration Act, 1940", expected: 50, label: "Arbitration 1940" },
  { pattern: "Securities Act, 2015", expected: 169, label: "Securities 2015" },
  { pattern: "Elections Act, 2017", expected: 241, label: "Elections 2017" },
];

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

async function main() {
  console.log("═".repeat(60));
  console.log("  Pakistani Federal Acts — Completeness Audit");
  console.log("═".repeat(60));

  const report: ActReport[] = [];

  for (const e of EXPECTED) {
    const { data, error } = await supabase
      .from("documents")
      .select("act_name, section_number, source_url")
      .eq("scope", "global")
      .ilike("act_name", `%${e.pattern}%`)
      .limit(2000);

    if (error) {
      console.error(`  ✗ ${e.label}: ${error.message}`);
      continue;
    }

    const chunks = data?.length ?? 0;
    const sections = new Set(
      (data ?? [])
        .map((r) => r.section_number)
        .filter((s) => s !== null && s !== undefined && s !== "")
    );
    const actNames = new Set((data ?? []).map((r) => r.act_name));
    const sourceUrl = (data ?? [])[0]?.source_url ?? null;
    const actName = actNames.size > 0 ? [...actNames][0] : null;

    const coverage = e.expected > 0 ? sections.size / e.expected : 0;
    const status: ActReport["status"] =
      chunks === 0 ? "missing" : coverage >= 0.85 ? "complete" : "partial";

    report.push({
      label: e.label,
      pattern: e.pattern,
      actual_act_name: actName,
      chunks,
      unique_sections: sections.size,
      expected_sections: e.expected,
      coverage_pct: Math.round(coverage * 100),
      sample_source_url: sourceUrl,
      status,
    });

    const icon = status === "complete" ? "✓" : status === "partial" ? "⚠" : "✗";
    const padLabel = e.label.padEnd(24);
    const padChunks = String(chunks).padStart(5);
    const padSections = String(sections.size).padStart(4);
    const padExpected = String(e.expected).padStart(4);
    const padPct = String(Math.round(coverage * 100)).padStart(3);
    console.log(`  ${icon} ${padLabel} chunks=${padChunks} sec=${padSections}/${padExpected} (${padPct}%)`);
  }

  const dir = path.resolve(process.cwd(), "data/audits");
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, "completeness.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  const complete = report.filter((r) => r.status === "complete");
  const partial = report.filter((r) => r.status === "partial");
  const missing = report.filter((r) => r.status === "missing");

  console.log("");
  console.log(`  Complete: ${complete.length}`);
  console.log(`  Partial:  ${partial.length}`);
  console.log(`  Missing:  ${missing.length}`);
  console.log(`  Report saved: ${outPath}`);

  if (partial.length > 0) {
    console.log("");
    console.log("  Partial Acts (need re-ingestion):");
    for (const r of partial) {
      console.log(`    ${r.label}: ${r.coverage_pct}% (${r.unique_sections}/${r.expected_sections} sections)`);
    }
  }

  if (missing.length > 0) {
    console.log("");
    console.log("  Missing Acts (zero chunks):");
    for (const r of missing) {
      console.log(`    ${r.label}`);
    }
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
