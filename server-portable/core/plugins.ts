// The plugin host (SMD-2310): which plugins this brain runs, and each
// operation as both servers serve it. The operator names them in OB1_PLUGINS;
// every plugin in the tree is imported by name (../plugins/registry.ts — no
// import() by a name the environment gives), its manifest checked whether or
// not it is enabled, and only an enabled plugin's operations reach the REST
// core's routes, the MCP server's tools/list, the OpenAPI document and whoami.
// A plugin reaches the brain's thoughts through ctx.call alone: a core
// operation, behind the caller's own scope, with its own schema.

import { z } from "zod";
import { PLUGINS } from "../../plugins/registry.ts";
import type { Principal } from "../auth.ts";
import { mayCall, scopeOf, TOOL_NAMES, type ToolName } from "../tools.ts";
import type { Method, PluginContext, PluginManifest, PluginOperation, PluginOutcome, PluginScope, Shape } from "../plugin-sdk.ts";
import { CALLS, pathFields, type CallOptions } from "./calls.ts";
import { SPECS } from "./schemas.ts";
import type { createCore } from "./index.ts";

type Core = ReturnType<typeof createCore>;

/** A plugin's name: lower-case words joined by single hyphens, at most 32 characters. */
const PLUGIN_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** An operation's key: lower-case words joined by single underscores. */
const OPERATION_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
/** An operation's path under its plugin's: `/` and segments, each lower-case words and hyphens or one `{field}`. */
const OPERATION_PATH = /^(?:\/(?:[a-z0-9]+(?:-[a-z0-9]+)*|\{[a-z_]+\}))+$/;
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

export type LoadedPlugin = { name: string; title: string; description: string; operations: LoadedOp[] };

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
      for (const f of pathFields(op.path ?? "")) {
        const field = (op.input ?? {})[f];
        if (!field) problems.push(`${where}: its path's {${f}} is no input field`);
        // A path segment is text: a field of another type could never be reached over REST.
        else if (jsonSchemaType(field, "input") !== "string") problems.push(`${where}: its path's {${f}} is not a string field`);
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

/** The handler's context for one call: the caller, and the core reached as the caller. */
export function contextFor({ core, principal, track }: OpDeps): PluginContext {
  return {
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
  const out = await op.handler(contextFor(deps), input as never);
  if (!out.ok) {
    const { status, code } = out.refusal;
    if (!REFUSAL_STATUSES.has(status) || !REFUSAL_CODE.test(code)) throw new Error(`${op.tool} refused with status ${status} and code ${JSON.stringify(code)}: a refusal is 400, 403, 404, 409 or 422 with an UPPER_CASE code`);
    // Never retryable, on either transport: a refusal is the plugin's answer
    // to this input, and the statuses it may use all say so. Last, so a fact
    // of the plugin's own cannot say otherwise.
    return { ok: false, refusal: { ...out.refusal, retryable: false } };
  }
  const value = op.output.safeParse(out.value);
  if (!value.success) throw new Error(`${op.tool} answered a value its output schema refuses: ${value.error.issues.map((i) => `${i.path.map(String).join(".") || "(value)"} ${i.message}`).join("; ")}`);
  return { ok: true, value: value.data };
}
