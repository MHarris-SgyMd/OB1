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
 * bounded under the platform's grace period (OB1_STOP_GRACE less 2 s, 8 s
 * under Docker's default), so a stuck call is cut off
 * here, with a line naming how many, rather than by the SIGKILL, with none;
 * that exit is 1. A second signal cuts the wait short the same way. The
 * bounds count from the handler, not from the signal's sending, so the stop
 * inside the grace period is a measurement (8.4–8.5 s for a cut at the
 * bound; about 9.0 s where a collector that hangs or refuses takes the
 * flush's last second, SMD-2902), not a guarantee.
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

/** The grace period a stop is given when OB1_STOP_GRACE is unset: Docker's default, which compose and `docker stop` use. */
export const DEFAULT_STOP_GRACE_S = 10;

/** What the drain leaves of the grace period, for the pool's close, the telemetry's flush (at most a second of it, FLUSH_MARGIN_MS before the kill, SMD-2902), the close of any streams held open (SMD-4347) and the exit. */
export const STOP_MARGIN_MS = 2_000;

/**
 * The shortest drain a grace period buys, however short it is: at 1 or 2 s the margin shrinks, and 0.5 s plus the
 * 250 ms close still fits; so do the two bounds of a stop that closes held streams after it (HELD_CLOSE_MS, 0.95 s
 * in all at a grace of 1 s, with every bound run out).
 */
export const MIN_DRAIN_MS = 500;

/** The longest grace period read: an hour. Past 2^31 ms a timer fires at once, which would cut every call. */
export const MAX_STOP_GRACE_S = 3_600;

/**
 * The drain's bound from OB1_STOP_GRACE, the platform's grace period in
 * whole seconds: that less STOP_MARGIN_MS, never under MIN_DRAIN_MS. Unset or
 * "" is DEFAULT_STOP_GRACE_S (8 s of drain under Docker's 10 s). Anything but
 * a whole number from 1 to MAX_STOP_GRACE_S is a problem: compose appends
 * `s` to the same variable for the server's `stop_grace_period`, so `1m`
 * would be a 1 ms kill, `0` an immediate one and `-1` no kill at all, while
 * the server planned another drain (review pass 4). Preflight refuses such a
 * value, so under compose the container stops before it serves; run another
 * way, the server says so and drains as for the default. Set it to the
 * platform's (Kubernetes' and ECS's 30, Fly's `kill_timeout`). It was a
 * constant 8 s until the maintainer's decision after review pass 3.
 */
export function drainBoundFrom(raw: string | undefined, fallbackS = DEFAULT_STOP_GRACE_S): { graceS: number; drainBoundMs: number; problem: string | null } {
  const text = raw?.trim() ?? "";
  const n = /^\d+$/.test(text) ? Number(text) : NaN;
  const valid = n >= 1 && n <= MAX_STOP_GRACE_S;
  const graceS = valid ? n : fallbackS;
  return {
    graceS,
    drainBoundMs: Math.max(MIN_DRAIN_MS, Math.round(graceS * 1000 - STOP_MARGIN_MS)),
    problem: text && !valid ? `OB1_STOP_GRACE="${text}" is not a whole number of seconds from 1 to ${MAX_STOP_GRACE_S}, with no unit (compose appends "s" for the server's stop_grace_period); the stop drains as for ${fallbackS} s (SMD-2250)` : null,
  };
}

/** How long the requests in flight are waited on by default: under Docker's 10 s, with room for the pool to close. */
export const DRAIN_BOUND_MS = drainBoundFrom(undefined).drainBoundMs;

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

/**
 * How often the drain looks for the requests still in flight when a server holds streams open on purpose (`held`,
 * SMD-4347): Bun's `stop()` resolves only when every response body has ended, a held stream's among them, and says
 * nothing as each other request ends.
 */
export const HELD_POLL_MS = 20;

/** How often the stop looks for the closed streams' answers to have ended: a turn or two of the event loop, as a rule. */
export const HELD_LEFT_POLL_MS = 2;

/**
 * The most the stop gives the held streams to be closed, and then their answers to end, each: 0.2 s in all, and only
 * where a close hangs; closing them takes a few milliseconds. Both come out of the flush's bound, so the latest a
 * stop can end is as it was, a second before the kill, at a grace of 2 s or more. A stop whose flush ends early (no
 * collector, or one that answers) can end up to 0.2 s later than it would have; at a grace of 1 s the latest is
 * 0.95 s where it was 0.75; and after a second signal, which leaves the flush the close's bound alone, the two are added.
 */
export const HELD_CLOSE_MS = 100;

/**
 * The most the stop gives its telemetry flush (SMD-2902): a collector that
 * answers in a second or two gets what was batched, and one that is down —
 * whose exports retry for up to their own timeout, 10 s, and fail all the
 * same — adds at most this to the stop. Nothing orders the observability
 * profile's collector after the servers, so a `compose down` or an upgrade
 * can stop it first.
 */
export const FLUSH_BUDGET_MS = 5_000;

/** What the flush leaves of the grace period, before the platform's kill. */
export const FLUSH_MARGIN_MS = 1_000;

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

/**
 * How the telemetry's flush ended (SMD-1849 PR 2b; PR 2c's metrics and log
 * records with the spans), counted from the stop's mark at its signal
 * (SMD-3297): everything exported since went (`sent`); an export of some signal
 * failed since (`failed`); nothing was exported, or on its way, since (`none`);
 * or it outlasted its time (`timeout`). With a metrics endpoint a stop is never
 * `none`: the uptime gauge (SMD-3050) is read at every flush, under either
 * temporality.
 */
export type FlushResult = "sent" | "failed" | "none" | "timeout";

export interface DrainOptions {
  /** The running server, once the first request has handed it over; undefined before, when nothing can be in flight. */
  server: () => Stoppable | undefined;
  /** Close the database pool: true once closed, false when none was ever opened. */
  close: () => Promise<boolean>;
  /**
   * Send the telemetry still batched or on its way (SMD-1849 PR 2b–2c); undefined
   * with no collector set. Run beside the close and said on its own, so a
   * collector that stalls is never read as a pool that did not close (review
   * pass 1), under a bound of its own (SMD-2902): FLUSH_BUDGET_MS, at most what
   * the grace period leaves less FLUSH_MARGIN_MS (and less the held streams'
   * two bounds, where `closeHeld` is given), never less than the close's.
   */
  flush?: () => Promise<FlushResult | undefined>;
  /**
   * Told first, as the signal comes: where each signal's exports stand, which
   * the flush counts from, so the stop's word says what the drain lost as well
   * as what its flush sent (SMD-3297).
   */
  mark?: () => void;
  /**
   * Told when the flush is cut — at its bound, or by a second signal — before
   * the stop's line: says what each signal still held as not sent, for `kind`
   * (SMD-2902).
   */
  unsent?: (kind: string) => void;
  /** The platform's grace period, which the flush's bound stays inside: DEFAULT_STOP_GRACE_S unless the server read OB1_STOP_GRACE. */
  graceMs?: number;
  /** The most the flush is given: FLUSH_BUDGET_MS outside a test. */
  flushBudgetMs?: number;
  /** The tool calls still running, waited on with the requests. */
  calls?: CallCount;
  /**
   * How many of the requests in flight are streams the server holds open on purpose (the MCP server's listen
   * streams, SMD-4347). The drain does not wait for these: they end when the stop ends them. Given with `closeHeld`.
   */
  held?: () => number;
  /**
   * Closes those streams, each with its own last word. Called last, after the flush: a client counts its wait for
   * the server's return from the end of its stream, so the later the stream ends, the more of that wait is the
   * restart's own. Awaited, to HELD_CLOSE_MS. Where it is given, no connection is closed at the bound, where it
   * would drop every held stream with no last word: every connection is closed after the streams are.
   */
  closeHeld?: () => Promise<void>;
  /**
   * Told as the drain ends, finished or cut, in the turn that decides it. A server that closes streams last keeps
   * its connections open through the flush, and Bun serves a request once it is whole on one of them: one whose
   * headers were half sent at the signal, which it keeps without counting, and on macOS one opened and never used
   * (Linux closes that one at the signal; both measured on 1.4.3). What arrives after this is not to be served, or
   * it would run with the stop no longer waiting on it, and be answered by a handler already closed (found in
   * review). Given with `closeHeld`.
   */
  afterDrain?: () => void;
  /** Told just before what is still in flight is closed — at the bound, or on a second signal — so the lines it leaves say the stop cut it. */
  onCut?: () => void;
  /**
   * Told just before the flush, on every path: ends what the server no longer
   * counts in flight but whose record is still open — a mirror whose client
   * left while its handler waits on the registry, which the runtime counts
   * done — so its line and its telemetry are written before the flush, not
   * never (SMD-1849 PR 2c review pass 3).
   */
  endOpen?: () => void;
  drainBoundMs?: number;
  closeBoundMs?: number;
  closeAfterCutMs?: number;
  log?: (line: string) => void;
  exit?: (code: number) => void;
  /** Where the handlers go; the process, outside a test. */
  on?: (signal: "SIGTERM" | "SIGINT", handler: () => void) => void;
}

const requests = (n: number) => `${n} request${n === 1 ? "" : "s"}`;
const heldStreams = (n: number) => `${n} stream${n === 1 ? "" : "s"} held open`;
const toolCalls = (n: number) => `${n} tool call${n === 1 ? "" : "s"}`;
const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Install the SIGTERM and SIGINT handlers. The returned promise settles when a stop has run to its exit, for a test. */
export function drainOnSignal(opts: DrainOptions): { stopped: Promise<number> } {
  const drainBoundMs = opts.drainBoundMs ?? DRAIN_BOUND_MS;
  const closeBoundMs = opts.closeBoundMs ?? CLOSE_BOUND_MS;
  const closeAfterCutMs = opts.closeAfterCutMs ?? CLOSE_AFTER_CUT_MS;
  const graceMs = opts.graceMs ?? DEFAULT_STOP_GRACE_S * 1000;
  const flushBudgetMs = opts.flushBudgetMs ?? FLUSH_BUDGET_MS;
  const log = opts.log ?? ((line: string) => console.log(line));
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const on = opts.on ?? ((signal, handler) => { process.on(signal, handler); });
  let settle: (code: number) => void = () => {};
  const stopped = new Promise<number>((resolve) => { settle = resolve; });
  // What a second signal ends: the drain while it runs, then the pool's close and the telemetry's flush.
  let cutShort: (() => void) | undefined;

  const stop = async (signal: string) => {
    const t0 = performance.now();
    // Guarded, as the cut's sink is: a mark that throws must not take the stop with it.
    try {
      opts.mark?.();
    } catch {}
    const server = opts.server();
    const calls = opts.calls;
    const running = () => (calls ? `, ${toolCalls(calls.running)} running` : "");
    // The streams held open on purpose are in the runtime's count and not in what the drain waits for.
    // Guarded, as each of the stop's callbacks is: a count that throws reads as no stream held, and what it would
    // have counted is then waited on as a request, to the bound.
    const held = () => {
      try {
        return opts.held?.() ?? 0;
      } catch {
        return 0;
      }
    };
    const inFlight = () => Math.max(0, (server?.pendingRequests ?? 0) - held());
    const heldAtStart = held();
    log(`${signal}: no longer accepting; ${requests(inFlight())} in flight${running()}, waited on for up to ${drainBoundMs / 1000} s (SMD-2250)${heldAtStart > 0 ? `; ${heldStreams(heldAtStart)}, closed last (SMD-4347)` : ""}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setTimeout> | undefined;
    // A second signal while the drain runs: the operator is not waiting for the rest, the flush included (review pass 1).
    let again = false;
    // A stop() that rejects has stopped accepting all the same; read as drained, not as an unhandled rejection that skips the close and the line.
    const stopping = server ? server.stop().then(() => true, () => true) : true;
    // With streams held, stop() does not resolve until they end, and they end last: what is waited on is the rest, looked for.
    // The requests and the calls are looked at together, so the drain's end is decided in one turn, with nothing in flight in it.
    const looked = opts.held && server;
    const rest: Promise<unknown> = looked
      ? new Promise<void>((resolve) => {
        const look = () => {
          if (inFlight() === 0 && (calls?.running ?? 0) === 0) resolve();
          else poll = setTimeout(look, HELD_POLL_MS);
        };
        look();
      })
      : Promise.all([stopping, calls?.idle()]);
    let drained = await Promise.race([
      rest.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), drainBoundMs); cutShort = () => { again = true; resolve(false); }; }),
    ]);
    clearTimeout(timer);
    clearTimeout(poll);
    // Cut with nothing left — the last request ended as the bound or a second
    // signal won the race — is a drain, not "0 still in flight … exit 1" (review pass 3).
    if (!drained && inFlight() === 0 && (calls?.running ?? 0) === 0) drained = true;
    if (!drained && server) {
      log(`${signal}: ${requests(inFlight())} still in flight${running()} after ${((performance.now() - t0) / 1000).toFixed(1)} s, closed unfinished`);
      // Guarded: a sink that throws must not take the flush and the exit with it (review pass 3).
      try {
        opts.onCut?.();
      } catch {}
      // Not awaited: Bun closes the sockets at once, but the promise waits
      // for every handler to settle, and one stalled before it returned a
      // response (a lookup on a database that never answers) would hold it
      // until the grace period's kill (review pass 1, measured on 1.4.0).
      // With streams to close last, the connections are closed after them
      // (below): here it would drop each stream with no last word.
      if (!opts.closeHeld) server.stop(true).catch(() => {});
    }
    // No await since the drain's end was decided: what is told here is true of every request that arrives after it.
    // Told only where there was a server to stop accepting: an entry that has served no request yet has none (it
    // learns its server from its first), and goes on listening until the exit, as it always has.
    if (server) {
      try {
        opts.afterDrain?.();
      } catch {}
    }
    // A drain that ended late gets what is left of the drain's bound plus the
    // after-cut close, so the exit-0 path cannot outlast the cut path (review pass 3).
    const closeMs = drained ? Math.round(Math.min(closeBoundMs, Math.max(closeAfterCutMs, drainBoundMs + closeAfterCutMs - (performance.now() - t0)))) : closeAfterCutMs;
    // The flush's own bound (SMD-2902): its budget, inside what the grace period
    // leaves before the kill, and never less than the close's — the bound it had;
    // after a second signal, the close's alone.
    // Where streams are closed after it, their two bounds come out of it.
    const heldMs = opts.closeHeld ? 2 * HELD_CLOSE_MS : 0;
    const flushMs = again ? closeMs : Math.round(Math.max(closeMs, Math.min(flushBudgetMs, graceMs - FLUSH_MARGIN_MS - heldMs - (performance.now() - t0))));
    try {
      opts.endOpen?.();
    } catch {}
    // The telemetry's flush beside the pool's close, each said on its own. The word is the stop's own, from its
    // signal's mark: what the flush sent of what was batched and the metrics' last reading, and every export lost
    // since the signal, in the drain or the flush. One lost before the signal was said on its own line when it was
    // lost, so a stop after one can say sent (SMD-3297).
    const said: Record<FlushResult, string> = { sent: "; telemetry sent", failed: "; telemetry not all sent", none: "; no telemetry left to send", timeout: `; telemetry not all sent within ${flushMs} ms` };
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let flushCut = () => {};
    // Once the flush has ended, a cut has nothing to say: its line already says how (review pass 1).
    let flushEnded = false;
    // What each signal still held, said once as the flush is cut — a collector that refuses is retried until then, and
    // one that hangs is waited on, so the kind is what is known: on its way, or still batched. Guarded, as the cut's sink is.
    const sayUnsent = (kind: string) => {
      if (flushEnded) return;
      flushEnded = true;
      try {
        opts.unsent?.(kind);
      } catch {}
    };
    const bySecondSignal = () => {
      sayUnsent("on its way or batched at a second signal");
      return "; telemetry not all sent: a second signal";
    };
    const flushed = opts.flush ? Promise.race([
      opts.flush().then((result) => {
        flushEnded = true;
        return result === undefined ? "" : said[result];
      }, () => {
        flushEnded = true;
        return said.failed;
      }),
      new Promise<string>((resolve) => {
        flushTimer = setTimeout(() => {
          if (again) return resolve(bySecondSignal());
          sayUnsent(`on its way or batched when the flush's ${flushMs} ms ran out`);
          resolve(said.timeout);
        }, flushMs);
        flushCut = () => resolve(bySecondSignal());
      }),
    ]) : Promise.resolve("");
    const closed = await Promise.race([
      opts.close().then((had) => (had ? "database pool closed" : "no database pool was opened"), (e: Error) => `database pool not closed: ${e.message}`),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(`database pool not closed within ${closeMs} ms`), closeMs);
        cutShort = () => {
          resolve("database pool not closed: a second signal");
          flushCut();
        };
      }),
    ]);
    clearTimeout(timer);
    const sent = await flushed;
    clearTimeout(flushTimer);
    // The streams held open, closed now, and the process not gone before what closing wrote has left. Measured on
    // the MCP server's entry: with the exit straight after the close, a stream's last word was lost; and with the
    // connections closed straight after it, lost again where the drain had finished (a reset in its place), though
    // not after a cut. So the stop waits for the streams' answers to have ended, which the runtime's count says by
    // falling by as many as were closed; then every connection is closed, the cut requests' and any with no
    // whole request on it yet, which the runtime's own end would wait on. A second signal ends either wait.
    let heldSaid = "";
    if (opts.closeHeld) {
      const closing = held();
      const before = server?.pendingRequests ?? 0;
      let hurried = false;
      const hurry = new Promise<void>((resolve) => { cutShort = () => { hurried = true; resolve(); }; });
      // A close that throws, at once or later, takes nothing with it.
      const closeHeld = opts.closeHeld;
      await Promise.race([Promise.resolve().then(() => closeHeld()).catch(() => {}), pause(HELD_CLOSE_MS), hurry]);
      if (server) {
        const until = performance.now() + HELD_CLOSE_MS;
        while (!hurried && server.pendingRequests > before - closing && performance.now() < until) await Promise.race([pause(HELD_LEFT_POLL_MS), hurry]);
        server.stop(true).catch(() => {});
      }
      const left = Math.min(closing, held());
      if (closing > 0) heldSaid = left === 0 ? `; ${heldStreams(closing)} closed` : `; ${left === closing ? "" : `${left} of `}${heldStreams(closing)} not closed`;
    }
    const code = drained ? 0 : 1;
    log(`${signal}: stopped in ${((performance.now() - t0) / 1000).toFixed(1)} s; ${closed}${sent}${heldSaid}; exit ${code}`);
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
