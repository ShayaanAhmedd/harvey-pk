-- =============================================================
-- Migration: 012 — Repair / idempotent RLS policy reset
-- Description:
--   Drops and recreates all RLS policies for chats, messages,
--   and cases.  Safe to run multiple times.
--
--   Run this if:
--     - A previous migration applied partially
--     - Policies were accidentally dropped
--     - You need to confirm the exact policy state
-- =============================================================

-- ──────────────────────────────────────────────────────────────
-- CHATS
-- ──────────────────────────────────────────────────────────────
ALTER TABLE chats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "chats__own_select" ON chats;
DROP POLICY IF EXISTS "chats__own_insert" ON chats;
DROP POLICY IF EXISTS "chats__own_update" ON chats;
DROP POLICY IF EXISTS "chats__own_delete" ON chats;
-- Also drop the user-specified name variants, just in case
DROP POLICY IF EXISTS "Users can select own chats" ON chats;
DROP POLICY IF EXISTS "Users can insert own chats" ON chats;

CREATE POLICY "chats__own_select"
    ON chats FOR SELECT
    USING (user_id = auth.uid());

CREATE POLICY "chats__own_insert"
    ON chats FOR INSERT
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "chats__own_update"
    ON chats FOR UPDATE
    USING      (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "chats__own_delete"
    ON chats FOR DELETE
    USING (user_id = auth.uid());

-- ──────────────────────────────────────────────────────────────
-- MESSAGES
-- ──────────────────────────────────────────────────────────────
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "messages__own_chat_select" ON messages;
DROP POLICY IF EXISTS "messages__own_chat_insert" ON messages;

-- Access is inherited from the parent chat ownership
CREATE POLICY "messages__own_chat_select"
    ON messages FOR SELECT
    USING (
        chat_id IN (
            SELECT id FROM chats WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "messages__own_chat_insert"
    ON messages FOR INSERT
    WITH CHECK (
        chat_id IN (
            SELECT id FROM chats WHERE user_id = auth.uid()
        )
    );

-- ──────────────────────────────────────────────────────────────
-- CASES
-- Uses a direct subquery instead of get_user_role() so this
-- policy works even if migration 002 was not applied.
-- ──────────────────────────────────────────────────────────────
ALTER TABLE cases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cases__admin_all"       ON cases;
DROP POLICY IF EXISTS "cases__lawyer_select"   ON cases;
DROP POLICY IF EXISTS "cases__lawyer_update"   ON cases;
DROP POLICY IF EXISTS "cases__lawyer_insert"   ON cases;
DROP POLICY IF EXISTS "cases__staff_select"    ON cases;
-- Also drop the user-specified name variant
DROP POLICY IF EXISTS "Users can view assigned cases" ON cases;

-- Admin: full access
CREATE POLICY "cases__admin_all"
    ON cases FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM user_roles
            WHERE user_id = auth.uid() AND role = 'admin'
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM user_roles
            WHERE user_id = auth.uid() AND role = 'admin'
        )
    );

-- Lawyer: select + insert + update on assigned cases
CREATE POLICY "cases__lawyer_select"
    ON cases FOR SELECT
    USING (
        assigned_to = auth.uid()
        AND EXISTS (
            SELECT 1 FROM user_roles
            WHERE user_id = auth.uid() AND role = 'lawyer'
        )
    );

CREATE POLICY "cases__lawyer_insert"
    ON cases FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM user_roles
            WHERE user_id = auth.uid() AND role = 'lawyer'
        )
    );

CREATE POLICY "cases__lawyer_update"
    ON cases FOR UPDATE
    USING (
        assigned_to = auth.uid()
        AND EXISTS (
            SELECT 1 FROM user_roles
            WHERE user_id = auth.uid() AND role = 'lawyer'
        )
    )
    WITH CHECK (
        assigned_to = auth.uid()
        AND EXISTS (
            SELECT 1 FROM user_roles
            WHERE user_id = auth.uid() AND role = 'lawyer'
        )
    );

-- Staff: read-only on assigned cases
CREATE POLICY "cases__staff_select"
    ON cases FOR SELECT
    USING (
        assigned_to = auth.uid()
        AND EXISTS (
            SELECT 1 FROM user_roles
            WHERE user_id = auth.uid() AND role = 'staff'
        )
    );

-- ──────────────────────────────────────────────────────────────
-- USER_ROLES
-- ──────────────────────────────────────────────────────────────
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_roles__own_select"  ON user_roles;
DROP POLICY IF EXISTS "user_roles__admin_all"   ON user_roles;

-- Every authenticated user can read their own role
CREATE POLICY "user_roles__own_select"
    ON user_roles FOR SELECT
    USING (user_id = auth.uid());

-- Admins can read all roles (needed for user management)
CREATE POLICY "user_roles__admin_all"
    ON user_roles FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM user_roles AS r
            WHERE r.user_id = auth.uid() AND r.role = 'admin'
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM user_roles AS r
            WHERE r.user_id = auth.uid() AND r.role = 'admin'
        )
    );
