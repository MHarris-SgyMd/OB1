# 212. `retry_failed` and `release_stale_leases` — the write half of `worker_status` (SMD-2132)

**What changed.** SMD-2131 shipped the read surface (`worker_status` + `GET
/worker-status`) and deferred the actions. This adds the two pure-SQL, write-scoped
actions that close the documented dogfood pains: releasing a 25 h-dead 27B lease
(previously `podman exec … psql SELECT release_claims_for_worker(...)`) and retrying
failed rows (previously a hand-rolled `bun` container). The control plane over the
existing claim machinery (migration 015) — never a worker or a scheduler.

- **`retry_failed`** (new write tool, `server-portable/index.ts`; scope `write` in
  `tools.ts`, so a read or capture key never sees it). One argument, `work_type`;
  requeues that pool's `failed` claim rows to `pending`, clearing `last_error`,
  `finished_at` and `attempt_count` (the `db/extract-entities.ts --retry-failed`
  statement, one pool at a time). Returns `{workType, retried, ids}`.
- **`release_stale_leases`** (new write tool). By default releases only
  `claimed AND ttl_expires_at < now()` — a dead worker's lapsed lease — optionally
  scoped by `work_type` and/or `worker_id`, mirroring migration 015's
  `release_claims_for_worker` SET (`pending`, TTL cleared, `attempt_count`
  decremented so an un-run lease is not penalised). A live lease is left for its
  holder; `include_live` reaches one but **requires** a `worker_id`, refused as a
  value otherwise (`REFUSED_LIVE_LEASE_NEEDS_WORKER`) — releasing a live lease risks
  the holder double-processing. Returns `{released, ids, workers}`.
- **`POST /worker-retry-failed`** and **`POST /worker-release-leases`** — the REST
  mirrors, args in the JSON body, gated by a **write** key (stricter than SMD-2131's
  read routes; a read/capture/no/wrong/revoked key gets the bodiless `ok`). POST at
  every path is the MCP endpoint, so the guard is registered before the MCP handler
  and falls through with `next()` for any path it does not own.
- **`ThoughtStore.retryFailed` / `releaseStaleLeases`** — SQL store: one statement
  each (the release uses parameterised optional predicates, no composed SQL).
  PostgREST shim: throws "requires the SQL backend" — `thought_work_claims` is not
  published to PostgREST (migration 015), as `workerStatus` does.
- **Audit.** Each action stamps the calling key as actor into the existing action
  log (`query_log` `kind='action'`), one row per affected thought, exactly as
  `delete_thought` records its action — the claim table has no `thought_audit`
  trigger of its own, and no new table is added.

**Scope.** Access keys carry `read | write | capture`, not per-work-type scope, so
the SMD-1311 key-scope parity is the `canWrite` gate plus a required, explicit
`work_type` on `retry_failed` (no blind cross-pool sweep). `release_stale_leases`
allows an omitted `work_type` — a cross-pool stale-lease reap is the reaper's own
reach — but never touches a live lease without the explicit escape hatch.

**Not taken.**
- `run_worker` (the drain). The server deliberately never runs the bulk LLM passes
  (`entities.ts`, `consolidate.ts`), the drain has no importable core (it is inline
  in each CLI `main()`), and a real drain runs for minutes against a POST-only
  transport whose SSE keepalive caps at 10 min. It belongs to a follow-up tied to
  SMD-1869 (a compose `tools` service) or a callable-core refactor.
- A new `admin` scope. `write` is already stricter than the read key the actions had
  to exceed; a fourth scope would touch keygen, `parseKeyRecords`, the docs and
  `sync-auth` for no gain here.

**Tested.**
- `server-portable/test-store-sql.ts` [5f]: `retryFailed` moves `failed→pending`
  (exact count + ids, error/finish/attempt reset), scoped to one pool (a sibling's
  failures and a succeeded row untouched), idempotent on none; `releaseStaleLeases`
  releases past-TTL leases and **leaves a live lease alone**, decrements
  `attempt_count`, scopes by `work_type`, and reaches a live lease only via
  `include_live` + `worker_id`.
- `server-portable/test-store-postgrest.ts` [8f]: both throw the SQL-only reason.
- `server-portable/test-e2e-sql.ts` [6e]: both tools and both keyed POSTs over HTTP
  — success, an action-log row per affected thought, the live-lease and blank-arg
  refusals (tool error and POST 400 with the code), and a capture/no key getting
  plain `ok` from the POST.
- `server-portable/test-server.ts` / `test-auth.ts`: the manifest drift guard, both
  `readOnlyHint: false`, and a read/capture key never seeing them.

**Review passes.**

| Pass | Finding | Caught | Fix |
| --- | --- | --- | --- |
| 1 | Both tools' catch blocks attached `{code: "STORE_UNAVAILABLE", retryable: true}`, but the sibling write tools (`delete_thought`, `update_thought`) and `worker_status` return a codeless error there — and on a PostgREST (Workers) deploy the failure is the permanent SQL-only reason, so `retryable: true` would tell a client to retry a call that can never succeed. Catches are now codeless, matching the siblings; the deliberate refusals (blank work_type, live lease) keep their machine-readable codes | cold-read | pass 1 |
| 1 | `releaseStaleLeases` had no store-level guard on `includeLive` without a `workerId` — both surfaces refuse it as a value, but a direct store caller could release EVERY live lease across every pool by omitting it. Added a backstop throw in the SQL store (unreachable from the surfaces, which refuse first with the code) + a [5f] tooth that it throws and releases nothing | cold-read | pass 1 |
| 2 | Verification (no MEDIUM+): confirmed the `app.post("*")` guard sits before the MCP `app.on(["POST"],"*")` and falls through with `next()` (e2e drives both a worker POST and ordinary MCP POSTs); the write-scope gate (read/capture key → tool absent / `ok`); the result contract (camelCase, `::int`→number); and concurrency — retry (`status='failed'`) and claim (`status='pending'`) never overlap, and a release/reaper race re-checks `status='claimed'` under the row lock so a row is released once. Noted a deliberate choice: a manual stale release decrements `attempt_count` (mirroring `release_claims_for_worker`, an operator giving back an un-run attempt), where the automatic reaper keeps it — the more lenient behaviour is intended for a hand intervention | cold-read, automated | pass 2 |

**Boyscout.** `server-portable/README.md`'s "Expected outcome" suite counts were stale (predating SMD-2131): refreshed the four this PR re-measured — `test-server.ts` 344, `test-auth.ts` 120, `test:sql` 180, `test:e2e` 265.
