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

/** The tables the read asks after: the counted ones, the config, the ledger, where consolidation's findings stand (SMD-2680) and what became of those posted to the board (SMD-2682). */
const KNOWN_TABLES = ["ob1_config", "schema_migrations", ...COUNTED_TABLES, "supersession_proposals", "thought_facets", "board_findings_posted"] as const;
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
  /**
   * The supersession-proposal queue (029, SMD-2680): what consolidation found
   * that waits on a reviewer. `pending` and `stale` by status; the oldest
   * pending row's verdict's age in seconds, by the database's clock (null when
   * none is pending) — since it was judged, which a pass re-judging a stale
   * row restarts, not since a reviewer first could see the pair; and how many
   * pending rows pair two tickets the board does not link (see the comment
   * above PROPOSALS_SQL; its own read, `proposals.boardPairs` in `unread` when
   * it did not answer, and null without an entry before 079). Null when the
   * table is absent or not read (`unread` names it). Not a stats read:
   * preflight's proposals row reads it.
   */
  proposals: ProposalQueue | null;
  /**
   * The judged relations standing (084, SMD-2680): `relation` facets with no
   * valid_until, by word, and how many pair two tickets the board does not
   * link, as `proposals` counts them. Nothing waits on them, so no row warns.
   * Null when not read or not asked (`stats: false`); zero on a brain without
   * 084, which holds none.
   */
  relations: StandingRelations | null;
  /**
   * What became of the findings db/board-findings.ts posted to the board
   * (087, SMD-2682): each (ticket pair, word) this brain posted, as accepted,
   * rejected, withdrawn, open or unanswered (see findingOutcome), and the
   * rows another poster's marker settled (`found`), apart. The acceptance
   * rate SMD-2682 is done on is accepted over accepted, rejected and
   * unanswered. Null when the table is absent (no `unread` entry: before 087),
   * not read (`unread` names it) or not asked (`stats: false`).
   */
  findings: BoardFindings | null;
  /** Every HNSW index on a table on this connection's search_path. */
  hnsw: HnswIndex[];
  /** Field → why its read did not answer. Empty when every read answered. */
  unread: Record<string, Unread>;
}

/** One long-running worker's heartbeat as the record carries it (SMD-2261). */
export interface WorkerHeartbeat {
  /** The ob1_config row's key — what retiring the worker deletes. */
  key: string;
  worker: "board-sync" | "extract" | "consolidate" | "sleep";
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
  /** The sleep scheduler's current or last sleep: its start and, once over, its end, UTC instants (SMD-2678); absent for the other workers, and for a sleep row with none or not of the shape. */
  slept?: { from: string; to: string | null };
  /** Whether the sleep scheduler's role reads query_log, as its start found (SMD-2678); absent for the other workers and an older scheduler. */
  reads?: "yes" | "denied" | "missing";
  /** The sleep scheduler's passes waiting at their start for a provider that does not answer (SMD-2752); absent while none is, and for the other workers. */
  waiting?: ("extract" | "consolidate")[];
  /** The start refusal that ended the sleep scheduler, one of db/worker-bootstrap.ts's START_REFUSALS (SMD-2752); absent otherwise, and for the other workers. */
  refused?: SleepRefusal;
  /**
   * The thoughts extraction holds back across the sleep scheduler's wakes —
   * pending or in flight with a hard stop counted on them (migration 093,
   * SMD-2694): how many, and up to three, the most stalled first, each with
   * its stops, the latest of them in a row that gained no window, and its
   * windows kept of how many. Absent while none is, and for the other workers.
   */
  held?: SleepHeld;
}

/** A thought the sleep scheduler's wakes hold back (WorkerHeartbeat.held). */
export type HeldThought = { id: string; stops: number; stalled: number; kept: number; windows: number | null };
export type SleepHeld = { total: number; thoughts: HeldThought[] };

/**
 * The long hard stops in a row with no window saved between, and none since,
 * after which the sleep scheduler lets consolidation join past a thought
 * extraction still holds (db/sleep.ts, SMD-2694): a window that outlasts
 * every sleep, or stops landing past its last. Here, as preflight's `sleep`
 * row names such a thought by the same number.
 */
export const SLEEP_STALLED_JOIN = 3;
/** The most held thoughts the scheduler's row names. */
export const SLEEP_HELD_NAMED = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A held thought in words, the scheduler's and preflight's: "<id>, 7 of 24 window(s) kept over 3 stop(s), the last 2 with none gained". */
export function heldWords(t: HeldThought): string {
  const kept = t.kept ? `${t.kept}${t.windows ? ` of ${t.windows}` : ""} window(s) kept` : "no window kept";
  return `${t.id}, ${kept} over ${t.stops} stop(s)${t.stalled ? `, the last ${t.stalled} with none gained` : ""}`;
}

/** A `held` value as db/sleep.ts writes it, or undefined: every thought of the shape, at most SLEEP_HELD_NAMED and no more than the total. */
function parseHeld(h: unknown): SleepHeld | undefined {
  if (h === null || typeof h !== "object") return undefined;
  const { total, thoughts } = h as { total?: unknown; thoughts?: unknown };
  if (!count(total) || (total as number) < 1 || !Array.isArray(thoughts) || thoughts.length < 1 || thoughts.length > Math.min(SLEEP_HELD_NAMED, total as number)) return undefined;
  const out: HeldThought[] = [];
  for (const t of thoughts as Record<string, unknown>[]) {
    if (t === null || typeof t !== "object" || typeof t.id !== "string" || !UUID.test(t.id)) return undefined;
    if (!count(t.stops) || (t.stops as number) < 1 || !count(t.stalled, t.stops as number) || !count(t.kept)) return undefined;
    if (!(t.windows === null || (count(t.windows) && (t.windows as number) > 1 && (t.kept as number) <= (t.windows as number)))) return undefined;
    out.push({ id: t.id, stops: t.stops as number, stalled: t.stalled as number, kept: t.kept as number, windows: t.windows as number | null });
  }
  return { total: total as number, thoughts: out };
}

