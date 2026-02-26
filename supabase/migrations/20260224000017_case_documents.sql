-- ── case_documents ──────────────────────────────────────────────────────────
-- Stores AI-generated and manually authored legal documents per case.

CREATE TABLE IF NOT EXISTS case_documents (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id    UUID        NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
    title      TEXT        NOT NULL DEFAULT 'Untitled Document',
    content    TEXT        NOT NULL DEFAULT '',
    created_by UUID        REFERENCES auth.users (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_case_documents_case_id
    ON case_documents (case_id);

CREATE TRIGGER trg_case_documents_updated_at
    BEFORE UPDATE ON case_documents
    FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

-- ── case_document_versions ──────────────────────────────────────────────────
-- Immutable snapshot of each previous content state; written before every save.

CREATE TABLE IF NOT EXISTS case_document_versions (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID        NOT NULL REFERENCES case_documents (id) ON DELETE CASCADE,
    content     TEXT        NOT NULL,
    saved_by    UUID        REFERENCES auth.users (id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_case_doc_versions_document_id
    ON case_document_versions (document_id);

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE case_documents         ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_document_versions ENABLE ROW LEVEL SECURITY;

-- case_documents
CREATE POLICY "cdocs_select" ON case_documents
    FOR SELECT USING (get_user_role() IN ('admin', 'lawyer', 'staff'));

CREATE POLICY "cdocs_insert" ON case_documents
    FOR INSERT WITH CHECK (get_user_role() IN ('admin', 'lawyer'));

CREATE POLICY "cdocs_update" ON case_documents
    FOR UPDATE USING (get_user_role() IN ('admin', 'lawyer'));

CREATE POLICY "cdocs_delete" ON case_documents
    FOR DELETE USING (get_user_role() = 'admin');

-- case_document_versions
CREATE POLICY "cdocversions_select" ON case_document_versions
    FOR SELECT USING (get_user_role() IN ('admin', 'lawyer', 'staff'));

CREATE POLICY "cdocversions_insert" ON case_document_versions
    FOR INSERT WITH CHECK (get_user_role() IN ('admin', 'lawyer'));
