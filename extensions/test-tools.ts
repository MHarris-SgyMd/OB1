#!/usr/bin/env bun
/**
 * test-tools.ts — every tool of the eight MCP servers with a schema of their
 * own on the SQL shim — seven extension servers and the ob-graph recipe —
 * answers against a real Postgres carrying those schemas.
 *
 * SMD-1798 added the three servers that were still on supabase-js — family-
 * calendar, job-hunt and ob-graph, held there by a grouped `.or()`, a
 * three-level `!inner` embed, an `in.(…)` list and a `!fk_name` hint the shim
 * did not read until that change — so a shim gap in any of those shapes fails
 * a named assertion here too. (enhanced-mcp, agent-memory-api and the
 * metadata worker, the other three that moved, need the model provider
 * stubbed and the fork's own tables; test-writes.ts drives them.)
 *
 * SMD-1588 (FORK.md change 77). Fix 13 moved these servers onto
 * compat/supabase-sql by changing one import line and never drove them; change
 * 74's review did, and seven of their tools failed on the shim itself — no
 * `.not()`, four embedded selects the codemod's blocker regex had let through,
 * a JavaScript array bound as its `String()` into a `text[]` column — and two
 * more rendered their error paths as `[object Object]`. Driving every argument
 * branch here found two more (a tag filter through `.contains()` on a `text[]`
 * column, an ingredient filter through `.or()`'s `cs`). A "runs on the fork"
 * claim needs the tools driven, not the process started: this suite is where
 * a shim gap fails a named assertion instead of a user's first call.
 *
 * Each server is imported as deployed under the stand-in for Deno's two
 * globals test-auth.ts and test-writes.ts use, and every tool it registers is
 * called through `tools/call` with the arguments its schema describes — each
 * optional filter on its own, each error path the tool documents — and what
 * comes back is read: the row a write stored, the rows a read chose, the
 * embedded relation as an object or null, the trigger's effect, the message a
 * failure carries. The database is the fork's migrations (crm_link_thought
 * reads `thoughts`) plus the four `schema.sql` files, applied as their READMEs'
 * Step 1 says — after the two `auth.*` stubs a plain Postgres lacks — and
 * dropped again at the end, whether or not the run finished, because CI shares
 * one Postgres across the job. The role that connects owns the tables, so the
 * row-level-security policies do not apply to it, as the READMEs say.
 *
 * The drift guard: each server's `tools/list` under a write key is exactly the
 * set of tools driven here, so a tool added to a server fails this suite until
 * it is driven. Fifty-five tools on eight servers: twenty-nine on the five
 * change 77 drove (SMD-1588's "twenty-five" counted the four `index.ts` files;
 * the shared meal-planning server's four are the rest), six on family-calendar,
 * ten on job-hunt and ten on ob-graph.
 *
 *   ../db/with-postgres.sh bun test-tools.ts
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SQL } from "bun";
import { createAssert, requireDatabaseUrl, resetSchema } from "../db/test-support.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const URL_ = requireDatabaseUrl("test-tools.ts");
const { assert, report } = createAssert();

// ── The database: the fork's schema, the READMEs' stubs, the four extension schemas ──

// The width is pinned as test-writes.ts pins it: one thought is planted through upsert_thought for crm_link_thought, and no
// vector is involved.
await resetSchema(URL_, { dim: 1536, model: "openai/text-embedding-3-small" });
const sql = new SQL({ url: URL_, max: 2 });

/** The eight servers, by the schema that owns their tables (the shared server reads meal-planning's; job-hunt's last tool writes into professional-crm's). */
const SCHEMAS = ["extensions/household-knowledge/schema.sql", "extensions/home-maintenance/schema.sql", "extensions/meal-planning/schema.sql", "extensions/professional-crm/schema.sql",
  "extensions/family-calendar/schema.sql", "extensions/job-hunt/schema.sql", "recipes/ob-graph/schema.sql"];