/**
 * db/worker-bootstrap.ts's START_REFUSALS, which a sleep row's `refused`
 * must be one of: kept here, as server-portable reads no db/ module, and
 * held equal to it by test-live [38].
 */
export const SLEEP_REFUSALS = ["usage", "egress", "tables", "model", "provider", "identity", "key", "lookup"] as const;
export type SleepRefusal = (typeof SLEEP_REFUSALS)[number];

/** A heartbeat older than this many of its own intervals is stale. */
export const STALE_AFTER_INTERVALS = 3;

const HEARTBEAT_KEY = /^heartbeat:(board-sync|extract|consolidate|sleep)(?::([A-Za-z0-9._:@/+-]{1,120}))?$/;
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
 * counts, the enums as written, the database's own instant, and the sleep
 * scheduler's held thought ids, each held to a uuid (parseHeld; read-scoped
 * as brain_info is, as list_thought_ids is). Anything else is counted in
 * `ignored`, and its text goes nowhere.
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
    const jobOk = worker === "board-sync" || worker === "sleep"
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
    // The scheduler's mark of its sleep (SMD-2678): left off when not of the
    // shape, as a malformed block is — the row still says whether it is alive.
    const s = worker === "sleep" ? (v!.slept as Record<string, unknown> | undefined) : undefined;
    const slept = s !== null && typeof s === "object" && typeof s.from === "string" && UTC_INSTANT.test(s.from) && (s.to === null || (typeof s.to === "string" && UTC_INSTANT.test(s.to)))
      ? { from: s.from, to: s.to as string | null }
      : undefined;
    const reads = worker === "sleep" && (v!.reads === "yes" || v!.reads === "denied" || v!.reads === "missing") ? v!.reads : undefined;
    // Its waiting passes and its refusal (SMD-2752), each left off when not
    // of the shape: the passes by name, each once; the refusal of the list.
    const w = worker === "sleep" ? v!.waiting : undefined;
    const waiting = Array.isArray(w) && w.length > 0 && new Set(w).size === w.length && w.every((p) => p === "extract" || p === "consolidate")
      ? (w as ("extract" | "consolidate")[])
      : undefined;
    const refused = worker === "sleep" && typeof v!.refused === "string" && (SLEEP_REFUSALS as readonly string[]).includes(v!.refused) ? (v!.refused as SleepRefusal) : undefined;
    // The thoughts its wakes hold back (SMD-2694), left off when not of the shape.
    const held = worker === "sleep" ? parseHeld(v!.held) : undefined;
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
      ...(slept ? { slept } : {}),
      ...(reads ? { reads } : {}),
      ...(waiting ? { waiting } : {}),
      ...(refused ? { refused } : {}),
      ...(held ? { held } : {}),
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

/** The proposal queue as the record carries it (SMD-2680). */
export interface ProposalQueue {
  pending: number;
  stale: number;
  oldestPendingS: number | null;
  /** Board pairs (the comment above PROPOSALS_SQL): 0 when there is nothing to count; null before 079, when its own read did not answer (`unread` names it), or when this field was not read. */
  boardPairs: number | null;
}

/** The standing judged relations as the record carries them (SMD-2680). */
export interface StandingRelations {
  related: number;
  evolves: number;
  duplicate: number;
  /** Board pairs (the comment above PROPOSALS_SQL): 0 when there is nothing to count; null before 079, when its own read did not answer (`unread` names it), or when this field was not read. */
  boardPairs: number | null;
}

// A board pair, in the two board-count reads below: the two thoughts are
// filed under two different tickets — coalesce(metadata->>'ticket',
// metadata->>'issue'), the identity node_state and 079 read, so a Linear
// section row (`ticket`) counts as its ticket's — and the board relates them
// in no way, now: 079's consolidation_tickets_linked (child_of, blocks,
// blocked_by, relates_to) says no, and no active Linear duplicate_of joins
// them either way. 079 leaves
// duplicate_of out on purpose, for the judge — a duplicate pair stays a
// candidate — but a pair Linear marks duplicate is linked as far as a reader
// of this count is concerned (review pass 2). A link made after a verdict does
// not move its row (only a text move makes one stale, 063), so the link is
// read here, not assumed. Before 079 the count is not taken (null): the rule
// it applies is not there.
//
// The board pairs are reads of their own, after the rest (review pass 2):
// 079's predicate is 0.1–0.2 ms a call where it looks a link up (079's note)
// and more on a ticket many links point at; measured, one statement passed the
// health cap at about 45k pending rows — and a timeout then takes the board
// count alone, not the queue beside it.

/** The queue: the pending and stale rows. */
const PROPOSALS_SQL = (sql: SqlTag) => sql`
  SELECT count(*) FILTER (WHERE p.status = 'pending')::int AS pending,
         count(*) FILTER (WHERE p.status = 'stale')::int AS stale,
         extract(epoch FROM now() - min(p.judged_at) FILTER (WHERE p.status = 'pending'))::float8 AS oldest_s
    FROM supersession_proposals p
   WHERE p.status IN ('pending', 'stale')`;

