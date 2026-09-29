#!/usr/bin/env bun
/**
 * extract-entities.ts — extract entities and relationships from every thought,
 * in parallel, resumably, and keep doing it for new ones.
 *
 * The second consumer of migration 015's lease table, and the worker for
 * migration 016's tables. Each thought goes to the metadata model — once when
 * it fits the extraction window, once per window when it does not
 * (server-portable/entities.ts holds the prompt, the parsing rules, the
 * windowing and the merge; SMD-1879) — and the result is written through
 * `record_thought_entities`, which replaces the thought's mentions and edges
 * wholesale — so running this twice over an unchanged corpus writes nothing
 * new, and running it after an edit leaves only what the new text says.
 *
 *   bun db/extract-entities.ts --url postgres://…             # the backlog, then exit
 *   bun db/extract-entities.ts --url … --follow [SECONDS]     # …then keep polling for new captures
 *   bun db/extract-entities.ts --url … --limit 25             # a trial: this many thoughts, then stop
 *   bun db/extract-entities.ts --url … --status               # where the pass stands, and what it has found
 *   bun db/extract-entities.ts --url … --dry-run              # what a run would do; writes nothing
 *   bun db/extract-entities.ts --url … --retry-failed         # failed rows back into the pool first
 *   bun db/extract-entities.ts --url … --retry-partial        # rows extracted in part back into the pool — after raising OB1_EXTRACT_MAX_WINDOWS
 *   bun db/extract-entities.ts --url … --retry-left-out       # …only those with windows left out as malformed — after a change of model, kept to this pool with --job (below)
 *   OB1_METADATA_MODEL=<larger> bun db/extract-entities.ts --url … --job <the recorded key> --retry-left-out --limit N   # a larger model over those N rows, the key and trigger left as they are (--status prints it)
 *   bun db/extract-entities.ts --url … --dump answers.jsonl   # also append every model answer, for evals/eval-entities.ts --replay
 *   bun db/extract-entities.ts --url … --switch-key           # required when the model or prompt version differs from ob1_config
 *   --workers N (2)   --batch N (1)   --ttl SECONDS (900)   --heartbeat SECONDS (60, or a third of the lease; at least 1, and the lease must cover two)   --timeout SECONDS (300, per model call — per window of a long thought)
 *   exits 0 clean (partial rows included) · 1 rows failed, leased or pending · 2 usage, configuration or the provider's refusal · 3 the model likely at fault (SMD-2266, ahead of 1) · 130 a signal (a second, at once); --follow stopped by one signal exits 0
 *
 * ── The cost, and the switch ────────────────────────────────────────────────
 * One LLM call per thought — per window of a thought over the extraction
 * window, so a 13,000-character thought is four or five smaller calls rather
 * than one that never ends (SMD-1879) — recurring: every new capture is extracted too. On
 * the fork's default — Ollama, `qwen2.5:7b` — that is compute and latency on
 * your own machine and nothing leaves it. Pointed at a hosted provider it is
 * money, per thought, for ever, and the content of every thought goes to that
 * provider rather than only the ones someone searches for. FORK.md change 30
 * has the measured wall clock for a full pass.
 *
 * Two workers by default, and the number was measured three times because the
 * first two readings disagreed and both were partly wrong. The 441-issue corpus
 * at two workers and a 120 s per-call timeout: 4,941 s. One worker at 300 s:
 * 6,793 s — read at the time as the second worker buying a third of the wall
 * clock. Two workers at 300 s, the like-for-like pair: 6,480 s, 4.6% faster
 * than one. The earlier gap was the timeout budget, not concurrency; per
 * completed document the two-worker passes spent about twice the worker-seconds,
 * which is what a serialising local Ollama looks like. Two stays the default
 * because it costs nothing and recovers a little; do not expect more. The
 * timeouts (21, 11, 19 across the three passes) were read as long documents
 * whose extraction genuinely takes minutes on a 7B model; measured again for
 * SMD-1879 they were answers that did not end — the model repeating one
 * relation until the context ran out — and the windows plus the per-call
 * answer budget (entities.ts) turn them into fast, visible failures or, for
 * the long ones, into extractions. --workers beyond two is for a hosted
 * provider that really does serve calls in parallel.
 *
 * One thought is extracted in at most OB1_EXTRACT_MAX_WINDOWS windows (24
 * unset), and runs chunk.ts cannot split are cut where the thought's text
 * reaches that many windows' worth (server-portable/entities.ts,
 * boundedWindows). A
 * longer one — an ingested PDF, a page, a long
 * session summary — is extracted over its first windows and its claim is
 * released succeeded with a caveat: migration 028's rule, last_error on a
 * succeeded row, here beginning "partial: " and naming how many windows of how
 * many (SMD-2240). Until SMD-2240 such a thought was failed before any call
 * and contributed nothing to the graph. A thought some of whose windows the
 * model answered malformed is the second kind of partial row, its caveat
 * naming those windows (SMD-2260, below). The run's summary and --status count
 * the partial rows apart from the full ones and from the failures, each kind
 * apart, and list them; raise OB1_EXTRACT_MAX_WINDOWS and --retry-partial
 * returns them to the pool, where record_thought_entities replaces the
 * prefix's rows with the longer reading's. A row failed by the old rule ("over EXTRACT_MAX_WINDOWS
 * (24); not extracted") comes back with --retry-failed and is extracted so.
 *
 * Nothing spends it until this runs. The first run writes the extraction key
 * to `ob1_config.entity_extraction_key`; from then on migration 016's trigger
 * enqueues every new or edited thought, and either the next run or a `--follow`
 * process extracts it. To stop: delete that row and the trigger goes quiet.
 *
 * ── Identity ────────────────────────────────────────────────────────────────
 * The worker authenticates like any client: OB1_WORKER_KEY holds a raw access
 * key whose hash is in MCP_ACCESS_KEYS, and the run resolves it through
 * `resolve_agent` to a stable agent id, which every mention and edge it writes
 * carries. A revoked key refuses to run. Without a key the rows carry NULL and
 * the run says so once; it does not refuse, because on a single-operator box
 * the attribution is not in doubt.
 *
 * ── What the model is and is not asked ──────────────────────────────────────
 * The model is asked for names and types; deciding whether two names are one
 * entity is the database's (`normalize_entity_name`, migration 016). A
 * malformed answer — not JSON, or not the shape — is a failure for that
 * thought, retryable with --retry-failed; so is a timeout, which the corpus run
 * showed is a property of the longest thoughts rather than of the moment.
 * A windowed thought's malformed window is not (SMD-2260): the windows that
 * parsed are written and the claim is released succeeded with a caveat naming
 * the windows left out, a second kind of partial row, counted and listed
 * apart from a prefix, whenever at least one other window parsed; a thought
 * none of whose windows parsed is failed as malformed. So a model that
 * answers a large share of windows malformed writes partial rows, not failed
 * ones, and the run watches the share instead (SMD-2266, db/config.mjs's
 * malformedAlarm): when more than a fifth of at least 48 answers — one per
 * window of each thought that returned — were malformed, it says on stderr
 * that the model is likely at fault and exits 3, ahead of the 1 of rows
 * failed, leased or pending. A --follow process judges blocks of 48 or more
 * after each pass drains the pool, so one started on a backlog says nothing
 * until the backlog is done (try a new model with --limit 48 first); stopped
 * by a signal it exits 0, and at its --limit with a block tripped, 3. A
 * thought's own share is not judged: a reference list is its text's fault,
 * not the model's. A
 * rate limit, a server error or a lost connection is neither: the worker
 * pauses and retries, and stops if the provider stays down, leaving its leases
 * to return to the pool rather than marking thoughts failed for it. A content
 * edit that lands while a thought is being extracted makes
 * `record_thought_entities` refuse with stale=true; the trigger has already
 * re-queued the thought, so the worker moves on and the pool redoes it.
 *
 * Changing the model or the prompt version changes the key. A run under a key
 * other than the recorded one needs --switch-key, as a re-embed under another
 * model needs --switch-model: record_thought_entities replaces a thought's rows
 * whatever key wrote them, so a partial run under a second model leaves a
 * per-thought mixture that nothing repairs.
 */

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { PROVIDER_ERROR_CHARS, refusesLength, resolveEmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { localKnob, ROW_UNITS } from "../server-portable/egress.ts";
import { blanketGate, egressDescription, egressRefusal, regateMessage, workerIdentity } from "./worker-bootstrap.ts";
import { callsMadeBy, callsOf, describeExtractWindow, extractEntities, extractionKey, MALFORMED_WINDOWS_MARK, OVER_BOUND_MARK, PARTIAL_CAVEAT_PREFIX, partialCaveat, windowingFor, windowList, type Extraction } from "../server-portable/entities.ts";
import { entityRecipe } from "../server-portable/lineage.ts";
import { decideEntities } from "../server-portable/hybrid-extract.ts";
import { resolveJevConfig, type JevEnv } from "../server-portable/jev.ts";
import { DEFAULT_HEARTBEAT_S, DEFAULT_TTL_S, describeHolder, heartbeatFor, leaseHolders, leaseRefusal, reportLost, startHeartbeat } from "./lease.ts";
import { commandLine } from "./cli.ts";
import { databaseUrl, openSql } from "./connect.ts";
import { EXTRACT_MALFORMED_ALARM_MIN, EXTRACT_MALFORMED_ALARM_SHARE, malformedAlarm } from "./config.mjs";

/**
 * Every argument accounted for (db/cli.ts): a flag this worker does not have,
 * or one given twice, is refused before anything is claimed — a mistyped
 * `--workers` ran the default and exited 0 (SMD-2015). A numeric flag present
 * with no value is an error, not the default: `--limit` typed alone meant "no
 * limit" once, and sent the whole backlog to the model. --follow's value is
 * optional: a poll interval with a sensible default.
 */
const cli = commandLine("extract-entities.ts", {
  url: "one", workers: "one", batch: "one", ttl: "one", heartbeat: "one", timeout: "one", limit: "one",
  follow: "optional", dump: "one", job: "one",
  status: "none", "dry-run": "none", "switch-key": "none", "retry-failed": "none", "retry-partial": "none", "retry-left-out": "none", decide: "none",
}, { hints: { url: "<postgres://…>", follow: "[SECONDS]", dump: "<answers.jsonl>", job: "<the recorded key>" } });

const url = databaseUrl(cli.value("url"));

const WORKERS = cli.int("workers", { absent: 2, min: 1 });
// One thought per claim. A claim costs half a millisecond against a model call
// of ten seconds or more, so a bigger batch buys nothing, and a worker that
// dies holds fewer rows. (Until migration 031 there was a second reason: the
// lease was stamped per claim and could not be moved, so a batch of four at a
// 300 s timeout could outlive a 900 s lease and be extracted twice. The
// heartbeat retires it.)
const BATCH = cli.int("batch", { absent: 1, min: 1 });
// The lease is renewed on a heartbeat while the worker holds rows, so it has
// to outlast a missed beat, not the batch — db/lease.ts holds the rule the
// three consumers share, and the refusal below is its.
const TTL = cli.int("ttl", { absent: DEFAULT_TTL_S, min: 1 });
const HEARTBEAT = cli.has("heartbeat") ? cli.int("heartbeat", { absent: DEFAULT_HEARTBEAT_S, min: 1 }) : heartbeatFor(TTL);
const TIMEOUT_S = cli.int("timeout", { absent: 300, min: 1 });
{
  const refusal = leaseRefusal(TTL, HEARTBEAT, !cli.has("heartbeat"));
  if (refusal) {
    console.error(refusal);
    process.exit(2);
  }
}
/**
 * Append every model answer here as JSONL — {id, fingerprint, entities,
 * relations}, and `windows` (the windows SENT), `coverage` when that was a
 * prefix of the thought (SMD-2240) or some windows' answers were malformed
 * and left out (SMD-2260) — for evals/eval-entities.ts --replay.
 */
const DUMP = cli.value("dump");
const LIMIT = cli.int("limit", { absent: 0, min: 1 });
const FOLLOW = cli.int("follow", { absent: 0, bare: 15, min: 1 });
const STATUS_ONLY = cli.has("status");
const DRY_RUN = cli.has("dry-run");
const SWITCH_KEY = cli.has("switch-key");
const RETRY_FAILED = cli.has("retry-failed");
const RETRY_PARTIAL = cli.has("retry-partial");
/** --retry-partial's rows with windows left out alone: a change of model re-reads them without re-reading every prefix to the place it already reached (review pass 1). */
const RETRY_LEFT_OUT = cli.has("retry-left-out");
// SMD-2321: `--decide` re-types the 7B's entities with the Jev decider (validity +
// type), storing p_true as confidence. Opt-in and only with the tier configured.
const DECIDE = cli.has("decide");

const cfg = resolveEmbedConfig(process.env as EmbedEnv);
const jevCfg = DECIDE ? resolveJevConfig(process.env as unknown as JevEnv) : null;
if (DECIDE && !jevCfg) {
  console.error("  --decide needs the Jev tier: set OB1_JEV_BASE_URL (and OB1_JEV_LOCAL for a loopback endpoint)");
  process.exit(2);
}
/** The windowing every row is extracted under — its bound is what a partial row's caveat names. */
const WINDOWING = windowingFor(cfg);
const JOB = cli.value("job") ?? extractionKey(cfg.metadataModel);

console.log(`  job:    ${JOB}`);
console.log(`  model:  ${cfg.metadataModel} via ${cfg.chat.base}, temperature ${cfg.metadataTemperature}`);
// The window a thought is extracted in, and where the number came from
// (SMD-1879) — the same rule preflight prints, so the banner says what the
// pass will do rather than a second opinion of it.
console.log(`  window: ${describeExtractWindow(cfg)}`);
// What may leave the box (SMD-1903): a row the gate refuses is a failed claim
// naming the rule; its text never went anywhere, and --retry-failed revisits it.
console.log(`  egress: ${egressDescription(cfg.chat, cfg.egress, localKnob(cfg, "chat"))}`);
{
  // A policy that refuses whatever the row (SMD-1903): stop before claiming,
  // rather than fail every row in the pool one at a time. A dry run and
  // --status still report — the banner's egress line says why a run would not.
  // The units a row of this pass carries: its metadata and text, and the
  // worker key's name as the actor when one is set (second review pass).
  const blanket = blanketGate({ endpoint: cfg.chat, policy: cfg.egress, units: process.env.OB1_WORKER_KEY ? undefined : ROW_UNITS, verb: "extracted", localKnobKey: localKnob(cfg, "chat") });
  if (blanket && !STATUS_ONLY && !DRY_RUN) {
    console.error(`\n  ${blanket}`);
    process.exit(2);
  }
}

// One connection per worker and one spare: the heartbeat (db/lease.ts) beats
// through the pool, and a worker parked on a lock or a long statement holds
// its own connection, so the spare is what keeps every worker's leases alive
// then. Tightening this to WORKERS would recreate the lapse 031 removed.
const sql = openSql(url, { max: WORKERS + 1 });

// ── The database's side ─────────────────────────────────────────────────────

const [{ tables }] = await sql`
  SELECT count(*)::int AS tables FROM pg_class
  WHERE relname IN ('thought_work_claims', 'ob1_entities', 'thought_entities', 'ob1_entity_edges') AND relkind = 'r'`;
if (Number(tables) < 4) {
  console.error("\n  The entity tables or the lease table are missing. Apply migrations 015 and 016 first:\n    cd db && bun migrate.ts --url …");
  await sql.close();
  process.exit(2);
}

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * The same decision the server makes: MCP_ACCESS_KEYS says whether a key is
 * valid and what it is called and may do; resolve_agent says who it belongs to.
 * So the key must be in MCP_ACCESS_KEYS — a key the server would refuse is not
 * an identity here either — and the record's own name and scope are what get
 * registered, not a guessed label and a hardcoded 'write' that the server's
 * next request would flip back. Resolution writes (first sight registers, and
 * since 054 a stale last_used_at or a changed scope is written), so --status
 * and --dry-run do not resolve.
 */
let agentId: string | null = null;
/** The worker key's name, for the egress gate's `actor:` unit (SMD-1903); undefined without a key. */
let actorName: string | undefined;
if (!STATUS_ONLY && !DRY_RUN) {
  const id = await workerIdentity(url, process.env, {
    noKeyWarning: "  ⚠  OB1_WORKER_KEY is not set: mentions and edges will carry no agent id. Mint one with server-portable/keygen.ts and add its hash to MCP_ACCESS_KEYS.",
  });
  if (!id.ok) {
    console.error(id.message);
    await sql.close();
    process.exit(2);
  }
  agentId = id.identity.agentId;
  actorName = id.identity.keyName;
  // A key that was set but did not resolve to a name is no actor: the blanket
  // check above credited one, so it is asked again without (third review pass).
  if (process.env.OB1_WORKER_KEY && id.identity.keyName === undefined) {
    const again = egressRefusal(cfg.chat, cfg.egress, ROW_UNITS);
    if (again) {
      console.error(`\n  ${regateMessage("extracted", again)}`);
      await sql.close();
      process.exit(2);
    }
  }
}

// ── Where the pass stands ───────────────────────────────────────────────────

/**
 * A succeeded row extracted in part: 028's caveat rule, the caveat this
 * worker writes for it — over a prefix (SMD-2240), or with windows left out
 * as malformed (SMD-2260), or both. One predicate for the counts, the lists
 * and --retry-partial, so they cannot disagree about which rows are partial.
 */
const partialRow = () => sql`status = 'succeeded' AND last_error IS NOT NULL AND starts_with(last_error, ${PARTIAL_CAVEAT_PREFIX})`;
/**
 * Of the partial rows, those with windows left out as malformed — a row that
 * is also a prefix included, since a model or budget change is what retries
 * it — and those extracted over a prefix only: the two kinds, apart.
 */
const leftOutRow = () => sql`${partialRow()} AND strpos(last_error, ${MALFORMED_WINDOWS_MARK}) > 0`;
const prefixOnlyRow = () => sql`${partialRow()} AND strpos(last_error, ${MALFORMED_WINDOWS_MARK}) = 0`;

/**
 * `partial` is a subset of `succeeded`: the rows extracted in part; `leftOut`
 * is the subset of those with windows left out as malformed, and `leftOutOver`
 * the subset of THOSE over the bound too — a retry reads them to the bound.
 */
type Counts = { pending: number; claimed: number; succeeded: number; partial: number; leftOut: number; leftOutOver: number; failed: number; unpooled: number; thoughts: number };
async function counts(): Promise<Counts> {
  const rows = (await sql`
    SELECT status, count(*)::int AS c, count(*) FILTER (WHERE ${partialRow()})::int AS partial, count(*) FILTER (WHERE ${leftOutRow()})::int AS left_out,
           count(*) FILTER (WHERE ${leftOutRow()} AND strpos(last_error, ${OVER_BOUND_MARK}) > 0)::int AS left_out_over
    FROM thought_work_claims WHERE work_type = ${JOB} GROUP BY status`) as { status: string; c: number; partial: number; left_out: number; left_out_over: number }[];
  const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.c)]));
  const partial = rows.reduce((n, r) => n + Number(r.partial), 0);
  const leftOut = rows.reduce((n, r) => n + Number(r.left_out), 0);
  const leftOutOver = rows.reduce((n, r) => n + Number(r.left_out_over), 0);
  const [{ unpooled, thoughts }] = await sql`
    SELECT count(*)::int AS thoughts,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM thought_work_claims c WHERE c.thought_id = t.id AND c.work_type = ${JOB}))::int AS unpooled
    FROM thoughts t`;
  return { pending: by.pending ?? 0, claimed: by.claimed ?? 0, succeeded: by.succeeded ?? 0, partial, leftOut, leftOutOver, failed: by.failed ?? 0, unpooled: Number(unpooled), thoughts: Number(thoughts) };
}

