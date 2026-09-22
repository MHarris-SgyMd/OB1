# Connector taxonomy and the brain-side seam (SMD-1933)

The fork carries many per-vendor implementations of a few external-system
interfaces: five capture integrations and eleven import recipes on the way in,
five digests and briefings on the way out, and the same vendor on both sides
more than once (`docs/vendored-disposition.md`, SMD-1924). This document is the
classification that collapses them, and the seam that lets **any** fetcher — a
node of the orchestration tool SMD-1863 picks, a native OB1 driver, the AI
client's own MCP connector, a browser extension — land in the brain through
**one schema per family** with no vendor client of OB1's own.

It is a spec with a data file behind it. `docs/connector-registry.json` is the
one source: the facet sets, every family's schema, every external-touching
artifact with its capabilities. The tables at the end of this page are rendered
from it by `scripts/connector-registry.mjs`, and `check-fork-consistency`
check 18 holds the registry sound, the tables current, and the coverage
complete (see "Held by"). Edit the JSON; run the script; the prose here is the
part a human writes.

Sibling contracts, so the boundaries are named once:

- **SMD-1867** gives the ingress adapter's *output* — canonical / text / edges /
  metadata / identity. This page names its *input families* and says which
  fetcher may produce them. Nothing here changes SMD-1867's five outputs or its
  round-trip rule (preserve the source, derive the text and the edges).
- **SMD-1863** picks the orchestration tool. The seam is designed so the pick
  changes *how many* fetchers are low-code nodes, not the schema any of them
  hands over.
- **SMD-1813** decides identity, conflict and the PHI allowlist once. The
  allowlist is enforced *at this seam*, one checkpoint for every source and sink.
- **SMD-1930** is the enrichment runner past the seam (atomization, extraction,
  classification). A stage that splits one captured item into several thoughts
  is enrichment, not mapping — see the cardinality facet.
- **SMD-1931** is the brain's outward surface. The brain-side capture node the
  seam lands on is a route of that surface; this page names the payload, not
  the route.

## The five facets

Every connector capability resolves to **exactly one value per facet**. A value
off a closed or near-closed set is a spec change: it edits the registry and the
pinned sets in `scripts/connector-registry.mjs` together, and the check refuses a
registry that redefines a set on its own.

| Facet | Values | Stability | What it answers |
|---|---|---|---|
| **family** | `mailbox/email` · `message-stream/chat` · `conversation-export` · `activity-export` · `annotation/highlight` · `document/page` · `web-clip` · `calendar/event` · (`notification-target`, reserved) | **open** — grows as new sources appear; a new family is declared with its schema *before* an artifact uses it | what the item *is*; vendors within a family differ only in auth and wire format |
| **transport** | `push` · `pull` · `batch` | near-closed | how new data reaches the seam: the vendor calls in as things happen; the fetcher asks on a schedule or on demand; a one-shot archive. For a sink, how the brain's output reaches the vendor (a send is `push`). **Not a wire protocol.** |
| **direction** | `source` · `sink` | closed | per capability. A **connector**'s direction is derived — `bidirectional` when its capabilities span both |
| **cardinality** | `1:1` · `1:many` · `many:1` | near-closed | vendor item → thought *at the seam*. The family names the item and owns the grouping key |
| **round-trip** | `read-only` · `writable` | closed | whether the brain writes the item back. `writable` invokes SMD-1867's canonical-is-truth rule: the stored source form must round-trip byte for byte |

The old vocabulary collapses into these: `webhook-push` is `push`, `api-poll` is
`pull`, `batch-export-file` is `batch`; `outbound-send` was never a transport,
it is the `sink` direction; `browser-extension` was never a transport, it is a
**fetcher** (below).

**Cardinality is the mapping's, not the pipeline's.** `gmail-smart-pull`
atomizes a long message into several thoughts and declares `1:1`, because one
message reaches the seam as one item and the split is an SMD-1930 stage after
it. `chatgpt-conversation-import` declares `1:many`, because the LLM extraction
*is* what reaches the brain today — the recipe has no seam yet. When such a
recipe is re-expressed as a thin adapter, its cardinality becomes the family's
default and the extraction moves past the seam; the registry row changes then,
not before.

### Wire protocol is below the seam