/** The pending rows that pair two tickets the board does not link. */
const PROPOSALS_BOARD_SQL = (sql: SqlTag) => sql`
  SELECT count(*) FILTER (WHERE x.ka <> x.kb
                            AND NOT consolidation_tickets_linked(x.am, x.bm)
                            AND NOT EXISTS (SELECT 1 FROM thought_facets d JOIN thoughts dh ON dh.id = d.thought_id
                                             WHERE d.kind = 'link' AND d.valid_until IS NULL AND d.payload->>'system' = 'linear' AND d.payload->>'relation' = 'duplicate_of'
                                               AND (coalesce(dh.metadata->>'ticket', dh.metadata->>'issue'), d.payload->>'target') IN ((x.ka, x.kb), (x.kb, x.ka))))::int AS n
    FROM (SELECT o.metadata AS am, n.metadata AS bm,
                 coalesce(o.metadata->>'ticket', o.metadata->>'issue') AS ka, coalesce(n.metadata->>'ticket', n.metadata->>'issue') AS kb
            FROM supersession_proposals p
            JOIN thoughts o ON o.id = p.older_id
            JOIN thoughts n ON n.id = p.newer_id
           WHERE p.status = 'pending') x`;

/** The standing relations by word. */
const RELATIONS_SQL = (sql: SqlTag) => sql`
  SELECT count(*) FILTER (WHERE f.payload->>'relation' = 'related')::int AS related,
         count(*) FILTER (WHERE f.payload->>'relation' = 'evolves')::int AS evolves,
         count(*) FILTER (WHERE f.payload->>'relation' = 'duplicate')::int AS duplicate
    FROM thought_facets f
   WHERE f.kind = 'relation' AND f.valid_until IS NULL`;

/**
 * The standing relations that pair two tickets the board does not link. The
 * target is cast only on a relation row, whose target 084's trigger checked is
 * a thought's id — a link facet's target is an identity such as SMD-12. A
 * standing relation's target exists: 084 closes a relation when its target is
 * deleted.
 */
const RELATIONS_BOARD_SQL = (sql: SqlTag) => sql`
  SELECT count(*) FILTER (WHERE x.ka <> x.kb
                            AND NOT consolidation_tickets_linked(x.am, x.bm)
                            AND NOT EXISTS (SELECT 1 FROM thought_facets d JOIN thoughts dh ON dh.id = d.thought_id
                                             WHERE d.kind = 'link' AND d.valid_until IS NULL AND d.payload->>'system' = 'linear' AND d.payload->>'relation' = 'duplicate_of'
                                               AND (coalesce(dh.metadata->>'ticket', dh.metadata->>'issue'), d.payload->>'target') IN ((x.ka, x.kb), (x.kb, x.ka))))::int AS n
    FROM (SELECT h.metadata AS am, t.metadata AS bm,
                 coalesce(h.metadata->>'ticket', h.metadata->>'issue') AS ka, coalesce(t.metadata->>'ticket', t.metadata->>'issue') AS kb
            FROM thought_facets f
            JOIN thoughts h ON h.id = f.thought_id
            JOIN thoughts t ON t.id = CASE WHEN f.kind = 'relation' THEN (f.payload->>'target')::uuid END
           WHERE f.kind = 'relation' AND f.valid_until IS NULL) x`;

/**
 * What a refusal names: `permission denied for table X` or `for function X`,
 * as Postgres words it (a table unqualified), or null for another message.
 * The table row and preflight's remedy name what was refused (review pass 2).
 */
export function deniedObject(message: string): { kind: "table" | "function"; name: string } | null {
  const m = /permission denied for (table|function) (\w+)/i.exec(message);
  return m ? { kind: m[1].toLowerCase() as "table" | "function", name: m[2] } : null;
}

/** A count the record may carry: a safe integer at least 0, or a read that did not answer. */
function countOf(field: string, n: unknown): number {
  const v = typeof n === "string" ? Number(n) : n;
  if (!count(v)) throw new Error(`the ${field} read answered ${typeof n === "number" || typeof n === "string" ? "a value that is not a count" : typeof n}`);
  return v;
}

/** The queue as the record carries it: counts, and a whole number of seconds for the oldest pending row. */
export function proposalsValue(row: { pending?: unknown; stale?: unknown; oldest_s?: unknown } | undefined): ProposalQueue {
  if (!row) throw new Error("the proposals read answered no row");
  const pending = countOf("proposals", row.pending);
  const age = row.oldest_s == null ? null : Number(row.oldest_s);
  if (age !== null && !Number.isFinite(age)) throw new Error("the proposals read answered an age that is not a number");
  // judged_at defaults to now(); a clock moved back can leave it ahead of the read's.
  // The board pairs are their own read's (boardPairsValue), filled in after.
  return { pending, stale: countOf("proposals", row.stale), oldestPendingS: pending === 0 || age === null ? null : Math.max(0, Math.round(age)), boardPairs: null };
}

/** The standing relations as the record carries them. */
export function relationsValue(row: { related?: unknown; evolves?: unknown; duplicate?: unknown } | undefined): StandingRelations {
  if (!row) throw new Error("the relations read answered no row");
  return { related: countOf("relations", row.related), evolves: countOf("relations", row.evolves), duplicate: countOf("relations", row.duplicate), boardPairs: null };
}

/** A board-pair read's answer: a count, or a read that did not answer. */
export function boardPairsValue(field: string, row: { n?: unknown } | undefined): number {
  return countOf(field, row?.n);
}

// ── What became of a finding posted to the board (SMD-2682) ─────────────────
//
// db/board-findings.ts posts a consolidation finding between two tickets the
// board does not link as one Linear comment, and records each (ticket pair,
// word) in board_findings_posted (087, SMD-2681). Whether those comments were
// worth a maintainer's attention is read from what the brain already holds,
// never asked of Linear:
//
//   * the board linked the pair since — an active Linear link either way,
//     079's set (child_of, blocks, blocked_by, relates_to) or duplicate_of,
//     the rule the finding was posted under, read now. A pair is posted only
//     unlinked as the brain knows it; a link Linear made without moving either
//     ticket's updatedAt reaches the brain at board-sync's next --full pass,
//     after the post, and counts as an answer then — the brain cannot tell it
//     from one made after the comment;
//   * an outdates finding's proposals (029) were accepted or rejected, or
//     when the pass first settled them since the judge last asserted them
//     (091's record, kept across 067's reopen);
//   * a relation finding's facet (084) still stands, re-judged or not, at
//     the same word, or when the judge stopped saying it.
//
// db/board-findings.ts --report prints the same rows one by one, from this
// read and findingOutcome, so the CLI and brain_info cannot disagree.

