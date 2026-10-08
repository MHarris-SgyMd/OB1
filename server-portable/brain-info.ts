// brain-info.ts — what this brain is, in one record (SMD-2041).
//
// The facts existed before this file, on three surfaces none of which answered
// at runtime: preflight read the schema version, the ledger and pgvector once,
// at container start; thought_stats counts thoughts; GET /health said `ok`.
// Never read anywhere: the commit the image was built from, Postgres's version,
// the database's size, the audit-row count, the tier, the HNSW parameters. One
// record now carries them, read by one function under two surfaces — the
// `brain_info` MCP tool (agents) and a keyed GET /health (probes, deploy/smoke.sh)
// — and preflight's `vector extension`, `migration ledger` and `schema version`
// rows read the same `readDatabaseFacts`, so the gate and the tool cannot
// disagree about what the database holds.
//
// The read's shape: ONE transaction on one connection; the catalog facts in one
// statement; each read that a role or a lock can refuse in a savepoint of its
// own; the timeouts set once, never raised above what the role already has; and
// the facts written into a progress record as they arrive, so a caller's
// deadline keeps what was read and names the rest. (A transaction per read,
// each with its own budget, added past one deadline and lost every fact at it.)
//
// No imports: the Workers build bundles this (index.ts imports it), and the SQL
// client is taken structurally rather than from "bun".

/** A tagged-template SQL client — Bun's `SQL`, structurally. */
export type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any[]>;

/** A transaction: statements, and a savepoint that rolls back alone when its body raises. */
export type SqlTx = SqlTag & { savepoint<T>(fn: (sp: SqlTag) => Promise<T>): Promise<T> };

/** A client that can open a transaction — Bun's `SQL`, or the pool the SQL store holds. */
export type SqlClient = SqlTag & { begin<T>(fn: (tx: SqlTx) => Promise<T>): Promise<T> };

/**
 * How long one statement may run, and wait for a lock, before it is recorded
 * as unread (review pass 1: a migration holding ACCESS EXCLUSIVE on
 * thought_audit left count(*) waiting, and a keyed /health probe got no reply).
 * Local to the read's transaction (set_config's `true`), and a ceiling: a role
 * or database already stricter keeps its own. The defaults are preflight's
 * and the tool's; the health body passes tighter ones, so its reads fit its
 * deadline (index.ts).
 */
export const READ_STATEMENT_TIMEOUT_MS = 5_000;
export const READ_LOCK_TIMEOUT_MS = 1_000;

/** The tables whose row counts the record carries. */
export const COUNTED_TABLES = ["thoughts", "thought_audit", "thought_chunks", "ob1_entities"] as const;
export type CountedTable = (typeof COUNTED_TABLES)[number];

/** The tables the read asks after: the counted ones, the config and the ledger. */
const KNOWN_TABLES = ["ob1_config", "schema_migrations", ...COUNTED_TABLES] as const;
type KnownTable = (typeof KNOWN_TABLES)[number];

export interface HnswIndex {
  index: string;
  table: string;
  /** pgvector's build parameters; its defaults (16, 64) when the index was built WITH none. */
  m: number;
  efConstruction: number;
}

/**
 * Why a fact is missing. `refused`: the role may not read it (42501).
 * `timeout`: a statement or lock timeout fired (57014, 55P03). `deadline`: the
 * caller's deadline came first and the read never ran. `invisible`: the table
 * exists but does not resolve for this role — not on its search_path, or no
 * USAGE on its schema. `error`: anything else.
 */
export type UnreadReason = "refused" | "timeout" | "deadline" | "invisible" | "error";
export interface Unread {
  reason: UnreadReason;
  message: string;
}

/**
 * What the database says about itself. A field is null for one of two reasons,
 * told apart by `unread`: the thing is absent (no pgvector, no schema_version
 * recorded, no such table anywhere — no entry), or the read did not answer (an
 * entry naming the field, the reason and the message).
 */
