import path from "path";
import { downloadToFile } from "./shared/http";
import { isIngested, markIngested } from "./shared/tracker";
import { runIngestLaw } from "./shared/pipeline";

// Hand-curated seed list of important Pakistani Acts.
// pakistancode.gov.pk hosts PDFs at predictable URLs under /pdffiles/
// Add more here over time. Format: { title, pdfUrl, year, pageUrl }
const PAKISTAN_SEED: Array<{ title: string; year: number; pdfUrl: string; pageUrl: string }> = [
  {
    title: "Companies Act 2017",
    year: 2017,
    pdfUrl: "https://pakistancode.gov.pk/pdffiles/administrator93f4dab9aff70b00b3d3d4ed03ada4b9.pdf",
    pageUrl: "https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-apaUY2N-sg-jjjjjjjjjjjjj",
  },
  // The user can append more entries to this list as needed.
  // Real URLs need to be verified at run-time; if the seeded URL 404s,
  // we log it and skip rather than fail the whole batch.
];

export async function extractPakistan(limit: number = 5): Promise<void> {
  console.log(`\n[PK] Processing seed list (limit=${limit})...`);
  const todo = PAKISTAN_SEED.slice(0, limit);

  for (const act of todo) {
    if (isIngested(act.pdfUrl)) {
      console.log(`[PK] Skip (already ingested): ${act.title}`);
      continue;
    }

    const filename = `${act.year}-${act.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}.pdf`;
    const localPath = path.resolve(process.cwd(), "data", "raw", "pakistan", filename);

    try {
      console.log(`[PK] Downloading: ${act.title}`);
      await downloadToFile(act.pdfUrl, localPath, { delayMs: 3000 });

      console.log(`[PK] Ingesting via ingest-law.ts...`);
      const result = await runIngestLaw({
        file: localPath,
        act: act.title,
        year: act.year,
        jurisdiction: "Pakistan",
        sourceUrl: act.pageUrl,
      });

      if (result.success) {
        markIngested({
          url: act.pdfUrl,
          jurisdiction: "Pakistan",
          act_name: act.title,
          ingested_at: new Date().toISOString(),
          file_path: localPath,
        });
        console.log(`[PK] ✓ Done: ${act.title}\n`);
      } else {
        console.error(`[PK] ✗ Ingest failed for: ${act.title}\n`);
      }
    } catch (e) {
      console.error(`[PK] Error processing ${act.title}: ${(e as Error).message}\n`);
    }
  }

  console.log(`[PK] Extraction complete.`);
}
