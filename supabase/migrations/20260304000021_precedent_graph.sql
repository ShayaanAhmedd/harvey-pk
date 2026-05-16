-- Migration 021: Precedent Network Graph
-- Creates precedent_nodes, precedent_edges, and match_precedent_nodes RPC.
-- No existing tables modified.

-- ── precedent_nodes ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS precedent_nodes (
  case_id        UUID        PRIMARY KEY REFERENCES legal_cases(id) ON DELETE CASCADE,
  case_title     TEXT,
  decision_year  INTEGER,
  authority_tier TEXT,
  court_name     TEXT,
  embedding      vector(1536),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_precedent_nodes_embedding
  ON precedent_nodes USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_precedent_nodes_authority_tier
  ON precedent_nodes (authority_tier);

CREATE INDEX IF NOT EXISTS idx_precedent_nodes_decision_year
  ON precedent_nodes (decision_year);

-- ── precedent_edges ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS precedent_edges (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  from_case_id   UUID        NOT NULL REFERENCES precedent_nodes(case_id) ON DELETE CASCADE,
  to_case_id     UUID        NOT NULL REFERENCES precedent_nodes(case_id) ON DELETE CASCADE,
  relation_type  TEXT        NOT NULL CHECK (relation_type IN ('cites', 'distinguishes', 'overrules', 'follows')),
  weight         FLOAT       NOT NULL DEFAULT 1.0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Idempotent: prevent duplicate edges
  UNIQUE (from_case_id, to_case_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_precedent_edges_from
  ON precedent_edges (from_case_id);

CREATE INDEX IF NOT EXISTS idx_precedent_edges_to
  ON precedent_edges (to_case_id);

CREATE INDEX IF NOT EXISTS idx_precedent_edges_relation_type
  ON precedent_edges (relation_type);

-- ── match_precedent_nodes RPC ─────────────────────────────────────────────────
-- Vector similarity search over precedent_nodes.
-- Returns top-N cases closest to query_embedding.

CREATE OR REPLACE FUNCTION match_precedent_nodes(
  query_embedding vector(1536),
  match_count     int DEFAULT 5
)
RETURNS TABLE (
  case_id         uuid,
  case_title      text,
  authority_tier  text,
  decision_year   int,
  similarity      float
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    pn.case_id,
    pn.case_title,
    pn.authority_tier,
    pn.decision_year,
    1 - (pn.embedding <=> query_embedding) AS similarity
  FROM precedent_nodes pn
  WHERE pn.embedding IS NOT NULL
  ORDER BY pn.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE precedent_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE precedent_edges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_read_precedent_nodes"
  ON precedent_nodes FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_read_precedent_edges"
  ON precedent_edges FOR SELECT TO authenticated USING (true);

-- Service role bypasses RLS for writes.