export interface DatabaseFacts {
  /** `server_version`, e.g. "16.4 (Debian 16.4-1.pgdg120+2)". */
  postgres: string;
  /** The installed pgvector and the schema it lives in; null when not installed. */
  pgvector: { version: string; schema: string } | null;
  /** ob1_config.schema_version (044, SMD-1804); null when none is recorded. */
  schemaVersion: string | null;
  /** The embedding contract the brain records (006); null fields when unrecorded. */
  embedding: { model: string | null; dim: number | null };
  /**
   * The migration ledger. `present` is whether a schema_migrations exists —
   * resolved for this role or not (pg_class, not the search path) — and
   * `names` every recorded name, or null when it could not be read (`unread`
   * says why: a refusal, a timeout, or a ledger this role does not resolve).
   */
  ledger: { present: boolean; names: string[] | null };
  /** The highest three-digit prefix the ledger records; null when it records none or was not read. */
  highestMigration: number | null;
  /** Row counts; null when the read was asked for none (`stats: false`). */
  counts: Record<CountedTable, number | null> | null;
  /** pg_database_size(current_database()), in bytes; null when not read. */
  databaseBytes: number | null;
  /**
   * The board-sync watermark (SMD-2261): the newest Linear `updatedAt` any
   * thought reflects — max metadata.linear_updated_at, which sync-linear.ts
   * writes — as an ISO instant in UTC. Null when no thought carries a usable one
   * (malformed and future values are passed over, see BOARD_SYNC_SQL), when
   * not read (`unread` names it) or not asked (`stats: false`). A high-water
   * mark: the newest board move the brain reflects, not proof it reflects every
   * move before it. It moves when the board does, so a quiet board leaves it old
   * on a current brain, and it says nothing of whether the sync is alive. It is
   * a thought's metadata — a write key can set it to any instant up to an hour
   * past the database's clock, and a later one counts once the clock reaches
   * it — not a fact the database keeps.
   */
  boardSync: string | null;
  /**
   * The long-running workers' heartbeats (SMD-2261, db/pass-stamp.ts): one per
   * `heartbeat:` row of ob1_config, judged against the database's clock.
   * `ignored` counts rows whose key or value is not a heartbeat's shape — named,
   * not printed. Null when ob1_config was not read (`unread` names it) or is
   * absent. A worker that never ran on this brain has no row.
   */
  workers: { heartbeats: WorkerHeartbeat[]; ignored: number } | null;
  /** Every HNSW index on a table on this connection's search_path. */
  hnsw: HnswIndex[];
  /** Field → why its read did not answer. Empty when every read answered. */
  unread: Record<string, Unread>;
}

/** One long-running worker's heartbeat as the record carries it (SMD-2261). */
export interface WorkerHeartbeat {
  /** The ob1_config row's key — what retiring the worker deletes. */
  key: string;
  worker: "board-sync" | "extract" | "consolidate";
  /** The claim job it works (extract:qwen2.5:7b@p2, or a custom --job as given); null for board-sync. */
  job: string | null;
  /** When it last stamped, a UTC instant, and how long ago by the database's clock. */
  at: string;
  ageS: number;
  /** The longest the worker lets pass between two stamps. */
  everyS: number;
  /** Older than three of its own intervals: the worker has stopped, or cannot reach the database. */
  stale: boolean;
  /** A pass was under way at the last stamp. */
  running: boolean;
  /** How the last pass ended; null before the first ends. */
  outcome: "ok" | "failed" | "stopped" | null;
  /** The worker's process has ended — stopped, or failed on a refusal or a thrown pass — so its row speaks for nothing running. */
  ended: boolean;
  /** The last judged block's answers and malformed ones, and whether they passed SMD-2266's alarm (extraction only). */
  malformed: { answers: number; bad: number; alarm: boolean } | null;
}

/** A heartbeat older than this many of its own intervals is stale. */
export const STALE_AFTER_INTERVALS = 3;

const HEARTBEAT_KEY = /^heartbeat:(board-sync|extract|consolidate)(?::([A-Za-z0-9._:@/+-]{1,120}))?$/;
// As long as a key's suffix with the worker's prefix on it, so every key
// stampKey writes is one the reader takes (review pass 2: 121–128 were not).
const JOB_TOKEN = /^[A-Za-z0-9._:@/+-]{1,132}$/;
/** A heartbeat stamped this far past the reader's now() is not one: a stamp's now() can trail the read's by its own transaction, never by a minute. */
const FUTURE_SLACK_S = 60;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const count = (n: unknown, max = Number.MAX_SAFE_INTEGER): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= max;

/**
 * The heartbeat rows as the record carries them. The record is rendered
 * unguarded (render.ts's AS_RECORD), and any role with the worker group can
 * write ob1_config, so a row counts only in full: a key naming a known worker
 * (board-sync without a job, the claim workers with one, of a bounded token
 * alphabet), a value of the version db/pass-stamp.ts writes, numbers that are
 * counts, the enums as written, and the database's own instant. Anything else
 * is counted in `ignored`, and its text goes nowhere.
 */
