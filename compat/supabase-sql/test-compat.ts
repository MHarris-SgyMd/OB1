#!/usr/bin/env bun
/**
 * test-compat.ts — the shim must behave the way supabase-js does.
 *
 * A compatibility layer that is merely *close* is worse than none: 54 files would
 * swap one import and inherit subtle differences with no failing test to find
 * them. Every assertion below pins a behaviour those files depend on, including
 * the ones that are easy to get wrong — inclusive ranges, `{ data, error }`
 * instead of throwing, `.single()` on no rows, empty `.in()`, jsonb containment,
 * identifier safety, JSON-path filter columns, a timestamp's shape, `.not()`,
 * arrays bound by their column's type, the error's class and one hop of
 * resource embedding (SMD-1588).
 *
 *   ../../db/with-postgres.sh bun test-compat.ts
 */

import { createClient, PostgrestError } from "./index.ts";
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
      labels     text[] DEFAULT '{}',
      created_at timestamptz DEFAULT now()
    )`;
  // One hop of embedding, both directions: a gizmo belongs to a widget; a link names two widgets (the ambiguous case).
  await admin`DROP TABLE IF EXISTS gizmos CASCADE`;
  await admin`DROP TABLE IF EXISTS links CASCADE`;
  await admin`
    CREATE TABLE gizmos (
      id         serial PRIMARY KEY,
      widget_id  int REFERENCES widgets(id) ON DELETE CASCADE,
      label      text NOT NULL,
      made_on    date DEFAULT '2026-09-20'
    )`;
  await admin`
    CREATE TABLE links (
      id    serial PRIMARY KEY,
      a_id  int REFERENCES widgets(id),
      b_id  int REFERENCES widgets(id)
    )`;
  // A one-to-one (the referencing column is unique), and a table that references itself.
  await admin`DROP TABLE IF EXISTS manuals CASCADE`;
  await admin`CREATE TABLE manuals (id serial PRIMARY KEY, widget_id int UNIQUE REFERENCES widgets(id), pages int)`;
  await admin`DROP TABLE IF EXISTS nodes CASCADE`;
  await admin`CREATE TABLE nodes (id serial PRIMARY KEY, parent_id int REFERENCES nodes(id), name text, counts int[] DEFAULT '{}')`;
  // A domain over an array type (format_type gives the domain's name; the type category says array), and a
  // same-named table in a schema behind the visible one, carrying the foreign key the visible one lacks.
  await admin`DROP DOMAIN IF EXISTS tagset CASCADE`;
  await admin`CREATE DOMAIN tagset AS text[]`;
  await admin`DROP TABLE IF EXISTS crates CASCADE`;
  await admin`CREATE TABLE crates (id serial PRIMARY KEY, tags tagset DEFAULT '{}')`;
  await admin`DROP SCHEMA IF EXISTS hidden CASCADE`;
  await admin`CREATE SCHEMA hidden`;
  await admin`DROP TABLE IF EXISTS kids CASCADE`;
  await admin`CREATE TABLE kids (id serial PRIMARY KEY, widget_id int, v text)`;
  await admin`CREATE TABLE hidden.kids (id serial PRIMARY KEY, widget_id int REFERENCES widgets(id), v text)`;
  // A function whose OUT columns include a date: its rows shaped as the table's.
  await admin`
    CREATE OR REPLACE FUNCTION gizmos_made(p_label text)
    RETURNS TABLE (id int, made_on date, label text) LANGUAGE sql STABLE AS $$
      SELECT id, made_on, label FROM gizmos WHERE label = p_label $$`;
  await admin`
    CREATE OR REPLACE FUNCTION widgets_labelled(p_labels text[], p_kind text DEFAULT NULL)
    RETURNS TABLE (id int, name text) LANGUAGE sql STABLE AS $$
      SELECT id, name FROM widgets WHERE labels @> p_labels AND (p_kind IS NULL OR kind = p_kind) ORDER BY id $$`;
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
  // The vendored servers build a client per request and close none; under Bun that was a pool per request (SMD-1588).
  const twin = createClient(URL_, "ignored-service-key");
  assert(twin.sql === db.sql, "two clients on one URL share one pool");
  await twin.close();
  await twin.close();
  const still = await db.from("widgets").select("id", { count: "exact", head: true });
  assert(still.error === null, `…and closing one (twice) leaves the other's pool open (${still.error?.message ?? "ok"})`);
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
  // Four tools interpolate user text into their expression; a comma in it splits a term PostgREST cannot parse either.
  const split = await db.from("widgets").select("name").or("name.ilike.%Sea, Salt%,kind.is.null");
  assert(split.error !== null && split.error.code === "PGRST100" && /not column\.operator\.value/.test(split.error.message), `a term user text broke resolves as { error } with PostgREST's 400 code, not a throw out of the handler (${split.error?.code})`);
  // Pattern text is text: a quote, a parenthesis or a bracket in an ILIKE value neither splits nor swallows a term.
  const rows4 = (r: { data: unknown }) => (r.data as { name: string }[] | null) ?? []; // rowsOf() is declared at [12]
  const quoteText = rows4(await db.from("widgets").select("name").or('name.ilike.%12" pipe%,name.ilike.%alp%,kind.ilike.%(x%'));
  assert(quoteText.length === 1 && quoteText[0]?.name === "alpha", `an unbalanced quote or parenthesis in a plain value is pattern text — the terms after it still count (${quoteText.length})`);
  const andText = rows4(await db.from("widgets").select("name").or("name.ilike.%wine and (cheese)%,name.eq.alpha"));
  assert(andText.length === 1, `"and (" inside a value is text, not grouping (${andText.length})`);
  const unclosed = await db.from("widgets").select("name").or('meta.cs.[{"k":"a,name.eq.alpha');
  assert(unclosed.error?.code === "PGRST100", `a group nothing closes is the 400, not a swallowed expression (${unclosed.error?.code})`);
  const quotedValue = rows4(await db.from("widgets").select("name").or('name.eq."alpha",name.eq."no, body"'));
  assert(quotedValue.length === 1, `PostgREST's double-quoted value form holds a comma (${quotedValue.length})`);

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

  // An embed the shim cannot serve fails loudly rather than returning subtly wrong rows ([17] has the served forms).
  let embedMsg = "";
  try { await db.from("widgets").select("*, other_table(*)"); } catch (e) { embedMsg = (e as Error).message; }
  assert(/no foreign key joins it/.test(embedMsg), "refuses embedding a relation with no foreign key to this table");
  let nestedMsg = "";
  try { await db.from("widgets").select("*, gizmos(*, other(*))"); } catch (e) { nestedMsg = (e as Error).message; }
  assert(/nests one resource embedding inside another/.test(nestedMsg) && /not supported/.test(nestedMsg), "refuses a nested embed, saying so rather than guessing at a join");
}