/** An open finding posted longer ago than this is unanswered: the tracker's "a month" (SMD-2682). */
export const UNANSWERED_AFTER_DAYS = 30;

/** One posted (pair, word) as the read answers it. */
export interface FindingRow {
  a: string;
  b: string;
  word: "outdates" | "related" | "evolves" | "duplicate";
  /** The ticket the comment is on. */
  postedOn: string;
  origin: "posted" | "found";
  /** When it was recorded, a UTC instant. */
  postedAt: string;
  /** Seconds since, by the database's clock. */
  ageS: number;
  /** While a link between the pair is active: seconds from posting to the first link made since, closed ones included (0 when none was made since); null when none is active. */
  linkedS: number | null;
  /**
   * An outdates finding's proposals among those it named and still present, by
   * state — accepted; rejected by a person; settled by the pass (067); reopened,
   * stale again after a settle since the judge last asserted it (091); stale,
   * waiting on its re-judge; pending — and when the first acceptance and the
   * last rejection were made; null for a relation.
   */
  proposals: { accepted: number; rejected: number; settled: number; reopened: number; stale: number; pending: number; acceptedS: number | null; rejectedS: number | null } | null;
  /** A relation finding: whether a relation of its word still stands where a facet it named stood; null for outdates. */
  stands: boolean | null;
  /**
   * Seconds from posting to when the judge took the finding back: for
   * outdates, when the pass had settled every proposal it named that is still
   * present, each by its first settle since the judge last asserted it (091's
   * record — a reopen by a text move does not clear it, a re-judge finding the
   * conflict again does); for a relation no longer standing, the close of the
   * last relation of its word there. Null when not taken back, or when no time
   * is left (every proposal gone, or the relation's facets gone with a thought).
   * Negative when the pass settled it between the finding being chosen and its
   * comment being posted.
   */
  withdrawnS: number | null;
}

export type FindingOutcome = "accepted" | "rejected" | "withdrawn" | "open" | "unanswered";

/** What became of one posted finding, how it was answered, and how long after posting. */
export interface FindingVerdict {
  outcome: FindingOutcome;
  /** accepted or rejected through a proposal's review, or accepted by a link on the board; null otherwise. */
  how: "proposal" | "linked" | null;
  answeredS: number | null;
}

/** What became of the findings this brain posted, as the record carries them. */
export interface BoardFindings {
  /** (pair, word) rows this brain posted, and the comments they were posted in. */
  posted: number;
  comments: number;
  /** Rows a marker already on the board settled (another poster's): not this brain's, and not in the rest. */
  found: number;
  accepted: number;
  rejected: number;
  withdrawn: number;
  open: number;
  unanswered: number;
  /** The window past which an open finding is unanswered. */
  windowDays: number;
  /** The median seconds from posting to an acceptance or a rejection; null when none was answered. */
  medianAnswerS: number | null;
}

