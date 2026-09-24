-- ============================================
-- Life Engine — OB1 Integration Schema
-- ============================================
-- Extends your Open Brain with tables for
-- habit tracking, check-ins, briefing logs,
-- and self-improvement evolution tracking.
--
-- Run this against your Open Brain's database:
--   psql "$DATABASE_URL" -f recipes/life-engine/schema.sql
-- ============================================

-- ----------------------------------------
-- UPGRADING FROM A PREVIOUS VERSION
-- ----------------------------------------
-- If you already have Life Engine tables from an earlier install,
-- run these migration statements before re-running the full schema:
--
-- 1. user_id UUID → TEXT (needed for Telegram/Discord chat_id storage):
--    ALTER TABLE life_engine_habits ALTER COLUMN user_id TYPE text;
--    ALTER TABLE life_engine_habit_log ALTER COLUMN user_id TYPE text;
--    ALTER TABLE life_engine_checkins ALTER COLUMN user_id TYPE text;
--    ALTER TABLE life_engine_briefings ALTER COLUMN user_id TYPE text;
--    ALTER TABLE life_engine_evolution ALTER COLUMN user_id TYPE text;
--
-- 2. Add delivered_via CHECK constraint (if column exists without one):
--    ALTER TABLE life_engine_briefings
--      ADD CONSTRAINT life_engine_briefings_delivered_via_check
--      CHECK (delivered_via IN ('telegram', 'discord'));
--
-- 3. Remove cron_state from briefing_type CHECK (if present):
--    ALTER TABLE life_engine_briefings
--      DROP CONSTRAINT life_engine_briefings_briefing_type_check,
--      ADD CONSTRAINT life_engine_briefings_briefing_type_check
--      CHECK (briefing_type IN ('morning', 'pre_meeting', 'checkin',
--             'evening', 'habit_reminder', 'weekly_review', 'custom'));
--
-- 4. Create life_engine_state table (see below — CREATE IF NOT EXISTS is safe).

-- ----------------------------------------
-- Habit definitions
-- ----------------------------------------
-- What habits the user wants to track.
-- Examples: morning jog, meditation, reading

