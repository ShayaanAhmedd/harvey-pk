"use client";

// ── Why the Suspense split? ────────────────────────────────────────────────
// Next.js 15+ requires any component that calls useSearchParams() to be
// wrapped in <Suspense>. Without it, Next.js skips client hydration for the
// component during static generation — the form renders as HTML but the
// onClick / onSubmit handlers NEVER attach, so submitting does nothing.
//
// Fix: extract the interactive part into <LoginForm> (which uses
// useSearchParams), and wrap it with <Suspense> in the default export.
// ─────────────────────────────────────────────────────────────────────────

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// ── Inner component — needs Suspense because of useSearchParams ───────────
function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirectTo") ?? "/";

  const supabase = createClient();

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      setError(signInError.message);
      setLoading(false);
      return;
    }

    // ── BUG FIX: router.refresh() BEFORE router.push() ───────────────────
    // router.push() starts navigating to the protected route.
    // If refresh() is called AFTER push(), Next.js may serve a cached
    // pre-login render of the layout (where getUser() returned null),
    // causing the dashboard layout to immediately redirect back to /login.
    // Calling refresh() FIRST invalidates the server-component cache so the
    // next navigation request hits the server with the new session.
    router.refresh();
    router.push(redirectTo);

    // ── BUG FIX: reset loading state on success ───────────────────────────
    // Previously missing — button stayed permanently disabled after login.
    setLoading(false);
  }

  return (
    <div className="w-full max-w-md bg-white rounded-lg shadow-md p-8">

      <h1 className="text-2xl font-bold text-gray-900 mb-1">Harvey PK</h1>
      <p className="text-sm text-gray-500 mb-8">Sign in to your account</p>

      <form onSubmit={handleSubmit} className="space-y-5">

        <div>
          <label
            htmlFor="email"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Email address
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            placeholder="you@example.com"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 placeholder-gray-400 focus:border-black focus:outline-none focus:ring-1 focus:ring-black text-sm"
          />
        </div>

        <div>
          <label
            htmlFor="password"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            placeholder="••••••••"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 placeholder-gray-400 focus:border-black focus:outline-none focus:ring-1 focus:ring-black text-sm"
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-black px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>

      </form>
    </div>
  );
}

// ── Page export — wraps LoginForm in Suspense ─────────────────────────────
// The fallback renders the same card shell so there is no layout shift
// while the client bundle loads.
export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="w-full max-w-md bg-white rounded-lg shadow-md p-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-1">Harvey PK</h1>
          <p className="text-sm text-gray-500">Loading…</p>
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
