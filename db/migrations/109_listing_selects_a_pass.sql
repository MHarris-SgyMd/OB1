-- =============================================================================
-- Migration 109: the listing selects one pass's proposals —
--                list_supersession_proposals redefined on 070's body with a
--                `p_judge_key` selector (SMD-3248)
-- =============================================================================
--
-- WHY
--   Every proposal names the pass that judged it in judge_key (029, NOT
--   NULL), and the key carries the pass's whole version: the judge model, or
--   under decide mode (SMD-3115) the decider and the writer, the prompt
--   version and the decide version — consolidate:h2o-lightning-4b+
--   qwen3.8:27b@p4d3. 070's listing reads the key but cannot select on it,
--   and caps a page at 200 with no cursor, so a reader filtering afterwards
--   loses every row past the cap. A reviewer grading one pass — SMD-3115's
--   precision check is per decide version — could not ask for that pass's
--   queue. Measured on the canary, 2026-10-23: 337 pending proposals, of
--   them 242 under @p4d1, 94 under @p4d3 and 1 under the 7B's @p4, and the
--   @p4d4 re-judge (SMD-3203) adds a fourth set beside them.
--
-- WHAT
--   1. list_supersession_proposals redefined on 070's body — its columns,
--      joins, order, cap and lineage selector unchanged — plus one trailing
--      parameter and one WHERE term. The parameter, `p_judge_key text
--      DEFAULT NULL`, selects the proposals whose judge_key equals it,
--      exactly: NULL every pass. It is applied before the order and the
--      cap, so a page of N holds N of that pass. Read in every status and
--      beside p_lineage. The sentinel `ob1:listing-selects-a-pass` marks the
--      body for preflight; 070's `ob1:listing-flags-the-lineage-pair` stays
--      in it, as the lineage term does.
--      A function cannot gain a parameter under CREATE OR REPLACE — another
--      argument list is another function — so 070's three-argument form is
--      dropped first, and 029's two-argument one with it if a hand
--      re-apply left it standing; EXECUTE on the new form is PUBLIC by
--      default, as on 070's, and no grant group in db/config.mjs names the
--      listing, so no ACL is carried.
--   2. The readers, in the same change. The stores and db/consolidate.ts
--      pass four arguments, always: 029 or 070 re-applied by hand lands its
--      form BESIDE this one, and a call both forms take — under three
--      arguments beside 029's, under four beside 070's (measured) — is then
--      ambiguous (42725, not unique) and fails, while four resolve here —
--      070's rule, one argument on. The MCP tool and the REST core's
--      GET /v1/proposals take `judge_key`, and each proposal's MCP value
--      gains `judgeKey` (the REST answer carried it); db/consolidate.ts
--      --list takes --key, for the proposal
--      listings and for --list relations (whose rows carry the key in their
--      facet's payload). Preflight's lineage check reads this form and its
--      sentinel and names this file where the listing is older, or where an
--      older form stands beside it.
--
-- SAFETY
--   One function dropped and created under a new arity, and one COMMENT.
--   A caller passing two or three arguments — a server or CLI from before
--   this file, during an upgrade — resolves to the new form through the
--   default and lists as before. An older server's preflight and an older
--   CLI's --status probe 070's three-argument form by its signature, which
--   this file drops, so on a brain at 109 they read the listing as from
--   before 070 and name 070's file: the fix is this tree's server and CLI,
--   never that remedy — 070 re-applied would stand its form beside this one
--   and make the older server's own three-argument calls ambiguous. The
--   window is a migrate ahead of its server: a release's `up` migrates, then
--   starts the server from the same tree. While 070's form ALONE stands (a brain at
--   108 under a server built from this tree), every fork caller fails
--   naming the four-argument form, and preflight's lineage check names this
--   file. Nothing runs at apply time but the DDL; no row moves; no table is
--   touched. The term costs one text comparison on the rows of the status
--   the listing already scans; no index (supersession_proposals holds
--   hundreds of rows on the dogfood brains). MINOR under FORK.md's version
--   rules, on 070's precedent: the parameter is trailing and defaulted, and
--   the columns are 070's, so every caller and reader keeps working.
--   test-schema [97], test-upgrade [20ba] (proposals planted before the file
--   list the same after it, and select by key), server-portable/
--   test-preflight.ts (the beside arm and the older-body arm), test-live
--   [16] (--list --key), the store and e2e suites.
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
      MESSAGE = 'migration 109 needs 016 (content_fingerprint_of); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'thoughts' AND column_name = 'derived_from') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 109 needs 025 (thoughts.derived_from); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  -- The table, not the listing: the listing is what this file creates, and a
  -- brain whose form was dropped by hand (preflight names that state) is
  -- repaired by applying this file.
  IF to_regclass('supersession_proposals') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 109 needs 029 (supersession_proposals); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- The older forms go first: another argument list is another function, so
