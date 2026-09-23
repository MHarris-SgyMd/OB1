-- =============================================================================
-- Migration 049: the actor on the row — who wrote a thought's current text,
--                from the key, where a read can filter on it (SMD-1726)
-- =============================================================================
--
-- WHY
--   046 records who holds the key on every audit row (thought_audit.actor_kind,
--   from ob1_agents.kind, never from the payload) beside 008's actor_name. But
--   a read does not return audit rows: a search hit, a listed item and a fetch
--   carry the thoughts row and its metadata, and nothing on that row says who
--   wrote it. A hit an agent's summary pass wrote and a hit the operator typed
--   look identical, and "only what I said" cannot be asked. Mem0's 2026 report
--   calls actor-aware memory table stakes; SMD-1716 defers isolation BETWEEN
--   operators, and this is the smaller thing — one operator, several keys.
--
-- WHAT
--   1. TWO RESERVED KEYS IN thoughts.metadata, actor_kind and actor_name,
--      stamped by a BEFORE trigger (thoughts_stamp_actor, ob1_stamp_actor)
--      from the envelope 008's writers set (ob1.actor), through 046's one
--      registry lookup (ob1_registry_kind: the id's kind, else the name's).
--      NEVER from the payload: whatever a payload's metadata carried under
--      either key is overwritten — or removed, when the write names no key —
--      before the row is written. The kind is written only when the registry
--      knows it; the name whenever the envelope carries one. NULL (absent) is
--      the honest value for an unclassified key or a mutation made outside
--      the server, as it is on the audit row.
--
--      Why metadata and not two columns: 014's route. match_thoughts filters
--      INSIDE the scan on `metadata @> filter`, over 001's GIN index, on both
--      the walk and the exact branch, and SMD-1490's `filter` argument on the
--      search tools already reaches it — so `said_by: operator` is
--      `{"actor_kind": "operator"}` on a path that exists and is measured
--      (014, 037, 038). Two columns would need their own index and a sixth
--      redefinition of match_thoughts (037–041 each carry the whole body) for
--      a branch the filter already has. metadata already carries the row's
--      system-written keys (`source`, `type`, `topics`, from the extractor);
--      these two are the first the DATABASE writes, so the column's COMMENT
--      says so.
--
--   2. THE ACTOR FOLLOWS THE CONTENT — 021's rule for the label, applied to
--      the writer. An INSERT stamps. An UPDATE that changes the content
--      re-stamps from the envelope present, or removes the mark when none is:
--      the text is now the editor's. An UPDATE that leaves the content keeps
--      the mark as it was, whatever the patch said: a metadata-only edit, a
--      re-capture's merge (upsert_thought's ON CONFLICT never touches
--      content), a re-embed, 018's unchanged edit — none of them changes who
--      said it. The audit row records the stamp with the rest of the metadata
--      diff, so "an agent rewrote the operator's note" is in the log.
--
--   3. THE BACKFILL, backfill_thought_actors(p_limit): for every thought, the
--      audit row that WROTE THE TEXT THAT STANDS gives the writer, and the two
--      keys are set to exactly that wherever the row differs — so a pre-049
--      row carrying a caller's `actor_kind` is corrected (the log knows the
--      writer) or stripped (it does not), a stamped row is left alone, and a
--      re-apply writes nothing.
--
--      Which row, in three steps. First, the row whose text IS the thought's
--      text: an update row whose after-text hashes to the row's text (hashed
--      from the row, not its content_fingerprint column, which a raw update
--      leaves stale). A capture row carries no text in its diff — 008 records
--      metadata on a capture — so it stands only when no update ever changed
--      the text (that a capture-only thought was rewritten unaudited cannot be
--      seen; the capturer stands). Update rows present and none matching means
--      the text was written unaudited, and nobody is stamped, as for a thought
--      with no row at all (third and fourth review passes). Then created_at,
--      newest first. Then `seq`, a monotonic identity this file adds to
--      thought_audit, for two rows one transaction wrote: created_at is now(),
--      one value for the whole transaction, and id is a random uuid, so a
--      capture and an edit in one transaction ordered by those two was a coin
--      flip that rewrote the trigger's correct stamp (first review pass,
--      reproduced 6 of 12). seq is exact for rows written after 049; rows from
--      before take theirs at the ALTER in heap order, which is NOT insertion
--      order once 046's backfill has amended rows and VACUUM has let later
--      inserts fill the freed pages (second review pass, reproduced: ordered
--      by seq alone, an agent's rewrite took a smaller number than the
--      operator's capture, and the operator was stamped on the agent's text).
--      Hence the text first, created_at before seq.
--
--      Which kind: the registry's for the writer's id or name NOW, else the
--      kind 046 stamped on the audit row. The mark is a view of the row's
--      writer, not history, so a key reclassified by set_agent_kind reaches
--      its rows on the next pass; 046's audit rows keep the kind they were
--      stamped with — that IS history (first review pass).
--
--      Called once by the file with {{BACKFILL_LIMIT}} (023's knob,
--      OB1_BACKFILL_LIMIT); run again after set_agent_kind. Each row it writes
--      is an UPDATE of metadata, which 008's trigger records — an audit row per
--      thought written, its door `backfill_thought_actors`, its actor nobody:
--      the record the ticket asks for. What p_limit buys, said plainly: it
--      bounds the rows written and the write lock held per call, so a brain
--      with a million rows takes the marks in batches between writers; it does
--      not bound the scan — every call derives every thought's writer (one
--      probe of 008's thought_id index per thought, and the hashes of its
--      update rows' texts, which on long thoughts are the cost) — nor the
--      audit rows, one per row marked whatever the batch. The pass scans
--      before it locks and re-checks each row under the lock (023's shape):
--      updated_at unchanged, and the marks still disagreeing. It takes
--      thoughts IN EXCLUSIVE MODE for the write — writers wait for the call's
--      transaction, readers do not — so an edit in flight is waited for rather
--      than deadlocked against, and lock_timeout (10 s) aborts a pass a
--      writer's idle transaction would hold up.
--
--   4. NOT HERE, SAID SO. No index beyond 001's GIN: the filter's route is the
--      GIN's (a `said_by` matching most of the corpus is the walk with a
--      predicate, as any broad filter is — 037's route estimate decides). No
--      preflight census of the rows still without a kind — the backfill's
--      return carries `awaiting`, and whether a start-up census over
--      thoughts needs a bound is SMD-1947's question. The trust label on the
--      hit is SMD-1724's; the tool arguments `said_by` and `actor` and the
--      `By:` line are the server's half of this ticket.
--
-- PRIVILEGES
--   The trigger runs as the writer and reads ob1_agents — the SELECT
--   ROLE_GRANTS.capture holds since 046; nothing new. The backfill holds the
--   updated_at trigger for its pass (a stamp is not an edit: 018's stale-read
--   guard and 021's evidence rule read updated_at), which needs the table's
--   owner, as 023's does.
--
-- Idempotent. CREATE OR REPLACE throughout; the trigger drop-then-create (001's
-- form); the backfill writes only where the log and the row disagree.
--
-- APPLYING IT. The identity column REWRITES thought_audit once, under ACCESS
-- EXCLUSIVE (a volatile default on a populated table): seconds on a small log,
-- about a minute per million rows, with a copy of the table on disk meanwhile
-- and every capture waiting on its audit INSERT. The file then takes locks on
-- thoughts (the trigger, the backfill's EXCLUSIVE), the reverse of a capture's
-- order (thoughts, then thought_audit), so a capture in flight can deadlock
-- the apply — migrate.ts renders 40P01 and a re-run applies cleanly (046 has
-- the same shape; second review pass). Apply in a quiet window.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- The order of the log. created_at is one value per transaction and id is
-- random; seq is the order rows were written in. ADD COLUMN on the append-only
-- table is 010's and 046's precedent (the immutability trigger is a row
-- trigger on UPDATE and DELETE; DDL is neither), and the amendment gate
-- compares whole rows, so an added column that never changes passes it.
-- ---------------------------------------------------------------------------
ALTER TABLE thought_audit ADD COLUMN IF NOT EXISTS seq bigint GENERATED ALWAYS AS IDENTITY;

COMMENT ON COLUMN thought_audit.seq IS
  'The order rows were written in — an identity, assigned at INSERT, exact for rows written after 049. created_at is now(), one value for every row a transaction writes, and id is a random uuid, so neither orders two writes to one thought inside a transaction; seq does. Rows from before 049 took theirs at the ALTER in heap order, which is not insertion order where 046''s backfill amended rows and VACUUM let later inserts fill the freed space — so read created_at first and seq as the tiebreak, as backfill_thought_actors does. Migration 049 / SMD-1726.';

-- ---------------------------------------------------------------------------
-- The stamp: who wrote this text, from the key.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_stamp_actor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor   jsonb;
  v_raw   text;
  v_agent uuid;
  v_name  text;
  v_kind  text;
  v_meta  jsonb;
  v_same  boolean := false;
BEGIN
  /**
   * ob1:actor-on-the-row-from-the-key — a CONTRACT SENTINEL, not prose (the
   * 014 convention): the two keys below are written from the envelope and the
   * registry, never copied from the payload.
   *
   * The backfill's own write: it has derived the keys from the log and sets
   * them as given, under its setting — the same shape as 046's
   * ob1.audit_amend. A direct SQL caller who sets it is a caller with UPDATE
   * on thoughts, who can already write any metadata (046's boundary).
   */
  IF current_setting('ob1.actor_amend', true) = 'backfill' THEN
    RETURN NEW;
  END IF;
  -- metadata is an object on every row the writers make (005 refuses any
  -- other payload); a raw writer's array or scalar is not this trigger's to
  -- fix, and `-` on a scalar would fail its write (first review pass).
  IF NEW.metadata IS NOT NULL AND jsonb_typeof(NEW.metadata) <> 'object' THEN
    RETURN NEW;
  END IF;

  -- The same text, by 003's rule (content_fingerprint_of: whitespace and case
  -- folded — 018 calls that edit "unchanged" and never refuses it), or the
  -- same bytes. Two IFs, not one OR: an SQL expression is not short-circuit,
  -- and the hashes are wanted only when the bytes differ — a re-embed or a
  -- metadata touch compares no hash at all.
  IF TG_OP = 'UPDATE' THEN
    v_same := NEW.content IS NOT DISTINCT FROM OLD.content;
    -- The bytes differ: is it the same text by 003's rule? OLD's text is
    -- hashed — always, because OLD's column cannot be trusted: a raw content
    -- UPDATE leaves it stale, and the next edit through update_thought then
    -- moves it from the stale value to the right one while the text stands
    -- (fourth review pass: "moved between two values" had been read as a
    -- change of text, and an unchanged edit re-stamped). NEW's column is
    -- trusted when it moved to a value — update_thought writes fp(text)
    -- there, and a raw writer's wrong value reads as a change, the answer it
    -- would get anyway — else NEW's text is hashed too: the column that did
    -- not move says nothing, and a move from or to NULL says nothing (a row
    -- 023's batches have not reached takes its first fingerprint on any
    -- edit; 018 sets NULL when another row holds the key — third review
    -- pass). One hash on an edit through update_thought, two on a raw one
    -- (second review pass: two on every content edit was +57% on a bulk
    -- UPDATE; a re-embed or metadata touch hashes nothing).
    IF NOT v_same THEN
      v_same := content_fingerprint_of(OLD.content) IS NOT DISTINCT FROM
                CASE WHEN NEW.content_fingerprint IS NOT NULL
                      AND NEW.content_fingerprint IS DISTINCT FROM OLD.content_fingerprint
                     THEN NEW.content_fingerprint
                     ELSE content_fingerprint_of(NEW.content) END;
    END IF;
  END IF;
  IF v_same THEN
    -- The actor follows the content: the mark stays as it was, whatever the
    -- patch said. The common case — a re-embed, a metadata touch — carries the
    -- same two keys in and out and pays two comparisons, no rebuild. A raw
    -- `SET metadata = NULL` on a marked row keeps the mark too: the writer of
    -- the text did not change because a caller wiped the rest.
    IF NEW.metadata->'actor_kind' IS NOT DISTINCT FROM OLD.metadata->'actor_kind'
       AND NEW.metadata->'actor_name' IS NOT DISTINCT FROM OLD.metadata->'actor_name' THEN
      RETURN NEW;
    END IF;
    v_meta := COALESCE(NEW.metadata, '{}'::jsonb) - 'actor_kind' - 'actor_name';
    IF jsonb_typeof(OLD.metadata) = 'object' THEN
      IF OLD.metadata ? 'actor_kind' THEN
        v_meta := v_meta || jsonb_build_object('actor_kind', OLD.metadata->'actor_kind');
      END IF;
      IF OLD.metadata ? 'actor_name' THEN
        v_meta := v_meta || jsonb_build_object('actor_name', OLD.metadata->'actor_name');
      END IF;
    END IF;
    NEW.metadata := v_meta;
    RETURN NEW;
  END IF;

  -- An INSERT, or an UPDATE that changes the content: the writer is whoever
  -- set the envelope. The setting is read inline first — a raw load with no
  -- actor pays one current_setting and nothing more (008's reader is plpgsql
  -- with an EXCEPTION arm, a savepoint per call, which the audit trigger
  -- already pays once per row; first review pass) — and through 008's reader
  -- when set, so a malformed envelope is no actor rather than a failed
  -- write, as 008 decided. Then 010's id reading (the exact form the server
  -- emits; anything else is no id) and 046's lookup — only when the envelope
  -- names an id or a name, so no actor means no probe (046, third pass).
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

  v_meta := COALESCE(NEW.metadata, '{}'::jsonb) - 'actor_kind' - 'actor_name';
  IF v_kind IS NOT NULL THEN
    v_meta := v_meta || jsonb_build_object('actor_kind', v_kind);
  END IF;
  IF v_name IS NOT NULL THEN
    v_meta := v_meta || jsonb_build_object('actor_name', v_name);
  END IF;
  -- A NULL metadata with nothing to add stays NULL: on this path the stamp
  -- adds keys, it does not decide the column's emptiness for a raw writer.
  IF NEW.metadata IS NULL AND v_meta = '{}'::jsonb THEN
    RETURN NEW;
  END IF;
  NEW.metadata := v_meta;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION ob1_stamp_actor() IS
  'BEFORE INSERT OR UPDATE on thoughts (thoughts_stamp_actor, 049): writes metadata.actor_kind (ob1_agents.kind for the envelope''s agent_id, else its name — ob1_registry_kind, 046) and metadata.actor_name (the envelope''s name) from the ob1.actor setting 008''s writers set, never from the payload — a payload''s own values under either key are overwritten or removed. The actor follows the content: an INSERT and an UPDATE that changes the text (by 003''s normalised fingerprint, so 018''s unchanged edit is unchanged here too) stamp from the envelope present (no envelope, no mark); an UPDATE that leaves the text keeps the mark as it was. A non-object metadata (a raw writer''s) passes untouched. Under ob1.actor_amend = ''backfill'' the keys are taken as given (backfill_thought_actors). Migration 049 / SMD-1726.';

DROP TRIGGER IF EXISTS thoughts_stamp_actor ON thoughts;
CREATE TRIGGER thoughts_stamp_actor
  BEFORE INSERT OR UPDATE ON thoughts
  FOR EACH ROW
  EXECUTE FUNCTION ob1_stamp_actor();

COMMENT ON COLUMN thoughts.metadata IS
  'The thought''s metadata: the caller''s keys and the extractor''s (source, type, topics, people, action_items). Two keys are the DATABASE''s since 049 and a write cannot set them: actor_kind (operator | agent | ingested — who holds the key that wrote the current content, from ob1_agents.kind, 046) and actor_name (that key''s name); absent when the key is unclassified or the write came from outside the server. Reads filter on them through 014''s metadata route (`said_by`, `actor` on the search and list tools) and print them as `By: name (kind)`. Migration 049 / SMD-1726.';

-- ---------------------------------------------------------------------------
-- The backfill: the log says who wrote the content; the row is made to agree.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION backfill_thought_actors(p_limit integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SET lock_timeout = '10s'
AS $$
DECLARE
  v_prev_actor text := current_setting('ob1.actor', true);
  v_prev_amend text := current_setting('ob1.actor_amend', true);
  -- 023's shape: a temp table named per call and dropped at commit, so two
  -- calls in one transaction never meet each other's, and nothing is dropped
  -- by hand (CLAUDE.md's rail; the first draft dropped a fixed name, which
  -- resolved to a permanent table of that name when no temp one existed —
  -- first review pass, reproduced).
  v_tbl      text := format('ob1_actor_backfill_%s',
                            to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'));
  v_rows     integer := 0;
  v_differ   integer;
  v_awaiting integer;
BEGIN
  IF p_limit IS NOT NULL AND p_limit < 1 THEN
    RAISE EXCEPTION 'backfill_thought_actors: p_limit must be at least 1, or NULL for every row (got %)',
      p_limit;
  END IF;

  /**
   * Every thought's writer, from the log: the update row whose after-text is
   * the row's text, else the capture when no update ever changed the text —
   * the newest by created_at then seq among candidates — read through 008's
   * thought_id index; nobody when update rows exist but none wrote the text
   * that stands (a capture-only thought rewritten unaudited cannot be told
   * apart, and its capturer stands). Its kind is what the registry says
   * NOW for its id or name — the trigger's rule applied late, and a
   * reclassification carried to the rows — else the kind 046 stamped on the
   * row (a key since removed from the registry). A thought with no such row
   * (loaded with the audit trigger off, or its log pruned by a migration)
   * derives to nothing, and a mark it carries is stripped: nobody vouches
   * for it. A metadata that is not an object has no mark to read or write.
   *
   * `differs` is where the row and the log disagree — the rows this pass
   * writes; `awaiting` is where the log names a key nobody has classified —
   * the rows the next pass fills once set_agent_kind has. updated_at rides
   * along so the write below can tell a row edited meanwhile (018's guard).
   */
  EXECUTE format($scan$
    CREATE TEMP TABLE %I ON COMMIT DROP AS
    SELECT d.id, d.updated_at, d.kind, d.name,
           -- Differs when the value differs, or when the key is present with
           -- a value that reads as NULL (a JSON null a caller planted — `->>`
           -- says NULL for it as for an absent key; run-it, first review pass).
           (d.kind IS DISTINCT FROM d.present_kind OR (d.kind IS NULL AND d.has_kind)
            OR d.name IS DISTINCT FROM d.present_name OR (d.name IS NULL AND d.has_name)) AS differs,
           (d.kind IS NULL AND (d.w_name IS NOT NULL OR d.w_agent IS NOT NULL)) AS awaiting
    FROM (
      SELECT t.id, t.updated_at,
             -- (w is the LATERAL below; f.fp is the thought's own text hashed
             -- once per thought — the OFFSET 0 fences the subquery, or the
             -- planner pulls the hash up into w's sort key and runs it once
             -- per update row (third review pass, counted: 5 edits, 5 hashes
             -- of the same text) — NOT the content_fingerprint column: a raw
             -- content UPDATE leaves that column stale, and the stale hash
             -- anchored the previous writer's edit — second review pass.)
             -- A writer stands only for text the log vouches for: an update
             -- row whose after-text is the row's, or the capture when no
             -- update ever changed the text (a capture row carries no text to
             -- check). Update rows present and none matching means the text
             -- that stands was written unaudited — nobody's, as a no-row
             -- thought is (third review pass).
             CASE WHEN w.vouched
                  THEN COALESCE(ob1_registry_kind(w.canonical_agent_id, w.name), w.actor_kind) END AS kind,
             CASE WHEN w.vouched THEN w.name END               AS name,
             CASE WHEN w.vouched THEN w.name END               AS w_name,
             CASE WHEN w.vouched THEN w.canonical_agent_id END AS w_agent,
             t.metadata->>'actor_kind' AS present_kind,
             t.metadata->>'actor_name' AS present_name,
             COALESCE(t.metadata ? 'actor_kind', false) AS has_kind,
             COALESCE(t.metadata ? 'actor_name', false) AS has_name
      FROM thoughts t
      CROSS JOIN LATERAL (
        -- Read only against update rows, so hashed only when one carries text
        -- (fourth review pass: a quarter of the hashes went to capture-only
        -- thoughts and were never compared). OFFSET 0 as above.
        SELECT CASE WHEN EXISTS (SELECT 1 FROM thought_audit u
                                  WHERE u.thought_id = t.id AND u.action = 'update' AND u.diff ? 'content')
                    THEN content_fingerprint_of(t.content) END AS fp
        OFFSET 0) f
      LEFT JOIN LATERAL (
        -- The name as the trigger reads it — trimmed, empty is none — so the
        -- two derive one value and a pass after a pass writes nothing
        -- (run-it, first review pass: a padded name flip-flopped every pass).
        SELECT a.actor_kind, NULLIF(btrim(a.actor_name), '') AS name, a.canonical_agent_id,
               -- Decided from the SET, not from which row sorts first: a
               -- capture stands only when no update ever changed the text
               -- (fourth review pass, planted: a pre-049 seq inverted under a
               -- created_at tie put the capture on top of an unmatched update,
               -- and it was vouched by its place in the order).
               ((a.action = 'update' AND a.fa IS NOT DISTINCT FROM f.fp)
                OR (a.action = 'capture' AND NOT bool_or(a.action = 'update') OVER ())) AS vouched
        FROM (
          -- Each candidate row's two texts hashed ONCE, behind an OFFSET 0:
          -- read inline, the planner hashed them in every place the value is
          -- used — four sha256 of a 100 KB text per update row, the whole cost
          -- of a pass on a brain of long thoughts (third review pass, measured:
          -- 17.6 s at 100,000 thoughts with a tenth at 100 KB, of which the
          -- hashing of the update rows' texts was 15.9).
          SELECT a.actor_kind, a.actor_name, a.canonical_agent_id, a.action, a.created_at, a.seq,
                 content_fingerprint_of(a.diff->'content'->>'before') AS fb,
                 content_fingerprint_of(a.diff->'content'->>'after')  AS fa
          FROM thought_audit a
          WHERE a.thought_id = t.id
            AND (a.action = 'capture' OR (a.action = 'update' AND a.diff ? 'content'))
          OFFSET 0
        ) a
        -- A content-writing row by the trigger's rule: a capture, or an update
        -- whose text CHANGED by 003's normalised fingerprint — 018's unchanged
        -- edit (case, whitespace) is in the diff and is not a change of writer,
        -- on the row or here (first review pass: the two disagreed, and a pass
        -- rewrote the trigger's stamp).
        WHERE a.action = 'capture' OR a.fb IS DISTINCT FROM a.fa
        -- The row whose text stands first; then the newest transaction; then
        -- the order inside it. Not seq alone (second review pass — see the
        -- header): a pre-049 seq is heap order, and heap order lies after
        -- 046's amendments and a VACUUM.
        ORDER BY (a.action = 'update' AND a.fa IS NOT DISTINCT FROM f.fp) DESC,
                 a.created_at DESC, a.seq DESC
        LIMIT 1
      ) w ON true
      WHERE t.metadata IS NULL OR jsonb_typeof(t.metadata) = 'object'
    ) d
  $scan$, v_tbl);

  EXECUTE format('SELECT count(*) FILTER (WHERE differs), count(*) FILTER (WHERE awaiting) FROM %I', v_tbl)
    INTO v_differ, v_awaiting;

  IF v_differ > 0 THEN
    -- The stamp trigger takes the keys as given under this setting; the audit
    -- row each write leaves names the door and nobody. Both restored below —
    -- a hand call must not leave the transaction's actor changed.
    PERFORM set_config('ob1.actor_amend', 'backfill', true);
    PERFORM set_config('ob1.actor', '{"via": "backfill_thought_actors"}', true);
    -- EXCLUSIVE, as 023 takes it, BEFORE the ALTER: the ALTER's own SHARE ROW
    -- EXCLUSIVE does not conflict with the ROW SHARE update_thought holds on
    -- its row between its lock and its UPDATE, so a pass that met an edit in
    -- flight waited on the row while the edit waited on the table — a
    -- deadlock, the pass the victim (run-it, first review pass, reproduced).
    -- EXCLUSIVE conflicts with ROW SHARE, so the pass waits its turn instead;
    -- readers (ACCESS SHARE) proceed. Held to commit, which is why each call
    -- is its own transaction; lock_timeout 10 s aborts it cleanly.
    LOCK TABLE thoughts IN EXCLUSIVE MODE;
    -- A stamp is not an edit: 001's trigger would bump updated_at on every
    -- row written, and 018's stale-read guard and 021's evidence rule both
    -- read it. Held off for the write, to commit, as 023 holds it.
    ALTER TABLE thoughts DISABLE TRIGGER thoughts_updated_at;

    EXECUTE format($write$
    UPDATE thoughts t
       SET metadata = (COALESCE(t.metadata, '{}'::jsonb) - 'actor_kind' - 'actor_name')
                      || CASE WHEN d.kind IS NOT NULL THEN jsonb_build_object('actor_kind', d.kind) ELSE '{}'::jsonb END
                      || CASE WHEN d.name IS NOT NULL THEN jsonb_build_object('actor_name', d.name) ELSE '{}'::jsonb END
      FROM (SELECT id, updated_at, kind, name FROM %I WHERE differs LIMIT %s) d
     WHERE t.id = d.id
       -- Re-checked on the locked row: a thought edited since the scan has a
       -- newer writer, stamped by the trigger; it is left for the next pass.
       AND t.updated_at IS NOT DISTINCT FROM d.updated_at
       -- …and one another pass marked meanwhile — updated_at held still, so
       -- the marks themselves are compared — is not written or counted again
       -- (run-it, first review pass: two passes each reported every row).
       AND (t.metadata->>'actor_kind' IS DISTINCT FROM d.kind OR (d.kind IS NULL AND t.metadata ? 'actor_kind')
            OR t.metadata->>'actor_name' IS DISTINCT FROM d.name OR (d.name IS NULL AND t.metadata ? 'actor_name'))
    $write$, v_tbl, COALESCE(p_limit::text, 'ALL'));
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    ALTER TABLE thoughts ENABLE TRIGGER thoughts_updated_at;
    PERFORM set_config('ob1.actor', COALESCE(v_prev_actor, ''), true);
    PERFORM set_config('ob1.actor_amend', COALESCE(v_prev_amend, ''), true);
  END IF;

  RETURN jsonb_build_object('ok', true, 'rows', v_rows, 'differing', v_differ, 'awaiting', v_awaiting);
END;
$$;

COMMENT ON FUNCTION backfill_thought_actors(integer) IS
  'Sets metadata.actor_kind and metadata.actor_name on every thought to what thought_audit derives for the writer of its current content — the update row whose after-text is the row''s text, else the capture when no update ever changed the text (update rows present and none matching: nobody), the newest by created_at then seq among matches: ob1_registry_kind for its id or name NOW (so a reclassified key reaches its rows) else the actor_kind 046 stamped, and its actor_name — wherever the row and the log disagree, stripping a mark no audit row vouches for. Returns {ok, rows (written this call), differing (found disagreeing), awaiting (writer named but unclassified — set_agent_kind, then this)}. p_limit (at least 1) bounds the rows written and the write lock per call, not the scan (every call derives every thought) nor the audit rows (one per row written); each call its own transaction. Holds the updated_at trigger for the write (a stamp is not an edit), which needs the table''s owner; each row written leaves an audit row whose origin is backfill_thought_actors. Idempotent: a second pass finds nothing. Migration 049 / SMD-1726.';

-- Every thought already written takes its writer's mark now — or the batch
-- OB1_BACKFILL_LIMIT names, the rest by hand.
SELECT backfill_thought_actors({{BACKFILL_LIMIT}});
