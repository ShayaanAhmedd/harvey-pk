-- =============================================================
-- Migration: 002 — user_roles
-- Description: Stores the role (admin / lawyer / staff) for each
--              authenticated Supabase user.
--
-- Created FIRST among domain tables because every RLS policy on
-- every other table calls get_user_role(), which reads this table.
-- =============================================================

-- ──────────────────────────────────────────────────────────────
-- TABLE
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_roles (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    role       TEXT        NOT NULL CHECK (role IN ('admin', 'lawyer', 'staff')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One role per user — enforce at DB level
    CONSTRAINT uq_user_roles_user_id UNIQUE (user_id)
);

-- ──────────────────────────────────────────────────────────────
-- INDEXES
-- ──────────────────────────────────────────────────────────────
-- Most lookups are by user_id (the UNIQUE constraint already
-- creates an index, but make it explicit for clarity)
CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles (user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role    ON user_roles (role);

-- ──────────────────────────────────────────────────────────────
-- HELPER FUNCTION — get_user_role()
-- ──────────────────────────────────────────────────────────────
-- SECURITY DEFINER: runs as the function owner (postgres/service
-- role), bypassing RLS on user_roles itself.  This lets every
-- other table's RLS policies call this function safely without
-- triggering a recursive RLS loop.
--
-- Returns NULL when the user has no row (unauthenticated or
-- newly registered users before a role is assigned).
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_user_role()
RETURNS TEXT
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
    SELECT role
    FROM   user_roles
    WHERE  user_id = auth.uid()
    LIMIT  1;
$$;

-- ──────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ──────────────────────────────────────────────────────────────
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read their own role
-- (needed so the UI can show/hide elements based on role)
CREATE POLICY "user_roles__own_select"
    ON user_roles
    FOR SELECT
    USING (user_id = auth.uid());

-- Only admins can assign roles to other users
CREATE POLICY "user_roles__admin_insert"
    ON user_roles
    FOR INSERT
    WITH CHECK (get_user_role() = 'admin');

CREATE POLICY "user_roles__admin_update"
    ON user_roles
    FOR UPDATE
    USING (get_user_role() = 'admin');

CREATE POLICY "user_roles__admin_delete"
    ON user_roles
    FOR DELETE
    USING (get_user_role() = 'admin');

-- ──────────────────────────────────────────────────────────────
-- BOOTSTRAP NOTE
-- ──────────────────────────────────────────────────────────────
-- The very first admin cannot be created via the app because
-- there is no admin yet to grant the role.
-- Run this once manually in the Supabase SQL editor after the
-- first user registers, replacing <USER_UUID>:
--
--   INSERT INTO user_roles (user_id, role)
--   VALUES ('<USER_UUID>', 'admin');
--
-- All subsequent role assignments go through the admin UI.
-- ──────────────────────────────────────────────────────────────
