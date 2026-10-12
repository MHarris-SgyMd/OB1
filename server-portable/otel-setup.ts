// The OpenTelemetry SDK (SMD-1849: traces in PR 2b, metrics and the log record
// in PR 2c), set up only when an operator names a collector: telemetry.ts
// loads this module then, and only on Bun, and hands it each signal's URL —
// the signal's own endpoint (OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, …_METRICS_…,
// …_LOGS_…), else OTEL_EXPORTER_OTLP_ENDPOINT with the signal's path. Until it
// runs, the spans and the request-duration histogram telemetry.ts records are
// the API's no-ops, and no log record is made — nothing is recorded and nothing
// is sent.
//
// Each signal goes over OTLP/HTTP as JSON to its URL: spans and log records in
// batches, metrics every OTEL_METRIC_EXPORT_INTERVAL (60 s). The exporters read
// the standard OTEL_EXPORTER_OTLP_* variables (headers, a timeout) and the tracer
// provider the sampler's (OTEL_TRACES_SAMPLER); the span batch's (OTEL_BSP_*),
// the log batch's (OTEL_BLRP_*) and the metric reader's are read here and held
// to their bounds (batchOptions, metricTimes). The resource is the SDK's own
// (telemetry.sdk.*), the service's name — OTEL_SERVICE_NAME, else the server's
// own — its version, and whatever OTEL_RESOURCE_ATTRIBUTES adds or overrides
// (a tier's name, PR 3).
//
// What is not sent — an export that failed, or what a batch's full queue
// dropped — is said on stderr at most once a minute per signal, by count and
// kind (a count held inside a minute is said when the minute ends), and what is
// still unsaid at the stop, its own flush's failures included, is said then;
// never an error's message, which can carry the URL. Context follows a request
// through its awaits by AsyncLocalStorage, so a tool's span is its request's
// child and a request's log record names its trace; the W3C propagator reads
// an incoming `traceparent`, which telemetry.ts links to the request's span, or
// continues where the operator trusts it (OB1_OTEL_TRUST_TRACEPARENT=1).
//
// Workers never loads this: wrangler.toml aliases it to
// shims/otel-unavailable.ts, so the Worker's bundle holds the API alone.

