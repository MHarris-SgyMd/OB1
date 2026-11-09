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
import type { ModelAnswer, ModelRefusal, ModelRequest } from "./core/model.ts";
import type { SPECS } from "./core/schemas.ts";
import { UUID_RE, type PluginSql } from "./store.ts";
import { ITEM_STATUSES, type ItemStatus } from "./open-items.ts";
import { dueInstant, levelOf, reasonOf, type PriorityScale } from "./priority-scale.ts";
import { withCallWaits, type CallWaits } from "./model-call.ts";

export { z };
export type { PluginSql, PriorityScale, ModelAnswer, ModelRefusal, ModelRequest };

/** The scope an operation needs, as a core tool's group: read, capture, or write (a forwarder's key is no caller). */
export type PluginScope = Exclude<Scope, "forward">;

/** An input or an output: a zod object's shape, each field its own schema — the form core/schemas.ts gives a tool's input. */
export type Shape = Record<string, z.ZodType>;

/**
 * A refusal a plugin answers: its status, its own code, and facts beside it —
 * JSON a caller can act on. 400, 403, 404, 409 and 422 say this input will not
 * do and are never retryable. 503 is the one retryable refusal (SMD-1992): a
 * service the plugin needs did not answer — the core's embedding provider, a
 * search's `vectorFailed` — so the same call may succeed later. (A capture with
 * no vector is no reason: the thought is saved, and the vector mender fills it.)
 */
export type PluginRefusal = { status: 400 | 403 | 404 | 409 | 422 | 503; code: string; message?: string } & Record<string, unknown>;

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
  /**
   * A model call (SMD-2690 PR 3a): `model.chat({ system?, user, json?,
   * temperature?, max_tokens? })` asks the brain's classifier model
   * (OB1_METADATA_MODEL) through the brain's own provider path, never a
   * provider of the plugin's. The egress gate judges it as the caller's key
   * (`actor`) for this plugin (`plugin`) before anything is sent: under deny
   * only a `plugin:` allow term lets it out; under allow a deny term on the
   * key, the plugin or a marker holds it (a marker read in the system prompt
   * too; a row's `source:`, `type:` or `topic:` never does), so the
   * brain's text and the caller's go in `user`, never `system`. The
   * model-call seam holds and measures it, and OB1_LLM_TIMEOUT bounds it. Its
   * answer is the model's text (and the object parsed from it, with `json`),
   * or a refusal: REFUSED_INPUT, REFUSED_EGRESS, PROVIDER_UNAVAILABLE (the
   * one retryable: answer it 503 PROVIDER_UNAVAILABLE), PROVIDER_REFUSED,
   * NOT_JSON. The text is the model's: treat it as untrusted input.
   */
  readonly model: { chat(req: ModelRequest): Promise<ModelAnswer> };
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

/** What a webhook's handler runs against: the core as the hook's own capture-only caller, the plugin's tables, its secret, how long a capture may run, and a way to answer before work ends. */
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
   * on, or the genre tier's deadline (OB1_JEV_BASE_URL) if longer — which a
   * plugin cannot read itself. onceById sizes its lease from it.
   */
  readonly captureSeconds: number;
  /**
   * Runs `work` once the handler's answer is on its way (SMD-2767), for a
   * sender that wants one sooner than the work takes (Slack: three seconds):
   * it starts on the event loop's next turn after the handler returns an
   * answer the runtime takes, and not at all if the handler throws or answers
   * what is refused — `discarded` runs then instead, before the 500 is sent
   * (waited on for 5 s at most),
   * to undo what the handler did for the work (onceById gives its claim
   * back). Work runs on any answer taken, a retryable 409 or 503 included, so
   * work its sender's retry must not repeat goes through onceById. The
   * runtime owns both:
   * a failure is caught and written to the REST core's fault log as one line,
   * never a rejection that would stop the process, and the server's stop
   * waits for them as for a request, within OB1_STOP_GRACE — counted from
   * when each is deferred, so one from a timer the handler left is waited for
   * only if it is deferred before the stop finds nothing running. Its sender has its 2xx by then and resends
   * nothing: work that fails is told only to the fault log, and work a crash
   * or the stop's cut ends only to the stop's count of what it cut, if to
   * anything.
   */
  defer(work: () => Promise<unknown>, discarded?: () => Promise<unknown>): void;
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

