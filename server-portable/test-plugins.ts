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
import { unlocks, visibleToolNames } from "./tools.ts";
import { enabledHooks, hookSecrets, loadPlugins, manifestProblems, pluginNames, pluginProblem, runOperation, toolNameOf } from "./core/plugins.ts";
import { hmacSha256Hex, isDeliveryId, onceById, verifyTimestamped, type HookRequest, type PluginSql } from "./plugin-sdk.ts";
import { createCore, type Core } from "./core/index.ts";
import { ok as coreOk, refuse as coreRefuse } from "./core/refusal.ts";
import type { AgentOutcome } from "./agents.ts";
import { createRestApp } from "./rest/app.ts";
import { openApiDocument } from "./rest/openapi.ts";
import { definePlugin, ok, operation, refuse, z, type PluginManifest } from "./plugin-sdk.ts";
import { PLUGINS } from "../plugins/registry.ts";
import { pluginLoginUrl } from "../db/config.mjs";

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

/** The example's tools a key of `scope` reaches: its manifest through the gate — what whoami and tools/list add to the core's. */
const exampleTools = (scope: "read" | "write" | "capture") => loadPlugins("example")[0].operations.filter((o) => unlocks({ scope }, o.scope)).map((o) => o.tool).sort();

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
    ["a page path with a field", [{ ...withOp("crm", "list"), gui: { pages: [{ path: "/items/{id}", label: "Items" }] } }], /a page's path is segments of lower-case words and hyphens/],
    ["two pages on one path", [{ ...withOp("crm", "list"), gui: { pages: [{ path: "/items", label: "A" }, { path: "/items", label: "B" }] } }], /two pages share the path/],
    ["a page label of two lines", [{ ...withOp("crm", "list"), gui: { pages: [{ path: "/items", label: "Items\nSecond" }] } }], /a label is one line of at most 40 characters/],
    ["a page label over 40 characters", [{ ...withOp("crm", "list"), gui: { pages: [{ path: "/items", label: "x".repeat(41) }] } }], /a label is one line of at most 40 characters/],
    ["a page that is no object", [{ ...withOp("crm", "list"), gui: { pages: [null as never] } }], /a page is \{ path, label \}/],
    ["a hook named with a slash", [{ ...withOp("crm", "list"), hooks: { "a/b": { description: "d", handler: async () => ({ status: 200 }) } } }], /a hook's name is lower-case words joined by single hyphens/],
    ["a hook with no handler", [{ ...withOp("crm", "list"), hooks: { inbound: { description: "d" } as never } }], /hook "inbound": no handler/],
    ["a hook with no description", [{ ...withOp("crm", "list"), hooks: { inbound: { description: " ", handler: async () => ({ status: 200 }) } } }], /hook "inbound": a description is required/],
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
  assert(exampleTools("read").join() === "example_list_notes,example_recent" && exampleTools("write").join() === "example_add_note,example_list_notes,example_recent" && exampleTools("capture").length === 0,
    `the example's tools by scope: a read key its two reads, a write key all three, a capture key none (${exampleTools("read")} / ${exampleTools("write")} / ${exampleTools("capture")})`);
  assert(ex.operations.find((o) => o.key === "add_note")?.annotations.readOnlyHint === undefined, "a write operation carries no read-only hint");
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
  // The plugin login role's URL: its user replaced, its password encoded, and a URL with no host refused —
  // the parser ignores a user set on one, and the connection would be the server's own role.
  const login = new URL(pluginLoginUrl("postgres://postgres:x@db:5432/openbrain?sslmode=disable", "a%41b@c:d/e#f?g&h=i"));
  assert(login.username === "ob1_plugins" && decodeURIComponent(login.password) === "a%41b@c:d/e#f?g&h=i" && login.host === "db:5432" && login.search === "?sslmode=disable", "the login URL: the user replaced, the password encoded (a % kept), the rest kept");
  let noHost = "";
  try { pluginLoginUrl("postgres:///brain?host=/var/run/postgresql", "p"); } catch (e) { noHost = (e as Error).message; }
  assert(/names no host/.test(noHost), `a URL with no host is refused, not left as the server's own login (${noHost})`);
  // That refusal is a plugin transaction's, not the store's start: a server on
  // such a URL with the password set still starts and serves the core.
  const { SqlStore } = await import("./store-sql.ts");
  let store: InstanceType<typeof SqlStore> | null = null;
  let built = "";
  try { store = new SqlStore("postgres:///brain?host=/var/run/postgresql", { pluginPassword: "p" }); } catch (e) { built = (e as Error).message; }
  let txSaid = "";
  if (store) await store.pluginTx("example", async () => 1).catch((e: Error) => { txSaid = e.message; });
  assert(store !== null && built === "" && /names no host/.test(txSaid), `the store builds; the plugin's transaction is refused, naming why (${built || txSaid})`);
  await store?.close();
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
    const want = [...visibleToolNames({ scope }), ...exampleTools(scope)].sort();
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
  assert(on.paths["/v1/plugins"]?.get?.operationId === "plugins", "the document lists the plugin registry");
  // The GUI's nav registry: an enabled plugin, its pages, the operations of it the key may call.
  type Listed = { plugins: { name: string; title: string; pages: { path: string; label: string }[]; operations: string[] }[] };
  for (const [key, scope] of [["read-raw", "read"], ["write-raw", "write"]] as const) {
    const listed = (await (await hit(enabled, "/v1/plugins", { key })).json()) as Listed;
    const ex = listed.plugins.find((pl) => pl.name === "example");
    assert(listed.plugins.length === 1 && ex?.title === "Example plugin" && JSON.stringify(ex.pages) === '[{"path":"/notes","label":"Notes"}]', `a ${scope} key reads the enabled plugin and its nav page`);
    assert(JSON.stringify([...(ex?.operations ?? [])].sort()) === JSON.stringify(exampleTools(scope)), `with the operations of it a ${scope} key may call (${ex?.operations.join(", ") || "none"})`);
  }
  const forCapture = (await (await hit(enabled, "/v1/plugins", { key: "cap-raw" })).json()) as Listed;
  assert(forCapture.plugins.length === 0, "a capture key, which can call none of the example's operations, is listed no plugin: no nav entry to nothing it can use");
  const offList = (await (await hit(disabled, "/v1/plugins", { key: "read-raw" })).json()) as Listed;
  assert(offList.plugins.length === 0, "disabled, the registry lists nothing: the GUI's nav shows no page of it");
  assert((await hit(enabled, "/v1/plugins")).status === 401, "the registry needs a key");
  const post = await hit(enabled, "/v1/plugins", { key: "read-raw", method: "POST", body: "{}" });
  assert(post.status === 405 && /GET/.test(post.headers.get("allow") ?? ""), "a POST to the registry is a 405 naming GET");
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
    const want = [...visibleToolNames({ scope }), ...exampleTools(scope)].sort();
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
  const hooksRow = (env: Record<string, string>) => {
    const p = Bun.spawnSync(["bun", "--no-env-file", "preflight.ts", "--json"], { cwd: import.meta.dir, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdout: "pipe", stderr: "pipe" });
    const parsed = JSON.parse(p.stdout.toString() || "{}") as { checks?: { name: string; status: string; detail: string }[] } | { name: string; status: string; detail: string }[];
    return (Array.isArray(parsed) ? parsed : parsed.checks ?? []).find((c) => c.name === "plugin webhooks");
  };
  const noPlugin = hooksRow({ OB1_PLUGINS: "example", OB1_HOOKS: "crm" });
  assert(noPlugin?.status === "fail" && /"crm", which is no enabled plugin with a webhook/.test(noPlugin.detail), `OB1_HOOKS naming no enabled plugin with a webhook fails the plugin webhooks row (${JSON.stringify(noPlugin)})`);
  const noSecret = hooksRow({ OB1_PLUGINS: "example", OB1_HOOKS: "example" });
  assert(noSecret?.status === "warn" && /no secret for example/.test(noSecret.detail), `a served plugin with no secret warns (${JSON.stringify(noSecret)})`);
  const served = hooksRow({ OB1_PLUGINS: "example", OB1_HOOKS: "example", OB1_HOOK_SECRETS: "example=abc" });
  assert(served?.status === "ok" && !served.detail.includes("abc"), `a served plugin with its secret: ok, and the secret never printed (${JSON.stringify(served)})`);
  const good = run("example");
  assert(good.row?.status === "ok" && /example — enabled/.test(good.row.detail), `a sound name is reported enabled (${JSON.stringify(good.row)})`);
  // A plugin with tables on the PostgREST store: its operations would fail at their first call.
  const p = Bun.spawnSync(["bun", "--no-env-file", "preflight.ts", "--json"], { cwd: import.meta.dir, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", OB1_PLUGINS: "example", OB1_STORE: "postgrest", SUPABASE_URL: "https://stub.invalid", SUPABASE_SERVICE_ROLE_KEY: "stub" }, stdout: "pipe", stderr: "pipe" });
  const parsed = JSON.parse(p.stdout.toString() || "{}") as { checks?: { name: string; status: string; detail: string }[] } | { name: string; status: string; detail: string }[];
  const postgrest = (Array.isArray(parsed) ? parsed : parsed.checks ?? []).find((c) => c.name === "plugins");
  assert(postgrest?.status === "fail" && /example keeps tables, which need the SQL store/.test(postgrest.detail), `a plugin with tables on the PostgREST store fails the plugins row (${JSON.stringify(postgrest)})`);
}

console.log("\n[11] Webhooks: served only for a plugin OB1_HOOKS names, POST alone, the body bounded, the handler's verification and its capture as the hook's own caller");
{
  // Which hooks are served, and their secrets.
  const enabledEx = loadPlugins("example");
  assert(enabledHooks(enabledEx, undefined).length === 0, "OB1_HOOKS unset: no webhook served");
  assert(JSON.stringify(enabledHooks(enabledEx, "example").map((h) => h.path)) === '["/hooks/example/capture"]', "OB1_HOOKS=example: the example's capture hook, at /hooks/example/capture");
  let thrown = "";
  try { enabledHooks(enabledEx, "crm"); } catch (e) { thrown = (e as Error).message; }
  assert(/OB1_HOOKS names "crm", which is no enabled plugin with a webhook/.test(thrown), `a name that is no enabled plugin is refused (${thrown})`);
  thrown = "";
  try { enabledHooks(loadPlugins(undefined), "example"); } catch (e) { thrown = (e as Error).message; }
  assert(/no enabled plugin/.test(thrown), "a plugin in OB1_HOOKS but not OB1_PLUGINS is refused: no webhook without its plugin");
  const parsed = hookSecrets("example=abc=def  other=x");
  assert(parsed.problem === null && parsed.secrets.get("example") === "abc=def" && parsed.secrets.get("other") === "x", "OB1_HOOK_SECRETS: plugin=secret pairs by spaces, the first = the separator");
  assert(/entry 2 is not plugin=secret/.test(hookSecrets("example=a nosecret").problem ?? "") && /twice/.test(hookSecrets("a=1 a=2").problem ?? ""), "a pair with no = and a name given twice are refused, by position and not by text");
  assert(!(hookSecrets("example=topsecret oops").problem ?? "").includes("topsecret"), "a refusal never prints a secret");

  // Over REST.
  const SECRET = "hook-secret-0123";
  const faults: string[] = [];
  const hookApp = (hooksRaw: string | undefined, secretsRaw: string | undefined, withCore: Core = core) => createRestApp({
    core: withCore, init: () => {}, keys: () => ({ MCP_ACCESS_KEYS: `r:read:${hashKey("read-raw")}` }), resolve: async () => identity, track: (run) => run(), log: (l) => lines.push(l), faultLog: (l) => faults.push(l),
    plugins: () => loadPlugins("example"),
    hooks: () => ({ hooks: enabledHooks(loadPlugins("example"), hooksRaw), secrets: hookSecrets(secretsRaw).secrets }),
  });
  const on = hookApp("example", `example=${SECRET}`);
  const deliver = (app: ReturnType<typeof hookApp>, body: string, headers: Record<string, string> = {}, path = "/hooks/example/capture", method = "POST") =>
    app.fetch(new Request(`http://api${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: method === "GET" ? undefined : body }));
  const body = JSON.stringify({ text: "a thought from a webhook" });
  /** The example's signature: over "<timestamp>.<body>", the timestamp beside it (SMD-2755). */
  const sign = (data: string | Uint8Array, ts = Math.floor(Date.now() / 1000), key = SECRET) => ({
    "x-example-timestamp": String(ts),
    "x-example-signature": hmacSha256Hex(key, new Uint8Array([...new TextEncoder().encode(`${ts}.`), ...(typeof data === "string" ? new TextEncoder().encode(data) : data)])),
  });
  const signed = sign(body);
  calls.length = 0;
  answer = async () => coreOk({ id: "t-hook" });
  let r = await deliver(on, body, signed);
  const got = (await r.json()) as Record<string, unknown>;
  assert(r.status === 202 && got.id === "t-hook", `a signed delivery: 202 and the thought's id (${r.status} ${JSON.stringify(got)})`);
  const capture = calls.find((c) => c.name === "capture");
  assert(capture?.principal.name === "hook:example" && capture.principal.scope === "capture" && (capture.input as { trust?: string; source?: string }).trust === "ingested" && (capture.input as { source?: string }).source === "example-hook", `it captured through the core as hook:example, capture scope, trust ingested (${JSON.stringify(capture?.principal)})`);
  const hookLine = JSON.parse(lines.at(-1) ?? "{}");
  assert(hookLine.method === "POST" && hookLine.route === "/hooks/example/capture" && hookLine.status === 202 && !("agent" in hookLine), `one request line, naming the hook's route, no key's name (${lines.at(-1)})`);
  // Through compose.api-public.yaml's /api, which strips its prefix and says so: no route, the handler never runs.
  calls.length = 0;
  r = await deliver(on, body, { ...signed, "x-forwarded-prefix": "/api" });
  assert(r.status === 404 && calls.length === 0, "a delivery that came through /api (X-Forwarded-Prefix): 404, the handler never ran — /api does not open /hooks");
  calls.length = 0;
  const code = async (res: Response) => ((await res.json()) as { code?: string }).code;
  r = await deliver(on, body, sign(body, undefined, "another"));
  assert(r.status === 401 && (await code(r)) === "BAD_SIGNATURE" && calls.length === 0, "a delivery signed with another secret: 401 BAD_SIGNATURE, and the core never ran");
  r = await deliver(on, body);
  assert(r.status === 401 && (await code(r)) === "NO_TIMESTAMP", "an unsigned delivery: 401");
  // Replays (SMD-2755): a recorded delivery verifies for the tolerance alone.
  const now = Math.floor(Date.now() / 1000);
  r = await deliver(on, body, sign(body, now - 301));
  assert(r.status === 401 && (await code(r)) === "STALE_DELIVERY" && calls.length === 0, "a delivery signed 301 s ago: 401 STALE_DELIVERY, and the core never ran");
  r = await deliver(on, body, sign(body, now + 310));
  assert(r.status === 401 && (await code(r)) === "STALE_DELIVERY" && calls.length === 0, "one dated 310 s ahead: 401 STALE_DELIVERY too (the 301 s edges are [12]'s, on a clock of its own)");
  r = await deliver(on, body, { ...sign(body, now - 301), "x-example-timestamp": String(now) });
  assert(r.status === 401 && (await code(r)) === "BAD_SIGNATURE" && calls.length === 0, "a stale delivery with its timestamp made fresh: 401 BAD_SIGNATURE — the time is signed");
  r = await deliver(on, body, { "x-example-signature": hmacSha256Hex(SECRET, body) });
  assert(r.status === 401 && (await code(r)) === "NO_TIMESTAMP" && calls.length === 0, "a sender that signs the body alone, as before SMD-2755, sends no timestamp: 401 NO_TIMESTAMP");
  r = await deliver(on, body, { "x-example-timestamp": String(now), "x-example-signature": hmacSha256Hex(SECRET, body) });
  assert(r.status === 401 && (await code(r)) === "BAD_SIGNATURE" && calls.length === 0, "a signature over the body alone, a timestamp beside it: 401 BAD_SIGNATURE — the time is not in what was signed");
  r = await deliver(on, "{not json", sign("{not json"));
  assert(r.status === 400, "a signed body that is not JSON: 400");
  const nul = JSON.stringify({ text: "a NUL \u0000 here", id: "evt-nul" });
  r = await deliver(on, nul, sign(nul));
  assert(r.status === 400 && (await code(r)) === "BAD_TEXT" && calls.length === 0, "text with a NUL, which Postgres will not store: 400 BAD_TEXT, before any claim or model call");
  for (const id of [7, "", "x".repeat(201), "a\u0000b", "\ud800", "has space", "é"]) {
    const withId = JSON.stringify({ text: "t", id });
    r = await deliver(on, withId, sign(withId));
    assert(r.status === 400 && (await code(r)) === "BAD_ID" && calls.length === 0, `a delivery id that is not 1 to 200 printable ASCII characters (${JSON.stringify(id).slice(0, 12)}): 400 BAD_ID, before any claim or capture`);
  }
  calls.length = 0;
  r = await deliver(hookApp("example", undefined), body, signed);
  assert(r.status === 503 && ((await r.json()) as { code?: string }).code === "HOOK_NOT_CONFIGURED" && calls.length === 0, "no secret for the plugin: the REST core refuses, 503, and the handler never runs");
  r = await deliver(hookApp(undefined, `example=${SECRET}`), body, signed);
  assert(r.status === 404 && calls.length === 0, "OB1_HOOKS unset: the webhook is no route, whatever is sent");
  r = await deliver(on, body, signed, "/hooks/example/nothing");
  assert(r.status === 404, "a hook the plugin does not have: 404");
  r = await deliver(on, body, {}, "/hooks/example/capture", "GET");
  assert(r.status === 405 && r.headers.get("allow") === "POST", "a GET of a webhook: 405, Allow POST");
  const big = JSON.stringify({ text: "x".repeat(1024 * 1024) });
  r = await deliver(on, big, sign(big));
  assert(r.status === 413 && calls.length === 0, "a body over 1 MiB: 413, before the handler reads it");
  answer = async () => coreRefuse({ code: "REFUSED", retryable: false, reason: "x" } as never);
  r = await deliver(on, body, signed);
  assert(r.status === 422 && ((await r.json()) as { refused?: string }).refused === "REFUSED", "the core refusing the capture: the plugin's 422, naming the core's code");
  answer = async () => { throw new Error("store down at secret-host:5432"); };
  lines.length = 0;
  r = await deliver(on, body, signed);
  const fault = (await r.json()) as Record<string, unknown>;
  assert(r.status === 500 && fault.code === "FAILED" && !JSON.stringify(fault).includes("secret-host"), `a fault: 500 FAILED, and nothing of why to the anonymous sender (${JSON.stringify(fault)})`);
  assert(faults.length === 1 && faults[0] === "api hook /hooks/example/capture fault: store down at secret-host:5432", `the message goes to the fault log, one line (${JSON.stringify(faults)})`);
  const faultLine = JSON.parse(lines.at(-1) ?? "{}");
  assert(faultLine.status === 500 && faultLine.code === "FAILED" && !lines.some((l) => l.includes("secret-host")), `the request line says the 500 and FAILED, never the message (${lines.at(-1)})`);
  // A chunked body with no length, past the limit: cut as it arrives, never read whole.
  let pulled = 0;
  const chunk = new Uint8Array(64 * 1024).fill(32);
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulled++; if (pulled > 64) controller.close(); else controller.enqueue(chunk); } });
  calls.length = 0;
  r = await on.fetch(new Request("http://api/hooks/example/capture", { method: "POST", body: stream, headers: { "x-example-signature": "x" }, duplex: "half" } as RequestInit));
  assert(r.status === 413 && pulled <= 20 && calls.length === 0, `a chunked body past 1 MiB: 413, cut after ${pulled} of 64 chunks, and the handler never ran`);
  // The bytes as sent: a BOM-prefixed body the sender signed verifies.
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(body)]);
  answer = async () => coreOk({ id: "t-bom" });
  r = await on.fetch(new Request("http://api/hooks/example/capture", { method: "POST", body: bom, headers: { "content-type": "application/json", ...sign(bom) } }));
  assert(r.status === 202, `a body signed over its bytes, BOM and all, verifies (${r.status})`);
  // A delivery's id (SMD-2755), over a stand-in for the example's deliveries
  // table (test-plugins-sql runs the real one): claimed before the capture,
  // given back when the capture fails so the sender's retry runs; a resend of
  // a captured one runs nothing, and of one still running is told to retry.
  /** A thought id the stub core answers: a uuid, as onceById records. */
  const thought = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const claims = new Map<string, string | null>();
  /** Unfinished claims past their lease, which the next claim of the id takes. */
  const lapsed = new Set<string>();
  /** Each claim's claimed_at, as the claim returns it and the release matches it. */
  const claimedAt = new Map<string, string>();
  let tick = 0;
  let recordFails = false;
  /** The seconds the last prune and claim were bound: the window and the lease (SMD-2768). */
  let pruneBound: unknown[] = [];
  let leaseBound: unknown;
  const standIn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ").trim();
    const id = values[0] as string;
    if (q.startsWith("DELETE FROM deliveries WHERE claimed_at <")) return Promise.resolve((pruneBound = values, []));
    if (q.startsWith("INSERT INTO deliveries (id) VALUES (?) ON CONFLICT (id) DO UPDATE SET claimed_at = now() WHERE deliveries.thought_id IS NULL AND")) {
      leaseBound = values[1];
      if (!claims.has(id) || (claims.get(id) === null && lapsed.delete(id))) {
        const at = `t${++tick}`;
        return Promise.resolve((claims.set(id, null), claimedAt.set(id, at), [{ claimed: at }]));
      }
      return Promise.resolve([]);
    }
    if (q.startsWith("SELECT thought_id FROM deliveries WHERE id =")) return Promise.resolve(claims.has(id) ? [{ thought_id: claims.get(id) }] : []);
    if (q.startsWith("DELETE FROM deliveries WHERE id = ? AND thought_id IS NULL AND claimed_at = ?::timestamptz")) return Promise.resolve((claims.get(id) === null && claimedAt.get(id) === values[1] && claims.delete(id), []));
    if (q.startsWith("INSERT INTO deliveries (id, thought_id) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET thought_id =")) {
      if (recordFails) return Promise.reject(new Error("connection reset"));
      return Promise.resolve((claims.set(id, values[1] as string), []));
    }
    throw new Error(`the stand-in table has no answer for: ${q}`);
  };
  const tableCore = new Proxy({}, { get: (_t, prop) => (prop === "pluginTx" ? async (_p: string, fn: (sql: typeof standIn) => Promise<unknown>) => fn(standIn) : prop === "captureSeconds" ? () => 300 : (core as unknown as Record<string | symbol, unknown>)[prop]) }) as unknown as Core;
  const withIds = hookApp("example", `example=${SECRET}`, tableCore);
  const send = (id: string) => { const b = JSON.stringify({ id, text: `delivery ${id}` }); return deliver(withIds, b, sign(b)); };
  const captures = () => calls.filter((c) => c.name === "capture").length;
  calls.length = 0;
  answer = async () => coreOk({ id: thought(1) });
  r = await send("evt-1");
  assert(r.status === 202 && ((await r.json()) as { id?: string }).id === thought(1) && claims.get("evt-1") === thought(1), "a delivery with an id: 202, its id kept with its thought");
  assert(JSON.stringify(pruneBound) === '[660,360,""]' && leaseBound === 360, `its window eleven minutes, its lease the core's capture deadline (300 s here) and a minute, through the REST app (${JSON.stringify(pruneBound)}, ${leaseBound})`);
  r = await send("evt-1");
  const dup = (await r.json()) as { id?: string; duplicate?: boolean };
  assert(r.status === 200 && dup.id === thought(1) && dup.duplicate === true && captures() === 1, `the same delivery again: 200, the same thought, a duplicate — and capture ran once (${r.status} ${JSON.stringify(dup)}, ${captures()} captures)`);
  answer = async () => coreRefuse({ code: "REFUSED", retryable: false, reason: "x" } as never);
  r = await send("evt-2");
  assert(r.status === 422 && !claims.has("evt-2"), "a capture the core refuses gives its claim back");
  answer = async () => { throw new Error("embedder down"); };
  r = await send("evt-3");
  assert(r.status === 500 && !claims.has("evt-3"), "a capture that throws gives its claim back too");
  answer = async () => coreOk({ id: thought(2) });
  calls.length = 0;
  r = await send("evt-2");
  const retried = r.status;
  r = await send("evt-3");
  assert(retried === 202 && r.status === 202 && captures() === 2, `so the sender's retries run, and capture (${retried}, ${r.status}, ${captures()} captures)`);
  claims.set("evt-4", null);
  calls.length = 0;
  r = await send("evt-4");
  const busy = (await r.json()) as { code?: string; retryable?: boolean };
  assert(r.status === 409 && busy.code === "IN_FLIGHT" && busy.retryable === true && captures() === 0, `a delivery whose first is still running: 409 IN_FLIGHT, retryable, nothing run (${r.status} ${JSON.stringify(busy)})`);
  lapsed.add("evt-4");
  r = await send("evt-4");
  assert(r.status === 202 && captures() === 1 && claims.get("evt-4") === thought(2), `one whose claim outlived its lease — the server stopped mid-capture — is taken and captured (${r.status}, ${captures()} captures)`);
  recordFails = true;
  r = await send("evt-5");
  recordFails = false;
  assert(r.status === 202 && ((await r.json()) as { id?: string }).id === thought(2), `a capture whose record fails is still the sender's 202: the thought is there (${r.status})`);
  // A first attempt that outlives its lease and then fails gives back its own claim, not the retry's that took it.
  let failFirst: (e: Error) => void = () => {};
  answer = () => new Promise((_ok, fail) => { failFirst = fail; });
  const slow = send("evt-7");
  /** Waits for the stand-in to reach a state, and fails rather than hangs if the handler never gets there. */
  const until = async (what: string, done: () => boolean) => {
    for (let i = 0; !done(); i++) {
      if (i > 2000) throw new Error(`evt-7: ${what} never happened`);
      await Bun.sleep(1);
    }
  };
  await until("the first claim", () => claims.get("evt-7") === null);
  lapsed.add("evt-7");
  let finishRetry: (v: unknown) => void = () => {};
  answer = () => new Promise((ok) => { finishRetry = ok; });
  const retry = send("evt-7");
  await until("the retry's claim", () => !lapsed.has("evt-7"));
  failFirst(new Error("embedder timed out"));
  /** An answer awaited with a deadline, so a regression fails the suite rather than hanging it. */
  const within = (what: string, answer: Response | Promise<Response>) =>
    Promise.race([answer, Bun.sleep(5000).then(() => { throw new Error(`evt-7: ${what} never answered`); })]);
  r = await within("the first attempt", slow);
  assert(r.status === 500 && claims.has("evt-7") && claims.get("evt-7") === null, `the first attempt's late failure leaves the retry's claim standing (${r.status})`);
  finishRetry(coreOk({ id: thought(3) }));
  r = await within("the retry", retry);
  assert(r.status === 202 && claims.get("evt-7") === thought(3), `and the retry records its thought (${r.status})`);
  answer = async () => coreRefuse({ code: "EMBEDDING_NOT_ATTACHED", retryable: true, id: "t-x", detail: "d" });
  r = await send("evt-6");
  const later = (await r.json()) as { code?: string; retryable?: boolean; refused?: string };
  assert(r.status === 503 && later.retryable === true && later.refused === "EMBEDDING_NOT_ATTACHED" && !claims.has("evt-6"), `a refusal the core says is retryable: 503, retryable, the claim given back (${r.status} ${JSON.stringify(later)})`);
  answer = async () => coreOk({ thoughts: [] });
  // A handler's answer the REST core will not pass on.
  const odd = definePlugin({ name: "probe-kit", title: "P", description: "D", operations: { x: operation({ title: "t", description: "d", scope: "read", method: "GET", path: "/x", input: {}, output: {}, handler: async () => ok({}) }) },
    hooks: { teapot: { description: "Answers a status no sender reads.", handler: async () => ({ status: 418 as never }) }, list: { description: "Answers an array.", handler: async () => ({ status: 200, body: [] as never }) } } });
  const oddApp = createRestApp({ core, init: () => {}, keys: () => ({}), resolve: async () => identity, track: (run) => run(), log: () => {},
    plugins: () => loadPlugins("probe-kit", [odd]), hooks: () => ({ hooks: enabledHooks(loadPlugins("probe-kit", [odd]), "probe-kit"), secrets: new Map([["probe-kit", "s"]]) }) });
  r = await oddApp.fetch(new Request("http://api/hooks/probe-kit/teapot", { method: "POST", body: "{}" }));
  assert(r.status === 500, "a hook answering a status no sender reads is the plugin's fault: 500");
  r = await oddApp.fetch(new Request("http://api/hooks/probe-kit/list", { method: "POST", body: "{}" }));
  assert(r.status === 500, "a hook answering a body that is no JSON object: 500");
}

