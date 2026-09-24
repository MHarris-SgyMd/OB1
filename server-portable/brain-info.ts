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
// No imports: the Workers build bundles this (index.ts imports it), and the SQL
// client is taken structurally rather than from "bun".

/** A tagged-template SQL client — Bun's `SQL`, structurally. */
export type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any[]>;

/** A client that can also open a transaction — Bun's `SQL`, or the pool the SQL store holds. */
export type SqlClient = SqlTag & { begin<T>(fn: (tx: SqlTag) => Promise<T>): Promise<T> };

/**
 * How long one read may run, and wait for a lock, before it is recorded as
 * unread (review pass 1: a migration holding ACCESS EXCLUSIVE on thought_audit
 * left count(*) waiting, and a keyed /health probe got no reply at all). Local
 * to each read's own transaction, so the pool's connections keep their defaults.
 */
export const READ_STATEMENT_TIMEOUT_MS = 2_000;
export const READ_LOCK_TIMEOUT_MS = 1_000;

/** The tables whose row counts the record carries. */
export const COUNTED_TABLES = ["thoughts", "thought_audit", "thought_chunks", "ob1_entities"] as const;
export type CountedTable = (typeof COUNTED_TABLES)[number];

export interface HnswIndex {
  index: string;
  table: string;
  /** pgvector's build parameters; its defaults (16, 64) when the index was built WITH none. */
  m: number;
  efConstruction: number;
}

/**
 * What the database says about itself. A field is null for one of two reasons,
 * told apart by `unread`: the thing is absent (no pgvector, no schema_version
 * recorded, no such table — no entry), or the read failed (a role without
 * SELECT, say — an entry naming the field and the error). Each read is its own
 * statement, so one refused read leaves the others standing.
 */
export interface DatabaseFacts {
  /** `server_version`, e.g. "16.4 (Debian 16.4-1.pgdg120+2)" — the one read that is not guarded. */
  postgres: string;
  /** The installed pgvector and the schema it lives in; null when not installed. */
  pgvector: { version: string; schema: string } | null;
  /** ob1_config.schema_version (044, SMD-1804); null when none is recorded. */
  schemaVersion: string | null;
  /** The embedding contract the brain records (006); null fields when unrecorded. */
  embedding: { model: string | null; dim: number | null };
  /**
   * The migration ledger. `present` is whether schema_migrations is visible to
   * this role at all; `names` every recorded name, or null when it is present
   * and this role cannot read it (preflight's remedies say so apart from a
   * ledger that does not record a migration).
   */
  ledger: { present: boolean; names: string[] | null };
  /** The highest three-digit prefix the ledger records; null when it records none or cannot be read. */
  highestMigration: number | null;
  counts: Record<CountedTable, number | null>;
  /** pg_database_size(current_database()), in bytes. */
  databaseBytes: number | null;
  /** Every HNSW index on a table on this connection's search_path. */
  hnsw: HnswIndex[] | null;
  /** Field → why its read failed. Empty when every read answered. */
  unread: Record<string, string>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];

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
 * preflight's own client. Raises only when the first statement does (the
 * connection itself failed); every later read runs in its own transaction under
 * READ_STATEMENT_TIMEOUT_MS and READ_LOCK_TIMEOUT_MS, and one that fails or
 * runs out of time is recorded in `unread` while the rest go on.
 */
