// lib/ai/types.ts
//
// Shared types, error normalisation, and utilities for all AI providers.
//
// Imported by: healthcheck, router, provider call functions.
// Never import into client components — server-only.

// ── Normalised provider error ──────────────────────────────────────────────────

export type ProviderErrorType =
  | "invalid_api_key"   // 401
  | "billing"           // 402 / insufficient_quota
  | "forbidden"         // 403
  | "model_not_found"   // 404
  | "rate_limit"        // 429
  | "server_error"      // 5xx
  | "timeout"           // AbortError / ETIMEDOUT
  | "network"           // Fetch failed, no response
  | "no_content"        // API returned 200 but no usable text
  | "provider_outage"   // Sustained 5xx / service unavailable
  | "unknown";

export interface ProviderError {
  provider:   string;
  status:     number | null;
  type:       ProviderErrorType;
  request_id: string | null;
  message:    string;
}

// ── ProviderCallError ──────────────────────────────────────────────────────────
//
// Structured error thrown by provider adapters inside the router.
// Extends Error so it works with try/catch and instanceof checks.
// Exposes `.status` so withRetry() can identify 429s.
// Exposes `.errType` so the router's fallback policy can inspect the error
// without string-matching — critical for correct hard-failure detection.

export class ProviderCallError extends Error {
  constructor(
    message:               string,
    public readonly providerErr: ProviderError
  ) {
    super(message);
    this.name = "ProviderCallError";
    // Restore prototype chain (required when extending Error in TypeScript)
    Object.setPrototypeOf(this, ProviderCallError.prototype);
  }

  /** HTTP status code — used by withRetry() to detect 429. */
  get status():  number | null      { return this.providerErr.status; }

  /** Normalised error type — used by router fallback policy. */
  get errType(): ProviderErrorType  { return this.providerErr.type; }
}

// ── Error classification ──────────────────────────────────────────────────────

export function classifyProviderError(
  status:  number | null,
  message: string
): ProviderErrorType {
  const m = message.toLowerCase();

  if (status === 401 || m.includes("invalid_api_key") || m.includes("authentication_error")) return "invalid_api_key";
  if (status === 402 || m.includes("insufficient_quota") || m.includes("billing")           ) return "billing";
  if (status === 403 || m.includes("forbidden") || m.includes("permission_denied")          ) return "forbidden";
  if (status === 404 || m.includes("model_not_found") || m.includes("not_found_error")      ) return "model_not_found";
  if (status === 429 || m.includes("rate_limit") || m.includes("too_many_requests")         ) return "rate_limit";
  if (status === 503 || m.includes("service_unavailable") || m.includes("overloaded")       ) return "provider_outage";
  if (status != null && status >= 500                                                        ) return "server_error";
  if (m.includes("timeout") || m.includes("abort") || m.includes("timed out")               ) return "timeout";
  if (m.includes("fetch") || m.includes("network") || m.includes("econnrefused")            ) return "network";
  if (m.includes("no text") || m.includes("no content") || m.includes("no usable")         ) return "no_content";
  return "unknown";
}

export function createProviderError(
  provider:   string,
  status:     number | null,
  message:    string,
  request_id: string | null = null
): ProviderError {
  return {
    provider,
    status,
    type:       classifyProviderError(status, message),
    request_id,
    message,
  };
}

// ── Retry with exponential back-off ──────────────────────────────────────────
//
// Retries ONLY on rate-limit errors. Checks both `.status === 429` (for SDK
// errors that carry HTTP status) and `.errType === "rate_limit"` (for
// ProviderCallError instances where the status was inferred from a text
// message like lib/claude.ts's "rate_limit" string re-throw).
//
// All other errors are rethrown immediately so the router's fallback chain
// activates without delay.

export async function withRetry<T>(
  fn:      () => Promise<T>,
  options: { maxRetries?: number; initialDelayMs?: number } = {}
): Promise<T> {
  const { maxRetries = 2, initialDelayMs = 1_000 } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;

      const status =
        (err as { status?: number })?.status ??
        (err as { statusCode?: number })?.statusCode ??
        null;
      const errType = (err as { errType?: string })?.errType ?? null;
      const isRateLimit = status === 429 || errType === "rate_limit";

      if (!isRateLimit) throw err;

      if (attempt < maxRetries) {
        const delay = initialDelayMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

// ── Provider health status (shared with healthcheck) ─────────────────────────

export type ProviderStatus =
  | "ok"
  | "key_missing"
  | "invalid_api_key"
  | "billing"
  | "model_not_found"
  | "model_not_available"
  | "quota_exceeded"
  | "error";

export function statusFromError(err: ProviderError): ProviderStatus {
  switch (err.type) {
    case "invalid_api_key": return "invalid_api_key";
    case "billing":         return "quota_exceeded";
    case "model_not_found": return "model_not_found";
    case "rate_limit":      return "quota_exceeded";
    default:                return "error";
  }
}
