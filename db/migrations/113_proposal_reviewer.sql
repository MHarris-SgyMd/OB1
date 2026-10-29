-- =============================================================================
-- Migration 113: who decided a proposal — the reviewer on the row, stamped
--                from the key that made the decision, accept and reject alike
--                (SMD-2608)
-- =============================================================================
--
-- WHY
--   An accept is audited under the reviewer's key: its thought_audit update
--   row (the supersedes write, 032) names the actor. A reject writes no audit
--   row unless it clears a pointer of its own, and supersession_proposals
--   holds the judge's canonical_agent_id and the decision with its note, but
--   no reviewer. So once a proposal is rejected, nothing records who rejected
--   it, whatever key ran the command (SMD-2424's review pass 3). Since
--   SMD-2424 a machine's key (the workers') decides beside a person's — the
--   pass settles a stale row it no longer finds in conflict (067) — and
--   since SMD-3338's decision any write-scope key may decide, an agent's
--   among them. Telling a person's decision from a machine's needs the key.
--
-- WHAT
--   1. Three columns on supersession_proposals, the audit row's three
--      (actor_name, canonical_agent_id, actor_kind): reviewed_by text, the
--      name the decision's actor envelope carried, as the audit row records
--      it; reviewed_by_agent_id uuid, its agent when the envelope named one
--      in the form the server emits (010's reading); reviewed_by_kind text,
--      the registry's kind when the decision was made (046's
--      ob1_registry_kind: the agent's, else its name's) — read only when an
--      agent is named, so a name alone, which anyone can put in an envelope,
--      never lends the decision a kind. A decision with no key —
--      db/consolidate.ts run without OB1_WORKER_KEY, or with one that did not
--      resolve — carries the name 'consolidate' and no agent, as its audit row
--      does, and no kind even when a key of that name is classified; a raw
--      call with no envelope carries none of the three. The kind is the
--      decision's: a key classified after it decided reads unclassified
--      here, and a reader asks the registry for the kind now
--      (db/consolidate.ts --list does). They describe the decision that
--      stands, as reviewed_at and review_note do: a later decision on the row
--      replaces them, and a row back to pending or stale (063's replace,
--      067's reopen) clears them.
--
--   2. ONE WRITER: a BEFORE INSERT OR UPDATE trigger,
--      supersession_proposals_stamp_reviewer (ob1_stamp_proposal_reviewer),
--      on any write that names status, reviewed_at, review_note or one of
--      the three columns. reviewed_at NULL (the row unreviewed: 063's CHECK)
--      clears them; otherwise they are stamped from the envelope present
--      (ob1.actor, which review_supersession_proposal sets from its p_actor
--      as the audit trigger reads it), never from the statement's values —
--      050's rule for the actor on a thought. 063's replace names status and
--      review_note on a row already unreviewed, so it clears what is already
--      clear. A write that names none of those columns (a similarity or
--      fingerprint fix, 091's settles trigger, which writes NEW in place)
--      leaves them as they were.
--
--      Why a trigger and not review_supersession_proposal's own UPDATE: the
--      review is one of two writers of reviewed_at — 067's reopen in
--      rebuild_derived sets it back to NULL — and both bodies are long and
--      frozen in their files; redefining either to write three columns would
--      copy it whole for one line. The trigger takes the review's decisions
--      (and 067's settle, which calls it) and the reopen alike, and a raw
--      UPDATE too, with nothing redefined.
--
--      Why columns and not a thought_audit event for a reject: thought_audit
--      is the log of the thoughts (thought_id on every row; since 060 the
--      row is its projection, docs/event-log-as-truth.md), and a reject that
--      clears nothing changes no thought — an event for it would project
--      nothing and name a thought it did not touch. The decision is the
--      proposal's, so it is recorded on the proposal, beside reviewed_at and
--      review_note. An accept's and a clearing reject's audit rows still
--      name the same actor.
--
--   3. Two CHECKs: reviewed_by_kind is one of the registry's kinds (046's),
--      and an unreviewed row carries no reviewer — the trigger keeps both,
--      the CHECKs hold a write made with it dropped.
--
--   4. THE BACKFILL, from the audit: a row decided before this file whose
--      decision wrote a pointer has that write's audit row, in the
--      decision's own transaction — created_at is now(), so equal to the
--      row's reviewed_at — on the thought the pointer is on. An accepted
--      row with pointer_written: the update setting supersedes on its
--      superseding_id to the other side. A rejected row: the update on
--      either side clearing supersedes from the other. Each takes that
--      row's actor_name, canonical_agent_id and actor_kind, the newest such
--      row (seq) when a transaction holds two — so a hand-run transaction
--      that decided one row twice, a clearing reject then a reject clearing
--      nothing by another key, is credited to the first; no path in the tree
--      decides twice in one transaction. Every other decided row — an
--      accept that found the pointer already set, a reject that cleared
--      nothing, the pass's settles — has no record of its reviewer, and
--      stays NULL: nothing is guessed. Run before the trigger exists (it is
--      dropped first on a re-apply), so the trigger does not restamp the
--      backfill from the migration's empty envelope; a row already holding a
--      reviewer is not touched.
--
--   ob1:proposal-reviewer-from-the-envelope — a CONTRACT SENTINEL, not prose
--   (the 014 convention).
--
-- SAFETY
--   Three nullable columns (no rewrite), one UPDATE of the decided rows the
--   audit names (hundreds of proposals on the dogfood brains; the audit is
--   read by thought_id), two CHECKs (each validated by a scan of the table),
--   one function, one trigger. The listing (110) is not redefined: a
--   RETURNS TABLE cannot gain a column under CREATE OR REPLACE, and 110
--   re-applied after a wider form of its own argument list would fail
--   (cannot change return type), so a wider listing is another argument
--   list and another round of every reader's and preflight's probes.
--   db/consolidate.ts --list reads the reviewer by the page's ids, as it
--   reads the writers (094). A decision under a key now reads ob1_agents for
--   the kind, as the audit trigger does: the capture group's SELECT on it
--   (046), which every role db/README.md describes deciding holds — a
--   consolidation role holds capture, server and worker, the REST core
--   capture — so no grant moves. A role granted the worker group alone,
--   which could reject a proposal that clears nothing before this file (and
--   nothing else of the review: it cannot read thoughts), is refused that
--   reject under a key ("permission denied for table ob1_agents"); a
--   decision with no key, a reopen and a new pending row read nothing.
--   A data-only reload (pg_restore --data-only, a COPY) with this trigger
--   enabled stamps every row it inserts from the loader's envelope, none,
--   and so empties every reviewer; a full pg_restore creates the trigger
--   after the data, as for 091's column. An older server or CLI writes
--   through the same functions and gets the reviewer stamped. MINOR under
--   FORK.md's version rules: columns and a trigger added, nothing a caller
--   passes or reads changed.
--   test-schema [101], test-upgrade [20be], test-live [16] (--reject and
--   --list under a key).
--
-- Prerequisites
--   008 (ob1_current_actor), 029 (supersession_proposals), 046
--   (ob1_registry_kind; thought_audit.actor_kind), 050 (thought_audit.seq).
--   Applied by `bun db/migrate.ts`. Re-applied: the columns and CHECKs are
--   kept, the backfill fills only rows with no reviewer, and the trigger and
--   its function are replaced as they were.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape).
DO $qc$
BEGIN
  IF to_regprocedure('ob1_current_actor()') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 113 needs 008 (ob1_current_actor); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regclass('supersession_proposals') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 113 needs 029 (supersession_proposals); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('ob1_registry_kind(uuid, text)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 113 needs 046 (ob1_registry_kind); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'thought_audit' AND column_name = 'seq') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 113 needs 050 (thought_audit.seq); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

ALTER TABLE supersession_proposals
  ADD COLUMN IF NOT EXISTS reviewed_by          text,
  ADD COLUMN IF NOT EXISTS reviewed_by_agent_id uuid,
  ADD COLUMN IF NOT EXISTS reviewed_by_kind     text;

COMMENT ON COLUMN supersession_proposals.reviewed_by IS
  'Who decided the row: the name the decision''s actor envelope (ob1.actor) carried, as thought_audit.actor_name records it — the key''s name, or ''consolidate'' for db/consolidate.ts run with no key. NULL while unreviewed, for a decision made with no envelope, and for one made before migration 113 whose audit row does not name it. Written only by supersession_proposals_stamp_reviewer. Migration 113 / SMD-2608.';
COMMENT ON COLUMN supersession_proposals.reviewed_by_agent_id IS
  'The decision''s agent (ob1_agents.canonical_agent_id) when its envelope named one in the form the server emits; NULL for a decision with no key. Written only by supersession_proposals_stamp_reviewer. Migration 113 / SMD-2608.';
COMMENT ON COLUMN supersession_proposals.reviewed_by_kind IS
  'The registry''s kind for the decision''s agent when it decided (ob1_registry_kind: the agent''s, else its name''s), read only when the envelope named an agent: operator, agent or ingested — so a person''s decision can be told from a machine''s. NULL for a decision with no agent, and for a key not classified when it decided (the registry holds its kind now). Written only by supersession_proposals_stamp_reviewer. Migration 113 / SMD-2608.';

-- The trigger goes first on a re-apply, so neither the backfill nor the
-- CHECKs below are restamped from this transaction's empty envelope.
DROP TRIGGER IF EXISTS supersession_proposals_stamp_reviewer ON supersession_proposals;

-- The backfill: the reviewer of a decision that wrote a pointer, from that
-- write's audit row in the decision's own transaction (created_at = now() =
-- the row's reviewed_at), on the thought the pointer is on.
UPDATE supersession_proposals p
   SET reviewed_by = a.actor_name, reviewed_by_agent_id = a.canonical_agent_id, reviewed_by_kind = a.actor_kind
  FROM (
    SELECT DISTINCT ON (q.id) q.id, t.actor_name, t.canonical_agent_id, t.actor_kind
      FROM supersession_proposals q
      JOIN thought_audit t
        ON t.thought_id IN (q.older_id, q.newer_id)
       AND t.created_at = q.reviewed_at
       AND t.action = 'update'
       AND t.diff ? 'supersedes'
     WHERE q.reviewed_at IS NOT NULL
       AND q.reviewed_by IS NULL AND q.reviewed_by_agent_id IS NULL AND q.reviewed_by_kind IS NULL
       AND (
         -- An accept that wrote its pointer: on the superseding side, onto the other.
         (q.status = 'accepted' AND q.pointer_written AND t.thought_id = q.superseding_id
          AND t.diff->'supersedes'->>'after' = (CASE WHEN q.superseding_id = q.newer_id THEN q.older_id ELSE q.newer_id END)::text)
         -- A reject that cleared one: on either side, cleared from the other.
         OR (q.status = 'rejected' AND t.diff->'supersedes'->>'after' IS NULL
             AND t.diff->'supersedes'->>'before' = (CASE WHEN t.thought_id = q.newer_id THEN q.older_id ELSE q.newer_id END)::text))
     ORDER BY q.id, t.seq DESC
  ) a
 WHERE p.id = a.id;

ALTER TABLE supersession_proposals DROP CONSTRAINT IF EXISTS supersession_proposals_reviewed_by_kind;
ALTER TABLE supersession_proposals ADD CONSTRAINT supersession_proposals_reviewed_by_kind
  CHECK (reviewed_by_kind IS NULL OR reviewed_by_kind IN ('operator', 'agent', 'ingested'));
ALTER TABLE supersession_proposals DROP CONSTRAINT IF EXISTS supersession_proposals_reviewer_decided;
ALTER TABLE supersession_proposals ADD CONSTRAINT supersession_proposals_reviewer_decided
  CHECK (reviewed_at IS NOT NULL OR (reviewed_by IS NULL AND reviewed_by_agent_id IS NULL AND reviewed_by_kind IS NULL));

CREATE OR REPLACE FUNCTION ob1_stamp_proposal_reviewer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor   jsonb;
  v_raw   text;
  v_name  text;
  v_agent uuid;
  v_kind  text;
BEGIN
  -- ob1:proposal-reviewer-from-the-envelope — unreviewed, no reviewer;
  -- decided, the envelope present and nothing the statement wrote.
  IF NEW.reviewed_at IS NULL THEN
    NEW.reviewed_by := NULL;
    NEW.reviewed_by_agent_id := NULL;
    NEW.reviewed_by_kind := NULL;
    RETURN NEW;
  END IF;
  -- 050's reading: the setting inline first, 008's reader when set (a
  -- malformed envelope is no actor), 010's id form, 046's one lookup — and
  -- no probe when the envelope names neither.
  v_raw := current_setting('ob1.actor', true);
  IF v_raw IS NOT NULL AND v_raw <> '' THEN
    actor := ob1_current_actor();
  END IF;
  IF actor IS NOT NULL AND jsonb_typeof(actor) = 'object' THEN
    -- The name as the audit row records it (actor->>'name', verbatim).
    v_name  := actor->>'name';
    v_agent := CASE
      WHEN actor->>'agent_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (actor->>'agent_id')::uuid
    END;
    -- The kind only for a named agent: a name alone is anyone's to write.
    IF v_agent IS NOT NULL THEN
      v_kind := ob1_registry_kind(v_agent, v_name);
    END IF;
  END IF;
  NEW.reviewed_by := v_name;
  NEW.reviewed_by_agent_id := v_agent;
  NEW.reviewed_by_kind := v_kind;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION ob1_stamp_proposal_reviewer() IS
  'BEFORE INSERT OR UPDATE OF status, reviewed_at, review_note, reviewed_by, reviewed_by_agent_id, reviewed_by_kind on supersession_proposals (supersession_proposals_stamp_reviewer, 113): the one writer of the reviewer columns. reviewed_at NULL clears them; otherwise they are the envelope present (ob1.actor: its name, its agent in the server''s id form, and for an agent the registry''s kind), never the statement''s values. review_supersession_proposal sets the envelope from p_actor, so its accept and reject, and 067''s settle through it, are stamped with the key that decided; 067''s reopen clears them. Migration 113 / SMD-2608.';

CREATE TRIGGER supersession_proposals_stamp_reviewer
  BEFORE INSERT OR UPDATE OF status, reviewed_at, review_note, reviewed_by, reviewed_by_agent_id, reviewed_by_kind
  ON supersession_proposals
  FOR EACH ROW EXECUTE FUNCTION ob1_stamp_proposal_reviewer();
