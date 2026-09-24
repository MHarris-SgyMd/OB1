#!/usr/bin/env bun
/**
 * test-agents.ts — stable agent identity, driven through the real MCP server.
 *
 * Migration 010's claim is narrow and worth stating precisely, because the
 * extension it was ported from claims something this fork already had:
 *
 *   ALREADY TRUE BEFORE 010. Attribution survives key ROTATION, because
 *   thought_audit.actor_name records the key's NAME and rotation changes only
 *   its digest. [3] asserts it anyway — a regression there would silently undo
 *   the property this whole feature is supposed to add.
 *
 *   NEW IN 010. Attribution survives a RENAME ([4]), distinguishes two agents
 *   that happen to share a name over time ([2]), and a credential can be
 *   refused without a redeploy while its history stays queryable ([6]).
 *
 * The registry-semantics cases run against resolve_agent directly, because a
 * rename means changing MCP_ACCESS_KEYS and initEnv memoises the environment on
 * first read — the running server cannot be re-keyed mid-suite. The attribution
 * and revocation cases go through the server, because those are the ones where
 * a break would be in the plumbing rather than in the SQL.
 *
 *   ../db/with-postgres.sh bun test-agents.ts
 */

import { SQL } from "bun";
import { createAssert, requireDatabaseUrl, resetSchema } from "../db/test-support.ts";
import { mcpClient } from "./test-support.ts";
import { hashKey, type Principal } from "./auth.ts";
import { AgentResolver } from "./agents.ts";
import type { AgentResolution, ThoughtStore } from "./store.ts";
import { TOOL_NAMES } from "./tools.ts";

const URL_ = requireDatabaseUrl("test-agents.ts");
const { assert, report } = createAssert();

const DIM = 64;
const EMB_MODEL = "stub-embed";

await resetSchema(URL_, { dim: DIM, model: EMB_MODEL });

/** Deterministic provider — this suite is about identity, not about models. */
const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = (await req.json()) as Record<string, unknown>;
    if (url.pathname.endsWith("/embeddings")) {
      const v = new Array(DIM).fill(0);
      v[String(body.input ?? "").length % DIM] = 1;
      return Response.json({ data: [{ embedding: v }], model: body.model });
    }
    return Response.json({
      choices: [{ message: { content: JSON.stringify({ topics: ["identity"], type: "observation", people: [] }) } }],
    });
  },
});

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const HASH_A = hashKey(KEY_A);
const HASH_B = hashKey(KEY_B);

process.env.MCP_ACCESS_KEYS = [
  `laptop:write:${HASH_A}`,
  `importer:write:${HASH_B}`,
].join(",");
delete process.env.MCP_ACCESS_KEY;

process.env.OB1_STORE = "sql";
process.env.DATABASE_URL = URL_;
process.env.OB1_LLM_BASE_URL = `http://localhost:${provider.port}/v1`;
// Declared local to the egress gate (SMD-1903): the stub is on this box, and
// the gate reads the flag, never the address — without it the default, deny,
// refuses every call to it. test-egress.ts holds that case.
process.env.OB1_LLM_LOCAL = "1";
process.env.OB1_EMBEDDING_MODEL = EMB_MODEL;
process.env.OB1_EMBEDDING_DIM = String(DIM);
process.env.OB1_METADATA_MODEL = "stub-meta";
// Resolve on every request. The cache's own behaviour is tested in [8] with an
// injected clock; leaving a 60-second TTL here would make [6] assert nothing —
// a revocation would not be visible within the run, and the test would pass
// while proving the opposite of what it says.
process.env.OB1_AGENT_CACHE_TTL_MS = "0";
delete process.env.OPENROUTER_API_KEY;
delete process.env.SUPABASE_URL;

const worker = (await import("./index.ts")).default as { fetch: (r: Request) => Response | Promise<Response> };
const server = Bun.serve({ port: 0, fetch: worker.fetch });
const BASE = `http://localhost:${server.port ?? 0}`;
const laptop = mcpClient(BASE, KEY_A);
const importer = mcpClient(BASE, KEY_B);

const sql = new SQL({ url: URL_, max: 2 });

const H = (c: string) => c.repeat(64);
const resolve = async (hash: string, label: string, scope?: string) =>
  (await sql`SELECT resolve_agent(${hash}, ${label}, ${scope ?? null}) AS r`)[0].r as Record<string, unknown>;
const revoke = async (hash: string, reason?: string) =>
  (await sql`SELECT revoke_agent_key(${hash}, ${reason ?? null}) AS r`)[0].r as Record<string, unknown>;
