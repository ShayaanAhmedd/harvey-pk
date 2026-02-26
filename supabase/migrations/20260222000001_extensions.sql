-- =============================================================
-- Migration: 001 — Enable Required PostgreSQL Extensions
-- Description: pgvector for AI embeddings, uuid-ossp for UUIDs
-- Run order: FIRST — all other migrations depend on these
-- =============================================================

-- pgvector: stores and queries OpenAI embedding vectors (1536-dim)
CREATE EXTENSION IF NOT EXISTS vector;

-- uuid-ossp: gen_random_uuid() for primary keys
-- Note: also available via pg_crypto in newer Postgres, but this
-- keeps compatibility explicit
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
