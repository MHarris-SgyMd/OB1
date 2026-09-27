# 214. The thought-enrichment backfills move onto the SQL shim — the class's first writers, `type`, `sensitivity_tier` and metadata through `.update().eq()`, never content or vector, and the live suite drives all three (SMD-2139)

**What changed.** SMD-2126 sent every maintenance script onto
`compat/supabase-sql`; SMD-2144 landed the two read-only ones. These three are
the first that write — six REST call sites, one file of shared client code.

1. `recipes/thought-enrichment/lib/brain.mjs` (new): the shim's `createClient`
   over `SUPABASE_URL`; `.env.local` beside the scripts under the environment
   (`export`, quotes and a trailing `# comment` read as a shell would); a value
   that is not `postgres://` refused by a line naming its scheme — only when
   `://` follows it — and never the value: the shim's own refusal quotes forty
   characters, which now carry the password (SMD-2263 for the shim); a refused
   query as an `Error` marked `brain`, naming the operation and the SQLSTATE;
   `isTransientDbError` (40001, 40P01, 57P01, class 08, the driver's
   closed-socket and reconnect-failed codes; a refused connection is not one);
   `intFlag` (digits, a safe integer, a floor) and `refuseUnknownFlags`
   (`--dryrun` had run the write; `--limit=2` and a trailing `--limit` passed
   and were ignored, so the run went unbounded); `endWith` closing the pool on
   both paths, a failure one line and exit 1, the stack under `DEBUG`.
   `lib/memory-core.mjs` loses the database fetch timeout.
