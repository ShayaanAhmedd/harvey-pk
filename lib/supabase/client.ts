// Browser-side Supabase client.
// Use this in Client Components ("use client") only.
// Creates a new client per call — memoized internally by @supabase/ssr.
import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
