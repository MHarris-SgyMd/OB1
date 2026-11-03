#!/usr/bin/env bun
/**
 * test-plugin-ports.ts — the extensions ported to plugins (SMD-2311), each
 * against real Postgres through both servers: the migrator makes each
 * plugin's tables in its own schema, owned by its own role, and every
 * operation answers through the REST core and through the MCP server (a
 * client of it), behind its key's scope. A read key sees and calls a
 * plugin's reads and is refused its writes, and a capture key sees none of
 * it. Each plugin's section then drives its operations as
 * extensions/test-tools.ts drove the standalone server's tools: each filter
 * on its own, each refusal, what a write stored and what a read chose.
 *
 * The drift guard: every tool a write key's tools/list shows for a ported
 * plugin is driven here, and nothing else, so an operation added to one fails
 * this suite until it is.
 *
 *   ../db/with-postgres.sh bun test-plugin-ports.ts
 */

import { SQL } from "bun";
import { createAssert, dropSchema, pollUntil } from "../db/test-support.ts";
import { hashKey } from "./auth.ts";
import { EMBEDDING_DIM, EMBEDDING_MODEL, pluginIdents } from "../db/config.mjs";
import { PLUGINS as REGISTRY } from "../plugins/registry.ts";
import { keepsMark, listSource, shoppingItems } from "../plugins/meal-planning/index.ts";
import { mcpUnderTest, servedByMcpServer } from "./test-support.ts";

const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  console.error("DATABASE_URL is not set. Try: ../db/with-postgres.sh bun test-plugin-ports.ts");
  process.exit(2);
}
process.env.OB1_EMBEDDING_DIM = String(EMBEDDING_DIM);
process.env.OB1_EMBEDDING_MODEL = EMBEDDING_MODEL;

/** The ported plugins, as each PR of SMD-2311 adds one: its section below drives it. */
const PORTED = ["family-calendar", "home-maintenance", "household-knowledge", "meal-planning"] as const;
const PLUGIN_PW = "smd2311-plugin-secret";

const { assert, report } = createAssert();
const sql = new SQL({ url: URL_, max: 2 });
const one = async <T>(q: Promise<unknown>): Promise<T> => ((await q) as T[])[0];

await dropSchema(URL_);

