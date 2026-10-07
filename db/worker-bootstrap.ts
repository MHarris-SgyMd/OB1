/**
 * worker-bootstrap.ts — the one place the db/ claim workers bootstrap their
 * provider egress (and, from SMD-2303's later slices, identity and error
 * classification). SMD-2134 cut 3.
 *
 * Before this, extract-entities.ts, consolidate.ts and reembed.ts each carried
 * a near-identical egress banner and blanket gate that differed only in the
 * verb of the refusal ("extracted" / "judged" / "re-embedded"), and
 * sync-linear.ts a fourth variant. They now share this module, and
 * test-cli.ts's census holds that no other db/ file reaches egress.ts's
 * `refusesEverything` or `describeEgress` directly.
 *
 * These functions RETURN their outcome — a refusal string, or null when at
 * least one call would go through — and never call process.exit or touch the
 * sql client. extract-entities.ts's, consolidate.ts's and reembed.ts's
 * importable run() turn the result into a return code (SMD-2304). Banners are
 * returned as strings for the caller to print with its own label and spacing.
 */

import { describeEgress, refusesEverything, type EgressPolicy, type EgressUnit } from "../server-portable/egress.ts";
import { refusesLength, type ProviderEndpoint } from "../server-portable/embed.ts";
// ProviderEndpoint's `headers` are what probeChat sends, as the workers' own calls do.
import { CLIENT_SCOPES, hashKey, parseKeyRecords } from "../server-portable/auth.ts";
import { SqlStore } from "../server-portable/store-sql.ts";
import { sleepUnless } from "./lease.ts";

// ── Egress ───────────────────────────────────────────────────────────────────

/**
 * One banner line: what the gate does for calls to this endpoint under this
 * policy, in words. The worker prints it under its own `  egress:` label.
 */
export function egressDescription(endpoint: ProviderEndpoint, policy: EgressPolicy, localKnobKey: string): string {
  return describeEgress(endpoint, policy, localKnobKey);
}

/**
 * The bare reason every call to this endpoint would be refused, or null when at
 * least one would go through. `units` are what a row of the pass carries; left
 * undefined it is the full set (an actor credited optimistically before a worker
 * key has, or has not, resolved). A caller that wants the worker's full "Nothing
 * would be <verb>" sentence uses blanketGate; sync-linear.ts, and reembed.ts's
 * blurbs warning, wrap the bare reason in their own text and use this.
 */
export function egressRefusal(
  endpoint: Pick<ProviderEndpoint, "base" | "local">,
  policy: EgressPolicy,
  units?: readonly EgressUnit[],
): string | null {
  return units === undefined ? refusesEverything(endpoint, policy) : refusesEverything(endpoint, policy, units);
}

/**
 * The refusal a claim worker prints before it claims anything: a policy that
 * would refuse whatever the row (SMD-1903) stops the pass rather than fail every
 * row in the pool one at a time. Returns the full sentence, or null when the
 * pass may run. `verb` is the pass's own word for what it does; the remedy tail
 * is one text for every worker.
 */
export function blanketGate(opts: {
  endpoint: Pick<ProviderEndpoint, "base" | "local">;
  policy: EgressPolicy;
  units?: readonly EgressUnit[];
  verb: string;
  localKnobKey: string;
}): string | null {
  const reason = egressRefusal(opts.endpoint, opts.policy, opts.units);
  if (reason === null) return null;
  return `Nothing would be ${opts.verb}: ${reason}. Declare the endpoint local (${opts.localKnobKey}=1) if it is, name what may leave in OB1_EGRESS_ALLOW, or set OB1_EGRESS_POLICY — in words, before a pass that would fail every row it claims.`;
}

/**
 * The re-gate after identity: the blanket gate above credited an actor because a
 * worker key was set, but the key did not resolve to a name, so the pass carries
 * no actor after all and is asked again without one (SMD-2303, from the workers'
 * third review pass). `reason` is egressRefusal(..., ROW_UNITS).
 */
export function regateMessage(verb: string, reason: string): string {
  return `Nothing would be ${verb}: ${reason} — the worker key did not resolve, so the pass carries no actor for an actor: term to name.`;
}

// ── Identity ─────────────────────────────────────────────────────────────────

/** What a worker key resolved to: an agent id (null when it did not resolve) and the key's own name (undefined then), the egress gate's `actor:` unit. */
export type WorkerIdentity = { agentId: string | null; keyName: string | undefined };

