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

import { existsSync } from "node:fs";
import { isLocalHostname, LOCAL_PROVIDER_SERVICES } from "../db/config.mjs";
import { ProviderError, providerDown, type ProviderEndpoint } from "./embed.ts";

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
 * words — never the text, nor the base — and `by`, whether a real call or the
 * probe saw the latest.
 */
export type ProviderState =
  | { status: "unknown" }
  | { status: "answering"; at: string }
  | { status: "unreachable"; since: string; at: string; reason: string; detail: string; by: "call" | "probe" };

/** Who saw an outage, and when the call that saw it began (ms since the epoch). */
export type DownSeen = { by?: "call" | "probe"; startedAt?: number };

export interface ProviderHealth {
  state(): ProviderState;
  /**
   * A call or probe the provider did not answer (providerDown's outcome). One
   * that began before the provider was last seen answering is passed over: a
   * request that timed out after the provider came back says nothing about
   * now (review pass 1).
   */
  noteDown(down: { reason: string; detail: string }, seen?: DownSeen): void;
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
    noteDown(down, seen = {}) {
      if (s.status === "answering" && seen.startedAt !== undefined && seen.startedAt < Date.parse(s.at)) return;
      const at = now().toISOString();
      const by = seen.by ?? "call";
      if (s.status === "unreachable") { s = { ...s, at, reason: down.reason, detail: down.detail, by }; return; }
      s = { status: "unreachable", since: at, at, reason: down.reason, detail: down.detail, by };
      log(`provider: the embedding provider at ${opts.base()} does not answer (${down.detail}) — serving degraded: a capture lands without its vector, a search answers by exact matches, until it answers`);
    },
    noteUp() {
      const was = s.status;
      s = { status: "answering", at: now().toISOString() };
      if (was === "unreachable") log(`provider: the embedding provider at ${opts.base()} answers again — no longer degraded`);
    },
  };
}

/**
 * What one real embedding call, begun at `startedAt`, says of the provider:
 * answered — a vector, or an HTTP refusal of the input that is no outage (a
 * 4xx: the provider is there, as the mender counts it) — or down, in
 * providerDown's terms. An egress refusal (no call made) and a failure that
 * is neither (a width mismatch, a body that is not JSON) say nothing.
 */
export function heardFrom(health: ProviderHealth, startedAt: number, e?: unknown): void {
  if (e === undefined) { health.noteUp(); return; }
  const down = providerDown(e);
  if (down) health.noteDown(down, { by: "call", startedAt });
  else if (e instanceof ProviderError && e.kind === "http") health.noteUp();
}

/** What preflight's probe of a local endpoint found, by kind (preflight.ts probeFailure). */
export type ProbeKind = "silent" | "unresolved" | "refused" | "unroutable" | "reset" | "tls" | "other";

/** Whether this process runs in a container: the marker file Docker writes, or podman's. */
export function inContainer(exists: (path: string) => boolean = existsSync): boolean {
  return exists("/.dockerenv") || exists("/run/.containerenv");
}

/**
 * Whether preflight lets the server start degraded on a probe that found
 * nothing answering (SMD-2890): a name that resolved and a connection
 * refused, silent, or with no route to it (EHOSTUNREACH, ENETUNREACH — a LAN
 * box asleep or booting, which the runtime's providerDown counts an outage
 * too; review pass 1) is a provider not up yet. Not: a failure through a
 * proxy (the route's before the provider's); a reset, an untrusted
 * certificate, anything unclassified (something answers wrongly, and will not
 * start answering by itself); and, in a container, a loopback host — the
 * container's own, where nothing will ever start (SMD-1875's headline case;
 * the maintainer's call, review pass 1). A name that does not resolve never
 * reaches this: the runtime lacks it.
 */
export function startsDegraded(kind: ProbeKind, where: { host: string; proxy: boolean; container: boolean }): boolean {
  if (where.proxy) return false;
  if (kind !== "refused" && kind !== "silent" && kind !== "unroutable") return false;
  const loopback = where.host === "localhost" || where.host === "::1" || where.host === "[::1]" || where.host === "0.0.0.0" || /^127\.\d+\.\d+\.\d+$/.test(where.host);
  return !(where.container && loopback);
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
 * PROVIDER_PROBE_TIMEOUT_MS. An HTTP answer is the provider answering (null),
 * but for the statuses providerDown reads as an outage — 5xx, 408, 429, a
 * proxy in front of a backend that is down (review pass 1); otherwise the
 * outage in providerDown's terms, a timeout and a failure it does not
 * classify included — the error's code or name, never its message, which may
 * carry the URL.
 */
export async function probeProvider(at: Pick<ProviderEndpoint, "base">): Promise<{ reason: string; detail: string } | null> {
  try {
    const r = await fetch(`${at.base}/models`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(PROVIDER_PROBE_TIMEOUT_MS) });
    await r.body?.cancel();
    if (r.status >= 500 || r.status === 408 || r.status === 429) return { reason: `provider_${r.status}`, detail: `GET /models answered ${r.status}` };
    return null;
  } catch (e) {
    const err = e as Error & { code?: unknown };
    if (err?.name === "TimeoutError") return { reason: "provider_timeout", detail: `no HTTP answer in ${PROVIDER_PROBE_TIMEOUT_MS / 1000} s` };
    return providerDown(e) ?? { reason: "provider_unreachable", detail: `the call failed (${typeof err?.code === "string" && err.code ? err.code : err?.name ?? "error"})` };
  }
}

/**
 * Whether the probe may end this outage by an answer. The probe sees the
 * socket and GET /models, not the call: an outage it saw itself, or a call's
 * connection that failed (refused, reset, unroutable, unresolved), it may end;
 * a call's 5xx, timeout or broken body it may not — a proxy whose backend is
 * down answers /models and fails /embeddings, and a probe that cleared that
 * flapped the state on every capture (review pass 1). Those end with a call
 * that is answered: a capture's, a search's, or the vector mender's.
 */
export function probeClears(s: ProviderState): boolean {
  return s.status !== "unreachable" || s.by === "probe" || s.reason === "provider_unreachable";
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
      const startedAt = Date.now();
      const down = await probeProvider(opts.endpoint());
      if (stopped) return;
      if (down) health.noteDown(down, { by: "probe", startedAt });
      else if (probeClears(health.state())) health.noteUp();
    }
    if (stopped) return;
    timer = setTimeout(() => void tick(false), Math.min(opts.intervalS * 1000, MAX_TIMER_MS));
    (timer as { unref?: () => void }).unref?.();
  };
  void tick(true);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); }, reprobeS: opts.intervalS };
}
