// Legacy server-only Supabase client.
//
// Used by the existing API routes (upload, query, cases, test).
// These routes will be migrated to use lib/supabase/server.ts in
// Phase 3 (API layer) so they become session-aware and enforce RLS.
//
// For now, this client is kept to prevent breaking changes during
// the auth phase. The env var fallback supports both naming
// conventions during the transition.

import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  (process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL)!,
  (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY)!
);
