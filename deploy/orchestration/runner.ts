#!/usr/bin/env bun
/**
 * runner.ts — the `orchestration` profile's import runner (SMD-2212;
 * docs/orchestration-tool.md, "Running a pipeline from a workflow").
 *
 *   bun deploy/orchestration/runner.ts                # the service (compose: orchestration-runner)
 *   bun deploy/orchestration/runner.ts --self-check   # the rules, against stand-in commands (CI)
 *
 * n8n's image has neither Bun nor python3, and n8n excludes its Execute Command
 * node by default. So an import template calls this service with an HTTP
 * Request node instead. The service runs one pipeline from a fixed allowlist
 * (pipelines.json), reached only on the compose network and behind a key of
 * its own:
 *
 *   POST /run/<pipeline>   x-runner-key: <OB1_RUNNER_KEY>
 *     1. the pipeline's emitter, over /imports/<pipeline>/ (read-only), as a
 *        user of its own, with no secret in its environment;
 *     2. every line it printed must be the pipeline's one source (its system)
 *        and scope, or the batch is refused whole and nothing is written;
 *     3. `bun db/ingest-records.ts --source items --items - --allow <scope>
 *        --actor orchestration-runner` on those lines;
 *     4. `bun db/reembed.ts`, then the pipeline's rows are counted: the run
 *        succeeds when every one of them has a vector.
 *   The answer is the run's report: the counts and the items the ingester
 *   named (skipped, stale, held), as JSON. A refusal or a failure is a non-2xx
 *   answer, so n8n marks the run failed. One deadline bounds the whole run.
 *   GET /health            no key; whether it is up, and how many pipelines it holds.
 *
 * The request names a pipeline and nothing else. The export is read from the
 * imports directory, never sent through n8n, so n8n's run data holds the
 * report and not the export.
 *
 * The bound on its key (decision 4 as amended): only the allowlisted
 * pipelines, one source each, and every row under its own actor. The key is
 * not a brain key. Provisioning refuses it in any other credential
 * (deploy/orchestration/provision.ts, sharedSecrets).
 *
 * In the image the service runs as root, with every capability dropped but
 * the two that change user (compose), and it runs nothing as root: the
 * emitter as `ob1-emitter`, the ingester and reembed as `bun` (su-exec). An
 * emitter parses an outside export, and a parser an export exploits then
 * holds no secret: it cannot read the runner's environment or the ingester's
 * (/proc/<pid>/environ is its owner's), and it gets no database URL or key
 * in its own.
 */
import { SQL } from "bun";
import { timingSafeEqual, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEM_RE } from "../../db/ingest-contract.ts";
import { RESERVED_SYSTEMS, scopeProblem } from "../../db/ingest-items.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
/** The allowlist. Compose mounts the checkout's copy read-only, so provisioning and the runner read the same file. Empty until an import recipe is converted (SMD-2147–2150, SMD-2021). */
export const PIPELINES_FILE = join(HERE, "pipelines.json");
/** The actor every row the runner writes carries (ingest-records.ts --actor). */
export const RUNNER_ACTOR = "orchestration-runner";
/** The users the image runs an emitter and the pipeline as (runner.Dockerfile). */
export const EMITTER_USER = "ob1-emitter";
export const PIPELINE_USER = "bun";
export const DEFAULT_PORT = 8090;
export const DEFAULT_TIMEOUT_S = 3600;
/** After SIGTERM, how long a step has before SIGKILL; after it exits, how long its pipes may stay open (a child it left holding them). */
const KILL_GRACE_MS = 5000;
const DRAIN_MS = 2000;

export type Pipeline = {
  /** The URL segment, the imports subdirectory, and the n8n workflow's suffix. */
  name: string;
  /** The one source its items may carry (identity.system). */
  system: string;
  /** The one scope its items may carry, and the only one the ingester is told to allow. */
  scope: string;
  /** argv, run from the repository root; `{input}` becomes /imports/<name>. */
  emitter: string[];
  /** The import template's schedule for this pipeline, in hours. */
  everyHours: number;
};

const NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
/** What the image has to run an emitter with. */
const INTERPRETERS = ["python3", "bun"];