export function parseHeartbeats(rows: { key: unknown; value: unknown; at: unknown; age_s: unknown; total?: unknown }[]): { heartbeats: WorkerHeartbeat[]; ignored: number } {
  const heartbeats: WorkerHeartbeat[] = [];
  // Rows past the read's bound are counted, not carried (review pass 1).
  let ignored = Math.max(0, Number(rows[0]?.total ?? rows.length) - rows.length) || 0;
  for (const r of rows) {
    const k = typeof r.key === "string" ? HEARTBEAT_KEY.exec(r.key) : null;
    const worker = k?.[1] as WorkerHeartbeat["worker"] | undefined;
    const suffix = k?.[2];
    let v: Record<string, unknown> | null = null;
    try { v = typeof r.value === "string" ? JSON.parse(r.value) : null; } catch { v = null; }
    const ageS = typeof r.age_s === "number" ? r.age_s : Number(r.age_s);
    // A block not of the shape is left off, not a reason to refuse the row: the
    // heartbeat still says whether the worker is alive. Any role of the worker
    // group can write the row, so a block of the right JSON types but
    // bad > answers must not hide a live follower (review pass 3).
    const m = v?.malformed as Record<string, unknown> | undefined;
    const malformed = m !== null && typeof m === "object" && count(m.answers) && count(m.bad, m.answers as number) && typeof m.alarm === "boolean"
      ? { answers: m.answers as number, bad: m.bad as number, alarm: m.alarm }
      : null;
    // The job the worker works is the value's; its key must be the one
    // db/pass-stamp.ts's stampKey derives from it (a custom --job prefixed).
    const job = v?.job === undefined ? (suffix === undefined ? null : `${worker}:${suffix}`) : v.job;
    const jobOk = worker === "board-sync"
      ? suffix === undefined && v?.job === undefined
      : suffix !== undefined && typeof job === "string" && JOB_TOKEN.test(job) && r.key === `heartbeat:${job.startsWith(`${worker}:`) ? job : `${worker}:${job}`}`;
    const ok = worker !== undefined && jobOk
      && v !== null && typeof v === "object" && v.v === 1
      && count(v.every_s, 2_147_483) && (v.every_s as number) >= 1
      && typeof v.running === "boolean"
      && (v.outcome === null || v.outcome === "ok" || v.outcome === "failed" || v.outcome === "stopped")
      && (v.ended === undefined || v.ended === true)
      && typeof r.at === "string" && UTC_INSTANT.test(r.at) && Number.isFinite(ageS) && ageS > -FUTURE_SLACK_S;
    if (!ok) {
      ignored++;
      continue;
    }
    const everyS = v!.every_s as number;
    heartbeats.push({
      key: r.key as string,
      worker: worker!,
      job: job as string | null,
      at: r.at as string,
      ageS: Math.max(0, Math.round(ageS)),
      everyS,
      stale: ageS > STALE_AFTER_INTERVALS * everyS,
      running: v!.running as boolean,
      outcome: v!.outcome as WorkerHeartbeat["outcome"],
      ended: v!.ended === true || v!.outcome === "stopped",
      malformed,
    });
  }
  return { heartbeats, ignored };
}

/** The heartbeat rows, at most fifty — one per worker and job, so a brain holds a handful. */
const HEARTBEAT_SQL = (sql: SqlTag) => sql`
  SELECT key, value, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
         extract(epoch FROM now() - updated_at)::float8 AS age_s, count(*) OVER () AS total
    FROM ob1_config WHERE key LIKE 'heartbeat:%' ORDER BY key LIMIT 50`;

export interface ReadOptions {
  /** Read the row counts and the database's size too — brain_info does; preflight, which uses neither, does not. Default true. */
  stats?: boolean;
  /** Ceilings on each statement's run and lock wait, in ms; READ_STATEMENT_TIMEOUT_MS and READ_LOCK_TIMEOUT_MS when unset. */
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
}

/**
 * A read in flight, observable by its caller: the catalog facts once they are
 * in, every guarded read still `pending`, and `abandoned` set by a caller whose
 * deadline has come — the read then starts nothing more, and `snapshotFacts`
 * names what it did not reach as `deadline`.
 */
export interface ReadProgress {
  facts: DatabaseFacts | null;
  pending: Set<string>;
  abandoned: boolean;
}

export const newProgress = (): ReadProgress => ({ facts: null, pending: new Set(), abandoned: false });

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0] || "no message";

/** A failed read's reason, from the SQLSTATE Bun's PostgresError carries in `errno`. */
export function unreadReason(e: unknown): UnreadReason {
  const state = String((e as { errno?: unknown })?.errno ?? "");
  return state === "42501" ? "refused" : state === "57014" || state === "55P03" ? "timeout" : "error";
}

/** pgvector's HNSW `reloptions` (`m=24,ef_construction=100`) — its defaults where unset. */
export function parseHnswOptions(opts: string | null | undefined): { m: number; efConstruction: number } {
  const get = (k: string) => {
    const v = new RegExp(`(?:^|,)${k}=(\\d+)(?:,|$)`).exec(opts ?? "")?.[1];
    return v === undefined ? undefined : Number(v);
  };
  return { m: get("m") ?? 16, efConstruction: get("ef_construction") ?? 64 };
}