/** The two kinds of partial row in words, a kind with no rows omitted, and how many of the second are over the bound too: "1 over a prefix only, 2 with windows left out as malformed, 1 of those also over the bound". */
function partialKinds(partial: number, leftOut: number, leftOutOver = 0): string {
  return [
    partial - leftOut ? `${partial - leftOut} over a prefix only` : "",
    leftOut ? `${leftOut} with windows left out as malformed` : "",
    leftOutOver ? `${leftOutOver} of those also over the bound` : "",
  ].filter(Boolean).join(", ");
}

function printCounts(c: Counts, label: string): void {
  console.log(
    `  ${label}: ${c.thoughts} thoughts — ${c.succeeded} extracted${c.partial ? ` (${partialKinds(c.partial, c.leftOut, c.leftOutOver)})` : ""}, ${c.failed} failed, ` +
      `${c.claimed} in flight, ${c.pending} pending, ${c.unpooled} not yet in the pool`
  );
}

async function printGraph(): Promise<void> {
  const [g] = await sql`
    SELECT (SELECT count(*)::int FROM ob1_entities) AS entities,
           (SELECT count(*)::int FROM thought_entities) AS mentions,
           (SELECT count(*)::int FROM ob1_entity_edges) AS edges,
           (SELECT count(DISTINCT thought_id)::int FROM thought_entities) AS thoughts_with_entities`;
  const byType = (await sql`SELECT entity_type, count(*)::int AS c FROM ob1_entities GROUP BY entity_type ORDER BY c DESC`) as { entity_type: string; c: number }[];
  console.log(
    `  graph: ${g.entities} entities (${byType.map((t) => `${t.c} ${t.entity_type}`).join(", ") || "none"}), ` +
      `${g.mentions} mentions across ${g.thoughts_with_entities} thoughts, ${g.edges} edges`
  );
}

