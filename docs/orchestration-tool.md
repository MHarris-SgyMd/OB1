# The orchestration tool is n8n (SMD-1863)

An architecture decision record. **Decided 2026-09-25: n8n is the fork's
orchestration tool for ingestion and sync — an optional, self-hosted sidecar
that talks to the brain only through its MCP surface, shipped as a compose
profile that references n8n's image, with OB1's part being workflow templates
and the key discipline around them, never the runtime.** The evidence is the
POC in `evals/README.md` § "Which orchestration tool?" (`evals/eval-orchestration.ts`,
PR #173): the same two workflows on n8n 2.40.6, Activepieces 0.91.3 and
Windmill CE 1.817.0 beside a throwaway brain, held to criteria posted on the
ticket before any of them ran. This page is the pick, the two gates, the
boundary, what it declines and what it leaves open.

## The decision

1. **n8n, over Activepieces and Windmill.** n8n and Activepieces passed every
   criterion (C1 ingestion, C1s the schedule firing, C2 the capture through the
   tool's own MCP client, C3 the tool's own MCP endpoint, C4 headless);
   Windmill failed C2 — it has no MCP-client step outside an AI agent. Between
   the two that passed, n8n wins on everything the POC could measure except the
   licence (the ranking below), and its licence passes the gate for the shape
   OB1 ships.
2. **A sidecar, opt-in, beside the brain.** A `deploy/compose.yaml` profile
   (`orchestration`, as `board-sync` and `jev` are profiles), off unless asked
   for; a brain plus Claude Code never runs it. The profile references n8n's
   pinned image; nothing of n8n's is vendored.
3. **n8n gets a Postgres of its own.** Not a database on the brain's server:
   n8n calls the brain's Postgres 16 "outside the supported range and receives
   compatibility support only. Upgrade to Postgres 17 or newer" (measured), and
   a shared postmaster is one buffer pool and one crash domain for the brain and
   a workflow engine (`deploy/compose.tiers.yaml` already gives each brain
   tier a Postgres of its own). A small Postgres 17 in the profile.
4. **It talks to the brain through MCP only.** Captures go through n8n's MCP
   Client node with a **capture-scope** key (can add a thought, cannot read one);
   a read goes through a read-scope key; no workflow holds a write key. The
   brain grows no n8n-specific route, and n8n reaches no brain table.
5. **OB1 ships templates, not a runtime and not a node.** Workflow definitions
   (JSON, with placeholder credential ids the provisioning replaces) and the
   provisioning that loads them. No community node: the stock MCP Client node
   and HTTP Request node covered everything the POC needed.
6. **n8n's public API is the integration contract.** `/api/v1` (OpenAPI,
   versioned, `X-N8N-API-KEY`) for credentials, workflows, publishing and run
   history. The one step outside it — minting that key, which the public API
   cannot do — goes through the editor's internal endpoints once, at
   provisioning, and nowhere else.
7. **The dividing line.** n8n when the need is a stateful workflow — a
   schedule, a trigger, a retry, a multi-step fetch, a cursor, a two-way sync.
   The AI client's own MCP connector (or a per-service MCP server) when the
   agent needs one call on demand. The tool does not become the hammer for
   every API an agent touches.
8. **Inbound first; nothing leaves the box until the checkpoint exists.** v1 is
   ingestion into the brain plus "act" tools that call a vendor for the AI
   client. No template ships that sends brain content to an outside system
   until the egress checkpoint below lands.

## What the POC measured

One clean cycle each, 2026-09-25, `--verify --wait-schedule`; the tables and
every caveat are in `evals/README.md`.

