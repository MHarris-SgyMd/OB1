# 62. A capturing role's grants are documented and checked for the whole capture path, not `thoughts` alone — one list, a widened preflight check, and `migrate.ts --grant` (SMD-1226)

Every function this fork adds is `SECURITY INVOKER` (the policy 010, 012 and 015
state, and the default the capture writers in 005/007/008/022/025 rely on), so
the writes they make run as the connecting role — and since 007 they reach past
`thoughts`: a windowed capture INSERTs `thought_chunks` (and since 022 DELETEs
them on a re-capture the label does not vouch for), an edit with content replaces
those rows, and 008's trigger INSERTs `thought_audit` on every capture. A role
granted `SELECT, INSERT, UPDATE, DELETE ON thoughts` alone — exactly what the
getting-started guide's grant step gives — therefore captures **nothing** on a
self-hosted brain: its first windowed capture fails on `thought_chunks`, its
first capture of any kind on the audit trigger. Upstream never hit it because
Supabase's `service_role` holds default privileges on the public schema; the
non-Supabase path is where it bites. Found by change 58's (SMD-1175's) review
passes, when 022 added a DELETE to the 3-argument path and the privilege class
surfaced — the gap for the audit and chunk-insert writers predated it.

`db/config.mjs`'s `ROLE_GRANTS` is now the single spelling: the tables and
privileges the fork's writers need, grouped by role (`capture`, `server`, `worker`,
`extraction`), each naming the migration that introduced it. Three consumers read
it, so none can drift from the others:

* Preflight's **`write privileges`** check (renamed from `chunk delete privilege`,
  which checked DELETE on `thought_chunks` alone) reads `CAPTURE_WRITES` — the
  `capture` group flattened — and refuses a server role missing any of it,
  naming each missing privilege in `ROLE_GRANTS` order with its GRANT (quoted
  role, schema-qualified `has_table_privilege`, gated on table presence so a
  brain before 007/008 is a skip not a raise). It stays a refusal: a role that
  cannot INSERT `thought_audit` fails every capture. One conditional addition
  (found by the second and third review passes): 016 adds a trigger on `thoughts`
  that runs as the caller on every capture and content-edit — it reads
  `ob1_config` always, and upserts a `thought_work_claims` row while
  `entity_extraction_key` is set. So the check reads `pg_trigger`: when the
  trigger is present it folds `ob1_config` SELECT into the refusal set (a role
  without it fails every capture in the trigger, even with extraction off), and
  when the key is set it adds `thought_work_claims` INSERT/UPDATE too. A server
  role that never runs a worker is thus refused at start-up on an extraction
  brain instead of being blessed and then failing every capture. The `server`
  group
  (`ob1_config` read, and the agent tables — `resolve_agent` is SECURITY INVOKER
  and *upserts* them, so they get the writes, not just `SELECT`, which the
  ticket's own list had wrong) is documented and granted but not enforced:
  attribution and preflight's config read degrade to a warn without it, not a
  failed capture. Over PostgREST it is a skip, as the old check
  was: table privileges are read over a direct connection.
* **`migrate.ts --grant <role>`** issues the whole documented set — `USAGE ON
  SCHEMA public` plus every group, for the tables that exist — in one
  transaction. Guarded like `--baseline`: it records nothing in the ledger and is
  refused beside `--baseline`/`--reapply`. It never creates a role or sets a
  password (a missing role is an error naming `CREATE ROLE`), so no credential
  passes through it; `--grant --dry-run` prints the statements for a role you
  would rather grant by hand. There are no sequences to grant — every table's
  primary key is a `uuid` or a natural key.
* **`db/README.md`**'s "Grants for a capturing role" is the human table, and the
  getting-started guide's grant step points a self-hoster at it. A
  check-fork-consistency check (the config↔docs parity check beside change 58's
  check 7) asserts the README names every table `ROLE_GRANTS` requires, in
  backticks, so a table added to a group in config without a README line fails
  CI rather than a self-hoster's first capture.

No schema, migration or runtime-server change — a documentation, preflight and
migrator change. `test-preflight.ts [5]` proves it end to end: a role with
`thoughts` and `SELECT` everywhere is refused, each missing write named with its
GRANT; after `migrate.ts --grant` a real windowed capture and an edit with
content run through the role, its chunk and audit rows landing.

Upstream status: **not applicable** — a self-hosting concern the Supabase path
does not have. **Unfiled** upstream. Reproduce: on a migrated brain, `CREATE ROLE
r LOGIN; GRANT SELECT, INSERT, UPDATE, DELETE ON thoughts TO r; GRANT SELECT ON
ALL TABLES IN SCHEMA public TO r;` then run preflight as `r` (refused, naming the
chunk and audit writes), `bun db/migrate.ts --grant r` (granted), preflight again
(ok), and a windowed `upsert_thought` through `r`.
