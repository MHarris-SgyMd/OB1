#!/usr/bin/env bun
/**
 * reembed.ts — re-embed every thought, in parallel, and resume where it stopped.
 *
 * The consumer that migration 015 exists for. Changing the embedding model has
 * always meant re-embedding every row — db/config.mjs says so, preflight refuses
 * a model that disagrees with the one ob1_config recorded — and until now there
 * was nothing to do it with but a script written for the occasion. This is that
 * script, kept: it walks the corpus through the claim table so several workers
 * divide the rows without overlap, a worker that dies leaves leases that expire
 * back into the pool, and a run that stops halfway is finished by running it
 * again.
 *
 * It re-embeds exactly as a capture would. The vectors come from
 * server-portable/embed.ts — the same chunking, the same blurb rule, the same
 * prompt template, the same whole-content-then-head-window fallback the server
 * uses — and the write goes through update_thought, which replaces the chunk
 * rows wholesale as an edit does. So it is also the backfill three earlier
 * changes deferred to SMD-946 by name: a long thought captured before change 27
 * gets the whole-content vector instead of its head window, and a corpus
 * captured under one OB1_CHUNK_CONTEXT setting is brought to the current one.
 *
 *   bun db/reembed.ts --url postgres://…                  # run, or resume
 *   bun db/reembed.ts --url … --status                    # where the pass stands
 *   bun db/reembed.ts --url … --dry-run                   # what a run would do; writes nothing
 *   bun db/reembed.ts --url … --switch-model              # required when the model differs from ob1_config
 *   bun db/reembed.ts --url … --job reembed:x@1024:ctx    # a backfill under the same model (keep the reembed: prefix — see "What preflight sees")
 *   bun db/reembed.ts --url … --retry-failed              # put this job's failed rows back in the pool first
 *   bun db/reembed.ts --url … --retry-fallbacks           # …and the rows stored with a head window (see Failure policy)
 *   bun db/reembed.ts --url … --accept-failed <thought-id…>   # a row the provider refuses permanently keeps its vector, and the row says so (see Saying "I know")
 *   bun db/reembed.ts --url … --accept-failed --all           # …every failed row under the job — said explicitly, since it hides an outage as well
 *   bun db/reembed.ts --url … --retire reembed:B@1024         # remove the record of a superseded pass (a switch abandoned or reverted)
 *   --workers N (2)   --batch N (8)   --ttl SECONDS (900)   --heartbeat SECONDS (60, or a third of the lease when that is shorter; at least 1, and the lease must cover two)
 *
 * The model, width and provider come from the same variables the server reads —
 * OB1_EMBEDDING_MODEL, OB1_EMBEDDING_DIM, OB1_EMBEDDING_DIMENSIONS,
 * OB1_LLM_BASE_URL, OB1_LLM_API_KEY, OB1_LLM_TIMEOUT, OB1_CHUNK_TOKENS,
 * OB1_CHUNK_OVERLAP, OB1_CHUNK_CONTEXT, OB1_METADATA_MODEL — resolved by the
 * same function.
 *
 * ── Changing model: what this does and does not cover ──────────────────────
 * SAME WIDTH ONLY. `thoughts.embedding` is vector(N) and N is baked into the
 * column, the chunk column, the HNSW indexes and the function signatures. This
 * tool refuses a configured width that differs from the column's, because a
 * width change is a schema migration that does not exist yet, not a re-embed.
 *
 * When the configured model differs from the one ob1_config records, the run
 * needs --switch-model, and the FIRST thing it does is record the new model in
 * ob1_config. From that moment preflight accepts a server configured for the
 * new model, and the server should be switched. Until the pass finishes,
 * searches mix vectors from two models, and rank accordingly. That is inherent
 * to changing model on a live corpus; the alternative, stopping the server for
 * the duration, is the operator's call. `--status` says how far along the pass
 * is, and so does preflight (below).
 *
 * ── The row says which model it is at (migration 021) ───────────────────────
 * Every vector carries the model that produced it, `thoughts.embedding_model`,
 * written by the same statement as the vector: the server's from its
 * configuration, this tool's from OB1_EMBEDDING_MODEL, passed to update_thought
 * as its eighth argument. NULL is a vector of unknown model — a row from before
 * 021 that no finished pass vouched for (021 labels the rows it has evidence
 * for), a raw INSERT, a capture from an older server — and counts as not at any
 * model; so does a row with no vector, whatever its label says. Under the
 * model's own key (`reembed:<model>@<dim>`, the default; poolModelFor in
 * config.mjs is the rule, shared with preflight) the pool is built from that
 * fact rather than from every thought: enqueue_thoughts is given the ids
 * not at the target, so a thought already at it with no row under the key is
 * finished and is never re-embedded "harmlessly" (one provider call each), and
 * "not yet in the pool" in the counts below means exactly what a run would add.
 * A --job key is a BACKFILL — a pass whose reason is not the model (a chunk
 * setting flipped, a suffix of the operator's) — and pools every thought under
 * its key, as every pass did before 021. The unlabelled rows a pool holds are
 * counted before a run: re-embedding is what labels a row nothing vouched for,
 * and on a brain that never ran a pass through 015 that is the whole corpus,
 * once. And on EVERY run, under any key, a succeeded row under this job whose
 * thought is not at the target returns to the pool — the row says done, the
 * thought says otherwise, and the data wins. Under a backfill key that means a
 * label naming another model, or no vector: an unlabelled row is left to its
 * finished row there, since 021 could label nothing from a key naming no
 * model and the first run after upgrading would otherwise return the corpus. That is what finds a thought captured or edited by a
 * server still on the old model, before or after the pass finished: until 021
 * such a row had the old vector and either no claim row or a finished one, and
 * the run could only say at its end that some rows were captured meanwhile
 * "and nothing here can tell". Failed rows are not returned by the data rule
 * (they are terminal until --retry-failed — see Failure policy) and a row
 * succeeded with a caveat is at the target (the head window is the target
 * model's vector), so neither is touched; nor is a row the operator ACCEPTED
 * (--accept-failed — see "Saying I know"), whose thought is not at the target
 * by decision, while nothing has written the thought since. `--status` and a
 * run print the corpus by model. A run requires 021: it writes the eighth argument and reads the
 * column; --status and --dry-run answer on an older schema and say so.
 *
 * That record and the pool are written in ONE transaction — the ob1_config row,
 * the rows the data rule and --retry-failed and --retry-fallbacks return, and
 * enqueue_thoughts — so a run that dies between them leaves either both or
 * neither: never a database whose record names the new model with no pool to
 * say the corpus is not at it, which nothing could tell from a fresh install
 * (SMD-1024). And a model change STARTS THIS PASS OVER: the key names the
 * target, and when the recorded model has just become that target the corpus
 * is not at it, whatever an earlier pass under the key recorded — switching
 * back to a model used before otherwise found every thought's terminal row
 * under the key, enqueued nothing, and reported nothing to do while every
 * vector was the other model's. Every FAILED row, and every lease that has
 * expired with no live holder, under THIS job returns to the pool, as if never
 * tried; a lease still running is left to its holder; the succeeded rows are
 * the data rule's — returned when, and only when, their thought is not at the
 * target, so a row already re-embedded to it is not re-embedded again on a
 * switch back (since 021; before it every terminal row returned, since nothing
 * said which rows were at the model). Under a BACKFILL key every terminal row
 * still returns on a model change, as before 021: that key's data rule trusts
 * a finished row whatever its label (021 could label nothing from a key naming
 * no model), so nothing else would re-embed a corpus whose history is under
 * `reembed:nightly` when the model changes (fourth review pass). --retry-failed
 * is therefore subsumed by a model change and --retry-fallbacks is not: a
 * caveat row is neither failed nor a lease, and is returned only when asked
 * for, on any run. Other keys of the same model are left as they
 * are: their rows are the record of their own passes, and once this pass has
 * finished the corpus is at the model again, which is what a finished row
 * under them says — returning them too would only demand a second pass over a
 * corpus already at the model (second review pass). The same start-over
 * happens when ob1_config records no model at all: nothing then says what the
 * corpus is at. A record moved by hand — an UPDATE on ob1_config around this
 * tool — is not a model change this tool can see, and does not start anything
 * over.
 *
 * A --job key that names a model or width (`reembed:<model>@<dim>[:suffix]`)
 * must name the configured one: a run under `reembed:B@d` with the shell set to
 * A would write A's vectors and record them as B's, and is refused — by a run,
 * and by --dry-run as the refusal it would make; --status reads and answers,
 * so the key preflight reports can be inspected from any shell. A key of
 * another shape cannot be judged and is accepted.
 *
 * ── What preflight sees ─────────────────────────────────────────────────────
 * A pass is UNFINISHED while any row under its key is pending, still leased or
 * failed — the rule is passUnfinished() in config.mjs, shared with
 * server-portable/preflight.ts, which reads the claim table on every start and
 * warns, in the counts printed here (formatPassCounts, the other shared
 * definition), for every unfinished key that starts with `reembed:`. The
 * record of the pass is the claim table and nothing else: no marker to clear,
 * so two processes finishing together or an operator clearing rows by hand
 * cannot leave a stale one. Succeeded rows with a caveat are finished; thoughts
 * with no row under the key and not at the key's model are reported as detail
 * while a pass is unfinished, and are what the next run adds. The rows' own
 * labels are preflight's `vector models` check, beside the claim counts: a
 * vector at another model is a warning whether or not any claim row says so.
 * --status and the end of a run say when preflight will warn, so the two never
 * disagree. A --job key without the reembed: prefix is accepted and
 * noted: preflight attributes a pass to this tool by the prefix and will not
 * report it (extraction keys are excluded on purpose — 016's trigger keeps that
 * pool fed).
 *
 * ── What the audit log sees ─────────────────────────────────────────────────
 * Nothing, for a row that already had a vector. update_thought fires 008's
 * trigger, and that trigger diffs the embedding's PRESENCE rather than its
 * value — a vector replaced by another vector is `{}` and `{}` is not an event
 * — so a full re-embed does not double thought_audit. A row that had NO vector
 * (the 2-argument fallback's shape) gains one and is audited as such, with this
 * tool as the actor. The per-thought record of the pass is the claim row.
 * db/test-live.ts [9] asserts both counts.
 *
 * Every re-embedded row's `updated_at` moves, because the row was updated. A
 * client holding an `if_unchanged_since` from before the pass gets STALE_READ
 * on its next edit, once, and refetches — the behaviour that guard exists for.
 *
 * ── Duplicates from before the fingerprint ──────────────────────────────────
 * Migration 003 added content_fingerprint without a backfill, so a brain that
 * predates it can hold two rows that normalise to the same text, both with
 * NULL fingerprints; a load that inserted into `thoughts` directly leaves the
 * same state. Re-embedding the first of such a pair gives it a fingerprint,
 * and until migration 018 update_thought then refused the second's own text as
 * DUPLICATE_CONTENT — failed, exit 1, and --retry-failed reproduced it for
 * ever (SMD-1022). 018 accepts an edit whose text normalises to what the row
 * holds, leaves that row's fingerprint NULL so the unique index is never
 * violated, and names the other row in its result. A run requires 018 (the
 * read-only --status and --dry-run do not), says per row when it found a pair,
 * and prints every group of thoughts sharing one normalised text at the end
 * and under --status — one query over the corpus hashing only the rows without
 * a fingerprint, so it stays cheap for a probe that is asked repeatedly (it
 * needs 016's function and says so on an older schema). --dry-run reports the
 * 018 refusal a run would make instead of the worker plan. Whether a pair should be one thought is the
 * operator's call; nothing is written to the claim row about it. 018's lock
 * serialises edits only: a capture of the same text committing while a worker
 * fingerprints a legacy row still raises the unique violation, which lands as
 * a failed claim naming the constraint, and --retry-failed resolves it. Since
 * migration 023 the corpus is fingerprinted once at upgrade — every legacy
 * singleton, and the oldest of each group (created_at, then id) — so a pass
 * finds NULL/fingerprinted pairs, and a NULL/NULL pair is a load that inserted
 * into `thoughts` directly since, or twins a stale holder blocked; `SELECT
 * backfill_content_fingerprints()` settles the first kind the same way, and
 * preflight's `fingerprint backfill` says when.
 * The list marks the row holding the key, and a holder whose key is stale as
 * such. Stop a pass before applying 023: its workers would wait on the table
 * lock and their leases expire.
 *
 * ── Failure policy ──────────────────────────────────────────────────────────
 * A thought the provider cannot embed is marked failed with the error and the
 * pass continues; the run exits 1 if any row is failed, still leased or still
 * pending at the end, and says which. Failed rows are terminal — a re-run does
 * not retry them — until --retry-failed returns them to the pool. A thought
 * edited between the claim and the write is re-read and re-embedded
 * (update_thought's if_unchanged_since guard reports the race rather than
 * letting the stale vector win); one deleted mid-pass is skipped, its claim row
 * gone with it.
 *
 * Whatever was embedded is always written before the outcome is decided, since
 * under --switch-model the vector already in the row is another model's. Then:
 * a long thought whose whole-content call failed transiently (429, 5xx, a lost
 * connection, the timeout) has its head window stored and its claim marked
 * failed, so --retry-failed tries the whole content again; a window whose blurb
 * failed under OB1_CHUNK_CONTEXT=on is stored bare and the claim marked failed.
 *
 * ── The head window, recorded ───────────────────────────────────────────────
 * A long thought the provider REFUSED to embed whole (a 413, or a 400 whose own
 * words name the length — hosted APIs refuse over-length input where Ollama
 * truncates it; a 400 that says nothing about length is not known to be about
 * this input and is treated as transient) has the head window's
 * vector stored, as a capture would have stored it, and its claim is succeeded:
 * the write happened and that vector is the provider's final answer. It is not
 * silent. The claim row's last_error carries the caveat, and the rule is
 * general: A SUCCEEDED ROW'S last_error, WHEN SET, IS WHAT THE WORKER COULD
 * NOT DO — the write stands, and this is what it fell short of. --status and
 * the end of a run count and list them; --retry-fallbacks returns them to the
 * pool, for the day the provider or its input limit changes (against the same
 * provider each is refused again and re-recorded, harmless). Until SMD-1021
 * such a row was indistinguishable from any other succeeded row, one line in a
 * summary was the only trace, and a terminal claim meant no re-run would ever
 * look at it again.
 *
 * For that to be a fact about THE ROW, the pass asks every long thought itself:
 * its embedder does not remember a refusal the way the server's does (one
 * probe per process on the interactive path), because a 413 is about that
 * input's length and a shorter long thought may well be accepted. One refused
 * round trip per long row, answered before any embedding is computed.
 *
 * Every provider call is bounded by OB1_LLM_TIMEOUT (120 s by default). A call
 * that never returns fails the row with the timeout named — or, on the
 * whole-content call, falls back as transient — instead of parking the worker
 * until the second signal. The lease has nothing to do with that bound since
 * migration 031 (SMD-1023): while a worker holds rows it renews every lease it
 * holds on a heartbeat — `renew_claims`, every --heartbeat seconds; db/lease.ts
 * is the one implementation the three consumers share — so the lease has to
 * outlast a missed beat, not the batch, and --ttl means one thing: how long a
 * dead worker's rows stay out of the pool. A --ttl under two heartbeats is
 * refused (a run or --dry-run; --status never claims and answers regardless)
 * with the arithmetic shown; --heartbeat not given is a third of the lease, at
 * most 60 s. Until 031 the lease was stamped per batch and could not be moved,
 * and this file grew its default to --batch × the timeout to keep a batch
 * inside it — a batch that outlived its lease was reaped mid-way and repeated
 * by another worker, and three such expiries marked a row failed although
 * every write succeeded. A row a beat finds no longer this worker's — the
 * beats stopped reaching the database for a whole lease — is skipped rather
 * than repeated, and the summary counts it.
 *
 * ── Saying "I know" ─────────────────────────────────────────────────────────
 * Preflight reports a pass unfinished while any row under its key is failed,
 * and the container runs preflight on every start. Right for a row a retry can
 * fix; endless for one the provider refuses permanently — a content filter
 * that rejects one thought on every attempt — where --retry-failed re-fails it
 * every time and the row keeps the vector it had. The over-length refusal has
 * its partial result (the head window, above); a content refusal has none, and
 * until SMD-1067 the only silencers were deleting the thought or clearing its
 * claim row by hand. --accept-failed <thought-id…> is the operator's way to
 * say "I know": the row becomes succeeded with the caveat
 * `kept the vector it had; accepted by the operator: <the failure>`
 * (ACCEPTED_CAVEAT_PREFIX in config.mjs, the one spelling both tools read) —
 * SMD-1021's rule unchanged: a succeeded row's last_error is what the worker
 * could not do, here what the operator has accepted it will not do. The row's
 * timestamps are left as the FAILURE's, and the bound below is measured from
 * claimed_at — the moment the attempt READ the content the provider refused
 * (015 stamps it at every claim and keeps it after release) — so a thought
 * edited during the attempt, or between the failure and the acceptance, is not
 * covered: that content was never tried, and the next run tries it (first
 * review pass: stamping the acceptance's time would have spoken for content the
 * caveat never described; second: so would the release's, for an edit that
 * landed while the provider was still refusing). Per row, by id; --all accepts
 * every failed row under the job and says that it hides a provider outage as
 * well as a refusal — and takes no ids beside it, since a list beside --all
 * would be read as one or the other silently. Every argument is accounted for:
 * an id after another flag, a flag this tool does not have, a flag given twice,
 * or a flag that takes a value followed by another flag, is refused rather than
 * dropped or read as the value (second and third review passes: `--job
 * --switch-model` would have backfilled the corpus under the key
 * "--switch-model"). An id that is not a failed row under this job refuses the
 * whole command, and nothing is written. So does a failed row whose thought
 * has NO vector (passed over, and said, under --all): acceptance keeps the
 * vector a row has, and a thought with none is invisible to semantic search
 * with nothing afterwards to say so — delete it, or fix its text and
 * --retry-failed. And so does a failed row whose thought was WRITTEN SINCE the
 * attempt read it and is not at the target: the acceptance would be void the
 * moment it was written — every reader applies the bound below — and the row
 * would return to the pool on the next run with the acceptance gone; the
 * content the provider refused is not the content the row has, so
 * --retry-failed tries that first (third review pass). A row whose thought IS
 * at the target — the worker wrote a head window or bare windows before the
 * row failed — is accepted whatever its timestamps: no reader needs the
 * acceptance to leave it, and the counts list it as a caveat. It needs 021's schema whole — the column and the
 * eight-argument update_thought, the same refusal a run makes: acceptance is
 * read against the label, and 021's evidence backfill trusts every succeeded
 * row under a key naming a model — it predates acceptance and, applied, is
 * never edited — so a brain that accepted rows before 021 would have them
 * labelled at a model whose pass never wrote their vector. A re-run of 021's
 * body — the remedy for a --baseline'd brain whose schema is older, below —
 * does the same to an accepted row whose thought is unlabelled, and a paste of
 * the file alone did, for anyone who followed the remedy this tool printed
 * until SMD-1193. So the re-run is the migrator's — `migrate.ts --reapply`
 * re-runs every recorded migration in one transaction — and migration 030
 * carries the corrected rule, reached after 021 in the same run and applied
 * once to every brain at upgrade: a label whose only evidence is an acceptance
 * under the model's own key goes back to unknown, and the evidence rule labels
 * with accepted rows excluded, so the latest succeeded row BEFORE an
 * acceptance decides. Any successor that labels from claim rows carries the
 * same exclusion; 030 is its spelling.
 *
 * What acceptance means to the two readers of the row, and its bound. The
 * data rule above returns a succeeded row whose thought is not at the target —
 * which an accepted row's thought is, by decision. So the data rule leaves an
 * accepted row, and preflight's `vector models` counts its vector as detail
 * ("accepted by the operator") rather than as a warning — each ONLY WHILE
 * NOTHING HAS WRITTEN THE THOUGHT SINCE THE ATTEMPT READ IT: `updated_at <=
 * claimed_at` (finished_at where a row was never claimed), the shape of the
 * bound 021 gave its backfill and the fifth review pass of SMD-1068 gave the
 * data rule under a backfill key. An edit, or a re-capture, is a new question, and
 * the row returns to the pool as any moved row does (a metadata-only edit
 * reopens it too: one evidence rule, not two). Preflight counts an acceptance
 * only under the OWN key of the model it judges against, the recorded one
 * (config.mjs's ACCEPTED_BY_MODEL_SQL says why not a backfill key of that
 * model): an acceptance under B's key says "stays where it is while the
 * corpus moves to B", and after a move to C it says nothing — C's own pass has
 * no row for the thought, pools it, and it is accepted under C's key or not.
 * The claim table may lower that warning because the acceptance IS the
 * operator's word about exactly those vectors; clear the table and the warning
 * returns, which is right — the acknowledgement was deleted. Everything else
 * sees an accepted row as the succeeded row it is: enqueue_thoughts skips it
 * by primary key, --retry-failed does not see it, a model change under the
 * model's own key restarts failed rows and expired leases and leaves it (under
 * a backfill key every terminal row restarts, accepted included, as before),
 * and --retry-fallbacks returns it like any caveat — which spends the
 * acceptance: requeue clears last_error, a second refusal fails the row again,
 * and the operator accepts again or not. A caveat describes the pass's write;
 * a later capture by the server does not clear it, and --status lists it until
 * --retry-fallbacks costs one call to find out (true of the head window's
 * caveat since SMD-1021).
 *
 * --retire <key> removes the rows of a SUPERSEDED pass — a key whose
 * `reembed:<model>@<dim>` is not the recorded model (a switch abandoned or
 * reverted), the recorded model at another width (which nothing can complete),
 * or a `reembed:` key naming no model (an abandoned backfill) — as the remedy
 * preflight prints in place of the hand DELETE it printed before. Refused, with
 * nothing written: a key without the reembed: prefix (another tool's pass), a
 * key naming the recorded model — or this shell's, when nothing is recorded —
 * at the recorded width (the column's, when no width is recorded), suffix or
 * not, whose pass can be finished or its failed rows accepted, a key with a
 * live lease (a pass under it is running), and a key with no rows (a typo is
 * the likelier cause). The width judged by is the COLUMN's, before any record: a pass runs
 * at the column's width and no other, so a record that disagrees with the
 * column (a hand edit, a restore from another brain) must not make the one
 * finishable key superseded (third review pass). The lease check and the
 * DELETE are one transaction with the key's rows locked, the DELETE takes
 * exactly the rows the check locked, and the record's row is read FOR UPDATE
 * inside it — so a claim taken meanwhile is not lost under it, and a
 * --switch-model back to that model either commits first and is seen, or
 * waits (first to third review passes). The corpus line printed after, judged
 * against the current model, says what the rows still are: the record of the
 * pass is gone, the vectors it wrote are not, and `vector models` reports them
 * until they are re-embedded.
 *
 * Both are maintenance modes like --status: they need the claim table and
 * nothing else — no provider, no model recorded — and refuse to be combined
 * with each other or with --status, --switch-model, --retry-failed or
 * --retry-fallbacks (one thing at a time); --dry-run says what either would
 * do. --accept-failed is refused from a shell whose model is not the recorded
 * one: the failed rows under this shell's key are a pass that has not recorded
 * itself — run it with --switch-model, and accept what it leaves.
 */

