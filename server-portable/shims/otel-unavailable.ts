/**
 * Workers-only stub for otel-setup.ts (SMD-1849 PR 2b).
 *
 * telemetry.ts loads the OpenTelemetry SDK with a dynamic import, and only on
 * Bun (startTelemetry runs where the server serves on Bun). But wrangler's
 * bundler resolves dynamic imports statically, and would put the whole SDK —
 * its exporter, its context manager, `async_hooks` — into the Worker for code
 * that never runs there. Mapped here via `[alias]` in wrangler.toml, so the
 * Worker carries the API's no-ops alone. CI's Workers build holds that the
 * bundle names none of the SDK's packages.
 *
 * Nothing here should ever run: reaching it means something started
 * telemetry on Workers, where no SDK is bundled. Fail loudly and say so.
 */

import type { Tracing } from "../otel-setup.ts";

export function setUpTracing(): Tracing {
  throw new Error("OpenTelemetry is not bundled for Cloudflare Workers: the SDK is set up only where the server runs on Bun (telemetry.ts startTelemetry, called where SERVES_ON_BUN). Reaching this is a bug in the code that started it; deploy to a container runtime (Bun) for traces.");
}
