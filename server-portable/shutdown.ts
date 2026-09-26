/**
 * shutdown.ts — stopping on SIGTERM, finishing what is in flight (SMD-2250).
 *
 * The image runs the server as the container's PID 1 (`exec bun index.ts`, the
 * Dockerfile's ENTRYPOINT), and the kernel gives PID 1 no default action for
 * SIGTERM: a process there that installs no handler ignores it. Until this
 * module the server installed none, so every `docker stop`, compose restart
 * and upgrade waited out the grace period, 10 s by default, and ended in
 * SIGKILL (exit 137) with anything in flight cut off. Measured on the image's
 * Bun, in a probe of the image's shape: 10.3 s, 0.1 s with a handler.
 *
 * On the signal the server stops accepting, lets the requests in flight finish
 * (a tool call's SSE stream included — Bun's `server.stop()` waits for a
 * response body to end, and closes idle keep-alive sockets at once; measured
 * on 1.4.0) and the tool calls still running (`calls`: Bun counts a request
 * done once its client has gone, while its handler runs on to its end, and a
 * capture may still land), closes the database pool and exits 0. The wait is
 * bounded under Docker's default grace period, so a stuck call is cut off
 * here, with a line naming how many, rather than by the SIGKILL, with none;
 * that exit is 1. A second signal cuts the wait short the same way. The
 * bounds count from the handler, not from the signal's sending, so the stop
 * inside the grace period is a measurement (8.4–8.5 s for a cut at the
 * bound), not a guarantee.
 *
 * Bun only, and only when index.ts is the entry: Workers has no signals, and a
 * suite that imports the module must keep its own. jev/serve.ts handles the
 * signal for the same reason (SMD-2050), but exits as soon as it has called
 * `stop()`, which cuts off what is in flight.
 */

/** What stopping needs from the running server: Bun's `Server`, as its fetch handler receives it. */
export interface Stoppable {
  stop(closeActiveConnections?: boolean): Promise<void>;
  readonly pendingRequests: number;
}

/** True for Bun's `Server`; false for a Workers `env`, the other thing a fetch handler's second argument can be. */
export function isStoppable(x: unknown): x is Stoppable {
  return typeof (x as Stoppable | null)?.stop === "function" && typeof (x as Stoppable).pendingRequests === "number";
}

/**
 * How long the requests in flight are waited on. Under Docker's default grace
 * period of 10 s, which compose and `docker stop` use, with room for the pool
 * to close; a platform with a longer one (Kubernetes' 30 s) still stops here.
 */
export const DRAIN_BOUND_MS = 8_000;

/** How long the pool is given to close once nothing is in flight. */
export const CLOSE_BOUND_MS = 1_000;

/**
 * How long it is given after the stop has cut calls off, and at most what is
 * left of the drain's bound plus this after a drain that ended late: Bun's
 * `close()` waits for the queries still running, and the cut calls' queries
 * were stuck, so a full second only spends the margin under Docker's 10 s (a
 * cut at the bound measured 9.2–9.3 s with the 1 s close, review pass 2).
 */
export const CLOSE_AFTER_CUT_MS = 250;

/** The tool calls running, whatever became of their requests. */
export interface CallCount {
  readonly running: number;
  /** Settles once none is running; at once when none is. */
  idle(): Promise<void>;
}

/**
 * Counts the calls `track` runs (review pass 3). Bun's `pendingRequests`
 * and `stop()` see a request as done once its client has gone, and a tool
 * call runs on to its end after that — SMD-1864's line says so, and a capture
 * may still land — so without this a stop whose only call's client had just
 * left exited at once, and the capture was lost (measured, 0 of 2).
 */
export function createCallCount(): CallCount & { track<T>(run: () => T | Promise<T>): Promise<T> } {
  let running = 0;
  let waiters: (() => void)[] = [];
  return {
    get running() { return running; },
    idle: () => (running === 0 ? Promise.resolve() : new Promise<void>((resolve) => { waiters.push(resolve); })),
    async track(run) {
      running++;
      try {
        return await run();
      } finally {
        if (--running === 0) { for (const resolve of waiters) resolve(); waiters = []; }
      }
    },
  };
}

