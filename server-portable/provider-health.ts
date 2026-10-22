// The embedding provider's health as this server last saw it (SMD-2890).
//
// A brain whose provider does not answer still serves: a capture lands without
// its vector (SMD-2888), a search answers by exact matches (SMD-2891), the
// vector mender embeds what waited once the provider answers (SMD-2889). What
// was missing is the server saying so: preflight let it start ("nothing
// answers … yet"), and nothing after that told an operator the brain was
// degraded or when it stopped being. This is that state — fed by every real
// embedding call (the capture, the edit, the search, the mender) and, while
// the provider is away, by a re-probe of a local endpoint — read by the keyed
// /health and brain_info (ServerFacts.provider). The keyless /health stays
// liveness: a degraded brain is a brain to keep running, not to restart.

import { existsSync } from "node:fs";
import { isLocalHostname, LOCAL_PROVIDER_SERVICES } from "../db/config.mjs";
import { ProviderError, providerDown, type ProviderEndpoint } from "./embed.ts";

/** Seconds between re-probes while the provider is away, when OB1_PROVIDER_REPROBE_INTERVAL is unset. */
export const DEFAULT_REPROBE_INTERVAL_S = 15;
/** The longest interval the knob takes: an hour. */
const MAX_REPROBE_INTERVAL_S = 3_600;
/** What a call-shaped probe embeds: a fixed word, no one's text — as preflight's --deep sends "preflight". */
export const PROBE_WORD = "probe";
/** A probe's bound: preflight's, so the two agree on what "answers" means. */
export const PROVIDER_PROBE_TIMEOUT_MS = 2_500;

/**
 * OB1_PROVIDER_REPROBE_INTERVAL: whole seconds between re-probes of a local
 * provider that does not answer, 1 to an hour; `0` or `off` for the probe at
 * start alone (the state then moves only with real calls). A value that does
 * not read falls back to the default and says so.
 */
export function reprobeIntervalFrom(raw: string | undefined): { intervalS: number; problem: string | null } {
  const v = raw?.trim().toLowerCase();
  if (v === undefined || v === "") return { intervalS: DEFAULT_REPROBE_INTERVAL_S, problem: null };
  if (v === "off" || v === "0") return { intervalS: 0, problem: null };
  if (/^[0-9]+$/.test(v) && Number(v) >= 1 && Number(v) <= MAX_REPROBE_INTERVAL_S) return { intervalS: Number(v), problem: null };
  return { intervalS: DEFAULT_REPROBE_INTERVAL_S, problem: `OB1_PROVIDER_REPROBE_INTERVAL=${JSON.stringify(raw)} is not a whole number of seconds from 1 to ${MAX_REPROBE_INTERVAL_S}, or "off"; a provider that does not answer is re-probed every ${DEFAULT_REPROBE_INTERVAL_S} s` };
}

/**
 * The provider as last seen (review pass 4 settled the definition):
 * - `unknown`: not yet called or probed.
 * - `answering`: the last call or probe was answered, at `at`; `by` says
 *   which — a probe's GET /models answering says the provider is reachable,
 *   a call's that it embeds. `fault`, when set, is an answered call the
 *   provider refused or answered unusably (a 4xx — a model not pulled, a
 *   key refused —, a body that is not JSON, a vector of the wrong width):
 *   the provider is there, and a capture fails outright, not degraded.
 * - `unreachable`: an outage since `since` (the first of this run of them),
 *   `at` the latest, with providerDown's word and words for the latest —
 *   never the text, nor the base — and `clears`, what evidence may end it:
 *   `probe` for an outage a GET /models can see (the probe's own, a call's
 *   failed connection), `call` once a call has failed where GET /models is
 *   blind (a 5xx, 408, 429, a timeout). Set when it opens, escalated by a
 *   call, reset by an answer.
 */
export type ProviderState =
  | { status: "unknown" }
  | { status: "answering"; at: string; by: "call" | "probe"; fault?: string }
  | { status: "unreachable"; since: string; at: string; reason: string; detail: string; clears: "call" | "probe" };

/**
 * Who saw an outage, and when the call that saw it began — on the monotonic
 * clock (`performance.now()`), never the wall clock, which a step back would
 * turn into every outage looking older than the last answer (review pass 2).
 */
export type DownSeen = { by?: "call" | "probe"; startedAt?: number };

