/**
 * subject-sweep.ts — the extraction worker's `--subjects` sweep (SMD-3306): each thought with no standing subject at
 * its current text is given its own subject, the rules' or, for the rest, the judge model's
 * (server-portable/subject.ts), through migration 110's record_thought_subject.
 *
 *   bun db/extract-entities.ts --url … --subjects                # the rules, then the judge model for the rest
 *   bun db/extract-entities.ts --url … --subjects rules          # the rules alone: no model call
 *   bun db/extract-entities.ts --url … --subjects --dry-run      # how many each would find; writes and asks nothing
 *   bun db/extract-entities.ts --url … --subjects --limit 50     # at most this many thoughts
 *   --timeout SECONDS (300, per model call)
 *   exits 0 clean · 1 thoughts unanswered, unread or refused, or the provider or the database stopped answering ·
 *   2 usage, configuration, a role without the door's grants or the provider's refusal · 130 a signal
 *
 * The extraction pass records the rules' subject with each thought's entities (extract-entities.ts's processRow), so
 * a thought filed under a ticket, or naming one on its first line, has its subject once it is extracted. This sweep
 * is the rest: thoughts extracted before 110, those the rules leave to the model, and those whose text moved since
 * their subject was found. It is also the one-time backfill. It takes one thought at a time, without a lease:
 * record_thought_subject locks the thought and checks the text's fingerprint, so two sweeps, or a sweep beside the
 * pass, write each text's subject once, and a later write keeps or replaces an earlier one. `--subjects rules`
 * stops at the rules, for a brain whose judge model has not been measured on the question.
 *
 * A ticket-shaped word counts as a ticket under a prefix the brain files its tickets under (ticketPrefixes, read once
 * a run), so `UTF-8` on a first line leaves the thought to the model. A model answer naming nothing records nothing,
 * so the next sweep asks again; so do an answer that is not JSON with a subject, a timeout or the provider refusing
 * the thought's length, and a row the egress gate refuses, each counted. A rate limit, a server error or a lost
 * connection is paused for and retried (TRANSIENT_PAUSES_MS), then ends the sweep; any other refusal of the request
 * ends it, exit 2, as it ends the pass. A dry run reads on through a signal, as the pass's does: it writes nothing.
 */

