# 216. Preflight's remedies for a refusal or a hidden column: the `schema` row reads the SQLSTATE, three column checks read `pg_attribute`, the `vector extension` row prints the `schema` row's statement (SMD-2238)

**What changed.**

- **The `schema` row** picks its remedy by the count's SQLSTATE, never its message or severity, which a server's `lc_messages` translates:
  - **3D000**, the database the connection names is not there: correct the database name in `$DATABASE_URL`, or create it and apply the migrations. It was "Apply the migrations" alone, since `/does not exist|relation/` took any "does not exist". That regex now backs up 42P01 itself, which a translated message missed.
  - **42501 at connection** (no CONNECT on the database, a parameter or `options=` setting in the connection string the role may not make, a PostgreSQL 17 login trigger): named as a refusal at connection, with `GRANT CONNECT ON DATABASE` for the connection string's database and user. The probe tells it apart: its query needs no privilege, so a 42501 on it is the connection's.
  - **28000**, the role refused before any query (it does not exist under trust auth, may not log in, or pg_hba.conf has no line for it): check the role in `$DATABASE_URL`. Under a password a missing role reads as 28P01, like a wrong password, and keeps "Check credentials and network reachability".
  - **42501 without SELECT on `public.thoughts`**: `GRANT SELECT ON public.thoughts TO <role>;`, or `migrate.ts --grant <role>` (shell-quoted) for every privilege the server's role needs. It was "Check credentials and network reachability". With the probe unable to answer a query's 42501, the row still names the grant, or the policy that refuses it.
  - **42501 with `row_security` off** on a table with row-level security: Postgres refuses the read rather than skip the policies; the row says so, with `BYPASSRLS` for a role that should read every row.
  - **42P01, or 42501 with SELECT held, while `public.thoughts` resolves**: the failing read is one the count reaches, a row-level security policy on the table. The row names the policies a SELECT by this role meets (`FOR SELECT` or `ALL`, to `PUBLIC` or a role it has the privileges of). It was "Apply the migrations" (42P01) or the network (42501).
  - **Another schema's `thoughts` first on the path**, in any of these: another tool's table, never granted on. The row says to put `public` ahead of that schema on the connection's path (naming it as the default path's `"$user"` when the path holds `$user` and the schema is `current_user`'s, which `$user` expands to), and without `public.thoughts` to do that and then migrate: the migrator's `CREATE TABLE IF NOT EXISTS thoughts` is unqualified too, and would find the other table.

  SMD-2242's probe answers the catalog cases: it runs on 42P01 or 42501 and now also reads the relation `thoughts` resolves to and its schema, the role's SELECT on it, `row_security`, and the policies.
- **`audit events`, `chunk context` and `vector models`** read their columns from `pg_attribute`, scoped to `public`, where they read `information_schema.columns`. That view shows a role none of a table's columns unless it holds a privilege on the table, so:
  - a role with SELECT on `thoughts` alone was told `thought_audit` lacked all eight of 046's columns, and to re-apply 046;
  - a role without SELECT on `thoughts` was told `embedding_model` did not exist, and to re-apply 021;
  - with `OB1_CHUNK_CONTEXT` on, a role without privileges on `thought_chunks` was told to apply 013.

  Now each row finds the columns and meets the refusal where it reads the table, in words it already had: the census skip naming the grant, or "could not verify: permission denied".
- **The `vector extension` row** (the second PR) prints the `schema` row's statement, pgvector's schema added. It printed `ALTER ROLE <current_user> SET search_path = "$user", public, <schema>`, or the same on the database: a plain setting, outranked by the role's own in the database; the role a login's settings SET ROLE to, whose settings never load; the role's path replaced by a fixed one; `public` twice with pgvector in `public`; and an `ALTER ROLE` where the connection string sets the path, which outranks it. It also said "then put it on the path" to a role with no USAGE whose path already held the schema.
  - `search-path.ts`'s `withPublic` takes pgvector's schema: the role's schemas kept in order, `public` where it stands or last, then that schema, once and only when off the path. It keeps `public` in place where SMD-2242's version moved it last; no reachable path statement differs, since the `schema` row prints one only when `public` is off the path.
  - `pathFix` is the `schema` row's source-aware statement, moved there: `ALTER ROLE <session_user> IN DATABASE`, `SET ROLE NONE;` first under SET ROLE, the `options=` value for source `client`, a caveat for `session` or unread. Both rows call it.
  - The `schema` row's probe reads pgvector's schema when the type does not resolve and passes it, so with both off the path the two rows print one path statement, which, run, puts both on the path; a missing USAGE on pgvector's schema is the vector row's GRANT.
  - The vector row reads the path, `session_user` and the source, and asks for the path only while the schema is off it.

