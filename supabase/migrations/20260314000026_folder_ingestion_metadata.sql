-- =============================================================
-- Migration: 026 — Add folder ingestion metadata columns
-- Description:
--   Adds `folder` and `document_name` to the `documents` table
--   to support bulk folder ingestion via ingest-folder script.
-- =============================================================

ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS document_name TEXT,
    ADD COLUMN IF NOT EXISTS folder        TEXT;

-- Index for querying all docs from a specific folder
CREATE INDEX IF NOT EXISTS idx_documents_folder
    ON documents (folder)
    WHERE folder IS NOT NULL;
