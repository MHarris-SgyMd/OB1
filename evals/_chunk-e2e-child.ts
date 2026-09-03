#!/usr/bin/env bun
/**
 * _chunk-e2e-child.ts — one server configuration, one measurement.
 *
 * Spawned by eval-chunking-e2e.ts. Separate because the server snapshots its
 * environment once at boot (so Cloudflare Workers bindings behave), which means
 * OB1_CHUNK_TOKENS cannot be changed within a process. Comparing two settings
 * honestly therefore needs two processes.
 *
 * Captures the documents it is handed, searches for each one's final sentence,
 * and prints `RESULT <found> <chunkRows>` for the parent to parse.
 */

const CASES = JSON.parse(process.env.OB1_EVAL_CASES ?? "[]") as {
  key: string; query: string; text: string;
}[];

const worker = (await import("../server-portable/index.ts")).default as {
  fetch: (r: Request) => Response | Promise<Response>;
};
const server = Bun.serve({ port: 0, fetch: worker.fetch });
const BASE = `http://localhost:${server.port ?? 0}`;

let id = 1;
async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await fetch(BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "x-brain-key": process.env.MCP_ACCESS_KEY ?? "",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }),
  });
  const t = await r.text();
  const b = JSON.parse(t.startsWith("{") ? t : (t.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6));
  const text = (b.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n");
  if (b.error) throw new Error(JSON.stringify(b.error));
  if (b.result?.isError) throw new Error(text);
  return text;
}

for (const c of CASES) await call("capture_thought", { content: c.text });

/**
 * A document counts as found only if it is ranked FIRST. Every document here
 * shares its opening and its filler, so anything less than first place means the
 * search could not tell them apart — which is precisely what losing the tail does.
 */
let found = 0;
for (const c of CASES) {
  const out = await call("search_thoughts", { query: c.query, limit: 1, threshold: 0.05 });
  const tailStart = c.text.slice(c.text.length - 60, c.text.length - 20);
  if (out.includes(tailStart)) found++;
}

const { SQL } = await import("bun");
const sql = new SQL({ url: process.env.DATABASE_URL as string, max: 1 });
const [{ c: chunks }] = await sql`SELECT count(*)::int AS c FROM thought_chunks`;
await sql.close();

console.log(`RESULT ${found} ${chunks}`);
server.stop();
process.exit(0);
