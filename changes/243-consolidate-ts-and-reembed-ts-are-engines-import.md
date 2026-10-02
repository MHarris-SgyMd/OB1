# 243. consolidate.ts and reembed.ts are engines: import one and call run(); the workers' numbers held to what the database takes — PRs 3–5 of 5 (SMD-2304 / 2134)

**What changed.** SMD-2134's fourth cut, PRs 3–5; change 240 has PRs 1–2
(the migrator and extract-entities.ts, the Writer, `PassStop`,
`stopOnSignals`, `sleepUnless`).
- `consolidate.ts`'s `run(opts: ConsolidateOptions)` is the CLI's run: the
  pass, --status, --dry-run and the review modes (--list, --accept,
  --reject, --stale). Numbers (`k`, `minSim`, `minConfidence`, `stale` beside
  extract's) are held to the CLI's rules in its order and words, the lease
  pair between them. The review flags' own rules — which combine, a --list
  word, a proposal id, the pass's note marker — are `reviewProblem`, an
  exported pure function the CLI (before it opens its client, where the
  script refused them) and run() both refuse through. A run or a decision
  with a worker key needs `url` beside a caller's `sql`, naming the database
  `sql` is on (nothing checks that). The judge takes an AbortSignal, so the
  hard stop also aborts the call in hand and run() returns at once. A
  decision writes, and stops under an aborted signal as a run does ("stopped
  before the decision was written"); --list and --stale only read. A Writer's
  throw inside a thought's work (the "not settled" line of a raced stale row)
  is marked and rethrown, so run() rejects rather than record it as the
  thought's failure.
- `reembed.ts`'s `run(opts: ReembedOptions)` is the CLI's run: the pass,
  --status, --dry-run, --retire and --accept-failed (`acceptFailed`, the ids;
  `[]` for the flag alone). --workers and --batch are held first, --ttl and
  --heartbeat after the embedding configuration, where the script read them;
  the CLI hands run() the number it read (`cli.ts`'s `numberIn`, readNumber's
  shape), so a command breaking two rules is refused for the one it always
  was. The modes' rule — one thing at a time, --all only with --accept-failed
  — is `modeProblem`, refused by the CLI before its client and by run(). The
  model and width come from `env` by config.mjs's rules (`embeddingContract`,
  which over process.env returns the module's constants), so the key, the
  checks and the vectors name one model. No worker key, so a caller's `sql`
  needs no `url`. --retire and --accept-failed write, and stop under an
  aborted signal before their write ("stopped before --retire wrote
  anything"); the hard stop abandons the row in hand once its call returns
  (the embedder takes no signal: OB1_LLM_TIMEOUT a call; a database
  statement waiting on a lock has no bound, and a vector already sent
  lands). The
  embedder's own lines (a fallback to the head window, a blurb refused) go
  through the Writer — `createEmbedder` takes a `log`, stderr when absent,
  latched per call so a throw stops that call's other lines — and a
  Writer's throw inside processRow (those lines, a legacy twin's
  "duplicates" line) rejects run(). A blank `job`, `retire` or id is refused
  in the scanner's words. Every maintenance refusal is returned as run()'s
  code, and test-engines counts that.
- Both: a caller's `sql` needs workers + 1 connections and is refused as a
  reserved connection or a transaction's handle; extract's stop wiring
  (`onPass` where `process.on` was, a caller's AbortSignal a first stop and
  aborted before the pass a stop before its next write, the hard stop
  writing and releasing nothing more for the thought in hand, 130).
  `cli.ts`'s `numberProblem` judges an in-process number by value in the
  scanner's words, and readNumber builds its refusal through it (320 inputs
  measured the same as before); `lease.ts` holds STOPPED_EARLY for the
  engines, and a heartbeat that fails after its worker has stopped is no
  longer reported (extract's and consolidate's too). The Writer contract
  says its calls are synchronous.
- PR 5, bounds measured on a real server and held by the scanner's own
  `max` (the CLI and run() refuse at the flag, in its words): `--batch` ≤
  `MAX_BATCH` (lease.ts, 2147483647: claim_thoughts' p_batch is an int, so a
  larger one matched no signature, the workers stopped with the pool
  untouched and the dry run had accepted it); `--timeout` ≤
  `MAX_CALL_TIMEOUT_S` (worker-bootstrap.ts, 9007199254740: the call's
  AbortSignal.timeout throws past 2^53 − 1 ms, and extract marked every
  thought failed); `--stale` ≤ `MAX_STALE_DAYS` (consolidate.ts, 2000000
  days: now() minus 3,000,000 is before 4714 BC, out of range, and 2,000,000
  stays inside as now() moves on); `--workers` ≤ `MAX_WORKERS` (lease.ts,
  2147483647: a connection each and a spare, Bun's pool max of 2^31).
  `--limit` is not bounded: it never reaches SQL, and 2^53 − 1 runs.

**Behaviour against main's CLI.** Masked: consolidate the same on 83 of 90
stub-judge cases (the rest races on both sides, an unmasked timestamp), 47
edge cases, 120 flag pairs, 447 of 462 pre-connection cases; reembed on 304
of 328 over eight environments; PR 5 changes only the bounded refusals. The rest are `?sslmode=bogus` beside flags
that refuse nothing before the client: exit 1 with connect.ts's refusal and
no banner, where main printed the banner and refused later (on the egress
gate, a configuration, a malformed --ttl) — change 240's case for extract.
As there: the hard stop's grace writes nothing, a follower's first signal
exits at once, and a signal after run() settles ends the process by it.

**Held.** test-engines: both in the census; consolidate's 26 refusals and
reembed's 24 against the spawned CLI, stream by stream, before connecting
(every number and their order, the lease pair, every review and mode rule, a
blank value, each bound in its own words and counted, the gate under a model
from env, a rule beside a URL Bun's client rejects); `reviewProblem`,
`modeProblem`, `numberProblem` and `numberIn` units; `embeddingContract`
against config.mjs's constants under five environments; the embedder's `log`
over a loopback stub; MAX_CALL_TIMEOUT_S at AbortSignal.timeout's edge; the
client rules; under an aborted signal, a decision, --retire and
--accept-failed stopped and a listing, --status and a dry run read. test-live
[16] and [9]: run() in-process beside the spawned dry run, `--status` (on
reembed, with no --job too: the env's model's own key), the no-op run on a
URL and on a caller's client, and refusals, byte for byte per stream; on
fresh pools, an AbortSignal's stop, the hard stop (consolidate's back within
1.5 s; reembed's writing no vector for the row in hand), the CLI's one and
two SIGINTs, start-up aborts at each write, a decision, --retire and
--accept-failed aborted before theirs, the listener gone after run(), and a
throwing Writer in a worker, on the freed line and inside processRow;
reembed's embedder lines in the Writer, not the host's console; a hard stop
while update_thought waits on an edit's lock sending nothing after its
STALE_READ; consolidate's hard stop in a 503 pause and its follower woken;
MAX_BATCH and MAX_STALE_DAYS against Postgres's own limits. [10] and
[16]: a throwing Writer throws once (thrown on every progress line, the other
worker stopped on its own 3 s later and the rule went untested), and the
follower cases fail at 10 s rather than hang the suite. Every fix has its
mutant killed.

**Review passes.** A cold reader and a run-it reviewer each pass.

| PR | Pass | Finding | Caught | Fix |
|---|---|---|---|---|
| 3 | 1 | nothing above low; a Writer throwing inside processRow was recorded as the thought's failure; a decision under an aborted signal still wrote | cold read, run-it | the throw marked and rethrown; a decision stops as a run does |
| 3 | 2 | nothing above low; a decision beside --dry-run under an abort connected first; a stopped decision spoke of a pass | cold read | one `writes` rule; the decision's own line |
| 3 | 3 | nothing above low on a fresh look; with `?sslmode=bogus` a bad --list exited 1; two fixes held on extract alone | cold read, run-it | the CLI refuses the review flags before its client; both held here |
| 3 | 4 | nothing above low, the stop signal | cold read, run-it | comments rewrapped |
| 4 | 1 | the embedder's lines bypassed the Writer in-process; a hard stop during a stale re-read sent the text again; a blank `job` pooled under '' | cold read, run-it | a `log` for the embedder; the check at each attempt; blanks refused |
| 4 | 2 | nothing above low, the stop signal: a log throw's sibling lines still written; the embedder's rethrow and the attempt check untested | cold read, run-it | the log latched per call; both held |
| 4 | 3 | nothing above low on a fresh look (lifecycle, concurrent runs, 53 flag cases, timing all main's); a hard stop racing a release said "lapsed"; the hard stop's bound overstated | cold read | no lapse reported after a hard stop; the bound said |
| 4 | 4 | nothing above low across the shared modules' other consumers (extract's and consolidate's heartbeats, 508 numeric flags, the server's captures); pass 3's check undercounted a release that won the race | cold read, run-it | the check on the lapse alone |
| 5 | 1 | each bound works at its value and refuses one past; a bound dropped from both paths passed the tests; --workers past 2^31 crashed blaming the URL | cold read, run-it | each bound case names its refusal; --workers bounded |
| 5 | 2 | nothing above low, the stop signal: the fragment's counts; a renamed bound case would skip its words | cold read | the counts; the bound cases counted |

Left, measured: a first stop during a provider-error pause fails the thought
(main's code, SMD-2401); `--accept <id> --dry-run` writes the decision
(main's code, SMD-2405); 99 or more workers take every connection before the
key's own (main's too), and tens of thousands of workers stall opening
their pool. In reembed's run(): after a throwing Writer a first
stop reads as the hard one; a Writer throw on an embedder line from a row
already failed is dropped; an abort while the summary prints returns 130
(main's SIGINT too); the hard stop's line still says "second signal". In
extract's and consolidate's: a blank `job` (extract) or `dump` is not
refused, and a hard stop racing a release still reads as a lapse (SMD-2425).

**Done.** SMD-2304's five PRs: the migrator and the three claim workers are
engines, and their numbers are held to what the database and the runtime
take.
