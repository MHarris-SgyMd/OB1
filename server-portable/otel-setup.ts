// The OpenTelemetry SDK for traces (SMD-1849 PR 2b), set up only when an
// operator names a collector (OTEL_EXPORTER_OTLP_ENDPOINT, or
// OTEL_EXPORTER_OTLP_TRACES_ENDPOINT): telemetry.ts loads
// this module then, and only on Bun. Until it runs, the spans telemetry.ts
// starts are the API's no-ops — nothing is recorded and nothing is sent.
//
// Spans go over OTLP/HTTP as JSON to the endpoint, in batches; the exporter
// reads the standard OTEL_EXPORTER_OTLP_* variables (the endpoint, a traces
// endpoint of its own, headers, a timeout), the provider the sampler's
// (OTEL_TRACES_SAMPLER) and the batch processor its own (OTEL_BSP_*). The resource
// is the SDK's own (telemetry.sdk.*), the service's name — OTEL_SERVICE_NAME,
// else the server's own — its version, and whatever OTEL_RESOURCE_ATTRIBUTES
// adds or overrides (a tier's name, PR 3).
//
// Spans not sent — an export that failed, or spans the batch's full queue
// dropped — are said on stderr at most once a minute, by count and kind (a
// count held inside a minute is said when the minute ends), and what is still
// unsaid at the stop, its own flush's failures included, is said then; never
// an error's message, which can carry the URL. Context follows a request through its awaits by
// AsyncLocalStorage, so a tool's span is its request's child, and an incoming
// W3C `traceparent` is continued, so the proxy's or a client's trace is this
// one.
//
// Workers never loads this: wrangler.toml aliases it to
// shims/otel-unavailable.ts, so the Worker's bundle holds the API alone.

import { context, diag, DiagLogLevel, propagation, trace, TraceFlags, type Context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ExportResultCode, W3CTraceContextPropagator, type ExportResult } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { defaultResource, detectResources, envDetector, resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, type ReadableSpan, type Span, type SpanExporter, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { FlushResult } from "./shutdown.ts";
import { FORK_VERSION } from "./version.ts";

export interface Tracing {
  /** The service the spans go out as: the resource's `service.name`, after OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES. */
  readonly serviceName: string;
  /** Sends what is batched and waits for what is on its way: how that ended (shutdown.ts FlushResult; the stop bounds it). */
  flush(): Promise<FlushResult>;
  /** Unregisters the provider, so later spans are no-ops again (a suite's). */
  shutdown(): Promise<void>;
}

/** Where spans not sent are said: the collector's origin, and the line's sink. */
interface Reporting {
  origin: string;
  warn: (line: string) => void;
  /** At most one line per this many milliseconds (60 s). */
  everyMs?: number;
}

/**
 * The kinds the exporter's failures are said by: an HTTP status it was
 * refused with, a network error's code, or one of the SDK's own fixed
 * messages (otlp-exporter-base 0.223); else the error's name. Never a message
 * of any other kind, which can carry the URL (review pass 2: a 503's, after
 * its retries, read only `OTLPExporterError`).
 */
const SDK_FAILURES: Record<string, string> = {
  "Export failed with retryable status": "retryable status, retries spent",
  "Request timed out": "timed out",
  "Export failed with unknown error": "unknown error",
  "Concurrent export limit reached": "too many exports at once",
  "Concurrency Limit reached": "too many exports at once",
  "Nothing to send": "nothing to send",
};
function failureKind(error: Error | undefined): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (typeof code === "number") return `HTTP ${code}`;
  // A network or TLS error's code (ECONNREFUSED, EAI_AGAIN, DEPTH_ZERO_SELF_SIGNED_CERT): capitals, digits and underscores.
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{2,47}$/.test(code)) return code;
  if (error?.message.startsWith("OTLP export response body exceeded size limit")) return "response too large";
  return (error && SDK_FAILURES[error.message]) ?? error?.name ?? "failed";
}

/** At most this many kinds named in one line, the most spans first; the rest said as `others`. */
const KINDS_SAID = 5;

/** The exporter a collector's spans go through: it says what was not sent, and tells a flush what it saw. */
interface WatchedExporter extends SpanExporter {
  /** Spans dropped before an export (the batch's queue full), said as an export's failure is. */
  dropped(count: number): void;
  /** Says what is still unsaid, whatever the window — the stop's last word on spans not sent. */
  sayRest(): void;
  /** How many spans were handed to an export, so far. */
  readonly handed: number;
  /** Where things stand, to compare after a flush. */
  mark(): { started: number; failed: number; pending: number };
  /** Waits for every export on its way. */
  idle(): Promise<void>;
}