export interface DrainOptions {
  /** The running server, once the first request has handed it over; undefined before, when nothing can be in flight. */
  server: () => Stoppable | undefined;
  /** Close the database pool: true once closed, false when none was ever opened. */
  close: () => Promise<boolean>;
  /** The tool calls still running, waited on with the requests. */
  calls?: CallCount;
  /** Told just before the requests still in flight at the bound are closed, so the lines they leave say the stop cut them. */
  onCut?: () => void;
  drainBoundMs?: number;
  closeBoundMs?: number;
  closeAfterCutMs?: number;
  log?: (line: string) => void;
  exit?: (code: number) => void;
  /** Where the handlers go; the process, outside a test. */
  on?: (signal: "SIGTERM" | "SIGINT", handler: () => void) => void;
}

const requests = (n: number) => `${n} request${n === 1 ? "" : "s"}`;
const toolCalls = (n: number) => `${n} tool call${n === 1 ? "" : "s"}`;

/** Install the SIGTERM and SIGINT handlers. The returned promise settles when a stop has run to its exit, for a test. */
export function drainOnSignal(opts: DrainOptions): { stopped: Promise<number> } {
  const drainBoundMs = opts.drainBoundMs ?? DRAIN_BOUND_MS;
  const closeBoundMs = opts.closeBoundMs ?? CLOSE_BOUND_MS;
  const closeAfterCutMs = opts.closeAfterCutMs ?? CLOSE_AFTER_CUT_MS;
  const log = opts.log ?? ((line: string) => console.log(line));
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const on = opts.on ?? ((signal, handler) => { process.on(signal, handler); });
  let settle: (code: number) => void = () => {};
  const stopped = new Promise<number>((resolve) => { settle = resolve; });
  // What a second signal ends: the drain while it runs, then the pool's close.
  let cutShort: (() => void) | undefined;

  const stop = async (signal: string) => {
    const t0 = performance.now();
    const server = opts.server();
    const calls = opts.calls;
    const running = () => (calls ? `, ${toolCalls(calls.running)} running` : "");
    log(`${signal}: no longer accepting; ${requests(server?.pendingRequests ?? 0)} in flight${running()}, waited on for up to ${drainBoundMs / 1000} s (SMD-2250)`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let drained = await Promise.race([
      Promise.all([
        // A stop() that rejects has stopped accepting all the same; read as drained, not as an unhandled rejection that skips the close and the line.
        server ? server.stop().then(() => true, () => true) : true,
        calls?.idle(),
      ]).then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), drainBoundMs); cutShort = () => resolve(false); }),
    ]);
    clearTimeout(timer);
    // Cut with nothing left — the last request ended as the bound or a second
    // signal won the race — is a drain, not "0 still in flight … exit 1" (review pass 3).
    if (!drained && (server?.pendingRequests ?? 0) === 0 && (calls?.running ?? 0) === 0) drained = true;
    if (!drained && server) {
      log(`${signal}: ${requests(server.pendingRequests)} still in flight${running()} after ${((performance.now() - t0) / 1000).toFixed(1)} s, closed unfinished`);
      opts.onCut?.();
      // Not awaited: Bun closes the sockets at once, but the promise waits
      // for every handler to settle, and one stalled before it returned a
      // response (a lookup on a database that never answers) would hold it
      // until the grace period's kill (review pass 1, measured on 1.4.0).
      server.stop(true).catch(() => {});
    }
    // A drain that ended late gets what is left of the drain's bound plus the
    // after-cut close, so the exit-0 path cannot outlast the cut path (review pass 3).
    const closeMs = drained ? Math.round(Math.min(closeBoundMs, Math.max(closeAfterCutMs, drainBoundMs + closeAfterCutMs - (performance.now() - t0)))) : closeAfterCutMs;
    const closed = await Promise.race([
      opts.close().then((had) => (had ? "database pool closed" : "no database pool was opened"), (e: Error) => `database pool not closed: ${e.message}`),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(`database pool not closed within ${closeMs} ms`), closeMs);
        cutShort = () => resolve("database pool not closed: a second signal");
      }),
    ]);
    clearTimeout(timer);
    const code = drained ? 0 : 1;
    log(`${signal}: stopped in ${((performance.now() - t0) / 1000).toFixed(1)} s; ${closed}; exit ${code}`);
    settle(code);
    exit(code);
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    on(signal, () => {
      if (cutShort) { log(`${signal} again: not waiting for the rest`); cutShort(); return; }
      cutShort = () => {};
      void stop(signal);
    });
  }
  return { stopped };
}