import { SQL } from "bun";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import {
  ACCEPTED_BY_MODEL_SQL,
  REAPPLY_COMMAND,
  REQUEUE_SET_SQL,
  ACCEPTED_CAVEAT_PREFIX,
  CORPUS_BY_MODEL_SQL,
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  embeddingConfigWarnings,
  formatPassCounts,
  parseReembedKey,
  type PassCounts,
  passUnfinished,
  poolModelFor,
  REEMBED_KEY_PREFIX,
  reembedKey,
  summariseCorpusByModel,
  UPDATE_THOUGHT_SIGNATURE,
  validateEmbeddingConfig,
} from "./config.mjs";
import { createEmbedder, PROVIDER_ERROR_CHARS, resolveEmbedConfig } from "../server-portable/embed.ts";
import { UUID_RE } from "../server-portable/store.ts";
import { DEFAULT_HEARTBEAT_S, DEFAULT_TTL_S, describeHolder, describeLoss, heartbeatFor, leaseHolders, leaseRefusal, lostReason, startHeartbeat } from "./lease.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);
/** What each flag takes — one value, any number, none — for the scanner below; flag(), has() and values() read by it. */
const TAKES_ONE = new Set(["url", "workers", "batch", "ttl", "heartbeat", "job", "retire"]);
const TAKES_MANY = new Set(["accept-failed"]);
const TAKES_NONE = new Set(["status", "dry-run", "switch-model", "retry-failed", "retry-fallbacks", "all"]);
const numberFlag = (name: string, fallback: number, min: number): number => {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    console.error(`--${name} must be an integer >= ${min}, got "${raw}"`);
    process.exit(2);
  }
  return n;
};

