/**
 * mcp-client.ts — the verifier's MCP client (SMD-1863): connect over Streamable
 * HTTP with a header, list the tools, call one. The SDK's own client, the same
 * transport an AI client uses, so "the AI client sees it" is the protocol the
 * client speaks rather than a hand-rolled JSON-RPC post.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type Tool = { name: string; description?: string };
export type CallResult = { isError: boolean; text: string };

/** One session: connect, run `use`, close whatever happened. */
export async function withMcp<T>(url: string, headers: Record<string, string>, use: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "ob1-orchestration-verify", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  await client.connect(transport);
  try {
    return await use(client);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function listTools(url: string, headers: Record<string, string>): Promise<Tool[]> {
  return withMcp(url, headers, async (c) => (await c.listTools()).tools.map((t) => ({ name: t.name, description: t.description })));
}

export async function callTool(url: string, headers: Record<string, string>, name: string, args: Record<string, unknown>): Promise<CallResult> {
  return withMcp(url, headers, async (c) => {
    const r = await c.callTool({ name, arguments: args });
    const content = Array.isArray(r.content) ? r.content : [];
    const text = content.map((p) => (p && typeof p === "object" && "text" in p ? String(p.text) : "")).join("\n");
    return { isError: r.isError === true, text };
  });
}

/**
 * Does the server refuse a session with these headers? True when connecting or
 * listing fails — the shape a missing or wrong key must take — and false when
 * the tools come back, which is the finding this probe exists to catch.
 */
export async function refuses(url: string, headers: Record<string, string>): Promise<{ refused: boolean; detail: string }> {
  try {
    const tools = await listTools(url, headers);
    return { refused: false, detail: `listed ${tools.length} tool(s) without credentials` };
  } catch (e) {
    return { refused: true, detail: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160) };
  }
}
