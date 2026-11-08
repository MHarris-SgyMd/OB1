// Generated from server-portable/rest/openapi.ts by rest-client/generate.ts — do not edit by hand (SMD-2287).

export interface paths {
    "/v1/search/compat": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Search Daemonic Brain
         * @description Search Daemonic Brain memories by meaning and by exact text — identifier-shaped tokens and "quoted" spans in the query are also matched literally. Use this read-only compatibility tool when ChatGPT needs search/fetch-style access to stored thoughts. A result naming a ticket whose status has moved since it was written carries `moved` — `{ticket, was, now}` in status types — and over MCP its title starts `[moved since written: <ticket> <then> → <now>]`, each status as its type's word (Triage, Backlog, Todo, In Progress, Done, Canceled, Duplicate; a custom "In Review" shows as In Progress), never the board's name; trust the ticket's status now over what the thought says (a ticket now Duplicate: its work is tracked under the ticket it duplicates). No `moved` makes no claim: a superseded thought, a ticket row and a note filed under a ticket are not checked, nor is any result on a brain before migration 095, nor a key past the first 50 a result mentions (beside a move, `movedNotRead` counts them). A result naming a ticket with an unreleased work claim carries `claimed` — each claim's id, ticket, piece, holder (`ownKey` when it is your key), label, times and `state` (live, or lapsed and never released: work that may be paused), the first ten, `claimedMore` the rest — and over MCP its title starts `[claimed: <ticket> by <holder>, since <time>]` (`(a piece)` after the ticket for a piece's claim, `lapsed at <time>` for a lapsed one), the first two, after any moved prefix — never the piece or label, the holder's own words — or `[claims not read]` beside a top-level `claimsNote` when they could not be read. A result's tickets are those it is filed under and the first 50 it names; beside its claims `claimedNotRead` counts the rest, and `claimed: null` on every result says the claims could not be read. No `claimed` makes no claim. It is a prompt, not the check: before starting work, still list the ticket's claims with the brain's list_claims and include_ended, and look for its branches and open PRs. While the embedding provider does not answer, the results are the query's exact matches alone — its identifiers and quoted spans, then, those matching nothing, the query as one text — and `vectorFailed` says so (over MCP the marker word beside a `note`, and each title carries `[exact match — semantic search unavailable]` after `[ingested]`, `[moved since written: …]` and `[claimed: …]` where those apply; over REST the reason, the endpoint and what happened there); with no result then, the search is refused `EMBEDDING_PROVIDER_UNAVAILABLE`, retryable.
         */
        post: operations["search"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/thoughts/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Fetch Daemonic Brain Thought
         * @description Fetch one Daemonic Brain thought by ID after using search. Use this read-only compatibility tool to retrieve the full text and metadata for citation. A thought naming a ticket with an unreleased work claim carries `claimed`, `claimedMore` and `claimedNotRead` as search's results do, only where a ticket it names is claimed, and its title starts `[claimed: …]` as theirs does, or `[claims not read]` beside a `claimsNote` when they could not be read. It is a prompt, not the check: before starting work, still list the ticket's claims with the brain's list_claims and include_ended, and look for its branches and open PRs. A thought in a work thread — the thoughts holding one subject, such as a ticket, in the order they were captured — carries `threads`: per thread its `key`, the thought's `place` (1 the first) and the thread's `total`, and `continues` (the member captured just before it, not a judged evolution) and `continuedBy` (the one just after), each its id, title and `supersededBy` when a newer thought supersedes it; null at the thread's ends. A board ticket's own row (its head row) keeps its first place while its text and status change. `threads: null` says they could not be read; a thought in no thread carries no `threads`. The brain's `thread` tool reads a whole thread.
         */
        get: operations["fetch"];
        put?: never;
        post?: never;
        /**
         * Delete Thought
         * @description Permanently remove a thought by id, along with its search chunks. `search_thoughts`, `search_thoughts_keyword`, and `list_thoughts` print the id on an `ID:` line under each hit, and `capture_thought` reports it when it saves; read the thought back first to confirm it is the one to remove. The deletion is recorded in the audit trail with the thought's previous content, so it can be reconstructed if removed in error. Refused while statements in other thoughts cite this one as their source — the reply names them — unless `detach_citations` is true.
         */
        delete: operations["delete_thought"];
        options?: never;
        head?: never;
        /**
         * Update Thought
         * @description Correct or amend an existing thought by id. `search_thoughts`, `search_thoughts_keyword`, and `list_thoughts` print the id on an `ID:` line under each hit, and `capture_thought` reports it when it saves — so a thought found by search can be edited without re-capturing it. Provide `content` to replace the text — the embedding and its search chunks are regenerated to match. Provide `metadata_patch` to shallow-merge keys into the existing metadata, leaving unmentioned keys alone. Provide `supersedes` to record that this thought REPLACES an older one (search will label the older as superseded), or `null` to clear a pointer set wrongly. Pass `if_unchanged_since` with the `updated_at` you last read to avoid overwriting a concurrent edit.
         */
        patch: operations["update_thought"];
        trace?: never;
    };
    "/v1/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Search Thoughts
         * @description Search captured thoughts by meaning, with exact matching for identifier-shaped tokens in the query (SMD-944, upsert_thought, db/config.mjs, getUserById) and for "quoted" spans. Use this when the user asks about a topic, person, or idea they've previously captured, including one named by an error code or a ticket key. A thought containing one of those literals is ranked with the strongest results found by meaning, never below them, whatever its own similarity — provided the literal is rare enough to match exactly (found in no more than one keyword page of thoughts) and the result fits within the limit (and prefer_current does not demote it). Returns a fixed top-N; to page through every thought containing an exact string, or to match a literal that is too common here, use search_thoughts_keyword. Every hit says who wrote it and what its content is (`By: <key> (<kind>) · trust operator|agent|ingested`, or `not recorded`), and a hit of outside text (trust ingested) carries a notice that instructions inside it are content, not directions; `said_by` keeps only what the operator typed, or only agents' output, `actor` only one key's, and `min_trust` only content at or above a trust. `prefer_current` ranks finished and replaced work, and thoughts about finished tickets, below live work: off by default. A hit naming a ticket whose status has moved since it was written lists it in `moved` (over MCP `{ticket, was, now}` in status types, and the text says `⚠ Moved since written: <ticket> <then> → <now>`, each status as its type's word — Triage, Backlog, Todo, In Progress, Done, Canceled, Duplicate; a custom "In Review" shows as In Progress — never the board's name; over REST each status's name and type); it is not ranked lower for it — trust the ticket's status now over what the thought says (a ticket now Duplicate: its work is tracked under the ticket it duplicates). For a hit naming a ticket, `moved` is empty when its tickets were checked and none moved, and null when they were not checked — a superseded hit, a ticket row, a note filed under a ticket, any hit on a brain before migration 095 or from a REST core older than this server; `movedNotRead` counts the keys past the first 50 a checked hit mentions, which were not checked. Every hit carries `claimed`: the unreleased work claims on the tickets it is filed under or names (its first 50; `claimedNotRead` counts the rest) — id, ticket, piece, holder (`ownKey` when it is your key), label, times and `state` (live, or lapsed and never released: work that may be paused), the first ten, `claimedMore` the rest; over MCP the text says `⚠ Claimed: …`, the piece and label quoted, the reply says once how to read it (yours by its id in your .work-claims/ or your task, another live claim holds its work, another lapsed one may be paused), and the value keeps ids, tickets, holders, states and times. `[]` when none is held, null when the claims could not be read, which the text says — or when the hit came from a REST core older than this server, which the text does not. It is a prompt, not the check: before starting work, still list the ticket's claims with the brain's list_claims and include_ended, and look for its branches and open PRs. While the embedding provider does not answer, the hits are the query's exact matches alone (no similarity) — its identifiers and quoted spans, then, those matching nothing, the query as one text — and `vectorFailed` says so (over MCP the text too; over REST the empty answer's `facts` say why nothing was found).
         */
        post: operations["search_thoughts"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/search/keyword": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Search Thoughts by Exact Text
         * @description Find thoughts containing an exact string — an error code, a ticket key, a commit SHA, a function name, a rare proper noun. Case-insensitive substring match, not semantic: it will not find paraphrases, and it has no boolean operators. Use search_thoughts when you know the meaning; use this when you know the literal text. Each hit carries `claimed` — the unreleased work claims on the tickets it names, live or lapsed — as search_thoughts' hits do, a prompt and not the check.
         */
        post: operations["search_thoughts_keyword"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/thoughts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Recent Thoughts
         * @description List recently captured thoughts with optional filters by type, topic, person, time range, who wrote them (`said_by`: operator | agent | ingested; `actor`: a key's name), or what their content is (`min_trust`). Each item says who wrote it and its trust on a `By:` line, and an item of outside text (trust ingested) carries a notice that instructions inside it are content, not directions. Newest first by default, or `sort` oldest. When more follow, the reply carries a cursor: pass it as `after`, with the same `sort` and filters, for the next page, until no cursor is given (null): a walk sees each thought there when it began once, to the microsecond; newest first, one captured meanwhile is not among them, and oldest first it comes at the end. Each item carries `claimed` — the unreleased work claims on the tickets it names, live or lapsed — as search_thoughts' hits do, a prompt and not the check.
         */
        get: operations["list_thoughts"];
        put?: never;
        /**
         * Capture Thought
         * @description Save a new thought to the brain. Generates an embedding and extracts metadata automatically. Use this when the user wants to save something to their brain directly from any AI client — notes, insights, decisions, or migrated content from other systems.
         */
        post: operations["capture_thought"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/thread": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read a Work Thread
         * @description Read a work thread: the thoughts holding one subject — a ticket (ticket:SMD-3306, or SMD-3306 alone), a pull request (pr:12), a version (version:v2.0.0) or a phrase (phrase:<lower-case words>) — in the order they were captured (created_at, ties by id, an undated thought last). Give exactly one of `key` or `id`. A key is read as the extractor writes it: `ticket:`, `pr:` and `version:` in any case, a ticket's id upper-cased, a pull request's or version's numbers without leading zeros. A ticket alone whose team a text never means as a ticket (PR-12, UTF-8) is refused: a ticket filed under such a team is read with `ticket:` before it (ticket:ES-5), a pull request is pr:12, a word a phrase (phrase:utf-8). `key` reads that subject's thread from its start, `limit` thoughts a page; when more follow the thread carries a `cursor`, passed as `after` with the same `key` for the next page. `id` reads each thread that thought stands in, around it: up to half the page before it, then it and those after it, its `place` marked (1 is the first); its `cursor` continues the thread with its `key`. A thought stands in no thread until its subject is found (the extraction worker's rules, or its --subjects sweep). The reply is `{id, threads}`: `id` the thought an id read was about (null for a key's), `threads` one per thread — one for a key (with `total` 0 when no thought holds it), one per subject for an id (none when it stands in no thread). A thread is `{key, total, place, earlier, cursor, members, linked, linkedMore}`: `earlier` when members come before the page, `cursor` null at the thread's end. Each member carries its id, title, created_at and place; `supersededBy` when a newer thought supersedes it (the thread keeps its whole history); and the ticket's own row — the board's head row for it, which is rewritten in place and so keeps its first place — its `ticket`: the ticket and its status as that row records it. A ticket's thread names the threads its ticket's board links reach (`linked`): each ticket's key, how it stands to this one (parent, child, blocks, blocked_by, relates_to) and how many thoughts its thread holds; the first 50, `linkedMore` when more. No thread runs across a link. MCP's structured value leaves out each member's title and a ticket row's status, and gives a phrase key (the judge model's words) as null: the text carries them, the key whole as a JSON string — send it decoded, without its quotes or escapes. Refused: neither or both of key and id, a key that is no subject key, or `after` without `key` (REFUSED_THREAD_INPUT); a cursor that is not this tool's (REFUSED_CURSOR); an id no thought has (NOT_FOUND).
         */
        get: operations["thread"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/thought-ids": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Thought IDs
         * @description List the brain's thought IDs — ids only, no content — in id order, for comparing one brain's corpus against another's cheaply. Returns a JSON object {total, digest, ids, cursor}: on the first page `total` is the whole corpus and `digest` is an md5 of every id (null where the store cannot compute it); page on by passing `after` = the previous page's `cursor` until `cursor` is null.
         */
        get: operations["list_thought_ids"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/logged-searches": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Logged Searches
         * @description List the brain's logged searches from query_log — the query text, which arm ran it, and its arguments — for replaying what a brain actually searched against another brain. query_log is opt-in (OB1_QUERY_LOG); this is empty when it was never on. Returns a JSON object {searches, truncated}: the most recent searches at or after `since`, up to `limit`; `truncated` is whether more matched. No thought content.
         */
        get: operations["list_logged_searches"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/proposals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Supersession Proposals
         * @description List the pairs of thoughts the consolidation pass (db/consolidate.ts) judged one to OUTDATE the other — a later state of the same thing, a decision and its reversal, a value and its update — or to DUPLICATE it, with its verdict on which is current. Nothing is applied until a reviewer accepts a proposal — review_supersession_proposal with a write key, or `cd db && bun consolidate.ts --url $DATABASE_URL --accept <proposal id>` — which sets `supersedes` on the current thought so search labels the other as superseded. Pending by default; `status` lists accepted, rejected or stale ones (stale: a text moved under a pending verdict, and the next pass re-judges the pair — migration 063), or all. A proposal standing on a LINEAGE PAIR — one side's `derived_from` names the other, a page and its evidence — is tagged: such a pair is never proposed since migration 066 and a standing one is a reviewer's to reject; `lineage: true` lists those alone (migration 070). Each proposal names the pass that judged it — its judge key, which carries the model (or the decider and the writer), the prompt version and the decide version — and `judge_key` lists one pass's alone (migration 109). Most confident first; the reply says how many follow (`remaining`) and, while more do, carries a cursor: pass it as `after`, with the same filters (one made under others is refused, naming its own), for the next page, until no cursor is given (null) (migration 110). A walk lists each row once while its status, judge key, confidence and judged_at hold; a row that joins the selection or moves in it during the walk — a new proposal, a decision, a stale mark, a re-judge (063) — is listed if its place is past the cursor and missed if behind it, and one that leaves it is not listed after. An accepted or rejected proposal names who decided it — the key, and its kind then or the registry's now (migration 114) — and each side names who wrote it (`By:` with its trust, and whether its text is a capture-only key's), an ingested side carries the ingested notice before its text, and each names the thought superseding it and the capture-only pointers an accept making it stand would clear; a proposal whose side to stand is a capture-only key's text or of a recorded trust below the other's is flagged WRITER, and that accept takes force (--force at the CLI) — on an undirected verdict, the flagged direction's (migration 094).
         */
        get: operations["list_supersession_proposals"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Thought Statistics
         * @description Get a summary of all captured thoughts: totals, types, top topics, and people.
         */
        get: operations["thought_stats"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/changes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * What Changed
         * @description List what changed in the brain — every capture, edit and deletion, oldest first, with who made it (by access-key name), the thought's ID, what moved, and whether it now supersedes another thought. Start from `since`: an ISO-8601 time with Z or an offset (2026-09-22T08:00:00Z), a date (read as UTC midnight), or the cursor a previous call ended with (its last line) to continue where you left off with no repeats; leave it out for the most recent changes. `others_only` leaves out this key's own writes — what everyone else did while you were away.
         */
        get: operations["thought_changes"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/workers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Worker Queue Status
         * @description Report the background-work pools (entity extraction, consolidation, re-embed) — one row per work_type that has any claim rows, with pending / claimed (in flight, INCLUDING stale) / succeeded / failed counts, how many thoughts are unpooled (not yet queued; for the subject pool `ob1_config.subject_pool_key` names, once its pooling has finished, the thoughts that had a current subject when it was named, which no run takes), the corpus total, how many claimed leases are STALE (a dead worker's lease past its ttl — healthy in-flight is claimed − stale), and whether the pool is the brain's active one. Read-only. Returns a JSON array; empty when nothing has been queued (a pool appears once it has a claim row).
         */
        get: operations["worker_status"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Task Status
         * @description Say each of the brain's background tasks in one word, from their heartbeat rows: the coordinator and the passes it runs (the sleep scheduler, the extraction and consolidation followers, board-sync), then any other long-running worker (a re-embed follower run by hand), then the import runner (the orchestration profile's service: running the pipelines it names, idle, with how its last run ended). Each task's `state` is one of running (a pass under way), idle (alive between passes), starting (started, not yet stamped), restarting (ended on its own, run again on the coordinator's clock), refused (held by a start refusal: deploy/.env's to mend), failed (ended on a failure), stale (no stamp in three of its intervals), stopped, or missing (the coordinator started it and it has written no heartbeat). `words` says the same in a reader's words, `coordinated` whether the coordinator runs it, and `at`/`ageS` its row's last stamp by the database's clock. brain_info and preflight read the same states. Read-only. Returns { tasks, ignored }: `ignored` counts heartbeat rows not of the shape; empty when no task has run on this brain.
         */
        get: operations["task_status"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/brain": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Brain Info
         * @description Say what this brain is: the server's version and the release it belongs to, the commit it was built from, the store and tier, the Postgres and pgvector versions, the schema version and highest migration applied (and whether that is this server's last), row counts, database size, vector-index parameters, the board-sync watermark (the newest Linear update any thought reflects), the long-running workers' heartbeats (alive, stopped or stale), and what consolidation found: the supersession proposals pending review (how many, how long ago the oldest was judged, how many pair two tickets the board does not link, how many are stale), the judged relations standing, by word, and what became of the findings posted to the board (accepted, rejected, withdrawn, open, unanswered after a month, and the acceptance rate: accepted over accepted, rejected and unanswered). Use it to check which version you are talking to, or whether the brain has reached this server's last migration (it compares the highest number applied; a skipped or edited migration is what `migrate.ts --dry-run` lists).
         */
        get: operations["brain_info"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/jobs/{job_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Async Job Status
         * @description Fetch the status and result of an async job by the `job_id` a long-running tool handed back (SMD-2273). Returns { jobId, kind, status: pending|running|succeeded|failed|lost, progress?, result?, error? }. A succeeded job carries its result; a failed one the error; `lost` means the server stopped before it finished — re-run it. Only the key that started the job can read it. Read-only.
         */
        get: operations["job_status"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/scans": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Scan Thoughts (async)
         * @description Start a background scan of the corpus and return a job HANDLE immediately (SMD-2273) — the caller does not wait for it. Walks the thoughts in pages (newest first) up to `limit`, tallying how many carry a created_at and a breakdown by metadata type, reporting progress as it goes. Returns { jobId, status: "accepted", poll, stream }: fetch the result with the job_status tool (an MCP client) or a GET of `poll` (curl), or subscribe with a GET of `stream`; both are under the endpoint the call came to (e.g. /mcp/jobs/<id> behind the proxy). The reference consumer for the async-job pattern; the result is a small summary, not the thoughts themselves.
         */
        post: operations["scan_thoughts"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/thoughts/{id}/reset-capture-stamp": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Reset Capture Stamp
         * @description Operator only: a key the operator classified `operator` (set_agent_kind). Reset the label — actor_kind, actor_name and trust — on a thought a capture-only key captured, after another key's re-capture of the same text settled it (a key whose trust was not higher was weighed first, so no later re-capture moves it) or moved it to that key. The reset puts the capture-only key's label back — undoing the move whichever key made it, yours included — and lets the next re-capture be weighed again. Re-capture the text with your key straight after, exactly as stored (fetch shows an outside text under a notice line that is not part of it): the reply says what each way does for the label it left — plainly, the label moves to your key if your key's trust is higher; with trust "ingested", a label at ingested or agent stays and the row is settled against every other key. Refused for any other key, for a thought whose label is not a capture-only key's, and, once something settled it, for one whose text was changed since. Recorded in the audit trail in your key's name; a thought with nothing to reset is left as it is.
         */
        post: operations["reset_capture_stamp"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/proposals/{id}/review": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Review Supersession Proposal
         * @description Accept or reject a proposal list_supersession_proposals listed, by its id. Accept sets `supersedes` on the side the verdict names as current (or `direction`), so search labels the other as superseded; it may also clear a capture-only key's pointer onto the side that stands, and the reply names each one. Reject records the decision and, on an accepted row, clears the pointer the accept wrote — but not a capture-only pointer the accept cleared, which stays cleared (thought_changes shows it). An accept is refused, each by name, when a text was edited since the pair was judged (a stale proposal's was), when one side's derived_from names the other (a lineage pair, which the expected decision is to reject), or when the proposal is flagged WRITER (the side to stand is a capture-only key's text, or of a lower trust than the other): read both sides first, and pass `force: true` if the accept still holds — force waives those three and nothing else. Refused too: an undirected verdict with no `direction`, an accepted proposal (reject it first to undo), a side to stand that already supersedes a third thought, a pointer that would close a loop. The proposal records your key as who decided, and each pointer written or cleared is in the audit trail under it. Requires a write key.
         */
        post: operations["review_supersession_proposal"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/workers/retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Retry Failed Work
         * @description Requeue a background-work pool's FAILED claim rows back to pending, so the next worker pass reprocesses them (the `--retry-failed` path over a tool). Read `worker_status` first for the `workType` and its `failed` count — pass that exact work_type (e.g. "extract:qwen2.5:7b@p2" or "reembed:<model>@<dim>"). Acts on this one pool only; a fresh attempt clears the recorded error and the attempt count. Requires a write key.
         */
        post: operations["retry_failed"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/workers/release-leases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Release Stale Leases
         * @description Return CLAIMED work rows whose lease has lapsed (a dead worker's, past its ttl) to the pending pool, so they can be reclaimed — the manual form of the lazy reaper. By default only STALE leases are released (worker_status reports `stale`, `staleWorkerId` and `oldestStaleClaimedAt`); a live lease is left for its holder. Pass `work_type` to scope to one pool, `worker_id` to scope to one holder. To release a lease that has NOT lapsed you must set `include_live` AND name the `worker_id` — releasing a live lease risks the holder double-processing. Requires a write key.
         */
        post: operations["release_stale_leases"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/workers/run": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Run Worker (drain a pool)
         * @description Drain a background-work pool for a `work_type` — the operator form of a `bun db/<worker>.ts` pass over MCP/REST. Currently the PREVIEW half only: call with `dry_run: true` to report, without claiming anything, what a pass would process now — the same pool `worker_status` shows (pending / claimed / stale / unpooled) plus `backlog` and, if you pass `limit`, `wouldClaim`. `backlog` = pending + stale + unpooled (a pass reaps expired stale leases back to the pool before it claims, so they drain too; a live claimed lease is skipped). It is exact for an extraction pool but an UPPER BOUND for reembed/consolidate, whose eligibility is model-aware (they count every un-pooled thought, not only the ones those pools would enqueue), and for a subject pool (`subjects:…`), whose unpooled thoughts no run takes: for the one `ob1_config.subject_pool_key` names, once its pooling has finished, those that had a current subject when it was named. The executing drain is not yet available (a call without `dry_run: true` is refused): the server does not run the bulk LLM passes, so it will land on a callable worker core. Read `worker_status` first for the exact `workType`. Requires a write key.
         */
        post: operations["run_worker"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/claims": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Work Claims
         * @description List who holds which work: the live claims on tickets (or on one piece of a ticket, such as `PR 1b-2`), each with its holder's key, its label, when it was claimed and when its lease runs out. Read this before recommending or starting work, and leave held work alone. `ticket` lists one ticket's; `holder` one key's (its name); `include_ended` adds lapsed and released claims, each with its `state`. A new session, or one whose context was compacted, finds its own claims by the token files it kept in its worktree; `holder` set to its key's name lists every session's claims under that key, its own among them. `truncated: true` means the limit cut the list: narrow by ticket or holder. Never shows a claim's token.
         */
        get: operations["list_claims"];
        put?: never;
        /**
         * Claim Work
         * @description Claim a ticket — or one piece of it, such as `PR 1b-2` — so no other agent builds the same change. Call it when you create the branch, before writing code. The reply carries a `token` (`wc_` and 64 hex digits), shown this once: keep it where only you read it (a git-ignored file in your worktree) — anyone holding it under your key acts as the holder — and pass it to renew_claim while you work and to release_claim when the work merges or is abandoned. Refused (WORK_CLAIMED) while a live claim covers the work — another key's, another session's of your key, or your own on overlapping work; the reply names each and when its lease ends. A whole ticket and any of its pieces are the same work; two different pieces are not. The lease defaults to four hours (60 seconds to a week); a lapsed claim is taken over by the next claim on exactly that work, so a lost token is recovered by claiming again after it lapses, or by an operator's forced release. Claiming again with your token renews your unreleased claim on exactly this work (and sets its label), the reply saying, as renew_claim's does, when a claim it revived had lapsed and any claim made or renewed on its work meanwhile; your token for exactly this work whose claim ended (released, or taken over after it lapsed) is refused (CLAIM_RELEASED), as renew_claim refuses it — pass no token when claiming other work; otherwise you get a new claim and a new token — keep the new one. An ingested (importer's) key cannot claim. A ticket the brain records as Done, Canceled or a Duplicate keeps no claim: board-sync releases every claim on it at its next pass, and a claim on one says so (`ticketClosed`, the status); work still to do there needs the ticket reopened, or a ticket of its own.
         */
        post: operations["claim_work"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/claims/{id}/renew": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Renew Work Claim
         * @description Set your claim's lease to lease_seconds from now (default four hours; a shorter one shortens it): the claim id and the token claim_work returned. Renew well before the lease runs out — about hourly on the default. Refused when another key holds the claim, or your key under another token; when it ended (released, or taken over after it lapsed: stop work on it; released by board-sync because its ticket closed, `ticketClosed`: done if your work merged, else the ticket closed under you, so stop and tell the user); or when it lapsed and another claim now covers its work. A claim that lapsed with nothing covering it is renewed, and the reply says when it had lapsed and names any claim made or renewed on its work meanwhile: another agent may have built part of it. The label changes through claim_work with your token.
         */
        post: operations["renew_claim"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/claims/{id}/release": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Release Work Claim
         * @description End your claim when the work merges or is abandoned: the claim id and the token claim_work returned, and a reason — the merged PR, or why it was dropped. The claim's row stays as history, with who ended it and why. An operator key (classified operator by its agent id) may release another holder's stuck claim with `force: true` and a `reason`. Refused when the claim is not yours and no force applies. Releasing a claim that already ended answers already_released, with who ended it and why: board-sync ends every claim on a ticket once it is Done, Canceled or a Duplicate.
         */
        post: operations["release_claim"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/priorities/{kind}/{key}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Priority History
         * @description Read who said an item (its kind and key, as set_priority takes them) matters, how much and when: its winning statement and level (null: nobody stated one — unknown, not low), and every statement made on it, replaced and cleared ones included, in the order written, each with its maker (key name, kind and trust as they stood), its tier, its reason, and when its window closed and why. `exists: false` is an item the brain no longer holds, whose statements are kept. Refused: an item the brain does not hold and nobody stated a priority on (ITEM_NOT_FOUND).
         */
        get: operations["priority_history"];
        put?: never;
        /**
         * Set Priority
         * @description State how much an item matters: a thought (its id), a ticket (its key, e.g. SMD-3664), an entity (its id) or an open item (its id), on one scale — 0 none, 1 low, 2 medium, 3 high, 4 urgent, 5 critical — optionally by when it is due (`due_at`), when it can start at the earliest (`not_before`, never after `due_at`), or taking another item's due time (`due_ref`), and why (`reason`). The statement is yours: your key is its maker, and its tier comes from your key, never from an argument — operator, a declared priority source, agent, or inferred (`inferred: true` lowers your own statement to it). Your new statement on an item replaces your earlier one there, which stays in the history; the same statement again writes nothing (`unchanged`). Every key's statement is kept, and the item's winner is the statement of the lowest tier, the newest within it; the reply names the winner. A capture-only key may state a priority only on a thought it captured or an open item it opened, while nobody else has taken it (or an open item its plugin's row stands for, through that plugin), and is never shown the winner. Refused: an item the brain does not hold (ITEM_NOT_FOUND), a capture-only key on anything else (ITEM_NOT_YOURS), an argument out of its rule (REFUSED_PRIORITY_INPUT).
         */
        post: operations["set_priority"];
        /**
         * Clear Priority
         * @description Withdraw your own statement of an item's priority (its kind and key, as set_priority takes them): it closes as cleared and stays in the history. Another key's statements are untouched, so the item may still have a winner, which the reply names (never to a capture-only key). With no statement of yours open on the item, nothing changes (`nothing_to_clear`).
         */
        delete: operations["clear_priority"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Items
         * @description List open items: by `status` (open, the default; proposed; done; dropped; unsettled, open and proposed; settled, done and dropped; all), `overdue: true` for those due before now and not settled (with no status given, open and proposed alike), from one `origin_thought`, or one `plugin`'s. Each carries `overdue` and `pendingProposals` (closes waiting on a decision). In due-time order, undated last, then the newest first said. `truncated: true` means the limit cut the list: narrow it.
         */
        get: operations["list_items"];
        put?: never;
        /**
         * Open Item
         * @description Record something to be done: an open item, with its text, optionally who is to do it (`owner`, free text), when it is due (`due_at`), the thought it was read from (`origin_thought`: its capture time becomes the item's `noted_at`, so an item read from an old thought reads as old), and `proposed: true` for an item inferred rather than stated, which reads as not yet open until a write key confirms it (set_item_status). The item is yours: your key is its opener. The same thought and text again (case aside) is the item already there, answered `unchanged` and nothing written; so is a plugin's row (`plugin_row`, through the plugin alone); an item from neither is opened again on each call. A capture-only key opens items, from a thought only if it captured that thought, and is shown an existing item only if it is its own. Refused: an origin thought the brain does not hold (ORIGIN_NOT_FOUND), a capture-only key's thought that is not its own (ITEM_NOT_YOURS), an argument out of its rule (REFUSED_ITEM_INPUT).
         */
        post: operations["open_item"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/items/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Item History
         * @description Read one open item: as it stands (status, text, owner, due time, where it came from, who opened it and when it was first said), every change made to it in the order written — each with its maker, the state after it and its reason — and every close proposed on it, with its evidence, proposer and decision. Refused: an id the brain does not hold (ITEM_NOT_FOUND).
         */
        get: operations["item_history"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Update Item
         * @description Change an open item's text, owner or due time — any of the three; `null` clears the owner or the due time — whatever its status. The change is an event in its history, made by your key. The same values again write nothing (`unchanged`). A capture-only key changes only an item it opened that no other key has changed since (or one its plugin's row stands for, through the plugin). Refused: an item the brain does not hold (ITEM_NOT_FOUND), a capture-only key on another's (ITEM_NOT_YOURS, answered alike whether it exists), an argument out of its rule (REFUSED_ITEM_INPUT).
         */
        patch: operations["update_item"];
        trace?: never;
    };
    "/v1/items/{id}/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Set Item Status
         * @description Settle, reopen or confirm an open item: `done` or `dropped` settles it (and moots any close still proposed on it); `open` reopens a settled item, or confirms a proposed one. Never back to proposed. The change is an event in its history, with your `reason`. The status it has already writes nothing (`unchanged`). A capture-only key may dismiss its own proposed item (dropped) but never confirm one, directly or by reopening it (CONFIRM_NOT_YOURS), and changes only an item it opened that no other key has changed since. Refused: an item the brain does not hold (ITEM_NOT_FOUND), a capture-only key on another's (ITEM_NOT_YOURS).
         */
        post: operations["set_item_status"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/items/{id}/proposals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Propose Item Close
         * @description Propose that an open item is done (or dropped), citing the thought that shows it (`evidence_thought`: the later "called the dentist, booked for Tuesday") and a `label` (resolves, implements). It never closes the item: a key other than you accepts or rejects it (decide_item_close). Your pending proposal with the same evidence is answered `unchanged` when it says the same, and withdrawn for this one when it does not. Refused: a done or dropped item (ITEM_SETTLED), an evidence thought the brain does not hold (EVIDENCE_NOT_FOUND), an item the brain does not hold (ITEM_NOT_FOUND), a capture-only key on another's item or with another key's thought (ITEM_NOT_YOURS).
         */
        post: operations["propose_item_close"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/item-proposals/{id}/decision": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Decide Item Close
         * @description Accept or reject a proposed close (its id, from item_history or the proposal's reply). Accepting closes the item to the proposal's status, with an event naming it, and moots the item's other pending proposals; rejecting leaves the item as it is. A proposal is accepted by a key other than its proposer (PROPOSAL_YOURS); its proposer may withdraw it by rejecting it. Refused: no such proposal (PROPOSAL_NOT_FOUND), one decided or moot already (PROPOSAL_DECIDED), a capture-only key on a proposal for another's item (ITEM_NOT_YOURS, answered alike for one that is not there).
         */
        post: operations["decide_item_close"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/whoami": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Who is calling
         * @description The key's name, its scope, its stable agent id and the operations it may call; forwarded, `act` names who carried it (the forwarder key's name and agent id).
         */
        get: operations["whoami"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/plugins": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The enabled plugins
         * @description Each enabled plugin: its name, title and description, its GUI pages (a path under the plugin's and a nav label) and the operations of it this key may call — what the operator GUI's nav reads.
         */
        get: operations["plugins"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/jobs/{job_id}/stream": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * A job's events
         * @description The job's progress and its end as server-sent events, for the key that started it.
         */
        get: operations["job_stream"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Liveness, and the brain's record for a key that may read it
         * @description Internal only: the process is serving, `{ status: "ok" }`. With a key that may read brain_info, which the agent registry clears within the deadline, the brain's record on the health surface instead — what the MCP server's public /health shows (SMD-2287). Any other key is answered liveness, as no key is: this route refuses no one.
         */
        get: operations["health"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        Refusal: {
            code: string;
            retryable?: boolean;
            /** @description Only on a forwarded request (a forward-scope key in x-brain-forwarder): the refusal whole, the words its facts leave out included (the caller's input, the store's) — a plugin's with its status in it — so the MCP server says it as it always has (SMD-2287). */
            refusal?: Record<string, unknown>;
        } & {
            [key: string]: unknown;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    search: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description The search query to run against Daemonic Brain thoughts */
                    query: string;
                };
            };
        };
        responses: {
            /** @description The operation's value; with `vectorFailed` — the provider's marker word, what happened there and its endpoint — when the embedding provider did not answer for the query, and the results are its exact matches alone — the query's literals, then the query as one text, or nothing it could match (`vectorFailed.matched`: literals, text or none; SMD-2891). A text match's hits carry the text as their one needle, its count bounded: 1001 means more than 1000. With nothing found then, `search` is refused EMBEDDING_PROVIDER_UNAVAILABLE (503) and `search_thoughts` answers its `facts`: a needle counted 0 is held by no thought; one counted above 0 is held only outside the search's filter, said_by, actor or min_trust (1001: more than 1000); a common needle is held by more thoughts than one keyword page; a needle may be the whole query text when that was what was matched; none at all, with `matched` none, means nothing could be matched. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    fetch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    delete_thought: {
        parameters: {
            query?: {
                detach_citations?: boolean;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    update_thought: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** @description Replacement text. Omit to leave the text, embedding and chunks untouched */
                    content?: string;
                    /** @description Keys to merge into the existing metadata. Unmentioned keys are left alone. actor_kind, actor_name and trust are the server's: the kind and name of the key that wrote the current text, and the trust a change of text declares (none above the key's kind). A patch naming them sets none of them — save a trust no higher than your key's kind (ingested for a key with no kind) sent with a change of text — while its other keys still merge, and the reply names each one the thought kept. `client_key` is set only by capture_thought: a patch naming it is refused. A `source` of `linear` is the board's own label, which only its importers write: a patch setting it is refused (REFUSED_SOURCE_RESERVED) */
                    metadata_patch?: {
                        [key: string]: unknown;
                    };
                    /** @description The updated_at from your last read. The update is refused as STALE_READ if the thought changed since */
                    if_unchanged_since?: string;
                    /** @description The id of a prior thought this one REPLACES (a corrected or updated version), as capture_thought's `supersedes`; search will label the older thought as superseded. Pass null to clear a pointer recorded wrongly. Omit to leave it as it is. */
                    supersedes?: string | null;
                };
            };
        };
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    search_thoughts: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description What to search for */
                    query: string;
                    /**
                     * @description Results to return, clamped to 1-100.
                     * @default 10
                     */
                    limit?: number;
                    /**
                     * @description Optional absolute minimum similarity, 0-1, on top of the relative cutoff (results are kept within half of the best match's similarity). 0 (default) lets the relative cutoff decide. An exact hit on an identifier or quoted span from the query is exempt.
                     * @default 0
                     */
                    threshold?: number;
                    /**
                     * @description How much a thought's age counts against its similarity, 0-1. 0 (default) ranks by meaning alone; 0.2 is a gentle preference for recent captures; 1 ranks the relevant thoughts newest first. A thought's recency halves every 90 days.
                     * @default 0
                     */
                    recency_weight?: number;
                    /** @description Optional metadata filter: an object whose top-level keys a thought's metadata must contain (jsonb containment). A value is a scalar or an array of scalars — {"type":"project"} keeps thoughts whose metadata.type is "project"; {"topics":["ob1"]} keeps those whose topics array contains "ob1". Nested objects are not accepted. Omit for an unfiltered search. */
                    filter?: {
                        [key: string]: (string | number | boolean) | (string | number | boolean)[];
                    };
                    /**
                     * @description Only thoughts whose current text was written through a key of this kind: operator (typed by the operator), agent (an agent's own output — a summary, a conclusion), or ingested (an importer copying outside text). Decided by the key that made the write, never by the thought's text. Omit for every writer.
                     * @enum {string}
                     */
                    said_by?: "operator" | "agent" | "ingested";
                    /** @description Only thoughts whose current text was written through the access key with this name — the name on a hit's `By:` line. Omit for every key. */
                    actor?: string;
                    /**
                     * @description Only thoughts whose trust is at least this: operator (typed by the operator) above agent (an agent's own output) above ingested (outside text an importer copied in). The trust is the one on a hit's `By:` line, decided by the key that wrote the text and what that write declared, never by the text; a thought with no trust recorded is below every word. Omit for every thought.
                     * @enum {string}
                     */
                    min_trust?: "operator" | "agent" | "ingested";
                    /**
                     * @description Rank settled and superseded thoughts, and thoughts about finished tickets, below current ones. Off (default): by meaning alone. On: a thought whose ticket is completed, canceled or a duplicate (a note filed under such a ticket included; a Duplicate's work is tracked under the ticket it duplicates, which ranks by its own status), that a newer thought supersedes, or with no ticket of its own whose tickets are all finished — every ticket it is about (its topics, action items, or a session summary's header) Done, Canceled or Duplicate, or with none of those three or more tickets named and all finished, and in either case no open ticket named anywhere in it — has its score multiplied by 0.25 — in practice every current match among the top candidates comes first, then the rest in their own order, each marked with why, so a demoted thought usually leaves the top results. A blocked or unknown status does not demote a thought (superseded still does). An exact identifier hit on a settled thought is demoted too: to look a finished ticket up by its key, leave this off. Each candidate's lifecycle is a lookup in a table kept current on write (migration 068): about half a millisecond over an ordinary search at 10,000 thoughts, about one at 100,000, most of it the wider window it reads; before 068 it read every thought's lifecycle per search (over 100 ms at 100,000).
                     * @default false
                     */
                    prefer_current?: boolean;
                    /**
                     * @description How much what matters counts beside meaning, 0-1. 0 (default) ranks by meaning alone. Above 0 the top min(100, 4 × limit) matches are ranked by (1 − weight) × relevance + weight × priority: relevance a match's place among them (the first 1, the last 1 over their count, so the search's own order, ties and all, is what weighs), priority its effective priority (a counted level 0 none to 5 critical, unknown counted as 2, plus urgency from a due time and what it unblocks — at most 9) over 9. A match's priority is its own: a ticket's row reads as its ticket; any other thought takes its own counted level, else one inherited from the ticket it is about (its metadata ticket or issue, else its standing subject) at one level less a hop, two hops at most, counted only above medium; a level counts when it was stated by a key the operator classified (an unclassified or importer's key's statement is inferred, and not counted yet). A finished ticket's own row keeps its stated level — only its urgency and what it unblocks drop — and passes nothing down to a note under it: to rank finished work lower, add prefer_current. A ticket a match's text only mentions does not count. It reorders those matches and can surface none past them. A search with it set is not logged in the query log.
                     * @default 0
                     */
                    priority_weight?: number;
                    /** @description Keep only matches whose priority is known — a counted level of its own (on a ticket's row, its ticket's; a finished ticket's row keeps its level), or one it inherits from the ticket it is about, as priority_weight reads them — and whose effective priority (the level plus urgency and what it unblocks, as priority_weight reads it) is at least this: 0 none, 1 low, 2 medium, 3 high, 4 urgent, 5 critical. A match with no stated or inherited level never passes. Read over the top min(100, 4 × limit) matches, as priority_weight is. A search with it set is not logged in the query log. */
                    min_priority?: number;
                };
            };
        };
        responses: {
            /** @description The operation's value; with `vectorFailed` — the provider's marker word, what happened there and its endpoint — when the embedding provider did not answer for the query, and the results are its exact matches alone — the query's literals, then the query as one text, or nothing it could match (`vectorFailed.matched`: literals, text or none; SMD-2891). A text match's hits carry the text as their one needle, its count bounded: 1001 means more than 1000. With nothing found then, `search` is refused EMBEDDING_PROVIDER_UNAVAILABLE (503) and `search_thoughts` answers its `facts`: a needle counted 0 is held by no thought; one counted above 0 is held only outside the search's filter, said_by, actor or min_trust (1001: more than 1000); a common needle is held by more thoughts than one keyword page; a needle may be the whole query text when that was what was matched; none at all, with `matched` none, means nothing could be matched. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    search_thoughts_keyword: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description The literal text to find. Matched as a substring; % and _ are literal, not wildcards. */
                    query: string;
                    /**
                     * @description Results per page, 1-100.
                     * @default 10
                     */
                    limit?: number;
                    /**
                     * @description Skip this many results, for paging.
                     * @default 0
                     */
                    offset?: number;
                    /** @description Optional metadata filter: an object whose top-level keys a thought's metadata must contain (jsonb containment). A value is a scalar or an array of scalars — {"type":"project"} keeps thoughts whose metadata.type is "project"; {"topics":["ob1"]} keeps those whose topics array contains "ob1". Nested objects are not accepted. Omit for an unfiltered search. */
                    filter?: {
                        [key: string]: (string | number | boolean) | (string | number | boolean)[];
                    };
                    /**
                     * @description Only thoughts whose current text was written through a key of this kind: operator (typed by the operator), agent (an agent's own output — a summary, a conclusion), or ingested (an importer copying outside text). Decided by the key that made the write, never by the thought's text. Omit for every writer.
                     * @enum {string}
                     */
                    said_by?: "operator" | "agent" | "ingested";
                    /** @description Only thoughts whose current text was written through the access key with this name — the name on a hit's `By:` line. Omit for every key. */
                    actor?: string;
                    /**
                     * @description Only thoughts whose trust is at least this: operator (typed by the operator) above agent (an agent's own output) above ingested (outside text an importer copied in). The trust is the one on a hit's `By:` line, decided by the key that wrote the text and what that write declared, never by the text; a thought with no trust recorded is below every word. Omit for every thought.
                     * @enum {string}
                     */
                    min_trust?: "operator" | "agent" | "ingested";
                };
            };
        };
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    list_thoughts: {
        parameters: {
            query?: {
                limit?: number;
                type?: string;
                topic?: string;
                person?: string;
                days?: number;
                said_by?: "operator" | "agent" | "ingested";
                actor?: string;
                min_trust?: "operator" | "agent" | "ingested";
                sort?: "newest" | "oldest";
                after?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page (SMD-2995): `thoughts`, each with `supersededBy` (the id of a thought that supersedes it, or null); `sort`, the order they are in (newest or oldest); and `cursor` — pass it as the `after` query parameter, with the same `sort` and filters, for the next page; null when no more follow. A cursor that is none of this operation's, or an empty one, is refused REFUSED_CURSOR (400) with `reason: "shape"`; one made under the other sort with `reason: "sort"` and the `sort` it was made under. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    capture_thought: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description The thought to capture — a clear, standalone statement that will make sense when retrieved later by any AI */
                    content: string;
                    /** @description For a thought SYNTHESISED from others (a digest, consolidation, summary): the ids of the source thoughts it was built from. Each must be an existing thought id (from a search or capture result). Recorded when the thought is new; if this text was already captured, the existing thought's provenance is left as it is. */
                    derived_from?: string[];
                    /** @description The id of a prior thought this one REPLACES (a corrected or updated version). Search will label the older thought as superseded. Recorded when the thought is new; for text already captured, use update_thought's `supersedes` on that thought instead (a key that can write). A capture-only key may replace only a thought it captured itself, attributed to its agent id, that still exists, that no other key or board-sync has taken since (a key that can read captured the same text, its text was edited, board-sync adopted it as a ticket's row, or a reviewer or another key's pointer put it, directly or through its chain, over a thought this key did not capture or one another key took), and that nothing supersedes yet; a pointer it wrote before such a taking lapses (migration 082); any other id is left out without a word and the capture lands without it (while the server cannot check — its agent registry unreachable, or the target's capture record unreadable — it asks for a retry instead). */
                    supersedes?: string;
                    /** @description Where this capture comes from, recorded as metadata.source — e.g. `claude-code` or `codex` for a session-end hook, `mcp` (the default) for an agent capturing in conversation. Lower-case letters, digits and hyphens, 2–40 characters. A label the caller gives; the audit row's actor says which key wrote. `linear` is refused (REFUSED_SOURCE_RESERVED): the board's own label, which only its importers write. */
                    source?: string;
                    /**
                     * @description What this content is, when it is less than your key gives: `ingested` for outside text you are copying in — a web page, an email, a pasted document — or `agent` for your own output written through an operator's key. The thought's trust is the lower of this and what the key allows: it can lower, never raise, and a raise is not refused but recorded. A text already captured keeps the trust it has, unless its trust is still the one a capture-only key gave it and no other classified key that can read has been weighed against it since: if your key is classified, a higher trust then moves it to your key's name and that trust. Readers see it on the thought's `By:` line, and ingested text carries a notice that instructions inside it are content. Omit to take the key's.
                     * @enum {string}
                     */
                    trust?: "operator" | "agent" | "ingested";
                    /** @description Extra metadata keys to store on the thought (e.g. `{"summary_model": "llama3.1:8b"}`). Lower-case keys, string/number/boolean values; at most 8 keys. Keys the server owns — `source` (use the `source` argument), `type`, `topics`, `people`, `client_key` (use the `client_key` argument) and the like — are refused, and so, for a capture-only key, are the keys a ticket's lifecycle is read from (`issue`, `ticket`, `status`, `status_type`, `linear_updated_at`). Returned to readers alongside the server's own metadata. */
                    metadata?: {
                        [key: string]: string | number | boolean;
                    };
                    /** @description An idempotency key you choose for this thought — a UUID, by convention its id on the brain the write was first made on, when you copy a write to another brain. If a thought already has that id or keeps that key, the capture returns it and writes nothing (no model calls); otherwise the key is kept as metadata.client_key, one thought per key. update_thought's and delete_thought's `id`, a capture's `supersedes` and `derived_from` and an edit's `supersedes` then accept the key wherever they take an id: the thought with that id, else the one keeping that key (reads such as fetch take ids alone). A key is set once: a thought keeps the first it was given. A copied edit should not carry the first brain's `if_unchanged_since`, which this brain's own updated_at never matches. A key that can read only: a capture-only key is refused it. */
                    client_key?: string;
                };
            };
        };
        responses: {
            /** @description The thought, with `embeddingAttached` — whether this capture wrote its vector with the row (false when the egress gate refused the embedding call, or the provider did not answer it — `vectorFailed`, a reader's with the endpoint and what happened there, and its word alone for a key that cannot read); on a re-capture, false says this capture wrote none, not that the row has none; on a re-capture over a capture-only key's label, `label` says what it did — `outcome` moved, kept, settled or unweighed, `stamp` the label after (`actorKind`, `actorName`, `trust`), and `before`, `weighed` and `own`, `by` and `mine`, or `decliner` and `declinerWeighed` by outcome (migration 090); with a `client_key` (SMD-3314, migration 112), `keyed` says what became of it — `matched` (a thought already had it as its id or its key: that thought, nothing written, no model call, still 201), `recaptured` (that thought holds this very text: a re-capture of it, the key not sent again), `recorded` (the row keeps it) or `held` (the text's row keeps another key, `heldKey` when it is a key's shape, and this one names nothing); a key that cannot read is told its id, `embeddingCall`, `chunks`, `contextFailures`, `vectorFailed` and `embeddingAttached` alone — carried by a forwarder, the whole value, which the MCP server words for that key. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    thread: {
        parameters: {
            query?: {
                key?: string;
                id?: string;
                after?: string;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    list_thought_ids: {
        parameters: {
            query?: {
                limit?: number;
                after?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    list_logged_searches: {
        parameters: {
            query?: {
                since?: string;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    list_supersession_proposals: {
        parameters: {
            query?: {
                status?: "pending" | "accepted" | "rejected" | "stale" | "all";
                limit?: number;
                lineage?: boolean;
                judge_key?: string;
                after?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page (SMD-3249): `proposals`, most confident first; `cursor` — pass it as the `after` query parameter, with the same status, lineage and judge_key, for the next page; null when no more follow; `remaining`, how many follow this page; `pastCursor`, whether this page followed a cursor; each accepted or rejected proposal's `reviewer` (who decided it: the key's name, whether an agent was recorded, its kind then and the registry's now; null when none is recorded, and on a pending or stale one); and `reviewersRead`, false when a decided row was listed on a brain short of migration 114, which records none (SMD-3338). A cursor that is none of this operation's, an empty one, or one whose time Postgres cannot read is refused REFUSED_CURSOR (400) with `reason: "shape"`; one made under other filters with `reason: "filters"` and `made`, the `status`, `lineage` and `judgeKey` it was made under. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    thought_stats: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    thought_changes: {
        parameters: {
            query?: {
                since?: string;
                others_only?: boolean;
                agent?: string;
                actions?: ("capture" | "update" | "delete")[];
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    worker_status: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    task_status: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    brain_info: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    job_status: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    scan_thoughts: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** @description How many thoughts to scan at most (newest first). Default 1000, max 100000. */
                    limit?: number;
                };
            };
        };
        responses: {
            /** @description The operation's value. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    reset_capture_stamp: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": Record<string, unknown>;
            };
        };
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    review_supersession_proposal: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description accept: write the pointer the verdict proposes; reject: decline it (and clear the pointer an earlier accept of it wrote)
                     * @enum {string}
                     */
                    decision: "accept" | "reject";
                    /**
                     * @description Accept only: which side stands as current — required when the verdict did not say (an undirected one), else it overrides the verdict's
                     * @enum {string}
                     */
                    direction?: "newer" | "older";
                    /** @description Recorded with the decision, up to 2000 characters */
                    note?: string;
                    /** @description Accept only: accept although a text was edited since judged, the pair is a lineage pair, or the proposal is flagged WRITER — after reading both sides. Waives nothing else */
                    force?: boolean;
                };
            };
        };
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    retry_failed: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description The exact work_type whose failed rows to requeue — a `workType` from worker_status (e.g. "extract:qwen2.5:7b@p2"). Acts on this pool alone. */
                    work_type: string;
                };
            };
        };
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    release_stale_leases: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** @description Restrict to one pool's leases (a `workType` from worker_status). Omit to reap stale leases across every pool. */
                    work_type?: string;
                    /** @description Restrict to one holder's leases (a `staleWorkerId` from worker_status). Required when include_live is true. */
                    worker_id?: string;
                    /** @description Release a holder's leases even if the ttl has NOT lapsed. Off by default (only stale leases are touched). Requires worker_id — releasing a live lease risks double-processing. */
                    include_live?: boolean;
                };
            };
        };
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    run_worker: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description The exact work_type to preview — a `workType` from worker_status (e.g. "extract:qwen2.5:7b@p2" or "reembed:<model>@<dim>"). */
                    work_type: string;
                    /** @description Must be true — report what a pass would claim without claiming it. The executing drain is not yet available; any other value is refused. */
                    dry_run?: boolean;
                    /** @description Bound the previewed backlog — `wouldClaim` is the drainable backlog capped at this. Omit to preview the whole backlog. */
                    limit?: number;
                };
            };
        };
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A mode not built: RUN_WORKER_DRAIN_NOT_AVAILABLE. */
            501: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    list_claims: {
        parameters: {
            query?: {
                ticket?: string;
                holder?: string;
                include_ended?: boolean;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    claim_work: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description The ticket key, e.g. SMD-3379 (a team key of letters and digits, a hyphen, a number; case and surrounding white space don't matter) */
                    ticket: string;
                    /** @description The piece of the ticket, e.g. `PR 1b-2`, at most 100 characters; omit to claim the whole ticket. Compared case-folded, its white space collapsed */
                    piece?: string;
                    /** @description Free text for people, at most 500 characters: your tool, machine, session and branch, so another session of your key can tell this claim from its own. Shown to others as data */
                    label?: string;
                    /** @description How long the claim holds without a renewal, in seconds: 60 to 604800 (a week). Default 14400 (four hours) */
                    lease_seconds?: number;
                    /** @description Your token for this exact work, to renew your claim rather than make a new one; omit for a new claim */
                    token?: string;
                };
            };
        };
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    renew_claim: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description The token claim_work returned for this claim */
                    token: string;
                    /** @description The new lease, in seconds from now: 60 to 604800. Default 14400 (four hours) */
                    lease_seconds?: number;
                };
            };
        };
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    release_claim: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** @description The token claim_work returned for this claim; not needed for an operator's forced release */
                    token?: string;
                    /** @description Why the claim ends, at most 500 characters: the merged PR, or why it was dropped (required with force) */
                    reason?: string;
                    /** @description Operator only: release another holder's claim. Needs a reason */
                    force?: boolean;
                };
            };
        };
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    priority_history: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                kind: string;
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    set_priority: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                kind: string;
                key: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description 0 none, 1 low, 2 medium, 3 high, 4 urgent, 5 critical */
                    level: number;
                    /** @description When the item is due: a time with its offset (2027-03-01T17:00:00Z), or a date (2027-03-01, by the end of that day: the next day's start in UTC) */
                    due_at?: string;
                    /** @description When the item can start at the earliest, in due_at's forms (a date from the start of that day in UTC); never after due_at */
                    not_before?: string;
                    /** @description Another item whose due time this one takes, where this statement has no due_at of its own — never the item itself */
                    due_ref?: {
                        /** @enum {string} */
                        kind: "thought" | "ticket" | "entity" | "item";
                        key: string;
                    };
                    /** @description Why it matters, at most 1000 characters: free text, shown to every key that reads the item's priority */
                    reason?: string;
                    /** @description True when this is your inference, not a statement you were given: lowers your statement to the inferred tier */
                    inferred?: boolean;
                };
            };
        };
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    clear_priority: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                kind: string;
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    list_items: {
        parameters: {
            query?: {
                status?: "open" | "proposed" | "done" | "dropped" | "unsettled" | "settled" | "all";
                overdue?: boolean;
                origin_thought?: string;
                plugin?: string;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    open_item: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description What is to be done, at most 1000 characters */
                    text: string;
                    /** @description Who is to do it, at most 200 characters: free text, not a key */
                    owner?: string;
                    /** @description When it is due: a time with its offset (2027-03-01T17:00:00Z), or a date (2027-03-01, by the end of that day: the next day's start in UTC) */
                    due_at?: string;
                    /** @description The id of the thought the item was read from */
                    origin_thought?: string;
                    /** @description Through a plugin's ctx.call alone: the plugin's row the item stands for. Refused from any other caller */
                    plugin_row?: string;
                    /** @description True for an item inferred, not stated (the extractor's): it reads as not yet open until a write key confirms it */
                    proposed?: boolean;
                };
            };
        };
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    item_history: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    update_item: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** @description Its new text, at most 1000 characters */
                    text?: string;
                    /** @description Its new owner, or null to clear it */
                    owner?: string | null;
                    /** @description Its new due time (open_item's forms), or null to clear it */
                    due_at?: (string) | null;
                };
            };
        };
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    set_item_status: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description open (confirm or reopen), done, or dropped
                     * @enum {string}
                     */
                    status: "open" | "done" | "dropped";
                    /** @description Why, at most 1000 characters: shown in the item's history */
                    reason?: string;
                };
            };
        };
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    propose_item_close: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /**
                     * @description What the item would close to. Default done
                     * @default done
                     * @enum {string}
                     */
                    status?: "done" | "dropped";
                    /** @description The id of the thought that shows it */
                    evidence_thought?: string;
                    /** @description One lower-case word naming how the evidence settles it: resolves, implements */
                    label?: string;
                    /** @description Why, at most 1000 characters */
                    reason?: string;
                };
            };
        };
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    decide_item_close: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description True to accept (close the item), false to reject */
                    accept: boolean;
                    /** @description Why, at most 1000 characters */
                    reason?: string;
                };
            };
        };
        responses: {
            /** @description The operation's value. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: REFUSED_FILTER, REFUSED_SINCE, REFUSED_CURSOR, REFUSED_THREAD_INPUT, REFUSED_SUPERSEDES_SHAPE, REFUSED_DERIVED_FROM_SHAPE, REFUSED_METADATA_SHAPE, REFUSED_CLIENT_KEY_SHAPE, REFUSED_SOURCE_RESERVED, REFUSED_NOTHING_TO_UPDATE, REFUSED_CLAIM_INPUT, REFUSED_PRIORITY_INPUT, REFUSED_ITEM_INPUT, REFUSED_REVIEW_ARGUMENT, REFUSED_DIRECTION_REQUIRED, REFUSED_EMPTY_WORK_TYPE, REFUSED_LIVE_LEASE_NEEDS_WORKER. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Nothing there: NOT_FOUND, CLAIM_NOT_FOUND, ITEM_NOT_FOUND, ORIGIN_NOT_FOUND, EVIDENCE_NOT_FOUND, PROPOSAL_NOT_FOUND. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The state conflicts: REFUSED_STALE_READ, REFUSED_DUPLICATE_CONTENT, REFUSED_WOULD_CYCLE, REFUSED_CITED, REFUSED_NOT_CAPTURE_STAMP, WORK_CLAIMED, CLAIM_RELEASED, ITEM_SETTLED, PROPOSAL_DECIDED, REFUSED_EDITED_SINCE, REFUSED_LINEAGE_PAIR, REFUSED_WRITER, REFUSED_ALREADY_ACCEPTED, REFUSED_ALREADY_SUPERSEDES, REFUSED_PROPOSAL_WOULD_CYCLE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A reference to nothing, or a refusal the store named: REFUSED_SUPERSEDES_UNKNOWN, DERIVED_FROM_MISSING, REFUSED, REFUSED_SUPERSEDED_GONE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    whoami: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The caller. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A bearer token whose scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    plugins: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The enabled plugins. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        plugins: {
                            name: string;
                            title: string;
                            description: string;
                            pages: {
                                path: string;
                                label: string;
                            }[];
                            operations: string[];
                        }[];
                    };
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A bearer token whose scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    job_stream: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description An event stream. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": unknown;
                };
            };
            /** @description No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: "forwarder"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: "token"` (and `WWW-Authenticate: Bearer error="invalid_token"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: "token"`, a token whose subject the agent registry revoked, which no new sign-in clears. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with `credential: "token"`, `WWW-Authenticate: Bearer error="insufficient_scope"`); or a rule: REFUSED_EGRESS, REFUSED_CLIENT_KEY_SCOPE, REFUSED_NOT_OPERATOR, CLAIM_NOT_YOURS, REFUSED_CLAIM_KEY, ITEM_NOT_YOURS, READ_ONLY_KEY, ITEM_UNOWNABLE, PROPOSAL_YOURS, CONFIRM_NOT_YOURS. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description No such job for this key. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description A fault (FAILED, with its message; no retryable until SMD-2461). */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
            /** @description Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as `name` to a forwarder; with `credential: "forwarder"` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with `credential: "token"`, Retry-After 30), or EMBEDDING_PROVIDER_UNAVAILABLE, SUPERSEDES_UNJUDGED, CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED, ITEM_UNATTRIBUTED — CLAIM_UNATTRIBUTED, PRIORITY_UNATTRIBUTED and ITEM_UNATTRIBUTED with Retry-After for `registry_away` alone; their other causes wait on an operator and carry none. */
            503: {
                headers: {
                    /** @description Seconds to wait before retrying. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
    health: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Serving: `{ status: "ok" }`, or the brain's record. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            /** @description A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does. */
            405: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Refusal"];
                };
            };
        };
    };
}
