/**
 * subject-sweep.ts — the extraction worker's `--subjects` sweep (SMD-3306): each thought in the subject pool (migration
 * 113) is given its own subject, the rules' or, for the rest, the judge model's (server-portable/subject.ts), through
 * migration 111's record_thought_subject. A subject is current when it stands at the thought's text and was found
 * under the current rules and question, a model's with its reasoning on when the question is asked with it on
 * (subjectCurrent), and the ticket the thought is filed under agrees with it (filedTicketSql).
 *
 *   bun db/extract-entities.ts --url … --subjects                # the rules, then the judge model for the rest
 *   bun db/extract-entities.ts --url … --subjects rules          # the rules alone: no model call
 *   bun db/extract-entities.ts --url … --subjects --dry-run      # how many each would find; writes, pools and asks nothing
 *   bun db/extract-entities.ts --url … --subjects --limit 50     # at most this many thoughts
 *   bun db/extract-entities.ts --url … --subjects --retry-failed # the pool's failed claims back in it first
 *   bun db/extract-entities.ts --url … --subjects --switch-key   # required when another pool is named
 *   --timeout SECONDS (per model call: 900 with the judge model's reasoning on, 300 off)
 *   OB1_SUBJECT_REASONING=off                                    # the judge model without its reasoning (on unset)
 *   exits 0 clean · 1 claims failed (unanswered, unread or refused, or a lease run out at its last attempt while it
 *   claimed), its pooling broke off, or the provider or the database stopped answering · 2 usage, configuration,
 *   another pool named without --switch-key, a capturing role a pool would fail, a role without the door's or the
 *   pool's grants or the provider's refusal · 130 a signal (the first after the call in hand, which can run to the
 *   limit a call; a second at once, the claim in hand handed back)
 *
 * The pool (113, PR 5). The sweep claims from thought_work_claims under its pool's key (subject.ts's subjectPoolKey:
 * the rules' versions and, when it asks the model, the question's with its reasoning), as the extraction pass claims
 * under its own, so a run costs what is in the pool, not the brain's size: until PR 5 every run read every thought,
 * its count and its pages, and a PGlite run timed the count alone at 5.9 s over a million synthetic thoughts. 113's
 * trigger puts each new or edited thought (back) in the pool ob1_config.subject_pool_key names. The first sweep names
 * its own and pools every thought with no current subject; after a rule's, the question's or the reasoning's change,
 * or for `--subjects rules`, whose pool is its own, a sweep under another key does so only with --switch-key, as the
 * pass's own key change is refused without it (review pass 1: a rules run renamed the model's pool unasked). They are
 * requeued, not only added, since a pool used before keeps its finished claims and a thought edited since must be
 * asked again; a claim records no fingerprint, so a switch to another key and back asks again, too, those the model
 * named nothing for. The pooling is marked finished in ob1_config.subject_pool_filled once it commits, so one that
 * broke off (a thought deleted under it, a lost connection) is pooled again by the next run (review pass 1: the pool
 * stood named and its backlog was never pooled). A signal during the naming and pooling ends the CLI at once, the
 * stop not yet handed out; the pooling, one statement, runs on to its end on the server, holding the pool's lock, and
 * its end unmarked, the next run pools again. The first naming is refused while a login role that can capture (it
 * reads ob1_config, without which 016's trigger refuses it already) cannot write the claims 113's trigger writes as
 * it, which would fail its every capture.
 *
 * Each claim is one thought, leased for the limit a call and LEASE_MARGIN_S more, renewed (031's renew_claims) before
 * a call is asked again, so a worker that dies hands it back within that; a run that stops hands back what it holds,
 * and a second signal hands back the claim in hand before the CLI exits. A thought the provider stopped answering on
 * goes back to the end of the pool, so the next run starts with another (review pass 1: it came first again, and
 * ended every run). A thought the extraction pass gave a current subject
 * after it was pooled is finished unasked, so long as the rules agree now (a ticket filed, moved or taken away is read
 * again). A claim finished records that the thought was asked at its text under the
 * pool's key: one the model named nothing for is not asked again until its text or the key changes ("asked, got
 * nothing"), and an out-of-date subject standing on it is closed through close_thought_subject (113), which closes it
 * only while it is still the one read at the text read, so a subject a pass wrote since stands. An answer that is not
 * JSON with a subject, a timeout or the provider refusing the thought's length, a row the egress gate refuses, and a
 * key the door refuses each fail the claim, counted, the subject standing; `--retry-failed` puts them back in the
 * pool. A rate limit, a server error or a lost connection is paused for and retried (TRANSIENT_PAUSES_MS), then ends
 * the sweep; any other refusal of the request ends it, exit 2, as it ends the pass. A dry run writes, pools and asks
 * nothing, counts what a run would take (the pool's, or every thought with no current subject when its pool is not
 * named yet or its pooling broke off), reads on through a signal as the pass's does, and names the refusals a run
 * would meet. Its pages go in thought id order, so with --limit it counts the first by id, which a run, taking the
 * oldest pooled first, need not.
 *
 * The extraction pass records the rules' subject with each thought's entities (extract-entities.ts's processRow), so
 * a thought filed under a ticket, or a session summary whose prompts name its header's ticket, has its subject once
 * it is extracted, and the sweep finishes it unasked. 111's door replaces a subject found under another pass key, so a
 * changed rule finds again the subjects it found, and those alone; version 1's one key for both rules is taken whole,
 * once, its filed tickets found again unchanged under the metadata rule's own key (review pass 5). Two sweeps, or a
 * sweep beside the pass, write each text's subject once: under one key the claims are disjoint while their leases
 * hold (a naming leaves a live lease to its run; an edit pools its thought again), and whatever the claims, the door
 * locks the thought and checks the text's fingerprint and, since 113, the ticket it is filed under (PR 5's review
 * pass 5: a subject read before the ticket moved landed after another pass recorded the ticket's, and stood).
 * `--subjects rules` stops at the rules, for a brain whose judge model has not been measured on the question.
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

/** What the pool needs of the role (113): the claims' reads and writes, and the pool's name in ob1_config. */
export const POOL_GRANTS = "SELECT, INSERT and UPDATE on thought_work_claims, and INSERT and UPDATE on ob1_config";

