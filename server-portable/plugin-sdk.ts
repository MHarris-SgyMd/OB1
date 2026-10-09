// What a plugin imports (SMD-2310): the one module a `plugins/<name>/` file
// reaches outside its own directory. A plugin is a curated contribution that
// runs inside the brain's servers (the REST core and the MCP server) — its
// operations join the brain's one contract (SMD-1931), so the REST core routes
// them, the MCP server lists them
// as tools and the OpenAPI document describes them, each behind the same scope
// gate as a core operation (tools.ts's UNLOCKS). zod comes from here, not from
// a bare import in the plugin: a plugin's directory has no node_modules of its
// own, in a checkout or in the image.

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Scope } from "./auth.ts";
import type { ToolName } from "./tools.ts";
import type { CoreAnswer } from "./core/calls.ts";
import type { SPECS } from "./core/schemas.ts";
import type { PluginSql } from "./store.ts";

export { z };
export type { PluginSql };

/** The scope an operation needs, as a core tool's group: read, capture, or write (a forwarder's key is no caller). */
export type PluginScope = Exclude<Scope, "forward">;

/** An input or an output: a zod object's shape, each field its own schema — the form core/schemas.ts gives a tool's input. */
export type Shape = Record<string, z.ZodType>;

/** A refusal a plugin answers: its status, its own code, and facts beside it — JSON a caller can act on. */
export type PluginRefusal = { status: 400 | 403 | 404 | 409 | 422; code: string; message?: string } & Record<string, unknown>;

/** An operation's answer: the value its output schema describes, or a refusal. A fault is thrown. */
export type PluginOutcome<T> = { ok: true; value: T } | { ok: false; refusal: PluginRefusal };

/** A core operation's input, as its caller writes it: before the schema fills defaults. */
export type CoreInput<K extends ToolName> = z.input<z.ZodObject<(typeof SPECS)[K]["inputSchema"]>>;

/** Who called, as a plugin may read it: the key's name, its scope and its stable agent id. */
export type Caller = { readonly name: string; readonly scope: PluginScope; readonly agentId?: string };

/** A core call's refusal from the gate, before the core: the caller's key may not call that operation. */
export type CallForbidden = { ok: false; refusal: { code: "FORBIDDEN"; retryable: false; needs: string } };

/** A core call's refusal from the input, before the core: the plugin gave the operation input its schema refuses. */
export type CallRefusedInput = { ok: false; refusal: { code: "REFUSED_INPUT"; retryable: false; issues: { path: string; message: string }[] } };

/** What a handler runs against. */
export interface PluginContext {
  /** The caller. */
  readonly caller: Caller;
  /**
   * A core operation, as the caller: the same scope gate a REST route or an
   * MCP tool asks (a read operation's caller with a read key cannot capture
   * through it), the operation's own schema, and the caller's principal on
   * the audit row. The only way a plugin reaches the brain's thoughts. Its
   * answer is the operation's whole value — capture_thought's carries more
   * than the REST core tells a key that cannot read — so an operation's
   * output schema should declare no more than its caller may see.
   */
  call<K extends ToolName>(name: K, input: CoreInput<K>): Promise<CoreAnswer<K> | CallForbidden | CallRefusedInput>;
  /**
   * The plugin's own tables: `db.tx(async (sql) => …)` runs in one
   * transaction as the plugin's Postgres role (`ob1_plugin_<name>`), its
   * schema (`plugin_<name>`) first on the path — so a table is named bare,
   * and a core table is refused by Postgres. `sql` is a tagged template: each
   * `${value}` is a bound parameter, never text. The tables are the plugin's
   * migrations', which the migrator applies while the plugin is enabled.
   */
  readonly db: { tx<T>(fn: (sql: PluginSql) => Promise<T>): Promise<T> };
}

export type Method = "GET" | "POST" | "PATCH" | "DELETE";

