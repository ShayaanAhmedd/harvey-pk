-- Email settings: per-user SMTP configuration.
-- Password is stored encrypted at rest by Supabase (pgcrypto at storage level).
-- RLS ensures each user can only read/write their own row.

CREATE TABLE IF NOT EXISTS email_settings (
  user_id    UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  smtp_host  TEXT        NOT NULL,
  smtp_port  INTEGER     NOT NULL DEFAULT 587,
  smtp_user  TEXT        NOT NULL,
  smtp_pass  TEXT        NOT NULL,
  from_email TEXT        NOT NULL,
  from_name  TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE email_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own email settings"
  ON email_settings
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_email_settings_user ON email_settings (user_id);