/** A claim's lease past the limit a call: the door's write and the reads beside the call. */
export const LEASE_MARGIN_S = 300;

/**
 * How long a naming waits for the transactions writing thoughts as it named the pool before it pools without them,
 * leaving its pooling unfinished for the next run: read as the run goes, so a test shortens it, as OUTAGE_MS is.
 */
export const WRITERS_WAIT = { ms: 30_000 };

/** The least thought id: a cursor before every page. */
const NIL_ID = "00000000-0000-0000-0000-000000000000";

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

/**
 * The ticket a thought `t` is filed under: 113's ob1_filed_ticket, subject.ts's metadataTicket in SQL, which the door
 * reads too, under its lock (review pass 5: two copies, the sweep's and the door's, would have to agree). test-live
 * [10h] holds it to metadataTicket value by value.
 */
export function filedTicketSql(sql: SQL) {
  return sql`ob1_filed_ticket(t.metadata)`;
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
 * call (left out, 900 with the judge model's reasoning on and 300 off); `switchKey` to name this run's pool in place of
 * another named; `retryFailed` to put the pool's failed claims
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
  switchKey?: boolean;
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
  const SWITCH_KEY = opts.switchKey === true;
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
    return await sweep(sql, cfg, { MODEL, DRY_RUN, LIMIT, RETRY_FAILED, SWITCH_KEY, env, url: opts.url ?? "", signal: opts.signal, onPass: opts.onPass, out, err });
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
  o: { MODEL: boolean; DRY_RUN: boolean; LIMIT: number; RETRY_FAILED: boolean; SWITCH_KEY: boolean; env: Record<string, string | undefined>; url: string; signal?: AbortSignal; onPass?: (stop: PassStop) => void; out: Writer["out"]; err: Writer["err"] },
): Promise<number> {
  const { MODEL, DRY_RUN, LIMIT, RETRY_FAILED, SWITCH_KEY, env, out, err } = o;
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
      err(`\n  ${blanket} Or run --subjects rules, which asks no model, from a pool of its own (with --switch-key while another is named).`);
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
           has_table_privilege('thought_work_claims', 'SELECT') AND has_table_privilege('thought_work_claims', 'INSERT')
       AND has_table_privilege('thought_work_claims', 'UPDATE')
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
  // question's, or a model's found with its reasoning off when the question is asked with it on, or one the ticket the
  // thought is filed under disagrees with — a metadata rule's whose ticket moved or went, or another way's on a thought
  // filed since — which the fingerprint, the text's alone, does not see (review pass 4: a ticket moved before 113, or
  // under another pool, was never pooled at a naming). `after`, a page's cursor, bounds the facets read too, so a dry
  // run's pages each read from their cursor, not from the first facet (review pass 5: its pages read every facet before
  // them, a dry run before a naming quadratic in the thoughts).
  const noCurrentSubject = (c: SQL, after = NIL_ID) => c`
    NOT EXISTS (
      SELECT 1 FROM thought_facets f JOIN derivations d ON d.artifact_kind = 'subject' AND d.artifact_id = f.id
       WHERE f.thought_id = t.id AND f.thought_id >= ${after}::uuid AND f.kind = 'subject' AND f.valid_until IS NULL
         AND d.input_fingerprints[1] = COALESCE(t.content_fingerprint, content_fingerprint_of(t.content))
         AND ${currentSubjectSql(c, reasoningOn)}
         AND (CASE WHEN f.payload->>'by' = 'metadata' THEN f.payload->>'key' = 'ticket:' || ${filedTicketSql(c)}
                   ELSE ${filedTicketSql(c)} IS NULL END) IS TRUE)`;
  const NO_CURRENT_SUBJECT = noCurrentSubject(sql);
  /** A thought's columns for the sweep, its standing subject beside it (`t` and `s`). */
  const CANDIDATE = sql`t.id, t.content, t.created_at, t.metadata, COALESCE(t.content_fingerprint, content_fingerprint_of(t.content)) AS fingerprint,
           s.id::text AS standing_id, s.payload->>'key' AS standing_key, s.payload->>'by' AS standing_by, s.payload->>'judge_key' AS standing_judge,
           NOT ${NO_CURRENT_SUBJECT} AS current`;

  // The pool's name, its naming and its pooling, one run at a time: a run takes the pool's lock, a session advisory lock
  // on a connection of its own, before it reads the name, so two runs at a key's change do not both pool, the second
  // requeueing what the first had claimed or finished (review pass 1). A dry run takes none. Each statement here runs
  // on that connection, which a caller's client of one connection lends whole.
  let named: string | null = null, filled: string | null = null, newPool = false;
  const pin = DRY_RUN ? null : await sql.reserve();
  const db: SQL = pin ?? sql;
  try {
    if (pin) {
      // Said when another run holds it, naming and pooling (review pass 2: the run waited without a word).
      const [{ got }] = (await pin`SELECT pg_try_advisory_lock(hashtextextended('ob1:subject-pool', 0)) AS got`) as { got: boolean }[];
      if (!got) {
        out("  waiting for another run holding the subject pool's lock (reading its name, or naming and pooling it)");
        await pin`SELECT pg_advisory_lock(hashtextextended('ob1:subject-pool', 0))`;
      }
    }
    // The pool: the one ob1_config.subject_pool_key names, into which 113's trigger puts new and edited thoughts, and
    // subject_pool_filled, the one whose pooling last finished. A sweep under another key names its own, with --switch-key
    // once another is named, and pools every thought with no current subject — requeued, since a pool used before keeps
    // its finished claims and a thought edited since must be asked again — once, at the change.
    try {
      const keys = (await db`SELECT key, value FROM ob1_config WHERE key IN ('subject_pool_key', 'subject_pool_filled')`) as { key: string; value: string }[];
      named = keys.find((k) => k.key === "subject_pool_key")?.value || null;
      filled = keys.find((k) => k.key === "subject_pool_filled")?.value || null;
    } catch (e) {
      if (sqlState(e) !== "42501") throw e;
      err(`\n  This role cannot read the subject pool's name (${(e as Error).message}): the sweep reads ob1_config, thoughts, thought_facets and derivations.`);
      return 2;
    }
    newPool = named !== POOL || filled !== POOL;
    const unnamed = named === null ? "none was named" : `${named} was`;
    // Another pool named: a run under this key would move the trigger's thoughts to it and pool every thought with no
    // current subject again, and a run under the other after it would pool them all again — asked for, as the pass's own
    // key change is (review pass 1: a rules run, or a trial with OB1_SUBJECT_REASONING off, renamed the pool unasked).
    if (named !== null && named !== POOL && !SWITCH_KEY) {
      const why = `the subject pool is ${named}; this run's is ${POOL} (another rule, question or reasoning, or --subjects rules)`;
      if (!DRY_RUN) {
        err(`\n  Refusing to sweep under a pool other than the one ob1_config names without --switch-key: ${why}.\n` +
          `  A run under it would name it, so new and edited thoughts join it, and pool every thought with no current subject\n` +
          `  again, those the model named nothing for among them, as a run under ${named} after it would. If that is the\n` +
          `  intent, pass --switch-key; if OB1_SUBJECT_REASONING or --subjects rules is simply set otherwise here, fix that instead.`);
        return 2;
      }
      wouldRefuse.push(`${why}, and it needs --switch-key`);
    }
    // The first pool named: 113's trigger writes a work claim as the role that captures or edits, so a login role that
    // can fire it — INSERT on thoughts, or UPDATE of their content or metadata — but cannot make that claim would fail
    // its every capture (review pass 1). requeue_thought_work's upsert reads the conflict and sets seven columns: SELECT,
    // INSERT and UPDATE on the table (review pass 2: INSERT and UPDATE alone failed too). Once a pool is named,
    // preflight holds a capturing role to them. A role that cannot read ob1_config is not asked about: 016's trigger
    // already refuses its every capture and text edit, and 113's its ticket edits, pool or no (review pass 4: the
    // enrichment recipe's role, SELECT and UPDATE on thoughts alone, was refused for a failure it already has). Read by
    // column, the two the triggers read, so a role granted those alone is asked about too (review pass 5). Nor is a
    // role reached only through SET ROLE.
    if (named === null) {
      const [{ failing }] = (await db`
        SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) AS failing
          FROM pg_roles r
         WHERE r.rolcanlogin AND has_column_privilege(r.oid, 'ob1_config', 'key', 'SELECT') AND has_column_privilege(r.oid, 'ob1_config', 'value', 'SELECT')
           AND (has_any_column_privilege(r.oid, 'thoughts', 'INSERT')
                OR has_column_privilege(r.oid, 'thoughts', 'content', 'UPDATE') OR has_column_privilege(r.oid, 'thoughts', 'metadata', 'UPDATE'))
           AND NOT (has_table_privilege(r.oid, 'thought_work_claims', 'SELECT') AND has_table_privilege(r.oid, 'thought_work_claims', 'INSERT')
                    AND has_table_privilege(r.oid, 'thought_work_claims', 'UPDATE'))`) as { failing: string | null }[];
      if (failing !== null) {
        const line = `naming the pool would fail the captures of ${failing}: 113's trigger writes a work claim as the role that captures, and they cannot SELECT, INSERT and UPDATE thought_work_claims`;
        if (!DRY_RUN) {
          err(`\n  Refusing to name a subject pool: ${line}. Grant them that (GRANT SELECT, INSERT, UPDATE ON thought_work_claims TO <role>, or the worker group: cd db && bun migrate.ts --url … --grant <role> --groups worker), then run again.`);
          return 2;
        }
        wouldRefuse.push(line);
      }
    }
    if (newPool && DRY_RUN) {
      const [{ n }] = (await db`SELECT count(*)::int AS n FROM thoughts t WHERE ${noCurrentSubject(db)}`) as { n: number }[];
      out(named === POOL
        ? `  pool ${POOL}: named, its pooling unfinished: a run pools the ${n} thought(s) with no current subject`
        : `  pool ${POOL}: not named (${unnamed}): a run names it and pools the ${n} thought(s) with no current subject`);
    } else if (newPool) {
      // Named first, its pooling marked unfinished, so a thought captured from here on joins it by the trigger; then the
      // thoughts with no current subject, each requeued (MATERIALIZED: every row's call is made, whatever the count reads
      // of it); then the pooling marked finished, so one that broke off is pooled again by the next run (review pass 1:
      // the pool stood named and its backlog was never pooled).
      await db`INSERT INTO ob1_config (key, value) VALUES ('subject_pool_key', ${POOL}), ('subject_pool_filled', '')
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
      // A capture whose transaction was open as the pool was named read no pool, or the one before, and the pooling
      // cannot see it until it commits: each transaction holding a write lock on thoughts in this database as the pool
      // was named is waited for first, by its virtual transaction id, at most WRITERS_WAIT (review pass 5: such a capture
      // was never pooled). A statement takes its table lock before its snapshot, so one that takes it after this read
      // sees the pool named; the xids pg_snapshot_xip lists missed a capture whose xid followed the naming's, and counted
      // writers of any table in any database (review pass 6, run-it). Past the wait the pooling is left unfinished, and
      // the next run pools again (review pass 6: it was marked finished, and they were never pooled). A capture under
      // REPEATABLE READ, whose snapshot can predate the naming, is not waited for: preflight refuses that level for the
      // writers (068).
      const [{ vxids }] = (await db`
        SELECT COALESCE(array_agg(DISTINCT virtualtransaction), '{}')::text[] AS vxids FROM pg_locks
         WHERE locktype = 'relation' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
           AND relation = 'thoughts'::regclass AND mode = 'RowExclusiveLock' AND pid IS DISTINCT FROM pg_backend_pid()`) as { vxids: string[] }[];
      let told = false, gaveUp = false;
      for (const since = Date.now(); vxids.length > 0;) {
        const [{ open }] = (await db`
          SELECT count(*)::int AS open FROM pg_locks WHERE locktype = 'virtualxid' AND virtualxid = ANY(${`{${vxids.join(",")}}`}::text[])`) as { open: number }[];
        if (open === 0) break;
        if (Date.now() - since >= WRITERS_WAIT.ms) {
          out(`  ${open} transaction(s) writing thoughts as the pool was named still are after ${WRITERS_WAIT.ms / 1000} s: its pooling is left unfinished, and the next run pools again`);
          gaveUp = true;
          break;
        }
        if (!told) out(`  waiting for ${open} transaction(s) writing thoughts as the pool was named, so the pooling sees what they capture`);
        told = true;
        await Bun.sleep(100);
      }
      let pooled = -1;
      for (let attempt = 1; pooled < 0; attempt++) {
        try {
          // A thought whose claim under the key a live run holds is left to it, its lease running (review pass 5: the
          // pooling set it pending, and another run asked the same text again while the first still had it).
          [{ n: pooled }] = (await db`
            WITH pooled AS MATERIALIZED (
              SELECT requeue_thought_work(${POOL}, t.id) FROM thoughts t
               WHERE ${noCurrentSubject(db)}
                 AND NOT EXISTS (SELECT 1 FROM thought_work_claims c
                                  WHERE c.thought_id = t.id AND c.work_type = ${POOL} AND c.status = 'claimed' AND c.ttl_expires_at >= now()))
            SELECT count(*)::int AS n FROM pooled`) as { n: number }[];
        } catch (e) {
          // A thought deleted under the pooling fails its claim's key (23503), and a deadlock is the server's to break:
          // each pooled again, three times at most. Anything else ends the run, the pool named and its pooling unfinished.
          const state = sqlState(e);
          if ((state === "23503" || state === "40P01") && attempt < 3) continue;
          if (databaseUnavailable(e)) throw e;
          if (state === "42501") {
            err(`\n  This role cannot pool the thoughts (${String((e as Error)?.message ?? e).slice(0, 300)}): the pool needs ${POOL_GRANTS}. Pool ${POOL} is named, and a run as a role that holds them pools them.`);
            return 2;
          }
          err(`\n  Pooling the thoughts with no current subject broke off (${String((e as Error)?.message ?? e).slice(0, 300)}): pool ${POOL} is named, and the next run pools them; run it again.`);
          return 1;
        }
      }
      if (!gaveUp) {
        await db`INSERT INTO ob1_config (key, value) VALUES ('subject_pool_filled', ${POOL})
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
      }
      out(named === POOL
        ? `  pool ${POOL}: named, its pooling broken off before: the ${pooled} thought(s) with no current subject pooled now`
        : `  pool ${POOL}: named (${unnamed}), and the ${pooled} thought(s) with no current subject pooled; new and edited thoughts join it from here on`);
    }
  } finally {
    if (pin) {
      await pin`SELECT pg_advisory_unlock(hashtextextended('ob1:subject-pool', 0))`.catch(() => {});
      pin.release();
    }
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
  // Each count by the index on (work_type, status): the pool's rows still to do, not its history. A lease run out
  // under its attempts is a gone worker's, which a run's claim takes again (claim_thoughts' reaping): counted with what
  // is still to do (review pass 1: a run took one its pool line and progress had not counted, "1/0").
  const [pool] = (await sql`
    SELECT (SELECT count(*) FROM thought_work_claims WHERE work_type = ${POOL} AND status = 'pending')::int AS pending,
           (SELECT count(*) FROM thought_work_claims WHERE work_type = ${POOL} AND status = 'claimed')::int AS claimed,
           (SELECT count(*) FROM thought_work_claims WHERE work_type = ${POOL} AND status = 'claimed' AND ttl_expires_at < now() AND attempt_count < ${MAX_ATTEMPTS})::int AS expired,
           (SELECT count(*) FROM thought_work_claims WHERE work_type = ${POOL} AND status = 'claimed' AND ttl_expires_at < now() AND attempt_count >= ${MAX_ATTEMPTS})::int AS spent,
           (SELECT count(*) FROM thought_work_claims WHERE work_type = ${POOL} AND status = 'failed')::int AS failed`) as { pending: number; claimed: number; expired: number; spent: number; failed: number }[];
  if (!(newPool && DRY_RUN && named !== POOL)) {
    // A lease run out at its last attempt is failed by the next claim's reaping: said here, and by a run that claims
    // (review pass 2: the run failed it without a word, and exited 0).
    const runOut = [pool.expired ? `${pool.expired} run out, taken again` : "", pool.spent ? `${pool.spent} run out at their last attempt, failed by the next claim` : ""].filter(Boolean).join("; ");
    out(`  pool ${POOL}: ${pool.pending} pending${pool.claimed ? `, ${pool.claimed} leased${runOut ? ` (${runOut})` : ""}` : ""}${pool.failed ? `, ${pool.failed} failed${RETRY_FAILED ? "" : " (--retry-failed asks them again)"}` : ""}${LIMIT ? `; this run takes at most ${LIMIT}` : ""}`);
  }

  /**
   * `seen`: the claims taken and finished, each in one of the buckets after it, so the summary's counts add up to it
   * (review pass 2: a thought the sweep ended at was counted and in none); a thought edited mid-sweep is taken twice,
   * edited and then its outcome, as --limit counts it. `taken`, for --limit, counts that one too.
   * `replaced` and `newKey` count within the recorded ones, `closed` within those the model named nothing for,
   * `leftOutOfDate` within the rest, and `lost`, the claims no longer this worker's when it released them, across them
   * all: no bucket of their own.
   */
  const n = { seen: 0, current: 0, metadata: 0, first_line: 0, model: 0, replaced: 0, newKey: 0, kept: 0, named: 0, closed: 0, unread: 0, unanswered: 0, left: 0, leftOutOfDate: 0, stale: 0, rewritten: 0, gone: 0, refusedKey: 0, egress: 0, lost: 0, lostFailed: 0 };
  let taken = 0;
  /**
   * The server's clock as the run first claims, null while it has not: its claims reap the pool's run-out leases, those
   * at their last attempt failed, so one failed since then failed while it claimed.
   */
  let claimedSince: string | null = null;
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

  const workerId = `subjects-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const TTL_S = Math.ceil(cfg.timeoutMs / 1000) + LEASE_MARGIN_S;

  // The stop, as the pass's (db/lease.ts's PassStop): the first after the thought in hand; the second the call in hand
  // too, returning the release of the claim in hand, which the CLI exits on (review pass 1: it returned at once, and
  // the CLI exited with the claim leased for its whole lease). A dry run writes nothing and asks nothing, and reads
  // on, as the pass's does.
  const stop = new AbortController();
  const hardStop = new AbortController();
  let ended = false;
  let hardRelease: Promise<unknown> | null = null;
  const passStop: PassStop = () => {
    if (ended) return null;
    if (!stop.signal.aborted) {
      stop.abort();
      return null;
    }
    hardStop.abort();
    hardRelease ??= sql`SELECT release_claims_for_worker(${POOL}, ${workerId})`.catch(() => null);
    return hardRelease;
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
          // The next call can run to the limit again: its lease is moved on for it (031's renew_claims), so a claim
          // asked again is not reaped and asked by another sweep meanwhile (review pass 1: four calls outran it).
          await sql`SELECT 1 FROM renew_claims(${POOL}, ${workerId}, ${TTL_S})`.catch(() => {});
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
    // Current — the extraction pass gave it a current subject after it was pooled — finished, unasked: so long as the
    // rules agree now. A ticket it is filed under since a model keyed it, or another ticket than the one a rule
    // read, or none where one was, is read again (review pass 2: 113's trigger pooled it, and it was finished as
    // current, its fingerprint the text's alone).
    const found = ruleSubject(row);
    const rulesAgree = row.standing_by === "model" ? found === null : found !== null && found.key === row.standing_key && found.by === row.standing_by;
    if (row.current && rulesAgree) {
      n.current++;
      return { release: "succeeded" };
    }
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
        // Not answering: the thought goes back to the end of the pool, so a thought the provider fails on whenever it
        // is asked does not come first again and end every run (review pass 1). Its claim is handed back as the run ends.
        if (kind !== "fatal") await sql`UPDATE thought_work_claims SET enqueued_at = now() WHERE thought_id = ${row.id}::uuid AND work_type = ${POOL} AND worker_id = ${workerId} AND status = 'claimed'`.catch(() => {});
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
        // changes; an out-of-date subject standing on it closes, if it is still the one read at the text read. Counted
        // once the close has answered: a text moved since is edited mid-sweep, a thought deleted is gone, and past the
        // hard stop nothing is closed nor finished (review pass 1: each was counted as named nothing). A subject written
        // since the read, by another pass or another key's run, is one the answer said nothing of: the thought goes
        // back in the pool and the run reads what stands when it comes up (review pass 6: across a switch to another
        // question and back, a subject the other key's run wrote stood out of date, its claim finished here).
        if (hardStop.signal.aborted) return false;
        let written = false;
        if (row.standing_id !== null) {
          let c: { action: string; stale?: boolean; gone?: boolean; moved?: boolean };
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
          // The text moved since it was read: the pool's trigger has it again, at its new text.
          if (c.stale) {
            n.stale++;
            return { release: "none" };
          }
          if (c.gone) {
            n.gone++;
            return { release: "none" };
          }
          if (c.moved) written = true;
          else if (c.action === "closed") n.closed++;
        }
        try {
          if (row.standing_id === null) {
            [{ written }] = (await sql`
              SELECT EXISTS (SELECT 1 FROM thought_facets WHERE thought_id = ${row.id}::uuid AND kind = 'subject' AND valid_until IS NULL) AS written`) as { written: boolean }[];
          }
          if (written) await sql`SELECT requeue_thought_work(${POOL}, ${row.id}::uuid)`;
        } catch (e) {
          if (!databaseUnavailable(e)) throw e;
          endedBy = { code: 1, line: databaseDown(e) };
          return false;
        }
        if (written) {
          n.rewritten++;
          return { release: "none" };
        }
        n.named++;
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
      // The text, or since 113's door the ticket the thought is filed under, moved mid-sweep (review passes 4 and 5): the
      // pool's trigger has the thought again, so its claim is not this worker's to finish, and this run takes it again
      // when it comes up.
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
  const todo = LIMIT ? Math.min(LIMIT, pool.pending + pool.expired) : pool.pending + pool.expired;
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
  try {
    if (DRY_RUN) {
      // The thoughts a run would take: every one with no current subject when the pool is not named yet or its
      // pooling broke off, else the pool's pending claims, its failed ones under --retry-failed and a gone worker's
      // run-out leases under their attempts, a page at a time by thought id (review pass 1: by when each was pooled, a
      // key's whole pooling one instant, each page sorted every claim tied with it; and a Date's milliseconds had paged
      // it without end).
      let afterId = NIL_ID;
      pages: for (;;) {
        let rows: Candidate[];
        try {
          rows = (newPool
            ? await sql`
                SELECT ${CANDIDATE} FROM thoughts t
                  LEFT JOIN thought_facets s ON s.thought_id = t.id AND s.kind = 'subject' AND s.valid_until IS NULL
                 WHERE t.id > ${afterId}::uuid AND ${noCurrentSubject(sql, afterId)}
                 ORDER BY t.id LIMIT ${PAGE}`
            : await sql`
                SELECT ${CANDIDATE} FROM thought_work_claims c JOIN thoughts t ON t.id = c.thought_id
                  LEFT JOIN thought_facets s ON s.thought_id = t.id AND s.kind = 'subject' AND s.valid_until IS NULL
                 WHERE c.work_type = ${POOL} AND c.thought_id > ${afterId}::uuid
                   AND (c.status = 'pending' OR (${RETRY_FAILED}::boolean AND c.status = 'failed')
                        OR (c.status = 'claimed' AND c.ttl_expires_at < now() AND c.attempt_count < ${MAX_ATTEMPTS}))
                 ORDER BY c.thought_id LIMIT ${PAGE}`) as Candidate[];
        } catch (e) {
          if (!databaseUnavailable(e)) throw e;
          endedBy = { code: 1, line: databaseDown(e) };
          break;
        }
        if (rows.length === 0) break;
        for (const row of rows) {
          afterId = row.id;
          if (LIMIT && taken >= LIMIT) break pages;
          taken++;
          await one(row);
          n.seen++;
        }
      }
    } else {
      for (;;) {
        if (stop.signal.aborted || (LIMIT && taken >= LIMIT)) break;
        let got: { thought_id: string }[];
        try {
          if (claimedSince === null) claimedSince = ((await sql`SELECT clock_timestamp()::text AS at`)[0] as { at: string }).at;
          got = (await sql`SELECT thought_id FROM claim_thoughts(${POOL}, ${workerId}, 1, ${TTL_S}, ${MAX_ATTEMPTS})`) as { thought_id: string }[];
        } catch (e) {
          if (!databaseUnavailable(e)) throw e;
          endedBy = { code: 1, line: databaseDown(e) };
          break;
        }
        if (got.length === 0) break;
        taken++;
        const id = got[0].thought_id;
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
        // Counted before its release, so a database lost there leaves the counts adding up (review pass 1); past the
        // hard stop the claim is the stop's release's, not this worker's to finish (review pass 2: counted in its
        // bucket and not seen).
        n.seen++;
        if (hardStop.signal.aborted) break;
        if (done.release !== "none") {
          try {
            // False: no longer this worker's — an edit put it back in the pool (the trigger), at its new text, or its
            // lease ran out and another run took it — counted and said (review pass 1: nothing said so).
            const [{ ok }] = (await sql`SELECT release_thought(${id}::uuid, ${POOL}, ${workerId}, ${done.release}, ${done.release === "failed" ? done.error : null}) AS ok`) as { ok: boolean }[];
            if (!ok) {
              n.lost++;
              if (done.release === "failed") n.lostFailed++;
            }
          } catch (e) {
            if (!databaseUnavailable(e)) throw e;
            endedBy = { code: 1, line: databaseDown(e) };
            break;
          }
        }
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
  const rest = clauses([[n.current, "already current"], [n.kept, "kept, at the text read now"], [n.named, `the model named nothing for${n.closed ? ` (${n.closed} out-of-date subject(s) closed)` : ""}`], [n.left, "left for the judge model (--subjects rules)"], [n.unread, "answered not as JSON of the expected shape"], [n.unanswered, "unanswered"], [n.stale, "edited mid-sweep"], [n.rewritten, "read again, a subject written meanwhile"], [n.gone, "deleted mid-sweep"], [n.egress, "refused by the egress gate"], [n.refusedKey, "keys refused"]]);
  const outOfDate = n.leftOutOfDate ? ` — among them, ${n.leftOutOfDate} with an out-of-date subject still standing` : "";
  const lost = n.lost ? `; ${n.lost} claim(s) no longer this run's when released (the thought edited, deleted or pooled again, its lease run out and taken by another run, or handed back by hand)` : "";
  out(`\n  ${n.seen} thought(s) in ${elapsed}s${calls ? ` (${(llmMs / 1000).toFixed(1)}s in ${calls} model call(s))` : ""}: ${recorded} subject(s) recorded${by ? ` (${by})` : ""}${n.replaced ? `, ${n.replaced} in place of a standing one (${n.newKey} with a new key)` : ""}${rest ? `; ${rest}${outOfDate}` : ""}${lost}`);
  if (endedBy) {
    err(endedBy.line);
    return endedBy.code;
  }
  if (stop.signal.aborted) {
    err(`\n  stopped after ${n.seen} thought(s): what it held is back in the pool, and the next sweep takes up the rest`);
    return 130;
  }
  // A failed claim no longer this run's when released is the pool's again, or gone: no failure for --retry-failed. A
  // lease run out at its last attempt and failed while this run claimed — by its claims' reaping, or a run's beside it —
  // is one, counted over the run's own window, not from the start's count (review pass 4: one spent mid-run went
  // unsaid, exit 0).
  let spent = 0;
  if (claimedSince !== null) {
    try {
      [{ spent }] = (await sql`
        SELECT count(*)::int AS spent FROM thought_work_claims
         WHERE work_type = ${POOL} AND status = 'failed' AND finished_at >= ${claimedSince}::timestamptz AND last_error LIKE 'lease expired %'`) as { spent: number }[];
    } catch (e) {
      // The database lost here leaves the count unknown: said as the run's end, not read as none (review pass 5: exit 0).
      if (!databaseUnavailable(e)) throw e;
      err(databaseDown(e));
      return 1;
    }
  }
  if (spent) err(`\n  ${spent} claim(s) whose lease ran out at its last attempt failed while this run claimed: a worker held each ${MAX_ATTEMPTS} times and did not finish it`);
  const failedNow = n.unanswered + n.unread + n.egress + n.refusedKey - n.lostFailed + spent;
  if (failedNow > 0) err(`\n  ${failedNow} claim(s) failed: fix the cause and run again with --retry-failed`);
  return failedNow > 0 ? 1 : 0;
}
