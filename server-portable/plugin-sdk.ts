// What a plugin imports (SMD-2310): the one module a `plugins/<name>/` file
// reaches outside its own directory. A plugin is a curated contribution that
// runs inside the REST core's process — its operations join the brain's one
// contract (SMD-1931), so the REST core routes them, the MCP server lists them
// as tools and the OpenAPI document describes them, each behind the same scope
// gate as a core operation (tools.ts's UNLOCKS). zod comes from here, not from
// a bare import in the plugin: a plugin's directory has no node_modules of its
// own, in a checkout or in the image.

import { z } from "zod";
import type { Scope } from "./auth.ts";
import type { ToolName } from "./tools.ts";
import type { CoreAnswer } from "./core/calls.ts";
import type { SPECS } from "./core/schemas.ts";

export { z };

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
   * the audit row. The only way a plugin reaches the brain's thoughts.
   */
  call<K extends ToolName>(name: K, input: CoreInput<K>): Promise<CoreAnswer<K> | CallForbidden | CallRefusedInput>;
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
}

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