The protocol a source speaks — REST, WebSocket, SSE, gRPC, AMQP, MQTT, Kafka,
SNS/SQS, a file on disk — is a fetcher detail, terminated by the tool's node,
the MCP server or the native driver, **never by OB1**. Whatever the protocol,
the fetcher hands the seam the family canonical, so OB1's inbound surface stays
REST + MCP over HTTP and grows no socket, stream or broker listener: the
persistent-connection weight (reconnects, subscriptions, backpressure) is what
the SMD-1863 sidecar absorbs. Today the tree speaks HTTP only — webhooks and
polling on the way in, MCP over Streamable HTTP, SSE only as MCP's streaming
response shape (SMD-1259) — and no WebSocket, AMQP, MQTT, SNS, Kafka or gRPC
client exists in it. `discord-capture` needs Discord's message-content gateway
intent on its bot; whatever session that bot holds is the bot's business, not
the brain's.

## The unit is a capability; a connector is a vendor

"Source" and "sink" are not connector types. They are **capabilities of one
vendor driver**, and the registry models them that way:

- An **artifact** (a folder under `integrations/` or `recipes/`) declares one or
  more capabilities. Most declare one. `chrome-capture-extension` declares six
  (three vendors, each with a manual `push` and a bulk `pull`); `life-engine`
  declares three (two chat sinks and a calendar source).
- A **connector** is a vendor. It is not declared in a folder of its own; it is
  the set of capabilities across the tree that name that vendor, and its
  direction is derived from them. The registry's `connectors` block declares the
  direction once so the check can hold it, and refuses a declaration the
  capabilities do not derive.

So the duplicated cases the ticket names are one connector each, with the
previously separate artifacts as its capabilities:

