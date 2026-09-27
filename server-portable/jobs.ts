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
 * The store is a single in-memory Map, deliberately (the durability the first
 * consumers need, weighed in the SMD-2273 plan): it fits the single-process Bun
 * server, needs no migration, and a job it holds does not survive a restart. A
 * job still running when the process stops is marked `lost` (`markRunningLost`,
 * from index.ts's SIGTERM drain) so an in-flight poll or stream sees a terminal
 * answer rather than hanging; after a restart the Map is empty, so a poll for a
 * job that was running gets `not found` — told it is gone, not left waiting. A
 * durable `jobs` table (with a `worker_status`-style read and retention) is the
 * fast-follow when a consumer needs a job to survive a restart or a second
 * replica. On Workers there is no long-lived process to hold the Map or run the
 * detached body past the response, so job handles are a Bun-server feature; the
 * REST routes still answer, they just never hold a running job.
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
  };
  jobs.set(id, rec);

  const ctx: JobContext = {
    signal: rec.abort.signal,
    progress(done, total, message) {
      if (isTerminal(rec.status)) return;
      rec.progress = { done, total, ...(message !== undefined ? { message } : {}) };
      broadcast(rec, frame("progress", rec.progress));
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
    broadcast(rec, frame("status", toPublic(rec)));
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

/** The ownership-checked projection of a job, or null when the id is unknown or the key is not its owner. */
export function readJob(principal: Pick<JobPrincipal, "keyHash">, id: string): PublicJob | null {
  const rec = jobs.get(id);
  if (!rec || rec.ownerKeyHash !== principal.keyHash) return null;
  return toPublic(rec);
}

/**
 * An SSE body for a job: the current status at once, then a `progress` event per
 * update and a terminal `done`/`error` event, after which the stream closes. A
 * job that is already terminal gets its snapshot and terminal event and closes.
 * Null when the id is unknown or the key is not its owner (the route answers as
 * it does for the poll). The route sets `content-type: text/event-stream` and
 * wraps this in withSseKeepalive.
 */
export function subscribe(principal: Pick<JobPrincipal, "keyHash">, id: string): ReadableStream<Uint8Array> | null {
  const rec = jobs.get(id);
  if (!rec || rec.ownerKeyHash !== principal.keyHash) return null;
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
