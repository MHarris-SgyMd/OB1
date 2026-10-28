#!/usr/bin/env bun
/**
 * smoke.ts — drive the operator GUI against a running brain the way a browser
 * would (SMD-2280). CI's full-stack job runs it through the stack's proxy:
 *
 *   bun smoke.ts --url http://127.0.0.1:8010/dashboard --key <write> --read-key <read> --capture-key <capture>
 *
 * Each key may come from the environment instead (OB1_SMOKE_KEY,
 * OB1_SMOKE_READ_KEY, OB1_SMOKE_CAPTURE_KEY), off the process list.
 *
 * With one cookie jar, it asserts:
 *   - signed out, every page and the sign-out redirect to /signin, and
 *     /health answers; the pages' CSP, framing and Referrer-Policy headers;
 *   - a wrong key and a capture-only key are refused at /signin and set no
 *     cookie; a cookie the server never issued is no session; a sign-in
 *     posted from another origin or with Origin null is refused;
 *   - the write key signs in: a cookie scoped to /dashboard, httpOnly,
 *     SameSite=Lax, a day, Secure only on https; and the overview, the
 *     status page and a thought's page render from the REST core, naming
 *     what the core answers on its own (the total, the version, a thought's
 *     text — required with --require-thought); the thought links are not
 *     preloaded; a wrong key from the signed-in tab is refused in words;
 *   - no page, header, navigation data (__data.json) or script module holds
 *     the key;
 *   - sign-out ends the session on the server, and so does a second sign-in
 *     over it; one key's 21st sign-in ends its own oldest session, not
 *     another key's;
 *   - on their own, before any request: browse's trail walked 26 pages over
 *     synthetic cursors (Previous to the 20th page back, then First page), and
 *     a list's first line cut beside an emoji keeping it whole;
 *   - browse (PR 2a) walks every thought a page of one at a time, newest and
 *     oldest first, each once, the one order the other's reverse; Previous
 *     and First page go back; a filter keeps its rows; a cursor the core
 *     refuses is a 400 in words; its data is each thought's id, first line,
 *     time, flag, type and trust alone;
 *   - search (PR 2a) finds the driven thought by meaning and by exact text,
 *     pages the exact-text matches, and sends each hit's fields alone;
 *   - the change feed (PR 2b) lists the driven thought's capture, walks every
 *     change a page of one at a time from a start, each once, and refuses a
 *     start it cannot read in words; the workers, proposals and query-log
 *     pages render, the query log holding the smoke's own search where
 *     query_log is on; each list's data its shown fields alone;
 *   - the read key signs in as a read key, browses, searches and reads the four
 *     operator views, and a thought the brain does not hold is a 404;
 *   - the example plugin's Notes page (PR 3): with `--notes on`, the write and
 *     read keys' navs name it, it lists the newest thoughts and a thought's
 *     notes, the write key pins one of 2,000 characters sent with CRLF breaks
 *     (an empty note, one of 2,001, a NUL and a thought not held refused in
 *     words; an address naming no id says so), the read key sees it with no
 *     pin form and its pin is refused; with `--notes off`, no nav names it and its page
 *     and pin are the GUI's 404 (pinning to a held thought only once the page
 *     is); unset, a Notes page the nav names is read but not pinned to.
 *     `--notes-only` runs that arm alone.
 *   - the write verbs (SMD-3322), with `--writes`: a thought captured for the
 *     arm over the proxy's /mcp under the write key is edited and deleted on
 *     its own pages — the edit posted as the page's multipart form does, a
 *     160 kB text of it saved, refused in words when its text is empty, its
 *     time altered, or stale (keeping that stale time in the form); the delete
 *     confirmed, the list saying so once from its flash cookie and never from
 *     a link, the thought then a 404 — and a read key is offered neither (no
 *     links; the pages' 403; its posts refused). A body past 64 kB is refused
 *     anywhere but an edit's post, a sign-in's signed out among them, and a
 *     thought whose text would post past the edit page's 1,000,000 bytes (its
 *     line breaks sent as CRLF) is offered no form. It prints the thought's
 *     id, for CI to read its audit rows.
 *
 * Exit 0 when every assertion holds, 1 otherwise. Read-only against the
 * brain, but for the click-through each thought page's `fetch` logs, with
 * `--notes on` alone the notes the arm pins to the example plugin's table, and
 * with `--writes` alone the one thought that arm captures, edits and deletes.
 */

import { pageLinks, readBrowse, TRAIL_MAX } from "./src/lib/browse.ts";
import { firstLine } from "./src/lib/format.ts";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const BASE = flag("url")?.replace(/\/$/, "");
// Each key from its flag, or from the environment CI's step exports, so a key need not ride a command line the process list shows.
const WRITE_KEY = flag("key") ?? (process.env.OB1_SMOKE_KEY || undefined);
const READ_KEY = flag("read-key") ?? (process.env.OB1_SMOKE_READ_KEY || undefined);
const CAPTURE_KEY = flag("capture-key") ?? (process.env.OB1_SMOKE_CAPTURE_KEY || undefined);
/** Fail, not skip, when the overview lists no thought: CI captures one first, so its thought page is always driven. */
const REQUIRE_THOUGHT = args.includes("--require-thought");
/** Fail unless the thought driven is an ingested one: CI's capture is, so the notice arm cannot pass on a thought without one. */
const REQUIRE_INGESTED = args.includes("--require-ingested");
/** Fail, not skip, when the brain holds fewer than three thoughts: CI captures three, so browse walks three pages and search pages past its first. */
const REQUIRE_PAGES = args.includes("--require-pages");
/** Fail unless the proposals and workers pages render rows, not their empty words: CI plants one proposal and one pool. */
const REQUIRE_ROWS = args.includes("--require-rows");
/** The example plugin's Notes page (PR 3): `on` requires it in the nav and drives it, `off` requires it absent and its route a 404; unset, the nav decides which. */
const NOTES = flag("notes");
/** The Notes arm alone, after the pure checks: CI's plugin step, whose stack the full smoke has already driven. */
const NOTES_ONLY = args.includes("--notes-only");
/** The write verbs' arm (SMD-3322): captures one thought of its own over /mcp, then edits and deletes it through the GUI. Off unless asked, so the smoke writes nothing to a brain it is pointed at. */
const WRITES = args.includes("--writes");
if (!BASE || !WRITE_KEY || (NOTES !== undefined && NOTES !== "on" && NOTES !== "off")) {
  console.error("usage: bun smoke.ts --url <origin>/dashboard --key <write-key> (or OB1_SMOKE_KEY) [--read-key <read-key>] [--capture-key <capture-key>] [--require-thought] [--require-ingested] [--require-pages] [--require-rows] [--notes on|off] [--notes-only] [--writes]");
  process.exit(2);
}
const ORIGIN = new URL(BASE).origin;
/** The session cookie: its name carries the origin's port when the origin names one (listener.ts sessionCookieName, SMD-3352), written out here, not imported, so a GUI that drops it fails this smoke. */
const COOKIE = new URL(BASE).port ? `ob1_dashboard_session_${new URL(BASE).port}` : "ob1_dashboard_session";
/** The delete's flash cookie, named after the session cookie (writes.ts deletedCookie): written out here, as COOKIE is. */
const FLASH = `${COOKIE}_deleted`;

let pass = 0;
let fail = 0;
const ok = (msg: string) => { console.log(`  ✓  ${msg}`); pass++; };
const bad = (msg: string) => { console.log(`  ✗  ${msg}`); fail++; };
const assert = (cond: boolean, msg: string) => (cond ? ok(msg) : bad(msg));

// One cookie: the session, or nothing; and the last Set-Cookie line for it, attributes included.
let cookie = "";
let lastSetCookie = "";
const takeCookie = (r: Response) => {
  for (const c of r.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (pair.slice(0, eq) === COOKIE) {
      const value = pair.slice(eq + 1);
      cookie = value ? `${COOKIE}=${value}` : "";
      lastSetCookie = c;
    }
  }
};
const headers = (extra: Record<string, string> = {}) => (cookie ? { cookie, ...extra } : extra);
const get = async (path: string) => {
  const r = await fetch(`${BASE}${path}`, { redirect: "manual", headers: headers() });
  takeCookie(r);
  return { status: r.status, location: r.headers.get("location") ?? "", html: await r.text(), headers: r.headers };
};
/** The cookie's attributes: scoped to the GUI, httpOnly, Lax, and Secure exactly where the origin is https. */
const https = ORIGIN.startsWith("https:");
const attributesHold = (line: string) =>
  /;\s*Path=\/dashboard(;|$)/i.test(line) && /HttpOnly/i.test(line) && /SameSite=Lax/i.test(line) && /;\s*Secure/i.test(line) === https;
