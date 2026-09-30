# 238. The reset guards ask the connection, not the URL, and the libpq tools never parse it — a URL two clients read as two databases is refused, and neither PGDATABASE nor PGSERVICE picks what is dropped (SMD-2317)

**What changed.** `db/connect.ts`'s resolver, reset rule and tool connection,
and their two destructive callers. Two PRs.
- `databaseUrlProblem`, in the resolver every script uses, refuses a URL Bun
  and libpq take to different places: a query key other than `sslmode`,
  `application_name` and `options` (exact case), or one given twice; a `+`,
  or a part libpq refuses (empty, no `=`, a second raw `=`, an `sslmode` in
  capitals); a fragment; an `@` other than the user's; a `,` or `%2C` in the
  host; a path the parser rewrites (a `.`/`..` segment, compared decoded, so
  `/café` stands); whitespace; an inexact scheme. A reason names a query key
  when it is a plain word, and nothing else of the URL.
- The reset rule has a part no override lifts. `identityRefusal` refuses,
  before connecting, a URL the resolver refuses, or one naming no host, no
  database, or no port while `PGPORT` is exported (Bun takes it; measured,
  `dropSchema` dropped a second server's database of the same name).
  `reachedDatabaseRefusal` asks the connection for
  `pg_catalog.current_database()`. `socketRefusal` refuses a unix socket
  unless `OB1_ALLOW_REMOTE_DB=1`, which still lifts the loopback host rule.
- `test-support.ts`: `assertThrowawayDatabase` is async and asks the server;
  `dropSchema` asks on the connection that drops; the five callers await.
- `tier.ts --refresh` checks both URLs before opening either, asks each
  side's server at the guard, and `--to` again on the connection that marks
  and drops. Every `current_database()` on the destructive paths is
  `pg_catalog`'s, since `options=` may set search_path.
- PR 2, `toolTarget`: `pg_dump` and `pg_restore` get a keyword/value
  connection string, the URL's host and port with the server's database and
  login (`session_user`, so a role set after login stays a role), and only `sslmode`, `application_name` and `options` beside. The
  password is in `PGPASSWORD`, off the argv. Their environment keeps only the
  `PG*` variables that authenticate (`TOOL_PG_KEEP`: `PGPASSFILE`, `PGSSL*`,
  `PGCHANNELBINDING`, …); `PGHOST`, `PGHOSTADDR`, `PGPORT`, `PGDATABASE`,
  `PGUSER`, `PGSERVICE`, `PGSERVICEFILE`, `PGOPTIONS` and the rest go. Before
  the mark, `toolReachRefusal` creates a table only this run knows through the
  dropping connection, in a schema of its own (a marked target killed
  mid-reset has no `public`), and requires `pg_dump -t` on `pg_restore`'s
  connection string to find it; else `--to` is left untouched. `pg_dump` must
  be at least both servers' major, since the probe reads `--to`.

**Why.** SMD-2302's review measured three readers of one URL disagreeing:
the rule, Bun 1.4.0, and libpq 17. Bun forwards `?database=`/`?user=` to the
server and follows `?path=` to a socket; an exported `PGDATABASE` beats the
URL's database (`dropSchema(".../canary")` with `PGDATABASE=stable` dropped
stable's tables); libpq has no fragment, ends the user at the first `@`, and
follows `?host=`/`?port=`/`?service=`, `PGHOSTADDR` and `PGSERVICE` (with
`--to …/canary?host=stable-host`, every guard judged canary and `pg_restore`
wrote stable-host). Reconciling the readers by parsing the URL leaked twice
there, and PR 1's two review rounds each found another libpq URL rule the
resolver lacked. So the guards ask the server, and the tools parse no URL.

**Where the ticket's sketch moved.** Through a container's published port
`127.0.0.1:55062` reached a server reporting `inet_server_addr()`
10.88.11.140, port 5432 (podman), so an address-must-be-loopback rule would
refuse every `with-postgres.sh` and CI run, and a tool target built from it is
unreachable. The loopback rule stays on the hostname; the database name and
the probe answer "is this the database you named". `options` is on the
allowlist: `test-upgrade` failed without it, and the fork documents
`options=-c search_path=…` (SETUP.md, preflight, SMD-2238).

**Held.**
- `test-connect.ts` (793 checks on the tree merged with main, hermetic): the refusal table (33
  shapes, each under the override); accepted shapes; the connected half
  against a stand-in; a startup packet off a listener (user, database,
  `application_name`, `options`, and Bun's `client_encoding`/`DateStyle`);
  both `--refresh` sides refused with zero connections; the await census;
  `toolTarget`'s string, quoting, IPv6 host, password and environment
  allowlist; the portless-with-`PGPORT` refusal.
- `test-live` [34] (real server, two scratch databases with `thoughts`
  markers): `PGDATABASE` diverted refuses `dropSchema`,
  `assertThrowawayDatabase` and `refresh()` on either side; a stand-in
  `pg_dump` holds a refresh while `PGDATABASE` changes, and the dropping
  connection refuses; a planted `current_database()` on an `options=` path
  answers neither the check nor the mark; stand-in tools record a connection
  string, not the URL, no password on any argv, and none of six redirecting
  variables exported around them; a `pg_dump` that cannot find the probe's
  table stops the refresh with `--to` whole and nothing left; the tools log
  in as the session user under an `options=` role; a marked target with no
  `public` is reset again; a newer `--to` is refused before anything runs;
  a probe that cannot create its schema refuses before the mark; a leftover
  probe schema is swept. The stand-in `pg_dump` answers the probe only for
  its exact `schema.table`, and otherwise fails as the real one does.
- Real tools (the tier image, `pg_dump` 16): a refresh with `PGHOSTADDR`,
  `PGSERVICE` and `PGOPTIONS` exported copies stable into canary; on main the
  same run failed in `pg_dump` on the service `PGSERVICE` named. A NOLOGIN
  role set through `options=` refreshes; a marked canary with no `public`
  recovers; a `--to` on PostgreSQL 17 is refused in words, untouched.
- 63 mutants, each removing or weakening one check, run on the final tree:
  61 killed (40 by `test-connect`, 21 by [34] — among them the tools handed
  the URL, their process environment, no probe, the probe in `public`, an
  unqualified `-t`, a probe that passes when it cannot create its schema, no
  sweep, `current_user`, `--to`'s major unchecked, the dump named after
  `--to`). Two are equivalent: the environment's `PGPASSWORD` kept over the
  URL's (the URL's always overwrites it), and a probe reading the exit code
  alone (a real `pg_dump` that finds nothing exits 1). Earlier sweeps counted
  the first killed: a scratch copy of [34] left in `db/` tripped
  `test-connect`'s census, not the mutant.

**Review passes.**

| Pass | Finding | Caught | Fix |
|---|---|---|---|
| 1 | `/x/../canary`: canary to Bun, `x/../canary` to libpq; `--refresh` dropped canary, restore failed | cold read, run-it | path the parser rewrites refused |
| 1 | `postgres:///canary` under the override: Bun over TCP, libpq over the socket | cold read | empty host refused |
| 1 | a planted `current_database()` on an `options=` path answered the check | run-it | `pg_catalog`-qualified |
| 1 | `+` in a query value; `%2C` host list; 8 of 31 extra mutants survived | cold read, mutant | refused; rows |
| 2 | `?application_name=x=y`, `?sslmode`, `?&…`, `sslmode=DISABLE`: libpq refuses what Bun reads | run-it | refused |
| 2 | pass 1's path rule refused `/café`; the mark's `current_database()` unqualified | cold read | decoded; `pg_catalog` |
| 2 | `assertThrowawayDatabase`'s probe, lowercase `%2c`, `+` outside the query untested | mutant | rows |
| PR 2, 1 | the tools logged in as `current_user`: an `options=` or `ALTER ROLE … SET role` role was refused | cold read, run-it | `session_user` |
| PR 2, 1 | the probe in `public`: a marked target killed mid-reset could no longer be reset | run-it | own schema |
| PR 2, 1 | a `--to` newer than `pg_dump` refused as "another server" | cold read, run-it | checked up front |
| PR 2, 1 | the recorder row never asserted `--from`'s string; `--no-password` untested | mutant | rows |
| PR 2, 2 | the stand-in `pg_dump` echoed any `-t`, so an unqualified probe passed; real `pg_dump` fails "no matching tables" | run-it | stand-in as real; message mapped |
| PR 2, 2 | the probe's refusal before the mark, the dump's host, a leftover probe schema: untested or unswept | run-it | rows; swept after the mark |

**Not taken.**
- Pinning the URL's database in `openSql` (it split a run across two
  databases, SMD-2302 pass 3); comparing `inet_server_addr()` with loopback.
- `options=-c search_path=x` moving `dropSchema`'s unqualified drops within
  the named database, and objects planted in the target beyond
  `current_database()`: the guards stop an operator's mistake, and whoever
  can write the target can drop it. `tier.ts`'s connections after the drop
  (settle, migrate, stamp) are not re-asked: the checks guard the drop.
- A probe of `--from`: nothing is written there. Its tool connection is the
  URL's host and port with the server's database and user; a name one
  resolver maps to ::1 and the other to 127.0.0.1, with two servers behind
  them, would dump the wrong source into the target, never drop it.

- A portless URL refused under `PGPORT=5432` too (no caller omits the port),
  and the tools' version check reading the full environment (Debian's
  `pg_wrapper` alone would care).

**Follow-ups.** SMD-2312 (`OB1_ALLOW_REMOTE_DB` from a `.env` file) is the
override half of this guard; SMD-2119 asks the same argv hygiene of
`tier.ts`'s `migrate.ts` spawn.
