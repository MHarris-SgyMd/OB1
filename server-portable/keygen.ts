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
 *   bun keygen.ts --name session-hook --scope capture   # may add a thought, nothing else (SMD-1298)
 */

import { randomBytes } from "node:crypto";
import { hashKey, SCOPES, type Scope } from "./auth.ts";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

const name = flag("name");
const scope = flag("scope") ?? "read";

if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) {
  console.error("usage: bun keygen.ts --name <client> [--scope read|write|capture]");
  console.error("  name must be [A-Za-z0-9_-]+ (it becomes part of the config line)");
  process.exit(2);
}
if (!(SCOPES as readonly string[]).includes(scope)) {
  console.error(`--scope must be one of ${SCOPES.join(", ")}, got "${scope}"`);
  process.exit(2);
}
const minted: Scope = scope as Scope;

const key = randomBytes(32).toString("hex");

console.log(`\n  Key for "${name}" (${scope}) — shown once, not recoverable:\n`);
console.log(`    ${key}\n`);
console.log(`  Add this line to MCP_ACCESS_KEYS (the hash, never the key):\n`);
console.log(`    ${name}:${scope}:${hashKey(key)}\n`);
if (minted === "read") {
  console.log(`  Read-only: the tools that write (capture_thought, update_thought,`);
  console.log(`  delete_thought; an extension's add/update tools) are not registered for`);
  console.log(`  this key, so they do not appear in tools/list. Safe for a URL-embedded connector.\n`);
} else if (minted === "capture") {
  console.log(`  Capture-only: capture_thought is the one tool registered for this key — no`);
  console.log(`  search, no update, no delete. For a hook or a pipeline that adds thoughts`);
  console.log(`  from a machine you do not sit at: a leak of this key can add, not read.\n`);
} else {
  console.log(`  Write scope: this key can capture and modify thoughts. Prefer --scope read`);
  console.log(`  for anything that only needs to search, --scope capture for a hook that`);
  console.log(`  only adds, and either for URL-embedded connectors.\n`);
}