console.log("\n[11] The generated SQL is inspectable");
{
  const q = db.from("widgets").select("id, name").eq("kind", "tool").order("score", { ascending: false }).limit(5);
  const { text, values } = await q.toSQL();
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
  const { text, values } = await q.toSQL();
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
  const refused = async (run: () => PromiseLike<unknown>) => { try { await run(); return ""; } catch (e) { return (e as Error).message; } };
  assert(/Identifiers must match/.test(await refused(() => db.from("widgets").select("meta->>owner"))), "a path in a select list is still refused — not a filter column");
  assert(/Identifiers must match/.test(await refused(() => db.from("widgets").update({ "meta->>owner": "x" }).eq("name", "delta"))), "a path as a payload key is still refused");
  assert(/Identifiers must match/.test(await refused(() => db.from("widgets").select("id").contains("meta->>owner", {}))), "contains() refuses a path — it is containment with the column's own operator, and text @> jsonb has no operator");
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
  // gizmos.made_on is a date column ([17] plants rows); PostgREST gives the bare date, not a midnight instant.
  await db.from("gizmos").insert({ label: "dated" }).select("id");
  const dated = rowsOf(await db.from("gizmos").select("made_on").eq("label", "dated"), "date column");
  assert(dated[0]?.made_on === "2026-09-20", `a date column arrives as the bare date PostgREST gives, not a Z instant (${String(dated[0]?.made_on)}) — five extension tools read one`);
  const viaFn = rowsOf(await db.rpc("gizmos_made", { p_label: "dated" }), "date through a function");
  assert(viaFn[0]?.made_on === "2026-09-20", `…and the same column through a RETURNS TABLE function is the same bare date — one shape whichever path a tool takes (${String(viaFn[0]?.made_on)})`);
  await db.from("gizmos").delete().eq("label", "dated");
} catch (e) {
  assert(false, `[13] threw: ${e instanceof Error ? e.message : String(e)}`);
}

