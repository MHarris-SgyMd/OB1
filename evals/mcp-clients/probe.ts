// A scratch MCP server (SMD-4344): it records which revision a client offers and what makes it list tools again.
// docs/mcp-client-refresh.md holds what was measured with it. Not the brain's server, and it has no auth: it binds
// to loopback, serves two dummy tools and holds nothing.
//
//   bun install && bun probe.ts        serve on 127.0.0.1:$PORT (default 8765), log to $LOG (default ./probe.jsonl)
//   bun selfcheck.ts                   prove it with the SDK's own client
//   ./run-claude-code.sh mcp toggle    one headless Claude Code session against it, the change made inside one turn
//   ./run-claude-code-turns.sh mcp toggle-quiet   the same over two turns, the change made between them
//   ./run-claude-code.sh mcp down/20 45           a restart 20 s long, the session waiting 45 s
//   An interactive session is run by hand: `claude --strict-mcp-config --setting-sources project --mcp-config
//   {"mcpServers":{"probe":{"type":"http","url":"http://127.0.0.1:8765/mcp"}}}`, a prompt that calls probe_time, the
//   control step from another terminal, /mcp, and a second prompt. A script that types into a real session is not
//   kept here: it cannot be made to read every dialog before it presses Enter.
//
//   /mcp        both eras: 2026-07-28 through createMcpHandler, 2025-era stateless
//   /legacy     2025-era only, stateless, POST only: the brain's wiring today
//   /session    2025-era only, with sessions and a GET stream
//
//   /control/toggle        add or remove the tool `probe_extra`, and notify: listen streams and open sessions
//   /control/toggle-quiet  change the tool set and tell nobody
//   /control/drop          end every open listen stream, with its closing frame, and change the tool set, the server staying up
//   /control/down/N        a restart behind a proxy (SMD-4347): the streams ended, the sessions forgotten and the tool set
//                          changed, then every MCP request answered 502 for N seconds, as the stack's proxy answers
//                          while the server behind it is away
//   /control/refuse/N      a restart of the whole stack: the same, with the port closed for N seconds
//   /control/busy/N        the server back before the REST core behind it: the same, each MCP request answered as the
//                          brain's edge answers a busy registry (HTTP 200, JSON-RPC -32003, Retry-After 2)
//   /control/fault/N       the same, each answered 500, as the brain's route answers when its key check throws
//   /control/cut/N         a server that dies: every connection dropped where it stands, a listen stream with no closing
//                          frame, then 502 for N seconds. The other controls end each stream as the SDK's close() does
//
//   LISTEN=off bun probe.ts   declare tools.listChanged false, as the brain's server does today: a client told so
//                             is offered no stream
//   /control/expire        forget every 2025-era session, so its next request is answered 404
//   /control/ttl?ms=N      the ttlMs answered on tools/list (2026-07-28 only)
//   /control/state         what the probe holds
import { appendFileSync } from "node:fs";
import { createMcpHandler, isLegacyRequest, McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

const PORT = Number(process.env.PORT ?? 8765);
// Loopback only, and not a setting: the probe has no auth.
const HOST = "127.0.0.1";
const LOG = process.env.LOG ?? `${import.meta.dir}/probe.jsonl`;

let extra = false;
let ttlMs = Number(process.env.TTL_MS ?? 0);
/** MCP requests received, so a check can tell a list answered from a client's cache from one that was sent. */
let requests = 0;
const sessions = new Map<string, { server: McpServer; transport: WebStandardStreamableHTTPServerTransport }>();
/** Until when the MCP paths answer as something that is not serving, and how; 0 while serving. */
let downUntil = 0;
let downAs: "down" | "busy" | "fault" = "down";
/** Whether the 2026-07-28 server says it sends list-changed notifications; `LISTEN=off` says it does not, as the brain's does today. */
const LISTEN = process.env.LISTEN !== "off";
/** What a client is answered while the probe is away, by the control that sent it away. */
const away = (id: unknown): Response =>
  downAs === "busy" ? Response.json({ jsonrpc: "2.0", error: { code: -32003, message: "Busy: the key could not be checked just now. Retry shortly." }, id: id ?? null }, { status: 200, headers: { "retry-after": "2" } })
    : downAs === "fault" ? new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain; charset=UTF-8" } })
    : new Response("Bad Gateway", { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } });

const log = (line: Record<string, unknown>): void => {
  const full = { at: new Date().toISOString(), ...line };
  appendFileSync(LOG, `${JSON.stringify(full)}\n`);
  console.log(JSON.stringify(full));
};