/**
 * The claim workers' identity bootstrap (SMD-2303), extract-entities.ts's and
 * consolidate.ts's ~45-line block in one place. The same decision the server
 * makes: OB1_WORKER_KEY must be a key MCP_ACCESS_KEYS holds, of a caller's
 * scope — one the server would refuse, a forwarder's included (SMD-2284), is no
 * identity here either — and the record's own name and scope are what get
 * registered. Resolution goes through the store's capped path
 * (SqlStore.resolveAgent, which bounds lock_timeout so a lookup of a locked
 * registry holds its connection for the cap, not the lock — what the raw
 * `resolve_agent` the workers ran did not), on a one-connection store of its
 * own that it opens and closes.
 *
 * Returns the resolved identity, or a refusal the caller prints before it closes
 * its own sql and exits 2. It never calls process.exit or touches the caller's
 * sql; the `agent:` line and the warnings go through the injectable writers
 * (SMD-2304's run() captures them). The caller decides its own actor label from
 * `keyName` — extract carries the key's name or none, consolidate falls back to
 * its audit label — and re-gates egress when `keyName` is undefined.
 */
export async function workerIdentity(
  url: string,
  /** The environment, read for OB1_WORKER_KEY and MCP_ACCESS_KEYS (process.env at the call sites). */
  env: Record<string, string | undefined>,
  opts: {
    /** The warning printed when OB1_WORKER_KEY is unset — its wording differs per worker. */
    noKeyWarning: string;
    write?: (line: string) => void;
    warn?: (line: string) => void;
  },
): Promise<{ ok: true; identity: WorkerIdentity } | { ok: false; message: string }> {
  const write = opts.write ?? ((l: string) => console.log(l));
  const warn = opts.warn ?? ((l: string) => console.error(l));
  const none: WorkerIdentity = { agentId: null, keyName: undefined };

  const rawKey = env.OB1_WORKER_KEY;
  if (!rawKey) {
    warn(opts.noKeyWarning);
    return { ok: true, identity: none };
  }
  if (!env.MCP_ACCESS_KEYS) {
    return { ok: false, message: "\n  OB1_WORKER_KEY is set but MCP_ACCESS_KEYS is not, so the key cannot be checked or named. Set both, as the server has them." };
  }
  const hash = hashKey(rawKey);
  // As the server picks (auth.ts authenticate): the first record of the digest
  // whose scope it admits as a caller's. A forwarder grants nothing and names
  // who carried another key's request (SMD-2284): every server refuses it as a
  // caller, and its scope is one the registry's CHECK does not hold (agents.ts,
  // recordedScope).
  const matching = parseKeyRecords(env.MCP_ACCESS_KEYS).keys.filter((k) => k.sha256 === hash);
  const record = matching.find((k) => CLIENT_SCOPES.includes(k.scope));
  if (!record && matching.length) {
    return { ok: false, message: `\n  OB1_WORKER_KEY is "${matching[0].name}", a ${matching[0].scope}-scope key — it grants nothing and names no worker; the server refuses it as a caller, and so does this. Give the worker a key of its own: cd server-portable && bun keygen.ts --name <worker> --scope capture (or write).` };
  }
  if (!record) {
    return { ok: false, message: "\n  OB1_WORKER_KEY is not one of the keys in MCP_ACCESS_KEYS. The server would refuse it; so does this." };
  }
  const store = new SqlStore(url, { max: 1 });
  let res: Awaited<ReturnType<SqlStore["resolveAgent"]>>;
  try {
    res = await store.resolveAgent({ keyHash: hash, label: record.name, scope: record.scope });
  } catch (e) {
    warn(`  ⚠  could not resolve the worker's identity (${(e as Error).message}); rows will carry no agent id`);
    return { ok: true, identity: none };
  } finally {
    await store.close();
  }
  // Outside the resolve's try: a writer that throws on the agent line is the
  // writer's error, not an identity that did not resolve (SMD-2304 review pass 2).
  if (!res.ok && res.error === "REVOKED") {
    return { ok: false, message: `\n  The worker's key was revoked at ${res.revokedAt}${res.reason ? ` (${res.reason})` : ""}. Refusing to run.` };
  }
  if (res.ok) {
    write(`  agent:  ${record.name} (${record.scope}, ${res.agentId})`);
    return { ok: true, identity: { agentId: res.agentId, keyName: record.name } };
  }
  warn(`  ⚠  resolve_agent answered ${res.detail}; rows will carry no agent id`);
  return { ok: true, identity: none };
}

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * What an error from the provider is about.
 *
 *   thought   — a fact about this thought: a timeout (the corpus run showed the
 *               same long documents exceed the limit every time), a 400 naming
 *               the input's length, a body that was not JSON. Recorded failed;
 *               --retry-failed revisits it.
 *   transient — says nothing about the thought: 429, 5xx, a dropped connection.
 *               Paused and retried; if it persists, THIS row is recorded failed
 *               with the error (so a thought that reliably draws a 500 becomes
 *               visible rather than cycling through the pool for ever) and the
 *               worker stops, leaving its other leases to the pool.
 *   fatal     — the request itself is wrong for this provider: 401/403 (the
 *               key), 404 (the model), or a 400 about the request's shape. The
 *               next thought would fail the same way, so every worker stops at
 *               once and the run exits 2, with nothing marked failed.
 */
