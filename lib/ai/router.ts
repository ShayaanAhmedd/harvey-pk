// lib/ai/router.ts
//
// Policy-driven multi-provider AI orchestration layer with circuit breaker.
//
// Execution layers (outermost → innermost):
//   1. Circuit breaker  — skips providers whose error rate is too high.
//   2. Fallback chain   — tries candidates in policy order.
//   3. Retry layer      — withRetry() handles 429 back-off per candidate.
//   4. Provider adapter — normalises call params to each provider's API.
//
// Design principles:
//   1. Provider selection is driven by task type, not mode strings.
//   2. Fallbacks activate ONLY on transient failures (rate_limit, timeout,
//      network, server_error, provider_outage). Hard failures (billing,
//      invalid_api_key, model_not_found) propagate immediately — falling
//      back to another provider would produce wrong answers from the
//      wrong model and mask the real configuration error.
//   3. withRetry() exhausts 429 back-off before the fallback chain is tried,
//      so a momentary rate limit does not burn through the entire provider list.
//   4. Circuit breaker sits above withRetry: all retries count as ONE provider
//      attempt. A provider is skipped entirely once its circuit is open.
//   5. All errors are wrapped in ProviderCallError before leaving this file.
//   6. Every request produces one structured log entry — never per-token noise.
//
// Integration:
//   import { routeAIRequest, type TaskType } from "@/lib/ai/router"

import { callClaude as callClaudeLib } from "@/lib/claude";
import { callGemini }                  from "./gemini";
import { callManus }                   from "./manus";
import {
  ProviderCallError,
  ProviderError,
  ProviderErrorType,
  createProviderError,
  withRetry,
} from "./types";

// ── Provider names ────────────────────────────────────────────────────────────

export type ProviderName = "claude" | "gemini" | "manus";

// ── Capability registry ───────────────────────────────────────────────────────
//
// Describes each provider's strengths. Used for documentation and future
// dynamic routing. Currently the routing policy table is the authoritative
// source of provider selection.

interface ProviderCapability {
  reasoning:  "high" | "medium" | "low";
  cost:       "high" | "medium" | "low";
  latency:    "fast" | "medium" | "slow";
  legalDepth: boolean;   // supports deep juridical memoranda
  drafting:   boolean;   // optimised for document drafting
}

export const PROVIDER_CAPABILITIES: Record<ProviderName, ProviderCapability> = {
  claude: { reasoning: "high",   cost: "medium", latency: "slow",   legalDepth: true,  drafting: false },
  gemini: { reasoning: "medium", cost: "low",    latency: "fast",   legalDepth: false, drafting: false },
  manus:  { reasoning: "medium", cost: "medium", latency: "medium", legalDepth: false, drafting: true  },
};

// ── Task types ────────────────────────────────────────────────────────────────
//
// Callers express WHAT they need, not WHICH provider to use.
// The routing policy table maps task → provider.

export type TaskType =
  | "legal_deep"       // Full juridical memorandum with statutory depth
  | "casual"           // Conversational / greeting / meta-question
  | "crosscheck"       // Independent cross-validation by a second model
  | "draft"            // Formal legal document drafting
  | "summarization"    // Document or section summary
  | "high_reasoning";  // Complex multi-step analytical problem

// ── Routing policy table ──────────────────────────────────────────────────────
//
// Immutable mapping of task → primary provider + ordered fallback chain.
// Fallbacks are tried in array order only when the error is transient.
// Hard errors (billing, invalid key, model not found) skip the chain entirely.

interface RoutingPolicy {
  primary:   ProviderName;
  fallbacks: ProviderName[];
}

const ROUTING_POLICY: Readonly<Record<TaskType, RoutingPolicy>> = {
  legal_deep:     { primary: "claude", fallbacks: ["gemini"         ] },
  casual:         { primary: "claude", fallbacks: ["gemini"         ] },
  crosscheck:     { primary: "gemini", fallbacks: ["claude"         ] },
  draft:          { primary: "manus",  fallbacks: ["claude", "gemini"] },
  summarization:  { primary: "gemini", fallbacks: ["claude"         ] },
  high_reasoning: { primary: "claude", fallbacks: ["gemini"         ] },
};

