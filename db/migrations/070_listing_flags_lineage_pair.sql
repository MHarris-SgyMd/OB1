-- =============================================================================
-- Migration 070: a proposal standing on a lineage pair is visible as such —
--                list_supersession_proposals redefined on 029's body with a
--                `lineage` column and a selector for it (SMD-2313)
-- =============================================================================
--
-- WHY
--   066 (SMD-2292) stops consolidation_candidates from pairing a thought with
--   a member of its derived_from, so the judge is no longer asked whether a
--   page supersedes its own evidence, or a digest its sources. It changes
--   nothing about a proposal that already stands on such a pair — judged
--   before 066, or recorded raw: the file ran no data step (a rejection is a
--   verdict with a reviewer's name on it), record_supersession_proposal has
--   no lineage guard (measured in SMD-2292's second review pass: a proposal
--   on (E, A) with A.derived_from = [E] is recorded at 066), and the
--   listing — 029's list_supersession_proposals, which db/consolidate.ts
--   --list and the MCP tool print — reads the verdict, both texts, the ids,
--   the cosine and the judge key, nothing of derived_from. A reviewer sees
--   "the page supersedes its evidence" as any other pending row, and an
--   accept archives the evidence while the page still names it — the harm
--   066's WHY describes. Such a row is nobody's but the reviewer's: a
--   pending proposal holds its pair — 029's rule, which 063's candidate
--   clause reads (a pair proposed in any state but stale is never a
--   candidate), so no pass could ever re-judge it — and 063's recorder
--   replaces stale rows alone, so nothing rewrites it. A row that has gone
--   stale (063: a text moved under the verdict — a page re-rendered moves
--   its text) is what 063's clause re-admits and 066 keeps out, so it is the
--   pass's since 067: the next run that re-pools its newer thought (both
--   sides with a vector, no failed claim under the run's key — a failed one
--   is --retry-failed's) finds the pair no longer a candidate and settles it,
--   the note naming the term that failed — "a lineage pair" unless a side is
--   superseded, which is named first; until that run it is listed as any
--   stale row — tagged, since this file. A census counting
--   unreviewed proposals on lineage pairs ran in about 10 ms on the probe
--   corpus (SMD-2313, filed from SMD-2292's second review pass).
--
-- WHAT
--   1. list_supersession_proposals redefined on 029's body — its columns,
--      joins, order and cap unchanged — plus one column, one parameter and
--      one WHERE term. The column, `lineage boolean`, is 066's
--      predicate on the pair — the newer side's derived_from naming the
--      older (a page and its evidence, a digest and its sources) or the
--      older's naming the newer (an older note re-cited through
--      update_thought's envelope, an ingester's backdated part row) —
--      NULL-safe, direct members only, spelled as 066 spells it (the array
--      form 025's readers use: `'["a"]'::jsonb @> '"a"'` is TRUE in
--      Postgres, so to_jsonb(id::text) would be the same rule; the regex in
--      test-schema pins the spelling); false on a pair neither side of which
--      names the other. The parameter, `p_lineage boolean DEFAULT NULL`,
--      selects on it: NULL every row (a two-argument call resolves here
--      through the default), true the lineage pairs alone,
--      false the rest. Read in every status: a rejected lineage row says
--      what it was, and the pass's settle note (067) names the reason
--      beside it.
--      A RETURNS TABLE cannot gain a column under CREATE OR REPLACE, so the
--      two-argument form is dropped first and the three-argument one
--      created; EXECUTE on it is PUBLIC by default, as on 029's, and no role
--      grant group in db/config.mjs names the listing, so no ACL is
--      carried. The sentinel `ob1:listing-flags-the-lineage-pair` marks
--      the body for preflight.
--   2. The readers, in the same change. db/consolidate.ts --list prints
--      LINEAGE PAIR on such a row with the reject to run, --list lineage
--      selects the unreviewed ones (pending, then stale; a decided row is
--      under its own status, tagged), --status counts them (its own SQL,
--      so it reads on a brain at 068 and names this file there); the MCP tool
--      list_supersession_proposals prints the tag and takes `lineage: true`;
--      db/consolidate.ts --accept on a lineage pair is refused with the
--      reject named unless --force (029's rule for a text edited since
--      judged, CLI-side — a guard, not a verdict; the listing's and the
--      tool's accept lines carry --force on such a row);
--      preflight's `lineage` check counts unreviewed (pending, stale)
--      proposals on a lineage pair — bounded, as its census is — and WARNs
--      with the count, the first ids and the remedy, and WARNs when the
--      listing's body is from before this file — this file not yet applied,
--      or a hand DROP — or when 029's two-argument form stands beside it:
--      029 re-applied by hand does not touch this body (a different argument
--      list is a new overload, not a replacement), it lands its own form
--      BESIDE this one, and a call passing fewer than three arguments is then
--      ambiguous — Postgres does not prefer the form without the default
--      (42725, not unique; measured) — so it fails, while a call passing
--      three resolves here. The fork's callers pass three arguments for that
--      reason; the second arm reads the count of forms.
--   3. NOT this file: a verdict. An auto-reject of the standing rows at apply
--      time was decided against in SMD-2292 and here — a rejection is a
--      reviewer's, with a name on it, and 066 promised nothing runs at apply
--      time but the DDL; the flag and a listed reject (`bun db/consolidate.ts
--      --list lineage`, then `--reject <id> --note "lineage pair (066)"`) are
--      the first step. A --reject-lineage sweep (an UPDATE with a
--      review_note, never a DELETE) is an opt-in second step, not taken
--      until the flag has been used. record_supersession_proposal keeps no
--      lineage guard: the rule lives in the candidate filter, the worker's
--      one source of pairs, and a raw recording is a raw writer's.
--
-- SAFETY
--   One function dropped and created under a new arity — the two-argument
--   form is gone; while it ALONE stands (a brain at 068 under a server
--   built from this tree) every fork caller fails naming the three-argument
--   form, and the MCP tool's hint, the CLI's --list and preflight's lineage
--   check name this file; PostgREST's rpc by name resolves once its schema
--   cache reloads — and one COMMENT. Nothing runs at apply time but the
--   DDL; no row moves; no table is touched. The predicate costs two per-row
--   jsonb containments on every row of the status the listing joins
--   (projected below the sort, so before the cap, p_lineage set or not); no
--   index. No grant is carried: EXECUTE is PUBLIC by default and no grant
--   group in db/config.mjs names the listing, so a hand REVOKE on the old
--   form is lost and re-granted by hand (061's rule for the forms it
--   dropped). MINOR under FORK.md's version
--   rules, on the precedent 046 wrote ("an added, defaulted parameter
--   keeps" every caller) and 058, 059 and 061 followed for a dropped-and-
--   recreated form — FORK.md's MAJOR bullet reads a changed signature or
--   return shape literally, and SMD-2324 asks it to carry the additive
--   clause these five files argue: the parameter is trailing
--   and defaulted, so every two-argument caller resolves to this form; the
--   column is trailing, and every reader in the tree keys by name (the
--   store's mapper, the CLI's row type, PostgREST's JSON, the eval's
--   SELECT *), so none moves. 029's file is not edited: it is frozen by
--   release 1.0.0.
--   test-schema [64], test-upgrade [20v] (proposals planted before the file
--   read the flag after it, the table whole and unmoved),
--   server-portable/test-preflight.ts (the census arm and the older-body
--   arm), test-live [16] (--list lineage), the store and e2e suites.
--
-- Prerequisites
--   016 (content_fingerprint_of, which 029's body calls), 025
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
      MESSAGE = 'migration 070 needs 016 (content_fingerprint_of); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'thoughts' AND column_name = 'derived_from') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 070 needs 025 (thoughts.derived_from); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  -- The table, not the listing: the listing is what this file creates, and a
  -- brain whose form was dropped by hand (preflight names that state) is
  -- repaired by applying this file.
  IF to_regclass('supersession_proposals') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 070 needs 029 (supersession_proposals); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- The two-argument form goes first: a RETURNS TABLE cannot gain a column
-- under CREATE OR REPLACE. Callers passing two arguments resolve to the
-- form below through p_lineage's default.
DROP FUNCTION IF EXISTS list_supersession_proposals(text, int);

-- ---------------------------------------------------------------------------
-- list_supersession_proposals — the review queue, with both thoughts, and
-- whether the pair is a lineage pair
--
-- 029's body — columns, joins, order, cap — plus the last column, the last
-- parameter and one WHERE term.
-- p_status NULL lists every state; p_lineage NULL every pair. Most confident
-- first; capped at 200.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION list_supersession_proposals(
  p_status  text    DEFAULT 'pending',
  p_limit   int     DEFAULT 20,
  p_lineage boolean DEFAULT NULL
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
     AND (p_lineage IS NULL
          OR (COALESCE(n.derived_from @> jsonb_build_array(o.id::text), false)
              OR COALESCE(o.derived_from @> jsonb_build_array(n.id::text), false)) = p_lineage)
   ORDER BY p.confidence DESC, p.judged_at, p.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 200)
$$;

COMMENT ON FUNCTION list_supersession_proposals(text, int, boolean) IS
  'The proposals in one status (NULL for all), most confident first, each with both thoughts'' content and capture time as they are NOW, whether either text has changed since the pair was judged, and — since 070 — whether the pair is a lineage pair: one side''s derived_from names the other (direct members, either direction, as 066''s candidate filter reads it), so the pair would never be proposed today and a reviewer rejects it (a derivation and its input; re-deriving is rebuild_derived''s door). p_lineage NULL lists every pair, true the lineage pairs alone, false the rest. At most 200. Migrations 029, 070.';
