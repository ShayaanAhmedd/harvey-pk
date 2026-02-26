"use client";

// AuthContext — provides the authenticated user, their session, and
// their role (admin | lawyer | staff) to any Client Component in the tree.
//
// Usage:
//   const { user, role, loading, signOut } = useAuth();
//
// The role is fetched once from the `user_roles` table immediately
// after a session is established, then cached in state for the
// lifetime of the session.

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────
export type UserRole = "admin" | "lawyer" | "staff";

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  role: UserRole | null;
  // true while the initial session + role fetch is in flight
  loading: boolean;
  signOut: () => Promise<void>;
}

// ──────────────────────────────────────────────────────────────
// Context
// ──────────────────────────────────────────────────────────────
const AuthContext = createContext<AuthContextValue>({
  user: null,
  session: null,
  role: null,
  loading: true,
  signOut: async () => {},
});

// ──────────────────────────────────────────────────────────────
// Provider
// ──────────────────────────────────────────────────────────────
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<UserRole | null>(null);
  const [loading, setLoading] = useState(true);

  const supabase = createClient();

  // Fetch the role via the server-side /api/me route.
  // Using a server route avoids calling Supabase REST directly from the
  // browser (which bypasses cookie auth and causes RLS to block the query).
  const fetchRole = useCallback(async (): Promise<UserRole | null> => {
    try {
      const res = await fetch("/api/me");
      if (!res.ok) return null;
      const json = await res.json();
      return (json.role as UserRole) ?? null;
    } catch {
      return null;
    }
  }, []);

  // Synchronise state from a session object (used on mount and on
  // every auth state change event).
  const syncSession = useCallback(
    async (newSession: Session | null) => {
      setSession(newSession);
      setUser(newSession?.user ?? null);

      if (newSession?.user) {
        const userRole = await fetchRole();
        setRole(userRole);
      } else {
        setRole(null);
      }

      setLoading(false);
    },
    [fetchRole]
  );

  useEffect(() => {
    // 1. Hydrate from the existing session on first render.
    supabase.auth.getSession().then(({ data: { session } }) => {
      syncSession(session);
    });

    // 2. Subscribe to future auth events (login, logout, token refresh).
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      syncSession(session);
    });

    return () => subscription.unsubscribe();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Empty deps: this effect should run exactly once on mount.
  // syncSession and supabase are stable references; adding them
  // would cause an infinite loop via onAuthStateChange.

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    // syncSession(null) is called automatically via onAuthStateChange
  }, [supabase]);

  return (
    <AuthContext.Provider value={{ user, session, role, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

// ──────────────────────────────────────────────────────────────
// Hook
// ──────────────────────────────────────────────────────────────
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be called inside <AuthProvider>");
  }
  return ctx;
}

// ──────────────────────────────────────────────────────────────
// Role guard helpers
// ──────────────────────────────────────────────────────────────
// Convenience predicates for conditional rendering in components.
export function isAdmin(role: UserRole | null): boolean {
  return role === "admin";
}

export function isLawyer(role: UserRole | null): boolean {
  return role === "lawyer";
}

export function isStaff(role: UserRole | null): boolean {
  return role === "staff";
}

// Returns true if the role can perform write operations on a case
export function canEditCase(role: UserRole | null): boolean {
  return role === "admin" || role === "lawyer";
}