**Why.** SMD-2062's review passes ran preflight as several roles against a migrated brain. Each of these shapes got a remedy that would re-run migrations on a current schema, or send the operator to check the network over a missing grant.

**Held.** test-preflight, 23 assertions added:

- **A database that is not there**, named in the connection string: the row names it and the connection string.
- **A NOLOGIN role:** the row names the role. Given LOGIN, with `options=-crole%3Dpg_monitor`, which it may not set, the row names the refusal at connection, not the table's grant. With CONNECT revoked from it and `PUBLIC`, the row prints `GRANT CONNECT ON DATABASE "<db>" TO "pf_nologin";`, which, run, lets it in: what fails next is the table's grant.
- **A role with SELECT on `thoughts` alone** (pf_reader): `audit events` finds 046's columns and names the refused census read; `vector models` finds 021's column; with `OB1_CHUNK_CONTEXT` on, `chunk context` says it could not verify, and names no 013.
- **No SELECT on `thoughts`**, `public` on the path: the row prints the GRANT and the `--grant` form, and `vector models` names the refused read, not 021's column missing. The printed GRANT, run, makes the row pass. With `CONNECTION LIMIT 1`, so the probe gets no connection, the row still names the grant.
- **`pf_reader.thoughts` ahead of `public`** under the default `"$user", public`, unreadable: the row names it as `"$user"` and prints no GRANT on it; with the path naming `pf_reader` itself, no `"$user"` note. With no USAGE on `public` as well, the GRANT USAGE comes first. Both, run as printed with `public` put ahead, make the row pass.
- **Unmigrated, with `pf_stray.thoughts` first** on the path of a role that may not read it: `public` put ahead, then the migrations, never a GRANT on it.
- **A role named `pf reader's`:** `--grant` is printed shell-quoted, and the command, run through `sh` as printed with the owner's connection string put in, grants it.
- **An RLS policy calling a function that reads a missing table** (SMD-2242's leg): the row names `pf_rls` and a restrictive `PUBLIC` policy, not one `FOR INSERT` or one `TO pg_monitor`, and not the migrations.
- **An RLS policy calling a function the role may not execute:** 42501 with SELECT held names the policies, not a GRANT on `thoughts`.
- **`row_security` off:** the row names it; the printed `BYPASSRLS`, run, makes the count read.

The second PR: test-preflight 5 more, db/test-search-path 7 more.
- **[4b]:** `withPublic` keeps `public` in place and adds pgvector's schema once, never `public` twice, never one on the path; `pathFix` for each source and under SET ROLE.
- **pgvector in `public` off the path** (pf_reader at `nowhere`, and as a login that SETs ROLE): the vector row prints the `schema` row's statement, `public` once, and both rows say to reconnect.
- **db/test-search-path, pgvector in `ext`:**
  - [4] prints `ALTER ROLE <login> IN DATABASE <db> SET search_path = "$user", public, "ext";` and no `ALTER DATABASE`, the remedy line held exactly; [6] runs it as printed over an hnsw bound on the same row, which it keeps, and preflight passes.
  - [5] a role with no USAGE gets the GRANT and the path, or the GRANT and the `options=` value where the connection string sets the path; the path run, the GRANT alone; both run, the type resolves.
  - [5b] a path in the connection string gets the `options=` value, which, put in place, resolves the type.
  - [5c] with `public` off the path too, both rows print one `options=` value, which puts both on the path.

**Measured after.** Thirty mutants against test-preflight, all run on the first PR's final tree: twenty-eight killed, two not killable here.
- **Killed, this change:**
  - the audit, chunk and label column reads each back on information_schema;
  - 3D000 not told apart; 28000 not told apart; 42501 not probed; the 42501 fallback dropped;
  - SELECT held not checked; a resolving thoughts not named; the policies not named; `--grant`'s argument never shell-quoted;
  - another schema's thoughts not told apart; the brain's table missing behind it not told apart; its USAGE grant dropped;
  - `row_security` off not told apart; policies for other commands named; policies for other roles named; `PUBLIC`'s policies not named; the plural not counted;
  - a 42501 at connection not told apart; the probe's error not kept; the migrate remedy behind another schema's thoughts without `public` put ahead; `"$user"` not named; `"$user"` named without `$user` on the path.
- **Killed, SMD-2242's probe, re-run over the restructured block:** thoughts resolving not checked; the `ALTER ROLE` naming `current_user`; the connection string not told apart; the caveat dropped when the source is unread.
- **Not killed:**
  - SMD-2242's "USAGE held not taken as off the path", equivalent as there;
  - the migrate fallback not keyed on 42P01, equivalent on an English server, where the message regex matches too. The test image has no other locale.

  A condition dropped along the way, the policies read only while row-level security is on, was equivalent: with it off, a count on a table reaches nothing else, and a view carries no policies.

The second PR: twenty mutants against test-preflight and db/test-search-path together, all killed — in `search-path.ts`, `public` moved last or quoted, pgvector's schema added as `public`, added though on the path, or never; `pathFix`'s connection string not told apart, the role named for the login, `SET ROLE NONE` dropped, a plain `ALTER ROLE`, the caveat dropped; in preflight, the `schema` row leaving pgvector's schema out, the vector row naming `current_user`, not checking the path, never reading the source, or leaving its schema out; each "Then reconnect." dropped; the GRANT and a connection-string path back in the chained form; a `RESET ALL` after the statement.

test-preflight 556 beside test-upgrade 386, as CI runs them; db/test-search-path 32; PG16.

**Review passes.**

| Pass | Finding | Caught | Fix |
| --- | --- | --- | --- |
| 1 | The GRANT and policy branches took any `thoughts` that resolved: another tool's table first on the path got a GRANT that, run, passed the row against it, and an unmigrated database with one was never told to migrate (both reviewers) | run-it | those branches act on `public.thoughts` alone; another schema's is named |
| 1 | The probe failing (no connection for it) sent 42501 back to "check credentials and network" | run-it | a 42501 fallback naming the grant or the policy |
| 1 | Every policy on the table was named, for any command or role | run-it | the policies a SELECT by this role meets |
| 1 | `row_security` off got the policy remedy, which cannot fix it | run-it | named, with `BYPASSRLS` |
| 2 | Pass 1's 42501 fallback named the table's grant for a refusal at connection (no CONNECT, a setting in `options=` the role may not make), which neither grant fixes (both reviewers) | run-it | severity FATAL told apart, named as the connection's |
| 2 | Pass 1's "migrate" behind another schema's thoughts, run as printed, failed on 001 and left the ledger in that schema: the migrator's `CREATE TABLE IF NOT EXISTS thoughts` found the other table | run-it | put `public` ahead, then migrate |
| 3 | Pass 2's refusal at connection read the error's severity, which Bun reports as the server's translated word: on a server with Russian, Chinese or Polish messages the table's grant came back (both reviewers) | run-it | the probe's own 42501 tells it |
| 3 | Pass 2's `"$user"` note fired on the schema matching either role, whatever the path said; `$user` is `current_user` | run-it | `current_user`, and only with `$user` on the path |

**Not taken.**

- **A missing role under password auth.** Postgres answers 28P01, the same as a wrong password, so the row cannot tell them apart; "check credentials" covers both.
- **Reading which relation a policy's function reads.** The row names the policy; the error Postgres printed names the relation or function.
- **A count that succeeds against another tool's `thoughts`** first on the path, which a role that may read it (a superuser) meets: the row passes, and the rows after it read the wrong table. No count fails, so nothing here runs; it is a check of its own.
- **The exact statement for putting `public` ahead** of another schema: it would reorder the role's path for that tool's names too, a choice the operator makes.
- **The `schema version` row behind another schema's thoughts** on an unmigrated database still says "Apply the migrations", which the `schema` row above it says to do after putting `public` ahead. It predates this change.
- **The statement copies the session's path.** Where that path is the database's (`ALTER DATABASE … SET search_path`), the role's setting in the database stores a copy, and a later change to the database's path no longer reaches this role here. It is right when printed, and the old `ALTER DATABASE` advice replaced the database's path outright.
- **pgvector's schema reached only through `"$user"`** (named for the role) reads as off the path, so the statement names it too: redundant, and it resolves either way.
- **The migrator pinning `public` for its own session,** so an unmigrated database with another schema first on the path migrates where the server reads. `db/migrate.ts`'s search-path handling is SMD-2247's.

**Boyscout.** No behaviour change: test-preflight's pf_reader legs build the role's connection string once, as `readerUrl` beside the role's creation, where eleven runs spelled it inline and the one definition came after them. In the second PR, db/test-search-path's connection strings with an `options=` value come from one `withOptions` helper, where four legs each chose `?` or `&` and spelled it inline.

**Follow-ups.** SMD-2247 widened: the migrator's unqualified `CREATE TABLE IF NOT EXISTS thoughts` finds another schema's table first on its path.
