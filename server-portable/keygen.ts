#!/usr/bin/env bun
/**
 * keygen.ts — mint an access key.
 *
 * Prints the key once and the config line to store. The key itself is never
 * written anywhere, and the server only ever holds its hash, so this output is
 * the only chance to copy it.
 *
 *   bun keygen.ts --name laptop  --scope write
 *   bun keygen.ts --name chatgpt --scope read
 */

import { randomBytes } from "node:crypto";
import { hashKey } from "./auth.ts";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

const name = flag("name");
const scope = flag("scope") ?? "read";

if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) {
  console.error("usage: bun keygen.ts --name <client> [--scope read|write]");
  console.error("  name must be [A-Za-z0-9_-]+ (it becomes part of the config line)");
  process.exit(2);
}
if (scope !== "read" && scope !== "write") {
  console.error(`--scope must be read or write, got "${scope}"`);
  process.exit(2);
}

const key = randomBytes(32).toString("hex");

console.log(`\n  Key for "${name}" (${scope}) — shown once, not recoverable:\n`);
console.log(`    ${key}\n`);
console.log(`  Add this line to MCP_ACCESS_KEYS (the hash, never the key):\n`);
console.log(`    ${name}:${scope}:${hashKey(key)}\n`);
if (scope === "read") {
  console.log(`  Read-only: capture_thought is not registered for this key, so it does`);
  console.log(`  not appear in tools/list. Safe for a URL-embedded connector.\n`);
} else {
  console.log(`  Write scope: this key can capture and modify thoughts. Prefer --scope read`);
  console.log(`  for anything that only needs to search, and for URL-embedded connectors.\n`);
}
