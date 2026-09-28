/**
 * jobs.ts — in-memory async job handles for long-running operations (SMD-2273).
 *
 * Every call to the server is otherwise synchronous: a POST holds open until
 * the handler returns, kept alive at most SSE_KEEPALIVE_MAX_MS (10 min,
 * SMD-1864). An operation that outlives that window — a worker drain
 * (SMD-2272), a large backfill, a full re-embed — cannot be a tool. This is the
 * Post/Redirect/Get shape for it: a tool call kicks off the work and returns a
 * handle at once (`startJob`), and the caller comes back for the result — an
 * MCP client through the `job_status` tool, a REST/curl client through the keyed
 * `GET /jobs/<id>` poll or the `GET /jobs/<id>/stream` SSE subscription, both in
 * index.ts. This module owns the registry, the detached runner and the SSE
 * fan-out; index.ts owns the transport (the routes, the auth gate, the
 * keepalive wrapper) and passes the work in.
 *
 * The live registry is a single in-memory Map: it holds the running jobs, the
 * SSE subscribers and the detached runner, and it is authoritative while the
 * process is up. A job still running when the process stops is marked `lost`
 * (`markRunningLost`, from index.ts's SIGTERM drain) so an in-flight poll or
 * stream sees a terminal answer rather than hanging.
 *
 * Durability is an optional write-through sink (SMD-2318, migration 069's `jobs`
 * table), injected by index.ts on the Bun/SQL server via `setJobSink`: the
 * registry mirrors each state change to it, and a poll for a job no longer in
 * the Map — evicted under the cap, or held by a prior process before a restart —
 * reads the row back through it. So a job that finished before a restart is
 * still readable with its result, and a running one is reconciled to `lost` at
 * startup (`reconcileDurableJobsLost`) rather than becoming `not found`. Left
 * unset, the registry is pure in-memory (the SMD-2273 behaviour), and a poll for
 * a job the Map no longer holds gets `not found`. On Workers there is no
 * long-lived process to hold the Map or run the detached body past the response,
 * so no sink is set and job handles are a Bun-server feature; the REST routes
 * still answer, they just never hold a running job. A `worker_status`-style
 * listing over the durable table, and a second replica, remain fast-follows.
 */

/** Who owns a job — the fields index.ts's Principal carries that this module needs. */
export interface JobPrincipal {
  /** The SHA-256 of the presented key: the ownership token (a job is visible only to the key that started it). */
  keyHash: string;
  /** The key's name, the actor fallback when the agent id has not resolved. */
  name: string;
  /** The resolved stable agent id, when the registry answered (auth.ts / agents.ts). */
  agentId?: string;
}

/** A job's progress: how far along a run is, for the poll body and the SSE `progress` events. */
export interface JobProgress {
  done: number;
  total: number;
  message?: string;
}

/**
 * A job's lifecycle. `pending` → `running` → one of the three terminal states.
 * `lost` is a running job the server's stop cut off (in-memory: not resumable).
 */
export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "lost";

/** The projection a caller sees — the record without its owner hash, timers or subscribers. */
export interface PublicJob {
  jobId: string;
  kind: string;
  status: JobStatus;
  actor: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  progress?: JobProgress;
  result?: unknown;
  error?: { message: string; code?: string };
}

/** What the POST hands back at once, without blocking: the PRG handle. */
export interface JobHandle {
  jobId: string;
  status: "accepted";
  /** The keyed REST poll route (relative). */
  poll: string;
  /** The keyed REST SSE route (relative). */
  stream: string;
}

/** What a running job body is given: a way to report progress and a signal that aborts on stop or timeout. */
export interface JobContext {
  progress(done: number, total: number, message?: string): void;
  readonly signal: AbortSignal;
}

/**
 * The row a durable sink persists (SMD-2318) — the public projection plus the
 * ownership token the read filters on. Timestamps are epoch ms, as the public
 * shape carries them; the SQL sink converts to and from timestamptz.
 */
