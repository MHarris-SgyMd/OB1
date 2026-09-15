#!/usr/bin/env bun
/**
 * test-auth.ts — the seven extension servers authenticate through the core
 * server's auth path (SMD-1252, FORK.md change 62).
 *
 * The claim is the one server-portable/test-auth.ts makes for the core server,
 * made here for each vendored extension as it is deployed: a wrong key is
 * refused; a key removed from MCP_ACCESS_KEYS stops working while its neighbour
 * keeps working; the hash is not a credential; the legacy single key still
 * authenticates, by digest now; and a read-scoped key does not merely fail to
 * write — the tools that write are not registered for it, so they are absent
 * from tools/list and a call names a tool that does not exist. Then the drift
 * guards: every tool a file registers is classified here as a read or a write,
 * every write is gated, the key is read through the shared module and nowhere
 * else, and each extension's deno.json still pins what package.json installs.
 *
 * The files are imported under a stand-in for the two Deno globals they use:
 * `Deno.env.get` hands the process environment through, and `Deno.serve`
 * captures the fetch handler instead of listening. No database — nothing here
 * reaches a tool that queries; the SQL shim and supabase-js both connect
 * lazily, so a stub URL is never dialled.
 *
 * Run: bun install && bun test-auth.ts   (in extensions/)
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hashKey } from "../server-portable/auth.ts";
import { createAssert } from "../db/test-support.ts";

const { assert, report } = createAssert();
const HERE = dirname(fileURLToPath(import.meta.url));

// ── The stand-in for Deno ────────────────────────────────────────────────────

type Handler = (req: Request) => Response | Promise<Response>;
const served: Handler[] = [];
(globalThis as unknown as { Deno: unknown }).Deno = {
  env: { get: (name: string) => process.env[name] },
  serve: (handler: Handler) => { served.push(handler); return { finished: Promise.resolve() }; },
};

// ── The seven servers, and what each tool does to the database ──────────────

const WRITE_KEY = "w".repeat(64);
const READ_KEY = "r".repeat(64);
const LEGACY_KEY = "old-style-key";
const KEYS = [`laptop:write:${hashKey(WRITE_KEY)}`, `chatgpt:read:${hashKey(READ_KEY)}`].join(",");

type Server = {
  file: string;
  /** The env names this server reads its keys from (the shared server has its own). */
  keys: string;
  legacy: string;
  /** What SUPABASE_URL must look like: the SQL shim wants postgres://, supabase-js an https:// URL. */
  url: string;
  reads: string[];
  writes: string[];
};
const PG = "postgres://ob1:stub@stub.invalid:5432/ob1";
const HTTPS = "https://stub.invalid";
const SERVERS: Server[] = [
  { file: "family-calendar/index.ts", keys: "MCP_ACCESS_KEYS", legacy: "MCP_ACCESS_KEY", url: HTTPS,
    reads: ["get_week_schedule", "search_activities", "get_upcoming_dates"],
    writes: ["add_family_member", "add_activity", "add_important_date"] },
  { file: "home-maintenance/index.ts", keys: "MCP_ACCESS_KEYS", legacy: "MCP_ACCESS_KEY", url: PG,
    reads: ["get_upcoming_maintenance", "search_maintenance_history"],
    writes: ["add_maintenance_task", "log_maintenance"] },
  { file: "household-knowledge/index.ts", keys: "MCP_ACCESS_KEYS", legacy: "MCP_ACCESS_KEY", url: PG,
    reads: ["search_household_items", "get_item_details", "list_vendors"],
    writes: ["add_household_item", "add_vendor"] },
  { file: "job-hunt/index.ts", keys: "MCP_ACCESS_KEYS", legacy: "MCP_ACCESS_KEY", url: HTTPS,
    reads: ["get_pipeline_overview", "get_upcoming_interviews", "search_job_contacts"],
    writes: ["add_company", "add_job_posting", "add_job_contact", "submit_application", "schedule_interview",
             "log_interview_notes", "link_contact_to_professional_crm"] },
  { file: "meal-planning/index.ts", keys: "MCP_ACCESS_KEYS", legacy: "MCP_ACCESS_KEY", url: PG,
    reads: ["search_recipes", "get_meal_plan"],
    writes: ["add_recipe", "update_recipe", "create_meal_plan", "generate_shopping_list"] },
  { file: "professional-crm/index.ts", keys: "MCP_ACCESS_KEYS", legacy: "MCP_ACCESS_KEY", url: PG,
    reads: ["crm_search_contacts", "crm_get_contact_history", "crm_get_follow_ups", "crm_prep_context", "crm_stale_contacts"],
    writes: ["crm_add_contact", "crm_log_interaction", "crm_create_opportunity", "crm_update_contact", "crm_link_thought"] },
  { file: "meal-planning/shared-server.ts", keys: "MCP_HOUSEHOLD_ACCESS_KEYS", legacy: "MCP_HOUSEHOLD_ACCESS_KEY", url: PG,
    reads: ["view_meal_plan", "view_recipes", "view_shopping_list"],
    writes: ["mark_item_purchased"] },
];

