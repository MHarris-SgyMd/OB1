-- =============================================================================
-- Migration 157: the settled parts that stand on a thought — settled_parts_on,
--                the accepted parts whose statement a thought still says, each
--                with the thought that shows it, and the index it reads
--                (SMD-4446 PR 3c)
-- =============================================================================
--
-- WHY
--   A reviewer's accept of a settled part (151) says a statement in one
--   thought no longer holds, or is done, while the thought stands. Nothing
--   that reads the thought says so: fetch and search give its text as if
--   every statement in it held. The listing (156) is a reviewer's queue, by
--   status and time; no read asks "which parts stand on these thoughts".
--
-- WHAT
--   1. settled_parts_accepted_holder_idx on (holder_id), for accepted rows
--      alone: a read asks by the thoughts it returns, a page of them at a
--      time, and only an accepted part shows. The decided rows only grow, so
--      the index holds the accepted ones and is read by holder. Measured on
--      30,000 parts over 3,000 thoughts of about 1,100 characters, 14,000 of
--      them accepted, four or five standing on each thought (medians of
--      seven): a page of ten thoughts took 1.4 ms through it and 4.1 ms
--      without, and a page of ten that hold none, which is most pages, 0.14 ms
--      against 2.8 ms, the whole table read each time. Two hundred thoughts
--      took 27 ms, and one, as fetch asks, 0.3 ms.
--   2. settled_parts_on(p_ids, p_per) returns, for each thought of p_ids that
--      holds one, the accepted parts that STAND on it, the first p_per of each
--      thought (3 by default, 1 to 50) with how many stand on it in all.
--      * A part stands on its holder while the holder's text still holds the
--        statement, read as a part's identity reads a statement: case, runs
--        of white space and white space at either end folded (016's fold,
--        which 151's one-statement index applies, as 156's listing reads a
--        quote). A statement edited out of its thought is on no read: the
--        thought no longer says it. The part's row stays, and the listing
--        shows it with its text marked as moved.
--      * Each row is the part's own words (the statement, the words that show
--        it, the writer's word and its group), the OTHER thought of the pair,
--        which holds those words (its id, which of the pair it is, capture
--        time, trust and first 200 characters), when the part was judged and
--        accepted, whether the holder's text has moved since the part was
--        judged, and whether the other thought's text still holds the words
--        that show it.
--      * Parts of one thought come in the order its text says them: `place`
--        is where the statement first begins in the text, from 1. Where the
--        text holds it only as the fold reads it, `place` is its place in the
--        folded text, which orders it among the others and is no offset into
--        the text as written. The row's own characters are looked for first:
--        a text that says a statement twice, once as written and once in
--        other capitals, places it where it is as written. Ties by the part's
--        id.
--      * `total` is how many accepted parts stand on that thought, so a
--        reader shown p_per knows how many more there are.
--      A pending, stale or rejected part is on no read: until a reviewer
--      accepts it, it is a proposal (docs/subject-anchored-claims.md, row 10).
--      Nothing here ranks, demotes or supersedes a thought (row 8).
--
-- WHO READS
--   No grant changes. The function is SECURITY INVOKER: it reads settled_parts
--   and thoughts as the caller. The server group (db/config.mjs) holds SELECT
--   on settled_parts since 151 and the capture group on thoughts. A role
--   without the first is refused (42501), and the servers' reads then carry no
--   part and say the parts were not read. EXECUTE on a new function is
--   PUBLIC's by default.
--
-- SAFETY
--   One index and one function. The index build reads every row of
--   settled_parts once under a SHARE lock on the table: a
--   record_settled_part that arrives meanwhile waits for it while holding the
--   supersession advisory lock, so a decision, a rebuild, a delete and a
--   forget wait with it for as long as the build takes (156's note; 151's
--   review measured that queue). The table holds tens of rows on the dogfood
--   brains, none of them accepted; a brain holding millions applies this file
--   in a quiet hour. Nothing else runs at apply time, and no row is written.
--   Nothing called the function before this file, so there is no older form
--   to drop. MINOR under MAINTAINING.md's versioning: a new function, and with
--   it a new field on a read. test-schema [142], test-upgrade [20ct].
--
-- Prerequisites
--   016 (content_fingerprint_of) and 151 (settled_parts). Applied by
--   `bun db/migrate.ts`. Re-applied, the index is kept and the function
--   replaced as it was.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not hold
-- (052's shape). plpgsql resolves what a body reads only at its first call, so
-- a missing table or column would otherwise make a read that fails when called
-- rather than a file refused here.
DO $qc$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(name, ', ' ORDER BY ord) INTO v_missing FROM (
    SELECT p.name, p.ord FROM (VALUES
        (1, 'content_fingerprint_of(text)', to_regprocedure('content_fingerprint_of(text)') IS NULL),
        (2, 'settled_parts', to_regclass('settled_parts') IS NULL)
      ) AS p(ord, name, missing)
     WHERE p.missing
    UNION ALL
    SELECT c.tbl || '.' || c.col, 10 + c.ord
      FROM (VALUES
        (1, 'settled_parts', 'holder'), (2, 'settled_parts', 'holder_id'), (3, 'settled_parts', 'word_group'),
        (4, 'settled_parts', 'older_fingerprint'), (5, 'settled_parts', 'newer_fingerprint'),
        (6, 'settled_parts', 'judged_at'), (7, 'settled_parts', 'reviewed_at'), (8, 'thoughts', 'metadata')
      ) AS c(ord, tbl, col)
     WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns i
                        WHERE i.table_schema = current_schema() AND i.table_name = c.tbl AND i.column_name = c.col)
  ) m;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 157 needs 016 and 151; this schema lacks ' || v_missing,
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. The read's index: the accepted parts, by the thought that holds the
--    statement
-- ---------------------------------------------------------------------------
-- holder_id is 151's generated column: the older or the newer thought, as the
-- row's holder says. Accepted rows alone: a read shows no other, and a queue
-- of pending parts is no part of what a page of thoughts asks.
CREATE INDEX IF NOT EXISTS settled_parts_accepted_holder_idx
  ON settled_parts (holder_id) WHERE status = 'accepted';

