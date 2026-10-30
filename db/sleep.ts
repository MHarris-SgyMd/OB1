#!/usr/bin/env bun
/**
 * sleep.ts — run the background passes while the brain is quiet, and stop
 * them within --poll seconds of the first live call being recorded: the sleep
 * scheduler, "dolphin sleep" (SMD-1794).
 *
 *   bun db/sleep.ts --url postgres://… --follow     # sleep whenever the brain is quiet, for ever
 *   bun db/sleep.ts --url …                         # wait for quiet, sleep once — until its pools drain, a call wakes it or its budget stops it — then exit
 *   bun db/sleep.ts --url … --dry-run               # the idle reading and each pass's pool; writes nothing
 *   await run({ url, follow: true, signal })         # in-process: import { run } from "./sleep.ts" (SMD-2304's engine shape)
 *   --quiet SECONDS (300)   --poll SECONDS (5; at most 60)   --workers N (1, for each pass)
 *   --budget MINUTES (60; 0 none)   --statement-timeout SECONDS (300; 0: the role's or database's own)   --work-mem MB (4)   --maintenance-work-mem MB (64)
 *   --dump-dir DIR (none)   each consolidation pass appends every verdict to DIR/<its pass key>.jsonl, consolidate.ts's --dump (SMD-3203)
 *   exits 0 done, or --follow stopped by one signal · 1 one sleep woken before its pools drained, or whose re-embed was set down or aside, or stopped on its budget, a pass that ended by itself with 0, or an uncaught error · 2 usage, configuration (a pass's start checked before the first quiet included), followers running outside sleep, or a pass's refusal (under --follow, all but a model, provider or lookup refusal at the start of a pass that got through its start earlier, which is retried — "Refusals" below) · 75 a migration seen — migrate.ts's lock taken or the ledger moved since the start — which its supervisor runs again at once (SMD-3379 PR 1c-1) · 130 a signal before one sleep ended, or a second signal (at once)
 *
 * ── Quiet ───────────────────────────────────────────────────────────────────
 * The brain is awake while it is written: a write the audit recorded
 * (thought_audit, 008) through a key whose kind is not `ingested`
 * (set_agent_kind, 046). It falls asleep after --quiet seconds with none, and
 * wakes on the first. Every comparison is on the database's clock, now().
 *  - A search neither wakes it nor holds it awake (SMD-3315): a running pass
 *    costs a search 24–33 ms (SMD-3024's paired medians), so the passes go on
 *    through one. It reads no query_log; before 2.0.0 a logged search woke it,
 *    for a role granted the retired `sleep` group.
 *  - "Background" is the key's kind, not the work: board-sync's key is
 *    classified `ingested` on the stable brain, so its sync writes do not
 *    wake it; an unclassified key's do — reembed.ts's, ingest-records.ts's, a
 *    migration's backfill — until set_agent_kind(<name>, 'ingested') says
 *    they are background. The servers' vector mender marks its own writes
 *    background in the audit row (actor_context.background, SMD-2889), and
 *    they do not wake it either.
 *  - The passes it runs write no thought_audit row (extraction writes the
 *    entity tables; consolidation writes proposals and, since 084, relation
 *    facets with their lineage) and call no server, so its own work never
 *    wakes it.
 * The default is from the stable brain's logs over 14 days (2026-09-23 to
 * 10-07), replayed at each quiet — the scheduler did not run there, and
 * stable logs reads: 3,379 live events, the median gap 0.3 s; at 300 s it
 * would have slept 222 times, 93% of the time, a median sleep of 16.6 min
 * (p10 2.4); at 60 s, 98% and 12.6 min; at 900 s, 84% and 25.5 min. Counting
 * board-sync's writes as live halves the median sleep at 300 s (6.5 min).
 * Those counted reads as live; on writes alone a sleep begins no later and
 * lasts no shorter, so the figures are its floor.
 *
 * ── Asleep ──────────────────────────────────────────────────────────────────
 * First the re-derive pass (SMD-1794's order, SMD-2679): rebuild_derived's
 * orphans-only sweep over the lineage rows whose artifact is gone — windows,
 * mentions, a vector or tags a raw delete or a replay took — through
 * rebuild.ts's sweepOrphans, at most 500 thoughts a sleep, no model, on a
 * connection of its own under the budget's session (Budget). It reads 10,001
 * lineage rows in id order a sleep, each sleep the next window once the one
 * before is swept whole, so a larger table is walked, said once — the place
 * kept in the process, so a restart begins again at the first.
 * A wake, a stop or the clock spent stops it between thoughts, its call in
 * hand given 2 s before it is cancelled on the server (pg_cancel_backend),
 * rolled back, the supersession lock let go; a call waiting on a lock gives
 * up after 2 s (lock_timeout), so no wait behind a row holds the lock past
 * it, and is passed over, its thought named. A wake ends the sleep, and a
 * clock spent by the sweep starts no pass. A thought whose call fails is
 * passed over, said in the summary, and tried again when the sweep comes
 * round; a failure of the sweep itself is said once and the passes go on; a replay's refusal
 * stops it, said once; a brain without 063, or a role without EXECUTE on the
 * function, is told once at the start and sweeps nothing — and the function
 * is SECURITY INVOKER over four groups' tables, so a role short of one of
 * those grants meets 42501 at the first call instead, said with the grant,
 * and the sweeps end for the process. Then the passes, in a fixed
 * order. Re-embed first (SMD-2679 PR 4b), alone, so the vectors consolidation
 * judges neighbours by are current: only when its backlog has work — rows
 * pending or in flight under the configured model's own key, thoughts not at
 * the model, finished rows whose thought has moved (reembed.ts's
 * reembedBacklog; another process's live lease, which its follower would not
 * claim, is not counted) — so an empty one starts no pass, and nothing probes
 * the embedding endpoint: its start is no check of the scheduler's (Refusals).
 * It runs until its pool drains, then stops after the thought in hand, and
 * extraction starts. Anything else that ends it sets it down for that sleep —
 * refused at its start (a key, credit, the model not served, the egress
 * policy) or mid-pass (the provider refusing the request itself), a statement
 * past its timeout, its provider not answering (the embedding endpoint can be
 * down while chat serves) — said, on the row (`aside`, its kind; the row's
 * outcome failed for a cause the operator mends, not for an outage; a thrown
 * error's reason in the log), extraction and consolidation running on; the
 * next sleep with work tries it again.
 * Before this, sleep needed no embedding endpoint, and a refused one would
 * have stopped the passes that do not use it. Its writes are marked
 * background, as the vector mender's are, so a vectorless row it gives a
 * vector wakes nothing. A model switch it will not make — the brain recording
 * an embedding model other than this stack's, at a sleep's start or under it
 * — sets it aside, said and on the row (briefly at each later sleep), the
 * others running on: they do not read the record. It is read again at each
 * sleep's start and each poll while aside: put right at a sleep's start,
 * re-embed runs in that sleep; at a poll, the set-aside clears and the next
 * sleep with work re-embeds. A brain with vectors from before migration 021,
 * which carry no model, re-embeds them in its first sleeps — one call a row,
 * across sleeps the clock ends — and the first sleep's start line and
 * --dry-run count them (reembed.ts --dry-run before upgrading). The
 * extraction follower runs alone until its pool is drained — nothing
 * pending, in flight or not yet in the pool — because consolidation judges a thought against neighbours that must be
 * extracted first (consolidate.ts's header; deploy/README.md's "Extraction
 * alone on a backlog", a rule there until now). The consolidation follower
 * then joins it, beside it as the coordinator's workers pass runs the two (SMD-2424):
 * safe for what arrives from then on, as a candidate was captured on an
 * earlier UTC date. It joins as well once extraction holds nothing but
 * thoughts that SLEEP_STALLED_JOIN (3) or more long hard stops in a row took
 * with no window saved between, and none saved since (migration 093's
 * `stalled` and `gained`, SMD-2694; long: the thought held a minute,
 * provider pauses aside, so short sleeps count none): a single window longer than
 * every long sleep — or a stop
 * that keeps landing past the last window, in the decider's call or the
 * write — which would otherwise hold consolidation back for as long as the
 * brain keeps waking. The cost is consolidate.ts's for an unextracted
 * neighbour: a newer thought judged meanwhile misses its pair with such a
 * thought, which is reached from its newer side only and not revisited.
 * Once taken, the decision holds for the rest of the sleep. Stalled thoughts
 * go last: every thought a stop has taken moves behind new captures as each
 * sleep begins — dated 30 days ahead, so a capture made during the sleep,
 * which a sync write's is, as it wakes nothing, goes ahead of them too
 * (SMD-3008; claims are taken by that date, which reads no clock). One that
 * lands while extraction has a stalled thought in hand, before consolidation
 * joins, would wait out the window, and the join with it: two polls reading
 * extraction with only stalled thoughts in hand and newer work pending
 * restart it, the stalled thought(s) moved behind that work, at most once a
 * minute. Once consolidation has joined, a stalled thought in hand keeps its
 * turn, and such a capture goes first at the next sleep; nor is a thought
 * still gaining windows, or a stall or two short of the join, stopped for one. When consolidation joins past,
 * extraction is set aside — stopped, if in hand with a stalled thought —
 * until consolidation's pool drains, then resumes, so on a one-slot model the
 * judge is not left waiting behind the window. While consolidation waits for
 * its provider — at its start, or mid-pass (consolidate.ts's providerWait):
 * past its workers' pauses for a 5xx, a minute and more, at once for a model
 * gone missing or a call no probe answers — its pool cannot drain, and
 * extraction is let out for the newer work meanwhile, with one worker, at
 * most once a minute, then set aside again once it holds a stalled thought —
 * its own claims, by worker id, since this run began — or holds nothing and
 * nothing newer is left; the stalled thought(s) wait for consolidation
 * (SMD-3008): the judge model failing while the extraction model serves, as
 * both are on the one chat endpoint. A judge model missing at the start is
 * refused, as before. Each of these stops of the scheduler's own — the join's
 * set-aside (SMD-2694), the restart, the let-out's — and its hard stop of the
 * passes when one ends by itself, a follower is found outside or the sleep
 * throws, is counted on the thought in hand as a cut, apart from its stops,
 * which say the wakes and the operator's second signal (migration 101's
 * `cuts`, SMD-3060): a cut stalls nothing, and a long outage's cuts no
 * longer read as wakes nor decide which held thoughts are named; read on
 * the row once the scheduler is restarted after 101. A stalled thought is
 * tried in every sleep once consolidation's pool drains, and finished by
 * the first sleep long enough for both — one its clock allows (Budget). A brain before 093, or a role that cannot read it,
 * joins once extraction is drained alone, and the start says so; granted
 * later, the scheduler takes it up once restarted.
 * A failed row stays failed — the operator's --retry-failed.
 * Followers, not one-shot runs: a follower waits out a database restart or a
 * provider outage mid-sleep (SMD-2599), where a one-shot run fails the
 * thought in hand. Without --follow, a sleep that drains its pools — re-embed
 * set down or aside leaves its pool, exit 1 — stops the
 * followers and exits 0; one whose claim pass's provider is down at its
 * start waits (re-embed's is set down instead).
 *
 * ── Waking ──────────────────────────────────────────────────────────────────
 * Every --poll seconds while asleep the logs are read for a live event since
 * the sleep began — and up to 30 s before it, within the quiet just read: an
 * audit row is dated at its transaction's start, so a capture begun before
 * the sleep and committed after it is dated before it (one blocked longer is
 * missed). On one, the passes are hard-stopped (the pass's signal, then its
 * PassStop): every lease returned, the model call in hand aborted —
 * extract's since this ticket's first cut, consolidate's since SMD-2304 — and
 * the claims they held moved to the back of the queue, since a release keeps
 * a claim's place: a thought longer than the sleeps would otherwise be every
 * sleep's first, and the pool behind it would never move. That thought's
 * windows answered so far are kept (extract-entities.ts over migration 093,
 * SMD-2694), so it advances by the windows each sleep finishes and is done
 * once its last is; one whose single window outlasts every sleep is joined
 * past (Asleep), and the row names both (Heartbeat). Waking costs up to
 * --poll seconds of a pass beside the live call, and the calls in flight
 * thrown away. The first live call is not spared: it is recorded after the
 * model work it does, so on a one-slot model it can queue behind the call in
 * hand. Awake, it reads again when the brain could first fall asleep —
 * --quiet seconds after the newest live event — at most a minute apart.
 *
 * ── Budget ──────────────────────────────────────────────────────────────────
 * Each sleep runs under a budget (SMD-2679, SMD-1794's step 2), stated here
 * until SMD-1499 derives it from the brain's size:
 *  - each pass's own client opens its connections with statement_timeout (--statement-timeout,
 *    300 s), work_mem (--work-mem, 4 MB) and maintenance_work_mem
 *    (--maintenance-work-mem, 64 MB) — the memory settings Postgres's own
 *    defaults, which a server sized up for its awake index would otherwise
 *    hand the background passes too; no pass builds an index or vacuums yet,
 *    so the last bounds SMD-2918's heal ahead of it. A startup setting beats
 *    the role's and the database's own, so a timeout of 0 is left out and
 *    theirs stands. The start's check runs under them. The scheduler's own
 *    two connections take the memory settings and statement_timeout 0,
 *    beating a role's or database's own: its poll reads the pools — a scan of
 *    every thought — and a timeout there would end the scheduler, not a pass;
 *    the clock is read between those reads, so a sleep can run one read past
 *    it. A statement past its timeout — a
 *    start-of-pass scan the brain has outgrown, most likely — is cancelled
 *    (57014, in Postgres's English words "statement timeout"; under another
 *    lc_messages it reads as any error, and ends the scheduler as before):
 *    the pass ends, the others stop hard, a
 *    cut, and the sleep stops on its budget, where it ended the scheduler
 *    with 1 before. An operator's pg_cancel_backend is 57014 too, "user
 *    request": no budget's, it ends the scheduler as a pass that throws
 *    does. One in a thought's own write fails that thought, as any database
 *    error there does (its --retry-failed); one on a claim costs its worker
 *    the poll;
 *  - a sleep runs --budget minutes (60) at most: then its passes stop after
 *    the thought in hand, every lease returned, and none starts; one still in
 *    hand 300 s later is stopped hard, a cut (101). A wake in that grace ends
 *    it at once, as any wake does. The stop is counted only when it cut work
 *    — a pass's pool not drained as the drain reads it (consolidation's not
 *    yet enqueued included, re-embed's only while it runs — not set down
 *    or aside — and only the leases this sleep can work; another process's
 *    claims under the claim passes' keys count too), or a pass waiting for
 *    its provider — as the clock was spent; an idle clock-out ends the sleep
 *    as quietly as a drained one, the next still after a live call, and one
 *    sleep's exits 0 — 1 if its re-embed was set down or aside.
 * The settings go out as startup parameters, which a transaction pooler —
 * PgBouncer, a managed host's pooled endpoint — refuses: the scheduler
 * connects to Postgres directly, as the compose stack's does. The worker
 * key's lookup opens its one connection without them.
 * A sleep stopped on its budget ends, and the next begins only after a live
 * call and the quiet — not after a rest: the budget bounds a night's work,
 * and the passes resume from the claim tables. Under --follow the row says
 * which stopped it, when one cut work (`slept.budget`: clock or statement), and the bound it
 * stopped at (`slept.limit`: minutes, or seconds), that it waits for a live
 * call (`resting`), and carries the budget in force with the sleeps stopped
 * on it since the process began (`budget`); one sleep stopped on it exits 1.
 * A restarted scheduler carries the last sleep's word and bound, and sleeps
 * after the quiet alone: the wait is this process's. The clock begins with
 * the sleep, the re-derive sweep inside it, and counts every
 * minute of the sleep, idle ones too: a sleep whose pools drained long ago
 * still ends at it, and a capture a sync write makes after that waits for the
 * next sleep.
 *
 * ── Refusals ────────────────────────────────────────────────────────────────
 * Before its first quiet the scheduler runs each pass's start once (the
 * engines' `check`, SMD-2752): the banner, the egress gate, the tables, the
 * model's probe, the worker key and extraction's recorded key. A refusal
 * there ends it with 2 at once — a bad worker key, a model not served, the
 * judge's included, which a sleep would meet only once extraction's backlog
 * drained. A provider that does not answer is no refusal: each pass waits for
 * it at its own start. The passes each sleep starts leave their banner to it,
 * and their end-of-run summary out (the counts and graph, scans the
 * scheduler would wait for at a wake).
 * Every sleep starts its passes afresh, so each meets its start's refusals
 * again. Each says which it is (worker-bootstrap.ts's StartRefusal), and one
 * rule reads that and whether the pass got through its start in this process
 * (the check, or onPass):
 *  - one no retry mends — the worker key revoked (the environment is read
 *    once, and the registry does not unrevoke), the extraction key another
 *    process's --switch-key moved, the tables, the egress policy — ends the
 *    scheduler with 2;
 *  - the model not served, the provider refusing the call, or the key's lookup
 *    not naming it under an actor-only egress policy, at the start of
 *    a pass that got through its start earlier, is retried under --follow on
 *    SMD-2599's outage schedule, heartbeat:sleep failed and re-stamped
 *    through the wait, until a pass of a later sleep stamps: a model
 *    re-pulled, a 402 cleared by topping up credit, a gateway's passing
 *    401/403/404;
 *  - the same at a pass's first start, or a refusal mid-pass (the provider
 *    refusing the request itself, a key refused on a real call), is the
 *    configuration's, as it is for a follower: it ends the scheduler with 2.
 *    So the same 402 or 401 ends it when it lands mid-pass, and is retried
 *    when a sleep's start meets it first;
 *  - any other code a pass ends with ends the scheduler;
 *  - but re-embed is none of these: its start is not checked, and whatever
 *    ends it — a refusal of any kind, at its start or mid-pass, a statement
 *    timeout — sets it down for the sleep, or aside on a model switch (the
 *    follower exits 2 then; the scheduler reads the record itself), and ends
 *    neither the sleep nor the scheduler (Asleep).
 *
 * ── Heartbeat ───────────────────────────────────────────────────────────────
 * `heartbeat:sleep` in ob1_config (db/pass-stamp.ts, SMD-2261): running while
 * asleep, re-stamped at least every minute awake or asleep, `failed` while a
 * pass's last word was (a provider still failing mid-pass, a refusal) — kept
 * into the next sleep until one of its passes stamps — ended when the
 * scheduler stops, a second signal included; `slept` carries the current or
 * last sleep's start and, once it is over, its end, on the database's clock
 * (SMD-2678); `waiting` names the passes waiting at their start for a
 * provider that does not answer, while one is, and `waitingMidPass` those
 * waiting mid-pass for one that stopped answering (SMD-2905); `refused` the start
 * refusal that ended it, so preflight's `sleep` row says each — not "its
 * passes running", nor "start it again", which would only refuse again
 * (SMD-2752); `aside`, re-embed set aside on a model switch, with the model
 * the brain records and this stack's, or down for the sleep, with what set it
 * down (SMD-2679 PR 4b); `held`, the thoughts
 * extraction holds back across the wakes —
 * how many, and the three most stalled with their stops, windows kept and
 * the scheduler's own cuts (101; read as none before it),
 * read at the first stamp awake or poll asleep, after each wake, at least
 * every minute and before the row ends — so the row names a thought the
 * sleeps cannot finish (SMD-2694). The passes stamp through it, not their
 * own rows, so a wake does not end a follower's row for preflight to warn
 * about, and preflight's
 * consolidate pass row reads it as the scheduler at work. Only --follow
 * stamps: one sleep leaves no row to go stale, as a one-shot pass does not.
 * Followers run outside sleep (the coordinator's workers, never beside it
 * there, or a hand run) do not yield, so the two are alternatives: a run
 * refuses (2) while any of their heartbeats
 * is fresh — at its start, and at every awake and asleep poll, since a
 * follower brought up beside it stamps only past its own start probe — and
 * --dry-run names them, each with how to stop them and retire their rows
 * (SMD-2678). Under --follow a refusal, at the start too, ends the row on a
 * failure, its last sleep kept, so preflight names the followers keeping it
 * down. Preflight's `sleep` row reads this heartbeat, with its `slept` mark
 * and its `reads` word on the query log, and the coordinator runs
 * `--follow` when OB1_PASSES names sleep (db/coordinator.ts, SMD-3476). The start's reads, like the sleep's,
 * wait out a database not answering yet, and so does each pass's start at
 * every sleep, up to its first claim (SMD-2752).
 *
 * ── Not here ────────────────────────────────────────────────────────────────
 * The frozen-belief scan, decay relabelling and an HNSW heal are their own
 * tickets' passes (SMD-1722, SMD-1736, SMD-1632), as is the awake
 * latency under a sleep at 1M and 10M rows (SMD-1500's harness).
 */