/**
 * Whether a delivery's id is one onceById takes: a string of 1 to 200 ASCII
 * characters from `!` to `~` — no space or control character; a lone surrogate
 * would reach Postgres as U+FFFD, and two such ids would be one — less its
 * scope and a space when it has one. A sender's numeric id (Telegram's
 * `update_id`) is passed as `String(id)`. Asked of the sender's own id, so an
 * empty or missing one is refused rather than made one id by its scope.
 */
export function isDeliveryId(id: unknown, scope?: string): id is string {
  return typeof id === "string" && /^[\x21-\x7e]+$/.test(id) && id.length <= 200 - (scope === undefined ? 0 : scope.length + 1);
}

/** The longest window or lease onceById binds, in seconds (about 31 years): past about 2 × 10^11, Postgres's timestamps overflow and every claim would fail. */
const ONCE_MAX_SECONDS = 1e9;

/**
 * How long onceById remembers (SMD-2768), in seconds. `keepSeconds`: an id,
 * from its claim — for a sender that signs its time, twice verifyTimestamped's
 * tolerance and a minute's margin, past which the same bytes resent are
 * stale; for one that signs none, as long as it may resend, `Infinity` for
 * good (nothing is pruned). `leaseSeconds`: a claim whose run never finished
 * (the server stopped mid-run), before a retry may take it — by default one
 * capture's model calls under the core's settings (ctx.captureSeconds) and a
 * minute; a run that outlives it may run twice. An unfinished claim is kept
 * past the window while its lease runs.
 */
export type OnceOptions = {
  keepSeconds: number;
  leaseSeconds?: number;
  /**
   * Whose ids these are, when a plugin has more than one hook that remembers
   * them: lower-case words and hyphens, at most 32 characters — the hook's
   * name, say. A claim prunes only its own scope's ids, so each hook keeps
   * its own window and lease in the one table, and two hooks' ids never meet.
   * Chosen before the hook first runs: the scope is part of the key, so adding
   * or changing one forgets the ids kept without it, and no claim prunes them.
   */
  scope?: string;
  /**
   * Claim now and leave the run, its record and its release to `ctx.defer`
   * (SMD-2767), so the sender is answered within its deadline: onceById's
   * answer is then `OnceDeferred`.
   */
  defer?: boolean;
};

/** What a run hands back: the value to answer with, and the thought to remember the id by — the core's thought id, a uuid; null gives the claim back, so the sender's retry runs. */
export type OnceRun<T> = { value: T; thoughtId: string | null };

/** onceById's answer: the run's value; the thought a delivery of the id already captured; or that one is still running. */
export type Once<T> = { ran: T } | { duplicate: string } | { inFlight: true };

/** onceById's answer with `defer`: the id claimed and its run left to `ctx.defer`, or, as without, a duplicate or one still running. */
export type OnceDeferred = { deferred: true } | { duplicate: string } | { inFlight: true };

/**
 * Runs `run` once per delivery id (SMD-2768), over the plugin's own table
 * `deliveries`, which its migration makes as plugins/example/migrations/
 * 002_deliveries.sql does: one table per plugin, a hook's ids kept under its
 * `scope` (`<scope> <id>`, the space no id holds) when it has one. A plugin
 * with a scope kept for good beside one that prunes adds the index the prune
 * reads, or each claim scans every kept row:
 * `CREATE INDEX IF NOT EXISTS deliveries_by_scope ON deliveries ((CASE WHEN strpos(id, ' ') = 0 THEN '' ELSE split_part(id, ' ', 1) END), claimed_at)`.
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
 * A `thoughtId` that is no uuid is the plugin's fault: thrown, the claim kept
 * to lapse, so a resend is told to retry (409) until the lease rather than run.
 * While one of the run's model calls waits for a slot of its background share,
 * the claim is renewed (SMD-3379 PR 2b-2b), so a resend is told to retry
 * however long the wait, and the call then runs within a whole lease.
 *
 * With `defer` (SMD-2767), the claim is made and answered now — `deferred`, a
 * duplicate or one still running — and the run, its record and its release
 * are left to `ctx.defer`: the sender is answered within its deadline, and a
 * resend while the run goes on is still told to retry. A deferred run that
 * throws, hands back no thought (a refusal of the core's, say) or a
 * `thoughtId` that is no uuid reaches the fault log, its message naming the
 * delivery and what became of its claim (`delivery <scope> <id> (its id given
 * back): …`), and not the sender, who has its answer; a run that throws with
 * the refusal's code says more than one that hands back nothing.
 */
