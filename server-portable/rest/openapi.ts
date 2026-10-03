// The REST core's OpenAPI document (SMD-2284), built from the same two
// sources its routes are: each tool's zod schema (core/schemas.ts) and its
// route (routes.ts). Nothing here is written by hand per operation, so a tool
// in the manifest is in the document, with the input its route parses.

import { z } from "zod";
import { SPECS } from "../core/index.ts";
import { TOOLS, type ToolName } from "../tools.ts";
import { FORK_VERSION } from "../version.ts";
import { pathFields, readsQuery, REFUSAL_STATUS, ROUTES } from "./routes.ts";

type Json = Record<string, unknown>;

/** A tool's input as JSON Schema, the fields `omit` names left out (they ride the path). */
function inputSchema(name: ToolName, omit: string[]): Json {
  const shape = Object.fromEntries(Object.entries(SPECS[name].inputSchema).filter(([k]) => !omit.includes(k)));
  const js = z.toJSONSchema(z.object(shape).strict(), { io: "input", unrepresentable: "any" }) as Json;
  delete js.$schema;
  return js;
}

const refusal = (description: string) => ({ description, content: { "application/json": { schema: { $ref: "#/components/schemas/Refusal" } } } });
const KEYED = [{ brainKey: [] }, { accessKey: [] }, { bearer: [] }];

/** Which refusal codes answer each status (REFUSAL_STATUS), so the document says what a client may see under each. */
const codesAt = (status: number): string => Object.entries(REFUSAL_STATUS).filter(([code, s]) => s === status && code !== "EMBEDDING_NOT_ATTACHED").map(([code]) => code).join(", ");
/** The answers every keyed operation may give besides its success: the caller's standing, the input, a refusal by its status, a fault. */
const KEYED_ANSWERS = {
  "400": refusal(`The input does not fit the schema, or is sent the way the route does not read it (REFUSED_INPUT); or a refusal the caller can mend: ${codesAt(400)}.`),
  "401": refusal("No key, a wrong key (UNAUTHORIZED) or a revoked one (REVOKED)."),
  "403": refusal(`The key's scope does not reach this operation (FORBIDDEN, naming the scope it needs); or a rule: ${codesAt(403)}.`),
  "404": refusal(`Nothing there: ${codesAt(404)}.`),
  "409": refusal(`The state conflicts: ${codesAt(409)}.`),
  "422": refusal(`A reference to nothing, or a refusal the store named: ${codesAt(422)}.`),
  "405": refusal("A method this path does not take (METHOD_NOT_ALLOWED); `Allow` names those it does."),
  "500": refusal("A fault (FAILED, with its message; no retryable until SMD-2461)."),
  "501": refusal(`A mode not built: ${codesAt(501)}.`),
  "503": { ...refusal(`Retry, after Retry-After: the agent registry is busy (BUSY), capture's store fault (STORE_UNAVAILABLE), or ${codesAt(503)}.`), headers: { "Retry-After": { description: "Seconds to wait before retrying.", schema: { type: "integer" } } } },
};
/** A keyed operation's answers: every one of KEYED_ANSWERS but 501, which only an operation with a mode not built (run_worker's drain) gives. */
const answersFor = (name: ToolName) => {
  const { "501": notBuilt, ...rest } = KEYED_ANSWERS;
  return name === "run_worker" ? { ...rest, "501": notBuilt } : rest;
};

export function openApiDocument(): Json {
  const paths: Record<string, Record<string, Json>> = {};
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
      "x-ob1-scope": TOOLS.find((t) => t.name === name)!.scope,
      ...(parameters.length ? { parameters } : {}),
      ...(readsQuery(route.method) ? {} : { requestBody: { required: required.size > 0, content: { "application/json": { schema: input } } } }),
      responses: {
        [String(route.ok)]: { description: name === "capture_thought" ? "The thought, with `embeddingAttached` — whether this capture wrote its vector with the row (false when the egress gate refused the embedding call); on a re-capture, false says this capture wrote none, not that the row has none; a key that cannot read is told its id, `embeddingCall`, `chunks`, `contextFailures` and `embeddingAttached` alone. A save whose vector did not attach (the PostgREST two-step) is `{ id, embeddingAttached: false }`." : "The operation's value.", content: { "application/json": { schema: { type: "object" } } } },
        ...answersFor(name),
      },
      security: KEYED,
    };
  }
  paths["/v1/whoami"] = { get: { operationId: "whoami", summary: "Who is calling", description: "The key's name, its scope, its stable agent id and the operations it may call.", responses: { "200": { description: "The caller.", content: { "application/json": { schema: { type: "object" } } } }, "401": refusal("No key, a wrong key or a revoked one."), "405": KEYED_ANSWERS["405"], "500": KEYED_ANSWERS["500"], "503": KEYED_ANSWERS["503"] }, security: KEYED } };
  paths["/v1/jobs/{job_id}/stream"] = { get: { operationId: "job_stream", summary: "A job's events", description: "The job's progress and its end as server-sent events, for the key that started it.", parameters: [{ name: "job_id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "An event stream.", content: { "text/event-stream": {} } }, "401": KEYED_ANSWERS["401"], "403": KEYED_ANSWERS["403"], "404": refusal("No such job for this key."), "405": KEYED_ANSWERS["405"], "500": KEYED_ANSWERS["500"], "503": KEYED_ANSWERS["503"] }, security: KEYED } };
  paths["/health"] = { get: { operationId: "health", summary: "Liveness", description: "Internal only: the process is serving. No key, nothing about the brain.", responses: { "200": { description: "Serving." }, "405": KEYED_ANSWERS["405"] }, security: [] } };
  return {
    openapi: "3.1.0",
    info: { title: "Open Brain REST core", version: FORK_VERSION, description: "Every operation the brain's MCP tools expose, as JSON (SMD-2284). Internal by default; public at /api only where the operator turns it on." },
    paths,
    components: {
      securitySchemes: {
        brainKey: { type: "apiKey", in: "header", name: "x-brain-key" },
        accessKey: { type: "apiKey", in: "header", name: "x-access-key" },
        bearer: { type: "http", scheme: "bearer" },
      },
      schemas: {
        Refusal: { type: "object", required: ["code"], properties: { code: { type: "string" }, retryable: { type: "boolean" } }, additionalProperties: true },
      },
    },
  };
}
