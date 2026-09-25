# The orchestration tool is n8n (SMD-1863)

An architecture decision record. **Decided 2026-09-25: n8n is the fork's
orchestration tool for ingestion and sync — an optional, self-hosted sidecar
that reaches the brain only through its MCP surface, shipped as a compose
profile that references n8n's image, with OB1's part being workflow templates
and the key discipline around them, never the runtime.** The evidence is the
POC in `evals/README.md` § "Which orchestration tool?" (`evals/eval-orchestration.ts`,
PR #173): the same two workflows on n8n 2.40.6, Activepieces 0.91.3 and
Windmill CE 1.817.0 beside a throwaway brain, held to criteria posted on the
ticket before any of them ran (C1s, the schedule seen to fire, was added after
the second review pass to test what C1 already said: "A scheduled workflow"). This
page is the pick, the two gates, the boundary, what it declines and what it
leaves open.

**Amended by SMD-2210** (the profile, built): decision 3's store is decided
(SQLite, measured). The import pipeline's runner is decided ("Running a
pipeline from a workflow"). The gates, the boundary and operations now say
what the profile does rather than what it would do.

## The decision

1. **n8n, over Activepieces and Windmill.** n8n and Activepieces passed every
   criterion (C1 ingestion, C1s the schedule firing, C2 the capture through the
   tool's own MCP client, C3 the tool's own MCP endpoint, C4 headless);
   Windmill failed C2 — it has no MCP-client step outside an AI agent. Between
   the two that passed, n8n wins on the axes the POC measured — MCP, operations,
   egress controls — and loses on the licence; breadth, from the vendors' own
   listings, is comparable (the ranking below). Its licence passes the gate for
   the shape OB1 ships.
2. **A sidecar, opt-in, beside the brain.** A `deploy/compose.yaml` profile
   (`orchestration`, as `board-sync` and `jev` are profiles), off unless asked
   for; a brain plus Claude Code never runs it. The profile references n8n's
   pinned image; nothing of n8n's is vendored.
3. **Not a database on the brain's server.** The POC ran n8n in its own
   database on the brain's Postgres 16, and n8n said of it "outside the
   supported range and receives compatibility support only. Upgrade to Postgres
   17 or newer" (measured); a shared postmaster is also one buffer pool and one
   crash domain for the brain and a workflow engine. Whether n8n's store is a
   Postgres 17 of its own or n8n's default SQLite was left to SMD-2210 to
   measure and decide, since neither shape was run here. **It is SQLite**
   (SMD-2210). Both passed every check of the kit. SQLite is one container
   fewer, lighter in memory and on disk, and its backup is a copy of one
   file; Postgres adds a second server to pin and upgrade, for a workload of
   one operator's schedules (`../evals/README.md`, "The orchestration profile
   (SMD-2210)", has the numbers).
4. **It reaches the brain through MCP only.** Captures go through n8n's MCP
   Client node with a **capture-scope** key (can add a thought, cannot read
   one); no workflow holds a write key. The brain grows no n8n-specific route,
   and n8n reaches no brain table.
5. **OB1 ships templates, not a runtime and not a node.** Workflow definitions
   (JSON, with placeholder credential ids the provisioning replaces) and the
   provisioning that loads them. No community node: every node the POC used is
   stock (Schedule and Webhook triggers, HTTP Request, Code, MCP Client, MCP
   Server Trigger and its tool nodes).
6. **n8n's public API is the integration contract, with two named gaps.**
   `/api/v1` (OpenAPI, versioned, `X-N8N-API-KEY`) for credentials, workflows,
   publishing and run history. It has no "run now" — an on-demand run is the
   workflow's own Webhook trigger — and it cannot mint its own key: owner
   setup, sign-in and key minting go through the editor's internal endpoints
   (`/rest/owner/setup`, `/rest/login`, `/rest/api-keys`), at provisioning and
   at every re-mint (key custody below).
7. **The dividing line.** n8n when the need is a stateful workflow — a
   schedule, a trigger, a retry, a multi-step fetch, a cursor, a two-way sync.
   The AI client's own MCP connector (the brain's, or a per-service MCP server)
   when the agent needs one call on demand. So n8n's MCP endpoint exposes what
   only a workflow can do — an act tool that is a multi-step flow, a trigger an
   agent may pull — and **not the brain's own tools**: the client already has
   the brain's MCP, under its own key, attributed and revocable per client,
   which a brain read through n8n's shared static header would lose (every
   client would read as the one key n8n holds). The POC's `brain_search` on
   n8n's endpoint proved the path; it is not a template. So the ticket's pitch —
   the AI client sees "remember" and "act" on **one** MCP surface — is declined:
   the client sees both through two connectors, the brain's and n8n's, at the
   cost of one more connector to configure. The live check below shows each path
   works.
