-- =============================================================
-- Migration: 015 — Legal metadata columns for Pakistani law corpus
-- Description:
--   Extends the `documents` table with structured legal metadata
--   so that global knowledge-base entries (scope='global') can be
--   stored and searched as Act → Chapter → Section hierarchies.
--
--   All columns use ADD COLUMN IF NOT EXISTS — safe to re-run.
--
--   Also updates match_global_documents() and
--   match_documents_by_case() to return the new fields so the
--   RAG pipeline can surface proper legal citations.
--
-- Prerequisites:
--   Create a Supabase Storage bucket named "legal-documents"
--   (Dashboard → Storage → New bucket, public: OFF).
--   RLS for that bucket: admin read/write, auth users read.
-- =============================================================

-- ── 1. Add legal metadata columns ─────────────────────────────

ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS title          TEXT,
    ADD COLUMN IF NOT EXISTS act_name       TEXT,
    ADD COLUMN IF NOT EXISTS section_number TEXT,
    ADD COLUMN IF NOT EXISTS chapter        TEXT,
    ADD COLUMN IF NOT EXISTS year           INTEGER,
    ADD COLUMN IF NOT EXISTS jurisdiction   TEXT DEFAULT 'Pakistan',
    ADD COLUMN IF NOT EXISTS source_url     TEXT,
    ADD COLUMN IF NOT EXISTS tags           JSONB;

-- ── 2. Indexes ────────────────────────────────────────────────

-- Filter / search by act
CREATE INDEX IF NOT EXISTS idx_documents_act_name
    ON documents (act_name)
    WHERE act_name IS NOT NULL;

-- Composite — supports deduplication by (act, section) in the API layer
CREATE INDEX IF NOT EXISTS idx_documents_act_section
    ON documents (act_name, section_number)
    WHERE act_name IS NOT NULL AND section_number IS NOT NULL;

-- Filter by year (e.g. "show all 1860 statutes")
CREATE INDEX IF NOT EXISTS idx_documents_year
    ON documents (year)
    WHERE year IS NOT NULL;

-- ── 3. Updated RPCs ───────────────────────────────────────────
-- Both RPCs return the new metadata columns so the API layer can
-- display proper Act / Section citations in chat sources.

-- match_global_documents — global KB vector search
DROP FUNCTION IF EXISTS match_global_documents(vector, integer);
DROP FUNCTION IF EXISTS match_global_documents(vector, integer, float);

CREATE OR REPLACE FUNCTION match_global_documents(
    query_embedding  vector(1536),
    match_count      integer,
    match_threshold  float DEFAULT 0.35
)
RETURNS TABLE (
    id              uuid,
    file_name       text,
    chunk_index     integer,
    content         text,
    similarity      float,
    title           text,
    act_name        text,
    section_number  text,
    chapter         text,
    year            integer
)
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
    SELECT
        d.id,
        d.file_name,
        d.chunk_index,
        d.content,
        (1 - (d.embedding <=> query_embedding))::float AS similarity,
        d.title,
        d.act_name,
        d.section_number,
        d.chapter,
        d.year
    FROM  documents d
    WHERE d.scope     = 'global'
      AND d.embedding IS NOT NULL
      AND (1 - (d.embedding <=> query_embedding)) >= match_threshold
    ORDER BY d.embedding <=> query_embedding
    LIMIT match_count;
$$;

-- match_documents_by_case — case-scoped vector search
DROP FUNCTION IF EXISTS match_documents_by_case(vector, integer, uuid);
DROP FUNCTION IF EXISTS match_documents_by_case(vector, integer, uuid, float);

CREATE OR REPLACE FUNCTION match_documents_by_case(
    query_embedding  vector(1536),
    match_count      integer,
    target_case      uuid,
    match_threshold  float DEFAULT 0.35
)
RETURNS TABLE (
    id              uuid,
    case_id         uuid,
    file_name       text,
    chunk_index     integer,
    content         text,
    similarity      float,
    section_number  text,
    act_name        text
)
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
    SELECT
        d.id,
        d.case_id,
        d.file_name,
        d.chunk_index,
        d.content,
        (1 - (d.embedding <=> query_embedding))::float AS similarity,
        d.section_number,
        d.act_name
    FROM  documents d
    WHERE d.case_id   = target_case
      AND d.embedding IS NOT NULL
      AND (1 - (d.embedding <=> query_embedding)) >= match_threshold
    ORDER BY d.embedding <=> query_embedding
    LIMIT match_count;
$$;
