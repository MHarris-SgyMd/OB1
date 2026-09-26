# 169. The PostgREST-speaking recipe scripts are decided — thirty files in twenty-one recipes port by kind, imports onto the ingestion contract and maintenance scripts onto the shim, three the core already owns retire, and check 24 holds the class from growing back (SMD-2126)

**What changed.** SMD-1802 swept the docs off Supabase and left one class alone
on purpose: the recipe scripts that describe Supabase as the *database* —
`${SUPABASE_URL}/rest/v1/<table>` with a service-role `apikey` from a `.mjs`,
`.js` or `.ts` `fetch`, or supabase-py's `create_client` from a `.py` — for one
decision rather than twenty-one rewrites. This is the decision, not a port.

1. The survey, re-measured on d8e3de60: thirty files in twenty-one recipes,
   none importing `compat/supabase-sql` (ten more match the same grep and are
   on the shim already — `SUPABASE_SERVICE_ROLE_KEY` read and ignored). Five
   embed the text themselves and POST content and vector as a row — the shape
   SMD-1524 closed for the servers; five call `upsert_thought` over
   `/rest/v1/rpc/` (re-atomize, entity-wiki, backfill-gmail-wikis, readwise,
   embed-local — the right function over a transport the fork lacks; the
   smoke harness too); the rest read `thoughts` and write metadata or a
   sidecar table. Four read `OPEN_BRAIN_URL` rather than `SUPABASE_URL`
   (entity-wiki, typed-edge-classifier, wiki-synthesis' two); three read
   either. Two of the thirty (atomizer's and authorship-edges' backfills)
   reach the gateway through a `lib/` file and have no call site of their own.
2. Three options weighed, in `docs/vendored-disposition.md`'s new section.
   *Upstream-only* loses every import recipe. *A PostgREST profile* in
   `deploy/compose.yaml` runs the scripts unchanged and brings back the surface
   SMD-1795's acceptance retired, with every raw insert still open —
   declined. *Port by kind* is taken: an **import** becomes an adapter of the
   ingestion contract (SMD-1867) — its parser emits `Ingested` items and
   `bun db/ingest-records.ts --items` writes them through the pipeline
   (SMD-2136, the one new mechanism) — its own insert with 003's fingerprint
   function and the audit actor, not `upsert_thought` — so a Python parser
   stays Python; a **maintenance script** moves onto `compat/supabase-sql`
   under `bun`, the shape SMD-1798 gave the servers, a thought it deletes
   through `delete_thought(p_id, p_actor)` with its `CITED` answer read from
   `data.ok`, and the four entity scripts writing mentions through 016's
   `record_thought_entities`, since `thought_entities` on a fork brain is
   016's table, not the schema's; a **smoke harness** has its own ticket; a script whose
   capability is **in core** retires — `obsidian-vault-import`
   (`db/ingest-markdown.ts` is the fork's Obsidian import; the recipe's
   heading split with LLM distillation, its filters, secret scan, sync log
   and source label have no counterpart and are dropped with it, each named
   in SMD-2137),
   `local-ollama-embeddings` (the server embeds locally; `reembed.ts`),
   `fingerprint-dedup-backfill/backfill-fingerprints.mjs` (migration 023).
   Not the REST gateway the ticket named as the `.py` target:
   `open-brain-rest`'s `POST /capture` embeds at
   `openai/text-embedding-3-small` (1536), which the fork's default brain
   refuses, and a request per row is the wrong shape for an import.
3. The record: the section with a twenty-one-row table (recipe, lines that
   speak PostgREST, what it touches, fate, ticket); the rollup counts move (keep 79, remove 8,
   sub-file removals 2); the twenty-one inventory rows point at their fate,
   the two retiring ones struck through as SMD-1800's were.
4. Check 24: in every code file (.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs, .py,
   .sh) under the seven category directories and docs/, a `rest/v1` path in
   any string, a supabase-py import or `create_client(` (Python and shell
   alone), or a `@supabase/postgrest-js` specifier is a hit — comments
   blanked by the JS scanner for JS and by a `#`-outside-a-string blanker for
   Python and shell — for shell at a word's start alone, after one of bash's
   metacharacters or at the text's start, since `$#` and `${#a[@]}` are not
   comments (a docstring is a string and is read: a file
   that says it posts to `/rest/v1/rpc/…` is making a claim about itself).
   `POSTGREST_EXCEPTIONS` counts the twenty-eight files with a call site, each
   with the ticket that ports or retires it: a line past the count fails, a
   count no line reaches fails as stale, a file that is gone fails until its
   entry goes. Every child PR shrinks the table, and its size is the class's
   remaining size. Thirty-one probes and two blanker probes run inside the check.
5. Fifteen tickets under SMD-2126: SMD-2136 (the `--items` source, blocking
   the four import ports), SMD-2147–2150 (chatgpt, perplexity, readwise,
   google-activity onto the contract), SMD-2137 and SMD-2138 (obsidian and
   local-ollama retire), SMD-2139–2145 (thought-enrichment, atomizer, the two
   edge writers, provenance-chains, the three wiki writers, the three
   read-only scripts, fingerprint-dedup-backfill onto the shim), SMD-2146
   (ob-graph's smoke). SMD-2021 (pull-gmail, backfill-metadata) and SMD-2103
   (brain-smoke-test) were already open and carry a note fixing their target.
6. Twenty READMEs open with a fork note naming the script, why its live mode
   fails here, where it is going and under which ticket; brain-smoke-test's
   note from SMD-1802 already said why it cannot run and now names SMD-2103.

**Why.** The import recipes are the root README's "start importing your data"
table, the most-used class among the vendored recipes, and on this fork not one
reached a brain. A profile would have fixed that in an afternoon and undone
SMD-1524 and SMD-1795 at once; per-file rewrites without a class rule would
have left each reviewer deciding the shape again. The contract exists, has two
adapters and owns the invariants (fingerprint, source, links, watermark,
actor); the shim exists and carries eight servers. The decision is which of
the two each script is, and the check is what keeps the answer.

**Held.** Sixteen drills and mutants against the real checker and an
untracked copy: a `.mjs` drill with a `rest/v1` fetch fails on its line
naming `POSTGREST_EXCEPTIONS`; a `.py` drill with `from supabase import` and
`create_client(` fails on both lines; a `.py` mentioning `rest/v1` in `#`
comments alone (one after an apostrophe inside a string) passes; a `.mjs`
mentioning it in comments and a regex literal alone passes; a `.md` passes; a
`.ts` importing postgrest-js and a `.sh` with a `rest/v1` curl fail; an
exception count one too high fails as a new call, an entry removed fails on
the file's line, an entry naming a gone file fails as stale; the path rule
changed to `rest/v2` fails its probes and every entry reads stale; the `#`
blanker dropped fails its blanker probe and a comment non-probe; the shell
class narrowed to whitespace, or its text-start arm dropped, fails the shell
blanker probe and a `.sh` non-probe; JS strings blanked fails every JS probe;
the report line dropped leaves the `.mjs` drill
unreported — so the drill is what has teeth.

**Measured after.** `bun scripts/check-fork-consistency.ts` PASS (115
contributions) with all twenty-eight counts reconciling on the first run;
`scripts/` typechecks; the ticket's grep over `recipes/` names exactly the
thirty files, every one in the disposition table.

**Review passes.**

| Pass | Finding | Caught | Fix |
| --- | --- | --- | --- |
| 1 | the record counted six raw-row embedders (five) and two `upsert_thought` callers (five, plus the smoke harness); four scripts read `OPEN_BRAIN_URL`, not `SUPABASE_URL`, and three notes and the port shape said the wrong name; the obsidian retire named nothing the adapter lacks (heading split with LLM distillation, filters, secret scan, sync log, source label); the Touches column listed a bare `edges` table for four recipes only entity-wiki reads, missed provenance-chains' two `merge_thought_*` functions and eval's metadata write, called synthesize-wiki a writer and did not name backfill-gmail-wikis' raw `POST /thoughts` fallback; source-filtering's note promised `node` → `bun` in a README that already runs `bun`; the checker's header and block said thirty files where the table has twenty-eight; the shell blanker took `$#` and `${#a[@]}` as comment starts and lost a hit after them on the same line, and its docblock said it could only add hits; the mismatch message blamed "a moved one", which cannot raise a count; two regex arms had no probe; the SMD-1795 quote was a paraphrase; the fold-in bullet still listed obsidian; "stops at `create_client`" (it stops at the first request); "`mcp-tools.ts` is on the shim" (it takes an injected client) | cold read; run-it | counts, names, rows, notes and quote rewritten; the losses named in the row, the section, the note and SMD-2137; a shell `#` opens a comment at a word's start alone, with a probe each way and a shell blanker probe; two import-arm probes; "or a moved one" dropped; the smoke-test note names SMD-2103; comments on SMD-2137, 2141, 2142, 2143 and 2144 carry the corrections |
| 2 | nine maintenance notes (and readwise's) said `--dry-run` runs — those dry runs read the brain over PostgREST first and fail as live mode does (the imports' never reach the URL); pass 1's shell word-start class (`;`, `(`, `|`, `&` and the text's start) had no probe, so narrowing it to whitespace passed every probe and the check, and it lacked `)`, `<` and `>`, which bash, dash and zsh also take as comment starts; a re-flow orphan ("each: a") in the block comment; the `twice` comment said "the last hit probe" after three more were added; the below-count message said "remove the entry" for a partial port; header item 24 still described the old shell rule; the fragment named the old column head; fingerprint-dedup's note lacked the `node` → `bun` clause; two notes comma-spliced | cold read; run-it | the parenthetical dropped from the nine and the section says which dry runs run; the class is bash's metacharacter set, pinned by a shell blanker probe over every member and the text's start plus three `.sh` non-hit probes; comment, message, header, fragment and notes rewritten |
| 3 | five import notes and the section said the `--items` pipeline writes through `upsert_thought` — it inserts the row itself with 003's `content_fingerprint_of` and the `ob1.actor` envelope, ids deterministic, no supersession lock; the idiom map sent every `count=exact` to `head: true`, which drops the page backfill-type reads and the rows provenance's counted PATCH returns; the dry-run sentence exempted readwise, whose `already_imported` select runs before its guard; ten notes said "the live mode fails" under bodies that say start with `--dry-run`; two of the five raw-row importers send a client-computed fingerprint; on a fork brain `thought_entities` is 016's table (uuid `entity_id`, no `mention_role`), so the four entity scripts' writes fail with 42703 whatever the transport and nothing in the record said so; `delete_thought`'s actor shape and `CITED`-in-`data` were unstated; the rollup bullet named three fates of four; chatgpt's `why` decided a fate the table left to SMD-2147; the Held paragraph counted fourteen after pass 2 made it sixteen | cold read; run-it | the pipeline described as it is; the idiom map split by request kind; readwise excepted; the ten notes say `--dry-run` included; the fingerprint clause split three and two; the shadow named in the section, four rows and four notes, each port through `record_thought_entities`; the delete call spelled with its actor and `data.ok`; the bullet, `why`, Fate cell and Held count fixed; comments on SMD-2136, 2139–2143, 2145, 2147–2150 and 2021 carry the corrections; SMD-2153 filed for `delete_thought`'s unguarded `p_actor` |

**Boyscout.** After the passes, what they cut for space, no behaviour
changed: check 24 names its shell files once (`SHELL_FILE`, beside
`HASH_COMMENT_FILE`, with a probe) where `postgrestIn` repeated the regex;
the hit-beside-a-comment probe is found by its text, not by an index that
moved each time a probe was added; the one shell hit probe that sat under the
"not hits" comment is back among the hits; and the section's forty-line
"kinds" paragraph is four — imports, maintenance scripts, the entity tables,
smoke harnesses and retirements — the sentences unchanged.

**Not taken.** Porting any file here — the ticket says decide before porting,
and SMD-2021's two are the template. Rewriting the twenty-one READMEs' data
paths — each child PR does its own; the note at the top is the pointer. A
check-10 extension reading `/rest/v1/thoughts` as a write — a whole-class rule
with no scoping catches the same lines and more (SMD-1252's lesson about scope
in a text rule). Counting `SUPABASE_SERVICE_ROLE_KEY` as a hit — the shim reads
and ignores it, and ten shim files do. A supabase-py import inside a shell
string (`python3 -c "from supabase import …"`) — the import arms are
line-anchored; `create_client(` would still hit, and no file does it. The
PostgREST profile, above.
