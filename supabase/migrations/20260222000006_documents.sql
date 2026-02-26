-- =============================================================
-- Migration: 006 — documents (production version with pgvector)
-- Description: Replaces the MVP `documents` table.  Each row is
--              one text chunk from an uploaded legal document.
--              The `embedding` column enables AI-powered semantic
--              search scoped to a specific case.
--
-- ⚠ DROP NOTICE — Development only
--   The existing MVP `documents` table (which used a different
--   schema: document_id FK, no case_id) is dropped here.
--   Remove this DROP before running in production.
-- =============================================================

-- ──────────────────────────────────────────────────────────────
-- REMOVE LEGACY TABLE
-- ──────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS documents CASCADE;

-- ──────────────────────────────────────────────────────────────
-- TABLE
-- ──────────────────────────────────────────────────────────────
CREATE TABLE documents (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Which case this document belongs to
    case_id       UUID        NOT NULL REFERENCES cases (id) ON DELETE CASCADE,

    -- Original uploaded file name (e.g. "FIR_2024_Lahore.docx")
    file_name     TEXT        NOT NULL,

    -- Type of the original file
    file_type     TEXT        NOT NULL DEFAULT 'docx'
                              CHECK (file_type IN ('docx', 'pdf', 'txt', 'other')),

    -- Path in Supabase Storage bucket (for download / preview)
    -- Null for purely text-pasted content
    storage_path  TEXT,

    -- ── RAG CHUNKING ─────────────────────────────────────────
    -- Each uploaded file is split into N chunks of ~1000 chars.
    -- chunk_index tracks position within the original document.
    chunk_index   INTEGER     NOT NULL DEFAULT 0,

    -- Actual text content of this chunk (used as LLM context)
    content       TEXT,

    -- OpenAI text-embedding-3-small output (1536 dimensions)
    -- Null while embedding is being generated (async pipeline)
    embedding     vector(1536),

    -- Audit
    uploaded_by   UUID        REFERENCES auth.users (id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()

    -- Note: no updated_at — chunks are immutable once created.
    -- Re-processing a document deletes old chunks and inserts new ones.
);

-- ──────────────────────────────────────────────────────────────
-- INDEXES
-- ──────────────────────────────────────────────────────────────
-- FK lookup — all document chunks for a case
CREATE INDEX idx_documents_case_id
    ON documents (case_id);

-- Filter by file_name within a case (retrieve all chunks of one file)
CREATE INDEX idx_documents_case_filename
    ON documents (case_id, file_name);

-- ── VECTOR INDEX ──────────────────────────────────────────────
-- IVFFlat: approximate nearest-neighbour search on embeddings.
-- `lists = 100` is appropriate for up to ~1M rows.
-- For smaller datasets (< 100k rows) `lists = 50` is fine.
-- Must be created AFTER data is loaded for optimal performance
-- (or use HNSW for insert-heavy workloads — swap if needed).
CREATE INDEX idx_documents_embedding
    ON documents
    USING ivfflat (embedding vector_cosine_ops)
    WITH  (lists = 100);

-- ──────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ──────────────────────────────────────────────────────────────
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

-- ── ADMIN ────────────────────────────────────────────────────
CREATE POLICY "documents__admin_all"
    ON documents
    FOR ALL
    USING      (get_user_role() = 'admin')
    WITH CHECK (get_user_role() = 'admin');

-- ── LAWYER ───────────────────────────────────────────────────
-- Lawyers see, upload, and delete documents for their own cases
CREATE POLICY "documents__lawyer_select"
    ON documents
    FOR SELECT
    USING (
        get_user_role() = 'lawyer'
        AND case_id IN (
            SELECT id FROM cases WHERE assigned_to = auth.uid()
        )
    );

CREATE POLICY "documents__lawyer_insert"
    ON documents
    FOR INSERT
    WITH CHECK (
        get_user_role() = 'lawyer'
        AND case_id IN (
            SELECT id FROM cases WHERE assigned_to = auth.uid()
        )
    );

CREATE POLICY "documents__lawyer_delete"
    ON documents
    FOR DELETE
    USING (
        get_user_role() = 'lawyer'
        AND case_id IN (
            SELECT id FROM cases WHERE assigned_to = auth.uid()
        )
    );

-- ── STAFF ────────────────────────────────────────────────────
-- Staff can read and upload documents but not delete them
CREATE POLICY "documents__staff_select"
    ON documents
    FOR SELECT
    USING (
        get_user_role() = 'staff'
        AND case_id IN (
            SELECT id FROM cases WHERE assigned_to = auth.uid()
        )
    );

CREATE POLICY "documents__staff_insert"
    ON documents
    FOR INSERT
    WITH CHECK (
        get_user_role() = 'staff'
        AND case_id IN (
            SELECT id FROM cases WHERE assigned_to = auth.uid()
        )
    );
