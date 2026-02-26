-- =============================================================
-- Migration: 003 — clients
-- Description: Stores law firm clients (individuals or entities).
--              Must be created before cases because cases hold
--              a client_id foreign key.
--
-- Pakistan-specific: includes CNIC (Computerised National Identity
-- Card) as the unique national identifier.
-- =============================================================

-- ──────────────────────────────────────────────────────────────
-- TABLE
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Core identity
    full_name    TEXT        NOT NULL,
    cnic         TEXT        UNIQUE,          -- Format: 00000-0000000-0 (optional)
    phone        TEXT,
    email        TEXT,
    address      TEXT,

    -- Client type: individual or company
    client_type  TEXT        NOT NULL DEFAULT 'individual'
                             CHECK (client_type IN ('individual', 'company')),

    -- For companies: the primary contact person
    contact_name TEXT,

    -- Internal notes visible only to lawyers/admin
    notes        TEXT,

    -- Audit
    created_by   UUID        REFERENCES auth.users (id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ──────────────────────────────────────────────────────────────
-- INDEXES
-- ──────────────────────────────────────────────────────────────
-- Full-text search on client name (common lookup pattern)
CREATE INDEX IF NOT EXISTS idx_clients_full_name
    ON clients USING gin (to_tsvector('english', full_name));

-- Direct equality on CNIC (already has UNIQUE index, explicit for docs)
CREATE INDEX IF NOT EXISTS idx_clients_cnic
    ON clients (cnic)
    WHERE cnic IS NOT NULL;

-- Filter by type
CREATE INDEX IF NOT EXISTS idx_clients_client_type
    ON clients (client_type);

-- ──────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ──────────────────────────────────────────────────────────────
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;

-- Admin: full unrestricted access
CREATE POLICY "clients__admin_all"
    ON clients
    FOR ALL
    USING      (get_user_role() = 'admin')
    WITH CHECK (get_user_role() = 'admin');

-- Lawyers: can see and create/edit clients
-- Rationale: lawyers manage client relationships directly
CREATE POLICY "clients__lawyer_select"
    ON clients
    FOR SELECT
    USING (get_user_role() = 'lawyer');

CREATE POLICY "clients__lawyer_insert"
    ON clients
    FOR INSERT
    WITH CHECK (get_user_role() = 'lawyer');

CREATE POLICY "clients__lawyer_update"
    ON clients
    FOR UPDATE
    USING (get_user_role() = 'lawyer');

-- Staff: read-only
-- Rationale: staff (paralegals, receptionists) need client contact info
CREATE POLICY "clients__staff_select"
    ON clients
    FOR SELECT
    USING (get_user_role() = 'staff');
