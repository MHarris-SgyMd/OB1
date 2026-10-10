// The transport-free core (SMD-2283): every tool's logic as a function of a
// principal and a typed input, bound once to the context a server builds. The
// MCP registration in ../index.ts validates (the SDK runs SPECS' zod), calls an
// operation and renders its answer; the REST core (SMD-2284) will call the
// same operations and answer JSON — one gateway, not two (SMD-1931).

import { createContext, type CoreDeps, type Ctx } from "./context.ts";
import * as reads from "./reads.ts";
import * as writes from "./writes.ts";
import * as workers from "./workers.ts";
import type { PluginSql } from "../store.ts";

export type { CoreDeps, CoreEnv, Ctx } from "./context.ts";
export type { Outcome, Refusal, RefusalCode, Failure } from "./refusal.ts";
export { failure } from "./refusal.ts";
export { SPECS, type Input, type ToolSpec } from "./schemas.ts";
export { CALLS, pathFields, type Call, type CallOptions, type CoreAnswer } from "./calls.ts";
export { enabledHooks, hookSecrets, loadPlugins, runHook, runOperation, type LoadedHook, type LoadedOp, type LoadedPlugin } from "./plugins.ts";

/** The operations, each taking the caller's principal and the tool's typed input. */
export function createCore(deps: CoreDeps) {
  const ctx: Ctx = createContext(deps);
  return {
    search: bind(ctx, reads.search),
    fetch: bind(ctx, reads.fetchThought),
    searchThoughts: bind(ctx, reads.searchThoughts),
    searchThoughtsKeyword: bind(ctx, reads.searchThoughtsKeyword),
    listThoughts: bind(ctx, reads.listThoughts),
    listSupersessionProposals: bind(ctx, reads.listSupersessionProposals),
    thoughtStats: bind(ctx, reads.thoughtStats),
    thoughtChanges: bind(ctx, reads.thoughtChanges),
    listThoughtIds: bind(ctx, reads.listThoughtIds),
    listLoggedSearches: bind(ctx, reads.listLoggedSearches),
    workerStatus: bind(ctx, reads.workerStatus),
    brainInfo: reads.brainInfoReader(ctx),
    jobStatus: bind(ctx, reads.jobStatus),
    scanThoughts: bind(ctx, reads.scanThoughts),
    capture: bind(ctx, writes.capture),
    updateThought: bind(ctx, writes.updateThought),
    deleteThought: bind(ctx, writes.deleteThought),
    resetCaptureStamp: bind(ctx, writes.resetCaptureStamp),
    retryFailed: bind(ctx, workers.retryFailed),
    releaseStaleLeases: bind(ctx, workers.releaseStaleLeases),
    runWorker: bind(ctx, workers.runWorker),
    /**
     * A plugin's own tables (SMD-2310): a transaction as its role, in its
     * schema (store-sql.ts's pluginTx). The store has none on PostgREST, and
     * says so when a plugin asks.
     */
    pluginTx: async <T>(plugin: string, fn: (sql: PluginSql) => Promise<T>): Promise<T> => {
      const store = await ctx.store();
      if (!store.pluginTx) throw new Error(`a plugin's tables need the SQL store; this brain runs the ${store.kind} store`);
      return store.pluginTx(plugin, fn);
    },
  };
}

export type Core = ReturnType<typeof createCore>;

function bind<A extends unknown[], R>(ctx: Ctx, op: (ctx: Ctx, ...args: A) => R): (...args: A) => R {
  return (...args) => op(ctx, ...args);
}
