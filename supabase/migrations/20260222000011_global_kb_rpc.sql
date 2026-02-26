-- =============================================================
-- Migration: 011 — Global Knowledge Base RPC
-- Description:
--   match_global_documents() — searches documents with
--   scope='global' by vector similarity.  Mirrors
--   match_documents_by_case() but is not scoped to any
--   specific case, making it suitable for cross-matter
--   legal research (statutes, precedents, form templates).
-- =============================================================

DROP FUNCTION IF EXISTS match_global_documents(vector, integer);
DROP FUNCTION IF EXISTS match_global_documents(vector, integer, float);

CREATE OR REPLACE FUNCTION match_global_documents(
    query_embedding  vector(1536),
    match_count      integer,
    match_threshold  float DEFAULT 0.35
)
RETURNS TABLE (
    id          uuid,
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
        d.file_name,
        d.chunk_index,
        d.content,
        (1 - (d.embedding <=> query_embedding))::float AS similarity
    FROM
        documents d
    WHERE
        d.scope = 'global'
        AND d.embedding IS NOT NULL
        AND (1 - (d.embedding <=> query_embedding)) >= match_threshold
    ORDER BY
        d.embedding <=> query_embedding
    LIMIT
        match_count;
$$;
