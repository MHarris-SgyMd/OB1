#!/usr/bin/env bun
/**
 * threads.ts — links the work threads (migration 120, SMD-3306 PR 7a-1): each subject key's thoughts, in capture
 * order, each linked to the one before it by a standing `evolves` relation of origin `thread`. The triggers on
 * subjects keep a thread as its subjects land and leave; this links every thread at once — an existing brain's at the
 * upgrade to 120, which writes no edge itself — and heals one a delete left unlinked.
 *
 *   bun db/threads.ts --url … [--batch N] [--dry-run]
 *   bun db/threads.ts --url … --key <subject key> [--dry-run]
 *   bun db/threads.ts --url … --status
 *   await run({ url, dryRun: true })   # in-process: import { run } from "./threads.ts"
 *
 * ── What a run does ─────────────────────────────────────────────────────────
 * For each subject key two thoughts or more hold (111), and each key a thread's edge stands under, in key order, it
 * calls thread_relink(key), which writes each edge the thread has that does not stand, with its lineage, and closes
 * each it no longer has; --batch keys a transaction (200 unless said), so a brain of many keys commits as it goes and a
 * stop loses one batch at most. A key whose re-link writes ends its batch: the row locks a write takes (its edges'
 * thoughts, KEY SHARE) are held to the commit, so a delete of one of them waits one thread's re-link, never a batch's,
 * and delete_thought, which holds the brain's review lock while it waits, keeps every other delete waiting no longer. Each page reads its keys in their indexes' order, so a run over millions of keys pages
 * in linear time; a key one thought holds and no edge names has nothing to link, and is passed over. --key re-links
 * that one key's thread. --dry-run calls thread_relink(key, true), which counts what a re-link now would write and close
 * and writes nothing, a key a transaction, so it holds one key's lock at a time (a batch's held through it would leave
 * a delete beside it its gap). Every transaction runs under READ COMMITTED, which thread_relink needs, whatever the
 * role's default. A key a thread's edge still stands under with no subject left is re-linked too, its edges
 * closed. A writing run needs a re-link's writes, refused up front, by name, without them (a dry run and --status
 * read). A batch
 * holds its keys' locks until it commits, so a writer moving a thought between two of them can deadlock it: Postgres
 * ends one (40P01), and a batch it ends is said and run again, three tries in all.
 *
 * --status reads, writing nothing: the threads (keys held by two thoughts or more), the thoughts in them, the edges
 * standing against those a whole linking leaves (each thread's thoughts less one), and the keys whose standing edges
 * are not the ones their thread wants, compared edge by edge — a thread the upgrade has not linked yet, or a delete by
 * a role that cannot write a facet left a gap in (120's NOT HERE) — and the keys no thought holds still carrying
 * edges, the first ten of them named, for --key.
 *
 * ── Exit codes ──────────────────────────────────────────────────────────────
 * 0 done (or --status printed); 1 a failure; 2 usage (a malformed --key among it), no database URL, a brain without
 * 120 (named, with the migrate command), or a writing run's role short of a re-link's writes (named, with the grant).
 */

import type { SQL } from "bun";
import { blankProblem, commandLine, consoleWriter, flagList, numberProblem, type Writer } from "./cli.ts";
import { closeThenExit, databaseUrl, databaseUrlProblem, NO_DATABASE_URL, openSql } from "./connect.ts";
import { subjectKeyValid } from "../server-portable/subject.ts";

const FLAGS = { url: "one", key: "one", batch: "one", status: "none", "dry-run": "none" } as const;
const HINTS = { url: "<postgres://…>", key: "<subject key> (ticket:SMD-123, pr:727, version:v1.2.3, phrase:…)", batch: "<N> keys a transaction" };

/** The keys a transaction when --batch says none, and the most it takes. */
export const DEFAULT_BATCH = 200;
const MAX_BATCH = 10_000;

/** One threads.ts run — the CLI's flags, typed. `sql`, when given, is the caller's client, never closed here. */
export interface ThreadsOptions {
  url?: string;
  sql?: SQL;
  key?: string;
  batch?: number;
  status?: boolean;
  dryRun?: boolean;
  writer?: Writer;
}

type Relink = { ok: boolean; key: string; thoughts: number; closed: number; added: number; dry: boolean };

