-- ============================================================================
-- 029 — a label whose only evidence is the operator's acceptance goes back to
--       unknown, and the evidence rule labels with accepted rows excluded
--       (SMD-1193)
--
-- Why
--   021's evidence backfill labels a thought from its latest SUCCEEDED claim
--   row under a key naming a model (`reembed:<model>@<dim>[:suffix]`), when
--   nothing has written the thought since the row finished
--   (`updated_at <= finished_at`). It was written before SMD-1067 (FORK.md
--   change 39), and since then a succeeded row can be the operator's
--   ACCEPTANCE of a failure: `reembed.ts --accept-failed` marks a row the
--   provider refuses permanently succeeded, with a caveat that begins with
--   ACCEPTED_CAVEAT_PREFIX (config.mjs spells it once; 028 states the rule at
--   the table). The thought kept the vector it had, which is by decision NOT at
--   that key's model. 021's rule cannot tell the two rows apart, and 021 is
--   applied and hashed, so its text is never corrected. Nothing runs that body
--   again on an applied brain — except a re-run of the file: the remedy
--   `reembed.ts` printed until this change for a brain adopted with
--   `migrate.ts --baseline` whose schema is older than its ledger says (paste
--   the body, substituting the width), and `migrate.ts --reapply`, which
--   re-runs every migration in order, in one transaction, and reaches this
--   file after it.
--   Over an accepted row whose thought is unlabelled, 021's block labels the
--   thought at the key's model. From then on reembed.ts's pool never takes it
--   (the label says it is at the target), preflight's `vector models` counts
--   it at the model, and no reader cross-checks the label against the caveat:
--   the wrong vector is invisible to both readers for good.
--
-- What this does
--   Two statements, in one DO block, over the corpus as it is:
--
--   1. A label whose ONLY evidence is an acceptance goes back to NULL. The
--      thought's latest succeeded row under a key naming a model is an
--      accepted one under the model's OWN key (exactly `reembed:<model>@<dim>`,
--      no suffix), the thought is labelled with that key's model, it has a
--      vector, and nothing has written it since the attempt READ it —
--      `claimed_at`, the bound every reader of an acceptance applies
--      (SMD-1067; `finished_at` for a row never claimed, and a row with
--      neither is never standing), not 021's `finished_at`: the worker writes
--      a head window or bare windows through update_thought BEFORE the row's
--      outcome is chosen, so a row that then failed and was accepted may sit
--      over a thought the worker itself labelled at the model, written
--      between the claim and the release, and that label is right. Under the
--      own key a thought AT the model is never pooled (021: the pool is the
--      rows not at it), so such a row can exist only for a thought that was
--      not at the model when the pass read it — and a label saying it is,
--      with nothing written since the read, can only be 021's block having
--      trusted the acceptance. An edit or re-capture since the read is a
--      server's write and its label is the server's: left alone.
--   2. 021's rule, with accepted rows excluded from the claim rows it reads:
--      the latest succeeded row that is NOT an acceptance decides, so a
--      thought an earlier pass did write is labelled at that pass's model —
--      exactly the vector the acceptance kept — and a thought with no such
--      row stays NULL, unknown. Applied to unlabelled rows only, as 021's is.
--
--   `last_error IS NOT NULL AND starts_with(last_error, <prefix>)` guards the
--   prefix test: starts_with(NULL, …) is NULL, and NOT NULL is not true. The
--   key grammar is config.mjs's, substituted ({{REEMBED_KEY_MODEL_RE}},
--   {{REEMBED_OWN_KEY_RE}}), as the prefix is. The latest row is chosen by
--   finished_at and then by key: two rows released in one transaction share
--   now(), and the winner decides whether a label is taken back, so it must be
--   the same row on every run — 021 has no tiebreak, and its outcome does not
--   depend on which row wins beyond the model it names.
--
-- What it leaves
--   An acceptance under a SUFFIXED key (`reembed:<model>@<dim>:ctx`, a
--   backfill whose reason is not the model) is not read by statement 1: a
--   backfill key pools every thought, at the model included, so a thought
--   labelled at that model with such an acceptance may be labelled rightly
--   (the server's own capture) — and 021's block, reading suffixed keys as
--   evidence too, may have labelled it wrongly. The two cannot be told apart
--   here; statement 2 excludes such rows from what it labels, so no NEW label
--   is written from one by THIS file — and because 021's block, re-run as
--   written, would write one, `migrate.ts --reapply` refuses while such a row
--   stands over an unlabelled thought, naming it and the way back
--   (`reembed.ts --job <key> --retry-fallbacks`, or `--retire <key>`). A label
--   the operator wrote by a raw UPDATE is the operator's.
--
-- The rule for a successor
--   Any future backfill that labels from claim rows carries the exclusion in
--   statement 2; this file is its spelling, and `db/reembed.ts`'s header
--   ("Saying I know") states it.
--
-- Safety
--   * No column, no function, no signature. The only writes are to
--     `thoughts.embedding_model`: NULL where statement 1 applies, a label
--     where statement 2 does. No DELETE.
--   * The label is a fact about a vector already there, not an edit: 001's
--     updated_at trigger is held off for the block — inside the one DO block,
--     so the hold and its release cannot be separated however the file is run
--     — and no row's updated_at moves; 008's audit trigger diffs content,
--     metadata and the vector's presence, and sees no event.
--   * Idempotent. A second run finds no label whose only evidence is an
--     acceptance (statement 1 removed them, or they were never written) and no
--     unlabelled row with evidence statement 2 has not already used.
--
-- Prerequisites
--   015 (thought_work_claims), 021 (thoughts.embedding_model). Applied by
--   `bun db/migrate.ts`; `--reapply` runs every migration and reaches this one
--   after 021, in the same transaction.
--
-- Expected outcome
--   No thought labelled at a model on the strength of an acceptance under
--   that model's own key; every unlabelled thought with a plain succeeded row
--   that vouches for its vector labelled from it.
-- ============================================================================

DO $lb$
BEGIN
  ALTER TABLE thoughts DISABLE TRIGGER thoughts_updated_at;

  -- 1. The label 021's block wrote from an acceptance under the own key: back
  --    to unknown. The latest row decides, as it did for 021; the bound is the
  --    acceptance's (claimed_at), see the header.
  UPDATE thoughts t
     SET embedding_model = NULL
    FROM (
      SELECT DISTINCT ON (k.thought_id) k.thought_id, k.model, k.claimed_at, k.finished_at, k.accepted, k.own_key
        FROM (
          SELECT c.thought_id, c.work_type, c.claimed_at, c.finished_at,
                 substring(c.work_type FROM '{{REEMBED_KEY_MODEL_RE}}') AS model,
                 c.work_type ~ '{{REEMBED_OWN_KEY_RE}}' AS own_key,
                 (c.last_error IS NOT NULL AND starts_with(c.last_error, '{{ACCEPTED_CAVEAT_PREFIX}}')) AS accepted
            FROM thought_work_claims c
           WHERE c.status = 'succeeded' AND c.finished_at IS NOT NULL
        ) k
       WHERE k.model IS NOT NULL
       -- The key breaks a tie on finished_at: two rows released in one
       -- transaction (a hand repair under `psql -1`) share now(), and which
       -- one wins decides whether the label is taken back — so it must be the
       -- same one on every run for the block to be idempotent.
       ORDER BY k.thought_id, k.finished_at DESC, k.work_type
    ) e
   WHERE t.id = e.thought_id
     AND e.accepted AND e.own_key
     AND t.embedding_model = e.model
     AND t.embedding IS NOT NULL
     AND COALESCE(t.updated_at, t.created_at) <= COALESCE(e.claimed_at, e.finished_at, '-infinity'::timestamptz);

  -- 2. 021's evidence rule, accepted rows excluded before the latest row is
  --    chosen: the latest row that is not an acceptance decides.
  UPDATE thoughts t
     SET embedding_model = e.model
    FROM (
      SELECT DISTINCT ON (k.thought_id) k.thought_id, k.model, k.finished_at
        FROM (
          SELECT c.thought_id, c.work_type, c.finished_at,
                 substring(c.work_type FROM '{{REEMBED_KEY_MODEL_RE}}') AS model
            FROM thought_work_claims c
           WHERE c.status = 'succeeded' AND c.finished_at IS NOT NULL
             AND NOT (c.last_error IS NOT NULL AND starts_with(c.last_error, '{{ACCEPTED_CAVEAT_PREFIX}}'))
        ) k
       WHERE k.model IS NOT NULL
       ORDER BY k.thought_id, k.finished_at DESC, k.work_type
    ) e
   WHERE t.id = e.thought_id
     AND t.embedding_model IS NULL
     AND t.embedding IS NOT NULL
     AND t.updated_at <= e.finished_at;

  ALTER TABLE thoughts ENABLE TRIGGER thoughts_updated_at;
END
$lb$;