export type ErrorKind = "thought" | "transient" | "fatal";

/**
 * The longest --timeout a model call takes, in whole seconds: the call's
 * signal is AbortSignal.timeout(seconds × 1000), which throws past 2^53 − 1
 * ms, so every call failed at once and extract marked every thought failed
 * (SMD-2304).
 */
export const MAX_CALL_TIMEOUT_S = Math.floor(Number.MAX_SAFE_INTEGER / 1000);

/** The back-off between retries of a transient provider failure, one pause per attempt. */
export const TRANSIENT_PAUSES_MS = [5_000, 15_000, 45_000];

/**
 * Classify a provider error for a claim worker (SMD-2303) — extract-entities.ts's
 * and consolidate.ts's identical function, less the one rule extract adds. A
 * timeout is the thought's (retry it later); a 429 or 5xx is transient (pause and
 * retry the call); a 400 about the input's length (refusesLength, shared with
 * embed.ts) is the thought's; any other 4xx is fatal (stop the pass); a connection
 * error is transient; anything else is the thought's.
 *
 * `maxTokensFatal` (extract only): a 400 naming the answer budget
 * (max_tokens/max_completion_tokens) is about the REQUEST — the same shape goes to
 * every thought — so it is fatal rather than read as this thought's length
 * (refusesLength matches "tokens") and failing the pool one row at a time.
 */
export function classifyError(e: unknown, opts: { maxTokensFatal?: boolean } = {}): ErrorKind {
  const status = (e as { status?: number }).status;
  const msg = (e as Error).message ?? "";
  const name = (e as Error).name ?? "";
  if (name === "TimeoutError" || /timed out/i.test(msg)) return "thought";
  if (status === 429 || (status !== undefined && status >= 500)) return "transient";
  if (opts.maxTokensFatal && status === 400 && /max_tokens|max_completion_tokens|completion tokens/i.test(msg)) return "fatal";
  if (status === 400 && refusesLength(status, msg)) return "thought";
  if (status !== undefined && status >= 400 && status < 500) return "fatal";
  if (/ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENOTFOUND|fetch failed|Unable to connect|socket/i.test(msg)) return "transient";
  return "thought";
}

// ── Outages (SMD-2599) ───────────────────────────────────────────────────────

/**
 * Whether a database error says the database is not answering, rather than
 * that a statement is wrong: a --follow worker waits the first out and stops
 * on the second, as it always has. Bun's client throws a PostgresError either
 * way (measured on Bun 1.4 against a restarted and a stopped Postgres): the
 * client's own codes for a connection refused, closed or timed out, and the
 * server's SQLSTATE for a connection exception (class 08), an administrator's
 * or a crash's shutdown and "starting up" (57P01–57P03), and too many
 * connections (53300). A syntax error, a missing function or a constraint is
 * none of these, and still ends the run.
 */
export function databaseUnavailable(e: unknown): boolean {
  const { name, code, errno } = (e ?? {}) as { name?: string; code?: unknown; errno?: unknown };
  if (name !== "PostgresError" && name !== "SQLError") return false;
  if (typeof code === "string" && /^ERR_POSTGRES_(CONNECTION_|IDLE_TIMEOUT|LIFETIME_TIMEOUT)/.test(code)) return true;
  return typeof errno === "string" && (errno.startsWith("08") || ["57P01", "57P02", "57P03", "53300"].includes(errno));
}

/**
 * Whether a database error is one no wait mends (SMD-2599, review pass 4):
 * a statement or object the server refuses — SQLSTATE class 42 (a function
 * or table missing, a privilege revoked) or 28 (authorization) — or a
 * database or schema that does not exist (3D000, 3F000). A follower's worker
 * ends the run on one of these, as the pass's own errors do; anything else
 * not databaseUnavailable's — a statement or lock timeout, out of memory or
 * disk, a serialization failure — costs that worker its poll, as before.
 */