const schemaText = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
/** What the schemas create, dropped before they are applied and at the end. meal-planning's and family-calendar's CREATE TABLE have no IF NOT EXISTS. */
async function dropExtensionSchemas() {
  for (const rel of SCHEMAS) {
    const text = schemaText(rel);
    for (const m of text.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)) await sql.unsafe(`DROP TABLE IF EXISTS public.${m[1]} CASCADE`);
    for (const m of text.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\s*\(/g)) await sql.unsafe(`DROP FUNCTION IF EXISTS public.${m[1]} CASCADE`);
  }
}
await dropExtensionSchemas();
// The READMEs' Step 1: the two Supabase functions the RLS policies call, created plain (a Supabase database has them; a
// throwaway one does not — dropped first here so a re-run on a kept database applies cleanly), and the three Supabase
// roles ob-graph's GRANT and REVOKE statements name, as its README says to create them.
await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS auth;
  DROP FUNCTION IF EXISTS auth.uid(); DROP FUNCTION IF EXISTS auth.jwt();
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
  CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS 'SELECT ''{}''::jsonb';`);
for (const role of ["authenticated", "service_role", "anon"]) {
  await sql.unsafe(`DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $r$`);
}
for (const rel of SCHEMAS) await sql.unsafe(schemaText(rel));

// ── Deno's two globals, and the environment the READMEs document ────────────

type Handler = (req: Request) => Response | Promise<Response>;
const served: Handler[] = [];
(globalThis as unknown as { Deno: unknown }).Deno = {
  env: { get: (name: string) => process.env[name] },
  serve: (a: Handler | object, b?: Handler) => {
    served.push(typeof a === "function" ? a : b!);
    return { finished: Promise.resolve() };
  },
};

const KEY = "one-write-key-for-every-tool";
const USER = "11111111-1111-4111-8111-111111111111";
process.env.SUPABASE_URL = URL_;
process.env.MCP_ACCESS_KEY = KEY;
process.env.MCP_HOUSEHOLD_ACCESS_KEY = KEY;
process.env.DEFAULT_USER_ID = USER;
for (const name of ["MCP_ACCESS_KEYS", "MCP_HOUSEHOLD_ACCESS_KEYS", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_HOUSEHOLD_KEY", "OB1_PG_POOL"]) delete process.env[name];

/** Each server's handler by file, for the drift guard at the end. */
const handlers = new Map<string, Handler>();
async function load(rel: string): Promise<Handler> {
  const before = served.length;
  await import(join(ROOT, rel));
  assert(served.length === before + 1, `${rel} imports as deployed and hands Deno.serve one handler`);
  handlers.set(rel, served[before]);
  return served[before];
}

// ── One request ──────────────────────────────────────────────────────────────

const HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-brain-key": KEY };
type Reply = { status: number; json: any; text: string };
async function send(handler: Handler, body: unknown): Promise<Reply> {
  const console_ = { error: console.error, warn: console.warn };
  console.error = () => {}; console.warn = () => {}; // a tool logs what it could not fetch; the reply is the assertion
  let r: Response;
  try {
    r = await handler(new Request("http://extension.test/mcp", { method: "POST", headers: HEADERS, body: JSON.stringify(body) }));
  } finally {
    Object.assign(console, console_);
  }
  const text = await r.text();
  const line = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6);
  let json: any = null;
  try { json = line ? JSON.parse(line) : null; } catch { json = null; }
  return { status: r.status, json, text };
}
/** Every tool called on each server — the drift guard compares it with tools/list. */
const driven = new Map<string, Set<string>>();
type Called = Reply & { toolText: string; isError: boolean; body: any };
/** An MCP tools/call: the tool's first text block, parsed where it is JSON (every tool here answers JSON text). */
async function call(file: string, handler: Handler, name: string, args: Record<string, unknown>): Promise<Called> {
  (driven.get(file) ?? driven.set(file, new Set()).get(file)!).add(name);
  const r = await send(handler, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const toolText = String(r.json?.result?.content?.[0]?.text ?? "");
  let body: any = null;
  try { body = JSON.parse(toolText); } catch { body = null; }
  return { ...r, toolText, isError: r.json?.result?.isError === true, body };
}
async function toolsOf(handler: Handler): Promise<string[]> {
  const r = await send(handler, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  return ((r.json?.result?.tools ?? []) as { name: string }[]).map((t) => t.name).sort();
}
/** A tool's success reply: HTTP 200, not isError, and — for the tools that say so — success: true. */
const ok = (r: Called) => r.status === 200 && !r.isError && r.body !== null && r.body?.success !== false;
/** What a tool's failure says: its `{ success: false, error }` body, or the SDK's isError text for a thrown error. */
const failure = (r: Called) => (r.body?.success === false ? String(r.body?.error) : r.isError ? r.toolText : "");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_ROW = "00000000-0000-4000-8000-00000000dead";
const isoDaysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const dateDaysFromNow = (days: number) => isoDaysFromNow(days).slice(0, 10);
const eqJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Everything below runs inside one try so the schemas are dropped however it ends.
try {

// ── extensions/household-knowledge ───────────────────────────────────────────

{
  const F = "extensions/household-knowledge/index.ts";
  console.log(`\n[${F}]`);
  const h = await load(F);
  const c = (name: string, args: Record<string, unknown>) => call(F, h, name, args);

  const paint = await c("add_household_item", { name: "Living Room Paint", category: "paint", location: "Living Room", details: '{"brand":"Sherwin Williams","color":"Sea Salt"}', notes: "two gallons, March" });
  assert(ok(paint) && UUID.test(paint.body?.item?.id), `add_household_item stores the row (${failure(paint) || paint.body?.item?.id})`);
  assert(paint.body?.item?.details?.brand === "Sherwin Williams", "…with details parsed into jsonb, not an escaped string");
  const badJson = await c("add_household_item", { name: "x", details: "not json" });
  assert(!ok(badJson) && /not valid JSON/.test(failure(badJson)), `…and refuses details that are not JSON with its own message (${failure(badJson).slice(0, 60)})`);
  const dishwasher = await c("add_household_item", { name: "Dishwasher", category: "appliance", location: "Kitchen" });
  assert(ok(dishwasher) && eqJson(dishwasher.body?.item?.details, {}), "a second item, details defaulting to {}");

  const plumber = await c("add_vendor", { name: "Ann the Plumber", service_type: "plumber", phone: "555-0100", rating: 5, last_used: "2026-09-01" });
  assert(ok(plumber) && UUID.test(plumber.body?.vendor?.id) && plumber.body?.vendor?.rating === 5, `add_vendor stores the row (${failure(plumber)})`);

  const byQuery = await c("search_household_items", { query: "paint" });
  assert(ok(byQuery) && byQuery.body?.count === 1 && byQuery.body?.items?.[0]?.name === "Living Room Paint", `search_household_items by query — the .or() across four columns (${failure(byQuery) || byQuery.body?.count})`);
  const byFilters = await c("search_household_items", { category: "appl", location: "kitch" });
  assert(ok(byFilters) && byFilters.body?.count === 1 && byFilters.body?.items?.[0]?.name === "Dishwasher", "…by category and location, ILIKE both");
  const comma = await c("search_household_items", { query: "Sea, Salt" });
  assert(!ok(comma) && comma.body?.success === false && /PGRST100/.test(failure(comma)), `…a query with a comma splits the .or() expression as it would through PostgREST (400), and the tool's own error handling reports PostgREST's code — the shim resolved { error }, it did not throw (${failure(comma).slice(0, 80)})`);
  // An item whose name carries a parenthesis and a quote, found by the unbalanced prefix a person types: under a
  // splitter that read brackets and quotes inside a value, the terms after the first were swallowed and this was 0.
  const tap = await c("add_household_item", { name: 'Kitchen (main) 12" tap', category: "plumbing", location: "Kitchen" });
  assert(ok(tap), "an item named with a parenthesis and a quote is stored");
  const parenQuery = await c("search_household_items", { query: "Kitchen (main" });
  assert(ok(parenQuery) && parenQuery.body?.count === 1 && parenQuery.body?.items?.[0]?.name === 'Kitchen (main) 12" tap', `…a query with an unclosed parenthesis is pattern text through all four ILIKE terms and finds it (${failure(parenQuery) || parenQuery.body?.count})`);
  const quoteQuery = await c("search_household_items", { query: '12" tap' });
  assert(ok(quoteQuery) && quoteQuery.body?.count === 1, `…as is one with a quote (${failure(quoteQuery) || quoteQuery.body?.count})`);
  const none = await c("search_household_items", { query: "nothing-of-the-kind" });
  assert(ok(none) && none.body?.count === 0 && eqJson(none.body?.items, []), "…and none is an empty list");
  const all = await c("search_household_items", {});
  assert(ok(all) && all.body?.count === 3 && all.body?.items?.[0]?.name === 'Kitchen (main) 12" tap', "…no filter lists every item, newest first");

  const details = await c("get_item_details", { item_id: paint.body?.item.id });
  assert(ok(details) && details.body?.item?.name === "Living Room Paint" && typeof details.body?.item?.created_at === "string", `get_item_details finds the row, timestamps as strings (${failure(details)})`);
  const missing = await c("get_item_details", { item_id: NO_ROW });
  assert(!ok(missing) && /Failed to get item details: .*rows returned/.test(failure(missing)), `…and a missing id is the tool's own error with PostgREST's message (${failure(missing).slice(0, 70)})`);

  const vendors = await c("list_vendors", {});
  assert(ok(vendors) && vendors.body?.count === 1 && vendors.body?.vendors?.[0]?.name === "Ann the Plumber", `list_vendors (${failure(vendors)})`);
  const plumbers = await c("list_vendors", { service_type: "plumb" });
  assert(ok(plumbers) && plumbers.body?.count === 1, "…filtered by service type, ILIKE");
  const electricians = await c("list_vendors", { service_type: "electric" });
  assert(ok(electricians) && electricians.body?.count === 0, "…and none for a type nobody has");
}

// ── extensions/home-maintenance ──────────────────────────────────────────────

{
  const F = "extensions/home-maintenance/index.ts";
  console.log(`\n[${F}]`);
  const h = await load(F);
  const c = (name: string, args: Record<string, unknown>) => call(F, h, name, args);

  const hvac = await c("add_maintenance_task", { name: "HVAC filter replacement", category: "hvac", frequency_days: 90, next_due: isoDaysFromNow(20), priority: "high", notes: "16x25x1 pleated" });
  assert(ok(hvac) && UUID.test(hvac.body?.task?.id) && hvac.body?.task?.priority === "high", `add_maintenance_task stores the row (${failure(hvac)})`);
  assert(typeof hvac.body?.task?.next_due === "string", "…next_due back as a string");
  const gutter = await c("add_maintenance_task", { name: "Gutter cleaning", category: "exterior" });
  assert(ok(gutter) && gutter.body?.task?.next_due === null && gutter.body?.task?.frequency_days === null && gutter.body?.task?.priority === "medium", "a one-time task with no due date, priority defaulted");
  const roof = await c("add_maintenance_task", { name: "Roof inspection", category: "exterior", next_due: isoDaysFromNow(5 * 365) });
  assert(ok(roof), "a task due years out");

  // .not("next_due", "is", null): the gutter task (no date) is out, the roof (beyond the window) is out.
  const upcoming = await c("get_upcoming_maintenance", { days_ahead: 30 });
  assert(ok(upcoming) && upcoming.body?.count === 1 && upcoming.body?.tasks?.[0]?.name === "HVAC filter replacement",
    `get_upcoming_maintenance lists the task due inside the window and leaves out the undated one — .not("next_due", "is", null) (${failure(upcoming) || JSON.stringify(upcoming.body?.tasks?.map((t: any) => t.name))})`);
  const farther = await c("get_upcoming_maintenance", { days_ahead: 10 * 365 });
  assert(ok(farther) && farther.body?.count === 2 && farther.body?.tasks?.[1]?.name === "Roof inspection", "…a wider window takes in the roof, ordered by due date, and still not the undated task");

  const hvacDone = isoDaysFromNow(-10);
  const logged = await c("log_maintenance", { task_id: hvac.body?.task.id, completed_at: hvacDone, performed_by: "self", cost: 45.5, notes: "changed the filter", next_action: "check the coil" });
  assert(ok(logged) && UUID.test(logged.body?.log?.id) && logged.body?.log?.cost === "45.50", `log_maintenance stores the log (${failure(logged) || JSON.stringify(logged.body?.log?.cost)})`);
  // The trigger adds an interval, which is calendar arithmetic in the database's time zone (a DST edge inside the
  // ninety days is an hour off the client's millisecond sum): the expectation is the database's own answer.
  const [{ due }] = await sql`SELECT (${hvacDone}::timestamptz + interval '90 days') AS due`;
  assert(logged.body?.updated_task?.last_completed === hvacDone && logged.body?.updated_task?.next_due === (due as Date).toISOString(),
    `…and reads the task the trigger moved: last_completed is the log's time, next_due 90 days on (${logged.body?.updated_task?.next_due})`);
  const gutterDone = isoDaysFromNow(-4);
  const loggedOnce = await c("log_maintenance", { task_id: gutter.body?.task.id, completed_at: gutterDone, performed_by: "Ann the Plumber" });
  assert(ok(loggedOnce) && loggedOnce.body?.updated_task?.next_due === null && loggedOnce.body?.updated_task?.last_completed === gutterDone, "a one-time task logged stays undated, last_completed set");
  const orphan = await c("log_maintenance", { task_id: NO_ROW });
  assert(!ok(orphan) && /Failed to log maintenance: .*foreign key/.test(failure(orphan)), `a log for no task is the tool's own error with the constraint's message (${failure(orphan).slice(0, 70)})`);

  // The embedded select: `*, maintenance_tasks ( id, name, category )` — the task nested on every log.
  const history = await c("search_maintenance_history", {});
  assert(ok(history) && history.body?.count === 2, `search_maintenance_history lists both logs (${failure(history) || history.body?.count})`);
  const hvacLog = history.body?.logs?.find((l: any) => l.task_id === hvac.body?.task.id);
  assert(hvacLog?.maintenance_tasks?.name === "HVAC filter replacement" && hvacLog?.maintenance_tasks?.category === "hvac" && Object.keys(hvacLog?.maintenance_tasks ?? {}).sort().join() === "category,id,name",
    `…each with its task embedded as an object of the three named columns (${JSON.stringify(hvacLog?.maintenance_tasks)})`);
  assert(history.body?.logs?.[0]?.task_id === gutter.body?.task.id, "…newest completion first");
  const byName = await c("search_maintenance_history", { task_name: "hvac" });
  assert(ok(byName) && byName.body?.count === 1 && byName.body?.logs?.[0]?.notes === "changed the filter", "…filtered by task name (the id list through .in())");
  const byCategory = await c("search_maintenance_history", { category: "exter" });
  assert(ok(byCategory) && byCategory.body?.count === 1 && byCategory.body?.logs?.[0]?.performed_by === "Ann the Plumber", "…by category");
  const noTask = await c("search_maintenance_history", { task_name: "zzz" });
  assert(ok(noTask) && noTask.body?.count === 0 && eqJson(noTask.body?.logs, []), "…a name no task has answers an empty list");
  const since = await c("search_maintenance_history", { date_from: isoDaysFromNow(-7) });
  assert(ok(since) && since.body?.count === 1 && since.body?.logs?.[0]?.task_id === gutter.body?.task.id, "…date_from keeps the recent log");
  const until = await c("search_maintenance_history", { date_to: isoDaysFromNow(-7) });
  assert(ok(until) && until.body?.count === 1 && until.body?.logs?.[0]?.task_id === hvac.body?.task.id, "…date_to keeps the older one");
}