import type { SQL } from "bun";
import { accessSync, constants, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { resolveEmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { extractionKey, windowingFor } from "../server-portable/entities.ts";
import { consolidatePassKey } from "../server-portable/consolidate-decide.ts";
import { budgetWords, heldWords, NAME_CHARS, REEMBED_DOWN, reembedKeyUnfit, shellWord, SLEEP_HELD_NAMED, SLEEP_STALLED_JOIN, STALE_AFTER_INTERVALS, type BudgetStop, type ReembedDown, type SleepAside, type SleepHeld } from "../server-portable/brain-info.ts";
import { run as runExtract } from "./extract-entities.ts";
import { run as runConsolidate } from "./consolidate.ts";
import { reembedBacklog, run as runReembed } from "./reembed.ts";
import { orphanCensus, sweepOrphans, type SweepResult } from "./rebuild.ts";
import { databaseUnavailable, outageWait, PERMANENT_REFUSALS, throughOutage, type StartRefusal, type StartResult } from "./worker-bootstrap.ts";
import { MAX_WORKERS, sleepUnless, stopOnSignals, STOPPED_EARLY, type PassStop } from "./lease.ts";
import { MIN_STAMP_EVERY_S, passStamper, type MalformedBlock, type PassOutcome, type PassStamper, type SleepMark } from "./pass-stamp.ts";
import { embeddingContract, MIGRATE_LOCK, MIGRATE_LOCK_HOLDER_SQL, MIGRATION_EXIT, reembedKey, startRefusalRemedy } from "./config.mjs";
import { commandLine, consoleWriter, flagList, numberProblem, type Writer } from "./cli.ts";
import { closeThenExit, databaseUrl, databaseUrlProblem, NO_DATABASE_URL, openSql, type SessionSettings } from "./connect.ts";

const FLAGS = { url: "one", quiet: "one", poll: "one", workers: "one", budget: "one", "statement-timeout": "one", "work-mem": "one", "maintenance-work-mem": "one", "dump-dir": "one", follow: "none", "dry-run": "none" } as const;
const HINTS = { url: "<postgres://…>", quiet: "<SECONDS>", poll: "<SECONDS>", workers: "<N>", budget: "<MINUTES>", "statement-timeout": "<SECONDS>", "work-mem": "<MB>", "maintenance-work-mem": "<MB>", "dump-dir": "<DIR>" };

/** The quiet before a sleep, from the stable brain's logs replayed (the header): 93% of the time asleep, a median sleep of 16.6 min. */
const DEFAULT_QUIET_S = 300;
/** How often the logs are read while asleep: the most a pass runs beside a live call. */
const DEFAULT_POLL_S = 5;
/** The followers' own poll for new work, their bare --follow's. */
const PASS_FOLLOW_S = 15;
/** How far ahead the stopped thoughts are dated as a sleep begins (stoppedLast): past any sleep, so every capture made during one is taken first (SMD-3008). */
const FORWARD_DAYS = 30;
/** The least time between two restarts of extraction for work that lands behind a stalled thought in hand (asleep(), SMD-3008). */
const RESTART_EVERY_MS = 60_000;
/** How far before a sleep began its wake reads, for a write committed after it in a transaction begun before (asleep()). */
const WAKE_SLACK_S = 30;
/** The longest --poll: the awake wait is at most a minute, the heartbeat's floor, and a poll past it would break that. */
const MAX_POLL_S = 60;
/** The longest a sleep runs, its clock (the header's Budget): then the passes stop after the thought in hand, and the next sleep waits for a wake. 0 is none. */
const DEFAULT_BUDGET_MIN = 60;
/** A pass's statement_timeout: a statement past it is cancelled (57014), and the sleep stops on its budget. 0 is none. */
const DEFAULT_STATEMENT_TIMEOUT_S = 300;
/** A pass's work_mem: Postgres's own default, which a server SMD-1499 sizes up would otherwise hand the background passes too. */
const DEFAULT_WORK_MEM_MB = 4;
/** A pass's maintenance_work_mem: Postgres's own default; no pass builds an index or vacuums yet, so it bounds SMD-2918's heal ahead of it. */
const DEFAULT_MAINTENANCE_WORK_MEM_MB = 64;
/** How long the passes have, once the clock is spent, to finish the thought in hand before they are stopped hard, a cut. */
const BUDGET_GRACE_S = 300;
/** The largest --budget, a week; --statement-timeout's, a day; the memory settings' in MB, Postgres's own bound (2^31 - 1 kB). */
const MAX_BUDGET_MIN = 10_080;
const MAX_STATEMENT_TIMEOUT_S = 86_400;
const MAX_MEM_MB = 2_097_151;
/** A pass's own line about the stop the scheduler made it take, not the operator's signal: left out of the scheduler's output. */
const PASS_STOP_LINE = /^\s*(stopping after the current thought|second signal — exiting now|stopped before the pass began)/;

/** The three passes, in their order: re-embed first, so the vectors consolidation judges neighbours by are current (SMD-2679 PR 4b). */
const PASSES = ["reembed", "extract", "consolidate"] as const;
type PassName = (typeof PASSES)[number];

/**
 * One sleep scheduler's run — the CLI's flags, typed. `url` is required: each
 * pass opens its own pool from it (a follower's needs a connection per worker
 * and a spare), and the worker key resolves on one of its own. `sql`, when
 * given, is the caller's client for the scheduler's own reads and heartbeat
 * — two connections are enough — and never closed here; it keeps its own
 * settings, so open it with schedulerSession() for the memory settings and no
 * timeout, as the CLI and a URL alone do (SMD-2679). `signal` stops it as
 * the CLI's first signal does: the passes after the thought in hand. `onPass`
 * is handed the scheduler's stop as it begins (db/lease.ts's PassStop): the
 * first call is that stop; a second hard-stops the passes and returns the
 * release of their leases. `env` is what the passes read (process.env when
 * absent).
 */
export interface SleepOptions {
  url?: string;
  sql?: SQL;
  env?: Record<string, string | undefined>;
  quiet?: number;
  poll?: number;
  workers?: number;
  follow?: boolean;
  dryRun?: boolean;
  writer?: Writer;
  signal?: AbortSignal;
  onPass?: (stop: PassStop) => void;
  /** The heartbeat's floor, MIN_STAMP_EVERY_S unless a test drives it faster. */
  minStampEveryS?: number;
  /** Extraction's stall floor (extract-entities.ts STALL_FLOOR_MS) unless a test drives it faster. */
  stallFloorMs?: number;
  /** The least time between two restarts or let-outs of extraction (RESTART_EVERY_MS) unless a test drives it faster. */
  restartEveryMs?: number;
  /** The passes' own poll for new work, in seconds (PASS_FOLLOW_S) unless a test drives it faster (SMD-3048). */
  passFollowS?: number;
  /** The sleep's clock in minutes (DEFAULT_BUDGET_MIN), 0 for none: --budget (SMD-2679). */
  budget?: number;
  /** Each pass's statement_timeout in seconds (DEFAULT_STATEMENT_TIMEOUT_S), 0 for none: --statement-timeout. */
  statementTimeout?: number;
  /** Each pass's work_mem in MB (DEFAULT_WORK_MEM_MB): --work-mem. */
  workMem?: number;
  /** Each pass's maintenance_work_mem in MB (DEFAULT_MAINTENANCE_WORK_MEM_MB): --maintenance-work-mem. */
  maintenanceWorkMem?: number;
  /**
   * --dump-dir: a directory each consolidation pass appends every verdict to, one JSONL file per pass key
   * (passDumpFile), as consolidate.ts's --dump writes them. A decide-mode pass can then be read pair by pair, its
   * link step's answer included: a pair it caps may store nothing at all (SMD-3203).
   */
  dumpDir?: string;
  /** The clock in ms in place of `budget`'s minutes, when a test drives it faster. */
  budgetMs?: number;
  /** The grace after the clock in ms (BUDGET_GRACE_S), when a test drives it faster. */
  budgetGraceMs?: number;
  /**
   * The quiet and the poll in ms, in place of `quiet` and `poll`'s whole seconds, when a test drives the scheduler
   * faster than --quiet and --poll's floor of a second (SMD-3196).
   */
  quietMs?: number;
  pollMs?: number;
}

/** The scheduler's numbers, its flags' or their defaults. */
type Numbers = { quiet: number; poll: number; workers: number; budget: number; statementTimeout: number; workMem: number; maintenanceWorkMem: number };

/**
 * The memory settings, alone: what the scheduler's own two connections open
 * with too — its poll reads the pools, a scan of every thought — but no
 * statement_timeout, which there would end the scheduler (review pass 1).
 */
export function budgetMemory(n: Pick<Numbers, "workMem" | "maintenanceWorkMem">): SessionSettings {
  return { work_mem: `${n.workMem}MB`, maintenance_work_mem: `${n.maintenanceWorkMem}MB` };
}

/**
 * The scheduler's own two connections: the memory settings, and
 * statement_timeout 0 — a startup setting beats the role's and the database's
 * own, which there would end the scheduler on its poll's scan (review pass 2).
 */
export function schedulerSession(n: Pick<Numbers, "workMem" | "maintenanceWorkMem">): SessionSettings {
  return { statement_timeout: "0", ...budgetMemory(n) };
}

/**
 * Each pass's session settings, from the budget's numbers: what every
 * connection of its own client opens with (connect.ts's `session`, SMD-2679).
 * A startup setting beats the role's and the database's own, so a timeout of
 * 0 is left out: theirs then stands (review pass 1).
 */
export function budgetSession(n: Pick<Numbers, "statementTimeout" | "workMem" | "maintenanceWorkMem">): SessionSettings {
  return { ...(n.statementTimeout ? { statement_timeout: `${n.statementTimeout}s` } : {}), ...budgetMemory(n) };
}

/**
 * A statement statement_timeout cancelled: 57014 in Postgres's words for it.
 * An operator's pg_cancel_backend is 57014 too, "due to user request": no
 * budget's, so it ends the scheduler as any error a pass throws does (review pass 1).
 */
export const statementTimedOut = (e: unknown): boolean => (e as { errno?: unknown } | null)?.errno === "57014" && /statement timeout/i.test((e as Error).message ?? "");

/**
 * A pass's pool: its claim rows by status, and the thoughts a pass would add
 * to it; for extraction, `stalled` — of its pending and in-flight rows, those
 * SLEEP_STALLED_JOIN or more long hard stops in a row have taken with no
 * window saved between, and none since (migration 093, SMD-2694), 0 where the
 * scheduler cannot read them — and `stalledPending`, those of them pending
 * (SMD-3008); `stalledRead`, whether that read ran. `mine` counts the rows in
 * flight under this process's extraction worker ids (MINE) claimed since this
 * run began, and `stalledMine` those of them stalled: another's claim, or a
 * lease a scheduler gone left — on another host, or this container before a
 * restart — is no thought this one holds. `unlabelled`, re-embed's alone
 * (reembedBacklog's): of the unpooled, the vectors that carry no model.
 */
type Pool = { pending: number; claimed: number; failed: number; unpooled: number; stalled: number; stalledPending: number; stalledRead: boolean; mine: number; stalledMine: number; unlabelled?: number };
/** Nothing for the pass to do: no row pending or in flight, and nothing to add. A failed row is the operator's. */
const drained = (p: Pool): boolean => p.pending + p.claimed + p.unpooled === 0;
/**
 * Extraction holds only thoughts whose single window outlasts every sleep,
 * or whose stops land past their last window:
 * nothing to add, and every row pending or in flight stalled. Consolidation
 * joins past them (SMD-2694), as it would never join behind them.
 */
const joinsPast = (p: Pool): boolean => p.unpooled === 0 && p.pending + p.claimed > 0 && p.pending + p.claimed === p.stalled;
/** Extraction's worker ids in this process (extract-entities.ts's `workerId`, heldHere's prefix). */
const MINE = `extract-${hostname()}-${process.pid}-`;
/** Re-embed's worker ids in this process (reembed.ts's `workerId`, heldHere's). */
const REEMBED_MINE = `reembed-${hostname()}-${process.pid}-`;
/** Consolidation's worker ids in this process (heldHere's). */
const CONSOLIDATE_MINE = `consolidate-${hostname()}-${process.pid}-`;
/** The work extraction has that no stall holds back: rows pending that are not stalled, and thoughts not yet in the pool (none in a claims-only read). */
const newerWork = (p: Pool): number => p.pending - p.stalledPending + p.unpooled;
/**
 * Extraction has only stalled thoughts in hand while newer work waits behind
 * them — a row pending that is not stalled, or a thought not yet in the pool:
 * a capture made during the sleep, which a sync write's is, as nothing wakes
 * the brain for it (SMD-3008). The pool is not all stalled, so consolidation
 * would not join past it either, and both waited out the window in hand.
 * In hand is this process's: a lapsed lease another left is not (review pass 2).
 */
const queuesBehind = (p: Pool): boolean => p.mine > 0 && p.stalledMine === p.mine && newerWork(p) > 0;

/**
 * 093's rows that speak for the thought as it stands and the windowing in
 * force: its fingerprint now (an edit makes a row of other text, which the
 * next claim replaces) and the worker's windowing, as extract-entities.ts
 * reads them before reusing a window.
 */
const currentProgress = (sql: SQL, sig: string) => sql`e.windowing = ${sig} AND e.fingerprint = COALESCE(t.content_fingerprint, content_fingerprint_of(t.content))`;

/**
 * A pass's pool, read as its own --status reads it: extraction's universe is
 * every thought (enqueue_thoughts adds those with no row under the key);
 * consolidation's is migration 029's consolidation_pool.
 */
async function poolOf(sql: SQL, pass: PassName, job: string, stalledUnder?: string, unread?: (e: Error) => void, claimsOnly = false, mineSince?: Date): Promise<Pool> {
  // Re-embed's is its own backlog read (reembed.ts): the rows pending or in
  // flight, and what a first pool would add — the thoughts not at the model,
  // and the finished rows whose thought has moved (SMD-2679 PR 4b).
  // In a sleep (`mineSince`), only the leases this process can work count:
  // another's live lease is not its follower's to claim (review pass 1).
  if (pass === "reembed") {
    const b = await reembedBacklog(sql, job, mineSince === undefined ? undefined : { prefix: REEMBED_MINE, since: mineSince });
    return { ...b, stalled: 0, stalledPending: 0, stalledRead: false, mine: 0, stalledMine: 0 };
  }
  // A claim made before this run began is not its own, though it carries this
  // process's worker id: a container restarted in place keeps its hostname and
  // pid, and its last run's lease lives on for its TTL (post-merge review).
  const since = mineSince === undefined ? sql`'-infinity'::timestamptz` : sql`${mineSince}::timestamptz`;
  // One statement, so one snapshot: read apart, a claim made between the two
  // reads counted neither claimed nor unpooled, and a pool just being claimed
  // read drained — extraction resumed 14 ms after consolidation joined, before
  // it had judged (review pass 5).
  // `claimsOnly` skips the thoughts not yet in the pool, a scan of every
  // thought for extraction: read every poll while consolidation waits on its
  // provider, where the capture trigger keeps it near nought (SMD-3008).
  const unpooled = claimsOnly
    ? sql`SELECT 0`
    : pass === "extract"
    ? sql`SELECT count(*)::int FROM thoughts t WHERE NOT EXISTS (SELECT 1 FROM thought_work_claims c WHERE c.thought_id = t.id AND c.work_type = ${job})`
    : sql`SELECT count(*)::int FROM consolidation_pool(${job})`;
  const [by] = (await sql`
    SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*) FILTER (WHERE status = 'claimed')::int AS claimed,
           count(*) FILTER (WHERE status = 'failed')::int AS failed, (${unpooled}) AS n,
           count(*) FILTER (WHERE status = 'claimed' AND starts_with(worker_id, ${MINE}) AND claimed_at >= ${since})::int AS mine
      FROM thought_work_claims WHERE work_type = ${job}`) as { pending: number; claimed: number; failed: number; n: number; mine: number }[];
  // Read only where the start found 093's table readable (stalledUnder, the
  // windowing). One gone or refused since reads none stalled, said by the
  // caller, so the scheduler joins once extraction drains rather than ends
  // (review pass 2: the read ran inside reading(), which rethrows it).
  let s = 0, sp = 0, sm = 0, read = false;
  if (pass === "extract" && stalledUnder !== undefined) {
    try {
      [{ s, sp, sm }] = (await sql`
        SELECT count(*)::int AS s, count(*) FILTER (WHERE c.status = 'pending')::int AS sp,
               count(*) FILTER (WHERE c.status = 'claimed' AND starts_with(c.worker_id, ${MINE}) AND c.claimed_at >= ${since})::int AS sm
          FROM thought_work_claims c
          JOIN extraction_progress e USING (thought_id, work_type) JOIN thoughts t ON t.id = c.thought_id
         WHERE c.work_type = ${job} AND c.status IN ('pending', 'claimed') AND e.stalled >= ${SLEEP_STALLED_JOIN} AND e.gained = 0 AND ${currentProgress(sql, stalledUnder)}`) as { s: number; sp: number; sm: number }[];
      read = true;
    } catch (e) {
      const code = (e as { errno?: string; code?: string }).errno ?? (e as { code?: string }).code;
      if (code !== "42P01" && code !== "42501") throw e;
      unread?.(e as Error);
    }
  }
  return { pending: Number(by.pending), claimed: Number(by.claimed), failed: Number(by.failed), unpooled: Number(by.n), stalled: Number(s), stalledPending: Number(sp), stalledRead: read, mine: Number(by.mine), stalledMine: Number(sm) };
}

/**
 * The thoughts extraction holds back across the wakes: pending or in flight,
 * a hard stop counted on them (093), of the text and windowing in force —
 * how many, and the SLEEP_HELD_NAMED most stalled, then most stopped: by the
 * wakes, the scheduler's own cuts counted apart (101, SMD-3060) and only said —
 * none where `cuts` is not there to read (a brain before 101).
 */
async function heldBack(sql: SQL, job: string, sig: string, cuts: boolean): Promise<SleepHeld> {
  const rows = (await sql`
    SELECT e.thought_id::text AS id, e.stops, CASE WHEN e.gained > 0 THEN 0 ELSE e.stalled END AS stalled, (SELECT count(*)::int FROM jsonb_object_keys(e.parts)) AS kept, e.windows,
           ${cuts ? sql`e.cuts` : sql`0`} AS cuts, count(*) OVER ()::int AS total
      FROM extraction_progress e JOIN thought_work_claims c USING (thought_id, work_type) JOIN thoughts t ON t.id = c.thought_id
     WHERE e.work_type = ${job} AND c.status IN ('pending', 'claimed') AND e.stops > 0 AND ${currentProgress(sql, sig)}
     ORDER BY 3 DESC, e.stops DESC, e.thought_id LIMIT ${SLEEP_HELD_NAMED}`) as { id: string; stops: number; stalled: number; kept: number; windows: number | null; cuts: number; total: number }[];
  return { total: rows[0]?.total ?? 0, thoughts: rows.map(({ total: _t, ...r }) => ({ ...r, windows: r.windows ?? null })) };
}

/**
 * A migration in progress — migrate.ts's ob1:migrate lock (SMD-3379 PR 1a),
 * its holder named — and the ledger's newest name: what the scheduler waits
 * out at its start and watches each poll (PR 1c-1).
 */
async function migrationState(sql: SQL): Promise<{ holder: string | null; newest: string | null }> {
  // The ledger first: a migration that commits between the two reads is then seen by the lock's, or
  // next time by the ledger's, never baselined as applied before it began (review pass 1).
  const [l] = (await sql`SELECT max(name) AS newest FROM public.schema_migrations`) as { newest: string | null }[];
  const [h] = (await sql.unsafe(MIGRATE_LOCK_HOLDER_SQL, [MIGRATE_LOCK])) as { pid: number }[];
  return { holder: h ? `backend ${h.pid}` : null, newest: l?.newest ?? null };
}

/**
 * The newest live write after `after` — a timestamp, or a number of seconds
 * before now() — and the database's now(). A live write is a thought_audit
 * row whose actor_kind is not 'ingested' (NULL counts as live) and that no
 * server's background work wrote (actor_context.background — the vector
 * mender's, SMD-2889), as these passes' own writes are not live; a search is
 * none (SMD-3315). Bounded below, so a brain whose newest audit rows are all
 * sync writes is not read back to its last live one.
 */
async function newestLive(sql: SQL, after: Date | number): Promise<{ now: Date; write: Date | null }> {
  const since = typeof after === "number" ? sql`now() - make_interval(secs => ${after})` : sql`${after}::timestamptz`;
  const [r] = await sql`
    SELECT now() AS now,
           (SELECT max(created_at) FROM thought_audit WHERE created_at > ${since} AND actor_kind IS DISTINCT FROM 'ingested'
              AND (actor_context->>'background') IS NULL) AS write`;
  return { now: new Date(r.now), write: r.write ? new Date(r.write) : null };
}

/**
 * A claim follower's heartbeat key as pass-stamp.ts writes one (brain-info.ts's
 * alphabet): any other row under the prefix is not counted, and is never
 * pasted into the DELETE the refusal prints (review pass 1). Matched in the
 * query, as Postgres reads the same pattern, so no other row takes a place
 * under the read's bound (review pass 2).
 */
const FOLLOWER_KEY = new RegExp(`^heartbeat:(extract|consolidate|reembed):${NAME_CHARS}{1,120}$`);

/** The claim followers stamping outside this scheduler, fresh as brain-info.ts reads a heartbeat: they do not yield to a live call. Newest first, so stale rows never hide a fresh one past the bound. */
async function followersOutside(sql: SQL): Promise<string[]> {
  const rows = (await sql`
    SELECT key, value, extract(epoch FROM now() - updated_at)::float8 AS age_s FROM ob1_config
     WHERE key ~ ${FOLLOWER_KEY.source} ORDER BY updated_at DESC LIMIT 20`) as { key: string; value: string; age_s: number }[];
  return rows.filter((r) => {
    try {
      const v = JSON.parse(r.value) as { every_s?: number; ended?: boolean };
      return !v.ended && typeof v.every_s === "number" && Number(r.age_s) <= v.every_s * STALE_AFTER_INTERVALS;
    } catch { return false; }
  }).map((r) => r.key);
}

/** The `slept` mark heartbeat:sleep carries now, when of the shape: what a refusal's stamp keeps (review pass 4). */
async function lastSlept(sql: SQL): Promise<SleepMark | null> {
  const [r] = (await sql`SELECT value, updated_at FROM ob1_config WHERE key = 'heartbeat:sleep'`) as { value: string; updated_at: Date | string }[];
  if (!r) return null;
  try {
    const s = (JSON.parse(r.value) as { slept?: { from?: unknown; to?: unknown } }).slept;
    if (!(s && typeof s.from === "string" && (s.to === null || typeof s.to === "string"))) return null;
    // A sleep the last process never ended — killed mid-sleep, most likely,
    // as it is asleep most of the time — ends at its row's last stamp, within
    // a minute of the truth (it stamped at least that often asleep): a mark
    // with no end reads "no sleep yet" to preflight's awake row (SMD-2752 PR 3,
    // review pass 2).
    const { budget, limit } = s as { budget?: unknown; limit?: unknown };
    const stopped = s.to !== null && (budget === "clock" || budget === "statement") ? budget : undefined;
    // The bound within its kind's range, as brain-info.ts reads it.
    const inRange = Number.isSafeInteger(limit) && (limit as number) >= 0 && (limit as number) <= (stopped === "clock" ? MAX_BUDGET_MIN : MAX_STATEMENT_TIMEOUT_S);
    return { from: s.from, to: s.to ?? new Date(r.updated_at).toISOString(), ...(stopped ? { budget: stopped, ...(inRange ? { limit: limit as number } : {}) } : {}) };
  } catch {
    return null;
  }
}

/**
 * The line naming followers outside the scheduler: the dry run's, or a run's
 * refusal — at its start, or found later in an awake or asleep poll (review
 * pass 1: a follower started beside it — a hand run, an old stack's container,
 * never the coordinator's — stamps only after its start probe, past the
 * start's check). The keys
 * are FOLLOWER_KEY's alphabet, so the DELETE it prints is safe to paste.
 */
function outsideLine(outside: string[], dryRun: boolean): string {
  // A re-embed follower is a hand run — no compose service runs one — whose stop ends its row at once (review pass 1).
  const hand = outside.filter((k) => k.startsWith("heartbeat:reembed:"));
  const handFix = "a reembed.ts --follow run by hand: stop it (Ctrl-C, or its container) — its row ends as it stops — and start sleep again";
  // Hand runs alone: the followers' remedy names containers that are not running (review pass 2).
  if (hand.length === outside.length) {
    return `  ${dryRun ? "a re-embed follower running outside sleep, which does not yield to a live call" : "refused: a re-embed follower is running outside sleep, and it does not yield to a live call"}: ${hand.join(", ")} — ${handFix}`;
  }
  const handWords = hand.length ? `. ${hand.join(", ")} is ${handFix}` : "";
  return `${outsideLineOf(outside, dryRun)}${handWords}`;
}
function outsideLineOf(outside: string[], dryRun: boolean): string {
  return `  ${dryRun ? "followers running outside sleep, which do not yield to a live call" : "refused: followers are running outside sleep, and they do not yield to a live call"}: ${outside.join(", ")} — a stack's from before the coordinator (SMD-3476), which never runs both, or a --follow run by hand. Sleep and the workers are alternatives: stop them (podman compose -f deploy/compose.yaml up -d --remove-orphans, with the -f files and -p the stack was started with, removes the old extract and consolidate; Ctrl-C a hand run), then delete their rows (DELETE FROM ob1_config WHERE key IN (${outside.map((k) => `'${k}'`).join(", ")})) so preflight does not ask for them back. A follower stopped cleanly marks its row ended at once; one killed past its grace leaves it fresh for up to three of its intervals`;
}

const ago = (now: Date, t: Date | null): string => (t ? `${Math.max(0, Math.round((now.getTime() - t.getTime()) / 1000))} s ago` : "none");

/**
 * The scheduler's line for a pass's start refusal that ends it — at the
 * check, a permanent one at a later sleep, or one at a pass's first start in
 * this process — with what to do beyond the pass's own words: those name the
 * cause, but the key's name a --switch-key this script does not take, and a
 * revoked key's no way back (review pass 6, an operator's walk through each
 * refusal).
 */
function refusedLine(pass: PassName, kind: StartRefusal | undefined, ends: string): string {
  // The other kinds' own words name their fix; preflight's row gives every kind's (db/config.mjs, SMD-2752).
  const remedy = kind === "key" || kind === "identity" ? `; ${startRefusalRemedy(kind)}` : "";
  return `  ${pass}'s start is refused${kind ? ` (${kind})` : ""} — ${ends}: fix what it names, then start the service again${remedy}`;
}

/**
 * The file a consolidation pass's verdicts go to under --dump-dir (SMD-3203): one per pass key, so a new judge or
 * decide version starts a file of its own, and each sleep of a pass appends to it. Each run of characters outside
 * letters, digits, ".", "_" and "-" (the key's ":", "+" and "@", a model name's "/") becomes one "_", so two keys
 * differing only there share a file; each line names its key.
 */
export function passDumpFile(dir: string, key: string): string {
  return join(dir, `${key.replace(/[^A-Za-z0-9._-]+/g, "_")}.jsonl`);
}

/** Why --dump-dir cannot be used, or null: it must name a directory this process can write, checked before anything runs. */
export function dumpDirProblem(dir: string): string | null {
  if (dir.trim() === "") return "--dump-dir is blank: name a directory, or leave the flag out";
  try {
    if (!statSync(dir).isDirectory()) return `--dump-dir ${dir} is not a directory`;
    accessSync(dir, constants.W_OK);
    return null;
  } catch {
    return `--dump-dir ${dir} is not a directory this process can write`;
  }
}

/** The scheduler's numbers from its options, or the refusal of the first that breaks its flag's rule. */
function numbers(opts: SleepOptions): Numbers | string {
  const read = (flag: string, v: number | null | undefined, absent: number, rule: { min: number; max?: number }): number | string => {
    if (v == null) return absent;
    const problem = numberProblem(flag, v, rule);
    return problem === null ? v : `${problem}\n${flagList(FLAGS, HINTS)}`;
  };
  const quiet = read("--quiet", opts.quiet, DEFAULT_QUIET_S, { min: 1, max: 86_400 });
  if (typeof quiet === "string") return quiet;
  const poll = read("--poll", opts.poll, DEFAULT_POLL_S, { min: 1, max: MAX_POLL_S });
  if (typeof poll === "string") return poll;
  const workers = read("--workers", opts.workers, 1, { min: 1, max: MAX_WORKERS });
  if (typeof workers === "string") return workers;
  const budget = read("--budget", opts.budget, DEFAULT_BUDGET_MIN, { min: 0, max: MAX_BUDGET_MIN });
  if (typeof budget === "string") return budget;
  const statementTimeout = read("--statement-timeout", opts.statementTimeout, DEFAULT_STATEMENT_TIMEOUT_S, { min: 0, max: MAX_STATEMENT_TIMEOUT_S });
  if (typeof statementTimeout === "string") return statementTimeout;
  const workMem = read("--work-mem", opts.workMem, DEFAULT_WORK_MEM_MB, { min: 1, max: MAX_MEM_MB });
  if (typeof workMem === "string") return workMem;
  const maintenanceWorkMem = read("--maintenance-work-mem", opts.maintenanceWorkMem, DEFAULT_MAINTENANCE_WORK_MEM_MB, { min: 1, max: MAX_MEM_MB });
  if (typeof maintenanceWorkMem === "string") return maintenanceWorkMem;
  return { quiet, poll, workers, budget, statementTimeout, workMem, maintenanceWorkMem };
}

/**
 * The scheduler, callable: the CLI's run, returning the code the CLI exits
 * with (the header's list). Nothing happens at import.
 */
export async function run(opts: SleepOptions): Promise<number> {
  const { out, err } = opts.writer ?? consoleWriter;
  const noUrl = opts.url == null || opts.url.trim() === "";
  const urlProblem = noUrl ? NO_DATABASE_URL : databaseUrlProblem(opts.url as string);
  if (urlProblem !== null) {
    err(urlProblem);
    return 2;
  }
  const settled = numbers(opts);
  if (typeof settled === "string") {
    err(settled);
    return 2;
  }
  const dumpProblem = opts.dumpDir === undefined ? null : dumpDirProblem(opts.dumpDir);
  if (dumpProblem !== null) {
    err(`${dumpProblem}\n${flagList(FLAGS, HINTS)}`);
    return 2;
  }
  // A caller's, not an operator's, so thrown: 0 would hand the passes no
  // --follow at all. The rule the flags' numbers keep (SMD-3048).
  const followProblem = opts.passFollowS === undefined ? null : numberProblem("passFollowS", opts.passFollowS, { min: 1 });
  if (followProblem !== null) throw new RangeError(followProblem);
  for (const [name, v] of [["budgetMs", opts.budgetMs], ["budgetGraceMs", opts.budgetGraceMs]] as const) {
    const problem = v === undefined ? null : numberProblem(name, v, { min: 0 });
    if (problem !== null) throw new RangeError(problem);
  }
  for (const [name, v] of [["quietMs", opts.quietMs], ["pollMs", opts.pollMs]] as const) {
    const problem = v === undefined ? null : numberProblem(name, v, { min: 1 });
    if (problem !== null) throw new RangeError(problem);
  }
  if (opts.signal?.aborted && !opts.dryRun) {
    err(STOPPED_EARLY);
    return 130;
  }
  const sql = opts.sql ?? openSql(opts.url as string, { max: 2, session: schedulerSession(settled) });
  try {
    // A migration seen ends the run with MIGRATION_EXIT, whichever way the loop then returned (PR 1c-1).
    const seen = { migration: false };
    try {
      const code = await sleepWith(sql, opts.url as string, opts, settled, out, err, seen);
      return seen.migration ? MIGRATION_EXIT : code;
    } catch (e) {
      // A throw on the way down from a migration seen is that end, not a crash (review pass 1).
      if (seen.migration) return MIGRATION_EXIT;
      throw e;
    }
  } finally {
    if (opts.sql == null) await sql.close().catch(() => {});
  }
}

/** A pass the scheduler started: its run, its stop once the pass began, and the signal that stops it before. */
type Running = { name: PassName; done: Promise<number>; settled: boolean; code: number | null; stop: PassStop | null; abort: AbortController; hushed: boolean; start: StartResult | null; timedOut: boolean };

async function sleepWith(sql: SQL, url: string, opts: SleepOptions, n: Numbers, out: Writer["out"], err: Writer["err"], seen: { migration: boolean }): Promise<number> {
  const { workers: WORKERS } = n;
  /** The quiet and the poll in seconds: a test's milliseconds in place of the flags' whole seconds (SMD-3196). */
  const QUIET = opts.quietMs !== undefined ? opts.quietMs / 1000 : n.quiet;
  const POLL = opts.pollMs !== undefined ? opts.pollMs / 1000 : n.poll;
  /** Each pass's session settings, and the sleep's clock and grace (SMD-2679). */
  const SESSION = budgetSession(n);
  const BUDGET_MS = opts.budgetMs ?? n.budget * 60_000;
  const GRACE_MS = opts.budgetGraceMs ?? BUDGET_GRACE_S * 1000;
  /** The clock on the row, in whole minutes: a test's milliseconds round up to one. */
  const CLOCK_MIN = Math.ceil(BUDGET_MS / 60_000);
  const FOLLOW = opts.follow === true;
  const env = opts.env ?? process.env;
  const cfg = resolveEmbedConfig(env as EmbedEnv);
  // Consolidation's key is decide mode's when OB1_CONSOLIDATE_DECIDER is set (SMD-3115), the judge's otherwise.
  /** The embedding model and width this stack is configured for, as reembed.ts reads them (config.mjs's embeddingContract). */
  const EMBED = embeddingContract(env);
  const JOBS: Record<PassName, string> = { reembed: reembedKey(EMBED.model, EMBED.dim), extract: extractionKey(cfg.metadataModel), consolidate: consolidatePassKey(cfg) };
  /**
   * Why this stack's embedding model and width form no re-embed key its row
   * carries, or null: such a key keeps re-embed out of sleep, said once. A
   * width that is no positive whole number crashed the first sleep (review
   * pass 2); a model name outside the readers' alphabet ran re-embed while
   * every reader of the row read none (SMD-3486).
   */
  const REEMBED_UNFIT = reembedKeyUnfit(EMBED.model, EMBED.dim);
  const REEMBED_OK = REEMBED_UNFIT === null;
  /** Its re-embed key on its heartbeat row, where it forms one (review pass 5). */
  const REEMBED_JOB = REEMBED_OK ? JOBS.reembed : undefined;
  /** --dump-dir: every consolidation verdict, appended to the pass key's own file (SMD-3203). */
  const DUMP = opts.dumpDir === undefined ? undefined : passDumpFile(opts.dumpDir, JOBS.consolidate);

  // The start's reads wait out a database not answering yet, as the sleep's
  // own do (reading, below): the compose service starts beside a Postgres that
  // may be restarting, and an exit here would spend one of its three restarts
  // (SMD-2678). A stop during the wait ends the run as a stop before it began.
  const startSaid = { down: false };
  /** The CLI passes no signal (its handlers come after these reads): a wait then ends only with the database. */
  const startWake = opts.signal ?? new AbortController().signal;
  const atStart = <T>(read: () => Promise<T>) => throughOutage(read, { wake: startWake, said: startSaid, out, err });
  // ── A migration in progress, waited out (SMD-3379 PR 1c-1) ───────────────
  // migrate.ts holds ob1:migrate while it writes (PR 1a): the start's reads
  // and the passes' starts below would meet a schema mid-change — a process
  // its supervisor restarted on a migration would read the old catalog — so
  // the scheduler waits until it is let go, before any of them, then takes
  // the ledger's newest name as what it watches each poll (the watcher,
  // below). A stop during the wait is a stop before the run began. A dry run
  // reads on.
  let ledgerAt: string | null = null;
  if (!opts.dryRun) {
    let saidWaiting = false;
    for (;;) {
      const state = await atStart(() => migrationState(sql));
      if (state === null || startWake.aborted) { err(STOPPED_EARLY); return 130; }
      if (state.holder === null) {
        ledgerAt = state.newest;
        break;
      }
      if (!saidWaiting) out(`  migration: ${state.holder} holds ob1:migrate, applying migrations — the scheduler waits for it to finish before it starts`);
      saidWaiting = true;
      await sleepUnless(POLL * 1000, startWake);
    }
  }

  /** The database's clock as this run began: a claim older than it is no pass of this run's (poolOf's `mineSince`). */
  const startedAt = await atStart(async () => new Date((await sql`SELECT now() AS now`)[0].now));
  if (startedAt === null) { err(STOPPED_EARLY); return 130; }
  out(`  quiet:  ${QUIET} s with no write in thought_audit but sync's (actor_kind 'ingested') and the vector mender's (marked background); a search does not wake it`);
  out(`  budget: ${budgetWords({ minutes: n.budget, statementTimeoutS: n.statementTimeout, workMemMb: n.workMem, maintenanceWorkMemMb: n.maintenanceWorkMem, stops: 0 })}${BUDGET_MS ? ` — then the passes stop after the thought in hand${opts.follow === true ? ", and the next sleep waits for a live call" : ""}` : ""}`);
  if (DUMP) out(`  dump:   each consolidation pass appends every verdict to ${DUMP}`);
  const outside = await atStart(() => followersOutside(sql));
  if (outside === null) { err(STOPPED_EARLY); return 130; }
  // Followers outside the scheduler do not yield to a live call, so a sleep
  // beside them is no sleep: a run refuses (2) rather than start one, and the
  // dry run names them (SMD-2678). The workers and sleep passes are
  // alternatives, which the coordinator never runs together (SMD-3476).
  // A signal aborted during the start's reads — one that did not wait on an
  // outage, where the wait returns 130 itself — is a stop before the run
  // began, and wins over what the reads found, a follower included: 130 and
  // no row, one rule (review passes 2 and 4).
  if (opts.signal?.aborted && !opts.dryRun) {
    err(STOPPED_EARLY);
    return 130;
  }
  /**
   * A pass's lines, each tagged with its name, and its own words for a stop
   * the scheduler made it take left out once `hushed` says so.
   */
  const tagged = (name: PassName, hushed: () => boolean): Writer => {
    const tag = (line: string) => line.split("\n").map((l) => (l.trim() ? `  [${name}]${l}` : l)).join("\n");
    const say = (write: Writer["out"]) => (l: string) => { if (!(hushed() && PASS_STOP_LINE.test(l))) write(tag(l)); };
    return { out: say(out), err: say(err) };
  };
  /**
   * A refusal at the start, under --follow said on the row too, ended on a
   * failure, so preflight's `sleep` row names what keeps the service down
   * rather than reading it as never run, or as one to start again (review
   * pass 3). The row's last sleep is carried over, since a stamp writes the
   * whole value (review pass 4).
   */
  const endAtStart = async (refused?: StartRefusal): Promise<void> => {
    if (!FOLLOW) return;
    const once = passStamper({ sql, worker: "sleep", intervalS: POLL, minEveryS: opts.minStampEveryS, reembedJob: REEMBED_JOB, onError: (e) => err(`  heartbeat: could not stamp heartbeat:sleep (${e.message})`) });
    const last = await lastSlept(sql).catch(() => null);
    if (last) once.slept?.(last);
    // The start refusal that ended it, when a pass's start was the cause:
    // preflight's row names it and its remedy (SMD-2752).
    if (refused) once.refused?.(refused);
    await once.end("failed");
  };
  if (outside.length) {
    err(outsideLine(outside, opts.dryRun === true));
    if (!opts.dryRun) {
      await endAtStart();
      return 2;
    }
  }
  // Whether this role reads 093's kept windows (SMD-2694): consolidation joins
  // past a thought extraction holds only when it can tell one, and the row
  // names the held thoughts only then. Read once, as the query log's state is;
  // a brain before 093, or a role without the extraction group's grant on it,
  // joins once extraction is drained, as before, and is told so once.
  // With it, whether 101's `cuts` is there to read (SMD-3060) — probed as the
  // held read resolves the table, unqualified: another schema's first on the
  // path lacks it too (review pass 3; board-findings.ts's rule).
  const progressRead = await atStart(async () => (await sql`
    SELECT CASE WHEN to_regclass('public.extraction_progress') IS NULL THEN 'missing'
                WHEN has_table_privilege('public.extraction_progress', 'SELECT') THEN 'yes' ELSE 'denied' END AS s,
           EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('extraction_progress') AND attname = 'cuts' AND NOT attisdropped) AS cuts`)[0] as { s: "yes" | "missing" | "denied"; cuts: boolean });
  if (progressRead === null) { err(STOPPED_EARLY); return 130; }
  const progressState = progressRead.s;
  /** Whether the held thoughts carry the scheduler's cuts: none read on a brain before 101, until a restart after it. */
  const CUTS = progressRead.cuts;
  /** The windowing extraction runs under, which a kept row must match to speak for the thought: set only when the rows are readable. */
  const SIG = progressState === "yes" ? JSON.stringify(windowingFor(cfg)) : undefined;
  if (progressState !== "yes") err(`  extraction_progress: ${progressState === "missing" ? "no such table (migration 093 not applied)" : "this role cannot read it (the extraction group's grant)"} — consolidation joins only once extraction is drained, and a thought the wakes hold back goes unnamed; a running scheduler takes it up once restarted`);
  // The re-derive sweep's function (063) and this role's EXECUTE on it, read
  // once as the rest are (SMD-2679): without either the sleeps sweep nothing,
  // said once.
  const sweepRead = await atStart(async () => (await sql`
    SELECT CASE WHEN to_regprocedure('rebuild_derived(uuid, text, boolean, text[], boolean, boolean)') IS NULL THEN 'missing'
                WHEN has_function_privilege('rebuild_derived(uuid, text, boolean, text[], boolean, boolean)', 'EXECUTE') THEN 'yes' ELSE 'denied' END AS s`)[0].s as "yes" | "missing" | "denied");
  if (sweepRead === null) { err(STOPPED_EARLY); return 130; }
  /** Whether each sleep runs the re-derive sweep: off for this process once a call is refused its privilege. */
  let sweeps = sweepRead === "yes";
  if (!sweeps) err(`  re-derive: ${sweepRead === "missing" ? "rebuild_derived is not on this brain (migration 063 not applied)" : "this role cannot execute rebuild_derived (GRANT EXECUTE ON FUNCTION rebuild_derived(uuid, text, boolean, text[], boolean, boolean) TO the role, as the owner)"} — the sleeps sweep no orphaned lineage row; a running scheduler takes it up once restarted`);

  /** The embedding model the brain records ("" for none): re-embed never switches it, and a record unlike EMBED's sets the pass aside. */
  const recordedModel = async (): Promise<string> => ((await sql`SELECT value FROM ob1_config WHERE key = 'embedding_model'`)[0]?.value as string | undefined) ?? "";
  /** Whether a record sets re-embed aside: one there, and unlike this stack's model (none is recorded by the pass's first pool). */
  const switched = (recorded: string): boolean => recorded !== "" && recorded !== EMBED.model;
  const asideLine = (recorded: string): string =>
    `  re-embed set aside: the brain records ${recorded}, this stack is configured for ${EMBED.model} — to keep ${EMBED.model}, run OB1_EMBEDDING_MODEL=${shellWord(EMBED.model)} bun db/reembed.ts --switch-model (the record is read again each poll); to keep ${recorded}, set OB1_EMBEDDING_MODEL=${shellWord(recorded)} (and OB1_EMBEDDING_DIM to its width) in deploy/.env and recreate api and sleep (this scheduler reads its environment once at its start). Extraction and consolidation run on`;
  /**
   * Re-embed set aside for a model switch it will not make (SMD-2679 PR 4b,
   * the maintainer's choice): the model the brain records while it differs
   * from this stack's, or null while re-embed runs. Set at a sleep's start,
   * or by the pass refusing `model-switch`; read again at each poll while
   * set, so a record put right — a --switch-model run by hand, which wakes
   * nothing — clears it within the sleep, and the next sleep re-embeds.
   */
  let reembedAside: { recorded: string } | null = null;
  /**
   * Re-embed set down for this sleep (review pass 1, the maintainer's
   * choice): refused at its start or mid-pass, a statement past its timeout,
   * its provider not answering — said, on the row, the claim passes running
   * on; the next sleep with work tries it again. Cleared as each sleep begins.
   */
  let reembedDown: ReembedDown | null = null;
  /** Re-embed set down or aside at any point of this sleep: its pool left, so a one-shot sleep exits 1 (review pass 3: one taken up mid-sleep, or its clock-out, exited 0). */
  let reembedLeft = false;
  const asideWord = (): SleepAside | null =>
    reembedAside ? { reembed: { kind: "model-switch", recorded: reembedAside.recorded, configured: EMBED.model } } : reembedDown ? { reembed: { kind: reembedDown } } : null;

  if (REEMBED_UNFIT === "width") err(`  re-embed: OB1_EMBEDDING_DIM (${EMBED.dim}) is no positive whole number of at most nine digits — re-embed does not run in sleep; the server refuses it too`);
  // The name not printed: what makes it unfit may be a character a log should not carry either.
  if (REEMBED_UNFIT === "model") err("  re-embed: OB1_EMBEDDING_MODEL is no model name this scheduler's row can carry (ASCII letters, digits and . _ : @ / + -, the name and its width at most 120 characters as <name>@<width>) — re-embed does not run in sleep; run bun db/reembed.ts by hand when it has work, as preflight says");

  if (opts.dryRun) {
    const [{ now }] = await sql`SELECT now() AS now`;
    const at = new Date(now);
    const [last] = await sql`
      SELECT (SELECT created_at FROM thought_audit WHERE actor_kind IS DISTINCT FROM 'ingested' AND (actor_context->>'background') IS NULL ORDER BY created_at DESC LIMIT 1) AS write`;
    const write = last.write ? new Date(last.write) : null;
    const left = write ? QUIET - (at.getTime() - write.getTime()) / 1000 : 0;
    out(`  last write: ${ago(at, write)}`);
    out(left <= 0 ? "  a sleep would begin now" : `  awake: a sleep would begin in ${Math.ceil(left)} s with no live call`);
    const recorded = await recordedModel();
    for (const pass of PASSES) {
      if (pass === "reembed" && !REEMBED_OK) continue;
      const p = await poolOf(sql, pass, JOBS[pass], SIG);
      out(`  ${pass} (${JOBS[pass]}): ${p.claimed} in flight, ${p.pending} pending, ${p.unpooled} not yet in the pool, ${p.failed} failed${drained(p) ? " — drained" : joinsPast(p) ? ` — only ${p.stalled} stalled thought(s), which consolidation would join past` : ""}`);
      if (pass === "reembed" && p.unlabelled) out(`  reembed: ${p.unlabelled} of those not yet in the pool are unlabelled — vectors from before migration 021, which the first sleeps re-embed and label`);
      if (pass === "reembed" && switched(recorded)) out(asideLine(recorded));
    }
    if (SIG !== undefined) {
      const held = await heldBack(sql, JOBS.extract, SIG, CUTS);
      if (held.total) out(`  held back across wakes (${held.thoughts.length} of ${held.total}): ${held.thoughts.map(heldWords).join("; ")}`);
    }
    // The re-derive sweep's pool, as the first sleep would read it (SMD-2679).
    if (sweepRead === "yes") {
      // A role that may call the function but not read the table is the sweep's to meet, not the dry run's to throw on (review pass 2).
      const census = await orphanCensus(sql).catch((e: Error) => e);
      if (census instanceof Error) err(`  re-derive: could not read the lineage table (${census.message}) — the first sleep's sweep meets it too`);
      else out(`  re-derive: ${census.ids.length >= 500 ? "500 or more" : census.ids.length} thought(s) with a lineage row whose artifact is gone${census.windowed ? ", in the first window of 10,001 lineage rows — the sleeps walk the rest" : ""}`);
    }
    return 0;
  }

  // ── The passes' starts, checked once (SMD-2752) ──────────────────────────
  // Each pass's own start — its banner, the egress gate, the tables, the
  // model's probe, the worker key, extraction's recorded key — run once here
  // (the engines' `check`), so a misconfiguration ends the service at its
  // start rather than at the first quiet, or after extraction's backlog for
  // consolidation's judge. The passes each sleep starts leave their banner to
  // this. A provider that does not answer is no refusal: each pass waits for
  // it at its own start, as before. The check runs before this process's
  // heartbeat exists — its probes up to a minute each, a database outage as
  // long as it lasts — so preflight reads the last process's row meanwhile,
  // as during the start's reads above; a refusal, or an error the check
  // throws, ends the row failed (review passes 1 and 3). Its probes are model
  // calls at the service's start whatever the brain's traffic — one token to
  // each model, which on a tight GPU may swap a model in once per start.
  /**
   * The passes whose start got through in this process — the provider
   * answered their probe, the keys resolved — at this check or at a sleep's
   * start (onPass). A model or provider refusal at a later start is then one
   * a re-pull or a top-up can mend, and is retried (review pass 3 of
   * SMD-1794; the check feeds it since SMD-2752).
   */
  const begun = new Set<PassName>();
  for (const pass of PASSES) {
    // Re-embed's start is each sleep's, run only when its backlog has work,
    // and whatever refuses it sets it down for that sleep rather than ending
    // the scheduler (review pass 1, the maintainer's choice): no probe of the
    // embedding endpoint at the scheduler's start.
    if (pass === "reembed") continue;
    // Written in the callback, which control-flow analysis does not follow:
    // the cast keeps the declared type (SMD-1932's idiom).
    let result = null as StartResult | null;
    // A check that throws — a grant refused on a read, say — ends the row
    // failed before it propagates, as a pass that throws at a sleep does in
    // the loop below, rather than leave the last process's row (review pass 3).
    const checking = {
      url, env, workers: WORKERS, follow: opts.passFollowS ?? PASS_FOLLOW_S, signal: opts.signal, check: true, session: SESSION,
      onStart: (r: StartResult) => { result = r; }, writer: tagged(pass, () => false),
    };
    const code = await (pass === "extract" ? runExtract(checking) : runConsolidate(checking)).catch(async (e: unknown) => {
      await endAtStart().catch(() => {});
      throw e;
    });
    // The engine said its own "stopped before the pass began".
    if (code === 130) return 130;
    if (code !== 0) {
      const kind = result && !result.ok ? result.refused : undefined;
      err(refusedLine(pass, kind, "the scheduler does not start"));
      await endAtStart(kind);
      return code;
    }
    if (result?.ok && result.provider === "up") begun.add(pass);
  }
  // A stop during the checks, landed after the last of them returned: a stop before the run began.
  if (opts.signal?.aborted) {
    err(STOPPED_EARLY);
    return 130;
  }

  // ── The heartbeat ────────────────────────────────────────────────────────
  // Only --follow stamps, as only a follower does: one sleep leaves no row to go stale.
  const stamper: PassStamper = FOLLOW
    ? passStamper({ sql, worker: "sleep", intervalS: POLL, minEveryS: opts.minStampEveryS, reembedJob: REEMBED_JOB, onError: (e) => err(`  heartbeat: could not stamp heartbeat:sleep (${e.message}) — the scheduler goes on as it was; the row keeps its last word until a stamp lands`) })
    : { key: "", stamp: async () => {}, end: async () => {}, during: (p) => p, alive: async () => {} };
  stamper.aside?.(asideWord());
  /** The sleeps stopped on the budget since this process began, on the row with the budget in force (SMD-2679). */
  let budgetStops = 0;
  const sayBudget = (): void => stamper.budget?.({ minutes: n.budget, statementTimeoutS: n.statementTimeout, workMemMb: n.workMem, maintenanceWorkMemMb: n.maintenanceWorkMem, stops: budgetStops });
  sayBudget();
  /** Why the last sleep stopped on its budget, and where its wake read began: the next sleep waits for a live event since (awaitWake). */
  let budgetKind = "clock" as BudgetStop;
  let budgetFrom = new Date(0);
  /**
   * Whether the clock found work left — a claim pending or in hand under the
   * passes' keys — so its stop is counted and marked; an idle clock-out ends
   * the sleep as quietly as a drained one (review pass 2: every quiet night
   * read "stopped on its budget"). And whether a wake ended it inside the
   * grace: the live call the next sleep waits for came already.
   */
  let budgetCut = false;
  let budgetWoke = false;
  // The last process's sleep, carried until this one sleeps: a stamp writes
  // the whole value, and a restarted scheduler's first row read "no sleep
  // yet" in preflight (review pass 1 of SMD-2752 PR 3; SMD-2678's mark).
  if (FOLLOW) {
    // Through the start's outage wait, as the other start reads: a blip here
    // would drop the mark (review pass 2). A stop during the wait, or another
    // error, leaves it to the first sleep.
    const last = await atStart(() => lastSlept(sql)).catch(() => null);
    if (last) stamper.slept?.(last);
  }
  /**
   * The thoughts extraction holds back across the wakes, on the row for
   * preflight's `sleep` row (SMD-2694): read at the first stamp awake or the
   * first poll asleep, after each wake, at least every minute after — a thought held back is most
   * often finished in a long sleep, which ends at the next live call or its
   * clock, an hour or more later (review pass 1) — and before the row ends; carried by the next
   * write. A courtesy, as the tail move is: a read that fails is said once and
   * leaves the row's last word on them.
   */
  let saidHeld = false;
  let heldAt = 0;
  const sayHeld = async (): Promise<void> => {
    if (SIG === undefined || !FOLLOW) return;
    heldAt = Date.now();
    try {
      stamper.held?.(await heldBack(sql, JOBS.extract, SIG, CUTS));
      // A later failure is said again (review pass 2).
      saidHeld = false;
    } catch (e) {
      if (!saidHeld) err(`  could not read the thoughts the wakes hold back (${(e as Error).message}) — the row keeps its last word on them`);
      saidHeld = true;
    }
  };
  // No read here: the first awake stamp reads them, as does the first asleep poll.
  let saidStalled = false;
  const stalledUnread = (e: Error): void => {
    if (!saidStalled) err(`  could not read the stalled thoughts (${e.message}) — consolidation joins only once extraction is drained while it stays unreadable; every poll reads it again`);
    saidStalled = true;
  };
  /** The row's end, the held thoughts read first: an operator's hand run since may have finished one. */
  const endRow = async (o: "stopped" | "failed", m?: MalformedBlock): Promise<void> => {
    // The watcher ended it already, without the held read (PR 1c-1).
    if (seen.migration) return;
    await sayHeld();
    await stamper.end(o, m);
  };
  const everyMs = Math.max(opts.minStampEveryS ?? MIN_STAMP_EVERY_S, POLL) * 1000;
  /** Each pass's last word in this sleep, and extraction's last judged block. */
  const words: Partial<Record<PassName, PassOutcome>> = {};
  let malformed: MalformedBlock | null | undefined;
  const sleepOutcome = (): "ok" | "failed" => (Object.values(words).includes("failed") ? "failed" : "ok");
  /**
   * The passes waiting at their start for a provider that does not answer,
   * as each says through its stamper: heartbeat:sleep carries them, so
   * preflight's row says the sleep waits on the provider rather than that its
   * passes run (SMD-2752).
   */
  const waitingAtStart = new Set<PassName>();
  /**
   * The passes waiting mid-pass for a provider that stopped answering, as each
   * says through its stamper (providerWait): read by the poll (SMD-3008), and
   * carried by heartbeat:sleep beside the start's, so preflight's row says the
   * provider rather than that its passes run (SMD-2905).
   */
  const waitingMidPass = new Set<PassName>();
  const sayWaiting = async (outcome?: "ok" | "failed"): Promise<void> => {
    stamper.waiting?.(PASSES.filter((p) => waitingAtStart.has(p)));
    stamper.waitingMidPass?.(PASSES.filter((p) => waitingMidPass.has(p)));
    await stamper.alive(outcome);
  };
  /** What a pass stamps goes to the sleep's row: its outcome mid-sleep, never an end, which is the scheduler's. */
  const through = (pass: PassName): PassStamper => ({
    key: stamper.key,
    async stamp(o, m) {
      words[pass] = o;
      if (m !== undefined) malformed = m;
      await stamper.alive(sleepOutcome(), malformed ?? undefined);
    },
    async end(o, m) {
      if (o === "failed") words[pass] = o;
      if (m !== undefined) malformed = m;
    },
    during: (p) => p,
    alive: async () => {},
    async startWait(on) {
      if (on) waitingAtStart.add(pass);
      else waitingAtStart.delete(pass);
      await sayWaiting();
    },
    async providerWait(on) {
      if (on) waitingMidPass.add(pass);
      else waitingMidPass.delete(pass);
      // Re-embed's provider not answering is the provider's state, not a
      // failure (SMD-2679 PR 4b): the failed word its follower stamps as the
      // wait begins goes at once, not at the poll that sets it down, where the
      // row read failed for that poll. Extraction's wait reads failed, as before.
      const cleared = on && pass === "reembed" && words.reembed === "failed";
      if (cleared) delete words.reembed;
      await sayWaiting(cleared ? sleepOutcome() : undefined);
    },
  });

  // ── The scheduler's stop ─────────────────────────────────────────────────
  let stopping = false;
  let hardStopped = false;
  let finished = false;
  /** Aborted by the first stop: the awake wait and the sleep's poll wake on it. */
  const onStop = new AbortController();
  const running: Running[] = [];
  // A pass's signal is its first stop, and aborting it again does nothing; its
  // PassStop called after that is the hard stop — the leases returned and the
  // call in hand aborted. A pass not yet begun has no PassStop: the signal
  // stops it before it claims. Either way the pass's own words for the stop
  // (a "signal" the operator did not send) are left out (`hushed`).
  const softStop = (p: Running): void => {
    p.hushed = true;
    if (!p.settled) p.abort.abort();
  };
  /** `cut`: the scheduler's own (setAside, or stopPasses for a reason of its own), counted on the thought in hand apart from its stops, which say the wakes (101, SMD-3060). */
  const hardStop = async (p: Running, cut = false): Promise<void> => {
    p.hushed = true;
    if (p.settled) return;
    p.abort.abort();
    await p.stop?.(cut ? { cut } : undefined);
  };
  const stop: PassStop = () => {
    if (finished) return null;
    if (stopping) {
      hardStopped = true;
      err("\n  second signal — the passes stop now, their leases returned");
      // The row ends before the CLI exits on the release (stopOnSignals), so
      // it reads stopped rather than running until it goes stale.
      // The row's end directly: the CLI exits 3 s after this signal, and the
      // held read would spend that (review pass 2); the row reads stopped,
      // and preflight names a stopped scheduler's held thoughts at its last word.
      return Promise.all(running.map((p) => hardStop(p))).then(() => stamper.end("stopped", malformed ?? undefined));
    }
    stopping = true;
    onStop.abort();
    for (const p of running) softStop(p);
    err("\n  stopping: the passes after the thought in hand (again to stop them now)");
    return null;
  };
  const abort = () => {
    if (stopping) return;
    stopping = true;
    onStop.abort();
    for (const p of running) softStop(p);
    err("\n  stopping: the passes after the thought in hand");
  };
  opts.signal?.addEventListener("abort", abort, { once: true });
  // A signal aborted during the start's reads has already fired, and a listener
  // added now never would (review pass 1).
  if (opts.signal?.aborted) abort();
  opts.onPass?.(stop);

  /** A database read that outlasts the database going away (worker-bootstrap.ts's throughOutage): null when a stop ended the wait. */
  const said = { down: false };
  const reading = <T>(read: () => Promise<T>): Promise<T | null> => throughOutage(read, { wake: onStop.signal, said, out, err });

  /** Aborted when a pass of the current sleep settles, so its poll wakes to read why. */
  let passEnded = new AbortController();
  const start = (name: PassName, workers = WORKERS): Running => {
    const abort = new AbortController();
    const p: Running = { name, done: Promise.resolve(0), settled: false, code: null, stop: null, abort, hushed: false, start: null, timedOut: false };
    // Its banner and its summary's queries are left out: the check said the
    // one at the scheduler's start, and the other is a scan the scheduler
    // would wait for at a wake (SMD-2752). Its start is reported, so a
    // refusal is told apart.
    const common = {
      url, env, workers, follow: opts.passFollowS ?? PASS_FOLLOW_S, signal: abort.signal, stamper: through(name),
      banner: false, summary: false, session: SESSION,
      onStart: (r: StartResult) => { p.start = r; },
      onPass: (s: PassStop) => { p.stop = s; begun.add(name); },
      writer: tagged(name, () => p.hushed),
    };
    const ended = passEnded;
    // Extraction's stall floor is its own (consolidation counts no stall).
    p.done = (name === "reembed" ? runReembed(common) : name === "extract" ? runExtract({ ...common, stallFloorMs: opts.stallFloorMs }) : runConsolidate(DUMP ? { ...common, dump: DUMP } : common)).then((code) => {
      p.settled = true;
      p.code = code;
      ended.abort();
      return code;
    }, (e) => {
      p.settled = true;
      ended.abort();
      // A statement past the pass's statement_timeout ends the pass, not the
      // scheduler: the poll reads it as the sleep's budget (SMD-2679). Before,
      // it rejected out of the sleep and the scheduler ended with 1.
      if (statementTimedOut(e)) {
        p.timedOut = true;
        p.code = 1;
        err(`  ${name}: a statement passed the pass's statement_timeout (${n.statementTimeout ? `${n.statementTimeout} s` : "the role's or the database's own"}) — ${(e as Error).message}; the pass ends`);
        return 1;
      }
      throw e;
    });
    // Handled now, read later: a pass that throws is rejected out of
    // stopPasses at the next poll, and until then the runtime would report it
    // unhandled — printed twice, and an in-process host's exit forced to 1
    // (review pass 4). allSettled still sees the rejection.
    p.done.catch(() => {});
    running.push(p);
    return p;
  };

  /**
   * Stop every pass — hard, a wake; soft, a sleep done — and wait for each to
   * return. A pass that threw rejects here, once the others have stopped.
   * `cut`: a hard stop of the scheduler's own, not a wake's nor the
   * operator's — a pass ended by itself, a follower found outside, an error —
   * counted on the thought in hand as a cut (101, SMD-3060).
   */
  const stopPasses = async (hard: boolean, cut = false): Promise<void> => {
    if (hard) await Promise.all(running.map((p) => hardStop(p, cut)));
    else for (const p of running) softStop(p);
    const results = await Promise.allSettled(running.map((p) => p.done));
    running.length = 0;
    // A stopped pass waits for nothing, and each says so as its wait ends (the
    // engines' finally): defensive only, the set is empty here (review pass 1).
    if (waitingAtStart.size) {
      waitingAtStart.clear();
      stamper.waiting?.([]);
    }
    if (waitingMidPass.size) {
      waitingMidPass.clear();
      stamper.waitingMidPass?.([]);
    }
    const thrown = results.find((r) => r.status === "rejected");
    if (thrown) throw (thrown as PromiseRejectedResult).reason;
  };

  /**
   * The claims this process's passes hold — their worker ids carry the host
   * and pid (extract-entities.ts's and consolidate.ts's `workerId`) — read
   * before a wake's hard stop returns them.
   */
  const heldHere = async (): Promise<{ id: string; job: string }[]> =>
    (await sql`
      SELECT thought_id::text AS id, work_type AS job FROM thought_work_claims
       WHERE work_type IN (${JOBS.reembed}, ${JOBS.extract}, ${JOBS.consolidate}) AND status = 'claimed'
         AND (starts_with(worker_id, ${REEMBED_MINE}) OR starts_with(worker_id, ${MINE}) OR starts_with(worker_id, ${CONSOLIDATE_MINE}))`) as { id: string; job: string }[];
  /**
   * A wake's abandoned claims to the back of the queue. The release keeps
   * enqueued_at and counts no attempt (015), and claims are taken oldest
   * first, so a thought longer than the sleeps would be taken first by every
   * sleep and the pool behind it would never move (review pass 1, run).
   */
  let saidTail = false;
  const toTail = async (held: { id: string; job: string }[]): Promise<void> => {
    if (held.length === 0) return;
    try {
      await sql`
        UPDATE thought_work_claims c SET enqueued_at = now()
          FROM unnest(${sql.array(held.map((h) => h.id), "TEXT")}::uuid[], ${sql.array(held.map((h) => h.job), "TEXT")}::text[]) AS u(id, job)
         WHERE c.thought_id = u.id AND c.work_type = u.job AND c.status = 'pending'`;
    } catch (e) {
      if (!saidTail) err(`  could not move the thought(s) the wake left to the back of the queue (${(e as Error).message}) — the next sleep takes them first again`);
      saidTail = true;
    }
  };

  /**
   * The thoughts a stop has taken, to the back of the queue as each sleep
   * begins (093's stops, at the text and windowing in force; review pass 5):
   * a wake's tail move dates them at the wake, so every capture of the awake
   * period after it queued behind them — a stalled thought then held the one
   * worker each sleep until the next wake, those captures unextracted all day
   * and the pool never all stalled. New work first, the long thoughts last,
   * and among them the least stalled first, then the order they had: dated
   * alike, claim_thoughts' tie fell the same way every sleep, so a stalled
   * thought could hold the worker ahead of a document still gaining windows,
   * or of one stall short of the join, and neither advanced (review pass 6).
   * Dated FORWARD_DAYS ahead, not now: a capture made during the sleep —
   * a sync write's, which wakes nothing — is enqueued at its own now(), and
   * behind a stalled thought dated at the sleep's start it waited out the
   * window in hand (SMD-3008). claim_thoughts orders by enqueued_at and reads
   * no clock (015), so the date is an order, not a delay; a wake's tail move
   * dates the thought(s) in hand now, and the next sleep dates every stopped
   * thought forward again. A courtesy, as the
   * wake's tail move is: one that fails is said once, and returns false.
   * A lapsed lease is moved too: a scheduler gone left it claimed, and the
   * next claim reaps it with its old date, ahead of the sleep's captures
   * (review pass 2).
   */
  let saidRetail = false;
  const stoppedLast = async (): Promise<boolean> => {
    if (SIG === undefined) return false;
    try {
      // A forward date outlives its stop record: a thought finished since (its
      // row deleted) and put back by a --retry-* flag or retry_failed keeps the
      // date and went behind every capture for up to 30 days. Dated now, then
      // moved forward again below if it is still a stopped thought (post-merge review).
      await sql`
        UPDATE thought_work_claims c SET enqueued_at = now()
         WHERE c.work_type = ${JOBS.extract} AND c.status = 'pending' AND c.enqueued_at > now()
           AND NOT EXISTS (SELECT 1 FROM extraction_progress e JOIN thoughts t ON t.id = e.thought_id
                            WHERE e.thought_id = c.thought_id AND e.work_type = c.work_type AND e.stops > 0 AND ${currentProgress(sql, SIG)})`;
      await sql`
        UPDATE thought_work_claims c SET enqueued_at = now() + make_interval(days => ${FORWARD_DAYS}) + o.rn * interval '1 microsecond'
          FROM (SELECT c2.thought_id, row_number() OVER (ORDER BY CASE WHEN e.gained > 0 THEN 0 ELSE e.stalled END, c2.enqueued_at, c2.thought_id) AS rn
                  FROM thought_work_claims c2 JOIN extraction_progress e USING (thought_id, work_type) JOIN thoughts t ON t.id = c2.thought_id
                 WHERE c2.work_type = ${JOBS.extract} AND (c2.status = 'pending' OR (c2.status = 'claimed' AND c2.ttl_expires_at < now()))
                   AND e.stops > 0 AND ${currentProgress(sql, SIG)}) o
         WHERE c.thought_id = o.thought_id AND c.work_type = ${JOBS.extract}`;
      return true;
    } catch (e) {
      if (!saidRetail) err(`  could not move the stopped thoughts behind new captures (${(e as Error).message}) — they are taken in queue order this sleep`);
      saidRetail = true;
      return false;
    }
  };

  /**
   * Followers found outside the scheduler after its start: a follower started
   * with it (both profiles at once) stamps only past its start probe. Each
   * awake and asleep poll reads them, and one found ends the run as the
   * start's refusal does (2).
   */
  let foreign: string[] = [];
  const outsideNow = async (): Promise<boolean> => {
    const found = await reading(() => followersOutside(sql));
    if (found && found.length) foreign = found;
    return foreign.length > 0;
  };

  /** Awake: wait until the brain has been quiet --quiet seconds. The database's now() when it fell asleep, or null on a stop or followers found outside. */
  const awaitQuiet = async (): Promise<Date | null> => {
    let stampedAt = 0;
    while (!stopping) {
      if (await outsideNow()) return null;
      const r = await reading(() => newestLive(sql, QUIET));
      if (r === null) return null;
      const newest = r.write;
      if (newest === null) return r.now;
      if (Date.now() - stampedAt >= everyMs) {
        // On heldAt, not this wait's stamp: a wake's own read is a moment old (review pass 2).
        if (Date.now() - heldAt >= everyMs) await sayHeld();
        await stamper.alive();
        stampedAt = Date.now();
      }
      const left = QUIET * 1000 - (r.now.getTime() - newest.getTime());
      await sleepUnless(Math.min(everyMs, Math.max(POLL * 1000, left)), onStop.signal);
    }
    return null;
  };

  /** Said once: a sweep that failed, a replay's refusal, a table larger than one window — so none is a line every sleep. */
  let saidSweep = false;
  /** Whether every call of a sweep failing has been said: once, until a sweep's call succeeds (review pass 4: said every sleep). */
  let saidAllFailed = false;
  let saidReplay = false;
  let saidWindowed = false;
  /**
   * Where the next sweep's window begins: the lineage rows in id order after
   * this one, null for the start. Moved on once a window is swept whole — its
   * orphans fewer than the limit, nothing stopped — so successive sleeps walk
   * a table larger than one window, which read in no order the same first
   * rows every sleep and never reached an orphan past them (review pass 1).
   */
  let sweepAfter = null as string | null;
  /** How long a stopped sweep's call in hand may run before it is cancelled on the server: a lock it waits on would hold the wake or the stop (review passes 1 and 2). */
  const SWEEP_GRACE_MS = 2000;
  /**
   * The sweep's lock wait, beside the budget's session: a call waiting on a
   * thought's row holds the supersession lock, which live deletes, edits and
   * reviews wait on — uncommitted, so no wake sees them. Past it the call is
   * passed over, tried again when the sweep comes round (review pass 3).
   */
  const SWEEP_LOCK_TIMEOUT = "2s";
  /** Whether the clock cut the last sweep — stopped it with work in hand or left — which the clock's check after it reads (review pass 4: a sweep the clock stopped after its last call cut nothing). */
  let sweepCut = false;
  /**
   * The re-derive pass, first in each sleep (SMD-1794's order, SMD-2679):
   * rebuild_derived's orphans-only sweep over the lineage rows whose artifact
   * is gone (rebuild.ts's sweepOrphans) — no model, at most its 500 thoughts —
   * on a connection of its own under the budget's session, the wake read every
   * --poll seconds meanwhile: a live event, a stop or the clock spent stops it
   * between thoughts, its call in hand given SWEEP_GRACE_MS before it is
   * cancelled on the server; a wake ends the sleep. A courtesy, as the
   * tail move is: an error is said once and the passes go on; a replay's
   * refusal stops it, said once; a call refused its privilege (42501) or a
   * function gone (42883) ends the sweeps for this process.
   */
  const sweep = async (from: Date, began: number): Promise<"woken" | "stopped" | null> => {
    sweepCut = false;
    if (!sweeps) return null;
    const halt = new AbortController();
    const client = openSql(url, { max: 1, session: { ...SESSION, lock_timeout: SWEEP_LOCK_TIMEOUT } });
    let replayed = false;
    /** The sweep's backend, read first on its one connection: what a stop past the grace cancels. */
    let pid = 0;
    /** The first call a failure skipped, said in the summary. */
    let skippedFirst = "";
    const tag = (l: string) => l.replace(/^ {2}/, "  [re-derive] ");
    const run = (async () => {
      pid = Number((await client`SELECT pg_backend_pid() AS pid`)[0].pid);
      return sweepOrphans(client, {
        after: sweepAfter, stopOnReplay: true, signal: AbortSignal.any([halt.signal, onStop.signal]),
        // One thought whose call always fails is passed over, so the rest of
        // its window is reached; the database going away, a privilege or a
        // function gone are not (review pass 2). A call cancelled by the stop
        // never reaches here: sweepOrphans reads its signal first. The thought
        // is named, so the operator can find it (review pass 4).
        skipFailure: (e, thought) => {
          const code = (e as { errno?: string }).errno;
          if (databaseUnavailable(e) || code === "42501" || code === "42883") return false;
          skippedFirst ||= `${thought}: ${(e as Error).message}`;
          return true;
        },
        writer: {
          out: (l) => out(tag(l)),
          // A replay's refusal is the session's: said once, not once a thought.
          err: (l) => {
            if (!/refused REPLAYING/.test(l)) return err(tag(l));
            replayed = true;
            if (!saidReplay) err("  re-derive: this session is a replay (ob1.projecting_replay, a database- or role-level default) — rebuild_derived refuses every call, so the sweep stops at its first; each sleep tries one");
            saidReplay = true;
          },
        },
      });
    })().then((r) => ({ r }), (e: unknown) => ({ e: e as Error }));
    /** Why the sweep was stopped, if it was: none of these is a failure to say (review pass 2). */
    let why = null as "woke" | "stopping" | "spent" | null;
    /** The live call that woke it, said as the passes' wake is (review pass 4). */
    let wokeBy = "";
    let ended = null as { r?: SweepResult; e?: Error } | null;
    try {
      while (ended === null) {
        ended = await Promise.race([run, sleepUnless(POLL * 1000, onStop.signal).then(() => null)]);
        if (ended !== null) break;
        // Null only when a stop ended an outage's wait.
        const live = stopping ? null : await reading(() => newestLive(sql, from));
        if (live !== null) sleptUntil = live.now;
        const woken = live === null ? null : live.write;
        if (woken !== null) wokeBy = `write at ${woken.toISOString()}`;
        why = stopping || live === null ? "stopping" : woken !== null ? "woke" : BUDGET_MS > 0 && Date.now() - began >= BUDGET_MS ? "spent" : null;
        if (why === null) continue;
        halt.abort();
        const grace = () => Bun.sleep(SWEEP_GRACE_MS).then(() => null);
        ended = await Promise.race([run, grace()]);
        if (ended === null) {
          // A call waiting on a lock outlives a closed socket on the server,
          // holding the supersession lock as it waits: cancelled there, it
          // rolls back and lets go (review pass 2: close({ timeout: 0 })
          // closed nothing on Bun 1.4.3 while a query was in flight).
          // On a connection of the sweep's own role: a caller's client may be another's, which may not signal it (review pass 3).
          if (pid) {
            const killer = openSql(url, { max: 1 });
            await killer`SELECT pg_cancel_backend(${pid})`.catch(() => {});
            await killer.close({ timeout: 1 }).catch(() => {});
          }
          ended = await Promise.race([run, grace()]);
          if (ended === null) {
            await client.close({ timeout: 1 }).catch(() => {});
            ended = await run;
          }
        }
      }
    } finally {
      // A wake read that throws leaves here too: the sweep stops before its next call (review pass 4).
      halt.abort();
      await client.close({ timeout: 1 }).catch(() => {});
    }
    const woke = why === "woke";
    sweepCut = why === "spent" && (ended.e !== undefined || ended.r?.stopped === true);
    if (ended.e) {
      const code = (ended.e as { errno?: string }).errno;
      if (code === "42501" || code === "42883") {
        sweeps = false;
        err(`  re-derive: ${ended.e.message} — the sleeps sweep no more in this process${code === "42501" ? "; rebuild_derived runs over four groups' tables, so grant the role every group (bun db/migrate.ts --grant <role>) and restart the scheduler" : ""}`);
      } else if (!saidSweep && why === null) {
        saidSweep = true;
        const on = (ended.e as { thought?: string }).thought;
        err(`  re-derive: the sweep failed (${on ? `${on}: ` : ""}${ended.e.message}) — the passes go on; each sleep tries it again`);
      }
    } else if (ended.r) {
      const r = ended.r;
      saidSweep = false;
      // Only a sweep that made a call speaks for the session's replay (review pass 2).
      if (!replayed && r.touched + r.refused + r.failed > 0) saidReplay = false;
      if (r.deleted || r.failed) {
        const skipped = r.failed ? `; ${r.failed} thought(s) whose call failed passed over (${skippedFirst}), tried again when the sweep comes round` : "";
        // The limit cut it: the next sleep reads this window again (review pass 4: the progress was not said).
        const cut = !r.whole && !r.stopped ? ` — the first ${r.thoughts} orphaned thought(s) of this window; the next sleep goes on` : "";
        out(`  re-derive: ${r.deleted} orphaned lineage row(s) swept over ${r.touched} thought(s)${skipped}${r.stopped && !replayed ? ` — stopped before the rest${FOLLOW && why !== "stopping" ? ", which the next sleep sweeps" : ""}` : cut}`);
      }
      // Every orphan's call failing is the sweep's own trouble — a grant, a
      // trigger — more than one bad thought's: said on stderr once, until a
      // sweep's call succeeds (review passes 3 and 4).
      if (r.failed > 0 && r.failed === r.thoughts) {
        if (!saidAllFailed) err(`  re-derive: every call of this sleep's sweep failed (${skippedFirst}) — the passes go on; each sleep tries again`);
        saidAllFailed = true;
      } else if (r.touched > 0) saidAllFailed = false;
      // A window swept whole moves the cursor on; one stopped, or cut at the
      // limit, is read again.
      if (r.whole) {
        if (r.windowed && !saidWindowed) out("  re-derive: the lineage table holds more than one window of 10,001 rows — each sleep sweeps the next, once the one before is swept whole");
        saidWindowed ||= r.windowed;
        sweepAfter = r.windowed ? r.last : null;
      }
    }
    if (stopping) return "stopped";
    if (woke) {
      out(`  awake: a live ${wokeBy} during the re-derive sweep — the sleep ends`);
      return "woken";
    }
    return null;
  };

  /** The database's now() at the sleep's last read: the end of its `slept` mark (SMD-2678). */
  let sleptUntil = new Date(0);
  /**
   * Asleep from `since`: re-embed alone while it has work, then extraction
   * alone until its pool drains, then consolidation beside it. Returns one
   * of: "woken" on a live event; "done" when one sleep (no --follow) drained
   * its pools; "stopped" on a stop, the passes
   * stopped before it returns, inside the heartbeat's `during`; or, for a pass
   * that ended by itself (a refusal), its name, its code and whether it had
   * got past its start in this sleep; or "outside" when a poll found a
   * follower running outside it, the passes stopped (hard) first.
   */
  const asleep = async (since: Date): Promise<"woken" | "done" | "stopped" | "outside" | "budget" | { pass: PassName; code: number; started: boolean; refused?: StartRefusal }> => {
    for (const k of PASSES) delete words[k];
    // The last sleep's set-down gone before the sweep, whose clock reads it (review pass 4: the row kept its word).
    reembedLeft = false;
    if (reembedDown !== null) {
      reembedDown = null;
      stamper.aside?.(asideWord());
    }
    passEnded = new AbortController();
    let wake = AbortSignal.any([onStop.signal, passEnded.signal]);
    const stopped = async (): Promise<"stopped"> => {
      await stopPasses(hardStopped);
      return "stopped";
    };
    out(`  asleep: no live call for ${QUIET} s — ${sweeps ? "the re-derive sweep, then " : ""}extracting${FOLLOW ? "" : ", then consolidating, until the pools are drained"}${REEMBED_OK ? ", re-embed first when it has work" : ""}`);
    sleptUntil = since;
    // An audit row carries its transaction's start: a capture begun before the
    // sleep and committed after it was not visible when the brain fell asleep,
    // and is dated before. The wake reads that far back — within the quiet
    // just read, where nothing visible then can stand.
    const from = new Date(since.getTime() - Math.min(QUIET, WAKE_SLACK_S) * 1000);
    /** The sleep's clock (SMD-2679): when it began — the sweep inside it — and when it was spent, the passes soft-stopped then, or 0. */
    const began = Date.now();
    let spentAt = 0;
    budgetCut = false;
    budgetWoke = false;
    // The re-derive pass first, before the passes claim (SMD-1794's order).
    const swept = await sweep(from, began);
    if (swept === "stopped") return stopped();
    if (swept === "woken") return "woken";
    // The clock spent during the sweep: no pass starts only to be stopped (review pass 2).
    if (BUDGET_MS > 0 && Date.now() - began >= BUDGET_MS) {
      budgetKind = "clock";
      budgetFrom = from;
      // Cut work: the sweep's, or the passes' pools not drained (review passes 3 and 4: a sweep done just past the clock, or stopped after its last call, cut nothing).
      const left = sweepCut ? true : await reading(async () => (REEMBED_OK && reembedAside === null && !drained(await poolOf(sql, "reembed", JOBS.reembed, undefined, undefined, false, since))) || !drained(await poolOf(sql, "extract", JOBS.extract, SIG, stalledUnread, true, startedAt)) || !drained(await poolOf(sql, "consolidate", JOBS.consolidate)));
      if (left === null) return stopped();
      budgetCut = left;
      out(`  the sleep's budget is spent (${opts.budgetMs !== undefined ? `${BUDGET_MS} ms` : `${n.budget} min`}) during the re-derive sweep — no pass starts${FOLLOW ? "; the next sleep begins after a live call" : ""}`);
      return "budget";
    }
    /** Whether the stopped thoughts can be moved behind newer work: a restart for it is no use otherwise. */
    let reorders = await stoppedLast();
    let consolidating = false;
    /**
     * Extraction set aside while consolidation goes first (review pass 5):
     * when extraction holds only stalled thoughts, starting it would claim one
     * at once, and on a one-slot model its window held the slot the judge
     * waited for until the wake aborted it — joining past judged nothing. It
     * starts once consolidation's pool drains, so a long sleep still reaches
     * the stalled thought.
     */
    let parked = false;
    /**
     * Extraction restarted for work that landed behind a stalled thought in
     * hand (SMD-3008): the polls in a row that read it so — two, so a second
     * worker between its claims, or a capture racing the join, is not one —
     * and when it last was, at most once a minute.
     */
    let behindPolls = 0;
    let restartedAt = 0;
    const restartEvery = opts.restartEveryMs ?? RESTART_EVERY_MS;
    /** Extraction's pool as this sleep reads it: 093's stalled read, this run's claims, the claims alone when asked. */
    const extractPool = (claimsOnly = false) => poolOf(sql, "extract", JOBS.extract, SIG, stalledUnread, claimsOnly, startedAt);
    /**
     * Extraction let out of the set-aside while consolidation waits for its
     * provider — at its start, or mid-pass (providerWait) — for the
     * newer work only: its pool would not drain until the judge answered, and
     * extraction got nothing for the sleep (SMD-3008). Set aside again once it
     * reaches the stalled thought(s), which wait for consolidation as before,
     * so the judge, on the same chat endpoint, never queues behind their
     * window when it answers. Let out at most once a minute, the restart's bound.
     */
    let aside = false;
    const judgeWaits = (): boolean => waitingAtStart.has("consolidate") || waitingMidPass.has("consolidate");
    /**
     * Extraction stopped hard and taken out of the sleep's passes, for the
     * join, the restart, the let-out's set-aside and the drain's alike — a
     * cut of the scheduler's own, counted apart from the stops (101). True
     * when a stop landed while it settled: no
     * pass starts after it, nor stamps a row a second signal has ended (review
     * pass 6).
     */
    const setAside = async (): Promise<boolean> => {
      const ex = running.find((r) => r.name === "extract");
      if (ex) {
        await hardStop(ex, true);
        await ex.done.catch(() => {});
        // One whose statement timed out stays, for the poll to stop the sleep
        // on its budget: dropped here, the stop was lost (review pass 1).
        if (!ex.timedOut) running.splice(running.indexOf(ex), 1);
        // Its settling aborted the sleep's pass-ended signal, which the poll
        // waits on: re-armed, or every poll after returned at once and the
        // rest of the sleep read the database without pause (review pass 5).
        passEnded = new AbortController();
        wake = AbortSignal.any([onStop.signal, passEnded.signal]);
      }
      return stopping;
    };
    /** The claim passes' first start, as each sleep's was before re-embed ran first: false when a stop landed during its read. */
    const startClaims = async (): Promise<boolean> => {
      const firstPool = SIG === undefined ? null : await reading(() => extractPool());
      if (SIG !== undefined && firstPool === null) return false;
      if (firstPool && joinsPast(firstPool)) {
        out(`  extraction holds only ${firstPool.stalled} thought(s) that ${SLEEP_STALLED_JOIN} or more long hard stops in a row took with no window gained — consolidating first; extraction resumes once its pool drains`);
        start("consolidate");
        consolidating = true;
        parked = true;
      } else {
        start("extract");
      }
      return true;
    };
    /**
     * Re-embed set aside from now on, said and on the row — briefly at each
     * later sleep: a model switch it will not make, at a sleep's start or its
     * own refusal.
     */
    const setReembedAside = async (recorded: string): Promise<void> => {
      // The sleep's outcome reads failed while it is aside: a switch the operator mends (review pass 2).
      words.reembed = "failed";
      reembedLeft = true;
      // Said again at each sleep, briefly: each sleep's log says why re-embed did not run (review pass 3).
      if (reembedAside?.recorded === recorded) {
        out(`  re-embed set aside: the brain still records ${recorded}, this stack ${EMBED.model}`);
        return;
      }
      reembedAside = { recorded };
      err(asideLine(recorded));
      await sayReembed();
    };
    /** The row written now with re-embed's word, not at the next pass's stamp, which a reader would read past (review pass 2). */
    const sayReembed = async (): Promise<void> => {
      stamper.aside?.(asideWord());
      await stamper.alive(sleepOutcome(), malformed ?? undefined);
    };
    /**
     * The record read again finds no switch: the set-aside cleared, said, the
     * row's word gone. At a sleep's start re-embed runs in it; at a poll, the
     * next sleep with work re-embeds (review pass 4: the start said the next).
     */
    const takeUpReembed = async (recorded: string, atStart = false): Promise<void> => {
      const when = atStart ? "re-embed runs in this sleep when it has work" : "the next sleep with work re-embeds";
      out(`  re-embed's set-aside cleared: the brain ${recorded === "" ? `records no embedding model now — ${when}, and records ${EMBED.model}` : `records ${EMBED.model}, this stack's — ${when}`}`);
      reembedAside = null;
      delete words.reembed;
      await sayReembed();
    };
    /**
     * Re-embed ended by itself — or, stopped, ended otherwise than the stop
     * asks: a throw (its reason said, which the pass does not say itself:
     * review pass 2, a privilege refused read only "it ended by itself"), a
     * statement past its timeout, a 2 — a model switch sets it aside, anything
     * else sets it down for this sleep. False when a stop ended the record's read.
     */
    const reembedEnded = async (re: Running): Promise<boolean> => {
      const why = re.timedOut ? null : await re.done.then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));
      if (why !== null) err(`  reembed: ${why.split("\n")[0]}`);
      const rec = re.code === 2 && !re.timedOut ? await reading(recordedModel) : "";
      if (rec === null) return false;
      if (switched(rec)) await setReembedAside(rec);
      else {
        const refused = re.start && !re.start.ok ? re.start.refused : undefined;
        await setReembedDown(re.timedOut ? "statement" : refused && (REEMBED_DOWN as readonly string[]).includes(refused) ? (refused as ReembedDown) : re.code === 2 ? "provider" : "failed");
      }
      return true;
    };
    /**
     * Re-embed stopped and taken out of the sleep's passes — its pool drained,
     * or its provider not answering — after the thought in hand: true when a
     * stop landed meanwhile (setAside's rule). Its settling aborted the poll's
     * pass-ended signal, re-armed here.
     */
    const endReembed = async (): Promise<boolean> => {
      const re = running.find((r) => r.name === "reembed");
      if (re) {
        softStop(re);
        const threw = await re.done.then(() => false, () => true);
        // Taken out whatever it ended with; one that ended otherwise than the stop asks — a statement timeout of
        // its own, a throw, a model switch landing as its pool drained (review passes 1 and 2) — read as such.
        running.splice(running.indexOf(re), 1);
        passEnded = new AbortController();
        wake = AbortSignal.any([onStop.signal, passEnded.signal]);
        if ((re.timedOut || threw || re.code === 2) && !(await reembedEnded(re))) return true;
      }
      return stopping;
    };
    /** The words for what set re-embed down: its own lines name the cause; this says what the scheduler does about it. */
    const downCause: Record<ReembedDown, string> = {
      provider: "the embedding provider refused it (a key, credit, or the request itself)",
      model: "the embedding model is not served",
      egress: "the egress policy refuses its call",
      tables: "a table it needs is missing",
      usage: "its configuration is refused",
      statement: "a statement passed its statement_timeout — raise OB1_SLEEP_STATEMENT_TIMEOUT, or read the log for the statement",
      outage: "its provider is not answering",
      failed: "it ended by itself",
    };
    /**
     * Re-embed set down for this sleep: said, on the row; the next sleep with
     * work tries again. The sleep's outcome reads failed for a cause the
     * operator mends — a refusal, a statement timeout, a throw — so preflight's
     * row flags it before it reads `aside`; not for its provider not answering,
     * the provider's state (review pass 2).
     */
    const setReembedDown = async (kind: ReembedDown): Promise<void> => {
      reembedDown = kind;
      reembedLeft = true;
      if (kind === "outage") delete words.reembed;
      else words.reembed = "failed";
      err(`  re-embed set down for this sleep — ${downCause[kind]}; extraction and consolidation run on, and the next sleep with work tries re-embed again`);
      await sayReembed();
    };
    // Re-embed first (SMD-1794's order, SMD-2679 PR 4b): consolidation judges
    // neighbours by vector, so the vectors are made current before it runs.
    // Only when its backlog has work — an empty one starts no pass, so no
    // probe loads the embedding model for nothing — and not while a model
    // switch sets it aside; the record is read again at each sleep. A width
    // or model name that forms no key its row carries keeps re-embed out of
    // sleep whatever the record says (SMD-3486).
    const recorded = await reading(recordedModel);
    if (recorded === null) return stopped();
    if (REEMBED_OK && switched(recorded)) await setReembedAside(recorded);
    else if (reembedAside !== null) await takeUpReembed(recorded, true);
    /**
     * Re-embed's pool as this sleep reads it: the leases this process can work
     * — its own taken in this sleep, not one an earlier sleep's failed release
     * stranded, which its follower could not claim either (review pass 2).
     */
    const reembedPool = () => poolOf(sql, "reembed", JOBS.reembed, undefined, undefined, false, since);
    /** Whether re-embed's pool is this sleep's work: not set aside, not set down, its key formed. */
    const reembedRuns = (): boolean => REEMBED_OK && reembedAside === null && reembedDown === null;
    /** The claim passes due to start, re-embed having ended by itself: started after this poll's wake and clock reads (review pass 2). */
    let claimsDue = false;
    let reembedding = false;
    if (reembedRuns()) {
      const backlog = await reading(reembedPool);
      if (backlog === null) return stopped();
      if (!drained(backlog)) {
        const unlabelled = backlog.unlabelled ? ` (${backlog.unlabelled} of them unlabelled: vectors from before migration 021, which nothing vouches for)` : "";
        out(`  re-embedding ${backlog.pending + backlog.claimed + backlog.unpooled} thought(s) to ${EMBED.model} first${unlabelled} — extraction starts once that pool drains`);
        start("reembed");
        reembedding = true;
      }
    }
    if (!reembedding && !(await startClaims())) return stopped();
    for (;;) {
      if (stopping) return stopped();
      const live = await reading(() => newestLive(sql, from));
      if (live === null) return stopped();
      sleptUntil = live.now;
      // A thought held back finished in this sleep is not named until the next wake otherwise.
      if (Date.now() - heldAt >= everyMs) await sayHeld();
      if (await outsideNow()) {
        // A soft stop that landed during the reads keeps its own: the thought
        // in hand finished, not abandoned (review pass 2).
        await stopPasses(hardStopped || !stopping, !hardStopped);
        return "outside";
      }
      // A stop that landed during the reads wins: the passes it stopped have
      // settled, one waiting at its start at once (130), and would read as
      // ended by themselves — the row failed, not stopped (review pass 1). A
      // pass that throws still rejects out of the stop, the row ended failed.
      if (stopping) return stopped();
      // A statement past statement_timeout ends the sleep on its budget, before
      // anything else read in this poll: the others stop hard, a cut, and the
      // next sleep waits for a live call (SMD-2679).
      if (running.some((p) => p.timedOut && p.name !== "reembed")) {
        await stopPasses(true, true);
        err(`  the sleep stops on its budget: a pass's statement timed out${FOLLOW ? " — the next sleep begins after a live call" : ""}`);
        budgetKind = "statement";
        budgetFrom = from;
        return "budget";
      }
      // A pass that ended by itself before the wake is read first: a refusal
      // and a live call in one poll would otherwise read as the wake alone.
      // Once the clock is spent, a pass settling with the soft stop's code (0,
      // or 130 before its pass began) is that stop's doing; any other code is
      // a pass that ended by itself, as before (review pass 1).
      const ended = running.find((p) => p.settled && !(spentAt && (p.code === 0 || p.code === 130)));
      // Re-embed ending by itself ends no sleep and no scheduler (review pass
      // 1, the maintainer's choice): a model switch — refused at its start, or
      // the record moved under it (a follower exits 2 then, its start long
      // through) — sets it aside; anything else — refused at its start (its
      // kind), mid-pass (the provider refusing the request itself, 2), a
      // statement past its timeout — sets it down for this sleep. The claim
      // passes start, unless the clock is spent: then none starts.
      const reEnded = running.find((p) => p.name === "reembed" && p.settled && !(spentAt && !p.timedOut && (p.code === 0 || p.code === 130)));
      if (reEnded) {
        running.splice(running.indexOf(reEnded), 1);
        passEnded = new AbortController();
        wake = AbortSignal.any([onStop.signal, passEnded.signal]);
        if (!(await reembedEnded(reEnded))) return stopped();
        if (reembedding) {
          reembedding = false;
          claimsDue = true;
        }
        continue;
      }
      if (ended) {
        // A pass that threw rejects out of stopPasses, after the others stop,
        // so past it the pass returned a code; a 0 unasked is no success.
        await stopPasses(true, true);
        const code = ended.code || 1;
        err(`  ${ended.name} ended by itself (exit ${ended.code}) — the sleep stops`);
        return { pass: ended.name, code, started: ended.stop !== null, refused: ended.start && !ended.start.ok ? ended.start.refused : undefined };
      }
      const woke = live.write;
      if (woke !== null) {
        out(`  awake: a live write at ${woke.toISOString()} — the passes stop now, their leases returned`);
        // The tail move is a courtesy to the next sleep: a read that fails
        // (a statement timeout) leaves the claims where they are, and the
        // wake goes on.
        const held = await reading(heldHere).catch((e: Error) => {
          err(`  could not read the claims the wake leaves (${e.message}) — the next sleep takes them first again`);
          return [];
        });
        await stopPasses(true);
        if (held) await toTail(held);
        // The stops just counted (093): the row names what the wakes hold back.
        await sayHeld();
        // A wake inside the clock's grace ends a sleep that stopped on its
        // budget, and is the wake the next sleep waits for (awaitWake).
        if (spentAt) budgetWoke = true;
        return spentAt ? "budget" : "woken";
      }
      // The clock (SMD-2679): spent, the passes stop after the thought in hand
      // — every lease returned, the next sleep resuming from the claim tables —
      // and none starts. One still in hand past the grace is stopped hard, a
      // cut, as the scheduler's own stops are (101).
      if (BUDGET_MS > 0 && !spentAt && Date.now() - began >= BUDGET_MS) {
        spentAt = Date.now();
        budgetKind = "clock";
        budgetFrom = from;
        // Work left is the pools as the drain reads them — consolidation's
        // not yet enqueued included, which its pass adds only as it begins —
        // or a pass waiting for its provider, whose work is waiting too: a
        // judge outage is no idle night (review pass 3).
        const left = await reading(async () => (reembedRuns() && !drained(await reembedPool())) || !drained(await extractPool(true)) || !drained(await poolOf(sql, "consolidate", JOBS.consolidate)));
        if (left === null) return stopped();
        budgetCut = left || waitingAtStart.size > 0 || waitingMidPass.size > 0;
        const clock = opts.budgetMs !== undefined ? `${BUDGET_MS} ms` : `${n.budget} min`;
        out(budgetCut
          ? `  the sleep's budget is spent (${clock}) — the passes stop after the thought in hand${FOLLOW ? "; the next sleep begins after a live call" : ""}`
          : `  the sleep's clock is spent (${clock}) with nothing left to do — it ends${FOLLOW ? "; the next begins after a live call" : ""}`);
        for (const p of running) softStop(p);
      }
      if (spentAt) {
        if (running.every((p) => p.settled)) {
          await stopPasses(false);
          return "budget";
        }
        if (Date.now() - spentAt >= GRACE_MS) {
          err(`  ${running.filter((p) => !p.settled).map((p) => p.name).join(" and ")} still in hand ${Math.round(GRACE_MS / 1000)} s past the budget — stopped now, the thought in hand cut`);
          await stopPasses(true, true);
          return "budget";
        }
        // Each pass settling aborted the poll's wake: re-armed, or every poll
        // after returned at once (setAside's rule).
        if (passEnded.signal.aborted) {
          passEnded = new AbortController();
          wake = AbortSignal.any([onStop.signal, passEnded.signal]);
        }
        await sleepUnless(POLL * 1000, wake);
        continue;
      }
      // While aside, the record read each poll: a --switch-model run by hand
      // writes no audited row, so it wakes nothing, and the row asked for it
      // for as long as the brain stayed asleep (review pass 2).
      if (reembedAside !== null) {
        const rec = await reading(recordedModel);
        if (rec === null) return stopped();
        if (!switched(rec)) await takeUpReembed(rec);
      }
      if (claimsDue) {
        claimsDue = false;
        if (!(await startClaims())) return stopped();
      }
      // Re-embed alone first: once its pool drains, or while its provider
      // does not answer — the embedding endpoint can be down while chat
      // serves — it stops after the thought in hand and the claim passes
      // start as they would have; it tries again at the next sleep.
      if (reembedding) {
        const rp = await reading(reembedPool);
        if (rp === null) return stopped();
        const waits = waitingAtStart.has("reembed") || waitingMidPass.has("reembed");
        if (drained(rp) || waits) {
          if (drained(rp)) out("  re-embed drained — extracting");
          if (await endReembed()) return stopped();
          if (!drained(rp) && reembedDown === null && reembedAside === null) await setReembedDown("outage");
          reembedding = false;
          if (!(await startClaims())) return stopped();
        }
        await sleepUnless(POLL * 1000, wake);
        continue;
      }
      // The pools decide when consolidation joins, when extraction resumes
      // after it, and when one sleep is done — so a --follow consolidating
      // with extraction running reads none: the extraction pool's count is a
      // scan of every thought.
      if (parked) {
        const co = await reading(() => poolOf(sql, "consolidate", JOBS.consolidate));
        if (co === null) return stopped();
        if (drained(co)) {
          // Captures made while it was set aside (a sync write wakes nothing)
          // go ahead of the stalled thoughts, as the sleep's own did (review
          // pass 6: one waited out the stuck window first).
          await stoppedLast();
          // A stop that landed during the move: no pass starts after it (review pass 1).
          if (stopping) return stopped();
          out("  consolidation drained — extracting beside it, the stalled thought(s) last");
          start("extract");
          parked = false;
        } else if (judgeWaits() && reorders && Date.now() - restartedAt >= restartEvery) {
          const ex = await reading(() => extractPool(true));
          if (ex === null) return stopped();
          // Only where the stalled thoughts can be told and moved behind the
          // newer work: otherwise one is claimed first, set aside at the next
          // poll, and let out again a minute on (review pass 1).
          if (ex.stalledRead && newerWork(ex) > 0 && (reorders = await stoppedLast())) {
            if (stopping) return stopped();
            out(`  consolidation waits for its provider — extracting the ${newerWork(ex)} newer thought(s) meanwhile; the stalled thought(s) wait for consolidation`);
            // One worker, so the stalled thought is not claimed beside the
            // newer work, whose call it would hold on a one-slot model (review pass 1).
            start("extract", 1);
            parked = false;
            aside = true;
            restartedAt = Date.now();
          }
        }
      } else if (aside) {
        // Let out for the newer work while the judge waits: set aside again
        // once only stalled thoughts are in hand, or nothing is left to do;
        // once the judge answers and consolidation drains, extraction stays
        // out, as after any drain.
        const ex = await reading(() => extractPool(true));
        if (ex === null) return stopped();
        // Any stalled thought this process holds, or one it can no longer tell
        // (093 gone or refused since): a lease another left is not its own,
        // and would re-park it every minute (review pass 1).
        const stalledInHand = !ex.stalledRead || ex.stalledMine > 0;
        // (Two statements: a claim reaped between them reads more stalled
        // pending than pending, so `<=`: review pass 2.)
        if (stalledInHand || (ex.mine === 0 && newerWork(ex) <= 0)) {
          out(`  extraction ${!ex.stalledRead ? "cannot tell the stalled thought(s) now" : stalledInHand ? "has reached the stalled thought(s)" : "has done the newer work"} — set aside again until consolidation drains`);
          if (await setAside()) return stopped();
          aside = false;
          parked = true;
        } else if (!judgeWaits()) {
          const co = await reading(() => poolOf(sql, "consolidate", JOBS.consolidate));
          if (co === null) return stopped();
          // The let-out ran one worker: with more, it ends through the
          // set-aside once it holds nothing, so the drain's resume starts them
          // all, where it ran one for the rest of the sleep (review pass 2).
          if (drained(co)) {
            if (WORKERS === 1) aside = false;
            else if (ex.mine === 0) {
              if (await setAside()) return stopped();
              aside = false;
              parked = true;
            }
          }
        }
      } else if (!consolidating || !FOLLOW) {
        const pools = await reading(async () => ({ extract: await extractPool(), consolidate: consolidating ? await poolOf(sql, "consolidate", JOBS.consolidate) : null }));
        if (pools === null) return stopped();
        behindPolls = !consolidating && queuesBehind(pools.extract) ? behindPolls + 1 : 0;
        if (!consolidating && drained(pools.extract)) {
          out("  extraction drained — consolidating beside it");
          start("consolidate");
          consolidating = true;
        } else if (!consolidating && joinsPast(pools.extract) && !running.some((r) => r.name === "extract" && r.settled)) {
          // (An extraction that ended by itself during the reads is the next
          // poll's to report, not the join's to swallow: review pass 6.)
          // Only thoughts no stop has gained a window on lately are left:
          // waiting for them would hold consolidation back for as long as the
          // brain keeps waking (SMD-2694). A newer thought judged meanwhile
          // misses its pair with one of them, as consolidate.ts's header says
          // of an unextracted neighbour. Extraction, in hand with one of them,
          // is stopped and set aside until consolidation drains (review pass
          // 5); the stop counts on the thought as a cut (101, SMD-3060).
          out(`  extraction holds only ${pools.extract.stalled} thought(s) that ${SLEEP_STALLED_JOIN} or more long hard stops in a row took with no window gained — consolidating first; extraction resumes once its pool drains`);
          if (await setAside()) return stopped();
          start("consolidate");
          consolidating = true;
          parked = true;
        } else if (behindPolls >= 2 && reorders && Date.now() - restartedAt >= restartEvery && !running.some((r) => r.name === "extract" && r.settled)) {
          // Work landed behind the stalled thought(s) in hand — a capture made
          // during the sleep, dated after the move at its start — and neither
          // it nor consolidation, which joins past only an all-stalled pool,
          // would move before the window in hand ends or the brain wakes
          // (SMD-3008). Not once consolidation has joined: the stalled thought
          // has its turn then, and such a capture goes first next sleep. The
          // stop counts on the thought as a cut, not a stop: it stalls
          // nothing, and this one is stalled already (101, SMD-3060).
          out(`  extraction has only stalled thought(s) in hand, and ${newerWork(pools.extract)} newer thought(s) wait behind — extraction restarts, the stalled thought(s) after them`);
          if (await setAside()) return stopped();
          behindPolls = 0;
          restartedAt = Date.now();
          // The release keeps the stalled thought's date, this sleep's forward
          // one, so the newer work is claimed first; the move covers one dated
          // before it — a lease another process left, reclaimed with its old
          // date — and a move that fails ends the restarts, as such a thought
          // would be claimed first again (review pass 1).
          reorders = await stoppedLast();
          if (stopping) return stopped();
          start("extract");
        } else if (!FOLLOW && pools.consolidate && drained(pools.extract) && drained(pools.consolidate)) {
          out("  the pools drained — the sleep ends");
          await stopPasses(false);
          return "done";
        }
      }
      await sleepUnless(POLL * 1000, wake);
    }
  };

  /**
   * After a sleep stopped on its budget: wait for a live event since that
   * sleep's wake read began (SMD-2679) — the decision is the next sleep after
   * a wake, not after a rest — re-stamping at least every minute. True on a
   * live event; false on a stop or a follower found outside.
   */
  const awaitWake = async (after: Date): Promise<boolean> => {
    let stampedAt = Date.now();
    while (!stopping) {
      if (await outsideNow()) return false;
      const r = await reading(() => newestLive(sql, after));
      if (r === null) return false;
      if (r.write !== null) return true;
      if (Date.now() - stampedAt >= everyMs) {
        if (Date.now() - heldAt >= everyMs) await sayHeld();
        await stamper.alive();
        stampedAt = Date.now();
      }
      await sleepUnless(POLL * 1000, onStop.signal);
    }
    return false;
  };

  /** A follower found outside, awake or asleep: the start's refusal, now, the row ended on a failure. */
  const refuseOutside = async (): Promise<number> => {
    err(outsideLine(foreign, false));
    await endRow("failed", malformed ?? undefined);
    return 2;
  };

  // ── A migration seen (SMD-3379 PR 1c-1) ──────────────────────────────────
  // Each poll, the lock migrate.ts holds while it writes and the ledger's
  // newest name. Either moved since the start: the passes stop now — a stop
  // on 093, as the operator's second signal is, not the scheduler's cut — the
  // row ends without the held read, as the second signal's does, and the run
  // returns MIGRATION_EXIT for its supervisor to start it again at once: the
  // next process waits the migration out and reads its start again on the
  // schema it left. A read that fails is tried at the next.
  const watchEnd = new AbortController();
  const watching = (async () => {
    if (opts.dryRun) return;
    const wake = AbortSignal.any([onStop.signal, watchEnd.signal]);
    while (!wake.aborted) {
      await sleepUnless(POLL * 1000, wake);
      if (wake.aborted || stopping) return;
      const now = await migrationState(sql).catch(() => null);
      if (now === null || stopping || finished) continue;
      const why = now.holder !== null ? `${now.holder} holds ob1:migrate, applying migrations`
        : now.newest !== ledgerAt ? `the migration ledger moved, ${ledgerAt ?? "empty"} to ${now.newest ?? "empty"}`
        : null;
      if (why === null) continue;
      seen.migration = true;
      stopping = true;
      hardStopped = true;
      onStop.abort();
      err(`\n  ${why} — the passes stop now, their leases returned, and the scheduler exits ${MIGRATION_EXIT} for its supervisor to start it again at once, to wait the migration out and read its start again`);
      await Promise.all(running.map((p) => hardStop(p))).catch(() => {});
      await stamper.end("stopped", malformed ?? undefined).catch(() => {});
      return;
    }
  })();

  try {
    /** Refusals in a row, reset by a sleep that ends without one: the next is tried on SMD-2599's outage schedule. */
    let refusals = 0;
    for (;;) {
      const since = await awaitQuiet();
      if (foreign.length && !stopping) return refuseOutside();
      // A stop during the last read: no pass is started for it.
      if (since === null || stopping) break;
      // The row says when this sleep began, and once it is over when it ended,
      // on the database's clock (preflight's `sleep` row, SMD-2678).
      stamper.slept?.({ from: since.toISOString(), to: null });
      const r = await stamper.during(asleep(since));
      // A stop on the budget is counted and marked when it cut work: a
      // statement's always, the clock's when it found work left.
      const counted = r === "budget" && (budgetKind === "statement" || budgetCut);
      if (counted) {
        budgetStops += 1;
        sayBudget();
      }
      stamper.slept?.({ from: since.toISOString(), to: sleptUntil.toISOString(), ...(counted ? { budget: budgetKind, limit: budgetKind === "clock" ? CLOCK_MIN : n.statementTimeout } : {}) });
      // A stop that landed while the passes settled after the budget's: a stop (review pass 1).
      if (r === "budget" && stopping) {
        await endRow("stopped", malformed ?? undefined);
        return FOLLOW && !hardStopped ? 0 : 130;
      }
      // A stop that landed while the follower was found wins, as it does awake (review pass 2).
      if (r === "outside" && !stopping) return refuseOutside();
      if (r === "outside") {
        await endRow("stopped", malformed ?? undefined);
        return FOLLOW && !hardStopped ? 0 : 130;
      }
      if (r === "stopped") {
        await endRow("stopped", malformed ?? undefined);
        return FOLLOW && !hardStopped ? 0 : 130;
      }
      if (typeof r === "object") {
        // Every sleep starts its passes afresh, so each meets its start's
        // refusals again. One at the start (2 before onPass: the probe, the
        // key) by a pass that got past its start in an earlier sleep is one a
        // restart could meet as well — a model re-pulled, a 402 cleared — and
        // under --follow it is retried, the row failed meanwhile, rather than
        // ending a scheduler nothing restarts. A pass refusing at its first
        // start, or mid-pass (the provider refusing the request itself, a key
        // refused on a real call), is the configuration's, as for a follower;
        // any other code is no refusal: each ends the run (review pass 3).
        // A refusal the pass names as one no retry mends — the worker key
        // revoked, the extraction key another run switched, the tables, the
        // egress policy — ends it too, where it was retried until a restart:
        // the environment is read once, and the registry does not unrevoke
        // (SMD-2752).
        const permanent = r.refused !== undefined && PERMANENT_REFUSALS.has(r.refused);
        if (FOLLOW && r.code === 2 && !r.started && permanent) err(refusedLine(r.pass, r.refused, "no retry mends that, so the scheduler ends"));
        // One of the kinds a retry can mend, at a pass's first start in this
        // process: the configuration's, said as such (review pass 1 of PR 3 — the
        // log had only the pass's own lines).
        else if (FOLLOW && r.code === 2 && !r.started && r.refused && !begun.has(r.pass)) err(refusedLine(r.pass, r.refused, "it had not got through its start in this process, so the scheduler ends"));
        if (!FOLLOW || r.code !== 2 || r.started || permanent || !begun.has(r.pass)) {
          // A start refusal that ends it is said on the row by its kind, so
          // preflight gives its remedy, not "start it again" (SMD-2752).
          if (r.code === 2 && !r.started && r.refused) stamper.refused?.(r.refused);
          await endRow("failed", malformed ?? undefined);
          return r.code;
        }
        words[r.pass] = "failed";
        await stamper.stamp("failed", malformed ?? undefined);
        const waitMs = outageWait(refusals++);
        err(`  ${r.pass} refused at its start, which it passed earlier in this process, so the next sleep tries it again in ${waitMs / 1000} s; heartbeat:sleep reads failed meanwhile`);
        // Re-stamped through the wait, at most a minute apart: a wait of up to
        // 5 min would otherwise read stale, and preflight would ask for a
        // second scheduler beside this one (review pass 2).
        for (let left = waitMs; left > 0 && !stopping; left -= everyMs) {
          await sleepUnless(Math.min(everyMs, left), onStop.signal);
          if (!stopping) {
            await sayHeld();
            await stamper.alive("failed", malformed ?? undefined);
          }
        }
        continue;
      }
      refusals = 0;
      // A sleep none of whose passes stamped (each waited at its start for the
      // provider until the wake) says nothing of how they went: the row keeps
      // its last word — a retried refusal's failed included — rather than read
      // ok (SMD-2752 PR 3, review pass 3).
      // Waiting for a live call, said on the row with the stop (SMD-2679).
      if (r === "budget" && FOLLOW && !budgetWoke) stamper.resting?.(true);
      if (Object.keys(words).length) await stamper.stamp(sleepOutcome(), malformed ?? undefined);
      else await stamper.alive();
      // An idle clock-out is done, as a drained sleep is; a stop that cut work is not (review pass 3).
      // A one-shot sleep whose re-embed was set down or aside left its pool: not done (review passes 1 and 3).
      if (!FOLLOW) return (r === "done" || (r === "budget" && !counted)) && !reembedLeft ? 0 : 1;
      if (r === "budget") {
        const woke = await awaitWake(budgetFrom);
        stamper.resting?.(false);
        if (foreign.length && !stopping) return refuseOutside();
        if (!woke) break;
      }
    }
    await endRow("stopped", malformed ?? undefined);
    return FOLLOW && !hardStopped ? 0 : 130;
  } catch (e) {
    await stopPasses(true, true).catch(() => {});
    // Directly: the database may be what threw, and the held read would wait
    // out its connect timeout before the end did again (review pass 4). Not
    // over the watcher's end, on the way down from a migration (PR 1c-1).
    if (!seen.migration) await stamper.end("failed", malformed ?? undefined);
    throw e;
  } finally {
    finished = true;
    watchEnd.abort();
    // Its stop and the row's end finished before the run returns.
    await watching;
    opts.signal?.removeEventListener("abort", abort);
  }
}

if (import.meta.main) {
  const cli = commandLine("sleep.ts", FLAGS, { hints: HINTS });
  const url = databaseUrl(cli.value("url"));
  const quiet = cli.int("quiet", { absent: DEFAULT_QUIET_S, min: 1, max: 86_400 });
  const poll = cli.int("poll", { absent: DEFAULT_POLL_S, min: 1, max: MAX_POLL_S });
  const workers = cli.int("workers", { absent: 1, min: 1, max: MAX_WORKERS });
  const budget = cli.int("budget", { absent: DEFAULT_BUDGET_MIN, min: 0, max: MAX_BUDGET_MIN });
  const statementTimeout = cli.int("statement-timeout", { absent: DEFAULT_STATEMENT_TIMEOUT_S, min: 0, max: MAX_STATEMENT_TIMEOUT_S });
  const workMem = cli.int("work-mem", { absent: DEFAULT_WORK_MEM_MB, min: 1, max: MAX_MEM_MB });
  const maintenanceWorkMem = cli.int("maintenance-work-mem", { absent: DEFAULT_MAINTENANCE_WORK_MEM_MB, min: 1, max: MAX_MEM_MB });
  const dumpDir = cli.value("dump-dir");
  const sql = openSql(url, { max: 2, session: schedulerSession({ workMem, maintenanceWorkMem }) });
  let uninstall = () => {};
  await closeThenExit(sql, async () => {
    return run({
      sql, url, quiet, poll, workers, budget, statementTimeout, workMem, maintenanceWorkMem,
      ...(dumpDir === undefined ? {} : { dumpDir }),
      follow: cli.has("follow"),
      dryRun: cli.has("dry-run"),
      onPass: (stop) => { uninstall = stopOnSignals(stop); },
    }).finally(() => uninstall());
  });
}