const url = flag("url") ?? process.env.DATABASE_URL;
if (!url) {
  console.error("No database URL. Pass --url or set DATABASE_URL.");
  process.exit(2);
}

const WORKERS = numberFlag("workers", 2, 1);
const BATCH = numberFlag("batch", 8, 1);
const STATUS_ONLY = has("status");
const DRY_RUN = has("dry-run");
const SWITCH_MODEL = has("switch-model");
const RETRY_FAILED = has("retry-failed");
const RETRY_FALLBACKS = has("retry-fallbacks");
/** The values after a flag, up to the next flag: `--accept-failed <id> <id>`. */
const values = (name: string): string[] => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return [];
  const out: string[] = [];
  for (let k = i + 1; k < args.length && !args[k].startsWith("--"); k++) out.push(args[k]);
  return out;
};
const ACCEPT_FAILED = has("accept-failed");
const ACCEPT_IDS = values("accept-failed");
const ACCEPT_ALL = has("all");
const RETIRE = has("retire");
const RETIRE_KEY = flag("retire");
// One thing at a time — see "Saying I know": the two maintenance modes write
// claim rows, not vectors, and combine with nothing but --dry-run.
{
  const modes = [STATUS_ONLY && "--status", ACCEPT_FAILED && "--accept-failed", RETIRE && "--retire"].filter(Boolean) as string[];
  const runFlags = [SWITCH_MODEL && "--switch-model", RETRY_FAILED && "--retry-failed", RETRY_FALLBACKS && "--retry-fallbacks"].filter(Boolean) as string[];
  if (modes.length > 1 || ((ACCEPT_FAILED || RETIRE) && runFlags.length > 0)) {
    console.error(`  ${[...modes, ...runFlags].join(" and ")} do not combine — one thing at a time (--dry-run combines with any one of them).`);
    process.exit(2);
  }
  if (RETIRE && (RETIRE_KEY === undefined || RETIRE_KEY.startsWith("--"))) {
    console.error("  --retire needs the key to retire: --retire reembed:<model>@<dim>[:suffix] — preflight prints it.");
    process.exit(2);
  }
  if (ACCEPT_ALL && !ACCEPT_FAILED) {
    console.error("  --all belongs to --accept-failed.");
    process.exit(2);
  }
}
// Every argument accounted for: an id after another flag, or a flag this tool
// does not have, is refused rather than dropped — `--accept-failed a --dry-run
// b` would otherwise accept one row and exit 0 (second review pass).
{
  const stray: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) { stray.push(a); continue; }
    const name = a.slice(2);
    // Once: flag() and values() read the first occurrence, and a second
    // would otherwise be consumed here and done nothing (third review pass).
    if (seen.has(name)) {
      console.error(`  --${name} is given twice — once, with everything it takes after it.`);
      process.exit(2);
    }
    seen.add(name);
    if (TAKES_ONE.has(name)) {
      // The value must be one: `--job --switch-model` read "--switch-model" as
      // the key and backfilled the corpus under it (third review pass).
      if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
        console.error(`  --${name} needs a value; what follows it is ${args[i + 1] ?? "nothing"}.`);
        process.exit(2);
      }
      i += 1;
    } else if (TAKES_MANY.has(name)) while (i + 1 < args.length && !args[i + 1].startsWith("--")) i++;
    else if (!TAKES_NONE.has(name)) stray.push(a);
  }
  if (stray.length) {
    console.error(`  not understood: ${stray.join(" ")} — ids go right after --accept-failed, and the flags are listed in the header of db/reembed.ts.`);
    process.exit(2);
  }
}
/** The pass and its target. See migration 015's header on why the target is in the key. */
const JOB = flag("job") ?? reembedKey(EMBEDDING_MODEL, EMBEDDING_DIM);
/** Whether preflight will attribute this key to the tool — see "What preflight sees". */
const PREFLIGHT_SEES = JOB.startsWith(REEMBED_KEY_PREFIX);
if (!PREFLIGHT_SEES) {
  // Accepted — rows under an existing bare key must stay reachable — but said
  // once: preflight attributes a pass to this tool by the prefix.
  console.error(`  ⚠  --job ${JOB}: preflight will not report this pass unfinished — its key does not start with ${REEMBED_KEY_PREFIX}`);
}
// A key that names a model must name this one — see "Changing model" in the
// header. Judged from the same variables the embedder resolves; refused where
// the other refusals are, so --status still answers and --dry-run reports it.
const refusalJob: string | null = (() => {
  const named = parseReembedKey(JOB);
  if (!named || (named.model === EMBEDDING_MODEL && named.dim === EMBEDDING_DIM)) return null;
  return (
    ` --job ${JOB} names a pass to ${named.model} @ ${named.dim}, but this shell is configured for ${EMBEDDING_MODEL} @ ${EMBEDDING_DIM}:\n` +
    `  the run would write ${EMBEDDING_MODEL}'s vectors and record them as ${named.model}'s. Set OB1_EMBEDDING_MODEL and\n` +
    `  OB1_EMBEDDING_DIM to what the key names, or drop --job.`
  );
})();

// ── Configuration ───────────────────────────────────────────────────────────

const problems = validateEmbeddingConfig();
if (problems.length > 0) {
  console.error("Embedding configuration is not usable:\n");
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(2);
}
for (const w of embeddingConfigWarnings()) console.error(`  ⚠  ${w}`);

const embedConfig = resolveEmbedConfig(process.env);
// Not remembering a refusal: see "The head window, recorded" in the header.
const embedder = createEmbedder(() => embedConfig, { rememberRefusal: false });

// The lease is renewed on a heartbeat while the worker holds rows — see the
// header — so it has to outlast a missed beat, not the batch; db/lease.ts
// holds the rule the three consumers share. Whole seconds: claim_thoughts and
// renew_claims take ints.
const TTL = numberFlag("ttl", DEFAULT_TTL_S, 1);
const HEARTBEAT = flag("heartbeat") === undefined ? heartbeatFor(TTL) : numberFlag("heartbeat", DEFAULT_HEARTBEAT_S, 1);
// Read-only modes never claim, so they answer whatever the lease; --dry-run
// reports the refusal a run would make, alongside the 018 check below.
const refusalTtl: string | null = (() => {
  const r = leaseRefusal(TTL, HEARTBEAT, flag("heartbeat") === undefined);
  return r === null ? null : ` ${r}`;
})();

