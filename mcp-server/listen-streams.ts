// The 2026-07-28 listen streams this server holds (SMD-4347, docs/mcp-listen-streams.md): whether it holds them at
// all, how many, and what the entry's stop needs of them.
//
// A client opens `subscriptions/listen`, a POST whose answer is a stream that stays open. This server sends no
// notification on it. Holding it is the point: a restart of this server ends the stream, and a client that sees its
// stream end asks for it again and lists its tools again.

/**
 * Whether this server holds a listen stream open. It then declares `tools.listChanged: true` on 2026-07-28, and a
 * client told so opens one; told `false`, it opens none (Claude Code, measured).
 *
 * `false` until the stop, the stream's record and the caps have landed and been run against a real client (PR 2b).
 * One word, in a module of its own, and read by the entry alone: no setting turns it on. The suite's own apps are
 * given `createListenStreams(true, …)`, and its spawned entry is started with this module swapped for one that says
 * `true` (test-listen-on.ts, a preload).
 */
export const HOLD_LISTEN_STREAMS = false;

/**
 * The most streams this server holds at once, counted by the route with the bound below. The SDK's own bound for
 * the whole server, 1,024 as it comes, is set to this too: what a stream the route's count has lost would run into.
 */
export const LISTEN_STREAMS_MAX = 256;

/**
 * The most it holds under one caller's name. One name is every session of one key, so this counts sessions, not
 * clients; the SDK has no such bound, and one caller could fill the server's (prototyped: 1,024 in a fraction of a second).
 */
export const LISTEN_STREAMS_PER_CALLER = 32;

/** The listen streams of one app: its settings, and what the app says back to its entry. */
export interface ListenStreams {
  /** Whether a stream is held open at all. */
  readonly hold: boolean;
  /** The most held at once. */
  readonly max: number;
  /** The most held under one caller's name. */
  readonly perCaller: number;
  /** How many are open now: kept by the app. */
  count: number;
  /**
   * Ends every open stream with the SDK's closing frame: the app's, for the entry's stop, which calls it after its
   * flush, or at its cut. It closes the SDK's handler with them, so no 2026-07-28 request is served after it.
   */
  close: () => Promise<void>;
  /**
   * Records the end of every stream still open, as ended by the stop (SMD-4459): the app's, for the entry's stop,
   * which calls it as its drain ends. That is before its flush, so the records are sent, where the streams themselves
   * are closed after it; each is counted until then, and its close records nothing more.
   */
  stopped: () => void;
  /**
   * How many streams are held whose end is not yet said: the app's. It is `count` until the stop's word and 0 after
   * it, and a suite holds it there, so that a stream whose end was said is not kept (SMD-4459, review pass 2).
   */
  unsaid: () => number;
}

/** An app's listen streams: the entry's with no argument, a suite's with what it tests. */
export function createListenStreams(hold: boolean = HOLD_LISTEN_STREAMS, max: number = LISTEN_STREAMS_MAX, perCaller: number = LISTEN_STREAMS_PER_CALLER): ListenStreams {
  return { hold, max, perCaller, count: 0, close: async () => {}, stopped: () => {}, unsaid: () => 0 };
}