| Connector | Source capabilities today | Sink capabilities today |
|---|---|---|
| `telegram` | `telegram-capture` (push), `vercel-neon-telegram` (push) | `weekly-digest`, `life-engine`, `life-engine-video` |
| `gmail` | `email-history-import` (pull), `gmail-smart-pull` (pull) | `daily-digest` (a draft, through the client's Gmail MCP) |
| `discord` | `discord-capture` (push) | `life-engine` |
| `slack` | `slack-capture` (push) | `editorial-policy` (optional critical-findings post) |

Four vendors, eleven distinct artifacts, four drivers' worth of client. The generated
tables below carry every connector, with the counts on their first line.

Two rules that settle the edge cases:

- **An ack is not a sink.** The threaded confirmation `slack-capture`,
  `telegram-capture` and the Vercel bot send back to the captured message is part
  of the source capability. A sink delivers *brain content* to a destination on
  a cadence or on demand.
- **A chat with the agent is not a capture source.** `life-engine`'s Telegram
  channel is two-way, but the inbound side is the user talking to Claude Code;
  what the agent chooses to remember goes through the brain's own MCP surface as
  the agent's capture, and is that surface's concern (SMD-1541's actor, not a
  connector).

## The seam: one family schema, any fetcher

A **fetcher** is whatever obtains the vendor item. Four kinds, one contract:

| Fetcher | When | Owns |
|---|---|---|
| **low-code node** — a node of the tool SMD-1863 picks | the default for any vendor the tool exposes; every stateful workflow (schedule, trigger, retry, multi-step, two-way sync) | vendor auth, pagination, rate limit, retry, the persistent connection |
| **native driver** — a typed OB1 script or function | a vendor the tool lacks, a one-shot archive parse (a tool adds nothing to a file walk), or where a reviewable typed script is preferred | the same, in OB1's tree, held to the check-fork rules |
| **MCP server** — the AI client's own connector or channel plugin | one call on demand from the AI client: "draft this digest", "what is on my calendar" | the vendor call, inside the client |
| **browser extension** — a client in the user's browser | what the user is looking at, pushed when they choose; bulk sync over a session the browser already holds | the DOM or the session the vendor exposes only there |

Every fetcher hands the seam the same thing: the **family canonical**, the
shape each family's schema below names. The vendor payload never crosses the
seam. Mapping vendor payload → family canonical is the *one* per-vendor step,
and it lives with the fetcher — a transform node in the tool, a function in the
driver — because it needs no brain state. Everything after the seam is the
family's and the brain's: canonical → text, edges, metadata, identity
(SMD-1867's projection), dedup by fingerprint, `upsert_thought`, idempotent edge
upsert, lineage. So:

> **A new vendor in a known family = one mapping from the vendor's existing
> node output to the family canonical. No OB1 vendor client, no pipeline
> change, no family code.** An IMAP mailbox beside Gmail is a mapping into
> `mailbox/email`; Matrix beside Slack is a mapping into `message-stream/chat`.

**The envelope.** What crosses the seam is one JSON object per item (or per
grouped item for a `many:1` family):

```jsonc
{
  "family":    "mailbox/email",            // a declared family
  "vendor":    "gmail",                    // the connector
  "fetcher":   { "kind": "low-code-node", "name": "n8n/gmail-trigger@2" },
  "identity":  "gmail:me@example.com:<CAF+…@mail.gmail.com>",   // the family's identity rule
  "observed_at": "2026-09-22T14:03:11Z",
  "canonical": { /* the family schema's canonical shape, source form intact */ }
}
```

`identity` is computed by the family's rule from fields in the canonical, so a
fetcher cannot invent one; the brain recomputes it and refuses a mismatch.
`fetcher` is provenance — it lands in the audit row's `actor_context` beside
`via` (SMD-1541), which is how "the same item from a low-code node and from a
native driver" is checked: same identity, same canonical, two fetchers.

**Where it lands.** The brain-side capture node is a route of the SMD-1931
surface — today `open-brain-rest`/`rest-api`'s `/ingest` and the
`capture_thought` tool are the two ways in, and SMD-1931 makes them one
definition. This page fixes the payload; that ticket fixes the route. A
`retrieve` counterpart (search + fetch) is the same surface's read side and is
what a sink's workflow calls to get the thoughts it delivers.

**What OB1 owns / what the tool owns.**

| OB1 owns | The fetcher owns |
|---|---|
| the family schemas and the identity rules | vendor auth (OAuth, bot tokens), token refresh |
| the facet sets and the connector model | pagination, rate limit, retry, backoff |
| canonical → text / edges / metadata (SMD-1867) | the persistent connection (webhook endpoint, gateway session, subscription) |
| dedup, `upsert_thought`, edge upsert, lineage | the vendor payload → family canonical mapping |
| the capture / retrieve node the fetcher calls | scheduling and the workflow state |
| the PHI allowlist and the egress decision at the seam | nothing about what is allowed in or out |

**The dividing line, per transport** (SMD-1863's "stateful workflow → tool; one
call on demand → MCP", applied):

| Transport | Default fetcher | Why |
|---|---|---|
| `push` | low-code node (native driver until SMD-1863 lands; browser extension when the vendor exposes the data only in the browser) | a webhook receiver or a gateway session is state the tool holds; OB1 grows no listener |
| `pull` | low-code node; the client's MCP connector when the AI client asks on demand | a schedule with a cursor is a workflow; "read this thread now" is one call |
| `batch` | native driver | an archive parse has no workflow state; the tool adds nothing |
| `push` (sink) | low-code node when the tool schedules it; the client's MCP connector or channel plugin when the AI client sends it | the send is one call either way; what differs is who owns the cadence |

Each family's schema names its own line where it differs (a two-way
`document/page` sync is a workflow with SMD-1813's rules applied in the brain,
not in the node).

## Adding to the classification

- **A new vendor in a known family.** Write the mapping where the fetcher lives.
  Add the artifact to `docs/connector-registry.json` with its capabilities; add
  the vendor to `connectors` with the direction the capabilities derive. Tag the
  artifact's `metadata.json` with the vendor's name and name its service in
  `requires.services` (a service string a model-provider pattern also matches,
  such as "OpenAI ChatGPT conversations API", is covered by the tag). Run
  `bun scripts/connector-registry.mjs`. Nothing else.
- **A new family.** Declare it under `families` with every schema field before
  any capability uses it. The check refuses a capability naming an undeclared
  family, and refuses `notification-target` until its `reserved` flag is dropped
  — which is the spec change the ticket names, made on purpose.
- **A second direction for an existing vendor** (Obsidian becomes writable under
  SMD-1814). Add the capability; the connector's declared direction must move to
  `bidirectional` in the same edit or the check names the disagreement.
- **An artifact that looks external but is not.** A dashboard over the brain's
  REST surface, an agent runtime consuming the brain, a backup to local JSON, a
  skill over the MCP surface: excuse it by name under
  `not_connectors.artifacts` with the reason. An excuse for an artifact nothing
  marks any more is refused as stale, so the list cannot rot.

## One checkpoint: PHI and egress at the seam

SMD-1813's allowlist — *default nothing, enforced by configuration* — and
SMD-1903's egress policy apply **at the seam**, not in each connector:

- **On the way in**, the envelope's `vendor` + `identity` scope (a mailbox label,
  a channel id, a vault path, a calendar id) is checked against the allowlist
  before the canonical is embedded or shown to a model. A source not on the list
  does not sync and the refusal is visible — in the capture node's response and
  in the audit row. `gmail-smart-pull`'s local sensitivity routing is the
  precedent: it decides *before* anything leaves the box, and its verdict
  travels in the envelope's metadata as `sensitivity`.
- **On the way out**, a sink's `retrieve` is an egress: `mayLeaveBox` decides per
  destination, `OB1_EGRESS_POLICY` denies by default, and the decision is
  recorded on the audit row (SMD-1903). `daily-digest` sending the day's
  thoughts to a Gmail draft crosses this line today and is the first sink the
  checkpoint fences.

One checkpoint means one place to test: a source scope off the list is refused
whichever fetcher brought it; a sink to a denied destination is refused
whichever workflow asked.

## What stays OB1's, and where it goes (SMD-1918)

The primitives that remain the brain's after the tool takes the transport, and
their home under `primitives/` once SMD-1918 extracts them:

- **Webhook receiver verification** — the shared-secret compare
  (`extensions/_shared/auth.ts`'s `secretMatches`, SMD-1455) every push receiver
  in the tree already uses; a low-code node inherits it as the node's auth, a
  native driver keeps it.
- **The ack reply** — the source capability's confirmation to the captured
  message, one helper per chat family, never a sink.
- **Identity + fingerprint** — the family identity rule and the content
  fingerprint (`recipes/content-fingerprint-dedup`, migration 003/005/033) that
  together make a re-delivery a no-op regardless of fetcher.
- **The archive walker** — the batch families' file walk (Takeout, an X or
  Instagram export, a vault) as one primitive the import recipes share instead
  of eleven copies.
- **OAuth token custody** — held by OB1 only for native drivers; moves to the
  tool's credential store for every vendor it fetches. How many vendors that is
  falls out of SMD-1863, which is why the seam is fixed first.

## Held by

`scripts/check-fork-consistency.mjs` check 18, one pure function
(`registryProblems` in `scripts/connector-registry.mjs`) with must-fail and
must-pass probes on every run:

- the four closed and near-closed facet sets and the fetcher set equal the
  pinned ones; a fifth value or a sixth facet is a spec change;
- every family declares its schema; a reserved family is used by no capability;
- every artifact is a directory that exists, listed once, with capabilities
  naming exactly the five facets and a fetcher from the sets and a declared
  family, no capability repeated;
- the connectors are exactly the vendors the capabilities name, each with the
  direction its capabilities derive;
- **coverage**: every contribution whose `metadata.json` names a service that is
  not a model provider, the hosting or the brain's own surface (a pattern covers
  a service string only when it matches within the first two words, so
  "OpenRouter or Anthropic" is a provider and "Notion API (summaries via
  OpenRouter)" is a vendor — one external system per entry, its name first), or carries a
  connector-shaped tag (`import`, `capture`, `digest`, `webhook`, `export`,
  `sync`, `messaging`, `email`, `bot`) or a tag naming a declared connector
  (`telegram`, `gmail`, …), or sits in an SMD-1867 row of
  `docs/vendored-disposition.md`, is classified or excused by name — never both,
  never neither; a classified artifact nothing marks is refused (declare the
  vendor in its metadata); a stale excuse and a service pattern matching nothing
  are refused;
