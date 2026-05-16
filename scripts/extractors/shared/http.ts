import fs from "fs";
import path from "path";

const USER_AGENT = "harvey-pk/1.0 legal-research-bot (+contact@example.com)";
const DEFAULT_DELAY_MS = 2000;

export async function politeFetch(url: string, opts: {
  delayMs?: number;
  acceptType?: string;
} = {}): Promise<Response> {
  const delay = opts.delayMs ?? DEFAULT_DELAY_MS;
  await new Promise((r) => setTimeout(r, delay));

  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": opts.acceptType ?? "text/html,application/xhtml+xml,application/xml,application/pdf;q=0.9",
    },
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res;
}

export async function downloadToFile(url: string, destPath: string, opts?: { delayMs?: number }): Promise<void> {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(destPath)) {
    return; // already downloaded
  }
  const res = await politeFetch(url, opts);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

export type FileFormat = "pdf" | "html" | "xml" | "unknown";

export function detectFormat(filePath: string): FileFormat {
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(512);
  fs.readSync(fd, buf, 0, 512, 0);
  fs.closeSync(fd);

  const head = buf.toString("utf-8", 0, 8).trim().toLowerCase();
  const headBytes = buf.toString("ascii", 0, 5);

  if (headBytes === "%PDF-") return "pdf";
  if (head.startsWith("<?xml")) return "xml";
  if (head.startsWith("<!doctype") || head.startsWith("<html")) return "html";
  // Some HTML pages start with whitespace or BOM — peek further
  const peek = buf.toString("utf-8", 0, 200).toLowerCase();
  if (peek.includes("<html") || peek.includes("<!doctype")) return "html";
  return "unknown";
}
