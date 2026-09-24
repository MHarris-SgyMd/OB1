/**
 * agents.ts — turning an access key into a stable agent id, without turning the
 * database into a second authenticator.
 *
 * The division of responsibility, which is the whole design:
 *
 *   auth.ts and MCP_ACCESS_KEYS decide whether a key is VALID and what it may
 *   do. That answer needs no database, so `tools/list` still works against a
 *   dead Postgres and a Workers deployment authenticates without a round trip.
 *
 *   ob1_agents and ob1_agent_keys decide WHO the key belongs to, and hold the
 *   one veto the environment cannot express quickly: `revoked_at`.
 *
 * The veto runs in one direction only. A digest revoked in the database is
 * refused even though the env still lists it; a digest absent from the env is
 * never accepted because the database knows it. So the two can disagree without
 * the disagreement ever widening access — which is what separates a second gate
 * from a second source of truth.
 *
 *
 * On failure, this returns `{ agentId: undefined }` rather than throwing.
 *
 * That is deliberate and worth defending, because "the identity lookup failed,
 * so deny" is the reflex. Consider what a caller could actually gain: with the
 * registry unreachable, every tool this server exposes is also unreachable —
 * they all read or write the same database. Denying buys no protection and
 * costs a working `tools/list` during a blip, plus a confusing "Unauthorized"
 * for what is really an outage. A definitive REVOKED, by contrast, is an answer,
 * and it is enforced.
 *
 * The argument has one gap, and it is closed separately: the registry's tables
 * locked while the thoughts are not (a migration of ob1_agent_keys, a
 * transaction holding a key's row). The lookup's lock wait is capped
 * (RESOLVE_LOCK_TIMEOUT_MS, SMD-2072), so the lookup times out there while
 * every tool still answers. On a timeout — the registry there but busy — a key
 * this process has had an answer for keeps that answer: its agent id, or its
 * revocation, which a lock must not lift. A key it has never had one for is
 * served by name, as for an unreachable database. Any other failure (no
 * connection, no resolve_agent) is served by name whatever came before: the
 * registry an old answer came from may be gone. Row locks never reach a
 * revoked key: its revocation is read before the UPDATE that waits.
 *
 * The same reasoning covers a deployment that has not applied migration 010:
 * `resolve_agent` does not exist, resolution fails, and attribution falls back
 * to the key's name in thought_audit.actor_name — precisely where it was before
 * 010, rather than a server that refuses to start.
 */

import type { Principal } from "./auth.ts";
import type { AgentResolution, ThoughtStore } from "./store.ts";

/**
 * How long a successful resolution is reused, in milliseconds.
 *
 * This is the delay between setting `revoked_at` and the key stopping, so it is
 * the one number an operator revoking a leaked credential cares about. Sixty
 * seconds keeps the steady-state cost at zero extra queries while keeping the
 * kill switch usefully fast. Set to 0 to resolve on every request.
 */
export const DEFAULT_CACHE_TTL_MS = 60000;

/**
 * The caps on one lookup (SMD-2072), set as ceilings in the transaction the
 * SQL store opens for it (store-sql.ts). resolve_agent reads a key's row and
 * UPDATEs it; the lock wait is the one wait it can have, and a second is
 * generous for a single-row write. Within /health's 2.5 s deadline (index.ts),
 * so a locked registry answers the probe before the deadline does. Workers'
 * PostgREST store runs under the role PostgREST connects as and sets neither.
 */
export const RESOLVE_LOCK_TIMEOUT_MS = 1_000;
export const RESOLVE_STATEMENT_TIMEOUT_MS = 2_000;

/**
 * A failed lookup is cached too, and far more briefly.
 *
 * Without this, a database that is down does not merely fail to resolve — it
 * fails slowly, on every request, adding a connection timeout to calls that
 * would otherwise have returned from memory. Ten seconds bounds the damage
 * while still recovering promptly once the database is back.
 */
const FAILURE_TTL_MS = 10000;