async function printFailures(limit = 10): Promise<void> {
  const rows = (await sql`
    SELECT thought_id, attempt_count, last_error FROM thought_work_claims
    WHERE work_type = ${JOB} AND status = 'failed' ORDER BY finished_at DESC LIMIT ${limit}`) as
    { thought_id: string; attempt_count: number; last_error: string | null }[];
  for (const r of rows) console.error(`    ${r.thought_id}  attempt ${r.attempt_count}  ${r.last_error ?? "(no error recorded)"}`);
}

/** The rows extracted in part, each with its caveat, one list per kind — succeeded, so on stdout, not among the failures. */
async function printPartials(c: Counts, limit = 10): Promise<void> {
  const prefixOnly = c.partial - c.leftOut;
  if (prefixOnly > 0) {
    const rows = (await sql`
      SELECT thought_id, last_error FROM thought_work_claims
      WHERE work_type = ${JOB} AND ${prefixOnlyRow()} ORDER BY finished_at DESC LIMIT ${limit}`) as { thought_id: string; last_error: string }[];
    // Each caveat names the bound its row was read under; the bound in force may
    // already be wider, so the advice names it rather than saying "raise" (review pass 1).
    console.log(`  extracted over a prefix only (${Math.min(prefixOnly, limit)} of ${prefixOnly}) — the rest of each is not in the graph; --retry-partial re-extracts them over at most ${cfg.extractMaxWindows} windows (OB1_EXTRACT_MAX_WINDOWS${cfg.extractMaxWindowsFrom === "default" ? " unset" : ""}), more than a row read under a smaller bound got; raise it for more:`);
    for (const r of rows) console.log(`    ${r.thought_id}  ${r.last_error}`);
  }
  if (c.leftOut > 0) {
    const rows = (await sql`
      SELECT thought_id, last_error FROM thought_work_claims
      WHERE work_type = ${JOB} AND ${leftOutRow()} ORDER BY finished_at DESC LIMIT ${limit}`) as { thought_id: string; last_error: string }[];
    // Closer to a failure than a prefix is: the bound decided a prefix, the
    // model's answers decided these (SMD-2260).
    // The model is the lever, and a changed OB1_METADATA_MODEL is another
    // key: --job keeps the retry on this pool's rows (review pass 2 — the
    // advice without it was refused, or with --switch-key found no rows).
    // --limit holds the larger model to these rows: the workers claim pending
    // rows by enqueued_at, and a returned row keeps its own, so a pending row
    // older than it is claimed in its place (review passes 3 and 4) — and a
    // worker of this pool running beside it takes returned rows as they land.
    const backlog = c.pending ? `; ${c.pending} pending row(s) of this pool may be claimed by that model in place of some of these — drain them first` : "";
    console.log(`  extracted with windows left out (${Math.min(c.leftOut, limit)} of ${c.leftOut}) — the model's answers for them were ${MALFORMED_WINDOWS_MARK}, and their text is not in the graph; --retry-left-out re-extracts them, and another model kept to this pool may be worth trying (OB1_METADATA_MODEL=<model> … --job ${JOB} --retry-left-out --limit ${c.leftOut}, no other worker of this pool running${backlog}); each over the bound is read to the bound in force, OB1_EXTRACT_MAX_WINDOWS (${cfg.extractMaxWindows}):`);
    for (const r of rows) console.log(`    ${r.thought_id}  ${r.last_error}`);
  }
}

