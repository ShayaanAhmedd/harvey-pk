-- Migration 022: Legal Knowledge Graph
-- Creates legal_entities and legal_relationships tables.
-- No existing tables modified.

-- ── legal_entities ────────────────────────────────────────────────────────────
-- One row per unique entity in the legal domain.
-- Sections use compound name format: "{act_name}:::{section_number}" to ensure
-- uniqueness across acts with the same section numbers.
-- Case entities are upserted with id = legal_cases.id for O(1) direct joins.

CREATE TABLE IF NOT EXISTS legal_entities (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   TEXT        NOT NULL CHECK (entity_type IN ('act', 'section', 'case', 'judge', 'court')),
  name          TEXT        NOT NULL,
  metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (entity_type, name)
);

CREATE INDEX IF NOT EXISTS idx_legal_entities_entity_type
  ON legal_entities (entity_type);

CREATE INDEX IF NOT EXISTS idx_legal_entities_name
  ON legal_entities (name);

-- ── legal_relationships ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS legal_relationships (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  from_entity       UUID        NOT NULL REFERENCES legal_entities(id) ON DELETE CASCADE,
  to_entity         UUID        NOT NULL REFERENCES legal_entities(id) ON DELETE CASCADE,
  relationship_type TEXT        NOT NULL,
  weight            FLOAT       NOT NULL DEFAULT 1.0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (from_entity, to_entity, relationship_type)
);

CREATE INDEX IF NOT EXISTS idx_legal_relationships_from
  ON legal_relationships (from_entity);

CREATE INDEX IF NOT EXISTS idx_legal_relationships_to
  ON legal_relationships (to_entity);

CREATE INDEX IF NOT EXISTS idx_legal_relationships_type
  ON legal_relationships (relationship_type);

-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE legal_entities       ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_relationships  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_read_legal_entities"
  ON legal_entities FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_read_legal_relationships"
  ON legal_relationships FOR SELECT TO authenticated USING (true);

-- Service role bypasses RLS for writes.
