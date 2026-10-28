// The REST core's OpenAPI document (SMD-2284), built from the same two
// sources its routes are: each tool's zod schema (core/schemas.ts) and its
// route (routes.ts). Nothing here is written by hand per operation, so a tool
// in the manifest is in the document, with the input its route parses.

import { z } from "zod";
import { SPECS } from "../core/index.ts";
import { scopeOf, type ToolName } from "../tools.ts";
import { FORK_VERSION } from "../version.ts";
import { pathFields, readsQuery, REFUSAL_STATUS, ROUTES } from "./routes.ts";
import type { LoadedOp } from "../core/index.ts";

type Json = Record<string, unknown>;

/** A tool's input as JSON Schema, the fields `omit` names left out (they ride the path). */
function inputSchema(name: ToolName, omit: string[]): Json {
  const shape = Object.fromEntries(Object.entries(SPECS[name].inputSchema).filter(([k]) => !omit.includes(k)));
  const js = z.toJSONSchema(z.object(shape).strict(), { io: "input", unrepresentable: "any" }) as Json;
  delete js.$schema;
  return js;
}

const refusal = (description: string) => ({ description, content: { "application/json": { schema: { $ref: "#/components/schemas/Refusal" } } } });
/** A caller's key in one of its three headers — alone, or forwarded with the forwarder slot beside it (SMD-2284). */
const CALLER_FORMS = [{ brainKey: [] }, { accessKey: [] }, { bearer: [] }];
const KEYED = [...CALLER_FORMS, ...CALLER_FORMS.map((form) => ({ ...form, forwarder: [] }))];

/** Which refusal codes answer each status (REFUSAL_STATUS), so the document says what a client may see under each. */
const codesAt = (status: number): string => Object.entries(REFUSAL_STATUS).filter(([, s]) => s === status).map(([code]) => code).join(", ");
/** The answers every keyed operation may give besides its success: the caller's standing, the input, a refusal by its status, a fault. */
const KEYED_ANSWERS = {
  "400": refusal(`The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: ${codesAt(400)}.`),
  "401": refusal("No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED, naming the key as `name` where the forwarder slot holds a forward-scope key); with `credential: \"forwarder\"`, the forwarder slot held something other than a forward-scope key, or a revoked one; with `credential: \"token\"` (and `WWW-Authenticate: Bearer error=\"invalid_token\"`), a bearer token that is not one the authorization server issued for this REST core (SMD-2286); and REVOKED with `credential: \"token\"`, a token whose subject the agent registry revoked, which no new sign-in clears."),
  "403": refusal(`The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), or a bearer token's scopes name no key scope (FORBIDDEN with \`credential: "token"\`, \`WWW-Authenticate: Bearer error="insufficient_scope"\`); or a rule: ${codesAt(403)}.`),
  "404": refusal(`Nothing there: ${codesAt(404)}.`),
  "409": refusal(`The state conflicts: ${codesAt(409)}.`),
  "422": refusal(`A reference to nothing, or a refusal the store named: ${codesAt(422)}.`),
  "405": refusal("A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does."),
  "500": refusal("A fault (FAILED, with its message; no retryable until SMD-2461)."),
  "501": refusal(`A mode not built: ${codesAt(501)}.`),
  "503": { ...refusal(`Retry, after Retry-After: the agent registry is busy (BUSY, naming the caller's key as \`name\` to a forwarder; with \`credential: "forwarder"\` on the forwarder's lookup), capture's store fault (STORE_UNAVAILABLE), a bearer token while the authorization server's keys cannot be read (BUSY with \`credential: "token"\`, Retry-After 30), or ${codesAt(503)}.`), headers: { "Retry-After": { description: "Seconds to wait before retrying.", schema: { type: "integer" } } } },
};
/** A keyed operation's answers: every one of KEYED_ANSWERS but 501, which only an operation with a mode not built (run_worker's drain) gives. */
const answersFor = (name: ToolName) => {
  const { "501": notBuilt, ...rest } = KEYED_ANSWERS;
  return name === "run_worker" ? { ...rest, "501": notBuilt } : rest;
};

