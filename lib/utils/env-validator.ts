// lib/utils/env-validator.ts
//
// Environment variable validator for all scripts and server-side modules.
// Supports both naming conventions used in this project:
//   NEXT_PUBLIC_SUPABASE_URL  or  SUPABASE_URL
//   SUPABASE_SERVICE_KEY      or  SUPABASE_SERVICE_ROLE_KEY

export interface ValidatedEnv {
  supabaseUrl:       string;
  supabaseServiceKey: string;
  openaiApiKey:      string;
  anthropicApiKey:   string | null;
}

/**
 * Validates all required environment variables.
 * Throws with a descriptive message if any required variable is absent.
 * Warns (but does not throw) for optional variables.
 *
 * Call once at script startup, before any API client is constructed.
 */
export function validateEnvironment(): ValidatedEnv {
  // Log current environment mode for diagnostics
  console.log(`[env] NODE_ENV=${process.env.NODE_ENV ?? "development"}`);

  // Support both Supabase URL naming conventions
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL;

  if (!supabaseUrl) {
    throw new Error(
      "Environment configuration error: missing required variable NEXT_PUBLIC_SUPABASE_URL",
    );
  }

  // Support both service key naming conventions
  const supabaseServiceKey =
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseServiceKey) {
    throw new Error(
      "Environment configuration error: missing required variable SUPABASE_SERVICE_KEY",
    );
  }

  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    throw new Error(
      "Environment configuration error: missing required variable OPENAI_API_KEY",
    );
  }

  // ANTHROPIC_API_KEY is optional — warn but continue
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? null;
  if (!anthropicApiKey) {
    console.warn(
      "[env] Warning: ANTHROPIC_API_KEY is not set. Claude API calls will fail at runtime.",
    );
  }

  return { supabaseUrl, supabaseServiceKey, openaiApiKey, anthropicApiKey };
}