export function onceById<T>(ctx: Pick<HookContext, "db" | "captureSeconds" | "defer">, id: string, run: () => Promise<OnceRun<T>>, options: OnceOptions & { defer: true }): Promise<OnceDeferred>;
export function onceById<T>(ctx: Pick<HookContext, "db" | "captureSeconds">, id: string, run: () => Promise<OnceRun<T>>, options: OnceOptions & { defer?: false }): Promise<Once<T>>;
export function onceById<T>(ctx: Pick<HookContext, "db" | "captureSeconds" | "defer">, id: string, run: () => Promise<OnceRun<T>>, options: OnceOptions): Promise<Once<T> | OnceDeferred>;
export async function onceById<T>(ctx: Pick<HookContext, "db" | "captureSeconds"> & Partial<Pick<HookContext, "defer">>, id: string, run: () => Promise<OnceRun<T>>, options: OnceOptions): Promise<Once<T> | OnceDeferred> {
  if (options.defer && typeof ctx.defer !== "function") throw new Error("onceById: defer needs the hook's ctx.defer");
  const scope = options.scope;
  if (scope !== undefined && !(typeof scope === "string" && scope.length <= 32 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scope))) throw new Error(`onceById: scope ${JSON.stringify(scope)} is not lower-case words and hyphens of at most 32 characters`);
  if (!isDeliveryId(id, scope)) throw new Error("onceById: an id is 1 to 200 characters from ! to ~, less its scope and a space (isDeliveryId)");
  const keep = options.keepSeconds;
  const lease = options.leaseSeconds ?? Math.ceil(ctx.captureSeconds) + 60;
  if (!(typeof keep === "number" && keep > 0 && (keep <= ONCE_MAX_SECONDS || keep === Infinity))) throw new Error(`onceById: keepSeconds ${keep} is not a number of seconds above 0 and at most ${ONCE_MAX_SECONDS}, or Infinity`);
  if (!(typeof lease === "number" && lease > 0 && lease <= ONCE_MAX_SECONDS)) throw new Error(`onceById: leaseSeconds ${lease} is not a number of seconds above 0 and at most ${ONCE_MAX_SECONDS}`);
  const key = scope === undefined ? id : `${scope} ${id}`;
  const claim = await ctx.db.tx(async (sql) => {
    // A claim still inside its lease outlives the window: pruned, its id would
    // run again beside it. Its own scope's ids alone ('' unscoped), each hook
    // pruning by its own window.
    if (keep !== Infinity) {
      await sql`DELETE FROM deliveries WHERE claimed_at < now() - ${keep} * interval '1 second'
                 AND (thought_id IS NOT NULL OR claimed_at < now() - ${lease} * interval '1 second')
                 AND (CASE WHEN strpos(id, ' ') = 0 THEN '' ELSE split_part(id, ' ', 1) END) = ${scope ?? ""}`;
    }
    const [mine] = await sql<{ claimed: string }>`
      INSERT INTO deliveries (id) VALUES (${key})
      ON CONFLICT (id) DO UPDATE SET claimed_at = now()
       WHERE deliveries.thought_id IS NULL AND deliveries.claimed_at < now() - ${lease} * interval '1 second'
      RETURNING claimed_at::text AS claimed`;
    if (mine) return { claimed: true as const, at: mine.claimed };
    const [held] = await sql<{ thought_id: string | null }>`SELECT thought_id FROM deliveries WHERE id = ${key}`;
    return { claimed: false as const, thoughtId: held?.thought_id ?? null };
  });
  if (!claim.claimed) return claim.thoughtId ? { duplicate: claim.thoughtId } : { inFlight: true };
  let claimedAt = claim.at;
  // The lease renewed while a run's model call waits for a slot of its background share (SMD-3379 PR 2b-2b, the
  // maintainer, 2026-11-08): a deferred run is background, and under the defaults may wait behind the sleep passes'
  // long calls, past a lease sized to a capture's own calls, for the sender's retry to run it again. As a wait begins
  // — a call before it may have run most of the lease (review pass 1) — then every third of the lease while any call
  // waits, and once as the last wait ends, so its call has a whole lease to run in. Matched on claimed_at, as the
  // release is, which waits for a renewal in flight: never another's claim. A tick while one is in flight is skipped,
  // the period held to a timer's most (a lease of years would fire every millisecond), and once the run is done the
  // observer does nothing, so a call it left waiting cannot renew a claim the release is giving back.
  let renewing: Promise<void> = Promise.resolve();
  let inFlight = false;
  let done = false;
  const renew = () => {
    if (inFlight || done) return;
    inFlight = true;
    // The catch and the reset on the chain itself, so a transaction that throws before it returns its promise neither
    // leaves `inFlight` set nor the chain the release waits on rejected (review pass 2).
    renewing = renewing
      .then(() => ctx.db.tx((sql) => sql<{ claimed: string }>`UPDATE deliveries SET claimed_at = now() WHERE id = ${key} AND thought_id IS NULL AND claimed_at = ${claimedAt}::timestamptz RETURNING claimed_at::text AS claimed`))
      .then((rows) => { if (rows[0]) claimedAt = rows[0].claimed; })
      .catch(() => undefined)
      .finally(() => { inFlight = false; });
  };
  let waits = 0;
  let renewal: ReturnType<typeof setInterval> | undefined;
  const stopRenewing = () => {
    done = true;
    clearInterval(renewal);
  };
  const leaseKept: CallWaits = {
    waiting: () => {
      if (done || waits++ > 0) return;
      renew();
      renewal = setInterval(renew, Math.min(Math.max(1, lease / 3) * 1000, 2_147_483_647));
    },
    running: () => {
      if (done || waits === 0 || --waits > 0) return;
      clearInterval(renewal);
      renew();
    },
  };
  // What became of its own claim: given back; already no longer its own (a
  // retry took it past the lease, or the prune); or, the DELETE failing, left
  // to lapse at the lease (review pass 4: a DELETE that matched nothing was told as given back).
  type Fate = "given back" | "already re-claimed or pruned" | "left to lapse at the lease";
  const release = (): Promise<Fate> =>
    renewing.then(() => ctx.db
      .tx((sql) => sql`DELETE FROM deliveries WHERE id = ${key} AND thought_id IS NULL AND claimed_at = ${claimedAt}::timestamptz RETURNING id`))
      .then((rows): Fate => (rows.length ? "given back" : "already re-claimed or pruned"), (): Fate => "left to lapse at the lease");
  // What became of the claim when no thought was recorded; null, kept to lapse (a thoughtId that is no uuid).
  let gaveBack: Fate | null = null;
  // The run's value, and whether it captured a thought.
  const finish = async (): Promise<{ value: T; captured: boolean }> => {
    let finished: OnceRun<T>;
    try {
      finished = await withCallWaits(leaseKept, run);
    } catch (err) {
      stopRenewing();
      gaveBack = await release();
      throw err;
    }
    stopRenewing();
    const thoughtId = finished.thoughtId;
    if (thoughtId === null) {
      gaveBack = await release();
      return { value: finished.value, captured: false };
    }
    // Anything else would fail the record unseen. Not given back: a resend is
    // 409 until the lease, where a release would run it again on every one.
    if (!UUID_RE.test(thoughtId)) {
      throw new Error("onceById: a run's thoughtId is the core's thought id, a uuid, or null");
    }
    await ctx.db
      .tx((sql) => sql`INSERT INTO deliveries (id, thought_id) VALUES (${key}, ${thoughtId}) ON CONFLICT (id) DO UPDATE SET thought_id = excluded.thought_id`)
      .catch(() => undefined);
    return { value: finished.value, captured: true };
  };
  if (options.defer) {
    // Its sender has its answer: a run that captured nothing is a fault to
    // tell, not a claim given back for a retry that will not come. Each
    // fault names the delivery — short, so a long id leaves the fault line's
    // 300 characters to the fault (review pass 2) — and what became of its
    // claim, before the fault's own words (review pass 3).
    const named = () => `delivery ${key.length > 64 ? `${key.slice(0, 61)}...` : key} (its id ${gaveBack ?? "kept to lapse at the lease"})`;
    ctx.defer!(
      () =>
        finish().then(
          ({ captured }) => {
            if (!captured) throw new Error(`${named()}: no thought captured`);
          },
          (err: unknown) => {
            throw new Error(`${named()}: ${err instanceof Error ? err.message : String(err)}`);
          },
        ),
      // The handler failed after the claim: its sender is told 500 and retries, so the id is given back now, not at the lease.
      async () => {
        gaveBack = await release();
        if (gaveBack === "left to lapse at the lease") throw new Error(`${named()}: its handler failed after the claim, and the claim could not be given back`);
      },
    );
    return { deferred: true };
  }
  return { ran: (await finish()).value };
}

