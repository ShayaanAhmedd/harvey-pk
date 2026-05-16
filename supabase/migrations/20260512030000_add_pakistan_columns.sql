-- =============================================================
-- Migration: 028 — Pakistan-specific document metadata
-- Description:
--   Adds columns to support Pakistan regional extraction.
--   province        — 'Federal' | 'Punjab' | 'Sindh' | 'KP' | 'Balochistan' | 'ICT' | 'AJK' | 'GB'
--   legal_doc_type  — 'Act' | 'Ordinance' | 'Rule' | 'Regulation' | 'Notification'
--                   | 'SRO' | 'Gazette' | 'Judgment' | 'Order' | 'Circular' | 'Policy' | 'Bylaw'
--   discovered_at   — when this row was first written by an extractor
--
--   Safe to re-run: all ADDs are IF NOT EXISTS.
-- =============================================================

ALTER TABLE documents ADD COLUMN IF NOT EXISTS province TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS legal_doc_type TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS discovered_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_documents_province
  ON documents(province) WHERE province IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_legal_doc_type
  ON documents(legal_doc_type) WHERE legal_doc_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_jurisdiction_province
  ON documents(jurisdiction, province) WHERE province IS NOT NULL;
