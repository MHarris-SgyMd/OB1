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
 * Run: bun test-auth.ts   (no database needed — the store is dialled at a port
 *                           nothing listens on and refused at once; [11] says why)
 */

import { authenticate, hashKey, parseKeyRecords, canCapture, canRead, canWrite, secretMatches, SCOPES } from "./auth.ts";
import { actorPayload } from "./store.ts";
import { createAssert } from "../db/test-support.ts";
import { visibleToolNames, READ_TOOL_NAMES, WRITE_TOOL_NAMES, type ToolName } from "./tools.ts";

const { assert, report } = createAssert();

// The mutating tools, named here independently of the manifest — a rename in
// both the manifest (tools.ts) and the server is still caught — but typed as
// ToolName, so a typo in this list is a compile error, not a runtime surprise
// (SMD-1805).
const MUTATING = ["capture_thought", "update_thought", "delete_thought"] as const satisfies readonly ToolName[];


const WRITE_KEY = "w".repeat(64);
const READ_KEY = "r".repeat(64);
// The capture-only scope (SMD-1298): the key a session-end hook holds.
const CAPTURE_KEY = "c".repeat(64);
const KEYS = [
  `laptop:write:${hashKey(WRITE_KEY)}`,
  `chatgpt:read:${hashKey(READ_KEY)}`,
  `session-hook:capture:${hashKey(CAPTURE_KEY)}`,
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
  assert(good.keys.length === 3, "…yielding all three keys");
  assert(good.keys.map((k) => k.scope).sort().join() === [...SCOPES].sort().join(), "…one of each scope the module names");

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
  assert(parseKeyRecords(KEYS).problems.length === 0, "three names with distinct digests still parse cleanly");

  const raw = parseKeyRecords(`laptop:write:${WRITE_KEY}`);
  assert(raw.problems.length > 0, "a raw key in the hash position is rejected");
  assert(/Store the HASH, not the key/.test(raw.problems[0]), "…with an explanation");
  assert(/keygen\.ts/.test(raw.problems[0]), "…and the command to mint one properly");

  assert(parseKeyRecords("laptop:admin:" + hashKey("x")).problems.some((p) => /expected read, write or capture/.test(p)),
    "an unknown scope is rejected, naming the three");
  assert(parseKeyRecords("laptop:admin:" + hashKey("x")).keys.length === 0, "…and yields no key");
  assert(parseKeyRecords("no-colons").problems.some((p) => /name:scope:sha256/.test(p)),
    "a malformed entry is rejected");
  assert(parseKeyRecords(`a:read:${hashKey("1")},a:write:${hashKey("2")}`).problems.some((p) => /more than once/.test(p)),
    "a duplicate key name is rejected");

  const commented = parseKeyRecords(`# a comment\n${KEYS}\n\n`);
  assert(commented.keys.length === 3 && commented.problems.length === 0,
    "comments and blank lines are ignored, so the value can be readable");
}

console.log("\n[3] Authentication resolves a principal, or nothing");
{
  const cfg = { MCP_ACCESS_KEYS: KEYS };
  const w = authenticate(WRITE_KEY, cfg);
  assert(w?.name === "laptop" && w?.scope === "write", "the write key resolves to its principal");
  const r = authenticate(READ_KEY, cfg);
  assert(r?.name === "chatgpt" && r?.scope === "read", "the read key resolves to its principal");
  // Admission (first review pass): a consumer that names no scopes — every
  // vendored server, whose read tools are registered for any principal — does
  // not see a capture key at all; the core server names SCOPES and does.
  assert(authenticate(CAPTURE_KEY, cfg) === null, "a capture key is NO principal to a consumer that does not admit the scope — the vendored servers");
  const c = authenticate(CAPTURE_KEY, cfg, { admit: SCOPES });
  assert(c?.name === "session-hook" && c?.scope === "capture", "…and resolves to its principal for one that admits every scope");
  assert(authenticate(WRITE_KEY, cfg, { admit: ["read"] }) === null && authenticate(READ_KEY, cfg, { admit: ["read"] })?.scope === "read",
    "admission is by scope, not by kind of key: a write key is refused where only read is admitted");
  assert(authenticate("old-style-key", { MCP_ACCESS_KEY: "old-style-key" }, { admit: ["read", "capture"] }) === null,
    "the legacy single key is write scope, and refused where write is not admitted");

  assert(authenticate("wrong", cfg) === null, "an unknown key resolves to null");
  assert(authenticate("", cfg) === null, "an empty key resolves to null");
  assert(authenticate(null, cfg) === null, "a missing key resolves to null");
  assert(authenticate(hashKey(WRITE_KEY), cfg) === null,
    "presenting the HASH does not authenticate — a leaked config is not a credential");
}

