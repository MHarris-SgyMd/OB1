#!/usr/bin/env bun
/**
 * generate.ts — writes the REST core's OpenAPI document and the client's
 * generated files from it (SMD-2287):
 *
 *   openapi.json   the document server-portable/rest/openapi.ts builds, core
 *                  operations alone — a plugin's operations are called by the
 *                  path its manifest declares (SMD-2310), as the brain that
 *                  enables it serves them;
 *   schema.d.ts    the types openapi-typescript makes of that document, which
 *                  openapi-fetch reads (index.ts);
 *   operations.ts  each operation's method and path by its operationId (the
 *                  tool's name), for a call by name.
 *
 *   bun generate.ts        # rewrite all three
 *
 * test-client.ts renders all three in memory and compares them with the
 * committed files, so a route, a schema or a description changed in
 * server-portable without a regeneration fails CI. The document's version is
 * the release's, which every cut bumps; the files are the contract's, so they
 * carry "snapshot" in its place.
 */
import openapiTS, { astToString } from "openapi-typescript";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openApiDocument } from "../server-portable/rest/openapi.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOTE = "Generated from server-portable/rest/openapi.ts by rest-client/generate.ts — do not edit by hand (SMD-2287).";

/** The document, as openapi.json holds it. */
export function renderDocument(): string {
  const doc = openApiDocument();
  return JSON.stringify({ ...doc, info: { ...(doc.info as Record<string, unknown>), version: "snapshot" } }, null, 2) + "\n";
}

/** The document's types, as schema.d.ts holds them. */
export async function renderTypes(document: string = renderDocument()): Promise<string> {
  // A success the document states only as an object is `Record<string, unknown>`, not `Record<string, never>`:
  // its value is the core's, which the document does not spell out yet.
  return `// ${NOTE}\n\n${astToString(await openapiTS(JSON.parse(document), { emptyObjectsUnknown: true }))}`;
}

type Doc = { paths: Record<string, Record<string, { operationId?: string }>> };

/** Each operation's method and path by its operationId, as operations.ts holds them. */
export function renderOperations(document: string = renderDocument()): string {
  const rows: string[] = [];
  for (const [path, item] of Object.entries((JSON.parse(document) as Doc).paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (op.operationId) rows.push(`  ${op.operationId}: { method: "${method.toUpperCase()}", path: "${path}" },`);
    }
  }
  rows.sort();
  return `// ${NOTE}\n\n/** Each REST operation's method and path, by its operationId — the MCP tool's name for a core operation. */\nexport const OPERATIONS = {\n${rows.join("\n")}\n} as const;\n\nexport type OperationId = keyof typeof OPERATIONS;\n`;
}

/** The three files, by name, as this directory holds them. */
export async function renderAll(): Promise<Record<string, string>> {
  const document = renderDocument();
  return { "openapi.json": document, "schema.d.ts": await renderTypes(document), "operations.ts": renderOperations(document) };
}

if (import.meta.main) {
  for (const [name, text] of Object.entries(await renderAll())) {
    writeFileSync(join(HERE, name), text);
    console.log(`wrote ${name} (${text.length} bytes)`);
  }
}
