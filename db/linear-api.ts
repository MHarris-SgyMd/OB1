/**
 * linear-api.ts — the one Linear GraphQL client Daemonic Brain's tools share.
 *
 * evals/build-linear-corpus.ts (the eval corpus) and db/sync-linear.ts (the
 * board in the brain, SMD-1954) both dial api.linear.app; until SMD-1954's third
 * review pass each carried its own copy of the access rule — the endpoint, the
 * raw-vs-Bearer authorization, the "errors arrive with HTTP 200" reading — the
 * value defined twice Daemonic Brain keeps finding. One definition here, under
 * db/ (SMD-1985 moved it from evals/) so SMD-1954's container mounts db/ and
 * server-portable/ and nothing else.
 *
 * The client returns data AND errors: Linear answers a partial query with both
 * (one refused alias beside forty-nine good ones), and a caller decides whether
 * a partial answer is an answer. `strict` is the caller that says no.
 */

export const LINEAR_API = "https://api.linear.app/graphql";

/** A GraphQL answer as Linear sends it: data and errors can both be present (HTTP 200 either way). */
export type GqlResult<T> = { data: T | null; errors: { message: string; path?: (string | number)[]; extensions?: { code?: unknown } }[] };
export type Gql = <T>(query: string, variables?: Record<string, unknown>) => Promise<GqlResult<T>>;

/**
 * Linear refused the request for its rate limit (SMD-4133): HTTP 429, or an
 * answer whose errors carry the code RATELIMITED. Linear limits by user, not
 * by key — 2,500 requests an hour, and a complexity budget beside it — so
 * every brain and tool under one Linear user spends the same hour, and a
 * refused request counts against it too. `resetAt` is when Linear says the
 * window has room again (epoch ms), from the exhausted limit's
 * `X-RateLimit-*-Reset` or a `Retry-After`; null when it said neither.
 */
export class LinearRateLimited extends Error {
  readonly resetAt: number | null;
  constructor(message: string, resetAt: number | null) {
    super(message);
    this.name = "LinearRateLimited";
    this.resetAt = resetAt;
  }
}

/**
 * When a rate-limited answer says the window has room again, in epoch ms, or
 * null. Linear sends `X-RateLimit-Requests-Reset` and
 * `X-RateLimit-Complexity-Reset` (epoch ms) with their `-Remaining`: the
 * exhausted one's reset is the time, and when neither reads exhausted, the
 * later of the two. `Retry-After` (seconds, or an HTTP date) when neither is
 * sent. A value that does not read as a time is no time.
 */
export function rateLimitReset(headers: Headers, now: number = Date.now()): number | null {
  const num = (name: string): number | null => {
    const raw = headers.get(name)?.trim();
    return raw && /^\d+$/.test(raw) ? Number(raw) : null;
  };
  const limits = (["requests", "complexity"] as const)
    .map((k) => ({ reset: num(`x-ratelimit-${k}-reset`), remaining: num(`x-ratelimit-${k}-remaining`) }))
    .filter((l): l is { reset: number; remaining: number | null } => l.reset !== null);
  const spent = limits.filter((l) => l.remaining === 0);
  const from = spent.length ? spent : limits;
  if (from.length) return Math.max(...from.map((l) => l.reset));
  const after = headers.get("retry-after")?.trim();
  if (!after) return null;
  if (/^\d+$/.test(after)) return now + Number(after) * 1000;
  const date = Date.parse(after);
  return Number.isFinite(date) ? date : null;
}

/** An error Linear's rate limit raised (LinearRateLimited), as any caller tells it from another failure. */
export const isRateLimited = (e: unknown): e is LinearRateLimited => e instanceof LinearRateLimited;

/**
 * A client over one key. Personal API keys (`lin_api_…`) go in Authorization
 * raw; OAuth tokens take Bearer. `url` is the endpoint (a test's stub; Linear's
 * otherwise), and `timeoutMs` bounds each request — db/board-findings.ts posts
 * inside the transaction that records the post, which a hung request would
 * hold open (SMD-2681); left out, a request waits as long as fetch does.
 */
export function linearClient(key: string, fetchImpl: typeof fetch = fetch, opts: { url?: string; timeoutMs?: number } = {}): Gql {
  const auth = key.startsWith("lin_api_") ? key : `Bearer ${key}`;
  const url = opts.url ?? LINEAR_API;
  return async <T>(query: string, variables: Record<string, unknown> = {}): Promise<GqlResult<T>> => {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      ...(opts.timeoutMs !== undefined ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
      // Never followed (SMD-2908): board-findings posts brain rows here under the egress gate, which judged this URL,
      // and the key rides along.
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      void res.body?.cancel().catch(() => {});
      // The target's host, when it names one: with no Location there is no target, not Linear's own host (review pass 3).
      const location = res.headers.get("location");
      let to = "";
      if (location !== null) {
        try {
          to = `, redirecting to ${new URL(location, url).host}`;
        } catch {
          to = ", redirecting to an address that does not parse";
        }
      }
      throw Object.assign(new Error(`Linear answered HTTP ${res.status}${to}: a redirect is never followed (SMD-2908)`), { status: res.status });
    }
    // A rate limit is said by its own error, with when Linear says to come back (SMD-4133): a caller holds off
    // until then rather than spending the same user's hour on requests that are refused too.
    const limited = (body: string) => new LinearRateLimited(`Linear returned HTTP ${res.status} ${res.statusText}, rate-limited: ${body.slice(0, 300)}`, rateLimitReset(res.headers));
    if (res.status === 429) throw limited(await res.text());
    const text = await res.text();
    type Body = { data?: T | null; errors?: GqlResult<T>["errors"] };
    let json: Body | null;
    try { json = JSON.parse(text) as Body; } catch { json = null; /* not JSON: said below for a non-2xx, thrown as JSON's error for a 2xx */ }
    if (json?.errors?.some((e) => e?.extensions?.code === "RATELIMITED")) throw limited(text);
    if (!res.ok) throw new Error(`Linear returned HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    const body: Body = json ?? (JSON.parse(text) as Body);
    return { data: body.data ?? null, errors: body.errors ?? [] };
  };
}

/** The answer, or the error — for the queries where a partial answer is no answer. */
export async function strict<T>(gql: Gql, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const r = await gql<T>(query, variables);
  if (r.errors.length) throw new Error(`Linear GraphQL error: ${r.errors.map((e) => e.message).join("; ")}`);
  if (r.data === null) throw new Error("Linear returned no data and no errors, which should not happen.");
  return r.data;
}