console.log("\n[4] Scopes");
{
  const w = { name: "laptop", scope: "write", keyHash: hashKey(WRITE_KEY) } as const;
  const r = { name: "chatgpt", scope: "read", keyHash: hashKey(READ_KEY) } as const;
  const c = { name: "session-hook", scope: "capture", keyHash: hashKey(CAPTURE_KEY) } as const;
  assert(canWrite(w), "write scope may write");
  assert(!canWrite(r), "read scope may not write");
  assert(!canWrite(c), "capture scope may not write — it adds, and touches nothing that exists (SMD-1298)");
  assert(canRead(w) && canRead(r), "write and read scopes may read");
  assert(!canRead(c), "capture scope may not read");
  assert(canCapture(w) && canCapture(c), "write and capture scopes may capture");
  assert(!canCapture(r), "read scope may not capture");
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

// The default store (sql, change 97) against a port nothing listens on: the
// connection is refused at once, and [11] asserts that a registry the store
// cannot reach denies nobody service. Before change 97 this ran the PostgREST
// store against a stub host for the same reason.
delete process.env.OB1_STORE;
process.env.DATABASE_URL = "postgres://ob1:x@127.0.0.1:1/ob1";
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
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
  // Counts derive from the manifest for each scope (SMD-1805); the mutating
  // tools are checked by the independent, typed MUTATING list above — the count
  // alone would pass if one write tool were swapped for another.
  const write = await toolsFor(WRITE_KEY, "header");
  assert(write.length === visibleToolNames({ scope: "write" }).length, `write scope sees every tool (${write.length})`);
  for (const t of MUTATING) assert(write.includes(t), `…including "${t}"`);

  const read = await toolsFor(READ_KEY, "header");
  assert(read.length === visibleToolNames({ scope: "read" }).length, `read scope sees only the read tools (${read.length})`);
  for (const t of MUTATING) assert(!read.includes(t), `"${t}" is absent from a read key, not merely refused`);
  for (const t of READ_TOOL_NAMES) {
    assert(read.includes(t), `read scope keeps "${t}"`);
  }

  // The capture-only key (SMD-1298): one tool, and every other absent — the
  // reads as much as the two other writers. Named against the manifest AND
  // against the literal, as the write surface is above: the manifest alone
  // would pass if CAPTURE_TOOL_NAMES grew a read tool by mistake.
  const capture = await toolsFor(CAPTURE_KEY, "header");
  assert(capture.join() === [...visibleToolNames({ scope: "capture" })].sort().join(),
    `capture scope sees exactly the manifest's capture surface (${capture.join(", ")})`);
  assert(visibleToolNames({ scope: "write" }).join() === [...new Set([...READ_TOOL_NAMES, ...visibleToolNames({ scope: "capture" }), ...WRITE_TOOL_NAMES])].sort().join(),
    "the write surface is the union of the three groups the manifest names");
  assert(capture.length === 1 && capture[0] === "capture_thought", "…which is capture_thought alone");
  for (const t of READ_TOOL_NAMES) assert(!capture.includes(t), `"${t}" is absent from a capture key — it cannot read the brain`);
  for (const t of MUTATING.filter((t) => t !== "capture_thought")) assert(!capture.includes(t), `"${t}" is absent from a capture key`);
}

console.log("\n[7b] A capture key calling a read tool is told the tool does not exist, before any store is reached");
{
  // Absent, not refused: the SDK answers an unknown tool with a JSON-RPC error
  // (or an isError result, depending on the version), and nothing here dials
  // the database — the port nothing listens on would refuse it at once, and
  // that refusal is a different message (see [11]).
  const r = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-brain-key": CAPTURE_KEY },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "search_thoughts", arguments: { query: "anything" } } }),
  });
  const t = await r.text();
  const line = t.startsWith("{") ? t : (t.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6);
  const b = JSON.parse(line);
  const msg = String(b.error?.message ?? (b.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join(" "));
  assert(b.error !== undefined || b.result?.isError === true, "search_thoughts through a capture key is an error");
  assert(/not found|unknown tool/i.test(msg), `…saying the tool does not exist for this key (${msg.slice(0, 80)})`);
  assert(!/ECONNREFUSED|connection/i.test(msg), "…and not a store error: the refusal came before any dial");
}

