#!/usr/bin/env bun
/**
 * test-auth.ts — scoped, hashed, named access keys, against the real server.
 *
 * The claim being tested is specific: a read-only key cannot write, and cannot
 * even see the tool that writes. That is the whole point of scoping here, because
 * `?key=` remains supported — Claude Desktop connectors are URL-only — so a key
 * embedded in a URL will end up in access logs and browser history. Scopes are
 * what make that survivable.
 *
 * Run: bun test-auth.ts   (no database needed — nothing here reaches the store)
 */

import { authenticate, hashKey, parseKeyRecords, canWrite } from "./auth.ts";
import { actorPayload } from "./store.ts";
import { createAssert } from "../db/test-support.ts";

const { assert, report } = createAssert();


const WRITE_KEY = "w".repeat(64);
const READ_KEY = "r".repeat(64);
const KEYS = [
  `laptop:write:${hashKey(WRITE_KEY)}`,
  `chatgpt:read:${hashKey(READ_KEY)}`,
].join(",");

console.log("[1] Keys are stored as hashes, never as keys");
{
  assert(!KEYS.includes(WRITE_KEY), "the write key does not appear in the config value");
  assert(!KEYS.includes(READ_KEY), "the read key does not appear in the config value");
  assert(/^[0-9a-f]{64}$/.test(hashKey(WRITE_KEY)), "hashKey produces a SHA-256 hex digest");
  assert(hashKey(WRITE_KEY) !== hashKey(READ_KEY), "distinct keys hash distinctly");

  // Migration 010 identifies an agent by digest, so the principal has to carry
  // one — and it must be the DIGEST. Returning the presented key here would put
  // a live credential into ob1_agent_keys, the one thing that table must never
  // hold.
  const p = authenticate(WRITE_KEY, { MCP_ACCESS_KEYS: KEYS });
  assert(p?.keyHash === hashKey(WRITE_KEY), "the principal carries the digest of the presented key");
  assert(p?.keyHash !== WRITE_KEY, "…which is not the key itself");
}

console.log("\n[2] Parsing rejects a config that stores raw keys");
{
  const good = parseKeyRecords(KEYS);
  assert(good.problems.length === 0, "a well-formed config parses cleanly");
  assert(good.keys.length === 2, "…yielding both keys");

  /**
   * One raw key registered under two names.
   *
   * Dead config before migration 010 — authenticate() returns the first match
   * and the second entry never fires. Once a digest identifies an agent it is a
   * genuine ambiguity: two names claim one identity, and resolve_agent() would
   * rename the same agent back and forth depending on which client spoke last.
   */
  const shared = hashKey("s".repeat(64));
  const dup = parseKeyRecords(`laptop:write:${shared},phone:read:${shared}`);
  assert(dup.problems.length > 0, "two names sharing one digest is rejected");
  assert(/share one digest/.test(dup.problems[0] ?? ""), "…saying what the collision is");
  assert(/keygen\.ts/.test(dup.problems[0] ?? ""), "…and how to mint a separate key");
  // The mirror: it must be the SHARED digest that trips this, not merely having
  // two keys. A check that rejected every multi-key config would also pass above.
  assert(parseKeyRecords(KEYS).problems.length === 0, "two names with distinct digests still parse cleanly");

  const raw = parseKeyRecords(`laptop:write:${WRITE_KEY}`);
  assert(raw.problems.length > 0, "a raw key in the hash position is rejected");
  assert(/Store the HASH, not the key/.test(raw.problems[0]), "…with an explanation");
  assert(/keygen\.ts/.test(raw.problems[0]), "…and the command to mint one properly");

  assert(parseKeyRecords("laptop:admin:" + hashKey("x")).problems.some((p) => /expected read or write/.test(p)),
    "an unknown scope is rejected");
  assert(parseKeyRecords("no-colons").problems.some((p) => /name:scope:sha256/.test(p)),
    "a malformed entry is rejected");
  assert(parseKeyRecords(`a:read:${hashKey("1")},a:write:${hashKey("2")}`).problems.some((p) => /more than once/.test(p)),
    "a duplicate key name is rejected");

  const commented = parseKeyRecords(`# a comment\n${KEYS}\n\n`);
  assert(commented.keys.length === 2 && commented.problems.length === 0,
    "comments and blank lines are ignored, so the value can be readable");
}

console.log("\n[3] Authentication resolves a principal, or nothing");
{
  const cfg = { MCP_ACCESS_KEYS: KEYS };
  const w = authenticate(WRITE_KEY, cfg);
  assert(w?.name === "laptop" && w?.scope === "write", "the write key resolves to its principal");
  const r = authenticate(READ_KEY, cfg);
  assert(r?.name === "chatgpt" && r?.scope === "read", "the read key resolves to its principal");

  assert(authenticate("wrong", cfg) === null, "an unknown key resolves to null");
  assert(authenticate("", cfg) === null, "an empty key resolves to null");
  assert(authenticate(null, cfg) === null, "a missing key resolves to null");
  assert(authenticate(hashKey(WRITE_KEY), cfg) === null,
    "presenting the HASH does not authenticate — a leaked config is not a credential");
}

console.log("\n[4] Scopes");
{
  assert(canWrite({ name: "laptop", scope: "write", keyHash: hashKey(WRITE_KEY) }),
         "write scope may write");
  assert(!canWrite({ name: "chatgpt", scope: "read", keyHash: hashKey(READ_KEY) }),
         "read scope may not write");
}