console.log(`  job:       ${JOB}`);
console.log(`  embedding: ${embedConfig.embeddingModel} @ ${embedConfig.embeddingDim} dimensions, via ${embedConfig.llmBase}, ${embedConfig.timeoutMs / 1000} s per call`);
console.log(`  chunks:    ${embedConfig.chunkTokens}-token windows above ${embedConfig.chunkThreshold} (${embedConfig.chunkTokensFrom === "window" ? `from ${embedConfig.embeddingModel}'s ${embedConfig.modelWindow}-token window` : embedConfig.chunkTokensFrom === "OB1_CHUNK_TOKENS" ? "OB1_CHUNK_TOKENS" : "the default, window unknown"}), overlap ${embedConfig.chunkOverlap}, context ${embedConfig.chunkContext ? "on" : "off"}`);

// One connection per worker and one spare: the heartbeat (db/lease.ts) beats
// through the pool, and a worker parked on a lock or a long statement holds
// its own connection, so the spare is what keeps every worker's leases alive
// then. Tightening this to WORKERS would recreate the lapse 031 removed.
const sql = new SQL({ url, max: WORKERS + 1 });

// ── The database's side of the contract ─────────────────────────────────────

const [claims] = await sql`SELECT to_regclass('thought_work_claims') IS NOT NULL AS present`;
if (!claims.present) {
  console.error("\n  thought_work_claims does not exist. Apply migration 015 first:\n    cd db && bun migrate.ts --url …");
  await sql.close();
  process.exit(2);
}

const [col] = await sql`
  SELECT atttypmod AS width FROM pg_attribute
  WHERE attrelid = 'thoughts'::regclass AND attname = 'embedding'`;
if (Number(col?.width) !== embedConfig.embeddingDim) {
  console.error(
    `\n  thoughts.embedding is vector(${col?.width}) but OB1_EMBEDDING_DIM=${embedConfig.embeddingDim}.\n` +
      `  This tool re-embeds at the column's width. A width change is a schema migration —\n` +
      `  the column, thought_chunks.embedding, both HNSW indexes and every function that\n` +
      `  names vector(${col?.width}) — and no migration for it exists yet. Set OB1_EMBEDDING_DIM=${col?.width}\n` +
      `  (with OB1_EMBEDDING_DIMENSIONS=on for a model that is wider natively) or stop here.`
  );
  await sql.close();
  process.exit(2);
}

const recorded = Object.fromEntries(
  ((await sql`SELECT key, value FROM ob1_config WHERE key IN ('embedding_model', 'embedding_dim')`) as { key: string; value: string }[])
    .map((r) => [r.key, r.value])
);
const modelChange = recorded.embedding_model !== undefined && recorded.embedding_model !== embedConfig.embeddingModel;
/** The run records the model — a change, or no record to compare with — and starts every pass to it over. */
const recordModel = modelChange || recorded.embedding_model === undefined;
// The retry flags select subsets of the rows recording the model returns anyway.
// --retry-failed selects a subset of the rows the start-over returns on a
// model change; --retry-fallbacks does not (since 021 the start-over returns
// failed rows and expired leases, and a caveat row is neither — second review
// pass), so it is honoured on every run.
const retryFailed = RETRY_FAILED && !recordModel;
const retryFallbacks = RETRY_FALLBACKS;
if (recorded.embedding_model === undefined) {
  console.log(`  ob1_config records no embedding model (migration 006 not applied?); the pass will record ${embedConfig.embeddingModel}`);
} else if (modelChange) {
  console.log(`  model change: ob1_config records ${recorded.embedding_model}; this pass embeds with ${embedConfig.embeddingModel}`);
} else if (poolModelFor(JOB) === null) {
  console.log(`  same model as ob1_config records — a backfill under ${JOB}: every thought without a row under it is pooled`);
} else if (parseReembedKey(JOB) !== null && parseReembedKey(JOB)!.model !== embedConfig.embeddingModel) {
  // --status for a key naming another model (a run is refused below): the
  // counts are the key's, not this shell's, and say so.
  console.log(`  --job ${JOB} names ${parseReembedKey(JOB)!.model}: the counts below are judged against it, not this shell's ${embedConfig.embeddingModel}`);
} else {
  console.log(`  same model as ob1_config records — this run pools the rows not at it; a same-model backfill over every row is --job ${JOB}:<suffix>`);
}
// The --job refusal first: a key naming another model is refused before the
// model-change refusal below can ask for --switch-model on its behalf.
if (refusalJob && !STATUS_ONLY && !DRY_RUN && !RETIRE && !ACCEPT_FAILED) {
  console.error(`\n ${refusalJob}`);
  await sql.close();
  process.exit(2);
}
if (modelChange && !SWITCH_MODEL && !STATUS_ONLY && !DRY_RUN && !RETIRE && !ACCEPT_FAILED) {
  console.error(
    `\n  Refusing to re-embed with a model other than the one ob1_config records without --switch-model.\n` +
      `  Every vector in the corpus would be replaced by ${embedConfig.embeddingModel}'s, and ob1_config\n` +
      `  would be updated so preflight accepts a server configured for it. If that is the intent:\n` +
      `    OB1_EMBEDDING_MODEL=${embedConfig.embeddingModel} bun db/reembed.ts --url … --switch-model\n` +
      `  If OB1_EMBEDDING_MODEL is simply set wrong in this shell, fix it instead.`
  );
  await sql.close();
  process.exit(2);
}

// The schema the pass writes to. The body the pass will CALL — the exact
// eight-argument signature (021), as preflight resolves match_thoughts, not any
// function of that name — is asked for 018's contract sentinel: a marker in
// pg_proc.prosrc, which every CREATE OR REPLACE rewrites, rather than a field
// name a comment could carry (a pass against 013's update_thought fails every
// legacy twin for ever — see the header). And the column the pass reads and
// writes, thoughts.embedding_model (021). The ledger decides the remedy: a
// brain adopted with --baseline records 021 as applied while the body is
// older, and "apply 021" would be a no-op there. Read here so --dry-run can
// report the refusal a run would make; --status is answered whatever the
// schema, since it never calls update_thought.
const [fn] = await sql`
  SELECT
    EXISTS (SELECT 1 FROM pg_proc
            WHERE oid = to_regprocedure(${"public." + UPDATE_THOUGHT_SIGNATURE})
              AND prosrc LIKE '%ob1:unchanged-edit-not-duplicate%') AS present,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'thoughts' AND column_name = 'embedding_model') AS labelled,
    to_regclass('schema_migrations') IS NOT NULL AS has_ledger`;
// Asked separately: a relation named in a statement is resolved when the
// statement is parsed, whatever the AND before it would have short-circuited,
// so a schema applied by hand — no ledger — must not be asked about its ledger.
fn.ledgered = fn.has_ledger ? (await sql`SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name LIKE '021%') AS l`)[0].l : false;
/** Whether thoughts.embedding_model exists — the read-only modes answer without it. */
const HAS_LABEL: boolean = Boolean(fn.labelled);
const refusal021: string | null = fn.present && fn.labelled
  ? null
  : ` ${fn.labelled ? "update_thought" : "the schema"} predates migration 021: this pass writes the model beside every vector it stores and builds\n` +
    "  its pool from the rows not at that model, which needs thoughts.embedding_model and the eight-argument update_thought\n" +
    "  (which carries 018's rule, without which a pair from before the fingerprint fails on every run). " +
    (fn.ledgered
      ? `schema_migrations records 021 as\n  applied (--baseline?) but the schema installed is older. Re-apply the recorded migrations with the migrator: it re-runs\n  every migration, pending ones included, in one transaction — 021's backfill as written, then 030, which returns a label\n  whose only evidence is an operator's acceptance to unknown (a paste of 021's body alone leaves it labelled at that key's\n  model). Run it from a shell configured as this brain is, with the server and every worker stopped:\n    ${REAPPLY_COMMAND}`
      : "Apply migration 021 first:\n    cd db && bun migrate.ts --url …");
/**
 * What a run would refuse on, in the order a run judges them — the job, the
 * lease, the schema — spelled once for --status, --dry-run and the run.
 */
const refusalForRun: string | null = refusalJob ?? refusalTtl ?? refusal021;

// ── Where the pass stands ───────────────────────────────────────────────────

/**
 * The caveat rule as a predicate — see "The head window, recorded" in the
 * header. One definition for the count, the list and --retry-fallbacks, so the
 * three cannot disagree about which rows carry a caveat.
 */
const withCaveat = () => sql`status = 'succeeded' AND last_error IS NOT NULL`;

/**
 * The rows a model change returns to the pool — see "Changing model" in the
 * header: every terminal row, and every lease expired with no live holder,
 * under this job. One definition for --dry-run's count and the run's UPDATE.
 */
const staleUnderThisJob = () =>
  BACKFILL
    ? sql`status IN ('succeeded', 'failed') OR (status = 'claimed' AND ttl_expires_at < now())`
    : sql`status = 'failed' OR (status = 'claimed' AND ttl_expires_at < now())`;

/**
 * How this key pools — see "The row says which model it is at" in the header.
 * poolModelFor (config.mjs, shared with preflight) names the model a model's
 * own key pools against and null for a backfill key, which pools every
 * thought. The target the rows are judged against is the KEY's model where it
 * names one — for a run that is the configured model, since a --job naming
 * another model is refused; --status answers for any key, and counts as
 * preflight does for it — and this shell's model otherwise.
 */
const POOL_MODEL = poolModelFor(JOB);
const BACKFILL = POOL_MODEL === null;
// The key's model wherever it names one — an own-shape key or a suffixed one
// (`reembed:y@1024:ctx` is a pass to y, as 021's backfill reads it) — so
// --status for any foreign key is judged against that key's model; this shell's
// otherwise. A run under a foreign key is refused above.
const TARGET = parseReembedKey(JOB)?.model ?? embedConfig.embeddingModel;

/**
 * "Not at the target": the row has no vector, or its label differs from the
 * target, NULL (unknown) included — see "The row says which model it is at"
 * in the header. One definition for the pool, the data rule and the counts.
 */
const notAtTarget = () => sql`(embedding IS NULL OR embedding_model IS DISTINCT FROM ${TARGET})`;
/** What the pool is built from: every thought for a backfill, the rows not at the target otherwise. */
const poolable = () => (BACKFILL ? sql`true` : notAtTarget());

/**
 * The data rule — a succeeded row under this job whose thought is not at the
 * target. Returned to the pool on every run: the row says done, the thought
 * says otherwise. Failed rows are left to --retry-failed. A row succeeded with
 * a caveat is at the target unless its thought has since moved, in which case
 * this rule takes it and --retry-fallbacks has nothing left to return — the
 * run requeues in that order, and --dry-run counts the caveats it would still
 * find (caveatsAtTarget) rather than every caveat.
 */
/**
 * Under a backfill key an UNLABELLED thought is left to its finished row: 021
 * could label nothing from a key naming no model, so after upgrading every
 * such row is NULL, and treating NULL as "moved" there would return the whole
 * corpus on the first run (third review pass). A backfill's reason is not the
 * model; only a label that names another model, or no vector, says its
 * finished row is wrong. Under the model's own key NULL is not at the target —
 * 021 labelled what it had evidence for, and what is left has none.
 */
const doneButNotAtTarget = () =>
  // An ACCEPTED row is left, under either key shape, by the same bound: the
  // operator's word holds while nothing has written the thought since the
  // failed attempt read it (updated_at <= claimed_at; finished_at for a row
  // never claimed); an edit is a new question — "Saying I know".
  sql`status = 'succeeded' AND EXISTS (
        SELECT 1 FROM thoughts x WHERE x.id = thought_id
          AND NOT ((${accepted()}) AND ${standingBound()})
          AND ${BACKFILL
            ? // The trust is bounded by 021's own evidence rule: a finished row
              // vouches for an unlabelled thought only while nothing has written
              // the row since — a NULL beside a row written since is a later
              // foreign write, not a pre-021 pass (fifth review pass).
              sql`(x.embedding IS NULL
                   OR (x.embedding_model IS NOT NULL AND x.embedding_model <> ${TARGET})
                   OR (x.embedding_model IS NULL AND x.updated_at > finished_at))`
            : // notAtTarget()'s columns are unqualified, and name x's here: the
              // claim row has none of them.
              notAtTarget()})`;
const caveatsAtTarget = () => sql`${withCaveat()} AND NOT (${doneButNotAtTarget()})`;
/**
 * An accepted row — see "Saying I know": a succeeded row whose caveat is the
 * operator's. Recognised by the prefix config.mjs spells once for both tools.
 */
const accepted = () => sql`status = 'succeeded' AND last_error IS NOT NULL AND starts_with(last_error, ${ACCEPTED_CAVEAT_PREFIX})`;
/**
 * The bound an acceptance stands within: the thought `x` written no later than
 * the claim row's attempt read it. Named for a thought aliased x beside an
 * unaliased claim row, which is how every reader here joins the two; config.mjs
 * spells it once more for preflight and the corpus query, where the aliases
 * differ. See "Saying I know".
 */
const standingBound = () => sql`COALESCE(x.updated_at, x.created_at) <= COALESCE(claimed_at, finished_at, '-infinity'::timestamptz)`;
/**
 * …and STANDING: nothing has written the thought since the failed attempt
 * read it — claimed_at, not the release's finished_at, which an edit during a
 * slow refusal would have hidden behind (second review pass); a hand-written
 * row with neither timestamp is never standing rather than NULL, which no
 * reader would have counted and the data rule would never have returned
 * (third review pass). The counts use
 * this form, so they cannot call a row accepted that the data rule and
 * preflight no longer treat as such (first review pass).
 * `last_error IS NOT NULL` above is not decoration: starts_with(NULL, …) is
 * NULL, and a NOT around it inside the data rule turned every ordinary
 * succeeded row's predicate NULL — false — for a row whose thought moved
 * before its claim was released (first review pass).
 */
const standingAcceptance = () =>
  sql`${accepted()} AND EXISTS (SELECT 1 FROM thoughts x WHERE x.id = thought_id AND ${standingBound()})`;

/**
 * Return this job's rows a predicate selects to the pool as if never tried:
 * pending, nothing known about them, attempt count reset, no lease — the next
 * worker writes what it finds. A terminal row's error or caveat goes with its
 * status; the last holder's name stays for diagnosis. An expired lease whose
 * holder is in fact still alive releases into a row that is no longer its own,
 * hears false, and says so — the path an expired lease always had. Returns how
 * many, for the caller to print once the transaction it ran in has committed.
 */
async function requeue(tx: SQL, where: ReturnType<typeof withCaveat>): Promise<number> {
  const [{ n }] = await tx`
    WITH retried AS (
      UPDATE thought_work_claims
         SET ${tx.unsafe(REQUEUE_SET_SQL)}
       WHERE work_type = ${JOB} AND (${where}) RETURNING 1)
    SELECT count(*)::int AS n FROM retried`;
  return Number(n);
}

async function counts(): Promise<PassCounts> {
  // One statement, so the caveat count is a subset of the succeeded count it
  // qualifies — --status is asked while workers release rows.
  const rows = (await sql`
    SELECT status, count(*)::int AS c, count(*) FILTER (WHERE last_error IS NOT NULL)::int AS noted,
           count(*) FILTER (WHERE ${standingAcceptance()})::int AS accepted
    FROM thought_work_claims WHERE work_type = ${JOB} GROUP BY status`) as { status: string; c: number; noted: number; accepted: number }[];
  const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.c)]));
  const done = rows.find((r) => r.status === "succeeded");
  const fellBack = Number(done?.noted ?? 0);
  // "Not yet in the pool" is what a run would add: with 021's column and the
  // model's own key, the thoughts not at the target with no row under the key;
  // under a backfill key, or before 021, every thought with no row.
  const [{ unpooled, thoughts }] = await sql`
    SELECT count(*)::int AS thoughts,
           count(*) FILTER (WHERE ${HAS_LABEL ? poolable() : sql`true`} AND NOT EXISTS (
             SELECT 1 FROM thought_work_claims c WHERE c.thought_id = t.id AND c.work_type = ${JOB}))::int AS unpooled
    FROM thoughts t`;
  return {
    pending: by.pending ?? 0,
    claimed: by.claimed ?? 0,
    succeeded: by.succeeded ?? 0,
    fellBack: Number(fellBack),
    accepted: Number(done?.accepted ?? 0),
    failed: by.failed ?? 0,
    unpooled: Number(unpooled),
    thoughts: Number(thoughts),
  };
}

function printCounts(c: PassCounts, label: string): void {
  console.log(`  ${label}: ${formatPassCounts(c)}`);
}

/**
 * The corpus by the model its vectors carry (021) — the fact preflight's
 * `vector models` check reads, printed where the claim counts are so an
 * operator sees the rows and the record of the pass side by side. Rows with no
 * vector are counted apart: they are not at any model and the pass gives them
 * one. A vector at another model whose thought the operator accepted, and has
 * not written since, is detail — "Saying I know" — and `unaccepted` is what a
 * warning counts. Before 021 there is nothing to read, and the line says so.
 */
async function printCorpusByModel(against: string = TARGET): Promise<{ unaccepted: number; noneAt: boolean }> {
  if (!HAS_LABEL) {
    console.log("  corpus:    the rows carry no model (migration 021 not applied)");
    return { unaccepted: 0, noneAt: false };
  }
  // The queries and the arithmetic are config.mjs's, shared with preflight.
  // Against the target the counts are judged against — the key's model where
  // it names one (--status for a foreign key), this shell's otherwise.
  const rows = (await sql.unsafe(CORPUS_BY_MODEL_SQL)) as { model: string | null; c: number }[];
  // Acceptances under the target's OWN key, asked only when there is a vector
  // at another model to explain — the scan joins the corpus to the claims.
  const acceptedRows = rows.some((r) => r.model !== null && r.model !== against)
    ? (await sql.unsafe(ACCEPTED_BY_MODEL_SQL, [reembedKey(against, embedConfig.embeddingDim), ACCEPTED_CAVEAT_PREFIX])) as { model: string | null; accepted: number }[]
    : [];
  const { at, unlabelled, others, otherCount, acceptedCount, unaccepted } = summariseCorpusByModel(rows, against, acceptedRows);
  const [{ n: noVector }] = await sql`SELECT count(*)::int AS n FROM thoughts WHERE embedding IS NULL`;
  console.log(
    `  corpus:    ${at} at ${against}` +
      (others.length
        ? `, ${otherCount} at another model (${others.map((r) => `${r.model}: ${r.c}`).join(", ")})` +
          (acceptedCount ? `, ${acceptedCount} of them accepted by the operator` : "")
        : "") +
      (unlabelled ? `, ${unlabelled} unlabelled (model unknown)` : "") +
      (Number(noVector) ? `, ${noVector} without a vector` : "")
  );
  // Preflight's other warning: NO vector known to be at the model — every
  // vector unlabelled, or accepted at another model (second review pass).
  return { unaccepted, noneAt: unaccepted === 0 && at === 0 && unlabelled + otherCount > 0 };
}

