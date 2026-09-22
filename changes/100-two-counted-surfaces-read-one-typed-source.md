# 100. Two counted surfaces read one typed source instead of drifting by hand — the MCP tool list is a `ToolName`-typed manifest the suites and the smoke test read, `db/README.md`'s assertion totals and migration list are checked against what the suites and `db/migrations/` hold, and the grant check compares privileges, not just names (SMD-1805, SMD-1471)

`server-portable/tools.ts` is the fork's ten tools as `const TOOLS = [{ name,
scope }, …] as const satisfies readonly ToolEntry[]` — the single, typed place
the surface is written. Because the names are `as const`, `ToolName` is a real
union TypeScript checks a name against (a JSON import would widen every name to
`string`), and `satisfies` fails a bad `scope` at the source. `scripts/gen-tools.mjs`
writes `server-portable/tools.json` from it for `deploy/smoke.sh`, which is bash
(and the deploy CI job has no bun); `check-fork-consistency.mjs` round-trips the
two — regenerate in memory, compare to the committed copy — the way the codemod
check round-trips the shim, so they cannot drift. `test-server.ts`,
`test-auth.ts`, `test-e2e-sql.ts`, `test-agents.ts` and `smoke.sh` read the
manifest in place of a hardcoded count or list, and the drift guards derive the
expected surface per scope from `visibleToolNames({ write })` rather than a fixed
number — so a gated or optional tool later changes what that returns, not a test.
`test-server.ts`'s `tools/list` case is the live drift guard: it compares the
running server to the manifest, so a `registerTool` added to or removed from
`index.ts` without a manifest entry fails there. `test-auth.ts` still names the
three mutating tools independently of the manifest — a manifest-and-server
co-rename is caught — but as a `ToolName[]`, so a typo in that list is a compile
error, not a runtime surprise. Before this the count was hardcoded in four suites
and the smoke test, and the ticket's claim that it lived in five —
`test-update-delete.ts` among them — was wrong; that suite asserts no count.
`index.ts`'s `registerTool` name literals are left as they are: the live drift
guard ties them to the manifest, and adopting the constants there (so the server
registers from `ToolName`) is a deliberate follow-up.

`db/README.md` quoted `test-schema.ts`'s and `test-live.ts`'s assertion totals
by hand. `createAssert` gains `total()`, `skipped()` and a `docCheck` — counted
apart from the headline total, so a check verifies that number without moving it
— and each suite holds every count the README gives it to what the run
produced (`test-live.ts` only on a full run, since a skipped group on
PostgreSQL 18 or with JIT off legitimately lowers it). The migration list was
edited by hand too and drifted an intro count once (SMD-1696);
`check-fork-consistency.mjs` now holds every file under `db/migrations/` to
being documented exactly once across "The migrations" table and the "024
onward" map, the applied count stated as a digit and checked against the file
count — distinct from check 5b, which only forbids two files sharing a number.

The same script's grant check named every `ROLE_GRANTS` object in the README
but never its privileges (SMD-1471). `db/config.mjs` gains `grantRows()` — every
row undeduped, since an object carries a different set in two groups
(`ob1_config`, `thought_audit`) — and the check now compares each group's
documented privilege set to what the group grants, so a `SELECT` the docs claim
but the config drops, or the reverse, fails with the object and the difference.

**Upstream status:** not sent — upstream runs no tests and has none of these
suites, the manifest, or the consistency script; this is the fork's own
machinery. Steps 1–2 and 4–7 of SMD-1805 — the branch-protection ruleset, the
merge queue, changelog fragments, the GHCR release job, frozen migrations, and
the commit and workflow linters of SMD-1808 — are follow-ups; the release job
and the frozen-migration check wait on SMD-1804's first tag.
