#!/usr/bin/env bun
/**
 * test-tools.ts — every tool of the one MCP server with a schema of its own
 * on the SQL shim — job-hunt, the last extension server — answers against a
 * real Postgres carrying its schema. (The ob-graph recipe was the eighth until
 * it retired with SMD-2920; family-calendar, home-maintenance,
 * household-knowledge, meal-planning and professional-crm were five more until
 * they became plugins with SMD-2311, which server-portable/test-plugin-ports.ts
 * drives now, and meal-planning's shared server retired with them.
 * professional-crm's schema.sql is applied here still: job-hunt's link to the
 * CRM writes into its table until job-hunt is a plugin too, SMD-2311 PR 4b.)
 *
 * SMD-1798 added the three servers that were still on supabase-js — family-
 * calendar, job-hunt and ob-graph, held there by a grouped `.or()`, a
 * three-level `!inner` embed, an `in.(…)` list and a `!fk_name` hint the shim
 * did not read until that change — so a shim gap in any of those shapes fails
 * a named assertion here too. (Of the other three that moved, agent-memory-api
 * and the metadata worker need the model provider stubbed and the fork's own
 * tables, and test-writes.ts drives them; the third, enhanced-mcp, retired
 * with SMD-1931.)
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
 * Each server is imported as a module — its default export's `fetch` is the
 * handler `bun <file>` serves (SMD-1799) — and every tool it registers is
 * called through `tools/call` with the arguments its schema describes — each
 * optional filter on its own, each error path the tool documents — and what
 * comes back is read: the row a write stored, the rows a read chose, the
 * embedded relation as an object or null, the trigger's effect, the message a
 * failure carries. The database is the fork's migrations plus the two
 * `schema.sql` files, applied as their READMEs'
 * Step 1 says — with no `auth.*` stub and no Supabase role: since SMD-1810 the
 * files carry no policy on auth.uid() and no GRANT to a role Postgres does not
 * have — and dropped again at the end, whether or not the run finished,
 * because CI shares one Postgres across the job. The role that connects owns
 * the tables and needs no grant.
 *
 * The drift guard: each server's `tools/list` under a write key is exactly the
 * set of tools driven here, so a tool added to a server fails this suite until
 * it is driven. Ten tools on the one server: job-hunt's.
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

// ── The database: the fork's schema and the two extension schemas ──

// The width is pinned as test-writes.ts pins it; no vector is involved.
await resetSchema(URL_, { dim: 1536, model: "openai/text-embedding-3-small" });
const sql = new SQL({ url: URL_, max: 2 });

/** The schemas job-hunt's tools write into: its own, and professional-crm's, which its last tool writes into until PR 4b. */
const SCHEMAS = ["extensions/professional-crm/schema.sql",
  "extensions/job-hunt/schema.sql"];
const schemaText = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
/** What the schemas create, dropped before they are applied and at the end. */
async function dropExtensionSchemas() {
  for (const rel of SCHEMAS) {
    const text = schemaText(rel);
    for (const m of text.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)) await sql.unsafe(`DROP TABLE IF EXISTS public.${m[1]} CASCADE`);
    for (const m of text.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\s*\(/g)) await sql.unsafe(`DROP FUNCTION IF EXISTS public.${m[1]} CASCADE`);
  }
}
await dropExtensionSchemas();
// The READMEs' Step 1, exactly: the files, on a Postgres with no `auth` schema and no Supabase role. Until SMD-1810 this
// suite created two `auth.*` stubs and the three roles first, because the files' policies and GRANTs named them; a
// file that needs either again fails here, as it would for a user.
const [{ authSchema, supabaseRoles }] = (await sql`SELECT to_regnamespace('auth') IS NOT NULL AS "authSchema", (SELECT count(*)::int FROM pg_roles WHERE rolname IN ('authenticated', 'anon', 'service_role')) AS "supabaseRoles"`) as { authSchema: boolean; supabaseRoles: number }[];
if (authSchema || supabaseRoles > 0) console.error(`test-tools.ts: this database carries ${authSchema ? "an auth schema" : ""}${authSchema && supabaseRoles ? " and " : ""}${supabaseRoles ? `${supabaseRoles} Supabase role(s)` : ""} — the schemas apply regardless, but a fresh database proves more`);
for (const rel of SCHEMAS) await sql.unsafe(schemaText(rel));

// ── The servers' handlers, and the environment the READMEs document ─────────

type Handler = (req: Request) => Response | Promise<Response>;

const KEY = "one-write-key-for-every-tool";
const USER = "11111111-1111-4111-8111-111111111111";
process.env.SUPABASE_URL = URL_;
process.env.MCP_ACCESS_KEY = KEY;
process.env.DEFAULT_USER_ID = USER;
for (const name of ["MCP_ACCESS_KEYS", "SUPABASE_SERVICE_ROLE_KEY", "OB1_PG_POOL"]) delete process.env[name];

/** Each server's handler by file, for the drift guard at the end. */
const handlers = new Map<string, Handler>();
async function load(rel: string): Promise<Handler> {
  // The handler Bun would serve: the module's default export's `fetch` (SMD-1799); nothing stands in for `Deno`.
  const mod = (await import(join(ROOT, rel))) as { default?: { fetch?: unknown } };
  assert(typeof mod.default?.fetch === "function", `${rel} imports as a module and exports default { fetch }`);
  const h = mod.default!.fetch as Handler;
  handlers.set(rel, h);
  return h;
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
const eqJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Everything below runs inside one try so the schemas are dropped however it ends.
try {

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
  const files = ["extensions/job-hunt/index.ts"];
  let total = 0;
  for (const file of files) {
    const handler = handlers.get(file);
    const listed = handler ? await toolsOf(handler) : [];
    const called = [...(driven.get(file) ?? [])].sort();
    assert(listed.length > 0 && listed.join() === called.join(), `${file}: tools/list under the write key is exactly the ${called.length} tool(s) driven above (${listed.join(", ")})`);
    total += listed.length;
  }
  assert(total === 10, `ten tools on the one server (${total})`);
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
  } catch (e) {
    console.error(`test-tools.ts: dropping the extension schemas failed — ${e instanceof Error ? e.message : String(e)}`);
  }
  await sql.close();
}
report();
