-- =============================================================================
-- Migration 076: the sixth release — ob1_config.schema_version = 1.5.0
--                (the cut FORK.md's "Cutting a release" orders, SMD-1804/SMD-1860)
-- =============================================================================
--
-- WHY
--   072 wrote 1.4.0, the fifth release, as the last file of the range it froze
--   (063..072). Since then three additive migrations landed — 073 (the trust of
--   the write on the row, SMD-1724), 074 (min_trust on match_thoughts and the
--   keyword read, SMD-1724) and 075 (min_trust on the hybrid and the current
--   read, SMD-1724) — so the release rule makes this cut a minor:
--   1.5.0+upstream.9543c29, the range 073..076 frozen by releases.json, and
--   this file its last on purpose: a brain at 076 is exactly the release,
--   preflight's schema-version row says so beside the ledger's highest
--   migration, and a brain migrated past 076 is "past the range its version
--   names" until the next cut.
--
--   The literal below is held equal to db/version.mjs's FORK_VERSION by
--   check-fork-consistency's 17d (the highest schema_version writer is the
--   current version), and scripts/assemble-release.ts refuses --write until
--   both say the version it is about to record.
--
-- WHAT
--   * Upsert ob1_config.schema_version, as 044, 048, 051, 057, 062 and 072 do.
--     A plain constant — not an OB1_* env value — so there is no
--     shell-vs-record disagreement for --reapply to refuse; under --reapply
--     every file re-runs in order and this later write wins.
--
-- SAFETY
--   Idempotent (ON CONFLICT DO UPDATE). No schema change — one config row — so a
--   brain at 075 applies it in milliseconds; the release job's stack proves the
--   range on the published images before the release exists.
-- =============================================================================

INSERT INTO ob1_config (key, value) VALUES
  ('schema_version', '1.5.0+upstream.9543c29')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value, updated_at = now();