/**
 * A plugin's row as the open item it stands for (SMD-3665 PR 3b): `row` its key (the row's id, plugin_row), `text`
 * what is to be done, `due` the day it is due (YYYY-MM-DD, due by the end of that day: SMD-3778) or null, `owner` who is to
 * do it (left as it is when undefined), and `done` when the row is finished — its item is then settled done with
 * that reason, and its due time left as it was. `reopenDone` for a row that comes round again (a recurring task): an
 * item a key settled done is reopened with that reason, since the row falls due anew (review pass 1, the
 * maintainer's word of 2026-11-05).
 */
export type RowItem = { row: string; text: string; due: string | null; owner?: string | null; done?: { reason: string }; reopenDone?: { reason: string } };

/** What keepRowItem did, and the item as it left it; or `failed`, the core's refusal code (`fault` for a throw), no item. */
export type RowItemKept =
  | { did: "opened" | "updated" | "settled" | "reopened" | "unchanged"; item: { id: string; status: ItemStatus } }
  | { did: "failed"; code: string; item: null };

/** An operation's answer of the item its row stands for: its id and status, or null when the brain did not keep it. */
export const RowItemAnswer = z.object({ id: z.string(), status: z.enum(ITEM_STATUSES) }).nullable();

/** A text as 117 keeps an item's, compared alike: white space collapsed and trimmed (115's cleaning, near enough to tell a change). */
const asItemText = (s: string) => s.replace(/\s+/gu, " ").trim();

