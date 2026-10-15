-- =============================================================================
-- Migration 092: pg_stat_statements, where the server offers it — each SQL
--                statement's calls and times, for the observability profile's
--                exporter (SMD-1849 PR 3b)
-- =============================================================================
--
-- WHY
--   The servers' spans name each store operation (db.operation.name, PR 2d),
--   one span per operation, never its SQL: no query's text is read there. What
--   each statement costs inside Postgres — calls, total and mean time, rows,
--   shared blocks hit and read — is pg_stat_statements', and the observability
--   profile's postgres_exporter reads it (deploy/compose.yaml's pg-exporter,
--   as ob1_monitor, a member of pg_monitor alone) into the collector beside
--   the spans.
--
--   The view needs its library loaded at the server's start
--   (shared_preload_libraries): deploy/compose.yaml's postgres, and each tier's
--   in compose.tiers.yaml, start with it, with track_utility off, so a utility
--   statement (ALTER ROLE … PASSWORD among them) is never recorded with its
--   text, and track_io_timing on, so the blocks' read and write times are
--   counted rather than 0. A server that has the extension but not the
--   library answers a read of the view "must be loaded via
--   shared_preload_libraries", which nothing in the brain reads; the
--   exporter's collector says so in its own log.
--
-- WHAT
--   CREATE EXTENSION pg_stat_statements, in public as vector and pg_trgm are,
--   only where pg_available_extensions lists it and it is not already there:
--   a managed Postgres without contrib, or one that keeps extensions to an
--   allow-list, goes on without it, and every brain migrates the same.
--   Nothing in the brain's schema depends on it. It is not a trusted
--   extension, so creating it needs a superuser: a migrator that is not one
--   (insufficient_privilege), or a server that refuses it
--   (feature_not_supported), leaves it out with a WARNING, and migrate.ts
--   says so on the run that applies this file.
--
--   Its two views (pg_stat_statements, pg_stat_statements_info) and the
--   functions behind them come readable by PUBLIC; here they are revoked
--   from PUBLIC and granted to pg_monitor alone, whose member ob1_monitor the
--   exporter reads as. So no other role reaches them but a superuser: not a
--   role --grant gives the servers or the workers, and not the plugins'
--   login role, whose privileges on the core are the plugin boundary
--   (preflight's "plugin tables" row, test-plugins-sql) — where this file's
--   role may change their grants; where it may not, migrate.ts says so. A
--   statement's text and queryid are a member of pg_read_all_stats's
--   (pg_monitor holds it) or a superuser's, as Postgres has it. The names are
--   read where the extension is, so one created earlier in another schema is
--   held the same, and only those that exist: an extension older than 1.9,
--   left behind by a pg_upgrade, has no pg_stat_statements_info.
--
--   A restore without privileges (a tier refresh's pg_restore -x) creates the
--   extension again with PUBLIC's grants, under a ledger that already records
--   this file; so migrate.ts reads those grants on every plain run and runs this
--   file again where PUBLIC holds one. A role that does not own the objects
--   may not change their grants: Postgres refuses it with a warning where the
--   role holds a grant itself and an error where it holds none, and either is
--   kept to a warning here, with the grants as they were, which migrate.ts
--   reads the same way and says. Two migrators creating it at once: the
--   second confines the first's.
-- =============================================================================

DO $$
DECLARE
  ns text;
  obj text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_stat_statements') THEN
      RETURN;
    END IF;
    BEGIN
      CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
    EXCEPTION
      WHEN insufficient_privilege OR feature_not_supported THEN
        RAISE WARNING 'pg_stat_statements left out: %', SQLERRM;
        RETURN;
      WHEN unique_violation THEN
        NULL; -- another migrator created it a moment ago: confine that one
    END;
  END IF;
  SELECT n.nspname INTO ns FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_stat_statements';
  IF ns IS NULL THEN
    RETURN;
  END IF;
  -- A role that neither owns the objects nor holds a grant on them, or holds
  -- no USAGE on their schema, is refused with an error: kept to a warning, as
  -- a REVOKE by a non-owner that holds one is, and the run goes on.
  BEGIN
    FOREACH obj IN ARRAY ARRAY['pg_stat_statements', 'pg_stat_statements_info'] LOOP
      IF to_regclass(format('%I.%I', ns, obj)) IS NOT NULL THEN
        EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC', ns, obj);
        EXECUTE format('GRANT SELECT ON %I.%I TO pg_monitor', ns, obj);
      END IF;
    END LOOP;
    FOREACH obj IN ARRAY ARRAY['pg_stat_statements(boolean)', 'pg_stat_statements_info()'] LOOP
      IF to_regprocedure(format('%I.%s', ns, obj)) IS NOT NULL THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC', ns, obj);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO pg_monitor', ns, obj);
      END IF;
    END LOOP;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE WARNING 'pg_stat_statements'' grants left as they were: %', SQLERRM;
  END;
END
$$;
