#!/usr/bin/env bun
/**
 * _write-path-arm.ts — one arm of the write-path eval, one process
 * (Linear SMD-1713). Spawned by eval-write-path.ts.
 *
 * Separate because the server snapshots its environment at boot and holds a
 * connection pool whose cached plans do not survive the schema being dropped
 * under them, so each arm gets a fresh schema, a fresh server and a fresh
 * stub provider. The arm and the reader policy arrive in the environment:
 *
 *   OB1_WP_ARM     default | -supersedes | -judge | -actor
 *   OB1_WP_READER  labels | blind
 *
 * What it does, in order: reset the schema (every migration, at the stub's
 * width); start the scripted provider (`/embeddings` and `/chat/completions`,
 * the rules in write-path.ts); boot the real server in-process with two write
 * keys; classify the keys in 046's registry (the actor arm); capture every
 * session's items through `capture_thought` under the writer's key, the
 * newer decision naming the older with `supersedes` (the supersedes arm); run
 * `db/extract-entities.ts` then `db/consolidate.ts` as children against the
 * stub (the judge arm); then, as the reader, search each deliverable's
 * subjects, read the pending proposals, apply the policy, and capture each
 * deliverable with `derived_from` naming the ids it used. Prints one line,
 * `RESULT <json>`, the Observation write-path.ts scores, and one
 * `SUMMARY …` line of the arm's cost on stderr.
 *
 * One coupling between arms, stated: 029 keeps a superseded thought out of
 * the judge's pool and its candidates, so the -supersedes arm also hands
 * the judge the three stale decisions to pair. `corpusProblems` keeps that
 * inert by rule — no item on a subject with a decision carries a digit — so
 * the arm still measures the pointer alone; a corpus that broke the rule
 * would credit the judge's work to the pointer.
 *
 * The parent's environment is not trusted: every knob the server, the
 * egress gate or the workers read is set or removed below, so a shell that
 * exports a dogfood key or policy (OB1_WORKER_KEY, OB1_EGRESS_POLICY) does
 * not change the number or fail the gate.
 */

import { SQL } from "bun";
import { join } from "node:path";
import { resetSchema } from "../db/test-support.ts";
import { hashKey } from "../server-portable/auth.ts";
import { mcpClient } from "../server-portable/test-support.ts";
import { DELIVERABLES, READER_K, SESSIONS, SUBJECTS, type SubjectKey } from "./write-path-corpus.ts";
import {
  ARMS, STUB_DIM, decide, parseCapturedId, parseHits, parseProposalIds, renderDeliverable, stubChat, vectorFor,
  type Arm, type DeliverableObservation, type Line, type Observation, type ReaderPolicy,
} from "./write-path.ts";

const t0 = Date.now();
const URL_ = process.env.DATABASE_URL;
if (!URL_) { console.error("DATABASE_URL is not set."); process.exit(2); }
const ARM = (process.env.OB1_WP_ARM ?? "default") as Arm;
if (!(ARMS as readonly string[]).includes(ARM)) { console.error(`OB1_WP_ARM must be one of ${ARMS.join(", ")}, not "${ARM}"`); process.exit(2); }
const READER = (process.env.OB1_WP_READER ?? "labels") as ReaderPolicy;
if (READER !== "labels" && READER !== "blind") { console.error(`OB1_WP_READER must be labels or blind, not "${READER}"`); process.exit(2); }
const on = (m: "supersedes" | "judge" | "actor"): boolean => ARM !== `-${m}`;

const EMBED_MODEL = "write-path-stub";
const META_MODEL = "write-path-stub-chat";
const HERE = import.meta.dir;

await resetSchema(URL_, { dim: STUB_DIM, model: EMBED_MODEL });

// ── The scripted provider ───────────────────────────────────────────────────