-- CREATE OR REPLACE below would stand beside them, and a call short of four
-- arguments would be ambiguous. 029's two-argument form is gone since 070,
-- unless 029 was re-applied by hand. Callers passing two or three arguments
-- resolve to the form below through p_judge_key's default.
DROP FUNCTION IF EXISTS list_supersession_proposals(text, int, boolean);
DROP FUNCTION IF EXISTS list_supersession_proposals(text, int);

-- ---------------------------------------------------------------------------
-- list_supersession_proposals — the review queue, with both thoughts,
-- whether the pair is a lineage pair, and the pass that judged it
--
-- 070's body — columns, joins, order, cap, lineage selector — plus the last
-- parameter and one WHERE term.
-- p_status NULL lists every state; p_lineage NULL every pair; p_judge_key
-- NULL every pass. Most confident first; capped at 200.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION list_supersession_proposals(
  p_status    text    DEFAULT 'pending',
  p_limit     int     DEFAULT 20,
  p_lineage   boolean DEFAULT NULL,
  p_judge_key text    DEFAULT NULL
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
  lineage          boolean
)
LANGUAGE sql
STABLE
AS $$
  -- 070 (ob1:listing-flags-the-lineage-pair): the pair is a lineage pair when
  -- either side's derived_from names the other — 066's predicate, which the
  -- candidate filter applies, read here on a proposal already standing.
  -- COALESCE: a NULL derived_from is "names nothing", not unknown.
  -- 109 (ob1:listing-selects-a-pass): p_judge_key keeps one pass's proposals,
  -- by its key exactly, before the order and the cap.
  SELECT p.id, p.status, p.verdict, p.confidence, p.reason, p.similarity, p.judge_key,
         p.judged_at, p.reviewed_at, p.review_note, p.superseding_id,
         o.id, o.content, o.created_at,
         n.id, n.content, n.created_at,
         p.older_fingerprint IS NOT NULL AND p.older_fingerprint IS DISTINCT FROM content_fingerprint_of(o.content),
         p.newer_fingerprint IS NOT NULL AND p.newer_fingerprint IS DISTINCT FROM content_fingerprint_of(n.content),
         COALESCE(n.derived_from @> jsonb_build_array(o.id::text), false)
           OR COALESCE(o.derived_from @> jsonb_build_array(n.id::text), false)
    FROM supersession_proposals p
    JOIN thoughts o ON o.id = p.older_id
    JOIN thoughts n ON n.id = p.newer_id
   WHERE (p_status IS NULL OR p.status = p_status)
     AND (p_judge_key IS NULL OR p.judge_key = p_judge_key)
     AND (p_lineage IS NULL
          OR (COALESCE(n.derived_from @> jsonb_build_array(o.id::text), false)
              OR COALESCE(o.derived_from @> jsonb_build_array(n.id::text), false)) = p_lineage)
   ORDER BY p.confidence DESC, p.judged_at, p.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 200)
$$;

COMMENT ON FUNCTION list_supersession_proposals(text, int, boolean, text) IS
  'The proposals in one status (NULL for all), most confident first, each with both thoughts'' content and capture time as they are NOW, whether either text has changed since the pair was judged, whether the pair is a lineage pair (070: one side''s derived_from names the other, so the pair would never be proposed today, 066, and a reviewer rejects it), and the pass that judged it. p_lineage NULL lists every pair, true the lineage pairs alone, false the rest; p_judge_key NULL every pass, or the proposals of the pass with exactly that judge_key (109), selected before the cap. At most 200. Migrations 029, 070, 109.';
