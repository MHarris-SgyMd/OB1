/**
 * slots.ts — background calls held to a share of a model server's slots
 * (SMD-3379 PR 2b-1): the model-call seam's hook (model-call.ts), off unless
 * OB1_BACKGROUND_SLOTS says how many.
 *
 * A model server answers a few calls at once — Ollama's OLLAMA_NUM_PARALLEL,
 * per loaded model — and live calls (a capture, a search) should find one
 * free. So each brain's background calls (its sleep passes, board-sync, its
 * servers' timers) are held to a share: at most N at once for a model on a
 * model server, across every process of the brain, by Postgres advisory
 * locks — slot i of a share is the two-key lock (hashtext(key), i), taken
 * with pg_try_advisory_lock on a connection of the semaphore's own and held
 * for the call, so a process that dies lets its slots go with its session. A
 * share is kept per model server (its base URL, normalised: the scheme and
 * host in lower case, no userinfo, no trailing slash) and model, the decide
 * tier per model server alone — it answers one request at a time, whatever
 * its model. Two spellings of one server (compose's host alias, a checkout's
 * localhost) are two shares. A live call never takes a slot.
 *
 * Written as types, with per-model overrides: `chat=1,embed=2,decide=1,
 * chat:qwen3.8:27b=1`. A type left out is unlimited; unset, empty or `off`,
 * no hook is set. A value that does not parse is said and the hook is left
 * off, as other server settings fall back.
 *
 * Fail open (the maintainer, 2026-11-05): a semaphore whose database does not
 * answer lets the call run without a slot, said once until it answers again —
 * the worker's own database is the same one, and meets a real outage itself.
 * So a hook fails a call only on its stop: the call's own signal, or the
 * process's `stop`, for the callers that hand the seam none (board-sync, the
 * vector mender, the digest).
 */
import { SQL } from "bun";
import { setModelCallHook, type ModelCallHook, type ModelType, type ResolvedModelCall } from "./model-call.ts";

/** A parsed OB1_BACKGROUND_SLOTS: each type's share, and per-model overrides keyed `type:model`. */
export type BackgroundSlots = ReadonlyMap<string, number>;

const TYPES: readonly ModelType[] = ["embed", "chat", "decide"];
/** The most slots one share may have: a model server answers a handful at once, and each held slot is a connection. */
export const MAX_SLOTS = 16;
/** How often a call waiting for a slot tries again, in ms, a little jitter beside it so waiters do not move in step. */
const POLL_MS = 250;

/** OB1_BACKGROUND_SLOTS read: null when unset, empty or `off`; else its shares, or a problem in words. */
export function backgroundSlotsFrom(raw: string | undefined): { slots: BackgroundSlots | null; problem?: string } {
  const text = (raw ?? "").trim();
  if (text === "" || text.toLowerCase() === "off") return { slots: null };
  const slots = new Map<string, number>();
  for (const part of text.split(",").map((p) => p.trim()).filter(Boolean)) {
    const eq = part.lastIndexOf("=");
    const name = eq > 0 ? part.slice(0, eq).trim() : "";
    const value = eq > 0 ? part.slice(eq + 1).trim() : "";
    const colon = name.indexOf(":");
    const type = colon < 0 ? name : name.slice(0, colon);
    const model = colon < 0 ? "" : name.slice(colon + 1);
    const bad = (why: string) => ({ slots: null, problem: `OB1_BACKGROUND_SLOTS: ${JSON.stringify(part)} ${why} — write types and per-model overrides, e.g. chat=1,embed=2,decide=1,chat:qwen3.8:27b=1, or off; background slots stay off` });
    if (!(TYPES as readonly string[]).includes(type)) return bad(`names no model type (${TYPES.join(", ")})`);
    if (colon >= 0 && (model === "" || type === "decide")) return bad(type === "decide" ? "gives the decide tier a model: it is shared per model server alone" : "names no model after the colon");
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_SLOTS) return bad(`is no whole number of slots from 1 to ${MAX_SLOTS}`);
    if (slots.has(name)) return bad("is given twice");
    slots.set(name, Number(value));
  }
  return slots.size ? { slots } : { slots: null };
}

