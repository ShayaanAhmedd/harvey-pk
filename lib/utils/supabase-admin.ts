// lib/utils/supabase-admin.ts
//
// Hardened Supabase admin client factory.
// Validates environment, constructs the service-role client,
// and verifies the connection with a lightweight query before returning.
//
// Usage:
//   const supabase = await createAdminClient();

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { validateEnvironment } from "./env-validator";

// Auth-related Postgres/PostgREST error signatures
const AUTH_ERROR_SIGNALS = [
  "jwt",
  "invalid signature",
  "unauthorized",
  "permission denied",
  "auth",
  "401",
  "403",
] as const;

function isAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return AUTH_ERROR_SIGNALS.some((s) => lower.includes(s));
}

/**
 * Creates and validates a Supabase service-role client.
 *
 * Steps:
 *   1. Validates required environment variables (throws if any are missing).
 *   2. Constructs the Supabase client with the service role key.
 *   3. Runs a lightweight connectivity probe (SELECT id FROM legal_cases LIMIT 0).
 *      - Table-not-found → allowed (schema may be empty on first deploy).
 *      - Auth/JWT error  → throws "Supabase authentication failed…".
 *      - Other DB error  → throws with the original message.
 *
 * Returns the verified client.
 */
export async function createAdminClient(): Promise<SupabaseClient> {
  const env = validateEnvironment();

  const client = createClient(env.supabaseUrl, env.supabaseServiceKey, {
    auth: {
      persistSession:   false,
      autoRefreshToken: false,
    },
  });

  // Lightweight connectivity probe — limit 0 avoids returning any rows
  const { error } = await client
    .from("legal_cases")
    .select("id")
    .limit(0);

  if (error) {
    const msg = error.message ?? String(error);

    if (isAuthError(msg)) {
      throw new Error(
        "Supabase authentication failed. Check SUPABASE_SERVICE_ROLE_KEY. " +
        `(original: ${msg})`,
      );
    }

    // Table not found (PGRST116) is tolerated on a fresh deploy
    if (
      error.code !== "42P01" &&   // Postgres: undefined_table
      error.code !== "PGRST116"   // PostgREST: relation not found
    ) {
      throw new Error(`Supabase connectivity check failed: ${msg}`);
    }
  }

  return client;
}