| | n8n 2.40.6 | Activepieces 0.91.3 | Windmill CE 1.817.0 |
| --- | --- | --- | --- |
| C1 ingestion (10 issues, run 2 adds none, counts from the tool's own run record) | PASS | PASS | PASS |
| C1s the schedule fired | PASS (692 s) | PASS (875 s) | PASS (811 s) |
| C2 capture through the tool's MCP client | PASS | PASS | **FAIL** (our script) |
| C3 its MCP endpoint: two tools, no key and a wrong key refused | PASS (403/403) | PASS (401/401) | PASS (401/401) |
| C4 provisioned with no UI step | PASS (public API + one key mint) | PASS (REST) | PASS (REST) |
| memory after the runs (cgroup) | 361 MiB | 1,176 MiB | 235 MiB (+664 MiB in Postgres, its queue) |

And the live AI-client check: a headless Claude Code session (Opus 5.5) given
only n8n's MCP endpoint — a throwaway `--mcp-config`, no user configuration
touched — listed `brain_search_thoughts` and `linear_issue`, searched the brain
(top hit SMD-1863) and read SMD-1863's live state from Linear, in four turns.
"Remember" and "act" on one MCP surface, from the client that will use it.

## The ranking, axis by axis

| axis | n8n | Activepieces | Windmill |
| --- | --- | --- | --- |
| connector breadth | 918 node types in the image; 2,274 integrations listed | 763 pieces | a Hub of scripts; no Linear or Gmail trigger |
| MCP maturity (live) | client node + server trigger, static header auth — the OB1 pattern | client piece (no timeout knob); OAuth-only endpoint offering 42 of its own flow-editing tools beside yours | server with path-scoped tokens (held); no deterministic client |
| licence vs FSL-1.1-MIT | Sustainable Use License — passes for OB1's shape (below) | MIT for everything used — cleanest | AGPLv3 + a proprietary CE image: "not … modify or wrap under any form without an explicit agreement" |
| operational fit | one container, ~360 MiB; nothing fetched at run time; wants Postgres 17 | ~1.2–2 GiB; needs its cloud catalogue to provision a fresh stack; refused known pieces on 10 of 11 fresh boots until a restart | small container, heavy on Postgres; superuser-made cluster roles (`windmill_admin WITH BYPASSRLS`); no job isolation unprivileged |
| auditability | workflow JSON; an OpenAPI contract for everything but the key mint | flow JSON; REST that is its web app's, not a published contract | scripts as files — the most reviewable, and the connectors are ours to write |
| egress controls (measured) | per-credential domain allowlist, enforced | sync can be turned off after provisioning, not before | none measured |

Windmill's strength — connectors as reviewable scripts — is also the reason not
to pick it: writing each connector ourselves is the per-service work this
ticket exists to stop. Activepieces has the cleaner licence and a comparable
catalogue, and loses on operations: a runtime dependency on its cloud to
provision, a boot race needing a restart on ten fresh boots of eleven, 3–5× n8n's memory,
and an MCP endpoint that hands an AI client its own admin tools unless each is
disabled. n8n's licence is the price; the gate is where that price is checked.

## Gate 1: the licence

n8n's Sustainable Use License 1.0 grants use, copy, distribution and derivative
works, limited so: "You may use or modify the software only for your own
internal business purposes or for non-commercial or personal use. You may
distribute the software or provide it to others only if you do so free of
charge for non-commercial purposes." Files with `.ee.` in the name or path are
not under it. It is not an OSI licence.

What OB1 does is inside it:

- **The profile references the image; OB1 does not distribute n8n.** The
  operator's own compose pulls `n8nio/n8n` from n8n's registry. No n8n code is
  in the tree.
- **The templates are OB1's.** Workflow JSON describing nodes and connections
  is configuration an operator writes; OB1 writing it for them adds nothing of
  n8n's to the tree.
- **The operator's use is personal or internal.** A brain is one person's or
  one team's; the SUL permits exactly that.
- **No `.ee.` feature is used.** Git source control (Business and Enterprise)
  is not needed: templates are files, loaded through the public API.

What it rules out, and the docs must say: running an OB1 brain with the n8n
profile **as a paid service for others**. That is also outside OB1's own
FSL-1.1-MIT, so the two licences point the same way. If that changes, n8n's
FAQ names `license@n8n.io`.

Activepieces (MIT outside `packages/ee` and `server/api/src/app/ee`) passes
cleanly; Windmill passes only for personal use of the unmodified image, and the
profile OB1 would ship is arguably "wrap" — conditional on an agreement it does
not have.

## Gate 2: egress

Every workflow that sends brain content outward is an egress boundary, the
concern SMD-1813's allowlist and SMD-1903's egress policy already name. The
posture, in the order it is enforced (SMD-2211 builds 2 and 5):

1. **v1 is inbound.** Ingestion into the brain, and act tools that call a vendor
   on the AI client's behalf. No template ships a sink (a digest to Gmail, a
   post to Slack, a page written back to Notion) until items 2–5 are in place.
2. **Every credential in a template is pinned to its host.** n8n enforces a
   per-credential domain allowlist (`allowedHttpRequestDomains`): the Linear key
   pinned elsewhere was refused, "Domain not allowed: This credential is
   restricted from accessing api.linear.app" (measured). The POC pinned the
   Linear credential only; whether the MCP Client node honours a pin on the
   brain's header credentials is not measured and is the first thing the
   follow-up measures.
3. **Keys are least-privilege and separate.** Ingestion holds a capture-scope
   brain key; a read path holds a read key; nothing holds a write key. The key
   an AI client presents to n8n's MCP endpoint is not the key that starts an
   ingestion (the POC shared one; the profile must not).
4. **The n8n API key is the owner's password in another form.** Scoped to eight
   of ~90 scopes, it still includes creating and publishing workflows — so a
   holder can publish one that sends any unpinned credential anywhere. It is
   minted at provisioning, given an expiry, kept out of every workflow, and
   rotated on re-provision (the POC left `expiresAt: null` and replaced keys
   stayed valid).
5. **A sink goes through the brain's egress gate.** When sinks come, the thoughts
   a workflow delivers come out of the brain through the SMD-1931 retrieve route
   with `mayLeaveBox` deciding per destination and the decision on the audit row
   (SMD-1903) — the one checkpoint `docs/connector-taxonomy.md` places at the
   seam, whichever fetcher asks.
