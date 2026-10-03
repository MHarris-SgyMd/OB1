// What every operation runs against (SMD-2283): the store, the model provider's
// settings and the embedder over them, and the opt-in query log. Built once by
// a server's composition root — index.ts today, the REST core (SMD-2284) next —
// from two readers it owns: the environment, read lazily because Workers
// bindings arrive per request, and the store, built on first use.

import { createEmbedder, resolveEmbedConfig, type EmbedConfig, type EmbedEnv, type Embedder } from "../embed.ts";
import type { JevEnv } from "../jev.ts";
import type { StoreEnv, ThoughtStore } from "../store.ts";
import { queryLogEnabled } from "../../db/config.mjs";
import type { Principal } from "../auth.ts";

/** The settings the core reads: the provider's, the store's, and the four of its own. root.ts's `Env` is one. */
export type CoreEnv = EmbedEnv & JevEnv & StoreEnv & {
  OB1_TIER?: string;
  OB1_GIT_SHA?: string;
  OB1_QUERY_LOG?: string;
  OPEN_BRAIN_CITATION_BASE_URL?: string;
};

export interface CoreDeps {
  /** The environment, frozen by the caller before the first operation runs. */
  env(): CoreEnv;
  /** The store, one instance per process; the caller owns its lifecycle (the pool, the stop). */
  store(): Promise<ThoughtStore>;
  /** The door every write names in its actor (`via`), which migration 046 stamps as thought_audit.origin (SMD-1730): the server's own name. */
  door: string;
}

/** One row of the action log: a tool name and the thought it touched or cited. */
export type ActionRow = { tool: string; targetId: string };

export interface Ctx {
  env(): CoreEnv;
  store(): Promise<ThoughtStore>;
  /** The door a write records as its origin (CoreDeps.door). */
  door: string;
  embedConfig(): EmbedConfig;
  /** The one embedder: it remembers whether the provider refused a whole-content embedding, a property of the model. */
  embedder: Embedder;
  citationBase(): string;
  /** The search's query_log row (migration 034); best-effort, a no-op unless OB1_QUERY_LOG=on. */
  logSearch(principal: Principal, tool: string, args: SearchLogArgs, data: { id: string; score?: number | null }[]): Promise<void>;
  /** The action-log rows of one call, in one write; best-effort, a no-op unless OB1_QUERY_LOG=on. */
  logActions(principal: Pick<Principal, "agentId">, rows: ActionRow[]): Promise<void>;
}

export type SearchLogArgs = { query: string; limit: number; threshold: number; recencyWeight: number; filter: Record<string, unknown>; arm: string };

/**
 * The cite rows of one write (SMD-1719): one per distinct id it named as a
 * source, lower-cased before the dedup (UUID_RE admits either case, and two
 * spellings of one id are one cite), tool `<writer>/<pointer>`, first pointer
 * wins for an id named twice. Returns the rows so a caller can batch them with
 * its own.
 */
export function citeRows(writer: string, pointers: { derived_from?: string[]; supersedes?: string }): ActionRow[] {
  const rows = new Map<string, string>();
  for (const id of pointers.derived_from ?? []) rows.set(id.toLowerCase(), `${writer}/derived_from`);
  if (pointers.supersedes) {
    const id = pointers.supersedes.toLowerCase();
    if (!rows.has(id)) rows.set(id, `${writer}/supersedes`);
  }
  return [...rows].map(([targetId, tool]) => ({ tool, targetId }));
}

export function createContext(deps: CoreDeps): Ctx {
  // How each provider-side setting is resolved from the environment lives in
  // embed.ts (resolveEmbedConfig), because db/reembed.ts must resolve them the
  // same way; this reader is lazy so Cloudflare Workers bindings still apply.
  const embedConfig = () => resolveEmbedConfig(deps.env());
  // The pipeline tier this server runs as (SMD-1806), stamped on every
  // query_log row so the canary — which replays stable's log — can tell a
  // stable-written row from its own. Unset is a plain brain (the row's tier is NULL).
  const tier = (): string | undefined => deps.env().OB1_TIER?.trim() || undefined;

  // The opt-in query log (migration 034, SMD-1295). Off unless OB1_QUERY_LOG=on,
  // and best-effort either way: a log write is never allowed to fail a search, a
  // fetch or a capture, so every call is guarded and every rejection swallowed.
  // The flag is read from the boot-time env snapshot (the caller freezes it on
  // the first request), so it is set at start-up, not toggled per request.
  // Nothing here reads the log back — the export tool does, offline.
  //   The write is awaited on the request's hot path, deliberately (SMD-1492).
  // Fire-and-forget or an in-process queue would shave a local INSERT off the
  // latency, but either can drop a row when the isolate is torn down or the
  // process dies — and SMD-1806 replays this log to build the canary, where a
  // dropped row is a lost replay. The added cost is measured in db/bench-querylog.ts
  // and kept; a cheaper insert path (a BRIN prune index in place of 047's btree)
  // is the follow-up (SMD-1950), not a durability trade here. On Workers, executionCtx
  // .waitUntil would keep the write durable and off the response path, but it is
  // not plumbed to the handlers today and the dogfood runs Bun, which has no
  // equivalent (deferred).
  const logSearch: Ctx["logSearch"] = async (principal, tool, args, data) => {
    if (!queryLogEnabled(deps.env())) return;
    try {
      await (await deps.store()).logSearch({
        tool,
        agentId: principal.agentId,
        query: args.query,
        matchCount: args.limit,
        threshold: args.threshold,
        recencyWeight: args.recencyWeight,
        filter: args.filter,
        resultIds: data.map((t) => t.id),
        resultScores: data.map((t) => t.score ?? null),
        arm: args.arm,
        tier: tier(),
      });
    } catch {
      // best-effort: a log failure must never reach the caller.
    }
  };
  // `tool` is the action's kind as well as its writer. A plain tool name —
  // `fetch`, `update_thought`, `delete_thought` — says the caller opened or
  // touched the target (034's click-through). `<writer>/<pointer>` —
  // `capture_thought/derived_from`, `capture_thought/supersedes`,
  // `update_thought/supersedes` — says the writer named the target as a source
  // and the database accepted the pointer (SMD-1719's cite). evals/utilization.ts
  // splits cited from opened on the `/` alone, so a new writer that cites names
  // itself the same way and is counted without a code change there.
  const logActions: Ctx["logActions"] = async (principal, rows) => {
    if (!queryLogEnabled(deps.env()) || rows.length === 0) return;
    try {
      // One round trip and one writer for the batch, whatever its size: a
      // synthesis citing forty sources is forty rows in one INSERT, not forty
      // on the pool, and there is one INSERT shape per store to keep right,
      // no single-row twin to drift from it. Best-effort as a whole: a
      // failure drops the batch, never the write it followed.
      await (await deps.store()).logActions(rows.map((r) => ({ tool: r.tool, agentId: principal.agentId, targetId: r.targetId, tier: tier() })));
    } catch {
      // best-effort.
    }
  };

  return {
    env: deps.env,
    store: deps.store,
    door: deps.door,
    embedConfig,
    // How a capture becomes vectors — chunking, the blurb rule, the prompt
    // template, the whole-content-then-head-window fallback, the width check —
    // is embed.ts, shared with db/reembed.ts so a re-embed produces exactly
    // what a capture would.
    embedder: createEmbedder(embedConfig),
    citationBase: () => deps.env().OPEN_BRAIN_CITATION_BASE_URL || "https://openbrain.local/thoughts",
    logSearch,
    logActions,
  };
}
