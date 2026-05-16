-- imported_memory: stores chat history imported from external LLMs (ChatGPT, Claude, etc.)
-- Users paste or upload text; Harvey can reference it as conversation context.

CREATE TABLE IF NOT EXISTS imported_memory (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title      text        NOT NULL DEFAULT 'Imported Memory',
  content    text        NOT NULL,
  case_id    uuid        REFERENCES cases(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX imported_memory_user_id_idx ON imported_memory (user_id);
CREATE INDEX imported_memory_case_id_idx ON imported_memory (case_id);

ALTER TABLE imported_memory ENABLE ROW LEVEL SECURITY;

-- Users can only access their own memory rows
CREATE POLICY "imported_memory_user_own"
  ON imported_memory
  USING  (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