const agentOf = async (label: string) =>
  (await sql`SELECT canonical_agent_id AS id FROM ob1_agents WHERE label = ${label}`)[0]?.id as string | undefined;

console.log("\n[1] A capture through a named key records that agent's id");
{
  await laptop.call("capture_thought", { content: "the first thought, from the laptop" });
  await importer.call("capture_thought", { content: "a second thought, from the importer" });

  const rows = await sql`
    SELECT actor_name, canonical_agent_id FROM thought_audit ORDER BY created_at`;
  assert(rows.length === 2, `two audit rows (${rows.length})`);
  assert(rows[0].canonical_agent_id != null, "the laptop's capture carries a canonical_agent_id");
  assert(rows[0].canonical_agent_id === (await agentOf("laptop")),
         "…and it is the id ob1_agents holds for that label");

  /**
   * The mirror. Every assertion above would also pass if resolve_agent returned
   * one constant id for everyone, which is precisely the failure that makes an
   * identity column worthless while looking populated.
   */
  assert(rows[1].canonical_agent_id !== rows[0].canonical_agent_id,
         "a different key resolves to a DIFFERENT agent, not one shared id");
  assert(rows[1].canonical_agent_id === (await agentOf("importer")),
         "…the importer's own");

  // Both, not one instead of the other: the name is what the agent was CALLED
  // at the time of writing, which the rename in [4] would otherwise erase.
  assert(rows[0].actor_name === "laptop" && rows[1].actor_name === "importer",
         "actor_name is still recorded alongside the id");

  // actor_context is the free-form blob for everything WITHOUT a column. An id
  // recorded in both places is not merely redundant: the two can then disagree,
  // and nothing says which is authoritative.
  const [ctx] = await sql`
    SELECT actor_context FROM thought_audit WHERE actor_name = 'laptop'`;
  assert(ctx.actor_context === null,
         `agent_id is not also duplicated into actor_context (${JSON.stringify(ctx.actor_context)})`);
}

console.log("\n[2] The registry distinguishes first sight from a repeat");
{
  const first = await resolve(H("1"), "solo", "read");
  assert(first.ok === true && first.created === true, "an unknown key and name creates an agent");
  const again = await resolve(H("1"), "solo", "read");
  assert(again.created === false, "the same pair does not create a second one");
  assert(again.agent_id === first.agent_id, "…and resolves to the same id");

  const other = await resolve(H("2"), "duo", "read");
  assert(other.agent_id !== first.agent_id, "an unrelated name gets its own id");

  // Registration is a side effect of resolving, so an existing deployment needs
  // no admin step — the registry fills itself as clients connect.
  const [c] = await sql`SELECT count(*)::int AS c FROM ob1_agents WHERE label IN ('solo','duo')`;
  assert(c.c === 2, "both were registered without anyone creating them by hand");

  const bad = await resolve("not-a-sha-256", "solo");
  assert(bad.ok === false && bad.error === "BAD_KEY_HASH", "a non-digest is refused, not registered");
  const [k] = await sql`SELECT count(*)::int AS c FROM ob1_agent_keys WHERE key_hash = 'not-a-sha-256'`;
  assert(k.c === 0, "…and nothing that is not a digest reaches ob1_agent_keys");
}

console.log("\n[3] Rotating a key preserves the agent, and its history");
{
  const before = await agentOf("importer");
  const [row] = await sql`
    SELECT canonical_agent_id AS id FROM thought_audit WHERE actor_name = 'importer'`;

  const rotated = await resolve(H("3"), "importer", "write");
  assert(rotated.rotated === true, "a new digest under a known name is a rotation, not a new agent");
  assert(rotated.agent_id === before, "…resolving to the id the agent already had");

  // The property the whole feature exists for: the row written under the OLD
  // credential still points at the live agent.
  assert(row.id === rotated.agent_id, "a capture made before the rotation is still attributed to it");

  const [keys] = await sql`
    SELECT count(*)::int AS c FROM ob1_agent_keys WHERE canonical_agent_id = ${before}`;
  assert(keys.c === 2, `both digests are on record for that agent (${keys.c})`);

  // Presenting the ORIGINAL key still works: rotation registers a credential, it
  // does not retire the previous one. Retiring is revocation, and it is separate.
  const stillA = await resolve(HASH_B, "importer", "write");
  assert(stillA.agent_id === before, "the pre-rotation key still resolves to the same agent");
}

