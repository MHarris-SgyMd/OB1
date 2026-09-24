#!/usr/bin/env bun
/**
 * smoke.ts — drive the built dashboard against a live Open Brain server, the
 * way a browser would (SMD-1801). CI's "Full stack, no Supabase" job runs it
 * against the compose stack after `bun run build`.
 *
 *   MCP_URL=http://127.0.0.1:8000/ bun smoke.ts --key <write-key> [--read-key <read-key>]
 *
 * Starts `vite preview` on a free port with MCP_URL and a throwaway
 * SESSION_SECRET, then asserts, with a cookie jar of one:
 *
 *   - unsigned-in, / redirects to /signin and /api/mcp answers 401;
 *   - a wrong key is refused at /signin with 401, and sets no cookie;
 *   - the write key signs in (303 to /, a cookie), / renders, and the JSON the
 *     first page loads — thought_stats through /api/mcp — begins "Total
 *     thoughts:"; list_thoughts and search_thoughts_keyword answer too;
 *   - the read key, when given, signs in, reads the same stats, and is refused
 *     capture_thought with 403 by the proxy — before the server is asked;
 *   - sign-out clears the cookie and /api/mcp is 401 again.
 *
 * Exit 0 when every assertion holds, 1 otherwise. Read-only against the brain:
 * nothing is captured (the one capture attempted is the refused one).
 */

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const MCP_URL = process.env.MCP_URL;
const WRITE_KEY = flag("key");
const READ_KEY = flag("read-key");
if (!MCP_URL || !WRITE_KEY) {
  console.error("usage: MCP_URL=<server> bun smoke.ts --key <write-key> [--read-key <read-key>]");
  process.exit(2);
}

let pass = 0;
let fail = 0;
const ok = (msg: string) => { console.log(`  ✓  ${msg}`); pass++; };
const bad = (msg: string) => { console.log(`  ✗  ${msg}`); fail++; };
const assert = (cond: boolean, msg: string) => (cond ? ok(msg) : bad(msg));

// A free port, then release it for the preview server.
const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
const port = probe.port!;
probe.stop(true);

const preview = Bun.spawn(["bun", "run", "preview", "--", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
  cwd: import.meta.dir,
  env: { ...process.env, MCP_URL, SESSION_SECRET: "smoke-".padEnd(48, "s") },
  stdout: "pipe",
  stderr: "pipe",
});
const base = `http://127.0.0.1:${port}`;
const stop = () => { try { preview.kill(); } catch { /* already gone */ } };
process.on("exit", stop);

// Wait for the preview to answer; report its output if it never does.
const deadline = Date.now() + 30_000;
let up = false;
while (Date.now() < deadline) {
  try {
    const r = await fetch(`${base}/signin`, { redirect: "manual" });
    if (r.status === 200) { up = true; break; }
  } catch { /* not yet */ }
  await Bun.sleep(250);
}
if (!up) {
  console.error(`the preview server never answered on ${base}`);
  console.error(await new Response(preview.stdout).text());
  console.error(await new Response(preview.stderr).text());
  stop();
  process.exit(1);
}
console.log(`▸ dashboard ${base} → MCP ${MCP_URL}`);

// One cookie: the session, or nothing.
let cookie = "";
const takeCookie = (r: Response) => {
  const set = r.headers.getSetCookie?.() ?? [];
  for (const c of set) {
    const [pair] = c.split(";");
    const [name, value] = pair.split("=");
    if (name === "ob1_dashboard_session") cookie = value ? `${name}=${value}` : "";
  }
};
const headers = (extra: Record<string, string> = {}) => (cookie ? { cookie, ...extra } : extra);

// As a browser submits the form: HTML wanted (without `accept: text/html`,
// SvelteKit answers the action as JSON for a fetch, HTTP 200 whatever happened),
// same-origin (its CSRF check reads `origin`).
const FORM = { "content-type": "application/x-www-form-urlencoded", accept: "text/html", origin: base };
const signIn = (key: string) => fetch(`${base}/signin`, {
  method: "POST",
  redirect: "manual",
  headers: headers(FORM),
  body: new URLSearchParams({ key }).toString(),
});
const tool = async (name: string, toolArgs: Record<string, unknown> = {}) => {
  const r = await fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ name, args: toolArgs }),
  });
  const body = (await r.json().catch(() => ({}))) as { result?: { content?: { text?: string }[]; isError?: boolean }; error?: string };
  return { status: r.status, text: body.result?.content?.[0]?.text ?? "", isError: body.result?.isError === true, error: body.error ?? "" };
};