// ── Fallback policy ───────────────────────────────────────────────────────────
//
// TRANSIENT errors → fallback allowed. The provider is temporarily
//   unavailable but a different provider may serve the request successfully.
//
// PERMANENT errors → fallback BLOCKED. The error reflects a configuration
//   or account problem. Routing to another provider would silently hide the
//   issue and return an answer from the wrong model or context.

const FALLBACK_ALLOWED: ReadonlySet<ProviderErrorType> = new Set([
  "rate_limit",
  "timeout",
  "network",
  "server_error",
  "provider_outage",
]);

const FALLBACK_BLOCKED: ReadonlySet<ProviderErrorType> = new Set([
  "invalid_api_key",
  "billing",
  "model_not_found",
  "forbidden",
]);

// ── Circuit breaker ───────────────────────────────────────────────────────────
//
// Process-level singleton per provider. Resets on server restart (acceptable
// for in-memory circuit state — persistent circuit state would require Redis
// and is out of scope).
//
// Node.js is single-threaded: all mutations here are atomic within a tick.
// Concurrent requests interleave only at await boundaries, and there are none
// inside isCircuitOpen / recordFailure / resetCircuit. No locking is needed.
//
// Circuit states:
//   Closed  — circuitOpenUntil === null. Requests pass through normally.
//   Open    — circuitOpenUntil > Date.now(). Provider is skipped entirely.
//   Expired — circuitOpenUntil <= Date.now(). Timer has elapsed; next check
//             resets to Closed and allows the request through as a probe.
//             If the probe fails, the failure counter starts from scratch.
//
// Failure window (sliding):
//   Only failures within the last CIRCUIT_WINDOW_MS contribute to the
//   threshold. A gap larger than the window resets the counter before
//   incrementing. This prevents a burst from two hours ago from contributing
//   to a circuit open now.
//
// Which errors trip the circuit:
//   Only CIRCUIT_TRIPPABLE types — transient provider health signals.
//   Hard config errors (billing, invalid_api_key, model_not_found, forbidden)
//   are excluded: they must surface to the operator immediately, not be hidden
//   behind circuit-breaker silence.

const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_WINDOW_MS = 60_000;  // sliding window for failure counting
const CIRCUIT_OPEN_MS   = 60_000;  // how long circuit stays open after tripping

const CIRCUIT_TRIPPABLE: ReadonlySet<ProviderErrorType> = new Set([
  "rate_limit",
  "timeout",
  "network",
  "server_error",
  "provider_outage",
]);

interface CircuitState {
  failureCount:     number;
  lastFailureTs:    number;        // epoch ms of most recent trippable failure
  circuitOpenUntil: number | null; // null = circuit closed
}

// Initialised at module load time. Safe to mutate directly — see threading note.
const circuitState: Record<ProviderName, CircuitState> = {
  claude: { failureCount: 0, lastFailureTs: 0, circuitOpenUntil: null },
  gemini: { failureCount: 0, lastFailureTs: 0, circuitOpenUntil: null },
  manus:  { failureCount: 0, lastFailureTs: 0, circuitOpenUntil: null },
};

/**
 * Returns true when the provider's circuit is open (caller must skip it).
 *
 * Side-effect: if the open timer has elapsed, resets state to Closed and
 * returns false, allowing the next request to act as a recovery probe.
 * The reset only touches the module-level record — no I/O, no await.
 */
function isCircuitOpen(provider: ProviderName): boolean {
  const state = circuitState[provider];
  if (state.circuitOpenUntil === null) return false;

  if (Date.now() >= state.circuitOpenUntil) {
    // Timer expired — reset fully and allow probe request through.
    state.circuitOpenUntil = null;
    state.failureCount     = 0;
    state.lastFailureTs    = 0;
    routerLog("info", "router.circuitExpired", {
      provider,
      note: "Open timer elapsed — reset to Closed, next request is recovery probe",
    });
    return false;
  }

  return true;
}