export interface JobRow {
  id: string;
  kind: string;
  ownerKeyHash: string;
  actor: string;
  status: JobStatus;
  progress?: JobProgress;
  result?: unknown;
  error?: { message: string; code?: string };
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
}

/**
 * A durable backing store for the registry (SMD-2318, migration 069's `jobs`
 * table). index.ts injects the SQL implementation on the Bun server; left unset,
 * the registry is pure in-memory — the SMD-2273 behaviour, which is what Workers
 * (no long-lived process) and any suite without a database run. The live SSE
 * fan-out and the detached runner always stay in this process; the sink holds
 * only the record, so a job survives a restart. Every write is best-effort from
 * the registry's side (fire-and-forget, its failure swallowed so it can never
 * fail a tool call); the startup reconcile is the durable guarantee if a write
 * did not land before the process stopped.
 */
export interface JobSink {
  /**
   * Upsert the row. The registry serializes a job's writes (a per-record chain),
   * so they arrive in lifecycle order; the sink must additionally never move a
   * terminal row back to a live state (a late write after a restart's reconcile).
   */
  write(row: JobRow): Promise<void>;
  /** The ownership-checked row, for a poll of a job no longer in the Map (evicted under the cap, or after a restart). */
  read(ownerKeyHash: string, id: string): Promise<PublicJob | null>;
  /** Mark every durable job still pending/running as lost — the process that ran it is gone, and an in-memory run does not resume. Returns the count. Run once at startup. */
  reconcileRunningLost(): Promise<number>;
}

/** The injected durable store, or null for the pure in-memory registry (Workers, no-DB suites). */
let sink: JobSink | null = null;

/** How often a running job's progress is written through to the sink; the running-transition and every terminal state are always written. */
const PERSIST_THROTTLE_MS = 1_000;

/** index.ts sets the durable store once at startup (SQL server) or clears it (a suite). */
export function setJobSink(s: JobSink | null): void {
  sink = s;
}

/** Mark every durable job left pending/running by a prior process as lost. Run once at startup, after setJobSink; 0 when there is no sink. */
export async function reconcileDurableJobsLost(): Promise<number> {
  return sink ? sink.reconcileRunningLost() : 0;
}

/** Tunables index.ts feeds from env(); each has a default so this module stands alone in tests. */
export interface StartJobOptions {
  /** How long a terminal record is kept before eviction. */
  retentionMs?: number;
  /** The hard cap on records; the oldest terminal ones are evicted to make room. */
  maxJobs?: number;
  /** Auto-fail a run that exceeds this (0 disables). */
  maxRunMs?: number;
  /** Wrap the detached run, so the SIGTERM drain waits for it — index.ts passes toolCalls.track. A wrapper that returns void (fire-and-forget) is fine; startJob does not depend on the return. */
  track?: <T>(run: () => Promise<T>) => Promise<T> | void;
  /** The clock, injectable for tests. */
  now?: () => number;
}

/** Terminal after 10 minutes by default, matching the SSE keepalive ceiling: a stream past that is stalled, not slow. */
export const DEFAULT_JOB_RETENTION_MS = 10 * 60_000;
/** At most this many records live at once; the oldest terminal ones are dropped first. */
export const DEFAULT_JOB_MAX = 100;
/** A detached run is auto-failed past this, so a stuck body does not leak forever with no line (30 min; 0 disables). */
export const DEFAULT_JOB_MAX_MS = 30 * 60_000;

/** One SSE writer attached to a job (a subscribed stream). */
interface Sub {
  write(frame: string): void;
  close(): void;
}

interface JobRecord {
  id: string;
  kind: string;
  status: JobStatus;
  ownerKeyHash: string;
  actor: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  progress?: JobProgress;
  result?: unknown;
  error?: { message: string; code?: string };
  subs: Set<Sub>;
  abort: AbortController;
  retentionMs: number;
  now: () => number;
  retentionTimer?: ReturnType<typeof setTimeout>;
  maxRunTimer?: ReturnType<typeof setTimeout>;
  /** Serializes this job's durable writes so they land in lifecycle order (SMD-2318); resolves once there is no sink. */
  writeChain: Promise<void>;
  /** When the last progress write went to the sink, for the throttle. */
  lastPersistMs: number;
}