/** Whether 120 is on this brain: thread_relink exists. */
async function hasThreads(sql: SQL): Promise<boolean> {
  const [r] = (await sql`SELECT to_regprocedure('thread_relink(text, boolean)') IS NOT NULL AS ok`) as { ok: boolean }[];
  return r.ok;
}

/**
 * The threads' census (--status): each thread's edges compared with the ones its thoughts want, edge by edge, as
 * thread_relink reads them — a count alone would pass a thread linked wrong with the right number of edges — and the
 * first ten keys that differ, in key order.
 */
async function census(sql: SQL): Promise<{ threads: number; thoughts: number; standing: number; whole: number; unlinked: number; orphaned: number; first: string[] | null }> {
  const [r] = (await sql`
    WITH k AS (
      SELECT payload->>'key' AS key, count(*)::int AS n
        FROM thought_facets WHERE kind = 'subject' AND valid_until IS NULL GROUP BY 1
    ), want AS (
      SELECT w.key, w.newer, w.older FROM (
        SELECT s.payload->>'key' AS key, s.thought_id AS newer,
               lag(s.thought_id) OVER (PARTITION BY s.payload->>'key' ORDER BY t.created_at, t.id) AS older
          FROM thought_facets s JOIN thoughts t ON t.id = s.thought_id
         WHERE s.kind = 'subject' AND s.valid_until IS NULL) w
       WHERE w.older IS NOT NULL
    ), have AS (
      SELECT payload->>'key' AS key, thought_id AS newer, (payload->>'target')::uuid AS older
        FROM thought_facets WHERE kind = 'relation' AND valid_until IS NULL AND payload ? 'key'
    ), differ AS (
      SELECT key FROM (SELECT key, newer, older FROM want EXCEPT SELECT key, newer, older FROM have) missing
      UNION
      SELECT key FROM (SELECT key, newer, older FROM have EXCEPT SELECT key, newer, older FROM want) stray
    )
    SELECT (SELECT count(*) FROM k WHERE n >= 2)::int AS threads,
           (SELECT coalesce(sum(n), 0) FROM k WHERE n >= 2)::int AS thoughts,
           (SELECT count(*) FROM have)::int AS standing,
           (SELECT count(*) FROM want)::int AS whole,
           (SELECT count(*) FROM differ d WHERE EXISTS (SELECT 1 FROM k WHERE k.key = d.key))::int AS unlinked,
           (SELECT count(*) FROM differ d WHERE NOT EXISTS (SELECT 1 FROM k WHERE k.key = d.key))::int AS orphaned,
           (SELECT array_agg(key ORDER BY key) FROM (SELECT key FROM differ ORDER BY key LIMIT 10) f) AS first`) as { threads: number; thoughts: number; standing: number; whole: number; unlinked: number; orphaned: number; first: string[] | null }[];
  return r;
}

/** What a re-link writes that this role lacks, and the groups that grant it (consolidate.ts's words for its door's). */
async function relinkLacks(sql: SQL): Promise<string | null> {
  const [g] = (await sql`
    SELECT current_user AS role, has_any_column_privilege('thought_facets', 'INSERT') AS fi, has_any_column_privilege('thought_facets', 'UPDATE') AS fu,
           has_table_privilege('thought_facets', 'SELECT') AS fs, has_table_privilege('thoughts', 'SELECT') AS ts,
           has_any_column_privilege('thoughts', 'UPDATE') AS tu, has_any_column_privilege('derivations', 'INSERT') AS di,
           has_any_column_privilege('derivations', 'UPDATE') AS du, has_table_privilege('derivations', 'SELECT') AS ds`) as ({ role: string } & Record<string, boolean>)[];
  const lackOn = (table: string, privs: [string, boolean][]) => {
    const lacked = privs.filter(([, has]) => !has).map(([p]) => p);
    return lacked.length ? `${lacked.length > 1 ? `${lacked.slice(0, -1).join(", ")} and ${lacked.at(-1)}` : lacked[0]} on ${table}` : "";
  };
  const structure = !g.fi;
  const captureLacks = [lackOn("thought_facets", [["SELECT", g.fs], ["UPDATE", g.fu]]), lackOn("thoughts", [["SELECT", g.ts], ["UPDATE", g.tu]]),
    lackOn("derivations", [["INSERT", g.di], ["UPDATE", g.du], ["SELECT", g.ds]])].filter(Boolean);
  if (!structure && captureLacks.length === 0) return null;
  const what = [structure && "INSERT on thought_facets (the structure group)", captureLacks.length > 0 && `${captureLacks.join(", ")} (the capture group)`].filter(Boolean).join(" and ");
  const groups = [captureLacks.length > 0 && "capture", structure && "structure"].filter(Boolean).join(",");
  return `this role lacks ${what}, which a re-link writes with (each edge, its lineage, its thoughts' row locks) — cd db && bun migrate.ts --url <owner's url> --grant ${g.role} --groups ${groups}, or run as the owner`;
}

