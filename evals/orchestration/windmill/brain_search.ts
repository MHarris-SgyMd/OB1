// OB1 — brain_search (Windmill script f/ob1/brain_search), exposed on Windmill's
// MCP server. Searches the brain's REST core (SMD-2295) with the READ key from
// Windmill's store; the AI client supplies the query and never sees the key.
import * as wmill from "windmill-client";

export async function main(query: string) {
  const brainKey = await wmill.getVariable("f/ob1/brain_read_key");
  const r = await fetch("http://api:8000/v1/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-brain-key": brainKey },
    body: JSON.stringify({ query, limit: 3 }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`brain search ${r.status}: ${text.slice(0, 300)}`);
  return text;
}
