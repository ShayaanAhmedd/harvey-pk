// lib/claude.ts
//
// Anthropic SDK — lazily initialised, environment-driven model selection.
//
// Model resolution order:
//   1. process.env.CLAUDE_MODEL  (set in .env.local)
//   2. "claude-3-5-sonnet-20241022" (stable pinned release — never an alias)
//
// ── CRITICAL: ANTHROPIC_BASE_URL ─────────────────────────────────────────────
//
// The SDK constructor reads ANTHROPIC_BASE_URL from process.env automatically
// (src/client.ts line 368: `baseURL = readEnv('ANTHROPIC_BASE_URL')`).
//
// Next.js does NOT override OS-level environment variables with .env.local
// values. If ANTHROPIC_BASE_URL is set anywhere in the Windows system
// environment, shell profile, or CI secrets, it silently redirects every
// Anthropic API call to the wrong endpoint and returns 404 on all models.
//
// Fix: we always pass `baseURL` explicitly to the constructor.
// The SDK's env-read is then bypassed entirely for our client.
//
// Server-only. Never import from client components.

import Anthropic, { APIError } from "@anthropic-ai/sdk";

const ANTHROPIC_OFFICIAL_BASE = "https://api.anthropic.com";

// ── Singleton client ──────────────────────────────────────────────────────────

let _client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (_client) return _client;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured.");

  // Determine effective base URL.
  // We read the env var ourselves so we can log it and decide explicitly —
  // rather than letting the SDK read it silently.
  const envBaseURL = process.env.ANTHROPIC_BASE_URL?.trim() || null;
  const baseURL    = envBaseURL || ANTHROPIC_OFFICIAL_BASE;

  if (envBaseURL && envBaseURL !== ANTHROPIC_OFFICIAL_BASE) {
    console.warn(
      `[claude] ANTHROPIC_BASE_URL is set to "${envBaseURL}". ` +
      `All Anthropic API requests are going to a NON-OFFICIAL endpoint. ` +
      `This is the most common cause of 404 on all models. ` +
      `To fix: unset ANTHROPIC_BASE_URL in your OS environment, shell profile, ` +
      `and Windows System Environment Variables, then restart your terminal and dev server.`
    );
  }

  // Always pass baseURL explicitly so the SDK cannot pick up a stale OS-level
  // ANTHROPIC_BASE_URL that overrides what .env.local intends.
  _client = new Anthropic({ apiKey, baseURL });

  console.log(
    `[claude] client initialised — baseURL=${baseURL} model=${getClaudeModel()} key=${apiKey.slice(0, 12)}…`
  );

  return _client;
}

// Reset singleton — call this if you change env vars at runtime (tests only).
export function resetAnthropicClient(): void {
  _client = null;
}

// ── Active model ──────────────────────────────────────────────────────────────

export function getClaudeModel(): string {
  // Always prefer an explicit pinned model ID over aliases ("latest" requires
  // alias resolution on Anthropic's side, which can be account-tier restricted).
  return process.env.CLAUDE_MODEL ?? "claude-3-5-sonnet-20241022";
}

// ── Model discovery ───────────────────────────────────────────────────────────

export async function listAvailableModels(): Promise<string[]> {
  try {
    const client = getAnthropicClient();
    const page   = await client.models.list({ limit: 50 });
    return page.data.map((m: { id: string }) => m.id);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[claude] listAvailableModels failed:", msg);
    return [];
  }
}

// ── Full diagnostic ────────────────────────────────────────────────────────────
//
// Returns the exact runtime state of the Anthropic integration.
// Called by GET /api/ai-health — never in hot request paths.
//
// Use this to answer: "Why am I getting 404 on all models?"
//   - baseURL shows where requests are actually going
//   - apiKeyPrefix confirms the key loaded at runtime (first 12 chars, safe to log)
//   - modelsAvailable shows which models the account/workspace can access
//   - envBaseURLRaw shows the raw OS env value — if non-empty and wrong, that's the bug

