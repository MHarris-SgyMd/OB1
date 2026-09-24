#!/usr/bin/env bun
/**
 * serve.ts — the typed-decision tier's serving process (SMD-2050).
 *
 * One model — Verdict v1.4 (verdict.ts) — behind the contract in
 * server-portable/jev-contract.ts, on onnxruntime-node's CPU provider under
 * Bun. It is not an Ollama model and not a chat endpoint: it reads option
 * logits in one forward pass, which Ollama's API does not expose. It is its
 * own process, so Ollama's scheduler (OLLAMA_MAX_LOADED_MODELS) neither
 * counts it nor evicts it; what it costs beside the embedder and the metadata
 * model is jev/README.md's measured footprint.
 *
 *   bun jev/serve.ts                # fetch-or-verify the pinned files, then serve on 127.0.0.1:8020
 *   bun jev/serve.ts --fetch-only   # fetch-or-verify and exit (pre-pull)
 *   bun jev/serve.ts --no-fetch     # refuse to start unless the files are already there
 *
 * Its knobs are its own, not the brain's (the brain's are OB1_JEV_BASE_URL,
 * OB1_JEV_MODEL and OB1_JEV_LOCAL — where to reach it, what to expect, and
 * that it is on this box):
 *
 *   JEV_HOST       127.0.0.1 — the compose service sets 0.0.0.0 inside its network
 *   JEV_PORT       8020
 *   JEV_MODEL_DIR  ~/.cache/ob1-jev/<revision> — the compose service mounts a volume
 *   JEV_THREADS    4 — onnxruntime's intra-op threads
 *   JEV_HUB        https://huggingface.co — where the pinned files are fetched from
 *
 * The API is unauthenticated, like Ollama's: it binds loopback unless told
 * otherwise, and compose publishes nothing (deploy/compose.yaml).
 */

import { homedir } from "node:os";
import { JEV_CONTRACT, jevRequestProblem, type JevRequest, type JevResponse } from "../server-portable/jev-contract.ts";
import { DEFAULT_HUB, ensureModel } from "./fetch-model.ts";
import { createVerdictEngine, VERDICT, type Engine } from "./verdict.ts";

/** A request body larger than this is refused before it is read: 64 decisions of 20k characters with room to spare. */
export const MAX_BODY_BYTES = 2 * 2 ** 20;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const ROUTES: Record<string, string> = { "/health": "GET", "/info": "GET", "/decide": "POST" };

/**
 * The fetch handler over an engine. Decisions run one request at a time — the
 * model's threads are the parallelism, and two interleaved requests would each
 * take twice as long — in arrival order.
 */
export function createHandler(engine: Engine): (req: Request) => Promise<Response> {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };
  return async (req) => {
    const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
    const method = ROUTES[path];
    if (!method) return json(404, { error: `no route ${path}; the tier serves ${Object.keys(ROUTES).join(", ")}` });
    if (req.method !== method) return json(405, { error: `${path} takes ${method}` }, { Allow: method });
    if (path === "/health") return new Response("ok");
    if (path === "/info") return json(200, engine.info);

    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) return json(413, { error: `the body is ${declared} bytes; at most ${MAX_BODY_BYTES}` });
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { error: `the body is over ${MAX_BODY_BYTES} bytes` });
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: "the body is not JSON" });
    }
    const problem = jevRequestProblem(body);
    if (problem) return json(400, { error: problem });
    const request = body as JevRequest;
    if (request.model !== undefined && request.model !== engine.info.model.name) {
      return json(409, { error: `this service serves ${engine.info.model.name}, not ${request.model}` });
    }
    const t0 = performance.now();
    try {
      const results = await serial(() => engine.decide(request.decisions));
      const response: JevResponse = { contract: JEV_CONTRACT, model: engine.info.model, results, ms: performance.now() - t0 };
      return json(200, response);
    } catch (e) {
      return json(500, { error: `the model failed: ${(e as Error).message}` });
    }
  };
}

/** A positive whole number from a knob, or the fallback; anything else is a start-up refusal. */
function intKnob(name: string, fallback: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    console.error(`${name}=${raw} is not a whole number from 1 to ${max}`);
    process.exit(2);
  }
  return n;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--fetch-only" && a !== "--no-fetch");
  if (unknown.length) {
    console.error(`unknown argument ${unknown.join(" ")} — serve.ts takes --fetch-only or --no-fetch`);
    process.exit(2);
  }
  const host = process.env.JEV_HOST?.trim() || "127.0.0.1";
  const port = intKnob("JEV_PORT", 8020, 65_535);
  const threads = intKnob("JEV_THREADS", 4, 256);
  const dir = (process.env.JEV_MODEL_DIR?.trim() || `${homedir()}/.cache/ob1-jev/${VERDICT.revision}`).replace(/\/+$/, "");
  const log = (line: string) => console.log(`jev: ${line}`);
  try {
    const got = await ensureModel(dir, { hub: process.env.JEV_HUB?.trim() || DEFAULT_HUB, fetch: !args.includes("--no-fetch"), log });
    log(`${VERDICT.repo}@${VERDICT.revision.slice(0, 8)} in ${dir}: ${got.fetched.length ? `fetched ${got.fetched.join(", ")}; ` : ""}every file matches its pin (${got.ms.toFixed(0)} ms)`);
  } catch (e) {
    console.error(`jev: ${(e as Error).message}`);
    process.exit(1);
  }
  if (args.includes("--fetch-only")) process.exit(0);
  const t0 = performance.now();
  const engine = await createVerdictEngine(dir, { threads });
  const server = Bun.serve({
    hostname: host,
    port,
    // A queued request waits for the ones ahead of it; Bun's 10 s default
    // would close a connection that is only waiting its turn.
    idleTimeout: 120,
    fetch: createHandler(engine),
  });
  log(`${VERDICT.name} loaded in ${(performance.now() - t0).toFixed(0)} ms (${threads} threads, rss ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MB); serving ${JEV_CONTRACT} on http://${host}:${server.port}`);
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      server.stop();
      process.exit(0);
    });
  }
}