console.log("\n[14] .not() negates a filter (SMD-1588)");
try {
  // Rows: alpha, beta, delta, epsilon; epsilon's kind is NULL after [13].
  const notNull = namesOf(await db.from("widgets").select("name").not("kind", "is", null).order("id"), "not is null");
  assert(notNull === "alpha,beta,delta", `not("kind", "is", null) is IS NOT NULL — the two calls in the tree (${notNull})`);
  const notEq = namesOf(await db.from("widgets").select("name").not("kind", "eq", "tool").order("id"), "not eq");
  assert(notEq === "delta", `not("kind", "eq", …) is NOT (kind = …), which leaves a NULL out as PostgREST's does (${notEq})`);
  const notIn = namesOf(await db.from("widgets").select("name").not("name", "in", ["alpha", "beta"]).order("id"), "not in");
  assert(notIn === "delta,epsilon", `not("name", "in", […]) is NOT (name IN (…)) (${notIn})`);
  const notEmptyIn = namesOf(await db.from("widgets").select("name").not("kind", "in", []).order("id"), "not in []");
  assert(notEmptyIn === "alpha,beta,delta", `not in([]) selects every row whose column is not NULL — PostgREST's NOT (x = ANY('{}')) is NULL for epsilon's NULL kind (${notEmptyIn})`);
  const notIlike = namesOf(await db.from("widgets").select("name").not("name", "ilike", "%A%").order("id"), "not ilike");
  assert(notIlike === "epsilon", `not(…, "ilike", …) (${notIlike})`);
  const notCs = namesOf(await db.from("widgets").select("name").not("meta", "cs", { owner: "ann" }).order("id"), "not cs");
  assert(notCs === "alpha,beta,epsilon", `not(…, "cs", …) is NOT (col @> …) (${notCs})`);
  const { text } = await db.from("widgets").select("id").not("kind", "is", null).not("score", "gt", 5).toSQL();
  assert(/WHERE "kind" IS NOT NULL AND NOT \("score" > \$1\)/.test(text), `the two renderings (${text})`);
  let bad = "";
  try { await db.from("widgets").select("id").not("kind", "bogus", 1); } catch (e) { bad = (e as Error).message; }
  assert(/operator "bogus" is not supported/.test(bad), "an unknown operator is refused at the call");
} catch (e) {
  assert(false, `[14] threw: ${e instanceof Error ? e.message : String(e)}`);
}

