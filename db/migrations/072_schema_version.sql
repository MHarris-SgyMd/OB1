-- =============================================================================
-- Migration 072: the fifth release — ob1_config.schema_version = 1.4.0
--                (the cut FORK.md's "Cutting a release" orders, SMD-1804/SMD-1860)
-- =============================================================================
--
-- WHY
--   062 wrote 1.3.0, the fourth release, as the last file of the range it froze
--   (058..062). Since then nine additive migrations landed — 063 (rebuild_derived,
--   SMD-1732), 064 (the page store, SMD-1812), 065 (the entity name gate's
--   allowlist, SMD-2300), 066 (a derivation never paired with its inputs,
--   SMD-2292), 067 (the pass settles stale proposals, SMD-2297), 068 (the
--   node_state projection kept current on write, SMD-2256), 069 (the durable jobs
--   table, SMD-2318), 070 (the listing flags a lineage pair, SMD-2313) and 071
--   (node_state's dependency columns keyed, SMD-2267) — so the release rule makes
--   this cut a minor: 1.4.0+upstream.9543c29, the range 063..072 frozen by
--   releases.json, and this file its last on purpose: a brain at 072 is exactly
--   the release, preflight's schema-version row says so beside the ledger's
--   highest migration, and a brain migrated past 072 is "past the range its
--   version names" until the next cut.
--
--   The literal below is held equal to db/version.mjs's FORK_VERSION by
--   check-fork-consistency's 17d (the highest schema_version writer is the
--   current version), and scripts/assemble-release.ts refuses --write until
--   both say the version it is about to record.
--
-- WHAT
--   * Upsert ob1_config.schema_version, as 044, 048, 051, 057 and 062 do. A plain
--     constant — not an OB1_* env value — so there is no shell-vs-record
--     disagreement for --reapply to refuse; under --reapply every file re-runs in
--     order and this later write wins.
--
-- SAFETY
--   Idempotent (ON CONFLICT DO UPDATE). No schema change — one config row — so a
--   brain at 071 applies it in milliseconds; the release job's stack proves the
--   range on the published images before the release exists.
-- =============================================================================

INSERT INTO ob1_config (key, value) VALUES
  ('schema_version', '1.4.0+upstream.9543c29')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value, updated_at = now();
