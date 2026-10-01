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
import { hashKey, parseKeyRecords } from "../server-portable/auth.ts";
import { SqlStore } from "../server-portable/store-sql.ts";

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
 * makes: OB1_WORKER_KEY must be a key MCP_ACCESS_KEYS holds — one the server
 * would refuse is no identity here either — and the record's own name and scope
 * are what get registered. Resolution goes through the store's capped path
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
  const record = parseKeyRecords(env.MCP_ACCESS_KEYS).keys.find((k) => k.sha256 === hash);
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
