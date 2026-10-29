# One coordinator per brain runs every task, and n8n defines the extensions' workflows (SMD-3215)

An architecture decision record. **Accepted by the maintainer on 2026-10-28.** The direction was decided on 2026-10-27, in two steps:

- **Two kinds of coordinator** (from SMD-3379's design). A dedicated coordinator for each brain runs that brain's own tasks. A coordinator for the federated case, shared by the brains on one host or in one federation, holds what no single brain can see, first of all SMD-3379's model-slot service.
- **Every plugin and extension becomes an implementation the coordinator runs, interactive tools included.** n8n (the `orchestration` profile, `orchestration-tool.md`) is where each workflow is defined, and the integration point with services outside the brain.

The decision table marks which rows are that direction, which the maintainer decided on their own (the open questions, answered on 2026-10-27 and 2026-10-28), and which were this record's proposals, accepted with it. Nothing here is built yet; "Order" lists the steps.

## Terms

- **Core pass:** a task of the brain's own on Postgres: the sleep scheduler's passes, the extract and consolidate followers, board-sync.
- **Plugin operation:** an operation a plugin's manifest declares, served as a REST route and an MCP tool (SMD-2310).
- **Plugin task:** a workflow a manifest declares to run on a trigger rather than on a call.
- **Run:** one execution of a plugin operation, a plugin webhook or a plugin task as an n8n workflow. Each run has a row in the brain's Postgres, an unguessable id, a caller, a scope, a class and a deadline.
- **Class:** `live` or `background`, SMD-3379's two classes for model slots. A run takes its root's class: an operation a client calls is `live`; a webhook's or a task's run, and every run it calls, is `background` (SMD-3379 counts ingested writes as background).
- **Declaration:** what a run runs for, as its manifest declares it: an operation, a hook or a task. Each declares the calls its runs may make.
- **Child run:** a run opened when a run calls another plugin's operation that is itself a workflow (see "Chained runs").
- **Data operation:** an operation a manifest declares for its own runs alone, with a `ctx.db` handler and a scope (`read` or `write`), never listed as a tool.

## Why

**The brain's own tasks** each answer the same questions their own way (SMD-3215's Problem):
- **Start and restart.** Each follower is a compose service. SMD-3214 closed the reboot gap: `db/supervise.ts` runs each follower as a child process and starts it again.
- **Mutual exclusion.** `sleep` and the `workers` profile must not run together, enforced by a refusal and the docs.
- **Status.** One heartbeat row per worker, read separately by preflight, the keyed `/health` and `brain_info`.
- **Yield.** Each task yields only to its own brain's traffic. Nothing weighs one brain against another on a shared model server (SMD-3034). SMD-3379's design answers this with a slot service, which the maintainer placed in the federated coordinator.
- **Scheduling.** board-sync's interval, sleep's work period and n8n's schedules are three separate clocks.

**The extensions** sit where SMD-2308 left them, with three gaps:
- **Plugins were decided as the destination** (`operator-surface-tiers.md` decisions 9–12): a plugin's operations join the brain's contract, and the brain's servers serve them behind the brain's keys. The mechanism is built (SMD-2310), but only the example plugin uses it. The six extensions and three integrations still run as standalone servers on `compat/supabase-sql` (SMD-3216).
- **A plugin runs inside the brain's servers**, so it must be curated, and its SQL needs a role boundary that one plugin cannot step out of (SMD-2756).
- **A plugin has no way out of the brain.** Check 31 refuses `fetch` in plugin code, so anything that reaches an outside service has no home. n8n was chosen as the fork's integration point for exactly that (SMD-1863), but `orchestration-tool.md`'s decision 7 kept it away from the brain's own tools.

The direction joins the two. One runtime runs every task a brain has, whether a pass, a schedule, a webhook or a tool call: the coordinator admits, schedules and records each one. n8n defines extension workflows and reaches outside services.

## The decision