- the tables below equal what the registry renders.

`bun scripts/connector-registry.mjs --check` runs the same rules by hand.

## Verify status

| Verify item (SMD-1933) | Status |
|---|---|
| The classification covers every SMD-1924 external-touching artifact, each with the five facets | **Done, mechanical.** The counts are the generated block's first line; check 18's coverage rule sweeps every `metadata.json` and the disposition table, so the claim is re-proven on every run |
| A bidirectional vendor is one connector serving capture and digest | **Done.** `telegram`, `gmail`, `discord`, `slack` derive `bidirectional` from their capabilities; the check refuses a declaration the capabilities do not derive |
| A new vendor in an existing family is added with only a driver/mapping | **Specified** (the envelope, the family schemas, the "Adding" recipe). **Proven when SMD-1867 lands the pipeline** — until then a new recipe still hand-rolls the projection |
| The same vendor via a low-code node and via a native driver produce identical canonical / text / edges | **Specified** (identity recomputed at the seam, fetcher as provenance). **Proven on one vendor once SMD-1863 picks the tool** |

<!-- connector-tables:start — generated from docs/connector-registry.json by scripts/connector-registry.mjs; do not edit by hand -->
22 artifacts, 32 capability rows, 16 connectors (4 bidirectional), 7 of 8 declared families in use.

### Family schemas

What a fetcher of any kind hands the seam (the **canonical**), and how the brain projects it into SMD-1867's five outputs. The item, the grouping key and the identity rule are the family's, never the fetcher's.