// ── extensions/meal-planning: index.ts, then the shared server on the same rows ──

const WEEK = "2026-09-21";
let pastaId = "", saladId = "", shoppingListId = "";
{
  const F = "extensions/meal-planning/index.ts";
  console.log(`\n[${F}]`);
  const h = await load(F);
  const c = (name: string, args: Record<string, unknown>) => call(F, h, name, args);

  // tags is TEXT[], ingredients and instructions JSONB: one insert, two array bindings.
  const pasta = await c("add_recipe", { name: "Pasta al limone", cuisine: "italian", prep_time_minutes: 10, cook_time_minutes: 20, servings: 4,
    ingredients: [{ name: "spaghetti", quantity: "400", unit: "g" }, { name: "olive oil", quantity: "2", unit: "tbsp" }], instructions: ["boil", "toss"], tags: ["quick", "vegetarian"], rating: 5 });
  assert(pasta.status === 200 && !pasta.isError && UUID.test(pasta.body?.id), `add_recipe stores the row (${pasta.isError ? pasta.toolText.slice(0, 80) : pasta.body?.id})`);
  pastaId = pasta.body?.id ?? "";
  assert(eqJson(pasta.body?.tags, ["quick", "vegetarian"]), `…tags into text[] as an array (${JSON.stringify(pasta.body?.tags)})`);
  assert(eqJson(pasta.body?.instructions, ["boil", "toss"]) && pasta.body?.ingredients?.[1]?.name === "olive oil", "…instructions and ingredients into jsonb as JSON arrays — the same insert, bound by column type");
  const salad = await c("add_recipe", { name: "Green salad", cuisine: "french", ingredients: [{ name: "lettuce", quantity: "1", unit: "head" }, { name: "olive oil", quantity: "1", unit: "tbsp" }], instructions: [], tags: [] });
  assert(!salad.isError && UUID.test(salad.body?.id) && eqJson(salad.body?.tags, []) && eqJson(salad.body?.instructions, []), `an empty tags array and empty instructions store as empty (${JSON.stringify(salad.body?.tags)})`);
  saladId = salad.body?.id ?? "";
  const noTags = await c("add_recipe", { name: "Toast", ingredients: [{ name: "bread", quantity: "2", unit: "slices" }], instructions: ["toast"] });
  assert(!noTags.isError && eqJson(noTags.body?.tags, []), "tags left out defaults to []");

  const every = await c("search_recipes", {});
  assert(!every.isError && Array.isArray(every.body) && every.body?.length === 3 && every.body[0]?.name === "Toast", `search_recipes lists all, newest first (${every.isError ? every.toolText.slice(0, 60) : every.body?.length})`);
  const byName = await c("search_recipes", { query: "pasta" });
  assert(!byName.isError && byName.body?.length === 1 && byName.body[0]?.name === "Pasta al limone", "…by name, ILIKE");
  const byCuisine = await c("search_recipes", { cuisine: "french" });
  assert(!byCuisine.isError && byCuisine.body?.length === 1 && byCuisine.body[0]?.name === "Green salad", "…by cuisine");
  const byTag = await c("search_recipes", { tag: "quick" });
  assert(!byTag.isError && byTag.body?.length === 1 && byTag.body[0]?.name === "Pasta al limone", `…by tag — .contains() on a text[] column is array containment (${byTag.isError ? byTag.toolText.slice(0, 60) : byTag.body?.length})`);
  const byNoTag = await c("search_recipes", { tag: "nope" });
  assert(!byNoTag.isError && byNoTag.body?.length === 0, "…a tag no recipe has finds none");
  const byIngredient = await c("search_recipes", { ingredient: "olive oil" });
  assert(!byIngredient.isError && byIngredient.body?.length === 2, `…by ingredient — .or("ingredients.cs.[…]") is jsonb containment on the array of objects (${byIngredient.isError ? byIngredient.toolText.slice(0, 60) : byIngredient.body?.length})`);
  const commaIngredient = await c("search_recipes", { ingredient: "olive oil, extra virgin" });
  assert(!commaIngredient.isError && Array.isArray(commaIngredient.body) && commaIngredient.body.length === 0, `…an ingredient with a comma is a value, not two .or() terms, and finds none (${commaIngredient.isError ? commaIngredient.toolText.slice(0, 80) : commaIngredient.body?.length})`);
  const byOneIngredient = await c("search_recipes", { ingredient: "lettuce" });
  assert(!byOneIngredient.isError && byOneIngredient.body?.length === 1 && byOneIngredient.body[0]?.name === "Green salad", "…and one where one recipe has it");

  const updated = await c("update_recipe", { recipe_id: pastaId, tags: ["quick"], rating: 4, notes: "less lemon" });
  assert(!updated.isError && eqJson(updated.body?.tags, ["quick"]) && updated.body?.rating === 4 && updated.body?.notes === "less lemon", `update_recipe replaces tags and fields (${updated.isError ? updated.toolText.slice(0, 60) : JSON.stringify(updated.body?.tags)})`);
  // `if (error) throw error`: the SDK renders a thrown Error's message; a thrown plain object was "[object Object]".
  const badId = await c("update_recipe", { recipe_id: "not-a-uuid", name: "x" });
  assert(badId.isError && /invalid input syntax for type uuid/.test(badId.toolText), `update_recipe on a malformed id fails with the database's message, not [object Object] (${badId.toolText.slice(0, 70)})`);
  const noRow = await c("update_recipe", { recipe_id: NO_ROW, name: "x" });
  assert(noRow.isError && /rows returned/.test(noRow.toolText), `…and on no row, with .single()'s PostgREST message (${noRow.toolText.slice(0, 70)})`);

  const plan = await c("create_meal_plan", { week_start: WEEK, meals: [
    { day_of_week: "monday", meal_type: "dinner", recipe_id: pastaId, servings: 4 },
    { day_of_week: "tuesday", meal_type: "lunch", custom_meal: "leftovers" },
    { day_of_week: "tuesday", meal_type: "dinner", recipe_id: saladId, notes: "light" },
  ] });
  assert(!plan.isError && Array.isArray(plan.body) && plan.body?.length === 3 && plan.body?.every((m: any) => UUID.test(m.id)), `create_meal_plan inserts the batch (${plan.isError ? plan.toolText.slice(0, 60) : plan.body?.length})`);
  const badMeal = await c("create_meal_plan", { week_start: WEEK, meals: [{ day_of_week: "monday", meal_type: "brunch" }] });
  assert(badMeal.isError && /meal_plans_meal_type_check/.test(badMeal.toolText), `a meal type the CHECK refuses fails with the constraint's name (${badMeal.toolText.slice(0, 70)})`);

  // The embedded select: `*, recipes:recipe_id (name, cuisine, prep_time_minutes, cook_time_minutes)` — by the key column, aliased.
  const week = await c("get_meal_plan", { week_start: WEEK });
  assert(!week.isError && Array.isArray(week.body) && week.body?.length === 3, `get_meal_plan lists the week (${week.isError ? week.toolText.slice(0, 80) : week.body?.length})`);
  assert(week.body?.map((m: any) => `${m.day_of_week}/${m.meal_type}`).join() === "monday/dinner,tuesday/dinner,tuesday/lunch", "…ordered by day then meal type");
  assert(eqJson(week.body?.[0]?.recipes, { name: "Pasta al limone", cuisine: "italian", prep_time_minutes: 10, cook_time_minutes: 20 }),
    `…each recipe meal carries its recipe as an object of the four named columns, keyed by the alias (${JSON.stringify(week.body?.[0]?.recipes)})`);
  assert(week.body?.[2]?.recipes === null && week.body?.[2]?.custom_meal === "leftovers", "…and a custom meal's recipe is null");
  assert(week.body?.[0]?.week_start === WEEK, `…the week_start date column is the bare date PostgREST gives (${week.body?.[0]?.week_start})`);
  const emptyWeek = await c("get_meal_plan", { week_start: "2020-01-06" });
  assert(!emptyWeek.isError && eqJson(emptyWeek.body, []), "an unplanned week is an empty list");

  // Aggregation over the embed: two recipes share olive oil in the same unit.
  const list = await c("generate_shopping_list", { week_start: WEEK });
  assert(!list.isError && UUID.test(list.body?.id) && Array.isArray(list.body?.items), `generate_shopping_list writes the list (${list.isError ? list.toolText.slice(0, 80) : list.body?.id})`);
  shoppingListId = list.body?.id ?? "";
  const items = (list.body?.items ?? []) as { name: string; quantity: string; unit: string; purchased: boolean; recipe_id: string }[];
  assert(items.map((i) => i.name).sort().join() === "lettuce,olive oil,spaghetti", `…with the two recipes' ingredients, read through the embed (${items.map((i) => i.name).join()})`);
  assert(items.find((i) => i.name === "olive oil")?.quantity === "2 + 1" && items.find((i) => i.name === "spaghetti")?.recipe_id === pastaId && items.every((i) => i.purchased === false),
    "…the shared ingredient aggregated, each item naming its recipe, none purchased");
  const again = await c("generate_shopping_list", { week_start: WEEK });
  assert(!again.isError && again.body?.id === shoppingListId && typeof again.body?.updated_at === "string", "…and a second run updates the same list");
}

