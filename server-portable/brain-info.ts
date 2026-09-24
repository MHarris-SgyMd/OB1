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
// The read's shape (review pass 2, which found pass 1's per-read transactions
// adding their budgets past one deadline and losing every fact at it): ONE
// transaction on one connection; the catalog facts in one statement; each read
// that a role or a lock can refuse in a savepoint of its own; the timeouts set
// once, never raised above what the role already has; and the facts written
// into a progress record as they arrive, so a caller's deadline keeps what was
// read and names the rest.
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
  /** Every HNSW index on a table on this connection's search_path. */
  hnsw: HnswIndex[];
  /** Field → why its read did not answer. Empty when every read answered. */
  unread: Record<string, Unread>;
}

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
             jsonb_build_object(
               'ob1_config', to_regclass('ob1_config') IS NOT NULL,
               'schema_migrations', to_regclass('schema_migrations') IS NOT NULL,
               'thoughts', to_regclass('thoughts') IS NOT NULL,
               'thought_audit', to_regclass('thought_audit') IS NOT NULL,
               'thought_chunks', to_regclass('thought_chunks') IS NOT NULL,
               'ob1_entities', to_regclass('ob1_entities') IS NOT NULL) AS resolved,
             (SELECT COALESCE(jsonb_object_agg(relname, schemas), '{}'::jsonb) FROM (
                SELECT c.relname::text AS relname, string_agg(n.nspname::text, ', ' ORDER BY n.nspname) AS schemas
                  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.relkind IN ('r', 'p')
                   AND c.relname IN ('ob1_config', 'schema_migrations', 'thoughts', 'thought_audit', 'thought_chunks', 'ob1_entities')
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
      hnsw: (cat.hnsw as { index: string; table: string; opts: string | null }[]).map((h) => ({ index: h.index, table: h.table, ...parseHnswOptions(h.opts) })),
      unread: {},
    };
    progress.facts = facts;

    // The guarded reads, in order. Each names the table it needs; a table that
    // does not resolve is not queried — absent, or `invisible` when pg_class
    // has it where this role cannot reach.
    type Guarded = { field: string; table?: KnownTable; read: (sp: SqlTag) => Promise<void> };
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
      },
      ...(stats
        ? [
            ...COUNTED_TABLES.map((t): Guarded => ({ field: `counts.${t}`, table: t, read: async (sp) => { facts.counts![t] = Number((await COUNT_SQL[t](sp))[0].n); } })),
            { field: "databaseBytes", read: async (sp: SqlTag) => { facts.databaseBytes = Number((await sp`SELECT pg_database_size(current_database())::float8 AS n`)[0].n); } },
          ]
        : []),
    ];
    for (const g of guarded) progress.pending.add(g.field);

    for (const g of guarded) {
      if (progress.abandoned) break; // snapshotFacts names what is still pending
      if (g.table && !resolved[g.table]) {
        if (g.table in anywhere) facts.unread[g.field] = { reason: "invisible", message: `${g.table} exists (schema ${anywhere[g.table]}) but does not resolve for this role — not on its search_path, or no USAGE on that schema` };
        if (g.field === "ledger") facts.ledger.names = g.table in anywhere ? null : [];
        progress.pending.delete(g.field);
        continue;
      }
      try {
        await tx.savepoint(g.read);
      } catch (e) {
        facts.unread[g.field] = { reason: unreadReason(e), message: message(e) };
        if (g.field === "ledger") facts.ledger.names = null;
      }
      progress.pending.delete(g.field);
    }
    if (progress.abandoned) markAbandoned(progress);
    return facts;
  });
}

/** Every read the progress still has pending, named as the deadline's. */
function markAbandoned(progress: ReadProgress): void {
  if (!progress.facts) return;
  for (const field of progress.pending) {
    progress.facts.unread[field] = { reason: "deadline", message: "not read before the deadline" };
    if (field === "ledger") progress.facts.ledger.names = null;
  }
  progress.pending.clear();
}

/**
 * The facts a read has reached, as its caller's deadline finds them — a copy,
 * since the read may still be finishing its last statement. Null when the
 * catalog statement has not answered: nothing is known about the database.
 */
export function snapshotFacts(progress: ReadProgress): DatabaseFacts | null {
  progress.abandoned = true;
  markAbandoned(progress);
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
    facts = null;
    failure = message(e);
  } finally {
    clearTimeout(timer);
  }
  if (!facts) return { ...server, database: { error: failure }, ledgerStatus: null };
  const { ledger, ...rest } = facts;
  const database: DatabaseSummary = { ...rest, ledger: { present: ledger.present, readable: ledger.present && ledger.names !== null } };
  return { ...server, database, ledgerStatus: ledgerStatus(facts.highestMigration, server.latestMigration) };
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

/** The record as the tool's short table: one fact per line, a label and a value. */
export function renderBrainInfo(info: BrainInfo): string {
  const row = (label: string, value: string) => `${`${label}:`.padEnd(16)} ${value}`;
  const release = info.releaseRange ? `release range ${pad3(info.releaseRange[0])}–${pad3(info.releaseRange[1])}` : "no release range recorded";
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
        : `${pad3(db.highestMigration)} applied — ${tree}${info.ledgerStatus === "current" ? " (current)" : info.ledgerStatus === "behind" ? " (the brain is behind it)" : " (the brain is ahead of it)"}`;
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
      row("Rows", `${num("thoughts")} thoughts · ${num("thought_audit")} audit · ${num("thought_chunks")} chunks · ${num("ob1_entities")} entities`),
      row("Database size", db.databaseBytes === null ? "?" : formatBytes(db.databaseBytes)),
    );
  }
  lines.push(row("HNSW", db.hnsw.length === 0 ? "none" : db.hnsw.map((h) => `${h.index} on ${h.table} (m ${h.m}, ef_construction ${h.efConstruction})`).join("; ")));
  const unread = Object.entries(db.unread);
  if (unread.length) lines.push(row("Not read", unread.map(([k, u]) => `${k} — ${unreadWords(u)}: ${u.message}`).join("; ")));
  return lines.join("\n");
}