const recordedKey: string | undefined = ((await sql`SELECT value AS key FROM ob1_config WHERE key = 'entity_extraction_key'`) as { key: string }[])[0]?.key;
if (recordedKey && recordedKey !== JOB) {
  console.log(`  ob1_config.entity_extraction_key is ${recordedKey}; this run uses ${JOB} — a different model or prompt version`);
  if (!SWITCH_KEY && !STATUS_ONLY && !DRY_RUN) {
    // The same gate reembed.ts has. record_thought_entities replaces a
    // thought's rows whatever key wrote them, so a run under another model —
    // a --limit trial with OB1_METADATA_MODEL changed in the shell — would
    // leave a per-thought mixture of two models' extractions and re-point the
    // trigger at the new key. Make the operator say so.
    console.error(
      `\n  Refusing to extract under a key other than the one ob1_config records without --switch-key.\n` +
        `  Every thought this run touches would carry ${JOB}'s extraction in place of ${recordedKey}'s, and new captures\n` +
        `  would enqueue under ${JOB}. If that is the intent, pass --switch-key and run the whole backlog; if\n` +
        `  OB1_METADATA_MODEL is simply set differently in this shell, fix it instead.`
    );
    await sql.close();
    process.exit(2);
  }
} else if (!recordedKey) {
  console.log(`  ob1_config.entity_extraction_key is not set: the trigger has enqueued nothing yet; this run sets it`);
}

if (STATUS_ONLY || DRY_RUN) {
  const c = await counts();
  printCounts(c, STATUS_ONLY ? "status" : "before");
  if (c.claimed > 0) for (const h of await leaseHolders(sql, JOB)) console.log(describeHolder(h));
  await printGraph();
  if (c.partial > 0) await printPartials(c);
  if (c.failed > 0) {
    console.error(`  failed rows (${Math.min(c.failed, 10)} of ${c.failed}):`);
    await printFailures();
  }
  if (DRY_RUN) {
    const todo = c.pending + c.unpooled + (RETRY_FAILED ? c.failed : 0) + (RETRY_PARTIAL ? c.partial : RETRY_LEFT_OUT ? c.leftOut : 0);
    console.log(
      `\n  would: ${recordedKey === JOB ? "" : `record ${JOB} in ob1_config so new captures enqueue; `}` +
        `${RETRY_FAILED ? `return ${c.failed} failed rows to the pool; ` : ""}` +
        `${RETRY_PARTIAL ? `return ${c.partial} row(s) extracted in part to the pool${c.partial ? ` (${partialKinds(c.partial, c.leftOut, c.leftOutOver)})` : ""}; ` : RETRY_LEFT_OUT ? `return ${c.leftOut} row(s) with windows left out to the pool${c.leftOut ? ` (${partialKinds(c.leftOut, c.leftOut, c.leftOutOver)})` : ""}; ` : ""}` +
        `add ${c.unpooled} thoughts to the pool; send ${LIMIT ? Math.min(LIMIT, todo) : todo} thought(s) to ${cfg.metadataModel} ` +
        `with ${WORKERS} worker(s), ${TTL} s leases renewed every ${HEARTBEAT} s. Nothing was written.`
    );
  }
  await sql.close();
  process.exit(0);
}

// ── The run ─────────────────────────────────────────────────────────────────

if (recordedKey !== JOB) {
  await sql`
    INSERT INTO ob1_config (key, value) VALUES ('entity_extraction_key', ${JOB})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  console.log(`  ob1_config.entity_extraction_key = ${JOB} — new and edited thoughts now enqueue for extraction`);
}

/** Rows a --retry-* flag returned to the pool: the run's first judgement is of rows chosen for failing (SMD-2266, review pass 2). */
let returned = 0;
if (RETRY_FAILED) {
  const [{ n }] = await sql`
    WITH retried AS (
      UPDATE thought_work_claims SET status = 'pending', last_error = NULL, finished_at = NULL, attempt_count = 0
      WHERE work_type = ${JOB} AND status = 'failed' RETURNING 1)
    SELECT count(*)::int AS n FROM retried`;
  returned += n;
  console.log(`  --retry-failed: ${n} failed row(s) returned to the pool`);
}

if (RETRY_PARTIAL || RETRY_LEFT_OUT) {
  // --retry-failed's statement over the partial rows — every one, or those
  // with windows left out: pending, the caveat cleared, so the row is
  // extracted afresh under the bound and the model in force now, and the new
  // reading replaces the old one's rows (record_thought_entities). Each row's
  // kinds are read before the caveat is cleared, so the message can say what
  // each gets — a row of both kinds is a prefix too (review pass 1).
  const [{ n, left_out: leftOut, left_out_over: both }] = await sql`
    WITH old AS (
      SELECT thought_id, strpos(last_error, ${MALFORMED_WINDOWS_MARK}) > 0 AS left_out, strpos(last_error, ${OVER_BOUND_MARK}) > 0 AS over FROM thought_work_claims
      WHERE work_type = ${JOB} AND ${RETRY_PARTIAL ? partialRow() : leftOutRow()} FOR UPDATE),
    retried AS (
      UPDATE thought_work_claims w SET status = 'pending', last_error = NULL, finished_at = NULL, attempt_count = 0
      FROM old WHERE w.work_type = ${JOB} AND w.thought_id = old.thought_id RETURNING old.left_out, old.over)
    SELECT count(*)::int AS n, count(*) FILTER (WHERE left_out)::int AS left_out, count(*) FILTER (WHERE left_out AND over)::int AS left_out_over FROM retried`;
  // A prefix is read afresh under the bound in force, which may be smaller
  // than the one it was read under: say both directions (review pass 1).
  // Counted, not inferred: a prefix-only row is every partial row without the
  // malformed mark, and a row of both carries both marks (review pass 2).
  const prefix = n - leftOut + both > 0 ? `; a prefix is extracted over at most ${cfg.extractMaxWindows} window(s) (OB1_EXTRACT_MAX_WINDOWS${cfg.extractMaxWindowsFrom === "default" ? " unset" : ""}) — a row read under a smaller bound gains coverage, one read under this bound is read to the same place again, and one read under a larger bound keeps less than it had` : "";
  // A fresh reading can fail outright — a window timing out, or none parsing —
  // and a failure writes nothing, so the row is failed while the earlier
  // reading's rows stay in the graph (review pass 3).
  const again = leftOut > 0 ? `; a row with windows left out is sent again to ${cfg.metadataModel}, and a window it answers malformed again is left out again` : "";
  // Any row, a prefix too: a failure writes nothing (review pass 4).
  const fails = n > 0 ? `; a reading that fails (a window timing out, or none parsing) records its row failed, the earlier reading's entities left in the graph until a later one succeeds` : "";
  returned += n;
  const what = RETRY_PARTIAL ? `--retry-partial: ${n} row(s) extracted in part` : `--retry-left-out: ${n} row(s) with windows left out`;
  console.log(`  ${what} returned to the pool${n ? ` (${partialKinds(n, leftOut, both)})` : ""}${prefix}${again}${fails}`);
}

