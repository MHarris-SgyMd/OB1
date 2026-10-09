// The plugin host (SMD-2310): which plugins this brain runs, and each
// operation as both servers serve it. The operator names them in OB1_PLUGINS;
// every plugin in the tree is imported by name (../plugins/registry.ts — no
// import() by a name the environment gives), its manifest checked whether or
// not it is enabled, and only an enabled plugin's operations reach the REST
// core's routes, the MCP server's tools/list, the OpenAPI document and whoami.
// A plugin reaches the brain's thoughts through ctx.call alone: a core
// operation, behind the caller's own scope, with its own schema.

import { z } from "zod";
import { PLUGIN_NAME_RE } from "../../db/config.mjs";
import { PLUGINS } from "../../plugins/registry.ts";
import type { Principal } from "../auth.ts";
import { mayCall, scopeOf, TOOL_NAMES, type ToolName } from "../tools.ts";
import type { GuiPage, HookAnswer, HookRequest, Method, PluginContext, PluginHook, PluginManifest, PluginOperation, PluginOutcome, PluginScope, Shape } from "../plugin-sdk.ts";
import { CALLS, pathFields, type CallOptions } from "./calls.ts";
import { failure } from "./refusal.ts";
import { SPECS } from "./schemas.ts";
import type { createCore } from "./index.ts";

type Core = ReturnType<typeof createCore>;

