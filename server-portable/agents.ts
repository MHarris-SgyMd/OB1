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
  /** Resolved, or resolvable later; `agentId` is undefined when the registry could not answer. */
  | { status: "ok"; agentId?: string }
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
    private readonly now: () => number = Date.now
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
        ttl = this.ttlMs;
      } else if (r.error === "REVOKED") {
        outcome = { status: "revoked", agentId: r.agentId, revokedAt: r.revokedAt, reason: r.reason };
        // Not cached for the full TTL: a revocation lifted by hand should take
        // effect about as fast as one applied.
        ttl = failureTtl(this.ttlMs);
      } else {
        // BAD_KEY_HASH, BAD_LABEL, MALFORMED_RESPONSE. A refusal of the ARGUMENT,
        // not of the caller — auth.ts already validated the digest's shape, so
        // reaching here means the schema and the server disagree. Serve without
        // an agent id rather than locking everyone out over a shape mismatch.
        outcome = { status: "ok", agentId: undefined };
        ttl = failureTtl(this.ttlMs);
      }
    } catch {
      // Unreachable, unmigrated, or misconfigured. See the header.
      outcome = { status: "ok", agentId: undefined };
      ttl = failureTtl(this.ttlMs);
    }

    if (ttl > 0) this.cache.set(key, { outcome, expires: this.now() + ttl });
    return outcome;
  }

  /** Drop everything cached. For tests, and for a deployment that wants a signal. */
  clear(): void {
    this.cache.clear();
  }
}

/** Parse OB1_AGENT_CACHE_TTL_MS, falling back rather than failing on nonsense. */
export function cacheTtlFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_CACHE_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CACHE_TTL_MS;
}
