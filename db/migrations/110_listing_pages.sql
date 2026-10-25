-- =============================================================================
-- Migration 110: the listing pages — list_supersession_proposals redefined on
--                109's body with a keyset cursor on its own order and two
--                columns a reader pages by (SMD-3249)
-- =============================================================================
--
-- WHY
--   The listing caps a page at 200 with no cursor (070, kept by 109), so a
--   status or a pass of more than 200 proposals could be read only in part.
--   A pending queue drains as it is reviewed — each accept or reject leaves
--   pending, so listing again shows the rest — but every other listing
--   stops at 200: accepted, rejected, stale, all, and any look back at one
--   pass's verdicts (SMD-3115's precision check is per pass). The canary on
--   2026-10-24 held 242 pending proposals under @p4d1 alone, and 126
--   rejected ones across the passes before it.
--
-- WHAT
--   1. list_supersession_proposals redefined on 109's body — its columns,
--      joins, order, cap and the status, lineage and judge-key selectors
--      unchanged — plus three trailing parameters, one WHERE term and two
--      trailing columns. The parameters, `p_after_confidence numeric`,
--      `p_after_judged_at timestamptz` and `p_after_id uuid`, all DEFAULT
--      NULL, are the last listed row's values on the listing's order
--      (`confidence DESC, judged_at, id`): set, the listing starts after that
--      row — `confidence < c OR (confidence = c AND (judged_at > t OR
--      (judged_at = t AND id > i)))` — before the order and the cap. The
--      values, not the row's id: 063's recorder replaces a stale row in
--      place (ON CONFLICT DO UPDATE: the same id, judged_at now() and the new
--      verdict's confidence), so a cursor that named the row would read its
--      new place and jump the walk, skipping or repeating rows; the values
--      keep the place the page ended at. A walk so lists each row once while
--      its status, judge key, confidence and judged_at hold; a row that joins
--      the selection or moves in it during the walk — a new proposal, a
--      decision, a stale mark, a re-judge — is listed if its place is past
--      the cursor and missed if behind it, and one that leaves it is not
--      listed after (review passes 1 and 2). All three
--      set or none: a partial cursor is refused by name (it would otherwise
--      read as no cursor and list from the top, a silent restart).
--      The columns: `page_key text`, a JSON array of the row's three values as text —
--      confidence::text exactly (numeric(3,2)), judged_at::text to the
--      microsecond (the form the thoughts cursor carries created_at in),
--      the id — which a reader passes back as the next call's three
--      parameters; and `remaining bigint`, how many rows the selection holds
--      from this page's first on (count(*) OVER (), before the LIMIT), so a
--      reader knows whether more follow without asking past the cap.
--      LANGUAGE plpgsql, for the refusal: a sql function cannot raise. The
--      body runs one query, RETURN QUERY, `#variable_conflict use_column`
--      so the output columns' names never shadow the table's. The sentinel
--      `ob1:listing-pages` marks the body for preflight; 070's
--      `ob1:listing-flags-the-lineage-pair` and 109's
--      `ob1:listing-selects-a-pass` stay in it, as their terms do.
--      A RETURNS TABLE cannot gain a column under CREATE OR REPLACE, and
--      another argument list is another function, so 109's four-argument
--      form is dropped first, and 070's and 029's with it if a hand re-apply
--      left them; EXECUTE on the new form is PUBLIC by default and no grant
--      group in db/config.mjs names the listing, so no ACL is carried.
--   2. The readers, in the same change. The stores and db/consolidate.ts
--      pass seven arguments, always: 029, 070 or 109 re-applied by hand lands
--      its form BESIDE this one, and a call both forms take is then
--      ambiguous (42725, not unique) and fails, while seven resolve here —
--      070's rule, three arguments on. The MCP tool and GET /v1/proposals
--      take `after` (a cursor) and answer `cursor` (null once no more follow)
--      — list_thoughts' shape (SMD-2995) — and db/consolidate.ts --list takes
--      --after. Preflight's lineage check reads this form and its sentinels.
--
-- SAFETY
--   One function dropped and created under a new arity and a new RETURNS
--   TABLE, and one COMMENT. A caller passing two, three or four arguments —
--   a server or CLI from before this file — resolves to the new form through
--   the defaults on a connection opened after it; a reader keying the rows
--   by name (the store's mapper, the CLI's row type, PostgREST's JSON) gains
--   two columns and loses none. But a connection that had already listed
--   holds a prepared `SELECT *` whose result type this file changes: each
--   later call on it fails, "cached plan must not change result type"
--   (0A000), until the process restarts (review pass 3: an older server left
--   running across a hand-run migrate.ts failed every listing; 109 kept
--   070's columns and so never met it). The release's `up` recreates the
--   servers after the migration; a server left running is restarted. An
--   older server's preflight and an older CLI's --status probe the
--   four-argument form by its signature, which this file drops, so on a
--   brain at 110 they read the listing as from before 109 — preflight says
--   every listing fails and prints `migrate.ts --reapply`, --status says
--   "apply migration 109 first": the fix is this tree's server and CLI, never
--   that remedy — the older tree's --reapply stands 109's form beside this
--   one, and its four-argument calls are then not unique. Nothing runs at apply time but the DDL; no row moves;
--   no table is touched. The keyset term and the window count read the
--   rows of the selection the listing already sorts; no index
--   (supersession_proposals holds hundreds of rows on the dogfood brains).
--   MINOR under FORK.md's version rules, on 070's and 109's precedent: the
--   parameters and the columns are trailing and defaulted.
--   test-schema [98], test-upgrade [20bb], server-portable/test-preflight.ts,
--   test-live [16] (--list --after), the store and e2e suites.
--
-- Prerequisites
--   016 (content_fingerprint_of, which the body calls), 025
--   (thoughts.derived_from), 029 (supersession_proposals; the listing this
--   file redefines is not probed — it is what the file creates, and a form
--   dropped by hand is repaired by applying it). Applied by `bun db/migrate.ts`.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape). Every probe names an object that stands on a brain at
-- this file too, so a --reapply passes.
DO $qc$
BEGIN
  IF to_regprocedure('content_fingerprint_of(text)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 110 needs 016 (content_fingerprint_of); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'thoughts' AND column_name = 'derived_from') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 110 needs 025 (thoughts.derived_from); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  -- The table, not the listing: the listing is what this file creates, and a
  -- brain whose form was dropped by hand (preflight names that state) is
  -- repaired by applying this file.
  IF to_regclass('supersession_proposals') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 110 needs 029 (supersession_proposals); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- The older forms go first: a RETURNS TABLE cannot gain a column under
-- CREATE OR REPLACE, and another argument list is another function, so
-- CREATE OR REPLACE below would stand beside them. Callers passing two,
-- three or four arguments resolve to the form below through its defaults.
DROP FUNCTION IF EXISTS list_supersession_proposals(text, int, boolean, text);
DROP FUNCTION IF EXISTS list_supersession_proposals(text, int, boolean);
DROP FUNCTION IF EXISTS list_supersession_proposals(text, int);

-- ---------------------------------------------------------------------------
-- list_supersession_proposals — the review queue, with both thoughts,
-- whether the pair is a lineage pair, the pass that judged it, and where a
-- reader goes on from
--
-- 109's body — columns, joins, order, cap, the lineage and judge-key
-- selectors — plus the after-cursor's three parameters and its term, and the
-- page_key and remaining columns.
-- p_status NULL lists every state; p_lineage NULL every pair; p_judge_key
-- NULL every pass; the after-cursor NULL from the top. Most confident first;
-- capped at 200.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION list_supersession_proposals(
  p_status           text        DEFAULT 'pending',
  p_limit            int         DEFAULT 20,
  p_lineage          boolean     DEFAULT NULL,
  p_judge_key        text        DEFAULT NULL,
  p_after_confidence numeric     DEFAULT NULL,
  p_after_judged_at  timestamptz DEFAULT NULL,
  p_after_id         uuid        DEFAULT NULL
)
RETURNS TABLE (
  id               uuid,
  status           text,
  verdict          text,
  confidence       numeric,
  reason           text,
  similarity       real,
  judge_key        text,
  judged_at        timestamptz,
  reviewed_at      timestamptz,
  review_note      text,
  superseding_id   uuid,
  older_id         uuid,
  older_content    text,
  older_created_at timestamptz,
  newer_id         uuid,
  newer_content    text,
  newer_created_at timestamptz,
  older_edited     boolean,
  newer_edited     boolean,
  lineage          boolean,
  page_key         text,
  remaining        bigint
)
LANGUAGE plpgsql
STABLE
AS $$
#variable_conflict use_column
BEGIN
  -- 110 (ob1:listing-pages): all three of the cursor's values or none — a
  -- partial cursor read as none would list from the top without a word.
  IF num_nulls(p_after_confidence, p_after_judged_at, p_after_id) NOT IN (0, 3) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'list_supersession_proposals: the after-cursor is three values, p_after_confidence, p_after_judged_at and p_after_id, all set or none',
      ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  -- 070 (ob1:listing-flags-the-lineage-pair): the pair is a lineage pair when
  -- either side's derived_from names the other — 066's predicate, which the
  -- candidate filter applies, read here on a proposal already standing.
  -- COALESCE: a NULL derived_from is "names nothing", not unknown.
  -- 109 (ob1:listing-selects-a-pass): p_judge_key keeps one pass's proposals,
  -- by its key exactly, before the order and the cap.
  -- 110 (ob1:listing-pages): the after-cursor starts past the row it names on
  -- the listing's own order, before the order and the cap; page_key is each
  -- row's values for the next call, remaining the selection's rows from this
  -- page's first on, counted before the LIMIT.
  SELECT p.id, p.status, p.verdict, p.confidence, p.reason, p.similarity, p.judge_key,
         p.judged_at, p.reviewed_at, p.review_note, p.superseding_id,
         o.id, o.content, o.created_at,
         n.id, n.content, n.created_at,
         p.older_fingerprint IS NOT NULL AND p.older_fingerprint IS DISTINCT FROM content_fingerprint_of(o.content),
         p.newer_fingerprint IS NOT NULL AND p.newer_fingerprint IS DISTINCT FROM content_fingerprint_of(n.content),
         COALESCE(n.derived_from @> jsonb_build_array(o.id::text), false)
           OR COALESCE(o.derived_from @> jsonb_build_array(n.id::text), false),
         jsonb_build_array(p.confidence::text, p.judged_at::text, p.id::text)::text,
         count(*) OVER ()
    FROM supersession_proposals p
    JOIN thoughts o ON o.id = p.older_id
    JOIN thoughts n ON n.id = p.newer_id
   WHERE (p_status IS NULL OR p.status = p_status)
     AND (p_judge_key IS NULL OR p.judge_key = p_judge_key)
     AND (p_after_id IS NULL
          OR p.confidence < p_after_confidence
          OR (p.confidence = p_after_confidence
              AND (p.judged_at > p_after_judged_at
                   OR (p.judged_at = p_after_judged_at AND p.id > p_after_id))))
     AND (p_lineage IS NULL
          OR (COALESCE(n.derived_from @> jsonb_build_array(o.id::text), false)
              OR COALESCE(o.derived_from @> jsonb_build_array(n.id::text), false)) = p_lineage)
   ORDER BY p.confidence DESC, p.judged_at, p.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 200);
END
$$;

COMMENT ON FUNCTION list_supersession_proposals(text, int, boolean, text, numeric, timestamptz, uuid) IS
  'The proposals in one status (NULL for all), most confident first, each with both thoughts'' content and capture time as they are NOW, whether either text has changed since the pair was judged, whether the pair is a lineage pair (070: one side''s derived_from names the other, so the pair would never be proposed today, 066, and a reviewer rejects it), and the pass that judged it. p_lineage NULL lists every pair, true the lineage pairs alone, false the rest; p_judge_key NULL every pass, or the proposals of the pass with exactly that judge_key (109). The after-cursor (110) — p_after_confidence, p_after_judged_at, p_after_id, all set or none — starts past that row on the listing''s order; each row''s page_key holds a JSON array of its three values as text for the next call, and remaining counts the selection''s rows from this page''s first on, so remaining > the rows returned means more follow. Every selector applies before the cap. At most 200. Migrations 029, 070, 109, 110.';