/**
 * Keeps the open item a plugin's row stands for (SMD-3665 PR 3b), through the core as the caller: open_item with
 * the row (the plugin named by ctx.call's envelope, so a write key changes it through the plugin alone), `proposed`
 * — the maintainer's word of 2026-11-05: a row's item is confirmed by a write key, as the extractor's are. The same
 * row again is the item already there; its text, due day and owner are moved to the row's (update_item), and a row
 * `done` settles it (set_item_status). A settled item is left as it is — a dropped one stays dropped, unedited —
 * except a done one whose row comes round again (`reopenDone`), which is reopened and moved to the row's due day.
 *
 * Called after the plugin's own transaction commits, so it never fails the plugin's write: a refusal or a fault is
 * answered `failed`, and the row's next keep (the plugin's sync operation) repairs it.
 */
export async function keepRowItem(ctx: Pick<PluginContext, "call">, want: RowItem): Promise<RowItemKept> {
  try {
    const opened = await ctx.call("open_item", {
      text: want.text, plugin_row: want.row, proposed: true,
      ...(want.due === null ? {} : { due_at: want.due }), ...(want.owner ? { owner: want.owner } : {}),
    });
    if (!opened.ok) return { did: "failed", code: opened.refusal.code, item: null };
    // An unchanged item is shown to a capture-only key only if it is its own; a row's writer is a write key.
    if (!opened.value.item) return { did: "failed", code: "ITEM_NOT_SHOWN", item: null };
    let item = opened.value.item;
    // A key's settling is not undone, nor its item edited after — a dropped item stays as it was dropped — but a row
    // that comes round again reopens an item settled done: the row is due anew.
    if (item.status === "dropped" || (item.status === "done" && !want.reopenDone)) return { did: "unchanged", item: { id: item.id, status: item.status } };
    let did: "opened" | "updated" | "settled" | "reopened" | "unchanged" = opened.value.outcome === "opened" ? "opened" : "unchanged";
    if (item.status === "done" && want.reopenDone) {
      const reopened = await ctx.call("set_item_status", { id: item.id, status: "open", reason: want.reopenDone.reason });
      if (!reopened.ok) return { did: "failed", code: reopened.refusal.code, item: null };
      item = reopened.value.item;
      did = "reopened";
    }
    if (opened.value.outcome === "unchanged") {
      // The row's day as 117 reads it (dueInstant: the end of that day, SMD-3778).
      const wantDue = dueInstant(want.due);
      const sameDue = item.dueAt === null ? wantDue === null : wantDue !== null && Date.parse(item.dueAt) === Date.parse(wantDue);
      const changes = {
        ...(asItemText(item.text) === asItemText(want.text) ? {} : { text: want.text }),
        ...(want.done || sameDue ? {} : { due_at: want.due }),
        ...(want.owner === undefined || (item.owner ?? null) === (want.owner ?? null) ? {} : { owner: want.owner }),
      };
      if (Object.keys(changes).length > 0) {
        const updated = await ctx.call("update_item", { id: item.id, ...changes });
        if (!updated.ok) return { did: "failed", code: updated.refusal.code, item: null };
        item = updated.value.item;
        if (updated.value.outcome === "updated" && did === "unchanged") did = "updated";
      }
    }
    if (want.done && (item.status === "proposed" || item.status === "open")) {
      const settled = await ctx.call("set_item_status", { id: item.id, status: "done", reason: want.done.reason });
      if (!settled.ok) return { did: "failed", code: settled.refusal.code, item: null };
      item = settled.value.item;
      did = "settled";
    }
    return { did, item: { id: item.id, status: item.status } };
  } catch (err) {
    console.error(`keepRowItem: the item of row ${want.row} was not kept: ${err instanceof Error ? err.message : String(err)}`);
    return { did: "failed", code: "fault", item: null };
  }
}