export function databasePermanent(e: unknown): boolean {
  const { name, errno } = (e ?? {}) as { name?: string; errno?: unknown };
  if (name !== "PostgresError" && name !== "SQLError") return false;
  return typeof errno === "string" && (errno.startsWith("42") || errno.startsWith("28") || errno === "3D000" || errno === "3F000");
}

/**
 * The provider's own words in an error, without the message's lead (which
 * names the base URL): a ProviderError's `body`, or what follows
 * "failed: <status> " in the workers' own call errors (entities.ts,
 * judgePair).
 */
function providerWords(e: unknown): string {
  const body = (e as { body?: unknown }).body;
  if (typeof body === "string" && body) return body;
  return /\bfailed: \d{3} ([\s\S]*)$/.exec((e as Error).message ?? "")?.[1] ?? "";
}

/**
 * Whether a provider error says the MODEL is not there (SMD-2599): a 404
 * whose own words name a model as not found — Ollama's `model "x" not found,
 * try pulling it first`, OpenAI's and vLLM's `The model `x` does not exist`
 * or `model_not_found`. A 404 that names no model is a wrong base URL
 * (Ollama's `404 page not found`) and stays fatal. classifyError calls both
 * fatal; a --follow worker that has seen the model answer at start reads
 * this one as the provider's state — Ollama pulling or swapping the model —
 * and waits it out.
 */
export function modelMissing(e: unknown): boolean {
  if ((e as { status?: number }).status !== 404) return false;
  return /model_not_found|\bmodel\b[^\n]{0,160}?\b(not found|does not exist)/i.test(providerWords(e));
}

/**
 * Whether a provider error is modelMissing's and its words name `model` — the
 * model an outage then probes, where the escalation model went missing
 * after the start (review pass 2).
 */
export function missingModelIs(e: unknown, model: string): boolean {
  return modelMissing(e) && quotedNames(providerWords(e)).some((name) => sameModel(name, model));
}

/**
 * Whether two model names are one model: equal, or one the other with
 * Ollama's implied `:latest` tag. Compared whole — `qwen3` is not
 * `qwen3:32b`, which a substring test read as one (review pass 3).
 */
export function sameModel(a: string, b: string): boolean {
  return a === b || a === `${b}:latest` || b === `${a}:latest`;
}

/**
 * The names a provider's words quote — `model "x" not found`, "The model
 * `x` does not exist" — read from the error message of a JSON body when it
 * is one, so the body's own JSON quoting is not read as names.
 */