{
  const F = "extensions/meal-planning/shared-server.ts";
  console.log(`\n[${F}]`);
  const h = await load(F);
  const c = (name: string, args: Record<string, unknown>) => call(F, h, name, args);

  const week = await c("view_meal_plan", { user_id: USER, week_start: WEEK });
  assert(!week.isError && week.body?.length === 3 && eqJson(week.body?.[0]?.recipes, { name: "Pasta al limone", cuisine: "italian", prep_time_minutes: 10, cook_time_minutes: 20, servings: 4 }),
    `view_meal_plan embeds the recipe with servings too (${week.isError ? week.toolText.slice(0, 80) : JSON.stringify(week.body?.[0]?.recipes)})`);
  const other = await c("view_meal_plan", { user_id: NO_ROW, week_start: WEEK });
  assert(!other.isError && eqJson(other.body, []), "…another user's week is empty");

  const recipes = await c("view_recipes", { user_id: USER });
  assert(!recipes.isError && recipes.body?.length === 3 && Object.keys(recipes.body?.[0] ?? {}).sort().join() === "cook_time_minutes,cuisine,id,name,prep_time_minutes,rating,servings,tags",
    `view_recipes lists the named columns only (${recipes.isError ? recipes.toolText.slice(0, 60) : Object.keys(recipes.body?.[0] ?? {}).join()})`);
  const tagged = await c("view_recipes", { user_id: USER, tag: "quick" });
  assert(!tagged.isError && tagged.body?.length === 1 && tagged.body[0]?.name === "Pasta al limone", "…by tag, array containment");
  const named = await c("view_recipes", { user_id: USER, query: "sal", cuisine: "french" });
  assert(!named.isError && named.body?.length === 1 && named.body[0]?.name === "Green salad", "…by name and cuisine");

  const list = await c("view_shopping_list", { user_id: USER, week_start: WEEK });
  assert(!list.isError && list.body?.id === shoppingListId && list.body?.items?.length === 3, `view_shopping_list finds the week's list (${list.isError ? list.toolText.slice(0, 60) : list.body?.id})`);
  const noList = await c("view_shopping_list", { user_id: USER, week_start: "2020-01-06" });
  assert(noList.isError && /rows returned/.test(noList.toolText), `…and a week without one fails with .single()'s message, not [object Object] (${noList.toolText.slice(0, 70)})`);

  const marked = await c("mark_item_purchased", { shopping_list_id: shoppingListId, item_name: "spaghetti", purchased: true });
  const after = (marked.body?.items ?? []) as { name: string; purchased: boolean }[];
  assert(!marked.isError && after.find((i) => i.name === "spaghetti")?.purchased === true && after.filter((i) => i.purchased).length === 1,
    `mark_item_purchased flips the one item (${marked.isError ? marked.toolText.slice(0, 60) : JSON.stringify(after.map((i) => [i.name, i.purchased]))})`);
  const noSuchList = await c("mark_item_purchased", { shopping_list_id: NO_ROW, item_name: "x", purchased: true });
  assert(noSuchList.isError && /rows returned/.test(noSuchList.toolText), "…and a missing list fails with the message");
}

// ── extensions/professional-crm ──────────────────────────────────────────────