console.log("\n[5] Independent revocation");
{
  const remaining = [`chatgpt:read:${hashKey(READ_KEY)}`].join(",");
  assert(authenticate(WRITE_KEY, { MCP_ACCESS_KEYS: remaining }) === null, "the removed key stops working");
  assert(authenticate(READ_KEY, { MCP_ACCESS_KEYS: remaining })?.name === "chatgpt", "…and the other keeps working");
}

console.log("\n[6] The legacy single key still works, with write scope");
{
  const legacy = { MCP_ACCESS_KEY: "old-style-key" };
  const p = authenticate("old-style-key", legacy);
  assert(p?.scope === "write", "a bare MCP_ACCESS_KEY authenticates as write");
  assert(p?.name === "MCP_ACCESS_KEY", "…named so logs show which form was used");
  assert(authenticate("nope", legacy) === null, "a wrong legacy key is rejected");

  const both = { MCP_ACCESS_KEYS: KEYS, MCP_ACCESS_KEY: "old-style-key" };
  assert(authenticate(READ_KEY, both)?.scope === "read", "both forms can be configured at once");
  assert(authenticate("old-style-key", both)?.scope === "write", "…and both authenticate");
}

// ── The tool surface actually changes with scope ─────────────────────────────

process.env.OB1_STORE = "postgrest";
process.env.SUPABASE_URL = "https://stub.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
process.env.OPENROUTER_API_KEY = "stub";
process.env.MCP_ACCESS_KEYS = KEYS;
delete process.env.MCP_ACCESS_KEY;

const worker = (await import("./index.ts")).default as { fetch: (r: Request) => Response | Promise<Response> };
const server = Bun.serve({ port: 0, fetch: worker.fetch });
const BASE = `http://localhost:${server.port ?? 0}`;

async function toolsFor(key: string, via: "header" | "query"): Promise<string[]> {
  const url = via === "query" ? `${BASE}/?key=${key}` : BASE;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (via === "header") headers["x-brain-key"] = key;
  const r = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const t = await r.text();
  const line = t.startsWith("{") ? t : (t.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6);
  const b = JSON.parse(line);
  return ((b.result?.tools ?? []) as { name: string }[]).map((x) => x.name).sort();
}

console.log("\n[7] A read-only key cannot see the tool that writes");
{
  const write = await toolsFor(WRITE_KEY, "header");
  assert(write.length === 8, `write scope sees 8 tools (${write.length})`);
  // The two mutating tools specifically — the count alone would pass if one
  // write tool were swapped for another.
  assert(write.includes("update_thought") && write.includes("delete_thought"),
         "…including update_thought and delete_thought");
  assert(write.includes("capture_thought"), "…including capture_thought");

  const read = await toolsFor(READ_KEY, "header");
  assert(read.length === 5, `read scope sees 5 tools (${read.length})`);
  assert(!read.includes("update_thought") && !read.includes("delete_thought"),
         "…and neither mutating tool is among them");
  assert(!read.includes("capture_thought"), "capture_thought is absent, not merely refused");
  for (const t of ["search", "fetch", "search_thoughts", "list_thoughts", "thought_stats"]) {
    assert(read.includes(t), `read scope keeps "${t}"`);
  }
}

console.log("\n[8] Scope applies through the ?key= URL form too");
{
  // This is the form that ends up in logs and browser history, so it is the one
  // that most needs to be limitable.
  const read = await toolsFor(READ_KEY, "query");
  assert(read.length === 5 && !read.includes("capture_thought"),
    "a read-only key in the URL still cannot see capture_thought");
  const write = await toolsFor(WRITE_KEY, "query");
  assert(write.includes("capture_thought"), "a write key in the URL still can");
}

console.log("\n[9] Rejection still uses the JSON-RPC envelope");
{
  const r = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-brain-key": "not-a-key" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }),
  });
  assert(r.status === 200, "wrong key → HTTP 200, not 401");
  const b = await r.json();
  assert(b?.error?.code === -32001, "…carrying -32001");
  assert(b?.id === 7, "…and echoing the id");
  assert(!JSON.stringify(b).includes("laptop"), "the response does not disclose configured key names");
}

console.log("\n[10] The audit actor is serialised in the shape the trigger reads");
{
  /**
   * The trigger reads `actor->>'agent_id'`; the TypeScript field is `agentId`.
   * Passing the object through unchanged type-checks, runs without error, and
   * writes NULL into canonical_agent_id on every row — a failure nobody sees
   * until they query the column. This is the translation that prevents it.
   */
  const full = actorPayload({ name: "laptop", source: "mcp", agentId: "abc-123" });
  assert(full?.agent_id === "abc-123", "agentId is emitted as agent_id");
  assert(!("agentId" in (full ?? {})), "…and the camelCase form is not also present");
  assert(full?.name === "laptop" && full?.source === "mcp", "name and source pass through");

  // Absent, not null: the trigger's `actor - 'agent_id'` strips a missing key
  // cleanly, while an explicit null would land in actor_context as noise.
  const bare = actorPayload({ name: "laptop" });
  assert(!("agent_id" in (bare ?? {})), "no agent id means no agent_id key at all");
  assert(actorPayload(undefined) === null, "no actor at all serialises to null");
}

console.log("\n[11] An unreachable agent registry does not deny service");
{
  /**
   * Every request above ran against SUPABASE_URL=https://stub.invalid, so
   * resolve_agent could never be called. Asserting it explicitly rather than
   * leaving it implied: a resolver that threw, or that treated a failed lookup
   * as a revocation, would have made all of [7] and [8] fail — but only this
   * line says that outcome was the point rather than a coincidence.
   */
  const tools = await toolsFor(WRITE_KEY, "header");
  assert(tools.includes("capture_thought"),
         "the full tool surface is served with no registry reachable");
}

server.stop();

report();
