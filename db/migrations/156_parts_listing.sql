-- =============================================================================
-- Migration 156: the settled parts' listing — list_settled_parts, each part
--                with its two quotes as its thoughts hold them now, the
--                whole-thought proposal on its pair and a keyset cursor, and
--                the index the listing reads (SMD-4446 PR 3a)
-- =============================================================================
--
-- WHY
--   Since decide version 6 the consolidation pass records settled parts (151):
--   a statement in one thought that the other thought of a pair settles, as a
--   proposal a reviewer decides. Nothing lists them. A reviewer could read one
--   only from the table, with neither thought beside it, and the dogfood
--   canary held 46 pending on 2026-11-27, twelve hours after its pass began
--   to record them.
--
-- WHAT
--   1. settled_parts_listing_idx on (status, judged_at, id): the listing's
--      selection and its order in one index, so a page of the pending queue
--      does not read the decided rows, which only grow. Measured on 30,000
--      parts, 2,000 of them pending, over texts of about 3,400 characters: a
--      page of 20 took 8 ms through it and 12 ms without (medians of seven).
--      Most of a page's time is its rows' own two texts, each hashed for the
--      edited flag: about 0.3 ms a row, 61 ms for a page of 200.
--   2. list_settled_parts(p_status, p_limit, p_judge_key, p_after_judged_at,
--      p_after_id, p_context) returns the parts in one status (NULL: every
--      status), oldest judged first, at most 200.
--      * Each row is the part as its row holds it (the holder, the statement,
--        the words that show it, the word and its group, the reason, the
--        judge's key and time, the decision and who made it), and both
--        thoughts as they are NOW: each one's id, capture time, first 200
--        characters, and whether its text has moved since the part was judged
--        (the row's fingerprint against content_fingerprint_of).
--      * The two quotes in their texts. statement_in_text and shown_by_in_text
--        say whether the holder's text still holds the statement, and the
--        other thought's the words that show it, read as a part's identity
--        reads a statement: case, runs of white space and white space at
--        either end folded (016's fold, which 151's one-statement index
--        applies). A row stores each quote as its thought's own characters, so
--        both are true while neither text has moved. Where the text holds the
--        row's characters exactly, the *_before and *_after columns give up to
--        p_context characters either side of their first place in it (120 by
--        default, 500 at most); where it holds them only as the fold reads
--        them, or not at all, the four are NULL. A statement the text says
--        twice is shown at its first place: the row keeps the words, not where
--        they stood.
--      * The pair's whole-thought proposal (029 holds one a pair), if any: its
--        id, status, verdict and the thought an accept made stand. A part
--        beside an accepted whole is a statement in a thought already marked
--        superseded, or in the one that superseded it.
--      * p_judge_key keeps one pass's parts, by its key exactly. The cursor,
--        p_after_judged_at and p_after_id, both set or neither, starts past
--        that row on the listing's order; page_key is each row's two values as
--        text for the next call, and remaining counts the selection's rows
--        from this page's first on (110's shape).
--      Oldest first, since a part has no confidence to order by: the queue is
--      read from its head, and a part recorded during a walk lands past the
--      cursor. judged_at is the time the write's transaction began, not the
--      order rows commit in (151's comment on the column), so a row whose
--      write began before a page was read and committed after it is passed
--      over by that walk, and listed by the next from the top. A row decided,
--      set stale or replaced during a walk leaves the selection and is not
--      listed after; a pending queue drains as it is decided.
--
-- WHO READS
--   No grant changes. The listing is SECURITY INVOKER: it reads settled_parts,
--   thoughts and supersession_proposals, and ob1_agents through
--   ob1_registry_kind for a decided row whose decision named an agent. The
--   server group (db/config.mjs) holds SELECT on the first and third since 151
--   and 029, and the capture group on thoughts; the worker group, which runs
--   db/consolidate.ts, holds all three. 151 carried the parts' SELECT only to a
--   role that reads the proposals, so no role it reached is refused the join.
--   A role granted settled_parts alone by hand is refused the listing (42501).
--   EXECUTE on a new function is PUBLIC's by default, as the proposals'
--   listing's is.
--
-- SAFETY
--   One index and one function. The index build reads every row of
--   settled_parts once under a SHARE lock on the table: a
--   record_settled_part that arrives meanwhile waits for it while holding the
--   supersession advisory lock, so a decision, a rebuild, a delete and a
--   forget wait with it for as long as the build takes (151's review measured
--   that queue behind a SHARE lock held by hand). The table holds tens of rows
--   on the dogfood brains, and the build milliseconds; a brain holding
--   millions applies this file in a quiet hour. Nothing else runs at apply
--   time, and no row is written. Nothing called the function before this
--   file, so there is no older form to drop. MINOR under MAINTAINING.md's
--   versioning: a new function, and with it a new REST route and tool.
--   test-schema [141], test-upgrade [20cs].
--
-- Prerequisites
--   016 (content_fingerprint_of), 029 (supersession_proposals), 046
--   (ob1_registry_kind) and 151 (settled_parts). Applied by
--   `bun db/migrate.ts`. Re-applied, the index is kept and the function
--   replaced as it was.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not hold
-- (052's shape). plpgsql resolves what a body reads only at its first call, so
-- a missing table or column would otherwise make a listing that fails when
-- called rather than a file refused here.
DO $qc$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(name, ', ' ORDER BY ord) INTO v_missing FROM (
    SELECT p.name, p.ord FROM (VALUES
        (1, 'content_fingerprint_of(text)', to_regprocedure('content_fingerprint_of(text)') IS NULL),
        (2, 'ob1_registry_kind(uuid, text)', to_regprocedure('ob1_registry_kind(uuid, text)') IS NULL),
        (3, 'supersession_proposals', to_regclass('supersession_proposals') IS NULL),
        (4, 'settled_parts', to_regclass('settled_parts') IS NULL)
      ) AS p(ord, name, missing)
     WHERE p.missing
    UNION ALL
    SELECT c.tbl || '.' || c.col, 10 + c.ord
      FROM (VALUES
        (1, 'supersession_proposals', 'superseding_id'), (2, 'supersession_proposals', 'verdict'),
        (3, 'settled_parts', 'holder'), (4, 'settled_parts', 'word_group'), (5, 'settled_parts', 'older_fingerprint'),
        (6, 'settled_parts', 'newer_fingerprint'), (7, 'settled_parts', 'judged_at'), (8, 'settled_parts', 'reviewed_by_kind')
      ) AS c(ord, tbl, col)
     WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns i
                        WHERE i.table_schema = current_schema() AND i.table_name = c.tbl AND i.column_name = c.col)
  ) m;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 156 needs 016, 029, 046 and 151; this schema lacks ' || v_missing,
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. The listing's index: its selection and its order
-- ---------------------------------------------------------------------------
-- One status, oldest judged first, ties by id: the listing reads its page off
-- this index's order, and the cursor's term is a range of it. The status
-- leads because a reviewer's queue is the pending rows, a small part of a
-- table whose decided rows only grow.
CREATE INDEX IF NOT EXISTS settled_parts_listing_idx
  ON settled_parts (status, judged_at, id);

-- ---------------------------------------------------------------------------
-- 2. list_settled_parts — the review queue for settled parts, each with its
--    two quotes as its thoughts hold them now, the whole-thought proposal on
--    its pair, and where a reader goes on from
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION list_settled_parts(
  p_status          text        DEFAULT 'pending',
  p_limit           int         DEFAULT 20,
  p_judge_key       text        DEFAULT NULL,
  p_after_judged_at timestamptz DEFAULT NULL,
  p_after_id        uuid        DEFAULT NULL,
  p_context         int         DEFAULT 120
)
RETURNS TABLE (
  id                   uuid,
  status               text,
  holder               text,
  statement            text,
  shown_by             text,
  word                 text,
  word_group           text,
  reason               text,
  judge_key            text,
  judged_at            timestamptz,
  reviewed_at          timestamptz,
  review_note          text,
  reviewed_by          text,
  reviewed_by_agent    boolean,
  reviewed_by_kind     text,
  reviewed_by_kind_now text,
  older_id             uuid,
  older_created_at     timestamptz,
  older_head           text,
  older_edited         boolean,
  newer_id             uuid,
  newer_created_at     timestamptz,
  newer_head           text,
  newer_edited         boolean,
  statement_in_text    boolean,
  statement_before     text,
  statement_after      text,
  shown_by_in_text     boolean,
  shown_by_before      text,
  shown_by_after       text,
  whole_id             uuid,
  whole_status         text,
  whole_verdict        text,
  whole_superseding_id uuid,
  page_key             text,
  remaining            bigint
)
LANGUAGE plpgsql
STABLE
AS $$
#variable_conflict use_column
DECLARE
  -- How much of a text is given either side of a quote: none below zero, and no more than 500.
  v_context int := LEAST(GREATEST(COALESCE(p_context, 120), 0), 500);
BEGIN
  -- Both of the cursor's values or neither: a partial cursor read as none
  -- would list from the top without a word (110's rule).
  IF num_nulls(p_after_judged_at, p_after_id) = 1 THEN
    RAISE EXCEPTION USING
      MESSAGE = 'list_settled_parts: the after-cursor is two values, p_after_judged_at and p_after_id, both set or neither',
      ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  -- ob1:parts-listing — a CONTRACT SENTINEL, not prose (the 014 convention),
  -- read by db/test-schema.ts. The page is chosen from the parts' rows alone,
  -- by id and time: both thoughts are foreign keys that cascade, so no join
  -- drops a part, and the count of what remains and the order need neither
  -- text. Chosen with the texts joined, every row of the selection carried
  -- both whole texts through the sort: 30,000 parts over texts of 3,400
  -- characters took 676 ms to list in every status, and 12 ms chosen first.
  WITH page AS MATERIALIZED (
    SELECT g.id, g.judged_at, count(*) OVER () AS remaining
      FROM settled_parts g
     WHERE (p_status IS NULL OR g.status = p_status)
       AND (p_judge_key IS NULL OR g.judge_key = p_judge_key)
       AND (p_after_id IS NULL OR (g.judged_at, g.id) > (p_after_judged_at, p_after_id))
     ORDER BY g.judged_at, g.id
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 200)
  )
  -- The part as its row holds it, and its two thoughts as they are now: a
  -- reviewer decides on the texts as they stand, and review_settled_part
  -- refuses an accept over a text that has moved unless forced, so each side
  -- says whether it has. `t` names the two texts by what the row quotes from
  -- each: the holder's holds the statement, the other thought's the words
  -- that show it. `q` is where the row's own characters first stand in each,
  -- 0 where they do not.
  SELECT s.id, s.status, s.holder, s.statement, s.shown_by, s.word, s.word_group, s.reason, s.judge_key,
         s.judged_at, s.reviewed_at, s.review_note,
         s.reviewed_by, s.reviewed_by_agent_id IS NOT NULL, s.reviewed_by_kind,
         -- The kind the registry gives the deciding agent now, for a row that recorded none at the decision.
         CASE WHEN s.reviewed_by_agent_id IS NOT NULL THEN ob1_registry_kind(s.reviewed_by_agent_id, s.reviewed_by) END,
         o.id, o.created_at, left(o.content, 200),
         s.older_fingerprint IS DISTINCT FROM content_fingerprint_of(o.content),
         n.id, n.created_at, left(n.content, 200),
         s.newer_fingerprint IS DISTINCT FROM content_fingerprint_of(n.content),
         -- ob1:a-quote-is-read-as-the-identity-reads-it — a CONTRACT SENTINEL:
         -- still in its text when the text holds it as 016's fold reads both,
         -- the fold of the part's identity (settled_parts_one_statement). A
         -- plain position() said a statement had left a text whose capitals
         -- alone had changed (151's review). The fold is read only where the
         -- row's own characters are not found: a CASE, which does not weigh
         -- its second arm when the first holds.
         CASE WHEN q.statement_at > 0 THEN true
              ELSE position(lower(btrim(regexp_replace(s.statement, '\s+', ' ', 'g'))) IN lower(regexp_replace(t.holder_text, '\s+', ' ', 'g'))) > 0 END,
         CASE WHEN q.statement_at > 0 THEN substr(t.holder_text, GREATEST(q.statement_at - v_context, 1), LEAST(v_context, q.statement_at - 1)) END,
         CASE WHEN q.statement_at > 0 THEN substr(t.holder_text, q.statement_at + char_length(s.statement), v_context) END,
         CASE WHEN q.shown_by_at > 0 THEN true
              ELSE position(lower(btrim(regexp_replace(s.shown_by, '\s+', ' ', 'g'))) IN lower(regexp_replace(t.other_text, '\s+', ' ', 'g'))) > 0 END,
         CASE WHEN q.shown_by_at > 0 THEN substr(t.other_text, GREATEST(q.shown_by_at - v_context, 1), LEAST(v_context, q.shown_by_at - 1)) END,
         CASE WHEN q.shown_by_at > 0 THEN substr(t.other_text, q.shown_by_at + char_length(s.shown_by), v_context) END,
         -- 029 holds one proposal a pair: the whole-thought proposal beside this part, if any.
         w.id, w.status, w.verdict, w.superseding_id,
         jsonb_build_array(s.judged_at::text, s.id::text)::text,
         g.remaining
    FROM page g
    JOIN settled_parts s ON s.id = g.id
    JOIN thoughts o ON o.id = s.older_id
    JOIN thoughts n ON n.id = s.newer_id
    LEFT JOIN supersession_proposals w ON w.older_id = s.older_id AND w.newer_id = s.newer_id
   CROSS JOIN LATERAL (SELECT CASE s.holder WHEN 'older' THEN o.content ELSE n.content END AS holder_text,
                              CASE s.holder WHEN 'older' THEN n.content ELSE o.content END AS other_text) t
   CROSS JOIN LATERAL (SELECT position(s.statement IN t.holder_text) AS statement_at,
                              position(s.shown_by IN t.other_text) AS shown_by_at) q
   ORDER BY g.judged_at, g.id;
END
$$;

COMMENT ON FUNCTION list_settled_parts(text, int, text, timestamptz, uuid, int) IS
  'The settled parts in one status (NULL for all), oldest judged first, at most 200 (156, SMD-4446): each part as its row holds it, with who decided it (reviewed_by, whether the decision named an agent, the kind recorded then and the registry''s now), and both thoughts as they are NOW: id, capture time, first 200 characters, and whether the text has moved since the part was judged. statement_in_text and shown_by_in_text say whether the holder''s text still holds the statement and the other thought''s the words that show it, read as a part''s identity reads a statement (case, runs of white space and white space at either end folded); where a text holds the row''s characters exactly, the _before and _after columns give up to p_context characters (120 by default, 0 to 500) either side of their first place in it, and are NULL otherwise. whole_id, whole_status, whole_verdict and whole_superseding_id are the whole-thought proposal on the same pair, if one stands (029 holds one a pair). p_judge_key NULL lists every pass, or the parts of the pass with exactly that judge_key. The after-cursor, p_after_judged_at and p_after_id, both set or neither (a partial one is refused), starts past that row on the listing''s order; each row''s page_key holds a JSON array of its two values as text for the next call, and remaining counts the selection''s rows from this page''s first on, so remaining > the rows returned means more follow. judged_at is when the write''s transaction began, not commit order: a row committed after a page was read, whose write began before it, is passed over by that walk. SECURITY INVOKER: it reads settled_parts, thoughts and supersession_proposals as the caller, and ob1_agents through ob1_registry_kind. Reads only. Migration 156 / SMD-4446.';