const redacted = (line: string) => line.replace(/=[^;]*/, "=…");

// As a browser submits the form: HTML wanted (without `accept: text/html`,
// SvelteKit answers an action as JSON for a fetch), same-origin (the GUI's
// origin check reads `origin`, hooks.server.ts).
const FORM = { "content-type": "application/x-www-form-urlencoded", accept: "text/html", origin: ORIGIN };
const signIn = async (key: string) => {
  const r = await fetch(`${BASE}/signin`, { method: "POST", redirect: "manual", headers: headers(FORM), body: new URLSearchParams({ key }).toString() });
  takeCookie(r);
  return { status: r.status, location: r.headers.get("location") ?? "", html: await r.text() };
};
const signOut = async () => {
  const r = await fetch(`${BASE}/signout`, { method: "POST", redirect: "manual", headers: headers({ origin: ORIGIN }) });
  takeCookie(r);
  return r;
};
/**
 * The keys of a page's listed items — the root field `field` of its __data.json, an array of objects — sorted and
 * joined, the same for every item, or what differs. SvelteKit's data is devalue's flat array: the node's root object
 * maps each key to an index, so object keys are the payload's structure and a thought's text is only ever a string
 * element.
 */
function listKeys(json: string, field: string): string {
  try {
    const doc = JSON.parse(json) as { nodes?: ({ data?: unknown[] } | null)[] };
    for (const node of doc.nodes ?? []) {
      const data = node?.data;
      const root = data?.[0] as Record<string, number> | undefined;
      if (!data || !root || typeof root !== "object" || !(field in root)) continue;
      const items = (data[root[field]] as number[]).map((i) => Object.keys(data[i] as object).sort().join(","));
      const kinds = [...new Set(items)];
      return items.length === 0 ? "no items listed" : kinds.length === 1 ? kinds[0] : `items differ: ${kinds.join(" | ")}`;
    }
    return `no ${field} in the data`;
  } catch (err) {
    return `unreadable: ${err instanceof Error ? err.message : String(err)}`;
  }
}
const toSignin = (r: { status: number; location: string }) => r.status === 303 && r.location === "/dashboard/signin";
/** Every page the GUI renders, by its path under the base. */
const PAGES = ["/", "/status", "/thoughts", "/search", "/changes", "/proposals", "/workers", "/query-log", "/thoughts/00000000-0000-0000-0000-000000000000"];

/** The thought ids a list page links to, in its order, within the element marked `testid`. */
const listedIds = (html: string, testid: string) => {
  const at = html.indexOf(`data-testid="${testid}"`);
  if (at < 0) return [];
  const end = html.indexOf("</ul>", at);
  return [...html.slice(at, end < 0 ? undefined : end).matchAll(/href="\/dashboard\/thoughts\/([0-9a-f-]{36})"/g)].map((m) => m[1]);
};
/** A link's address under the base, by its testid, as the page wrote it (attributes unescaped); "" when there is none. */
const linkOf = (html: string, testid: string) => {
  const m = new RegExp(`<a href="([^"]+)"[^>]*data-testid="${testid}"`).exec(html);
  return m ? m[1].replaceAll("&amp;", "&").replace(/^\/dashboard/, "") : "";
};
/** Whether `key` is in any of `pages` — its text or a header — or in any script module they load, followed import by import. */
async function keyIn(pages: { html: string; headers: Headers }[], key: string) {
  const queue = pages.flatMap((p) => [...p.html.matchAll(/["'](\/dashboard\/_app\/[^"']+\.js)["']/g)].map((m) => m[1]));
  const scripts = new Set<string>();
  let leaked = pages.some((p) => p.html.includes(key) || [...p.headers.values()].some((v) => v.includes(key)));
  while (queue.length) {
    const s = queue.pop()!;
    if (scripts.has(s)) continue;
    scripts.add(s);
    const text = await (await fetch(`${ORIGIN}${s}`)).text();
    if (text.includes(key)) leaked = true;
    // A chunk names the others it imports relative to itself: "./x.js", "../chunks/y.js".
    for (const m of text.matchAll(/["'](\.{1,2}\/[^"']+\.js)["']/g)) queue.push(new URL(m[1], `${ORIGIN}${s}`).pathname);
  }
  return { leaked, scripts };
}

/** Every page of a browse from `start`, by its Next links: each page's ids, and its address. At most 60 pages. */
async function walkBrowse(start: string) {
  const pages: { path: string; ids: string[]; html: string }[] = [];
  let path = start;
  while (path && pages.length < 60) {
    const r = await get(path);
    if (r.status !== 200) break;
    pages.push({ path, ids: listedIds(r.html, "browse"), html: r.html });
    path = linkOf(r.html, "next");
  }
  return pages;
}

console.log(`▸ dashboard ${BASE}`);

// Browse's trail, on its own (src/lib/browse.ts imports nothing): 26 pages walked by Next over synthetic cursors, then
// back by Previous. No brain of CI's holds 22 pages of thoughts, so this is where the trail's cut is made and spent
// (review pass 2: nothing held the half that makes it).
{
  const at = (address: string) => readBrowse(new URL(address, "http://x").searchParams);
  let q = at("/t?limit=1");
  const page = (qq: ReturnType<typeof readBrowse>) => (qq.after === undefined ? 1 : Number(qq.after.slice(1)) + 1);
  for (let n = 1; n < 26; n++) q = at(pageLinks("/t", q, `c${n}`).next!);
  const landed: number[] = [];
  let links = pageLinks("/t", q, null);
  while (links.previous && landed.length < 30) {
    q = at(links.previous);
    landed.push(page(q));
    links = pageLinks("/t", q, null);
  }
  const want = Array.from({ length: TRAIL_MAX }, (_, i) => 25 - i);
  assert(landed.join() === want.join() && links.previous === null && links.first !== null && at(links.first).after === undefined,
    `browse's trail: from page 26, Previous steps back to page ${want[want.length - 1]} one page at a time, then gives way to First page (${landed.join(",")})`);
  const onward = at(pageLinks("/t", q, "c99").next!);
  assert(onward.cut && !at(links.first!).cut, "…Next from a cut page stays cut, and First page is not");
  // An address holding more cursors than are kept is cut too, though it carries no mark (a hand-made one: review pass 2).
  const handMade = at(`/t?limit=1&after=c30&back=${Array.from({ length: TRAIL_MAX + 1 }, (_, i) => `c${i + 1}`).join(".")}`);
  assert(handMade.cut && handMade.trail.length === TRAIL_MAX, `…and an address with ${TRAIL_MAX + 1} cursors behind it is cut, keeping ${TRAIL_MAX}`);
}
// A list's first line cut at its length never splits a surrogate pair (review pass 2: half an emoji was U+FFFD).
{
  const cutAt = [158, 159, 160].map((n) => firstLine(`${"a".repeat(n)}\u{1F600}\u{1F600}tail`));
  assert(cutAt.every((l) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(l) && l.endsWith("…")), "a list's first line, cut beside an emoji, holds no half of one");
}