/** What a row says of how much it matters (SMD-3666): its own word on its source's scale, and whether it was chosen — a source's default, not chosen, is unknown. */
export type RowPriority = { scale: PriorityScale; value: string | null; chosen?: boolean };

/** What keepItemPriority did: 116's outcome, or `failed` with the core's refusal code (`fault` for a throw). */
export type ItemPriorityKept = { did: "asserted" | "unchanged" | "cleared" | "nothing_to_clear" } | { did: "failed"; code: string };

/**
 * States a row's own priority on the open item it stands for (SMD-3666 PR 3), through the core as the caller:
 * set_priority on `{kind: item, key}` with the row's word mapped onto the brain's scale (server-portable/
 * priority-scale.ts, docs/priority.md's table) and that word as the reason, or clear_priority when the word reads as
 * unknown (none, a word the scale does not hold, the source's default not chosen). The tier is the caller's key's
 * (docs/priority.md, "A plugin"); the same again is `unchanged`, nothing written. The due time is the item's own
 * (recurrence belongs to the item, not the statement), so none is stated. Called after the row's item is kept, and,
 * as keepRowItem does, it never fails the plugin's write: a refusal or a fault is answered `failed`.
 */
export async function keepItemPriority(ctx: Pick<PluginContext, "call">, itemId: string, said: RowPriority): Promise<ItemPriorityKept> {
  try {
    const level = levelOf(said.scale, said.value, { chosen: said.chosen });
    const r = level === null
      ? await ctx.call("clear_priority", { kind: "item", key: itemId })
      : await ctx.call("set_priority", { kind: "item", key: itemId, level, reason: reasonOf(said.scale, said.value!) });
    if (!r.ok) return { did: "failed", code: r.refusal.code };
    return { did: r.value.outcome };
  } catch (err) {
    console.error(`keepItemPriority: the priority of item ${itemId} was not kept: ${err instanceof Error ? err.message : String(err)}`);
    return { did: "failed", code: "fault" };
  }
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
