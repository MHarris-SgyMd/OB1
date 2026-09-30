# 232. The migrator and the tier refresh read a search_path with preflight's parser (SMD-2247)

**What changed.**

- **`searchPathSchemas`** (SMD-2242's parser for Postgres's SplitIdentifierString, fuzzed against Postgres there) moves from `server-portable/search-path.ts` to `db/config.mjs`, and `search-path.ts` re-exports it. The migrator's image copies `db/` files alone, so the parser has to live there for the migrator to use it.
- **`db/migrate.ts`**: before 021, `applyShadowed` sets the path for the transaction to itself without `pg_temp`, so that a temporary view shadows the claim table. It split the path on commas outside quotes, `trim()`med each entry and dropped any entry matching `/^"?pg_temp"?$/i`. Two readings differed from Postgres:
  - `trim()` strips a non-breaking space, U+3000, U+2028 and the BOM. Postgres counts only space, tab, newline, carriage return and form feed as whitespace (vertical tab too from 17). So `x,<NBSP>public`, whose second entry is a schema literally named `<NBSP>public`, became `x, public`.
  - The case-blind match dropped a quoted `"PG_TEMP"`, which is another schema, because quoting keeps case.

  It now calls `setPathWithoutTemp(tx)` (config.mjs), the step itself: it reads the path and `server_version_num`, parses the path with `searchPathSchemas`, drops `pg_temp` by its parsed name (an unquoted `PG_TEMP` and a quoted `"pg_temp"` go, `"PG_TEMP"` stays), quotes each name that is left, sets the result for the transaction and returns the path it read. It lives in config.mjs so that db/test-search-path runs the step itself against Postgres, not a copy of it.
- **`db/tier.ts`**: a refresh copies `--from`'s database settings onto `--to`, and it split each list setting itself: it dropped only a space and kept case. So a path stored raw by `ALTER DATABASE … SET search_path FROM CURRENT`, such as `NoWhere,<tab>public`, came back as `"NoWhere", "<tab>public"`, two other schemas. `databaseSettings` now reads `search_path` and `temp_tablespaces`, the two lists Postgres parses as identifiers, with `searchPathSchemas` under the source server's version, and quotes each name. For `temp_tablespaces` it keeps an empty entry, `""`, which there is the database's default tablespace, one of the list's members; `search_path`'s reading drops it, since it names no schema. `applyDatabaseSettings` splits that text as before and writes each list element as an `E''` string literal, where it wrote a quoted identifier: `""` is no identifier, and Postgres stores a literal element as it would the identifier, except that a literal is not cut to 63 bytes. An `E''` literal reads the same whatever the session's `standard_conforming_strings`; a plain `'…'` one reads a backslash as an escape with it off, which a second refresh's session has when the source sets it. Scalar settings are written the same way, which they were not on main either. The other four list settings keep their split. Their write changes with the rest, which fixes one thing: a `session_preload_libraries` or `local_preload_libraries` path over 63 bytes was copied cut short.

**Why.** SMD-2242's review passes found both splitters: the migrator's in pass 1, `tier.ts`'s in pass 7. A raw path reaches them only from a connection string, `set_config`, `FROM CURRENT` or postgresql.conf. The migrator's rewrite lasts only for 021's transaction, as [7] holds.

**Held.**

- **db/test-search-path [7]:** `setPathWithoutTemp`, run in a transaction on a session whose path is stored raw as `"$user",<NBSP>public, "PG_TEMP", PG_TEMP, "pg_temp", "a""b"`, returns that path and sets `"$user", "<NBSP>public", "PG_TEMP", "a""b"`. Postgres resolves the result to the same schemas as the raw path, and the real `public` is not among them. After the transaction the session's path is the raw one again.
- **test-upgrade's pg_temp-last leg** (021 and 030 pending, the path listing `pg_temp` last) still labels through the view, and fails if the migrator stops calling the step.
- **test-live, the refresh's settings leg:** a source path stored with `FROM CURRENT` as `NoWhere,<tab>public, "Kept", "a\b"` is read as `"nowhere", "public", "Kept", "a\b"` and stored on the target, whose session runs with `standard_conforming_strings` off, as `nowhere, public, "Kept", "a\b"`; a `temp_tablespaces` stored as `"", PG_DEFAULT` is stored on the target as `"", pg_default`; a scalar `C:\temp` is copied as written; a path set to the empty list is copied as the empty list. The existing byte-for-byte leg still holds.
- **test-preflight [4b]:** `keepEmpty` keeps a list's empty entry, which a path's reading drops.