console.log("\n[15] A JavaScript array is bound by its column's type (SMD-1588)");
try {
  // An array column takes an array literal; a jsonb column takes the array as JSON. Bun's own binding of a
  // JS array is its String() — `a,b`, `""` for [] — which a text[] column refuses as malformed (22P02).
  const empty = rowsOf(await db.from("widgets").insert({ name: "zeta", kind: "tool", score: 1, labels: [], meta: ["j", "k"] }).select("labels, meta"), "insert []");
  assert(Array.isArray(empty[0]?.labels) && (empty[0].labels as unknown[]).length === 0, `[] into text[] stores an empty array (${JSON.stringify(empty[0]?.labels)})`);
  assert(JSON.stringify(empty[0]?.meta) === '["j","k"]', `…and the same insert's array into jsonb stores a JSON array (${JSON.stringify(empty[0]?.meta)})`);
  const two = rowsOf(await db.from("widgets").insert({ name: "eta", kind: "tool", score: 2, labels: ["ai", "with, comma", 'quo"te'] }).select("labels"), "insert [a, b]");
  assert(JSON.stringify(two[0]?.labels) === '["ai","with, comma","quo\\"te"]', `elements with a comma and a quote survive the literal (${JSON.stringify(two[0]?.labels)})`);
  const domain = rowsOf(await db.from("crates").insert({ tags: ["a", "b"] }).select("tags"), "domain over text[]");
  assert(JSON.stringify(domain[0]?.tags) === '["a","b"]', `a domain over text[] binds as an array — the type's category decides, not its name (${JSON.stringify(domain[0]?.tags)})`);
  const ints = rowsOf(await db.from("nodes").insert({ name: "counted", counts: [3, 1, 2] }).select("counts"), "int[]");
  assert(Array.isArray(ints[0]?.counts) && JSON.stringify(ints[0]?.counts) === "[3,1,2]", `an int[] column comes back as a list, not the Int32Array Bun decodes it into (${JSON.stringify(ints[0]?.counts)})`);
  await db.from("nodes").delete().eq("name", "counted");
  const upd = rowsOf(await db.from("widgets").update({ labels: ["ai", "ops"] }).eq("name", "zeta").select("labels"), "update");
  assert(JSON.stringify(upd[0]?.labels) === '["ai","ops"]', "update binds an array the same way");
  // contains(): the column's operator — array containment on text[], jsonb containment on jsonb.
  const csArr = namesOf(await db.from("widgets").select("name").contains("labels", ["ai"]).order("id"), "contains text[]");
  assert(csArr === "zeta,eta", `contains() on a text[] column is array @> (${csArr})`);
  const csText = namesOf(await db.from("widgets").select("name").contains("labels", '{"ops"}').order("id"), "contains literal");
  assert(csText === "zeta", `…and takes PostgREST's literal text too (${csText})`);
  const csJson = namesOf(await db.from("widgets").select("name").contains("meta", ["j"]), "contains jsonb array");
  assert(csJson === "zeta", `contains() on a jsonb column with an array is jsonb @> (${csJson})`);
  const orCs = namesOf(await db.from("widgets").select("name").or('meta.cs.["k"],score.gt.90').order("id"), "or cs");
  assert(orCs === "alpha,zeta", `or() takes a cs term — the value parsed to JSON and bound as such, not as a JSON string (${orCs})`);
  const orCsArr = namesOf(await db.from("widgets").select("name").or('labels.cs.{"ops"},score.gt.90').order("id"), "or cs on text[]");
  assert(orCsArr === "alpha,zeta", `…and on an array column, PostgREST's literal (${orCsArr})`);
  const eqArr = namesOf(await db.from("widgets").select("name").eq("labels", ["ai", "ops"]), "eq array");
  assert(eqArr === "zeta", `.eq() against an array column takes a JS array as the literal too — PostgREST's eq.{a,b} (${eqArr})`);
  const inArr = namesOf(await db.from("widgets").select("name").in("labels", [["ai", "ops"], []]).order("id"), "in arrays");
  assert(inArr === "alpha,beta,delta,epsilon,zeta", `…and .in() with array values (the four rows whose labels default to {} and zeta) (${inArr})`);
  const orComma = namesOf(await db.from("widgets").select("name").or('meta.cs.[{"k":"a, b"}],labels.cs.{"with, comma"}').order("id"), "or with commas in values");
  assert(orComma === "eta", `or() keeps a comma inside a cs value's brackets or braces with the value, not as a term boundary (${orComma})`);
  // rpc: a text[] argument by the function's declaration.
  const fn = rowsOf(await db.rpc("widgets_labelled", { p_labels: ["ai"] }), "rpc text[]");
  assert(fn.map((r) => r.name).join() === "zeta,eta", `a text[] argument is bound as an array literal (${fn.map((r) => r.name).join()})`);
  const fnEmpty = rowsOf(await db.rpc("widgets_labelled", { p_labels: [], p_kind: "gadget" }), "rpc []");
  assert(fnEmpty.map((r) => r.name).join() === "delta", `…and [] as an empty one — every gadget contains it; epsilon's kind is NULL since [13] (${fnEmpty.map((r) => r.name).join()})`);
  const { text, values } = await db.from("widgets").insert({ name: "x", labels: ["a"], meta: ["a"] }).select("id").toSQL();
  assert(/VALUES \(\$1, \$2::text\[\], \$3\)/.test(text) && values[1] === '{"a"}' && Array.isArray(values[2]),
    `the literal travels cast to the declared type; the jsonb value travels as itself (${text}; ${JSON.stringify(values)})`);
  await db.from("widgets").delete().in("name", ["zeta", "eta"]);
} catch (e) {
  assert(false, `[15] threw: ${e instanceof Error ? e.message : String(e)}`);
}

