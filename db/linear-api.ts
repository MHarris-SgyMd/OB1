/**
 * linear-api.ts — the one Linear GraphQL client the fork's tools share.
 *
 * evals/build-linear-corpus.ts (the eval corpus) and db/sync-linear.ts (the
 * board in the brain, SMD-1954) both dial api.linear.app; until SMD-1954's third
 * review pass each carried its own copy of the access rule — the endpoint, the
 * raw-vs-Bearer authorization, the "errors arrive with HTTP 200" reading — the
 * value defined twice this fork keeps finding. One definition here, under db/
 * (the fifth pass moved it from evals/) so the sync's container mounts db/ and
 * server-portable/ and nothing else.
 *
 * The client returns data AND errors: Linear answers a partial query with both
 * (one refused alias beside forty-nine good ones), and a caller decides whether
 * a partial answer is an answer. `strict` is the caller that says no.
 */

export const LINEAR_API = "https://api.linear.app/graphql";

/** A GraphQL answer as Linear sends it: data and errors can both be present (HTTP 200 either way). */
export type GqlResult<T> = { data: T | null; errors: { message: string; path?: (string | number)[] }[] };
export type Gql = <T>(query: string, variables?: Record<string, unknown>) => Promise<GqlResult<T>>;

/** A client over one key. Personal API keys (`lin_api_…`) go in Authorization raw; OAuth tokens take Bearer. */
export function linearClient(key: string, fetchImpl: typeof fetch = fetch): Gql {
  const auth = key.startsWith("lin_api_") ? key : `Bearer ${key}`;
  return async <T>(query: string, variables: Record<string, unknown> = {}): Promise<GqlResult<T>> => {
    const res = await fetchImpl(LINEAR_API, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Linear returned HTTP ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { data?: T | null; errors?: { message: string; path?: (string | number)[] }[] };
    return { data: json.data ?? null, errors: json.errors ?? [] };
  };
}

/** The answer, or the error — for the queries where a partial answer is no answer. */
export async function strict<T>(gql: Gql, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const r = await gql<T>(query, variables);
  if (r.errors.length) throw new Error(`Linear GraphQL error: ${r.errors.map((e) => e.message).join("; ")}`);
  if (r.data === null) throw new Error("Linear returned no data and no errors, which should not happen.");
  return r.data;
}