8. **One owner per source per brain.** A source is ingested by one writer on a
   given brain, or the brain holds the same item twice in two renderings. The
   fork's Linear board is board-sync's (SMD-1954), which updates a ticket's row
   in place; an n8n Linear template ships only when it can do the same —
   identity-keyed upsert through SMD-1931's capture route with SMD-1867's
   identity — and then, on a brain that runs it, replaces board-sync there.
   The rule holds during a cut-over too: a template proving itself "unattended"
   before a native path retires does so on another brain (the canary tier is its
   own Postgres server), or with the native path switched off — never beside it
   on the same brain.
9. **v1 sends no brain content to a vendor.** Ingestion into the brain, and act
   tools that call a vendor with what the AI client gives them. No template
   delivers thoughts to an outside system until the egress checkpoint below
   lands. What does leave or linger in v1 is named in Gate 2.

## What the POC measured

One clean cycle each, 2026-09-25, `--verify --wait-schedule`; the tables and
their caveats are in `evals/README.md`.

| | n8n 2.40.6 | Activepieces 0.91.3 | Windmill CE 1.817.0 |
| --- | --- | --- | --- |
| C1 ingestion (10 issues, run 2 adds none, counts from the tool's own run record) | PASS | PASS | PASS |
| C1s the schedule fired | PASS (692 s) | PASS (875 s) | PASS (811 s) |
| C2 capture through the tool's MCP client | PASS | PASS | **FAIL** (our script) |
| C3 its MCP endpoint: both tools answer, no key and a wrong key refused | PASS (403/403) | PASS (401/401; 42 of its own tools listed beside) | PASS (401/401; `runScriptByPath` beside) |
| C4 provisioned with no UI step | PASS (public API + the internal key mint) | PASS (REST) | PASS (REST) |
| candidate container, at the start → after the runs (cgroup) | 575 → 361 MiB | 1,224 → 1,176 MiB | 578 → 235 MiB |
| the shared Postgres container after the runs — brain and candidate together, no brain-only baseline | 90 MiB | 187 MiB | 664 MiB (from 188) |

And the live AI-client check, recorded in the evals README: a headless Claude
Code session given only n8n's MCP endpoint — a throwaway `--mcp-config`, no
user configuration touched — listed both tools, searched the brain (top hit
SMD-1863) and read SMD-1863's live state from Linear, in four turns.

## The ranking, axis by axis

| axis | n8n | Activepieces | Windmill |
| --- | --- | --- | --- |
| connector breadth (the vendors' listings, not measured) | 918 node types in the image (tool variants included); 2,274 integrations on n8n.io/integrations (2026-09-24) | 763 pieces on activepieces.com/pieces (2026-09-24) | a Hub of scripts; no Linear trigger, and the Hub's Gmail integration is send-only (its docs and hub.windmill.dev, 2026-09-24) |
| MCP maturity (live) | client node + server trigger, static header auth — the OB1 pattern | client piece with no timeout property; OAuth-only endpoint listing 42 of its own tools (flows, tables, run any piece action) beside yours | server with path-scoped tokens (held); no deterministic client |
| licence (Gate 1) | Sustainable Use License — passes for OB1's shape | MIT for everything used — cleanest | AGPLv3 + a proprietary CE image: "not … modify or wrap under any form without an explicit agreement" |
| operational fit | 361–575 MiB; what it ran needed no package fetched at run time (inferred from stock nodes; not probed); warns below Postgres 17 | 1.1–1.2 GiB, 2.1–3.3× n8n; needs its cloud catalogue to provision a fresh stack; refused known pieces on 10 of 11 fresh boots until a restart | smallest container after the runs, the heaviest Postgres growth (its queue lives there); superuser-made cluster roles (`windmill_admin WITH BYPASSRLS`); no job isolation unprivileged |
| auditability | workflow JSON; an OpenAPI contract with the two gaps in decision 6 | flow JSON; a published `/v1` OpenAPI, whose API keys need the Platform or Enterprise edition — on the community image the kit signs in as a user and calls it | scripts as files — the most reviewable, and the connectors are ours to write |
| egress controls (measured) | a per-credential domain allowlist, enforced; key scopes enforced on the two calls tried | catalogue sync can be turned off after provisioning, not before | none measured |

Windmill's strength — connectors as reviewable scripts — is also the reason not
to pick it: writing each connector ourselves is the per-service work this
ticket exists to stop. Activepieces has the cleaner licence and a comparable
catalogue by count (a node type is not a piece, so the counts are indicative),
and loses on operations: a runtime dependency on its cloud to provision, a boot
race needing a restart on ten fresh boots of eleven, 2.1–3.3× n8n's memory, and
an MCP endpoint that hands an AI client its own admin tools unless each is
disabled. n8n's licence is the price; Gate 1 is where that price is checked.

## Gate 1: the licence

What follows is the fork's reading of the licence texts, not legal advice; where
it rests on an inference, it says so.

n8n's Sustainable Use License 1.0 grants use, copying, distribution, making
available and derivative works, limited so: "You may use or modify the software
only for your own internal business purposes or for non-commercial or personal
use. You may distribute the software or provide it to others only if you do so
free of charge for non-commercial purposes." Files with ".ee." in the filename
or ".ee" in the dirname are not under it. n8n calls it fair-code and
source-available and says it does not call itself open source (its licence FAQ
and docs.n8n.io/n8n-community-license).

Why OB1's shape is inside it — the second and third points are inferences the
licence does not address in words:

- **The operator's use is internal or personal.** A brain is one person's or
  one team's; that is what the SUL permits.
- **The profile references the image; OB1 does not distribute n8n.** The
  operator's own compose pulls `n8nio/n8n` from Docker Hub; no n8n code is in
  the tree. Because OB1 distributes nothing of n8n's, the SUL's Notices clause
  (pass these terms on with a copy) does not bite; if the fork ever built or
  published an image containing n8n, it would.
- **The templates are OB1's.** Workflow JSON naming nodes and connections is
  configuration an operator writes; OB1 writing it for them adds nothing of
  n8n's to the tree.
- **No licence-gated feature is enabled.** The image ships and loads ".ee"
  directories; what the profile never turns on is a feature that needs an
  Enterprise licence — n8n's Git source control (`modules/source-control.ee`)
  among them, since templates are files loaded through the public API. The
  profile names n8n only to identify it, not as a mark of OB1's.

**Where the two licences differ.** OB1's FSL-1.1-MIT forbids a Competing Use —
making OB1 available in a commercial product or service that substitutes for
it, substitutes for another product the licensor offers with it, or offers the
same or substantially similar functionality — and permits professional
services to a licensee; each release becomes MIT two years after it is made
available. n8n's SUL never converts, and it draws its line elsewhere: n8n's own
licence FAQ permits consulting and automation services, and installing and
managing n8n on a client's own server "provided that you are not *also*
hosting for them", while hosting n8n for others, or letting others build
workflows on it, is outside the licence. So the same deployment can meet both:
a consultant installing an OB1 brain with the profile on a client's own
infrastructure is inside both licences; hosting the profile for a client is
outside the SUL; a commercial product built on OB1 that competes with it is
outside the FSL whatever the SUL says. The profile's docs state those three,
and that the operator is running two non-OSI licences side by side. n8n's FAQ
names `license@n8n.io` for anything unclear.

**The other two.** Activepieces is MIT outside `packages/ee/` and
`packages/server/api/src/app/ee`, and everything the POC used is outside them.
Windmill grants use of its Community Edition "for free without restrictions
other than the limits and quotas set in the software" and distribution only "as
is but not to sell, resell, serve as a managed service, modify or wrap under any
form without an explicit agreement". By the reading above, a profile
referencing its image distributes nothing either; what the SUL lacks and
Windmill's terms add is "wrap", and a compose profile built around the image to
serve OB1 is arguably wrapping it. That leaves Windmill conditional on an
agreement the fork does not have — moot for the pick, since it failed C2.

## Gate 2: egress

Every workflow that sends brain content outward is an egress boundary, the
concern SMD-1813's allowlist and SMD-1903's egress policy already name.

**What leaves or lingers in v1**, named so the checkpoint covers it:

- **Act tools carry what the AI client gives them to a vendor.** That is any MCP
  connector's contract; the client decides what it sends. No v1 template feeds a
  vendor call from the brain itself.
- **n8n keeps a copy of every run.** n8n saves execution data by default and
  prunes it after 14 days or 10,000 runs (its defaults, read from the 2.40.6
  image's configuration), so each capture's text sits in n8n's store as well as
  the brain's for up to a fortnight — outside `delete_thought`, redaction and the
  brain's retention. The same holds for an act tool's arguments: whatever the
  client handed it, brain content included, lingers in n8n's run history.
  The profile shortens the window to 24 hours or 1,000 runs (SMD-2210).
  n8n's execution-data redaction (a workflow's `redactionPolicy`) is behind
  an Enterprise licence check (`isDataRedactionLicensed`, read from the
  2.40.6 image), and the profile turns on no licence-gated feature, so the
  window is the control. A
  run's data is deleted up to about 2¼ hours after it leaves the window:
  n8n marks it at an hourly check, then deletes it at a 15-minute sweep an
  hour later. Saving stays on, so the kit still counts captures from saved
  runs, and its P check measures a run past the window gone from the API and
  the store.
- **Brain reads do not go through n8n** (decision 7), so no brain search result
  transits it.

**The posture**, and which follow-up builds each step:

1. **v1 is inbound** (decision 9). No template ships a sink — a digest to Gmail,
   a post to Slack, a page written back to Notion — until steps 2–5 are in place.
2. **Every credential in a template is pinned to its host** (SMD-2211). n8n
   enforces a per-credential domain allowlist (`allowedHttpRequestDomains`):
   the Linear key pinned elsewhere was refused, "Domain not allowed: This
   credential is restricted from accessing api.linear.app…" (measured). The POC
   pinned the Linear credential only; whether the MCP Client node honours a pin
   on the brain's header credentials is not measured and is the first thing
   SMD-2211 measures.
3. **Keys are least-privilege and separate** (SMD-2210). Ingestion holds a
   capture-scope brain key; nothing holds a write key. The key an AI client
   presents to n8n's MCP endpoint is not the key that starts an ingestion (the
   POC shared one). In the profile they are `N8N_MCP_KEY` and
   `N8N_WEBHOOK_KEY`, and the kit measures each refused (403) on the other's
   path. Provisioning refuses a brain key that `MCP_ACCESS_KEYS` does not list,
   and one at write scope.
4. **Key custody** (SMD-2210). The POC's key held eight of ~90 scopes. The
   profile's holds ten: `credential:update` and `workflow:update` were added,
   so a re-provision patches credentials and replaces workflows in place. The
   two calls outside the POC's scopes tried in the third review pass answered
   403, though n8n's docs say non-Enterprise keys have full access. But the
   scopes include creating and publishing workflows, so a holder can publish
   one that sends any unpinned credential anywhere. The profile's key
   expires (`N8N_API_KEY_DAYS`, 90), and a re-mint deletes the key it
   replaces, which n8n then answers with 401 (measured; in the POC, replaced
   keys stayed valid). Every
   mint and re-mint signs in as the owner, so the **owner password** is a
   standing secret of the profile, stronger than the key; it lives in
   `deploy/.env` beside `POSTGRES_PASSWORD`. So does **`N8N_ENCRYPTION_KEY`**:
   n8n encrypts every stored credential with it, and losing it loses them all.
5. **A sink goes through the brain's egress decision** (SMD-2211 specifies it;
   SMD-1931's retrieve route is its precondition). The thoughts a workflow
   delivers come out of the brain through that route, and the decision is made
   there per destination and recorded on the audit row. Today `mayLeaveBox`
   decides what may leave for a model call (SMD-1903); extending it to a
   workflow's destination is part of the step, not something that exists.
6. **Telemetry off, and measured** (SMD-2210). The profile sets n8n's documented
   switches. The POC set them and did not probe what the container dials. The
   kit's `--with sealed` puts n8n on an `internal: true` network with a
   tcpdump watcher in its network namespace. The brain-side paths still pass
   there, and the watcher records every name n8n asked for
   (`../evals/README.md`, "The orchestration profile (SMD-2210)").

**On the way in**, the seam's inbound allowlist applies to a template exactly as
to any fetcher (`docs/connector-taxonomy.md`, "One checkpoint"): the Gmail
template is gated on SMD-1813's label allowlist, and `gmail-smart-pull`'s local
sensitivity routing — the taxonomy's precedent — is carried into it or kept,
not dropped when the recipe retires.

## The boundary, concretely

- **The profile** (SMD-2210, `../deploy/compose.yaml`'s `n8n` service). It
  has `n8nio/n8n` pinned by digest (2.40.6 measured), a store of its own
  (decision 3), and one published port on loopback (the house rule, check
  13). It sets the telemetry switches and `N8N_BLOCK_ENV_ACCESS_IN_NODE=true`,
  so no workflow reads a secret from the environment, and a 24-hour
  execution window. It refuses to start without `N8N_ENCRYPTION_KEY`. The
  provisioning step is `../deploy/orchestration/provision.ts`, run from a
  checkout: owner, an expiring key, credentials, templates, publish. It is
  the POC's adapter grown up, and the eval kit now imports it and runs its
  checks against the profile as it ships, not against the shape decision 3
  rejects.
- **The templates** (SMD-2212). Gmail → brain, once an operator's Google OAuth
  client exists (self-hosted n8n has no managed OAuth; the consent is one
  browser step, outside C4's "no UI step"), gated on SMD-1813; an
  act-tool workflow on n8n's MCP endpoint; the Linear template only on the terms
  of decision 8.
- **What the brain sees.** A capture from n8n is a capture from a key: its actor
  is the key's name, its trust the key's kind. When SMD-1931's single capture
  route and SMD-1933's family envelope exist, the templates hand over the
  envelope; until then, `capture_thought` with the rendered text.

## Operations

- **Footprint.** n8n's container measured 361–575 MiB and a 1.1 GiB image in the
  POC's shape (a database on the brain's server). In the profile's shape
  (SMD-2210): 369 MiB after the runs, on a 6.4 MiB SQLite store. A Postgres
  17 of its own measured 404 MiB for n8n, plus 52 MiB for its server and a
  280 MiB image, on a 15.5 MiB store.
- **Upgrades.** The image is pinned by digest and bumped deliberately. Each bump
  re-runs the eval kit's `--up n8n` and `--verify n8n --wait-schedule`, which
  run the profile as it ships, because two things the profile depends on are not
  n8n's published contract: the internal key-mint endpoints, and the shape of
  the run data the verifier counts. That is the kit's one operational use.
- **Backups.** n8n's store holds workflows, credentials (encrypted with
  `N8N_ENCRYPTION_KEY`), each polling workflow's cursor (its static data) and
  run history. The workflows are the templates in the tree, and an API-key
  credential is re-created from `deploy/.env` at provisioning — but an OAuth
  credential's refresh token (Gmail's) exists only in n8n's store, and losing a
  cursor means re-ingesting from the start. So what needs keeping is
  `deploy/.env` — the owner password and the encryption key with the brain's
  own secrets — **and** n8n's store. The store is one SQLite file, copied
  while n8n runs (`VACUUM INTO`); `../deploy/README.md`, "Orchestration", has
  the copy and the restore, both measured.

