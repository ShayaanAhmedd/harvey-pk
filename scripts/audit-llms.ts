/**
 * audit-llms.ts — LLM System Audit
 *
 * Verifies all configured LLM providers and routing logic.
 *
 * Usage:
 *   npx ts-node scripts/audit-llms.ts
 *   npx ts-node scripts/audit-llms.ts --skip-irac   # skip IRAC pipeline test
 *
 * Exit codes:
 *   0 — all tests passed
 *   1 — one or more failures
 *
 * Note on router import: lib/ai/router.ts imports from "@/lib/claude" using
 * Next.js path aliases, which cannot be resolved by ts-node in the scripts
 * context (scripts/tsconfig.json clears path aliases with "paths": {}).
 * This audit calls each provider adapter directly — the same functions the
 * router delegates to internally. The routing policy is replicated here as a
 * read-only reference; no router code is modified.
 *
 * Required env vars (in .env.local):
 *   ANTHROPIC_API_KEY
 *   GEMINI_API_KEY
 *   MANUS_API_KEY  (optional — audit marks manus as skipped if absent)
 */

import path       from "path";
import dotenv     from "dotenv";
import Anthropic  from "@anthropic-ai/sdk";

import { validateEnvironment } from "../lib/utils/env-validator";
import { detectGatewayError  } from "../lib/utils/network-errors";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs(): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--")) flags[arg.slice(2)] = true;
  }
  return flags;
}

const flags = parseArgs();

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Deterministic JSON probe — identical to the health-check prompt.
 * Only reasoning_result and token_test are validated (checksum is advisory).
 */
const AUDIT_PROMPT = `You are running a system health check.
Return ONLY valid JSON. No explanation, no markdown fences.

{
  "reasoning_result": 323,
  "token_test": "HARVEY_PK_HEALTH_CHECK_V1",
  "checksum": "test"
}

Do not change any value. Output exactly as shown.`;

const EXPECTED = {
  reasoning_result: 323,
  token_test:       "HARVEY_PK_HEALTH_CHECK_V1",
} as const;

const LLM_TIMEOUT_MS = 20_000;

/**
 * Read-only copy of ROUTING_POLICY from lib/ai/router.ts.
 * Only "legal_deep" is used by the router test.
 */
const ROUTING_POLICY = {
  legal_deep:     { primary: "claude", fallbacks: ["gemini"         ] },
  casual:         { primary: "claude", fallbacks: ["gemini"         ] },
  crosscheck:     { primary: "gemini", fallbacks: ["claude"         ] },
  draft:          { primary: "manus",  fallbacks: ["claude", "gemini"] },
  summarization:  { primary: "gemini", fallbacks: ["claude"         ] },
  high_reasoning: { primary: "claude", fallbacks: ["gemini"         ] },
} as const;

// ── Types ─────────────────────────────────────────────────────────────────────

type ProviderStatus = "healthy" | "degraded" | "down" | "skipped";

interface ProviderResult {
  provider:          string;
  model:             string;
  status:            ProviderStatus;
  latency_ms:        number;
  json_valid:        boolean;
  reasoning_correct: boolean;
  token_correct:     boolean;
  error:             string | null;
}

interface IracCore {
  issue:       string;
  rule:        string;
  application: string;
  conclusion:  string;
  citations:   Array<{ act_name: string; section_number: string; excerpt: string }>;
}