export interface ClaudeDiagnostic {
  apiKeyConfigured:  boolean;
  apiKeyPrefix:      string;
  baseURL:           string;
  envBaseURLRaw:     string | null;
  baseURLOverridden: boolean;
  configuredModel:   string;
  modelAccessible:   boolean;
  modelsAvailable:   string[];
  modelsError:       string | null;
  testCallResult:    "ok" | string;
}

export async function diagnoseClaude(): Promise<ClaudeDiagnostic> {
  const apiKey      = process.env.ANTHROPIC_API_KEY ?? null;
  const envBaseURL  = process.env.ANTHROPIC_BASE_URL?.trim() || null;
  const baseURL     = envBaseURL || ANTHROPIC_OFFICIAL_BASE;
  const model       = getClaudeModel();

  const result: ClaudeDiagnostic = {
    apiKeyConfigured:  !!apiKey,
    apiKeyPrefix:      apiKey ? `${apiKey.slice(0, 12)}…` : "(none)",
    baseURL,
    envBaseURLRaw:     envBaseURL,
    baseURLOverridden: !!envBaseURL,
    configuredModel:   model,
    modelAccessible:   false,
    modelsAvailable:   [],
    modelsError:       null,
    testCallResult:    "not_run",
  };

  if (!apiKey) {
    result.testCallResult = "skipped — no API key";
    return result;
  }

  // Step 1: List available models
  try {
    const client = getAnthropicClient();
    const page   = await client.models.list({ limit: 50 });
    result.modelsAvailable = page.data.map((m) => m.id);
    result.modelAccessible = result.modelsAvailable.includes(model);
  } catch (err: unknown) {
    result.modelsError = err instanceof APIError
      ? `APIError status=${err.status} request_id=${err.requestID ?? "none"}: ${err.message}`
      : (err instanceof Error ? err.message : String(err));
  }

  // Step 2: Minimal test call to confirm messages endpoint works
  try {
    const client = getAnthropicClient();
    await client.messages.create({
      model,
      max_tokens: 5,
      messages:   [{ role: "user", content: "hi" }],
    });
    result.testCallResult = "ok";
  } catch (err: unknown) {
    result.testCallResult = err instanceof APIError
      ? `APIError status=${err.status} request_id=${err.requestID ?? "none"}: ${err.message}`
      : (err instanceof Error ? err.message : String(err));
  }

  console.log("[claude:diagnose]", JSON.stringify(result, null, 2));
  return result;
}

// ── Reusable call function ────────────────────────────────────────────────────

export interface ClaudeCallOptions {
  system?:      string;
  max_tokens?:  number;
  temperature?: number;
}

export async function callClaude(
  messages: Anthropic.MessageParam[],
  options:  ClaudeCallOptions = {}
): Promise<string> {
  const model      = getClaudeModel();
  const max_tokens = options.max_tokens ?? 4000;

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens,
    temperature: options.temperature ?? 0.2,
    messages,
    ...(options.system ? { system: options.system } : {}),
  };

  try {
    const client   = getAnthropicClient();
    const response = await client.messages.create(params);

    const textBlock = response.content.find((c) => c.type === "text");
    const text      = textBlock?.type === "text" ? textBlock.text : "";
    if (!text) throw new Error("Claude returned no text content.");
    return text;

  } catch (error: unknown) {
    if (error instanceof APIError) {
      // Log the full structured error — status, request_id, and the exact URL
      // the request went to (via the client's baseURL) are critical for diagnosis.
      console.error(
        `[claude] APIError — status=${error.status} ` +
        `request_id=${error.requestID ?? "none"} ` +
        `model=${model} ` +
        `baseURL=${_client?.baseURL ?? "unknown"}:`,
        error.message
      );
      if (error.status === 401) throw new Error("invalid_api_key");
      if (error.status === 404) throw new Error("model_not_found");
      if (error.status === 429) throw new Error("rate_limit");
      throw new Error(`Claude API error ${error.status}`);
    }

    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[claude] call failed [model=${model}]:`, msg);
    throw new Error("Claude API call failed");
  }
}