let stopping = false;
let done = 0;
/** Of `done`, the thoughts extracted over a prefix only (SMD-2240), and those with windows left out as malformed, a prefix of one included, with how many windows (SMD-2260). */
let partial = 0;
let leftOut = 0;
let leftOutWindows = 0;
let failed = 0;
let vanished = 0;
let superseded = 0;
let lost = 0;
let beats = 0;
let malformed = 0;
let llmMs = 0;
/** Thoughts extracted in more than one window, thoughts a runaway call was retried for, and model calls made in all (SMD-1879). */
let windowed = 0;
let retried = 0;
/** Thoughts a runaway was escalated to OB1_EXTRACT_ESCALATE_MODEL for, rather than retried under the penalty (SMD-2000). */
let escalated = 0;
/** Thoughts a runaway was aborted on the stream for, before its budget (SMD-1960). */
let aborted = 0;
let calls = 0;
/**
 * The answers the model gave this run — one a window sent, a one-window
 * thought's one — and how many were not JSON of the expected shape, in a
 * thought failed as malformed or left out of a partial one: the run's signal
 * that the model, not the documents, is at fault (SMD-2266, malformedAlarm).
 */
let answers = 0;
let answersMalformed = 0;
/**
 * The answers judged so far, and how many judgements tripped. A run that
 * exits is judged once, at its end; a follower judges its answers in blocks of
 * at least EXTRACT_MALFORMED_ALARM_MIN after each poll, so it says so while it
 * runs — a stopped follower exits 0 — and a breakage that starts late is not
 * diluted by the good polls before it (review pass 1).
 */
const judged = { answers: 0, malformed: 0, escalated: 0 };
let alarms = 0;
const totals = { entities: 0, newEntities: 0, mentions: 0, edges: 0, dropped: 0, ambiguous: 0, refused: 0, retyped: 0, gated: false };
const activeWorkers = new Set<string>();
const started = Date.now();
let total = 0;
const lastReport = { at: 0 };

function progress(force = false): void {
  const now = Date.now();
  if (!force && now - lastReport.at < 3000) return;
  lastReport.at = now;
  const elapsed = (now - started) / 1000;
  const rate = done / Math.max(elapsed, 0.001);
  const remaining = Math.max((LIMIT ? Math.min(LIMIT, total) : total) - done - failed, 0);
  const eta = rate > 0 ? Math.round(remaining / rate) : null;
  console.log(
    `  ${done + failed}/${LIMIT ? Math.min(LIMIT, total) : total}  ${rate.toFixed(2)}/s  ` +
      `${totals.entities} entity mentions, ${totals.edges} edges` +
      (failed ? `  ${failed} failed` : "") +
      (eta !== null ? `  ~${eta}s left` : "")
  );
}

type Row = { id: string; content: string; fingerprint: string | null; metadata: Record<string, unknown> | null };
type Outcome =
  /** `caveat` is set for a thought extracted in part: 028's caveat, released on the succeeded row (SMD-2240); `leftOut`, how many of its windows were left out as malformed (SMD-2260). */
  | { outcome: "succeeded"; caveat?: string; leftOut?: number }
  | { outcome: "failed"; error: string }
  | { outcome: "vanished" }
  /** Edited while it was being extracted; the trigger has already re-queued it and the pool will redo it. */
  | { outcome: "superseded" };

async function processRow(row: Row): Promise<Outcome> {
  const t0 = Date.now();
  let extraction: Extraction;
  try {
    // The row's own metadata is what the gate reads (SMD-1903); a refusal
    // throws out of here as a failed claim naming the rule. The timeout is per
    // call — per window of a long thought (SMD-1879).
    extraction = await extractEntities(row.content, cfg, TIMEOUT_S * 1000, { kind: "extraction", actor: actorName, metadata: row.metadata ?? undefined });
  } finally {
    llmMs += Date.now() - t0;
  }
  // Every call the thought cost: one per window, and one more per window
  // that was retried (first review pass: the retries went uncounted).
  calls += callsOf(extraction);
  // Every answer counts, whatever the write then does: the signal is the
  // model's, not the rows'.
  answers += extraction.windows;
  answersMalformed += extraction.malformed ? extraction.windows : extraction.coverage?.malformed?.length ?? 0;
  // A per-window record, not a count over one: a prefix of one window of a
  // longer thought is windowed — sent "Part 1 of N" (review pass 2).
  if (extraction.parts) windowed++;
  // A runaway escalated to the larger model is counted as an escalation, not a
  // penalised retry, though it is both a runaway and a second call (SMD-2000).
  if (extraction.escalated) escalated++;
  else if (extraction.retried) retried++;
  if (extraction.abortedMs !== undefined) aborted++;
  if (extraction.malformed) {
    malformed++;
    const where = extraction.parts ? ` (window ${windowList(extraction.parts.filter((p) => p.malformed).map((p) => p.index))} of ${extraction.windows}${extraction.coverage ? ` sent, a prefix of ${extraction.coverage.of}` : ""})` : "";
    // "No retry was made" is reachable only with EXTRACT_RETRY_RUNAWAY off and
    // the stream abort on — a constant flipped — and stays for that truth.
    // A runaway aborted on the stream is named in the failed row's error, so
    // an operator sorting the failed rows — for SMD-2000's larger model, say —
    // can tell a loop the retry did not rescue from an answer that was never
    // JSON. The MALFORMED window's own abort, not the thought's longest (one
    // the retry may have rescued), and "the retry did not converge" only when
    // a retry was made (review passes one to four). Only a first call is ever
    // aborted — the retry is read whole — so the note names it.
    const abortedParts: { abortedMs?: number; retried?: true; escalated?: string }[] = extraction.parts ? extraction.parts.filter((p) => p.malformed && p.abortedMs !== undefined) : extraction.abortedMs !== undefined ? [extraction] : [];
    const abortedMs = Math.max(...abortedParts.map((p) => p.abortedMs as number));
    const retriedToo = abortedParts.some((p) => p.retried);
    // When the second call was an escalation (SMD-2000), name the model that
    // still could not answer — the operator sorting the failed rows for a
    // larger model is told the larger model already ran.
    const escalatedTo = abortedParts.map((p) => p.escalated).find(Boolean);
    const secondNote = escalatedTo ? `and the escalation to ${escalatedTo}, read whole, did not converge either` : "and the penalised retry, read whole, did not converge either";
    const abortedNote = abortedParts.length ? `; the first call was aborted on the stream ${(abortedMs / 1000).toFixed(1)} s in — the answer went on past a third copy of one item — ${retriedToo ? secondNote : "and no retry was made"}` : "";
    return { outcome: "failed", error: `the model's answer was not JSON of the expected shape${where}${abortedNote}` };
  }
  if (DUMP) {
    // The model's answer as parsed, before the database applies the rule —
    // what a replay needs to re-score a rule change without the model — and,
    // for a windowed thought, each window's own answer beside the merged one:
    // the derivation record (SMD-1731) until a lineage table holds it.
    // `escalated: <model>` where a runaway went to the larger model, `retried:
    // true` where it took the penalised same-model retry — the derivation
    // record of which model produced the answer (SMD-2000), the pass key on the
    // row itself staying the first model's.
    appendFileSync(DUMP, JSON.stringify({ id: row.id, fingerprint: row.fingerprint, key: JOB, entities: extraction.entities, relations: extraction.relations, windows: extraction.windows, ...(extraction.escalated ? { escalated: extraction.escalated } : extraction.retried ? { retried: true } : {}), ...(extraction.abortedMs !== undefined ? { abortedMs: extraction.abortedMs } : {}), ...(extraction.coverage ? { coverage: extraction.coverage } : {}), ...(extraction.parts ? { parts: extraction.parts } : {}) }) + "\n");
  }
  // SMD-2321: the hybrid mode re-types the 7B's entities with the decider —
  // identifier shapes carved by rule, the rest validity-gated and typed, p_true
  // the confidence. After the dump above, so the dump keeps the raw generative
  // answer for replay; a decider outage falls back to the 7B's entities inside
  // decideEntities. The row's metadata is the egress subject, as extraction's.
  if (jevCfg && extraction.entities.length) {
    const decided = await decideEntities(row.content, extraction.entities, jevCfg, { kind: "extraction", actor: actorName, metadata: row.metadata ?? undefined });
    extraction = { ...extraction, entities: decided.entities };
  }
  // 061: the pass's recipe — the model, the prompt's version and hash, the
  // windows sent and what was cut — recorded in `derivations` with the rows,
  // beside the input's fingerprint the function checks and now stores
  // (SMD-1731); the per-window answers stay in the dump above.
  const [r] = await sql`
    SELECT record_thought_entities(
      ${row.id}::uuid, ${JOB}::text,
      ${extraction.entities}::jsonb, ${extraction.relations}::jsonb,
      ${row.fingerprint}::text, ${agentId}::uuid,
      ${entityRecipe(cfg, extraction)}::jsonb
    ) AS r`;
  const res = r.r as { ok: boolean; stale?: boolean; error?: string; entities?: number; new_entities?: number; mentions?: number; edges?: number; dropped_relations?: number; ambiguous_relations?: number; refused_entities?: number; retyped_entities?: number };
  if (res.ok) {
    totals.entities += res.mentions ?? 0;
    totals.newEntities += res.new_entities ?? 0;
    totals.mentions += res.mentions ?? 0;
    totals.edges += res.edges ?? 0;
    totals.dropped += res.dropped_relations ?? 0;
    totals.ambiguous += res.ambiguous_relations ?? 0;
    // A brain before 056 returns no gate counts: say nothing rather than a gate's zeros (third review pass).
    if (res.refused_entities !== undefined) totals.gated = true;
    totals.refused += res.refused_entities ?? 0;
    totals.retyped += res.retyped_entities ?? 0;
    // A prefix's rows stand, and the claim says they are a prefix (SMD-2240);
    // so do the parsed windows' rows, the claim naming those left out (SMD-2260).
    const c = extraction.coverage;
    return c ? { outcome: "succeeded", caveat: partialCaveat(c, WINDOWING), ...(c.malformed ? { leftOut: c.malformed.length } : {}) } : { outcome: "succeeded" };
  }
  if (res.error === "NOT_FOUND") return { outcome: "vanished" };
  // Edited between the claim and the write. What was extracted describes text
  // that is no longer there, so re-extracting it here would be a second model
  // call for work the pool should do. The trigger has usually re-queued the
  // thought already — but only under the key ob1_config records, and only if
  // that key is set, so re-queue under THIS job explicitly (idempotent) rather
  // than leave a lease held on a promise.
  if (res.stale) {
    await sql`SELECT requeue_thought_work(${JOB}, ${row.id}::uuid)`;
    return { outcome: "superseded" };
  }
  return { outcome: "failed", error: `record_thought_entities: ${res.error}` };
}