console.log("\n[12] verifyTimestamped: the HMAC over prefix, timestamp, separator and body; a time outside the tolerance refused, and only once signed (SMD-2755)");
{
  const KEY = "8f42a73054b1749f8f58848be5e6502c";
  const at = 1_700_000_000;
  const req = (headers: Record<string, string>, text = '{"token":"x"}'): HookRequest => ({ headers, query: {}, body: new TextEncoder().encode(text), text });
  // Slack's documented example: v0=HMAC(secret, "v0:<ts>:<body>").
  const slack = { signatureHeader: "X-Slack-Signature", timestampHeader: "X-Slack-Request-Timestamp", prefix: "v0:", separator: ":", signaturePrefix: "v0=" };
  const slackBody = "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
  const slackSent = req({ "x-slack-request-timestamp": "1531420618", "x-slack-signature": "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503" }, slackBody);
  const slackAt = 1531420618 * 1000;
  const SLACK_DOC_SECRET = "8f742231b10e8888abcd99yyyzzz85a5"; // Slack's "Verifying requests from Slack" example, public
  assert(JSON.stringify(verifyTimestamped(slackSent, SLACK_DOC_SECRET, slack, slackAt)) === '{"ok":true,"timestamp":1531420618}', "Slack's documented signed request verifies in Slack's form, the header names in any case");
  assert(verifyTimestamped(slackSent, SLACK_DOC_SECRET, { ...slack, separator: "." }, slackAt).ok === false, "and not with another separator");
  assert(verifyTimestamped(slackSent, SLACK_DOC_SECRET, { ...slack, prefix: "" }, slackAt).ok === false, "nor without the v0: prefix");
  const v = (headers: Record<string, string>, now = at * 1000, tolerance?: number) => verifyTimestamped(req(headers), KEY, { signatureHeader: "x-sig", timestampHeader: "x-ts", ...(tolerance ? { toleranceSeconds: tolerance } : {}) }, now);
  const sig = (ts: string, text = '{"token":"x"}') => hmacSha256Hex(KEY, `${ts}.${text}`);
  assert(v({ "x-ts": String(at), "x-sig": sig(String(at)) }).ok, "the plain form: HMAC of <ts>.<body>, hex");
  assert(v({ "x-ts": String(at), "x-sig": sig(String(at)).toUpperCase() }).ok, "upper-case hex is the same signature");
  const reason = (x: ReturnType<typeof v>) => (x.ok ? "ok" : x.code);
  assert(reason(v({ "x-sig": sig(String(at)) })) === "NO_TIMESTAMP", "no timestamp: NO_TIMESTAMP");
  for (const ts of ["", "17e8", "-1", " 1700000000", "1700000000.5", "1".repeat(13)]) assert(reason(v({ "x-ts": ts, "x-sig": sig(ts) })) === "NO_TIMESTAMP", `a timestamp that is not Unix seconds, ${JSON.stringify(ts)}: NO_TIMESTAMP, though signed`);
  assert(reason(v({ "x-ts": String(at) })) === "BAD_SIGNATURE", "no signature: BAD_SIGNATURE");
  assert(reason(v({ "x-ts": String(at), "x-sig": sig(String(at + 1)) })) === "BAD_SIGNATURE", "a signature over another time: BAD_SIGNATURE");
  assert(reason(v({ "x-ts": String(at), "x-sig": sig(String(at), '{"token":"y"}') })) === "BAD_SIGNATURE", "a signature over another body: BAD_SIGNATURE");
  assert(reason(v({ "x-ts": String(at), "x-sig": `v0=${sig(String(at))}` })) === "BAD_SIGNATURE", "a prefix the scheme does not name: BAD_SIGNATURE");
  const old = String(at - 300);
  const soon = String(at + 300);
  assert(v({ "x-ts": old, "x-sig": sig(old) }).ok && v({ "x-ts": soon, "x-sig": sig(soon) }).ok, "300 s old, or 300 s ahead, the default tolerance: verified");
  const older = String(at - 301);
  assert(reason(v({ "x-ts": older, "x-sig": sig(older) })) === "STALE_DELIVERY", "301 s old: STALE_DELIVERY");
  const ahead = String(at + 301);
  assert(reason(v({ "x-ts": ahead, "x-sig": sig(ahead) })) === "STALE_DELIVERY", "301 s ahead of the clock: STALE_DELIVERY");
  assert(reason(v({ "x-ts": older, "x-sig": sig(older, "other") })) === "BAD_SIGNATURE", "a stale time on a delivery the secret did not sign: BAD_SIGNATURE, never STALE — the sender learns nothing of the clock");
  assert(v({ "x-ts": older, "x-sig": sig(older) }, at * 1000, 400).ok && reason(v({ "x-ts": String(at - 61), "x-sig": sig(String(at - 61)) }, at * 1000, 60)) === "STALE_DELIVERY", "the tolerance is the scheme's to set");
  let thrown = "";
  try { v({ "x-ts": String(at), "x-sig": sig(String(at)) }, at * 1000, -5); } catch (e) { thrown = (e as Error).message; }
  assert(/toleranceSeconds -5 is not a positive number/.test(thrown), "a tolerance that is no positive number is the plugin's fault: thrown");
}

