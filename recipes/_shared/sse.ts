// A response stream kept alive while a call runs (SMD-1864), for every server
// that answers with an event stream — the MCP transport's replies and the job
// streams (SMD-2273). Moved out of index.ts (SMD-2284) so the REST core keeps
// its streams alive with the same frame and the same ceiling. The vendored MCP
// servers answer on the same kind of stream (@hono/mcp's transport, which pings
// only a GET's stream), so a byte-for-byte copy of this file sits in
// extensions/_shared/, recipes/_shared/ and integrations/_shared/ beside
// auth.ts's, and each of those servers sends its reply through mcpReply below
// (SMD-2001). `bun run sync-sse` in extensions/ rewrites the copies from this
// file; extensions/test-auth.ts fails if one differs or a server skips it. It
// imports nothing, and everything here runs as it is on Bun, Node, Deno and Workers.
//
// The transport answers a POST with an SSE stream at once and writes the tool's
// result to it when the tool returns; until then the stream carries nothing
// (the core's SDK v2 transport adds its own keepalive comment every 15 s,
// longer than the silence Bun allows; the vendored servers' none).
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
 * since `startedAt` (the timer stops, `stalledLine` — stalledRequestLine
 * unless given — is logged for `label` and `onStall` runs once — the route marks the request settled, so
 * the runtime's reap that follows on Bun is not logged as a client leaving; on
 * Node or Workers nothing reaps a silent stream, and it stays open until the
 * client or a proxy gives up). A response that is not an event stream is
 * returned as it is, `onEnd` run at once: it is complete. `onEnd` is told the
 * bytes the body carried, this function's own keepalive frames apart — the
 * MCP SDK's transport writes its own every 15 s, part of the body it hands
 * here, and those are counted (none for a response returned as it is).
 * `onCancel` runs if the body is cancelled before it ends — the reader let go
 * of it, as a runtime does when the client leaves — so a caller waiting on
 * its end hears that it will not come, even where `signal` never aborts.
 * Measured on Bun 1.4.0: a reader's cancel and a client leaving a socket both
 * reach it; so does a source stream that errors, which none of this file's
 * callers' streams do. Other runtimes are unmeasured: where one does not call
 * a transformer's `cancel`, the next keepalive frame finds the stream closed
 * and runs it then. Should a runtime close the stream before calling
 * `cancel`, it could run twice (that frame, then the cancel), so a caller
 * makes it idempotent.
 */
export function withSseKeepalive(
  response: Response,
  opts: {
    intervalMs?: number; maxMs?: number; startedAt?: number; signal?: AbortSignal; onEnd?: (bytes?: number) => void; onStall?: () => void; onCancel?: () => void; label?: string;
    stalledLine?: (label: string, elapsedMs: number) => string;
  } = {},
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
  let bytes = 0;
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
          console.warn((opts.stalledLine ?? stalledRequestLine)(opts.label ?? "?", elapsed));
          opts.onStall?.();
          return;
        }
        try {
          controller.enqueue(SSE_KEEPALIVE_FRAME);
        } catch {
          stop(); // the readable side closed under the timer: the client left
          opts.onCancel?.(); // said here too, for a runtime that never calls the transformer's cancel
        }
      }, intervalMs);
    },
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    flush() {
      stop(); // the transport closed the stream: the response is complete
      opts.onEnd?.(bytes);
    },
    cancel() {
      stop(); // the reader let go: no end will come
      opts.onCancel?.();
    },
    // Cast: the WHATWG Transformer has `cancel`, and Bun runs it, but neither
    // bun-types nor lib.dom declares it yet.
  } as Transformer<Uint8Array, Uint8Array>);
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

/**
 * The same, from a vendored server (review pass 3). The core's advice does not
 * carry over: of these servers only kubernetes-deployment calls a provider,
 * under its own OB1_LLM_TIMEOUT (SMD-2692), which may be set past the ceiling,
 * and the rest make queries alone. So the line names neither that bound nor the
 * database alone: the stuck part is a provider call or a query, and the
 * server's own log above it says which.
 */
