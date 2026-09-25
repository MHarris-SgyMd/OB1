#!/usr/bin/env bun
/**
 * test-preflight.ts — the deploy gate must actually catch bad configurations.
 *
 * A preflight that passes everything is worse than none: it converts an unchecked
 * deployment into a deployment someone believes was checked. Each case below is a
 * misconfiguration that previously produced a server which started, answered the
 * MCP handshake, and failed only on the first real tool call.
 *
 * Runs preflight as a subprocess so real exit codes are observed. The connectivity
 * cases need DATABASE_URL; without one they are skipped, not silently passed.
 */

import { join, dirname } from "node:path";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { applyMigrations, createAssert, dropSchema, runScript } from "../db/test-support.ts";
import { DIRECT_CHECK_SKIP_OVER_POSTGREST } from "./store.ts";
import { ACCEPTED_CAVEAT_PREFIX, MATCH_THOUGHTS_SIGNATURE, SEARCH_THOUGHTS_HYBRID_SIGNATURE, UPDATE_THOUGHT_SIGNATURE } from "../db/config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE = process.env.DATABASE_URL;

/** db/migrations/*.sql are templates; migrate.ts substitutes these at apply time. */
// Derived from the shipped defaults, not a copy of them, and exported to the
// environment so the preflight subprocess builds its expectation from the same
// values this suite builds the schema from. Hardcoding them here meant the schema
// said 1536 while preflight said 1024 the moment the default changed, and the gate
// failed against a database that was in fact correct.
const { DEFAULT_EMBEDDING_DIM, DEFAULT_EMBEDDING_MODEL } = await import("../db/config.mjs");
const EMBEDDING_DIM = Number(process.env.OB1_EMBEDDING_DIM ?? DEFAULT_EMBEDDING_DIM);
const EMBEDDING_MODEL = process.env.OB1_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
process.env.OB1_EMBEDDING_DIM = String(EMBEDDING_DIM);
process.env.OB1_EMBEDDING_MODEL = EMBEDDING_MODEL;

const { assert, skip: skipRaw, report } = createAssert();
/** A literal for a RegExp source — model names carry dots and colons. */
const rx = (literal: string) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const skip = (l: string) => skipRaw(l, "no DATABASE_URL");

/**
 * A local endpoint that answers GET /models, for every case whose subject is
 * not the endpoint: since SMD-1875 preflight dials a local endpoint by default,
 * and the code's default (127.0.0.1:11434) reaches nothing in CI — and, on a
 * box that runs Ollama, the real thing. Section [9] holds the probe itself.
 */
const localStub = Bun.serve({ port: 0, fetch: () => Response.json({ object: "list", data: [] }) });
const LOCAL_STUB = `http://127.0.0.1:${localStub.port}/v1`;
const BASE_OK = { MCP_ACCESS_KEY: "x".repeat(64), OPENROUTER_API_KEY: "sk-stub", OB1_LLM_BASE_URL: LOCAL_STUB };

async function run(env: Record<string, string | undefined>, ...args: string[]) {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) {
    if (v !== undefined) clean[k] = String(v);
  }
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete clean[k];
  // A developer's proxy would route every loopback probe below through it
  // (Bun reads these four; fifth review pass): only a case that sets one has one.
  for (const k of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]) if (!(k in env)) delete clean[k];
  return runScript(["bun", join(HERE, "preflight.ts"), ...args], { env: clean, cwd: HERE });
}

/** The report row named `name` — glyph, name, detail — or "" when none printed. Fix lines start with →, so they never match. */
const row = (out: string, name: string) => out.split("\n").find((l) => new RegExp(`^\\s*[✓✗!·]\\s+${name}\\s`).test(l)) ?? "";
/** The → fix line under the row named `name`, or "" when the row has none. */
const fix = (out: string, name: string) => { const ls = out.split("\n"); const i = ls.findIndex((l) => new RegExp(`^\\s*[✓✗!·]\\s+${name}\\s`).test(l)); return i >= 0 && /^\s*→ /.test(ls[i + 1] ?? "") ? ls[i + 1] : ""; };

// db/migrate.ts, for the --grant step: the one executable spelling of the
// capturing-role privileges. Spawned like preflight so its exit code and output
// are asserted the same way.
async function migrate(args: string[], env: Record<string, string | undefined> = {}) {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) if (v !== undefined) clean[k] = String(v);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete clean[k];
  return runScript(["bun", join(HERE, "..", "db", "migrate.ts"), ...args], { env: clean, cwd: join(HERE, "..", "db") });
}

const NO_DB = { DATABASE_URL: undefined, SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined };

console.log("[1] Missing configuration fails, with an actionable fix");
{
  const r = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql" });
  assert(r.code === 1, "OB1_STORE=sql without DATABASE_URL exits 1");
  assert(/DATABASE_URL/.test(r.out) && /→/.test(r.out), "…names the variable and suggests a fix");

  const p = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "postgrest" });
  assert(p.code === 1, "OB1_STORE=postgrest without SUPABASE_URL exits 1");

  const k = await run({ ...NO_DB, OB1_STORE: "sql", DATABASE_URL: "postgres://x/y", OPENROUTER_API_KEY: "z", MCP_ACCESS_KEY: undefined });
  assert(k.code === 1, "a missing MCP_ACCESS_KEY exits 1");

  const b = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "typo" });
  assert(b.code === 1, "an unrecognised OB1_STORE exits 1 rather than defaulting");
  assert(/"sql" \(the default/.test(b.out), "…naming sql as the default");

  // Change 97 (SMD-1797): unset selects the SQL store, and every line says so.
  const d = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: undefined });
  assert(d.code === 1, "OB1_STORE unset without DATABASE_URL exits 1");
  assert(/store selection\s+OB1_STORE unset — sql, the default/.test(d.out), "…the store selection line says unset means sql");
  assert(/DATABASE_URL\s+OB1_STORE is unset, which selects the SQL store, and DATABASE_URL is not set/.test(d.out), "…the DATABASE_URL line says which selection wants it");
  assert(!/SUPABASE_URL\s+not set/.test(d.out), "…and SUPABASE_URL is not asked for");

  // The deployment the old default served — an https:// SUPABASE_URL, no
  // OB1_STORE — is told both ways out rather than asked for a DATABASE_URL alone.
  const h = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: undefined, SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" });
  assert(h.code === 1, "an https:// SUPABASE_URL under the default exits 1");
  assert(/the PostgREST store's base URL/.test(h.out) && /set OB1_STORE=postgrest/.test(h.out), "…naming OB1_STORE=postgrest as the way to keep reaching the brain through it");
  assert(!/set but unused/.test(h.out), "…and does not, two lines later, tell the operator to remove the variables that way out needs");

  // SUPABASE_URL holding a postgres:// URL is the connection string: the
  // configuration passes, masked and attributed, and the run fails only at the
  // unreachable database — the same failure [4] asserts for DATABASE_URL.
  const a = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: undefined, SUPABASE_URL: "postgres://u:hunter2@127.0.0.1:1/x" });
  assert(/DATABASE_URL\s+postgres:\/\/\*\*\*@127\.0\.0\.1:1\/x \(from SUPABASE_URL, which holds a postgres:\/\/ URL; DATABASE_URL is unset\)/.test(a.out),
         "a postgres:// SUPABASE_URL is read as the connection string, masked, and said to be");
  assert(!/hunter2/.test(a.out), "…with its password masked too");
  assert(!/SUPABASE_URL\s+set but unused/.test(a.out), "…and not called unused");
  // The ✗ glyph and the absence of the config-skip text are the teeth: with the
  // alias ignored, DATABASE_URL fails and this line reads `·  schema  skipped —
  // fix the configuration above first`, which a bare /schema/ also matched.
  assert(a.code === 1 && /✗\s+schema\s+/.test(a.out) && !/skipped — fix the configuration/.test(a.out) && !/store selection\s+OB1_STORE=/.test(a.out),
         "…so the run reaches the database and fails THERE (✗ schema, not the config skip), under the default selection");
  // The direct-connection block dialled the alias: its first check carries the
  // refused connection. Gated on env.DATABASE_URL by name — the first
  // version — the block is skipped whole and this line is absent.
  assert(/vector extension\s+could not verify/.test(a.out), "…and the direct-connection block dialled it too (vector extension carries the refused connection)");

  // The mirror slip: OB1_STORE=postgrest kept beside a SUPABASE_URL that holds a
  // postgres:// string. Refused by name, the password masked — the first version
  // printed the URL raw and then blamed network reachability (first review pass).
  const m = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "postgrest", SUPABASE_URL: "postgres://u:hunter2@127.0.0.1:1/x", SUPABASE_SERVICE_ROLE_KEY: "k" });
  assert(m.code === 1, "OB1_STORE=postgrest with a postgres:// SUPABASE_URL exits 1");
  assert(/✗\s+SUPABASE_URL\s+holds a postgres:\/\/ connection string \(postgres:\/\/\*\*\*@127\.0\.0\.1:1\/x\), which the PostgREST store cannot dial/.test(m.out), "…refused by name, with the string masked");
  assert(!/hunter2/.test(m.out), "…and the password appears nowhere in the report");
  assert(/→ .*Unset OB1_STORE — the SQL store reads that URL/.test(m.out), "…with the fix naming the SQL store as the reader of that URL");
  assert(/data layer\s+skipped — fix the configuration/.test(m.out) && !/protocol must be/.test(m.out), "…and the store is never built on it, so supabase-js's protocol error never appears");

  // PostgREST stays selectable. On Bun the selection is a WARNING that names
  // Workers and carries the notice as its fix line — not a failure of the config.
  const w = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "postgrest", SUPABASE_URL: "https://stub.invalid", SUPABASE_SERVICE_ROLE_KEY: "k", OB1_CHUNK_CONTEXT: undefined });
  assert(/!\s+store selection\s+OB1_STORE=postgrest — the PostgREST store, kept for Cloudflare Workers/.test(w.out), "OB1_STORE=postgrest is a warning naming Workers");
  assert(/→ OB1_STORE=postgrest selects the PostgREST store, which this fork keeps for Cloudflare Workers only: this process runs on Bun/.test(w.out), "…with the retired notice as its fix line");
  assert(/✓\s+SUPABASE_URL\s+https:\/\/stub\.invalid/.test(w.out), "…and its own configuration still passes");
  // Over PostgREST with the schema check failed, every direct-connection check
  // still prints — the file's own rule. Before the first review pass `edit
  // signature` was silent on this path, and sixteen SQL-only checks were silent
  // on every PostgREST run (pre-existing; by-catch).
  assert(/edit signature\s+not probed — the schema check above failed first/.test(w.out), "edit signature reports when the schema check failed over PostgREST");
  // Every name in DIRECT_CHECKS, read from the source as [4] does, exactly ONCE
  // as a report row — the loop that fills the gaps must neither miss a name nor
  // double one already reported by hand (second review pass: a four-name sample
  // could not see the loop moved above the hand-written skips, which then printed
  // twice). The row shape is the glyph, the name, whitespace.
  const listedNames = [...readFileSync(join(HERE, "preflight.ts"), "utf8").match(/const DIRECT_CHECKS = \[([\s\S]*?)\];/)![1].matchAll(/"([^"]+)"/g)].map((mm) => mm[1]);
  assert(listedNames.length >= 20, `DIRECT_CHECKS parsed from the source (${listedNames.length} names)`);
  /** A report row for `name`: the glyph, the name, whitespace (fix lines start with →, so they never match). */
  const rowRe = (name: string, flags = "") => new RegExp(`^\\s*[✓✗!·]\\s+${name}\\s`, flags);
  const rowCounts = listedNames.map((name) => [name, (w.out.match(rowRe(name, "gm")) ?? []).length] as const);
  assert(rowCounts.every(([, n]) => n === 1), `over PostgREST every direct-connection check prints exactly one row (${rowCounts.filter(([, n]) => n !== 1).map(([name, n]) => `${name}×${n}`).join(", ") || "all once"})`);
  assert(rowCounts.filter(([name]) => new RegExp(`·\\s+${name}\\s+${DIRECT_CHECK_SKIP_OVER_POSTGREST}`).test(w.out)).length === 19, "…nineteen of them as the catalog-only skip, the rest by their own hand-written rows");
  // And nothing else: every row between `data layer` and the provider section is
  // `schema` or one of the listed names. A hand-written PostgREST row under a
  // misspelt name would print beside the loop's correctly named skip with every
  // count above intact (third review pass); this total sees it.
  const lines = w.out.split("\n");
  const rowOf = (name: string) => lines.findIndex((l) => rowRe(name).test(l));
  const fromRow = rowOf("data layer"), toRow = rowOf("embedding provider");
  const rows = lines.slice(fromRow + 1, toRow).filter((l) => /^\s*[✓✗!·]\s+\S/.test(l));
  assert(fromRow > 0 && toRow > fromRow && rows.length === listedNames.length + 1,
         `…and nothing else prints between the data layer and the provider: schema plus the ${listedNames.length} names (${rows.length} rows)`);
}

console.log("\n[2] Weak secrets warn without blocking");
{
  const r = await run({ ...NO_DB, OB1_STORE: "sql", DATABASE_URL: "postgres://u:p@127.0.0.1:1/x",
                        OPENROUTER_API_KEY: "k", MCP_ACCESS_KEY: "short" });
  assert(/only thing protecting/.test(r.out), "a short access key is called out");
  assert(/openssl rand -hex 32/.test(r.out), "…with the command to generate a real one");
}

console.log("\n[3] Credentials are not echoed");
{
  const r = await run({ ...NO_DB, OB1_STORE: "sql", MCP_ACCESS_KEY: "s3cr3t-key-value-abcdefghijklmnop",
                        OPENROUTER_API_KEY: "sk-live-should-not-appear",
                        DATABASE_URL: "postgres://dbuser:hunter2@db.example:5432/ob" });
  assert(!/s3cr3t-key-value/.test(r.out), "the access key is never printed");
  assert(!/sk-live-should-not-appear/.test(r.out), "the OpenRouter key is never printed");
  assert(!/hunter2/.test(r.out), "the database password is masked");
  assert(/db\.example/.test(r.out), "…while the host stays visible for debugging");
}

