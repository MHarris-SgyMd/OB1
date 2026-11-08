# Changelog

## 0.2.0 — 2026-11-08

The provider calls the brain's agent-memory plugin (`plugins/agent-memory`), which replaces the standalone Agent Memory API server after the brain's 2.0.0 (SMD-2690). On a brain still running that server, keep 0.1.0.

### Changed

- `endpoint` is the plugin's REST base, `https://<host>/api/v1/plugins/agent-memory`; the key is still sent as `x-brain-key`.
- Routes: usage is `POST /recalls/{request_id}/usage`, a recall trace `GET /recalls/{request_id}`, the review queue `GET /review-queue`, and listing `GET /memories`, the reads' input in the query string. The review queue and listing were `POST /memories/review` and `POST /memories/list`, which no server answered.
- A refusal raises `OB1RequestError`, whose message, `code` and `status` name the plugin's refusal code (`HTTP 400 REFUSED_INPUT`); a retryable 503 carries its `Retry-After`. A 2xx that is not a JSON object (an endpoint pointing at some other page), an empty one among them, raises one too.
- A write-back of more than ten memories is sent in parts of ten, each under `writeback_timeout` (new: 60 s by default, at least 8, at most 255, the brain's idle timeout; reads keep `api_timeout`). The plugin takes at most 50 in one request, a long session's end extracts up to 60 findings, and each memory is a capture with its model calls, so a part of 50 outlasted the 8 s timeout. A key given is each part's own (`<key>:part<n>`); without one each part has its own step (`<step>:part<n>`), so the same text at the same index of two parts is two memories, as in one write-back. A key the plugin's 200 characters would not hold is sent as its sha256 (a part's as `<sha256>:part<n>`, so a key of 194 characters or more once split). A part refused or timed out raises, the parts before it kept and the ones after it not sent; sent again, the write-back answers the kept parts and sends the rest, though a refusal that holds (an unsafe memory) refuses it again.
- A session end writes back in the background, as a turn's write-back does, so it never holds up a turn: Hermes ends sessions mid-process too, inside a turn on a compression and on `/new`, where 0.1.0's single request held the turn up to 8 s. Its write-back gets at most one `writeback_timeout`, fresh each time, and later write-backs go on as before. Shutdown shares the last session end's deadline while it is still ahead, as at exit, else takes one of its own: it waits for every background write-back still running, not only the latest, and the client starts no write-back part after it (a part already in flight keeps the wait it started with). What the deadline left out is logged at warning: the parts never started as not written back, a part whose wait it cut as unconfirmed, since the plugin finishes a write-back its caller stops waiting for. A session end's write-back that fails otherwise, a refusal among them, is logged at warning too.
- `ob1_review_memory` sends the reviewer as `actor_label`, the field the plugin takes (it refuses a field it does not know), and an `edit` takes `content` and `summary`; one with neither is refused before it is sent.
- Recall context reads a memory's time from `freshness` (when a person last confirmed it, else when it was written), as the plugin answers it.

### Removed

- The `GET /health` probe at initialization: the plugin has no such route.

## 0.1.0 — 2026-05-09

Initial release of the Hermes OB1 memory provider.

### Added

- Native Hermes `MemoryProvider` implementation against the OB1 v1 contract.
- Auto-recall before each turn via `prefetch()`.
- Background recall caching via `queue_prefetch()` / consumed by next `prefetch()` (90s TTL).
- Auto-writeback after each turn via `sync_turn()` — payload structured as OB1 `outputs[]`.
- Synchronous structured-finding writeback at session end via `on_session_end()`.
- Background writeback + summary string injection at compression via `on_pre_compress()`.
- Heuristic finding extractor that maps conversation lines into OB1 categories: decisions, lessons, constraints, next_steps, unresolved_questions, failures.
- Seven explicit tools: `ob1_recall`, `ob1_writeback`, `ob1_search`, `ob1_report_usage`, `ob1_list_review_queue`, `ob1_review_memory`, `ob1_get_recall_trace`.
- Setup-wizard support via `get_config_schema` / `save_config`.
- `x-brain-key` header authentication (matches OB1 v1 contract — not Bearer).
- Per-turn model + provider tracking, with fallback to Hermes `config.yaml` when `on_turn_start` kwargs are absent.
- Subagent / cron / flush context guard — disables writes for non-primary contexts to prevent corrupting the parent's memory record.
- 75 pytest tests covering pure helpers, schema shapes, lifecycle, prefetch caching, sync_turn, session-end, pre-compress, and tool routing.