// One literal statement per table: an identifier cannot be a bound parameter.
const COUNT_SQL: Record<CountedTable, (sql: SqlTag) => Promise<{ n: number }[]>> = {
  thoughts: (sql) => sql`SELECT count(*)::float8 AS n FROM thoughts`,
  thought_audit: (sql) => sql`SELECT count(*)::float8 AS n FROM thought_audit`,
  thought_chunks: (sql) => sql`SELECT count(*)::float8 AS n FROM thought_chunks`,
  ob1_entities: (sql) => sql`SELECT count(*)::float8 AS n FROM ob1_entities`,
};

/**
 * The board-sync watermark's read. Only a full ISO instant with its offset
 * counts, and only one Postgres reads as a timestamp: a malformed value, a bare
 * date or a word timestamptz accepts ('infinity', 'now') is passed over rather
 * than failing the read or winning the max — the value is a thought's
 * metadata, and the record carries it unguarded (render.ts's AS_RECORD).
 *
 * So is an instant more than an hour past the database's clock. Linear's
 * updatedAt is never in the future, and any write key can set the key: a
 * far-future value would otherwise win the max for good, and one past 9999 in
 * UTC would render a shape boardSyncValue refuses, leaving the field unread
 * for good (review pass 1). The cost is a host clock more than an hour slow,
 * whose watermark lags a fresh move until the clock catches up.
 *
 * The cast sits in an inner CASE, after the validity test, because AND does
 * not order its operands. The pattern is spelled with [0-9], not \d: a Bun
 * template drops the backslash. `metadata ? key` is the GIN index 001 builds.
 */
const BOARD_SYNC_SQL = (sql: SqlTag) => sql`
  SELECT to_char(max(CASE WHEN v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$'
                           AND pg_input_is_valid(v, 'timestamptz')
                          THEN CASE WHEN v::timestamptz <= now() + interval '1 hour' THEN v::timestamptz END END) AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS w
    FROM (SELECT metadata->>'linear_updated_at' AS v FROM thoughts WHERE metadata ? 'linear_updated_at') s`;

/** The watermark as the record carries it: the read's instant, or null when no thought has a usable one. Anything else is a read that did not answer. */
export function boardSyncValue(w: unknown): string | null {
  if (w == null) return null;
  if (typeof w !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(w)) throw new Error(`the board-sync watermark read answered ${typeof w === "string" ? "a value not shaped as an ISO instant" : typeof w}`);
  return w;
}

/**
 * Read the database's facts over a direct connection — the SQL store's pool, or
 * preflight's own client — in one transaction. Raises only when the transaction
 * or its catalog statement fails (the connection itself); every guarded read
 * that does not answer is recorded in `unread` while the rest go on. Pass a
 * `progress` to observe the read, and to abandon it at a deadline.
 */
