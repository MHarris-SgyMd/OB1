# The three dashboards, read against one operator surface

**Status:** analysis, 2026-09-27, read from `main` at `0d659e5b` (SMD-2280, under SMD-2133). No decision is recorded here. This is the input to one.
**Question:** the tree ships three dashboards, and `FORK.md` says "nothing says which is canonical. Pick one before depending on any." What does each one do, where do they overlap, what is unique to each, and what would a single GUI for human operators need that none of them has?

Every claim cites `file:line`. Paths are relative to the dashboard's own folder unless they start with a top-level directory. **S** is `dashboards/open-brain-dashboard/` (SvelteKit), **N** is `dashboards/open-brain-dashboard-next/`, **P** is `dashboards/open-brain-dashboard-pro/`. **OBR** is `integrations/open-brain-rest/index.ts` and **RA** is `integrations/rest-api/index.ts`.

"Observed" means read in the code. "Suspected" means inferred and not run. Nothing was run for this analysis.

---

## 1. At a glance

| | S (SvelteKit) | N (Next) | P (Pro) |
|---|---|---|---|
| Stack | SvelteKit 2, Svelte 5, Tailwind 4, `adapter-vercel` | Next 16.2.4, React 19, iron-session, dnd-kit, OpenNext/Cloudflare | Next 16.2.6, React 19, iron-session |
| Talks to | **Core server, MCP**, via its own `/api/mcp` proxy (`src/lib/server/mcp.ts:77-116`) | **OBR** REST gateway, plus the **agent-memory-api** sidecar (`lib/agent-memory.ts:11-19`) | **OBR** by its README, but three features are written for **RA** routes (`/count`, `/duplicates/resolve`, real ingestion jobs) |
| Deployed backend exists? | Yes: `server-portable` is the only server in `deploy/compose.yaml` | No: no compose file runs OBR, RA or agent-memory-api | No |
| Source size | ~1,300 lines (`src/`) | ~6,700 TS/TSX | ~4,640 TS/TSX |
| CI | built, `svelte-check`, **driven** against the stack with write, read and capture keys (`.github/workflows/fork-checks.yml:1302`, `smoke.ts`) | built only (`fork-checks.yml:777-782`) | built only |
| Lineage | headcrest; moved off Supabase sign-in by SMD-1801 (PR #148) | alanshurafa `a082d268` (2026-03-23), then upstream work: #131, #132, kanban #146, UUID ids `86ac0d21`, agent memory, Cloudflare, extension hook | same author's 2026-03-23 snapshot, re-added fresh as `0b91c39a` (2026-05-22), plus a security review pass. It has **none** of N's later commits (P's `DeleteModal.tsx` is byte-identical to `a082d268`) |

In short:
- **S** is a thin search-and-capture page on the one server that is actually deployed.
- **N** and **P** are one app that forked in March. N gained features and P gained hardening.
- Both N and P sit on a gateway the fork does not deploy, and that gateway cannot run on the default brain: it hard-codes OpenRouter `text-embedding-3-small` at 1536 dimensions (OBR:30-34), while the fork's default is `qwen3-embedding:4b` at 1024 dimensions (`integrations/open-brain-rest/README.md:51`).

---

## 2. Feature matrix

✅ = present and works on this fork. ⚠️ = present but broken or degraded on this fork (reason in §5). — = absent. The "Server" column says whether the core server can back the feature today without a gateway.

| Capability | S | N | P | Server (MCP / HTTP) |
|---|---|---|---|---|
| **Sign in with an access key, sealed cookie** | ✅ AES-GCM, key in the `x-brain-key` header | ✅ iron-session | ✅ iron-session (⚠️ Secure flag, §5) | ✅ keys `read`/`write`/`capture` (`server-portable/auth.ts:74-76`) |
| Scope-aware UI (read key is read-only; capture-only key refused) | ✅ `signin/+page.server.ts:38-41`, proxy 403 `api/mcp/+server.ts:29-31` | — any valid key is treated as full | — | ✅ `tools/list` filtered by scope |
| Stats | total only (`+page.svelte:248`); types, topics and people are parsed but never rendered | ✅ total, types, top topics | ✅, plus a settings/status page | `thought_stats` (prose) |
| Recent feed on home | — (blank until you search) | ✅ 5 recent | ✅ 5 recent | `list_thoughts` |
| Browse, paginated, with filters | — (`list_thoughts` is coded but unreachable, `src/lib/api.ts:112-121`) | ✅ 25/page, type, source, importance 1–5 | ✅ same, importance 0–6 | `list_thoughts` (type, topic, person, days, said_by, actor); no offset paging |
| Semantic search | ✅ limit 50, re-sorted by date (relevance lost) | ✅ semantic or text, 100/page, % match | ✅ same | `search_thoughts`, `search_thoughts_keyword` (paged) |
| Capture | ✅ content only | ✅ Add to Brain | ✅ | `capture_thought` (+ `metadata`, `supersedes`, `derived_from`) |
| Smart ingest (extract many, dry run, execute job) | — | ⚠️ OBR stub | ⚠️ OBR stub; built for RA | — (smart-ingest is a vendored service) |
| Thought detail page | — (view-only modal, no real ids) | ✅ | ✅ | `fetch` |
| Edit | — | ✅ content, type, importance, status | ✅ content, type, importance | `update_thought` (content, metadata_patch, if_unchanged_since, supersedes) |
| Delete | — | ✅ | ✅ | `delete_thought` (refused while the thought is cited; `detach_citations`) |
| Connections panel | — | ✅ | ⚠️ never shows (integer id check) | — (OBR RPC from `schemas/enhanced-thoughts`) |
| Reflections (decision/lesson traces) | — | ⚠️ no table in any `.sql` | — | — |
| Low-quality audit + bulk delete | — | ✅ unguarded | ⚠️ well guarded, but rejects UUIDs | — (`quality_score` is an enhanced-thoughts column) |
| Duplicate review + resolve | — | ⚠️ OBR duplicates are token-similarity over a page of recent rows, not semantic | ⚠️ resolve route missing on OBR, rejects UUIDs | — (`find_near_duplicates` in RA only) |
| Restricted-content lock (passphrase) | — | ✅ (⚠️ BL-02 leak on connections) | ✅ | — (`sensitivity-tiers` does not exist, `FORK.md:913`) |
| Kanban workflow board | — | ✅ (needs `schemas/workflow-status`) | — | — |
| Agent-memory governance (review queue, inspector, recall traces) | — | ✅ (sidecar service) | — | — (agent-memory-api, vendored) |
| Settings / system status | — | — | ⚠️ `/count` missing on OBR, so it reads "empty brain" | `brain_info`, keyed `GET /health` (JSON, including `ledgerStatus`) |
| Extension nav registry | — | ✅ `extensions.config.ts`, `EXTENSIONS.md` | — | — |
| Mobile layout | partial (responsive grid; cramped search, suspected) | ✅ SidebarShell drawer | — fixed `w-56` sidebar | |
| Accessible modal | — no dialog role, Escape or focus trap | ✅ (#132) | — (pre-#132 copy) | |
| Theme | dark only | graphite, with NBJ branding | violet | |

---

## 3. What overlaps

All three share one core:

1. **Access-key sign-in into a sealed, httpOnly, SameSite=Lax cookie.** There is no password and no user table. The key the operator pastes is the key forwarded upstream. This matches `changes/152-the-dashboards-off-supabase.md`, which brought S to the shape N and P already had.
2. **A server-side proxy.** The browser never holds the key. S proxies MCP (`/api/mcp`); N and P proxy REST through Next route handlers and server actions.
3. **Search, capture and headline stats.** These are the only features all three have.

N and P further share, almost line for line: browse, detail/edit/delete, connections, audit, duplicates, ingest, and the restricted lock. They also share a data model S does not have: `importance`, `quality_score`, `status`, `sensitivity_tier`, `source_type`. All of these come from `schemas/enhanced-thoughts` and `schemas/workflow-status`, not from the core `thoughts` table.

---

## 4. What is distinctive, and whether it is worth carrying

### S: the only one on the real contract
- **Talks MCP to the deployed server.** It works on the default brain and needs only `MCP_URL` and `SESSION_SECRET`.
- **Scope-correct.**
  - Sign-in reads the key's `tools/list`.
  - A capture-only key is refused (SMD-1298).
  - A read key hides capture, and the proxy refuses it before asking the server.
  - Revocation mid-session drops the cookie and returns 401.
- **Session hardening.**
  - The expiry lives inside the sealed token (`session.ts:100`).
  - Secure follows the request scheme on both set and delete (`session.ts:40-42`).
  - `/signin` returns generic errors to strangers.
  - The SSE frame is matched by request id, not taken as the last line (`mcp.ts:50-75`).
- **The only dashboard CI actually drives.** `smoke.ts` has 34 assertions and 8 killed mutants.
- **Worth carrying:** the transport, the auth model and the smoke harness.
- **Weak UI:**
  - no real ids, so nothing can be edited, deleted or linked;
  - no browse mode;
  - results pile up across searches;
  - all data is scraped from prose output (`src/lib/api.ts:45-230`).
- **Deliberate open proxy.** The proxy forwards any tool name (by design, `api/mcp/+server.ts:7-9`), so a write key can call `delete_thought` through it even though the UI has no delete.

### N: the feature-rich one
- **Worth carrying:**
  - UUID string ids end to end;
  - SidebarShell mobile layout;
  - the accessible DeleteModal;
  - the filter that applies on blur or Enter instead of every keystroke (#131);
  - the status badge;
  - the extension nav registry, the only designed extension point in any of the three;
  - the flexible Secure-cookie rule (`AUTH_COOKIE_SECURE`, else the app URL's scheme; `lib/auth.ts:18-24`).
- **Kanban.** A real operator workflow (drag between statuses, priority, auto-archive). It depends on a `status` column the core table does not have. Suspected bug: a drop onto a card sends the card's UUID as the new status (`components/KanbanBoard.tsx:115-116`).
- **Agent-memory governance.**
  - Review actions: Evidence, Confirm, Reject.
  - A memory inspector.
  - Recall-trace viewer.
  - It is a separate vendored service and schema, and hard-codes "Nate Jones Personal OB1" (`app/agent-memory/page.tsx:106`).
- **Must not be carried:**
  - the demo auth bypass (`OB1_DEMO_AUTH_BYPASS`, `lib/auth.ts:46-51`);
  - upstream error bodies rendered into HTML (`lib/api.ts:44`, `app/page.tsx:29`);
  - unguarded bulk delete (`app/api/audit/delete/route.ts:17-30`);
  - duplicate-resolve that deletes any id it is sent (`app/api/duplicates/resolve/route.ts:22-41`);
  - the BL-02 restricted leak: connections trust `?exclude_restricted=false` (`app/api/thoughts/[id]/connections/route.ts:19-20`);
  - NBJ branding and `allowedDevOrigins: ["192.168.0.140"]`.

### P: the hardened one
- **Worth carrying (the server-side guards):**
  - generic `ApiError.message`, with the raw body kept on `upstreamBody` for logs only (`lib/api.ts:32-47`);
  - bulk-delete cap of 50, and each thought re-verified as still low-quality before it is deleted (`app/api/audit/delete/route.ts:5-76`);
  - the audit delete honours the restricted lock;
  - duplicate-resolve re-verifies that the pair is still a pair (`app/api/duplicates/resolve/route.ts:5-104`);
  - the restricted flag comes from the session, never the query string (BL-02 fixed);
  - ingest item normalization and the richer ItemCard (`app/api/ingest/[id]/route.ts:5-27`, `components/AddToBrain.tsx:56-163`);
  - duplicates-page selections survive paging;
  - AbortController loaders;
  - the restricted-configured flag computed on the server;
  - zero kept in numeric params (IN-07);
  - the settings page's refusal to show made-up numbers.
- **Must not be carried:**
  - the integer-only id checks, left over from upstream's bigint ids, on audit delete, duplicate resolve and connections. They reject every thought id on this fork (SMD-2152 fixed only the detail page, `4a3713db`).
  - `secure: NODE_ENV === "production"` (`lib/auth.ts:32`). Suspected: `next start` over plain HTTP causes a login loop.
  - the https-only `NEXT_PUBLIC_API_URL` check (WR-06). Suspected: it rejects a compose service URL.
  - `apiKeyPrefix` sent to the browser (`app/api/settings/status/route.ts:90`), though the README says the key is never exposed.
  - the regressions of #131 (the filter navigates on every keystroke) and #132 (modal accessibility), and no mobile layout.

---

## 5. How much works on this fork

This section matters more than the feature list: much of N and P's surface is inert here.

- **No gateway is deployed.** OBR and RA appear in no compose file. N and P have nothing to talk to on the dogfood stack or the tier stack.
- **OBR can't run on the default brain.** Captures and edits need OpenRouter at 1536 dimensions. Every read needs `schemas/enhanced-thoughts`, because `thoughtSelect` names `type`, `importance`, `quality_score`, `sensitivity_tier`, `status` and `status_updated_at` (OBR:43-44).
- **Features that are dead or fake on OBR:**
  - Reflections: no `reflections` table exists in any `.sql` in the tree.
  - Ingestion jobs: hard-coded stubs (OBR:698-700); `/ingest` makes one capture and returns `job_id: 0`.
  - Duplicates: token similarity (`tokenSimilarity`, OBR:639) over a single page of recent thoughts, while the UI says "semantic".
  - P's `/count` and `/duplicates/resolve`: RA-only routes.
- **Importance scale disagrees four ways:**

  | Where | Scale |
  |---|---|
  | OBR | 0–100, default 50 (OBR:84,145,463) |
  | enhanced-thoughts column | `SMALLINT DEFAULT 3` |
  | N editor | 1–5 |
  | N kanban | 0–100 |
  | P | 0–6 |

  Both editors always submit importance, so a content-only edit silently rewrites it.
- **S works but is fragile:**
  - Suspected: `crypto.randomUUID()` runs in the browser (`src/lib/api.ts:164,196,220`, imported by `+page.svelte:2`) and is only available on HTTPS or localhost. On plain HTTP to a LAN host, a setup S's own cookie code supports, search would throw, and a capture would save and then report failure.
  - Its prose parsers are untested in CI, and a change to the server's text format would silently empty the page.

---

## 6. Operator capabilities no dashboard shows

The core server exposes 17 tools (`server-portable/tools.ts`). The dashboards together use 4 of them (S: `thought_stats`, `search_thoughts`, `capture_thought`, and `list_thoughts` as dead code). What an operator most needs is exactly what none of them shows:

| Capability | Server today | Output |
|---|---|---|
| Worker queue health (pending/claimed/failed/stale per work_type) | `worker_status`, `GET /worker-status` | JSON |
| Worker actions (requeue failed, release lapsed leases) | `retry_failed`, `release_stale_leases`, `POST /worker-retry-failed`, `POST /worker-release-leases` (write key) | JSON / text |
| Change feed (who changed what since when) | `thought_changes` over `thought_audit`, with a cursor | prose |
| Supersession proposals | `list_supersession_proposals` lists them; **accept/reject is CLI only** (`db/consolidate.ts --accept/--reject`) | prose |
| Brain identity, version, migration ledger freshness, sizes, HNSW params | `brain_info` (text); keyed `GET /health` (JSON, `ledgerStatus`) | JSON via /health |
| Query log | `list_logged_searches` (needs `OB1_QUERY_LOG=on`) | JSON |
| Id census / digest | `list_thought_ids` | JSON |
| Derivations lineage (migration 061) | **no read path** | — |
| Provenance chains (`trace_provenance`, `find_derivatives`, migration 025) | store methods exist and **nothing calls them** (`server-portable/store.ts:1289-1290`) | — |
| Entity graph (migration 016), centrality, stale entities | `db/` scripts only | — |
| Keys and agents (mint, revoke) | env + `keygen.ts`; revoke is SQL | — |
| Re-embed / extract / consolidate runs | `db/` scripts in a container shell; SMD-2134 would fold them; drain deferred (SMD-2272) | — |
| Canary vs stable compare | `db/tier.ts --compare` (HTTP-only, over MCP data) | CLI |

---

## 7. What this implies for one operator surface

These are observations, not decisions. The decisions are listed in §8.

1. **The transport is already decided upstream of this question.** SMD-2133 makes MCP-over-HTTP canonical, with a REST façade *derived from* `server-portable/tools.ts` (SMD-1931), not a second hand-written gateway. SMD-1846 mounts `/dashboard` → `dashboards/open-brain-dashboard` beside `/mcp` behind one proxy. `changes/152` rejected moving S onto OBR for the width and schema reasons in §5.
   - An operator GUI built on OBR runs against all three of these.
   - One built on the core server's MCP (or the derived façade) runs with them.
   - **N and P's features are worth keeping; their transport is not.**
2. **The contract needs structured output before a GUI can be anything but a scraper.**
   - These tools return prose today: `thought_stats`, `thought_changes`, `list_supersession_proposals`, `brain_info`, `search_thoughts`, `search_thoughts_keyword` and `list_thoughts`. S's parsers are the cost of that.
   - A `structuredContent` field alongside the text (the pattern SMD-1978 used for capture refusals) would let one GUI and one REST façade share it.
3. **The operator surface is mostly contract work, not screen work.** The screens N and P already have (browse, detail, edit, delete, capture, search) map directly onto existing tools. The missing operator views need new tools:
   - supersession accept/reject;
   - a lineage/provenance read (the store already has the methods);
   - an entity-graph read.
   The workers view and its actions (SMD-2131/2132) and the ledger view (`/health`) already exist server-side.
4. **Carry the security model from S and the guards from P.**
   - From S: the key in a header, scope read from `tools/list`, the refusal made before the proxy asks the server, the expiry inside the token, and Secure following the scheme.
   - From P: generic errors, the bulk cap, re-verifying before a destructive act, and restricted state from the session only. Its id checks become digits-or-UUID, or UUID only (this fork's ids are UUIDs).
   - Decide whether S's open proxy stays open (today "what the dashboard may do is what the key may do") or gets an allow-list per screen.
5. **Carry the shell from N:** mobile drawer, accessible modals, blur-applied filters, and the extension nav registry. The registry is how operator views for vendored services (agent memory, kanban) can be add-ons rather than core.
6. **Features that depend on non-core schema are the natural extension candidates, not the core:** importance, quality audit, the restricted lock, kanban status, reflections, agent memory, smart-ingest jobs. The core `thoughts` table and the 17 tools don't carry them.

---

## 8. Decisions this analysis leaves open

1. **Base:**
   - (a) grow S, which is on the right transport and the only one CI drives, and port N/P screens into it;
   - (b) keep N's React shell and re-point it at MCP or the derived façade;
   - (c) a new app.
   The framework matters less than the transport, which (1) in §7 already settles.
2. **Transport inside the GUI:** MCP JSON-RPC through a server-side proxy (S today), or the SMD-1931 REST façade once it exists. Can the GUI wait for 1931?
3. **Structured tool output:** add `structuredContent` to the prose tools first (item 2 in §7), or ship the GUI on parsers and migrate?
4. **Scope of "core" operator views:** is it the thoughts CRUD plus workers, changes, supersession, ledger and query log? Which of lineage, entity graph and keys are day-one?
5. **Non-core features:**
   - Kanban, agent memory and smart-ingest: extensions, retired, or folded into core with a migration?
   - Reflections: drop, since no table exists.
   - Quality audit and importance: drop, or define one scale in core?
   - The restricted lock: drop until `sensitivity-tiers` exists?
6. **Retire what:** once the surface exists, delete N and P (and OBR's dashboard-only routes)? This fits the fork's no-upstream-parity posture.
7. **Destructive-action policy:**
   - Should the GUI allow bulk delete at all?
   - Should it go through `delete_thought`'s citation refusal and `detach_citations`?
   - Should every GUI action carry an actor label, as N's agent-memory review does (`actor_label: "Open Brain dashboard"`), so `thought_changes` can tell GUI edits apart?

## Related

- `FORK.md:908-913`: the "three overlapping dashboards" and `sensitivity-tiers` notes.
- `changes/152-the-dashboards-off-supabase.md`: S's sign-in design and why S stays on MCP.
- SMD-2133 (surface consolidation epic), SMD-1931 (one REST/MCP contract from `tools.ts`), SMD-1846 (one origin, `/dashboard` route), SMD-2131/2132 (worker surfaces), SMD-2152 (P's integer ids), SMD-1978 (`structuredContent` precedent).
- `docs/vendored-disposition.md`: OBR and RA are both "keep + audited".