console.log("\n[4] Renaming an agent keeps its history — which a name alone could not");
{
  const before = await agentOf("importer");
  const renamed = await resolve(H("3"), "ingest", "write");
  assert(renamed.ok === true, "a known digest under a new name resolves");
  assert(renamed.created === false && renamed.rotated === false, "…as neither a creation nor a rotation");
  assert(renamed.agent_id === before, "…keeping the id it already had");
  assert((await agentOf("ingest")) === before, "ob1_agents now answers to the new label");
  assert((await agentOf("importer")) === undefined, "…and no longer to the old one");

  /**
   * The point of the whole migration, in one assertion. The audit row still says
   * `importer`, because that is what the agent was called when it wrote. Before
   * 010 that string was the only attribution there was, and after a rename it
   * pointed at nothing. Now it joins.
   */
  const [joined] = await sql`
    SELECT a.actor_name, g.label
      FROM thought_audit a JOIN ob1_agents g ON g.canonical_agent_id = a.canonical_agent_id
     WHERE a.actor_name = 'importer'`;
  assert(joined?.actor_name === "importer", "the historical row keeps the name it was written with");
  assert(joined?.label === "ingest", "…and joins to the agent under its current name");
}

console.log("\n[5] Renaming AND rotating at once is a new agent, as documented");
{
  const before = await agentOf("solo");
  const both = await resolve(H("4"), "solo-renamed", "read");
  assert(both.created === true, "with neither identifier recognisable, it is first sight");
  assert(both.agent_id !== before, "…and a genuinely new id");
  // Not a defect to fix but a limit to state: both identifiers changed at once,
  // so nothing links the two. Doing the steps separately keeps the chain, which
  // [3] and [4] together demonstrate.
  assert((await agentOf("solo")) === before, "the original agent is untouched, not merged into it");
}

console.log("\n[6] A revoked key is refused, and its history stays queryable");
{
  const laptopId = await agentOf("laptop");
  const [beforeCount] = await sql`
    SELECT count(*)::int AS c FROM thought_audit WHERE canonical_agent_id = ${laptopId}`;
  assert(beforeCount.c >= 1, "the laptop has history to preserve");

  const r = await revoke(HASH_A, "found in a shell history file");
  assert(r.ok === true, "the digest is revoked");
  assert(r.already_revoked === false, "…and reported as newly revoked");

  const refused = (await laptop.rpc("tools/list")) as { error?: { code: number; message: string } };
  assert(refused.error?.code === -32001, "the next request from that key is refused");
  assert(/revoked/i.test(refused.error?.message ?? ""),
         `…saying the key was revoked rather than that it is invalid (${refused.error?.message})`);

  /**
   * Two mirrors, because "refused" on its own is what a broken server does too.
   */
  const stillWorks = (await importer.rpc("tools/list")) as { error?: unknown; result?: unknown };
  assert(stillWorks.error === undefined, "another agent's key is unaffected");

  const [afterCount] = await sql`
    SELECT count(*)::int AS c FROM thought_audit WHERE canonical_agent_id = ${laptopId}`;
  assert(afterCount.c === beforeCount.c, "the revoked agent's history is intact");
  const [named] = await sql`SELECT label FROM ob1_agents WHERE canonical_agent_id = ${laptopId}`;
  assert(named?.label === "laptop", "…and still resolvable to a name, so it can be read back");
}

console.log("\n[7] Revocation is idempotent, and does not rewrite the first record");
{
  const again = await revoke(HASH_A, "cleanup");
  assert(again.ok === true && again.already_revoked === true, "a repeat call reports it was already revoked");
  const [k] = await sql`
    SELECT revoked_reason, revoked_at FROM ob1_agent_keys WHERE key_hash = ${HASH_A}`;
  /**
   * The second reason is invariably the vaguer of the two, because whoever
   * writes it already believes the key is dead. Keeping the first preserves the
   * only account of why access actually stopped.
   */
  assert(k.revoked_reason === "found in a shell history file",
         `the original reason survives the second call (${k.revoked_reason})`);

  const missing = await revoke(H("9"), "never registered");
  assert(missing.ok === false && missing.error === "NOT_FOUND",
         "revoking an unregistered digest reports NOT_FOUND rather than a revocation that did not happen");
}

