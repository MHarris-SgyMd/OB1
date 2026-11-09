// The transport-free core (SMD-2283): every tool's logic as a function of a
// principal and a typed input, bound once to the context a server builds. The
// MCP registration in ../index.ts validates (the SDK runs SPECS' zod), calls an
// operation and renders its answer; the REST core (SMD-2284) will call the
// same operations and answer JSON — one gateway, not two (SMD-1931).

import { createContext, type CoreDeps, type Ctx } from "./context.ts";
import * as reads from "./reads.ts";
import * as writes from "./writes.ts";
import * as workers from "./workers.ts";
import * as mend from "./mend.ts";
import * as claims from "./claims.ts";
import * as priority from "./priority.ts";
import * as threads from "./threads.ts";
import * as relations from "./relations.ts";
import * as items from "./items.ts";
import * as agendaRead from "./agenda.ts";
import { pluginChat, type ModelAnswer, type ModelRequest } from "./model.ts";
import { PROBE_WORD, startProviderReprobe } from "../provider-health.ts";
import { mayLeaveBox } from "../egress.ts";
import { resolveJevConfig } from "../jev.ts";
import type { PluginSql } from "../store.ts";

export type { CoreDeps, CoreEnv, Ctx } from "./context.ts";
export type { Outcome, Refusal, RefusalCode, Failure } from "./refusal.ts";
export { failure } from "./refusal.ts";
export { SPECS, type Input, type ToolSpec } from "./schemas.ts";
export { CALLS, pathFields, type Call, type CallOptions, type CoreAnswer } from "./calls.ts";
export { enabledHooks, hookSecrets, loadPlugins, runHook, runOperation, type LoadedHook, type LoadedOp, type LoadedPlugin } from "./plugins.ts";
/** How long a keyed /health takes at most, the registry's word on its key included: either server's (SMD-2287). */
export { HEALTH_DEADLINE_MS } from "./reads.ts";
/** The REST core runs each request asLive, so its model calls count live (SMD-3379 PR 2a, model-call.ts). */
export { asLive } from "../model-call.ts";
/** Background calls held to OB1_BACKGROUND_SLOTS' share, the api's hook among the brain's processes' (SMD-3379 PR 2b-1, slots.ts). */
export { installBackgroundSlots } from "../slots.ts";
export { mendIntervalFrom, newMendState, type MendState } from "./mend.ts";
export { reprobeIntervalFrom } from "../provider-health.ts";

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
    taskStatus: bind(ctx, reads.taskStatus),
    brainInfo: reads.brainInfoReader(ctx),
    jobStatus: bind(ctx, reads.jobStatus),
    scanThoughts: bind(ctx, reads.scanThoughts),
    capture: bind(ctx, writes.capture),
    updateThought: bind(ctx, writes.updateThought),
    deleteThought: bind(ctx, writes.deleteThought),
    resetCaptureStamp: bind(ctx, writes.resetCaptureStamp),
    reviewSupersessionProposal: bind(ctx, writes.reviewSupersessionProposal),
    retryFailed: bind(ctx, workers.retryFailed),
    releaseStaleLeases: bind(ctx, workers.releaseStaleLeases),
    runWorker: bind(ctx, workers.runWorker),
    claimWork: bind(ctx, claims.claimWork),
    renewClaim: bind(ctx, claims.renewClaim),
    releaseClaim: bind(ctx, claims.releaseClaim),
    listClaims: bind(ctx, claims.listClaims),
    thread: bind(ctx, threads.thread),
    relations: bind(ctx, relations.relations),
    setPriority: bind(ctx, priority.setPriority),
    clearPriority: bind(ctx, priority.clearPriority),
    priorityHistory: bind(ctx, priority.priorityHistory),
    openItem: bind(ctx, items.openItem),
    updateItem: bind(ctx, items.updateItem),
    setItemStatus: bind(ctx, items.setItemStatus),
    proposeItemClose: bind(ctx, items.proposeItemClose),
    decideItemClose: bind(ctx, items.decideItemClose),
    itemHistory: bind(ctx, items.itemHistory),
    listItems: bind(ctx, items.listItems),
    agenda: bind(ctx, agendaRead.agenda),
    /**
     * A plugin's own tables (SMD-2310): a transaction as its role, in its
     * schema (store-sql.ts's pluginTx). A store without one (a suite's fake)
     * says so when a plugin asks.
     */
    pluginTx: async <T>(plugin: string, fn: (sql: PluginSql) => Promise<T>): Promise<T> => {
      const store = await ctx.store();
      if (!store.pluginTx) throw new Error(`a plugin's tables need the SQL store; this brain runs the ${store.kind} store`);
      return store.pluginTx(plugin, fn);
    },
    /**
     * A plugin handler's model call (SMD-2690 PR 3a, core/model.ts): one chat
     * call through the brain's own provider path and egress gate, made as the
     * caller's key for the plugin. ctx.model.chat is this, bound to its call.
     */
    pluginChat: (plugin: string, actor: string, req: ModelRequest): Promise<ModelAnswer> => pluginChat(ctx.embedConfig(), actor, plugin, req),
    /** The longest one capture's model calls may run under this brain's settings, in seconds: what a webhook's id lease is sized from (SMD-2768). */
    captureSeconds: (): number => writes.captureCallSeconds(ctx.embedConfig(), resolveJevConfig(ctx.env())),
    /** The vector mender's loop (SMD-2889): both servers start one at boot, under OB1_VECTOR_MEND_INTERVAL. */
    startVectorMender: bind(ctx, mend.startVectorMender),
    /** One tick of it, for a suite. */
    mendOnce: bind(ctx, mend.mendOnce),
    /**
     * The provider's re-probe loop (SMD-2890): both servers start one at boot,
     * under OB1_PROVIDER_REPROBE_INTERVAL. What it probes, when, and how each
     * outage ends is startProviderReprobe's; the call it may spend is made
     * here, the server's own embedding of PROBE_WORD as a query.
     */
    startProviderReprobe: (intervalS: number) => {
      // The probe's call is asked of the gate once, here, as the call itself
      // would be: refused (a probeable endpoint not declared local, under deny
      // with terms the word cannot meet), it is not made, and the state's
      // words say so (review pass 4: made and refused, it said nothing, and
      // the outage it was there to end stood).
      const cfg = ctx.embedConfig();
      const subject = { kind: "query" as const, content: PROBE_WORD };
      const callAllowed = mayLeaveBox(subject, cfg.embeddings, cfg.egress).allowed;
      const loop = startProviderReprobe(ctx.providerHealth, {
        endpoint: () => ctx.embedConfig().embeddings,
        intervalS,
        ...(callAllowed ? { call: () => ctx.embedder.getEmbedding(PROBE_WORD, subject, "query") } : {}),
      });
      ctx.reprobeS = loop.reprobeS;
      ctx.reprobeByCall = loop.byCall;
      return loop;
    },
    /** The provider's state, for a suite. */
    providerHealth: ctx.providerHealth,
  };
}

export type Core = ReturnType<typeof createCore>;

function bind<A extends unknown[], R>(ctx: Ctx, op: (ctx: Ctx, ...args: A) => R): (...args: A) => R {
  return (...args) => op(ctx, ...args);
}