CREATE TABLE IF NOT EXISTS life_engine_habits (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  frequency TEXT DEFAULT 'daily'
    CHECK (frequency IN ('daily', 'weekdays', 'weekends', 'weekly', 'custom')),
  time_of_day TEXT DEFAULT 'morning'
    CHECK (time_of_day IN ('morning', 'midday', 'evening', 'anytime')),
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE life_engine_habits IS 'User-defined habits for Life Engine to track and remind';

-- ----------------------------------------
-- Habit completion log
-- ----------------------------------------
-- Each row = one completion of a habit.
-- Streaks are calculated from this data.

CREATE TABLE IF NOT EXISTS life_engine_habit_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  habit_id UUID REFERENCES life_engine_habits(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ DEFAULT now(),
  notes TEXT
);

COMMENT ON TABLE life_engine_habit_log IS 'Daily log of habit completions';

-- ----------------------------------------
-- Check-ins (mood, energy, health)
-- ----------------------------------------
-- User self-reports prompted by Life Engine.
-- Freeform value field supports any format:
-- "great", "7/10", "tired but productive"

CREATE TABLE IF NOT EXISTS life_engine_checkins (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  checkin_type TEXT NOT NULL
    CHECK (checkin_type IN ('mood', 'energy', 'health', 'custom')),
  value TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE life_engine_checkins IS 'User check-in responses (mood, energy, health)';

-- ----------------------------------------
-- Briefing log
-- ----------------------------------------
-- Every message Life Engine sends is logged here.
-- Used to prevent duplicate briefings and to
-- analyze engagement in the self-improvement cycle.

CREATE TABLE IF NOT EXISTS life_engine_briefings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  briefing_type TEXT NOT NULL
    CHECK (briefing_type IN ('morning', 'pre_meeting', 'checkin', 'evening', 'habit_reminder', 'weekly_review', 'custom')),
  content TEXT NOT NULL,
  delivered_via TEXT DEFAULT 'telegram'
    CHECK (delivered_via IN ('telegram', 'discord')),
  user_responded BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE life_engine_briefings IS 'Log of all briefings sent by Life Engine';

-- ----------------------------------------
-- Evolution log (self-improvement)
-- ----------------------------------------
-- Tracks every change Claude suggests and
-- whether the user approved it. This is the
-- memory of how the skill has grown over time.

CREATE TABLE IF NOT EXISTS life_engine_evolution (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  change_type TEXT NOT NULL
    CHECK (change_type IN ('added', 'removed', 'modified')),
  description TEXT NOT NULL,
  reason TEXT, -- why Claude suggested this change
  approved BOOLEAN DEFAULT false,
  applied_at TIMESTAMPTZ, -- when it was actually applied
  created_at TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE life_engine_evolution IS 'Self-improvement history — tracks skill changes over time';

-- ----------------------------------------
-- Runtime state (key-value)
-- ----------------------------------------
-- System state that doesn't belong in user-facing tables.
-- Examples: cron_job_id, cron_interval, wake_time, sleep_time, latitude, longitude.
-- Note: No user_id column — this table assumes a single Life Engine instance
-- per Supabase project. For multi-user setups, prefix keys with user ID.

CREATE TABLE IF NOT EXISTS life_engine_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE life_engine_state IS 'Key-value store for Life Engine runtime state (cron ID, sleep schedule, etc.)';

-- ----------------------------------------
-- Row Level Security and grants
-- ----------------------------------------
-- This fork (SMD-1810): upstream's file ENABLEd ROW LEVEL SECURITY on the six
-- tables here — with no policy, as "a safety net to block anon/authenticated
-- access", since its skill wrote through service_role, which bypasses RLS —
-- and GRANTed each TO service_role. Those are Supabase's: on plain Postgres
-- the first GRANT stopped the file (`role "service_role" does not exist`),
-- and RLS with no policy denied every row to any role but the tables' owner —
-- the skill's own writes, where it connects as anything else. Removed.
-- Grant the role your server connects as instead — from db/:
--   bun migrate.ts --url postgres://… --grant <role>
-- issues db/config.mjs ROLE_GRANTS' `recipes` group, which covers this file's
-- six tables (SELECT, INSERT, UPDATE, DELETE); a role that owns the tables
-- needs nothing. Row-level security on this fork: SMD-1716.

-- ----------------------------------------
-- Indexes for performance
-- ----------------------------------------

CREATE INDEX IF NOT EXISTS idx_le_habits_user
  ON life_engine_habits(user_id);

CREATE INDEX IF NOT EXISTS idx_le_habit_log_user_date
  ON life_engine_habit_log(user_id, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_le_checkins_user_date
  ON life_engine_checkins(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_le_briefings_user_date
  ON life_engine_briefings(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_le_briefings_type_date
  ON life_engine_briefings(user_id, briefing_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_le_evolution_user_date
  ON life_engine_evolution(user_id, created_at DESC);

-- ----------------------------------------
-- Helper: auto-update timestamps
-- ----------------------------------------

CREATE OR REPLACE FUNCTION update_life_engine_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER life_engine_habits_updated
  BEFORE UPDATE ON life_engine_habits
  FOR EACH ROW
  EXECUTE FUNCTION update_life_engine_updated_at();

CREATE TRIGGER life_engine_state_updated
  BEFORE UPDATE ON life_engine_state
  FOR EACH ROW
  EXECUTE FUNCTION update_life_engine_updated_at();

-- ----------------------------------------
-- Verification
-- ----------------------------------------
-- Run this to confirm all tables were created:
--
-- SELECT table_name FROM information_schema.tables
-- WHERE table_name LIKE 'life_engine_%'
-- ORDER BY table_name;
--
-- Expected: 6 tables
--   life_engine_briefings
--   life_engine_checkins
--   life_engine_evolution
--   life_engine_habit_log
--   life_engine_habits
--   life_engine_state