/** One transaction under READ COMMITTED, which thread_relink needs whatever the role's default (115's rule). */
async function readCommitted<T>(sql: SQL, body: (tx: SQL) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`;
    return body(tx as unknown as SQL);
  }) as Promise<T>;
}

/** A database error's SQLSTATE. */
const sqlState = (e: unknown): string | undefined => {
  const { errno, code } = (e ?? {}) as { errno?: unknown; code?: unknown };
  return typeof errno === "string" ? errno : typeof code === "string" ? code : undefined;
};

/**
 * The door's run, callable: the CLI's, returning the code the CLI exits with (the header's list). Its usage refusals
 * come first, in the CLI's words, before any connection is opened. Nothing happens at import.
 */
export async function run(opts: ThreadsOptions): Promise<number> {
  const { out, err } = opts.writer ?? consoleWriter;
  const blank = blankProblem(FLAGS, { key: opts.key });
  if (blank !== null) {
    err(`${blank}\n${flagList(FLAGS, HINTS)}`);
    return 2;
  }
  const noUrl = opts.url == null || opts.url.trim() === "";
  const urlProblem = noUrl ? (opts.sql == null ? NO_DATABASE_URL : null) : databaseUrlProblem(opts.url as string);
  if (urlProblem !== null) {
    err(urlProblem);
    return 2;
  }
  const batchProblem = opts.batch == null ? null : numberProblem("--batch", opts.batch, { min: 1, max: MAX_BATCH });
  if (batchProblem !== null) {
    err(`${batchProblem}\n${flagList(FLAGS, HINTS)}`);
    return 2;
  }
  const STATUS = opts.status === true;
  const DRY = opts.dryRun === true;
  const KEY = opts.key ?? undefined;
  if (STATUS && (DRY || KEY !== undefined || opts.batch != null)) {
    err("--status reads and writes nothing: it takes no --dry-run, --key or --batch");
    return 2;
  }
  if (KEY !== undefined && opts.batch != null) {
    err("--batch goes with a run over every key: --key re-links one thread in one transaction");
    return 2;
  }
  // 111's rule, before any connection: a key no subject can hold has no thread.
  if (KEY !== undefined && !subjectKeyValid(KEY)) {
    err(`--key is a subject key — ticket:<ID>, pr:<number>, version:<v1.2.3> or phrase:<lower-case words> — got ${JSON.stringify(KEY.slice(0, 80))}\n${flagList(FLAGS, HINTS)}`);
    return 2;
  }
  const BATCH = opts.batch ?? DEFAULT_BATCH;
  const sql = opts.sql ?? openSql(opts.url as string);
  try {
    if (!(await hasThreads(sql))) {
      err("  thread_relink is not on this brain: migration 120 (SMD-3306) is missing. Apply it — cd db && bun migrate.ts --url <url> — and run again.");
      return 2;
    }
    if (STATUS) {
      const c = await census(sql);
      out(`  threads:   ${c.threads} (subject keys two thoughts or more hold), ${c.thoughts} thought(s) in them`);
      out(`  edges:     ${c.standing} standing, ${c.whole} once every thread is linked`);
      out(c.unlinked === 0 && c.orphaned === 0
        ? "  linked:    every thread — nothing to do"
        : `  linked:    ${c.unlinked} key(s) whose edges differ from their thread's${c.orphaned ? `, ${c.orphaned} key(s) no thought holds still carrying edges` : ""} — threads.ts without --status links them`);
      const named = c.first ?? [];
      if (named.length) out(`  keys:      ${named.join(", ")}${c.unlinked + c.orphaned > named.length ? `, and ${c.unlinked + c.orphaned - named.length} more` : ""} — --key <key> re-links one`);
      return 0;
    }
    if (!DRY) {
      const lacks = await relinkLacks(sql);
      if (lacks !== null) {
        err(`  ${lacks}.`);
        return 2;
      }
    }
    if (KEY !== undefined) {
      const r = await readCommitted(sql, async (tx) => ((await tx`SELECT thread_relink(${KEY}, ${DRY}) AS r`) as { r: Relink }[])[0].r);
      out(`  ${KEY}: ${r.thoughts} thought(s), ${r.closed} edge(s) ${DRY ? "to close" : "closed"}, ${r.added} ${DRY ? "to write" : "written"}${DRY ? " (dry run: nothing written)" : ""}`);
      return 0;
    }
    let after = "";
    let keys = 0, closed = 0, added = 0, batches = 0;
    for (;;) {
      // The keys with work in them, a page at a time, each source read in its index's order and cut at the batch, so a
      // page costs the batch and not every key above the cursor: the keys two thoughts or more hold (111's key index),
      // and the keys a thread's edge stands under (120's) — a thread shrunk to one thought, or a key no subject holds,
      // whose edges the re-link closes. A key one thought holds and no edge names has nothing to link.
      const page = (await sql`
        SELECT key FROM (
          (SELECT payload->>'key' AS key FROM thought_facets
            WHERE kind = 'subject' AND valid_until IS NULL AND payload->>'key' > ${after}
            GROUP BY 1 HAVING count(*) >= 2
            ORDER BY 1 LIMIT ${BATCH})
          UNION
          (SELECT DISTINCT payload->>'key' FROM thought_facets
            WHERE kind = 'relation' AND valid_until IS NULL AND payload ? 'key' AND payload->>'key' > ${after}
            ORDER BY 1 LIMIT ${BATCH})
        ) k
         ORDER BY key
         LIMIT ${BATCH}`) as { key: string }[];
      if (page.length === 0) break;
      // One transaction a batch: its keys' re-links stand or fall together, and the run commits as it goes. A deadlock
      // with a writer (40P01, the server's to break) ends the batch, rolled back, and it is run again, three tries in all.
      // A key that writes ends its batch, its row locks going at the commit, and the next batch takes the page's rest:
      // a page is read once, so a run that writes every key still pages in linear time. A dry run's keys go a
      // transaction each, holding one key's lock at a time and no row's.
      for (let from = 0; from < page.length; ) {
        let done: Relink[] = [];
        if (DRY) {
          for (const { key } of page) done.push(await readCommitted(sql, async (tx) => ((await tx`SELECT thread_relink(${key}, true) AS r`) as { r: Relink }[])[0].r));
        } else {
          for (let attempt = 1; ; attempt++) {
            try {
              done = await readCommitted(sql, async (tx) => {
                const rs: Relink[] = [];
                for (const { key } of page.slice(from)) {
                  const r = ((await tx`SELECT thread_relink(${key}, false) AS r`) as { r: Relink }[])[0].r;
                  rs.push(r);
                  if (r.added > 0 || r.closed > 0) break;
                }
                return rs;
              });
              break;
            } catch (e) {
              if (sqlState(e) !== "40P01" || attempt >= 3) throw e;
              err(`  batch ${batches + 1}: a deadlock with a writer ended it (40P01, the server's to break) — its re-links run again`);
            }
          }
        }
        batches += 1;
        keys += done.length;
        for (const r of done) {
          closed += r.closed;
          added += r.added;
        }
        from += done.length;
      }
      after = page[page.length - 1].key;
    }
    out(`  ${keys} key(s) in ${batches} batch(es): ${closed} edge(s) ${DRY ? "to close" : "closed"}, ${added} ${DRY ? "to write" : "written"}${DRY ? " (dry run: nothing written)" : ""}`);
    return 0;
  } catch (e) {
    err(`  failed: ${(e as Error).message}`);
    return 1;
  } finally {
    // A failing close must not mask the run's own code.
    if (opts.sql == null) await sql.close().catch(() => {});
  }
}

if (import.meta.main) {
  const cli = commandLine("threads.ts", FLAGS, { hints: HINTS });
  const url = databaseUrl(cli.value("url"));
  const batch = cli.has("batch") ? cli.int("batch", { absent: DEFAULT_BATCH, min: 1, max: MAX_BATCH }) : undefined;
  const sql = openSql(url);
  await closeThenExit(sql, async () => {
    return run({ sql, url, batch, key: cli.value("key"), status: cli.has("status"), dryRun: cli.has("dry-run") });
  });
}