{
  const F = "extensions/professional-crm/index.ts";
  console.log(`\n[${F}]`);
  const h = await load(F);
  const c = (name: string, args: Record<string, unknown>) => call(F, h, name, args);

  const ada = await c("crm_add_contact", { name: "Ada Lovelace", company: "Analytical Engines", title: "Engineer", email: "ada@example.test", how_we_met: "a conference", tags: ["ai", "math"], notes: "met at the engine talk" });
  assert(ok(ada) && UUID.test(ada.body?.contact?.id) && eqJson(ada.body?.contact?.tags, ["ai", "math"]), `crm_add_contact stores tags into text[] (${failure(ada) || JSON.stringify(ada.body?.contact?.tags)})`);
  const bob = await c("crm_add_contact", { name: "Bob Builder", company: "Bricks", tags: [] });
  assert(ok(bob) && eqJson(bob.body?.contact?.tags, []), `…and tags: [] — the ticket's 22P02 case — as an empty array (${failure(bob)})`);
  const cy = await c("crm_add_contact", { name: "Cy Nolan" });
  assert(ok(cy) && eqJson(cy.body?.contact?.tags, []), "…and no tags as []");
  const ids = { ada: ada.body?.contact?.id as string, bob: bob.body?.contact?.id as string, cy: cy.body?.contact?.id as string };

  // Full-text search through crm_search_contacts_fts(search_tags text[]): the tool falls back to ILIKE on an rpc error and
  // says so in search_mode — so "fts" is the assertion that the text[] argument bound.
  const fts = await c("crm_search_contacts", { query: "engineer" });
  assert(ok(fts) && fts.body?.search_mode === "fts" && fts.body?.count === 1 && fts.body?.contacts?.[0]?.name === "Ada Lovelace", `crm_search_contacts by query is full-text search (${failure(fts) || fts.body?.search_mode})`);
  const ftsTags = await c("crm_search_contacts", { query: "engineer", tags: ["ai"] });
  assert(ok(ftsTags) && ftsTags.body?.search_mode === "fts" && ftsTags.body?.count === 1, `…with tags, still fts — the text[] argument bound as an array, not the ILIKE fallback (${failure(ftsTags) || ftsTags.body?.search_mode})`);
  assert(fts.body?.contacts?.[0]?.follow_up_date === null && typeof fts.body?.contacts?.[0]?.created_at === "string", "…its rows through the function are JSON-shaped as the table's are (timestamps strings)");
  const ftsNoTag = await c("crm_search_contacts", { query: "engineer", tags: ["nope"] });
  assert(ok(ftsNoTag) && ftsNoTag.body?.search_mode === "fts" && ftsNoTag.body?.count === 0, "…and a tag she lacks finds none, through fts");
  const ftsTwo = await c("crm_search_contacts", { query: "engine talk" });
  assert(ok(ftsTwo) && ftsTwo.body?.search_mode === "fts" && ftsTwo.body?.count === 1, "…two words AND together");
  const byTag = await c("crm_search_contacts", { tags: ["math"] });
  assert(ok(byTag) && byTag.body?.count === 1 && byTag.body?.contacts?.[0]?.name === "Ada Lovelace" && byTag.body?.search_mode === undefined, `…tags without a query — .contains() on text[] (${failure(byTag) || byTag.body?.count})`);
  const everyone = await c("crm_search_contacts", {});
  assert(ok(everyone) && everyone.body?.count === 3 && everyone.body?.contacts?.map((x: any) => x.name).join() === "Ada Lovelace,Bob Builder,Cy Nolan", "…nothing lists everyone by name");
  const limited = await c("crm_search_contacts", { limit: 2 });
  assert(ok(limited) && limited.body?.count === 2, "…limit applies");

  const met = isoDaysFromNow(-3);
  const interaction = await c("crm_log_interaction", { contact_id: ids.ada, interaction_type: "coffee", occurred_at: met, summary: "talked about the difference engine", follow_up_needed: true, follow_up_notes: "send the paper" });
  assert(ok(interaction) && UUID.test(interaction.body?.interaction?.id) && interaction.body?.interaction?.follow_up_needed === true, `crm_log_interaction stores the row (${failure(interaction)})`);
  const badType = await c("crm_log_interaction", { contact_id: ids.ada, interaction_type: "carrier pigeon", summary: "x" });
  assert(badType.isError && /Invalid arguments/.test(badType.toolText), `…a type outside the enum is refused by the tool's schema, before the database (${badType.toolText.slice(0, 60)})`);

  const history = await c("crm_get_contact_history", { contact_id: ids.ada });
  assert(ok(history) && history.body?.contact?.last_contacted === met, `crm_get_contact_history: the trigger set last_contacted to the interaction's time (${failure(history) || history.body?.contact?.last_contacted})`);
  assert(history.body?.interaction_count === 1 && history.body?.interactions?.[0]?.summary === "talked about the difference engine" && eqJson(history.body?.opportunities, []), "…one interaction, no opportunities yet");
  const noContact = await c("crm_get_contact_history", { contact_id: NO_ROW });
  assert(noContact.isError && /Failed to get contact: .*rows returned/.test(noContact.toolText), `…a missing contact is the tool's own error (${noContact.toolText.slice(0, 70)})`);

  const deal = await c("crm_create_opportunity", { contact_id: ids.ada, title: "Engine consult", description: "a week of analysis", stage: "proposal", value: 12000.5, expected_close_date: "2026-12-01" });
  assert(ok(deal) && UUID.test(deal.body?.opportunity?.id) && deal.body?.opportunity?.value === "12000.50" && deal.body?.opportunity?.stage === "proposal", `crm_create_opportunity stores the row (${failure(deal) || JSON.stringify(deal.body?.opportunity?.value)})`);
  const unlinked = await c("crm_create_opportunity", { title: "Speculative" });
  assert(ok(unlinked) && unlinked.body?.opportunity?.contact_id === null && unlinked.body?.opportunity?.stage === "identified", "…and one with no contact, stage defaulted");

  const bobDue = await c("crm_update_contact", { contact_id: ids.bob, follow_up_date: dateDaysFromNow(2), tags: ["ops"], title: "Foreman" });
  assert(ok(bobDue) && eqJson(bobDue.body?.contact?.tags, ["ops"]) && bobDue.body?.contact?.title === "Foreman" && bobDue.body?.contact?.follow_up_date === dateDaysFromNow(2),
    `crm_update_contact replaces tags and sets a follow-up (${failure(bobDue) || JSON.stringify(bobDue.body?.contact?.tags)})`);
  const cyDue = await c("crm_update_contact", { contact_id: ids.cy, follow_up_date: dateDaysFromNow(-2) });
  assert(ok(cyDue), "…a follow-up already past");
  const nothing = await c("crm_update_contact", { contact_id: ids.cy });
  assert(nothing.isError && /No fields provided to update/.test(nothing.toolText), "…no fields is the tool's own error");

  // .not("follow_up_date", "is", null): Ada, with none, is out; Cy's is overdue, Bob's upcoming.
  const followUps = await c("crm_get_follow_ups", { days_ahead: 7 });
  assert(ok(followUps) && followUps.body?.overdue_count === 1 && followUps.body?.overdue?.[0]?.name === "Cy Nolan" && followUps.body?.upcoming_count === 1 && followUps.body?.upcoming?.[0]?.name === "Bob Builder",
    `crm_get_follow_ups splits overdue from upcoming and leaves out the contact with none (${failure(followUps) || JSON.stringify([followUps.body?.overdue_count, followUps.body?.upcoming_count])})`);
  const soon = await c("crm_get_follow_ups", { days_ahead: 1 });
  assert(ok(soon) && soon.body?.overdue_count === 1 && soon.body?.upcoming_count === 0, "…a one-day window keeps only the overdue one");
  const cleared = await c("crm_update_contact", { contact_id: ids.cy, follow_up_date: null });
  assert(ok(cleared) && cleared.body?.contact?.follow_up_date === null, "crm_update_contact clears a follow-up with null");
  const ftsDated = await c("crm_search_contacts", { query: "bricks" });
  assert(ok(ftsDated) && ftsDated.body?.search_mode === "fts" && ftsDated.body?.contacts?.[0]?.follow_up_date === dateDaysFromNow(2), `…a date column through the function's rows is the bare date the table's rows give — one shape whichever path the tool takes (${ftsDated.body?.contacts?.[0]?.follow_up_date})`);
  const afterClear = await c("crm_get_follow_ups", {});
  assert(ok(afterClear) && afterClear.body?.overdue_count === 0 && afterClear.body?.upcoming_count === 1, "…and the follow-ups no longer list it");

  // A thought through the fork's own function, then linked.
  const [{ t }] = await sql`SELECT upsert_thought('Ada described the analytical engine as a loom for numbers.'::text, '{"type":"note"}'::jsonb) AS t`;
  const thoughtId = (t as { id: string }).id;
  const linked = await c("crm_link_thought", { thought_id: thoughtId, contact_id: ids.ada });
  assert(ok(linked) && /\[Linked Thought \d{4}-\d\d-\d\d\]: Ada described the analytical engine/.test(linked.body?.contact?.notes ?? "") && linked.body?.contact?.notes?.startsWith("met at the engine talk"),
    `crm_link_thought appends the thought's text to the notes (${failure(linked) || JSON.stringify(linked.body?.contact?.notes)})`);
  const noThought = await c("crm_link_thought", { thought_id: NO_ROW, contact_id: ids.ada });
  assert(noThought.isError && /Failed to retrieve thought/.test(noThought.toolText), "…a missing thought is the tool's own error");

  const prep = await c("crm_prep_context", { contact_id: ids.ada });
  const b = prep.body?.briefing;
  assert(ok(prep) && b?.contact?.name === "Ada Lovelace" && eqJson(b?.contact?.tags, ["ai", "math"]), `crm_prep_context gathers the contact (${failure(prep)})`);
  assert(b?.relationship?.total_interactions === 1 && b?.relationship?.days_since_last_contact === 3 && b?.relationship?.last_contacted === met, `…the relationship's numbers (${JSON.stringify(b?.relationship)})`);
  assert(b?.pending_follow_ups?.length === 1 && b?.pending_follow_ups?.[0]?.notes === "send the paper", "…the pending follow-up from the interaction");
  assert(b?.opportunities?.active_count === 1 && b?.opportunities?.total_pipeline_value === 12000.5 && b?.opportunities?.items?.[0]?.title === "Engine consult", `…and the pipeline, its numeric value parsed (${JSON.stringify(b?.opportunities)})`);
  const prepMissing = await c("crm_prep_context", { contact_id: NO_ROW });
  assert(prepMissing.isError && /Contact not found/.test(prepMissing.toolText), "…a missing contact is the tool's own error");

  // .or("last_contacted.lt.…,last_contacted.is.null") with nulls first: the two never contacted, then Ada only when the threshold reaches her.
  const stale = await c("crm_stale_contacts", { days_threshold: 7 });
  assert(ok(stale) && stale.body?.count === 2 && stale.body?.stale_contacts?.every((x: any) => x.last_contacted === null && x.days_since_contact === null) && stale.body?.stale_contacts?.map((x: any) => x.name).sort().join() === "Bob Builder,Cy Nolan",
    `crm_stale_contacts at 7 days: the two never contacted, not Ada at 3 (${failure(stale) || stale.body?.count})`);
  const staler = await c("crm_stale_contacts", { days_threshold: 1, limit: 10 });
  assert(ok(staler) && staler.body?.count === 3 && staler.body?.stale_contacts?.[2]?.name === "Ada Lovelace" && staler.body?.stale_contacts?.[2]?.days_since_contact === 3, "…at 1 day Ada too, after the nulls");
  const staleOne = await c("crm_stale_contacts", { days_threshold: 1, limit: 1 });
  assert(ok(staleOne) && staleOne.body?.count === 1, "…limit applies");
}

