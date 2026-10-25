/**
 * test-support.ts — driving the server over MCP, once instead of five times.
 *
 * Five files carried a near-identical JSON-RPC client: build the envelope, POST
 * it, cope with the response arriving either as JSON or as an SSE `data:` line,
 * unwrap `result.content`, and turn `isError` into a throw. Small enough to copy
 * and just subtle enough to copy wrong — the SSE fallback in particular, which is
 * easy to omit and only fails on transports that use it.
 */

/** A server a suite drives: its fetch, as Bun.serve takes it, and the MCP server's tool calls running and keepalive timing. */
export type ServerUnderTest = {
  fetch: (req: Request) => Response | Promise<Response>;
  toolCallsRunning: () => number;
  useKeepaliveTiming: (next: { intervalMs: number; maxMs: number }) => { intervalMs: number; maxMs: number };
};

/** The forward-scope key mcp-server/stack.ts adds to MCP_ACCESS_KEYS: the carrier (`act`) on every write through it. */
export const SUITE_CARRIER = "mcp-server-suite";

/**
 * Whether the server mcpUnderTest() loaded is the MCP server, read from what
 * its stack leaves behind (its carrier in MCP_ACCESS_KEYS): a suite asserts
 * it, so a loader that stops loading the stack fails the run (SMD-2287 PR 3b
 * review pass 1 found such a switch running index.ts twice).
 */
export function servedByMcpServer(): boolean {
  return (process.env.MCP_ACCESS_KEYS ?? "").split(",").some((entry) => entry.startsWith(`${SUITE_CARRIER}:`));
}

/**
 * The MCP server a suite drives (SMD-2287): the MCP server as a client of the
 * REST core, with the REST core behind it in the same process
 * (mcp-server/stack.ts). Call it after the suite has set its environment. The
 * stack's path is read at run time, so this file's typecheck does not reach
 * mcp-server's packages, which its own directory installs.
 */
export async function mcpUnderTest(): Promise<ServerUnderTest> {
  const stack = "../mcp-server/stack.ts";
  return (await import(stack)).default as ServerUnderTest;
}

export type McpClient = {
  /** Call a tool and return its joined text content. Throws on a tool error. */
  call: (name: string, args?: Record<string, unknown>) => Promise<string>;
  /** Issue a raw JSON-RPC method, for `tools/list` and the handshake. */
  rpc: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readonly base: string;
};

/**
 * `key` goes in the `x-brain-key` header rather than the query string. Both work,
 * but a header keeps the credential out of anything that logs a URL — which is the
 * habit the suites should demonstrate.
 */
export function mcpClient(base: string, key: string): McpClient {
  let id = 1;

  async function rpc(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const r = await fetch(base, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "x-brain-key": key,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
    });
    const text = await r.text();
    // StreamableHTTP may answer as JSON or as a single SSE frame; both are valid
    // and the suites must not care which the transport chose.
    const line = text.startsWith("{")
      ? text
      : (text.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6);
    return JSON.parse(line) as Record<string, unknown>;
  }

  async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const body = (await rpc("tools/call", { name, arguments: args })) as {
      error?: unknown;
      result?: { content?: { text?: string }[]; isError?: boolean };
    };
    if (body.error) throw new Error(`JSON-RPC error: ${JSON.stringify(body.error)}`);
    const joined = (body.result?.content ?? []).map((c) => c.text ?? "").join("\n");
    if (body.result?.isError) throw new Error(`tool error: ${joined}`);
    return joined;
  }

  return { call, rpc, base };
}

/**
 * A port that refuses, for a stub that must refuse until it binds or a database that refuses: free when picked, and
 * below the kernels' default ranges for port 0 (Linux 32768–60999, macOS 49152–65535), so no server bound at port 0,
 * a child at PORT 0 included, can be handed it once it is freed (SMD-3296). Free when bound on 127.0.0.1, which
 * every child dials, and on 0.0.0.0: on macOS a 127.0.0.1 bind sits beside another process's 0.0.0.0 or :: listener,
 * and a 0.0.0.0 bind beside a 127.0.0.1 one, either of which would then answer for the port. On Linux either bind
 * alone sees all three. Here, not in db/test-support.ts: db/'s TypeScript spells no loopback host of its own but
 * connect.ts's (test-connect), and these are bind addresses for the suites' own servers.
 */
export function quietPort(): number {
  for (let tries = 0; tries < 100; tries++) {
    const port = 20_000 + Math.floor(Math.random() * 10_000);
    try {
      for (const hostname of ["127.0.0.1", "0.0.0.0"]) Bun.serve({ port, hostname, fetch: () => new Response(null) }).stop(true);
      return port;
    } catch {}
  }
  throw new Error("no free port between 20000 and 30000 in 100 tries");
}
