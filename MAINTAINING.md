# MAINTAINING.md — how Daemonic Brain is versioned, released, deployed and checked

Daemonic Brain grew out of [Open Brain](https://github.com/NateBJones-Projects/OB1):
it began as a fork of that tree at `9543c29` (2026-08-30), and has been a
project in its own right since 2026-11-04 (SMD-3765). It takes nothing further
from upstream and keeps no parity. [`FORK.md`](FORK.md) is the record of the fork era: the pin,
changes 1–17, the detach and how rebases ran.

This file is for whoever changes the code: the version scheme and what it
covers, cutting a release, the one deployment, CI and its checks, how a review
pass records what it caught, and the issues left open on purpose.
[`README.md`](README.md) is the front door for a reader and
[`SETUP.md`](SETUP.md) for an operator. The record of every change from 18 on is
one file under [`changes/`](changes/README.md), indexed there.

---

## Versioning

Daemonic Brain ships continuously from `main`, so for a long time nothing named
what shipped: one tag (the upstream pin, FORK.md's "The pin"), no releases,
and a brain identified only by the highest migration its ledger recorded. The
version scheme (SMD-1804) gives it a name:

```
MAJOR.MINOR.PATCH
```

Plain SemVer from 2.0.0 (SMD-3317). The releases before it, 1.0.0 to 1.9.0,
carried the upstream pin as build metadata (`1.0.0+upstream.9543c29`). The pin is
frozen now (SMD-1256), so the version no longer spells it: FORK.md's "The pin" names
it once, and each release goes on recording it as data, in `releases.json`'s
`upstream` key and the release notes' "upstream pin" line. The two forms order by
their cores (build metadata takes no part). The bump is chosen by the
contracts the project already enforces — the rules are here, and checked, not
remembered:

- **MAJOR** — a change a client sees. One of these:
  - A migration changes a shipped function's signature or return shape so that
    a positional call resolves to another form or to none, or a reader that
    takes columns by position reads something else (020's `match_thoughts`,
    014's sentinel).
  - A shipped table, column or index a client can see is dropped or renamed.
  - The MCP tool surface changes incompatibly: a tool removed, or an argument's
    meaning changed.
  - A command a shipped image runs loses a flag or a named value, or one changes
    meaning: `ob1-migrate`'s `migrate.ts` flags and its `--groups` names, for
    example (SMD-3325 retires `--baseline` this way).
  - A URL, route, port, transport or setting stops answering, where something
    inside the version contract (below) gives it to a configured client. The
    origin root that the proxy's `/mcp` replaced closed this way with 2.0.0
    (SMD-2306, SMD-2532).

  A client written against `N.x` keeps working on `N.y`. A URL it was given goes
  only after a release has said so on every answer, in a `Deprecation` header,
  and a cut removes it no sooner than two weeks after that release (SMD-3057).
- **MINOR** — an additive migration (a new function; a new column with
  `IF NOT EXISTS`; an index swapped under the same names), a new tool, a new
  worker, a new preflight check, or a surface marked deprecated (SemVer §7;
  the root URL's `Deprecation` header, SMD-2306). A shipped function changed
  only additively is a MINOR too — a trailing parameter with a default, a
  trailing output column, or an older form dropped and created anew — when
  every caller in the tree resolves the new signature and every reader keys
  its columns by name (046, 058, 059, 061 and 070 each argued this before the
  rule said it: SMD-2324). So is a removal outside the version contract, with
  an upgrade line in its fragment.
- **PATCH** — no schema change: server, docs, evals, tests, or a migration that
  only re-comments (028, 043).

**What the version contract covers** (SMD-2687). A version speaks for what a
release ships, and for nothing else:
- **Its two images.** `ob1-server` (`server-portable/Dockerfile`: the MCP server,
  the REST core, the operator GUI and the plugins). `ob1-migrate`
  (`db/Dockerfile`: `migrate.ts` and the migrations).
- **The files it attaches** (`scripts/release-artifacts.ts`, `ASSETS`):
  - `deploy/compose.yaml` with its profiles;
  - the digest-pinned `compose.release.yaml`;
  - the settings `.env.example` names;
  - the four opt-in overlays: `compose.api-public.yaml` (`/api`),
    `compose.hooks-public.yaml`, `compose.grafana-port.yaml` and
    `compose.grafana-public.yaml`.

The authorization server (`deploy/auth/`) is inside through `compose.yaml`'s
`auth` profile. It ships as source, not as an image, so that profile needs a
checkout until SMD-3328 publishes one.

A URL, route, port or setting that any of these gives a client falls under the
MAJOR rule. Outside the contract nothing is a MAJOR: a removal there is a
MINOR, with an upgrade line. Two things sit outside it:
- **Maintainer tooling**, which a release neither attaches nor builds into an
  image: `deploy/compose.host-ports.yaml`, the edge (`deploy/edge/`), the
  scripts under `deploy/` (`canary.sh`, `tier.sh`, `instance.ts`, `smoke.sh`)
  and the `db/` scripts the migrator does not carry.
- **Vendored code**: `integrations/`, `extensions/` and the `recipes/` servers,
  which no image carries.

The cuts decided this before it was written here:
- v1.6.0 stayed a minor though SMD-2294 dropped the tier stack's own ports and
  settings, since `compose.tiers.yaml` was the maintainer's promotion pipeline,
  not a client's setup.
- v1.7.0 stayed a minor though SMD-1931 deleted six vendored integrations.
- SMD-2878's retirement of `compose.tiers.yaml` ships in 2.0.0 as a minor change.

A fragment that removes a URL, port or setting from a shipped file, or deletes
vendored code, says in one sentence which side of this line it falls on
(`changes/README.md`).

**The brain reports its version.** Migration 044 writes `schema_version` into
`ob1_config`; `preflight` prints it beside the ledger's highest migration and
warns, by name, when a brain is past its version's range or a server is older than
the brain it serves. `db/version.mjs` is the one definition of the current version
(`FORK_VERSION`), and `migrate.ts --dry-run` names the release each pending
migration belongs to. 044 wrote `0.0.0+upstream.9543c29`, the pre-first-release
baseline; each cut appends the migration that writes its version as the last file
of the range it freezes — 048 writes `1.0.0+upstream.9543c29`, the first release;
051 writes `1.1.0+upstream.9543c29`, the second; from 2.0.0 the stamp is the plain
version (`2.0.0`). The server reports its own at
runtime — the MCP `initialize` reply, the `brain_info` tool and `GET /health` with a
key — from `server-portable/version.ts`, generated from `db/version.mjs`,
`releases.json` and `db/migrations/` by `scripts/gen-version.ts` and round-tripped
by check-fork's 17e (SMD-2041).

**A release is a tag naming three things**: the migration range it closes
(the first cut, `001..048`; the second, `049..051`), the server commit, and the upstream pin
(recorded as data beside the version, not in it, from 2.0.0). The committed
`releases.json` is the machine-readable mirror CI reads with no network. Migrations
inside a released range are **frozen** — the ledger's sha check already refuses
drift at apply time; `check-fork-consistency` adds the rule that a renumber or
edit of a released migration fails at review time (a released migration is
append-only; add a new file).

**The change counter is retired.** Numbered `### N.` sections were assigned by
hand at PR time, so every merge of `main` while a PR was in review renumbered a
section and its cross-references. A PR ships a fragment, `changes/smd-NNNN.md`
(front matter — `type`, `bump`, `tickets`, `migrations` — and a `## Changelog`
and a `## FORK` body), with no change number; the release step assigns the
numbers once, at assembly, writing each fragment as the next
`changes/NNN-<slug>.md` in merge order and regenerating the index in
[`changes/README.md`](changes/README.md) (SMD-1804, SMD-1917). A fragment needs no
edit to the index, which lists numbered changes alone, so adding a fragment
never moves it — a cut does, or a numbered record's retitle (SMD-2084).
Changes 1–103 keep their numbers — the code comments cite them — as FORK.md's
table and the files they are.

`CHANGELOG.md` (root, **Keep a Changelog 1.1.0**) is the short page beside the
record in `changes/`: `## [Unreleased]` first, one dated section per release with entries
under the six headings, each entry ending in its ticket and migration numbers. The
release step writes it and the change files from the same fragments in one commit,
and `check-fork-consistency` pairs the two both ways. Conventional Commits is **not**
adopted — the fragment's fields give tooling what it needs, and the `[fork]` prefix
and `(caught: …)` tags stay. (The orphaned `.github/release-drafter.yml`, an
upstream leftover no workflow ran, is removed so there is one release mechanism.)

## Cutting a release

A cut closes a capability, not a date, and carries everything merged to `main`
before it. Its version is the last release's, bumped by the strongest `bump` among
the `changes/` fragments it carries (`scripts/assemble-release.ts`'s `nextVersion`);
once `main` holds a `bump: major` fragment, the next cut is a major. A patch can
ship at any time for an urgent fix, but carries no migration.

**Two commits, on one branch, in this order** (SMD-1804, SMD-1860;
`scripts/assemble-release.ts --write` enforces it):
1. **The version.** Run `bun scripts/assemble-release.ts` (a dry run that touches
   nothing) for the version it proposes. Bump `db/version.mjs`'s `FORK_VERSION` to
   it, and add the migration that writes it: a new `NNN_schema_version.sql`
   upserting `ob1_config.schema_version`, the highest migration on disk, so the
   range the cut freezes ends on the migration that names the release (check 17d
   holds the two equal). Move `db/README.md`'s migration map and the suites'
   migration counts with it, and run `bun scripts/gen-version.ts` to regenerate
   `server-portable/version.ts` (17e). The stamp takes the next migration number,
   so a branch adding a migration renumbers past it when it merges `main` after
   the cut.
2. **The release.** `bun scripts/assemble-release.ts --write`, which refuses a
   tree whose `FORK_VERSION` or highest migration does not say the version it is
   about to record, or one that is not clean. It writes each fragment as the next
   numbered `changes/NNN-<slug>.md`, regenerates `changes/README.md`'s index,
   writes the `CHANGELOG.md` section and the `releases.json` entry (its
   `upstream` key the pin, as data), and regenerates `server-portable/version.ts`.

The PR lands the two. If `main` moves under an open cut, rebuild the cut on the
new tip rather than merging, so `releases.json`'s server commit carries what
shipped. The maintainer tags the merge commit `v<MAJOR.MINOR.PATCH>` and pushes
the tag, and `.github/workflows/release.yml` publishes the images and the release
from it (`scripts/release-artifacts.ts`).

**The soak.** Before a cut is tagged, the canary runs it as the canary is: an
in-place writer fed stable's inputs (`deploy/canary.sh up`, which keeps its
database since SMD-3155), not a refreshed copy of stable's data (decided
2026-10-25; SMD-2541, SMD-1806). The cutover release, which changes how
clients reach the brain, soaks at least 24 hours.

## Deploying

The brain deploys one way: the compose stack, `deploy/compose.yaml` — the proxy,
the REST core, the MCP server at `/mcp`, Postgres and the profiles beside them
(SMD-2282's decision 6, SMD-2288). [`SETUP.md`](SETUP.md) brings it up, and
`docs/01-getting-started.md` is the same stack at a beginner's pace. Clients
reach `/mcp` through a TLS proxy or tunnel in front of the stack's proxy, or at
`http://127.0.0.1:8000/mcp` on its own machine (`docs/01-getting-started.md`,
Steps 6 and 7). There is no single-process, lone-container, Workers or
Kubernetes deployment, and no Supabase Edge Function build: `server/` left
with SMD-1800, the Workers target with SMD-3152.

The stack's `migrate` service applies every migration under `db/migrations/`
before `api` starts, and the servers assume the whole set. Nothing degrades
around a missing one: `capture_thought` is one call to `upsert_thought`, with
no two-step fallback (`server-portable/store-sql.ts`), and preflight's
"migration ledger" row warns of a brain behind the tree.

A vendored extension, recipe or integration server under the category
directories is not the brain. It is one HTTP process beside the stack,
`bun <file>`, behind the same TLS proxy, never stdio
(`primitives/deploy-remote-mcp/`). A contribution that adds operations to the
brain is a plugin (`plugins/<name>/`, SMD-2310), which the brain's own servers
serve.

---

## Vendored content: audit once, hold the delta

Everything under `recipes/`, `integrations/`, `extensions/`, `skills/`,
`schemas/` and `primitives/` is upstream's community tree,
vendored wholesale at the pin, so we ship its worst advice with its best under
this repository's name. The rule (SMD-1251, change 51): **audit the tree once
and hold the delta** — a standing check carries each audit so nothing quietly
undoes it. Four rules are held today, each in
`scripts/check-fork-consistency.ts` with counted, reasoned exceptions: shell
safety (check 6, change 51), core ownership (check 7, change 58), credential
compares (check 8, changes 64 and 67 — the exception list has been empty since
67) and writes around the functions that own a thought's content and vector
(check 10, changes 69 and 71). A new hit fails CI, and the choice is the one made
at the pin: fix the vendored file and record the delta in
that change's file, or list the exception with its reason. Each rule's text and
its measurements are in the change file named.

---

## Checking CI

**Running the suites individually cannot catch state leaking between them.**
`db/with-postgres.sh` starts a fresh container per invocation, so anything one
suite leaves behind is invisible; CI reuses one Postgres service across every
step. That difference hid a real failure: `DROP TABLE thoughts CASCADE` removes the
foreign-key constraint on `thought_chunks`, not the table, so a stale chunk table
survived at the previous suite's vector width and the next suite died on a
dimension mismatch. Every suite now drops `thought_chunks` first, and

```bash
./db/ci-parity.sh
```

runs them in CI's order on one shared database, test-live's shards and
test-upgrade/preflight on their own. Use it before pushing. Beside them it runs
the suites and self-checks of CI's jobs with no database (`DATABASE_URL` unset,
as in CI) and every typecheck (SMD-3638). Check 35 holds it to the workflow,
both ways: a script a step runs, from the same directory, with the same flags
and environment, or an excuse with its reason (SMD-2903).

**Two linters run on every PR (SMD-1808).** `commit-lint` holds each commit to the
house grammar (`[fork] … (SMD-NNNN)`, and `(caught: …)` on a review pass's finding
bullets) — `scripts/commitlint.config.ts`, which shares its tag parser with
`scripts/mechanism-yield.ts` through `scripts/commit-grammar.ts`, so the check
and the yield count cannot disagree. `workflow-lint` runs `actionlint` (pinned by
checksum) with `shellcheck` over `fork-checks.yml`'s `run:` steps; the workflow
now sets `defaults.run.shell: bash`, so every step runs under `-eo pipefail` and a
masked `cmd | grep` failure is surfaced rather than swallowed. Both are opt-in
locally (`bun scripts/install-hooks.ts` for the commit hook), and both are
*required* on `main` (SMD-1856), through "Fork Checks passed" since SMD-3168
(below).

**The runner image and every action are pinned (SMD-2093).** Every job runs on
`ubuntu-24.04`, not `ubuntu-latest`, which GitHub moves to Ubuntu 26 from
2026-10-19. Moving to the next image is a PR of its own, with the stack job's
lines rerun and actionlint's pin moved too (1.7.7 refuses `ubuntu-26.04` as an
unknown label). Every `uses:` is a full commit SHA with its tag in a trailing
comment (`actions/checkout@<sha> # v7.0.1`), because the release job runs its
actions with `packages: write` and a tag's owner can move it.
`.github/dependabot.yml` opens a weekly PR that moves the pins, once a release
is seven days old (a security update does not wait), grouping minor and patch
releases and sending each major on its own. Read a major before it lands:
actionlint looks an action's inputs up by tag, so it cannot check a SHA-pinned
one's, and an input the new major dropped is ignored at run time with a
warning. Dependabot's commits carry the house header, `[fork] Bump …`, through
a prefix whose trailing space keeps it from writing `[fork]:`. Check 23 refuses
a tag, a SHA with no tag comment, a `docker://` step image by tag, a `-latest`
or expression-picked runner, and a `dependabot.yml` that Dependabot would refuse
or that can open no PR. It holds a pin's shape, not its truth: a comment naming
another tag is what zizmor finds, and zizmor ran once for SMD-2093 and is not in
CI. Two images the release job's actions start by default, QEMU's binfmt and
the BuildKit builder that pushes to GHCR, are pinned by digest through their
inputs in `release-steps.yml`, and nothing moves those but a hand edit; nor
does anything move the database jobs' pgvector image. The rehearsal runs as a
job of its own whose token only reads (SMD-2111).

**`main` carries a ruleset (SMD-1856, SMD-3168).** One required check,
"Fork Checks passed", on a head up to date with `main` and satisfied only by a
run of the Actions app; changes only through a pull request; no deletion, **no
force-push**, and no bypass actors — it applies to admins too. "Fork Checks
passed" is `fork-checks.yml`'s job `fork-checks-passed`, which needs every other
job, runs even when one failed, and fails unless each succeeded (or skipped: by
its own `if:`, or as a docs-only PR's code job). So every job is required through
it, and a job added, renamed, split or run as a matrix changes nothing in the
ruleset. The ruleset is a file, `.github/rulesets/main.json`, applied
with `gh api -X PUT repos/MHarris-SgyMd/OB1/rulesets/22189960 --input .github/rulesets/main.json`,
and `check-fork-consistency` check 20 holds the file to that one context and the
job to every other job in the workflow, so a job left out of its `needs:` fails
CI by name. A push straight to `main` is refused, green checks or not: GitHub
answers with one `remote: -` line per rule it applied.

**"Schema migrations" runs `test-schema.ts` twice at once (SMD-2092).** One
step runs the suite at the default width and at 768 in the background, each to
its own log, and waits on both; nothing prints until both have exited. A
passing run's log is folded under its width; a failing one is printed open
under an error annotation naming the width. The two lines at the end of the
step, each run's `N assertions: …` line, are the first thing to read. "No
summary line" means the run died before its report, and its log says where;
exit 124 means it hung past its 15-minute limit (137, that it ignored the stop
and was killed, or ran out of memory). The self-checks after it run whether it
passes or fails. `db/ci-parity.sh` runs both widths, one after the other; to
reproduce a 768-only failure on its own:

```bash
cd db && OB1_EMBEDDING_DIM=768 OB1_EMBEDDING_MODEL=nomic-embed-text bun test-schema.ts
```

---

## Review passes: what caught a finding is written at the catch

Measured 2026-09-18 with `bun scripts/mechanism-yield.ts` over the commit log
as of `main` at 28e20d7 — before any tagged pass existed, so a re-run at HEAD
adds SMD-1711's own passes to every figure: 221 review-pass commits across
61 tickets, 511 bulleted findings in the 31 tickets whose passes carry bullet
bodies. **None of the 511 says what found it.** Each says what was wrong and
what changed. A keyword search for phrases that name a catcher ("mutant", "the
reviewer", "found by driving it") turns up about twenty, and half of those are
mentions, not catches — so nothing is inferred, and "which review mechanisms
pay" cannot be answered from the record. A proposal to back-fill a corrections
table from it (SMD-1711's origin) was dropped for that reason.

What the record does say, by a keyword classifier whose samples were read
(approximate by design: a defect in a checker that parses comments reads as
record drift):

- About a third of findings are record drift — FORK.md, comments, READMEs.
  A little under a third are code defects. A fifth are test teeth: a vacuous
  assertion, a wrong fixture, a gate with no margin. The rest are confirmations
  of no defect and tickets filed.
- **The defect share does not fall with the pass number**: 44 / 43 / 51 / 51 %
  at passes one to four, higher on the few tickets that went further. Fourteen
  of 31 tickets found their last code or test defect at pass three or later,
  and three of the four that ran five or more passes found one on their final
  pass. Passes stop because the operator stops them. The stop signal — a pass
  whose findings are the previous pass's own fixes — is a per-ticket judgement;
  a pass count is no proxy for it.

**The convention, from SMD-1711 on.** Every finding bullet in a review-pass
commit body ends with a tag the script reads:

```
- <finding>. (caught: <mechanism>)
- <finding>. (caught: <mechanism>; held: test-live [17])
```

`<mechanism>` is one of five: `cold-read` (a reviewer reading the diff or the
record), `run-it` (running the suite, bench or tool and reading what it did),
`mutant` (a deliberate break the suite should have failed on), `walkthrough`
(following the documented procedure as an operator or deployer), `automated` (a
gate fired on its own — CI, a check, preflight, typecheck; name it in `held`).
Confirmations of no defect and record fixes carry the tag too: the mix per
mechanism is the point. `held` is optional and names the test section, check
or migration that now enforces the finding. An untagged bullet is counted as
`implicit`, and the script says how many there were; a bullet that contains
"(caught" but does not end in a readable tag is warned on, not counted as
untagged. Bullets that only report a green run are not findings.

**Re-measure when ten tickets carry tags**: `bun scripts/mechanism-yield.ts
--since <first tagged commit>` — that commit and everything committed at or
after it, so a branch begun earlier contributes only what it committed in the
tagged era. That run was to decide SMD-1712, the citations facet that gives
`delete_thought` its `CITED` refusal; the gate was re-decided at three tagged
tickets under the epic's schedule caveat, the numbers are in change 95, and
the ten-ticket run now judges the epic's Phase 3 instead. The script is a
maintainer report, not a CI gate; it
prints its rules and a sample per class so the tallies can be judged before
anything is built on them. `--self-check` runs the parser's fixtures.

**The window and the attribution, corrected (SMD-1728, PR #80).** A
`--since YYYY-MM-DD` handed to the log was read as that day *at the current
time*, and the two paths cut on two clocks — committer time and author date,
which differ on 129 of the log's 1,351 commits — so a dump and a live run of one
window tallied differently. Both are one rule now: every row carries the
committer instant, and a `--since` day is resolved once to the instant it begins
in `--zone` (a Region/City name, default `America/Chicago`) and cut by instant
exactly as a `<sha>` anchor is. `ticketOf` took the first `SMD-nnnn` anywhere in
a subject and credited 13 of the 221 baseline passes to a ticket the subject
only mentioned; it reads the parenthetical the subject ends with first. The
baseline figures above are re-read under both rules from the same dump — 221
passes across **61** tickets, 511 findings in **31** — and the per-pass defect
shares are unchanged. The fixtures, the pass-number reading and the
dropped-bullet report are in that ticket's pass commits.

---

## The recurring defect: a value defined twice

Worth naming, because it has now caused five separate failures and every one
looked different on the surface:

| what was duplicated | how it failed |
| --- | --- |
| embedding prompts (harness vs `config.mjs`) | benchmark measured an instruction the server never sends |
| truncation rule (`index.ts`, `preflight.ts`, `config.mjs`) | container crashlooped on a valid default |
| schema reset across 9 test files | stale `thought_chunks` broke a later suite in CI only |
| compose `${VAR:-fallback}` vs `config.mjs` | a stale fallback would silently override the code default |
| **preflight's own copy of the defaults** | **the gate validated a configuration that was never going to run** |
| `applyPrompt` (server vs `evals/lib.ts`) | introduced *while fixing* this same pattern, one commit earlier |

The last one is the worst of them and survived until a deliberate look for it.
`preflight.ts` exists to refuse to serve when misconfigured, and it held its own
`"openai/text-embedding-3-small"` and `1536`, so after the default moved it checked
`text-embedding-3-small @ 1536` while the server ran `qwen3-embedding:4b @ 1024`.
Invisible in the container, because compose sets every one of those explicitly.

The last row is the instructive one: it was introduced one commit after this
section was written, by the person who wrote it, in a commit whose subject was
removing duplication. Naming a pattern does not stop you repeating it — only a
check does, which is why the row above it is now enforced by
`scripts/check-fork-consistency.ts` rather than by intent.

The pattern is consistent enough to be a rule: **a default that appears in two
files will be wrong in one of them, and the copy that goes stale is the one nobody
runs directly.** Everything provider-facing now resolves through `db/config.mjs`,
and `scripts/check-fork-consistency.ts` fails the build when compose, the
embedding model, the metadata model and the base URL stop agreeing.

The same rule applies to the suites. Three of them read a shipped default instead
of pinning their own, so changing the default broke tests that were testing
something else entirely — `test-e2e-sql` matched a provider by the literal string
`openrouter.ai`, `test-preflight` hardcoded `1536`, `test-embedding-dimensions`
keyed a stub off exact input text. A suite should pin what it does not test.

---

## Known issues we did NOT fix

Deliberate. Recorded so nobody assumes they were missed.

- **The access key still rides in the URL** — but it is now scoped, named and
  hashed (fix 14, FORK.md's table). `?key=` is kept because Claude Desktop
  connectors are URL-only, so a key in a URL still reaches access logs and
  browser history. What changed is
  what a leak is worth: a read-scoped key cannot write, and `capture_thought` is
  not even registered for it. Upstream
  [issue #216](https://github.com/NateBJones-Projects/OB1/issues/216) and
  [PR #238](https://github.com/NateBJones-Projects/OB1/pull/238) (OAuth 2.1) were
  the upstream answer; Daemonic Brain has its own OAuth path now. The `auth`
  profile runs an authorization server (SMD-2285), and on a stack configured
  with a stable public origin the MCP server advertises it at that origin
  (SMD-2382).
  `mcp-server/`, which serves `/mcp` since SMD-2287 PR 5b, trades the token it
  issues at the hop (SMD-2286), and keys
  keep working beside it (a claude.ai connector at that origin is asked to sign
  in first). Change 42 is adjacent, not a substitute: it makes the claude.ai
  connector *reach* the key path at all (upstream
  [#340](https://github.com/NateBJones-Projects/OB1/issues/340)) by answering
  OAuth discovery with 404 wherever OAuth is not advertised; it does not change
  what the key is. **Still treat a connection URL as a credential**, and give
  URL-embedded clients read scope.
- **Overlapping dashboards: fixed.** The one canonical dashboard is the
  operator GUI at `/dashboard` (`dashboard/README.md`). The other three and the
  `dashboards/` category retired (SMD-3309, SMD-3310).
- **`sensitivity-tiers` does not exist.** The `weekly-digest` recipe and its
  code reference it as a primitive (both Next dashboards did, until SMD-3309).
  [PR #110](https://github.com/NateBJones-Projects/OB1/pull/110) was closed
  pending a consolidation that never landed. Any feature gated on it is inert.
- **The eval sample is small.** Twenty retrieval queries and eight extraction
  captures. Differences under ~0.05 MRR, or one point of a per-field score, are not
  meaningful; the clear separations (the long-document slice, the structural
  failures) are. The test sets also reflect one person's kind of notes.
- **The local path is verified against real Ollama** (0.33.2, `nomic-embed-text` +
  `llama3.2`): `preflight --deep` passes, including `llama3.2 honours JSON mode`,
  and real thoughts capture and retrieve with no external service. Two caveats
  remain: Ollama was installed **natively** (Homebrew), because a Linux container
  on Apple Silicon gets no Metal passthrough and runs inference on CPU — the
  compose `local-models` profile is for Linux hosts and CI. And a container
  reaching a host-native Ollama needs
  `OB1_LLM_BASE_URL=http://host.containers.internal:11434/v1` — and nothing
  more: Ollama's loopback default is reachable through that name on podman
  machine (measured in change 99's fourth review pass; `OLLAMA_HOST=0.0.0.0`,
  which this bullet used to prescribe, put an unauthenticated model API on the
  LAN for nothing).
- **The codemod-migrated files are not individually tested.** Most need live
  credentials (Gmail, Slack, Readwise). The shim itself is tested against
  real Postgres, and CI checks every banner-carrying file still parses and that
  the codemod round-trips byte-for-byte — but exercise the ones you actually run
  before trusting them. The hand ports (`recipes/brain-backup` and
  `recipes/lint-sweep`, SMD-2144; `recipes/thought-enrichment`'s three scripts,
  SMD-2139) carry no banner and are driven instead, as deployed, by
  `db/test-live.ts` [26] and [29].
- **No file imports supabase-js at runtime any more.** The six servers that
  used resource embedding and nested `.or()` moved with SMD-1798; the
  dashboard's type-only import went with its Supabase sign-in (SMD-1801). Check
  22 holds the tree there; `bun scripts/migrate-to-sql-shim.ts` triages a
  file that imports it again.
- **`CLAUDE.md` and `AGENTS.md` disagree** — a duplicated worktrees block, then
  divergent content, and `AGENTS.md` mandates updating a private tracker.
  [PR #274](https://github.com/NateBJones-Projects/OB1/pull/274) proposed the
  obvious fix, was endorsed in review, and was closed unmerged.
- **An HNSW walk can miss a live row over near-equidistant vectors**
  (pgvector 0.8.6). Investigated under SMD-1632 and now understood: over the
  test suite's orthogonal unit axes (every pair at cosine distance 1.0)
  pgvector's neighbour-selection heuristic keeps few edges and the graph is not
  connected, so a search walking from the entry point misses a live row its own
  vector matches — the flake behind `test-live.ts` [7], reproduced with no
  vacuum. `db/hnsw-graph.ts` reads it from the index and [17] drives it; [4],
  [7], [11] and [15]'s reads take `match_thoughts`' exact branch, which does not
  walk. A **random, production-shaped corpus is fully reachable**, so this is
  the test corpus's problem (and quantised or binary vectors', SMD-1501) rather
  than a live brain's; no production check or capture-path verification is built
  for it, and `REINDEX` is not a remedy (a rebuild of an equidistant graph is no
  more connected). See change 85 (SMD-1632) for the measurements and the
  decision.

## Before this touches anything sensitive

Two constraints that are not engineering problems.

**Data.** A brain is one shared `thoughts` table with no per-user isolation,
reached with keys (scoped and hashed, FORK.md's fix 14; they can ride in a URL)
or the `auth` profile's tokens. Every captured thought's text goes to the model
endpoints — embedding, metadata extraction and the background passes — which are
local Ollama by default. An endpoint not declared local (`OB1_LLM_LOCAL`) gets
only what the egress gate lets through, which by default is nothing until an
`OB1_EGRESS_ALLOW` term names it ([`SETUP.md`](SETUP.md), "What may leave the
box"). That is fine for personal notes. It is not an architecture
to put regulated or patient-adjacent data into.

**Licence.** Daemonic Brain is a derivative of Open Brain under its licence,
FSL-1.1-MIT, © Nate B. Jones ([`LICENSE.md`](LICENSE.md)). "Your internal use and
access" is an explicitly Permitted Purpose, so running it privately for internal
tooling is squarely allowed. A **Competing Use** — making it available to others
in a commercial product with the same or substantially similar functionality —
is not. Each Open Brain version converts to MIT two years after it is published.
Fine as internal tooling; get a legal read before any of it ships in a product.