/** The registry: one process-wide Map, keyed by job id. */
const jobs = new Map<string, JobRecord>();

const isTerminal = (s: JobStatus): boolean => s === "succeeded" || s === "failed" || s === "lost";

function toPublic(rec: JobRecord): PublicJob {
  return {
    jobId: rec.id,
    kind: rec.kind,
    status: rec.status,
    actor: rec.actor,
    createdAt: rec.createdAt,
    ...(rec.startedAt !== undefined ? { startedAt: rec.startedAt } : {}),
    ...(rec.endedAt !== undefined ? { endedAt: rec.endedAt } : {}),
    ...(rec.progress !== undefined ? { progress: rec.progress } : {}),
    ...(rec.result !== undefined ? { result: rec.result } : {}),
    ...(rec.error !== undefined ? { error: rec.error } : {}),
  };
}

/** The durable row for a record — its public fields plus the ownership token (SMD-2318). */
function rowOf(rec: JobRecord): JobRow {
  return {
    id: rec.id,
    kind: rec.kind,
    ownerKeyHash: rec.ownerKeyHash,
    actor: rec.actor,
    status: rec.status,
    createdAt: rec.createdAt,
    ...(rec.startedAt !== undefined ? { startedAt: rec.startedAt } : {}),
    ...(rec.endedAt !== undefined ? { endedAt: rec.endedAt } : {}),
    ...(rec.progress !== undefined ? { progress: rec.progress } : {}),
    ...(rec.result !== undefined ? { result: rec.result } : {}),
    ...(rec.error !== undefined ? { error: rec.error } : {}),
  };
}

/**
 * Write the record's current state through to the durable sink, best-effort and
 * in lifecycle order (SMD-2318). A no-op when there is no sink (the in-memory
 * registry). The row is snapshotted now, because the record keeps mutating; the
 * write is queued on the record's chain so a later state cannot land before an
 * earlier one, and its failure is swallowed so a durable-store hiccup never
 * fails the job.
 */
