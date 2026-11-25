// Proves the probe before any real client meets it, with the SDK's own client: `bun selfcheck.ts` beside a running
// `bun probe.ts`, or `LISTEN=off bun selfcheck.ts` beside one started `LISTEN=off`, whose rows say what that mode
// must do instead. The mode is this check's to name, not the probe's: a probe in the other mode fails its first row.
// Start it beside a fresh probe: it expects tool set A. Exits 1 when a row fails, and leaves the probe on tool set A
// with ttlMs 0.
//
// What the rows for SMD-4493's controls (end, revoked, unknown, nolisten) do not hold: how long a refusal lasts
// closer than about 0.4 s, or for an N but 1 and 2; a refusal's headers, but that it carries no Retry-After; two
// controls at once, but one caller's refusal begun under another's; with no stream held, a refusal after a WAY but
// the one each is run with; and three things no reader of the probe can tell from the right ones: the tool set
// changed three times for once, a frame sent in two writes, and something put on a stream in the instant before
// it is reset. The words are the probe's copy of the brain's, copied here again. The last rows read the probe's
// log, at the path its state gives: a log this check cannot read fails them. The rows that wait on a clock have a
// quarter of a second of room or more: a machine starved of its processor fails them, as it fails the rows for an
// outage's length.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const base = process.env.BASE ?? "http://127.0.0.1:8765";
const names = async (c: Client): Promise<string> => (await c.listTools()).tools.map((t) => t.name).sort().join(",");
/** When this check began, and how many controls with a time it has sent: what the probe's log is held to at the end. */
const startedAt = new Date().toISOString();
let timed = 0;
const control = async (what: string): Promise<void> => {
  if (/\/\d+$/.test(what)) timed++;
  try {
    await fetch(`${base}/control/${what}`);
  } catch (err) {
    row(false, `control ${what}: the probe did not answer (${(err as Error).message})`);
  }
};
const negotiated = (c: Client): string | undefined => (c as unknown as { getNegotiatedProtocolVersion?: () => string }).getNegotiatedProtocolVersion?.();
const onListChanged = (c: Client, heard: () => void): void =>
  (c as unknown as { setNotificationHandler(method: string, handler: () => void): void }).setNotificationHandler("notifications/tools/list_changed", heard);
let failed = 0;
function row(ok: boolean, what: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
}
// A probe that goes away, answers nonsense or never answers ends the check with a failed row and its summary, not
// with a stack trace and no count: whatever is thrown past a row, and a check still running after three minutes.
function giveUp(err: unknown): never {
  row(false, `the check could not go on: ${err instanceof Error ? err.message : String(err)}`);
  console.log(`FAIL: ${failed} row(s)`);
  process.exit(1);
}
process.on("uncaughtException", giveUp);
process.on("unhandledRejection", giveUp);
setTimeout(() => giveUp(new Error("no end after 180 s")), 180_000).unref();
const requests = async (): Promise<number> => ((await (await fetch(`${base}/control/state`)).json()) as { requests: number }).requests;
/** Whether the probe offers a listen stream: false when it was started LISTEN=off, as the brain's server answers today. */
const listening = ((await (await fetch(`${base}/control/state`)).json()) as { listen?: boolean }).listen !== false;

const A = "probe_time";
const B = "probe_extra,probe_time";
row(listening === (process.env.LISTEN !== "off"), `the probe is in the mode this check was asked for (LISTEN ${process.env.LISTEN === "off" ? "off" : "on"}; the probe says listen ${listening})`);

// The 2025-era paths, in the client's default mode. /mcp and /legacy have no stream, so no notification can arrive;
// the client lists on every call, so it sees the change anyway. /session has a stream.
for (const [path, hears] of [["/mcp", false], ["/legacy", false], ["/session", true]] as const) {
  const client = new Client({ name: "probe-selfcheck", version: "0" });
  let changed = 0;
  onListChanged(client, () => void changed++);
  await client.connect(new StreamableHTTPClientTransport(new URL(base + path)));
  row(negotiated(client) === "2025-11-25", `${path}: the default client negotiates 2025-11-25 (${negotiated(client)})`);
  row((await names(client)) === A, `${path}: tool set A before the toggle`);
  await control("toggle");
  await Bun.sleep(300);
  row(changed > 0 === hears, `${path}: list_changed ${hears ? "heard" : "not heard"} (${changed})`);
  row((await names(client)) === B, `${path}: tool set B after the toggle`);
  await control("toggle");
  await client.close();
}

