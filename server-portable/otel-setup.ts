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
// own — its version, an instance id fresh at each start, whatever
// OTEL_RESOURCE_ATTRIBUTES adds or overrides, and a pipeline tier's
// deployment.environment.name from OB1_TIER (PR 3a), which nothing overrides.
//
// What is not sent — an export that failed, one its collector never finished
// answering by its deadline, what a partial success rejected, or what a batch's
// full queue dropped — is said on stderr at most once a minute per signal, by count and
// kind (a count held inside a minute is said when the minute ends), and what is
// still unsaid at the stop, its own flush's failures included, is said then;
// never an error's message, which can carry the URL. Context follows a request
// through its awaits by AsyncLocalStorage, so a tool's span is its request's
// child and a request's log record names its trace; the W3C propagator reads
// an incoming `traceparent`, which telemetry.ts links to the request's span, or
// continues where the operator trusts it (OB1_OTEL_TRUST_TRACEPARENT=1) or the
// REST core's forwarder carried it (SMD-2287).
//
// Loaded only by startTelemetry, where a collector is named; every other
// process holds the API alone.

import { context, createNoopMeter, diag, DiagLogLevel, metrics, propagation, trace, TraceFlags, type Attributes, type Context, type MeterProvider } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ExportResultCode, W3CTraceContextPropagator, type ExportResult } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { defaultResource, detectResources, envDetector, resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider, SimpleLogRecordProcessor, type LogRecordExporter, type LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { MeterProvider as SdkMeterProvider, PeriodicExportingMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, type ReadableSpan, type Span, type SpanExporter, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { FlushResult } from "./shutdown.ts";
import { FORK_VERSION } from "./version.ts";
import { PIPELINE_TIERS } from "../db/config.mjs";

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
  /** The stop's flush cut short (SMD-2902): says, by signal, what was on its way or still batched as not sent, for `kind`. */
  cut(kind: string): void;
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
  /**
   * How long an export may go unanswered before it is counted as not sent, `no answer in time` (SMD-2902 PR 2): the
   * exporter's own timeout is an idle timeout, which a collector that trickles its answer never lets fire.
   */
  deadlineMs?: number;
  /** What a partial success said the collector rejected of the export just answered, taken once (SMD-2902 PR 2). */
  takeRejected?: () => number;
  /** How a partial success is said: `rejected by the collector`, or for a metric export, counted whole, `partly rejected by the collector`. */
  rejectedKind?: string;
}

/** What a watched export's deadline adds to twice the exporter's own timeout (exportDeadlineFrom). */
export const EXPORT_DEADLINE_MARGIN_MS = 2_000;

/**
 * The OTLP exporter's timeout for a signal as the SDK reads it (otlp-exporter-base's shared env configuration):
 * OTEL_EXPORTER_OTLP_<SIGNAL>_TIMEOUT, else OTEL_EXPORTER_OTLP_TIMEOUT, each a finite number above 0, else 10 s.
 */
export function exportTimeoutFrom(env: Record<string, string | undefined>, signal: "TRACES" | "METRICS" | "LOGS"): number {
  const read = (name: string) => {
    const raw = env[name];
    if (raw == null || raw.trim() === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return read(`OTEL_EXPORTER_OTLP_${signal}_TIMEOUT`) ?? read("OTEL_EXPORTER_OTLP_TIMEOUT") ?? 10_000;
}

/**
 * A watched export's deadline (SMD-2902 PR 2): twice the exporter's timeout, plus EXPORT_DEADLINE_MARGIN_MS, at most a
 * timer's longest. The SDK's retrying transport schedules a retry only when its wait (a backoff, or a Retry-After
 * header) fits in what is left of the timeout, and gives that attempt what is left as its own idle timer — so an
 * export that is answered at all ends by twice the timeout, and one past this deadline is a collector that never
 * finishes answering (review pass 1: a deadline of the timeout plus 2 s counted a Retry-After export that was then
 * answered as not sent).
 */
export function exportDeadlineFrom(env: Record<string, string | undefined>, signal: "TRACES" | "METRICS" | "LOGS"): number {
  return Math.min(MAX_TIMER, 2 * exportTimeoutFrom(env, signal) + EXPORT_DEADLINE_MARGIN_MS);
}

/** The OTLP exporter's one word on a partial success, which a diag logger at WARN is handed with the response's `partialSuccess` as JSON. */
const PARTIAL_SUCCESS = "Received Partial Success response:";
const REJECTED_FIELDS: Record<string, Signal> = { rejectedSpans: "traces", rejectedDataPoints: "metrics", rejectedLogRecords: "logs" };

/**
 * How many items a partial success rejected, by signal, from the diag line's arguments (SMD-2902 PR 2): its counts
 * alone — never its errorMessage, which is the collector's text. A count of 0 (a warning, by the spec) is none.
 */
export function partialRejections(message: string, args: unknown[]): Partial<Record<Signal, number>> {
  if (message !== PARTIAL_SUCCESS || typeof args[0] !== "string") return {};
  let body: unknown;
  try {
    body = JSON.parse(args[0]);
  } catch {
    return {};
  }
  const found: Partial<Record<Signal, number>> = {};
  for (const [field, signal] of Object.entries(REJECTED_FIELDS)) {
    const n = Number((body as Record<string, unknown> | null)?.[field]);
    if (Number.isSafeInteger(n) && n > 0) found[signal] = n;
  }
  return found;
}

/**
 * What each signal's partial successes rejected, between the diag line that says it and the export answered with it
 * (SMD-2902 PR 2): `add` reads a diag line, `take` gives a signal's count once and leaves it 0.
 */
export function partialBuckets(): { add(message: string, args: unknown[]): void; take(signal: Signal): number } {
  const by: Record<Signal, number> = { traces: 0, metrics: 0, logs: 0 };
  return {
    add: (message, args) => {
      for (const [signal, n] of Object.entries(partialRejections(message, args)) as [Signal, number][]) by[signal] += n;
    },
    take: (signal) => {
      const n = by[signal];
      by[signal] = 0;
      return n;
    },
  };
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
  /**
   * The stop's flush cut short (SMD-2902): counts the items of every export
   * still on its way, and `held` more its batch never handed over, as not sent
   * for `kind`, and says them at once. An export counted here is not counted
   * again when it ends.
   */
  cut(kind: string, held?: number): void;
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
export function watchExporter<T = ReadableSpan[]>(inner: Exporter<T>, { origin, warn, everyMs = 60_000, noun = ["span", "spans"], deadlineMs, takeRejected, rejectedKind = "rejected by the collector" }: Reporting, count: (items: T) => number = (items) => (items as unknown[]).length): WatchedExporter<T> {
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
  // Each export on its way, with its item count, and whether a cut, or its deadline, has already counted it.
  const pending = new Map<Promise<void>, { n: number; cut: boolean }>();
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
      const entry = { n, cut: false };
      pending.set(going, entry);
      // Past its deadline the export is counted as not sent — unless the stop's cut counted it already — and the SDK is
      // handed a failure, so its batch moves on; a flush, the stop's cut and idle() no longer wait on it, and its answer,
      // if one ever comes, counts nothing (SMD-2902 PR 2; review pass 1: a batch held the log records behind it).
      let over = false;
      const deadline = deadlineMs === undefined ? undefined : setTimeout(() => {
        over = true;
        failed += 1;
        if (!entry.cut) say(n, "no answer in time");
        entry.cut = true;
        pending.delete(going);
        settle();
        done({ code: ExportResultCode.FAILED, error: new Error("no answer in time") });
      }, deadlineMs);
      (deadline as { unref?: () => void } | undefined)?.unref?.();
      inner.export(items, (result) => {
        clearTimeout(deadline);
        // Taken whatever the answer, so a count belongs to the export answered with it alone.
        const rejected = takeRejected?.() ?? 0;
        if (over) return;
        if (result.code !== ExportResultCode.SUCCESS) {
          failed += 1;
          if (!entry.cut) say(n, failureKind(result.error));
        } else if (rejected > 0) {
          // A partial success: what the collector took is sent, what it rejected is not (the spec's count, at most the export's own).
          failed += 1;
          if (!entry.cut) say(Math.min(rejected, n), rejectedKind);
        }
        pending.delete(going);
        settle();
        done(result);
      });
    },
    dropped: (n) => say(n, "queue full"),
    sayRest: sayNow,
    cut: (kind, held = 0) => {
      let n = Math.max(0, held);
      for (const entry of pending.values()) {
        if (entry.cut) continue;
        entry.cut = true;
        n += entry.n;
      }
      if (n > 0) lost.set(kind, (lost.get(kind) ?? 0) + n);
      sayNow();
    },
    close: () => {
      closing = true;
      sayNow();
    },
    get handed() {
      return handed;
    },
    mark: () => ({ started, failed, pending: pending.size }),
    idle: async () => {
      await Promise.all([...pending.keys()]);
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
    // The exports this watcher still waits on, not the SDK's own queue, which holds one past its deadline until its
    // collector ends the trickle: the log batch and the metric reader call this from their flush (review pass 1).
    forceFlush: async () => {
      await Promise.all([...pending.keys()]);
    },
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
 * The log batch's counterpart of countingProcessor (SMD-2902): counts the
 * records it is handed, so a stop whose flush is cut knows how many it still
 * held — the log batch hands its queue over one batch at a time, after any
 * export already on its way, so a collector that hangs holds the rest back.
 */
export function countingLogProcessor(inner: LogRecordProcessor): LogRecordProcessor & { readonly queued: number } {
  let queued = 0;
  return {
    get queued() {
      return queued;
    },
    onEmit: (record, within) => {
      queued += 1;
      inner.onEmit(record, within);
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
export function dropCount(say: (count: number) => void): { fromDiag(count: number): void; exactly(total: number): void; readonly known: number } {
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
    // How many drops are known so far, said or not: what a cut takes off what the batch was handed (SMD-2902).
    get known() {
      return Math.max(diag, exact);
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
 * `max` (a note says that too). Neither note says the value: it may be a
 * secret pasted into the wrong variable, and one of digits alone parses as a
 * number too (SMD-3235 review pass 1). Nor the other value of a pair: where
 * `max` is a value the operator set in `pair`, the notes name `pair`, as the
 * bound and as a fallback equal to it (review pass 2).
 */
function wholeNumber(asked: string | undefined, name: string, fallback: number, notes: string[], { min = 1, max = Infinity, pair = "" } = {}): number {
  if (asked === undefined || asked.trim() === "") return fallback;
  const n = Number(asked);
  if (!Number.isInteger(n) || n < min) {
    notes.push(`telemetry: ${name} (a value not shown) is not a whole number of at least ${min}: ${pair && fallback === max ? `the value of ${pair}` : fallback} is used (SMD-1849)`);
    return fallback;
  }
  if (n > max) {
    notes.push(`telemetry: ${name} (a value not shown) is held to ${pair ? `the value of ${pair}` : max} (SMD-1849)`);
    return max;
  }
  return n;
}

/**
 * A batch's queue and export size from the operator's variables (`prefix`
 * OTEL_BSP for spans, OTEL_BLRP for log records): the queue 2,048 by default
 * and held to 65,536; the export size 512 by default and held to 1..the queue
 * — an export size of 0 sends either batch processor round a loop that never
 * ends (review pass 7). `notes` says each setting held or ignored.
 */
export function batchSizes(queueAsked: string | undefined, batchAsked: string | undefined, prefix: "OTEL_BSP" | "OTEL_BLRP" = "OTEL_BSP"): { queue: number; batch: number; notes: string[] } {
  const notes: string[] = [];
  const queue = wholeNumber(queueAsked, `${prefix}_MAX_QUEUE_SIZE`, 2048, notes, { max: MAX_QUEUE });
  // The queue is the operator's own value where it was set and nothing was said of it: then it is named, not said.
  const pair = queueAsked?.trim() && notes.length === 0 ? `${prefix}_MAX_QUEUE_SIZE` : "";
  const batch = wholeNumber(batchAsked, `${prefix}_MAX_EXPORT_BATCH_SIZE`, Math.min(512, queue), notes, { max: queue, pair });
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
  // As the queue for the export size (batchSizes): the operator's own interval is named, not said.
  const pair = intervalAsked?.trim() && notes.length === 0 ? "OTEL_METRIC_EXPORT_INTERVAL" : "";
  const timeout = wholeNumber(timeoutAsked, "OTEL_METRIC_EXPORT_TIMEOUT", Math.min(30_000, interval), notes, { max: interval, pair });
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

/** A request log record's severity names as the OTel log data model numbers them. */
const SEVERITY = { INFO: 9, WARN: 13, ERROR: 17 } as const;

/** A suite's: each signal into an exporter of its own, each span and log record handed over as it ends, the metrics at a flush. */
type InMemory = { exporter: SpanExporter; metrics?: PushMetricExporter; logs?: LogRecordExporter };
/** A server's: each signal with a URL over OTLP/HTTP, batched, what is not sent said through `report` (a setting held to its bound or read as its default through its `note`, where given, SMD-2909); `oneShot` where the process sends once and exits (preflight --deep), so it sends no uptime gauge. */
type Collector = { report: Omit<Reporting, "origin" | "noun"> & { note?: (line: string) => void }; urls: Partial<Record<Signal, string>>; oneShot?: boolean };

/** The resource's tier, where OB1_TIER names a pipeline tier (root.ts reads it trimmed and refuses any other at start); none for a plain brain. */
function tierAttribute(): Attributes {
  const tier = process.env.OB1_TIER?.trim();
  return tier !== undefined && (PIPELINE_TIERS as readonly string[]).includes(tier) ? { "deployment.environment.name": tier } : {};
}

/**
 * Registers a provider for each signal that has somewhere to go, the context
 * manager and the W3C propagator. A server's (Collector): each signal with a
 * URL is sent there — spans and log records batched, metrics at the reader's
 * interval — what is not sent said through `report`, by signal; the SDK's
 * diag output is read for the span batch's drops and a partial success's
 * counts alone (its other text can carry the URL, and a partial success's
 * message is the collector's), and a flush waits for exports already on their way (review
 * pass 2: the span batch's flush does not, and an empty one resolves at once).
 * A suite's (InMemory): its exporters, unbatched. Every provider is built
 * before any is registered, and a throw while building shuts down what was
 * built, so a setup that fails leaves nothing recording that no stop would
 * flush or shut down (review pass 1).
 */
export function setUpTelemetry(serviceName: string, mode: InMemory | Collector): Telemetry {
  const resource = defaultResource()
    // service.instance.id a fresh UUID per start (review pass 3 of PR 2d): the MCP server and the REST core under one
    // OTEL_SERVICE_NAME, or two tiers, would otherwise be one series whose cumulative readings interleave. No host, no process.
    .merge(resourceFromAttributes({ "service.name": serviceName, "service.version": FORK_VERSION, "service.instance.id": crypto.randomUUID() }))
    .merge(detectResources({ detectors: [envDetector] }))
    // A pipeline tier's brain (OB1_TIER, SMD-1806) says which as deployment.environment.name, a label Prometheus keeps, so a
    // canary sending to stable's collector is told apart by name, not by an instance id (SMD-1849 PR 3a) — over
    // OTEL_RESOURCE_ATTRIBUTES, which a canary's env file copies from stable's (review pass 2).
    .merge(resourceFromAttributes(tierAttribute()));
  const collector = "report" in mode ? mode : undefined;
  // The suite's exporters, read only where the mode is a suite's: a Collector's own options never pass as an exporter (review pass 3).
  const memory = "report" in mode ? undefined : mode;
  // What each signal's partial successes rejected, set by the diag line and taken by the export the line answered (SMD-2902 PR 2).
  const rejected = partialBuckets();
  const SDK_SIGNAL = { traces: "TRACES", metrics: "METRICS", logs: "LOGS" } as const;
  const reportFor = (url: string, noun: readonly [string, string], signal: Signal): Reporting => ({
    ...collector!.report, origin: new URL(url).origin, noun,
    deadlineMs: exportDeadlineFrom(process.env, SDK_SIGNAL[signal]),
    ...(signal === "metrics" ? { rejectedKind: "partly rejected by the collector" } : {}),
    takeRejected: () => rejected.take(signal),
  });
  // The span batch's drops, read from the diag line where spans are sent.
  let spanDropsFromDiag: ((count: number) => void) | undefined;
  const notes: string[] = [];
  const flushes: (() => Promise<FlushResult>)[] = [];
  /** Each watched signal's word when the stop cuts its flush short (SMD-2902). */
  const cuts: ((kind: string) => void)[] = [];
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
      const watched = watchExporter(new OTLPTraceExporter({ url: collector.urls.traces }), reportFor(collector.urls.traces, ["span", "spans"], "traces"));
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
      spanDropsFromDiag = (count) => drops.fromDiag(count);
      flushes.push(() => flushBatch(provider, counted, watched, drops));
      // What the batch was handed and never handed on, less its drops (already said), with what is on its way.
      cuts.push((kind) => watched.cut(kind, counted.queued - watched.handed - drops.known));
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
      const watched = collector?.urls.metrics ? watchExporter(metricExporter, reportFor(collector.urls.metrics, ["metric export", "metric exports"], "metrics"), () => 1) : undefined;
      const times = collector ? metricTimes(process.env.OTEL_METRIC_EXPORT_INTERVAL, process.env.OTEL_METRIC_EXPORT_TIMEOUT) : { interval: 3_600_000, timeout: 30_000, notes: [] };
      notes.push(...times.notes);
      // The reader asks its exporter which temporality and aggregation it wants: the OTLP exporter's, read from OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE.
      const exporter: PushMetricExporter = watched ? Object.assign(watched, {
        selectAggregationTemporality: metricExporter.selectAggregationTemporality?.bind(metricExporter),
        selectAggregation: metricExporter.selectAggregation?.bind(metricExporter),
      }) : metricExporter;
      const provider = new SdkMeterProvider({ resource, readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: times.interval, exportTimeoutMillis: times.timeout })] });
      // The uptime gauge (SMD-3050): the conventions' process.uptime, read at each export, so a running server sends a
      // series from its start — its request histogram has none until a request it records, and the keyless liveness
      // probe records none. The observability profile's "A server stopped sending metrics" rule reads it, so a process
      // that sends once and exits (preflight --deep) sends none: its one point would read as a server gone silent for a
      // day (review pass 1).
      if (!collector?.oneShot) provider.getMeter("ob1").createObservableGauge("process.uptime", { unit: "s", description: "How long the server's process has run" }).addCallback((reading) => reading.observe(process.uptime()));
      shutdowns.push(() => provider.shutdown().catch(() => {}));
      registers.push(() => metrics.setGlobalMeterProvider(provider));
      flushes.push(watched ? () => flushSignal(provider, watched) : async () => {
        await provider.forceFlush().catch(() => {});
        return "sent";
      });
      if (watched) {
        closes.push(() => watched.close());
        // A metric reader holds no queue: what was on its way.
        cuts.push((kind) => watched.cut(kind));
      }
    }

    // Log records: one per request, emitted by telemetry.ts through `emit`, under its span's context.
    let loggerProvider: LoggerProvider | undefined;
    if (collector?.urls.logs) {
      const watched = watchExporter(new OTLPLogExporter({ url: collector.urls.logs }), reportFor(collector.urls.logs, ["log record", "log records"], "logs"));
      const options = batchOptions(process.env, "OTEL_BLRP");
      notes.push(...options.notes);
      let logsDropped = 0;
      const counted = countingLogProcessor(new BatchLogRecordProcessor({
        exporter: watched,
        maxQueueSize: options.queue,
        maxExportBatchSize: options.batch,
        scheduledDelayMillis: options.delay,
        exportTimeoutMillis: options.timeout,
        selfObsMeterProvider: logDrops((count) => {
          logsDropped += count;
          watched.dropped(count);
        }),
      }));
      loggerProvider = new LoggerProvider({ resource, processors: [counted] });
      const provider = loggerProvider;
      flushes.push(() => flushSignal(provider, watched));
      // The records the batch still held behind an export on its way, less its drops (already said), with what is on its way.
      cuts.push((kind) => watched.cut(kind, counted.queued - watched.handed - logsDropped));
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
    // The SDK's diag output, read for two words alone — the span batch's drops and an exporter's partial success —
    // and never said: its other text can carry the URL, and a partial success's message is the collector's.
    if (collector) {
      const quiet = () => {};
      registers.push(() => diag.setLogger({
        warn: (message: string, ...args: unknown[]) => {
          const drop = DROPPED.exec(message);
          if (drop) spanDropsFromDiag?.(Number(drop[1]));
          rejected.add(message, args);
        },
        error: quiet, info: quiet, debug: quiet, verbose: quiet,
      }, DiagLogLevel.WARN));
    }
  } catch (err) {
    for (const close of closes) close();
    for (const shutdown of shutdowns) void shutdown();
    throw err;
  }

  // A setting held to its bound, or not read and its default used, is a note, not a loss: said through `note` where the caller tells them apart (SMD-2909).
  for (const line of notes) (collector?.report.note ?? collector?.report.warn)?.(line);
  for (const register of registers) register();
  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  return {
    serviceName: String(resource.attributes["service.name"] ?? serviceName),
    flush: async () => flushesResult(await Promise.all(flushes.map((flush) => flush()))),
    cut: (kind) => {
      for (const cut of cuts) cut(kind);
    },
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