## The capture layer's sync trigger

The ticket asked for the trigger decision to be made once for every source, not
per connector. It is:

- **Poll, for now.** v1 templates poll on a schedule. A vendor webhook needs the
  vendor to reach n8n, whose one port is loopback-only (check 13); exposing it
  is what the single inbound origin SMD-1846 adds. The Linear Trigger (Linear's
  webhook) waits on the same.
- **The native push receivers stay native** until then — the chat and highlight
  captures the taxonomy lists as `push` (Slack, Discord, Telegram, Readwise).
- **After SMD-1846, push moves to n8n's triggers**, one receiver at a time, each
  proven on another brain or with its native receiver off (decision 8), then the
  native receiver retired.
- **Batch stays a native driver**: an archive parse has no workflow state for a
  tool to hold.

## Running a pipeline from a workflow

Decided in SMD-2210; built in SMD-2212. The import recipes SMD-2126 routes
onto the ingestion contract (SMD-2147–2150, SMD-2021) run as instances of one
generic template: an emitter, then `bun db/ingest-records.ts --source items
--items -`, then `db/reembed.ts`. Three of the five emitters are Python and the
pipeline is Bun. n8n's image has neither, and n8n 2.40.6 excludes its Execute
Command node by default (`NODES_EXCLUDE`, read from the image). So the step
runs outside n8n:

