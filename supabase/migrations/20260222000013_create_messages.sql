-- =============================================================
-- Migration: 013 — Create messages table (idempotent repair)
-- Description:
--   Creates the messages table if it does not exist.
--   Drops and recreates RLS policies unconditionally so this
--   file is safe to run more than once.
--
--   Root cause this fixes:
--     PostgreSQL SQLSTATE 42P01 — relation "messages" does not exist
--     Confirmed via /api/debug/db diagnostic endpoint.
-- =============================================================

-- ── Table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id    UUID        NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
    role       TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT        NOT NULL,
    sources    JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index: all messages for a chat in chronological order
-- (the primary read pattern — loading a conversation)
CREATE INDEX IF NOT EXISTS idx_messages_chat_id
    ON messages (chat_id, created_at ASC);

-- ── RLS ───────────────────────────────────────────────────────
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Drop before recreating so re-runs don't error on duplicate names
DROP POLICY IF EXISTS "messages__own_chat_select" ON messages;
DROP POLICY IF EXISTS "messages__own_chat_insert" ON messages;

-- SELECT: a user may read messages whose parent chat they own
CREATE POLICY "messages__own_chat_select"
    ON messages FOR SELECT
    USING (
        chat_id IN (
            SELECT id FROM chats WHERE user_id = auth.uid()
        )
    );

-- INSERT: a user may write into chats they own
CREATE POLICY "messages__own_chat_insert"
    ON messages FOR INSERT
    WITH CHECK (
        chat_id IN (
            SELECT id FROM chats WHERE user_id = auth.uid()
        )
    );

-- Messages are immutable once written.
-- No UPDATE or DELETE policies are intentional.
-- Deleting the parent chat cascades to its messages automatically.
