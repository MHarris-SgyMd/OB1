/**
 * test-capture-atomicity.mjs
 *
 * Regression test for the non-atomic capture_thought write path.
 *
 * The original wrote in two steps — upsert_thought(content, payload) to create
 * the row, then a separate UPDATE to attach the embedding. A failure between
 * them left the row committed with a NULL embedding: stored, but invisible to
 * every semantic search, and reported to the user as a flat "Failed to save
 * embedding" that reads as though nothing was saved at all.
 *
 * The fix calls the 3-arg upsert_thought(text, jsonb, vector) overload added by
 * db/migrations/004_upsert_thought_with_embedding.sql, falling back to the old
 * two-step path when that function is absent so it stays a drop-in change.
 *
 * index.ts cannot be imported under Node (Deno.env at module scope, jsr:
 * imports), so this mirrors the write path and guards the mirror against drift.
 *
 * Run: node test-capture-atomicity.mjs   (or: bun test-capture-atomicity.mjs)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_TS = readFileSync(join(HERE, "index.ts"), "utf8");
const MIGRATION = readFileSync(
  join(HERE, "..", "db", "migrations", "004_upsert_thought_with_embedding.sql"),
  "utf8"
);

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}`);
    failed++;
  }
}

// ── [0] Drift guard ───────────────────────────────────────────────────────────

console.log("[0] Drift guard — index.ts still prefers the atomic write");

assert(
  /rpc\("upsert_thought", \{\s*p_content: content,\s*p_payload: payload,\s*p_embedding: embedding,\s*\}\)/.test(
    INDEX_TS
  ),
  "index.ts calls the 3-arg upsert_thought first"
);
assert(/PGRST202/.test(INDEX_TS), "index.ts detects PGRST202 (function not found)");
assert(
  /will NOT appear in semantic search until re-captured/.test(INDEX_TS),
  "index.ts reports a committed-but-unsearchable row explicitly"
);

console.log("\n[0b] Drift guard — the migration keeps the overload unambiguous");

assert(
  /p_embedding vector\(1536\)\s*\)/.test(MIGRATION),
  "migration declares p_embedding vector(1536)"
);
assert(
  !/p_embedding\s+vector\(1536\)\s+DEFAULT/i.test(MIGRATION),
  "p_embedding has NO default — a default would make the 2-arg call ambiguous"
);
assert(
  /COALESCE\(EXCLUDED\.embedding, thoughts\.embedding\)/.test(MIGRATION),
  "a null embedding never blanks an existing good vector"
);
assert(
  !/ALTER\s+TABLE/i.test(MIGRATION),
  "migration adds no columns and alters no table structure"
);

if (failed > 0) {
  console.error("\nDrift assertions failed — not testing against a stale contract.");
  console.error("FAIL\n");
  process.exit(1);
}

// ── Stub client ───────────────────────────────────────────────────────────────

const FN_NOT_FOUND = {
  code: "PGRST202",
  message:
    "Could not find the function public.upsert_thought(p_content, p_embedding, p_payload) in the schema cache",
};

function makeStub({ hasAtomic = true, atomicError = null, upsertError = null, embeddingError = null, returnsId = true } = {}) {
  const calls = { atomic: 0, twoArg: 0, update: 0 };
  const rows = [];

  return {
    calls,
    rows,
    rpc(name, args) {
      if (name !== "upsert_thought") throw new Error(`unexpected rpc ${name}`);
      const isAtomic = "p_embedding" in args;

      if (isAtomic) {
        calls.atomic++;
        if (!hasAtomic) return Promise.resolve({ data: null, error: FN_NOT_FOUND });
        if (atomicError) return Promise.resolve({ data: null, error: atomicError });
        rows.push({ id: "id-atomic", embedding: args.p_embedding, metadata: args.p_payload.metadata });
        return Promise.resolve({
          data: returnsId ? { id: "id-atomic", fingerprint: "fp" } : {},
          error: null,
        });
      }

      calls.twoArg++;
      if (upsertError) return Promise.resolve({ data: null, error: upsertError });
      rows.push({ id: "id-two-step", embedding: null, metadata: args.p_payload.metadata });
      return Promise.resolve({
        data: returnsId ? { id: "id-two-step", fingerprint: "fp" } : {},
        error: null,
      });
    },
    from() {
      return {
        update(patch) {
          return {
            eq: (_col, id) => {
              calls.update++;
              if (embeddingError) return Promise.resolve({ error: embeddingError });
              const row = rows.find((r) => r.id === id);
              if (row) row.embedding = patch.embedding;
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
}

// Mirrors the write path in index.ts (see drift guard above).
async function captureThought(supabase, { content, embedding, metadata }) {
  const payload = { metadata: { ...metadata, source: "mcp" } };

  const { data: atomicResult, error: atomicError } = await supabase.rpc("upsert_thought", {
    p_content: content,
    p_payload: payload,
    p_embedding: embedding,
  });

  const atomicUnavailable =
    atomicError &&
    (atomicError.code === "PGRST202" || /Could not find the function/i.test(atomicError.message ?? ""));

  if (atomicError && !atomicUnavailable) {
    return { isError: true, text: `Failed to capture: ${atomicError.message}` };
  }

  if (atomicUnavailable) {
    const { data: upsertResult, error: upsertError } = await supabase.rpc("upsert_thought", {
      p_content: content,
      p_payload: payload,
    });
    if (upsertError) return { isError: true, text: `Failed to capture: ${upsertError.message}` };

    const thoughtId = upsertResult?.id;
    if (!thoughtId) {
      return {
        isError: true,
        text: "Failed to capture: upsert_thought returned no id, so the embedding could not be attached.",
      };
    }

    const { error: embError } = await supabase.from("thoughts").update({ embedding }).eq("id", thoughtId);
    if (embError) {
      return {
        isError: true,
        text: `Thought saved (id ${thoughtId}) but its embedding failed to attach: ${embError.message}. It will NOT appear in semantic search until re-captured.`,
      };
    }
  } else if (!atomicResult?.id) {
    return { isError: true, text: "Failed to capture: upsert_thought returned no id." };
  }

  return { isError: false, text: "Captured" };
}

const INPUT = { content: "a thought", embedding: [0.1, 0.2, 0.3], metadata: { type: "idea" } };

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log("\n[1] Migration applied — one atomic round-trip, no follow-up UPDATE");
{
  const stub = makeStub({ hasAtomic: true });
  const r = await captureThought(stub, INPUT);
  assert(!r.isError, "capture succeeds");
  assert(stub.calls.atomic === 1, "called the 3-arg overload once");
  assert(stub.calls.twoArg === 0, "did not fall back");
  assert(stub.calls.update === 0, "no separate embedding UPDATE — the whole point");
  assert(stub.rows[0].embedding === INPUT.embedding, "embedding written in the same statement");
}

console.log("\n[2] Migration not applied — falls back and still succeeds");
{
  const stub = makeStub({ hasAtomic: false });
  const r = await captureThought(stub, INPUT);
  assert(!r.isError, "capture still succeeds without the migration");
  assert(stub.calls.atomic === 1, "tried the atomic path first");
  assert(stub.calls.twoArg === 1, "fell back to the 2-arg form");
  assert(stub.calls.update === 1, "attached the embedding in a second call");
  assert(stub.rows[0].embedding === INPUT.embedding, "embedding eventually stored");
}

console.log("\n[3] The original bug — fallback UPDATE fails, row is committed without a vector");
{
  const stub = makeStub({
    hasAtomic: false,
    embeddingError: { message: "connection reset" },
  });
  const r = await captureThought(stub, INPUT);
  assert(r.isError, "reported as an error");
  assert(stub.rows.length === 1, "the row IS committed");
  assert(stub.rows[0].embedding === null, "with a NULL embedding");
  assert(/Thought saved \(id id-two-step\)/.test(r.text), "message says the thought was saved");
  assert(/NOT appear in semantic search/.test(r.text), "message says it is unsearchable");
  assert(
    !/^Failed to save embedding/.test(r.text),
    "no longer the old message that read as 'nothing was saved'"
  );
}

console.log("\n[4] A real atomic error propagates — it is not mistaken for a missing function");
{
  const stub = makeStub({
    hasAtomic: true,
    atomicError: { code: "23505", message: "duplicate key value violates unique constraint" },
  });
  const r = await captureThought(stub, INPUT);
  assert(r.isError, "surfaced as an error");
  assert(/duplicate key value/.test(r.text), "propagates the real message");
  assert(stub.calls.twoArg === 0, "does NOT silently retry on the legacy path");
}

console.log("\n[5] Missing-function detected by message when the code is absent");
{
  const stub = makeStub({
    hasAtomic: true,
    atomicError: { message: "Could not find the function public.upsert_thought(...)" },
  });
  const r = await captureThought(stub, INPUT);
  assert(!r.isError, "recognised as missing-function and handled");
  assert(stub.calls.twoArg === 1, "fell back on the message match alone");
}

console.log("\n[6] Upsert returning no id is caught before a bad UPDATE");
{
  const stub = makeStub({ hasAtomic: false, returnsId: false });
  const r = await captureThought(stub, INPUT);
  assert(r.isError, "reported as an error");
  assert(stub.calls.update === 0, "never issues .eq('id', undefined)");
  assert(/returned no id/.test(r.text), "explains why");
}

console.log("\n[7] Atomic path returning no id is caught too");
{
  const stub = makeStub({ hasAtomic: true, returnsId: false });
  const r = await captureThought(stub, INPUT);
  assert(r.isError, "reported as an error");
  assert(/returned no id/.test(r.text), "explains why");
}

console.log("\n[8] Two-arg upsert failing outright");
{
  const stub = makeStub({ hasAtomic: false, upsertError: { message: "permission denied for table thoughts" } });
  const r = await captureThought(stub, INPUT);
  assert(r.isError, "reported as an error");
  assert(/permission denied/.test(r.text), "propagates the real message");
  assert(stub.rows.length === 0, "nothing committed");
}

console.log(`\n${"─".repeat(50)}`);
console.log(`${passed + failed} assertions: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error("FAIL\n");
  process.exit(1);
} else {
  console.log("PASS\n");
}