export interface PluginOperation<I extends Shape = Shape, O extends Shape = Shape> {
  title: string;
  description: string;
  /** The scope a key needs to call it — and to see it in tools/list and whoami. */
  scope: PluginScope;
  /** Its REST route: the method, and a path under the plugin's own (`/v1/plugins/<name>`); `{field}` fills an input field. */
  method: Method;
  path: string;
  input: I;
  /** What a success answers: the REST body, the MCP tool's structured content, the OpenAPI response schema. */
  output: O;
  /** MCP hints; a read operation is read-only unless it says otherwise. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  handler(ctx: PluginContext, input: z.output<z.ZodObject<I>>): Promise<PluginOutcome<z.input<z.ZodObject<O>>>>;
}

export interface PluginManifest {
  /** The plugin's name: its directory, its `OB1_PLUGINS` entry, its route segment and its tools' prefix. Lower-case letters, digits and hyphens. */
  name: string;
  title: string;
  description: string;
  /** Each operation, keyed by its name: lower-case letters, digits and underscores. Its tool is `<name>_<key>`, a hyphen in the plugin's name read as `_`. */
  operations: Record<string, PluginOperation>;
  /**
   * The plugin's pages in the operator GUI (SMD-2280): each a path under the
   * plugin's own and the label its nav entry shows. The REST core lists an
   * enabled plugin's at GET /v1/plugins, which the GUI's nav reads; the pages
   * themselves are the GUI's to render.
   */
  gui?: { pages: GuiPage[] };
  /**
   * Its inbound webhooks (SMD-2310), keyed by name: each a POST the REST core
   * serves at /hooks/<plugin>/<name> with no key — the sender is no brain key
   * holder, so the handler verifies the request itself, against the secret
   * the operator set (ctx.secret) — and only while OB1_HOOKS names the
   * plugin. The proxy reaches them only where the operator names
   * deploy/compose.hooks-public.yaml.
   */
  hooks?: Record<string, PluginHook>;
}

/**
 * An inbound webhook's request: its headers (names lower-cased), its query,
 * its body as the bytes the sender sent (at most 1 MiB) — what a signature is
 * over — and the same bytes read as UTF-8 text, for parsing.
 */
export type HookRequest = { headers: Readonly<Record<string, string>>; query: Readonly<Record<string, string>>; body: Uint8Array; text: string };

/** A webhook's answer to its sender: a status, and a JSON body if it has one. */
export type HookAnswer = { status: 200 | 202 | 204 | 400 | 401 | 403 | 404 | 409 | 413 | 422 | 503; body?: Record<string, unknown> };

/** What a webhook's handler runs against: the core as the hook's own capture-only caller, the plugin's tables, and its secret. */
export interface HookContext {
  /**
   * A core operation as `hook:<plugin>`, a caller of capture scope alone: a
   * webhook may add a thought, and nothing it is sent can read, change or
   * delete one. The audit row names it.
   */
  call: PluginContext["call"];
  readonly db: PluginContext["db"];
  /** The secret OB1_HOOK_SECRETS gives this plugin: always set — with none, the REST core answers 503 and never calls the handler. */
  readonly secret: string;
  /**
   * The longest one capture_thought's model calls may run under this brain's
   * settings, in seconds — OB1_LLM_TIMEOUT, twice over with OB1_CHUNK_CONTEXT
   * on, or the genre tier's deadline if longer — which a plugin cannot read
   * itself. onceById sizes its lease from it.
   */
  readonly captureSeconds: number;
}

export interface PluginHook {
  description: string;
  handler(ctx: HookContext, request: HookRequest): Promise<HookAnswer>;
}

