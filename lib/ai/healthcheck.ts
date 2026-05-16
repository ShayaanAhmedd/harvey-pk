// lib/ai/healthcheck.ts
//
// Deterministic LLM health probe — stress-test edition.
// Called by GET /api/ai-health (admin-protected route only).
//
// Execution model:
//   Each LLM provider (OpenAI, Claude, Gemini, Manus) is probed STRESS_RUNS
//   times concurrently with the same deterministic prompt at temperature 0.
//   Brave Search is a REST search API — one connectivity ping only.
//
// Stress-test aggregation (per LLM provider):
//   0 of N runs fail  → status from average latency  (healthy / degraded)
//   1 of N runs fail  → degraded  (regardless of latency)
//   ≥ 2 of N runs fail → down
//
// A run "fails" if: API error, invalid JSON, OR reasoning_result or token_test
// return false. Checksum mismatch produces a warning but does NOT fail the run.
//
// Routing recommendation:
//   After aggregation, providers are ranked by health then latency.
//   Brave is excluded from LLM routing (search API, no LLM capability).

import Anthropic from "@anthropic-ai/sdk";
import { extractJson } from "./extract-json";

// ── Probe config ─────────────────────────────────────────────────────────────

const HEALTH_PROMPT =
`You are running inside a production health check.
Return ONLY valid JSON.
Do not explain anything.

Schema:
{
  "reasoning_result": number,
  "token_test": string,
  "checksum": string
}

Tests:
1. What is 17 * 19?
2. Output exactly: HARVEY_PK_HEALTH_CHECK_V1
3. Return SHA256 of the string 'harvey-pk' in lowercase hex.`;

const EXPECTED = {
  reasoning_result: 323,
  token_test:       "HARVEY_PK_HEALTH_CHECK_V1",
  checksum:         "7e7f5b5a66a9e6d6e9e7d4bbdcd9c5edb7f0b45e7a5e3c1f8d0e3cbb1b0f6c5b",
} as const;

const LATENCY_THRESHOLD_MS = 2_500;
const LLM_TIMEOUT_MS       = 15_000;
const SEARCH_TIMEOUT_MS    = 10_000;
const STRESS_RUNS          = 3;

// ── Types ─────────────────────────────────────────────────────────────────────

interface HealthResponse {
  reasoning_result?: unknown;
  token_test?:       unknown;
  checksum?:         unknown;
}

type ProviderHealthStatus = "healthy" | "degraded" | "down";

interface ProviderReport {
  provider:          string;
  model:             string;
  runs:              number;        // probes sent (STRESS_RUNS for LLMs, 1 for Brave)
  latency_ms:        number;        // average across all runs
  json_valid:        boolean;
  reasoning_correct: boolean;
  token_correct:     boolean;
  checksum_correct:  boolean;
  checksum_warning:  boolean;       // true when checksum mismatches but provider is otherwise healthy
  status:            ProviderHealthStatus;
  error_type:        string | null;
  raw_truncated:     string | null; // first 200 chars of last run's raw response
}

interface RoutingRecommendation {
  primary_provider:   string | null;
  secondary_provider: string | null;
  blocked_providers:  string[];
  reasoning:          string;
}