/** A plugin's name: lower-case words joined by single hyphens, at most 32 characters. */
const PLUGIN_NAME = PLUGIN_NAME_RE;
/** An operation's key: lower-case words joined by single underscores. */
const OPERATION_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
/** An operation's path under its plugin's: `/` and segments, each lower-case words and hyphens or one `{field}`. */
const OPERATION_PATH = /^(?:\/(?:[a-z0-9]+(?:-[a-z0-9]+)*|\{[a-z_]+\}))+$/;
/** A webhook's name: one path segment of lower-case words and hyphens. */
const HOOK_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The statuses a webhook may answer its sender with. */
const HOOK_STATUSES = new Set([200, 202, 204, 400, 401, 403, 404, 409, 413, 422, 503]);
/** A GUI page's path under the plugin's: `/` and segments of lower-case words and hyphens. */
const GUI_PATH = /^(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
/** A refusal's code: upper-case words joined by underscores, as the core's are. */
const REFUSAL_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const SCOPES: readonly PluginScope[] = ["read", "capture", "write"];
const METHODS: readonly Method[] = ["GET", "POST", "PATCH", "DELETE"];
const REFUSAL_STATUSES = new Set([400, 403, 404, 409, 422]);

/** An enabled plugin's operation, as both servers serve it. */
export type LoadedOp = {
  plugin: string;
  /** The operation's key in its manifest. */
  key: string;
  /** Its MCP tool name and OpenAPI operationId: `<plugin>_<key>`, the plugin's hyphens read as `_`. */
  tool: string;
  scope: PluginScope;
  method: Method;
  /** Its REST path: `/v1/plugins/<plugin>` and the operation's own. */
  path: string;
  title: string;
  description: string;
  annotations: NonNullable<PluginOperation["annotations"]>;
  /** The input's shape, for reading a query string's fields by type. */
  shape: Shape;
  input: z.ZodObject<Shape>;
  output: z.ZodObject<Shape>;
  handler: PluginOperation["handler"];
};

export type LoadedPlugin = { name: string; title: string; description: string; operations: LoadedOp[]; pages: GuiPage[]; hooks: LoadedHook[] };

/** An enabled plugin's webhook, as the REST core serves it. */
export type LoadedHook = { plugin: string; name: string; path: string; description: string; handler: PluginHook["handler"] };

/** An operation's tool name: `<plugin>_<key>`, the plugin's hyphens read as `_` so the name is one word to a client. */
export const toolNameOf = (plugin: string, key: string): string => `${plugin.replace(/-/g, "_")}_${key}`;

/** The plugin names OB1_PLUGINS lists: comma-separated, each trimmed, blanks dropped. */
export function pluginNames(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((n) => n.trim()).filter(Boolean);
}

/** A field's JSON-schema type on one side of the parse, or null when it has none or cannot be stated. */
function jsonSchemaType(field: z.ZodType, io: "input" | "output"): string | null {
  try {
    return ((z.toJSONSchema(field, { io }) as { type?: unknown }).type as string) ?? null;
  } catch {
    return null;
  }
}

/**
 * What is wrong with a set of manifests, one sentence each — every manifest in
 * the tree, enabled or not, so a broken plugin fails the suites rather than
 * the brain that first turns it on. Pure.
 */
export function manifestProblems(manifests: readonly PluginManifest[]): string[] {
  const problems: string[] = [];
  const plugins = new Set<string>();
  // A tool name a plugin takes, and who took it first: the core's twenty, then each plugin's.
  const tools = new Map<string, string>(TOOL_NAMES.map((t) => [t, "the core"]));
  for (const m of manifests) {
    const at = `plugin ${JSON.stringify(m.name)}`;
    if (!PLUGIN_NAME.test(m.name) || m.name.length > 32) problems.push(`${at}: a name is lower-case words joined by single hyphens, at most 32 characters`);
    if (plugins.has(m.name)) problems.push(`${at}: two plugins share the name`);
    plugins.add(m.name);
    if (!m.title?.trim() || !m.description?.trim()) problems.push(`${at}: a title and a description are required`);
    const keys = Object.keys(m.operations ?? {});
    if (keys.length === 0) problems.push(`${at}: no operations`);
    // Each route taken so far, as its method and segments: two that one request could match are refused, not ordered.
    const routes: { key: string; method: string; segments: string[] }[] = [];
    for (const key of keys) {
      const op = m.operations[key];
      const where = `${at} operation ${JSON.stringify(key)}`;
      if (!OPERATION_KEY.test(key)) problems.push(`${where}: a key is lower-case words joined by single underscores`);
      const tool = toolNameOf(m.name, key);
      const holder = tools.get(tool);
      if (holder) problems.push(`${where}: its tool name ${tool} is ${holder}'s`);
      // The Claude API's tool names are at most 64 characters (^[a-zA-Z0-9_-]{1,64}$).
      if (tool.length > 64) problems.push(`${where}: its tool name ${tool} is over 64 characters`);
      else tools.set(tool, at);
      if (!SCOPES.includes(op.scope)) problems.push(`${where}: scope ${JSON.stringify(op.scope)} is not read, capture or write`);
      if (!METHODS.includes(op.method)) problems.push(`${where}: method ${JSON.stringify(op.method)} is not GET, POST, PATCH or DELETE`);
      if (!OPERATION_PATH.test(op.path ?? "")) problems.push(`${where}: path ${JSON.stringify(op.path)} is not segments of lower-case words and hyphens, or {field}`);
      // A {field} matches any segment, so `/items/{id}` and `/items/latest`
      // both match /items/latest: refused, rather than one hiding the other.
      const segments = (op.path ?? "").split("/").slice(1);
      const clash = routes.find((r) => r.method === op.method && r.segments.length === segments.length && r.segments.every((s, i) => s === segments[i] || s.startsWith("{") || segments[i].startsWith("{")));
      if (clash) problems.push(`${where}: its route ${op.method} ${op.path} matches a request operation ${JSON.stringify(clash.key)}'s does`);
      routes.push({ key, method: op.method, segments });
      if (!op.title?.trim() || !op.description?.trim()) problems.push(`${where}: a title and a description are required`);
      const fields = pathFields(op.path ?? "");
      for (const [i, f] of fields.entries()) {
        const field = (op.input ?? {})[f];
        if (fields.indexOf(f) !== i) problems.push(`${where}: its path names {${f}} twice`);
        else if (!field) problems.push(`${where}: its path's {${f}} is no input field`);
        // A path segment is text: a field of another type could never be reached over REST.
        else if (jsonSchemaType(field, "input") !== "string") problems.push(`${where}: its path's {${f}} is not a string field`);
        // A path segment is always there: a field that may be absent is one MCP could call without.
        else if (field.safeParse(undefined).success) problems.push(`${where}: its path's {${f}} is optional or defaulted, and a path field is always given`);
      }
      // The output is held to its schema once, here, and the MCP SDK holds the
      // held value to it again: a transform would answer REST and fail MCP.
      try {
        z.toJSONSchema(z.object(op.output ?? {}), { io: "output" });
      } catch {
        problems.push(`${where}: its output schema transforms or cannot be stated as JSON Schema`);
      }
      if (typeof op.handler !== "function") problems.push(`${where}: no handler`);
    }
    // Its webhooks: a name that is one path segment, a description, a handler.
    for (const [name, hook] of Object.entries(m.hooks ?? {})) {
      const where = `${at} hook ${JSON.stringify(name)}`;
      if (!HOOK_NAME.test(name)) problems.push(`${where}: a hook's name is lower-case words joined by single hyphens`);
      if (!hook || typeof hook !== "object") { problems.push(`${where}: a hook is { description, handler }`); continue; }
      if (!hook.description?.trim()) problems.push(`${where}: a description is required`);
      if (typeof hook.handler !== "function") problems.push(`${where}: no handler`);
    }
    // Its GUI pages: each a path of plain segments under the plugin's, once, with a label a nav entry can show.
    const pages = new Set<string>();
    for (const page of m.gui?.pages ?? []) {
      if (!page || typeof page !== "object") { problems.push(`${at}: a page is { path, label }`); continue; }
      const where = `${at} page ${JSON.stringify(page.path)}`;
      if (!GUI_PATH.test(page.path ?? "")) problems.push(`${where}: a page's path is segments of lower-case words and hyphens`);
      if (pages.has(page.path)) problems.push(`${where}: two pages share the path`);
      pages.add(page.path);
      if (!page.label?.trim() || page.label.length > 40 || /[\r\n]/.test(page.label)) problems.push(`${where}: a label is one line of at most 40 characters`);
    }
  }
  return problems;
}

/**
 * The plugins OB1_PLUGINS enables, in the tree's order, each operation ready
 * to serve. Throws, naming what is wrong, on a manifest the tree should not
 * hold or a name that is no plugin's — the server does not start on it, and
 * preflight says so first (pluginProblem).
 */
export function loadPlugins(raw: string | undefined, registry: readonly PluginManifest[] = PLUGINS): LoadedPlugin[] {
  const problems = manifestProblems(registry);
  if (problems.length) throw new Error(`a plugin manifest is malformed (plugins/): ${problems.join("; ")}`);
  const names = pluginNames(raw);
  const known = new Set(registry.map((m) => m.name));
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length) throw new Error(`OB1_PLUGINS names ${unknown.map((n) => JSON.stringify(n)).join(", ")}, which ${unknown.length === 1 ? "is no plugin" : "are no plugins"} in this build (known: ${[...known].join(", ") || "none"})`);
  const twice = names.filter((n, i) => names.indexOf(n) !== i);
  if (twice.length) throw new Error(`OB1_PLUGINS names ${JSON.stringify(twice[0])} twice`);
  return registry.filter((m) => names.includes(m.name)).map((m) => ({
    name: m.name,
    title: m.title,
    description: m.description,
    pages: (m.gui?.pages ?? []).map((p) => ({ path: p.path, label: p.label })),
    hooks: Object.entries(m.hooks ?? {}).map(([name, hook]) => ({ plugin: m.name, name, path: `/hooks/${m.name}/${name}`, description: hook.description, handler: hook.handler })),
    operations: Object.entries(m.operations).map(([key, op]) => ({
      plugin: m.name,
      key,
      tool: toolNameOf(m.name, key),
      scope: op.scope,
      method: op.method,
      path: `/v1/plugins/${m.name}${op.path}`,
      title: op.title,
      description: op.description,
      annotations: { ...(op.scope === "read" ? { readOnlyHint: true } : {}), ...op.annotations },
      shape: op.input,
      input: z.object(op.input),
      output: z.object(op.output),
      handler: op.handler,
    })),
  }));
}

