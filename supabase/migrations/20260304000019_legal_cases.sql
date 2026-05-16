-- Migration 019: Legal Cases + Benchmark Cache
-- Creates tables for the Continuous Court Intelligence & Structured Tagging Engine.
-- All columns are additive; no existing tables are modified.

-- ── legal_cases ───────────────────────────────────────────────────────────────
-- Stores structured, deduplicated court decisions with extracted metadata.
-- Embeddings allow semantic RAG over case law (separate from statute documents).

CREATE TABLE IF NOT EXISTS legal_cases (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_title      TEXT,
  act_name        TEXT,
  section_number  TEXT,
  authority_tier  TEXT        CHECK (authority_tier IN ('supreme', 'high', 'lower', 'legislation')),
  court_name      TEXT,
  judge_name      TEXT,
  bench           TEXT,
  decision_year   INTEGER,
  outcome         TEXT        CHECK (outcome IN ('favorable', 'unfavorable', 'neutral', 'mixed', 'unknown')),
  jurisdiction    TEXT        NOT NULL DEFAULT 'Pakistan',
  citation_count  INTEGER     NOT NULL DEFAULT 0,
  full_text       TEXT,
  embedding       vector(1536),
  -- SHA-256 hex of normalised full_text — primary dedup guard
  hash            TEXT        UNIQUE NOT NULL,
  parse_confidence NUMERIC(4,3) DEFAULT 1.0 CHECK (parse_confidence BETWEEN 0 AND 1),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_legal_cases_act_name
  ON legal_cases (act_name);

CREATE INDEX IF NOT EXISTS idx_legal_cases_act_section
  ON legal_cases (act_name, section_number);

CREATE INDEX IF NOT EXISTS idx_legal_cases_authority_tier
  ON legal_cases (authority_tier);

CREATE INDEX IF NOT EXISTS idx_legal_cases_decision_year
  ON legal_cases (decision_year);

CREATE INDEX IF NOT EXISTS idx_legal_cases_outcome
  ON legal_cases (outcome);

-- Semantic vector index (IVFFlat, lists tuned for expected corpus size ≤ 100k)
CREATE INDEX IF NOT EXISTS idx_legal_cases_embedding
  ON legal_cases USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- auto-update updated_at
CREATE OR REPLACE FUNCTION set_legal_cases_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_legal_cases_updated_at ON legal_cases;
CREATE TRIGGER trg_legal_cases_updated_at
  BEFORE UPDATE ON legal_cases
  FOR EACH ROW EXECUTE FUNCTION set_legal_cases_updated_at();

-- ── benchmark_cache ───────────────────────────────────────────────────────────
-- Pre-aggregated statistics per (act_name, section_number).
-- Updated incrementally by updateBenchmarkStats() after every new case ingestion.
-- computeBenchmarkAssessment() prefers this table for sub-millisecond lookups;
-- falls back to raw legal_cases query only when cache is absent.

CREATE TABLE IF NOT EXISTS benchmark_cache (
  act_name          TEXT        NOT NULL,
  section_number    TEXT        NOT NULL DEFAULT '*',  -- '*' = any section in act
  total_cases       INTEGER     NOT NULL DEFAULT 0,
  success_rate      NUMERIC(5,4),                      -- 0.0000 – 1.0000
  supreme_alignment NUMERIC(5,4),
  five_year_trend   TEXT        CHECK (five_year_trend IN ('favorable', 'neutral', 'unfavorable')),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (act_name, section_number)
);

CREATE INDEX IF NOT EXISTS idx_benchmark_cache_act_name
  ON benchmark_cache (act_name);

-- ── Row Level Security ────────────────────────────────────────────────────────
ALTER TABLE legal_cases    ENABLE ROW LEVEL SECURITY;
ALTER TABLE benchmark_cache ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read both tables
CREATE POLICY "auth_read_legal_cases"
  ON legal_cases FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "auth_read_benchmark_cache"
  ON benchmark_cache FOR SELECT
  TO authenticated
  USING (true);

-- Only service role can insert / update / delete (ingestion scripts use service key)
-- No explicit insert/update policies needed — service_role bypasses RLS by default.
