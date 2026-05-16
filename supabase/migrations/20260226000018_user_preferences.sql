-- Migration 018: user_preferences and user_platform_settings
-- Persists per-user profile preferences and platform/system settings.

-- ── user_preferences ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id          UUID        PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  legal_role       TEXT        NOT NULL DEFAULT 'lawyer',
  default_mode     TEXT        NOT NULL DEFAULT 'fast',
  writing_style    TEXT        NOT NULL DEFAULT 'formal',
  citation_style   TEXT        NOT NULL DEFAULT 'standard',
  output_density   TEXT        NOT NULL DEFAULT 'detailed',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── user_platform_settings ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_platform_settings (
  user_id              UUID        PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  routing_strategy     TEXT        NOT NULL DEFAULT 'auto',
  web_intelligence     BOOLEAN     NOT NULL DEFAULT true,
  cross_validation     BOOLEAN     NOT NULL DEFAULT false,
  draft_engine         TEXT        NOT NULL DEFAULT 'manus',
  retrieval_strictness TEXT        NOT NULL DEFAULT 'balanced',
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── updated_at triggers ───────────────────────────────────────────────────────
CREATE TRIGGER trg_user_preferences_updated_at
  BEFORE UPDATE ON user_preferences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_user_platform_settings_updated_at
  BEFORE UPDATE ON user_platform_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE user_preferences        ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_platform_settings  ENABLE ROW LEVEL SECURITY;

-- user_preferences: each user can read/write only their own row
CREATE POLICY "user_preferences_select" ON user_preferences
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "user_preferences_insert" ON user_preferences
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "user_preferences_update" ON user_preferences
  FOR UPDATE USING (auth.uid() = user_id);

-- user_platform_settings: each user can read/write only their own row
CREATE POLICY "user_platform_settings_select" ON user_platform_settings
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "user_platform_settings_insert" ON user_platform_settings
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "user_platform_settings_update" ON user_platform_settings
  FOR UPDATE USING (auth.uid() = user_id);