export async function readDatabaseFacts(client: SqlClient, opts: ReadOptions = {}, progress: ReadProgress = newProgress()): Promise<DatabaseFacts> {
  const stats = opts.stats ?? true;
  const st = opts.statementTimeoutMs ?? READ_STATEMENT_TIMEOUT_MS;
  const lt = opts.lockTimeoutMs ?? READ_LOCK_TIMEOUT_MS;
  return client.begin(async (tx) => {
    // Ceilings, not settings: 0 (no limit) or a looser value is lowered to the
    // read's, a stricter one kept. pg_settings.setting is in ms for both.
    await tx`
      SELECT set_config('statement_timeout', (CASE WHEN s.st = 0 OR s.st > ${st}::int THEN ${st}::int ELSE s.st END)::text, true),
             set_config('lock_timeout', (CASE WHEN s.lt = 0 OR s.lt > ${lt}::int THEN ${lt}::int ELSE s.lt END)::text, true)
        FROM (SELECT (SELECT setting::int FROM pg_settings WHERE name = 'statement_timeout') AS st,
                     (SELECT setting::int FROM pg_settings WHERE name = 'lock_timeout') AS lt) s`;

    // The catalog in one statement: every relation here is readable by any
    // role, and to_regclass and pg_class take no lock a migration holds. A
    // table is resolved (to_regclass: this role's search path and USAGE) or
    // merely present somewhere (pg_class) — the two apart, so a table this
    // role cannot see is never called absent (review pass 2: preflight then
    // recommends --baseline, which marks pending migrations applied).
    const [cat] = await tx`
      SELECT current_setting('server_version') AS postgres,
             (SELECT e.extversion::text FROM pg_extension e WHERE e.extname = 'vector') AS vec_version,
             (SELECT n.nspname::text FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector') AS vec_schema,
             -- Schema-qualified: regclass's text drops the schema of a table the
             -- path reaches, and the schema is the point of the message.
             (SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE c.oid = to_regclass('schema_migrations')) AS ledger_resolves_to,
             jsonb_build_object(
               'ob1_config', to_regclass('ob1_config') IS NOT NULL,
               -- The fork's ledger resolves only if the table the path
               -- reaches carries migrate.ts's sha256 column: another tool's
               -- schema_migrations on the path is not it (review pass 4).
               'schema_migrations', EXISTS (SELECT 1 FROM pg_attribute a
                                             WHERE a.attrelid = to_regclass('schema_migrations') AND a.attname = 'sha256' AND NOT a.attisdropped),
               'thoughts', to_regclass('thoughts') IS NOT NULL,
               'thought_audit', to_regclass('thought_audit') IS NOT NULL,
               'thought_chunks', to_regclass('thought_chunks') IS NOT NULL,
               'ob1_entities', to_regclass('ob1_entities') IS NOT NULL) AS resolved,
             (SELECT COALESCE(jsonb_object_agg(relname, schemas), '{}'::jsonb) FROM (
                SELECT c.relname::text AS relname, string_agg(n.nspname::text, ', ' ORDER BY n.nspname) AS schemas
                  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.relkind IN ('r', 'p')
                   AND c.relname IN ('ob1_config', 'schema_migrations', 'thoughts', 'thought_audit', 'thought_chunks', 'ob1_entities')
                   -- Another tool's schema_migrations (Supabase's auth and
                   -- supabase_migrations, Rails, dbmate) is not this ledger:
                   -- only one carrying migrate.ts's sha256 column counts
                   -- (review pass 3).
                   AND (c.relname <> 'schema_migrations' OR EXISTS (
                         SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'sha256' AND NOT a.attisdropped))
                 GROUP BY c.relname) x) AS anywhere,
             (SELECT COALESCE(jsonb_agg(jsonb_build_object('index', c.relname, 'table', t.relname, 'opts', array_to_string(c.reloptions, ',')) ORDER BY t.relname, c.relname), '[]'::jsonb)
                FROM pg_index i
                JOIN pg_class c ON c.oid = i.indexrelid
                JOIN pg_class t ON t.oid = i.indrelid
                JOIN pg_am a ON a.oid = c.relam
               WHERE a.amname = 'hnsw' AND pg_table_is_visible(t.oid)) AS hnsw`;
    const resolved = cat.resolved as Record<KnownTable, boolean>;
    const anywhere = cat.anywhere as Record<string, string>;

    const facts: DatabaseFacts = {
      postgres: String(cat.postgres),
      pgvector: cat.vec_version == null ? null : { version: String(cat.vec_version), schema: String(cat.vec_schema) },
      schemaVersion: null,
      embedding: { model: null, dim: null },
      ledger: { present: resolved.schema_migrations || "schema_migrations" in anywhere, names: [] },
      highestMigration: null,
      counts: stats ? Object.fromEntries(COUNTED_TABLES.map((t) => [t, null])) as Record<CountedTable, number | null> : null,
      databaseBytes: null,
      boardSync: null,
      workers: null,
      hnsw: (cat.hnsw as { index: string; table: string; opts: string | null }[]).map((h) => ({ index: h.index, table: h.table, ...parseHnswOptions(h.opts) })),
      unread: {},
    };
    progress.facts = facts;

    // The guarded reads, in order. Each names the table it needs; a table that
    // does not resolve is not queried — absent, or `invisible` when pg_class
    // has it where this role cannot reach.
    // `clear` takes a value back when the savepoint fails after the read wrote
    // it (its RELEASE, say), so a fact is never both read and unread (review pass 4).
    type Guarded = { field: string; table?: KnownTable; read: (sp: SqlTag) => Promise<void>; clear: () => void };
    const guarded: Guarded[] = [
      {
        field: "ob1_config",
        table: "ob1_config",
        read: async (sp) => {
          const rows = await sp`SELECT key, value FROM ob1_config WHERE key IN ('schema_version', 'embedding_model', 'embedding_dim')`;
          const config = Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value])) as Record<string, string>;
          const dim = config.embedding_dim === undefined ? null : Number(config.embedding_dim);
          facts.schemaVersion = config.schema_version ?? null;
          facts.embedding = { model: config.embedding_model ?? null, dim: dim === null || Number.isNaN(dim) ? null : dim };
        },
        clear: () => { facts.schemaVersion = null; facts.embedding = { model: null, dim: null }; },
      },
      // Not a stats read: preflight's workers row reads it (SMD-2261).
      {
        field: "workers",
        table: "ob1_config",
        read: async (sp) => { facts.workers = parseHeartbeats(await HEARTBEAT_SQL(sp)); },
        clear: () => { facts.workers = null; },
      },
      {
        field: "ledger",
        table: "schema_migrations",
        read: async (sp) => {
          const names = (await sp`SELECT name FROM schema_migrations`).map((r: { name: string }) => String(r.name));
          const numbers = names.map((n) => Number(n.slice(0, 3))).filter((n) => !Number.isNaN(n));
          facts.ledger.names = names;
          facts.highestMigration = numbers.length ? Math.max(...numbers) : null;
        },
        clear: () => { facts.ledger.names = null; facts.highestMigration = null; },
      },
      ...(stats
        ? [
            ...COUNTED_TABLES.map((t): Guarded => ({ field: `counts.${t}`, table: t, read: async (sp) => { facts.counts![t] = Number((await COUNT_SQL[t](sp))[0].n); }, clear: () => { facts.counts![t] = null; } })),
            { field: "databaseBytes", read: async (sp: SqlTag) => { facts.databaseBytes = Number((await sp`SELECT pg_database_size(current_database())::float8 AS n`)[0].n); }, clear: () => { facts.databaseBytes = null; } },
            { field: "boardSync", table: "thoughts" as const, read: async (sp: SqlTag) => { facts.boardSync = boardSyncValue((await BOARD_SYNC_SQL(sp))[0]?.w); }, clear: () => { facts.boardSync = null; } },
          ]
        : []),
    ];
    // A table that does not resolve is settled here, before any read: absent
    // everywhere (null, no entry) or `invisible` — so only a read that will run
    // is pending, and a deadline never names an absent table (review pass 3).
    const toRun: Guarded[] = [];
    for (const g of guarded) {
      if (g.table && !resolved[g.table]) {
        // A ledger the path does reach, but through another tool's table of the
        // same name, is shadowed — a path-order fix, not a grant (review pass 5).
        const shadow = g.table === "schema_migrations" && cat.ledger_resolves_to != null ? String(cat.ledger_resolves_to) : null;
        if (g.table in anywhere) {
          facts.unread[g.field] = {
            reason: "invisible",
            message: shadow
              ? `${g.table} exists (schema ${anywhere[g.table]}) but this role's search_path reaches ${shadow} first, which is not the ledger (no sha256 column)`
              : `${g.table} exists (schema ${anywhere[g.table]}) but does not resolve for this role — not on its search_path, or no USAGE on that schema`,
          };
        }
        if (g.field === "ledger") facts.ledger.names = g.table in anywhere ? null : [];
      } else {
        toRun.push(g);
        progress.pending.add(g.field);
      }
    }

    for (const g of toRun) {
      if (progress.abandoned) break; // snapshotFacts named what is still pending
      try {
        // The field leaves `pending` in the same synchronous step that writes
        // it, before the savepoint's RELEASE round trip: a deadline between
        // the two would otherwise name a written fact `deadline` (review pass 3).
        await tx.savepoint(async (sp) => {
          // A deadline during the SAVEPOINT round trip: start no statement
          // (review pass 4: the abandoned read ran one more count).
          if (progress.abandoned) return;
          await g.read(sp);
          progress.pending.delete(g.field);
        });
      } catch (e) {
        progress.pending.delete(g.field);
        g.clear();
        facts.unread[g.field] = { reason: unreadReason(e), message: message(e) };
      }
    }
    return facts;
  });
}