console.log("\n[3b] The chunk window is derived from the model, and named");
{
  // Configuration checks print whether or not the database answers, so a
  // refused port is enough; the model is set explicitly because the suite
  // exports the default one to every run.
  const base = { ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: "postgres://u:p@127.0.0.1:1/x", OB1_CHUNK_TOKENS: undefined };
  const qwen = await run({ ...base, OB1_EMBEDDING_MODEL: "qwen3-embedding:4b", OB1_EMBEDDING_DIM: "1024" });
  assert(/chunk window\s+captures over 4096 tokens are windowed at 1200, derived from qwen3-embedding:4b's 40960-token window — the threshold capped at 4096/.test(qwen.out),
         "the default model windows above 4096 at the shipped 1200: the threshold from its window, capped, and the line says so");
  const gemma = await run({ ...base, OB1_EMBEDDING_MODEL: "embeddinggemma", OB1_EMBEDDING_DIM: "768" });
  assert(/chunk window\s+captures over 1200 tokens are windowed at 1200, derived from embeddinggemma's 2048-token window\s*$/m.test(gemma.out),
         "a 2048-token model derives the shipped 1200 for both, uncapped");
  const unknown = await run({ ...base, OB1_EMBEDDING_MODEL: "some-model", OB1_EMBEDDING_DIM: "1024" });
  assert(/chunk window\s+captures over 1200 tokens are windowed at 1200, the default for some-model's window, which db\/config\.mjs's KNOWN_MODEL_WINDOW does not list/.test(unknown.out),
         "an unknown model keeps 1200 and is told where the table is");
  const pinned = await run({ ...base, OB1_EMBEDDING_MODEL: "qwen3-embedding:4b", OB1_EMBEDDING_DIM: "1024", OB1_CHUNK_TOKENS: "1200" });
  assert(/chunk window\s+captures over 1200 tokens are windowed at 1200, from OB1_CHUNK_TOKENS \(qwen3-embedding:4b's 40960-token window\)/.test(pinned.out),
         "OB1_CHUNK_TOKENS sets both, as it always did, and the window is shown beside it");
  const over = await run({ ...base, OB1_EMBEDDING_MODEL: "embeddinggemma", OB1_EMBEDDING_DIM: "768", OB1_CHUNK_TOKENS: "3000" });
  assert(/chunk window\s+OB1_CHUNK_TOKENS=3000 is over embeddinggemma's 2048-token window — a window that long is cut at 2048 tokens silently/.test(over.out)
         && /Unset OB1_CHUNK_TOKENS to derive the rule from the window, or set it under 2048/.test(over.out),
         "a limit over the model's window is a warning naming the cut and the two ways out");
  const tight = await run({ ...base, OB1_EMBEDDING_MODEL: "embeddinggemma", OB1_EMBEDDING_DIM: "768", OB1_CHUNK_TOKENS: "2000" });
  assert(/chunk window\s+OB1_CHUNK_TOKENS=2000 leaves little headroom under embeddinggemma's 2048-token window/.test(tight.out) && /at or under 1200/.test(tight.out),
         "…and one under the window but over the headroom the estimate needs warns too, naming the ratio's value");
  const tagged = await run({ ...base, OB1_EMBEDDING_MODEL: "granite-embedding:278m", OB1_EMBEDDING_DIM: "384" });
  assert(/chunk window\s+captures over 300 tokens are windowed at 300, derived from granite-embedding:278m's 512-token window/.test(tagged.out),
         "a tagged local name finds its untagged entry — a miss here would be the silent cut");
}

console.log("\n[3c] The extraction window is derived from the METADATA model's served context, and named (SMD-1879)");
{
  // The embedding model is the default here and the metadata model varies, so
  // the row that moves is the extraction window's — and the chunk window row
  // beside it must not move, since the two models are two tables.
  const base = { ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: "postgres://u:p@127.0.0.1:1/x", OB1_EXTRACT_CHUNK_TOKENS: undefined };
  const qwen = await run({ ...base, OB1_METADATA_MODEL: "qwen2.5:7b" });
  assert(/extraction window\s+thoughts over 1200 estimated tokens are extracted in 1200-token windows \(overlap 150\), derived from qwen2\.5:7b's 32768-token served context — held at 1200, the size the default model was measured to finish reliably \(evals\/README\.md, SMD-1879\); the answer is streamed and a call is aborted once it holds 3 copies of one item, and a call aborted so or run to its answer budget is made once more with a 0\.5 frequency penalty, read whole/.test(qwen.out),
         "the default model derives the measured size from its 32,768-token context, the row says the context would have allowed more, and names the stream abort and the runaway retry");
  const unknown = await run({ ...base, OB1_METADATA_MODEL: "some-chat-model" });
  assert(/extraction window\s+thoughts over 1200 estimated tokens are extracted in 1200-token windows \(overlap 150\), the default for some-chat-model's served context, which db\/config\.mjs's KNOWN_CHAT_MODEL_WINDOW does not list; the answer is streamed and a call is aborted once it holds 3 copies of one item, and a call aborted so or run to its answer budget is made once more with a 0\.5 frequency penalty, read whole — set OB1_EXTRACT_CHUNK_TOKENS if the model serves fewer than 6814 tokens/.test(unknown.out),
         "an unknown model keeps the default, is told where the table is, and what context the default needs");
  const pinned = await run({ ...base, OB1_METADATA_MODEL: "qwen2.5:7b", OB1_EXTRACT_CHUNK_TOKENS: "600" });
  assert(/extraction window\s+thoughts over 600 estimated tokens are extracted in 600-token windows \(overlap 75\), from OB1_EXTRACT_CHUNK_TOKENS \(qwen2\.5:7b's 32768-token served context\)/.test(pinned.out),
         "OB1_EXTRACT_CHUNK_TOKENS sets the window, the overlap follows it, and the context is shown beside it");
  const over = await run({ ...base, OB1_METADATA_MODEL: "qwen2.5:7b", OB1_EXTRACT_CHUNK_TOKENS: "20000" });
  assert(/extraction window\s+OB1_EXTRACT_CHUNK_TOKENS=20000 — a window that long, its answer budget and the rules do not fit qwen2\.5:7b's 32768-token served context/.test(over.out)
         && /set it at or under 7688/.test(over.out),
         "a window whose text plus answer would not fit the context warns, naming the most that fits — 7,688: (32768 − 398 rules − 80 marker and header reserve − 1536 floor) / 4, with the floor and the marker the first review pass found missing");
  const edge = await run({ ...base, OB1_METADATA_MODEL: "qwen2.5:7b", OB1_EXTRACT_CHUNK_TOKENS: "7688" });
  assert(/extraction window\s+thoughts over 7688 estimated tokens/.test(edge.out) && !/do not fit/.test(edge.out), "…and the value it names is accepted: a window at the limit requests exactly the context");
  const overByOne = await run({ ...base, OB1_METADATA_MODEL: "qwen2.5:7b", OB1_EXTRACT_CHUNK_TOKENS: "7689" });
  assert(/OB1_EXTRACT_CHUNK_TOKENS=7689 — a window that long/.test(overByOne.out), "…while one token more warns");
  const tinyKnob = await run({ ...base, OB1_METADATA_MODEL: "qwen2.5:7b", OB1_EXTRACT_CHUNK_TOKENS: "1" });
  assert(/extraction window\s+OB1_EXTRACT_CHUNK_TOKENS=1 is under 64 tokens — a window that small is one model call per few words/.test(tinyKnob.out) && /at or above 64/.test(tinyKnob.out),
         "an explicit window under the minimum warns — the derived path refuses the same size, and until the third review pass the explicit one printed ok");
  const thinking = await run({ ...base, OB1_METADATA_MODEL: "qwen2.5:7b", OB1_METADATA_REASONING: "medium" });
  assert(/extraction window\s+thoughts over 1200 estimated tokens are extracted in 1200-token windows \(overlap 150\), derived from qwen2\.5:7b's 32768-token served context — held at 1200[^\n]*; no answer budget and no runaway retry — reasoning is on \(OB1_METADATA_REASONING\)/.test(thinking.out),
         "with reasoning on the row says the budget and the retry are off, and why — a budget would cap the thinking");
  assert(/chunk window\s+captures over 4096 tokens are windowed at 1200, derived from qwen3-embedding:4b's 40960-token window/.test(qwen.out)
         && /chunk window\s+captures over 4096 tokens are windowed at 1200, derived from qwen3-embedding:4b's 40960-token window/.test(unknown.out),
         "…while the embedding model's chunk window row does not move with the metadata model: two models, two tables");
}

console.log("\n[4] Unreachable database fails rather than hanging");
{
  const r = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql",
                        DATABASE_URL: "postgres://u:p@127.0.0.1:1/nope" });
  assert(r.code === 1, "a refused connection exits 1");
  assert(/schema/.test(r.out), "…and is reported against the schema check");
  // The direct-connection block's checks are one list, DIRECT_CHECKS: a
  // connection that fails before the first of them leaves each named — the
  // first carrying the error, the rest as not reached — and the list is kept
  // in step with the block's add() calls by reading the source, since nothing
  // else would (a renamed or added check would otherwise be blamed or silent).
  const src = readFileSync(join(HERE, "preflight.ts"), "utf8");
  const listed = [...src.match(/const DIRECT_CHECKS = \[([\s\S]*?)\];/)![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const from = src.indexOf('if (built.kind === "sql" && conn) {'), to = src.indexOf("const missing = DIRECT_CHECKS.filter");
  assert(from > 0 && to > from, "the block's two anchors are found in preflight.ts");
  const block = src.slice(from, to);
  // First appearance in the source is the order the block reports in, and the
  // catch blames the FIRST listed name not yet reported — so the list must be
  // in that order, not merely the same set.
  const added = [...new Set([...block.matchAll(/add\("([^"]+)"/g)].map((m) => m[1]))];
  assert(JSON.stringify(added) === JSON.stringify(listed), `DIRECT_CHECKS names exactly the checks the direct-connection block adds, in the order it adds them (block: ${added.join(", ")})`);
  assert(listed.every((n) => r.out.includes(n)), `…and an unreachable database names every one of them (${listed.filter((n) => !r.out.includes(n)).join(", ") || "all named"})`);
  assert(/vector extension\s+.*could not verify/.test(r.out) && /atomic capture\s+.*not checked — the direct connection failed before it/.test(r.out),
         "…the first carrying the error and the later ones saying they were not reached");
}

console.log("\n[5] Against a real database");
if (!LIVE) { skip("healthy configuration passes"); skip("missing schema is distinguished from bad credentials"); }
else {
  const { SQL } = await import("bun");
  // Drop and apply are separate calls on purpose: the two assertions between them
  // observe the un-migrated state, which is the thing this section tests.
  await dropSchema(LIVE);

  // Another tool's thoughts, in a schema of its own, does not make an
  // un-migrated public read as "exists but does not resolve" (SMD-2062's
  // review pass 1): the schema row still says to migrate.
  const otherTool = new SQL({ url: LIVE, max: 1 });
  await otherTool.unsafe("CREATE SCHEMA pf_stray; CREATE TABLE pf_stray.thoughts (id int)");
  let before: { code: number; out: string };
  try {
    before = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  } finally {
    await otherTool.unsafe("DROP SCHEMA pf_stray CASCADE");
    await otherTool.close();
  }
  assert(before.code === 1, "an un-migrated database exits 1");
  assert(/bun migrate\.ts/.test(before.out), "…and tells you to run the migrations");
  assert(/✗\s+schema\s+relation "thoughts" does not exist\n\s+→ Apply the migrations: cd db && bun migrate\.ts/.test(before.out),
         `…from the schema row too, with another schema's thoughts beside an empty public (${before.out.split("\n").find((l) => /\bschema\b/.test(l))?.trim()})`);

  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL });

  const after = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(after.code === 0, "a migrated database passes");
  assert(/thoughts table reachable/.test(after.out), "…and confirms the table is reachable");
  assert(/atomic capture\s+the 2- and 3-argument upsert_thought present, both 046's/.test(after.out), "…and that atomic capture is available, with the shipped bodies (a warn would also say \"present\")");
  assert(/✓  audit events\s+046's event shape present — the columns, the trigger that derives the kind from the key, the one lawful amendment — and every key classified/.test(after.out), "…and that 046's event shape is present, with no key waiting on a kind (SMD-1730)");
  assert(/no schema_migrations table/.test(after.out), "…and warns the schema was applied outside the runner");
  assert(/resolve_agent present/.test(after.out), "…and that the agent registry is available");

  /**
   * The agent registry is a WARNING where the audit trigger is fatal, and the
   * difference has to be asserted rather than asserted-in-a-comment: without
   * 010 every mutation is still attributed by key name, so refusing to start
   * would make applying a migration a hostage situation.
   *
   * Dropping just the function leaves the rest of the schema intact, which is
   * exactly the state a deployment on 009 is in.
   */
  const admin = new SQL({ url: LIVE, max: 1 });
  await admin.unsafe("DROP FUNCTION IF EXISTS resolve_agent(text, text, text)");
  await admin.close();

  const noRegistry = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(noRegistry.code === 0, "a database without migration 010 still starts");
  assert(/resolve_agent is missing/.test(noRegistry.out), "…while saying the registry is absent");
  assert(/attributed by key name only/.test(noRegistry.out), "…and what that costs");

  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL });

  /**
   * A capture-scoped key (SMD-1298) needs 049's wider CHECK on
   * ob1_agent_keys.scope; on a brain without it resolve_agent raises and every
   * hook capture lands unattributed while nothing says why. Put 010's CHECK
   * back and configure a capture key: the registry row fails and names 049;
   * without a capture key the same brain is fine; with 049 re-applied it is ok.
   */
  const KEYS_WITH_CAPTURE = `laptop:write:${"a".repeat(64)},session-hook:capture:${"b".repeat(64)}`;
  const before049 = new SQL({ url: LIVE, max: 1 });
  await before049.unsafe("ALTER TABLE ob1_agent_keys DROP CONSTRAINT IF EXISTS ob1_agent_keys_scope_check");
  // No CHECK at all — a table restored without it — is its own diagnosis, a warning, not 010's two-value CHECK (sixth review pass).
  const noCheck = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE, MCP_ACCESS_KEYS: KEYS_WITH_CAPTURE });
  assert(noCheck.code === 0 && /agent identity.*carries no CHECK at all/s.test(noCheck.out), `a brain with no scope CHECK at all warns as such and starts (exit ${noCheck.code})`);
  // A value list that names neither read nor write fails whatever keys are configured — it refuses them all at resolve_agent (twelfth review pass: it read as "not the scope rule").
  await before049.unsafe("ALTER TABLE ob1_agent_keys ADD CONSTRAINT ob1_agent_keys_scope_check CHECK (scope IN ('capture'))");
  const captureOnly = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE, MCP_ACCESS_KEYS: `laptop:write:${"a".repeat(64)}` });
  assert(captureOnly.code === 1 && /agent identity.*does not admit read or write \(ob1_agent_keys_scope_check: scope = 'capture'/s.test(captureOnly.out) && /every write key configured lands unattributed/.test(captureOnly.out),
         `a list naming capture alone fails with a write key configured, naming what it lacks (exit ${captureOnly.code})`);
  // …and is a warning when no key of the missing scope is configured: a brain with write keys alone may narrow the list on purpose (thirteenth review pass).
  await before049.unsafe("ALTER TABLE ob1_agent_keys DROP CONSTRAINT ob1_agent_keys_scope_check");
  await before049.unsafe("ALTER TABLE ob1_agent_keys ADD CONSTRAINT ob1_agent_keys_scope_check CHECK (scope IN ('write', 'capture'))");
  const writeOnly = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE, MCP_ACCESS_KEYS: `laptop:write:${"a".repeat(64)}` });
  assert(writeOnly.code === 0 && /!\s+agent identity.*does not admit read .*no key of that scope is configured, so nothing is refused today/s.test(writeOnly.out),
         `a list without read on a brain with write keys alone is a warning, not a failure (exit ${writeOnly.code})`);
  await before049.unsafe("ALTER TABLE ob1_agent_keys DROP CONSTRAINT ob1_agent_keys_scope_check");
  // The two-value rule under another name is the same failure, named — not "no CHECK at all" (ninth review pass).
  await before049.unsafe("ALTER TABLE ob1_agent_keys ADD CONSTRAINT scope_two_values CHECK (scope IN ('read', 'write'))");
  const oddName = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE, MCP_ACCESS_KEYS: KEYS_WITH_CAPTURE });
  assert(oddName.code === 1 && /admits read and write only \(under the name scope_two_values\)/.test(oddName.out) && !/no CHECK at all/.test(oddName.out),
         `a two-value CHECK under another name fails the row naming that constraint (exit ${oddName.code})`);
  // The array-literal spelling of the two-value rule is the same rule (thirteenth review pass: it read as "not the scope rule").
  await before049.unsafe("ALTER TABLE ob1_agent_keys ADD CONSTRAINT scope_array_literal CHECK (scope = ANY ('{read,write}'::text[]))");
  const literal = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE, MCP_ACCESS_KEYS: KEYS_WITH_CAPTURE });
  assert(literal.code === 1 && /admits read and write only \(under the name scope_array_literal, scope_two_values\)|admits read and write only \(under the name scope_two_values, scope_array_literal\)/.test(literal.out), `a two-value rule spelled as an array literal is a two-value rule (exit ${literal.code})`);
  await before049.unsafe("ALTER TABLE ob1_agent_keys DROP CONSTRAINT scope_array_literal");
  // The mixed shape — the three-value rule beside a two-value one under another name, what a drop by name would have left — fails naming the odd one: every value list must admit capture, not one (eleventh review pass: `.every` → `.some` survived).
  await before049.unsafe("ALTER TABLE ob1_agent_keys ADD CONSTRAINT ob1_agent_keys_scope_check CHECK (scope IN ('read', 'write', 'capture'))");
  const mixedShape = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE, MCP_ACCESS_KEYS: KEYS_WITH_CAPTURE });
  assert(mixedShape.code === 1 && /admits read and write only \(under the name scope_two_values\)/.test(mixedShape.out), `a two-value CHECK beside the three-value one still fails, naming it (exit ${mixedShape.code})`);
  await before049.unsafe("ALTER TABLE ob1_agent_keys DROP CONSTRAINT scope_two_values");
  // A CHECK on the column alone that is no value list is a warning naming its definition, not "read and write only" (eleventh review pass).
  await before049.unsafe("ALTER TABLE ob1_agent_keys ADD CONSTRAINT scope_nonempty CHECK (scope <> '')");
  const nonList = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE, MCP_ACCESS_KEYS: KEYS_WITH_CAPTURE });
  assert(nonList.code === 0 && /!\s+agent identity.*1 other CHECK\(s\) on ob1_agent_keys\.scope alone \(scope_nonempty: CHECK/s.test(nonList.out) && !/read and write only/.test(nonList.out),
         `a non-list CHECK on the column is warned about by its definition (exit ${nonList.code})`);
  await before049.unsafe("ALTER TABLE ob1_agent_keys DROP CONSTRAINT scope_nonempty");
  await before049.unsafe("ALTER TABLE ob1_agent_keys DROP CONSTRAINT ob1_agent_keys_scope_check");
  await before049.unsafe("ALTER TABLE ob1_agent_keys ADD CONSTRAINT ob1_agent_keys_scope_check CHECK (scope IN ('read', 'write'))");
  await before049.close();
  const captureBefore049 = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE, MCP_ACCESS_KEYS: KEYS_WITH_CAPTURE });
  assert(captureBefore049.code === 1 && /agent identity.*1 capture-scoped key\(s\) configured \(session-hook\) but ob1_agent_keys\.scope admits read and write only/s.test(captureBefore049.out),
         `a capture key on a brain before 049 fails the registry row, naming the key (exit ${captureBefore049.code})`);
  assert(/049_agent_key_scope_capture\.sql/.test(captureBefore049.out), "…with the migration to apply");
  const noCaptureBefore049 = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE, MCP_ACCESS_KEYS: `laptop:write:${"a".repeat(64)}` });
  assert(noCaptureBefore049.code === 0 && /resolve_agent present/.test(noCaptureBefore049.out), "…while the same brain with no capture key configured is fine");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("049") });
  const captureWith049 = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE, MCP_ACCESS_KEYS: KEYS_WITH_CAPTURE });
  assert(captureWith049.code === 0 && /the scope CHECK admits capture \(049\)/.test(captureWith049.out), "…and with 049 applied the row says the CHECK admits capture");

  /**
   * Migration 012, and the reason it is checked at all: the tool is registered
   * unconditionally, so a database without the function serves a tool that
   * errors on every call while everything else looks healthy.
   */
  const noKeyword = new SQL({ url: LIVE, max: 1 });
  await noKeyword.unsafe("DROP FUNCTION IF EXISTS search_thoughts_keyword(text, int, int, jsonb)");
  await noKeyword.close();

  const missingKw = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(missingKw.code === 1, "a database missing migration 012 does not start");
  assert(/search_thoughts_keyword is missing/.test(missingKw.out),
         "…and names the function rather than the symptom");
  assert(/012_search_thoughts_keyword\.sql/.test(missingKw.out), "…with the migration to apply");

  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("012") });
  const withKw = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/keyword search.*present/s.test(withKw.out), "…and reports it present once applied");

  /**
   * Migration 017, the same shape of check on a bigger surface: search and
   * search_thoughts call search_thoughts_hybrid unconditionally, so a database
   * without it serves the two most-used tools broken while the handshake and
   * every other tool look fine. The PostgREST branch probes by RPC and cannot
   * be exercised here; this holds the SQL branch's message and remedy.
   */
  const noHybrid = new SQL({ url: LIVE, max: 1 });
  await noHybrid.unsafe(`DROP FUNCTION IF EXISTS ${SEARCH_THOUGHTS_HYBRID_SIGNATURE}`);
  await noHybrid.close();
  const missingHy = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(missingHy.code === 1, "a database missing migration 017 does not start");
  assert(/search_thoughts_hybrid is missing/.test(missingHy.out), "…and names the function search and search_thoughts depend on");
  assert(/017_search_thoughts_hybrid\.sql/.test(missingHy.out) && /020_match_thoughts_recency\.sql/.test(missingHy.out), "…with the migration that defines it and the one that redefines it");
  assert(/search signatures.*not checked — a search function is missing/s.test(missingHy.out), "…and the signature check stands aside rather than repeating it");
  // 017 alone puts back the 5-argument form: present by name, and not the form
  // the server calls since 020 — which is its own failure, with 020 as the remedy.
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("017") });
  const withHy = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/hybrid search.*present/s.test(withHy.out), "…and reports it present once applied");
  assert(withHy.code === 1 && /search signatures.*search_thoughts_hybrid\(vector,text,double precision,integer,jsonb\) is the form from before migration 020/s.test(withHy.out),
         "a 017-era search_thoughts_hybrid under a 020 server does not start, and is named by its signature");
  assert(/every search would fail/.test(withHy.out) && /Apply db\/migrations\/020_match_thoughts_recency\.sql/.test(withHy.out), "…with 020 as the remedy");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("020") });
  const sigsOk = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(sigsOk.code === 0 && /search signatures.*the forms the servers call since migration 020, one of each/s.test(sigsOk.out), "with 020 re-applied both signatures are the ones the servers call, one of each");
  assert(/stats summary.*thought_stats_summary present/s.test(sigsOk.out), "…and a fully migrated database reports thought_stats_summary present (migration 024)");

  /**
   * Migration 024's function, the same shape of check on the SQL path: on the
   * SQL store thought_stats calls thought_stats_summary(), so a database that
   * stops at 023 serves that one tool broken while everything else is fine
   * (SMD-1249). LIVE is fully healthy here (sigsOk exited 0), so dropping only
   * this function isolates the fail to it.
   */
  const noStats = new SQL({ url: LIVE, max: 1 });
  await noStats.unsafe("DROP FUNCTION IF EXISTS thought_stats_summary()");
  await noStats.close();
  const missingStats = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(missingStats.code === 1, "a database missing migration 024 does not start");
  assert(/thought_stats_summary is missing/.test(missingStats.out), "…and names the function thought_stats depends on");
  assert(/024_thought_stats_summary\.sql/.test(missingStats.out), "…with the migration to apply");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("024") });
  const withStats = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(withStats.code === 0 && /stats summary.*present/s.test(withStats.out), "…and reports it present once applied, the database healthy again");

  /**
   * Migration 025's provenance functions (SMD-1253). capture_thought accepts
   * derived_from/supersedes, but the pre-025 upsert_thought drops those envelope
   * keys silently, and trace_provenance/find_derivatives (and the search label)
   * are absent — a recording tool taking input it cannot honour. A database that
   * stops at 024 must not start. LIVE is healthy here, so dropping one read
   * function isolates the fail to this check — and proves the per-function count
   * (a combined >= 2 would miss one missing function; review pass 1).
   */
  // Drop only ONE of the two, so the check's per-function count is what fails,
  // not a combined >=2 that a double-overload of the survivor could satisfy
  // (review pass 1).
  const noProv = new SQL({ url: LIVE, max: 1 });
  await noProv.unsafe("DROP FUNCTION IF EXISTS find_derivatives(uuid, int)");
  await noProv.close();
  const missingProv = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(missingProv.code === 1, "a database missing one of migration 025's functions does not start");
  assert(/provenance.*functions are missing/s.test(missingProv.out), "…and names the provenance functions the write path depends on");
  assert(/025_thought_provenance\.sql/.test(missingProv.out), "…with the migration to apply");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("025") });
  const withProv = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(withProv.code === 0 && /provenance.*present/s.test(withProv.out), "…and reports it present once applied, the database healthy again");
  // …but 025 re-applied put 025's trace_provenance — the per-path recursive
  // walk 026 replaced — back over 026's, with no error. The same statement the
  // vendored provenance-chains schema carries (SMD-1250). A warning naming 026.
  assert(/provenance\s+trace_provenance and find_derivatives present, but trace_provenance's body is not 026's/.test(withProv.out) && /Apply db\/migrations\/026_trace_provenance_bounded\.sql\./.test(withProv.out),
         "…and, 025 re-applied over 026, says trace_provenance's body is not 026's, naming 026");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("026") });
  assert(/provenance\s+trace_provenance and find_derivatives present; trace_provenance's body is 026's, the walk bounded/.test((await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE })).out),
         "…and 026 re-applied is the bounded walk again, said as such");

  /**
   * Two more bodies a vendored file replaced on a real brain (SMD-1250, fourth
   * review pass): the edge-function-cost-optimization recipe's (retired by
   * SMD-1800) thought_stats_summary over 024's — a warning, thought_stats raising on a
   * null topic — and upstream's thought-work-claims release_thought over
   * 015's — a failure, every worker release refused by 015's CHECK. Stand-ins
   * with the same shape and none of the clause each recogniser reads; and a
   * stray overload of an owned claim name, which is a warning naming it with
   * its DROP.
   */
  const tamper = new SQL({ url: LIVE, max: 1 });
  await tamper.unsafe("CREATE OR REPLACE FUNCTION thought_stats_summary() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$");
  const statsStale = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(statsStale.code === 0 && /stats summary\s+thought_stats_summary present, but its body is not 024's/.test(statsStale.out) && /024_thought_stats_summary\.sql/.test(statsStale.out),
         "a thought_stats_summary body that is not 024's is a warning naming 024");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("024") });
  assert(/stats summary\s+thought_stats_summary present, 024's body/.test((await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE })).out), "…and 024 re-applied is said to be 024's");
  // 015's parameter names kept: CREATE OR REPLACE refuses to rename a
  // parameter ("cannot change name of input parameter"), which is also why
  // upstream's body, with the same names, goes over 015's unrefused.
  await tamper.unsafe("CREATE OR REPLACE FUNCTION release_thought(p_thought_id uuid, p_work_type text, p_worker_id text, p_status text, p_error text DEFAULT NULL) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$");
  const releaseStale = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(releaseStale.code === 1 && /work claims\s+release_thought's or release_claims_for_worker's body is not 015's — it does not clear the lease/.test(releaseStale.out) && /015_thought_work_claims\.sql/.test(releaseStale.out),
         "a release_thought body that is not 015's does not start, naming 015 and the CHECK every worker release would fail");
  await tamper.unsafe("CREATE FUNCTION claim_thoughts(uuid[], text, text, int) RETURNS SETOF uuid LANGUAGE sql AS $$ SELECT NULL::uuid WHERE false $$");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("015") });
  const stray = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(stray.code === 0 && /work claims\s+claim_thoughts, release_thought, release_claims_for_worker and renew_claims present with 015's and 031's bodies; 1 overload\(s\) no migration defines: claim_thoughts\(_uuid,text,text,int4\)/.test(stray.out) && /DROP FUNCTION claim_thoughts\(_uuid,text,text,int4\);/.test(stray.out),
         "015 re-applied puts the bodies back, and an overload no migration defines is a warning naming it with its DROP");
  await tamper.unsafe("DROP FUNCTION claim_thoughts(uuid[], text, text, int)");
  await tamper.close();
  assert(/work claims\s+claim_thoughts, release_thought, release_claims_for_worker and renew_claims present with 015's and 031's bodies\s*$/m.test((await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE })).out),
         "…and dropped, the claim functions are the shipped four, said as such");

  /**
   * Migration 014 lives in a SET clause on match_thoughts, which a later
   * CREATE OR REPLACE drops without any error. Re-applying 007 is exactly that
   * event: same signature, no iterative scan. A warning, because every search
   * still answers — with the filtered recall it had before 014.
   */
  assert(/filtered search.*scans iteratively/s.test(withKw.out), "a fully migrated match_thoughts is reported as scanning iteratively");
  // This fixture just re-applied 012 ALONE, which is the trap 019's header names:
  // CREATE OR REPLACE reset search_thoughts_keyword's estimate to 1,000 while
  // match_thoughts still carries its clause and ROWS 10. The check says exactly that.
  assert(/candidate scan.*carries enable_seqscan = off but search_thoughts_keyword's row estimate is 1000 rather than 25/s.test(withKw.out), "…while 019's check reports the keyword estimate that re-applying 012 alone reset");
  // A database that predates 020 as well as 014: 020's function dropped first
  // (re-applying 007 over 020 would otherwise CREATE a second overload, the
  // state tested at the end), then 007's 4-argument body. The 014 check reads
  // the one function there is, whatever its arity, and still says what is
  // wrong with its body; the signature check separately fails the start.
  const pre020 = new SQL({ url: LIVE, max: 1 });
  await pre020.unsafe(`DROP FUNCTION ${MATCH_THOUGHTS_SIGNATURE}`);
  await pre020.close();
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("007") });
  const pre014 = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(pre014.code === 1 && /search signatures.*match_thoughts\(vector,double precision,integer,jsonb\) is the form from before migration 020/s.test(pre014.out),
         "a 4-argument match_thoughts under a 020 server does not start, named by its signature");
  assert(/does not carry hnsw\.iterative_scan/.test(pre014.out), "…while 014's check still reads the body it found and says the filtered scan is not iterative");
  assert(/migration 014 is not applied/.test(pre014.out), "…and, with no ledger, calls it not applied");
  assert(/014_filtered_match_thoughts\.sql/.test(pre014.out), "…with the migration to apply");

  /**
   * The other wording. With 014 RECORDED in the ledger and the function still
   * 007's, "apply 014" is a no-op — migrate.ts skips it — so the remedy has to
   * be the ALTER FUNCTION that puts the clauses back (or the body, when that
   * was dropped too). This database has no ledger; one is created for the
   * probe and removed after, so the earlier "no schema_migrations table"
   * assertions stay true of the same fixture.
   */
  const ledger = new SQL({ url: LIVE, max: 1 });
  await ledger.unsafe(`CREATE TABLE schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  await ledger.unsafe(`INSERT INTO schema_migrations (name, sha256) VALUES ('014_filtered_match_thoughts.sql', 'test')`);
  await ledger.close();
  const dropped = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/search signatures.*before migration 020/s.test(dropped.out), "a recorded 014 whose function was replaced by 007's is still the pre-020 form (the signature check says so)");
  // Re-applying 007 replaces the BODY as well as the clause, so this is the
  // "replaced its body" wording with the body re-run as the remedy.
  assert(/recorded as applied — --baseline recorded it without running it, or a later redefinition replaced its body/.test(dropped.out), "…and is described as recorded-but-not-in-effect (--baseline or a redefinition), not a missing migration");
  assert(/Re-apply the recorded migrations with the migrator — cd db && bun migrate\.ts --url … --reapply/.test(dropped.out), "…with a remedy a plain run will not turn into a no-op: the migrator's re-run");
  // The other branch: 014's body intact, its SET clause gone — what a successor
  // that redefined the function without the clause leaves. (An earlier draft
  // asserted this wording with a regex alternative that could never match the
  // singular the check prints, on a fixture that never reached the branch.)
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f >= "013" });
  const reset = new SQL({ url: LIVE, max: 1 });
  await reset.unsafe(`ALTER FUNCTION ${MATCH_THOUGHTS_SIGNATURE} RESET ALL`);
  await reset.close();
  const noClause = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(noClause.code === 0, "a recorded 014 whose function lost only its SET clause still starts");
  assert(/has 014's body but no iterative scan in force although migration 014 is recorded as applied — a later redefinition dropped its SET clause/.test(noClause.out), "…is described as 014's body without its clause");
  assert(/ALTER FUNCTION match_thoughts\(vector,double precision,integer,jsonb,double precision,double precision\) SET hnsw\.iterative_scan = relaxed_order/.test(noClause.out), "…with the ALTER FUNCTION that puts the clause back as the remedy, naming the signature the catalog holds");
  // RESET ALL took 019's clause with it (prorows it leaves alone): the second
  // check names the clause, as a warning, with 041's file as the remedy since
  // this ledger records neither 019 nor 041 — 041 is the last definer and
  // carries 019's clauses; 019's own file is never named (review pass 2).
  assert(/candidate scan.*does not carry enable_seqscan = off — migration 019 is not applied/s.test(noClause.out), "the candidate-scan check reports 019's clause missing");
  // The remedy is the LAST definer, not 019's file: on this 6-argument brain
  // 019's CREATE would put the 4-argument form back beside it (the state the
  // twoForms section below fails the start on), while 041 carries 019's
  // clauses and ROWS 10 with its own and drops that form (review pass 2).
  assert(/Apply db\/migrations\/041_match_thoughts_pin_paths\.sql — the last definer of match_thoughts, which carries 019's clauses and ROWS 10 with its own \(019's file alone would re-create the 4-argument form 020 dropped\)\.\s*$/m.test(noClause.out) && !/Apply db\/migrations\/019/.test(noClause.out) && !/Then put the keyword estimate back/.test(noClause.out),
         "…with 041, the last definer, as the whole remedy while the ledger records neither 019 nor 041 — never 019's own file, and no keyword ALTER while that estimate holds");
  // The other remedy: 019 recorded, the clause gone — the ALTER that restores both.
  const led019 = new SQL({ url: LIVE, max: 1 });
  // 040 and 041 recorded beside 019: a brain whose function carries their
  // clauses and whose ledger records 019 records them too, and a recorded
  // last definer is what makes the ALTER, not a file, the remedy (review pass 2).
  await led019.unsafe(`INSERT INTO schema_migrations (name, sha256) VALUES ('019_match_thoughts_plan_and_rows.sql', 'test'), ('040_match_thoughts_jit_off.sql', 'test'), ('041_match_thoughts_pin_paths.sql', 'test')`);
  // RESET ALL leaves prorows alone; a CREATE OR REPLACE would not, so reset it by hand as a redefinition would —
  // and reset the keyword function's too, as re-applying 012 alone does. 040's
  // jit clause and 041's two pins are put back here so this fixture is 019's
  // loss alone; their own losses are probed after the walk-index probes below.
  await led019.unsafe(`ALTER FUNCTION ${MATCH_THOUGHTS_SIGNATURE} SET hnsw.iterative_scan = relaxed_order SET jit = off SET enable_nestloop = on SET enable_tidscan = on ROWS 1000`);
  await led019.unsafe(`ALTER FUNCTION search_thoughts_keyword(text, int, int, jsonb) ROWS 1000`);
  await led019.close();
  const noSeq = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(noSeq.code === 0, "a recorded 019 whose function lost only its plan setting still starts");
  assert(/filtered search.*scans iteratively/s.test(noSeq.out) && /candidate scan.*although migration 019 is recorded as applied — a later redefinition dropped its SET clause, and match_thoughts' row estimate is 1000 rather than 10, and search_thoughts_keyword's row estimate is 1000 rather than 25/s.test(noSeq.out),
         "…014's check is satisfied while 019's names the dropped clause and both reset estimates");
  assert(/ALTER FUNCTION match_thoughts\(vector,double precision,integer,jsonb,double precision,double precision\) SET enable_seqscan = off ROWS 10; ALTER FUNCTION search_thoughts_keyword\(text, int, int, jsonb\) ROWS 25;/.test(noSeq.out), "…with one ALTER FUNCTION per function as the remedy, after any body re-apply");
  // Only the keyword estimate gone: the clause is fine, one ALTER, the other function not named.
  const kwOnly = new SQL({ url: LIVE, max: 1 });
  await kwOnly.unsafe(`ALTER FUNCTION ${MATCH_THOUGHTS_SIGNATURE} SET enable_seqscan = off SET jit = off SET enable_nestloop = on SET enable_tidscan = on ROWS 10`);
  await kwOnly.close();
  const kwReset = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/candidate scan.*carries enable_seqscan = off but search_thoughts_keyword's row estimate is 1000 rather than 25 — a redefinition reset what 019 declared/s.test(kwReset.out), "a reset keyword estimate alone is named alone");
  assert(/Put it back[^\n]*ALTER FUNCTION search_thoughts_keyword\(text, int, int, jsonb\) ROWS 25;/.test(kwReset.out) && !/Put it back[^\n]*ALTER FUNCTION match_thoughts/.test(kwReset.out), "…with only its own ALTER as the remedy");
  const unledger = new SQL({ url: LIVE, max: 1 });
  await unledger.unsafe(`DROP TABLE schema_migrations`);
  await unledger.close();
  // 007 also re-created the chunk writers without the context column, and the
  // RESET above took 014's clause: restore 013 and 014.
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f >= "013" });
  // Everything shipped again: both estimates and the clause, reported as ok.
  const shipped = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/candidate scan.*declares enable_seqscan = off and ROWS 10, search_thoughts_keyword ROWS 25 \(019\), match_thoughts jit = off \(040\) and enable_nestloop = on with enable_tidscan = on \(041\)/s.test(shipped.out), "with every migration re-applied, the candidate-scan check reports 019's clause, both row estimates, 040's clause and 041's two pins");
  assert(shipped.code === 0 && /search signatures.*one of each/s.test(shipped.out), "…and the signature check is satisfied");
  // 039: the walk's cast and the index's expression are one contract in two
  // halves, and each half moves by hand without the other — 037 re-applied
  // alone puts a raw-column body over the halfvec indexes; 001's DDL re-run
  // after a drop puts a vector index under the cast body. Everything else
  // reads as ok in both states; every walk is a sequential scan.
  assert(/walk index.*orders its walk by embedding::halfvec and both HNSW indexes are over that expression \(039\)/s.test(shipped.out), "with every migration applied, the walk-index check pairs the body's cast with both indexes");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("038") });
  const rawBody = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(rawBody.code === 0 && /walk index.*orders its walk by the vector column but thoughts_embedding_idx is over embedding::halfvec; thought_chunks_embedding_idx is over embedding::halfvec/s.test(rawBody.out),
         "038 re-applied over 039: the check names the raw-column body over both halfvec indexes, as a warning");
  assert(/Apply db\/migrations\/039_match_thoughts_halfvec_index\.sql/.test(rawBody.out), "…with 039 as the remedy");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("039") });
  const rebuilt = new SQL({ url: LIVE, max: 1 });
  await rebuilt.unsafe(`DROP INDEX thoughts_embedding_idx`);
  await rebuilt.unsafe(`CREATE INDEX thoughts_embedding_idx ON thoughts USING hnsw (embedding vector_cosine_ops)`);
  await rebuilt.close();
  const vecIdx = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/walk index.*orders its walk by embedding::halfvec but thoughts_embedding_idx is over the vector column —/s.test(vecIdx.out) && !/thought_chunks_embedding_idx is over/.test(vecIdx.out),
         "001's DDL re-run by hand: the check names the vector index under the cast body and leaves the chunk index unmentioned");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("039") });
  const paired = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/walk index.*over that expression \(039\)/s.test(paired.out), "…and re-applying 039 pairs them again");
  // The other two branches, and the ledger's suffix (review pass 3): an
  // INVALID index under the name — what an interrupted CONCURRENTLY build
  // leaves, made here by flipping the catalog flag as test-upgrade [16] does —
  // a missing index, and the wording when the ledger records 039.
  const broken = new SQL({ url: LIVE, max: 1 });
  await broken.unsafe(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = to_regclass('thoughts_embedding_idx')`);
  await broken.unsafe(`CREATE TABLE schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  await broken.unsafe(`INSERT INTO schema_migrations (name, sha256) VALUES ('039_match_thoughts_halfvec_index.sql', 'test')`);
  await broken.close();
  const invalid = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/walk index.*thoughts_embedding_idx is INVALID \(an interrupted CREATE INDEX CONCURRENTLY\), which the planner ignores — although migration 039 is recorded as applied/s.test(invalid.out),
         "an INVALID index under the name is named as such, with the ledger's suffix when 039 is recorded");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("039") });
  const rebuiltValid = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/walk index.*over that expression \(039\)/s.test(rebuiltValid.out), "…and the remedy — 039 again — rebuilds it");
  const gone = new SQL({ url: LIVE, max: 1 });
  await gone.unsafe(`DROP INDEX thought_chunks_embedding_idx`);
  await gone.unsafe(`DROP TABLE schema_migrations`);
  await gone.close();
  const missing = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/walk index.*thought_chunks_embedding_idx does not exist — the planner has no index path/s.test(missing.out) && !/although migration 039 is recorded/.test(missing.out),
         "a missing index is named, without the ledger's suffix when nothing records 039");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("039") });
  const restored039 = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/walk index.*over that expression \(039\)/s.test(restored039.out), "…and 039 builds it where the name is free");
  // 039's file alone, as the walk-index probes above applied it, is the state
  // 040's header names for its clause and 041's for its pins: 039's CREATE
  // carries 019's clauses and neither 040's nor 041's, so the candidate-scan
  // check warns for both — with 041, the last definer, as the one remedy.
  // 040 applied over it puts the jit clause back and not the pins, which the
  // check then names alone; 041 puts everything back.
  assert(/candidate scan.*but not jit = off — migration 040 is not applied[^\n]*; and it does not carry enable_nestloop = on and enable_tidscan = on — migration 041 is not applied, so an operator's enable_nestloop = off/s.test(restored039.out) && /041_match_thoughts_pin_paths\.sql/.test(restored039.out) && !/040_match_thoughts_jit_off\.sql/.test(restored039.out),
         "…while 039 applied alone has dropped 040's clause and 041's pins: the candidate-scan check names both losses and 041, the last definer, as the remedy — not 040's file");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("040") });
  const only040 = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(only040.code === 0 && /candidate scan.*carries enable_seqscan = off, both row estimates hold and jit = off, but not enable_nestloop = on and enable_tidscan = on — migration 041 is not applied: an operator's enable_nestloop = off at any level reaches every join in the call/s.test(only040.out) && /041_match_thoughts_pin_paths\.sql/.test(only040.out) && !/not carry jit = off/.test(only040.out),
         "…040 applied over it carries the jit clause and not the pins: the check names the pins alone, with what an operator's setting does without them, and 041 as the remedy");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("041") });
  assert(/candidate scan.*match_thoughts jit = off \(040\) and enable_nestloop = on with enable_tidscan = on \(041\)/s.test((await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE })).out), "…and 041 applied over it is reported as carrying the clause and both pins");
  // 040's clause alone gone — what a redefinition that carried 019's clauses
  // and 041's pins and not 040's leaves: a warning naming the compile it lets
  // back in, with 041, the last definer, as the remedy while no ledger records
  // it, then ok again once 041 is re-applied.
  const jitReset = new SQL({ url: LIVE, max: 1 });
  await jitReset.unsafe(`ALTER FUNCTION ${MATCH_THOUGHTS_SIGNATURE} RESET jit`);
  await jitReset.close();
  const noJit = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(noJit.code === 0 && /candidate scan.*carries enable_seqscan = off and both row estimates hold, but not jit = off — migration 040 is not applied: a planner path disabled at any level/s.test(noJit.out) && /041_match_thoughts_pin_paths\.sql/.test(noJit.out) && !/enable_nestloop = on and enable_tidscan = on — migration 041/.test(noJit.out),
         "match_thoughts without 040's jit clause still starts, and the candidate-scan check names the clause, the compile it lets back in and 041 — the last definer — as the remedy, with nothing said of the pins, which hold");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("041") });
  assert(/candidate scan.*match_thoughts jit = off \(040\) and enable_nestloop = on with enable_tidscan = on \(041\)/s.test((await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE })).out), "…and 041 re-applied is reported as carrying it");
  // 041's two pins alone gone — what 040's file re-applied by hand leaves, or
  // a redefinition that carried 040's clause and not 041's: the last branch
  // of the check, naming what an operator's setting does without them, 041's
  // file as the remedy while no ledger records it (SMD-1677).
  const pinsReset = new SQL({ url: LIVE, max: 1 });
  await pinsReset.unsafe(`ALTER FUNCTION ${MATCH_THOUGHTS_SIGNATURE} RESET enable_nestloop RESET enable_tidscan`);
  await pinsReset.close();
  const noPins = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(noPins.code === 0 && /candidate scan.*carries enable_seqscan = off, both row estimates hold and jit = off, but not enable_nestloop = on and enable_tidscan = on — migration 041 is not applied: an operator's enable_nestloop = off at any level reaches every join in the call[^\n]*on PostgreSQL 18 enable_tidscan = off leaves the gate's probe no TID Range path/s.test(noPins.out) && /Apply db\/migrations\/041_match_thoughts_pin_paths\.sql\.\s*$/m.test(noPins.out),
         "match_thoughts without 041's pins still starts, and the candidate-scan check names both pins, what each setting does without them, and 041's file as the whole remedy");
  const onePin = new SQL({ url: LIVE, max: 1 });
  await onePin.unsafe(`ALTER FUNCTION ${MATCH_THOUGHTS_SIGNATURE} SET enable_nestloop = on`);
  await onePin.close();
  // One pin back of two — also the state the header's escape hatch leaves
  // (`ALTER FUNCTION … RESET enable_nestloop`): still the warning, naming the
  // one pin that is missing and what that setting alone does, and nothing
  // about the one that holds (review pass 1).
  const onePinOut = (await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE })).out;
  assert(/candidate scan.*but not enable_tidscan = on — migration 041 is not applied: on PostgreSQL 18 enable_tidscan = off leaves the gate's probe no TID Range path/s.test(onePinOut) && !/not enable_nestloop = on/.test(onePinOut) && !/reaches every join/.test(onePinOut) && /Apply db\/migrations\/041_match_thoughts_pin_paths\.sql\.\s*$/m.test(onePinOut),
         "…and one pin back of two is still the warning, naming only the pin that is missing and what its setting alone does, with 041's file as the remedy");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("041") });
  assert(/candidate scan.*match_thoughts jit = off \(040\) and enable_nestloop = on with enable_tidscan = on \(041\)/s.test((await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE })).out), "…and 041 re-applied puts both back");
  // The other wording, with 040 RECORDED: "apply 040" would be a no-op for a
  // plain run, so the remedy is the ALTER that puts the clause back — and,
  // with the keyword estimate reset beside it and 019 recorded too, the
  // Put-it-back list names both functions. Then 019 recorded but the ledger
  // lacking 040, the keyword estimate reset: the file for 040's clause and
  // the keyword ALTER beside it, since 040 does not define that function
  // (review pass 1). The ledger is created for these probes and dropped after.
  const led040 = new SQL({ url: LIVE, max: 1 });
  await led040.unsafe(`CREATE TABLE schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  await led040.unsafe(`INSERT INTO schema_migrations (name, sha256) VALUES ('019_match_thoughts_plan_and_rows.sql', 'test'), ('040_match_thoughts_jit_off.sql', 'test'), ('041_match_thoughts_pin_paths.sql', 'test')`);
  await led040.unsafe(`ALTER FUNCTION ${MATCH_THOUGHTS_SIGNATURE} RESET jit`);
  await led040.unsafe(`ALTER FUNCTION search_thoughts_keyword(text, int, int, jsonb) ROWS 1000`);
  await led040.close();
  const recorded040 = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/candidate scan.*carries enable_seqscan = off but search_thoughts_keyword's row estimate is 1000 rather than 25 — a redefinition reset what 019 declared; every query[^\n]*; and it does not carry jit = off although migration 040 is recorded as applied — a later redefinition dropped its SET clause/s.test(recorded040.out),
         "with 019 and 040 recorded, a reset keyword estimate and a dropped jit clause are both named, the clause as recorded-but-dropped");
  assert(/Put it back[^\n]*ALTER FUNCTION match_thoughts\(vector,double precision,integer,jsonb,double precision,double precision\) SET jit = off; ALTER FUNCTION search_thoughts_keyword\(text, int, int, jsonb\) ROWS 25;/.test(recorded040.out),
         "…with one ALTER per function as the remedy — SET jit = off for match_thoughts, ROWS 25 for the keyword function");
  // And with 041 recorded and both pins RESET beside the jit clause: the
  // ledger clause says recorded-but-dropped-or-RESET, and the one ALTER
  // carries all three SETs — the fragment the file remedy never prints, so
  // nothing else in this suite would catch a typo in it (review pass 1, run-it).
  const led041 = new SQL({ url: LIVE, max: 1 });
  await led041.unsafe(`ALTER FUNCTION ${MATCH_THOUGHTS_SIGNATURE} RESET enable_nestloop RESET enable_tidscan`);
  await led041.close();
  const recorded041 = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/and it does not carry enable_nestloop = on and enable_tidscan = on although migration 041 is recorded as applied — a later redefinition dropped them, or an ALTER FUNCTION … RESET took them off, so an operator's enable_nestloop = off/.test(recorded041.out),
         "with 041 recorded and both pins RESET, the pins are named as recorded-but-dropped, allowing for a RESET");
  assert(/Put it back[^\n]*ALTER FUNCTION match_thoughts\(vector,double precision,integer,jsonb,double precision,double precision\) SET jit = off SET enable_nestloop = on SET enable_tidscan = on; ALTER FUNCTION search_thoughts_keyword\(text, int, int, jsonb\) ROWS 25;/.test(recorded041.out),
         "…and the one ALTER for match_thoughts carries the jit clause and both pins, the keyword function's its ROWS 25");
  const led040b = new SQL({ url: LIVE, max: 1 });
  await led040b.unsafe(`DELETE FROM schema_migrations WHERE name LIKE '040%' OR name LIKE '041%'`);
  await led040b.close();
  const unrecorded040 = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  // The jit clause, both pins and the keyword estimate are missing here (the
  // recorded-041 probe above RESET the pins); 019's clause and ROWS 10 hold,
  // so the file is named without the parenthetical about 019's clauses
  // (review pass 3 of SMD-1624; pass 2 of SMD-1677 for the pins).
  assert(/Apply db\/migrations\/041_match_thoughts_pin_paths\.sql\. Then put the keyword estimate back: SELECT '\[1\]'::vector; ALTER FUNCTION search_thoughts_keyword\(text, int, int, jsonb\) ROWS 25;/.test(unrecorded040.out),
         "…and with neither 040 nor 041 recorded the remedy is 041's file — the last definer, which carries 040's clause and its own pins — and the keyword ALTER beside it, which 041 cannot restore");
  assert(!/the last definer of match_thoughts/.test(unrecorded040.out), "…without the note about 019's clauses, which hold here");
  const unled040 = new SQL({ url: LIVE, max: 1 });
  await unled040.unsafe(`DROP TABLE schema_migrations`);
  await unled040.unsafe(`ALTER FUNCTION search_thoughts_keyword(text, int, int, jsonb) ROWS 25`);
  await unled040.close();
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("041") });
  assert(/candidate scan.*declares enable_seqscan = off and ROWS 10, search_thoughts_keyword ROWS 25 \(019\), match_thoughts jit = off \(040\) and enable_nestloop = on with enable_tidscan = on \(041\)/s.test((await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE })).out), "…and everything put back is reported ok again");
  // A server that would not compile — Supabase's, whose images have no LLVM
  // JIT and whose upgrades set jit off; here the database's own jit off, the
  // setting a fresh connection (preflight's) inherits — is told the missing
  // clause costs it nothing today (review pass 4).
  const dbJit = new SQL({ url: LIVE, max: 1 });
  await dbJit.unsafe(`DO $j$ BEGIN EXECUTE format('ALTER DATABASE %I SET jit = off', current_database()); END $j$`);
  await dbJit.unsafe(`ALTER FUNCTION ${MATCH_THOUGHTS_SIGNATURE} RESET jit`);
  await dbJit.close();
  const noJitServer = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/candidate scan.*but not jit = off — migration 040 is not applied[^\n]*\(not on this server today: it has no JIT, or its own jit is off/s.test(noJitServer.out),
         "on a server whose own jit is off the missing clause is still named, with the note that it costs nothing there today");
  const dbJitBack = new SQL({ url: LIVE, max: 1 });
  await dbJitBack.unsafe(`DO $j$ BEGIN EXECUTE format('ALTER DATABASE %I RESET jit', current_database()); END $j$`);
  await dbJitBack.close();
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("041") });
  assert(!/not on this server today/.test((await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE })).out), "…and with the database's jit back on and 041 applied, neither the warning nor the note appears");

  /**
   * The other state 020's header names: an earlier migration re-applied by hand
   * OVER 020 re-creates the 4-argument form BESIDE the 6-argument one. The
   * server's own calls still resolve, so nothing above notices; every
   * 4-argument call is now "function is not unique". Failed, with the DROP 020
   * runs as the remedy, spelled with the signature the catalog holds.
   */
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("014") });
  const twoForms = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(twoForms.code === 1 && /search signatures.*beside the forms the servers call there is an earlier one: match_thoughts\(vector,double precision,integer,jsonb\)/s.test(twoForms.out),
         "a 4-argument match_thoughts re-created beside 020's does not start, and the earlier form is named");
  assert(/function is not unique/.test(twoForms.out) && /DROP FUNCTION match_thoughts\(vector,double precision,integer,jsonb\);/.test(twoForms.out), "…with the DROP as the remedy");
  assert(/filtered search.*scans iteratively/s.test(twoForms.out), "…while the 014 check reads 020's function, the one the servers call, not the re-created one");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f >= "019" });
  const oneForm = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(oneForm.code === 0 && /search signatures.*one of each/s.test(oneForm.out), "re-applying 019 and 020 leaves one form again");

  /**
   * The trigram flag is read only when 011 APPLIES. Migrations run once, so a
   * deployment that flips it afterwards and re-runs the migrator gets a clean
   * "already applied" and no change to the index — a silent no-op on an explicit
   * instruction, in both directions. Preflight is the only thing that notices,
   * so all four combinations are covered here.
   *
   * SMD-944 flipped the default from off to on, which inverts which of these
   * states the schema starts in: applyMigrations above now builds the index.
   */
  const agreeOn = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/trigram index.*enabled and present/s.test(agreeOn.out),
         "with the flag unset, the default builds the index and preflight agrees");

  // Present, but this deployment says it does not want it. A small brain that
  // turned it off is paying the write cost for nothing, and only preflight can
  // say so — the migrator will not drop it.
  const unwanted = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE, OB1_TRGM_INDEX: "off" });
  assert(unwanted.code === 0, "a trigram mismatch is a warning, not a refusal to serve");
  assert(/exists but OB1_TRGM_INDEX is off/.test(unwanted.out),
         "an index nobody asked for is reported — it costs every capture");
  assert(/DROP INDEX CONCURRENTLY/.test(unwanted.out), "…with the statement that fixes it");

  // The mirror, and the one that matters most after the default flip: every
  // deployment that applied 011 before SMD-944 is in exactly this state — the
  // default now wants the index, the ledger says 011 is done, and no index
  // exists. Their keyword search works and sequentially scans.
  const idx = new SQL({ url: LIVE, max: 1 });
  await idx.unsafe("DROP INDEX IF EXISTS idx_thoughts_content_trgm");
  await idx.close();

  const wantOn = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(wantOn.code === 0, "a database upgraded from before the flip still starts");
  assert(/OB1_TRGM_INDEX is on but idx_thoughts_content_trgm does not exist/.test(wantOn.out),
         "…and names the disagreement between the setting and the database");
  assert(/CREATE INDEX CONCURRENTLY/.test(wantOn.out), "…with the statement that fixes it");

  // And the fourth state: both off, which is a supported configuration rather
  // than a problem, so it must not warn.
  const agreeOff = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE, OB1_TRGM_INDEX: "off" });
  assert(/trigram index.*disabled/s.test(agreeOff.out),
         "asking for it off, with it absent, is reported as agreement and not a warning");

  /**
   * Chunk context, in the four states it can be in.
   *
   * The one that has to FAIL is the flag on against a database without
   * migration 013: the column the blurbs go into does not exist, the
   * chunk-writing functions from 007 and 009 simply do not select the key, and
   * every capture succeeds while the context is generated, embedded and
   * dropped. Nothing else in the system would ever mention it.
   */
  const ctx = new SQL({ url: LIVE, max: 1 });
  await ctx.unsafe("ALTER TABLE thought_chunks DROP COLUMN IF EXISTS context");

  const noColumnOff = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/chunk context.*off \(migration 013 not applied\)/s.test(noColumnOff.out),
         "off against a database without 013 is agreement, not a warning");

  const noColumnOn = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE, OB1_CHUNK_CONTEXT: "on" });
  assert(noColumnOn.code !== 0, "the flag on without 013 refuses to start");
  assert(/every blurb would reach the VECTOR and none would be recorded/.test(noColumnOn.out),
         "…and says what would silently happen — the blurb lands in the embedding, only the record is lost");
  assert(/013_chunk_context\.sql/.test(noColumnOn.out), "…with the migration that fixes it");

  await ctx.unsafe("ALTER TABLE thought_chunks ADD COLUMN IF NOT EXISTS context text");
  await ctx.unsafe("DELETE FROM thoughts");

  const empty = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE, OB1_CHUNK_CONTEXT: "on" });
  assert(/chunk context.*on, no chunks stored yet/s.test(empty.out),
         "on with 013 applied and nothing captured is reported as ok");

  /**
   * The mixed corpus — the state SMD-951 exists to make visible. Written
   * directly rather than captured, because producing it through the server
   * would mean running two servers with different settings; what preflight
   * reads is the rows, and this is the rows.
   */
  const [row] = await ctx.unsafe(
    "SELECT upsert_thought('a chunked thought', '{\"metadata\":{}}'::jsonb, NULL::vector) AS r"
  );
  const tid = (row.r as { id: string }).id;
  const vec = `('[' || array_to_string(array_fill(0.5::real, ARRAY[${EMBEDDING_DIM}]), ',') || ']')::vector`;
  await ctx.unsafe(
    `INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding, context)
     VALUES ('${tid}'::uuid, 0, 'first window',  ${vec}, 'Situating blurb.'),
            ('${tid}'::uuid, 1, 'second window', ${vec}, NULL)`
  );

  const mixed = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE, OB1_CHUNK_CONTEXT: "on" });
  assert(mixed.code === 0, "a mixed corpus is a warning, not a refusal — every query still works");
  assert(/1 of 2 chunks carry a situating context and 1 do not/.test(mixed.out),
         "…and it is counted from the rows rather than trusted from ob1_config");

  await ctx.unsafe(`UPDATE thought_chunks SET context = 'Situating blurb.' WHERE context IS NULL`);
  const allCtxOff = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE });
  assert(/all 2 chunks carry a context but OB1_CHUNK_CONTEXT is off/.test(allCtxOff.out),
         "turning it back off with a contextualized corpus warns about the next capture");

  await ctx.unsafe("DELETE FROM thoughts");
  await ctx.close();

  /**
   * An unfinished re-embed pass (SMD-1024). `reembed.ts --switch-model` records
   * the new model in ob1_config before the first row is re-embedded — on
   * purpose, so a server configured for it can be switched while the pass runs
   * — and the embedding-contract check then says "matching" for a pass that
   * died at 5%. The claim table is the record of the pass, so the states are
   * written to it directly, as the tool would leave them: mid-pass (pending,
   * failed and succeeded rows, one with a caveat) warns with the counts in the
   * tool's own words; a capture during the pass is counted as not yet pooled;
   * a finished pass with such a capture is finished — after a switch every new
   * capture is one; a row another process holds is unfinished work; a backfill
   * under another key is reported by its key; a fresh install and a schema
   * before 015 are not warnings.
   */
  const SQL_ENV = { ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE };
  const KEY = `reembed:${EMBEDDING_MODEL}@${EMBEDDING_DIM}`;
  const claims = new SQL({ url: LIVE, max: 1 });

  const fresh = await run(SQL_ENV);
  assert(/embedding contract.*matching/s.test(fresh.out) && /re-embed pass\s+none unfinished/.test(fresh.out),
         "a fresh install — no claim rows — reports no unfinished pass beside a matching contract");

  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const [r] = await claims.unsafe(`SELECT upsert_thought('pass thought ${i}', '{"metadata":{}}'::jsonb, NULL::vector) AS r`);
    ids.push((r.r as { id: string }).id);
  }
  await claims`SELECT enqueue_thoughts(${KEY})`;
  await claims`UPDATE thought_work_claims SET status = 'succeeded', finished_at = now() WHERE work_type = ${KEY} AND thought_id = ${ids[0]}::uuid`;
  await claims`UPDATE thought_work_claims SET status = 'succeeded', finished_at = now(), last_error = 'whole-content embedding refused by the provider (413 stub)' WHERE work_type = ${KEY} AND thought_id = ${ids[1]}::uuid`;
  await claims`UPDATE thought_work_claims SET status = 'failed', finished_at = now(), last_error = 'stub: refused this text' WHERE work_type = ${KEY} AND thought_id = ${ids[2]}::uuid`;

  const mid = await run(SQL_ENV);
  assert(mid.code === 0, "a database mid-pass still starts — a warning, as the model mismatch beside it is");
  assert(/re-embed pass\s+the pass to .* has not finished: 5 thoughts — 2 succeeded \(1 with a caveat\), 1 failed, 0 in flight, 2 pending, 0 not yet in the pool/.test(mid.out),
         "…and warns with the counts, in the words reembed.ts prints under --status");
  assert(/--retry-failed for the 1 failed row/.test(mid.out) && /--status shows where it stands/.test(mid.out),
         "…with the run that finishes it, --retry-failed while a row is failed, and --status as the remedy");
  assert(/--accept-failed <thought-id…> for one the provider refuses permanently/.test(mid.out),
         "…and --accept-failed for a row no retry will change (SMD-1067)");
  assert(/embedding contract.*matching/s.test(mid.out), "…beside a contract line that still says matching, which is true of the record");
  const midJson = await run(SQL_ENV, "--json");
  const midParsed = JSON.parse(midJson.out) as { ok: boolean; checks: { name: string; status: string }[] };
  assert(midParsed.ok === true && midParsed.checks.some((c) => c.name === "re-embed pass" && c.status === "warn"),
         "--json carries the warning for a pipeline, under ok:true");

  await claims.unsafe(`SELECT upsert_thought('captured during the pass', '{"metadata":{}}'::jsonb, NULL::vector)`);
  const during = await run(SQL_ENV);
  assert(/6 thoughts — 2 succeeded \(1 with a caveat\), 1 failed, 0 in flight, 2 pending, 1 not yet in the pool/.test(during.out),
         "a thought captured during the pass is counted as not yet in the pool");

  await claims`UPDATE thought_work_claims SET status = 'succeeded', finished_at = now(), last_error = NULL WHERE work_type = ${KEY} AND status IN ('pending', 'failed')`;
  const finished = await run(SQL_ENV);
  assert(/re-embed pass\s+none unfinished/.test(finished.out) && !/not yet in the pool/.test(finished.out),
         "a finished pass with a thought captured since is finished — after a switch every new capture is such a thought");

  await claims`SELECT enqueue_thoughts(${KEY})`;
  const [{ thought_id: leasedId }] = await claims`SELECT thought_id FROM claim_thoughts(${KEY}, 'preflight-test', 1)`;
  const leased = await run(SQL_ENV);
  assert(/6 thoughts — 5 succeeded \(1 with a caveat\), 0 failed, 1 in flight, 0 pending, 0 not yet in the pool/.test(leased.out),
         "a row another process holds is unfinished work, counted in flight");
  await claims`SELECT release_thought(${leasedId}::uuid, ${KEY}, 'preflight-test', 'succeeded')`;

  const CTX = `${KEY}:ctx`;
  await claims.unsafe(`SELECT enqueue_thoughts('${CTX}', ARRAY['${ids[0]}']::uuid[])`);
  const other = await run(SQL_ENV);
  assert(other.code === 0 && new RegExp(`re-embed pass\\s+${rx(CTX)}: 6 thoughts — 0 succeeded, 0 failed, 0 in flight, 1 pending, 5 not yet in the pool — a pass under this key stopped before it finished`).test(other.out),
         "a backfill under --job that stopped is reported by its key, with its counts");
  assert(other.out.includes(`--job ${CTX}`), "…with the flag that resumes it");
  assert(!/the pass to .* has not finished/.test(other.out), "…while the finished pass to the configured model is not reported");
  assert(!/--switch-model/.test(other.out), "…and, with the record and the configuration agreeing, no --switch-model in the remedy");
  await claims`UPDATE thought_work_claims SET status = 'failed', finished_at = now(), last_error = 'stub: refused this text' WHERE work_type = ${CTX}`;
  const otherFailed = await run(SQL_ENV);
  assert(otherFailed.out.includes(`--job ${CTX} --accept-failed <thought-id…>`),
         "…and with a failed row its acceptance remedy carries the key, so the row is accepted under the pass it belongs to and not the shell's default key");
  await claims`DELETE FROM thought_work_claims WHERE work_type = ${CTX}`;

  /**
   * A switch that was abandoned or reverted. The corpus was moving to "other",
   * the operator went back, and other's key keeps its pending rows for ever.
   * Finishing "that pass" under this shell would write this model's vectors
   * under other's key — reembed.ts refuses the --job — so the remedy is to
   * complete that switch in other's environment or retire its record, never
   * `--job` under the current model (first review pass).
   */
  const OTHER = `reembed:other-model@${EMBEDDING_DIM}`;
  await claims.unsafe(`SELECT enqueue_thoughts('${OTHER}', ARRAY['${ids[0]}']::uuid[])`);
  const superseded = await run(SQL_ENV);
  assert(superseded.code === 0 && new RegExp(`${rx(OTHER)}: 6 thoughts — .* — a pass to other-model @ ${EMBEDDING_DIM}, which is no longer the recorded model \\(${EMBEDDING_MODEL} @ ${EMBEDDING_DIM}\\); its rows describe a switch that was abandoned or reverted`).test(superseded.out),
         "a pass to a model that is no longer the recorded one is described as an abandoned switch");
  assert(/OB1_EMBEDDING_MODEL=other-model OB1_EMBEDDING_DIM=\d+ bun reembed\.ts --url \$DATABASE_URL --switch-model/.test(superseded.out) && superseded.out.includes(`retire its record: cd db && bun reembed.ts --url $DATABASE_URL --retire ${OTHER}`) && !/DELETE FROM/.test(superseded.out),
         "…with the two remedies: finish that switch in its own environment, or retire its record with the tool's own flag — never a hand DELETE (SMD-1067)");
  assert(!superseded.out.includes(`--job ${OTHER}`), "…and never --job under the current model, which reembed.ts would refuse");
  await claims`DELETE FROM thought_work_claims WHERE work_type = ${OTHER}`;

  /**
   * The record disagrees with the configuration — a revert the server has not
   * followed, or a switch the server is ahead of — and the configured model's
   * pass is unfinished: the command preflight prints has to carry
   * --switch-model, or reembed.ts exits 2 on it (first review pass).
   */
  await claims.unsafe(`SELECT enqueue_thoughts('${KEY}', ARRAY['${ids[1]}']::uuid[])`);
  await claims`UPDATE thought_work_claims SET status = 'failed', finished_at = now(), last_error = 'stub: refused this text' WHERE work_type = ${KEY} AND thought_id = ${ids[1]}::uuid`;
  await claims`UPDATE ob1_config SET value = 'other-model' WHERE key = 'embedding_model'`;
  const reverted = await run(SQL_ENV);
  assert(/embedding contract\s+schema was built with other-model, now configured for/.test(reverted.out) && /re-embed pass\s+reembed:/.test(reverted.out),
         "with the record on another model and the configured model's pass unfinished, both lines warn");
  assert(new RegExp(`${rx(KEY)}: 6 thoughts — .* — a pass to ${rx(EMBEDDING_MODEL)} @ ${EMBEDDING_DIM}, which is no longer the recorded model \\(other-model @ ${EMBEDDING_DIM}\\); its rows describe a switch that was abandoned or reverted`).test(reverted.out),
         "…and the configured model's own key, which the record has moved on from, is a superseded key too — the record decides, not this server's environment");
  assert(new RegExp(`Either finish that switch — cd db && OB1_EMBEDDING_MODEL=${rx(EMBEDDING_MODEL)} OB1_EMBEDDING_DIM=${EMBEDDING_DIM} bun reembed\\.ts --url \\$DATABASE_URL --switch-model — or, if the revert stands, retire its record: cd db && bun reembed\\.ts --url \\$DATABASE_URL --retire ${rx(KEY)}`).test(reverted.out) && !/--accept-failed/.test(reverted.out),
         "…with both remedies — finish the switch, or retire the record — and not --accept-failed, which reembed.ts refuses under a model change");
  /**
   * The same disagreement, with an unfinished key preflight cannot read a
   * model from: the command still needs --switch-model, since the shell it
   * runs in is the configured one (second review pass — the first pass's
   * expression for this could never be true).
   */
  await claims.unsafe(`SELECT enqueue_thoughts('reembed:nightly', ARRAY['${ids[0]}']::uuid[])`);
  const nightly = await run(SQL_ENV);
  assert(/reembed:nightly: 6 thoughts — .* — a pass under this key stopped before it finished/.test(nightly.out) && /bun reembed\.ts --url \$DATABASE_URL --job reembed:nightly --switch-model/.test(nightly.out),
         "an unfinished key naming no model, while the record disagrees with the configuration, gets --switch-model too");
  await claims`DELETE FROM thought_work_claims WHERE work_type = 'reembed:nightly'`;
  await claims`UPDATE ob1_config SET value = ${EMBEDDING_MODEL} WHERE key = 'embedding_model'`;
  await claims`UPDATE thought_work_claims SET status = 'succeeded', finished_at = now(), last_error = NULL WHERE work_type = ${KEY} AND status IN ('pending', 'failed')`;

  /**
   * A hand-applied schema can carry the model row without the width row. The
   * width then says nothing, and the configured model's own backfill must be
   * a resumable pass, not "a switch that was abandoned" with a DELETE as its
   * remedy (second review pass: `dim !== Number(undefined)` is always true).
   */
  await claims`DELETE FROM ob1_config WHERE key = 'embedding_dim'`;
  await claims.unsafe(`SELECT enqueue_thoughts('${CTX}', ARRAY['${ids[0]}']::uuid[])`);
  const noDim = await run(SQL_ENV);
  assert(noDim.out.includes(`--job ${CTX}`) && !/abandoned or reverted/.test(noDim.out),
         "with no width recorded, the configured model's backfill is still a pass to resume, not an abandoned switch");
  const wrongDim = await run({ ...SQL_ENV, OB1_EMBEDDING_DIM: String(EMBEDDING_DIM + 1) });
  assert(wrongDim.out.includes(`--job ${CTX}`) && !/where the column and the record are/.test(wrongDim.out),
         "…and a server misconfigured for another width does not make it one nothing can finish: the width judged by is the column's, not this server's");
  await claims`INSERT INTO ob1_config (key, value) VALUES ('embedding_dim', ${String(EMBEDDING_DIM + 1)})`;
  const wrongRecord = await run(SQL_ENV);
  assert(wrongRecord.out.includes(`--job ${CTX}`) && !/where the column and the record are/.test(wrongRecord.out),
         "…nor does a record that disagrees with the column: the column comes first, since a pass runs at its width and no other");
  await claims`DELETE FROM ob1_config WHERE key = 'embedding_dim'`;
  await claims`DELETE FROM thought_work_claims WHERE work_type = ${CTX}`;
  await claims`INSERT INTO ob1_config (key, value) VALUES ('embedding_dim', ${String(EMBEDDING_DIM)})`;

  /**
   * The same model at another width. Migration 006 keeps the recorded width
   * equal to the column's and reembed.ts refuses any other, so "finish that
   * switch" can never run; the only remedy is to retire the record.
   */
  const WIDE = `reembed:${EMBEDDING_MODEL}@${EMBEDDING_DIM + 1}`;
  await claims.unsafe(`SELECT enqueue_thoughts('${WIDE}', ARRAY['${ids[0]}']::uuid[])`);
  const wide = await run(SQL_ENV);
  assert(new RegExp(`${rx(WIDE)}: 6 thoughts — .* — a pass to ${rx(EMBEDDING_MODEL)} at ${EMBEDDING_DIM + 1} dimensions, where the column and the record are ${EMBEDDING_DIM}`).test(wide.out),
         "a key at another width is described as one no run can finish");
  assert(/Nothing can complete it/.test(wide.out) && wide.out.includes(`--retire ${WIDE}`) && !/DELETE FROM/.test(wide.out) && !/--switch-model/.test(wide.out),
         "…with retiring the record as the only remedy, and no --switch-model that reembed.ts would refuse on the width");
  await claims`DELETE FROM thought_work_claims WHERE work_type = ${WIDE}`;

  /**
   * Nothing recorded (006 not applied, or the row deleted) and a stale key at
   * another model: this server's model stands in for the record, as
   * reembed.ts's --retire judges, so the key is an abandoned switch with
   * --retire as a remedy — not "finish it under X", which would have
   * re-embedded the corpus to X against a server configured for M.
   */
  await claims`DELETE FROM ob1_config WHERE key = 'embedding_model'`;
  await claims.unsafe(`SELECT enqueue_thoughts('${OTHER}', ARRAY['${ids[0]}']::uuid[])`);
  const noRecord = await run(SQL_ENV);
  assert(new RegExp(`${rx(OTHER)}: 6 thoughts — .* — a pass to other-model @ ${EMBEDDING_DIM}, which is not this server's model \\(${rx(EMBEDDING_MODEL)}; nothing is recorded\\); its rows describe a switch that was abandoned or reverted`).test(noRecord.out) && noRecord.out.includes(`--retire ${OTHER}`) && !noRecord.out.includes(`--job ${OTHER}`),
         `with nothing recorded, a stale key at another model is an abandoned switch judged against this server's model, with --retire as a remedy and never --job under it (${noRecord.out.split("\n").find((l) => /re-embed pass/.test(l))?.trim()})`);
  await claims`DELETE FROM thought_work_claims WHERE work_type = ${OTHER}`;
  await claims`INSERT INTO ob1_config (key, value) VALUES ('embedding_model', ${EMBEDDING_MODEL})`;

  /**
   * An unfinished consolidation pass, and the review queue (SMD-1294).
   * db/consolidate.ts pools the thoughts WITH entities under
   * consolidate:<model>@p<version>, and its product is migration 029's
   * proposal table. The states are written as the tool would leave them: a
   * pass stopped mid-way warns with the counts (the universe being the thoughts
   * with entities, not every thought) and the command that finishes it under
   * the key's own model; pending proposals ride the line as a count with the
   * command that lists them, and alone they are ok, not a warning — the pass
   * proposes, a reviewer decides. Before 015 or 029 there is nothing to read.
   */
  const CONS = "consolidate:other-judge@p1";
  assert(/consolidate pass\s+none unfinished\s*$/m.test(noRecord.out), "with no consolidation rows and no proposals the check is ok and says so");
  // The pool's universe is thoughts with entities AND a vector; give three a vector for the count.
  await claims.unsafe(`UPDATE thoughts SET embedding = ('[' || array_to_string(array_fill(0.5::real, ARRAY[${EMBEDDING_DIM}]), ',') || ']')::vector WHERE id IN ('${ids[0]}', '${ids[1]}', '${ids[2]}')`);
  await claims`SELECT record_thought_entities(${ids[0]}::uuid, 'extract:stub@p1', ${[{ name: "billing", type: "topic", confidence: 0.9 }]}::jsonb, '[]'::jsonb, NULL, NULL)`;
  await claims`SELECT record_thought_entities(${ids[1]}::uuid, 'extract:stub@p1', ${[{ name: "billing", type: "topic", confidence: 0.9 }]}::jsonb, '[]'::jsonb, NULL, NULL)`;
  await claims`SELECT record_thought_entities(${ids[2]}::uuid, 'extract:stub@p1', ${[{ name: "billing", type: "topic", confidence: 0.9 }]}::jsonb, '[]'::jsonb, NULL, NULL)`;
  // An entity on a thought with no vector: not in the pass's universe (the
  // worker's pool rule, one definition), so the count below stays at three.
  await claims`SELECT record_thought_entities(${ids[3]}::uuid, 'extract:stub@p1', ${[{ name: "billing", type: "topic", confidence: 0.9 }]}::jsonb, '[]'::jsonb, NULL, NULL)`;
  await claims.unsafe(`SELECT enqueue_thoughts('${CONS}', ARRAY['${ids[0]}', '${ids[1]}']::uuid[])`);
  await claims`UPDATE thought_work_claims SET status = 'succeeded', finished_at = now() WHERE work_type = ${CONS} AND thought_id = ${ids[0]}::uuid`;
  await claims`SELECT record_supersession_proposal(${ids[0]}::uuid, ${ids[1]}::uuid, 'newer_supersedes_older', 0.8, 'stub reason', 0.9, ${CONS}, NULL)`;
  const consMid = await run(SQL_ENV);
  assert(consMid.code === 0 && new RegExp(`consolidate pass\\s+${rx(CONS)}: 3 thoughts with entities — 1 succeeded, 0 failed, 0 in flight, 1 pending, 1 not yet in the pool — a consolidation pass under this key stopped before it finished; 1 proposal\\(s\\) pending review — cd db && bun consolidate\\.ts --url \\$DATABASE_URL --list`).test(consMid.out),
         `a consolidation pass stopped mid-way warns with its counts over the thoughts with entities, and the queue (${consMid.out.split("\n").find((l) => /consolidate pass/.test(l))?.trim()})`);
  assert(/Finish it: cd db && OB1_JUDGE_MODEL=other-judge bun consolidate\.ts --url \$DATABASE_URL; OB1_JUDGE_MODEL=other-judge bun consolidate\.ts --url \$DATABASE_URL --status shows where it stands\./.test(consMid.out),
         "…and the remedy runs the worker under the key's own judge model — the judge's knob, so the extractor stays put (SMD-1901) — since another shell would pool under another key");
  assert(!/OB1_METADATA_MODEL=other-judge/.test(consMid.out), "…and not by moving the metadata model");
  const consJson = JSON.parse((await run(SQL_ENV, "--json")).out) as { ok: boolean; checks: { name: string; status: string }[] };
  assert(consJson.ok === true && consJson.checks.some((c) => c.name === "consolidate pass" && c.status === "warn"), "--json carries it as a warning, under ok:true");
  await claims`UPDATE thought_work_claims SET status = 'failed', finished_at = now(), last_error = 'stub: not JSON' WHERE work_type = ${CONS} AND thought_id = ${ids[1]}::uuid`;
  const consFailed = await run(SQL_ENV);
  assert(/consolidate pass\s+[^\n]* 1 succeeded, 1 failed, 0 in flight, 0 pending, 1 not yet in the pool/.test(consFailed.out) && /\(--retry-failed for the 1 failed row\(s\) once their cause is fixed\)/.test(consFailed.out),
         "…with a failed row, --retry-failed in the remedy");
  await claims`UPDATE thought_work_claims SET status = 'succeeded', finished_at = now(), last_error = NULL WHERE work_type = ${CONS}`;
  const consDone = await run(SQL_ENV);
  assert(/consolidate pass\s+none unfinished; 1 proposal\(s\) pending review — cd db && bun consolidate\.ts --url \$DATABASE_URL --list\s*$/m.test(consDone.out) && !/consolidate pass\s+consolidate:/.test(consDone.out),
         "a finished pass with a proposal waiting is ok — the queue is a reviewer's, not a defect — and the thought never pooled is not a signal");
  const consOk = JSON.parse((await run(SQL_ENV, "--json")).out) as { checks: { name: string; status: string }[] };
  assert(consOk.checks.some((c) => c.name === "consolidate pass" && c.status === "ok"), "…and --json says ok for it");
  await claims`DELETE FROM supersession_proposals`;
  await claims`DELETE FROM thought_work_claims WHERE work_type = ${CONS}`;
  await claims`DELETE FROM thought_entities`;
  await claims`SELECT prune_orphan_entities()`;
  await claims.unsafe("UPDATE thoughts SET embedding = NULL");
  await claims.unsafe("DROP TABLE supersession_proposals CASCADE");
  const pre029 = await run(SQL_ENV);
  assert(pre029.code === 0 && /consolidate pass\s+not checked — supersession_proposals does not exist \(migration 029 not applied\)/.test(pre029.out),
         "before migration 029 there is no queue to read, and the check says so rather than warning");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("029") });
  assert(/consolidate pass\s+none unfinished\s*$/m.test((await run(SQL_ENV)).out), "…and 029 applied it is ok again");

  /**
   * The rows say which model they are at (migration 021, SMD-1068). The claim
   * table is a record of passes and vanishes when an operator clears it; the
   * column is a fact about each vector. Every fixture below has an EMPTY claim
   * table for the key, so `re-embed pass` says none unfinished throughout and
   * only the rows can speak: a corpus at two models warns with the counts and
   * the pass as the remedy; one wholly at the recorded model is ok, unlabelled
   * rows as detail; the record disagreeing with the configuration puts
   * --switch-model in the remedy; the column missing under this server fails;
   * and the ten-argument update_thought is checked alone — 018 or 021
   * re-applied by hand beside it, or in its place, fails with the DROP or the
   * migration.
   */
  const noVec = await run(SQL_ENV);
  assert(/vector models\s+no vectors stored yet/.test(noVec.out) && /re-embed pass\s+none unfinished/.test(noVec.out), "with no vectors stored the rows have nothing to say, and say so");
  assert(new RegExp(`edit signature\\s+update_thought\\(uuid,text,jsonb,vector,jsonb,timestamp with time zone,jsonb,text,jsonb,jsonb\\): the form the servers and reembed\\.ts call since migration 046 \\(${rx(UPDATE_THOUGHT_SIGNATURE)}\\), alone`).test(noVec.out),
         "the ten-argument update_thought is the only form");
  const VEC = `('[' || array_to_string(array_fill(0.5::real, ARRAY[${EMBEDDING_DIM}]), ',') || ']')::vector`;
  await claims.unsafe(`UPDATE thoughts SET embedding = ${VEC}, embedding_model = '${EMBEDDING_MODEL}' WHERE id IN ('${ids[0]}', '${ids[1]}')`);
  await claims.unsafe(`UPDATE thoughts SET embedding = ${VEC}, embedding_model = 'other-model' WHERE id = '${ids[2]}'`);
  await claims.unsafe(`UPDATE thoughts SET embedding = ${VEC}, embedding_model = NULL WHERE id = '${ids[3]}'`);
  const twoModels = await run(SQL_ENV);
  assert(twoModels.code === 0 && new RegExp(`vector models\\s+1 vector\\(s\\) at another model \\(other-model: 1\\) beside 2 at ${rx(EMBEDDING_MODEL)}, 1 unlabelled \\(model unknown\\) — searches rank across the two`).test(twoModels.out),
         "rows at two models, with an empty claim table, warn from the rows alone — with the counts by model");
  assert(/re-embed pass\s+none unfinished/.test(twoModels.out), "…while the claim table, empty, still says no pass is unfinished — the state SMD-1068 was filed for");
  assert(new RegExp(`Re-embed them: cd db && bun reembed\\.ts --url \\$DATABASE_URL — the pass takes exactly the rows not at ${rx(EMBEDDING_MODEL)}\\.`).test(twoModels.out) && !/vector models[^\n]*--switch-model/.test(twoModels.out),
         "…with the pass as the remedy, and no --switch-model while the record and the configuration agree");
  const twoJson = JSON.parse((await run(SQL_ENV, "--json")).out) as { ok: boolean; checks: { name: string; status: string }[] };
  assert(twoJson.ok === true && twoJson.checks.some((c) => c.name === "vector models" && c.status === "warn"), "--json carries it as a warning, under ok:true");
  /**
   * The operator accepts the row at the other model (SMD-1067): its row under
   * the recorded model's key becomes a succeeded row with the accepted caveat,
   * as `reembed.ts --accept-failed` writes it, and the vector is detail rather
   * than a warning — the acknowledgement is the operator's word about exactly
   * that vector. A second row at that model, not spoken for, warns, counting
   * only itself; and the acceptance holds only while nothing has written the
   * thought since (021's evidence rule) — an edit makes it a new question.
   */
  await claims`UPDATE thought_work_claims SET status = 'succeeded', finished_at = now(), last_error = ${ACCEPTED_CAVEAT_PREFIX} || 'stub: refused this text' WHERE work_type = ${KEY} AND thought_id = ${ids[2]}::uuid`;
  const acceptedOne = await run(SQL_ENV);
  assert(acceptedOne.code === 0 && new RegExp(`vector models\\s+2 at ${rx(EMBEDDING_MODEL)}, 1 at another model accepted by the operator \\(other-model: 1\\), 1 unlabelled \\(model unknown\\)\\s*$`, "m").test(acceptedOne.out) && !/vector\(s\) at another model/.test(acceptedOne.out),
         "a vector at another model whose thought the operator accepted is detail, not a warning — the acknowledgement SMD-1067 adds");
  assert(/re-embed pass\s+none unfinished/.test(acceptedOne.out), "…and its row, succeeded with the caveat, leaves the pass finished");
  // Every vector at the recorded model gone: a corpus whose only vectors are
  // accepted ones at another model is NOT ok — nothing is at the model the
  // server embeds with (first review pass).
  await claims.unsafe(`UPDATE thoughts SET embedding = NULL WHERE id IN ('${ids[0]}', '${ids[1]}')`);
  const noneAt = await run(SQL_ENV);
  assert(new RegExp(`vector models\\s+no vector is known to be at ${rx(EMBEDDING_MODEL)}: 1 at another model accepted by the operator \\(other-model: 1\\), 1 unlabelled \\(model unknown\\) — nothing is at the model the record names`).test(noneAt.out) && /--retry-fallbacks/.test(noneAt.out),
         "…but with no vector at the recorded model at all, an accepted corpus is a warning, naming the way the accepted rows come back");
  await claims.unsafe(`UPDATE thoughts SET embedding = ${VEC} WHERE id IN ('${ids[0]}', '${ids[1]}')`);
  // The counts line says "accepted" only while the acceptance stands — the
  // same bound the readers apply — so one report gives one account.
  // (The head-window caveat on ids[1] was cleared by the reverted fixture
  // above, so the accepted row is the one caveat here. finished_at is put back
  // as it was: a fresh one would be evidence for 021's backfill below.)
  const [{ fin: pendingFin }] = await claims`SELECT finished_at::text AS fin FROM thought_work_claims WHERE work_type = ${KEY} AND thought_id = ${ids[3]}::uuid`;
  await claims`UPDATE thought_work_claims SET status = 'pending', finished_at = NULL WHERE work_type = ${KEY} AND thought_id = ${ids[3]}::uuid`;
  const pendingOne = await run(SQL_ENV);
  assert(/re-embed pass\s+the pass to .* has not finished: 6 thoughts — 5 succeeded \(1 with a caveat, 1 accepted by the operator\), 0 failed, 0 in flight, 1 pending/.test(pendingOne.out),
         `the pass counts name the accepted row inside the caveat count while its acceptance stands (${pendingOne.out.split("\n").filter((l) => /re-embed pass|vector models|could not/.test(l)).join(" | ").trim()})`);
  await claims.unsafe(`UPDATE thoughts SET embedding = ${VEC}, embedding_model = 'other-model' WHERE id = '${ids[4]}'`);
  const oneMore = await run(SQL_ENV);
  assert(new RegExp(`vector models\\s+1 vector\\(s\\) at another model \\(other-model: 1\\) beside 2 at ${rx(EMBEDDING_MODEL)}, 1 at another model accepted by the operator \\(other-model: 1\\), 1 unlabelled`).test(oneMore.out),
         "a second row at that model, not accepted, warns — counting only the one the operator has not spoken for");
  await claims.unsafe(`UPDATE thoughts SET metadata = metadata || '{"edited":true}'::jsonb WHERE id = '${ids[2]}'`);
  const edited = await run(SQL_ENV);
  assert(/vector models\s+2 vector\(s\) at another model \(other-model: 2\)/.test(edited.out) && !/accepted by the operator/.test(edited.out),
         "…and a thought written since its acceptance is no longer spoken for: the acceptance held while nothing wrote the row");
  assert(/5 succeeded \(1 with a caveat\), 0 failed, 0 in flight, 1 pending/.test(edited.out), `…and the pass counts call it a caveat now, not an acceptance (${edited.out.split("\n").filter((l) => /re-embed pass/.test(l)).join(" | ").trim()})`);
  await claims`UPDATE thought_work_claims SET status = 'succeeded', finished_at = ${pendingFin}::timestamptz WHERE work_type = ${KEY} AND thought_id = ${ids[3]}::uuid`;
  await claims`UPDATE thought_work_claims SET last_error = NULL WHERE work_type = ${KEY} AND thought_id = ${ids[2]}::uuid`;
  await claims.unsafe(`UPDATE thoughts SET embedding = NULL, embedding_model = NULL WHERE id = '${ids[4]}'`);
  await claims.unsafe(`UPDATE thoughts SET embedding_model = '${EMBEDDING_MODEL}' WHERE id = '${ids[2]}'`);
  const atModel = await run(SQL_ENV);
  assert(new RegExp(`vector models\\s+3 at ${rx(EMBEDDING_MODEL)}, 1 unlabelled \\(model unknown\\)\\s*$`, "m").test(atModel.out) && !/at another model/.test(atModel.out),
         "a corpus wholly at the recorded model is ok, the unlabelled row reported as detail rather than as wrong");
  await claims`UPDATE ob1_config SET value = 'other-model' WHERE key = 'embedding_model'`;
  const recordMoved = await run(SQL_ENV);
  assert(new RegExp(`vector models\\s+3 vector\\(s\\) at another model \\(${rx(EMBEDDING_MODEL)}: 3\\) beside 0 at other-model, 1 unlabelled[^\\n]*; the record says other-model and this server embeds with ${rx(EMBEDDING_MODEL)}`).test(recordMoved.out),
         "with the record on another model, the rows at the configured one are the ones out of place against the record");
  assert(/Finish the switch to other-model: cd db && OB1_EMBEDDING_MODEL=other-model bun reembed\.ts --url \$DATABASE_URL, and configure the server for it; or, if .* stands: cd db && bun reembed\.ts --url \$DATABASE_URL --switch-model, which re-embeds the rows at other-model instead\./.test(recordMoved.out),
         "…and the remedy gives both directions rather than a --switch-model from this shell that would revert the switch");
  await claims`UPDATE ob1_config SET value = ${EMBEDDING_MODEL} WHERE key = 'embedding_model'`;
  await claims.unsafe("ALTER TABLE thoughts DROP COLUMN embedding_model");
  const noColumn = await run(SQL_ENV);
  assert(noColumn.code === 1 && /vector models\s+thoughts\.embedding_model does not exist/.test(noColumn.out) && /021_embedding_model_per_row\.sql/.test(noColumn.out),
         "the column missing under this server does not start, naming 021");
  // 021 puts the column back; the pre-022 and pre-025 capture-body warnings
  // are asserted further down, after 018 and then 021 alone. 046 follows here,
  // since 021 re-applied leaves its 8-argument update_thought beside 046's
  // (asserted further down too) and 046 is the file whose DROP chain reaches
  // it — 032's reaches only 8 and 7 and would leave its own 9-argument form
  // beside the shipped one (SMD-1730).
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("021") || f.startsWith("046") || f.startsWith("055") });
  const restored = await run(SQL_ENV);
  assert(restored.code === 0 && new RegExp(`vector models\\s+no vector is known to be at ${rx(EMBEDDING_MODEL)}: 4 unlabelled \\(model unknown\\)`).test(restored.out) && /the pass takes every row nothing vouches for/.test(restored.out),
         `021 re-applied: the column is back, its labels gone — and a corpus with no vector known to be at its model is a warning with the pass as the remedy, not an ok (exit ${restored.code}: ${restored.out.split("\n").filter((l) => /vector models|fail/.test(l)).join(" | ").trim()})`);
  // 021's backfill holds the updated_at trigger off for one statement; a
  // hand run that stopped between DISABLE and ENABLE leaves it off.
  await claims.unsafe("ALTER TABLE thoughts DISABLE TRIGGER thoughts_updated_at");
  const trgOff = await run(SQL_ENV);
  assert(trgOff.code === 1 && /updated_at trigger\s+thoughts_updated_at is disabled/.test(trgOff.out) && /ALTER TABLE thoughts ENABLE TRIGGER thoughts_updated_at;/.test(trgOff.out),
         "the updated_at trigger left disabled does not start, with the one-line remedy");
  await claims.unsafe("ALTER TABLE thoughts ENABLE TRIGGER thoughts_updated_at");
  assert(/updated_at trigger\s+thoughts_updated_at enabled/.test((await run(SQL_ENV)).out), "…and enabled again it is ok");
  // 018 re-applied by hand puts the 7-argument form back BESIDE 032's.
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("018") });
  const twoEdits = await run(SQL_ENV);
  assert(twoEdits.code === 1 && /edit signature\s+beside the form the servers call there is an earlier one: update_thought\(uuid,text,jsonb,vector,jsonb,timestamp with time zone,jsonb\) — an earlier migration re-applied by hand over 046/.test(twoEdits.out),
         "018 re-applied over 046 leaves two update_thought forms, and the start is refused naming the extra one");
  assert(/DROP FUNCTION update_thought\(uuid,text,jsonb,vector,jsonb,timestamp with time zone,jsonb\);/.test(twoEdits.out), "…with the exact DROP as the remedy");
  // 021 re-applied drops the 7-argument form — and puts its own 8-argument
  // one beside 032's, the state SMD-1323's verify names: every caller sending
  // eight arguments or fewer, reembed.ts's positional call among them, is
  // "function is not unique".
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("021") });
  const eightBeside = await run(SQL_ENV);
  assert(eightBeside.code === 1 && /edit signature\s+beside the form the servers call there is an earlier one: update_thought\(uuid,text,jsonb,vector,jsonb,timestamp with time zone,jsonb,text\) — an earlier migration re-applied by hand over 046 — so every call that sends fewer than ten arguments/.test(eightBeside.out),
         "021 re-applied over 046 leaves the 8-argument form beside the 10-argument one, and the start is refused naming it");
  assert(/DROP FUNCTION update_thought\(uuid,text,jsonb,vector,jsonb,timestamp with time zone,jsonb,text\);/.test(eightBeside.out) && !/timestamp with time zone,jsonb\);/.test(eightBeside.out),
         "…with the 8-argument DROP as the remedy, and only that one");
  // 032 re-applied drops 021's form — and puts its own 9-argument one beside
  // 046's 10-argument form (032's DROP reaches 8 and 7): the state a hand
  // re-apply of 032 or 033 leaves since SMD-1730, refused with the one DROP.
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("032") });
  const nineBeside = await run(SQL_ENV);
  assert(nineBeside.code === 1 && /edit signature\s+beside the form the servers call there is an earlier one: update_thought\(uuid,text,jsonb,vector,jsonb,timestamp with time zone,jsonb,text,jsonb\) — an earlier migration re-applied by hand over 046 — so every call that sends fewer than ten arguments/.test(nineBeside.out) && /DROP FUNCTION update_thought\(uuid,text,jsonb,vector,jsonb,timestamp with time zone,jsonb,text,jsonb\);/.test(nineBeside.out),
         "032 re-applied over 046 leaves its 9-argument form beside the 10-argument one, and the start is refused naming it with its DROP");
  await claims.unsafe("DROP FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb)");
  const reapplied021 = await run(SQL_ENV);
  assert(reapplied021.code === 0 && /edit signature\s+update_thought\(uuid,text,jsonb,vector,jsonb,timestamp with time zone,jsonb,text,jsonb,jsonb\): the form the servers and reembed\.ts call since migration 046/.test(reapplied021.out),
         "…which the DROP performs (046 re-applied would too, its chain reaching 9, 8 and 7)");
  // 036 re-applied by hand over 042 puts the two-argument delete_thought back
  // BESIDE 042's three-argument one: every two-argument caller is "not unique".
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("036") });
  const twoDeletes = await run(SQL_ENV);
  assert(twoDeletes.code === 1 && /delete signature\s+beside the form the servers call there is an earlier one: delete_thought\(uuid,jsonb\) — 009 or 036 re-applied by hand over 042/.test(twoDeletes.out) && /DROP FUNCTION delete_thought\(uuid,jsonb\);/.test(twoDeletes.out),
         "036 re-applied over 042 leaves two delete_thought forms, and the start is refused naming the extra one with its DROP");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("042") });
  assert(/delete signature\s+delete_thought\(uuid,jsonb,boolean\): the form the servers call since migration 042, alone/.test((await run(SQL_ENV)).out), "…which 042 re-applied performs");
  // A brain that stopped at 036 — a server deployed ahead of the migration:
  // the two-argument form alone. Every delete the server sends would fail at
  // the first user call, so the start is refused naming 042 instead.
  await claims.unsafe("DROP FUNCTION delete_thought(uuid, jsonb, boolean)");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("036") });
  const preFacet = await run(SQL_ENV);
  assert(preFacet.code === 1 && /delete signature\s+delete_thought\(uuid,jsonb\) is the form from before migration 042; the server sends p_detach, which only 042's form takes — so every delete would fail/.test(preFacet.out),
         "a brain at 036 does not start: every delete the server sends would fail, and the check says so before a user finds out");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("042") });
  // The isolation level every lock-order argument assumes, read from the
  // connection's default: ok at read committed, a warning naming the guarantees
  // at any other, with the ALTER ROLE that puts it back. Set on the role, so a
  // fresh session (preflight's) inherits it; reset after.
  assert(/transaction isolation\s+default_transaction_isolation is read committed/.test((await run(SQL_ENV)).out), "the connection's default isolation is read committed, and the check says which guarantees rest on it");
  await claims.unsafe("ALTER ROLE current_user SET default_transaction_isolation = 'repeatable read'");
  try {
    const rr = await run(SQL_ENV);
    assert(rr.code === 0 && /transaction isolation\s+default_transaction_isolation is repeatable read: the writers' lock order \(018\/033\/036\) and the citation guard \(042\) are argued under read committed/.test(rr.out) && /ALTER ROLE \S+ SET default_transaction_isolation = 'read committed';/.test(rr.out),
           `a role defaulting to repeatable read starts with a warning naming the guarantees that rest on read committed and the ALTER ROLE that restores it (exit ${rr.code})`);
  } finally {
    await claims.unsafe("ALTER ROLE current_user RESET default_transaction_isolation");
  }
  // …and 021's CREATE OR REPLACE put its 3-argument upsert_thought back over
  // 035's: a chunkless re-capture would leave the previous vector's windows
  // again. A warning naming 035 — captures work, search is over-inclusive.
  assert(/atomic capture\s+the 2- and 3-argument upsert_thought present, but the 3-argument body is from before migration 022 \(004, 005, 008 or 021 re-applied by hand without 046 after them\)/.test(reapplied021.out) && /Apply db\/migrations\/046_thought_audit_event_shape\.sql — the last definer; 022's or 025's file alone would leave what the later ones added out\./.test(reapplied021.out) && !/either/.test(reapplied021.out),
         "021 re-applied over 035 leaves 021's 3-argument upsert_thought, and the start warns naming 035 — the last definer, not 022, 025 or 033 — rather than refusing");
  // 022 re-applied by hand over 035: the sentinel is back, the provenance
  // envelope is not — derived_from and supersedes would be dropped silently
  // (SMD-1250). A warning naming 035, told apart from 022's by more than the
  // sentinel.
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("022") });
  const reapplied022 = await run(SQL_ENV);
  assert(reapplied022.code === 0 && /atomic capture\s+the 2- and 3-argument upsert_thought present, and the 3-argument body carries 022's rule, but it is from before migration 025 \(022 re-applied by hand puts it back\)/.test(reapplied022.out) && /Apply db\/migrations\/046_thought_audit_event_shape\.sql\./.test(reapplied022.out),
         "022 re-applied over 035 keeps 022's sentinel and loses 025's envelope, and the start warns naming 035");
  // 025 re-applied by hand over 035 (SMD-1043): 022's sentinel and 025's
  // envelope are back, 033's lock is not — a capture racing an edit of the
  // same text raises again. A warning naming 035, told by 033's own sentinel.
  // 025 re-applied puts 025's trace_provenance over 026's too; 026 follows
  // it here and below, so no later "healthy" run carries the provenance warn.
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("025") || f.startsWith("026") });
  const reapplied025 = await run(SQL_ENV);
  assert(reapplied025.code === 0 && /atomic capture\s+the 2- and 3-argument upsert_thought present, and the 3-argument body carries 022's rule and 025's envelope, but it is from before migration 033 \(migrations 033, 035 and 046 are not yet applied, or 025 was re-applied by hand\): it takes no fingerprint lock/.test(reapplied025.out) && /Apply db\/migrations\/046_thought_audit_event_shape\.sql\./.test(reapplied025.out) && !/either/.test(reapplied025.out),
         "025 re-applied over 046 keeps 022's rule and 025's envelope and loses the lock, and the start warns naming 046 — the cause hedged, since this schema has no ledger to say whether 035 was ever applied — with the 2-argument body, still 046's, not mentioned");
  assert(/!  audit events\s+the columns are there but the audit trigger's body is from before 046 \(025 or an earlier file re-applied by hand\): every write records an unknown kind, no door and no event/.test(reapplied025.out) && /Apply db\/migrations\/046_thought_audit_event_shape\.sql\./.test(reapplied025.out),
         "…and 025 re-applied put 025's audit trigger back over 046's: the event check warns — writes go through, the kind and the event are not recorded — naming 046 (SMD-1730)");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("046") });
  // 046 re-applied over 055 puts 046's audit trigger back: the event shape is
  // whole, the payload is not — a warning naming 055 (SMD-2115); 055
  // re-applied is the shipped body again.
  const pre055 = await run(SQL_ENV);
  assert(/!  audit events\s+046's event shape present and every key classified, but the audit trigger's body is from before 055 \(migration 055 not yet applied, or 046 re-applied by hand\): a capture records no content and an update no key move/.test(pre055.out) && /Apply db\/migrations\/055_capture_event_payload\.sql\./.test(pre055.out),
         "…046 re-applied over 055 puts a trigger back that records no payload: the event check warns beside the census — the kind and the event are recorded, the content is not — naming 055 and both causes (SMD-2115)");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("055") });
  const shippedPair = await run(SQL_ENV);
  assert(/atomic capture\s+the 2- and 3-argument upsert_thought present, both 046's — the 3-argument body carries 022's rule, so a re-capture's windows stay only while the label vouches for them, 025's provenance envelope, the fingerprint lock, so a capture and an edit of one text are serialised, and writes provenance on a first capture only, so no capture can close a supersession loop, and both set the write event beside the actor \(046\); the 2-argument body refuses a non-object payload \(005\) and takes the lock\s*$/m.test(shippedPair.out),
         "…and 046 re-applied is the shipped pair again, said as such");
  assert(/✓  audit events\s+046's event shape present[^\n]*055's payload in every capture event/.test(shippedPair.out), "…and the event shape is whole again with 055's payload: 046 then 055 re-applied put the trigger's body back");
  // 033 re-applied by hand over 035 (SMD-1453): 033's lock and sentinel are
  // back, and with them 025's fill of a NULL pointer on a re-capture and the
  // supersession lock on every capture naming one — 035's sentinel is what
  // says so. A warning naming 035; the 2-argument body, byte-identical
  // between 033 and 035 and so from before 046 — it sets no write event — is
  // said beside it (sixth review pass; before 046 it was not mentioned).
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("033") });
  const reapplied033 = await run(SQL_ENV);
  // 033 defines update_thought too, so its 9-argument form lands beside 046's
  // 10-argument one and the start is refused for that (exit 1, the edit
  // signature naming it); the capture-body verdict is read from the same run.
  assert(reapplied033.code === 1 && /edit signature\s+beside the form the servers call there is an earlier one: update_thought\(uuid,text,jsonb,vector,jsonb,timestamp with time zone,jsonb,text,jsonb\) — an earlier migration re-applied by hand over 046/.test(reapplied033.out),
         "033 re-applied over 046 also puts its 9-argument update_thought beside the shipped one, and the start is refused naming it (SMD-1730)");
  assert(/atomic capture\s+the 2- and 3-argument upsert_thought present, and the 3-argument body carries 022's rule, 025's envelope and the fingerprint lock, but it is from before migration 035 \(migrations 035 and 046 are not yet applied, or 033 was re-applied by hand\): a re-capture naming supersedes fills a NULL pointer without walking the chain, so a dedup can write a two-row loop, and every capture naming supersedes holds the supersession lock through its insert.*; and the 2-argument body is not 046's either — it is from before migration 046 \(migration 046 is not yet applied, or 033 or 035 was re-applied by hand\): it sets no write event beside the actor/.test(reapplied033.out) && /Apply db\/migrations\/046_thought_audit_event_shape\.sql\./.test(reapplied033.out),
         "033 re-applied over 035 puts the fill and the supersession lock back, and the start warns naming 035 — the cause hedged with no ledger — with the 2-argument body, 035's and so without the write event, said beside it");
  // The query-log check reads the same verdict (SMD-1719): a body from before
  // 035 answers no `existed`, so no cite row is ever logged on this brain, and
  // the line says so rather than reporting the log as complete.
  assert(/query log\s+present; .*Cite rows \(a write naming a returned id as its source, SMD-1719\) need migration 035's upsert_thought and will NOT be logged on this brain/.test(reapplied033.out) && /!  query log/.test(reapplied033.out),
         "…and the query-log line warns that cite rows will not be logged under the pre-035 body");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("046") || f.startsWith("055") });
  const shippedAgain = await run(SQL_ENV);
  assert(/atomic capture\s+the 2- and 3-argument upsert_thought present, both 046's/.test(shippedAgain.out), "…and 046 after it is the shipped pair again");
  assert(/✓  query log\s+present; /.test(shippedAgain.out) && !/will NOT be logged/.test(shippedAgain.out), "…and the query-log line is ok again, without the cite warning");
  // 035 re-applied by hand over 046 (sixth review pass): both capture bodies
  // are 035's — locked, no fill, and no write event set beside the actor. The
  // 3-argument body's state is said, and the 2-argument body beside it, both
  // naming 046; every event a capture declares would otherwise be dropped
  // with the pair reported as shipped. update_thought is not 035's to define,
  // so the start is not refused for a 9-argument form.
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("035") });
  const reapplied035 = await run(SQL_ENV);
  assert(reapplied035.code === 0 && /atomic capture\s+the 2- and 3-argument upsert_thought present, and the 3-argument body carries 022's rule, 025's envelope, the fingerprint lock and writes provenance on a first capture only, but it is from before migration 046 \(migration 046 is not yet applied, or 035 was re-applied by hand\): the write event a capture declares — stance, cites, the valid window, trust — is dropped silently, so no audit row carries it.*; and the 2-argument body is not 046's either — it is from before migration 046 \(migration 046 is not yet applied, or 033 or 035 was re-applied by hand\): it sets no write event beside the actor/.test(reapplied035.out) && /Apply db\/migrations\/046_thought_audit_event_shape\.sql\./.test(reapplied035.out),
         "035 re-applied over 046 is a warning naming 046 for both bodies: neither sets the write event, and a capture's declaration would be dropped silently (SMD-1730, sixth review pass)");
  assert(/✓  edit signature/.test(reapplied035.out), "…and the edit signature is untouched by it — 035 defines no update_thought");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("046") || f.startsWith("055") });
  assert(/atomic capture\s+the 2- and 3-argument upsert_thought present, both 046's/.test((await run(SQL_ENV)).out), "…and 046 after it is the shipped pair again");
  // The 2-argument form from before 005 — what the getting-started guide, the
  // fingerprint recipe's Step 2 and upstream's enhanced-thoughts schema all
  // carry — over 035's (SMD-1250): 003 re-applied is that statement. A warning
  // naming 035, the last definer of the 2-argument form as well.
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("003") });
  const reapplied003 = await run(SQL_ENV);
  assert(reapplied003.code === 0 && /atomic capture\s+the 2- and 3-argument upsert_thought present and the 3-argument body is 046's, but the 2-argument body is not 005's — it does not refuse a non-object payload/.test(reapplied003.out) && /Apply db\/migrations\/046_thought_audit_event_shape\.sql — the last definer of the 2-argument form as well\./.test(reapplied003.out),
         "an earlier 2-argument body over 046's is a warning naming 046, the last definer of that form too");
  // Both bodies stale at once — 003's 2-argument and 021's 3-argument: one
  // warning says both, and the remedy is 035, once. 032 follows 021 here so
  // `edit signature` stays ok and only `atomic capture` speaks.
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("021") || f.startsWith("032") });
  const bothStale = await run(SQL_ENV);
  assert(/atomic capture\s+the 2- and 3-argument upsert_thought present, but the 3-argument body is from before migration 022 .*; and it takes no fingerprint lock; and the 2-argument body is not 005's either — it does not refuse a non-object payload/.test(bothStale.out) && /Apply db\/migrations\/046_thought_audit_event_shape\.sql — the last definer; 022's or 025's file alone/.test(bothStale.out) && (bothStale.out.match(/046_thought_audit_event_shape/g) ?? []).length === 1,
         "both bodies stale is one warning naming both, with 046 as the one remedy");
  // 005 re-applied alone: a pre-022 3-argument body, and the 2-argument body
  // 005's — the guard back, no lock. The warning says which of the two stale
  // states the 2-argument body is in.
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("005") });
  const fiveAlone = await run(SQL_ENV);
  assert(/atomic capture\s+the 2- and 3-argument upsert_thought present, but the 3-argument body is from before migration 022 .*; and the 2-argument body is not 046's either — it is from before migration 033 \(migrations 033, 035 and 046 are not yet applied, or 005 was re-applied by hand\): it takes no fingerprint lock/.test(fiveAlone.out) && /Apply db\/migrations\/046_thought_audit_event_shape\.sql — the last definer/.test(fiveAlone.out),
         "…and 005 re-applied alone leaves a pre-022 3-argument body and a 2-argument body with the guard and no lock, said as such");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("046") || f.startsWith("055") });
  assert(/atomic capture\s+the 2- and 3-argument upsert_thought present, both 046's/.test((await run(SQL_ENV)).out), "…and 046 after it is the shipped pair again");
  // The 3-argument form gone from a 035 database: the remedy is the last
  // definer, not 004, 022 or 025 — whose bodies would drop 005's guard, 008's
  // actor, 021's label, 022's rule, 025's envelope, 033's lock and 035's rule, or the
  // last of those.
  await claims.unsafe("DROP FUNCTION upsert_thought(text, jsonb, vector)");
  const noThree = await run(SQL_ENV);
  assert(noThree.code === 1 && /atomic capture\s+2 upsert_thought overload\(s\) — the 3-argument form, the atomic capture, is missing/.test(noThree.out) && /Apply db\/migrations\/046_thought_audit_event_shape\.sql — the last definer of both forms/.test(noThree.out) && !/Apply db\/migrations\/00[24]_/.test(noThree.out) && !/Apply db\/migrations\/02[25]_/.test(noThree.out),
         "the 3-argument form missing is a refusal whose remedy is 046, the last definer — not 004, 022 or 025");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("046") || f.startsWith("055") });
  assert((await run(SQL_ENV)).code === 0, "…which 046 re-applied performs");
  // A database whose update_thought predates 032: 018's form alone, then
  // 021's alone — each named by its signature, 032 the remedy.
  await claims.unsafe(`DROP FUNCTION ${UPDATE_THOUGHT_SIGNATURE}`);
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("018") });
  const pre021 = await run(SQL_ENV);
  assert(pre021.code === 1 && /edit signature\s+update_thought\(uuid,text,jsonb,vector,jsonb,timestamp with time zone,jsonb\) is the form from before migration 032; the server sends p_provenance/.test(pre021.out) && /Apply db\/migrations\/046_thought_audit_event_shape\.sql\. Its DROP chain reaches every older form/.test(pre021.out),
         "a 018-era update_thought under this server does not start, and is named by its signature with 046 — whose DROP chain reaches every older form — as the remedy");
  // The ledger recording 046 makes the remedy the re-run — and the re-run
  // still says what 046's DROP chain drops, as the apply text does (cold
  // read, fourth review pass: the sentence rode the apply text alone, and a
  // ledgered brain with stale forms was not told what re-applying does).
  const led046 = new SQL({ url: LIVE, max: 1 });
  await led046.unsafe(`CREATE TABLE schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  await led046.unsafe(`INSERT INTO schema_migrations (name, sha256) VALUES ('046_thought_audit_event_shape.sql', 'test')`);
  const ledgered = await run(SQL_ENV);
  await led046.unsafe(`DROP TABLE schema_migrations`);
  await led046.close();
  // The remedy prints on the line after the finding, so the whole output is read, as the arms above read it.
  assert(ledgered.code === 1 && /edit signature\s+update_thought\(uuid,text,jsonb,vector,jsonb,timestamp with time zone,jsonb\) is the form from before migration 032/.test(ledgered.out) && /re-apply the recorded migrations with the migrator/.test(ledgered.out) && /Re-applied, 046's DROP chain reaches every older form and leaves the one the servers call\./.test(ledgered.out) && !/Apply db\/migrations\/046/.test(ledgered.out),
         `with 046 recorded in the ledger the edit-signature remedy is the re-run alone, and it says what 046's DROP chain drops (exit ${ledgered.code}: ${ledgered.out.split("\n").filter((l) => /edit signature|re-apply the recorded|DROP chain/.test(l)).join(" | ").trim().slice(0, 400)})`);
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("021") });
  const pre032 = await run(SQL_ENV);
  assert(pre032.code === 1 && /edit signature\s+update_thought\(uuid,text,jsonb,vector,jsonb,timestamp with time zone,jsonb,text\) is the form from before migration 032; the server sends p_provenance, which only 032's form and its successors take — so every edit would fail, and db\/reembed\.ts refuses to run/.test(pre032.out) && /Apply db\/migrations\/046_thought_audit_event_shape\.sql\. Its DROP chain reaches every older form/.test(pre032.out),
         "…and a 021-era one — a brain at 031 — likewise, with 046 as the remedy");
  // 032 re-applied on that brain leaves its 9-argument form ALONE — a brain at
  // 044 under this server: every edit resolves, a warning naming what is lost
  // and 046. Then 021 re-applied beside it: two older forms and none the
  // servers call — the remedy is 046, whose DROP chain reaches both, not 032,
  // which would leave its own 9 to be named on the next start (second review
  // pass).
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("032") });
  const nineAlone = await run(SQL_ENV);
  assert(nineAlone.code === 0 && /!  edit signature\s+update_thought\(uuid,text,jsonb,vector,jsonb,timestamp with time zone,jsonb,text,jsonb\) is the form from before migration 046: every edit resolves, but no write event \(p_event — stance, cites, the valid window, trust\) reaches the audit row, and db\/reembed\.ts, which resolves the body by/.test(nineAlone.out) && /Apply db\/migrations\/046_thought_audit_event_shape\.sql\./.test(nineAlone.out),
         `a 9-argument form alone — a brain at 044 — is a warning naming 046, not a refusal (exit ${nineAlone.code})`);
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("021") });
  const eightAndNine = await run(SQL_ENV);
  const editLine = eightAndNine.out.split("\n").find((l) => /edit signature/.test(l)) ?? "";
  assert(eightAndNine.code === 1 && /^✗  edit signature/.test(editLine.trim()) && /update_thought\(uuid,text,jsonb,vector,jsonb,timestamp with time zone,jsonb,text\)/.test(editLine) && /update_thought\(uuid,text,jsonb,vector,jsonb,timestamp with time zone,jsonb,text,jsonb\)/.test(editLine) && / are forms from before migration 046 with none the servers call/.test(editLine) && /Apply db\/migrations\/046_thought_audit_event_shape\.sql\. Its DROP chain reaches the 9-, 8- and 7-argument forms/.test(eightAndNine.out) && !/032_update_thought_provenance/.test(eightAndNine.out),
         `the 8- and 9-argument forms with no 10 are refused with 046 as the one remedy, not 032 (exit ${eightAndNine.code})`);
  // 021 put the column back; 046 puts the shipped bodies back over 021's
  // (022, 025, 033 or 035 alone would leave the later ones' out, warnings
  // above) — 032 and 033 first, so the 9-argument update_thought 046 drops is
  // there to drop, the ACL crossing as it did at the upgrade.
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("026") || f.startsWith("032") || f.startsWith("033") || f.startsWith("046") || f.startsWith("055") });
  const restoredAll = await run(SQL_ENV);
  assert(/provenance\s+trace_provenance and find_derivatives present; trace_provenance's body is 026's, the walk bounded/.test(restoredAll.out),
         "…and trace_provenance is 026's again: every 025 re-applied above was followed by 026, so no later healthy run carries the provenance warn");
  // The census (SMD-1730): a key the registry knows and nobody has classified
  // is a warning naming it, with set_agent_kind and the backfill as the
  // remedy; classified, the check is ok again. A brain before 046 had no kind
  // to be missing, which is why the arm is a WARN and not a FAIL.
  await claims.unsafe(`SELECT resolve_agent(repeat('d', 64), 'unclassified-key', 'write')`);
  const unclassified = await run(SQL_ENV);
  assert(unclassified.code === 0 && /!  audit events\s+1 key\(s\) with no kind \(unclassified-key\) and 0 audit row\(s\) naming a key with no kind — every write through an unclassified key is recorded with actor_kind and trust unknown/.test(unclassified.out) && /SELECT set_agent_kind\('<label>', '<operator \| agent \| ingested>'\); then, as the owner \(the pass amends thought_audit and locks ob1_agents\), SELECT backfill_thought_audit_events\(\);/.test(unclassified.out),
         "a resolved key nobody has classified is a warning naming it, with set_agent_kind and the backfill as the remedy (SMD-1730)");
  await claims.unsafe(`SELECT set_agent_kind('unclassified-key', 'agent')`);
  assert(/✓  audit events\s+046's event shape present/.test((await run(SQL_ENV)).out), "…and classified, the check is ok again");
  // A key retired through revoke_agent_key (010) can never write again: its
  // missing kind is not a warning to carry on every start (third review pass).
  await claims.unsafe(`SELECT resolve_agent(repeat('e', 64), 'retired-key', 'write'); SELECT revoke_agent_key(repeat('e', 64), 'left the team')`);
  assert(/✓  audit events\s+046's event shape present/.test((await run(SQL_ENV)).out), "…and an unclassified key whose every digest is revoked is not counted: it cannot write");
  // Rows waiting on the backfill alone — every key they name classified: the
  // remedy is the backfill call, with no key to classify (run-it, third pass).
  // (The planted row carries a content since 055 — this arm is about the
  // kind; the payload census has its own arm below.)
  await claims.unsafe(`INSERT INTO thought_audit (thought_id, action, actor_name, diff) VALUES (gen_random_uuid(), 'capture', 'unclassified-key', '{"content": "planted", "metadata": {}}'::jsonb)`);
  const fillOnly = await run(SQL_ENV);
  assert(/!  audit events\s+0 key\(s\) with no kind and 1 audit row\(s\) naming a key with no kind, 1 of them naming a key classified since — waiting only on the backfill/.test(fillOnly.out) && /SELECT backfill_thought_audit_events\(\); fills them — every key they name is classified/.test(fillOnly.out) && !/For each name/.test(fillOnly.out),
         "rows waiting on the backfill alone get the backfill as the remedy, with no key to classify");
  await claims.unsafe(`SELECT backfill_thought_audit_events()`);
  assert(/✓  audit events\s+046's event shape present/.test((await run(SQL_ENV)).out), "…which fills them");
  // 055's payload census (SMD-2115): a capture row without content whose
  // thought stands is waiting on the payload backfill — a warning with the
  // pass as the remedy; one whose thought is gone without a tombstone has
  // nothing to derive from and is named in the ok line, not carried as a
  // warning on every start; the pass fills the first and reports the second.
  // Planted with no actor (the kind census counts rows naming a key), after
  // the thought's own capture (a capture that re-took the id later would
  // leave the earlier one nothing to derive from).
  const [{ id: payloadThought }] = (await claims`SELECT id FROM thoughts ORDER BY created_at LIMIT 1`) as { id: string }[];
  // The first names a classified key with no kind on the row — waiting on the
  // kind backfill AND the payload — so the line carries both findings and
  // both remedies (cold read, first review pass: the first draft dropped the
  // payload clause from the message and spliced "Then As the owner").
  await claims`INSERT INTO thought_audit (thought_id, action, actor_name, diff) VALUES (${payloadThought}::uuid, 'capture', 'unclassified-key', '{"metadata": {}}'::jsonb)`;
  await claims.unsafe(`INSERT INTO thought_audit (thought_id, action, diff) VALUES (gen_random_uuid(), 'capture', '{"metadata": {}}'::jsonb)`);
  const both = await run(SQL_ENV);
  assert(both.code === 0 && /!  audit events\s+0 key\(s\) with no kind and 1 audit row\(s\) naming a key with no kind, 1 of them naming a key classified since — waiting only on the backfill — every write through an unclassified key is recorded with actor_kind and trust unknown, which every read built on them will say; and 2 capture event\(s\) carry no content \(written before migration 055, or under a re-applied 046\), 1 of them with nothing to derive from — the thought gone without a tombstone — 1 of them the payload backfill fills/.test(both.out)
         && /SELECT backfill_thought_audit_events\(\); fills them — every key they name is classified \(db\/README\.md\)\. Then, as the owner \(the pass amends thought_audit\), SELECT backfill_thought_payloads\(\);/.test(both.out),
         "a row waiting on the kind backfill beside capture rows waiting on the payload: one line naming both, the two remedies in order (SMD-2115)");
  await claims.unsafe(`SELECT backfill_thought_audit_events()`);
  const payloadWaiting = await run(SQL_ENV);
  assert(payloadWaiting.code === 0 && /!  audit events\s+046's event shape present and every key classified, but 2 capture event\(s\) carry no content \(written before migration 055, or under a re-applied 046\), 1 of them with nothing to derive from — the thought gone without a tombstone — 1 of them the payload backfill fills; the log alone cannot rebuild those thoughts until it runs/.test(payloadWaiting.out) && /SELECT backfill_thought_payloads\(\);/.test(payloadWaiting.out),
         "two capture rows without content: a warning counting both, saying which the pass fills and which nothing derives for, with the pass as the remedy (SMD-2115)");
  const [{ r: payloadPass }] = (await claims`SELECT backfill_thought_payloads() AS r`) as { r: { rows: number; from_row: number; unrecoverable: number; awaiting: number } }[];
  assert(payloadPass.rows === 1 && payloadPass.from_row === 1 && payloadPass.unrecoverable === 1 && payloadPass.awaiting === 1, `the pass fills the row whose thought stands (from the live row) and reports the other as unrecoverable (${JSON.stringify(payloadPass)})`);
  const payloadAfter = await run(SQL_ENV);
  assert(/✓  audit events\s+046's event shape present[^\n]*055's payload in every capture event that has one — 1 with nothing to derive it from \(the thought gone without a tombstone; the fold names them\)/.test(payloadAfter.out),
         "…after which the check is ok, naming the one row nothing derives for rather than warning on every start");
  // A column dropped from under 046's trigger is fatal — the trigger INSERTs
  // into it, so every write would fail; the same missing column on a brain
  // whose trigger is 025's is the ordinary state before 046 — writes go
  // through — and a warning naming 046 (first review pass: the first draft
  // called both a failure).
  await claims.unsafe("ALTER TABLE thought_audit DROP COLUMN backfilled_at");
  const droppedCol = await run(SQL_ENV);
  assert(droppedCol.code === 1 && /✗  audit events\s+thought_audit lacks 1 of 046's eight columns \(backfilled_at\) while the audit trigger is 046's, which writes them — every capture, edit and delete would fail in the trigger/.test(droppedCol.out) && /Apply db\/migrations\/046_thought_audit_event_shape\.sql\./.test(droppedCol.out),
         "a 046 column dropped from under 046's trigger does not start, naming the column and 046 (SMD-1730)");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("025") || f.startsWith("026") });
  const pre046 = await run(SQL_ENV);
  assert(pre046.code === 0 && /!  audit events\s+thought_audit lacks 1 of 046's eight columns \(backfilled_at\) — the brain predates migration 046: writes go through, and every row records no kind, trust, door or event until it is applied/.test(pre046.out) && /Apply db\/migrations\/046_thought_audit_event_shape\.sql\./.test(pre046.out),
         "…while the same column missing under 025's trigger — a brain before 046 — is a warning that writes go through, naming 046");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("046") || f.startsWith("055") });
  assert(/✓  audit events\s+046's event shape present/.test((await run(SQL_ENV)).out), "…and 046 then 055 re-applied put the column and the trigger back (055's body over 046's — SMD-2115)");
  await claims.unsafe("UPDATE thoughts SET embedding = NULL");

  await claims.unsafe("DROP TABLE thought_work_claims");
  const pre015 = await run(SQL_ENV);
  assert(pre015.code === 0 && /re-embed pass\s+not checked — thought_work_claims does not exist/.test(pre015.out),
         "before migration 015 there is nothing to read, and the check says so rather than warning");
  assert(/work claims\s+claim_thoughts, release_thought, release_claims_for_worker and renew_claims present/.test(pre015.out),
         "…while the claim functions, which outlive the table, still read as 015's");
  assert(/consolidate pass\s+not checked — thought_work_claims does not exist/.test(pre015.out),
         "…and the consolidate pass check, which reads the same table, says so too");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("015") });

  // The capture path's SECURITY INVOKER writers run as the calling role. A role
  // that can read everything and write thoughts, but cannot INSERT/DELETE
  // thought_chunks or INSERT thought_audit, fails every windowed capture and the
  // audit trigger on every capture — so preflight refuses it, naming each
  // missing privilege with its GRANT. `migrate.ts --grant` then issues the whole
  // documented set (db/config.mjs's ROLE_GRANTS, the one spelling); granted, the
  // role starts and a real windowed capture and an edit through it succeed. A
  // full apply first, so upsert_thought is the shipped 4-argument form whatever
  // state the reapply blocks above left. A role is cluster-wide and dropSchema
  // does not touch it, so an interrupted run's leftover is dropped first and the
  // fixture cleans up whatever happens inside it.
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL });
  const CAPTURE_URL = LIVE.replace(/\/\/[^@]*@/, "//ob1_pf_capture:ob1pf@");
  const vecOf = (seed: number) => `[${Array.from({ length: EMBEDDING_DIM }, (_, i) => (i === 0 ? seed : 0)).join(",")}]`;
  const dropCaptureRole = () => claims.unsafe(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob1_pf_capture') THEN
      EXECUTE 'DROP OWNED BY ob1_pf_capture'; EXECUTE 'DROP ROLE ob1_pf_capture';
    END IF; END $$`);
  const [{ mayCreate }] = await claims`SELECT (rolsuper OR rolcreaterole) AS "mayCreate" FROM pg_roles WHERE rolname = current_user`;
  if (CAPTURE_URL === LIVE) {
    skipRaw("a capturing role missing the write privileges does not start", "DATABASE_URL carries no credentials to swap for the role's");
  } else if (!mayCreate) {
    skipRaw("a capturing role missing the write privileges does not start", "the connection's role cannot CREATE ROLE");
  } else {
    await dropCaptureRole();
    try {
      await claims.unsafe("CREATE ROLE ob1_pf_capture LOGIN PASSWORD 'ob1pf'");
      await claims.unsafe("GRANT USAGE ON SCHEMA public TO ob1_pf_capture");
      await claims.unsafe("GRANT SELECT ON ALL TABLES IN SCHEMA public TO ob1_pf_capture");
      await claims.unsafe("GRANT INSERT, UPDATE, DELETE ON thoughts TO ob1_pf_capture");

      // thoughts satisfied, but no INSERT/DELETE on thought_chunks, no INSERT
      // on thought_audit and no UPDATE on thought_facets (042's delete guard
      // writes the detached citations as the caller): refused, the three
      // tables named in CAPTURE_WRITES order, each with its GRANT.
      const missingBoth = await run({ ...SQL_ENV, DATABASE_URL: CAPTURE_URL });
      const writeLine = (out: string) => out.split("\n").find((l) => /write privileges/.test(l)) ?? "";
      assert(missingBoth.code === 1 &&
             /write privileges\s+this connection's role \(ob1_pf_capture\) is missing privileges the capture path's writers need/.test(missingBoth.out) &&
             /INSERT, DELETE on thought_chunks; INSERT on thought_audit; UPDATE on thought_facets/.test(writeLine(missingBoth.out)) &&
             /GRANT INSERT, DELETE ON thought_chunks TO ob1_pf_capture;\s+GRANT INSERT ON thought_audit TO ob1_pf_capture;\s+GRANT UPDATE ON thought_facets TO ob1_pf_capture;/.test(missingBoth.out),
             `a role missing the chunk, audit and facet writes does not start, each named in order with its GRANT (exit ${missingBoth.code})`);
      assert(/a windowed capture, an edit with content, or 008's audit trigger, and every delete of a thought \(042's citation guard reads and writes thought_facets as the caller\) would fail/.test(writeLine(missingBoth.out)),
             "…and says what each missing privilege breaks: the capture path for the chunk and audit writes, every delete for the facet one");
      assert(/atomic capture\s+the 2- and 3-argument upsert_thought present, both 046's/.test(missingBoth.out), "…while atomic capture, a separate fact, is ok for it");

      // Grant the chunk writes by hand; the audit INSERT and the facet UPDATE remain named.
      await claims.unsafe("GRANT INSERT, DELETE ON thought_chunks TO ob1_pf_capture");
      const missingAudit = await run({ ...SQL_ENV, DATABASE_URL: CAPTURE_URL });
      assert(missingAudit.code === 1 &&
             /INSERT on thought_audit; UPDATE on thought_facets/.test(writeLine(missingAudit.out)) &&
             !/thought_chunks/.test(writeLine(missingAudit.out)) &&
             /GRANT INSERT ON thought_audit TO ob1_pf_capture;\s+GRANT UPDATE ON thought_facets TO ob1_pf_capture;/.test(missingAudit.out),
             `with the chunk writes granted, the audit INSERT and the facet UPDATE are named, the chunks no longer (exit ${missingAudit.code})`);
      // Grant the audit INSERT alone: only the facet UPDATE remains, and the
      // sentence names only deletes — a capture would succeed, and says so.
      await claims.unsafe("GRANT INSERT ON thought_audit TO ob1_pf_capture");
      const facetOnly = await run({ ...SQL_ENV, DATABASE_URL: CAPTURE_URL });
      assert(facetOnly.code === 1 && /UPDATE on thought_facets — so every delete of a thought \(042's citation guard reads and writes thought_facets as the caller\) would fail/.test(writeLine(facetOnly.out)) && !/windowed capture/.test(writeLine(facetOnly.out)),
             `with only the facet UPDATE missing, the check names deletes and not captures as what would fail (exit ${facetOnly.code})`);

      // Grant the facet UPDATE by hand so the base capture set is satisfied —
      // the extraction conditional is the remaining lever.
      await claims.unsafe("GRANT UPDATE ON thought_facets TO ob1_pf_capture");
      const baseOk = await run({ ...SQL_ENV, DATABASE_URL: CAPTURE_URL });
      assert(baseOk.code === 0 && /write privileges\s+ob1_pf_capture holds the capture path's privileges/.test(baseOk.out) && !/thought_work_claims/.test(writeLine(baseOk.out)),
             `with the audit INSERT granted and extraction off, the base capture set is ok and says nothing of thought_work_claims (exit ${baseOk.code})`);

      // 016's trigger reads ob1_config as the caller on EVERY capture (before it
      // checks the key), so with the trigger present — the schema is fully
      // migrated — SELECT on ob1_config is a hard capture-path requirement even
      // with extraction off. Revoke it and preflight refuses, naming the trigger;
      // then restore it (the role's SELECT-on-all otherwise held it).
      await claims.unsafe("REVOKE SELECT ON ob1_config FROM ob1_pf_capture");
      const noConfig = await run({ ...SQL_ENV, DATABASE_URL: CAPTURE_URL });
      assert(noConfig.code === 1 &&
             /SELECT on ob1_config/.test(writeLine(noConfig.out)) &&
             /016's enqueue trigger/.test(writeLine(noConfig.out)) &&
             /GRANT SELECT ON ob1_config TO ob1_pf_capture;/.test(noConfig.out),
             `with 016's trigger present, a role lacking SELECT on ob1_config is refused, the trigger named (exit ${noConfig.code})`);
      await claims.unsafe("GRANT SELECT ON ob1_config TO ob1_pf_capture");

      // 046's audit trigger reads the key's kind from ob1_agents as the caller
      // on every write that carries an actor, so SELECT there is a hard
      // capture-path requirement since SMD-1730 (first review pass: it sat only
      // in the soft `server` group, and a role granted exactly the capture set
      // passed preflight and failed every write in the trigger). Revoke it: a
      // real capture as the role fails in the trigger, and preflight refuses
      // naming the table and the trigger; then restore it.
      await claims.unsafe("REVOKE SELECT ON ob1_agents FROM ob1_pf_capture");
      const asCapturer = new SQL({ url: CAPTURE_URL, max: 1 });
      let deniedInTrigger = "";
      try { await asCapturer`SELECT upsert_thought('preflight: a capture without SELECT on ob1_agents', ${{ metadata: {}, actor: { name: "laptop" } }}::jsonb)`; }
      catch (e) { deniedInTrigger = (e as Error).message; }
      finally { await asCapturer.close(); }
      assert(/permission denied for table ob1_agents/.test(deniedInTrigger), `a capture as a role without SELECT on ob1_agents fails inside 046's audit trigger (${deniedInTrigger.slice(0, 80)})`);
      // …while a raw write with NO actor set does not touch the registry at all
      // (third review pass): the trigger probes it only when an envelope names
      // an id or a name, so the sentence "on every write that carries an
      // actor" is what the code does.
      const asCapturerRaw = new SQL({ url: CAPTURE_URL, max: 1 });
      let rawNoActor = "";
      try { await asCapturerRaw`INSERT INTO thoughts (content, metadata) VALUES ('preflight: a raw write with no actor set', '{}'::jsonb)`; }
      catch (e) { rawNoActor = (e as Error).message; }
      finally { await asCapturerRaw.close(); }
      assert(rawNoActor === "", `…and a raw INSERT with no actor set succeeds for the same role: the trigger reads the registry only for a write that carries an actor (${rawNoActor.slice(0, 80)})`);
      const noAgents = await run({ ...SQL_ENV, DATABASE_URL: CAPTURE_URL });
      assert(noAgents.code === 1 &&
             /SELECT on ob1_agents/.test(writeLine(noAgents.out)) &&
             /046's audit trigger reads ob1_agents as the caller on every capture, edit and delete that carries an actor/.test(writeLine(noAgents.out)) &&
             /GRANT SELECT ON ob1_agents TO ob1_pf_capture;/.test(noAgents.out),
             `a role lacking SELECT on ob1_agents is refused, the trigger named (exit ${noAgents.code})`);
      // The census skip names the table the denial was on — here ob1_agents,
      // the capture group's row since 046, not thought_audit (run-it, third pass).
      assert(/·  audit events\s+not checked — this role cannot read the census \(permission denied for table ob1_agents\)/.test(noAgents.out) && /GRANT SELECT ON ob1_agents TO <the connector's role>; — the capture group's row since 046/.test(noAgents.out),
             "…and the census skip names ob1_agents as the table to grant, not thought_audit");
      // The requirement follows the trigger body that reads the table (second
      // review pass): with 025's audit trigger in place — a brain still at 044
      // under this server — the role lacking SELECT on ob1_agents holds the
      // capture set and is not refused for it; 046's body back, it is.
      await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("025") || f.startsWith("026") });
      const pre046Agents = await run({ ...SQL_ENV, DATABASE_URL: CAPTURE_URL });
      assert(/write privileges\s+ob1_pf_capture holds the capture path's privileges/.test(pre046Agents.out) && !/ob1_agents/.test(writeLine(pre046Agents.out)),
             `under 025's audit trigger the same role holds the capture set — SELECT on ob1_agents is required only while the body that reads it is installed (exit ${pre046Agents.code})`);
      await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("046") || f.startsWith("055") });
      // 046 re-applied requires the SELECT again, and grants it to nobody: the
      // grant is the operator's, by the convention every privilege has landed
      // under — a ROLE_GRANTS row, this check naming what is missing, --grant
      // (ninth review pass cut an in-file grant after three passes of edges).
      assert(/SELECT on ob1_agents/.test(writeLine((await run({ ...SQL_ENV, DATABASE_URL: CAPTURE_URL })).out)), "…and 046's body back, it is required again — and named, not granted, by the apply");
      await claims.unsafe("GRANT SELECT ON ob1_agents TO ob1_pf_capture");
      // The census SELECTs the log; the hard capture set grants INSERT only. A
      // role granted exactly that set is told the census was not checked, and
      // where the SELECT is — not warned about its brain (run-it, second review
      // pass); the role's SELECT-on-all otherwise held it.
      await claims.unsafe("REVOKE SELECT ON thought_audit FROM ob1_pf_capture");
      const noCensus = await run({ ...SQL_ENV, DATABASE_URL: CAPTURE_URL });
      assert(noCensus.code === 0 && /·  audit events\s+not checked — this role cannot read the census \(permission denied for table thought_audit\); the shape is checked, the waiting keys are not/.test(noCensus.out) && /GRANT SELECT ON thought_audit TO <the connector's role>; — the community group's row/.test(noCensus.out),
             `a role that cannot read thought_audit is told the census was skipped, with the community group's GRANT (exit ${noCensus.code})`);
      await claims.unsafe("GRANT SELECT ON thought_audit TO ob1_pf_capture");

      // Enable entity extraction: 016's trigger now upserts a work claim as the
      // caller on every capture, so the capture path needs thought_work_claims
      // INSERT/UPDATE — which this role (SELECT-everywhere, no worker DML) lacks.
      // Preflight refuses it, naming them with the trigger as the reason.
      await claims.unsafe("INSERT INTO ob1_config (key, value) VALUES ('entity_extraction_key', 'extract:test') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
      const extractOn = await run({ ...SQL_ENV, DATABASE_URL: CAPTURE_URL });
      assert(extractOn.code === 1 &&
             /INSERT, UPDATE on thought_work_claims/.test(writeLine(extractOn.out)) &&
             /016's enqueue trigger/.test(writeLine(extractOn.out)) &&
             /GRANT INSERT, UPDATE ON thought_work_claims TO ob1_pf_capture;/.test(extractOn.out),
             `with entity extraction enabled, a role lacking the work-claim writes is refused, the trigger named (exit ${extractOn.code})`);

      // The executable spelling: migrate.ts --grant issues the whole documented
      // set — the server, worker and extraction groups too, quoted role — so the
      // role holds everything the writers need and preflight is ok.
      const grant = await migrate(["--grant", "ob1_pf_capture", "--url", LIVE]);
      // thought_audit's GRANT merges the capture group's INSERT with the
      // community group's SELECT (SMD-1796): 008's table is present on every
      // migrated brain, so that row is issued whether or not the community
      // schema that names it was applied.
      assert(grant.code === 0 &&
             /GRANT SELECT, INSERT ON thought_audit TO "ob1_pf_capture";/.test(grant.out) &&
             /GRANT SELECT, INSERT, UPDATE, DELETE ON thought_work_claims TO "ob1_pf_capture";/.test(grant.out),
             `migrate.ts --grant issues the documented set (exit ${grant.code}: ${grant.out.trim().split("\n").find((l) => /Granted/.test(l)) ?? grant.out.trim().split("\n").slice(-1)[0]})`);
      assert(/GRANT INSERT ON query_log TO "ob1_pf_capture";/.test(grant.out),
             "…including the opt-in query log's INSERT (querylog group, SMD-1295)");
      const okRun = await run({ ...SQL_ENV, DATABASE_URL: CAPTURE_URL });
      assert(okRun.code === 0 && /write privileges\s+ob1_pf_capture holds the capture path's privileges/.test(okRun.out) && /entity extraction is enabled/.test(writeLine(okRun.out)),
             `…and granted, the role starts, the ok noting extraction is on (exit ${okRun.code}: ${okRun.out.split("\n").filter((l) => /fail/.test(l)).join(" | ").trim()})`);
      // The query log check (034, SMD-1295): present after the migrations, and
      // off by default with OB1_QUERY_LOG unset — reported, never a refusal.
      assert(/query log\s+present; off by default/.test(okRun.out),
             `…and the query log is named present and off by default (${(okRun.out.split("\n").find((l) => /query log/.test(l)) ?? "no query log line").trim().slice(0, 70)})`);

      // The real proof: a windowed capture and an edit with content run through
      // the role. The 4-argument upsert_thought DELETEs then INSERTs
      // thought_chunks (both privileges, even the DELETE of zero rows), and the
      // thoughts INSERT fires 008's trigger into thought_audit — the three
      // writes a thoughts-only grant lacked.
      const asRole = new SQL({ url: CAPTURE_URL, max: 1 });
      try {
        // Objects and arrays, bound to ::jsonb the way store-sql.ts does — a
        // JSON.stringify here would double-encode and 005's guard would reject it.
        const envelope = { metadata: {}, embedding_model: EMBEDDING_MODEL };
        const windows = [
          { content: "window one", embedding: vecOf(1), context: null },
          { content: "window two", embedding: vecOf(2), context: null },
        ];
        const [{ r }] = (await asRole`SELECT upsert_thought('a windowed capture through the role'::text, ${envelope}::jsonb, ${vecOf(3)}::vector, ${windows}::jsonb) AS r`) as { r: { id: string; chunks: number } }[];
        assert(r.chunks === 2, `a windowed capture through the role writes chunk rows (${r.chunks})`);
        const [{ audited }] = (await asRole`SELECT count(*)::int AS audited FROM thought_audit WHERE thought_id = ${r.id}`) as { audited: number }[];
        assert(audited >= 1, "…and 008's trigger writes an audit row as the role");
        // Extraction is enabled, so the thoughts INSERT also fired 016's enqueue
        // trigger, which upserted a work claim as the role — the write the
        // conditional check just proved it needs.
        const [{ queued }] = (await asRole`SELECT count(*)::int AS queued FROM thought_work_claims WHERE thought_id = ${r.id} AND work_type = 'extract:test'`) as { queued: number }[];
        assert(queued === 1, "…and 016's enqueue trigger upserts a work claim as the role, extraction being on");
        const edit = (await asRole`SELECT update_thought(${r.id}::uuid, 'the capture, edited with content'::text, NULL::jsonb, ${vecOf(4)}::vector, ${windows}::jsonb, NULL::timestamptz, NULL::jsonb, ${EMBEDDING_MODEL}::text) AS r`) as { r: { ok?: boolean } }[];
        assert(edit.length === 1 && edit[0].r?.ok !== false, "an edit with content through the role succeeds — chunks replaced as the role");
      } finally {
        await asRole.close();
      }
    } finally {
      // Clear the shared state that later sub-blocks see first, so it runs even
      // if dropping the role throws; then drop the role.
      await claims.unsafe("DELETE FROM ob1_config WHERE key = 'entity_extraction_key'").catch(() => {});
      await dropCaptureRole();
    }
  }

  // 003's missing half. A NULL-fingerprint row whose key no row holds is a
  // capture doubled in waiting; 023's function writes it, and the remedy is
  // that one statement — as the owner, since it holds the updated_at
  // trigger. After it a NULL row is a twin, or blocked by a stale key: ok.
  // Before 023 the same row's remedy is the migration.
  await claims.unsafe("DELETE FROM thoughts");
  await claims.unsafe("INSERT INTO thoughts (content, content_fingerprint) VALUES ('a legacy singleton', NULL)");
  const [{ owner }] = await claims`SELECT pg_get_userbyid(relowner)::text AS owner FROM pg_class WHERE oid = 'thoughts'::regclass`;
  const pending = await run(SQL_ENV);
  assert(pending.code === 0 && /fingerprint backfill\s+1 thought\(s\) without a fingerprint, at least one whose text no row holds — 023's call has not reached them/.test(pending.out) && pending.out.includes(`As ${owner}: SELECT backfill_content_fingerprints(); — or, keeping each lock short, SELECT backfill_content_fingerprints(10000); until it returns 0, each call its own transaction.`),
         `a NULL-fingerprint row whose key is free is a warning that claims no cause it cannot read, with the one-statement remedy and its batched form, naming the owner (exit ${pending.code})`);
  await claims.unsafe("SELECT backfill_content_fingerprints()");
  assert(/fingerprint backfill\s+no thought is missing a fingerprint \(a stale key on a row that has one is not read here\)/.test((await run(SQL_ENV)).out), "…which performs, and the ok says what it did not read");
  await claims.unsafe("INSERT INTO thoughts (content, content_fingerprint) VALUES ('a  legacy singleton', NULL)");
  const twin = await run(SQL_ENV);
  assert(twin.code === 0 && /fingerprint backfill\s+1 thought\(s\) without a fingerprint, each sharing its text with the row that holds it \(a twin, or a stale key\)/.test(twin.out),
         "a NULL row whose text a fingerprinted row holds is a twin, not pending — ok, pointing at the pairs list");
  await claims.unsafe("DROP FUNCTION backfill_content_fingerprints(integer)");
  await claims.unsafe("INSERT INTO thoughts (content, content_fingerprint) VALUES ('another legacy singleton', NULL)");
  const pre023 = await run(SQL_ENV);
  assert(pre023.code === 0 && /fingerprint backfill\s+2 thought\(s\) without a fingerprint, at least one whose text no row holds: a capture of that text inserts a second row/.test(pre023.out) && /Apply db\/migrations\/023_content_fingerprint_backfill\.sql\./.test(pre023.out),
         "before 023 the same row is a warning whose remedy is the migration");
  // Adopted with --baseline: the ledger says 023, the function is absent, and
  // "apply 023" would be a loop the migrator skips out of. The remedy is the
  // migrator's re-run, as reembed.ts says for 021 (SMD-1193).
  await claims.unsafe("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
  await claims.unsafe("INSERT INTO schema_migrations (name, sha256) VALUES ('023_content_fingerprint_backfill.sql', 'baseline') ON CONFLICT DO NOTHING");
  const baselined = await run(SQL_ENV);
  assert(/fingerprint backfill\s+2 thought\(s\) without a fingerprint/.test(baselined.out) && /The ledger says 023 but backfill_content_fingerprints is absent \(adopted with --baseline\): re-apply the recorded migrations with the migrator — cd db && bun migrate\.ts --url … --reapply — which re-runs every migration in one transaction/.test(baselined.out),
         "…and where the ledger already says 023 the remedy is the migrator's re-run, not a migration a plain run would skip");
  await claims.unsafe("DROP TABLE schema_migrations");
  await applyMigrations(LIVE, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("023") });
  assert(/fingerprint backfill\s+1 thought\(s\) without a fingerprint, each sharing its text/.test((await run(SQL_ENV)).out), "…and 023 applied writes it and is ok again, the twin still listed");

  // The version the brain was migrated under (044, SMD-1804): reported beside the
  // highest migration, and two warnings that are never a refusal — a brain from
  // before 044, and a server older than the brain it serves.
  {
    const { FORK_VERSION } = await import("../db/version.mjs");
    const okVer = await run(SQL_ENV);
    // The ledger is unpopulated in this harness (the schema is applied without
    // recording schema_migrations rows), so "highest migration" reads "unknown"
    // here; a real migrate.ts run records the rows and prints the number.
    assert(new RegExp(`schema version\\s+${rx(FORK_VERSION)} · highest migration (?:\\d+|unknown)`).test(okVer.out),
           `a migrated brain reports schema_version beside the highest migration (${okVer.out.split("\n").find((l) => /schema version/.test(l))?.trim()})`);

    await claims.unsafe("UPDATE ob1_config SET value = '9.9.9+upstream.deadbee' WHERE key = 'schema_version'");
    const older = await run(SQL_ENV);
    assert(new RegExp(`schema version\\s+the brain is at 9\\.9\\.9\\+upstream\\.deadbee but this server is ${rx(FORK_VERSION)} — a server older than the brain`).test(older.out),
           `a brain ahead of the server warns the server is older, with a remedy (${older.out.split("\n").find((l) => /schema version/.test(l))?.trim()})`);
    const olderJson = JSON.parse((await run(SQL_ENV, "--json")).out) as { ok: boolean; checks: { name: string; status: string }[] };
    assert(olderJson.ok === true && olderJson.checks.some((c) => c.name === "schema version" && c.status === "warn"),
           "…carried as a warning in --json, under ok:true — a version mismatch never refuses the deploy");

    await claims.unsafe("DELETE FROM ob1_config WHERE key = 'schema_version'");
    const absent = await run(SQL_ENV);
    assert(/schema version\s+ob1_config records no schema_version — this brain predates migration 044/.test(absent.out) && /bun migrate\.ts --url \$DATABASE_URL/.test(absent.out),
           `a brain with no schema_version warns to apply 044 (${absent.out.split("\n").find((l) => /schema version/.test(l))?.trim()})`);

    // Restore the baseline so the --json ok run below is clean.
    await claims.unsafe(`INSERT INTO ob1_config (key, value) VALUES ('schema_version', '${FORK_VERSION}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  }

  // SMD-2041: `vector extension`, `migration ledger` and `schema version` read
  // brain-info.ts's readDatabaseFacts — the read brain_info and the keyed
  // /health body make — so a change to that read moves these rows and the
  // tool's together (test-e2e-sql [14] holds the tool's side). The ledger is
  // judged against the tree's last file, read here from the directory rather
  // than from the generated module preflight reads it from.
  {
    const row = (out: string, name: string) => out.split("\n").find((l) => new RegExp(`\\b${name}\\b`).test(l))?.trim();
    const treeLast = Math.max(...readdirSync(join(HERE, "..", "db", "migrations")).filter((n) => /^\d{3}_.*\.sql$/.test(n)).map((n) => Number(n.slice(0, 3))));
    const last = String(treeLast).padStart(3, "0");
    const prev = String(treeLast - 1).padStart(3, "0");
    const [{ v: extversion }] = await claims`SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'`;
    const bare = await run(SQL_ENV);
    assert(new RegExp(`✓\\s+vector extension\\s+the vector type resolves \\(pgvector ${rx(String(extversion))} in schema public\\)`).test(bare.out),
           `the vector row names the installed pgvector, the catalog's ${extversion} (${row(bare.out, "vector extension")})`);
    // In a checkout the generated version module is held to db/migrations/
    // (review pass 4: a stale one made a freshly migrated brain read "ahead").
    assert(new RegExp(`✓\\s+version module\\s+server-portable/version\\.ts matches db/migrations/ \\(${last}\\)`).test(bare.out),
           `the version module row holds version.ts to the tree it sits in (${row(bare.out, "version module")})`);

    const adopt = await migrate(["--url", LIVE, "--baseline"]);
    assert(adopt.code === 0, `migrate.ts --baseline records every file (${adopt.out.trim().split("\n").slice(-1)[0]})`);
    const current = await run(SQL_ENV);
    assert(new RegExp(`✓\\s+migration ledger\\s+schema_migrations present, highest ${last} — this server's tree ends there too`).test(current.out)
             // Between releases the tree's last file is past the release range,
             // which the version row warns about in its own words (SMD-1804).
             && new RegExp(`schema version\\s+(?:\\S+ · highest migration|.* ledger reaches migration) ${last}\\b`).test(current.out),
           `a ledger at the tree's last file is current, and both rows read the same highest migration (${row(current.out, "migration ledger")} | ${row(current.out, "schema version")})`);

    await claims.unsafe(`DELETE FROM schema_migrations WHERE name LIKE '${last}%'`);
    const behind = await run(SQL_ENV);
    assert(behind.code === 0 && new RegExp(`!\\s+migration ledger\\s+the ledger reaches ${prev} but this server's tree ends at ${last} — the brain is behind`).test(behind.out)
             && /bun migrate\.ts --url \$DATABASE_URL \(--dry-run lists them\)/.test(behind.out)
             // As in the current case: past the release range the version row
             // warns in its own words, and a merge of main moves the range's
             // top under this test (review pass 5: 052 behind 053 is past 051).
             && new RegExp(`schema version\\s+(?:\\S+ · highest migration|.* ledger reaches migration) ${prev}\\b`).test(behind.out),
           `a ledger short of the tree's last file warns, with the migrate remedy, and the version row agrees (${row(behind.out, "migration ledger")})`);

    await claims.unsafe(`INSERT INTO schema_migrations (name, sha256) VALUES ('${last}_x.sql', 'baseline'), ('999_from_a_newer_tree.sql', 'baseline')`);
    const ahead = await run(SQL_ENV);
    assert(new RegExp(`!\\s+migration ledger\\s+the ledger reaches 999, past this server's tree \\(${last}\\) — a newer tree migrated this brain`).test(ahead.out),
           `a ledger past the tree's last file warns the other way (${row(ahead.out, "migration ledger")})`);

    // A role that may read the corpus and neither the ledger nor ob1_config
    // (review pass 1): the ledger row says the table is there and unreadable —
    // information_schema hid it from such a role, and the row told it to adopt
    // a hand-applied schema with --baseline — and the version row says it
    // could not read ob1_config rather than that 044 never ran.
    await claims.unsafe("DROP ROLE IF EXISTS pf_reader");
    await claims.unsafe("CREATE ROLE pf_reader LOGIN PASSWORD 'reader'");
    await claims.unsafe("GRANT USAGE ON SCHEMA public TO pf_reader");
    await claims.unsafe("GRANT SELECT ON thoughts TO pf_reader");
    try {
      const asReader = await run({ ...SQL_ENV, DATABASE_URL: LIVE!.replace(/\/\/[^@]*@/, "//pf_reader:reader@") });
      assert(/migration ledger\s+schema_migrations present, not readable by this role \(permission denied for table schema_migrations\)/.test(asReader.out) && !/no schema_migrations table/.test(asReader.out),
             `a role without SELECT on the ledger is told it is unreadable, not absent (${row(asReader.out, "migration ledger")})`);
      assert(/schema version\s+could not verify: permission denied for table ob1_config/.test(asReader.out),
             `…and the version row names the refused ob1_config read (${row(asReader.out, "schema version")})`);

      // The same role with public off its search path (review pass 2): the
      // ledger exists and does not resolve for it. Never "no schema_migrations
      // table" and never the --baseline remedy, which on a partly migrated
      // brain would record pending migrations as applied.
      await claims.unsafe("ALTER ROLE pf_reader SET search_path = nowhere");
      const lost = await run({ ...SQL_ENV, DATABASE_URL: LIVE!.replace(/\/\/[^@]*@/, "//pf_reader:reader@") });
      assert(/!\s+migration ledger\s+schema_migrations exists \(schema public\) but does not resolve for this role/.test(lost.out)
               && !/no schema_migrations table/.test(lost.out) && !/Adopt it with: cd db && bun migrate\.ts --url \$DATABASE_URL --baseline/.test(lost.out),
             `a ledger off the role's search path warns that it does not resolve, and recommends no --baseline (${row(lost.out, "migration ledger")})`);

      // The same role granted SELECT on every table, ob1_config among them,
      // public still off its path (SMD-2062): the write-privileges check tested
      // public.ob1_config, then read a bare ob1_config, which does not resolve —
      // and the raise took every later direct row down as "not checked".
      // The row now names what the role lacks, every later row runs, and the
      // schema row — thoughts is there, off the path — does not say migrate.
      await claims.unsafe("GRANT SELECT ON ALL TABLES IN SCHEMA public TO pf_reader");
      const wide = await run({ ...SQL_ENV, DATABASE_URL: LIVE!.replace(/\/\/[^@]*@/, "//pf_reader:reader@") });
      assert(/✗\s+write privileges\s+this connection's role \(pf_reader\) is missing privileges the capture path's writers need/.test(wide.out),
             `a role that may read ob1_config without public on its path gets the write-privileges row's own result (${row(wide.out, "write privileges")})`);
      assert(!/not checked — the direct connection failed before it/.test(wide.out)
               && /✓\s+chunk context/.test(wide.out)
               && /migration ledger\s+schema_migrations exists \(schema public\) but does not resolve for this role/.test(wide.out)
               && /schema version\s+could not verify: ob1_config exists \(schema public\) but does not resolve for this role/.test(wide.out),
             `…and every later direct row runs, the ledger and version rows in their own words (${row(wide.out, "chunk context")} | ${row(wide.out, "schema version")})`);
      assert(/✗\s+schema\s+relation "thoughts" does not exist — public\.thoughts exists but does not resolve for this role \(public is not on its search_path\)\n\s+→ Put public on the server role's search_path/.test(wide.out)
               && !/Apply the migrations: cd db/.test(wide.out),
             `…and the schema row names the path, not the migrate command (${row(wide.out, "schema")})`);

      // With no USAGE on public — PUBLIC's taken too, which a fresh database
      // grants — to_regclass('public.…') itself raises. The rows whose reads
      // are qualified say so each, in their own boundary; none takes the rest.
      const [{ publicUsage }] = await claims`SELECT has_schema_privilege('public', 'public', 'USAGE') AS "publicUsage"`;
      await claims.unsafe("REVOKE USAGE ON SCHEMA public FROM pf_reader, PUBLIC");
      try {
        const bare = await run({ ...SQL_ENV, DATABASE_URL: LIVE!.replace(/\/\/[^@]*@/, "//pf_reader:reader@") });
        assert(/!\s+write privileges\s+could not verify: permission denied for schema public/.test(bare.out)
                 && /!\s+chunk context\s+could not verify: permission denied for schema public/.test(bare.out)
                 && !/not checked — the direct connection failed before it/.test(bare.out),
               `a role with no USAGE on public: the qualified reads' rows warn, each alone, and every later row runs (${row(bare.out, "write privileges")} | ${row(bare.out, "tier")})`);
        assert(/✗\s+schema\s+relation "thoughts" does not exist — public\.thoughts exists but does not resolve for this role \(no USAGE on schema public\)\n\s+→ GRANT USAGE ON SCHEMA public TO pf_reader;/.test(bare.out),
               `…and the schema row names the missing USAGE, not the path (${row(bare.out, "schema")})`);
      } finally {
        if (publicUsage) await claims.unsafe("GRANT USAGE ON SCHEMA public TO PUBLIC");
      }
    } finally {
      await claims.unsafe("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM pf_reader");
      await claims.unsafe("REVOKE ALL ON thoughts FROM pf_reader");
      await claims.unsafe("REVOKE USAGE ON SCHEMA public FROM pf_reader");
      await claims.unsafe("DROP ROLE pf_reader");
    }

    // A ledger held by a migration while preflight runs (review pass 2): its
    // read times out, and the row says it could not verify — not that the
    // role lacks a grant.
    {
      const locker = new SQL({ url: LIVE!, max: 1 });
      let release: () => void = () => {};
      const held = new Promise<void>((r) => { release = r; });
      let locked: () => void = () => {};
      const isLocked = new Promise<void>((r) => { locked = r; });
      const tx = locker.begin(async (t) => {
        await t`LOCK TABLE schema_migrations IN ACCESS EXCLUSIVE MODE`;
        locked();
        await held;
      });
      await isLocked;
      let busy: { code: number; out: string } = { code: -1, out: "" };
      try {
        busy = await run(SQL_ENV);
      } finally {
        release();
        await tx;
        await locker.close();
      }
      assert(/!\s+migration ledger\s+could not verify: schema_migrations could not be read \(canceling statement due to lock timeout\)/.test(busy.out) && !/not readable by this role/.test(row(busy.out, "migration ledger") ?? ""),
             `a locked ledger is could-not-verify, not a missing grant (${row(busy.out, "migration ledger")})`);
      // …and the version row, whose range check needs the ledger's highest,
      // says it could not verify rather than ✓ "unknown" (review pass 3).
      assert(/!\s+schema version\s+could not verify against the ledger: .* schema_migrations could not be read: canceling statement due to lock timeout/.test(busy.out),
             `a locked ledger leaves the version row unverified, not ✓ (${row(busy.out, "schema version")})`);
    }

    // Back to the harness's unrecorded schema for the sections below.
    await claims.unsafe("DROP TABLE schema_migrations");
  }

  // The pipeline tier (SMD-1806): unset on a plain brain the ingester never
  // touched, reported once db/ingest-records.ts has stamped it, and a warning —
  // never a refusal — when the server's OB1_TIER names a different tier than the
  // database was stamped as (a working server pointed at the stable database).
  {
    const tierRow = (out: string) => out.split("\n").find((l) => /\btier\b/.test(l))?.trim();
    const none = await run(SQL_ENV);
    assert(/·\s+tier\s+no tier recorded — db\/ingest-records\.ts has not run/.test(none.out),
           `a brain the ingester never touched reports no tier (${tierRow(none.out)})`);

    await claims.unsafe("INSERT INTO ob1_config (key, value) VALUES ('tier', 'stable'), ('last_ingest', '2026-09-22T00:00:00.000Z') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
    const okTier = await run(SQL_ENV);
    assert(/✓\s+tier\s+stable, last ingest 2026-09-22T00:00:00\.000Z/.test(okTier.out),
           `a stamped brain reports its tier and last ingest (${tierRow(okTier.out)})`);

    const mism = await run({ ...SQL_ENV, OB1_TIER: "working" });
    assert(/!\s+tier\s+the database is tier 'stable'.*but this server runs OB1_TIER=working — a server pointed at another tier's database/.test(mism.out),
           `a server whose OB1_TIER names another tier than the database warns (${tierRow(mism.out)})`);
    const mismJson = JSON.parse((await run({ ...SQL_ENV, OB1_TIER: "working" }, "--json")).out) as { ok: boolean; checks: { name: string; status: string }[] };
    assert(mismJson.ok === true && mismJson.checks.some((c) => c.name === "tier" && c.status === "warn"),
           "…carried as a warning in --json under ok:true — a tier mismatch never refuses the deploy");

    // An INVALID OB1_TIER (a value not in the pipeline set, incl. a case variant)
    // is a different verdict: fatal. It fails migration 045's CHECK, and the
    // best-effort log write would silently drop every query_log row — so
    // preflight fails, and the container entrypoint (bun preflight.ts && …)
    // refuses to serve (SMD-1953).
    const bad = await run({ ...SQL_ENV, OB1_TIER: "prod" });
    assert(bad.code !== 0, `an invalid OB1_TIER refuses at preflight, so the container entrypoint would not serve (exit ${bad.code})`);
    assert(/OB1_TIER is "prod"/.test(bad.out), `…and the tier row names the bad value (${tierRow(bad.out)})`);
    const badJson = JSON.parse((await run({ ...SQL_ENV, OB1_TIER: "prod" }, "--json")).out) as { ok: boolean; checks: { name: string; status: string }[] };
    assert(badJson.ok === false && badJson.checks.some((c) => c.name === "tier" && c.status === "fail"),
           "…as fail in --json under ok:false — a wrong tier refuses the deploy, unlike a mismatch which only warns (SMD-1953)");

    await claims.unsafe("DELETE FROM ob1_config WHERE key IN ('tier', 'last_ingest')");
  }

  await claims.unsafe("DELETE FROM thoughts");
  await claims.close();

  const j = await run({ ...BASE_OK, ...NO_DB, OB1_STORE: "sql", DATABASE_URL: LIVE }, "--json");
  const parsed = JSON.parse(j.out);
  assert(parsed.ok === true, "--json reports ok:true");
  assert(Array.isArray(parsed.checks) && parsed.checks.length > 5, "--json lists every check for a pipeline to consume");
}

// [6], [7] and [8] need no database: the provider rows print from configuration
// alone, and the --deep probes run whether or not the data layer came up. A
// store that is configured and unreachable, and no credential anywhere.
const DB_DOWN = { ...NO_DB, OB1_STORE: "sql", DATABASE_URL: "postgres://u:p@127.0.0.1:1/x", MCP_ACCESS_KEY: "x".repeat(64), OB1_LLM_BASE_URL: LOCAL_STUB };
const NO_KEYS = { OPENROUTER_API_KEY: undefined, OB1_LLM_API_KEY: undefined, OB1_CHAT_BASE_URL: undefined, OB1_CHAT_API_KEY: undefined };

console.log("\n[6] Two provider endpoints are reported and gated by name (SMD-1902)");
{
  const LOCAL = LOCAL_STUB;
  const HOSTED = "https://openrouter.ai/api/v1";

  // Neither chat knob: one provider row that says it serves both, and no chat rows at all.
  const one = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: LOCAL });
  assert(/embeddings and chat/.test(row(one.out, "model provider")), "one endpoint: the provider row says it serves embeddings and chat");
  assert(row(one.out, "chat provider") === "" && row(one.out, "chat credential") === "", "…and no chat rows print");

  // A hosted chat endpoint with no key of its own fails by name, and is told
  // the embeddings key is not borrowed.
  const hosted = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: LOCAL, OB1_LLM_API_KEY: "k-emb", OB1_CHAT_BASE_URL: HOSTED });
  assert(hosted.code === 1, "a hosted chat endpoint with no OB1_CHAT_API_KEY exits 1");
  assert(/✗\s+chat credential\s+no OB1_CHAT_API_KEY, and https:\/\/openrouter\.ai\/api\/v1 is not local — OB1_LLM_API_KEY belongs to the other endpoint/.test(hosted.out),
         "…the chat credential row names the knob and says the embeddings key is not sent there");
  assert(/→ Set OB1_CHAT_API_KEY, or point OB1_CHAT_BASE_URL at a local provider\./.test(hosted.out), "…with the fix naming both chat knobs");
  assert(/✓\s+chat provider\s+https:\/\/openrouter\.ai\/api\/v1 — chat \(OB1_CHAT_BASE_URL\)/.test(hosted.out), "…and the chat provider row names the base");
  assert(new RegExp(String.raw`✓\s+model provider\s+${rx(LOCAL)} — embeddings \(local`).test(hosted.out), "…while the provider row now says embeddings only");
  assert(/!\s+provider credential\s+a key is set but the endpoint is local/.test(hosted.out), "…and the embeddings credential still warns about its own key on a local endpoint");

  // With a key of its own it passes and the value never prints; a local chat
  // endpoint beside a hosted embedder needs none and is told the hosted key stays put.
  const keyed = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: LOCAL, OB1_CHAT_BASE_URL: HOSTED, OB1_CHAT_API_KEY: "k-chat-1234" });
  assert(/✓\s+chat credential\s+set \(11 chars\)/.test(keyed.out), "OB1_CHAT_API_KEY set: the chat credential row reports its length");
  assert(!/k-chat-1234/.test(keyed.out), "…and never the value");
  const localChat = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: HOSTED, OPENROUTER_API_KEY: "k-emb", OB1_CHAT_BASE_URL: LOCAL });
  assert(/✓\s+chat credential\s+not required for a local endpoint — OPENROUTER_API_KEY belongs to the other endpoint/.test(localChat.out),
         "a local chat endpoint beside a hosted embedder: no key required, and the hosted key is named as not sent");
  assert(!/chat credential\s+a key is set but the endpoint is local/.test(localChat.out), "…with no warning that a key will be sent to it");
  const chatKeyOnly = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: HOSTED, OPENROUTER_API_KEY: "k-emb", OB1_CHAT_API_KEY: "k-chat" });
  assert(/✓\s+chat provider\s+https:\/\/openrouter\.ai\/api\/v1 — chat, the embeddings endpoint with its own credential \(OB1_CHAT_API_KEY\)/.test(chatKeyOnly.out),
         "OB1_CHAT_API_KEY alone: the chat row says the endpoint is shared and only the credential is its own");

  // --deep dials each endpoint by name: a chat endpoint that is down fails its
  // own row while the embeddings row passes against its endpoint.
  const emb = Bun.serve({ port: 0, fetch: () => Response.json({ data: [{ embedding: new Array(EMBEDDING_DIM).fill(0) }] }) });
  const deep = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: `http://127.0.0.1:${emb.port}/v1`, OB1_CHAT_BASE_URL: "http://127.0.0.1:1/v1" }, "--deep");
  emb.stop();
  assert(new RegExp(`✓\\s+embedding provider\\s+${rx(EMBEDDING_MODEL)} returns ${EMBEDDING_DIM} dimensions, matching the schema`).test(deep.out),
         "--deep: the embeddings probe passes against its endpoint");
  assert(/✗\s+metadata model\s+\S+ at http:\/\/127\.0\.0\.1:1\/v1: /.test(deep.out) && /→ Network reachability to 127\.0\.0\.1:1\./.test(deep.out),
         "…while the chat probe fails by its own name, naming the chat endpoint and its host");
}