/** The tools a server holds, by name: the SDK keeps no public list of them. */
const toolsOf = (server: McpServer): Record<string, { remove(): void } | undefined> => (server as unknown as { _registeredTools: Record<string, { remove(): void }> })._registeredTools;
const addExtra = (server: McpServer): void => {
  // A session left on the other set by a quiet change already holds it.
  if (toolsOf(server).probe_extra) return;
  server.registerTool("probe_extra", { description: "Present only in tool set B.", inputSchema: {} }, async () => ({ content: [{ type: "text" as const, text: "probe_extra answered" }] }));
};
const dropExtra = (server: McpServer): void => {
  toolsOf(server).probe_extra?.remove();
};

/** A server for one request or one session, holding the tool set as it stands now. */
function build(): McpServer {
  const server = new McpServer({ name: "client-probe", version: "0.0.1" }, { cacheHints: { "tools/list": { ttlMs, cacheScope: "private" } }, ...(LISTEN ? {} : { capabilities: { tools: { listChanged: false } } }) });
  server.registerTool("probe_time", { description: "Says the probe's time and which tool set it serves.", inputSchema: {} }, async () => ({
    content: [{ type: "text" as const, text: `time ${new Date().toISOString()} · tool set ${extra ? "B (probe_time, probe_extra)" : "A (probe_time)"}` }],
  }));
  if (extra) addExtra(server);
  return server;
}

const handler = () => createMcpHandler(() => build(), { onerror: (err) => log({ event: "handler-error", message: err.message }) });
let modern = handler();

/** The brain's wiring today: a 2025-era transport built per request, no session, POST only. */
async function stateless(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST, OPTIONS" } });
  const server = build();
  const transport = new WebStandardStreamableHTTPServerTransport();
  await server.connect(transport);
  const res = await transport.handleRequest(req);
  res.headers.delete("mcp-session-id");
  return res;
}

const HEADERS = ["user-agent", "accept", "content-type", "origin", "mcp-protocol-version", "mcp-method", "mcp-name", "mcp-session-id", "last-event-id"];
const META = "io.modelcontextprotocol/";

/** What one JSON-RPC message says about its client: the method, the revision it names, who it says it is. */
function summarize(message: unknown): Record<string, unknown> {
  if (typeof message !== "object" || message === null) return { malformed: true };
  const m = message as { method?: string; id?: unknown; params?: Record<string, unknown>; result?: unknown; error?: unknown };
  const out: Record<string, unknown> = { method: m.method ?? (m.result !== undefined || m.error !== undefined ? "(response)" : "(none)"), id: m.id };
  const p = m.params ?? {};
  if (p.protocolVersion !== undefined) out.protocolVersion = p.protocolVersion;
  if (p.clientInfo !== undefined) out.clientInfo = p.clientInfo;
  if (p.capabilities !== undefined) out.capabilities = p.capabilities;
  if (typeof p.name === "string") out.name = p.name;
  if (p.notifications !== undefined) out.notifications = p.notifications;
  const meta = p._meta as Record<string, unknown> | undefined;
  if (meta) {
    const envelope = Object.fromEntries(Object.entries(meta).filter(([k]) => k.startsWith(META)).map(([k, v]) => [k.slice(META.length), v]));
    if (Object.keys(envelope).length > 0) out.envelope = envelope;
  }
  return out;
}

async function record(req: Request, path: string): Promise<void> {
  const headers = Object.fromEntries(HEADERS.map((h) => [h, req.headers.get(h)]).filter(([, v]) => v !== null));
  let messages: unknown[] = [];
  let era = "legacy";
  if (req.method === "POST") {
    const text = await req.clone().text();
    try {
      const parsed = JSON.parse(text);
      messages = (Array.isArray(parsed) ? parsed : [parsed]).map(summarize);
    } catch {
      messages = [{ unparsed: text.slice(0, 200) }];
    }
    era = (await isLegacyRequest(req)) ? "legacy" : "modern";
  }
  log({ event: "request", path, http: req.method, era, headers, messages });
}

async function sessionful(req: Request): Promise<Response> {
  const sid = req.headers.get("mcp-session-id");
  if (sid) {
    const held = sessions.get(sid);
    if (!held) {
      log({ event: "session-unknown", sid });
      return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }, { status: 404 });
    }
    return held.transport.handleRequest(req);
  }
  if (req.method !== "POST") return new Response("Method not allowed.", { status: 405, headers: { Allow: "POST" } });
  const server = build();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { server, transport });
      log({ event: "session-open", sid: id });
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
      log({ event: "session-closed", sid: id });
    },
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}