/**
 * The unlabelled rows this run pools — no evidence of their model, so the
 * pass is what labels them, and on a brain that never ran a pass through 015
 * that is the whole corpus. Said before the workers start so the cost is not a
 * surprise. Once the start transaction has built the pool the count is read
 * from it (the pending rows); before it (--dry-run) it is what the start would
 * pool, by the start's own predicates — a thought with no row that the pool
 * takes, or a row one of the requeue rules returns (second and fourth review
 * passes: two hand-inverted copies of those rules each counted rows the run
 * never touched).
 */
async function unlabelledPooled(pooled: boolean): Promise<number> {
  if (!HAS_LABEL) return 0;
  const [{ n }] = await sql`
    SELECT count(*)::int AS n FROM thoughts t
    WHERE t.embedding IS NOT NULL AND t.embedding_model IS NULL
      AND ${pooled
        ? sql`EXISTS (SELECT 1 FROM thought_work_claims c WHERE c.thought_id = t.id AND c.work_type = ${JOB} AND c.status = 'pending')`
        : sql`((${poolable()} AND NOT EXISTS (SELECT 1 FROM thought_work_claims c WHERE c.thought_id = t.id AND c.work_type = ${JOB}))
               OR EXISTS (SELECT 1 FROM thought_work_claims c WHERE c.thought_id = t.id AND c.work_type = ${JOB}
                          AND (c.status = 'pending'
                               OR (${doneButNotAtTarget()})
                               OR (${recordModel} AND (${staleUnderThisJob()}))
                               OR (${retryFailed} AND c.status = 'failed')
                               OR (${retryFallbacks} AND (${withCaveat()})))))`}`;
  return Number(n);
}

/**
 * What preflight will say until the pass finishes — the same rule and the same
 * phrase (config.mjs) for the claim counts, so an operator reading either sees
 * one account — and, since 021, what its `vector models` line will say about
 * the rows: vectors at another model are a warning there whether or not any
 * claim row remembers them — except those the operator accepted, which are
 * detail there as here — and a corpus with NO vector known to be at the model,
 * accepted or unlabelled as its vectors may be, is a warning there too
 * (second review pass: the first note alone missed it). Preflight judges the rows against the RECORDED
 * model, this tool against its own, so the second note is given only when the
 * two agree AS THEY STAND — after a run that recorded the model they do,
 * whatever they did before it (second review pass); when they do not,
 * preflight's embedding-contract line already says so. Printed under --status
 * and at the end of a run; a --dry-run describes a run, not the state, and
 * says nothing here.
 */
/** Whether the rows here are judged against the model preflight judges by — the record, as it stands (after this run recorded it, or as found). */
const judgedAsPreflight = (afterRecord: boolean) => TARGET === (afterRecord ? embedConfig.embeddingModel : recorded.embedding_model);
function printPreflightNote(c: PassCounts, corpus: { unaccepted: number; noneAt: boolean }, recordAgrees: boolean): void {
  if (passUnfinished(c)) {
    if (PREFLIGHT_SEES) console.error(`  preflight will warn until this finishes: ${JOB} — ${formatPassCounts(c)}`);
    else console.error(`  unfinished, and preflight cannot see this key: ${JOB} — ${formatPassCounts(c)}`);
  }
  if (corpus.unaccepted > 0 && recordAgrees) console.error(`  preflight will warn until they are re-embedded: ${corpus.unaccepted} vector(s) at another model (its vector models check)`);
  if (corpus.noneAt && recordAgrees) console.error(`  preflight will warn: no vector is known to be at ${TARGET} — accepted or unlabelled rows are all it has (its vector models check)`);
}

/**
 * The succeeded rows that carry a caveat. Listed from the record, not from a
 * counter, so --status and the end of a run agree whichever process did the
 * work. The wording is the rule's, not one caveat's: two are written today —
 * the head window, and a failure the operator accepted — and the count and
 * the list are true of any caveat a later worker records; each row's text
 * says which it is.
 */
async function printFallbacks(total: number, limit = 10): Promise<void> {
  const rows = (await sql`
    SELECT thought_id, last_error FROM thought_work_claims
    WHERE work_type = ${JOB} AND ${withCaveat()}
    ORDER BY finished_at DESC LIMIT ${limit}`) as { thought_id: string; last_error: string }[];
  console.error(
    `\n  ${total} succeeded row(s) carry a caveat (${Math.min(total, limit)} of ${total} listed): the write stands, and the caveat is what the\n` +
      `  worker could not do — a long thought the provider refused to embed whole, stored with its head window's vector as a capture\n` +
      `  would have stored it; or a failure the operator accepted with --accept-failed, the row keeping the vector it had. --retry-fallbacks\n` +
      `  returns them to the pool once the cause — the provider, its input limit, or the refusal — has changed.`
  );
  for (const r of rows) console.error(`    ${r.thought_id}  ${r.last_error}`);
}

/**
 * Groups of thoughts that normalise to one text: pairs from before migration
 * 003's fingerprint, or a load that bypassed upsert_thought. One query over
 * the corpus that hashes only the rows whose fingerprint column is NULL and
 * groups them with the fingerprinted rows through the column — so it finds
 * NULL/NULL pairs before a pass and NULL/fingerprinted pairs after, and costs
 * little once a pass has fingerprinted the corpus. It runs under --status,
 * which is asked repeatedly during a pass, so it must stay cheap: hashing
 * every row's text would catch a row whose column carries a STALE key as well,
 * but that row is reported by the pass itself (fingerprint_held_by) when it
 * blocks another row, and nothing here needs to find it twice. Prints nothing
 * when there are none. Needs 016's content_fingerprint_of; on an older schema
 * it says so and returns.
 */
async function printDuplicateGroups(limit = 10): Promise<number> {
  const [{ present }] = await sql`SELECT to_regprocedure('content_fingerprint_of(text)') IS NOT NULL AS present`;
  if (!present) {
    console.error("  (the duplicate report needs migration 016's content_fingerprint_of — not applied here)");
    return 0;
  }
  // The groups first, hashing only the NULL rows; then the mark, hashing only
  // the rows IN a group — a holder whose own text does not hash to its key
  // holds it under OTHER text (018's fingerprint_held_by), and is grouped
  // here with the NULL row it blocks, not with a twin.
  const rows = (await sql`
    WITH g AS (
      SELECT count(*) OVER ()::int AS total, array_agg(id ORDER BY created_at, id) AS ids, min(created_at) AS first
      FROM thoughts
      GROUP BY COALESCE(content_fingerprint, content_fingerprint_of(content))
      HAVING count(*) > 1
      ORDER BY min(created_at)
      LIMIT ${limit})
    SELECT g.total,
           array_agg(t.id::text || CASE WHEN t.content_fingerprint IS NULL THEN ''
                                        WHEN t.content_fingerprint = content_fingerprint_of(t.content) THEN ' (holds the key)'
                                        ELSE ' (holds the key under OTHER text — stale)' END ORDER BY u.ord) AS ids
    FROM g CROSS JOIN LATERAL unnest(g.ids) WITH ORDINALITY AS u(id, ord)
    JOIN thoughts t ON t.id = u.id
    GROUP BY g.total, g.first, g.ids
    ORDER BY g.first`) as { total: number; ids: string[] }[];
  if (!rows.length) return 0;
  const total = Number(rows[0].total);
  console.error(
    `\n  ${total} group(s) of thoughts share one normalised text — pairs from before migration 003's fingerprint, or a load that\n` +
      `  bypassed upsert_thought. Every row in a group is re-embedded; the one marked holds the key, so a later capture of that\n` +
      `  text merges into it and not into the others (none marked: backfill_content_fingerprints() gives it to the oldest; a pass\n` +
      `  gives it to whichever row it re-embeds first). Whether twins should be one thought is the operator's call — delete_thought\n` +
      `  on an unmarked twin keeps its text in the audit row. A holder marked STALE is not a twin: its key describes text it no\n` +
      `  longer holds, and the unmarked row(s) beside it carry that text — re-save the holder's own text through update_thought\n` +
      `  to free the key, then backfill_content_fingerprints() gives it to the oldest of them; whether several of them are twins\n` +
      `  of each other is the operator's call, as above. ${total > limit ? `First ${limit}:` : ""}`
  );
  for (const r of rows) console.error(`    ${r.ids.join("  =  ")}`);
  return total;
}

async function printFailures(limit = 10): Promise<void> {
  const rows = (await sql`
    SELECT thought_id, attempt_count, worker_id, last_error FROM thought_work_claims
    WHERE work_type = ${JOB} AND status = 'failed' ORDER BY finished_at DESC LIMIT ${limit}`) as
    { thought_id: string; attempt_count: number; worker_id: string | null; last_error: string | null }[];
  for (const r of rows) {
    console.error(`    ${r.thought_id}  attempt ${r.attempt_count}  ${r.last_error ?? "(no error recorded)"}`);
  }
  // The hint names what THIS shell can do: acceptance is refused under a
  // model change and under a key naming another model (third review pass).
  if (rows.length) {
    if (refusalJob) console.error(`    a pass to another model: once the revert stands, --retire ${JOB} removes its record; its failed rows are not this shell's to accept`);
    else if (modelChange) console.error(`    a row the provider refuses permanently: --accept-failed <thought-id…> once the switch is recorded (--switch-model) — it keeps its vector, and the row says so`);
    else console.error(`    a row the provider refuses permanently, that no retry will change: --accept-failed <thought-id…> — it keeps its vector, and the row says so`);
  }
}

// ── Saying "I know" — see the header ────────────────────────────────────────