/**
 * What an error from the provider is about.
 *
 *   thought   — a fact about this thought: a timeout (the corpus run showed the
 *               same long documents exceed the limit every time), a 400 naming
 *               the input's length, a body that was not JSON. Recorded failed;
 *               --retry-failed revisits it.
 *   transient — says nothing about the thought: 429, 5xx, a dropped connection.
 *               Paused and retried; if it persists, THIS row is recorded failed
 *               with the error (so a thought that reliably draws a 500 becomes
 *               visible rather than cycling through the pool for ever) and the
 *               worker stops, leaving its other leases to the pool.
 *   fatal     — the request itself is wrong for this provider: 401/403 (the
 *               key), 404 (the model), or a 400 about the request's shape. The
 *               next thought would fail the same way, so every worker stops at
 *               once and the run exits 2, with nothing marked failed.
 */
type ErrorKind = "thought" | "transient" | "fatal";
function classifyError(e: unknown): ErrorKind {
  const status = (e as { status?: number }).status;
  const msg = (e as Error).message ?? "";
  const name = (e as Error).name ?? "";
  if (name === "TimeoutError" || /timed out/i.test(msg)) return "thought";
  if (status === 429 || (status !== undefined && status >= 500)) return "transient";
  // The one rule for "this 400 is about the input's length", shared with
  // embed.ts so the two tools cannot drift. A 413 stays fatal below, as it
  // was: the extraction request is the same shape for every thought, so a
  // provider refusing its size would refuse the next one too.
  // A 400 about the answer budget names the REQUEST — the same max_tokens
  // shape goes to every thought — and would otherwise read as this thought's
  // length (refusesLength matches "tokens") and fail the pool one row at a
  // time (fifth review pass). Fatal: stop every worker, mark nothing.
  if (status === 400 && /max_tokens|max_completion_tokens|completion tokens/i.test(msg)) return "fatal";
  if (status === 400 && refusesLength(status, msg)) return "thought";
  if (status !== undefined && status >= 400 && status < 500) return "fatal";
  if (/ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENOTFOUND|fetch failed|Unable to connect|socket/i.test(msg)) return "transient";
  return "thought";
}
const TRANSIENT_PAUSES_MS = [5_000, 15_000, 45_000];
// Written inside the worker closures below, which control-flow analysis does
// not follow: declared `: string | null = null`, the read at the end of the
// run is narrowed to `never`. The cast keeps the declared type as the initial
// one (SMD-1932).
let configError = null as string | null;

/**
 * --limit counts thoughts CLAIMED, reserved at claim time, so two workers
 * cannot each take one on a limit of one. A claimed row is always processed.
 */
let reserved = 0;
function limitReached(): boolean {
  return LIMIT > 0 && reserved >= LIMIT;
}