console.log("\n[13] onceById: its lease the core's own capture deadline and a minute, so a raised OB1_LLM_TIMEOUT lengthens it; what it binds, gives back and refuses (SMD-2768)");
{
  /** captureSeconds as a core over `env` reads it: no store, which the deadline never asks for. */
  const deadline = (env: Record<string, string>) => createCore({ env: () => env as never, store: () => Promise.reject(new Error("no store")), door: "test" }).captureSeconds();
  assert(deadline({}) === 120, `by default one round of model calls at OB1_LLM_TIMEOUT's 120 s (${deadline({})})`);
  assert(deadline({ OB1_LLM_TIMEOUT: "600" }) === 600, `OB1_LLM_TIMEOUT=600: 600 s (${deadline({ OB1_LLM_TIMEOUT: "600" })})`);
  assert(deadline({ OB1_LLM_TIMEOUT: "600", OB1_CHUNK_CONTEXT: "on" }) === 1200, "with OB1_CHUNK_CONTEXT on, two rounds: a long text's windows are blurbed, then embedded");
  assert(deadline({ OB1_LLM_TIMEOUT: "10", OB1_JEV_BASE_URL: "http://jev:8080" }) === 31, "the genre tier's deadline, 30 s and 1 s for its one decision, when it is the longer");
  assert(deadline({ OB1_LLM_TIMEOUT: "10", OB1_CHUNK_CONTEXT: "on", OB1_JEV_BASE_URL: "http://jev:8080" }) === 31, "and with chunk context on, still the longer of the two: the tier runs beside both rounds, once");
  /** A handle that records each statement's bound values, and answers a claim with `claimed`. */
  const bound: { q: string; values: unknown[] }[] = [];
  let claimed: { claimed: string }[] = [{ claimed: "2026-10-09 20:00:00.123456+00" }];
  const record = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ").trim();
    bound.push({ q, values });
    return Promise.resolve(q.includes("RETURNING claimed_at") ? claimed : q.startsWith("SELECT thought_id") ? [{ thought_id: null }] : []);
  }) as unknown as PluginSql;
  const db = { tx: <T>(fn: (sql: PluginSql) => Promise<T>) => fn(record) };
  const T1 = "00000000-0000-4000-8000-000000000001";
  const leaseOf = () => bound.find((b) => b.q.startsWith("INSERT INTO deliveries (id) VALUES"))?.values[1];
  const done = await onceById({ db, captureSeconds: deadline({ OB1_LLM_TIMEOUT: "600" }) }, "evt-1", async () => ({ value: "v", thoughtId: T1 }), { keepSeconds: 660 });
  assert(JSON.stringify(done) === '{"ran":"v"}' && leaseOf() === 660 && JSON.stringify(bound[0].values) === '[660,660,""]', `with OB1_LLM_TIMEOUT=600, the lease is 660 s, longer than one capture's model calls, and the prune keeps a claim that long (${leaseOf()}, ${JSON.stringify(bound[0].values)})`);
  assert(bound.at(-1)?.q.startsWith("INSERT INTO deliveries (id, thought_id)") === true && JSON.stringify(bound.at(-1)?.values) === `["evt-1","${T1}"]`, "the run's thought is recorded against its id");
  bound.length = 0;
  await onceById({ db, captureSeconds: 120.3 }, "evt-2", async () => ({ value: "v", thoughtId: null }), { keepSeconds: 660 });
  assert(leaseOf() === 181, `a fractional deadline is rounded up, whole seconds bound (${leaseOf()})`);
  assert(bound.at(-1)?.q.startsWith("DELETE FROM deliveries WHERE id = ? AND thought_id IS NULL AND claimed_at = ?::timestamptz") === true && JSON.stringify(bound.at(-1)?.values) === '["evt-2","2026-10-09 20:00:00.123456+00"]', "a run that hands back no thought gives back its own claim, by the claimed_at text the claim returned");
  bound.length = 0;
  await onceById({ db, captureSeconds: 120 }, "evt-3", async () => ({ value: "v", thoughtId: T1 }), { keepSeconds: 660, leaseSeconds: 30 });
  assert(leaseOf() === 30, "a lease the plugin names is its own");
  bound.length = 0;
  await onceById({ db, captureSeconds: 120 }, "evt-6", async () => ({ value: "v", thoughtId: T1 }), { keepSeconds: Infinity });
  assert(!bound.some((b) => b.q.startsWith("DELETE FROM deliveries WHERE claimed_at")) && leaseOf() === 180, "keepSeconds Infinity, for a sender that signs no time: nothing pruned, the lease as ever");
  bound.length = 0;
  let notUuid = "";
  try { await onceById({ db, captureSeconds: 120 }, "evt-7", async () => ({ value: "v", thoughtId: "U024BE7LH-1531420618" }), { keepSeconds: 660 }); } catch (e) { notUuid = (e as Error).message; }
  assert(/a uuid, or null/.test(notUuid) && !bound.some((b) => b.q.startsWith("DELETE FROM deliveries WHERE id = ?") || b.q.startsWith("INSERT INTO deliveries (id, thought_id)")),
    `a run that hands back no thought id of the core's (a sender's own id) is thrown, nothing recorded, and its claim kept: a resend is 409 until the lease, not run again (${notUuid})`);
  bound.length = 0;
  await onceById({ db, captureSeconds: 120 }, "Ev0123", async () => ({ value: "v", thoughtId: T1 }), { keepSeconds: 660, scope: "events" });
  const scoped = bound.find((b) => b.q.startsWith("DELETE FROM deliveries WHERE claimed_at"))?.values;
  assert(JSON.stringify(scoped) === '[660,180,"events"]' && bound.slice(1).every((b) => b.values[0] === "events Ev0123"),
    `a scope: its ids kept as "<scope> <id>", and its prune held to its own scope (${JSON.stringify(scoped)}, ${JSON.stringify(bound.slice(1).map((b) => b.values[0]))})`);
  claimed = [];
  const busy = await onceById({ db, captureSeconds: 120 }, "evt-4", async () => { throw new Error("never run"); }, { keepSeconds: 660 });
  assert(JSON.stringify(busy) === '{"inFlight":true}', `an id claimed and not yet captured: in flight, the run not called (${JSON.stringify(busy)})`);
  const refusedWith = async (id: string, captureSeconds: number, options: Parameters<typeof onceById>[3]) => {
    try {
      await onceById({ db, captureSeconds }, id, async () => ({ value: 0, thoughtId: null }), options);
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };
  bound.length = 0;
  assert(/an id is 1 to 200/.test(await refusedWith("a b", 120, { keepSeconds: 660 })), "an id isDeliveryId refuses is the plugin's fault: thrown");
  assert(/keepSeconds 0 is not a number/.test(await refusedWith("evt-5", 120, { keepSeconds: 0 })) && /keepSeconds NaN is not a number/.test(await refusedWith("evt-5", 120, { keepSeconds: NaN }))
    && /leaseSeconds NaN is not a number/.test(await refusedWith("evt-5", NaN, { keepSeconds: 660 })) && /leaseSeconds 0 is not a number/.test(await refusedWith("evt-5", 120, { keepSeconds: 660, leaseSeconds: 0 }))
    && /leaseSeconds Infinity is not a number/.test(await refusedWith("evt-5", 120, { keepSeconds: 660, leaseSeconds: Infinity })),
    "a window that is no positive number or Infinity, or a lease that is no positive number, the plugin's own or the default: thrown");
  assert(/keepSeconds 660 is not a number/.test(await refusedWith("evt-5", 120, { keepSeconds: "660" as never })) && /keepSeconds 10000000000 is not/.test(await refusedWith("evt-5", 120, { keepSeconds: 1e10 }))
    && /leaseSeconds 10000000000 is not/.test(await refusedWith("evt-5", 120, { keepSeconds: 660, leaseSeconds: 1e10 })) && /leaseSeconds 9999999940 is not/.test(await refusedWith("evt-5", 9999999880, { keepSeconds: 660 })),
    "a window or lease that is no number, or past 10^9 s (Postgres's timestamps overflow on every claim at about 2 × 10^11): thrown");
  assert(/scope "Events" is not/.test(await refusedWith("evt-5", 120, { keepSeconds: 660, scope: "Events" })) && /scope "a b" is not/.test(await refusedWith("evt-5", 120, { keepSeconds: 660, scope: "a b" }))
    && /scope "x{33}" is not/.test(await refusedWith("evt-5", 120, { keepSeconds: 660, scope: "x".repeat(33) })) && /an id is 1 to 200/.test(await refusedWith("", 120, { keepSeconds: 660, scope: "events" })),
    "a scope that is not lower-case words and hyphens of at most 32 characters, or an empty id under one: thrown");
  assert(bound.length === 0, `and each before any claim: no statement run (${bound.length})`);
  assert(isDeliveryId("evt-1") && isDeliveryId("~".repeat(200)) && ![undefined, 5, "", "a b", "caf\u00e9", "\ud800", "x".repeat(201)].some((v) => isDeliveryId(v)), "isDeliveryId: 1 to 200 characters from ! to ~");
  assert(isDeliveryId("x".repeat(193), "events") && !isDeliveryId("x".repeat(194), "events") && !isDeliveryId("", "events"), "under a scope, an id leaves room for it and its space; an empty one is still refused");
  // With defer (SMD-2767): the claim made and answered now, the run, its record and its release left to ctx.defer.
  const left: (() => Promise<unknown>)[] = [];
  const deferring = { db, captureSeconds: 120, defer: (work: () => Promise<unknown>) => { left.push(work); } };
  claimed = [{ claimed: "2026-10-09 21:00:00.5+00" }];
  bound.length = 0;
  let runs = 0;
  const now = await onceById(deferring, "evt-8", async () => ({ value: ++runs, thoughtId: T1 }), { keepSeconds: 660, defer: true });
  assert(JSON.stringify(now) === '{"deferred":true}' && runs === 0 && left.length === 1 && !bound.some((b) => b.q.startsWith("INSERT INTO deliveries (id, thought_id)")),
    `with defer: answered deferred once the id is claimed, the run not yet started and nothing recorded (${JSON.stringify(now)}, ${runs} runs)`);
  await left[0]();
  assert(runs === 1 && bound.at(-1)?.q.startsWith("INSERT INTO deliveries (id, thought_id)") === true, "the deferred run records its thought against the id, as an awaited one does");
  bound.length = 0;
  await onceById(deferring, "evt-9", async () => { throw new Error("embedder down"); }, { keepSeconds: 660, defer: true });
  const deferredThrow = await left[1]().then(() => "", (e: Error) => e.message);
  assert(deferredThrow === "embedder down" && bound.at(-1)?.q.startsWith("DELETE FROM deliveries WHERE id = ?") === true, `a deferred run that throws gives its claim back and throws on, for ctx.defer to log (${deferredThrow})`);
  claimed = [];
  const busyDeferred = await onceById(deferring, "evt-10", async () => ({ value: 0, thoughtId: T1 }), { keepSeconds: 660, defer: true });
  assert(JSON.stringify(busyDeferred) === '{"inFlight":true}' && left.length === 2, "an id still running is in flight with defer too, and nothing is deferred");
  bound.length = 0;
  const noDefer = await refusedWith("evt-11", 120, { keepSeconds: 660, defer: true } as never);
  assert(/defer needs the hook's ctx.defer/.test(noDefer) && bound.length === 0, `defer with no ctx.defer to hand: thrown before any claim (${noDefer})`);
}

console.log("\n[14] ctx.defer: a hook answers before its work ends; the work counted for the stop, and its failure one fault line, never a stopped server (SMD-2767)");
{
  const tracked: Promise<unknown>[] = [];
  const faults: string[] = [];
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => { open = resolve; });
  let ran = 0;
  const probe = definePlugin({ name: "probe-defer", title: "P", description: "D", operations: { x: operation({ title: "t", description: "d", scope: "read", method: "GET", path: "/x", input: {}, output: {}, handler: async () => ok({}) }) },
    hooks: {
      later: { description: "Answers at once, its work failing afterwards.", handler: async (ctx) => { ctx.defer(async () => { await gate; ran++; throw new Error("embedder\n  timed out"); }); return { status: 202, body: { accepted: true } }; } },
      sync: { description: "Defers work that throws before its first await.", handler: async (ctx) => { ctx.defer((() => { throw new Error("at once"); }) as never); return { status: 202 }; } },
      fine: { description: "Defers work that succeeds.", handler: async (ctx) => { ctx.defer(async () => { ran++; }); return { status: 202 }; } },
      promise: { description: "Hands defer a promise, not a function.", handler: async (ctx) => { ctx.defer(Promise.resolve() as never); return { status: 202 }; } },
    } });
  const deferApp = createRestApp({ core, init: () => {}, keys: () => ({}), resolve: async () => identity, log: () => {}, faultLog: (l) => faults.push(l),
    track: (run) => { const p = run(); tracked.push(p); return p; },
    plugins: () => loadPlugins("probe-defer", [probe]), hooks: () => ({ hooks: enabledHooks(loadPlugins("probe-defer", [probe]), "probe-defer"), secrets: new Map([["probe-defer", "s"]]) }) });
  const post = (hook: string) => deferApp.fetch(new Request(`http://api/hooks/probe-defer/${hook}`, { method: "POST", body: "{}" }));
  let r = await post("later");
  assert(r.status === 202 && ran === 0 && faults.length === 0 && tracked.length === 1, `answered 202 before its deferred work ran, the work counted by the stop's tracker (${r.status}, ${tracked.length} tracked)`);
  open();
  await Promise.all(tracked);
  assert(ran === 1 && JSON.stringify(faults) === '["api hook /hooks/probe-defer/later deferred fault: embedder timed out"]', `the work's failure: one fault line, bounded and on one line (${JSON.stringify(faults)})`);
  r = await post("later");
  await Promise.all(tracked);
  assert(r.status === 202 && ran === 2 && faults.length === 2, `and the server answers on: the failure stopped nothing (${r.status}, ${faults.length} faults)`);
  r = await post("sync");
  await Promise.all(tracked);
  assert(r.status === 202 && faults.at(-1) === "api hook /hooks/probe-defer/sync deferred fault: at once", `work that throws before its first await is caught all the same (${faults.at(-1)})`);
  r = await post("fine");
  await Promise.all(tracked);
  assert(r.status === 202 && ran === 3 && faults.length === 3, "work that succeeds writes no line");
  r = await post("promise");
  assert(r.status === 500 && /ctx\.defer takes a function/.test(faults.at(-1) ?? ""), `a promise handed to defer, already running outside the tracker, is the plugin's fault: 500 (${faults.at(-1)})`);
}

report();