/** Parse and check the allowlist. Throws, naming the entry and the field, on anything it would not run. */
export function parsePipelines(text: string, file = "pipelines.json"): Pipeline[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`${file}: not JSON (${(e as Error).message})`); }
  if (!Array.isArray(raw)) throw new Error(`${file}: must be a JSON array of pipelines`);
  const seen = new Set<string>();
  return raw.map((p: any, i) => {
    const at = `${file}[${i}]${typeof p?.name === "string" ? ` (${p.name})` : ""}`;
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error(`${at}: must be an object`);
    const extra = Object.keys(p).filter((k) => !["name", "system", "scope", "emitter", "everyHours"].includes(k));
    if (extra.length) throw new Error(`${at}: unknown field ${extra[0]}`);
    if (typeof p.name !== "string" || !NAME_RE.test(p.name)) throw new Error(`${at}: name must match ${NAME_RE.source}`);
    if (seen.has(p.name)) throw new Error(`${at}: name ${p.name} is listed twice`);
    seen.add(p.name);
    if (typeof p.system !== "string" || !SYSTEM_RE.test(p.system)) throw new Error(`${at}: system must match ${SYSTEM_RE.source}`);
    if ((RESERVED_SYSTEMS as readonly string[]).includes(p.system)) throw new Error(`${at}: system ${p.system} is one the pipeline reads itself, not an emitter's`);
    // The item rule itself: a scope every item would fail is refused here, not on every run.
    const scopeWhy = scopeProblem(p.scope);
    if (scopeWhy) throw new Error(`${at}: scope ${JSON.stringify(p.scope)}: ${scopeWhy}`);
    if (!Array.isArray(p.emitter) || !p.emitter.length || !p.emitter.every((a: unknown) => typeof a === "string" && a.length)) throw new Error(`${at}: emitter must be a non-empty argv of strings`);
    if (!INTERPRETERS.includes(p.emitter[0])) throw new Error(`${at}: emitter must start with ${INTERPRETERS.join(" or ")}, the interpreters the image has`);
    if (!Number.isInteger(p.everyHours) || p.everyHours < 1 || p.everyHours > 168) throw new Error(`${at}: everyHours must be a whole number from 1 to 168`);
    return { name: p.name, system: p.system, scope: p.scope, emitter: p.emitter, everyHours: p.everyHours };
  });
}

export const loadPipelines = (file = PIPELINES_FILE) => parsePipelines(readFileSync(file, "utf8"), file);

/**
 * The emitter scripts an allowlist names that the image does not hold: a
 * line added to pipelines.json before the image was rebuilt with its emitter.
 * The script is argv[1] when it is a relative path.
 */
export function missingEmitters(pipelines: Pipeline[], root: string): string[] {
  return pipelines.flatMap((p) => {
    const script = p.emitter[1];
    return script && !script.startsWith("-") && script.includes("/") && !script.includes("{input}") && !existsSync(resolve(root, script)) ? [`${p.name}: ${script}`] : [];
  });
}

/**
 * The one-source rule, over the emitter's lines before any is written: a line
 * whose identity.system or scope is not the pipeline's is named. A line that
 * is not JSON is left to the ingester, which refuses the whole batch for it.
 */
export function strayLines(bytes: Uint8Array, p: Pipeline): string[] {
  const out: string[] = [];
  const lines = new TextDecoder().decode(bytes).split("\n");
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let item: any;
    try { item = JSON.parse(line); } catch { return; }
    const system = item?.identity?.system;
    if (system !== p.system) out.push(`line ${i + 1}: identity.system ${JSON.stringify(system)} is not ${p.name}'s source, ${p.system}`);
    else if (item?.scope !== p.scope) out.push(`line ${i + 1}: scope ${JSON.stringify(item?.scope)} is not ${p.name}'s scope, ${p.scope}`);
  });
  return out;
}

const TALLY_KEYS = ["inserted", "updated", "patched", "unchanged", "skipped", "held", "stale"] as const;
export type Tally = Record<(typeof TALLY_KEYS)[number], number>;
/** The ingester's count line (`tier=stable  inserted 5  updated 0 …`), or null when it printed none. */
export function parseTally(stdout: string): Tally | null {
  const line = stdout.split("\n").find((l) => /^\s*tier=\S+\s+inserted \d+/.test(l));
  if (!line) return null;
  return Object.fromEntries(TALLY_KEYS.map((k) => [k, Number(new RegExp(`\\b${k} (\\d+)`).exec(line)?.[1] ?? NaN)])) as Tally;
}

/** Which commands a run spawns, and how it counts the pipeline's rows without a vector. The service's are the pipeline's own; the self-check puts stand-ins here. */
export type Commands = {
  ingest: (p: Pipeline) => string[];
  reembed: () => string[];
  unembedded: (p: Pipeline) => Promise<number>;
};
export const PIPELINE_COMMANDS = (env: Record<string, string | undefined>): Commands => ({
  ingest: (p) => ["bun", "db/ingest-records.ts", "--source", "items", "--items", "-", "--allow", p.scope, "--actor", RUNNER_ACTOR],
  reembed: () => ["bun", "db/reembed.ts"],
  // The rows this pipeline's source holds with no vector. The ingester labels
  // each row with the item's system (metadata.source), and one pipeline owns
  // one system, so these are this pipeline's rows, from this run or an earlier one.
  async unembedded(p) {
    const sql = new SQL({ url: env.DATABASE_URL ?? "", max: 1 });
    try {
      const [row] = await sql`SELECT count(*)::int AS n FROM thoughts WHERE metadata->>'source' = ${p.system} AND embedding IS NULL`;
      return Number(row.n);
    } finally {
      await sql.close();
    }
  },
});

