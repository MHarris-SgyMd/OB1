/**
 * subject-sweep.ts — the extraction worker's `--subjects` sweep (SMD-3306): each thought in the subject pool (migration
 * 113) is given its own subject, the rules' or, for the rest, the judge model's (server-portable/subject.ts), through
 * migration 111's record_thought_subject. A subject is current when it stands at the thought's text and was found
 * under the current rules and question, a model's with its reasoning on when the question is asked with it on
 * (subjectCurrent).
 *
 *   bun db/extract-entities.ts --url … --subjects                # the rules, then the judge model for the rest
 *   bun db/extract-entities.ts --url … --subjects rules          # the rules alone: no model call
 *   bun db/extract-entities.ts --url … --subjects --dry-run      # how many each would find; writes, pools and asks nothing
 *   bun db/extract-entities.ts --url … --subjects --limit 50     # at most this many thoughts
 *   bun db/extract-entities.ts --url … --subjects --retry-failed # the pool's failed claims back in it first
 *   --timeout SECONDS (per model call: 900 with the judge model's reasoning on, 300 off)
 *   OB1_SUBJECT_REASONING=off                                    # the judge model without its reasoning (on unset)
 *   exits 0 clean · 1 claims failed (unanswered, unread or refused), or the provider or the database stopped answering ·
 *   2 usage, configuration, a role without the door's or the pool's grants or the provider's refusal · 130 a signal
 *   (the first after the call in hand, which can run to the limit a call; a second at once)
 *
 * The pool (113, PR 5). The sweep claims from thought_work_claims under its pool's key (subject.ts's subjectPoolKey:
 * the rules' versions and, when it asks the model, the question's with its reasoning), as the extraction pass claims
 * under its own, so a run costs what is in the pool, not the brain's size: until PR 5 every run read every thought,
 * its count and its pages, and a PGlite run timed the count alone at 5.9 s over a million synthetic thoughts. 113's
 * trigger puts each new or edited thought (back) in the pool ob1_config.subject_pool_key names. A sweep whose key is
 * not that one names its own and pools every thought with no current subject: after 111, and after a rule's, the
 * question's or the reasoning's change. They are requeued, not only added, since a pool used before keeps its
 * finished claims and a thought edited since must be asked again; a claim records no fingerprint, so a switch to
 * another key and back asks again, too, those the model named nothing for. `--subjects rules` has a pool of its own,
 * so a later run with the model pools again the thoughts it left.
 *
 * Each claim is one thought, leased for the limit a call and LEASE_MARGIN_S more, so a worker that dies hands it back
 * within that; a run that stops hands back what it holds at once. A thought the extraction pass gave a current subject
 * after it was pooled is finished unasked. A claim finished records that the thought was asked at its text under the
 * pool's key: one the model named nothing for is not asked again until its text or the key changes ("asked, got
 * nothing"), and an out-of-date subject standing on it is closed through close_thought_subject (113), which closes it
 * only while it is still the one read at the text read, so a subject a pass wrote since stands. An answer that is not
 * JSON with a subject, a timeout or the provider refusing the thought's length, a row the egress gate refuses, and a
 * key the door refuses each fail the claim, counted, the subject standing; `--retry-failed` puts them back in the
 * pool. A rate limit, a server error or a lost connection is paused for and retried (TRANSIENT_PAUSES_MS), then ends
 * the sweep; any other refusal of the request ends it, exit 2, as it ends the pass. A dry run writes, pools and asks
 * nothing, counts what a run would take (the pool's, or every thought with no current subject when its pool is not
 * named yet), reads on through a signal as the pass's does, and names the refusals a run would meet.
 *
 * The extraction pass records the rules' subject with each thought's entities (extract-entities.ts's processRow), so
 * a thought filed under a ticket, or a session summary whose prompts name its header's ticket, has its subject once
 * it is extracted, and the sweep finishes it unasked. 111's door replaces a subject found under another pass key, so a
 * changed rule finds again the subjects it found, and those alone; version 1's one key for both rules is taken whole,
 * once, its filed tickets found again unchanged under the metadata rule's own key (review pass 5). Two sweeps, or a
 * sweep beside the pass, write each text's subject once: the claims are disjoint, and the door locks the thought and
 * checks the text's fingerprint. `--subjects rules` stops at the rules, for a brain whose judge model has not been
 * measured on the question.
 *
 * The question is asked with the judge model's reasoning on unless OB1_SUBJECT_REASONING says off (PR 4: Verify item 1
 * was met that way and missed without, though the difference alone was not significant), at about 8x the time a call,
 * and the default --timeout follows it. A subject a model found with its reasoning off is pooled again while it is on
 * (`@p2` under `@p2r`); turning it off pools none of those found with it on.
 */

