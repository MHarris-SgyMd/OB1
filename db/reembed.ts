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
 *   await run({ url, dryRun: true })                          # a dry run, in-process: import { run } from "./reembed.ts" (SMD-2304)
 *   --workers N (2)   --batch N (8)   --ttl SECONDS (900)   --heartbeat SECONDS (60, or a third of the lease when that is shorter; at least 1, and the lease must cover two)
 *
 * The model, width and provider come from the same variables the server reads —
 * OB1_EMBEDDING_MODEL, OB1_EMBEDDING_DIM, OB1_EMBEDDING_DIMENSIONS,
 * OB1_LLM_BASE_URL, OB1_LLM_API_KEY, OB1_CHAT_BASE_URL, OB1_CHAT_API_KEY (the
 * blurbs are chat calls), OB1_LLM_TIMEOUT, OB1_CHUNK_TOKENS,
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
 * Since migration 060 (SMD-2116) a re-embedded row's `updated_at` does NOT
 * move: a vector onto a row that has one is a projection refresh inside
 * update_thought — no event, no stamp — so a client holding an
 * `if_unchanged_since` from before the pass is not told STALE_READ for it.
 * (Until 060 every re-embedded row's stamp moved, because the row was
 * updated, and the client refetched once.) The stale-read guard, the chunk
 * rewrite and 018's duplicate reports are why this tool still calls
 * update_thought rather than the refresh function directly.
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
 * serialised edits only until migration 033: a capture of the same text
 * committing while a worker fingerprinted a legacy row raised the unique
 * violation, which landed as a failed claim naming the constraint for
 * --retry-failed to resolve; since 033 upsert_thought takes the same lock, so
 * the worker waits for the capture and is told duplicate_of instead. Since
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
 * acceptance to leave it, and the counts list it as a caveat. It needs 021's column and 032's
 * nine-argument update_thought, the same refusal a run makes: acceptance is
 * read against the label, and 021's evidence backfill trusts every succeeded
 * row under a key naming a model — it predates acceptance and, applied, is
 * never edited — so a brain that accepted rows before 021 would have them
 * labelled at a model whose pass never wrote their vector. A re-run of 021's
 * body — the remedy for a --baseline'd brain whose schema is older, below —
 * does the same to an accepted row whose thought is unlabelled, and a paste of
 * the file alone did, for anyone who followed the remedy this tool printed
 * until SMD-1193. So the re-run is the migrator's — `migrate.ts --reapply`
 * re-runs every recorded migration in one transaction, and runs 021's block
 * with the acceptances out of its sight: a view of the claim table without
 * them shadows the real one for that file, so the block labels from the
 * latest row that is not an acceptance, or not at all (SMD-1421) — and
 * migration 030 carries the corrected rule, applied once to every brain at
 * upgrade: a label whose only evidence is an acceptance
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