#### `mailbox/email`

- **Item.** one message · default cardinality `1:1` · typical transport `pull`, `push`
- **Grouping key.** thread — RFC 2822 Message-ID / In-Reply-To / References, or the vendor's thread id
- **Canonical.** the RFC 2822 message: headers (Message-ID, Date, From, To, Cc, Subject, In-Reply-To, References, List-Id, Labels), the text/plain body, the text/html body, attachment names and types (never bodies)
- **Text.** Subject, From, Date, then the plain body with quoted replies and signatures stripped; the html body flattened only when no plain part exists
- **Edges.** correspondent person edges from From/To/Cc (a person entity per address); reply-to edges along In-Reply-To / References to the thread's other messages; list membership from List-Id
- **Metadata.** `message_id`, `thread_id`, `labels or folder`, `date`, `from`, `to`, `cc`, `has_attachments`, `sensitivity (the fetcher's local routing verdict, when it made one)`
- **Identity.** `<vendor>:<account>:<Message-ID>`; the Message-ID survives a label change, a move and a re-download, so a re-pull is a no-op
- **Sink shape.** a draft or a send: subject, body, recipients; the brain never edits a message that exists
- **Dividing line.** a scheduled mailbox pull or a label-triggered push is a stateful workflow → tool node; "draft this digest" or "read this one thread" on demand → the client's MCP connector
- **Instances today.** `gmail`

#### `message-stream/chat`

- **Item.** one message in a channel or a direct conversation · default cardinality `1:1` · typical transport `push`
- **Grouping key.** conversation — channel id + thread ts (Slack), channel id + message reference chain (Discord), chat id + reply_to_message_id (Telegram), the DM conversation id (X, Instagram)
- **Canonical.** the vendor's message object: ids (message, channel or chat, thread or reply-to), author, timestamp, the text with the vendor's markup intact, mentions, reactions, attachment references, an edited timestamp when the vendor keeps one
- **Text.** the message text with the vendor's markup flattened (mention tokens to display names, formatting to plain text) and the author and channel named once
- **Edges.** author person edge; mention edges to the people and channels named; reply-to edge along the grouping key
- **Metadata.** `vendor`, `workspace or server`, `channel or chat`, `thread`, `author`, `posted_at`, `edited_at`
- **Identity.** `<vendor>:<workspace>:<channel>:<message id>` — the vendor's message id is stable across an edit, which is what lets telegram-capture's UPDATE_ON_EDIT re-embed in place
- **Sink shape.** one outbound message (text, optional media) to a chat id; many thoughts → one message is the digest case (many:1)
- **Dividing line.** a bot that must sit on the vendor's event stream (a webhook receiver, a gateway session) is a stateful workflow → tool node, or a native driver where the tool lacks the vendor; a confirmation reply to the captured message is part of the source capability (an ack), not a sink; a briefing or digest sent on a cadence is the sink capability → tool node when scheduled by the tool, the client's channel plugin when the AI client sends it
- **Instances today.** `discord`, `instagram`, `slack`, `telegram`, `x`

#### `conversation-export`

- **Item.** one conversation with an AI assistant, or one captured exchange of it · default cardinality `1:1` · typical transport `batch`, `push`, `pull`
- **Grouping key.** conversation id; within it, the turn index and (ChatGPT) the branch the export resolves to
- **Canonical.** the vendor's conversation object: conversation id, title, created and updated timestamps, the ordered turns each with role, timestamp, text (markdown intact) and tool or citation blocks, the branch map when the vendor exports one
- **Text.** the turns in order as `role: text`, markdown flattened, tool and citation blocks reduced to their visible text
- **Edges.** model or assistant entity; citation edges to the URLs a turn cites
- **Metadata.** `vendor`, `conversation_id`, `title`, `created_at`, `updated_at`, `turn_count`, `model`
- **Identity.** `<vendor>:<conversation id>` for a whole conversation; `<vendor>:<conversation id>:<turn index>` for a captured exchange — the id survives a rename
- **Dividing line.** a one-shot export file is a batch → native driver (a parse has no workflow state for a tool to hold); a browser capture is a push → browser extension; an auto-sync over the vendor's API is a pull the tool owns once SMD-1863 lands. Distilling a conversation into 0–5 thoughts is an enrichment past the seam; the recipes that do it today declare `1:many` because that is what reaches the brain
- **Instances today.** `chatgpt`, `claude-ai`, `gemini`, `grok`, `perplexity`

#### `activity-export`

