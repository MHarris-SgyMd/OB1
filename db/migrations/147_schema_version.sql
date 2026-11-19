-- =============================================================================
-- Migration 147: the thirteenth release — ob1_config.schema_version = 2.2.0
--                (the cut MAINTAINING.md's "Cutting a release" orders, SMD-1804/SMD-1860)
-- =============================================================================
--
-- WHY
--   146 wrote 2.1.0, the twelfth release, as the last file of the range it
--   froze (122..146). Since then no migration landed: the eleven changes since —
--   the forget's fan-out to the other brains (SMD-1723), priority findings
--   over REST and MCP (SMD-3671), and SMD-3318, SMD-4308, SMD-4291, SMD-4352,
--   SMD-4363, SMD-4369, SMD-3379, SMD-4347 and SMD-4401 — are code, documents
--   and tests.
--   main carries no `bump: major` fragment, so the release rule makes this cut
--   a minor: 2.2.0, the range 147..147 frozen by releases.json, and this file
--   its only member on purpose: a brain at 147 is exactly the release,
--   preflight's schema-version row says so beside the ledger's highest
--   migration, and a brain migrated past 147 is "past the range its version
--   names" until the next cut.
--
--   The version is plain MAJOR.MINOR.PATCH (SMD-3317): the frozen upstream pin
--   is kept as data (releases.json's `upstream` key), not as a suffix.
--
--   The literal below is held equal to db/version.mjs's BRAIN_VERSION by
--   check-consistency's 17d (the highest schema_version writer is the current
--   version), and scripts/assemble-release.ts refuses --write until both say
--   the version it is about to record.
--
-- WHAT
--   * Upsert ob1_config.schema_version, as 044, 048, 051, 057, 062, 072, 076,
--     081, 083, 089, 103, 121 and 146 do. A plain constant — not an OB1_* env
--     value — so there is no shell-vs-record disagreement for --reapply to
--     refuse; under --reapply every file re-runs in order and this later write
--     wins.
--
-- SAFETY
--   Idempotent (ON CONFLICT DO UPDATE). No schema change — one config row — so a
--   brain at 146 applies it in milliseconds; the release job's stack proves the
--   range on the published images before the release exists.
-- =============================================================================

INSERT INTO ob1_config (key, value) VALUES
  ('schema_version', '2.2.0')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value, updated_at = now();