async function worker(n: number): Promise<void> {
  const workerId = `extract-${hostname()}-${process.pid}-${n}-${randomUUID().slice(0, 8)}`;
  activeWorkers.add(workerId);
  const hb = startHeartbeat({
    sql, job: JOB, workerId, ttlS: TTL, everyS: HEARTBEAT,
    onLost: (ids) => console.error(`  ${workerId}: ${ids.length} row(s) no longer this worker's at the last beat — reaped, requeued by an edit, or deleted; each is named as the loop reaches it, or at its release if it was the row in hand`),
    onError: (e, consecutive) => { if (consecutive === 1) console.error(`  ${workerId}: heartbeat failed (${e.message}); the leases hold ${TTL} s from the last beat that reached the database`); },
  });
  try {
    while (!stopping && !limitReached()) {
      let batch: { thought_id: string; attempt: number }[];
      let byId: Map<string, Row>;
      try {
        const room = LIMIT > 0 ? LIMIT - reserved : BATCH;
        if (room <= 0) return;
        const want = Math.min(BATCH, room);
        reserved += want;
        batch = (await sql`
          SELECT thought_id, attempt FROM claim_thoughts(${JOB}, ${workerId}, ${want}, ${TTL})`) as { thought_id: string; attempt: number }[];
        reserved -= want - batch.length;
        if (batch.length === 0) return;
        const ids = batch.map((b) => b.thought_id);
        hb.claimed(ids);
        const rows = (await sql`
          SELECT id, content, COALESCE(content_fingerprint, content_fingerprint_of(content)) AS fingerprint, metadata
            FROM thoughts WHERE id = ANY(${sql.array(ids, "TEXT")}::uuid[])`) as Row[];
        byId = new Map(rows.map((r) => [r.id, r]));
      } catch (e) {
        console.error(`  ${workerId}: ${(e as Error).message} — this worker stops`);
        return;
      }
      for (const b of batch) {
        if (stopping) return;
        if (hb.lost.has(b.thought_id)) {
          // A beat found this row no longer ours. Nothing to release, and
          // repeating the provider's work would only race the holder; the row
          // says why (db/lease.ts reportLost), and which count it joins.
          if ((await reportLost(sql, JOB, workerId, b.thought_id)) === "deleted") vanished++;
          else lost++;
          continue;
        }
        const row = byId.get(b.thought_id);
        if (b.attempt > 1) console.error(`  ${b.thought_id}: attempt ${b.attempt} — an earlier lease on it expired`);
        let outcome: Outcome | null = null;
        if (!row) {
          outcome = { outcome: "vanished" };
        } else {
          let stopAfter = false;
          for (let attempt = 0; outcome === null; attempt++) {
            try {
              outcome = await processRow(row);
            } catch (e) {
              // The calls a thrown thought made — its fourth window timing out
              // is four calls — count too (second review pass).
              calls += callsMadeBy(e);
              const kind = classifyError(e);
              const msg = (e as Error).message.slice(0, PROVIDER_ERROR_CHARS);
              if (kind === "thought") {
                outcome = { outcome: "failed", error: msg };
              } else if (kind === "fatal") {
                // Every thought would fail the same way. Stop everyone, mark
                // nothing, and say what to fix; this row goes back with the
                // leases the finally returns.
                configError = msg;
                stopping = true;
                console.error(`  ${workerId}: the provider refuses the request itself (${msg.slice(0, 160)}) — stopping every worker; nothing is marked failed`);
                return;
              } else if (attempt < TRANSIENT_PAUSES_MS.length && !stopping) {
                console.error(`  ${workerId}: provider unavailable (${msg.slice(0, 120)}); pausing ${TRANSIENT_PAUSES_MS[attempt] / 1000} s`);
                await Bun.sleep(TRANSIENT_PAUSES_MS[attempt]);
              } else {
                // Still failing after the pauses. This row is recorded failed
                // with the error — if the provider is down it is one row per
                // worker, and if this thought is what draws the error every
                // time it is now visible instead of cycling for ever — and the
                // worker stops, its other leases going back to the pool.
                outcome = { outcome: "failed", error: `provider error after ${TRANSIENT_PAUSES_MS.length} retries: ${msg}` };
                stopAfter = true;
              }
            }
          }
          if (stopAfter) console.error(`  ${workerId}: provider still failing — this worker stops after recording this thought; re-run when it is back`);
          if (stopAfter && outcome.outcome === "failed") {
            hb.held.delete(b.thought_id);
            let recorded = false;
            try {
              const rows = (await sql`SELECT release_thought(${b.thought_id}::uuid, ${JOB}, ${workerId}, 'failed', ${outcome.error}) AS ok`) as { ok: boolean }[];
              recorded = rows[0]?.ok === true;
            } catch (e) {
              console.error(`  ${b.thought_id}: could not record the failure (${(e as Error).message})`);
            }
            if (recorded) failed++;
            else {
              // Not ours to record: the lease lapsed during the pauses, or the
              // row was returned by hand. Counted with the rows this worker lost.
              lost++;
              console.error(`  ${b.thought_id}: the claim was no longer this worker's at release; the failure below was not recorded`);
            }
            console.error(`  ${b.thought_id}: ${outcome.error}`);
            return;
          }
        }
        // Out of the heartbeat's set before the release goes out, so a beat in
        // flight across the release does not read the released row as lost.
        hb.held.delete(b.thought_id);
        if (outcome.outcome === "vanished") {
          vanished++;
          continue;
        }
        if (outcome.outcome === "superseded") {
          // The claim is already pending again with no holder — the trigger
          // did that — so there is nothing to release.
          superseded++;
          console.error(`  ${b.thought_id}: edited while it was being extracted; it is pending again and will be extracted from the new text`);
          continue;
        }
        let ok: boolean;
        let gone = false;
        try {
          [{ ok }] = await sql`
            SELECT release_thought(${b.thought_id}::uuid, ${JOB}, ${workerId},
                                   ${outcome.outcome}, ${outcome.outcome === "failed" ? outcome.error : outcome.caveat ?? null}) AS ok`;
          if (!ok) {
            const [{ exists }] = await sql`SELECT EXISTS (SELECT 1 FROM thoughts WHERE id = ${b.thought_id}::uuid) AS exists`;
            gone = !exists;
          }
        } catch (e) {
          console.error(`  ${b.thought_id}: could not release the claim (${(e as Error).message}) — this worker stops`);
          return;
        }
        if (gone) {
          vanished++;
          console.error(`  ${b.thought_id}: deleted while it was being extracted`);
          continue;
        }
        if (!ok) {
          // Either the lease expired, or the content was edited and migration
          // 016's trigger put the row back in the pool to be extracted from the
          // new text. Not ours to finish either way: counted with the rows this
          // worker lost, not the ones it finished.
          console.error(`  ${b.thought_id}: the claim was no longer this worker's at release — an edit requeued it, its lease lapsed (no beat reached the database for ${TTL} s), or it was returned by hand with release_claims_for_worker; the row is the pool's or another worker's now`);
          if (outcome.outcome === "failed") console.error(`  ${b.thought_id}: ${outcome.error} (not recorded — the row was not this worker's)`);
          lost++;
          progress();
          continue;
        }
        if (outcome.outcome === "failed") {
          failed++;
          console.error(`  ${b.thought_id}: ${outcome.error}`);
        } else {
          done++;
          if (outcome.leftOut) { leftOut++; leftOutWindows += outcome.leftOut; } else if (outcome.caveat) partial++;
        }
        progress();
      }
    }
  } finally {
    hb.stop();
    beats += hb.beats;
    try {
      const [{ n: freed }] = await sql`SELECT release_claims_for_worker(${JOB}, ${workerId}) AS n`;
      if (freed > 0 && !FOLLOW) console.error(`  ${workerId}: returned ${freed} unfinished row(s) to the pool`);
    } catch (e) {
      console.error(`  ${workerId}: could not return its leases (${(e as Error).message}); they expire within ${TTL} s`);
    }
    activeWorkers.delete(workerId);
  }
}