async function control(url: URL): Promise<Response> {
  const what = url.pathname.slice("/control/".length);
  if (what === "toggle-quiet") {
    // The set changes and nobody is told: what a ttlMs alone has to find. (The SDK tells a session's stream when a tool
    // is registered or removed on its server, so a session's server is left as it was: its list stays the old one.)
    extra = !extra;
    log({ event: "toggle-quiet", toolSet: extra ? "B" : "A" });
  } else if (what === "drop") {
    // Every open listen stream cut, as a stack restart cuts them; the set changes too, unannounced.
    extra = !extra;
    const old = modern;
    modern = handler();
    await old.close();
    log({ event: "drop", toolSet: extra ? "B" : "A" });
  } else if (what === "toggle") {
    extra = !extra;
    modern.notify.toolsChanged();
    // A session's server was built with the old set, so the tool is added to it or removed from it in place.
    let told = 0;
    for (const { server } of sessions.values()) {
      try {
        // Registering or removing a tool on a connected server sends the notification itself.
        if (extra) addExtra(server);
        else dropExtra(server);
        told++;
      } catch (err) {
        log({ event: "toggle-session-error", message: (err as Error).message });
      }
    }
    log({ event: "toggle", toolSet: extra ? "B" : "A", sessionsTold: told });
  } else if (what === "expire") {
    const n = sessions.size;
    for (const { transport } of sessions.values()) await transport.close().catch(() => undefined);
    sessions.clear();
    log({ event: "expire", sessions: n });
  } else if (/^(down|refuse|busy|fault|cut)\/\d+$/.test(what)) {
    // A restart as a client meets it. What a restart loses is lost at once: the listen streams and the sessions. The
    // tool set changes, unannounced, as a release's does. Then nothing serves for the seconds named.
    const [how, n] = what.split("/");
    const seconds = Number(n);
    if (seconds < 1 || seconds > 600) return new Response("1 to 600 seconds", { status: 400 });
    extra = !extra;
    const old = modern;
    modern = handler();
    // A server that dies sends no closing frame: its streams end when their connections are dropped, below.
    if (how !== "cut") await old.close();
    for (const { transport } of sessions.values()) await transport.close().catch(() => undefined);
    sessions.clear();
    log({ event: how, seconds, toolSet: extra ? "B" : "A" });
    if (how === "cut") {
      downAs = "down";
      downUntil = Date.now() + seconds * 1000;
      setTimeout(() => log({ event: "serving-again" }), seconds * 1000);
      // After this answer has left: every connection dropped, and the port open again at once to answer 502.
      setTimeout(() => {
        void listener.stop(true).then(() => old.close()).catch(() => undefined);
        listener = listen();
      }, 100);
    } else if (how !== "refuse") {
      downAs = how as typeof downAs;
      downUntil = Date.now() + seconds * 1000;
      setTimeout(() => log({ event: "serving-again" }), seconds * 1000);
    } else {
      // After this answer has left: the port closed, its connections with it, and opened again.
      setTimeout(() => {
        void listener.stop(true);
        setTimeout(() => {
          listener = listen();
          log({ event: "serving-again" });
        }, seconds * 1000);
      }, 100);
    }
  } else if (what === "ttl") {
    ttlMs = Number(url.searchParams.get("ms") ?? 0);
    log({ event: "ttl", ttlMs });
  } else if (what !== "state") {
    return new Response("unknown control", { status: 404 });
  }
  return Response.json({ toolSet: extra ? "B" : "A", ttlMs, sessions: sessions.size, requests, down: Date.now() < downUntil, listen: LISTEN });
}

const listen = () => Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/control/")) return control(url);
    if (!["/mcp", "/legacy", "/session"].includes(url.pathname)) {
      log({ event: "other-path", http: req.method, path: url.pathname });
      return new Response("not found", { status: 404 });
    }
    requests++;
    await record(req, url.pathname);
    if (Date.now() < downUntil) {
      const id = req.method === "POST" ? await req.clone().json().then((m: { id?: unknown }) => m?.id, () => undefined) : undefined;
      const res = away(id);
      log({ event: "response", path: url.pathname, http: req.method, status: res.status, type: res.headers.get("content-type"), sid: null, away: downAs });
      return res;
    }
    const res = url.pathname === "/mcp" ? await modern.fetch(req) : url.pathname === "/legacy" ? await stateless(req) : await sessionful(req);
    log({ event: "response", path: url.pathname, http: req.method, status: res.status, type: res.headers.get("content-type"), sid: res.headers.get("mcp-session-id") });
    return res;
  },
});
let listener = listen();
log({ event: "listening", host: HOST, port: PORT, ttlMs });
