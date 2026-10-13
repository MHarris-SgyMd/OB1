// The OpenTelemetry API's side of spans.ts (SMD-1849 PR 2d): the spans a
// provider call, a store operation, a job's body and a webhook's deferred work
// run under, the points their histograms get, and the stop's cut of whatever
// is still open. telemetry.ts installs it (useTracing) as a server, or
// preflight under --deep, loads it, and builds its tool spans on it. Only the API comes in here,
// which the Workers bundle carries; the SDK is otel-setup.ts's, loaded by
// startTelemetry, and until then every span and point here is the API's no-op.

import * as otel from "@opentelemetry/api";
import { faultOf, NO_SPAN, type HistogramSpec, type SpanAttributes, type SpanRequest, type Tracing, type WorkSpan } from "./spans.ts";

/**
 * The tracer every span comes from: the API's no-op until otel-setup.ts
 * registers a provider. Read each time: a suite's shutdown (trace.disable())
 * replaces the API's proxy, so a tracer held from before would miss the next
 * provider.
 */
export const tracer = () => otel.trace.getTracer("ob1");

/** A fault on a span: an `exception` event with its kind and code (faultOf), and nothing of its message or stack. An SDK that throws loses the event, not the call. */
export function markFault(span: otel.Span, err: unknown): void {
  const { kind, code } = faultOf(err);
  try {
    span.addEvent("exception", code === undefined ? { "exception.type": kind } : { "exception.type": kind, "ob1.fault.code": code });
  } catch {}
}

/** Each histogram by its name, made again whenever the API's meter provider is another (the SDK set up, or a suite's stopped). */
let histograms: { provider: otel.MeterProvider; made: Map<string, otel.Histogram> } | undefined;

/** The histogram of this name, from the meter provider the API has now. */
export function histogram(name: string, spec: HistogramSpec): otel.Histogram {
  const provider = otel.metrics.getMeterProvider();
  if (histograms?.provider !== provider) histograms = { provider, made: new Map() };
  let made = histograms.made.get(name);
  if (!made) {
    made = provider.getMeter("ob1").createHistogram(name, { unit: spec.unit, description: spec.description, advice: { explicitBucketBoundaries: spec.bounds } });
    histograms.made.set(name, made);
  }
  return made;
}

/** The spans not yet ended, so the stop's cut ends each with its request (cutOpenSpans). */
const OPEN_SPANS = new Set<WorkSpan>();

/** Attributes without the ones left undefined, which the API would drop one by one with a warning each. */
const defined = (attributes: SpanAttributes | undefined): otel.Attributes => {
  const out: otel.Attributes = {};
  for (const [key, value] of Object.entries(attributes ?? {})) if (value !== undefined) out[key] = value;
  return out;
};

/** spans.ts's withSpan, on the OpenTelemetry API: what telemetry.ts installs. */
export const OTEL_TRACING: Tracing = {
  async run<T>(name: string, request: SpanRequest, fn: (span: WorkSpan) => Promise<T>): Promise<T> {
    const active = otel.context.active();
    const caller = request.root ? otel.trace.getSpanContext(active) : undefined;
    const parent = request.root ? otel.ROOT_CONTEXT : active;
    const started = performance.now();
    // Never the work's undoing (review pass 1): an SDK that throws as a span starts runs the work with none, and one
    // that throws as it is told or ended loses what it was told — a store write that landed is never reported failed.
    let span: otel.Span;
    try {
      span = tracer().startSpan(name, {
        kind: request.kind === "client" ? otel.SpanKind.CLIENT : otel.SpanKind.INTERNAL,
        attributes: defined(request.attributes),
        links: caller && otel.isSpanContextValid(caller) ? [{ context: caller }] : undefined,
      }, parent);
    } catch {
      return fn(NO_SPAN);
    }
    let done = false;
    const handle: WorkSpan = {
      end: (outcome, errorType) => {
        if (done) return;
        done = true;
        OPEN_SPANS.delete(handle);
        const type = outcome === "error" || outcome === "cut" ? errorType ?? outcome : undefined;
        let failed: SpanAttributes = {};
        try {
          if (type !== undefined) failed = { "error.type": type, ...request.failed?.(type) };
        } catch {}
        try {
          span.setAttributes(defined({ "ob1.outcome": outcome, ...failed }));
          if (type !== undefined) span.setStatus({ code: otel.SpanStatusCode.ERROR });
          span.end();
        } catch {}
        try {
          if (request.metric) histogram(request.metric.name, request.metric.spec).record((performance.now() - started) / 1000, defined({ ...request.metric.labels, ...failed }));
        } catch {}
      },
      fault: (err) => {
        if (!done) markFault(span, err);
      },
      set: (attributes) => {
        try {
          if (!done) span.setAttributes(defined(attributes));
        } catch {}
      },
    };
    OPEN_SPANS.add(handle);
    let value: T;
    try {
      value = await otel.context.with(otel.trace.setSpan(parent, span), () => fn(handle));
    } catch (err) {
      handle.fault(err);
      let type: string | undefined;
      // Its own guard, as faultOf's reads have theirs: a classifier that throws leaves the fault's code or kind.
      try {
        type = request.errorType?.(err);
      } catch {}
      if (type === undefined) {
        const { kind, code } = faultOf(err);
        type = code ?? kind;
      }
      handle.end("error", type);
      throw err;
    }
    handle.end("ok");
    return value;
  },
};

/** How many work spans are open: a suite holds it to none once its work is done. */
export function openSpanCount(): number {
  return OPEN_SPANS.size;
}

/** Ends every span still open as `cut`: the stop's, with the requests it cuts (telemetry.ts cutOpenRequests). */
export function cutOpenSpans(): void {
  for (const span of [...OPEN_SPANS]) span.end("cut");
}
