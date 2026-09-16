#!/usr/bin/env bun
/**
 * test-compat.ts — the shim must behave the way supabase-js does.
 *
 * A compatibility layer that is merely *close* is worse than none: 54 files would
 * swap one import and inherit subtle differences with no failing test to find
 * them. Every assertion below pins a behaviour those files depend on, including
 * the ones that are easy to get wrong — inclusive ranges, `{ data, error }`
 * instead of throwing, `.single()` on no rows, empty `.in()`, jsonb containment,
 * identifier safety, JSON-path filter columns and a timestamp's shape.
 *
 *   ../../db/with-postgres.sh bun test-compat.ts
 */

import { createClient } from "./index.ts";
import { createAssert } from "../../db/test-support.ts";
import { SQL } from "bun";

const { assert, report } = createAssert();

const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  console.error("DATABASE_URL is not set. Try: ../../db/with-postgres.sh bun test-compat.ts");
  process.exit(2);
}


// Fixture table, shaped like the kinds of tables the recipes actually use.
{
  const admin = new SQL({ url: URL_, max: 1 });
  await admin`DROP TABLE IF EXISTS widgets CASCADE`;
  await admin`
    CREATE TABLE widgets (
      id         serial PRIMARY KEY,
      name       text UNIQUE NOT NULL,
      kind       text,
      score      int,
      meta       jsonb DEFAULT '{}'::jsonb,
      retired    boolean DEFAULT false,
      created_at timestamptz DEFAULT now()
    )`;
  await admin`
    CREATE OR REPLACE FUNCTION widget_score_total(p_kind text DEFAULT NULL)
    RETURNS int LANGUAGE sql STABLE AS $$
      SELECT COALESCE(sum(score), 0)::int FROM widgets
      WHERE p_kind IS NULL OR kind = p_kind $$`;
  await admin`
    CREATE OR REPLACE FUNCTION widgets_by_kind(p_kind text)
    RETURNS TABLE (id int, name text) LANGUAGE sql STABLE AS $$
      SELECT id, name FROM widgets WHERE kind = p_kind ORDER BY id $$`;
  await admin`
    CREATE OR REPLACE FUNCTION widgets_created(p_kind text)
    RETURNS TABLE (id int, created_at timestamptz) LANGUAGE sql STABLE AS $$
      SELECT id, created_at FROM widgets WHERE kind = p_kind ORDER BY id $$`;
  await admin.close();
}

const db = createClient(URL_, "ignored-service-key");

console.log("[1] createClient keeps the supabase-js signature");
{
  assert(typeof db.from === "function" && typeof db.rpc === "function", "exposes .from() and .rpc()");
  let threw = "";
  try { createClient("https://project.supabase.co", "key"); } catch (e) { threw = (e as Error).message; }
  assert(/expected a postgres:\/\/ connection URL/.test(threw), "a project URL is rejected with an explanatory message");
}

console.log("\n[2] insert, and RETURNING via .select()");
{
  const { data, error } = await db.from("widgets").insert({ name: "alpha", kind: "tool", score: 10 }).select("id, name");
  assert(error === null, `insert succeeds (${error?.message ?? "no error"})`);
  assert(Array.isArray(data) && data.length === 1, "returns the inserted row");
  assert((data as Record<string, unknown>[])[0].name === "alpha", "…with the RETURNING columns");

  const batch = await db.from("widgets").insert([
    { name: "beta", kind: "tool", score: 20, meta: { tags: ["x"] } },
    { name: "gamma", kind: "gadget", score: 30 },
  ]).select("*");
  assert(batch.error === null && (batch.data as unknown[]).length === 2, "batch insert of heterogeneous rows");
}

console.log("\n[3] Errors resolve as { error }, they do not throw");
{
  const { data, error } = await db.from("widgets").insert({ name: "alpha" }).select("id");
  assert(error !== null, "a unique violation produces an error object");
  assert(data === null, "…and no data");
  assert(/duplicate key|unique/i.test(error!.message), `…carrying the Postgres message (${error!.message.slice(0, 40)}…)`);
  assert(error!.code === "23505", `…and the SQLSTATE (${error!.code})`);
}