function quotedNames(words: string): string[] {
  let text = words;
  try {
    const body = JSON.parse(words) as { error?: unknown; message?: unknown };
    const err = body?.error as { message?: unknown } | string | undefined;
    const message = typeof err === "string" ? err : typeof err?.message === "string" ? err.message : typeof body?.message === "string" ? body.message : undefined;
    if (typeof message === "string") text = message;
  } catch {
    // Not JSON: the words as they came.
  }
  return [...text.matchAll(/["'`\u201c\u201d]([^"'`\u201c\u201d\s]+)["'`\u201c\u201d]/g)].map((m) => m[1]);
}

/** Whether a provider error is a call's deadline passing — classifyError's "thought" for a timeout. */
export function timedOut(e: unknown): boolean {
  return (e as Error).name === "TimeoutError" || /timed out/i.test((e as Error).message ?? "");
}

/**
 * The probe's whole prompt. Fixed, and no thought's: the probe sends nothing
 * of the brain's, so the egress gate (which governs a row's text) has nothing
 * to read in it. The suites' stub providers answer it apart from a real call.
 */
export const PROBE_PROMPT = "Reply with the word OK.";

/**
 * What one probe found. `up`: the model answered, or the provider answered a
 * way the next real call will judge (a 400 for the probe's own `max_tokens`,
 * say). `out`: no answer, a timeout, a 429 or a 5xx. `missing`: a 404 naming
 * the model. `refused`: a 401, 402 or 403 (the key), or a 404 naming no model
 * (the base URL).
 */
export type Probe = { state: "up" } | { state: "out" | "missing" | "refused"; why: string };

/**
 * One chat call of one token to `model` at `endpoint` (SMD-2599): the check a
 * --follow worker makes at start and while it waits out an outage. A chat
 * call, not preflight's GET /models: Ollama answers /models while its chat
 * endpoint answers 503 (busy) or the model is still being pulled, so only the
 * call the pass makes says the pass can go on.
 */
export async function probeChat(endpoint: Pick<ProviderEndpoint, "base" | "headers">, model: string, timeoutMs: number, wake?: AbortSignal): Promise<Probe> {
  let r: Response;
  try {
    r = await fetch(`${endpoint.base}/chat/completions`, {
      method: "POST",
      headers: endpoint.headers,
      body: JSON.stringify({ model, messages: [{ role: "user", content: PROBE_PROMPT }], max_tokens: 1 }),
      // The probe's deadline is the one deadline, as the workers' calls' are;
      // `wake` (the pass's stop) ends it sooner, as "out".
      signal: wake ? AbortSignal.any([AbortSignal.timeout(timeoutMs), wake]) : AbortSignal.timeout(timeoutMs),
      timeout: false,
    });
  } catch (e) {
    if (wake?.aborted) return { state: "out", why: "the probe was stopped" };
    return { state: "out", why: timedOut(e) ? `no answer to a one-token call in ${timeoutMs / 1000} s` : (e as Error).message };
  }
  let words = "";
  let unread = false;
  try {
    words = (await r.text()).slice(0, 300);
  } catch {
    unread = true;
  }
  const why = `${r.status} ${words}`.trimEnd();
  // An answer whose body never arrived is a provider hung mid-answer, not
  // one that answered (review pass 2) — whatever its status: an unread 404
  // cannot be told from a wrong URL, nor an unread 401 from a key refused
  // (review pass 3).
  if (unread) return { state: "out", why: `${r.status}, and the answer did not arrive` };
  if (r.ok) return { state: "up" };
  if (r.status === 429 || r.status >= 500) return { state: "out", why };
  if (modelMissing({ status: r.status, body: words })) return { state: "missing", why };
  if (r.status === 404 || r.status === 401 || r.status === 402 || r.status === 403) return { state: "refused", why };
  return { state: "up" };
}

/**
 * A call that failed where the probe after it got no answer either: thrown
 * by a worker that reads its own timeouts (consolidate's pairs) so the
 * worker's catch takes it for the outage it is (SMD-2599).
 */
export class ProviderDown extends Error {
  override name = "ProviderDown";
}

/**
 * Whether the provider lists `model` (SMD-2599, review pass 3): GET /models,
 * which loads no model, where a chat probe of a large escalation model loaded
 * it at every start and evicted the model the first call needs. `listed`
 * when a listed id is the model (`sameModel`). `unlisted` only when the list
 * names models by the names chat takes — `reference`, a model chat has just
 * answered for, is listed by its own name — and no listed id shares the
 * model's base, the name before its last `:` tag (review pass 4: Gemini
 * lists `models/<name>`, llama-server one alias for any name, OpenRouter
 * not its `:nitro` variants, so an unlisted id there proved nothing).
 * Anything else — another status, another shape, no answer — is `unknown`.
 */
export async function modelListed(endpoint: Pick<ProviderEndpoint, "base" | "headers">, model: string, reference: string, timeoutMs: number, wake?: AbortSignal): Promise<"listed" | "unlisted" | "unknown"> {
  try {
    const r = await fetch(`${endpoint.base}/models`, {
      method: "GET",
      headers: endpoint.headers,
      signal: wake ? AbortSignal.any([AbortSignal.timeout(timeoutMs), wake]) : AbortSignal.timeout(timeoutMs),
      timeout: false,
    });
    if (!r.ok) return "unknown";
    const body = (await r.json()) as { data?: unknown };
    if (!Array.isArray(body?.data) || body.data.length === 0) return "unknown";
    const ids = body.data.map((m) => (m as { id?: unknown })?.id).filter((id): id is string => typeof id === "string");
    if (ids.length === 0) return "unknown";
    if (ids.some((id) => sameModel(id, model))) return "listed";
    if (!ids.some((id) => sameModel(id, reference))) return "unknown";
    const base = model.includes(":") ? model.slice(0, model.lastIndexOf(":")) : model;
    return ids.some((id) => id === base || id.startsWith(`${base}:`)) ? "unknown" : "unlisted";
  } catch {
    return "unknown";
  }
}

/** Whether a probe found the provider still out: no answer, or the model missing. */
export function isOut(p: Probe): p is Extract<Probe, { why: string }> {
  return p.state === "out" || p.state === "missing";
}

/**
 * Probe on outageWait's schedule until a probe `settles` (SMD-2599), and
 * return that probe — null when `wake` aborted first. An outage settles on anything
 * but out or missing (`isOut`): up, or refused, which the next real call
 * meets and turns into the run's refusal. The start's wait settles on
 * anything but out, so a model the provider turns out not to serve, once it
 * answers, is refused there rather than waited on for ever (review pass 2).
 */
export async function probeUntil(probe: () => Promise<Probe>, wake: AbortSignal, settles: (p: Probe) => boolean, sleep: (ms: number, wake: AbortSignal) => Promise<void> = sleepUnless): Promise<Probe | null> {
  for (let step = 0; ; step++) {
    await sleep(outageWait(step), wake);
    if (wake.aborted) return null;
    const p = await probe();
    if (settles(p)) return p;
  }
}

/**
 * How long after a probe answered a thought in hand at the outage still
 * counts as "right after": the pauses (65 s) and a slow model call or two
 * past the re-claim, which comes first in the pool (the row keeps its
 * enqueued_at).
 */
export const SUSPECT_WINDOW_MS = 15 * 60_000;

/**
 * A --follow worker's provider outage (SMD-2599): why it began, and the
 * thoughts in hand when it did. While `reason` is set the pass stops after
 * the thought in hand and the follower probes; `end()` clears it when a probe
 * answers. A thought in hand at an outage goes back to the pool, not failed —
 * but one that draws a provider error again right after the provider has
 * answered a probe is the thought's own (a document that crashes the server
 * every time), and `begin` says so, so it is recorded failed and visible
 * rather than cycling through the pool for ever. "Right after" is within
 * SUSPECT_WINDOW_MS of the probe that answered: a thought another process
 * finished meanwhile, and an edit re-queued hours later, meets a later
 * outage as any other thought does (review pass 1).
 */
export class ProviderOutage {
  reason: string | null = null;
  private endedAt = 0;
  /** Thoughts in hand at the latest outage; a new outage clears them, so an earlier one's are no longer "right after". */
  private suspects = new Set<string>();

  /** `now` is the clock; the suite's own, to run the window without the wall clock. */
  constructor(private readonly now: () => number = Date.now) {}

  /** Begin, or join, an outage over `thoughtId`'s error — "outage" — or say it is the thought's: "thought". */
  begin(reason: string, thoughtId?: string): "outage" | "thought" {
    if (thoughtId !== undefined && this.reason === null && this.suspects.has(thoughtId) && this.now() - this.endedAt <= SUSPECT_WINDOW_MS) {
      this.suspects.delete(thoughtId);
      return "thought";
    }
    if (this.reason === null) {
      this.suspects.clear();
      this.reason = reason;
    }
    if (thoughtId !== undefined) this.suspects.add(thoughtId);
    return "outage";
  }

  /** A probe answered. */
  end(): void {
    this.reason = null;
    this.endedAt = this.now();
  }

  /** A thought finished — succeeded, or recorded failed — and is a suspect no longer. */
  settled(thoughtId: string): void {
    this.suspects.delete(thoughtId);
  }
}

/** The wait between a follower's checks during an outage: 5 s, doubling, at most 5 min. */
export const OUTAGE_FIRST_MS = 5_000;
export const OUTAGE_MAX_MS = 300_000;

/** The wait before check `step` (0 first) of an outage. */
export function outageWait(step: number): number {
  return Math.min(OUTAGE_MAX_MS, OUTAGE_FIRST_MS * 2 ** Math.min(step, 16));
}

/**
 * Wait an outage out (SMD-2599): sleep, then `check`, on outageWait's
 * schedule, until a check resolves — true — or `wake` aborts — false, the
 * caller's stop. A check that throws what `outage` says is still the outage
 * waits again; anything else is thrown, so a database that answers with a
 * refusal (a password changed while it was down) ends the run rather than
 * being waited on for ever.
 */
export async function waitOut(opts: {
  check: () => Promise<unknown>;
  outage: (e: unknown) => boolean;
  wake: AbortSignal;
  /** db/lease.ts's sleepUnless; the suite's own, to run the schedule without the wall clock. */
  sleep?: (ms: number, wake: AbortSignal) => Promise<void>;
}): Promise<boolean> {
  const sleep = opts.sleep ?? sleepUnless;
  for (let step = 0; ; step++) {
    await sleep(outageWait(step), opts.wake);
    if (opts.wake.aborted) return false;
    try {
      await opts.check();
      return true;
    } catch (e) {
      if (!opts.outage(e)) throw e;
    }
  }
}