**Measured after.** Seven mutants:
- **Killed (six):**
  - `pg_temp` matched case-blind again;
  - a non-breaking space counted as whitespace;
  - the rebuilt path left unquoted;
  - the migrator setting the path with `pg_temp` still in it;
  - `tier.ts` reading the path literally again;
  - the source's read not re-spelled.
- **Removed (the seventh):** a second parse in `applyDatabaseSettings` survived as equivalent, because it only ever saw the quoted text `databaseSettings` returns. The branch was taken out, which leaves one parse point.

Review pass 1's mutants, seven more: six killed — the migrator's call site back to the hand splitter; its version hard-coded; the helper quoting without doubling a `"`; `temp_tablespaces` read as before; its empty entry dropped; list elements written as quoted identifiers again. One survived: `tier.ts` passing a hard-coded version, since every suite runs on one PG16 server (below).

Review pass 2's mutants, six: five killed — plain `'…'` literals again (the backslash under `standard_conforming_strings` off); the empty list written as a quoted empty identifier; the migrator's version hard-coded with its read left in a comment; a second path setting after the helper's; `keepEmpty` ignored. The sixth, the migrator's call reflowed over two lines, passes, as a change of layout should.

Review pass 3's mutants, seven: five killed — the rewrite set for the session, not the transaction; `pg_temp` matched case-blind; quotes not doubled; the migrator no longer calling the step; the scalar written as a plain literal. Two survive, both named under Not taken: the step's version hard-coded (one PG16 server), and the old splitter inlined at the migrator's call site.

test-preflight 579 beside test-upgrade 480, as CI runs them, on the tree with main merged; db/test-search-path 35; test-live 910; PG16.

**Review passes.**

