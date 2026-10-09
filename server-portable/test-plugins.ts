#!/usr/bin/env bun
/**
 * test-plugins.ts — plugins in the brain's contract, without a database
 * (SMD-2310): the manifests the tree holds and the ones it must refuse,
 * OB1_PLUGINS read into the enabled set, and an enabled plugin's operation as
 * both servers serve it — a REST route behind the scope gate over a stub core,
 * an OpenAPI entry with its output schema, a whoami entry, an MCP tool a key
 * sees only where its scope reaches — and a disabled one in none of them.
 * ctx.call reaches a core operation as the caller, behind the caller's gate.
 *
 *   bun test-plugins.ts
 */

import { createHash } from "node:crypto";
import { createAssert } from "../db/test-support.ts";
import { hashKey, type Principal } from "./auth.ts";
import { visibleToolNames } from "./tools.ts";
import { loadPlugins, manifestProblems, pluginNames, pluginProblem, runOperation, toolNameOf } from "./core/plugins.ts";
import type { Core } from "./core/index.ts";
import { ok as coreOk, refuse as coreRefuse } from "./core/refusal.ts";
import type { AgentOutcome } from "./agents.ts";
import { createRestApp } from "./rest/app.ts";
import { openApiDocument } from "./rest/openapi.ts";
import { definePlugin, ok, operation, refuse, z, type PluginManifest } from "./plugin-sdk.ts";
import { PLUGINS } from "../plugins/registry.ts";

const { assert, report } = createAssert();

// The MCP server reads its environment once, at its first request: the
// example plugin enabled and three keys, one per client scope, before it is
// imported ([7]). No store: nothing below reaches one through it.
delete process.env.OB1_STORE;
delete process.env.DATABASE_URL;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.MCP_ACCESS_KEY;
process.env.OPENROUTER_API_KEY = "stub-openrouter";
process.env.OB1_PLUGINS = "example";
const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
process.env.MCP_ACCESS_KEYS = `r:read:${sha("read-raw")},w:write:${sha("write-raw")},c:capture:${sha("cap-raw")}`;

/** A manifest with one operation, `fields` over a sound one. */
const withOp = (name: string, key: string, fields: Record<string, unknown> = {}): PluginManifest =>
  definePlugin({
    name,
    title: "T",
    description: "D",
    operations: { [key]: { title: "t", description: "d", scope: "read", method: "GET", path: `/${key.replace(/_/g, "-")}`, input: {}, output: {}, handler: async () => ok({}), ...fields } as never },
  });

