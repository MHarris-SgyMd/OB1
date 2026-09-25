// OB1 — linear_issue (Windmill script f/ob1/linear_issue), exposed on Windmill's
// MCP server: a Linear issue's live state by identifier, with the Linear key
// from Windmill's store.
import * as wmill from "windmill-client";

export async function main(identifier: string) {
  const linearKey = await wmill.getVariable("f/ob1/linear_api_key");
  const r = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: linearKey },
    body: JSON.stringify({
      query: "query($id: String!) { issue(id: $id) { identifier title url updatedAt state { name } assignee { name } } }",
      variables: { id: identifier },
    }),
  });
  if (!r.ok) throw new Error(`Linear ${r.status}: ${await r.text()}`);
  return (await r.json()).data.issue;
}