import type { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { ProviderError, resolveEmbedConfig, type EmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { localKnob, ROW_UNITS } from "../server-portable/egress.ts";
import { actorKindOf } from "../server-portable/consolidate.ts";
import { askOwnSubject, ruleSubject, SUBJECT_KEY_PREFIX, subjectModelKey, subjectModelSuffix, subjectPoolKey, subjectReasoning, subjectReasoningOn, subjectRuleKey, type SubjectBy } from "../server-portable/subject.ts";
import { subjectRecipe, type Recipe } from "../server-portable/lineage.ts";
import { blanketGate, classifyError, databaseUnavailable, egressDescription, egressRefusal, MAX_CALL_TIMEOUT_S, regateMessage, TRANSIENT_PAUSES_MS, workerIdentity } from "./worker-bootstrap.ts";
import { sleepUnless, STOPPED_EARLY, type PassStop } from "./lease.ts";
import { consoleWriter, numberProblem, type Writer } from "./cli.ts";
import { databaseUrlProblem, NO_DATABASE_URL, openSql } from "./connect.ts";

/** 111's door, by its signature: the sweep's one write. */
const DOOR = "record_thought_subject(uuid, text, text, text, uuid, text, jsonb)";

/** 113's close, by its signature: the sweep's close of an out-of-date subject the model names nothing for. */
const CLOSE = "close_thought_subject(uuid, uuid, text)";

/** What the door needs of the role that calls it (111's comment), and where each grant comes from: the sweep's refusals and the pass's say this. */
export const DOOR_GRANTS = "INSERT and UPDATE on thought_facets (INSERT is the structure group's), UPDATE on thoughts (its row lock), and INSERT and UPDATE on derivations (the capture group's)";

/** What the pool needs of the role (113): the claims' writes, and the pool's name in ob1_config. */
export const POOL_GRANTS = "INSERT and UPDATE on thought_work_claims and on ob1_config";

/** A claim's lease past the limit a call: the door's write and the reads beside the call. */
export const LEASE_MARGIN_S = 300;

/** Leases a thought may take and lose, its worker gone, before its claim fails (claim_thoughts's p_max_attempts). */
const MAX_ATTEMPTS = 3;

/** What record_thought_subject answers. */
export type SubjectWrite = { ok: boolean; action: "added" | "kept" | "replaced" | "closed" | "none"; id?: string; stale?: boolean; gone?: boolean };

/** One thought's subject through 111's door, at the fingerprint of the text it was found in. */
export async function recordSubject(sql: SQL, row: { id: string; fingerprint: string }, key: string, by: SubjectBy, judgeKey: string, recipe: Recipe, agentId: string | null): Promise<SubjectWrite> {
  const [r] = await sql`SELECT record_thought_subject(${row.id}::uuid, ${key}, ${by}, ${judgeKey}, ${agentId}::uuid, ${row.fingerprint}, ${recipe}::jsonb) AS r`;
  return r.r as SubjectWrite;
}

/**
 * subject.ts's subjectCurrent in SQL, over a standing subject facet `f`: a rule's under that rule's key now, a model's
 * under the current question by any model, with its reasoning on while `reasoningOn`. False or NULL where the payload
 * lacks `by` or `judge_key`, either of which the sweep's NOT EXISTS reads as not current. test-live [10h] holds it to
 * subjectCurrent row by row under both settings.
 */
export function currentSubjectSql(sql: SQL, reasoningOn: boolean) {
  const [withReasoning, without] = [subjectModelSuffix(true), subjectModelSuffix(false)];
  return sql`CASE f.payload->>'by'
               WHEN 'metadata' THEN f.payload->>'judge_key' = ${subjectRuleKey("metadata")}
               WHEN 'first_line' THEN f.payload->>'judge_key' = ${subjectRuleKey("first_line")}
               WHEN 'model' THEN starts_with(f.payload->>'judge_key', ${SUBJECT_KEY_PREFIX})
                             AND (right(f.payload->>'judge_key', ${withReasoning.length}::int) = ${withReasoning}
                                  OR (${!reasoningOn}::boolean AND right(f.payload->>'judge_key', ${without.length}::int) = ${without}))
               ELSE false END`;
}

/** A database error's SQLSTATE. */
const sqlState = (e: unknown): string | undefined => {
  const { errno, code } = (e ?? {}) as { errno?: unknown; code?: unknown };
  return typeof errno === "string" ? errno : typeof code === "string" ? code : undefined;
};

/** The line a database that stopped answering ends the sweep with. */
const databaseDown = (e: unknown) => `\n  The database stopped answering (${String((e as Error)?.message ?? e).slice(0, 300)}): the sweep stops here; run it again.`;

/**
 * What one sweep is asked: `model` false for the rules alone; `limit` 0 for no limit; `timeout` in seconds, per model
 * call (left out, 900 with the judge model's reasoning on and 300 off); `retryFailed` to put the pool's failed claims
 * back in it first. `sql` is the caller's client in place of `url`, never closed here; `env` what the run reads,
 * process.env when absent. `signal` stops the sweep after the thought in hand, as the CLI's first signal does;
 * `onPass` is handed the sweep's stop as its thoughts begin, whose second call aborts the model call in hand too.
 * A dry run hears neither: it reads on.
 */
export interface SubjectSweepOptions {
  url?: string;
  sql?: SQL;
  env?: Record<string, string | undefined>;
  model?: boolean;
  limit?: number;
  timeout?: number;
  retryFailed?: boolean;
  dryRun?: boolean;
  writer?: Writer;
  signal?: AbortSignal;
  onPass?: (stop: PassStop) => void;
}

/** A dry run's pages, of the pool's claims or of the thoughts with no current subject. */
const PAGE = 100;

/**
 * A thought the sweep takes: its text and the fingerprint read, its standing subject's facet, key, way and pass when
 * one stands (at another text, or out of date), and whether that one is current at this text.
 */
type Candidate = {
  id: string; content: string; created_at: string | Date | null; metadata: Record<string, unknown> | null; fingerprint: string;
  standing_id: string | null; standing_key: string | null; standing_by: string | null; standing_judge: string | null; current: boolean;
};

/** What became of a claimed thought: the claim finished or failed (with why), or left as it is (the pool has it again, or it is gone). False ends the sweep. */
type Done = { release: "succeeded" } | { release: "failed"; error: string } | { release: "none" };

/** The sweep, callable: the code the CLI exits with (the header's list). */
export async function sweepSubjects(opts: SubjectSweepOptions): Promise<number> {
  const { out, err } = opts.writer ?? consoleWriter;
  const env = opts.env ?? process.env;
  const MODEL = opts.model !== false;
  const DRY_RUN = opts.dryRun === true;
  const RETRY_FAILED = opts.retryFailed === true;
  const noUrl = opts.url == null || opts.url.trim() === "";
  const urlProblem = noUrl ? (opts.sql == null ? NO_DATABASE_URL : null) : databaseUrlProblem(opts.url as string);
  if (urlProblem !== null) {
    err(urlProblem);
    return 2;
  }
  for (const [flag, v, rule] of [["--limit", opts.limit, { min: 1 }], ["--timeout", opts.timeout, { min: 1, max: MAX_CALL_TIMEOUT_S }]] as const) {
    const problem = v == null ? null : numberProblem(flag, v, rule);
    if (problem !== null) {
      err(problem);
      return 2;
    }
  }
  const LIMIT = opts.limit ?? 0;
  const resolved = resolveEmbedConfig(env as EmbedEnv);
  // A reasoning call runs long: of 200 the 27B answered with its reasoning on, two took over 300 s, the slowest 369 s,
  // where the slowest of 160 without it took 133 s (SMD-3306 PR 4): each default about 2.4x and 2.3x the slowest.
  const TIMEOUT_S = opts.timeout ?? (subjectReasoningOn(resolved) ? 900 : 300);
  if (opts.sql != null && noUrl && env.OB1_WORKER_KEY && !DRY_RUN) {
    // The pass's rule (extract-entities.ts's run): the key resolves on a connection of its own.
    err("extract-entities.ts --subjects resolves OB1_WORKER_KEY on a connection of its own (db/worker-bootstrap.ts): pass url beside sql, or run without the key.");
    return 2;
  }
  if (opts.signal?.aborted && !DRY_RUN) {
    err(STOPPED_EARLY);
    return 130;
  }
  const cfg: EmbedConfig = { ...resolved, timeoutMs: TIMEOUT_S * 1000 };
  const sql = opts.sql ?? openSql(opts.url as string, { max: 2 });
  try {
    return await sweep(sql, cfg, { MODEL, DRY_RUN, LIMIT, RETRY_FAILED, env, url: opts.url ?? "", signal: opts.signal, onPass: opts.onPass, out, err });
  } catch (e) {
    // A database that stops answering before the pages, or between them, ends the sweep in words, not a trace
    // (review pass 2).
    if (!databaseUnavailable(e)) throw e;
    err(databaseDown(e));
    return 1;
  } finally {
    if (opts.sql == null) await sql.close().catch(() => {});
  }
}

async function sweep(
  sql: SQL,
  cfg: EmbedConfig,
  o: { MODEL: boolean; DRY_RUN: boolean; LIMIT: number; RETRY_FAILED: boolean; env: Record<string, string | undefined>; url: string; signal?: AbortSignal; onPass?: (stop: PassStop) => void; out: Writer["out"]; err: Writer["err"] },
): Promise<number> {
  const { MODEL, DRY_RUN, LIMIT, RETRY_FAILED, env, out, err } = o;
  const reasoning = subjectReasoning(cfg);
  const reasoningOn = subjectReasoningOn(cfg);
  /** The effort each question sends, which a refusal names (review pass 2): nothing at the default, with reasoning on. */
  const sentEffort = cfg.subjectReasoning.reasoning_effort;
  const judgeKey = subjectModelKey(cfg.judgeModel, reasoningOn);
  const POOL = subjectPoolKey(MODEL, reasoningOn);
  /** What a run would be refused, said by a dry run, which goes on to count (review pass 2). */
  const wouldRefuse: string[] = [];
  out(`  subjects: the rules (${subjectRuleKey("metadata")}, ${subjectRuleKey("first_line")})${MODEL ? `, then ${cfg.judgeModel} via ${cfg.chat.base}, temperature ${cfg.metadataTemperature}, reasoning ${reasoning}, at most ${cfg.timeoutMs / 1000} s a call (${judgeKey})` : ", no model (--subjects rules)"}`);
  if (MODEL) {
    out(`  egress: ${egressDescription(cfg.chat, cfg.egress, localKnob(cfg, "chat"))}`);
    // A policy that refuses whatever the row: stop before the first call, as the pass does (SMD-1903).
    const blanket = blanketGate({ endpoint: cfg.chat, policy: cfg.egress, units: env.OB1_WORKER_KEY ? undefined : ROW_UNITS, verb: "asked for its subject", localKnobKey: localKnob(cfg, "chat") });
    if (blanket && !DRY_RUN) {
      err(`\n  ${blanket} Or run --subjects rules, which asks no model.`);
      return 2;
    }
    if (blanket) wouldRefuse.push("the egress gate refuses every row (the egress line above)");
  }
  const [{ door, close }] = (await sql`SELECT to_regprocedure(${DOOR}) IS NOT NULL AS door, to_regprocedure(${CLOSE}) IS NOT NULL AS close`) as { door: boolean; close: boolean }[];
  if (!door || !close) {
    err(`\n  ${door ? "close_thought_subject is missing: the subject pool is migration 113's" : "record_thought_subject is missing: a thought's own subject is migration 111's"}. Apply it first:\n    cd db && bun migrate.ts --url …`);
    return 2;
  }
  // The door's and the pool's grants, asked before any model call: a role that cannot write a subject is refused here,
  // not at its first write with a question already spent (review pass 1). A dry run says it instead.
  const [{ can, pools }] = (await sql`
    SELECT has_any_column_privilege('thought_facets', 'INSERT') AND has_any_column_privilege('thought_facets', 'UPDATE')
       AND has_any_column_privilege('thoughts', 'UPDATE')
       AND has_any_column_privilege('derivations', 'INSERT') AND has_any_column_privilege('derivations', 'UPDATE') AS can,
           has_any_column_privilege('thought_work_claims', 'INSERT') AND has_any_column_privilege('thought_work_claims', 'UPDATE')
       AND has_any_column_privilege('ob1_config', 'INSERT') AND has_any_column_privilege('ob1_config', 'UPDATE') AS pools`) as { can: boolean; pools: boolean }[];
  if ((!can || !pools) && !DRY_RUN) {
    err(`\n  This role cannot ${can ? "claim from the subject pool: it needs" : "write a thought's subject: record_thought_subject needs"} ${can ? POOL_GRANTS : DOOR_GRANTS}. Grant them, or run the sweep as a role that holds them.`);
    return 2;
  }
  if (!can) wouldRefuse.push("this role cannot write a thought's subject");
  if (!pools) wouldRefuse.push("this role cannot claim from the subject pool");

  let agentId: string | null = null;
  let actor: string | undefined;
  if (!DRY_RUN) {
    const id = await workerIdentity(o.url, env, {
      noKeyWarning: "  ⚠  OB1_WORKER_KEY is not set: the subjects' lineage rows will carry no agent id. Mint one with server-portable/keygen.ts and add its hash to MCP_ACCESS_KEYS.",
      write: out,
      warn: (l) => { if (l) err(l); },
    });
    if (!id.ok) {
      err(id.message);
      return 2;
    }
    agentId = id.identity.agentId;
    actor = id.identity.keyName;
    if (MODEL && env.OB1_WORKER_KEY && actor === undefined) {
      const again = egressRefusal(cfg.chat, cfg.egress, ROW_UNITS);
      if (again) {
        err(`\n  ${regateMessage("asked for its subject", again)}`);
        return 2;
      }
    }
  }

  // No current subject: none standing at the thought's text, or one found under another rule's key or an older
  // question's, or a model's found with its reasoning off when the question is asked with it on.
  const NO_CURRENT_SUBJECT = sql`
    NOT EXISTS (
      SELECT 1 FROM thought_facets f JOIN derivations d ON d.artifact_kind = 'subject' AND d.artifact_id = f.id
       WHERE f.thought_id = t.id AND f.kind = 'subject' AND f.valid_until IS NULL
         AND d.input_fingerprints[1] = COALESCE(t.content_fingerprint, content_fingerprint_of(t.content))
         AND ${currentSubjectSql(sql, reasoningOn)})`;
  /** A thought's columns for the sweep, its standing subject beside it (`t` and `s`). */
  const CANDIDATE = sql`t.id, t.content, t.created_at, t.metadata, COALESCE(t.content_fingerprint, content_fingerprint_of(t.content)) AS fingerprint,
           s.id::text AS standing_id, s.payload->>'key' AS standing_key, s.payload->>'by' AS standing_by, s.payload->>'judge_key' AS standing_judge,
           NOT ${NO_CURRENT_SUBJECT} AS current`;

  // The pool: the one ob1_config.subject_pool_key names, into which 113's trigger puts new and edited thoughts. A sweep
  // under another key names its own and pools every thought with no current subject — requeued, since a pool used
  // before keeps its finished claims and a thought edited since must be asked again — once, at the change.
  let named: string | null;
  try {
    named = ((await sql`SELECT value FROM ob1_config WHERE key = 'subject_pool_key'`) as { value: string }[])[0]?.value ?? null;
  } catch (e) {
    if (sqlState(e) !== "42501") throw e;
    err(`\n  This role cannot read the subject pool's name (${(e as Error).message}): the sweep reads ob1_config, thoughts, thought_facets and derivations.`);
    return 2;
  }
  const newPool = named !== POOL;
  const unnamed = named === null ? "none was named" : `${named} was`;
  if (newPool && DRY_RUN) {
    const [{ n }] = (await sql`SELECT count(*)::int AS n FROM thoughts t WHERE ${NO_CURRENT_SUBJECT}`) as { n: number }[];
    out(`  pool ${POOL}: not named (${unnamed}): a run names it and pools the ${n} thought(s) with no current subject`);
  } else if (newPool) {
    // Named first, so a thought captured from here on joins it by the trigger; then the thoughts with no current
    // subject, each requeued (MATERIALIZED: every row's call is made, whatever the count reads of it).
    await sql`INSERT INTO ob1_config (key, value) VALUES ('subject_pool_key', ${POOL})
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    const [{ n }] = (await sql`
      WITH pooled AS MATERIALIZED (SELECT requeue_thought_work(${POOL}, t.id) FROM thoughts t WHERE ${NO_CURRENT_SUBJECT})
      SELECT count(*)::int AS n FROM pooled`) as { n: number }[];
    out(`  pool ${POOL}: named (${unnamed}), and the ${n} thought(s) with no current subject pooled; new and edited thoughts join it from here on`);
  }
  if (RETRY_FAILED && !DRY_RUN) {
    // extract-entities.ts's --retry-failed statement, under the pool's key.
    const [{ n }] = (await sql`
      WITH retried AS (
        UPDATE thought_work_claims SET status = 'pending', last_error = NULL, finished_at = NULL, attempt_count = 0
        WHERE work_type = ${POOL} AND status = 'failed' RETURNING 1)
      SELECT count(*)::int AS n FROM retried`) as { n: number }[];
    out(`  --retry-failed: ${n} failed claim(s) returned to the pool`);
  }
  // Each count by the index on (work_type, status): the pool's rows still to do, not its history.
  const [pool] = (await sql`
    SELECT (SELECT count(*) FROM thought_work_claims WHERE work_type = ${POOL} AND status = 'pending')::int AS pending,
           (SELECT count(*) FROM thought_work_claims WHERE work_type = ${POOL} AND status = 'claimed')::int AS claimed,
           (SELECT count(*) FROM thought_work_claims WHERE work_type = ${POOL} AND status = 'failed')::int AS failed`) as { pending: number; claimed: number; failed: number }[];
  if (!(newPool && DRY_RUN)) {
    out(`  pool ${POOL}: ${pool.pending} pending${pool.claimed ? `, ${pool.claimed} leased` : ""}${pool.failed ? `, ${pool.failed} failed${RETRY_FAILED ? "" : " (--retry-failed asks them again)"}` : ""}${LIMIT ? `; this run takes at most ${LIMIT}` : ""}`);
  }

  /**
   * `seen`: the thoughts finished, each in one of the buckets after it, so the summary's counts add up to it (review
   * pass 2: a thought the sweep ended at was counted and in none). `taken`, for --limit, counts that one too.
   * `replaced` and `newKey` count within the recorded ones, `closed` within those the model named nothing for,
   * `leftOutOfDate` within the rest: no bucket of their own.
   */
  const n = { seen: 0, current: 0, metadata: 0, first_line: 0, model: 0, replaced: 0, newKey: 0, kept: 0, named: 0, closed: 0, unread: 0, unanswered: 0, left: 0, leftOutOfDate: 0, stale: 0, gone: 0, refusedKey: 0, egress: 0 };
  let taken = 0;
  let llmMs = 0;
  let calls = 0;
  /**
   * Why the sweep ended early, the provider, the database or the role, with its code; null when it ran out of
   * thoughts, reached its limit or was stopped. Written inside `one`, which control-flow analysis does not follow: the
   * cast keeps the declared type (SMD-1932's way, as extract-entities.ts's configError).
   */
  let endedBy = null as { code: number; line: string } | null;
  const said = { unread: false, unanswered: false, refusedKey: false, egress: false };
  const started = Date.now();
  let reported = started;

  // The stop, as the pass's (db/lease.ts's PassStop): the first after the thought in hand, the second the call in
  // hand too. A dry run writes nothing and asks nothing, and reads on, as the pass's does.
  const stop = new AbortController();
  const hardStop = new AbortController();
  let ended = false;
  const passStop: PassStop = () => {
    if (ended) return null;
    if (!stop.signal.aborted) {
      stop.abort();
      return null;
    }
    hardStop.abort();
    return Promise.resolve();
  };

  /** The judge model's subject for a row: the answer, an egress refusal, or the thought left unanswered; throws to end the sweep. */
  async function ask(row: Candidate): Promise<{ key: string | null; answer: string | null } | { egress: string } | { unanswered: string }> {
    const side = { content: row.content, createdAt: row.created_at, metadata: row.metadata ?? {}, writer: actorKindOf(row.metadata) };
    const subject = { kind: "extraction" as const, actor, metadata: row.metadata ?? undefined, content: row.content };
    for (let attempt = 0; ; attempt++) {
      const t0 = Date.now();
      /** Whether a request was made (providerCall's gate refuses before any), and when its answer or error came: a pause after it is not the model's time. */
      let made = true, came = 0;
      try {
        const a = await askOwnSubject(cfg, side, subject, hardStop.signal);
        came = Date.now();
        return { key: a.key, answer: a.answer };
      } catch (e) {
        came = Date.now();
        if (hardStop.signal.aborted) throw e;
        if (e instanceof ProviderError && e.kind === "egress") {
          made = false;
          return { egress: e.message };
        }
        const kind = classifyError(e);
        if (kind === "thought") {
          // A timeout names the sweep's limit, which --timeout sets over the provider's knob the message names (review
          // pass 2).
          const timedOut = e instanceof ProviderError && e.kind === "timeout";
          return { unanswered: timedOut ? `timed out after ${cfg.timeoutMs / 1000} s, the sweep's limit a call, which --timeout sets` : (e as Error).message };
        }
        if (kind === "transient" && attempt < TRANSIENT_PAUSES_MS.length) {
          await sleepUnless(TRANSIENT_PAUSES_MS[attempt], stop.signal);
          if (stop.signal.aborted) throw e;
          continue;
        }
        throw e;
      } finally {
        if (made) {
          calls++;
          llmMs += (came || Date.now()) - t0;
        }
      }
    }
  }

  /** Each kind said once, with the first thought it took: the summary counts the rest. */
  function sayOnce(kind: keyof typeof said, line: string): void {
    if (!said[kind]) err(line);
    said[kind] = true;
  }

  /**
   * One thought: current already, else the rules, else the model; what the door answered, counted, and what becomes of
   * its claim. False ends the sweep, the thought unfinished and its claim handed back. A dry run counts as a run would.
   */
  async function one(row: Candidate): Promise<Done | false> {
    // The extraction pass gave it a current subject after it was pooled: finished, unasked.
    if (row.current) {
      n.current++;
      return { release: "succeeded" };
    }
    const found = ruleSubject(row);
    let key: string, by: SubjectBy, judge: string, recipe: Recipe;
    if (found && DRY_RUN) {
      // The door keeps a subject found the same way by the same pass at a moved text, and replaces any other standing
      // one: counted as a run would count it.
      if (row.standing_key === found.key && row.standing_by === found.by && row.standing_judge === subjectRuleKey(found.by)) n.kept++;
      else {
        n[found.by]++;
        if (row.standing_key !== null) {
          n.replaced++;
          if (row.standing_key !== found.key) n.newKey++;
        }
      }
      return { release: "none" };
    }
    if (found) {
      ({ key, by } = found);
      judge = subjectRuleKey(found.by);
      recipe = subjectRecipe({ by: found.by });
    } else if (!MODEL || DRY_RUN) {
      n.left++;
      // One holding a subject found at another text or under an older rule or question: it stands until a model's
      // answer replaces it. Under --subjects rules the claim is finished: the rules' pool is done with the thought, and
      // a run with the model pools it again.
      if (row.standing_key !== null) n.leftOutOfDate++;
      return DRY_RUN ? { release: "none" } : { release: "succeeded" };
    } else {
      let a: Awaited<ReturnType<typeof ask>>;
      try {
        a = await ask(row);
      } catch (e) {
        if (hardStop.signal.aborted || stop.signal.aborted) return false;
        const kind = classifyError(e);
        endedBy = kind === "fatal"
          ? { code: 2, line: `\n  The provider refused the request itself: ${(e as Error).message.slice(0, 300)}\n  Check the chat endpoint (OB1_CHAT_BASE_URL and OB1_CHAT_API_KEY, or OB1_LLM_BASE_URL and OB1_LLM_API_KEY when those are unset) and OB1_JUDGE_MODEL against the provider${sentEffort === undefined ? "" : `, and OB1_SUBJECT_REASONING, which sent reasoning_effort ${JSON.stringify(sentEffort)}`}. Nothing was recorded for this thought.` }
          : { code: 1, line: `\n  The provider is not answering after ${TRANSIENT_PAUSES_MS.length} pauses (${(e as Error).message.slice(0, 300)}): the sweep stops here; run it again.` };
        return false;
      }
      // Each outcome below but a closed subject writes nothing: a subject out of date stands, counted.
      if ("egress" in a) {
        n.egress++;
        if (row.standing_key !== null) n.leftOutOfDate++;
        sayOnce("egress", `  ${row.id}: ${a.egress.slice(0, 300)}`);
        return { release: "failed", error: a.egress.slice(0, 500) };
      }
      if ("unanswered" in a) {
        n.unanswered++;
        if (row.standing_key !== null) n.leftOutOfDate++;
        sayOnce("unanswered", `  ${row.id}: no answer (${a.unanswered.slice(0, 300)}); --retry-failed asks it again`);
        return { release: "failed", error: a.unanswered.slice(0, 500) };
      }
      // Not JSON with a subject: the model's failure for this thought, as the pass reads a malformed answer.
      if (a.answer === null) {
        n.unread++;
        if (row.standing_key !== null) n.leftOutOfDate++;
        sayOnce("unread", `  ${row.id}: ${cfg.judgeModel}'s answer was not JSON of the expected shape; --retry-failed asks it again`);
        return { release: "failed", error: `${cfg.judgeModel}'s answer was not JSON of the expected shape` };
      }
      if (a.key === null) {
        // Asked, got nothing: the claim finished is the record, so it is not asked again until its text or the pool
        // changes; an out-of-date subject standing on it closes, if it is still the one read at the text read.
        n.named++;
        if (row.standing_id !== null && !DRY_RUN && !hardStop.signal.aborted) {
          let c: { action: string; stale?: boolean; gone?: boolean };
          try {
            [{ c }] = (await sql`SELECT close_thought_subject(${row.id}::uuid, ${row.standing_id}::uuid, ${row.fingerprint}) AS c`) as { c: typeof c }[];
          } catch (e) {
            if (sqlState(e) === "42501") {
              endedBy = { code: 2, line: `\n  This role cannot close a thought's subject (${(e as Error).message.slice(0, 300)}): close_thought_subject needs UPDATE on thought_facets and on thoughts.` };
              return false;
            }
            if (databaseUnavailable(e)) {
              endedBy = { code: 1, line: databaseDown(e) };
              return false;
            }
            throw e;
          }
          if (c.action === "closed") n.closed++;
          // The text moved since it was read: the pool's trigger has it again, at its new text.
          if (c.stale) return { release: "none" };
        }
        return { release: "succeeded" };
      }
      key = a.key;
      by = "model";
      judge = judgeKey;
      recipe = subjectRecipe({ by: "model", model: cfg.judgeModel, temperature: cfg.metadataTemperature, reasoning, answer: a.answer });
    }
    // Past the hard stop nothing more is written.
    if (hardStop.signal.aborted) return false;
    let w: SubjectWrite;
    try {
      w = await recordSubject(sql, row, key, by, judge, recipe, agentId);
    } catch (e) {
      const state = sqlState(e);
      if (state === "22023") {
        n.refusedKey++;
        if (row.standing_key !== null) n.leftOutOfDate++;
        sayOnce("refusedKey", `  ${row.id}: record_thought_subject refused the key (${(e as Error).message.slice(0, 300)})`);
        return { release: "failed", error: `record_thought_subject refused the key: ${(e as Error).message.slice(0, 400)}` };
      }
      if (state === "42501") {
        endedBy = { code: 2, line: `\n  This role cannot write a thought's subject (${(e as Error).message.slice(0, 300)}): record_thought_subject needs ${DOOR_GRANTS}.` };
        return false;
      }
      if (databaseUnavailable(e)) {
        endedBy = { code: 1, line: databaseDown(e) };
        return false;
      }
      throw e;
    }
    if (w.stale) {
      // The text moved mid-sweep (review pass 4): the pool's trigger has the thought again, at its new text, so its
      // claim is not this worker's to finish, and this run takes it again when it comes up.
      n.stale++;
      return { release: "none" };
    }
    if (w.gone) {
      n.gone++;
      return { release: "none" };
    }
    if (w.action === "kept") n.kept++;
    else if (w.action === "added" || w.action === "replaced") {
      n[by]++;
      if (w.action === "replaced") {
        n.replaced++;
        // Review pass 3: the replacements of a version's bump mostly keep their key; how many changed is what a
        // reader wants.
        if (row.standing_key !== key) n.newKey++;
      }
    }
    return { release: "succeeded" };
  }

  /** A progress line, at most every 10 s, for a run: of the claims pending at its start, which an edit can add to. */
  const todo = LIMIT ? Math.min(LIMIT, pool.pending) : pool.pending;
  const progress = () => {
    if (DRY_RUN || Date.now() - reported < 10_000) return;
    reported = Date.now();
    out(`  ${n.seen}/${todo}  ${n.metadata + n.first_line + n.model} recorded, ${n.named} named nothing${n.unanswered + n.unread ? `, ${n.unanswered + n.unread} unanswered or unread` : ""}`);
  };

  // The stop is handed out, and the caller's signal heard, while the thoughts are taken, then let go: a signal a
  // caller keeps holds no listener. A dry run hears neither.
  const detach = new AbortController();
  if (!DRY_RUN) {
    o.signal?.addEventListener("abort", () => passStop(), { once: true, signal: detach.signal });
    if (o.signal?.aborted) passStop();
    o.onPass?.(passStop);
  }
  const workerId = `subjects-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const TTL_S = Math.ceil(cfg.timeoutMs / 1000) + LEASE_MARGIN_S;
  try {
    if (DRY_RUN) {
      // The thoughts a run would take: every one with no current subject when the pool is not named yet, else the
      // pool's pending claims (and its failed ones under --retry-failed), a page at a time. The cursor's time is
      // carried as Postgres's text: a Date keeps milliseconds of its microseconds, so a page's last row read after
      // it again, and the dry run paged without end.
      let afterId = "00000000-0000-0000-0000-000000000000";
      let afterAt = "-infinity";
      pages: for (;;) {
        let rows: (Candidate & { enqueued_at?: string })[];
        try {
          rows = (newPool
            ? await sql`
                SELECT ${CANDIDATE} FROM thoughts t
                  LEFT JOIN thought_facets s ON s.thought_id = t.id AND s.kind = 'subject' AND s.valid_until IS NULL
                 WHERE t.id > ${afterId}::uuid AND ${NO_CURRENT_SUBJECT}
                 ORDER BY t.id LIMIT ${PAGE}`
            : await sql`
                SELECT ${CANDIDATE}, c.enqueued_at::text AS enqueued_at FROM thought_work_claims c JOIN thoughts t ON t.id = c.thought_id
                  LEFT JOIN thought_facets s ON s.thought_id = t.id AND s.kind = 'subject' AND s.valid_until IS NULL
                 WHERE c.work_type = ${POOL} AND c.status IN ('pending', ${RETRY_FAILED ? "failed" : "pending"})
                   AND (c.enqueued_at, c.thought_id) > (${afterAt}::timestamptz, ${afterId}::uuid)
                 ORDER BY c.enqueued_at, c.thought_id LIMIT ${PAGE}`) as (Candidate & { enqueued_at?: string })[];
        } catch (e) {
          if (!databaseUnavailable(e)) throw e;
          endedBy = { code: 1, line: databaseDown(e) };
          break;
        }
        if (rows.length === 0) break;
        for (const row of rows) {
          afterId = row.id;
          if (row.enqueued_at !== undefined) afterAt = row.enqueued_at;
          if (LIMIT && taken >= LIMIT) break pages;
          taken++;
          await one(row);
          n.seen++;
        }
      }
    } else {
      for (;;) {
        if (stop.signal.aborted || (LIMIT && taken >= LIMIT)) break;
        let claimed: { thought_id: string }[];
        try {
          claimed = (await sql`SELECT thought_id FROM claim_thoughts(${POOL}, ${workerId}, 1, ${TTL_S}, ${MAX_ATTEMPTS})`) as { thought_id: string }[];
        } catch (e) {
          if (!databaseUnavailable(e)) throw e;
          endedBy = { code: 1, line: databaseDown(e) };
          break;
        }
        if (claimed.length === 0) break;
        taken++;
        const id = claimed[0].thought_id;
        let row: Candidate | undefined;
        try {
          [row] = (await sql`
            SELECT ${CANDIDATE} FROM thoughts t
              LEFT JOIN thought_facets s ON s.thought_id = t.id AND s.kind = 'subject' AND s.valid_until IS NULL
             WHERE t.id = ${id}::uuid`) as Candidate[];
        } catch (e) {
          if (!databaseUnavailable(e)) throw e;
          endedBy = { code: 1, line: databaseDown(e) };
          break;
        }
        if (row === undefined) {
          // Deleted after the claim: its claim went with it.
          n.gone++;
          n.seen++;
          continue;
        }
        const done = await one(row);
        if (done === false) break;
        if (done.release !== "none") {
          try {
            // False: an edit put it back in the pool (the trigger), so it is the pool's again at its new text.
            await sql`SELECT release_thought(${id}::uuid, ${POOL}, ${workerId}, ${done.release}, ${done.release === "failed" ? done.error : null}) AS ok`;
          } catch (e) {
            if (!databaseUnavailable(e)) throw e;
            endedBy = { code: 1, line: databaseDown(e) };
            break;
          }
        }
        n.seen++;
        progress();
      }
    }
  } finally {
    ended = true;
    detach.abort();
    // What this worker still holds goes back to the pool, its attempt not counted: a stop, an error, a database lost.
    if (!DRY_RUN) await sql`SELECT release_claims_for_worker(${POOL}, ${workerId})`.catch(() => {});
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const clauses = (parts: [number, string][]) => parts.filter(([k]) => k > 0).map(([k, s]) => `${k} ${s}`).join(", ");
  if (DRY_RUN) {
    // Ended early (the database, at a page), it counted part of the thoughts: say why, not a would-line of a part.
    if (endedBy) {
      err(endedBy.line);
      return endedBy.code;
    }
    out(`\n  would: of ${n.seen} thought(s), record ${clauses([[n.metadata, "by the ticket each is filed under"], [n.first_line, "by its session header's ticket"]]) || "none by the rules"}` +
      (n.replaced ? ` (${n.replaced} in place of a standing subject, ${n.newKey} with a new key)` : "") +
      (n.kept ? `, keep ${n.kept} found the same way at the text read now` : "") +
      (n.current ? `, finish ${n.current} already current` : "") + "; " +
      (MODEL ? `ask ${cfg.judgeModel} about ${n.left}` : `leave ${n.left} for the judge model (--subjects without rules)`) +
      (n.leftOutOfDate ? ` (${n.leftOutOfDate} with an out-of-date subject)` : "") + ". Nothing was written, pooled or asked." +
      (wouldRefuse.length ? ` A run would be refused: ${wouldRefuse.join("; ")}.` : ""));
    return 0;
  }
  const recorded = n.metadata + n.first_line + n.model;
  const by = clauses([[n.metadata, "by the ticket filed under"], [n.first_line, "by the session header's ticket"], [n.model, `by ${cfg.judgeModel}`]]);
  const rest = clauses([[n.current, "already current"], [n.kept, "kept, at the text read now"], [n.named, `the model named nothing for${n.closed ? ` (${n.closed} out-of-date subject(s) closed)` : ""}`], [n.left, "left for the judge model (--subjects rules)"], [n.unread, "answered not as JSON of the expected shape"], [n.unanswered, "unanswered"], [n.stale, "edited mid-sweep"], [n.gone, "deleted mid-sweep"], [n.egress, "refused by the egress gate"], [n.refusedKey, "keys refused"]]);
  const outOfDate = n.leftOutOfDate ? ` — among them, ${n.leftOutOfDate} with an out-of-date subject still standing` : "";
  out(`\n  ${n.seen} thought(s) in ${elapsed}s${calls ? ` (${(llmMs / 1000).toFixed(1)}s in ${calls} model call(s))` : ""}: ${recorded} subject(s) recorded${by ? ` (${by})` : ""}${n.replaced ? `, ${n.replaced} in place of a standing one (${n.newKey} with a new key)` : ""}${rest ? `; ${rest}${outOfDate}` : ""}`);
  if (endedBy) {
    err(endedBy.line);
    return endedBy.code;
  }
  if (stop.signal.aborted) {
    err(`\n  stopped after ${n.seen} thought(s): what it held is back in the pool, and the next sweep takes up the rest`);
    return 130;
  }
  const failedNow = n.unanswered + n.unread + n.egress + n.refusedKey;
  if (failedNow > 0) err(`\n  ${failedNow} claim(s) failed: fix the cause and run again with --retry-failed`);
  return failedNow > 0 ? 1 : 0;
}
