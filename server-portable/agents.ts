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
 * On failure, this returns `{ agentId: undefined }` rather than throwing —
 * except on a lock (`busy`) or for a revocation already read, which are
 * refusals; the paragraph after next says why.
 *
 * That is deliberate and worth defending, because "the identity lookup failed,
 * so deny" is the reflex. Consider what a caller could actually gain: with the
 * registry unreachable, every tool this server exposes is also unreachable —
 * they all read or write the same database. Denying buys no protection and
 * costs a working `tools/list` during a blip, plus a confusing "Unauthorized"
 * for what is really an outage. A definitive REVOKED, by contrast, is an answer,
 * and it is enforced.
 *
 * The argument fails when ob1_agent_keys is locked while the thoughts are
 * not (a migration of that table, a transaction holding a key's row). The
 * lookup's lock waits are capped on the SQL store (RESOLVE_LOCK_TIMEOUT_MS),
 * so it times out there while every tool still answers, and serving by name
 * would serve a key the registry may have revoked. So a timeout is not an
 * outage: the lookup is retried for a short while (BUSY_RETRY, pausing with
 * no connection held), which waits out a brief lock as the uncapped wait did,
 * and past that the key is `busy` — not served, as it was not while the
 * uncapped wait lasted, and told to retry. And a revocation this process has
 * read stands through any failure, and any reply that is not an answer, until
 * the registry answers that the key is not revoked. A lock on ob1_agents
 * stalls every write anyway (046's audit trigger reads a writer's kind
 * there). A committed revocation is read before any write, so a row lock
 * does not delay it. Since migration 054 a key used in the last five minutes
 * and presenting its recorded scope writes nothing, so a held key row does
 * not delay its lookup, and a revocation that commits while a staler key's
 * write waits is answered REVOKED — under READ COMMITTED; under a stricter
 * isolation the write fails 40001, which is retried like a timeout
 * (SMD-2090).
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
 * The cap on each lock wait of one lookup, in ms: a ceiling the SQL store sets
 * in the lookup's own statement (store-sql.ts), a stricter role setting kept.
 * resolve_agent's waits are on the registry's relation locks and one key's
 * rows, which no other lookup holds for more than a moment; a wait past this
 * is a migration, a transaction holding them, or 046's backfill holding
 * ob1_agents FOR SHARE against a rename. Each wait is capped; a table lock
 * ends the lookup at its first. Short, since a lookup holds a pool connection
 * while it waits. Workers' PostgREST store sets none; its role's
 * statement_timeout, where set, is the cap there.
 */
export const RESOLVE_LOCK_TIMEOUT_MS = 250;

/**
 * How a lookup that times out on a lock is retried before the key is `busy`:
 * up to `attempts` lookups within `budgetMs` of the first, `pauseMs` apart
 * with no connection held. About two seconds waits out a migration's brief
 * lock (a CHECK added to a small table), which the uncapped wait used to, and
 * stays inside /health's 2.5 s deadline. Measured in real time, whatever clock
 * the cache reads; a lookup slower than the budget (Workers, whose cap is a
 * role's statement_timeout) is not retried at all.
 */
export const BUSY_RETRY = { attempts: 5, budgetMs: 2_000, pauseMs: 250 };
export type BusyRetry = typeof BUSY_RETRY;

/**
 * How long a `busy` answer is reused, bounded by the TTL like every non-success
 * answer (0 stays 0): long enough that a key's retries do not each spend the
 * retry budget again, on Workers above all, where lookups are not shared.
 */
const BUSY_TTL_MS = 1000;

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
  | { status: "revoked"; agentId: string; revokedAt: string; reason: string | null }
  /**
   * The lookup timed out on a lock (the registry there, but held) and this
   * process has no revocation for the key. Refused with a retry: the registry
   * could still say revoked.
   */
  | { status: "busy" };

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
    private readonly busyRetry: BusyRetry = BUSY_RETRY,
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
    // not got share it, retries included, so a burst of one key while the
    // registry is locked holds one pool connection for each capped wait, not
    // one each.
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
      const r = await this.resolveRetrying(await store, principal);

      if (r.ok) {
        outcome = { status: "ok", agentId: r.agentId };
        this.revocations.delete(principal.keyHash);
        this.warned.delete(key);
        ttl = this.ttlMs;
      } else if (r.error === "REVOKED") {
        outcome = { status: "revoked", agentId: r.agentId, revokedAt: r.revokedAt, reason: r.reason };
        this.revocations.set(principal.keyHash, outcome);
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
        // Not an answer that the key is not revoked, so a revocation read
        // before stands.
        const detail = String((r as { detail?: unknown }).detail ?? r.error);
        const revoked = this.revocations.get(principal.keyHash);
        if (revoked) {
          this.warnOnce(key, "revoked", `agent registry: resolve_agent refused key "${principal.name}" (${detail}) — its revocation stands until the registry answers`);
          outcome = revoked;
        } else {
          this.warnOnce(key, "refused", `agent registry: resolve_agent refused key "${principal.name}" (${detail}) — writes are attributed by name only; the label or digest the schema rejects will not pass on retry`);
          outcome = { status: "ok", agentId: undefined, unresolved: "refused" };
        }
        ttl = failureTtl(this.ttlMs);
      }
    } catch (e) {
      // Unreachable, unmigrated, misconfigured, or locked past the cap. See the
      // header. Said once per key and outcome while the failure lasts, so a
      // brain whose CHECK refuses a scope (049, SMD-1298) is not silent about
      // the unattributed writes, and a key that moves from one outcome to
      // another is said again.
      const cause = String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200);
      const revoked = this.revocations.get(principal.keyHash);
      if (revoked) {
        this.warnOnce(key, "revoked", `agent registry: resolve_agent failed for key "${principal.name}" — its revocation stands until the registry answers: ${cause}`);
        outcome = revoked;
        ttl = failureTtl(this.ttlMs);
      } else if (timedOut(e)) {
        this.warnOnce(key, "busy", `agent registry: resolve_agent timed out for key "${principal.name}" on a lock, retried for ${this.busyRetry.budgetMs} ms — its requests are refused with a retry until the registry answers: ${cause}`);
        outcome = { status: "busy" };
        ttl = Math.min(this.ttlMs, BUSY_TTL_MS);
      } else {
        this.warnOnce(key, "unreachable", `agent registry: resolve_agent failed for key "${principal.name}" — writes are attributed by name only until it answers: ${cause}`);
        outcome = { status: "ok", agentId: undefined, unresolved: "unreachable" };
        ttl = failureTtl(this.ttlMs);
      }
    }

    if (ttl > 0) this.cache.set(key, { outcome, expires: this.now() + ttl });
    return outcome;
  }

  /**
   * One lookup, retried while it times out on a lock (BUSY_RETRY) and this
   * process has no revocation for the key — a revocation answers at once. Each
   * pause holds no connection. Throws the last error.
   */
  private async resolveRetrying(store: ThoughtStore, principal: Principal): Promise<AgentResolution> {
    const started = performance.now();
    const { attempts, budgetMs, pauseMs } = this.busyRetry;
    for (let attempt = 1; ; attempt++) {
      try {
        return await store.resolveAgent({ keyHash: principal.keyHash, label: principal.name, scope: principal.scope });
      } catch (e) {
        const again = timedOut(e) && !this.revocations.has(principal.keyHash)
          && attempt < attempts && performance.now() - started + pauseMs < budgetMs;
        if (!again) throw e;
        await new Promise((r) => setTimeout(r, pauseMs));
      }
    }
  }

  /**
   * The revocations the registry has answered, by digest — a rename keeps the
   * digest, and the revocation with it. Kept apart from the cache and whatever
   * its TTL (0 included), read only when a lookup fails, and cleared by the
   * registry's next answer that the key is not revoked. The key space is the
   * configured key set, as for the cache.
   */
  private readonly revocations = new Map<string, Extract<AgentOutcome, { status: "revoked" }>>();

  /**
   * The outcome each failing key was last warned about; cleared when the
   * registry answers. One warning per key and outcome — the one dedupe rule
   * for every failure (tenth review pass) — so a change of outcome is said.
   */
  private readonly warned = new Map<string, string>();
  private warnOnce(key: string, kind: string, message: string): void {
    if (this.warned.get(key) === kind) return;
    this.warned.set(key, kind);
    console.warn(message);
  }

  /** Drop everything cached. For tests, and for a deployment that wants a signal. */
  clear(): void {
    this.cache.clear();
    this.revocations.clear();
    this.warned.clear();
  }
}

/**
 * Whether a lookup gave up on a lock: 55P03 (lock_timeout, the SQL store's
 * cap), 57014 (statement_timeout — a role's, as on Workers; or a cancel),
 * 40P01 (a deadlock with a migration taking the two tables in the other
 * order) or 40001 (a serialization failure: under a REPEATABLE READ or
 * SERIALIZABLE default, resolve_agent's write of a row another transaction
 * changed while it waited — a revocation among them — fails where READ
 * COMMITTED would have re-read it, and a fresh attempt answers; SMD-2090).
 * The SQLSTATE rides on `errno`: Bun's SQL sets it, and the PostgREST store
 * copies PostgREST's code there.
 */
function timedOut(e: unknown): boolean {
  const state = String((e as { errno?: unknown })?.errno ?? "");
  return state === "55P03" || state === "57014" || state === "40P01" || state === "40001";
}

/** Parse OB1_AGENT_CACHE_TTL_MS, falling back rather than failing on nonsense. */
export function cacheTtlFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_CACHE_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CACHE_TTL_MS;
}