- **A runner service in the profile.** It is a small HTTP service, built from an
  image with Bun and python3, and reachable only on the compose network (no
  published port), behind a key of its own. It runs a fixed allowlist of
  pipelines by name, with the items in the request body. A workflow calls it
  with an HTTP Request node, and every import template shares it. n8n reaches
  the runner, never the brain. The runner is OB1's code on OB1's side of the
  line, as board-sync is, and it writes the way the pipeline writes from a
  checkout. So decision 4 holds for n8n.
- **Declined: an n8n image with Bun and python3 added**, and Execute Command
  turned back on. OB1 would then build and distribute an image containing
  n8n, which is what Gate 1's "OB1 does not distribute n8n" rests on. And
  Execute Command runs whatever command a workflow names.
- **Declined: a compose one-off the workflow starts.** It would need the
  container engine's socket inside n8n, which is root on the host.

The runner is built with SMD-2212's first import template, not before, since
nothing calls it until then. Like the rest of the profile it is loopback-only.
SMD-2211's checkpoint covers the two live-API emitters' own egress.

## What moves, what stays

- **board-sync (SMD-1954) stays** as the no-orchestrator fallback: the path for
  any brain without the profile, and the owner of the fork's Linear board until
  an n8n Linear template meets decision 8 — at which point, on a brain that runs
  that template, the template replaces it there.