/** The outages a GET /models can see: a connection that failed. A call's timeout is not one — the socket took the request. */
const SOCKET_REASONS = new Set(["provider_unreachable"]);
/** The outages whose words are "does not answer" rather than "fails its calls". */
const SILENT_REASONS = new Set(["provider_unreachable", "provider_timeout"]);

export interface ProviderHealth {
  state(): ProviderState;
  /**
   * A call or probe the provider did not answer (providerDown's outcome). One
   * that began before the provider was last seen answering is passed over: a
   * request that timed out after the provider came back says nothing about
   * now (review pass 1) — for an outage only a call can see, before a CALL
   * last answered, since a probe's answer does not say the calls work
   * (review pass 4).
   */
  noteDown(down: { reason: string; detail: string }, seen?: DownSeen): void;
  /** A call or probe it answered; `fault` an answered call it refused or answered unusably. */
  noteUp(seen?: { by?: "call" | "probe"; fault?: string }): void;
}

/**
 * The tracker. A change of state is logged once — degraded, back, a fault
 * and its end — never each call: an outage under traffic is one line, not
 * one per capture.
 */
export function createProviderHealth(opts: { base: () => string; log?: (line: string) => void; now?: () => Date; mono?: () => number } = { base: () => "" }): ProviderHealth {
  const log = opts.log ?? ((line: string) => console.error(line));
  const now = opts.now ?? (() => new Date());
  const mono = opts.mono ?? (() => performance.now());
  let s: ProviderState = { status: "unknown" };
  /** When it was last seen answering, and last answered a call, on the monotonic clock: what a late outage is judged by. */
  let answeredMono = -Infinity;
  let callAnsweredMono = -Infinity;
  return {
    state: () => s,
    noteDown(down, seen = {}) {
      const by = seen.by ?? "call";
      const callOnly = by === "call" && !SOCKET_REASONS.has(down.reason);
      if (s.status === "answering" && seen.startedAt !== undefined && seen.startedAt < (callOnly ? callAnsweredMono : answeredMono)) return;
      const at = now().toISOString();
      if (s.status === "unreachable") {
        s = { ...s, at, reason: down.reason, detail: down.detail, clears: s.clears === "call" || callOnly ? "call" : "probe" };
        return;
      }
      s = { status: "unreachable", since: at, at, reason: down.reason, detail: down.detail, clears: callOnly ? "call" : "probe" };
      const what = SILENT_REASONS.has(down.reason) ? "does not answer" : "fails its calls";
      log(`provider: the embedding provider at ${opts.base()} ${what} (${down.detail}) — serving degraded: a capture lands without its vector, a search answers by exact matches, until it answers`);
    },
    noteUp(seen = {}) {
      const was = s;
      const by = seen.by ?? "call";
      answeredMono = mono();
      if (by === "call") callAnsweredMono = answeredMono;
      s = { status: "answering", at: now().toISOString(), by, ...(seen.fault ? { fault: seen.fault } : {}) };
      const hadFault = was.status === "answering" && was.fault !== undefined;
      if (seen.fault && (was.status !== "answering" || !hadFault)) log(`provider: the embedding provider at ${opts.base()} answers, but refuses its embedding calls (${seen.fault}) — a capture fails outright until that is fixed`);
      else if (was.status === "unreachable") log(`provider: the embedding provider at ${opts.base()} answers again — no longer degraded`);
      else if (hadFault && by === "call" && !seen.fault) log(`provider: the embedding provider at ${opts.base()} embeds again`);
    },
  };
}

/**
 * What one real embedding call, begun at `startedAt` (performance.now()),
 * says of the provider: answered — a vector —; answered with a fault — a 4xx
 * (a model not pulled, a key refused), a body that is not JSON, or an answer
 * the call could not use (a vector of the wrong width: a plain Error raised
 * after the exchange) —; or down, in providerDown's terms. An egress refusal
 * (no call made) says nothing (review pass 4: one rule for every path; the
 * mender counts a broken body an outage for its holds, not for this state).
 */
