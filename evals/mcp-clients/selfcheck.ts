// Proves the probe before any real client meets it, with the SDK's own client: `bun selfcheck.ts` beside a running
// `bun probe.ts`, or `LISTEN=off bun selfcheck.ts` beside one started `LISTEN=off`, whose rows say what that mode
// must do instead. The mode is this check's to name, not the probe's: a probe in the other mode fails its first row.
// Start it beside a fresh probe: it expects tool set A. Exits 1 when a row fails, and leaves the probe on tool set A
// with ttlMs 0.
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
    const state = async (): Promise<{ held: number }> => (await (await fetch(`${base}/control/state`)).json()) as { held: number };
    /** The closing frames in what a stream sent. */
    const closings = (text: string): string[] => text.split("\n\n").filter((frame) => frame.includes('"resultType":"complete"'));
    const plain = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const modernListen = { ...plain, "mcp-protocol-version": "2026-07-28", "mcp-method": "subscriptions/listen" };
    const listenBody = { jsonrpc: "2.0", id: 9, method: "subscriptions/listen", params: { notifications: { toolsListChanged: true }, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "probe-selfcheck", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} } } };
    /** A call answered with a result. Its status alone says nothing: every refusal the probe gives is a 200 too. */
    const served = async (path = "/mcp"): Promise<boolean> => {
      const r = await fetch(base + path, { method: "POST", headers: plain, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }) });
      const text = await r.text();
      return r.status === 200 && text.includes('"result"') && !text.includes('"error"');
    };
    /** What a refused request is answered, whole: the status, the error's code, the id echoed and the words. */
    const refusal = async (path: string, headers: Record<string, string>, body: unknown): Promise<string> => {
      const r = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
      const type = (r.headers.get("content-type") ?? "none").split(";")[0];
      if (type !== "application/json") {
        void r.body?.cancel();
        return `${r.status} ${type}`;
      }
      const said = (await r.json().catch(() => null)) as { id?: unknown; error?: { code?: number; message?: string } } | null;
      return `${r.status} ${said?.error?.code} id ${said?.id} ${said?.error?.message}`;
    };
    const callSaid = (path = "/mcp"): Promise<string> => refusal(path, plain, { jsonrpc: "2.0", id: 7, method: "tools/list" });
    const listenSaid = (): Promise<string> => refusal("/mcp", modernListen, listenBody);
    // The brain's words, whole (server-portable/mcp-edge.ts and mcp-server/app.ts), which the probe copies.
    const WORDS = {
      revoked: "Unauthorized: this access key has been revoked. Its history is retained; request a new key.",
      unknown: "Unauthorized: missing or invalid authentication.",
      nolisten: "Subscription limit reached: this caller holds as many listen streams as one caller may",
    };
    // The SDK's own closing frame, to hold the one written by hand to: for a number's id, and for a string's, which
    // is what Claude Code sends ("listen:0").
    const sdk: Record<string, string> = {};
    for (const id of [9, "listen:1"]) {
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
      row(got.includes("notifications/subscriptions/acknowledged") && too.includes("notifications/subscriptions/acknowledged") && got.endsWith(ends) && too.endsWith(ends) && closings(got).length === frames && closings(too).length === frames,
        `end/${way}: each held stream ${way === "reset" ? "is dropped" : "ends whole"}, ${way === "frame" ? "after one closing frame" : "with no closing frame"} (${got.slice(-40).replace(/\n/g, " ")})`);
      if (way === "frame") row(closings(got)[0] === sdk["9"] && closings(too)[0] === sdk["listen:1"] && sdk["9"] !== "" && sdk["listen:1"] !== "", `end/frame: the frame written by hand is the SDK's own, byte for byte, for a number's id and a string's (${closings(got)[0]?.length} and ${closings(too)[0]?.length} characters)`);
      row((await served()) && (await set()) !== before && (await state()).held === 0, `end/${way}: the probe serves on, the tool set changed, and it holds no stream`);
      const one = await held("listen:0");
      row((await state()).held === 1, `end/${way}: a listen made after it is held`);
      const alone = await set();
      await control(`end/${way}`);
      const last = await one.read();
      row(last.endsWith(ends) && (await set()) !== alone, `end/${way}: one stream ended alone ends the same way, and the tool set changes once`);
      const next = await held();
      await control("drop");
      row((await next.read()).endsWith("[ended]"), `end/${way}: and the SDK's own close still ends a later one`);
    }
    // Each refusal, after each way the gate ran it with. A refusal lasts what it was asked to: still there 1.5 s
    // into two seconds, gone 0.3 s after.
    for (const [how, way] of [["revoked", "clean"], ["revoked", "frame"], ["unknown", "clean"], ["nolisten", "clean"], ["nolisten", "frame"]] as const) {
      const name = `${how}/${way}/2`;
      const stream = await held("listen:1");
      const before = await set();
      await control(name);
      const began = Date.now();
      const got = await stream.read();
      const frames = closings(got);
      row(got.includes("notifications/subscriptions/acknowledged") && got.endsWith("[ended]") && frames.length === (way === "frame" ? 1 : 0) && (way !== "frame" || frames[0] === sdk["listen:1"]), `${name}: the stream held is ended first, ${way === "frame" ? "after the frame written by hand" : "with no frame"}`);
      row((await set()) !== before, `${name}: the tool set changed`);
      if (how === "nolisten") {
        const listen = await listenSaid();
        row((await served()) && (await served("/legacy")) && listen === `200 -32603 id 9 ${WORDS.nolisten}`, `${name}: a call is served, with its result, and a listen refused as at a bound (${listen})`);
      } else {
        const call = await callSaid();
        const listen = await listenSaid();
        const legacy = await callSaid("/legacy");
        row(call === `200 -32001 id 7 ${WORDS[how]}` && listen === `200 -32001 id 9 ${WORDS[how]}` && legacy === call, `${name}: a call, a listen and a call at /legacy are each answered 200 with -32001, in the brain's words whole (${call})`);
        const noted = await fetch(`${base}/mcp`, { method: "POST", headers: plain, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
        row(noted.status === 202 && (await noted.text()) === "", `${name}: a notification is answered 202 with no body (${noted.status})`);
      }
      await Bun.sleep(Math.max(0, 1500 - (Date.now() - began)));
      const during = how === "nolisten" ? await listenSaid() : await callSaid();
      row(during.startsWith(how === "nolisten" ? "200 -32603 " : "200 -32001 "), `${name}: still refused 1.5 s in (${during.slice(0, 40)})`);
      await Bun.sleep(Math.max(0, 2300 - (Date.now() - began)));
      const again = await held();
      row((await served()) && (await state()).held === 1, `${name}: after its two seconds a call is served and a listen held`);
      await control("end/clean");
      row((await again.read()).endsWith("[ended]"), `${name}: and that stream is ended in its turn`);
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
    row((await set()) !== was && (await mcp()) === 200, "LISTEN=off, end/frame: with nothing held the tool set changes and the probe serves on");
    await control("revoked/clean/1");
    const refusedOff = await said();
    row(refusedOff === "200 -32001 id 7 retry-after null application/json", `LISTEN=off, revoked/clean/1: a call is refused as a revoked caller's (${refusedOff})`);
    await Bun.sleep(1200);
    const servedOff = await said();
    row(!servedOff.startsWith("200 -32001"), `LISTEN=off, revoked/clean/1: serving again after its second (${servedOff})`);
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