console.log("\n[4] Filters");
{
  const eq = await db.from("widgets").select("name").eq("kind", "tool");
  assert((eq.data as unknown[]).length === 2, "eq");
  const neq = await db.from("widgets").select("name").neq("kind", "tool");
  assert((neq.data as unknown[]).length === 1, "neq");
  const gte = await db.from("widgets").select("name").gte("score", 20);
  assert((gte.data as unknown[]).length === 2, "gte");
  const lt = await db.from("widgets").select("name").lt("score", 20);
  assert((lt.data as unknown[]).length === 1, "lt");
  const like = await db.from("widgets").select("name").like("name", "%a%");
  assert((like.data as unknown[]).length === 3, "like");
  const ilike = await db.from("widgets").select("name").ilike("name", "ALPHA");
  assert((ilike.data as unknown[]).length === 1, "ilike is case-insensitive");
  const inList = await db.from("widgets").select("name").in("name", ["alpha", "gamma"]);
  assert((inList.data as unknown[]).length === 2, "in");
  const isFalse = await db.from("widgets").select("name").is("retired", false);
  assert((isFalse.data as unknown[]).length === 3, "is(false) uses IS, not =");
  const contains = await db.from("widgets").select("name").contains("meta", { tags: ["x"] });
  assert((contains.data as unknown[]).length === 1, "contains() is jsonb @> containment");
  const matched = await db.from("widgets").select("name").match({ kind: "tool", score: 10 });
  assert((matched.data as unknown[]).length === 1, "match() ANDs several equalities");
  const chained = await db.from("widgets").select("name").eq("kind", "tool").gte("score", 15);
  assert((chained.data as unknown[]).length === 1, "chained filters AND together");

  // The one .or() shape the repo actually uses: a flat column.op.value list.
  const ored = await db.from("widgets").select("name").or("score.gt.25,kind.is.null");
  assert((ored.data as unknown[]).length === 1, "or() combines flat terms with OR");
  const oredNull = await db.from("widgets").update({ kind: null }).eq("name", "gamma").select("name");
  assert(oredNull.error === null, "…setup for the null branch");
  const ored2 = await db.from("widgets").select("name").or("score.gt.99,kind.is.null");
  assert((ored2.data as unknown[]).length === 1, "or() handles is.null as a literal, not a parameter");
  await db.from("widgets").update({ kind: "gadget" }).eq("name", "gamma");

  let nested = "";
  try { await db.from("widgets").select("name").or("and(a.eq.1,b.eq.2),c.eq.3"); } catch (e) { nested = (e as Error).message; }
  assert(/nested and\(\)\/or\(\) grouping/.test(nested), "or() refuses nested grouping rather than half-parsing it");

  let badOp = "";
  try { await db.from("widgets").select("name").or("score.bogus.1"); } catch (e) { badOp = (e as Error).message; }
  assert(/operator "bogus" is not supported/.test(badOp), "or() refuses an unknown operator");

  // PostgREST semantics: an empty in() list matches nothing rather than everything.
  const emptyIn = await db.from("widgets").select("name").in("name", []);
  assert((emptyIn.data as unknown[]).length === 0, "in([]) selects nothing, as PostgREST does");
}

console.log("\n[5] Modifiers");
{
  const ordered = await db.from("widgets").select("name, score").order("score", { ascending: false });
  assert((ordered.data as { name: string }[])[0].name === "gamma", "order descending");
  const asc = await db.from("widgets").select("name").order("score", { ascending: true });
  assert((asc.data as { name: string }[])[0].name === "alpha", "order ascending is the default direction");
  const limited = await db.from("widgets").select("name").limit(2);
  assert((limited.data as unknown[]).length === 2, "limit");

  // PostgREST ranges are inclusive at both ends: range(0,1) is two rows.
  const ranged = await db.from("widgets").select("name").order("id").range(0, 1);
  assert((ranged.data as unknown[]).length === 2, "range(0,1) returns 2 rows — inclusive, as PostgREST is");
  const ranged2 = await db.from("widgets").select("name").order("id").range(1, 2);
  assert((ranged2.data as { name: string }[])[0].name === "beta", "range offsets correctly");
}

