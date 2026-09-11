-- ============================================================================
-- 023 — 003's missing half: every legacy singleton, and the oldest of each
--       twin group, takes its fingerprint once
--
-- Why (Linear SMD-1042, found by SMD-1022's first review pass)
--   Migration 003 added content_fingerprint with a partial unique index
--   (WHERE content_fingerprint IS NOT NULL) and no backfill; its header gives
--   no reason. Every row from before it carries NULL, and so does every row a
--   load inserted around upsert_thought — the getting-started guide's
--   hand-pasted schema (docs/01-getting-started.md, step 2.6) is exactly such
--   a brain. Two consequences survived 018:
--
--     * upsert_thought capturing text equal to a legacy row inserts a SECOND
--       row. ON CONFLICT cannot see a NULL, so 003's conflict target never
--       fires for it. Silently: the capture succeeds, search returns both,
--       and every later capture of that text merges into the new row while
--       the old one stays. 018's header states this and does not fix it.
--     * A legacy row gains its fingerprint only when a re-embed pass visits
--       it (018 writes the fingerprint on an unchanged edit). A brain that
--       never runs `reembed.ts --switch-model` keeps every pre-003 singleton
--       unfingerprinted for ever, and reembed.ts's duplicate report hashes
--       every NULL row on each --status.
--
--   018 deferred the rule to this ticket in so many words: "which twin owns
--   the text is whichever edit committed first, until SMD-1042 states a rule
--   (oldest by created_at) and applies it to the rest." Feasible now because
--   016's content_fingerprint_of(text) — IMMUTABLE STRICT, byte-identical to
--   003's inline rule — exists, because 008's audit trigger diffs content,
--   metadata and the vector's presence and nothing else (a fingerprint-only
--   UPDATE writes no audit row), and because a guarded UPDATE re-applies as
--   a no-op.
--
-- The rule: the oldest takes the key, when the key is free
--   A row without a fingerprint takes content_fingerprint_of(content) when
--
--     * no row holds that key — the same text under a fingerprint, or a
--       STALE key (a hash left by a raw update of content around the
--       writers: 018's fingerprint_held_by case). The key is taken, whatever
--       the holder's text; 018 decided that and this migration does not
--       re-decide it. A row blocked by a stale holder is corrected the day
--       that holder's own text is re-saved, as 018's header says; and
--
--     * it is the OLDEST of the rows without a fingerprint that hash to it:
--       ORDER BY created_at, id — NULL created_at (a raw load may leave it)
--       last, the id as the tiebreak. The same order db/reembed.ts's
--       duplicate report already lists a group in, so the first id it prints
--       is the row that takes the key here.
--
--   So a legacy singleton — the common case — is fingerprinted, and a capture
--   of its text from now on merges into it. True twins (two or more NULL rows
--   normalising to one text) end with exactly one fingerprinted, the rest
--   NULL: the state 018 leaves after a pass, so update_thought's duplicate_of
--   and the pairs list keep meaning what they meant, and the partial index is
--   never violated. A row that already carries a key is not touched, right
--   or stale.
--
--   Not the community recipe's rule. recipes/fingerprint-dedup-backfill
--   strips trailing punctuation, possessives and plurals before hashing, so
--   the fingerprints it writes never match the ones capture computes; a brain
--   that ran it holds stale keys in 018's sense, and this migration leaves
--   them where they are.
--
-- A function, so the remedy is one statement
--   The rule lives in backfill_content_fingerprints(p_limit integer DEFAULT
--   NULL), and this file calls it once. 021's backfill is an inline DO block;
--   this one is a function because it is needed again: a load that inserts
--   into `thoughts` directly after this migration leaves NULL rows again, and
--   the remedy is then `SELECT backfill_content_fingerprints();` — one
--   statement preflight's `fingerprint backfill` check can name, rather than
--   a body to re-run by hand (the remedy shape SMD-1193 found wanting).
--   Re-applying this file re-runs it, and it is a no-op when nothing is left
--   to write: it hashes only the rows whose fingerprint is NULL. p_limit is
--   for the by-hand path — an operator who wants short lock windows after a
--   raw load calls it in batches until it returns 0 — and the NOT EXISTS sits
--   INSIDE the limited set, so a batch counts only rows it will write and 0
--   means none remain. The migration itself takes the whole corpus.
--
-- One transaction, and the lock is the point
--   Under bun migrate.ts the file is one transaction. The function's first
--   statement is LOCK TABLE thoughts IN EXCLUSIVE MODE, held to commit, and
--   the lock is what makes the rule exact:
--
--     * a concurrent upsert_thought of a legacy singleton's text cannot
--       insert a fingerprinted row under the backfill and leave the UPDATE to
--       raise 23505 on the unique index. The INSERT waits, then lands ON
--       CONFLICT on the row this migration just fingerprinted and merges —
--       the defect fixed in the same instant it would have struck.
--     * a concurrent update_thought — a re-embed pass reaching a legacy twin,
--       an edit into a legacy singleton's text — waits at its `SELECT … FOR
--       UPDATE`, because ROW SHARE conflicts with EXCLUSIVE. Then its holder
--       lookup (a fresh READ COMMITTED snapshot) sees the committed key and
--       it answers duplicate_of or DUPLICATE_CONTENT. The trigger hold below
--       takes only SHARE ROW EXCLUSIVE, which ROW SHARE does not conflict
--       with: under that lock alone the edit would pass its lookup, wait at
--       its UPDATE, and raise 23505 after the commit — the symptom 018
--       removed, back for the duration of the upgrade.
--     * a write in flight before the LOCK holds it up until that write
--       commits, and the UPDATE's own snapshot then sees the row in NOT
--       EXISTS. Bounded: lock_timeout is set to 10 s for this transaction
--       (set_config with is_local, so it rolls back with the file), and an
--       idle-in-transaction writer fails the migration — re-run it — rather
--       than queueing every other writer behind the wait.
--
--   Reads (ACCESS SHARE) proceed throughout: search is not blocked, captures
--   and edits wait. Not batched inside the migration — a loop in one
--   transaction changes nothing about the locks, and a tool outside the
--   migrator would lose the ledger's word that the corpus is fingerprinted.
--
--   The updated_at trigger is held off for the UPDATE, as 021's backfill
--   holds it: the fingerprint is not an edit. 001's BEFORE UPDATE trigger
--   would stamp every row written, and two rules read that column — 021's
--   `updated_at <= finished_at` evidence, which would stop vouching for every
--   legacy row's vector, and 018's if_unchanged_since guard, which would tell
--   a client holding a pre-migration read STALE_READ on a row nothing edited.
--   DISABLE and ENABLE are statements of one function in one transaction, so
--   they cannot be separated however the file is run; preflight's `updated_at
--   trigger` check still says so if a hand DISABLE is ever left behind.
--
-- Cost
--   content_fingerprint is indexed, so the UPDATE is never HOT: every row
--   written is a new tuple entered into every index on thoughts — the primary
--   key, the HNSW index, the metadata GIN, created_at, the partial index, and
--   011's trigram GIN where it was built. 021's backfill is not a precedent:
--   embedding_model is unindexed, so that UPDATE was HOT. The hash itself is
--   one sha256 per NULL row and one probe of the partial index per candidate.
--   Measured on the test container at 1,024 dimensions, 20,000 legacy rows
--   with random vectors beside 20,000 fingerprinted ones, HNSW built by 001:
--   the whole-corpus call 56 s (2.8 ms a row — the index maintenance is the
--   cost: the same call with the HNSW index dropped, 0.34 s); a p_limit batch
--   of 1,000 1.7 s; the no-op re-run 9 ms. Per 100,000 legacy rows, about
--   five minutes of waiting writers. A brain with millions of legacy rows
--   should not take that in one transaction: run this file by hand up to but
--   not including its final SELECT (the function and its COMMENT), call
--   backfill_content_fingerprints(10000) in batches until it returns 0, then
--   `bun db/migrate.ts` — its call finds nothing and writes the ledger row.
--   migrate.ts sets no statement_timeout, so a server default applies to the
--   UPDATE; on a large legacy brain, apply this migration in a quiet window.
--
-- What the audit sees: nothing new
--   008's trigger compares content, metadata and whether a vector is present;
--   a fingerprint-only UPDATE is an empty diff and returns before writing.
--   016's entity trigger fires on INSERT OR UPDATE OF content only. No row in
--   thought_audit, no row in the work queue, no updated_at moved.
--
-- Safety
--   * Additive. No column added, altered or dropped; no signature changed; no
--     DELETE, no DROP. The one UPDATE writes a column that was NULL, to a
--     value the partial unique index accepts (checked by NOT EXISTS under the
--     table lock), on rows chosen by the rule above.
--   * Privileges. SECURITY INVOKER, as every function in this fork. ALTER
--     TABLE … DISABLE TRIGGER needs the table's owner — the migrator's role.
--     A non-owner calling the function is refused with "must be owner of
--     table thoughts", having written nothing; preflight names the owner in
--     its remedy.
--   * Idempotent. CREATE OR REPLACE of one function; the call is a no-op when
--     no row is left to write; COMMENT re-issued.
--
-- Prerequisites
--   Migration 016 (content_fingerprint_of) and 018 (the rule this completes,
--   whose duplicate_of is what a twin left NULL reports). Applied by `bun
--   db/migrate.ts`.
--
-- Expected outcome
--   Every thought whose normalised text no other thought holds carries its
--   fingerprint; of each group that shares one text, the oldest carries it
--   and the rest read NULL. A capture of a former singleton's text merges
--   into it. updated_at and thought_audit are as they were. Preflight's
--   `fingerprint backfill` reports no row pending.
-- ============================================================================

CREATE OR REPLACE FUNCTION backfill_content_fingerprints(p_limit integer DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_written integer;
BEGIN
  -- Bounded wait for the table lock, for this transaction only: a writer idle
  -- in a transaction fails this call rather than queueing every other writer
  -- behind it. See "One transaction, and the lock is the point".
  PERFORM set_config('lock_timeout', '10s', true);

  -- EXCLUSIVE, not the SHARE ROW EXCLUSIVE the trigger hold would take on its
  -- own: it conflicts with update_thought's FOR UPDATE (ROW SHARE) as well as
  -- with every INSERT, UPDATE and DELETE, so no writer can decide against a
  -- key this call is about to write. Reads proceed.
  LOCK TABLE thoughts IN EXCLUSIVE MODE;

  -- The fingerprint is not an edit: 001's trigger would stamp updated_at on
  -- every row written, and 021's evidence rule and 018's stale-read guard
  -- both read it. Held off for the one statement, re-enabled below.
  ALTER TABLE thoughts DISABLE TRIGGER thoughts_updated_at;

  UPDATE thoughts t
     SET content_fingerprint = o.fp
  FROM (
    -- Of the rows without a fingerprint whose key no row holds, the oldest
    -- per key: created_at then id, NULL created_at last — the order
    -- db/reembed.ts lists a duplicate group in. The NOT EXISTS is inside the
    -- limited set so that a batch counts only rows it writes and a result of
    -- 0 means none remain.
    SELECT DISTINCT ON (c.fp) c.id, c.fp
      FROM (
        SELECT id, created_at, content_fingerprint_of(content) AS fp
          FROM thoughts
         WHERE content_fingerprint IS NULL
      ) c
     WHERE NOT EXISTS (SELECT 1 FROM thoughts h WHERE h.content_fingerprint = c.fp)
     ORDER BY c.fp, c.created_at, c.id
     LIMIT p_limit
  ) o
  WHERE t.id = o.id
    AND t.content_fingerprint IS NULL;
  GET DIAGNOSTICS v_written = ROW_COUNT;

  ALTER TABLE thoughts ENABLE TRIGGER thoughts_updated_at;
  RETURN v_written;
END;
$$;

COMMENT ON FUNCTION backfill_content_fingerprints(integer) IS
  'Migration 003''s missing backfill (023): every thought without a content_fingerprint whose normalised text no other thought holds takes it, and of each group sharing one text the oldest (created_at, id) takes it while the rest stay NULL — the state 018 leaves after a pass. Locks thoughts IN EXCLUSIVE MODE for the transaction (writers wait, readers do not; lock_timeout 10s) and holds the updated_at trigger: the fingerprint is not an edit. Returns the rows written; p_limit bounds a batch, and 0 means none remain. Needs the table''s owner. Run again after a load that inserted into thoughts directly.';

-- Once, over the whole corpus. Re-applying the file re-runs it and it writes
-- nothing: only rows whose fingerprint is NULL and whose key is free qualify.
SELECT backfill_content_fingerprints();