console.log("\n[8] Scope applies through the ?key= URL form too");
{
  // This is the form that ends up in logs and browser history, so it is the one
  // that most needs to be limitable.
  const read = await toolsFor(READ_KEY, "query");
  assert(read.length === visibleToolNames({ scope: "read" }).length && MUTATING.every((t) => !read.includes(t)),
    "a read-only key in the URL is scoped too — no mutating tool");
  const write = await toolsFor(WRITE_KEY, "query");
  assert(MUTATING.every((t) => write.includes(t)), "a write key in the URL still sees the mutating tools");
  const capture = await toolsFor(CAPTURE_KEY, "query");
  assert(capture.join() === "capture_thought", "a capture key in the URL sees capture_thought alone");
}

console.log("\n[8b] GET /health says what the brain is to a key that may read it, and `ok` to any other (SMD-2041)");
{
  // The record is the brain_info tool's, so it goes where that tool goes: a
  // read or a write key. A capture-only key cannot see brain_info and gets the
  // literal, as a missing or wrong key does. The store here is refused at once
  // (the port nothing listens on), so the JSON carries database.error — the
  // body's shape is test-server's; this is who gets it.
  const health = async (key: string | null, via: "header" | "query" = "header") => {
    const r = await fetch(via === "query" && key ? `${BASE}/health?key=${key}` : `${BASE}/health`, { headers: via === "header" && key ? { "x-brain-key": key } : {} });
    return { status: r.status, body: await r.text() };
  };
  for (const [label, key, via] of [["read", READ_KEY, "header"], ["write", WRITE_KEY, "header"], ["read, in the URL", READ_KEY, "query"]] as const) {
    const r = await health(key, via);
    let version: unknown;
    try { version = JSON.parse(r.body).version; } catch { /* not JSON */ }
    assert(r.status === 200 && typeof version === "string", `a ${label} key gets the record as JSON (${r.body.slice(0, 50)})`);
  }
  for (const [label, key, via] of [["capture", CAPTURE_KEY, "header"], ["capture, in the URL", CAPTURE_KEY, "query"], ["wrong", "not-a-key", "header"], ["missing", null, "header"]] as const) {
    const r = await health(key, via);
    assert(r.status === 200 && r.body === "ok", `a ${label} key gets \`ok\` and nothing else (${JSON.stringify(r.body.slice(0, 40))})`);
  }
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
  const full = actorPayload({ name: "laptop", via: "open-brain", agentId: "abc-123" });
  assert(full?.agent_id === "abc-123", "agentId is emitted as agent_id");
  assert(!("agentId" in (full ?? {})), "…and the camelCase form is not also present");
  assert(full?.name === "laptop" && full?.via === "open-brain", "name and via — the door, 046's origin column — pass through");
  assert(!("source" in (full ?? {})), "…and no source: the trigger reads the row's own metadata.source since 046, so the server names none (SMD-1730)");

  // Absent, not null: the trigger's `actor - 'agent_id'` strips a missing key
  // cleanly, while an explicit null would land in actor_context as noise.
  const bare = actorPayload({ name: "laptop" });
  assert(!("agent_id" in (bare ?? {})), "no agent id means no agent_id key at all");
  assert(actorPayload(undefined) === null, "no actor at all serialises to null");
}

console.log("\n[11] An unreachable agent registry does not deny service");
{
  /**
   * Every request above ran the default store against DATABASE_URL at
   * 127.0.0.1:1, a port nothing listens on, so resolve_agent could never be called. Asserting it explicitly rather than
   * leaving it implied: a resolver that threw, or that treated a failed lookup
   * as a revocation, would have made all of [7] and [8] fail — but only this
   * line says that outcome was the point rather than a coincidence.
   */
  const tools = await toolsFor(WRITE_KEY, "header");
  assert(tools.includes("capture_thought"),
         "the full tool surface is served with no registry reachable");
}

console.log("\n[12] secretMatches — a secret the caller echoes, compared digest to digest");
{
  assert(secretMatches("s3cret", "s3cret"), "the same secret matches");
  assert(!secretMatches("s3cre", "s3cret") && !secretMatches("s3cret!", "s3cret"), "a prefix or an extension does not");
  assert(!secretMatches("S3CRET", "s3cret"), "case matters");
  assert(!secretMatches("", ""), "two empty strings are not a match");
  assert(!secretMatches(null, "s3cret") && !secretMatches("s3cret", undefined), "empty on either side is a refusal");
  assert(!secretMatches("undefined", undefined) && !secretMatches("null", null), "the literal spellings of nothing do not match nothing");
  assert(!secretMatches(hashKey("s3cret"), "s3cret"), "the digest is not the secret");
  assert(!secretMatches(12345, "12345") && !secretMatches({ secret: "s3cret" }, "s3cret"), "a value that is not a string is refused, not hashed");
}

server.stop();

report();