/** Every read the progress still has pending, named with the reason it was not reached. */
function markPending(progress: ReadProgress, unread: Unread): void {
  if (!progress.facts) return;
  for (const field of progress.pending) {
    progress.facts.unread[field] = unread;
    if (field === "ledger") progress.facts.ledger.names = null;
  }
  progress.pending.clear();
}

/**
 * The facts a read has reached, as its caller finds them at a deadline or a
 * failure — a copy, since the read may still be finishing its last statement.
 * The rest are named with `unread`'s reason. Null when the catalog statement
 * has not answered: nothing is known about the database.
 */
export function snapshotFacts(progress: ReadProgress, unread: Unread = { reason: "deadline", message: "not read before the deadline" }): DatabaseFacts | null {
  progress.abandoned = true;
  markPending(progress, unread);
  return progress.facts ? structuredClone(progress.facts) : null;
}

/** What the server process knows about itself — no database needed. */
export interface ServerFacts {
  /** FORK_VERSION (server-portable/version.ts). */
  version: string;
  /** The migration range releases.json records for that version, or null. */
  releaseRange: readonly [number, number] | null;
  /** The highest migration file in the tree the server was built from. */
  latestMigration: number;
  /** The commit the image was built from (OB1_GIT_SHA), or "unknown". */
  commit: string;
  store: string;
  /** OB1_TIER, or null for a plain brain. */
  tier: string | null;
  /** The embedding model and width the server is configured with. */
  embedding: { model: string; dim: number };
}

/**
 * The database's facts as the record carries them: the ledger as whether it is
 * there and readable, not every name it records — preflight's remedies need
 * the names, the record's readers need the highest (review pass 1).
 */
export type DatabaseSummary = Omit<DatabaseFacts, "ledger"> & { ledger: { present: boolean; readable: boolean } };

export type LedgerStatus = "current" | "behind" | "ahead" | null;