console.log("\n[7] The supersession judge's model is reported, and probed under its own row when it is not the metadata model (SMD-1901)");
{
  // A stub serves both paths and logs the model each chat probe names, so
  // "probed once" and "probed under its own row" are facts about the requests.
  const chatModels: string[] = [];
  let refuse = "";
  const stub = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === "GET") return Response.json({ object: "list", data: [] }); // the reachability probe (SMD-1875)
      const body = (await req.json()) as { model: string };
      if (new URL(req.url).pathname.endsWith("/embeddings")) return Response.json({ data: [{ embedding: new Array(EMBEDDING_DIM).fill(0) }] });
      chatModels.push(body.model);
      if (body.model === refuse) return new Response(`model "${body.model}" not found`, { status: 404 });
      return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
    },
  });
  const ENV = { ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: `http://127.0.0.1:${stub.port}/v1`, OB1_METADATA_MODEL: "meta-7b" };

  // Unset: the row says the judge runs on the metadata model and how to give
  // it another; --deep probes one model, once.
  const shared = await run({ ...ENV, OB1_JUDGE_MODEL: undefined }, "--deep");
  assert(/✓\s+judge model\s+meta-7b — the metadata model; OB1_JUDGE_MODEL gives the judge its own\s*$/m.test(shared.out),
         "OB1_JUDGE_MODEL unset: the judge model row names the metadata model and the knob");
  assert(/✓\s+metadata model\s+meta-7b honours JSON mode at/.test(shared.out), "--deep: the metadata model is probed for JSON mode");
  assert(!/judge model\s+meta-7b honours/.test(shared.out) && chatModels.length === 1 && chatModels[0] === "meta-7b",
         `…once — one model, one probe, and no judge-model probe row (${chatModels.join(", ")})`);

  // Set: its own row and its own probe; the metadata model's are unchanged.
  chatModels.length = 0;
  const own = await run({ ...ENV, OB1_JUDGE_MODEL: "big-judge" }, "--deep");
  assert(/✓\s+judge model\s+big-judge \(OB1_JUDGE_MODEL\)\s*$/m.test(own.out), "OB1_JUDGE_MODEL set: the judge model row names it and the knob");
  assert(/✓\s+metadata model\s+meta-7b\s*$/m.test(own.out), "…and the metadata model row still names the extractor's model");
  assert(/✓\s+judge model\s+big-judge honours JSON mode at/.test(own.out) && /✓\s+metadata model\s+meta-7b honours JSON mode at/.test(own.out),
         "--deep probes each model under its own row");
  assert(chatModels.length === 2 && chatModels.includes("meta-7b") && chatModels.includes("big-judge"), `…two probes, one per model (${chatModels.join(", ")})`);

  // A judge model the endpoint does not serve fails the judge's row, with the
  // pass as the consequence, and the metadata model's row passes on its own.
  refuse = "big-judge";
  const refused = await run({ ...ENV, OB1_JUDGE_MODEL: "big-judge" }, "--deep");
  assert(/✗\s+judge model\s+big-judge returned 404 from http:\/\/127\.0\.0\.1:\d+\/v1/.test(refused.out) && /Capture is unaffected; db\/consolidate\.ts would fail every pair it judges\./.test(refused.out),
         "a judge model the endpoint refuses fails the judge model row, naming the pass it would break and not capture");
  assert(/✓\s+metadata model\s+meta-7b honours JSON mode at/.test(refused.out), "…while the metadata model row passes");
  refuse = "";

  // The metadata model named again in the judge's knob is one model: one probe.
  chatModels.length = 0;
  const same = await run({ ...ENV, OB1_JUDGE_MODEL: "meta-7b" }, "--deep");
  assert(/✓\s+judge model\s+meta-7b \(OB1_JUDGE_MODEL\) — the same as the metadata model\s*$/m.test(same.out), "the same model in both knobs: the row says so");
  assert(chatModels.length === 1, `…and it is probed once (${chatModels.length})`);
  stub.stop();
}