console.log("\n[6] single() and maybeSingle()");
{
  const one = await db.from("widgets").select("name").eq("name", "alpha").single();
  assert(!Array.isArray(one.data) && (one.data as unknown as { name: string }).name === "alpha", "single() returns an object, not an array");

  const missing = await db.from("widgets").select("name").eq("name", "nope").single();
  assert(missing.error !== null, "single() with no rows is an error");
  assert(missing.error!.code === "PGRST116", `…with PostgREST's code (${missing.error!.code})`);

  const maybe = await db.from("widgets").select("name").eq("name", "nope").maybeSingle();
  assert(maybe.error === null && maybe.data === null, "maybeSingle() with no rows is null, not an error");
}

console.log("\n[7] count and head");
{
  const { count, data } = await db.from("widgets").select("id", { count: "exact", head: true });
  assert(count === 3, `head+count returns the count (${count})`);
  assert(data === null, "…and no rows, which is what head:true means");

  const filtered = await db.from("widgets").select("id", { count: "exact", head: true }).eq("kind", "tool");
  assert(filtered.count === 2, "count honours filters");
}

console.log("\n[8] update, upsert, delete");
{
  const upd = await db.from("widgets").update({ score: 99 }).eq("name", "alpha").select("name, score");
  assert(upd.error === null && (upd.data as { score: number }[])[0].score === 99, "update with a filter");

  const up = await db.from("widgets")
    .upsert({ name: "beta", kind: "tool", score: 21 }, { onConflict: "name" })
    .select("name, score");
  assert(up.error === null, `upsert succeeds (${up.error?.message ?? "ok"})`);
  assert((up.data as { score: number }[])[0].score === 21, "…updating the conflicting row rather than failing");
  const stillThree = await db.from("widgets").select("id", { count: "exact", head: true });
  assert(stillThree.count === 3, "…and adding no row");

  const del = await db.from("widgets").delete().eq("name", "gamma").select("name");
  assert(del.error === null && (del.data as unknown[]).length === 1, "delete returns the removed row");
  const two = await db.from("widgets").select("id", { count: "exact", head: true });
  assert(two.count === 2, "…and the row is gone");
}

console.log("\n[9] rpc");
{
  const scalar = await db.rpc("widget_score_total");
  assert(scalar.error === null && scalar.data === 120, `a scalar function returns its value (${scalar.data})`);

  const withArg = await db.rpc("widget_score_total", { p_kind: "tool" });
  assert(withArg.data === 120, "named arguments are passed through");

  const setOf = await db.rpc("widgets_by_kind", { p_kind: "tool" });
  assert(Array.isArray(setOf.data) && (setOf.data as unknown[]).length === 2, "a set-returning function returns rows");

  const bad = await db.rpc("no_such_function");
  assert(bad.error !== null, "a missing function resolves as an error rather than throwing");
}

console.log("\n[10] Injection safety and honest refusals");
{
  for (const [bad, what] of [
    ['name"; DROP TABLE widgets; --', "a quoted identifier"],
    ["name = 1 OR 1=1", "an expression"],
    ["", "an empty column"],
  ] as [string, string][]) {
    let threw = false;
    try { await db.from("widgets").select("id").eq(bad, "x"); } catch { threw = true; }
    assert(threw, `rejects ${what} as a column name`);
  }

  let tableThrew = false;
  try { await db.from('widgets"; DROP TABLE widgets; --').select("id"); } catch { tableThrew = true; }
  assert(tableThrew, "rejects an injected table name");

  // Values are parameterised, so this is data, not SQL.
  const safe = await db.from("widgets").select("name").eq("name", "'; DROP TABLE widgets; --");
  assert(safe.error === null && (safe.data as unknown[]).length === 0, "a value containing SQL is treated as data");
  const survived = await db.from("widgets").select("id", { count: "exact", head: true });
  assert(survived.count === 2, "…and the table still exists");

  // Embedded selects must fail loudly rather than return subtly wrong rows.
  let embedMsg = "";
  try { await db.from("widgets").select("*, other_table(*)"); } catch (e) { embedMsg = (e as Error).message; }
  assert(/resource embedding/.test(embedMsg), "refuses PostgREST resource embedding");
  assert(/not supported/.test(embedMsg), "…saying so explicitly rather than guessing at a join");
}