// Signed out.
{
  const home = await fetch(`${base}/`, { redirect: "manual" });
  assert(home.status === 302 && (home.headers.get("location") ?? "").endsWith("/signin"), `signed out, / redirects to /signin (${home.status} → ${home.headers.get("location")})`);
  const api = await tool("thought_stats");
  assert(api.status === 401, `signed out, /api/mcp answers 401 (${api.status})`);
}

// A wrong key.
{
  const r = await signIn("not-a-key");
  takeCookie(r);
  assert(r.status === 401, `a wrong key is refused at /signin with 401 (${r.status})`);
  assert(cookie === "", "…and no session cookie is set");
  const page = await r.text();
  assert(page.includes("The server refused that access key"), "…and the page says the server refused it");
}

// The write key.
{
  const r = await signIn(WRITE_KEY);
  takeCookie(r);
  assert(r.status === 303 && (r.headers.get("location") ?? "") === "/", `the write key signs in: 303 to / (${r.status} → ${r.headers.get("location")})`);
  assert(cookie !== "", "…and a session cookie is set");
  const home = await fetch(`${base}/`, { headers: headers() });
  const html = await home.text();
  assert(home.status === 200 && html.includes("Signed in with a write key"), `/ renders for the write key and names its scope (${home.status})`);
  assert(html.includes("+ Capture"), "…with the capture button");
  const stats = await tool("thought_stats");
  assert(stats.status === 200 && stats.text.startsWith("Total thoughts:"), `the first page's JSON — thought_stats through /api/mcp — reaches the database (${stats.status}: ${stats.text.split("\n")[0]})`);
  const listed = await tool("list_thoughts", { limit: 1 });
  assert(listed.status === 200 && !listed.isError, `list_thoughts answers (${listed.status})`);
  const kw = await tool("search_thoughts_keyword", { query: "zylotrope-dashboard-smoke-needle" });
  assert(kw.status === 200 && !kw.isError && /^No thoughts contain/.test(kw.text), `search_thoughts_keyword reaches the database (${kw.status}: ${kw.text.split("\n")[0]})`);
  const unnamed = await fetch(`${base}/api/mcp`, { method: "POST", headers: headers({ "content-type": "application/json" }), body: "{}" });
  assert(unnamed.status === 400, `a call with no tool name is 400 (${unnamed.status})`);
  const out = await fetch(`${base}/signout`, { method: "POST", redirect: "manual", headers: headers({ origin: base }) });
  takeCookie(out);
  assert(out.status === 303 && cookie === "", `sign-out is a POST that clears the cookie (${out.status})`);
  const after = await tool("thought_stats");
  assert(after.status === 401, `…and /api/mcp is 401 again (${after.status})`);
}

// The read key.
if (READ_KEY) {
  const r = await signIn(READ_KEY);
  takeCookie(r);
  assert(r.status === 303 && cookie !== "", `the read key signs in (${r.status})`);
  const home = await fetch(`${base}/`, { headers: headers() });
  const html = await home.text();
  assert(home.status === 200 && html.includes("Signed in with a read key"), `/ renders for the read key and names its scope (${home.status})`);
  assert(!html.includes("+ Capture") && html.includes("Read-only key"), "…without the capture button");
  const stats = await tool("thought_stats");
  assert(stats.status === 200 && stats.text.startsWith("Total thoughts:"), `the read key reads stats (${stats.status})`);
  const cap = await tool("capture_thought", { content: "the dashboard smoke must never store this" });
  assert(cap.status === 403 && /read-scoped/.test(cap.error), `the read key is refused capture by the proxy with 403, before the server is asked (${cap.status}: ${cap.error})`);
  const out = await fetch(`${base}/signout`, { method: "POST", redirect: "manual", headers: headers({ origin: base }) });
  takeCookie(out);
  assert(out.status === 303 && cookie === "", "…and signs out");
} else {
  console.log("  ·  no --read-key: the read-key arm skipped");
}

stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