console.log("\n[8] Two names cannot claim one agent by sharing a digest");
{
  // auth.ts refuses this configuration outright; this is the second line, for a
  // digest registered by some other route. Without it the two entries would
  // rename the same agent back and forth on alternate requests.
  await resolve(H("5"), "twin-one", "read");
  await resolve(H("6"), "twin-two", "read");
  const clash = await resolve(H("5"), "twin-two", "read");
  assert(clash.ok === true, "the request still resolves rather than erroring");
  assert(clash.label_conflict === true, "…flagging that the rename was refused");
  assert(clash.label === "twin-one", "…and keeping the existing name");
  assert((await agentOf("twin-two")) !== clash.agent_id, "the two agents stay distinct");
}

console.log("\n[9] A mutation with no principal is honestly unattributed");
{
  await sql`INSERT INTO thoughts (content, metadata) VALUES ('written by a migration', '{}'::jsonb)`;
  const [ev] = await sql`
    SELECT actor_name, canonical_agent_id FROM thought_audit
     WHERE thought_id = (SELECT id FROM thoughts WHERE content = 'written by a migration')`;
  assert(ev.canonical_agent_id === null, "no actor means no agent id, not a placeholder");
  assert(ev.actor_name === null, "…and no name either");
  // Rows written before migration 010 read exactly this way, which is correct:
  // no honest id can be invented for a write that predates the registry.
}

