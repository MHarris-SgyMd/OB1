-- =============================================================================
-- Migration 043: the cite shape, stated at the table — query_log.tool's two
--                shapes and what each means, and the table's COMMENT re-issued
--                to name a cite beside fetch/edit/delete (SMD-1749)
-- =============================================================================
--
-- WHY
--   034 gave `query_log.tool` one meaning on an action row: which tool touched
--   the target — `fetch`, `update_thought`, `delete_thought` — and the inline
--   comment beside the column says exactly those three names. SMD-1719 (FORK.md
--   change 90) gave the column a second shape: `<writer>/<pointer>` —
--   `capture_thought/derived_from`, `capture_thought/supersedes`,
--   `update_thought/supersedes` — written when a capture or an edit named the
--   target as its source and the database accepted the pointer (035 writes no
--   pointer on a re-capture, so a re-capture logs none). A plain name is an
--   OPEN: the caller went and looked at, or touched, the row (034's
--   click-through relevance). A slashed name is a CITE: the fact reached a
--   write (MERIT's memory-utilization signal). `evals/utilization.ts` splits
--   the two on the first slash — a non-empty name either side is a cite, a
--   slash at either end is not — so a new writer that cites names itself the
--   same way and is counted without a code change there. Neither this server's
--   tool names nor the MCP tool-name grammar ([A-Za-z0-9._-], the spec's
--   SHOULD, which the SDK enforces as a warning) carry a slash, so the two
--   shapes do not collide here — the server's rule, not a protocol guarantee: a
--   foreign tool logged under a slashed name would read as a cite, and
--   utilization.ts reports a plain name it does not know as unknown
--   (OPEN_TOOLS) rather than folding it in silently.
--
--   The contract lives in server-portable/index.ts's comment beside the writer,
--   evals/utilization.ts's header, evals/README.md and the FORK section. The
--   schema said nothing: 034 wrote no COMMENT ON COLUMN for `tool` at all
--   (the three names are a SQL comment in the file, invisible to a reader of
--   the live table), and its COMMENT ON TABLE says "one per follow-up
--   fetch/edit/delete of a returned id". So a reader of the table — psql's
--   `\d+`, a future writer of action rows, an operator auditing what personal
--   data the table holds — is told three plain names and nothing about the
--   rows a cite writes. 034 is applied and cannot be edited (migrate.ts hashes
--   the file; the ledger would read an edit as drift). The repo's mechanism
--   for stating a contract on a column is a COMMENT in a new migration, as 028
--   (SMD-1052, change 49) did for `thought_work_claims.last_error`. SMD-1719's
--   third review pass proposed it and declined it there as a second mechanism
--   in a PR about a log convention; it travels alone here.
--
-- WHAT
--   * A guard first, 031's shape: on a schema without 034's table, both
--     statements would fail bare ("relation query_log does not exist"). The
--     brain that meets this is one adopted with --baseline whose ledger records
--     034 but whose schema never had it (a guide-built brain, or one baselined
--     and never re-applied); a plain run there, the compose stack's, gates the
--     server and would stop with no remedy named. The file refuses up front
--     naming 034 and --reapply, as 031 does for 015. db/test-upgrade.ts [20]
--     drives it, and drives the same pending file applying once 034's table
--     exists.
--   * COMMENT ON COLUMN query_log.tool — the DATA CONTRACT: on a search row,
--     the search tool; on an action row, one of two shapes — a plain tool name
--     is an open, `<writer>/<pointer>` is a cite — with what each shape means,
--     the three cite values written today, the rule that a value with a
--     non-empty name either side of its first slash is a cite whatever the
--     writer, and where the readers are. Which rows a cite is logged for (a
--     pointer the database accepted, so never a re-capture), which writers
--     cite, and how a cite is attributed to a search are the SERVER's and the
--     READERS' contract and change with them, so the comment points at index.ts
--     and evals/utilization.ts for them rather than restating them.
--   * COMMENT ON TABLE query_log — re-issued with 034's text kept whole and one
--     clause added beside fetch/edit/delete: a write that cited a returned id
--     as its source, naming the shape and the ticket.
--
-- WHAT A SUCCESSOR MUST CARRY
--   A re-issued COMMENT replaces the description. Any migration that
--   re-comments `query_log` or `query_log.tool` and re-issues 034's text would
--   silently drop the cite clause. db/test-schema.ts [42] asserts the LIVE text
--   of both comments after every file has applied — both name
--   `<writer>/<pointer>` — so the drop fails the suite whichever migration
--   causes it. The typed record of what a write cited is SMD-1730's event
--   shape (Phase 1a of SMD-1729); when it lands, the migration that carries it
--   should re-issue this column's comment to point at it.
--
--   No flag and no double dash inside either COMMENT literal: 028 set that
--   convention when test-schema [10]'s scan stripped `--` to end of line;
--   the scan is literal-aware since change 93 (SMD-1796), so nothing depends
--   on it now, and [42] keeps asserting it of the LIVE text as the
--   convention, so a successor's re-issue is held to it too. (The guard's
--   HINT names the two flags, as 030's and 031's do.)
--
-- SAFETY
--   COMMENT ON is idempotent (it replaces the description). No DDL on data,
--   no function body change, no ACL change, no placeholder, no CHECK change:
--   034's `tool <> ''` is the only constraint on the column and a slashed name
--   satisfies it. The export join, the utilization report and the server are
--   unaffected. test-upgrade.ts's shape comparison (columns and function
--   signatures) is unaffected by a comment.
-- =============================================================================

DO $qc$
BEGIN
  IF to_regclass('query_log') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 043 needs 034 (query_log); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

COMMENT ON COLUMN query_log.tool IS
  'Which tool wrote the row. On a search row: the search tool (search, search_thoughts). On an action row, one of two shapes. A plain tool name (fetch, update_thought, delete_thought) is an OPEN: the caller went and looked at, or touched, the target (click-through relevance, SMD-1295). <writer>/<pointer> (capture_thought/derived_from, capture_thought/supersedes, update_thought/supersedes) is a CITE: the writer named the target as its source and the database accepted the pointer (SMD-1719). The rule is the column''s, not one tool''s: any value with a non-empty name either side of its first slash is a cite, whatever the writer, so a new writer that cites names itself <its tool>/<the pointer field> and is counted without a code change; a slash at either end is not a cite. Neither this server''s tool names nor the MCP tool-name grammar ([A-Za-z0-9._-]) carry a slash, so the two shapes do not collide here; a foreign tool logged under a slashed name would be read as a cite, and a plain name the readers do not know is reported as unknown (evals/utilization.ts, OPEN_TOOLS). When a cite is logged (a pointer the database accepted, never a re-capture), which writers cite, and how an action is attributed to a search are the server''s and the readers'' contract, not the column''s: server-portable/index.ts beside the writer and evals/utilization.ts''s header state them. Stated here: SMD-1749.';

COMMENT ON TABLE query_log IS
  'Opt-in (OB1_QUERY_LOG=on), off by default: one row per search call (the query, its arguments, and the ids returned in rank order with scores) and one per follow-up fetch/edit/delete of a returned id, or a write that cited a returned id as its source (the target; the tool is <writer>/<pointer> on a cite, and the tool column''s comment has both shapes, SMD-1719). Personal data at rest — every query typed. Nothing reads it on the hot path; the write is best-effort and never fails a search. An action is linked to its search at export time by (agent_id, target_id, time window), not at write time — there is no request/session token in the handlers. Pruned by prune_query_log(); default retention 30 days (OB1_QUERY_LOG_RETENTION_DAYS).';