console.log("\n[8] The egress gate is reported: the mode, and per endpoint what leaves — declared local, the upgrade case, or refused (SMD-1903)");
{
  const LOCAL = LOCAL_STUB;
  const HOSTED = "https://openrouter.ai/api/v1";
  /** Every gate knob unset, whatever the shell has. */
  const GATE = { OB1_EGRESS_POLICY: undefined, OB1_EGRESS_ALLOW: undefined, OB1_EGRESS_DENY: undefined, OB1_LLM_LOCAL: undefined, OB1_CHAT_LOCAL: undefined };

  // The upgrade case: a loopback endpoint nothing declared. The policy row
  // says deny is the default; the endpoint row warns with the one-line fix.
  const undeclared = await run({ ...DB_DOWN, ...NO_KEYS, ...GATE, OB1_LLM_BASE_URL: LOCAL });
  const sourceTerm = await run({ ...BASE_OK, ...GATE, OB1_EGRESS_POLICY: "allow", OB1_EGRESS_DENY: "source:mcp,type:idea" });
  assert(/!\s+egress policy\s+1 source: term\(s\) \(source:mcp\) do NOT gate a capture/.test(sourceTerm.out) && /actor:<key name>/.test(sourceTerm.out),
         "a source: term is warned about — it does not gate a capture, whose source is the caller's claim (SMD-1941)");
  assert(/✓\s+egress policy\s+deny \(the default\) — a thought's text reaches an endpoint not declared local only under an OB1_EGRESS_ALLOW term; no terms/.test(undeclared.out),
         "unset: the policy row says deny, the default, no terms");
  assert(new RegExp(String.raw`!\s+embeddings egress\s+${rx(LOCAL)} looks local but is not declared so — the gate treats it as remote, and under deny with no allow term every embeddings and chat call is refused: captures land without a vector`).test(undeclared.out),
         "…a loopback endpoint nothing declared warns as the upgrade case, naming the consequence");
  assert(/→ Set OB1_LLM_LOCAL=1 if this endpoint is on this machine/.test(undeclared.out), "…with the one-line fix");
  assert(row(undeclared.out, "chat egress") === "", "…and one row when chat is the embeddings endpoint");
  const declared = await run({ ...DB_DOWN, ...NO_KEYS, ...GATE, OB1_LLM_BASE_URL: LOCAL, OB1_LLM_LOCAL: "1" });
  assert(new RegExp(String.raw`✓\s+embeddings egress\s+${rx(LOCAL)} is declared local \(OB1_LLM_LOCAL\) — the embeddings and chat text stays on the box; the gate does not apply`).test(declared.out),
         "declared: ok, naming the knob");

  // Hosted under deny with no terms: every call refused, said with the
  // consequence and the ways out; with terms, what leaves and under what.
  const hostedDeny = await run({ ...DB_DOWN, ...NO_KEYS, ...GATE, OB1_LLM_BASE_URL: HOSTED, OPENROUTER_API_KEY: "k" });
  assert(/!\s+embeddings egress\s+every embeddings and chat call to openrouter\.ai is refused — deny with no OB1_EGRESS_ALLOW term — so captures land without a vector/.test(hostedDeny.out),
         "hosted, deny, no terms: warns that every call is refused");
  assert(/→ Declare the endpoint local \(OB1_LLM_LOCAL=1\) if it is, name what may leave in OB1_EGRESS_ALLOW/.test(hostedDeny.out), "…with the ways out");
  const hostedTerms = await run({ ...DB_DOWN, ...NO_KEYS, ...GATE, OB1_LLM_BASE_URL: HOSTED, OPENROUTER_API_KEY: "k", OB1_EGRESS_ALLOW: "actor:chatgpt, marker:#public" });
  assert(/✓\s+egress policy\s+deny \(the default\) — .*; 2 term\(s\): actor:chatgpt, marker:#public/.test(hostedTerms.out), "…with terms the policy row lists them");
  assert(/✓\s+embeddings egress\s+the embeddings and chat text leaves to openrouter\.ai only under an OB1_EGRESS_ALLOW term; otherwise captures land/.test(hostedTerms.out),
         "…and the endpoint row says what leaves and under what");
  const allow = await run({ ...DB_DOWN, ...NO_KEYS, ...GATE, OB1_LLM_BASE_URL: HOSTED, OPENROUTER_API_KEY: "k", OB1_EGRESS_POLICY: "allow" });
  assert(/✓\s+egress policy\s+allow — .*; no terms/.test(allow.out) && /✓\s+embeddings egress\s+the full text of every embeddings and chat call leaves to openrouter\.ai — no OB1_EGRESS_DENY term holds any back/.test(allow.out),
         "allow with no deny terms: says everything leaves, in words");
  const off = await run({ ...DB_DOWN, ...NO_KEYS, ...GATE, OB1_LLM_BASE_URL: HOSTED, OPENROUTER_API_KEY: "k", OB1_EGRESS_POLICY: "off" });
  assert(/!\s+egress policy\s+off — nothing decides what leaves the box/.test(off.out) && /✓\s+embeddings egress\s+the full text of every embeddings and chat call leaves to openrouter\.ai — the gate is off/.test(off.out),
         "off: the policy row warns, the endpoint row says the text leaves");
  assert(!/✗\s+egress/.test(off.out), "…a warning, not a failure: the operator may choose it");

  // A knob that does not parse fails by name, and the endpoint row says the
  // gate is closed meanwhile.
  const bad = await run({ ...DB_DOWN, ...NO_KEYS, ...GATE, OB1_LLM_BASE_URL: HOSTED, OPENROUTER_API_KEY: "k", OB1_EGRESS_POLICY: "allow", OB1_EGRESS_DENY: "marker:#phi,nonsense" });
  assert(bad.code === 1 && /✗\s+egress policy\s+OB1_EGRESS_DENY: `nonsense` is not unit:value \(units: actor, source, type, topic, marker\) — the gate fails closed \(deny\) until this is fixed/.test(bad.out),
         "a term that does not parse fails by name");
  assert(/!\s+embeddings egress\s+every embeddings and chat call to openrouter\.ai is refused while the policy does not parse/.test(bad.out), "…and the endpoint row says every call is refused meanwhile");
  // Terms in the knob the mode does not read: a warning naming both knobs.
  const unread = await run({ ...DB_DOWN, ...NO_KEYS, ...GATE, OB1_LLM_BASE_URL: LOCAL, OB1_LLM_LOCAL: "1", OB1_EGRESS_DENY: "marker:#phi" });
  assert(/!\s+egress policy\s+OB1_EGRESS_DENY has 1 term\(s\) but the mode is deny, which reads OB1_EGRESS_ALLOW — they decide nothing/.test(unread.out) && /→ Move them to OB1_EGRESS_ALLOW, or change OB1_EGRESS_POLICY\./.test(unread.out),
         "deny terms under deny: warned as unread, with the knob the mode reads");
  assert(!/egress policy\s+.*decide nothing/.test(declared.out), "…and no such warning when no term is unread");
  // The upgrade-case warning carries the consequence for the mode in force.
  const undeclaredTerms = await run({ ...DB_DOWN, ...NO_KEYS, ...GATE, OB1_LLM_BASE_URL: LOCAL, OB1_EGRESS_ALLOW: "marker:#public" });
  assert(/looks local but is not declared so — the gate treats it as remote, and under deny every embeddings and chat call no OB1_EGRESS_ALLOW term matches is refused/.test(undeclaredTerms.out),
         "…undeclared under deny WITH terms says what is refused");
  const undeclaredOff = await run({ ...DB_DOWN, ...NO_KEYS, ...GATE, OB1_LLM_BASE_URL: LOCAL, OB1_EGRESS_POLICY: "off" });
  assert(/looks local but is not declared so — the gate treats it as remote; the gate is off, so nothing is refused today/.test(undeclaredOff.out), "…and under off that nothing is refused today");
  // Either knob declares a shared endpoint; the row names the one that did.
  const chatKnob = await run({ ...DB_DOWN, ...NO_KEYS, ...GATE, OB1_LLM_BASE_URL: LOCAL, OB1_CHAT_LOCAL: "1" });
  assert(new RegExp(String.raw`✓\s+embeddings egress\s+${rx(LOCAL)} is declared local \(OB1_CHAT_LOCAL\) — the embeddings and chat text stays on the box`).test(chatKnob.out),
         "OB1_CHAT_LOCAL alone declares the one endpoint both calls use, and the row names that knob");
  const badMode = await run({ ...DB_DOWN, ...NO_KEYS, ...GATE, OB1_LLM_BASE_URL: LOCAL, OB1_LLM_LOCAL: "1", OB1_EGRESS_POLICY: "maybe" });
  assert(badMode.code === 1 && /✗\s+egress policy\s+OB1_EGRESS_POLICY: `maybe` is not one of deny, allow, off/.test(badMode.out),
         "a mode outside the three fails by name, even with every endpoint declared local");

  // Two endpoints, two rows, each with its own knob; a same-base chat
  // endpoint inherits and names the knob that declared it.
  const split = await run({ ...DB_DOWN, ...NO_KEYS, ...GATE, OB1_LLM_BASE_URL: LOCAL, OB1_LLM_LOCAL: "1", OB1_CHAT_BASE_URL: HOSTED, OB1_CHAT_API_KEY: "k" });
  assert(new RegExp(String.raw`✓\s+embeddings egress\s+${rx(LOCAL)} is declared local \(OB1_LLM_LOCAL\) — the embeddings text stays`).test(split.out), "split: the embeddings row is its own");
  assert(/!\s+chat egress\s+every chat call to openrouter\.ai is refused — deny with no OB1_EGRESS_ALLOW term — so captures land untagged/.test(split.out) && /→ Declare the endpoint local \(OB1_CHAT_LOCAL=1\)/.test(split.out),
         "…and the chat row names its own knob and consequence");
  const inherit = await run({ ...DB_DOWN, ...NO_KEYS, ...GATE, OB1_LLM_BASE_URL: LOCAL, OB1_LLM_LOCAL: "1", OB1_CHAT_API_KEY: "k" });
  assert(new RegExp(String.raw`✓\s+chat egress\s+${rx(LOCAL)} is declared local \(OB1_LLM_LOCAL\)`).test(inherit.out),
         "a chat endpoint at the same base with its own key inherits the declaration and names the knob that made it");
}

console.log("\n[9] A local endpoint is dialled by default, and one that answers nothing fails before the server starts (SMD-1875)");
{
  const THREE = (s: string) => /host\.containers\.internal:11434\/v1/.test(s) && /host\.docker\.internal:11434\/v1/.test(s) && /--profile local-models/.test(s);

  // The measured baseline: the code's default inside a container is the
  // container's own loopback, which reaches nothing. Refused → fail, exit 1,
  // and the remedy says what 127.0.0.1 is inside a container and names the
  // three spellings.
  const refused = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: "http://127.0.0.1:1/v1" });
  assert(refused.code === 1 && /✗\s+provider endpoint\s+nothing answers at http:\/\/127\.0\.0\.1:1\/v1 — the connection was refused \(GET \/models, 2\.5 s timeout\); the first capture would fail on it in milliseconds/.test(row(refused.out, "provider endpoint")),
         `a loopback endpoint nothing listens on fails the provider endpoint row by name (exit ${refused.code})`);
  assert(/→ Inside a container 127\.0\.0\.1 is the container itself, not the host: an Ollama on the host is/.test(fix(refused.out, "provider endpoint")) && THREE(fix(refused.out, "provider endpoint")),
         "…with the remedy naming the three spellings — the two host aliases and the stack's own service under its profile");
  assert(/✓\s+model provider\s+http:\/\/127\.0\.0\.1:1\/v1 — embeddings and chat \(local — no credential needed\)/.test(refused.out) && /✓\s+provider credential\s+not required for a local endpoint/.test(refused.out),
         "…while the provider and credential rows still pass: local it is, reachable it is not");

  // The compose fallback with no profile — the ticket's case, and SMD-1843's
  // OpenRouter-key-alone case: `ollama` resolves only on the compose network
  // with the profile up. Port 1, so a box whose resolver knows the name still
  // fails; the remedy is the hostname's either way. Which wording
  // is decided here first, by the same resolver, so the unresolved wording
  // is pinned wherever the name is unknown (first review pass: an
  // either-or regex let the ENOTFOUND mapping drift unnoticed).
  // A box whose resolver knows the name may also have a host that drops
  // port 1 (a wildcard search domain, a firewall), which is the timeout
  // wording (second review pass); an unknown name is one wording, pinned.
  const ollamaResolves = await Bun.dns.lookup("ollama").then(() => true, () => false);
  const service = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: "http://ollama:1/v1" });
  // An unknown name is "does not resolve" — with its code, or "within 2.5 s"
  // where the resolver stalls (a GitHub runner did, on PR #138's first run) —
  // never the timeout kind: the name is judged before anything is dialled.
  const serviceWhy = ollamaResolves ? String.raw`(the connection was refused|no HTTP answer in 2\.5 s)` : String.raw`the name does not resolve(?: \([A-Z_]+\)| within 2\.5 s — the resolver did not answer)? \(GET /models, 2\.5 s timeout\); the first capture would (?:fail on it in milliseconds|wait on the resolver)`;
  assert(service.code === 1 && new RegExp(String.raw`✗\s+provider endpoint\s+nothing answers at http://ollama:1/v1 — ${serviceWhy}`).test(row(service.out, "provider endpoint")),
         `the ollama service name with nothing behind it fails (exit ${service.code}; the name ${ollamaResolves ? "resolves here, so refused or silent" : "does not resolve here, so that wording, pinned"})`);
  assert(/→ `ollama` is the local-models profile's service and exists only under it: start the stack with --profile local-models, or set OB1_LLM_BASE_URL to an Ollama on the host \(http:\/\/host\.containers\.internal:11434\/v1 under podman or http:\/\/host\.docker\.internal:11434\/v1 under Docker\) or to a hosted provider with a key\./.test(fix(service.out, "provider endpoint")),
         "…and the remedy names the profile first, then the host aliases and a hosted provider");
  const withKey = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: "http://ollama:1/v1", OPENROUTER_API_KEY: "sk-or-1234" });
  assert(withKey.code === 1 && /✗\s+provider endpoint/.test(withKey.out) && /!\s+provider credential\s+a key is set but the endpoint is local/.test(withKey.out),
         "a key set beside the fallback address (the URL line left commented) fails on the endpoint, where it used to warn about the key and say OK");

  // The host alias on a runtime that does not provide it, or with nothing on
  // the host: the remedy says which runtime provides which name, and that
  // Linux Docker gets host.docker.internal through compose's extra_hosts.
  const alias = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: "http://host.docker.internal:1/v1" });
  assert(alias.code === 1 && /✗\s+provider endpoint\s+nothing answers at http:\/\/host\.docker\.internal:1\/v1/.test(row(alias.out, "provider endpoint")),
         `the Docker host alias with nothing behind it fails (exit ${alias.code})`);
  assert(/→ Nothing on the host answers at that port, or this runtime does not provide the name: podman writes both names; Docker Desktop only host\.docker\.internal; Docker on Linux neither unless extra_hosts host-gateway is set, and deploy\/compose\.yaml sets it for host\.docker\.internal\./.test(fix(alias.out, "provider endpoint")),
         "…with the runtimes and the extra_hosts line named");
  assert(THREE(fix(alias.out, "provider endpoint")), "…and the three spellings, this remedy too (third review pass: the pass-2 rewrite had dropped podman's)");
  // A private address (a LAN box): the generic remedy, still with the three spellings.
  const lan = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: "http://192.168.0.1:1/v1" });
  assert(/✗\s+provider endpoint/.test(lan.out) && /→ Start the provider at that address or fix the host and port in OB1_LLM_BASE_URL;/.test(fix(lan.out, "provider endpoint")) && THREE(fix(lan.out, "provider endpoint")),
         "a private-network address nothing answers on gets the generic remedy, with the three spellings");

  // An endpoint that answers passes, whatever it answers: the probe is the
  // connection, --deep is the API. The request is a bare GET of /models with
  // no credential even when a key is set — a key is never sent to prove reachability.
  const seen: { method: string; path: string; auth: string | null; length: string | null }[] = [];
  let status = 200;
  const answering = Bun.serve({ port: 0, fetch: (req) => { seen.push({ method: req.method, path: new URL(req.url).pathname, auth: req.headers.get("authorization"), length: req.headers.get("content-length") }); return new Response(status === 200 ? '{"object":"list","data":[]}' : "not here", { status }); } });
  const ANSWERS = `http://127.0.0.1:${answering.port}/v1`;
  const up = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: ANSWERS, OB1_LLM_API_KEY: "k-local" });
  assert(new RegExp(String.raw`✓\s+provider endpoint\s+${rx(ANSWERS)} answers — HTTP 200 to GET /models in \d+ ms; what it serves is checked under --deep`).test(up.out),
         "an endpoint that answers passes the row, naming the status and the path");
  assert(seen.length === 1 && seen[0].method === "GET" && seen[0].path === "/v1/models" && seen[0].auth === null && (seen[0].length === null || seen[0].length === "0"),
         `…with exactly one bare GET of /v1/models and no Authorization header, key or no key (${JSON.stringify(seen)})`);
  assert(!/✗/.test(row(up.out, "provider endpoint")) && !/embedding provider\s+\S+ returns/.test(up.out), "…and no embedding request was made without --deep");
  status = 404; seen.length = 0;
  const notFound = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: ANSWERS });
  assert(new RegExp(String.raw`✓\s+provider endpoint\s+${rx(ANSWERS)} answers — HTTP 404 to GET /models`).test(notFound.out), "a 4xx answer is an endpoint that answers — the API's behaviour is --deep's question");
  status = 500;
  const erroring = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: ANSWERS });
  assert(/✓\s+provider endpoint\s+\S+ answers — HTTP 500/.test(erroring.out), "…and so is a 5xx");
  answering.stop(true);

  // One that accepts the connection and never answers: the timeout, in words,
  // and a consequence that is not "milliseconds" — a capture would hang on it
  // for its request budget (first review pass). The stub keeps Bun.serve's
  // 10 s idleTimeout, and the upper bound below leans on it: a probe timeout
  // over 10 s would surface as the stub's own idle close at ~12 s.
  const hung = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
  const t0 = performance.now();
  const timedOut = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: `http://127.0.0.1:${hung.port}/v1` });
  const waited = performance.now() - t0;
  hung.stop(true);
  assert(timedOut.code === 1 && /✗\s+provider endpoint\s+nothing answers at http:\/\/127\.0\.0\.1:\d+\/v1 — no HTTP answer in 2\.5 s \(GET \/models, 2\.5 s timeout\); the first capture would wait on it, up to the whole request timeout \(OB1_LLM_TIMEOUT\), and then fail/.test(row(timedOut.out, "provider endpoint")),
         `an endpoint that accepts and never answers fails on the timeout, said in seconds, with the hang as the consequence (exit ${timedOut.code})`);
  assert(waited >= 2400 && waited < 10000, `…after about the timeout and not the run's whole patience (${Math.round(waited)} ms)`);

  // A redirect is an answer from THIS address and is not followed: the row
  // says 3xx, the target is never dialled — so a redirector cannot make the
  // row name one address and judge another, on or off the box (first review
  // pass: `fetch` followed it, and a 302 to a dead port read as refused).
  let targetHits = 0;
  const target = Bun.serve({ port: 0, fetch: () => { targetHits++; return new Response("here", { status: 200 }); } });
  const redirector = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${target.port}/elsewhere` } }) });
  const redirected = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: `http://127.0.0.1:${redirector.port}/v1` });
  redirector.stop(true); target.stop(true);
  assert(/✓\s+provider endpoint\s+http:\/\/127\.0\.0\.1:\d+\/v1 answers — HTTP 302 to GET \/models/.test(redirected.out) && targetHits === 0,
         `a 302 passes as an answer from the base and its target is not dialled (${targetHits} hit(s) on the target)`);

  // A hosted endpoint is not dialled without --deep (unchanged): a name that
  // cannot resolve, with a key, prints no endpoint row and no resolver error.
  const hosted = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: "https://provider.invalid/v1", OPENROUTER_API_KEY: "sk-or-1234" });
  assert(row(hosted.out, "provider endpoint") === "" && !/ENOTFOUND|does not resolve/.test(hosted.out) && /✓\s+provider credential\s+set \(10 chars\)/.test(hosted.out),
         "a hosted endpoint with a key is not dialled: no endpoint row, no resolver error");
  // Declared local by the knob but hosted by its name: the probe follows the
  // credential rule (the hostname), as the row's own text says — the
  // declaration is the egress gate's, and a name that is not on this box is
  // not dialled without a credential to show for it.
  const declared = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: "https://provider.invalid/v1", OPENROUTER_API_KEY: "sk-or-1234", OB1_LLM_LOCAL: "1" });
  assert(row(declared.out, "provider endpoint") === "", "…and OB1_LLM_LOCAL=1 on a hosted name does not make it dial either");

  // Two endpoints: the same base is one socket and one probe; a chat base of
  // its own is its own row, so a down chat server fails by its own name.
  const chatSeen: string[] = [];
  const chatStub = Bun.serve({ port: 0, fetch: (req) => { chatSeen.push(new URL(req.url).pathname); return Response.json({ object: "list", data: [] }); } });
  const CHAT = `http://127.0.0.1:${chatStub.port}/v1`;
  const shared = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: CHAT, OB1_CHAT_API_KEY: "k-chat" });
  assert(chatSeen.length === 1 && row(shared.out, "chat endpoint") === "" && /✓\s+provider endpoint/.test(shared.out),
         `a chat endpoint at the embeddings base with its own key is one probe and one row (${chatSeen.length} request(s))`);
  chatSeen.length = 0;
  const own = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: LOCAL_STUB, OB1_CHAT_BASE_URL: CHAT });
  assert(chatSeen.length === 1 && new RegExp(String.raw`✓\s+chat endpoint\s+${rx(CHAT)} answers — HTTP 200 to GET /models`).test(own.out) && /✓\s+provider endpoint/.test(own.out),
         "a chat base of its own is probed under its own row");
  chatStub.stop(true);
  const chatDown = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: LOCAL_STUB, OB1_CHAT_BASE_URL: "http://127.0.0.1:1/v1" });
  assert(chatDown.code === 1 && /✓\s+provider endpoint/.test(chatDown.out) && /✗\s+chat endpoint\s+nothing answers at http:\/\/127\.0\.0\.1:1\/v1 — the connection was refused/.test(row(chatDown.out, "chat endpoint")),
         `a down chat server beside a live embedder fails the chat endpoint row and not the provider's (exit ${chatDown.code})`);
  assert(/fix the port in OB1_CHAT_BASE_URL\./.test(fix(chatDown.out, "chat endpoint")) && /fix the port in OB1_LLM_BASE_URL\./.test(fix(refused.out, "provider endpoint")),
         "…and each row's remedy names its own knob (fifth review pass)");
  const hostedChat = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: LOCAL_STUB, OB1_CHAT_BASE_URL: "https://provider.invalid/v1", OB1_CHAT_API_KEY: "k-chat" });
  assert(row(hostedChat.out, "chat endpoint") === "" && /✓\s+provider endpoint/.test(hostedChat.out), "…and a hosted chat endpoint beside a local embedder is not dialled");

  // A proxy in the environment: Bun routes loopback through it too, and so do
  // the server's calls, so the row names the route before the endpoint and the
  // remedy leads with NO_PROXY (fifth review pass: a dead corporate proxy read
  // as "127.0.0.1 refused" with the container remedy).
  const proxied = Bun.serve({ port: 0, fetch: () => Response.json({ object: "list", data: [] }) });
  const PROXIED = `http://127.0.0.1:${proxied.port}/v1`;
  const deadProxy = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: PROXIED, HTTP_PROXY: "http://127.0.0.1:1" });
  assert(deadProxy.code === 1 && /✗\s+provider endpoint\s+nothing answers at http:\/\/127\.0\.0\.1:\d+\/v1 — the connection was refused \(GET \/models, 2\.5 s timeout\); HTTP_PROXY is set, so this call and every one the server makes go through that proxy unless NO_PROXY names 127\.0\.0\.1; the first capture/.test(row(deadProxy.out, "provider endpoint")),
         `a live endpoint behind a dead HTTP_PROXY fails naming the proxy variable (exit ${deadProxy.code})`);
  assert(/→ Add 127\.0\.0\.1 to NO_PROXY \(and no_proxy\) for the server, or unset HTTP_PROXY for it\. Otherwise: Inside a container/.test(fix(deadProxy.out, "provider endpoint")), "…with NO_PROXY first in the remedy, the hostname's remedy after");
  const exempt = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: PROXIED, http_proxy: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1" });
  assert(/✓\s+provider endpoint\s+http:\/\/127\.0\.0\.1:\d+\/v1 answers — HTTP 200/.test(exempt.out) && !/proxy/.test(row(exempt.out, "provider endpoint")), "…and NO_PROXY naming the host passes with no proxy text on the row");
  const httpsProxyOnly = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: PROXIED, HTTPS_PROXY: "http://127.0.0.1:1" });
  assert(/✓\s+provider endpoint\s+http:\/\/127\.0\.0\.1:\d+\/v1 answers — HTTP 200/.test(httpsProxyOnly.out), "…and HTTPS_PROXY alone does not touch an http base");
  proxied.stop(true);

  // Userinfo in the base: fetch never sends it, and the rows must not print
  // it on every start (fifth review pass).
  const seenAuth: (string | null)[] = [];
  const plain = Bun.serve({ port: 0, fetch: (req) => { seenAuth.push(req.headers.get("authorization")); return Response.json({ object: "list", data: [] }); } });
  const withUser = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: `http://user:s3cret-in-url@127.0.0.1:${plain.port}/v1` });
  plain.stop(true);
  assert(!/s3cret-in-url/.test(withUser.out) && /✓\s+provider endpoint\s+http:\/\/\*\*\*@127\.0\.0\.1:\d+\/v1 answers/.test(withUser.out) && /✓\s+model provider\s+http:\/\/\*\*\*@127\.0\.0\.1:\d+\/v1 — embeddings/.test(withUser.out),
         "userinfo in the base URL is masked on the endpoint and provider rows and appears nowhere in the report");
  assert(seenAuth.length === 1 && seenAuth[0] === null, `…and fetch sent no Authorization for it (${JSON.stringify(seenAuth)})`);

  // A listener that accepts and closes with no HTTP — an https port dialled
  // as http is the common shape — is its own wording, without Bun's advice
  // about its verbose option (fifth review pass).
  const closer = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(sock) { sock.end(); }, data() {} } });
  const reset = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: `http://127.0.0.1:${closer.port}/v1` });
  closer.stop(true);
  assert(reset.code === 1 && /✗\s+provider endpoint\s+nothing answers at http:\/\/127\.0\.0\.1:\d+\/v1 — the connection was accepted and closed with no HTTP answer, as an https endpoint dialled as http does \(GET \/models/.test(row(reset.out, "provider endpoint")) && !/verbose: true/.test(reset.out),
         `a listener that closes on accept reads as accepted-and-closed, without Bun's advice (exit ${reset.code}; ${row(reset.out, "provider endpoint").slice(0, 160)})`);

  // TLS: something answered and its certificate was refused. The lead says
  // "answers, but", the remedy is trust, not addresses; under
  // NODE_TLS_REJECT_UNAUTHORIZED=0 it passes as the server's calls would
  // (fifth review pass). The certificate is minted here with openssl; a box
  // without one skips the case rather than passing it.
  const certDir = mkdtempSync(join(tmpdir(), "ob1-preflight-tls-"));
  const minted = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(certDir, "k.pem"), "-out", join(certDir, "c.pem"), "-subj", "/CN=localhost", "-days", "1"], { stdout: "ignore", stderr: "ignore" });
  if (minted.exitCode !== 0) {
    skipRaw("a self-signed TLS endpoint reads as answering with an untrusted certificate", "no openssl to mint a certificate");
    skipRaw("…and passes under NODE_TLS_REJECT_UNAUTHORIZED=0", "no openssl to mint a certificate");
  } else {
    const tlsStub = Bun.serve({ port: 0, tls: { key: Bun.file(join(certDir, "k.pem")), cert: Bun.file(join(certDir, "c.pem")) }, fetch: () => Response.json({ object: "list", data: [] }) });
    const TLS = `https://127.0.0.1:${tlsStub.port}/v1`;
    const untrusted = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: TLS, NODE_TLS_REJECT_UNAUTHORIZED: undefined });
    assert(untrusted.code === 1 && new RegExp(String.raw`✗\s+provider endpoint\s+${rx(TLS)} answers, but its TLS certificate is not trusted \(DEPTH_ZERO_SELF_SIGNED_CERT\) \(GET /models, 2\.5 s timeout\); every capture would fail the same way`).test(row(untrusted.out, "provider endpoint")),
           `a self-signed TLS endpoint reads as answering with an untrusted certificate (exit ${untrusted.code}; ${row(untrusted.out, "provider endpoint").slice(0, 160)})`);
    assert(/→ Serve it over http:\/\/ on the box, or trust its issuer for the server \(NODE_EXTRA_CA_CERTS=<ca\.pem>\); NODE_TLS_REJECT_UNAUTHORIZED=0 disables the check for every call the server makes\./.test(fix(untrusted.out, "provider endpoint")) && !/Inside a container/.test(fix(untrusted.out, "provider endpoint")),
           "…with a trust remedy and not an address one");
    const trusted = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: TLS, NODE_TLS_REJECT_UNAUTHORIZED: "0" });
    assert(new RegExp(String.raw`✓\s+provider endpoint\s+${rx(TLS)} answers — HTTP 200`).test(trusted.out), "…and passes under NODE_TLS_REJECT_UNAUTHORIZED=0");
    tlsStub.stop(true);
  }
  rmSync(certDir, { recursive: true, force: true });

  // The row is in the JSON report too, by name, so a pipeline gate reads it.
  const asJson = await run({ ...DB_DOWN, ...NO_KEYS, OB1_LLM_BASE_URL: "http://127.0.0.1:1/v1" }, "--json");
  const parsed = JSON.parse(asJson.out) as { ok: boolean; checks: { name: string; status: string; fix?: string }[] };
  const jsonRow = parsed.checks.find((c) => c.name === "provider endpoint");
  assert(parsed.ok === false && jsonRow?.status === "fail" && THREE(jsonRow?.fix ?? ""), "--json carries the row, its status and its remedy");
}