console.log("\n[11] The generated SQL is inspectable");
{
  const q = db.from("widgets").select("id, name").eq("kind", "tool").order("score", { ascending: false }).limit(5);
  const { text, values } = q.toSQL();
  assert(/SELECT "id", "name" FROM "widgets"/.test(text), "columns and table are quoted");
  assert(/WHERE "kind" = \$1/.test(text), "filters are parameterised, not interpolated");
  assert(/ORDER BY "score" DESC LIMIT 5/.test(text), "modifiers compile as expected");
  assert(values.length === 1 && values[0] === "tool", "the value travels as a parameter");
}

console.log("\n[12] JSON-path filter columns (SMD-1544)");
/** A result's rows, the error named first: a regression that resolves as { error } is one counted failure, not a TypeError before the tally. */
const rowsOf = (r: { data: unknown; error: { message: string } | null }, what: string): Record<string, unknown>[] => {
  if (r.error) assert(false, `${what}: ${r.error.message}`);
  return (r.data as Record<string, unknown>[] | null) ?? [];
};
const namesOf = (r: { data: unknown; error: { message: string } | null }, what: string) => rowsOf(r, what).map((x) => String(x.name)).join();
try {
  // Two rows with keys under `meta`; alpha and beta have none of them.
  rowsOf(await db.from("widgets").insert([
    { name: "delta", kind: "gadget", score: 5, meta: { owner: "ann", nested: { level: "deep" }, generated_by: "bot", score: 25 } },
    { name: "epsilon", kind: "gadget", score: 7, meta: { owner: "bob", score: 5 } },
  ]).select("name"), "setup insert");

  assert(namesOf(await db.from("widgets").select("name").eq("meta->>owner", "ann"), "eq") === "delta", "eq on `col->>key` compares the key's text");
  const isNull = rowsOf(await db.from("widgets").select("name").is("meta->>generated_by", null), "is(null)");
  assert(isNull.length === 3, `is(null) on a path selects the rows without the key (${isNull.length}) — the bio worker's filter`);
  assert(namesOf(await db.from("widgets").select("name").eq("meta->nested->>level", "deep"), "nested") === "delta", "`col->a->>b` reaches a nested key");
  assert(namesOf(await db.from("widgets").select("name").neq("meta->>owner", "ann"), "neq") === "epsilon", "neq on a path leaves out the rows without the key, as SQL and PostgREST do");
  const gte = rowsOf(await db.from("widgets").select("name").gte("meta->>score", 20), "gte with a number");
  assert(gte.length === 2, `a number against a path compares as text — "5" >= "20" — which is PostgREST's comparison for ->>, and not an error (${gte.length})`);
  assert(rowsOf(await db.from("widgets").select("name").in("meta->>owner", ["ann", "bob"]), "in").length === 2, "in() on a path");
  assert(namesOf(await db.from("widgets").select("name").match({ "meta->>owner": "bob", kind: "gadget" }), "match") === "epsilon", "match() takes a path among its keys");
  const ored = rowsOf(await db.from("widgets").select("name").or("meta->>owner.eq.ann,score.gt.90"), "or");
  assert(ored.length === 2, `or() parses a path term — the key is dot-free, so column.op.value still splits (${ored.length})`);
  const ordered = rowsOf(await db.from("widgets").select("name").order("meta->>owner", { ascending: false, nullsFirst: false }), "order");
  assert(ordered[0]?.name === "epsilon", "order() by a path");

  const q = db.from("widgets").select("id").eq("meta->>owner", "ann").is("meta->>generated_by", null).order("meta->>owner");
  const { text, values } = q.toSQL();
  assert(/WHERE "meta"->>'owner' = \$1::text AND "meta"->>'generated_by' IS NULL ORDER BY "meta"->>'owner' ASC/.test(text),
    `the column is a quoted identifier, the key a quoted literal, the value a parameter cast to text (${text})`);
  assert(values.length === 1 && values[0] === "ann", "…and the value travels as a parameter");

  // Refusals: a path that yields jsonb, a ->> before the end, an array index, an injected key, and a path anywhere but a comparison or an order.
  for (const [bad, re, what] of [
    ["meta->owner", /must end in ->>/, "a path ending in -> (jsonb) is refused, naming ->> and .contains()"],
    ["meta->>owner->>x", /must end in ->>/, "a ->> before the end is refused"],
    ["meta->>0", /Identifiers must match/, "an array index is refused"],
    ["meta->>owner'; DROP TABLE widgets; --", /Identifiers must match/, "an injected key is refused"],
  ] as [string, RegExp, string][]) {
    let msg = "";
    try { await db.from("widgets").select("id").eq(bad, "x"); } catch (e) { msg = (e as Error).message; }
    assert(re.test(msg), `${what} (${msg.slice(0, 60)})`);
  }
  const refused = async (run: () => Promise<unknown>) => { try { await run(); return ""; } catch (e) { return (e as Error).message; } };
  assert(/Identifiers must match/.test(await refused(() => db.from("widgets").select("meta->>owner"))), "a path in a select list is still refused — not a filter column");
  assert(/Identifiers must match/.test(await refused(() => db.from("widgets").update({ "meta->>owner": "x" }).eq("name", "delta"))), "a path as a payload key is still refused");
  assert(/Identifiers must match/.test(await refused(() => db.from("widgets").select("id").contains("meta->>owner", {}))), "contains() refuses a path — it is jsonb containment on a column, and text @> jsonb has no operator");
  const survived = await db.from("widgets").select("id", { count: "exact", head: true });
  assert(survived.count === 4, "…and the table still exists");
} catch (e) {
  assert(false, `[12] threw: ${e instanceof Error ? e.message : String(e)}`);
}

