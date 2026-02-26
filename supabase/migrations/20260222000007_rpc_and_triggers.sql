-- =============================================================
-- Migration: 007 — RPC Functions & Triggers
-- Description:
--   1. update_updated_at_column() trigger function — keeps
--      `updated_at` accurate on any table that has that column.
--   2. Triggers wired to clients, cases, hearings tables.
--   3. match_documents_by_case() RPC — case-scoped vector
--      similarity search used by the AI query pipeline.
--      Replaces the MVP version that joined case_documents.
-- =============================================================

-- ──────────────────────────────────────────────────────────────
-- 1. TRIGGER FUNCTION — auto-update `updated_at`
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

-- ──────────────────────────────────────────────────────────────
-- 2. ATTACH TRIGGERS
-- ──────────────────────────────────────────────────────────────
-- Drop first to make this migration idempotent (re-runnable)

DROP TRIGGER IF EXISTS trg_clients_updated_at  ON clients;
DROP TRIGGER IF EXISTS trg_cases_updated_at    ON cases;
DROP TRIGGER IF EXISTS trg_hearings_updated_at ON hearings;

CREATE TRIGGER trg_clients_updated_at
    BEFORE UPDATE ON clients
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_cases_updated_at
    BEFORE UPDATE ON cases
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_hearings_updated_at
    BEFORE UPDATE ON hearings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────
-- 3. RPC — match_documents_by_case
-- ──────────────────────────────────────────────────────────────
-- Purpose: Given a query embedding and a case UUID, return the
--          top N most semantically similar document chunks from
--          that case.  Called by /api/query during RAG retrieval.
--
-- Security:
--   SECURITY DEFINER — runs as the function owner so it can
--   query documents without triggering the per-chunk RLS
--   check N times.  Caller-level access is enforced via the
--   `target_case` argument (users can only query cases they
--   can see, because the API layer validates case ownership
--   before calling this function).
--
--   If you want database-level enforcement here too, add:
--     AND case_id IN (SELECT id FROM cases)
--   But this causes a recursive RLS evaluation on every vector
--   search row — prefer enforcing at the API layer for perf.
--
-- Parameters:
--   query_embedding  — 1536-dim vector from OpenAI
--   match_count      — number of chunks to return (e.g. 5)
--   target_case      — UUID of the case to search within
--   match_threshold  — minimum cosine similarity (0.0–1.0)
--                      defaults to 0.35; tune per use-case
-- ──────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS match_documents_by_case(vector, integer, uuid);
DROP FUNCTION IF EXISTS match_documents_by_case(vector, integer, uuid, float);

CREATE OR REPLACE FUNCTION match_documents_by_case(
    query_embedding  vector(1536),
    match_count      integer,
    target_case      uuid,
    match_threshold  float DEFAULT 0.35
)
RETURNS TABLE (
    id          uuid,
    case_id     uuid,
    file_name   text,
    chunk_index integer,
    content     text,
    similarity  float
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
        -- cosine similarity: 1 minus cosine distance (<=>)
        (1 - (d.embedding <=> query_embedding))::float AS similarity
    FROM
        documents d
    WHERE
        d.case_id  = target_case
        AND d.embedding IS NOT NULL
        -- pre-filter by threshold to avoid returning irrelevant chunks
        AND (1 - (d.embedding <=> query_embedding)) >= match_threshold
    ORDER BY
        d.embedding <=> query_embedding   -- ascending distance = descending similarity
    LIMIT
        match_count;
$$;
