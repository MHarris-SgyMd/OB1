// Whether a db/ tool may state priorities through migration 116 (SMD-3666):
// the ingestion pipeline (ingest-records.ts) and board-sync (sync-linear.ts)
// ask it once at start, and a brain or role that cannot take them is said once
// while the run goes on, the priorities staying as facets.
//
// 116's writers are SECURITY INVOKER with PUBLIC's EXECUTE, so EXECUTE alone
// says nothing: a role without the priority grant group fails the first write
// (42501), which would end the record's transaction and the run with it
// (review pass 2). So the tables the group grants are asked, read from
// config.mjs's own definition of the group, so the two cannot drift.

import type { SQL } from "bun";
import { ROLE_GRANTS } from "./config.mjs";

/** 116's two writers, by signature. */
export const PRIORITY_WRITERS = ["assert_priority(text, text, integer, timestamptz, timestamptz, text, text, text, boolean, jsonb)", "clear_priority(text, text, jsonb)"] as const;

/** The priority grant group's privileges, table by table, as config.mjs grants them. */
const GROUP = ROLE_GRANTS.priority as readonly { table: string; privileges: readonly string[] }[];

/**
 * Null when this brain has 116's writers and this role holds every privilege the priority group grants; else why
 * not, with the way out: the migration to apply, or the group to grant naming the first privilege missing.
 */
export async function priorityWritersProblem(sql: SQL): Promise<string | null> {
  // Each writer by its own parameter: Bun binds a JS array as one comma-joined string, which no text[] cast reads.
  const [assertFn, clearFn] = PRIORITY_WRITERS;
  const [r] = (await sql`SELECT to_regprocedure(${assertFn}) IS NOT NULL AND to_regprocedure(${clearFn}) IS NOT NULL AS ok`) as { ok: boolean }[];
  if (!r?.ok) return "migration 116 is not applied on this brain (cd db && bun migrate.ts --url …)";
  for (const { table, privileges } of GROUP) {
    for (const privilege of privileges) {
      // A table this brain has not got (117's, on a brain at 116) is not the role's to lack. A CASE, as OR evaluates
      // in no promised order, and has_table_privilege raises for a table that is not there.
      const [g] = (await sql`SELECT CASE WHEN to_regclass(${table}) IS NULL THEN true ELSE has_table_privilege(${table}, ${privilege}) END AS ok`) as { ok: boolean }[];
      if (!g?.ok) return `this role lacks ${privilege} on ${table} (the priority grant group: cd db && bun migrate.ts --url … --grant <role> --groups priority)`;
    }
  }
  return null;
}