process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
process.env.SUPABASE_HOUSEHOLD_KEY = "stub";
process.env.DEFAULT_USER_ID = "00000000-0000-4000-8000-000000000001";
for (const s of SERVERS) {
  process.env.SUPABASE_URL = s.url;
  await import(join(HERE, s.file));
  assert(served.length === SERVERS.indexOf(s) + 1, `${s.file} imports as deployed and hands Deno.serve one handler`);
}

// ── One request ──────────────────────────────────────────────────────────────

type Via = "x-access-key" | "x-brain-key" | "bearer" | "query";
const RPC = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

async function call(s: Server, key: string | null, body: unknown, via: Via = "x-access-key"): Promise<{ status: number; json: any }> {
  const handler = served[SERVERS.indexOf(s)];
  const headers: Record<string, string> = { ...RPC };
  let url = "http://extension.test/mcp";
  if (key !== null) {
    if (via === "query") url += `?key=${encodeURIComponent(key)}`;
    else if (via === "bearer") headers.Authorization = `Bearer ${key}`;
    else headers[via] = key;
  }
  const r = await handler(new Request(url, { method: "POST", headers, body: JSON.stringify(body) }));
  const text = await r.text();
  const line = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6);
  return { status: r.status, json: line ? JSON.parse(line) : null };
}

const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
const toolsOf = (r: { json: any }) => ((r.json?.result?.tools ?? []) as { name: string }[]).map((t) => t.name).sort();
const env = (s: Server, keys: string | undefined, legacy?: string) => {
  if (keys === undefined) delete process.env[s.keys]; else process.env[s.keys] = keys;
  if (legacy === undefined) delete process.env[s.legacy]; else process.env[s.legacy] = legacy;
};

for (const s of SERVERS) {
  const all = [...s.reads, ...s.writes].sort();
  console.log(`\n[${s.file}]`);
  env(s, KEYS);

  const write = await call(s, WRITE_KEY, LIST);
  assert(write.status === 200 && toolsOf(write).join() === all.join(),
    `a write-scoped key sees every tool (${toolsOf(write).length}/${all.length})`);

  const read = await call(s, READ_KEY, LIST);
  assert(read.status === 200 && toolsOf(read).join() === [...s.reads].sort().join(),
    `a read-scoped key sees the ${s.reads.length} read tool(s) and none of the ${s.writes.length} that write`);
  for (const w of s.writes) assert(!toolsOf(read).includes(w), `…${w} is absent, not merely refused`);

  // A call, not only a listing: the tool is not registered for this principal,
  // so the server answers "not found" before any handler — or any query — runs.
  const attempt = await call(s, READ_KEY, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: s.writes[0], arguments: {} } });
  const err = attempt.json?.error ?? attempt.json?.result;
  assert(attempt.status === 200 && (attempt.json?.error?.code === -32602 || attempt.json?.result?.isError === true)
    && /not found|unknown tool/i.test(JSON.stringify(err)),
    `a read-scoped key calling ${s.writes[0]} is told the tool does not exist (${JSON.stringify(err).slice(0, 80)})`);

  assert((await call(s, "not-a-key", LIST)).status === 401, "a wrong key is refused with 401");
  assert((await call(s, null, LIST)).status === 401, "no key is refused with 401");
  assert((await call(s, hashKey(WRITE_KEY), LIST)).status === 401,
    "presenting the HASH does not authenticate — a leaked config is not a credential");

  // Independent revocation: the write key removed from the config, the read key kept.
  env(s, `chatgpt:read:${hashKey(READ_KEY)}`);
  assert((await call(s, WRITE_KEY, LIST)).status === 401, "the removed key stops working");
  assert(toolsOf(await call(s, READ_KEY, LIST)).length === s.reads.length, "…and the other keeps working");

  // The legacy single key: still accepted, with write scope, compared by digest now.
  env(s, undefined, LEGACY_KEY);
  assert(toolsOf(await call(s, LEGACY_KEY, LIST)).join() === all.join(), `the legacy single ${s.legacy} still authenticates, as write`);
  assert((await call(s, "nope", LIST)).status === 401, "…and a wrong legacy key is refused");
  env(s, undefined, undefined);
  assert((await call(s, LEGACY_KEY, LIST)).status === 401, "no keys configured at all refuses everything");
  env(s, KEYS);
}