console.log("\n[13] Rows are JSON-shaped where PostgREST's are: a timestamp is a string");
try {
  const one = await db.from("widgets").select("name, created_at").eq("name", "alpha").single();
  const at = (rowsOf({ data: one.data === null ? [] : [one.data], error: one.error }, "single")[0] ?? {}).created_at;
  assert(typeof at === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at),
    `a timestamptz arrives as an ISO string, as PostgREST's JSON has it — Bun hands back a Date, whose .slice is a 500 in a file written for PostgREST (got ${typeof at} ${String(at)})`);
  const many = rowsOf(await db.from("widgets").select("created_at").order("id"), "many rows");
  assert(many.length === 4 && many.every((r) => typeof r.created_at === "string"), "…on every row of a many-row result");
  const fn = await db.rpc("widgets_created", { p_kind: "tool" });
  const fnRows = rowsOf(fn, "set-returning rpc");
  assert(fnRows.length === 2 && fnRows.every((r) => typeof r.created_at === "string"), "…and on a set-returning function's rows");
  const nulled = rowsOf(await db.from("widgets").update({ kind: null }).eq("name", "epsilon").select("kind, created_at"), "update returning");
  assert(nulled[0]?.kind === null && typeof nulled[0]?.created_at === "string", "a NULL stays null; only a Date is reshaped");
} catch (e) {
  assert(false, `[13] threw: ${e instanceof Error ? e.message : String(e)}`);
}

await db.close();

report();