export async function readDatabaseFacts(client: SqlClient): Promise<DatabaseFacts> {
  const unread: Record<string, string> = {};
  const attempt = async <T>(field: string, read: (sql: SqlTag) => Promise<T>, absent: T): Promise<T> => {
    try {
      return await client.begin(async (sql) => {
        await sql`SELECT set_config('statement_timeout', ${String(READ_STATEMENT_TIMEOUT_MS)}, true),
                         set_config('lock_timeout', ${String(READ_LOCK_TIMEOUT_MS)}, true)`;
        return read(sql);
      });
    } catch (e) {
      unread[field] = message(e);
      return absent;
    }
  };

  // Not guarded: a connection that fails fails here, and the caller names it.
  const [{ v: postgres }] = await client`SELECT current_setting('server_version') AS v`;

  const databaseBytes = await attempt("databaseBytes", async (sql) => {
    const [{ n }] = await sql`SELECT pg_database_size(current_database())::float8 AS n`;
    return Number(n);
  }, null);

  const pgvector = await attempt("pgvector", async (sql) => {
    const rows = await sql`
      SELECT e.extversion::text AS version, n.nspname::text AS schema
        FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
       WHERE e.extname = 'vector'`;
    return rows.length ? { version: String(rows[0].version), schema: String(rows[0].schema) } : null;
  }, null);

  // Which tables resolve on this connection's search path. to_regclass needs no
  // privilege on the table, so a role that may not read one still sees it —
  // the ledger included (review pass 1: information_schema.tables lists only
  // the tables a role holds some privilege on, so the documented server role
  // was told its brain had no ledger, and it matched a schema_migrations in
  // any schema). If this read itself fails, every table is tried, and each
  // read records its own error rather than passing for absent.
  const everything = { config: true, schema_migrations: true, thoughts: true, thought_audit: true, thought_chunks: true, ob1_entities: true };
  const has: Record<string, boolean> = await attempt("tables", async (sql) => (await sql`
    SELECT to_regclass('ob1_config') IS NOT NULL AS config,
           to_regclass('schema_migrations') IS NOT NULL AS schema_migrations,
           to_regclass('thoughts') IS NOT NULL AS thoughts,
           to_regclass('thought_audit') IS NOT NULL AS thought_audit,
           to_regclass('thought_chunks') IS NOT NULL AS thought_chunks,
           to_regclass('ob1_entities') IS NOT NULL AS ob1_entities`)[0], everything);

  const config = has.config
    ? await attempt("ob1_config", async (sql) => {
        const rows = await sql`SELECT key, value FROM ob1_config WHERE key IN ('schema_version', 'embedding_model', 'embedding_dim')`;
        return Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value])) as Record<string, string>;
      }, {} as Record<string, string>)
    : {};
  const dim = config.embedding_dim === undefined ? null : Number(config.embedding_dim);

  // The ledger: present on the path, then readable — a role without SELECT on
  // it is `names: null`, not an empty ledger.
  let names: string[] | null = [];
  if (has.schema_migrations) {
    names = await attempt("ledger", async (sql) => {
      const rows = await sql`SELECT name FROM schema_migrations`;
      return rows.map((r: { name: string }) => String(r.name));
    }, null);
  }
  const numbers = (names ?? []).map((n) => Number(n.slice(0, 3))).filter((n) => !Number.isNaN(n));

  const counts = {} as Record<CountedTable, number | null>;
  for (const t of COUNTED_TABLES) {
    counts[t] = has[t]
      ? await attempt(`counts.${t}`, async (sql) => Number((await COUNT_SQL[t](sql))[0].n), null)
      : null;
  }

  const hnsw = await attempt("hnsw", async (sql) => {
    const rows = await sql`
      SELECT c.relname::text AS index, t.relname::text AS "table", array_to_string(c.reloptions, ',') AS opts
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_am a ON a.oid = c.relam
       WHERE a.amname = 'hnsw' AND pg_table_is_visible(t.oid)
       ORDER BY t.relname, c.relname`;
    return rows.map((r: { index: string; table: string; opts: string | null }) => ({ index: r.index, table: r.table, ...parseHnswOptions(r.opts) }));
  }, null);

  return {
    postgres: String(postgres),
    pgvector,
    schemaVersion: config.schema_version ?? null,
    embedding: { model: config.embedding_model ?? null, dim: dim === null || Number.isNaN(dim) ? null : dim },
    ledger: { present: has.schema_migrations, names },
    highestMigration: numbers.length ? Math.max(...numbers) : null,
    counts,
    databaseBytes,
    hnsw,
    unread,
  };
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
  /** The database's facts, or why they could not be had. */
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
 * within `deadlineMs` whatever the database does: a database that cannot
 * answer in time, or at all, is `database.error` (review pass 1: an
 * unreachable address waited out the driver's 30-second connect, and the
 * runtime closed the probe's socket first).
 */
export async function brainInfo(server: ServerFacts, readDatabase: () => Promise<DatabaseFacts>, deadlineMs: number): Promise<BrainInfo> {
  let database: BrainInfo["database"];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the database gave no answer within ${deadlineMs} ms`)), deadlineMs);
    });
    const { ledger, ...rest } = await Promise.race([readDatabase(), late]);
    database = { ...rest, ledger: { present: ledger.present, readable: ledger.present && ledger.names !== null } };
  } catch (e) {
    database = { error: message(e) };
  } finally {
    clearTimeout(timer);
  }
  return { ...server, database, ledgerStatus: ledgerStatus("error" in database ? null : database.highestMigration, server.latestMigration) };
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
  // A count is null when its table is absent (no entry in unread) or its read failed.
  const num = (t: CountedTable) => {
    const n = db.counts[t];
    return n === null ? (db.unread[`counts.${t}`] ? "?" : "no table") : n.toLocaleString("en-US");
  };
  const tree = `this server's tree ends at ${pad3(info.latestMigration)}`;
  const ledger = !db.ledger.present
    ? `no schema_migrations table — ${tree}`
    : !db.ledger.readable
      ? `schema_migrations not readable by this role — ${tree}`
      : db.highestMigration === null
        ? `the ledger records none — ${tree}`
        : `${pad3(db.highestMigration)} applied — ${tree}${info.ledgerStatus === "current" ? " (current)" : info.ledgerStatus === "behind" ? " (the brain is behind it)" : " (the brain is ahead of it)"}`;
  // ob1_config unread is not ob1_config recording nothing (review pass 1).
  const configUnread = db.unread.ob1_config !== undefined;
  const recorded = configUnread
    ? "? (ob1_config not read)"
    : db.embedding.model === null && db.embedding.dim === null
      ? "none recorded"
      : `${db.embedding.model ?? "?"} @ ${db.embedding.dim ?? "?"}`;
  lines.push(
    row("Postgres", `${db.postgres} · pgvector ${db.pgvector ? `${db.pgvector.version} (schema ${db.pgvector.schema})` : "not installed"}`),
    row("Schema version", configUnread ? "? (ob1_config not read)" : db.schemaVersion ?? "none recorded (migration 044 writes it)"),
    row("Migrations", ledger),
    row("Brain embedding", recorded),
    row("Rows", `${num("thoughts")} thoughts · ${num("thought_audit")} audit · ${num("thought_chunks")} chunks · ${num("ob1_entities")} entities`),
    row("Database size", db.databaseBytes === null ? "?" : formatBytes(db.databaseBytes)),
    row("HNSW", db.hnsw === null ? "?" : db.hnsw.length === 0 ? "none" : db.hnsw.map((h) => `${h.index} on ${h.table} (m ${h.m}, ef_construction ${h.efConstruction})`).join("; ")),
  );
  const unread = Object.entries(db.unread);
  if (unread.length) lines.push(row("Not read", unread.map(([k, v]) => `${k} — ${v}`).join("; ")));
  return lines.join("\n");
}
