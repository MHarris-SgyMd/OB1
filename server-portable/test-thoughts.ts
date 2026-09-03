#!/usr/bin/env bun
/**
 * test-thoughts.ts — the pure rules, tested directly.
 *
 * None of this had a test before, because none of it was reachable: index.ts
 * exports only its fetch handler, so asserting that `action_item` maps to `task`
 * meant booting a server, stubbing a model provider, and driving a capture over
 * JSON-RPC — per alias. Nobody was going to write seven of those, so nobody wrote
 * any, and the alias table has been shipping unverified since it was added.
 *
 * Needs no database and no provider.
 *
 *   bun test-thoughts.ts
 */

import { createAssert } from "../db/test-support.ts";
import { normaliseType, thoughtTitle, thoughtUrl, THOUGHT_TYPES, TYPE_ALIASES } from "./thoughts.ts";

const { assert, report } = createAssert();

console.log("\n[1] Every canonical type passes through untouched");
{
  for (const t of THOUGHT_TYPES) {
    const out = normaliseType(t);
    assert(out.type === t && out.raw === undefined, `${t} is preserved with no raw marker`);
  }
}

console.log("\n[2] Every alias maps, and records what it was");
{
  // The reason the table exists: llama3.2 returned "action_item" for a reminder,
  // which silently fragments `list_thoughts?type=task`.
  for (const [alias, canonical] of Object.entries(TYPE_ALIASES)) {
    const out = normaliseType(alias);
    assert(out.type === canonical, `${alias} → ${canonical}`);
    assert(out.raw === alias, `…and keeps "${alias}" in type_raw, so drift stays visible`);
  }
}

console.log("\n[3] Unknown and malformed values degrade to observation");
{
  for (const bad of ["wingding", "", "   ", null, undefined, 42, {}, []]) {
    const out = normaliseType(bad as unknown);
    assert(out.type === "observation", `${JSON.stringify(bad)} → observation`);
  }
  assert(normaliseType("wingding").raw === "wingding", "an invented type is preserved in type_raw");
}

console.log("\n[4] Case and spacing are normalised, not rejected");
{
  assert(normaliseType("TASK").type === "task", "uppercase matches");
  assert(normaliseType("Action Item").type === "task", "space-separated alias matches");
  assert(normaliseType("action-item").type === "task", "hyphenated alias matches");
  assert(normaliseType("  task  ").type === "task", "surrounding whitespace is trimmed");
}

console.log("\n[5] Titles collapse whitespace and truncate");
{
  const t = thoughtTitle("a  thought\nwith\tragged   spacing", "2026-01-15T10:00:00Z");
  assert(/a thought with ragged spacing/.test(t), `newlines and tabs collapse to single spaces (${t})`);

  const long = thoughtTitle("x".repeat(200));
  const body = long.split(" - ")[1] ?? "";
  assert(body.length === 80, `truncated to 80 characters (${body.length})`);

  assert(/^Open Brain/.test(thoughtTitle("something")), "no date yields the Open Brain prefix");
  assert(/thought$/.test(thoughtTitle("")), "empty content still produces a usable title");
  assert(/thought$/.test(thoughtTitle("   ")), "whitespace-only content counts as empty");
}

console.log("\n[6] Citation URLs join cleanly whatever the base looks like");
{
  const id = "abc-123";
  assert(thoughtUrl("https://x.test", id) === "https://x.test/abc-123", "no trailing slash");
  assert(thoughtUrl("https://x.test/", id) === "https://x.test/abc-123", "one trailing slash is not doubled");
  assert(thoughtUrl("https://x.test/brain/", id) === "https://x.test/brain/abc-123", "a path base keeps its path");
}

report();