export interface BrainInfo extends ServerFacts {
  /**
   * The migrations this server's tree carries past its release's range —
   * [first, last] — or null when the tree ends at the range (a release image)
   * or no range is recorded. Between cuts every build of main reports the last
   * cut's version; this says what it adds (review pass 4).
   */
  unreleased: readonly [number, number] | null;
  /** The database's facts, or why none could be had. */
  database: DatabaseSummary | { error: string };
  /**
   * The ledger's highest migration against the server's tree: `current` when
   * equal, `behind` when the brain has not applied the tree's last migration,
   * `ahead` when a newer tree migrated it; null when the ledger gave no number.
   */
  ledgerStatus: LedgerStatus;
}

/** The ledger's highest migration judged against the tree's last — one rule for the record and preflight's row. */
export function ledgerStatus(highest: number | null, latest: number): LedgerStatus {
  return highest === null ? null : highest === latest ? "current" : highest < latest ? "behind" : "ahead";
}

/**
 * The one read under the tool and the health body. Never raises, and answers
 * by `deadlineMs` whatever the database does: the facts read by then, each
 * read not yet answered named `deadline`; a database whose catalog has not
 * answered by then — unreachable, say — is `database.error`.
 */
export async function brainInfo(
  server: ServerFacts,
  readDatabase: (progress: ReadProgress) => Promise<DatabaseFacts>,
  deadlineMs: number,
): Promise<BrainInfo> {
  const progress = newProgress();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let facts: DatabaseFacts | null;
  let failure = "";
  try {
    facts = await Promise.race([
      readDatabase(progress),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), deadlineMs); }),
    ]);
    if (facts === null) {
      facts = snapshotFacts(progress);
      if (!facts) failure = `the database gave no answer within ${deadlineMs} ms`;
    }
  } catch (e) {
    // A failure after the catalog answered (the connection dropped mid-read, a
    // COMMIT refused) keeps what was read, the rest named with the error
    // (review pass 3: it threw every fact away).
    failure = message(e);
    facts = snapshotFacts(progress, { reason: "error", message: failure });
    // Every read answered and the transaction then failed (its COMMIT, the
    // connection dropping): nothing was pending to carry the error, so it is
    // named on its own rather than lost (review pass 4).
    if (facts && !Object.values(facts.unread).some((u) => u.message === failure)) facts.unread.transaction = { reason: unreadReason(e), message: failure };
  } finally {
    clearTimeout(timer);
  }
  const unreleased = server.releaseRange && server.latestMigration > server.releaseRange[1]
    ? [server.releaseRange[1] + 1, server.latestMigration] as const
    : null;
  if (!facts) return { ...server, unreleased, database: { error: failure }, ledgerStatus: null };
  const { ledger, ...rest } = facts;
  const database: DatabaseSummary = { ...rest, ledger: { present: ledger.present, readable: ledger.present && ledger.names !== null } };
  return { ...server, unreleased, database, ledgerStatus: ledgerStatus(facts.highestMigration, server.latestMigration) };
}

/** A migration number as the ledger and the files spell it — 052. */
export const pad3 = (n: number) => String(n).padStart(3, "0");

/** Bytes as the largest whole unit that keeps one decimal — 45.2 MB. */
export function formatBytes(n: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return u === 0 ? `${v} B` : `${v.toFixed(1)} ${units[u]}`;
}

/** An unread fact as the table says it. */
const unreadWords = (u: Unread): string =>
  u.reason === "refused" ? "not readable by this role"
    : u.reason === "timeout" ? "not read in time"
    : u.reason === "deadline" ? "not read before the deadline"
    : u.reason === "invisible" ? "not resolved for this role"
    : "not read";