| # | Decision | Status | Instead of |
| --- | --- | --- | --- |
| 1 | **A coordinator per brain**, a service in that brain's stack, runs every task the brain has. | Direction (2026-10-27) | Each task as its own service with its own rules |
| 2 | **A federated coordinator** on the host, on no brain's network, reached through the host alias as the model servers are. It holds SMD-3379's slot service. A brain's sleep reaches it through the brain's own coordinator. | Direction (2026-10-27) | A broker per brain; a proxy in front of the model server |
| 3 | **Every plugin operation, interactive ones included, every plugin webhook and every plugin task is an implementation the coordinator runs.** n8n defines the workflow and is its one integration point with outside services. | Direction (2026-10-27) | Handlers in the REST core's process (SMD-2310 as built) |
| 4 | **The plugin manifest stays the contract.** Operations (schemas, scopes, REST route, MCP tool), tables, GUI pages and hooks are declared as today. An operation names its implementation: a workflow, or a handler, which a port may ship first and swap for a workflow later. The tool, its schemas and its scope do not change with the implementation. A workflow operation may answer two refusals a handler never does (see "Failure and limits"). | Accepted (2026-10-28); the interim handler decided 2026-10-27 | The workflow as the contract; a second MCP server for extension tools |
| 5 | **n8n's engine runs the workflow; the coordinator never interprets it.** The coordinator admits a run, gives it a deadline, starts it through the workflow's Webhook trigger, waits for the last node's answer and records the run. | Accepted (2026-10-28): follows from n8n's workflow JSON running only on n8n's engine | An OB1 engine for n8n's format |
| 6 | **A run carries its caller, and n8n holds no caller's credential.** The REST core opens each run. n8n calls the brain with a standing `run` key, which grants nothing alone, plus the run's id. The REST core resolves the id to the run's caller, bounded by the caller's scope and the operation's, by the calls its declaration lists, and by the deadline, and refuses it once the caller is revoked. | Accepted (2026-10-28) | n8n's one standing key for every caller (`orchestration-tool.md` decision 7's objection); a bearer token per run passed through n8n as data |
| 7 | **A plugin workflow reaches two things only:** the REST core, with the `run` key, and outside services through credentials pinned to their hosts. (n8n's own templates keep what they reach today: the REST core with a capture key, the import runner, and Linear for the act tool.) It never reaches Postgres or a model provider. A workflow's model call is a REST-core operation, so the egress gate and SMD-3379's slot hook see it. A lint holds this for plugin workflows (check 31); the network does not, since n8n shares `egress` with the model servers. | Accepted (2026-10-28) | n8n's own AI nodes on brain content |
| 8 | **Extension data stays in plugin tables in the brain's Postgres**, behind data operations only a run of that plugin may call. | Accepted (2026-10-28) | Tables in n8n's store; n8n given a database connection |
| 9 | **Core passes stay native engines on Postgres**: extract, consolidate, the re-derive sweep, board-sync, and the HNSW heal once built (SMD-2918). The coordinator runs them as child processes, as `db/supervise.ts` does today. | Decided (maintainer, 2026-10-27) | Core passes as n8n workflows |
| 10 | **The coordinator is one process running each core pass as a child** (SMD-3215's option a), grown from `db/supervise.ts`. Each child runs as its own user with only its own settings. | Accepted (2026-10-28) | Option b, starting and stopping containers, which needs the container runtime's socket (root on the host); option c, growing `db/sleep.ts`; option d, a status view only |
| 11 | **n8n is part of every brain**, as the coordinator is: both are default services of the compose stack, not a profile. | Decided (maintainer, 2026-10-28) | n8n only in a brain that enables a plugin with a workflow; n8n as the opt-in `orchestration` profile |
| 12 | **The brain keeps the inbound endpoint for webhooks.** The plugin's hook handler verifies the sender at `/hooks/<plugin>/<name>` as today, then opens a run. n8n gets no public route. | Accepted (2026-10-28) | n8n's own Webhook triggers published through the proxy |
| 13 | **One status surface for the brain's tasks:** the coordinator's view, built from the core passes' heartbeat rows and the runs' rows, read by preflight, `brain_info` and a GUI page. n8n's own templates keep their history in n8n. | Accepted (2026-10-28) | n8n's run history; a separate surface per task |
| 14 | **No brain content is saved in n8n.** A plugin workflow saves neither its successful nor its failed runs. Content passes through n8n's memory for a run's life. | Decided (maintainer, 2026-10-28) | n8n's 24-hour window for plugin runs |

## The shape

### An interactive tool call

Take `crm_add_contact`, professional-crm's tool once it is a plugin with a workflow (SMD-2311):

1. The client calls the tool on the brain's MCP server. The MCP server forwards it to the REST core as it forwards any plugin operation (`POST /v1/plugins/professional-crm/contacts`), with the client's key or exchanged token (`operator-surface-tiers.md`, "Identity").
2. The REST core checks the caller, the scope and the input against the manifest, as it does today. The operation's implementation is a workflow, so it opens a run: a row with the caller's principal, the operation, its bounded scope, the class `live` and a deadline.
3. The REST core asks the coordinator to start the run, authenticated with the dispatch key (see "Credentials"), passing the run id and the input.
4. The coordinator admits the run against the plugin's limit, the brain's and n8n's (see "Failure and limits"). It POSTs to the workflow's Webhook trigger with the trigger key, the run id and the input, then waits up to the deadline.
5. The workflow runs its steps:
   - its brain calls go to the REST core (`http://api:8000`) with the `run` key credential and the run id, each one its declaration lists: its plugin's data operations, core operations (for example `capture_thought`), another plugin's operations, and a model call through the egress gate;
   - its outside calls go through n8n credentials pinned to their hosts.
6. The last node's answer goes back to the coordinator, which returns it to the REST core. The REST core holds it to the output schema, closes the run and answers the client. A workflow refuses as a handler does: its last node answers `{ "refusal": { "status", "code", … } }`, which the REST core answers as a `PluginRefusal`.

### Chained runs

When a run calls another plugin's operation that is itself a workflow (job-hunt adding a contact through professional-crm's operation), the REST core opens a child run:
- **its caller** is the parent's caller, and its bound is the parent's intersected with the child operation's scope;
- **its class** is the root's, and its deadline the parent's remaining time;
- **its row names its parent**, so the audit and the status surface show the chain;
- **the depth is two:** a child run cannot open another, and a run cannot open a child of its own plugin;
- **it counts against its root's admission**, not as a new run, so a parent waiting on its child cannot deadlock behind the coordinator's caps.

A called operation that is a handler opens no child run: the REST core runs the handler under the calling run's bound. A handler that calls a workflow operation opens a run whose caller and bound are the handler's (see "Identity").

### A webhook

`/hooks/<plugin>/<name>` keeps what SMD-2310 built: the plugin's hook handler checks the sender's signature against its secret in `OB1_HOOK_SECRETS`, inside `onceById`, so a resend of a delivery that captured does not run twice. A new `HookContext` method opens a run as `hook:<plugin>`. Its bound is capture scope for core operations, as today, and for its own plugin's data operations, those the hook declares, whatever their scope, as a hook's handler may write its tables today (`HookContext.db`). The handler answers the sender when the run ends, or at once with 202 when the sender cannot wait: Slack retries a delivery not answered within 3 s (`integrations/slack-capture/README.md:315`).
- **After a 202 the sender resends nothing** (`server-portable/plugin-sdk.ts:157`), so a failed run reaches the fault log and the run's row alone.
- **The claim** is given back as it is today when the handler throws or hands back no thought (`plugin-sdk.ts:305`), so a later resend of the same delivery may run. A run whose outcome is unknown keeps its claim to lapse instead, as `onceById` already does for an answer it cannot record (`plugin-sdk.ts:310`), so a resend cannot repeat a capture that may have happened.
- **A delivery is remembered by the thought it captured.** A hook whose run writes only its plugin's tables hands back no thought, so a resend runs again, as it would today. Such a hook makes its writes idempotent by the delivery id.
- **`onceById`'s lease** must outlast the run's deadline. At default settings the lease is 180 s (`plugin-sdk.ts:332`).

### A plugin task

A manifest may declare a task: a workflow, its trigger (an interval, the brain's work period, or an event such as a capture), its scope (at most `write`), its calls, and whether it is idempotent. The coordinator opens its runs through the REST core as `task:<plugin>`, a service principal the core fixes, as it fixes `hook:<plugin>` (`server-portable/core/plugins.ts:378`). The coordinator cannot open a run for any task an enabled manifest does not declare, or as any user. Task runs are `background`, so their model calls take background slots and pause for live work.

### A core pass

Core passes are not plugins. The coordinator runs them as `db/supervise.ts` runs them today, each a child process on Postgres. It holds the exclusion (`sleep` or the `workers` followers, never both) by construction rather than by refusal, and board-sync's interval becomes one of its triggers. SMD-3379's scheduler and its admit gate become the coordinator's background half, unchanged.

## Every task, and where it goes

| Task | Today | Under this record |
| --- | --- | --- |
| Sleep scheduler and its passes | `sleep` service, through `db/supervise.ts` | A child of the coordinator; SMD-3379's background half |
| Extract and consolidate followers | `workers` profile, an alternative to `sleep` | Children of the coordinator, exclusive with `sleep` by construction |
| board-sync | `board-sync` service with its own loop | A child of the coordinator, its interval a coordinator trigger |
| Migrations | `migrate`, one-shot | Unchanged: it runs before the stack's servers. The coordinator waits it out, as the followers will through SMD-3379's migration lock (its PR 1a, not yet built) |
| Model pull | `ollama-pull`, one-shot | Unchanged: provisioning, not a task |
| Import runner (and its role job) | `orchestration-runner`, asked by n8n's import template | Unchanged: a batch write straight to Postgres (`operator-surface-tiers.md`, "Where everything else lives"). Its state joins the status surface through a row of its own, which step 1 adds |
| Re-embed, rebuild, benches | by hand; SMD-1869's re-embed verbs as `workers` one-offs | Unchanged: an operator's commands, not tasks |
| n8n's own templates: the import template, the act tool | n8n's Schedule trigger; n8n's MCP endpoint | Unchanged under `orchestration-tool.md` decisions 5 and 7. The act tool can become a plugin operation (follow-up). The import template's schedule becomes a coordinator trigger after step 4 (decided 2026-10-28) |
| The six extensions, three integrations, three recipes, Slack and Telegram | standalone servers, workers, libraries, README samples | Plugin operations, webhooks and tasks ("Measured" has each) |
| entity-extraction-worker | a worker | Retires (decided 2026-10-22): its tables clash with core migration 016 |

## The seams

| Seam | Closed? |
| --- | --- |
| Reboot | Yes. SMD-3214 closed it for today's services, and the coordinator is `unless-stopped` and restarts its children. |
| Mutual exclusion | Yes, by construction: the coordinator starts `sleep` or the followers, never both. |
| Status | Yes: one surface (row 13). Heartbeat rows stay, as the view's input. |
| Yield | For model slots, yes: SMD-3379's classes put live calls first, across brains through the slot service. For n8n's one process, in part: the coordinator caps background runs inside n8n, so a burst of tasks queues in the coordinator rather than inside n8n, but a background run already started still holds its place. |
| Scheduling | Yes, after step 4. Sleep's work period, board-sync's interval and plugin task triggers are the coordinator's, and the import template's schedule moves to a coordinator trigger then (decided 2026-10-28). Until it does, n8n's Schedule trigger is a second clock. |

## Credentials

| Credential | Held by | Grants |
| --- | --- | --- |
| Dispatch key (new) | REST core; checked by the coordinator | Asking the coordinator to start a run the REST core opened |
| `coordinate` key (new scope) | The coordinator | Opening runs of the tasks the enabled manifests declare, as `task:<plugin>`, and reporting a run's end; nothing else |
| Trigger key (new, separate from `N8N_WEBHOOK_KEY`) | The coordinator; checked by each plugin workflow's Webhook trigger | Starting a plugin workflow |
| `run` key (new scope) | n8n, as a credential pinned to `api` | Nothing alone. With an open run's id, that run's bounded caller |
| Board-sync's Linear keys, `OB1_WORKER_KEY`, the database credentials | The coordinator's container, as today's followers' | Each passed to its own child alone |

`run` and `coordinate` are scopes like `forward` (`server-portable/auth.ts:91`): no caller holds them. The agent registry records each such key with no scope, as it records a forwarder (`recordedScope`, `server-portable/agents.ts:181`), so each has an agent id for `act` and a revocation reaches it.

**The cost of option a.** Today each follower's container holds only its own secrets. One coordinator container holds the union. Each child runs as its own user with only its own settings (the import runner already runs each step as a user of its own), so no child reads another's environment. But a compromise of the coordinator's own process reaches every secret its container holds. Option b avoids that only by holding the container runtime's socket, which is worse.

**What the coordinator can do with runs.** It holds every live run's id, the trigger key (shared by every plugin workflow) and the `coordinate` key. A compromised coordinator could start any plugin's workflow with a live run's id and input of its own, acting as that run's caller until the deadline, and could open a run of any task the enabled manifests declare, with input of its own. What bounds each is the run, not the workflow: the calls its declaration lists, within its scope. That is why calls are declared per operation, hook and task, not per plugin.

## Identity

- **The REST core opens every run**, the only place that already checks callers. Neither the coordinator nor n8n mints anything.
- **What n8n presents** is the `run` key, held as an n8n credential pinned to `api`, plus the run id in `x-brain-run`. The run id is random (128 bits), held in the brain only as a digest, never saved in n8n (row 14), and useless without the key. The key opens nothing without an open run. n8n sends a credential only to its pinned host, and the lint refuses a brain call made without it (check 31).
- **The bound** is the caller's scope intersected with the operation's: a write-key caller of a read operation gets a read-scope run. Within it, the run may call only what its declaration lists in the manifest: data operations of its own plugin, core operations, and other plugins' operations (job-hunt writing a contact through professional-crm's operation, not its table). The run's row records its declaration, and each call is checked against that declaration's list and the bound.
- **One bound for both implementations.** A handler has no run, but the same bound: the caller's scope intersected with the operation's, and the calls its operation lists. Today a handler's `ctx.call` acts with the caller's whole scope and reaches core operations alone (`server-portable/plugin-sdk.ts:50`, `:59`). Step 2 narrows it to that bound and lets it reach the other plugins' operations its operation lists, so swapping a handler for a workflow changes nothing a caller can do.
- **Each use checks** that the run is open, inside its deadline, and that its caller is still valid. Revoking a key or banning a subject stops its runs at their next call.
- **The audit** records the caller as the subject, as for a forwarded key. `actor_context.act` is the `run` key's `{name, agent_id}`, as the forwarder's is (`server-portable/auth.ts:133`). The run id is a new member of `actor_context`, `run`, so the row's columns do not change.
- **The headers are inside the stack only.** `x-brain-run` is deleted wherever `x-brain-forwarder` is: the `/api` overlay (`deploy/compose.api-public.yaml`), the hooks overlay (`deploy/compose.hooks-public.yaml`) and the edge (`deploy/edge/edge.ts`).

This answers `orchestration-tool.md` decision 7's objection to the brain's tools behind n8n: no caller reads as n8n's key.

**What this departs from.** `operator-surface-tiers.md` decision 7 declined "a service credential plus an asserted user". A run is not that: the user is not asserted by n8n or the coordinator but recorded by the REST core when it opened the run, from a credential it checked itself. A task's principal is a service principal the core fixes, never a user. **What it is close to:** inside a run's window, whoever holds the `run` key and the run id can make any call within the run's bound, with any input. The pair is a bearer handle the REST core issued, short-lived and bounded, and that is what row 6 accepts in exchange for keeping every caller's own credential out of n8n.

## Data

Plugin tables stay where SMD-2310 put them: schema `plugin_<name>`, owned by role `ob1_plugin_<name>`, migrations in `plugin_migrations`. What changes is who calls the SQL:
- **Data operations** are declared beside the public ones, with `ctx.db` handlers and a scope, and served only to a run of the same plugin whose declaration lists them and whose bound covers their scope (a hook's run excepted, as "A webhook" says). Neither `tools/list` nor the OpenAPI document lists them.
- **One data operation is one transaction.** A sequence that must be atomic (read a row and write it back; insert into two tables) is one operation, never several workflow steps, since a workflow has no transaction across its steps.
- **No n8n node reaches Postgres**, so `orchestration-tool.md`'s decision 3 (n8n's store is not the brain's server) and decision 4's REST-core boundary hold.
- **Each plugin logs in as its own role** (SMD-2756, decided 2026-10-28). Handler SQL still runs in the REST core's process, so each plugin's pool and migrations log in as a login role of its own that may `SET ROLE` to its own plugin's role alone, its password derived from one master secret. SQL that undoes its role can then reach no other plugin's tables. This lands before the first port that carries SQL.

## What n8n runs with

- **Workflows live in the plugin's directory**, `plugins/<name>/workflows/*.json`. `deploy/orchestration/provision.ts` loads the enabled plugins' workflows from the checkout, in the same run that loads the templates today. A brain does not author workflows here; SMD-2274 decides whether it ever may.
- **Check 31 reads them.** Today a plugin may hold only TypeScript, its migrations, a README and its metadata (`scripts/check-fork-consistency.ts:9155`). It gains workflow JSON, read against rules:
  - node types from an allowlist, with no Code node, no AI node, and none of Execute Workflow, Respond to Webhook, Wait or the n8n API node;
  - credentials only the `run` key's and those the manifest declares, every one pinned to its host, and none pinned to a host of the stack but `api` (so not `ollama`, `jev`, `orchestration-runner`, the coordinator or n8n itself);
  - every HTTP Request node credentialed, with a literal host, and every brain call made with the `run` credential to `http://api:8000`;
  - the trigger's header auth set, and its answer the last node's;
  - an execution timeout no longer than the deadline, and each HTTP Request node's own timeout within it, since n8n's execution timeout is not known to stop a node mid-request (not used in the repo today; step 2 measures it);
  - saving off for both successful and failed runs.
  Provisioning refuses a plugin workflow that breaks any of these, as it refuses a misplaced brain credential today. Its brain-scope rule, which takes only capture and read (`deploy/orchestration/provision.ts:389`), gains `run` for plugin workflows alone. The Code node is barred because it runs arbitrary JavaScript, network calls included, that the credential rules cannot see. Expressions are code in every node too, which is why hosts must be literal. Whether n8n keeps credentials from a Code node has not been measured.
- **Networks.** n8n stays on `egress` alone (SMD-2583). The coordinator joins `egress` to reach it and `data` for the core passes, as the followers do. The dispatch key is what lets only the REST core start a run: the coordinator listens on `egress`, beside n8n and the model servers.
- **Outside services.** Every credential is pinned to its host, as SMD-2211 requires. A workflow that sends brain content out is a sink, and waits on SMD-2211's checkpoint (`orchestration-tool.md` decision 9).

## Measured

### The extension surface (main 32424f81)

Read from the code. Every component below reaches Postgres through `compat/supabase-sql` today, none through a REST-core operation.

| Component | Kind | Operations | Model calls | Outside hosts | Trigger |
| --- | --- | --- | --- | --- | --- |
| family-calendar, home-maintenance, household-knowledge | MCP tools | 6, 4, 5 | none | none | request |
| job-hunt | MCP tools | 10 | none | none | request |
| meal-planning (`index.ts`, `shared-server.ts`) | MCP tools | 6 + 4 | none | none | request |
| professional-crm | MCP tools | 10 | none | none | request |
| agent-memory-api | HTTP API | 9 routes | embeddings | none | request |
| smart-ingest | HTTP API | 2 routes | chat, embeddings | the extraction worker | request |
| readwise-capture | webhook | 1 | embeddings | `readwise.io` | webhook |
| consolidation-workers: bio, metadata-norm | workers | 1 each | chat (metadata-norm one per row, at most 100), embeddings | none | cron |
| entity-extraction-worker | worker | 1 | chat per item | none | cron, smart-ingest |
| adaptive-capture-classification | library | 2 | chat | none | by hand, with a person confirming between the two |
| editorial-policy's auditor | worker | 1 | chat | `slack.com` | weekly |
| schema-aware-routing | library | 1 | stubs that throw | none | by hand |
| slack-capture, telegram-capture | code in their READMEs | 1 each | chat, embeddings | `slack.com`, `api.telegram.org` | webhook |

What it says about the move:
- **43 of the six extensions' 45 tools are reads or writes of their own tables, and none calls a model or an outside service.** The two exceptions: `crm_link_thought` reads core `thoughts` directly (`extensions/professional-crm/index.ts:486`), and job-hunt's link tool writes professional-crm's table. For these tools a workflow adds no capability. It is one data operation behind a webhook, so its cost is the latency measured below.
- **Everything else calls a model and writes core `thoughts`**, through `upsert_thought` and `update_thought` and also by raw updates (smart-ingest, readwise-capture, bio, metadata-norm, schema-aware-routing). Under row 7, each raw write becomes a core operation, and each model call the brain's own, through the egress gate.
- **Several writes read and then write in separate statements**, not atomically: professional-crm's notes append, `mark_item_purchased`, `generate_shopping_list`, job-hunt's link, agent-memory-api's writeback. Each becomes one data operation in one transaction (see "Data").
- **Some behaviour lives in triggers** (home-maintenance's next-due date, professional-crm's `last_contacted`). These stay in the plugin's migrations, inside its own schema.
- **entity-extraction-worker cannot move.** Its schema's `thought_entities` (a BIGINT key to its own `entities`) clashes with core migration 016's (a uuid key to `ob1_entities`), and 016 replaces its queue.

### What n8n adds to a call (2026-10-28 UTC)

A throwaway measurement on the maintainer's Mac:
- **Machine:** Apple M5 Pro; podman VM (libkrun, 8 vCPU).
- **n8n:** the profile's pinned image (2.40.6), on SQLite, provisioned as `provision.ts` does.
- **Workflows:** each a Webhook trigger with header auth that answers with its last node.
- **The "brain":** a Bun stub on the host answering a small JSON body, with no database.
- **The relay:** a Bun container in the VM forwarding to the stub, so the floor carries the same VM hop as n8n.
- **Runs:** 30 warm-up calls, then 300 one after another, then 300 eight at a time. "Saving off" was n8n's global `EXECUTIONS_DATA_SAVE_ON_SUCCESS=none`; row 14's per-workflow setting is expected to cost the same, not measured. Every figure is in milliseconds.

| Shape | Saving successful runs | One at a time: p50 / p95 | Eight at a time: p50 / p95 |
| --- | --- | --- | --- |
| D1: relay → stub (the floor) | n/a | 0.4 / 0.4 | 1.7 / 3.6 |
| W0: webhook → answer | on (the profile) | 40.7 / 53.7 | 181 / 302 |
| W0 | off | 33.1 / 43.5 | 151 / 199 |
| W1: webhook → one brain call → answer | on | 46.7 / 64.0 | 233 / 434 |
| W1 | off | 36.4 / 46.3 | 169 / 233 |
| W3: webhook → three brain calls → answer | on | 54.5 / 80.2 | 238 / 341 |
| W3 | off | 53.2 / 83.9 | 275 / 383 |

What it says:
- **n8n adds about 46 ms at p50 and 64 ms at p95 to a call with one brain call** (W1 − D1, saving on); with saving off, about 36 ms and 46 ms. Each further step adds 4–8 ms at p50. An earlier run gave 41 ms per call, so expect about ±10% between runs.
- **The floor is n8n's own, not the VM's.** A call from inside the VM, container to container, took 38.7 ms against 40.7 ms from the host. n8n's own run record shows about 4 ms for W0. By the timestamps (not profiled), the rest goes to the webhook's handling, setting up the execution and the answer.
- **n8n is one process, and calls queue inside it.** Eight at a time, it served about 30–50 calls a second, and p50 rose to 150–275 ms. No measured call failed, and its CPU was not saturated (21–51% on the main thread), so something inside it serialises them. SQLite writes are a guess, not measured.
- **Rare stalls of about 68 s** hit 18 of 1,200 three-step calls in the run above, and 8 of 600 one-step calls in the earlier run. They are not n8n's. n8n's HTTP Request node opens a new connection per call, and podman's forwarding from the VM to the host on macOS stalls on some of them. The image's own Node, opening a fresh connection per call, stalled the same way, and with connections reused its worst call was 9.5 ms. In the stack, n8n reaches `api:8000` over the compose network, not through the host forwarder, so step 2 measures that path in CI before anything relies on it.
- **Memory:** about 500 MB for n8n under this load, against the profile's record of 369 MiB after its runs.

Caveats: one machine, macOS with podman, a stub in place of the REST core and Postgres, and n8n on SQLite. The coordinator's hop and the MCP server's are not in the figures; each is a call on the stack's own network.

## Failure and limits

- **Two refusals are new to the contract**, answered only by workflow operations:
  - `UNAVAILABLE` (503, retryable, with `Retry-After`) when the coordinator or n8n does not answer before the run is handed to n8n, so nothing has run;
  - `RUN_OUTCOME_UNKNOWN` when the deadline passes, or n8n or the coordinator is lost after the hand-off. Steps may have committed, so it is retryable only for an operation that declares `idempotentHint`.
- **Atomicity is per data operation.** A handler's writes roll back together. A workflow that fails after a data operation committed leaves that write in place, and answers `FAILED`. An operation whose writes must be all or nothing makes them in one data operation.
- **The deadline** is the operation's own (declared in the manifest, with a default) and closes the run. A brain call made after it is refused, so a workflow left running cannot write to the brain. n8n stops the execution at its own timeout, which the lint holds to the deadline. The coordinator keeps the webhook connection open past the deadline, up to that timeout and a grace, and counts the run against its caps until n8n answers or the grace passes, so nothing runs beside it unseen.
- **Retries** happen only inside the run's deadline, before the REST core answers, as a new execution under the same run: for an operation that declares `idempotentHint`, and a hook or task its declaration marks idempotent. Once the REST core has answered, the run is closed and nothing retries it. Otherwise a lost run is reported, not repeated.
- **Concurrency.** The coordinator caps runs per plugin, per brain and inside n8n, and queues the rest itself. n8n's one process served about 30–50 calls a second eight at a time (measured above). Live runs are admitted ahead of background ones, and background runs inside n8n are capped below the whole cap, so live runs keep room there.
- **An n8n restart** drops the webhook connections in flight at once. The coordinator retries the idempotent ones inside their deadlines; the others answer `RUN_OUTCOME_UNKNOWN`.
- **The coordinator down** fails every workflow operation and every webhook, and stops the core passes (sleep, the followers, board-sync) until it comes back. It is `unless-stopped` and restarts its children; the brain's servers and every core operation keep serving.
- **The run rows** have one writer, the REST core: it opens and closes each run, records an end the coordinator reports with the `coordinate` key, and deletes rows past retention (7 days by default; the setting names the days). A row holds no brain content: the caller, the operation, timings, its state, and on failure a code, plus the failing node's name where n8n's answer gives it (step 2 measures what it gives), never a body. `brain_info` shows counts and states alone.
- **Row 14 is unmeasured.** The latency measurement turned saving off globally and did not search n8n's store. Step 2 plants a marker string in a run's input and checks it is nowhere in n8n's store after the run, its SQLite file and write-ahead log included, and again after a run cut off by a restart.

## What this reverses or amends

Applied with this record on 2026-10-28, each in its own text (the tickets' in their own descriptions and comments):

- **`orchestration-tool.md`:**
  - **Decision 2** (an opt-in sidecar, never run by a brain plus Claude Code) is reversed: n8n is a default service of every brain (row 11). Its footprint (369 MiB after the profile's runs, about 500 MB under the measured load) and its provisioning become every brain's.
  - **Decision 4** (REST core only, a capture key, no write key): the REST-core boundary holds. A plugin workflow holds the `run` key, which grants nothing alone; with a run, it may write within that run's bound. A template still holds no standing write key.
  - **Decision 5** (templates, not a runtime): OB1 still ships templates, now also in each plugin's directory. n8n becomes the runtime for plugin operations.
  - **Decision 7** is reversed for plugin operations: its dividing line sent a call on demand to the client's connector and stateful work to n8n. A plugin operation is a call on demand, and it runs through n8n, carried by a run (row 6). The core's own tools still never do. Extension tools stay on the brain's MCP server; n8n's act tool stays on n8n's endpoint until it becomes a plugin operation, so a client using it keeps two connectors until then.
  - **Gate 2** is amended: "brain reads do not go through n8n" becomes "brain content passes through n8n's memory during a plugin run, and is saved nowhere in n8n" (row 14), and "nothing holds a write key" becomes the `run` key's rule above.
  - **Decision 9** is unchanged: a workflow that sends brain content out waits on SMD-2211.
  - **Gate 1, the licence:** the reading holds (OB1 references n8n's image and distributes none of it). Extension features now depend on software under the Sustainable Use License, which never converts to an open-source licence, while OB1's FSL-1.1-MIT does after two years. Hosting n8n for others stays outside the SUL. The maintainer accepted this on 2026-10-27, and with row 11 every brain, not only one with extensions, runs software under the SUL.
- **`operator-surface-tiers.md`:**
  - **"Contributions and plugins":** an operation's implementation may be a workflow the coordinator runs. "A plugin is given no outbound call" stays true of plugin code; outbound calls are n8n's, pinned per host.
  - **"Identity":** a run is a fourth way a caller reaches the REST core, beside a key, a forwarded key and an exchanged token.
- **`CLAUDE.md`'s guard rails:**
  - On plugins: "the brain's own servers serve it behind its own keys" holds. It gains that an operation's implementation may be an n8n workflow the brain's coordinator runs, and that check 31 reads the workflow too.
  - On deployment: the brain is still the compose stack alone, and its list of services gains the coordinator and n8n. The federated coordinator belongs to no brain; it runs on the host as a small compose stack of its own, as the edge proxy does (SMD-2876).
- **SMD-3379's design:** a model call made inside a run takes the run's class rather than one derived from the process and `EgressSubject.kind`, since every run's model call is made by the REST core.
- **SMD-3215's options:** option a is chosen (row 10), and "n8n is not the coordinator" holds: n8n defines and executes, the coordinator coordinates.
- **SMD-3319's decision of 2026-10-22** (bio and metadata-norm become `db/` workers) is reversed: they become plugin tasks (decided 2026-10-28).

## Order

Each step is its own PR. The ports run in parallel with handlers (decided 2026-10-27), so the shim (SMD-3216) does not wait for any of this:

1. **The coordinator, first form.** `db/supervise.ts` grows into one `coordinator` service that runs the core passes the enabled profiles name (`sleep` or the `workers` pair, and `board-sync`; since a `--profile` on compose's command line never reaches the container, the passes `OB1_PASSES` names, the profiles retired: decided 2026-10-28, SMD-3476), each as its own user with only its own settings, and adds a status row for the import runner. The exclusion holds by construction, and one status route reports each child. This closes the exclusion seam and starts the status surface.
2. **Runs.**
   - `coordinator_runs`, a core migration;
   - the `run` and `coordinate` scopes (`recordedScope` recording them with none), and the dispatch and trigger keys;
   - `x-brain-run` deleted wherever `x-brain-forwarder` is, with the checker's pins for that stripping extended to it;
   - declarations' call lists, chained runs (the parent column, the depth, admission against the root);
   - an implementation kind `workflow` in `plugin-sdk.ts`;
   - the coordinator's dispatch;
   - check 31's workflow rules, and `provision.ts` loading plugin workflows under them;
   - a handler's `ctx.call` narrowed to the same bound, and reaching the other plugins' operations its operation lists;
   - the marker check of row 14, and what n8n's timeout and failed-webhook answer give;
   - n8n made a default service of the stack (row 11), with its provisioning in the stack's setup;
   - one workflow operation on the example plugin, and a CI full-stack step that times the round trip on the stack's own network and fails above 100 ms at p95 for a one-step workflow (decided 2026-10-28).
3. **Data operations and the model call:** run-only data operations, and a model call through the egress gate as a REST-core operation carrying the run's class.
4. **Plugin tasks** under the coordinator, in the background class, and the import template's schedule moved to a coordinator trigger.
5. **Webhooks open runs:** `HookContext`'s run; a run's failure mapped to a throw, so `onceById` gives the claim back as it does today; an unknown outcome keeping the claim to lapse; the lease sized past the deadline.
6. **Ports move from handlers to workflows**, plugin by plugin: SMD-2311 (the six extensions), SMD-2690 (the three integrations), SMD-2101 (Slack and Telegram), SMD-3320 (the three recipes) and SMD-3319 (bio and metadata-norm as plugin tasks).

The federated coordinator comes with SMD-3379's third PR, its slot service, and needs nothing above.

## Open questions, answered

1. **Core passes: answered 2026-10-27, they stay native** (row 9). They claim and lease rows on Postgres in batches, and as a workflow each thought would cost a REST call through n8n. **Answered 2026-10-28:** SMD-3319's two vendored consolidation workers (bio, metadata-norm) are extensions, so they become plugin tasks, not the `db/` workers decided on 2026-10-22.
2. **Ports before runs: answered 2026-10-27, yes.** A port lands now with handlers, under the same contract, and moves to workflows once step 2 exists. The shim's importers retire without waiting for the coordinator.
3. **SMD-2756: answered 2026-10-28, one login per plugin**, its password derived from one master secret, before the first port that carries SQL (see "Data").
4. **n8n: answered 2026-10-28, in every brain** (row 11), a default service rather than a profile.
5. **The licence: answered 2026-10-27, accepted.** Extension features may depend on n8n's Sustainable Use License.
6. **No run data in n8n: answered 2026-10-28, as recommended** (row 14). Neither successful nor failed plugin runs are saved. A failure is diagnosed from the run's row in the brain, which records the error's code, and the failing node's name where n8n's answer gives it. The declined alternative kept failed runs for n8n's 24-hour window, with brain content in them.
7. **The latency budget: answered 2026-10-28, as recommended.** Measured: about 36–46 ms per call at p50 and 46–64 ms at p95, plus 4–8 ms a step, one at a time. It is accepted for interactive tools, since an AI client's turn takes seconds, and CI holds the stack's own path (step 2) to a ceiling of 100 ms at p95 for a one-step workflow.
8. **The import template's schedule: answered 2026-10-28, as recommended.** It moves from n8n's Schedule trigger to a coordinator trigger after step 4, so the brain has one clock.

## Not decided here

- **The federated coordinator's protocol** beyond slots: what else it holds for a federation (SMD-2877, SMD-3268). How a live call's slot request reaches it is SMD-3379's third PR's.
- **Workflows a brain writes on request** (SMD-2274). Under this record, only reviewed templates run.
- **Multiple users per brain** (SMD-1716).
- **Each port's details:** which of upstream's `user_id` columns survive, and which tables are adopted (SMD-2311's own decisions).
- **Provisioning as a service.** `provision.ts` runs from a checkout against n8n's loopback port today. Whether it becomes a one-shot service in the stack is not decided here.

## Related

- `orchestration-tool.md`: the n8n decision this amends
- `operator-surface-tiers.md`: the REST core, identity, and plugins (decisions 7, 9–12)
- `one-brain-per-stack.md`: why a coordinator coordinates its own brain, and the host alias
- `../plugins/README.md`: the plugin mechanism as built
- `../db/supervise.ts`: the first form's starting point
- SMD-3379: the slot service and the work period
