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
 * each it no longer has. It reads the keys a page at a time, each page in its indexes' order, so a run over millions
 * of keys pages in linear time; a key one thought holds and no edge names has nothing to link, and is passed over. A
 * batch of a page's keys is a transaction, at most --batch of them (200, the default and the most), so a brain of many
 * keys commits as it goes and a stop loses one batch at most; a key whose re-link writes ends its batch, the next
 * taking the page's rest. A batch holds its keys' locks, and a write's row locks (its edges' thoughts, KEY SHARE),
 * until it commits: a subject written on one of its keys waits that long at its commit, and a delete of that thought
 * waits behind it, holding the brain's review lock (delete_thought's), so every other delete with it. A batch is a
 * thread's write and its no-op keys' reads at most, which is why --batch stops at 200: more keys a batch buy no speed,
 * a writing key ending it anyway, and hold more locks longer (10,000 held ten thousand advisory locks, enough to run a
 * default server's lock table short). --key re-links that one key's thread, and says so of a key nothing holds. --dry-run calls thread_relink(key, true),
 * which counts what a re-link now would write and close and writes nothing, a key a transaction (a batch each, in its
 * count, whatever --batch says: it sizes the pages alone), so it holds one key's lock at a time (a batch's held through it would leave a delete beside it its gap).
 * Every transaction runs under READ COMMITTED, which thread_relink needs, whatever the role's default. A key a
 * thread's edge still stands under with no subject left is re-linked too, its edges closed. A writing run needs a
 * re-link's writes, refused up front, by name, without them (a dry run and --status read). A writer outside the
 * stack's doors can still deadlock with a batch (120's NOT HERE): Postgres ends one (40P01), and a batch it ends is
 * said and run again, three tries in all.
 *
 * --status reads, writing nothing: the threads (keys held by two thoughts or more), the thoughts in them, the edges
 * standing against those a whole linking leaves (each thread's thoughts less one), and the keys whose standing edges
 * are not the ones their thread wants, compared edge by edge — a thread the upgrade has not linked yet, a gap a delete
 * left (by a role that cannot write a facet, above READ COMMITTED, or beside a held key), or a raw writer's change (a
 * created_at moved, a subject facet deleted alone beside a held key: 120's NOT HERE) — and the keys no thought holds
 * still carrying edges, the first ten of them named, for --key.
 *
 * ── Exit codes ──────────────────────────────────────────────────────────────
 * 0 done (or --status printed); 1 a failure; 2 usage (a malformed --key among it), no database URL, a brain without
 * 120 (named, with the migrate command), a role whose search_path misses thought_facets' schema (named, with the fix),
 * or a writing run's role short of a re-link's writes (named, with the grant).
 */

import type { SQL } from "bun";
import { blankProblem, commandLine, consoleWriter, flagList, numberProblem, type Writer } from "./cli.ts";
import { closeThenExit, databaseUrl, databaseUrlProblem, NO_DATABASE_URL, openSql } from "./connect.ts";
import { subjectKeyValid } from "../server-portable/subject.ts";
// The census (--status) is brain_info's and preflight's too, read here with no bound (SMD-3306 PR 7a-2c).
import { shellWord, threadCensus, UNBOUNDED } from "../server-portable/brain-info.ts";

const FLAGS = { url: "one", key: "one", batch: "one", status: "none", "dry-run": "none" } as const;
const HINTS = { url: "<postgres://…>", key: "<subject key> (ticket:SMD-123, pr:727, version:v1.2.3, phrase:…)", batch: "<N> keys a transaction at most (1–200)" };

/** The keys a transaction at most: --batch's default and its ceiling (more buy no speed and hold more locks longer). */
export const DEFAULT_BATCH = 200;
const MAX_BATCH = DEFAULT_BATCH;

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

/**
 * Whether 120 is on this brain: thread_relink resolves (true). Else why not — thought_facets in a schema this role's
 * search_path misses (its name), or 120 not applied (null) — so a role off the path is not told 120 is missing, as
 * brain_info's read is not (review pass 3).
 */
async function hasThreads(sql: SQL): Promise<true | string | null> {
  const [r] = (await sql`
    SELECT to_regprocedure('thread_relink(text, boolean)') IS NOT NULL AS ok,
           (SELECT string_agg(n.nspname::text, ', ' ORDER BY n.nspname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relname = 'thought_facets' AND to_regclass('thought_facets') IS NULL) AS unresolved`) as { ok: boolean; unresolved: string | null }[];
  return r.ok ? true : r.unresolved;
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
    const has = await hasThreads(sql);
    if (has !== true) {
      err(has === null
        ? "  thread_relink is not on this brain: migration 120 (SMD-3306) is missing. Apply it — cd db && bun migrate.ts --url <url> — and run again."
        : `  thought_facets exists (schema ${has}) but does not resolve for this role — not on its search_path, or no USAGE on that schema. Run as the owner (--url <the owner's connection string>), or put that schema on this role's search_path.`);
      return 2;
    }
    if (STATUS) {
      const c = await threadCensus(sql, UNBOUNDED);
      out(`  threads:   ${c.threads} (subject keys two thoughts or more hold), ${c.thoughts} thought(s) in them`);
      out(`  edges:     ${c.standing} standing, ${c.whole} once every thread is linked`);
      out(c.unlinked === 0 && c.orphaned === 0
        ? "  linked:    every thread — nothing to do"
        : `  linked:    ${c.unlinked} key(s) whose edges differ from their thread's${c.orphaned ? `, ${c.orphaned} key(s) no thought holds still carrying edges` : ""} — threads.ts without --status links them`);
      const named = c.first;
      // Each key on a line of its own, quoted as the shell takes it: a phrase key may hold an apostrophe, a comma or a
      // space, so a list joined with commas read as other keys and a pasted '<key>' broke (review pass 3).
      if (named.length) {
        const more = c.unlinked + c.orphaned - named.length;
        named.forEach((k, i) => out(`  ${i === 0 ? "keys:     " : "          "} ${shellWord(k)}`));
        out(`             ${more > 0 ? `and ${more} more; ` : ""}--key <a key as printed above> re-links one`);
      }
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
      // A key nothing holds reads the same as a thread already linked: said, so a mistyped key is not taken for one.
      if (r.thoughts === 0 && r.closed === 0) out("  no thought holds this key and no thread's edge stands under it — nothing to link (--status names the first keys whose edges differ, each as --key takes it)");
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
      // transaction each, a batch each, holding one key's lock at a time and no row's.
      for (let from = 0; from < page.length; ) {
        let done: Relink[] = [];
        if (DRY) {
          const { key } = page[from];
          done = [await readCommitted(sql, async (tx) => ((await tx`SELECT thread_relink(${key}, true) AS r`) as { r: Relink }[])[0].r)];
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
