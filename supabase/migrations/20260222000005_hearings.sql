-- =============================================================
-- Migration: 005 — hearings
-- Description: Tracks all court hearings scheduled for a case.
--              Each row is one hearing date.  After the hearing
--              the lawyer fills in `outcome` and `next_date`.
--
-- Visibility rule: a user can see/manage hearings for any case
-- they can see (RLS on hearings delegates to RLS on cases via
-- a subquery — no duplicate logic needed).
-- =============================================================

-- ──────────────────────────────────────────────────────────────
-- TABLE
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hearings (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Which case this hearing belongs to
    -- Cascade delete: if a case is deleted all its hearings go too
    case_id      UUID        NOT NULL REFERENCES cases (id) ON DELETE CASCADE,

    -- Scheduled date and time of the hearing
    hearing_date TIMESTAMPTZ NOT NULL,

    -- Physical/virtual location details
    court_room   TEXT,                        -- e.g. "Court Room 4, LHC"

    -- Judge presiding at this specific hearing
    -- (may differ from the case's default judge mid-litigation)
    judge        TEXT,

    -- What this hearing is about
    -- Examples: "Arguments", "Evidence", "Judgment", "Bail"
    purpose      TEXT,

    -- Filled in AFTER the hearing
    outcome      TEXT,                        -- what happened
    next_date    TIMESTAMPTZ,                 -- next adjourned date if any

    -- Internal notes (pre or post hearing)
    notes        TEXT,

    -- Audit
    created_by   UUID        REFERENCES auth.users (id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ──────────────────────────────────────────────────────────────
-- INDEXES
-- ──────────────────────────────────────────────────────────────
-- FK lookup — all hearings for a case
CREATE INDEX idx_hearings_case_id
    ON hearings (case_id);

-- Calendar queries: upcoming hearings sorted by date
CREATE INDEX idx_hearings_hearing_date
    ON hearings (hearing_date);

-- Combined index: hearings for a case sorted by date
-- (the most common query: "show me hearings for case X in order")
CREATE INDEX idx_hearings_case_date
    ON hearings (case_id, hearing_date);

-- ──────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ──────────────────────────────────────────────────────────────
ALTER TABLE hearings ENABLE ROW LEVEL SECURITY;

-- ── ADMIN ────────────────────────────────────────────────────
-- Full access to all hearings regardless of case assignment
CREATE POLICY "hearings__admin_all"
    ON hearings
    FOR ALL
    USING      (get_user_role() = 'admin')
    WITH CHECK (get_user_role() = 'admin');

-- ── LAWYER ───────────────────────────────────────────────────
-- Lawyers see and manage hearings for cases assigned to them.
-- The subquery against `cases` inherits cases RLS automatically.
CREATE POLICY "hearings__lawyer_select"
    ON hearings
    FOR SELECT
    USING (
        get_user_role() = 'lawyer'
        AND case_id IN (
            SELECT id FROM cases WHERE assigned_to = auth.uid()
        )
    );

CREATE POLICY "hearings__lawyer_insert"
    ON hearings
    FOR INSERT
    WITH CHECK (
        get_user_role() = 'lawyer'
        AND case_id IN (
            SELECT id FROM cases WHERE assigned_to = auth.uid()
        )
    );

CREATE POLICY "hearings__lawyer_update"
    ON hearings
    FOR UPDATE
    USING (
        get_user_role() = 'lawyer'
        AND case_id IN (
            SELECT id FROM cases WHERE assigned_to = auth.uid()
        )
    )
    WITH CHECK (
        get_user_role() = 'lawyer'
        AND case_id IN (
            SELECT id FROM cases WHERE assigned_to = auth.uid()
        )
    );

-- ── STAFF ────────────────────────────────────────────────────
-- Staff can read hearings for cases assigned to them (scheduling)
-- but cannot create or edit hearing records
CREATE POLICY "hearings__staff_select"
    ON hearings
    FOR SELECT
    USING (
        get_user_role() = 'staff'
        AND case_id IN (
            SELECT id FROM cases WHERE assigned_to = auth.uid()
        )
    );