console.log("\n[10] A malformed agent id does not break the mutation");
{
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('ob1.actor', ${JSON.stringify({ name: "x", agent_id: "not-a-uuid" })}, true)`;
    await tx`INSERT INTO thoughts (content, metadata) VALUES ('survived a bad agent id', '{}'::jsonb)`;
  });
  const [t] = await sql`SELECT count(*)::int AS c FROM thoughts WHERE content = 'survived a bad agent id'`;
  assert(t.c === 1, "the capture succeeded despite an unparseable agent id");
  const [ev] = await sql`
    SELECT actor_name, canonical_agent_id FROM thought_audit
     WHERE thought_id = (SELECT id FROM thoughts WHERE content = 'survived a bad agent id')`;
  assert(ev.canonical_agent_id === null, "…recorded with a NULL id");
  assert(ev.actor_name === "x", "…while the name it did carry is kept");
}

console.log("\n[11] The registry holds digests, never keys");
{
  const rows = await sql`SELECT key_hash FROM ob1_agent_keys`;
  const stored = rows.map((r: { key_hash: string }) => r.key_hash);
  assert(stored.length > 0, `there is something to check (${stored.length} rows)`);
  assert(stored.every((h: string) => /^[0-9a-f]{64}$/.test(h)), "every stored value is a lowercase hex digest");
  // The specific thing that must never be true: a live credential in the table.
  assert(!stored.includes(KEY_A) && !stored.includes(KEY_B),
         "neither raw key appears, so the table is not a credential store");
}

console.log("\n[11b] A server running against a database still at 009");
{
  /**
   * The upgrade order nobody controls: new server code deployed before the
   * migration is applied. `resolve_agent` does not exist, so the identity
   * lookup fails on every request.
   *
   * This has to be driven through the real server rather than asserted about
   * the resolver, because the risk is not in agents.ts — it is that a failed
   * query leaves the connection or the request in a state the NEXT call
   * inherits. Dropping just the function reproduces a 009 database exactly.
   */
  await sql`DROP FUNCTION IF EXISTS resolve_agent(text, text, text)`;

  const list = (await importer.rpc("tools/list")) as { error?: unknown; result?: { tools?: unknown[] } };
  assert(list.error === undefined, "tools/list still answers with no resolve_agent");
  assert((list.result?.tools ?? []).length === TOOL_NAMES.length, `…with the full write surface (${(list.result?.tools ?? []).length})`);

  // The one that matters: a failed lookup must not poison the request behind it.
  const out = await importer.call("capture_thought", { content: "captured against an unmigrated database" });
  assert(/Captured as/.test(out), `the capture itself succeeds (${out.slice(0, 40)})`);

  const [ev] = await sql`
    SELECT actor_name, canonical_agent_id FROM thought_audit
     WHERE thought_id = (SELECT id FROM thoughts WHERE content = 'captured against an unmigrated database')`;
  // "importer", not "ingest": the name comes from MCP_ACCESS_KEYS, which [4]
  // never touched — it renamed the agent in the registry, and with resolve_agent
  // gone the registry is not consulted at all.
  assert(ev?.actor_name === "importer", `attribution falls back to the key name (${ev?.actor_name})`);
  assert(ev?.canonical_agent_id === null, "…with no id, rather than a fabricated one");
}

// ── The resolver's own behaviour, with a fake store and an injected clock ────

/** A store that only answers resolveAgent; nothing else is reached. */
function fakeStore(answer: () => Promise<AgentResolution>, onCall: () => void): Promise<ThoughtStore> {
  return Promise.resolve({
    resolveAgent: async () => { onCall(); return answer(); },
  } as unknown as ThoughtStore);
}
const principal = (name: string, keyHash: string): Principal => ({ name, scope: "write", keyHash });

console.log("\n[12] Resolution is cached, and the TTL is the revocation delay");
{
  let now = 0;
  let calls = 0;
  const ok: AgentResolution = { ok: true, agentId: "agent-1", label: "laptop", created: false, rotated: false, labelConflict: false };
  const store = fakeStore(async () => ok, () => calls++);
  const r = new AgentResolver(60000, () => now);

  await r.resolve(store, principal("laptop", H("a")));
  await r.resolve(store, principal("laptop", H("a")));
  assert(calls === 1, `a repeat within the TTL does not query again (${calls})`);

  now = 59999;
  await r.resolve(store, principal("laptop", H("a")));
  assert(calls === 1, "…still not, just before it expires");

  now = 60001;
  await r.resolve(store, principal("laptop", H("a")));
  assert(calls === 2, "…and does once it has");

  /**
   * Keyed by digest AND name. Cached on the digest alone, the first request
   * after a rename would return the cached entry, resolve_agent would never see
   * the new label, and ob1_agents would keep the stale one until the TTL
   * happened to lapse — a rename that silently did not take.
   */
  await r.resolve(store, principal("macbook", H("a")));
  assert(calls === 3, "the same digest under a new name is resolved afresh");
}

console.log("\n[13] An unreachable registry degrades to no id, not to a refusal");
{
  // …and says so once per key while it lasts (SMD-1298): a brain whose CHECK
  // refuses a scope is otherwise silent about its unattributed writes.
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
  let calls = 0;
  const store = fakeStore(async () => { throw new Error("connection refused"); }, () => calls++);
  const r = new AgentResolver(60000, () => 0);
  const out = await r.resolve(store, principal("laptop", H("a")));
  assert(out.status === "ok", "a failed lookup is not treated as a revocation");
  assert(out.status === "ok" && out.agentId === undefined,
         "…and carries no id, so attribution falls back to the name");
  assert(out.status === "ok" && out.unresolved === "unreachable", "…saying the registry could not be REACHED — a retry may answer (SMD-1298)");

  // Bounded, so a dead database costs one connection attempt per interval
  // rather than one per request.
  await r.resolve(store, principal("laptop", H("a")));
  assert(calls === 1, `the failure is cached too (${calls} lookups)`);

  /**
   * …but a TTL of zero means zero.
   *
   * The first version capped failures at a fixed ten seconds regardless of the
   * configured TTL, so `OB1_AGENT_CACHE_TTL_MS=0` — documented in three places
   * as "resolve on every request" — quietly did not, for exactly the answers an
   * operator setting 0 would be trying to observe.
   */
  let zeroCalls = 0;
  const dead = fakeStore(async () => { throw new Error("connection refused"); }, () => zeroCalls++);
  const noCache = new AgentResolver(0, () => 0);
  await noCache.resolve(dead, principal("laptop", H("a")));
  await noCache.resolve(dead, principal("laptop", H("a")));
  assert(zeroCalls === 2, `with TTL 0 a failure is not cached either (${zeroCalls} lookups)`);
  console.warn = realWarn;
  assert(warnings.length === 2 && warnings.every((w) => /agent registry: resolve_agent failed for key "laptop"/.test(w) && /connection refused/.test(w)),
         `each resolver warned once for the key, naming it and the cause, and not again while the failure lasted (${warnings.length} warning(s))`);
}

console.log("\n[14] A definitive revocation IS enforced, cached or not");
{
  const store = fakeStore(
    async () => ({ ok: false, error: "REVOKED", agentId: "agent-1", revokedAt: "2026-09-03T00:00:00Z", reason: "leaked" }),
    () => {}
  );
  const r = new AgentResolver(60000, () => 0);
  const out = await r.resolve(store, principal("laptop", H("a")));
  assert(out.status === "revoked", "REVOKED is passed through, unlike a lookup failure");
  assert(out.status === "revoked" && out.reason === "leaked", "…with the reason attached");

  // An UNRESOLVED answer is the other direction: the function replied, but with
  // something the server cannot act on. Refusing every caller over a schema
  // mismatch would be worse than serving without an id.
  const odd = fakeStore(async () => ({ ok: false, error: "UNRESOLVED", detail: "BAD_LABEL" }), () => {});
  {
    const refusedWarnings: string[] = [];
    const prevWarn = console.warn;
    console.warn = (...a: unknown[]) => { refusedWarnings.push(a.map(String).join(" ")); };
    const refuser = new AgentResolver(60000, () => 0);
    const refusedOut = await refuser.resolve(odd, principal("laptop", H("odd")));
    await refuser.resolve(odd, principal("laptop", H("odd")));
    console.warn = prevWarn;
    assert(refusedOut.status === "ok" && refusedOut.agentId === undefined && refusedOut.unresolved === "refused",
           "a registry that ANSWERED and refused the argument says so — a retry will not change it (SMD-1298)");
    // The tool's `Refused:` sends the operator to the server log; the log has to hold a line (eighth review pass).
    assert(refusedWarnings.length === 1 && /resolve_agent refused key "laptop" \(BAD_LABEL\)/.test(refusedWarnings[0]),
           `…and warned once for the key, naming the detail (${refusedWarnings.length} warning(s))`);
  }
  const out2 = await new AgentResolver(0, () => 0).resolve(odd, principal("laptop", H("a")));
  assert(out2.status === "ok" && out2.agentId === undefined, "an unusable answer serves without an id");
}

console.log("\n[15] Concurrent requests of a key share one lookup — on the SQL store, not on Workers (SMD-2041)");
{
  // resolve_agent can wait on a lock, up to its cap (SMD-2072):
  // five concurrent requests of a cold key are one lookup, one connection.
  // On Workers a fetch belongs to the request that started it, so there each
  // request makes its own.
  const slow = (onCall: () => void) => fakeStore(async () => { await Bun.sleep(50); return { ok: true, agentId: "agent-1" } as AgentResolution; }, onCall);
  let shared = 0;
  const pooled = new AgentResolver(0, () => 0);
  const store = slow(() => shared++);
  const outs = await Promise.all(Array.from({ length: 5 }, () => pooled.resolve(store, principal("laptop", H("s")))));
  assert(shared === 1 && outs.every((o) => o.status === "ok" && o.agentId === "agent-1"), `five concurrent requests of one key, one lookup (${shared})`);
  let apart = 0;
  const workers = new AgentResolver(0, () => 0, false);
  const store2 = slow(() => apart++);
  await Promise.all(Array.from({ length: 5 }, () => workers.resolve(store2, principal("laptop", H("s")))));
  assert(apart === 5, `with sharing off (Workers), each request its own lookup (${apart})`);
}

console.log("\n[16] A lookup that times out on a lock is retried, then busy, and a revocation this process has read stands through any failure (SMD-2072)");
{
  // The lookup's lock wait is capped (store-sql.ts), so a registry whose
  // tables are locked fails the lookup while every tool still answers: serving
  // by name there would serve a key the registry may have revoked.
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
  // Bun's SQL carries the SQLSTATE as `errno`: 55P03 is lock_timeout's.
  const failing = (errno: string | undefined, message: string) => async (): Promise<AgentResolution> => { throw Object.assign(new Error(message), errno ? { errno } : {}); };
  const lockTimeout = failing("55P03", "canceling statement due to lock timeout");
  const refusedConn = failing(undefined, "connection refused");
  const noFunction = failing("42883", "function resolve_agent(text, text, text) does not exist");
  const okAnswer = async () => ({ ok: true, agentId: "agent-9" } as AgentResolution);
  const revokedAnswer = async () => ({ ok: false, error: "REVOKED", agentId: "agent-9", revokedAt: "2026-09-24T00:00:00Z", reason: "leaked" } as AgentResolution);
  let answer: () => Promise<AgentResolution> = okAnswer;
  const store = fakeStore(() => answer(), () => {});
  // TTL 0, so each step below is a lookup; no retries, so each is one (the
  // retry has its own case below).
  const once = { attempts: 1, budgetMs: 0, pauseMs: 0 };
  const r = new AgentResolver(0, () => 0, true, once);
  const p = principal("laptop", H("9"));

  // A key the registry answered for is busy when it times out: that answer
  // is at least a TTL old (a fresher one is still cached), and the registry
  // could have revoked the key since.
  await r.resolve(store, p);
  answer = lockTimeout;
  const timed = await r.resolve(store, p);
  assert(timed.status === "busy", `a key answered ok before is busy when its lookup times out on a lock (${JSON.stringify(timed)})`);
  const never = principal("desk", H("8"));
  for (const [code, what] of [["55P03", "lock_timeout's 55P03"], ["57014", "statement_timeout's 57014 (a role's cap, as on Workers)"], ["40P01", "a deadlock's 40P01"], ["40001", "a serialization failure's 40001 (resolve_agent's write under a REPEATABLE READ default, a revocation committed during its wait — SMD-2090)"]] as const) {
    answer = failing(code, what);
    const o = await r.resolve(store, p);
    const n = await r.resolve(store, never);
    assert(o.status === "busy" && n.status === "busy", `…on ${what}, the answered key and one never answered for alike — not served by name (${o.status}, ${n.status})`);
  }
  // Any other failure is an outage, served by name as before: the tools fail
  // with it.
  answer = refusedConn;
  const down = await r.resolve(store, p);
  assert(down.status === "ok" && down.agentId === undefined && down.unresolved === "unreachable", "a lost connection is served by name, as before the cap");
  // busy → ok → busy: the registry's answer resets the warning, so a second
  // lock is said again.
  answer = lockTimeout;
  await r.resolve(store, p);
  answer = okAnswer;
  await r.resolve(store, p);
  answer = lockTimeout;
  await r.resolve(store, p);

  // A revocation this process has read stands through any failure — a lock,
  // an outage, the function gone — and any reply that is not an answer, until
  // the registry answers otherwise.
  answer = revokedAnswer;
  await r.resolve(store, p);
  const stands: string[] = [];
  const malformed = async () => ({ ok: false, error: "UNRESOLVED", detail: "MALFORMED_RESPONSE" } as AgentResolution);
  for (const [f, what] of [[lockTimeout, "a lock"], [refusedConn, "a lost connection"], [noFunction, "resolve_agent gone"], [malformed, "a malformed reply"], [lockTimeout, "a lock again"]] as const) {
    answer = f;
    const o = await r.resolve(store, p);
    if (o.status !== "revoked") stands.push(`${what}: ${o.status}`);
  }
  assert(stands.length === 0, `a revoked key stays refused through a lock, a lost connection, a missing resolve_agent and a malformed reply (${stands.join(", ") || "every step revoked"})`);
  // By digest: a rename presents the same digest under a new name.
  const renamed = await r.resolve(store, principal("laptop-renamed", H("9")));
  assert(renamed.status === "revoked", "…by digest, so a renamed key stays refused too");
  // A fresh REVOKED answer resets the warning like any answer.
  answer = revokedAnswer;
  await r.resolve(store, p);
  answer = lockTimeout;
  await r.resolve(store, p);
  // The registry's answer that the key is not revoked clears it.
  answer = okAnswer;
  const lifted = await r.resolve(store, p);
  answer = lockTimeout;
  const afterLift = await r.resolve(store, p);
  assert(lifted.status === "ok" && lifted.agentId === "agent-9" && afterLift.status === "busy", `once the registry says the key is not revoked, a later timeout is busy, not revoked (${lifted.status}, ${afterLift.status})`);
  console.warn = realWarn;

  // One warning per key and outcome, said again when the outcome changes and
  // after the registry answers: laptop went busy, unreachable, busy — then
  // answered, busy again — revoked kept through five failures, answered
  // revoked, revoked kept again, answered ok, busy.
  const laptop = warnings.filter((w) => /key "laptop"/.test(w));
  const kinds = laptop.map((w) => /timed out/.test(w) ? "busy" : /revocation stands/.test(w) ? "revoked" : /attributed by name/.test(w) ? "unreachable" : "?");
  assert(JSON.stringify(kinds) === JSON.stringify(["busy", "unreachable", "busy", "busy", "revoked", "revoked", "busy"]),
    `warned once per key and outcome, again when it changes or the registry has answered (${kinds.join(" → ")})`);

  // The retry: a lookup that times out is tried again, pausing between, and a
  // lock that clears inside the budget is waited out — served, not busy.
  {
    let calls = 0;
    let fails = 2;
    const clearing = fakeStore(async () => { if (fails-- > 0) throw Object.assign(new Error("lock timeout"), { errno: "55P03" }); return { ok: true, agentId: "agent-5" } as AgentResolution; }, () => calls++);
    const retrying = new AgentResolver(0, () => 0, true, { attempts: 5, budgetMs: 2000, pauseMs: 40 });
    const t0 = performance.now();
    const served = await retrying.resolve(clearing, principal("retry", H("5")));
    const took = performance.now() - t0;
    assert(served.status === "ok" && served.agentId === "agent-5" && calls === 3 && took >= 70,
      `a lock that clears within the retry budget is waited out: served on the third lookup, after two pauses (${served.status}, ${calls} lookups, ${Math.round(took)} ms)`);
    console.warn = () => {};
    let tries = 0;
    const held = fakeStore(lockTimeout, () => tries++);
    const exhausted = await retrying.resolve(held, principal("retry-held", H("4")));
    assert(exhausted.status === "busy" && tries === 5, `…and one that does not is busy after its attempts (${exhausted.status}, ${tries} lookups)`);
    let slowTries = 0;
    const slow = fakeStore(async () => { await Bun.sleep(300); throw Object.assign(new Error("statement timeout"), { errno: "57014" }); }, () => slowTries++);
    const budgeted = await new AgentResolver(0, () => 0, true, { attempts: 5, budgetMs: 500, pauseMs: 40 }).resolve(slow, principal("retry-slow", H("3")));
    assert(budgeted.status === "busy" && slowTries === 2, `…within the budget in real time: 300 ms lookups against 500 ms are tried twice (${slowTries})`);
    let outageTries = 0;
    await retrying.resolve(fakeStore(refusedConn, () => outageTries++), principal("retry-down", H("2")));
    let revokedTries = 0;
    const known = new AgentResolver(0, () => 0, true, { attempts: 5, budgetMs: 2000, pauseMs: 40 });
    let first = true;
    const revokedThenLocked = fakeStore(async () => { if (first) { first = false; return revokedAnswer(); } throw Object.assign(new Error("lock timeout"), { errno: "55P03" }); }, () => revokedTries++);
    await known.resolve(revokedThenLocked, principal("retry-revoked", H("1")));
    const k = await known.resolve(revokedThenLocked, principal("retry-revoked", H("1")));
    console.warn = realWarn;
    assert(outageTries === 1 && k.status === "revoked" && revokedTries === 2, `…and not retried on an outage (${outageTries}) or for a key whose revocation is read, which answers at once (${k.status}, ${revokedTries - 1} lookup)`);
    // Under a REPEATABLE READ default, resolve_agent's write of a row whose
    // revocation committed while it waited fails 40001; the retry reads the
    // revocation (SMD-2090's run-it review measured the served-by-name answer
    // this replaces).
    let serialTries = 0;
    let serialFirst = true;
    const serialThenRevoked = fakeStore(async () => { if (serialFirst) { serialFirst = false; throw Object.assign(new Error("could not serialize access due to concurrent update"), { errno: "40001" }); } return revokedAnswer(); }, () => serialTries++);
    const afterSerial = await retrying.resolve(serialThenRevoked, principal("retry-serial", H("0")));
    assert(afterSerial.status === "revoked" && serialTries === 2, `…and a serialization failure is retried, so a revocation that committed during the wait is refused, not served by name (${afterSerial.status}, ${serialTries} lookups)`);
  }

  // Cached with a TTL: a kept revocation for the failure TTL, as a read one
  // is; `busy` for a second, so a key's retries do not each spend the budget.
  let n = 0;
  let now = 0;
  answer = async () => ({ ok: false, error: "REVOKED", agentId: "agent-7", revokedAt: "2026-09-24T00:00:00Z", reason: null } as AgentResolution);
  const counted = fakeStore(() => answer(), () => n++);
  const ttl = new AgentResolver(60000, () => now, true, once);
  const q = principal("tablet", H("7"));
  await ttl.resolve(counted, q);
  now += 20000; // past the revocation's 10 s failure TTL
  answer = lockTimeout;
  console.warn = () => {};
  await ttl.resolve(counted, q);
  const before = n;
  now += 5000;
  const kept = await ttl.resolve(counted, q);
  assert(kept.status === "revoked" && n === before, `a kept revocation is cached for the failure TTL — no lookup inside it (${n - before})`);
  const cold = principal("phone", H("6"));
  await ttl.resolve(counted, cold);
  const b2 = n;
  now += 500;
  const within = await ttl.resolve(counted, cold);
  const b3 = n;
  now += 1000;
  await ttl.resolve(counted, cold);
  console.warn = realWarn;
  assert(within.status === "busy" && b3 === b2 && n === b3 + 1, `…and busy for a second: none inside it, one after (${b3 - b2}, ${n - b3})`);
}

await sql.close();
server.stop();
provider.stop();
report();
