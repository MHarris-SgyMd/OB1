-- =============================================================================
-- Migration 044: the brain records the version it was migrated under —
--                ob1_config.schema_version (SMD-1804)
-- =============================================================================
--
-- WHY
--   Until now a brain's identity was "the highest migration its ledger records"
--   (043 today) plus whichever server happened to be checked out. There was no
--   single number to compare, so preflight reasoned about "last definer" per
--   function and a release could not say what it closed. SMD-1804 gives the fork
--   a version — MAJOR.MINOR.PATCH+upstream.<sha> (FORK.md's "Versioning") — and
--   this migration is where a brain reports the one it runs.
--
--   0.0.0+upstream.9543c29 is the pre-first-release BASELINE: the machinery is in
--   place but no release has been cut, so a fresh brain reports this rather than
--   leaving preflight to warn on a missing key forever. The first release cut
--   (assembled and tagged by the release step, not by hand) appends its own tiny
--   migration that upserts the number that cut deserves — 1.0.0 — as the last
--   step of its migration range; --reapply re-runs every file in order, so the
--   later write wins and the row lands at the latest release's version.
--
--   The literal below is held equal to db/version.mjs's FORK_VERSION by
--   check-fork-consistency's checkSchemaVersion: the string a brain reports and
--   the string the tooling computes cannot drift.
--
-- WHAT
--   * Upsert ob1_config.schema_version. ob1_config exists by 006 (this file runs
--     after it), and the row is a plain constant — not an OB1_* env value — so
--     unlike embedding_dim/model/chunk_context there is no shell-vs-record
--     disagreement for --reapply to refuse; the write is unconditional.
--   * COMMENT ON COLUMN is not available (ob1_config.value is one shared column);
--     the contract for this key lives in db/version.mjs and db/README.md.
--
-- SAFETY
--   Idempotent (ON CONFLICT DO UPDATE, as 006/013 do for their keys). No schema
--   change — a new config row, no DDL on data, no function or ACL change — so
--   under the version rules this migration is additive (MINOR), and a fragment
--   that ships it may not claim `bump: patch` (check-fork's checkFragments).
-- =============================================================================

INSERT INTO ob1_config (key, value) VALUES
  ('schema_version', '0.0.0+upstream.9543c29')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value, updated_at = now();
