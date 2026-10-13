-- =============================================================================
-- Migration 089: the ninth release — ob1_config.schema_version = 1.8.0
--                (the cut FORK.md's "Cutting a release" orders, SMD-1804/SMD-1860)
-- =============================================================================
--
-- WHY
--   083 wrote 1.7.0, the eighth release, as the last file of the range it froze
--   (082..083). Since then five additive migrations landed — 084 (the judge's
--   relation facets, SMD-1873), 085 (a re-capture restamps a capture-only key's
--   trust, SMD-2664), 086 (the operator's reset of a capture stamp, SMD-2744),
--   087 (the board findings posted, SMD-2681) and 088 (update_thought answers
--   what it did, SMD-2744) — so the release rule makes this cut a minor:
--   1.8.0+upstream.9543c29, the range 084..089 frozen by releases.json, and this
--   file its last on purpose: a brain at 089 is exactly the release,
--   preflight's schema-version row says so beside the ledger's highest
--   migration, and a brain migrated past 089 is "past the range its version
--   names" until the next cut.
--
--   The literal below is held equal to db/version.mjs's FORK_VERSION by
--   check-fork-consistency's 17d (the highest schema_version writer is the
--   current version), and scripts/assemble-release.ts refuses --write until
--   both say the version it is about to record.
--
-- WHAT
--   * Upsert ob1_config.schema_version, as 044, 048, 051, 057, 062, 072, 076,
--     081 and 083 do. A plain constant — not an OB1_* env value — so there is
--     no shell-vs-record disagreement for --reapply to refuse; under --reapply
--     every file re-runs in order and this later write wins.
--
-- SAFETY
--   Idempotent (ON CONFLICT DO UPDATE). No schema change — one config row — so a
--   brain at 088 applies it in milliseconds; the release job's stack proves the
--   range on the published images before the release exists.
-- =============================================================================

INSERT INTO ob1_config (key, value) VALUES
  ('schema_version', '1.8.0+upstream.9543c29')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value, updated_at = now();