/** What is wrong with OB1_PLUGINS, or null: loadPlugins' refusal as a sentence, for preflight. */
export function pluginProblem(raw: string | undefined, registry: readonly PluginManifest[] = PLUGINS): string | null {
  try {
    loadPlugins(raw, registry);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export type OpDeps = { core: Core; principal: Principal; track?: CallOptions["track"] };

/** The handler's context for one call of `plugin`'s operation: the caller, the core reached as the caller, and the plugin's own tables. */
export function contextFor(plugin: string, { core, principal, track }: OpDeps): PluginContext {
  return {
    // Read when the handler asks, so an operation that touches no table never reaches the store.
    db: { tx: (fn) => core.pluginTx(plugin, fn) },
    caller: { name: principal.name, scope: principal.scope as PluginScope, ...(principal.agentId ? { agentId: principal.agentId } : {}) },
    call: async <K extends ToolName>(name: K, input: unknown) => {
      // The type admits a tool name alone; a plugin that casts past it is told, not served.
      if (!TOOL_NAMES.includes(name)) throw new Error(`ctx.call: ${JSON.stringify(name)} is no core operation`);
      if (!mayCall(principal, name)) return { ok: false as const, refusal: { code: "FORBIDDEN" as const, retryable: false as const, needs: scopeOf(name) } };
      const parsed = z.object(SPECS[name].inputSchema).strict().safeParse(input);
      if (!parsed.success) return { ok: false as const, refusal: { code: "REFUSED_INPUT" as const, retryable: false as const, issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) } };
      return (CALLS[name] as (...args: unknown[]) => Promise<unknown>)(core, principal, parsed.data, { track }) as never;
    },
  };
}

/**
 * One call of an enabled operation, its input already held to its schema: the
 * handler's answer, a success held to the output schema the document promises
 * (a value that does not fit is the plugin's fault, thrown) and a refusal to a
 * status and a code a client can read.
 */
export async function runOperation(op: LoadedOp, deps: OpDeps, input: unknown): Promise<PluginOutcome<Record<string, unknown>>> {
  const out = await op.handler(contextFor(op.plugin, deps), input as never);
  if (!out.ok) {
    const { status, code } = out.refusal;
    if (!REFUSAL_STATUSES.has(status) || !REFUSAL_CODE.test(code)) throw new Error(`${op.tool} refused with status ${status} and code ${JSON.stringify(code)}: a refusal is 400, 403, 404, 409 or 422 with an UPPER_CASE code`);
    // Never retryable, on either transport: a refusal is the plugin's answer
    // to this input, and the statuses it may use all say so. Last, so a fact
    // of the plugin's own cannot say otherwise.
    return { ok: false, refusal: { ...out.refusal, retryable: false } };
  }
  const value = op.output.safeParse(out.value);
  const refused = (error: z.ZodError) => error.issues.map((i) => `${i.path.map(String).join(".") || "(value)"} ${i.message}`).join("; ");
  if (!value.success) throw new Error(`${op.tool} answered a value its output schema refuses: ${refused(value.error)}`);
  // The MCP SDK holds the held value to the schema again; one a step changed
  // past it (a pipe, a codec, a preprocess the load check cannot see) would
  // answer REST and fail MCP. Held twice here, both transports answer alike.
  const again = op.output.safeParse(value.data);
  if (!again.success) throw new Error(`${op.tool} answered a value its output schema changes into one it refuses: ${refused(again.error)}`);
  return { ok: true, value: value.data };
}

/**
 * The webhooks the REST core serves (SMD-2310): those of the plugins OB1_HOOKS
 * names, each also enabled in OB1_PLUGINS — a plugin's operations can be on
 * with its inbound endpoint off, never the other way. Throws, naming it, on a
 * name that is no enabled plugin or one with no hook, as loadPlugins does on
 * OB1_PLUGINS: the server does not start on it.
 */
export function enabledHooks(enabled: readonly LoadedPlugin[], raw: string | undefined): LoadedHook[] {
  const names = pluginNames(raw);
  const byName = new Map(enabled.map((p) => [p.name, p]));
  const bad = names.filter((n) => !byName.get(n)?.hooks.length);
  if (bad.length) throw new Error(`OB1_HOOKS names ${bad.map((n) => JSON.stringify(n)).join(", ")}, which ${bad.length === 1 ? "is" : "are"} no enabled plugin with a webhook (OB1_PLUGINS: ${enabled.map((p) => p.name).join(", ") || "none"})`);
  return enabled.filter((p) => names.includes(p.name)).flatMap((p) => p.hooks);
}

/**
 * The secrets OB1_HOOK_SECRETS gives the plugins' webhooks: `plugin=secret`
 * pairs separated by spaces, the first `=` the separator (a secret may hold
 * one). A pair with no `=`, an empty name or secret, or a name given twice is
 * refused, naming the pair's position and never its text.
 */
export function hookSecrets(raw: string | undefined): { secrets: Map<string, string>; problem: string | null } {
  const secrets = new Map<string, string>();
  const pairs = (raw ?? "").split(/\s+/).filter(Boolean);
  for (const [i, pair] of pairs.entries()) {
    const at = pair.indexOf("=");
    const name = at > 0 ? pair.slice(0, at) : "";
    const secret = at > 0 ? pair.slice(at + 1) : "";
    if (!name || !secret || !PLUGIN_NAME_RE.test(name)) return { secrets: new Map(), problem: `OB1_HOOK_SECRETS' entry ${i + 1} is not plugin=secret` };
    if (secrets.has(name)) return { secrets: new Map(), problem: `OB1_HOOK_SECRETS names ${JSON.stringify(name)} twice` };
    secrets.set(name, secret);
  }
  return { secrets, problem: null };
}

/** The caller a webhook runs as: `hook:<plugin>`, capture scope alone, no key behind it. */
export function hookPrincipal(plugin: string): Principal {
  return { name: `hook:${plugin}`, scope: "capture", keyHash: "" } as Principal;
}

/**
 * One delivery to an enabled webhook: the handler's answer, held to a status a
 * sender reads and a JSON object body. A handler that answers otherwise is
 * the plugin's fault, thrown. Work it defers (SMD-2767) starts once that
 * answer has been held and is on its way, on the event loop's next turn, under
 * `track` so the stop waits for it, its failure handed to `deferredFault` as
 * one bounded message; a handler that throws, or answers what is refused,
 * starts none of it, so its sender's retry of the 500 does not run it twice.
 */
export async function runHook(hook: LoadedHook, deps: { core: Core; secret: string; track?: CallOptions["track"]; deferredFault?: (message: string) => void }, request: HookRequest): Promise<HookAnswer> {
  const ctx = contextFor(hook.plugin, { core: deps.core, principal: hookPrincipal(hook.plugin), track: deps.track });
  // The core's settings as this delivery finds them, read only by a hook that asks.
  const core = deps.core;
  const deferredFault = deps.deferredFault ?? ((message: string) => console.error(`hook ${hook.path} deferred fault: ${message}`));
  const start = (work: () => Promise<unknown>) => {
    // The next turn, not a microtask: one queued now would run before the
    // answer is written, and work that spins before its first await would
    // hold the sender's 2xx (review pass 1, measured on Bun 1.4.0).
    const run = () =>
      new Promise<void>((resolve) => setImmediate(resolve))
        .then(work)
        .then(
          () => undefined,
          (err) => {
            // Never a rejection: one left unhandled stops the process, and with it every client.
            try {
              deferredFault(String(failure(err).message).replace(/\s+/g, " ").slice(0, 300));
            } catch {
              // A log that throws loses the line, not the server.
            }
          },
        );
    // Counted from now, so the stop finds no gap between the request and its work.
    void (deps.track ? deps.track(run) : run());
  };
  // Held until the answer is: a handler that fails defers nothing.
  let pending: (() => Promise<unknown>)[] | null = [];
  const defer = (work: () => Promise<unknown>) => {
    // A function, so the work starts under the tracker and a throw before its first await is caught too.
    if (typeof work !== "function") throw new Error(`${hook.path}: ctx.defer takes a function that starts the work`);
    if (pending) pending.push(work);
    else start(work);
  };
  const answer = await hook.handler({ call: ctx.call, db: ctx.db, secret: deps.secret, get captureSeconds() { return core.captureSeconds(); }, defer }, request);
  if (!answer || !HOOK_STATUSES.has(answer.status)) throw new Error(`${hook.path} answered status ${answer?.status}: a webhook answers 200, 202, 204, 400, 401, 403, 404, 409, 413, 422 or 503`);
  if (answer.body !== undefined && (answer.body === null || typeof answer.body !== "object" || Array.isArray(answer.body))) throw new Error(`${hook.path} answered a body that is not a JSON object`);
  const deferred = pending;
  pending = null;
  for (const work of deferred) start(work);
  return answer;
}