- **The recipes stay until a template replaces one.** Of the capture recipes,
  only `gmail-smart-pull` has a planned template (SMD-2212), and it retires only
  after that template has run unattended — on another brain, or with the recipe
  off (decision 8) — with its sensitivity routing carried over. The import recipes (Takeout, exports, vaults) are batch and stay native
  drivers. SMD-1251, SMD-1317 and SMD-1455 are hardening work on that family and
  are unaffected.
- **SMD-949's connectors are re-scoped against n8n before any is built.** Notion
  (SMD-1816), Linear (SMD-1817) and Jira/Confluence (SMD-1818) have n8n nodes
  and become templates carrying SMD-1813's rules on the brain side — the Linear
  one under decision 8. Obsidian (SMD-1814) and Markdown/git (SMD-1815) split by
  the taxonomy's line: the one-shot import of a vault or repository is batch and
  stays a native driver; the live two-way sync is a stateful workflow, a tool
  node by the same line — but it needs the vault's or working tree's files,
  which a container beside the brain does not have. Which runs it is SMD-1814's
  and SMD-1815's to decide, not this record's.
- **The eval kit stays an eval kit.** `evals/orchestration/`'s adapter interface
  (provision, run, run history, MCP endpoint) is enough to verify any candidate;
  it is promoted to an operations interface only if the fork ever runs or
  switches between two tools. Workflow templates are not made portable across
  tools — that would mean a workflow language of our own and give up the
  catalogue that is the reason to adopt one. The portable seams are the ones
  that already exist: the family envelope inbound (SMD-1933) and MCP tool names
  outbound.

