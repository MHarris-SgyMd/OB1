-- =============================================================================
-- Migration 103: the tenth release — ob1_config.schema_version = 1.9.0
--                (the cut FORK.md's "Cutting a release" orders, SMD-1804/SMD-1860)
-- =============================================================================
--
-- WHY
--   089 wrote 1.8.0, the ninth release, as the last file of the range it froze
--   (084..089). Since then thirteen additive migrations landed — 090 (a
--   re-capture says what it did, SMD-2898), 091 (every settle kept, SMD-2913),
--   092 (a capture-only key's thought taken while its supersedes waits,
--   SMD-2708), 093 (a long thought's extraction windows survive a stop,
--   SMD-2694), 094 (a proposal's review names its writers, SMD-2707), 095 and
--   098 (the stated-status label's inputs, read and bounded, SMD-2540), 096
--   (pg_stat_statements, SMD-1849), 097 (one lapse definition, SMD-3035), 099
--   (an unlink takes the review lock, SMD-3045), 100 (the vectorless index,
--   SMD-3056), 101 (the sleep scheduler's own cuts, SMD-3060) and 102 (the
--   judge's distinct stored, SMD-3117) — so the release rule makes this cut a
--   minor: 1.9.0+upstream.9543c29, the range 090..103 frozen by releases.json,
--   and this file its last on purpose: a brain at 103 is exactly the release,
--   preflight's schema-version row says so beside the ledger's highest
--   migration, and a brain migrated past 103 is "past the range its version
--   names" until the next cut.
--
--   The literal below is held equal to db/version.mjs's FORK_VERSION by
--   check-fork-consistency's 17d (the highest schema_version writer is the
--   current version), and scripts/assemble-release.ts refuses --write until
--   both say the version it is about to record.
--
-- WHAT
--   * Upsert ob1_config.schema_version, as 044, 048, 051, 057, 062, 072, 076,
--     081, 083 and 089 do. A plain constant — not an OB1_* env value — so there
--     is no shell-vs-record disagreement for --reapply to refuse; under
--     --reapply every file re-runs in order and this later write wins.
--
-- SAFETY
--   Idempotent (ON CONFLICT DO UPDATE). No schema change — one config row — so a
--   brain at 102 applies it in milliseconds; the release job's stack proves the
--   range on the published images before the release exists.
-- =============================================================================

INSERT INTO ob1_config (key, value) VALUES
  ('schema_version', '1.9.0+upstream.9543c29')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value, updated_at = now();