/**
 * How long a NON-success answer is reused.
 *
 * Bounded by the configured TTL rather than fixed, because
 * `OB1_AGENT_CACHE_TTL_MS=0` is documented as "resolve on every request" and a
 * hard 10s here quietly made that false for exactly the answers an operator
 * setting 0 is most likely to be debugging. Any nonzero setting still caps a
 * failure at ten seconds, so a dead database costs one connection attempt per
 * interval rather than one per request.
 */
function failureTtl(ttlMs: number): number {
  return Math.min(ttlMs, FAILURE_TTL_MS);
}

export type AgentOutcome =
  /**
   * Resolved, or resolvable later; `agentId` is undefined when the registry
   * could not answer — `unresolved` says why: `unreachable` (no connection,
   * not migrated, a CHECK refusing the scope; a retry may answer) or `refused`
   * (the registry answered and refused the argument — BAD_KEY_HASH, BAD_LABEL,
   * a malformed reply; a retry will not). capture_thought reads the difference
   * when a capture-only key's `supersedes` needs the id (SMD-1298).
   */
  | { status: "ok"; agentId?: string; unresolved?: "unreachable" | "refused" }
  /** The database refused this digest. The request must be rejected. */
  | { status: "revoked"; agentId: string; revokedAt: string; reason: string | null };

type Entry = { outcome: AgentOutcome; expires: number };

/**
 * Keyed by digest AND name, not by digest alone.
 *
 * A rename changes the name while the digest stays put, and that is exactly the
 * case resolve_agent() exists to record. Cache on the digest only and the first
 * request after a rename returns the cached entry, the rename is never sent,
 * and ob1_agents keeps the stale label until the TTL happens to expire.
 */
function cacheKey(keyHash: string, label: string): string {
  return `${keyHash} ${label}`;
}

