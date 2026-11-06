-- =============================================================================
-- Migration 120: a work thread's edges stand — the thoughts holding one
--                subject key, in capture order, each linked to the one before
--                it by an `evolves` relation the database keeps as subjects
--                land and leave (SMD-3306 PR 7a-1)
-- =============================================================================
--
-- WHY
--   SMD-3306 makes evolves a property of each thought's own subject (111,
--   113): B evolves A when B comes next on A's subject's timeline. The
--   maintainer chose (2026-11-05) standing facets for it, an edge between
--   each two consecutive thoughts of a thread, so the readers of 084's
--   relations keep working; linked threads, so a board link joins no two
--   threads; and threads before decide mode stops judging evolves.
--
-- WHAT
--   * A thread is the thoughts holding one standing subject key (111), in
--     capture order: created_at, then id.
--   * thought_facets_validate takes a thread's edge in its relation branch
--     (111's body verbatim but that): a relation naming a subject key is the
--     thread's — relation evolves, the key a subject key, judge_key
--     thread:<version>, no confidence — and the validator writes its origin
--     `thread`; any other relation names no key and no thread's judge key,
--     and keeps origin `judged`. A thread's edge, like a judged one, sits on
--     the newer thought and names the older as its target, is written
--     standing, and is only ever closed.
--   * The active-pair index (084) keeps to the judge's edges, under its own
--     name, and a second takes a thread's per pair and key, so a judged
--     `related` and a thread's `evolves` stand side by side on one pair until
--     decide mode stops judging evolves (PR 7b). A third finds a thread's
--     edges by key.
--   * record_thought_relation (102's body verbatim but its pair read) reads,
--     keeps, replaces and closes the judge's edge alone: a re-judge never
--     touches a thread's.
--   * thread_relink(key, dry) — re-links one key's thread under an advisory
--     lock on the key: each edge the thread has that does not stand is
--     written first, with its lineage row (artifact_kind relation, the older
--     and the newer thought at their fingerprints now, produced_by thread:v1)
--     in the same transaction (ob1:thread-lineage-with-its-artifact), its two
--     thoughts locked (KEY SHARE) before the write, so a delete in flight is
--     waited out, a pair it took a thought from is passed over and the thread
--     read again once the round is through; then each standing edge the
--     thread no longer has is closed, the thread's edges and the ones it
--     wants read once each and set against each other. Dry, it counts and
--     writes nothing. Returns {ok, key, thoughts, closed, added, dry}.
--   * Three constraint triggers on thought_facets keep the threads, deferred
--     to the writer's commit, so a replace (a subject closed and another
--     written in one transaction) re-links once its subjects are final, a
--     replace onto another key locking both keys in key order first, as
--     db/threads.ts's batches lock theirs, so two writers moving thoughts
--     across one pair of keys queue rather than deadlock: a subject written
--     (AFTER INSERT) re-links its key; a subject closed (AFTER UPDATE OF
--     valid_until) re-links its key; a standing subject deleted with its
--     thought (AFTER DELETE) re-links its key when the deleting role may make
--     a re-link's writes — INSERT and UPDATE on thought_facets (the structure
--     and capture groups'), UPDATE on thoughts (the row locks) and INSERT,
--     UPDATE and SELECT on derivations (the capture group's) — its
--     transaction is READ COMMITTED and no other transaction holds the key's
--     lock: a delete's own re-link never waits on the key's lock, which a
--     re-link waiting on the deleted thought may hold.
--   * READ COMMITTED alone: thread_relink refuses a transaction above it
--     (feature_not_supported, 115's rule), since its reads after the key's
--     lock would see a snapshot taken before it; a subject written in such a
--     transaction is refused at its commit with it.
--   * Grants: none issued. The triggers run as the writer, as 016's and
--     113's do: record_thought_subject already needs every write a re-link
--     makes; close_thought_subject, which needed UPDATE alone, needs them
--     too since a close re-links (its comment says so, below), as the
--     subject sweep that calls it holds them; a delete re-links only with
--     them (NOT HERE).
--
--   ob1:thread-edge and ob1:thread-lineage-with-its-artifact — CONTRACT
--   SENTINELS, not prose (the 014 convention).
--
-- NOT HERE
--   * The backfill: an existing brain's threads are linked by db/threads.ts,
--     in batches, once at the upgrade — not here, since a brain may hold
--     millions of thoughts. Until it runs, a thread is linked where a subject
--     lands or leaves.
--   * A thought deleted by a role that cannot make a re-link's writes (a
--     server role holds the capture and server groups alone, no INSERT on
--     thought_facets), above READ COMMITTED, or while another transaction
--     holds its key's lock (a db/threads.ts batch among them), closes its
--     edges (084's trigger and the cascade) and links its neighbours at the
--     key's next re-link, or db/threads.ts's; the holder links past it itself
--     when its own work reaches the deleted thought, which a dry run's never
--     does.
--   * A delete waits for an open re-link that has locked its thought (KEY
--     SHARE), as long as that transaction runs — a db/threads.ts batch's.
--     Two raw DELETEs on one thread can deadlock, one refused, the second's
--     close of an edge waiting on the first's cascade while the first's
--     re-link waits on the second's row; delete_thought serialises them
--     (036's lock), as it does its other raw-delete residue.
--   * One transaction writing many subjects on one key re-links the key once
--     for each at its commit: every re-link after the first finds nothing to
--     do, at the cost of its read. No writer of the stack writes more than
--     one subject a transaction.
--   * The reads (PR 7a-2): a thread read, fetch's "continues X" and
--     "continued by Y", and SMD-2726's relations on search, list and fetch.
--   * A thought's subjects as a set (PR 7a-3): one standing per thought
--     (111) until then, so a thought stands in one thread.
--   * Decide mode's evolves (PR 7b): the judge's evolves still stand beside
--     the threads' until the next decide version.
--   * rebuild_derived's relation arm (SMD-2726): a thread's edge is kept by
--     its subjects, not by its texts' fingerprints — an edit that keeps the
--     subject keeps the edge, its lineage at the fingerprints it was written
--     at — so the arm, when it lands, keeps to the judge's edges.
--   * A writer outside the stack's doors can still deadlock with a re-link,
--     Postgres ending one: a transaction re-keying one thought twice (it locks
--     the middle key alone); one that writes or closes a thought's subject and
--     then deletes the thought (the subject's re-link waits on the key while
--     the transaction holds the deleted row); a re-link closing stray edges a
--     raw write left both on and naming a thought another transaction is
--     deleting. No writer of the stack does any of them.
--
-- SAFETY
--   Two functions redefined, the validator and record_thought_relation, each
--   a body verbatim but the edit above; 084's index made again with the
--   judge's clause, and two made; one new function, one trigger function and
--   three constraint triggers; one comment restated (close_thought_subject's).
--   No existing row changes: every relation standing names no key, so each
--   keeps origin judged and stays under the judge's index, which holds the
--   same pairs 084's did. Dropping 084's index holds thought_facets (ACCESS
--   EXCLUSIVE) until the migrator's transaction commits, so facet reads and
--   writes wait out the judge's index's build over the standing relations —
--   a moment on a brain of thousands, longer on one of millions.
--
-- Idempotent: CREATE OR REPLACE, the triggers dropped by name first, 084's
-- index dropped only while it has 084's shape, the indexes IF NOT EXISTS.
-- =============================================================================

DO $qc$
DECLARE
  v_missing text;
BEGIN
  -- The first prerequisite missing, in file order, named.
  v_missing := CASE
    WHEN to_regprocedure('ob1_record_derivation(text, uuid, uuid[], text[], text, jsonb, uuid)') IS NULL THEN '061 and 064 (ob1_record_derivation)'
    WHEN to_regprocedure('record_thought_relation(uuid, uuid, text, numeric, text, uuid, text, text, jsonb)') IS NULL THEN '084 (record_thought_relation)'
    WHEN to_regprocedure('subject_key_valid(text)') IS NULL THEN '111 (subject_key_valid)'
    WHEN to_regprocedure('close_thought_subject(uuid, uuid, text)') IS NULL THEN '113 (close_thought_subject)'
  END;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format('migration 120 needs %s; this schema lacks it', v_missing),
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url ... --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. A thread's edge — thought_facets_validate's relation branch takes one
--
-- 111's body verbatim but the relation branch: the thread's checks above the
-- confidence's, and the origin by the key.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION thought_facets_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_source   text;
  v_deleted  text;
  v_text     text;
  v_stance   text;
  v_relation text;
  v_system   text;
  v_target   text;
  v_conf     jsonb;
  v_key      text;
  v_by       text;
BEGIN
  IF jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('thought_facets.payload must be a JSON object, got %s', COALESCE(jsonb_typeof(NEW.payload), 'null'));
  END IF;
  -- 084: a facet keeps its kind. An UPDATE turning a link into a citation
  -- was admitted by the citation branch, so a role holding the capture
  -- group's UPDATE could forge a citation of any thought and have its delete
  -- refused (CITED); the same for a link or a relation made from another
  -- kind. No writer changes a kind (SMD-1873 PR 2 review pass 2).
  IF TG_OP = 'UPDATE' AND NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('a facet keeps its kind: a %s is not turned into a %s; write a new facet', OLD.kind, NEW.kind);
  END IF;
  IF NEW.kind IS DISTINCT FROM 'citation' AND NEW.kind IS DISTINCT FROM 'link' AND NEW.kind IS DISTINCT FROM 'relation'
     AND NEW.kind IS DISTINCT FROM 'subject' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('thought_facets.kind %L is not a registered facet kind', NEW.kind),
      HINT = 'The registered kinds are: citation (migration 042), link (migration 053), relation (migration 084), subject (migration 111). A new kind is registered by a migration that extends thought_facets_validate.';
  END IF;

  IF NEW.kind = 'subject' THEN
    -- ob1:subject-facet (111)
    -- A thought's own subject (SMD-3306), written once and only ever closed,
    -- as a relation is: the one UPDATE is the close — record_thought_subject
    -- setting valid_until with every other column as it was. A rewrite would
    -- leave its lineage naming what it no longer says.
    IF TG_OP = 'UPDATE' THEN
      IF NEW.id = OLD.id AND NEW.thought_id = OLD.thought_id AND NEW.payload = OLD.payload
         AND NEW.superseded_by IS NOT DISTINCT FROM OLD.superseded_by AND NEW.created_at = OLD.created_at
         AND OLD.valid_until IS NULL AND NEW.valid_until IS NOT NULL AND NEW.valid_until <= now() THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a subject is written once and only closed: the one update it takes sets valid_until, not in the future, on a standing subject, every other column as it was',
        HINT = 'record_thought_subject replaces a subject (the old one closed, a new one written); write a new row rather than edit one.';
    END IF;
    IF NEW.valid_until IS NOT NULL OR NEW.superseded_by IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a subject is written standing: valid_until and superseded_by are set only by its close';
    END IF;
    v_key := NEW.payload->>'key';
    v_by  := NEW.payload->>'by';
    IF jsonb_typeof(NEW.payload->'key') IS DISTINCT FROM 'string' OR NOT subject_key_valid(v_key) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a subject''s key is ticket:<ID>, pr:<number>, version:<v1.2.3> or phrase:<lower-case words>, got %L', left(v_key, 80));
    END IF;
    IF v_by IS NULL OR v_by NOT IN ('metadata', 'first_line', 'model') THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a subject says how it was found: by is metadata, first_line or model, got %L', v_by);
    END IF;
    IF jsonb_typeof(NEW.payload->'judge_key') IS DISTINCT FROM 'string' OR btrim(NEW.payload->>'judge_key') = '' OR length(NEW.payload->>'judge_key') > 200 THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a subject names the pass that found it: judge_key, a non-empty string of at most 200 characters';
    END IF;
    -- Origin is the validator's word, not the writer's: a pass derived it.
    NEW.payload := NEW.payload || jsonb_build_object('origin', 'derived');
    RETURN NEW;
  END IF;

  IF NEW.kind = 'relation' THEN
    -- ob1:relation-facet (084; distinct since 102)
    -- A relation is written once and only ever closed. The one UPDATE is the
    -- close — record_thought_relation, or the target's delete, setting
    -- valid_until with every other column as it was — and it is not re-judged:
    -- the target may be gone by then. Any other UPDATE of a relation, or one
    -- turning another kind into a relation, is refused: a rewrite would leave
    -- its lineage naming what it no longer says, and a re-open could stand an
    -- edge on a deleted thought (SMD-1873 PR 2 review pass 1).
    IF TG_OP = 'UPDATE' THEN
      -- The close sets valid_until to a time not in the future: a future one
      -- would leave the row off the one-standing index while
      -- thought_facet_active still counted it active (review pass 2).
      IF NEW.id = OLD.id AND NEW.thought_id = OLD.thought_id AND NEW.payload = OLD.payload
         AND NEW.superseded_by IS NOT DISTINCT FROM OLD.superseded_by AND NEW.created_at = OLD.created_at
         AND OLD.valid_until IS NULL AND NEW.valid_until IS NOT NULL AND NEW.valid_until <= now() THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a relation is written once and only closed: the one update it takes sets valid_until, not in the future, on a standing relation, every other column as it was',
        HINT = 'record_thought_relation replaces a relation (the old one closed, a new one written); write a new row rather than edit one.';
    END IF;
    IF NEW.valid_until IS NOT NULL OR NEW.superseded_by IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a relation is written standing: valid_until and superseded_by are set only by its close';
    END IF;
    v_relation := NEW.payload->>'relation';
    v_target   := NEW.payload->>'target';
    v_conf     := NEW.payload->'confidence';
    IF v_relation IS NULL OR v_relation NOT IN ('related', 'evolves', 'duplicate', 'distinct') THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a relation''s relation must be related, evolves, duplicate or distinct, got %L', v_relation);
    END IF;
    IF jsonb_typeof(NEW.payload->'target') IS DISTINCT FROM 'string'
       OR v_target !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a relation''s target must be a thought id, got %L', left(v_target, 60));
    END IF;
    IF v_target::uuid = NEW.thought_id THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a thought is not related to itself';
    END IF;
    IF jsonb_typeof(NEW.payload->'judge_key') IS DISTINCT FROM 'string' OR btrim(NEW.payload->>'judge_key') = '' OR length(NEW.payload->>'judge_key') > 200 THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a relation names the pass that judged it: judge_key, a non-empty string of at most 200 characters';
    END IF;
    -- ob1:thread-edge (120)
    -- A relation naming a subject key is a thread's edge (SMD-3306 PR 7a-1), written by
    -- thread_relink: the next thought on the key's thread goes on from the one before it, so
    -- evolves, under the threads' judge key, thread:<version>, with no confidence — its order is
    -- the capture order, not a judgement. Any other relation is the judge's: no key, and no
    -- thread's judge key. The validator, not the writer, says which (its origin below).
    IF NEW.payload ? 'key' THEN
      v_key := NEW.payload->>'key';
      IF jsonb_typeof(NEW.payload->'key') IS DISTINCT FROM 'string' OR NOT subject_key_valid(v_key) THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation',
          MESSAGE = format('a thread''s edge names its thread by a subject key, ticket:<ID>, pr:<number>, version:<v1.2.3> or phrase:<lower-case words>, got %L', left(v_key, 80));
      END IF;
      IF v_relation IS DISTINCT FROM 'evolves' THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation',
          MESSAGE = format('a thread''s edge is evolves, the next thought on the thread going on from the one before it, got %L', v_relation);
      END IF;
      IF NEW.payload->>'judge_key' NOT LIKE 'thread:%' THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation',
          MESSAGE = format('a thread''s edge names the threads'' version as its judge key, thread:<version>, got %L', left(NEW.payload->>'judge_key', 80));
      END IF;
      IF v_conf IS NOT NULL AND jsonb_typeof(v_conf) <> 'null' THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation',
          MESSAGE = 'a thread''s edge carries no confidence: its order is the capture order, not a judgement';
      END IF;
    ELSIF NEW.payload->>'judge_key' LIKE 'thread:%' THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a judge key thread:<version> is a thread''s edge''s, which names the subject key of its thread';
    END IF;
    IF v_conf IS NOT NULL AND jsonb_typeof(v_conf) <> 'null'
       AND (jsonb_typeof(v_conf) <> 'number' OR (v_conf)::numeric < 0 OR (v_conf)::numeric > 1) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a relation''s confidence is a number from 0 to 1, got %s', left(v_conf::text, 40));
    END IF;
    IF v_target IS DISTINCT FROM (v_target::uuid)::text THEN
      NEW.payload := NEW.payload || jsonb_build_object('target', v_target::uuid);
      v_target := (v_target::uuid)::text;
    END IF;
    -- The target must exist when the edge is written; locked FOR KEY SHARE so
    -- a delete of it waits, and then closes the edge (084's trigger on thoughts).
    PERFORM 1 FROM thoughts WHERE id = v_target::uuid FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a relation''s target %s is not a thought', v_target);
    END IF;
    -- Origin is the validator's word, not the writer's: a pass judged it, or, since 120, a
    -- thread's order made it.
    NEW.payload := NEW.payload || jsonb_build_object('origin', CASE WHEN NEW.payload ? 'key' THEN 'thread' ELSE 'judged' END);
    RETURN NEW;
  END IF;

  IF NEW.kind = 'link' THEN
    -- ob1:link-facet (053)
    -- A close — record_source_links setting valid_until with the payload as
    -- it was — is not a new link and is not re-judged: an identity re-pointed
    -- onto the target since (record_thought_source on the same thought) would
    -- otherwise make the row impossible to close, and every later structure
    -- write on the thought would fail (fourth review pass).
    -- Exactly a close and nothing else: the same link row, on the same
    -- thought, going from open to closed — a raw UPDATE that moves the row to
    -- another thought, re-opens it or turns a citation into a link is judged
    -- like any write (fifth review pass, independent read).
    IF TG_OP = 'UPDATE' AND OLD.kind = 'link' AND NEW.thought_id = OLD.thought_id
       AND NEW.payload = OLD.payload AND OLD.valid_until IS NULL AND NEW.valid_until IS NOT NULL THEN
      RETURN NEW;
    END IF;
    v_relation := NEW.payload->>'relation';
    v_system   := NEW.payload->>'system';
    v_target   := NEW.payload->>'target';
    IF v_relation IS NULL OR v_relation NOT IN ('references', 'child_of', 'blocks', 'blocked_by', 'relates_to', 'duplicate_of') THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a link''s relation must be references, child_of, blocks, blocked_by, relates_to or duplicate_of, got %L', v_relation);
    END IF;
    IF v_system IS NULL OR v_system !~ '^[a-z][a-z0-9_-]*$' THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a link names its source system as one lower-case word, got %L', v_system);
    END IF;
    IF jsonb_typeof(NEW.payload->'target') IS DISTINCT FROM 'string' OR btrim(v_target) = '' OR length(v_target) > 512 THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a link names its target by identity within the system: a non-empty string of at most 512 characters';
    END IF;
    IF EXISTS (SELECT 1 FROM thought_sources s WHERE s.thought_id = NEW.thought_id AND s.system = v_system AND s.identity = v_target) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a thought does not link to itself (%s %s)', v_system, v_target);
    END IF;
    -- Origin is the validator's word, not the writer's: the source said it.
    NEW.payload := NEW.payload || jsonb_build_object('origin', 'structured');
    RETURN NEW;
  END IF;

  v_text    := NEW.payload->>'text';
  v_stance  := NEW.payload->>'stance';
  v_source  := NEW.payload->>'source_id';
  v_deleted := NEW.payload->>'source_deleted_id';

  IF jsonb_typeof(NEW.payload->'text') IS DISTINCT FROM 'string' OR btrim(v_text) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'a citation needs a non-empty text: the statement that rests on the source';
  END IF;
  IF v_stance IS NULL OR v_stance NOT IN ('stated', 'retrieved', 'inferred') THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('a citation''s stance must be stated, retrieved or inferred, got %L', v_stance);
  END IF;

  IF v_source IS NULL THEN
    IF v_deleted IS NULL
       OR v_deleted !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR NEW.payload->>'source_deleted_at' IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'a citation names its source: payload.source_id must be a thought id (null only with source_deleted_id and source_deleted_at — the shape the guard writes when a source is deleted, or a detached row restored whole)';
    END IF;
    BEGIN
      PERFORM (NEW.payload->>'source_deleted_at')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a detached citation''s source_deleted_at must be a timestamp, got %L', left(NEW.payload->>'source_deleted_at', 40));
    END;
    IF v_deleted IS DISTINCT FROM (v_deleted::uuid)::text THEN
      NEW.payload := NEW.payload || jsonb_build_object('source_deleted_id', v_deleted::uuid);
      v_deleted := (v_deleted::uuid)::text;
    END IF;
    IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM thoughts WHERE id = v_deleted::uuid) THEN
      NEW.payload := (NEW.payload - 'source_deleted_id' - 'source_deleted_at') || jsonb_build_object('source_id', v_deleted::uuid);
      v_source := v_deleted;
    ELSE
      IF TG_OP = 'INSERT' OR OLD.payload->>'source_id' IS NOT NULL THEN
        IF TG_OP = 'UPDATE' AND v_deleted::uuid IS DISTINCT FROM (OLD.payload->>'source_id')::uuid THEN
          RAISE EXCEPTION USING ERRCODE = 'check_violation',
            MESSAGE = format('a citation is detached only from the source it had (%s), not %s', OLD.payload->>'source_id', v_deleted);
        END IF;
        IF EXISTS (SELECT 1 FROM thoughts WHERE id = v_deleted::uuid) THEN
          RAISE EXCEPTION USING ERRCODE = 'check_violation',
            MESSAGE = format('a citation is detached only when its source is gone; thought %s still exists', v_deleted);
        END IF;
      ELSIF v_deleted::uuid IS DISTINCT FROM (OLD.payload->>'source_deleted_id')::uuid THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation',
          MESSAGE = 'a detached citation keeps the source it lost';
      END IF;
      RETURN NEW;
    END IF;
  END IF;

  IF v_source !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('a citation''s source_id must be a thought id, got %L', left(v_source, 60));
  END IF;
  IF v_source::uuid = NEW.thought_id THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'a thought cannot cite itself as a source';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.payload->>'source_id' IS NULL AND OLD.payload ? 'source_deleted_id' THEN
    IF v_source::uuid IS DISTINCT FROM (OLD.payload->>'source_deleted_id')::uuid THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a detached citation is not re-pointed at a new source (it rested on %s, deleted %s); record a new citation — it may only be re-attached to %s once that thought exists again', OLD.payload->>'source_deleted_id', OLD.payload->>'source_deleted_at', OLD.payload->>'source_deleted_id');
    END IF;
    NEW.payload := NEW.payload - 'source_deleted_id' - 'source_deleted_at';
  END IF;
  IF v_source IS DISTINCT FROM (v_source::uuid)::text THEN
    NEW.payload := NEW.payload || jsonb_build_object('source_id', v_source::uuid);
    v_source := (v_source::uuid)::text;
  END IF;
  IF NEW.payload ? 'source_deleted_id' OR NEW.payload ? 'source_deleted_at' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'a citation with a source carries no source_deleted_id or source_deleted_at — those are the detached shape''s, written when the source is deleted';
  END IF;
  IF TG_OP = 'INSERT' OR v_source IS DISTINCT FROM (OLD.payload->>'source_id') THEN
    PERFORM 1 FROM thoughts WHERE id = v_source::uuid FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = format('a citation''s source_id %s is not a thought', v_source);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION thought_facets_validate() IS
  'BEFORE INSERT OR UPDATE on thought_facets: refuses an unregistered kind. For a citation (042): a missing text, a stance outside stated | retrieved | inferred, a source_id that is not an existing thought or is the citing thought itself — all as check_violation — stores source_id lower-case, locks the source row FOR KEY SHARE; source_id may be null only in the detached shape, which keeps what it lost and is not re-pointed. For a link (053): relation one of references | child_of | blocks | blocked_by | relates_to | duplicate_of, system one lower-case word, target a non-empty identity within it, never the thought''s own (thought_sources); writes origin = structured. For a relation (084): written standing (no valid_until, no superseded_by), relation one of related | evolves | duplicate | distinct (distinct since 102), target an existing thought (locked FOR KEY SHARE) that is not the thought itself, stored lower-case, judge_key a non-empty string of at most 200 characters, confidence a number in 0..1 or absent; writes origin = judged; afterwards only its close (valid_until set, not in the future, every other column as it was) is admitted — no rewrite, re-open or move. For a subject (111): written standing, key a subject key (subject_key_valid), by one of metadata | first_line | model, judge_key a non-empty string of at most 200 characters; writes origin = derived; afterwards only its close, as a relation''s. For a relation since 120: one naming a subject key is a thread''s edge — relation evolves, the key a subject key (subject_key_valid), judge_key thread:<version>, no confidence — and writes origin = thread; any other must name no thread''s judge key, and writes origin = judged. Since 084 no facet changes its kind on UPDATE. A pure close of a link passes unjudged. Migrations 042, 053, 084, 102, 111, 120.';

-- ---------------------------------------------------------------------------
-- 2. One standing edge per pair, the judge's and each thread's apart
--
-- 084's index held one relation per pair whoever wrote it; it now holds the
-- judge's alone (the same rows: none standing names a key), under its own
-- name, so a re-apply of 084 (IF NOT EXISTS) keeps it; a thread's edge is
-- one per pair and key. A third index finds a thread's edges by key, as
-- 111's finds its subjects.
-- ---------------------------------------------------------------------------
DO $ix$
BEGIN
  -- 084's shape, not yet the judge's alone: dropped, to be made again below. A
  -- re-apply of 120 finds it made and keeps it.
  IF EXISTS (SELECT 1 FROM pg_indexes
              WHERE schemaname = current_schema() AND indexname = 'thought_facets_relation_active_uniq'
                AND indexdef NOT LIKE '%NOT (payload ? ''key''::text)%') THEN
    DROP INDEX thought_facets_relation_active_uniq;
  END IF;
END
$ix$;
CREATE UNIQUE INDEX IF NOT EXISTS thought_facets_relation_active_uniq
  ON thought_facets (thought_id, (payload->>'target'))
  WHERE kind = 'relation' AND valid_until IS NULL AND NOT (payload ? 'key');
CREATE UNIQUE INDEX IF NOT EXISTS thought_facets_relation_thread_uniq
  ON thought_facets (thought_id, (payload->>'target'), (payload->>'key'))
  WHERE kind = 'relation' AND valid_until IS NULL AND payload ? 'key';
CREATE INDEX IF NOT EXISTS thought_facets_thread_key_idx
  ON thought_facets ((payload->>'key'))
  WHERE kind = 'relation' AND valid_until IS NULL AND payload ? 'key';

COMMENT ON INDEX thought_facets_relation_active_uniq IS
  'One standing judged relation per pair (the newer thought, the older target): 084''s rule, kept to the judge''s edges since 120, so a thread''s edge on the same pair stands beside it. Migrations 084, 120.';
COMMENT ON INDEX thought_facets_relation_thread_uniq IS
  'One standing thread''s edge per pair and subject key (120, SMD-3306): thread_relink''s set, under the key''s lock.';
COMMENT ON INDEX thought_facets_thread_key_idx IS
  'A thread''s standing edges by its subject key, for thread_relink''s read of what stands (120, SMD-3306).';

-- ---------------------------------------------------------------------------
-- 3. The judge's writer keeps to the judge's edges
--
-- 102's body verbatim but its read of the pair's standing edge.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_thought_relation(
  p_newer      uuid,
  p_older      uuid,
  p_relation   text,
  p_confidence numeric,
  p_judge_key  text,
  p_agent      uuid,
  p_older_fp   text,
  p_newer_fp   text,
  p_recipe     jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_active    uuid;
  v_relation  text;
  v_key       text;
  v_conf      numeric;
  v_id        uuid;
BEGIN
  IF p_newer IS NULL OR p_older IS NULL OR p_newer = p_older THEN
    RAISE EXCEPTION USING MESSAGE = 'record_thought_relation: two different thoughts are required', ERRCODE = 'invalid_parameter_value';
  END IF;
  -- ob1:relation-distinct — a CONTRACT SENTINEL, not prose (the 014
  -- convention): this door takes distinct (102, SMD-3117). db/consolidate.ts
  -- reads it to know whether to send the word: 102 keeps 084's signature.
  IF p_relation IS NOT NULL AND p_relation NOT IN ('related', 'evolves', 'duplicate', 'distinct') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('record_thought_relation: relation must be related, evolves, duplicate, distinct or NULL (close), got %L', p_relation),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_judge_key IS NULL OR btrim(p_judge_key) = '' OR length(p_judge_key) > 200 THEN
    -- The validator's bound, refused here as a parameter error: a check
    -- violation would read to the pass as a side deleted mid-write (review pass 2).
    RAISE EXCEPTION USING MESSAGE = 'record_thought_relation: judge_key must name the pass, in at most 200 characters', ERRCODE = 'invalid_parameter_value';
  END IF;

  -- One writer per pair at a time: two passes judging the pair at once would
  -- otherwise both find nothing active and the second insert hit the index.
  PERFORM pg_advisory_xact_lock(hashtextextended('ob1:relation:' || p_newer::text || ':' || p_older::text, 0));
  -- Both thoughts locked FOR KEY SHARE before the facet row: a delete of either
  -- then waits here, rather than holding its thought while its trigger (the
  -- close, or the cascade) waits on the facet this call locked — a deadlock
  -- Postgres would break by aborting one side, the user's delete perhaps
  -- (review pass 1). A thought already gone answers none: nothing to write.
  PERFORM 1 FROM thoughts WHERE id IN (p_newer, p_older) ORDER BY id FOR KEY SHARE;
  IF (SELECT count(*) FROM thoughts WHERE id IN (p_newer, p_older)) < 2 THEN
    RETURN jsonb_build_object('ok', true, 'action', 'none', 'gone', true);
  END IF;

  -- The judge's edge on the pair, never a thread's (120): a thread's edge on the same pair stands
  -- beside it, kept by the subjects, so a re-judge neither keeps, replaces nor closes it.
  SELECT f.id, f.payload->>'relation', f.payload->>'judge_key', (f.payload->>'confidence')::numeric INTO v_active, v_relation, v_key, v_conf
    FROM thought_facets f
   WHERE f.thought_id = p_newer AND f.kind = 'relation' AND f.valid_until IS NULL
     AND f.payload->>'target' = p_older::text AND NOT (f.payload ? 'key')
   FOR UPDATE;

  IF p_relation IS NULL THEN
    IF v_active IS NULL THEN
      RETURN jsonb_build_object('ok', true, 'action', 'none');
    END IF;
    UPDATE thought_facets SET valid_until = now() WHERE id = v_active;
    RETURN jsonb_build_object('ok', true, 'action', 'closed', 'id', v_active);
  END IF;

  IF v_active IS NOT NULL AND v_relation = p_relation AND v_key = p_judge_key
     AND v_conf IS NOT DISTINCT FROM round(p_confidence, 2) THEN
    -- Kept: the same word, by the same pass, at the same confidence — the
    -- edge stands, its lineage moved to the texts judged now. Anything else
    -- is a replace, since a relation is never edited (the validator): its
    -- payload says who judged it and how sure, and its lineage is that judge's
    -- (review pass 1: a kept edge under another key read stale).
    PERFORM ob1_record_derivation('relation', v_active, ARRAY[p_older, p_newer], ARRAY[p_older_fp, p_newer_fp], p_judge_key,
                                  COALESCE(p_recipe, jsonb_build_object('deterministic', false, 'declared', false)), p_agent);
    RETURN jsonb_build_object('ok', true, 'action', 'kept', 'id', v_active);
  END IF;
  IF v_active IS NOT NULL THEN
    UPDATE thought_facets SET valid_until = now() WHERE id = v_active;
  END IF;

  INSERT INTO thought_facets (thought_id, kind, payload)
  VALUES (p_newer, 'relation',
          jsonb_build_object('relation', p_relation, 'target', p_older, 'judge_key', p_judge_key)
          || CASE WHEN p_confidence IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('confidence', round(p_confidence, 2)) END)
  RETURNING id INTO v_id;
  -- ob1:relation-lineage-with-its-artifact — a CONTRACT SENTINEL, not prose:
  -- the edge and its lineage are one transaction (061's rule).
  PERFORM ob1_record_derivation('relation', v_id, ARRAY[p_older, p_newer], ARRAY[p_older_fp, p_newer_fp], p_judge_key,
                                COALESCE(p_recipe, jsonb_build_object('deterministic', false, 'declared', false)), p_agent);
  RETURN jsonb_build_object('ok', true, 'action', CASE WHEN v_active IS NULL THEN 'added' ELSE 'replaced' END, 'id', v_id);
END;
$$;

COMMENT ON FUNCTION record_thought_relation(uuid, uuid, text, numeric, text, uuid, text, text, jsonb) IS
  'The consolidation pass''s write of one judged relation (SMD-1873 PR 2): a `relation` facet on the newer thought naming the older as target — related, evolves, duplicate, or since 102 distinct (two near neighbours the judge called unrelated: different subjects, kept apart; SMD-3117) — a set per pair under an advisory lock on the pair, both thoughts locked FOR KEY SHARE first. The same relation already standing, by the same judge key at the same confidence, is kept (its lineage row moved to the fingerprints judged now); anything else replaces it (the old edge closed with valid_until, a new one inserted — a relation is never edited); a NULL relation closes the pair''s standing edge, or answers none; a thought gone answers none. Each new edge''s lineage row (artifact_kind relation, inputs older and newer at the fingerprints the judge was sent, produced_by the judge key) is written in the same transaction (ob1:relation-lineage-with-its-artifact). Returns {ok, action: added | kept | replaced | closed | none, id}. SECURITY INVOKER: the caller needs INSERT on thought_facets (the structure group), UPDATE on it and on thoughts (the row locks) and the writes on derivations (the capture group). Since 120 it reads, keeps, replaces and closes the judge''s edge on the pair alone: a thread''s edge (a relation naming a subject key) stands beside it, kept by the subjects. Migrations 084, 102, 120 / SMD-1873, SMD-3117, SMD-3306.';

-- ---------------------------------------------------------------------------
-- 4. thread_relink — one key's thread made to stand as its subjects say
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION thread_relink(p_key text, p_dry boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_closed  integer := 0;
  v_added   integer := 0;
  v_count   integer;
  v_held    integer;
  v_reads   integer := 0;
  v_lost    boolean;
  v_n       integer;
  v_id      uuid;
  r         record;
BEGIN
  IF p_key IS NULL OR NOT subject_key_valid(p_key) THEN
    RAISE EXCEPTION USING
      MESSAGE = format('thread_relink: the key is ticket:<ID>, pr:<number>, version:<v1.2.3> or phrase:<lower-case words>, got %L', left(p_key, 80)),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  -- READ COMMITTED alone, checked before the re-link reads anything (115's
  -- rule): above it the reads after the key's lock see the transaction's
  -- snapshot, taken before the lock, and would write a thread its subjects no
  -- longer say. A subject written in such a transaction is refused at its
  -- commit with it.
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('thread_relink must run under READ COMMITTED; this transaction is %s', upper(current_setting('transaction_isolation'))),
      HINT = 'Under REPEATABLE READ or SERIALIZABLE its read of the thread would predate the key''s lock. A subject''s write re-links at its commit: write subjects under READ COMMITTED: BEGIN ISOLATION LEVEL READ COMMITTED in the writer, or, where a session''s default is above it, set default_transaction_isolation back to read committed (preflight names where it was set).',
      ERRCODE = 'feature_not_supported';
  END IF;
  -- One re-link of a thread at a time: two at once would both find an edge
  -- missing and the second insert hit the index. A dry run reads under it too,
  -- so it counts what a re-link now would do.
  PERFORM pg_advisory_xact_lock(hashtextextended('ob1:thread:' || p_key, 0));

  -- The edges the thread has that do not stand are written first, each with
  -- its lineage: the older and the newer thought at their fingerprints now.
  -- Each edge's two thoughts are locked (KEY SHARE) before its write, so a
  -- delete in flight is waited out; a pair it took a thought from is passed
  -- over, and once the round is through the thread is read again, the gone
  -- thought's neighbours then linked past it. Every read again follows a
  -- delete of one of the thread's thoughts, so a thread is read at most once
  -- more than it loses thoughts meanwhile. Before any close, so the re-link
  -- holds no edge's row while it waits on a thought whose delete (084's
  -- trigger) closes the edges naming it.
  <<reads>>
  LOOP
    v_reads := v_reads + 1;
    v_lost := false;
    FOR r IN
      WITH thread AS (
        SELECT t.id, t.created_at
          FROM thought_facets s
          JOIN thoughts t ON t.id = s.thought_id
         WHERE s.kind = 'subject' AND s.valid_until IS NULL AND s.payload->>'key' = p_key
      ), want AS (
        SELECT id AS newer, lag(id) OVER (ORDER BY created_at, id) AS older FROM thread
      )
      SELECT w.newer, w.older,
             COALESCE(n.content_fingerprint, content_fingerprint_of(n.content)) AS newer_fp,
             COALESCE(o.content_fingerprint, content_fingerprint_of(o.content)) AS older_fp
        FROM want w
        JOIN thoughts n ON n.id = w.newer
        JOIN thoughts o ON o.id = w.older
       WHERE w.older IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM thought_facets e
                          WHERE e.thought_id = w.newer AND e.kind = 'relation' AND e.valid_until IS NULL
                            AND e.payload ? 'key' AND e.payload->>'key' = p_key AND e.payload->>'target' = w.older::text)
       ORDER BY w.newer
    LOOP
      IF p_dry THEN
        v_added := v_added + 1;
        CONTINUE;
      END IF;
      PERFORM 1 FROM thoughts WHERE id IN (r.older, r.newer) FOR KEY SHARE;
      GET DIAGNOSTICS v_held = ROW_COUNT;
      IF v_held < 2 THEN
        -- A thought of the pair went while the re-link read: past it, and the
        -- thread read again once the round is through.
        v_lost := true;
        CONTINUE;
      END IF;
      INSERT INTO thought_facets (thought_id, kind, payload)
      VALUES (r.newer, 'relation', jsonb_build_object('relation', 'evolves', 'target', r.older, 'judge_key', 'thread:v1', 'key', p_key))
      RETURNING id INTO v_id;
      -- ob1:thread-lineage-with-its-artifact — a CONTRACT SENTINEL, not prose:
      -- the edge and its lineage are one transaction (061's rule).
      PERFORM ob1_record_derivation('relation', v_id, ARRAY[r.older, r.newer], ARRAY[r.older_fp, r.newer_fp], 'thread:v1',
                                    jsonb_build_object('deterministic', true, 'key', p_key), NULL);
      v_added := v_added + 1;
    END LOOP;
    EXIT reads WHEN NOT v_lost;
    -- A guard, not a limit: each read again follows a thought deleted since
    -- the last, which no thread does a million times over one re-link.
    IF v_reads >= 1000000 THEN
      RAISE EXCEPTION USING ERRCODE = 'serialization_failure',
        MESSAGE = format('thread_relink: the thread of %L lost a thought under each of %s reads; run it again', p_key, v_reads);
    END IF;
  END LOOP;

  -- Then the edges standing that the thread no longer has — a thought gone
  -- from it, or one come between — are closed. A closed edge is history, as a
  -- judged one is: a later re-link writes a new one, never re-opens it. The
  -- thread's edges and the ones it wants are each read once and set against
  -- each other: an anti-join on the window ran it again for every edge where
  -- the planner underestimated a key's rows. Each close counts once it lands:
  -- a delete's own trigger may have closed the edge first.
  FOR r IN
    WITH thread AS (
      SELECT t.id, t.created_at
        FROM thought_facets s
        JOIN thoughts t ON t.id = s.thought_id
       WHERE s.kind = 'subject' AND s.valid_until IS NULL AND s.payload->>'key' = p_key
    ), want AS MATERIALIZED (
      SELECT newer, older
        FROM (SELECT id AS newer, lag(id) OVER (ORDER BY created_at, id) AS older FROM thread) w
       WHERE older IS NOT NULL
    ), have AS MATERIALIZED (
      SELECT e.id, e.thought_id AS newer, (e.payload->>'target')::uuid AS older
        FROM thought_facets e
       WHERE e.kind = 'relation' AND e.valid_until IS NULL AND e.payload ? 'key' AND e.payload->>'key' = p_key
    ), unwanted AS MATERIALIZED (
      SELECT newer, older FROM have
      EXCEPT
      SELECT newer, older FROM want
    )
    SELECT h.id
      FROM have h
      JOIN unwanted u ON u.newer = h.newer AND u.older = h.older
     ORDER BY h.id
  LOOP
    IF p_dry THEN
      v_closed := v_closed + 1;
      CONTINUE;
    END IF;
    UPDATE thought_facets SET valid_until = now() WHERE id = r.id AND valid_until IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_closed := v_closed + v_n;
  END LOOP;

  SELECT count(*) INTO v_count
    FROM thought_facets s
   WHERE s.kind = 'subject' AND s.valid_until IS NULL AND s.payload->>'key' = p_key;
  -- A NULL p_dry runs, as 118's dry run's NULL does: the answer says so.
  RETURN jsonb_build_object('ok', true, 'key', p_key, 'thoughts', v_count, 'closed', v_closed, 'added', v_added, 'dry', p_dry IS TRUE);
END;
$$;

COMMENT ON FUNCTION thread_relink(text, boolean) IS
  'Makes one subject key''s work thread stand as its subjects say (SMD-3306 PR 7a-1): the thoughts holding the key standing, in capture order (created_at, then id), each linked to the one before it by a standing `relation` facet — relation evolves, judge_key thread:v1, the key, origin thread — on the newer thought. Under an advisory lock on the key, each edge the thread has that does not stand is written first, with its lineage row (artifact_kind relation, the older and the newer thought at their fingerprints now, produced_by thread:v1, its recipe deterministic and naming the key) in the same transaction, its two thoughts locked FOR KEY SHARE before the write — a delete in flight is waited out, a pair it took a thought from is passed over, and the thread is read again once the round is through, each read again following a delete — then each standing edge of the key''s that the thread no longer has is closed, the two sides read once each and set against each other (EXCEPT), each close counted as it lands. p_dry counts and writes nothing. READ COMMITTED alone (feature_not_supported above it, 115''s rule): its reads must postdate the key''s lock. Returns {ok, key, thoughts, closed, added, dry}. SECURITY INVOKER: the caller needs SELECT, INSERT and UPDATE on thought_facets (the structure and capture groups), SELECT and UPDATE on thoughts (the row locks), and INSERT, UPDATE and SELECT on derivations (the capture group). Called by the triggers on subjects, at their writer''s commit, and by db/threads.ts. Migration 120 / SMD-3306.';

-- ---------------------------------------------------------------------------
-- 5. The triggers that keep the threads
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_thread_relink_subject()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_new text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM thread_relink(NEW.payload->>'key');
  ELSIF TG_OP = 'UPDATE' THEN
    -- A replace closes a subject and writes another in one transaction, its
    -- close's re-link first at the commit, then its insert's. Two writers
    -- moving thoughts across one pair of keys in opposite directions would
    -- each hold its first key while it waited on the other's, so the closed
    -- key and the thought's new one, standing by now, are locked first, in key
    -- order, as db/threads.ts's batches lock theirs: they queue.
    SELECT s.payload->>'key' INTO v_new
      FROM thought_facets s
     WHERE s.thought_id = OLD.thought_id AND s.kind = 'subject' AND s.valid_until IS NULL;
    IF v_new IS NOT NULL AND v_new <> OLD.payload->>'key' THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('ob1:thread:' || least(OLD.payload->>'key', v_new), 0));
      PERFORM pg_advisory_xact_lock(hashtextextended('ob1:thread:' || greatest(OLD.payload->>'key', v_new), 0));
    END IF;
    PERFORM thread_relink(OLD.payload->>'key');
  -- A standing subject deleted with its thought: its edges are closed by 084's
  -- trigger and the cascade, and its neighbours linked here when the deleting
  -- role may make a re-link's writes, the transaction is READ COMMITTED (the
  -- re-link refuses any other) and the key's lock is free; otherwise at the
  -- key's next re-link (NOT HERE). A delete never waits on the key's lock: a
  -- re-link holding it may be waiting on the deleted thought's row.
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
  'Constraint triggers AFTER INSERT, AFTER UPDATE OF valid_until and AFTER DELETE on thought_facets for a subject (thought_facets_thread_written, _closed and _deleted, 120), deferred to the writer''s commit: re-links the subject''s key''s thread (thread_relink) once the transaction''s subjects are final, so a replace (a close and an insert on one key) moves no edge; a replace onto another key locks both keys in key order at its close, as db/threads.ts locks its batches'' keys, so two writers moving thoughts across one pair of keys queue rather than deadlock. A delete — the subject''s thought deleted — re-links only when the deleting role may make a re-link''s writes (INSERT and UPDATE on thought_facets, UPDATE on thoughts for the row locks, and INSERT, UPDATE and SELECT on derivations), the transaction is READ COMMITTED and no other transaction holds the key''s lock (pg_try_advisory_xact_lock): a delete never waits on the key''s lock; otherwise the key''s next re-link, or db/threads.ts''s, links its neighbours. Runs as the writer. Migration 120 / SMD-3306.';

-- Constraint triggers, deferred to the writer's commit: a replace closes a
-- subject and writes another in one transaction, and a re-link between the
-- two would bridge the thought and then un-bridge it (three closed edges and
-- their lineage for nothing). At the commit both re-links read the final
-- subjects, the second a no-op; the key's lock is held from then alone.
DROP TRIGGER IF EXISTS thought_facets_thread_written ON thought_facets;
CREATE CONSTRAINT TRIGGER thought_facets_thread_written
  AFTER INSERT ON thought_facets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.kind = 'subject') EXECUTE FUNCTION ob1_thread_relink_subject();
DROP TRIGGER IF EXISTS thought_facets_thread_closed ON thought_facets;
CREATE CONSTRAINT TRIGGER thought_facets_thread_closed
  AFTER UPDATE OF valid_until ON thought_facets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.kind = 'subject' AND OLD.valid_until IS NULL AND NEW.valid_until IS NOT NULL)
  EXECUTE FUNCTION ob1_thread_relink_subject();
DROP TRIGGER IF EXISTS thought_facets_thread_deleted ON thought_facets;
CREATE CONSTRAINT TRIGGER thought_facets_thread_deleted
  AFTER DELETE ON thought_facets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.kind = 'subject' AND OLD.valid_until IS NULL) EXECUTE FUNCTION ob1_thread_relink_subject();

-- A close re-links its thread now: close_thought_subject's comment (113's)
-- says what its caller needs since.
COMMENT ON FUNCTION close_thought_subject(uuid, uuid, text) IS
  'Closes a thought''s standing subject only when it is still the facet the caller read and the thought''s text still has the fingerprint read (113, SMD-3306): the subject sweep''s close of an out-of-date subject the model now names nothing for. Under record_thought_subject''s advisory lock, the thought locked FOR KEY SHARE first. Returns {ok, action: closed | none, id?, gone?, stale?, moved?}: none with gone for a thought deleted, with stale for a text that moved, with moved (and the standing id) when another subject stands, and alone when none does. SECURITY INVOKER: the caller needs UPDATE on thought_facets and on thoughts (the row locks), as the door''s close does; since 120 a close re-links the subject''s thread (thought_facets_thread_closed), which needs INSERT on thought_facets (the structure group) and INSERT, UPDATE and SELECT on derivations (the capture group) too, as the door''s writes do. Migrations 113, 120 / SMD-3306.';

-- ---------------------------------------------------------------------------
-- 6. The catalog's copy of the vocabulary
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN thought_facets.payload IS
  'Shaped by kind. citation: text (non-empty), stance (stated | retrieved | inferred), source_id (an existing thought, not thought_id itself, stored lower-case); after the source is deleted, source_id null with source_deleted_id and source_deleted_at set by the guard — a shape a restore may insert whole, and that is never re-pointed at a new source. link (053): relation, system, target (an identity in the system), origin structured. relation (084): relation (related | evolves | duplicate | distinct — distinct since 102), target (the older thought''s id), judge_key, confidence, origin judged; inserted standing only, so a restore re-inserts a closed relation as standing or not at all. subject (111): key (ticket:<ID> | pr:<number> | version:<v> | phrase:<words>), by (metadata | first_line | model), judge_key, origin derived; inserted standing only, as a relation. Since 120 a relation may be a thread''s edge (SMD-3306): payload {relation evolves, target (the thought before it on the thread), judge_key thread:<version>, key (the thread''s subject key), origin thread}, written by thread_relink.';
COMMENT ON TABLE thought_facets IS
  'Typed rows on a thought, four kinds registered: citation (042), payload {text, stance, source_id} — a statement in thought_id that rests on thought source_id; link (053), payload {relation, system, target, origin} — a source system''s structured link from the thought to another identity in it; relation (084), payload {relation, target, judge_key, confidence, origin} — the consolidation judge''s related, evolves or duplicate verdict on the thought (the newer) and the target thought (the older), or since 102 its distinct (the pair it called unrelated: two near neighbours about different subjects, kept apart), written once — by record_thought_relation, the consolidation pass''s door, though origin `judged` marks the kind and any role holding INSERT on the table (the structure group) can write one — and only ever closed; subject (111), payload {key, by, judge_key, origin} — the thought''s own subject, one standing per thought, written by record_thought_subject and only ever closed. Since 120 a relation is also a work thread''s edge — origin thread, the key of the thread it links — kept by thread_relink as the subjects land and leave (SMD-3306). Validated by kind in thought_facets_validate (check_violation for an unregistered kind or a malformed payload). Active while valid_until is NULL or future and no facet that still exists supersedes it (thought_facet_active); only active citations make thoughts_guard_citation_sources refuse a delete of their source. Migrations 042, 053, 084, 102, 111, 120 / SMD-1712, SMD-1867, SMD-1873, SMD-3117, SMD-3306.';
