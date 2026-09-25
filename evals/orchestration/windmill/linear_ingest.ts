// OB1 — Linear issues into the brain (Windmill script f/ob1/linear_ingest).
// Windmill has no Linear trigger and no MCP-client step: the fetch and the MCP
// session are this script's own, the Linear key and the brain's capture key are
// secret variables in Windmill's store, and a schedule runs it every 15 minutes.
import * as wmill from "windmill-client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const QUERY = `query { issues(first: 10, filter: { team: { key: { eq: "SMD" } }, number: { in: [949, 1813, 1814, 1815, 1816, 1817, 1818, 1863, 1933, 1954] } }) { nodes { identifier title url description state { name } project { name } } } }`;

type Issue = { identifier: string; title: string; url: string; description?: string; state?: { name: string }; project?: { name: string } };

export async function main() {
  const linearKey = await wmill.getVariable("f/ob1/linear_api_key");
  const brainKey = await wmill.getVariable("f/ob1/brain_capture_key");
  const r = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: linearKey },
    body: JSON.stringify({ query: QUERY }),
  });
  if (!r.ok) throw new Error(`Linear ${r.status}: ${await r.text()}`);
  const issues: Issue[] = (await r.json()).data.issues.nodes;

  const client = new Client({ name: "windmill-ob1-ingest", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://server:8000/"), { requestInit: { headers: { "x-brain-key": brainKey } } }));
  const captured: string[] = [];
  try {
    for (const i of issues) {
      const content = [
        `${i.identifier} — ${i.title}`,
        `State: ${i.state?.name ?? ""} · Project: ${i.project?.name ?? ""}`,
        i.url,
        "",
        i.description ?? "",
      ].join("\n").trim();
      const res = await client.callTool({ name: "capture_thought", arguments: { content } }, undefined, { timeout: 180_000 });
      if (res.isError) throw new Error(`capture_thought failed for ${i.identifier}`);
      captured.push(i.identifier);
    }
  } finally {
    await client.close();
  }
  return { captured };
}