export interface LLMHealthCheckResult {
  timestamp: string;
  summary: {
    total_providers: number;
    healthy:         number;
    degraded:        number;
    down:            number;
  };
  providers: ProviderReport[];
  routing:   RoutingRecommendation;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function validate(parsed: HealthResponse) {
  return {
    reasoning_correct: parsed.reasoning_result === EXPECTED.reasoning_result,
    token_correct:     parsed.token_test        === EXPECTED.token_test,
    checksum_correct:  parsed.checksum          === EXPECTED.checksum,
  };
}

/**
 * A run "passes" the stress test when it returns valid JSON and the two
 * core LLM validations are correct. Checksum mismatch produces a warning
 * but does not count as a failure.
 */
function isPassing(r: ProviderReport): boolean {
  return r.json_valid && r.reasoning_correct && r.token_correct;
}

function resolveStatus(
  v:          ReturnType<typeof validate>,
  latency_ms: number,
  json_valid: boolean
): ProviderHealthStatus {
  if (!json_valid || !v.reasoning_correct || !v.token_correct) return "down";
  return latency_ms >= LATENCY_THRESHOLD_MS ? "degraded" : "healthy";
}

function downReport(
  provider:   string,
  model:      string,
  latency_ms: number,
  error_type: string,
  runs        = 1
): ProviderReport {
  return {
    provider, model, runs, latency_ms,
    json_valid: false, reasoning_correct: false, token_correct: false,
    checksum_correct: false, checksum_warning: false,
    status:       "down",
    error_type,
    raw_truncated: null,
  };
}

function buildReport(
  provider:   string,
  model:      string,
  latency_ms: number,
  rawText:    string
): ProviderReport {
  const raw_truncated = rawText
    ? (rawText.length > 200 ? rawText.slice(0, 200) + "…" : rawText)
    : null;

  let parsed: HealthResponse;
  let json_valid = false;

  try {
    parsed     = JSON.parse(extractJson(rawText)) as HealthResponse;
    json_valid = true;
  } catch {
    return {
      provider, model, runs: 1, latency_ms,
      json_valid: false, reasoning_correct: false, token_correct: false,
      checksum_correct: false, checksum_warning: false,
      status:       "down",
      error_type:   "invalid_json",
      raw_truncated,
    };
  }

  const v                = validate(parsed);
  const status           = resolveStatus(v, latency_ms, json_valid);
  const checksum_warning = json_valid && !v.checksum_correct;

  return {
    provider, model, runs: 1, latency_ms, json_valid, ...v, checksum_warning, status,
    error_type:   status === "down" ? "validation_failed" : null,
    raw_truncated,
  };
}

function classifyNetworkError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return "timeout";
    if (err.message.toLowerCase().includes("fetch"))              return "network_error";
    return err.message.slice(0, 80);
  }
  return "unknown_error";
}

// ── Stress-test runner ────────────────────────────────────────────────────────
//
// Sends `n` concurrent probes via `testFn` and aggregates results.
//
// Aggregation rules (per the stress-test spec):
//   0 failed runs  → status = healthy | degraded based on avg latency
//   1 failed run   → status = degraded (overrides latency-based status)
//   ≥ 2 failed runs → status = down
//
// latency_ms in the returned report is the arithmetic mean across all runs.
// Validation fields (json_valid, etc.) come from the most recent passing run,
// or the last run when all runs failed — gives the most accurate snapshot of
// what the provider is currently returning.

async function runNTimes(
  testFn: () => Promise<ProviderReport>,
  n:      number
): Promise<ProviderReport> {
  const settled = await Promise.allSettled(
    Array.from({ length: n }, () => testFn())
  );

  // Promise.allSettled never rejects; each testFn has its own try/catch.
  // The fallback downReport handles any unexpected throws from testFn itself.
  const runs: ProviderReport[] = settled.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : downReport("unknown", "unknown", 0, "internal_error")
  );

  const failed     = runs.filter((r) => !isPassing(r));
  const passed     = runs.filter((r) => isPassing(r));
  const avgLatency = Math.round(runs.reduce((s, r) => s + r.latency_ms, 0) / runs.length);

  let status:     ProviderHealthStatus;
  let error_type: string | null;

  if (failed.length >= 2) {
    status     = "down";
    error_type = failed[failed.length - 1].error_type ?? `${failed.length}_of_${n}_runs_failed`;
  } else if (failed.length === 1) {
    status     = "degraded";
    error_type = "1_of_3_runs_failed";
  } else {
    status     = avgLatency >= LATENCY_THRESHOLD_MS ? "degraded" : "healthy";
    error_type = null;
  }

  // Representative snapshot: prefer most-recent passing run, else last run.
  const rep              = passed.length > 0 ? passed[passed.length - 1] : runs[runs.length - 1];
  const checksum_warning = runs.some((r) => r.checksum_warning);

  return { ...rep, runs: n, latency_ms: avgLatency, status, error_type, checksum_warning };
}

// ── Provider single-run tests ─────────────────────────────────────────────────

