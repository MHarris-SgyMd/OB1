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
 *   JEV_HOST       127.0.0.1 — the image (jev/Dockerfile) sets 0.0.0.0 inside the compose network
 *   JEV_PORT       8020
 *   JEV_MODEL_DIR  ~/.cache/ob1-jev/<revision> — the compose service mounts a volume
 *   JEV_THREADS    4 — onnxruntime's intra-op threads
 *   JEV_HUB        https://huggingface.co — where the pinned files are fetched from
 *
 * The API is unauthenticated, like Ollama's: it binds loopback unless told
 * otherwise, and compose publishes nothing (deploy/compose.yaml).
 *
 * Serving, nothing at start exits on its own (SMD-3214): the compose service
 * is `restart: unless-stopped`, so it comes back after a reboot — the
 * servers' preflight fails while a configured tier is down (SMD-2834) — and
 * an exit would be restarted at once, with no backoff, in a loop. A fetch
 * that fails or hashes wrong, an engine that does not load and a port taken
 * are tried again after 1, 2, 4, 8, then every 15 minutes (RETRY_MS, as
 * db/supervise.ts's clock), each failure said; a bad JEV_PORT or JEV_THREADS,
 * which nothing mends without a recreate, holds until the service is
 * stopped. --fetch-only is a one-shot still: it exits 1 on a failed fetch
 * and 2 on a bad knob, so `serve.ts --fetch-only && …` stops there.
 */

import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { JEV_CONTRACT, JEV_MAX_BODY_BYTES, jevRequestProblem, type JevRequest, type JevResponse } from "../server-portable/jev-contract.ts";
import { DEFAULT_HUB, ensureModel, openParts } from "./fetch-model.ts";
import { CallerGone, createVerdictEngine, DecisionRefused, VERDICT, type Engine } from "./verdict.ts";

/**
 * The body as text, or null past `max` bytes — counted as they arrive, so a
 * chunked request with no Content-Length is refused at the cap rather than
 * read whole first (first review pass: req.text() read up to Bun's 128 MB).
 */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req.body) {
    total += chunk.byteLength;
    if (total > max) return null;
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const ROUTES: Record<string, string> = { "/health": "GET", "/info": "GET", "/decide": "POST" };

/**
 * The fetch handler over an engine. Decisions run one request at a time — the
 * model's threads are the parallelism, and two interleaved requests would each
 * take twice as long — in arrival order. A request whose caller has gone by
 * the time its turn comes (its deadline passed, it hung up) is skipped, not
 * computed for no one (first review pass: ten abandoned requests still ran
 * ten times ahead of everyone behind them); one whose caller goes mid-batch
 * stops between forward passes (CallerGone, fifth review pass). Both answer
 * 499. The queue itself is unbounded — SMD-2082 bounds it.
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
    // HEAD is GET without the body, for a probe that asks it (Bun drops the body).
    if (req.method !== method && !(method === "GET" && req.method === "HEAD")) return json(405, { error: `${path} takes ${method}` }, { Allow: method === "GET" ? "GET, HEAD" : method });
    if (path === "/health") return new Response("ok");
    if (path === "/info") return json(200, engine.info);

    const declared = Number(req.headers.get("content-length") ?? "0");
    // The contract's cap, which the client packs its requests under.
    if (declared > JEV_MAX_BODY_BYTES) return json(413, { error: `the body is ${declared} bytes; at most ${JEV_MAX_BODY_BYTES}` });
    const raw = await readCapped(req, JEV_MAX_BODY_BYTES);
    if (raw === null) return json(413, { error: `the body is over ${JEV_MAX_BODY_BYTES} bytes` });
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
      const results = await serial(async () => (req.signal.aborted ? null : engine.decide(request.decisions, req.signal)));
      // 499, nginx's "client closed request": there is no one to read it.
      if (results === null) return json(499, { error: "the caller went away before its turn; nothing was computed" });
      const response: JevResponse = { contract: JEV_CONTRACT, model: engine.info.model, results, ms: performance.now() - t0 };
      return json(200, response);
    } catch (e) {
      if (e instanceof DecisionRefused) return json(422, { error: e.message });
      if (e instanceof CallerGone) return json(499, { error: e.message });
      return json(500, { error: `the model failed: ${(e as Error).message}` });
    }
  };
}

/** A positive whole number from a knob, or the fallback; anything else is a start-up refusal, its words returned. */
export function intKnob(name: string, fallback: number, max: number, env: Record<string, string | undefined> = process.env): number | { error: string } {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  // Digits only: Number() also reads 0x1f, 1e3 and 8020.0 (third review pass).
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > max) return { error: `${name}=${raw} is not a whole number from 1 to ${max}` };
  return n;
}

/** The waits between failed starts: the first, and the cap it doubles to — db/supervise.ts's clock (SMD-3214). */
export const RETRY_MS = { first: 60_000, max: 900_000 } as const;

/** The wait after `tries` failed starts in a row (1 for the first). */
export function retryWait(tries: number, waits: { first: number; max: number } = RETRY_MS): number {
  return Math.min(waits.max, waits.first * 2 ** Math.min(Math.max(0, tries - 1), 30));
}