| Pass | Finding | Caught | Fix |
| --- | --- | --- | --- |
| 1 | `temp_tablespaces`' empty entry, the database's default tablespace, was dropped by the path's reading: `"", ts` copied as `ts`, moving every temp file there, where main failed the refresh on it | run-it | kept for `temp_tablespaces`, list elements written as string literals |
| 1 | The migrator's call site was held by nothing: the old splitter put back passed every suite | mutant | [7] reads the call from `migrate.ts`'s source |
| 1 | `temp_tablespaces` as an identifier list, and the helper's quote doubling, were held by nothing | mutant | a raw `temp_tablespaces` in test-live, a name holding a `"` in [7] |
| 1 | The fragment's counts predated the merge of main; config.mjs's `quoteIdent` was documented as a database name's | cold-read | counts measured on the merged tree; the doc names schemas and tablespaces too |
| 2 | Pass 1's plain `'…'` literals read a backslash as an escape in a session with `standard_conforming_strings` off, which a second refresh's has when the source sets it: `a\b` copied as a backspace, a tablespace ending in `\` failing the refresh, where main's quoted identifiers copied both | run-it | `E''` literals |
| 2 | The fragment said no end-to-end run tells the splitters apart; a fresh database with `"PG_TEMP"` ahead of `public` does, at 021. [7]'s source check failed on a reflowed call and passed a hard-coded version left beside a commented read, or a second path setting | mutant | the claim corrected; the check scoped to `applyShadowed`, comment lines left out, whitespace-tolerant, one path setting in the migrator |
| 2 | The empty-list write was reached by no test once `temp_tablespaces` kept its `""`; `keepEmpty` had no unit case; the literal switch's 63-byte fix went unmentioned | mutant | a path set to the empty list copied; [4b]'s case; the fragment credits it |
| 3 | Pass 2's source check failed on code meaning the same (a reordered column, a trailing comment, prose naming `SET search_path` in a message) and passed real reverts (a local function of the helper's name, a path setting on a `*`-led line); "nothing else in the migrator sets a path" missed `alignVectorSearchPath`'s append (both reviewers) | mutant | the check removed: the step moves into config.mjs as `setPathWithoutTemp`, which [7] runs against Postgres in a transaction |
| 3 | The scalar backslash fix was held by no test; "the rewrite lasts only for 021's transaction" was held by nothing | mutant | a scalar `C:\temp` copied onto the `standard_conforming_strings`-off target; [7] reads the session's path after the transaction |

**Not taken.**

- **The other four list settings** in `tier.ts` (the preload libraries and `unix_socket_directories`) are directory and library lists, which Postgres splits differently (SplitDirectoriesString or SplitGUCList). They keep the old split.
- **The version, tested on one server.** `setPathWithoutTemp` reading the server's version, and `tier.ts` reading an identifier list under the source's version, not the target's, matter only where a vertical tab separates on one and not the other (PostgreSQL 17 against 16). CI runs PG16 alone, so it is held by review, not a suite; run by hand, PG17 to PG16 and back copies the names each source read.
- **The migrator's call site, held by review.** Its one line, `const path = await setPathWithoutTemp(tx);`, is held against being dropped (test-upgrade's pg_temp-last leg) but not against an old splitter inlined in its place, which no run tells apart once the second PR puts `public` first. Reading the migrator's source for it was tried in pass 2 and removed in pass 3: it failed on code meaning the same and passed real reverts.
- **A path naming the session's own temp schema as `pg_temp_N`.** Postgres resolves it to the temp schema, and the migrator keeps it, as main's did: listed first, 021's functions would go there. Which `pg_temp_N` a backend gets is not known before it connects.
- **The migrator's own path** (its ledger's `3F000` under a path without `public`, and a `"$user"` schema ahead of `public` taking the build) is the second PR's.

**The second PR: the migrator puts `public` first on its own session.**

- **What changed.** Every migration and the ledger are unqualified, so they land in the first schema on the migrating session's path and find the first table of a name.
  - With another schema first, the build went there, or failed on another tool's `thoughts` there: 001's `CREATE TABLE IF NOT EXISTS thoughts` found that table. That schema could be the default path's `"$user"` (a schema named for the role), or one from a connection string's `options=` or a role's setting.
  - With no schema on the path at all, the ledger's `CREATE` failed with `3F000`. That is the `--baseline` preflight's ledger row offers, run over `options=-csearch_path=nowhere`.

  `pinPublicFirst` (config.mjs) runs before the ledger is created, and before `--grant`'s statements, which are unqualified too. It puts `public` first for the session (`set_config(…, false)`, as `alignVectorSearchPath` does), with the rest of the path after it, read with `searchPathSchemas`, so an extension's schema on the path still resolves. It lasts for this run alone: the run's printed line says so, and that the server's connection keeps its own path, which preflight's `schema` row judges. It does not change the path where `public` is already the first schema Postgres searches. It refuses, exit 2, before any SQL of the migrator's own:
  - **A brain elsewhere:** a schema on the path other than `public` holds this migrator's ledger (`schema_migrations` with `name` and `sha256`), and `public` holds no brain: that ledger and `thoughts` beside it. An empty ledger alone in `public`, which `--dry-run` or a first run failed at 001 leaves, is none. Building on would start a second brain in `public`. Every schema the path resolves to is read, so another tool's `schema_migrations` (Rails', Ecto's) neither hides a brain behind it nor counts as one, and a brain behind an empty `public` first refuses too; on main that built a second brain. The refusal says so in words and prints no statement: take that schema off the path if it is another brain, or, if it is this brain, move it into `public` by hand, as the owner of both schemas, minding whatever else `public` holds. It names a schema reached through the default path's `"$user"` as such, as preflight does. `--grant` is refused alike, in its own words. `--baseline`, which adopts a brain built by hand, takes `public.thoughts` alone as the brain there, as its own guard does.
  - **No `public`:** there is no schema `public`, and the run names `CREATE SCHEMA public;`.
  - **No USAGE:** the role has no USAGE on `public`, which Postgres leaves off its path. The run names the database's owner (or a member of it) to run as, and the GRANT that lets this role build there. Either way, 001's `vector` needs a superuser unless it is installed: pgvector is untrusted. 011's `pg_trgm` needs CREATE on the database, which its owner has. `--grant` is told to run as the objects' owner, and, with no `public`, to create it and apply the migrations first.

  The catalog is read through `pg_class` and `pg_attribute`, not `to_regclass`, which needs USAGE on the schema. Preflight's remedy for another tool's `thoughts` first on an unmigrated database says to apply the migrations, which build in `public`, and to put `public` ahead for the server, which reads the first `thoughts` on its path. It used to say the migrator's `CREATE TABLE IF NOT EXISTS thoughts` would otherwise find the other table, which is no longer so.
- **Held.** test-upgrade [23]:
  - A path naming no schema: `public` is put first, the run says so for this run only, every migration applies, and the ledger and `thoughts` are in `public`. A run with `public` already first says nothing.
  - `tu_ahead.thoughts` first on the path: the brain is built in `public`, and `tu_ahead` keeps its one table. `--grant` under that path grants on `public`'s objects; unpinned, its check after the GRANTs failed.
  - `pg_trgm` in `tu_ext`, the path `tu_ext` alone: every migration applies, and 011 finds the operator class there.
  - A `--dry-run` then a plain run on a fresh database builds in `public`. With the brain there, another schema's ledger of this shape on the path refuses nothing, nor stops `--baseline` adopting `public`'s `thoughts` with no ledger yet.
  - A real brain, its schema renamed `tu_brain`, `public` empty: refused in words, no statement printed, nothing created in `public`. Refused alike behind another tool's ledger first on the path, behind `public` first, and over the empty ledger a `--dry-run` left in `public`, and where `public` holds a `thoughts` but no ledger. `--grant` refused there in its own words. Renamed to the role's own name, under the default path: named as the path's `"$user"`.
  - Another tool's ledger (a `version` column, and a `name` but no `sha256`) beside an app's `thoughts`: no brain, left alone, and the brain is built in `public`.
  - `public` renamed away: refused, naming `CREATE SCHEMA public`, with no ledger anywhere.
  - A role without USAGE on `public`: refused, naming the database's owner, the GRANT and what each extension needs; `--grant` as that role, refused in its own words. The GRANT, run as printed, lets the role build in `public`. `--grant` with `public` renamed away: refused in its own words.

  [22]'s off-path `--baseline` leg now records its ledger in `public`, not in the off-path schema. test-preflight's stray-`thoughts` leg holds the new remedy.
- **Measured after.** Nine mutants against test-upgrade, all killed, before review:
  - never pinning;
  - `public` put last;
  - the rest of the path dropped;
  - the ledger guard dropped;
  - any foreign ledger refused;
  - `public` not re-checked after the pin;
  - "missing" and "no USAGE" swapped;
  - the migrator ignoring a refusal;
  - no pin before the ledger.

  Review pass 1's mutants, seven:
  - **Killed (six):** only the first schema on the path read; the ledger's shape not checked; the guard skipped where `public` is first; `--grant` not pinning; the owner not named; the printed line claiming more than the run.
  - **The seventh:** it asked for a `thoughts` beside the ledger, and survived as equivalent: the ledger's shape tells it from another tool's alone. The condition was dropped.

  The earlier mutants still standing were re-run on the new guard, all killed.

  Review pass 2's mutants, six, all killed: an empty ledger in `public` counted as a brain; either column making a ledger; `--grant` ignoring a refusal; `--grant` worded as the build; the guard run with a brain in `public`; the refusal printing the rename again.

  Review pass 3's mutants, seven, all killed: `public`'s `thoughts` alone taken as a brain; `--grant`'s no-USAGE and missing-`public` refusals worded as the build's; the extension caveat put back; the scan counting `public`; `--baseline` not adopting; the `"$user"` note never given.

  test-preflight 585 beside test-upgrade 525, as CI runs them, on the tree with main merged; db/test-search-path 35; test-live 934; PG16.
- **Review passes.**

  | Pass | Finding | Caught | Fix |
  | --- | --- | --- | --- |
  | 1 | The printed line said the brain is built "where preflight reads it", but the pin is this run's alone: under the same connection string, preflight and the server still read the old path | run-it | "for this run only", and the server's path named as preflight's `schema` row's to fix |
  | 1 | The guard read only the first `schema_migrations` a name resolved to: another tool's earlier on the path hid a brain behind it, a Rails-shaped ledger beside an app's `thoughts` refused as a brain, and one in `public` skipped the guard (both reviewers) | run-it | every schema on the path read; this migrator's ledger known by its `name` and `sha256` columns |
  | 1 | "Move that brain's tables into public", taken literally, left its functions and extensions behind, and the guard then passed a broken brain | run-it | the schema-rename pair printed, and run as printed in [23]; or take the schema off the path |
  | 1 | The no-USAGE GRANT, run as printed by a role that does not own the database, built to 010 and failed at 011's `pg_trgm` | run-it | the database's owner named first; the GRANT's limit said |
  | 1 | `--grant` ran unpinned: its unqualified GRANTs named another schema's `thoughts` first on the path, and its check then failed the grant | cold-read | `--grant` pins too |
  | 1 | An empty path printed as `""`; the docblock said a refusal changed nothing; the fragment's counts predated the merge of main; [23]'s role setup ran outside its `try` | cold-read | fixed |
  | 2 | Pass 1's printed rename moved everything else `public` held — another app's tables on a shared database — into `public_empty`; pasted into psql it ran as two statements, and as the database's owner the second failed on a schema that owner did not own, leaving no `public`; it stuck where `public_empty` existed (both reviewers) | run-it | the rename cut: the refusal names the two ways on in words, and prints no statement |
  | 2 | An empty ledger in `public` — a `--dry-run`'s, or a first run's failed at 001 — counted as the brain there, and the guard let a second brain be built beside the real one, where main went on with it (both reviewers) | run-it | `public` holds a brain only with `thoughts` beside its ledger |
  | 3 | The no-USAGE caveat said the database's owner can create 001's `vector`: pgvector 0.8.6 is untrusted, and followed as printed the run failed at 001 (both reviewers) | run-it | a superuser for `vector` unless installed; the owner's CREATE for `pg_trgm` |
  | 3 | Pass 2's public test, ledger and `thoughts` both, refused a `--baseline` adoption of a hand-built brain that main made, with "public holds none" | run-it | `--baseline` takes `public.thoughts` alone; "holds no brain" |
  | 3 | The refusal named a brain in the role's own schema without saying the path reaches it as `"$user"`, which the operator does not see | run-it | named as the path's `"$user"`, as preflight does |
  | 3 | `--grant`'s no-USAGE and missing-`public` refusals, and the extension caveat, were held by nothing, though the PR said they were; `--grant` with no `public` was told to run again, which grants on nothing; the ledger half of the public test and the scan's skipping of `public` were unheld in test-upgrade | mutant | each given a leg; the grant told to apply the migrations first |
  | 2 | `--grant`'s refusals spoke of starting a second brain and of building; the no-USAGE caveat named 011 where 001's `vector` comes first, and a NOLOGIN owner with no word of membership; a `name`-only ledger, the exemption for a brain in `public`, and "Nothing was changed." on the missing-`public` refusal were held by nothing | run-it | `--grant`'s own words; 001 named, "or a role that is a member of it"; each given a leg |

- **Not taken.**
  - **A brain off the path** (in a schema the path does not name) is not seen, as on main: a second is built in `public`.
  - **Another tool's `schema_migrations` in `public`** fails the ledger's reads, as on main.
  - **The `--dry-run` that still creates the ledger** is SMD-2291's.
  - **A brain in a schema on the path this role has no USAGE on** is not read: `current_schemas` leaves it out, as Postgres's resolution does. As on main, the run then builds in `public`, until a privilege it lacks stops it.
  - **A role with USAGE but no CREATE on `public`** (a non-owner on PostgreSQL 15 and later) still meets a raw permission error at the ledger's `CREATE`, as on main. A refusal for it would be another mechanism.
  - **Moving a brain into `public`** is not scripted: which statements are safe turns on what else `public` holds and who owns what, which the operator knows and the migrator does not.
