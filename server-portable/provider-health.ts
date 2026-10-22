// The embedding provider's health as this server last saw it (SMD-2890).
//
// A brain whose provider does not answer still serves: a capture lands without
// its vector (SMD-2888), a search answers by exact matches (SMD-2891), the
// vector mender embeds what waited once the provider answers (SMD-2889). What
// was missing is the server saying so: preflight let it start ("nothing
// answers … yet"), and nothing after that told an operator the brain was
// degraded or when it stopped being. This is that state — fed by every real
// embedding call (the capture, the search, the mender) and, while the provider
// is away, by a re-probe of a local endpoint — read by the keyed /health and
// brain_info (ServerFacts.provider). The keyless /health stays liveness: a
// degraded brain is a brain to keep running, not to restart.

import { isLocalHostname, LOCAL_PROVIDER_SERVICES } from "../db/config.mjs";
import { providerDown, shownBase, type ProviderEndpoint } from "./embed.ts";

/** Seconds between re-probes while the provider is away, when OB1_PROVIDER_REPROBE_INTERVAL is unset. */
export const DEFAULT_REPROBE_INTERVAL_S = 15;
/** The longest interval the knob takes: an hour. */
const MAX_REPROBE_INTERVAL_S = 3_600;
/** A probe's bound: preflight's, so the two agree on what "answers" means. */
export const PROVIDER_PROBE_TIMEOUT_MS = 2_500;
/** setTimeout's ceiling (Bun, as Node). */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * OB1_PROVIDER_REPROBE_INTERVAL: whole seconds between re-probes of a local
 * provider that does not answer, 1 to an hour; `0` or `off` for none (the state
 * then moves only with real calls). A value that does not read falls back to
 * the default and says so.
 */
export function reprobeIntervalFrom(raw: string | undefined): { intervalS: number; problem: string | null } {
  const v = raw?.trim().toLowerCase();
  if (v === undefined || v === "") return { intervalS: DEFAULT_REPROBE_INTERVAL_S, problem: null };
  if (v === "off" || v === "0") return { intervalS: 0, problem: null };
  if (/^[0-9]+$/.test(v) && Number(v) >= 1 && Number(v) <= MAX_REPROBE_INTERVAL_S) return { intervalS: Number(v), problem: null };
  return { intervalS: DEFAULT_REPROBE_INTERVAL_S, problem: `OB1_PROVIDER_REPROBE_INTERVAL=${JSON.stringify(raw)} is not a whole number of seconds from 1 to ${MAX_REPROBE_INTERVAL_S}, or "off"; a provider that does not answer is re-probed every ${DEFAULT_REPROBE_INTERVAL_S} s` };
}

/**
 * The provider as last seen: not yet called or probed; answering (`at`, the
 * last call or probe it answered); or unreachable since `since` (the first
 * outage of this run of them), `at` the latest, with providerDown's word and
 * words — never the text, nor the base.
 */
export type ProviderState =
  | { status: "unknown" }
  | { status: "answering"; at: string }
  | { status: "unreachable"; since: string; at: string; reason: string; detail: string };

export interface ProviderHealth {
  state(): ProviderState;
  /** A call or probe the provider did not answer (providerDown's outcome). */
  noteDown(down: { reason: string; detail: string }): void;
  /** A call or probe it answered. */
  noteUp(): void;
}

/**
 * The tracker. A change of state is logged once — degraded, and back — never
 * each call: an outage under traffic is one line, not one per capture.
 */
export function createProviderHealth(opts: { base: () => string; log?: (line: string) => void; now?: () => Date } = { base: () => "" }): ProviderHealth {
  const log = opts.log ?? ((line: string) => console.error(line));
  const now = opts.now ?? (() => new Date());
  let s: ProviderState = { status: "unknown" };
  return {
    state: () => s,
    noteDown(down) {
      const at = now().toISOString();
      if (s.status === "unreachable") { s = { ...s, at, reason: down.reason, detail: down.detail }; return; }
      s = { status: "unreachable", since: at, at, reason: down.reason, detail: down.detail };
      log(`provider: the embedding provider at ${opts.base()} does not answer (${down.detail}) — serving degraded: a capture lands without its vector, a search answers by exact matches, until it answers`);
    },
    noteUp() {
      const was = s.status;
      s = { status: "answering", at: now().toISOString() };
      if (was === "unreachable") log(`provider: the embedding provider at ${opts.base()} answers again — no longer degraded`);
    },
  };
}

/** An endpoint the server may dial with no credential and no content: preflight's local rule (loopback, a private network, the host aliases, the stack's own service names). */
export function probeable(at: Pick<ProviderEndpoint, "base">): boolean {
  try {
    return isLocalHostname(new URL(at.base).hostname, [...LOCAL_PROVIDER_SERVICES]);
  } catch {
    return false;
  }
}

/**
 * One probe, as preflight's: GET /models, no credential, no redirect followed,
 * PROVIDER_PROBE_TIMEOUT_MS. Any HTTP answer is the provider answering (null);
 * otherwise the outage in providerDown's terms, a timeout and a failure it does
 * not classify included — the error's code or name, never its message, which
 * may carry the URL.
 */
export async function probeProvider(at: Pick<ProviderEndpoint, "base">): Promise<{ reason: string; detail: string } | null> {
  try {
    const r = await fetch(`${at.base}/models`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(PROVIDER_PROBE_TIMEOUT_MS) });
    await r.body?.cancel();
    return null;
  } catch (e) {
    const err = e as Error & { code?: unknown };
    if (err?.name === "TimeoutError") return { reason: "provider_timeout", detail: `no HTTP answer in ${PROVIDER_PROBE_TIMEOUT_MS / 1000} s` };
    return providerDown(e) ?? { reason: "provider_unreachable", detail: `the call failed (${typeof err?.code === "string" && err.code ? err.code : err?.name ?? "error"})` };
  }
}

/**
 * The re-probe loop: once at start, so a server started with its provider
 * down says so at once (preflight's warning is another process's); then every
 * `intervalS` while the state is not answering — a real call that meets an
 * outage turns it back on, one that is answered leaves it idle. Only a local
 * endpoint is probed: a hosted one costs a credential to ask, and its state
 * moves with real calls alone. Timers are unref'd, never overlap, and stop()
 * starts no further probe.
 */
export function startProviderReprobe(health: ProviderHealth, opts: { endpoint: () => ProviderEndpoint; intervalS: number }): { stop: () => void; reprobeS: number | null } {
  const at = opts.endpoint();
  if (opts.intervalS === 0 || !probeable(at)) return { stop: () => {}, reprobeS: null };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (first: boolean) => {
    if (stopped) return;
    if (first || health.state().status !== "answering") {
      const down = await probeProvider(opts.endpoint());
      if (stopped) return;
      if (down) health.noteDown(down);
      else health.noteUp();
    }
    if (stopped) return;
    timer = setTimeout(() => void tick(false), Math.min(opts.intervalS * 1000, MAX_TIMER_MS));
    (timer as { unref?: () => void }).unref?.();
  };
  void tick(true);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); }, reprobeS: opts.intervalS };
}

/** The base a log line names: userinfo masked, as a row prints it (SMD-2885). */
export const providerBaseShown = (at: Pick<ProviderEndpoint, "base" | "userinfo">) => shownBase(at);
