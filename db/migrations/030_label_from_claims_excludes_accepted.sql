-- ============================================================================
-- 030 — a label whose only evidence is the operator's acceptance goes back to
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
--   1. A label whose ONLY evidence is an acceptance goes back to NULL. An
--      accepted row under the model's OWN key (exactly `reembed:<model>@<dim>`,
--      no suffix) exists for the thought — the latest row or not: a later
--      acceptance under ANOTHER model's key does not vouch for this label,
--      and a later real pass wrote the vector, moving updated_at past the
--      bound below — the thought is labelled with that key's model, it has a
--      vector, and nothing has written it since the row was ENQUEUED
--      (`enqueued_at`; `claimed_at`, then `finished_at`, for a row written by
--      hand without one; a row with none is never standing). The enqueue,
--      not the claim or the release: the pool is
--      built from the rows not at the model, so a thought the pool took was
--      not at it THEN — and a label saying it is, with nothing written since,
--      can only be 021's block having trusted the acceptance. Anything
--      written after the enqueue is a server's or the worker's, and its label
--      is theirs: a capture at the model landing between the enqueue and the
--      claim (the worker re-embeds regardless, may fail, and --accept-failed
--      accepts a thought already at the target whatever its timestamps); a
--      head window or bare windows the worker wrote through update_thought
--      before the row's outcome was chosen; an edit or re-capture since.
--   2. 021's rule, with accepted rows excluded from the claim rows it reads:
--      the latest succeeded row that is NOT an acceptance decides, so a
--      thought an earlier pass did write is labelled at that pass's model —
--      exactly the vector the acceptance kept — and a thought with no such
--      row stays NULL, unknown. Applied to unlabelled rows only, as 021's is.
--
--   The rows both statements read are one text, config.mjs's
--   CLAIM_EVIDENCE_ROWS_SQL, substituted here as {{CLAIM_EVIDENCE_ROWS}} and
--   read as a constant by `migrate.ts --reapply`'s gate, so what the gate
--   refuses and what this file corrects are decided by one spelling: every
--   succeeded row under a key naming a model — the grammar is 021's, byte for
--   byte (`[0-9]+`), since 021 decides what is evidence and a narrower reader
--   would miss rows it labels from; "the model's own key" is the canonical
--   spelling, as poolModelFor has it — its model, whether the key is the
--   model's own, whether the row is an acceptance (`last_error IS NOT NULL
--   AND starts_with(…)`; starts_with(NULL, …) is NULL, and NOT NULL is not
--   true), its timestamps, and the latest finished_at among the thought's
--   rows (the gate's, to match what 021 picks from a tie). Statement 2 chooses
--   one row, the key breaking a tie on finished_at (two releases in one
--   transaction share now()), so its choice is the same on every run.
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
--   stands over an unlabelled thought (or an own-key acceptance over a thought
--   written since its enqueue, which 021 labels — its bound is the release —
--   and statement 1 leaves), naming it and the way back. A label the operator
--   wrote by a raw UPDATE is the operator's — with the trigger ON, since then
--   updated_at moved past the bound; written under a hand-held trigger, as a
--   test models a hand label, it is indistinguishable from 021's block's and
--   statement 1 takes it back. And a label 021's block wrote
--   that a metadata-only edit has since moved `updated_at` past the enqueue:
--   update_thought keeps the label when no content arrives, so the edit is
--   not evidence about the vector — but nothing here tells it from a
--   re-capture, and the label stands; the pool never takes it. Known, and
--   left: the alternative, reading 008's audit rows for a content or vector
--   change, is a second evidence rule.
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
  -- Prerequisites, said with the remedy: on a brain adopted with --baseline
  -- whose schema is older than its ledger says, this is the first pending file
  -- that reads 015's table and 021's column, and a plain run would otherwise
  -- fail here with a bare "does not exist" and no pointer — with the server
  -- gated on the migrator in the compose stack. Under --reapply both are in
  -- place by the time this file runs.
  IF to_regclass('thought_work_claims') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('thoughts') AND attname = 'embedding_model' AND NOT attisdropped) THEN
    RAISE EXCEPTION USING
      MESSAGE = format('migration 030 needs 015 (thought_work_claims) and 021 (thoughts.embedding_model); this schema lacks %s',
                       CASE WHEN to_regclass('thought_work_claims') IS NULL THEN 'thought_work_claims' ELSE 'thoughts.embedding_model' END),
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (fourth review pass saw the remedy printed one letter per NUL).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;

  -- Nothing to read: no succeeded row under a key naming a model, so neither
  -- statement could write, and the trigger hold's table lock is not taken.
  IF NOT EXISTS (SELECT 1 FROM thought_work_claims WHERE status = 'succeeded' AND work_type ~ '{{REEMBED_KEY_MODEL_RE}}') THEN
    RETURN;
  END IF;

  ALTER TABLE thoughts DISABLE TRIGGER thoughts_updated_at;

  -- 1. The label 021's block wrote from an acceptance under the own key: back
  --    to unknown. Any accepted own-key row for the label's model, the latest
  --    or not; the bound is the row's enqueue, see the header.
  UPDATE thoughts t
     SET embedding_model = NULL
    FROM ({{CLAIM_EVIDENCE_ROWS}}) e
   WHERE t.id = e.thought_id
     AND e.accepted AND e.own_key
     AND t.embedding_model = e.model
     AND t.embedding IS NOT NULL
     AND COALESCE(t.updated_at, t.created_at) <= COALESCE(e.enqueued_at, e.claimed_at, e.finished_at, '-infinity'::timestamptz);

  -- 2. 021's evidence rule, accepted rows excluded before the latest row is
  --    chosen: the latest row that is not an acceptance decides, the key
  --    breaking a tie so the choice is the same on every run.
  UPDATE thoughts t
     SET embedding_model = e.model
    FROM (
      SELECT DISTINCT ON (k.thought_id) k.thought_id, k.model, k.finished_at
        FROM ({{CLAIM_EVIDENCE_ROWS}}) k
       WHERE NOT k.accepted
       ORDER BY k.thought_id, k.finished_at DESC, k.work_type
    ) e
   WHERE t.id = e.thought_id
     AND t.embedding_model IS NULL
     AND t.embedding IS NOT NULL
     AND t.updated_at <= e.finished_at;

  ALTER TABLE thoughts ENABLE TRIGGER thoughts_updated_at;
END
$lb$;
