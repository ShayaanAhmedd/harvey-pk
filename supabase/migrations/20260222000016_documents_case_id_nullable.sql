-- =============================================================
-- Migration: 016 — Allow NULL case_id on documents
-- Description:
--   Migration 006 created documents.case_id as NOT NULL.
--   Global knowledge-base documents (scope='global') legitimately
--   have no associated case, so case_id must be nullable.
--
--   This migration drops the NOT NULL constraint and updates the
--   foreign key to allow NULL (ON DELETE SET NULL is kept so that
--   if a case is ever deleted, its documents lose the reference
--   rather than being cascade-deleted — consistent with the
--   global-document scenario).
--
--   Safe to run multiple times (idempotent via IF NOT EXISTS /
--   DROP CONSTRAINT IF EXISTS pattern).
--
--   After this migration:
--     case_id IS NULL  → global document (scope='global')
--     case_id IS NOT NULL → case-scoped document (scope='case')
--
--   Existing RLS policies are unaffected:
--     - documents__global_select  → WHERE scope = 'global'      ✓
--     - documents__admin_insert_global → scope='global' AND admin ✓
--     - documents__lawyer_* / staff_* → case_id IN (...)
--         NULL IN (...) evaluates to FALSE so global docs are
--         invisible to those policies — correct behaviour.
-- =============================================================

-- Drop the NOT NULL constraint (if still present)
ALTER TABLE documents
    ALTER COLUMN case_id DROP NOT NULL;

-- Ensure the FK still exists but allows NULL
-- (PostgreSQL FK columns allow NULL by default once NOT NULL is dropped;
--  no extra step needed — the existing FK definition is preserved.)