console.log(`\n[1] The migrator makes each ported plugin's tables in its own schema, owned by its own role (${PORTED.join(", ")})`);
{
  const { run: migrate } = await import("../db/migrate.ts");
  const out: string[] = [];
  const err: string[] = [];
  const code = await migrate({ url: URL_, plugins: PORTED.join(","), pluginPassword: PLUGIN_PW, writer: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } });
  assert(code === 0 && /plugins: applied \d+, skipped 0/.test(out.join("\n")), `the migrator applies them (${code}: ${err.join(" ").slice(0, 300)})`);
  for (const name of PORTED) {
    const { schema, role } = pluginIdents(name);
    const owned = (await sql`SELECT c.relname, c.relkind::text AS kind, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                              WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'v') ORDER BY c.relname`) as { relname: string; kind: string; owner: string }[];
    assert(owned.length > 0 && owned.every((t) => t.owner === role), `${name}: its tables and views are in ${schema}, every one ${role}'s (${owned.map((t) => `${t.relname}:${t.owner}`).join(", ")})`);
    const strays = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = ${role}`);
    assert(strays.n === 0, `${name}: nothing of its own in public`);
  }
}

// ── Both servers, the ported plugins enabled, over this database ─────────────
const STUB_BASE = "https://stub.invalid/v1";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith(STUB_BASE)) {
    if (url.endsWith("/embeddings")) {
      const v = new Array(EMBEDDING_DIM).fill(0);
      v[0] = 1;
      return Response.json({ data: [{ embedding: v }] });
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify({ topics: ["stubbed"], type: "idea" }) } }] });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;
process.env.OB1_LLM_BASE_URL = STUB_BASE;
process.env.OB1_LLM_LOCAL = "1";
process.env.OPENROUTER_API_KEY = "stub";
delete process.env.OB1_STORE;
delete process.env.MCP_ACCESS_KEY;
delete process.env.OB1_HOOKS;
process.env.DATABASE_URL = URL_;
process.env.OB1_PLUGINS = PORTED.join(",");
process.env.OB1_PLUGIN_DB_PASSWORD = PLUGIN_PW;
const KEYS = { writer: "writer-raw", reader: "reader-raw", capture: "capture-raw" } as const;
process.env.MCP_ACCESS_KEYS = [`writer:write:${hashKey(KEYS.writer)}`, `reader:read:${hashKey(KEYS.reader)}`, `capturer:capture:${hashKey(KEYS.capture)}`].join(",");
const mcpServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (await mcpUnderTest()).fetch });
assert(servedByMcpServer(), "the server under test is the MCP server, the REST core behind it");
const apiServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (await import("./api.ts")).default.fetch });
const MCP = `http://127.0.0.1:${mcpServer.port}`;
const API = `http://127.0.0.1:${apiServer.port}`;

type Body = Record<string, any>;
async function rest(method: string, path: string, body: unknown, key: string): Promise<{ status: number; body: Body }> {
  const r = await fetch(`${API}${path}`, { method, headers: { "x-brain-key": key, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Body };
}
type McpReply = { result?: { structuredContent?: Body; isError?: boolean; tools?: { name: string; annotations?: { readOnlyHint?: boolean } }[]; content?: { text: string }[] }; error?: { message: string } };
async function mcp(method: string, params: Record<string, unknown>, key: string): Promise<McpReply> {
  const r = await fetch(MCP, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-brain-key": key }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const t = await r.text();
  return JSON.parse(t.startsWith("{") ? t : (t.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6)) as McpReply;
}
const toolsFor = async (key: string) => ((await mcp("tools/list", {}, key)).result?.tools ?? []);

/** Every tool called below, by plugin — the drift guard's set. */
const driven = new Map<string, Set<string>>();
/** A plugin's operation, as the plugins' registry declares it. */
function opOf(plugin: string, key: string) {
  const manifest = REGISTRY.find((p) => p.name === plugin);
  const op = manifest?.operations[key];
  if (!op) throw new Error(`${plugin} has no operation ${key}`);
  return op;
}
/** The REST path of an operation with its input: path fields filled, a GET's or a DELETE's other fields on the query string. */
function restCall(plugin: string, key: string, input: Body): { method: string; path: string; body: unknown } {
  const op = opOf(plugin, key);
  const rest = { ...input };
  const path = op.path.replace(/\{([a-z_]+)\}/g, (_m, f: string) => {
    const v = rest[f];
    delete rest[f];
    return encodeURIComponent(String(v));
  });
  const base = `/v1/plugins/${plugin}${path}`;
  if (op.method !== "GET" && op.method !== "DELETE") return { method: op.method, path: base, body: rest };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(rest)) for (const one of Array.isArray(v) ? v : [v]) q.append(k, String(one));
  return { method: op.method, path: q.size ? `${base}?${q}` : base, body: undefined };
}
const toolName = (plugin: string, key: string) => `${plugin.replaceAll("-", "_")}_${key}`;

type Called = { status: number; body: Body; viaMcp: McpReply };
/**
 * One operation, through both servers: over REST, and its tool over MCP. A
 * write runs once, by the door `door` names, so its row is stored once; a
 * read runs through both and the suite holds the MCP structured content to
 * the REST body. The answer is the REST body (or the MCP structured content
 * for a write sent over MCP) and its status.
 */
async function call(plugin: string, key: string, input: Body, opts: { as?: string; door?: "rest" | "mcp" } = {}): Promise<Called> {
  (driven.get(plugin) ?? driven.set(plugin, new Set()).get(plugin)!).add(toolName(plugin, key));
  const as = opts.as ?? KEYS.writer;
  const op = opOf(plugin, key);
  const r = restCall(plugin, key, input);
  if (op.scope !== "read") {
    if (opts.door === "mcp") {
      const viaMcp = await mcp("tools/call", { name: toolName(plugin, key), arguments: input }, as);
      return { status: viaMcp.result?.isError ? 0 : 200, body: viaMcp.result?.structuredContent ?? {}, viaMcp };
    }
    const viaRest = await rest(r.method, r.path, r.body, as);
    return { ...viaRest, viaMcp: {} };
  }
  const viaRest = await rest(r.method, r.path, r.body, as);
  const viaMcp = await mcp("tools/call", { name: toolName(plugin, key), arguments: input }, as);
  if (viaRest.status === 200) {
    assert(viaMcp.result?.isError !== true && JSON.stringify(viaMcp.result?.structuredContent) === JSON.stringify(viaRest.body), `${toolName(plugin, key)}: the MCP structured content is the REST body (${JSON.stringify(viaMcp).slice(0, 160)})`);
  }
  return { ...viaRest, viaMcp };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_ROW = "00000000-0000-4000-8000-00000000dead";

console.log("\n[2] Each ported plugin's tools behind each key's scope: a read key its reads alone, a capture key its captures alone, a write key all of them; each refused the rest");
{
  const writer = (await toolsFor(KEYS.writer)).map((t) => t.name);
  const readerTools = await toolsFor(KEYS.reader);
  const reader = readerTools.map((t) => t.name);
  const writerTools = await toolsFor(KEYS.writer);
  const capture = (await toolsFor(KEYS.capture)).map((t) => t.name);
  for (const name of PORTED) {
    const manifest = REGISTRY.find((p) => p.name === name)!;
    const prefix = `${name.replaceAll("-", "_")}_`;
    const ops = Object.entries(manifest.operations);
    const named = (scope?: string) => ops.filter(([, op]) => scope === undefined || op.scope === scope).map(([k]) => prefix + k).sort();
    const mine = (tools: string[]) => tools.filter((t) => t.startsWith(prefix)).sort().join();
    assert(ops.length > 0 && mine(writer) === named().join(), `${name}: a write key sees all ${ops.length} of its tools`);
    assert(mine(reader) === named("read").join(), `${name}: a read key sees its ${named("read").length} read(s) alone (${named("read").join(", ") || "none"})`);
    assert(mine(capture) === named("capture").join(), `${name}: a capture key sees its ${named("capture").length} capture(s) alone (${named("capture").join(", ") || "none"})`);
    assert(writerTools.filter((t) => t.name.startsWith(prefix)).every((t) => (t.annotations?.readOnlyHint === true) === named("read").includes(t.name)), `${name}: each read is annotated read-only, and nothing else is`);
    // Refused by scope before the input is read, so an empty input reaches the gate: 403 naming the scope over REST,
    // and over MCP no such tool for that key.
    for (const [key, op] of ops) {
      for (const [label, as, mayCall] of [["read", KEYS.reader, op.scope === "read"], ["capture", KEYS.capture, op.scope === "capture"]] as const) {
        if (mayCall) continue;
        const r = restCall(name, key, {});
        const refused = await rest(r.method, r.path, r.body, as);
        const viaMcp = await mcp("tools/call", { name: prefix + key, arguments: {} }, as);
        assert(refused.status === 403 && refused.body.needs === op.scope && viaMcp.error?.message === `Tool ${prefix + key} not found`,
          `${name}: a ${label} key cannot call ${prefix + key}: 403 needs ${op.scope} over REST, and over MCP no such tool for it (${refused.status} ${JSON.stringify(refused.body).slice(0, 80)}; ${JSON.stringify(viaMcp).slice(0, 120)})`);
      }
    }
  }
}

// ── plugins/family-calendar ──────────────────────────────────────────────────

console.log("\n[family-calendar] its members, activities and dates");
{
  const P = "family-calendar";
  const c = (key: string, input: Body, opts?: { as?: string; door?: "rest" | "mcp" }) => call(P, key, input, opts);
  const titles = (r: Called) => ((r.body.activities ?? []) as { title: string }[]).map((a) => a.title).sort().join();
  const [{ today }] = (await sql`SELECT (now() AT TIME ZONE 'UTC')::date::text AS today`) as { today: string }[];
  /** A date `days` from today in UTC, the plugin's today, YYYY-MM-DD. */
  const fromToday = async (days: number) => ((await sql`SELECT (${today}::date + ${days}::int)::text AS d`) as { d: string }[])[0].d;
  /** The same day and month as the date `days` from today, `yearsBack` years earlier. */
  const yearsBefore = async (days: number, yearsBack: number) => ((await sql`SELECT ((${today}::date + ${days}::int) - make_interval(years => ${yearsBack}::int))::date::text AS d`) as { d: string }[])[0].d;

  // Each operation's scope, pinned here: [2] reads the scopes from the manifest it checks, so a wrong declaration there
  // (a write declared read, an add declared capture) would pass it.
  const scopes = Object.fromEntries(Object.entries(REGISTRY.find((p) => p.name === P)!.operations).map(([k, op]) => [k, op.scope]));
  assert(JSON.stringify(scopes) === JSON.stringify({ add_family_member: "write", list_family_members: "read", add_activity: "write", get_week_schedule: "read", search_activities: "read", add_important_date: "write", get_upcoming_dates: "read" }),
    `its seven operations' scopes: the four reads read, the three adds write (${JSON.stringify(scopes)})`);
  const hints = Object.fromEntries((await toolsFor(KEYS.writer)).filter((t) => t.name.startsWith("family_calendar_")).map((t) => [t.name.slice("family_calendar_".length), JSON.stringify(t.annotations)]));
  const ADDS_HINT = JSON.stringify({ destructiveHint: false, openWorldHint: false }), READ_HINT = JSON.stringify({ readOnlyHint: true, openWorldHint: false });
  assert(Object.keys(hints).length === 7 && Object.entries(hints).every(([k, h]) => h === (scopes[k] === "read" ? READ_HINT : ADDS_HINT)),
    `its hints, all seven: an add destroys nothing, a read is read-only, and every operation is closed-world (${JSON.stringify(hints).slice(0, 240)})`);

  const ada = await c("add_family_member", { name: "  Ada ", relationship: "child", birth_date: "2018-03-01" });
  assert(ada.status === 200 && UUID.test(ada.body.member?.id) && ada.body.member?.name === "Ada" && ada.body.member?.relationship === "child" && ada.body.member?.birth_date === "2018-03-01" && !("user_id" in ada.body.member),
    `add_family_member stores the row and answers it: the name trimmed, the birth date bare, no user_id (${JSON.stringify(ada.body).slice(0, 160)})`);
  const adaId = String(ada.body.member?.id);
  const ben = await c("add_family_member", { name: "Ben" }, { door: "mcp" });
  assert(ben.status === 200 && UUID.test(ben.body.member?.id) && ben.body.member?.relationship === null && ben.body.member?.birth_date === null, `…over MCP too, the optional fields null (${JSON.stringify(ben.viaMcp).slice(0, 160)})`);
  const listed = await c("list_family_members", {});
  const members = (listed.body.members ?? []) as { id: string; name: string }[];
  assert(listed.status === 200 && members.map((m) => m.name).join() === "Ada,Ben" && members[0].id === adaId && members[1].id === ben.body.member?.id,
    `list_family_members: every member by name, with the ids the other operations take (${JSON.stringify(members).slice(0, 160)})`);
  const nul = await c("add_family_member", { name: "Cy\u0000" });
  const nulSearch = await c("search_activities", { query: "a\u0000b" });
  assert(nul.status === 400 && nulSearch.status === 400, `a NUL character, which Postgres will not store in text, is refused at 400 in a body and in a query, not the database's 500 (${nul.status}, ${nulSearch.status})`);
  const stored = await one<{ user_id: string | null }>(sql`SELECT user_id::text FROM plugin_family_calendar.family_members WHERE id = ${adaId}`);
  assert(stored.user_id === null, "the row's user_id is left null: kept, and ignored (decided 2026-11-02)");
  const badDay = await c("add_family_member", { name: "Cy", birth_date: "2018-02-30" });
  const yearZero = await c("add_family_member", { name: "Cy", birth_date: "0000-01-01" });
  assert(badDay.status === 400 && yearZero.status === 400, `a birth date that is no date, or in the year 0000 Postgres has not, is refused before the database (${badDay.status}, ${yearZero.status} ${JSON.stringify(yearZero.body).slice(0, 100)})`);

  // Activities around the week of 2026-09-21 (Monday) to 2026-09-27: one weekly; spans across the week, ended before it
  // and reaching into it from before; one-offs inside it and on the day after it; and one weekly whose dates ended before it.
  const swim = await c("add_activity", { family_member_id: adaId, title: "Swimming", activity_type: "sports", day_of_week: "monday", start_time: "16:00", end_time: "17:00" });
  const camp = await c("add_activity", { title: "Autumn camp", activity_type: "school", start_date: "2026-09-20", end_date: "2026-09-27", start_time: "09:00", location: "Lincoln Park" });
  const ended = await c("add_activity", { title: "Spring term", activity_type: "school", start_date: "2026-09-01", end_date: "2026-09-10", start_time: "08:00" });
  const ongoing = await c("add_activity", { title: "Piano", activity_type: "music", start_date: "2026-09-15", end_date: "2026-10-31", start_time: "18:00" }, { door: "mcp" });
  const ahead = await c("add_activity", { title: "Ski trip", activity_type: "sports", start_date: "2026-09-28", start_time: "07:00" });
  // A one-off: a start_date and no end_date is that day alone (the old server ran it on for ever).
  const dentist = await c("add_activity", { title: "Dentist", activity_type: "medical", start_date: "2026-09-24", start_time: "15:00" });
  const lapsed = await c("add_activity", { family_member_id: adaId, title: "Summer tennis", activity_type: "sports", day_of_week: "tuesday", start_date: "2026-06-01", end_date: "2026-08-31", start_time: "10:00" });
  // A weekly one with no start date, ended before every week read below: with Swimming, the two with none, newest first.
  const chess = await c("add_activity", { title: "Chess", activity_type: "games", day_of_week: "sunday", end_date: "2026-06-30" });
  const made = [swim, camp, ended, ongoing, ahead, lapsed, chess, dentist];
  assert(made.every((r) => r.status === 200 && UUID.test(r.body.activity?.id)), `add_activity ×8 (${made.map((r) => r.status === 200 ? "" : JSON.stringify(r.body)).join("").slice(0, 200)})`);
  assert(swim.body.activity?.family_member_id === adaId && swim.body.activity?.family_member?.name === "Ada" && swim.body.activity?.start_time === "16:00" && swim.body.activity?.day_of_week === "monday" && camp.body.activity?.family_member === null && camp.body.activity?.start_date === "2026-09-20",
    `…each answered with its member (or null for the whole family's), its times HH:MM and dates bare (${JSON.stringify(swim.body.activity).slice(0, 200)})`);

  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  assert(swim.body.activity?.end_time === "17:00" && ISO.test(String(swim.body.activity?.created_at)) && ISO.test(String(ada.body.member?.created_at)),
    `…the end time HH:MM too, and created_at ISO text in UTC (${swim.body.activity?.end_time}, ${swim.body.activity?.created_at})`);
  const oneDay = await c("add_activity", { title: "Sports day", activity_type: "school", start_date: "2026-09-25", end_date: "2026-09-25" });
  assert(oneDay.status === 200, `a span of one day, its end its start, is no BAD_DATES (${oneDay.status} ${JSON.stringify(oneDay.body).slice(0, 100)})`);
  const week = await c("get_week_schedule", { week_start: "2026-09-21" });
  assert(week.status === 200 && titles(week) === "Autumn camp,Dentist,Piano,Sports day,Swimming" && week.body.week_end === "2026-09-27",
    `get_week_schedule: the weekly activity, the two spans that reach the week and the one-off inside it — not the span that ended before it, the one-off the day after (the old server's week ran eight days), or the weekly one whose dates ended (${week.status} ${titles(week)} to ${week.body.week_end})`);
  const inWeek = (week.body.activities ?? []) as { title: string; on_date: string }[];
  assert(inWeek.map((a) => `${a.title}@${a.on_date}`).join() === "Autumn camp@2026-09-21,Swimming@2026-09-21,Piano@2026-09-21,Dentist@2026-09-24,Sports day@2026-09-25",
    `…in date order, by start time within a day, each with the date it falls on — a span its first day in the week (${inWeek.map((a) => `${a.title}@${a.on_date}`).join()})`);
  const swimRow = (week.body.activities ?? []).find((a: { title: string }) => a.title === "Swimming");
  assert(JSON.stringify(swimRow?.family_member) === JSON.stringify({ id: adaId, name: "Ada", relationship: "child" }) && (week.body.activities ?? []).find((a: { title: string }) => a.title === "Piano")?.family_member === null,
    `…each with its member, or null for the whole family's (${JSON.stringify(swimRow?.family_member)})`);
  const summer = await c("get_week_schedule", { week_start: "2026-07-06" });
  assert(titles(summer) === "Summer tennis,Swimming", `…the weekly one in a week its dates reach (${titles(summer)})`);
  const forAda = await c("get_week_schedule", { week_start: "2026-09-21", family_member_id: adaId });
  assert(forAda.status === 200 && titles(forAda) === "Swimming", `…filtered to one member (${titles(forAda)})`);
  const forNoOne = await c("get_week_schedule", { week_start: "2026-09-21", family_member_id: NO_ROW });
  assert(forNoOne.status === 404 && forNoOne.body.code === "NO_SUCH_MEMBER" && /list_family_members/.test(String(forNoOne.body.message)),
    `…a member id that names no one: 404 NO_SUCH_MEMBER saying where the ids are, not an empty week (${JSON.stringify(forNoOne.body).slice(0, 160)})`);

  const byQuery = await c("search_activities", { query: "CAMP" });
  assert(byQuery.status === 200 && titles(byQuery) === "Autumn camp", `search_activities by title, any case (${byQuery.status} ${titles(byQuery)})`);
  const byName = await c("search_activities", { query: "ada" });
  assert(titles(byName) === "Summer tennis,Swimming", `…by the member's name (${titles(byName)})`);
  const byType = await c("search_activities", { activity_type: "sports" });
  const byTypeUpper = await c("search_activities", { activity_type: "SPORTS" });
  assert(titles(byType) === "Ski trip,Summer tennis,Swimming" && titles(byTypeUpper) === titles(byType), `…by type, in any case (${titles(byType)} / ${titles(byTypeUpper)})`);
  const byPlace = await c("search_activities", { query: "lincoln" });
  assert(titles(byPlace) === "Autumn camp", `…by location (${titles(byPlace)})`);
  const searchNoOne = await c("search_activities", { family_member_id: NO_ROW });
  assert(searchNoOne.status === 404 && searchNoOne.body.code === "NO_SUCH_MEMBER", `…a member id that names no one: 404 NO_SUCH_MEMBER (${searchNoOne.status})`);
  const both = await c("search_activities", { activity_type: "sports", family_member_id: adaId });
  assert(titles(both) === "Summer tennis,Swimming", `…the filters together (${titles(both)})`);
  const every = await c("search_activities", {});
  const order = ((every.body.activities ?? []) as { title: string }[]).map((a) => a.title);
  assert(every.status === 200 && order.join() === "Ski trip,Sports day,Dentist,Autumn camp,Piano,Spring term,Summer tennis,Chess,Swimming", `…none lists all nine, latest start date first, then the two with none, newest first (${order.join()})`);
  // A weekly activity is listed only where its day in the week is within its own dates: a Monday class starting on the
  // Wednesday of the week of 2026-09-21 first falls on the 28th, and a Monday club ending Sunday the 20th last fell on the 14th.
  const late = await c("add_activity", { title: "Late Monday class", activity_type: "music", day_of_week: "monday", start_date: "2026-09-23" });
  const club = await c("add_activity", { title: "Monday club", activity_type: "music", day_of_week: "monday", start_date: "2026-09-01", end_date: "2026-09-20" });
  assert(late.status === 200 && club.status === 200, "two more weekly activities");
  const weekAgain = await c("get_week_schedule", { week_start: "2026-09-21" });
  const fromTuesday = await c("get_week_schedule", { week_start: "2026-09-15" });
  const next = await c("get_week_schedule", { week_start: "2026-09-28" });
  const before = await c("get_week_schedule", { week_start: "2026-09-14" });
  assert(titles(weekAgain) === "Autumn camp,Dentist,Piano,Sports day,Swimming" && !titles(fromTuesday).includes("Monday club") && titles(next).includes("Late Monday class") && titles(before).includes("Monday club") && !titles(before).includes("Late Monday class"),
    `…a weekly one in a week its dates overlap but where its day falls outside them is left out, and listed in the week its day falls inside (${titles(weekAgain)} / ${titles(fromTuesday)} / ${titles(next)} / ${titles(before)})`);
  assert(titles(next).includes("Ski trip") && !titles(next).includes("Dentist") && titles(next).includes("Piano"), `…a one-off is in the week of its day alone, a span in each week it reaches (${titles(next)})`);
  const capped = await c("search_activities", { limit: 2 });
  assert(((capped.body.activities ?? []) as unknown[]).length === 2 && capped.body.truncated === true && every.body.truncated === false, "…limit applies, and truncated says when more matched");
  assert(titles(await c("search_activities", { query: "swim\u00a0ada" })) === "Swimming", "…a no-break space splits a query's words");
  const allNow = ((await c("search_activities", { limit: 200 })).body.activities ?? []) as unknown[];
  assert((await c("search_activities", { limit: allNow.length })).body.truncated === false && (await c("search_activities", { limit: allNow.length - 1 })).body.truncated === true,
    "…search_activities: exactly limit matches is not truncated, one fewer is");
  assert(titles(await c("search_activities", { query: "swim ada" })) === "Swimming" && titles(await c("search_activities", { query: "park camp" })) === "Autumn camp" && titles(await c("search_activities", { query: "swim camp" })) === "",
    "…a query's words each matched apart, across the title, the member's name and the location, all of them needed");
  await c("add_activity", { title: "Bake sale 50% off", start_date: "2026-10-01" });
  const percent = await c("search_activities", { query: "50%" });
  const underscore = await c("search_activities", { query: "_" });
  await c("add_activity", { title: "Folder C:\\temp", start_date: "2026-10-02" });
  const backslash = await c("search_activities", { query: "C:\\t" });
  assert(titles(percent) === "Bake sale 50% off" && titles(underscore) === "" && titles(backslash) === "Folder C:\\temp", `…a %, an _ or a backslash in the query matches itself, not any text (${titles(percent)} / ${titles(underscore)} / ${titles(backslash)})`);

  // The week's edges, in the week of Monday 2027-03-01 to Sunday 03-07: each edge day in and the day past it out, for a
  // one-off, a span and a weekly activity's own dates; and two on one day, the one with no time after the timed one.
  const edges: [string, Body][] = [
    ["E one-off on the Sunday", { start_date: "2027-03-07" }], ["E one-off the Monday after", { start_date: "2027-03-08" }],
    ["E span ending the Monday", { start_date: "2027-02-20", end_date: "2027-03-01" }], ["E span ending the Sunday before", { start_date: "2027-02-20", end_date: "2027-02-28" }],
    ["E weekly from its Wednesday", { day_of_week: "wednesday", start_date: "2027-03-03", start_time: "08:00" }], ["E weekly from the Thursday", { day_of_week: "wednesday", start_date: "2027-03-04" }],
    ["E weekly to its Wednesday", { day_of_week: "wednesday", start_date: "2027-01-01", end_date: "2027-03-03" }], ["E weekly to the Tuesday", { day_of_week: "wednesday", start_date: "2027-01-01", end_date: "2027-03-02" }],
  ];
  for (const [title, when] of edges) await c("add_activity", { title, activity_type: "edge", ...when });
  const edgeWeek = ((await c("get_week_schedule", { week_start: "2027-03-01" })).body.activities ?? []) as { title: string; on_date: string }[];
  const edgeTitles = edgeWeek.filter((a) => a.title.startsWith("E ")).map((a) => a.title);
  assert(edgeTitles.join() === "E span ending the Monday,E weekly from its Wednesday,E weekly to its Wednesday,E one-off on the Sunday",
    `…each edge day in and the day past it out, in date order, the timed one before the untimed on the same day (${edgeTitles.join()})`);

  const noMember = await c("add_activity", { title: "x", start_date: "2026-09-01", family_member_id: NO_ROW });
  const noMemberMcp = await c("add_activity", { title: "x", start_date: "2026-09-01", family_member_id: NO_ROW }, { door: "mcp" });
  assert(noMember.status === 404 && noMember.body.code === "NO_SUCH_MEMBER" && /list_family_members/.test(String(noMember.body.message)) && noMemberMcp.viaMcp.result?.isError === true && JSON.stringify(noMemberMcp.viaMcp).includes("NO_SUCH_MEMBER"), `a member that is not there: 404 NO_SUCH_MEMBER over both doors (${JSON.stringify(noMember.body)})`);
  const backwards = await c("add_activity", { title: "x", start_date: "2026-09-10", end_date: "2026-09-01" });
  assert(backwards.status === 422 && backwards.body.code === "BAD_DATES", `an end before the start: 422 BAD_DATES (${JSON.stringify(backwards.body)})`);
  const noWhen = await c("add_activity", { title: "x", activity_type: "sports" });
  assert(noWhen.status === 422 && noWhen.body.code === "NO_WHEN", `an activity with neither a day nor a start date, which no week would list: 422 NO_WHEN (${JSON.stringify(noWhen.body)})`);
  const zeroWeek = await c("get_week_schedule", { week_start: "0000-06-01" });
  assert(zeroWeek.status === 400, `a week in the year 0000: 400, not the database's 500 (${zeroWeek.status})`);
  const badDow = await c("add_activity", { title: "x", day_of_week: "Monday" });
  const badTime = await c("add_activity", { title: "x", start_time: "25:00" });
  assert(badDow.status === 400 && badTime.status === 400, `a day not lower-case, a time past 23:59: refused before the database (${badDow.status}, ${badTime.status})`);
  const bounds: [string, string, Body][] = [
    ["a minute of 60", "add_activity", { title: "x", start_date: "2026-09-01", start_time: "16:60" }],
    ["a time with seconds", "add_activity", { title: "x", start_date: "2026-09-01", start_time: "16:00:30" }],
    ["an empty title", "add_activity", { title: "  ", start_date: "2026-09-01" }],
    ["a title of 201 characters", "add_activity", { title: "x".repeat(201), start_date: "2026-09-01" }],
    ["a member id that is no uuid", "add_activity", { title: "x", start_date: "2026-09-01", family_member_id: "Ada" }],
    ["an empty name", "add_family_member", { name: "" }],
    ["an empty relationship", "add_family_member", { name: "x", relationship: " " }],
    ["a reminder of 366 days", "add_important_date", { title: "x", date_value: "2026-09-01", reminder_days_before: 366 }],
    ["a reminder of -1 days", "add_important_date", { title: "x", date_value: "2026-09-01", reminder_days_before: -1 }],
    ["a week's member id that is no uuid", "get_week_schedule", { week_start: "2026-09-21", family_member_id: "Ada" }],
    ["a limit of 0", "search_activities", { limit: 0 }],
    ["a limit of 201", "search_activities", { limit: 201 }],
    ["an empty query", "search_activities", { query: "" }],
    ["days_ahead of 367", "get_upcoming_dates", { days_ahead: 367 }],
  ];
  const outOfBounds: string[] = [];
  for (const [label, key, input] of bounds) {
    const r = await c(key, input);
    if (r.status !== 400) outOfBounds.push(`${label}: ${r.status}`);
  }
  assert(outOfBounds.length === 0, `each input out of its bounds is refused at 400, before the database (${bounds.length} cases; not: ${outOfBounds.join("; ") || "none"})`);
  const strays = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM plugin_family_calendar.activities WHERE title = 'x'`);
  assert(strays.n === 0, "none of the refused ones stored a row");
  // The rule NO_WHEN answers is the table's too, so a row written around the operation (a copy from the old tables) is held to it.
  const tableRefuses = async (statement: string, constraint: RegExp) => {
    try { await sql.unsafe(statement); return `${statement.slice(0, 60)}: stored`; } catch (e) { return constraint.test((e as Error).message) ? "" : `${statement.slice(0, 60)}: ${(e as Error).message.slice(0, 80)}`; }
  };
  const tableMisses = (await Promise.all([
    tableRefuses("INSERT INTO plugin_family_calendar.activities (title) VALUES ('no when')", /activities_weekly_or_dated/),
    tableRefuses("INSERT INTO plugin_family_calendar.activities (title, start_date, end_date) VALUES ('t', '2026-09-10', '2026-09-01')", /activities_end_not_before_start/),
    tableRefuses("INSERT INTO plugin_family_calendar.activities (title, day_of_week) VALUES ('t', 'Monday')", /day_of_week_check/),
    tableRefuses("INSERT INTO plugin_family_calendar.activities (title, start_date) VALUES ('', '2026-09-01')", /title_check/),
    tableRefuses("INSERT INTO plugin_family_calendar.activities (title, start_date, family_member_id) VALUES ('t', '2026-09-01', '00000000-0000-4000-8000-00000000dead')", /foreign key/),
    tableRefuses("INSERT INTO plugin_family_calendar.family_members (name) VALUES ('')", /name_check/),
    tableRefuses("INSERT INTO plugin_family_calendar.important_dates (title, date_value, reminder_days_before) VALUES ('t', '2026-09-01', 366)", /reminder_days_before_check/),
  ])).filter(Boolean);
  assert(tableMisses.length === 0, `…and the tables hold the rules themselves, so a row written around the operations (the README's copy) is refused by name (${tableMisses.join("; ") || "all seven"})`);

  // Dates: a birthday whose stored year is long past (the old server never listed one), a deadline, one past, one beyond.
  const bdayOn = await fromToday(10);
  const bday = await c("add_important_date", { family_member_id: adaId, title: "Ada's birthday", date_value: await yearsBefore(10, 8), recurring_yearly: true });
  const renewal = await c("add_important_date", { title: "Insurance renewal", date_value: await fromToday(60), reminder_days_before: 14 }, { door: "mcp" });
  const past = await c("add_important_date", { title: "Old deadline", date_value: await fromToday(-3) });
  const todayOne = await c("add_important_date", { title: "Today's deadline", date_value: today, reminder_days_before: 0 });
  assert([bday, renewal, past, todayOne].every((r) => r.status === 200 && UUID.test(r.body.important_date?.id)), `add_important_date ×4 (${[bday, renewal, past, todayOne].map((r) => JSON.stringify(r.body)).join(" ").slice(0, 200)})`);
  assert(bday.body.important_date?.next_date === bdayOn && renewal.body.important_date?.next_date === (await fromToday(60)) && past.body.important_date?.next_date === null,
    `each added date answers when it next comes: the yearly birthday on its anniversary, the renewal on its day, and a one-time date already past null, so the agent can say it will not be listed (${past.body.important_date?.next_date})`);
  assert(bday.body.important_date?.recurring_yearly === true && bday.body.important_date?.reminder_days_before === 7 && bday.body.important_date?.family_member?.name === "Ada" && renewal.body.important_date?.reminder_days_before === 14 && renewal.body.important_date?.recurring_yearly === false,
    `…the defaults filled, the member folded in (${JSON.stringify(bday.body.important_date).slice(0, 200)})`);
  const soon = await c("get_upcoming_dates", { days_ahead: 30 });
  const soonDates = (soon.body.dates ?? []) as { title: string; next_date: string; days_until: number; remind: boolean; date_value: string }[];
  assert(soon.status === 200 && soon.body.today === today && soonDates.map((d) => d.title).join() === "Today's deadline,Ada's birthday",
    `get_upcoming_dates: today's, then the yearly birthday on its next anniversary — not the past one or the one beyond (${soon.status} ${soonDates.map((d) => d.title).join()})`);
  const b = soonDates.find((d) => d.title === "Ada's birthday");
  assert(b?.next_date === bdayOn && b?.days_until === 10 && b?.remind === false && b?.date_value === (await yearsBefore(10, 8)), `…its next_date ${bdayOn}, ten days off, outside its seven days' reminder; its stored date unchanged (${JSON.stringify(b)})`);
  assert(soonDates[0]?.days_until === 0 && soonDates[0]?.remind === true, "…today's is zero days off, and reminded of");
  // The user's own today, a day behind UTC's: the birthday eleven days off, today's deadline tomorrow.
  const behindDates = ((await c("get_upcoming_dates", { days_ahead: 30, today: await fromToday(-1) })).body.dates ?? []) as { title: string; days_until: number }[];
  assert(behindDates.find((d) => d.title === "Ada's birthday")?.days_until === 11 && behindDates.find((d) => d.title === "Today's deadline")?.days_until === 1,
    `…given the user's today, it counts from that day (${behindDates.map((d) => `${d.title}@${d.days_until}`).join()})`);
  const farDates = await c("get_upcoming_dates", { today: await fromToday(3) });
  const pastDates = await c("get_upcoming_dates", { today: await fromToday(-2) });
  assert(farDates.status === 400 && pastDates.status === 400, `…a today more than a day from UTC's, ahead or behind, is refused at 400 (${farDates.status}, ${pastDates.status})`);
  const wider = await c("get_upcoming_dates", { days_ahead: 90 });
  const widerDates = (wider.body.dates ?? []) as { title: string; family_member: unknown }[];
  assert(widerDates.map((d) => d.title).join() === "Today's deadline,Ada's birthday,Insurance renewal" && widerDates[2]?.family_member === null, `…a wider window takes in the renewal, a family-wide date's member null (${widerDates.map((d) => d.title).join()})`);
  const defaulted = await c("get_upcoming_dates", {});
  assert(((defaulted.body.dates ?? []) as unknown[]).length === 2, "…thirty days unless given");
  // Added on the user's today, a day behind UTC's: a one-time date on that day comes today, not never.
  const behindDay = await fromToday(-1);
  const onBehind = await c("add_important_date", { title: "Behind deadline", date_value: behindDay, today: behindDay });
  const onBehindUtc = await c("add_important_date", { title: "Behind deadline, no today", date_value: behindDay });
  assert(onBehind.body.important_date?.next_date === behindDay && onBehindUtc.body.important_date?.next_date === null,
    `…an added date's next_date counts from the user's today when given: a one-time date on it is today, not past (${onBehind.body.important_date?.next_date}, ${onBehindUtc.body.important_date?.next_date})`);
  const behindUpcoming = ((await c("get_upcoming_dates", { days_ahead: 0, today: behindDay })).body.dates ?? []) as { title: string; days_until: number }[];
  assert(behindUpcoming.find((d) => d.title === "Behind deadline")?.days_until === 0, `…and get_upcoming_dates given that today lists it at zero days (${behindUpcoming.map((d) => `${d.title}@${d.days_until}`).join()})`);
  const annivToday = await c("add_important_date", { title: "Anniversary added today", date_value: await yearsBefore(0, 3), recurring_yearly: true });
  const annivPast = await c("add_important_date", { title: "Anniversary ten days gone", date_value: await yearsBefore(-10, 3), recurring_yearly: true });
  assert(annivToday.body.important_date?.next_date === today && annivPast.body.important_date?.next_date === (await yearsBefore(-10, -1)),
    `…a yearly date added on its anniversary comes today; one ten days gone comes next year (${annivToday.body.important_date?.next_date}, ${annivPast.body.important_date?.next_date})`);
  const noMemberDate = await c("add_important_date", { title: "x", date_value: today, family_member_id: NO_ROW });
  assert(noMemberDate.status === 404 && noMemberDate.body.code === "NO_SUCH_MEMBER", "a date for a member that is not there: 404 NO_SUCH_MEMBER");
  const zeroDate = await c("add_important_date", { title: "x", date_value: "0000-02-29" });
  assert(zeroDate.status === 400, `a date in the year 0000: 400 (${zeroDate.status})`);
  const strayDates = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM plugin_family_calendar.important_dates WHERE title = 'x'`);
  assert(strayDates.n === 0, "neither refused date stored a row");

  // Dates added after the windows above were read: a yearly one whose anniversary is today, a 29 February, two dated
  // thirty and thirty-one days on either side of the default, a yearly one stored under next year, and a deadline
  // forty days off whose 45 days' reminder has begun.
  await c("add_important_date", { title: "Anniversary today", date_value: await yearsBefore(0, 5), recurring_yearly: true });
  await c("add_important_date", { title: "Leap day", date_value: "2020-02-29", recurring_yearly: true });
  await c("add_important_date", { title: "Day thirty", date_value: await fromToday(30) });
  await c("add_important_date", { title: "Day thirty-one", date_value: await fromToday(31) });
  await c("add_important_date", { title: "Next year's birthday", date_value: await yearsBefore(20, -1), recurring_yearly: true });
  await c("add_important_date", { title: "Long reminder", date_value: await fromToday(40), reminder_days_before: 45 });
  const zero = await c("get_upcoming_dates", { days_ahead: 0 });
  const zeroDates = (zero.body.dates ?? []) as { title: string; next_date: string; days_until: number; remind: boolean }[];
  assert(zeroDates.filter((d) => d.days_until === 0).map((d) => d.title).join() === "Anniversary added today,Anniversary today,Today's deadline" && zeroDates.every((d) => d.days_until === 0 ? d.next_date === today : d.remind)
         && zeroDates.some((d) => d.title === "Long reminder"),
    `days_ahead 0: today's, a yearly date whose anniversary is today among them, and beyond today only those whose reminder has begun (${zeroDates.map((d) => d.title).join()})`);
  const thirty = ((await c("get_upcoming_dates", {})).body.dates ?? []) as { title: string; next_date: string; days_until: number; remind: boolean }[];
  assert(thirty.some((d) => d.title === "Day thirty") && !thirty.some((d) => d.title === "Day thirty-one"), `…unless given, thirty days: the thirtieth day in, the thirty-first out (${thirty.map((d) => d.title).join()})`);
  const nextYears = thirty.find((d) => d.title === "Next year's birthday");
  assert(nextYears?.next_date === (await fromToday(20)), `…a yearly date stored under next year comes round this year all the same, on its month and day (${JSON.stringify(nextYears)})`);
  const longOne = thirty.find((d) => d.title === "Long reminder");
  assert(longOne?.days_until === 40 && longOne.remind === true, `…and a date past the window whose reminder has begun is listed, reminded of (${JSON.stringify(longOne)})`);
  // 29 February's next anniversary, as the description says: that day in a leap year, the 28th in another. Reckoned
  // here from today in UTC, and found in a year's window wherever today falls.
  const [ty, tm, td] = today.split("-").map(Number);
  const leapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const feb = (y: number) => `${y}-02-${leapYear(y) ? "29" : "28"}`;
  const expected = (tm < 2 || (tm === 2 && td <= (leapYear(ty) ? 29 : 28))) ? feb(ty) : feb(ty + 1);
  const year = ((await c("get_upcoming_dates", { days_ahead: 366 })).body.dates ?? []) as { title: string; next_date: string }[];
  const leap = year.find((d) => d.title === "Leap day");
  assert(leap?.next_date === expected, `a yearly 29 February comes round on ${expected} (${JSON.stringify(leap)})`);
  assert(!year.some((d) => d.title === "Old deadline"), "…and a one-time date already past is in no window, a year's included: it does not come round");
}

// ── Shared by the plugins' sections ──────────────────────────────────────────

/** Each operation's scope as `plugin`'s manifest declares it, for a section to pin: [2] reads the same manifest. */
const scopesOf = (plugin: string) => Object.fromEntries(Object.entries(REGISTRY.find((p) => p.name === plugin)!.operations).map(([k, op]) => [k, op.scope]));
/** Each of `plugin`'s tools' MCP hints, as a write key's tools/list shows them. */
async function hintsOf(plugin: string): Promise<Record<string, string>> {
  const prefix = `${plugin.replaceAll("-", "_")}_`;
  return Object.fromEntries((await toolsFor(KEYS.writer)).filter((t) => t.name.startsWith(prefix)).map((t) => [t.name.slice(prefix.length), JSON.stringify(t.annotations)]));
}
const ADDS_HINT = JSON.stringify({ destructiveHint: false, openWorldHint: false });
const READ_HINT = JSON.stringify({ readOnlyHint: true, openWorldHint: false });
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** JSON with every object's keys sorted: jsonb keeps no key order, so an answer's object is compared by its content. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
/** Each input, sent to its operation, that is answered other than 400: the bounds a section holds. */
async function outOfBounds(c: (key: string, input: Body) => Promise<Called>, cases: [string, string, Body][]): Promise<string[]> {
  const missed: string[] = [];
  for (const [label, key, input] of cases) {
    const r = await c(key, input);
    if (r.status !== 400) missed.push(`${label}: ${r.status}`);
  }
  return missed;
}
/** Each statement, run around the operations as the database owner, that a table does not refuse by the check named. */
async function tableMisses(cases: [string, RegExp][]): Promise<string[]> {
  const missed: string[] = [];
  for (const [statement, constraint] of cases) {
    try {
      await sql.unsafe(statement);
      missed.push(`${statement.slice(0, 60)}: stored`);
    } catch (e) {
      if (!constraint.test((e as Error).message)) missed.push(`${statement.slice(0, 60)}: ${(e as Error).message.slice(0, 80)}`);
    }
  }
  return missed;
}
const [{ utcToday }] = (await sql`SELECT (now() AT TIME ZONE 'UTC')::date::text AS "utcToday"`) as { utcToday: string }[];
/** A date `days` from today in UTC, the plugins' today, YYYY-MM-DD. */
const dayFromToday = async (days: number) => ((await sql`SELECT (${utcToday}::date + ${days}::int)::text AS d`) as { d: string }[])[0].d;

// ── plugins/home-maintenance ─────────────────────────────────────────────────

console.log("\n[home-maintenance] its tasks and the log of work done");
{
  const P = "home-maintenance";
  const c = (key: string, input: Body, opts?: { as?: string; door?: "rest" | "mcp" }) => call(P, key, input, opts);
  const names = (r: Called, field = "tasks") => ((r.body[field] ?? []) as { name: string }[]).map((t) => t.name).join();
  const scopes = scopesOf(P);
  assert(JSON.stringify(scopes) === JSON.stringify({ add_maintenance_task: "write", list_maintenance_tasks: "read", log_maintenance: "write", get_upcoming_maintenance: "read", search_maintenance_history: "read" }),
    `its five operations' scopes: the three reads read, the add and the log write (${JSON.stringify(scopes)})`);
  const hints = await hintsOf(P);
  assert(Object.keys(hints).length === 5 && Object.entries(hints).every(([k, h]) => h === (scopes[k] === "read" ? READ_HINT : ADDS_HINT)), `its hints, all five (${JSON.stringify(hints).slice(0, 200)})`);

  // Tasks: recurring with a date, one-time undated, one-time years out, recurring with no date (due frequency_days on),
  // one overdue, and an urgent one due the same day as the high one.
  const hvac = await c("add_maintenance_task", { name: "HVAC filter replacement", category: "hvac", frequency_days: 90, next_due: await dayFromToday(20), priority: "high", notes: "16x25x1 pleated" });
  const gutter = await c("add_maintenance_task", { name: "Gutter cleaning", category: "exterior" });
  const roof = await c("add_maintenance_task", { name: "Roof inspection", category: "exterior", next_due: await dayFromToday(5 * 365) });
  const filter = await c("add_maintenance_task", { name: "Water filter", category: "plumbing", frequency_days: 30 }, { door: "mcp" });
  const smoke = await c("add_maintenance_task", { name: "Smoke alarm test", category: "safety", frequency_days: 365, next_due: await dayFromToday(-5) });
  const salt = await c("add_maintenance_task", { name: "Softener salt", category: "plumbing", frequency_days: 60, next_due: await dayFromToday(20), priority: "urgent" });
  const made = [hvac, gutter, roof, filter, smoke, salt];
  assert(made.every((r) => r.status === 200 && UUID.test(r.body.task?.id)), `add_maintenance_task ×6 (${made.map((r) => (r.status === 200 ? "" : JSON.stringify(r.body))).join("").slice(0, 200)})`);
  assert(hvac.body.task?.priority === "high" && hvac.body.task?.next_due === (await dayFromToday(20)) && hvac.body.task?.days_until === 20 && hvac.body.task?.done === false && ISO.test(String(hvac.body.task?.created_at)) && !("user_id" in hvac.body.task),
    `…the task answered with its due date bare, days_until, done and created_at ISO, no user_id (${JSON.stringify(hvac.body.task).slice(0, 200)})`);
  const { id: _hvacId, created_at: _hc, updated_at: hvacUpdated, ...hvacRest } = hvac.body.task ?? {};
  assert(JSON.stringify(hvacRest) === JSON.stringify({ name: "HVAC filter replacement", category: "hvac", frequency_days: 90, last_completed: null, next_due: await dayFromToday(20), priority: "high", notes: "16x25x1 pleated", done: false, days_until: 20 }) && ISO.test(String(hvacUpdated)),
    `…every field of the task as it was given, updated_at ISO (${JSON.stringify(hvac.body.task).slice(0, 240)})`);
  assert(gutter.body.task?.next_due === null && gutter.body.task?.frequency_days === null && gutter.body.task?.priority === "medium" && gutter.body.task?.days_until === null,
    "…a one-time task with no date: no due date, priority medium unless given");
  assert(filter.body.task?.next_due === (await dayFromToday(30)) && filter.body.task?.days_until === 30, `…a recurring task given no date falls due frequency_days from today (${filter.body.task?.next_due})`);
  const ids = { hvac: String(hvac.body.task?.id), gutter: String(gutter.body.task?.id), filter: String(filter.body.task?.id) };

  const listed = await c("list_maintenance_tasks", {});
  assert(listed.status === 200 && names(listed) === "Smoke alarm test,Softener salt,HVAC filter replacement,Water filter,Roof inspection,Gutter cleaning",
    `list_maintenance_tasks: every task with its id, soonest due first, urgent before high on one day, the undated last (${names(listed)})`);
  assert(names(await c("list_maintenance_tasks", { query: "GUTTER" })) === "Gutter cleaning" && names(await c("list_maintenance_tasks", { category: "exter" })) === "Roof inspection,Gutter cleaning"
         && names(await c("list_maintenance_tasks", { query: "pleated" })) === "HVAC filter replacement",
    "…by name in any case, by category, and by the notes");
  const two = await c("list_maintenance_tasks", { limit: 2 });
  assert((two.body.tasks as unknown[]).length === 2 && two.body.truncated === true && (await c("list_maintenance_tasks", {})).body.truncated === false, "…limit applies, and truncated says when more matched");
  assert(names(await c("list_maintenance_tasks", { query: "filter HVAC" })) === "HVAC filter replacement" && names(await c("list_maintenance_tasks", { query: "pleated hvac" })) === "HVAC filter replacement"
         && names(await c("list_maintenance_tasks", { query: "HVAC gutter" })) === "",
    "…a query's words each matched apart, in any order and across the name and the notes, all of them needed");

  const upcoming = await c("get_upcoming_maintenance", { days_ahead: 30 });
  const up = (upcoming.body.tasks ?? []) as { name: string; days_until: number }[];
  assert(upcoming.status === 200 && upcoming.body.today === utcToday && up.map((t) => `${t.name}@${t.days_until}`).join() === "Smoke alarm test@-5,Softener salt@20,HVAC filter replacement@20,Water filter@30",
    `get_upcoming_maintenance: the overdue one first at a negative days_until, then those due in the window by date and priority; not the roof years out or the undated gutter (${up.map((t) => `${t.name}@${t.days_until}`).join()})`);
  assert(names(await c("get_upcoming_maintenance", { days_ahead: 0 })) === "Smoke alarm test", "…days_ahead 0: the overdue alone");
  assert(names(await c("get_upcoming_maintenance", {})) === names(upcoming), "…thirty days unless given");
  assert(names(await c("get_upcoming_maintenance", { days_ahead: 29 })) === "Smoke alarm test,Softener salt,HVAC filter replacement", "…the thirtieth day's task out of a 29-day window");
  // The user's own today, a day behind UTC's: every days_until one more, and the window counted from it.
  const yesterday = await dayFromToday(-1);
  const behind = await c("get_upcoming_maintenance", { days_ahead: 30, today: yesterday });
  const behindUp = (behind.body.tasks ?? []) as { name: string; days_until: number }[];
  assert(behind.body.today === yesterday && behindUp.map((t) => `${t.name}@${t.days_until}`).join() === "Smoke alarm test@-4,Softener salt@21,HVAC filter replacement@21",
    `…given the user's today, it counts from that day: days_until one more each, and the thirtieth UTC day past the window (${behindUp.map((t) => `${t.name}@${t.days_until}`).join()})`);
  const listedBehind = ((await c("list_maintenance_tasks", { today: yesterday })).body.tasks ?? []) as { name: string; days_until: number | null }[];
  assert(listedBehind.find((t) => t.name === "Water filter")?.days_until === 31, "…and list_maintenance_tasks counts days_until from it too");
  const fromYesterday = await c("add_maintenance_task", { name: "Dryer vent", frequency_days: 10, today: yesterday });
  assert(fromYesterday.body.task?.next_due === (await dayFromToday(9)) && fromYesterday.body.task?.days_until === 10, `…and a recurring task added on the user's today falls due from it (${fromYesterday.body.task?.next_due})`);
  // A today more than a day from UTC's is no time zone's: a typo, refused before it dates a stored row.
  const farToday: string[] = [];
  for (const [key, input] of [["add_maintenance_task", { name: "x", frequency_days: 30, today: "2062-01-01" }], ["add_maintenance_task", { name: "x", frequency_days: 30, today: await dayFromToday(2) }],
                              ["list_maintenance_tasks", { today: await dayFromToday(-2) }], ["get_upcoming_maintenance", { today: "2100-01-01" }],
                              ["log_maintenance", { task_id: ids.filter, completed_on: utcToday, today: "0001-01-01" }]] as const) {
    const r = await c(key, input as Body);
    if (r.status !== 400) farToday.push(`${key} ${JSON.stringify(input)}: ${r.status}`);
  }
  assert(farToday.length === 0, `…and a today more than a day from UTC's is refused at 400, on every operation that takes it (${farToday.join("; ") || "all five"})`);
  assert(names(await c("list_maintenance_tasks", { query: "filter\u00a0HVAC" })) === "HVAC filter replacement", "…a no-break space between a query's words splits them as a space does");
  const allTasks = await c("list_maintenance_tasks", {});
  const exactly = await c("list_maintenance_tasks", { limit: (allTasks.body.tasks as unknown[]).length });
  assert(exactly.body.truncated === false && (exactly.body.tasks as unknown[]).length === (allTasks.body.tasks as unknown[]).length, "…list_maintenance_tasks: exactly limit matches is not truncated");

  // Logging: a recurring task moves on from the day logged, an older log leaves it where it is, a one-time task is done.
  const ten = await dayFromToday(-10);
  const logged = await c("log_maintenance", { task_id: ids.hvac, completed_on: ten, performed_by: "self", cost: 45.5, notes: "changed the filter", next_action: "check the coil" });
  const { id: logId, created_at: logCreated, ...logRest } = logged.body.log ?? {};
  assert(logged.status === 200 && UUID.test(logId) && ISO.test(String(logCreated))
         && JSON.stringify(logRest) === JSON.stringify({ task_id: ids.hvac, completed_on: ten, performed_by: "self", cost: 45.5, notes: "changed the filter", next_action: "check the coil", task: { id: ids.hvac, name: "HVAC filter replacement", category: "hvac" } }),
    `log_maintenance stores the log, its cost a number, its task folded in (${JSON.stringify(logged.body.log).slice(0, 200)})`);
  assert(logged.body.task?.last_completed === ten && logged.body.task?.next_due === (await dayFromToday(80)) && logged.body.task?.days_until === 80,
    `…and answers the task moved on: last_completed the day logged, next_due ninety days after it (${JSON.stringify(logged.body.task).slice(0, 160)})`);
  assert(String(logged.body.task?.updated_at) > String(hvacUpdated), `…its updated_at moved on by the log (${hvacUpdated} → ${logged.body.task?.updated_at})`);
  const older = await c("log_maintenance", { task_id: ids.hvac, completed_on: await dayFromToday(-100), performed_by: "self" }, { door: "mcp" });
  assert(older.status === 200 && older.body.task?.last_completed === ten && older.body.task?.next_due === (await dayFromToday(80)),
    `…a log of older work is kept, and the task is not moved back (the old trigger moved it to the older day) (${JSON.stringify(older.body.task).slice(0, 160)})`);
  const once = await c("log_maintenance", { task_id: ids.gutter, completed_on: await dayFromToday(-4), performed_by: "Ann the Plumber" });
  assert(once.status === 200 && once.body.task?.done === true && once.body.task?.next_due === null && once.body.task?.last_completed === (await dayFromToday(-4)), "…a one-time task logged is done, with no due date");
  const today = await c("log_maintenance", { task_id: ids.filter, completed_on: utcToday });
  assert(today.status === 200 && today.body.log?.completed_on === utcToday && today.body.task?.next_due === (await dayFromToday(30)), "…a recurring task logged today falls due frequency_days on");
  // completed_on is the user's own day, never the server's guess: a log written under UTC's today would be a day off for
  // part of every day, and no later log can move a task back.
  const noDay = await c("log_maintenance", { task_id: ids.filter });
  const future = await c("log_maintenance", { task_id: ids.filter, completed_on: await dayFromToday(2) });
  const filterLogs = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM plugin_home_maintenance.maintenance_logs WHERE task_id = ${ids.filter}`);
  assert(noDay.status === 400 && future.status === 422 && future.body.code === "FUTURE_DATE" && filterLogs.n === 1,
    `…a log with no completed_on: 400; one more than a day past today in UTC: 422 FUTURE_DATE, nothing stored (${noDay.status}, ${future.status} ${JSON.stringify(future.body).slice(0, 120)})`);
  assert(!names(await c("list_maintenance_tasks", {})).includes("Gutter cleaning") && names(await c("list_maintenance_tasks", { include_done: true })).endsWith("Gutter cleaning")
         && !names(await c("get_upcoming_maintenance", { days_ahead: 366 })).includes("Gutter cleaning"),
    "…and a done task is listed only with include_done, last, and is never upcoming");
  const orphan = await c("log_maintenance", { task_id: NO_ROW, completed_on: utcToday });
  const orphanMcp = await c("log_maintenance", { task_id: NO_ROW, completed_on: utcToday }, { door: "mcp" });
  assert(orphan.status === 404 && orphan.body.code === "NO_SUCH_TASK" && /list_maintenance_tasks/.test(String(orphan.body.message)) && orphanMcp.viaMcp.result?.isError === true && JSON.stringify(orphanMcp.viaMcp).includes("NO_SUCH_TASK"),
    `a log for no task: 404 NO_SUCH_TASK over both doors, saying where the ids are (${JSON.stringify(orphan.body).slice(0, 160)})`);

  const history = await c("search_maintenance_history", {});
  const logs = (history.body.logs ?? []) as { task: { name: string }; completed_on: string }[];
  assert(history.status === 200 && logs.map((l) => l.task.name).join() === "Water filter,Gutter cleaning,HVAC filter replacement,HVAC filter replacement" && logs[2].completed_on === ten,
    `search_maintenance_history: every log, latest first, each with its task (${logs.map((l) => `${l.task.name}@${l.completed_on}`).join()})`);
  assert(history.body.count === 4 && history.body.total_cost === 45.5 && history.body.truncated === false, `…with count and total_cost over every log that matched (${history.body.count}, ${history.body.total_cost})`);
  const page = await c("search_maintenance_history", { limit: 1 });
  assert(((page.body.logs ?? []) as unknown[]).length === 1 && page.body.count === 4 && page.body.total_cost === 45.5 && page.body.truncated === true,
    `…a page of one still counts and costs all four, and says it is truncated (${JSON.stringify({ count: page.body.count, total_cost: page.body.total_cost, truncated: page.body.truncated })})`);
  const none = await c("search_maintenance_history", { task_name: "zzz" });
  assert(none.body.count === 0 && none.body.total_cost === 0 && JSON.stringify(none.body.logs) === "[]" && none.body.truncated === false, "…and nothing matched is zero of each, no log");
  const histNames = async (input: Body) => (((await c("search_maintenance_history", input)).body.logs ?? []) as { task: { name: string } }[]).map((l) => l.task.name).join();
  assert((await histNames({ task_name: "replacement HVAC" })) === (await histNames({ task_name: "hvac" })) && (await histNames({ task_name: "HVAC gutter" })) === "",
    "…task_name's words each matched apart in the task's name, all of them needed");
  assert((await histNames({ task_id: ids.hvac })) === "HVAC filter replacement,HVAC filter replacement" && (await histNames({ task_name: "hvac" })) === "HVAC filter replacement,HVAC filter replacement"
         && (await histNames({ category: "EXTER" })) === "Gutter cleaning" && (await histNames({ task_name: "zzz" })) === "",
    "…by task, by name, by category in any case, and a name no task has is an empty list");
  assert((await histNames({ date_from: await dayFromToday(-7) })) === "Water filter,Gutter cleaning" && (await histNames({ date_to: ten })) === "HVAC filter replacement,HVAC filter replacement"
         && (await histNames({ date_from: ten, date_to: ten })) === "HVAC filter replacement" && (await histNames({ limit: 1 })) === "Water filter",
    "…from a day, to a day (both edge days in), and the limit");
  const unknownTask = await c("search_maintenance_history", { task_id: NO_ROW });
  const backwards = await c("search_maintenance_history", { date_from: ten, date_to: await dayFromToday(-20) });
  assert(unknownTask.status === 404 && unknownTask.body.code === "NO_SUCH_TASK" && unknownTask.viaMcp.result?.isError === true && JSON.stringify(unknownTask.viaMcp).includes("NO_SUCH_TASK")
         && backwards.status === 422 && backwards.body.code === "BAD_DATES",
    `…a task id that names no task: 404 NO_SUCH_TASK, not an empty history; a date_to before date_from: 422 BAD_DATES (${unknownTask.status}, ${backwards.status})`);
  assert(names(await c("list_maintenance_tasks", { query: "exterior" })) === "Roof inspection" && names(await c("list_maintenance_tasks", { query: "16x25x1" })) === "HVAC filter replacement",
    "…a query reads the category and the notes too");
  // A log's answered task counts days_until from the user's today when given: logged eleven days back, due thirty after.
  const hinge = String((await c("add_maintenance_task", { name: "Gate hinge", frequency_days: 30 })).body.task?.id);
  const loggedBehind = await c("log_maintenance", { task_id: hinge, completed_on: await dayFromToday(-11), today: await dayFromToday(-1) });
  assert(loggedBehind.body.task?.next_due === (await dayFromToday(19)) && loggedBehind.body.task?.days_until === 20, `…and the task a log answers counts days_until from the user's today when given (${loggedBehind.body.task?.days_until})`);
  // A newer log after an older one: both last_completed and next_due move on to the newer day.
  const fresh = String((await c("add_maintenance_task", { name: "Hose bib", frequency_days: 30 })).body.task?.id);
  await c("log_maintenance", { task_id: fresh, completed_on: await dayFromToday(-20) });
  const newerLog = await c("log_maintenance", { task_id: fresh, completed_on: await dayFromToday(-5) });
  assert(newerLog.body.task?.last_completed === (await dayFromToday(-5)) && newerLog.body.task?.next_due === (await dayFromToday(25)), `…a newer log moves last_completed and next_due on from its day (${JSON.stringify(newerLog.body.task).slice(0, 160)})`);
  // UTC's tomorrow is a user's today in UTC+13 and +14: accepted.
  const tomorrow = await c("log_maintenance", { task_id: fresh, completed_on: await dayFromToday(1) });
  assert(tomorrow.status === 200, `…a completed_on of UTC's tomorrow, a far-east user's today, is accepted (${tomorrow.status})`);
  assert((await histNames({ category: "_" })) === "" && (await histNames({ task_name: "_" })) === "", "…history's category and task_name match an _ as itself");
  // A one-time task with a date, logged: done, its date gone.
  const roofDone = await c("log_maintenance", { task_id: String(roof.body.task?.id), completed_on: utcToday });
  assert(roofDone.body.task?.done === true && roofDone.body.task?.next_due === null && roofDone.body.task?.days_until === null, `…a one-time task with a date, logged, is done and its next_due gone (${JSON.stringify(roofDone.body.task).slice(0, 160)})`);

  const missed = await outOfBounds(c, [
    ["a frequency of 0 days", "add_maintenance_task", { name: "x", frequency_days: 0 }], ["a frequency of 3651 days", "add_maintenance_task", { name: "x", frequency_days: 3651 }],
    ["a priority of critical", "add_maintenance_task", { name: "x", priority: "critical" }], ["an empty name", "add_maintenance_task", { name: " " }],
    ["a NUL in the name", "add_maintenance_task", { name: "x\u0000" }], ["a due date in the year 0000", "add_maintenance_task", { name: "x", next_due: "0000-01-01" }],
    ["a cost below 0", "log_maintenance", { task_id: ids.hvac, cost: -1 }], ["a task id that is no uuid", "log_maintenance", { task_id: "hvac" }],
    ["days_ahead of 367", "get_upcoming_maintenance", { days_ahead: 367 }], ["a limit of 0", "search_maintenance_history", { limit: 0 }],
    ["a limit of 501", "list_maintenance_tasks", { limit: 501 }], ["a name of 201 characters", "add_maintenance_task", { name: "x".repeat(201) }],
    ["an empty category", "add_maintenance_task", { name: "x", category: "" }], ["a frequency of 1.5 days", "add_maintenance_task", { name: "x", frequency_days: 1.5 }],
    ["a cost past 99999999.99", "log_maintenance", { task_id: ids.hvac, completed_on: utcToday, cost: 1e9 }], ["days_ahead of -1", "get_upcoming_maintenance", { days_ahead: -1 }],
  ]);
  assert(missed.length === 0, `each input out of its bounds is refused at 400, before the database (not: ${missed.join("; ") || "none"})`);
  const strays = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM plugin_home_maintenance.maintenance_tasks WHERE name = 'x'`);
  assert(strays.n === 0, "none of them stored a task");
  const misses = await tableMisses([
    ["INSERT INTO plugin_home_maintenance.maintenance_tasks (name, priority) VALUES ('t', 'critical')", /priority_check/],
    ["INSERT INTO plugin_home_maintenance.maintenance_tasks (name, frequency_days) VALUES ('t', 0)", /frequency_days_check/],
    ["INSERT INTO plugin_home_maintenance.maintenance_tasks (name) VALUES ('')", /name_check/],
    ["INSERT INTO plugin_home_maintenance.maintenance_logs (task_id, completed_on) VALUES ('00000000-0000-4000-8000-00000000dead', '2026-01-01')", /foreign key/],
    [`INSERT INTO plugin_home_maintenance.maintenance_logs (task_id, completed_on, cost) VALUES ('${ids.hvac}', '2026-01-01', -1)`, /cost_check/],
  ]);
  assert(misses.length === 0, `…and the tables hold the rules themselves, each by name (${misses.join("; ") || "all five"})`);

  await c("add_maintenance_task", { name: "Paint 50% of the fence", category: "exterior" });
  assert(names(await c("list_maintenance_tasks", { query: "50%" })) === "Paint 50% of the fence" && names(await c("list_maintenance_tasks", { query: "_" })) === "" && names(await c("list_maintenance_tasks", { category: "_" })) === "",
    "a %, or an _ in a query or a category, matches itself, not any text");
  // Two logs at once, forced to race: a row lock held around both (FOR NO KEY UPDATE, which the logs' foreign-key
  // checks pass) stops each at its UPDATE after its statement has taken its snapshot, the newer queued first. Released,
  // one commits and the other's UPDATE, which waited on it, re-reads the row. Either way the task must keep the newer
  // day. A move-on read from the logs (a max over them, as pass 1 had it) is read before the wait, and loses the newer
  // day whenever the newer commits first, which Postgres's wake order gives about one round in three: ten rounds.
  const raceTask = String((await c("add_maintenance_task", { name: "Race probe", frequency_days: 7 })).body.task?.id);
  const waiting = async () => Number(((await sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'ob1_plugins_home_maintenance' AND wait_event_type = 'Lock'`) as { n: number }[])[0].n);
  const raceLost: string[] = [];
  for (let round = 0; round < 10; round++) {
    // Each round's days newer than every earlier round's, so a max over all the task's logs is this round's when it
    // sees both: only the race can lose the newer day.
    const base = -300 + round * 20;
    const [newerDay, olderDay] = [await dayFromToday(base + 15), await dayFromToday(base + 10)];
    const holder = new SQL({ url: URL_, max: 1 });
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const isHeld = new Promise<void>((r) => (held = r));
    const holding = holder.begin(async (tx) => {
      await tx`SELECT 1 FROM plugin_home_maintenance.maintenance_tasks WHERE id = ${raceTask} FOR NO KEY UPDATE`;
      held();
      await released;
    });
    await isHeld;
    const racerNewer = c("log_maintenance", { task_id: raceTask, completed_on: newerDay });
    const newerWaits = await pollUntil(async () => (await waiting()) === 1, 10_000);
    const racerOlder = c("log_maintenance", { task_id: raceTask, completed_on: olderDay });
    const bothWait = await pollUntil(async () => (await waiting()) === 2, 10_000);
    release();
    await holding;
    await holder.close();
    const [newerDone, olderDone] = await Promise.all([racerNewer, racerOlder]);
    const [after] = (await sql`SELECT last_completed::text AS last FROM plugin_home_maintenance.maintenance_tasks WHERE id = ${raceTask}`) as { last: string }[];
    if (!(newerWaits && bothWait && newerDone.status === 200 && olderDone.status === 200 && after.last === newerDay)) raceLost.push(`round ${round}: ${newerWaits}/${bothWait} ${newerDone.status}/${olderDone.status} kept ${after.last}, newer ${newerDay}`);
  }
  assert(raceLost.length === 0, `two logs at once, both waiting on a held row and released together, ten rounds: the task keeps the newer day every time (${raceLost.join("; ") || "every round"})`);
}

// ── plugins/household-knowledge ──────────────────────────────────────────────

console.log("\n[household-knowledge] its items and vendors");
{
  const P = "household-knowledge";
  const c = (key: string, input: Body, opts?: { as?: string; door?: "rest" | "mcp" }) => call(P, key, input, opts);
  const names = (r: Called, field = "items") => ((r.body[field] ?? []) as { name: string }[]).map((t) => t.name).join();
  const scopes = scopesOf(P);
  assert(JSON.stringify(scopes) === JSON.stringify({ add_household_item: "write", search_household_items: "read", get_item_details: "read", add_vendor: "write", list_vendors: "read" }),
    `its five operations' scopes: the three reads read, the two adds write (${JSON.stringify(scopes)})`);
  const hints = await hintsOf(P);
  assert(Object.keys(hints).length === 5 && Object.entries(hints).every(([k, h]) => h === (scopes[k] === "read" ? READ_HINT : ADDS_HINT)), `its hints, all five (${JSON.stringify(hints).slice(0, 200)})`);

  const paint = await c("add_household_item", { name: "Living Room Paint", category: "paint", location: "Living Room", details: { brand: "Sherwin Williams", color: "Sea Salt", code: "SW 6204" }, notes: "two gallons, March" });
  const { id: _pid, created_at: _pc, updated_at: paintUpdated, ...paintRest } = paint.body.item ?? {};
  assert(canon(paintRest) === canon({ name: "Living Room Paint", category: "paint", location: "Living Room", details: { brand: "Sherwin Williams", color: "Sea Salt", code: "SW 6204" }, notes: "two gallons, March" }) && ISO.test(String(paintUpdated)),
    `…every field of the item as it was given, updated_at ISO (${JSON.stringify(paint.body.item).slice(0, 240)})`);
  assert(paint.status === 200 && UUID.test(paint.body.item?.id) && paint.body.item?.details?.brand === "Sherwin Williams" && ISO.test(String(paint.body.item?.created_at)) && !("user_id" in paint.body.item),
    `add_household_item stores the row, details an object as given, created_at ISO, no user_id (${JSON.stringify(paint.body).slice(0, 200)})`);
  const dishwasher = await c("add_household_item", { name: "Dishwasher", category: "appliance", location: "Kitchen" }, { door: "mcp" });
  assert(dishwasher.status === 200 && JSON.stringify(dishwasher.body.item?.details) === "{}", "…over MCP too, details {} unless given");
  const tap = await c("add_household_item", { name: 'Kitchen (main) 12" tap', category: "plumbing", location: "Kitchen" });
  assert(tap.status === 200, "an item named with a parenthesis and a quote is stored");
  const surrogate = await c("add_household_item", { name: "x", details: { s: "a\ud800b" } });
  assert(surrogate.status === 400, `details holding a lone surrogate: 400, not the database's 500 (${surrogate.status})`);
  const deep: string[] = [];
  for (const details of [{ "a\u0000": 1 }, { l: ["\u0000"] }, { o: { s: "\ud800" } }, { o: { "k\ud800": 1 } }]) {
    const r = await c("add_household_item", { name: "x", details });
    if (r.status !== 400) deep.push(`${JSON.stringify(details)}: ${r.status}`);
  }
  assert(deep.length === 0, `…as is a NUL or a lone surrogate in a key, in a list, or nested (${deep.join("; ") || "all four"})`);

  const asString = await c("add_household_item", { name: "x", details: '{"brand":"Bosch"}' });
  const bigDetails = await c("add_household_item", { name: "x", details: { blob: "y".repeat(10_001) } });
  const nulDetails = await c("add_household_item", { name: "x", details: { model: "A\u0000B" } });
  assert(asString.status === 400 && bigDetails.status === 400 && nulDetails.status === 400,
    `details as a JSON string (the old tool's form), past 10,000 characters, or holding a NUL: 400, before the database (${asString.status}, ${bigDetails.status}, ${nulDetails.status})`);

  const search = async (input: Body) => names(await c("search_household_items", input));
  assert((await search({ query: "paint" })) === "Living Room Paint" && (await search({ query: "SEA SALT" })) === "Living Room Paint" && (await search({ query: "march" })) === "Living Room Paint",
    "search_household_items by name, by a value in the details in any case, and by the notes");
  assert((await search({ location: "_" })) === "", "…a location filter matches an _ as itself");
  assert((await search({ category: "appl", location: "kitch" })) === "Dishwasher" && (await search({ location: "kitchen" })) === 'Kitchen (main) 12" tap,Dishwasher',
    "…by category and location, partial and any case, newest first");
  assert((await search({ query: "Kitchen (main" })) === 'Kitchen (main) 12" tap' && (await search({ query: '12" tap' })) === 'Kitchen (main) 12" tap' && (await search({ query: "Sea, Salt" })) === "",
    "…an unclosed parenthesis or a quote is plain text, and a comma no longer splits the query (the old server's PostgREST syntax)");
  assert((await search({})) === 'Kitchen (main) 12" tap,Dishwasher,Living Room Paint' && (await search({ limit: 1 })) === 'Kitchen (main) 12" tap' && (await search({ query: "nothing-of-the-kind" })) === "",
    "…no filter lists every item newest first, the limit applies, and no match is an empty list");
  assert((await c("search_household_items", { limit: 1 })).body.truncated === true && (await c("search_household_items", {})).body.truncated === false, "…truncated says when more matched than the limit");
  assert((await search({ query: "living" })) === "Living Room Paint" && (await search({ query: "appliance" })) === "Dishwasher" && (await search({ query: "kitchen" })).includes("Dishwasher"),
    "…a query reads the location and the category too (the dishwasher's kitchen is in its location alone)");
  assert((await search({ query: "brand" })) === "Living Room Paint" && (await search({ query: "march\u00a0paint" })) === "Living Room Paint", "…the details' keys are searched as well as their values, and a no-break space splits words");
  const allItems = await c("search_household_items", {});
  assert((await c("search_household_items", { limit: (allItems.body.items as unknown[]).length })).body.truncated === false, "…search_household_items: exactly limit matches is not truncated");
  assert((await search({ query: "salt living" })) === "Living Room Paint" && (await search({ query: "williams march" })) === "Living Room Paint" && (await search({ query: "paint kitchen" })) === "",
    "…a query's words each matched apart, across the name, the details and the notes, all of them needed");

  const details = await c("get_item_details", { item_id: paint.body.item?.id });
  assert(details.status === 200 && JSON.stringify(details.body.item) === JSON.stringify(paint.body.item), "get_item_details answers the item as it was added");
  const noItem = await c("get_item_details", { item_id: NO_ROW });
  const badId = await c("get_item_details", { item_id: "paint" });
  assert(noItem.status === 404 && noItem.body.code === "NO_SUCH_ITEM" && /search_household_items/.test(String(noItem.body.message)) && badId.status === 400
         && noItem.viaMcp.result?.isError === true && JSON.stringify(noItem.viaMcp).includes("NO_SUCH_ITEM"),
    `…an id that names no item: 404 NO_SUCH_ITEM saying where the ids are; one that is no uuid: 400 (${noItem.status}, ${badId.status})`);

  const plumber = await c("add_vendor", { name: "Ann the Plumber", service_type: "plumber", phone: "555-0100", email: "ann@example.com", website: "https://ann.example.com", rating: 5, last_used: "2026-09-01" });
  const { id: _vid, created_at: plumberCreated, ...plumberRest } = plumber.body.vendor ?? {};
  assert(JSON.stringify(plumberRest) === JSON.stringify({ name: "Ann the Plumber", service_type: "plumber", phone: "555-0100", email: "ann@example.com", website: "https://ann.example.com", notes: null, rating: 5, last_used: "2026-09-01" }) && ISO.test(String(plumberCreated)),
    `…every field of the vendor as it was given, created_at ISO (${JSON.stringify(plumber.body.vendor).slice(0, 240)})`);
  assert(plumber.status === 200 && UUID.test(plumber.body.vendor?.id) && plumber.body.vendor?.rating === 5 && plumber.body.vendor?.last_used === "2026-09-01" && plumber.body.vendor?.email === "ann@example.com",
    `add_vendor stores the row, the rating a number and the day bare (${JSON.stringify(plumber.body).slice(0, 200)})`);
  const sparks = await c("add_vendor", { name: "Bright Sparks", service_type: "Electrician", notes: "did the kitchen lights" }, { door: "mcp" });
  assert(sparks.status === 200 && sparks.body.vendor?.rating === null, "…over MCP too, the optional fields null");
  const vendors = async (input: Body) => names(await c("list_vendors", input), "vendors");
  assert((await vendors({})) === "Ann the Plumber,Bright Sparks" && (await vendors({ service_type: "plumb" })) === "Ann the Plumber" && (await vendors({ service_type: "ELECTRIC" })) === "Bright Sparks"
         && (await vendors({ query: "kitchen" })) === "Bright Sparks" && (await vendors({ limit: 1 })) === "Ann the Plumber",
    "list_vendors: by name, by service type partial and any case, by the notes, and the limit");
  assert((await vendors({ query: "555" })) === "Ann the Plumber" && (await vendors({ query: "lights sparks" })) === "Bright Sparks" && (await vendors({ query: "ann@example" })) === "Ann the Plumber"
         && (await c("list_vendors", { limit: 1 })).body.truncated === true,
    "…a query's words each matched apart, the phone and the email among the fields, and truncated when more matched");
  assert((await vendors({ query: "ann" })) === "Ann the Plumber" && (await vendors({ query: "electrician" })) === "Bright Sparks" && (await vendors({ query: "ann sparks" })) === ""
         && (await vendors({ query: "ann.example.com" })) === "Ann the Plumber" && (await vendors({ query: "plumber\u00a0ann" })) === "Ann the Plumber"
         && (await vendors({ service_type: "_" })) === "",
    "…a query reads the name, the service type and the website, every word needed, a no-break space splitting words; service_type matches an _ as itself");
  assert((await c("list_vendors", { limit: 2 })).body.truncated === false, "…list_vendors: exactly limit matches is not truncated");
  await c("add_vendor", { name: "Aaron's Roofing", service_type: "roofer" });
  assert((await vendors({})) === "Aaron's Roofing,Ann the Plumber,Bright Sparks", "…listed by name, whatever order they were added in");
  const nextDay = await c("add_vendor", { name: "Tomorrow's Tiling", last_used: await dayFromToday(1) });
  assert(nextDay.status === 200, `a last_used of UTC's tomorrow, a far-east user's today, is accepted (${nextDay.status})`);
  const lateUse = await c("add_vendor", { name: "x", last_used: await dayFromToday(30) });
  assert(lateUse.status === 422 && lateUse.body.code === "FUTURE_DATE", `a last_used more than a day past today in UTC: 422 FUTURE_DATE, since no operation changes a vendor (${JSON.stringify(lateUse.body).slice(0, 120)})`);
  const badEmail = await c("add_vendor", { name: "x", email: "sparks@example" });
  assert(badEmail.status === 400 && /keep anything else in notes/.test(JSON.stringify(badEmail.body)), `…an email not in its form says where else it can go (${JSON.stringify(badEmail.body).slice(0, 160)})`);

  const missed = await outOfBounds(c, [
    ["an email that is no address", "add_vendor", { name: "x", email: "ann at example" }], ["a website that is ftp", "add_vendor", { name: "x", website: "ftp://x.example.com" }],
    ["a rating of 6", "add_vendor", { name: "x", rating: 6 }], ["a rating of 0", "add_vendor", { name: "x", rating: 0 }],
    ["a last_used in the year 0000", "add_vendor", { name: "x", last_used: "0000-01-01" }], ["an empty name", "add_household_item", { name: "" }],
    ["a NUL in the name", "add_household_item", { name: "x\u0000" }], ["a limit of 201", "search_household_items", { limit: 201 }],
    ["an empty query", "list_vendors", { query: "" }], ["a blank name", "add_household_item", { name: "   " }],
    ["a name of 201 characters", "add_vendor", { name: "x".repeat(201) }], ["a rating of 4.5", "add_vendor", { name: "x", rating: 4.5 }],
    ["a limit of 501", "list_vendors", { limit: 501 }],
  ]);
  assert(missed.length === 0, `each input out of its bounds is refused at 400, before the database (not: ${missed.join("; ") || "none"})`);
  const strays = await one<{ n: number }>(sql`SELECT (SELECT count(*) FROM plugin_household_knowledge.household_items WHERE name = 'x') + (SELECT count(*) FROM plugin_household_knowledge.household_vendors WHERE name = 'x') AS n`);
  assert(Number(strays.n) === 0, "none of them stored a row");
  const misses = await tableMisses([
    ["INSERT INTO plugin_household_knowledge.household_items (name, details) VALUES ('t', '[]')", /details_check/],
    ["INSERT INTO plugin_household_knowledge.household_items (name) VALUES ('')", /name_check/],
    ["INSERT INTO plugin_household_knowledge.household_vendors (name, rating) VALUES ('t', 6)", /rating_check/],
    ["INSERT INTO plugin_household_knowledge.household_vendors (name) VALUES ('')", /name_check/],
  ]);
  assert(misses.length === 0, `…and the tables hold the rules themselves, each by name (${misses.join("; ") || "all four"})`);
  const escapedText = await c("add_household_item", { name: "Escape note", details: { note: "the text \\u0000 as typed" } });
  assert(escapedText.status === 200, `details holding the six characters backslash-u0000 as text are no NUL: stored (${escapedText.status})`);
  await c("add_household_item", { name: "Kitchen window", details: { size: '24" x 36"', path: "C:\\Users\\me" } });
  assert((await search({ query: '24" x' })) === "Kitchen window" && (await search({ query: "C:\\Users" })) === "Kitchen window",
    "the details are searched as their values read, a quote and a backslash as themselves, not as the JSON escapes them");
  assert((await search({ query: "{" })) === "" && (await search({ query: '":"' })) === "", "…and the JSON's own syntax, a brace or a quoted colon, matches nothing");
  await c("add_household_item", { name: "Boiler", details: { warranty: { until: "2030-06", parts: ["pump"] } } });
  assert((await search({ query: "2030-06" })) === "Boiler" && (await search({ query: "pump" })) === "Boiler" && (await search({ query: "until" })) === "Boiler",
    "…a value or a key nested in an object or a list is searched too");
  const tenK = await c("add_household_item", { name: "Ten thousand", details: { b: "y".repeat(10_000 - 8) } });
  assert(tenK.status === 200, `details of exactly 10,000 characters as JSON are stored (${tenK.status})`);
  await c("add_household_item", { name: "Paint 50% off" });
  assert((await search({ query: "50%" })) === "Paint 50% off" && (await search({ query: "_" })) === "" && (await search({ category: "_" })) === "", "a %, or an _ in a query or a category, matches itself, not any text");
}

// ── plugins/meal-planning ────────────────────────────────────────────────────

console.log("\n[meal-planning] its recipes, the week's meals and the shopping list");
{
  const P = "meal-planning";
  const c = (key: string, input: Body, opts?: { as?: string; door?: "rest" | "mcp" }) => call(P, key, input, opts);
  const names = (r: Called, field = "recipes") => ((r.body[field] ?? []) as { name: string }[]).map((t) => t.name).join();
  const CHANGES_HINT = JSON.stringify({ destructiveHint: true, openWorldHint: false });
  const scopes = scopesOf(P);
  assert(JSON.stringify(scopes) === JSON.stringify({ add_recipe: "write", search_recipes: "read", update_recipe: "write", create_meal_plan: "write", get_meal_plan: "read", generate_shopping_list: "write", get_shopping_list: "read", mark_item_purchased: "write" }),
    `its eight operations' scopes: the three reads read, the five writes write (${JSON.stringify(scopes)})`);
  const hints = await hintsOf(P);
  const wantHint = (k: string) => (scopes[k] === "read" ? READ_HINT : ["update_recipe", "create_meal_plan", "generate_shopping_list"].includes(k) ? CHANGES_HINT : ADDS_HINT);
  assert(Object.keys(hints).length === 8 && Object.entries(hints).every(([k, h]) => h === wantHint(k)), `its hints, all eight: a change that overwrites is destructive, an add is not, a read is read-only (${JSON.stringify(hints).slice(0, 240)})`);

  // Recipes: their quantities as written, for the shopping list to sum.
  const pasta = await c("add_recipe", { name: "Pasta al limone", cuisine: "Italian", prep_time_minutes: 10, cook_time_minutes: 20, servings: 4,
    ingredients: [{ name: "spaghetti", quantity: "400", unit: "g" }, { name: "olive oil", quantity: "2", unit: "tbsp" }, { name: "salt", quantity: "1" }],
    instructions: ["boil", "toss"], tags: ["Quick", "vegetarian", " quick "], rating: 5, notes: "a lemon a person" });
  const { id: pastaId, created_at: _pc, updated_at: pastaUpdated, ...pastaRest } = pasta.body.recipe ?? {};
  assert(pasta.status === 200 && UUID.test(pastaId) && ISO.test(String(pastaUpdated)) && canon(pastaRest) === canon({ name: "Pasta al limone", cuisine: "Italian", prep_time_minutes: 10, cook_time_minutes: 20, servings: 4,
    ingredients: [{ name: "spaghetti", quantity: "400", unit: "g" }, { name: "olive oil", quantity: "2", unit: "tbsp" }, { name: "salt", quantity: "1" }], instructions: ["boil", "toss"], tags: ["quick", "vegetarian"], rating: 5, notes: "a lemon a person" }),
    `add_recipe stores every field as given, the tags lower-case and each once (${String(JSON.stringify(pasta.body)).slice(0, 240)})`);
  const salad = await c("add_recipe", { name: "Green salad", cuisine: "French", ingredients: [{ name: "lettuce", quantity: "1", unit: "head" }, { name: "Olive Oil", quantity: "1", unit: "TBSP" }, { name: "stock", quantity: "1/2", unit: "cup" }], instructions: [] }, { door: "mcp" });
  const soup = await c("add_recipe", { name: "Stock soup", ingredients: [{ name: "stock", quantity: "1 1/2", unit: "cup" }, { name: "salt", quantity: "a pinch" }], instructions: ["simmer"] });
  const toast = await c("add_recipe", { name: "Toast", ingredients: [{ name: "bread", quantity: "2", unit: "slices" }], instructions: ["toast"] });
  assert([salad, soup, toast].every((r) => r.status === 200 && UUID.test(r.body.recipe?.id)) && JSON.stringify(toast.body.recipe?.tags) === "[]" && JSON.stringify(salad.body.recipe?.instructions) === "[]",
    "…over MCP too; tags left out and no instructions are empty lists");
  const ids = { pasta: String(pastaId), salad: String(salad.body.recipe?.id), soup: String(soup.body.recipe?.id), toast: String(toast.body.recipe?.id) };

  const search = async (input: Body) => names(await c("search_recipes", input));
  assert((await search({})) === "Toast,Stock soup,Green salad,Pasta al limone" && (await search({ query: "limone PASTA" })) === "Pasta al limone" && (await search({ query: "spaghetti" })) === "Pasta al limone"
         && (await search({ query: "vegetarian" })) === "Pasta al limone" && (await search({ query: "lemon\u00a0person" })) === "Pasta al limone",
    "search_recipes: every recipe newest first; a query's words matched apart across the name, the ingredients, the tags and the notes, a no-break space splitting them");
  assert((await search({ cuisine: "ITAL" })) === "Pasta al limone" && (await search({ tag: "QUICK" })) === "Pasta al limone" && (await search({ tag: "qui" })) === ""
         && (await search({ ingredient: "OIL" })) === "Green salad,Pasta al limone" && (await search({ ingredient: "lettuce" })) === "Green salad" && (await search({ ingredient: "olive oil, extra virgin" })) === "",
    "…by part of the cuisine, by a whole tag, and by part of an ingredient's name, each in any case (the old server's ingredient search took the exact name)");
  assert((await search({ query: "spaghetti lettuce" })) === "" && (await search({ query: "olive lettuce" })) === "Green salad" && (await search({ query: "french" })) === "Green salad"
         && (await search({ cuisine: "%" })) === "" && (await search({ query: "_" })) === "" && (await search({ ingredient: "_" })) === "",
    "…every word of a query needed, the cuisine among the fields; a % or an _ matches itself in a query, a cuisine and an ingredient");
  const ordered = await c("add_recipe", { name: "Tag order", ingredients: [], instructions: [], tags: ["vegetarian", "Quick"] });
  assert(JSON.stringify(ordered.body.recipe?.tags) === '["vegetarian","quick"]', `…tags kept in the order given (${JSON.stringify(ordered.body.recipe?.tags)})`);
  const firstPage = await c("search_recipes", { limit: 1 });
  assert((firstPage.body.recipes as unknown[]).length === 1 && firstPage.body.truncated === true && (await c("search_recipes", { limit: 5 })).body.truncated === false, "…limit applies, truncated when more matched and not when exactly limit did");

  const updated = await c("update_recipe", { recipe_id: ids.pasta, tags: ["Weeknight"], rating: 4, cuisine: null, notes: "less lemon" });
  assert(updated.status === 200 && JSON.stringify(updated.body.recipe?.tags) === '["weeknight"]' && updated.body.recipe?.rating === 4 && updated.body.recipe?.cuisine === null && updated.body.recipe?.notes === "less lemon"
         && updated.body.recipe?.name === "Pasta al limone" && updated.body.recipe?.servings === 4 && String(updated.body.recipe?.updated_at) > String(pastaUpdated),
    `update_recipe changes the fields given, clears one given null, leaves the rest, and moves updated_at (${JSON.stringify(updated.body.recipe).slice(0, 200)})`);
  const everything = await c("update_recipe", { recipe_id: ids.toast, name: "Buttered toast", cuisine: "British", prep_time_minutes: 2, cook_time_minutes: 3, servings: 1,
    ingredients: [{ name: "bread", quantity: "2", unit: "slice" }, { name: "butter", quantity: "1", unit: "tbsp" }], instructions: ["toast", "butter"], tags: ["breakfast"], rating: 3, notes: "salted butter" });
  const t = everything.body.recipe ?? {};
  assert(canon({ name: t.name, cuisine: t.cuisine, prep: t.prep_time_minutes, cook: t.cook_time_minutes, servings: t.servings, ingredients: t.ingredients, instructions: t.instructions, tags: t.tags, rating: t.rating, notes: t.notes })
         === canon({ name: "Buttered toast", cuisine: "British", prep: 2, cook: 3, servings: 1, ingredients: [{ name: "bread", quantity: "2", unit: "slice" }, { name: "butter", quantity: "1", unit: "tbsp" }], instructions: ["toast", "butter"], tags: ["breakfast"], rating: 3, notes: "salted butter" }),
    `…every field given is changed (${JSON.stringify(t).slice(0, 200)})`);
  const nameOnly = await c("update_recipe", { recipe_id: ids.toast, name: "Toast" });
  assert(nameOnly.body.recipe?.notes === "salted butter" && JSON.stringify(nameOnly.body.recipe?.instructions) === '["toast","butter"]' && nameOnly.body.recipe?.servings === 1 && nameOnly.body.recipe?.prep_time_minutes === 2,
    "…and a change of the name alone leaves every other field as it was");
  const nothing = await c("update_recipe", { recipe_id: ids.pasta });
  const noRecipe = await c("update_recipe", { recipe_id: NO_ROW, name: "x" });
  const noRecipeMcp = await c("update_recipe", { recipe_id: NO_ROW, name: "x" }, { door: "mcp" });
  assert(nothing.status === 422 && nothing.body.code === "NOTHING_TO_CHANGE" && noRecipe.status === 404 && noRecipe.body.code === "NO_SUCH_RECIPE" && /search_recipes/.test(String(noRecipe.body.message))
         && noRecipeMcp.viaMcp.result?.isError === true && JSON.stringify(noRecipeMcp.viaMcp).includes("NO_SUCH_RECIPE"),
    `…no field to change: 422 NOTHING_TO_CHANGE; a recipe that is not there: 404 NO_SUCH_RECIPE over both doors, saying where the ids are (${nothing.status}, ${noRecipe.status})`);

  // The week of Monday 2026-09-21.
  const WEEK = "2026-09-21";
  const plan = await c("create_meal_plan", { week_start: WEEK, meals: [
    { day_of_week: "friday", meal_type: "breakfast", recipe_id: ids.toast },
    { day_of_week: "monday", meal_type: "dinner", recipe_id: ids.pasta, servings: 4 },
    { day_of_week: "tuesday", meal_type: "dinner", recipe_id: ids.salad, notes: "light" },
    { day_of_week: "tuesday", meal_type: "lunch", custom_meal: "leftovers" },
  ] });
  const planned = (plan.body.meals ?? []) as { day_of_week: string; meal_type: string; on_date: string; recipe: { name: string } | null; custom_meal: string | null }[];
  assert(plan.status === 200 && planned.map((m) => `${m.day_of_week}/${m.meal_type}@${m.on_date}`).join() === "monday/dinner@2026-09-21,tuesday/lunch@2026-09-22,tuesday/dinner@2026-09-22,friday/breakfast@2026-09-25",
    `create_meal_plan answers the meals by day and then by meal, each with the date it falls on (${planned.map((m) => `${m.day_of_week}/${m.meal_type}@${m.on_date}`).join()})`);
  const tuesdayDinner = (plan.body.meals as { day_of_week: string; meal_type: string; notes: string | null; servings: number | null; recipe: { cuisine: string | null } | null }[]).find((m) => m.day_of_week === "tuesday" && m.meal_type === "dinner");
  assert(tuesdayDinner?.notes === "light" && tuesdayDinner?.recipe?.cuisine === "French" && (plan.body.meals as { servings: number | null }[])[0].servings === 4, `…each meal's notes and servings, and its recipe's cuisine (${JSON.stringify(tuesdayDinner).slice(0, 160)})`);
  assert(canon((plan.body.meals as { recipe: unknown }[])[0].recipe) === canon({ id: ids.pasta, name: "Pasta al limone", cuisine: null, prep_time_minutes: 10, cook_time_minutes: 20, servings: 4 }) && planned[1].recipe === null && planned[1].custom_meal === "leftovers",
    "…each with its recipe's name, cuisine, times and servings, or null for a custom meal");
  const week = await c("get_meal_plan", { week_start: WEEK });
  assert(week.status === 200 && JSON.stringify(week.body.meals) === JSON.stringify(plan.body.meals), "get_meal_plan answers the same meals in the same order (the old server sorted days and meals alphabetically: friday before monday)");
  // A slot sent again is replaced, not doubled; two meals for one slot are both kept; slots not sent stay.
  const again = await c("create_meal_plan", { week_start: WEEK, meals: [{ day_of_week: "monday", meal_type: "dinner", recipe_id: ids.salad }, { day_of_week: "monday", meal_type: "dinner", custom_meal: "garlic bread" }] });
  const weekAgain = ((await c("get_meal_plan", { week_start: WEEK })).body.meals ?? []) as { day_of_week: string; meal_type: string; recipe: { name: string } | null; custom_meal: string | null }[];
  assert(again.status === 200 && weekAgain.map((m) => `${m.day_of_week}/${m.meal_type}:${m.recipe?.name ?? m.custom_meal}`).join() === "monday/dinner:Green salad,monday/dinner:garlic bread,tuesday/lunch:leftovers,tuesday/dinner:Green salad,friday/breakfast:Toast",
    `…a slot planned again holds the meals sent for it, both kept in the order sent, and the slots not sent are left (${weekAgain.map((m) => `${m.day_of_week}/${m.meal_type}:${m.recipe?.name ?? m.custom_meal}`).join()})`);
  const replacedMeals = (again.body.replaced ?? []) as { day_of_week: string; meal_type: string; recipe: { name: string } | null }[];
  assert(replacedMeals.map((m) => `${m.day_of_week}/${m.meal_type}:${m.recipe?.name}`).join() === "monday/dinner:Pasta al limone" && JSON.stringify(plan.body.replaced) === "[]",
    `…and the answer's replaced lists what the slot held before, so "add a salad to Monday" sent alone says the pasta went (${JSON.stringify(replacedMeals).slice(0, 160)})`);
  const missing = await c("create_meal_plan", { week_start: WEEK, meals: [{ day_of_week: "monday", meal_type: "dinner", recipe_id: ids.pasta }, { day_of_week: "monday", meal_type: "dinner", recipe_id: NO_ROW }] });
  const weekAfterMissing = ((await c("get_meal_plan", { week_start: WEEK })).body.meals ?? []) as unknown[];
  assert(missing.status === 404 && missing.body.code === "NO_SUCH_RECIPE" && JSON.stringify(missing.body.recipe_ids) === JSON.stringify([NO_ROW]) && weekAfterMissing.length === 5,
    `…a recipe that is not there beside one that is: 404 NO_SUCH_RECIPE naming the missing one alone, and the plan as it was (${JSON.stringify(missing.body).slice(0, 160)})`);
  // A week is named by its Monday: a plan under any other day would hold the same dates under a second name.
  const notMonday: string[] = [];
  for (const [key, input] of [["create_meal_plan", { week_start: "2026-09-23", meals: [{ day_of_week: "monday", meal_type: "lunch", custom_meal: "picnic" }] }], ["get_meal_plan", { week_start: "2026-09-20" }],
                              ["generate_shopping_list", { week_start: "2026-09-22" }], ["get_shopping_list", { week_start: "2026-09-27" }]] as const) {
    const r = await c(key, input as Body);
    if (r.status !== 400) notMonday.push(`${key}: ${r.status}`);
  }
  assert(notMonday.length === 0, `…a week_start that is not a Monday is refused at 400 by every operation that takes one (${notMonday.join("; ") || "all four"})`);
  assert(JSON.stringify((await c("get_meal_plan", { week_start: "2020-01-06" })).body.meals) === "[]" && (await c("get_meal_plan", { week_start: "9999-12-20" })).status === 200,
    "an unplanned week is no meals; the last week ending in the year 9999 is a week");

  // The shopping list, from the week of Monday 2026-10-05: pasta twice, the salad, the soup, and a custom meal.
  const LIST_WEEK = "2026-10-05";
  await c("create_meal_plan", { week_start: LIST_WEEK, meals: [
    { day_of_week: "monday", meal_type: "dinner", recipe_id: ids.pasta }, { day_of_week: "tuesday", meal_type: "dinner", recipe_id: ids.salad },
    { day_of_week: "wednesday", meal_type: "dinner", recipe_id: ids.pasta }, { day_of_week: "thursday", meal_type: "dinner", recipe_id: ids.soup },
    { day_of_week: "thursday", meal_type: "lunch", custom_meal: "out" },
  ] });
  assert(((await c("get_meal_plan", { week_start: WEEK })).body.meals as unknown[]).length === 5, "…planning another week leaves this week's slots as they were");
  await c("create_meal_plan", { week_start: WEEK, meals: [{ day_of_week: "tuesday", meal_type: "dinner", recipe_id: ids.salad, notes: "light" }] });
  const tuesday = ((await c("get_meal_plan", { week_start: WEEK })).body.meals as { day_of_week: string; meal_type: string }[]).filter((m) => m.day_of_week === "tuesday").map((m) => m.meal_type).join();
  assert(tuesday === "lunch,dinner", `…and replacing one meal of a day leaves the day's other meals (${tuesday})`);
  const made = await c("generate_shopping_list", { week_start: LIST_WEEK });
  const items = (made.body.shopping_list?.items ?? []) as { id: string; name: string; quantity: string | null; unit: string | null; purchased: boolean; recipe_ids: string[] }[];
  assert(made.status === 200 && UUID.test(made.body.shopping_list?.id) && items.map((i) => `${i.name}:${i.quantity}${i.unit ? ` ${i.unit}` : ""}`).join() === "spaghetti:800 g,olive oil:5 tbsp,salt:2 + a pinch,lettuce:1 head,stock:2 cup",
    `generate_shopping_list: each ingredient once by name and unit in any case, in the order the week first names it; numbers summed (a recipe twice counts twice, 1/2 and 1 1/2 make 2), words after the sum (${items.map((i) => `${i.name}:${i.quantity} ${i.unit ?? ""}`).join()})`);
  assert(JSON.stringify(items.find((i) => i.name === "olive oil")?.recipe_ids) === JSON.stringify([ids.pasta, ids.salad]) && items.every((i) => i.purchased === false && UUID.test(i.id)),
    "…each item naming the recipes it is for, none purchased");
  const oil = items.find((i) => i.name === "olive oil")!;
  const lettuce = items.find((i) => i.name === "lettuce")!;
  const marked = await c("mark_item_purchased", { item_id: oil.id });
  await c("mark_item_purchased", { item_id: lettuce.id });
  assert(marked.status === 200 && marked.body.item?.purchased === true && marked.body.item?.id === oil.id, `mark_item_purchased marks it bought (${JSON.stringify(marked.body).slice(0, 120)})`);
  assert(made.body.shopping_list?.stale === false, "…a list just made is not stale");
  const listed = await c("get_shopping_list", { week_start: LIST_WEEK });
  assert(ISO.test(String(listed.body.shopping_list?.updated_at)) && String(listed.body.shopping_list?.updated_at) > String(made.body.shopping_list?.updated_at), "…a mark moves the list's updated_at on");
  assert(listed.status === 200 && ((listed.body.shopping_list?.items ?? []) as { name: string; purchased: boolean }[]).find((i) => i.name === "olive oil")?.purchased === true && listed.body.shopping_list?.id === made.body.shopping_list?.id,
    "get_shopping_list answers the week's list as it now is, the mark kept");
  // The plan changed: Wednesday's pasta gone. The list says it is stale; made again, it follows the plan, and lettuce
  // (the same quantity) and olive oil (5 tbsp bought, now 3: less than was bought) stay bought.
  await c("create_meal_plan", { week_start: LIST_WEEK, meals: [{ day_of_week: "wednesday", meal_type: "dinner", custom_meal: "takeaway" }] });
  const staleNow = async (week = LIST_WEEK) => (await c("get_shopping_list", { week_start: week })).body.shopping_list?.stale;
  assert((await staleNow()) === true, "…once the plan changes, the list made before it says it is stale");
  const remade = await c("generate_shopping_list", { week_start: LIST_WEEK }, { door: "mcp" });
  const remadeItems = (remade.body.shopping_list?.items ?? []) as { id: string; name: string; quantity: string | null; purchased: boolean }[];
  const was = (its: typeof remadeItems, name: string) => its.find((i) => i.name === name);
  assert(remade.body.shopping_list?.id === made.body.shopping_list?.id && remade.body.shopping_list?.stale === false && was(remadeItems, "spaghetti")?.quantity === "400" && was(remadeItems, "spaghetti")?.purchased === false
         && was(remadeItems, "olive oil")?.quantity === "3" && was(remadeItems, "olive oil")?.purchased === true && was(remadeItems, "lettuce")?.purchased === true,
    `…made again, the same list follows the plan; a mark stays on an item whose quantity is the same or smaller (the old server's regeneration wiped every mark) (${remadeItems.map((i) => `${i.name}:${i.quantity}:${i.purchased}`).join()})`);
  assert(String(remade.body.shopping_list?.updated_at) > String(listed.body.shopping_list?.updated_at) && String(remade.body.shopping_list?.created_at) === String(made.body.shopping_list?.created_at),
    "…making it again moves updated_at on and keeps created_at");
  // Stale is whether a list made now would say otherwise: a recipe's notes and rating, the same meal planned again in
  // its slot, and a custom meal change nothing it says.
  await c("update_recipe", { recipe_id: ids.salad, notes: "with croutons", rating: 4 });
  await c("create_meal_plan", { week_start: LIST_WEEK, meals: [{ day_of_week: "tuesday", meal_type: "dinner", recipe_id: ids.salad }, { day_of_week: "friday", meal_type: "lunch", custom_meal: "picnic" }] });
  assert((await staleNow()) === false, "…a planned recipe's notes and rating, the same meal planned again in its slot, and a custom meal leave the list current");
  // A planned recipe's ingredients changed: stale, and a mark after it leaves it stale (pass 1's stale was by the list's
  // updated_at, which a mark moves on).
  await c("update_recipe", { recipe_id: ids.soup, ingredients: [{ name: "stock", quantity: "2", unit: "cup" }, { name: "salt", quantity: "a pinch" }] });
  await c("mark_item_purchased", { item_id: String(was(remadeItems, "spaghetti")?.id) });
  assert((await staleNow()) === true, "…a planned recipe's ingredients changed make it stale, and a mark after it leaves it stale");
  // Wednesday's pasta back: spaghetti, 400 g bought, is now 800 g, and to buy again.
  await c("create_meal_plan", { week_start: LIST_WEEK, meals: [{ day_of_week: "wednesday", meal_type: "dinner", recipe_id: ids.pasta }] });
  const grownItems = ((await c("generate_shopping_list", { week_start: LIST_WEEK })).body.shopping_list?.items ?? []) as typeof remadeItems;
  assert(was(grownItems, "spaghetti")?.quantity === "800" && was(grownItems, "spaghetti")?.purchased === false && was(grownItems, "lettuce")?.purchased === true && was(grownItems, "stock")?.quantity === "2 1/2",
    `…a quantity that grew is to buy again (${grownItems.map((i) => `${i.name}:${i.quantity}:${i.purchased}`).join()})`);
  // An item first named in capitals ("Olive Oil", the salad's) keeps its mark when the list is made again unchanged.
  const CAPS_WEEK = "2026-10-12";
  await c("create_meal_plan", { week_start: CAPS_WEEK, meals: [{ day_of_week: "monday", meal_type: "dinner", recipe_id: ids.salad }] });
  const capsList = await c("generate_shopping_list", { week_start: CAPS_WEEK });
  const capsOil = ((capsList.body.shopping_list?.items ?? []) as { id: string; name: string }[]).find((i) => i.name === "Olive Oil");
  await c("mark_item_purchased", { item_id: String(capsOil?.id) });
  const capsAgain = ((await c("generate_shopping_list", { week_start: CAPS_WEEK })).body.shopping_list?.items ?? []) as { name: string; purchased: boolean }[];
  assert(capsOil !== undefined && capsAgain.find((i) => i.name === "Olive Oil")?.purchased === true, `…an item first named in capitals keeps its mark (${JSON.stringify(capsAgain).slice(0, 160)})`);
  // A name JavaScript and Postgres lower-case apart ("ΑΣ" is "ας" to one, "ασ" to the other) keeps its mark too: the
  // keys are made in one place.
  const greek = await c("add_recipe", { name: "Greek plate", ingredients: [{ name: "\u0391\u03a3", quantity: "1" }], instructions: [] });
  const GREEK_WEEK = "2026-10-19";
  await c("create_meal_plan", { week_start: GREEK_WEEK, meals: [{ day_of_week: "monday", meal_type: "dinner", recipe_id: String(greek.body.recipe?.id) }] });
  const greekItem = (((await c("generate_shopping_list", { week_start: GREEK_WEEK })).body.shopping_list?.items ?? []) as { id: string }[])[0];
  await c("mark_item_purchased", { item_id: String(greekItem?.id) });
  const greekAgain = (((await c("generate_shopping_list", { week_start: GREEK_WEEK })).body.shopping_list?.items ?? []) as { purchased: boolean }[])[0];
  assert(greekAgain?.purchased === true, `…and so does a name whose lower case JavaScript and Postgres disagree on (${JSON.stringify(greekAgain)})`);
  const unmarked = await c("mark_item_purchased", { item_id: String(was(grownItems, "lettuce")?.id), purchased: false });
  assert(unmarked.body.item?.purchased === false, "…and purchased false takes the mark off");

  // A mark and a list made again at once, forced to race: a lock held on the item stops the mark at it, and the list
  // made again then waits too. Pass 1's mark took the item before the list, and the list's maker the list before the
  // items: released, the two deadlocked (a 500), or the new items took the mark's item away. The mark now takes the
  // list first, so the maker waits for it, and keeps the mark.
  const RACE_WEEK = "2026-10-26";
  await c("create_meal_plan", { week_start: RACE_WEEK, meals: [{ day_of_week: "monday", meal_type: "dinner", recipe_id: ids.toast }] });
  const bread = (((await c("generate_shopping_list", { week_start: RACE_WEEK })).body.shopping_list?.items ?? []) as { id: string }[])[0];
  const waiting = async () => Number(((await sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'ob1_plugins_meal_planning' AND wait_event_type = 'Lock'`) as { n: number }[])[0].n);
  const holdWhile = async (lock: string, id: string, race: () => Promise<boolean>) => {
    const holder = new SQL({ url: URL_, max: 1 });
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const isHeld = new Promise<void>((r) => (held = r));
    const holding = holder.begin(async (tx) => {
      await tx.unsafe(lock, [id]);
      held();
      await released;
    });
    await isHeld;
    try {
      return await race();
    } finally {
      release();
      await holding;
      await holder.close();
    }
  };
  let marking!: Promise<Called>, making!: Promise<Called>;
  const bothWait = await holdWhile("SELECT 1 FROM plugin_meal_planning.shopping_list_items WHERE id = $1 FOR UPDATE", bread.id, async () => {
    marking = c("mark_item_purchased", { item_id: bread.id });
    const markWaits = await pollUntil(async () => (await waiting()) === 1, 10_000);
    making = c("generate_shopping_list", { week_start: RACE_WEEK });
    return markWaits && (await pollUntil(async () => (await waiting()) === 2, 10_000));
  });
  const [markDone, makeDone] = await Promise.all([marking, making]);
  const raced = (((await c("get_shopping_list", { week_start: RACE_WEEK })).body.shopping_list?.items ?? []) as { purchased: boolean }[])[0];
  assert(bothWait && markDone.status === 200 && makeDone.status === 200 && raced?.purchased === true,
    `a mark and a list made again at once, both waiting on a held item and released together: both succeed and the new list keeps the mark (${bothWait}, ${markDone.status} ${String(markDone.body.code ?? "")}, ${makeDone.status} ${String(makeDone.body.code ?? "")}, ${JSON.stringify(raced)})`);
  // A plan committing while a list is made, forced: a lock held on the salad's row stops a plan of it at its
  // foreign-key check, its meal already stamped, and the list is made meanwhile without the salad. Pass 1's stale
  // compared stamps, the meal's older than the list's, and read current; it now compares what the list says.
  let planning!: Promise<Called>;
  let meanwhile!: Called;
  const planWaits = await holdWhile("SELECT 1 FROM plugin_meal_planning.recipes WHERE id = $1 FOR UPDATE", ids.salad, async () => {
    planning = c("create_meal_plan", { week_start: RACE_WEEK, meals: [{ day_of_week: "tuesday", meal_type: "dinner", recipe_id: ids.salad }] });
    const waits = await pollUntil(async () => (await waiting()) === 1, 10_000);
    meanwhile = await c("generate_shopping_list", { week_start: RACE_WEEK });
    return waits;
  });
  const planDone = await planning;
  const meanwhileNames = ((meanwhile.body.shopping_list?.items ?? []) as { name: string }[]).map((i) => i.name).join();
  const lateStale = await staleNow(RACE_WEEK);
  assert(planWaits && meanwhile.status === 200 && !meanwhileNames.includes("lettuce") && planDone.status === 200 && lateStale === true,
    `…and a plan that commits after a list made while it was open leaves that list stale (${planWaits}, ${meanwhile.status} ${meanwhileNames}, ${planDone.status}, stale ${lateStale})`);
  const noList = await c("get_shopping_list", { week_start: "2020-01-06" });
  const noItem = await c("mark_item_purchased", { item_id: NO_ROW });
  const emptyList = await c("generate_shopping_list", { week_start: "2020-01-13" });
  assert(noList.status === 404 && noList.body.code === "NO_SUCH_LIST" && /generate_shopping_list/.test(String(noList.body.message)) && noItem.status === 404 && noItem.body.code === "NO_SUCH_ITEM"
         && emptyList.status === 200 && JSON.stringify(emptyList.body.shopping_list?.items) === "[]",
    `a week with no list: 404 NO_SUCH_LIST saying how to make one; an item that is not there: 404 NO_SUCH_ITEM; a week with no planned recipe makes an empty list (${noList.status}, ${noItem.status}, ${emptyList.status})`);

  // The list's arithmetic, on its own: what agents write in quantity and unit.
  const list = (meals: { recipe_id: string; ingredients: { name: string; quantity?: string | null; unit?: string | null }[] }[]) => shoppingItems(meals).map((i) => `${i.name}:${i.quantity ?? ""}${i.unit ? ` ${i.unit}` : ""}`).join(" | ");
  const r1 = "11111111-1111-4111-8111-111111111111", r2 = "22222222-2222-4222-8222-222222222222";
  assert(list([{ recipe_id: r1, ingredients: [{ name: "milk", quantity: "\u00bd", unit: "cup" }, { name: "beef", quantity: "1 lb" }, { name: "flour", quantity: "2-3", unit: "cups" }, { name: "cream", quantity: "1/3", unit: "cup" }] },
               { recipe_id: r2, ingredients: [{ name: "Milk", quantity: ".5", unit: "Cups" }, { name: "beef", quantity: "2", unit: "lbs" }, { name: "flour", quantity: "2-3", unit: "cup" }, { name: "cream", quantity: "1/3", unit: "cup" }, { name: "beef", quantity: "1\u00bd", unit: "pounds" }] }])
         === "milk:1 cup | beef:4 1/2 lb | flour:2-3 \u00d72 cup | cream:2/3 cup",
    `shoppingItems: a half as ½ or .5 summed, "1 lb" with its unit in the quantity, "lbs" and "pounds" one unit, a third shown as a fraction, and words kept with how many times they came (${list([{ recipe_id: r1, ingredients: [{ name: "milk", quantity: "\u00bd", unit: "cup" }] }])})`);
  assert(list([{ recipe_id: r1, ingredients: [{ name: "salt", quantity: "a pinch" }, { name: "salt", quantity: "1" }, { name: "pepper" }] }]) === "salt:1 + a pinch | pepper:"
         && shoppingItems([{ recipe_id: r1, ingredients: [{ name: "pepper" }] }])[0].quantity === null,
    "…a number and a word together, the number first; an ingredient with no quantity listed with none (null, not empty text)");
  assert(list([{ recipe_id: r1, ingredients: [{ name: "oil", quantity: "2", unit: "tbsp" }, { name: "oil", quantity: "1", unit: "cup" }, { name: "x", quantity: "0.5" }, { name: "x", quantity: "1.5" },
                                              { name: "y", quantity: "0.1" }, { name: "y", quantity: "0.2" }, { name: "z", quantity: "1/0" }] }])
         === "oil:2 tbsp | oil:1 cup | x:2 | y:0.3 | z:1/0",
    "…two units of one ingredient listed apart; 0.5 and 1.5 make 2; 0.1 and 0.2 make 0.3, not its float; a division by zero is a word, not Infinity");
  assert(list([{ recipe_id: r1, ingredients: [{ name: "eggs", quantity: "2 large" }, { name: "eggs", quantity: "3" }, { name: "oil", quantity: "1", unit: "T" }, { name: "oil", quantity: "1", unit: "t" },
                                              { name: "milk", quantity: "1", unit: "c" }, { name: "milk", quantity: "1", unit: "cup" }, { name: "thyme", quantity: "1", unit: "Sprig" }, { name: "thyme", quantity: "2", unit: "sprig" }] }])
         === "eggs:3 + 2 large | oil:1 tbsp | oil:1 tsp | milk:2 cup | thyme:3 Sprig",
    "…a word after a number that is no unit stays part of the quantity; T and t are a tablespoon and a teaspoon, apart; c is a cup; an unknown unit merges in any case");
  const pinch = { recipe_id: r1, ingredients: [{ name: "salt", quantity: "a pinch" }, { name: "Oil", quantity: "1" }] }, taste = { recipe_id: r2, ingredients: [{ name: "oil", quantity: "2" }, { name: "salt", quantity: "to taste" }] };
  assert(list([pinch, taste]) === "salt:a pinch + to taste | Oil:3" && list([taste, pinch]) === "oil:3 | salt:a pinch + to taste",
    "…the words in one order whatever the meals' order, so a mark made at them holds when two meals swap");
  assert(listSource(shoppingItems([pinch, taste])) === listSource(shoppingItems([taste, pinch])) && listSource(shoppingItems([pinch, taste])) !== listSource(shoppingItems([pinch, pinch])),
    "listSource: two lists saying the same with their items in another order and case are one source; another quantity is another");
  assert(list([{ recipe_id: r1, ingredients: [{ name: "a", quantity: "0.004", unit: "kg" }, { name: "b", quantity: "9".repeat(50) }, { name: "c", quantity: "1 \u00bd cup" }, { name: "d", quantity: "\u2159" }, { name: "d", quantity: "\u2159" },
                                              { name: "e", quantity: "2", unit: "Tbs" }, { name: "e", quantity: "1", unit: "tbsp" }, { name: "f", quantity: "1/16" }, { name: "g", quantity: "1/6" }] }])
         === `a:0.004 kg | b:${"9".repeat(50)} | c:1 1/2 cup | d:1/3 | e:3 tbsp | f:0.063 | g:1/6`,
    "…a sum below a hundredth in two figures, not 0; a number past a billion kept as written, not 1e+50; \"1 \u00bd cup\" read; \u2159 a sixth; Tbs a tablespoon; 1/16 as 0.063, a sixth as 1/6");
  const marks: [string | null, string | null, boolean][] = [["800", "800", true], ["800", "400", true], ["400", "800", false], ["1 1/2", "1/2", true], ["a pinch", "a pinch", true], ["2 + a pinch", "1 + a pinch", false], [null, null, true], [null, "1", false]];
  const markMisses = marks.filter(([a, b, want]) => keepsMark(a, b) !== want).map(([a, b, want]) => `${a} → ${b}: ${!want}`);
  assert(markMisses.length === 0, `keepsMark: a mark holds at the same quantity or a smaller number, and goes from more, or a changed quantity not a number (${markMisses.join("; ") || "all eight"})`);

  const missed = await outOfBounds(c, [
    ["a name of 201 characters", "add_recipe", { name: "x".repeat(201), ingredients: [], instructions: [] }], ["no ingredients list", "add_recipe", { name: "x", instructions: [] }],
    ["servings of 0", "add_recipe", { name: "x", ingredients: [], instructions: [], servings: 0 }], ["a prep time of -1", "add_recipe", { name: "x", ingredients: [], instructions: [], prep_time_minutes: -1 }],
    ["a rating of 6", "add_recipe", { name: "x", ingredients: [], instructions: [], rating: 6 }], ["31 tags", "add_recipe", { name: "x", ingredients: [], instructions: [], tags: Array.from({ length: 31 }, (_, i) => `t${i}`) }],
    ["an ingredient with no name", "add_recipe", { name: "x", ingredients: [{ name: "", quantity: "1" }], instructions: [] }], ["a NUL in the name", "add_recipe", { name: "x\u0000", ingredients: [], instructions: [] }],
    ["a day not lower-case", "create_meal_plan", { week_start: WEEK, meals: [{ day_of_week: "Monday", meal_type: "dinner", custom_meal: "x" }] }],
    ["a meal type of brunch", "create_meal_plan", { week_start: WEEK, meals: [{ day_of_week: "monday", meal_type: "brunch", custom_meal: "x" }] }],
    ["a meal with neither recipe nor custom meal", "create_meal_plan", { week_start: WEEK, meals: [{ day_of_week: "monday", meal_type: "dinner" }] }],
    ["no meals", "create_meal_plan", { week_start: WEEK, meals: [] }], ["a recipe id that is no uuid", "create_meal_plan", { week_start: WEEK, meals: [{ day_of_week: "monday", meal_type: "dinner", recipe_id: "pasta" }] }],
    ["a week in the year 0000", "get_meal_plan", { week_start: "0000-01-03" }], ["a week ending in the year 10000", "get_meal_plan", { week_start: "9999-12-27" }], ["a limit of 0", "search_recipes", { limit: 0 }], ["an empty query", "search_recipes", { query: "" }],
    ["an item id that is no uuid", "mark_item_purchased", { item_id: "oil" }], ["servings of 1001", "add_recipe", { name: "x", ingredients: [], instructions: [], servings: 1001 }],
    ["a cook time of 10081", "add_recipe", { name: "x", ingredients: [], instructions: [], cook_time_minutes: 10081 }], ["a rating of 0", "add_recipe", { name: "x", ingredients: [], instructions: [], rating: 0 }],
    ["an empty quantity", "add_recipe", { name: "x", ingredients: [{ name: "salt", quantity: "" }], instructions: [] }], ["101 steps", "add_recipe", { name: "x", ingredients: [], instructions: Array.from({ length: 101 }, () => "stir") }],
    ["a recipe id that is no uuid", "update_recipe", { recipe_id: "pasta", name: "x" }],
  ]);
  assert(missed.length === 0, `each input out of its bounds is refused at 400, before the database (not: ${missed.join("; ") || "none"})`);
  const strays = await one<{ n: number }>(sql`SELECT (SELECT count(*) FROM plugin_meal_planning.recipes WHERE name = 'x') + (SELECT count(*) FROM plugin_meal_planning.meal_plans WHERE custom_meal = 'x') AS n`);
  assert(Number(strays.n) === 0, "none of them stored a row");
  const misses = await tableMisses([
    [`INSERT INTO plugin_meal_planning.meal_plans (week_start, day_of_week, meal_type) VALUES ('${WEEK}', 'monday', 'dinner')`, /meal_plans_recipe_or_custom/],
    [`INSERT INTO plugin_meal_planning.meal_plans (week_start, day_of_week, meal_type, custom_meal) VALUES ('${WEEK}', 'Monday', 'dinner', 'x')`, /day_of_week_check/],
    [`INSERT INTO plugin_meal_planning.meal_plans (week_start, day_of_week, meal_type, custom_meal) VALUES ('${WEEK}', 'monday', 'brunch', 'x')`, /meal_type_check/],
    [`INSERT INTO plugin_meal_planning.meal_plans (week_start, day_of_week, meal_type, recipe_id) VALUES ('${WEEK}', 'monday', 'dinner', '00000000-0000-4000-8000-00000000dead')`, /foreign key/],
    ["INSERT INTO plugin_meal_planning.recipes (name, ingredients) VALUES ('t', '{}')", /recipes_ingredients_shape/],
    [`INSERT INTO plugin_meal_planning.recipes (name, ingredients) VALUES ('t', '[{"name": "beef", "quantity": 2}]')`, /recipes_ingredients_shape/],
    [`INSERT INTO plugin_meal_planning.recipes (name, ingredients) VALUES ('t', '[{"quantity": "2"}]')`, /recipes_ingredients_shape/],
    [`INSERT INTO plugin_meal_planning.recipes (name, instructions) VALUES ('t', '[1]')`, /recipes_instructions_shape/],
    ["INSERT INTO plugin_meal_planning.recipes (name) VALUES ('')", /name_check/],
    ["INSERT INTO plugin_meal_planning.recipes (name, servings) VALUES ('t', 0)", /servings_check/],
    [`INSERT INTO plugin_meal_planning.shopping_list_items (list_id, name, position) VALUES ('00000000-0000-4000-8000-00000000dead', 'x', 0)`, /foreign key/],
    ["INSERT INTO plugin_meal_planning.recipes (name, rating) VALUES ('t', 6)", /rating_check/],
    [`INSERT INTO plugin_meal_planning.shopping_lists (week_start) VALUES ('${LIST_WEEK}')`, /shopping_lists_week_start_key/],
    ["INSERT INTO plugin_meal_planning.meal_plans (week_start, day_of_week, meal_type, custom_meal) VALUES ('2026-09-23', 'monday', 'dinner', 'x')", /meal_plans_week_monday/],
    ["INSERT INTO plugin_meal_planning.shopping_lists (week_start) VALUES ('2026-09-23')", /shopping_lists_week_monday/],
  ]);
  assert(misses.length === 0, `…and the tables hold the rules themselves, each by name (${misses.join("; ") || "all fifteen"})`);
}

// ── The drift guard: every ported plugin's tool is driven, and nothing else ──

console.log("\n[every tool each ported plugin registers is driven here]");
{
  const writer = (await toolsFor(KEYS.writer)).map((t) => t.name);
  for (const name of PORTED) {
    const prefix = `${name.replaceAll("-", "_")}_`;
    const listed = writer.filter((t) => t.startsWith(prefix)).sort();
    const called = [...(driven.get(name) ?? [])].sort();
    assert(listed.length > 0 && listed.join() === called.join(), `${name}: tools/list under the write key is exactly the ${called.length} tool(s) driven above (${listed.join(", ")})`);
  }
  assert([...driven.keys()].every((p) => (PORTED as readonly string[]).includes(p)), "and nothing else was driven");
}

mcpServer.stop(true);
apiServer.stop(true);
await sql.close();
report();
