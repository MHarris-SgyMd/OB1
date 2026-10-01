// What an operation answers when it does not do what was asked (SMD-2283): a
// typed refusal, never a sentence. `code` says which rule; `retryable` is the
// transient/final split SMD-1978 gave the session hook; the other fields are
// the facts a renderer needs to say it — the MCP layer in prose, the REST core
// as JSON. A refusal is what the principal may be told: a field the existence-
// oracle rule (SMD-1298) withholds from a key is left off by the operation.

/**
 * Every refusal an operation returns. The SMD-1978 codes the session hook keys
 * on keep their names; the rest name the read tools' refusals, which carried no
 * code before SMD-2283.
 */
export type Refusal =
  // The read tools.
  | { code: "NOT_FOUND"; retryable: false; id: string }               // fetch: no such thought; job_status: no such job for this key
  | { code: "REFUSED_FILTER"; retryable: false; message: string }     // a metadata filter (or said_by/actor) the boundary refuses
  | { code: "REFUSED_EGRESS"; retryable: false; rule: string; reason: string; actor: string } // the query may not leave for its embedding (SMD-1903)
  | { code: "REFUSED_SINCE"; retryable: false; value: string }        // a `since` that is neither a time nor a cursor
  | { code: "REFUSED_CURSOR"; retryable: false; value: string };      // list_thought_ids' `after` is not a thought id

export type RefusalCode = Refusal["code"];

/** An operation's answer: the typed value, or the refusal. A fault — the store down, a missing migration — is thrown, not returned. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

export const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
export const refuse = <T = never>(refusal: Refusal): Outcome<T> => ({ ok: false, refusal });

/**
 * A fault an operation threw, typed for a caller that wants a code: FAILED,
 * with the thrown message, and `retryable` when the fault is one a second
 * call can outlast (isTransient). A missing migration or grant is final, as
 * is anything unrecognised: telling a client to retry a fault that cannot heal
 * is the worse error.
 */
export type Failure = { code: "FAILED"; retryable: boolean; message: string; hint?: string };
export const failure = (err: unknown): Failure => ({ code: "FAILED", retryable: isTransient(err), message: (err as Error)?.message ?? String(err) });

/**
 * SQLSTATEs a retry can outlast: a lost connection (class 08), the server
 * shutting down or not yet up (57P01–57P03), out of resources (class 53, e.g.
 * too many connections), a statement or lock timeout under load (57014,
 * 55P03), and a serialization failure or deadlock (40001, 40P01).
 */
const TRANSIENT_SQLSTATE = /^(08...|57P0[123]|53...|57014|55P03|40001|40P01)$/;
/** Socket-level codes a fetch (the provider, PostgREST) rejects with when the far end is away. */
const TRANSIENT_SOCKET = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ConnectionRefused", "ConnectionClosed"]);

/**
 * Whether a thrown fault is transient. Read off the shapes the drivers throw,
 * measured (SMD-2283 review pass 2): Bun's PostgresError keeps the SQLSTATE in
 * `errno` with `code` ERR_POSTGRES_SERVER_ERROR, and names a connection that
 * closed or was refused in `code` (ERR_POSTGRES_CONNECTION_CLOSED,
 * ERR_POSTGRES_CONNECTION_REFUSED); embed.ts's ProviderError says `timeout`, or
 * `http` with the status (429 and 5xx heal, the rest of 4xx do not).
 */
export function isTransient(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; code?: unknown; errno?: unknown; kind?: unknown; status?: unknown };
  if (typeof e.errno === "string" && TRANSIENT_SQLSTATE.test(e.errno)) return true;
  if (typeof e.code === "string" && (/^ERR_POSTGRES_CONNECTION_/.test(e.code) || /^ERR_POSTGRES_.*TIMEOUT$/.test(e.code) || TRANSIENT_SOCKET.has(e.code))) return true;
  if (e.name === "ProviderError") return e.kind === "timeout" || (e.kind === "http" && typeof e.status === "number" && (e.status === 429 || e.status >= 500));
  return false;
}