// The 2026-07-28 leg: discover, a list kept inside its ttlMs, subscriptions/listen, and the list fetched again on a notification.
await control("ttl?ms=3000");
const client = new Client({ name: "probe-selfcheck", version: "0" }, { versionNegotiation: { mode: "auto" } });
let changed = 0;
onListChanged(client, () => void changed++);
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
row(negotiated(client) === "2026-07-28", `/mcp: a negotiating client gets 2026-07-28 (${negotiated(client)})`);
row((await names(client)) === A, "/mcp 2026-07-28: tool set A");
const before = await requests();
row((await names(client)) === A && (await requests()) === before, "/mcp 2026-07-28: a second list inside ttlMs sends no request");
const sub = await client.listen({ toolsListChanged: true } as never);
const honoured = (sub.honoredFilter as { toolsListChanged?: boolean }).toolsListChanged === true;
row(honoured === listening, listening ? "/mcp 2026-07-28: subscriptions/listen honours toolsListChanged" : "/mcp 2026-07-28, LISTEN=off: subscriptions/listen honours nothing");
await control("toggle");
await Bun.sleep(400);
row(changed === (listening ? 1 : 0), listening ? `/mcp 2026-07-28: list_changed heard on the listen stream (${changed})` : `/mcp 2026-07-28, LISTEN=off: no list_changed heard (${changed})`);
row((await names(client)) === (listening ? B : A), listening ? "/mcp 2026-07-28: tool set B after the notification, inside ttlMs" : "/mcp 2026-07-28, LISTEN=off: the change is not seen inside ttlMs, nothing having said so");
await control("toggle-quiet");
row((await names(client)) === (listening ? B : A), "/mcp 2026-07-28: a quiet change is not seen inside ttlMs");
await Bun.sleep(3200);
row((await names(client)) === A, "/mcp 2026-07-28: a quiet change is seen once ttlMs has run out");
await sub.close();
await control("ttl?ms=0");
await client.close();

