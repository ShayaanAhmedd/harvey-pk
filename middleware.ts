// Next.js Edge Middleware — runs before every request.
//
// Responsibilities:
//   1. Refresh the Supabase session cookie (MUST happen on every request
//      so tokens never expire silently).
//   2. Redirect unauthenticated users away from protected routes.
//   3. Redirect authenticated users away from auth pages (login).
//
// ⚠ Do NOT use the server client from lib/supabase/server.ts here.
//   Middleware runs on the Edge runtime; it must build its own
//   Supabase client using the request/response cookie API below.

import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

// Routes that require a valid session
const PROTECTED_PREFIXES = [
  "/",          // dashboard home
  "/clients",
  "/cases",
  "/hearings",
  "/documents",
  "/ai",
  "/dashboard",
];

// Routes only accessible when NOT logged in
const AUTH_PREFIXES = ["/login"];

export async function middleware(request: NextRequest) {
  // Start with a plain next() response that we'll mutate with cookies
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Write cookies back to both the request and the response.
          // This is the pattern required by @supabase/ssr to keep the
          // session alive across server/edge boundaries.
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: Always call getUser() — never getSession().
  // getSession() trusts the client cookie without re-validating with
  // Supabase servers, making it spoofable. getUser() always hits the
  // Supabase Auth server to confirm the token is legitimate.
  const { data: { user } } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // Skip middleware logic for Next.js internals and static files
  const isNextInternal = pathname.startsWith("/_next");
  const isStaticFile = /\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js)$/.test(pathname);
  const isApiRoute = pathname.startsWith("/api");

  if (isNextInternal || isStaticFile || isApiRoute) {
    return supabaseResponse;
  }

  const isAuthPage = AUTH_PREFIXES.some((p) => pathname.startsWith(p));
  const isProtectedPage = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/")
  );

  // Not authenticated + trying to access a protected page → send to login
  if (!user && isProtectedPage) {
    const loginUrl = new URL("/login", request.url);
    // Preserve the intended destination so we can redirect back after login
    loginUrl.searchParams.set("redirectTo", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Already authenticated + trying to access a login page → send to home
  if (user && isAuthPage) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return supabaseResponse;
}

export const config = {
  // Run on all paths except Next.js internals and static assets.
  // The regex is the official Supabase recommendation.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