function persist(rec: JobRecord): void {
  const s = sink;
  if (!s) return;
  const row = rowOf(rec);
  rec.writeChain = rec.writeChain.then(() => s.write(row)).catch(() => {});
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function terminalFrame(rec: JobRecord): string {
  return frame(rec.status === "succeeded" ? "done" : "error", toPublic(rec));
}

/** Push a frame to every subscriber; a writer whose stream has closed is dropped silently. */
function broadcast(rec: JobRecord, f: string): void {
  for (const s of rec.subs) {
    try {
      s.write(f);
    } catch {
      /* the readable side closed under us: the client left */
    }
  }
}

function evict(rec: JobRecord): void {
  if (rec.retentionTimer) clearTimeout(rec.retentionTimer);
  if (rec.maxRunTimer) clearTimeout(rec.maxRunTimer);
  jobs.delete(rec.id);
}

/** Keep the registry under its cap by dropping the oldest terminal records; a running job is never evicted. */
function evictToCap(maxJobs: number): void {
  if (jobs.size < maxJobs) return;
  const terminal = [...jobs.values()]
    .filter((r) => isTerminal(r.status))
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  for (const r of terminal) {
    if (jobs.size < maxJobs) break;
    evict(r);
  }
}

/** Move a job to a terminal state once: notify subscribers, close their streams, and schedule the record's eviction. */
function finish(rec: JobRecord, status: Exclude<JobStatus, "pending" | "running">, patch: { result?: unknown; error?: { message: string; code?: string } }): void {
  if (isTerminal(rec.status)) return;
  rec.status = status;
  rec.endedAt = rec.now();
  if (patch.result !== undefined) rec.result = patch.result;
  if (patch.error !== undefined) rec.error = patch.error;
  if (rec.maxRunTimer) {
    clearTimeout(rec.maxRunTimer);
    rec.maxRunTimer = undefined;
  }
  if (status !== "succeeded" && !rec.abort.signal.aborted) rec.abort.abort();
  // Each subscriber gets the terminal frame, then its stream closes — one pass.
  const term = terminalFrame(rec);
  for (const s of rec.subs) {
    try {
      s.write(term);
      s.close();
    } catch {
      /* the readable side already closed: the client left */
    }
  }
  rec.subs.clear();
  // Persist the terminal state (SMD-2318): a job that finished before a restart
  // is then still readable with its result; a `lost` marked by the stop's drain
  // survives the restart rather than becoming `not found`. Best-effort — the
  // startup reconcile catches a write that did not land.
  persist(rec);
  rec.retentionTimer = setTimeout(() => jobs.delete(rec.id), rec.retentionMs);
  rec.retentionTimer.unref?.();
}

/**
 * Start a detached job and return its handle at once. `run` is invoked with a
 * JobContext and NOT awaited by the caller — its resolution moves the job to
 * `succeeded` (its value the result) and its rejection to `failed` (its message
 * the error). `run` should check `ctx.signal` at its own boundaries so a stop
 * or a timeout ends it promptly.
 */
export function startJob(
  principal: JobPrincipal,
  kind: string,
  run: (ctx: JobContext) => Promise<unknown>,
  opts: StartJobOptions = {},
): JobHandle {
  const now = opts.now ?? Date.now;
  const retentionMs = opts.retentionMs ?? DEFAULT_JOB_RETENTION_MS;
  const maxJobs = opts.maxJobs ?? DEFAULT_JOB_MAX;
  const maxRunMs = opts.maxRunMs ?? DEFAULT_JOB_MAX_MS;
  const track = opts.track ?? ((r) => r());

  evictToCap(maxJobs);

  const id = crypto.randomUUID();
  const rec: JobRecord = {
    id,
    kind,
    status: "pending",
    ownerKeyHash: principal.keyHash,
    actor: principal.agentId ?? principal.name,
    createdAt: now(),
    subs: new Set<Sub>(),
    abort: new AbortController(),
    retentionMs,
    now,
    writeChain: Promise.resolve(),
    lastPersistMs: now(),
  };
  jobs.set(id, rec);
  // Insert the pending row (SMD-2318). Best-effort and fire-and-forget: the
  // handle returns at once, and the durable store never gates the start.
  persist(rec);

  const ctx: JobContext = {
    signal: rec.abort.signal,
    progress(done, total, message) {
      if (isTerminal(rec.status)) return;
      rec.progress = { done, total, ...(message !== undefined ? { message } : {}) };
      broadcast(rec, frame("progress", rec.progress));
      // Write progress through at most once a second (SMD-2318): a live
      // subscriber sees every tick over SSE, but a long scan must not hammer the
      // durable store — a poll after a restart wants a recent figure, not each.
      const t = rec.now();
      if (t - rec.lastPersistMs >= PERSIST_THROTTLE_MS) {
        rec.lastPersistMs = t;
        persist(rec);
      }
    },
  };

  if (maxRunMs > 0) {
    rec.maxRunTimer = setTimeout(() => {
      finish(rec, "failed", { error: { message: `job exceeded ${Math.round(maxRunMs / 1000)} s (OB1_JOB_MAX_MS)`, code: "JOB_TIMEOUT" } });
    }, maxRunMs);
    rec.maxRunTimer.unref?.();
  }

  const exec = async (): Promise<void> => {
    rec.status = "running";
    rec.startedAt = now();
    rec.lastPersistMs = rec.startedAt;
    broadcast(rec, frame("status", toPublic(rec)));
    persist(rec); // the running-transition (SMD-2318)
    try {
      const result = await run(ctx);
      finish(rec, "succeeded", { result });
    } catch (e) {
      finish(rec, "failed", { error: { message: (e as Error).message } });
    }
  };
  // Detached, but tracked: the SIGTERM drain waits on it up to its bound
  // (index.ts wires toolCalls.track in), then markRunningLost cuts it. Wrapped
  // in Promise.resolve so a `track` that returns void (a test's) is fine too;
  // exec routes every throw to finish(), so this only guards the wrapper.
  void Promise.resolve(track(exec)).catch(() => {});

  return { jobId: id, status: "accepted", poll: `/jobs/${id}`, stream: `/jobs/${id}/stream` };
}

/**
 * The ownership-checked projection of a job, or null when the id is unknown or
 * the key is not its owner. The live in-process record is authoritative (it
 * carries progress between the throttled durable writes); a job no longer in the
 * Map — evicted under the cap, or held by a prior process before a restart — is
 * read from the durable sink when one is configured (SMD-2318).
 */
export async function readJob(principal: Pick<JobPrincipal, "keyHash">, id: string): Promise<PublicJob | null> {
  const rec = jobs.get(id);
  if (rec) return rec.ownerKeyHash === principal.keyHash ? toPublic(rec) : null;
  return sink ? sink.read(principal.keyHash, id) : null;
}

/** An SSE body that emits a durable row's snapshot (and its terminal event, if terminal) once, then closes — for a job no longer in the Map. */
function snapshotStream(row: PublicJob): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(frame("status", row)));
      if (isTerminal(row.status)) {
        controller.enqueue(enc.encode(frame(row.status === "succeeded" ? "done" : "error", row)));
      }
      controller.close();
    },
  });
}