/**
 * An exporter that says when spans are not sent — every one since the last
 * line, by kind (failureKind; `queue full` for the batch's drops), with the
 * origin — at most once a window, and nothing of a message; and that keeps
 * the count of exports started, failed and on their way, so a flush can tell
 * sent from failed from nothing at all. A window's line names each kind it
 * counts (review pass 3: one kind's name was on spans lost to another).
 */
export function watchExporter(inner: SpanExporter, { origin, warn, everyMs = 60_000 }: Reporting): WatchedExporter {
  const lost = new Map<string, number>();
  let saidAt = -Infinity;
  let started = 0;
  let failed = 0;
  let handed = 0;
  // Says a count held inside the window when the window ends, so a collector
  // that recovers does not leave it unsaid (review pass 4); unref'd, so it
  // never holds the process open.
  let held: ReturnType<typeof setTimeout> | undefined;
  // Once shutting down, a count is said at once, never held for a timer that would outlive the exporter (review pass 6).
  let closing = false;
  const pending = new Set<Promise<void>>();
  const sayNow = () => {
    clearTimeout(held);
    held = undefined;
    const total = [...lost.values()].reduce((sum, n) => sum + n, 0);
    if (total === 0) return;
    const byCount = [...lost].sort((a, b) => b[1] - a[1]);
    const named = byCount.slice(0, KINDS_SAID).map(([kind, n]) => `${kind}: ${n}`);
    const others = byCount.slice(KINDS_SAID).reduce((sum, [, n]) => sum + n, 0);
    const kinds = lost.size === 1 ? byCount[0][0] : [...named, ...(others > 0 ? [`others: ${others}`] : [])].join(", ");
    warn(`telemetry: ${total} span${total === 1 ? "" : "s"} not sent to ${origin} (${kinds}) (SMD-1849)`);
    saidAt = performance.now();
    lost.clear();
  };
  const say = (count: number, kind: string) => {
    lost.set(kind, (lost.get(kind) ?? 0) + count);
    const since = performance.now() - saidAt;
    if (closing || since >= everyMs) sayNow();
    else if (!held) {
      held = setTimeout(sayNow, everyMs - since);
      (held as { unref?: () => void }).unref?.();
    }
  };
  return {
    export(spans: ReadableSpan[], done: (result: ExportResult) => void) {
      started += 1;
      handed += spans.length;
      let settle = () => {};
      const going = new Promise<void>((resolve) => { settle = resolve; });
      pending.add(going);
      inner.export(spans, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) {
          failed += 1;
          say(spans.length, failureKind(result.error));
        }
        pending.delete(going);
        settle();
        done(result);
      });
    },
    dropped: (count) => say(count, "queue full"),
    sayRest: sayNow,
    get handed() {
      return handed;
    },
    mark: () => ({ started, failed, pending: pending.size }),
    idle: async () => {
      await Promise.all([...pending]);
    },
    // What is held is said as the exporter goes, and what its last exports lose as they end, so no timer says it to a sink that has gone (review passes 5–6).
    shutdown: async () => {
      closing = true;
      sayNow();
      try {
        await inner.shutdown();
      } finally {
        sayNow();
      }
    },
    forceFlush: () => inner.forceFlush?.() ?? Promise.resolve(),
  };
}

/** How a flush ended, from where things stood before it and after: none, sent, or failed. */
export function flushResult(before: { started: number; failed: number; pending: number }, after: { started: number; failed: number }): FlushResult {
  if (before.pending + (after.started - before.started) === 0) return "none";
  return after.failed > before.failed ? "failed" : "sent";
}

/**
 * A batch processor that counts the sampled spans it is handed, so the stop
 * knows exactly how many the full queue dropped: once a flush has handed the
 * exporter all that was queued, what was queued and never handed was dropped
 * (review pass 3: the SDK says a drop only when a later span is queued, and a
 * queue full until the stop never says it).
 */
export function countingProcessor(inner: SpanProcessor): SpanProcessor & { readonly queued: number } {
  let queued = 0;
  return {
    get queued() {
      return queued;
    },
    onStart: (span: Span, parent: Context) => inner.onStart(span, parent),
    onEnd: (span: ReadableSpan) => {
      if ((span.spanContext().traceFlags & TraceFlags.SAMPLED) !== 0) queued += 1;
      inner.onEnd(span);
    },
    forceFlush: () => inner.forceFlush(),
    shutdown: () => inner.shutdown(),
  };
}

