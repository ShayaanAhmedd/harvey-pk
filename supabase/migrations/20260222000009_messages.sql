-- =============================================================
-- Migration: 009 — messages
-- Description: One row per turn in a chat.  role is 'user' or
--              'assistant'. sources is a JSONB array of the RAG
--              citations returned for that assistant turn
--              (null for user messages and general-knowledge answers).
--
-- Messages are immutable once created (no updated_at).
-- To "edit" a message the chat is forked or the assistant message
-- is regenerated, which creates a new row.
-- =============================================================

CREATE TABLE IF NOT EXISTS messages (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id    UUID        NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
    role       TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT        NOT NULL,
    -- RAG citations — array of { file_name, similarity, chunk_index }
    -- NULL for user turns and for answers with no document context
    sources    JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- All messages for a chat, in order — the primary access pattern
CREATE INDEX idx_messages_chat_id ON messages (chat_id, created_at ASC);

-- ── RLS ──────────────────────────────────────────────────────
-- Messages inherit visibility from their parent chat.
-- A user can access a message iff they own the parent chat.
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

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

-- Messages cannot be updated or individually deleted.
-- Deleting a chat cascades to its messages automatically.