import type { SQL } from "bun";
import { ProviderError, resolveEmbedConfig, type EmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { localKnob, ROW_UNITS } from "../server-portable/egress.ts";
import { actorKindOf } from "../server-portable/consolidate.ts";
import { askOwnSubject, ruleSubject, SUBJECT_RULES_KEY, subjectModelKey, type SubjectBy, type TicketPrefixes } from "../server-portable/subject.ts";
import { subjectRecipe, type Recipe } from "../server-portable/lineage.ts";
import { blanketGate, classifyError, databaseUnavailable, egressDescription, egressRefusal, MAX_CALL_TIMEOUT_S, regateMessage, TRANSIENT_PAUSES_MS, workerIdentity } from "./worker-bootstrap.ts";
import { sleepUnless, STOPPED_EARLY, type PassStop } from "./lease.ts";
import { consoleWriter, numberProblem, type Writer } from "./cli.ts";
import { databaseUrlProblem, NO_DATABASE_URL, openSql } from "./connect.ts";

/** 110's door, by its signature: the sweep's one write. */
const DOOR = "record_thought_subject(uuid, text, text, text, uuid, text, jsonb)";

/** What the door needs of the role that calls it (110's comment), and where each grant comes from. */
const DOOR_GRANTS = "INSERT and UPDATE on thought_facets (INSERT is the structure group's), UPDATE on thoughts (its row lock), and INSERT and UPDATE on derivations (the capture group's)";

/** What record_thought_subject answers. */
export type SubjectWrite = { ok: boolean; action: "added" | "kept" | "replaced" | "closed" | "none"; id?: string; stale?: boolean; gone?: boolean };

/** One thought's subject through 110's door, at the fingerprint of the text it was found in. */
export async function recordSubject(sql: SQL, row: { id: string; fingerprint: string }, key: string, by: SubjectBy, judgeKey: string, recipe: Recipe, agentId: string | null): Promise<SubjectWrite> {
  const [r] = await sql`SELECT record_thought_subject(${row.id}::uuid, ${key}, ${by}, ${judgeKey}, ${agentId}::uuid, ${row.fingerprint}, ${recipe}::jsonb) AS r`;
  return r.r as SubjectWrite;
}

/**
 * The prefixes the brain files its tickets under: every issue key 068's ob1_ticket_head holds, by its letters
 * (subject.ts's TicketPrefixes). Empty when the brain files none, or the table cannot be read: a ticket-shaped word
 * then counts as a ticket unless it is one of NOT_TICKET_PREFIXES.
 */
export async function ticketPrefixes(sql: SQL): Promise<Set<string>> {
  try {
    const rows = (await sql`SELECT DISTINCT substring(issue from '^([A-Z][A-Z0-9]+)-[0-9]+$') AS p FROM ob1_ticket_head WHERE issue ~ '^[A-Z][A-Z0-9]+-[0-9]+$'`) as { p: string }[];
    return new Set(rows.map((r) => r.p));
  } catch {
    return new Set();
  }
}

/** A database error's SQLSTATE. */
const sqlState = (e: unknown): string | undefined => {
  const { errno, code } = (e ?? {}) as { errno?: unknown; code?: unknown };
  return typeof errno === "string" ? errno : typeof code === "string" ? code : undefined;
};

/**
 * What one sweep is asked: `model` false for the rules alone; `limit` 0 for no limit; `timeout` in seconds, per model
 * call (300 left out). `sql` is the caller's client in place of `url`, never closed here; `env` what the run reads,
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
  dryRun?: boolean;
  writer?: Writer;
  signal?: AbortSignal;
  onPass?: (stop: PassStop) => void;
}

/** The thoughts with no standing subject at their current text, a page at a time in id order. */
const PAGE = 100;

type Candidate = { id: string; content: string; created_at: string | Date | null; metadata: Record<string, unknown> | null; fingerprint: string };

/** The sweep, callable: the code the CLI exits with (the header's list). */
export async function sweepSubjects(opts: SubjectSweepOptions): Promise<number> {
  const { out, err } = opts.writer ?? consoleWriter;
  const env = opts.env ?? process.env;
  const MODEL = opts.model !== false;
  const DRY_RUN = opts.dryRun === true;
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
  const TIMEOUT_S = opts.timeout ?? 300;
  if (opts.sql != null && noUrl && env.OB1_WORKER_KEY && !DRY_RUN) {
    // The pass's rule (extract-entities.ts's run): the key resolves on a connection of its own.
    err("extract-entities.ts --subjects resolves OB1_WORKER_KEY on a connection of its own (db/worker-bootstrap.ts): pass url beside sql, or run without the key.");
    return 2;
  }
  if (opts.signal?.aborted && !DRY_RUN) {
    err(STOPPED_EARLY);
    return 130;
  }
  const cfg: EmbedConfig = { ...resolveEmbedConfig(env as EmbedEnv), timeoutMs: TIMEOUT_S * 1000 };
  const sql = opts.sql ?? openSql(opts.url as string, { max: 2 });
  try {
    return await sweep(sql, cfg, { MODEL, DRY_RUN, LIMIT, env, url: opts.url ?? "", signal: opts.signal, onPass: opts.onPass, out, err });
  } finally {
    if (opts.sql == null) await sql.close().catch(() => {});
  }
}

async function sweep(
  sql: SQL,
  cfg: EmbedConfig,
  o: { MODEL: boolean; DRY_RUN: boolean; LIMIT: number; env: Record<string, string | undefined>; url: string; signal?: AbortSignal; onPass?: (stop: PassStop) => void; out: Writer["out"]; err: Writer["err"] },
): Promise<number> {
  const { MODEL, DRY_RUN, LIMIT, env, out, err } = o;
  const judgeKey = subjectModelKey(cfg.judgeModel);
  out(`  subjects: the rules (${SUBJECT_RULES_KEY})${MODEL ? `, then ${cfg.judgeModel} via ${cfg.chat.base}, temperature ${cfg.metadataTemperature} (${judgeKey})` : ", no model (--subjects rules)"}`);
  if (MODEL) {
    out(`  egress: ${egressDescription(cfg.chat, cfg.egress, localKnob(cfg, "chat"))}`);
    // A policy that refuses whatever the row: stop before the first call, as the pass does (SMD-1903).
    const blanket = blanketGate({ endpoint: cfg.chat, policy: cfg.egress, units: env.OB1_WORKER_KEY ? undefined : ROW_UNITS, verb: "asked for its subject", localKnobKey: localKnob(cfg, "chat") });
    if (blanket && !DRY_RUN) {
      err(`\n  ${blanket} Or run --subjects rules, which asks no model.`);
      return 2;
    }
  }
  const [{ door }] = (await sql`SELECT to_regprocedure(${DOOR}) IS NOT NULL AS door`) as { door: boolean }[];
  if (!door) {
    err("\n  record_thought_subject is missing: a thought's own subject is migration 110's. Apply it first:\n    cd db && bun migrate.ts --url …");
    return 2;
  }
  if (!DRY_RUN) {
    // The door's grants, asked before any model call: a role that cannot write a subject is refused here, not at its
    // first write with a question already spent (review pass 1).
    const [{ can }] = (await sql`
      SELECT has_any_column_privilege('thought_facets', 'INSERT') AND has_any_column_privilege('thought_facets', 'UPDATE')
         AND has_any_column_privilege('thoughts', 'UPDATE')
         AND has_any_column_privilege('derivations', 'INSERT') AND has_any_column_privilege('derivations', 'UPDATE') AS can`) as { can: boolean }[];
    if (!can) {
      err(`\n  This role cannot write a thought's subject: record_thought_subject needs ${DOOR_GRANTS}. Grant them, or run the sweep as a role that holds them.`);
      return 2;
    }
  }

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

  const NO_SUBJECT_AT_TEXT = sql`
    NOT EXISTS (
      SELECT 1 FROM thought_facets f JOIN derivations d ON d.artifact_kind = 'subject' AND d.artifact_id = f.id
       WHERE f.thought_id = t.id AND f.kind = 'subject' AND f.valid_until IS NULL
         AND d.input_fingerprints[1] = COALESCE(t.content_fingerprint, content_fingerprint_of(t.content)))`;
  let total: number;
  try {
    total = Number(((await sql`SELECT count(*)::int AS n FROM thoughts t WHERE ${NO_SUBJECT_AT_TEXT}`) as { n: number }[])[0].n);
  } catch (e) {
    if (sqlState(e) !== "42501") throw e;
    err(`\n  This role cannot read the thoughts' subjects (${(e as Error).message}): the sweep reads thoughts, thought_facets and derivations.`);
    return 2;
  }
  const todo = LIMIT ? Math.min(LIMIT, total) : total;
  out(`  ${total} thought(s) with no subject at their text${LIMIT ? `; this run takes at most ${LIMIT}` : ""}`);
  const known: TicketPrefixes = await ticketPrefixes(sql);

  const n = { seen: 0, metadata: 0, first_line: 0, model: 0, kept: 0, named: 0, unread: 0, unanswered: 0, left: 0, stale: 0, gone: 0, refusedKey: 0, egress: 0 };
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
        const a = await askOwnSubject(cfg, side, subject, hardStop.signal, known);
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
        if (kind === "thought") return { unanswered: (e as Error).message };
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

  /** One thought: the rules, else the model; what the door answered, counted. False ends the sweep. */
  async function one(row: Candidate): Promise<boolean> {
    const found = ruleSubject(row, known);
    let key: string, by: SubjectBy, judge: string, recipe: Recipe;
    if (found && DRY_RUN) {
      n[found.by]++;
      return true;
    }
    if (found) {
      ({ key, by } = found);
      judge = SUBJECT_RULES_KEY;
      recipe = subjectRecipe({ by: found.by });
    } else if (!MODEL || DRY_RUN) {
      n.left++;
      return true;
    } else {
      let a: Awaited<ReturnType<typeof ask>>;
      try {
        a = await ask(row);
      } catch (e) {
        if (hardStop.signal.aborted || stop.signal.aborted) return false;
        const kind = classifyError(e);
        endedBy = kind === "fatal"
          ? { code: 2, line: `\n  The provider refused the request itself: ${(e as Error).message.slice(0, 300)}\n  Check the chat endpoint (OB1_CHAT_BASE_URL and OB1_CHAT_API_KEY, or OB1_LLM_BASE_URL and OB1_LLM_API_KEY when those are unset) and OB1_JUDGE_MODEL against the provider. Nothing was recorded for this thought.` }
          : { code: 1, line: `\n  The provider is not answering after ${TRANSIENT_PAUSES_MS.length} pauses (${(e as Error).message.slice(0, 300)}): the sweep stops here; run it again.` };
        return false;
      }
      if ("egress" in a) {
        n.egress++;
        sayOnce("egress", `  ${row.id}: ${a.egress.slice(0, 300)}`);
        return true;
      }
      if ("unanswered" in a) {
        n.unanswered++;
        sayOnce("unanswered", `  ${row.id}: no answer (${a.unanswered.slice(0, 300)}); the next sweep asks again`);
        return true;
      }
      // Not JSON with a subject: the model's failure for this thought, as the pass reads a malformed answer.
      if (a.answer === null) {
        n.unread++;
        sayOnce("unread", `  ${row.id}: ${cfg.judgeModel}'s answer was not JSON of the expected shape; the next sweep asks again`);
        return true;
      }
      if (a.key === null) {
        n.named++;
        return true;
      }
      key = a.key;
      by = "model";
      judge = judgeKey;
      recipe = subjectRecipe({ by: "model", model: cfg.judgeModel, temperature: cfg.metadataTemperature, answer: a.answer });
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
        sayOnce("refusedKey", `  ${row.id}: record_thought_subject refused the key (${(e as Error).message.slice(0, 300)})`);
        return true;
      }
      if (state === "42501") {
        endedBy = { code: 2, line: `\n  This role cannot write a thought's subject (${(e as Error).message.slice(0, 300)}): record_thought_subject needs ${DOOR_GRANTS}.` };
        return false;
      }
      if (databaseUnavailable(e)) {
        endedBy = { code: 1, line: `\n  The database stopped answering (${(e as Error).message.slice(0, 300)}): the sweep stops here; run it again.` };
        return false;
      }
      throw e;
    }
    if (w.stale) n.stale++;
    else if (w.gone) n.gone++;
    else if (w.action === "kept") n.kept++;
    else if (w.action === "added" || w.action === "replaced") n[by]++;
    return true;
  }

  // The stop is handed out, and the caller's signal heard, while the pages are swept, then let go: a signal a caller
  // keeps holds no listener. A dry run hears neither.
  const detach = new AbortController();
  if (!DRY_RUN) {
    o.signal?.addEventListener("abort", () => passStop(), { once: true, signal: detach.signal });
    if (o.signal?.aborted) passStop();
    o.onPass?.(passStop);
  }
  let after = "00000000-0000-0000-0000-000000000000";
  try {
    pages: for (;;) {
      const rows = (await sql`
        SELECT t.id, t.content, t.created_at, t.metadata, COALESCE(t.content_fingerprint, content_fingerprint_of(t.content)) AS fingerprint
          FROM thoughts t
         WHERE t.id > ${after}::uuid AND ${NO_SUBJECT_AT_TEXT}
         ORDER BY t.id LIMIT ${PAGE}`) as Candidate[];
      if (rows.length === 0) break;
      for (const row of rows) {
        after = row.id;
        if (stop.signal.aborted || (LIMIT && n.seen >= LIMIT)) break pages;
        n.seen++;
        if (!(await one(row))) break pages;
        if (Date.now() - reported >= 10_000) {
          reported = Date.now();
          out(`  ${n.seen}/${todo}  ${n.metadata + n.first_line + n.model} recorded, ${n.named} named nothing${n.unanswered + n.unread ? `, ${n.unanswered + n.unread} unanswered or unread` : ""}`);
        }
      }
    }
  } finally {
    ended = true;
    detach.abort();
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const clauses = (parts: [number, string][]) => parts.filter(([k]) => k > 0).map(([k, s]) => `${k} ${s}`).join(", ");
  if (DRY_RUN) {
    out(`\n  would: of ${n.seen} thought(s), record ${clauses([[n.metadata, "by the ticket each is filed under"], [n.first_line, "by the ticket on its first line"]]) || "none by the rules"}; ` +
      (MODEL ? `ask ${cfg.judgeModel} about ${n.left}` : `leave ${n.left} for the judge model (--subjects without rules)`) + ". Nothing was written or asked.");
    return 0;
  }
  const recorded = n.metadata + n.first_line + n.model;
  const by = clauses([[n.metadata, "by the ticket filed under"], [n.first_line, "by the first line's ticket"], [n.model, `by ${cfg.judgeModel}`]]);
  const rest = clauses([[n.kept, "kept, at the text read now"], [n.named, "the model named nothing for"], [n.left, "left for the judge model (--subjects rules)"], [n.unread, "answered not as JSON of the expected shape"], [n.unanswered, "unanswered"], [n.stale, "edited mid-sweep"], [n.gone, "deleted mid-sweep"], [n.egress, "refused by the egress gate"], [n.refusedKey, "keys refused"]]);
  out(`\n  ${n.seen} thought(s) in ${elapsed}s${calls ? ` (${(llmMs / 1000).toFixed(1)}s in ${calls} model call(s))` : ""}: ${recorded} subject(s) recorded${by ? ` (${by})` : ""}${rest ? `; ${rest}` : ""}`);
  if (endedBy) {
    err(endedBy.line);
    return endedBy.code;
  }
  if (stop.signal.aborted) {
    err(`\n  stopped after ${n.seen} thought(s): the next sweep takes up the rest`);
    return 130;
  }
  return n.unanswered + n.unread + n.egress + n.refusedKey > 0 ? 1 : 0;
}