if (RETIRE) {
  const key = RETIRE_KEY!;
  const named = parseReembedKey(key);
  const refuse = async (why: string): Promise<never> => {
    console.error(`\n  Refusing --retire ${key}: ${why} Nothing was written.`);
    await sql.close();
    process.exit(2);
  };
  if (!key.startsWith(REEMBED_KEY_PREFIX)) await refuse(`its key does not start with ${REEMBED_KEY_PREFIX}, so it is another tool's pass, not this one's.`);
  // The current model at the current width — a suffix or not — is a pass that
  // can be finished, or whose failed rows can be accepted: the recorded model,
  // and this shell's when nothing is recorded (a record deleted by hand around
  // a running pass must not make that pass retireable — first review pass);
  // the recorded width, and the column's when none is recorded (a hand-applied
  // schema; preflight resolves the width the same way, so the two agree on
  // which keys are superseded — first review pass).
  const currentModel = recorded.embedding_model ?? embedConfig.embeddingModel;
  // The column is the width authority — see the header (third review pass).
  const currentDim = Number(col.width);
  const isCurrent = (model: string) => named !== null && named.model === model && named.dim === currentDim;
  const refuseCurrent = (model: string, how: string) =>
    refuse(
      `it names the ${how} model (${model} @ ${currentDim}), so its pass can be finished —\n` +
        `  cd db && OB1_EMBEDDING_MODEL=${model} bun reembed.ts --url … --job ${key} — or its failed rows accepted with --accept-failed.\n` +
        `  --retire is for a pass the record has moved on from.`
    );
  if (isCurrent(currentModel)) await refuseCurrent(currentModel, recorded.embedding_model === undefined ? "configured" : "recorded");
  // The lease check and the DELETE in one transaction, the key's rows locked:
  // claim_thoughts skips locked rows, so a claim cannot be taken between the
  // two and lost under the DELETE. The DELETE takes exactly the rows locked,
  // and the record's row is read FOR UPDATE here: a --switch-model back to
  // this key's model — its record and its pool in one transaction — either
  // committed first and is seen, or waits on the row until this commits (second
  // review pass read it plainly, and a switch that locked none of the key's
  // rows could commit unseen in between — third).
  const outcome = await sql.begin(async (tx: SQL) => {
    const rows = (await tx`
      SELECT thought_id::text AS id, status, (status = 'claimed' AND ttl_expires_at >= now()) AS live
      FROM thought_work_claims WHERE work_type = ${key} FOR UPDATE`) as { id: string; status: string; live: boolean }[];
    const [nowRecorded] = (await tx`SELECT value FROM ob1_config WHERE key = 'embedding_model' FOR UPDATE`) as { value: string }[];
    const byStatus = [...rows.reduce((m, r) => m.set(r.status, (m.get(r.status) ?? 0) + 1), new Map<string, number>())]
      .sort(([a], [b]) => a.localeCompare(b)).map(([s, c]) => `${c} ${s}`).join(", ");
    const live = rows.filter((r) => r.live).length;
    const movedTo = nowRecorded !== undefined && nowRecorded.value !== recorded.embedding_model && isCurrent(nowRecorded.value) ? nowRecorded.value : null;
    const wrote = rows.some((r) => r.status === "succeeded");
    if (rows.length === 0 || live > 0 || movedTo !== null || DRY_RUN) return { total: rows.length, live, byStatus, movedTo, wrote };
    // Qualified by the key and bounded to the rows locked, the one DELETE this
    // tool makes: the record of a pass the record has moved on from, as 015's
    // fourth principle allows.
    const removed = (await tx`DELETE FROM thought_work_claims WHERE work_type = ${key} AND thought_id = ANY(${sql.array(rows.map((r) => r.id), "TEXT")}::uuid[]) RETURNING 1`) as unknown[];
    return { total: removed.length, live, byStatus, movedTo, wrote };
  });
  if (outcome.total === 0) await refuse("no rows are recorded under that key — nothing to retire (a typo in the key is the likelier cause; --status --job <key> shows what a key holds).");
  if (outcome.live > 0) await refuse(`${outcome.live} row(s) under it are leased right now — a pass under this key is running; stop it first, or wait for the leases to expire.`);
  if (outcome.movedTo !== null) await refuseCurrent(outcome.movedTo, "recorded — the record moved to it while this ran —");
  if (DRY_RUN) {
    console.log(`\n  would: retire ${key} — remove its ${outcome.total} row(s) (${outcome.byStatus}). Nothing was written.`);
  } else {
    console.log(`\n  retired ${key}: ${outcome.total} row(s) removed (${outcome.byStatus}).`);
    // Judged against the CURRENT model, not this shell's — the shell that ran
    // the abandoned switch is still configured for the model it abandoned
    // (third review pass) — and worded by what the pass did.
    console.log(
      outcome.wrote && named !== null
        ? `  The vectors that pass wrote are still at ${named.model}; preflight's vector models check reports them until they are re-embedded:`
        : "  That pass wrote no vector; the record of it is gone and the corpus stands as it was:"
    );
    await printCorpusByModel(currentModel);
  }
  await sql.close();
  process.exit(0);
}

if (ACCEPT_FAILED) {
  const refuse = async (why: string): Promise<never> => {
    console.error(`\n  Refusing --accept-failed: ${why} Nothing was written.`);
    await sql.close();
    process.exit(2);
  };
  if (refusalJob) await refuse(refusalJob.trim());
  // 021 whole, as a run needs it: acceptance is read against the label, and
  // 021's evidence backfill — which the remedy for an older body re-runs —
  // would read an accepted row as proof the thought is AT the key's model; see
  // "Saying I know" (first and second review passes).
  if (refusal021) {
    await refuse(
      `${refusal021.trim()}\n` +
        `  --accept-failed needs the same: acceptance is read against the label, and 021's backfill reads a succeeded row — an accepted\n` +
        `  one included — as proof the thought is at the key's model.`
    );
  }
  // Ids AFTER --all are the scanner's to refuse (it takes nothing); this is the list before it.
  if (ACCEPT_ALL && ACCEPT_IDS.length > 0) {
    await refuse(`--all takes no ids beside it — name the rows, or accept every failed row under ${JOB} with --all alone.`);
  }
  if (modelChange) {
    await refuse(
      `ob1_config records ${recorded.embedding_model} and this shell is configured for ${embedConfig.embeddingModel}, so the failed rows under\n` +
        `  ${JOB} belong to a pass that has not recorded itself. Run it — --switch-model — and accept what it leaves; or, if\n` +
        `  ${embedConfig.embeddingModel} is simply set wrong in this shell, fix it instead.`
    );
  }
  // With whether the thought has a vector to keep: one with none is invisible
  // to semantic search, and an accepted row would be the last thing to say so
  // (second review pass) — refused by id, passed over and said under --all.
  // …and whether the thought was written since the attempt read it while not
  // at the target — an acceptance every reader would treat as void from the
  // start, and the next run would spend (third review pass); a thought at the
  // target needs no reader to leave it, so the worker's own head-window write
  // does not count against it.
  const failedRows = (await sql`
    SELECT thought_id::text AS id, last_error, (x.embedding IS NULL) AS vectorless,
           (x.embedding IS NOT NULL AND x.embedding_model IS DISTINCT FROM ${TARGET} AND NOT (${standingBound()})) AS edited_since
    FROM thought_work_claims
    JOIN thoughts x ON x.id = thought_id
    WHERE work_type = ${JOB} AND status = 'failed' ORDER BY finished_at DESC`) as { id: string; last_error: string | null; vectorless: boolean; edited_since: boolean }[];
  const describe = (r: { id: string; last_error: string | null; vectorless?: boolean; edited_since?: boolean }) =>
    `    ${r.id}  ${r.vectorless ? "(no vector) " : r.edited_since ? "(written since the attempt) " : ""}${r.last_error ?? "(no error recorded)"}`;
  if (!ACCEPT_ALL && ACCEPT_IDS.length === 0) {
    await refuse(
      `it needs the rows to accept, by id — --accept-failed <thought-id…> — or --all for every failed row under ${JOB}, said explicitly\n` +
        `  since a provider outage accepted that way hides itself. ${failedRows.length} failed row(s) under ${JOB}${failedRows.length ? ":\n" : "."}` +
        failedRows.slice(0, 20).map(describe).join("\n")
    );
  }
  // The stores' rule (store.ts), so the CLI refuses exactly the ids they answer null for.
  const bad = ACCEPT_IDS.filter((id) => !UUID_RE.test(id));
  if (bad.length) await refuse(`not a thought id: ${bad.join(", ")}.`);
  const failedIds = new Set(failedRows.map((r) => r.id));
  const asked = [...new Set(ACCEPT_IDS.map((id) => id.toLowerCase()))];
  const notFailed = asked.filter((id) => !failedIds.has(id));
  if (notFailed.length) {
    const states = (await sql`
      SELECT thought_id::text AS id, status FROM thought_work_claims
      WHERE work_type = ${JOB} AND thought_id = ANY(${sql.array(notFailed, "TEXT")}::uuid[])`) as { id: string; status: string }[];
    const stateOf = new Map(states.map((r) => [r.id, r.status]));
    await refuse(
      `not a failed row under ${JOB}: ${notFailed.map((id) => `${id} (${stateOf.get(id) ?? "no row"})`).join(", ")}. Only a failed row can be\n` +
        `  accepted — a pending or leased one has not been tried, a succeeded one needs nothing.`
    );
  }
  const vectorless = failedRows.filter((r) => r.vectorless);
  const noVector = asked.filter((id) => vectorless.some((r) => r.id === id));
  if (noVector.length) {
    await refuse(
      `no vector to keep: ${noVector.join(", ")}. Acceptance keeps the vector a row has; a thought with none is invisible to semantic\n` +
        `  search, and an accepted row would be the last thing to say so. Delete the thought, or fix its text and --retry-failed.`
    );
  }
  const editedSince = failedRows.filter((r) => r.edited_since);
  const edited = asked.filter((id) => editedSince.some((r) => r.id === id));
  if (edited.length) {
    await refuse(
      `written since the attempt read it: ${edited.join(", ")}. The content the provider refused is not the content the row has now, and\n` +
        `  the acceptance would be void as written — every reader applies that bound, and the next run would return the row with it gone.\n` +
        `  --retry-failed tries the new content; accept what still fails.`
    );
  }
  const passedOver = ACCEPT_ALL ? failedRows.filter((r) => r.vectorless || r.edited_since) : [];
  const ids = ACCEPT_ALL ? failedRows.filter((r) => !r.vectorless && !r.edited_since).map((r) => r.id) : asked;
  if (ids.length === 0) await refuse(`no failed rows under ${JOB}${passedOver.length ? ` to accept as they are (${passedOver.length} passed over, listed by --status)` : ""} — nothing to accept.`);
  const idSet = new Set(ids);
  const chosen = failedRows.filter((r) => idSet.has(r.id));
  const sayPassedOver = () => {
    if (!passedOver.length) return;
    console.error(
      `  ${passedOver.length} failed row(s) were not accepted — a thought with no vector has nothing to keep, and nothing would say afterwards that it is invisible\n` +
        `  to search (delete it, or fix its text and --retry-failed); one written since the attempt read it has content the provider never saw (--retry-failed\n` +
        `  tries it; accept what still fails):`
    );
    for (const r of passedOver) console.error(describe(r));
  };
  if (DRY_RUN) {
    console.log(`\n  would: accept ${chosen.length} failed row(s) under ${JOB} — each becomes succeeded with the caveat "${ACCEPTED_CAVEAT_PREFIX}<the failure>", keeping the vector it has:`);
    for (const r of chosen) console.log(describe(r));
    sayPassedOver();
    console.log("  Nothing was written.");
    await sql.close();
    process.exit(0);
  }
  // The row's timestamps stay the failure's — the bound is claimed_at (see the
  // header). 015 stamps finished_at on every failed row, released or reaped;
  // the COALESCE covers a hand-written one.
  // What is printed is what was written: a row another process returned to the
  // pool between the list above and this statement is not accepted, and is not
  // listed as if it were (first review pass).
  const written = (await sql`
    UPDATE thought_work_claims
       SET status = 'succeeded', finished_at = COALESCE(finished_at, now()),
           last_error = ${ACCEPTED_CAVEAT_PREFIX} || COALESCE(last_error, '(no error recorded)')
     WHERE work_type = ${JOB} AND status = 'failed' AND thought_id = ANY(${sql.array(ids, "TEXT")}::uuid[])
     RETURNING thought_id::text AS id, last_error`) as { id: string; last_error: string }[];
  console.log(
    `\n  ${written.length} failed row(s) accepted under ${JOB}${ACCEPT_ALL ? " (--all: a provider outage accepted this way hides itself; --status lists the caveats)" : ""}` +
      ` — each keeps the vector it has, and its row says so:`
  );
  for (const r of written) console.log(`    ${r.id}  ${r.last_error}`);
  if (written.length < chosen.length) console.error(`  ${chosen.length - written.length} of the rows named left 'failed' meanwhile — returned to the pool by another process — and were not accepted.`);
  sayPassedOver();
  console.log("  --retry-fallbacks returns them to the pool on the day the cause changes; an edit to the thought reopens it by itself.");
  const c = await counts();
  printCounts(c, "status");
  const corpus = await printCorpusByModel();
  printPreflightNote(c, corpus, judgedAsPreflight(false));
  await sql.close();
  process.exit(0);
}

