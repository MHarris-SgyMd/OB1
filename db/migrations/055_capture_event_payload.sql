-- =============================================================================
-- Migration 055: the capture event carries the payload — a capture's content
--                and a backdating writer's created_at, an update's key move —
--                and 046's diff rule, its append and 050's stamp become
--                functions a projector can call; the log alone rebuilds every
--                thought's text (SMD-2115; step 1 of SMD-1997's path)
-- =============================================================================
--
-- WHY
--   046 made thought_audit the log of record and 008's capture row records the
--   creating METADATA, not the content: the one thing a rebuild needs first is
--   the one thing the log does not hold. SMD-1998 measured it on the dogfood
--   brain — the log alone reproduced the text of 217 of 440 live thoughts,
--   and only those whose text later moved (an update's `before`). SMD-1999
--   measured what a projector needs beyond 046's event and found three things
--   and nothing else:
--
--     * THE CONTENT on a capture. Without it a capture event projects to
--       nothing (the prototype refuses one, SQLSTATE OB003).
--     * THE ROW'S created_at on a capture, when the writer set one.
--       db/ingest-records.ts backdates a record to its own time; the event's
--       created_at is the clock of the write; a replay had no way back.
--     * THE KEY'S MOVE on an update. 018 sets content_fingerprint NULL for a
--       text another row holds — a decision a replay cannot re-derive from
--       the content — and 023's backfill gives a legacy row its key after the
--       fact; either way the row's key moved and the event did not say so.
--
--   docs/event-log-as-truth.md (SMD-1997) decides that the log is the
--   write-side source of truth for a thought and the row its projection, in
--   three additive steps from 053. This is step 1: the log becomes complete
--   in payload from the day it lands, so step 2 (the functions append then
--   project, SMD-2116) and step 3 (the rebuild is the replay, SMD-2117) have
--   a log to fold. Nothing about the write path moves here: the row is still
--   written first and the trigger still derives the event from it; no
--   function changes what it returns; no row is written differently.
--
-- WHAT
--   1. THREE ADDITIONS TO THE TRIGGER'S DIFF, AND NO OTHER. capture: `content`
--      always, and `created_at` when the row's differs from the transaction's
--      now() — a defaulted column equals now() and is not carried; a writer's
--      own value is. update: `content_fingerprint` {before, after} when the
--      key moved, 018's NULL and 023's fill included. Outside these three the
--      event is byte-equal to 046's: SMD-1999's differential held it so, and
--      test-schema [51] runs one scripted set of writes under 046's trigger
--      and under this one and compares every audit column outside the three
--      keys. Readers of 046's shape ignore the added keys (052's
--      thought_changes lists an update's diff keys, so `content_fingerprint`
--      now appears in `changed` beside `content` when a text moves — the same
--      bookkeeping place `embedding_present` already has). Two passes that
--      wrote no audit row before write one per row they key now, because a
--      key's move is an event: 023's backfill_content_fingerprints on a
--      legacy row, and db/reembed.ts's update_thought on a legacy twin it
--      keys as it passes. A brain with many NULL keys gains that many rows
--      at its next such pass — the record of a change the log did not hold.
--
--   2. 046's RULES AS FUNCTIONS, THE TRIGGERS CALLING THEM. The diff rule is
--      ob1_thought_diff (046's, lifted out, with the three additions); the
--      trigger's tail — who from the key, the registry's kind, the trust
--      ceiling, the door, the claim filed, 046's late gate, the INSERT — is
--      ob1_append_thought_event, returning the event's id or NULL when the
--      gate drops it; 050's two stamp arms are ob1_actor_stamp (a new text:
--      the writer from the envelope) and ob1_actor_stamp_kept (the same
--      text: the mark as it was). thoughts_write_audit and ob1_stamp_actor
--      are redefined to call them and do nothing else that they did not do
--      before; each rule has one copy, which step 2's functions will call
--      BEFORE the row exists. The sentinels move with the rules:
--      ob1:audit-event-from-the-key now stands in the append function and
--      is named in the trigger; ob1:actor-on-the-row-from-the-key stands in
--      ob1_actor_stamp; ob1:capture-event-carries-content is new, in the
--      diff rule and the trigger, and is what preflight and test-schema read
--      to tell this trigger from 046's.
--
--   3. THE PAYLOAD FOR ROWS ALREADY WRITTEN — the THIRD NAMED AMENDMENT of
--      the append-only table, after 046's kind-fill and before SMD-1723's
--      redaction. Under ob1.audit_amend = 'payload' an UPDATE of a CAPTURE
--      row may fill diff.content and diff.created_at where absent, and
--      nothing else: every other column byte-equal (to_jsonb(OLD) against
--      to_jsonb(NEW) with `diff` removed — the fifth column, under this
--      value alone; under 'backfill' an UPDATE of diff stays refused), every
--      other key of diff byte-equal, a value once set never changed,
--      something filled, and each fill WHAT THE LOG AND THE ROW DERIVE TO —
--      the gate re-derives it key by key (ob1_capture_payload, one copy for
--      the gate and the backfill). The source order, in the order the
--      evidence is trustworthy: the `before` of the first content-moving
--      update after the capture (the text as captured, byte for byte); else
--      the tombstone's previous_content (008 keeps it); else the live row's
--      content, when no later tombstone or capture closed this incarnation
--      of the id; else unrecoverable, counted and left as it is. The first
--      update carrying a content key is the evidence, whatever it holds: a
--      `before` that is no string (no writer's is; a hand-planted row's may
--      be) derives to nothing rather than to the next update's `before`, the
--      text after an edit (run-it, fourth review pass).
--      created_at is filled from the live row
--      alone, and only when it differs from the event's — a deleted
--      thought's is gone with the row and the fold falls back to the event's
--      clock, as it does for a row captured at now(). A created_at is filled
--      with the content or before it, never onto a row that already carries
--      its content: a complete 055 capture gains no time it never had, even
--      if the row's created_at is moved by hand later (run-it, first review
--      pass).
--
--      WHAT "AFTER THE CAPTURE" MEANS, exactly (two review passes, both
--      readers). Two clocks order the log (the ADR's Time section): `seq`,
--      050's identity, is exact insertion order for every row written since
--      050 and heap order for the rows before it (050's own COMMENT: 046's
--      backfill and VACUUM moved tuples); created_at is now(), the
--      TRANSACTION's start, so it neither orders two writes inside one
--      transaction nor a write from a transaction older than the capture's
--      that committed after it. So: a row written since 050 is after the
--      capture when its seq is larger, and is ordered by seq; a row from
--      before 050 is after the capture when (created_at, seq) is larger, and
--      is ordered so. The boundary is ob1_config.audit_seq_exact_since —
--      050's applied_at from the ledger, recorded once by this file; the
--      apply's own time where no ledger says (the suites). Every degradation
--      falls to the clock path, the ADR's default order, which cannot cross
--      an incarnation: a brain baselined after 050 counts its rows between as
--      before-050; a key pruned from ob1_config reads as 'infinity', every
--      row before it (third review pass — the first draft fell to
--      '-infinity', the identity path, the one that can). One set is mis-read
--      the other way and cannot be told from the log at 055: rows a writer
--      committed while 050's ALTER waited for its lock, stamped after the
--      apply's start yet numbered in heap order — narrow, and the verify
--      mode's to name. And the events read stop at the first later
--      tombstone or capture, that row included: an id db/ingest-records.ts
--      re-uses after a delete has a second incarnation whose edits are not
--      this capture's. What the first two readings got wrong: "the first
--      content-moving update" walked into the second incarnation (cold
--      read, first review pass); the (created_at, seq) comparison alone
--      dropped an edit from an older transaction, so the derivation fell to
--      the live text (run-it, first review pass, two connections); and
--      admitting every row with a larger seq admitted, on a brain with
--      pre-050 history, a PRIOR incarnation's rows whose heap seq happened to
--      be larger, which then sorted first by created_at and became the edge —
--      the tombstone's text onto a standing thought's capture (both readers,
--      second review pass; the dogfood
--      log's 512 heap inversions all sit at seq <= 1097 and touch no capture,
--      measured read-only). The boundary is what tells an older
--      transaction's edit from a prior incarnation's row; the log alone
--      cannot. For rows from before 050 a capture and its edit made in one
--      transaction can still sort the wrong way round and derive from the
--      live text rather than the captured one; SMD-2117's verify mode is the
--      check. A capture row whose diff is NULL (a hand INSERT; every writer's
--      is an object) counts as waiting and is filled onto an empty object.
--
--      A filled row is not marked: the record is the ledger's applied_at
--      for this file — a capture row older than that whose diff carries
--      content was filled by the pass (046's backfilled_at is the kind-fill's
--      stamp and is not moved). The text written into the log by this file
--      is not removable until SMD-1723's redaction exists; the decision
--      orders that no later than step 2, and SMD-2116 is blocked on it.
--
--      backfill_thought_payloads(p_limit) is the pass: 023's shape (a temp
--      table per call, dropped at commit), candidates read through a partial
--      index on the capture rows still without content — empty once the
--      pass has run, so preflight's census reads an index, not the heap —
--      in (created_at, seq) order, each derived once, filled under the
--      setting, the setting restored. Returns {ok, rows, from_update,
--      from_tombstone, from_row, with_created_at, unrecoverable, skipped,
--      awaiting}.
--      Idempotent: a second pass finds nothing. Two passes at once: the
--      second re-reads each row under its lock and skips what the first
--      filled (test-live holds this with two connections; PGlite cannot);
--      two whose row locks interleave can close a cycle Postgres breaks
--      (40P01), which nothing here retries — run one pass at a time.
--      A capture whose text moves while a pass derives it derives the same
--      text either way — the update's `before` IS the row's text the pass
--      read. A thought DELETED while the pass runs is another matter: its
--      created_at is gone with the row, the gate — a VOLATILE trigger,
--      reading under a fresh snapshot — derives a different answer from the
--      scan's, and refuses; before the second review pass one delete_thought
--      from a live server during the apply failed the whole migration
--      (run-it, reproduced with an ordinary delete loop). The fill runs in
--      batches of 1,000 candidates in (created_at, seq) order, each inside
--      a block that catches the gate's refusal, re-derives the batch under a
--      fresh snapshot, sets the rows whose derivation moved aside as
--      `skipped`, and runs the batch again; a refusal that set nothing aside
--      is the defect it would be, raised after five of them in one batch.
--      (Fourth review pass: one statement over every candidate, retried five
--      times whatever the retry found, was exhausted by ten deletes spread
--      over half a second — each delete cost the whole pass, and a retry
--      that set a row aside counted against the budget as a fruitless one
--      did; run-it, reproduced at 5,000 rows.) Nothing of a refused batch
--      stands; nothing already filled is lost. The by-source counts are of
--      the rows THIS pass filled (the UPDATE's RETURNING), `skipped` the
--      candidates another pass took or whose derivation moved (the next pass
--      fills them from their tombstones), `unrecoverable` the candidates
--      nothing derives for. lock_timeout is 10 s: a second pass beside one
--      that runs longer than that raises rather than waits. A capture row
--      whose diff is no object (a hand INSERT's array or scalar; every
--      writer's is an object, and a NULL reads as empty) is no candidate and
--      is not counted as waiting — the gate refuses a fill onto it by name
--      (cold read, fourth review pass: it was a candidate the fill could not
--      complete, and the apply failed on it). And the live row is the
--      operator's to edit: a capture event filled from it carries the row's
--      text as it stood when the pass ran, no more trustworthy than that row
--      — which is why the log's own evidence, an update's `before` or a
--      tombstone, is read before it.
--
--      Measured on a copy of the dogfood log (631 thoughts, 2,688 audit rows,
--      632 capture rows without content, 6.0 MB table and TOAST, Postgres
--      16.15 in a container): every row recoverable — 239 from the first
--      moving update, 1 from a tombstone, 392 from the live row; 222 gain a
--      created_at (the board sync's backdated records); this file's apply,
--      the pass over all 632 included, took 0.64 s, and a second pass fills
--      0. The option the ticket left open — leave the log incomplete and
--      seed a replay from the row store — is declined on that measurement:
--      one source, and the fold never reads the row store it is rebuilding.
--
--   4. WHAT IT COSTS. The trigger pays two plpgsql calls it did not (the diff
--      rule and the append): a raw INSERT of 2,000 rows measured 31 µs a row
--      under 046's trigger and 36 µs under this one (×1.15, the median of
--      three on the copy above; 008 measured its whole trigger at 6% of a
--      bulk insert). And it carries the content of every capture into the
--      log: the dogfood corpus was 2.2 M characters of live text beside a
--      6.0 MB audit table, so the log grows by about the corpus. 046 chose
--      the log's partition key (RANGE on created_at by month) and did not
--      apply it; SMD-1947 benches the log at a million rows and decides.
--
--   5. NOT HERE, SAID SO. The write functions do not append before they
--      write (step 2). No function passes a created_at: the three
--      upsert_thought forms pass p_content and no time, so a backdating
--      writer's created_at reaches the event through the trigger's raw path
--      alone — db/ingest-records.ts's INSERT — which is every backdating
--      writer today; the form a function-borne capture takes is SMD-2117's
--      to decide when the ingester moves onto the functions. A row with no
--      capture event at all (a load with the trigger off; the dogfood brain
--      has none) is not synthesised here: the fold reports the count
--      (SMD-2117). The redaction amendment: SMD-1723, in the gate below,
--      with its ticket.
--
-- SAFETY
--   Additive: thoughts is untouched; thought_audit gains one partial index;
--   every function is CREATE OR REPLACE; no signature moves, no row is
--   written differently, no return changes. Existing capture rows read as
--   before until the pass fills them; the file's own call fills every row
--   waiting (or one batch under OB1_BACKFILL_LIMIT, 023's knob — the rest by
--   hand). Idempotent: a second run adds nothing, the pass finds nothing.
--   MINOR under FORK.md's version rules: functions added, none renamed.
--
-- Prerequisites
--   006 (ob1_config, the boundary's row), 008 (thought_audit), 046 (the
--   event columns, ob1_registry_kind, ob1_trust_ceiling, ob1_door_of, the
--   trigger body carried), 050 (thought_audit.seq, ob1_stamp_actor).
--   Applied by `bun db/migrate.ts`.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape): the bodies below are plpgsql and would fail at their
-- first call with a bare "does not exist" otherwise.
DO $qc$
BEGIN
  IF to_regclass('ob1_config') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 055 needs 006 (ob1_config); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regclass('thought_audit') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 055 needs 008 (thought_audit); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'thought_audit' AND column_name = 'actor_kind')
     OR to_regprocedure('ob1_registry_kind(uuid, text)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 055 needs 046 (thought_audit.actor_kind, ob1_registry_kind); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'thought_audit' AND column_name = 'seq')
     OR to_regprocedure('ob1_stamp_actor()') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 055 needs 050 (thought_audit.seq, ob1_stamp_actor); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. The diff rule: 046's, one copy, with the three additions.
--
-- STABLE, not IMMUTABLE: a timestamptz inside jsonb_build_object renders in
-- the session's TimeZone, as to_jsonb itself is marked. The value round-trips
-- whatever the offset; the bytes do not.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_thought_diff(
  p_action          text,
  p_old_content     text,    p_new_content     text,
  p_old_metadata    jsonb,   p_new_metadata    jsonb,
  p_old_has_vector  boolean, p_new_has_vector  boolean,
  p_old_supersedes  uuid,    p_new_supersedes  uuid,
  p_old_derived     jsonb,   p_new_derived     jsonb,
  p_old_fingerprint text,    p_new_fingerprint text,
  -- The row's created_at on a capture, when the writer set one (NULL when it
  -- is the transaction's now() — the trigger decides that, once, and passes
  -- NULL for a defaulted column).
  p_created_at      timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  d jsonb := '{}'::jsonb;
BEGIN
  IF p_action = 'capture' THEN
    -- ob1:capture-event-carries-content — a CONTRACT SENTINEL, not prose (the
    -- 014 convention); preflight's `audit events` check and test-schema read
    -- it. 046 recorded the creating metadata; the event carries the content
    -- too (SMD-1998: the log is otherwise not the payload store), and the
    -- row's own time when the writer set one.
    d := jsonb_build_object('content', p_new_content, 'metadata', p_new_metadata);
    IF p_created_at IS NOT NULL THEN
      d := d || jsonb_build_object('created_at', p_created_at);
    END IF;
    -- 025: a captured derivation is part of what the row was created with.
    IF p_new_derived IS NOT NULL THEN
      d := d || jsonb_build_object('derived_from', p_new_derived);
    END IF;
    IF p_new_supersedes IS NOT NULL THEN
      d := d || jsonb_build_object('supersedes', p_new_supersedes);
    END IF;
    RETURN d;
  ELSIF p_action = 'update' THEN
    -- Only what changed (008): recording the whole row on every metadata
    -- touch would make the log expensive to store and tedious to read.
    IF p_new_content IS DISTINCT FROM p_old_content THEN
      d := d || jsonb_build_object('content', jsonb_build_object('before', p_old_content, 'after', p_new_content));
    END IF;
    IF p_new_metadata IS DISTINCT FROM p_old_metadata THEN
      d := d || jsonb_build_object('metadata', jsonb_build_object('before', p_old_metadata, 'after', p_new_metadata));
    END IF;
    IF p_new_has_vector IS DISTINCT FROM p_old_has_vector THEN
      d := d || jsonb_build_object('embedding_present', p_new_has_vector);
    END IF;
    -- 025: provenance is history too — `supersedes` going NULL when a
    -- superseded parent is deleted is the change the old diff could not see.
    IF p_new_supersedes IS DISTINCT FROM p_old_supersedes THEN
      d := d || jsonb_build_object('supersedes', jsonb_build_object('before', p_old_supersedes, 'after', p_new_supersedes));
    END IF;
    IF p_new_derived IS DISTINCT FROM p_old_derived THEN
      d := d || jsonb_build_object('derived_from', jsonb_build_object('before', p_old_derived, 'after', p_new_derived));
    END IF;
    -- 055: the key's move is recorded — 018 sets it NULL for a text another
    -- row holds, 023 fills a legacy row's after the fact, update_thought
    -- recomputes it with the text; a replay cannot re-derive any of these
    -- from the content it lands. A raw content edit that leaves the key
    -- stale moves nothing here, and a replay leaves it stale too: the log is
    -- faithful, not corrective.
    IF p_new_fingerprint IS DISTINCT FROM p_old_fingerprint THEN
      d := d || jsonb_build_object('content_fingerprint', jsonb_build_object('before', p_old_fingerprint, 'after', p_new_fingerprint));
    END IF;
    RETURN d;
  ELSE
    -- In full (008): the audit row has to be enough to reconstruct what was
    -- lost; 025 adds the prior provenance to that record.
    RETURN jsonb_build_object(
      'previous_content',      p_old_content,
      'previous_metadata',     p_old_metadata,
      'previous_derived_from', p_old_derived,
      'previous_supersedes',   p_old_supersedes);
  END IF;
END;
$$;

COMMENT ON FUNCTION ob1_thought_diff(text, text, text, jsonb, jsonb, boolean, boolean, uuid, uuid, jsonb, jsonb, text, text, timestamptz) IS
  'The one diff rule for a thought_audit row (046''s, lifted out of the audit trigger so a write function can compute the event before the row exists — SMD-1997 step 2): capture → {content, metadata, created_at when the writer set one, derived_from and supersedes when set}; update → before/after of each of content, metadata, supersedes, derived_from and content_fingerprint that moved, plus embedding_present when the vector''s presence flipped; delete → previous_content, previous_metadata, previous_derived_from, previous_supersedes. The trigger thoughts_write_audit calls it with OLD and NEW. Migration 055 / SMD-2115.';

-- ---------------------------------------------------------------------------
-- 2. The append: 046's trigger tail as a function. Returns the event's id,
--    or NULL when 046's late gate drops the row — an update with an empty
--    diff whose only declarations were a trust or an actor_kind the key
--    supports (a lowering, honoured, nothing to record).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_append_thought_event(
  p_thought uuid,
  p_action  text,
  p_source  text,
  p_diff    jsonb,
  p_event   jsonb
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  actor      jsonb := ob1_current_actor();
  event      jsonb := CASE WHEN p_action = 'delete' THEN NULL ELSE p_event END;
  v_agent    uuid;
  v_kind     text;
  v_declared text;
  v_trust    text;
  v_origin   text;
  v_claimed  jsonb := '{}'::jsonb;
  v_context  jsonb;
  v_id       uuid;
BEGIN
  /**
   * A malformed id must not break the mutation (008: audit observes, it does
   * not obstruct). Guarded by a pattern rather than BEGIN … EXCEPTION, which
   * would open a subtransaction on every row (046). The pattern is the
   * canonical hyphenated form, the only one this server emits.
   */
  v_agent := CASE
    WHEN actor->>'agent_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (actor->>'agent_id')::uuid
  END;

  /**
   * ob1:audit-event-from-the-key — a CONTRACT SENTINEL, not prose (the 014
   * convention); preflight's `audit events` check and test-schema read it.
   *
   * 046: actor_kind is the REGISTRY's word for who holds the key —
   * ob1_agents.kind by the id the envelope carries (010) or, for a writer
   * that never resolved one, by the key's name. The payload's own actor_kind
   * is never copied: the database never sees the key, so the row the
   * operator classified is the one thing a claim can be checked against.
   * NULL is honest — an unclassified key, or a mutation made outside the
   * server. The boundary (046): the envelope's name and id are the SERVER's
   * word; what is enforced is that the EVENT's claims cannot exceed the
   * envelope's identity.
   *
   * Only when an envelope is there to look up: a raw write with no actor set
   * must not probe the registry — a SELECT the writer's role may not hold,
   * whose answer could only be NULL.
   */
  IF v_agent IS NOT NULL OR actor->>'name' IS NOT NULL THEN
    v_kind := ob1_registry_kind(v_agent, actor->>'name');
  END IF;

  /**
   * trust is the CEILING on the content, and the key's kind is the highest it
   * can be (046): undeclared, it is the kind; declared lower, the declaration
   * stands; declared higher, it is clamped and the attempt recorded under
   * `claimed`. A key of unknown kind supports only a declared `ingested`.
   * ob1_trust_ceiling is the one copy, which the amendment gate and the
   * backfill call too.
   */
  v_declared := event->>'trust';
  v_trust := ob1_trust_ceiling(v_kind, v_declared);
  IF v_declared IS NOT NULL AND v_declared IS DISTINCT FROM v_trust THEN
    v_claimed := v_claimed || jsonb_build_object('trust', v_declared);
  END IF;
  IF event->>'actor_kind' IS NOT NULL AND (event->>'actor_kind') IS DISTINCT FROM v_kind THEN
    v_claimed := v_claimed || jsonb_build_object('actor_kind', event->>'actor_kind');
  END IF;

  -- The free-form remainder (046): everything the envelope carried that has no
  -- column. `via` joins the strip list when it is a door (ob1_door_of, read
  -- once, so the column and the strip cannot disagree); `source` LEAVES it —
  -- the column is the row's own metadata.source, one vocabulary. A `claimed`
  -- the envelope sent moves under caller_claimed first: `claimed` is THIS
  -- function's key, read by the gate and the backfill as the declaration filed
  -- while the key was unclassified, and a caller must not pre-seed it.
  v_context := COALESCE(actor - 'name' - 'session' - 'agent_id', '{}'::jsonb);
  v_origin := ob1_door_of(actor);
  IF v_origin IS NOT NULL THEN
    v_context := v_context - 'via';
  END IF;
  IF v_context ? 'claimed' THEN
    v_context := (v_context - 'claimed') || jsonb_build_object('caller_claimed', v_context->'claimed');
  END IF;
  IF v_claimed <> '{}'::jsonb THEN
    v_context := v_context || jsonb_build_object('claimed', v_claimed);
  END IF;

  -- 046's late gate: an unchanged write whose event carried only a trust or an
  -- actor_kind the key supports — a lowering, honoured — is nothing to record.
  -- One the key does NOT support — a clamp — is a fact about the caller, and
  -- this row is the only place SMD-1724 can count it. Stance, cites and a
  -- window were let through by the trigger's no-op guard.
  IF p_action = 'update' AND p_diff = '{}'::jsonb
     AND NOT COALESCE(event ?| ARRAY['stance', 'cites', 'valid_from', 'valid_until'], false)
     AND v_claimed = '{}'::jsonb THEN
    RETURN NULL;
  END IF;

  INSERT INTO thought_audit (
    thought_id, action, source, actor_name, canonical_agent_id,
    author_session_id, diff, actor_context,
    actor_kind, trust, origin, stance, cites, valid_from, valid_until)
  VALUES (
    p_thought,
    p_action,
    -- 046: the row's own metadata.source, and nothing else.
    p_source,
    actor->>'name',
    v_agent,
    actor->>'session',
    p_diff,
    -- NULL rather than an empty object when the actor carries nothing extra.
    NULLIF(v_context, '{}'::jsonb),
    v_kind,
    v_trust,
    v_origin,
    -- NULL throughout on a tombstone: a tombstone declares nothing (046).
    event->>'stance',
    CASE WHEN event ? 'cites' THEN ARRAY(SELECT jsonb_array_elements_text(event->'cites'))::uuid[] END,
    (event->>'valid_from')::timestamptz,
    (event->>'valid_until')::timestamptz
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION ob1_append_thought_event(uuid, text, text, jsonb, jsonb) IS
  'Append one thought_audit row — 046''s trigger tail as a function: who from the ob1.actor envelope and the registry (ob1_registry_kind by the envelope''s id, else its name; never from the payload), the trust ceiling (ob1_trust_ceiling), the door (ob1_door_of), a claim the key could not support filed under actor_context.claimed, the event''s stance / cites / window (none on a delete), and 046''s late gate (an update with an empty diff declaring only a trust or kind the key supports writes nothing). Returns the row''s id, or NULL when the gate dropped it. thoughts_write_audit calls it for every audited write; SMD-1997 step 2 makes the write functions call it before the row exists. Migration 055 / SMD-2115.';

-- ---------------------------------------------------------------------------
-- 3. 050's two stamp arms, callable.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_actor_stamp(p_meta jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  actor   jsonb;
  v_raw   text;
  v_agent uuid;
  v_name  text;
  v_kind  text;
  v_meta  jsonb;
BEGIN
  /**
   * ob1:actor-on-the-row-from-the-key — a CONTRACT SENTINEL, not prose (the
   * 014 convention): the two keys are written from the envelope and the
   * registry, never copied from the payload (050).
   *
   * A new text takes its writer from whoever set the envelope. The setting
   * is read inline first — a raw load with no actor pays one current_setting
   * and nothing more — and through 008's reader when set, so a malformed
   * envelope is no actor rather than a failed write. Then 010's id reading
   * and 046's one lookup, only when the envelope names an id or a name.
   */
  IF p_meta IS NOT NULL AND jsonb_typeof(p_meta) <> 'object' THEN
    RETURN p_meta;  -- a raw writer's array or scalar is not this rule's to fix
  END IF;
  v_raw := current_setting('ob1.actor', true);
  IF v_raw IS NOT NULL AND v_raw <> '' THEN
    actor := ob1_current_actor();
  END IF;
  IF actor IS NOT NULL AND jsonb_typeof(actor) = 'object' THEN
    v_name  := NULLIF(btrim(actor->>'name'), '');
    v_agent := CASE
      WHEN actor->>'agent_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (actor->>'agent_id')::uuid
    END;
    IF v_agent IS NOT NULL OR v_name IS NOT NULL THEN
      v_kind := ob1_registry_kind(v_agent, v_name);
    END IF;
  END IF;
  v_meta := COALESCE(p_meta, '{}'::jsonb) - 'actor_kind' - 'actor_name';
  IF v_kind IS NOT NULL THEN
    v_meta := v_meta || jsonb_build_object('actor_kind', v_kind);
  END IF;
  IF v_name IS NOT NULL THEN
    v_meta := v_meta || jsonb_build_object('actor_name', v_name);
  END IF;
  -- A NULL metadata with nothing to add stays NULL: the stamp adds keys, it
  -- does not decide the column's emptiness for a raw writer (050).
  IF p_meta IS NULL AND v_meta = '{}'::jsonb THEN
    RETURN NULL;
  END IF;
  RETURN v_meta;
END;
$$;

COMMENT ON FUNCTION ob1_actor_stamp(jsonb) IS
  'A new text''s metadata with the writer''s mark (050''s stamp, callable): metadata.actor_kind (ob1_agents.kind for the ob1.actor envelope''s agent_id, else its name — ob1_registry_kind) and metadata.actor_name (the envelope''s name), never from the payload — the payload''s own values under either key are removed first. No envelope, no mark; a non-object metadata passes untouched; a NULL with nothing to add stays NULL. ob1_stamp_actor calls it on an INSERT and on an UPDATE that changes the text. Migration 055 / SMD-2115.';

CREATE OR REPLACE FUNCTION ob1_actor_stamp_kept(p_new jsonb, p_old jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_meta jsonb;
BEGIN
  -- 050's same-text arm: the actor follows the content, so the mark stays as
  -- it was whatever the patch said — a re-embed, a metadata touch, a raw
  -- `SET metadata = NULL` on a marked row all keep the writer of the text.
  IF p_new IS NOT NULL AND jsonb_typeof(p_new) <> 'object' THEN
    RETURN p_new;
  END IF;
  IF p_new->'actor_kind' IS NOT DISTINCT FROM p_old->'actor_kind'
     AND p_new->'actor_name' IS NOT DISTINCT FROM p_old->'actor_name' THEN
    RETURN p_new;  -- the common case: the same two keys in and out
  END IF;
  v_meta := COALESCE(p_new, '{}'::jsonb) - 'actor_kind' - 'actor_name';
  IF jsonb_typeof(p_old) = 'object' THEN
    IF p_old ? 'actor_kind' THEN
      v_meta := v_meta || jsonb_build_object('actor_kind', p_old->'actor_kind');
    END IF;
    IF p_old ? 'actor_name' THEN
      v_meta := v_meta || jsonb_build_object('actor_name', p_old->'actor_name');
    END IF;
  END IF;
  RETURN v_meta;
END;
$$;

COMMENT ON FUNCTION ob1_actor_stamp_kept(jsonb, jsonb) IS
  'An unchanged text''s metadata with the writer''s mark kept as it was (050''s same-text arm, callable): p_new''s actor_kind and actor_name replaced by p_old''s, whatever the patch said — the actor follows the content. A non-object p_new passes untouched. ob1_stamp_actor calls it on an UPDATE that leaves the text. Migration 055 / SMD-2115.';

-- ---------------------------------------------------------------------------
-- 4. 050's stamp trigger, calling the two arms. The pass-through, the
--    non-object guard and the same-text detection — the two hashes, ordered
--    as 050 ordered them — stay here; what each arm writes is the function's.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_stamp_actor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_same boolean := false;
BEGIN
  -- The backfill's own write (050): it has derived the keys from the log and
  -- sets them as given, under its setting. SMD-1997 step 2's projector runs
  -- under the same pass-through, the metadata already stamped in the event.
  IF current_setting('ob1.actor_amend', true) = 'backfill' THEN
    RETURN NEW;
  END IF;
  -- metadata is an object on every row the writers make (005); a raw
  -- writer's array or scalar is not this trigger's to fix (050).
  IF NEW.metadata IS NOT NULL AND jsonb_typeof(NEW.metadata) <> 'object' THEN
    RETURN NEW;
  END IF;

  -- The same text, by 003's rule or the same bytes (050): OLD's text is
  -- always hashed, because OLD's column cannot be trusted after a raw content
  -- UPDATE; NEW's column is trusted when it moved to a value (update_thought
  -- writes fp(text) there), else NEW's text is hashed too. Two IFs, not one
  -- OR — an SQL expression is not short-circuit, and the hashes are wanted
  -- only when the bytes differ.
  IF TG_OP = 'UPDATE' THEN
    v_same := NEW.content IS NOT DISTINCT FROM OLD.content;
    IF NOT v_same THEN
      v_same := content_fingerprint_of(OLD.content) IS NOT DISTINCT FROM
                CASE WHEN NEW.content_fingerprint IS NOT NULL
                      AND NEW.content_fingerprint IS DISTINCT FROM OLD.content_fingerprint
                     THEN NEW.content_fingerprint
                     ELSE content_fingerprint_of(NEW.content) END;
    END IF;
  END IF;
  IF v_same THEN
    NEW.metadata := ob1_actor_stamp_kept(NEW.metadata, OLD.metadata);
    RETURN NEW;
  END IF;
  -- An INSERT, or an UPDATE that changes the content: the writer is whoever
  -- set the envelope — ob1:actor-on-the-row-from-the-key, in ob1_actor_stamp.
  NEW.metadata := ob1_actor_stamp(NEW.metadata);
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION ob1_stamp_actor() IS
  'BEFORE INSERT OR UPDATE on thoughts (thoughts_stamp_actor, 050): writes metadata.actor_kind (ob1_agents.kind for the envelope''s agent_id, else its name — ob1_registry_kind, 046) and metadata.actor_name (the envelope''s name) from the ob1.actor setting 008''s writers set, never from the payload — a payload''s own values under either key are overwritten or removed. The actor follows the content: an INSERT and an UPDATE that changes the text (by 003''s normalised fingerprint, so 018''s unchanged edit is unchanged here too) stamp from the envelope present (no envelope, no mark) through ob1_actor_stamp; an UPDATE that leaves the text keeps the mark as it was through ob1_actor_stamp_kept — the two arms as functions since 055, one copy for the write functions to call. A non-object metadata (a raw writer''s) passes untouched. Under ob1.actor_amend = ''backfill'' the keys are taken as given (backfill_thought_actors). Migration 050 / SMD-1726; the arms lifted out by 055 / SMD-2115.';

-- ---------------------------------------------------------------------------
-- 5. The audit trigger: 046's body with the rules called rather than
--    spelled. What stays here is what only a trigger can do — read OLD and
--    NEW, read and clear the event handoff, and hold 008's no-op guard.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION thoughts_write_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  event    jsonb;
  v_raw    text;
  v_action text;
  v_diff   jsonb;
  v_id     uuid;
  v_source text;
BEGIN
  /**
   * 046: the event is read ONCE and the setting cleared — so a raw write
   * later in the same transaction cannot inherit a stance, cites or window
   * declared for another row. A tombstone declares nothing: on DELETE the
   * event is not read at all (thoughts_delete_clears_event, 046's BEFORE
   * DELETE statement trigger, clears it before any row work). Read inline,
   * not through a function: one current_setting and nothing more on the
   * common path, where no event is set. A value that does not begin as an
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
   * ingester's) is what a replay could not know otherwise.
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

  /**
   * An update that changed nothing is not an event (008): a re-capture of
   * identical content takes the ON CONFLICT branch and moves updated_at and
   * nothing else, and recording that wrote one empty row per duplicate of a
   * bulk re-import. 046: an unchanged write that DECLARED an event is an
   * event — a restatement with a stance, cites or a window is recorded with
   * an empty diff; one carrying only a trust or an actor_kind goes on to the
   * key's word in the append, where the late gate decides. (`?|` on a NULL
   * event is NULL; NOT NULL is NULL; the IF takes the row — so the NULL case
   * is spelled: no event, no row.)
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
  'AFTER INSERT OR UPDATE OR DELETE on thoughts (thoughts_audit, 008): derives the event from OLD and NEW through ob1_thought_diff (046''s diff rule with 055''s three additions — a capture''s content and a backdating writer''s created_at, an update''s key move), holds 008''s no-op guard (an unchanged write declaring no event writes no row), reads and clears the ob1.event handoff once (046), and appends the row through ob1_append_thought_event (who from the key, the ceiling, the door, the claim, the late gate). At 055 the row is still written first and the trigger describes it; SMD-1997 step 2 makes the trigger the check under ob1.projecting. Migration 008 / 025 / 046 / 055 (SMD-2115).';

-- ---------------------------------------------------------------------------
-- 5b. The boundary the derivation reads: since when seq is exact insertion
--     order — 050's applied_at from the ledger when the brain has one, else
--     this apply's own time (the suites apply the files with no ledger; every
--     row they write comes after). Written once; a re-apply keeps the first
--     value, since the rows do not move.
-- ---------------------------------------------------------------------------
DO $b$
DECLARE
  v_since timestamptz;
BEGIN
  IF to_regclass('schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT min(applied_at) FROM schema_migrations WHERE name LIKE ''050\_%''' INTO v_since;
  END IF;
  -- One form, whatever the migrator session's DateStyle: a ::text render
  -- under 'Postgres, DMY' would reach a reader under 'ISO, MDY' as a string
  -- it misparses or rejects (cold read, fourth review pass).
  INSERT INTO ob1_config (key, value)
  VALUES ('audit_seq_exact_since', to_char(COALESCE(v_since, now()) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US"+00"'))
  ON CONFLICT (key) DO NOTHING;
END
$b$;

-- ---------------------------------------------------------------------------
-- 6. What a capture row's payload derives to — one copy for the gate and
--    the backfill. Among the thought's rows written after the capture — a
--    row since the boundary above when its seq is larger, a row before it
--    when (created_at, seq) is larger — ordered by seq since the boundary
--    and by (created_at, seq) before it, and no further than the first later
--    tombstone or capture (this incarnation of a re-used id; that row
--    included, so the tombstone is read):
--      the first content-moving update's `before` — the text as captured;
--      else the tombstone's previous_content;
--      else the live row's content, when no later capture re-took the id;
--      else nothing, said as `none`.
--    created_at comes from the live row alone, and only when it differs
--    from the event's (the transaction's now() at the time). The header's
--    "WHAT AFTER THE CAPTURE MEANS" has the two review passes that shaped it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_capture_payload(p_thought uuid, p_at timestamptz, p_seq bigint)
RETURNS TABLE (content text, row_created_at timestamptz, source text)
LANGUAGE sql
STABLE
AS $$
  -- Absent (a pruned ob1_config, a partial restore), the boundary is
  -- 'infinity': every row takes the clock path — the ADR's default order,
  -- which cannot cross an incarnation — never the identity path, which on a
  -- brain with pre-050 history can (third review pass: '-infinity' chose the
  -- corrupting direction).
  WITH exact AS (
    SELECT COALESCE((SELECT c.value::timestamptz FROM ob1_config c WHERE c.key = 'audit_seq_exact_since'),
                    'infinity'::timestamptz) AS since
  ),
  -- The rows after the capture, and the clock that orders them: a row from
  -- before the boundary keeps its created_at (heap-order seq breaks ties, as
  -- 050 reads it); a row since takes the boundary itself, so every such row
  -- sorts after every earlier one and seq — exact insertion order — decides
  -- among them, whatever transaction start each carries.
  later AS (
    SELECT a.action, a.diff, a.seq,
           CASE WHEN a.created_at < x.since THEN a.created_at ELSE x.since END AS o_at
      FROM thought_audit a, exact x
     WHERE a.thought_id = p_thought
       AND CASE WHEN a.created_at < x.since THEN (a.created_at, a.seq) > (p_at, p_seq) ELSE a.seq > p_seq END
  ),
  -- …and no further than this incarnation of the id: the first later
  -- tombstone or capture closes it, that row included.
  edge AS (
    SELECT l.o_at, l.seq
      FROM later l
     WHERE l.action IN ('delete', 'capture')
     ORDER BY l.o_at, l.seq
     LIMIT 1
  ),
  mine AS (
    SELECT l.*
      FROM later l
     WHERE NOT EXISTS (SELECT 1 FROM edge e WHERE (l.o_at, l.seq) > (e.o_at, e.seq))
  ),
  -- The first update that carries a content key is the evidence: its
  -- `before` when that is a string; nothing when it is not (no writer's is —
  -- 001's content is NOT NULL — a planted row's may be), never the next
  -- update's `before`, which is the text after an edit (run-it, fourth
  -- review pass).
  mv AS (
    SELECT CASE WHEN jsonb_typeof(l.diff->'content'->'before') = 'string' THEN l.diff->'content'->>'before' END AS c
      FROM mine l
     WHERE l.action = 'update' AND l.diff ? 'content'
     ORDER BY l.o_at, l.seq
     LIMIT 1
  ),
  tomb AS (
    SELECT l.diff->>'previous_content' AS c
      FROM mine l
     WHERE l.action = 'delete' AND jsonb_typeof(l.diff->'previous_content') = 'string'
     ORDER BY l.o_at, l.seq
     LIMIT 1
  ),
  -- The live row is this capture's only while no later tombstone or capture
  -- closed the incarnation: a row standing after a tombstone was put there
  -- without a capture event (a load with the trigger off) and is another
  -- incarnation's — its created_at no more this event's than its text (cold
  -- read, fourth review pass: the guard read the later captures alone, and a
  -- tombstone's text went out beside a second incarnation's time).
  live AS (
    SELECT t.content, t.created_at
      FROM thoughts t
     WHERE t.id = p_thought AND NOT EXISTS (SELECT 1 FROM edge)
  )
  SELECT CASE WHEN EXISTS (SELECT 1 FROM mv) THEN (SELECT c FROM mv)
              ELSE COALESCE((SELECT c FROM tomb), (SELECT l.content FROM live l)) END AS content,
         CASE WHEN (SELECT l.created_at FROM live l) IS DISTINCT FROM p_at THEN (SELECT l.created_at FROM live l) END AS row_created_at,
         CASE WHEN EXISTS (SELECT 1 FROM mv WHERE c IS NOT NULL) THEN 'update'
              WHEN EXISTS (SELECT 1 FROM mv) THEN 'none'
              WHEN EXISTS (SELECT 1 FROM tomb) THEN 'delete'
              WHEN EXISTS (SELECT 1 FROM live) THEN 'row'
              ELSE 'none' END AS source
$$;

COMMENT ON FUNCTION ob1_capture_payload(uuid, timestamptz, bigint) IS
  'What a capture row written before 055 derives to, for the payload amendment: among the thought''s events written after it — a row since ob1_config.audit_seq_exact_since (050''s applied_at) when its seq is larger, a row before it when (created_at, seq) is larger; ordered by seq since, by (created_at, seq) before — and no further than the first later tombstone or capture (this incarnation of the id), its content from the first update carrying a content key (the `before`; nothing when that is no string), else the tombstone''s previous_content, else the live row''s content when no later tombstone or capture closed the incarnation, else NULL with source `none`; its created_at from the live row alone, and only when it differs from the event''s. The gate (thought_audit_refuse_mutation under ob1.audit_amend = ''payload'') and backfill_thought_payloads both read it, so a hand fill can write nothing the pass would not. Migration 055 / SMD-2115.';

-- ---------------------------------------------------------------------------
-- 7. Immutable by rule: 008's refusal, 046's kind-fill arm verbatim, and the
--    payload arm — the third named amendment. The trigger knows which change
--    is lawful, so nothing outside it has to.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION thought_audit_refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_kind     text;
  v_origin   text;
  v_trust    text;
  v_why      text;
  v_content  text;
  v_created  timestamptz;
  v_source   text;
  v_old      jsonb;
  v_new      jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('ob1.audit_amend', true) = 'backfill' THEN
    -- ob1:audit-amend-fills-null-only — a CONTRACT SENTINEL, not prose (the
    -- 014 convention); preflight's `audit events` check reads it.
    -- What the row derives to, through the two rules the audit trigger and the
    -- backfill read.
    v_kind   := COALESCE(OLD.actor_kind, ob1_registry_kind(OLD.canonical_agent_id, OLD.actor_name));
    v_origin := COALESCE(OLD.origin, ob1_door_of(OLD.actor_context));
    v_trust  := COALESCE(OLD.trust, CASE WHEN v_kind IS NOT NULL THEN ob1_trust_ceiling(v_kind, OLD.actor_context->'claimed'->>'trust') END);
    -- Each condition named when it fails (run-it, second review pass: thirteen
    -- different refusals read one sentence), so a hand amendment learns which
    -- of the five it broke — and that it must fill everything derivable at once.
    -- Each of the three may be left as it was (a fill may be partial — the
    -- backfill's candidates are derived under its statement's snapshot, the
    -- gate's under a fresher one, and a key registered between the two must
    -- not roll a pass back; fourth review pass) or set to what it derives to;
    -- never anything else, and something must be filled. `diff` is among the
    -- columns that must not move under THIS value: the payload is the arm
    -- below's, under its own (055).
    IF (to_jsonb(OLD) - 'actor_kind' - 'trust' - 'origin' - 'backfilled_at')
       <> (to_jsonb(NEW) - 'actor_kind' - 'trust' - 'origin' - 'backfilled_at') THEN
      v_why := 'a column other than actor_kind, trust, origin and backfilled_at changes';
    ELSIF NEW.actor_kind IS DISTINCT FROM OLD.actor_kind AND NEW.actor_kind IS DISTINCT FROM v_kind THEN
      v_why := format('actor_kind must be what the registry holds for the row''s key, %L', v_kind);
    ELSIF NEW.trust IS DISTINCT FROM OLD.trust AND NEW.trust IS DISTINCT FROM v_trust THEN
      v_why := format('trust must be what the rule gives from that kind and the row''s filed claim, %L', v_trust);
    ELSIF NEW.origin IS DISTINCT FROM OLD.origin AND NEW.origin IS DISTINCT FROM v_origin THEN
      v_why := format('origin must be the door the row''s own blob carries, %L', v_origin);
    ELSIF NEW.actor_kind IS NOT DISTINCT FROM OLD.actor_kind AND NEW.trust IS NOT DISTINCT FROM OLD.trust AND NEW.origin IS NOT DISTINCT FROM OLD.origin THEN
      v_why := 'nothing is filled';
    ELSIF NEW.backfilled_at IS DISTINCT FROM now() THEN
      v_why := 'backfilled_at must be now(), this transaction''s time';
    ELSE
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'thought_audit is append-only: the backfill amendment may only fill a NULL actor_kind, trust or origin with what the row derives to, and stamp backfilled_at with now() — here %.',
      v_why;
  END IF;

  IF TG_OP = 'UPDATE' AND current_setting('ob1.audit_amend', true) = 'payload' THEN
    -- ob1:audit-amend-fills-payload-only — a CONTRACT SENTINEL, not prose
    -- (the 014 convention); test-schema reads it. The third named amendment
    -- (055): a CAPTURE row's diff.content and diff.created_at, where absent,
    -- with what the log and the row derive to (ob1_capture_payload, the
    -- backfill's own reading), and nothing else — every other column
    -- byte-equal with `diff` removed as the fifth column under this value
    -- alone, every other key of diff byte-equal, a value once set never
    -- changed, something filled. Each condition named when it fails.
    -- A NULL diff (a hand INSERT's; every writer's is an object) counts as
    -- empty before, so the pass can fill it onto an object.
    v_old := COALESCE(OLD.diff, '{}'::jsonb);
    v_new := COALESCE(NEW.diff, '{}'::jsonb);
    IF OLD.action <> 'capture' THEN
      v_why := 'only a capture row takes a payload';
    ELSIF (to_jsonb(OLD) - 'diff') <> (to_jsonb(NEW) - 'diff') THEN
      v_why := 'a column other than diff changes';
    ELSIF jsonb_typeof(v_old) <> 'object' OR jsonb_typeof(v_new) <> 'object' THEN
      v_why := 'diff must be an object before and after (a NULL diff counts as empty)';
    ELSIF (v_old - 'content' - 'created_at') <> (v_new - 'content' - 'created_at') THEN
      v_why := 'a key of diff other than content and created_at changes';
    ELSIF v_old ? 'content' AND v_new->'content' IS DISTINCT FROM v_old->'content' THEN
      v_why := 'a content once set is never changed';
    ELSIF v_old ? 'created_at' AND v_new->'created_at' IS DISTINCT FROM v_old->'created_at'
          AND (v_new->>'created_at' IS NULL OR v_new->>'created_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}'
               OR v_old->>'created_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}'
               OR (v_new->>'created_at')::timestamptz IS DISTINCT FROM (v_old->>'created_at')::timestamptz) THEN
      -- Byte-equal is unchanged, whatever the bytes: a created_at set by hand
      -- to no timestamp is not this arm's to judge, and the pass, which never
      -- rewrites a set one, fills the content beside it (cold read, fourth
      -- review pass: the shape test ran on the unchanged value, so the fill
      -- was refused five times and the apply failed). Otherwise as an
      -- instant, not as bytes: a timestamptz in jsonb renders in the
      -- session's TimeZone, and a hand fill under another zone is the same time.
      v_why := 'a created_at once set is never changed';
    ELSIF (v_new ? 'content') = (v_old ? 'content') AND (v_new ? 'created_at') = (v_old ? 'created_at') THEN
      v_why := 'nothing is filled';
    ELSIF (v_new ? 'created_at') AND NOT (v_old ? 'created_at') AND (v_old ? 'content') THEN
      -- A complete capture event gains no time it never had, however the
      -- row's created_at is moved later (run-it, first review pass).
      v_why := 'a created_at is filled with the content or before it, never onto a row that already carries its content';
    ELSE
      SELECT p.content, p.row_created_at, p.source INTO v_content, v_created, v_source
        FROM ob1_capture_payload(OLD.thought_id, OLD.created_at, OLD.seq) p;
      IF (v_new ? 'content') AND NOT (v_old ? 'content') AND jsonb_typeof(v_new->'content') <> 'string' THEN
        v_why := 'content must be a string';
      ELSIF (v_new ? 'content') AND NOT (v_old ? 'content')
         AND (v_content IS NULL OR (v_new->>'content') IS DISTINCT FROM v_content) THEN
        v_why := CASE WHEN v_content IS NULL THEN 'no content derives for this row (no later content-moving update, no tombstone, no live row)'
                      ELSE format('content must be the text the log and the row derive to (from the %s)', v_source) END;
      ELSIF (v_new ? 'created_at') AND NOT (v_old ? 'created_at')
         AND (v_new->>'created_at' IS NULL OR v_new->>'created_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}') THEN
        -- Shape first, so a string that is no timestamp is refused by name
        -- rather than by the cast's own error (run-it, first review pass).
        v_why := 'created_at must be a timestamp';
      ELSIF (v_new ? 'created_at') AND NOT (v_old ? 'created_at')
         AND (v_created IS NULL OR (v_new->>'created_at')::timestamptz IS DISTINCT FROM v_created) THEN
        v_why := CASE WHEN v_created IS NULL THEN 'no created_at derives for this row (no live row, or the row''s equals the event''s)'
                      ELSE 'created_at must be the live row''s own' END;
      ELSE
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION
      'thought_audit is append-only: the payload amendment may only fill a capture row''s diff.content and diff.created_at, where absent, with what the log and the row derive to — here %.',
      v_why;
  END IF;

  -- 008: the guidance is in the MESSAGE rather than in USING HINT deliberately.
  -- Bun's Postgres client returns the HINT field as UTF-16 bytes with
  -- interleaved nulls, so anything put there is unreadable to the runtime this
  -- server actually uses.
  RAISE EXCEPTION
    'thought_audit is append-only: % is not permitted. To prune history, DROP TRIGGER % in a migration — deliberately, and with a record of why.',
    TG_OP, CASE WHEN TG_OP = 'TRUNCATE' THEN 'thought_audit_immutable_truncate' ELSE 'thought_audit_immutable' END;
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. The rows still waiting for their payload — the backfill's candidates and
--    preflight's census, by index rather than by heap. Empty once the pass has
--    run on a brain whose every capture derives, so it costs nothing after.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS thought_audit_awaiting_payload_idx
  ON thought_audit (created_at, seq)
  WHERE action = 'capture' AND NOT COALESCE(diff ? 'content', false);

-- ---------------------------------------------------------------------------
-- 9. The backfill: the payload onto every capture row written before this
--    file, from the log first and the row second.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION backfill_thought_payloads(p_limit integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SET lock_timeout = '10s'
AS $$
DECLARE
  v_prev_amend text := current_setting('ob1.audit_amend', true);
  -- 023's shape: a temp table named per call and dropped at commit, so two
  -- calls in one transaction never meet each other's, and nothing is dropped
  -- by hand (CLAUDE.md's rail).
  v_tbl        text := format('ob1_payload_backfill_%s', to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'));
  v_rows       integer := 0;
  v_update     integer;
  v_tomb       integer;
  v_row        integer;
  v_none       integer;
  v_skipped    integer;
  v_stamped    integer;
  v_awaiting   integer;
  v_moved      integer;
  v_got        integer;
  v_n          bigint;
  v_lo         bigint := 0;
  v_fruitless  integer;
  -- A refusal costs one batch, not the pass (fourth review pass).
  v_batch      constant integer := 1000;
BEGIN
  IF p_limit IS NOT NULL AND p_limit < 1 THEN
    RAISE EXCEPTION 'backfill_thought_payloads: p_limit must be at least 1, or NULL for every row (got %)', p_limit;
  END IF;

  -- The candidates, read through the partial index in (created_at, seq)
  -- order (a bounded pass; the file's own unbounded call sorts the heap, the
  -- right plan when every row is one), each derived once (ob1_capture_payload
  -- — the gate's own reading) and numbered in that order for the batches
  -- below; whether the row already carried a created_at (a hand fill of the
  -- time alone is lawful), whether this pass filled it and whether its
  -- derivation moved ride along. A diff that is no object is no candidate:
  -- the gate would refuse every fill onto it, and the pass could not
  -- complete (cold read, fourth review pass).
  EXECUTE format($scan$
    CREATE TEMP TABLE %I ON COMMIT DROP AS
    SELECT c.id, p.content, p.row_created_at, p.source,
           COALESCE(c.diff ? 'created_at', false) AS had_created_at,
           false AS filled,
           false AS moved,
           row_number() OVER (ORDER BY c.created_at, c.seq) AS n
      FROM (SELECT a.id, a.thought_id, a.created_at, a.seq, a.diff
              FROM thought_audit a
             WHERE a.action = 'capture' AND NOT COALESCE(a.diff ? 'content', false)
               AND jsonb_typeof(COALESCE(a.diff, '{}'::jsonb)) = 'object'
             ORDER BY a.created_at, a.seq
             LIMIT %s) c
      CROSS JOIN LATERAL ob1_capture_payload(c.thought_id, c.created_at, c.seq) p
  $scan$, v_tbl, COALESCE(p_limit::text, 'NULL'));
  EXECUTE format('SELECT count(*) FROM %I', v_tbl) INTO v_n;

  PERFORM set_config('ob1.audit_amend', 'payload', true);
  -- Re-read on the row as it is when the lock is taken (READ COMMITTED): a
  -- pass that ran beside this one and filled the row first leaves it nothing
  -- to fill, and it is skipped rather than refused (046's rule for its pass);
  -- a created_at a hand fill set stays as it is. The rows the UPDATE returns
  -- are marked, so the counts below are of what THIS pass wrote (run-it,
  -- first review pass: a second pass reported the first's rows as its own).
  --
  -- The gate re-derives each row under a fresh snapshot (a VOLATILE trigger),
  -- so a thought deleted between the scan and the trigger's read derives
  -- differently — its created_at is gone with the row — and is refused, which
  -- aborts the statement; before the second review pass one delete_thought
  -- from a live server during the apply failed the whole migration (run-it).
  -- A pre-check in the UPDATE's WHERE cannot close that window: it reads the
  -- statement's snapshot, the gate a later one (the first review pass's
  -- re-derive changed nothing and cost a third of the pass). So the fill runs
  -- in batches of v_batch candidates, and a refusal is caught: nothing of the
  -- batch stands, its candidates are re-derived under a fresh snapshot, the
  -- rows whose derivation moved are set aside as `skipped` (the next pass
  -- fills them from their tombstones), and the batch runs again. A refusal
  -- that set nothing aside is the defect it would be: five of them in one
  -- batch and it is raised. (Fourth review pass: one statement over every
  -- candidate, retried five times whatever the retry found, was exhausted by
  -- ten deletes over half a second — run-it, at 5,000 rows.) Each attempt
  -- costs one savepoint; a productive one marks at least one candidate, so
  -- a batch runs at most v_batch + 5 times.
  WHILE v_lo < v_n LOOP
    v_fruitless := 0;
    LOOP
      BEGIN
        EXECUTE format($fill$
          WITH f AS (
            UPDATE thought_audit a
               SET diff = COALESCE(a.diff, '{}'::jsonb)
                          || jsonb_build_object('content', d.content)
                          || CASE WHEN d.row_created_at IS NULL OR COALESCE(a.diff ? 'created_at', false) THEN '{}'::jsonb
                                  ELSE jsonb_build_object('created_at', d.row_created_at) END
              FROM %I d
             WHERE a.id = d.id
               AND d.n > %s AND d.n <= %s
               AND d.content IS NOT NULL
               AND NOT d.moved
               AND a.action = 'capture'
               AND NOT COALESCE(a.diff ? 'content', false)
             RETURNING d.id)
          UPDATE %I t SET filled = true FROM f WHERE t.id = f.id
        $fill$, v_tbl, v_lo, v_lo + v_batch, v_tbl);
        GET DIAGNOSTICS v_got = ROW_COUNT;
        v_rows := v_rows + v_got;
        EXIT;
      EXCEPTION WHEN raise_exception THEN
        EXECUTE format($again$
          UPDATE %I d SET moved = true
            FROM (SELECT d2.id, p.content, p.row_created_at
                    FROM %I d2
                    JOIN thought_audit a ON a.id = d2.id
                    CROSS JOIN LATERAL ob1_capture_payload(a.thought_id, a.created_at, a.seq) p
                   WHERE NOT d2.moved AND d2.n > %s AND d2.n <= %s) n
           WHERE n.id = d.id
             AND (n.content IS DISTINCT FROM d.content OR n.row_created_at IS DISTINCT FROM d.row_created_at)
        $again$, v_tbl, v_tbl, v_lo, v_lo + v_batch);
        GET DIAGNOSTICS v_moved = ROW_COUNT;
        IF v_moved = 0 THEN
          v_fruitless := v_fruitless + 1;
          IF v_fruitless = 5 THEN
            RAISE;
          END IF;
        END IF;
      END;
    END LOOP;
    v_lo := v_lo + v_batch;
  END LOOP;
  PERFORM set_config('ob1.audit_amend', COALESCE(v_prev_amend, ''), true);

  EXECUTE format($count$
    SELECT count(*) FILTER (WHERE filled AND source = 'update'),
           count(*) FILTER (WHERE filled AND source = 'delete'),
           count(*) FILTER (WHERE filled AND source = 'row'),
           count(*) FILTER (WHERE NOT filled AND NOT moved AND source = 'none'),
           count(*) FILTER (WHERE NOT filled AND (moved OR source <> 'none')),
           count(*) FILTER (WHERE filled AND row_created_at IS NOT NULL AND NOT had_created_at)
      FROM %I
  $count$, v_tbl) INTO v_update, v_tomb, v_row, v_none, v_skipped, v_stamped;

  -- What still waits: the capture rows without content — those a bounded
  -- pass did not reach, and those nothing derives for. Read through the
  -- index: with the type clause the planner's estimate stays small and the
  -- count is a bitmap scan of the index under stale statistics as under
  -- fresh; without it the default selectivity of the `?` test read half the
  -- table and the heap was scanned (run-it, fourth review pass, at 20,000).
  SELECT count(*)::int INTO v_awaiting
    FROM thought_audit
   WHERE action = 'capture' AND NOT COALESCE(diff ? 'content', false)
     AND jsonb_typeof(COALESCE(diff, '{}'::jsonb)) = 'object';

  RETURN jsonb_build_object(
    'ok', true,
    'rows', v_rows,
    'from_update', v_update,
    'from_tombstone', v_tomb,
    'from_row', v_row,
    'with_created_at', v_stamped,
    'unrecoverable', v_none,
    'skipped', v_skipped,
    'awaiting', v_awaiting);
END;
$$;

COMMENT ON FUNCTION backfill_thought_payloads(integer) IS
  'Fill diff.content — and diff.created_at where the live row''s differs from the event''s — on capture rows written before 055, from the first content-moving update''s `before`, else the tombstone''s previous_content, else the live row (ob1_capture_payload): the third amendment thought_audit_immutable allows, under ob1.audit_amend = ''payload''. Idempotent; p_limit bounds a pass (each call its own transaction); the fill runs in batches of 1,000; a refusal by the gate for a thought deleted while the pass ran is caught, the moved rows set aside, the batch retried (a refusal that moves nothing is raised after five). A capture row whose diff is no object is no candidate. Returns {ok, rows, from_update, from_tombstone, from_row, with_created_at, unrecoverable, skipped, awaiting}: rows and the by-source counts are what THIS pass wrote; with_created_at those of them that gained a created_at; unrecoverable the candidates nothing derives for (left as they are); skipped the candidates another pass filled meanwhile or whose derivation moved while this one ran (whatever they derived to at the scan); awaiting the capture rows still without content. Migration 055 / SMD-2115.';

-- ---------------------------------------------------------------------------
-- 10. What the columns and the table say now.
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN thought_audit.diff IS
  'capture: the creating metadata and, since 055, the content — and created_at when the writer set the row''s own time (a backdating ingester''s; absent when the row took now()); derived_from and supersedes when set. update: before/after of each changed field — content, metadata, supersedes, derived_from and, since 055, content_fingerprint when the key moved — and embedding_present when the vector''s presence flipped. delete: previous_content, previous_metadata, previous_derived_from and previous_supersedes, in full, for recovery. On a capture row from before 055 the content and created_at are filled after the fact by backfill_thought_payloads, the one change the payload amendment allows. Migration 008 / 025 / 046 / 055 (SMD-2115).';

COMMENT ON TABLE thought_audit IS
  'Append-only log of every capture/update/delete on thoughts, and since 046 the log of record SMD-1729''s views derive from: who (actor_name, canonical_agent_id, actor_kind from the key), the door (origin), the ceiling on the content (trust), what changed (diff — since 055 a capture''s content and a backdating writer''s created_at, an update''s key move, so the log alone rebuilds every thought''s text: docs/event-log-as-truth.md, step 1), what the write claimed (stance, cites, valid_from/valid_until) and when (created_at, seq). Written by a trigger inside the mutating transaction, so an event cannot be lost independently of the change it describes. thought_id is deliberately not a foreign key so audit rows outlive their subject. UPDATE and DELETE are refused by trigger, not by grant; two lawful amendments: filling a NULL actor_kind/trust/origin and stamping backfilled_at (046), and filling a capture row''s diff.content / diff.created_at where absent (055). Partition key chosen and not applied (SMD-1730): RANGE on created_at by month — append-only, so a closed month is cold; SMD-1697''s bench decides when.';

-- Once, here: every capture row written before this file gains its payload
-- from the log and the row — or one batch of OB1_BACKFILL_LIMIT rows, the
-- rest by hand (023's knob; the migrator says which). A re-apply finds nothing.
SELECT backfill_thought_payloads({{BACKFILL_LIMIT}});