console.log("\n[where the key may travel]");
{
  const s = SERVERS[0];
  env(s, KEYS);
  for (const via of ["x-access-key", "x-brain-key", "bearer", "query"] as Via[]) {
    assert(toolsOf(await call(s, READ_KEY, LIST, via)).join() === [...s.reads].sort().join(),
      `the ${via} form authenticates, and scope applies through it`);
  }
  const health = await served[0](new Request("http://extension.test/", { method: "GET" }));
  assert(health.status === 200 && (await health.json()).status === "ok", "the unauthenticated GET health check still answers");
}

// ── Drift guards ─────────────────────────────────────────────────────────────

console.log("\n[the files say what this test assumes]");
for (const s of SERVERS) {
  const text = readFileSync(join(HERE, s.file), "utf8");
  const registered = [...text.matchAll(/server\.tool\(\n\s+"([a-z_]+)"/g)].map((m) => m[1]).sort();
  const gated = [...text.matchAll(/if \(canWrite\(principal\)\) server\.tool\(\n\s+"([a-z_]+)"/g)].map((m) => m[1]).sort();
  assert(registered.join() === [...s.reads, ...s.writes].sort().join(),
    `${s.file}: every registered tool is classified above (${registered.length})`);
  assert(gated.join() === [...s.writes].sort().join(), `…and exactly the writes are gated (${gated.length})`);
  for (const w of s.writes) {
    const body = text.slice(text.indexOf(`"${w}"`), text.indexOf("\n  );", text.indexOf(`"${w}"`)));
    const handler = body.match(/handle\w+/)?.[0];
    const reach = handler ? text.slice(text.indexOf(`async function ${handler}`), text.indexOf("\n}", text.indexOf(`async function ${handler}`))) : body;
    assert(/\.(insert|update|upsert|delete)\(/.test(reach), `…${w} does write (its body or handler inserts, updates, upserts or deletes)`);
  }
  for (const r of s.reads) {
    const body = text.slice(text.indexOf(`"${r}"`), text.indexOf("\n  );", text.indexOf(`"${r}"`)));
    const handler = body.match(/handle\w+/)?.[0];
    const reach = handler ? text.slice(text.indexOf(`async function ${handler}`), text.indexOf("\n}", text.indexOf(`async function ${handler}`))) : body;
    assert(!/\.(insert|update|upsert|delete)\(/.test(reach), `…${r} does not write`);
  }
  assert(text.includes('from "../../server-portable/auth.ts"') && text.includes("authenticate(presentedKey(c.req.raw)"),
    "…the key is read and resolved through server-portable/auth.ts");
  assert(!/c\.req\.query\("key"\)|c\.req\.header\("x-access-key"\)/.test(text), "…and nowhere else");
}
{
  const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).devDependencies as Record<string, string>;
  const dirs = readdirSync(HERE, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("_") && d.name !== "node_modules").map((d) => d.name);
  for (const dir of dirs) {
    const imports = JSON.parse(readFileSync(join(HERE, dir, "deno.json"), "utf8")).imports as Record<string, string>;
    const drift = Object.entries(imports).filter(([name, spec]) => spec !== `npm:${name}@${pkg[name]}`);
    assert(drift.length === 0, `${dir}/deno.json pins what package.json installs${drift.length ? ` (${drift.map(([n, s]) => `${n}: ${s}`).join(", ")})` : ""}`);
  }
}

report();