// ── extensions/family-calendar (SMD-1798) ────────────────────────────────────

{
  const F = "extensions/family-calendar/index.ts";
  console.log(`\n[${F}]`);
  const h = await load(F);
  const c = (name: string, args: Record<string, unknown>) => call(F, h, name, args);
  // These tools answer the row or the rows themselves, no envelope.
  const titles = (r: Called) => (Array.isArray(r.body) ? (r.body as { title: string }[]) : []).map((a) => a.title).sort().join();

  const ada = await c("add_family_member", { name: "Ada", relationship: "child", birth_date: "2018-03-01" });
  assert(ok(ada) && UUID.test(ada.body?.id) && ada.body?.relationship === "child" && ada.body?.birth_date === "2018-03-01", `add_family_member stores the row and answers it, the birth date a bare date (${failure(ada) || JSON.stringify(ada.body).slice(0, 80)})`);
  const adaId = String(ada.body?.id);
  // Five activities around the week of 2026-09-21: one recurring, four dated — one across the week, one ended before it,
  // one open-ended since before it, one ahead of it.
  const swim = await c("add_activity", { family_member_id: adaId, title: "Swimming", activity_type: "sports", day_of_week: "monday", start_time: "16:00", end_time: "17:00" });
  const camp = await c("add_activity", { title: "Autumn camp", activity_type: "school", start_date: "2026-09-20", end_date: "2026-09-27", start_time: "09:00" });
  const ended = await c("add_activity", { title: "Spring term", activity_type: "school", start_date: "2026-09-01", end_date: "2026-09-10", start_time: "08:00" });
  const ongoing = await c("add_activity", { title: "Piano", activity_type: "music", start_date: "2026-09-15", start_time: "18:00" });
  const ahead = await c("add_activity", { title: "Ski trip", activity_type: "sports", start_date: "2026-10-15", start_time: "07:00" });
  assert([swim, camp, ended, ongoing, ahead].every(ok) && swim.body?.family_member_id === adaId && camp.body?.family_member_id === null, `add_activity ×5: a recurring one for Ada, four dated ones for the whole family (${[swim, camp, ended, ongoing, ahead].map(failure).filter(Boolean).join("; ")})`);
  const week = await c("get_week_schedule", { week_start: "2026-09-21" });
  assert(ok(week) && titles(week) === "Autumn camp,Piano,Swimming", `get_week_schedule: the recurring activity and the two whose dates reach the week, not the one that ended before it or the one ahead — the grouped .or() the shim reads since SMD-1798 (${failure(week) || titles(week)})`);
  assert(week.body?.[0]?.title === "Autumn camp" && week.body?.[2]?.title === "Piano", `…ordered by start time (${(week.body ?? []).map((a: { title: string }) => a.title).join()})`);
  const swimRow = week.body?.find((a: { title: string }) => a.title === "Swimming");
  assert(swimRow?.family_members?.name === "Ada" && swimRow?.family_members?.relationship === "child" && Object.keys(swimRow?.family_members ?? {}).sort().join() === "name,relationship" && week.body?.find((a: { title: string }) => a.title === "Piano")?.family_members === null,
    `…each with its family member embedded through the key column — the two named columns, no more — or null for the whole family (${JSON.stringify(swimRow?.family_members)})`);
  const forAda = await c("get_week_schedule", { week_start: "2026-09-21", family_member_id: adaId });
  assert(ok(forAda) && titles(forAda) === "Swimming", `…filtered to one family member (${titles(forAda)})`);
  const byQuery = await c("search_activities", { query: "camp" });
  assert(ok(byQuery) && titles(byQuery) === "Autumn camp", `search_activities by title, ILIKE (${failure(byQuery) || titles(byQuery)})`);
  const byType = await c("search_activities", { activity_type: "sports" });
  assert(ok(byType) && titles(byType) === "Ski trip,Swimming", `…by type (${titles(byType)})`);
  const byMember = await c("search_activities", { family_member_id: adaId });
  assert(ok(byMember) && titles(byMember) === "Swimming" && byMember.body?.[0]?.family_members?.relationship === "child", "…by family member, the member embedded");
  const every = await c("search_activities", {});
  const dated = (every.body ?? []).filter((a: { start_date: string | null }) => a.start_date);
  assert(ok(every) && every.body?.length === 5 && dated[0]?.title === "Ski trip" && dated[3]?.title === "Spring term", `…no filter lists all five, latest start date first (${(every.body ?? []).map((a: { title: string }) => a.title).join()})`);
  const bday = await c("add_important_date", { family_member_id: adaId, title: "Ada's birthday", date_value: dateDaysFromNow(10), recurring_yearly: true });
  const renewal = await c("add_important_date", { title: "Insurance renewal", date_value: dateDaysFromNow(60), reminder_days_before: 14 });
  assert(ok(bday) && ok(renewal) && bday.body?.recurring_yearly === true && bday.body?.reminder_days_before === 7 && renewal.body?.reminder_days_before === 14 && renewal.body?.recurring_yearly === false, `add_important_date ×2, the defaults filled (${failure(bday) || failure(renewal) || JSON.stringify(bday.body).slice(0, 80)})`);
  const soon = await c("get_upcoming_dates", { days_ahead: 30 });
  assert(ok(soon) && soon.body?.length === 1 && soon.body?.[0]?.title === "Ada's birthday" && soon.body?.[0]?.family_members?.name === "Ada" && soon.body?.[0]?.date_value === dateDaysFromNow(10), `get_upcoming_dates: the birthday within 30 days, the member embedded, the date bare (${failure(soon) || JSON.stringify(soon.body).slice(0, 100)})`);
  const wider = await c("get_upcoming_dates", { days_ahead: 90 });
  assert(ok(wider) && wider.body?.length === 2 && wider.body?.[1]?.title === "Insurance renewal" && wider.body?.[1]?.family_members === null, `…a wider window takes in the renewal, ordered by date, a family-wide date's member null (${(wider.body ?? []).map((d: { title: string }) => d.title).join()})`);
}

// ── extensions/job-hunt (SMD-1798) ───────────────────────────────────────────

