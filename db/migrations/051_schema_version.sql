-- =============================================================================
-- Migration 051: the second release — ob1_config.schema_version = 1.1.0
--                (the cut FORK.md's "Cutting a release" orders, SMD-1804/SMD-1860)
-- =============================================================================
--
-- WHY
--   048 wrote 1.0.0, the first release, as the last file of the range it froze
--   (001..048). Since then two migrations landed — 049 (the capture-only key
--   scope, SMD-1298) and 050 (the writer's kind and name on the row, SMD-1726) —
--   so the release rule makes this cut a minor: 1.1.0+upstream.9543c29, the
--   range 049..051 frozen by releases.json, and this file its last on purpose:
--   a brain at 051 is exactly the release, preflight's schema-version row says so
--   beside the ledger's highest migration, and a brain migrated past 051 is "past
--   the range its version names" until the next cut.
--
--   The literal below is held equal to db/version.mjs's FORK_VERSION by
--   check-fork-consistency's 17d (the highest schema_version writer is the
--   current version), and scripts/assemble-release.ts refuses --write until
--   both say the version it is about to record.
--
-- WHAT
--   * Upsert ob1_config.schema_version, as 044 and 048 do. A plain constant —
--     not an OB1_* env value — so there is no shell-vs-record disagreement for
--     --reapply to refuse; under --reapply every file re-runs in order and this
--     later write wins.
--
-- SAFETY
--   Idempotent (ON CONFLICT DO UPDATE). No schema change — one config row — so a
--   brain at 050 applies it in milliseconds; the release job's stack proves the
--   range on the published images before the release exists.
-- =============================================================================

INSERT INTO ob1_config (key, value) VALUES
  ('schema_version', '1.1.0+upstream.9543c29')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value, updated_at = now();
