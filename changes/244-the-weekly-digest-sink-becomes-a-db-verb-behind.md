# 244. The weekly-digest sink becomes a `db/` verb behind the egress gate (SMD-2239)

**What it adds.** `db/weekly-digest.ts` on SMD-2134's harness: `db/connect.ts` for the connection, `db/worker-bootstrap.ts` for the actor and the egress refusal wording, and `server-portable/`'s own `resolveEmbedConfig` + gated `providerCall` for the synthesis. It is the fork's **first true sink** — brain content leaving to a third party, not only to an LLM — so it gates two independent hops:

- the **synthesis** (`providerCall(cfg, "/chat/completions", …, subject)`), refused → no digest, stop with the reason (declare `OB1_LLM_LOCAL=1` or allow it); and
- the **Telegram send**, gated by `mayLeaveBox(subject, telegramEndpoint(env), cfg.egress)` — `telegramEndpoint` derives its base/local from `OB1_TELEGRAM_API_BASE` / `OB1_TELEGRAM_LOCAL` (default `api.telegram.org`, never local), so the gate reflects the real destination.

The gate names content **units**, not hosts, and a digest belongs to no single row, so it declares its own subject — `kind: "digest"` (added to `EgressSubject`), `metadata.type = "digest"`, `metadata.source = "weekly-digest"`, the worker key as the actor. `--output stdout|file` never leaves the box (the synthesis still does). The read is raw SQL (SqlStore exposes neither `sensitivity_tier` nor `importance`): `restricted`/`personal` are excluded when the column exists, `importance` comes from a native column or `metadata.importance`, and a missing `sensitivity_tier` column **fails closed** unless `--no-sensitivity-filter`.

**Why a `db/` verb, not an n8n sink template.** The template alternative is blocked on SMD-2211's egress checkpoint (Backlog, itself needing SMD-1931's retrieve route and `mayLeaveBox` extended to workflow destinations). The `db/` verb is buildable now and puts the connection, the actor and the gate in one place — the ticket's second option.

**Design.** The model defaults to the brain's chat model (`cfg.metadataModel`), overridable with `--model` / `OB1_DIGEST_MODEL` (SMD-2290's precedent). Provider failures are classified through `worker-bootstrap`'s `classifyError` (a transient hop is retried on `TRANSIENT_PAUSES_MS`). Identity is best-effort — a keyless run just cannot be granted by `actor:`. The census (`test-cli.ts`) is satisfied: the worker reaches egress/identity only through `worker-bootstrap.ts` and args only through `cli.ts`.

**Tests.** `db/test-weekly-digest.ts` (DB-free): the ranking, the Telegram chunking, and the gate over a digest subject — the drop-the-gate mutant (a local endpoint always passes) and each allow term (`type`/`source`/`actor`), a keyless subject an `actor:` term cannot name, a wrong-type term refused. `db/test-live.ts` [36]: the sink end to end against one stub answering both hops — zero Telegram sends under the default deny (the refusal naming the rule), at least one under `type:digest` (the deny zero is a gate holding, not a dead sender), and the sensitivity fail-closed / filtered-proceeds branch by column presence.

**Retirement (follow-up, PR 2).** `recipes/weekly-digest/weekly-digest.mjs`'s live PostgREST mode will retire — its stdout/file modes also read over `rest/v1`, so removing the read supersedes the script — the README becoming a pointer to this verb, and check-fork-consistency's `POSTGREST_EXCEPTIONS` entry for it going. (recipes/ and scripts/ are not fragment dirs, so PR 2 needs no fragment of its own.)

**Upstream status.** Fork-only; the fork's `db/` harness and egress gate diverge from upstream.