// The example plugin's Notes page (PR 3): in the nav of a key the registry lists the plugin to, its route under
// /plugins/example/notes rendered from the plugin's own operations — the newest thoughts, a thought's notes, and a
// write key's pin — and with the plugin off, no nav entry and a 404 (SMD-2310's deferred Verify item).
const NOTES_PATH = "/plugins/example/notes";
const NO_THOUGHT = "00000000-0000-4000-8000-000000000000";
const navOf = (html: string) => /<nav[^>]*aria-label="Views"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
const namesNotes = (html: string) => new RegExp(`<a[^>]*href="/dashboard${NOTES_PATH}"[^>]*>Notes</a`).test(navOf(html));
const pin = async (thought: string, note: string) => {
  const r = await fetch(`${BASE}${NOTES_PATH}?thought=${thought}&/pin`, { method: "POST", redirect: "manual", headers: headers(FORM), body: new URLSearchParams({ thought_id: thought, note }).toString() });
  return { status: r.status, location: r.headers.get("location") ?? "", html: await r.text(), headers: r.headers };
};
/** The pin form as the page renders it: its action, unescaped, and its hidden fields — what a browser posts (review pass 4: the smoke built its own post, so a broken form passed). */
const pinFormOf = (html: string) => {
  const form = /<form[^>]*data-testid="pin"[^>]*>[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";
  const action = (/action="([^"]*)"/.exec(form)?.[1] ?? "").replaceAll("&amp;", "&");
  const fields = Object.fromEntries([...form.matchAll(/<input[^>]*type="hidden"[^>]*>/g)].map((m) => [/name="([^"]*)"/.exec(m[0])?.[1] ?? "", /value="([^"]*)"/.exec(m[0])?.[1] ?? ""]));
  return { action, fields };
};
const notesListed = (html: string) => [...(/data-testid="notes"[\s\S]*?<\/ol>/.exec(html)?.[0] ?? "").matchAll(/<li[\s\S]*?<\/li>/g)].map((m) => m[0]);
/** The GUI's own 404 — the gate's, words SvelteKit's error page gives a page it has no route for — never the core's refusal in words. */
const guiNotFound = (r: { status: number; html: string }) => r.status === 404 && r.html.includes('data-testid="error">No page at this address.<');
/** A refusal as the page shows it, beside the form or above it — not the words in the page's hydration data (review pass 1). */
const shownRefusal = (html: string, words: string) => new RegExp(`data-testid="pin-error"[^>]*>[^<]*${words}`).test(html);
async function notesArm() {
  const out = await get(NOTES_PATH);
  assert(toSignin(out), `signed out, the Notes page redirects to /signin (${out.status} → ${out.location})`);
  const signedIn = await signIn(WRITE_KEY!);
  const home = await get("/");
  assert(signedIn.status === 303 && home.status === 200, `the write key signs in for the Notes arm (${signedIn.status}, ${home.status})`);
  // The page of grants is a stack configured with the authorization server's (SMD-3307 PR 3; review pass 1): here, no nav names it and its page is a 404.
  const grants = await get("/grants");
  assert(!navOf(home.html).includes('href="/dashboard/grants"') && grants.status === 404, `with no authorization server, the write key's nav has no page of grants, and its address is a 404 (${grants.status})`);
  // The root layout reads the address, so SvelteKit runs it again at every navigation and the nav follows the registry (review pass 2; pass 4: only a browser run held it).
  const rootData = await get("/__data.json");
  let rereads = false;
  try { rereads = (JSON.parse(rootData.html) as { nodes?: ({ uses?: { url?: number } } | null)[] }).nodes?.[0]?.uses?.url === 1; } catch { /* asserted below */ }
  assert(rereads, `the root layout's data says it reads the address, so it runs again at every navigation (${rootData.status})`);
  const on = NOTES === undefined ? namesNotes(home.html) : NOTES === "on";
  // Only --notes on writes: unset, a plugin found on is read, never pinned to (review pass 1: a plain run wrote a note).
  const writes = NOTES === "on";
  if (NOTES === undefined) console.log(`  ·  no --notes: the nav ${on ? "names" : "does not name"} Notes, so the plugin is taken as ${on ? "on, and read without pinning" : "off"}`);
  if (!on) {
    const page = await get(NOTES_PATH);
    assert(!namesNotes(home.html) && guiNotFound(page), `the example plugin off: the write key's nav has no Notes, and its page is the GUI's own 404 (${page.status})`);
    // The pin to a real thought, so the gate alone can answer 404 (on a thought the brain does not hold the core's own
    // refusal is one too: review pass 1) — and only under --notes off and once the page is a 404, so no run that took
    // the plugin for off by a nav it could not read writes (review pass 2).
    if (NOTES === "off" && guiNotFound(page)) {
      const held = /href="\/dashboard\/thoughts\/([0-9a-f-]{36})"/.exec(home.html)?.[1] ?? NO_THOUGHT;
      const posted = await pin(held, "never pinned");
      assert(guiNotFound(posted), `…and its pin, on a thought the brain holds, is the GUI's 404 too (${posted.status})`);
      // The gate before anything the post says (review pass 5: a malformed post was answered 400 first), and the page's
      // data a 404 too — SvelteKit's error node, the request itself 200.
      const malformed = await pin("not-an-id", "");
      // As a script's own post asks (x-sveltekit-action): the action's answer alone, no load after it to 404 the page.
      const asJson = await fetch(`${BASE}${NOTES_PATH}?/pin`, { method: "POST", redirect: "manual", headers: headers({ ...FORM, accept: "application/json", "x-sveltekit-action": "true" }), body: new URLSearchParams({ thought_id: "not-an-id", note: "" }).toString() });
      const asJsonBody = await asJson.text();
      const offData = await get(`${NOTES_PATH}/__data.json`);
      let dataStatus = 0;
      try { dataStatus = ((JSON.parse(offData.html) as { nodes?: ({ type?: string; status?: number } | null)[] }).nodes ?? []).find((n) => n?.type === "error")?.status ?? 0; } catch { /* asserted below */ }
      assert(guiNotFound(malformed) && asJson.status === 404 && /"type":"error"/.test(asJsonBody) && dataStatus === 404, `…a malformed pin is the GUI's 404 as well, a script's own post of it the action's 404 error, and the page's data an error of 404 (${malformed.status}, ${asJson.status} ${asJsonBody.slice(0, 60)}, ${dataStatus})`);
    }
    await signOut();
    if (READ_KEY) {
      const r = await signIn(READ_KEY);
      const [h, p] = [await get("/"), await get(NOTES_PATH)];
      assert(r.status === 303 && h.status === 200 && !namesNotes(h.html) && guiNotFound(p), `…nor the read key's, its page the GUI's 404 (${r.status}, ${p.status})`);
      await signOut();
    }
    return;
  }
  const who = /data-testid="who">([^<·]+)·/.exec(home.html)?.[1].trim() ?? "";
  assert(namesNotes(home.html), "the example plugin on: the write key's nav names Notes");
  const page = await get(NOTES_PATH);
  const recent = [...(/data-testid="recent"[\s\S]*?<\/ul>/.exec(page.html)?.[0] ?? "").matchAll(/notes\?thought=([0-9a-f-]{36})"/g)].map((m) => m[1]);
  assert(page.status === 200 && page.html.includes('data-testid="plugin"') && recent.length > 0, `…its page renders the plugin's newest thoughts through example_recent (${page.status}, ${recent.length} listed)`);
  const thought = recent[0] ?? NO_THOUGHT;
  const before = await get(`${NOTES_PATH}?thought=${thought}`);
  assert(before.status === 200 && before.html.includes('data-testid="pin"'), `…a thought's notes, with a pin form for the write key (${before.status})`);
  const upper = await get(`${NOTES_PATH}?thought=${thought.toUpperCase()}`);
  assert(upper.status === 200 && pinFormOf(upper.html).fields.thought_id === thought, `…an id in capitals reads as the same thought, written back in lower case (${upper.status})`);
  const badId = await get(`${NOTES_PATH}?thought=not-an-id`);
  assert(badId.status === 200 && badId.html.includes('data-testid="bad-id"'), `…and an address naming no thought id says so (${badId.status})`);
  const data = await get(`${NOTES_PATH}/__data.json?thought=${thought}`);
  assert(listKeys(data.html, "recent") === "at,id,type", `…its data lists each thought by its shown fields alone (${listKeys(data.html, "recent")})`);
  const { leaked } = await keyIn([page, before, data], WRITE_KEY!);
  assert(!leaked, "…and neither the page, its data nor its scripts hold the key");
  if (!writes) {
    console.log("  ·  no --notes on: the pin arms skipped");
    await signOut();
    return;
  }
  // The note as a browser's textarea sends it: line breaks as CRLF, 2,000 characters once read as LF and trimmed, so the
  // break's two characters and the spaces around it are counted as the field and add_note count them (review pass 1).
  const stamp = String(Date.now());
  const lines = [`Pinned by the GUI smoke <b>${stamp}</b> & kept as typed.`, "x".repeat(600), "y".repeat(600)];
  lines.push("z".repeat(2000 - lines.join("\n").length - 1));
  const note = lines.join("\n");
  // Posted as the page's own form, its hidden thought id and its action as rendered.
  const form = pinFormOf(before.html);
  assert(form.fields.thought_id === thought && form.action.startsWith(`/dashboard${NOTES_PATH}?thought=${thought}&/pin`), `…its pin form carries the thought and posts to its own action (${form.action})`);
  const posted = await fetch(`${ORIGIN}${form.action}`, { method: "POST", redirect: "manual", headers: headers(FORM), body: new URLSearchParams({ ...form.fields, note: `  ${lines.join("\r\n")}  ` }).toString() });
  const pinned = { status: posted.status, location: posted.headers.get("location") ?? "", html: "", headers: posted.headers };
  await posted.text();
  assert(pinned.status === 303 && pinned.location === `/dashboard${NOTES_PATH}?thought=${thought}#pin`, `…the write key pins a note of 2,000 characters sent with CRLF breaks and spaces around it: 303 back to the thought's notes (${pinned.status} → ${pinned.location})`);
  const after = await get(`${NOTES_PATH}?thought=${thought}`);
  const escaped = note.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const mine = notesListed(after.html).filter((li) => li.includes(`>${escaped}<`));
  // The key's name as the by-line starts, not anywhere in the item: a short name is in many a class (review pass 2).
  assert(notesListed(after.html).length === notesListed(before.html).length + 1 && mine.length === 1 && who !== "" && mine[0].includes(`>${who} · `), `…and the thought's notes list it once — trimmed, its breaks LF, escaped — by the key's name (${notesListed(before.html).length} → ${notesListed(after.html).length})`);
  // The data after the pin, so a brain with no note before still holds the notes' shape (review pass 2: CI's never did).
  const withNote = await get(`${NOTES_PATH}/__data.json?thought=${thought}`);
  assert(listKeys(withNote.html, "notes") === "at,by,id,note", `…its data lists each note by its shown fields alone (${listKeys(withNote.html, "notes")})`);
  const long = "w".repeat(2001);
  const [empty, tooLong, nul, nowhere] = [await pin(thought, "   "), await pin(thought, ` ${long} `), await pin(thought, "a\u0000b"), await pin(NO_THOUGHT, "a note on nothing")];
  assert(empty.status === 400 && shownRefusal(empty.html, "Write the note first"), `…an empty note is refused beside the form (${empty.status})`);
  assert(tooLong.status === 400 && shownRefusal(tooLong.html, "A note is at most 2,000 characters; this one is 2,001") && new RegExp(`<textarea[^>]*>\\s?${long}\\s?</textarea>`).test(tooLong.html), `…a note of 2,001 once trimmed is refused beside the form, the note kept in it (${tooLong.status})`);
  assert(nul.status === 400 && shownRefusal(nul.html, "A note cannot hold a NUL"), `…a note holding a NUL is refused in words, not the core's 500 (${nul.status})`);
  assert(nowhere.status === 404 && nowhere.html.includes("holds no thought with that id"), `…a note on a thought the brain does not hold is refused in words (${nowhere.status})`);
  const unchanged = notesListed((await get(`${NOTES_PATH}?thought=${thought}`)).html).length;
  assert(unchanged === notesListed(after.html).length, `…none of them pinned (${unchanged})`);
  // The write's answers too: the pin's redirect, the refusals' pages, the notes after it and their data (review pass 5).
  assert(!(await keyIn([pinned, after, withNote, empty, tooLong, nul, nowhere], WRITE_KEY!)).leaked, "…and no answer of the pin's, its refusals' or the notes after it holds the key");
  await signOut();
  if (READ_KEY) {
    const r = await signIn(READ_KEY);
    const [h, p] = [await get("/"), await get(`${NOTES_PATH}?thought=${thought}`)];
    assert(r.status === 303 && namesNotes(h.html) && p.status === 200 && notesListed(p.html).some((li) => li.includes(`>${escaped}<`)) && !p.html.includes('data-testid="pin"'), `the read key's nav names Notes, and its page lists the note with no pin form (${r.status}, ${p.status})`);
    const refused = await pin(thought, "a read key's note");
    const again = await get(`${NOTES_PATH}?thought=${thought}`);
    assert(refused.status === 403 && shownRefusal(refused.html, "This key cannot pin notes") && notesListed(again.html).length === notesListed(p.html).length, `…and its pin is refused, said on the page, with nothing pinned (${refused.status})`);
    assert(!(await keyIn([h, p, refused, again], READ_KEY)).leaked, "…and none of the read key's pages or answers holds its key");
    await signOut();
  }
}
const finish = () => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};
if (NOTES_ONLY) {
  await notesArm();
  finish();
}

// Signed out.
{
  for (const p of PAGES) {
    const r = await get(p);
    assert(toSignin(r), `signed out, ${p} redirects to /signin (${r.status} → ${r.location})`);
  }
  const out = await signOut();
  assert(out.status === 303 && out.headers.get("location") === "/dashboard/signin", `signed out, sign-out redirects to /signin (${out.status})`);
  const health = await get("/health");
  assert(health.status === 200 && health.html.trim() === "ok", `/health answers ok signed out (${health.status})`);
  const signin = await get("/signin");
  assert(signin.status === 200 && signin.html.includes('name="key"'), `/signin offers key sign-in (${signin.status})`);
  assert(/content-security-policy/i.test([...signin.headers.keys()].join(" ")) && signin.headers.get("x-frame-options") === "DENY", "…with a Content-Security-Policy, and no framing");
  // same-origin, never no-referrer: under no-referrer a browser posts a plain form with `Origin: null`, which
  // the GUI's origin check refuses, and sign-out — a form with no script — failed in every browser (review pass 1).
  // This smoke sets Origin itself, so it holds the header that decides what a browser sends.
  assert(signin.headers.get("referrer-policy") === "same-origin", `…and Referrer-Policy same-origin, so a browser's form post carries its origin (${signin.headers.get("referrer-policy")})`);
  const nullOrigin = await fetch(`${BASE}/signin`, { method: "POST", redirect: "manual", headers: { ...FORM, origin: "null" }, body: new URLSearchParams({ key: WRITE_KEY }).toString() });
  assert(nullOrigin.status === 403, `…since a form posted with Origin null is refused (${nullOrigin.status})`);
}

// Keys the brain must not take.
{
  const wrong = await signIn("not-a-key");
  assert(wrong.status === 401 && cookie === "", `a wrong key is refused at /signin with 401 and no cookie (${wrong.status})`);
  assert(wrong.html.includes("The brain refused that access key"), "…and the page says the brain refused it");
  if (CAPTURE_KEY) {
    const cap = await signIn(CAPTURE_KEY);
    assert(cap.status === 403 && cookie === "", `a capture-only key is refused at /signin with 403 and no cookie (${cap.status})`);
    assert(cap.html.includes("This key cannot read"), "…and the page says why");
  } else {
    console.log("  ·  no --capture-key: the capture-key arm skipped");
  }
  // A cookie the server never issued: random, and the key itself as the value.
  for (const [value, what] of [["A".repeat(43), "a random value"], [WRITE_KEY, "the write key itself"]] as const) {
    cookie = `${COOKIE}=${value}`;
    const r = await get("/");
    assert(toSignin(r) && /Max-Age=0/i.test(lastSetCookie) && attributesHold(lastSetCookie), `a cookie holding ${what} is no session: / redirects to /signin and the cookie is dropped with the session's attributes (${r.status}; ${redacted(lastSetCookie)})`);
    cookie = "";
  }
  const cross = await fetch(`${BASE}/signin`, { method: "POST", redirect: "manual", headers: { ...FORM, origin: "https://elsewhere.example" }, body: new URLSearchParams({ key: WRITE_KEY }).toString() });
  takeCookie(cross);
  assert(cross.status === 403 && cookie === "", `a sign-in posted from another origin is refused, with no cookie (${cross.status})`);
}

// The write key.
let thoughtId = "";
let thoughtText = "";
let thoughtPage = "";
let searchWord = "";
{
  const r = await signIn(WRITE_KEY);
  assert(r.status === 303 && r.location === "/dashboard/", `the write key signs in: 303 to /dashboard/ (${r.status} → ${r.location})`);
  assert(cookie !== "" && attributesHold(lastSetCookie) && /Max-Age=86400/.test(lastSetCookie), `…its cookie scoped to /dashboard, HttpOnly, SameSite=Lax, a day, Secure ${https ? "on https" : "not on plain HTTP"} (${redacted(lastSetCookie)})`);
  assert(!cookie.includes(WRITE_KEY) && !lastSetCookie.includes(WRITE_KEY), "…and it does not hold the key");
  const sessionCookie = cookie;

  const home = await get("/");
  assert(home.status === 200 && home.html.includes('data-testid="who"') && home.html.includes("write key"), `the overview renders for the write key and names its scope (${home.status})`);
  const total = /data-testid="total">([\d,.\s]+)</.exec(home.html)?.[1];
  assert(total !== undefined, `…with the brain's total from the REST core (${total ?? "none"})`);
  assert(home.headers.get("cache-control") === "no-store" && home.headers.get("referrer-policy") === "same-origin", "…no-store, so no copy is kept, and Referrer-Policy same-origin");
  thoughtId = /href="\/dashboard\/thoughts\/([0-9a-f-]{36})"/.exec(home.html)?.[1] ?? "";
  // The thought links are not preloaded on hover: each open is a `fetch`, which the core logs as a click-through (review pass 1).
  if (thoughtId) assert(/data-testid="recent"[^>]*data-sveltekit-preload-data="off"/.test(home.html), "…its thought links not preloaded on hover (each open is a logged fetch)");

  const status = await get("/status");
  const version = /data-testid="version">([^<]+)</.exec(status.html)?.[1];
  assert(status.status === 200 && /^\d+\.\d+\.\d+/.test(version ?? ""), `the status page renders the server's version (${status.status}: ${version ?? "none"})`);
  assert(/data-testid="migrations">\s*\d+ applied/.test(status.html), "…and the ledger's highest migration, in brain_info's words");

  if (thoughtId) {
    const t = await get(`/thoughts/${thoughtId}`);
    thoughtPage = t.html;
    assert(t.status === 200 && t.html.includes('data-testid="text"') && t.html.includes(thoughtId), `a thought's page renders its text and id (${t.status})`);
    // Its text, for search to find it by (PR 2a): the page's, unescaped, and its longest word for the exact-text search.
    thoughtText = (/data-testid="text">([^<]*)</.exec(t.html)?.[1] ?? "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&").trim();
    searchWord = thoughtText.split(/[^A-Za-z0-9]+/).sort((x, y) => y.length - x.length)[0] ?? "";
    // Rendered on the server alone, so its text rides once (review pass 4: twice, with the hydration data).
    assert(!t.html.includes("<script"), "…with no script, so its text is in the page once");
    // The ingested notice exactly where the thought's trust is ingested, before its text (SMD-1724; CI's capture is one).
    const ingested = /<dt[^>]*>trust<\/dt>\s*<dd[^>]*>ingested</.test(t.html);
    const notice = t.html.indexOf('data-testid="notice"');
    assert(ingested === (notice >= 0) && (notice < 0 || notice < t.html.indexOf('data-testid="text"')), `…and the ingested notice ${ingested ? "before its text" : "absent"}, its trust ${ingested ? "ingested" : "otherwise"}`);
    if (REQUIRE_INGESTED) assert(ingested, "…an ingested thought, as --require-ingested asks, so the notice arm is driven");
  } else if (REQUIRE_THOUGHT) {
    bad("the overview lists no thought, and --require-thought asks for one: the thought page went undriven");
  } else {
    console.log("  ·  the brain holds no thought: the thought page's arm skipped");
  }

  // Browse (PR 2a): every thought a page of one at a time, by the pages' own Next links, in each order.
  const count = Number((total ?? "0").replace(/[^\d]/g, ""));
  if (REQUIRE_PAGES && count < 3) bad(`the brain holds ${count} thought(s), and --require-pages asks for three: browse, the cut trail and search went undriven past their first pages`);
  const browse = await get("/thoughts");
  assert(browse.status === 200 && browse.html.includes('data-testid="filters"') && (count === 0 || listedIds(browse.html, "browse").length > 0), `browse renders its filters and lists thoughts from the REST core (${browse.status})`);
  assert(count === 0 || /data-testid="browse"[^>]*data-sveltekit-preload-data="off"/.test(browse.html), "…its thought links not preloaded on hover");
  if (count > 0 && count <= 50) {
    const newest = await walkBrowse("/thoughts?limit=1");
    const oldest = await walkBrowse("/thoughts?limit=1&sort=oldest");
    const ids = newest.flatMap((p) => p.ids);
    const back = oldest.flatMap((p) => p.ids);
    assert(newest.every((p) => p.ids.length === 1) && ids.length === count && new Set(ids).size === count, `browse newest first, a page of one: ${newest.length} pages, each thought once, the overview's ${count} in all (${ids.length} listed, ${new Set(ids).size} distinct)`);
    assert(back.join() === [...ids].reverse().join(), `…and oldest first, the same thoughts in reverse (${back.length})`);
    if (newest.length >= 2) {
      // Previous from the second page is the first, which First page would repeat, so it is not offered there.
      const second = newest[1].html;
      const prev = await get(linkOf(second, "previous"));
      assert(listedIds(prev.html, "browse")[0] === ids[0] && linkOf(second, "first") === "", `…Previous from the second page is the first page (${listedIds(prev.html, "browse")[0] === ids[0]}), with no separate First page link`);
    }
    if (newest.length >= 3) {
      const third = newest[2].html;
      const [prev, first] = [await get(linkOf(third, "previous")), await get(linkOf(third, "first"))];
      assert(listedIds(prev.html, "browse")[0] === ids[1] && listedIds(first.html, "browse")[0] === ids[0], "…from the third, Previous is the second page and First page the first");
    }
    if (newest.length >= 2) {
      // A trail cut at its 20 cursors, spent: the page before is lost, so there is no Previous, only First page (review pass 1)
      // — on the walk's last page, where nothing else would carry the pager (review pass 3: CI's brain, it was hidden).
      // Its own trail stripped, so the cut is spent there: only the page's cursor and the mark (review pass 3).
      const last = new URL(newest[newest.length - 1].path, "http://x");
      last.searchParams.delete("back");
      last.searchParams.set("cut", "1");
      const spent = await get(`${last.pathname}${last.search}`);
      assert(linkOf(spent.html, "previous") === "" && linkOf(spent.html, "first") === "/thoughts?limit=1", `…on a cut trail spent, no Previous, and First page the way back (${linkOf(spent.html, "previous") || "none"}, ${linkOf(spent.html, "first")})`);
    }
    // A filter keeps its rows: trust at least ingested lists the thoughts that carry a trust word, each showing it, and
    // leaves out those with none (a capture through an unclassified key records none: CI's untrusted capture).
    const trusted = await get("/thoughts?min_trust=ingested&limit=100");
    const metas = [...trusted.html.matchAll(/<div class="text-xs text-text-muted[^"]*">([^<]*)<\/div>/g)].map((m) => m[1].trim());
    const drivenTrusted = /<dt[^>]*>trust<\/dt>\s*<dd[^>]*>(?:operator|agent|ingested)</.test(thoughtPage);
    assert(trusted.status === 200 && metas.every((m) => / · (?:operator|agent|ingested)(?: ·|$)/.test(m)) && listedIds(trusted.html, "browse").includes(thoughtId) === drivenTrusted && (REQUIRE_PAGES ? metas.length < count : true),
      `browse at trust ingested and above lists ${metas.length} of ${count}, each with its trust, the driven thought ${drivenTrusted ? "among them" : "(no trust) left out"}`);
  } else if (count > 50) {
    if (REQUIRE_PAGES) bad(`the brain holds ${count} thoughts, past the 50 the walk reads, and --require-pages asks for the walk`);
    else console.log(`  ·  the brain holds ${count} thoughts: browse's walk of every page skipped`);
  }
  // A cursor the core refuses is a 400 in the GUI's words, with the way back to the first page — never a fault.
  const refused = await get("/thoughts?after=AAAAAAAAAAAA");
  assert(refused.status === 400 && refused.html.includes("not one the brain reads") && refused.html.includes('data-testid="restart"'), `a browse cursor the core refuses is a 400 in words, offering the first page (${refused.status})`);
  // NUL, which no Postgres text holds, never reaches the core from a filter or a query: dropped, not a 500 (review pass 1).
  const [nulFilter, nulQuery] = [await get("/thoughts?type=%00"), await get("/search?q=a%00b&mode=text")];
  assert(nulFilter.status === 200 && nulQuery.status === 200, `a NUL in a browse filter or a search query is dropped, not the core's 500 (${nulFilter.status}, ${nulQuery.status})`);
  // Clear filters keeps the order and the size, and drops the filters alone (review pass 1).
  const kept = await get("/thoughts?type=nothing-holds-this&sort=oldest&limit=7");
  assert(linkOf(kept.html, "clear") === "/thoughts?sort=oldest&limit=7", `Clear filters keeps the order and the page size (${linkOf(kept.html, "clear")})`);

  // Search (PR 2a): the driven thought found by a word of its own, by exact text and by meaning.
  const search = await get("/search");
  assert(search.status === 200 && search.html.includes('data-testid="search-form"') && !search.html.includes('data-testid="hits"'), `search renders its form, and with no query reads nothing (${search.status})`);
  if (thoughtText) {
    const text = await get(`/search?q=${encodeURIComponent(searchWord)}&mode=text`);
    assert(text.status === 200 && listedIds(text.html, "hits").includes(thoughtId) && /data-testid="total">\d/.test(text.html), `search by exact text for "${searchWord}" finds the driven thought, and says how many hold it (${text.status})`);
    const meaning = await get(`/search?q=${encodeURIComponent(thoughtText.slice(0, 200))}`);
    assert(meaning.status === 200 && listedIds(meaning.html, "hits").includes(thoughtId), `search by meaning for the thought's own words finds it (${meaning.status}${meaning.html.includes('data-testid="vectorless"') ? ", without a vector" : ""})`);
    assert(/data-testid="hits"[^>]*data-sveltekit-preload-data="off"/.test(text.html), "…its hit links not preloaded on hover");
    // By exact text the query goes as given, its spaces kept: the word and three spaces is not the word (review pass 1;
    // the keyword search is untrimmed by design, migration 012).
    const spaced = await get(`/search?q=${encodeURIComponent(`${searchWord}   `)}&mode=text`);
    assert(spaced.status === 200 && !listedIds(spaced.html, "hits").includes(thoughtId) && spaced.html.includes(`value="${searchWord}   "`), `search by exact text sends the query untrimmed: "${searchWord}" and three spaces does not find the thought, and the field keeps them`);
  }
  if (count >= 2) {
    // A letter nearly every thought holds, a match a page: Next moves on, Previous comes back.
    const one = await get("/search?q=e&mode=text&limit=1");
    const next = linkOf(one.html, "next");
    const two = next ? await get(next) : undefined;
    const prev = two ? await get(linkOf(two.html, "previous")) : undefined;
    const [a, b] = [listedIds(one.html, "hits")[0], two ? listedIds(two.html, "hits")[0] : undefined];
    assert(Boolean(a && b && a !== b && prev && listedIds(prev.html, "hits")[0] === a), `search by exact text pages a match at a time: Next is another, Previous the first again (${Boolean(next)})`);
  }

  // The change feed (PR 2b): the driven thought's capture among the most recent, then every change from a start a page
  // of one at a time by the page's own Next, each once; a start the core cannot read is a 400 in words.
  const changes = await get("/changes");
  const changeIds = (html: string) => [...html.matchAll(/data-change="([0-9a-f-]{36})"/g)].map((m) => m[1]);
  assert(changes.status === 200 && (!thoughtId || listedIds(changes.html, "changes").includes(thoughtId)) && /captured by/.test(changes.html), `the change feed lists the most recent changes, the driven thought's capture among them (${changes.status}, ${changeIds(changes.html).length})`);
  if (REQUIRE_PAGES || count > 1) {
    const walked: string[] = [];
    let path = "/changes?since=2000-01-01&limit=1";
    let pages = 0;
    let lastStatus = 200;
    while (path && pages < 60) {
      const r = await get(path);
      lastStatus = r.status;
      if (r.status !== 200) break;
      walked.push(...changeIds(r.html));
      pages++;
      path = linkOf(r.html, "next");
    }
    const recent = changeIds(changes.html);
    // Ended at its last page — no Next — and not at a page that failed (review pass 1: a big brain's walk hid one).
    assert(pages >= 2 && lastStatus === 200 && path === "" && new Set(walked).size === walked.length && (recent.length >= 50 || walked.join() === recent.join()), `…from a start, a change at a time by Next: ${pages} pages, each change once${recent.length < 50 ? ", the same changes as the most recent" : ""} (${walked.length})`);
  }
  const badSince = await get("/changes?since=not-a-time");
  assert(badSince.status === 400 && badSince.html.includes("not a time the brain reads") && badSince.html.includes('data-testid="restart"'), `a start the change feed cannot read is a 400 in words, the newest changes a link away (${badSince.status})`);
  // Next carries the page's cursor as `after`, never in `since`, which the form shows: a new filter starts again (review pass 1).
  const firstNext = linkOf((await get("/changes?since=2000-01-01&limit=1")).html, "next");
  // …and keeps the typed start beside it, so the form still shows it and a new filter after Next starts from it (review pass 2).
  assert(/[?&]after=[0-9a-f-]{36}/.test(firstNext) && !/[?&]since=[0-9a-f]{8}-/.test(firstNext) && /[?&]since=2000-01-01(&|$)/.test(firstNext), `…Next carries the cursor as after, not in since, and keeps the typed start (${firstNext.replace(/[0-9a-f-]{36}/, "<cursor>")})`);
  // A filter that matches nothing says so, and does not read as an empty brain (review pass 1).
  const none = await get("/changes?agent=no-key-has-this-name-pr2b");
  assert(none.status === 200 && none.html.includes("No change matches these filters"), `a change-feed filter matching nothing says so (${none.status})`);
  // A query-log start the core once took and Postgres did not is now the core's refusal, in words: not a 500 (review pass 1).
  const looseSince = await get("/query-log?since=1");
  assert(looseSince.status === 400 && looseSince.html.includes("not a time the brain reads"), `a query-log start of "1" is a 400 in words, not the store's 500 (${looseSince.status})`);
  const deletes = await get("/changes?action=delete");
  assert(deletes.status === 200 && !/captured by/.test(deletes.html), `…and the kinds filter keeps its kind: deletions alone list no capture (${deletes.status})`);

  // The worker queue, the proposals and the query log (PR 2b): each renders from the core, its rows or its empty words.
  const workers = await get("/workers");
  const pools = workers.html.includes('data-testid="pools"');
  assert(workers.status === 200 && (pools || (!REQUIRE_ROWS && workers.html.includes('data-testid="empty"'))), `the worker queue renders its pools${REQUIRE_ROWS ? " (--require-rows: CI queued one)" : " or says none is queued"} (${workers.status}, ${pools ? "rows" : "empty"})`);
  const proposals = await get("/proposals?status=all&limit=5");
  const proposed = proposals.html.includes('data-testid="proposals"');
  assert(proposals.status === 200 && (proposed || (!REQUIRE_ROWS && proposals.html.includes('data-testid="empty"'))), `the proposals render${REQUIRE_ROWS ? " (--require-rows: CI recorded one)" : ", or say there are none"} (${proposals.status}, ${proposed ? "rows" : "empty"})`);
  assert(/data-testid="proposals"[^>]*data-sveltekit-preload-data="off"/.test(proposals.html) || proposals.html.includes('data-testid="empty"'), "…their thought links not preloaded on hover");
  const queryLog = await get("/query-log");
  const logged = searchWord !== "" && queryLog.html.includes(`“${searchWord}”`);
  assert(queryLog.status === 200 && (!REQUIRE_PAGES || logged), `the query log renders${REQUIRE_PAGES ? ", the smoke's own exact-text search in it (CI's stack logs searches)" : ""} (${queryLog.status}${logged ? ", logged" : ""})`);

  // A wrong key posted from a tab still signed in is refused in words, and the session it came from stands (review pass 2).
  const held = cookie;
  const stray = await signIn("not-a-key");
  cookie = held;
  const still = await get("/status");
  assert(stray.status === 401 && stray.html.includes("The brain refused that access key") && still.status === 200, `a wrong key posted while signed in says it was refused (${stray.status}) and the session stands (${still.status})`);

  // The key reaches no page, no header, no script the pages load — the
  // entries SvelteKit imports inline, and every module they import in turn —
  // and none of the data a client-side navigation fetches (__data.json).
  const pages = [home, status, await get("/__data.json"), await get("/status/__data.json"), await get("/thoughts/__data.json"), browse,
    await get(searchWord ? `/search/__data.json?q=${encodeURIComponent(searchWord)}&mode=text` : "/search/__data.json"), search,
    await get("/changes/__data.json"), changes, workers, proposals, queryLog];
  const { leaked, scripts } = await keyIn(pages, WRITE_KEY);
  assert([2, 3, 4, 6, 8].every((i) => pages[i].status === 200), `the pages' navigation data answers for the session (${[2, 3, 4, 6, 8].map((i) => pages[i].status).join(", ")})`);
  // The overview sends each thought's first line, not its content: ten large thoughts made it 18.8 MB (review pass 4).
  // Held by the data's structure — each listed thought's keys — not by a word, which a thought's own text can hold
  // (review pass 6: a first line reading `content:` failed a search for the word).
  assert(listKeys(pages[2].html, "recent") === "created_at,id,line,superseded", `the overview's data lists each thought as its id, first line, time and flag alone (${listKeys(pages[2].html, "recent")})`);
  // Browse's and search's the same way (PR 2a): the fields each list shows, never a thought's content.
  assert(listKeys(pages[4].html, "thoughts") === "created_at,id,line,superseded,trust,type", `browse's data lists each thought as its id, first line, time, flag, type and trust alone (${listKeys(pages[4].html, "thoughts")})`);
  // The change feed's the same way (PR 2b): the core's fields for each change, its text one line.
  assert(listKeys(pages[8].html, "changes") === "action,at,changed,derivation,id,metadataKeys,metadataMore,present,supersedesAfter,supersedesBefore,text,thoughtId,who", `the change feed's data lists each change by its shown fields alone (${listKeys(pages[8].html, "changes")})`);
  assert(searchWord === "" || listKeys(pages[6].html, "hits") === "created_at,exact,id,line,moved,occurrences,score,superseded,trust", `search's data lists each hit by its fields alone (${searchWord === "" ? "no word to search" : listKeys(pages[6].html, "hits")})`);
  assert(!leaked && scripts.size > 2, `no page, header, navigation data or script (${scripts.size} modules) holds the key`);

  const out = await signOut();
  assert(out.status === 303 && cookie === "" && /Max-Age=0/i.test(lastSetCookie) && attributesHold(lastSetCookie), `sign-out is a POST that clears the cookie with the session's attributes (${out.status})`);
  cookie = sessionCookie;
  const again = await get("/");
  assert(toSignin(again), `…and ends the session on the server: the old cookie presented again is no session (${again.status} → ${again.location})`);
  cookie = "";

  // A sign-in over a live session replaces it: the first id is no session once the second is issued (review pass 1).
  await signIn(WRITE_KEY);
  const first = cookie;
  await signIn(WRITE_KEY);
  const second = cookie;
  cookie = first;
  const stale = await get("/");
  cookie = second;
  const fresh = await get("/");
  assert(first !== second && toSignin(stale) && fresh.status === 200, `a second sign-in ends the first session on the server (first ${stale.status}, second ${fresh.status})`);
  await signOut();
  cookie = "";

  // One key holds 20 sessions at most: 21 sign-ins with it end its first, keep its second, and leave another key's
  // session alone (session.ts MAX_PER_KEY; review pass 2: nothing held it).
  let other = "";
  if (READ_KEY) {
    await signIn(READ_KEY);
    other = cookie;
    cookie = "";
  }
  const ids: string[] = [];
  for (let i = 0; i < 21; i++) {
    await signIn(WRITE_KEY);
    ids.push(cookie);
    cookie = "";
  }
  const statusOf = async (c: string) => { cookie = c; const r = await get("/"); cookie = ""; return r.status; };
  const [oldest, next, newest] = [await statusOf(ids[0]), await statusOf(ids[1]), await statusOf(ids[20])];
  const others = other ? await statusOf(other) : 200;
  assert(oldest === 303 && next === 200 && newest === 200 && others === 200, `21 sign-ins with one key end its oldest session alone, not another key's (oldest ${oldest}, second ${next}, newest ${newest}, other key's ${other ? others : "not tried"})`);
  for (const c of [...ids.slice(1), other].filter(Boolean)) { cookie = c; await signOut(); }
  cookie = "";
}

// The read key.
if (READ_KEY) {
  const r = await signIn(READ_KEY);
  assert(r.status === 303 && cookie !== "", `the read key signs in (${r.status})`);
  const home = await get("/");
  assert(home.status === 200 && home.html.includes("read key"), `the overview renders for the read key and names its scope (${home.status})`);
  const [browse, search] = [await get("/thoughts"), await get(`/search?q=${encodeURIComponent(searchWord || "e")}&mode=text`)];
  assert(browse.status === 200 && search.status === 200, `…browses and searches by exact text (${browse.status}, ${search.status})`);
  const views = await Promise.all(["/changes", "/workers", "/proposals", "/query-log"].map(async (v) => (await get(v)).status));
  assert(views.every((st) => st === 200), `…and reads the change feed, the workers, the proposals and the query log (${views.join(", ")})`);
  const missing = await get("/thoughts/00000000-0000-0000-0000-000000000000");
  assert(missing.status === 404, `a thought the brain does not hold is a 404 (${missing.status})`);
  const out = await signOut();
  assert(out.status === 303 && cookie === "", "…and signs out");
} else {
  console.log("  ·  no --read-key: the read-key arm skipped");
}

await writesArm();
await notesArm();
finish();

/** A hidden field's value in a page's form, unescaped as a browser would post it. */
function hidden(html: string, name: string): string | undefined {
  const v = new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`).exec(html)?.[1] ?? new RegExp(`<input[^>]*value="([^"]*)"[^>]*name="${name}"`).exec(html)?.[1];
  return v?.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/**
 * A form post as a browser makes it, to a page's own action — url-encoded, or multipart as the edit page's form
 * posts (`multipart`) — its status, where it sends, its page, and the flash cookie it set, if any.
 */
async function post(path: string, fields: Record<string, string>, multipart = false) {
  const body = multipart ? Object.entries(fields).reduce((f, [k, v]) => (f.append(k, v), f), new FormData()) : new URLSearchParams(fields).toString();
  const { "content-type": _, ...noType } = FORM;
  const r = await fetch(`${BASE}${path}`, { method: "POST", redirect: "manual", headers: headers(multipart ? noType : FORM), body });
  takeCookie(r);
  const flash = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith(`${FLASH}=`)) ?? "";
  return { status: r.status, location: r.headers.get("location") ?? "", html: await r.text(), flash };
}

