-- =============================================================================
-- Migration 048: the first release — ob1_config.schema_version = 1.0.0
--                (SMD-1804's cut, the shape SMD-1860 orders)
-- =============================================================================
--
-- WHY
--   044 wrote the pre-first-release baseline, 0.0.0+upstream.9543c29, so a brain
--   reported a version before any release existed. This is the first cut: the
--   migration range 001..048 is frozen by releases.json under the version
--   1.0.0+upstream.9543c29 — SemVer's "the public API is now defined", whatever
--   the assembled fragments' bumps — and the brain that applies the range reports
--   it. The migration is the range's last file on purpose (FORK.md, "Cutting a
--   release"): a brain at 048 is exactly the release, and preflight's
--   schema-version row says so beside the ledger's highest migration; a brain
--   migrated past 048 is "past the range its version names", which preflight
--   warns about by name until the next cut.
--
--   The literal below is held equal to db/version.mjs's FORK_VERSION by
--   check-fork-consistency's 17d (the highest schema_version writer is the
--   current version), and scripts/assemble-release.ts refuses --write until
--   both say the version it is about to record.
--
-- WHAT
--   * Upsert ob1_config.schema_version, as 044 does. A plain constant — not an
--     OB1_* env value — so there is no shell-vs-record disagreement for
--     --reapply to refuse; under --reapply every file re-runs in order and this
--     later write wins.
--
-- SAFETY
--   Idempotent (ON CONFLICT DO UPDATE). No schema change — one config row — so a
--   brain at 047 applies it in milliseconds; the release job's stack proved the
--   range on the published images before the release existed.
-- =============================================================================

INSERT INTO ob1_config (key, value) VALUES
  ('schema_version', '1.0.0+upstream.9543c29')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value, updated_at = now();
