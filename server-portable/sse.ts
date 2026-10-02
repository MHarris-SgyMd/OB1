// A response stream kept alive while a call runs (SMD-1864), for every server
// that answers with an event stream — the MCP transport's replies and the job
// streams (SMD-2273). Moved out of index.ts (SMD-2284) so the REST core keeps
// its streams alive with the same frame and the same ceiling.
//
// The transport answers a POST with an SSE stream at once and writes the tool's
// result to it when the tool returns; until then the stream carries nothing.
// Bun closes a connection that has been silent for `idleTimeout` seconds — 10
// by default — a streaming response included, at the next of its 4-second
// sweeps, so between 8 and 12 s of silence by phase; it never reaches into a
// handler that has not yet returned a response. Measured on 1.4.0, macOS and
// the Alpine image alike: a handler still pending at 12 s answers normally,
// body read or not, on a fresh or a reused socket; a streamed response silent
// for 13 s is closed at the sweep, the client sees ECONNRESET, and the handler
// runs on to write into a closed stream; a comment frame every 5 s keeps it
// open. A capture whose embedding and metadata calls ran past ten seconds was
// that second case (9.76 s, deterministically, on the dogfood brain), with no
// line in the server's log. So every SSE response leaves through
// withSseKeepalive: a `: keepalive` comment — a line SSE parsers discard by
// specification, so no client sees an event — every SSE_KEEPALIVE_MS for the
// life of the stream, until the transport closes it or the client goes, when
// the timer stops itself. The idle timeout itself stays at the runtime's
// default: its job is reaping dead keep-alive sockets, and raising it to the
// ceiling of 255 s would move the cliff a long capture falls off rather than
// remove it, and let a dead socket linger 25× longer. Half the default, so a
// stream is never silent for a whole sweep; a proxy's read timeout in front of
// the server (SMD-1846) is kept the same way.
export const SSE_KEEPALIVE_MS = 5_000;

/**
 * How long a stream is kept alive at most. A provider call is bounded by
 * OB1_LLM_TIMEOUT (120 s, embed.ts) and a capture makes a few; a database
 * write is bounded by nothing — a transaction stuck on upsert_thought's
 * fingerprint lock (033) would hold every concurrent capture of that thought,
 * and with an unbounded keepalive each would hold a stream and a timer for
 * hours with no line anywhere. Past this the timer stops, one line says so,
 * and the runtime's idle timeout takes over: a call this long is stuck, not
 * slow. (Review pass 1.)
 */
export const SSE_KEEPALIVE_MAX_MS = 10 * 60_000;

/** The SSE comment frame the keepalive writes. A line beginning `:` is a comment (WHATWG, "event stream interpretation"): every parser drops it. */
const SSE_KEEPALIVE_FRAME = new TextEncoder().encode(": keepalive\n\n");

/**
 * The response with its SSE body kept alive: a comment frame every
 * `intervalMs` until the body ends (`onEnd` runs once, then), the client
 * leaves (`signal` aborts, or the next frame finds the stream closed — either
 * stops the timer, so an abandoned call leaks nothing), or `maxMs` passes
 * since `startedAt` (the timer stops, `stalledRequestLine` is logged for
 * `label` and `onStall` runs once — the route marks the request settled, so
 * the runtime's reap that follows on Bun is not logged as a client leaving; on
 * Node or Workers nothing reaps a silent stream, and it stays open until the
 * client or a proxy gives up). A response that is not an event stream is
 * returned as it is, `onEnd` run at once: it is complete.
 */
export function withSseKeepalive(
  response: Response,
  opts: { intervalMs?: number; maxMs?: number; startedAt?: number; signal?: AbortSignal; onEnd?: () => void; onStall?: () => void; label?: string } = {},
): Response {
  const body = response.body;
  if (!body || !/^text\/event-stream\b/i.test(response.headers.get("content-type") ?? "")) {
    opts.onEnd?.();
    return response;
  }
  const intervalMs = opts.intervalMs ?? SSE_KEEPALIVE_MS;
  const maxMs = opts.maxMs ?? SSE_KEEPALIVE_MAX_MS;
  const started = opts.startedAt ?? performance.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    opts.signal?.removeEventListener("abort", stop);
  };
  const keepalive = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        const elapsed = performance.now() - started;
        if (elapsed >= maxMs) {
          stop();
          console.warn(stalledRequestLine(opts.label ?? "?", elapsed));
          opts.onStall?.();
          return;
        }
        try {
          controller.enqueue(SSE_KEEPALIVE_FRAME);
        } catch {
          stop(); // the readable side closed under the timer: the client left
        }
      }, intervalMs);
    },
    flush() {
      stop(); // the transport closed the stream: the response is complete
      opts.onEnd?.();
    },
  });
  opts.signal?.addEventListener("abort", stop, { once: true });
  if (opts.signal?.aborted) stop(); // gone before the stream was built: nothing to keep alive
  return new Response(body.pipeThrough(keepalive), { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** A caller's string as a log line may carry it: printable ASCII only — a newline would forge a second line — and at most this many characters. */
const LABEL_PART_MAX = 64;
export const labelPart = (s: string): string => s.replace(/[^\x20-\x7e]/g, "?").slice(0, LABEL_PART_MAX);

/** The line logged when a stream has been kept alive for SSE_KEEPALIVE_MAX_MS: the call is stuck, and the keepalive lets go. */
export function stalledRequestLine(label: string, elapsedMs: number): string {
  return `request still running after ${Math.round(elapsedMs / 1000)} s: ${label} — the keepalive stops here and the runtime's idle timeout takes over; a provider call is bounded by OB1_LLM_TIMEOUT, so look at the database (SMD-1864)`;
}
