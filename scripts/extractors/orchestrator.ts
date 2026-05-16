/**
 * Master Pakistan extraction orchestrator.
 * Runs the full Sprint 1 pipeline end-to-end with checkpointing.
 *
 * Phases:
 *   1. Discover federal (pakistancode.gov.pk)
 *   2. Extract federal
 *   3. Discover provincial × 4 + territorial × 3 (sequential, not parallel — same DB)
 *   4. Extract provincial × 7
 *   5. Discover SC judgments
 *   6. Extract SC judgments
 *   7. Discover FBR SROs
 *   8. Extract FBR SROs
 *
 * Progress saved to data/progress.json so a crash → restart picks up cleanly.
 *
 * Usage:
 *   npx tsx scripts/extractors/orchestrator.ts            # full run
 *   npx tsx scripts/extractors/orchestrator.ts --resume   # continue from last checkpoint
 *   npx tsx scripts/extractors/orchestrator.ts --only federal
 *   npx tsx scripts/extractors/orchestrator.ts --skip sc-judgments,fbr-sros
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";

type PhaseStatus = "pending" | "running" | "done" | "failed";
type Progress = {
  started_at: string;
  last_updated: string;
  phases: Record<string, { status: PhaseStatus; started?: string; finished?: string; error?: string }>;
};

const PROGRESS_PATH = path.resolve(process.cwd(), "data", "progress.json");

const PHASES: { id: string; label: string; cmd: string; args: string[] }[] = [
  { id: "discover-federal", label: "Federal Discovery", cmd: "tsx", args: ["scripts/extractors/discover-pakistancode.ts"] },
  { id: "extract-federal", label: "Federal Extraction", cmd: "tsx", args: ["scripts/extractors/csv-driven.ts", "--seed", "data/seeds/pakistan-federal.csv", "--concurrency", "3"] },
  { id: "discover-punjab", label: "Punjab Discovery", cmd: "tsx", args: ["scripts/extractors/discover-provincial.ts", "--province", "Punjab"] },
  { id: "extract-punjab", label: "Punjab Extraction", cmd: "tsx", args: ["scripts/extractors/csv-driven.ts", "--seed", "data/seeds/pakistan-punjab.csv", "--concurrency", "3"] },
  { id: "discover-sindh", label: "Sindh Discovery", cmd: "tsx", args: ["scripts/extractors/discover-provincial.ts", "--province", "Sindh"] },
  { id: "extract-sindh", label: "Sindh Extraction", cmd: "tsx", args: ["scripts/extractors/csv-driven.ts", "--seed", "data/seeds/pakistan-sindh.csv", "--concurrency", "3"] },
  { id: "discover-kp", label: "KP Discovery", cmd: "tsx", args: ["scripts/extractors/discover-provincial.ts", "--province", "KP"] },
  { id: "extract-kp", label: "KP Extraction", cmd: "tsx", args: ["scripts/extractors/csv-driven.ts", "--seed", "data/seeds/pakistan-kp.csv", "--concurrency", "3"] },
  { id: "discover-balochistan", label: "Balochistan Discovery", cmd: "tsx", args: ["scripts/extractors/discover-provincial.ts", "--province", "Balochistan"] },
  { id: "extract-balochistan", label: "Balochistan Extraction", cmd: "tsx", args: ["scripts/extractors/csv-driven.ts", "--seed", "data/seeds/pakistan-balochistan.csv", "--concurrency", "3"] },
  { id: "discover-ict", label: "ICT Discovery", cmd: "tsx", args: ["scripts/extractors/discover-provincial.ts", "--province", "ICT"] },
  { id: "extract-ict", label: "ICT Extraction", cmd: "tsx", args: ["scripts/extractors/csv-driven.ts", "--seed", "data/seeds/pakistan-ict.csv", "--concurrency", "3"] },
  { id: "discover-ajk", label: "AJK Discovery", cmd: "tsx", args: ["scripts/extractors/discover-provincial.ts", "--province", "AJK"] },
  { id: "extract-ajk", label: "AJK Extraction", cmd: "tsx", args: ["scripts/extractors/csv-driven.ts", "--seed", "data/seeds/pakistan-ajk.csv", "--concurrency", "3"] },
  { id: "discover-gb", label: "GB Discovery", cmd: "tsx", args: ["scripts/extractors/discover-provincial.ts", "--province", "GB"] },
  { id: "extract-gb", label: "GB Extraction", cmd: "tsx", args: ["scripts/extractors/csv-driven.ts", "--seed", "data/seeds/pakistan-gb.csv", "--concurrency", "3"] },
  { id: "discover-sc-judgments", label: "Supreme Court Discovery", cmd: "tsx", args: ["scripts/extractors/discover-sc-pakistan.ts"] },
  { id: "extract-sc-judgments", label: "Supreme Court Extraction", cmd: "tsx", args: ["scripts/extractors/csv-driven.ts", "--seed", "data/seeds/pakistan-sc-judgments.csv", "--concurrency", "3"] },
  { id: "discover-fbr-sros", label: "FBR SRO Discovery", cmd: "tsx", args: ["scripts/extractors/discover-fbr-sros.ts"] },
  { id: "extract-fbr-sros", label: "FBR SRO Extraction", cmd: "tsx", args: ["scripts/extractors/csv-driven.ts", "--seed", "data/seeds/pakistan-fbr-sros.csv", "--concurrency", "3"] },
];

function loadProgress(): Progress {
  if (!fs.existsSync(PROGRESS_PATH)) {
    const init: Progress = {
      started_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      phases: {},
    };
    for (const p of PHASES) init.phases[p.id] = { status: "pending" };
    return init;
  }
  return JSON.parse(fs.readFileSync(PROGRESS_PATH, "utf-8"));
}

function saveProgress(p: Progress) {
  p.last_updated = new Date().toISOString();
  fs.mkdirSync(path.dirname(PROGRESS_PATH), { recursive: true });
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(p, null, 2));
}

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

async function runPhase(phase: typeof PHASES[number]): Promise<boolean> {
  return new Promise((resolve) => {
    console.log(`\n${"━".repeat(60)}\n▶ ${phase.label}\n${"━".repeat(60)}`);
    const child = spawn("npx", [phase.cmd, ...phase.args], {
      cwd: process.cwd(),
      shell: true,
      stdio: "inherit",
      env: { ...process.env },
    });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

async function main() {
  const args = parseArgs();
  const resume = args["resume"] === "true";
  const only = (args["only"] ?? "").split(",").filter(Boolean);
  const skip = (args["skip"] ?? "").split(",").filter(Boolean);

  const progress = loadProgress();

  console.log("═".repeat(60));
  console.log("  Pakistan Legal Corpus Orchestrator");
  console.log("═".repeat(60));
  console.log(`  Resume:   ${resume}`);
  console.log(`  Only:     ${only.join(",") || "(all)"}`);
  console.log(`  Skip:     ${skip.join(",") || "(none)"}`);
  console.log(`  Progress: ${PROGRESS_PATH}`);
  console.log("═".repeat(60));

  for (const phase of PHASES) {
    if (only.length > 0 && !only.includes(phase.id)) continue;
    if (skip.includes(phase.id)) continue;
    if (resume && progress.phases[phase.id]?.status === "done") {
      console.log(`  ↪ Skip (already done): ${phase.label}`);
      continue;
    }

    progress.phases[phase.id] = { status: "running", started: new Date().toISOString() };
    saveProgress(progress);

    const ok = await runPhase(phase);
    progress.phases[phase.id] = {
      ...progress.phases[phase.id],
      status: ok ? "done" : "failed",
      finished: new Date().toISOString(),
      error: ok ? undefined : "exit code non-zero",
    };
    saveProgress(progress);

    if (!ok) {
      console.log(`\n  ✗ Phase failed: ${phase.label}`);
      console.log(`  Continue anyway. Re-run with --resume to retry later.`);
      // Don't abort — continue with next phase. Failed phases can be retried.
    }
  }

  console.log("\n" + "═".repeat(60));
  console.log("  Orchestrator finished.");
  console.log("═".repeat(60));
  const done = Object.values(progress.phases).filter((p) => p.status === "done").length;
  const failed = Object.values(progress.phases).filter((p) => p.status === "failed").length;
  console.log(`  ✓ Done:   ${done}/${PHASES.length}`);
  console.log(`  ✗ Failed: ${failed}/${PHASES.length}`);
  console.log("\nRun npm run extract:pk:status to see chunk counts in Supabase.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