if (STATUS_ONLY || DRY_RUN) {
  const c = await counts();
  printCounts(c, STATUS_ONLY ? "status" : "before");
  const corpus = await printCorpusByModel();
  if (STATUS_ONLY) printPreflightNote(c, corpus, judgedAsPreflight(false));
  // What a run would refuse on, said here too: --status is the mode the
  // operator reads first, and the 021 remedy is the migrator's (SMD-1193). The
  // same three a run judges; not beside --dry-run, whose "would: refuse" line
  // below is the same text.
  if (STATUS_ONLY && !DRY_RUN && refusalForRun) console.error(`\n  a run would refuse:${refusalForRun}`);
  if (c.claimed > 0) for (const h of await leaseHolders(sql, JOB)) console.log(describeHolder(h));
  if (c.failed > 0) {
    console.error(`  failed rows (${Math.min(c.failed, 10)} of ${c.failed}):`);
    await printFailures();
  }
  if (c.fellBack > 0) await printFallbacks(c.fellBack);
  await printDuplicateGroups();
  if (DRY_RUN) {
    if (refusalForRun) {
      console.error(`\n  would: refuse.${refusalForRun}`);
      await sql.close();
      process.exit(2);
    }
    // Recording the model starts this pass over (see the header) — the failed
    // rows and the expired leases count towards the run, and --retry-failed
    // adds nothing; the data rule's rows count on every run, and the caveats
    // --retry-fallbacks would return are those the data rule leaves.
    const countWhere = async (where: ReturnType<typeof withCaveat>) =>
      Number((await sql`SELECT count(*)::int AS n FROM thought_work_claims WHERE work_type = ${JOB} AND (${where})`)[0].n);
    const restart = recordModel ? await countWhere(staleUnderThisJob()) : 0;
    // The rows the start-over takes first are not the data rule's to count
    // again (under a backfill key the start-over takes every terminal row).
    const notAt = recordModel
      ? await countWhere(sql`(${doneButNotAtTarget()}) AND NOT (${staleUnderThisJob()})`)
      : await countWhere(doneButNotAtTarget());
    const fallbacks = retryFallbacks
      ? await countWhere(recordModel ? sql`(${caveatsAtTarget()}) AND NOT (${staleUnderThisJob()})` : caveatsAtTarget())
      : 0;
    const unlabelled = await unlabelledPooled(false);
    // Said as what a run WITH the flag would do when the flag is missing: the
    // run itself refuses, and this line must not read as its plan.
    console.log(
      `\n  would: ${modelChange && !SWITCH_MODEL ? "refuse without --switch-model; with it: " : ""}` +
        `${recordModel ? `record ${embedConfig.embeddingModel} in ob1_config; ` : ""}` +
        `${restart ? `start this pass over (${restart} ${BACKFILL ? "terminal" : "failed"} row(s) or expired lease(s) from before the change return to the pool); ` : ""}` +
        `${notAt ? `return ${notAt} succeeded row(s) whose thought is not at ${embedConfig.embeddingModel} to the pool; ` : ""}` +
        `${retryFailed ? `return ${c.failed} failed rows to the pool; ` : ""}` +
        `${retryFallbacks ? `return ${fallbacks} rows succeeded with a caveat to the pool; ` : ""}` +
        `add ${c.unpooled} thoughts to the pool; run ${WORKERS} worker(s), ${BATCH} per claim, ${TTL} s leases renewed every ${HEARTBEAT} s, ` +
        `over ${c.pending + c.unpooled + restart + notAt + (retryFailed ? c.failed : 0) + fallbacks} rows` +
        `${unlabelled ? ` — ${unlabelled} of them unlabelled (nothing vouches for their model; re-embedding is what labels them)` : ""}. Nothing was written.`
    );
  }
  await sql.close();
  process.exit(0);
}

// ── The run ─────────────────────────────────────────────────────────────────

if (refusalForRun) {
  console.error(`\n ${refusalForRun}`);
  await sql.close();
  process.exit(2);
}

// The provider first, so a wrong URL or a wrong width fails before any row is
// touched — the width check inside getEmbedding names the model and both widths.
try {
  await embedder.getEmbedding("reembed.ts provider probe");
} catch (e) {
  console.error(`\n  The embedding provider is not usable: ${(e as Error).message}`);
  await sql.close();
  process.exit(2);
}