let embedCalls = 0, chatCalls = 0;
const provider = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const body = (await req.json()) as Record<string, unknown>;
    if (url.pathname.endsWith("/embeddings")) {
      embedCalls++;
      const inputs = Array.isArray(body.input) ? (body.input as string[]) : [String(body.input ?? "")];
      return Response.json({ data: inputs.map((text, index) => ({ index, embedding: vectorFor(text, STUB_DIM) })), model: body.model });
    }
    if (url.pathname.endsWith("/chat/completions")) {
      chatCalls++;
      const messages = (body.messages ?? []) as { role: string; content: string }[];
      return Response.json({ choices: [{ message: { role: "assistant", content: stubChat(messages) } }], model: body.model });
    }
    return new Response("not found", { status: 404 });
  },
});
const PROVIDER = `http://127.0.0.1:${provider.port}/v1`;

// ── The real server, in-process ─────────────────────────────────────────────

const OP_RAW = "op-raw", BOT_RAW = "bot-raw";
process.env.DATABASE_URL = URL_;
delete process.env.OB1_STORE;
process.env.OB1_LLM_BASE_URL = PROVIDER;
process.env.OB1_LLM_LOCAL = "1"; // the egress gate (SMD-1903): a provider on this box
process.env.OB1_EMBEDDING_MODEL = EMBED_MODEL;
process.env.OB1_EMBEDDING_DIM = String(STUB_DIM);
process.env.OB1_METADATA_MODEL = META_MODEL;
process.env.OB1_LLM_TIMEOUT = "10";
process.env.MCP_ACCESS_KEYS = `op-key:write:${hashKey(OP_RAW)},bot-key:write:${hashKey(BOT_RAW)}`;
process.env.OB1_AGENT_CACHE_TTL_MS = "0";
for (const k of [
  "MCP_ACCESS_KEY", "OPENROUTER_API_KEY", "OB1_LLM_API_KEY", "OB1_CHAT_BASE_URL", "OB1_CHAT_API_KEY", "OB1_CHAT_LOCAL", "OB1_JUDGE_MODEL",
  "OB1_QUERY_LOG", "OB1_TIER", "OB1_EGRESS_POLICY", "OB1_EGRESS_ALLOW", "OB1_EGRESS_DENY", "OB1_WORKER_KEY", "OB1_EMBEDDING_DIMENSIONS",
  "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
]) delete process.env[k];

const worker = (await import("../server-portable/index.ts")).default as { fetch: (r: Request) => Response | Promise<Response> };
const server = Bun.serve({ port: 0, fetch: worker.fetch });
const BASE = `http://localhost:${server.port ?? 0}`;
const asOp = mcpClient(BASE, OP_RAW);
const asBot = mcpClient(BASE, BOT_RAW);

const sql = new SQL({ url: URL_, max: 1 });

// The actor arm: the two keys classified in 046's registry, before their first
// write, so every row they write carries `By:` (050). Off: never classified,
// so a hit reads "kind not classified" and the reader has no kind to act on.
if (on("actor")) {
  await sql`SELECT set_agent_kind('op-key', 'operator')`;
  await sql`SELECT set_agent_kind('bot-key', 'agent')`;
}

// ── The sessions ────────────────────────────────────────────────────────────

const idOf: Record<string, string> = {};
for (const [day, session] of SESSIONS.entries()) {
  const captured: string[] = [];
  for (const item of session.items) {
    const client = item.writer === "op" ? asOp : asBot;
    const args: Record<string, unknown> = { content: item.text };
    // The supersedes arm: the newer decision names the older one. Off: the
    // pointer is never written, and the read has nothing to label.
    if (on("supersedes") && item.supersedes) {
      const older = idOf[item.supersedes];
      if (!older) throw new Error(`${item.id} supersedes ${item.supersedes}, which has not been captured`);
      args.supersedes = older;
    }
    idOf[item.id] = parseCapturedId(await client.call("capture_thought", args));
    captured.push(idOf[item.id]);
  }
  // A session is a day. The corpus is twenty sessions and the run takes a
  // second, so the rows are dated by hand, one calendar day apart, as the
  // sessions would have been: 029's candidate rule pairs a thought only with
  // one captured at least a calendar day (UTC) earlier, and the judge's
  // prompt shows the dates. The text is not touched, so 050's mark stays
  // (the rule it holds), and the deliverables keep today's date, after all.
  const iso = new Date(Date.UTC(2026, 0, 1 + day, 12)).toISOString();
  await sql`UPDATE thoughts SET created_at = ${iso}::timestamptz WHERE id = ANY(${sql.array(captured, "TEXT")}::uuid[])`;
}