## Declined

- **Activepieces** — cleanest licence, comparable breadth by count; declined on
  the operational findings above.
- **Windmill** — fails C2; licence conditional on an agreement; connectors
  would be ours to write.
- **SaaS (Zapier, Make)** — not self-hostable, and the brain is personal data.
- **An OB1-native connector SDK** — the per-service plumbing this ticket exists
  to stop writing, with a framework around it.
- **Per-service MCP servers for everything** — right for one call on demand
  (decision 7), wrong for a schedule, a cursor or a retry, which is state a
  server per vendor would each re-implement.
- **An OB1 community node for n8n** — not needed; stock nodes did everything,
  and a node would be one more package to ship and version.
- **A database on the brain's server** — n8n's version floor and a shared crash
  domain (decision 3).
- **Brain tools on n8n's MCP endpoint** — the client's own brain connector does
  it with per-client attribution (decision 7).

## Not decided here

- **Gmail**, until an operator's Google OAuth client exists; the POC's source
  was Linear with an API key.
- **Two-way sync** — conflict resolution and round-trip fidelity are SMD-1813's
  and SMD-949's, consuming this transport; where the Obsidian and Markdown syncs
  run is SMD-1814's and SMD-1815's.
- **Whether the MCP Client node honours a credential domain pin** — SMD-2211
  measures it first.

