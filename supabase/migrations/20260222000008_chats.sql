-- =============================================================
-- Migration: 008 — chats
-- Description: One row per conversation thread. A chat belongs to
--              one user and optionally to one case (case-scoped RAG).
--              When case_id is NULL the chat is a general assistant
--              session (uses only global KB in Phase 2).
-- =============================================================

CREATE TABLE IF NOT EXISTS chats (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    case_id    UUID        REFERENCES cases (id) ON DELETE SET NULL,
    title      TEXT        NOT NULL DEFAULT 'New Chat',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every user queries their own chats constantly
CREATE INDEX idx_chats_user_id    ON chats (user_id);
-- Filter by case for the "chats related to this case" view
CREATE INDEX idx_chats_case_id    ON chats (case_id) WHERE case_id IS NOT NULL;
-- Most-recent-first ordering in the sidebar
CREATE INDEX idx_chats_updated_at ON chats (user_id, updated_at DESC);

-- Auto-update updated_at whenever a row changes
CREATE TRIGGER trg_chats_updated_at
    BEFORE UPDATE ON chats
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE chats ENABLE ROW LEVEL SECURITY;

-- Users can only see and manage their own chats.
-- Admins get no special override here — chats are personal.
CREATE POLICY "chats__own_select"
    ON chats FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "chats__own_insert"
    ON chats FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "chats__own_update"
    ON chats FOR UPDATE
    USING      (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "chats__own_delete"
    ON chats FOR DELETE USING (user_id = auth.uid());