// ── The workers (the judge arm) ─────────────────────────────────────────────

let extracted = 0;
async function runWorker(script: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["bun", join(HERE, "..", "db", script), "--url", URL_!, ...args], {
    env: {
      ...process.env,
      OB1_LLM_BASE_URL: PROVIDER,
      OB1_LLM_LOCAL: "1",
      OB1_METADATA_MODEL: META_MODEL,
      OB1_LLM_TIMEOUT: "10",
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${script} exited ${code}:\n${err.slice(-1500)}\n${out.slice(-800)}`);
  if (process.env.OB1_WP_VERBOSE) console.error(`── ${script} ──\n${out}\n${err}`);
  return out;
}
if (on("judge")) {
  await runWorker("extract-entities.ts", ["--workers", "1"]);
  extracted = Number((await sql`SELECT count(DISTINCT thought_id)::int AS n FROM thought_entities`)[0].n);
  // At the shipped candidate count: the number is the shipped pass's, and
  // corpusProblems holds that no slip has more earlier neighbours than that.
  await runWorker("consolidate.ts", ["--workers", "1"]);
}

// ── The reader ──────────────────────────────────────────────────────────────

const hits: Partial<Record<SubjectKey, string[]>> = {};
const decided: Partial<Record<SubjectKey, Line[]>> = {};
const proposals = parseProposalIds(await asOp.call("list_supersession_proposals", { limit: 200 }));
// Every search first, every deliverable after: a deliverable is a thought too,
// and one captured early would be a hit for the next deliverable's subjects.
for (const spec of DELIVERABLES) {
  for (const k of spec.subjects) {
    const reply = await asOp.call("search_thoughts", { query: SUBJECTS[k], limit: READER_K });
    const parsed = /^No thoughts found/.test(reply) ? [] : parseHits(reply);
    hits[k] = parsed.map((h) => h.id);
    decided[k] = decide(parsed, proposals, READER);
  }
}

const deliverables: DeliverableObservation[] = [];
for (const spec of DELIVERABLES) {
  const lines = spec.subjects.flatMap((k) => (decided[k] ?? []).map((l) => ({ ...l, subject: k })));
  const content = renderDeliverable(spec, decided);
  const derived = [...new Set(lines.map((l) => l.id))];
  const reply = await asOp.call("capture_thought", { content, derived_from: derived, source: "write-path-eval" });
  const thoughtId = parseCapturedId(reply);
  const [row] = (await sql`SELECT derived_from, length(content)::int AS chars FROM thoughts WHERE id = ${thoughtId}::uuid`) as { derived_from: string[] | null; chars: number }[];
  deliverables.push({ title: spec.title, subjects: spec.subjects, lines, thoughtId, derivedFrom: row?.derived_from ?? [], chars: row?.chars ?? content.length });
}

const [{ pending }] = (await sql`SELECT count(*)::int AS pending FROM supersession_proposals WHERE status = 'pending'`) as { pending: number }[];

const observation: Observation = {
  arm: ARM, reader: READER, idOf, hits, deliverables,
  pendingProposals: Number(pending), extracted, ms: Date.now() - t0,
};
console.log(`RESULT ${JSON.stringify(observation)}`);
console.error(`SUMMARY ${ARM} / ${READER}: ${embedCalls} embedding calls, ${chatCalls} chat calls, ${extracted} thoughts extracted, ${pending} pending proposals, ${Date.now() - t0} ms`);

await sql.close();
server.stop(true);
provider.stop(true);
process.exit(0);
