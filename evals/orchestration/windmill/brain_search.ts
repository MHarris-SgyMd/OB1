// OB1 — brain_search (Windmill script f/ob1/brain_search), exposed on Windmill's
// MCP server. Searches the brain with the READ key from Windmill's store; the
// AI client supplies the query and never sees the key.
import * as wmill from "windmill-client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export async function main(query: string) {
  const brainKey = await wmill.getVariable("f/ob1/brain_read_key");
  const client = new Client({ name: "windmill-ob1-search", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://server:8000/"), { requestInit: { headers: { "x-brain-key": brainKey } } }));
  try {
    const res = await client.callTool({ name: "search_thoughts", arguments: { query, limit: 3 } });
    const content = Array.isArray(res.content) ? res.content : [];
    return content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("\n");
  } finally {
    await client.close();
  }
}