const stop = () => {
  if (stopping) {
    console.error(`\n  second signal — exiting now; leases not returned in time expire within ${TTL} s`);
    const hardStop = setTimeout(() => process.exit(130), 3000);
    void Promise.all([...activeWorkers].map((w) => sql`SELECT release_claims_for_worker(${JOB}, ${w})`.catch(() => null)))
      .finally(() => { clearTimeout(hardStop); process.exit(130); });
    return;
  }
  stopping = true;
  console.error("\n  stopping after the current thought; unfinished claims go back to the pool (again to exit now)");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

/**
 * The alarm's lines for the answers since the last judgement, when there are
 * at least EXTRACT_MALFORMED_ALARM_MIN of them and more than the share were
 * malformed (SMD-2266, db/config.mjs's malformedAlarm): the verdict, then what
 * to check and retry. Undefined otherwise. Either way they are judged, and the
 * next judgement starts after them. The first judgement of a run that returned
 * rows for failing (--retry-*) is of documents chosen for it, so it is not told
 * they are not at fault, and a follower's later blocks, new captures, are
 * (review passes 1 and 2). The models named are those that answered the
 * block, the escalation's when it took a runaway (SMD-2000); the retries named
 * are for the kinds of row the run left.
 */
function judge(): string | undefined {
  const n = answers - judged.answers;
  const bad = answersMalformed - judged.malformed;
  if (n < EXTRACT_MALFORMED_ALARM_MIN) return undefined;
  const chosen = returned > 0 && judged.answers === 0;
  const esc = escalated - judged.escalated;
  judged.answers = answers;
  judged.malformed = answersMalformed;
  judged.escalated = escalated;
  if (!malformedAlarm(n, bad)) return undefined;
  alarms++;
  const models = esc ? `OB1_METADATA_MODEL (${cfg.metadataModel}) and OB1_EXTRACT_ESCALATE_MODEL (${WINDOWING.escalateModel}), which answered the runaways of ${esc} thought(s)` : `OB1_METADATA_MODEL (${cfg.metadataModel})`;
  const retries = [leftOut ? "--retry-left-out re-reads the partial rows" : "", failed ? "--retry-failed re-reads the failed ones" : ""].filter(Boolean).join(" and ");
  return `  ${bad} of ${FOLLOW ? `the follower's last ${n} answers` : `the ${n} answers this run`} were ${MALFORMED_WINDOWS_MARK} — more than ${Math.round(EXTRACT_MALFORMED_ALARM_SHARE * 100)}% of at least ${EXTRACT_MALFORMED_ALARM_MIN} (db/config.mjs, EXTRACT_MALFORMED_ALARM_SHARE): ` +
    (chosen
      ? `the ${returned} row(s) this run returned were chosen for failing or leaving windows out, so their documents may be at fault; if not, the model is.`
      : "the model, not the documents, is likely at fault — documents it can answer only in part, such as reference lists, leave out far fewer.") +
    `\n    Check ${models}, the endpoint and the prompt. ${done ? `The rows written stand${leftOut ? ", each partial one naming its windows left out" : ""}` : "No row was written"}` +
    `${retries ? `; once the model is right, ${retries}, with --job ${JOB} if OB1_METADATA_MODEL changes` : ""}.`;
}

let firstPass = true;
async function pass(): Promise<Counts> {
  // The backlog is pooled once. While following, the trigger enqueues every
  // new capture, so re-running enqueue_thoughts — a scan of every thought —
  // each poll would find nothing and cost the table.
  const added = firstPass ? Number((await sql`SELECT enqueue_thoughts(${JOB}) AS added`)[0].added) : 0;
  firstPass = false;
  const before = await counts();
  if (added > 0 || !FOLLOW) console.log(`  pool: ${added} thought(s) added`);
  total += before.pending + before.claimed;
  if (before.pending + before.claimed === 0) return before;
  if (!FOLLOW || added > 0 || before.pending > 0) {
    printCounts(before, "before");
  }
  await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));
  progress(true);
  return counts();
}

console.log(`\n  ${WORKERS} worker(s), ${BATCH} per claim, ${TTL} s leases renewed every ${HEARTBEAT} s, ${TIMEOUT_S} s per model call${LIMIT ? `, stopping after ${LIMIT}` : ""}${FOLLOW ? `, then polling every ${FOLLOW} s` : ""}\n`);

let after = await pass();
if (FOLLOW) {
  // Only a block it will poll after: the last pass's — the limit reached, or
  // stopped — is the final judgement's, which says the exit the run takes
  // (review pass 2: a follower at its --limit said "exits 0" and exited 3).
  const say = () => {
    if (stopping || limitReached()) return;
    const line = judge();
    if (line) console.error(`${line} The follower keeps polling; stopped by a signal, it exits 0${LIMIT ? ", and at its --limit, 3" : ""}.`);
  };
  say();
  // "This many thoughts, then stop" holds while following too.
  while (!stopping && !limitReached()) {
    await Bun.sleep(FOLLOW * 1000);
    if (stopping) break;
    after = await pass();
    say();
  }
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
// How the runaways were handled: a penalised same-model retry, an escalation to
// the larger model (SMD-2000), or both. A count is named only when it happened,
// so an escalation pass does not read "0 retried … , N escalated".
const runawayNote = escalated
  ? `${retried ? `${retried} retried and ` : ""}${escalated} escalated to ${WINDOWING.escalateModel} after a runaway answer`
  : `${retried} retried after a runaway answer`;
console.log(
  `\n  ${done} extracted${partial || leftOut ? ` (${[
    partial ? `${partial} over a prefix only — past the per-thought bound, OB1_EXTRACT_MAX_WINDOWS (${cfg.extractMaxWindows}); each row's caveat says how much` : "",
    leftOut ? `${leftOut} with ${leftOutWindows} window(s) left out, the model's answers for them ${MALFORMED_WINDOWS_MARK}; each row's caveat names them` : "",
  ].filter(Boolean).join("; ")})` : ""}, ${failed} failed, ${superseded} edited mid-extraction and re-queued, ${vanished} deleted mid-pass${lost ? `, ${lost} no longer this worker's when checked (each named above)` : ""}, in ${elapsed}s ` +
    `(${(llmMs / 1000).toFixed(1)}s in ${calls} model call(s) across ${WORKERS} worker(s), ${windowed} thought(s) in windows, ${runawayNote} (${aborted} aborted on the stream before the budget), ${beats} heartbeat(s))`
);
console.log(
  `  wrote ${totals.mentions} mentions of ${totals.newEntities} new entities, ${totals.edges} edges; ` +
    `dropped ${totals.dropped} relation(s) naming an unlisted entity; ${totals.ambiguous} attached to a name listed under two types` +
    (totals.gated ? `; the name gate (056) refused ${totals.refused} entity name(s) and retyped ${totals.retyped}` : "")
);
// Thoughts none of whose windows parsed; a window left out beside parsed ones
// is in the summary's partial clause instead (SMD-2260, review pass 2).
if (malformed > 0) console.error(`  ${malformed} thought(s) whose every answer was not JSON of the expected shape — recorded failed`);
// A run whose model answers a large share of windows malformed writes partial
// rows, each succeeded, where one malformed window used to fail its thought:
// say so, and exit 3 below, rather than let the exit code pass it (SMD-2266).
// The exit code is settled first, so the line says the one the run exits with
// (review pass 1: a signal or the provider's refusal exits otherwise).
const alarmLine = judge();
const incomplete = after.failed > 0 || after.claimed > 0 || (after.pending > 0 && !limitReached());
// The alarm before the failures: a model at fault explains them, and
// --retry-failed under it would fail them again. Leased and pending rows keep
// their own lines below.
const exitCode = configError ? 2 : stopping ? (FOLLOW ? 0 : 130) : alarms > 0 ? 3 : incomplete ? 1 : 0;
if (alarmLine) console.error(`${alarmLine} ${exitCode === 3 ? "Exiting 3." : `Exiting ${exitCode}, not 3: ${exitCode === 2 ? "the provider refused the request itself (below)" : "stopped by a signal"}.`}`);
printCounts(after, "after");
await printGraph();
if (after.partial > 0) await printPartials(after);
if (after.failed > 0) {
  console.error(`\n  failed rows (${Math.min(after.failed, 10)} of ${after.failed}) — fix the cause and re-run with --retry-failed:`);
  await printFailures();
}
if (after.claimed > 0 && !stopping) {
  console.error(`\n  ${after.claimed} row(s) are still leased — by another process running this job, or left by a worker that failed. They return to the pool within ${TTL} s of the holder's last heartbeat; --status names each holder, and a dead one's rows return at once with SELECT release_claims_for_worker(job, worker_id).`);
}
if (after.pending > 0 && !stopping && !limitReached()) {
  console.error(`\n  ${after.pending} row(s) are still pending: every worker stopped before the pool was empty. Re-run.`);
}
await sql.close();
if (configError) {
  console.error(
    `\n  The provider refused the request itself: ${configError.slice(0, 300)}\n` +
      `  Check the chat endpoint (OB1_CHAT_BASE_URL and OB1_CHAT_API_KEY, or OB1_LLM_BASE_URL and OB1_LLM_API_KEY when those are unset) and OB1_METADATA_MODEL against the provider; a 400 about a request field\n` +
      `  is usually reasoning_effort, response_format, max_tokens (the answer budget) or frequency_penalty (the runaway retry) not being supported by this model or endpoint. Nothing was marked failed.`
  );
  await Promise.resolve();
  process.exit(2);
}
process.exit(exitCode);