/**
 * `attempt` until it resolves, waiting retryWait after each failure, each
 * failure said once with when it is tried again (SMD-3214). A stop is the
 * signal handler's, which exits the process wherever this stands; a caller
 * that needs one sooner passes `sleep`.
 */
export async function untilReady<T>(attempt: () => Promise<T>, opts: { err: (line: string) => void; waits?: { first: number; max: number }; sleep?: (ms: number) => Promise<void> }): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  for (let tries = 1; ; tries++) {
    try {
      return await attempt();
    } catch (e) {
      const waitMs = retryWait(tries, opts.waits);
      opts.err(`jev: ${(e as Error).message}`);
      opts.err(`jev: not serving — tried again in ${waitMs < 120_000 ? `${Math.round(waitMs / 1000)} s` : `${Math.round(waitMs / 60_000)} min`} (failure ${tries} in a row), then every 15 min at most; the healthcheck reads unhealthy meanwhile, and a stop ends it (SMD-3214)`);
      await sleep(waitMs);
    }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--fetch-only" && a !== "--no-fetch");
  if (unknown.length) {
    console.error(`unknown argument ${unknown.join(" ")} — serve.ts takes --fetch-only or --no-fetch`);
    process.exit(2);
  }
  const host = process.env.JEV_HOST?.trim() || "127.0.0.1";
  const fetchOnly = args.includes("--fetch-only");
  const portKnob = intKnob("JEV_PORT", 8020, 65_535);
  const threadsKnob = intKnob("JEV_THREADS", 4, 256);
  const dir = (process.env.JEV_MODEL_DIR?.trim() || `${homedir()}/.cache/ob1-jev/${VERDICT.revision}`).replace(/\/+$/, "");
  const log = (line: string) => console.log(`jev: ${line}`);
  // Before the fetch and the load, not after: as a container's PID 1 the
  // process has no default SIGTERM action, so a stop during the 20 s fetch
  // waited out the grace period and was killed (first review pass). A stop
  // while serving is the ordinary end, 0; one before the service ever served
  // is an interruption, 128 + the signal, so `serve.ts --fetch-only && …`
  // does not carry on with nothing fetched (second review pass).
  let server: ReturnType<typeof Bun.serve> | undefined;
  for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
    process.on(sig, () => {
      for (const part of openParts) rmSync(part, { force: true });
      if (!server) process.exit(code);
      server.stop();
      process.exit(0);
    });
  }
  // A knob that is not a number: --fetch-only exits 2, as it always did; the
  // service holds, idle, until it is stopped — nothing changes it short of a
  // recreate, and an exit would be restarted in a loop (SMD-3214).
  const knobError = [portKnob, threadsKnob].find((k): k is { error: string } => typeof k !== "number");
  if (knobError) {
    console.error(knobError.error);
    if (fetchOnly) process.exit(2);
    console.error("jev: held, not serving — set it in deploy/.env and recreate the service; a stop ends it (SMD-3214)");
    // The handlers above end it; the timer keeps the process waiting for them.
    setInterval(() => {}, 2 ** 30);
    await new Promise<never>(() => {});
  }
  const port = portKnob as number;
  const threads = threadsKnob as number;
  const fetchModel = async () => {
    const got = await ensureModel(dir, { hub: process.env.JEV_HUB?.trim() || DEFAULT_HUB, fetch: !args.includes("--no-fetch"), log });
    log(`${VERDICT.repo}@${VERDICT.revision.slice(0, 8)} in ${dir}: ${got.fetched.length ? `fetched ${got.fetched.join(", ")}; ` : ""}every file matches its pin (${got.ms.toFixed(0)} ms)`);
  };
  if (fetchOnly) {
    try {
      await fetchModel();
    } catch (e) {
      console.error(`jev: ${(e as Error).message}`);
      process.exit(1);
    }
    process.exit(0);
  }
  // The files, the engine and the port, tried again until all three hold.
  // Until the engine loads, each try verifies the files afresh, so a part a
  // failed fetch left is removed and a file replaced since is read as it now
  // is; once loaded it is kept — about 1 GB resident — and only the port is
  // tried again (SMD-3214).
  let engine: Engine | undefined;
  await untilReady(async () => {
    const t0 = performance.now();
    if (!engine) {
      await fetchModel();
      engine = await createVerdictEngine(dir, { threads });
    }
    server = Bun.serve({
      hostname: host,
      port,
      // Bun 1.4 keeps a connection open while its handler is pending — a
      // request waiting its turn answered 200 at 13 s under the default
      // (measured, seventh review pass); this bounds a connection idle with
      // nothing in flight, generously.
      idleTimeout: 120,
      fetch: createHandler(engine),
    });
    log(`${VERDICT.name} loaded in ${(performance.now() - t0).toFixed(0)} ms (${threads} threads, rss ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MB); serving ${JEV_CONTRACT} on http://${host}:${server.port}`);
  }, { err: (line) => console.error(line) });
}
