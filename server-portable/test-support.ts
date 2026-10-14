/**
 * test-support.ts — driving the server over MCP, once instead of five times.
 *
 * Five files carried a near-identical JSON-RPC client: build the envelope, POST
 * it, cope with the response arriving either as JSON or as an SSE `data:` line,
 * unwrap `result.content`, and turn `isError` into a throw. Small enough to copy
 * and just subtle enough to copy wrong — the SSE fallback in particular, which is
 * easy to omit and only fails on transports that use it.
 */

/** A server a suite drives: its fetch, as Bun.serve takes it. */
export type ServerUnderTest = { fetch: (req: Request) => Response | Promise<Response> };

/** The forward-scope key mcp-server/stack.ts adds to MCP_ACCESS_KEYS: the carrier (`act`) on every write through it. */
export const SUITE_CARRIER = "mcp-server-suite";

/**
 * Whether the server mcpUnderTest() loaded is the one OB1_MCP_UNDER_TEST names,
 * read from what the stack leaves behind (its carrier in MCP_ACCESS_KEYS)
 * against the variable itself, not through mcpTarget(): a suite asserts it, so
 * a switch that stops switching fails the run instead of testing index.ts
 * twice (SMD-2287 PR 3b review pass 1).
 */
export function servedAsNamed(): boolean {
  const served = (process.env.MCP_ACCESS_KEYS ?? "").split(",").some((entry) => entry.startsWith(`${SUITE_CARRIER}:`));
  return served === (process.env.OB1_MCP_UNDER_TEST === "client");
}

/** Which MCP server a suite drives: OB1_MCP_UNDER_TEST unset, empty or "index" is index.ts, "client" the MCP server as a REST client; anything else is refused. */
export function mcpTarget(): "index" | "client" {
  const target = process.env.OB1_MCP_UNDER_TEST;
  if (target === undefined || target === "" || target === "index") return "index";
  if (target !== "client") throw new Error(`OB1_MCP_UNDER_TEST must be unset, "index" or "client", not ${JSON.stringify(target)}`);
  return "client";
}

/**
 * The MCP server a suite drives (SMD-2287): server-portable's index.ts, or —
 * with OB1_MCP_UNDER_TEST=client — the MCP server as a client of the REST core,
 * with the REST core behind it in the same process (mcp-server/stack.ts), so
 * the same assertions hold both. Call it after the suite has set its
 * environment, as the import of index.ts it replaces came. The stack's path is
 * read at run time, so this file's typecheck does not reach mcp-server's
 * packages, which its own directory installs.
 */
export async function mcpUnderTest(): Promise<ServerUnderTest> {
  if (mcpTarget() === "index") return (await import("./index.ts")).default as ServerUnderTest;
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
