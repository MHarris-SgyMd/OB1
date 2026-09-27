-- =============================================================================
-- Migration 063: the page store — a page is a thought whose text is the render
--                of its sections; every section has an owner; one write guard
--                parks a machine's draft on a human's section instead of
--                overwriting it; revisions are append-only and reconstruct any
--                prior state; a generated section records its lineage
--                (SMD-1812; the store half of SMD-949)
-- =============================================================================
--
-- WHY
--   The fork has no document: a durable, named artifact a human and a machine
--   both edit. A synthesised runbook or an entity page is either kept outside
--   the brain, losing the link to its evidence, or captured back as one opaque
--   thought that the next run of its generator replaces whole — and with it
--   whatever a human edited. Upstream's schemas/wiki-pages had the right idea
--   (per-section ownership, one write guard, append-only revisions) and three
--   things this fork cannot carry: a parallel store with no link to the thought
--   row (an id array the application "cleans up"), Supabase's roles and a
--   PostgREST cache, and no lineage (docs/event-log-as-truth.md makes every
--   derived artifact a projection with a recorded key; SMD-1729's rule is that
--   an artifact and its lineage row commit together).
--
-- THE DECISION (SMD-1812's "decide first", on the ticket)
--   A page is its own table AND a thought. `pages.id` IS the page thought's id:
--   the thought's content is the RENDER of the page — its title and its live
--   sections in order — written only through upsert_thought and update_thought,
--   so every render is an event in thought_audit (the page's own history, title
--   included), stamped with the key that wrote it (050), searchable once
--   re-embedded (021: an edit with content and no vector clears the vector;
--   db/reembed.ts's pool is `embedding IS NULL OR label <> target`), extracted
--   as any thought is (016's trigger). Its derived_from is the union of the
--   live sections' evidence, so 025's trace_provenance and find_derivatives
--   read a page with no change to either; supersedes passes through, and the
--   superseded page is archived. Not SMD-1715's deliverable (one blob with a
--   status machine — orthogonal, and compatible: a page has a thought id, so a
--   deliverable facet can sit on it later); not one thought per section (003's
--   fingerprint dedup collapses two sections with one text into one row, and
--   every unaccepted draft would reach search, the extractor and the judge —
--   the belief the guard exists to withhold).
--
-- WHAT
--   1. THE TABLES. `pages` (id = the thought's id, FK ON DELETE CASCADE; slug
--      UNIQUE; title; page_kind; status active|archived; metadata), `page_sections`
--      (page_id; section_key UNIQUE per page; heading; display_order; origin
--      manual|generated — the OWNER the guard reads; locked forces human-owned;
--      body_md; the machine's evidence and recipe; the PENDING buffer: a parked
--      draft's body, time, recipe and evidence), `page_section_revisions` (an
--      identity seq; body, heading and order — everything the render reads —
--      origin, actor, created_at): append-only by trigger (UPDATE, DELETE and
--      TRUNCATE refused, the owner's too; a revision goes only when its
--      section is gone — the section's cascade — which the trigger tells by
--      the section row, not by the trigger depth).
--   2. THE GUARD. write_page_section is the one door for a section's text
--      (022's argument for upsert_thought owning the chunk rule). A generated
--      write onto a section a human owns (origin manual, or locked) PARKS: the
--      live body is not touched, the draft waits in the pending buffer with its
--      own evidence and recipe. accept_page_section promotes it — a deliberate
--      human act — and the section stays human-owned: the machine proposes
--      next time too. A manual write takes ownership; release_page_section
--      hands a section back to the machine (upstream's release was a raw
--      UPDATE nothing recorded); lock_page_section sets the lock and
--      delete_page_section removes a section, the render following — the
--      doors upstream lacked. A revision is written on every change to what
--      the render reads, and on an ownership or lock move.
--   3. THE RENDER. render_page(page, at) is the text the thought holds:
--      `# title`, then each section by (display_order, section_key) — `##
--      heading` when it has one, then its body — joined by blank lines; with
--      `at`, the same over page_sections_as_of(page, at), the latest revision
--      of each section at or before that time: any prior state of the page,
--      byte for byte. After every live change ob1_render_page_thought writes
--      the render and the evidence union through update_thought; nothing
--      moved, nothing written (the audit's no-op rule holds by construction).
--   4. THE LINEAGE. A generated section is a derived artifact: write_page_section
--      and accept_page_section record a `derivations` row (artifact_kind
--      `section`, the sixth kind — the CHECK and ob1_record_derivation's list
--      widened, the body carried verbatim otherwise), input_ids the evidence,
--      input_fingerprints the evidence's text as read (003's column, the text
--      hashed again where it is NULL), produced_by `write_page_section`, the
--      recipe the caller's generation_source with `deterministic` false unless
--      it declares a boolean (a non-boolean is refused; none at all is marked
--      `declared: false`, 061's convention) — the same recipe is what the
--      section's generation_source holds, so "this body is a machine's" is one
--      predicate: generation_source is not empty. A generated write without
--      evidence is refused: a derivation names its inputs or it is not one; a
--      page is never its own evidence. A parked draft parks the fingerprints
--      its evidence had when it was generated, and accept records those. A
--      manual write that moves the body drops the row and empties the recipe —
--      the text is no longer the recipe's output (a heading or order move alone
--      leaves the machine's text, its recipe and its row). An AFTER DELETE
--      trigger on page_sections drops a deleted section's rows (061's shape).
--      Preflight's `lineage` check counts sections carrying a recipe without a
--      row — a regeneration of such a section records the row even when nothing
--      else moved (walkthrough, second review pass: the remedy said so and the
--      identical-regeneration rule made it false) — and, when no row is
--      missing, warns on a page whose thought does not hold its render.
--   5. THE ACTOR. Every writer takes p_actor (a name the revision and the
--      updated_by columns record); absent, the name the session's ob1.actor
--      envelope carries (008), else 'system'. The thought's own actor is the
--      envelope's, never p_actor: 050's rule, the key and not the payload.
--
-- SAFETY
--   Additive: thoughts is untouched (no column, no index, no trigger); three
--   tables, thirteen functions and two trigger functions added; one CHECK on
--   061's derivations widened by one value (found by what it constrains, not
--   by its name — a renamed CHECK would otherwise stand beside the new one and
--   refuse every section; added NOT VALID then validated, so a large table is
--   scanned once without an exclusive lock held through the scan) and
--   ob1_record_derivation redefined on 061's body plus that value. LOCK ORDER:
--   a writer given p_supersedes takes 029's supersession advisory lock FIRST
--   (033's rule for every writer of the pointer; delete_thought takes it before
--   its row lock, and update_thought would take it inside the render — after
--   the rows — where two pages superseding each other deadlocked 39 of 40 races
--   and a supersede racing the target's delete 7 of 40: run-it, second review
--   pass); then every writer locks the page THOUGHT (FOR NO KEY UPDATE — the
--   row update_thought locks, and the order delete_thought's cascade takes: the
--   thought, then the page), then the page row, then the section; a writer
--   racing delete_thought of the page therefore waits and then finds no page —
--   or, for upsert_page, finds no slug and creates the page anew, an upsert —
--   where the page-first order deadlocked 38 of 40 races (run-it, first review
--   pass). The one inversion left is against 033's fingerprint lock, which
--   update_thought takes after this row lock: a client editing the page
--   thought directly to the very text the render is moving to holds the
--   fingerprint lock while waiting on the row (run-it, second review pass:
--   25 of 30 such races) — a raw edit of a page thought, which nothing in the
--   store does, and whose loser is one refused statement. No arity moves, no return shape moves. No seed
--   row: core ships no fixture. Idempotent under --reapply. MINOR under FORK.md's
--   version rules. A role provisioned by --grant before this file lacks every
--   privilege on the three tables: run `migrate.ts --grant` for it again
--   (db/config.mjs's `pages` group); the store's functions run as the caller
--   and write thoughts and derivations too, so the capture group is needed
--   beside it. Names differ from upstream's (`pages`, not `wiki_pages`): a
--   brain that applied schemas/wiki-pages by hand keeps its tables untouched,
--   and nothing here CREATE OR REPLACEs one of its bodies.
--
-- Prerequisites
--   025 (thoughts.derived_from, find_derivatives), 032 (validate_derived_from,
--   update_thought's provenance envelope), 060 (the projector the write
--   functions call), 061 (derivations, ob1_record_derivation, ob1_actor_agent_id).
--   Applied by `bun db/migrate.ts`.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not hold
-- (052's shape): the bodies below are plpgsql and would fail at their first
-- call with a bare "does not exist" otherwise.
DO $qc$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'thoughts' AND column_name = 'derived_from') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 063 needs 025 (thoughts.derived_from); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('validate_derived_from(jsonb)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 063 needs 032 (validate_derived_from, update_thought''s provenance envelope); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('ob1_project_thought_event(uuid, vector, text, boolean)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 063 needs 060 (ob1_project_thought_event, the write functions that append then project); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regclass('derivations') IS NULL
     OR to_regprocedure('ob1_record_derivation(text, uuid, uuid[], text[], text, jsonb, uuid)') IS NULL
     OR to_regprocedure('ob1_actor_agent_id()') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 063 needs 061 (derivations, ob1_record_derivation, ob1_actor_agent_id); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- 1. The tables.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pages (
  -- The page thought's id: a page IS a thought (the header). The cascade is
  -- the thought's delete taking its page, sections and revisions with it —
  -- delete_thought (009) is the door; the thought's audit delete row holds the
  -- last render.
  id          uuid        PRIMARY KEY REFERENCES thoughts(id) ON DELETE CASCADE,
  slug        text        NOT NULL UNIQUE CHECK (slug <> ''),
  title       text        NOT NULL CHECK (title <> ''),
  page_kind   text        NOT NULL DEFAULT 'topic' CHECK (page_kind IN ('topic', 'entity', 'autobiography', 'custom')),
  status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text        NOT NULL DEFAULT 'system',
  updated_by  text        NOT NULL DEFAULT 'system'
);
CREATE INDEX IF NOT EXISTS idx_pages_kind_status ON pages (page_kind, status);

CREATE TABLE IF NOT EXISTS page_sections (
  id                           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id                      uuid        NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  section_key                  text        NOT NULL CHECK (section_key <> ''),
  heading                      text,
  display_order                integer     NOT NULL DEFAULT 100,
  -- The OWNER: generated is the machine's (a generated write refreshes it in
  -- place); manual is a human's (a generated write parks). locked forces the
  -- human-owned behaviour whatever the origin says.
  origin                       text        NOT NULL DEFAULT 'generated' CHECK (origin IN ('manual', 'generated')),
  locked                       boolean     NOT NULL DEFAULT false,
  body_md                      text        NOT NULL DEFAULT '',
  -- The machine's record of the live body: its recipe (as the lineage row
  -- carries it — deterministic, declared, the caller's keys) and the thoughts
  -- it read. EMPTY when the body is a human's: a manual write that moves the
  -- body empties it, so "a machine wrote this text" is one predicate
  -- (generation_source <> '{}'), whatever the owner. The lineage row in
  -- `derivations` is the record the rebuild reads; these two are the
  -- section's own copy, for a reader of the page. A human's citations stay
  -- in evidence_thought_ids across their edits.
  generation_source            jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(generation_source) = 'object'),
  evidence_thought_ids         uuid[]      NOT NULL DEFAULT ARRAY[]::uuid[],
  -- The pending buffer: a machine's draft parked on a human-owned section,
  -- with the evidence, the fingerprints that evidence had when the draft was
  -- generated, and the recipe IT was made from (upstream parked the body
  -- alone and left the live evidence naming an older generation). A heading
  -- or order the parked write proposed is not parked: the body is the draft.
  pending_body_md              text,
  pending_at                   timestamptz,
  pending_generation_source    jsonb       CHECK (pending_generation_source IS NULL OR jsonb_typeof(pending_generation_source) = 'object'),
  pending_evidence_thought_ids uuid[],
  pending_evidence_fingerprints text[],
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  created_by                   text        NOT NULL DEFAULT 'system',
  updated_by                   text        NOT NULL DEFAULT 'system',
  UNIQUE (page_id, section_key)
);
CREATE INDEX IF NOT EXISTS idx_page_sections_order ON page_sections (page_id, display_order, section_key);

CREATE TABLE IF NOT EXISTS page_section_revisions (
  -- An internal order, never a thought id (050's thought_audit.seq shape).
  seq           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  section_id    uuid        NOT NULL REFERENCES page_sections(id) ON DELETE CASCADE,
  -- Everything the render reads, so a state reconstructs byte for byte.
  body_md       text        NOT NULL,
  heading       text,
  display_order integer     NOT NULL,
  origin        text        NOT NULL CHECK (origin IN ('manual', 'generated')),
  actor         text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_page_section_revisions_section ON page_section_revisions (section_id, created_at DESC, seq DESC);

COMMENT ON TABLE pages IS
  'The page store (migration 063 / SMD-1812): one row per page, keyed by the PAGE THOUGHT''S id — a page is a thought whose content is render_page()''s text, written through update_thought on every live change (its history is thought_audit''s), with derived_from the sorted union of its sections'' evidence and supersedes passed through. slug is the stable handle; status archived marks a page another superseded. Written by upsert_page; updated_at and updated_by move with delete_page_section too.';
COMMENT ON TABLE page_sections IS
  'The sections of a page, each with an OWNER: origin generated is the machine''s (a generated write refreshes it in place), origin manual or locked is a human''s (a generated write parks in the pending buffer — pending_body_md and the evidence and recipe it was made from — until accept_page_section promotes it). evidence_thought_ids and generation_source are the machine''s own record of the live body; the lineage row is in derivations (artifact_kind section). Written by write_page_section, accept_page_section, release_page_section, lock_page_section and delete_page_section only. Migration 063 / SMD-1812.';
COMMENT ON COLUMN page_sections.origin IS
  'Who owns the section: manual (a human — a generated write parks) or generated (the machine — a generated write refreshes). A manual write takes ownership; release_page_section gives it back. Migration 063 / SMD-1812.';
COMMENT ON COLUMN page_sections.pending_body_md IS
  'A machine draft parked because the section is human-owned (origin manual or locked), with pending_at, pending_generation_source, pending_evidence_thought_ids and pending_evidence_fingerprints (the evidence''s text as the draft was generated from it) beside it. Promoted by accept_page_section; cleared by any in-place write. Migration 063 / SMD-1812.';
COMMENT ON COLUMN page_sections.generation_source IS
  'The recipe of the live body when a machine wrote it — the lineage row''s recipe (deterministic, declared, the generator''s own keys) — and {} when the body is a human''s: a manual write that moves the body empties it. The one predicate for "this text is a machine''s", whatever the owner; preflight''s lineage check reads it. Migration 063 / SMD-1812.';
COMMENT ON TABLE page_section_revisions IS
  'Append-only history of a section: one row per change to what the render reads (body, heading, order) and per ownership or lock move, with the origin the write declared and the actor. Never rewritten, never deleted while its section stands and never truncated (a row trigger refuses UPDATE and a DELETE whose section still exists, a statement trigger the truncation), the owner''s included; a section''s rows go with the section — delete_page_section''s cascade, or the page thought''s delete. page_sections_as_of() reads the latest row per section at a time; render_page(page, at) renders it. seq is an internal order, never a thought id. Migration 063 / SMD-1812.';

-- ---------------------------------------------------------------------------
-- 2. Append-only, by trigger (046's shape for thought_audit).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION page_section_revisions_refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- A revision goes only when its section is gone: the cascade's DELETE runs
  -- after the section's row is deleted, so the row is absent here; a hand
  -- DELETE, a function's, or one from inside any other trigger finds the
  -- section standing and is refused. The owner's included — 046's shape for
  -- thought_audit had no cascade to allow for (cold read, first review pass:
  -- the COMMENT claimed what the grant alone held; run-it, second review
  -- pass: the trigger-depth rule this replaced let a DELETE issued from inside
  -- any user trigger through).
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM page_sections WHERE id = OLD.section_id) THEN
    RETURN OLD;
  END IF;
  -- 008: the guidance is in the MESSAGE rather than in USING HINT deliberately
  -- (Bun's client mis-decodes the HINT field).
  RAISE EXCEPTION
    'page_section_revisions is append-only: % is not permitted. A revision is history; write the next one through write_page_section, and remove a section''s through delete_page_section. To prune history, DROP TRIGGER % in a migration — deliberately, and with a record of why.',
    TG_OP, CASE WHEN TG_OP = 'TRUNCATE' THEN 'page_section_revisions_immutable_truncate' ELSE 'page_section_revisions_immutable' END;
END;
$$;

DROP TRIGGER IF EXISTS page_section_revisions_immutable ON page_section_revisions;
CREATE TRIGGER page_section_revisions_immutable
  BEFORE UPDATE OR DELETE ON page_section_revisions
  FOR EACH ROW EXECUTE FUNCTION page_section_revisions_refuse_mutation();
DROP TRIGGER IF EXISTS page_section_revisions_immutable_truncate ON page_section_revisions;
CREATE TRIGGER page_section_revisions_immutable_truncate
  BEFORE TRUNCATE ON page_section_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION page_section_revisions_refuse_mutation();

-- ---------------------------------------------------------------------------
-- 3. The sixth lineage kind: `section`. 061's CHECK widened by one value, its
--    writer redefined on its own body plus that value, and the drop trigger a
--    deleted section's rows need (061's shape).
-- ---------------------------------------------------------------------------
-- The CHECK is found by what it constrains, not by the name 061's inline
-- CHECK was given: a brain that renamed it would otherwise keep the old one
-- beside the new and refuse every section (run-it, first review pass). Found
-- by its SHAPE — the kind list as Postgres prints an IN — so a CHECK of
-- someone else's that merely mentions the column is left standing (run-it,
-- second review pass: a LIKE on the column name dropped two such).
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
-- NOT VALID, then VALIDATE: the scan of a large table runs under a SHARE
-- UPDATE EXCLUSIVE lock rather than the ACCESS EXCLUSIVE the ADD would hold
-- through it (first review pass). A re-apply repeats the drop, the add and
-- the scan: idempotent, not free.
ALTER TABLE derivations ADD CONSTRAINT derivations_artifact_kind_check
  CHECK (artifact_kind IN ('chunks', 'entities', 'proposal', 'vector', 'metadata', 'section')) NOT VALID;
ALTER TABLE derivations VALIDATE CONSTRAINT derivations_artifact_kind_check;

-- 061's body, lifted by script and widened by one value in the kind list and
-- its message (010's trap: CREATE OR REPLACE takes the whole body).
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
  IF p_kind IS NULL OR p_kind NOT IN ('chunks', 'entities', 'proposal', 'vector', 'metadata', 'section') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('ob1_record_derivation: artifact_kind must be chunks, entities, proposal, vector, metadata or section, got %L', p_kind),
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
  INSERT INTO derivations (artifact_kind, artifact_id, input_ids, input_fingerprints, produced_by, recipe, canonical_agent_id)
  VALUES (p_kind, p_artifact, p_inputs, p_fingerprints, p_produced_by, p_recipe, p_agent)
  ON CONFLICT (artifact_kind, artifact_id, produced_by) DO UPDATE
    SET input_ids          = EXCLUDED.input_ids,
        input_fingerprints = EXCLUDED.input_fingerprints,
        recipe             = EXCLUDED.recipe,
        produced_at        = now(),
        canonical_agent_id = EXCLUDED.canonical_agent_id
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION ob1_record_derivation(text, uuid, uuid[], text[], text, jsonb, uuid) IS
  'Records one derived artifact''s lineage in `derivations`, upserting on (artifact_kind, artifact_id, produced_by) and moving produced_at: the inputs and their fingerprints (parallel, no NULL), the pass, the recipe (a JSON object with a boolean `deterministic`), the agent. Refuses a bad shape with a RAISE — a producer that cannot record its lineage must not commit its artifact either. Six kinds since 063: chunks, entities, proposal, vector, metadata (061) and section (063, a page section a machine wrote). Migration 061 / SMD-1731; 063 / SMD-1812.';

CREATE OR REPLACE FUNCTION ob1_drop_section_derivations()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM derivations WHERE artifact_kind = 'section' AND artifact_id = OLD.id;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION ob1_drop_section_derivations() IS
  'AFTER DELETE on page_sections (page_sections_drop_derivations, 063): drops the `derivations` rows the section keyed — the machine''s lineage for its body. A section goes only with its page (the page''s cascade, from the page thought''s delete), so this fires under delete_thought and under a replayed tombstone alike (061''s rule). Migration 063 / SMD-1812.';

DROP TRIGGER IF EXISTS page_sections_drop_derivations ON page_sections;
CREATE TRIGGER page_sections_drop_derivations
  AFTER DELETE ON page_sections
  FOR EACH ROW EXECUTE FUNCTION ob1_drop_section_derivations();

-- ---------------------------------------------------------------------------
-- 4. The helpers the store's functions share.
-- ---------------------------------------------------------------------------

-- The name a revision records: the caller's, else the session's ob1.actor
-- envelope's (008), else 'system'. The THOUGHT's actor is the envelope's alone
-- (050): p_actor is a name for the page's own history, never a key.
CREATE OR REPLACE FUNCTION ob1_page_actor(p_actor text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(NULLIF(trim(COALESCE(p_actor, '')), ''), NULLIF(trim(COALESCE(ob1_current_actor()->>'name', '')), ''), 'system')
$$;

-- The lock every writer takes, in the one order: the page THOUGHT (the row
-- update_thought locks, and the first row delete_thought's cascade holds),
-- then the page. A writer racing delete_thought of the page waits on the
-- thought, then finds no page — where the page-first order deadlocked (run-it,
-- first review pass). Refuses by name when either row is gone.
CREATE OR REPLACE FUNCTION ob1_page_lock(p_page_id uuid, p_what text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1 FROM thoughts WHERE id = p_page_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING MESSAGE = format('%s: no page %s', p_what, p_page_id), ERRCODE = 'no_data_found';
  END IF;
  PERFORM 1 FROM pages WHERE id = p_page_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING MESSAGE = format('%s: no page %s', p_what, p_page_id), ERRCODE = 'no_data_found';
  END IF;
END;
$$;

-- The evidence, checked: every id names a thought (a derivation against a
-- missing input is refused — SMD-1729's rule, 025's validate_derived_from's
-- shape) and none is the page itself (a page is not its own evidence: 025's
-- walk would loop on it, and the fingerprint would move with every render),
-- duplicates dropped keeping the first, and each input's text as read: 003's
-- fingerprint column where the writer keeps it, the text hashed again where it
-- is NULL (018's state; 061's rule for every producer). Returns (ids,
-- fingerprints) as parallel arrays through OUT parameters.
CREATE OR REPLACE FUNCTION ob1_page_evidence(p_ids uuid[], p_what text, p_page_id uuid, OUT o_ids uuid[], OUT o_fps text[])
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_missing uuid;
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    o_ids := ARRAY[]::uuid[];
    o_fps := ARRAY[]::text[];
    RETURN;
  END IF;
  IF array_position(p_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format('%s: evidence_thought_ids holds a NULL — every element names a thought', p_what),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_page_id IS NOT NULL AND p_page_id = ANY (p_ids) THEN
    RAISE EXCEPTION USING
      MESSAGE = format('%s: a page is not its own evidence (%s names the page)', p_what, p_page_id),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT e INTO v_missing FROM unnest(p_ids) AS e WHERE NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.id = e) LIMIT 1;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format('%s: evidence thought %s does not exist — a section derived from a thought the brain does not hold is refused (SMD-1729)', p_what, v_missing),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT array_agg(d.e ORDER BY d.n), array_agg(COALESCE(t.content_fingerprint, content_fingerprint_of(t.content)) ORDER BY d.n)
    INTO o_ids, o_fps
    FROM (SELECT DISTINCT ON (u.e) u.e, u.n FROM unnest(p_ids) WITH ORDINALITY AS u(e, n) ORDER BY u.e, u.n) d
    JOIN thoughts t ON t.id = d.e;
END;
$$;

-- The recipe a lineage row carries, and the section's generation_source
-- holds: the caller's generation_source with `deterministic` false — a
-- model's answer — unless it declares a boolean (a non-boolean is refused by
-- name: a recipe that lies about its determinism is worse than none), and
-- `declared: false` beside it when the caller sent none at all (061's
-- convention, which preflight's undeclared count reads).
CREATE OR REPLACE FUNCTION ob1_page_recipe(p_source jsonb, p_what text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_source jsonb := COALESCE(p_source, '{}'::jsonb);
BEGIN
  IF jsonb_typeof(v_source) <> 'object' THEN
    RAISE EXCEPTION USING
      MESSAGE = format('%s: generation_source must be a JSON object, got %s', p_what, jsonb_typeof(v_source)),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_source ? 'deterministic' AND jsonb_typeof(v_source->'deterministic') <> 'boolean' THEN
    RAISE EXCEPTION USING
      MESSAGE = format('%s: generation_source.deterministic must be a boolean, got %s', p_what, jsonb_typeof(v_source->'deterministic')),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_source = '{}'::jsonb THEN
    RETURN '{"deterministic": false, "declared": false}'::jsonb;
  END IF;
  RETURN CASE WHEN v_source ? 'deterministic' THEN v_source ELSE v_source || '{"deterministic": false}'::jsonb END;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. The reads: a page's sections at a time, and the render.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION page_sections_as_of(p_page_id uuid, p_at timestamptz)
RETURNS TABLE (
  section_id    uuid,
  section_key   text,
  heading       text,
  display_order integer,
  origin        text,
  body_md       text,
  actor         text,
  revised_at    timestamptz
)
LANGUAGE sql
STABLE
AS $$
  -- The latest revision of each of the page's sections at or before p_at; a
  -- section whose first revision is later is absent (it did not exist). Two
  -- revisions in one transaction share created_at; seq orders them.
  SELECT DISTINCT ON (s.id) s.id, s.section_key, r.heading, r.display_order, r.origin, r.body_md, r.actor, r.created_at
    FROM page_sections s
    JOIN page_section_revisions r ON r.section_id = s.id
   WHERE s.page_id = p_page_id AND r.created_at <= p_at
   ORDER BY s.id, r.created_at DESC, r.seq DESC
$$;

COMMENT ON FUNCTION page_sections_as_of(uuid, timestamptz) IS
  'The page''s sections as they stood at a time: the latest revision of each at or before p_at (body, heading, order, the origin the write declared, its actor, when). A section first written later is absent; a section deleted since is absent too (its revisions went with it — the page thought''s audit log holds every render). render_page(page, at) renders these. Migration 063 / SMD-1812.';

CREATE OR REPLACE FUNCTION render_page(p_page_id uuid, p_at timestamptz DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_title text;
  v_body  text;
BEGIN
  -- ob1:page-render — a CONTRACT SENTINEL (the 014 convention): this is the
  -- one spelling of a page's text, and the page thought's content is exactly
  -- it (ob1_render_page_thought writes what this returns, nothing else).
  SELECT title INTO v_title FROM pages WHERE id = p_page_id;
  IF v_title IS NULL THEN RETURN NULL; END IF;
  IF p_at IS NULL THEN
    SELECT string_agg(CASE WHEN s.heading IS NOT NULL THEN '## ' || s.heading || E'\n\n' ELSE '' END || s.body_md, E'\n\n' ORDER BY s.display_order, s.section_key)
      INTO v_body
      FROM page_sections s WHERE s.page_id = p_page_id;
  ELSE
    SELECT string_agg(CASE WHEN s.heading IS NOT NULL THEN '## ' || s.heading || E'\n\n' ELSE '' END || s.body_md, E'\n\n' ORDER BY s.display_order, s.section_key)
      INTO v_body
      FROM page_sections_as_of(p_page_id, p_at) s;
  END IF;
  RETURN '# ' || v_title || COALESCE(E'\n\n' || v_body, '');
END;
$$;

COMMENT ON FUNCTION render_page(uuid, timestamptz) IS
  'The page''s text — what its thought''s content holds: `# title`, then each section by (display_order, section_key), `## heading` when it has one and its body, joined by blank lines. With p_at, the same over page_sections_as_of(): any prior state, byte for byte (the title is the current one; the title''s own history is the page thought''s audit log). NULL for no page. Migration 063 / SMD-1812.';

-- ---------------------------------------------------------------------------
-- 6. The page thought: written through update_thought after every live change.
--    Also the repair door: a raw write of page_sections or of the page thought
--    leaves the two apart until the next live change — SELECT
--    ob1_render_page_thought(page) closes the gap (preflight's lineage check
--    counts such pages and names this call).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_render_page_thought(p_page_id uuid, p_supersedes uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_render      text;
  v_current     text;
  v_cur_derived jsonb;
  v_cur_sup     uuid;
  v_derived     jsonb;
  v_prov        jsonb := '{}'::jsonb;
  v_res         jsonb;
  v_twin        uuid;
BEGIN
  v_render := render_page(p_page_id);
  SELECT content, derived_from, supersedes INTO v_current, v_cur_derived, v_cur_sup FROM thoughts WHERE id = p_page_id;
  IF v_current IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format('page %s has no thought row — a page is a thought (063); the row was removed around delete_thought', p_page_id),
      ERRCODE = 'no_data_found';
  END IF;
  -- 025's derived_from: the union of the live sections' evidence, sorted so
  -- two renders of one state compare equal; NULL for none; a thought deleted
  -- since a section cited it is left out (the section's own array keeps it,
  -- and its lineage row reads as stale).
  SELECT COALESCE(jsonb_agg(e.id::text ORDER BY e.id::text), 'null'::jsonb)
    INTO v_derived
    FROM (SELECT DISTINCT u.e AS id FROM page_sections s CROSS JOIN LATERAL unnest(s.evidence_thought_ids) AS u(e) WHERE s.page_id = p_page_id) e
   WHERE EXISTS (SELECT 1 FROM thoughts t WHERE t.id = e.id);
  IF v_derived IS DISTINCT FROM COALESCE(v_cur_derived, 'null'::jsonb) THEN
    v_prov := v_prov || jsonb_build_object('derived_from', v_derived);
  END IF;
  IF p_supersedes IS NOT NULL AND p_supersedes IS DISTINCT FROM v_cur_sup THEN
    v_prov := v_prov || jsonb_build_object('supersedes', p_supersedes);
  END IF;
  IF v_render IS NOT DISTINCT FROM v_current AND v_prov = '{}'::jsonb THEN
    RETURN;  -- nothing moved, nothing written
  END IF;
  -- The eleven-argument form (061): the render when it moved, no patch, no
  -- vector (021 clears the old one — the re-embed worker's pool), no windows,
  -- no stale check, no actor of its own (the session's envelope stays, 008),
  -- no label, the provenance, no event, no lineage envelope.
  v_res := update_thought(
    p_page_id,
    CASE WHEN v_render IS DISTINCT FROM v_current THEN v_render END,
    NULL::jsonb, NULL::vector, NULL::jsonb, NULL::timestamptz, NULL::jsonb, NULL::text,
    CASE WHEN v_prov = '{}'::jsonb THEN NULL::jsonb ELSE v_prov END,
    NULL::jsonb, NULL::jsonb);
  IF COALESCE((v_res->>'ok')::boolean, false) THEN
    RETURN;
  END IF;
  IF v_res->>'error' = 'DUPLICATE_CONTENT' THEN
    SELECT id INTO v_twin FROM thoughts WHERE content_fingerprint = content_fingerprint_of(v_render) AND id <> p_page_id;
    RAISE EXCEPTION USING
      MESSAGE = format('page %s: another thought (%s) holds this page''s exact text — a page is a thought, and two thoughts never share one text (003); give the page a title or a section of its own', p_page_id, COALESCE(v_twin::text, 'unknown')),
      ERRCODE = 'unique_violation';
  END IF;
  IF v_res->>'error' IN ('WOULD_CYCLE', 'SUPERSEDES_NOT_FOUND') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('page %s: supersedes %s is refused — %s (025: the pointer lives on the newer thought and never closes a loop)', p_page_id, v_res->>'supersedes', v_res->>'error'),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  RAISE EXCEPTION USING
    MESSAGE = format('page %s: update_thought refused the render — %s', p_page_id, v_res::text),
    ERRCODE = 'invalid_parameter_value';
END;
$$;

COMMENT ON FUNCTION ob1_render_page_thought(uuid, uuid) IS
  'Writes the page thought after a live change: render_page() as the content when it moved, derived_from as the sorted union of the live sections'' evidence when it moved, supersedes when given — through the eleven-argument update_thought (an audited event, the vector cleared for the re-embed worker), nothing when nothing moved. Refuses by name a render another thought holds (003''s one text, one row). Called by every writer of the store, and the repair door after a raw write of page_sections or of the page thought (preflight''s lineage check names it). Migration 063 / SMD-1812.';

-- ---------------------------------------------------------------------------
-- 7. The page: create or update by slug.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_page(
  p_slug       text,
  p_title      text,
  p_page_kind  text  DEFAULT 'topic',
  p_metadata   jsonb DEFAULT '{}'::jsonb,
  p_actor      text  DEFAULT NULL,
  p_supersedes uuid  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_slug   text  := NULLIF(trim(COALESCE(p_slug, '')), '');
  v_title  text  := NULLIF(trim(COALESCE(p_title, '')), '');
  v_kind   text  := COALESCE(NULLIF(trim(COALESCE(p_page_kind, '')), ''), 'topic');
  v_meta   jsonb := COALESCE(p_metadata, '{}'::jsonb);
  v_actor  text  := ob1_page_actor(p_actor);
  v_id     uuid;
  v_render text;
  v_twin   uuid;
  v_res    jsonb;
BEGIN
  IF v_slug IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'upsert_page: slug is required', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_title IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'upsert_page: title is required', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_kind NOT IN ('topic', 'entity', 'autobiography', 'custom') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('upsert_page: page_kind must be topic, entity, autobiography or custom, got %L', v_kind),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_typeof(v_meta) <> 'object' THEN
    RAISE EXCEPTION USING
      MESSAGE = format('upsert_page: metadata must be a JSON object, got %s', jsonb_typeof(v_meta)),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_supersedes IS NOT NULL AND NOT EXISTS (SELECT 1 FROM thoughts WHERE id = p_supersedes) THEN
    RAISE EXCEPTION USING
      MESSAGE = format('upsert_page: supersedes names no thought (%s)', p_supersedes),
      ERRCODE = 'invalid_parameter_value';
  END IF;

  -- ob1:supersession-review (032/036): a supersedes write is serialised with
  -- every other on 029's lock, taken BEFORE any row — 033's order, which
  -- delete_thought keeps and update_thought would take inside the render,
  -- after the rows: two pages superseding each other deadlocked 39 of 40
  -- races and a supersede racing its target's delete 7 of 40 (run-it, second
  -- review pass). Re-entrant: update_thought takes it again below.
  IF p_supersedes IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('ob1:supersession-review'));
  END IF;
  -- An existing page: found by slug unlocked, then locked in the writers'
  -- order (the thought, then the page — ob1_page_lock); the title and the
  -- metadata (merged with ||, one level deep) move, the kind stays (a page is
  -- what it was made as), supersedes when given. The render follows the title
  -- through the thought. A page deleted while this call waited is created
  -- anew — an upsert.
  SELECT id INTO v_id FROM pages WHERE slug = v_slug;
  IF v_id IS NOT NULL THEN
    PERFORM ob1_page_lock(v_id, 'upsert_page');
    UPDATE pages
       SET title      = v_title,
           metadata   = pages.metadata || v_meta,
           updated_at = now(),
           updated_by = v_actor
     WHERE id = v_id;
    PERFORM ob1_render_page_thought(v_id, p_supersedes);
    IF p_supersedes IS NOT NULL THEN
      UPDATE pages SET status = 'archived', updated_at = now(), updated_by = v_actor WHERE id = p_supersedes AND status <> 'archived';
    END IF;
    RETURN jsonb_build_object('page_id', v_id, 'created', false);
  END IF;

  -- A new page: its thought first. The render of a page with no sections is
  -- its title line; 003's one-text-one-row rule makes two such pages with one
  -- title collide, so the collision is refused by name here rather than
  -- merged silently by upsert_thought's ON CONFLICT (which would hand back
  -- the OTHER row's id). Two concurrent creates of one text serialise on
  -- 033's fingerprint lock inside upsert_thought; the loser gets `existed`
  -- and is refused below, its merge rolled back with it. Two concurrent
  -- creates of one slug under DIFFERENT titles meet the slug's unique index
  -- instead: the loser is refused by name, its thought rolled back with it.
  v_render := '# ' || v_title;
  SELECT id INTO v_twin FROM thoughts WHERE content_fingerprint = content_fingerprint_of(v_render);
  IF v_twin IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format('upsert_page: another thought (%s) holds this page''s exact text (%L) — a page is a thought, and two thoughts never share one text (003); give the page a title of its own', v_twin, v_render),
      ERRCODE = 'unique_violation';
  END IF;
  v_res := upsert_thought(
    v_render,
    jsonb_strip_nulls(jsonb_build_object(
      'metadata', jsonb_build_object('source', 'pages', 'slug', v_slug, 'page_kind', v_kind),
      'supersedes', p_supersedes)),
    NULL::vector);
  v_id := (v_res->>'id')::uuid;
  IF COALESCE((v_res->>'existed')::boolean, false) THEN
    RAISE EXCEPTION USING
      MESSAGE = format('upsert_page: the capture merged into thought %s, which another writer created with this text meanwhile — retry, or give the page a title of its own', v_id),
      ERRCODE = 'unique_violation';
  END IF;
  BEGIN
    INSERT INTO pages (id, slug, title, page_kind, metadata, created_by, updated_by)
    VALUES (v_id, v_slug, v_title, v_kind, v_meta, v_actor, v_actor);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION USING
      MESSAGE = format('upsert_page: another writer created page %L meanwhile — retry, and the call will update it', v_slug),
      ERRCODE = 'unique_violation';
  END;
  IF p_supersedes IS NOT NULL THEN
    UPDATE pages SET status = 'archived', updated_at = now(), updated_by = v_actor WHERE id = p_supersedes AND status <> 'archived';
  END IF;
  RETURN jsonb_build_object('page_id', v_id, 'created', true);
END;
$$;

COMMENT ON FUNCTION upsert_page(text, text, text, jsonb, text, uuid) IS
  'Create or update a page by slug; returns {page_id, created}. A new page captures its thought first — the render `# title` through upsert_thought (a title another thought holds as its whole text is refused by name: 003) — and takes the thought''s id as its own; an existing one moves its title and merges its metadata one level deep (||), the kind unchanged (say it at creation), the render following through update_thought. p_supersedes names the page (or thought) this one replaces: 025''s pointer on the thought (a cycle is refused by update_thought), and that page archived. p_actor is the name the page records; absent, the session''s ob1.actor name, else system. Two creates racing on one slug: one page, the other refused by name. Migration 063 / SMD-1812.';

-- ---------------------------------------------------------------------------
-- 8. The one door for a section's text: the regen guard.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION write_page_section(
  p_page_id              uuid,
  p_section_key          text,
  p_body_md              text,
  p_origin               text    DEFAULT 'generated',
  p_heading              text    DEFAULT NULL,
  p_generation_source    jsonb   DEFAULT '{}'::jsonb,
  p_evidence_thought_ids uuid[]  DEFAULT NULL,
  p_display_order        integer DEFAULT NULL,
  p_actor                text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_key       text  := NULLIF(trim(COALESCE(p_section_key, '')), '');
  v_actor     text  := ob1_page_actor(p_actor);
  v_body      text  := COALESCE(p_body_md, '');
  -- The heading: NULL leaves it, '' clears it, a word sets it (trimmed).
  v_heading   text  := NULLIF(trim(p_heading), '');
  v_recipe    jsonb;
  v_ids       uuid[];
  v_fps       text[];
  v_old       page_sections%ROWTYPE;
  v_row       page_sections%ROWTYPE;
  v_now       timestamptz := now();
  v_action    text;
  v_moved     boolean;
  v_body_moved boolean;
BEGIN
  /**
   * ob1:page-regen-guard — a CONTRACT SENTINEL, not prose (the 014
   * convention): a generated write onto a human-owned section (origin manual,
   * or locked) never changes body_md; it parks in the pending buffer.
   */
  IF v_key IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'write_page_section: section_key is required', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_origin IS NULL OR p_origin NOT IN ('manual', 'generated') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('write_page_section: origin must be manual or generated, got %L', p_origin),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The recipe, checked whatever the origin (a manual write's is discarded
  -- below — a human's text has none — but a bad one is refused all the same).
  v_recipe := ob1_page_recipe(p_generation_source, 'write_page_section');
  -- A generated section is a derivation: it names what it was derived from,
  -- or it is not one the store accepts (SMD-1729). A manual write may cite.
  IF p_origin = 'generated' AND (p_evidence_thought_ids IS NULL OR cardinality(p_evidence_thought_ids) = 0) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'write_page_section: a generated section names the thoughts it was derived from (evidence_thought_ids) — a derived artifact without lineage is refused (SMD-1729)',
      ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The thought, then the page (the writers' one order), then the evidence.
  PERFORM ob1_page_lock(p_page_id, 'write_page_section');
  SELECT o_ids, o_fps INTO v_ids, v_fps FROM ob1_page_evidence(p_evidence_thought_ids, 'write_page_section', p_page_id);

  -- New section: insert race-safely. Two concurrent first writes to one
  -- (page_id, section_key) both reach this INSERT; the page lock above has
  -- already serialised them, and the unique constraint would anyway, so ON
  -- CONFLICT DO NOTHING lets the second fall through to the existing-section
  -- path instead of a unique violation. The first snapshots the first revision.
  INSERT INTO page_sections (
    page_id, section_key, heading, display_order, origin, body_md,
    generation_source, evidence_thought_ids, created_by, updated_by)
  VALUES (
    p_page_id, v_key, v_heading, COALESCE(p_display_order, 100), p_origin, v_body,
    CASE WHEN p_origin = 'generated' THEN v_recipe ELSE '{}'::jsonb END,
    v_ids, v_actor, v_actor)
  ON CONFLICT (page_id, section_key) DO NOTHING
  RETURNING * INTO v_row;

  IF v_row.id IS NOT NULL THEN
    INSERT INTO page_section_revisions (section_id, body_md, heading, display_order, origin, actor)
    VALUES (v_row.id, v_row.body_md, v_row.heading, v_row.display_order, p_origin, v_actor);
    v_action := 'created';
  ELSE
    SELECT * INTO v_old FROM page_sections WHERE page_id = p_page_id AND section_key = v_key FOR UPDATE;

    -- THE REGEN RULE: a machine may never overwrite a section a human owns.
    -- The draft parks with the evidence (at the fingerprints it had) and the
    -- recipe it was made from; the live body, its revision history and its
    -- lineage stay as they are. A draft that says what the live body already
    -- says is nothing to review: unchanged, nothing parked.
    IF p_origin = 'generated' AND (v_old.origin = 'manual' OR v_old.locked) THEN
      IF v_body = v_old.body_md THEN
        RETURN jsonb_build_object('section_id', v_old.id, 'action', 'unchanged');
      END IF;
      UPDATE page_sections
         SET pending_body_md               = v_body,
             pending_at                    = v_now,
             pending_generation_source     = v_recipe,
             pending_evidence_thought_ids  = v_ids,
             pending_evidence_fingerprints = v_fps,
             updated_at                    = v_now,
             updated_by                    = v_actor
       WHERE id = v_old.id;
      RETURN jsonb_build_object('section_id', v_old.id, 'action', 'pending');
    END IF;

    -- In place. A manual write takes ownership and keeps the section's
    -- evidence unless it cites anew (a human's citations), and — when it
    -- moved the body — empties the recipe: the text is no longer a machine's.
    -- A generated write onto a machine-owned section refreshes body, recipe
    -- and evidence. Either way the pending buffer clears — the live text is
    -- now the newest word.
    v_body_moved := v_body IS DISTINCT FROM v_old.body_md;
    v_moved := v_body_moved
            OR (p_heading IS NOT NULL AND v_heading IS DISTINCT FROM v_old.heading)
            OR COALESCE(p_display_order, v_old.display_order) IS DISTINCT FROM v_old.display_order
            OR (p_origin = 'manual' AND v_old.origin <> 'manual');
    UPDATE page_sections
       SET body_md                       = v_body,
           heading                       = CASE WHEN p_heading IS NULL THEN heading ELSE v_heading END,
           origin                        = CASE WHEN p_origin = 'manual' THEN 'manual' ELSE origin END,
           display_order                 = COALESCE(p_display_order, display_order),
           generation_source             = CASE WHEN p_origin = 'generated' THEN v_recipe
                                                WHEN v_body_moved THEN '{}'::jsonb
                                                ELSE generation_source END,
           evidence_thought_ids          = CASE WHEN p_evidence_thought_ids IS NOT NULL THEN v_ids ELSE evidence_thought_ids END,
           pending_body_md               = NULL,
           pending_at                    = NULL,
           pending_generation_source     = NULL,
           pending_evidence_thought_ids  = NULL,
           pending_evidence_fingerprints = NULL,
           updated_at                    = v_now,
           updated_by                    = v_actor
     WHERE id = v_old.id
     RETURNING * INTO v_row;
    IF v_moved THEN
      INSERT INTO page_section_revisions (section_id, body_md, heading, display_order, origin, actor)
      VALUES (v_row.id, v_row.body_md, v_row.heading, v_row.display_order, p_origin, v_actor);
    END IF;
    v_action := 'updated';
  END IF;

  -- ob1:derivation-recorded-with-its-artifact (061): the lineage row in the
  -- section's own transaction. A generated body is a derivation — recorded
  -- when it is new, or when its text, its evidence or its recipe moved (an
  -- identical regeneration moves no produced_at, 061's rule for a re-capture).
  -- A manual write that moved the BODY makes it a human's: its row goes with
  -- the recipe (a heading or order move alone leaves the machine's text, its
  -- recipe and its row).
  IF p_origin = 'generated' THEN
    IF v_action = 'created' OR v_moved
       OR v_row.evidence_thought_ids IS DISTINCT FROM v_old.evidence_thought_ids
       OR v_row.generation_source IS DISTINCT FROM v_old.generation_source
       -- …or the row is missing: a regeneration is the remedy preflight names
       -- for a section that lost its row, so an identical one records it
       -- (walkthrough, second review pass: it recorded nothing).
       OR NOT EXISTS (SELECT 1 FROM derivations WHERE artifact_kind = 'section' AND artifact_id = v_row.id) THEN
      PERFORM ob1_record_derivation('section', v_row.id, v_ids, v_fps, 'write_page_section', v_recipe, ob1_actor_agent_id());
    END IF;
  ELSIF v_action = 'updated' AND v_body_moved THEN
    DELETE FROM derivations WHERE artifact_kind = 'section' AND artifact_id = v_row.id;
  END IF;

  -- The page thought follows: the render and the evidence union, when moved.
  PERFORM ob1_render_page_thought(p_page_id);
  RETURN jsonb_build_object('section_id', v_row.id, 'action', v_action);
END;
$$;

COMMENT ON FUNCTION write_page_section(uuid, text, text, text, text, jsonb, uuid[], integer, text) IS
  'The one door for a section''s text (the regen guard, ob1:page-regen-guard). Returns {section_id, action} with action created | updated | pending | unchanged. A generated write onto a human-owned section (origin manual, or locked) PARKS — body untouched, the draft with its evidence (at the fingerprints it had) and recipe in the pending buffer for accept_page_section; one that says what the live body already says is unchanged, nothing parked. Any other write updates in place (a manual write takes ownership; the pending buffer clears) and snapshots a revision when body, heading, order or ownership moved; a manual write onto a locked section leaves it locked (lock_page_section unlocks). p_heading NULL leaves the heading, '''' clears it. A generated write names its evidence (refused without; every id must exist and none may be the page itself) and records its lineage row in derivations (kind section) in the same transaction, the recipe held in generation_source too; a manual write that moves the body drops the row and empties the recipe. The page thought is re-rendered through update_thought when the render or the evidence union moved. Locks the page thought, then the page, then the section. Migration 063 / SMD-1812.';

-- ---------------------------------------------------------------------------
-- 9. Accept a parked draft — a deliberate human decision.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accept_page_section(p_section_id uuid, p_actor text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_actor text := ob1_page_actor(p_actor);
  v_page  uuid;
  v_row   page_sections%ROWTYPE;
  v_ids   uuid[];
  v_fps   text[];
BEGIN
  SELECT page_id INTO v_page FROM page_sections WHERE id = p_section_id;
  IF v_page IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = format('accept_page_section: no section %s', p_section_id), ERRCODE = 'no_data_found';
  END IF;
  PERFORM ob1_page_lock(v_page, 'accept_page_section');
  SELECT * INTO v_row FROM page_sections WHERE id = p_section_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = format('accept_page_section: no section %s', p_section_id), ERRCODE = 'no_data_found';
  END IF;
  IF v_row.pending_body_md IS NULL THEN
    RETURN jsonb_build_object('section_id', v_row.id, 'action', 'no_pending');
  END IF;
  -- The draft's own evidence, checked again now: a thought deleted since the
  -- draft parked makes it a derivation from a tombstoned input — refused by
  -- name (SMD-1729); regenerate the draft. The fingerprints recorded are the
  -- ones parked with it — the text the draft was generated from, not the text
  -- the evidence holds now (cold read, first review pass).
  SELECT o_ids INTO v_ids FROM ob1_page_evidence(v_row.pending_evidence_thought_ids, 'accept_page_section', v_row.page_id);
  IF cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = format('accept_page_section: the parked draft on section %s names no evidence — a generated body without lineage is refused (SMD-1729); regenerate it', p_section_id),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  v_fps := COALESCE(v_row.pending_evidence_fingerprints, (SELECT o_fps FROM ob1_page_evidence(v_ids, 'accept_page_section', v_row.page_id)));
  -- Accepting keeps the section human-owned: the machine proposes next time
  -- too (its writes keep parking). release_page_section is the other choice.
  UPDATE page_sections
     SET body_md                       = pending_body_md,
         origin                        = 'manual',
         generation_source             = ob1_page_recipe(pending_generation_source, 'accept_page_section'),
         evidence_thought_ids          = v_ids,
         pending_body_md               = NULL,
         pending_at                    = NULL,
         pending_generation_source     = NULL,
         pending_evidence_thought_ids  = NULL,
         pending_evidence_fingerprints = NULL,
         updated_at                    = now(),
         updated_by                    = v_actor
   WHERE id = v_row.id
   RETURNING * INTO v_row;
  INSERT INTO page_section_revisions (section_id, body_md, heading, display_order, origin, actor)
  VALUES (v_row.id, v_row.body_md, v_row.heading, v_row.display_order, 'generated', v_actor);
  -- ob1:derivation-recorded-with-its-artifact (061): the accepted body is the
  -- machine's, so its lineage is recorded under the same pass as a live write.
  PERFORM ob1_record_derivation('section', v_row.id, v_ids, v_fps, 'write_page_section', v_row.generation_source, ob1_actor_agent_id());
  PERFORM ob1_render_page_thought(v_row.page_id);
  RETURN jsonb_build_object('section_id', v_row.id, 'action', 'accepted');
END;
$$;

COMMENT ON FUNCTION accept_page_section(uuid, text) IS
  'Promote a parked draft to the live body: the body, evidence and recipe move from the pending buffer, a revision is snapshotted (origin generated — the text is the machine''s — under the accepting actor), the lineage row is recorded at the fingerprints the draft was generated from, the page thought re-rendered, and the section STAYS human-owned (the machine proposes next time too). Returns {section_id, action} with accepted | no_pending. Refuses a draft whose evidence no longer exists. Migration 063 / SMD-1812.';

-- ---------------------------------------------------------------------------
-- 10. Release a section back to the machine; lock one; delete one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION release_page_section(p_section_id uuid, p_actor text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_actor text := ob1_page_actor(p_actor);
  v_page  uuid;
  v_row   page_sections%ROWTYPE;
BEGIN
  SELECT page_id INTO v_page FROM page_sections WHERE id = p_section_id;
  IF v_page IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = format('release_page_section: no section %s', p_section_id), ERRCODE = 'no_data_found';
  END IF;
  PERFORM ob1_page_lock(v_page, 'release_page_section');
  SELECT * INTO v_row FROM page_sections WHERE id = p_section_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = format('release_page_section: no section %s', p_section_id), ERRCODE = 'no_data_found';
  END IF;
  IF v_row.origin = 'generated' AND NOT v_row.locked THEN
    RETURN jsonb_build_object('section_id', v_row.id, 'action', 'already_generated');
  END IF;
  -- The body stays as it is (a human's — its recipe empty — or an accepted
  -- draft's, with its recipe and row); the next generated write refreshes it
  -- in place. The ownership move is history: a revision under the new origin,
  -- the body unchanged. A parked draft stays parked until that write.
  UPDATE page_sections
     SET origin = 'generated', locked = false, updated_at = now(), updated_by = v_actor
   WHERE id = v_row.id
   RETURNING * INTO v_row;
  INSERT INTO page_section_revisions (section_id, body_md, heading, display_order, origin, actor)
  VALUES (v_row.id, v_row.body_md, v_row.heading, v_row.display_order, 'generated', v_actor);
  RETURN jsonb_build_object('section_id', v_row.id, 'action', 'released');
END;
$$;

COMMENT ON FUNCTION release_page_section(uuid, text) IS
  'Hand a human-owned (or locked) section back to the machine: origin generated, locked false, the body as it stands (its recipe empty when a human wrote it — preflight does not read such a section as a derivation without lineage), a revision recording the move. The next generated write refreshes it in place. Returns {section_id, action} with released | already_generated. Upstream''s release was a raw UPDATE nothing recorded. Migration 063 / SMD-1812.';

CREATE OR REPLACE FUNCTION lock_page_section(p_section_id uuid, p_locked boolean, p_actor text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_actor text := ob1_page_actor(p_actor);
  v_page  uuid;
  v_row   page_sections%ROWTYPE;
BEGIN
  IF p_locked IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'lock_page_section: locked must be true or false', ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT page_id INTO v_page FROM page_sections WHERE id = p_section_id;
  IF v_page IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = format('lock_page_section: no section %s', p_section_id), ERRCODE = 'no_data_found';
  END IF;
  PERFORM ob1_page_lock(v_page, 'lock_page_section');
  SELECT * INTO v_row FROM page_sections WHERE id = p_section_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = format('lock_page_section: no section %s', p_section_id), ERRCODE = 'no_data_found';
  END IF;
  IF v_row.locked = p_locked THEN
    RETURN jsonb_build_object('section_id', v_row.id, 'action', 'unchanged');
  END IF;
  -- The lock is the human-owned rule whatever the origin says; a move of it
  -- is history, as an ownership move is: a revision under the current origin.
  UPDATE page_sections SET locked = p_locked, updated_at = now(), updated_by = v_actor WHERE id = v_row.id RETURNING * INTO v_row;
  INSERT INTO page_section_revisions (section_id, body_md, heading, display_order, origin, actor)
  VALUES (v_row.id, v_row.body_md, v_row.heading, v_row.display_order, v_row.origin, v_actor);
  RETURN jsonb_build_object('section_id', v_row.id, 'action', CASE WHEN p_locked THEN 'locked' ELSE 'unlocked' END);
END;
$$;

COMMENT ON FUNCTION lock_page_section(uuid, boolean, text) IS
  'Lock a section (a generated write parks, whatever its origin) or unlock it, recording the move as a revision under the body as it stands; a manual write leaves the lock as it is. Returns {section_id, action} with locked | unlocked | unchanged. Migration 063 / SMD-1812.';

CREATE OR REPLACE FUNCTION delete_page_section(p_section_id uuid, p_actor text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_page uuid;
  v_key  text;
BEGIN
  SELECT page_id, section_key INTO v_page, v_key FROM page_sections WHERE id = p_section_id;
  IF v_page IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = format('delete_page_section: no section %s', p_section_id), ERRCODE = 'no_data_found';
  END IF;
  PERFORM ob1_page_lock(v_page, 'delete_page_section');
  -- The section goes with its revisions (the cascade, which the revisions'
  -- trigger allows by its depth) and its lineage rows (the drop trigger); the
  -- page thought's audit log keeps every render the section was part of, and
  -- the render moves through update_thought as for any live change. p_actor
  -- is read for the thought's updated_by through the render's event alone —
  -- the section leaves nothing to record it on.
  DELETE FROM page_sections WHERE id = p_section_id;
  UPDATE pages SET updated_at = now(), updated_by = ob1_page_actor(p_actor) WHERE id = v_page;
  PERFORM ob1_render_page_thought(v_page);
  RETURN jsonb_build_object('section_id', p_section_id, 'section_key', v_key, 'action', 'deleted');
END;
$$;

COMMENT ON FUNCTION delete_page_section(uuid, text) IS
  'Remove a section from its page: the row, its revisions (the cascade) and its lineage rows go, and the page thought is re-rendered — an audited event whose before-text still holds the section. Returns {section_id, section_key, action: deleted}. A page_sections row removed by hand, around this function, leaves the thought stale until ob1_render_page_thought(page) or the next live change; preflight''s lineage check counts such pages. Migration 063 / SMD-1812.';