/**
 * Records a trippable failure against the provider's circuit counter.
 * No-op for error types outside CIRCUIT_TRIPPABLE (billing, invalid_api_key,
 * model_not_found — those are hard failures handled separately by the router).
 *
 * Called AFTER withRetry has already exhausted its retry budget, so one call
 * here represents the full retry sequence (initial attempt + up to 2 retries),
 * not individual HTTP requests. This prevents retry storms from over-counting.
 */
function recordFailure(provider: ProviderName, errType: ProviderErrorType): void {
  if (!CIRCUIT_TRIPPABLE.has(errType)) return;

  const now   = Date.now();
  const state = circuitState[provider];

  // Sliding window: reset counter if the previous failure is outside the window.
  if (state.lastFailureTs > 0 && (now - state.lastFailureTs) > CIRCUIT_WINDOW_MS) {
    state.failureCount = 0;
  }

  state.failureCount++;
  state.lastFailureTs = now;

  if (state.failureCount >= CIRCUIT_THRESHOLD && state.circuitOpenUntil === null) {
    const reopenAt = now + CIRCUIT_OPEN_MS;
    state.circuitOpenUntil = reopenAt;
    routerLog("error", "router.circuitOpened", {
      provider,
      failureCount: state.failureCount,
      windowMs:     CIRCUIT_WINDOW_MS,
      openMs:       CIRCUIT_OPEN_MS,
      reopenAt:     new Date(reopenAt).toISOString(),
    });
  }
}

/**
 * Resets the circuit to Closed on a successful call.
 * Emits router.circuitClosed only when there was prior failure state to clear,
 * keeping the log silent on every healthy request.
 */
function resetCircuit(provider: ProviderName): void {
  const state   = circuitState[provider];
  const wasOpen = state.circuitOpenUntil !== null || state.failureCount > 0;

  state.failureCount     = 0;
  state.lastFailureTs    = 0;
  state.circuitOpenUntil = null;

  if (wasOpen) {
    routerLog("info", "router.circuitClosed", { provider });
  }
}

// ── Common call params ────────────────────────────────────────────────────────

export interface ProviderCallParams {
  question:     string;
  contextText:  string;
  systemPrompt?: string;   // used by Claude; Gemini/Manus use own internal prompts
  maxTokens:    number;
  temperature:  number;
}

// ── Routing result ────────────────────────────────────────────────────────────

export interface AIRoutingResult {
  result:       string;
  providerUsed: ProviderName;
  fallbackUsed: boolean;
  attempts:     number;
  latencyMs:    number;
  errors:       ProviderError[];  // all errors encountered before success
}

// ── Structured logger ─────────────────────────────────────────────────────────
//
// Single-line JSON — wire-compatible with log aggregators (Datadog, Loki, etc.).
// Outputs to stdout only. No sensitive data (keys, content) is logged.

type LogLevel = "info" | "warn" | "error";

function routerLog(
  level:   LogLevel,
  event:   string,
  payload: Record<string, unknown> = {}
): void {
  const entry  = { ts: new Date().toISOString(), level, event, ...payload };
  const method = level === "error" ? console.error
               : level === "warn"  ? console.warn
               : console.log;
  method(JSON.stringify(entry));
}

// ── Error wrapping ────────────────────────────────────────────────────────────
//
// Normalises any thrown value into a ProviderCallError.
// Recovers the HTTP status from:
//   - SDK typed errors (APIError from @anthropic-ai/sdk) via .status
//   - Text-based re-throws from lib/claude.ts ("rate_limit", "model_not_found", etc.)
//   - Numeric patterns in error messages ("Gemini 429: ...", "Manus 404: ...")