async function testOpenAI(): Promise<ProviderReport> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model  = "gpt-4o";
  if (!apiKey) return downReport("openai", model, 0, "key_missing");

  const start = Date.now();
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body:    JSON.stringify({
        model,
        messages:    [{ role: "user", content: HEALTH_PROMPT }],
        max_tokens:  200,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    const latency_ms = Date.now() - start;

    if (!res.ok) {
      interface OAIErr { error?: { type?: string; code?: string; message?: string } }
      const body = await res.json().catch(() => ({})) as OAIErr;
      return downReport("openai", model, latency_ms, body?.error?.type ?? body?.error?.code ?? `http_${res.status}`);
    }

    interface OAIRes { choices?: Array<{ message?: { content?: string } }> }
    const data = await res.json() as OAIRes;
    return buildReport("openai", model, latency_ms, data?.choices?.[0]?.message?.content ?? "");

  } catch (err) {
    return downReport("openai", model, Date.now() - start, classifyNetworkError(err));
  }
}

async function testClaude(): Promise<ProviderReport> {
  const apiKey  = process.env.ANTHROPIC_API_KEY;
  const model   = process.env.CLAUDE_MODEL ?? "claude-3-5-sonnet-20241022";
  const baseURL = process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com";
  if (!apiKey) return downReport("claude", model, 0, "key_missing");

  const start = Date.now();
  try {
    // Fresh client per run — avoids singleton state interference.
    const client = new Anthropic({ apiKey, baseURL });
    const msg    = await client.messages.create({
      model,
      max_tokens:  200,
      temperature: 0,
      messages:    [{ role: "user", content: HEALTH_PROMPT }],
    });
    const latency_ms = Date.now() - start;
    const block      = msg.content[0];
    return buildReport("claude", model, latency_ms, block.type === "text" ? block.text : "");

  } catch (err) {
    return downReport("claude", model, Date.now() - start, classifyNetworkError(err));
  }
}

async function testGemini(): Promise<ProviderReport> {
  const apiKey = process.env.GEMINI_API_KEY;
  const model  = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  if (!apiKey) return downReport("gemini", model, 0, "key_missing");

  const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        contents:         [{ role: "user", parts: [{ text: HEALTH_PROMPT }] }],
        generationConfig: { maxOutputTokens: 200, temperature: 0 },
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    const latency_ms = Date.now() - start;

    if (!res.ok) {
      interface GErr { error?: { message?: string; status?: string } }
      const body = await res.json().catch(() => ({})) as GErr;
      return downReport("gemini", model, latency_ms, body?.error?.message ?? body?.error?.status ?? `http_${res.status}`);
    }

    interface GRes { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
    const data = await res.json() as GRes;
    return buildReport("gemini", model, latency_ms, data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "");

  } catch (err) {
    return downReport("gemini", model, Date.now() - start, classifyNetworkError(err));
  }
}

