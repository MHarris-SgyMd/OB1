#!/usr/bin/env bun
/**
 * test-tools.ts — every tool of the five extension servers on the SQL shim
 * answers against a real Postgres carrying the extensions' own schemas.
 *
 * SMD-1588 (FORK.md change 76). Fix 13 moved these servers onto
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
 * it is driven. Twenty-nine tools on five servers (the ticket's "twenty-five"
 * counted the four `index.ts` files; the shared meal-planning server's four
 * are the rest).
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

/** The five servers, by the schema that owns their tables (the shared server reads meal-planning's). */
const SCHEMAS = ["household-knowledge", "home-maintenance", "meal-planning", "professional-crm"];
const schemaText = (ext: string) => readFileSync(join(ROOT, "extensions", ext, "schema.sql"), "utf8");
/** What the four schemas create, dropped before they are applied and at the end. meal-planning's CREATE TABLE has no IF NOT EXISTS. */
async function dropExtensionSchemas() {
  for (const ext of SCHEMAS) {
    const text = schemaText(ext);
    for (const m of text.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)) await sql.unsafe(`DROP TABLE IF EXISTS public.${m[1]} CASCADE`);
    for (const m of text.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\s*\(/g)) await sql.unsafe(`DROP FUNCTION IF EXISTS public.${m[1]} CASCADE`);
  }
}
await dropExtensionSchemas();
// The READMEs' Step 1: the two Supabase functions the RLS policies call, created plain (a Supabase database has them; a
// throwaway one does not — dropped first here so a re-run on a kept database applies cleanly).
await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS auth;
  DROP FUNCTION IF EXISTS auth.uid(); DROP FUNCTION IF EXISTS auth.jwt();
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
  CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS 'SELECT ''{}''::jsonb';`);
for (const ext of SCHEMAS) await sql.unsafe(schemaText(ext));

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

async function load(rel: string): Promise<Handler> {
  const before = served.length;
  await import(join(ROOT, rel));
  assert(served.length === before + 1, `${rel} imports as deployed and hands Deno.serve one handler`);
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
  const quoteQuery = await c("search_household_items", { query: 'Paint (Sea "Salt' });
  assert(ok(quoteQuery) && quoteQuery.body?.count === 0, `…a query with an unclosed quote and parenthesis is pattern text — four ILIKE terms, no rows, no error (${failure(quoteQuery) || quoteQuery.body?.count})`);
  const exactQuery = await c("search_household_items", { query: "Living Room Paint" });
  assert(ok(exactQuery) && exactQuery.body?.count === 1, "…and an exact name finds its row through the four-term .or()");
  const none = await c("search_household_items", { query: "nothing-of-the-kind" });
  assert(ok(none) && none.body?.count === 0 && eqJson(none.body?.items, []), "…and none is an empty list");
  const all = await c("search_household_items", {});
  assert(ok(all) && all.body?.count === 2 && all.body?.items?.[0]?.name === "Dishwasher", "…no filter lists every item, newest first");

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
  assert(ok(noTask) && noTask.body?.count === 0 && eqJson(noTask.body?.logs, []), "…a name no task has answers an empty list before the log query");
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
  assert(badType.isError && /carrier pigeon|invalid/i.test(badType.toolText), "…a type outside the enum is refused before the database");

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

// ── The drift guard: every registered tool is driven, and nothing else is ────

// ── The connections the servers hold: every request built a client and closed none ──

console.log("\n[the servers' clients share one pool]");
{
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()`;
  const requests = [...driven.values()].reduce((a, set) => a + set.size, 0);
  // The shared pool is ten wide (Bun opens it to `max`, serial or not) and this suite's own two more, and a backend
  // from an earlier step of the CI job may not have been reaped yet — so the bound is a fifth of the limit, not the
  // arithmetic: 84 were held before change 76, against a default of 100.
  assert(Number(n) <= 20, `after ${requests}+ tools/call requests, each of which built a client it never closed, the database sees a handful of connections, not one per request (${n}; 84 held before change 76, against a default limit of 100)`);
}

console.log("\n[every tool each server registers is driven here]");
{
  const files = ["extensions/household-knowledge/index.ts", "extensions/home-maintenance/index.ts", "extensions/meal-planning/index.ts", "extensions/meal-planning/shared-server.ts", "extensions/professional-crm/index.ts"];
  let total = 0;
  for (const [i, file] of files.entries()) {
    const listed = await toolsOf(served[i]);
    const called = [...(driven.get(file) ?? [])].sort();
    assert(listed.length > 0 && listed.join() === called.join(), `${file}: tools/list under the write key is exactly the ${called.length} tool(s) driven above (${listed.join(", ")})`);
    total += listed.length;
  }
  assert(total === 29, `twenty-nine tools on the five servers (${total})`);
  const onShim = [...new Bun.Glob("extensions/**/*.ts").scanSync({ cwd: ROOT })]
    .filter((f) => !f.includes("node_modules") && !f.startsWith("extensions/test-") && /["'][^"'\n]*compat\/supabase-sql\/index\.ts["']/.test(readFileSync(join(ROOT, f), "utf8"))).sort();
  assert(onShim.join() === [...files].sort().join(), `every extension file on the SQL shim is driven here (${onShim.join(", ")})`);
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