function inferStatus(err: unknown): number | null {
  const sdkStatus =
    (err as { status?: number })?.status ??
    (err as { statusCode?: number })?.statusCode ??
    null;
  if (sdkStatus != null) return sdkStatus;

  const msg = err instanceof Error ? err.message : String(err);
  // lib/claude.ts re-throws text codes — map back to HTTP status
  if (msg === "invalid_api_key")        return 401;
  if (msg === "model_not_found")        return 404;
  if (msg === "rate_limit")             return 429;
  if (msg.startsWith("Claude API error ")) {
    const n = parseInt(msg.replace("Claude API error ", ""), 10);
    return isNaN(n) ? null : n;
  }
  // Numeric status embedded in message: "Gemini 429: ...", "Manus 404 ..."
  const match = /\b([45]\d{2})\b/.exec(msg);
  return match ? parseInt(match[1], 10) : null;
}

function wrapError(provider: ProviderName, err: unknown): ProviderCallError {
  if (err instanceof ProviderCallError) return err;
  const msg    = err instanceof Error ? err.message : String(err);
  const status = inferStatus(err);
  const pErr   = createProviderError(provider, status, msg,
    (err as { requestID?: string })?.requestID ?? null
  );
  return new ProviderCallError(msg, pErr);
}

// ── Provider adapters ─────────────────────────────────────────────────────────
//
// Each adapter bridges ProviderCallParams to the provider's own call signature.
// Adapters always throw ProviderCallError — never raw errors.

async function claudeAdapter(params: ProviderCallParams): Promise<string> {
  const { question, contextText, systemPrompt, maxTokens, temperature } = params;
  const userContent = contextText
    ? `Question:\n${question}\n\nStatutory Context:\n${contextText}`
    : `Question:\n${question}`;
  try {
    return await callClaudeLib(
      [{ role: "user", content: userContent }],
      { system: systemPrompt, max_tokens: maxTokens, temperature }
    );
  } catch (err) {
    throw wrapError("claude", err);
  }
}

async function geminiAdapter(params: ProviderCallParams): Promise<string> {
  try {
    return await callGemini(params.question, params.contextText);
  } catch (err) {
    throw wrapError("gemini", err);
  }
}

async function manusAdapter(params: ProviderCallParams): Promise<string> {
  try {
    return await callManus(params.question, params.contextText);
  } catch (err) {
    throw wrapError("manus", err);
  }
}

const ADAPTERS: Record<ProviderName, (p: ProviderCallParams) => Promise<string>> = {
  claude: claudeAdapter,
  gemini: geminiAdapter,
  manus:  manusAdapter,
};

// ── Main router ───────────────────────────────────────────────────────────────
//
// Execution flow:
//
//   1. Look up routing policy for the task type.
//   2. Build the candidate list: [primary, ...fallbacks].
//   3. For each candidate:
//      a. isCircuitOpen(provider) → if open, log and skip to next candidate.
//      b. Call withRetry(adapter) — this handles 429 back-off internally.
//         All retries count as ONE provider attempt for circuit purposes.
//      c. On success:
//           - resetCircuit(provider) to clear any prior failure state.
//           - Return AIRoutingResult immediately.
//      d. On ProviderCallError:
//           - recordFailure(provider, errType) — increments circuit counter
//             for CIRCUIT_TRIPPABLE types; no-op for hard errors.
//           - If FALLBACK_BLOCKED → throw immediately (permanent failure).
//           - If FALLBACK_ALLOWED (or unknown) → record error, try next candidate.
//   4. If all candidates exhausted (or skipped by open circuits) → throw last error.
//
// Loop termination: `candidates` is a finite, deduplicated array derived from
// the static ROUTING_POLICY table. Each entry is visited at most once.
// Circuit-skipped entries are counted in `attempt` to keep logging coherent.