async function testManus(): Promise<ProviderReport> {
  const apiKey = process.env.MANUS_API_KEY;
  const model  = process.env.MANUS_MODEL ?? "manus-draft-1";
  if (!apiKey) return downReport("manus", model, 0, "key_missing");

  const start = Date.now();
  try {
    const res = await fetch("https://api.manus.im/v1/chat/completions", {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body:    JSON.stringify({
        model,
        messages:    [{ role: "user", content: HEALTH_PROMPT }],
        max_tokens:  200,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    const latency_ms = Date.now() - start;

    if (!res.ok) {
      interface OAIErr { error?: { type?: string; message?: string } }
      const body = await res.json().catch(() => ({})) as OAIErr;
      return downReport("manus", model, latency_ms, body?.error?.message ?? body?.error?.type ?? `http_${res.status}`);
    }

    interface OAIRes { choices?: Array<{ message?: { content?: string } }> }
    const data = await res.json() as OAIRes;
    return buildReport("manus", model, latency_ms, data?.choices?.[0]?.message?.content ?? "");

  } catch (err) {
    return downReport("manus", model, Date.now() - start, classifyNetworkError(err));
  }
}

// Brave is a search REST API — cannot receive LLM prompts.
// One connectivity ping. LLM validation fields are N/A (true) and excluded
// from routing decisions. raw_truncated is null (no LLM output to capture).
async function testBrave(): Promise<ProviderReport> {
  const apiKey = process.env.BRAVE_API_KEY;
  const model  = "search-api";
  if (!apiKey) return downReport("brave", model, 0, "key_missing");

  const start = Date.now();
  try {
    const res = await fetch(
      "https://api.search.brave.com/res/v1/web/search?q=health+check&count=1",
      {
        headers: {
          Accept:                 "application/json",
          "Accept-Encoding":      "gzip",
          "X-Subscription-Token": apiKey,
        },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      }
    );
    const latency_ms = Date.now() - start;

    if (!res.ok) return downReport("brave", model, latency_ms, `http_${res.status}`);

    return {
      provider: "brave", model, runs: 1, latency_ms,
      json_valid: true, reasoning_correct: true, token_correct: true,
      checksum_correct: true, checksum_warning: false,
      status:       latency_ms >= LATENCY_THRESHOLD_MS ? "degraded" : "healthy",
      error_type:   null,
      raw_truncated: null,
    };

  } catch (err) {
    return downReport("brave", model, Date.now() - start, classifyNetworkError(err));
  }
}

// ── Routing recommendation ────────────────────────────────────────────────────
//
// Ranks passing LLM providers by: healthy > degraded, then avg latency (asc).
// Brave is excluded — it is not an LLM and cannot be routed LLM traffic.
// Blocked list includes providers that are "down" or failed all validations.

function computeRouting(providers: ProviderReport[]): RoutingRecommendation {
  const llm = providers.filter((p) => p.provider !== "brave");

  const eligible = llm
    .filter((p) => isPassing(p) && p.status !== "down")
    .sort((a, b) => {
      if (a.status === "healthy" && b.status !== "healthy") return -1;
      if (b.status === "healthy" && a.status !== "healthy") return  1;
      return a.latency_ms - b.latency_ms;
    });

  const blocked = llm
    .filter((p) => p.status === "down" || !isPassing(p))
    .map((p) => p.provider);

  const primary   = eligible[0]?.provider ?? null;
  const secondary = eligible[1]?.provider ?? null;

  let reasoning: string;

  if (!primary) {
    reasoning = "All LLM providers are down or failing validation — no routing possible.";
  } else {
    const pR    = eligible[0];
    const sR    = eligible[1];
    const parts = [
      `${primary} selected as primary (${pR.status}, ${pR.latency_ms}ms avg over ${pR.runs} runs${pR.checksum_warning ? ", checksum_warning" : ""})`,
      sR
        ? `${secondary} as secondary fallback (${sR.status}, ${sR.latency_ms}ms avg)`
        : "no secondary provider available",
      ...(blocked.length > 0
        ? [`blocked: ${blocked.join(", ")} (validation failure or provider error)`]
        : []),
    ];
    reasoning = parts.join("; ");
  }

  return { primary_provider: primary, secondary_provider: secondary, blocked_providers: blocked, reasoning };
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Runs the full infrastructure health check:
 *   - Each LLM provider: STRESS_RUNS concurrent probes, aggregated
 *   - Brave: single connectivity ping
 *   - Routing recommendation derived from aggregated results
 *
 * Never throws — all errors are captured inside individual test functions.
 */
export async function runLLMHealthCheck(): Promise<LLMHealthCheckResult> {
  const timestamp = new Date().toISOString();

  const [openai, claude, gemini, manus, brave] = await Promise.all([
    runNTimes(testOpenAI, STRESS_RUNS),
    runNTimes(testClaude, STRESS_RUNS),
    runNTimes(testGemini, STRESS_RUNS),
    runNTimes(testManus,  STRESS_RUNS),
    testBrave(),
  ]);

  const providers = [openai, claude, gemini, manus, brave];
  const healthy   = providers.filter((p) => p.status === "healthy").length;
  const degraded  = providers.filter((p) => p.status === "degraded").length;
  const down      = providers.filter((p) => p.status === "down").length;
  const routing   = computeRouting(providers);

  return {
    timestamp,
    summary: { total_providers: providers.length, healthy, degraded, down },
    providers,
    routing,
  };
}