- **Item.** one activity record — a search, a visit, a view, a post, a comment, a location event · default cardinality `many:1` · typical transport `batch`
- **Grouping key.** the vendor's activity category plus the day (a day of one category is the unit the importers summarise)
- **Canonical.** the vendor's record: category, timestamp, title or text, the URL or target, the products and locations the vendor attached
- **Text.** for a grouped item: the day and category once, then one line per record (`time — title — target`); for a single record: the title and target
- **Edges.** target edges to the URLs, places and accounts the records name
- **Metadata.** `vendor`, `category`, `day`, `record_count`, `date range`
- **Identity.** `<vendor>:<category>:<day>` for a grouped item; `<vendor>:<category>:<record timestamp>:<hash of title+target>` for a single record — a re-import of the same archive is a no-op
- **Dividing line.** always a batch over an archive the user downloads (Takeout, an X or Instagram export) → native driver; a tool adds nothing to a file parse
- **Instances today.** `google-takeout`, `instagram`, `x`

#### `annotation/highlight`

- **Item.** one highlight or note on a source document · default cardinality `1:1` · typical transport `push`, `pull`
- **Grouping key.** the source document (book, article, podcast) — the vendor's book or document id
- **Canonical.** the vendor's highlight object: id, text, note, location (page, position, timestamp), color or tags, highlighted_at, and the source document's id, title, author and category
- **Text.** the highlight text; the user's note appended as `Note: …`; the source title and author named once
- **Edges.** source-document edge (a document entity per book or article, cached in schemas/readwise-books today); author person edge
- **Metadata.** `vendor`, `highlight_id`, `book_id`, `title`, `author`, `category`, `location`, `highlighted_at`, `tags`
- **Identity.** `<vendor>:<highlight id>`; the id is stable across a note edit and a re-export, which is why readwise-capture answers `existed` on a re-delivery
- **Dividing line.** the live webhook is a push → tool node (or the native receiver today); the history backfill is a pull the tool can page → tool node, or the native script; both map to one identity so running both makes no duplicate
- **Instances today.** `readwise`

#### `document/page`

