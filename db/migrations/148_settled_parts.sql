-- =============================================================================
-- Migration 148: settled parts — a statement in one thought that another
--                thought settles, proposed by the consolidation pass and
--                decided by a reviewer, both thoughts left standing
--                (SMD-4446 PR 1)
-- =============================================================================
--
-- WHY
--   A supersession proposal (029) says one thought outdates another, and
--   accepting it marks the falling thought superseded whole. The maintainer
--   marked every proposal decide version 5 had made on the canary by
--   2026-11-18 (SMD-3340): of 41, 2 were right as a whole, 32 were right
--   about a part (a statement of the falling thought is outdated, and the
--   thought still stands) and 7 were neither. Nothing stores a part: a pair
--   holds one proposal, and a thought one `supersedes` pointer.
--   docs/subject-anchored-claims.md, rows 8 to 10, decides that the pass
--   records the settled part, as a proposal a reviewer decides.
--
-- WHAT
--   * settled_parts, one row a part: the pair as a proposal names it
--     (older_id, newer_id, by capture order), which of the two holds the
--     statement (holder), the statement's words and the words of the other
--     thought that show it, the fingerprint of each text as judged, the word
--     (one of SMD-3116's eight settling labels) and its group
--     (no_longer_holds, or done_or_settled), the reason, the judge's key, a
--     status (pending, accepted, rejected, stale) and who decided it.
--   * A pair may hold several parts, and a whole-thought proposal (029)
--     beside them: the two tables do not read each other. Two rows of one
--     pair may not hold the same statement in the same thought. The statement
--     is a part's identity as 016's fingerprint reads it
--     (content_fingerprint_of: case, runs of white space and white space at
--     either end folded, as a thought's text is), so a statement a reviewer
--     rejected is not proposed on that pair again in other capitals or
--     spacing, while another statement of the pair may be. The fold is that
--     much and no more, and what counts as a capital or as white space is
--     the database's own (its ctype). A
--     quote that differs by a word or a full stop is another part. So is one
--     that differs by a character a reader does not see, a no-break space, a
--     zero-width space or an accent typed as two characters: of 20 spellings
--     a person would call the same, 9 were recorded beside the rejected
--     statement (review pass 2). And so is one in the straight quotes and
--     hyphens the pass's quote check takes for curly ones and dashes: of 10
--     spellings that check finds in a text, 9 were another part. One span is
--     one part only if the pass records the holder's own characters for it.
--     That is PR 2's to do, as is whether it judges a pair again once the
--     pair holds a part. Nor is a statement of characters no reader sees
--     refused: a zero-width space or a no-break space alone is recorded.
--   * record_settled_part(older, newer, holder, statement, shown_by, word,
--     reason, judge key, both fingerprints, recipe, agent) is the pass's one
--     write. It refuses a part of the wrong shape with a RAISE, and a call
--     above READ COMMITTED, as the decision does. It takes the supersession
--     advisory lock, which a decision on a proposal or a part, a rebuild,
--     delete_thought and forget_thought each take first, so no rebuild at
--     READ COMMITTED runs between its read of the two texts and its commit.
--     (rebuild_derived has no guard of its own. A forget refuses above READ
--     COMMITTED; db/rebuild.ts and the sleep scheduler's sweep run at their
--     session's level, which is READ COMMITTED unless the database or the
--     role defaults higher. Above it, a rebuild that waited on the lock
--     reads the store as its transaction first saw it, and misses the
--     part.) It locks no thought's row for itself (its foreign keys take a
--     key share on each, which no edit waits for): an edit does not wait for
--     it, and one that commits while it runs is as one that commits after it
--     (the next paragraph but one). A thought that is not there when it
--     reads the two is answered NOT_FOUND with the side (older_gone,
--     newer_gone), nothing written and no fingerprint compared: a delete or
--     a forget while the judge was out is the pass's to step over (PR 2).
--     It refuses a judgement of a text that had moved when it read it: that
--     is answered EDITED_SINCE with the side, nothing written, for the pass
--     to put the thought back (PR 2). Otherwise it answers {ok, action, id,
--     status}: `recorded`, with the new row's id and `replaced` (the next
--     paragraph), or `stands`, with the id and status of the row that
--     already holds the statement, which it keeps locked to its
--     transaction's end.
--   * A part's row is one judgement, and none is written over another. When
--     the pass names a statement again and the row that holds it is
--     undecided and no longer a judgement of the texts as they stand (stale,
--     or pending at other fingerprints than the two given, which the write
--     has just read to be the texts'), that row is deleted with its lineage
--     row, and the new judgement is a new row with a new id: `replaced`
--     names the row that went. A pending row judged at these texts stands,
--     and so does a decided one, whatever its texts have done since: the
--     judgement given is then not recorded. So, through the two functions
--     and against any UPDATE, an id names one judgement: a decision on the
--     id of a row a later judgement replaced finds nothing (NOT_FOUND), and
--     cannot land on words its reviewer did not read. An undecided part's
--     id ends when it is replaced: a table that refers to a part refers to
--     a decided one, or lets its reference go with the row, since a foreign
--     key that refused the delete would refuse the write. (By hand, a role
--     holding DELETE and INSERT can remove a row and write another under
--     its id, as one holding UPDATE can move a status: the table does not
--     hold a raw write to the functions' rules. A status moved by hand
--     under a write is the one way `stands` answers stale.)
--   * An edit is not followed by a rebuild: rebuild_derived is the
--     operator's door (db/rebuild.ts), forget's, and the sleep scheduler's
--     sweep, which deletes orphans and marks nothing. Until one runs for the
--     thought, a part recorded before the edit stands pending at the old
--     text. An accept of it is refused (EDITED_SINCE) unless forced, the
--     next judgement of its statement replaces it, and a rebuild of either
--     thought sets it stale and queues its newer thought. A part already
--     stale is queued again by each later rebuild while a text stays
--     moved, and counted stale once.
--   * review_settled_part(id, accept or reject, note, actor, force, was) is
--     the reviewer's decision. An accept is refused when either text has
--     moved since it was judged (EDITED_SINCE), unless forced. A decision
--     that repeats the row's status is refused (ALREADY_ACCEPTED,
--     ALREADY_REJECTED). A caller that gives the status it read (p_was) is
--     refused when the row's is another (STALE_READ, with the row's): a
--     second reviewer does not undo a first unseen, and a row a rebuild has
--     set stale is not decided as pending. A reviewer may reverse a
--     decision, as 036 lets one reverse a proposal's, and may decide a stale
--     row as one may a stale proposal: reject it, or accept it, which a
--     moved text refuses unless forced. The row keeps the last decision
--     alone, its note or none with it, and the reply's `was` says the
--     status it replaced. A forced accept is recorded as any accept is: the
--     row says neither that it was forced nor at which texts, and whether a
--     decision should record them is to settle before the first is made
--     (PR 3). A decision asks no actor, as a proposal's asks none: one made
--     with no envelope is made, and names no reviewer unless its
--     transaction or session had already set one (a second decision in one
--     transaction, given no actor, is stamped with the first's, as a
--     proposal's is). A caller's p_was is the status alone: decisions in
--     between that leave the status as read are not seen. It runs under READ
--     COMMITTED alone (068's rule): above it, an accept that waited on the
--     lock would read the two texts as they were before the wait. The
--     reviewer columns are stamped from the actor envelope by 114's trigger
--     function, which reads only the columns the two tables share.
--   * A part keeps its judgement (settled_parts_keep_judgement): no UPDATE
--     changes its pair, its holder, its quotes, its word, its reason, its
--     fingerprints, its judge or the time it was judged. A part goes with
--     its thoughts and is never pointed at others. The trigger does not hold
--     the status: a role holding UPDATE can move it by hand, as it can a
--     proposal's.
--   * Neither of the part's two functions writes `thoughts`, and nor does
--     the part's arm of rebuild_derived. An accepted part sets no
--     `supersedes` pointer and demotes nothing.
--   * `part` joins the lineage kinds: derivations' CHECK, ob1_record_derivation
--     (111's body with one more kind) and the walk's order
--     (derivation_descendants, 063's body, `part` beside `proposal`: ahead of
--     the kinds the order does not name, which share what the walk's cap of
--     2,000 rows leaves, and behind a thought's own proposals, so a thought
--     with 2,000 of those leaves its parts unwalked: the cap is SMD-4476's).
--   * rebuild_derived is 067's body with the part beside the proposal. When a
--     text moves, a pending part goes stale and its newer thought is queued
--     again under the part's judge key. A decided part stands. A lineage row
--     whose part is gone is deleted. The result gains stale_parts and
--     cascading.parts; that count, like cascading.proposals, is of the
--     lineage rows the walk held: a part written by hand with no lineage
--     row, or one recorded between a rebuild run on its own
--     (db/rebuild.ts --gone) and the delete, goes with the cascade
--     uncounted. Within a forget the write waits on the lock.
--   * Deleting either thought takes its parts (ON DELETE CASCADE), and a
--     part's lineage rows go with the part (settled_parts_drop_derivation),
--     as a proposal's does. forget_thought (139) removes a thought through
--     delete_thought, so a part's quotes leave with either thought.
--   * The planner keeps no statistics on a part's words: SET STATISTICS 0 on
--     statement, shown_by, reason and review_note, and on the identity
--     index's fingerprint. ANALYZE would otherwise copy values of them into
--     pg_statistic, as most common values and histogram bounds, where a
--     forgotten thought's quotes would outlast it.
--
-- UNLIKE A PROPOSAL
--   A part has no confidence and no similarity: the judge gives a word, and
--   a reason, which a proposal's write does not require. Its
--   write reads the two texts and refuses a judgement of one that has moved,
--   where 063's write of a proposal records it (SMD-4480). An undecided
--   part judged again once stale, or at other texts, is replaced by another
--   row, where 063 rewrites a stale proposal in place, so a decision by a
--   part's id cannot land on another judgement (a proposal's can:
--   SMD-4477). Nothing settles a part the pass no longer names, so 067's
--   reopening of a rejection the pass itself made has no arm here: the
--   settle and its reopening are PR 2's. A repeat of a decision is refused,
--   where a proposal's second reject is stamped again.
--
-- NOT HERE
--   The pass does not write parts yet, and the candidate rule does not read
--   them (PR 2). No surface lists or decides them (PR 3), and the proposals
--   pending today are untouched (PR 4). The quote check stays the pass's
--   (SMD-4442): this file checks a part's shape, not that its words are in
--   the two texts, nor that the pair is in capture order. Nor is there a
--   rule on who may decide: 117 refuses a call that names no maker and a
--   proposer's accept of its own proposal, 029's review has neither, and a
--   part's follows 029's until the maintainer says otherwise. And no index
--   serves a listing: PR 3's brings the one its listing is measured to need.
--   Nothing an operator reads counts a part yet. `db/rebuild.ts --status`
--   prints the stale proposals and no stale part, and preflight, brain_info
--   and the dashboard say nothing of parts. Both censuses of stale lineage
--   rows leave a part's row out, as they do a proposal's, so a pending part
--   at a moved text shows nowhere until a rebuild or the next judgement.
--   The sweep's census (db/rebuild.ts --orphans, the sleep scheduler,
--   preflight) names four kinds and finds neither a proposal's orphaned
--   lineage row nor a part's: a rebuild of one of its thoughts deletes it.
--   And preflight's lineage coverage reads no settled_parts. These are for
--   the pass and the review surfaces to bring (PR 2, PR 3): no part exists
--   before the pass writes one.
--
-- NOT CHANGED
--   supersession_proposals, thoughts.supersedes and every reader of them.
--
-- SAFETY
--   One new table with its two indexes and three triggers, four new
--   functions (the write, the decision and two trigger functions), three
--   bodies carried, each with the part added (ob1_record_derivation,
--   derivation_descendants, rebuild_derived), two comments issued again (the
--   lineage table's and 114's trigger function's), and the worker and server
--   groups' grants on supersession_proposals carried to the new table, so a
--   role that records or decides proposals does the same for parts. The
--   pass's role may also delete a part, which is how an undecided one is
--   replaced, and which the write asks for on every call that gets past
--   its refusals, whether a row goes or not. Nothing runs at apply time
--   but the DDL and the grant, and no row moves: the lineage table's kind
--   CHECK is dropped, added and validated over every lineage row, at the
--   first apply and at each re-apply (the whole file applied in 0.09 s on
--   400,000 lineage rows).
--   The file takes `thoughts` (its two foreign keys), then `derivations`
--   (the kind's CHECK), in its one transaction, which is the order a
--   capture and an edit take them. A forget, and a write of a generated
--   page section, take them the other way: one in flight as the file
--   applies can be the deadlock's victim and fail with 40P01, to be run
--   again. With two forgets looping, 14 and 12 of 20 applies cost one; with
--   a page write looping, 12 of 12; the migrator applied every time (review
--   pass 4). 064 and 084 took the two tables in one file the same way. The
--   kind's CHECK first deadlocked captures and edits instead; in a file of
--   its own it cost nothing (0 of 20, 0 of 12): not taken, put to the
--   maintainer.
--   record_settled_part holds the supersession advisory lock until its
--   transaction ends. A caller makes the write as a statement of its own,
--   as db/consolidate.ts writes a proposal today: no thought's or claim's
--   row held when it is called, and nothing awaited before it commits. A
--   caller that held such a row first deadlocked the call that holds the
--   lock and waits for that row (a rebuild, a delete, a forget, an edit
--   that names a pointer, a proposal's accept) 80 times in 80, the other
--   call the victim; and one that awaited a rebuild or a citation on a
--   second connection before it committed never returned, 10 times in 10
--   (review pass 3). The lock also makes the write single file with every
--   call that takes it.
--   rebuild_derived now reads settled_parts when a thought's walk holds a
--   part's lineage row, and locks and updates a pending part whose text has
--   moved: a role that runs it needs SELECT there for the orphan rule, and
--   UPDATE to set a part stale. The worker and server groups hold both, and
--   this file gives both to every role holding SELECT and UPDATE on the
--   proposals. A role that ran it before and holds neither is refused
--   (42501) on such a thought, and on no other: the part's orphan test is a
--   statement of its own, so a plan that walks no part's row reads no
--   settled_parts (as an arm of the other kinds' CASE it was refused on
--   thoughts with no part, under a generic plan: review pass 4). Measured
--   for one holding capture, extraction, structure and, by hand, SELECT on
--   ob1_config, which ran the orphan sweep until the thought held a part.
--   (As `--grant` gives those three groups alone, the function is refused
--   at ob1_config before its walk, a part or none.)
--   A `part` lineage row is one more that an earlier file's kind list does
--   not admit. `migrate.ts --reapply` already fails at 064 on a brain holding
--   a `relation` or `subject` row (SMD-4474), and now fails there on one
--   holding a part and neither of those; this file re-applied alone
--   validates over its own kind.
--   MINOR under MAINTAINING.md's version rules. test-schema [133],
--   test-upgrade [20ck].
--
-- Prerequisites
--   016 (content_fingerprint_of, requeue_thought_work), 029
--   (supersession_proposals), 061 (derivations), 063 and 067
--   (derivation_descendants, rebuild_derived), 111 (ob1_record_derivation)
--   and 114 (ob1_stamp_proposal_reviewer). Applied by `bun db/migrate.ts`.
--   Re-applied: the table, its indexes and its constraints stand, the
--   triggers are dropped and made again, the lineage table's kind CHECK is
--   dropped, added and validated again, and the functions are replaced as
--   they were.
-- =============================================================================

-- Refused up front on a schema the ledger records but does not hold (052's
-- shape): a missing function by its own name, either table in one message
-- that names both.
DO $qc$
DECLARE
  v_need text[][] := ARRAY[
    ARRAY['content_fingerprint_of(text)', '016 (content_fingerprint_of)'],
    ARRAY['requeue_thought_work(text, uuid)', '016 (requeue_thought_work)'],
    ARRAY['derivation_descendants(uuid, integer, integer)', '063 (derivation_descendants)'],
    ARRAY['rebuild_derived(uuid, text, boolean, text[], boolean, boolean)', '063 (rebuild_derived)'],
    ARRAY['ob1_record_derivation(text, uuid, uuid[], text[], text, jsonb, uuid)', '061 (ob1_record_derivation)'],
    ARRAY['ob1_stamp_proposal_reviewer()', '114 (ob1_stamp_proposal_reviewer)']];
  i int;
BEGIN
  FOR i IN 1 .. array_length(v_need, 1) LOOP
    IF to_regprocedure(v_need[i][1]) IS NULL THEN
      RAISE EXCEPTION USING
        MESSAGE = format('migration 148 needs %s; this schema lacks it', v_need[i][2]),
        -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
        HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
        ERRCODE = 'invalid_schema_definition';
    END IF;
  END LOOP;
  IF to_regclass('supersession_proposals') IS NULL OR to_regclass('derivations') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 148 needs 029 and 061 (supersession_proposals, derivations); this schema lacks one',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. settled_parts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settled_parts (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The pair, by capture order, as 029 names a proposal's.
  older_id             uuid        NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  newer_id             uuid        NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  -- Which of the two holds the statement. The other holds the words that
  -- show it. Usually the older: a ticket row keeps its first capture date
  -- and may hold later text.
  holder               text        NOT NULL,
  holder_id            uuid        GENERATED ALWAYS AS (CASE holder WHEN 'older' THEN older_id ELSE newer_id END) STORED,
  -- The statement, quoted from the holder, and the words quoted from the
  -- other thought that show it is no longer true or no longer open.
  statement            text        NOT NULL,
  shown_by             text        NOT NULL,
  -- One of SMD-3116's eight settling labels, kept as data, and the group
  -- anything that acts on a part reads.
  word                 text        NOT NULL,
  -- Both groups are named: a word added to the eight without a group of its
  -- own has none, and its row is refused (settled_parts_word_group), where
  -- an ELSE would file it under the group that closes an open item.
  word_group           text        GENERATED ALWAYS AS (
    CASE WHEN word IN ('corrects', 'reverses', 'revises', 'withdraws') THEN 'no_longer_holds'
         WHEN word IN ('implements', 'resolves', 'updates', 'prioritizes') THEN 'done_or_settled' END) STORED,
  reason               text        NOT NULL,
  -- 016's fingerprint of each text AS JUDGED: the quotes are from those texts.
  older_fingerprint    text        NOT NULL,
  newer_fingerprint    text        NOT NULL,
  judge_key            text        NOT NULL,
  judged_at            timestamptz NOT NULL DEFAULT now(),
  canonical_agent_id   uuid,
  status               text        NOT NULL DEFAULT 'pending',
  reviewed_at          timestamptz,
  review_note          text,
  reviewed_by          text,
  reviewed_by_agent_id uuid,
  reviewed_by_kind     text,
  CONSTRAINT settled_parts_pair              CHECK (older_id <> newer_id),
  CONSTRAINT settled_parts_holder            CHECK (holder IN ('older', 'newer')),
  -- Words, not white space alone: '\S' reads a line break or a tab as blank,
  -- where btrim reads only a space, and it is what 016's fingerprint, the
  -- statement's identity below, folds to nothing.
  CONSTRAINT settled_parts_statement         CHECK (statement ~ '\S' AND length(statement) <= 2000),
  CONSTRAINT settled_parts_shown_by          CHECK (shown_by ~ '\S' AND length(shown_by) <= 2000),
  CONSTRAINT settled_parts_word              CHECK (word IN ('corrects', 'reverses', 'revises', 'withdraws', 'implements', 'resolves', 'updates', 'prioritizes')),
  -- Read after settled_parts_word (a table's CHECKs run in name order), so a
  -- word outside the eight is refused by that name, and this one speaks only
  -- for a word the list above has gained and the groups have not.
  CONSTRAINT settled_parts_word_group        CHECK (word_group IS NOT NULL),
  CONSTRAINT settled_parts_reason            CHECK (reason ~ '\S' AND length(reason) <= 1000),
  CONSTRAINT settled_parts_fingerprints      CHECK (older_fingerprint <> '' AND newer_fingerprint <> ''),
  CONSTRAINT settled_parts_judge_key         CHECK (judge_key <> ''),
  CONSTRAINT settled_parts_status_check      CHECK (status IN ('pending', 'accepted', 'rejected', 'stale')),
  -- A stale row is unreviewed, as a pending one is (063's pairing rule).
  CONSTRAINT settled_parts_unreviewed_check  CHECK ((status IN ('pending', 'stale')) = (reviewed_at IS NULL)),
  -- 114's two rules for the reviewer columns.
  CONSTRAINT settled_parts_reviewed_by_kind  CHECK (reviewed_by_kind IS NULL OR (reviewed_by_agent_id IS NOT NULL AND reviewed_by_kind IN ('operator', 'agent', 'ingested'))),
  CONSTRAINT settled_parts_reviewer_decided  CHECK (reviewed_at IS NOT NULL OR (reviewed_by IS NULL AND reviewed_by_agent_id IS NULL AND reviewed_by_kind IS NULL))
);

COMMENT ON TABLE settled_parts IS
  'One row per settled part: a statement in one thought of a pair that the other thought shows is no longer true or no longer open, with the quote from each, a reason and the word (docs/subject-anchored-claims.md, rows 8 to 10). Proposed by the consolidation pass through record_settled_part and decided by a reviewer through review_settled_part. An accepted part sets no supersedes pointer and demotes no thought: both thoughts stand. A pair may hold several parts, and one statement of one thought once; it may hold a whole-thought proposal (029) beside them. A row is one judgement and no UPDATE changes it (settled_parts_keep_judgement): when the pass judges a statement again and its row is undecided and no longer a judgement of the texts as they stand, the judgement is another row with another id, and otherwise it is not recorded. Deleting either thought takes the row, and its lineage rows with it. The planner keeps no statistics on its words. Migration 148 / SMD-4446.';
COMMENT ON COLUMN settled_parts.holder IS
  'Which thought of the pair holds the statement: older or newer, by capture order. The other thought holds shown_by. holder_id is that thought''s id.';
COMMENT ON COLUMN settled_parts.statement IS
  'The statement, as the judge quoted it from the holder''s text at the fingerprint recorded. With the pair and the holder it is the part''s identity, read as 016''s content_fingerprint_of reads a text: case, runs of white space and white space at either end folded (settled_parts_one_statement).';
COMMENT ON COLUMN settled_parts.shown_by IS
  'The words of the other thought that show the statement is no longer true or no longer open, as the judge quoted them from its text at the fingerprint recorded.';
COMMENT ON COLUMN settled_parts.word IS
  'One of SMD-3116''s eight settling labels, kept as data. Anything that acts on a part reads word_group, not the word.';
COMMENT ON COLUMN settled_parts.word_group IS
  'The word''s group: no_longer_holds (corrects, reverses, revises, withdraws) or done_or_settled (implements, resolves, updates, prioritizes). Each of the eight has one, and a row whose word has none is refused (settled_parts_word_group).';
COMMENT ON COLUMN settled_parts.judged_at IS
  'When the transaction that recorded the row''s judgement began (now()). A row is one judgement: a later judgement of its statement is another row with its own time, or is not recorded (record_settled_part). It is not the order rows commit in: a listing that pages by it can pass over a row whose transaction began before the page was read and committed after.';
COMMENT ON COLUMN settled_parts.status IS
  'pending: the part awaits a reviewer. accepted or rejected: a decision (review_settled_part). stale: rebuild_derived found one of the pair''s texts moved since the judge saw them, or was called with p_force; the row stays stale if the text moves back, and the next judgement of its statement replaces it with a new row. A pending row whose texts have moved with no rebuild since is replaced the same way. Migration 148.';
COMMENT ON COLUMN settled_parts.reviewed_by IS
  'Who decided the row, from the decision''s actor envelope, with reviewed_by_agent_id and reviewed_by_kind: written only by settled_parts_stamp_reviewer, which runs 114''s ob1_stamp_proposal_reviewer. The last decision''s alone: a reversal replaces it. NULL while unreviewed, and on a decided row whose decision carried no actor envelope.';

-- One statement of one thought, once a pair, as 016's fingerprint reads a
-- text: the same words in other capitals or spacing are the same statement.
-- A hash, since a statement may be 2,000 characters, past what a btree key
-- holds.
-- The index is built on content_fingerprint_of, and holds what that
-- function read when each row was written. A later file that changes what
-- it folds leaves the index at the old fold and says nothing: the write's
-- ON CONFLICT probes it, so a statement a reviewer rejected was recorded
-- again beside its rejection, and a REINDEX then failed on the pair (10 of
-- 10 each, review pass 4). Such a file rebuilds this index in its own
-- transaction, as it must 023's on the same function, and says what
-- becomes of two rows the new fold reads as one. A fold for parts alone is
-- a function of its own.
CREATE UNIQUE INDEX IF NOT EXISTS settled_parts_one_statement
  ON settled_parts (older_id, newer_id, holder, content_fingerprint_of(statement));
-- The newer side, for the cascade and for the pass, which asks from it.
CREATE INDEX IF NOT EXISTS settled_parts_newer_idx
  ON settled_parts (newer_id);

-- No planner statistics on a thought's words. ANALYZE copies a column's
-- commonest values and its histogram bounds into pg_statistic, which no
-- delete of the row clears: a forgotten thought's quote would stand there
-- until the next ANALYZE. The four columns hold a thought's words, or a
-- reviewer's about them; the index's fourth column is the statement's
-- fingerprint. No plan needs their statistics: the identity index is
-- unique, and the write finds its row through all four of its columns;
-- anything else finds a part by its pair, its holder or its status.
ALTER TABLE settled_parts
  ALTER COLUMN statement   SET STATISTICS 0,
  ALTER COLUMN shown_by    SET STATISTICS 0,
  ALTER COLUMN reason      SET STATISTICS 0,
  ALTER COLUMN review_note SET STATISTICS 0;
ALTER INDEX settled_parts_one_statement ALTER COLUMN 4 SET STATISTICS 0;

-- The reviewer columns: 114's trigger function, which reads NEW.reviewed_at
-- and writes the three reviewer columns and nothing else, on this table too.
DROP TRIGGER IF EXISTS settled_parts_stamp_reviewer ON settled_parts;
CREATE TRIGGER settled_parts_stamp_reviewer
  BEFORE INSERT OR UPDATE OF status, reviewed_at, review_note, reviewed_by, reviewed_by_agent_id, reviewed_by_kind
  ON settled_parts
  FOR EACH ROW EXECUTE FUNCTION ob1_stamp_proposal_reviewer();

CREATE OR REPLACE FUNCTION ob1_keep_part_judgement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- ob1:a-part-keeps-its-judgement — a CONTRACT SENTINEL, not prose (the 014
  -- convention), read by db/test-schema.ts. A row is one judgement: what a
  -- reviewer read is what the row holds, for as long as the row stands, and
  -- another judgement is another row (record_settled_part). And a part's
  -- quotes are its thoughts' words, which the cascade from those two
  -- thoughts takes when one is deleted or forgotten: a row pointed at
  -- another thought would keep them. The message carries no value: the row
  -- holds a thought's words.
  IF (NEW.id, NEW.older_id, NEW.newer_id, NEW.holder, NEW.statement, NEW.shown_by, NEW.word, NEW.reason,
      NEW.older_fingerprint, NEW.newer_fingerprint, NEW.judge_key, NEW.judged_at, NEW.canonical_agent_id)
     IS DISTINCT FROM
     (OLD.id, OLD.older_id, OLD.newer_id, OLD.holder, OLD.statement, OLD.shown_by, OLD.word, OLD.reason,
      OLD.older_fingerprint, OLD.newer_fingerprint, OLD.judge_key, OLD.judged_at, OLD.canonical_agent_id) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'settled_parts: a part''s pair, holder, quotes, word, reason, fingerprints and judge never change; another judgement is another row',
      ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION ob1_keep_part_judgement() IS
  'BEFORE UPDATE OF the judgement''s columns on settled_parts (settled_parts_keep_judgement, 148). Refuses, with check_violation and a message that carries no value, an UPDATE that changes a part''s id, pair, holder, statement, showing words, word, reason, either fingerprint, judge key, judging agent or time judged, on a row in any status: a row is one judgement, and record_settled_part makes another row for another. The status is not held: a role holding UPDATE can move it by hand, as it can a proposal''s. A part''s quotes leave by the cascade from its two thoughts, so a row never points at others. Migration 148 / SMD-4446.';

DROP TRIGGER IF EXISTS settled_parts_keep_judgement ON settled_parts;
CREATE TRIGGER settled_parts_keep_judgement
  BEFORE UPDATE OF id, older_id, newer_id, holder, statement, shown_by, word, reason, older_fingerprint, newer_fingerprint, judge_key, judged_at, canonical_agent_id
  ON settled_parts
  FOR EACH ROW EXECUTE FUNCTION ob1_keep_part_judgement();

CREATE OR REPLACE FUNCTION ob1_drop_part_derivation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM derivations WHERE artifact_kind = 'part' AND artifact_id = OLD.id;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION ob1_drop_part_derivation() IS
  'AFTER DELETE on settled_parts (settled_parts_drop_derivation, 148): drops the part''s `derivations` rows, as 061 drops a proposal''s. A part goes by the cascade from either of its thoughts, so a deleted or forgotten thought leaves neither its parts'' quotes nor their recipes. Migration 148 / SMD-4446.';

DROP TRIGGER IF EXISTS settled_parts_drop_derivation ON settled_parts;
CREATE TRIGGER settled_parts_drop_derivation
  AFTER DELETE ON settled_parts
  FOR EACH ROW EXECUTE FUNCTION ob1_drop_part_derivation();

-- ---------------------------------------------------------------------------
-- 2. derivations: `part` joins the artifact kinds
--
-- 111's drop-by-shape, add NOT VALID, then VALIDATE, and its
-- ob1_record_derivation, verbatim, each with one more value in the kind list
-- and its message. Then the table's comment, 111's with the kind, its id and
-- its drop trigger added, and 114's comment on the reviewer's trigger
-- function, which now names the second table it stamps.
-- ---------------------------------------------------------------------------
DO $ck$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'derivations'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE 'CHECK ((artifact_kind = ANY (ARRAY[%'
  LOOP
    EXECUTE format('ALTER TABLE derivations DROP CONSTRAINT %I', v_name);
  END LOOP;
END
$ck$;
ALTER TABLE derivations ADD CONSTRAINT derivations_artifact_kind_check
  CHECK (artifact_kind IN ('chunks', 'entities', 'proposal', 'vector', 'metadata', 'section', 'relation', 'subject', 'part')) NOT VALID;
ALTER TABLE derivations VALIDATE CONSTRAINT derivations_artifact_kind_check;

CREATE OR REPLACE FUNCTION ob1_record_derivation(
  p_kind         text,
  p_artifact     uuid,
  p_inputs       uuid[],
  p_fingerprints text[],
  p_produced_by  text,
  p_recipe       jsonb,
  p_agent        uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
BEGIN
  -- The write path is the choke point, or an untrusted-input hole (025):
  -- every refusal is a RAISE, since a producer that cannot record its lineage
  -- must not commit its artifact either — the two are one transaction.
  IF p_kind IS NULL OR p_kind NOT IN ('chunks', 'entities', 'proposal', 'vector', 'metadata', 'section', 'relation', 'subject', 'part') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('ob1_record_derivation: artifact_kind must be chunks, entities, proposal, vector, metadata, section, relation, subject or part, got %L', p_kind),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_artifact IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'ob1_record_derivation: artifact_id is required', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_inputs IS NULL OR cardinality(p_inputs) < 1 OR array_position(p_inputs, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'ob1_record_derivation: input_ids must name at least one input and no NULL', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_fingerprints IS NULL OR cardinality(p_fingerprints) <> cardinality(p_inputs) OR array_position(p_fingerprints, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format('ob1_record_derivation: input_fingerprints must be one non-NULL fingerprint per input (%s inputs, %s fingerprints)',
                       cardinality(p_inputs), COALESCE(cardinality(p_fingerprints), 0)),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_produced_by IS NULL OR p_produced_by = '' THEN
    RAISE EXCEPTION USING MESSAGE = 'ob1_record_derivation: produced_by must name the pass', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_recipe IS NULL OR jsonb_typeof(p_recipe) <> 'object' OR COALESCE(jsonb_typeof(p_recipe->'deterministic'), '') <> 'boolean' THEN
    RAISE EXCEPTION USING
      MESSAGE = 'ob1_record_derivation: recipe must be a JSON object carrying a boolean "deterministic"',
      ERRCODE = 'invalid_parameter_value';
  END IF;
  -- ob1:rerun-clears-the-mark — a CONTRACT SENTINEL, not prose (the 014
  -- convention); db/test-schema.ts reads it. 063: the producer's write is the
  -- answer to a rebuild's request, so the upsert clears stale_since and
  -- stale_reason (SMD-1732).
  INSERT INTO derivations (artifact_kind, artifact_id, input_ids, input_fingerprints, produced_by, recipe, canonical_agent_id)
  VALUES (p_kind, p_artifact, p_inputs, p_fingerprints, p_produced_by, p_recipe, p_agent)
  ON CONFLICT (artifact_kind, artifact_id, produced_by) DO UPDATE
    SET input_ids          = EXCLUDED.input_ids,
        input_fingerprints = EXCLUDED.input_fingerprints,
        recipe             = EXCLUDED.recipe,
        produced_at        = now(),
        canonical_agent_id = EXCLUDED.canonical_agent_id,
        stale_since        = NULL,
        stale_reason       = NULL
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION ob1_record_derivation(text, uuid, uuid[], text[], text, jsonb, uuid) IS
  'Records one derived artifact''s lineage in `derivations`, upserting on (artifact_kind, artifact_id, produced_by) and moving produced_at: the inputs and their fingerprints (parallel, no NULL), the pass, the recipe (a JSON object with a boolean `deterministic`), the agent. Refuses a bad shape with a RAISE — a producer that cannot record its lineage must not commit its artifact either. Nine kinds since 148: chunks, entities, proposal, vector, metadata (061), section (064, a page section a machine wrote), relation (084, a judged relation between two thoughts), subject (111, a thought''s own subject) and part (148, a settled part of a pair of thoughts); the upsert clears 063''s mark (ob1:rerun-clears-the-mark). Migrations 061, 063, 064, 084, 111, 148 / SMD-1731, SMD-1732, SMD-1812, SMD-1873, SMD-3306, SMD-4446.';

COMMENT ON TABLE derivations IS
  'Lineage for every derived artifact (SMD-1731, Phase 1b of SMD-1729): one row per artifact per producing pass, written in the transaction that writes the artifact. artifact_kind names the tier — chunks (a thought''s window set), entities (a thought''s extraction under one extraction_key), proposal (one supersession proposal), vector (a thought''s embedding), metadata (a thought''s capture-time tags), since 064 section (a page section a machine wrote — SMD-1812), since 084 relation (a judged relation between two thoughts, a `relation` facet — SMD-1873), since 111 subject (a thought''s own subject, a `subject` facet — SMD-3306), and since 148 part (a settled part of a pair of thoughts — SMD-4446); artifact_id is the thought''s id for the four keyed by a thought, the proposal''s id for a proposal, the section''s id for a section, the facet''s id for a relation or a subject, the part''s id for a part. input_ids and input_fingerprints are parallel arrays naming what the artifact was computed from and the text it was computed from — a row whose fingerprints no longer match its inputs'' is stale, which is a read (preflight counts them), not a trigger. produced_by is the pass; recipe is a JSON object carrying a boolean `deterministic` (what rebuild_derived reads, migration 063: a re-derivation the database owns against a re-run a worker owns) and the producer''s own record — model, prompt_version, prompt_hash, window parameters; `legacy: true` on a row 061 backfilled, `declared: false` where a caller sent no recipe. stale_since and stale_reason (063) carry a rebuild''s request for a re-run until the producer writes the row again. No foreign key: thoughts_drop_derivations, supersession_proposals_drop_derivation, page_sections_drop_derivations, thought_facets_drop_relation_derivation, thought_facets_drop_subject_derivation and settled_parts_drop_derivation drop the rows a deleted thought, proposal, section, relation, subject or part keyed; rebuild_derived deletes a row whose artifact is gone while its thought stands. Migrations 061, 063, 064, 084, 111, 148 / SMD-1731, SMD-1732, SMD-1812, SMD-1873, SMD-3306, SMD-4446.';

COMMENT ON FUNCTION ob1_stamp_proposal_reviewer() IS
  'BEFORE INSERT OR UPDATE OF status, reviewed_at, review_note, reviewed_by, reviewed_by_agent_id, reviewed_by_kind on supersession_proposals (supersession_proposals_stamp_reviewer, 114): the one writer of the reviewer columns. reviewed_at NULL clears them; otherwise they are the envelope present (ob1.actor: its name, its agent in the server''s id form, and for an agent the registry''s kind), never the statement''s values. review_supersession_proposal sets the envelope from p_actor, so its accept and reject, and 067''s settle through it, are stamped with the key that decided; 067''s reopen clears them. Migration 114 / SMD-2608. Since 148 (SMD-4446) the same function stamps settled_parts (settled_parts_stamp_reviewer), whose three reviewer columns are these: review_settled_part sets the envelope from p_actor. On a part a later decision replaces them, with nothing when it carries no envelope, as a write of the note by hand does, and a status taken back by hand clears them; a part a later judgement replaces is another row, unreviewed.';

-- ---------------------------------------------------------------------------
-- 3. The walk: 063's body verbatim, `part` in its kind order beside
--    `proposal`. One place: the ORDER BY of the lineage rows a level yields.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION derivation_descendants(
  p_input     uuid,
  p_max_depth int DEFAULT 3,
  p_node_cap  int DEFAULT 2000
)
RETURNS TABLE (
  derivation_id      uuid,
  artifact_kind      text,
  artifact_id        uuid,
  produced_by        text,
  input_ids          uuid[],
  input_fingerprints text[],
  recipe             jsonb,
  stale_since        timestamptz,
  depth              int,
  prose              boolean
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_max_depth int    := GREATEST(1, LEAST(COALESCE(p_max_depth, 3), 10));
  v_node_cap  int    := GREATEST(1, LEAST(COALESCE(p_node_cap, 2000), 2000));
  v_seen      uuid[];   -- every node discovered so far; WALK-GLOBAL (026)
  v_frontier  uuid[];   -- the nodes whose descendants this level yields
  v_next      uuid[];   -- the artifacts not yet seen, the next frontier
  v_prose     uuid[];   -- the derived_from children found this level
  v_depth     int    := 0;
  v_emitted   int    := 0;
  v_rows      int;
  -- ob1:derivation-walk-bounded — a CONTRACT SENTINEL (the 014 convention),
  -- read by db/test-schema.ts: this walk expands each node once through a
  -- walk-global seen set and stops at its clamps — 026's bound, which a
  -- per-path recursive CTE cannot give. A redefinition keeps the property and
  -- this string, or the test fails.
BEGIN
  IF p_input IS NULL THEN RETURN; END IF;
  v_seen     := ARRAY[p_input];
  v_frontier := ARRAY[p_input];

  WHILE v_depth < v_max_depth
        AND v_frontier IS NOT NULL AND array_length(v_frontier, 1) > 0
        AND v_emitted < v_node_cap LOOP
    v_depth := v_depth + 1;

    -- The lineage rows this frontier fed: one GIN probe (`&&`, array_ops).
    -- Kind order is the primitive's order of action, then the artifact and
    -- the pass — deterministic, so a cap truncates the same way twice.
    -- 148: a part beside the proposal. A kind the order does not name
    -- sorts after every kind it does, by artifact, and shares what the
    -- cap leaves: on a thought that fed 2,100 judged relations, 7 of 50
    -- parts went unwalked, and no later call reached them (SMD-4446,
    -- review pass 1, measured).
    RETURN QUERY
      SELECT d.id, d.artifact_kind, d.artifact_id, d.produced_by, d.input_ids, d.input_fingerprints, d.recipe, d.stale_since, v_depth, false
        FROM derivations d
       WHERE d.input_ids && v_frontier
       ORDER BY array_position(ARRAY['vector', 'chunks', 'entities', 'proposal', 'part', 'metadata'], d.artifact_kind), d.artifact_id, d.produced_by
       LIMIT (v_node_cap - v_emitted);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_emitted := v_emitted + v_rows;
    IF v_emitted >= v_node_cap THEN EXIT; END IF;

    -- The frontier's derived_from children (025's pointer, its GIN): prose,
    -- listed once and not expanded — their text did not move.
    SELECT array_agg(DISTINCT t.id) INTO v_prose
      FROM unnest(v_frontier) AS w(node)
      JOIN thoughts t ON t.derived_from @> jsonb_build_array(w.node::text)
     WHERE NOT (t.id = ANY(v_seen));
    IF v_prose IS NOT NULL THEN
      RETURN QUERY
        SELECT NULL::uuid, 'thought'::text, c.id, 'derived_from'::text,
               (SELECT array_agg(w.node) FROM unnest(v_frontier) AS w(node) WHERE c.derived_from @> jsonb_build_array(w.node::text)),
               NULL::text[], NULL::jsonb, NULL::timestamptz, v_depth, true
          FROM thoughts c
         WHERE c.id = ANY(v_prose)
         ORDER BY c.id
         LIMIT (v_node_cap - v_emitted);
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_emitted := v_emitted + v_rows;
      v_seen := v_seen || v_prose;
    END IF;

    -- The next frontier: the artifacts this level yielded that are not yet
    -- seen. A thought's own rows name the thought — already seen, so the
    -- self-loop ends here; a proposal's id enters and feeds nothing (nothing
    -- records a proposal as an input today), which is one empty probe.
    SELECT array_agg(DISTINCT d.artifact_id) INTO v_next
      FROM derivations d
     WHERE d.input_ids && v_frontier
       AND NOT (d.artifact_id = ANY(v_seen));
    v_seen     := v_seen || COALESCE(v_next, ARRAY[]::uuid[]);
    v_frontier := COALESCE(v_next, ARRAY[]::uuid[]);
  END LOOP;
END;
$$;

COMMENT ON FUNCTION derivation_descendants(uuid, int, int) IS
  'Walks `derivations` FORWARD from an input: every lineage row the input (and, level by level, the artifacts those rows produced) fed, with the row''s inputs, fingerprints, recipe and mark, at its depth; and the input''s derived_from children (025) as prose rows (artifact_kind thought, produced_by derived_from, prose true), listed once and not expanded. 026''s shape: an iterative level-by-level walk with a walk-global seen set, each node expanded once (a thought''s own rows name the thought — the self-loop the set guards); depth clamped 1..10 (default 3), rows capped 1..2000 (default 2000), the same order every time (kind, artifact, pass; since 148 a settled part beside the proposal, and a kind the order does not name after all it does). On the graph the producers write today the walk is one level deep; the clamps are for a producer that one day records an artifact fed by another artifact. Read by rebuild_derived, and by SMD-1734''s trust propagation. Migrations 063, 148 / SMD-1732, SMD-4446.';

-- ---------------------------------------------------------------------------
-- 4. record_settled_part — the pass's one write
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_settled_part(
  p_older_id          uuid,
  p_newer_id          uuid,
  p_holder            text,
  p_statement         text,
  p_shown_by          text,
  p_word              text,
  p_reason            text,
  p_judge_key         text,
  p_older_fingerprint text,
  p_newer_fingerprint text,
  -- The judge's recipe, recorded with the part in `derivations`, as 061
  -- records a proposal's.
  p_recipe            jsonb,
  p_agent_id          uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_id         uuid;
  v_replaced   uuid;
  v_held       record;
  v_old_edited boolean;
  v_new_edited boolean;
BEGIN
  -- Every refusal of a part's shape is a RAISE, as ob1_record_derivation's are: a pass that
  -- cannot record a part must not go on as if it had. Each shape the table's
  -- CHECKs hold is refused here first, and said without the row: a CHECK's
  -- own error carries the failing row in its DETAIL, and the row holds a
  -- thought's words. No message echoes an argument either, the holder and
  -- the word included: a pass that crossed its fields would put a quote
  -- there, and its caller keeps a refusal's message (thought_work_claims'
  -- last_error), which goes with the claim's own thought and so outlives
  -- the pair's other one. A length is said instead. (A text bound to the
  -- uuid or the jsonb parameter is refused by Postgres's own cast before
  -- this function runs, in words that carry it: a caller keeps only the
  -- messages that begin with this function's name.)
  IF p_older_id IS NULL OR p_newer_id IS NULL OR p_older_id = p_newer_id THEN
    RAISE EXCEPTION USING
      MESSAGE = 'record_settled_part: a part is of two different thoughts',
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_holder IS NULL OR p_holder NOT IN ('older', 'newer') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('record_settled_part: p_holder must be older or newer, got %s', COALESCE(length(p_holder) || ' characters', 'none')),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_word IS NULL OR p_word NOT IN ('corrects', 'reverses', 'revises', 'withdraws', 'implements', 'resolves', 'updates', 'prioritizes') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('record_settled_part: p_word must be corrects, reverses, revises, withdraws, implements, resolves, updates or prioritizes, got %s',
                       COALESCE(length(p_word) || ' characters', 'none')),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Words, and not white space alone ('\S', the table's rule).
  IF p_statement IS NULL OR p_statement !~ '\S' OR length(p_statement) > 2000
     OR p_shown_by IS NULL OR p_shown_by !~ '\S' OR length(p_shown_by) > 2000 THEN
    RAISE EXCEPTION USING
      MESSAGE = format('record_settled_part: the statement and the words that show it must each hold 1 to 2000 characters and not white space alone, got %s and %s',
                       COALESCE(length(p_statement)::text, 'none'), COALESCE(length(p_shown_by)::text, 'none')),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_reason IS NULL OR p_reason !~ '\S' OR length(p_reason) > 1000 THEN
    RAISE EXCEPTION USING
      MESSAGE = format('record_settled_part: p_reason must hold 1 to 1000 characters and not white space alone, got %s', COALESCE(length(p_reason)::text, 'none')),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_judge_key IS NULL OR p_judge_key = '' THEN
    RAISE EXCEPTION USING
      MESSAGE = 'record_settled_part: p_judge_key must name the pass, e.g. consolidate:<model>@p1',
      ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The quotes are from the texts the judge was sent: without their
  -- fingerprints nothing can say later whether a text has moved.
  IF p_older_fingerprint IS NULL OR p_older_fingerprint = '' OR p_newer_fingerprint IS NULL OR p_newer_fingerprint = '' THEN
    RAISE EXCEPTION USING
      MESSAGE = 'record_settled_part: both fingerprints of the texts the judge was sent are required',
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_recipe IS NULL OR jsonb_typeof(p_recipe) <> 'object' OR COALESCE(jsonb_typeof(p_recipe->'deterministic'), '') <> 'boolean' THEN
    RAISE EXCEPTION USING
      MESSAGE = 'record_settled_part: p_recipe must be a JSON object carrying a boolean "deterministic"',
      ERRCODE = 'invalid_parameter_value';
  END IF;
  -- READ COMMITTED alone, checked before anything is read, as the decision
  -- is (068's rule): above it the two texts would be read as the transaction
  -- first saw them, before the lock below was had.
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('record_settled_part must run under READ COMMITTED; this transaction is %s', upper(current_setting('transaction_isolation'))),
      HINT = 'Under REPEATABLE READ or SERIALIZABLE its read of the two texts would predate its lock. BEGIN ISOLATION LEVEL READ COMMITTED; then call it.',
      ERRCODE = 'feature_not_supported';
  END IF;
  -- The supersession advisory lock, which review_settled_part,
  -- rebuild_derived, delete_thought and forget_thought each take first
  -- (033, 036; 042's record_citation, which names two thoughts too). With
  -- it no rebuild runs between this write's read of the two texts and its
  -- commit: a rebuild that follows an edit either ends before this write
  -- has the lock, and the read below sees the edit, or has the lock after
  -- this write's commit, and finds the part. That is a rebuild at READ
  -- COMMITTED: a forget refuses above it, and db/rebuild.ts and the sleep
  -- scheduler's sweep run at their session's level, which is that unless
  -- the database or the role defaults higher (preflight's `transaction
  -- isolation` row). rebuild_derived (067's body) has no guard of its own:
  -- one whose transaction is REPEATABLE READ or SERIALIZABLE, having waited
  -- here, reads the store as its transaction first saw it and misses the
  -- part, 20 times in 20 (review pass 3).
  -- No thought's row is locked here; the insert's foreign keys take a key
  -- share on each, which no edit waits for. A plain edit does not take this
  -- lock, so a row lock here could not make an edit and its rebuild one
  -- step. It made the write wait, holding this lock, behind whatever held
  -- the row: with one thought's row held 3 s, a decision on another pair, a
  -- delete and a rebuild of unrelated thoughts each took about 2.95 s, and
  -- 4 to 16 ms without the row lock (medians of 5: review pass 3). The lock
  -- is the caller's transaction's to its end: the function's comment says
  -- what a caller must not do.
  PERFORM pg_advisory_xact_lock(hashtext('ob1:supersession-review'));
  -- ob1:a-part-is-of-the-texts-as-they-stand — a CONTRACT SENTINEL (the 014
  -- convention), read by db/test-schema.ts. A judgement of a text that had
  -- moved when this read it is not recorded: its quotes are from a text no
  -- longer there, and an accept of it would be refused. It is answered as
  -- review_settled_part answers it, EDITED_SINCE with the side, for its
  -- caller to put the thought back to be judged at its new text. The text
  -- itself is read, not the row's stored fingerprint, which a raw UPDATE of
  -- the text leaves behind. An edit that commits after this read is as one
  -- that commits after the write: the part stands pending at the old text
  -- (ob1:a-judgement-is-a-row, below, for what becomes of it).
  -- A thought that is not there when this reads it is answered too,
  -- NOT_FOUND with the side, before a fingerprint is compared: the judge is
  -- out for seconds, and a delete or a forget of either thought meanwhile is
  -- the pass's to step over, not an error for it to keep. Were the
  -- fingerprints compared first, a gone thought beside a moved one would be
  -- answered EDITED_SINCE with the gone side said unmoved. delete_thought
  -- and forget_thought take the lock above, so neither lands between this
  -- read and the insert; a DELETE by hand can, and is then the foreign
  -- key's to refuse, which names the id alone.
  SELECT p_older_fingerprint IS DISTINCT FROM content_fingerprint_of(t.content) INTO v_old_edited
    FROM thoughts t WHERE t.id = p_older_id;
  SELECT p_newer_fingerprint IS DISTINCT FROM content_fingerprint_of(t.content) INTO v_new_edited
    FROM thoughts t WHERE t.id = p_newer_id;
  IF v_old_edited IS NULL OR v_new_edited IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND', 'older_gone', v_old_edited IS NULL, 'newer_gone', v_new_edited IS NULL);
  END IF;
  IF v_old_edited OR v_new_edited THEN
    RETURN jsonb_build_object('ok', false, 'error', 'EDITED_SINCE', 'older_edited', v_old_edited, 'newer_edited', v_new_edited);
  END IF;
  -- ob1:a-judgement-is-a-row — a CONTRACT SENTINEL (the 014 convention), read
  -- by db/test-schema.ts. One statement of one thought, once a pair, as
  -- 016's fingerprint reads it. The row that holds it goes when it is
  -- undecided and no longer a judgement of the texts as they stand: a stale
  -- row, which a rebuild marked, or a pending one at other fingerprints than
  -- these two, which were just read to be the texts' (an edit is not
  -- followed by a rebuild, so such a row is stale in fact). Its lineage row
  -- goes with it (settled_parts_drop_derivation). This judgement is then a
  -- new row, with a new id: the id a reviewer read names the judgement it
  -- read, or nothing. A pending row at these fingerprints stands, and a
  -- decided one stands whatever its texts have done since: the insert meets
  -- it, takes its lock and writes nothing (DO UPDATE ... WHERE false: the
  -- arm that locks the row it meets, where DO NOTHING leaves it free). So
  -- the row cannot go before it is read just below: a DELETE by hand takes
  -- no advisory lock, and with the row free the answer was `stands` with
  -- no id (40 of 40, the gap widened: review pass 3).
  DELETE FROM settled_parts s
   WHERE s.older_id = p_older_id AND s.newer_id = p_newer_id AND s.holder = p_holder
     AND content_fingerprint_of(s.statement) = content_fingerprint_of(p_statement)
     AND (s.status = 'stale'
          OR (s.status = 'pending'
              AND (s.older_fingerprint, s.newer_fingerprint) IS DISTINCT FROM (p_older_fingerprint, p_newer_fingerprint)))
  RETURNING s.id INTO v_replaced;
  INSERT INTO settled_parts (older_id, newer_id, holder, statement, shown_by, word, reason,
                             older_fingerprint, newer_fingerprint, judge_key, canonical_agent_id)
  VALUES (p_older_id, p_newer_id, p_holder, p_statement, p_shown_by, p_word, p_reason,
          p_older_fingerprint, p_newer_fingerprint, p_judge_key, p_agent_id)
  ON CONFLICT (older_id, newer_id, holder, content_fingerprint_of(statement))
    DO UPDATE SET status = settled_parts.status WHERE false
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    -- The statement stands on the pair, pending at these texts or decided:
    -- said with the row's status, so the pass can tell a statement a
    -- reviewer rejected from one that waits. (A status moved by hand
    -- between the delete above and this insert can show here as stale, a
    -- raw UPDATE taking no advisory lock: 381 of 600 free runs, review pass
    -- 3. Written again, such a row is replaced.) The row is this holder's:
    -- the pair's other thought may hold the same words in a row of its own.
    SELECT s.id, s.status INTO v_held FROM settled_parts s
     WHERE s.older_id = p_older_id AND s.newer_id = p_newer_id AND s.holder = p_holder
       AND content_fingerprint_of(s.statement) = content_fingerprint_of(p_statement);
    RETURN jsonb_build_object('ok', true, 'action', 'stands', 'id', v_held.id, 'status', v_held.status);
  END IF;
  -- ob1:part-recorded-with-its-lineage — a CONTRACT SENTINEL, not prose (the
  -- 014 convention), read by db/test-schema.ts: the part's lineage row
  -- commits with the part, both inputs at the fingerprints the judge saw,
  -- and is the part's one lineage row: the row is new, so no earlier judge's
  -- key has left one on it.
  PERFORM ob1_record_derivation('part', v_id, ARRAY[p_older_id, p_newer_id],
                                ARRAY[p_older_fingerprint, p_newer_fingerprint], p_judge_key, p_recipe, p_agent_id);
  RETURN jsonb_build_object('ok', true, 'action', 'recorded', 'id', v_id, 'status', 'pending', 'replaced', v_replaced);
END;
$$;

COMMENT ON FUNCTION record_settled_part(uuid, uuid, text, text, text, text, text, text, text, text, jsonb, uuid) IS
  'The consolidation pass''s one write of a settled part (148, SMD-4446): the pair, which thought holds the statement, the statement and the words of the other thought that show it, the word, the reason, the judge''s key, the fingerprint of each text as judged and the judge''s recipe. Refuses with a RAISE (invalid_parameter_value) a holder that is not older or newer, a word outside the eight settling labels, a statement or showing words missing, of white space alone or past 2000 characters, a reason so or past 1000, a missing key, fingerprint or recipe, and a pair that is one thought or lacks one; and (feature_not_supported) a call above READ COMMITTED. No refusal echoes an argument: a length is said. Three answers write nothing and are values. {ok: false, error: NOT_FOUND, older_gone, newer_gone} when either thought is not there as it reads them, said before a fingerprint is compared (a thought deleted by hand after that read fails the foreign key, whose error names the id alone). {ok: false, error: EDITED_SINCE, older_edited, newer_edited} when a fingerprint given is not its text''s as it stands: a judgement of a text that has moved is not recorded, and its caller is to put the thought back for its new text. {ok: true, action: stands, id, status}, the id and status of the row that already holds that statement of that thought on the pair, the statement read as 016''s fingerprint reads a text (case, runs of white space and white space at either end folded): a pending row at these fingerprints, or a decided row whatever its texts have done since (stale only where a status was moved by hand under the write: write again); that row is locked until the write''s transaction ends, nothing is written to it, and the judgement given is not recorded. Otherwise {ok: true, action: recorded, id, status: pending, replaced}: a new row, replaced being the id of the row it took the place of, or null. A row is one judgement, and none is written over another: an undecided row holding the statement that is no longer a judgement of these texts (stale, or pending at other fingerprints) is deleted with its lineage row and the judgement recorded as a new row. An undecided part''s id ends there, and a foreign key to it that does not let the reference go would refuse the write. The part''s lineage row (kind part) commits with it. It does not check that the words are in the texts, nor the pair''s order: the quote check is the pass''s (SMD-4442). Takes the supersession advisory lock, which a decision on a proposal or a part, a rebuild, delete_thought and forget_thought each take first, so that no rebuild at READ COMMITTED runs between its read of the two texts and its commit (rebuild_derived has no guard of its own, and one above READ COMMITTED that waited on the lock misses the part); it locks no thought''s row beyond its foreign keys'' key share, so no edit waits for it; the lock is held to the end of the caller''s transaction, so call it as a statement of its own, with no thought''s or claim''s row held when it is called and nothing awaited before the commit. Writes no thought. Migration 148 / SMD-4446.';

-- ---------------------------------------------------------------------------
-- 5. review_settled_part — the reviewer's decision
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION review_settled_part(
  p_id                 uuid,
  p_decision           text,
  p_note               text        DEFAULT NULL,
  p_actor              jsonb       DEFAULT NULL,
  p_force              boolean     DEFAULT false,
  -- The row's status as the caller read it. Given, a decision on a row in
  -- another status is refused.
  p_was                text        DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  r            settled_parts%ROWTYPE;
  v_old_edited boolean;
  v_new_edited boolean;
BEGIN
  -- The decision is not echoed: see record_settled_part.
  IF p_decision IS NULL OR p_decision NOT IN ('accept', 'reject') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'review_settled_part: p_decision must be accept or reject',
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_was IS NOT NULL AND p_was NOT IN ('pending', 'accepted', 'rejected', 'stale') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'review_settled_part: p_was must be a status a part can have: pending, accepted, rejected or stale',
      ERRCODE = 'invalid_parameter_value';
  END IF;
  -- READ COMMITTED alone, checked before anything is read (068's rule). An
  -- accept reads the two texts after it has the lock; above READ COMMITTED
  -- it would read them as the transaction first saw them, and accept a part
  -- whose text an edit moved while it waited.
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('review_settled_part must run under READ COMMITTED; this transaction is %s', upper(current_setting('transaction_isolation'))),
      HINT = 'Under REPEATABLE READ or SERIALIZABLE its read of the two texts would predate its lock. BEGIN ISOLATION LEVEL READ COMMITTED; then call it.',
      ERRCODE = 'feature_not_supported';
  END IF;
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;

  -- The locks in review_supersession_proposal's order (036): the
  -- supersession advisory lock first, then the row. rebuild_derived takes the
  -- same lock before it moves a part, delete_thought before the cascade
  -- that takes one, and record_settled_part before it reads the two texts.
  -- This function takes no thought's row, where 036's review locks the one
  -- it writes: a part's decision writes none. It reads the two texts
  -- unlocked, after its own locks, as 036's review reads the thought it
  -- does not write.
  PERFORM pg_advisory_xact_lock(hashtext('ob1:supersession-review'));

  SELECT * INTO r FROM settled_parts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND', 'id', p_id);
  END IF;

  -- ob1:a-decision-is-on-the-row-as-read — a CONTRACT SENTINEL (the 014
  -- convention), read by db/test-schema.ts. The id names one judgement: a
  -- row a later judgement replaced is gone, that judgement another row
  -- (record_settled_part), so the words here are the words the caller
  -- read, or the id found nothing above. What
  -- can have changed under a reader is the status: a second reviewer may
  -- have decided, a rebuild may have set the row stale. A caller that gives
  -- the status it read is refused when the row's is another, and told the
  -- row's. The status is all it compares: decisions made in between that
  -- leave the row in the status the caller read are not seen (a rejection
  -- read, then an accept and a second rejection by others, and the first
  -- caller's accept landed on the second, 10 of 10: review pass 4).
  IF p_was IS NOT NULL AND r.status <> p_was THEN
    RETURN jsonb_build_object('ok', false, 'error', 'STALE_READ', 'id', p_id, 'status', r.status);
  END IF;

  -- A decision that repeats the row's status decides nothing, and is said so
  -- rather than restamped with a second reviewer and time. The other way
  -- round is a reversal, which a reviewer may make: the row keeps the last
  -- decision alone, and `was` says the status it replaced.
  IF p_decision = 'reject' THEN
    IF r.status = 'rejected' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_REJECTED', 'id', p_id);
    END IF;
    UPDATE settled_parts SET status = 'rejected', reviewed_at = now(), review_note = p_note WHERE id = p_id;
    RETURN jsonb_build_object('ok', true, 'id', p_id, 'status', 'rejected', 'was', r.status);
  END IF;

  -- accept
  IF r.status = 'accepted' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_ACCEPTED', 'id', p_id);
  END IF;
  -- The part quotes the texts as judged. Either edited since is refused
  -- unless the reviewer, shown both texts, says p_force (036's rule).
  SELECT r.older_fingerprint IS DISTINCT FROM content_fingerprint_of(content)
    INTO v_old_edited FROM thoughts WHERE id = r.older_id;
  SELECT r.newer_fingerprint IS DISTINCT FROM content_fingerprint_of(content)
    INTO v_new_edited FROM thoughts WHERE id = r.newer_id;
  IF NOT COALESCE(p_force, false) AND (COALESCE(v_old_edited, false) OR COALESCE(v_new_edited, false)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'EDITED_SINCE', 'id', p_id,
                              'older_edited', COALESCE(v_old_edited, false), 'newer_edited', COALESCE(v_new_edited, false));
  END IF;
  -- ob1:a-part-never-writes-supersedes — a CONTRACT SENTINEL (the 014
  -- convention), read by db/test-schema.ts: the acceptance is this one
  -- UPDATE of the part's own row. No thought is written, so no pointer is
  -- set and nothing is demoted (docs/subject-anchored-claims.md, row 8).
  UPDATE settled_parts SET status = 'accepted', reviewed_at = now(), review_note = p_note WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'status', 'accepted', 'was', r.status);
END;
$$;

COMMENT ON FUNCTION review_settled_part(uuid, text, text, jsonb, boolean, text) IS
  'The reviewer''s decision on one settled part (148, SMD-4446): accept or reject, with a note. Refuses, as values, each {ok: false, error, id}: NOT_FOUND, which is also the answer for the id of a part a later judgement has replaced (a row is one judgement: record_settled_part deletes an undecided row that is no longer a judgement of the texts as they stand, and records another); STALE_READ, with status, the row''s, when p_was is given and the row''s status is another (a second reviewer decided, or a rebuild set it stale, since the caller read it); ALREADY_ACCEPTED and ALREADY_REJECTED, for a decision that repeats the row''s status; EDITED_SINCE, with older_edited and newer_edited, for an accept when either text has moved since it was judged, unless p_force. A reject reads no text. A reviewer may reverse a decision, and may decide a stale row as one may a stale proposal: reject it, or accept it, which a moved text refuses unless p_force. The row keeps the last decision alone, its note or none with it. A forced accept is recorded as any accept is: the row says neither that it was forced nor at which texts. The decision asks no actor: made with no envelope, in a transaction and a session that set none, it names no reviewer. A decision that gives no p_was is made on the row in whatever status it stands, and p_was is the status alone: decisions in between that leave it as the caller read it are not seen. An acceptance updates the part''s own row and writes no thought: no supersedes pointer is set and nothing is demoted. p_actor is set on ob1.actor, from which settled_parts_stamp_reviewer stamps who decided. Raises (invalid_parameter_value) on a decision that is neither, or a p_was that is no status, without echoing either, and (feature_not_supported) above READ COMMITTED, where an accept that waited would read the texts as they were. Takes the supersession advisory lock, then the row, as review_supersession_proposal does. Returns {ok, id, status, was}. Migration 148 / SMD-4446.';

-- ---------------------------------------------------------------------------
-- 6. The primitive: 067's body verbatim, the part beside the proposal. Four
--    places: the artifact's thought is not read for a part's row, as it is
--    not for a proposal's; a part's lineage row is an orphan when the part
--    is gone (a statement after the other kinds' CASE, not an arm of it);
--    it is counted for the cascade when the input leaves; and a moved text
--    stales a pending part.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rebuild_derived(
  p_input        uuid,
  p_reason       text,
  p_input_gone   boolean DEFAULT false,
  p_fingerprints text[]  DEFAULT NULL,
  p_force        boolean DEFAULT false,
  -- 063, first review pass: the orphan sweep (db/rebuild.ts --orphans) acts
  -- on the rows whose artifact is gone and nothing else — a stale row on the
  -- same thought keeps its own reason for its own rebuild (cold read: the
  -- sweep marked and handed on every stale row under the sweep's name).
  p_orphans_only boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_t            record;             -- the input's row
  v_a            record;             -- the artifact's thought, per row
  v_a_found      boolean := false;
  v_p            record;             -- the proposal, per row
  v_s            record;             -- the part, per row (148)
  v_row          record;             -- one walk row
  v_fp           text;               -- the input's current fingerprint
  v_cur          text;               -- the artifact's thought's current fingerprint
  v_cfg_model    text;
  v_cfg_dim      text;
  v_cfg_key      text;
  v_model        text;
  v_pool         text;
  v_snap_ok      boolean;            -- a usable snapshot row for the vector arm (no variable of the vector type: the body must run with pgvector off the search_path — db/test-search-path.ts)
  v_fps          text[];
  v_touched      uuid[];
  v_more         uuid[];
  v_graph_done   boolean := false;
  v_windows_done boolean := false;
  v_orphan       boolean;
  v_stale        boolean;
  v_fp_stale     boolean;
  v_stale_props  int := 0;
  v_stale_parts  int := 0;
  v_walked       int := 0;
  v_depth        int := 0;
  v_rebuilt      int := 0;
  v_enqueued     int := 0;
  v_deleted      int := 0;
  v_marked       int := 0;
  v_unqueued     int := 0;
  v_kept         int := 0;
  v_current      int := 0;
  v_legacy       int := 0;
  v_casc_prop    int := 0;
  v_casc_part    int := 0;
  v_casc_rows    int := 0;
  v_n            int;
  v_irre         uuid[] := ARRAY[]::uuid[];
  v_pools        text[] := ARRAY[]::text[];
  v_claims       text[] := ARRAY[]::text[];  -- distinct (pool, thought) enqueued
  -- ob1:rebuild-acts-on-a-held-frontier — a CONTRACT SENTINEL (the 014
  -- convention), read by db/test-schema.ts: the walk is materialised whole
  -- (a plpgsql set-returning function's rows) before any row moves, and the
  -- supersession advisory lock is taken before the input's row — 036's and
  -- 060's order, kept here because this function moves proposal rows.
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION USING
      MESSAGE = 'rebuild_derived: p_reason must say why (forget, edit, trust, sweep ...) - it is recorded on every row marked',
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_input_gone AND p_orphans_only THEN
    RAISE EXCEPTION USING
      MESSAGE = 'rebuild_derived: p_input_gone and p_orphans_only exclude each other - a leaving input takes every artifact it keyed, a sweep takes orphans alone',
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF COALESCE(current_setting('ob1.projecting_replay', true), '') = 'on' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'REPLAYING', 'id', p_input);
  END IF;

  -- The locks, in delete_thought's order (036/060): the supersession lock
  -- first and unconditionally, then the input's row.
  PERFORM pg_advisory_xact_lock(hashtext('ob1:supersession-review'));
  SELECT t.id, t.content, t.content_fingerprint, t.embedding, t.embedding_model, t.metadata
    INTO v_t FROM thoughts t WHERE t.id = p_input FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND', 'id', p_input);
  END IF;
  v_fp := COALESCE(v_t.content_fingerprint, content_fingerprint_of(v_t.content));

  -- The workers' current keys (the pools they drain); NULL where unset.
  -- An empty value is unset, as 016's trigger reads the extraction key (and
  -- 015's claims refuse an empty work_type) — first review pass, cold read.
  SELECT NULLIF(value, '') INTO v_cfg_model FROM ob1_config WHERE key = 'embedding_model';
  SELECT NULLIF(value, '') INTO v_cfg_dim   FROM ob1_config WHERE key = 'embedding_dim';
  SELECT NULLIF(value, '') INTO v_cfg_key   FROM ob1_config WHERE key = 'entity_extraction_key';

  -- The input leaving: the snapshot fingerprints, computed while the input's
  -- own lineage rows still stand — its OWN position on each (a proposal's row
  -- carries both thoughts'), the current one, the caller's from the log —
  -- minus any a standing thought other than the input holds.
  IF p_input_gone THEN
    SELECT array_agg(DISTINCT s.f) INTO v_fps
      FROM (SELECT v_fp AS f
            UNION ALL
            SELECT d.input_fingerprints[array_position(d.input_ids, p_input)]
              FROM derivations d WHERE d.input_ids @> ARRAY[p_input]
            UNION ALL
            SELECT unnest(COALESCE(p_fingerprints, ARRAY[]::text[]))) AS s
     WHERE s.f IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM thoughts o
                        WHERE o.id <> p_input
                          AND (o.content_fingerprint = s.f
                               OR (o.content_fingerprint IS NULL AND content_fingerprint_of(o.content) = s.f)));
  END IF;

  -- The walk, held whole (the set-returning function materialises its rows
  -- before the first is read), then acted on row by row.
  FOR v_row IN SELECT * FROM derivation_descendants(p_input) LOOP
    v_walked := v_walked + 1;
    v_depth  := GREATEST(v_depth, v_row.depth);

    -- Prose: a derived_from child. Listed; its text did not move, and its
    -- recipe is a synthesis no rebuild re-runs — the limit, named.
    IF v_row.prose THEN
      -- (Not under orphans_only: the sweep reproduces nothing, so it reports
      -- nothing as irreproducible — second review pass, cold read.)
      IF NOT p_orphans_only THEN v_irre := v_irre || v_row.artifact_id; END IF;
      CONTINUE;
    END IF;

    -- The artifact's thought (the proposal's is the pair; read below). The
    -- SELECT INTO runs on EVERY row: a record variable never assigned has no
    -- tuple shape, and the first expression that names one of its fields
    -- raises "record is not assigned yet" — the first rebuild in a session
    -- whose first row was a proposal failed so (run-it, first review pass).
    -- A no-row SELECT INTO leaves a NULL row WITH a shape.
    SELECT t.id, t.content, t.content_fingerprint, t.embedding, t.embedding_model, t.metadata
      INTO v_a FROM thoughts t WHERE t.id = v_row.artifact_id AND v_row.artifact_kind NOT IN ('proposal', 'part');
    v_a_found := FOUND;

    -- ORPHAN rules first: a row whose artifact is gone names nothing to
    -- re-derive, and a vector row on a NULL embedding must never reach the
    -- refresh (OB002 would roll a forget back).
    v_orphan := CASE v_row.artifact_kind
      WHEN 'chunks'   THEN NOT EXISTS (SELECT 1 FROM thought_chunks c WHERE c.thought_id = v_row.artifact_id)
      WHEN 'entities' THEN NOT EXISTS (SELECT 1 FROM thought_entities m WHERE m.thought_id = v_row.artifact_id AND m.extraction_key = v_row.produced_by)
                       AND NOT EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.thought_id = v_row.artifact_id AND g.extraction_key = v_row.produced_by)
      WHEN 'vector'   THEN NOT v_a_found OR v_a.embedding IS NULL
      WHEN 'metadata' THEN NOT v_a_found OR NOT COALESCE(v_a.metadata ? 'type' OR v_a.metadata ? 'topics', false)
      WHEN 'proposal' THEN NOT EXISTS (SELECT 1 FROM supersession_proposals p WHERE p.id = v_row.artifact_id)
      ELSE false END;
    -- 148: a part's row, tested in a statement of its own. One arm more in
    -- the CASE above would have every caller's plan read settled_parts:
    -- under a generic plan Postgres checks each arm's table, whichever
    -- kind the row is, so a role without SELECT there was refused on
    -- thoughts that hold no part, from its sixth call of a session (25
    -- of 30 sweeps on a small brain, none before this file: review pass
    -- 4). A statement is planned when it first runs.
    IF v_row.artifact_kind = 'part' THEN
      v_orphan := NOT EXISTS (SELECT 1 FROM settled_parts s WHERE s.id = v_row.artifact_id);
    END IF;
    IF v_orphan THEN
      DELETE FROM derivations WHERE id = v_row.derivation_id;
      v_deleted := v_deleted + 1;
      CONTINUE;
    END IF;
    IF p_orphans_only THEN
      v_current := v_current + 1;
      CONTINUE;
    END IF;
    IF v_row.recipe->>'legacy' = 'true' THEN v_legacy := v_legacy + 1; END IF;

    -- THE INPUT LEAVING, for the artifacts it keys: they go with it.
    IF p_input_gone AND v_row.artifact_id = p_input THEN
      CASE v_row.artifact_kind
        WHEN 'chunks' THEN
          IF NOT v_windows_done THEN
            DELETE FROM thought_chunks WHERE thought_id = p_input;
            v_windows_done := true;
          END IF;
          DELETE FROM derivations WHERE id = v_row.derivation_id;
          v_deleted := v_deleted + 1;
        WHEN 'entities' THEN
          IF NOT v_graph_done THEN
            -- The worker's lock order (016, 053): the entities first, then
            -- the mention and edge rows, then the prune over what was touched.
            SELECT array_agg(DISTINCT e) INTO v_touched
              FROM (SELECT m.entity_id AS e FROM thought_entities m WHERE m.thought_id = p_input
                    UNION ALL SELECT g.from_entity_id FROM ob1_entity_edges g WHERE g.thought_id = p_input
                    UNION ALL SELECT g.to_entity_id   FROM ob1_entity_edges g WHERE g.thought_id = p_input) AS s;
            IF v_touched IS NOT NULL THEN
              PERFORM e.id FROM ob1_entities e WHERE e.id = ANY(v_touched) ORDER BY e.id FOR UPDATE;
            END IF;
            -- The deletes RETURN what they touched: a worker that committed
            -- while this waited on the entity lock wrote rows the snapshot
            -- above did not see, and its entities are pruned too (run-it,
            -- the build: test-live [31]'s race left the worker's new entity
            -- standing).
            WITH d AS (DELETE FROM ob1_entity_edges WHERE thought_id = p_input RETURNING from_entity_id, to_entity_id)
            SELECT array_agg(x) INTO v_more FROM (SELECT d.from_entity_id FROM d UNION SELECT d.to_entity_id FROM d) AS s(x);
            v_touched := COALESCE(v_touched, ARRAY[]::uuid[]) || COALESCE(v_more, ARRAY[]::uuid[]);
            WITH d AS (DELETE FROM thought_entities WHERE thought_id = p_input RETURNING entity_id)
            SELECT array_agg(d.entity_id) INTO v_more FROM d;
            v_touched := v_touched || COALESCE(v_more, ARRAY[]::uuid[]);
            IF cardinality(v_touched) > 0 THEN
              DELETE FROM ob1_entities e
               WHERE e.id = ANY(v_touched)
                 AND NOT EXISTS (SELECT 1 FROM thought_entities m WHERE m.entity_id = e.id)
                 AND NOT EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.from_entity_id = e.id OR g.to_entity_id = e.id);
            END IF;
            v_graph_done := true;
          END IF;
          DELETE FROM derivations WHERE id = v_row.derivation_id;
          v_deleted := v_deleted + 1;
        ELSE
          -- The vector's and the tags' rows: 061's drop trigger's, at the
          -- caller's row delete.
          v_casc_rows := v_casc_rows + 1;
      END CASE;
      CONTINUE;
    END IF;
    IF p_input_gone AND v_row.artifact_kind = 'proposal' THEN
      -- 029's cascade takes the proposal at the caller's row delete; its
      -- lineage row goes by the proposal's own drop trigger.
      v_casc_prop := v_casc_prop + 1;
      CONTINUE;
    END IF;
    IF p_input_gone AND v_row.artifact_kind = 'part' THEN
      -- 148: the part's own cascade takes it at the caller's row delete, and
      -- its lineage row goes by the part's drop trigger.
      v_casc_part := v_casc_part + 1;
      CONTINUE;
    END IF;

    -- THE INPUT STANDING (or a row fed by the leaving input that another
    -- thought keys): stale when any input's fingerprint moved or the input
    -- has no row; --force says every row is.
    v_fp_stale := (p_input_gone AND p_input = ANY(v_row.input_ids))
               OR EXISTS (SELECT 1 FROM unnest(v_row.input_ids, v_row.input_fingerprints) AS u(iid, ifp)
                            LEFT JOIN thoughts t ON t.id = u.iid
                           WHERE t.id IS NULL
                              OR u.ifp IS DISTINCT FROM COALESCE(t.content_fingerprint, content_fingerprint_of(t.content)));
    v_stale := p_force OR v_fp_stale;
    IF NOT v_stale THEN
      v_current := v_current + 1;
      CONTINUE;
    END IF;

    CASE v_row.artifact_kind
      WHEN 'vector' THEN
        v_cur   := COALESCE(v_a.content_fingerprint, content_fingerprint_of(v_a.content));
        v_model := COALESCE(v_row.recipe->>'model', v_a.embedding_model, v_cfg_model);
        -- (The row's OWN model — its recipe's or its label — against the
        -- configured one, not v_model's fallback to the config: an unlabelled
        -- vector would otherwise be re-recorded under a model nothing named,
        -- where the pool's write moves the label and records — fourth
        -- review pass.)
        IF NOT v_fp_stale AND (v_cfg_model IS NULL OR COALESCE(v_row.recipe->>'model', v_a.embedding_model) IS NOT DISTINCT FROM v_cfg_model) THEN
          -- --force on a vector whose text did not move, AT THE CONFIGURED
          -- MODEL: the vector IS the current text's (a deterministic model,
          -- the fingerprint the row carries), so what force renews is the
          -- RECORD — the row is written again under the recipe as it stands,
          -- which drops `legacy` and clears the mark. Sending it to the pool
          -- would mark a row no worker could clear: the re-embedding
          -- reproduces the vector, and the trigger returns before recording
          -- when neither the vector nor its label moved (second review pass,
          -- cold read and run-it). A vector at ANOTHER model — a corpus
          -- mid-switch — takes the pool path below: the re-embed moves the
          -- label, the trigger records, the mark clears (third review pass,
          -- cold read: the re-record left such rows at the old model and
          -- called them rebuilt). The row's agent stands when the session
          -- sets no actor: the vector did not change, its writer's word does
          -- (third pass, run-it).
          PERFORM ob1_record_derivation('vector', v_a.id, ARRAY[v_a.id], ARRAY[v_cur], v_row.produced_by,
                                        jsonb_build_object('deterministic', true, 'dims', array_length(v_a.embedding::real[], 1))
                                          || jsonb_strip_nulls(jsonb_build_object('model', v_model)),
                                        COALESCE(ob1_actor_agent_id(), (SELECT d.canonical_agent_id FROM derivations d WHERE d.id = v_row.derivation_id)));
          v_rebuilt := v_rebuilt + 1;
        ELSE
        -- A usable snapshot row: the current text at the model, holding a
        -- vector OTHER than the one the row carries. An identical vector is
        -- not the new text's: 060's snapshot trigger records the standing
        -- vector under the row's key when a raw writer moves the text and
        -- leaves the vector, so that row is the raw writer's copy (a model
        -- does not embed two texts to the same vector), and restoring it
        -- would launder the staleness the census exists to see (061's first
        -- review pass named the same trap on the vector trigger) — run-it,
        -- the build: the smoke's raw move "rebuilt" its own stale vector.
        -- …and only for a row stale BY FINGERPRINT: under --force alone the
        -- row's text did not move, so a differing snapshot vector at its key
        -- is a twin's raw move overwriting it (060's trigger upserts under
        -- the key), and restoring it would launder the other way (cold read,
        -- first review pass) — force sends the row to the pool instead.
        v_snap_ok := v_fp_stale AND v_model IS NOT NULL AND EXISTS (
          SELECT 1 FROM ob1_embedding_snapshot s
           WHERE s.content_fingerprint = v_cur AND s.embedding_model = v_model
             AND s.embedding::real[] IS DISTINCT FROM v_a.embedding::real[]);
        IF v_snap_ok THEN
          -- The one re-derivation this database owns: the text's vector at
          -- the model already stands in the snapshot. A projection refresh
          -- (no event, no updated_at); the vector moved, so the vector
          -- trigger re-records the row at the current fingerprint.
          PERFORM ob1_refresh_thought_vector(v_a.id,
                                             (SELECT s.embedding FROM ob1_embedding_snapshot s WHERE s.content_fingerprint = v_cur AND s.embedding_model = v_model),
                                             v_model);
          v_rebuilt := v_rebuilt + 1;
        ELSE
          v_pool := CASE WHEN v_cfg_model IS NOT NULL AND v_cfg_dim IS NOT NULL THEN 'reembed:' || v_cfg_model || '@' || v_cfg_dim END;
          UPDATE derivations SET stale_since = COALESCE(stale_since, now()), stale_reason = COALESCE(stale_reason, p_reason) WHERE id = v_row.derivation_id;
          v_marked := v_marked + 1;
          IF v_pool IS NULL THEN
            v_unqueued := v_unqueued + 1;
          ELSIF NOT ((v_pool || '|' || v_a.id::text) = ANY(v_claims)) THEN
            PERFORM requeue_thought_work(v_pool, v_a.id);
            v_claims := v_claims || (v_pool || '|' || v_a.id::text);
            v_enqueued := v_enqueued + 1;
            IF NOT (v_pool = ANY(v_pools)) THEN v_pools := v_pools || v_pool; END IF;
          END IF;
        END IF;
        END IF;
      WHEN 'chunks' THEN
        -- The windows: split and embedded by db/reembed.ts under the
        -- configured model, through the 11-argument update_thought, which
        -- re-records them.
        v_pool := CASE WHEN v_cfg_model IS NOT NULL AND v_cfg_dim IS NOT NULL THEN 'reembed:' || v_cfg_model || '@' || v_cfg_dim END;
        UPDATE derivations SET stale_since = COALESCE(stale_since, now()), stale_reason = COALESCE(stale_reason, p_reason) WHERE id = v_row.derivation_id;
        v_marked := v_marked + 1;
        IF v_pool IS NULL THEN
          v_unqueued := v_unqueued + 1;
        ELSIF NOT ((v_pool || '|' || v_a.id::text) = ANY(v_claims)) THEN
          PERFORM requeue_thought_work(v_pool, v_a.id);
          v_claims := v_claims || (v_pool || '|' || v_a.id::text);
          v_enqueued := v_enqueued + 1;
          IF NOT (v_pool = ANY(v_pools)) THEN v_pools := v_pools || v_pool; END IF;
        END IF;
      WHEN 'entities' THEN
        IF v_row.produced_by LIKE 'source:%' THEN
          -- A structured pass reads the source's own record, not the text.
          v_kept := v_kept + 1;
        ELSE
          v_pool := COALESCE(v_cfg_key, v_row.produced_by);
          UPDATE derivations SET stale_since = COALESCE(stale_since, now()), stale_reason = COALESCE(stale_reason, p_reason) WHERE id = v_row.derivation_id;
          v_marked := v_marked + 1;
          IF NOT ((v_pool || '|' || v_a.id::text) = ANY(v_claims)) THEN
            PERFORM requeue_thought_work(v_pool, v_a.id);
            v_claims := v_claims || (v_pool || '|' || v_a.id::text);
            v_enqueued := v_enqueued + 1;
            IF NOT (v_pool = ANY(v_pools)) THEN v_pools := v_pools || v_pool; END IF;
          END IF;
        END IF;
      WHEN 'proposal' THEN
        SELECT p.id, p.status, p.newer_id, p.judge_key, p.review_note INTO v_p
          FROM supersession_proposals p WHERE p.id = v_row.artifact_id FOR UPDATE;
        -- ob1:pass-settled-is-the-pass-to-reopen — a CONTRACT SENTINEL (the
        -- 014 convention), read by db/test-schema.ts and by preflight: a
        -- rejected row whose review_note begins 'settled by the pass:' was
        -- decided by db/consolidate.ts about texts that have now moved, so a
        -- text move makes it stale again as it makes a pending one; a
        -- person's decision stands (067, SMD-2297). The literal is
        -- server-portable/consolidate.ts's PASS_SETTLED_PREFIX; test-schema
        -- holds the two to one string.
        IF v_p.status IN ('pending', 'stale')
           OR (v_p.status = 'rejected' AND v_p.review_note LIKE 'settled by the pass:%') THEN
          -- The proposal's own status is its mark: the lineage row is left
          -- unmarked, since nothing but the pass's replacement writes it
          -- again — a reviewer's decision on the stale row would otherwise
          -- leave a mark standing for ever and the census counting it (cold
          -- read, 063's first review pass). The judge's key is the pool by
          -- construction (029: db/consolidate.ts writes its job as the key);
          -- no config records the current one, so the claim written here
          -- sits under the ROW's key — and since 067 the pass re-pools every
          -- stale row's newer thought under its OWN key at the start of a
          -- run, so a judge-model change no longer strands the pair (a
          -- stray pending row under the old key is what --status shows).
          -- A row already stale is requeued again and not counted again.
          -- From pending or from the pass's own rejection: reviewed_at goes
          -- back to NULL (063's unreviewed CHECK reads a stale row as
          -- unreviewed) and the pass's note with it, as 063's replacement
          -- clears a note — a stale row carries none.
          IF v_p.status IN ('pending', 'rejected') THEN
            UPDATE supersession_proposals
               SET status = 'stale', reviewed_at = NULL, review_note = NULL
             WHERE id = v_p.id AND status IN ('pending', 'rejected');
            v_stale_props := v_stale_props + 1;
          END IF;
          v_pool := v_p.judge_key;
          IF NOT ((v_pool || '|' || v_p.newer_id::text) = ANY(v_claims)) THEN
            PERFORM requeue_thought_work(v_pool, v_p.newer_id);
            v_claims := v_claims || (v_pool || '|' || v_p.newer_id::text);
            v_enqueued := v_enqueued + 1;
            IF NOT (v_pool = ANY(v_pools)) THEN v_pools := v_pools || v_pool; END IF;
          END IF;
        ELSE
          -- A person's decision stands — an accepted row, or a rejection
          -- whose note is not the pass's; the queue says edited-since.
          v_kept := v_kept + 1;
        END IF;
      WHEN 'part' THEN
        SELECT s.id, s.status, s.newer_id, s.judge_key INTO v_s
          FROM settled_parts s WHERE s.id = v_row.artifact_id FOR UPDATE;
        -- ob1:a-moved-text-stales-its-parts - a CONTRACT SENTINEL (the 014
        -- convention), read by db/test-schema.ts. 148: a pending part
        -- quotes texts that have now moved, so it goes stale and its newer
        -- thought is queued again under the part's judge key; a part
        -- already stale is queued again and not counted again. A decided
        -- part stands, a rejection included: nothing settles a part yet, so
        -- the proposal's reopening of a rejection the pass made has no arm
        -- here. The part's status is its mark, and the lineage row is left
        -- unmarked, as a proposal's is.
        IF v_s.status IN ('pending', 'stale') THEN
          IF v_s.status = 'pending' THEN
            UPDATE settled_parts SET status = 'stale' WHERE id = v_s.id AND status = 'pending';
            v_stale_parts := v_stale_parts + 1;
          END IF;
          v_pool := v_s.judge_key;
          IF NOT ((v_pool || '|' || v_s.newer_id::text) = ANY(v_claims)) THEN
            PERFORM requeue_thought_work(v_pool, v_s.newer_id);
            v_claims := v_claims || (v_pool || '|' || v_s.newer_id::text);
            v_enqueued := v_enqueued + 1;
            IF NOT (v_pool = ANY(v_pools)) THEN v_pools := v_pools || v_pool; END IF;
          END IF;
        ELSE
          v_kept := v_kept + 1;
        END IF;
      WHEN 'section' THEN
        -- 064's generated page section (SMD-1812): no pool regenerates it —
        -- its generator calls write_page_section, whose lineage upsert
        -- clears the mark — so it is marked for the operator, as the tags
        -- are. Before this file the row fell to the kept arm below, unmarked
        -- and uncounted as waiting (067's post-merge review pass, run-it).
        UPDATE derivations SET stale_since = COALESCE(stale_since, now()), stale_reason = COALESCE(stale_reason, p_reason) WHERE id = v_row.derivation_id;
        v_marked   := v_marked + 1;
        v_unqueued := v_unqueued + 1;
      WHEN 'metadata' THEN
        -- No pool re-tags a thought: marked for the operator, nothing more.
        UPDATE derivations SET stale_since = COALESCE(stale_since, now()), stale_reason = COALESCE(stale_reason, p_reason) WHERE id = v_row.derivation_id;
        v_marked   := v_marked + 1;
        v_unqueued := v_unqueued + 1;
      ELSE
        v_kept := v_kept + 1;
    END CASE;
  END LOOP;

  -- The input leaving, whatever the walk held: mentions written by a producer
  -- from before 061 (or by a raw writer) have no lineage row, so the windows
  -- and the graph go here when no row in the walk took them (run-it, first
  -- review pass: a thought whose entities rows were gone kept its mentions
  -- for the cascade and its entities for nobody). A worker committing an
  -- extraction after this ran leaves an entity the caller's row delete does
  -- not prune — delete_thought's own residue; prune_orphan_entities() is its
  -- broom.
  IF p_input_gone AND NOT v_windows_done THEN
    DELETE FROM thought_chunks WHERE thought_id = p_input;
    v_windows_done := true;
  END IF;
  IF p_input_gone AND NOT v_graph_done THEN
    SELECT array_agg(DISTINCT e) INTO v_touched
      FROM (SELECT m.entity_id AS e FROM thought_entities m WHERE m.thought_id = p_input
            UNION ALL SELECT g.from_entity_id FROM ob1_entity_edges g WHERE g.thought_id = p_input
            UNION ALL SELECT g.to_entity_id   FROM ob1_entity_edges g WHERE g.thought_id = p_input) AS s;
    IF v_touched IS NOT NULL THEN
      PERFORM e.id FROM ob1_entities e WHERE e.id = ANY(v_touched) ORDER BY e.id FOR UPDATE;
    END IF;
    WITH d AS (DELETE FROM ob1_entity_edges WHERE thought_id = p_input RETURNING from_entity_id, to_entity_id)
    SELECT array_agg(x) INTO v_more FROM (SELECT d.from_entity_id FROM d UNION SELECT d.to_entity_id FROM d) AS s(x);
    v_touched := COALESCE(v_touched, ARRAY[]::uuid[]) || COALESCE(v_more, ARRAY[]::uuid[]);
    WITH d AS (DELETE FROM thought_entities WHERE thought_id = p_input RETURNING entity_id)
    SELECT array_agg(d.entity_id) INTO v_more FROM d;
    v_touched := v_touched || COALESCE(v_more, ARRAY[]::uuid[]);
    IF cardinality(v_touched) > 0 THEN
      DELETE FROM ob1_entities e
       WHERE e.id = ANY(v_touched)
         AND NOT EXISTS (SELECT 1 FROM thought_entities m WHERE m.entity_id = e.id)
         AND NOT EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.from_entity_id = e.id OR g.to_entity_id = e.id);
    END IF;
    v_graph_done := true;
  END IF;

  -- The input leaving: the snapshot rows at its fingerprints (060 names this
  -- file as their removal path).
  IF p_input_gone AND v_fps IS NOT NULL THEN
    DELETE FROM ob1_embedding_snapshot WHERE content_fingerprint = ANY(v_fps);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_deleted := v_deleted + v_n;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'input', p_input, 'reason', p_reason, 'input_gone', p_input_gone, 'force', p_force, 'orphans_only', p_orphans_only,
    -- at_cap: the walk returned its cap of rows; whatever stood beyond, if
    -- anything, is the next call's (the walk is deterministic and shrinks as
    -- rows are deleted or re-recorded) — first review pass: "truncated" read
    -- as a cut on exactly the cap.
    'walked', v_walked, 'depth', v_depth, 'at_cap', v_walked >= 2000,
    'rebuilt', v_rebuilt, 'enqueued', v_enqueued, 'deleted', v_deleted,
    'marked', v_marked, 'unqueued', v_unqueued, 'stale_proposals', v_stale_props, 'stale_parts', v_stale_parts, 'kept', v_kept, 'current', v_current, 'legacy', v_legacy,
    'irreproducible', to_jsonb(v_irre),
    'cascading', jsonb_build_object('proposals', v_casc_prop, 'parts', v_casc_part, 'lineage_rows', v_casc_rows),
    'pools', to_jsonb(v_pools));
END;
$$;

COMMENT ON FUNCTION rebuild_derived(uuid, text, boolean, text[], boolean, boolean) IS
  'The one primitive over the lineage table (SMD-1732, Phase 1c of SMD-1729): walks `derivations` forward from p_input (derivation_descendants) and acts on every descendant. A row whose artifact is gone is deleted. With the input standing, a row whose inputs'' fingerprints moved (or p_force) is: re-derived when the database can — a vector whose current text has a snapshot row at the model, by ob1_refresh_thought_vector (rebuilt); otherwise handed to the worker that owns the recipe through requeue_thought_work under the worker''s current key — the reembed pool for a vector or the windows, the extraction key for an extract: pass, the judge''s key — with stale_since/stale_reason set on the lineage row (marked; the tags have no pool: unqueued; the first request standing is kept) — and, for a pending proposal or one the consolidation pass itself rejected (a review_note beginning ''settled by the pass:'', 067), its status set stale with reviewed_at and the note cleared (the status is the mark; stale_proposals; the next pass replaces the row when it finds the conflict again and settles it when it does not), and for a pending settled part its status set stale and its newer thought queued under the part''s judge key (148; stale_parts; a part already stale is queued again and not counted again; a decided part is kept, a rejection included: nothing settles a part yet); under p_force a vector whose text did not move, at the configured model, is re-recorded, not re-embedded (one at another model goes to the pool); a source: pass, a person''s decision on a proposal and a decided part are kept; a generated page section (064) is marked with no pool, as the tags are; an unmoved row is current. With p_input_gone (SMD-1723''s forget, called BEFORE the row delete in its transaction): the windows, the input''s mentions and edges (entities locked first, orphans pruned) and their lineage rows are deleted, the snapshot rows at the input''s own fingerprints and p_fingerprints removed where no standing thought holds them, the proposals, the parts and the vector''s and tags'' rows counted for the cascade, as the walk saw them. derived_from children are listed as irreproducible. Refuses an empty reason; answers a replay with REPLAYING and a missing input with NOT_FOUND. Takes the supersession advisory lock, then the input''s row. With p_orphans_only (the sweep''s mode) only the orphan rule runs. Returns {ok, input, reason, input_gone, force, orphans_only, walked, depth, at_cap, rebuilt, enqueued, deleted, marked, unqueued, stale_proposals, stale_parts, kept, current, legacy, irreproducible, cascading, pools}. Migrations 063, 067, 148 / SMD-1732, SMD-2297, SMD-4446.';

-- ---------------------------------------------------------------------------
-- 7. supersession_proposals' grants, copied
-- ---------------------------------------------------------------------------
-- A role that decides or records proposals does the same for parts, and no
-- role gains what its grants on the proposals do not already amount to.
-- One holding SELECT and UPDATE on supersession_proposals (the server
-- group's reviewer, the worker group's pass) gains SELECT and UPDATE on
-- settled_parts. One holding INSERT there besides (the pass) gains INSERT
-- and DELETE too: an undecided row that is no longer a judgement of the
-- texts as they stand is deleted, and the judgement recorded as a new row.
-- A role holding less gains nothing. One that only reads the proposal
-- queue (the structure group's board-sync) has no use for a part; and one
-- holding UPDATE or INSERT there alone, which no group gives, can neither
-- decide nor record a proposal. Copied privilege by privilege, such a role
-- read a part's statement where it could read no proposal, or deleted
-- every part with INSERT alone (review pass 4).
-- Each grantee is read from its own entry in the proposals' ACL, PUBLIC's
-- included: a privilege held through membership is not followed. The owner
-- holds every privilege already. A re-apply copies the grants again: a
-- privilege on parts taken back by hand from a role that still holds the
-- proposals' comes back with it.
DO $grant$
DECLARE
  v_item record;
BEGIN
  FOR v_item IN
    SELECT a.grantee, bool_or(a.privilege_type = 'SELECT') AS reads, bool_or(a.privilege_type = 'UPDATE') AS updates,
           bool_or(a.privilege_type = 'INSERT') AS inserts
      FROM pg_class c, aclexplode(c.relacl) AS a
     WHERE c.oid = 'supersession_proposals'::regclass AND a.grantee <> c.relowner
     GROUP BY a.grantee
  LOOP
    CONTINUE WHEN NOT (v_item.reads AND v_item.updates);
    EXECUTE format('GRANT %s ON settled_parts TO %s',
                   CASE WHEN v_item.inserts THEN 'SELECT, INSERT, UPDATE, DELETE' ELSE 'SELECT, UPDATE' END,
                   CASE WHEN v_item.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_item.grantee)) END);
  END LOOP;
END
$grant$;