/** A duration as an operator reads it: seconds, minutes, hours, then days. */
export function ago(s: number): string {
  return s < 90 ? `${Math.round(s)} s` : s < 90 * 60 ? `${Math.round(s / 60)} min` : s < 48 * 3600 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`;
}

/** One heartbeat's state in a few words: what a reader acts on first. */
export function heartbeatState(h: WorkerHeartbeat): string {
  const alarm = h.malformed?.alarm ? `; ${h.malformed.bad} of its last ${h.malformed.answers} answers malformed` : "";
  const when = `last stamped ${ago(h.ageS)} ago, every ${h.everyS} s${alarm}`;
  // A worker that said it ended is stopped, fresh or not (review pass 1: it
  // read "alive"); one that ended on a failure says so (review pass 2).
  if (h.ended) return `${h.outcome === "failed" ? "ended on a failure" : "stopped"} (${when})`;
  if (h.stale) return `stale (${when}${h.outcome === "failed" ? ", its last pass failed" : ""})`;
  // Running says so, and a failed last pass still shows: a follower against a
  // down provider spends most of each pass in its pauses (review pass 3).
  return `${h.running ? "running a pass" : "alive"}${h.outcome === "failed" ? ", its last pass failed" : ""} (${when})`;
}

/** The Workers row: each heartbeat's state, none, or why it was not read. */
function workersLine(db: DatabaseSummary): string {
  if (db.workers === null) return "workers" in db.unread ? `? (ob1_config ${unreadWords(db.unread.workers)})` : "no ob1_config";
  const { heartbeats, ignored } = db.workers;
  const tail = ignored ? ` (${ignored} heartbeat row(s) not of the shape, ignored)` : "";
  if (heartbeats.length === 0) return `none stamped — no long-running worker has run here${tail}`;
  return heartbeats.map((h) => `${h.job ?? h.worker} ${heartbeatState(h)}`).join("; ") + tail;
}

/** The record as the tool's short table: one fact per line, a label and a value. */
export function renderBrainInfo(info: BrainInfo): string {
  const row = (label: string, value: string) => `${`${label}:`.padEnd(16)} ${value}`;
  const tail = info.unreleased ? `; this tree adds ${info.unreleased[0] === info.unreleased[1] ? pad3(info.unreleased[0]) : `${pad3(info.unreleased[0])}–${pad3(info.unreleased[1])}`}, unreleased` : "";
  const release = info.releaseRange ? `release range ${pad3(info.releaseRange[0])}–${pad3(info.releaseRange[1])}${tail}` : "no release range recorded";
  const lines = [
    row("Version", `${info.version} (${release})`),
    row("Commit", info.commit),
    row("Store", `${info.store}${info.tier ? ` · tier ${info.tier}` : ""}`),
    row("Embedding", `${info.embedding.model} @ ${info.embedding.dim}`),
  ];
  const db = info.database;
  if ("error" in db) {
    lines.push(row("Database", `unavailable — ${db.error}`));
    return lines.join("\n");
  }
  const counts = db.counts;
  // A count is null when its table is absent (no entry in unread) or its read did not answer.
  const num = (t: CountedTable) => {
    const n = counts?.[t] ?? null;
    return n !== null ? n.toLocaleString("en-US") : `counts.${t}` in db.unread ? "?" : "no table";
  };
  const tree = `this server's tree ends at ${pad3(info.latestMigration)}`;
  const ledgerUnread = db.unread.ledger;
  const ledger = !db.ledger.present
    ? `no schema_migrations table — ${tree}`
    : !db.ledger.readable
      ? `schema_migrations ${ledgerUnread ? unreadWords(ledgerUnread) : "not read"} — ${tree}`
      : db.highestMigration === null
        ? `the ledger records none — ${tree}`
        // `current` judges the highest number alone — a hole, a renamed or an
        // edited migration is migrate.ts --dry-run's to find (SMD-2069).
        : `${pad3(db.highestMigration)} applied — ${tree}${info.ledgerStatus === "current" ? " (current: the ledger's highest is the tree's last)" : info.ledgerStatus === "behind" ? " (the brain is behind it)" : " (the brain is ahead of it)"}`;
  // ob1_config unread is not ob1_config recording nothing (review pass 1).
  const configUnread = db.unread.ob1_config;
  const notConfig = configUnread ? `? (ob1_config ${unreadWords(configUnread)})` : null;
  const recorded = notConfig ?? (db.embedding.model === null && db.embedding.dim === null
    ? "none recorded"
    : `${db.embedding.model ?? "?"} @ ${db.embedding.dim ?? "?"}`);
  lines.push(
    row("Postgres", `${db.postgres} · pgvector ${db.pgvector ? `${db.pgvector.version} (schema ${db.pgvector.schema})` : "not installed"}`),
    row("Schema version", notConfig ?? db.schemaVersion ?? "none recorded (migration 044 writes it)"),
    row("Migrations", ledger),
    row("Brain embedding", recorded),
  );
  if (counts) {
    lines.push(
      row("Rows", `${num("thoughts")} thoughts · ${num("thought_audit")} audit events · ${num("thought_chunks")} chunks · ${num("ob1_entities")} entities`),
      row("Database size", db.databaseBytes === null ? "?" : formatBytes(db.databaseBytes)),
      row("Board sync", db.boardSync ?? ("boardSync" in db.unread ? "?" : "none — no thought carries a usable Linear watermark")),
    );
  }
  lines.push(row("Workers", workersLine(db)));
  lines.push(row("HNSW", db.hnsw.length === 0 ? "none" : db.hnsw.map((h) => `${h.index} on ${h.table} (m ${h.m}, ef_construction ${h.efConstruction})`).join("; ")));
  const unread = Object.entries(db.unread);
  // A deadline's message is its words; every other reason adds the database's.
  if (unread.length) lines.push(row("Not read", unread.map(([k, u]) => `${k} — ${unreadWords(u)}${u.reason === "deadline" ? "" : `: ${u.message}`}`).join("; ")));
  return lines.join("\n");
}
