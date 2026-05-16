-- =============================================================
-- Migration: 027 — Add 384-dim embedding column, keep 1536-dim legacy
-- Description:
--   Switches the embedding pipeline from OpenAI text-embedding-3-small
--   (1536 dims) to a self-hosted BGE-small-en-v1.5 model (384 dims).
--
--   STRATEGY: non-destructive. The existing 1536-dim column is RENAMED
--   to `embedding_legacy` so case-scoped user data is preserved. A new
--   `embedding vector(384)` column is added (NULL for all existing rows).
--
--   After this migration:
--     - All new ingestions write to `embedding` (384-dim, BGE).
--     - Existing rows have NULL `embedding` and intact `embedding_legacy`.
--     - Search RPCs are recreated to take vector(384). They will return
--       no hits for un-migrated rows until those rows are re-embedded.
--     - Re-embed `scope='case'` rows via a backfill script (text is in
--       `documents.content`, so no data is lost — only the vector).
--     - Re-embed `scope='global'` rows by re-running extract:* scripts
--       (the source PDFs/HTML can be fetched again).
-- =============================================================

-- ── 1. Drop the existing vector index ─────────────────────────
-- The pre-existing ivfflat index was named `idx_documents_embedding`
-- (created in migration 006). The spec-suggested alternate name is
-- `documents_embedding_idx` — drop both for safety.
DROP INDEX IF EXISTS idx_documents_embedding;
DROP INDEX IF EXISTS documents_embedding_idx;

-- ── 2. Preserve the existing column under a new name ──────────
-- `embedding_legacy` retains all 1536-dim OpenAI vectors so case-scoped
-- user data is not destroyed. It will be removed in a future migration
-- once all rows have been re-embedded into the new column.
ALTER TABLE documents RENAME COLUMN embedding TO embedding_legacy;

-- ── 3. Add the new 384-dim column ─────────────────────────────
-- Initially NULL for all existing rows.
ALTER TABLE documents ADD COLUMN embedding vector(384);

-- ── 4. Rebuild the vector index on the new column ─────────────
-- HNSW chosen over IVFFlat: better for insert-heavy workloads (corpus
-- extraction will continually append rows) and doesn't require the
-- table to be pre-populated before indexing.
CREATE INDEX IF NOT EXISTS documents_embedding_idx
  ON documents USING hnsw (embedding vector_cosine_ops);

-- ── 5. Recreate RPCs with vector(384) signatures ──────────────
-- The original RPCs (007, 011, 015) take vector(1536). They would
-- raise "different vector dimensions" the moment the column shrinks.
-- These replacements match the latest return-shapes from migration 015.

-- match_global_documents — global KB vector search
DROP FUNCTION IF EXISTS match_global_documents(vector, integer);
DROP FUNCTION IF EXISTS match_global_documents(vector, integer, float);

CREATE OR REPLACE FUNCTION match_global_documents(
    query_embedding  vector(384),
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
    query_embedding  vector(384),
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