console.log("\n[16] The error is an Error (SMD-1588)");
{
  const { error } = await db.from("widgets").insert({ name: "alpha" }).select("id");
  assert(error instanceof Error, "a database error is an Error instance — `throw error` in a caller renders its message, not [object Object]");
  assert(error instanceof PostgrestError && error.name === "PostgrestError" && error.code === "23505", `…of the exported class, carrying the SQLSTATE (${error?.code})`);
  assert(String(error).includes("duplicate key"), `String(error) is the message (${String(error).slice(0, 50)})`);
  const missing = await db.from("widgets").select("name").eq("name", "nope").single();
  assert(missing.error instanceof PostgrestError && missing.error.code === "PGRST116", "the shim's own PGRST116 is one too");
  const fn = await db.rpc("no_such_function");
  assert(fn.error instanceof PostgrestError && fn.error.code === "42883", `an rpc error is one too (${fn.error?.code})`);
}

console.log("\n[17] Resource embedding, one hop (SMD-1588)");
try {
  const alpha = rowsOf(await db.from("widgets").select("id").eq("name", "alpha").limit(1), "alpha id")[0]?.id as number;
  const beta = rowsOf(await db.from("widgets").select("id").eq("name", "beta").limit(1), "beta id")[0]?.id as number;
  rowsOf(await db.from("gizmos").insert([{ widget_id: alpha, label: "g1" }, { widget_id: alpha, label: "g2" }, { widget_id: null, label: "orphan" }]).select("id"), "gizmos");
  // Many-to-one by the table's name, with a column list and whitespace anywhere (the tree's spelling).
  const byTable = rowsOf(await db.from("gizmos").select(`
      *,
      widgets (
        id,
        name
      )
    `).order("id"), "by table");
  assert(byTable.length === 3 && (byTable[0].widgets as { name: string })?.name === "alpha" && Object.keys(byTable[0].widgets as object).join() === "id,name",
    `many-to-one by table name: an object with the named columns, keyed by the table (${JSON.stringify(byTable[0]?.widgets)})`);
  assert(byTable[2].widgets === null, "…and null where the key is null, as PostgREST's is");
  assert(byTable[0].label === "g1" && typeof byTable[0].made_on === "string", "the base row's own columns are there, JSON-shaped");
  // By the foreign-key column, with an alias.
  const byCol = rowsOf(await db.from("gizmos").select("label, w:widget_id (name, score)").eq("label", "g2"), "by column");
  assert(JSON.stringify(byCol[0]?.w) === JSON.stringify({ name: "alpha", score: 99 }), `many-to-one by the key column, keyed by the alias (${JSON.stringify(byCol[0])})`);
  const byColNoAlias = rowsOf(await db.from("gizmos").select("widget_id (name)").eq("label", "g2"), "by column, no alias");
  assert(JSON.stringify(byColNoAlias[0]) === JSON.stringify({ widget_id: { name: "alpha" } }), `…keyed by the column when there is no alias (${JSON.stringify(byColNoAlias[0])})`);
  // One-to-many, with (*).
  const o2m = rowsOf(await db.from("widgets").select("name, gizmos(*)").in("name", ["alpha", "beta"]).order("id"), "one-to-many");
  assert(Array.isArray(o2m[0]?.gizmos) && (o2m[0].gizmos as { label: string }[]).map((g) => g.label).sort().join() === "g1,g2",
    `one-to-many by table name: an array of the rows with every column (${JSON.stringify(o2m[0]?.gizmos)})`);
  assert((o2m[0].gizmos as Record<string, unknown>[])[0].made_on === "2026-09-20", "an embedded date carries Postgres's spelling, as PostgREST's does");
  assert(Array.isArray(o2m[1]?.gizmos) && (o2m[1].gizmos as unknown[]).length === 0, "…and [] where there are none");
  // Embeds compose with filters, order and single().
  const one = await db.from("gizmos").select("label, widgets (name)").eq("label", "g1").single();
  assert(one.error === null && (one.data as unknown as { widgets: { name: string } }).widgets?.name === "alpha", "an embed under single()");
  const { text } = await db.from("gizmos").select("*, widgets (name)").eq("label", "g1").toSQL();
  assert(/SELECT \*, \(SELECT row_to_json\(__r\) FROM \(SELECT __e\."name" FROM "widgets" AS __e WHERE __e\."id" = "gizmos"\."widget_id"\) __r\) AS "widgets" FROM "gizmos" WHERE "label" = \$1/.test(text),
    `the embed is a correlated subquery on the foreign key (${text})`);
  // Refusals, each naming why.
  const refusedMsg = async (run: () => PromiseLike<unknown>) => { try { await run(); return ""; } catch (e) { return (e as Error).message; } };
  assert(/more than one foreign key/.test(await refusedMsg(() => db.from("links").select("*, widgets(name)"))), "two foreign keys to the same table are refused, naming the column form");
  rowsOf(await db.from("links").insert({ a_id: alpha, b_id: beta }).select("id"), "links setup");
  const links = rowsOf(await db.from("links").select("a:a_id (name), b:b_id (name)"), "links read");
  assert(JSON.stringify(links[0]) === JSON.stringify({ a: { name: "alpha" }, b: { name: "beta" } }), `…and the column form serves them (${JSON.stringify(links[0])})`);
  assert(/embedding hint/.test(await refusedMsg(() => db.from("gizmos").select("*, widgets!inner(name)"))), "!inner is refused as a hint");
  assert(/embedding hint/.test(await refusedMsg(() => db.from("gizmos").select("*, widgets!gizmos_widget_id_fkey(name)"))), "!fk_name is refused as a hint");
  assert(/not a single-column foreign key/.test(await refusedMsg(() => db.from("gizmos").select("*, label(name)"))), "a column that is not a foreign key is refused");
  // A one-to-one: the referencing column is unique, so PostgREST gives the one row or null, not a list.
  rowsOf(await db.from("manuals").insert({ widget_id: alpha, pages: 12 }).select("id"), "manual");
  const o2o = rowsOf(await db.from("widgets").select("name, manuals(pages)").in("name", ["alpha", "beta"]).order("id"), "one-to-one");
  assert(JSON.stringify(o2o[0]?.manuals) === JSON.stringify({ pages: 12 }) && o2o[1]?.manuals === null, `a one-to-one embed is the row or null, as PostgREST's is — not [row] and [] (${JSON.stringify(o2o.map((r) => r.manuals))})`);
  // A self-reference: the table's name does not say which side; the column form does.
  rowsOf(await db.from("nodes").insert([{ name: "root" }]).select("id"), "root");
  const root = rowsOf(await db.from("nodes").select("id").eq("name", "root"), "root id")[0]?.id as number;
  rowsOf(await db.from("nodes").insert({ name: "leaf", parent_id: root }).select("id"), "leaf");
  assert(/in itself/.test(await refusedMsg(() => db.from("nodes").select("*, nodes(name)"))), "embedding a table in itself by name is refused, naming the column form");
  const parent = rowsOf(await db.from("nodes").select("name, parent:parent_id (name)").eq("name", "leaf"), "self by column");
  assert(JSON.stringify(parent[0]) === JSON.stringify({ name: "leaf", parent: { name: "root" } }), `…and the column form serves it (${JSON.stringify(parent[0])})`);
  // A same-named table in a schema off the search path carries a foreign key the visible one lacks: it is not
  // counted under the visible table's name, which the join would have reached (the silent wrong join).
  await new SQL({ url: URL_, max: 1 }).unsafe(`INSERT INTO hidden.kids (widget_id, v) VALUES (${alpha}, 'the hidden table''s row')`).then(() => {});
  assert(/no foreign key joins it/.test(await refusedMsg(() => db.from("widgets").select("*, kids(v)"))), "a foreign key on an invisible same-named table is not the visible table's — refused, not joined to the wrong rows");
  // A table the catalog cannot see: the query reports it, not a refusal about foreign keys.
  const ghost = await db.from("no_such_table").select("*, widgets(name)");
  assert(ghost.error !== null && ghost.error.code === "42P01", `an embed on a missing table is the missing table's error, as without the embed (${ghost.error?.code})`);
  assert(/RETURNING list/.test(await refusedMsg(() => db.from("gizmos").insert({ label: "x" }).select("*, widgets(name)"))), "an embed in a RETURNING list is refused");
  assert(/Identifiers must match/.test(await refusedMsg(() => db.from("gizmos").select("widgets(name, meta->>k)"))), "a JSON path inside an embed is refused");
  assert(/with no columns/.test(await refusedMsg(() => db.from("gizmos").select("count()"))), "an aggregate — a name with empty parentheses — is refused");
  assert(/not a column or a one-hop embed/.test(await refusedMsg(() => db.from("gizmos").select("widgets(name)x"))), "text around an embed is refused");
  const survived = await db.from("widgets").select("id", { count: "exact", head: true });
  assert(survived.count === 4, "…and the table still exists");
} catch (e) {
  assert(false, `[17] threw: ${e instanceof Error ? e.message : String(e)}`);
}

