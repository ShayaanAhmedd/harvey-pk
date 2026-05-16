-- =============================================================
-- Migration: 029 — Pakistan case law columns
-- Description:
--   Judgments need columns statutes don't have. Adds court / citation /
--   judgment_date / parties / judges. All ADDs are IF NOT EXISTS so the
--   migration is safe to re-run.
-- =============================================================

ALTER TABLE documents ADD COLUMN IF NOT EXISTS court TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS case_citation TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS judgment_date DATE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS parties TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS judges TEXT;

CREATE INDEX IF NOT EXISTS idx_documents_court
  ON documents(court) WHERE court IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_case_citation
  ON documents(case_citation) WHERE case_citation IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_judgment_date
  ON documents(judgment_date) WHERE judgment_date IS NOT NULL;