/** Every recorded (pair, word), newest first, with what the brain holds of its answer. */
export const FINDING_OUTCOMES_SQL = (sql: SqlTag) => sql`
  SELECT b.ticket_a, b.ticket_b, b.word, b.posted_on, b.origin, b.posted_at,
         extract(epoch FROM now() - b.posted_at)::float8 AS age_s,
         CASE WHEN l.linked_now THEN extract(epoch FROM coalesce(l.first_after, b.posted_at) - b.posted_at)::float8 END AS linked_s,
         p.accepted, p.rejected, p.settled, p.reopened, p.stale, p.pending,
         extract(epoch FROM p.accepted_at - b.posted_at)::float8 AS accepted_s,
         extract(epoch FROM p.rejected_at - b.posted_at)::float8 AS rejected_s,
         extract(epoch FROM coalesce(p.withdrawn_at, r.gone_at) - b.posted_at)::float8 AS withdrawn_s,
         r.stands
    FROM board_findings_posted b
    -- The link's target probes 053's target index; its holder is the other
    -- ticket's row. Linked is an active link now; answered is when the first
    -- link since the post was made, closed ones included — a ticket head that
    -- moves closes its links and the new head records them afresh (053), which
    -- is no later answer. A link brought in after the post that Linear made
    -- before it (board-sync's --full pass) cannot be told apart: it counts.
    LEFT JOIN LATERAL (
      SELECT bool_or(f.valid_until IS NULL) AS linked_now,
             min(f.created_at) FILTER (WHERE f.created_at >= b.posted_at) AS first_after
        FROM thought_facets f
        JOIN thoughts h ON h.id = f.thought_id
       WHERE f.kind = 'link' AND f.payload->>'system' = 'linear'
         AND f.payload->>'relation' IN ('child_of', 'blocks', 'blocked_by', 'relates_to', 'duplicate_of')
         AND f.payload->>'target' IN (b.ticket_a, b.ticket_b)
         AND coalesce(h.metadata->>'ticket', h.metadata->>'issue') = CASE WHEN f.payload->>'target' = b.ticket_a THEN b.ticket_b ELSE b.ticket_a END) l ON true
    -- A rejection whose note carries 067's marker is the pass's own settle (a
    -- re-judge found no conflict, or the two tickets linked), not a person's
    -- no: counted apart (review pass 2). The literal is PASS_SETTLED_PREFIX
    -- (consolidate.ts), which this file may not import; test-board-findings
    -- holds the two equal.
    -- Taken back is when the pass had settled every proposal still present
    -- since the judge last asserted it — each by its first settle in 091's
    -- record, which 067's reopen on a later text move keeps and a re-judge
    -- finding the conflict again (063: the judge saying it again, after which
    -- the comment on the board is its verdict once more) empties (SMD-2913,
    -- review passes 1 and 2). The poster posts pending rows only, so a settle
    -- in the record came after the finding was chosen — one made before its
    -- comment was posted counts, at 0. A stale row the pass settled since is
    -- reopened: taken back, so it neither waits nor holds off a person's
    -- rejection; stale is one that waits on its re-judge (review pass 2).
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE s.state = 'accepted')::int AS accepted,
             count(*) FILTER (WHERE s.state = 'rejected')::int AS rejected,
             count(*) FILTER (WHERE s.state = 'settled')::int AS settled,
             count(*) FILTER (WHERE s.state = 'stale' AND s.settled_since IS NOT NULL)::int AS reopened,
             count(*) FILTER (WHERE s.state = 'stale' AND s.settled_since IS NULL)::int AS stale,
             count(*) FILTER (WHERE s.state = 'pending')::int AS pending,
             min(s.reviewed_at) FILTER (WHERE s.state = 'accepted') AS accepted_at,
             max(s.reviewed_at) FILTER (WHERE s.state = 'rejected') AS rejected_at,
             CASE WHEN bool_and(s.settled_since IS NOT NULL) THEN max(s.settled_since) END AS withdrawn_at
        FROM (SELECT x.reviewed_at,
                     CASE WHEN x.status = 'rejected' AND x.review_note LIKE 'settled by the pass:%' THEN 'settled' ELSE x.status END AS state,
                     (SELECT min(t) FROM unnest(x.pass_settled_at) AS t) AS settled_since
                FROM supersession_proposals x
               WHERE b.word = 'outdates' AND x.id = ANY (b.finding_ids)) s) p ON b.word = 'outdates'
    -- A re-judge closes a relation and writes its successor on the same pair
    -- of thoughts (084's one active relation per pair), so the named facet's
    -- pair is where its word is looked for: standing now, or when the last
    -- relation of that word there was closed.
    -- Driven from the ids by primary key, the word tested inside: on a small
    -- thought_facets the planner otherwise scanned it once per posted row,
    -- outdates rows included (review pass 1).
    LEFT JOIN LATERAL (
      -- A close whose target is gone is 084's trigger answering a delete, not
      -- the judge: no time, as when the holder's delete cascades (review pass 3).
      SELECT bool_or(n.valid_until IS NULL) IS TRUE AS stands,
             max(n.valid_until) FILTER (WHERE EXISTS (SELECT 1 FROM thoughts g WHERE g.id = (n.payload->>'target')::uuid)) AS gone_at
        FROM unnest(b.finding_ids) AS x(id)
        JOIN thought_facets o ON o.id = x.id AND o.kind = 'relation'
        JOIN thought_facets n ON n.thought_id = o.thought_id AND n.kind = 'relation' AND n.payload->>'target' = o.payload->>'target'
       WHERE b.word <> 'outdates' AND n.payload->>'relation' = b.word) r ON b.word <> 'outdates'
   ORDER BY b.posted_at DESC, b.ticket_a, b.ticket_b, b.word`;

const FINDING_WORD_NAMES = ["outdates", "related", "evolves", "duplicate"] as const;

/** A number of seconds the read answered, or null; anything else is a read that did not answer. */
function secondsOf(field: string, v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`the ${field} read answered a duration that is not a number`);
  return n;
}

/** The read's rows as the record reads them. */
export function findingRows(rows: readonly Record<string, unknown>[]): FindingRow[] {
  return rows.map((r) => {
    const word = String(r.word);
    const origin = String(r.origin);
    if (!(FINDING_WORD_NAMES as readonly string[]).includes(word) || (origin !== "posted" && origin !== "found")) throw new Error("the findings read answered a row not of 087's shape");
    const at = r.posted_at instanceof Date ? r.posted_at : new Date(String(r.posted_at));
    if (Number.isNaN(at.getTime())) throw new Error("the findings read answered a posted_at that is not an instant");
    const linked = secondsOf("findings", r.linked_s);
    return {
      a: String(r.ticket_a),
      b: String(r.ticket_b),
      word: word as FindingRow["word"],
      postedOn: String(r.posted_on),
      origin,
      postedAt: at.toISOString(),
      ageS: Math.max(0, secondsOf("findings", r.age_s) ?? 0),
      linkedS: linked === null ? null : Math.max(0, linked),
      proposals: word === "outdates"
        ? {
            accepted: countOf("findings", r.accepted ?? 0), rejected: countOf("findings", r.rejected ?? 0),
            settled: countOf("findings", r.settled ?? 0), reopened: countOf("findings", r.reopened ?? 0),
            stale: countOf("findings", r.stale ?? 0), pending: countOf("findings", r.pending ?? 0),
            acceptedS: secondsOf("findings", r.accepted_s), rejectedS: secondsOf("findings", r.rejected_s),
          }
        : null,
      stands: word === "outdates" ? null : r.stands === true,
      withdrawnS: word !== "outdates" && r.stands === true ? null : secondsOf("findings", r.withdrawn_s),
    };
  });
}