console.log("\n[18] The catalog forgets an empty answer (SMD-1588)");
try {
  // A query before the table exists: the error PostgREST would give; then the table appears, and the next
  // call binds its array column by type — a cached "no columns" would have sent the array raw for the process's life.
  const before = await db.from("latecomers").select("id");
  assert(before.error !== null && before.error.code === "42P01", `a table that does not exist yet is a runtime error (${before.error?.code})`);
  const admin = new SQL({ url: URL_, max: 1 });
  await admin`CREATE TABLE latecomers (id serial PRIMARY KEY, tags text[] DEFAULT '{}')`;
  const after = rowsOf(await db.from("latecomers").insert({ tags: ["late", "comer"] }).select("tags"), "insert after create");
  assert(JSON.stringify(after[0]?.tags) === '["late","comer"]', `…and once it exists, its array column binds by type (${JSON.stringify(after[0]?.tags)})`);
  // A column added after the first read: naming it makes the catalog read the table again.
  await admin`ALTER TABLE latecomers ADD COLUMN aliases text[] DEFAULT '{}'`;
  const grown = rowsOf(await db.from("latecomers").insert({ aliases: ["x"] }).select("aliases"), "insert into a new column");
  assert(JSON.stringify(grown[0]?.aliases) === '["x"]', `a column added under a running client binds by type on its first use — the map is re-read when a named column is missing (${JSON.stringify(grown[0]?.aliases)})`);
  // A column the table does not have: one re-read, then remembered as absent — not a read per call.
  const typo1 = await db.from("latecomers").select("id").eq("nmae", "x");
  const typo2 = await db.from("latecomers").select("id").eq("nmae", "x");
  assert(typo1.error?.code === "42703" && typo2.error?.code === "42703", "a column the table lacks is Postgres's 42703, both times");
  await admin`DROP TABLE latecomers`;
  await admin.close();
} catch (e) {
  assert(false, `[18] threw: ${e instanceof Error ? e.message : String(e)}`);
}

await db.close();

report();
