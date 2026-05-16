// lib/utils/network-errors.ts
//
// Network and gateway error detection utilities.
// Used by all scripts and API routes to surface actionable diagnostics
// instead of raw error objects.

export interface GatewayError {
  type:    "gateway_error";
  message: string;
}

// Signals that indicate an upstream gateway / proxy failure
const GATEWAY_SIGNALS = [
  "502",
  "bad gateway",
  "cloudflare",
  "upstream connect error",
  "service unavailable",
  "503",
] as const;

/**
 * Inspects an unknown thrown value for Cloudflare / gateway error signals.
 *
 * Returns a structured GatewayError when the error looks like a 502/503/
 * Cloudflare failure, or null when the error is unrelated.
 *
 * Usage:
 *   catch (err) {
 *     const gw = detectGatewayError(err);
 *     if (gw) {
 *       console.error(gw.message);
 *     } else {
 *       console.error("API request failed:", err instanceof Error ? err.message : err);
 *     }
 *     throw err;
 *   }
 */
export function detectGatewayError(error: unknown): GatewayError | null {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
      ? error
      : JSON.stringify(error);

  const lower = raw.toLowerCase();

  if (GATEWAY_SIGNALS.some((s) => lower.includes(s))) {
    return {
      type:    "gateway_error",
      message: "Upstream service unavailable (Cloudflare 502). Retry later.",
    };
  }

  return null;
}

/**
 * Formats any thrown value into a stable human-readable message string.
 * Safe to pass directly to console.error or logger.
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

/**
 * Wraps an async operation with structured gateway-error detection.
 * Re-throws the original error after logging.
 */
export async function withGatewayErrorHandling<T>(
  label:  string,
  fn:     () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const gateway = detectGatewayError(error);
    if (gateway) {
      console.error(`[${label}] ${gateway.message}`);
    } else {
      console.error(`[${label}] API request failed: ${formatError(error)}`);
    }
    throw error;
  }
}
