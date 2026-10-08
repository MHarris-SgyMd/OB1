-- =============================================================================
-- Migration 081: the seventh release — ob1_config.schema_version = 1.6.0
--                (the cut FORK.md's "Cutting a release" orders, SMD-1804/SMD-1860)
-- =============================================================================
--
-- WHY
--   076 wrote 1.5.0, the sixth release, as the last file of the range it froze
--   (073..076). Since then four additive migrations landed — 077 (prefer_current
--   reads the tickets a thought names, SMD-2271), 078 (jobs.door, which server
--   started a job, SMD-2284), 079 (linked tickets left out of consolidation's
--   candidates, SMD-2448) and 080 (upsert_thought's recapture=keep, SMD-2539) —
--   so the release rule makes this cut a minor: 1.6.0+upstream.9543c29, the
--   range 077..081 frozen by releases.json, and this file its last on purpose:
--   a brain at 081 is exactly the release, preflight's schema-version row says
--   so beside the ledger's highest migration, and a brain migrated past 081 is
--   "past the range its version names" until the next cut.
--
--   The literal below is held equal to db/version.mjs's FORK_VERSION by
--   check-fork-consistency's 17d (the highest schema_version writer is the
--   current version), and scripts/assemble-release.ts refuses --write until
--   both say the version it is about to record.
--
-- WHAT
--   * Upsert ob1_config.schema_version, as 044, 048, 051, 057, 062, 072 and 076
--     do. A plain constant — not an OB1_* env value — so there is no
--     shell-vs-record disagreement for --reapply to refuse; under --reapply
--     every file re-runs in order and this later write wins.
--
-- SAFETY
--   Idempotent (ON CONFLICT DO UPDATE). No schema change — one config row — so a
--   brain at 080 applies it in milliseconds; the release job's stack proves the
--   range on the published images before the release exists.
-- =============================================================================

INSERT INTO ob1_config (key, value) VALUES
  ('schema_version', '1.6.0+upstream.9543c29')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value, updated_at = now();