2. `backfill-type.mjs`: the cursor page is
   `.eq("type", "reference").gt("id", after).order("id").limit(n)`, the first
   with `{ count: "exact" }` (no `head` — the page is read); the write
   `.update({ type }).eq("id", id).select("id")`. The page selects `metadata`
   whole and reads its `type` key in the script — the shim takes no JSON path
   in a select list — a non-string type as its JSON text, as `->>` gave it.
   `--limit N` (the ticket's Verify) stops after N rows written, before the
   next page is read; `Rows processed` counts the rows examined.
3. `backfill-sensitivity.mjs`: the filter is PostgREST's own `or=(…)` through
   `.or()` — the shim reads its empty `eq.` term as the gateway did (probed); a
   refused read or write ends the run (a failed write was counted, the scan went
   on); `--dry-run` beside `--apply` (it wrote under a dry-run banner) is refused.
4. `enrich-thoughts.mjs`: `fetchUnenriched` is `.eq("enriched", false)` with
   the cursor's `.gt()` or `--skip`'s `.range()`; `fetchByIds` `.in()` in
   chunks of fifty; `patchThought` `.update({ ...patch }).eq("id", id)
   .select("id")`, `metadata` bound as an object; `countByEnriched` two head
   counts. A write the database refuses for a structural reason ends the run
   on that row — under `Promise.allSettled` it was a `FAIL` line per row while
   every later row still paid its model call and the run exited 0 — and a run
   that left rows failed exits 1; a model that cannot be reached is such a
   per-row failure, kept for `--retry-failed` (Bun's fetch gives it a code,
   which a test on the code alone read as a refusal), the chunk's checkpoint
   written before a refusal ends the run. `--max-calls` bounds each chunk to
   the calls left (it overshot by up to concurrency − 1; three observed) and
   says ABORTED only when a row was left. A scalar or array `metadata` is kept
   under `prior_metadata`; a checkpoint missing a key takes the default; an id
   that is no uuid names `--reset-state`. `OPENROUTER_BASE_URL` points the
   provider at any OpenAI-compatible endpoint, a local one included;
   `ENRICH_STATE_DIR` moves the checkpoint (default `data/` beside the script),
   made and proven writable first. `--provider` is one of two; numeric flags
   are integers; a value flag's value is required, never after `=`.
5. The `.select("id")` after each `.update()`: without it the shim returns the
   whole row, vector included (probed) — `Prefer: return=minimal`'s purpose.
   Three output lines say "the brain"; the key errors name the environment.
6. README rewritten: `bun`, a checkout, the connection string, a local
   endpoint (Setup 3), the grants each script needs — `SELECT, UPDATE` on
   `thoughts` for the backfills; `SELECT, INSERT` on `thought_audit` too for the
   enrichment, whose metadata change the audit trigger records (probed; the
   capture group's INSERT alone is refused — SMD-2264) — `backfill_thought_types()`
   as the function for the `NULL`-typed rows, `updated_at` as evidence (run
   between re-embed passes), a Security note that the enrichment sends thought
   text to the provider outside the egress gate, Troubleshooting by message.
   `metadata.json` (Bun, an env object). The fork note says the port is a
   stopgap: SMD-1930 re-expresses the three as transforms (the home note).
7. `scripts/check-fork-consistency.ts`: `POSTGREST_EXCEPTIONS` loses the three
   entries — twenty-one files with a call site — and its comments say so;
   `docs/vendored-disposition.md` reads "on the shim (SMD-2139)", 23 in 16;
   `FORK.md`'s hand-port bullet and the shim README's sentence name the three.
8. `db/test-live.ts` [29]: the three scripts driven as deployed — `bun <file>`
   in a directory of their own, `SUPABASE_URL` in the environment — against the
   live database with `enhanced-thoughts`: thirteen planted rows with fingerprint
   and model label, the blank one and the type candidates at known uuids;
   `backfill-type` dry run over five pages of three, `--limit 1` on pages of
   one and on one page, the full run; `backfill-sensitivity` usage, dry run, apply;
   `enrich-thoughts` `--status`, dry run, `--apply --limit 5`, a budget of one at
   concurrency two, `--retry-failed` and a model at a closed port, against a
   `Bun.serve` stub through `OPENROUTER_BASE_URL`, the checkpoint under
   `ENRICH_STATE_DIR`; a LOGIN role
   with SELECT alone refused on the first write of all three; the same role
   with `SELECT, UPDATE` on `thoughts` writing a type, refused metadata on
   `thought_audit`, writing it once granted; ten refusals of exactly one ERROR
   line each, a mistyped scheme's token appearing nowhere. Sixteen assertions (`db/README.md`
   799 → 815); the no-URL case skips under `recipes/thought-enrichment/.env.local`.
9. This record. No migration; `patch`.

**Why.** None of the three reached a brain on this fork, `--dry-run` included
(it reads first). SMD-2126 sends a maintenance script onto the shim; its third
pass corrected the idiom map (`head: true` for a HEAD request alone), which
item 2 follows. The writes are what check 10 permits: transport alone.

**Held.** [29]'s sixteen assertions hold every printed number to the planted
table: every run's counts and pages, the tiers, the blank row's page (one
`[DRY]` line, one call), five rows enriched with four calls and a metadata
object keeping its own keys, the checkpoint at the last id and after the retry,
the recipe's own left as found, the budget bound, the closed-port model's
`FAIL` in `failedIds`, every row's content, fingerprint and model label the
planted ones, a SELECT-only role's three refusals, the grant ladder, ten
refusals of one ERROR line each with the password token absent. Check 24 holds the
three files at zero `rest/v1` lines; the codemod's round trip names three hand
ports — `lib/brain.mjs` the recipe's one importer of the shim. Twenty-two
mutants through the leg, each killed by the assertion its comment names (seven
before the first commit, five in pass 1, four in pass 2 — one survived a bound
and died to an exact count — six in pass 4, teeth for the survivors its audit
found). Unheld, and said so: the env-file loader's spellings, `prior_metadata`,
the checkpoint default and the `--reset-state` hint, `--provider`/`--concurrency`
refusals, a non-string type's JSON text, `3D000` and `28P01`, `ENRICH_MAX_CALLS`,
the `.select("id")` narrowing, the status head counts (the same output either
way), a model's 5xx retries, the closed-socket retry, the pool's close (Bun 1.4
ends the process without it). The walkthrough reader drove most by hand.

**Review passes.** The `caught` column is the commit bullet's tag; pass 3's two reads were a definitions trace and a maintainer's read.

| pass | finding | caught | fix |
| --- | --- | --- | --- |
| 1 | the leg's dry-run assertion assumed the blank row was not among the two lowest uuids — a 1-in-6 flake — and asserted an operator's own checkpoint absent | cold-read | b4ecf5a0 |
| 1 | `enrich-thoughts.mjs`'s refused write was one `FAIL` line per row under `allSettled`, every later row paid its call, exit 0 — while README and record said one line and exit 1; the checkpoint had moved to the cwd; `isTransientDbError` named class 08 for a code Bun does not send | run-it | b4ecf5a0 |
| 1 | the README's `SELECT, UPDATE ON thoughts` was not enough for the enrichment: a metadata change fires the audit trigger, which reads and writes `thought_audit` — probed, the grants written, a grant ladder in the leg (SMD-2264); `backfill_thought_types()` called the script's twin — it covers `type IS NULL` | cold-read | b4ecf5a0 |
| 1 | the shim's refusal quoted forty characters of `SUPABASE_URL` — since this port the password (SMD-2263); `--dry-run --apply` wrote; `--concurrency 0` spun forever; `--max-calls 1` at 20 made three calls; scalar `metadata` spread to digits; a checkpoint without `failedIds` a TypeError; `--dryrun` ran the write; `Rows processed` overcounted a stopped page | run-it | b4ecf5a0 |
| 2 | `--limit=2` and a trailing `--limit` passed the new refusal and were ignored — the run went unbounded; `connect()` named the first colon token of a scheme-less value (the user name, or the password); `--limit N` scanned on to the next candidate, every page between read for nothing; a checkpoint directory that was a file failed after the first chunk's writes; ABORTED printed when the budget met the table's end | run-it | pass 2 |
| 2 | a model at a closed port ended the run — Bun's fetch error carries a code, and the rule tested the code, not the database's mark — while the record said a model's error stays per-row; the review table's `caught` cells disagreed with the commit tags on three rows; the Unheld list read as complete; `metadata.json` lacked `ENRICH_STATE_DIR` and `DEBUG`; the README lacked `28P01`, the model's `FAIL`, the `=` rule, the dry run's `OK` lines; "four output lines" were three | walkthrough | 5db9cec0 |
| 3 | every write moves `updated_at` (001's trigger), which this fork's accepted-vector caveat and label rule read as evidence — the README says to run between re-embed passes; a refusal's rethrow dropped the chunk's checkpoint deltas (the checkpoint is written first); the 57P01 note named the wrong follower; two `caught` cells spelled the mechanism with a space | cold-read | pass 3 |
| 3 | twenty "(review pass N, …)" tags in the recipe's comments narrated history the commit tags and this table carry (stripped; the defect clauses stay); the hand ports' scaffolding is in its third copy (SMD-2268 filed, before SMD-2140 makes a fourth); `metadata.json`'s services one prose string; the leg's number and the headline collide with main's — the merge's job | cold-read | fdb56c8c |
| 4 | nine of twenty-two mutants survived the leg: a refused connection counted transient walked the ladder to the same line; a retried id stayed in `failedIds`; the personal check before the restricted; the tripping row counted; the chunk ignoring its budget; `intFlag` taking `1.5`; and "one line" meant "at least one" — six teeth (a both-pattern row, a budget run, `--limit 1.5`, a page count, the checkpoint re-read, no `[retry]`) and every refusal counted to exactly one ERROR line; three rightly unheld (`.select("id")`, head counts, `prior_metadata`) | mutant | f3d517bd |
| 4 | the codemod's docblock named two hand ports where there are three; the pool-close comment claimed idle connections hold the process, which Bun 1.4 does not bear out (SMD-2144 saw it once — the close stays as hygiene); a relative `ENRICH_STATE_DIR` outside the recipe's `data/` is not gitignored — the README says to keep it there | cold-read | f3d517bd |

**Not taken.** The REST retry ladders on every error — 429 and 5xx have no
Postgres analogue; the transient classes keep the ladder. A database fetch
timeout — the race would abandon a write in flight. An Anthropic base URL — the
default provider has the seam. Keeping a scalar `metadata` — the enrichment
writes an object; the old value rides under one key. Aligning the scripts'
no-flag behaviour (write / usage / refuse) — upstream's; the Verify leans on it.

**Follow-ups.** SMD-2263 (the shim's refusal), SMD-2264 (the capture grants),
SMD-2268 (the hand ports' shared scaffolding, before SMD-2140), SMD-1930 (the
runner); the ports SMD-2140–2143, 2145 and SMD-2021's backfill.

**Upstream status.** Upstream keeps all three on PostgREST.