/**
 * What became of one posted finding, first match wins:
 *
 *   outdates   accepted   a proposal it named was accepted
 *              rejected   none is pending or waiting on a re-judge and a
 *                         person rejected one — a link on the board since
 *                         does not undo that no; a proposal the pass took
 *                         back and a text move reopened does not wait
 *              accepted   the board links the pair
 *              withdrawn  the pass settled every proposal it named that is
 *                         still present (067's marker: its re-judge found no
 *                         conflict), each since the judge last asserted it,
 *                         within the window — stale since by a text move or
 *                         not; after it, unanswered
 *              open       a proposal is still pending, or stale and not
 *                         settled since it was last asserted (063, 067)
 *              withdrawn  the rest: every proposal it named is gone (or 091's
 *                         record was bypassed and a settle left no time)
 *   relation   accepted   the board links the pair
 *              open       a relation of its word still stands
 *              withdrawn  the judge stopped saying it within the window
 *              unanswered …or after it: the board had the window and left it
 *
 * An open finding posted more than `days` ago is unanswered — the window runs
 * from the post, the tracker's "a month of posted findings", so a finding the
 * judge asserts again late in it leaves the board less time, and past it reads
 * unanswered at once (review pass 2). The board has no
 * "no" for a relation: left unlinked past the window is how it says one, and
 * a judge that changes its mind afterwards does not take that back (review
 * pass 1: a withdrawal after the window left the rate's denominator). A
 * proposal or a relation deleted with its thought leaves no time behind it:
 * the comment is still on the board, so withdrawn within the window,
 * unanswered past it.
 *
 * What the judge last asserted decides (SMD-2913). A text move reopening a
 * settle (067: stale, reviewed_at cleared) is the brain asking again, not the
 * judge saying it again: 091 keeps the settle, so a finding the pass took back
 * on its fifth day stays withdrawn through the reopen and a second settle. A
 * re-judge that finds the conflict again (pending, judged_at moved) or a
 * relation said again is the judge asserting it once more — the comment on the
 * board is its verdict again, so it reads open, then unanswered, and is counted
 * (review pass 1: ranking every take-back ahead of that left it out of the
 * rate). A settle 067 reopened before 091 left no time behind; that finding
 * reads by its state now, which can only understate the rate. A rejection whose
 * note a person wrote beginning with 067's marker (by hand, in SQL:
 * consolidate.ts --reject refuses it) reads as the pass's, as 067 itself reads
 * it.
 */
export function findingOutcome(r: FindingRow, days = UNANSWERED_AFTER_DAYS): FindingVerdict {
  const open = (): FindingVerdict => ({ outcome: r.ageS > days * 86_400 ? "unanswered" : "open", how: null, answeredS: null });
  const linked: FindingVerdict | null = r.linkedS === null ? null : { outcome: "accepted", how: "linked", answeredS: r.linkedS };
  // Taken back by the judge: within the window it was never the board's to
  // answer; after it, the board had its time. Gone with its thought, no time
  // is left: the comment is still on the board, so its age decides (review
  // pass 2: deleting the newer thought read withdrawn at any age, the older
  // by its close).
  const withdrawn = (atS: number | null): FindingVerdict => ({ outcome: (atS ?? r.ageS) > days * 86_400 ? "unanswered" : "withdrawn", how: null, answeredS: null });
  const p = r.proposals;
  if (p) {
    if (p.accepted > 0) return { outcome: "accepted", how: "proposal", answeredS: p.acceptedS === null ? null : Math.max(0, p.acceptedS) };
    if (p.pending === 0 && p.stale === 0 && p.rejected > 0) return { outcome: "rejected", how: "proposal", answeredS: p.rejectedS === null ? null : Math.max(0, p.rejectedS) };
    if (linked) return linked;
    // Every proposal present was taken back since it was last asserted, a
    // text move having reopened some or none (091 keeps the settle).
    if (r.withdrawnS !== null) return withdrawn(r.withdrawnS);
    if (p.pending + p.stale > 0) return open();
    return withdrawn(null);
  }
  if (linked) return linked;
  if (r.stands) return open();
  return withdrawn(r.withdrawnS);
}

/** The rows as the record carries them: this brain's by outcome, the found apart. */
export function findingsValue(rows: readonly FindingRow[], days = UNANSWERED_AFTER_DAYS): BoardFindings {
  const out: BoardFindings = { posted: 0, comments: 0, found: 0, accepted: 0, rejected: 0, withdrawn: 0, open: 0, unanswered: 0, windowDays: days, medianAnswerS: null };
  const comments = new Set<string>();
  const answered: number[] = [];
  for (const r of rows) {
    if (r.origin === "found") { out.found++; continue; }
    out.posted++;
    // One comment is one transaction: its rows share the pair and posted_at (postedToday's count).
    comments.add(`${r.a}\u0000${r.b}\u0000${r.postedAt}`);
    const v = findingOutcome(r, days);
    out[v.outcome]++;
    if (v.answeredS !== null && (v.outcome === "accepted" || v.outcome === "rejected")) answered.push(v.answeredS);
  }
  out.comments = comments.size;
  if (answered.length) {
    answered.sort((x, y) => x - y);
    const m = answered.length >> 1;
    out.medianAnswerS = Math.round(answered.length % 2 ? answered[m] : (answered[m - 1] + answered[m]) / 2);
  }
  return out;
}

