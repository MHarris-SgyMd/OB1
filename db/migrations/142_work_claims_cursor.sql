-- =============================================================================
-- Migration 142: the work-claims listing pages — list_work_claims redefined on
--                115's body with a keyset cursor on its own order and the four
--                columns a reader pages by (SMD-3606 PR 2)
-- =============================================================================
--
-- WHY
--   list_work_claims caps a page at 1,000 rows with no cursor (115), ordered by
--   (issue, piece_key, claimed_at, id). One key that hoards the board — SMD-3606's
--   runaway agent, before 140's cap stops it — pushes everyone else's rows past
--   the cap, so an unfiltered "who holds what" goes blind past 1,000. A keyset
--   cursor lets a full read page to the end instead of stopping there (SMD-3606
--   Work item 2), as 110 gave list_supersession_proposals.
--
-- WHAT
--   list_work_claims redefined on 115's body — its columns, filters, order and
--   cap unchanged — plus four trailing parameters, one WHERE term and two
--   trailing columns. The parameters, `p_after_issue text`, `p_after_piece_key
--   text`, `p_after_claimed_at timestamptz` and `p_after_id uuid`, all DEFAULT
--   NULL, are the last listed row's values on the listing's order: set, the
--   listing starts after that row, before the order and the cap. All four order
--   columns are NOT NULL (issue; piece_key is generated COALESCE(lower(piece),
--   ''); claimed_at; id the PK) and the order is all ascending, so the keyset is
--   one row-value comparison, `(issue, piece_key, claimed_at, id) > (the four)` —
--   no NULL to unroll, unlike 110's confidence DESC. The values, not a row id
--   alone: a claim's four order values never change after it is made (renew
--   touches renewed_at and expires_at, not claimed_at; a takeover is a new row
--   with its own claimed_at and id), so the cursor keeps the place the page
--   ended at and a walk lists each claim once while it stands; a claim made or
--   ended during the walk is listed if its place is past the cursor, missed if
--   behind it. All four set or none: a partial cursor is refused by name (it
--   would otherwise read as no cursor and list from the top, a silent restart).
--   The columns: `page_key text`, a JSON array of the row's four values as text
--   (issue, piece_key, claimed_at::text to the microsecond, id) which a reader
--   passes back as the next call's four parameters; and `remaining bigint`,
--   count(*) OVER () — the selection's rows from this page's first on, before the
--   LIMIT — so a reader knows whether more follow without asking past the cap.
--   LANGUAGE plpgsql, for the refusal: a sql function cannot raise. The body runs
--   one query, RETURN QUERY, `#variable_conflict use_column` so the output
--   columns' names never shadow the table's.
--   A RETURNS TABLE cannot gain a column under CREATE OR REPLACE, and another
--   argument list is another function, so 115's four-argument form is dropped
--   first; EXECUTE on the new form is PUBLIC by default and no grant group in
--   deploy/config.mjs names the listing, so no ACL is carried (115's listing read
--   was PUBLIC too).
--   The readers, in the same change: the store passes eight arguments always
--   (115 re-applied by hand lands its four-argument form beside this one, and a
--   call both forms take is then ambiguous, 42725, and fails; eight resolve
--   here), its columns by name so a later column leaves the prepared plan's
--   result type as it was (SMD-3302); the MCP tool and GET /v1/claims take
--   `after` (a cursor) and answer `cursor` (null once no more follow) — list_
--   thoughts' and list_supersession_proposals' shape (SMD-2995, SMD-3249).
--   preflight's ticket-claims check reads the eight-argument signature.
--
-- SAFETY
--   One function dropped and created under a new arity and a new RETURNS TABLE,
--   and one COMMENT. A caller passing four arguments — a server from before this
--   file — resolves to the new form through the defaults on a connection opened
--   after it; a reader keying the rows by name gains two columns and loses none.
--   A connection that had already listed holds a prepared `SELECT` whose result
--   type this file changes; the store selects by name, so it is re-planned, not
--   failed 0A000 ("cached plan must not change result type"), when the process
--   keeps running. An older server left running calls the four-argument form this
--   file drops and fails every listing (42883, function does not exist) until it
--   restarts; the release's `up` recreates the servers. Preflight on a brain at
--   142, run from an older tree, probes the four-argument signature this file
--   dropped and reports the listing missing; the fix is this tree's server, which
--   probes the eight. Nothing runs at apply time but the DDL; no row moves; no
--   table is touched. The keyset term and the window count read the rows the
--   listing already sorts; no index (work_claims holds few rows on the dogfood
--   brains, and 140 now caps a holder at 50). MINOR under FORK.md's version
--   rules, on 110's precedent: the parameters and the columns are trailing and
--   defaulted. test-schema [128], test-upgrade [20cf], server-portable/test-
--   preflight.ts, test-rest-sql, the store and server suites.
--
-- Prerequisites
--   115 (work_claims, and ob1_work_claim_text, which the body calls). The listing
--   this file redefines is not probed — it is what the file creates, and a form
--   dropped by hand is repaired by applying it. Applied by `bun db/migrate.ts`.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not hold
-- (052's shape). Every probe names an object that stands on a brain at this file.
DO $qc$
BEGIN
  IF to_regclass('work_claims') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 142 needs 115 (work_claims); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('ob1_work_claim_text(text, integer, text)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 142 needs 115 (ob1_work_claim_text); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- The older form goes first: a RETURNS TABLE cannot gain a column under CREATE OR
-- REPLACE, and another argument list is another function, so CREATE OR REPLACE
-- below would stand beside it. A caller passing four arguments resolves to the
-- form below through its defaults.
DROP FUNCTION IF EXISTS list_work_claims(text[], text, boolean, int);

-- ---------------------------------------------------------------------------
-- list_work_claims — who holds a ticket or one of its pieces, and where a
-- reader goes on from.
--
-- 115's body — columns, filters, order, cap — plus the after-cursor's four
-- parameters and its term, and the page_key and remaining columns.
-- p_issues NULL lists every ticket; p_holder NULL every holder; p_include_ended
-- false the live alone; the after-cursor NULL from the top. By ticket, then
-- piece, then claim time, then id; capped at 1,000.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION list_work_claims(
  p_issues           text[]      DEFAULT NULL,
  p_holder           text        DEFAULT NULL,
  p_include_ended    boolean     DEFAULT false,
  p_limit            int         DEFAULT 100,
  p_after_issue      text        DEFAULT NULL,
  p_after_piece_key  text        DEFAULT NULL,
  p_after_claimed_at timestamptz DEFAULT NULL,
  p_after_id         uuid        DEFAULT NULL
)
RETURNS TABLE (
  id uuid, issue text, piece text, holder text, holder_agent_id uuid, holder_kind text,
  label text, claimed_at timestamptz, renewed_at timestamptz, expires_at timestamptz,
  released_at timestamptz, released_by text, released_by_kind text, release_reason text, state text,
  page_key text, remaining bigint
)
LANGUAGE plpgsql
STABLE
AS $$
#variable_conflict use_column
BEGIN
  -- 142 (SMD-3606 PR 2): all four of the cursor's values or none — a partial
  -- cursor read as none would list from the top without a word (110's rule).
  IF num_nulls(p_after_issue, p_after_piece_key, p_after_claimed_at, p_after_id) NOT IN (0, 4) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'list_work_claims: the after-cursor is four values, p_after_issue, p_after_piece_key, p_after_claimed_at and p_after_id, all set or none',
      ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  -- 142 (ob1:work-claims-pages): the after-cursor starts past the row it names
  -- on the listing's own order, before the order and the cap; page_key is each
  -- row's four values for the next call, remaining the selection's rows from this
  -- page's first on, counted before the LIMIT. All four order columns are NOT
  -- NULL and ascending, so the keyset is one row-value comparison.
  SELECT c.id, c.issue, c.piece, c.holder_name, c.holder_agent_id, c.holder_kind,
         c.label, c.claimed_at, c.renewed_at, c.expires_at,
         c.released_at, c.released_by, c.released_by_kind, c.release_reason,
         CASE WHEN c.released_at IS NOT NULL THEN 'released' WHEN c.expires_at <= statement_timestamp() THEN 'lapsed' ELSE 'live' END,
         jsonb_build_array(c.issue, c.piece_key, c.claimed_at::text, c.id::text)::text,
         count(*) OVER ()
    FROM work_claims c
   WHERE (p_issues IS NULL OR c.issue = ANY (ARRAY(SELECT upper(ob1_work_claim_text(left(k, 200), 200, 'a ticket key')) FROM unnest(p_issues) k)))
     AND (p_holder IS NULL OR c.holder_name = p_holder)
     AND (p_include_ended OR (c.released_at IS NULL AND c.expires_at > statement_timestamp()))
     AND (p_after_id IS NULL
          OR (c.issue, c.piece_key, c.claimed_at, c.id) > (p_after_issue, p_after_piece_key, p_after_claimed_at, p_after_id))
   ORDER BY c.issue, c.piece_key, c.claimed_at, c.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 1000);
END
$$;

COMMENT ON FUNCTION list_work_claims(text[], text, boolean, int, text, text, timestamptz, uuid) IS
  'Who holds a ticket, or one piece of it, under a lease — live, lapsed or (p_include_ended) released, by ticket then piece then claim time then id. p_issues NULL lists every ticket, p_holder NULL every holder. The after-cursor (142) — p_after_issue, p_after_piece_key, p_after_claimed_at, p_after_id, all set or none — starts past that row on the listing''s order; each row''s page_key holds a JSON array of its four values as text for the next call, and remaining counts the selection''s rows from this page''s first on, so remaining > the rows returned means more follow. At most 1,000. Migrations 115, 142 / SMD-3606.';