export function vendoredStalledLine(label: string, elapsedMs: number): string {
  return `request still running after ${Math.round(elapsedMs / 1000)} s: ${label} — the keepalive stops here and the runtime's idle timeout takes over; the call is stuck on a provider call or a query (SMD-2001)`;
}

/**
 * What a log line may say about a request: the JSON-RPC method and, for a
 * tool call, the tool's name — never the arguments, which are the thought —
 * each as `labelPart` admits it, since both are the caller's strings. A batch
 * is named by its first message; anything unreadable is `?`.
 */
export function requestLabel(bodyText: string | null): string {
  try {
    const parsed: unknown = JSON.parse(bodyText ?? "");
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const msg = (first ?? {}) as { method?: unknown; params?: { name?: unknown } };
    const method = typeof msg.method === "string" ? labelPart(msg.method) : "?";
    return typeof msg.params?.name === "string" ? `${method} ${labelPart(msg.params.name)}` : method;
  } catch {
    return "?";
  }
}

/**
 * The line the server logs when a client closes the connection before the
 * response is complete — the trace SMD-1864's captures never left. The tool
 * runs to its end regardless (a capture may still land), which the line says,
 * so an operator reading a duplicate row later knows where it came from.
 */
export function abandonedRequestLine(label: string, elapsedMs: number): string {
  return `request abandoned by the client after ${(elapsedMs / 1000).toFixed(1)} s: ${label} — the connection closed before the response was complete; the call runs to its end on this side, so a capture may still have landed (SMD-1864)`;
}

/**
 * A vendored MCP server's reply, given the two things the core route gives its
 * own (SMD-2001): the stream kept alive by withSseKeepalive while the tool
 * runs, and a client that leaves before the reply is complete logged once with
 * abandonedRequestLine, named by requestLabel.
 *
 * `c` is the route's Hono context, typed by the two members read here:
 * `c.req.raw`, the request as it came (its signal is the client's), and
 * `c.req.text()`, its body. Hono caches the text, and @hono/mcp's transport
 * reads `ctx.req.json()` from that cache, so it sees the same body. The SDK v2
 * transport (SMD-2279) reads the raw Request stream instead, which this read
 * will have drained: that move must hand it a Request rebuilt from the text,
 * as the core route does (SMD-2278). `respond` is the transport's
 * handleRequest.
 *
 * The watch starts after the key check and the server's build, which take
 * nothing long, and its listener comes before the body read, so a client that
 * leaves mid-upload is logged, as `?`. Then:
 * - a method other than POST carries no call: its reply is respond()'s as it
 *   is, body unread, close unwatched — ob-graph hands a GET to the transport,
 *   whose stream only the client ends;
 * - a client already gone gets the line and a 408, and the tool never runs
 *   (unlike at the core route, the server has been built);
 * - a reply that is not an event stream (JSON, a 202, a refusal) comes back as
 *   it is, and a respond() that throws settles the request and throws;
 * - a stream held to the ceiling is logged with vendoredStalledLine.
 */
export async function mcpReply(
  c: { req: { raw: Request; text(): Promise<string> } },
  respond: () => Promise<Response | undefined> | Response | undefined,
): Promise<Response | undefined> {
  const req = c.req.raw;
  if (req.method !== "POST") return respond();
  const started = performance.now();
  let label = "?";
  let settled = false;
  const settle = () => { settled = true; };
  const abandoned = () => {
    if (!settled) console.warn(abandonedRequestLine(label, performance.now() - started));
  };
  // A listener added to a signal already aborted never fires, so that case is logged by hand.
  req.signal.addEventListener("abort", abandoned, { once: true });
  if (req.signal.aborted) abandoned();
  else label = requestLabel(await c.req.text().catch(() => null));
  if (req.signal.aborted) {
    // Gone before the call: logged once (by the listener or above), and no call.
    settle();
    return new Response(null, { status: 408 });
  }
  let response: Response | undefined;
  try {
    response = await respond();
  } catch (e) {
    settle();
    throw e;
  }
  if (!response) {
    settle();
    return response;
  }
  return withSseKeepalive(response, { signal: req.signal, label, startedAt: started, onEnd: settle, onStall: settle, stalledLine: vendoredStalledLine });
}
