// Proves the probe before any real client meets it, with the SDK's own client: `bun selfcheck.ts` beside a running
// `bun probe.ts`, or `LISTEN=off bun selfcheck.ts` beside one started `LISTEN=off`, whose rows say what that mode
// must do instead. The mode is this check's to name, not the probe's: a probe in the other mode fails its first row.
// Start it beside a fresh probe: it expects tool set A. Exits 1 when a row fails, and leaves the probe on tool set A
// with ttlMs 0.
//
// What the rows for SMD-4493's controls (end, revoked, unknown, nolisten) do not hold, by a second reader's mutants:
// a refusal at /session, and a notification's at /legacy; how long a refusal lasts closer than about half a second,
// or for an N but 2 (1 with no stream); a WAY with a refusal other than the five pairs run; a refusal's headers; an
// id of 0; a second refusal begun while one runs; the bound on N; the tool set changing three times for once; and
// the log's `away`, `refused` and `serving-again`. The words are the probe's copy of the brain's, copied here again.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const base = process.env.BASE ?? "http://127.0.0.1:8765";
const names = async (c: Client): Promise<string> => (await c.listTools()).tools.map((t) => t.name).sort().join(",");
const control = async (what: string): Promise<void> => {
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
  const plain = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "probe-selfcheck", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} };
  /** A 2026-07-28 request as Claude Code sends one: its headers, a string for its id, the envelope in its params. */
  const modern = (method: string, id: string, params: Record<string, unknown> = {}, name?: string): { headers: Record<string, string>; body: unknown } => ({
    headers: { ...plain, "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...(name ? { "mcp-name": name } : {}) },
    body: { jsonrpc: "2.0", id, method, params: { ...params, _meta: META } },
  });
  const LIST = modern("tools/list", "list:1");
  const CALL = modern("tools/call", "call:1", { name: "probe_time", arguments: {} }, "probe_time");
  const LISTEN_AGAIN = modern("subscriptions/listen", "listen:0", { notifications: { toolsListChanged: true } });
  const bare = { headers: plain, body: { jsonrpc: "2.0", id: 7, method: "tools/list" } };
  /** A request answered with a result. Its status alone says nothing: every refusal the probe gives is a 200 too. */
  const served = async (path = "/mcp", what: { headers: Record<string, string>; body: unknown } = bare): Promise<boolean> => {
    const r = await fetch(base + path, { method: "POST", headers: what.headers, body: JSON.stringify(what.body) });
    const text = await r.text();
    return r.status === 200 && text.includes('"result"') && !text.includes('"error"');
  };
  /** What a refused request is answered, whole: the status, the error's code, the id as it came back and the words. */
  const refusal = async (path: string, what: { headers: Record<string, string>; body: unknown }): Promise<string> => {
    const r = await fetch(base + path, { method: "POST", headers: what.headers, body: JSON.stringify(what.body) });
    const type = (r.headers.get("content-type") ?? "none").split(";")[0];
    if (type !== "application/json") {
      void r.body?.cancel();
      return `${r.status} ${type}`;
    }
    const answer = (await r.json().catch(() => null)) as { jsonrpc?: unknown; id?: unknown; error?: { code?: number; message?: string } } | null;
    return `${r.status} ${answer?.jsonrpc} ${answer?.error?.code} id ${JSON.stringify(answer?.id)} ${answer?.error?.message}`;
  };
  // The words the probe copies from the brain (server-portable/mcp-edge.ts, mcp-server/app.ts), copied here again:
  // these rows hold the probe to this text, and nothing holds either copy to the brain's.
  const WORDS = {
    revoked: "Unauthorized: this access key has been revoked. Its history is retained; request a new key.",
    unknown: "Unauthorized: missing or invalid authentication.",
    nolisten: "Subscription limit reached: this caller holds as many listen streams as one caller may",
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
    row((await mcp()) === 502, "cut/1: the port answers 502 at once after the drop");
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
    /** A stream's frames as they were sent: what the blank lines part, the word read() adds taken off. */
    const framesOf = (text: string): string[] => text.replace(/ \[(ended|dropped|still open)\]$/, "").split("\n\n").filter((frame) => frame !== "");
    const closings = (text: string): string[] => framesOf(text).filter((frame) => frame.includes('"resultType":"complete"'));
    /** Whether a stream carried its acknowledgement and no more besides its closing frames: nothing was announced on it. */
    const quiet = (text: string): boolean => {
      const rest = framesOf(text).filter((frame) => !frame.includes('"resultType":"complete"'));
      return rest.length === 1 && rest[0].includes("notifications/subscriptions/acknowledged");
    };
    // The requests of 2026-07-28 above are in the shape the probe serves: held here before any row leans on them.
    row((await served("/mcp", LIST)) && (await served("/mcp", CALL)), "/mcp 2026-07-28: a tools/list and a tools/call with a string's id are each served with a result");
    // The SDK's own closing frame, to hold the one written by hand to: for a number's id, and for a string's, which
    // is what Claude Code sends ("listen:0").
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
      const frames = way === "frame" ? 1 : 0;
      // `reset` is held as the reader's error, which a body cut short gives too; a reset at TCP was seen by hand.
      row(got.endsWith(ends) && too.endsWith(ends) && closings(got).length === frames && closings(too).length === frames,
        `end/${way}: each held stream ${way === "reset" ? "is dropped" : "ends whole"}, ${way === "frame" ? "after one closing frame" : "with no closing frame"} (${got.slice(-40).replace(/\n/g, " ")})`);
      row(quiet(got) && quiet(too), `end/${way}: nothing was announced on either stream: its acknowledgement, and no frame more${way === "frame" ? " but the closing one" : ""}`);
      if (way === "frame") row(framesOf(got).at(-1) === sdk["9"] && framesOf(too).at(-1) === sdk["listen:1"], `end/frame: the frame written by hand is the SDK's own, byte for byte, and the last thing sent, for a number's id and a string's (${closings(got)[0]?.length} and ${closings(too)[0]?.length} characters)`);
      row((await served()) && (await served("/mcp", LIST)) && (await set()) !== before && (await state()).held === 0, `end/${way}: the probe serves on, a bare call and one of 2026-07-28, the tool set changed, and it holds no stream`);
      const one = await held("listen:0");
      row((await state()).held === 1, `end/${way}: a listen made after it is held`);
      const alone = await set();
      await control(`end/${way}`);
      const last = await one.read();
      row(last.endsWith(ends) && quiet(last) && closings(last).length === frames && (way !== "frame" || framesOf(last).at(-1) === sdk["listen:0"]) && (await set()) !== alone, `end/${way}: one stream ended alone ends the same way, frame for frame, and the tool set is the other one`);
      const next = await held();
      await control("drop");
      row((await next.read()).endsWith("[ended]"), `end/${way}: and the SDK's own close still ends a later one`);
    }
    // Each refusal, after each way the gate ran it with. A refusal lasts about what it was asked to: still there
    // 1.5 s into two seconds, gone 0.3 s after.
    for (const [how, way] of [["revoked", "clean"], ["revoked", "frame"], ["unknown", "clean"], ["nolisten", "clean"], ["nolisten", "frame"]] as const) {
      const name = `${how}/${way}/2`;
      const stream = await held("listen:1");
      const before = await set();
      await control(name);
      const began = Date.now();
      const got = await stream.read();
      const frames = closings(got);
      row(got.endsWith("[ended]") && quiet(got) && frames.length === (way === "frame" ? 1 : 0) && (way !== "frame" || framesOf(got).at(-1) === sdk["listen:1"]), `${name}: the stream held is ended first, ${way === "frame" ? "after the frame written by hand" : "with no frame"}, and nothing announced on it`);
      row((await set()) !== before, `${name}: the tool set changed`);
      if (how === "nolisten") {
        const listen = await refusal("/mcp", LISTEN_AGAIN);
        row((await served()) && (await served("/legacy")) && (await served("/mcp", LIST)) && (await served("/mcp", CALL)), `${name}: every call is served with its result: a bare one at /mcp and at /legacy, a tools/list and a tools/call of 2026-07-28`);
        row(listen === `200 2.0 -32603 id "listen:0" ${WORDS.nolisten}` && (await state()).noListen === true, `${name}: a listen is refused as at a bound, its id as the client sent it, and the probe's state says so (${listen})`);
      } else {
        const call = await refusal("/mcp", bare);
        const list = await refusal("/mcp", LIST);
        const listen = await refusal("/mcp", LISTEN_AGAIN);
        const legacy = await refusal("/legacy", bare);
        row(call === `200 2.0 -32001 id 7 ${WORDS[how]}` && legacy === call, `${name}: a bare call at /mcp and at /legacy is answered 200 with -32001, its id a number as sent, in the words copied from the brain's (${call}; ${legacy})`);
        row(list === `200 2.0 -32001 id "list:1" ${WORDS[how]}` && listen === `200 2.0 -32001 id "listen:0" ${WORDS[how]}`, `${name}: a tools/list and a listen of 2026-07-28 are answered the same, each id a string as sent (${list}; ${listen})`);
        const noted = await fetch(`${base}/mcp`, { method: "POST", headers: plain, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
        row(noted.status === 202 && (await noted.text()) === "", `${name}: a notification is answered 202 with no body (${noted.status})`);
      }
      await Bun.sleep(Math.max(0, 1500 - (Date.now() - began)));
      const during = await refusal("/mcp", LISTEN_AGAIN);
      const callDuring = how === "nolisten" ? String(await served("/mcp", LIST)) : await refusal("/mcp", LIST);
      row(during.startsWith(how === "nolisten" ? "200 2.0 -32603 " : "200 2.0 -32001 ") && (how === "nolisten" ? callDuring === "true" : callDuring.startsWith("200 2.0 -32001 ")), `${name}: 1.5 s in a listen is still refused, and a call still ${how === "nolisten" ? "served" : "refused"} (${during.slice(0, 44)})`);
      await Bun.sleep(Math.max(0, 2300 - (Date.now() - began)));
      const again = await held("listen:0");
      const after = await state();
      row((await served()) && (await served("/mcp", CALL)) && after.held === 1 && after.noListen === false, `${name}: after its two seconds calls are served and a listen held`);
      await control("end/clean");
      const ended = await again.read();
      row(ended.endsWith("[ended]") && quiet(ended), `${name}: and that stream, acknowledged, is ended in its turn`);
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
    // The new controls with no stream to end (SMD-4493): the tool set still changes, and a refusal still refuses.
    const was = await set();
    await control("end/frame");
    row((await set()) !== was && (await served()) && (await served("/mcp", LIST)), "LISTEN=off, end/frame: with nothing held the tool set changes and the probe serves on, each call with its result");
    await control("revoked/clean/1");
    const refusedOff = await refusal("/mcp", bare);
    const listedOff = await refusal("/mcp", LIST);
    row(refusedOff === `200 2.0 -32001 id 7 ${WORDS.revoked}` && listedOff === `200 2.0 -32001 id "list:1" ${WORDS.revoked}`, `LISTEN=off, revoked/clean/1: a bare call and one of 2026-07-28 are refused as a revoked caller's, in its words (${refusedOff})`);
    await Bun.sleep(1200);
    row((await served()) && (await served("/mcp", LIST)), "LISTEN=off, revoked/clean/1: serving again after its second, each call with its result");
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
  // However many changes of the tool set that was, the check ends on A.
  if ((await set()) !== "A") await control("toggle-quiet");
  row((await set()) === "A", "left on tool set A");
}

console.log(failed === 0 ? "PASS" : `FAIL: ${failed} row(s)`);
process.exit(failed === 0 ? 0 : 1);