export class AgentResolver {
  /**
   * Never evicted, and it does not need to be: resolution happens only AFTER
   * authentication succeeds, so a key must already be in MCP_ACCESS_KEYS to
   * create an entry. The key space is the configured key set, not anything a
   * caller controls, and an expired entry is overwritten rather than added to.
   */
  private cache = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number = DEFAULT_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
    /**
     * Whether concurrent requests of one key share a lookup. Off on Cloudflare
     * Workers (the PostgREST store): the runtime ties a fetch to the request
     * that started it, so a second request awaiting the first's lookup can
     * hang or see it cancelled when the first client goes (SMD-2041 review
     * pass 5). The SQL store's pool is shared by every request, as the lookup is.
     */
    private readonly shareLookups: boolean = true,
  ) {}

  /**
   * Resolve the principal's agent id, consulting the cache first.
   *
   * `store` is passed per call rather than held: index.ts builds the store
   * lazily on first use, and a resolver that captured it at construction would
   * force the connection open during startup — on Workers, before any request
   * has arrived to justify it.
   */
  async resolve(store: Promise<ThoughtStore>, principal: Principal): Promise<AgentOutcome> {
    const key = cacheKey(principal.keyHash, principal.name);
    const hit = this.cache.get(key);
    if (hit && hit.expires > this.now()) return hit.outcome;
    // One lookup in flight per key: concurrent requests of a key the cache has
    // not got share it, so a burst of one key while the registry's tables are
    // locked holds one pool connection for the lock wait, not one each
    // (SMD-2041), and the wait is capped (SMD-2072).
    if (!this.shareLookups) return this.lookup(store, principal, key);
    const shared = this.inflight.get(key);
    if (shared) return shared;
    const lookup = this.lookup(store, principal, key);
    this.inflight.set(key, lookup);
    try {
      return await lookup;
    } finally {
      if (this.inflight.get(key) === lookup) this.inflight.delete(key);
    }
  }

  private readonly inflight = new Map<string, Promise<AgentOutcome>>();

  private async lookup(store: Promise<ThoughtStore>, principal: Principal, key: string): Promise<AgentOutcome> {
    let outcome: AgentOutcome;
    let ttl: number;
    try {
      const r: AgentResolution = await (await store).resolveAgent({
        keyHash: principal.keyHash,
        label: principal.name,
        scope: principal.scope,
      });

      if (r.ok) {
        outcome = { status: "ok", agentId: r.agentId };
        this.lastAnswer.set(principal.keyHash, outcome);
        this.warned.delete(key);
        ttl = this.ttlMs;
      } else if (r.error === "REVOKED") {
        outcome = { status: "revoked", agentId: r.agentId, revokedAt: r.revokedAt, reason: r.reason };
        this.lastAnswer.set(principal.keyHash, outcome);
        this.warned.delete(key);
        // Not cached for the full TTL: a revocation lifted by hand should take
        // effect about as fast as one applied.
        ttl = failureTtl(this.ttlMs);
      } else {
        // BAD_KEY_HASH, BAD_LABEL, MALFORMED_RESPONSE. A refusal of the ARGUMENT,
        // not of the caller — auth.ts already validated the digest's shape, so
        // reaching here means the schema and the server disagree. Serve without
        // an agent id rather than locking everyone out over a shape mismatch —
        // and say so once per key: a retry will not change this answer, and
        // the tool's `Refused:` sends the operator to this log (eighth review pass).
        this.warnOnce(key, `agent registry: resolve_agent refused key "${principal.name}" (${String((r as { detail?: unknown }).detail ?? r.error)}) — writes are attributed by name only; the label or digest the schema rejects will not pass on retry`);
        outcome = { status: "ok", agentId: undefined, unresolved: "refused" };
        ttl = failureTtl(this.ttlMs);
      }
    } catch (e) {
      // Unreachable, unmigrated, misconfigured, or locked past the cap. See the
      // header. Said once per key while the failure lasts, so a brain whose
      // CHECK refuses a scope (049, SMD-1298) is not silent about the
      // unattributed writes.
      const cause = String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200);
      const last = timedOut(e) ? this.lastAnswer.get(principal.keyHash) : undefined;
      if (last) {
        this.warnOnce(key, `agent registry: resolve_agent failed for key "${principal.name}" — its last answer (${last.status === "revoked" ? "revoked" : `agent ${last.agentId}`}) stands until it answers: ${cause}`);
        outcome = last;
      } else {
        this.warnOnce(key, `agent registry: resolve_agent failed for key "${principal.name}" — writes are attributed by name only until it answers: ${cause}`);
        outcome = { status: "ok", agentId: undefined, unresolved: "unreachable" };
      }
      ttl = failureTtl(this.ttlMs);
    }

    if (ttl > 0) this.cache.set(key, { outcome, expires: this.now() + ttl });
    return outcome;
  }

  /**
   * The registry's last answer for each digest — an agent id or a revocation —
   * kept apart from the cache and whatever its TTL (0 included): it is read
   * only when a lookup times out (the header). By digest, not digest and name: a
   * rename keeps the agent and the revocation. The key space is the configured
   * key set, as for the cache.
   */
  private readonly lastAnswer = new Map<string, AgentOutcome>();

  /** Keys whose resolve threw and were warned about; cleared when one answers again. */
  private readonly warned = new Set<string>();
  /** Said once per key while the failure lasts — the one dedupe rule for both outcomes (tenth review pass). */
  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(message);
  }

  /** Drop everything cached. For tests, and for a deployment that wants a signal. */
  clear(): void {
    this.cache.clear();
    this.lastAnswer.clear();
    this.warned.clear();
  }
}

/**
 * Whether a lookup failed on the SQL store's caps: 55P03 (lock_timeout) or
 * 57014 (statement_timeout), the SQLSTATE Bun's SQL carries as `errno`. The
 * PostgREST store rethrows a message alone, and sets no caps.
 */
function timedOut(e: unknown): boolean {
  const state = String((e as { errno?: unknown })?.errno ?? "");
  return state === "55P03" || state === "57014";
}

/** Parse OB1_AGENT_CACHE_TTL_MS, falling back rather than failing on nonsense. */
export function cacheTtlFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_CACHE_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CACHE_TTL_MS;
}
