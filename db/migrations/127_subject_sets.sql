-- =============================================================================
-- Migration 127: a thought's own subjects are a set — one standing subject
--                per key, at most three, written and closed as a set, so a
--                thought stands in each of its subjects' threads
--                (SMD-3306 PR 7a-3a)
-- =============================================================================
--
-- WHY
--   111 kept one standing subject per thought, so a thought stood in one work
--   thread (120). Blind raters split on the multi-ticket sessions, 7 of 275
--   canary thoughts drawn (SMD-3306's measure, 2026-10-24): such a session is
--   a segment of each ticket's work. The maintainer chose (2026-11-05) that a
--   thought's own subject can be a set, so such a session stands in each of
--   its tickets' threads; and (2026-11-09) that a set is one rule's — the
--   rule that found it, or the judge model, never a mix — of at most three
--   keys, and that this PR is the database side alone: the rules and the
--   judge's question that find sets follow (PR 7a-3b).
--
-- WHAT
--   * One standing subject per thought AND KEY: 111's partial unique index on
--     the thought alone is replaced by one on the thought and its key. Closed
--     rows are history, as before.
--   * Statistics on a facet's key (thought_facets_key_stats), gathered at
--     once: the planner read a thread's rows as 0.5% of the table, and so
--     scanned every thought to read a thread (120's re-link and the lock
--     below alike).
--   * ob1_thread_lock_keys(keys) — each key's thread lock (120's
--     ob1:thread:<key>), taken in key order, so writers that move thoughts
--     across the same keys queue rather than deadlock, as db/threads.ts's
--     batches and 120's replace already lock theirs.
--   * record_thought_subjects(thought, keys, by, judge_key, agent,
--     fingerprint, recipe) — the door for a set: the standing subjects made
--     to be exactly these keys, found this way by this pass. A standing
--     subject under one of the keys, found the same way by the same pass, is
--     kept (its lineage moved to the text read now); every other standing
--     subject is closed; each key not kept is written, with its lineage, in
--     the same transaction. NULL or an empty set closes every standing
--     subject. One `by` and one judge key for the set (one rule's); at most
--     three distinct keys (a repeated key counts once); `metadata` names one
--     key, the ticket the thought is filed under. Refused as stale, writing
--     nothing, as 113's door refuses: a text that moved since the pass read
--     it, or a filed ticket that disagrees (metadata's key under another
--     ticket than it is filed under now, or any other way's set on a thought
--     filed since). Under the door's advisory lock on the thought, the thought
--     locked FOR KEY SHARE first (111's order); it closes before it writes,
--     the writes in key order, and its threads re-link at its commit (120's
--     triggers, below).
--   * record_thought_subject — 113's door, its signature and refusals kept,
--     now the set door with one key (or NULL, closing every standing
--     subject). Its answer keeps 113's shape: `id` is the one standing
--     subject written or kept, or the one closed.
--   * close_thought_subjects(thought, facets, fingerprint) — closes the
--     thought's standing subjects only while they are exactly the facets the
--     caller read and the text is still the one read; otherwise it answers
--     what it found and writes nothing. close_thought_subject — 113's close,
--     its signature and refusals kept — is it with one facet: a thought
--     standing in a second subject since the read answers `moved`.
--   * ob1_thread_relink_subject — 120's trigger function, its locks taken
--     for a set: a subject written or closed locks, before its re-link, every
--     subject key the transaction wrote or closed on the thought, in key order
--     (ob1_thread_lock_keys over the thought's subject rows the transaction
--     made: xmin its own). 120 locked a close's key and "the" thought's
--     standing key, of which a set has several: a replace of two keys locking
--     the second's as its re-link came, after a later key, could deadlock with
--     a writer taking both in order, and a subject kept standing beside the
--     replace is no part of it. With them it locks (KEY SHARE, in id order)
--     the thought and its neighbours in every key moved, the thoughts the
--     re-links' edges join: one neighbour may stand in two of the keys, and
--     a delete of it, waiting on an edge the first key's re-link closed,
--     deadlocked with the second's waiting on it to write the edge again
--     (review pass 1); locked first, the delete waits for the commit, 120's
--     write-before-close carried across the keys. All this once a
--     transaction, thought and set of keys moved (one local setting,
--     ob1.thread_mark, marks them), the rest finding the locks held, so a
--     door's set, written or closed in any order, a raw writer's included,
--     queues behind another on the same keys. Its timing is 120's: from the
--     commit's first re-link to the commit. Above READ COMMITTED the
--     re-link's refusal comes first, before any lock.
--   * Comments restated: thought_facets' (one standing per key; a set of at
--     most three, one rule's, through record_thought_subjects), the trigger
--     function's and the two doors'.
--   * Grants: none issued. The doors are 111's and 113's, SECURITY INVOKER,
--     needing what they needed: INSERT on thought_facets (the structure
--     group), UPDATE on it and on thoughts (the row locks) and the writes on
--     derivations (the capture group).
--
--   ob1:subject-set — a CONTRACT SENTINEL, not prose (the 014 convention).
--
-- WHO READS
--   Every reader of a thread reads subjects by key already: a thread (120's
--   thread_relink, db/threads.ts, the census of brain_info and preflight) is
--   one key's thoughts, and the thread read and fetch's continues read each
--   standing key of a thought (PR 7a-2a). Two readers of a thought's own
--   subject read one row, below (NOT HERE). brain_info's and --status's
--   thought count is a count of thread places: a thought in two threads
--   counts in each, as each thread wants an edge to it.
--
-- NOT HERE
--   * What finds a set (PR 7a-3b): the session-header rule keying each ticket
--     a session's prompts name, the judge's question in a version 3 asking
--     for up to three subjects, the new pool key, and the subject sweep and
--     the extraction pass writing sets through this door. Until then every
--     writer of the stack writes one key, so no thought holds a set.
--   * The sweep reads a thought's standing subject as one row
--     (db/subject-sweep.ts), which PR 7a-3b changes before anything writes a
--     set. On a set its candidate read returns a row a subject (a dry run
--     counting the thought once for each), its rules write one key, and a
--     non-current set the model names nothing for is never closed:
--     close_thought_subject, given one facet of it, answers moved and closes
--     none, the claim goes back to pending, and the same run claims and asks
--     it again at once — without end under --judge-checked, else until the
--     garbage-judge alarm trips on the run of answers naming nothing, blaming
--     the model and holding the pool (review pass 3).
--   * ob1_item_serves (122) reads one ticket subject of a thought (LIMIT 1);
--     with a set it serves one of them. SMD-4149's 125 redefines it: the set
--     reading follows that.
--   * A transaction that writes the subjects of several thoughts locks each
--     thought's keys as its first re-link comes, so it can deadlock beside a
--     writer taking the same keys in order, Postgres ending one (120's NOT
--     HERE). One that writes inside a savepoint (its rows' xmin a
--     subtransaction's, which the trigger does not read as its own) locks
--     120's set instead, the thought's standing keys and the one re-linked,
--     at each re-link: a replace of one key queues as under 120, but a set's
--     keys closed in a savepoint, each locked as its re-link comes, can
--     deadlock the same way. No writer of the stack does either: each writes
--     one thought's subjects a transaction, outside any savepoint. The first
--     of several thoughts locks its own neighbours alone, so a delete of a
--     later thought's neighbour can deadlock with the commit too.
--   * An edge a moved key's thread lacks away from the moved thought (a
--     thread the upgrade to 120 left unlinked, or a gap a delete left) joins
--     thoughts the neighbour locks do not cover: a delete of one of them,
--     waiting on an edge an earlier key's re-link closed, can still deadlock
--     with the commit, Postgres ending one. db/threads.ts links such gaps.
--     So can a raw write of the moved thought's created_at in the same
--     transaction (120's NOT HERE: no writer of the stack moves one): the
--     neighbours are read at its new place, its old ones' bridge unlocked.
--
-- SAFETY
--   One index made and 111's dropped (by name: the new one stands first, so
--   at no point does the table hold no rule); a statistics object made and
--   thought_facets analysed (a sample of its rows); three functions added,
--   three redefined (113's two doors, now wrappers keeping their signatures,
--   refusals and answers' shape; 120's trigger function, its locks taken for
--   a set); four comments restated. No row changes: a brain holds at most
--   one standing subject per thought, which the new index admits. Making the
--   index scans all of thought_facets (every kind, closed rows too) under
--   the migrator's lock on it (SHARE: facet writes wait it out) — a moment
--   on a brain of thousands of facets, longer on one of millions. Dropping
--   111's index then holds thought_facets ACCESS EXCLUSIVE until the
--   migrator commits, reads waiting too, for the functions after it.
--
-- Prerequisites
--   111 (record_thought_subject), 113 (close_thought_subject,
--   ob1_filed_ticket), 120 (thread_relink). Applied by `bun db/migrate.ts`.
--   Idempotent: CREATE OR REPLACE, the index IF NOT EXISTS, 111's dropped IF
--   EXISTS. A re-apply of 111 makes its index again: on a brain where no
--   thought holds a set it is built, refusing a second subject on a thought
--   until this file runs again (--reapply runs both, in order); where one
--   does, its build fails and so does a --reapply, rolled back whole. (A
--   --reapply already fails at 064 on any brain holding a subject: 064's
--   derivations CHECK lacks the kind, SMD-3149.)
-- =============================================================================

DO $qc$
DECLARE
  v_missing text;
BEGIN
  -- The first prerequisite missing, in file order, named.
  v_missing := CASE
    WHEN to_regprocedure('record_thought_subject(uuid, text, text, text, uuid, text, jsonb)') IS NULL THEN '111 (record_thought_subject)'
    WHEN to_regprocedure('close_thought_subject(uuid, uuid, text)') IS NULL THEN '113 (close_thought_subject)'
    WHEN to_regprocedure('ob1_filed_ticket(jsonb)') IS NULL THEN '113 (ob1_filed_ticket)'
    WHEN to_regprocedure('thread_relink(text, boolean)') IS NULL THEN '120 (thread_relink)'
  END;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format('migration 127 needs %s; this schema lacks it', v_missing),
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url ... --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. One standing subject per thought and key
-- ---------------------------------------------------------------------------
-- The new rule stands before 111's goes, so the table is never without one.
CREATE UNIQUE INDEX IF NOT EXISTS thought_facets_subject_key_uniq
  ON thought_facets (thought_id, (payload->>'key'))
  WHERE kind = 'subject' AND valid_until IS NULL;
DROP INDEX IF EXISTS thought_facets_subject_active_uniq;

-- How many rows a key holds, which no partial index's expression tells the
-- planner: guessing 0.5% of thought_facets a key, it scanned every thought to
-- read a thread of four (review pass 3: some 350 ms a subject's commit at a
-- million thoughts, in 120's thread reads and this file's lock alike; 3 ms with
-- these). Gathered now, then by autovacuum's analyze as facets change.
CREATE STATISTICS IF NOT EXISTS thought_facets_key_stats ON ((payload->>'key')) FROM thought_facets;
ANALYZE thought_facets;

-- ---------------------------------------------------------------------------
-- 2. ob1_thread_lock_keys — the threads' locks, in key order
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_thread_lock_keys(p_keys text[])
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_key text;
BEGIN
  -- The order is the database's default collation's, as 120's least() and
  -- greatest() and db/threads.ts's ORDER BY key take it. A lock this
  -- transaction holds already is taken again at once.
  FOR v_key IN SELECT DISTINCT k FROM unnest(p_keys) AS k WHERE k IS NOT NULL ORDER BY k LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('ob1:thread:' || v_key, 0));
  END LOOP;
END;
$$;

COMMENT ON FUNCTION ob1_thread_lock_keys(text[]) IS
  'Takes each key''s work-thread lock (120''s advisory lock ob1:thread:<key>, held to the transaction''s end), the distinct keys in key order (the default collation''s, as 120''s replace and db/threads.ts''s batches order theirs), NULLs passed over: writers that move thoughts across the same keys then queue rather than deadlock. 120''s trigger function calls it, since 127, with every subject key a transaction wrote or closed on a thought, before the first re-link at its commit. Migration 127 / SMD-3306.';

-- ---------------------------------------------------------------------------
-- 3. record_thought_subjects — the door for a set
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_thought_subjects(
  p_thought   uuid,
  p_keys      text[],
  p_by        text,
  p_judge_key text,
  p_agent     uuid,
  p_fp        text,
  p_recipe    jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  -- ob1:subject-set — a CONTRACT SENTINEL, not prose: at most three keys a
  -- set (the maintainer, 2026-11-09: the capture hook's header lists three
  -- tickets at most, and the judge's question asks for three at most).
  c_max    constant integer := 3;
  v_keys   text[];
  v_fp     text;
  v_filed  text;
  v_stood  integer;
  v_kept   uuid[] := '{}';
  v_keptk  text[] := '{}';
  v_close  uuid[] := '{}';
  v_add    text[];
  v_id     uuid;
  v_key    text;
  v_ids    uuid[];
  r        record;
BEGIN
  IF p_thought IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'record_thought_subjects: a thought is required', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_judge_key IS NULL OR btrim(p_judge_key) = '' OR length(p_judge_key) > 200 THEN
    -- 111's bounds, refused as parameter errors: a check violation would read
    -- to the pass as the thought deleted mid-write (084's way).
    RAISE EXCEPTION USING MESSAGE = 'record_thought_subjects: judge_key must name the pass, in at most 200 characters', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF array_ndims(p_keys) > 1 THEN
    RAISE EXCEPTION USING MESSAGE = 'record_thought_subjects: the set is a one-dimensional array of keys', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF array_position(p_keys, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'record_thought_subjects: a key in the set is NULL (an empty set, or NULL, closes every standing subject)', ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The set: each key once, in key order.
  SELECT COALESCE(array_agg(DISTINCT k ORDER BY k), '{}') INTO v_keys FROM unnest(p_keys) AS k;
  SELECT k INTO v_key FROM unnest(v_keys) AS k WHERE NOT subject_key_valid(k) LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      MESSAGE = format('record_thought_subjects: each key is ticket:<ID>, pr:<number>, version:<v1.2.3> or phrase:<lower-case words>, got %L', left(v_key, 80)),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF cardinality(v_keys) > c_max THEN
    RAISE EXCEPTION USING
      MESSAGE = format('record_thought_subjects: a thought holds at most %s subjects, got %s keys', c_max, cardinality(v_keys)),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF cardinality(v_keys) > 0 AND (p_by IS NULL OR p_by NOT IN ('metadata', 'first_line', 'model')) THEN
    RAISE EXCEPTION USING
      MESSAGE = format('record_thought_subjects: by is metadata, first_line or model, got %L', p_by),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_by = 'metadata' AND cardinality(v_keys) > 1 THEN
    RAISE EXCEPTION USING
      MESSAGE = format('record_thought_subjects: by metadata is one key, the ticket the thought is filed under, got %s keys', cardinality(v_keys)),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF cardinality(v_keys) > 0 AND (p_fp IS NULL OR btrim(p_fp) = '') THEN
    RAISE EXCEPTION USING MESSAGE = 'record_thought_subjects: the fingerprint of the text the subjects were found in is required', ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 111's lock and order: one writer of a thought's subjects at a time, the
  -- thought locked FOR KEY SHARE before its facet rows. A thought gone
  -- answers none.
  PERFORM pg_advisory_xact_lock(hashtextextended('ob1:subject:' || p_thought::text, 0));
  SELECT COALESCE(t.content_fingerprint, content_fingerprint_of(t.content)), ob1_filed_ticket(t.metadata) INTO v_fp, v_filed
    FROM thoughts t WHERE t.id = p_thought FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none', 'gone', true);
  END IF;
  -- 111's and 113's staleness: a text that moved since the pass read it, or
  -- a filed ticket that disagrees — metadata's key under another ticket than
  -- the thought is filed under now, or another way's set on a thought filed
  -- since. Nothing is written; the edit put the thought back in the pool.
  IF cardinality(v_keys) > 0 AND (p_fp IS DISTINCT FROM v_fp
       OR CASE WHEN p_by = 'metadata' THEN v_keys[1] IS DISTINCT FROM 'ticket:' || v_filed ELSE v_filed IS NOT NULL END) THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none', 'stale', true);
  END IF;

  -- The standing subjects, each kept (under a key of the set, found the same
  -- way by the same pass) or closed.
  v_stood := 0;
  FOR r IN
    SELECT f.id, f.payload->>'key' AS key, f.payload->>'by' AS way, f.payload->>'judge_key' AS judge
      FROM thought_facets f
     WHERE f.thought_id = p_thought AND f.kind = 'subject' AND f.valid_until IS NULL
     ORDER BY f.payload->>'key', f.id
       FOR UPDATE
  LOOP
    v_stood := v_stood + 1;
    IF r.key = ANY (v_keys) AND r.way = p_by AND r.judge = p_judge_key AND NOT r.key = ANY (v_keptk) THEN
      v_kept := v_kept || r.id;
      v_keptk := v_keptk || r.key;
    ELSE
      v_close := v_close || r.id;
    END IF;
  END LOOP;
  SELECT COALESCE(array_agg(k ORDER BY k), '{}') INTO v_add FROM unnest(v_keys) AS k WHERE NOT k = ANY (v_keptk);

  IF v_stood = 0 AND cardinality(v_keys) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none', 'ids', '[]'::jsonb, 'kept', 0, 'added', 0, 'closed', 0);
  END IF;

  -- The closes, then the writes in key order; the threads re-link at the
  -- commit, the first re-link locking every key moved (120's triggers).
  IF cardinality(v_close) > 0 THEN
    UPDATE thought_facets SET valid_until = now() WHERE id = ANY (v_close);
  END IF;
  -- Kept: the facet stands, its lineage moved to the text read now.
  FOREACH v_id IN ARRAY v_kept LOOP
    PERFORM ob1_record_derivation('subject', v_id, ARRAY[p_thought], ARRAY[p_fp], p_judge_key,
                                  COALESCE(p_recipe, jsonb_build_object('deterministic', p_by <> 'model', 'declared', false)), p_agent);
  END LOOP;
  FOREACH v_key IN ARRAY v_add LOOP
    INSERT INTO thought_facets (thought_id, kind, payload)
    VALUES (p_thought, 'subject', jsonb_build_object('key', v_key, 'by', p_by, 'judge_key', p_judge_key))
    RETURNING id INTO v_id;
    -- ob1:subject-lineage-with-its-artifact (111's): each facet and its
    -- lineage are one transaction (061's rule).
    PERFORM ob1_record_derivation('subject', v_id, ARRAY[p_thought], ARRAY[p_fp], p_judge_key,
                                  COALESCE(p_recipe, jsonb_build_object('deterministic', p_by <> 'model', 'declared', false)), p_agent);
  END LOOP;

  SELECT COALESCE(array_agg(f.id ORDER BY f.payload->>'key'), '{}') INTO v_ids
    FROM thought_facets f
   WHERE f.thought_id = p_thought AND f.kind = 'subject' AND f.valid_until IS NULL;
  RETURN jsonb_build_object(
    'ok', true,
    -- What moved: written alone (added), closed alone (closed), both
    -- (replaced), neither (kept).
    'action', CASE WHEN cardinality(v_close) = 0 AND cardinality(v_add) = 0 THEN 'kept'
                   WHEN cardinality(v_close) = 0 THEN 'added'
                   WHEN cardinality(v_add) = 0 THEN 'closed'
                   ELSE 'replaced' END,
    'ids', to_jsonb(v_ids),
    'kept', cardinality(v_kept), 'added', cardinality(v_add), 'closed', cardinality(v_close),
    'closedIds', to_jsonb(v_close));
END;
$$;

COMMENT ON FUNCTION record_thought_subjects(uuid, text[], text, text, uuid, text, jsonb) IS
  'The subject pass''s write of one thought''s own subjects as a set (SMD-3306 PR 7a-3a): the standing `subject` facets made to be exactly these keys (each once; at most three, ob1:subject-set), found one way (`by`) by one pass (judge_key). A standing subject under a key of the set, found the same way by the same pass, is kept (its lineage row moved to the fingerprint read now); every other standing subject is closed (valid_until); each key not kept is written, with its lineage row (artifact_kind subject, its thought at the fingerprint read, produced_by the pass''s key; the recipe the caller''s, else deterministic unless the model found it) in the same transaction. NULL or an empty set closes every standing subject. `metadata` names one key. Refused, writing nothing (action none, stale), when the thought''s fingerprint is not the one the pass read, or the ticket it is filed under (ob1_filed_ticket) disagrees: metadata''s key under another ticket than it is filed under now, or any other way''s set on a thought filed since. Under the advisory lock on the thought (111''s), the thought locked FOR KEY SHARE first; the threads of the keys it moves re-link at the commit (120''s triggers, which lock them all in key order). Returns {ok, action, ids (the standing facets after, by key), kept, added, closed, closedIds (on a write), stale?, gone?}: action added when it wrote and closed nothing, closed when it closed and wrote nothing, replaced when it did both, kept when it did neither, none when nothing stood and nothing was asked, or on a refusal. SECURITY INVOKER: the caller needs INSERT on thought_facets (the structure group), UPDATE on it and on thoughts (the row locks) and the writes on derivations (the capture group), and since 120 what a re-link writes, as record_thought_subject. Migration 127 / SMD-3306.';

-- ---------------------------------------------------------------------------
-- 4. record_thought_subject — 113's door, now a set of one
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_thought_subject(
  p_thought   uuid,
  p_key       text,
  p_by        text,
  p_judge_key text,
  p_agent     uuid,
  p_fp        text,
  p_recipe    jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_r jsonb;
BEGIN
  -- 113's refusals, word for word, before the set door's.
  IF p_thought IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'record_thought_subject: a thought is required', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_judge_key IS NULL OR btrim(p_judge_key) = '' OR length(p_judge_key) > 200 THEN
    RAISE EXCEPTION USING MESSAGE = 'record_thought_subject: judge_key must name the pass, in at most 200 characters', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_key IS NOT NULL AND NOT subject_key_valid(p_key) THEN
    RAISE EXCEPTION USING
      MESSAGE = format('record_thought_subject: the key is ticket:<ID>, pr:<number>, version:<v1.2.3> or phrase:<lower-case words>, or NULL (close), got %L', left(p_key, 80)),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_key IS NOT NULL AND (p_by IS NULL OR p_by NOT IN ('metadata', 'first_line', 'model')) THEN
    RAISE EXCEPTION USING
      MESSAGE = format('record_thought_subject: by is metadata, first_line or model, got %L', p_by),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_key IS NOT NULL AND (p_fp IS NULL OR btrim(p_fp) = '') THEN
    RAISE EXCEPTION USING MESSAGE = 'record_thought_subject: the fingerprint of the text the subject was found in is required', ERRCODE = 'invalid_parameter_value';
  END IF;

  v_r := record_thought_subjects(p_thought, CASE WHEN p_key IS NULL THEN NULL ELSE ARRAY[p_key] END, p_by, p_judge_key, p_agent, p_fp, p_recipe);
  -- 113's answer: the one subject written or kept, or with a NULL key the one
  -- closed (the first by key, should a set have stood). A set narrowed to its
  -- one key replaced it, in 113's words: anything but the same key, way and
  -- pass standing alone replaces.
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'action', CASE WHEN p_key IS NOT NULL AND v_r->>'action' = 'closed' THEN 'replaced' ELSE v_r->>'action' END,
    'id', CASE WHEN p_key IS NULL THEN v_r->'closedIds'->0 ELSE v_r->'ids'->0 END,
    'stale', v_r->'stale', 'gone', v_r->'gone'));
END;
$$;

COMMENT ON FUNCTION record_thought_subject(uuid, text, text, text, uuid, text, jsonb) IS
  'The subject pass''s write of one thought''s own subject (SMD-3306): since 127, record_thought_subjects with a set of one key — a NULL key closes every standing subject — its refusals and answer 113''s. Refused (action none, stale) when the thought''s fingerprint is not the one the pass read, or the ticket it is filed under (ob1_filed_ticket) disagrees with it: the metadata rule''s subject under another ticket than it is filed under now, or none, or a session header''s or a model''s on a thought filed since. The same key, found the same way by the same pass, is kept (its lineage row moved to the fingerprint read now); anything else replaces it (the old facets closed with valid_until, a new one inserted — a subject is never edited), with its lineage row in the same transaction (ob1:subject-lineage-with-its-artifact); a thought gone answers none. Returns {ok, action: added | kept | replaced | closed | none, id, stale?, gone?}: id the one subject standing after, or the one closed (the first by key, had a set stood). SECURITY INVOKER: the caller needs INSERT on thought_facets (the structure group), UPDATE on it and on thoughts (the row locks) and the writes on derivations (the capture group). Migrations 111, 113, 127 / SMD-3306.';

-- ---------------------------------------------------------------------------
-- 5. close_thought_subjects — close the set read, and no other
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION close_thought_subjects(
  p_thought uuid,
  p_facets  uuid[],
  p_fp      text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_fp    text;
  v_ids   uuid[];
  v_read  uuid[];
BEGIN
  IF p_thought IS NULL OR p_facets IS NULL OR cardinality(p_facets) = 0 OR array_ndims(p_facets) > 1 OR array_position(p_facets, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'close_thought_subjects: a thought and the subject facets read are required', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_fp IS NULL OR btrim(p_fp) = '' THEN
    RAISE EXCEPTION USING MESSAGE = 'close_thought_subjects: the fingerprint of the text read is required', ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The door's lock and order (111): one writer per thought at a time, the
  -- thought locked FOR KEY SHARE before its facet rows.
  PERFORM pg_advisory_xact_lock(hashtextextended('ob1:subject:' || p_thought::text, 0));
  SELECT COALESCE(t.content_fingerprint, content_fingerprint_of(t.content)) INTO v_fp
    FROM thoughts t WHERE t.id = p_thought FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none', 'gone', true);
  END IF;
  -- The text moved since it was read: what was asked of it says nothing of
  -- the text now, which the pool's trigger has put back in the pool.
  IF p_fp IS DISTINCT FROM v_fp THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none', 'stale', true);
  END IF;

  SELECT COALESCE(array_agg(id ORDER BY key, id), '{}') INTO v_ids
    FROM (SELECT f.id, f.payload->>'key' AS key
            FROM thought_facets f
           WHERE f.thought_id = p_thought AND f.kind = 'subject' AND f.valid_until IS NULL
             FOR UPDATE) s;
  IF cardinality(v_ids) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none');
  END IF;
  -- Another set stands now, written since the read (a pass's rule): not the
  -- one the caller means to close.
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}') INTO v_read FROM unnest(p_facets) AS x;
  IF (SELECT array_agg(x ORDER BY x) FROM unnest(v_ids) AS x) IS DISTINCT FROM v_read THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none', 'moved', true, 'ids', to_jsonb(v_ids));
  END IF;
  UPDATE thought_facets SET valid_until = now() WHERE id = ANY (v_ids);
  RETURN jsonb_build_object('ok', true, 'action', 'closed', 'ids', to_jsonb(v_ids));
END;
$$;

COMMENT ON FUNCTION close_thought_subjects(uuid, uuid[], text) IS
  'Closes a thought''s standing subjects only while they are exactly the facets the caller read (as a set) and the thought''s text still has the fingerprint read (SMD-3306 PR 7a-3a): the subject sweep''s close of out-of-date subjects the model now names nothing for. Under record_thought_subjects''s advisory lock, the thought locked FOR KEY SHARE first; the closed keys'' threads re-link at the commit (120''s triggers, which lock them all in key order). Returns {ok, action: closed | none, ids?, gone?, stale?, moved?}: none with gone for a thought deleted, with stale for a text that moved, with moved (and the standing ids, by key) when another set stands, and alone when none does. SECURITY INVOKER: the caller needs UPDATE on thought_facets and on thoughts (the row locks), and what a re-link writes (120): INSERT on thought_facets (the structure group) and INSERT, UPDATE and SELECT on derivations (the capture group). Migration 127 / SMD-3306.';

CREATE OR REPLACE FUNCTION close_thought_subject(
  p_thought uuid,
  p_facet   uuid,
  p_fp      text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_r jsonb;
BEGIN
  -- 113's refusals, word for word.
  IF p_thought IS NULL OR p_facet IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'close_thought_subject: a thought and the subject facet read are required', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_fp IS NULL OR btrim(p_fp) = '' THEN
    RAISE EXCEPTION USING MESSAGE = 'close_thought_subject: the fingerprint of the text read is required', ERRCODE = 'invalid_parameter_value';
  END IF;
  v_r := close_thought_subjects(p_thought, ARRAY[p_facet], p_fp);
  -- 113's answer: `id` the one closed, or when another stands the one standing
  -- in its place (the first by key other than the facet passed: on a set the
  -- facet passed may stand beside others).
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', true, 'action', v_r->>'action',
    'id', CASE WHEN v_r ? 'moved'
               THEN (SELECT to_jsonb(x) FROM jsonb_array_elements_text(v_r->'ids') WITH ORDINALITY AS e(x, n) WHERE x::uuid <> p_facet ORDER BY n LIMIT 1)
               ELSE v_r->'ids'->0 END,
    'gone', v_r->'gone', 'stale', v_r->'stale', 'moved', v_r->'moved'));
END;
$$;

COMMENT ON FUNCTION close_thought_subject(uuid, uuid, text) IS
  'Closes a thought''s standing subject only when it is still the facet the caller read, standing alone, and the thought''s text still has the fingerprint read (113, SMD-3306): since 127, close_thought_subjects with one facet. Returns {ok, action: closed | none, id?, gone?, stale?, moved?}: none with gone for a thought deleted, with stale for a text that moved, with moved (and the id of a subject standing in its place or beside it, the first by key other than the one passed) when another subject stands, and alone when none does. SECURITY INVOKER: the caller needs UPDATE on thought_facets and on thoughts (the row locks), as the door''s close does; since 120 a close re-links the subject''s thread (thought_facets_thread_closed), which needs INSERT on thought_facets (the structure group) and INSERT, UPDATE and SELECT on derivations (the capture group) too, as the door''s writes do. Migrations 113, 120, 127 / SMD-3306.';

-- ---------------------------------------------------------------------------
-- 6. The trigger that keeps the threads: the first re-link locks every key moved
-- ---------------------------------------------------------------------------
-- 120's body but the locks before a re-link of a subject written or closed.
CREATE OR REPLACE FUNCTION ob1_thread_relink_subject()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_thought uuid;
  v_key     text;
  v_moved   text[];
  v_mark    text;
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF TG_OP = 'INSERT' THEN
      v_thought := NEW.thought_id;
      v_key := NEW.payload->>'key';
    ELSE
      v_thought := OLD.thought_id;
      v_key := OLD.payload->>'key';
    END IF;
    -- thread_relink's refusal, said before any lock: a transaction above READ
    -- COMMITTED is refused at its commit whatever it waits on, so it waits on
    -- none (review pass 1: it waited out another writer's key first).
    IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
      PERFORM thread_relink(v_key);
    END IF;
    -- Before the first re-link, once a transaction and thought, the locks every
    -- re-link of its subjects may wait on. A replace closes subjects and writes
    -- others in one transaction, each re-linking its key at the commit in turn.
    --  * Its keys. Two writers moving thoughts across the same keys in
    --    opposite directions would each hold a key while they waited on the
    --    other's, so every subject key the transaction wrote or closed on the
    --    thought — its rows there of this transaction's making, closed or
    --    standing — is locked, in key order, as db/threads.ts's batches lock
    --    theirs: they queue. A subject that stood before the transaction, kept
    --    beside the replace, is no part of it: taken after a later key, its
    --    lock could deadlock with a writer that takes both in order.
    --  * Its neighbours. Each edge those re-links write joins the thought to
    --    its neighbour in a key it joined, or bridges its two neighbours in a
    --    key it left, and its two thoughts are locked (KEY SHARE) before the
    --    write (120). With a set, one neighbour can stand in two of the keys:
    --    the first key's re-link closing the thought's edge to it, a delete of
    --    it then waiting on that closed edge's row (084's close), and the
    --    second's waiting on the deleted row to write the edge again — a
    --    deadlock (review pass 1). So the thought and its neighbours in every
    --    key moved are locked first, in id order, before any re-link closes an
    --    edge: a delete of one waits for the commit, as 120's write-before-close
    --    makes it wait within one key.
    -- The thought and the keys moved mark the transaction (one local setting,
    -- ob1.thread_mark): the next re-link of its subjects finds them taken,
    -- unless a write since moved another key. One name, not one a thought: a
    -- name a thought left a placeholder for the session's life (review pass 2:
    -- 9 MB after 20,000 thoughts). A transaction writing several thoughts'
    -- subjects locks again at each change of thought, the locks held already.
    SELECT array_agg(s.payload->>'key') INTO v_moved
      FROM thought_facets s
     WHERE s.thought_id = v_thought AND s.kind = 'subject' AND s.xmin = pg_current_xact_id()::xid;
    -- None of the transaction's own: its subjects were written inside a
    -- savepoint, their xmin a subtransaction's. 120's set then, the thought's
    -- standing keys with this one, all taken at once in key order (review
    -- pass 3: locking each key as its re-link came, a replace in a savepoint
    -- deadlocked beside a writer moving a thought the other way, where 120's
    -- replace queued).
    IF v_moved IS NULL THEN
      SELECT array_agg(s.payload->>'key') INTO v_moved
        FROM thought_facets s
       WHERE s.thought_id = v_thought AND s.kind = 'subject' AND s.valid_until IS NULL;
    END IF;
    SELECT array_agg(DISTINCT k ORDER BY k) INTO v_moved FROM unnest(v_moved || v_key) AS k;
    v_mark := v_thought::text || ':' || v_moved::text;
    IF current_setting('ob1.thread_mark', true) IS DISTINCT FROM v_mark THEN
      PERFORM ob1_thread_lock_keys(v_moved);
      -- The thought itself in the IN list, not an OR beside it: an OR planned a
      -- scan of every thought on every commit (review pass 2: 85 ms at a
      -- million thoughts, 2 ms as one list probed by the key). Each member's
      -- created_at read by its key, not joined: misjudging a key's rows, the
      -- planner hash-joined a scan of every thought (review pass 3: 197 to
      -- 241 ms a set at a million thoughts).
      PERFORM 1 FROM thoughts t
       WHERE t.id IN (SELECT v_thought
                      UNION ALL
                      SELECT x
                        FROM (SELECT o.id, lag(o.id) OVER w AS prev, lead(o.id) OVER w AS next
                                FROM (SELECT s.payload->>'key' AS k, s.thought_id AS id,
                                             (SELECT h.created_at FROM thoughts h WHERE h.id = s.thought_id) AS created_at
                                        FROM thought_facets s
                                       WHERE s.kind = 'subject' AND s.valid_until IS NULL AND s.payload->>'key' = ANY (v_moved)
                                         AND s.thought_id <> v_thought
                                      UNION ALL
                                      SELECT k, v_thought, (SELECT h.created_at FROM thoughts h WHERE h.id = v_thought)
                                        FROM unnest(v_moved) AS k) o
                              WINDOW w AS (PARTITION BY o.k ORDER BY o.created_at, o.id)) around,
                             LATERAL (VALUES (around.prev), (around.next)) AS v(x)
                       WHERE around.id = v_thought AND x IS NOT NULL)
       ORDER BY t.id
         FOR KEY SHARE OF t;
      PERFORM set_config('ob1.thread_mark', v_mark, true);
    END IF;
    PERFORM thread_relink(v_key);
  -- A standing subject deleted with its thought: its edges are closed by 084's
  -- trigger and the cascade, and its neighbours linked here when the deleting
  -- role may make a re-link's writes, the transaction is READ COMMITTED (the
  -- re-link refuses any other) and the key's lock is free; otherwise at the
  -- key's next re-link (120's NOT HERE). A delete never waits on the key's
  -- lock: a re-link holding it may be waiting on the deleted thought's row.
  ELSIF has_any_column_privilege('thought_facets', 'INSERT') AND has_any_column_privilege('thought_facets', 'UPDATE')
        AND has_any_column_privilege('thoughts', 'UPDATE')
        AND has_any_column_privilege('derivations', 'INSERT') AND has_any_column_privilege('derivations', 'UPDATE')
        AND has_table_privilege('derivations', 'SELECT')
        AND current_setting('transaction_isolation') IN ('read committed', 'read uncommitted') THEN
    IF pg_try_advisory_xact_lock(hashtextextended('ob1:thread:' || (OLD.payload->>'key'), 0)) THEN
      PERFORM thread_relink(OLD.payload->>'key');
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION ob1_thread_relink_subject() IS
  'Constraint triggers AFTER INSERT, AFTER UPDATE OF valid_until and AFTER DELETE on thought_facets for a subject (thought_facets_thread_written, _closed and _deleted, 120), deferred to the writer''s commit: re-links the subject''s key''s thread (thread_relink) once the transaction''s subjects are final, so a replace (a close and an insert on one key) moves no edge. A subject written or closed locks, before its re-link, every subject key the same transaction wrote or closed on the thought, in key order (ob1_thread_lock_keys over the thought''s subject rows of the transaction''s making; since 127 a thought''s subjects are a set, and a subject kept standing beside a replace is not locked), as db/threads.ts locks its batches'' keys, so two writers moving thoughts across the same keys queue rather than deadlock; with them the thought and its neighbours in those keys'' threads (KEY SHARE, in id order), so a delete of a neighbour standing in two of them waits for the commit rather than deadlocking with its re-links; once a transaction and thought (the local setting ob1.thread_mark marks it), and above READ COMMITTED not at all (the re-link''s refusal first). A delete — the subject''s thought deleted — re-links only when the deleting role may make a re-link''s writes (INSERT and UPDATE on thought_facets, UPDATE on thoughts for the row locks, and INSERT, UPDATE and SELECT on derivations), the transaction is READ COMMITTED and no other transaction holds the key''s lock (pg_try_advisory_xact_lock): a delete never waits on the key''s lock; otherwise the key''s next re-link, or db/threads.ts''s, links its neighbours. Runs as the writer. Migrations 120, 127 / SMD-3306.';

-- ---------------------------------------------------------------------------
-- 7. The catalog's copy of the vocabulary
-- ---------------------------------------------------------------------------
COMMENT ON TABLE thought_facets IS
  'Typed rows on a thought, four kinds registered: citation (042), payload {text, stance, source_id} — a statement in thought_id that rests on thought source_id; link (053), payload {relation, system, target, origin} — a source system''s structured link from the thought to another identity in it; relation (084), payload {relation, target, judge_key, confidence, origin} — the consolidation judge''s related, evolves or duplicate verdict on the thought (the newer) and the target thought (the older), or since 102 its distinct (the pair it called unrelated: two near neighbours about different subjects, kept apart), written once — by record_thought_relation, the consolidation pass''s door, though origin `judged` marks the kind and any role holding INSERT on the table (the structure group) can write one — and only ever closed; subject (111), payload {key, by, judge_key, origin} — the thought''s own subject, since 127 a set: one standing per thought and key (the index''s rule), at most three and one rule''s (record_thought_subjects''s), written by record_thought_subjects (record_thought_subject a set of one) and only ever closed. Since 120 a relation is also a work thread''s edge — origin thread, the key of the thread it links — kept by thread_relink as the subjects land and leave (SMD-3306), so a thought with a set stands in each key''s thread. Validated by kind in thought_facets_validate (check_violation for an unregistered kind or a malformed payload). Active while valid_until is NULL or future and no facet that still exists supersedes it (thought_facet_active); only active citations make thoughts_guard_citation_sources refuse a delete of their source. Migrations 042, 053, 084, 102, 111, 120, 127 / SMD-1712, SMD-1867, SMD-1873, SMD-3117, SMD-3306.';