/** The acceptance rate's terms: accepted over accepted, rejected and unanswered — an unanswered finding counts against it; withdrawn and open are left out. */
export function acceptance(f: BoardFindings): { accepted: number; counted: number } {
  return { accepted: f.accepted, counted: f.accepted + f.rejected + f.unanswered };
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
             -- 079's pair rule, which the findings' board pairs apply (SMD-2680).
             to_regprocedure('consolidation_tickets_linked(jsonb, jsonb)') IS NOT NULL AS tickets_linked,
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
               'ob1_entities', to_regclass('ob1_entities') IS NOT NULL,
               'supersession_proposals', to_regclass('supersession_proposals') IS NOT NULL,
               'thought_facets', to_regclass('thought_facets') IS NOT NULL,
               'board_findings_posted', to_regclass('board_findings_posted') IS NOT NULL) AS resolved,
             (SELECT COALESCE(jsonb_object_agg(relname, schemas), '{}'::jsonb) FROM (
                SELECT c.relname::text AS relname, string_agg(n.nspname::text, ', ' ORDER BY n.nspname) AS schemas
                  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.relkind IN ('r', 'p')
                   AND c.relname IN ('ob1_config', 'schema_migrations', 'thoughts', 'thought_audit', 'thought_chunks', 'ob1_entities', 'supersession_proposals', 'thought_facets', 'board_findings_posted')
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
      proposals: null,
      relations: null,
      findings: null,
      hnsw: (cat.hnsw as { index: string; table: string; opts: string | null }[]).map((h) => ({ index: h.index, table: h.table, ...parseHnswOptions(h.opts) })),
      unread: {},
    };
    progress.facts = facts;

    // The guarded reads, in order. Each names the table it needs; a table that
    // does not resolve is not queried — absent, or `invisible` when pg_class
    // has it where this role cannot reach.
    // `clear` takes a value back when the savepoint fails after the read wrote
    // it (its RELEASE, say), so a fact is never both read and unread (review pass 4).
    // `joins` names the other tables a read touches (SMD-2680), so a lock
    // already refused on one of them is not waited on again below.
    type Guarded = { field: string; table?: KnownTable; joins?: KnownTable[]; read: (sp: SqlTag) => Promise<void>; clear: () => void };
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
            { field: "relations", table: "thought_facets" as const, read: async (sp: SqlTag) => { facts.relations = relationsValue((await RELATIONS_SQL(sp))[0]); }, clear: () => { facts.relations = null; } },
          ]
        : []),
      // Not a stats read: preflight's proposals row reads it (SMD-2680).
      {
        field: "proposals",
        table: "supersession_proposals",
        read: async (sp) => { facts.proposals = proposalsValue((await PROPOSALS_SQL(sp))[0]); },
        clear: () => { facts.proposals = null; },
      },
      // The board pairs last, each its own read, and only where 079's rule is
      // there to apply (null, no entry, before it): the costly reads, so a
      // timeout or a deadline takes them alone — the queue's first, the one a
      // reviewer acts on (review pass 3). Each fills in its field's count once
      // that field was read; on a stats read, after a refused lock on thoughts
      // neither is sent.
      ...(cat.tickets_linked === true
        ? [
            { field: "proposals.boardPairs", table: "supersession_proposals" as const, joins: ["thoughts" as const, "thought_facets" as const],
              read: async (sp: SqlTag) => {
                if (!facts.proposals) return;
                // Nothing pending pairs nothing: not sent, so a refusal of 079's predicate cannot speak for an empty queue (review pass 4).
                facts.proposals.boardPairs = facts.proposals.pending === 0 ? 0 : boardPairsValue("the queue's board pairs", (await PROPOSALS_BOARD_SQL(sp))[0]);
              },
              clear: () => { if (facts.proposals) facts.proposals.boardPairs = null; } },
            ...(stats
              ? [{ field: "relations.boardPairs", table: "thought_facets" as const, joins: ["thoughts" as const],
                   read: async (sp: SqlTag) => {
                     if (!facts.relations) return;
                     const r = facts.relations;
                     r.boardPairs = r.related + r.evolves + r.duplicate === 0 ? 0 : boardPairsValue("relations' board pairs", (await RELATIONS_BOARD_SQL(sp))[0]);
                   },
                   clear: () => { if (facts.relations) facts.relations.boardPairs = null; } }]
              : []),
          ]
        : []),
      // What became of the findings posted (SMD-2682): a handful of rows a
      // day at most (the poster's cap), each a few index probes — after the
      // queue and its board counts, so a lock on a table it joins is waited
      // on by the queue's own read alone, and a slow answer here never stands
      // in front of the queue (review pass 1).
      ...(stats
        ? [{ field: "findings", table: "board_findings_posted" as const, joins: ["thoughts" as const, "thought_facets" as const, "supersession_proposals" as const],
             read: async (sp: SqlTag) => { facts.findings = findingsValue(findingRows(await FINDING_OUTCOMES_SQL(sp))); }, clear: () => { facts.findings = null; } }]
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

    // A table whose lock a read of it alone was refused (55P03): a later read
    // that touches it is not tried, so a migration holding one table costs
    // one lock wait, not one per read (SMD-2680). Only a single-table read
    // says which table it was; a join's refusal names none.
    const lockRefused = new Set<KnownTable>();
    for (const g of toRun) {
      if (progress.abandoned) break; // snapshotFacts named what is still pending
      const refused = [g.table, ...(g.joins ?? [])].find((t): t is KnownTable => t !== undefined && lockRefused.has(t));
      if (refused) {
        progress.pending.delete(g.field);
        facts.unread[g.field] = { reason: "timeout", message: `not tried — a lock on ${refused} (the table or one of its indexes) was refused to an earlier read here (lock timeout)` };
        continue;
      }
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
        if (g.table && !g.joins?.length && String((e as { errno?: unknown })?.errno ?? "") === "55P03") lockRefused.add(g.table);
      }
    }
    settleBoardPairs(facts);
    return facts;
  });
}

/**
 * A board count that has nothing to count reads 0, and one whose field was not
 * read reads nothing: neither keeps an `unread` entry, whatever left it
 * unread — a lock refused earlier, the deadline (review pass 5). Run on a
 * finished read and on a snapshot.
 */
function settleBoardPairs(facts: DatabaseFacts): void {
  const settle = (field: string, parent: { boardPairs: number | null } | null, total: number | undefined) => {
    if (!(field in facts.unread)) return;
    if (parent === null) delete facts.unread[field];
    else if (total === 0) { delete facts.unread[field]; parent.boardPairs = 0; }
  };
  settle("proposals.boardPairs", facts.proposals, facts.proposals?.pending);
  settle("relations.boardPairs", facts.relations, facts.relations ? facts.relations.related + facts.relations.evolves + facts.relations.duplicate : undefined);
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
  if (!progress.facts) return null;
  const snapshot = structuredClone(progress.facts);
  settleBoardPairs(snapshot);
  return snapshot;
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
  // A pass the sleep scheduler started that waits at its start for the
  // provider runs nothing: said so, not "running a pass" (SMD-2752 PR 3).
  const state = h.running ? (h.waiting?.length ? "waiting for the provider at a pass's start" : "running a pass") : "alive";
  return `${state}${h.outcome === "failed" ? ", its last pass failed" : ""} (${when})`;
}

