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
import { createAssert, dropSchema } from "../db/test-support.ts";
import { hashKey } from "./auth.ts";
import { EMBEDDING_DIM, EMBEDDING_MODEL, pluginIdents } from "../db/config.mjs";
import { PLUGINS as REGISTRY } from "../plugins/registry.ts";
import { mcpUnderTest, servedByMcpServer } from "./test-support.ts";

const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  console.error("DATABASE_URL is not set. Try: ../db/with-postgres.sh bun test-plugin-ports.ts");
  process.exit(2);
}
process.env.OB1_EMBEDDING_DIM = String(EMBEDDING_DIM);
process.env.OB1_EMBEDDING_MODEL = EMBEDDING_MODEL;

/** The ported plugins, as each PR of SMD-2311 adds one: its section below drives it. */
const PORTED = ["family-calendar", "home-maintenance", "household-knowledge"] as const;
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
  assert(((capped.body.activities ?? []) as unknown[]).length === 2, "…limit applies");
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
  const wider = await c("get_upcoming_dates", { days_ahead: 90 });
  const widerDates = (wider.body.dates ?? []) as { title: string; family_member: unknown }[];
  assert(widerDates.map((d) => d.title).join() === "Today's deadline,Ada's birthday,Insurance renewal" && widerDates[2]?.family_member === null, `…a wider window takes in the renewal, a family-wide date's member null (${widerDates.map((d) => d.title).join()})`);
  const defaulted = await c("get_upcoming_dates", {});
  assert(((defaulted.body.dates ?? []) as unknown[]).length === 2, "…thirty days unless given");
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
  assert(zeroDates.filter((d) => d.days_until === 0).map((d) => d.title).join() === "Anniversary today,Today's deadline" && zeroDates.every((d) => d.days_until === 0 ? d.next_date === today : d.remind)
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
  assert(((await c("list_maintenance_tasks", { limit: 2 })).body.tasks as unknown[]).length === 2, "…limit applies");

  const upcoming = await c("get_upcoming_maintenance", { days_ahead: 30 });
  const up = (upcoming.body.tasks ?? []) as { name: string; days_until: number }[];
  assert(upcoming.status === 200 && upcoming.body.today === utcToday && up.map((t) => `${t.name}@${t.days_until}`).join() === "Smoke alarm test@-5,Softener salt@20,HVAC filter replacement@20,Water filter@30",
    `get_upcoming_maintenance: the overdue one first at a negative days_until, then those due in the window by date and priority; not the roof years out or the undated gutter (${up.map((t) => `${t.name}@${t.days_until}`).join()})`);
  assert(names(await c("get_upcoming_maintenance", { days_ahead: 0 })) === "Smoke alarm test", "…days_ahead 0: the overdue alone");
  assert(names(await c("get_upcoming_maintenance", {})) === names(upcoming), "…thirty days unless given");
  assert(names(await c("get_upcoming_maintenance", { days_ahead: 29 })) === "Smoke alarm test,Softener salt,HVAC filter replacement", "…the thirtieth day's task out of a 29-day window");

  // Logging: a recurring task moves on from the day logged, an older log leaves it where it is, a one-time task is done.
  const ten = await dayFromToday(-10);
  const logged = await c("log_maintenance", { task_id: ids.hvac, completed_on: ten, performed_by: "self", cost: 45.5, notes: "changed the filter", next_action: "check the coil" });
  assert(logged.status === 200 && UUID.test(logged.body.log?.id) && logged.body.log?.cost === 45.5 && logged.body.log?.completed_on === ten && JSON.stringify(logged.body.log?.task) === JSON.stringify({ id: ids.hvac, name: "HVAC filter replacement", category: "hvac" }),
    `log_maintenance stores the log, its cost a number, its task folded in (${JSON.stringify(logged.body.log).slice(0, 200)})`);
  assert(logged.body.task?.last_completed === ten && logged.body.task?.next_due === (await dayFromToday(80)) && logged.body.task?.days_until === 80,
    `…and answers the task moved on: last_completed the day logged, next_due ninety days after it (${JSON.stringify(logged.body.task).slice(0, 160)})`);
  const older = await c("log_maintenance", { task_id: ids.hvac, completed_on: await dayFromToday(-100), performed_by: "self" }, { door: "mcp" });
  assert(older.status === 200 && older.body.task?.last_completed === ten && older.body.task?.next_due === (await dayFromToday(80)),
    `…a log of older work is kept, and the task is not moved back (the old trigger moved it to the older day) (${JSON.stringify(older.body.task).slice(0, 160)})`);
  const once = await c("log_maintenance", { task_id: ids.gutter, completed_on: await dayFromToday(-4), performed_by: "Ann the Plumber" });
  assert(once.status === 200 && once.body.task?.done === true && once.body.task?.next_due === null && once.body.task?.last_completed === (await dayFromToday(-4)), "…a one-time task logged is done, with no due date");
  const today = await c("log_maintenance", { task_id: ids.filter });
  assert(today.status === 200 && today.body.log?.completed_on === utcToday && today.body.task?.next_due === (await dayFromToday(30)), "…completed_on is today in UTC unless given");
  assert(!names(await c("list_maintenance_tasks", {})).includes("Gutter cleaning") && names(await c("list_maintenance_tasks", { include_done: true })).endsWith("Gutter cleaning")
         && !names(await c("get_upcoming_maintenance", { days_ahead: 366 })).includes("Gutter cleaning"),
    "…and a done task is listed only with include_done, last, and is never upcoming");
  const orphan = await c("log_maintenance", { task_id: NO_ROW });
  const orphanMcp = await c("log_maintenance", { task_id: NO_ROW }, { door: "mcp" });
  assert(orphan.status === 404 && orphan.body.code === "NO_SUCH_TASK" && /list_maintenance_tasks/.test(String(orphan.body.message)) && orphanMcp.viaMcp.result?.isError === true && JSON.stringify(orphanMcp.viaMcp).includes("NO_SUCH_TASK"),
    `a log for no task: 404 NO_SUCH_TASK over both doors, saying where the ids are (${JSON.stringify(orphan.body).slice(0, 160)})`);

  const history = await c("search_maintenance_history", {});
  const logs = (history.body.logs ?? []) as { task: { name: string }; completed_on: string }[];
  assert(history.status === 200 && logs.map((l) => l.task.name).join() === "Water filter,Gutter cleaning,HVAC filter replacement,HVAC filter replacement" && logs[2].completed_on === ten,
    `search_maintenance_history: every log, latest first, each with its task (${logs.map((l) => `${l.task.name}@${l.completed_on}`).join()})`);
  const histNames = async (input: Body) => (((await c("search_maintenance_history", input)).body.logs ?? []) as { task: { name: string } }[]).map((l) => l.task.name).join();
  assert((await histNames({ task_id: ids.hvac })) === "HVAC filter replacement,HVAC filter replacement" && (await histNames({ task_name: "hvac" })) === "HVAC filter replacement,HVAC filter replacement"
         && (await histNames({ category: "EXTER" })) === "Gutter cleaning" && (await histNames({ task_name: "zzz" })) === "",
    "…by task, by name, by category in any case, and a name no task has is an empty list");
  assert((await histNames({ date_from: await dayFromToday(-7) })) === "Water filter,Gutter cleaning" && (await histNames({ date_to: ten })) === "HVAC filter replacement,HVAC filter replacement"
         && (await histNames({ date_from: ten, date_to: ten })) === "HVAC filter replacement" && (await histNames({ limit: 1 })) === "Water filter",
    "…from a day, to a day (both edge days in), and the limit");
  const unknownTask = await c("search_maintenance_history", { task_id: NO_ROW });
  const backwards = await c("search_maintenance_history", { date_from: ten, date_to: await dayFromToday(-20) });
  assert(unknownTask.status === 404 && unknownTask.body.code === "NO_SUCH_TASK" && backwards.status === 422 && backwards.body.code === "BAD_DATES",
    `…a task id that names no task: 404 NO_SUCH_TASK, not an empty history; a date_to before date_from: 422 BAD_DATES (${unknownTask.status}, ${backwards.status})`);

  const missed = await outOfBounds(c, [
    ["a frequency of 0 days", "add_maintenance_task", { name: "x", frequency_days: 0 }], ["a frequency of 3651 days", "add_maintenance_task", { name: "x", frequency_days: 3651 }],
    ["a priority of critical", "add_maintenance_task", { name: "x", priority: "critical" }], ["an empty name", "add_maintenance_task", { name: " " }],
    ["a NUL in the name", "add_maintenance_task", { name: "x\u0000" }], ["a due date in the year 0000", "add_maintenance_task", { name: "x", next_due: "0000-01-01" }],
    ["a cost below 0", "log_maintenance", { task_id: ids.hvac, cost: -1 }], ["a task id that is no uuid", "log_maintenance", { task_id: "hvac" }],
    ["days_ahead of 367", "get_upcoming_maintenance", { days_ahead: 367 }], ["a limit of 0", "search_maintenance_history", { limit: 0 }],
    ["a limit of 501", "list_maintenance_tasks", { limit: 501 }],
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
  assert(paint.status === 200 && UUID.test(paint.body.item?.id) && paint.body.item?.details?.brand === "Sherwin Williams" && ISO.test(String(paint.body.item?.created_at)) && !("user_id" in paint.body.item),
    `add_household_item stores the row, details an object as given, created_at ISO, no user_id (${JSON.stringify(paint.body).slice(0, 200)})`);
  const dishwasher = await c("add_household_item", { name: "Dishwasher", category: "appliance", location: "Kitchen" }, { door: "mcp" });
  assert(dishwasher.status === 200 && JSON.stringify(dishwasher.body.item?.details) === "{}", "…over MCP too, details {} unless given");
  const tap = await c("add_household_item", { name: 'Kitchen (main) 12" tap', category: "plumbing", location: "Kitchen" });
  assert(tap.status === 200, "an item named with a parenthesis and a quote is stored");
  const asString = await c("add_household_item", { name: "x", details: '{"brand":"Bosch"}' });
  const bigDetails = await c("add_household_item", { name: "x", details: { blob: "y".repeat(10_001) } });
  const nulDetails = await c("add_household_item", { name: "x", details: { model: "A\u0000B" } });
  assert(asString.status === 400 && bigDetails.status === 400 && nulDetails.status === 400,
    `details as a JSON string (the old tool's form), past 10,000 characters, or holding a NUL: 400, before the database (${asString.status}, ${bigDetails.status}, ${nulDetails.status})`);

  const search = async (input: Body) => names(await c("search_household_items", input));
  assert((await search({ query: "paint" })) === "Living Room Paint" && (await search({ query: "SEA SALT" })) === "Living Room Paint" && (await search({ query: "march" })) === "Living Room Paint",
    "search_household_items by name, by a value in the details in any case, and by the notes");
  assert((await search({ category: "appl", location: "kitch" })) === "Dishwasher" && (await search({ location: "kitchen" })) === 'Kitchen (main) 12" tap,Dishwasher',
    "…by category and location, partial and any case, newest first");
  assert((await search({ query: "Kitchen (main" })) === 'Kitchen (main) 12" tap' && (await search({ query: '12" tap' })) === 'Kitchen (main) 12" tap' && (await search({ query: "Sea, Salt" })) === "",
    "…an unclosed parenthesis or a quote is plain text, and a comma no longer splits the query (the old server's PostgREST syntax)");
  assert((await search({})) === 'Kitchen (main) 12" tap,Dishwasher,Living Room Paint' && (await search({ limit: 1 })) === 'Kitchen (main) 12" tap' && (await search({ query: "nothing-of-the-kind" })) === "",
    "…no filter lists every item newest first, the limit applies, and no match is an empty list");

  const details = await c("get_item_details", { item_id: paint.body.item?.id });
  assert(details.status === 200 && JSON.stringify(details.body.item) === JSON.stringify(paint.body.item), "get_item_details answers the item as it was added");
  const noItem = await c("get_item_details", { item_id: NO_ROW });
  const badId = await c("get_item_details", { item_id: "paint" });
  assert(noItem.status === 404 && noItem.body.code === "NO_SUCH_ITEM" && /search_household_items/.test(String(noItem.body.message)) && badId.status === 400,
    `…an id that names no item: 404 NO_SUCH_ITEM saying where the ids are; one that is no uuid: 400 (${noItem.status}, ${badId.status})`);

  const plumber = await c("add_vendor", { name: "Ann the Plumber", service_type: "plumber", phone: "555-0100", email: "ann@example.com", website: "https://ann.example.com", rating: 5, last_used: "2026-09-01" });
  assert(plumber.status === 200 && UUID.test(plumber.body.vendor?.id) && plumber.body.vendor?.rating === 5 && plumber.body.vendor?.last_used === "2026-09-01" && plumber.body.vendor?.email === "ann@example.com",
    `add_vendor stores the row, the rating a number and the day bare (${JSON.stringify(plumber.body).slice(0, 200)})`);
  const sparks = await c("add_vendor", { name: "Bright Sparks", service_type: "Electrician", notes: "did the kitchen lights" }, { door: "mcp" });
  assert(sparks.status === 200 && sparks.body.vendor?.rating === null, "…over MCP too, the optional fields null");
  const vendors = async (input: Body) => names(await c("list_vendors", input), "vendors");
  assert((await vendors({})) === "Ann the Plumber,Bright Sparks" && (await vendors({ service_type: "plumb" })) === "Ann the Plumber" && (await vendors({ service_type: "ELECTRIC" })) === "Bright Sparks"
         && (await vendors({ query: "kitchen" })) === "Bright Sparks" && (await vendors({ limit: 1 })) === "Ann the Plumber",
    "list_vendors: by name, by service type partial and any case, by the notes, and the limit");

  const missed = await outOfBounds(c, [
    ["an email that is no address", "add_vendor", { name: "x", email: "ann at example" }], ["a website that is ftp", "add_vendor", { name: "x", website: "ftp://x.example.com" }],
    ["a rating of 6", "add_vendor", { name: "x", rating: 6 }], ["a rating of 0", "add_vendor", { name: "x", rating: 0 }],
    ["a last_used in the year 0000", "add_vendor", { name: "x", last_used: "0000-01-01" }], ["an empty name", "add_household_item", { name: "" }],
    ["a NUL in the name", "add_household_item", { name: "x\u0000" }], ["a limit of 201", "search_household_items", { limit: 201 }],
    ["an empty query", "list_vendors", { query: "" }],
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