- **Item.** one page or note · default cardinality `1:1` · typical transport `batch`, `pull`, `push`
- **Grouping key.** the page — sections are the sync unit for the writable direction (SMD-949's section ownership), the page is the capture unit
- **Canonical.** the source form byte-for-byte: the markdown file with its frontmatter (Obsidian, Markdown+git), the block JSON (Notion), the storage format (Confluence), the Atom entry (Blogger) — SMD-1867's round-trip rule: this is the stored truth for a writable page, the text and edges are projections
- **Text.** the body with presentation markup flattened — callouts, embeds, block refs, macros reduced to their visible text — and the title first
- **Edges.** link edges from `[[wikilinks]]`, relation properties, issue links, `@page` mentions — the structured layer, imported deterministically and authoritative over an LLM-inferred edge naming the same pair (SMD-1867); tag edges from `#tags`, labels, frontmatter tags; parent/child from the page tree
- **Metadata.** `vendor`, `page_id`, `path or url`, `title`, `tags`, `frontmatter or typed properties`, `created_at`, `updated_at`, `author`
- **Identity.** `<vendor>:<page id>` where the vendor has one (Notion, Confluence, Blogger); for a file vault, the frontmatter id when present, else the path with a rename detected by content fingerprint (SMD-1813's identity rule: it must survive a rename on either side)
- **Sink shape.** the page's owned sections written back in the source form; a page the brain did not create is never overwritten whole
- **Dividing line.** a vault or export import is a batch → native driver; a live two-way sync (SMD-1814–1818) is a stateful workflow → tool node with the section-ownership and conflict rules of SMD-1813 applied in the brain, not in the node. Splitting a long page by heading is an enrichment past the seam; obsidian-vault-import declares `1:many` because that is what reaches the brain
- **Instances today.** `blogger`, `obsidian`

#### `web-clip`

- **Item.** one web page or selection the user chose to keep · default cardinality `1:1` · typical transport `push`
- **Grouping key.** the URL (canonicalised: scheme and host lowercased, tracking parameters dropped, fragment kept only for a selection anchor)
- **Canonical.** the URL, the page title, the captured HTML fragment or the readable-article extraction, the selection text when one was made, the capture timestamp
- **Text.** the title, then the selection if any, else the readable article text
- **Edges.** site or publisher entity; author from the page's metadata when present
- **Metadata.** `url`, `title`, `site`, `captured_at`, `selection (boolean)`
- **Identity.** `web:<canonical url>[#<selection hash>]` — the same page clipped twice is one thought with the later canonical
- **Dividing line.** a browser extension push → browser extension; no instance in the tree today (the Chrome extension captures conversations, a different family); the slot names where a clipper lands
- **Instances today.** none

#### `calendar/event`

- **Item.** one calendar event (an instance of a recurring series counts as one) · default cardinality `1:1` · typical transport `pull`, `push`
- **Grouping key.** the recurring series id; a day of events is the unit a briefing summarises
- **Canonical.** the event resource: id and iCalUID, calendar id, summary, description, start and end with time zone, recurrence rule and the series id, attendees with response status, location, organizer, created and updated timestamps
- **Text.** summary, start–end in the user's zone, location, attendee names, then the description flattened
- **Edges.** attendee person edges; series edge to the recurring parent; location place edge
- **Metadata.** `vendor`, `calendar_id`, `event_id`, `ical_uid`, `start`, `end`, `all_day`, `status`, `recurring`
- **Identity.** `<vendor>:<calendar id>:<iCalUID>[:<instance start>]` — the iCalUID survives a title change and a move; the instance start distinguishes one occurrence of a series
- **Dividing line.** a look-ahead pull on a cadence → tool node, or the client's calendar MCP when the AI client asks on demand (life-engine today); a change notification push → tool node. Not one of the ticket's seven — added for the calendar read the tree already does
- **Note.** Added at classification time: recipes/life-engine reads Google Calendar through the client's MCP connector and none of the seven families named it. The events are read for a briefing, not stored one to one — the family exists so a calendar ingester has a declared slot.
- **Instances today.** `google-calendar`

#### `notification-target` (reserved, sink only)

- **Item.** one outbound notification to a destination that is not a capturable source — SMS, a push service, an arbitrary outbound webhook
- **Status.** Held in reserve with no instance: every digest in the tree today delivers to a family that is also a source (mail, chat) and is that family's sink capability. An artifact may use this family only once `reserved` is dropped here, which is a spec change, not a connector detail.

### Connectors (one per vendor; direction derived from the capabilities)

| Connector | Direction | Source capabilities | Sink capabilities |
|---|---|---|---|
| `blogger` | source | `recipes/journals-blogger-import` (document/page · batch · native-driver) | — |
| `chatgpt` | source | `integrations/chrome-capture-extension` (conversation-export · push · browser-extension); `integrations/chrome-capture-extension` (conversation-export · pull · browser-extension); `recipes/chatgpt-conversation-import` (conversation-export · batch · native-driver) | — |
| `claude-ai` | source | `integrations/chrome-capture-extension` (conversation-export · push · browser-extension); `integrations/chrome-capture-extension` (conversation-export · pull · browser-extension) | — |
| `discord` | bidirectional | `integrations/discord-capture` (message-stream/chat · push · native-driver) | `recipes/life-engine` (message-stream/chat · push · mcp-server) |
| `gemini` | source | `integrations/chrome-capture-extension` (conversation-export · push · browser-extension); `integrations/chrome-capture-extension` (conversation-export · pull · browser-extension) | — |
| `gmail` | bidirectional | `recipes/email-history-import` (mailbox/email · pull · native-driver); `recipes/gmail-smart-pull` (mailbox/email · pull · native-driver) | `recipes/daily-digest` (mailbox/email · push · mcp-server) |
| `google-calendar` | source | `recipes/life-engine` (calendar/event · pull · mcp-server) | — |
| `google-takeout` | source | `recipes/google-activity-import` (activity-export · batch · native-driver) | — |
| `grok` | source | `recipes/grok-export-import` (conversation-export · batch · native-driver); `recipes/x-twitter-import` (conversation-export · batch · native-driver) | — |
| `instagram` | source | `recipes/instagram-import` (message-stream/chat · batch · native-driver); `recipes/instagram-import` (activity-export · batch · native-driver) | — |
| `obsidian` | source | `recipes/obsidian-vault-import` (document/page · batch · native-driver) | — |
| `perplexity` | source | `recipes/perplexity-conversation-import` (conversation-export · batch · native-driver) | — |
| `readwise` | source | `integrations/readwise-capture` (annotation/highlight · push · native-driver); `recipes/readwise-import` (annotation/highlight · pull · native-driver) | — |
| `slack` | bidirectional | `integrations/slack-capture` (message-stream/chat · push · native-driver) | `recipes/editorial-policy` (message-stream/chat · push · native-driver) |
| `telegram` | bidirectional | `integrations/telegram-capture` (message-stream/chat · push · native-driver); `recipes/vercel-neon-telegram` (message-stream/chat · push · native-driver) | `recipes/weekly-digest` (message-stream/chat · push · native-driver); `recipes/life-engine` (message-stream/chat · push · mcp-server); `recipes/life-engine-video` (message-stream/chat · push · mcp-server) |
| `x` | source | `recipes/x-twitter-import` (activity-export · batch · native-driver); `recipes/x-twitter-import` (message-stream/chat · batch · native-driver) | — |

### Capabilities (one row per artifact capability)

| Artifact | Vendor | Family | Transport | Direction | Cardinality | Round-trip | Fetcher |
|---|---|---|---|---|---|---|---|
| `integrations/slack-capture` | `slack` | message-stream/chat | push | source | 1:1 | read-only | native-driver |
| `integrations/discord-capture` | `discord` | message-stream/chat | push | source | 1:1 | read-only | native-driver |
| `integrations/telegram-capture` | `telegram` | message-stream/chat | push | source | 1:1 | read-only | native-driver |
| `integrations/readwise-capture` | `readwise` | annotation/highlight | push | source | 1:1 | read-only | native-driver |
| `recipes/readwise-import` | `readwise` | annotation/highlight | pull | source | 1:1 | read-only | native-driver |
| `integrations/chrome-capture-extension` | `claude-ai` | conversation-export | push | source | 1:1 | read-only | browser-extension |
| `integrations/chrome-capture-extension` | `claude-ai` | conversation-export | pull | source | 1:1 | read-only | browser-extension |
| `integrations/chrome-capture-extension` | `chatgpt` | conversation-export | push | source | 1:1 | read-only | browser-extension |
| `integrations/chrome-capture-extension` | `chatgpt` | conversation-export | pull | source | 1:1 | read-only | browser-extension |
| `integrations/chrome-capture-extension` | `gemini` | conversation-export | push | source | 1:1 | read-only | browser-extension |
| `integrations/chrome-capture-extension` | `gemini` | conversation-export | pull | source | 1:1 | read-only | browser-extension |
| `recipes/chatgpt-conversation-import` | `chatgpt` | conversation-export | batch | source | 1:many | read-only | native-driver |
| `recipes/perplexity-conversation-import` | `perplexity` | conversation-export | batch | source | 1:many | read-only | native-driver |
| `recipes/grok-export-import` | `grok` | conversation-export | batch | source | 1:1 | read-only | native-driver |
| `recipes/x-twitter-import` | `x` | activity-export | batch | source | many:1 | read-only | native-driver |
| `recipes/x-twitter-import` | `x` | message-stream/chat | batch | source | many:1 | read-only | native-driver |
| `recipes/x-twitter-import` | `grok` | conversation-export | batch | source | 1:1 | read-only | native-driver |
| `recipes/email-history-import` | `gmail` | mailbox/email | pull | source | 1:1 | read-only | native-driver |
| `recipes/gmail-smart-pull` | `gmail` | mailbox/email | pull | source | 1:1 | read-only | native-driver |
| `recipes/google-activity-import` | `google-takeout` | activity-export | batch | source | many:1 | read-only | native-driver |
| `recipes/instagram-import` | `instagram` | message-stream/chat | batch | source | many:1 | read-only | native-driver |
| `recipes/instagram-import` | `instagram` | activity-export | batch | source | many:1 | read-only | native-driver |
| `recipes/journals-blogger-import` | `blogger` | document/page | batch | source | 1:1 | read-only | native-driver |
| `recipes/obsidian-vault-import` | `obsidian` | document/page | batch | source | 1:many | read-only | native-driver |
| `recipes/daily-digest` | `gmail` | mailbox/email | push | sink | many:1 | read-only | mcp-server |
| `recipes/weekly-digest` | `telegram` | message-stream/chat | push | sink | many:1 | read-only | native-driver |
| `recipes/editorial-policy` | `slack` | message-stream/chat | push | sink | many:1 | read-only | native-driver |
| `recipes/life-engine` | `telegram` | message-stream/chat | push | sink | many:1 | read-only | mcp-server |
| `recipes/life-engine` | `discord` | message-stream/chat | push | sink | many:1 | read-only | mcp-server |
| `recipes/life-engine` | `google-calendar` | calendar/event | pull | source | many:1 | read-only | mcp-server |
| `recipes/life-engine-video` | `telegram` | message-stream/chat | push | sink | many:1 | read-only | mcp-server |
| `recipes/vercel-neon-telegram` | `telegram` | message-stream/chat | push | source | 1:1 | read-only | native-driver |
<!-- connector-tables:end -->