{
  const F = "extensions/job-hunt/index.ts";
  console.log(`\n[${F}]`);
  const h = await load(F);
  const c = (name: string, args: Record<string, unknown>) => call(F, h, name, args);

  const acme = await c("add_company", { name: "Acme Robotics", industry: "robotics", size: "startup", remote_policy: "hybrid", glassdoor_rating: 4.2 });
  assert(ok(acme) && UUID.test(acme.body?.company?.id) && acme.body?.company?.name === "Acme Robotics" && Number(acme.body?.company?.glassdoor_rating) === 4.2, `add_company (${failure(acme) || JSON.stringify(acme.body?.company).slice(0, 80)})`);
  const globex = await c("add_company", { name: "Globex", industry: "energy" });
  assert(ok(globex) && UUID.test(globex.body?.company?.id), `…and a second company (${failure(globex)})`);
  const acmeId = String(acme.body?.company?.id);
  const posting = await c("add_job_posting", { company_id: acmeId, title: "Staff Engineer", requirements: ["TypeScript", "Postgres"], salary_min: 180000, salary_max: 220000, source: "referral", posted_date: "2026-09-01" });
  assert(ok(posting) && UUID.test(posting.body?.job_posting?.id) && eqJson(posting.body?.job_posting?.requirements, ["TypeScript", "Postgres"]) && eqJson(posting.body?.job_posting?.nice_to_haves, []) && posting.body?.job_posting?.posted_date === "2026-09-01",
    `add_job_posting: the text[] requirements as a list, the empty default too, the date bare (${failure(posting) || JSON.stringify(posting.body?.job_posting).slice(0, 120)})`);
  const rita = await c("add_job_contact", { company_id: acmeId, name: "Rita Recruiter", title: "Talent Partner", email: "rita@acme.example", role_in_process: "recruiter" });
  assert(ok(rita) && UUID.test(rita.body?.job_contact?.id) && rita.body?.job_contact?.companies?.name === "Acme Robotics", `add_job_contact answers the contact with its company embedded (${failure(rita) || JSON.stringify(rita.body?.job_contact?.companies)})`);
  const hank = await c("add_job_contact", { name: "Hank Hiring", role_in_process: "hiring_manager", notes: "met at the robotics meetup" });
  assert(ok(hank) && hank.body?.job_contact?.companies === null, "…and null where the contact has no company");
  const gina = await c("add_job_contact", { company_id: String(globex.body?.company?.id), name: "Gina", role_in_process: "interviewer" });
  assert(ok(gina), `…a third, at the second company (${failure(gina)})`);
  const app = await c("submit_application", { job_posting_id: posting.body?.job_posting?.id, applied_date: "2026-09-05", resume_version: "v3" });
  assert(ok(app) && UUID.test(app.body?.application?.id) && app.body?.application?.status === "applied" && app.body?.application?.applied_date === "2026-09-05", `submit_application (${failure(app)})`);
  const appId = String(app.body?.application?.id);
  const screen = await c("schedule_interview", { application_id: appId, interview_type: "phone_screen", scheduled_at: isoDaysFromNow(2), duration_minutes: 45, interviewer_name: "Rita Recruiter" });
  assert(ok(screen) && UUID.test(screen.body?.interview?.id) && screen.body?.interview?.status === "scheduled", `schedule_interview (${failure(screen)})`);
  const technical = await c("schedule_interview", { application_id: appId, interview_type: "technical", scheduled_at: isoDaysFromNow(20) });
  assert(ok(technical), `…and a second, further out (${failure(technical)})`);
  const upcoming = await c("get_upcoming_interviews", { days_ahead: 7 });
  assert(ok(upcoming) && upcoming.body?.count === 1 && upcoming.body?.interviews?.[0]?.interview_type === "phone_screen", `get_upcoming_interviews within 7 days: the phone screen, not the technical in 20 (${failure(upcoming) || upcoming.body?.count})`);
  const ctx = upcoming.body?.interviews?.[0]?.applications;
  assert(ctx?.status === "applied" && ctx?.job_postings?.title === "Staff Engineer" && ctx?.job_postings?.companies?.name === "Acme Robotics" && eqJson(ctx?.job_postings?.requirements, ["TypeScript", "Postgres"]),
    `…each interview carrying its application, posting and company nested three deep — the !inner chain the shim reads since SMD-1798 (${JSON.stringify(ctx).slice(0, 140)})`);
  const wider = await c("get_upcoming_interviews", { days_ahead: 30 });
  assert(ok(wider) && wider.body?.count === 2 && wider.body?.interviews?.[1]?.interview_type === "technical", `…a wider window takes in both, soonest first (${wider.body?.count})`);
  const overview = await c("get_pipeline_overview", { days_ahead: 7 });
  assert(ok(overview) && overview.body?.total_applications === 1 && overview.body?.status_breakdown?.applied === 1 && overview.body?.upcoming_interviews_count === 1 && overview.body?.upcoming_interviews?.[0]?.applications?.job_postings?.companies?.name === "Acme Robotics",
    `get_pipeline_overview: the status breakdown and the week's interviews with their context (${failure(overview) || JSON.stringify(overview.body).slice(0, 120)})`);
  const notes = await c("log_interview_notes", { interview_id: screen.body?.interview?.id, feedback: "went well", rating: 4 });
  assert(ok(notes) && notes.body?.interview?.status === "completed" && notes.body?.interview?.rating === 4 && notes.body?.interview?.feedback === "went well", `log_interview_notes marks the interview completed (${failure(notes)})`);
  const afterNotes = await c("get_upcoming_interviews", { days_ahead: 30 });
  assert(ok(afterNotes) && afterNotes.body?.count === 1 && afterNotes.body?.interviews?.[0]?.interview_type === "technical", "…and it leaves the upcoming list");
  const byCompany = await c("search_job_contacts", { query: "globex" });
  assert(ok(byCompany) && byCompany.body?.count === 1 && byCompany.body?.contacts?.[0]?.name === "Gina" && byCompany.body?.contacts?.[0]?.companies?.name === "Globex",
    `search_job_contacts by a company's name — nothing on the contact says it; the company_id.in.(…) term inside .or() does (${failure(byCompany) || byCompany.body?.count})`);
  const byNotes = await c("search_job_contacts", { query: "meetup" });
  assert(ok(byNotes) && byNotes.body?.count === 1 && byNotes.body?.contacts?.[0]?.name === "Hank Hiring", `…by a word in the notes, through the flat ILIKE terms (${byNotes.body?.count})`);
  const byRole = await c("search_job_contacts", { role_in_process: "recruiter" });
  assert(ok(byRole) && byRole.body?.count === 1 && byRole.body?.contacts?.[0]?.name === "Rita Recruiter", `…by role (${byRole.body?.count})`);
  const unlinked = await c("search_job_contacts", { only_unlinked: true });
  assert(ok(unlinked) && unlinked.body?.count === 3, `…only the unlinked: all three (${unlinked.body?.count})`);
  const link = await c("link_contact_to_professional_crm", { job_contact_id: rita.body?.job_contact?.id });
  assert(ok(link) && UUID.test(link.body?.professional_contact?.id) && link.body?.professional_contact?.company === "Acme Robotics" && eqJson(link.body?.professional_contact?.tags, ["job-hunt", "recruiter"]) && link.body?.job_contact?.professional_crm_contact_id === link.body?.professional_contact?.id,
    `link_contact_to_professional_crm creates the CRM contact (professional-crm's schema) with the company's name and the tags as a list, and links it (${failure(link) || JSON.stringify(link.body).slice(0, 120)})`);
  const again = await c("link_contact_to_professional_crm", { job_contact_id: rita.body?.job_contact?.id });
  assert(ok(again) && again.body?.already_linked === true, "…and a second link says already linked, creating nothing");
  const stillUnlinked = await c("search_job_contacts", { only_unlinked: true });
  assert(ok(stillUnlinked) && stillUnlinked.body?.count === 2, `…so two are unlinked now (${stillUnlinked.body?.count})`);
  const missing = await c("link_contact_to_professional_crm", { job_contact_id: NO_ROW });
  assert(!ok(missing) && /Failed to retrieve job contact/.test(failure(missing)), `an unknown contact fails by name (${failure(missing).slice(0, 60)})`);
}

// ── recipes/ob-graph (SMD-1798) ──────────────────────────────────────────────