/**
 * The write verbs (SMD-3322). The thought is the arm's own, captured over the proxy's /mcp under the write key
 * (as CI's step captures its thoughts), so the thoughts the other arms read stay as they were.
 */
async function writesArm() {
  if (!WRITES) {
    console.log("  ·  no --writes: the write verbs' arm skipped");
    return;
  }
  const marker = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const captured = await fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": WRITE_KEY! },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "capture_thought", arguments: { content: `The operator GUI smoke edits and deletes this thought (SMD-3322, ${marker}).` } } }),
  });
  const id = /id ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(await captured.text())?.[1];
  if (!id) return bad(`the write arm's capture over /mcp gave no thought id (${captured.status})`);
  console.log(`  ·  the write arm's thought: ${id}`);

  // Only an edit's post may carry more than 64 kB (hooks.server.ts, review pass 2): signed out, a sign-in's is refused.
  const bigSignin = await post("/signin", { key: "k".repeat(70_000) });
  assert(bigSignin.status === 413 && cookie === "", `signed out, a sign-in past 64 kB is refused before it is read (${bigSignin.status})`);

  await signIn(WRITE_KEY!);
  const bigDelete = await post(`/thoughts/${id}/delete?/delete`, { pad: "p".repeat(70_000) });
  assert(bigDelete.status === 413 && (await get(`/thoughts/${id}`)).status === 200, `signed in, a post past 64 kB to any page but an edit is refused, the thought kept (${bigDelete.status})`);
  const page = await get(`/thoughts/${id}`);
  assert(page.status === 200 && page.html.includes(`href="/dashboard/thoughts/${id}/edit"`) && page.html.includes(`href="/dashboard/thoughts/${id}/delete"`), `a thought's page offers the write key Edit and Delete (${page.status})`);

  const edit = await get(`/thoughts/${id}/edit`);
  const since = hidden(edit.html, "if_unchanged_since") ?? "";
  assert(edit.status === 200 && edit.html.includes('data-testid="edit-form"') && edit.html.includes(marker) && since !== "", `its edit page holds the text and the time it was read (${edit.status}, ${since || "no time"})`);
  assert(/<form[^>]*action="\?\/save"[^>]*enctype="multipart\/form-data"[^>]*data-testid="edit-form"/.test(edit.html), "…its form posting to its own save action as multipart, so its text is not percent-encoded");
  // A browser drops one line break straight after <textarea>: the page puts one there, so a text starting with a break keeps it.
  assert(/<textarea[^>]*>\n/.test(edit.html), "…its field opening with the line break a browser drops, so the text's own first character survives");

  const empty = await post(`/thoughts/${id}/edit?/save`, { content: "  \r\n ", if_unchanged_since: since }, true);
  assert(empty.status === 400 && /data-testid="edit-error"[^>]*>[^<]*cannot be left empty/.test(empty.html), `an empty text is refused in words (${empty.status})`);
  const altered = await post(`/thoughts/${id}/edit?/save`, { content: "never saved", if_unchanged_since: "notatime" }, true);
  assert(altered.status === 400 && /data-testid="edit-error"[^>]*>[^<]*lost the time its thought was read/.test(altered.html), `…and so is a form whose time was altered to none, before the core sees it (${altered.status})`);

  // Past the 64 kB the GUI took before (review pass 1): 160 kB of text, two bytes a character, posted as the form posts it.
  const wide = "é".repeat(80_000);
  const text = `The operator GUI smoke edited this thought (SMD-3322, ${marker}).\r\nIts second line.\r\n${wide}`;
  const saved = await post(`/thoughts/${id}/edit?/save`, { content: text, if_unchanged_since: since }, true);
  assert(saved.status === 303 && saved.location === `/dashboard/thoughts/${id}`, `the write key saves an edit of 160 kB: 303 back to the thought (${saved.status} → ${saved.location})`);
  const after = await get(`/thoughts/${id}`);
  assert(after.status === 200 && after.html.includes(`edited this thought (SMD-3322, ${marker}).\nIts second line.\n${wide}`), "…which shows the new text whole, each CRLF break saved as one line break");

  // The time first read is stale now: the second save is refused, and the form keeps that time, not the one the
  // page reads afresh after the refusal, so saving again cannot overwrite the change it was just told of.
  const stale = await post(`/thoughts/${id}/edit?/save`, { content: `${text} Again.`, if_unchanged_since: since }, true);
  assert(stale.status >= 400 && /data-testid="edit-error"[^>]*>[^<]*changed after this page read it/.test(stale.html), `an edit from a stale read is refused in words (${stale.status})`);
  assert(hidden(stale.html, "if_unchanged_since") === since && stale.html.includes(" Again."), "…its form keeping the stale time it posted and the text typed");
  const kept = await get(`/thoughts/${id}`);
  assert(kept.status === 200 && kept.html.includes(`${wide}<`) && !kept.html.includes(" Again."), "…and the thought keeps the saved edit");

  if (READ_KEY) {
    const held = cookie;
    cookie = "";
    await signIn(READ_KEY);
    const asRead = await get(`/thoughts/${id}`);
    assert(asRead.status === 200 && !asRead.html.includes('data-testid="edit-link"') && !asRead.html.includes('data-testid="delete-link"'), `the read key's thought page offers no Edit and no Delete (${asRead.status})`);
    const [editPage, deletePage] = [await get(`/thoughts/${id}/edit`), await get(`/thoughts/${id}/delete`)];
    assert(editPage.status === 403 && deletePage.status === 403, `…and its edit and delete pages are 403s (${editPage.status}, ${deletePage.status})`);
    // Refused either way: the actions' own gates spare the core a call it would refuse, and the load that runs after a
    // refused action answers the page's 403 whatever the action did, so these hold the refusal, not which side made it.
    const [readEdit, readDelete] = [await post(`/thoughts/${id}/edit?/save`, { content: "never saved", if_unchanged_since: since }, true), await post(`/thoughts/${id}/delete?/delete`, {})];
    assert(readEdit.status === 403 && readDelete.status === 403, `…its posts to them refused (${readEdit.status}, ${readDelete.status})`);
    await signOut();
    cookie = held;
    const still = await get(`/thoughts/${id}`);
    assert(still.status === 200 && still.html.includes(`${wide}<`) && !still.html.includes("never saved"), "…and the thought is as the write key left it");
  } else {
    console.log("  ·  no --read-key: the write arm's read-key checks skipped");
  }

  // A text of many short lines posts larger than it is stored, a byte more a break (CRLF): 800 kB stored, 1.2 MB posted,
  // past the edit page's 1,000,000 bytes, so it is offered no form to lose an edit in (review pass 2).
  const lines = await fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": WRITE_KEY! },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "capture_thought", arguments: { content: `Many lines (SMD-3322, ${marker})${"\n.".repeat(400_000)}` } } }),
  });
  const linesId = /id ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(await lines.text())?.[1];
  if (!linesId) bad(`the write arm's many-lined capture gave no thought id (${lines.status})`);
  else {
    const tall = await get(`/thoughts/${linesId}/edit`);
    assert(tall.status === 200 && tall.html.includes('data-testid="too-large"') && !tall.html.includes('data-testid="edit-form"'), `a thought of 400,000 short lines, 800 kB stored, which a browser posts as 1.2 MB, is offered no edit form, the page saying why (${tall.status})`);
    const gone = await post(`/thoughts/${linesId}/delete?/delete`, {});
    assert(gone.status === 303, `…and is deleted (${gone.status})`);
  }

  const confirm = await get(`/thoughts/${id}/delete`);
  assert(confirm.status === 200 && confirm.html.includes('data-testid="delete-form"') && confirm.html.includes(marker), `its delete page asks first, naming the thought (${confirm.status})`);
  // A link cannot make the list say a thought was deleted: the notice comes from the delete's flash cookie alone.
  const spoofed = await get(`/thoughts?deleted=${id}`);
  assert(spoofed.status === 200 && !spoofed.html.includes('data-testid="deleted"'), "a link naming a thought as deleted makes the list say nothing");
  const deleted = await post(`/thoughts/${id}/delete?/delete`, {});
  assert(deleted.status === 303 && deleted.location === "/dashboard/thoughts" && deleted.flash === `${FLASH}=${id}`, `the write key deletes it: 303 to the list, with a flash cookie naming it (${deleted.status} → ${deleted.location})`);
  const withFlash = async () => {
    const r = await fetch(`${BASE}/thoughts`, { redirect: "manual", headers: { cookie: `${cookie}; ${deleted.flash}` } });
    // Cleared with the attributes it was set with, or the browser keeps it.
    return { status: r.status, html: await r.text(), cleared: (r.headers.getSetCookie?.() ?? []).some((c) => c.startsWith(`${FLASH}=;`) && /Max-Age=0/i.test(c) && attributesHold(c)) };
  };
  const list = await withFlash();
  assert(list.status === 200 && new RegExp(`data-testid="deleted"[^>]*>[^<]*<span[^>]*>${id}<`).test(list.html) && list.cleared, "…which says what was deleted, and clears the cookie as it does");
  const gone = await get(`/thoughts/${id}`);
  assert(gone.status === 404, `…and the thought is then a 404 (${gone.status})`);
  await signOut();
  cookie = "";
}
