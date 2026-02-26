-- =============================================================
-- Migration: 010 — Add scope column to documents
-- Description: Distinguishes case-specific documents (uploaded by
--              lawyers for a particular case) from the global
--              knowledge base (uploaded by admins — laws, statutes,
--              legal textbooks that apply to every chat).
--
-- Default is 'case' so all existing rows are unaffected.
-- =============================================================

ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'case'
    CHECK (scope IN ('case', 'global'));

-- Index for filtering by scope — used in the merged RAG query
CREATE INDEX IF NOT EXISTS idx_documents_scope
    ON documents (scope);

-- Combined index: global documents by embedding search
-- (the most common query in Phase 2: "search global KB")
CREATE INDEX IF NOT EXISTS idx_documents_global
    ON documents (scope)
    WHERE scope = 'global';

-- ── RLS update for global documents ─────────────────────────
-- Global documents are admin-write, all-read.
-- The existing RLS policies cover case-scoped documents.
-- We add a read policy for global docs accessible to all roles.

CREATE POLICY "documents__global_select"
    ON documents FOR SELECT
    USING (scope = 'global');

-- Only admins can insert global documents
CREATE POLICY "documents__admin_insert_global"
    ON documents FOR INSERT
    WITH CHECK (
        scope = 'global' AND get_user_role() = 'admin'
    );
