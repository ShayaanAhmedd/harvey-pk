// lib/scrapers/court-scraper.ts
//
// Court Decision Scraper
// Fetches judgment listings + individual judgment pages/PDFs from public court websites.
//
// Safety:
//   - No LLM calls — pure HTTP fetch + regex extraction
//   - Deterministic output for the same input URL
//   - Retry with exponential backoff on transient network errors (5xx, timeouts)
//   - Per-judgment failures are caught and skipped — never aborts the full batch
//   - Polite 500 ms inter-request delay to respect server rate limits

// ── Public types ──────────────────────────────────────────────────────────────

export interface ScrapedDecision {
  title:         string | null;
  court_name:    string | null; // sniffed from URL; overridden by parser downstream
  judge_name:    string | null; // always null here — extracted by judgment-parser
  decision_year: number | null; // sniffed from URL
  full_text:     string;
  source_url:    string;
}

export interface ScraperOptions {
  maxDecisions?: number;  // max judgments to fetch per source (default 20)
  retries?:      number;  // per-request retry count on transient errors (default 3)
  retryDelayMs?: number;  // base backoff delay in ms; doubles each retry (default 1000)
  timeoutMs?:    number;  // per-request fetch timeout in ms (default 15000)
  userAgent?:    string;  // HTTP User-Agent header
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_MAX      = 20;
const DEFAULT_RETRIES  = 3;
const DEFAULT_DELAY_MS = 1_000;
const DEFAULT_TIMEOUT  = 15_000;
const DEFAULT_UA       = "HarveyPK-CourtScraper/1.0 (+legal-ai-research)";

const INTER_REQUEST_DELAY_MS = 500; // polite delay between judgment fetches
const MIN_TEXT_LENGTH        = 300; // shorter texts are skipped as non-judgment

// ── Retry-capable fetch ───────────────────────────────────────────────────────
// Retries on HTTP 5xx responses and network-level errors.
// Fails immediately on HTTP 4xx (client error — no point retrying).

async function fetchWithRetry(
  url:      string,
  init:     RequestInit,
  retries:  number,
  delayMs:  number,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      if (res.status < 500) {
        // Client error (400–499): non-retryable
        throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
      }
      // Server error (500+): retryable
      lastError = new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
    } catch (err) {
      lastError = err;
      // Non-retryable on the first attempt if it's a clear client-side config error
      if (err instanceof TypeError && err.message.includes("Invalid URL")) throw err;
    }

    if (attempt < retries) {
      await delay(delayMs * 2 ** attempt); // exponential backoff: 1s, 2s, 4s
    }
  }
  throw lastError;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── HTML → plain text ─────────────────────────────────────────────────────────
// Lightweight regex-based HTML stripping — removes scripts/styles/tags,
// decodes common entities, normalises whitespace.
// Sufficient for extracting readable judgment text from court website HTML.

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|h[1-6]|li|tr|td|th|section|article|blockquote)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi,  " ")
    .replace(/&amp;/gi,   "&")
    .replace(/&lt;/gi,    "<")
    .replace(/&gt;/gi,    ">")
    .replace(/&quot;/gi,  '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/[ \t]+/g,   " ")
    .replace(/\n{3,}/g,   "\n\n")
    .trim();
}

// ── HTML title extraction ─────────────────────────────────────────────────────

const H1_RE         = /<h1[^>]*>([\s\S]*?)<\/h1>/i;
const HTML_TITLE_RE = /<title[^>]*>([^<]+)<\/title>/i;

function extractHtmlTitle(html: string): string | null {
  const h1 = H1_RE.exec(html);
  if (h1) {
    const text = stripHtml(h1[1]).slice(0, 220).trim();
    if (text.length > 5) return text;
  }
  const title = HTML_TITLE_RE.exec(html);
  if (title) {
    const text = stripHtml(title[1]).slice(0, 220).trim();
    if (text.length > 5) return text;
  }
  return null;
}

// ── Judgment link extraction ──────────────────────────────────────────────────
// Extracts href values from anchor tags and filters to those that look like
// individual judgment pages or PDF downloads.
// Resolves relative hrefs against the base URL.