// A restart as a client meets it (SMD-4347): the set changed and 502 while down, serving again after; then the port closed.
{
  const mcp = (): Promise<number> =>
    fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })
      .then((r) => { void r.body?.cancel(); return r.status; }, () => 0);
  const set = async (): Promise<string> => fetch(`${base}/control/state`).then(async (r) => ((await r.json()) as { toolSet: string }).toolSet, () => "no answer");
  // What an MCP request is answered: the status, the JSON-RPC error's code and id where there is one, Retry-After,
  // and the content type, which tells the proxy's and the route's plain text from a JSON-RPC body.
  const said = async (): Promise<string> => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }) });
    const type = (r.headers.get("content-type") ?? "none").split(";")[0];
    const body = (await r.json().catch(() => null)) as { id?: unknown; error?: { code?: number } } | null;
    return `${r.status} ${body?.error?.code} id ${body?.id} retry-after ${r.headers.get("retry-after")} ${type}`;
  };
  await control("down/1");
  const down = await said();
  row(down === "502 undefined id undefined retry-after null text/plain" && (await set()) === "B", `down/1: an MCP request is answered 502 in plain text while it is down, and the tool set changed (${down})`);
  await Bun.sleep(1200);
  row((await mcp()) !== 502, "down/1: serving again after its second");
  await control("refuse/1");
  await Bun.sleep(400);
  row((await mcp()) === 0, "refuse/1: the port is closed");
  await Bun.sleep(1200);
  row((await mcp()) !== 0 && (await set()) === "A", "refuse/1: serving again after its second, back on tool set A");
  // The server back before the REST core behind it: the edge's busy answer, and the route's 500.
  await control("busy/1");
  const busy = await said();
  row(busy === "200 -32003 id 7 retry-after 2 application/json" && (await set()) === "B", `busy/1: answered as the brain's edge answers a busy registry, and the tool set changed (${busy})`);
  await Bun.sleep(1200);
  await control("fault/1");
  const fault = await said();
  row(fault === "500 undefined id undefined retry-after null text/plain", `fault/1: answered 500 in plain text, as the route's own (${fault})`);
  await Bun.sleep(1200);
  row((await mcp()) !== 500 && (await set()) === "A", "busy/1 and fault/1: serving again, back on tool set A");
  // What a held stream meets: `down` ends it as the SDK's close() does, its result frame sent; `cut` drops it with none.
  const held = async (id: unknown = 9): Promise<{ read: () => Promise<string> }> => {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "subscriptions/listen" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "subscriptions/listen", params: { notifications: { toolsListChanged: true }, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "probe-selfcheck", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} } } }),
    });
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    return {
      // Everything the stream sends until it ends, however it ends, or 3 s.
      read: async () => {
        let text = "";
        const deadline = Bun.sleep(3000).then(() => "deadline" as const);
        for (;;) {
          const next = await Promise.race([reader.read().then((x) => x, () => "dropped" as const), deadline]);
          if (next === "deadline") return `${text} [still open]`;
          if (next === "dropped") return `${text} [dropped]`;
          if (next.done) return `${text} [ended]`;
          text += decoder.decode(next.value);
        }
      },
    };
  };
  // What the rows for SMD-4493 read, in both modes.
  const state = async (): Promise<{ held: number; noListen?: boolean }> => (await (await fetch(`${base}/control/state`)).json()) as { held: number; noListen?: boolean };
  type Asked = { headers: Record<string, string>; body: { id?: unknown } & Record<string, unknown> };
  const plain = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "probe-selfcheck", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} };
  /**
   * A 2026-07-28 request in the shape Claude Code 2.1.331 sent it to the probe (docs/mcp-client-refresh.md, its last
   * section): its user-agent and protocol headers, the envelope in its params, and its ids below, a number for a
   * tools/list and a tools/call, a string for a server/discover and a listen.
   */
  const modern = (method: string, id: string | number, params: Record<string, unknown> = {}, name?: string): Asked => ({
    headers: { ...plain, "user-agent": "claude-code/2.1.331 (sdk-cli)", "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...(name ? { "mcp-name": name } : {}) },
    body: { jsonrpc: "2.0", id, method, params: { ...params, _meta: META } },
  });
  const DISCOVER = modern("server/discover", "server-discover-probe-1");
  const LIST = modern("tools/list", 0);
  const CALL = modern("tools/call", 2, { name: "probe_time", arguments: {} }, "probe_time");
  // A stream the client opens again is asked for as `listen:1` and on; its first is `listen:0`.
  const LISTEN_AGAIN = modern("subscriptions/listen", "listen:1", { notifications: { toolsListChanged: true } });
  const bare: Asked = { headers: plain, body: { jsonrpc: "2.0", id: 7, method: "tools/list" } };
  const post = (path: string, what: Asked): Promise<Response> => fetch(base + path, { method: "POST", headers: what.headers, body: JSON.stringify(what.body) });
  /** A request answered with a result, and no tool's error in it. Its status alone says nothing: every refusal the probe gives is a 200 too. */
  const served = async (path = "/mcp", what: Asked = bare): Promise<boolean> => {
    const r = await post(path, what);
    const text = await r.text();
    tally(text);
    return r.status === 200 && text.includes('"result"') && !text.includes('"error"') && !text.includes('"isError":true');
  };
  /** A value's JSON with each object's members in one order, so that two bodies are compared whole, in whatever order theirs came. */
  const canon = (value: unknown): string => JSON.stringify(value, (_key, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
  /** What a request is answered: its status, a Retry-After where it carries one, and its body whole, or its content type where the body is no JSON. */
  const answered = async (path: string, what: Asked): Promise<string> => {
    const r = await post(path, what);
    const type = (r.headers.get("content-type") ?? "none").split(";")[0];
    const retry = r.headers.get("retry-after");
    const status = `${r.status}${retry === null ? "" : ` retry-after ${retry}`}`;
    if (type !== "application/json") {
      void r.body?.cancel();
      return `${status} ${type}`;
    }
    const text = await r.text();
    tally(text);
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // No JSON: compared as null.
    }
    return `${status} ${canon(body)}`;
  };
  /** What the probe is to answer a request it refuses: the refusal whole, the request's own id in it and no member more. */
  const refused = (what: Asked, code: number, message: string): string => `200 ${canon({ jsonrpc: "2.0", error: { code, message }, id: what.body.id })}`;
  /** The tools a 2026-07-28 tools/list names: what the probe serves, to hold what its state says of the tool set to. */
  const listed = async (): Promise<string> => {
    const r = await post("/mcp", LIST);
    const body = (await r.json().catch(() => null)) as { result?: { tools?: { name: string }[] } } | null;
    return (body?.result?.tools ?? []).map((t) => t.name).sort().join(",");
  };
  const agrees = async (): Promise<boolean> => (await listed()) === ((await set()) === "B" ? B : A);
  // The words the probe copies from the brain (server-portable/mcp-edge.ts, mcp-server/app.ts), copied here again:
  // these rows hold the probe to this text, and nothing holds either copy to the brain's.
  const WORDS = {
    revoked: "Unauthorized: this access key has been revoked. Its history is retained; request a new key.",
    unknown: "Unauthorized: missing or invalid authentication.",
    nolisten: "Subscription limit reached: this caller holds as many listen streams as one caller may",
  };
  /** How many answers this check has met in each refusal's words, a notification's 202 with them: what the log is held to. */
  const seen = { revoked: 0, unknown: 0, listen: 0 };
  function tally(text: string): void {
    if (text.includes(WORDS.revoked)) seen.revoked++;
    else if (text.includes(WORDS.unknown)) seen.unknown++;
    else if (text.includes(WORDS.nolisten)) seen.listen++;
  }
  /** What a notification is answered under a caller's refusal: its status, a Retry-After if it has one, and its body. */
  const note = async (path: string, how: "revoked" | "unknown"): Promise<string> => {
    const r = await fetch(base + path, { method: "POST", headers: plain, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    const text = await r.text();
    if (r.status === 202) seen[how]++;
    else tally(text);
    return `${r.status}${r.headers.get("retry-after") === null ? "" : " retry-after"} ${JSON.stringify(text)}`;
  };
  /**
   * Everything asked under a caller's refusal, together, so that the clock is not spent: a bare tools/list at the
   * three paths, a server/discover, a tools/list, a tools/call and a listen in the client's shape, and a
   * notification at the three paths. Says what was answered wrongly, or nothing.
   */
  const underRefusal = async (how: "revoked" | "unknown"): Promise<string> => {
    const asks = [bare, DISCOVER, LIST, CALL, LISTEN_AGAIN];
    const paths = ["/mcp", "/legacy", "/session"];
    const [legacy, session, ...rest] = await Promise.all([answered("/legacy", bare), answered("/session", bare), ...paths.map((at) => note(at, how)), ...asks.map((what) => answered("/mcp", what))]);
    const notes = rest.slice(0, 3);
    const answers = rest.slice(3);
    const want = refused(bare, -32001, WORDS[how]);
    const wrong = answers.findIndex((said, i) => said !== refused(asks[i], -32001, WORDS[how]));
    if (wrong !== -1) return `at /mcp: ${answers[wrong]}`;
    if (legacy !== want) return `at /legacy: ${legacy}`;
    if (session !== want) return `at /session: ${session}`;
    const bad = notes.findIndex((said) => said !== '202 ""');
    return bad === -1 ? "" : `a notification at ${paths[bad]}: ${notes[bad]}`;
  };
  /** What /session answers a bare tools/list that names no session, while the probe serves: an error of the transport's own. */
  const atSession = await answered("/session", bare);
  /**
   * Whether a listen is answered as the mode answers one while the probe serves: held, where it offers a stream, and
   * acknowledged honouring nothing and ended where it offers none. A stream held is ended again, which changes the
   * tool set once more.
   */
  const listens = async (): Promise<boolean> => {
    const stream = await held("listen:0");
    if (!listening) {
      const text = await stream.read();
      return text.includes('"notifications":{}') && text.endsWith("[ended]");
    }
    const one = (await state()).held === 1;
    await control("end/clean");
    return (await stream.read()).endsWith("[ended]") && one;
  };
  if (listening) {
    const graceful = await held();
    await control("down/1");
    const ended = await graceful.read();
    row(ended.includes("notifications/subscriptions/acknowledged") && ended.includes('"resultType":"complete"') && ended.endsWith("[ended]"), `down/1: a held stream is ended with its result frame (${ended.slice(-60).replace(/\n/g, " ")})`);
    await Bun.sleep(1200);
    const abrupt = await held();
    await control("cut/1");
    const cut = await abrupt.read();
    row(cut.includes("notifications/subscriptions/acknowledged") && !cut.includes('"resultType":"complete"') && !cut.endsWith("[still open]"), `cut/1: a held stream is dropped with no result frame (${cut.slice(-40).replace(/\n/g, " ")})`);
    // The probe closes its port for an instant as it drops its connections, and a connection made then is refused:
    // the port is asked until it answers, for a quarter of a second.
    let refusals = 0;
    let first = await mcp();
    for (const until = Date.now() + 250; first === 0 && Date.now() < until; first = await mcp()) {
      refusals++;
      await Bun.sleep(5);
    }
    row(first === 502, `cut/1: the port answers 502 within a quarter of a second of the drop (${first}, after ${refusals} refused)`);
    await Bun.sleep(1200);
    row((await mcp()) !== 502 && (await set()) === "A", "down/1 and cut/1: serving again, back on tool set A");
    // The other three controls end a held stream as `down` does, before they answer as they do.
    for (const how of ["busy", "fault", "refuse"]) {
      const stream = await held();
      await control(`${how}/1`);
      const said = await stream.read();
      row(said.includes('"resultType":"complete"') && said.endsWith("[ended]"), `${how}/1: a held stream is ended with its result frame (${said.slice(-24).replace(/\n/g, " ")})`);
      await Bun.sleep(1600);
    }
    // Three more changes of the tool set: one more puts it back on A for what follows.
    await control("toggle-quiet");
    // The server ending one stream of its own accord, and serving on (SMD-4493): three ways, and what follows each.
    /** A stream's text as it was sent: the word read() adds taken off. */
    const sent = (text: string): string => text.replace(/ \[(ended|dropped|still open)\]$/, "");
    const framesOf = (text: string): string[] => sent(text).split("\n\n").filter((frame) => frame !== "");
    const closings = (text: string): string[] => framesOf(text).filter((frame) => frame.includes('"resultType":"complete"'));
    /** Whether a frame is the acknowledgement of a listen that asked for the tool list's changes, honouring that. */
    const acknowledges = (frame: string): boolean => {
      try {
        const m = JSON.parse(frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? "") as { method?: string; params?: { notifications?: { toolsListChanged?: boolean } } };
        return m.method === "notifications/subscriptions/acknowledged" && m.params?.notifications?.toolsListChanged === true;
      } catch {
        return false;
      }
    };
    /**
     * Whether nothing was announced on a stream: its acknowledgement first, no frame more besides its closing ones,
     * and each frame followed by one blank line and nothing else.
     */
    const quiet = (text: string): boolean => {
      const frames = framesOf(text);
      const rest = frames.filter((frame) => !frame.includes('"resultType":"complete"'));
      return rest.length === 1 && frames[0] === rest[0] && acknowledges(rest[0]) && sent(text) === frames.map((frame) => `${frame}\n\n`).join("");
    };
    // The requests of 2026-07-28 above are in a shape the probe serves: held here before any row leans on them.
    row((await served("/mcp", DISCOVER)) && (await served("/mcp", LIST)) && (await served("/mcp", CALL)) && (await agrees()), "/mcp 2026-07-28: a server/discover, a tools/list and a tools/call in the client's shape are each served with a result, and the list names the tool set the probe says it is on");
    // The SDK's own closing frame, to hold the one written by hand to: for a number's id, and for the two strings
    // Claude Code sends, its first listen's and a later one's.
    const sdk: Record<string, string> = {};
    for (const id of [9, "listen:1", "listen:0"]) {
      const own = await held(id);
      await control("drop");
      const frames = closings(await own.read());
      sdk[String(id)] = frames[0] ?? "";
      row(frames.length === 1, `drop: the SDK's own closing frame is read, once, for the id ${JSON.stringify(id)}`);
    }
    for (const [way, ends] of [["clean", "[ended]"], ["reset", "[dropped]"], ["frame", "[ended]"]] as const) {
      const stream = await held(9);
      const other = await held("listen:1");
      row((await state()).held === 2, `end/${way}: the probe holds the two streams opened (${(await state()).held})`);
      const before = await set();
      await control(`end/${way}`);
      const got = await stream.read();
      const too = await other.read();
      const want = way === "frame" ? 1 : 0;
      // `reset` is held as the reader's error, which a body cut short gives too; a reset at TCP was seen by hand.
      row(got.endsWith(ends) && too.endsWith(ends) && closings(got).length === want && closings(too).length === want,
        `end/${way}: each held stream ${way === "reset" ? "is dropped" : "ends whole"}, ${way === "frame" ? "after one closing frame" : "with no closing frame"} (${got.slice(-30).replace(/\n/g, " ")} | ${too.slice(-30).replace(/\n/g, " ")})`);
      row(quiet(got) && quiet(too), `end/${way}: nothing was announced on either stream: its acknowledgement, and no frame more${way === "frame" ? " but the closing one" : ""}`);
      if (way === "frame") row(framesOf(got).at(-1) === sdk["9"] && framesOf(too).at(-1) === sdk["listen:1"], `end/frame: the frame written by hand is the SDK's own, byte for byte, and the last thing sent, for a number's id and a string's (${closings(got)[0]?.length} and ${closings(too)[0]?.length} characters)`);
      row((await served()) && (await served("/mcp", CALL)) && (await set()) !== before && (await agrees()) && (await state()).held === 0, `end/${way}: the probe serves on, a bare tools/list and a tools/call of 2026-07-28, its tool set changed in what it lists too, and it holds no stream`);
      const one = await held("listen:0");
      row((await state()).held === 1, `end/${way}: a listen made after it is held`);
      const alone = await set();
      await control(`end/${way}`);
      const last = await one.read();
      row(last.endsWith(ends) && quiet(last) && closings(last).length === want && (way !== "frame" || framesOf(last).at(-1) === sdk["listen:0"]) && (await set()) !== alone && (await agrees()), `end/${way}: one stream ended alone ends the same way, frame for frame, and the tool set is the other one`);
      const next = await held();
      await control("drop");
      row(closings(await next.read()).length === 1, `end/${way}: and the SDK's own close still ends a later one, with its frame`);
    }
    // Each refusal after each way, the five pairs the gate ran among the nine. A refusal lasts about what it was
    // asked to: still there 1.5 s into two seconds, gone 0.3 s after. What is asked under it goes together, so that
    // the clock is not spent.
    for (const how of ["revoked", "unknown", "nolisten"] as const) for (const [way, ends] of [["clean", "[ended]"], ["reset", "[dropped]"], ["frame", "[ended]"]] as const) {
      const name = `${how}/${way}/2`;
      const stream = await held("listen:0");
      const before = await set();
      await control(name);
      const began = Date.now();
      const told = await state();
      const got = await stream.read();
      row(got.endsWith(ends) && quiet(got) && closings(got).length === (way === "frame" ? 1 : 0) && (way !== "frame" || framesOf(got).at(-1) === sdk["listen:0"]), `${name}: the stream held is ${way === "reset" ? "dropped" : "ended"}, ${way === "frame" ? "after the frame written by hand" : "with no frame"}, and nothing announced on it (${got.slice(-30).replace(/\n/g, " ")})`);
      if (how === "nolisten") {
        const [atMcp, atLegacy, session, discover, list, call, listen] = await Promise.all([served(), served("/legacy"), answered("/session", bare), served("/mcp", DISCOVER), served("/mcp", LIST), served("/mcp", CALL), answered("/mcp", LISTEN_AGAIN)]);
        row(atMcp && atLegacy && session === atSession && discover && list && call, `${name}: every other request is answered as with no refusal: a bare tools/list at /mcp and at /legacy with its result, at /session what it is answered at any time, and a server/discover, a tools/list and a tools/call in the client's shape with theirs (bare ${atMcp}, /legacy ${atLegacy}, /session ${session === atSession}, discover ${discover}, list ${list}, call ${call})`);
        row(listen === refused(LISTEN_AGAIN, -32603, WORDS.nolisten) && told.noListen === true, `${name}: a listen is refused as at a bound, the refusal whole and its id the listen's, and the probe's state said so (${listen}; state ${told.noListen})`);
        row((await set()) !== before && (await agrees()), `${name}: the tool set changed, in what the probe lists too`);
      } else {
        const wrong = await underRefusal(how);
        row(wrong === "", `${name}: each request is refused whole, 200 with -32001, its own id, no Retry-After, and the words copied from the brain's: a bare tools/list at /mcp, at /legacy and at /session, and a server/discover, a tools/list, a tools/call and a listen in the client's shape; and a notification is answered 202 with no body at each of the three (${wrong || "each as it should be"})`);
        row((await set()) !== before, `${name}: the probe says its tool set changed`);
      }
      await Bun.sleep(Math.max(0, 1500 - (Date.now() - began)));
      const [during, callDuring, bareDuring] = await Promise.all([answered("/mcp", LISTEN_AGAIN), how === "nolisten" ? served("/mcp", CALL).then(String) : answered("/mcp", CALL), how === "nolisten" ? served().then(String) : answered("/mcp", bare)]);
      const wants = [refused(LISTEN_AGAIN, how === "nolisten" ? -32603 : -32001, WORDS[how]), how === "nolisten" ? "true" : refused(CALL, -32001, WORDS[how]), how === "nolisten" ? "true" : refused(bare, -32001, WORDS[how])];
      const late = [during, callDuring, bareDuring];
      const off = late.findIndex((said, i) => said !== wants[i]);
      row(off === -1, `${name}: 1.5 s in a listen is still refused, whole, and a tools/call and a bare tools/list still ${how === "nolisten" ? "served" : "refused"} (${["the listen", "the call", "the bare list"][Math.max(off, 0)]}: ${late[Math.max(off, 0)].slice(0, 80)})`);
      await Bun.sleep(Math.max(0, 2300 - (Date.now() - began)));
      const again = await held("listen:0");
      const after = await state();
      row((await served()) && (await served("/mcp", CALL)) && (await set()) !== before && (await agrees()) && after.held === 1 && after.noListen === false, `${name}: after its two seconds requests are served, the list names the changed tool set, and a listen is held`);
      await control("end/clean");
      const last = await again.read();
      row(last.endsWith("[ended]") && quiet(last), `${name}: and that stream, acknowledged, is ended in its turn`);
    }
  } else {
    const off = await held();
    const answer = await off.read();
    row(answer.includes('"notifications":{}') && answer.endsWith("[ended]"), `LISTEN=off: a listen is acknowledged honouring nothing, and ended (${answer.slice(0, 120).replace(/\n/g, " ")})`);
    const before = await set();
    await control("cut/1");
    await Bun.sleep(300);
    row((await mcp()) === 502 && (await set()) !== before, "LISTEN=off, cut/1: the port answers 502 after the drop, and the tool set changed");
    await Bun.sleep(1000);
    row((await mcp()) !== 502, "LISTEN=off, cut/1: serving again after its second");
  }
  // The controls of SMD-4493 with no stream to end, in either mode: the tool set still changes, each refusal still
  // refuses, for the second it was given, and a listen made after is answered as the mode answers one.
  {
    const where = listening ? "nothing held" : "LISTEN=off";
    const answer = listening ? "held" : "acknowledged honouring nothing";
    row((await state()).held === 0, `${where}: the probe holds no stream (${(await state()).held})`);
    for (const way of ["clean", "reset", "frame"] as const) {
      const was = await set();
      await control(`end/${way}`);
      row((await set()) !== was && (await agrees()) && (await served()) && (await served("/mcp", CALL)) && (await listens()), `${where}, end/${way}: the tool set changes, in what is listed too, and the probe serves on: each request with its result, and a listen ${answer}`);
    }
    for (const [how, way] of [["revoked", "reset"], ["unknown", "frame"]] as const) {
      const name = `${where}, ${how}/${way}/1`;
      const was = await set();
      await control(`${how}/${way}/1`);
      const began = Date.now();
      const wrong = await underRefusal(how);
      row(wrong === "" && (await set()) !== was, `${name}: each request is refused whole, at the three paths, a listen and a notification among them, and the tool set changed (${wrong || "each as it should be"})`);
      await Bun.sleep(Math.max(0, 600 - (Date.now() - began)));
      const mid = await answered("/mcp", LIST);
      row(mid === refused(LIST, -32001, WORDS[how]), `${name}: 0.6 s in a request is still refused (${mid})`);
      await Bun.sleep(Math.max(0, 1250 - (Date.now() - began)));
      row((await served()) && (await served("/mcp", CALL)) && (await set()) !== was && (await agrees()) && (await listens()), `${name}: serving again after its second: each request with its result, the tool set still the changed one, and a listen ${answer}`);
    }
    {
      const was = await set();
      await control("nolisten/clean/1");
      const began = Date.now();
      const [listen, call] = await Promise.all([answered("/mcp", LISTEN_AGAIN), served("/mcp", CALL)]);
      row(listen === refused(LISTEN_AGAIN, -32603, WORDS.nolisten) && call && (await set()) !== was, `${where}, nolisten/clean/1: a listen is refused as at a bound, a tools/call served, and the tool set changed (${listen}; the call ${call})`);
      await Bun.sleep(Math.max(0, 600 - (Date.now() - began)));
      const mid = await answered("/mcp", LISTEN_AGAIN);
      row(mid === refused(LISTEN_AGAIN, -32603, WORDS.nolisten), `${where}, nolisten/clean/1: 0.6 s in a listen is still refused (${mid})`);
      await Bun.sleep(Math.max(0, 1250 - (Date.now() - began)));
      row(await listens(), `${where}, nolisten/clean/1: after its second a listen is ${answer} again`);
    }
    // A caller's refusal begun while another's runs replaces it, its time with it: the second is the longer here.
    {
      await control("revoked/clean/1");
      await control("unknown/clean/2");
      const began = Date.now();
      const want = refused(LIST, -32001, WORDS.unknown);
      const under = await answered("/mcp", LIST);
      await Bun.sleep(Math.max(0, 1500 - (Date.now() - began)));
      const late = await answered("/mcp", LIST);
      await Bun.sleep(Math.max(0, 2300 - (Date.now() - began)));
      row(under === want && late === want && (await served("/mcp", LIST)), `${where}, unknown/clean/2 begun under revoked/clean/1: the second refusal replaces the first, in its words and for its own time, still there 1.5 s in and gone after its two seconds (${under !== want ? under : late})`);
    }
    // The seconds a refusal may be given: outside them nothing is done, to a stream held or to anything else.
    {
      const stream = listening ? await held("listen:0") : undefined;
      const was = await set();
      const statuses: number[] = [];
      for (const what of ["revoked/clean/0", "revoked/clean/601", "nolisten/clean/0", "nolisten/clean/601"]) {
        const r = await fetch(`${base}/control/${what}`);
        void r.body?.cancel();
        statuses.push(r.status);
      }
      const holds = (await state()).held;
      const untouched = statuses.every((status) => status === 400) && (await set()) === was && holds === (stream ? 1 : 0) && (await served());
      if (stream) {
        await control("end/clean");
        await stream.read();
      }
      row(untouched && (await listens()), `${where}: a refusal asked for 0 seconds or for 601, a caller's or a listen's, is answered 400, and nothing is changed, ended or refused (${statuses.join(", ")}; ${holds} held)`);
    }
  }
  // An outage lasts what it was asked to, in either mode: still away most of the way through, serving after.
  for (const [how, away] of [["down", "502 "], ["busy", "200 -32003 "], ["fault", "500 "]] as const) {
    await control(`${how}/2`);
    await Bun.sleep(1500);
    const during = await said();
    row(during.startsWith(away), `${how}/2: still away 1.5 s in (${during})`);
    await Bun.sleep(800);
    const after = await said();
    row(!after.startsWith(away), `${how}/2: serving again after its two seconds (${after})`);
  }
  // The probe's log is the record of a measurement: what this check's own requests and controls left in it, on the
  // lines of this probe's port. Each answer the check met as a refusal is marked as that refusal's, and no other
  // answer is; and each control with a time has its serving-again, written as that time ends.
  {
    const path = ((await (await fetch(`${base}/control/state`)).json()) as { log?: string }).log;
    type Line = { at?: string; port?: number; event?: string; away?: string; refused?: string; seconds?: number };
    const text = path ? await Bun.file(path).text().catch(() => "") : "";
    const lines = text.split("\n").flatMap((line): Line[] => {
      try {
        return [JSON.parse(line) as Line];
      } catch {
        return [];
      }
    }).filter((line) => line.port === Number(new URL(base).port) && (line.at ?? "") >= startedAt);
    const answers = lines.filter((line) => line.event === "response");
    const n = { revoked: answers.filter((line) => line.away === "revoked").length, unknown: answers.filter((line) => line.away === "unknown").length, listen: answers.filter((line) => line.refused === "listen").length };
    // The counts differ between the two callers' refusals, or marks swapped between them would pass.
    row(n.revoked === seen.revoked && n.unknown === seen.unknown && n.listen === seen.listen && seen.revoked > 0 && seen.unknown > 0 && seen.listen > 0 && seen.revoked !== seen.unknown,
      `the log marks each answer this check met as a refusal, and no other: away revoked ${n.revoked} for ${seen.revoked} met, away unknown ${n.unknown} for ${seen.unknown}, a listen refused ${n.listen} for ${seen.listen} (${path ?? "the probe names no log"})`);
    const due = lines.filter((line) => typeof line.seconds === "number" && line.seconds > 0).map((line) => Date.parse(line.at ?? "") + (line.seconds ?? 0) * 1000);
    const again = lines.filter((line) => line.event === "serving-again").map((line) => Date.parse(line.at ?? ""));
    const none = due.filter((when) => {
      const i = again.findIndex((at) => at >= when - 50 && at <= when + 600);
      if (i !== -1) again.splice(i, 1);
      return i === -1;
    });
    row(due.length === timed && none.length === 0 && again.length === 0, `the log has one serving-again for each control with a time, written as that time ends (${due.length} such controls in the log for ${timed} sent; ${none.length} with none in time; ${again.length} beside)`);
  }
  // However many changes of the tool set that was, the check ends on A.
  if ((await set()) !== "A") await control("toggle-quiet");
  row((await set()) === "A", "left on tool set A");
}

console.log(failed === 0 ? "PASS" : `FAIL: ${failed} row(s)`);
process.exit(failed === 0 ? 0 : 1);