export function heardFrom(health: ProviderHealth, startedAt: number, e?: unknown): void {
  if (e === undefined) { health.noteUp({ by: "call" }); return; }
  const down = providerDown(e);
  if (down) { health.noteDown(down, { by: "call", startedAt }); return; }
  if (e instanceof ProviderError) {
    if (e.kind === "http") health.noteUp({ by: "call", fault: `it answered ${e.status}` });
    else if (e.kind === "body") health.noteUp({ by: "call", fault: "its answer was not JSON" });
    return;
  }
  // A runtime error carries a code (the socket's); one with none was raised on an answer.
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  if (code === undefined) health.noteUp({ by: "call", fault: "its answer could not be used" });
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
export function startsDegraded(kind: ProbeKind, where: { host: string; proxy: boolean; container: boolean; addresses?: string[] }): boolean {
  if (where.proxy) return false;
  if (kind !== "refused" && kind !== "silent" && kind !== "unroutable") return false;
  return !(where.container && isLoopback(where.host, where.addresses));
}

/**
 * Whether a host is this machine's loopback (or the any-address, which dials
 * it): by its spelling — `localhost` and its subdomains, `127.0.0.0/8`, `::1`,
 * `::`, `0.0.0.0`, an IPv4-mapped loopback, brackets and a trailing dot
 * aside — or by any address it resolved to, which catches an /etc/hosts alias
 * (review pass 2: `localhost.` and `[::ffff:127.0.0.1]` slipped the spelling).
 */
export function isLoopback(host: string, addresses: string[] = []): boolean {
  const one = (h: string) => {
    const x = h.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    return x === "localhost" || x.endsWith(".localhost") || x === "::1" || x === "::" || x === "0.0.0.0" || /^127\.\d+\.\d+\.\d+$/.test(x) || /^::ffff:(127\.|7f[0-9a-f]{2}:)/.test(x);
  };
  return one(host) || addresses.some(one);
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
 * Whether a GET /models answer may end this outage: one whose `clears` is
 * `probe`. The probe sees the socket and /models, not the call: a call's
 * 5xx or timeout it cannot end — a proxy whose backend is down answers
 * /models and fails /embeddings, and a probe that cleared that flapped the
 * state on every capture (review pass 1). Those end with a call that is
 * answered: a capture's, an edit's, a search's, the vector mender's, or the
 * loop's own call-shaped probe (review pass 3).
 */
export function probeClears(s: ProviderState): boolean {
  return s.status !== "unreachable" || s.clears === "probe";
}

/**
 * The re-probe loop, for a local endpoint (a hosted one costs a credential
 * to ask, and its state moves with real calls alone): a GET /models at start,
 * so a server started with its provider down says so at once (preflight's
 * warning is another process's) — with the knob off too, then never again
 * (review pass 2). Then every `intervalS` while the state is unreachable:
 * GET /models first; an answer ends an outage the probe can see; for one
 * only a call can see, an answer spends `call`, when given — one real
 * embedding of PROBE_WORD, fed to the state as any call is (heardFrom) — so
 * each process ends its own outage whether or not its mender holds the lock,
 * on a quiet brain too (review pass 3), and a silent provider costs the
 * cheap probe's 2.5 s, not a call's request timeout (review pass 4). `call`
 * is not given when the egress gate refuses it; the state's words then say
 * only a call that is answered ends such an outage. While answering, nothing
 * is probed. Timers are unref'd, never overlap, and stop() starts no further
 * probe and writes nothing a probe in flight finds.
 */
export function startProviderReprobe(health: ProviderHealth, opts: { endpoint: () => ProviderEndpoint; intervalS: number; call?: () => Promise<unknown> }): { stop: () => void; reprobeS: number | null; byCall: boolean } {
  const at = opts.endpoint();
  if (!probeable(at)) return { stop: () => {}, reprobeS: null, byCall: false };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    const s = health.state();
    if (s.status !== "answering") {
      const startedAt = performance.now();
      const down = await probeProvider(opts.endpoint());
      if (stopped) return;
      if (down) health.noteDown(down, { by: "probe", startedAt });
      else if (probeClears(health.state())) health.noteUp({ by: "probe" });
      else if (opts.call) {
        const callStarted = performance.now();
        let failed: { e: unknown } | null = null;
        try { await opts.call(); } catch (e) { failed = { e }; }
        if (stopped) return;
        heardFrom(health, callStarted, failed ? failed.e : undefined);
      }
    }
    if (stopped || opts.intervalS === 0) return;
    timer = setTimeout(() => void tick(), opts.intervalS * 1000);
    (timer as { unref?: () => void }).unref?.();
  };
  void tick();
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); }, reprobeS: opts.intervalS === 0 ? null : opts.intervalS, byCall: opts.intervalS !== 0 && opts.call !== undefined };
}