-- ---------------------------------------------------------------------------
-- 2. settled_parts_on — the accepted parts that stand on each of a set of
--    thoughts, in the order each thought's text says them
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION settled_parts_on(
  p_ids uuid[],
  p_per int DEFAULT 3
)
RETURNS TABLE (
  holder_id        uuid,
  id               uuid,
  statement        text,
  shown_by         text,
  word             text,
  word_group       text,
  other_is         text,
  other_id         uuid,
  other_created_at timestamptz,
  other_trust      text,
  other_head       text,
  judged_at        timestamptz,
  accepted_at      timestamptz,
  holder_edited    boolean,
  shown_by_in_text boolean,
  place            int,
  total            int
)
LANGUAGE plpgsql
STABLE
AS $$
-- The OUT columns share names with settled_parts' own (id, statement, word, …):
-- a bare name in the query below is the table's column, never the OUT variable.
#variable_conflict use_column
DECLARE
  v_per int := LEAST(GREATEST(COALESCE(p_per, 3), 1), 50);
BEGIN
  RETURN QUERY
  -- ob1:parts-on-a-thought — a CONTRACT SENTINEL, not prose (the 014
  -- convention), read by db/test-schema.ts. The accepted parts whose holder is
  -- asked for, through this file's index: a read asks by the page of thoughts
  -- it returns, and the decided rows of the table only grow.
  WITH mine AS MATERIALIZED (
    SELECT s.id, s.holder_id, s.holder, s.older_id, s.newer_id, s.statement, s.shown_by, s.word, s.word_group,
           s.older_fingerprint, s.newer_fingerprint, s.judged_at, s.reviewed_at
      FROM settled_parts s
     WHERE s.status = 'accepted' AND s.holder_id = ANY(p_ids)
  ),
  -- Each with its two texts as they are now: the holder's, which holds the
  -- statement, and the other thought's, which holds the words that show it.
  -- Both thoughts are foreign keys that cascade, so no join drops a part.
  texts AS (
    SELECT m.*, h.content AS holder_text, x.id AS other_id, x.created_at AS other_created_at,
           x.metadata->>'trust' AS other_trust, x.content AS other_text,
           position(m.statement IN h.content) AS exact_at
      FROM mine m
      JOIN thoughts h ON h.id = m.holder_id
      JOIN thoughts x ON x.id = CASE m.holder WHEN 'older' THEN m.newer_id ELSE m.older_id END
  ),
  -- ob1:a-part-shows-while-its-thought-says-it — a CONTRACT SENTINEL: a part
  -- stands on its holder while the holder's text holds the statement as
  -- 016's fold reads both, the fold of the part's identity
  -- (settled_parts_one_statement) and of 156's listing. A statement edited
  -- out is on no read; one whose capitals or spacing alone changed still is.
  -- The fold is read only where the row's own characters are not found: a
  -- CASE, which does not weigh its second arm when the first holds.
  placed AS (
    SELECT t.*,
           CASE WHEN t.exact_at > 0 THEN t.exact_at
                ELSE position(lower(btrim(regexp_replace(t.statement, '\s+', ' ', 'g'))) IN lower(regexp_replace(t.holder_text, '\s+', ' ', 'g'))) END AS place
      FROM texts t
  ),
  standing AS (
    SELECT p.*,
           row_number() OVER (PARTITION BY p.holder_id ORDER BY p.place, p.id) AS nth,
           count(*) OVER (PARTITION BY p.holder_id) AS total
      FROM placed p
     WHERE p.place > 0
  )
  SELECT g.holder_id, g.id, g.statement, g.shown_by, g.word, g.word_group,
         CASE g.holder WHEN 'older' THEN 'newer' ELSE 'older' END,
         g.other_id, g.other_created_at, g.other_trust, left(g.other_text, 200),
         g.judged_at, g.reviewed_at,
         (CASE g.holder WHEN 'older' THEN g.older_fingerprint ELSE g.newer_fingerprint END) IS DISTINCT FROM content_fingerprint_of(g.holder_text),
         CASE WHEN position(g.shown_by IN g.other_text) > 0 THEN true
              ELSE position(lower(btrim(regexp_replace(g.shown_by, '\s+', ' ', 'g'))) IN lower(regexp_replace(g.other_text, '\s+', ' ', 'g'))) > 0 END,
         g.place, g.total::int
    FROM standing g
   WHERE g.nth <= v_per
   ORDER BY g.holder_id, g.place, g.id;
END
$$;

COMMENT ON FUNCTION settled_parts_on(uuid[], int) IS
  'The accepted settled parts that stand on each thought of p_ids, the first p_per of each (3 by default, 1 to 50) in the order its text says them (157, SMD-4446). A part stands on its holder, the thought that holds the statement, while that text still holds the statement, read as a part''s identity reads one (case, runs of white space and white space at either end folded); a statement edited out of its thought is on no read, and a pending, stale or rejected part never is. Each row: the holder, the part''s id, the statement, the words that show it, the writer''s word and its group; the other thought of the pair, which holds those words (other_is older or newer, its id, capture time, metadata trust and first 200 characters); when the part was judged and when accepted; holder_edited, whether the holder''s text has moved since the part was judged; shown_by_in_text, whether the other thought''s text still holds the words that show it; place, where the statement first begins in the holder''s text from 1 (in the folded text where only the fold finds it: an order, not an offset); and total, how many accepted parts stand on that thought. Thoughts with none return no row. It ranks, demotes and supersedes nothing. SECURITY INVOKER: it reads settled_parts and thoughts as the caller. Reads only. Migration 157 / SMD-4446.';
