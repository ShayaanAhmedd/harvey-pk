import { extractUk } from "./uk-legislation";
import { extractPakistan } from "./pakistan-code";
import { listIngested } from "./shared/tracker";

function parseArgs(): Record<string, string> {
  const args = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const jurisdiction = (args["jurisdiction"] ?? "all").toLowerCase();
  const limit = parseInt(args["limit"] ?? "5", 10);

  if (args["status"] === "true") {
    const all = listIngested();
    console.log(`Total ingested documents: ${all.length}`);
    const byJur: Record<string, number> = {};
    for (const e of all) {
      byJur[e.jurisdiction] = (byJur[e.jurisdiction] ?? 0) + 1;
    }
    for (const [j, n] of Object.entries(byJur)) {
      console.log(`  ${j}: ${n}`);
    }
    return;
  }

  console.log("═".repeat(60));
  console.log(`  Legal Extractor`);
  console.log(`  Jurisdiction: ${jurisdiction}`);
  console.log(`  Limit:        ${limit}`);
  console.log("═".repeat(60));

  if (jurisdiction === "uk" || jurisdiction === "all") {
    await extractUk(limit);
  }
  if (jurisdiction === "pakistan" || jurisdiction === "pk" || jurisdiction === "all") {
    await extractPakistan(limit);
  }

  console.log("\nAll done.");
}

main().catch((e) => {
  console.error("\nFatal:", e);
  process.exit(1);
});
