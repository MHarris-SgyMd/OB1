// Proves the probe before any real client meets it, with the SDK's own client: `bun selfcheck.ts` beside a running
// `bun probe.ts`. Exits 1 when a row fails. It leaves the probe on tool set A with ttlMs 0.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const base = process.env.BASE ?? "http://127.0.0.1:8765";
const names = async (c: Client): Promise<string> => (await c.listTools()).tools.map((t) => t.name).sort().join(",");
const control = async (what: string): Promise<void> => void (await fetch(`${base}/control/${what}`));
const negotiated = (c: Client): string | undefined => (c as unknown as { getNegotiatedProtocolVersion?: () => string }).getNegotiatedProtocolVersion?.();
const onListChanged = (c: Client, heard: () => void): void =>
  (c as unknown as { setNotificationHandler(method: string, handler: () => void): void }).setNotificationHandler("notifications/tools/list_changed", heard);
const requests = async (): Promise<number> => ((await (await fetch(`${base}/control/state`)).json()) as { requests: number }).requests;

let failed = 0;
const row = (ok: boolean, what: string): void => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};
const A = "probe_time";
const B = "probe_extra,probe_time";

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
row((sub.honoredFilter as { toolsListChanged?: boolean }).toolsListChanged === true, "/mcp 2026-07-28: subscriptions/listen honours toolsListChanged");
await control("toggle");
await Bun.sleep(400);
row(changed === 1, `/mcp 2026-07-28: list_changed heard on the listen stream (${changed})`);
row((await names(client)) === B, "/mcp 2026-07-28: tool set B after the notification, inside ttlMs");
await control("toggle-quiet");
row((await names(client)) === B, "/mcp 2026-07-28: a quiet change is not seen inside ttlMs");
await Bun.sleep(3200);
row((await names(client)) === A, "/mcp 2026-07-28: a quiet change is seen once ttlMs has run out");
await sub.close();
await control("ttl?ms=0");
await client.close();

console.log(failed === 0 ? "PASS" : `FAIL: ${failed} row(s)`);
process.exit(failed === 0 ? 0 : 1);
