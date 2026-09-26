-- =============================================================================
-- Migration 057: the third release — ob1_config.schema_version = 1.2.0
--                (the cut FORK.md's "Cutting a release" orders, SMD-1804/SMD-1860)
-- =============================================================================
--
-- WHY
--   051 wrote 1.1.0, the second release, as the last file of the range it froze
--   (049..051). Since then five migrations landed — 052 (thought_changes,
--   SMD-1296), 053 (thought_sources + link facets, SMD-1867), 054 (resolve_agent
--   stale-only touch, SMD-2090), 055 (the capture event carries its payload,
--   SMD-2115) and 056 (the entity-name gate, SMD-1935) — so the release rule
--   makes this cut a minor: 1.2.0+upstream.9543c29, the range 052..057 frozen by
--   releases.json, and this file its last on purpose: a brain at 057 is exactly
--   the release, preflight's schema-version row says so beside the ledger's
--   highest migration, and a brain migrated past 057 is "past the range its
--   version names" until the next cut.
--
--   The literal below is held equal to db/version.mjs's FORK_VERSION by
--   check-fork-consistency's 17d (the highest schema_version writer is the
--   current version), and scripts/assemble-release.ts refuses --write until
--   both say the version it is about to record.
--
-- WHAT
--   * Upsert ob1_config.schema_version, as 044, 048 and 051 do. A plain constant
--     — not an OB1_* env value — so there is no shell-vs-record disagreement for
--     --reapply to refuse; under --reapply every file re-runs in order and this
--     later write wins.
--
-- SAFETY
--   Idempotent (ON CONFLICT DO UPDATE). No schema change — one config row — so a
--   brain at 056 applies it in milliseconds; the release job's stack proves the
--   range on the published images before the release exists.
-- =============================================================================

INSERT INTO ob1_config (key, value) VALUES
  ('schema_version', '1.2.0+upstream.9543c29')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value, updated_at = now();