export async function routeAIRequest(
  taskType: TaskType,
  params:   ProviderCallParams
): Promise<AIRoutingResult> {
  const policy     = ROUTING_POLICY[taskType];
  const candidates = [policy.primary, ...policy.fallbacks];
  const totalStart = Date.now();
  const errors: ProviderError[] = [];
  let attempt = 0;
  let lastError: ProviderCallError | null = null;

  routerLog("info", "router.request", {
    taskType,
    primaryProvider: policy.primary,
    candidateCount:  candidates.length,
  });

  for (const provider of candidates) {
    attempt++;

    // ── Circuit breaker gate ─────────────────────────────────────────────────
    // Check before any I/O. If open, skip this provider entirely.
    // isCircuitOpen() auto-resets expired circuits (no await — purely synchronous).
    if (isCircuitOpen(provider)) {
      const state = circuitState[provider];
      routerLog("warn", "router.circuitSkip", {
        taskType,
        provider,
        attempt,
        reopenAt: state.circuitOpenUntil
          ? new Date(state.circuitOpenUntil).toISOString()
          : null,
      });
      continue;
    }

    const providerStart = Date.now();

    try {
      // ── Retry layer ─────────────────────────────────────────────────────────
      // withRetry handles 429 back-off internally (up to 2 retries: 1s, 2s).
      // The circuit sees this entire sequence as a single provider attempt.
      const result = await withRetry(
        () => ADAPTERS[provider](params),
        { maxRetries: 2, initialDelayMs: 1_000 }
      );

      const latencyMs         = Date.now() - totalStart;
      const providerLatencyMs = Date.now() - providerStart;
      const fallbackUsed      = provider !== policy.primary;

      // Success: reset circuit state (logs only when there was prior failure).
      resetCircuit(provider);

      routerLog("info", "router.success", {
        taskType,
        provider,
        fallbackUsed,
        attempt,
        latencyMs,
        providerLatencyMs,
      });

      return {
        result,
        providerUsed: provider,
        fallbackUsed,
        attempts:     attempt,
        latencyMs,
        errors,
      };

    } catch (err: unknown) {
      const pce  = err instanceof ProviderCallError ? err : wrapError(provider, err);
      const pErr = pce.providerErr;

      errors.push(pErr);
      lastError = pce;

      // ── Circuit failure recording ────────────────────────────────────────────
      // Called after withRetry has exhausted its budget, so this represents the
      // final outcome of the full retry sequence — not individual HTTP attempts.
      // No-op for hard-failure types (billing, invalid_api_key, etc.) since those
      // are not in CIRCUIT_TRIPPABLE and must surface to the operator immediately.
      recordFailure(provider, pErr.type);

      routerLog(
        FALLBACK_BLOCKED.has(pErr.type) ? "error" : "warn",
        "router.providerError",
        {
          taskType,
          provider,
          attempt,
          status:    pErr.status,
          errorType: pErr.type,
          requestId: pErr.request_id,
          message:   pErr.message,
        }
      );

      // ── Hard failure: propagate immediately ──────────────────────────────────
      // Billing and auth errors must surface to the caller. Routing around them
      // would produce an answer from the wrong model and mask the root cause.
      if (FALLBACK_BLOCKED.has(pErr.type)) {
        routerLog("error", "router.hardFailure", {
          taskType,
          provider,
          errorType:     pErr.type,
          reason:        "Permanent error — fallback suppressed",
          totalAttempts: attempt,
          latencyMs:     Date.now() - totalStart,
        });
        throw pce;
      }

      // ── Transient failure: fall through to next candidate ────────────────────
      const nextProvider = candidates[attempt]; // attempt was post-incremented
      if (!nextProvider) {
        routerLog("error", "router.chainExhausted", {
          taskType,
          attempts:  attempt,
          latencyMs: Date.now() - totalStart,
        });
        throw pce;
      }

      routerLog("warn", "router.fallback", {
        taskType,
        from:      provider,
        to:        nextProvider,
        errorType: pErr.type,
        attempt,
      });
    }
  }

  // All candidates were either skipped (circuit open) or exhausted.
  // lastError is set whenever a candidate failed; it's null only if every
  // provider was circuit-skipped, in which case we synthesise a sentinel error.
  if (lastError) throw lastError;

  routerLog("error", "router.allCircuitsOpen", {
    taskType,
    candidates,
    latencyMs: Date.now() - totalStart,
  });
  throw new ProviderCallError(
    "[router] All providers circuit-open — no candidates available",
    {
      provider:   policy.primary,
      status:     null,
      type:       "provider_outage",
      request_id: null,
      message:    "All providers in the fallback chain have open circuits",
    }
  );
}