console.log("\n[10] The typed-decision tier is dialled when configured — every run, not only --deep (SMD-2050)");
{
  // A stub tier that speaks ob1-jev/1 and counts what reaches it, so "dialled
  // without --deep" and "the refused decision sent nothing" are facts about
  // the requests, not the report.
  const { INSUFFICIENT_EVIDENCE, JEV_CONTRACT } = await import("./jev-contract.ts");
  const MODEL = { name: "verdict-v1.4", source: "https://huggingface.co/o/r", revision: "8af2496eb63c7fa66d7d234e1f62629380030eb4", weights_sha256: "4ae01f82".padEnd(64, "0"), calibrator_sha256: "af2a8769".padEnd(64, "0"), rules: "openjev-engine@00b5ee96#d1c5fb07e514" };
  const seen: string[] = [];
  const stub = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push(`${req.method} ${path}`);
      if (path === "/info") return Response.json({ contract: JEV_CONTRACT, model: MODEL, kinds: ["binary", "choice"], max_options: 24, max_batch: 64, max_tokens: 512 });
      const { decisions } = (await req.json()) as { decisions: { id?: string }[] };
      return Response.json({ contract: JEV_CONTRACT, model: MODEL, ms: 1, results: decisions.map((d) => ({ ...(d.id ? { id: d.id } : {}), kind: "binary", probabilities: { true: 0.6, false: 0.2, [INSUFFICIENT_EVIDENCE]: 0.2 }, selected: "true", abstained: false, p_insufficient: 0.2, p_true: 0.75, logits: [1, 0, 0], temperature: 5.0069, tokens: 30, truncated: false })) });
    },
  });
  const other = Bun.serve({ port: 0, fetch: () => Response.json({ models: [] }) }); // answers, but not the contract
  // Answers every path with a redirect: something is there, and it is not the tier.
  const redirector = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 302, headers: { Location: "http://elsewhere.invalid/" } }) });
  // Answers /info as the tier and fails /decide: the decision row's failure path.
  const halfTier = Bun.serve({
    port: 0,
    fetch: (req) => (new URL(req.url).pathname === "/info"
      ? Response.json({ contract: JEV_CONTRACT, model: MODEL, kinds: ["binary", "choice"], max_options: 24, max_batch: 64, max_tokens: 512 })
      : Response.json({ error: "the model failed" }, { status: 500 })),
  });
  const TIER = `http://127.0.0.1:${stub.port}`;
  const row = (out: string, name: string) => out.split("\n").find((l) => new RegExp(`^\\s*[✓✗!·]\\s+${name}\\s`).test(l)) ?? "";
  const JEV = { OB1_JEV_BASE_URL: undefined, OB1_JEV_MODEL: undefined, OB1_JEV_LOCAL: undefined, OB1_EGRESS_POLICY: undefined, OB1_EGRESS_ALLOW: undefined, OB1_EGRESS_DENY: undefined };

  const off = await run({ ...DB_DOWN, ...NO_KEYS, ...JEV });
  assert(/^\s*·\s+jev tier\s+OB1_JEV_BASE_URL is unset — the typed-decision tier is off/.test(row(off.out, "jev tier")) && row(off.out, "jev egress") === "",
         "unset: one skip row, and no egress row for a tier that is not there");

  seen.length = 0;
  const up = await run({ ...DB_DOWN, ...NO_KEYS, ...JEV, OB1_JEV_BASE_URL: TIER, OB1_JEV_LOCAL: "1" });
  assert(/✓\s+jev tier\s+http:\/\/127\.0\.0\.1:\d+ serves verdict-v1\.4 \(https:\/\/huggingface\.co\/o\/r@8af2496e, weights 4ae01f820000…\) — ob1-jev\/1/.test(row(up.out, "jev tier")),
         `set: the row names the model, its pinned revision and weights (${row(up.out, "jev tier").trim().slice(0, 90)})`);
  assert(JSON.stringify(seen) === JSON.stringify(["GET /info"]), `…dialled without --deep, /info only — no decision, no text (${seen.join(", ")})`);
  assert(/✓\s+jev egress\s+http:\/\/127\.0\.0\.1:\d+ is declared local \(OB1_JEV_LOCAL\) — the decision text stays on the box/.test(up.out), "…and the egress row names the knob that declared it");
  assert(/·\s+jev decision\s+not checked — pass --deep/.test(up.out), "…and the decision probe waits for --deep");

  seen.length = 0;
  const deep = await run({ ...DB_DOWN, ...NO_KEYS, ...JEV, OB1_JEV_BASE_URL: TIER, OB1_JEV_LOCAL: "1" }, "--deep");
  assert(/✓\s+jev decision\s+one binary decision in \d+ ms: p 0\.750, insufficient 0\.200, temperature 5\.0069/.test(deep.out) && seen.includes("POST /decide"),
         "--deep: one decision through the client, its answer read back");

  const dead = await run({ ...DB_DOWN, ...NO_KEYS, ...JEV, OB1_JEV_BASE_URL: "http://127.0.0.1:1", OB1_JEV_LOCAL: "1" }, "--deep");
  assert(/✗\s+jev tier\s+nothing answers at http:\/\/127\.0\.0\.1:1 — the connection was refused \(GET \/info, 2\.5 s timeout\)/.test(dead.out) && /→ Start it — compose --profile jev/.test(dead.out),
         "an unreachable tier fails its row with how to start it — at preflight, not at a spike's first call");
  assert(/·\s+jev decision\s+not checked — the jev tier row failed/.test(dead.out), "…and --deep does not dial a tier that did not answer");

  // SMD-1875's masking rule: userinfo never lands in the log, on the tier row or the egress row.
  const withUser = await run({ ...DB_DOWN, ...NO_KEYS, ...JEV, OB1_JEV_BASE_URL: "http://user:jevsecret@127.0.0.1:1", OB1_JEV_LOCAL: "1" });
  assert(!/jevsecret/.test(withUser.out) && /✗\s+jev tier\s+nothing answers at http:\/\/\*\*\*@127\.0\.0\.1:1/.test(withUser.out), "a base with userinfo is shown masked, never in the clear");
  const unknown = await run({ ...DB_DOWN, ...NO_KEYS, ...JEV, OB1_JEV_BASE_URL: "http://jev-not-a-host.invalid:8020", OB1_JEV_LOCAL: "1" });
  assert(/✗\s+jev tier\s+nothing answers at http:\/\/jev-not-a-host\.invalid:8020 — the name does not resolve/.test(unknown.out), "a name that does not resolve says so, resolved before it is dialled");
  // Something answers, not as the tier; the base's userinfo stays masked in
  // the client's own words too (the fifth review pass's mutant: dropping
  // masked() passed every case before these).
  const redirected = await run({ ...DB_DOWN, ...NO_KEYS, ...JEV, OB1_JEV_BASE_URL: `http://user:jevsecret@127.0.0.1:${redirector.port}`, OB1_JEV_LOCAL: "1" });
  assert(!/jevsecret/.test(redirected.out) && /✗\s+jev tier\s+http:\/\/\*\*\*@127\.0\.0\.1:\d+ answers, but not as the tier: Info request to http:\/\/\*\*\*@.*302 redirecting to http:\/\/elsewhere\.invalid\//.test(redirected.out) && /→ Check OB1_JEV_BASE_URL is the tier's base with no path/.test(redirected.out),
         "a redirect is an answer that is not the tier: named, its Location shown, userinfo masked, the base's path the remedy");
  const halfway = await run({ ...DB_DOWN, ...NO_KEYS, ...JEV, OB1_JEV_BASE_URL: `http://user:jevsecret@127.0.0.1:${halfTier.port}`, OB1_JEV_LOCAL: "1" }, "--deep");
  assert(!/jevsecret/.test(halfway.out) && /✗\s+jev decision\s+Decision request to http:\/\/\*\*\*@127\.0\.0\.1:\d+\/decide failed: 500/.test(halfway.out), "a /decide that fails is the decision row's, userinfo masked");
  const pathed = await run({ ...DB_DOWN, ...NO_KEYS, ...JEV, OB1_JEV_BASE_URL: `${TIER}/v1`, OB1_JEV_LOCAL: "1" });
  assert(/✗\s+jev tier\s+http:\/\/127\.0\.0\.1:\d+\/v1 answers, but not as the tier/.test(pathed.out), "a base with Ollama's /v1 on it answers, but not as the tier");
  const proxied = await run({ ...DB_DOWN, ...NO_KEYS, ...JEV, OB1_JEV_BASE_URL: TIER, OB1_JEV_LOCAL: "1", HTTP_PROXY: "http://127.0.0.1:9", http_proxy: undefined, NO_PROXY: undefined, no_proxy: undefined });
  assert(/✗\s+jev tier\s+.*HTTP_PROXY is set, so this call goes through that proxy unless NO_PROXY names 127\.0\.0\.1/.test(proxied.out) && /→ Add 127\.0\.0\.1 to NO_PROXY/.test(proxied.out), "a proxy variable in the way is named, with NO_PROXY as the fix");
  const stopped = await run({ ...DB_DOWN, ...NO_KEYS, ...JEV, OB1_JEV_BASE_URL: "http://jev:8020", OB1_JEV_LOCAL: "1" });
  assert(/→ The jev service is not running: bring the profile up — compose --profile jev up -d \(compose restart server does not start it\)/.test(stopped.out), "the stack's own service unresolved: not running, and restart server does not start it");
  // A proxy that answers — with an error status — is an answer not from the
  // tier, and the row still names the proxy as the route.
  const badProxy = Bun.serve({ port: 0, fetch: () => new Response("bad gateway", { status: 502 }) });
  const viaBadProxy = await run({ ...DB_DOWN, ...NO_KEYS, ...JEV, OB1_JEV_BASE_URL: TIER, OB1_JEV_LOCAL: "1", HTTP_PROXY: `http://127.0.0.1:${badProxy.port}`, http_proxy: undefined, NO_PROXY: undefined, no_proxy: undefined });
  badProxy.stop();
  assert(/✗\s+jev tier\s+.* answers, but not as the tier: Info request .*502.*; HTTP_PROXY is set, so this call goes through that proxy/.test(viaBadProxy.out), "an error status through a proxy is not the tier's, and the proxy is named as the route");
  // NO_PROXY exempts the host by Bun's rule — the host, `*`, host:port — and
  // the call goes direct: a live tier behind a proxy that answers only 502
  // passes, which it cannot through the proxy (seventh review pass: the
  // earlier case could not tell a direct dial from a proxied one).
  const exemptProxy = Bun.serve({ port: 0, fetch: () => new Response("bad gateway", { status: 502 }) });
  for (const noProxy of ["127.0.0.1", "*", `127.0.0.1:${stub.port}`, "localhost,127.0.0.1"]) {
    const exempted = await run({ ...DB_DOWN, ...NO_KEYS, ...JEV, OB1_JEV_BASE_URL: TIER, OB1_JEV_LOCAL: "1", HTTP_PROXY: `http://127.0.0.1:${exemptProxy.port}`, http_proxy: undefined, NO_PROXY: noProxy, no_proxy: undefined });
    assert(/✓\s+jev tier\s+http:\/\/127\.0\.0\.1:\d+ serves verdict-v1\.4/.test(exempted.out) && !/HTTP_PROXY is set/.test(exempted.out), `NO_PROXY=${noProxy}: the tier is dialled direct past the proxy, and the row does not blame it`);
  }
  // …and where the exemption shows: a refused exempt host is not blamed on the
  // proxy (the ✓ rows above carry no proxy wording to test). The suffix
  // spelling (`.internal`) needs a resolvable subdomain and is not driven here.
  for (const noProxy of ["127.0.0.1", "*", "127.0.0.1:1"]) {
    const refused = await run({ ...DB_DOWN, ...NO_KEYS, ...JEV, OB1_JEV_BASE_URL: "http://127.0.0.1:1", OB1_JEV_LOCAL: "1", HTTP_PROXY: `http://127.0.0.1:${exemptProxy.port}`, http_proxy: undefined, NO_PROXY: noProxy, no_proxy: undefined });
    assert(/✗\s+jev tier\s+nothing answers at http:\/\/127\.0\.0\.1:1 — the connection was refused/.test(refused.out) && !/HTTP_PROXY is set/.test(refused.out) && !/Add 127\.0\.0\.1 to NO_PROXY/.test(refused.out),
           `NO_PROXY=${noProxy}: a refused exempt host is not blamed on the proxy`);
  }
  // A port that is not the tier's does not exempt it: the call goes through the proxy, which answers 502.
  const wrongPort = await run({ ...DB_DOWN, ...NO_KEYS, ...JEV, OB1_JEV_BASE_URL: TIER, OB1_JEV_LOCAL: "1", HTTP_PROXY: `http://127.0.0.1:${exemptProxy.port}`, http_proxy: undefined, NO_PROXY: "127.0.0.1:1", no_proxy: undefined });
  exemptProxy.stop();
  assert(/✗\s+jev tier\s+.*502.*HTTP_PROXY is set/.test(wrongPort.out), "NO_PROXY=host:another-port does not exempt it, and the proxy is named");
  // An /info that names the contract and lacks its fields answers, but not as the tier.
  const partial = Bun.serve({ port: 0, fetch: () => Response.json({ contract: JEV_CONTRACT }) });
  const partialRun = await run({ ...DB_DOWN, ...NO_KEYS, ...JEV, OB1_JEV_BASE_URL: `http://127.0.0.1:${partial.port}`, OB1_JEV_LOCAL: "1" });
  partial.stop();
  assert(/✗\s+jev tier\s+http:\/\/127\.0\.0\.1:\d+ answers, but not as the tier: .*lacks model, kinds, max_options/.test(partialRun.out), "an /info with the contract's name and not its fields is not the tier, not a crash");
  // A certificate the runtime does not trust: something answers; the tier serves plain http.
  const jevCerts = mkdtempSync(join(tmpdir(), "ob1-preflight-jev-tls-"));
  const jevMinted = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(jevCerts, "k.pem"), "-out", join(jevCerts, "c.pem"), "-subj", "/CN=localhost", "-days", "1"], { stdout: "ignore", stderr: "ignore" });
  if (jevMinted.exitCode !== 0) {
    skipRaw("an https tier with an untrusted certificate answers, and the fix is http://", "no openssl to mint a certificate");
  } else {
    const tlsTier = Bun.serve({ port: 0, tls: { key: Bun.file(join(jevCerts, "k.pem")), cert: Bun.file(join(jevCerts, "c.pem")) }, fetch: () => Response.json({}) });
    const tls = await run({ ...DB_DOWN, ...NO_KEYS, ...JEV, OB1_JEV_BASE_URL: `https://127.0.0.1:${tlsTier.port}`, OB1_JEV_LOCAL: "1", NODE_TLS_REJECT_UNAUTHORIZED: undefined });
    tlsTier.stop(true);
    assert(/✗\s+jev tier\s+https:\/\/127\.0\.0\.1:\d+ answers, but its TLS certificate is not trusted/.test(tls.out) && /→ The tier serves plain http: use http:\/\/ in OB1_JEV_BASE_URL/.test(tls.out),
           "an https tier with an untrusted certificate answers, and the fix is http://");
  }
  rmSync(jevCerts, { recursive: true, force: true });
  redirector.stop();
  halfTier.stop();
  const wrongModel = await run({ ...DB_DOWN, ...NO_KEYS, ...JEV, OB1_JEV_BASE_URL: TIER, OB1_JEV_LOCAL: "1", OB1_JEV_MODEL: "semif" });
  assert(/✗\s+jev tier\s+.* serves verdict-v1\.4 .*, and OB1_JEV_MODEL expects semif/.test(wrongModel.out) && /→ Point OB1_JEV_BASE_URL at the tier serving semif, or set OB1_JEV_MODEL=verdict-v1\.4\./.test(wrongModel.out),
         "a tier serving another model than OB1_JEV_MODEL fails, naming both");

  const notJev = await run({ ...DB_DOWN, ...NO_KEYS, ...JEV, OB1_JEV_BASE_URL: `http://127.0.0.1:${other.port}`, OB1_JEV_LOCAL: "1" });
  assert(/✗\s+jev tier\s+.*speaks undefined, not ob1-jev\/1/.test(notJev.out), "a URL that answers but is not the tier (an Ollama, say) fails as not the contract");

  seen.length = 0;
  const undeclared = await run({ ...DB_DOWN, ...NO_KEYS, ...JEV, OB1_JEV_BASE_URL: TIER }, "--deep");
  assert(/!\s+jev egress\s+http:\/\/127\.0\.0\.1:\d+ looks local but is not declared so/.test(undeclared.out) && /→ Set OB1_JEV_LOCAL=1 if this endpoint is on this machine/.test(undeclared.out),
         "undeclared: the egress row warns with OB1_JEV_LOCAL as the fix");
  assert(/!\s+jev decision\s+Decision request to .* refused by the egress gate/.test(undeclared.out) && !seen.includes("POST /decide"),
         `…and the --deep decision is refused by the gate before it is sent (${seen.join(", ")})`);
  stub.stop();
  other.stop();
}

localStub.stop(true);
report();
