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
const PORTED = ["family-calendar"] as const;
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
  const [{ today }] = (await sql`SELECT current_date::text AS today`) as { today: string }[];
  /** A date `days` from the database's today, YYYY-MM-DD. */
  const fromToday = async (days: number) => ((await sql`SELECT (${today}::date + ${days}::int)::text AS d`) as { d: string }[])[0].d;
  /** The same day and month as the date `days` from today, `yearsBack` years earlier. */
  const yearsBefore = async (days: number, yearsBack: number) => ((await sql`SELECT ((${today}::date + ${days}::int) - make_interval(years => ${yearsBack}::int))::date::text AS d`) as { d: string }[])[0].d;

  const ada = await c("add_family_member", { name: "  Ada ", relationship: "child", birth_date: "2018-03-01" });
  assert(ada.status === 200 && UUID.test(ada.body.member?.id) && ada.body.member?.name === "Ada" && ada.body.member?.relationship === "child" && ada.body.member?.birth_date === "2018-03-01" && !("user_id" in ada.body.member),
    `add_family_member stores the row and answers it: the name trimmed, the birth date bare, no user_id (${JSON.stringify(ada.body).slice(0, 160)})`);
  const adaId = String(ada.body.member?.id);
  const ben = await c("add_family_member", { name: "Ben" }, { door: "mcp" });
  assert(ben.status === 200 && UUID.test(ben.body.member?.id) && ben.body.member?.relationship === null && ben.body.member?.birth_date === null, `…over MCP too, the optional fields null (${JSON.stringify(ben.viaMcp).slice(0, 160)})`);
  const nul = await c("add_family_member", { name: "Cy\u0000" });
  const nulSearch = await c("search_activities", { query: "a\u0000b" });
  assert(nul.status === 400 && nulSearch.status === 400, `a NUL character, which Postgres will not store in text, is refused at 400 in a body and in a query, not the database's 500 (${nul.status}, ${nulSearch.status})`);
  const stored = await one<{ user_id: string | null }>(sql`SELECT user_id::text FROM plugin_family_calendar.family_members WHERE id = ${adaId}`);
  assert(stored.user_id === null, "the row's user_id is left null: kept, and ignored (decided 2026-11-02)");
  const badDay = await c("add_family_member", { name: "Cy", birth_date: "2018-02-30" });
  const yearZero = await c("add_family_member", { name: "Cy", birth_date: "0000-01-01" });
  assert(badDay.status === 400 && yearZero.status === 400, `a birth date that is no date, or in the year 0000 Postgres has not, is refused before the database (${badDay.status}, ${yearZero.status} ${JSON.stringify(yearZero.body).slice(0, 100)})`);

  // Six activities around the week of 2026-09-21 (Monday) to 2026-09-27: one weekly, four dated — across the week, ended
  // before it, running on since before it, ahead of it — and one weekly whose dates ended before the week.
  const swim = await c("add_activity", { family_member_id: adaId, title: "Swimming", activity_type: "sports", day_of_week: "monday", start_time: "16:00", end_time: "17:00" });
  const camp = await c("add_activity", { title: "Autumn camp", activity_type: "school", start_date: "2026-09-20", end_date: "2026-09-27", start_time: "09:00" });
  const ended = await c("add_activity", { title: "Spring term", activity_type: "school", start_date: "2026-09-01", end_date: "2026-09-10", start_time: "08:00" });
  const ongoing = await c("add_activity", { title: "Piano", activity_type: "music", start_date: "2026-09-15", start_time: "18:00" }, { door: "mcp" });
  const ahead = await c("add_activity", { title: "Ski trip", activity_type: "sports", start_date: "2026-09-28", start_time: "07:00" });
  const lapsed = await c("add_activity", { family_member_id: adaId, title: "Summer tennis", activity_type: "sports", day_of_week: "tuesday", start_date: "2026-06-01", end_date: "2026-08-31", start_time: "10:00" });
  // A weekly one with no start date, ended before every week read below: with Swimming, the two with none, newest first.
  const chess = await c("add_activity", { title: "Chess", activity_type: "games", day_of_week: "sunday", end_date: "2026-06-30" });
  const made = [swim, camp, ended, ongoing, ahead, lapsed, chess];
  assert(made.every((r) => r.status === 200 && UUID.test(r.body.activity?.id)), `add_activity ×7 (${made.map((r) => r.status === 200 ? "" : JSON.stringify(r.body)).join("").slice(0, 200)})`);
  assert(swim.body.activity?.family_member_id === adaId && swim.body.activity?.family_member?.name === "Ada" && swim.body.activity?.start_time === "16:00" && swim.body.activity?.day_of_week === "monday" && camp.body.activity?.family_member === null && camp.body.activity?.start_date === "2026-09-20",
    `…each answered with its member (or null for the whole family's), its times HH:MM and dates bare (${JSON.stringify(swim.body.activity).slice(0, 200)})`);

  const week = await c("get_week_schedule", { week_start: "2026-09-21" });
  assert(week.status === 200 && titles(week) === "Autumn camp,Piano,Swimming" && week.body.week_end === "2026-09-27",
    `get_week_schedule: the weekly activity and the two whose dates reach the week — not the one that ended before it, the one starting the day after (the old server's week ran eight days), or the weekly one whose dates ended (${week.status} ${titles(week)} to ${week.body.week_end})`);
  assert(((week.body.activities ?? []) as { title: string }[]).map((a) => a.title).join() === "Autumn camp,Swimming,Piano", `…ordered by start time (${((week.body.activities ?? []) as { title: string }[]).map((a) => a.title).join()})`);
  const swimRow = (week.body.activities ?? []).find((a: { title: string }) => a.title === "Swimming");
  assert(JSON.stringify(swimRow?.family_member) === JSON.stringify({ id: adaId, name: "Ada", relationship: "child" }) && (week.body.activities ?? []).find((a: { title: string }) => a.title === "Piano")?.family_member === null,
    `…each with its member, or null for the whole family's (${JSON.stringify(swimRow?.family_member)})`);
  const summer = await c("get_week_schedule", { week_start: "2026-07-06" });
  assert(titles(summer) === "Summer tennis,Swimming", `…the weekly one in a week its dates reach (${titles(summer)})`);
  const forAda = await c("get_week_schedule", { week_start: "2026-09-21", family_member_id: adaId });
  assert(forAda.status === 200 && titles(forAda) === "Swimming", `…filtered to one member (${titles(forAda)})`);

  const byQuery = await c("search_activities", { query: "CAMP" });
  assert(byQuery.status === 200 && titles(byQuery) === "Autumn camp", `search_activities by title, any case (${byQuery.status} ${titles(byQuery)})`);
  const byName = await c("search_activities", { query: "ada" });
  assert(titles(byName) === "Summer tennis,Swimming", `…by the member's name (${titles(byName)})`);
  const byType = await c("search_activities", { activity_type: "sports" });
  assert(titles(byType) === "Ski trip,Summer tennis,Swimming", `…by type (${titles(byType)})`);
  const both = await c("search_activities", { activity_type: "sports", family_member_id: adaId });
  assert(titles(both) === "Summer tennis,Swimming", `…the filters together (${titles(both)})`);
  const every = await c("search_activities", {});
  const order = ((every.body.activities ?? []) as { title: string }[]).map((a) => a.title);
  assert(every.status === 200 && order.join() === "Ski trip,Autumn camp,Piano,Spring term,Summer tennis,Chess,Swimming", `…none lists all seven, latest start date first, then the two with none, newest first (${order.join()})`);
  // A weekly activity is listed only where its day in the week is within its own dates: a Monday class starting on the
  // Wednesday of the week of 2026-09-21 first falls on the 28th, and a Monday club ending Sunday the 20th last fell on the 14th.
  const late = await c("add_activity", { title: "Late Monday class", activity_type: "music", day_of_week: "monday", start_date: "2026-09-23" });
  const club = await c("add_activity", { title: "Monday club", activity_type: "music", day_of_week: "monday", start_date: "2026-09-01", end_date: "2026-09-20" });
  assert(late.status === 200 && club.status === 200, "two more weekly activities");
  const weekAgain = await c("get_week_schedule", { week_start: "2026-09-21" });
  const fromTuesday = await c("get_week_schedule", { week_start: "2026-09-15" });
  const next = await c("get_week_schedule", { week_start: "2026-09-28" });
  const before = await c("get_week_schedule", { week_start: "2026-09-14" });
  assert(titles(weekAgain) === "Autumn camp,Piano,Swimming" && !titles(fromTuesday).includes("Monday club") && titles(next).includes("Late Monday class") && titles(before).includes("Monday club") && !titles(before).includes("Late Monday class"),
    `…a weekly one in a week its dates overlap but where its day falls outside them is left out, and listed in the week its day falls inside (${titles(weekAgain)} / ${titles(fromTuesday)} / ${titles(next)} / ${titles(before)})`);
  const capped = await c("search_activities", { limit: 2 });
  assert(((capped.body.activities ?? []) as unknown[]).length === 2, "…limit applies");
  await c("add_activity", { title: "Bake sale 50% off", start_date: "2026-10-01" });
  const percent = await c("search_activities", { query: "50%" });
  const underscore = await c("search_activities", { query: "_" });
  assert(titles(percent) === "Bake sale 50% off" && titles(underscore) === "", `…a % or an _ in the query matches itself, not any text (${titles(percent)} / ${titles(underscore)})`);

  const noMember = await c("add_activity", { title: "x", start_date: "2026-09-01", family_member_id: NO_ROW });
  const noMemberMcp = await c("add_activity", { title: "x", start_date: "2026-09-01", family_member_id: NO_ROW }, { door: "mcp" });
  assert(noMember.status === 404 && noMember.body.code === "NO_SUCH_MEMBER" && noMemberMcp.viaMcp.result?.isError === true && JSON.stringify(noMemberMcp.viaMcp).includes("NO_SUCH_MEMBER"), `a member that is not there: 404 NO_SUCH_MEMBER over both doors (${JSON.stringify(noMember.body)})`);
  const backwards = await c("add_activity", { title: "x", start_date: "2026-09-10", end_date: "2026-09-01" });
  assert(backwards.status === 422 && backwards.body.code === "BAD_DATES", `an end before the start: 422 BAD_DATES (${JSON.stringify(backwards.body)})`);
  const noWhen = await c("add_activity", { title: "x", activity_type: "sports" });
  assert(noWhen.status === 422 && noWhen.body.code === "NO_WHEN", `an activity with neither a day nor a start date, which no week would list: 422 NO_WHEN (${JSON.stringify(noWhen.body)})`);
  const zeroWeek = await c("get_week_schedule", { week_start: "0000-06-01" });
  assert(zeroWeek.status === 400, `a week in the year 0000: 400, not the database's 500 (${zeroWeek.status})`);
  const badDow = await c("add_activity", { title: "x", day_of_week: "Monday" });
  const badTime = await c("add_activity", { title: "x", start_time: "25:00" });
  assert(badDow.status === 400 && badTime.status === 400, `a day not lower-case, a time past 23:59: refused before the database (${badDow.status}, ${badTime.status})`);
  const strays = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM plugin_family_calendar.activities WHERE title = 'x'`);
  assert(strays.n === 0, "none of the refused ones stored a row");
  // The rule NO_WHEN answers is the table's too, so a row written around the operation (a copy from the old tables) is held to it.
  let tableSaid = "";
  try { await sql`INSERT INTO plugin_family_calendar.activities (title) VALUES ('no when')`; } catch (e) { tableSaid = (e as Error).message; }
  assert(/check constraint/.test(tableSaid), `…and the table refuses an activity with neither a day nor a start date itself (${tableSaid.slice(0, 100)})`);

  // Dates: a birthday whose stored year is long past (the old server never listed one), a deadline, one past, one beyond.
  const bdayOn = await fromToday(10);
  const bday = await c("add_important_date", { family_member_id: adaId, title: "Ada's birthday", date_value: await yearsBefore(10, 8), recurring_yearly: true });
  const renewal = await c("add_important_date", { title: "Insurance renewal", date_value: await fromToday(60), reminder_days_before: 14 }, { door: "mcp" });
  const past = await c("add_important_date", { title: "Old deadline", date_value: await fromToday(-3) });
  const todayOne = await c("add_important_date", { title: "Today's deadline", date_value: today, reminder_days_before: 0 });
  assert([bday, renewal, past, todayOne].every((r) => r.status === 200 && UUID.test(r.body.important_date?.id)), `add_important_date ×4 (${[bday, renewal, past, todayOne].map((r) => JSON.stringify(r.body)).join(" ").slice(0, 200)})`);
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
  const hints = Object.fromEntries((await toolsFor(KEYS.writer)).filter((t) => t.name.startsWith("family_calendar_")).map((t) => [t.name, t.annotations]));
  assert(JSON.stringify(hints.family_calendar_add_activity) === JSON.stringify({ destructiveHint: false, openWorldHint: false }) && JSON.stringify(hints.family_calendar_get_upcoming_dates) === JSON.stringify({ readOnlyHint: true, openWorldHint: false }),
    `its hints: an add destroys nothing, and every operation is closed-world (${JSON.stringify(hints).slice(0, 200)})`);

  // Dates added after the windows above were read: a yearly one whose anniversary is today, a 29 February, and two
  // dated thirty and thirty-one days on, either side of the default.
  await c("add_important_date", { title: "Anniversary today", date_value: await yearsBefore(0, 5), recurring_yearly: true });
  await c("add_important_date", { title: "Leap day", date_value: "2020-02-29", recurring_yearly: true });
  await c("add_important_date", { title: "Day thirty", date_value: await fromToday(30) });
  await c("add_important_date", { title: "Day thirty-one", date_value: await fromToday(31) });
  const zero = await c("get_upcoming_dates", { days_ahead: 0 });
  const zeroDates = (zero.body.dates ?? []) as { title: string; next_date: string; days_until: number }[];
  assert(zeroDates.map((d) => d.title).join() === "Anniversary today,Today's deadline" && zeroDates.every((d) => d.next_date === today && d.days_until === 0),
    `days_ahead 0: today alone, a yearly date whose anniversary is today among it (${zeroDates.map((d) => d.title).join()})`);
  const thirty = ((await c("get_upcoming_dates", {})).body.dates ?? []) as { title: string }[];
  assert(thirty.some((d) => d.title === "Day thirty") && !thirty.some((d) => d.title === "Day thirty-one"), `…unless given, thirty days: the thirtieth day in, the thirty-first out (${thirty.map((d) => d.title).join()})`);
  // 29 February's next anniversary, as the description says: that day in a leap year, the 28th in another. Reckoned
  // here from the database's today, and found in a year's window wherever today falls.
  const [ty, tm, td] = today.split("-").map(Number);
  const leapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const feb = (y: number) => `${y}-02-${leapYear(y) ? "29" : "28"}`;
  const expected = (tm < 2 || (tm === 2 && td <= (leapYear(ty) ? 29 : 28))) ? feb(ty) : feb(ty + 1);
  const year = ((await c("get_upcoming_dates", { days_ahead: 366 })).body.dates ?? []) as { title: string; next_date: string }[];
  const leap = year.find((d) => d.title === "Leap day");
  assert(leap?.next_date === expected, `a yearly 29 February comes round on ${expected} (${JSON.stringify(leap)})`);
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