/** HMAC-SHA256 of `data` (the body's bytes, or text) under `key`, as lower-case hex — the signature most webhook senders send. Over the body alone it verifies a resend forever: a sender that signs the time too is verifyTimestamped's. */
export function hmacSha256Hex(key: string, data: Uint8Array | string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

/** Whether two strings are equal, in time that does not depend on where they first differ — for comparing a signature. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * How a sender signs a delivery with the time it sent it (SMD-2755): the
 * HMAC-SHA256, under the plugin's secret, of `<prefix><timestamp><separator>`
 * followed by the body's bytes, as hex in one header (after
 * `signaturePrefix`), the timestamp — Unix seconds — in another. A signature
 * over the body alone verifies forever, so a recorded delivery could be resent
 * at will; one over the time too verifies for the tolerance alone. Slack's is
 * `{ signatureHeader: "x-slack-signature", signaturePrefix: "v0=",
 * timestampHeader: "x-slack-request-timestamp", prefix: "v0:", separator: ":" }`.
 */
export type TimestampedScheme = {
  signatureHeader: string;
  timestampHeader: string;
  /** Before the timestamp in what is signed: none by default. */
  prefix?: string;
  /** Between the timestamp and the body in what is signed: "." by default. */
  separator?: string;
  /** Before the hex in the signature header (Slack's "v0="): none by default. */
  signaturePrefix?: string;
  /** How far the timestamp may be from the server's clock, either way, in seconds: 300 by default. */
  toleranceSeconds?: number;
};

/**
 * A timestamped delivery's verdict: verified, with its timestamp, or the code
 * a handler answers 401 with — a timestamp missing or not Unix seconds, a
 * signature that does not match, or a signed one outside the tolerance.
 */
export type TimestampVerdict = { ok: true; timestamp: number } | { ok: false; code: "NO_TIMESTAMP" | "BAD_SIGNATURE" | "STALE_DELIVERY" };

/**
 * Whether a delivery is signed by the secret's holder within the tolerance of
 * now (`now` in milliseconds, the clock's by default). The signature is
 * checked before the time, so only a delivery the secret's holder signed is
 * told it is stale — a clock-skew fault its operator can read.
 */
export function verifyTimestamped(request: HookRequest, secret: string, scheme: TimestampedScheme, now = Date.now()): TimestampVerdict {
  const tolerance = scheme.toleranceSeconds ?? 300;
  if (!Number.isFinite(tolerance) || tolerance <= 0) throw new Error(`verifyTimestamped: toleranceSeconds ${tolerance} is not a positive number of seconds`);
  const stamp = request.headers[scheme.timestampHeader.toLowerCase()] ?? "";
  if (!/^\d{1,12}$/.test(stamp)) return { ok: false, code: "NO_TIMESTAMP" };
  const sent = request.headers[scheme.signatureHeader.toLowerCase()] ?? "";
  const signaturePrefix = scheme.signaturePrefix ?? "";
  if (!sent.startsWith(signaturePrefix)) return { ok: false, code: "BAD_SIGNATURE" };
  const expected = createHmac("sha256", secret)
    .update(`${scheme.prefix ?? ""}${stamp}${scheme.separator ?? "."}`)
    .update(request.body)
    .digest("hex");
  if (!safeEqual(sent.slice(signaturePrefix.length).toLowerCase(), expected)) return { ok: false, code: "BAD_SIGNATURE" };
  const timestamp = Number(stamp);
  if (Math.abs(now / 1000 - timestamp) > tolerance) return { ok: false, code: "STALE_DELIVERY" };
  return { ok: true, timestamp };
}

/** Whether a delivery's id is one onceById takes: 1 to 200 printable ASCII characters — a lone surrogate would reach Postgres as U+FFFD, and two such ids would be one. */
export function isDeliveryId(id: unknown): id is string {
  return typeof id === "string" && /^[\x21-\x7e]{1,200}$/.test(id);
}

/**
 * How long onceById remembers (SMD-2768), in seconds. `keepSeconds`: an id,
 * from its claim — for a sender that signs its time, twice verifyTimestamped's
 * tolerance and a minute's margin, past which the same bytes resent are
 * stale. `leaseSeconds`: a claim whose run never finished (the server stopped
 * mid-run), before a retry may take it — by default one capture's model calls
 * under the core's settings (ctx.captureSeconds) and a minute; a run that
 * outlives it may run twice.
 */
export type OnceOptions = { keepSeconds: number; leaseSeconds?: number };

/** What a run hands back: the value to answer with, and the thought to remember the id by — null gives the claim back, so the sender's retry runs. */
export type OnceRun<T> = { value: T; thoughtId: string | null };

/** onceById's answer: the run's value; the thought a delivery of the id already captured; or that one is still running. */
export type Once<T> = { ran: T } | { duplicate: string } | { inFlight: true };

/**
 * Runs `run` once per delivery id (SMD-2768), over the plugin's own table
 * `deliveries`, which its migration makes as plugins/example/migrations/
 * 002_deliveries.sql does. One table per plugin: a plugin with two hooks that
 * remember ids prefixes each hook's.
 *
 * The id is claimed in a transaction of its own, never held across the run's
 * model calls, which would hold one of the plugin's two connections for as
 * long; ids past the window are pruned first. A resend waits for the first
 * claim to commit, then finds it: captured (`duplicate`), or still running
 * (`inFlight`, a retryable 409 to its sender). A run that throws, or hands
 * back no thought, gives its own claim back — matched on `claimed_at`, read as
 * text since a Date would round its microseconds away, so never one a retry
 * took past the lease — and the sender's retry runs. A thought is recorded by
 * upsert, so a run that outlived the prune is still recorded; a record that
 * fails leaves the claim to lapse, and the run's value is answered all the same.
 */
export async function onceById<T>(ctx: Pick<HookContext, "db" | "captureSeconds">, id: string, run: () => Promise<OnceRun<T>>, options: OnceOptions): Promise<Once<T>> {
  if (!isDeliveryId(id)) throw new Error("onceById: an id is 1 to 200 printable ASCII characters (isDeliveryId)");
  const keep = options.keepSeconds;
  const lease = options.leaseSeconds ?? Math.ceil(ctx.captureSeconds) + 60;
  for (const [name, seconds] of [["keepSeconds", keep], ["leaseSeconds", lease]] as const) {
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`onceById: ${name} ${seconds} is not a positive number of seconds`);
  }
  const claim = await ctx.db.tx(async (sql) => {
    // A claim still inside its lease outlives the window: pruned, its id would run again beside it.
    await sql`DELETE FROM deliveries WHERE claimed_at < now() - ${keep} * interval '1 second'
               AND (thought_id IS NOT NULL OR claimed_at < now() - ${lease} * interval '1 second')`;
    const [mine] = await sql<{ claimed: string }>`
      INSERT INTO deliveries (id) VALUES (${id})
      ON CONFLICT (id) DO UPDATE SET claimed_at = now()
       WHERE deliveries.thought_id IS NULL AND deliveries.claimed_at < now() - ${lease} * interval '1 second'
      RETURNING claimed_at::text AS claimed`;
    if (mine) return { claimed: true as const, at: mine.claimed };
    const [held] = await sql<{ thought_id: string | null }>`SELECT thought_id FROM deliveries WHERE id = ${id}`;
    return { claimed: false as const, thoughtId: held?.thought_id ?? null };
  });
  if (!claim.claimed) return claim.thoughtId ? { duplicate: claim.thoughtId } : { inFlight: true };
  const claimedAt = claim.at;
  // One that cannot be given back lapses with the lease.
  const release = () =>
    ctx.db.tx((sql) => sql`DELETE FROM deliveries WHERE id = ${id} AND thought_id IS NULL AND claimed_at = ${claimedAt}::timestamptz`).catch(() => undefined);
  let done: OnceRun<T>;
  try {
    done = await run();
  } catch (err) {
    await release();
    throw err;
  }
  const thoughtId = done.thoughtId;
  if (thoughtId === null) {
    await release();
    return { ran: done.value };
  }
  await ctx.db
    .tx((sql) => sql`INSERT INTO deliveries (id, thought_id) VALUES (${id}, ${thoughtId}) ON CONFLICT (id) DO UPDATE SET thought_id = excluded.thought_id`)
    .catch(() => undefined);
  return { ran: done.value };
}

/** A GUI page: its path under the plugin's (lower-case words and hyphens), and its nav label. */
export type GuiPage = { path: string; label: string };

/** One operation, its handler's input and answer typed from its own schemas. */
export function operation<I extends Shape, O extends Shape>(op: PluginOperation<I, O>): PluginOperation {
  return op as unknown as PluginOperation;
}

/** A plugin's manifest — what `plugins/<name>/index.ts` exports as its default. */
export function definePlugin(manifest: PluginManifest): PluginManifest {
  return manifest;
}

export const ok = <T>(value: T): PluginOutcome<T> => ({ ok: true, value });
export const refuse = (status: PluginRefusal["status"], code: string, facts: { message?: string } & Record<string, unknown> = {}): PluginOutcome<never> => ({ ok: false, refusal: { ...facts, status, code } });