{
  const F = "recipes/ob-graph/index.ts";
  console.log(`\n[${F}]`);
  const h = await load(F);
  const c = (name: string, args: Record<string, unknown>) => call(F, h, name, args);
  const node = async (label: string, node_type: string, properties?: Record<string, unknown>) => {
    const r = await c("create_node", { label, node_type, ...(properties ? { properties: JSON.stringify(properties) } : {}) });
    assert(ok(r) && UUID.test(r.body?.node?.id) && r.body?.node?.label === label && r.body?.node?.node_type === node_type, `create_node ${label} (${failure(r)})`);
    return String(r.body?.node?.id);
  };
  const supabase = await node("Supabase", "tool", { url: "https://supabase.com" });
  const brain = await node("Open Brain", "project");
  const postgres = await node("Postgres", "tool");
  const island = await node("Island", "place");
  const dependsOn = await c("create_edge", { source_node_id: brain, target_node_id: supabase, relationship_type: "depends_on", weight: 0.9 });
  const runsOn = await c("create_edge", { source_node_id: supabase, target_node_id: postgres, relationship_type: "runs_on" });
  // weight is a REAL: Bun decodes the float4 into a double (0.8999999761581421), where PostgREST prints Postgres's shortest
  // spelling (0.9) — a rendering difference the shim does not paper over; the value is the one stored.
  assert(ok(dependsOn) && ok(runsOn) && UUID.test(dependsOn.body?.edge?.id) && Math.abs(Number(dependsOn.body?.edge?.weight) - 0.9) < 1e-6 && Number(runsOn.body?.edge?.weight) === 1, `create_edge ×2, the weight stored and defaulted (${failure(dependsOn) || failure(runsOn) || dependsOn.body?.edge?.weight})`);
  const dup = await c("create_edge", { source_node_id: brain, target_node_id: supabase, relationship_type: "depends_on" });
  assert(!ok(dup) && /Failed to create edge/.test(failure(dup)) && /unique_edge/.test(failure(dup)), `a duplicate edge is refused by the unique constraint, the message the database's (${failure(dup).slice(0, 80)})`);
  const found = await c("search_nodes", { query: "supa" });
  assert(ok(found) && found.body?.count === 1 && found.body?.nodes?.[0]?.label === "Supabase" && found.body?.nodes?.[0]?.properties?.url === "https://supabase.com", `search_nodes by label, ILIKE, the properties as JSON (${failure(found) || found.body?.count})`);
  const tools = await c("search_nodes", { node_type: "tool" });
  assert(ok(tools) && tools.body?.count === 2, `…by type (${tools.body?.count})`);
  const neighbours = await c("get_neighbors", { node_id: supabase });
  const labels = (r: Called) => ((r.body?.neighbors ?? []) as { neighbor: { label: string } | null }[]).map((n) => n.neighbor?.label).sort().join();
  assert(ok(neighbours) && neighbours.body?.count === 2 && labels(neighbours) === "Open Brain,Postgres", `get_neighbors both ways: the node each edge reaches, embedded through the key the file names (graph_nodes!graph_edges_target_node_id_fkey) — the hint the shim reads since SMD-1798 (${failure(neighbours) || labels(neighbours)})`);
  const out = neighbours.body?.neighbors?.find((n: { direction: string }) => n.direction === "outgoing");
  assert(out?.neighbor?.label === "Postgres" && out?.relationship_type === "runs_on" && out?.neighbor?.node_type === "tool" && typeof out?.neighbor?.id === "string", `…the outgoing one Postgres, the neighbour an object of the four named columns (${JSON.stringify(out?.neighbor)})`);
  const incoming = await c("get_neighbors", { node_id: supabase, direction: "incoming", relationship_type: "depends_on" });
  assert(ok(incoming) && incoming.body?.count === 1 && labels(incoming) === "Open Brain", `…incoming only, by relationship type (${labels(incoming)})`);
  const walk = await c("traverse_graph", { start_node_id: brain, max_depth: 3 });
  const deepest = (walk.body?.nodes ?? []).find((n: { node_label: string }) => n.node_label === "Postgres");
  assert(ok(walk) && walk.body?.count === 3 && walk.body?.nodes?.[0]?.depth === 0 && deepest?.depth === 2 && deepest?.via_relationship === "runs_on",
    `traverse_graph from Open Brain: the start, Supabase, Postgres — three rows by depth (${failure(walk) || JSON.stringify(walk.body?.nodes).slice(0, 120)})`);
  assert(Array.isArray(deepest?.path) && deepest.path.length === 3 && deepest.path[0] === brain && deepest.path[2] === postgres, `…each row's path a list of ids — a uuid[] through to_json, not the literal text Bun left it as (${JSON.stringify(deepest?.path)})`);
  const typedWalk = await c("traverse_graph", { start_node_id: brain, relationship_type: "depends_on" });
  assert(ok(typedWalk) && typedWalk.body?.count === 2, `…following one relationship type stops at Supabase (${typedWalk.body?.count})`);
  const path = await c("find_path", { start_node_id: brain, end_node_id: postgres });
  assert(ok(path) && path.body?.path_found === true && path.body?.steps === 3 && path.body?.path?.[0]?.node_id === brain && path.body?.path?.[2]?.node_label === "Postgres" && path.body?.path?.[2]?.via_relationship === "runs_on",
    `find_path Open Brain → Postgres: three steps through Supabase (${failure(path) || JSON.stringify(path.body).slice(0, 120)})`);
  const noPath = await c("find_path", { start_node_id: brain, end_node_id: island });
  assert(ok(noPath) && noPath.body?.path_found === false, `…and none to the island (${JSON.stringify(noPath.body)})`);
  const updated = await c("update_node", { node_id: supabase, label: "Supabase (hosted)", properties: JSON.stringify({ tier: "pro" }) });
  assert(ok(updated) && updated.body?.node?.label === "Supabase (hosted)" && eqJson(updated.body?.node?.properties, { url: "https://supabase.com", tier: "pro" }), `update_node relabels and merges the properties (${failure(updated) || JSON.stringify(updated.body?.node?.properties)})`);
  const nothing = await c("update_node", { node_id: supabase });
  assert(!ok(nothing) && /No fields to update/.test(failure(nothing)), "…and nothing to update is refused by name");
  const types = await c("list_edge_types", {});
  assert(ok(types) && types.body?.count === 2 && (types.body?.types ?? []).map((t: { relationship_type: string }) => t.relationship_type).sort().join() === "depends_on,runs_on", `list_edge_types counts each type (${failure(types) || JSON.stringify(types.body?.types)})`);
  const gone = await c("delete_edge", { edge_id: runsOn.body?.edge?.id });
  const typesAfter = await c("list_edge_types", {});
  assert(ok(gone) && ok(typesAfter) && typesAfter.body?.count === 1 && typesAfter.body?.types?.[0]?.relationship_type === "depends_on", `delete_edge removes it (${failure(gone) || typesAfter.body?.count})`);
  const removed = await c("delete_node", { node_id: supabase });
  const orphaned = await c("get_neighbors", { node_id: brain });
  const remaining = await c("search_nodes", {});
  assert(ok(removed) && ok(orphaned) && orphaned.body?.count === 0 && ok(remaining) && remaining.body?.count === 3, `delete_node removes the node and, by cascade, its edge (${failure(removed) || `${orphaned.body?.count} neighbours, ${remaining.body?.count} nodes`})`);
}

// ── The connections the servers hold: every request built a client and closed none ──

console.log("\n[the servers' clients share one pool]");
{
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()`;
  const requests = [...driven.values()].reduce((a, set) => a + set.size, 0);
  // The shared pool is ten wide (Bun opens it to `max`, serial or not) and this suite's own two more, and a backend
  // from an earlier step of the CI job may not have been reaped yet — so the bound is a fifth of the limit, not the
  // arithmetic: 84 were held before change 77, against a default of 100.
  assert(Number(n) <= 20, `after ${requests}+ tools/call requests, each of which built a client it never closed, the database sees a handful of connections, not one per request (${n}; 84 held before change 77, against a default limit of 100)`);
}

// ── The drift guard: every registered tool is driven, and nothing else is ────

console.log("\n[every tool each server registers is driven here]");
{
  const files = ["extensions/household-knowledge/index.ts", "extensions/home-maintenance/index.ts", "extensions/meal-planning/index.ts", "extensions/meal-planning/shared-server.ts", "extensions/professional-crm/index.ts",
    "extensions/family-calendar/index.ts", "extensions/job-hunt/index.ts", "recipes/ob-graph/index.ts"];
  let total = 0;
  for (const file of files) {
    const handler = handlers.get(file);
    const listed = handler ? await toolsOf(handler) : [];
    const called = [...(driven.get(file) ?? [])].sort();
    assert(listed.length > 0 && listed.join() === called.join(), `${file}: tools/list under the write key is exactly the ${called.length} tool(s) driven above (${listed.join(", ")})`);
    total += listed.length;
  }
  assert(total === 55, `fifty-five tools on the eight servers (${total})`);
  const onShim = [...new Bun.Glob("extensions/**/*.ts").scanSync({ cwd: ROOT })]
    .filter((f) => !f.includes("node_modules") && !f.startsWith("extensions/test-") && /["'][^"'\n]*compat\/supabase-sql\/index\.ts["']/.test(readFileSync(join(ROOT, f), "utf8"))).sort();
  assert(onShim.join() === files.filter((f) => f.startsWith("extensions/")).sort().join(), `every extension file on the SQL shim is driven here (${onShim.join(", ")})`);
}

} catch (e) {
  // A throw is a failure with a tally, not a stack trace in place of one.
  assert(false, `the suite threw: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
} finally {
  try {
    await dropExtensionSchemas();
    await sql.unsafe("DROP FUNCTION IF EXISTS auth.uid(); DROP FUNCTION IF EXISTS auth.jwt();");
  } catch (e) {
    console.error(`test-tools.ts: dropping the extension schemas failed — ${e instanceof Error ? e.message : String(e)}`);
  }
  await sql.close();
}
report();
