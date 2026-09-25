# 146. Retire the Edge Function build — `server/` and its mirrors, every `deno.json` and `@ts-types` pragma, the two Deno CI jobs, the Deno image and the two Edge Function recipes go; the rebase cost is a measured number (SMD-1800)

**What changed.** Nothing in the tree runs on Deno. In five commits (review
passes follow), each green on its own:

1. `integrations/kubernetes-deployment` runs on Bun: `import { SQL } from "bun"`
   in place of the deno.land postgres driver (six `pool.connect()` blocks are one
   `pgQuery(text, params)` each), a `package.json` + `bun.lock` the image
   installs (`FROM oven/bun:1.4.0-alpine`, `CMD ["bun", "index.ts"]`), its
   `deno.json` and typed `node:process` import gone; the deploy-stack job builds
   the image. Running it found three defects (below).
2. `server/` deleted — upstream's Edge Function, `deno.json`, `package.json`,
   `bun.lock`, `test-stateless.mjs`, `test-stats-pagination.mjs`,
   `test-capture-atomicity.mjs`; the `server-tests` and `deno-check` jobs and
   their two required contexts in `.github/rulesets/main.json`; every path that
   named `server/index.ts` points at `server-portable/index.ts`.
3. The sixteen remaining `deno.json` deleted (eighteen in all — the ticket's
   twenty less consolidation-workers' two, gone with SMD-1798); the 21 remaining
   `@ts-types` pragmas and their two-line notes (22 in all; change 84's, for
   `deno check` alone); the three `jsr:` import lines (the ticket's five, less
   SMD-1798's two) went with `server/` and the two recipes; `extensions/test-auth.ts` loses
   `sdkTyped` and its two deno.json pin loops for one `hold()` — the MCP stack
   equal across the tree's three installs (`extensions/`, `server-portable/`,
   the Kubernetes image) — and both test loaders lose their Deno half (`jsr:`
   strip, `npm:` unprefix, the postgres stub).
4. `recipes/local-brain-no-mcp` and `recipes/edge-function-cost-optimization`
   deleted; `skills/ob1-local-http`, the former's companion, calls
   `integrations/open-brain-rest` (`POST /capture`, `POST /search`,
   `GET /thoughts`, an `x-brain-key`); check 11's `DENO_EXCEPTIONS`, check 22's
   local-brain entry, check 7's two init-script rows, check 10's one and the
   codemod's `KEEP` list are empty, the mechanisms kept.
5. This record; FORK.md's Deploying, Files-we-own, Drift-guards and Rebasing
   sections; the checker's header.

**Why.** SMD-1795's premise: nothing under Bun needs Deno. After SMD-1798 (the
shim everywhere) and SMD-1799 (Bun's entry shape) the Deno items existed for a
deployment path `SETUP.md` disowns and no test exercised — `server/index.ts` was
never imported by a suite (its mirrors read it as text), `deno check` typed
files Bun already ran, each `deno.json` mirrored a `package.json` the pin guard
held it to, and the two recipes were Supabase deployments of capabilities the
fork's stack has (no cloud; `open-brain-rest` as the HTTP surface without MCP).
The cost recipe's measurements were Edge Function invocation billing, a meter a
container has no analogue of.

**Held.** check-fork PASS (checks 11 and 22 with empty exception maps, a stale
or gone entry still failing; check 20 with the two contexts gone from the
ruleset — the live ruleset took the record on 2026-09-23, `gh api -X PUT
repos/MHarris-SgyMd/OB1/rulesets/22189960 --input .github/rulesets/main.json`,
read back as the ten contexts and neither Deno one; before that the PR would
have waited on two checks no job reports); `extensions/test-auth.ts` 758
(74 fewer than main's 832: the pin, pragma and cost-sample assertions), `test-tools.ts` 185,
`test-writes.ts` 313; `server-portable/test-server.ts` 229; tsc clean for
`scripts/` and `server-portable/`; the codemod round trip unchanged, 0 eligible,
1 blocked (SMD-1801's); the Kubernetes image built and started (no `deno` in
it, `Started server: http://localhost:8000`, 401 to an unauthenticated POST);
`find . -name deno.json` empty; `@ts-types` and `Deno.` absent from every code
file outside comments, the checker's rule text and `test-server`'s own assertion.

**Measured after.** kubernetes-deployment driven for real against a fresh Postgres
built by its `k8s/init.sql`, a stub provider, twelve assertions over its six
tools — the port's three defects, each caught by running it: a helper named
`query` was shadowed by two tools' `{ query }` argument; `fetch` selected an
`updated_at` column the schema never had (upstream's, failing under Deno's
driver too); a JSON string under `$3::jsonb` reaches Postgres from Bun's client
as a JSON *string* scalar (`jsonb_typeof = string`), so `metadata->>'type'`
found nothing — the object is the parameter. Bun returns `BIGSERIAL` as a
string and `timestamptz` as `Date`; the types say so. The rebase cost, `git
merge-tree --write-tree upstream/main HEAD` against upstream's three commits
since the pin: **3 conflicts, all workflows the fork deleted (SMD-1256), 0
vendored files**; three docs auto-merge — identical before and after `server/`
went, since upstream never touched it after the pin.

**Review passes.** Two reviewers on each pass. Pass 1 cold-read with mutants
(none of five survived: a `Deno` line, a stale exception, a dropped ruleset
context, a drifted pin in each of the two held package.json). Pass 2 ran the
skill's exact commands against a gateway on a fresh 1536-wide brain, and on a
default one; its findings were inside pass 1's fixes — the stop signal. Pass 3,
one reader over pass 2's diff: its findings were inside pass 2's. Pass 4, the
merge of main (dbd5a7c5), one reader against both parents: clean.

| Pass | Finding | Caught | Fix |
| --- | --- | --- | --- |
| 1 | the repointed skill promised the gateway "on the stack SETUP.md builds": the gateway embeds at 1536 through OpenRouter (fixed in its code) and every read selects the enhanced-thoughts schema's columns, so a default brain (1024, migrations only) answers 500 to every call; `curl -f` hid the error bodies the skill tells Claude to read | cold-read | both prerequisites in README and SKILL, `NODE_PATH` in the run line, `curl -sS`, the 403 body verbatim |
| 1 | the pin guard's `hold()` demanded every devDependency of extensions/ of the image's package.json (exact) and the core server's, not the four of the stack — a test-only fixture library would ship in the image | cold-read | the set is `PACKAGES`' four; an extra name in the image's file fails as such |
| 1 | check 11's and 22's failure strings still named the Edge Function set and `server/index.ts` as where supabase-js lives | mutant | the strings say what is held now |
| 1 | the image build ran after the compose smoke test, so a bring-up failure hid whether the image builds | cold-read | first step of the job |
| 1 | the Changelog gave commit 3's sixteen/21 as the PR's totals (18 deno.json, 22 pragmas: the ticket's 20/22 less the two `{}` maps SMD-1798 dropped); FORK.md said twelve required jobs; the primitive's four `deno.json` fetches from this fork's raw URL would 404; nine sentences of stale prose | cold-read | the totals with their arithmetic; ten; the fetches cut; each sentence |
| 2 | the skill's run line resolves the gateway's packages from extensions/ through `NODE_PATH` — but a forgotten `NODE_PATH` does not fail: Bun fetches an unpinned stack from npm (hono 4.13.9 against the 4.13.8 pin) and starts | run-it | `bun --no-install` in the skill's and the gateway's line — a missing install fails naming `hono` |
| 2 | the skill's failure modes said "check the gateway's log": the gateway prints one line at start and nothing on a 500; the body is the diagnosis (`OPENROUTER_API_KEY is not configured`, `expected 1024 dimensions, not 1536`, `column "type" does not exist`) | run-it | the bodies quoted as the discriminator |
| 2 | pass 1 named two schemas as the source of the gateway's columns; enhanced-thoughts alone adds every one (workflow-status re-adds two and backfills) | cold-read | one schema named as the cause, the other as the gateway README's second file |
| 2 | pass 1 asserted `stack.length === 4` beside `hold()`, the regex's cardinality typed twice; the record still said 757 after pass 1 added an assertion, and "before this merges" after the PUT was applied | cold-read | `STACK` once, the regex and the count from it; 758, the PUT dated |
| 3 | pass 2 made the stack one list in test-auth while test-writes' loader kept the regex as a literal — a name added to one alone leaves that suite's import unrewritten, and Bun fetches it unpinned | cold-read | `STACK` and `PACKAGES` exported from db/test-support.ts; both loaders and the pin guard import them |
| 3 | the gateway README said test-auth "starts it this way" a line after `--no-install` joined the run line; the suite spawns without the flag (its SDK-importing servers resolve by Bun's fetch, SMD-1991); pass 2's own commit put its tag mid-bullet | cold-read | the sentence says what the suite does; the message amended |
| 3 | kubernetes-deployment's README ran the file from a checkout naming no install — the one vendored directory with a lockfile of its own | cold-read | `bun install --frozen-lockfile`, then `bun --no-install index.ts` |
| 4 | the merge of main (SMD-1867 with 053, SMD-1958, SMD-1960): file sets exact both ways, the three shared files branch plus main, nothing of main's reaches the retired set or check 11's roots; the merge message placed main's new CI step in the wrong job and pass 3's message carried a mid-bullet tag — both reworded (trees untouched); two preflight comments still named the cost recipe in the present tense | cold-read | the comments say retired |

**Not taken.** Porting local-brain-no-mcp's three functions to a Bun server
(a second gateway against a second schema). Retitling the cost recipe to
session reuse (the fork's servers are per-request by design, change 78, and a
container bills no invocations). A tsconfig and CI typecheck for
kubernetes-deployment in place of `deno check` (nothing types `extensions/`
either; test-auth imports and starts the file) — SMD-2051. Deleting the
ob1-local-http skill with its recipe (the capability is the skill's).

**Follow-ups.** SMD-2051: type-check `integrations/kubernetes-deployment`
(check 18's list). SMD-1802: the primitives `deploy-edge-function` (its
`deno.json` fetches cut here, the guide otherwise standing) and
`troubleshooting`, the `supabase functions deploy` blocks the two integration
READMEs whose `deno.json` lines this cut still carry — and the twenty-nine others, two of them numbered change files —
`open-brain-rest`'s metadata still calling itself an Edge Function, CLAUDE.md's
rule. SMD-1991: a recipe started
from a checkout still resolves its packages by Bun's network auto-install.
SMD-1245's item 1 (an "Apply 004" string in `server/index.ts`) closes here.

**Upstream status:** not sent — the fork's deployment path.