console.log("\n[1] Manifests: the tree's are sound, and a malformed one is refused, naming what is wrong");
{
  assert(manifestProblems(PLUGINS).length === 0, `every plugin in plugins/registry.ts is sound (${manifestProblems(PLUGINS).join("; ")})`);
  assert(PLUGINS.some((p) => p.name === "example"), "the example plugin is in the registry");
  const cases: [string, PluginManifest[], RegExp][] = [
    ["a name with an upper-case letter", [withOp("Crm", "list")], /lower-case words joined by single hyphens/],
    ["a name with an underscore", [withOp("meal_plan", "list")], /lower-case words joined by single hyphens/],
    ["a name over 32 characters", [withOp("a".repeat(33), "list")], /at most 32/],
    ["two plugins of one name", [withOp("crm", "list"), withOp("crm", "add")], /two plugins share the name/],
    ["an operation key with a hyphen", [withOp("crm", "add-contact")], /lower-case words joined by single underscores/],
    ["a tool name the core holds", [withOp("list", "thoughts")], /list_thoughts is the core's/],
    ["two plugins one tool name", [withOp("a-b", "c"), withOp("a", "b_c")], /a_b_c is plugin "a-b"'s/],
    ["a scope no key has", [withOp("crm", "list", { scope: "forward" })], /scope "forward" is not read, capture or write/],
    ["a method no route takes", [withOp("crm", "list", { method: "PUT" })], /method "PUT"/],
    ["a path with a dot", [withOp("crm", "list", { path: "/a.b" })], /path "\/a.b"/],
    ["a path with no leading slash", [withOp("crm", "list", { path: "list" })], /path "list"/],
    ["a path field no input names", [withOp("crm", "get", { path: "/items/{id}" })], /\{id\} is no input field/],
    ["no operations", [definePlugin({ name: "crm", title: "T", description: "D", operations: {} })], /no operations/],
    ["no title", [withOp("crm", "list", { title: " " })], /a title and a description are required/],
    ["no handler", [withOp("crm", "list", { handler: undefined })], /no handler/],
  ];
  for (const [label, manifests, want] of cases) {
    const problems = manifestProblems(manifests).join("; ");
    assert(want.test(problems), `${label} is refused (${problems || "no problem found"})`);
  }
  const twoRoutes = definePlugin({ name: "crm", title: "T", description: "D", operations: {
    a: operation({ title: "t", description: "d", scope: "read", method: "GET", path: "/items/{x}", input: { x: z.string() }, output: {}, handler: async () => ok({}) }),
    b: operation({ title: "t", description: "d", scope: "read", method: "GET", path: "/items/{y}", input: { y: z.string() }, output: {}, handler: async () => ok({}) }),
  } });
  assert(/its route GET \/items\/\{y\} matches a request operation "a"'s does/.test(manifestProblems([twoRoutes]).join()), "two operations on one method and path shape are refused");
  const shadowed = definePlugin({ name: "crm", title: "T", description: "D", operations: {
    by_id: operation({ title: "t", description: "d", scope: "read", method: "GET", path: "/items/{id}", input: { id: z.string() }, output: {}, handler: async () => ok({}) }),
    latest: operation({ title: "t", description: "d", scope: "read", method: "GET", path: "/items/latest", input: {}, output: {}, handler: async () => ok({}) }),
    other_method: operation({ title: "t", description: "d", scope: "write", method: "POST", path: "/items/latest", input: {}, output: {}, handler: async () => ok({}) }),
    deeper: operation({ title: "t", description: "d", scope: "read", method: "GET", path: "/items/latest/old", input: {}, output: {}, handler: async () => ok({}) }),
  } });
  const shadow = manifestProblems([shadowed]);
  assert(shadow.length === 1 && /"latest".*GET \/items\/latest matches a request operation "by_id"'s does/.test(shadow[0]), `a static segment a {field} would hide is refused, and only that: another method or depth is its own route (${shadow.join("; ")})`);
  const staticFirst = definePlugin({ name: "crm", title: "T", description: "D", operations: {
    latest: operation({ title: "t", description: "d", scope: "read", method: "GET", path: "/items/latest", input: {}, output: {}, handler: async () => ok({}) }),
    by_id: operation({ title: "t", description: "d", scope: "read", method: "GET", path: "/items/{id}", input: { id: z.string() }, output: {}, handler: async () => ok({}) }),
  } });
  assert(/"by_id".*matches a request operation "latest"'s does/.test(manifestProblems([staticFirst]).join()), "the same overlap declared the other way round is refused too: the static route first would hide the field's 'latest'");
  assert(/its path names \{id\} twice/.test(manifestProblems([withOp("crm", "get", { path: "/x/{id}/{id}", input: { id: z.string() } })]).join()), "a path naming one field twice is refused");
  assert(/\{id\} is optional or defaulted/.test(manifestProblems([withOp("crm", "get", { path: "/items/{id}", input: { id: z.string().optional() } })]).join()), "an optional path field is refused: MCP could call without it");
  assert(/\{id\} is optional or defaulted/.test(manifestProblems([withOp("crm", "get", { path: "/items/{id}", input: { id: z.string().default("x") } })]).join()), "a defaulted path field is refused too");
  assert(/is over 64 characters/.test(manifestProblems([withOp("a".repeat(32), "b".repeat(32))]).join()) && manifestProblems([withOp("a".repeat(31), "b".repeat(32))]).length === 0, "a tool name over 64 characters is refused, and one of 64 is sound");
  const numberPath = withOp("crm", "get", { path: "/items/{n}", input: { n: z.number().int() } });
  assert(/its path's \{n\} is not a string field/.test(manifestProblems([numberPath]).join()), "a path field that is not a string is refused: a segment is text, and REST could never reach it");
  const transformed = withOp("crm", "len", { output: { len: z.string().transform((s) => s.length) } });
  assert(/its output schema transforms/.test(manifestProblems([transformed]).join()), "an output schema that transforms is refused: MCP holds the answer to it again");
  assert(manifestProblems([withOp("crm", "get", { path: "/items/{id}", input: { id: z.string().uuid() }, output: { at: z.string().default("now") } })]).length === 0, "a string path field with a format, and an output default, are sound");
  assert(toolNameOf("meal-planning", "add_recipe") === "meal_planning_add_recipe", "a tool name reads the plugin's hyphens as underscores");
}

console.log("\n[2] OB1_PLUGINS: the enabled set, in the tree's order; a name that is no plugin, or one named twice, refuses to start");
{
  assert(loadPlugins(undefined).length === 0 && loadPlugins("").length === 0 && loadPlugins(" , ").length === 0, "unset, empty or blank: none");
  assert(pluginNames(" example , ,") .join() === "example", "names are trimmed and blanks dropped");
  const [ex] = loadPlugins("example");
  const op = ex.operations[0];
  assert(ex.name === "example" && op.tool === "example_recent" && op.path === "/v1/plugins/example/recent" && op.scope === "read" && op.method === "GET", `the example's operation: ${op.tool} at ${op.method} ${op.path}, scope ${op.scope}`);
  assert(op.annotations.readOnlyHint === true, "a read operation is annotated read-only");
  let thrown = "";
  try { loadPlugins("example,crm"); } catch (e) { thrown = (e as Error).message; }
  assert(/OB1_PLUGINS names "crm", which is no plugin in this build \(known: example\)/.test(thrown), `a name that is no plugin throws, naming it and the known ones (${thrown})`);
  thrown = "";
  try { loadPlugins("example,example"); } catch (e) { thrown = (e as Error).message; }
  assert(/names "example" twice/.test(thrown), `a name given twice throws (${thrown})`);
  thrown = "";
  try { loadPlugins("", [withOp("Bad", "x")]); } catch (e) { thrown = (e as Error).message; }
  assert(/a plugin manifest is malformed/.test(thrown), "a malformed manifest in the tree throws even when no plugin is enabled");
  assert(pluginProblem("nope") !== null && pluginProblem("example") === null && pluginProblem(undefined) === null, "pluginProblem: the throw as a sentence, null when sound");
}

// ── A stub core: each operation answers what the case below asks of it ──────
const calls: { name: string; principal: Principal; input: unknown }[] = [];
let answer: () => Promise<unknown> = async () => coreOk({ thoughts: [] });
const core = new Proxy({}, {
  get: (_t, prop) => async (principal: Principal, input: unknown) => {
    calls.push({ name: String(prop), principal, input });
    return answer();
  },
}) as unknown as Core;
const identity: AgentOutcome = { status: "ok", agentId: "agent-1" };
const lines: string[] = [];
const appWith = (raw: string | undefined, registry: readonly PluginManifest[] = PLUGINS) =>
  createRestApp({
    core,
    init: () => {},
    keys: () => ({ MCP_ACCESS_KEYS: `r:read:${hashKey("read-raw")},w:write:${hashKey("write-raw")},c:capture:${hashKey("cap-raw")}` }),
    resolve: async () => identity,
    track: (run) => run(),
    log: (l) => lines.push(l),
    plugins: () => loadPlugins(raw, registry),
  });
const enabled = appWith("example");
const disabled = appWith(undefined);
const hit = (app: ReturnType<typeof appWith>, path: string, init: RequestInit & { key?: string } = {}) =>
  app.fetch(new Request(`http://api${path}`, { ...init, headers: { ...(init.key ? { "x-brain-key": init.key } : {}), ...(init.body ? { "content-type": "application/json" } : {}) } }));
const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> });

console.log("\n[3] Enabled, the operation is in whoami for the scopes that reach it and in the OpenAPI document; disabled, in neither");
{
  for (const [key, scope, sees] of [["read-raw", "read", true], ["write-raw", "write", true], ["cap-raw", "capture", false]] as const) {
    const on = await json(await hit(enabled, "/v1/whoami", { key }));
    const ops = on.body.operations as string[];
    assert(ops.includes("example_recent") === sees, `a ${scope} key's whoami ${sees ? "lists" : "does not list"} example_recent`);
    const want = [...visibleToolNames({ scope }), ...(sees ? ["example_recent"] : [])].sort();
    assert(JSON.stringify(ops) === JSON.stringify(want), `a ${scope} key's whoami is the core's operations and the plugin's it may call, sorted`);
    const off = await json(await hit(disabled, "/v1/whoami", { key }));
    assert(!(off.body.operations as string[]).includes("example_recent"), `disabled, a ${scope} key's whoami does not list it`);
  }
  type Doc = { paths: Record<string, Record<string, Record<string, unknown>>> };
  const on = (await (await hit(enabled, "/openapi.json")).json()) as Doc;
  const entry = on.paths["/v1/plugins/example/recent"]?.get as Record<string, unknown> | undefined;
  assert(entry?.operationId === "example_recent" && entry["x-ob1-scope"] === "read" && entry["x-ob1-plugin"] === "example", "enabled, the document lists the operation with its scope and plugin");
  assert(JSON.stringify(entry?.tags) === '["plugin:example"]', "under its plugin's tag");
  const params = (entry?.parameters ?? []) as { name: string; in: string; required: boolean }[];
  assert(params.length === 1 && params[0].name === "limit" && params[0].in === "query" && params[0].required === false, "its input as query parameters, a defaulted one not required");
  const success = ((entry?.responses as Record<string, { content?: { "application/json": { schema: { properties?: Record<string, unknown>; required?: string[] } } } }>)["200"]);
  const schema = success?.content?.["application/json"].schema;
  assert(schema?.properties && "thoughts" in schema.properties && JSON.stringify(schema.required) === '["thoughts"]', "its success is described by the output schema the manifest declares");
  const answers = Object.keys(entry?.responses as object).sort().join();
  assert(answers === "200,400,401,403,404,405,409,422,500,503", `its answers: the success, the caller's standing, its input, the plugin's refusals, a fault — no 501 (${answers})`);
  const off = (await (await hit(disabled, "/openapi.json")).json()) as Doc;
  assert(!Object.keys(off.paths).some((p) => p.startsWith("/v1/plugins/")), "disabled, the document has no plugin path");
  const ids = Object.values(on.paths).flatMap((m) => Object.values(m).map((o) => o.operationId));
  assert(new Set(ids).size === ids.length, "operationIds stay unique with a plugin's beside the core's");
}

console.log("\n[4] The operation over REST: the gate, the input held to its schema, the answer held to its output; disabled, no route");
{
  calls.length = 0;
  answer = async () => coreOk({ thoughts: [{ id: "t1", content: "secret words", metadata: { type: "idea" }, created_at: "2026-10-08T00:00:00.000Z", supersededBy: null }] });
  let r = await json(await hit(enabled, "/v1/plugins/example/recent", { key: "read-raw" }));
  assert(r.status === 200 && JSON.stringify(r.body) === '{"thoughts":[{"id":"t1","type":"idea","created_at":"2026-10-08T00:00:00.000Z"}]}', `a read key → 200 and the value its output schema holds, no content (${JSON.stringify(r.body)})`);
  assert(calls.length === 1 && calls[0].name === "listThoughts" && calls[0].principal.name === "r" && (calls[0].input as { limit: number }).limit === 5, "it ran list_thoughts as the caller, with the schema's default limit");
  const line = JSON.parse(lines.at(-1) ?? "{}");
  assert(line.door === "api" && line.route === "/v1/plugins/example/recent" && line.tool === "example_recent" && line.agent === "r" && line.status === 200, `one request line, naming the operation's route and its tool (${lines.at(-1)})`);
  calls.length = 0;
  r = await json(await hit(enabled, "/v1/plugins/example/recent?limit=3", { key: "write-raw" }));
  assert(r.status === 200 && (calls[0].input as { limit: number }).limit === 3, "a write key → 200, a query field read as its number");
  calls.length = 0;
  r = await json(await hit(enabled, "/v1/plugins/example/recent", { key: "cap-raw" }));
  assert(r.status === 403 && r.body.code === "FORBIDDEN" && r.body.needs === "read" && calls.length === 0, `a capture key → 403 FORBIDDEN needs read, and nothing runs (${r.status} ${JSON.stringify(r.body)})`);
  r = await json(await hit(enabled, "/v1/plugins/example/recent"));
  assert(r.status === 401 && r.body.code === "UNAUTHORIZED", "no key → 401");
  r = await json(await hit(enabled, "/v1/plugins/example/recent?limit=50", { key: "read-raw" }));
  assert(r.status === 400 && r.body.code === "REFUSED_INPUT" && calls.length === 0, `a limit past its schema → 400 REFUSED_INPUT (${JSON.stringify(r.body)})`);
  r = await json(await hit(enabled, "/v1/plugins/example/recent?colour=red", { key: "read-raw" }));
  assert(r.status === 400 && r.body.code === "REFUSED_INPUT", "a field the schema does not name → 400");
  r = await json(await hit(enabled, "/v1/plugins/example/recent", { key: "read-raw", method: "POST", body: "{}" }));
  assert(r.status === 405 && r.body.code === "METHOD_NOT_ALLOWED", `a POST to a GET operation → 405 (${r.status})`);
  const head = await hit(enabled, "/v1/plugins/example/recent", { key: "read-raw", method: "HEAD" });
  assert(head.status === 200 && (await head.text()) === "" && calls.length === 0, "a HEAD → 200, no body, and nothing runs");
  answer = async () => coreRefuse({ code: "REFUSED_SINCE", retryable: false, since: "x" } as never);
  r = await json(await hit(enabled, "/v1/plugins/example/recent", { key: "read-raw" }));
  assert(r.status === 422 && r.body.code === "CORE_REFUSED" && r.body.retryable === false && /list_thoughts refused: REFUSED_SINCE/.test(String(r.body.message)), `the plugin's refusal → its status and code (${JSON.stringify(r.body)})`);
  answer = async () => { throw new Error("the store is down"); };
  r = await json(await hit(enabled, "/v1/plugins/example/recent", { key: "read-raw" }));
  assert(r.status === 500 && r.body.code === "FAILED" && r.body.message === "the store is down", `a fault → 500 FAILED with its message (${JSON.stringify(r.body)})`);
  answer = async () => coreOk({ thoughts: [] });
  r = await json(await hit(enabled, "/v1/plugins/example/nothing", { key: "read-raw" }));
  assert(r.status === 404 && r.body.code === "NO_ROUTE", "an operation the plugin does not have → 404 NO_ROUTE");
  r = await json(await hit(disabled, "/v1/plugins/example/recent", { key: "read-raw" }));
  assert(r.status === 404 && r.body.code === "NO_ROUTE", "disabled → 404 NO_ROUTE");
}

// A plugin of the suite's own, beside the example: a path field, a write
// operation that calls a core write, an answer its schema refuses and a
// refusal no client could read.
let handed: unknown = null;
const probe = definePlugin({
  name: "probe-kit",
  title: "Probe",
  description: "The suite's own plugin.",
  operations: {
    item: operation({
      title: "An item", description: "Echoes its path field.", scope: "read", method: "GET", path: "/items/{item_id}",
      input: { item_id: z.string(), verbose: z.boolean().default(false) }, output: { item_id: z.string(), verbose: z.boolean() },
      async handler(_ctx, input) { handed = input; return input.item_id === "gone" ? refuse(404, "ITEM_GONE", { item_id: input.item_id }) : ok(input); },
    }),
    note: operation({
      title: "Note", description: "Captures through the core.", scope: "read", method: "POST", path: "/notes",
      input: { text: z.string() }, output: { outcome: z.string() },
      async handler(ctx, { text }) {
        const r = await ctx.call("capture_thought", { content: text });
        return ok({ outcome: r.ok ? "captured" : r.refusal.code });
      },
    }),
    bad_input: operation({
      title: "Bad input", description: "Calls the core with input its schema refuses.", scope: "read", method: "POST", path: "/bad-input",
      input: {}, output: { outcome: z.string() },
      async handler(ctx) {
        const r = await ctx.call("fetch", { id: 7 } as never);
        return ok({ outcome: r.ok ? "fetched" : r.refusal.code });
      },
    }),
    wrong_shape: operation({
      title: "Wrong shape", description: "Answers what its schema refuses.", scope: "write", method: "POST", path: "/wrong-shape",
      input: {}, output: { count: z.number() },
      async handler() { return ok({ count: "three" } as never); },
    }),
    bad_refusal: operation({
      title: "Bad refusal", description: "Refuses with a status no client reads as one.", scope: "write", method: "POST", path: "/bad-refusal",
      input: {}, output: {},
      async handler() { return refuse(500 as never, "lower case"); },
    }),
    busy: operation({
      title: "Busy", description: "Refuses, claiming a retry would help.", scope: "read", method: "POST", path: "/busy",
      input: {}, output: {},
      async handler() { return refuse(409, "TRY_AGAIN", { retryable: true, message: "later" }); },
    }),
  },
});

console.log("\n[5] ctx.call: a core operation as the caller, behind the caller's gate and the operation's schema");
{
  const ops = loadPlugins("probe-kit", [...PLUGINS, probe])[0].operations;
  const note = ops.find((o) => o.key === "note")!;
  const reader: Principal = { name: "r", scope: "read" } as Principal;
  const writer: Principal = { name: "w", scope: "write" } as Principal;
  calls.length = 0;
  let out = await runOperation(note, { core, principal: reader }, { text: "hello" });
  assert(out.ok && out.value.outcome === "FORBIDDEN" && calls.length === 0, `a read key cannot capture through a read operation: FORBIDDEN, and the core never ran (${JSON.stringify(out)})`);
  answer = async () => coreOk({ id: "n1" });
  out = await runOperation(note, { core, principal: writer }, { text: "hello" });
  assert(out.ok && out.value.outcome === "captured" && calls.length === 1 && calls[0].name === "capture" && calls[0].principal === writer, "a write key captures through it, as itself");
  assert((calls[0].input as Record<string, unknown>).content === "hello", "the core got the plugin's input");
  calls.length = 0;
  out = await runOperation(ops.find((o) => o.key === "bad_input")!, { core, principal: writer }, {});
  assert(out.ok && out.value.outcome === "REFUSED_INPUT" && calls.length === 0, "input the core's schema refuses: REFUSED_INPUT, and the core never ran");
  let thrown = "";
  try { await runOperation(ops.find((o) => o.key === "wrong_shape")!, { core, principal: writer }, {}); } catch (e) { thrown = (e as Error).message; }
  assert(/probe_kit_wrong_shape answered a value its output schema refuses: count/.test(thrown), `an answer its output schema refuses is the plugin's fault, thrown (${thrown})`);
  // A step the load check cannot see — a pipe after a transform, a
  // preprocess that is not idempotent — changes the answer past its schema;
  // the MCP SDK would refuse what REST answered, so neither answers it.
  for (const [label, output, value] of [
    ["a transform piped into a typed schema", { v: z.string().transform((s) => s.length).pipe(z.number()) }, { v: "abc" }],
    ["a preprocess that is not idempotent", { v: z.preprocess((x) => `${String(x)}!`, z.string().max(3)) }, { v: "ab" }],
  ] as const) {
    const changing = definePlugin({ name: "probe-kit", title: "P", description: "D", operations: { x: operation({ title: "t", description: "d", scope: "read", method: "GET", path: "/x", input: {}, output: output as never, async handler() { return ok(value as never); } }) } });
    thrown = "";
    try { await runOperation(loadPlugins("probe-kit", [changing])[0].operations[0], { core, principal: reader }, {}); } catch (e) { thrown = (e as Error).message; }
    assert(/changes into one it refuses/.test(thrown), `${label}: the held answer, held again, is refused — a fault on both transports (${thrown || "answered"})`);
  }
  thrown = "";
  try { await runOperation(ops.find((o) => o.key === "bad_refusal")!, { core, principal: writer }, {}); } catch (e) { thrown = (e as Error).message; }
  assert(/refused with status 500 and code "lower case"/.test(thrown), `a refusal at no refusal status, or with no code, is the plugin's fault (${thrown})`);
  thrown = "";
  const ctxProbe = definePlugin({ name: "probe-kit", title: "P", description: "D", operations: { x: operation({ title: "t", description: "d", scope: "write", method: "POST", path: "/x", input: {}, output: {}, async handler(ctx) { await ctx.call("drop_everything" as never, {} as never); return ok({}); } }) } });
  try { await runOperation(loadPlugins("probe-kit", [ctxProbe])[0].operations[0], { core, principal: writer }, {}); } catch (e) { thrown = (e as Error).message; }
  assert(/"drop_everything" is no core operation/.test(thrown), "a name no core operation has is refused, not dispatched");
}

console.log("\n[6] Over REST: a path field decoded and held to the schema, a body read by its schema, a fault and a refusal as JSON");
{
  const app = appWith("probe-kit", [...PLUGINS, probe]);
  let r = await json(await hit(app, "/v1/plugins/probe-kit/items/a%20b?verbose=true", { key: "read-raw" }));
  assert(r.status === 200 && r.body.item_id === "a b" && r.body.verbose === true && (handed as { item_id: string }).item_id === "a b", `a path field decoded, a query boolean read (${JSON.stringify(r.body)})`);
  const itemLine = JSON.parse(lines.at(-1) ?? "{}");
  assert(itemLine.route === "/v1/plugins/probe-kit/items/:item_id" && itemLine.tool === "probe_kit_item", `the line names the route's template, its field spelled as a core route's, never the path given (${lines.at(-1)})`);
  r = await json(await hit(app, "/v1/plugins/probe-kit/items/%E0", { key: "read-raw" }));
  assert(r.status === 400 && r.body.code === "REFUSED_INPUT", "a path segment that does not decode → 400");
  r = await json(await hit(app, "/v1/plugins/probe-kit/items/x?item_id=y", { key: "read-raw" }));
  assert(r.status === 400 && /comes from the path/.test(JSON.stringify(r.body)), "a path field sent in the query → 400");
  r = await json(await hit(app, "/v1/plugins/probe-kit/items/gone", { key: "read-raw" }));
  assert(r.status === 404 && r.body.code === "ITEM_GONE" && r.body.item_id === "gone" && r.body.retryable === false && !("status" in r.body), `the plugin's refusal → its status, code and facts, not its status field (${JSON.stringify(r.body)})`);
  r = await json(await hit(app, "/v1/plugins/probe-kit/notes", { key: "read-raw", method: "POST", body: JSON.stringify({ text: "x", extra: 1 }) }));
  assert(r.status === 400 && r.body.code === "REFUSED_INPUT", "a body field the schema does not name → 400");
  r = await json(await hit(app, "/v1/plugins/probe-kit/wrong-shape", { key: "write-raw", method: "POST" }));
  assert(r.status === 500 && r.body.code === "FAILED" && /output schema refuses/.test(String(r.body.message)), "an answer its schema refuses → 500 FAILED");
  r = await json(await hit(app, "/v1/plugins/probe-kit/wrong-shape", { key: "read-raw", method: "POST" }));
  assert(r.status === 403 && r.body.needs === "write", "a write operation refuses a read key: 403 needs write");
  r = await json(await hit(app, "/v1/plugins/probe-kit/busy", { key: "read-raw", method: "POST" }));
  assert(r.status === 409 && r.body.code === "TRY_AGAIN" && r.body.retryable === false && r.body.message === "later", `a refusal is never retryable, whatever the plugin's facts say (${JSON.stringify(r.body)})`);
  lines.length = 0;
  await hit(app, "/v1/plugins/probe-kit/nothing-here", { key: "read-raw" });
  const unrouted = JSON.parse(lines.at(-1) ?? "{}");
  assert(unrouted.status === 404 && !("route" in unrouted) && !("tool" in unrouted), `a plugin path no operation takes logs as any unrouted request, not the wildcard (${lines.at(-1)})`);
}

console.log("\n[7] The MCP server: an enabled plugin's operation is a tool for the keys whose scope reaches it");
{
  const worker = (await import("./index.ts")).default as { fetch: (req: Request) => Response | Promise<Response> };
  const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const rpc = async (key: string, method: string, params: Record<string, unknown>) => {
    const r = await worker.fetch(new Request("http://mcp/mcp", { method: "POST", headers: { ...H, "x-brain-key": key }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
    const text = await r.text();
    const line = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? "null";
    return JSON.parse(line) as { result?: Record<string, unknown>; error?: { message: string } };
  };
  type Tool = { name: string; outputSchema?: { properties?: Record<string, unknown> }; annotations?: { readOnlyHint?: boolean } };
  for (const [key, scope, sees] of [["read-raw", "read", true], ["write-raw", "write", true], ["cap-raw", "capture", false]] as const) {
    const tools = ((await rpc(key, "tools/list", {})).result?.tools ?? []) as Tool[];
    const names = tools.map((t) => t.name).sort();
    const want = [...visibleToolNames({ scope }), ...(sees ? ["example_recent"] : [])].sort();
    assert(JSON.stringify(names) === JSON.stringify(want), `a ${scope} key's tools/list is the core's and ${sees ? "example_recent" : "no plugin tool"} (${names.filter((n) => n.startsWith("example")).join() || "none"})`);
    if (sees) {
      const tool = tools.find((t) => t.name === "example_recent")!;
      assert(tool.outputSchema?.properties && "thoughts" in tool.outputSchema.properties && tool.annotations?.readOnlyHint === true, "with its output schema and the read-only hint");
    }
  }
  const call = await rpc("cap-raw", "tools/call", { name: "example_recent", arguments: {} });
  const refused = JSON.stringify(call);
  assert(/example_recent/.test(refused) && (call.error !== undefined || (call.result as { isError?: boolean })?.isError === true), `a capture key calling it is refused: the tool is not its (${refused.slice(0, 160)})`);
  // A read key's call reaches the operation, and its ctx.call reaches the
  // core: with no store configured, the core's own fault comes back as the
  // tool's error — the operation ran, through the server's registration.
  const ran = (await rpc("read-raw", "tools/call", { name: "example_recent", arguments: { limit: 2 } })).result as { isError?: boolean; content?: { text: string }[] } | undefined;
  assert(ran?.isError === true && /^Error: .*DATABASE_URL/.test(ran.content?.[0]?.text ?? ""), `a read key's call runs the operation through to the core, whose fault is the tool's error (${ran?.content?.[0]?.text?.slice(0, 120)})`);
  const bad = await rpc("read-raw", "tools/call", { name: "example_recent", arguments: { limit: 50 } });
  assert(JSON.stringify(bad).includes("limit") && (bad.error !== undefined || (bad.result as { isError?: boolean })?.isError === true), "an argument past its schema is refused before the operation runs");
}

console.log("\n[9] The MCP reply: the value as JSON text and as structured content the SDK holds to the output schema; a refusal its code and facts");
{
  const { renderPlugin } = await import("./render.ts");
  const okReply = renderPlugin({ ok: true, value: { item_id: "a", verbose: false } });
  assert(okReply.isError === undefined && okReply.content[0].text === '{"item_id":"a","verbose":false}' && JSON.stringify(okReply.structuredContent) === '{"item_id":"a","verbose":false}', "a success: the value's JSON, and the value as structured content");
  const no = renderPlugin({ ok: false, refusal: { status: 404, code: "ITEM_GONE", retryable: false, message: "gone", item_id: "a" } });
  assert(no.isError === true && no.content[0].text === "Refused: ITEM_GONE — gone" && JSON.stringify(no.structuredContent) === '{"code":"ITEM_GONE","retryable":false,"message":"gone","item_id":"a","text":"Refused: ITEM_GONE — gone"}', `a refusal: its code and message in the text, its facts beside it, no status (${JSON.stringify(no.structuredContent)})`);
  // The SDK's own check, as index.ts registers a tool: the answer runOperation
  // held to the output schema passes the SDK's second hold, a default filled.
  const { McpServer, WebStandardStreamableHTTPServerTransport } = await import("@modelcontextprotocol/server");
  const defaulted = definePlugin({ name: "probe-kit", title: "P", description: "D", operations: {
    stamp: operation({ title: "t", description: "d", scope: "read", method: "GET", path: "/stamp", input: {}, output: { at: z.string().default("never"), n: z.number() }, async handler() { return ok({ n: 1 }); } }),
  } });
  const [op] = loadPlugins("probe-kit", [defaulted])[0].operations;
  const server = new McpServer({ name: "probe", version: "1" });
  (server.registerTool as unknown as (n: string, s: unknown, h: (i: unknown) => Promise<unknown>) => unknown)(op.tool, { title: op.title, description: op.description, annotations: op.annotations, inputSchema: op.input, outputSchema: op.output },
    async (input) => renderPlugin(await runOperation(op, { core, principal: { name: "r", scope: "read" } as Principal }, input)));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const send = async (id: number, method: string, params: unknown) => (await (await transport.handleRequest(new Request("http://probe/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }))).json()) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown> } };
  await send(0, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } });
  const stamped = await send(1, "tools/call", { name: "probe_kit_stamp", arguments: {} });
  assert(stamped.result?.isError !== true && JSON.stringify(stamped.result?.structuredContent) === '{"at":"never","n":1}', `the SDK takes the held answer, its default filled (${JSON.stringify(stamped.result)})`);
}

console.log("\n[10] Each server refuses to start on a name in OB1_PLUGINS that is no plugin");
for (const entry of ["index.ts", "api.ts"]) {
  const p = Bun.spawnSync(["bun", "--no-env-file", entry], { cwd: import.meta.dir, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PORT: "0", OB1_PLUGINS: "example,nope" }, stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  const said = p.stderr.toString() + p.stdout.toString();
  assert(p.exitCode !== 0 && p.exitCode !== null && /"nope", which is no plugin/.test(said), `${entry} exits at its start, naming the name (exit ${p.exitCode}: ${said.match(/OB1_PLUGINS[^\n]*/)?.[0] ?? said.slice(0, 120)})`);
}

console.log("\n[8] Preflight: a name in OB1_PLUGINS that is no plugin fails the gate; a sound one is reported");
{
  const run = (plugins: string) => {
    const p = Bun.spawnSync(["bun", "--no-env-file", "preflight.ts", "--json"], { cwd: import.meta.dir, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", OB1_PLUGINS: plugins }, stdout: "pipe", stderr: "pipe" });
    const rows = JSON.parse(p.stdout.toString() || "{}") as { checks?: { name: string; status: string; detail: string }[] } | { name: string; status: string; detail: string }[];
    const list = Array.isArray(rows) ? rows : rows.checks ?? [];
    return { exit: p.exitCode, row: list.find((c) => c.name === "plugins") };
  };
  const bad = run("example,nope");
  assert(bad.exit !== 0 && bad.row?.status === "fail" && /"nope", which is no plugin/.test(bad.row.detail), `an unknown name fails the plugins row (${JSON.stringify(bad.row)})`);
  const good = run("example");
  assert(good.row?.status === "ok" && /example — enabled/.test(good.row.detail), `a sound name is reported enabled (${JSON.stringify(good.row)})`);
}

report();
