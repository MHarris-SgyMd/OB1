# 65. An opt-in query log turns real use into a replayable eval, and a CI gate holds a recall floor against the searches people actually ran (SMD-1295)

Every retrieval decision this fork has shipped is measured on one corpus the
baseline already saturates — 441 Linear issues, recall@10 0.98 — so the reranker
cascade, hybrid fusion, contextual chunks and GraphRAG all came out neutral or
worse there, and each write-up (and change 30, SMD-1041) names the corpus as the
reason. The other ground truth a real brain produces on every request — the query
someone typed, and which returned thought they opened next — the server used to
discard. This change records it, behind a flag, and gates PRs on it.

**The log (migration 034, `query_log`).** Off by default; `OB1_QUERY_LOG=on`
makes the two search tools write one row per call (query text, `match_count`,
`threshold`, `recency_weight`, `filter`, and the ids returned in rank order with
scores) and the three action tools (`fetch`, `update_thought`, `delete_thought`)
write one row per touch of a *returned* id. Nothing reads it on the hot path; the
write is best-effort — a failure is swallowed so it can never fail a search or a
capture — and it is a new table off the capture path, no trigger, no `thoughts`
change. A search and the action that followed are **not** joined at write time:
there is no request/session token in the MCP handlers (008's actor envelope has a
`session` slot nothing populates), so the link is recovered at export by the only
keys both rows share — the acting agent (010) and the returned id, within a
window — a NULL agent its own bucket, not a wildcard. `prune_query_log(p_keep_days)`
is the retention window (default 30, `OB1_QUERY_LOG_RETENTION_DAYS`; the DELETE
always bounded by `logged_at`), part of this version because the log is personal
data at rest — every query typed. The bound is strict: a row logged in the
prune's own transaction shares its `now()` and stays, and `test-schema` [34]
asserts that with insert and prune in one transaction (SMD-1498 — the section
had assumed each statement's `now()` is later than the last's, which PGlite's
millisecond clock does not promise, and its wipe assertion flaked once). The
window's unit is asserted too (SMD-1515): the section had checked the default
over rows hours old and rows going only at 0, which a body counting hours
passes; now a row half a day past 30 days goes and one half a day inside
stays under the default — half a day, since rows a whole day out sit on a 31-
or 29-day bound whenever the insert and the prune share a `now()`, and the
tick then decides whether such a window is caught.
`db/config.mjs`'s `QUERY_LOG` is the one spelling of the flag, names, tool sets
and retention, read by the server, preflight and the tests; a `querylog` grant
group (query_log `INSERT`, since 034) means a self-hosted role that runs
`--grant` can turn the flag on and have it work — documented, but not enforced,
since preflight cannot read a server env flag and the log is off by default.

**Export → replay → gate (`evals/`).** `export-queries.ts` reads the log and
writes a fixture of query text and ids (`query`, `relevant` = the touched ids,
`baseline` = the recorded ranking): no *thought content* leaves the brain, so it
is committable — but the `query` strings are the searcher's own words, personal
data, so committing an export fixture from a real brain commits real queries (a
maintainer's call). `scripts/check-fork-consistency.mjs` check 9 is the guard: an
allowlist, not a denylist of field names, so every committed string must be a
thought id or free text under a known key (`query`/`note`) — a thought body, an
array of chunks, or a content-derived `title` all fail closed. The attribution is
click-through relevance — a proxy, a fetch can be a wrong guess — and it collapses
distinct callers who typed the same query, and every anonymous caller (a NULL
agent) into one bucket; kept beside the hand-labelled sets, not instead of them. `eval-replay.ts` replays a fixture through the shipped
`search_thoughts_hybrid` over the live corpus and reports recall@k / MRR against
`relevant` and rank drift against `baseline`, in `eval-real.ts`'s table shape.
`db/test-replay.ts` is the CI gate (job *Retrieval replay gate*): offline PGlite,
no model or key, ~0.5 s, replaying a committed **content-free** synthetic fixture
(`build-replay-fixture.ts` — seeded vectors and ids) through `match_thoughts` and
failing when mean recall@5 drops past the fixture's floor. It proves the floor has
teeth by replaying random query vectors and watching recall collapse (0.154 <
0.8), so a scrambling regression fails it without a git-revert to stage one.

Upstream status: **not applicable** — a fork-only measurement mechanism; the log
is a self-hosting feature and the gate is fork CI. **Unfiled** upstream.
Reproduce: `OB1_QUERY_LOG=on`, capture then `search_thoughts` then `fetch` a
returned id, and `SELECT kind, tool FROM query_log` shows the two rows;
`bun db/test-replay.ts` runs the gate offline.
