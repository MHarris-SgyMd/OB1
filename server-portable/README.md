# server-portable

The Open Brain REST core (`api.ts`) and the core every brain operation runs
in. It began as a runtime-neutral build of the MCP server, so the runtime could
be chosen last, with the same tools and wire behaviour as upstream's Edge
Function build (`server/index.ts`, in this fork until SMD-1800). The runtime
chosen was Bun: the brain runs as the compose stack (`SETUP.md`). That MCP
server, this directory's `index.ts`, retired in SMD-2287 PR 6b, and `/mcp` is
`mcp-server/`, a client of this REST core. The
Cloudflare Workers target and the PostgREST store it needed were retired in
SMD-3152 — no brain ran them.

## Prerequisites

- [Bun](https://bun.sh) 1.4+ (used for tests and the container image)
- A Postgres with pgvector and the core Open Brain schema — `db/migrations/`
  applies it; [`SETUP.md`](../SETUP.md) brings up the whole stack

## What differs from upstream's Edge Function build

Three changes.

1. **No Deno globals.** `Deno.env.get(…)` and `Deno.serve(…)` are gone, and the
   `jsr:@supabase/functions-js/edge-runtime.d.ts` type import is removed.
2. **Env is read lazily.** The import-time env reads and the eager client
   became an `initEnv`/`env()`/`db()` shim, seeded by the first middleware (it
   was written for Cloudflare Workers, whose bindings arrive on the request).
   It reads `process.env`.
3. **The data layer is an interface.** Every database call goes through the
   `ThoughtStore` interface in `store.ts`; the SQL store is its implementation.

The second change is what makes the file testable; the third is what let the
SQL store replace the PostgREST one.

## Choosing a model provider

Two calls happen per capture — an embedding, and a metadata extraction. Both go to
OpenAI-compatible endpoints, so switching providers is configuration. By default
one endpoint serves both; `OB1_CHAT_BASE_URL` gives the chat calls (metadata,
chunk blurbs, the supersession judge) an endpoint of their own — local
embeddings with a hosted chat model, or a second local runtime that serves
chat only, beside Ollama:

| Variable | Default | Notes |
| --- | --- | --- |
| `OB1_LLM_BASE_URL` | `https://openrouter.ai/api/v1` | Any OpenAI-compatible `/v1`. Ollama works. Embeddings — and chat, unless the next row says otherwise |
| `OB1_LLM_API_KEY` | falls back to `OPENROUTER_API_KEY` | Omitted entirely for a loopback endpoint |
| `OB1_CHAT_BASE_URL` | the embeddings endpoint | Where `/chat/completions` goes when that is a different provider; `OB1_METADATA_MODEL` then names a model this endpoint serves |
| `OB1_CHAT_API_KEY` | none for a different endpoint; the embeddings key for the same one (a chat base with a user and password of its own is a different endpoint) | A credential belongs to an endpoint: a different chat endpoint never inherits `OB1_LLM_API_KEY` or `OPENROUTER_API_KEY` (both are the embeddings endpoint's), so a local chat model beside a hosted embedder is not handed the hosted key, and local embeddings with OpenRouter for chat means this knob, not `OPENROUTER_API_KEY`. A user and password in a base URL are that endpoint's credential too, sent as Basic unless a key is set (SMD-2885). Preflight fails a hosted chat endpoint with neither of its own and names the fix |
| `OB1_LLM_TIMEOUT` | `120` seconds | Per provider call, both endpoints — embedding, blurb and metadata extraction alike; a call that never returns fails as such instead of hanging |
| `OB1_EMBEDDING_MODEL` / `OB1_EMBEDDING_DIM` | `openai/text-embedding-3-small` / 1536 | Must match the column; permanent once there is data |
| `OB1_METADATA_MODEL` | `openai/gpt-4o-mini` | No schema dependency — safe to change anytime |
| `OB1_JUDGE_MODEL` | the metadata model | The supersession judge's model (`db/consolidate.ts`), for running the judge — the harder task — on a stronger model than every capture's tagging; a model the chat endpoint serves. The pass key carries it, so a change starts a fresh pass (SMD-1901) |
| `OB1_CONSOLIDATE_DECIDER` | unset (the judge decides) | Consolidation's decide mode: the typed-decision tier's model (`OB1_JEV_BASE_URL`) gives each pair's verdict, and `OB1_JUDGE_MODEL` only writes the proposals it calls outdates at the pass's floor, both quotes checked in the texts without their markdown (SMD-3151). Since decide version 4 it first answers the mediated-pair test's link step for those pairs and for an evolves the pass would store, and a pair linked only through a third subject or a passing mention is related at most, with no proposal (SMD-3203). The pass key names both models, so turning it on, or a new decide version, starts a fresh pass; preflight fails it without the tier, or with `OB1_JEV_MODEL` naming another model (SMD-3115) |
| `OB1_LLM_LOCAL` / `OB1_CHAT_LOCAL` | unset (remote) | `1` declares the embeddings / chat endpoint on this machine or its private network, so the egress gate does not apply to it. Declared, never guessed from the address: a loopback URL with the flag unset is remote to the gate. A chat endpoint at the same base is the same box: either knob declares it (SMD-1903) |
| `OB1_EGRESS_POLICY` | `deny` | What may leave the box for an endpoint not declared local: `deny` (only what an `OB1_EGRESS_ALLOW` term names), `allow` (everything but what an `OB1_EGRESS_DENY` term names), `off`. A knob that does not parse fails preflight and closes the gate |
| `OB1_EGRESS_ALLOW` / `OB1_EGRESS_DENY` | none | Comma-separated `unit:value` terms — `actor` (the access key's name), `source`, `type`, `topic` (a row's metadata), `marker` (a literal in the text) — read under `deny` and `allow` respectively |

The two calls fail differently and deliberately. A metadata failure lets the
capture succeed and records why, because the content is the durable part and the
tags are re-derivable: a 4xx, a body that is not JSON or an answer with no
content writes placeholder tags beside `metadata_extraction_failed`; a provider
that did not answer — the connection refused, reset or unroutable, a name that
does not resolve, the deadline passed, a 5xx, 408 or 429 (`embed.ts`
`providerDown`, SMD-2888) — writes the marker alone, no topics and no type, as a
refused call does, so a re-capture during the outage leaves an existing
thought's tags as they were. An embedding failure lets the capture succeed only
when the provider did not answer: the thought lands with its text and
fingerprint and no vector, the reply says the provider was unavailable (where
and why to a key that can read; that it was, to one that cannot), the write's
audit row records the word (`thought_audit.actor_context.vector_failed`:
`provider_unreachable`, `provider_timeout`, `provider_<status>` — that this
write's call failed, which on a re-capture is not that the row has no vector),
and `search_thoughts_keyword` finds it at once. The vector mender gives it its
vector once the provider answers (below); so does the same text captured again,
or a re-embed pass. Any other
embedding failure still fails the capture — a 4xx (an input the model refuses, a
credential, a model that is not there), a body that is not JSON, a vector of the
wrong width — because those say the brain is misconfigured, and a thought with
no vector is invisible to semantic search. An edit (`update_thought`) whose
provider does not answer is refused whole, as before: nothing is lost, and
storing the new text would clear a vector the thought had.

A search whose query embedding the provider does not answer (the same
`providerDown` outages) is answered by the hybrid's exact-literal arm alone —
the identifiers and quoted spans in the query, through the same function with
no vector — and, those matching nothing, by the whole query matched as one
text, case aside, as `search_thoughts_keyword` matches it — when it is 3 to 64
characters and not only common words, in a scan bounded at its first 1,001
matching rows, newest first among them, a count past that said "more than 1000" (SMD-2891). `search_thoughts` says so first, names the endpoint and
`search_thoughts_keyword`, and carries `vectorFailed`; with nothing found it
says whether the query's literals are absent, too common to match exactly,
held only by thoughts outside the search's filter, `said_by`, `actor` or
`min_trust`. The compat `search` marks each title `[exact match — semantic
search unavailable]` and adds `vectorFailed` and a `note`; with nothing found it
is refused `EMBEDDING_PROVIDER_UNAVAILABLE` (retryable; REST 503), saying the
same of its literals, since an empty list would read as nothing stored. The query log records the
search as arm `literal` (migration 106). Any other embedding failure still
fails the search.

The **vector mender** (`core/mend.ts`, SMD-2889) is what gives a thought with
no vector its vector, by itself — one the provider did not answer for, one the
gate refused, or one an import wrote bare. The REST core runs one (`api.ts`;
`index.ts` did too until SMD-2287 PR 6b), every `OB1_VECTOR_MEND_INTERVAL` seconds (60 unless set, 1 to 86400;
`0` or `off` for none), and a tick acts only while it holds a Postgres advisory
lock (`ob1:vector-mender`) taken on a connection of its own, never the pool's,
so one tick acts at a time across replicas. Each server
keeps its own cursor, holds and log; the lock only takes turns, so a brain's
two servers mend up to 8 rows a tick each (16 an interval), and a held row is
tried by each on its own schedule. A session lock needs a session: behind a
pooler in statement or transaction mode it is not let go where it was taken
(the mender says so, once) — point `DATABASE_URL` at Postgres, or set the knob
off on every server but one. The lock's connection is one beyond
`OB1_PG_POOL` per server. A tick reads in id order from where the last stopped,
passing over the rows the gate refuses and the rows held, until it has tried
8 rows (a long row is a call per window and one for the whole, and a blurb call
per window under `OB1_CHUNK_CONTEXT`), read 256 rows, or reached the end; a
policy that refuses every call (deny with no allow term, an endpoint not
declared local) makes it idle, said once. It embeds each by the capture's own
path — windows, blurbs and the head-window fallback included — and writes it
through `update_thought` with the stamp it read: one `update` event per row,
actor `vector-mender` (marked `background` on the audit row, which
`db/sleep.ts` reads past, as it reads past an ingested write), the row's own
stamp (who wrote the text, its trust) kept, the egress decision recorded, and
its `updated_at` moved, as any event moves it — an agent holding the old stamp
for `if_unchanged_since` re-reads. The provider away needs no rule about which
row is to blame: every failure holds its row — an outage-shaped one (refused,
reset, timed out, 5xx, 408, 429, or a body that is not JSON, a proxy's page)
for 1, 2, then up to 4 sweeps — and two outage-shaped failures in a row stop
the tick, so the provider away costs two calls a tick at most. Two ticks
running whose calls met outages and none was answered are the provider away,
said once; the first answer after — a vector, or an HTTP status that is not an
outage's — is its return, said, and lets every outage hold go, so the rows
that waited through it are tried again at once. One such tick alone, or an
outage met beside an answer, lets nothing go: a text the provider fails alone,
a blip or a rate limit waits out its own short hold, and nothing is said; and a
row that has failed three times speaks no more for the provider — a tick whose
outages all met such rows counts toward no outage. An
egress refusal is the row's failure and says nothing either way. A sweep's end
drops the holds of rows no longer waiting (mended by another writer, or
deleted); with no outage hold left, an outage that stood is over, and said so.
The only row waiting through an outage has no other row's answer to show the
provider back, so it waits out its hold: up to 4 sweeps, about 5 intervals. A row whose call
or write fails otherwise (a 4xx other than 408 or 429, the wrong width, a write the database refuses)
is held for 1, 2, 4 … up to 32 sweeps; the holds are the process's, so a
restart tries every row again. A database not there to answer stops the tick, and the loop
waits twice as long each time, up to 32 times the interval. The egress gate is
asked what the row's writer asked: a row a key captured through a server (its
capture's audit `origin` a server's name) as the capture was asked — the key
and the text — and as a pass asks of a row, its metadata too, sent only when
both allow, so a `source:` the caller claimed opens nothing and a `source:`
deny term keeps the row home; any other row — an import's, board-sync's — as
`db/reembed.ts` asks, its metadata and text and no actor, since its
`actor_name` may be a label the tool chose, and again with that `actor_name`,
so a deny term naming it (board-sync's own gate asked with its name) keeps it
home. Blurbs the gate refuses for a row are left off and its windows go in
bare, as a capture's do. The door and actor the mender trusts are the ones the
capture's own session declared (046, 050): a database role in the capture
group can name a server's door and a key, as it can name any actor today, so
such roles are trusted as the servers are. A row edited between the read and the write is left
for the next sweep (`STALE_READ`). `brain_info` (its `Vectors` row) and a keyed
`/health` (`database.vectorless`) count the thoughts that wait. The cost lands
as rows do: an import written bare for a later `db/reembed.ts`, or a backlog
after an outage, is embedded on the configured provider — a hosted one's bill
included — unless the knob is off. `db/reembed.ts` stays the tool for a model
change or a whole brain at once.

Together these are a brain **serving degraded** (`provider-health.ts`,
SMD-2890): its embedding provider away, it still captures, searches by exact
matches and mends after, and it says so. The server keeps the provider's
state, fed by every embedding call — a capture's, an edit's, a search's, a
mender tick's — and by its own probes:

- `answering`, at `at`, `by` a call (it embeds) or by the probe (`GET /models`
  answered: reachable, nothing yet said of the calls). With a `fault`, a call
  the provider answered and refused or answered unusably — a 4xx (a model not
  pulled, a key refused), a body that is not JSON, a vector of the wrong
  width: the provider is there, and a capture fails outright until it is fixed.
- `unreachable` since `since` (the first outage of the run), `at` the latest,
  the `reason` word and its `detail` for the latest, and `clears`: `probe`
  for an outage a `GET /models` can see (the probe's own, a call's failed
  connection), `call` once a call has failed where `GET /models` is blind (a
  5xx, 408, 429, a timeout — a proxy that answers `/models` while its backend
  is down). Set when the outage opens, escalated by a call, reset by an answer.
  The words say "unreachable" for a connection or a timeout, "failing its
  calls" for the rest.

Each change is said once in the log (`provider: … does not answer …` or `…
fails its calls … serving degraded`; `… answers again`; `… refuses its
embedding calls (…)`). A call that began before the provider was last seen
answering is not counted against it — before a call last answered, for an
outage only a call can see — judged on the monotonic clock. A local endpoint
(the local rule preflight dials by, below) is probed: `GET /models` at start,
so a server started with its provider down says so before any call, then,
while unreachable, every `OB1_PROVIDER_REPROBE_INTERVAL` seconds (15 unless
set, 1 to 3600; `0` or `off` for the start's probe alone): `GET /models`, no
credential, no redirect followed, 2.5 s, a 5xx, 408 or 429 an outage. Its
answer ends an outage whose `clears` is `probe`; for one whose `clears` is
`call` it spends one real call — an embedding of the word `probe`, through the
server's own embedder, as a query (as preflight's `--deep` sends
`preflight`) — and that call's answer ends it. So a silent provider costs the
cheap probe's 2.5 s a round, not a request timeout, and each process ends its
own outage whether or not its mender holds the lock, on a brain with no
traffic too. That call costs a model call an interval, only while calls fail;
it is a `gen_ai` span like any other (the `GET /models` probe makes none), so a
provider failing it counts toward the provider-failures alert as its failing
captures do. The egress gate is asked for it once, at start: refused (a
probeable endpoint not declared local, under deny with terms the word cannot
meet) it is not made, and the `Provider` row says only a call that is
answered ends such an outage, and why. An answering provider is not probed;
probes never overlap. A hosted endpoint is not probed — asking it costs a
credential — and its state moves with real calls alone. A keyed `/health`
(`provider`: the state, with `reprobeS` and `reprobeByCall`) and `brain_info`
(its `Provider` row) report it; the keyless `/health` stays `ok`, liveness
alone, so a container's health check never restarts a brain that is serving
degraded. The state is the process's: each server keeps its own (the `/mcp`
service shows the REST core's), and a restart starts it at `unknown`.

A call the **egress gate** refuses is neither (`egress.ts`, SMD-1903). The
server asks the gate before either call and makes only the ones it allows: a
refused embedding lands the capture with its text and fingerprint and no vector,
the reply says so and names the rule, and the decision is recorded on the
thought's audit row (`thought_audit.actor_context.egress`); a refused tagging
call lands it untagged — no topics, no type — with `metadata_extraction_failed:
egress_denied`, and a re-capture of a tagged thought keeps its tags and vector
(a write key's merges only the marker in, and a capture-only key's nothing —
080, SMD-2539; the marker stays: the merge cannot remove a key, so a
`metadata_extraction_failed` marker on a thought that carries real tags is
informational and may be stale, as for the other failure reasons). An edit is
judged on the row's own metadata; a capture is judged before the write, on
the actor and the text alone. A refused search names `search_thoughts_keyword`, which makes no
model call. Every dialler — `providerCall`, the judge, the entity extractor —
asks the gate itself before the request, so no call the fork makes is ungated;
a refusal there is a `ProviderError` of kind `egress`. Deny is the default and
"local" is declared, never guessed: a stack from before the gate that points
at Ollama by address needs `OB1_LLM_LOCAL=1`, and preflight's `embeddings
egress` row says so with the line.

A local endpoint — local by its hostname, the credential rule's sense and not
`OB1_LLM_LOCAL`'s: loopback, a private address, the `ollama` service name, the two
host aliases — is dialled once on every start, with or without `--deep`: the
name resolved first, then one `GET /models`, no body, no credential, 2.5 s
each, and any HTTP answer but a 5xx, 408 or 429 passes the
`provider endpoint` row (a `chat endpoint` row for a chat base of its own). A
name that resolves with nothing answering yet — refused, silent, or no route
to it (`EHOSTUNREACH`, `ENETUNREACH`) — warns, and the server starts degraded
(above, SMD-2890): an Ollama on the host started after the stack, or the
profile's container still starting, is a provider not up yet, not a broken
brain, and failing preflight on it restart-looped the container until it came
up. The row says what serving degraded costs (a silent endpoint holds each
capture and search up to `OB1_LLM_TIMEOUT` first, SMD-3205) and the re-probe
interval; the chat row's cost is captures landing untagged. Still failures: a
name that does not resolve — a runtime without it (the `ollama` service
without its profile, a host alias the runtime does not write) will not grow
it; in a container (`/.dockerenv` or `/run/.containerenv`), a loopback host,
which is the container itself, where nothing will start (the maintainer's
call); an endpoint that answers wrongly (a reset, an untrusted certificate) and
anything unclassified;
and any failure through a proxy, the route's before the provider's
(`startsDegraded`, `provider-health.ts`). A port typo outside a container is
now the warning. Either way the
remedy names the name's kind: the service name needs `--profile local-models`; inside a
container `127.0.0.1` is the container; `host.containers.internal` is podman's
alias and `host.docker.internal` Docker's, which Linux Docker gets through the
compose file's `extra_hosts`. A certificate the server would not trust reads
"answers, but", with trust as the remedy; when `HTTP_PROXY` is set the row says
the call went through it unless `NO_PROXY` names the host, since Bun routes
loopback through a proxy too and the server's own calls take the same route;
userinfo in the URL is masked. Until SMD-1875 preflight's credential rule called an
endpoint local by its hostname and connected to nothing, so a container pointed at an address with
nothing behind it started `preflight OK` and failed its first capture in 7 ms.
A hosted endpoint is not dialled without `--deep`.

`preflight.ts --deep` exercises both against the live endpoint, checks the
embedding width matches the schema, and checks the metadata model actually honours
JSON mode — a provider that ignores `response_format` degrades every capture to
`uncategorized` without ever failing — and, when `OB1_JUDGE_MODEL` names a
different model, checks that one too under its own `judge model` row. The
typed-decision tier (`jev.ts`, SMD-2050) is checked only when `OB1_JEV_BASE_URL`
is set, and then on every run, not only under `--deep`: `jev tier` dials its
`/info` (no text sent) and fails on an unreachable URL, an answer outside the
`ob1-jev/1` contract, or a model other than `OB1_JEV_MODEL`; `jev egress` says
what the gate does with its decisions (declared by `OB1_JEV_LOCAL`); `--deep`
adds `jev decision`, one binary decision through the client and its gate. The
server never decides — the Jev spikes do — so the rows exist for the operator
who set the knob to learn at start, not at a spike's first call, that the tier
is not there. `chunk window` prints the length a capture
is windowed above, the window size, and where the numbers came from — `OB1_CHUNK_TOKENS`, the model's
measured window (`db/config.mjs`, `KNOWN_MODEL_WINDOW`), or the default for a
model the table does not know — and warns when an explicit limit is over the
window, or over the headroom under it the estimate needs, since a window that
overshoots is cut silently (SMD-1305). With or without `--deep`, over a direct
connection it also reads the claim table: a re-embed pass that has not finished —
rows pending, leased or failed under a `reembed:` key — is a warning with the
counts and the command that finishes it, because `ob1_config` records the new
model from the pass's first moment while the rows say how far it got
(`db/README.md`, "What preflight sees"); the remedy names `--accept-failed` for
a row the provider refuses permanently and `--retire` for a superseded key, the
operator's two acknowledgements. And since migration 021 every vector
carries the model that produced it, so `vector models` reads the corpus by
that label: vectors at another model are a warning with the counts and the
re-embed as the remedy, whether or not any claim row remembers the pass that
left them — a vector the operator accepted, and has not written since, is
detail; the column missing under this server is a failure, as is a database
whose `update_thought` predates 032 or carries an older form beside it (`edit
signature`) — the server sends the model on every capture and every edit, and
the provenance envelope (`p_provenance`, migration 032) on every edit.
Over a direct connection `atomic capture` reads both `upsert_thought` bodies
as well, since a `CREATE OR REPLACE` from outside the migrations — an earlier
migration by hand, the getting-started guide pasted again, a vendored schema
or recipe (SMD-1250) — replaces one with no error: a 3-argument body from
before 022 leaves a re-capture's stale windows behind, one from before 025
drops `derived_from` and `supersedes` silently, one from before 033 takes no
fingerprint lock (a capture racing an edit of the same text raises the unique
violation 018 removed for edits), one from before 035 fills a NULL `supersedes`
on a re-capture without walking for a loop and holds the supersession lock
through every capture that names one, and a 2-argument body from before 005
empties a double-encoded payload silently — or, from before 033, takes no
lock either; each is a warning naming 035, the last definer of both forms. `provenance` reads
`trace_provenance`'s body the same way and warns, naming 026, when the
bounded walk is gone; `stats summary` warns when `thought_stats_summary`'s
body is not 024's; and `work claims` fails when `release_thought`'s or
`release_claims_for_worker`'s body is not 015's — every worker release would
fail 015's CHECK — and names any overload of the claim names no migration
defines. `write privileges`: a role missing any privilege the capture path's
writers need — SELECT/INSERT/DELETE on `thought_chunks`, INSERT on
`thought_audit`, DML on `thoughts`, each writer running as its caller — is a
failure naming each
missing one with its GRANT (`db/config.mjs`'s `ROLE_GRANTS`, the same list
`migrate.ts --grant` issues). `fingerprint backfill` (023): a thought without a fingerprint
whose text no row holds is a capture doubled in waiting — a warning naming the
migration, or after it the one statement `SELECT backfill_content_fingerprints();`
as the table's owner; NULL rows that share their text with the row holding the
key (twins, or a stale key) are ok. `query log` (034, SMD-1295): the opt-in query
log — reported, never a refusal, since it is off by default and its write is
best-effort. When `query_log` is present the check names it and whether
`OB1_QUERY_LOG=on` here, says what it stores (personal data at rest) and its
retention, and points at `evals/export-queries.ts` and `evals/eval-utilization.ts`;
absent, it is a skip; present without migration 035 it warns, since a write that
cites a returned id logs no cite row there (SMD-1719). `vector index memory` and
`filter bitmap memory` (SMD-1499): the server sized for the table. The first
is a warning, since a managed platform may not let the operator change the
setting: the valid HNSW indexes over `thoughts` and `thought_chunks` against
`shared_buffers`, with the size to set and the statement that sets it. A
staging index built by hand for 039 to adopt is left out while the body still
orders by the vector column and the vector index (001's, 007's) holds the
shipped name, since the walk uses that until 039 runs; the row says so, and a
warning's remedy has 039 applied before sizing (SMD-2871). The OS
page cache serves a walk too, but measured at ten million rows it gave ten
connections about a third of the throughput. The second is information only:
the bitmap a filter on the GIN route needs (64 bytes a heap page; every page
under 037's gate, at least 1 − 1/e of them for a filter at its boundary above it, more on a heap under ten times v_exact pages)
against `work_mem`, and a generic-plan walk's over the whole heap. A lossy
routing count costs little under its LIMIT, and whether `match_thoughts` takes
a generic plan is SMD-1464's to settle, so it recommends nothing.
`db/config.mjs`'s `memorySizing` holds the arithmetic.

## Choosing a data layer

One store: `store-sql.ts`, Postgres directly through `Bun.sql`. It needs
`DATABASE_URL` (or `SUPABASE_URL` holding a `postgres://` URL), and `OB1_STORE`
stays unset (or `sql`). It became the default in FORK.md change 97 (SMD-1797)
and the only store in SMD-3152, which retired the PostgREST store beside it and
the Cloudflare Workers target that store was kept for: no brain ran either, and
stable and canary run the compose stack. An `OB1_STORE` of `postgrest` is
refused at start and by preflight's `store selection` row, naming the fix (unset
it, set `DATABASE_URL`).

### Two behaviours the SQL port had to preserve exactly

- `match_thoughts` compares `> match_threshold` **strictly**, so a row whose
  similarity equals the threshold is excluded. The SQL store calls the stored
  function rather than reimplementing the ranking, which keeps that guaranteed in
  one place.
- jsonb parameters must be bound as **objects**. `Bun.sql` binds a JS string to a
  jsonb parameter as `jsonb_typeof='string'`, and `p_payload->'metadata'` then
  returns NULL — silently storing `{}`. Migration 005 rejects that outright.

### Ranking by recency, opt-in (migration 020)

`search_thoughts` takes `recency_weight` (0–1, default 0). At 0 the ranking is
by meaning alone, exactly as before; at 0.2 a thought's age counts gently
against its similarity (half-life 90 days); at 1 the thoughts above the
threshold come newest first. The threshold still gates the raw similarity, so a
weight reorders relevant thoughts and cannot surface irrelevant recent ones, and
the `% match` shown is always the cosine. The store sends `recency_weight` and
`half_life_days` on every call — the function forms from before 020 no longer
exist, and preflight's `search signatures` check fails a database that still
has them, or has an old form re-created beside 020's. The ChatGPT `search` tool
cannot take a parameter and sends a fixed weight; `db/migrations/020_*.sql` and
`evals/eval-recency.ts` record how it was chosen.

### Current thoughts first, opt-in (migration 059)

`search_thoughts` takes `prefer_current` (default false). Off, the server calls
`search_thoughts_hybrid` exactly as before, so the default ranking is unchanged
and a superseded hit is only labelled (`⚠ Superseded by …`). On, it calls 059's
`search_thoughts_current`: over the hybrid's top min(100, 4 × limit), a thought
whose ticket is settled — completed, canceled or a duplicate, by 058's and
105's `node_state`, so a
note filed under a Done ticket counts — or that a newer thought supersedes has
its score multiplied by 0.25. Under the hybrid's fusion that puts every current
match in the window first, then the demoted ones in their own order (a demoted
exact hit keeps a quarter of its literal bonus, so on a query of literals only,
or holding several of the query's literals, it can still outrank current rows —
the header says when one does). Since migration 077 (SMD-2271) a thought with no
ticket of its own is demoted too when every ticket it is about is finished:
the keys in its topics, action items or session-summary header all Done,
Canceled or Duplicate — or, naming none of those, three or more keys in its text, all
finished — and no open ticket named anywhere in it. Each
demoted hit says `↓ Ranked ×0.25 — completed` (or `canceled`, `duplicate`, `superseded`,
`references settled work (SMD-…)` with the deciding keys; the structured reply's
`demoted` carries the token `references_settled`),
and the header says how many of the window were demoted, how many carry a
lifecycle and the latest sync among them — and, when the window held fewer
current matches than asked for, that one past it may have been missed (raise
`limit` below 25; above, the window is already capped at 100). A blocked or
unknown status does not demote a thought (superseded still does), and ties go
to the current one. An exact identifier hit on a settled thought is demoted
too: to look a finished ticket up by its key, leave the flag off. Since
migration 068 each candidate's lifecycle is a lookup in a table the thoughts
triggers keep current, so the server's role needs the capture group's grants on
`ob1_ticket_head` and `ob1_superseded_by`, and keeps the server group's SELECT
on `thought_sources` (a brain before 068 reads it; since 068 PostgreSQL 16 and
17 skip it, which is observed, not documented — `db/README.md`); without them,
or without 059, that search is refused naming the fix and every other search
runs.
The query log records such a search as arm `current`. It costs about half a
millisecond over an ordinary search at 10,000 thoughts and about one at
100,000, most of that the wider window it reads (`db/bench-hybrid.ts`; at 059
it read the whole brain per call, about 130 ms at 100,000). The ChatGPT `search` tool cannot take the parameter and never
demotes; `evals/eval-supersession.ts` records what the demotion finds higher
(the current version, the live ticket) and lower (the topical answer, a note
under a finished ticket, a finished ticket looked up by its key).

### Tickets that moved since a hit was written (migration 095)

Both searches label, and never rank lower, a hit naming a ticket whose status
type has moved since the hit was written (SMD-2540): `search_thoughts` prints
`⚠ Moved since written: SMD-2306 In Progress → Done; …` after the superseded
and demoted lines, every moved ticket by key, and lists them in each hit's
`moved` (`{ticket, was, now}` in status types; the REST answer carries each
status's name and type); `search` gives that result `moved`, in status types
over REST as well, and over MCP starts its title `[moved since written: …]` —
before the thought's own words, which could forge it at the end. A status prints as its type's word (Triage,
Backlog, Todo, In Progress, Done, Canceled, Duplicate), never the board's name: any write
key can write a ticket row's name, and it would print on other people's hits.
A hit's first 50 keys, in the order it mentions them, are read; the rest are
counted (`movedNotRead`; beside a move, `(+N more named past the first 50, not
checked)`). Written is
the session's end the hook's last line records, else the row's stored time,
and a ticket that already held its current type an hour later is the writer's
own move, not labelled — the reading `evals/eval-stated-status.ts` measured
(`server-portable/stated-status.ts`).
A superseded hit, a ticket row and a note filed under a ticket are not
checked: their `moved` is null, as is every hit naming a ticket on a brain
before 095; an empty one means checked and nothing moved. The inputs are one call to 095's
`ticket_status_inputs`, made only when a hit names a ticket; a brain before
095, or a role without `ob1_config`, labels nothing and searches as before.

There is no switch: the label never moves a rank or refuses a search. A wrong
label is a wrong reading of one ticket. Its status now is the ticket's head
(`SELECT head_id, status, status_type FROM ob1_ticket_head WHERE issue =
'SMD-…'`): a write key's ticket row with a later `linear_updated_at` takes
it (SMD-3047), so `delete_thought` that row, or `update_thought` it with
`metadata_patch: {"issue": null}` — an edit of its text alone leaves it the
head — and board-sync's own row is read again. A list step can read a count as a ticket
(`SMD-2306, 1006 summaries` names SMD-1006), labelled only if that ticket
exists and moved.

## Steps

### 1. Install

```bash
bun install
```

Every suite that drives an MCP server (all but `test-rest.ts`, `test-thoughts.ts`,
`test-jobs.ts`, `test-store-sql.ts` and `test-preflight.ts`) loads `../mcp-server/` and
`../rest-client/` too, so run `bun install` in each of those as well. This directory's `bunfig.toml` turns Bun's
auto-install off, so without them the import fails, naming the package, rather than
Bun fetching it (SMD-2978).

`hono` and `zod` are pinned to the exact versions `../extensions/package.json`
installs for the vendored servers, and `extensions/test-auth.ts` fails if they
drift; the MCP packages differ (the v2 scoped packages here, the v1 SDK and
`@hono/mcp` there, until SMD-2279 and SMD-2281). **If you bump a shared package
in one file, bump it in both in the same commit.**

### 2. Run it

The brain deploys as the compose stack (SMD-2282's decision 6): the REST core
is its `api` service, built from `Dockerfile` (the image's default command), and
[`SETUP.md`](../SETUP.md) and [`deploy/README.md`](../deploy/README.md) bring it
up. `bun api.ts` serves it on `PORT` (default 8000).

### 3. Provide configuration

Required in every environment:

```
MCP_ACCESS_KEYS              name:scope:sha256 entries, scope read | write | capture | forward (grants nothing; SMD-2284) — bun keygen.ts mints one (or the legacy MCP_ACCESS_KEY, one raw key, write scope)
DATABASE_URL                 the brain's postgres:// connection string — the SQL store, the default
OPENROUTER_API_KEY           embeddings, and metadata extraction unless OB1_CHAT_BASE_URL gives chat its own endpoint — then OB1_CHAT_API_KEY (neither needed for a local endpoint)
```

A box that also runs a vendored server migrated onto `compat/supabase-sql` —
which reads a `postgres://` URL from `SUPABASE_URL` — may set that one name for
both: this server reads a `postgres://` `SUPABASE_URL` as `DATABASE_URL` when
the latter is unset (`store.ts:databaseUrl`), and preflight says which variable
supplied the string. An `https://` `SUPABASE_URL` is not a connection string,
and preflight and the store's first use say so.

Optional: `OPEN_BRAIN_CITATION_BASE_URL`, `PORT`, `OB1_LISTEN_HOST` (compose never forwards it; for a server run outside the stack: the one IP address to listen on, such as `127.0.0.1`; unset, every address — `::` is every address too, `0.0.0.0` every IPv4 address; a value that is no IP address, a link-local IPv6 one (it needs an interface the setting does not take), or one the host's interfaces do not list, stops the server at start with exit 2, in words, without printing the value; SMD-3323), and on Bun `OB1_STOP_GRACE` (the platform's grace period for a stop, in whole seconds with no unit; default 10 — see Caveats), `OB1_VECTOR_MEND_INTERVAL` (seconds between the vector mender's ticks, 1 to 86400; default 60, `0` or `off` for none — see "The vector mender" above) and `OB1_PROVIDER_REPROBE_INTERVAL` (seconds between re-probes of a local embedding provider that does not answer, 1 to 3600; default 15, `0` or `off` for the start's probe alone — see "serving degraded" above).

On a container these are ordinary environment variables.

### 4. Apply the migrations

`../db/migrations/004_upsert_thought_with_embedding.sql` is still required for
the atomic capture path: the store writes content, metadata and vector in one
`upsert_thought` call and has no two-step fallback (that was the retired
PostgREST store's).

The schema is the migrator's. In the compose stack its `migrate` service runs
`db/migrate.ts` on every `up`, before the servers start (`db/README.md`).
Preflight probes `match_thoughts` on every start and warns while a body from
before 014 is in place, one that filters metadata *after* choosing its
candidates and so returns fewer rows than match. A schema applied without the
migrator takes `--reapply` once; a plain run there is refused (`db/README.md`
§4, SMD-3425).

Upgrade every checkout that runs against the brain — this server, `db/*.ts`, a
second workstation — together with the migrations. A signature-changing
migration leaves an older checkout's preflight refusing the newer brain with a
misleading message (it looks for a form the migration dropped) — 032 today, and
the same shape at 020 and 021 — and, for 032, its `reembed.ts` sending you to
`--reapply` and that older `--reapply` re-creating the dropped form beside the
current one, after which every shorter call is `function is not unique` until a
current checkout re-applies. The compose stack is in lockstep by construction; a hand-run server
is not (FORK.md change 60;
SMD-1451 is the migrator refusing it).

## What this brain is: `brain_info` and a keyed `/health`

An agent or an operator can ask a running brain what it is (SMD-2041). The
**`brain_info`** tool (read scope — a read or a write key sees it, a capture-only
key does not) answers a short table:

```
Version:         1.5.0 (release range 073–076; this tree adds 077–079, unreleased)
Commit:          8ba58db5…
Store:           sql · tier stable
Embedding:       qwen3-embedding:4b @ 1024
Postgres:        16.15 (Debian 16.15-1.pgdg12+2) · pgvector 0.8.6 (schema public)
Schema version:  1.5.0
Migrations:      079 applied — this server's tree ends at 079 (current: the ledger's highest is the tree's last)
Brain embedding: qwen3-embedding:4b @ 1024
Rows:            373 thoughts · 1,204 audit events · 90 chunks · 512 entities
Database size:   45.2 MB
Board sync:      2026-10-05T16:57:19.368Z
Relations:       14 standing (9 related, 4 evolves, 1 duplicate; 11 pair two tickets the board does not link)
Proposals:       6 pending (the oldest judged 3 d ago; 4 pair two tickets the board does not link); 2 stale
Findings:        8 posted in 6 comment(s): 3 accepted, 1 rejected, 1 unanswered after 30 d, 2 open, 1 withdrawn — acceptance 60% (3 of 5: accepted over accepted, rejected and unanswered), median 4 d to an answer
Workers:         board-sync alive (last stamped 2 min ago, every 300 s)
HNSW:            thought_chunks_embedding_idx on thought_chunks (m 16, ef_construction 64); …
```

What the judgements mean. `ledgerStatus` compares one number: the ledger's
highest migration against the last file of the tree this server was built from.
`current` says they are equal — not that every file below it was applied as
written: a skipped, renumbered or edited migration is what `migrate.ts --dry-run`
lists, file by file (SMD-2069 compares the two lists). Between release cuts the
version stays the last cut's; `unreleased` names the migrations this tree adds
past its range. The audit count is the event log's size — every capture, edit and
delete, deleted thoughts' included — not a count of thoughts. `Database size` is
the whole database's. The server's embedding and the brain's are printed side by
side without a verdict (preflight's embedding rows judge them; SMD-2071).
`Board sync` is the board-sync watermark (SMD-2261): the newest Linear
`updatedAt` any thought carries in `metadata.linear_updated_at`, which
`db/sync-linear.ts` writes, in UTC. It reads `none — no thought carries a usable
Linear watermark` when none counts (a malformed value, or one more than an hour
past the database's clock, is passed over), and `?` when the read did not answer
(named in `Not read`). It is a
high-water mark — the newest board move the brain reflects, not proof it reflects
every one before it — and a quiet board leaves it old on a current brain.
`tier.ts --compare` diffs it between two brains. `Workers` is each long-running
worker's heartbeat (SMD-2261): alive, running a pass, stopped, or stale past
three of its intervals, with the last pass's outcome and a tripped malformed
alarm; preflight's `workers` row warns on the same and names the restart
(`db/README.md`, "Long-running workers report their liveness").
`Proposals` and `Relations` are what consolidation found (SMD-2680), so a sleep
pass's findings show without a query. `Proposals` is the queue a reviewer works:
how many are pending, how long ago the oldest was judged (a pass that re-judges
a stale proposal restarts it), how many pair two tickets the board does not link
— filed under two different tickets, `metadata.ticket` else `metadata.issue`,
with no active Linear link between them now (079's `child_of`, `blocks`,
`blocked_by`, `relates_to`, and a `duplicate_of` either way), so a link made
after a verdict takes the pair out; not counted before 079 — and the stale
ones; `none pending` when there is none.
`consolidate.ts --list` and the `list_supersession_proposals` tool list them —
one pass's alone with `--key` or `judge_key`, the pass key each proposal names
(109), a page at a time with `--after` (pages of 50) or `after` (up to 200), the
cursor the page before ended with, under the filters it was made with (110) —
and preflight's `proposals` row warns once the oldest has waited past
`OB1_PROPOSALS_WARN_DAYS` (7). `Relations` is the judged relations standing
(084) by word, with their board pairs counted the same way; nothing waits on
one, so nothing warns (`consolidate.ts --list relations` shows them); `none
standing` when there is none, `none — migration 084 is not applied` before 084.
Since 102 the pairs judged distinct follow, `; N pairs judged distinct`: near
neighbours the judge called unrelated, kept apart (SMD-3117) — not in the
relations' count, never a board pair, and not said when there is none.
A board count counts rows — proposals, relation facets — not distinct pairs of
tickets: five proposals between two tickets' thoughts count five, and a pair
can be in both counts; `board pairs ?` says the count was not read. Each reads `?` when its read did not
answer and `no table` before its table's migration.
`Findings` is what became of the findings board-sync posted to the board
(SMD-2681's `board_findings_posted`, SMD-2682), one per ticket pair and word
this brain posted: accepted (its proposal accepted, or the board linking the
pair since — any active Linear link either way, `duplicate_of` included),
rejected (a person rejected one of its proposals, none pending or waiting on a
re-judge — a link since does not undo that no), withdrawn (its proposals gone, or settled by
the consolidation pass's own re-judge, or a relation the judge stopped saying,
within the window), open (a proposal pending, or stale and not settled since it
was last asserted, or a relation standing), or unanswered once open past 30 days
from the post — a finding the judge takes
back after that stays unanswered, and one deleted with its thought, which
leaves no time, is unanswered once its comment is past the window. What the
judge last asserted decides (SMD-2913): the pass's settles are kept across 067's
reopen (migration 091), so a finding taken back within the window stays
withdrawn when a text move reopens it; a re-judge that finds the conflict again,
or a relation said again, makes it open once more — unanswered at once when the
post is past the window. The row reads `? (migration
091 is not applied)` on a brain without it. The rate is
accepted over accepted, rejected and unanswered — an unanswered finding counts
against it; withdrawn and open are left out — and the median is from the post to the first link since or the
review. A link Linear made before the comment but board-sync brought in after
it (a `--full` pass) counts as an answer: the brain cannot tell the two. Rows
another poster's marker settled are counted apart, never in the rate. A stats
read, as `Relations`; `no table — migration 087 is not applied` before 087.
`db/board-findings.ts --report` lists the same rows one by one.

**`GET /health` with a read or write key** (the `x-brain-key` header, a bearer
token or `?key=`) answers the same record as JSON — `version`, `releaseRange`,
`unreleased`, `latestMigration`, `commit`, `store`, `tier`, `embedding`,
`ledgerStatus` (`current` | `behind` | `ahead` | `null`) and `database`, which carries the
database's facts (the ledger as `{ present, readable }`, not its names; the
watermark as `boardSync`, an ISO instant or null; the long-running workers'
heartbeats as `workers`, `{ heartbeats, ignored }`, SMD-2261; the queue as
`proposals`, `{ pending, stale, oldestPendingS, boardPairs }`, and the standing
relations as `relations`, `{ related, evolves, duplicate, distinct, boardPairs }` (`distinct` since SMD-3117: the pairs judged apart, outside the three and the board pairs); what
became of the findings posted as `findings`, `{ posted, comments, found,
accepted, rejected, withdrawn, open, unanswered, windowDays, medianAnswerS }`,
SMD-2682; each null when not read or absent; each `boardPairs` is a read of its own, last,
null with `proposals.boardPairs` or `relations.boardPairs` in `unread` when it
did not answer, null with no entry before 079 (or when its field was not read),
and 0, not read, when there is nothing to count, SMD-2680) or
`{ "error": … }` when it cannot answer. Beside the record, `oauth` is the
server's own view of its public origin (SMD-2382): `{ configured, origin,
advertised }`, which `deploy/smoke.sh` compares with what reaches it. It answers within 2.5 s
(`HEALTH_DEADLINE_MS`) whatever the database does — still a 200, since the
process is serving. A database that refuses at once is `database.error`; one
that never answers (a dropped route) leaves the agent registry unanswered too,
and the body is then the literal `ok`, as for a key the server cannot vouch for
(below); tables locked by a migration cost their lock waits — one per table:
once a read of one table alone is refused its lock (on the table or one of its
indexes), a later read that touches it is named in `unread` as not tried rather
than waiting again. The
read is one transaction whose statements are capped at 800 ms and whose lock
waits at 300 ms (never above a stricter setting the role already has), a read
that does not answer is named in `unread` with its reason (`refused`,
`timeout`, `deadline`, `invisible`, `error`), the facts read by the deadline
are kept, and a database whose catalog has not answered by then is
`database.error`. Concurrent probes share one read, and requests of one key share
one agent-registry lookup (at /health and the MCP route alike), so a burst during
a migration holds one connection for the read and one per distinct key. On
the SQL store each of the lookup's lock waits is capped at 250 ms (a ceiling;
a table lock ends the lookup at its first wait), and a lookup that times out
is retried for up to 2 s, 250 ms apart with no connection held — a brief
migration lock is waited out, as before the cap — after which the key is
**busy**: the MCP route refuses it with JSON-RPC error `-32003` ("retry in a
few seconds"), since the registry could still say revoked. More cold keys
than the pool holds queue for it, in rounds of about the cap. A
revocation this process has already read stands through any failure until
the registry answers that the key is not revoked (SMD-2072). Since migration
054 a key used in the last five minutes and presenting its recorded scope
writes nothing, so a transaction holding its row no longer makes it wait,
and a serialization failure (40001, under a REPEATABLE READ or SERIALIZABLE
default) is retried like a lock timeout (SMD-2090). A lock on
`ob1_agents` stalls every write regardless: 046's audit trigger reads a
writer's kind there. Without a key, with a wrong
or capture-only key, with a revoked one or a busy one — or while the agent registry has
not answered by the deadline, since it could still say revoked — the body is
the literal `ok`, so nothing about the deployment reaches an unauthenticated
probe; a `HEAD`, keyed or not, is the bodiless `ok` and reads nothing. Point a
platform's liveness probe at the keyless form. `deploy/smoke.sh`'s check 10
reads the keyed body.

Where each fact comes from: the version, its release range and the tree's last
migration are generated into `version.ts` by `scripts/gen-version.ts` (the
image carries no `db/migrations/` for the server to read; check-fork's 17e round-trips the file, and in a
checkout preflight's `version module` row compares it with `db/migrations/`, so
rerun the script after adding a migration). The commit is the image's
`OB1_GIT_SHA` build arg (`deploy/README.md`), `unknown` when unset. The database's
half is `brain-info.ts`'s `readDatabaseFacts`, the same read preflight's
`vector extension`, `migration ledger` and `schema version` rows make, so the gate
and the tool cannot disagree (preflight skips the counts and size, which it does
not use). Each read that a role or a lock can refuse has a savepoint of its own:
a role without `SELECT` on, say, `ob1_entities` or `schema_migrations` gets that
field as unread, named on a `Not read:` line, and the rest still answers; a table
that exists where the role cannot resolve it (off its search path, or no USAGE on
its schema) is `invisible`, never "no table". The tool's statements are capped at
5 s and its whole read at 15 s.

## Other read surfaces

Beside `brain_info`, the read scope carries a few keyed, read-only tools a client
discovers through `tools/list` (a capture-only key sees none of them):

- **`list_thought_ids`** (SMD-2244) — the corpus's thought ids, id-only, keyset-paged,
  with a first-page md5 digest, for a cheap cross-brain id-set diff.
- **`list_thoughts`**, a page at a time (SMD-2995) — `sort` newest (the default) or
  oldest, and `after`, the cursor the previous page ended with, keyset on
  `(created_at, id)` in `thoughts_created_at_idx`'s order (undated first, newest
  first). The cursor holds the sort it was made under and Postgres's own text of the
  last `created_at`, so a walk sees each thought there when it began once, to the
  microsecond (newest first, one captured meanwhile is not among them; oldest first,
  it comes at the end); a cursor of the other sort, or none of this tool's, is
  `REFUSED_CURSOR` (an empty one too). The reply's `cursor` is null when no more follow.
- **`list_logged_searches`** (SMD-2245) — the `query_log` search rows (query, arm,
  arguments), most recent first and `since`-windowed, for a log-sourced replay.
- **`worker_status`** (SMD-2131) — the background-work queues over
  `thought_work_claims`, one row per `work_type`: pending / claimed (in flight,
  INCLUDING stale) / succeeded / failed, how many thoughts are unpooled, the corpus
  total, the stale-lease count with its oldest lease's time and holder, and whether the
  pool is the active one (`ob1_config.entity_extraction_key` or `reembed:<model>@<dim>`;
  `null` for consolidate). Read-only.

`worker_status` also has a keyed **`GET /worker-status`** — the same authentication as
`/health` (a read or write key gets the JSON array, a capture/wrong/no/revoked key or a
`HEAD` gets the bodiless `ok`), so an operator can read the queues with a `curl` the way
they read `/health`. It is a parallel route, deliberately kept out of the `/health`
BrainInfo body: the queue read is SQL-only and stays off the health path's identity
budget and its both-backend contract.

## Worker-queue write actions

Three **write-scoped** tools act on the same queues (SMD-2132, SMD-2272) — the control
plane over the existing claim machinery (migration 015), never a worker or a scheduler,
and never the LLM drain itself (the server does not run the bulk passes; executing a
drain waits on a callable worker core, SMD-2304 — `run_worker` below is its preview half
only). A read or capture key does not see them. The two mutating actions each stamp the
calling key as actor into the action log, one row per affected thought; `run_worker`'s
dry-run preview mutates nothing, so it stamps none:

- **`retry_failed(work_type)`** — requeue one pool's `failed` claim rows to `pending`
  (the `db/*.ts --retry-failed` path), scoped to the one `work_type`; a fresh attempt
  clears the recorded error and the attempt count.
- **`release_stale_leases(work_type?, worker_id?, include_live?)`** — return `claimed`
  rows whose lease has lapsed (a dead worker's, past `ttl_expires_at`) to `pending` — the
  manual form of the lazy reaper. By default a live lease is left for its holder;
  reaching one needs `include_live` **and** a `worker_id`, because releasing a live lease
  risks the holder double-processing (refused as a value otherwise).
- **`run_worker(work_type, dry_run, limit?)`** — the third action SMD-2132 carved out,
  for now a **preview only**: `dry_run: true` reports, without claiming anything, what a
  drain of the pool would process — the same census `worker_status` shows plus a
  `backlog` and a `limit`-bounded `wouldClaim` (exact for an extraction pool, an upper
  bound for reembed/consolidate, whose eligibility is model-aware). A call without
  `dry_run: true` is refused as a value (`RUN_WORKER_DRAIN_NOT_AVAILABLE`) — the executing
  drain waits on the callable core (SMD-2304), so it writes no action-log row.

Each is mirrored by a keyed **`POST`** — `POST /worker-retry-failed`,
`POST /worker-release-leases` and `POST /worker-run` — with the args in the JSON body,
gated by a **write** key (stricter than the read routes; a read/capture/no key gets the
bodiless `ok`).

## The operator's label reset (SMD-2744)

**`reset_capture_stamp(id)`** is a **write-scoped** tool for the operator alone: the key
must be one the registry classifies `operator` (`set_agent_kind`), and the database
decides that, since the server does not hold a key's kind — so every write key sees the
tool, and any write key the operator has not classified `operator` is refused
(`REFUSED_NOT_OPERATOR`, 403 over REST). A read or capture key does not see it.

It undoes migration 085's one move on a capture-only key's label (SMD-2664). There, the
first classified key that can read to re-capture the text either moves the label to
itself or records a decline that settles the row against every other key — and a label
settled or moved by the wrong key, or by a name-only decline written while the registry
lookup failed, had no way back that kept the thought. The reset (migration 086's
`ob1_reset_capture_stamp`) clears the declines and the restamp since the row's last
reset, puts the capture-only key's label back where a restamp moved it — derived from
its capture as the backfill derives it, so a key demoted since comes back down and a
pass after finds nothing to change — names the keys whose move or declines it undid
(the operator's own included), and records one event in the operator's name. The next
re-capture by a key that can read is then weighed again, so the operator re-captures
the text straight after, exactly as stored (`fetch` shows an outside text under a
notice line that is not part of it; REST `GET /v1/thoughts/{id}` gives the content
alone). The reply gives the ways on by the trust the row is left at: plainly, the
label moves to the operator's key at trust operator; with `trust: "ingested"`, a label
at `ingested` or `agent` stays as it is and the row is settled against every other key
(not the operator's own: its later plain re-capture still moves it) — at `ingested`, the
way to keep outside text that another key lifted labelled as outside text — while a
label with no trust moves to the operator's key at `ingested`; a label at `operator` no
re-capture moves, and the reply asks for none. A thought whose label is not
a capture-only key's — another key's capture, or one from before the scope mark — is
refused (`REFUSED_NOT_CAPTURE_STAMP`, 409), and so is one whose text changed since,
once something settled it; one with nothing to reset is left as it is, and the reply
says so. Over MCP, a key that is not the operator's is refused by name and kind — an
unclassified one given the `set_agent_kind` line that would classify it, a classified
one told to use the operator's own key — and a database before 086 is named in the
fault; the REST core answers the code and its status. `thought_changes` reads the event
as "reset by <key>", and a decline's line names the reset as the way out.

## A write copied to another brain: `client_key` (SMD-3314)

A thought captured on two brains separately gets two ids, while an edit, a delete or a
`supersedes` names a thought by the id the brain that made it gave it. A client that
repeats a write on a second brain (the canary, SMD-2872) passes **`client_key`** on
`capture_thought`: a UUID, by convention the thought's id on the brain where it was
first written. The copy keeps it as `metadata.client_key`, one thought per key
(migration 112's unique index), and every name a write takes resolves to **the thought
with that id, else the one keeping it as its key**: `update_thought`'s and
`delete_thought`'s `id` (and the REST paths `PATCH`/`DELETE /v1/thoughts/{id}`), and
the `supersedes` and `derived_from` of a capture or an edit. So the client sends the
second brain the same ids it sent the first. A thought a refresh copied has the same id
on both brains, and a key equal to it names that thought.

- **A key that names a thought already** (as its id or its key) returns that thought
  and writes nothing, with no model call: `Already captured — id …`, `keyed:
  "matched"` beside it (REST and MCP alike). A retried copy, or copies racing under one key, make one
  thought; the loser of a race is answered the same way.
- **A key naming the thought that holds this very text** is a re-capture of it
  (`keyed: "recaptured"`): merged as any write key's re-capture is (080), the key not
  sent again, so the copy takes what the first brain's re-capture merged.
- **A key that names nothing** is kept on the new row (`keyed: "recorded"`), and on
  a re-capture of text already a thought it is merged onto that row, as 080's merge
  takes a write key's metadata. A row already keeping another key keeps it
  (`keyed: "held"`, with `heldKey` when it is a key's shape): the reply says the
  key given was not recorded and names nothing here.
- **Only a key that can read** sends one. A capture-only key is refused
  (`REFUSED_CLIENT_KEY_SCOPE`, 403 over REST), as the match would tell it whether an id
  exists (SMD-1298), and its names stay ids. A key that is not a UUID is
  `REFUSED_CLIENT_KEY_SHAPE` (400).
- **The key is set once.** `metadata.client_key` in a capture's `metadata`, or a
  `metadata_patch` naming it, is `REFUSED_METADATA_SHAPE` (`reserved_key`). A deleted
  thought's key goes with it, and is free again. Keys are kept and compared in lower
  case: a `client_key` a caller's metadata set in upper case before 112 names nothing.
- An edit or a delete that reached its thought by a key says so (`, named by its
  client_key …`, `byClientKey` beside it); one by the thought's own id says nothing.
- **A key is set once**, in the database too: migration 112's trigger refuses a write
  that would give a keyed row another key (two keyed copies of one text racing past the
  servers' read of the row), with the write's event, and the server captures it again
  without the key and answers `held`. A name that is no uuid is `NOT_FOUND` for an edit
  or a delete.
- **What is named:** only a thought that has a name's id, or keeps it as its key.
  Reads (`fetch`, `GET /v1/thoughts/{id}`) take ids alone. A name that is both one
  thought's id and another's key names the one with the id. A thought each brain's own
  writers made (a board-sync row, a worker's output, anything captured before the copying
  began) has an id of its own on each brain, so a copied pointer to it resolves to
  nothing on the second brain and is refused there as an unknown id would be: a client
  copying writes drops such a pointer, or the write, on that brain. A copied edit drops
  the first brain's `if_unchanged_since` too, which the second brain's own `updated_at`
  never matches; and it keeps the first brain's order (a capture before the edit or
  delete of it), or a late capture after a delete would bring the thought back.

## Where a tool's logic lives (SMD-2283)

A tool is three pieces, so that the REST core (SMD-2284) calls the same logic the
MCP tools do rather than a copy of it:

- **`core/`** — what the tool does, with no MCP types and no prose. `core/schemas.ts`
  holds every tool's title, description, behaviour hints and zod input schema, keyed by
  the manifest's names (`tools.ts`). `core/reads.ts` holds the read operations, each a
  function of the caller's principal and its typed input: the search operation with its
  egress gate and query log, the store reads, `brain_info`'s shared read, the job tools.
  `core/writes.ts` holds `capture_thought`, `update_thought`, `delete_thought` and
  `reset_capture_stamp`: the shapes, a capture-only key's trimmed provenance and owned
  pointers, the egress gate, the model calls, the write and its cites. `core/workers.ts` holds the worker actions
  (`retry_failed`, `release_stale_leases`, `run_worker`'s dry run), which the keyed REST
  POSTs (`/worker-retry-failed`, `/worker-release-leases`, `/worker-run`) call too. Each
  returns its typed value or a typed refusal (`core/refusal.ts`: a `code`, whether it is
  `retryable`, and the facts to say it with), and throws a fault. `core/context.ts` is what they run against: the store,
  the provider settings and the one embedder, the query log, the door a write records.
- **`render.ts`** — the words: each tool's reply rendered from that value, the text the
  tools have always said.
- **`api.ts`** and **`rest/`** — the REST core: the routes, authentication and the
  JSON answer, which the MCP server (`mcp-server/`) renders with `render.ts`. It
  builds no store and makes no egress or embedding call: it hands root.ts's readers to
  the core, says it serves (`serveHere()`) and closes the store at a stop. Until
  SMD-2287 PR 6b, `index.ts` joined the two for MCP the same way: validate (the SDK
  ran the spec's schema), call the operation, render.
- **`mcp-edge.ts`** — what the MCP endpoint answers around the SDK's transport:
  - the methods it serves and its CORS headers;
  - the JSON-RPC refusal envelopes, and a notification's bare 202 or 503 (SMD-2106);
  - the public origin's challenge and its 503 (SMD-2382);
  - the bounded read of a refused body;
  - a request's parts and its calls' record for its line;
  - the stop's cut line;
  - the keyed mirrors' answer to a caller they show nothing.

  It is HTTP alone, with no store, no provider and no environment. It was moved out of
  `index.ts` as it was (SMD-2287 PR 2), so the MCP server as a REST client answers at
  its edge as that one did.
- **`root.ts`** — the process root a serving entry builds on (SMD-2284): `type Env`,
  the one list of what the container's process reads; `initEnv()` and `env()`; the
  store's wiring — `db()` builds it and wires the job sink, `closeStore()` closes it at a
  stop; and the agent registry the keys are looked up through. `sse.ts` keeps an event
  stream alive while a call runs (SMD-1864). Both were moved out of `index.ts` so the
  REST core (SMD-2284) could build on them rather than on a copy.
- **`telemetry.ts`** — the one JSON line written per request, on every route of both
  servers but the keyless liveness probe (SMD-1849), from one per-request record
  each server's first middleware makes (notFound, for a path that middleware
  never sees): its keys an allow-list, each value held to its rule as the line is written, so no
  URL, key, argument or thought text reaches it (`deploy/README.md`, "What the
  servers log"). The same record is the request's OpenTelemetry span, a point
  on the request-duration histogram and a log record, and each tool call a span
  under it — the request's attributes the line's checked values, a call's its
  own outcome and code, a fault its kind and code — the API's no-ops until
  `OTEL_EXPORTER_OTLP_ENDPOINT` (or a signal's own variable) names a collector
  (`deploy/README.md`, "Traces, metrics and log records").
- **`spans.ts`** — the spans a provider call (`embed.ts`'s `providerCall`,
  preflight's `--deep` probes), a store operation (`createStore`'s store), a
  job's body (`startJob`) and a webhook's deferred work (each of the last two a
  trace of its own, linked to what started it) run under, a provider call's
  and a store operation's point on their histograms and a job's on its own, and
  `faultOf`. It imports nothing — `embed.ts` and `store.ts` are imported by
  `db/`'s workers and `evals/`, which install no package of this directory's —
  so a span there is nothing until `telemetry.ts` installs **`tracing.ts`**, the
  OpenTelemetry API's spans, as a server, or preflight under `--deep`, loads it.
- **`otel-setup.ts`** — the OpenTelemetry SDK for traces, metrics and log
  records, loaded only then: an OTLP/HTTP exporter for each signal with a URL,
  spans and log records batched, the AsyncLocalStorage context manager and the
  W3C propagator.

`scripts/check-fork-consistency.ts` check 25 is a tripwire on `api.ts`, `rest/`, `mcp-edge.ts`
and `root.ts` for what a move would leave behind: an import outside the file's list, a
SQL call or `fetch`, the store named outside `root.ts`'s wiring.

Every tool's reply carries a typed answer as `structuredContent` beside the text.
Claude Code, VS Code and Codex show the model `structuredContent` alone when it is present, so:

- A tool whose text is its value's JSON (`search`, `fetch`, `list_thought_ids`,
  `list_logged_searches`, `worker_status`, `job_status`, `scan_thoughts`, the three
  worker actions) answers the value itself. A value is always an object, so
  `worker_status`'s rows ride under `pools` while its text stays the bare array.
- A tool whose text is prose answers its `text` plus fields that cannot carry a
  word a thought, a key or a judge wrote: ids, timestamps, counts, scores, booleans,
  enum codes (a search hit's id, scores, `supersededBy` and demotion reasons; a
  change's id, action, thought id and pointers; the stats' totals; a capture's id,
  whether it was already a thought — a reader's to know — and whether its embedding
  call was made; an edit's id, `updatedAt` and what moved). Every such word reaches
  the model through the text, cleaned and bounded there as it always was.
  `render.ts`'s `guard` holds each such string to the shape its field's name
  promises — a time, a uuid, or one enum token — and nulls anything else, so a
  field typed as a time but filled from a thought's metadata (prefer_current's
  `window.syncedAt`) cannot carry a sentence.
  `brain_info` answers its whole record beside the table: it holds the
  server's and the database's own facts, and one value read from thoughts'
  metadata — the board-sync watermark, which the read itself holds to one shape
  (a UTC instant to the millisecond, never past an hour from now by the
  database's clock) or leaves null — and the workers' heartbeats, rows any role
  with the worker group can write, which `parseHeartbeats` carries only in full
  (a known worker's key and job of a bounded alphabet, counts, the enums as
  written, the database's own instant) and otherwise counts as ignored.
- A refusal answers `{ code, retryable, text }`. The reads': `NOT_FOUND`,
  `REFUSED_FILTER`, `REFUSED_EGRESS` (with its `rule`), `REFUSED_SINCE`,
  `REFUSED_CURSOR` (list_thoughts' with its `reason`, `shape` or `sort`, and for
  `sort` the one the cursor was made under). Capture's: the pointer and metadata shapes
  (`REFUSED_SUPERSEDES_SHAPE`, `REFUSED_DERIVED_FROM_SHAPE`,
  `REFUSED_METADATA_SHAPE` with its `problem`, and the `key` unless the key itself
  is malformed; a capture-only key is refused the keys a ticket's lifecycle is read
  from, `issue`, `ticket`, `status`, `status_type` and `linear_updated_at`,
  SMD-2617, SMD-2657), SMD-1978's pointer
  codes (`DERIVED_FROM_MISSING` with a reader's `positions`, a reader's `REFUSED_SUPERSEDES_UNKNOWN`,
  `SUPERSEDES_UNJUDGED`; a capture-only key's `supersedes` it cannot prove its
  own is dropped, not refused, SMD-2473, and a thought another key or board-sync
  has since taken, or that something already supersedes, is not its own, a
  pointer written before the taking lapsing, migration 082, SMD-2638). An
  edit's and a delete's: `NOT_FOUND`, `REFUSED_NOTHING_TO_UPDATE`,
  `REFUSED_SUPERSEDES_SHAPE`, `REFUSED_STALE_READ` (with the row's
  `currentUpdatedAt`, to retry from without a re-read), `REFUSED_DUPLICATE_CONTENT`,
  `REFUSED_SUPERSEDES_UNKNOWN`, `REFUSED_WOULD_CYCLE`, `REFUSED_CITED` (with
  `citedBy`), and `REFUSED` for a refusal the store names that this server does not
  know. The worker actions': `REFUSED_EMPTY_WORK_TYPE`, `REFUSED_LIVE_LEASE_NEEDS_WORKER`,
  `RUN_WORKER_DRAIN_NOT_AVAILABLE` — the codes their REST POSTs answer as a 400. Which
  facts a refusal carries is declared beside its code (`core/refusal.ts`'s `FACTS`),
  so a new code does not compile until they are.
- A fault answers `{ code: "FAILED", text }`, with no `retryable` yet —
  classifying faults is SMD-2461 — except capture's, `STORE_UNAVAILABLE` and
  retryable, which the session hook keys on (SMD-1978).

The core's values are whole, for the REST core.

## The REST core (SMD-2284)

`bun api.ts` serves every operation the tools expose as JSON, over the same core and
the same process root (`root.ts`) as the MCP server. In the stack it is the `api`
service — the server's image with `command: ["api.ts"]` — reached as
`api.ob1.internal` on the mesh, and at `/api` through the proxy only where the
operator names `deploy/compose.api-public.yaml` (`deploy/README.md`, "The REST core
and its opt-in `/api`"); there the links it answers carry the `/api` the proxy
stripped (`X-Forwarded-Prefix`).

- **Routes** come from `rest/routes.ts`, one per tool in the manifest (a tool
  without one does not compile): `GET /v1/thoughts`, `GET`/`PATCH`/`DELETE
  /v1/thoughts/{id}`, `POST /v1/thoughts`, `POST
  /v1/thoughts/{id}/reset-capture-stamp`, `POST /v1/search` (and `/keyword`,
  `/compat`), `GET /v1/stats`, `/v1/changes`, `/v1/thought-ids`,
  `/v1/logged-searches`, `/v1/proposals`, `/v1/brain`, `/v1/workers`, `POST
  /v1/workers/retry`, `/release-leases`, `/run`, `POST /v1/scans`, `GET
  /v1/jobs/{job_id}` and its `/stream`. A GET or DELETE reads its input from the
  query string, a POST or PATCH from a JSON body, and input sent the other way is
  refused; a search's text always rides a body. The input is the tool's own zod schema
  (`core/schemas.ts`), held strictly: an unknown field is refused. A GET whose headers
  announce a body is refused too (Bun hands a GET's handler no body, so its input would
  vanish). A HEAD answers what the GET would before it looks anything up — the caller's
  standing and the input as the schema holds it — with the GET's content type and no
  body, and never runs the operation, so a HEAD for a thought that is not there, or with
  a `since` or `after` the operation itself would refuse, is still a 200. A method a path
  does not take is a 405 naming those it does.
- **`GET /openapi.json`** is built from the same two sources, so it lists every
  operation with the input its route parses. **`GET /v1/whoami`** names the
  calling key, its scope, its agent id and the operations it may call, and — forwarded —
  its `act`.
- **Authorization** is the key's: `x-brain-key`, `x-access-key` or `Authorization:
  Bearer` — never `?key=`, which only URL-only MCP connectors need. No key or a
  wrong one is a 401 `UNAUTHORIZED`, a revoked one a 401 `REVOKED`, a busy registry
  a 503 `BUSY` with `Retry-After`, a scope that does not reach the operation a 403
  `FORBIDDEN` naming the scope it needs.
- **The authorization server's tokens** (SMD-2286, `oauth-token.ts`): on a stack
  with the `auth` profile and a sound `OB1_PUBLIC_ORIGIN`, an `Authorization:
  Bearer` JWT that no key matched is checked as a token issued for
  `<origin>/api`. Its `brain:` scopes act as a key's scope, and the caller is
  `oauth:<sub>+<client>`, the subject and the client it signed in through (the
  connector an exchanged token nests in its `act`), or a service's
  `oauth:<sub>` alone: a principal per client, with its own registry row
  (SMD-3064). A token this server does not accept is a 401 `UNAUTHORIZED` with
  `credential: "token"`. A valid one whose scopes name no key scope is a 403
  `FORBIDDEN` with `credential: "token"` (`insufficient_scope`). One it has no
  signing keys for is a 503 `BUSY` with `credential: "token"` and `Retry-After:
  30`; one whose principal the registry revoked, a 401 `REVOKED` with
  `credential: "token"`. Elsewhere a token is an unknown key.
- **Forwarded** (SMD-2284, the ADR's decision 7): beside a caller's key, the
  `x-brain-forwarder` header carries the key of whoever forwarded it — the MCP
  server's, a `forward`-scope key that grants nothing (`keygen.ts --scope
  forward`). The caller's key still decides everything; the forwarder is
  recorded as `act` (`{name, agentId}`) — on every thought write's audit row
  (`thought_audit.actor_context.act`) and in `whoami`; the action log, jobs and
  the query log keep the caller's id alone. Anything but a forward-scope key in
  that header, an empty one or two of them included, is a 401 `UNAUTHORIZED`
  with `credential: "forwarder"`, checked before either key reaches the
  registry; a revoked one a 401 `REVOKED`, a busy registry a 503, each with the
  same — so a client holding two keys cannot stamp one as the other's carrier. A
  request it carries is answered its refusals and its captures whole (SMD-2287), the
  words the MCP server says them in, which the caller's key alone is not told over
  REST: a forwarder key is the MCP server's alone, never an integration's.
  The public `/api` route deletes the header, so it is read only inside the
  stack (`rest-client/` sends it, and nothing in the stack does until the MCP
  server forwards, SMD-2287). Mint a forwarder under a name never used before —
  the registry reads a known name with a new digest as that agent's rotation.
- **Answers.** A success is the operation's value, for a key that can read (a capture
  is a 201 with its `Location` and `embeddingAttached` — whether this capture wrote its
  vector with the row, false when the egress gate refused the embedding call or the
  provider did not answer it, `vectorFailed` saying why (on a re-capture the row then
  keeps any vector it had); a scan a 202 whose handle points at
  `/v1/jobs`). A capture-only key is told what the MCP tool tells it — the id,
  `embeddingCall`, `chunks`, `contextFailures`, `vectorFailed`'s word — and not the provider's address, the
  egress gate's reasons or the extractor's tags — unless a forwarder carried the
  request, which is answered the whole value for the MCP server to word for that key,
  as a refusal is (SMD-2287). A refusal is its code, `retryable` and the facts its code declares
  (`core/refusal.ts`'s `FACTS`), never the caller's input or the store's words, at
  the status `rest/routes.ts`'s `REFUSAL_STATUS` gives it: 400 a shape to mend, 403 a
  rule, 404 nothing there, 409 a conflict, 422 a reference to nothing, 501 a mode
  not built, 503 retry. Carried by a forwarder, a revoked or busy caller's key is
  named (`name`), for the MCP server's line (SMD-2287 PR 4b), and a refusal also holds itself whole
  as `refusal` — its words included, the caller's input quoted back and the
  store's or the egress gate's — so the MCP server says it as it always has
  (SMD-2287). It is the refusal as the operation made it for that caller, the
  existence-oracle rule applied: what `render.ts` has always been handed, and
  bounds into its text. A refused input is a 400 `REFUSED_INPUT`
  naming each field and zod's reason. A fault is a 500 `FAILED` with its message, as the MCP tool's text
  gives it, and no `retryable` until SMD-2461 — but capture's is a 503
  `STORE_UNAVAILABLE`, retryable, the verdict the session hook keys on. Every 503
  carries `Retry-After`. Loose core inputs that reach Postgres (a non-UUID id
  on update or delete) are still faults through both doors (SMD-2534);
  `list_thoughts`' limit, `days` and `after` are bounded in its schema since SMD-2995.
- **The log** is one JSON line per request (`telemetry.ts`, SMD-1849) — the
  method, the route's template, the operation, the key's name, the status, an
  error answer's code and the time — with no query string, key, id or content
  in it.
- **The idle timeout** is Bun's ceiling, 255 s (`api.ts`'s `IDLE_TIMEOUT_S`): on Bun
  1.4.3 the 10 s default cuts a GET whose handler has not answered — measured, a
  14-second GET reset at about 12 s while a POST ran on — and the MCP server's
  whoami, fetch, stats and job polls are GETs a locked table can hold that long
  (SMD-2287). A dead keep-alive socket on the stack's internal network is held up to
  255 s.
- **`GET /health`** is liveness with no key, for the container's healthcheck, and
  writes no line. With a key it answers as `index.ts`'s `/health` did: the brain's
  record on the health surface (statements capped, within `HEALTH_DEADLINE_MS`) for a
  key that may read `brain_info` and that the registry clears in time, and liveness
  for any other key, never a refusal. The MCP server as a REST client (`mcp-server/`,
  SMD-2287) shows that record at its public `/health`. The tool's record, on the slower
  tool surface, is `GET /v1/brain`. A write through the REST core records its door
  as `open-brain-api` (thought_audit.origin).
- **Jobs** are durable as the MCP server's are (069's `jobs`), and its own: each server
  writes its door on the jobs it starts (`jobs.door`, migration 078) and its start-up
  reconcile marks only those lost, so the REST core and the MCP server on one database
  leave each other's live jobs alone.

`test-rest-sql.ts` runs every operation through both servers on one database, over
data each has something to say about, and holds that the MCP reply to a success is what
`render.ts` makes of the REST answer, text and `structuredContent` both — so every word
MCP shows is in the REST answer, which may carry more — and that a refusal is the same
code and facts through both. A refusal's MCP text reads words its facts leave out (the
caller's input, the store's words), so the suite also sends each refusal through the
forwarder slot and holds that render.ts makes of the `refusal` it carries exactly the MCP
reply, for every code that section reaches. Each renderer reads only the outcome it is
handed, so a refusal whole is all the MCP server as a REST client (SMD-2287) needs to
word any refusal as this one does.
`rest-client/` is the REST core's typed client, generated from its OpenAPI document.

## Expected outcome

```bash
bun test-server.ts        # 1224 — transport, auth, tool surface, OAuth discovery and the public origin's challenge, the method guard, /health, the store default, the tool-call keepalive, the stop on SIGTERM and a tool call past its client waited on by the MCP server's, the replies' fenced text and one-line metadata, the legacy route's marker read no more, a proposal's one-line reason and note, the board-sync watermark's shape, the heartbeats' parsing, the proposal queue's and the relations' counts and rows, what became of the findings posted and its row (SMD-2682), one lock wait per table, a `Host` the URL parser refuses, or none, the request line's allow-list and its one line per request, the spans, the request-duration histogram and the log record, a provider call's and a store operation's spans and points, a job's and a webhook's deferred work's traces, the budget for requests no key was accepted for (SMD-1849), a monitor's keyed HEADs outside it, a tool call one trace, the uptime gauge (SMD-3050), the stop's telemetry flush under a bound of its own and what it cut said by signal, an export past its deadline and a partial success counted (SMD-2902), a list cursor through structuredContent at its own field alone (SMD-2995), preflight's telemetry row judged by each line's kind (SMD-2909), a whole-number setting ignored or held said without its value (SMD-3235), the stop's telemetry mark taken at its signal (SMD-3297), the address OB1_LISTEN_HOST names, every stub and child on 127.0.0.1 (SMD-3323), through the MCP server as a REST client and its own entry (mcp-server/, SMD-2287)
bun test-auth.ts          # 191 — scoped, hashed, named keys, through the MCP server as a REST client (mcp-server/, SMD-2287)
bun test-rest.ts          # 509 — the REST core's routes, OpenAPI, authorization ladder, its JSON request line and its spans, a forwarder's traceparent continued, over a stub core, `bun api.ts` stopped mid-request, and where it listens (OB1_LISTEN_HOST, SMD-3323)
bun test-plugins.ts       # 282 — plugins in the contract: manifests, OB1_PLUGINS, an operation through REST, OpenAPI, whoami and MCP behind the scope gate, ctx.call, the plugin login URL, the GUI's registry at GET /v1/plugins, and webhooks: verifyTimestamped, onceById, ctx.defer and the example's replay refusals, a plugin operation's span, a webhook fault's and its deferred work's, through the MCP server as a REST client (mcp-server/, SMD-2287)
bun test-thoughts.ts      # 845 — the pure rules, no database or provider: the type aliases, titles and URLs, the embed and chunk-context prompts, the extraction window and its parsing, the consolidate judge's verdicts and decide mode, chunking, the entity gate and genre, the provider's state and the vector mender, and a thought's own subject: its rules, its key and the question pinned by hash (SMD-3306)
bun test-jobs.ts          # 45 — the async job registry in memory: the lifecycle, ownership, the SSE frames, retention, the cap and the durable sink through a fake (SMD-2273, SMD-2318)
bun run test:local        # 226 — fully local provider, no credential
bun run test:sql          # 296 — store conformance, real Postgres in a container
bun run test:e2e          # 677 — the whole server over MCP with no Supabase at all, OB1_STORE unset, through the MCP server as a REST client (mcp-server/, SMD-2287)
../db/with-postgres.sh bun test-rest-sql.ts  # 269 — the REST core beside the MCP server on one database: every operation through both, each read held to a core of the suite's own in process, value for value, and capture, update and delete its rendering and its whole shape, a forwarded capture's too, every refusal's words from the forwarded answer
../db/with-postgres.sh bun test-plugins-sql.ts  # 116 — a plugin's tables: the migrator's plugin ledger and its lock, the plugin role's and the login role's boundary, the example's operations through both servers, its webhook's delivery ids, preflight's row
```

`test:sql`, `test:e2e`, `test-rest-sql.ts` and `test-plugins-sql.ts` need podman or docker; they use `../db/with-postgres.sh`
to start and remove a throwaway `pgvector/pgvector:0.8.6-pg16`.

## Testing

`test-server.ts` **imports the real server.** That is the point of this directory.

Upstream's Edge Function build, `server/index.ts` (in this fork until SMD-1800),
could not be imported by a test runner — it read `Deno.env` at module scope and
imported from `jsr:` — so the suites beside it reimplemented the server inline and
asserted against the copy. That is precisely how upstream's auth assertions came
to claim HTTP 401 for three months after the server started returning HTTP 200
([issue #487](https://github.com/NateBJones-Projects/OB1/issues/487)). The copy
kept passing.

The fork's first answer over there was a drift guard that grepped `index.ts` as
text, which detected the divergence but did not prevent it. Here there is nothing
to diverge from, so the guards are unnecessary and absent.

`test-e2e-sql.ts` goes further: it boots the real server with `OB1_STORE` unset —
the default store is what it drives — and `SUPABASE_URL` deleted from the
environment, and drives the tools over real JSON-RPC against real Postgres. Only the model provider is stubbed, so the suite
stays hermetic and free.

`test-egress.ts` holds the egress gate (SMD-1903): the policy's parsing, "local"
as a declaration, every term unit, a second opinion that can only refuse, the
three diallers refusing before any request reaches a counting stub — and the
real server under the default, where a capture from a key no term names lands
without a vector and says why at zero requests while the key a term names
reaches the stub. Every other suite that boots the server against a stub
declares it local (`OB1_LLM_LOCAL=1`), which is the upgrade every stack from
before the gate makes.

The three mirror suites went with the Edge Function build (SMD-1800): what they
asserted is this server's behaviour, tested on the server itself — the auth
envelope (`test-server.ts` [4]–[5]), `thought_stats` aggregated in SQL with no page
to fall off (migration 024, `test-e2e-sql.ts`), and the vector written in the same
statement as the row (`test-store-sql.ts` [2], `test-e2e-sql.ts` "the embedding was
stored in the same write").

## Caveats

- **The SQL store's pool is bounded** at `OB1_PG_POOL` (default 10). PostgREST was
  stateless HTTP, so nothing upstream limits concurrency any more — an unbounded
  pool would let a burst of captures exhaust the server's connection slots. Each
  enabled plugin with tables adds a pool of two of its own, opened at its first
  call (SMD-2310), so what a plugin's SQL leaves on a session never meets a core
  query: a server's budget is `OB1_PG_POOL` plus two per such plugin, and the
  stack runs two servers.
- **Auth is unchanged**, which means it is still a single shared key accepted from
  a header or a `?key=` query parameter. Moving runtimes does not improve that; see
  [issue #216](https://github.com/NateBJones-Projects/OB1/issues/216).
- **A tool call may run longer than the runtime's idle timeout.** Bun closes a
  connection that has been silent for its idle timeout — a streaming response
  included, at the next of its 4-second sweeps, so after 8 to 12 s of silence
  at the 10 s default — and the MCP transport opens a tool call's SSE stream at
  once and writes to it only when the tool returns. A capture whose model calls
  took ten seconds was closed under the client with nothing in the server's log
  (SMD-1864). Every event stream now carries a `: keepalive` comment frame
  every 5 s (`SSE_KEEPALIVE_MS` in `sse.ts`), a line SSE parsers discard by
  specification, for as long as the tool runs — up to ten minutes
  (`SSE_KEEPALIVE_MAX_MS`), past which the frames stop, one line says
  `request still running after N s: …` and, on Bun, the idle timeout reaps the
  stream (not logged again as a client leaving) — the MCP server's stream
  excepted, which its SDK transport's own 15 s frame keeps open until the call
  ends, at the same ten minutes (`REST_TIMEOUT_MS`); on Node it stays open
  until the client or a proxy gives up. A provider call is bounded by
  `OB1_LLM_TIMEOUT`, so a call that long is stuck in the database. The brain's
  servers serve with Bun's ceiling, 255 s, for their GETs (the idle timeout,
  above), and keep the keepalive for the proxy in front and a call past 255 s;
  the vendored MCP servers stay on the default (`sse.ts` says why, SMD-2931).
  The two intervals are constants, not knobs: 5 s is inside any proxy read
  timeout worth running (SMD-1846). A
  client that closes the connection before the response is complete is logged
  in words beside the request's JSON line (`telemetry.ts`, SMD-1849) —
  `request abandoned by the client after 9.8 s: tools/call capture_thought …` —
  by the method and tool the body names (each the caller's string, cut to 64
  printable characters), never by the arguments; the MCP SDK client gives up at
  60 s by default, so for a Claude Desktop-class client that is the line a
  stuck call produces, long before the ceiling. The call runs to its end on the
  server, and a retry of the same text is `upsert_thought`'s fingerprint no-op
  rather than a second row.
- **A stop finishes what is in flight, for the grace period less 2 s**
  (SMD-2250). On SIGTERM or SIGINT the server stops accepting, waits for the
  requests in flight (a tool call's stream included) and for the tool calls
  still running (one whose client has gone runs on, and a capture may still
  land), closes the database pool and exits 0: `docker compose stop api`
  returns in about 0.1 s idle, or when the last call ends. The wait is
  `OB1_STOP_GRACE` less 2 s (at least 0.5 s): the platform's grace period in
  whole seconds from 1 to 3600, no unit, 10 unless set (Docker's, so 8 s of
  drain). Compose appends `s` to the same variable for the server's
  `stop_grace_period`, so preflight refuses anything else (`30s` would fail
  compose itself, `1m` would be a 1 ms kill); set it to the platform's
  elsewhere (Kubernetes' and ECS's 30, Fly's `kill_timeout`). A call still
  running at the bound is cut off, the line says how many, an MCP call's own
  line says the stop cut it, and the exit is 1; a second signal cuts the wait
  short. The bounds count from the handler, so the stop inside Docker's 10 s
  grace period is measured (8.4–8.5 s for a cut at the bound; about 9.0 s
  where a telemetry collector that hangs or refuses takes the flush's last
  second, SMD-2902), not guaranteed. A second signal cuts the telemetry's
  flush short too.
  Before, the image ignored SIGTERM — the server is the container's PID 1,
  which has no default action for it — so every stop waited out the grace
  period and was killed (exit 137), cutting off any call in flight. Run with
  an init as PID 1 (`docker run --init`, compose's `init: true`, Fly), under
  systemd or in a terminal, Bun died at the signal at once; it now drains the
  same way, and Ctrl-C exits 0. Only when `api.ts` is Bun's entry: a suite
  that imports the module keeps its own. What the
  container's exit code says:

  | Exit | Meaning |
  | --- | --- |
  | 0 | Stopped once everything in flight had ended (or nothing was) |
  | 1 | The stop cut calls off at the bound or on a second signal — or preflight refused the configuration, or the server failed; the last `SIGTERM: stopped` line tells which |
  | 143 / 130 | Stopped by SIGTERM / SIGINT during preflight, before it served (the Dockerfile's traps) |
  | 137 | Killed: the stop outlasted the grace period, or the signal landed while the entry was still loading |

  Under podman, `podman restart` and `docker compose restart` without `-t`
  kill the server at once (exit 137, measured on podman 6.0.2) rather than
  signal it; `compose stop api` then `compose start api`, or
  `podman restart -t 10`, drains.

## Related

- `../deploy/` — the compose stack this server is the published port of
- `../FORK.md` — what this fork changes and why