// The record and the pool, in one transaction — see "Changing model" in the
// header. Nothing below is printed until it has committed, so what the
// operator reads is what the database holds.
type Start = { restarted: number; movedSinceDone: number; retriedFailed: number; retriedFallbacks: number; added: number };
let start: Start;
try {
  start = await sql.begin(async (tx: SQL) => {
    if (recordModel) {
      await tx`
        INSERT INTO ob1_config (key, value) VALUES ('embedding_model', ${embedConfig.embeddingModel})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    }
    // Recording the model starts this pass over — its failed rows and expired
    // leases, whatever an earlier pass under the key recorded; --retry-failed
    // is subsumed. The succeeded rows are the data rule's, on every run: back
    // to the pool when their thought is not at the target, and only then.
    const restarted = recordModel ? await requeue(tx, staleUnderThisJob()) : 0;
    const movedSinceDone = await requeue(tx, doneButNotAtTarget());
    const retriedFailed = retryFailed ? await requeue(tx, sql`status = 'failed'`) : 0;
    // After the data rule, so a caveat row whose thought moved is counted once.
    const retriedFallbacks = retryFallbacks ? await requeue(tx, withCaveat()) : 0;
    // The pool (021): under the model's own key the rows not at the target — a
    // thought already at it with no row under the key needs nothing; under a
    // backfill key every thought, through 015's set-based branch, as before.
    const [{ added }] = BACKFILL
      ? await tx`SELECT enqueue_thoughts(${JOB}) AS added`
      : await tx`SELECT enqueue_thoughts(${JOB}, ARRAY(SELECT id FROM thoughts WHERE ${notAtTarget()})) AS added`;
    // enqueue_thoughts analyses only when it added rows; a requeue moves as
    // many into the pending index and would otherwise leave the statistics
    // describing the finished pass (migration 015, "Cost of a claim").
    if (restarted + movedSinceDone + retriedFailed + retriedFallbacks > 0 && Number(added) === 0) await tx`ANALYZE thought_work_claims`;
    return { restarted, movedSinceDone, retriedFailed, retriedFallbacks, added: Number(added) };
  });
} catch (e) {
  // Rolled back whole: the record still names the previous model and the pool
  // is as it was. One cause worth naming — the start-over takes the expired
  // leases another process's claim_thoughts is reaping at the same moment, and
  // the two can take them in opposite orders (a deadlock the server resolves
  // by ending one of them). Nothing is lost either way; run again.
  console.error(
    `\n  Could not start the pass: ${(e as Error).message}\n` +
      `  Nothing was written — the record and the pool are as they were. If another process is claiming under this key\n` +
      `  right now, its reaper and this start took the same expired leases in opposite orders; run again.`
  );
  await sql.close();
  process.exit(2);
}
if (recordModel) {
  console.log(`  ob1_config.embedding_model = ${embedConfig.embeddingModel} — a server configured for it now passes preflight; switch it.`);
}
if (start.restarted > 0) {
  console.log(`  ${modelChange ? "model change" : "no model was recorded"}: this pass starts over — ${start.restarted} ${BACKFILL ? "terminal" : "failed"} row(s) or expired lease(s) from before the change returned to the pool`);
}
if (start.movedSinceDone > 0) {
  console.log(`  ${start.movedSinceDone} succeeded row(s) whose thought is not at ${embedConfig.embeddingModel} returned to the pool — captured or edited since by a server on another model`);
}
if (RETRY_FAILED) console.log(`  --retry-failed: ${recordModel ? "nothing to do separately — recording the model returned every failed row under this job to the pool" : `${start.retriedFailed} failed row(s) returned to the pool`}`);
if (RETRY_FALLBACKS) console.log(`  --retry-fallbacks: ${start.retriedFallbacks} row(s) succeeded with a caveat returned to the pool`);
const before = await counts();
console.log(`  pool: ${start.added} thought(s) added`);
printCounts(before, "before");
const corpusBefore = await printCorpusByModel();
{
  const unlabelled = await unlabelledPooled(true);
  if (unlabelled > 0) console.error(`  ${unlabelled} of the rows to re-embed are unlabelled — nothing vouches for their model — and this pass is what labels them`);
}

const total = before.pending + before.claimed;
if (total === 0) {
  console.log("\n  Nothing to do.");
  if (before.failed > 0) {
    console.error(`  ${before.failed} failed row(s) remain from an earlier run — pass --retry-failed to try them again:`);
    await printFailures();
    printPreflightNote(before, corpusBefore, judgedAsPreflight(recordModel));
    await sql.close();
    process.exit(1);
  }
  await sql.close();
  process.exit(0);
}

const toVector = (v: number[]) => `[${v.join(",")}]`;
const actor = { name: "reembed", source: "db/reembed.ts", session: JOB };

let stopping = false;
let done = 0;
let failed = 0;
let vanished = 0;
let lost = 0;
let beats = 0;
/** Worker ids with leases possibly outstanding, for a forced exit. */
const activeWorkers = new Set<string>();
const started = Date.now();
const lastReport = { at: 0 };

function progress(force = false): void {
  const now = Date.now();
  if (!force && now - lastReport.at < 2000) return;
  lastReport.at = now;
  const elapsed = (now - started) / 1000;
  const rate = done / Math.max(elapsed, 0.001);
  const remaining = Math.max(total - done - failed, 0);
  const eta = rate > 0 ? Math.round(remaining / rate) : null;
  console.log(
    `  ${done + failed}/${total}  ${rate.toFixed(1)}/s` +
      (failed ? `  ${failed} failed` : "") +
      (eta !== null ? `  ~${eta}s left` : "")
  );
}

/**
 * `updated_at` is `COALESCE(updated_at, created_at)` — the expression
 * update_thought's guard compares against. Migration 001 leaves the column
 * nullable, and a row loaded around upsert_thought can carry NULL there; passing
 * that NULL as `p_if_unchanged_since` would disable the guard and let this pass
 * write a concurrent edit back to its old text.
 */
type Row = { id: string; content: string; updated_at: Date };

/**
 * Embed and write one thought. Returns "succeeded" — with a caveat when the
 * write fell short of what was asked and the row should say so — "failed" with
 * an error, or "vanished" when the thought was deleted after it was claimed.
 */
type Outcome = { outcome: "succeeded"; caveat?: string } | { outcome: "failed"; error: string } | { outcome: "vanished" };
async function processRow(row: Row): Promise<Outcome> {
  let current = row;
  for (let attempt = 0; attempt < 3; attempt++) {
    const embedded = await embedder.embedCapture(current.content);
    const chunks = embedded.chunks.map((c) => ({ content: c.content, embedding: toVector(c.embedding), context: c.context ?? null }));
    const [r] = await sql`
      SELECT update_thought(
        ${current.id}::uuid,
        ${current.content}::text,
        NULL::jsonb,
        ${toVector(embedded.embedding)}::vector,
        ${chunks.length ? chunks : null}::jsonb,
        ${current.updated_at}::timestamptz,
        ${actor}::jsonb,
        ${embedded.model}::text
      ) AS r`;
    const result = r.r as { ok: boolean; error?: string; duplicate_of?: string; fingerprint_held_by?: string };
    if (result.ok) {
      // The write is done in every case below: whatever was embedded is better
      // than the vector the row had, and under --switch-model the old one is
      // from another model. What differs is whether the claim may go terminal.
      // Two things 018 reports are not outcomes — nothing about this row's
      // vectors is in doubt — and are said once per row here.
      if (result.duplicate_of) {
        // The row's own text is also another thought's — a pair from before the
        // fingerprint. The summary lists the groups from the corpus, so that
        // count is the authoritative one (a pair's first row is never reported
        // here — nothing owned its text yet).
        console.error(`  ${current.id}: duplicates ${result.duplicate_of} — the same text, which deduplication could not see because this row had no fingerprint; re-embedded, see the summary`);
      } else if (result.fingerprint_held_by) {
        // Another row carries this text's key under DIFFERENT text — a stale
        // fingerprint from a raw update around update_thought — so this row
        // could not take the fingerprint it should have. The key is the other
        // row's problem, and re-saving its own text fixes it.
        console.error(`  ${current.id}: could not take its fingerprint — ${result.fingerprint_held_by} holds that key under other text (a stale fingerprint; re-saving that thought's own text corrects it)`);
      }
      // Everything the row should say about itself is collected before the
      // outcome is chosen, so a row with two things wrong records both: a
      // refusal is not lost behind a blurb failure, nor a blurb failure behind
      // a transient fallback.
      //
      // Refused outright: the head window is the provider's final answer for
      // this input, as it would be for a capture, and the row says so — as a
      // caveat on success, or appended to a failure. See "The head window,
      // recorded" in the header.
      const refused = embedded.wholeContentFellBack && embedded.wholeContentRefused
        ? `whole-content embedding refused by the provider (${embedded.wholeContentError ?? "no detail"}); the head window's vector is stored, as a capture would have stored it — --retry-fallbacks once the provider or its input limit changes`
        : null;
      const failures: string[] = [];
      if (embedded.wholeContentFellBack && !embedded.wholeContentRefused) {
        // The whole-content call failed for a reason that says nothing about
        // the next attempt — a 429, a 5xx, a dropped connection, the timeout —
        // so the head window is in the row and the claim is retryable rather
        // than final.
        // "Transiently" covers a 400 whose words do not name the length: not
        // known to be about this input, so retryable rather than final. A
        // provider that answers that 400 for every long input will fail these
        // rows on every --retry-failed; the row says what it got.
        failures.push(`whole-content embedding failed transiently (${embedded.wholeContentError ?? "no detail"}) and the head window's vector was stored — not a stated refusal of the length, so --retry-failed will try the whole content again`);
      }
      // The server stores a bare window and tells the caller; here there is no
      // caller, and a terminal claim cannot be re-run. So the new vectors are
      // written, bare, and the claim is a failure --retry-failed can revisit
      // once the metadata model behaves.
      if (embedConfig.chunkContext && embedded.contextFailures > 0) {
        // With the reasons, distinct: a metadata model slower than
        // OB1_LLM_TIMEOUT is told apart from one that answers badly.
        const reasons = embedded.contextErrors.slice(0, 3).join("; ") + (embedded.contextErrors.length > 3 ? `; and ${embedded.contextErrors.length - 3} more` : "");
        failures.push(`${embedded.contextFailures} of ${embedded.chunks.length} windows were embedded without context (${reasons || "no detail"}); the bare vectors are stored; fix the cause, then --retry-failed`);
      }
      if (failures.length) return { outcome: "failed", error: [...failures, ...(refused ? [refused] : [])].join("; also: ") };
      return refused ? { outcome: "succeeded", caveat: refused } : { outcome: "succeeded" };
    }
    if (result.error === "NOT_FOUND") return { outcome: "vanished" };
    if (result.error === "STALE_READ" || result.error === "DUPLICATE_CONTENT") {
      // Edited between the claim and the write. Re-read and embed what is there
      // now; the guard exists so the stale vector never wins. DUPLICATE_CONTENT
      // is the same event seen through a gap in the guard: updated_at is the
      // editing transaction's start time at millisecond precision, so an edit
      // that began before this worker's read and committed after it passes
      // if_unchanged_since — and the text this worker holds is then no longer
      // the row's, so 018 judges it as a change into another row's text. The
      // re-read carries the current text and the next call is unchanged.
      const [fresh] = (await sql`SELECT id, content, COALESCE(updated_at, created_at) AS updated_at FROM thoughts WHERE id = ${current.id}::uuid`) as Row[];
      if (!fresh) return { outcome: "vanished" };
      current = fresh;
      continue;
    }
    // Anything else is reported as what it is. Not an error code at all: a
    // capture of the same text committing while this row is fingerprinted
    // (018's lock covers edits, not upsert_thought — SMD-1043) raises a unique
    // violation into the catch in worker(): failed with the constraint named,
    // and --retry-failed then finds the other row and reports duplicate_of.
    return { outcome: "failed", error: `update_thought: ${result.error}` };
  }
  return { outcome: "failed", error: "update_thought: STALE_READ or DUPLICATE_CONTENT three times in a row — the thought is being edited faster than it can be re-embedded; --retry-failed once it settles" };
}

async function worker(n: number): Promise<void> {
  // Globally unique: release_claims_for_worker matches on this alone, and a
  // bare pid collides across containers.
  const workerId = `reembed-${hostname()}-${process.pid}-${n}-${randomUUID().slice(0, 8)}`;
  activeWorkers.add(workerId);
  const hb = startHeartbeat({
    sql, job: JOB, workerId, ttlS: TTL, everyS: HEARTBEAT,
    onLost: (ids) => console.error(`  ${workerId}: ${ids.length} row(s) no longer this worker's at the last beat — reaped, requeued by an edit, or deleted; each is named as the loop reaches it, or at its release if it was the row in hand`),
    onError: (e, consecutive) => { if (consecutive === 1) console.error(`  ${workerId}: heartbeat failed (${e.message}); the leases hold ${TTL} s from the last beat that reached the database`); },
  });
  try {
    while (!stopping) {
      let batch: { thought_id: string; attempt: number }[];
      let byId: Map<string, Row>;
      try {
        batch = (await sql`
          SELECT thought_id, attempt FROM claim_thoughts(${JOB}, ${workerId}, ${BATCH}, ${TTL})`) as { thought_id: string; attempt: number }[];
        if (batch.length === 0) return;
        const ids = batch.map((b) => b.thought_id);
        hb.claimed(ids);
        const rows = (await sql`
          SELECT id, content, COALESCE(updated_at, created_at) AS updated_at FROM thoughts WHERE id = ANY(${sql.array(ids, "TEXT")}::uuid[])`) as Row[];
        byId = new Map(rows.map((r) => [r.id, r]));
      } catch (e) {
        // A database error here is not about one thought. This worker stops;
        // the others carry on, and the finally below hands back what it holds.
        console.error(`  ${workerId}: ${(e as Error).message} — this worker stops`);
        return;
      }
      for (const b of batch) {
        if (stopping) return;
        if (hb.lost.has(b.thought_id)) {
          // A beat found this row no longer ours. The row says why: deleted
          // (its claim cascaded away), back in the pool (reaped, or requeued by
          // an edit), or another worker's now. Nothing to release either way,
          // and repeating the provider's work would only race the holder.
          const why = await lostReason(sql, JOB, workerId, b.thought_id).catch(() => null);
          if (why?.kind === "deleted") vanished++;
          else lost++;
          console.error(`  ${b.thought_id}: ${describeLoss(why)}`);
          continue;
        }
        const row = byId.get(b.thought_id);
        if (b.attempt > 1) console.error(`  ${b.thought_id}: attempt ${b.attempt} — an earlier lease on it expired`);
        let outcome: Outcome;
        if (!row) {
          outcome = { outcome: "vanished" };
        } else {
          try {
            outcome = await processRow(row);
          } catch (e) {
            outcome = { outcome: "failed", error: (e as Error).message.slice(0, PROVIDER_ERROR_CHARS) };
          }
        }
        // Out of the heartbeat's set before the release goes out, so a beat in
        // flight across the release does not read the released row as lost.
        hb.held.delete(b.thought_id);
        if (outcome.outcome === "vanished") {
          // The claim row cascaded away with the thought; there is nothing to
          // release. Count it so the summary adds up.
          vanished++;
          continue;
        }
        let ok: boolean;
        let gone = false;
        try {
          // A succeeded row's last_error is its caveat — see the header.
          [{ ok }] = await sql`
            SELECT release_thought(${b.thought_id}::uuid, ${JOB}, ${workerId},
                                   ${outcome.outcome}, ${outcome.outcome === "failed" ? outcome.error : outcome.caveat ?? null}) AS ok`;
          // False has two causes and only one of them is about the lease: the
          // thought may have been deleted between the write and this call, its
          // claim row cascading away with it.
          if (!ok) {
            const [{ exists }] = await sql`SELECT EXISTS (SELECT 1 FROM thoughts WHERE id = ${b.thought_id}::uuid) AS exists`;
            gone = !exists;
          }
        } catch (e) {
          // The write to `thoughts`, if there was one, stands. The claim stays
          // this worker's until the finally below returns it to the pool, and
          // the row is then done again — the same vector twice, harmless.
          console.error(`  ${b.thought_id}: could not release the claim (${(e as Error).message}) — this worker stops`);
          return;
        }
        if (gone) {
          vanished++;
          console.error(`  ${b.thought_id}: deleted while it was being re-embedded`);
          progress();
          continue;
        }
        if (!ok) {
          // The lease expired and the row is not ours to finish; our write to
          // `thoughts`, if we made one, stands — the same vector twice at
          // worst, harmless. Counted with the rows this worker lost, not the
          // ones it finished, so the workers' summaries add up across a pass.
          console.error(`  ${b.thought_id}: the claim was no longer this worker's at release — its lease lapsed (no beat reached the database for ${TTL} s), it was returned by hand with release_claims_for_worker, or it failed at its last allowed expiry; the row is the pool's, another worker's, or failed now`);
          if (outcome.outcome === "failed") console.error(`  ${b.thought_id}: ${outcome.error} (not recorded — the row was not this worker's)`);
          else if (outcome.caveat) console.error(`  ${b.thought_id}: ${outcome.caveat} (not recorded — the row was not this worker's)`);
          lost++;
          progress();
          continue;
        }
        if (outcome.outcome === "failed") {
          failed++;
          console.error(`  ${b.thought_id}: ${outcome.error}`);
        } else {
          done++;
          if (outcome.caveat) console.error(`  ${b.thought_id}: ${outcome.caveat}`);
        }
        progress();
      }
    }
  } finally {
    hb.stop();
    beats += hb.beats;
    // Unconditionally: a worker that stops for any reason — an empty pool, a
    // signal, a database error — must not leave its leases to expire. Normally
    // there is nothing to return and this is one cheap statement.
    try {
      const [{ n: freed }] = await sql`SELECT release_claims_for_worker(${JOB}, ${workerId}) AS n`;
      if (freed > 0) console.error(`  ${workerId}: returned ${freed} unfinished row(s) to the pool`);
    } catch (e) {
      console.error(`  ${workerId}: could not return its leases (${(e as Error).message}); they expire within ${TTL} s`);
    }
    activeWorkers.delete(workerId);
  }
}

const stop = () => {
  if (stopping) {
    // A second signal while a worker is inside a call it cannot leave — a
    // provider call has OB1_LLM_TIMEOUT to answer, but a database call has
    // nothing — so the workers may not reach their own finally: return their
    // leases from here, best effort and bounded, then leave.
    console.error(`\n  second signal — exiting now; leases not returned in time expire within ${TTL} s`);
    const hardStop = setTimeout(() => process.exit(130), 3000);
    void Promise.all(
      [...activeWorkers].map((w) => sql`SELECT release_claims_for_worker(${JOB}, ${w})`.catch(() => null))
    ).finally(() => {
      clearTimeout(hardStop);
      process.exit(130);
    });
    return;
  }
  stopping = true;
  console.error("\n  stopping after the current thought; unfinished claims go back to the pool (again to exit now)");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

console.log(`\n  ${WORKERS} worker(s), ${BATCH} per claim, ${TTL} s leases renewed every ${HEARTBEAT} s\n`);
await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));
progress(true);

const after = await counts();
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n  ${done} re-embedded, ${failed} failed, ${vanished} deleted mid-pass${lost ? `, ${lost} no longer this worker's when checked (each named above)` : ""}, in ${elapsed}s, ${beats} heartbeat(s)`);
printCounts(after, "after");
await printDuplicateGroups();
if (after.fellBack > 0) await printFallbacks(after.fellBack);
if (after.failed > 0) {
  console.error(`\n  failed rows (${Math.min(after.failed, 10)} of ${after.failed}) — fix the cause and re-run with --retry-failed:`);
  await printFailures();
}
const corpusAfter = await printCorpusByModel();
if (after.unpooled > 0) {
  // Under the model's own key: captured or edited while the pass ran, by a
  // server on another model — the rows say so (021), and a re-run takes exactly
  // them. Under a backfill key every capture made meanwhile is unpooled,
  // whatever model it is at, and nothing about the server follows from it.
  console.error(
    BACKFILL
      ? `\n  ${after.unpooled} thought(s) captured while the pass ran have no row under this job; re-run to pool them.`
      : `\n  ${after.unpooled} thought(s) are not at ${TARGET} and have no row under this job — captured or edited while the pass ran\n` +
          `  by a server on another model, by one older than 021 (no label), or through a fallback that stores no vector. Switch or upgrade the\n` +
          `  server if that is what it was, then re-run: the pool takes exactly them.`
  );
}
printPreflightNote(after, corpusAfter, judgedAsPreflight(recordModel));
if (after.claimed > 0) {
  console.error(
    `\n  ${after.claimed} row(s) are still leased — by another process running this job, or left by a worker that failed.\n` +
      `  They return to the pool when their leases expire (within ${TTL} s of the holder's last heartbeat); re-run then, or watch --status —\n` +
      `  which names each holder; a holder that is dead can be returned at once: SELECT release_claims_for_worker(job, worker_id).`
  );
}
if (after.pending > 0 && !stopping) {
  // Every worker stopped before the pool was empty — a database error each
  // (their messages are above) — and handed its leases back. Not done.
  console.error(`\n  ${after.pending} row(s) are still pending: every worker stopped before the pool was empty. Re-run.`);
}
await sql.close();
process.exit(stopping ? 130 : after.failed > 0 || after.claimed > 0 || after.pending > 0 ? 1 : 0);
