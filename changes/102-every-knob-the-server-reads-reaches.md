# 102. Every knob the server reads reaches the container — `deploy/compose.yaml` forwards the six `OB1_*` settings it did not, the server's `type Env` is the list check 14 holds the file to, and a name in a comment is no longer a forward (SMD-1843)

**What changed.** Compose gives a container exactly the variables its
`environment:` names, and the `server` block named sixteen and not
`OB1_LLM_BASE_URL`, `OB1_METADATA_MODEL`, `OB1_QUERY_LOG`,
`OB1_QUERY_LOG_RETENTION_DAYS`, `OB1_METADATA_TEMPERATURE` or
`OB1_METADATA_REASONING`. It forwards all six: five as `${NAME:-}`, so
`db/config.mjs` keeps the default and `""` reaches the server, which reads it as
unset; `OB1_LLM_BASE_URL` as `${OB1_LLM_BASE_URL:-http://ollama:11434/v1}` — a
fallback on purpose and not a copy of the code's `127.0.0.1`, which is the right
address from the host and the wrong one inside every container by construction.
The `local-models` profile now needs nothing set; an Ollama on the host is one
line; OpenRouter is the URL, the key and both models. Around it: the environment
is trimmed once at the boundary (`trimmedEnv` in `db/config.mjs`, applied in
`index.ts`'s `initEnv` and in preflight) and the three flag resolvers trim their
own argument, so a padded `" on "` decides the same for the migrator and the
server; `OB1_PG_POOL` reads `""` as the default of 10 (`poolSizeFrom`, in
`store-sql.ts` and the compat shim) where `Number("")` had given a pool of 0 that
Bun refuses at construction; `type Env` declares `OB1_PG_POOL` and
`OB1_TRGM_INDEX`, which were read undeclared; `.env.example`'s provider section
says the shipped defaults are local (Options A–C, D from change 101), with a
query-log block and the extraction knobs; `deploy/README.md` and SETUP.md name
the profile in the bring-up line and say what happens without it.

**Why.** The first stack this fork ran for real (2026-09-19, change 99) set the
three knobs in `deploy/.env` and the container saw none of them until a second
`-f` file added the lines. The rule that should have caught it read "forwarded"
as *any* `OB1_*` token in the compose file's text, and a comment and
`ollama-pull`'s command line carried two of the names. Measured before, on a
throwaway project from `main`'s file with the knobs set and no OpenRouter key:
the ticket's premise — preflight fails on the missing credential — was wrong. The
server took the code's default `127.0.0.1:11434`, which `isLocalHostname` calls
local, preflight said OK, the stack came up healthy, and the first
`capture_thought` failed in 7 ms with `Unable to connect` while the server log
ended at `Started server`.

**Held.** Check 14 replaces the text rule. Universe: the `OB1_*` / `OPEN_BRAIN_*`
names `index.ts`'s `type Env` declares, held honest by a scan of every server
source and `db/config.mjs` for a direct read of an undeclared name (the
migrator-only knob excused in `READ_FOR_MIGRATOR`, the excuse held stale two
ways). Forwarded: the parsed `services.*.environment` (`Bun.YAML`, mapping or
list form) of every `compose*.yaml` under `deploy/`. Each declared knob is
forwarded under its own name as `${NAME}` or `${NAME:-…}` — one `HOUSE_FORM`
regex is the shape rule — or excused by name in `NOT_FORWARDED` with a reason,
and documented in `.env.example`; a forwarded name the server does not declare,
a documented knob no service forwards, `env_file`, a bare list item (absent in
the container where every other knob is `""`, measured under docker-compose
v5.5) and a fallback that is not `http://<one of LOCAL_PROVIDER_SERVICES>:11434/v1`
for a service the file or the base defines are refused. The decision is one pure
function, `serverEnvGapsIn(declared, documented, files, excused)`; 25
`DECISION_PROBES` run it on in-memory documents every run, beside 12
`LINE_PROBES`, 11 `FORM_PROBES`, 8 `FORWARD_PROBES` and the reader probes; under
no `Bun.YAML` the check fails in words beside check 13. Fourteen mutants on the
real files bite. CI's "Full stack, no Supabase" job sets a provider URL that is
neither default and `OB1_QUERY_LOG=on` in its `.env`, drops the stub key, and
greps preflight's report in the server log for the URL, `ON` and `preflight OK`.

**Measured after.** Same throwaway project, rebuilt from the tip: preflight names
the host's Ollama, `qwen2.5:7b`, the query log ON; `smoke.sh` 9 of 9; a capture
lands in 1.2 s with topics extracted; a search in 81 ms writes its `query_log`
row. `compose config` renders the six under `server` with the env file's values.
`check-fork-consistency` PASS, `tsc` clean, `test-thoughts` 114, `test-server`
178, `test-preflight` 50, `db/test-schema` 1082, `test-live` 579. The CI job's
shape run locally with its exact `.env`: three greps, three `jq` lines, smoke.

**Review passes.** Eight, each a cold read beside a run-it reviewer with a
mutation harness on the real files and the live stack. The stop signal fired at
pass 4; passes 5–8 each found a real defect of the author's outside the check,
so the signal alone did not settle the branch. One row per finding that changed
the mechanism; the rest, with `(caught: …)` tags, is in the commit bodies.

| Pass | Finding | Caught | Fix |
| --- | --- | --- | --- |
| 1 | `lineOf` searched the whole file, so a fault in the server's block pointed at the migrator's line | both | 11d0a9d — `lineIn(text, service, needle)`, six probes |
| 1 | the fallback rule accepted *any* service (`postgres:5432/v1` passed) while preflight's local list was a literal in `preflight.ts` | cold read | 11d0a9d — `LOCAL_PROVIDER_SERVICES` in `db/config.mjs`, both read it |
| 1 | the base file alone was read; an overlay's `OB1_STORE: postgrest` under `server` went unheld | run-it | 11d0a9d — every `compose*.yaml` held to the shape and the names |
| 1 | `OB1_PG_POOL=""` gave `Number("") = 0`; the file kept `${OB1_PG_POOL:-10}`, a copy of the code default | cold read | 11d0a9d — `poolSizeFrom`; the claim "opens nothing" corrected in pass 6 (Bun refuses 0) |
| 2 | `lineIn` matched the needle as a substring, so `OB1_QUERY_LOG` resolved to `_RETENTION_DAYS`'s line | both | 6d73ea3 — keys alone, regex-escaped, quoted or list-item, five probes |
| 2 | the six `forwardForm` messages were unprobed (swapping two passed) | run-it | 6d73ea3 — `FORM_PROBES` |
| 3 | the decision had no probe: dropping `if (!server.has(k))` left the real file passing | cold read | 0599553 — pure `serverEnvGapsIn`, 19 probes (25 by pass 4) |
| 3 | the universe was hand-declared; a `process.env.OB1_X` read elsewhere slipped past | cold read | 0599553 — `envReadsIn` over every server source, planted read reported at its line |
| 3 | a bare list item is absent in the container, not `""` (measured, docker-compose v5.5) | run-it | 0599553 — refused; the message says what was measured |
| 3 | `DECISION_PROBES` parsed YAML at module scope — threw under no `Bun.YAML` (found at pass 7) | cold read | f5cf844 — text held, parsed inside the guard |
| 4 | the shape regex loosened to "starts with `${NAME`" passed every probe | run-it | cf8f078 — three tail probes |
| 4 | the read scan stopped at `server-portable/`; `db/config.mjs` reads eight knobs through its proxy | cold read | cf8f078 — scanned, `READ_FOR_MIGRATOR` excuse held stale two ways |
| 5 | `LOCAL_PROVIDER_SERVICES` sat between `isLocalHostname`'s JSDoc and the function | cold read | f2c5551 — above the block |
| 5 | the source walk was flat; `shims/` was never read | cold read | f2c5551 — recursive walk, self-check that it reaches `shims/` |
| 5 | the fallback pin read the base file's server alone | cold read | f2c5551 — every file's server, service looked up in that file or the base |
| 6 | the compat shim had the same `Number(process.env.OB1_PG_POOL ?? 10)` read | both | 4e46885 — `poolSizeFrom` there too, asserted |
| 6 | the model and URL knobs were not trimmed while the comment said "like every sibling" | cold read | 4e46885 — `stringOr` / `baseUrlOr` in `embed.ts`, preflight reads through them |
| 7 | `stringOr` sat between `resolveEmbedConfig`'s JSDoc and the function (the second orphaned docblock on one branch) | cold read | f5cf844 — above the block |
| 7 | the migrator's `ENV` proxy did not trim while the server did; a padded model label recorded with the space | cold read | f5cf844 — the proxy trims |
| 8 | the proxy trim missed the three flag resolvers: `" on "` was ON to the migrator and OFF to the server | run-it | 92d0083 — `trimmedEnv` at the boundary (initEnv, preflight), resolvers trim their argument |
| 8 | an unreadable service registered an empty environment and cascaded one report per knob | cold read | 92d0083 — registers nothing; two probes |
| CI | main's change 101 put "— embeddings and chat" between the URL and the local clause; the exact grep failed PR #93's first run | CI | 64be9f2 — the grep tolerates prose between the two facts |

Tidied while open (6ddc8df): one `HOUSE_FORM` regex, `index.ts` read once, the
script's path one module constant.

**Not taken.** Comment-awareness in the read scan (a JavaScript comment stripper
is its own hazard; no scanned source has such a mention). The CI step reading
`printenv` instead of the log (the log proves preflight *read* the value). A
universe derived from the reads rather than declared and held. An overlay
forwarding an undeclared knob to *migrate*, which reads `db/config.mjs`'s
universe, not the server's.

**Follow-ups.** SMD-1875 — preflight dials no local endpoint without `--deep`, so
a wrong local URL (the `ollama` fallback with no profile) still passes and fails
at the first capture (argued in six passes, not taken here). SMD-1876 — SETUP.md
twice and the server README say the default provider is OpenRouter; the code's
default is local. SMD-1881 — five hand-rolled "empty means unset" numeric
readers, one shared reader. SMD-1917 — this record was 470 lines before that
change cut it to this shape.

**Numbered at the merge.** 100 on its branch; `main` took 100 and 101 while the
passes ran, so 102 — the last hand renumber; SMD-1917 ends them.

**Upstream status:** not sent — upstream has no `deploy/`; the stack is this
fork's (change 16 and the migration plan's Phase 4).