/** A model server's base as one share knows it: the scheme and host in lower case, no userinfo, no trailing slash. */
export function normalisedBase(base: string): string {
  try {
    // URL lower-cases the scheme and host; built from its parts, the userinfo is left out.
    const u = new URL(base);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return base.replace(/\/+$/, "");
  }
}

/** The share a call counts against: its key and its size, or null where it is unlimited (a live call, a type left out). */
export function shareOf(slots: BackgroundSlots, call: Pick<ResolvedModelCall, "type" | "model" | "base" | "cls">): { key: string; limit: number } | null {
  if (call.cls !== "background") return null;
  const limit = (call.type !== "decide" && call.model !== undefined ? slots.get(`${call.type}:${call.model}`) : undefined) ?? slots.get(call.type);
  if (limit === undefined) return null;
  const base = normalisedBase(call.base);
  return { key: call.type === "decide" ? `ob1:slot:decide:${base}` : `ob1:slot:${call.type}:${base}:${call.model ?? "?"}`, limit };
}

/** Sleeps `ms`, ending early, rejecting with the signal's reason, when it aborts. */
function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal?.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Sets the background-slots hook for this process, once, at its entry point:
 * `raw` its OB1_BACKGROUND_SLOTS, `url` its database. Returns `uninstall`,
 * which puts back the hook it replaced, ends every wait (with the process's
 * stop, if none was given) and closes the semaphore's connections; and the
 * setting's problem, said through `log`, the hook then left off.
 */
export function installBackgroundSlots(opts: { url: string; raw: string | undefined; log?: (line: string) => void; stop?: AbortSignal }): { installed: boolean; problem?: string; uninstall: () => Promise<void> } {
  const log = opts.log ?? ((line: string) => console.error(line));
  const { slots, problem } = backgroundSlotsFrom(opts.raw);
  if (problem) log(problem);
  if (!slots) return { installed: false, ...(problem ? { problem } : {}), uninstall: async () => {} };
  const total = [...slots.values()].reduce((a, b) => a + b, 0);
  const pool = new SQL({ url: opts.url, max: Math.min(MAX_SLOTS * TYPES.length, total + 2) });
  const ended = new AbortController();
  const stop = opts.stop ? AbortSignal.any([opts.stop, ended.signal]) : ended.signal;
  let down = false;
  const failedOpen = (e: unknown) => {
    if (!down) log(`  background slots: the semaphore's database did not answer (${(e as Error).message}) — background calls run without a slot until it does`);
    down = true;
  };
  type Held = { conn: Awaited<ReturnType<SQL["reserve"]>>; key: string; slot: number };
  const acquire = async (key: string, limit: number, signal: AbortSignal): Promise<Held | null> => {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      let conn: Held["conn"];
      try {
        conn = await pool.reserve();
      } catch (e) {
        failedOpen(e);
        return null;
      }
      try {
        for (let slot = 0; slot < limit; slot++) {
          const [r] = (await conn`SELECT pg_try_advisory_lock(hashtext(${key}), ${slot}) AS got`) as { got: boolean }[];
          if (r.got) {
            if (down) log("  background slots: the semaphore's database answers again");
            down = false;
            return { conn, key, slot };
          }
        }
      } catch (e) {
        conn.release();
        failedOpen(e);
        return null;
      }
      conn.release();
      await wait(POLL_MS + Math.floor(Math.random() * POLL_MS), signal);
    }
  };
  const release = async (held: Held): Promise<void> => {
    try {
      await held.conn`SELECT pg_advisory_unlock(hashtext(${held.key}), ${held.slot})`;
    } catch {
      // A connection gone took its lock with it.
    } finally {
      held.conn.release();
    }
  };
  const hook: ModelCallHook = async (call, run) => {
    const share = shareOf(slots, call);
    if (!share) return run();
    const held = await acquire(share.key, share.limit, call.signal ? AbortSignal.any([call.signal, stop]) : stop);
    try {
      return await run();
    } finally {
      if (held) await release(held);
    }
  };
  const before = setModelCallHook(hook);
  return {
    installed: true,
    uninstall: async () => {
      setModelCallHook(before);
      ended.abort(new Error("background slots: the process is stopping"));
      await pool.close({ timeout: 2 }).catch(() => {});
    },
  };
}
