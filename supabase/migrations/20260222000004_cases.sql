-- =============================================================
-- Migration: 004 — cases (production version)
-- Description: Replaces the minimal MVP `cases` table (id, name,
--              created_at) with a full legal case record.
--
-- ⚠ DROP NOTICE ─ Development only
--   The existing MVP tables `case_documents` and `cases` are
--   dropped here because they have no production data and their
--   schema is incompatible with the new design.
--   Remove the DROP statements before running in production.
-- =============================================================

-- ──────────────────────────────────────────────────────────────
-- REMOVE LEGACY TABLES (dev only — no FK-safe data exists)
-- Order matters: child first, then parent
-- ──────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS case_documents CASCADE;
DROP TABLE IF EXISTS cases          CASCADE;

-- ──────────────────────────────────────────────────────────────
-- TABLE
-- ──────────────────────────────────────────────────────────────
CREATE TABLE cases (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Human-readable identifier used in court filings
    -- Example: "2024-LHC-001" (year - court code - sequence)
    case_number  TEXT        NOT NULL UNIQUE,

    -- Case title / short description
    title        TEXT        NOT NULL,

    -- Which client this case belongs to
    client_id    UUID        REFERENCES clients (id) ON DELETE SET NULL,

    -- Court details
    court        TEXT,                        -- e.g. "Lahore High Court"
    judge        TEXT,

    -- Workflow status
    status       TEXT        NOT NULL DEFAULT 'active'
                             CHECK (status IN (
                                 'active',    -- ongoing litigation
                                 'adjourned', -- postponed to a later date
                                 'settled',   -- out-of-court settlement
                                 'closed'     -- fully concluded
                             )),

    -- When the case was officially filed
    filed_date   DATE,

    -- Lead lawyer responsible for this case
    -- Staff visibility is gated on this field via RLS
    assigned_to  UUID        REFERENCES auth.users (id) ON DELETE SET NULL,

    -- Free-form case summary / background
    description  TEXT,

    -- Audit
    created_by   UUID        REFERENCES auth.users (id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ──────────────────────────────────────────────────────────────
-- INDEXES
-- ──────────────────────────────────────────────────────────────
-- FK lookups (Postgres doesn't auto-index FK columns)
CREATE INDEX idx_cases_client_id   ON cases (client_id);
CREATE INDEX idx_cases_assigned_to ON cases (assigned_to);

-- Filtering by status is a very common list view operation
CREATE INDEX idx_cases_status      ON cases (status);

-- Sorting / searching by filed date for calendar views
CREATE INDEX idx_cases_filed_date  ON cases (filed_date);

-- Full-text on title + case_number for search bar
CREATE INDEX idx_cases_fts
    ON cases USING gin (
        to_tsvector('english', coalesce(title, '') || ' ' || coalesce(case_number, ''))
    );

-- ──────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ──────────────────────────────────────────────────────────────
ALTER TABLE cases ENABLE ROW LEVEL SECURITY;

-- Admin: full unrestricted access to all cases
CREATE POLICY "cases__admin_all"
    ON cases
    FOR ALL
    USING      (get_user_role() = 'admin')
    WITH CHECK (get_user_role() = 'admin');

-- Lawyer: can see and edit cases assigned to them
CREATE POLICY "cases__lawyer_select"
    ON cases
    FOR SELECT
    USING (
        get_user_role() = 'lawyer'
        AND assigned_to = auth.uid()
    );

CREATE POLICY "cases__lawyer_update"
    ON cases
    FOR UPDATE
    USING (
        get_user_role() = 'lawyer'
        AND assigned_to = auth.uid()
    )
    WITH CHECK (
        get_user_role() = 'lawyer'
        AND assigned_to = auth.uid()
    );

-- Lawyer: can create new cases (assigned_to themselves or left for admin)
CREATE POLICY "cases__lawyer_insert"
    ON cases
    FOR INSERT
    WITH CHECK (get_user_role() = 'lawyer');

-- Staff: read-only on cases assigned to them
-- Rationale: staff support a specific lawyer's caseload
CREATE POLICY "cases__staff_select"
    ON cases
    FOR SELECT
    USING (
        get_user_role() = 'staff'
        AND assigned_to = auth.uid()
    );