## Follow-ups

- **SMD-2210** (done) — the `orchestration` compose profile: pinned image, a
  store of its own (SQLite, measured), loopback, a shorter execution window,
  one provisioning step, expiring and separate keys, custody of the owner
  password, the encryption key and n8n's store, the kit run against the
  profile, the egress probe.
- **SMD-2211** — the egress checkpoint: every template credential pinned, the MCP
  Client node's honouring of a pin measured, no sink before the retrieve route
  and the egress decision carry it.
- **SMD-2212** — the first templates: Gmail → brain once an OAuth client exists,
  an act-tool workflow, and the Linear template only on decision 8's terms.
- SMD-949 carries the connector re-scope (a comment on the ticket).

## Held by

`evals/eval-orchestration.ts` — `--up n8n` then `--verify n8n --wait-schedule`
re-runs the POC's criteria against a throwaway brain: ingestion counted from
n8n's own run record, the schedule firing, the MCP endpoint's tools and its
refusal of a missing and a wrong key. The verifier's mechanisms were each killed
as a mutant in three review passes (PR #173). Measured once by hand and not
re-run by the kit: the credential domain pin, the key scopes' 403, the
POC's replaced keys staying valid, Activepieces' sync-mode behaviour, and the
live Claude Code check. Since SMD-2210 `--up n8n` runs the profile as it
ships, provisioned by its own step. `--verify` adds three checks:
- K: each inbound key refused on the other's path; after `--rotate` the
  replaced API key answers 401, the new one carries its expiry, and n8n holds
  exactly one provisioned key.
- P: a saved run past the window gone from the API and the store, and one
  inside it kept.
- E, under `--with sealed`: the egress record.

`--with postgres` measures the store decision 3 did not take. CI runs
provisioning's pure rules (`provision.ts --self-check`) and holds the
profile's port to loopback, its image to a digest, and a plain `config` to
the three services it had before.

## Related

- `../evals/README.md` § "Which orchestration tool?" — the evidence
- `connector-taxonomy.md` — the seam, the fetcher kinds, the one egress checkpoint
- `../deploy/compose.yaml` — the `orchestration` profile's `n8n` service, beside the `board-sync` and `jev` profiles
- `../deploy/README.md` § "Orchestration" — running it: keys, provisioning, an AI client, backups, upgrades
- `../deploy/orchestration/provision.ts` — the provisioning step the profile and the eval kit share
