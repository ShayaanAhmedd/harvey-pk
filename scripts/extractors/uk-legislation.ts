import path from "path";
import { politeFetch, downloadToFile, detectFormat } from "./shared/http";
import { isIngested, markIngested } from "./shared/tracker";
import { runIngestLaw } from "./shared/pipeline";

// legislation.gov.uk URL conventions:
//   Atom feed of recent Acts:  https://www.legislation.gov.uk/ukpga/data.feed
//   Specific Act HTML:         https://www.legislation.gov.uk/ukpga/<year>/<chapter>/data.htm
//   Specific Act XML:          https://www.legislation.gov.uk/ukpga/<year>/<chapter>/data.xml
//   Specific Act page:         https://www.legislation.gov.uk/ukpga/<year>/<chapter>

type UkAct = {
  title: string;
  year: number;
  chapter: number;
  pageUrl: string;
  htmlUrl: string;
};

const UK_FEED = "https://www.legislation.gov.uk/ukpga/data.feed";

async function fetchRecentActs(limit: number): Promise<UkAct[]> {
  const res = await politeFetch(UK_FEED, { acceptType: "application/atom+xml" });
  const xml = await res.text();

  const entries: UkAct[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  const titleRegex = /<title[^>]*>([^<]+)<\/title>/;
  const linkRegex = /<link\s+[^>]*href="([^"]+)"/;

  let m: RegExpExecArray | null;
  while ((m = entryRegex.exec(xml)) !== null && entries.length < limit) {
    const block = m[1];
    const title = titleRegex.exec(block)?.[1]?.trim();
    const link = linkRegex.exec(block)?.[1]?.trim();
    if (!title || !link) continue;

    const match = /\/ukpga\/(\d{4})\/(\d+)$/.exec(link);
    if (!match) continue;
    const year = parseInt(match[1], 10);
    const chapter = parseInt(match[2], 10);

    entries.push({
      title,
      year,
      chapter,
      pageUrl: link,
      htmlUrl: `${link}/data.htm`,
    });
  }

  return entries;
}

export async function extractUk(limit: number = 5): Promise<void> {
  console.log(`\n[UK] Fetching recent Acts (limit=${limit})...`);
  const acts = await fetchRecentActs(limit);
  console.log(`[UK] Found ${acts.length} Acts.\n`);

  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (const act of acts) {
    if (isIngested(act.htmlUrl)) {
      console.log(`[UK] Skip (already ingested): ${act.title}`);
      skipped++;
      continue;
    }

    const slug = act.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
    const filename = `${act.year}-c${act.chapter}-${slug}.html`;
    const localPath = path.resolve(process.cwd(), "data", "raw", "uk", filename);

    try {
      console.log(`[UK] Downloading: ${act.title}`);
      await downloadToFile(act.htmlUrl, localPath, { delayMs: 2500 });

      // Validate format
      const format = detectFormat(localPath);
      if (format !== "html" && format !== "xml") {
        console.error(`[UK] ✗ Downloaded file is not HTML/XML (detected: ${format}). Skipping: ${act.title}`);
        failed++;
        continue;
      }

      console.log(`[UK] Ingesting via ingest-law.ts...`);
      const result = await runIngestLaw({
        file: localPath,
        act: act.title,
        year: act.year,
        jurisdiction: "UK",
        sourceUrl: act.pageUrl,
      });

      if (result.success) {
        markIngested({
          url: act.htmlUrl,
          jurisdiction: "UK",
          act_name: act.title,
          ingested_at: new Date().toISOString(),
          file_path: localPath,
        });
        console.log(`[UK] ✓ Done: ${act.title}\n`);
        success++;
      } else {
        console.error(`[UK] ✗ Ingest failed for: ${act.title}\n`);
        failed++;
      }
    } catch (e) {
      console.error(`[UK] Error processing ${act.title}: ${(e as Error).message}\n`);
      failed++;
    }
  }

  console.log(`\n[UK] Extraction complete: ${success} success, ${skipped} skipped, ${failed} failed.`);
}