/**
 * The full queue's drops, from its two witnesses, each said once: the SDK's
 * diag line (a count since its last, said when a later span is queued) and a
 * flush's exact count (queued less handed). Neither counts a drop twice, so
 * the larger is what is known, and only what is past the last said is said
 * (review pass 4: a second flush, or a diag line after one, said them again).
 */
export function dropCount(say: (count: number) => void): { fromDiag(count: number): void; exactly(total: number): void } {
  let diag = 0;
  let exact = 0;
  let said = 0;
  const known = () => {
    const now = Math.max(diag, exact);
    if (now > said) say(now - said);
    said = Math.max(said, now);
  };
  return {
    fromDiag: (count) => {
      diag += count;
      known();
    },
    exactly: (total) => {
      exact = Math.max(exact, total);
      known();
    },
  };
}

/**
 * A batch's flush, as the stop runs it: the batch hands the exporter all it
 * holds as the flush starts — synchronously, while the resource has no
 * attributes pending, which defaultResource's and envDetector's are not — so
 * what was queued and never handed is what the full queue dropped. That and
 * whatever else is unsaid is said before the wait, in case the stop's bound
 * cuts it, and again after, for the flush's own exports that failed (review
 * pass 4); then how it ended.
 */
export async function flushBatch(provider: { forceFlush(): Promise<void> }, counted: { readonly queued: number }, watched: WatchedExporter, drops: { exactly(total: number): void }): Promise<FlushResult> {
  const before = watched.mark();
  const flushing = provider.forceFlush().catch(() => {});
  drops.exactly(counted.queued - watched.handed);
  watched.sayRest();
  await flushing;
  await watched.idle();
  watched.sayRest();
  return flushResult(before, watched.mark());
}

/**
 * The batch's queue at most: OTEL_BSP_MAX_QUEUE_SIZE is the operator's, but each span held costs about 6 KB, and a
 * keyless flood fills any queue while a collector stalls (review pass 6: a million took the server to 6 GB).
 */
const MAX_QUEUE = 65_536;

/** The batch processor's one word on dropped spans, which a diag logger at WARN is handed. */
const DROPPED = /^Dropped (\d+) spans because maxQueueSize reached$/;

/**
 * Registers a tracer provider, the context manager and the W3C propagator.
 * `{ exporter }`: a suite's in-memory one, each span handed over as it ends.
 * `{ report }`: OTLP/HTTP from the environment, batched; its failures and its
 * queue's drops said through `report` — the SDK's diag output is read for the
 * drops alone (its other text can carry the URL) — and its flush waiting for
 * exports already on their way (review pass 2: the batch processor's flush
 * does not, and an empty one resolves at once).
 */
export function setUpTracing(serviceName: string, mode: { exporter: SpanExporter } | { report: Reporting }): Tracing {
  const resource = defaultResource()
    .merge(resourceFromAttributes({ "service.name": serviceName, "service.version": FORK_VERSION }))
    .merge(detectResources({ detectors: [envDetector] }));
  const watched = "report" in mode ? watchExporter(new OTLPTraceExporter(), mode.report) : undefined;
  const asked = Number(process.env.OTEL_BSP_MAX_QUEUE_SIZE);
  const queue = Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_QUEUE) : 2048;
  if ("report" in mode && Number.isInteger(asked) && asked > MAX_QUEUE) mode.report.warn(`telemetry: OTEL_BSP_MAX_QUEUE_SIZE ${asked} is held to ${MAX_QUEUE} (SMD-1849)`);
  const counted = watched ? countingProcessor(new BatchSpanProcessor(watched, { maxQueueSize: queue })) : undefined;
  const processor = counted ?? new SimpleSpanProcessor((mode as { exporter: SpanExporter }).exporter);
  const provider = new BasicTracerProvider({ resource, spanProcessors: [processor] });
  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
  const drops = watched ? dropCount((count) => watched.dropped(count)) : undefined;
  if (drops) {
    const quiet = () => {};
    diag.setLogger({
      warn: (message: string) => {
        const drop = DROPPED.exec(message);
        if (drop) drops.fromDiag(Number(drop[1]));
      },
      error: quiet, info: quiet, debug: quiet, verbose: quiet,
    }, DiagLogLevel.WARN);
  }
  return {
    serviceName: String(resource.attributes["service.name"] ?? serviceName),
    flush: async () => {
      if (!watched || !counted || !drops) {
        await provider.forceFlush().catch(() => {});
        return "sent";
      }
      return flushBatch(provider, counted, watched, drops);
    },
    shutdown: async () => {
      await provider.shutdown().catch(() => {});
      trace.disable();
      propagation.disable();
      context.disable();
      diag.disable();
    },
  };
}