interface IracAuditResult {
  ok:          boolean;
  latency_ms:  number;
  result?:     IracCore;
  error?:      string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strips markdown code fences; falls back to first {...} block. */
function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced  = trimmed.match(/```\w*\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const s = trimmed.indexOf("{");
  const e = trimmed.lastIndexOf("}");
  return s !== -1 && e > s ? trimmed.slice(s, e + 1) : trimmed;
}

function errorMsg(err: unknown): string {
  const gw = detectGatewayError(err);
  if (gw) return gw.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function skipped(provider: string, model: string, reason: string): ProviderResult {
  return {
    provider, model, status: "skipped", latency_ms: 0,
    json_valid: false, reasoning_correct: false, token_correct: false,
    error: reason,
  };
}

function down(provider: string, model: string, error: string, latency_ms = 0): ProviderResult {
  return {
    provider, model, status: "down", latency_ms,
    json_valid: false, reasoning_correct: false, token_correct: false,
    error,
  };
}

function parseProbeResult(
  provider:   string,
  model:      string,
  latency_ms: number,
  raw:        string,
): ProviderResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(extractJson(raw)) as Record<string, unknown>;
  } catch {
    return down(provider, model, "invalid_json — response could not be parsed", latency_ms);
  }

  const reasoning_correct = parsed.reasoning_result === EXPECTED.reasoning_result;
  const token_correct     = parsed.token_test        === EXPECTED.token_test;
  const status: ProviderStatus =
    (!reasoning_correct || !token_correct) ? "degraded" : "healthy";

  return {
    provider, model, status, latency_ms,
    json_valid: true, reasoning_correct, token_correct,
    error: null,
  };
}

// ── Provider single-run tests ─────────────────────────────────────────────────

async function testClaude(): Promise<ProviderResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model  = process.env.CLAUDE_MODEL ?? "claude-3-5-sonnet-20241022";
  if (!apiKey) return skipped("claude", model, "ANTHROPIC_API_KEY not set");

  const start   = Date.now();
  const baseURL = process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com";

  try {
    const client = new Anthropic({ apiKey, baseURL });
    const msg    = await client.messages.create({
      model,
      max_tokens:  200,
      temperature: 0,
      messages:    [{ role: "user", content: AUDIT_PROMPT }],
    });
    const latency_ms = Date.now() - start;
    const block      = msg.content[0];
    const text       = block?.type === "text" ? block.text : "";
    return parseProbeResult("claude", model, latency_ms, text);
  } catch (err) {
    return down("claude", model, errorMsg(err), Date.now() - start);
  }
}

async function testGemini(): Promise<ProviderResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  const model  = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  if (!apiKey) return skipped("gemini", model, "GEMINI_API_KEY not set");

  const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const start = Date.now();

  try {
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents:         [{ role: "user", parts: [{ text: AUDIT_PROMPT }] }],
        generationConfig: { maxOutputTokens: 200, temperature: 0 },
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    const latency_ms = Date.now() - start;

    if (!res.ok) {
      interface GErr { error?: { message?: string; status?: string } }
      const body = await res.json().catch(() => ({})) as GErr;
      const msg  = body?.error?.message ?? body?.error?.status ?? `HTTP ${res.status}`;
      return down("gemini", model, msg, latency_ms);
    }

    interface GRes { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
    const data = await res.json() as GRes;
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    return parseProbeResult("gemini", model, latency_ms, text);

  } catch (err) {
    return down("gemini", model, errorMsg(err), Date.now() - start);
  }
}

async function testManus(): Promise<ProviderResult> {
  const apiKey = process.env.MANUS_API_KEY;
  const model  = process.env.MANUS_MODEL ?? "manus-draft-1";
  if (!apiKey) return skipped("manus", model, "MANUS_API_KEY not set");

  const start = Date.now();

  try {
    const res = await fetch("https://api.manus.im/v1/chat/completions", {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages:    [{ role: "user", content: AUDIT_PROMPT }],
        max_tokens:  200,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    const latency_ms = Date.now() - start;

    if (!res.ok) {
      interface OAIErr { error?: { type?: string; message?: string } }
      const body = await res.json().catch(() => ({})) as OAIErr;
      const msg  = body?.error?.message ?? body?.error?.type ?? `HTTP ${res.status}`;
      return down("manus", model, msg, latency_ms);
    }

    interface OAIRes { choices?: Array<{ message?: { content?: string } }> }
    const data = await res.json() as OAIRes;
    const text = data?.choices?.[0]?.message?.content ?? "";
    return parseProbeResult("manus", model, latency_ms, text);

  } catch (err) {
    return down("manus", model, errorMsg(err), Date.now() - start);
  }
}

// ── Router simulation ─────────────────────────────────────────────────────────
//
// Mirrors the routing logic in lib/ai/router.ts:
//   Walk the candidate list (primary, ...fallbacks).
//   First non-down provider wins.

interface RouterAuditResult {
  task:           string;
  primary:        string;
  fallbacks:      readonly string[];
  selected:       string | null;
  fallback_used:  boolean;
  status:         "pass" | "fail";
  reason:         string;
}

function auditRouter(
  task:      keyof typeof ROUTING_POLICY,
  providers: ProviderResult[],
): RouterAuditResult {
  const policy     = ROUTING_POLICY[task];
  const candidates = [policy.primary, ...policy.fallbacks] as string[];
  const byName     = Object.fromEntries(providers.map((p) => [p.provider, p]));

  let selected:      string | null = null;
  let fallback_used: boolean       = false;

  for (const candidate of candidates) {
    const r = byName[candidate];
    if (r && r.status !== "down" && r.status !== "skipped") {
      selected      = candidate;
      fallback_used = candidate !== policy.primary;
      break;
    }
  }

  if (!selected) {
    return {
      task, primary: policy.primary, fallbacks: policy.fallbacks,
      selected: null, fallback_used: false, status: "fail",
      reason: "All providers in the candidate list are down or skipped.",
    };
  }

  const reason = fallback_used
    ? `Primary (${policy.primary}) is unavailable — fallback to ${selected}.`
    : `Primary (${selected}) is healthy.`;

  return {
    task, primary: policy.primary, fallbacks: policy.fallbacks,
    selected, fallback_used, status: "pass", reason,
  };
}

// ── IRAC pipeline test ────────────────────────────────────────────────────────
//
// Calls Claude directly with a minimal IRAC system prompt and validates that
// the response contains the five required IRAC fields + citations array.
// This exercises the same LLM call path as callIrac() in lib/ai/irac.ts.

const IRAC_SYSTEM_PROMPT = `You are a Pakistani legal analyst.
Return ONLY valid JSON following this exact schema — no prose, no markdown:

{
  "issue":       "The legal question to be decided.",
  "rule":        "The applicable statute, section, and principle.",
  "application": "Application of the rule to the specific facts.",
  "conclusion":  "The legal outcome.",
  "citations": [
    { "act_name": "Name of Act", "section_number": "302", "excerpt": "Quoted text from the provision." }
  ]
}`;

const IRAC_QUESTION =
  "Can murder under Section 302 PPC be reduced to culpable homicide if provocation exists?";

async function testIracPipeline(): Promise<IracAuditResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model  = process.env.CLAUDE_MODEL ?? "claude-3-5-sonnet-20241022";

  if (!apiKey) {
    return { ok: false, latency_ms: 0, error: "ANTHROPIC_API_KEY not set — cannot run IRAC test" };
  }

  const start   = Date.now();
  const baseURL = process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com";

  try {
    const client = new Anthropic({ apiKey, baseURL });
    const msg    = await client.messages.create({
      model,
      max_tokens:  1_500,
      temperature: 0,
      system:      IRAC_SYSTEM_PROMPT,
      messages:    [{ role: "user", content: IRAC_QUESTION }],
    });
    const latency_ms = Date.now() - start;
    const block      = msg.content[0];
    const text       = block?.type === "text" ? block.text : "";

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(extractJson(text)) as Record<string, unknown>;
    } catch {
      return { ok: false, latency_ms, error: "Response could not be parsed as JSON" };
    }

    if (
      typeof parsed.issue       !== "string" ||
      typeof parsed.rule        !== "string" ||
      typeof parsed.application !== "string" ||
      typeof parsed.conclusion  !== "string" ||
      !Array.isArray(parsed.citations)
    ) {
      return { ok: false, latency_ms, error: "Response missing required IRAC fields" };
    }

    return { ok: true, latency_ms, result: parsed as unknown as IracCore };

  } catch (err) {
    return { ok: false, latency_ms: Date.now() - start, error: errorMsg(err) };
  }
}

// ── Report formatting ─────────────────────────────────────────────────────────

function statusIcon(status: ProviderStatus | "pass" | "fail"): string {
  switch (status) {
    case "healthy":  return "✓";
    case "degraded": return "~";
    case "down":     return "✗";
    case "skipped":  return "-";
    case "pass":     return "✓";
    case "fail":     return "✗";
    default:         return "?";
  }
}

function fmtMs(ms: number): string {
  return ms > 0 ? `${(ms / 1000).toFixed(1)}s` : "n/a";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n══════════════════════════════════════════");
  console.log("  Harvey PK — LLM System Audit");
  console.log("══════════════════════════════════════════\n");

  // ── Environment validation ────────────────────────────────────────────────
  let envOk = true;
  try {
    validateEnvironment();
    console.log("  ✓  Environment variables OK\n");
  } catch (err) {
    console.log(`  ~  Environment warning: ${err instanceof Error ? err.message : err}\n`);
    envOk = false;
  }

  // ── Provider tests (parallel) ─────────────────────────────────────────────
  console.log("  Running provider probes (parallel)…");
  const [claude, gemini, manus] = await Promise.all([
    testClaude(),
    testGemini(),
    testManus(),
  ]);
  const providers = [claude, gemini, manus];

  // ── Router test ───────────────────────────────────────────────────────────
  const routerResult = auditRouter("legal_deep", providers);

  // ── IRAC pipeline test ────────────────────────────────────────────────────
  let iracResult: IracAuditResult = { ok: false, latency_ms: 0, error: "skipped" };
  if (!flags["skip-irac"]) {
    console.log("  Running IRAC pipeline test…");
    iracResult = await testIracPipeline();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // OUTPUT REPORT
  // ─────────────────────────────────────────────────────────────────────────

  console.log("\n────────────────────────────────────────");
  console.log("  LLM SYSTEM AUDIT");
  console.log("────────────────────────────────────────\n");

  // Providers
  console.log("  Providers");
  for (const p of providers) {
    const icon   = statusIcon(p.status);
    const lat    = fmtMs(p.latency_ms);
    const label  = capitalize(p.provider).padEnd(8);
    const status = p.status.padEnd(9);

    if (p.status === "skipped") {
      console.log(`  -  ${label} → skipped   (${p.error})`);
    } else if (p.status === "down") {
      console.log(`  ✗  ${label} → ${status} (${lat})  error: ${p.error}`);
    } else {
      const checks = [
        `json=${p.json_valid ? "✓" : "✗"}`,
        `reasoning=${p.reasoning_correct ? "✓" : "✗"}`,
        `token=${p.token_correct ? "✓" : "✗"}`,
      ].join("  ");
      console.log(`  ${icon}  ${label} → ${status} (${lat})  ${checks}  [${p.model}]`);
    }
  }

  // Router
  console.log("\n  Router  (task: legal_deep)");
  console.log(`  ${statusIcon(routerResult.status)}  Primary provider:  ${routerResult.primary}`);
  console.log(`       Fallback chain:  ${routerResult.fallbacks.join(" → ")}`);
  if (routerResult.selected) {
    if (routerResult.fallback_used) {
      console.log(`  ~    Would use fallback: ${routerResult.selected}  (primary is unavailable)`);
    } else {
      console.log(`  ✓    Would route to:     ${routerResult.selected}  (primary is healthy)`);
    }
    console.log(`  ✓  Status: PASS`);
  } else {
    console.log(`  ✗  No eligible provider — cannot route legal_deep requests`);
    console.log(`  ✗  Status: FAIL`);
  }

  // IRAC pipeline
  console.log("\n  IRAC Pipeline");
  if (flags["skip-irac"]) {
    console.log("  -  Skipped (--skip-irac flag)");
  } else if (iracResult.ok && iracResult.result) {
    const r = iracResult.result;
    console.log(`  ✓  Status: PASS  (${fmtMs(iracResult.latency_ms)})`);
    console.log(`       Fields:     issue ✓  rule ✓  application ✓  conclusion ✓  citations ✓`);
    console.log(`       Citations:  ${r.citations.length} found`);
    if (r.citations.length > 0) {
      const c = r.citations[0];
      console.log(`       First cite: ${c.act_name} § ${c.section_number}`);
    }
    const issueSummary = r.issue.length > 90 ? r.issue.slice(0, 90) + "…" : r.issue;
    console.log(`       Issue:      ${issueSummary}`);
  } else {
    console.log(`  ✗  Status: FAIL`);
    if (iracResult.error) {
      console.log(`       Error: ${iracResult.error}`);
    }
  }

  // Overall
  const iracPass      = flags["skip-irac"] ? true : iracResult.ok;
  const routerPass    = routerResult.status === "pass";
  const anyProviderUp = providers.some((p) => p.status === "healthy" || p.status === "degraded");
  const overallPass   = routerPass && iracPass && anyProviderUp;

  console.log("\n  Overall System Status");
  if (overallPass) {
    console.log("  ✓  PASS\n");
  } else {
    console.log("  ✗  FAIL");
    const failures: string[] = [];
    if (!anyProviderUp) failures.push("all providers are down or skipped");
    if (!routerPass)    failures.push("router cannot serve legal_deep requests");
    if (!iracPass)      failures.push(`IRAC pipeline: ${iracResult.error ?? "failed"}`);
    if (!envOk)         failures.push("environment variables incomplete");
    for (const f of failures) console.log(`     • ${f}`);
    console.log("");
  }

  console.log("════════════════════════════════════════\n");
  process.exit(overallPass ? 0 : 1);
}

main().catch((err) => {
  console.error("\n  ✗  Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
