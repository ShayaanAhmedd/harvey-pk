-- =============================================================
-- Migration: 014 — chats
-- Description: One row per conversation thread. A chat belongs
--              to one user and optionally to one case.
-- =============================================================

-- ── Table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chats (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    case_id    UUID        REFERENCES cases (id) ON DELETE SET NULL,
    title      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Index ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_chats_user_id
    ON chats (user_id, created_at DESC);

-- ── RLS ───────────────────────────────────────────────────────
ALTER TABLE chats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "chats__own_select" ON chats;
DROP POLICY IF EXISTS "chats__own_insert" ON chats;
DROP POLICY IF EXISTS "chats__own_delete" ON chats;

CREATE POLICY "chats__own_select"
    ON chats FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "chats__own_insert"
    ON chats FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "chats__own_delete"
    ON chats FOR DELETE
    USING (auth.uid() = user_id);