/**
 * An SSE body for a job: the current status at once, then a `progress` event per
 * update and a terminal `done`/`error` event, after which the stream closes. A
 * job that is already terminal gets its snapshot and terminal event and closes.
 * Null when the id is unknown or the key is not its owner (the route answers as
 * it does for the poll). The route sets `content-type: text/event-stream` and
 * wraps this in withSseKeepalive.
 */
export async function subscribe(principal: Pick<JobPrincipal, "keyHash">, id: string): Promise<ReadableStream<Uint8Array> | null> {
  const rec = jobs.get(id);
  if (!rec) {
    // Not in the Map: a durable job from a prior process (reconciled to a
    // terminal state at startup) or one evicted under the cap. Read the row and
    // replay its snapshot; there is no live runner in this process to attach to.
    if (!sink) return null;
    const row = await sink.read(principal.keyHash, id);
    return row ? snapshotStream(row) : null;
  }
  if (rec.ownerKeyHash !== principal.keyHash) return null;
  const enc = new TextEncoder();
  let sub: Sub | null = null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      sub = {
        write: (f) => {
          try {
            controller.enqueue(enc.encode(f));
          } catch {
            /* closed */
          }
        },
        close: () => {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        },
      };
      sub.write(frame("status", toPublic(rec)));
      if (isTerminal(rec.status)) {
        sub.write(terminalFrame(rec));
        sub.close();
        sub = null;
        return;
      }
      rec.subs.add(sub);
    },
    cancel() {
      if (sub) {
        rec.subs.delete(sub);
        sub = null;
      }
    },
  });
}

/**
 * Mark every still-running job `lost` — the server's stop cut it off, and an
 * in-memory job does not resume. Called from index.ts's SIGTERM drain after it
 * has waited its bound, so a poll or stream in flight sees a terminal answer.
 * Returns how many were cut, for the stop's log line.
 */
export function markRunningLost(): number {
  let n = 0;
  for (const rec of jobs.values()) {
    if (!isTerminal(rec.status)) {
      finish(rec, "lost", { error: { message: "the server stopped before the job finished; re-run it (an in-memory job does not survive a restart)", code: "SERVER_STOPPING" } });
      n++;
    }
  }
  return n;
}

/** How many jobs are pending or running — for the drain's line and tests. */
export function jobsRunning(): number {
  let n = 0;
  for (const rec of jobs.values()) if (rec.status === "pending" || rec.status === "running") n++;
  return n;
}

/** Test-only: drop every record and its timers, so a suite starts clean. */
export function resetJobsForTest(): void {
  for (const rec of jobs.values()) {
    if (rec.retentionTimer) clearTimeout(rec.retentionTimer);
    if (rec.maxRunTimer) clearTimeout(rec.maxRunTimer);
  }
  jobs.clear();
}

/** Test-only: the live record count. */
export function jobCountForTest(): number {
  return jobs.size;
}
