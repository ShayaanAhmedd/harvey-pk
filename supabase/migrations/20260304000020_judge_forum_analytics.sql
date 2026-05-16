-- Migration 020: Judge & Forum Intelligence Engine
-- Creates judge_analytics and forum_analytics tables.
-- All additive — no existing tables modified.

-- ── judge_analytics ───────────────────────────────────────────────────────────
-- One row per judge. Maintained incrementally by ingest-case.ts.
-- act_specialization JSONB: { "Pakistan Penal Code": 0.62, "CPC": 0.48 }
--   values = fraction of this judge's total cases involving that act.

CREATE TABLE IF NOT EXISTS judge_analytics (
  judge_name          TEXT        PRIMARY KEY,
  court_name          TEXT,
  total_cases         INTEGER     NOT NULL DEFAULT 0,
  favorable_count     INTEGER     NOT NULL DEFAULT 0,
  unfavorable_count   INTEGER     NOT NULL DEFAULT 0,
  success_rate        NUMERIC(5,4),              -- favorable_count / total_cases
  strictness_index    NUMERIC(5,4),              -- unfavorable_count / total_cases
  act_specialization  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  last_updated        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_judge_analytics_court_name
  ON judge_analytics (court_name);

-- ── forum_analytics ───────────────────────────────────────────────────────────
-- One row per court. Maintained incrementally by ingest-case.ts.
-- five_year_trend: numeric delta (recent_rate − prior_rate); positive = improving.

CREATE TABLE IF NOT EXISTS forum_analytics (
  court_name              TEXT        PRIMARY KEY,
  total_cases             INTEGER     NOT NULL DEFAULT 0,
  overall_success_rate    NUMERIC(5,4),
  supreme_alignment_rate  NUMERIC(5,4),          -- fraction of SC decisions that are favorable
  five_year_trend         NUMERIC(6,4),          -- float delta: recentRate − priorRate
  volume_last_12_months   INTEGER     NOT NULL DEFAULT 0,
  last_updated            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE judge_analytics  ENABLE ROW LEVEL SECURITY;
ALTER TABLE forum_analytics  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_read_judge_analytics"
  ON judge_analytics FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "auth_read_forum_analytics"
  ON forum_analytics FOR SELECT
  TO authenticated
  USING (true);

-- Service role bypasses RLS for writes (ingestion scripts use service key).