const PDF_SUFFIX_RE  = /\.pdf(\?[^"' ]*)?$/i;
const JUDGMENT_URL_RE = /\/(judgment|judgement|decision|order|ruling|verdict|case|opinion)[s]?\//i;
const QUERY_DOC_RE   = /[?&](?:id|case_id|judgment_id|doc|ref|no)=[\w-]+/i;
// Negative filter: skip obvious navigation links
const NAV_URL_RE = /\/(login|logout|register|about|contact|faq|search|home|tag|category|page|feed|rss)/i;

function extractJudgmentLinks(html: string, baseUrl: string): string[] {
  const base  = new URL(baseUrl);
  const links = new Set<string>();

  // Match all href attributes — one pass over the HTML
  const HREF_RE = /href=["']([^"'#\s][^"']*?)["']/gi;
  for (const m of html.matchAll(HREF_RE)) {
    const raw = m[1].trim();
    if (!raw || raw.startsWith("mailto:") || raw.startsWith("javascript:")) continue;

    let full: string;
    try {
      full = new URL(raw, base).href;
    } catch {
      continue; // malformed href
    }

    if (NAV_URL_RE.test(full)) continue;

    if (
      PDF_SUFFIX_RE.test(full)    ||
      JUDGMENT_URL_RE.test(full)  ||
      QUERY_DOC_RE.test(full)
    ) {
      links.add(full);
    }
  }

  return [...links];
}

// ── URL metadata sniffing ─────────────────────────────────────────────────────
// Coarse metadata derived from the source URL when no better signal is available.
// The judgment-parser will refine these from the document text.

const URL_YEAR_RE  = /\b(19[6-9]\d|20[0-3]\d)\b/;
const COURT_URL_RE = /\b(supreme[-_]?court|high[-_]?court|sessions[-_]?court|shariat[-_]?court)\b/i;

const COURT_LABEL: [RegExp, string][] = [
  [/supreme/i, "Supreme Court of Pakistan"],
  [/shariat/i, "Federal Shariat Court"],
  [/high/i,    "High Court"],
  [/session/i, "Sessions Court"],
];

function sniffCourtFromUrl(url: string): string | null {
  const m = COURT_URL_RE.exec(url);
  if (!m) return null;
  const seg = m[1].toLowerCase();
  for (const [re, label] of COURT_LABEL) {
    if (re.test(seg)) return label;
  }
  return null;
}

function sniffYearFromUrl(url: string): number | null {
  const m = URL_YEAR_RE.exec(url);
  return m ? parseInt(m[1], 10) : null;
}

// ── PDF text extraction ───────────────────────────────────────────────────────
// Dynamic require avoids ENOENT crash at module load when pdf-parse is absent.

async function extractPdfText(buffer: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse") as (b: Buffer) => Promise<{ text: string }>;
  const result   = await pdfParse(buffer);
  return result.text;
}

// ── Single judgment fetch ─────────────────────────────────────────────────────
// Fetches one URL (HTML page or PDF) and returns extracted text + title.
// Returns null on any failure — caller skips gracefully.

async function fetchJudgment(
  url:       string,
  headers:   HeadersInit,
  retries:   number,
  delayMs:   number,
  timeoutMs: number,
): Promise<{ text: string; title: string | null } | null> {
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetchWithRetry(url, { headers, signal: controller.signal }, retries, delayMs);
    } finally {
      clearTimeout(tid);
    }

    const contentType = res.headers.get("content-type") ?? "";

    if (contentType.includes("application/pdf") || PDF_SUFFIX_RE.test(url)) {
      const buf  = Buffer.from(await res.arrayBuffer());
      const text = await extractPdfText(buf);
      return { text, title: null };
    }

    if (
      contentType.includes("text/html")  ||
      contentType.includes("text/plain") ||
      contentType === ""
    ) {
      const html  = await res.text();
      const title = extractHtmlTitle(html);
      const text  = stripHtml(html);
      return { text, title };
    }

    return null; // unsupported content type (binary, XML, etc.)
  } catch {
    return null; // network / parse / pdf failure — caller skips gracefully
  }
}

// ── Public entry point ────────────────────────────────────────────────────────
//
// Two modes:
//   A) sourceUrl is a direct PDF link → fetch + extract text → return one decision
//   B) sourceUrl is an HTML listing page → extract judgment links → fetch each one
//
// All per-judgment failures are suppressed; the successfully scraped decisions
// are always returned, even when some judgments fail to fetch.

export async function fetchCourtDecisions(
  sourceUrl: string,
  options:   ScraperOptions = {},
): Promise<ScrapedDecision[]> {
  const {
    maxDecisions = DEFAULT_MAX,
    retries      = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_DELAY_MS,
    timeoutMs    = DEFAULT_TIMEOUT,
    userAgent    = DEFAULT_UA,
  } = options;

  const headers: HeadersInit = {
    "User-Agent": userAgent,
    "Accept":     "text/html,application/pdf,application/xhtml+xml,*/*;q=0.9",
    "Accept-Language": "en-US,en;q=0.9",
  };

  const results: ScrapedDecision[] = [];

  // ── Fetch listing / root page ──────────────────────────────────────────────
  let listingText: string;
  let listingContentType: string;
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), timeoutMs);
    let listingRes: Response;
    try {
      listingRes = await fetchWithRetry(sourceUrl, { headers, signal: controller.signal }, retries, retryDelayMs);
    } finally {
      clearTimeout(tid);
    }
    listingContentType = listingRes.headers.get("content-type") ?? "";
    listingText        = await listingRes.text();
  } catch {
    return results; // listing page unreachable — return empty
  }

  // ── Case A: source URL is itself a PDF ────────────────────────────────────
  if (listingContentType.includes("application/pdf") || PDF_SUFFIX_RE.test(sourceUrl)) {
    try {
      const buf  = Buffer.from(Buffer.from(listingText, "binary"));
      const text = await extractPdfText(buf);
      if (text.length >= MIN_TEXT_LENGTH) {
        results.push({
          title:         null,
          court_name:    sniffCourtFromUrl(sourceUrl),
          judge_name:    null,
          decision_year: sniffYearFromUrl(sourceUrl),
          full_text:     text,
          source_url:    sourceUrl,
        });
      }
    } catch { /* graceful */ }
    return results;
  }

  // ── Case B: HTML listing page → extract + fetch each judgment link ─────────
  const judgmentUrls = extractJudgmentLinks(listingText, sourceUrl).slice(0, maxDecisions);

  for (let i = 0; i < judgmentUrls.length; i++) {
    const judUrl  = judgmentUrls[i];
    const judgment = await fetchJudgment(judUrl, headers, retries, retryDelayMs, timeoutMs);

    if (!judgment || judgment.text.length < MIN_TEXT_LENGTH) {
      // Text too short to be a real judgment — skip silently
    } else {
      results.push({
        title:         judgment.title,
        court_name:    sniffCourtFromUrl(judUrl) ?? sniffCourtFromUrl(sourceUrl),
        judge_name:    null,
        decision_year: sniffYearFromUrl(judUrl),
        full_text:     judgment.text,
        source_url:    judUrl,
      });
    }

    // Polite delay between requests (skip after the last one)
    if (i < judgmentUrls.length - 1) {
      await delay(INTER_REQUEST_DELAY_MS);
    }
  }

  return results;
}