import { context, createNoopMeter, diag, DiagLogLevel, metrics, propagation, trace, TraceFlags, type Attributes, type Context, type MeterProvider } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ExportResultCode, W3CTraceContextPropagator, type ExportResult } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { defaultResource, detectResources, envDetector, resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider, SimpleLogRecordProcessor, type LogRecordExporter } from "@opentelemetry/sdk-logs";
import { MeterProvider as SdkMeterProvider, PeriodicExportingMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, type ReadableSpan, type Span, type SpanExporter, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { FlushResult } from "./shutdown.ts";
import { FORK_VERSION } from "./version.ts";

/** The three signals, each sent only where it has a URL. */
export type Signal = "traces" | "metrics" | "logs";

/** One request's log record, as telemetry.ts hands it over: the line's checked fields, how bad its end was, its span's context and its end. */
export interface RequestLog {
  body: Record<string, string | number>;
  severity: "INFO" | "WARN" | "ERROR";
  context: Context;
  /** When the request ended (performance.now()). */
  at: number;
}

export interface Telemetry {
  /** The service the signals go out as: the resource's `service.name`, after OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES. */
  readonly serviceName: string;
  /** Sends what is batched and waits for what is on its way, every signal at once: how that ended (shutdown.ts FlushResult; the stop bounds it). */
  flush(): Promise<FlushResult>;
  /** Unregisters the providers, so later spans and points are no-ops again (a suite's). */
  shutdown(): Promise<void>;
  /** Emits a request's log record; nothing where log records are not sent. */
  emit(record: RequestLog): void;
}

/** Where what is not sent is said: the collector's origin, the line's sink, and what is counted. */
interface Reporting {
  origin: string;
  warn: (line: string) => void;
  /** At most one line per this many milliseconds (60 s). */
  everyMs?: number;
  /** What the exporter sends, one and many (`span`, `spans`). */
  noun?: readonly [string, string];
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

/** At most this many kinds named in one line, the most first; the rest said as `others`. */
const KINDS_SAID = 5;

/** What every exporter here is: spans, metrics and log records alike. */
interface Exporter<T> {
  export(items: T, done: (result: ExportResult) => void): void;
  shutdown(): Promise<void>;
  forceFlush?(): Promise<void>;
}

/** The exporter a collector's signal goes through: it says what was not sent, and tells a flush what it saw. */
export interface WatchedExporter<T = ReadableSpan[]> extends Exporter<T> {
  /** Items dropped before an export (a batch's queue full), said as an export's failure is. */
  dropped(count: number): void;
  /** Says what is still unsaid, whatever the window — the stop's last word on what was not sent. */
  sayRest(): void;
  /** From now on says each count at once, and says what is held: the provider is shutting down, whether or not its batch reaches this exporter's shutdown. */
  close(): void;
  /** How many items were handed to an export, so far. */
  readonly handed: number;
  /** Where things stand, to compare after a flush. */
  mark(): { started: number; failed: number; pending: number };
  /** Waits for every export on its way. */
  idle(): Promise<void>;
  forceFlush(): Promise<void>;
}

/**
 * An exporter that says when what it sends is not sent — every item since the
 * last line, by kind (failureKind; `queue full` for a batch's drops), with
 * the origin — at most once a window, and nothing of a message; and that keeps
 * the count of exports started, failed and on their way, so a flush can tell
 * sent from failed from nothing at all. A window's line names each kind it
 * counts (review pass 3: one kind's name was on spans lost to another).
 * `count` is how many items one export holds: an array's length (spans, log
 * records), or 1 for a metric export, whose cumulative reading the next export sends again.
 */
export function watchExporter<T = ReadableSpan[]>(inner: Exporter<T>, { origin, warn, everyMs = 60_000, noun = ["span", "spans"] }: Reporting, count: (items: T) => number = (items) => (items as unknown[]).length): WatchedExporter<T> {
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
    warn(`telemetry: ${total} ${total === 1 ? noun[0] : noun[1]} not sent to ${origin} (${kinds}) (SMD-1849)`);
    saidAt = performance.now();
    lost.clear();
  };
  const say = (n: number, kind: string) => {
    lost.set(kind, (lost.get(kind) ?? 0) + n);
    const since = performance.now() - saidAt;
    if (closing || since >= everyMs) sayNow();
    else if (!held) {
      held = setTimeout(sayNow, everyMs - since);
      (held as { unref?: () => void }).unref?.();
    }
  };
  return {
    export(items: T, done: (result: ExportResult) => void) {
      const n = count(items);
      started += 1;
      handed += n;
      let settle = () => {};
      const going = new Promise<void>((resolve) => { settle = resolve; });
      pending.add(going);
      inner.export(items, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) {
          failed += 1;
          say(n, failureKind(result.error));
        }
        pending.delete(going);
        settle();
        done(result);
      });
    },
    dropped: (n) => say(n, "queue full"),
    sayRest: sayNow,
    close: () => {
      closing = true;
      sayNow();
    },
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

/** Several signals' flushes as one: failed if any failed, else sent if any sent, else none. */
export function flushesResult(results: readonly FlushResult[]): FlushResult {
  return results.includes("failed") ? "failed" : results.includes("sent") ? "sent" : "none";
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
 * A metric reader's or a log batch's flush, as the stop runs it: what is
 * unsaid is said before the wait and after it, and how it ended. Neither needs
 * the spans' count of drops — the log batch says each as it drops it
 * (logDrops), and a metric reader holds no queue.
 */
export async function flushSignal<T>(provider: { forceFlush(): Promise<void> }, watched: WatchedExporter<T>): Promise<FlushResult> {
  const before = watched.mark();
  const flushing = provider.forceFlush().catch(() => {});
  watched.sayRest();
  await flushing;
  await watched.idle();
  watched.sayRest();
  return flushResult(before, watched.mark());
}

/**
 * The log batch's own meter, read for its drops alone: the batch counts each
 * record its full queue drops on `otel.sdk.processor.log.processed` with
 * `error.type` `queue_full`, as it drops it, and says it nowhere else (no diag
 * line, unlike the span batch's). Every other instrument is the API's no-op.
 */
export function logDrops(dropped: (count: number) => void): MeterProvider {
  const noop = createNoopMeter();
  const meter = Object.assign(Object.create(noop) as typeof noop, {
    createCounter: () => ({ add: (n: number, attributes?: Attributes) => { if (attributes?.["error.type"] === "queue_full") dropped(n); } }),
  });
  return { getMeter: () => meter };
}

/**
 * A batch's queue at most: OTEL_BSP_MAX_QUEUE_SIZE and OTEL_BLRP_MAX_QUEUE_SIZE are the operator's, but each item
 * held costs memory (a span 1–2 KB, measured in review pass 7), and a keyless flood fills any queue while a collector
 * stalls (review pass 6: a million spans took the server to 6 GB).
 */
const MAX_QUEUE = 65_536;

/** A timer's longest: past it a runtime fires at once (Bun's TimeoutOverflowWarning sets 1 ms), so the reader or the batch would export back to back (review pass 1). */
const MAX_TIMER = 2_147_483_647;

/**
 * A whole number from an operator's variable: `fallback` where it is unset or
 * blank, or is no whole number of at least `min` (a note says so); held to
 * `max` (a note says that too).
 */
function wholeNumber(asked: string | undefined, name: string, fallback: number, notes: string[], { min = 1, max = Infinity } = {}): number {
  if (asked === undefined || asked.trim() === "") return fallback;
  const n = Number(asked);
  if (!Number.isInteger(n) || n < min) {
    notes.push(`telemetry: ${name} ${JSON.stringify(asked.slice(0, 32))} is not a whole number of at least ${min}: ${fallback} is used (SMD-1849)`);
    return fallback;
  }
  if (n > max) {
    notes.push(`telemetry: ${name} ${n} is held to ${max} (SMD-1849)`);
    return max;
  }
  return n;
}

/**
 * A batch's queue and export size from the operator's variables (`prefix`
 * OTEL_BSP for spans, OTEL_BLRP for log records): the queue 2,048 by default
 * and held to 65,536; the export size 512 by default and held to 1..the queue
 * — an export size of 0 sends either batch processor round a loop that never
 * ends (review pass 7). `notes` says each value held or ignored.
 */
export function batchSizes(queueAsked: string | undefined, batchAsked: string | undefined, prefix: "OTEL_BSP" | "OTEL_BLRP" = "OTEL_BSP"): { queue: number; batch: number; notes: string[] } {
  const notes: string[] = [];
  const queue = wholeNumber(queueAsked, `${prefix}_MAX_QUEUE_SIZE`, 2048, notes, { max: MAX_QUEUE });
  const batch = wholeNumber(batchAsked, `${prefix}_MAX_EXPORT_BATCH_SIZE`, Math.min(512, queue), notes, { max: queue });
  return { queue, batch, notes };
}

/**
 * The metric reader's interval and export timeout: 60 s and 30 s by default,
 * as the SDK's variables say; the interval at least a second and at most a
 * timer's longest, and the timeout held to the interval — the reader refuses
 * to start with a timeout past an interval it is given, and would take the
 * setup with it.
 */
export function metricTimes(intervalAsked: string | undefined, timeoutAsked: string | undefined): { interval: number; timeout: number; notes: string[] } {
  const notes: string[] = [];
  const interval = wholeNumber(intervalAsked, "OTEL_METRIC_EXPORT_INTERVAL", 60_000, notes, { min: 1000, max: MAX_TIMER });
  const timeout = wholeNumber(timeoutAsked, "OTEL_METRIC_EXPORT_TIMEOUT", Math.min(30_000, interval), notes, { max: interval });
  return { interval, timeout, notes };
}

/**
 * A batch's options from the operator's variables (`prefix` OTEL_BSP for
 * spans, OTEL_BLRP for log records), each passed to its batch processor — the
 * log batch reads none of them itself, and the span batch reads its own
 * without a bound (review pass 2: an export timeout past a timer's longest
 * fired at once, and exports overlapped): its sizes (batchSizes), its delay
 * (5 s for spans and 1 s for log records, as the SDK's variables say; 0 sends
 * each as it comes) and its export's timeout (30 s), each timer at most a
 * timer's longest.
 */
export function batchOptions(env: Record<string, string | undefined>, prefix: "OTEL_BSP" | "OTEL_BLRP"): { queue: number; batch: number; delay: number; timeout: number; notes: string[] } {
  const sizes = batchSizes(env[`${prefix}_MAX_QUEUE_SIZE`], env[`${prefix}_MAX_EXPORT_BATCH_SIZE`], prefix);
  const notes = [...sizes.notes];
  const delay = wholeNumber(env[`${prefix}_SCHEDULE_DELAY`], `${prefix}_SCHEDULE_DELAY`, prefix === "OTEL_BSP" ? 5000 : 1000, notes, { min: 0, max: MAX_TIMER });
  const timeout = wholeNumber(env[`${prefix}_EXPORT_TIMEOUT`], `${prefix}_EXPORT_TIMEOUT`, 30_000, notes, { max: MAX_TIMER });
  return { queue: sizes.queue, batch: sizes.batch, delay, timeout, notes };
}

/** The span batch's one word on dropped spans, which a diag logger at WARN is handed. */
const DROPPED = /^Dropped (\d+) spans because maxQueueSize reached$/;

const SEVERITY = { INFO: 9, WARN: 13, ERROR: 17 } as const;

/** A suite's: each signal into an exporter of its own, each span and log record handed over as it ends, the metrics at a flush. */
type InMemory = { exporter: SpanExporter; metrics?: PushMetricExporter; logs?: LogRecordExporter };
/** A server's: each signal with a URL over OTLP/HTTP, batched, what is not sent said through `report`. */
type Collector = { report: Omit<Reporting, "origin" | "noun">; urls: Partial<Record<Signal, string>> };

/**
 * Registers a provider for each signal that has somewhere to go, the context
 * manager and the W3C propagator. A server's (Collector): each signal with a
 * URL is sent there — spans and log records batched, metrics at the reader's
 * interval — what is not sent said through `report`, by signal; the SDK's
 * diag output is read for the span batch's drops alone (its other text can
 * carry the URL), and a flush waits for exports already on their way (review
 * pass 2: the span batch's flush does not, and an empty one resolves at once).
 * A suite's (InMemory): its exporters, unbatched. Every provider is built
 * before any is registered, and a throw while building shuts down what was
 * built, so a setup that fails leaves nothing recording that no stop would
 * flush or shut down (review pass 1).
 */
export function setUpTelemetry(serviceName: string, mode: InMemory | Collector): Telemetry {
  const resource = defaultResource()
    .merge(resourceFromAttributes({ "service.name": serviceName, "service.version": FORK_VERSION }))
    .merge(detectResources({ detectors: [envDetector] }));
  const collector = "report" in mode ? mode : undefined;
  // The suite's exporters, read only where the mode is a suite's: a Collector's own options never pass as an exporter (review pass 3).
  const memory = "report" in mode ? undefined : mode;
  const reportFor = (url: string, noun: readonly [string, string]): Reporting => ({ ...collector!.report, origin: new URL(url).origin, noun });
  const notes: string[] = [];
  const flushes: (() => Promise<FlushResult>)[] = [];
  const closes: (() => void)[] = [];
  const shutdowns: (() => Promise<void>)[] = [];
  /** What setting up does to the API's globals, done only once every provider is built. */
  const registers: (() => void)[] = [];
  let logger: ReturnType<LoggerProvider["getLogger"]> | undefined;

  try {
    // Spans: a suite's exporter, or the collector's batch with its drops counted.
    let tracerProvider: BasicTracerProvider | undefined;
    if (memory) {
      tracerProvider = new BasicTracerProvider({ resource, spanProcessors: [new SimpleSpanProcessor(memory.exporter)] });
      const provider = tracerProvider;
      flushes.push(async () => {
        await provider.forceFlush().catch(() => {});
        return "sent";
      });
    } else if (collector?.urls.traces) {
      const watched = watchExporter(new OTLPTraceExporter({ url: collector.urls.traces }), reportFor(collector.urls.traces, ["span", "spans"]));
      const options = batchOptions(process.env, "OTEL_BSP");
      notes.push(...options.notes);
      const counted = countingProcessor(new BatchSpanProcessor(watched, {
        maxQueueSize: options.queue,
        maxExportBatchSize: options.batch,
        scheduledDelayMillis: options.delay,
        exportTimeoutMillis: options.timeout,
      }));
      tracerProvider = new BasicTracerProvider({ resource, spanProcessors: [counted] });
      const provider = tracerProvider;
      const drops = dropCount((count) => watched.dropped(count));
      const quiet = () => {};
      registers.push(() => diag.setLogger({
        warn: (message: string) => {
          const drop = DROPPED.exec(message);
          if (drop) drops.fromDiag(Number(drop[1]));
        },
        error: quiet, info: quiet, debug: quiet, verbose: quiet,
      }, DiagLogLevel.WARN));
      flushes.push(() => flushBatch(provider, counted, watched, drops));
      // The watcher closed first: the batch's shutdown flush may fail, and never reach the exporter's own shutdown (review pass 7).
      closes.push(() => watched.close());
    }
    if (tracerProvider) {
      const provider = tracerProvider;
      registers.push(() => trace.setGlobalTracerProvider(provider));
      shutdowns.push(() => provider.shutdown().catch(() => {}));
    }

    // Metrics: read at the interval, or at a flush; a suite's reader only at a flush.
    const metricExporter = collector?.urls.metrics ? new OTLPMetricExporter({ url: collector.urls.metrics }) : memory?.metrics;
    if (metricExporter) {
      // Counted by export, not by point: a cumulative reading is sent whole each time, so the next export carries what a failed one held (review pass 1).
      const watched = collector?.urls.metrics ? watchExporter(metricExporter, reportFor(collector.urls.metrics, ["metric export", "metric exports"]), () => 1) : undefined;
      const times = collector ? metricTimes(process.env.OTEL_METRIC_EXPORT_INTERVAL, process.env.OTEL_METRIC_EXPORT_TIMEOUT) : { interval: 3_600_000, timeout: 30_000, notes: [] };
      notes.push(...times.notes);
      // The reader asks its exporter which temporality and aggregation it wants: the OTLP exporter's, read from OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE.
      const exporter: PushMetricExporter = watched ? Object.assign(watched, {
        selectAggregationTemporality: metricExporter.selectAggregationTemporality?.bind(metricExporter),
        selectAggregation: metricExporter.selectAggregation?.bind(metricExporter),
      }) : metricExporter;
      const provider = new SdkMeterProvider({ resource, readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: times.interval, exportTimeoutMillis: times.timeout })] });
      shutdowns.push(() => provider.shutdown().catch(() => {}));
      registers.push(() => metrics.setGlobalMeterProvider(provider));
      flushes.push(watched ? () => flushSignal(provider, watched) : async () => {
        await provider.forceFlush().catch(() => {});
        return "sent";
      });
      if (watched) closes.push(() => watched.close());
    }

    // Log records: one per request, emitted by telemetry.ts through `emit`, under its span's context.
    let loggerProvider: LoggerProvider | undefined;
    if (collector?.urls.logs) {
      const watched = watchExporter(new OTLPLogExporter({ url: collector.urls.logs }), reportFor(collector.urls.logs, ["log record", "log records"]));
      const options = batchOptions(process.env, "OTEL_BLRP");
      notes.push(...options.notes);
      loggerProvider = new LoggerProvider({
        resource,
        processors: [new BatchLogRecordProcessor({
          exporter: watched,
          maxQueueSize: options.queue,
          maxExportBatchSize: options.batch,
          scheduledDelayMillis: options.delay,
          exportTimeoutMillis: options.timeout,
          selfObsMeterProvider: logDrops((count) => watched.dropped(count)),
        })],
      });
      const provider = loggerProvider;
      flushes.push(() => flushSignal(provider, watched));
      closes.push(() => watched.close());
    } else if (memory?.logs) {
      loggerProvider = new LoggerProvider({ resource, processors: [new SimpleLogRecordProcessor({ exporter: memory.logs })] });
      const provider = loggerProvider;
      flushes.push(async () => {
        await provider.forceFlush().catch(() => {});
        return "sent";
      });
    }
    if (loggerProvider) {
      const provider = loggerProvider;
      shutdowns.push(() => provider.shutdown().catch(() => {}));
    }
    logger = loggerProvider?.getLogger("ob1");
  } catch (err) {
    for (const close of closes) close();
    for (const shutdown of shutdowns) void shutdown();
    throw err;
  }

  for (const line of notes) collector?.report.warn(line);
  for (const register of registers) register();
  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  return {
    serviceName: String(resource.attributes["service.name"] ?? serviceName),
    flush: async () => flushesResult(await Promise.all(flushes.map((flush) => flush()))),
    shutdown: async () => {
      for (const close of closes) close();
      await Promise.all(shutdowns.map((shutdown) => shutdown()));
      trace.disable();
      metrics.disable();
      propagation.disable();
      context.disable();
      diag.disable();
    },
    emit: logger
      ? ({ body, severity, context: within, at }) => logger!.emit({ eventName: "ob1.request", timestamp: at, severityNumber: SEVERITY[severity], severityText: severity, body, context: within })
      : () => {},
  };
}