export type Config = {
  key: string;
  pipelines: Pipeline[];
  importsDir: string;
  /** Where commands run: the repository root, so the emitter's and the pipeline's relative paths resolve. */
  cwd: string;
  commands: Commands;
  /** One run's bound, emitter to reembed, in seconds. */
  timeoutS: number;
  /** The most an emitter may print, in bytes. */
  maxBytes: number;
  /** The environment the ingester and reembed get: the database and the model knobs. The emitter gets none of it. */
  env: Record<string, string | undefined>;
  /** Prefixes that run the emitter and the pipeline as their own users (su-exec in the image); empty elsewhere. */
  asEmitter: string[];
  asPipeline: string[];
};

/** Whatever a step printed, cut to its end: enough to say why, not a copy of what it read. */
const tail = (s: string, n = 2000) => (s.length > n ? `…${s.slice(-n)}` : s);
const lines = (s: string) => s.split("\n").map((l) => l.trimEnd()).filter(Boolean);

type Step = { code: number; bytes: Uint8Array; out: string; err: string; timedOut: boolean; overflow: boolean };
/**
 * One step, bounded. At the deadline it gets SIGTERM, then SIGKILL after a
 * grace. Its stdout is capped; its stderr keeps only a rolling tail. Once it
 * has exited, its pipes get a moment to close, and are then abandoned. A child
 * it left holding them cannot keep the run, or the pipeline's busy mark,
 * waiting (review pass 1, run-it: an emitter that daemonised a child held its
 * pipeline at 409 until the runner restarted).
 */