/** A zod object as JSON Schema, as the document states it: `io` the side of the parse it describes. */
function jsonSchemaOf(schema: z.ZodType, io: "input" | "output"): Json {
  const js = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as Json;
  delete js.$schema;
  return js;
}

/** The answers a plugin operation may give besides its success: as a core operation's, but a plugin's own refusal codes at 400–422 and no 501. */
const PLUGIN_ANSWERS = {
  "400": refusal("The input does not fit the schema (REFUSED_INPUT), or the plugin's own refusal."),
  "401": KEYED_ANSWERS["401"],
  "403": refusal("The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs), a bearer token's scopes name no key scope (FORBIDDEN with `credential: \"token\"`), or the plugin's own refusal."),
  "404": refusal("The plugin's own refusal: nothing there."),
  "405": KEYED_ANSWERS["405"],
  "409": refusal("The plugin's own refusal: the state conflicts."),
  "422": refusal("The plugin's own refusal."),
  "500": KEYED_ANSWERS["500"],
  "503": KEYED_ANSWERS["503"],
};

/**
 * The document: every core operation, then the enabled plugins' (SMD-2310) —
 * each under its plugin's tag, its scope as a core operation's, and its
 * success described by the output schema its manifest declares.
 */
export function openApiDocument(plugins: readonly LoadedOp[] = []): Json {
  const paths: Record<string, Record<string, Json>> = {};
  for (const op of plugins) {
    const fields = pathFields(op.path);
    const input = jsonSchemaOf(z.object(Object.fromEntries(Object.entries(op.shape).filter(([k]) => !fields.includes(k)))).strict(), "input");
    const props = (input.properties ?? {}) as Record<string, Json>;
    const required = new Set((input.required ?? []) as string[]);
    const parameters: Json[] = fields.map((f) => ({ name: f, in: "path", required: true, schema: { type: "string" } }));
    if (readsQuery(op.method)) {
      for (const [field, schema] of Object.entries(props)) parameters.push({ name: field, in: "query", required: required.has(field), schema });
    }
    paths[op.path] ??= {};
    paths[op.path][op.method.toLowerCase()] = {
      operationId: op.tool,
      summary: op.title,
      description: op.description,
      tags: [`plugin:${op.plugin}`],
      "x-ob1-scope": op.scope,
      "x-ob1-plugin": op.plugin,
      ...(parameters.length ? { parameters } : {}),
      ...(readsQuery(op.method) ? {} : { requestBody: { required: required.size > 0, content: { "application/json": { schema: input } } } }),
      responses: {
        "200": { description: "The operation's value.", content: { "application/json": { schema: jsonSchemaOf(op.output, "output") } } },
        ...PLUGIN_ANSWERS,
      },
      security: KEYED,
    };
  }
  for (const name of Object.keys(ROUTES) as ToolName[]) {
    const route = ROUTES[name];
    const spec = SPECS[name];
    const fields = pathFields(route.path);
    const input = inputSchema(name, fields);
    const props = (input.properties ?? {}) as Record<string, Json>;
    const required = new Set((input.required ?? []) as string[]);
    const parameters: Json[] = fields.map((f) => ({ name: f, in: "path", required: true, schema: { type: "string" } }));
    if (readsQuery(route.method)) {
      for (const [field, schema] of Object.entries(props)) parameters.push({ name: field, in: "query", required: required.has(field), schema });
    }
    paths[route.path] ??= {};
    paths[route.path][route.method.toLowerCase()] = {
      operationId: name,
      summary: spec.title,
      // The tool's own words, but a job's links: an MCP client polls the
      // MCP server's /jobs, a REST client this server's /v1/jobs.
      description: spec.description.replace(/GET \/jobs\//g, "GET /v1/jobs/"),
      "x-ob1-scope": scopeOf(name),
      ...(parameters.length ? { parameters } : {}),
      ...(readsQuery(route.method) ? {} : { requestBody: { required: required.size > 0, content: { "application/json": { schema: input } } } }),
      responses: {
        [String(route.ok)]: { description: name === "capture_thought" ? "The thought, with `embeddingAttached` — whether this capture wrote its vector with the row (false when the egress gate refused the embedding call, or the provider did not answer it — `vectorFailed`, a reader's with the endpoint and what happened there, and its word alone for a key that cannot read); on a re-capture, false says this capture wrote none, not that the row has none; on a re-capture over a capture-only key's label, `label` says what it did — `outcome` moved, kept, settled or unweighed, `stamp` the label after (`actorKind`, `actorName`, `trust`), and `before`, `weighed` and `own`, `by` and `mine`, or `decliner` and `declinerWeighed` by outcome (migration 090); with a `client_key` (SMD-3314, migration 112), `keyed` says what became of it — `matched` (a thought already had it as its id or its key: that thought, nothing written, no model call, still 201), `recaptured` (that thought holds this very text: a re-capture of it, the key not sent again), `recorded` (the row keeps it) or `held` (the text's row keeps another key, `heldKey` when it is a key's shape, and this one names nothing); a key that cannot read is told its id, `embeddingCall`, `chunks`, `contextFailures`, `vectorFailed` and `embeddingAttached` alone — carried by a forwarder, the whole value, which the MCP server words for that key." : name === "search" || name === "search_thoughts" ? "The operation's value; with `vectorFailed` — the provider's marker word, what happened there and its endpoint — when the embedding provider did not answer for the query, and the results are its exact matches alone — the query's literals, then the query as one text, or nothing it could match (`vectorFailed.matched`: literals, text or none; SMD-2891). A text match's hits carry the text as their one needle, its count bounded: 1001 means more than 1000. With nothing found then, `search` is refused EMBEDDING_PROVIDER_UNAVAILABLE (503) and `search_thoughts` answers its `facts`: a needle counted 0 is held by no thought; one counted above 0 is held only outside the search's filter, said_by, actor or min_trust (1001: more than 1000); a common needle is held by more thoughts than one keyword page; a needle may be the whole query text when that was what was matched; none at all, with `matched` none, means nothing could be matched." : name === "list_thoughts" ? "A page (SMD-2995): `thoughts`, each with `supersededBy` (the id of a thought that supersedes it, or null); `sort`, the order they are in (newest or oldest); and `cursor` — pass it as the `after` query parameter, with the same `sort` and filters, for the next page; null when no more follow. A cursor that is none of this operation's, or an empty one, is refused REFUSED_CURSOR (400) with `reason: \"shape\"`; one made under the other sort with `reason: \"sort\"` and the `sort` it was made under." : name === "list_supersession_proposals" ? "A page (SMD-3249): `proposals`, most confident first; `cursor` — pass it as the `after` query parameter, with the same status, lineage and judge_key, for the next page; null when no more follow; `remaining`, how many follow this page; and `pastCursor`, whether this page followed a cursor. A cursor that is none of this operation's, an empty one, or one whose time Postgres cannot read is refused REFUSED_CURSOR (400) with `reason: \"shape\"`; one made under other filters with `reason: \"filters\"` and `made`, the `status`, `lineage` and `judgeKey` it was made under." : "The operation's value.", content: { "application/json": { schema: { type: "object" } } } },
        ...answersFor(name),
      },
      security: KEYED,
    };
  }
  paths["/v1/whoami"] = { get: { operationId: "whoami", summary: "Who is calling", description: "The key's name, its scope, its stable agent id and the operations it may call; forwarded, `act` names who carried it (the forwarder key's name and agent id).", responses: { "200": { description: "The caller.", content: { "application/json": { schema: { type: "object" } } } }, "401": KEYED_ANSWERS["401"], "403": refusal("A bearer token whose scopes name no key scope (FORBIDDEN with `credential: \"token\"`, `WWW-Authenticate: Bearer error=\"insufficient_scope\"`)."), "405": KEYED_ANSWERS["405"], "500": KEYED_ANSWERS["500"], "503": KEYED_ANSWERS["503"] }, security: KEYED } };
  // The enabled plugins, for the operator GUI's nav (SMD-2310).
  const page = { type: "object", required: ["path", "label"], properties: { path: { type: "string" }, label: { type: "string" } } };
  const plugin = { type: "object", required: ["name", "title", "description", "pages", "operations"], properties: { name: { type: "string" }, title: { type: "string" }, description: { type: "string" }, pages: { type: "array", items: page }, operations: { type: "array", items: { type: "string" } } } };
  paths["/v1/plugins"] = { get: { operationId: "plugins", summary: "The enabled plugins", description: "Each enabled plugin: its name, title and description, its GUI pages (a path under the plugin's and a nav label) and the operations of it this key may call — what the operator GUI's nav reads.", responses: { "200": { description: "The enabled plugins.", content: { "application/json": { schema: { type: "object", required: ["plugins"], properties: { plugins: { type: "array", items: plugin } } } } } }, "401": KEYED_ANSWERS["401"], "403": refusal("A bearer token whose scopes name no key scope (FORBIDDEN with `credential: \"token\"`, `WWW-Authenticate: Bearer error=\"insufficient_scope\"`)."), "405": KEYED_ANSWERS["405"], "500": KEYED_ANSWERS["500"], "503": KEYED_ANSWERS["503"] }, security: KEYED } };
  paths["/v1/jobs/{job_id}/stream"] = { get: { operationId: "job_stream", summary: "A job's events", description: "The job's progress and its end as server-sent events, for the key that started it.", parameters: [{ name: "job_id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "An event stream.", content: { "text/event-stream": {} } }, "401": KEYED_ANSWERS["401"], "403": KEYED_ANSWERS["403"], "404": refusal("No such job for this key."), "405": KEYED_ANSWERS["405"], "500": KEYED_ANSWERS["500"], "503": KEYED_ANSWERS["503"] }, security: KEYED } };
  paths["/health"] = { get: { operationId: "health", summary: "Liveness, and the brain's record for a key that may read it", description: "Internal only: the process is serving, `{ status: \"ok\" }`. With a key that may read brain_info, which the agent registry clears within the deadline, the brain's record on the health surface instead — what the MCP server's public /health shows (SMD-2287). Any other key is answered liveness, as no key is: this route refuses no one.", responses: { "200": { description: "Serving: `{ status: \"ok\" }`, or the brain's record.", content: { "application/json": { schema: { type: "object" } } } }, "405": KEYED_ANSWERS["405"] }, security: [{}, ...CALLER_FORMS] } };
  return {
    openapi: "3.1.0",
    info: { title: "Open Brain REST core", version: FORK_VERSION, description: "Every operation the brain's MCP tools expose, as JSON (SMD-2284). Internal by default; public at /api only where the operator turns it on." },
    paths,
    components: {
      securitySchemes: {
        brainKey: { type: "apiKey", in: "header", name: "x-brain-key" },
        accessKey: { type: "apiKey", in: "header", name: "x-access-key" },
        bearer: { type: "http", scheme: "bearer", description: "A caller's key, or, on a stack configured with the authorization server, an access token it issued for this REST core (`<origin>/api`): the key scope its `brain:` scopes name, the caller `oauth:<sub>+<client>`, the subject and the client it signed in through, or a service's `oauth:<sub>` alone (SMD-2286, SMD-3064)." },
        // Beside a caller's key, never alone: the MCP server's forward-scope key, recorded as the request's `act` (SMD-2284).
        forwarder: { type: "apiKey", in: "header", name: "x-brain-forwarder", description: "A forward-scope key, beside a caller's: names who carried the request (recorded as act); grants nothing — but a request it carries is answered its refusals and its captures whole, the words the MCP server says them in, so it is the MCP server's alone. Read only inside the stack: the public /api route deletes it." },
      },
      schemas: {
        Refusal: { type: "object", required: ["code"], properties: { code: { type: "string" }, retryable: { type: "boolean" }, refusal: { type: "object", description: "Only on a forwarded request (a forward-scope key in x-brain-forwarder): the refusal whole, the words its facts leave out included (the caller's input, the store's) — a plugin's with its status in it — so the MCP server says it as it always has (SMD-2287)." } }, additionalProperties: true },
      },
    },
  };
}
