// A response stream kept alive while a call runs (SMD-1864), for every server
// that answers with an event stream — the MCP transport's replies and the job
// streams (SMD-2273). Moved out of index.ts (SMD-2284) so the REST core keeps
// its streams alive with the same frame and the same ceiling. A byte-for-byte
// copy sat in extensions/_shared/ for the vendored MCP servers, with mcpReply
// and vendoredStalledLine for their replies (SMD-2001), until the last of those
// servers retired (SMD-2311) and the copy with them (SMD-3747). It imports
// nothing, and everything here runs as it is on Bun, Node, Deno and Workers.
//
// The transport answers a POST with an SSE stream at once and writes the tool's
// result to it when the tool returns; until then the stream carries nothing
// (the MCP server's SDK v2 transport adds its own keepalive comment every 15 s,
// longer than the silence Bun's default allows).
// Bun closes a connection that has been silent for `idleTimeout` seconds — 10
// by default — at the next of its 4-second sweeps, so between 8 and 12 s of
// silence by phase. What it closes, measured on 1.4.3 (SMD-2931), each case
// silent for 14 s at the default: a streamed response, at 12 s — the client
// sees ECONNRESET, and the handler runs on to write into a closed stream; a
// GET whose handler has not answered yet, the same; but not a POST whose
// handler has not answered, which runs to its end. At 255 all three answer. A
// comment frame every 5 s keeps a stream open. A capture whose embedding and
// metadata calls ran past ten seconds was the stream's case (9.76 s,
// deterministically, on the dogfood brain, SMD-1864), with no line in the
// server's log. So every SSE response leaves through withSseKeepalive: a
// `: keepalive` comment — a line SSE parsers discard by specification, so no
// client sees an event — every SSE_KEEPALIVE_MS for the life of the stream,
// until the transport closes it or the client goes, when the timer stops
// itself. Half the default, so a stream is never silent for a whole sweep; a
// proxy's read timeout in front of the server (SMD-1846) is kept the same way.
//
// The brain's own servers serve with Bun's ceiling, 255 s (IDLE_TIMEOUT_S in
// server-portable/api.ts and mcp-server/index.ts), for the GET the keepalive
// cannot reach: the MCP server's job polls and mirrors are GETs that a locked
// table can hold past 10 s (SMD-2287); test-rest [16] measures the cut on
// every run. Their streams keep the keepalive, for the proxy and for a call
// past 255 s.
export const SSE_KEEPALIVE_MS = 5_000;

/**
 * How long a stream is kept alive at most. A provider call is bounded by
 * OB1_LLM_TIMEOUT (120 s, embed.ts) and a capture makes a few; a database
 * write is bounded by nothing — a transaction stuck on upsert_thought's
 * fingerprint lock (033) would hold every concurrent capture of that thought,
 * and with an unbounded keepalive each would hold a stream and a timer for
 * hours with no line anywhere. Past this the timer stops, one line says so,
 * and the runtime's idle timeout takes over (on Bun, 255 s of silence on the
 * REST core's streams): a call this long is stuck, not slow. (Review pass 1.)
 * The MCP server's streams are never that
 * silent, its SDK transport writing its own frame every 15 s, so they end with
 * the call, whose request to the REST core ends at this same bound
 * (mcp-server/app.ts's REST_TIMEOUT_MS; SMD-2931).
 */
export const SSE_KEEPALIVE_MAX_MS = 10 * 60_000;

/** The SSE comment frame the keepalive writes. A line beginning `:` is a comment (WHATWG, "event stream interpretation"): every parser drops it. */
const SSE_KEEPALIVE_FRAME = new TextEncoder().encode(": keepalive\n\n");

/**
 * The response with its SSE body kept alive: a comment frame every
 * `intervalMs` until the body ends (`onEnd` runs once, then), the client
 * leaves (`signal` aborts, or the next frame finds the stream closed — either
 * stops the timer, so an abandoned call leaks nothing), or `maxMs` passes
 * since `startedAt` (the timer stops, stalledRequestLine is logged for
 * `label` and `onStall` runs once — the route marks the request settled, so
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
          console.warn(stalledRequestLine(opts.label ?? "?", elapsed));
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
