import fs from "fs";
import path from "path";

const TRACKER_PATH = path.resolve(process.cwd(), "data", "tracker.json");

type TrackerEntry = {
  url: string;
  jurisdiction: string;
  act_name: string;
  ingested_at: string;
  file_path: string;
};

type Tracker = Record<string, TrackerEntry>; // keyed by url

function load(): Tracker {
  if (!fs.existsSync(TRACKER_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(TRACKER_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function save(t: Tracker): void {
  fs.mkdirSync(path.dirname(TRACKER_PATH), { recursive: true });
  fs.writeFileSync(TRACKER_PATH, JSON.stringify(t, null, 2));
}

export function isIngested(url: string): boolean {
  return Boolean(load()[url]);
}

export function markIngested(entry: TrackerEntry): void {
  const t = load();
  t[entry.url] = entry;
  save(t);
}

export function listIngested(jurisdiction?: string): TrackerEntry[] {
  const t = load();
  const items = Object.values(t);
  return jurisdiction ? items.filter((e) => e.jurisdiction === jurisdiction) : items;
}
