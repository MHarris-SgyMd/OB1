-- =============================================================================
-- Migration 057: the write functions append then project — upsert_thought,
--                update_thought and delete_thought write the event first and
--                one projector writes the row in the same transaction; the
--                audit trigger becomes the check under ob1.projecting and
--                appends for a raw write; the vector snapshot the fold reads
--                (SMD-2116; step 2 of SMD-1997's path)
-- =============================================================================
--
-- WHY
--   At 055 the row is written first and the audit trigger derives the event
--   from OLD and NEW afterwards: the log describes what happened, it does not
--   decide it. docs/event-log-as-truth.md (SMD-1997) designates the event
--   the write-side truth for a thought and the row its projection, and
--   SMD-1999 measured the one shape that keeps the extension contract while
--   doing so: the three write functions append the thought_audit row FIRST
--   and call one projector that writes the row in the same transaction;
--   `thoughts` stays a table with a table's DDL surface (a view under its
--   name was NO-GO twice: ADD COLUMN, CREATE INDEX, REFERENCES and a row
--   trigger all fail against a view); the trigger that used to derive the
--   event becomes the check that the projected row is its event's AFTER
--   image. Measured against 053 on one scripted set of writes: the log and
--   the rows identical on every caller-visible column, the three lock-order
--   behaviours held (SMD-1043, SMD-1323, SMD-1462), read-your-writes held,
--   one audit row and one extraction claim per logical write, an empty
--   contributor delta (evals/README.md, the SMD-1999 section). Step 1 (055)
--   put the payload in the event so a projector has something to project;
--   this file is step 2. From the day it lands there is one truth: the row
--   is what its event says, and the trigger refuses a row that is not.
--   "Dual-write" names the period in which the raw in-tree writers
--   (db/ingest-records.ts, review_supersession_proposal, the backfills,
--   042's guard) still write the row first and are trigger-audited — not two
--   sources; step 3 (SMD-2117) moves them onto the projector.
--
-- WHAT
--   1. THE PROJECTOR. ob1_project_thought_event(p_event, p_embedding,
--      p_embedding_model, p_replay) applies ONE event to the row store:
--      capture -> INSERT (the row's created_at from the event when it carries
--      one — a backdating writer's — else the event row's own, never a
--      replay's clock), update -> UPDATE by the event's afters, delete ->
--      DELETE. The live write passes its vector; a replay takes the vector
--      from ob1_embedding_snapshot by (content_fingerprint, embedding_model)
--      — SMD-1998's key, made a table (5 below) — or leaves what stands.
--      FAITHFUL, NOT CORRECTIVE: a key the event does not move stays (018's
--      stale key after a raw content edit stays stale, live and on replay);
--      a vector the event does not flip stays unless the snapshot holds one
--      for the new text; a replayed capture whose text the snapshot does not
--      hold lands with no vector, readable while 015's pass fills it. The
--      one thing a projection fills that the event does not carry is a
--      capture's KEY: derived from the content (003's rule), as the decision
--      says a raw insert's NULL key is filled — and a raw insert's wrong key
--      is corrected the same way, since a capture event carries no key and
--      the check requires the content's; such a row's vector was never in
--      the snapshot (a NULL key never enters it) and re-embeds under 015's
--      pass (run-it, first review pass). THE ORDER a fold replays in is the
--      log's: by seq for rows since ob1_config.audit_seq_exact_since, by
--      (created_at, seq) before it (055's rule, db/README.md). created_at is
--      the TRANSACTION's clock: an older transaction that wins the row lock
--      later is stamped earlier and numbered later, so a replay by the clock
--      inverts that row's history and refuses at its tombstone, while seq —
--      the row-lock serialisation order, since every writer locks the row
--      before it appends — rebuilds every column (run-it, first review pass:
--      eight connections' log). Live, the event projected must be the
--      thought's latest (OB002 otherwise): a re-projection of an earlier
--      event would roll a row back with no event, and PUBLIC executes this
--      function because SECURITY INVOKER writers must. A capture
--      event carrying no content (008's shape, before 055's pass) is refused
--      by name (SQLSTATE OB003), not projected as an empty thought. On a
--      replay a tombstone never refuses: 042's guard runs in detach mode for
--      the DELETE (the citations it detaches are a projection rebuilt apart)
--      and the mode is restored after. The projector announces itself to the
--      row's triggers through three transaction-local settings —
--      ob1.projecting (the event's id), ob1.projecting_thought (the row it
--      writes), ob1.projecting_replay — runs 050's stamp under its own
--      pass-through (ob1.actor_amend = 'backfill': the metadata is already
--      stamped in the event), clears ob1.event (046's rule against a raw
--      write later in the transaction inheriting an earlier call's stance,
--      cites or window), and before it returns clears the three and restores
--      ob1.actor_amend and ob1.cited_delete to what they were: a raw write
--      later in the same transaction meets the appending arm, not the check.
--
--   2. THE THREE FUNCTIONS APPEND THEN PROJECT. upsert_thought (2- and
--      3-argument; 013's 4-argument form delegates to the 3-argument body and
--      is not redefined), update_thought (10-argument), delete_thought
--      (3-argument): the same locks in the same order as at 046 and 042 —
--      update_thought: 036's supersession lock first where the call names
--      supersedes, 033's advisory lock on the fingerprint, 032's row lock
--      FOR NO KEY UPDATE; upsert_thought: the fingerprint lock, then the row
--      lock (new to the 2-argument form, 7 below); delete_thought: 036's
--      supersession lock first, unconditionally, then a row lock FOR NO KEY
--      UPDATE that 042 never took — the tombstone is computed from the row
--      before the DELETE, where the trigger read OLD — which deadlocks with
--      nothing: every delete is already serialised on the supersession lock
--      it holds, the row lock sits where the DELETE's own lock sat, and
--      042's guard locks the citing rows after it, as before (cold read,
--      first review pass) — then the after-image computed in plpgsql (050's two stamp arms and
--      046's diff rule, the functions 055 lifted out), ob1_append_thought_event
--      (046's trigger tail: who from the key, the registry's kind, the trust
--      ceiling, the door, the claim, the late gate), then the projector.
--      Every body clears ob1.event: the event rides the append now, and the
--      setting a raw write later in the transaction would read is left empty
--      (SMD-1999's first review pass found the bodies had stopped setting it
--      and a cascaded row inherited an earlier call's stance). Every refusal
--      path — NOT_FOUND, STALE_READ, DUPLICATE_CONTENT, SUPERSEDES_NOT_FOUND,
--      WOULD_CYCLE, CITED — returns before any append, so a refused call
--      leaves no event; a delete the guard refuses (OB001, raised from the
--      base table's DELETE inside the projector) rolls back the tombstone
--      with the row, since both sit in delete_thought's sub-block — the
--      appended row's seq is spent, so a brain with refused cited deletes
--      has gaps in thought_audit.seq (052's thought_changes orders by it
--      and reads nothing into a gap).
--
--   3. THE TRIGGER IS THE CHECK. thoughts_write_audit, seeing ob1.projecting
--      = <event id>, recomputes the diff from the row it sees and RAISES
--      (SQLSTATE OB002) when the row is not the event's AFTER image or moved
--      a column the event does not name — every projected write, live or
--      replayed, is verified against its event by the trigger that used to
--      write it. Afters rather than before/after pairs: on a replay a
--      cascade may have applied part of a later event already (the successor
--      whose pointer a tombstone nulled), so the state the event asserts is
--      what must hold and the key set moved is a SUBSET of the event's. The
--      vector is a projection (SMD-1998), not the event's claim: its PRESENCE
--      is held on a live write (a flip named, or none — a vector dropped or
--      conjured under an event that names no flip is a divergence) and not
--      on a replay, where the snapshot may miss. THE FOREIGN-ROW RULE: a row
--      OTHER than the event's that moves under its projection is a
--      consequence the schema draws — a tombstone's ON DELETE SET NULL on a
--      successor's pointer (025), 042's guard bumping a citing thought's
--      stamp on a detach — judged on the whole diff (a cascade that flips a
--      vector's presence is not a bump; one that swaps a vector for another
--      is, the vector being a projection the snapshot records): a bump (an
--      empty diff) is nothing; a successor's nulled pointer under a tombstone's
--      projection is appended as its own update event live (as 046 does
--      today: the successor's row says when its pointer went) and skipped on
--      a replay (the log already holds that event and will replay it);
--      anything else refuses. Under ob1.projecting = 'vector' (4 below) the
--      trigger verifies that only the vector moved. WITHOUT ANY SETTING — a
--      raw write from a community schema, an in-tree raw writer, a backfill,
--      042's guard — the trigger appends as 046 does, 055's raw path
--      verbatim: a raw write is audited, never refused, and the log stays
--      complete. THE COMMUNITY-TRIGGER CONTRACT, said here because SMD-1999's
--      C6 applied the community DDL and did not write under a projection: a
--      community `AFTER ... ON thoughts` row trigger that writes a SIDECAR
--      table is untouched; one that writes a `thoughts` row during a
--      function-borne write meets the check — a foreign row must be a bump
--      (a community column the diff rule does not read is free) or, under a
--      tombstone's projection alone, a successor's pointer nulled and nothing
--      else; a write to the event's own row must leave it the event's AFTER
--      image; anything else is refused where today it is merely audited. No
--      schema in the tree does this (the one row trigger, the
--      entity-extraction schema's, writes its own table); test-schema plants
--      one of each kind.
--
--   4. THE REFRESH. ob1_refresh_thought_vector(p_id, p_embedding,
--      p_embedding_model): a vector arriving on a row that already has one is
--      a projection refresh — no event (the log records the vector's
--      presence, never a label change: 046), no updated_at bump (a stamp no
--      event carries cannot be rebuilt; the vector's own time is the
--      snapshot's taken_at), announced as ob1.projecting = 'vector' so the
--      check holds that nothing but the vector and its label moved.
--      update_thought's same-text-with-a-vector arm — db/reembed.ts's shape,
--      the store's re-embed — is this call; reembed keeps calling
--      update_thought, which still owns the stale-read guard, the chunk
--      rewrite and 018's duplicate reports the refresh has no business in.
--      A vector onto a row WITHOUT one is a presence flip and stays an event.
--
--   5. THE SNAPSHOT. ob1_embedding_snapshot (content_fingerprint,
--      embedding_model) -> embedding, dims, taken_at: the vector by its key,
--      what lets a fold rebuild the vector without the provider (SMD-1998
--      measured 100% reuse by this key). SEEDED ONCE by this file from every
--      thoughts row holding all three of key, model and vector — without the
--      seed the snapshot holds rows only for text written after this step,
--      and the first fold re-embeds the corpus gate 1 measured as reused —
--      then FED by a trigger on the row store that records LIVE writes only:
--      under ob1.projecting_replay it does nothing, so a fold never moves a
--      taken_at (the prototype's trigger had no such exclusion — SMD-1997's
--      first review pass); a NULL key, model or vector is skipped; an UPDATE
--      that moves none of the three writes nothing, so a metadata edit
--      projected through the same UPDATE statement moves no taken_at. The
--      trigger names no column (the prototype's named three): a probe that
--      drops embedding_model to stand a pre-021 brain would take a
--      column-bound trigger with it (test-preflight's vector models arm). A
--      raw writer's vector enters it like any other: the row store is what
--      the snapshot trusts today. THE SEED'S REACH, exactly
--      (SMD-1997's third review pass): one (key, model) -> vector pair per
--      thought, for its CURRENT text. A fold lands each thought's capture
--      text first and its later texts after, so an edited thought MISSES at
--      its capture and HITS at its final text; the projector calls no
--      provider on a miss (a NULL vector on a capture, the one before on an
--      update). After a fold every thought's final text carries the seed's
--      vector; rows with an 018 NULL key or no vector re-embed under 015's
--      pass as they do today. Reuse holds for final states, not the states a
--      fold passes through. The fold's input is the log AND this table: a
--      fold onto another server copies both (SMD-2117 owns the copy). What
--      it costs: a second copy of every live vector — 4 KB a row at 1,024
--      float4 dimensions, the size of thoughts.embedding itself — and one
--      upsert per vector written, measured below.
--
--   6. 001's updated_at TRIGGER YIELDS to the projector's stamp for the row
--      ob1.projecting_thought names — the event's created_at, now() on the
--      live path, the original time on a replay — and bumps a cascaded row
--      as 001 bumps it (the first replay smoke had the cascaded row keep its
--      old stamp live and take the event's on replay, the one column that
--      then differed). Guarded on TG_TABLE_NAME: the function serves
--      ob1_agents too (010), whose rows the setting never names.
--
--   7. THE DELTAS AGAINST 055, ACCEPTED BY THE DECISION (five), built as
--      accepted — "no event, no write": an identical re-capture no longer
--      bumps updated_at (046's ON CONFLICT DO UPDATE did — a write that
--      changes nothing is not a write; thought_changes and if_unchanged_since
--      read the log and the row's stamp, and neither should move); an edit
--      whose patch changes nothing writes nothing — no row, no bump — where
--      046 bumped updated_at and recorded no audit row; a vector refresh
--      leaves updated_at alone (4); update_thought's stale-read refusal
--      stands and its second check in the UPDATE's own WHERE — unreachable
--      under the row lock taken first, by 046's own argument — goes with the
--      UPDATE it sat in; the 2-argument upsert_thought takes the row lock the
--      other forms take, under the same advisory lock, so no caller can
--      observe the difference. A caller reading updated_at as "something
--      happened" reads less than before, and more truly. And a sixth the
--      write path forces: a capture whose text a writer taking no
--      fingerprint lock (a raw import beside a live capture) commits between
--      the row read and the projection met 046's ON CONFLICT and merged;
--      the projector's INSERT meets the unique index instead, so both
--      capture forms catch unique_violation on that arm, roll the event
--      back with it, read the row that landed under the lock still held and
--      merge as a re-capture — a savepoint per fresh capture, measured in
--      the cost line (run-it, first review pass).
--
--   8. PINS MOVE WITH THE BODIES. Each function's COMMENT (046's on
--      update_thought said the if_unchanged_since predicate sits in the
--      UPDATE — that path is gone, the sentence rewritten); preflight's
--      recognisers (`atomic capture`, `audit events`, `edit signature`,
--      `delete signature` name this file as the last definer and read the
--      new sentinel); test-schema's sentinel reads. The sentinels the bodies
--      carry, unchanged in meaning: ob1:capture-takes-fingerprint-lock (033),
--      ob1:capture-sets-write-event (046 — the declared event reaches the
--      audit row, by the append itself now), ob1:re-capture-writes-no-provenance
--      (035), ob1:vector-replaces-chunks (022), ob1:unchanged-edit-not-duplicate
--      (018), ob1:supersession-review (036), ob1:capture-event-carries-content
--      and ob1:audit-event-from-the-key (055, in the trigger). New:
--      ob1:capture-appends-then-projects in the three writers and
--      ob1:projection-checked-against-its-event in the trigger — what
--      preflight and test-schema read to tell this trigger from 055's.
--
--   9. THE EVAL'S FATE. SMD-1999's runner (evals/eval-writable-projection.ts)
--      compared the shipped schema against the prototype; once these bodies
--      ship, its baseline IS the prototype and its teardown would drop
--      shipped objects. It is retired with this file: its contract criteria
--      C1–C6 and C10–C12 are test-schema's section on this file, its
--      behaviours C7–C9 (two sessions, read through pg_locks) test-live's,
--      its cost line C13 is measured below; the record of the spike stays in
--      evals/README.md, which says where each criterion lives now.
--
--   COST. Measured on Postgres 16.15 in a container, width 8, no provider,
--      the medians of 200 calls each over five rounds, 056's bodies against
--      this file's on one database: a 3-argument capture with a vector
--      844 us -> 829 us (x0.98), a content edit with a vector 780 us ->
--      858 us (x1.10); the ratio moved x0.61-x1.26 (capture) and
--      x0.85-x1.29 (edit) across the rounds, inside SMD-1999's band
--      (x0.65-x1.8 across fourteen runs) — noise over effect (the first
--      review pass added a savepoint per fresh capture and one index probe
--      per write, and re-measured: the same band). The edit pays the
--      after-image in plpgsql and the snapshot's upsert; the capture the
--      same upsert, the savepoint and one row read more (the 2-argument
--      form's lock). This file's apply, the seed over 200 rows included,
--      14-25 ms; over the
--      dogfood copy's 873 rows with key, model and vector at 1,024 dimensions,
--      30 ms, every seeded vector byte-equal to its row's with the row's stamp
--      as taken_at; the scripted writes and a replay of one thought's log
--      then behaved as test-schema [53] holds.
--
--   NOT HERE, SAID SO. db/reembed.ts does not call the refresh function
--      directly (the ticket's item 4): the stale-read guard, the chunk
--      rewrite and 018's duplicate reports live in update_thought, whose
--      same-text arm IS the refresh (4 above), so the pass keeps calling
--      update_thought and its docblock says the stamp no longer moves. The
--      redaction arm — the projector skipping every event
--      of a redacted thought_id (a redacted thought projects to nothing) — is
--      SMD-1723's, which lands after this file and owns the marker table the
--      fold reads (docs/event-log-as-truth.md, Deletion and forgetting); the
--      decision ordered that redaction no later than this step, and the
--      order is the maintainer's to keep or waive at the merge. The fold
--      itself (db/fold.ts), the raw in-tree writers moving onto the projector
--      (db/ingest-records.ts's INSERT ... ON CONFLICT with its own
--      created_at, review_supersession_proposal, the backfills), a
--      function-borne backdating capture, thought_changes reading a
--      capture's head from the event, and the key of a pre-055 update event
--      derived under 018's rule: SMD-2117. The extraction trigger (016) fires
--      on every projected write as on a raw one, live and on a replay — a
--      fold's claims are SMD-2117's to bound.
--
-- SAFETY
--   Additive: thoughts is untouched (no column, no index; its triggers keep
--   their names and timing, two of their functions are redefined); one table
--   with one trigger on thoughts feeding it; every function is CREATE OR
--   REPLACE under its existing signature — no arity moves; the older
--   update_thought and delete_thought forms are dropped and the ACL carried
--   as 046 and 042 did, which finds nothing on a brain at 046 or later — and
--   no return shape changes (update_thought's
--   updated_at is the row's stamp as it stands after the call, which a
--   no-write arm leaves where it was). The seed is one INSERT ... SELECT over
--   thoughts (SHARE, the length of a read of the vectors) with ON CONFLICT DO
--   NOTHING: idempotent, and a re-apply moves no row. A brain that reverts
--   to 046's bodies (`bun migrate.ts --reapply` runs every file in order, so
--   055 and this file put theirs back last) writes the row first again and
--   is trigger-audited; the log written under either is complete and shaped
--   the same. MINOR under FORK.md's version rules: functions and a table
--   added, none renamed.
--
-- Prerequisites
--   042 (delete_thought's 3-argument form, the citation guard and its
--   ob1.cited_delete), 050 (ob1_stamp_actor, its ob1.actor_amend
--   pass-through, thought_audit.seq), 055 (ob1_thought_diff,
--   ob1_append_thought_event, ob1_actor_stamp, ob1_actor_stamp_kept, the
--   capture event's content). Applied by `bun db/migrate.ts`.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape): the bodies below are plpgsql and would fail at their
-- first call with a bare "does not exist" otherwise.
DO $qc$
BEGIN
  IF to_regprocedure('delete_thought(uuid, jsonb, boolean)') IS NULL
     OR to_regprocedure('thoughts_guard_citation_sources()') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 057 needs 042 (delete_thought(uuid, jsonb, boolean), thoughts_guard_citation_sources); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('ob1_stamp_actor()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'thought_audit' AND column_name = 'seq') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 057 needs 050 (ob1_stamp_actor, thought_audit.seq); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('ob1_thought_diff(text, text, text, jsonb, jsonb, boolean, boolean, uuid, uuid, jsonb, jsonb, text, text, timestamptz)') IS NULL
     OR to_regprocedure('ob1_append_thought_event(uuid, text, text, jsonb, jsonb)') IS NULL
     OR to_regprocedure('ob1_actor_stamp(jsonb)') IS NULL
     OR to_regprocedure('ob1_actor_stamp_kept(jsonb, jsonb)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 057 needs 055 (ob1_thought_diff, ob1_append_thought_event, ob1_actor_stamp, ob1_actor_stamp_kept); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. 001's updated_at trigger yields to the projector's stamp.
--
-- The event's own row takes the event's time (the projector writes it); a
-- row a cascade moves under the projection — a successor's nulled pointer, a
-- citing thought 042's guard touches — is bumped as 001 bumps it. Two IFs:
-- the function serves ob1_agents too (010's ob1_agents_updated_at), and
-- `new.id` is read only on the table the setting can name.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'thoughts' THEN
    IF new.id::text = COALESCE(current_setting('ob1.projecting_thought', true), '') THEN
      RETURN new;
    END IF;
  END IF;
  new.updated_at = now();
  RETURN new;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_updated_at() IS
  'BEFORE UPDATE on thoughts (thoughts_updated_at, 001) and ob1_agents (010): stamps updated_at = now(). Since 057 it yields on thoughts for the one row ob1.projecting_thought names — the projector writes the stamp its event holds (now() live, the event''s time on a replay) — and bumps every other row as before, a row a cascade moves under a projection included. Migration 001 / 057 (SMD-2116).';

-- ---------------------------------------------------------------------------
-- 2. The snapshot: the vector by its key (SMD-1998), fed by the row store.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ob1_embedding_snapshot (
  content_fingerprint text        NOT NULL,
  embedding_model     text        NOT NULL,
  embedding           vector({{EMBEDDING_DIM}}) NOT NULL,
  -- The vector's width as written. On this server every row is the
  -- column's declared width; the value is for a text dump of this table
  -- read onto a server declared at another width (SMD-2117's fold copies
  -- the log and the snapshot), where the column type must be reconciled
  -- before the vectors cast, and a row says which width it carries.
  dims                integer     NOT NULL,
  taken_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (content_fingerprint, embedding_model)
);

COMMENT ON TABLE ob1_embedding_snapshot IS
  'The vector by its key, (content_fingerprint, embedding_model) -> embedding — SMD-1998''s key made a table, what lets a fold rebuild a thought''s vector without the provider. Seeded once by 057 from every thoughts row holding key, model and vector, then fed by thoughts_snapshot_embedding on every LIVE write of a vector, a label or a key (a replay writes nothing here, so a fold never moves a taken_at). No foreign key: a row outlives the thought it came from on purpose — a replayed capture of a deleted thought still finds its vector. dims is the width as written. Migration 057 / SMD-2116.';

CREATE OR REPLACE FUNCTION ob1_snapshot_embedding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- A fold's write is not evidence of when a vector was taken: the row it
  -- lands is what the snapshot already holds (or nothing), and taken_at is
  -- the live write's clock.
  IF COALESCE(current_setting('ob1.projecting_replay', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  -- Every UPDATE reaches here (the trigger names no column: a probe or a
  -- rebuild that drops one would take the trigger with it — 2BP01 — and the
  -- projector's UPDATE names every column on every update event anyway), so
  -- an unmoved vector, label and key write nothing and move no taken_at.
  -- The vectors compared as text, the width read through the real[] cast:
  -- a session with pgvector OFF its search_path (db/test-search-path.ts) has
  -- no `=` for the type and no vector_dims by name, and this body runs in
  -- every writer's session; a cast resolves by type, not by name.
  IF TG_OP = 'UPDATE'
     AND NEW.embedding::text IS NOT DISTINCT FROM OLD.embedding::text
     AND NEW.embedding_model IS NOT DISTINCT FROM OLD.embedding_model
     AND NEW.content_fingerprint IS NOT DISTINCT FROM OLD.content_fingerprint THEN
    RETURN NULL;
  END IF;
  IF NEW.embedding IS NOT NULL AND NEW.embedding_model IS NOT NULL AND NEW.content_fingerprint IS NOT NULL THEN
    INSERT INTO ob1_embedding_snapshot (content_fingerprint, embedding_model, embedding, dims)
    VALUES (NEW.content_fingerprint, NEW.embedding_model, NEW.embedding, array_length(NEW.embedding::real[], 1))
    ON CONFLICT (content_fingerprint, embedding_model) DO UPDATE
      SET embedding = EXCLUDED.embedding, dims = EXCLUDED.dims, taken_at = now();
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION ob1_snapshot_embedding() IS
  'AFTER INSERT OR UPDATE on thoughts (thoughts_snapshot_embedding, 057): upserts the row''s vector into ob1_embedding_snapshot under (content_fingerprint, embedding_model) when all three are set and one of them moved; nothing under ob1.projecting_replay (a fold is not a live write), nothing for a NULL key, label or vector. Migration 057 / SMD-2116.';

DROP TRIGGER IF EXISTS thoughts_snapshot_embedding ON thoughts;
CREATE TRIGGER thoughts_snapshot_embedding
  AFTER INSERT OR UPDATE ON thoughts
  FOR EACH ROW EXECUTE FUNCTION ob1_snapshot_embedding();

-- The seed: every live row's vector under its key, once. ON CONFLICT DO
-- NOTHING: a re-apply, or a brain whose trigger already fed the row, keeps
-- the row it has — the live write's taken_at is the better clock.
INSERT INTO ob1_embedding_snapshot (content_fingerprint, embedding_model, embedding, dims, taken_at)
SELECT t.content_fingerprint, t.embedding_model, t.embedding, vector_dims(t.embedding),
       COALESCE(t.updated_at, t.created_at, now())
  FROM thoughts t
 WHERE t.content_fingerprint IS NOT NULL AND t.embedding_model IS NOT NULL AND t.embedding IS NOT NULL
ON CONFLICT (content_fingerprint, embedding_model) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. The projector: one event onto the row store.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_project_thought_event(
  p_event           uuid,
  p_embedding       vector({{EMBEDDING_DIM}}) DEFAULT NULL,
  p_embedding_model text    DEFAULT NULL,
  p_replay          boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  e            thought_audit%ROWTYPE;
  v_content    text;
  v_fp         text;
  -- By the column's type, not by name: a DECLAREd type is resolved when the
  -- body compiles in the caller's session, under the caller's search_path,
  -- and a brain with pgvector off its path (db/test-search-path.ts) has no
  -- `vector` by name — a 2-argument text capture would have failed on it
  -- (cold read, first review pass). Parameters resolve once, at CREATE.
  v_vec        thoughts.embedding%TYPE;
  v_model      text;
  v_target     text;
  v_found      boolean := false;
  v_prev_amend text := current_setting('ob1.actor_amend', true);
  v_prev_cited text := current_setting('ob1.cited_delete', true);
BEGIN
  SELECT * INTO e FROM thought_audit WHERE id = p_event;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ob1_project_thought_event: no event % in thought_audit', p_event;
  END IF;
  -- Live, the event must be the thought's latest: the writers call this
  -- right after their own append, so it always is — and a caller holding
  -- the capture grants (PUBLIC executes this, as it must for SECURITY
  -- INVOKER writers) could otherwise re-project an earlier event and roll a
  -- row back to a state the log says it left, with no event (run-it, first
  -- review pass). The fold walks the log in order under p_replay, as the
  -- owner. One index probe on thought_audit(thought_id) a write.
  IF NOT p_replay AND EXISTS (SELECT 1 FROM thought_audit a WHERE a.thought_id = e.thought_id AND a.seq > e.seq) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'OB002',
      MESSAGE = 'ob1_project_thought_event: a live projection of an event that is not the thought''s latest — the row would disagree with its log',
      DETAIL  = jsonb_build_object('thought_id', e.thought_id, 'event', p_event, 'seq', e.seq)::text;
  END IF;
  -- The model a replay reads the snapshot under: 006's configured one. Read
  -- on a replay alone — the live path needs no privilege on ob1_config (the
  -- capture role has none; the fold runs as the owner).
  IF p_replay THEN
    SELECT value INTO v_target FROM ob1_config WHERE key = 'embedding_model';
  END IF;

  -- The row's triggers see the event id (the audit trigger checks instead of
  -- writing; 001's stamp yields for this row) and 050's pass-through (the
  -- metadata is already stamped in the event).
  PERFORM set_config('ob1.projecting', p_event::text, true);
  PERFORM set_config('ob1.projecting_thought', e.thought_id::text, true);
  PERFORM set_config('ob1.projecting_replay', CASE WHEN p_replay THEN 'on' ELSE '' END, true);
  PERFORM set_config('ob1.actor_amend', 'backfill', true);
  -- 046's anti-inheritance rule, kept: the setting a raw write would read is
  -- cleared before any row moves, so a cascaded row cannot inherit a stance,
  -- cites or a window declared for another write.
  PERFORM set_config('ob1.event', '', true);

  IF e.action = 'capture' THEN
    IF NOT COALESCE(e.diff ? 'content', false) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'OB003',
        MESSAGE = 'ob1_project_thought_event: the capture event carries no content (008''s shape) — the log is not the payload store for this thought, and the row cannot be projected from it',
        DETAIL  = e.thought_id::text,
        HINT    = 'SELECT backfill_thought_payloads(NULL) fills the capture rows 055 can derive; the fold reports the rest.';
    END IF;
    v_content := e.diff->>'content';
    v_fp      := content_fingerprint_of(v_content);
    IF p_replay THEN
      SELECT s.embedding, s.embedding_model INTO v_vec, v_model
        FROM ob1_embedding_snapshot s
       WHERE s.content_fingerprint = v_fp AND s.embedding_model = v_target;
    ELSE
      v_vec   := p_embedding;
      v_model := CASE WHEN p_embedding IS NULL THEN NULL ELSE p_embedding_model END;
    END IF;
    -- metadata as the event holds it: a payload's `"metadata": null` is
    -- jsonb null on the row (046's COALESCE does not replace it, 050's guard
    -- leaves it) and stays so here — a NULLIF would turn it into SQL NULL,
    -- and the check, applying the same NULLIF, would not see the difference.
    -- An update's after keeps the NULLIF: a raw `SET metadata = NULL` is SQL
    -- NULL, and JSON encodes both the same.
    INSERT INTO thoughts (id, content, content_fingerprint, metadata, embedding, embedding_model, derived_from, supersedes, created_at, updated_at)
    VALUES (
      e.thought_id, v_content, v_fp,
      e.diff->'metadata',
      v_vec, v_model,
      NULLIF(e.diff->'derived_from', 'null'::jsonb),
      (e.diff->>'supersedes')::uuid,
      -- The row's own created_at when the event carries one (a backdating
      -- writer), else the write's clock; updated_at is the write's clock as
      -- 001's default makes it.
      COALESCE((e.diff->>'created_at')::timestamptz, e.created_at), e.created_at);

  ELSIF e.action = 'update' THEN
    IF e.diff ? 'content' THEN
      v_content := e.diff->'content'->>'after';
      IF p_replay THEN
        -- The vector by the new text's key, if a live write ever snapshotted one.
        SELECT s.embedding, s.embedding_model INTO v_vec, v_model
          FROM ob1_embedding_snapshot s
         WHERE s.content_fingerprint = content_fingerprint_of(v_content) AND s.embedding_model = v_target;
        v_found := FOUND;
      ELSE
        -- The live edit's vector, or none: update_thought writes p_embedding beside a new text (018/021).
        v_vec   := p_embedding;
        v_model := CASE WHEN p_embedding IS NULL THEN NULL ELSE p_embedding_model END;
      END IF;
    END IF;
    -- Faithful, not corrective: a key the event does not move stays as it
    -- was (a raw content UPDATE around the functions leaves 018's stale key
    -- live, and the replay leaves it too); a vector the event does not flip
    -- stays unless the snapshot holds one for the new text.
    UPDATE thoughts t SET
      content             = CASE WHEN e.diff ? 'content' THEN v_content ELSE t.content END,
      content_fingerprint = CASE WHEN e.diff ? 'content_fingerprint' THEN e.diff->'content_fingerprint'->>'after'
                                 ELSE t.content_fingerprint END,
      metadata            = CASE WHEN e.diff ? 'metadata' THEN NULLIF(e.diff->'metadata'->'after', 'null'::jsonb) ELSE t.metadata END,
      supersedes          = CASE WHEN e.diff ? 'supersedes' THEN (e.diff->'supersedes'->>'after')::uuid ELSE t.supersedes END,
      derived_from        = CASE WHEN e.diff ? 'derived_from' THEN NULLIF(e.diff->'derived_from'->'after', 'null'::jsonb) ELSE t.derived_from END,
      embedding           = CASE WHEN e.diff ? 'content' AND NOT p_replay THEN v_vec
                                 WHEN e.diff ? 'content' AND (e.diff->>'embedding_present') = 'false' THEN NULL
                                 WHEN e.diff ? 'content' AND v_found THEN v_vec
                                 WHEN e.diff ? 'content' THEN t.embedding
                                 WHEN p_embedding IS NOT NULL THEN p_embedding
                                 WHEN (e.diff->>'embedding_present') = 'false' THEN NULL
                                 ELSE t.embedding END,
      embedding_model     = CASE WHEN e.diff ? 'content' AND NOT p_replay THEN v_model
                                 WHEN e.diff ? 'content' AND (e.diff->>'embedding_present') = 'false' THEN NULL
                                 WHEN e.diff ? 'content' AND v_found THEN v_model
                                 WHEN e.diff ? 'content' THEN t.embedding_model
                                 WHEN p_embedding IS NOT NULL THEN p_embedding_model
                                 WHEN (e.diff->>'embedding_present') = 'false' THEN NULL
                                 ELSE t.embedding_model END,
      updated_at          = e.created_at
    WHERE t.id = e.thought_id;
    -- No row: nothing was projected and the check never ran. A fold that
    -- meets an update before its capture, or after a raw delete, must hear
    -- so rather than report the event applied (cold read, first review pass).
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'OB003',
        MESSAGE = 'ob1_project_thought_event: the update event names a thought with no row — projected out of order, or the row removed around the log',
        DETAIL  = e.thought_id::text;
    END IF;

  ELSIF e.action = 'delete' THEN
    -- On a replay a tombstone never refuses: the delete happened, and 042's
    -- guard (which reads ob1.cited_delete, default refuse) would otherwise
    -- abort the whole fold on a thought that was cited when it went. The
    -- facets it detaches are a projection rebuilt apart.
    IF p_replay THEN
      PERFORM set_config('ob1.cited_delete', 'detach', true);
    END IF;
    -- A tombstone for a row already gone deletes nothing and is not refused:
    -- the state it asserts holds.
    DELETE FROM thoughts WHERE id = e.thought_id;
  ELSE
    RAISE EXCEPTION 'ob1_project_thought_event: unknown action %', e.action;
  END IF;

  -- Cleared and restored before the return: a raw write later in this
  -- transaction meets the appending arm and 050's stamp, not the check and
  -- the pass-through; a raw DELETE meets the guard's mode as the caller had
  -- it (as delete_thought restores its own). A RAISE above leaves them set
  -- — the transaction, or the caller's sub-block, rolls the settings back
  -- with the rows (set_config with is_local is transactional).
  PERFORM set_config('ob1.projecting', '', true);
  PERFORM set_config('ob1.projecting_thought', '', true);
  PERFORM set_config('ob1.projecting_replay', '', true);
  PERFORM set_config('ob1.actor_amend', COALESCE(v_prev_amend, ''), true);
  PERFORM set_config('ob1.cited_delete', COALESCE(v_prev_cited, ''), true);
  RETURN e.thought_id;
END;
$$;

COMMENT ON FUNCTION ob1_project_thought_event(uuid, vector, text, boolean) IS
  'The projector (SMD-1997, step 2): applies one thought_audit event to the thoughts row — capture -> INSERT (the row''s created_at from the event when it carries one, else the event''s own), update -> UPDATE by the event''s afters (refused, SQLSTATE OB003, when no row stands: the event is out of order or the row went around the log), delete -> DELETE (a row already gone is nothing to refuse) — and returns the thought id. Live (p_replay false) the event must be the thought''s latest by seq, else SQLSTATE OB002: a re-projection of an earlier event would roll the row back with no event. A fold replays in the log''s order — seq since ob1_config.audit_seq_exact_since, (created_at, seq) before it (055''s rule; created_at is the transaction''s clock and inverts a row''s history). Faithful, not corrective: a key the event does not move stays, a vector the event does not flip stays unless (on a replay) ob1_embedding_snapshot holds one for the new text; live, the caller''s vector and label are written. Refuses a capture event without content (SQLSTATE OB003). Announces itself in ob1.projecting (the event id), ob1.projecting_thought and ob1.projecting_replay so the audit trigger checks instead of appending and 001''s stamp yields; runs 050''s stamp under ob1.actor_amend = ''backfill''; clears ob1.event; on a replay runs the citation guard in detach mode. Clears the three and restores ob1.actor_amend and ob1.cited_delete before returning. Called by upsert_thought, update_thought and delete_thought (live) and by the fold (SMD-2117, p_replay). Migration 057 / SMD-2116.';

-- ---------------------------------------------------------------------------
-- 4. The refresh: a vector onto a row that has one — no event, no bump.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_refresh_thought_vector(
  p_id              uuid,
  p_embedding       vector({{EMBEDDING_DIM}}),
  p_embedding_model text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_prev_proj    text := current_setting('ob1.projecting', true);
  v_prev_thought text := current_setting('ob1.projecting_thought', true);
BEGIN
  -- As the projector: the announcing settings restored to what the caller
  -- had, and 046's handoff cleared — a caller that set ob1.event and called
  -- this directly would otherwise leave it for the next raw write in the
  -- transaction to inherit (cold read, first review pass).
  PERFORM set_config('ob1.event', '', true);
  PERFORM set_config('ob1.projecting', 'vector', true);
  PERFORM set_config('ob1.projecting_thought', p_id::text, true);
  UPDATE thoughts SET embedding = p_embedding, embedding_model = p_embedding_model
   WHERE id = p_id;
  PERFORM set_config('ob1.projecting', COALESCE(v_prev_proj, ''), true);
  PERFORM set_config('ob1.projecting_thought', COALESCE(v_prev_thought, ''), true);
END;
$$;

COMMENT ON FUNCTION ob1_refresh_thought_vector(uuid, vector, text) IS
  'A projection refresh (SMD-1997, step 2): writes a vector and its label onto a thought that already has one, under ob1.projecting = ''vector'' — the audit trigger verifies that nothing but the vector moved, its presence included (SQLSTATE OB002 otherwise: a NULL onto a vector, or a vector onto a row without one, is an event and is refused here), 001''s stamp yields, so no event is appended and updated_at does not move; the snapshot trigger records the new vector under the row''s key. update_thought calls it for a same-text edit that carries a vector (the re-embed''s shape). A vector onto a row without one is a presence flip and an event, not this. Migration 057 / SMD-2116.';

-- ---------------------------------------------------------------------------
-- 5. The audit trigger: the check under a projection, the writer for a raw
--    write (055's raw path, verbatim).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION thoughts_write_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_proj   text := COALESCE(current_setting('ob1.projecting', true), '');
  v_raw    text;
  event    jsonb;
  v_action text;
  v_id     uuid;
  v_source text;
  v_diff   jsonb;
  e        thought_audit%ROWTYPE;
BEGIN
  v_action := CASE TG_OP WHEN 'INSERT' THEN 'capture' WHEN 'UPDATE' THEN 'update' ELSE 'delete' END;
  v_id     := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  v_source := CASE WHEN TG_OP = 'DELETE' THEN OLD.metadata->>'source' ELSE NEW.metadata->>'source' END;

  /**
   * ob1:capture-event-carries-content — the rule is ob1_thought_diff's (046's
   * diff with the three additions of 055: a capture's content and, when the
   * writer set one, its created_at; an update's key move). The row's
   * created_at is carried only when it differs from the transaction's now()
   * — a defaulted column equals it and says nothing a replay could not
   * supply from the event's own clock; a writer's own value (a backdating
   * ingester's) is what a replay could not know otherwise. Computed first,
   * on every path: the check below compares it to the event, the raw path
   * appends it.
   */
  v_diff := ob1_thought_diff(
    v_action,
    OLD.content, NEW.content,
    OLD.metadata, NEW.metadata,
    OLD.embedding IS NOT NULL, NEW.embedding IS NOT NULL,
    OLD.supersedes, NEW.supersedes,
    OLD.derived_from, NEW.derived_from,
    OLD.content_fingerprint, NEW.content_fingerprint,
    CASE WHEN TG_OP = 'INSERT' AND NEW.created_at IS DISTINCT FROM now() THEN NEW.created_at END);

  IF v_proj = 'vector' THEN
    -- ob1:projection-checked-against-its-event — a CONTRACT SENTINEL, not
    -- prose (the 014 convention); preflight's `audit events` and test-schema
    -- read it. A refresh moves the vector and its label and nothing else:
    -- the label is not in the diff, and the vector's PRESENCE must not move
    -- either — a vector arriving on a row without one, or a NULL replacing
    -- one, is an event (046 records the presence), not a refresh, so the
    -- diff must be empty (cold read, first review pass: the prototype
    -- stripped embedding_present before comparing, and a refresh could blank
    -- a vector with no trace in the log).
    IF TG_OP <> 'UPDATE' OR v_diff <> '{}'::jsonb THEN
      RAISE EXCEPTION USING
        ERRCODE = 'OB002',
        MESSAGE = 'thoughts_write_audit: a vector refresh changed more than the vector, or moved its presence — that is an event, not a refresh',
        DETAIL  = v_diff::text;
    END IF;
    RETURN NULL;
  ELSIF v_proj <> '' THEN
    IF v_proj !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION USING ERRCODE = 'OB002',
        MESSAGE = 'thoughts_write_audit: ob1.projecting is neither ''vector'' nor an event id', DETAIL = v_proj;
    END IF;
    SELECT * INTO e FROM thought_audit WHERE id = v_proj::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'OB002',
        MESSAGE = 'thoughts_write_audit: ob1.projecting names an event that is not in the log', DETAIL = v_proj;
    END IF;
    IF e.thought_id <> v_id THEN
      -- ANOTHER row moved under this event's projection: a consequence the
      -- schema itself draws, judged on the WHOLE diff (a cascade that also
      -- moved a vector is not a bump). A tombstone's ON DELETE SET NULL
      -- (025) writes every successor's pointer; 042's citation guard bumps a
      -- citing thought's updated_at on a detach.
      IF v_diff = '{}'::jsonb THEN
        RETURN NULL;  -- a bump (updated_at is not in the diff): nothing to record
      END IF;
      IF e.action = 'delete' AND TG_OP = 'UPDATE'
         AND v_diff = jsonb_build_object('supersedes', jsonb_build_object('before', e.thought_id, 'after', NULL)) THEN
        -- The FK's consequence. Live: audited as its own update, as 046 does
        -- (the successor's row says when its pointer went). Replay: the log
        -- already holds that event and will replay it — appending again
        -- would double the log.
        IF COALESCE(current_setting('ob1.projecting_replay', true), '') <> 'on' THEN
          PERFORM ob1_append_thought_event(v_id, 'update', NEW.metadata->>'source', v_diff, NULL);
        END IF;
        RETURN NULL;
      END IF;
      RAISE EXCEPTION USING ERRCODE = 'OB002',
        MESSAGE = 'thoughts_write_audit: a row other than the event''s moved under its projection',
        DETAIL  = jsonb_build_object('event', jsonb_build_object('thought_id', e.thought_id, 'action', e.action),
                                     'row', jsonb_build_object('thought_id', v_id, 'action', v_action, 'diff', v_diff))::text;
    END IF;

    -- The vector's PRESENCE: live, the projector writes what the event says
    -- (a flip named, or none), so a vector dropped or conjured under an event
    -- that names no flip is a divergence. On a replay the snapshot may miss,
    -- so presence is not held there.
    IF COALESCE(current_setting('ob1.projecting_replay', true), '') <> 'on'
       AND (e.diff->'embedding_present') IS DISTINCT FROM (v_diff->'embedding_present') THEN
      RAISE EXCEPTION USING ERRCODE = 'OB002',
        MESSAGE = 'thoughts_write_audit: the projection moved the vector''s presence in a way its event does not name',
        DETAIL  = jsonb_build_object('event', e.diff->'embedding_present', 'row', v_diff->'embedding_present')::text;
    END IF;
    v_diff := v_diff - 'embedding_present';  -- the vector itself is a projection (SMD-1998), not the event's claim
    IF e.action <> v_action THEN
      RAISE EXCEPTION USING ERRCODE = 'OB002',
        MESSAGE = 'thoughts_write_audit: the projected row''s action is not the event''s',
        DETAIL  = jsonb_build_object('event', e.action, 'row', v_action)::text;
    END IF;
    -- The event's AFTER image against the row, and nothing moved that the
    -- event does not name. Afters rather than before/after pairs: on a replay
    -- a cascade may have applied part of a later event already (the successor
    -- whose pointer a tombstone nulled), so its before differs and its diff
    -- is a subset — the state the event asserts is what must hold.
    IF TG_OP = 'INSERT' THEN
      -- The key is not in a capture event (003's rule lives in the functions
      -- and the projector derives it from the content): derived here the same
      -- way, so a row that claims another key under a capture's projection is
      -- refused (cold read, first review pass).
      IF (e.diff->>'content') IS DISTINCT FROM NEW.content
         OR content_fingerprint_of(e.diff->>'content') IS DISTINCT FROM NEW.content_fingerprint
         OR (e.diff->'metadata') IS DISTINCT FROM NEW.metadata
         OR (e.diff ? 'created_at' AND (e.diff->>'created_at')::timestamptz IS DISTINCT FROM NEW.created_at)
         OR NULLIF(e.diff->'derived_from', 'null'::jsonb) IS DISTINCT FROM NEW.derived_from
         OR (e.diff->>'supersedes')::uuid IS DISTINCT FROM NEW.supersedes THEN
        RAISE EXCEPTION USING ERRCODE = 'OB002',
          MESSAGE = 'thoughts_write_audit: the projected row diverges from its capture event',
          DETAIL  = jsonb_build_object('event', e.diff - 'content', 'row', v_diff - 'content')::text;
      END IF;
    ELSIF TG_OP = 'DELETE' THEN
      -- The row projected away must be the one the tombstone describes (008
      -- keeps it in full): live, delete_thought read it one statement
      -- earlier; on a replay this is the difference between "the log said
      -- what was there" and "it was checked" (cold read, first review pass:
      -- the prototype checked captures and updates alone).
      -- jsonb null and SQL NULL read as one on both sides: a raw row's
      -- NULL metadata is a JSON null in its tombstone (jsonb_build_object),
      -- and the row itself may hold either.
      IF (e.diff->>'previous_content') IS DISTINCT FROM OLD.content
         OR NULLIF(e.diff->'previous_metadata', 'null'::jsonb) IS DISTINCT FROM NULLIF(OLD.metadata, 'null'::jsonb)
         OR NULLIF(e.diff->'previous_derived_from', 'null'::jsonb) IS DISTINCT FROM NULLIF(OLD.derived_from, 'null'::jsonb)
         OR (e.diff->>'previous_supersedes')::uuid IS DISTINCT FROM OLD.supersedes THEN
        RAISE EXCEPTION USING ERRCODE = 'OB002',
          MESSAGE = 'thoughts_write_audit: the row projected away diverges from its tombstone',
          DETAIL  = jsonb_build_object('event', e.diff - 'previous_content', 'row', v_diff - 'previous_content')::text;
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      IF NOT (SELECT COALESCE(bool_and(k IN (SELECT jsonb_object_keys(e.diff))), true) FROM jsonb_object_keys(v_diff) k) THEN
        RAISE EXCEPTION USING ERRCODE = 'OB002',
          MESSAGE = 'thoughts_write_audit: the projection moved a column its event does not name',
          DETAIL  = jsonb_build_object('event', e.diff - 'embedding_present', 'row', v_diff)::text;
      END IF;
      IF (e.diff ? 'content' AND (e.diff->'content'->>'after') IS DISTINCT FROM NEW.content)
         OR (e.diff ? 'metadata' AND NULLIF(e.diff->'metadata'->'after', 'null'::jsonb) IS DISTINCT FROM NEW.metadata)
         OR (e.diff ? 'supersedes' AND (e.diff->'supersedes'->>'after')::uuid IS DISTINCT FROM NEW.supersedes)
         OR (e.diff ? 'derived_from' AND NULLIF(e.diff->'derived_from'->'after', 'null'::jsonb) IS DISTINCT FROM NEW.derived_from)
         OR (e.diff ? 'content_fingerprint' AND (e.diff->'content_fingerprint'->>'after') IS DISTINCT FROM NEW.content_fingerprint) THEN
        RAISE EXCEPTION USING ERRCODE = 'OB002',
          MESSAGE = 'thoughts_write_audit: the projected row diverges from its update event',
          DETAIL  = jsonb_build_object('event', e.diff - 'embedding_present', 'row', v_diff)::text;
      END IF;
    END IF;
    RETURN NULL;
  END IF;

  /**
   * A raw write — 046's path as 055 left it. The event is read ONCE and the
   * setting cleared, so a raw write later in the same transaction cannot
   * inherit a stance, cites or window declared for another row. A tombstone
   * declares nothing: on DELETE the event is not read at all
   * (thoughts_delete_clears_event, 046's BEFORE DELETE statement trigger,
   * clears it before any row work). A value that does not begin as an
   * object is a hand-set thing that is no event; one that begins as an
   * object but is malformed fails the write loudly (046).
   */
  v_raw := current_setting('ob1.event', true);
  IF v_raw IS NOT NULL AND v_raw <> '' THEN
    PERFORM set_config('ob1.event', '', true);
    IF TG_OP <> 'DELETE' AND v_raw ~ '^\s*\{' THEN
      event := v_raw::jsonb;
    END IF;
  END IF;

  /**
   * An update that changed nothing is not an event (008). 046: an unchanged
   * write that DECLARED an event is an event — a restatement with a stance,
   * cites or a window is recorded with an empty diff; one carrying only a
   * trust or an actor_kind goes on to the key's word in the append, where
   * the late gate decides. (`?|` on a NULL event is NULL; NOT NULL is NULL;
   * the IF takes the row — so the NULL case is spelled: no event, no row.)
   */
  IF TG_OP = 'UPDATE' AND v_diff = '{}'::jsonb
     AND NOT COALESCE(event ?| ARRAY['stance', 'cites', 'valid_from', 'valid_until', 'trust', 'actor_kind'], false) THEN
    RETURN NULL;
  END IF;

  -- ob1:audit-event-from-the-key holds here through ob1_append_thought_event,
  -- which carries the sentinel and the rule: who from the key and the
  -- registry, the ceiling, the door, the claim filed, 046's late gate.
  PERFORM ob1_append_thought_event(v_id, v_action, v_source, v_diff, event);
  RETURN NULL;  -- AFTER trigger; the return value is ignored.
END;
$$;

COMMENT ON FUNCTION thoughts_write_audit() IS
  'AFTER INSERT OR UPDATE OR DELETE on thoughts (thoughts_audit, 008). Since 057 two arms: under ob1.projecting = <event id> it is the CHECK — recomputes the diff from the row through ob1_thought_diff and raises SQLSTATE OB002 unless the row is the event''s AFTER image and moved only columns the event names (the vector''s presence held on a live write, not a replay; a row other than the event''s accepted as a bump or as a tombstone''s nulled successor pointer, which it appends live and skips on a replay); under ob1.projecting = ''vector'' it holds that only the vector moved. Without a setting — a raw write — it appends as 046/055 did: derives the event from OLD and NEW, holds 008''s no-op guard, reads and clears the ob1.event handoff once, and appends through ob1_append_thought_event. Migration 008 / 025 / 046 / 055 / 057 (SMD-2116).';

-- ---------------------------------------------------------------------------
-- 6. upsert_thought(text, jsonb) — the 2-argument form (PostgREST callers by
--    name, the two-step capture fallback; the servers use the 3- and
--    4-argument forms). 046's body up to the write; the write is an append
--    and a projection.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_thought(p_content text, p_payload jsonb DEFAULT '{}')
RETURNS jsonb AS $$
DECLARE
  v_fingerprint text;
  v_id          uuid;
  v_existed     boolean := false;
  v_event       jsonb;
  v_old_meta    jsonb;
  v_new_meta    jsonb;
  v_diff        jsonb;
  v_ev          uuid;
BEGIN
  -- 005's guard, carried forward verbatim.
  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION
      'upsert_thought: p_payload must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_payload);
  END IF;

  -- 008's actor, as the 3-argument form has read it since then (033): the
  -- append attributes the capture through the two-step fallback instead of
  -- recording NULL. Transaction-local.
  IF p_payload ? 'actor' THEN
    PERFORM set_config('ob1.actor', p_payload->>'actor', true);
  END IF;

  -- 046: the write event's shape, refused here as a bad payload is. 057: the
  -- event rides the append, and the setting a raw write later in this
  -- transaction would read is cleared here, as 046 cleared it before its
  -- write.
  v_event := validate_write_event(p_payload->'event');
  PERFORM set_config('ob1.event', '', true);

  v_fingerprint := content_fingerprint_of(p_content);

  -- ob1:capture-takes-fingerprint-lock — a CONTRACT SENTINEL, not prose (the
  -- 014 convention); preflight's `atomic capture` reads it. 033: the lock 018
  -- takes for an edit that would take this key, spelled the same, taken
  -- before the row read so a concurrent writer of this text has committed
  -- before the read runs (READ COMMITTED).
  PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0));

  -- 057: the row read the 3-argument form has had since 035, under the same
  -- advisory lock — 046's form was a pure INSERT ... ON CONFLICT with no row
  -- lock. A named delta, unobservable to a caller: the advisory lock already
  -- serialises every writer of this text.
  SELECT id, metadata INTO v_id, v_old_meta
    FROM thoughts WHERE content_fingerprint = v_fingerprint FOR NO KEY UPDATE;

  -- ob1:capture-sets-write-event — a CONTRACT SENTINEL, not prose (the 014
  -- convention); preflight's `atomic capture` reads it. 046: the declared
  -- event reaches the audit row — since 057 by the append itself, not by a
  -- setting the trigger reads.
  -- ob1:capture-appends-then-projects — a CONTRACT SENTINEL, not prose (the
  -- 014 convention); preflight's `atomic capture` reads it. 057: the event
  -- is appended first and the row projected from it.
  v_existed := FOUND;
  IF NOT v_existed THEN
    BEGIN
      v_id       := gen_random_uuid();
      v_new_meta := ob1_actor_stamp(COALESCE(p_payload->'metadata', '{}'::jsonb));
      v_diff     := ob1_thought_diff('capture', NULL, p_content, NULL, v_new_meta, false, false,
                                     NULL, NULL, NULL, NULL, NULL, v_fingerprint);
      v_ev       := ob1_append_thought_event(v_id, 'capture', v_new_meta->>'source', v_diff, v_event);
      IF v_ev IS NULL THEN
        RAISE EXCEPTION 'upsert_thought: the append recorded no capture event for %', v_id;
      END IF;
      PERFORM ob1_project_thought_event(v_ev);
    EXCEPTION WHEN unique_violation THEN
      -- A writer that takes no fingerprint lock — a raw import, a backfill,
      -- a community schema — committed this text between the row read and
      -- the projection. 046's INSERT ... ON CONFLICT merged into it; the
      -- projector's INSERT meets the unique index. The event rolls back with
      -- this block; the row that landed is read under the lock still held
      -- and merged as a re-capture (run-it, first review pass).
      SELECT id, metadata INTO v_id, v_old_meta
        FROM thoughts WHERE content_fingerprint = v_fingerprint FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE;
      END IF;
      v_existed := true;
      v_ev := NULL;
    END;
  END IF;
  IF v_existed THEN
    -- A re-capture: the metadata merged as 046's ON CONFLICT merged it, the
    -- stamp kept (050: the mark follows the content, and the content is the
    -- same), 046's no-op gate — an update event only when the merge changed
    -- something or the envelope declared stance, cites or a window; a write
    -- that changes nothing writes nothing and moves no updated_at (057's
    -- named delta).
    v_new_meta := ob1_actor_stamp_kept(v_old_meta || COALESCE(p_payload->'metadata', '{}'::jsonb), v_old_meta);
    v_diff     := ob1_thought_diff('update', p_content, p_content, v_old_meta, v_new_meta, false, false,
                                   NULL, NULL, NULL, NULL, v_fingerprint, v_fingerprint);
    IF v_diff <> '{}'::jsonb OR COALESCE(v_event ?| ARRAY['stance', 'cites', 'valid_from', 'valid_until', 'trust', 'actor_kind'], false) THEN
      v_ev := ob1_append_thought_event(v_id, 'update', v_new_meta->>'source', v_diff, v_event);
      IF v_ev IS NOT NULL THEN  -- 046's late gate may drop an unchanged write carrying only a trust or an actor_kind
        PERFORM ob1_project_thought_event(v_ev);
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION upsert_thought(text, jsonb) IS
  'Capture without a vector: content + metadata, merged into the row holding the same normalised text. Reads p_payload.actor (008, here since 033) for the audit row. Takes the fingerprint advisory lock before the row read (033), the one update_thought takes, so a capture and an edit of one text are serialised (READ COMMITTED), and since 057 locks the row it lands on FOR NO KEY UPDATE as the 3-argument form does. Refuses a non-object payload (005). Reads no provenance from the envelope. Reads p_payload.event (046) — {stance, cites, valid_from, valid_until, trust, actor_kind} — validated by validate_write_event and carried by the append. Since 057 the event is appended first (ob1_append_thought_event) and the row projected from it (ob1_project_thought_event); a re-capture that changes nothing writes nothing and moves no updated_at. Called by PostgREST clients by name and the two-step capture fallback; the servers capture through the 3- and 4-argument forms. Migration 003 / 005 / 033 / 035 / 046 / 057 (SMD-2116).';

-- ---------------------------------------------------------------------------
-- 7. upsert_thought(text, jsonb, vector) — the atomic capture. 046's body up
--    to the write; the write is an append and a projection, the vector
--    riding the projection or, on a re-capture with nothing to record, a
--    refresh.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_thought(
  p_content   text,
  p_payload   jsonb,
  p_embedding vector({{EMBEDDING_DIM}})
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_fingerprint    text;
  v_id             uuid;
  -- 022: whether a row was there to lock, and the model its vector — and so
  -- its windows — was labelled with before this write (NULL: unknown). 035:
  -- read for every capture, so `existed` in the return is always right.
  v_existed        boolean := false;
  v_old_label      text;
  -- 057: the rest of the row the after-image is computed from.
  v_old_meta       jsonb;
  v_old_has_vec    boolean;
  v_old_sup        uuid;
  v_old_derived    jsonb;
  -- 035: the row's pointer after the write — the fresh row's, or the one the
  -- existing row keeps — returned so a caller told `existed` can say what
  -- stands instead of guessing.
  v_supersedes_now uuid;
  -- 025: the provenance the envelope carries, if any — written on a fresh
  -- row only (035).
  v_derived        jsonb;
  v_supersedes     text  := p_payload->>'supersedes';
  v_event          jsonb;  -- 046
  v_new_meta       jsonb;
  v_diff           jsonb;
  v_ev             uuid;
  v_label          text := p_payload->>'embedding_model';  -- 021
BEGIN
  /**
   * Migration 005's guard, carried forward verbatim.
   *
   * This is the trap in redefining a function from a later migration: CREATE OR
   * REPLACE takes the whole body, so every change made to it in between is
   * silently reverted. Anything that redefines upsert_thought again must carry
   * this, the actor, the event and the locks forward too.
   */
  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION
      'upsert_thought: p_payload must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_payload);
  END IF;

  -- 025: derived_from is validated HERE — the write is the choke point, or an
  -- untrusted-input hole (SMD-1253). 033: through 032's validate_derived_from,
  -- the one copy of the rule. 035: validated before the write is known to be
  -- a dedup, so a bad reference is refused whether or not the text is new.
  v_derived := validate_derived_from(p_payload->'derived_from');

  -- 025: supersedes existence is the self-FK's job; check only its SHAPE here,
  -- so a bad string fails with a message about supersedes rather than a raw
  -- uuid cast error, and the FK reports a missing target.
  IF v_supersedes IS NOT NULL
     AND v_supersedes !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION
      'upsert_thought: supersedes must be a thought UUID string, got %.', v_supersedes;
  END IF;

  -- Transaction-local, so it cannot outlive this call on a pooled connection.
  IF p_payload ? 'actor' THEN
    PERFORM set_config('ob1.actor', p_payload->>'actor', true);
  END IF;

  -- 046: the write event's shape, refused here as a bad derived_from is. 057:
  -- the event rides the append; the setting a raw write later in this
  -- transaction would read is cleared here, as 046 cleared it before its write.
  v_event := validate_write_event(p_payload->'event');
  PERFORM set_config('ob1.event', '', true);

  v_fingerprint := content_fingerprint_of(p_content);

  -- 035: no supersession lock here. 033 took it first when the envelope named
  -- supersedes, to order the ON CONFLICT fill of a NULL pointer against
  -- update_thought's cycle walk; the fill is gone, and the pointer a fresh
  -- row writes is one no concurrent walk can reach.

  -- ob1:capture-takes-fingerprint-lock — a CONTRACT SENTINEL, not prose (the
  -- 014 convention); preflight's `atomic capture` reads it. 033: the lock 018
  -- takes for an edit that would take this key, spelled the same. Taken
  -- BEFORE the row read, so a concurrent writer of this text — an edit
  -- taking the key, a first capture racing this one, an edit moving another
  -- row onto it — has committed before the read runs and the read finds its
  -- row (READ COMMITTED: a fresh snapshot per statement).
  PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0));

  -- 022/035: the row this capture lands on, if any, locked — so the write
  -- below lands on THIS row, not on one a concurrent writer commits meanwhile
  -- — and its label before the write, which says whether its windows still
  -- hold. FOR NO KEY UPDATE: ordered against update_thought's row lock, not
  -- against the FOR KEY SHARE every foreign key onto this row holds. 057: the
  -- rest of the row too, for the after-image.
  SELECT id, embedding_model, metadata, embedding IS NOT NULL, supersedes, derived_from
    INTO v_id, v_old_label, v_old_meta, v_old_has_vec, v_old_sup, v_old_derived
    FROM thoughts WHERE content_fingerprint = v_fingerprint FOR NO KEY UPDATE;
  v_existed := FOUND;

  -- ob1:capture-sets-write-event — a CONTRACT SENTINEL, not prose (the 014
  -- convention); preflight's `atomic capture` check reads it. 046: the
  -- declared event reaches the audit row — since 057 by the append itself.
  -- ob1:capture-appends-then-projects — a CONTRACT SENTINEL, not prose (the
  -- 014 convention); preflight's `atomic capture` reads it. 057: the event
  -- is appended first and the row projected from it, the caller's vector
  -- and label (021) riding the projection.
  IF NOT v_existed THEN
    BEGIN
      v_id       := gen_random_uuid();
      -- 050: a new text — the writer from the envelope. 025: derived_from and
      -- supersedes written on a fresh row, validated above.
      v_new_meta := ob1_actor_stamp(COALESCE(p_payload->'metadata', '{}'::jsonb));
      v_diff     := ob1_thought_diff('capture', NULL, p_content, NULL, v_new_meta, false, p_embedding IS NOT NULL,
                                     NULL, v_supersedes::uuid, NULL, v_derived, NULL, v_fingerprint);
      v_ev       := ob1_append_thought_event(v_id, 'capture', v_new_meta->>'source', v_diff, v_event);
      IF v_ev IS NULL THEN
        RAISE EXCEPTION 'upsert_thought: the append recorded no capture event for %', v_id;
      END IF;
      PERFORM ob1_project_thought_event(v_ev, p_embedding, v_label);
      v_supersedes_now := v_supersedes::uuid;
    EXCEPTION WHEN unique_violation THEN
      -- A writer that takes no fingerprint lock — a raw import, a backfill,
      -- a community schema — committed this text between the row read and
      -- the projection. 046's INSERT ... ON CONFLICT merged into it; the
      -- projector's INSERT meets the unique index. The event rolls back with
      -- this block; the row that landed is read under the lock still held
      -- and merged as a re-capture below (run-it, first review pass).
      SELECT id, embedding_model, metadata, embedding IS NOT NULL, supersedes, derived_from
        INTO v_id, v_old_label, v_old_meta, v_old_has_vec, v_old_sup, v_old_derived
        FROM thoughts WHERE content_fingerprint = v_fingerprint FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE;
      END IF;
      v_existed := true;
      v_ev := NULL;
    END;
  END IF;
  IF v_existed THEN
    -- ob1:re-capture-writes-no-provenance — a CONTRACT SENTINEL, not prose
    -- (the 014 convention); preflight's `atomic capture` reads it. 035: the
    -- envelope's derived_from and supersedes are NOT written on an existing
    -- row — the diff below carries the old values on both sides, so the
    -- event names no move and the projector leaves them. Setting, changing
    -- or clearing provenance on an existing thought is update_thought's,
    -- through its p_provenance envelope (032).
    -- 050: the same text — the mark as it was. 046's gate: an update event
    -- only when the merge changed something, the vector's presence flipped
    -- or the envelope declared stance, cites or a window.
    v_new_meta := ob1_actor_stamp_kept(v_old_meta || COALESCE(p_payload->'metadata', '{}'::jsonb), v_old_meta);
    v_diff     := ob1_thought_diff('update', p_content, p_content, v_old_meta, v_new_meta,
                                   v_old_has_vec, v_old_has_vec OR p_embedding IS NOT NULL,
                                   v_old_sup, v_old_sup, v_old_derived, v_old_derived, v_fingerprint, v_fingerprint);
    IF v_diff <> '{}'::jsonb OR COALESCE(v_event ?| ARRAY['stance', 'cites', 'valid_from', 'valid_until', 'trust', 'actor_kind'], false) THEN
      v_ev := ob1_append_thought_event(v_id, 'update', v_new_meta->>'source', v_diff, v_event);
    END IF;
    IF v_ev IS NOT NULL THEN
      -- The vector rides the projection: kept when none arrives (021), the
      -- caller's when one does.
      PERFORM ob1_project_thought_event(v_ev, p_embedding, v_label);
    ELSIF p_embedding IS NOT NULL THEN
      -- No event to project, a vector to place: a projection refresh — no
      -- event, no updated_at (057's named delta).
      PERFORM ob1_refresh_thought_vector(v_id, p_embedding, v_label);
    END IF;
    v_supersedes_now := v_old_sup;
  END IF;

  -- ob1:vector-replaces-chunks — a CONTRACT SENTINEL, not prose (the 014
  -- convention); preflight's `atomic capture` check reads it. 022: the windows
  -- stay while the label vouches for them — the row's vector was labelled
  -- with a model and the vector arriving is labelled with the same one — and
  -- go in every other case: a label unknown on either side, or another model.
  -- No vector arriving keeps vector, label and windows alike; a fresh insert
  -- runs no DELETE (v_existed). The 4-argument form delegates here and then
  -- writes the caller's windows; update_thought does the same for an edit.
  IF p_embedding IS NOT NULL AND v_existed
     AND (v_old_label = v_label) IS NOT TRUE THEN
    DELETE FROM thought_chunks WHERE thought_id = v_id;
  END IF;

  -- 035: `existed` — the text was already captured; metadata merged, vector
  -- and windows by 021/022, provenance in the envelope not written — and
  -- `supersedes`, the row's pointer as it stands after this write.
  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint, 'existed', v_existed, 'supersedes', v_supersedes_now);
END;
$$;

COMMENT ON FUNCTION upsert_thought(text, jsonb, vector) IS
  'Atomic capture: content + metadata + embedding in one call. Reads p_payload.actor (008), p_payload.embedding_model (021), p_payload.derived_from / p_payload.supersedes (025) and p_payload.event (046: {stance, cites, valid_from, valid_until, trust, actor_kind}, validated by validate_write_event and carried by the append) from the envelope. derived_from is validated by validate_derived_from — an array of existing thought UUIDs, or the write is refused (SMD-1253); supersedes'' existence is the self-FK''s, checked where the column is written — a first capture (035). Takes the fingerprint advisory lock before the row read (033), the one update_thought takes, so a capture and an edit of one text are serialised (READ COMMITTED); no supersession lock (035). Since 057 the event is appended first (ob1_append_thought_event) and the row projected from it (ob1_project_thought_event) with the caller''s vector: a fresh text is a capture event; a re-capture is an update event only when the metadata merge, the vector''s presence or a declared event gives it one, a vector onto a row that has one is a refresh with no event and no updated_at, and a re-capture that changes nothing writes nothing. On a re-capture the label follows the vector, the chunk rows stay only while the label vouches for them (022), and the envelope''s provenance is NOT written (035) — setting, changing or clearing it is update_thought''s p_provenance (032). Returns {id, fingerprint, existed, supersedes}. Migration 004 / 021 / 022 / 025 / 033 / 035 / 046 / 057 (SMD-2116).';

-- ---------------------------------------------------------------------------
-- 8. update_thought — the 10-argument form (046's signature, unchanged). 046's
--    body up to the write; the write is the after-image, the append and the
--    projection, or a refresh, or nothing. 032/033/046's mechanism, carried:
--    as the last definer this file leaves ONE update_thought whatever state
--    it meets — the ACL of an older form (9-, 8- or 7-argument, a brain where
--    046, 033, 021 or 018 was re-applied by hand) captured, the older forms
--    dropped (or every shorter call is "function is not unique"), the ACL
--    replayed onto this one — so test-schema's restore of the last definer
--    means what it did (033's header). On a brain at 046 or later the setting
--    is empty and the DROPs find nothing.
-- ---------------------------------------------------------------------------
SELECT set_config('ob1.acl_update_thought',
                  CASE WHEN to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb)') IS NOT NULL THEN ''
                       WHEN to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb)') IS NOT NULL THEN
                         COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb)')), '')
                       WHEN to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text)') IS NOT NULL THEN
                         COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text)')), '')
                       ELSE
                         COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb)')), '') END,
                  false);

DROP FUNCTION IF EXISTS update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb);
DROP FUNCTION IF EXISTS update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text);
DROP FUNCTION IF EXISTS update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb);

CREATE OR REPLACE FUNCTION update_thought(
  p_id                 uuid,
  p_content            text        DEFAULT NULL,
  p_metadata_patch     jsonb       DEFAULT NULL,
  p_embedding          vector({{EMBEDDING_DIM}}) DEFAULT NULL,
  p_chunks             jsonb       DEFAULT NULL,
  p_if_unchanged_since timestamptz DEFAULT NULL,
  p_actor              jsonb       DEFAULT NULL,
  -- 021: the model that produced p_embedding, as OB1_EMBEDDING_MODEL names it.
  p_embedding_model    text        DEFAULT NULL,
  -- 032: the provenance envelope — {"supersedes": uuid|null, "derived_from":
  -- [uuid…]|null}. An absent key leaves the column, a JSON null clears it, a
  -- value sets it.
  p_provenance         jsonb       DEFAULT NULL,
  -- 046: the write event — {"stance": stated|retrieved|inferred, "cites":
  -- [uuid…], "valid_from", "valid_until", "trust", "actor_kind"} — validated by
  -- validate_write_event and carried by the append; trust and actor_kind are
  -- claims the append checks against the key, never copies.
  p_event              jsonb       DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing     thoughts%ROWTYPE;
  v_fingerprint  text;
  v_unchanged    boolean;
  -- The row holding v_fingerprint in the unique index, if any, and whether its
  -- text still hashes to it (a raw update around this function can leave a
  -- stale key): the twin, or the stale holder, reported as such below.
  v_other        uuid;
  v_other_same   boolean;
  v_updated      timestamptz;
  -- 032: whether the envelope names each key, and the value to write when it
  -- does (NULL clears). Two flags rather than two nullable values, because
  -- "clear" and "leave alone" are both NULL.
  v_set_supersedes boolean := COALESCE(p_provenance ? 'supersedes', false);
  v_set_derived    boolean := COALESCE(p_provenance ? 'derived_from', false);
  v_supersedes     uuid;
  v_derived        jsonb;
  v_walk           uuid;
  v_steps          int := 0;
  v_event          jsonb;  -- 046
  -- 057: the after-image, as 046's UPDATE would have left the row.
  v_new_content    text;
  v_new_fp         text;
  v_new_meta       jsonb;
  v_new_sup        uuid;
  v_new_derived    jsonb;
  v_new_has_vec    boolean;
  v_same_text      boolean;
  v_diff           jsonb;
  v_ev             uuid;
BEGIN
  -- 032: the envelope's shape, before any lock is taken — 005's guard, for
  -- this parameter: a client that binds a JS string to a jsonb parameter
  -- double-encodes it. Then each key's value: supersedes a UUID string or
  -- null (shape here, existence under the row lock below), derived_from
  -- through the one rule.
  IF p_provenance IS NOT NULL AND jsonb_typeof(p_provenance) <> 'object' THEN
    RAISE EXCEPTION
      'update_thought: p_provenance must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_provenance);
  END IF;
  -- 057: the same guard for the patch — `{} || 'null'` and `{} || '[…]'`
  -- make an ARRAY of the row's metadata, after which every later event has
  -- no source and no mark (run-it, first review pass; 046 accepted it).
  IF p_metadata_patch IS NOT NULL AND jsonb_typeof(p_metadata_patch) <> 'object' THEN
    RAISE EXCEPTION
      'update_thought: p_metadata_patch must be a JSON object, got %. A client that binds a JS string to a jsonb parameter double-encodes it — pass an object, or cast explicitly.',
      jsonb_typeof(p_metadata_patch);
  END IF;
  IF v_set_supersedes AND jsonb_typeof(p_provenance->'supersedes') <> 'null' THEN
    IF jsonb_typeof(p_provenance->'supersedes') <> 'string'
       OR (p_provenance->>'supersedes') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION
        'update_thought: supersedes must be a thought UUID string or null, got %.', p_provenance->'supersedes';
    END IF;
    v_supersedes := (p_provenance->>'supersedes')::uuid;
  END IF;
  IF v_set_derived THEN
    v_derived := validate_derived_from(p_provenance->'derived_from');
  END IF;

  -- 008: transaction-local, so it cannot outlive this call on a pooled
  -- connection; set before the write so the append reads it.
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;
  -- 046: the event's shape, refused here before any lock. 057: the event
  -- rides the append, which runs after every refusal this function can
  -- return (NOT_FOUND, STALE_READ, DUPLICATE_CONTENT, SUPERSEDES_NOT_FOUND,
  -- WOULD_CYCLE) — so a refused call leaves no event, in the log or on the
  -- transaction; the setting a raw write later would read is cleared here.
  -- The ACTOR set above stays, as 008 scoped it.
  v_event := validate_write_event(p_event);
  PERFORM set_config('ob1.event', '', true);

  -- ob1:supersession-review (032/036): a supersedes write is serialised with
  -- every other on 029's lock, taken BEFORE the row lock — see "Lock order"
  -- in 033's header — so the walk below reads committed pointers.
  -- Re-entrant: review_supersession_proposal holds it already when it calls
  -- here.
  IF v_supersedes IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('ob1:supersession-review'));
  END IF;

  -- 033: the fingerprint lock BEFORE the row, whenever content arrives — the
  -- order every capture takes, so no writer holds a row while waiting on a
  -- fingerprint lock another writer holds while waiting on a row. 003's
  -- rule, through 016's function: a fingerprint computed differently here
  -- would silently stop matching the ones capture writes.
  IF p_content IS NOT NULL THEN
    v_fingerprint := content_fingerprint_of(p_content);
    PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0));
  END IF;

  -- The row lock: what "unchanged" is decided against below is the row as it
  -- is NOW, and stays so until this transaction ends. FOR NO KEY UPDATE, not
  -- 018's FOR UPDATE (032): the supersedes write takes FOR KEY SHARE on the
  -- target row, which FOR UPDATE on that row — another edit of it, waiting
  -- on a fingerprint lock this one holds — would deadlock with. Two edits of
  -- one row still serialise, and delete_thought still waits.
  SELECT * INTO v_existing FROM thoughts WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;

  -- 009: a stale read is told apart from a missing row before the write, so
  -- the caller gets the reason rather than a bare "0 rows". Truncated on both
  -- sides to milliseconds — JavaScript's Date carries no more, and a caller
  -- passing back exactly what it read must pass this. 057: this is THE
  -- guard. 046's second copy in the UPDATE's own WHERE is gone with the
  -- UPDATE: under READ COMMITTED with the row locked FOR NO KEY UPDATE
  -- above, the row this read saw is the row the projector writes.
  IF p_if_unchanged_since IS NOT NULL
     AND date_trunc('milliseconds', COALESCE(v_existing.updated_at, v_existing.created_at))
         > date_trunc('milliseconds', p_if_unchanged_since) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'STALE_READ',
      'current_updated_at', COALESCE(v_existing.updated_at, v_existing.created_at));
  END IF;

  -- 032: the target exists, and pointing at it closes no loop. The first read
  -- answers both: NOT FOUND is the ghost; its pointer starts the walk. 029's
  -- walk, moved here so a hand edit and an acceptance are refused alike;
  -- bounded, so a chain longer than the bound is refused rather than walked
  -- for ever. A thought cannot supersede itself.
  IF v_supersedes IS NOT NULL THEN
    IF v_supersedes = p_id THEN
      RETURN jsonb_build_object('ok', false, 'error', 'WOULD_CYCLE', 'supersedes', v_supersedes);
    END IF;
    SELECT supersedes INTO v_walk FROM thoughts WHERE id = v_supersedes;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'SUPERSEDES_NOT_FOUND', 'supersedes', v_supersedes);
    END IF;
    WHILE v_walk IS NOT NULL LOOP
      IF v_walk = p_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'WOULD_CYCLE', 'supersedes', v_supersedes);
      END IF;
      v_steps := v_steps + 1;
      IF v_steps > 1000 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'WOULD_CYCLE', 'supersedes', v_supersedes, 'detail', 'chain longer than 1000');
      END IF;
      SELECT supersedes INTO v_walk FROM thoughts WHERE id = v_walk;
    END LOOP;
  END IF;

  IF p_content IS NOT NULL THEN
    IF v_existing.content_fingerprint = v_fingerprint THEN
      -- The row already owns this key, and it is locked: the unique index
      -- says no other row can hold it, so there is nothing to look up. The
      -- common case — every fingerprinted row a re-embed pass visits, every
      -- same-text re-save through the tool.
      v_unchanged := true;
    ELSE
      v_unchanged := v_fingerprint = content_fingerprint_of(v_existing.content);

      -- ob1:unchanged-edit-not-duplicate — a CONTRACT SENTINEL, not prose (the
      -- 014 convention). The one definition of "another row holding this key":
      -- the refusal below and the duplicate_of report both read it. Under the
      -- fingerprint lock taken above, so it sees the other writer's committed
      -- row rather than racing it to the unique index — see "The rule", 2, in
      -- 018's header. The holder's text is hashed again, because a stale key
      -- — a raw update of content around this function — is not the same
      -- text, and must not be reported as a twin.
      SELECT id, content_fingerprint_of(content) = v_fingerprint
        INTO v_other, v_other_same
      FROM thoughts
      WHERE content_fingerprint = v_fingerprint AND id <> p_id
      LIMIT 1;

      IF v_other IS NOT NULL THEN
        -- Editing a thought INTO a key another row holds. The partial unique
        -- index would reject this anyway, but as a constraint violation that
        -- surfaces at the tool boundary as an opaque 23505. An edit whose text
        -- normalises to what the row already holds creates no duplicate that
        -- was not already there, so it is not refused; what was found is
        -- reported instead — the twin, or the row whose stale key blocks the
        -- fingerprint this row should have had.
        IF NOT v_unchanged THEN
          RETURN jsonb_build_object('ok', false, 'error', 'DUPLICATE_CONTENT');
        END IF;
      END IF;
    END IF;
  END IF;

  -- ob1:capture-appends-then-projects — a CONTRACT SENTINEL, not prose (the
  -- 014 convention); preflight's `edit signature` reads it. 057: the
  -- after-image, as 046's UPDATE would have left the row, computed here;
  -- the diff from it; the event appended; the row projected from the event.
  v_new_content := COALESCE(p_content, v_existing.content);
  -- v_other is set only when content arrived: another row holds this key, so
  -- this row must not claim it — NULL, whatever a raw update around this
  -- function may have left here (018).
  v_new_fp      := CASE WHEN p_content IS NULL   THEN v_existing.content_fingerprint
                        WHEN v_other IS NOT NULL THEN NULL
                        ELSE v_fingerprint END;
  -- 050: the actor follows the content — the same text (the same bytes, or
  -- 003's normalised fingerprint) keeps the mark, a new text takes the
  -- envelope's; the two arms 055 lifted out of ob1_stamp_actor.
  v_same_text   := p_content IS NULL OR p_content IS NOT DISTINCT FROM v_existing.content
                   OR content_fingerprint_of(v_existing.content) IS NOT DISTINCT FROM v_fingerprint;
  v_new_meta    := CASE WHEN p_metadata_patch IS NOT NULL THEN v_existing.metadata || p_metadata_patch ELSE v_existing.metadata END;
  v_new_meta    := CASE WHEN v_same_text THEN ob1_actor_stamp_kept(v_new_meta, v_existing.metadata) ELSE ob1_actor_stamp(v_new_meta) END;
  -- 032: each provenance column moves only when the envelope names its key
  -- — to the value given, NULL included.
  v_new_sup     := CASE WHEN v_set_supersedes THEN v_supersedes ELSE v_existing.supersedes END;
  v_new_derived := CASE WHEN v_set_derived THEN v_derived ELSE v_existing.derived_from END;
  -- Only when content arrived does the vector move (021): a metadata-only
  -- edit must not blank the vector and quietly remove the row from every
  -- semantic search.
  v_new_has_vec := CASE WHEN p_content IS NOT NULL THEN p_embedding IS NOT NULL ELSE v_existing.embedding IS NOT NULL END;
  v_diff := ob1_thought_diff('update',
    v_existing.content, v_new_content,
    v_existing.metadata, v_new_meta,
    v_existing.embedding IS NOT NULL, v_new_has_vec,
    v_existing.supersedes, v_new_sup,
    v_existing.derived_from, v_new_derived,
    v_existing.content_fingerprint, v_new_fp);

  -- 046's gate, as the trigger applied it: an edit that changes nothing and
  -- declares nothing is not an event.
  IF v_diff <> '{}'::jsonb OR COALESCE(v_event ?| ARRAY['stance', 'cites', 'valid_from', 'valid_until', 'trust', 'actor_kind'], false) THEN
    v_ev := ob1_append_thought_event(p_id, 'update', v_new_meta->>'source', v_diff, v_event);
  END IF;
  IF v_ev IS NOT NULL THEN
    -- The label follows the vector (021): the caller's with a vector, NULL
    -- with content and no vector, untouched without content — the projector
    -- writes it so from the event and these two.
    PERFORM ob1_project_thought_event(v_ev, CASE WHEN p_content IS NOT NULL THEN p_embedding END, p_embedding_model);
    SELECT updated_at INTO v_updated FROM thoughts WHERE id = p_id;
  ELSIF p_content IS NOT NULL AND p_embedding IS NOT NULL THEN
    -- The same text with a new vector (the re-embed's shape): a projection
    -- refresh — no event, no updated_at (057's named delta).
    PERFORM ob1_refresh_thought_vector(p_id, p_embedding, p_embedding_model);
    v_updated := COALESCE(v_existing.updated_at, v_existing.created_at);
  ELSE
    -- Nothing changed: no event, no write, no updated_at (057's named delta;
    -- 046 bumped the stamp and recorded no audit row).
    v_updated := COALESCE(v_existing.updated_at, v_existing.created_at);
  END IF;

  -- Chunks describe the content, so they follow it: replaced wholesale, as
  -- migration 007's capture path does, carrying 013's context.
  IF p_content IS NOT NULL THEN
    DELETE FROM thought_chunks WHERE thought_id = p_id;
    IF p_chunks IS NOT NULL AND jsonb_array_length(p_chunks) > 0 THEN
      INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding, context)
      SELECT p_id, (ord - 1)::int, elem->>'content',
             (elem->>'embedding')::vector({{EMBEDDING_DIM}}),
             elem->>'context'
      FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS a(elem, ord);
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', p_id, 'updated_at', v_updated)
         || CASE WHEN v_other IS NULL   THEN '{}'::jsonb
                 WHEN v_other_same       THEN jsonb_build_object('duplicate_of', v_other)
                 ELSE jsonb_build_object('fingerprint_held_by', v_other) END;
END;
$$;

-- 032's ACL replay, verbatim, onto the 10-argument form from the older form
-- the capture above read — nothing on a brain that already had the
-- 10-argument form (CREATE OR REPLACE keeps its ACL).
DO $acl$
DECLARE
  v_acl  text := current_setting('ob1.acl_update_thought', true);
  v_item record;
BEGIN
  IF v_acl IS NULL OR v_acl = '' THEN
    RETURN;
  END IF;
  EXECUTE 'REVOKE ALL ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb) FROM PUBLIC';
  FOR v_item IN
    SELECT DISTINCT a.grantee FROM pg_proc p, aclexplode(p.proacl) AS a
    WHERE p.oid = to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb)') AND a.grantee <> 0
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb) FROM %s', quote_ident(pg_get_userbyid(v_item.grantee)));
  END LOOP;
  FOR v_item IN SELECT grantee, privilege_type, is_grantable FROM aclexplode(v_acl::aclitem[]) LOOP
    IF v_item.privilege_type = 'EXECUTE' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb) TO %s%s',
                     CASE WHEN v_item.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_item.grantee)) END,
                     CASE WHEN v_item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END IF;
  END LOOP;
END
$acl$;

COMMENT ON FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb) IS
  'Edit a thought by id. Recomputes content_fingerprint and replaces chunks — with their context — when content changes; an edit whose text normalises to what the row holds is never DUPLICATE_CONTENT, and reports duplicate_of when another row holds that text (a pair from before migration 003), or fingerprint_held_by when a row holds the key under other text, leaving this row''s fingerprint NULL. Every edit with content takes the fingerprint advisory lock (READ COMMITTED) — the one every capture through upsert_thought takes since 033 — and then locks the row FOR NO KEY UPDATE (032); both locks are held until the caller''s transaction ends, refusals included. Checks if_unchanged_since against the locked row before the write — since 057 the one check, the row it read being the row it writes. Since 057 the edit is an event first: the after-image is computed in the body (050''s stamp arms, 046''s diff rule), appended (ob1_append_thought_event) and projected (ob1_project_thought_event); a same-text edit carrying a vector is a refresh with no event and no updated_at (ob1_refresh_thought_vector); an edit that changes nothing writes nothing. p_embedding_model (021) is written beside the vector — the label follows the vector: untouched without content, NULL with content and no vector. p_provenance (032) is the envelope {"supersedes": uuid|null, "derived_from": [uuid…]|null}: an absent key leaves the column, a JSON null clears it, a value sets it — derived_from validated by validate_derived_from, supersedes an existing thought that closes no loop, the write serialised with review_supersession_proposal''s. p_event (046) is the write event {"stance", "cites", "valid_from", "valid_until", "trust", "actor_kind"}: validated by validate_write_event (a bad shape is refused) and carried by the append, which stamps stance, cites and the window on the row and checks trust and actor_kind against the key rather than copying them. Returns {ok:true, id, updated_at} — the row''s stamp after the call, unmoved by a refresh or a no-op — or {ok:false, error} for NOT_FOUND | STALE_READ | DUPLICATE_CONTENT | SUPERSEDES_NOT_FOUND | WOULD_CYCLE. Migration 009 / 013 / 018 / 021 / 032 / 033 / 046 / 057 (SMD-2116).';

-- ---------------------------------------------------------------------------
-- 9. delete_thought — 042's body; inside the sub-block the tombstone is
--    appended and projected, so a refused delete (OB001 from the guard on
--    the base table's DELETE) rolls back the event with the row. 042's DROP
--    of the 2-argument form, carried: the last definer leaves one function.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS delete_thought(uuid, jsonb);

CREATE OR REPLACE FUNCTION delete_thought(
  p_id     uuid,
  p_actor  jsonb   DEFAULT NULL,
  p_detach boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted   uuid;
  -- The mode as the caller's transaction had it, put back after the write:
  -- p_detach is this call's, not the transaction's, so a raw DELETE later in
  -- the same transaction meets the guard's default (or the caller's own
  -- setting) and not this call's choice (042's first review pass).
  v_prev_mode text := current_setting('ob1.cited_delete', true);
  -- The running totals as the caller's transaction has them, read before and
  -- subtracted after: the guard ADDS to them, a refusal's rollback undoes its
  -- adding, and NOT_FOUND adds nothing — so this call's own count is the
  -- difference, with no zeroing and nothing to put back (042).
  v_before_det int := COALESCE(NULLIF(current_setting('ob1.citations_detached', true), ''), '0')::int;
  v_before_ina int := COALESCE(NULLIF(current_setting('ob1.citations_inactive', true), ''), '0')::int;
  v_refused   boolean := false;
  v_detail    text;
  v_json      jsonb;
  v_detached  int;
  v_inactive  int;
  v_old       thoughts%ROWTYPE;
  v_ev        uuid;
BEGIN
  -- Every setting OUTSIDE the block below: a caught exception rolls back its
  -- subtransaction, set_config included, and the append must still see the
  -- actor on the path that follows no refusal.
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('ob1.actor', p_actor::text, true);
  END IF;
  PERFORM set_config('ob1.cited_delete', CASE WHEN COALESCE(p_detach, false) THEN 'detach' ELSE 'refuse' END, true);
  -- A tombstone declares nothing (046); the setting a raw write later would
  -- read is cleared here, as 046's statement trigger clears it on a DELETE.
  PERFORM set_config('ob1.event', '', true);

  -- ob1:supersession-review (036): the supersession advisory lock before the
  -- write — the key review_supersession_proposal, update_thought and
  -- upsert_thought take (029/032/033) — so a delete of a superseded thought
  -- serialises with an acceptance writing that pointer instead of
  -- deadlocking against it through 029's cascade. Unconditional, held to the
  -- end of the transaction. Taken outside the block: a savepoint's rollback
  -- releases the advisory locks it acquired, and this one must outlive a
  -- refusal.
  PERFORM pg_advisory_xact_lock(hashtext('ob1:supersession-review'));

  BEGIN
    -- ob1:capture-appends-then-projects — a CONTRACT SENTINEL, not prose (the
    -- 014 convention); preflight's `delete signature` reads it. 057: the row
    -- locked and read, the tombstone appended with 008's previous content
    -- and metadata in full (the diff rule's delete arm), the row projected
    -- away — the DELETE the guard (042) judges, raising OB001 from inside
    -- the projector, which this block catches: the tombstone rolls back with
    -- the row.
    SELECT * INTO v_old FROM thoughts WHERE id = p_id FOR NO KEY UPDATE;
    IF FOUND THEN
      v_ev := ob1_append_thought_event(p_id, 'delete', v_old.metadata->>'source',
                ob1_thought_diff('delete', v_old.content, NULL, v_old.metadata, NULL, v_old.embedding IS NOT NULL, false,
                                 v_old.supersedes, NULL, v_old.derived_from, NULL, v_old.content_fingerprint, NULL),
                NULL);
      IF v_ev IS NULL THEN
        RAISE EXCEPTION 'delete_thought: the append recorded no delete event for %', p_id;
      END IF;
      v_deleted := ob1_project_thought_event(v_ev);
    END IF;
  EXCEPTION WHEN SQLSTATE 'OB001' THEN
    -- The guard refused (042). Only this SQLSTATE is caught: a real
    -- foreign_key_violation, a permission failure, the check's OB002,
    -- anything else is the fault it is and propagates. What it refused on —
    -- the count and up to ten of the citing rows, read from the rows the
    -- guard locked — rides in the error's DETAIL as JSON, so the answer is
    -- the state the guard saw and not a re-read after the rollback.
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    v_refused := true;
  END;
  PERFORM set_config('ob1.cited_delete', COALESCE(v_prev_mode, ''), true);

  IF v_refused OR v_deleted IS NULL THEN
    -- Nothing was detached: a refusal (whose rollback undid the guard's
    -- adding and the tombstone), or no row — a distinct outcome, not a
    -- silent success; the caller asked to remove a specific thing, and not
    -- finding it is information.
    IF v_refused THEN
      -- The guard's DETAIL is JSON; an OB001 from anything else (a future
      -- trigger, a hand-raised one) is answered as a refusal with a count of
      -- nothing rather than a parse error (042's fifth review pass).
      BEGIN
        v_json := v_detail::jsonb;
      EXCEPTION WHEN OTHERS THEN
        v_json := '{}'::jsonb;
      END;
      RETURN jsonb_build_object('ok', false, 'error', 'CITED', 'id', p_id)
             || jsonb_build_object('cited_by', COALESCE((v_json->>'cited_by')::int, 0),
                                   'citations', COALESCE(v_json->'citations', '[]'::jsonb));
    END IF;
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;

  -- What the guard did on the way: the active citations it detached (only with
  -- p_detach — refuse mode never reaches here with any), and the expired or
  -- superseded ones it marked with the deleted source in either mode — the
  -- difference between the running totals now and as the caller had them.
  v_detached := COALESCE(NULLIF(current_setting('ob1.citations_detached', true), ''), '0')::int - v_before_det;
  v_inactive := COALESCE(NULLIF(current_setting('ob1.citations_inactive', true), ''), '0')::int - v_before_ina;
  RETURN jsonb_build_object('ok', true, 'id', v_deleted, 'detached', v_detached)
         || CASE WHEN v_inactive > 0 THEN jsonb_build_object('inactive', v_inactive) ELSE '{}'::jsonb END;
END;
$$;

COMMENT ON FUNCTION delete_thought(uuid, jsonb, boolean) IS
  'Hard-delete a thought by id. Chunks go by cascade; the tombstone keeps previous_content and the metadata in full (008), which is what makes a hard delete recoverable. Takes the supersession advisory lock first (036) — the one review_supersession_proposal and update_thought take — so a delete of a superseded thought serialises with an acceptance writing that pointer rather than deadlocking against 029''s ON DELETE CASCADE. Since 057 the tombstone is appended first (ob1_append_thought_event) and the row projected away (ob1_project_thought_event), both inside the block that catches the citation guard''s refusal, so a refused delete leaves no event. Returns {ok:false, error:NOT_FOUND} rather than succeeding silently, and since 042 {ok:false, error:CITED, id, cited_by, citations[<=10]} when active citations rest on the row and p_detach is false; p_detach = true detaches them (each keeps text and stance, source_id -> null, source_deleted_id/at recorded) and success carries detached:n, plus inactive:m when expired or superseded citations were marked the same way. Two-argument calls resolve through the default. Migration 009 / 036 / 042 / 057 (SMD-2116).';
