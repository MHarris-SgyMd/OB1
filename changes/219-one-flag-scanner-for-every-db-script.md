# 219. One flag scanner for every db/ script — a mistyped flag on a worker is refused, not run as the default (SMD-2134 / 2015)

**What changed.** `db/cli.ts` is the one argument scanner, declared per script as
a table of what each flag takes — `none`, `one`, `two`, `optional`, `many` or
`repeated` — and run before anything else: before a database URL is resolved, a
model is called or a row is claimed. It refuses, with exit 2, the script's
flag list and its note, a flag the script does not have; one given twice
(except a `repeated` one); one that takes a value followed by nothing, by
another flag or by a blank; a value joined with `=`; a bare `--` after the first
argument (Bun consumes one given first); and a value where no flag takes one
beyond the positionals the script declares. A refusal never repeats what the
operator typed — it names the script's flags and, for an argument no flag
accounts for, its position among the script's own arguments (`unknown argument
4`) — since an argument can be a password or a key and a refusal is printed to
a log; the scripts' own checks of a value a flag takes as-is keep the rule too
(reembed's `--accept-failed` ids, consolidate's `--list` word,
graph-centrality's `--types`/`--status`, which name what is allowed). A flag read
only beside another is refused alone: hnsw-graph's `--table` without `--index`,
consolidate's `--note` without `--accept`/`--reject`. `--help` prints the list and exits 0. `int`/`number` read
decimal digits only (graph-centrality's rule, now everyone's, sync-linear's
`--interval` included): `Number()` read `0x10`, `1e2` and `" 7"`, and past 2^53
an integer is refused rather than rounded. `tier.ts --compare` now replays the
`--query` values before a `--queries-file`'s lines, not in argv order. Twenty-one
entry points moved onto it — the three claim workers, `migrate.ts`,
`ingest-records.ts`, `sync-linear.ts`, `tier.ts` (the SQL verbs and
`--compare`), `graph-centrality.ts` (its pure `parseArgs` now scans with
`scanArgs`), `hnsw-graph.ts`, the seven benches, `measure-1288.ts`, the three
ingest libraries' `--self-check`, and `rebuild.ts`, which SMD-1732 (#223)
landed on `main` during review with `flag()`/`has()` lookups — an unknown flag
ignored — and test-cli's census caught at the merge. The
scripts keep their own checks of what the values mean after the scan. The
migrator image copies `cli.ts` beside `migrate.ts` (`db/Dockerfile`,
`.dockerignore`, `release.yml`'s paths), and so does the orchestration import
runner's image (`deploy/orchestration/runner.Dockerfile`, SMD-2212, merged during
review), whose `ingest-records.ts` and `reembed.ts` now import it — without the
line the runner's first ingest would fail to load; `ingest-records.ts`'s new
`--actor` is in its table, and its refusal names the label rule, not the value.

**Why.** Five parsers. `extract-entities.ts` and `consolidate.ts` looked flags up
with `flag()`/`has()` over argv, so `--K 10`, `--minsim 0.5` or `--worker 4` ran
the shipped default and exited 0 — SMD-1713's run-it review found it by handing
the worker a nonsense flag and watching the numbers not move (SMD-2015); their
`flag()` also read `--url --dry-run` as the URL `"--dry-run"`, and a trailing
`--dump` as no dump. `migrate.ts`, `ingest-records.ts`, `tier.ts` and
`sync-linear.ts` carried copies of one scanner that refused (migrate.ts's header:
"the two are not yet one function"), `reembed.ts` a larger variant, and
`hnsw-graph.ts` and the benches ignored anything but the flag they looked for.
The three numeric helpers had three signatures, and reembed's read a missing
value as the default.

**Held.** `db/test-cli.ts` (241 checks, no database, CI's replay-gate job): the
scanner's rules as pure functions, among them fifteen shapes an operator can put
a secret in (`--url=…`, `--a-keySECRET`, `NAME=secret`, a libpq DSN, a key where
no flag takes it, the argument after a flag) each refused without it, and
graph-centrality's own checks likewise; that every entry point — a file with an
`import.meta.main` guard, or a shebang and no exports — imports `./cli.ts` and
no other file reads `process.argv`; and each entry point run with `--bogus-flag`
(exit 2, the refusal its first line) and `--help` (exit 0), plus the SMD-2015
typos, seven value flags given bare, the documented bare
`--follow`/`--stale`/`--list` and fractional `--min-sim`, the dependent-flag
refusals and the no-echo cases run for real. Forty-four mutants of `cli.ts` and
the scripts' tables and checks, run on the final tree, each fail it (1 to 33
checks each). Pass 3's run-it reviewer put a marker in every position a refusal
could name across the twenty entry points then (1,070 runs): the scanner printed it
in none. The existing
refusal assertions (test-live's reembed strays and `--job --switch-model`,
test-upgrade's migrator, test-brain-compare's `--compare` grammar, test-schema's
graph-centrality) run against the scanner's wording.

**Review passes.**

| Pass | Finding | Caught | Fix |
|---|---|---|---|
| 1 | a missing value's refusal echoed the next argument whole — `--grant --url=postgres://u:PASSWORD@…` printed the password | cold read, run-it | the argument shown by the `=`/URL rule |
| 1 | a stray value was echoed unless it held `://`; tier's `--compare` parser never echoed one, so a key typed there reached the log | cold read, run-it | strays counted, named only where a script opts in |
| 1 | a bare `--` was a positional, so graph-centrality took it as the subject | cold read | refused everywhere |
| 1 | sync-linear's `--interval` still read by `Number()`; a many flag took `""`; an integer past 2^53 was rounded | cold read | the digits rule, the empty rule, `Number.isSafeInteger` |
| 2 | pass 1's masking leaked three shapes it did not name — a key glued to a flag (`--a-keySECRET`), `NAME=secret` and a DSN among opted-in strays, graph-centrality's own subject list — the third seam in one mechanism | cold read | a refusal names positions and the script's flags, never an argument; the nearest flag for a typo |
| 2 | a blank value passed the empty rule and read as absent downstream (`--interval " "`); the 2^53 check pre-empted the range message | cold read | blank is empty; range first |
| 2 | the documented bare `--follow`/`--stale` and the fractional `--min-sim` were held by no suite, nor six scanner rules (a two flag's second value, twice on optional/two, `in` for `hasOwn`, inclusive bounds) | run-it, mutant | teeth for each |
| 2 | reembed's stray refusal lost where ids go; `--compare`'s scanner refusals lost its usage | cold read, run-it | a script's note prints with every refusal |
| 3 | pass 2's "did you mean" pointed whole-word typos at write flags (`--retry` → `--retire`, `--apply` → `--reapply`, `--json` → `--job`) — a review-pass mechanism's first seam | cold read, run-it | removed; the flag list is the answer |
| 3 | the scripts' own checks repeated a value a flag takes as-is — reembed's ids (a URL taken as a second id), consolidate's `--list` word, graph-centrality's `--types`/`--status` | cold read | each names what is allowed |
| 3 | hnsw-graph's `--table` and consolidate's `--note` accepted and dropped when their partner flag was absent (SMD-2015's kind) | cold read | refused alone |
| 3 | reembed's note printed under every refusal; six value flags given bare, `=` on an optional flag, three positions, `--help` anywhere and a single-dash many/optional value held by no suite | cold read, run-it, mutant | the hint beside `--accept-failed`; teeth for each |

**Not taken.** Renaming graph-centrality's `--status <lifecycle>` so `--status`
means a report everywhere: it is a value flag the scanner reads as such, and
three change records and the operator's habit name it. A per-script
`--status`/`--dry-run` contract is the engines' (SMD-2134's later cuts), not the
scanner's. An int4 bound on `--stale`/`--batch`/`--limit` (a value past
2,147,483,647 fails at the SQL call, as before this change; lease.ts bounds
`--ttl`/`--heartbeat`). A "did you mean" for a typo (pass 2 added it, pass 3
found it pointing at write flags; the flag list is printed with every refusal).
Output that prints what was asked for — graph-centrality's report of its
subject, the workers' `job:` banner, ingest-records' "no such file" — is not a
refusal and keeps the value. Positions behind `deploy/tier.sh`, which appends
`--from`/`--to`, count tier.ts's own arguments.

**Follow-ups.** The rest of SMD-2134, one PR each: the connection module (URL
resolution, one loopback guard where `tier.ts` and `test-support.ts` disagree on
an empty host and `0.0.0.0`, close-then-exit where `hnsw-graph.ts` and `tier.ts`'s
replay/diff exit inside the `try`), the worker bootstrap (egress banner and gate,
the `OB1_WORKER_KEY` identity block, `classifyError`), and importable engines.