/** The Workers row: each heartbeat's state, none, or why it was not read. */
function workersLine(db: DatabaseSummary): string {
  if (db.workers === null) return "workers" in db.unread ? `? (ob1_config ${unreadWords(db.unread.workers)})` : "no ob1_config";
  const { heartbeats, ignored } = db.workers;
  const tail = ignored ? ` (${ignored} heartbeat row(s) not of the shape, ignored)` : "";
  if (heartbeats.length === 0) return `none stamped — no long-running worker has run here${tail}`;
  return heartbeats.map((h) => `${h.job ?? h.worker} ${heartbeatState(h)}`).join("; ") + tail;
}

/** "4 pair two tickets the board does not link", `?` when that read did not answer, or nothing. */
const boardTail = (n: number | null, unread: Unread | undefined) =>
  unread
    ? `; board pairs ? (${unread.reason === "refused" && deniedObject(unread.message)?.kind === "function" ? "079's predicate not executable by this role" : unreadWords(unread)})`
    : n ? `; ${n} pair two tickets the board does not link` : "";

/** The Proposals row: the queue, none, or why it was not read (SMD-2680). */
function proposalsLine(db: DatabaseSummary): string {
  const p = db.proposals;
  if (p === null) return "proposals" in db.unread ? `? (${deniedObject(db.unread.proposals.message)?.name ?? "supersession_proposals"} ${unreadWords(db.unread.proposals)})` : "no table — migration 029 is not applied";
  const stale = p.stale ? `; ${p.stale} stale` : "";
  if (p.pending === 0) return `none pending${stale}`;
  return `${p.pending} pending (the oldest judged ${p.oldestPendingS === null ? "?" : `${ago(p.oldestPendingS)} ago`}${boardTail(p.boardPairs, db.unread["proposals.boardPairs"])})${stale}`;
}

/** The Relations row: the standing judged relations by word, none, or why they were not read (SMD-2680). */
function relationsLine(db: DatabaseSummary): string {
  const r = db.relations;
  if (r === null) return "relations" in db.unread ? `? (${deniedObject(db.unread.relations.message)?.name ?? "thought_facets"} ${unreadWords(db.unread.relations)})` : "no table — migration 042 is not applied";
  const n = r.related + r.evolves + r.duplicate;
  // A brain short of 084 holds none because it cannot yet, not because none was found.
  if (n === 0) return db.highestMigration !== null && db.highestMigration < 84 ? "none — migration 084 is not applied" : "none standing";
  return `${n} standing (${r.related} related, ${r.evolves} evolves, ${r.duplicate} duplicate${boardTail(r.boardPairs, db.unread["relations.boardPairs"])})`;
}

/**
 * The Findings row: what became of the findings posted to the board, and the
 * acceptance rate over those answered (SMD-2682); none, or why not read.
 */
export function findingsLine(db: Pick<DatabaseSummary, "findings" | "unread">): string {
  const f = db.findings;
  if (f === null) {
    const u = db.unread.findings;
    if (!u) return "no table — migration 087 is not applied";
    // A brain behind this server: the read names 091's column (review pass 1).
    if (/\bpass_settled_at\b.* does not exist/.test(u.message)) return "? (migration 091 is not applied)";
    // The read joins four tables: a refusal or an earlier lock names the one it
    // was (review pass 1); its own timeout names none, since Postgres does not
    // say which (review pass 2).
    const named = deniedObject(u.message)?.name ?? /^not tried — a lock on (\w+)/.exec(u.message)?.[1] ?? (u.reason === "invisible" ? "board_findings_posted" : null);
    return named ? `? (${named} ${unreadWords(u)})` : `? (${unreadWords(u)})`;
  }
  const found = f.found ? `; ${f.found} found on the board from another poster` : "";
  if (f.posted === 0) return `none posted${found}`;
  // The unanswered are in the denominator, so the sentence does not call them answered (review pass 4).
  const { accepted, counted } = acceptance(f);
  const rate = counted
    ? `acceptance ${Math.round((100 * accepted) / counted)}% (${accepted} of ${counted}: accepted over accepted, rejected and unanswered)${f.medianAnswerS === null ? "" : `, median ${ago(f.medianAnswerS)} to an answer`}`
    : "no rate yet (none answered, none past the window)";
  return `${f.posted} posted in ${f.comments} comment(s): ${f.accepted} accepted, ${f.rejected} rejected, ${f.unanswered} unanswered after ${f.windowDays} d, ${f.open} open, ${f.withdrawn} withdrawn — ${rate}${found}`;
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
      row("Relations", relationsLine(db)),
    );
  }
  lines.push(row("Proposals", proposalsLine(db)));
  if (counts) lines.push(row("Findings", findingsLine(db)));
  lines.push(row("Workers", workersLine(db)));
  lines.push(row("HNSW", db.hnsw.length === 0 ? "none" : db.hnsw.map((h) => `${h.index} on ${h.table} (m ${h.m}, ef_construction ${h.efConstruction})`).join("; ")));
  const unread = Object.entries(db.unread);
  // A deadline's message is its words; every other reason adds the database's.
  if (unread.length) lines.push(row("Not read", unread.map(([k, u]) => `${k} — ${unreadWords(u)}${u.reason === "deadline" ? "" : `: ${u.message}`}`).join("; ")));
  return lines.join("\n");
}