6. **Telemetry off, and measured.** The profile sets n8n's documented switches
   (diagnostics, version check, templates, personalisation); the POC set them
   and did not probe what the container dials. An egress probe (the container on
   an internal network after provisioning) is part of the profile's acceptance.

## The boundary, concretely

- **The profile** (SMD-2210). `n8nio/n8n` pinned by digest (2.40.6 measured), a Postgres 17
  of its own, one published port on loopback (the house rule, check 13), the
  telemetry switches, `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` so no workflow reads a
  secret from the environment, and a one-shot provisioning step — owner, key,
  credentials, templates, publish — the POC's adapter grown up.
- **The templates** (SMD-2212). Linear → brain first (the POC's workflow, with a cursor on
  `updatedAt` in place of a fixed issue list), the MCP-endpoint workflow for
  `brain_search` and a vendor lookup, then Gmail → brain once an operator's
  Google OAuth client exists (self-hosted n8n has no managed OAuth).
- **What the brain sees.** A capture from `n8n` is a capture from a key; its
  actor is the key's name, its trust the key's kind. When SMD-1931's single
  capture route and SMD-1933's family envelope exist, the templates hand over
  the envelope; until then, `capture_thought` with the rendered text.

## What moves, what stays

- **board-sync (SMD-1954) stays** as the no-orchestrator fallback, and as the
  path for a brain without the profile. Its poll is not replaced by n8n's Linear
  Trigger yet: a Linear webhook needs Linear to reach n8n, which needs the one
  inbound origin SMD-1846 adds. The Linear template polls too.
- **The recipe family (SMD-1251, SMD-1317, SMD-1455) stays as it is** and each
  recipe retires when its template lands and has run unattended — `gmail-smart-pull`
  after the Gmail template, not before.
- **SMD-949's connectors (1814–1818) are re-scoped against n8n before any is
  built**: Notion, Linear and Jira/Confluence have n8n nodes and become
  templates carrying SMD-1813's rules on the brain side; Obsidian and Markdown/git
  are file walks — batch, a native driver by the taxonomy's own dividing line —
  and stay OB1's.
- **The eval kit stays an eval kit.** `evals/orchestration/`'s adapter interface
  (provision, run, run history, MCP endpoint) is enough to verify any candidate;
  it is promoted to an operations interface only if the fork ever runs or
  switches between two tools. Workflow templates are not made portable across
  tools — that would mean a workflow language of our own and give up the
  catalogue that is the reason to adopt one. The portable seams are the ones
  that already exist: the family envelope inbound (SMD-1933) and MCP tool names
  outbound.

## Declined

- **Activepieces** — cleanest licence, comparable breadth; declined on the
  operational findings above.
- **Windmill** — fails C2; licence conditional on an agreement; connectors
  would be ours to write.
- **SaaS (Zapier, Make)** — not self-hostable, and the brain is personal data.
- **An OB1-native connector SDK** — the per-service plumbing this ticket exists
  to stop writing, with a framework around it.
- **Per-service MCP servers for everything** — right for one call on demand
  (decision 7), wrong for a schedule, a cursor or a retry, which is state a
  server per vendor would each re-implement.
- **An OB1 community node for n8n** — not needed; the stock MCP Client node does
  the capture, and a node would be one more package to ship and version.
- **A database on the brain's server** — n8n's own version floor and a shared
  crash domain (decision 3).

## Not decided here

- **Gmail**, until an operator's Google OAuth client exists; the POC's source
  was Linear with an API key.
- **Two-way sync** — conflict resolution and round-trip fidelity are SMD-1813's
  and SMD-949's, consuming this transport.
- **Whether the MCP Client node honours a credential domain pin** — measured
  first in the egress follow-up.
- **Webhooks from vendors** (push instead of poll) — after SMD-1846.

## Follow-ups

- **SMD-2210** — the `orchestration` compose profile: n8n pinned by digest, a
  Postgres 17 of its own, loopback, one provisioning step, expiring and separate
  keys, the egress probe.
- **SMD-2211** — the egress checkpoint: every template credential pinned, the MCP
  Client node's honouring of a pin measured, no sink before the retrieve route
  and the egress gate carry it.
- **SMD-2212** — the first templates: Linear → brain on an `updatedAt` cursor, the
  MCP-endpoint workflow, Gmail → brain once an OAuth client exists.
- SMD-949 carries the connector re-scope (a comment on the ticket).

## Held by

`evals/eval-orchestration.ts` — `--up n8n` then `--verify n8n --wait-schedule`
re-runs the whole POC against a throwaway brain; the verifier's own mechanisms
were each killed as a mutant in three review passes (PR #173). The profile's
follow-up adds its own acceptance: the POC's checks against the profile rather
than the eval overlay, and the egress probe.

## Related

- `../evals/README.md` § "Which orchestration tool?" — the evidence
- `connector-taxonomy.md` — the seam, the fetcher kinds, the one egress checkpoint
- `../deploy/compose.yaml` — the `board-sync` and `jev` profiles the orchestration profile sits beside