async function step(argv: string[], o: { cwd: string; env: Record<string, string | undefined>; stdin?: Uint8Array; deadline: number; maxBytes?: number; errBytes?: number }): Promise<Step> {
  const proc = Bun.spawn(argv, { cwd: o.cwd, env: o.env, stdin: o.stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false, overflow = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    try { proc.kill("SIGTERM"); } catch {}
    killer ??= setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, KILL_GRACE_MS);
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(0, o.deadline - Date.now()));
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const drain = async (s: ReadableStream<Uint8Array>, take: (c: Uint8Array) => void) => {
    const r = s.getReader();
    readers.push(r);
    try { for (;;) { const { done, value } = await r.read(); if (done) return; take(value); } } catch {}
  };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let errTail = "";
  const errMax = o.errBytes ?? 16384;
  const dec = new TextDecoder();
  const reading = Promise.all([
    drain(proc.stdout as ReadableStream<Uint8Array>, (c) => {
      if (overflow) return;
      size += c.length;
      if (o.maxBytes !== undefined && size > o.maxBytes) { overflow = true; stop(); return; }
      chunks.push(c);
    }),
    drain(proc.stderr as ReadableStream<Uint8Array>, (c) => { errTail = (errTail + dec.decode(c, { stream: true })).slice(-errMax); }),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  if (killer) clearTimeout(killer);
  await Promise.race([reading, Bun.sleep(DRAIN_MS)]);
  for (const r of readers) r.cancel().catch(() => {});
  const bytes = Buffer.concat(chunks);
  return { code, bytes, out: new TextDecoder().decode(bytes), err: errTail, timedOut, overflow };
}

/** The emitter's environment: enough to run, nothing the runner holds. */
const EMITTER_ENV = (env: Record<string, string | undefined>) => ({ PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" });

export type Stage = "emitter" | "one-source" | "ingest" | "reembed";
export type Report = {
  pipeline: string;
  ok: boolean;
  /** Where it stopped, when it did not finish, and that step's exit code (null when it was stopped). */
  stage?: Stage;
  exit?: number | null;
  why?: string;
  emitted: number;
  counts?: Tally | null;
  /** The ingester's count lines, and its stderr (the items it named, the refusals). */
  report?: string[];
  notes?: string[];
  reembed?: { exit: number; tail: string[]; unembedded?: number };
};

/** The HTTP status for a report: the input's fault is 422 (the emitter, the one-source rule, the ingester refusing the batch), anything else 500. */
export function statusOf(r: Report): number {
  if (r.ok) return 200;
  if (r.stage === "emitter" || r.stage === "one-source") return 422;
  if (r.stage === "ingest" && r.exit === 2) return 422;
  return 500;
}

/** reembed is one pass over the whole brain at a time: two pipelines' passes would see each other's leases. */
let reembedTurn: Promise<unknown> = Promise.resolve();

/** One run of one pipeline, start to report, within one deadline. */
export async function runPipeline(c: Config, p: Pipeline): Promise<Report> {
  const deadline = Date.now() + c.timeoutS * 1000;
  const past = `ran past the run's ${c.timeoutS} s and was stopped`;
  const input = join(c.importsDir, p.name);
  const argv = [...c.asEmitter, ...p.emitter.map((a) => a.replaceAll("{input}", input))];
  const e = await step(argv, { cwd: c.cwd, env: EMITTER_ENV(c.env), deadline, maxBytes: c.maxBytes });
  if (e.timedOut || e.overflow || e.code !== 0) {
    const why = e.timedOut ? `the emitter ${past}` : e.overflow ? `the emitter printed more than ${c.maxBytes} bytes and was stopped` : `the emitter exited ${e.code}`;
    return { pipeline: p.name, ok: false, stage: "emitter", exit: e.timedOut || e.overflow ? null : e.code, why, emitted: 0, notes: lines(tail(e.err)) };
  }
  const emitted = lines(e.out).length;
  const stray = strayLines(e.bytes, p);
  if (stray.length) return { pipeline: p.name, ok: false, stage: "one-source", why: `${stray.length} line(s) are not ${p.name}'s source — the batch is refused whole; nothing written`, emitted, notes: stray.slice(0, 20) };
  if (emitted === 0) return { pipeline: p.name, ok: true, emitted, counts: null, report: [`${p.name}: the emitter printed nothing — no export under ${input}?`] };
  const ing = await step([...c.asPipeline, ...c.commands.ingest(p)], { cwd: c.cwd, env: c.env, stdin: e.bytes, deadline });
  // The ingester's own "next: bun db/reembed.ts" is the runner's next step, not the reader's.
  const base = { pipeline: p.name, emitted, counts: parseTally(ing.out), report: lines(ing.out).filter((l) => !/^\s*next: /.test(l)), notes: lines(tail(ing.err, 8000)) };
  if (ing.timedOut || ing.code !== 0) return { ...base, ok: false, stage: "ingest", exit: ing.timedOut ? null : ing.code, why: ing.timedOut ? `the ingester ${past}` : `the ingester exited ${ing.code}${ing.code === 2 ? " (it refused the batch or its configuration; nothing written — the notes say which)" : ""}` };
  const turn = reembedTurn.then(async () => {
    const re = await step([...c.asPipeline, ...c.commands.reembed()], { cwd: c.cwd, env: c.env, deadline });
    // reembed exits 1 for any failed row it holds from any earlier pass, and
    // for another pass's leases (review pass 1: every import then failed for
    // good). What this run owes is its own source's rows with a vector.
    const unembedded = await c.commands.unembedded(p).catch((err) => { throw new Error(`the rows are written, and counting ${p.system}'s rows without a vector failed: ${(err as Error).message}`); });
    return { re, unembedded };
  });
  reembedTurn = turn.catch(() => {});
  let re: Step, unembedded: number;
  try {
    ({ re, unembedded } = await turn);
  } catch (err) {
    return { ...base, ok: false, stage: "reembed", exit: null, why: (err as Error).message };
  }
  const reembed = { exit: re.code, tail: lines(tail(`${re.out}\n${re.err}`, 1500)), unembedded };
  if (unembedded > 0) {
    return {
      ...base, ok: false, stage: "reembed", exit: re.timedOut ? null : re.code, reembed,
      why: `the rows are written, and ${unembedded} of ${p.system}'s rows have no vector (reembed ${re.timedOut ? past : `exited ${re.code}`}). A row the provider refused waits for \`bun db/reembed.ts --retry-failed\`; one still pending is embedded by the next run`,
    };
  }
  return { ...base, ok: true, reembed };
}

const digest = (s: string) => createHash("sha256").update(s).digest();
/** 401 without a key, 403 with a wrong one: the two answers the brain gives. Compared as digests, in constant time. */
function keyStatus(req: Request, key: string): 0 | 401 | 403 {
  const given = req.headers.get("x-runner-key");
  if (!given) return 401;
  return timingSafeEqual(digest(given), digest(key)) ? 0 : 403;
}

/** The service. `port: 0` picks one (the self-check). */
export function serve(c: Config, port = DEFAULT_PORT) {
  const byName = new Map(c.pipelines.map((p) => [p.name, p]));
  const busy = new Set<string>();
  return Bun.serve({
    port,
    hostname: "0.0.0.0",
    // Never Bun's development error page, which shows source and a stack.
    development: false,
    // A pipeline's run can take a while; the connection waits for it.
    idleTimeout: 0,
    error(err) {
      console.error(`runner: ${err.message}`);
      return Response.json({ ok: false, why: "the runner failed on this request; its log says why" }, { status: 500 });
    },
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/health") return Response.json({ ok: true, pipelines: byName.size });
      const m = /^\/run\/([^/]+)$/.exec(u.pathname);
      if (!m) return new Response("not here", { status: 404 });
      // The key first, so an unkeyed caller learns nothing, not even which pipelines exist.
      const refused = keyStatus(req, c.key);
      if (refused) return Response.json({ ok: false, why: refused === 401 ? "no x-runner-key" : "wrong x-runner-key" }, { status: refused });
      if (req.method !== "POST") return new Response("POST only", { status: 405, headers: { allow: "POST" } });
      // A name is a plain label (NAME_RE), so an escape that does not decode names nothing.
      let name: string;
      try { name = decodeURIComponent(m[1]); } catch { name = ""; }
      const p = byName.get(name);
      if (!p) return Response.json({ ok: false, why: `no pipeline ${JSON.stringify(m[1])} in the allowlist` }, { status: 404 });
      if (busy.has(p.name)) return Response.json({ ok: false, pipeline: p.name, why: "a run of this pipeline is already going" }, { status: 409 });
      busy.add(p.name);
      try {
        const r = await runPipeline(c, p);
        console.log(`${new Date().toISOString()} ${p.name}: ${r.ok ? "ok" : `${r.stage}: ${r.why}`} (emitted ${r.emitted}${r.counts ? `, inserted ${r.counts.inserted}, updated ${r.counts.updated}, unchanged ${r.counts.unchanged}` : ""})`);
        return Response.json(r, { status: statusOf(r) });
      } finally {
        busy.delete(p.name);
      }
    },
  });
}

/** su-exec, where the image installs it. */
const SU_EXEC = ["/sbin/su-exec", "/usr/bin/su-exec"].find((f) => existsSync(f));

/** The service's configuration from its environment; throws with the reason. */
export function configFrom(env: Record<string, string | undefined>, uid = process.getuid?.() ?? -1): Config {
  const key = env.OB1_RUNNER_KEY?.trim() ?? "";
  if (key.length < 32) throw new Error("OB1_RUNNER_KEY is not set, or shorter than 32 characters — run `bun deploy/orchestration/provision.ts --init`, which writes it into deploy/.env");
  const timeoutS = Number(env.OB1_RUNNER_TIMEOUT_S?.trim() || DEFAULT_TIMEOUT_S);
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) throw new Error(`OB1_RUNNER_TIMEOUT_S must be a positive number of seconds, got "${env.OB1_RUNNER_TIMEOUT_S}"`);
  // As root (the image), nothing runs as root: without su-exec the runner refuses to start.
  if (uid === 0 && !SU_EXEC) throw new Error("running as root without su-exec: an emitter would run as root and could read every secret — use the runner's image (deploy/orchestration/runner.Dockerfile)");
  const pipelines = loadPipelines(PIPELINES_FILE);
  const missing = missingEmitters(pipelines, REPO);
  if (missing.length) throw new Error(`pipelines.json names an emitter the image does not hold (${missing.join("; ")}) — rebuild the runner: compose --profile orchestration up -d --build orchestration-runner`);
  return {
    key,
    pipelines,
    // The container's own path; compose mounts IMPORTS_DIR (a host path) here.
    importsDir: "/imports",
    cwd: REPO,
    commands: PIPELINE_COMMANDS(env),
    timeoutS,
    maxBytes: 256 * 1024 * 1024,
    env: uid === 0 ? { ...env, HOME: `/home/${PIPELINE_USER}` } : env,
    asEmitter: uid === 0 ? [SU_EXEC!, EMITTER_USER] : [],
    asPipeline: uid === 0 ? [SU_EXEC!, PIPELINE_USER] : [],
  };
}

/**
 * `--self-check`: the allowlist's rules, the one-source rule, the count line,
 * the status mapping, and the service against stand-in commands (no
 * database):
 * - the key's two refusals, an unknown pipeline, and a malformed escape;
 * - a run that writes, and one whose rows are left without a vector
 *   whatever reembed's exit;
 * - a stray line refused before the ingester runs;
 * - an emitter that fails, and an emitter that cannot see the runner's
 *   environment;
 * - the bounds on a run: a second call while one is going (409), a step past
 *   the deadline, one that ignores SIGTERM, one that leaves a child holding
 *   its pipes, and output past the cap.
 * Running as another user is the image's, and the eval kit holds it live
 * (evals/orchestration/n8n.ts, I).
 */
async function selfCheck(): Promise<number> {
  const fails: string[] = [];
  const expect = (what: string, ok: boolean) => { if (!ok) fails.push(what); };
  const throws = (fn: () => unknown, re: RegExp) => { try { fn(); return false; } catch (e) { return re.test((e as Error).message); } };
  const good = { name: "fixture", system: "fixture", scope: "fixture:export", emitter: ["bun", "x.ts", "{input}"], everyHours: 24 };
  const one = (p: object) => JSON.stringify([{ ...good, ...p }]);
  expect("a good pipeline parses", parsePipelines(one({}))[0].name === "fixture");
  expect("the shipped allowlist parses", Array.isArray(loadPipelines()));
  expect("a name that is not a label is refused", throws(() => parsePipelines(one({ name: "../x" })), /name must match/));
  expect("a name listed twice is refused", throws(() => parsePipelines(JSON.stringify([good, good])), /listed twice/));
  expect("a reserved system is refused", throws(() => parsePipelines(one({ system: "linear" })), /reads itself/));
  expect("two scopes are refused", throws(() => parsePipelines(one({ scope: "a,b" })), /separator between scopes/));
  expect("a scope the ingester would refuse (a `/`, surrounding space) is refused here", throws(() => parsePipelines(one({ scope: "a/b" })), /holds a `\/`/) && throws(() => parsePipelines(one({ scope: " a:b" })), /surrounding whitespace/));
  expect("an interpreter the image lacks is refused", throws(() => parsePipelines(one({ emitter: ["sh", "-c", "x"] })), /must start with python3 or bun/));
  expect("an unknown field is refused", throws(() => parsePipelines(one({ env: ["TOKEN"] })), /unknown field env/));
  expect("a schedule past a week is refused", throws(() => parsePipelines(one({ everyHours: 200 })), /everyHours/));
  expect("an emitter script the image lacks is named; an inline one and a present one are not", JSON.stringify(missingEmitters(parsePipelines(JSON.stringify([
    { ...good, name: "gone", emitter: ["python3", "recipes/nowhere/emit.py", "{input}"] },
    { ...good, name: "here", emitter: ["bun", "deploy/orchestration/runner.ts"] },
    { ...good, name: "inline", emitter: ["bun", "-e", "1"] },
  ])), REPO)) === JSON.stringify(["gone: recipes/nowhere/emit.py"]));
  const item = (system: string, scope = "fixture:export") => JSON.stringify({ identity: { system, key: "k" }, scope, text: "t" });
  const p = parsePipelines(one({}))[0];
  expect("the pipeline's own lines are not stray", strayLines(new TextEncoder().encode(`${item("fixture")}\n\n${item("fixture")}\n`), p).length === 0);
  const stray = strayLines(new TextEncoder().encode(`${item("fixture")}\n${item("linear")}\n${item("fixture", "other:scope")}\nnot json\n`), p);
  expect("another source's line and another scope's are named, a non-JSON line is left to the ingester", stray.length === 2 && /^line 2: identity.system "linear"/.test(stray[0]) && /^line 3: scope "other:scope"/.test(stray[1]));
  const t = parseTally("  items: 3 record(s) (fixture 3)\n  tier=stable  inserted 3  updated 0  patched 0  unchanged 0  skipped 0  held 0  stale 0\n");
  expect("the count line is read", t?.inserted === 3 && t.unchanged === 0 && parseTally("nothing") === null);
  expect("configFrom refuses a missing or short key", throws(() => configFrom({}), /OB1_RUNNER_KEY/) && throws(() => configFrom({ OB1_RUNNER_KEY: "short" }), /OB1_RUNNER_KEY/));
  if (!SU_EXEC) expect("as root without su-exec it refuses to start", throws(() => configFrom({ OB1_RUNNER_KEY: "k".repeat(40) }, 0), /without su-exec/));
  const r = (x: Partial<Report>) => statusOf({ pipeline: "p", ok: false, emitted: 0, ...x });
  expect("status follows the stage and the exit code, not the text", r({ ok: true }) === 200 && r({ stage: "emitter", exit: 3 }) === 422 && r({ stage: "one-source" }) === 422
    && r({ stage: "ingest", exit: 2 }) === 422 && r({ stage: "ingest", exit: 20, why: "exited 2" }) === 500 && r({ stage: "ingest", exit: 1 }) === 500 && r({ stage: "reembed", exit: 1 }) === 500);

  // The service, with stand-in commands: an emitter per case, an "ingester"
  // that counts stdin's lines, a reembed that says it ran and exits as told,
  // and an unembedded count the case sets.
  const dir = `${HERE}/.self-check.${process.pid}`;
  const emit = (body: string) => ["bun", "-e", body];
  const pipelines = parsePipelines(JSON.stringify([
    { ...good, name: "writes", emitter: emit(`const at = process.argv.at(-1); for (const k of ["a", "b"]) console.log(JSON.stringify({ identity: { system: "fixture", key: k }, scope: "fixture:export", text: at }))`).concat("{input}") },
    { ...good, name: "unembedded", emitter: emit(`console.log(${JSON.stringify(item("fixture"))})`) },
    { ...good, name: "stray", emitter: emit(`console.log(${JSON.stringify(item("fixture"))}); console.log(${JSON.stringify(item("gmail"))})`) },
    { ...good, name: "fails", emitter: emit(`console.error("cannot read the export"); process.exit(3)`) },
    { ...good, name: "snoops", emitter: emit(`console.log(JSON.stringify({ identity: { system: "fixture", key: "k" }, scope: "fixture:export", text: String(process.env.DATABASE_URL ?? "") + "|" + String(process.env.OB1_RUNNER_KEY ?? "") }))`) },
  ]));
  let ingested = 0;
  let reembedExit = 0;
  const leftWithout = new Map<string, number>([["unembedded", 1]]);
  const key = "k".repeat(40);
  const commands: Commands = {
    ingest: () => { ingested++; return ["bun", "-e", `const t = await Bun.stdin.text(); const n = t.split("\\n").filter(Boolean).length; if (t.includes("postgres://") || t.includes(${JSON.stringify(key)})) { console.error("leaked"); process.exit(9); } console.error("first text " + JSON.parse(t.split("\\n")[0]).text); console.log("  tier=stable  inserted " + n + "  updated 0  patched 0  unchanged 0  skipped 0  held 0  stale 0"); console.log("  next: bun db/reembed.ts --url … — embed the new rows")`]; },
    reembed: () => ["bun", "-e", `console.log("reembed ran"); process.exit(${reembedExit})`],
    unembedded: async (x) => leftWithout.get(x.name) ?? 0,
  };
  const config = (over: Partial<Config>): Config => ({ key, pipelines, importsDir: dir, cwd: REPO, commands, timeoutS: 30, maxBytes: 1 << 20, env: { ...process.env, DATABASE_URL: "postgres://secret@db/x", OB1_RUNNER_KEY: key }, asEmitter: [], asPipeline: [], ...over });
  const server = serve(config({}), 0);
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  const post = (path: string, headers: Record<string, string> = { "x-runner-key": key }) => fetch(url(path), { method: "POST", headers });
  try {
    expect("health answers without a key", (await fetch(url("/health"))).status === 200);
    expect("no key is 401", (await post("/run/writes", {})).status === 401);
    expect("a wrong key is 403", (await post("/run/writes", { "x-runner-key": key.slice(0, -1) + "x" })).status === 403);
    expect("an unkeyed caller cannot tell an unknown pipeline from a known one", (await post("/run/nope", {})).status === 401);
    expect("an unknown pipeline is 404", (await post("/run/nope")).status === 404);
    const bad = await post("/run/%E0%A4%A");
    expect(`a malformed escape is 404 and JSON, not an error page (${bad.status})`, bad.status === 404 && /application\/json/.test(bad.headers.get("content-type") ?? ""));
    expect("GET on a run is 405", (await fetch(url("/run/writes"), { headers: { "x-runner-key": key } })).status === 405);
    const w = await post("/run/writes");
    const wr = await w.json() as Report;
    expect(`a run writes and reports: 200, two emitted, inserted 2, reembed ran (${w.status} ${JSON.stringify(wr).slice(0, 200)})`, w.status === 200 && wr.ok && wr.emitted === 2 && wr.counts?.inserted === 2 && wr.reembed?.exit === 0);
    expect(`the emitter's {input} is the pipeline's imports directory (${wr.notes?.[0]})`, wr.notes?.[0] === `first text ${join(dir, "writes")}`);
    expect("the ingester's own `next:` line is not in the report", !wr.report?.some((l) => /next:/.test(l)));
    reembedExit = 1;
    const w1 = await post("/run/writes");
    const w1r = await w1.json() as Report;
    expect(`reembed exiting 1 (an old failed row, another pass's leases) does not fail a run whose rows all have a vector (${w1.status})`, w1.status === 200 && w1r.ok && w1r.reembed?.exit === 1);
    reembedExit = 0;
    const u = await post("/run/unembedded");
    const ur = await u.json() as Report;
    expect(`a row of the pipeline's source left without a vector fails the run even when reembed exits 0, and says how to retry (${u.status} ${ur.why})`, u.status === 500 && ur.stage === "reembed" && ur.reembed?.unembedded === 1 && /--retry-failed/.test(ur.why ?? ""));
    const before = ingested;
    const s = await post("/run/stray");
    const sr = await s.json() as Report;
    expect("a batch with another source's line is 422, refused whole, and the ingester never runs", s.status === 422 && sr.stage === "one-source" && /identity.system "gmail"/.test(sr.notes?.[0] ?? "") && ingested === before);
    const f = await post("/run/fails");
    const fr = await f.json() as Report;
    expect("an emitter that fails is 422 with its reason and exit code", f.status === 422 && fr.stage === "emitter" && fr.exit === 3 && fr.notes?.[0] === "cannot read the export");
    const n = await post("/run/snoops");
    const nr = await n.json() as Report;
    expect(`the emitter's environment holds neither the database URL nor the key (${n.status} ${nr.why ?? ""})`, n.status === 200 && nr.ok);
  } finally {
    server.stop(true);
  }

  // The bounds on one run: a second call while one is going, a step past the
  // deadline, one that ignores SIGTERM, one that leaves a child holding its
  // pipes, and an emitter printing past the cap. None reaches the ingester.
  const bounded = parsePipelines(JSON.stringify([
    { ...good, name: "slow", emitter: emit(`await Bun.sleep(1500); console.log(${JSON.stringify(item("fixture"))})`) },
    { ...good, name: "hangs", emitter: emit(`await Bun.sleep(20000)`) },
    { ...good, name: "deaf", emitter: emit(`process.on("SIGTERM", () => {}); await Bun.sleep(30000)`) },
    { ...good, name: "orphans", emitter: emit(`Bun.spawn(["bun", "-e", "await Bun.sleep(30000)"], { stdout: "inherit", stderr: "inherit" }).unref(); process.exit(0)`) },
    { ...good, name: "floods", emitter: emit(`const l = ${JSON.stringify(item("fixture"))} + "\\n"; for (let i = 0; i < 200; i++) process.stdout.write(l)`) },
  ]));
  const before = ingested;
  const small = serve(config({ pipelines: bounded, timeoutS: 3, maxBytes: 2000, env: process.env }), 0);
  const at = (path: string) => fetch(`http://127.0.0.1:${small.port}${path}`, { method: "POST", headers: { "x-runner-key": key } });
  try {
    const [a, b] = await Promise.all([at("/run/slow"), Bun.sleep(300).then(() => at("/run/slow"))]);
    expect(`a second run of a pipeline already going is 409, and the first finishes (${a.status}, ${b.status})`, a.status === 200 && b.status === 409);
    const timed = async (name: string) => { const t0 = Date.now(); const res = await at(`/run/${name}`); return { res, rep: await res.json() as Report, s: (Date.now() - t0) / 1000 }; };
    const h = await timed("hangs");
    expect(`an emitter past the deadline is stopped and refused (${h.res.status}, ${h.s.toFixed(1)} s, ${h.rep.why})`, h.res.status === 422 && /ran past the run's 3 s/.test(h.rep.why ?? "") && h.s < 6);
    const d = await timed("deaf");
    expect(`an emitter that ignores SIGTERM is killed after the grace (${d.res.status}, ${d.s.toFixed(1)} s)`, d.res.status === 422 && d.s < 3 + KILL_GRACE_MS / 1000 + 3);
    const o = await timed("orphans");
    expect(`an emitter that leaves a child holding its pipes still answers (${o.res.status}, ${o.s.toFixed(1)} s)`, o.s < DRAIN_MS / 1000 + 3);
    const again = await at("/run/orphans");
    expect(`…and its pipeline is free for the next run, not held at 409 (${again.status})`, again.status !== 409);
    const fl = await timed("floods");
    expect(`an emitter past the output cap is stopped and refused (${fl.res.status}, ${fl.rep.why})`, fl.res.status === 422 && /more than 2000 bytes/.test(fl.rep.why ?? ""));
    expect("of the bounded runs only the slow one reached the ingester", ingested === before + 1);
  } finally {
    small.stop(true);
  }

  for (const x of fails) console.error(`FAIL ${x}`);
  console.log(fails.length ? `runner self-check: ${fails.length} failed` : "runner self-check: OK");
  return fails.length ? 1 : 0;
}

if (import.meta.main && process.argv.includes("--self-check")) process.exit(await selfCheck());

if (import.meta.main) {
  let c: Config;
  try {
    c = configFrom(process.env);
  } catch (e) {
    console.error(`runner: ${(e as Error).message}`);
    process.exit(2);
  }
  if (!existsSync(c.importsDir)) console.error(`runner: ${c.importsDir} does not exist; every emitter will find no export`);
  const s = serve(c);
  console.log(`runner: listening on :${s.port}, ${c.pipelines.length} pipeline(s)${c.pipelines.length ? `: ${c.pipelines.map((p) => p.name).join(", ")}` : " (none converted yet — deploy/orchestration/pipelines.json)"}${c.asEmitter.length ? `; emitters run as ${EMITTER_USER}, the pipeline as ${PIPELINE_USER}` : ""}`);
  const stop = () => { s.stop(true); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
