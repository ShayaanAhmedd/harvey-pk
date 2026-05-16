-- Migration 023: voice_calls table
-- Stores transcript + AI-generated summary for every voice session.

CREATE TABLE IF NOT EXISTS voice_calls (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  chat_id    UUID        REFERENCES chats(id)  ON DELETE SET NULL,
  case_id    UUID        REFERENCES cases(id)  ON DELETE SET NULL,
  transcript JSONB       NOT NULL DEFAULT '[]'::jsonb,
  summary    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE voice_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "voice_calls_select_own"
  ON voice_calls FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "voice_calls_insert_own"
  ON voice_calls FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE INDEX idx_voice_calls_user_id ON voice_calls (user_id);
CREATE INDEX idx_voice_calls_chat_id ON voice_calls (chat_id);
CREATE INDEX idx_voice_calls_case_id ON voice_calls (case_id);
CREATE INDEX idx_voice_calls_created ON voice_calls (created_at DESC);