import type { SQL } from "bun";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import {
  ACCEPTED_BY_MODEL_SQL,
  REAPPLY_COMMAND,
  REQUEUE_SET_SQL,
  ACCEPTED_CAVEAT_PREFIX,
  CORPUS_BY_MODEL_SQL,
  embeddingConfigWarnings,
  embeddingContract,
  formatPassCounts,
  parseReembedKey,
  type PassCounts,
  passUnfinished,
  poolModelFor,
  REEMBED_KEY_PREFIX,
  reembedKey,
  summariseCorpusByModel,
  UPDATE_THOUGHT_SIGNATURE,
  UPDATE_THOUGHT_SIGNATURE_9,
  UPDATE_THOUGHT_SIGNATURE_10,
  validateEmbeddingConfig,
} from "./config.mjs";
import { createEmbedder, PROVIDER_ERROR_CHARS, ProviderError, resolveEmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { localKnob, mayLeaveBox, ROW_UNITS } from "../server-portable/egress.ts";
import { blanketGate, egressDescription, egressRefusal } from "./worker-bootstrap.ts";
import { actorPayload, maskUrl, UUID_RE } from "../server-portable/store.ts";
import { chunkRecipe } from "../server-portable/lineage.ts";
import { DEFAULT_TTL_S, describeHolder, heartbeatFor, leaseHolders, leaseRefusal, reportLost, startHeartbeat, stopOnSignals, STOPPED_EARLY, type PassStop } from "./lease.ts";
import { commandLine, consoleWriter, flagList, numberIn, numberProblem, type Writer } from "./cli.ts";
import { closeThenExit, databaseUrl, databaseUrlProblem, NO_DATABASE_URL, openSql } from "./connect.ts";

/**
 * Every argument accounted for (db/cli.ts): an id after another flag, a flag
 * this tool does not have, a flag given twice or one that takes a value
 * followed by another flag is refused rather than dropped — `--accept-failed a
 * --dry-run b` would accept one row and exit 0 (second review pass), and `--job
 * --switch-model` read "--switch-model" as the key and backfilled the corpus
 * under it (third). Ids go right after --accept-failed. run()'s refusals of a
 * number end with the same flag list the CLI's do.
 */
const FLAGS = {
  url: "one", workers: "one", batch: "one", ttl: "one", heartbeat: "one", job: "one", retire: "one",
  "accept-failed": "many",
  status: "none", "dry-run": "none", "switch-model": "none", "retry-failed": "none", "retry-fallbacks": "none", all: "none",
} as const;
const HINTS = { url: "<postgres://…>", job: "<reembed:model@dim[:suffix]>", retire: "<reembed:model@dim[:suffix] — preflight prints it>", "accept-failed": "<thought-id …> (right after it, before any other flag)", all: "(with --accept-failed)" };

/**
 * What one re-embed run is asked to do — the CLI's flags, typed (SMD-2304).
 * A number left out takes the CLI's default, and one given is held to its
 * flag's rule and refused in the CLI's words, where the CLI refuses it:
 * --workers and --batch first, --ttl and --heartbeat after the embedding
 * configuration is judged. `acceptFailed` is --accept-failed's ids, [] for
 * the flag alone (beside `all`, or to be shown the failed rows); `retire` is
 * --retire's key. An absent option may also be null.
 *
 * `sql`, when given, is the caller's client — used in place of `url`, and
 * never closed here. It needs a connection per worker and a spare the
 * heartbeat beats through (db/lease.ts), so at least workers + 1 (the `max`
 * option), free for the run: a pool another run or caller is using at the
 * same time takes the spare. A reserved connection or a transaction's handle
 * is refused. `env` is what the run reads for the embedding model and width
 * (config.mjs's rules, embeddingContract), the provider, the chunking and the
 * egress policy: process.env when absent.
 *
 * `signal` stops the pass as the CLI's first signal does: every worker after
 * the thought in hand, its unfinished claims back to the pool. Aborted before
 * the pass begins, it stops the run before its next write — the record and
 * the pool's one transaction — and run() returns 130 (a statement already
 * committed stays so); --retire and --accept-failed stop the same way before
 * their write, saying so. --status and --dry-run only read, and do not read
 * it. `onPass` is called once, as a run's workers start — where the CLI
 * installs its signal handlers (stopOnSignals) — with the pass's stop
 * (db/lease.ts's PassStop); --status, --dry-run, the maintenance modes and a
 * run with nothing to do have no pass. Its hard stop returns the leases at
 * once, and run() returns 130 once the embedding call in hand does (at most
 * OB1_LLM_TIMEOUT per call), writing and releasing nothing more for the
 * thought in hand; a call after run() has returned does nothing.
 */
export interface ReembedOptions {
  url?: string;
  sql?: SQL;
  env?: Record<string, string | undefined>;
  workers?: number;
  batch?: number;
  ttl?: number;
  heartbeat?: number;
  job?: string;
  retire?: string;
  acceptFailed?: readonly string[];
  all?: boolean;
  status?: boolean;
  dryRun?: boolean;
  switchModel?: boolean;
  retryFailed?: boolean;
  retryFallbacks?: boolean;
  writer?: Writer;
  signal?: AbortSignal;
  onPass?: (stop: PassStop) => void;
}

/** What run() says when a caller's signal stopped --retire or --accept-failed before its write: neither has a pass. */
const stoppedBefore = (flag: string): string => `\n  stopped before ${flag} wrote anything: the caller's signal was aborted`;

/** An option held to its flag's rule, in the scanner's words and with its flag list, or the CLI's default when absent. */
function readOption(flag: string, v: number | null | undefined, absent: number): number | string {
  if (v == null) return absent;
  const problem = numberProblem(flag, v, { min: 1 });
  return problem === null ? v : `${problem}\n${flagList(FLAGS, HINTS)}`;
}

/** The run's numbers read first, or the refusal of the first that breaks its flag's rule, in the CLI's order. */
function numbers(opts: ReembedOptions): { workers: number; batch: number } | string {
  const workers = readOption("--workers", opts.workers, 2);
  if (typeof workers === "string") return workers;
  const batch = readOption("--batch", opts.batch, 8);
  if (typeof batch === "string") return batch;
  return { workers, batch };
}

/**
 * The lease's numbers, read after the embedding configuration as the CLI
 * reads them (the lease pair itself is a run's refusal, below, which --status
 * answers regardless). Whole seconds: claim_thoughts and renew_claims take
 * ints.
 */
function leaseNumbers(opts: ReembedOptions): { ttl: number; heartbeat: number } | string {
  const ttl = readOption("--ttl", opts.ttl, DEFAULT_TTL_S);
  if (typeof ttl === "string") return ttl;
  const heartbeat = readOption("--heartbeat", opts.heartbeat, heartbeatFor(ttl));
  if (typeof heartbeat === "string") return heartbeat;
  return { ttl, heartbeat };
}

/**
 * A blank value where the CLI's scanner refuses one — `--job ""` reaches no
 * run — in its words and with its flag list, or null (review pass 1: run()
 * pooled under the key ''). The scanner refuses before anything else.
 */
function blankProblem(opts: Pick<ReembedOptions, "job" | "retire" | "acceptFailed">): string | null {
  const blank = (v: string | null | undefined) => v != null && v.trim() === "";
  const problem = blank(opts.job) ? "--job is empty; give it a value"
    : blank(opts.retire) ? "--retire is empty; give it a value"
    : (opts.acceptFailed ?? []).some(blank) ? "one of --accept-failed's values is empty"
    : null;
  return problem === null ? null : `${problem}\n${flagList(FLAGS, HINTS)}`;
}

/**
 * The modes' own rule — one thing at a time (see "Saying I know": the two
 * maintenance modes write claim rows, not vectors, and combine with nothing
 * but --dry-run), and --all only with --accept-failed — as the refusal, in the
 * CLI's order and words, or null. Pure; the CLI and run() both refuse through
 * it (SMD-2304).
 */
export function modeProblem(opts: Pick<ReembedOptions, "status" | "acceptFailed" | "retire" | "switchModel" | "retryFailed" | "retryFallbacks" | "all">): string | null {
  const accepting = opts.acceptFailed != null;
  const retiring = opts.retire != null;
  const modes = [opts.status === true && "--status", accepting && "--accept-failed", retiring && "--retire"].filter(Boolean) as string[];
  const runFlags = [opts.switchModel === true && "--switch-model", opts.retryFailed === true && "--retry-failed", opts.retryFallbacks === true && "--retry-fallbacks"].filter(Boolean) as string[];
  if (modes.length > 1 || ((accepting || retiring) && runFlags.length > 0)) {
    return `  ${[...modes, ...runFlags].join(" and ")} do not combine — one thing at a time (--dry-run combines with any one of them).`;
  }
  if (opts.all === true && !accepting) return "  --all belongs to --accept-failed.";
  return null;
}

/**
 * The re-embed pass and its maintenance modes, callable: the CLI's run,
 * returning the code the CLI exits with — 0 done or nothing to do, 1 rows
 * failed, leased or pending, 2 usage, configuration, the schema or the
 * provider, 130 a signal. Nothing happens at import. A database error outside
 * a thought's own handling — the claim table's check refused, say — rejects,
 * as the CLI's stack dump always showed; run()'s own client is closed first.
 */
export async function run(opts: ReembedOptions): Promise<number> {
  const { out, err } = opts.writer ?? consoleWriter;
  const blank = blankProblem(opts);
  if (blank !== null) {
    err(blank);
    return 2;
  }
  // databaseUrl's two refusals without its exit, then the numbers and the
  // modes' rule. A URL beside a caller's client is held to the rule too.
  const noUrl = opts.url == null || opts.url.trim() === "";
  const urlProblem = noUrl ? (opts.sql == null ? NO_DATABASE_URL : null) : databaseUrlProblem(opts.url as string);
  if (urlProblem !== null) {
    err(urlProblem);
    return 2;
  }
  const settled = numbers(opts);
  if (typeof settled === "string") {
    err(settled);
    return 2;
  }
  const mode = modeProblem(opts);
  if (mode !== null) {
    err(mode);
    return 2;
  }
  if (opts.sql != null) {
    // A reserved connection or a transaction's handle reports its pool's max
    // but is one connection, and a transaction keeps the run's claims from the
    // other workers — and a rollback from the database.
    const handle = opts.sql as { release?: unknown; savepoint?: unknown };
    if (typeof handle.release === "function" || typeof handle.savepoint === "function") {
      err("reembed.ts needs a pool, not a reserved connection or a transaction's handle: either is one connection whatever max it reports, and a transaction's claims are no other worker's until it commits. Pass the client itself, or a URL.");
      return 2;
    }
    // One connection per worker and one spare: the heartbeat (db/lease.ts)
    // beats through the pool, and a worker parked on a lock or a long statement
    // holds its own connection, so the spare is what keeps every worker's
    // leases alive then. Tightening this to the workers would recreate the
    // lapse 031 removed. Bun's default pool is ten.
    const max = Number((opts.sql as { options?: { max?: number } }).options?.max ?? 10);
    if (max < settled.workers + 1) {
      err(`reembed.ts needs a client of at least ${settled.workers + 1} connections for ${settled.workers} worker(s): one each and a spare the heartbeat beats through (db/lease.ts). Pass a client opened with a larger max option, or a URL.`);
      return 2;
    }
  }
  // A signal aborted before the call: nothing opened, nothing written.
  // --status and --dry-run only read, and read on; --retire and
  // --accept-failed write, and stop as a run does.
  if (opts.signal?.aborted && opts.status !== true && opts.dryRun !== true) {
    err(opts.retire != null ? stoppedBefore("--retire") : opts.acceptFailed != null ? stoppedBefore("--accept-failed") : STOPPED_EARLY);
    return 130;
  }
  const sql = opts.sql ?? openSql(opts.url as string, { max: settled.workers + 1 });
  // Aborted when the run returns, taking its listener off the caller's signal.
  const detach = new AbortController();
  try {
    return await reembedWith(sql, opts, settled, out, err, detach.signal);
  } finally {
    detach.abort();
    // A failing close must not mask the run's own error.
    if (opts.sql == null) await sql.close().catch(() => {});
  }
}

/** The run once its options are settled: the script's body as it was, printing through the Writer and returning where it exited. */
async function reembedWith(sql: SQL, opts: ReembedOptions, settled: { workers: number; batch: number }, out: Writer["out"], err: Writer["err"], detach: AbortSignal): Promise<number> {
  const { workers: WORKERS, batch: BATCH } = settled;
  const env = opts.env ?? process.env;
  const STATUS_ONLY = opts.status === true;
  const DRY_RUN = opts.dryRun === true;
  const SWITCH_MODEL = opts.switchModel === true;
  const RETRY_FAILED = opts.retryFailed === true;
  const RETRY_FALLBACKS = opts.retryFallbacks === true;
  const ACCEPT_FAILED = opts.acceptFailed != null;
  const ACCEPT_IDS: readonly string[] = opts.acceptFailed ?? [];
  const ACCEPT_ALL = opts.all === true;
  const RETIRE = opts.retire != null;
  const RETIRE_KEY = opts.retire ?? undefined;
  /** config.mjs's EMBEDDING_MODEL, EMBEDDING_DIM and EMBEDDING_DIMENSIONS over the environment this run reads — the CLI's are those constants. */
  const { model: EMBEDDING_MODEL, dim: EMBEDDING_DIM, truncate: EMBEDDING_DIMENSIONS } = embeddingContract(env);
  /**
   * A caller's signal aborted before the pass began stops the run before its
   * next write, returning 130, as a signal before the CLI's handlers ends the
   * process where it stands.
   */
  const stoppedEarly = (line: string = STOPPED_EARLY): boolean => {
    if (opts.signal?.aborted !== true) return false;
    err(line);
    return true;
  };
  /** The pass and its target. See migration 015's header on why the target is in the key. */
  const JOB = opts.job ?? reembedKey(EMBEDDING_MODEL, EMBEDDING_DIM);
  /** Whether preflight will attribute this key to the tool — see "What preflight sees". */
  const PREFLIGHT_SEES = JOB.startsWith(REEMBED_KEY_PREFIX);
  if (!PREFLIGHT_SEES) {
    // Accepted — rows under an existing bare key must stay reachable — but said
    // once: preflight attributes a pass to this tool by the prefix.
    err(`  ⚠  --job ${JOB}: preflight will not report this pass unfinished — its key does not start with ${REEMBED_KEY_PREFIX}`);
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

  const problems = validateEmbeddingConfig(EMBEDDING_DIM, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS);
  if (problems.length > 0) {
    err("Embedding configuration is not usable:\n");
    for (const p of problems) err(`  ✗ ${p}`);
    return 2;
  }
  for (const w of embeddingConfigWarnings(EMBEDDING_DIM, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS)) err(`  ⚠  ${w}`);

  /**
   * A Writer's throw from inside processRow, the embedder's own lines
   * included, marked so the worker's catch rethrows it — the Writer's error
   * rejects run() — rather than recording it as the thought's failure on a
   * claim whose write may have gone through.
   */
  class WriterThrow {
    constructor(readonly error: unknown) {}
  }
  const errInRow = (line: string): void => {
    try {
      err(line);
    } catch (e) {
      throw new WriterThrow(e);
    }
  };

  const embedConfig = resolveEmbedConfig(env as EmbedEnv);
  // Not remembering a refusal: see "The head window, recorded" in the header.
  // Its own lines (a fallback to the head window, a blurb refused) through
  // the Writer, as a row's: a throw there is the Writer's (review pass 1).
  const embedder = createEmbedder(() => embedConfig, { rememberRefusal: false, log: errInRow });

  // The lease is renewed on a heartbeat while the worker holds rows — see the
  // header — so it has to outlast a missed beat, not the batch; db/lease.ts
  // holds the rule the three consumers share (leaseNumbers, above).
  const lease = leaseNumbers(opts);
  if (typeof lease === "string") {
    err(lease);
    return 2;
  }
  const { ttl: TTL, heartbeat: HEARTBEAT } = lease;
  // Read-only modes never claim, so they answer whatever the lease; --dry-run
  // reports the refusal a run would make, alongside the 018 check below.
  const refusalTtl: string | null = (() => {
    const r = leaseRefusal(TTL, HEARTBEAT, opts.heartbeat == null);
    return r === null ? null : ` ${r}`;
  })();

  out(`  job:       ${JOB}`);
  out(`  embedding: ${embedConfig.embeddingModel} @ ${embedConfig.embeddingDim} dimensions, via ${maskUrl(embedConfig.embeddings.base)}, ${embedConfig.timeoutMs / 1000} s per call`);
  // What may leave the box (SMD-1903): a row the gate refuses is a failed claim
  // naming the rule, retried by --retry-failed once the policy or the endpoint
  // changes; the text never went anywhere.
  out(`  egress:    ${egressDescription(embedConfig.embeddings, embedConfig.egress, localKnob(embedConfig, "embeddings"))}${embedConfig.chunkContext ? `; blurbs: ${egressDescription(embedConfig.chat, embedConfig.egress, localKnob(embedConfig, "chat"))}` : ""}`);
  {
    // A policy that refuses whatever the row (SMD-1903): stop before claiming,
    // rather than fail every row in the pool one at a time. A dry run and
    // --status still report — the banner's egress line says why a run would not.
    // Units a re-embed carries: the row's own metadata and text, never an
    // actor — this pass has no worker key (second review pass).
    const blanket = blanketGate({ endpoint: embedConfig.embeddings, policy: embedConfig.egress, units: ROW_UNITS, verb: "re-embedded", localKnobKey: localKnob(embedConfig, "embeddings") });
    // --retire and --accept-failed write claim rows, not vectors, and dial
    // nothing: bookkeeping the gate has no say over (second review pass).
    if (blanket && !STATUS_ONLY && !DRY_RUN && !RETIRE && !ACCEPT_FAILED) {
      err(`\n  ${blanket}`);
      return 2;
    }
    // The blurbs are chat calls: refused, every long row's claim fails on them
    // (a bare window is a failure here, since no caller is told) and
    // --retry-failed would revisit each uselessly. Said before the pass.
    const blurbs = embedConfig.chunkContext ? egressRefusal(embedConfig.chat, embedConfig.egress, ROW_UNITS) : null;
    if (blurbs) err(`  ⚠  OB1_CHUNK_CONTEXT is on and every blurb call would be refused (${blurbs}) — every long row's claim will fail on its blurbs; turn the context off for this pass, or declare the chat endpoint local (${localKnob(embedConfig, "chat")}=1)`);
  }
  out(`  chunks:    ${embedConfig.chunkTokens}-token windows above ${embedConfig.chunkThreshold} (${embedConfig.chunkTokensFrom === "window" ? `from ${embedConfig.embeddingModel}'s ${embedConfig.modelWindow}-token window` : embedConfig.chunkTokensFrom === "OB1_CHUNK_TOKENS" ? "OB1_CHUNK_TOKENS" : "the default, window unknown"}), overlap ${embedConfig.chunkOverlap}, context ${embedConfig.chunkContext ? `on (blurbs via ${embedConfig.chat.base})` : "off"}`);

  // ── The database's side of the contract ─────────────────────────────────────

  const [claims] = await sql`SELECT to_regclass('thought_work_claims') IS NOT NULL AS present`;
  if (!claims.present) {
    err("\n  thought_work_claims does not exist. Apply migration 015 first:\n    cd db && bun migrate.ts --url …");
    return 2;
  }

  const [col] = await sql`
    SELECT atttypmod AS width FROM pg_attribute
    WHERE attrelid = 'thoughts'::regclass AND attname = 'embedding'`;
  if (Number(col?.width) !== embedConfig.embeddingDim) {
    err(
      `\n  thoughts.embedding is vector(${col?.width}) but OB1_EMBEDDING_DIM=${embedConfig.embeddingDim}.\n` +
        `  This tool re-embeds at the column's width. A width change is a schema migration —\n` +
        `  the column, thought_chunks.embedding, both HNSW indexes and every function that\n` +
        `  names vector(${col?.width}) — and no migration for it exists yet. Set OB1_EMBEDDING_DIM=${col?.width}\n` +
        `  (with OB1_EMBEDDING_DIMENSIONS=on for a model that is wider natively) or stop here.`
    );
    return 2;
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
    out(`  ob1_config records no embedding model (migration 006 not applied?); the pass will record ${embedConfig.embeddingModel}`);
  } else if (modelChange) {
    out(`  model change: ob1_config records ${recorded.embedding_model}; this pass embeds with ${embedConfig.embeddingModel}`);
  } else if (poolModelFor(JOB) === null) {
    out(`  same model as ob1_config records — a backfill under ${JOB}: every thought without a row under it is pooled`);
  } else if (parseReembedKey(JOB) !== null && parseReembedKey(JOB)!.model !== embedConfig.embeddingModel) {
    // --status for a key naming another model (a run is refused below): the
    // counts are the key's, not this shell's, and say so.
    out(`  --job ${JOB} names ${parseReembedKey(JOB)!.model}: the counts below are judged against it, not this shell's ${embedConfig.embeddingModel}`);
  } else {
    out(`  same model as ob1_config records — this run pools the rows not at it; a same-model backfill over every row is --job ${JOB}:<suffix>`);
  }
  // The --job refusal first: a key naming another model is refused before the
  // model-change refusal below can ask for --switch-model on its behalf.
  if (refusalJob && !STATUS_ONLY && !DRY_RUN && !RETIRE && !ACCEPT_FAILED) {
    err(`\n ${refusalJob}`);
    return 2;
  }
  if (modelChange && !SWITCH_MODEL && !STATUS_ONLY && !DRY_RUN && !RETIRE && !ACCEPT_FAILED) {
    err(
      `\n  Refusing to re-embed with a model other than the one ob1_config records without --switch-model.\n` +
        `  Every vector in the corpus would be replaced by ${embedConfig.embeddingModel}'s, and ob1_config\n` +
        `  would be updated so preflight accepts a server configured for it. If that is the intent:\n` +
        `    OB1_EMBEDDING_MODEL=${embedConfig.embeddingModel} bun db/reembed.ts --url … --switch-model\n` +
        `  If OB1_EMBEDDING_MODEL is simply set wrong in this shell, fix it instead.`
    );
    return 2;
  }

  // The schema the pass writes to. The body the pass will CALL — the exact
  // ten-argument signature (046; this pass's positional eight resolve through
  // its defaults), as preflight resolves match_thoughts, not any function of that
  // name — is asked for 018's contract sentinel: a marker in pg_proc.prosrc,
  // which every CREATE OR REPLACE rewrites, rather than a field name a comment
  // could carry (a pass against 013's update_thought fails every legacy twin for
  // ever — see the header). And the column the pass reads and writes,
  // thoughts.embedding_model (021). The ledger decides the remedy: a brain
  // adopted with --baseline records the migration as applied while the body is
  // older, and "apply it" would be a no-op there. Read here so --dry-run can
  // report the refusal a run would make; --status is answered whatever the
  // schema, since it never calls update_thought.
  const [fn] = await sql`
    SELECT
      EXISTS (SELECT 1 FROM pg_proc
              WHERE oid = to_regprocedure(${"public." + UPDATE_THOUGHT_SIGNATURE})
                AND prosrc LIKE '%ob1:unchanged-edit-not-duplicate%') AS present,
      EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'thoughts' AND column_name = 'embedding_model') AS labelled,
      -- 032's nine-argument form alone: a brain at 044 under this tree, whose
      -- missing piece is 046, not 032 (SMD-1730, fourth review pass).
      EXISTS (SELECT 1 FROM pg_proc
              WHERE oid = to_regprocedure(${"public." + UPDATE_THOUGHT_SIGNATURE_9})) AS nine,
      -- 046's ten-argument form alone: a brain at 060, whose missing piece is
      -- 061 — the lineage envelope this pass sends (SMD-1731).
      EXISTS (SELECT 1 FROM pg_proc
              WHERE oid = to_regprocedure(${"public." + UPDATE_THOUGHT_SIGNATURE_10})) AS ten,
      to_regclass('schema_migrations') IS NOT NULL AS has_ledger`;
  // Asked separately: a relation named in a statement is resolved when the
  // statement is parsed, whatever the AND before it would have short-circuited,
  // so a schema applied by hand — no ledger — must not be asked about its ledger.
  // Which migration the missing piece belongs to: the column is 021's, the
  // eleven-argument body 061's when 046's ten-argument one is there, 046's when
  // 032's nine-argument one is, 032's when none is. The ledger is asked about
  // that one.
  const missingMigration = !fn.labelled ? "021" : fn.ten ? "061" : fn.nine ? "046" : "032";
  fn.ledgered = fn.has_ledger ? (await sql`SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name LIKE ${missingMigration + "%"}) AS l`)[0].l : false;
  /** Whether thoughts.embedding_model exists — the read-only modes answer without it. */
  const HAS_LABEL: boolean = Boolean(fn.labelled);
  const refusalSchema: string | null = fn.present && fn.labelled
    ? null
    : ` ${fn.labelled ? "update_thought" : "the schema"} predates migration ${missingMigration}: this pass writes the model beside every vector it stores and builds\n` +
      "  its pool from the rows not at that model, which needs thoughts.embedding_model (021) and the eleven-argument update_thought\n" +
      "  (061, carrying 046's event, 032's envelope and 018's rule — without which a pair from before the fingerprint fails on every run — and taking the lineage envelope this pass sends). " +
      (fn.ledgered
        ? `schema_migrations records ${missingMigration} as\n  applied (--baseline?) but the schema installed is older. Re-apply the recorded migrations with the migrator: it re-runs\n  every migration, pending ones included, in one transaction, and runs 021's backfill with the operator's acceptances out of its sight, so it labels\n  from real passes alone (a paste of 021's body alone labels from the acceptances too).\n  Run it from a shell configured as this brain is, with the server and every worker stopped:\n    ${REAPPLY_COMMAND}`
        : `Apply the pending migrations first (every file through ${fn.labelled ? "061" : "021"}, in order — a plain run does exactly that; ${missingMigration} alone would not):\n    cd db && bun migrate.ts --url …`);
  /**
   * What a run would refuse on, in the order a run judges them — the job, the
   * lease, the schema — spelled once for --status, --dry-run and the run.
   */
  const refusalForRun: string | null = refusalJob ?? refusalTtl ?? refusalSchema;

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
    out(`  ${label}: ${formatPassCounts(c)}`);
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
      out("  corpus:    the rows carry no model (migration 021 not applied)");
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
    out(
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
      if (PREFLIGHT_SEES) err(`  preflight will warn until this finishes: ${JOB} — ${formatPassCounts(c)}`);
      else err(`  unfinished, and preflight cannot see this key: ${JOB} — ${formatPassCounts(c)}`);
    }
    if (corpus.unaccepted > 0 && recordAgrees) err(`  preflight will warn until they are re-embedded: ${corpus.unaccepted} vector(s) at another model (its vector models check)`);
    if (corpus.noneAt && recordAgrees) err(`  preflight will warn: no vector is known to be at ${TARGET} — accepted or unlabelled rows are all it has (its vector models check)`);
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
    err(
      `\n  ${total} succeeded row(s) carry a caveat (${Math.min(total, limit)} of ${total} listed): the write stands, and the caveat is what the\n` +
        `  worker could not do — a long thought the provider refused to embed whole, stored with its head window's vector as a capture\n` +
        `  would have stored it; or a failure the operator accepted with --accept-failed, the row keeping the vector it had. --retry-fallbacks\n` +
        `  returns them to the pool once the cause — the provider, its input limit, or the refusal — has changed.`
    );
    for (const r of rows) err(`    ${r.thought_id}  ${r.last_error}`);
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
      err("  (the duplicate report needs migration 016's content_fingerprint_of — not applied here)");
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
    err(
      `\n  ${total} group(s) of thoughts share one normalised text — pairs from before migration 003's fingerprint, or a load that\n` +
        `  bypassed upsert_thought. Every row in a group is re-embedded; the one marked holds the key, so a later capture of that\n` +
        `  text merges into it and not into the others (none marked: backfill_content_fingerprints() gives it to the oldest; a pass\n` +
        `  gives it to whichever row it re-embeds first). Whether twins should be one thought is the operator's call — delete_thought\n` +
        `  on an unmarked twin keeps its text in the audit row. A holder marked STALE is not a twin: its key describes text it no\n` +
        `  longer holds, and the unmarked row(s) beside it carry that text — re-save the holder's own text through update_thought\n` +
        `  to free the key, then backfill_content_fingerprints() gives it to the oldest of them; whether several of them are twins\n` +
        `  of each other is the operator's call, as above. ${total > limit ? `First ${limit}:` : ""}`
    );
    for (const r of rows) err(`    ${r.ids.join("  =  ")}`);
    return total;
  }

  async function printFailures(limit = 10): Promise<void> {
    const rows = (await sql`
      SELECT thought_id, attempt_count, worker_id, last_error FROM thought_work_claims
      WHERE work_type = ${JOB} AND status = 'failed' ORDER BY finished_at DESC LIMIT ${limit}`) as
      { thought_id: string; attempt_count: number; worker_id: string | null; last_error: string | null }[];
    for (const r of rows) {
      err(`    ${r.thought_id}  attempt ${r.attempt_count}  ${r.last_error ?? "(no error recorded)"}`);
    }
    // The hint names what THIS shell can do: acceptance is refused under a
    // model change and under a key naming another model (third review pass).
    if (rows.length) {
      if (refusalJob) err(`    a pass to another model: once the revert stands, --retire ${JOB} removes its record; its failed rows are not this shell's to accept`);
      else if (modelChange) err(`    a row the provider refuses permanently: --accept-failed <thought-id…> once the switch is recorded (--switch-model) — it keeps its vector, and the row says so`);
      else err(`    a row the provider refuses permanently, that no retry will change: --accept-failed <thought-id…> — it keeps its vector, and the row says so`);
    }
  }

  // ── Saying "I know" — see the header ────────────────────────────────────────

  if (RETIRE) {
    const key = RETIRE_KEY!;
    const named = parseReembedKey(key);
    // Every call is returned: the refusal is run()'s code (test-engines holds that).
    const refuse = (why: string): number => {
      err(`\n  Refusing --retire ${key}: ${why} Nothing was written.`);
      return 2;
    };
    if (!key.startsWith(REEMBED_KEY_PREFIX)) return refuse(`its key does not start with ${REEMBED_KEY_PREFIX}, so it is another tool's pass, not this one's.`);
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
    if (isCurrent(currentModel)) return refuseCurrent(currentModel, recorded.embedding_model === undefined ? "configured" : "recorded");
    // The lease check and the DELETE in one transaction, the key's rows locked:
    // claim_thoughts skips locked rows, so a claim cannot be taken between the
    // two and lost under the DELETE. The DELETE takes exactly the rows locked,
    // and the record's row is read FOR UPDATE here: a --switch-model back to
    // this key's model — its record and its pool in one transaction — either
    // committed first and is seen, or waits on the row until this commits (second
    // review pass read it plainly, and a switch that locked none of the key's
    // rows could commit unseen in between — third).
    if (!DRY_RUN && stoppedEarly(stoppedBefore("--retire"))) return 130;
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
    if (outcome.total === 0) return refuse("no rows are recorded under that key — nothing to retire (a typo in the key is the likelier cause; --status --job <key> shows what a key holds).");
    if (outcome.live > 0) return refuse(`${outcome.live} row(s) under it are leased right now — a pass under this key is running; stop it first, or wait for the leases to expire.`);
    if (outcome.movedTo !== null) return refuseCurrent(outcome.movedTo, "recorded — the record moved to it while this ran —");
    if (DRY_RUN) {
      out(`\n  would: retire ${key} — remove its ${outcome.total} row(s) (${outcome.byStatus}). Nothing was written.`);
    } else {
      out(`\n  retired ${key}: ${outcome.total} row(s) removed (${outcome.byStatus}).`);
      // Judged against the CURRENT model, not this shell's — the shell that ran
      // the abandoned switch is still configured for the model it abandoned
      // (third review pass) — and worded by what the pass did.
      out(
        outcome.wrote && named !== null
          ? `  The vectors that pass wrote are still at ${named.model}; preflight's vector models check reports them until they are re-embedded:`
          : "  That pass wrote no vector; the record of it is gone and the corpus stands as it was:"
      );
      await printCorpusByModel(currentModel);
    }
    return 0;
  }

  if (ACCEPT_FAILED) {
    const refuse = (why: string): number => {
      err(`\n  Refusing --accept-failed: ${why} Nothing was written.`);
      return 2;
    };
    if (refusalJob) return refuse(refusalJob.trim());
    // 021 whole, as a run needs it: acceptance is read against the label, and
    // 021's evidence backfill — which the remedy for an older body re-runs —
    // would read an accepted row as proof the thought is AT the key's model; see
    // "Saying I know" (first and second review passes).
    if (refusalSchema) {
      return refuse(
        `${refusalSchema.trim()}\n` +
          `  --accept-failed needs the same: acceptance is read against the label, and 021's backfill reads a succeeded row — an accepted\n` +
          `  one included — as proof the thought is at the key's model.`
      );
    }
    // Ids AFTER --all are the scanner's to refuse (it takes nothing); this is the list before it.
    if (ACCEPT_ALL && ACCEPT_IDS.length > 0) {
      return refuse(`--all takes no ids beside it — name the rows, or accept every failed row under ${JOB} with --all alone.`);
    }
    if (modelChange) {
      return refuse(
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
      return refuse(
        `it needs the rows to accept, by id — --accept-failed <thought-id…> — or --all for every failed row under ${JOB}, said explicitly\n` +
          `  since a provider outage accepted that way hides itself. ${failedRows.length} failed row(s) under ${JOB}${failedRows.length ? ":\n" : "."}` +
          failedRows.slice(0, 20).map(describe).join("\n")
      );
    }
    // The stores' rule (store.ts), so the CLI refuses exactly the ids they answer null for.
    const bad = ACCEPT_IDS.filter((id) => !UUID_RE.test(id));
    // Counted, not repeated: a value --accept-failed takes may be a URL given without --url (cli.ts's rule).
    if (bad.length) return refuse(`${bad.length} of the ${ACCEPT_IDS.length} value(s) after --accept-failed ${bad.length === 1 ? "is" : "are"} not a thought id (a UUID).`);
    const failedIds = new Set(failedRows.map((r) => r.id));
    const asked = [...new Set(ACCEPT_IDS.map((id) => id.toLowerCase()))];
    const notFailed = asked.filter((id) => !failedIds.has(id));
    if (notFailed.length) {
      const states = (await sql`
        SELECT thought_id::text AS id, status FROM thought_work_claims
        WHERE work_type = ${JOB} AND thought_id = ANY(${sql.array(notFailed, "TEXT")}::uuid[])`) as { id: string; status: string }[];
      const stateOf = new Map(states.map((r) => [r.id, r.status]));
      return refuse(
        `not a failed row under ${JOB}: ${notFailed.map((id) => `${id} (${stateOf.get(id) ?? "no row"})`).join(", ")}. Only a failed row can be\n` +
          `  accepted — a pending or leased one has not been tried, a succeeded one needs nothing.`
      );
    }
    const vectorless = failedRows.filter((r) => r.vectorless);
    const noVector = asked.filter((id) => vectorless.some((r) => r.id === id));
    if (noVector.length) {
      return refuse(
        `no vector to keep: ${noVector.join(", ")}. Acceptance keeps the vector a row has; a thought with none is invisible to semantic\n` +
          `  search, and an accepted row would be the last thing to say so. Delete the thought, or fix its text and --retry-failed.`
      );
    }
    const editedSince = failedRows.filter((r) => r.edited_since);
    const edited = asked.filter((id) => editedSince.some((r) => r.id === id));
    if (edited.length) {
      return refuse(
        `written since the attempt read it: ${edited.join(", ")}. The content the provider refused is not the content the row has now, and\n` +
          `  the acceptance would be void as written — every reader applies that bound, and the next run would return the row with it gone.\n` +
          `  --retry-failed tries the new content; accept what still fails.`
      );
    }
    const passedOver = ACCEPT_ALL ? failedRows.filter((r) => r.vectorless || r.edited_since) : [];
    const ids = ACCEPT_ALL ? failedRows.filter((r) => !r.vectorless && !r.edited_since).map((r) => r.id) : asked;
    if (ids.length === 0) return refuse(`no failed rows under ${JOB}${passedOver.length ? ` to accept as they are (${passedOver.length} passed over, listed by --status)` : ""} — nothing to accept.`);
    const idSet = new Set(ids);
    const chosen = failedRows.filter((r) => idSet.has(r.id));
    const sayPassedOver = () => {
      if (!passedOver.length) return;
      err(
        `  ${passedOver.length} failed row(s) were not accepted — a thought with no vector has nothing to keep, and nothing would say afterwards that it is invisible\n` +
          `  to search (delete it, or fix its text and --retry-failed); one written since the attempt read it has content the provider never saw (--retry-failed\n` +
          `  tries it; accept what still fails):`
      );
      for (const r of passedOver) err(describe(r));
    };
    if (DRY_RUN) {
      out(`\n  would: accept ${chosen.length} failed row(s) under ${JOB} — each becomes succeeded with the caveat "${ACCEPTED_CAVEAT_PREFIX}<the failure>", keeping the vector it has:`);
      for (const r of chosen) out(describe(r));
      sayPassedOver();
      out("  Nothing was written.");
      return 0;
    }
    // The row's timestamps stay the failure's — the bound is claimed_at (see the
    // header). 015 stamps finished_at on every failed row, released or reaped;
    // the COALESCE covers a hand-written one.
    // What is printed is what was written: a row another process returned to the
    // pool between the list above and this statement is not accepted, and is not
    // listed as if it were (first review pass).
    if (stoppedEarly(stoppedBefore("--accept-failed"))) return 130;
    const written = (await sql`
      UPDATE thought_work_claims
         SET status = 'succeeded', finished_at = COALESCE(finished_at, now()),
             last_error = ${ACCEPTED_CAVEAT_PREFIX} || COALESCE(last_error, '(no error recorded)')
       WHERE work_type = ${JOB} AND status = 'failed' AND thought_id = ANY(${sql.array(ids, "TEXT")}::uuid[])
       RETURNING thought_id::text AS id, last_error`) as { id: string; last_error: string }[];
    out(
      `\n  ${written.length} failed row(s) accepted under ${JOB}${ACCEPT_ALL ? " (--all: a provider outage accepted this way hides itself; --status lists the caveats)" : ""}` +
        ` — each keeps the vector it has, and its row says so:`
    );
    for (const r of written) out(`    ${r.id}  ${r.last_error}`);
    if (written.length < chosen.length) err(`  ${chosen.length - written.length} of the rows named left 'failed' meanwhile — returned to the pool by another process — and were not accepted.`);
    sayPassedOver();
    out("  --retry-fallbacks returns them to the pool on the day the cause changes; an edit to the thought reopens it by itself.");
    const c = await counts();
    printCounts(c, "status");
    const corpus = await printCorpusByModel();
    printPreflightNote(c, corpus, judgedAsPreflight(false));
    return 0;
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
    if (STATUS_ONLY && !DRY_RUN && refusalForRun) err(`\n  a run would refuse:${refusalForRun}`);
    if (c.claimed > 0) for (const h of await leaseHolders(sql, JOB)) out(describeHolder(h));
    if (c.failed > 0) {
      err(`  failed rows (${Math.min(c.failed, 10)} of ${c.failed}):`);
      await printFailures();
    }
    if (c.fellBack > 0) await printFallbacks(c.fellBack);
    await printDuplicateGroups();
    if (DRY_RUN) {
      if (refusalForRun) {
        err(`\n  would: refuse.${refusalForRun}`);
        return 2;
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
      out(
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
    return 0;
  }

  // ── The run ─────────────────────────────────────────────────────────────────

  if (refusalForRun) {
    err(`\n ${refusalForRun}`);
    return 2;
  }

  // The provider first, so a wrong URL or a wrong width fails before any row is
  // touched — the width check inside getEmbedding names the model and both widths.
  // The probe is the egress gate's subject too (SMD-1903): a constant with no
  // row behind it, so under terms that read the row (type:, source:) it is
  // refused where every pooled row would pass. Skipped then, and said — the
  // first row stands in — rather than blamed on the provider (first review
  // pass: the probe was called without a subject and crashed under any policy
  // that read one).
  const probeSubject = { kind: "re-embed" as const };
  const probeGate = mayLeaveBox(probeSubject, embedConfig.embeddings, embedConfig.egress);
  /**
   * Whether the provider has answered once — the probe, or a first row
   * processed to any outcome. While it has not, a row's failure that is not the
   * gate's is read as the provider's answer (a wrong width, a wrong URL) and
   * stops the run, so a skipped probe does not turn a configuration error into
   * a pool marked failed one row at a time (second review pass).
   */
  let probed = false;
  /**
   * Set by the stand-in when the provider's first answer was a failure shaped
   * like the configuration's: the workers return, the row in hand is recorded,
   * the rest stay pending, and the run exits 1 with the pending hint — not
   * `stopping`, which is the operator's Ctrl-C and exits 130 (third review pass).
   */
  let haltedByProvider = false;
  /**
   * Whether a failure reads as the configuration's — a wrong width, no
   * embedding in the reply, a body that is not JSON, a model or a route the
   * endpoint refuses (400–404) — rather than this row's or the moment's: a
   * timeout, a 408/429, a 5xx, a dropped connection and a database error are
   * all left to the row, since the probe's stand-in must not halt a run on a
   * rate limit (third review pass).
   */
  function configShaped(e: unknown): boolean {
    // 402 included (fifth review pass): a hosted provider out of credit answers
    // it, and that is the account's state, not the row's.
    if (e instanceof ProviderError) return e.kind === "body" || (e.kind === "http" && [400, 401, 402, 403, 404].includes(e.status ?? 0));
    const msg = (e as Error).message ?? "";
    return /Embedding width mismatch|returned no embedding/.test(msg);
  }
  if (!probeGate.allowed) {
    out(`  probe:     skipped — ${probeGate.reason}; the first row stands in: a configuration-shaped failure there (a wrong width, no embedding, a non-JSON body, a 400–404) halts the run, anything else is the row's`);
  } else {
    try {
      await embedder.getEmbedding("reembed.ts provider probe", probeSubject);
      probed = true;
    } catch (e) {
      err(`\n  The embedding provider is not usable: ${(e as Error).message}`);
      return 2;
    }
  }

  // The record and the pool, in one transaction — see "Changing model" in the
  // header. Nothing below is printed until it has committed, so what the
  // operator reads is what the database holds.
  type Start = { restarted: number; movedSinceDone: number; retriedFailed: number; retriedFallbacks: number; added: number };
  if (stoppedEarly()) return 130;
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
    err(
      `\n  Could not start the pass: ${(e as Error).message}\n` +
        `  Nothing was written — the record and the pool are as they were. If another process is claiming under this key\n` +
        `  right now, its reaper and this start took the same expired leases in opposite orders; run again.`
    );
    return 2;
  }
  if (recordModel) {
    out(`  ob1_config.embedding_model = ${embedConfig.embeddingModel} — a server configured for it now passes preflight; switch it.`);
  }
  if (start.restarted > 0) {
    out(`  ${modelChange ? "model change" : "no model was recorded"}: this pass starts over — ${start.restarted} ${BACKFILL ? "terminal" : "failed"} row(s) or expired lease(s) from before the change returned to the pool`);
  }
  if (start.movedSinceDone > 0) {
    out(`  ${start.movedSinceDone} succeeded row(s) whose thought is not at ${embedConfig.embeddingModel} returned to the pool — captured or edited since by a server on another model`);
  }
  if (RETRY_FAILED) out(`  --retry-failed: ${recordModel ? "nothing to do separately — recording the model returned every failed row under this job to the pool" : `${start.retriedFailed} failed row(s) returned to the pool`}`);
  if (RETRY_FALLBACKS) out(`  --retry-fallbacks: ${start.retriedFallbacks} row(s) succeeded with a caveat returned to the pool`);
  const before = await counts();
  out(`  pool: ${start.added} thought(s) added`);
  printCounts(before, "before");
  const corpusBefore = await printCorpusByModel();
  {
    const unlabelled = await unlabelledPooled(true);
    if (unlabelled > 0) err(`  ${unlabelled} of the rows to re-embed are unlabelled — nothing vouches for their model — and this pass is what labels them`);
  }

  const total = before.pending + before.claimed;
  if (total === 0) {
    out("\n  Nothing to do.");
    if (before.failed > 0) {
      err(`  ${before.failed} failed row(s) remain from an earlier run — pass --retry-failed to try them again:`);
      await printFailures();
      printPreflightNote(before, corpusBefore, judgedAsPreflight(recordModel));
      return 1;
    }
    return 0;
  }

  const toVector = (v: number[]) => `[${v.join(",")}]`;
  // `via`, the door (046's origin column) — `source` until SMD-1730, when the
  // trigger stopped reading an actor's source; the row's own stays the column.
  const actor = actorPayload({ name: "reembed", via: "db/reembed.ts", session: JOB });

  let stopping = false;
  /**
   * Set by the hard stop, which has returned every worker's leases: a worker
   * writes and releases nothing more — the thought in hand is the pool's
   * again, and may already be another worker's.
   */
  let hardStopped = false;
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
    out(
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
  type Row = { id: string; content: string; updated_at: Date; metadata: Record<string, unknown> | null };

  /**
   * Embed and write one thought. Returns "succeeded" — with a caveat when the
   * write fell short of what was asked and the row should say so — "failed" with
   * an error, or "vanished" when the thought was deleted after it was claimed.
   */
  type Outcome = { outcome: "succeeded"; caveat?: string } | { outcome: "failed"; error: string } | { outcome: "vanished" } | { outcome: "abandoned" };

  async function processRow(row: Row): Promise<Outcome> {
    let current = row;
    for (let attempt = 0; attempt < 3; attempt++) {
      // The hard stop came during the re-read below: the row is the pool's
      // again, and its text is not sent (review pass 1).
      if (hardStopped) return { outcome: "abandoned" };
      // The row's own metadata is what the gate reads — source, type, topics —
      // and an egress refusal throws out of here as a failed claim (SMD-1903).
      const embedded = await embedder.embedCapture(current.content, { kind: "re-embed", metadata: current.metadata ?? undefined, content: current.content });
      // The hard stop came while the provider answered: the leases are
      // returned, so the vector is not written.
      if (hardStopped) return { outcome: "abandoned" };
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
          ${embedded.model}::text,
          NULL::jsonb,
          NULL::jsonb,
          ${chunks.length ? { chunks: chunkRecipe(embedConfig, embedded) } : null}::jsonb
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
          errInRow(`  ${current.id}: duplicates ${result.duplicate_of} — the same text, which deduplication could not see because this row had no fingerprint; re-embedded, see the summary`);
        } else if (result.fingerprint_held_by) {
          // Another row carries this text's key under DIFFERENT text — a stale
          // fingerprint from a raw update around update_thought — so this row
          // could not take the fingerprint it should have. The key is the other
          // row's problem, and re-saving its own text fixes it.
          errInRow(`  ${current.id}: could not take its fingerprint — ${result.fingerprint_held_by} holds that key under other text (a stale fingerprint; re-saving that thought's own text corrects it)`);
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
        const [fresh] = (await sql`SELECT id, content, COALESCE(updated_at, created_at) AS updated_at, metadata FROM thoughts WHERE id = ${current.id}::uuid`) as Row[];
        if (!fresh) return { outcome: "vanished" };
        current = fresh;
        continue;
      }
      // Anything else is reported as what it is. Not an error code at all: a
      // load that inserted the same text around upsert_thought while this row
      // is fingerprinted raises a unique violation into the catch in worker():
      // failed with the constraint named, and --retry-failed then finds the
      // other row and reports duplicate_of. A CAPTURE of that text cannot do
      // this since migration 033: upsert_thought takes 018's fingerprint lock,
      // so the two are serialised and the later one is told, not refused.
      return { outcome: "failed", error: `update_thought: ${result.error}` };
    }
    return { outcome: "failed", error: "update_thought: STALE_READ or DUPLICATE_CONTENT three times in a row — the thought is being edited faster than it can be re-embedded; --retry-failed once it settles" };
  }

  /**
   * The Writer's err for lines written on a timer or an event — the heartbeat's,
   * the caller's signal's — where a throw has no caller to reject and would be
   * the host's unhandled error: it is dropped there.
   */
  const errAside = (line: string): void => {
    try {
      err(line);
    } catch {
      // Nothing awaits this line.
    }
  };

  async function worker(n: number): Promise<void> {
    // Globally unique: release_claims_for_worker matches on this alone, and a
    // bare pid collides across containers.
    const workerId = `reembed-${hostname()}-${process.pid}-${n}-${randomUUID().slice(0, 8)}`;
    activeWorkers.add(workerId);
    const hb = startHeartbeat({
      sql, job: JOB, workerId, ttlS: TTL, everyS: HEARTBEAT,
      onLost: (ids) => { if (!hardStopped) errAside(`  ${workerId}: ${ids.length} row(s) no longer this worker's at the last beat — reaped, requeued by an edit, or deleted; each is named as the loop reaches it, or at its release if it was the row in hand`); },
      onError: (e, consecutive) => { if (consecutive === 1) errAside(`  ${workerId}: heartbeat failed (${e.message}); the leases hold ${TTL} s from the last beat that reached the database`); },
    });
    try {
      while (!stopping && !haltedByProvider) {
        let batch: { thought_id: string; attempt: number }[];
        let byId: Map<string, Row>;
        try {
          batch = (await sql`
            SELECT thought_id, attempt FROM claim_thoughts(${JOB}, ${workerId}, ${BATCH}, ${TTL})`) as { thought_id: string; attempt: number }[];
          if (batch.length === 0) return;
          const ids = batch.map((b) => b.thought_id);
          hb.claimed(ids);
          const rows = (await sql`
            SELECT id, content, COALESCE(updated_at, created_at) AS updated_at, metadata FROM thoughts WHERE id = ANY(${sql.array(ids, "TEXT")}::uuid[])`) as Row[];
          byId = new Map(rows.map((r) => [r.id, r]));
        } catch (e) {
          // A database error here is not about one thought. This worker stops;
          // the others carry on, and the finally below hands back what it holds.
          err(`  ${workerId}: ${(e as Error).message} — this worker stops`);
          return;
        }
        for (const b of batch) {
          if (stopping || haltedByProvider) return;
          if (hb.lost.has(b.thought_id)) {
            // A beat found this row no longer ours. Nothing to release, and
            // repeating the provider's work would only race the holder; the row
            // says why (db/lease.ts reportLost), and which count it joins.
            if ((await reportLost(sql, JOB, workerId, b.thought_id, err)) === "deleted") vanished++;
            else lost++;
            continue;
          }
          const row = byId.get(b.thought_id);
          if (b.attempt > 1) err(`  ${b.thought_id}: attempt ${b.attempt} — an earlier lease on it expired`);
          let outcome: Outcome;
          if (!row) {
            outcome = { outcome: "vanished" };
          } else {
            try {
              outcome = await processRow(row);
              probed = true;
            } catch (e) {
              if (e instanceof WriterThrow) throw e.error;
              const msg = (e as Error).message.slice(0, PROVIDER_ERROR_CHARS);
              outcome = { outcome: "failed", error: msg };
              // The skipped probe's stand-in (see `probed`): the provider's
              // first answer was a failure shaped like the configuration's, so
              // it is not this row's. This row is recorded; the rest stay
              // pending rather than fail the same way in turn.
              if (!probed && configShaped(e)) {
                err(`  ${workerId}: the first row failed before any succeeded — ${msg} — read as the provider's answer, not the row's; halting so the pool is not marked failed row by row (this row is recorded failed, --retry-failed revisits it; the rest stay pending for the re-run)`);
                haltedByProvider = true;
              }
            }
          }
          // The hard stop returned this row's lease while it was in hand: it is
          // the pool's again, so nothing of it is released or counted here.
          if (hardStopped || outcome.outcome === "abandoned") return;
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
            err(`  ${b.thought_id}: could not release the claim (${(e as Error).message}) — this worker stops`);
            return;
          }
          if (gone) {
            vanished++;
            err(`  ${b.thought_id}: deleted while it was being re-embedded`);
            progress();
            continue;
          }
          if (!ok) {
            // The lease expired and the row is not ours to finish; our write to
            // `thoughts`, if we made one, stands — the same vector twice at
            // worst, harmless. Counted with the rows this worker lost, not the
            // ones it finished, so the workers' summaries add up across a pass.
            err(`  ${b.thought_id}: the claim was no longer this worker's at release — its lease lapsed (no beat reached the database for ${TTL} s), it was returned by hand with release_claims_for_worker, or it failed at its last allowed expiry; the row is the pool's, another worker's, or failed now`);
            if (outcome.outcome === "failed") err(`  ${b.thought_id}: ${outcome.error} (not recorded — the row was not this worker's)`);
            else if (outcome.caveat) err(`  ${b.thought_id}: ${outcome.caveat} (not recorded — the row was not this worker's)`);
            lost++;
            progress();
            continue;
          }
          if (outcome.outcome === "failed") {
            failed++;
            err(`  ${b.thought_id}: ${outcome.error}`);
          } else {
            done++;
            if (outcome.caveat) err(`  ${b.thought_id}: ${outcome.caveat}`);
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
      let freed = 0;
      try {
        [{ n: freed }] = await sql`SELECT release_claims_for_worker(${JOB}, ${workerId}) AS n`;
      } catch (e) {
        err(`  ${workerId}: could not return its leases (${(e as Error).message}); they expire within ${TTL} s`);
      }
      activeWorkers.delete(workerId);
      // Outside the release's try: a Writer's throw here is the Writer's, not a
      // lease left unreturned.
      if (freed > 0) err(`  ${workerId}: returned ${freed} unfinished row(s) to the pool`);
    }
  }

  // The pass's stop (db/lease.ts's PassStop), handed to the caller here, where
  // the script installed its signal handlers — before this a signal ends the
  // CLI at once. One while already stopping is the hard stop: a worker may be
  // inside a call it cannot leave — a provider call has OB1_LLM_TIMEOUT to
  // answer, but a database call has nothing — so it may not reach its own
  // finally; the release of every worker's leases, from here, the CLI exiting
  // 130 when it settles.
  const stop: PassStop = () => {
    // After the run has returned there is no pass to stop.
    if (detach.aborted) return null;
    if (stopping) {
      hardStopped = true;
      // Started before the line is written: a Writer that throws does not keep the leases.
      const release = Promise.all([...activeWorkers].map((w) => sql`SELECT release_claims_for_worker(${JOB}, ${w})`.catch(() => null)));
      err(`\n  second signal — exiting now; leases not returned in time expire within ${TTL} s`);
      return release;
    }
    stopping = true;
    err("\n  stopping after the current thought; unfinished claims go back to the pool (again to exit now)");
    return null;
  };
  // A caller's signal is a first stop, in words that promise no second; its
  // listener goes when the run returns (`detach`, run()'s).
  const abort = () => {
    if (stopping) return;
    stopping = true;
    errAside("\n  stopping after the current thought; unfinished claims go back to the pool");
  };
  if (stoppedEarly()) return 130;
  opts.signal?.addEventListener("abort", abort, { once: true, signal: detach });
  opts.onPass?.(stop);

  out(`\n  ${WORKERS} worker(s), ${BATCH} per claim, ${TTL} s leases renewed every ${HEARTBEAT} s\n`);
  // A worker that throws — a Writer that throws, in practice; each catches its
  // own database errors — stops the rest after the thought in hand, and run()
  // rejects with its error once they have stopped, not while they still hold
  // rows and the client.
  const ends = await Promise.allSettled(Array.from({ length: WORKERS }, (_, i) => worker(i).catch((e: unknown) => {
    stopping = true;
    throw e;
  })));
  const thrown = ends.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (thrown) throw thrown.reason;
  progress(true);

  const after = await counts();
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  out(`\n  ${done} re-embedded, ${failed} failed, ${vanished} deleted mid-pass${lost ? `, ${lost} no longer this worker's when checked (each named above)` : ""}, in ${elapsed}s, ${beats} heartbeat(s)`);
  printCounts(after, "after");
  await printDuplicateGroups();
  if (after.fellBack > 0) await printFallbacks(after.fellBack);
  if (after.failed > 0) {
    err(`\n  failed rows (${Math.min(after.failed, 10)} of ${after.failed}) — fix the cause and re-run with --retry-failed:`);
    await printFailures();
  }
  const corpusAfter = await printCorpusByModel();
  if (after.unpooled > 0) {
    // Under the model's own key: captured or edited while the pass ran, by a
    // server on another model — the rows say so (021), and a re-run takes exactly
    // them. Under a backfill key every capture made meanwhile is unpooled,
    // whatever model it is at, and nothing about the server follows from it.
    err(
      BACKFILL
        ? `\n  ${after.unpooled} thought(s) captured while the pass ran have no row under this job; re-run to pool them.`
        : `\n  ${after.unpooled} thought(s) are not at ${TARGET} and have no row under this job — captured or edited while the pass ran\n` +
            `  by a server on another model, by one older than 021 (no label), or through a fallback that stores no vector. Switch or upgrade the\n` +
            `  server if that is what it was, then re-run: the pool takes exactly them.`
    );
  }
  printPreflightNote(after, corpusAfter, judgedAsPreflight(recordModel));
  if (after.claimed > 0) {
    err(
      `\n  ${after.claimed} row(s) are still leased — by another process running this job, or left by a worker that failed.\n` +
        `  They return to the pool when their leases expire (within ${TTL} s of the holder's last heartbeat); re-run then, or watch --status —\n` +
        `  which names each holder; a holder that is dead can be returned at once: SELECT release_claims_for_worker(job, worker_id).`
    );
  }
  if (after.pending > 0 && !stopping) {
    // Every worker stopped before the pool was empty — a database error each
    // (their messages are above), or the provider's first answer was a
    // configuration-shaped failure — and handed its leases back. Not done.
    err(`\n  ${after.pending} row(s) are still pending: every worker stopped before the pool was empty${haltedByProvider ? " — the provider's first answer was a failure (above); fix it, then --retry-failed and re-run" : ". Re-run"}.`);
  }
  return stopping ? 130 : after.failed > 0 || after.claimed > 0 || after.pending > 0 ? 1 : 0;
}

if (import.meta.main) {
  const cli = commandLine("reembed.ts", FLAGS, { hints: HINTS });
  const url = databaseUrl(cli.value("url"));
  const workers = cli.int("workers", { absent: 2, min: 1 });
  const batch = cli.int("batch", { absent: 8, min: 1 });
  const modes = {
    status: cli.has("status"),
    switchModel: cli.has("switch-model"),
    retryFailed: cli.has("retry-failed"),
    retryFallbacks: cli.has("retry-fallbacks"),
    acceptFailed: cli.has("accept-failed") ? cli.values("accept-failed") : undefined,
    all: cli.has("all"),
    retire: cli.value("retire"),
  };
  // The modes' rule before the client, where the script refused it: a URL
  // Bun's client rejects still meets it first. run() refuses through the same
  // function.
  const mode = modeProblem(modes);
  if (mode !== null) {
    console.error(mode);
    process.exit(2);
  }
  // --ttl and --heartbeat as the numbers they read, judged by run() where the
  // script judged them — after the embedding configuration — so a command
  // breaking two rules is refused for the one it always was.
  const lenient = (flag: "ttl" | "heartbeat") => (cli.has(flag) ? numberIn(cli.value(flag) ?? "") : undefined);
  // One connection per worker and a spare (run()'s rule), opened lazily: a
  // refusal before the first query opens none.
  const sql = openSql(url, { max: workers + 1 });
  // The signal handlers go when run() settles: a signal while the door closes
  // the pool and flushes ends the process, as one before the pass does.
  let uninstall = () => {};
  await closeThenExit(sql, async () => {
    return run({
      sql, url, workers, batch, ttl: lenient("ttl"), heartbeat: lenient("heartbeat"),
      job: cli.value("job"),
      ...modes,
      dryRun: cli.has("dry-run"),
      onPass: (stop) => { uninstall = stopOnSignals(stop); },
    }).finally(() => uninstall());
  });
}
