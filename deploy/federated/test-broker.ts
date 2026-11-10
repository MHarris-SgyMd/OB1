#!/usr/bin/env bun
/**
 * test-broker.ts — the slot broker (SMD-3379 PR 3a) over real WebSockets, hermetic: a broker started in this process
 * on a free loopback port, brains as WebSocket clients with their own keys. Who is granted what and when — live at
 * once, background within the room live leaves, turns across brains, a brain's own order, the lease, the warm-up, a
 * socket that closes or goes silent — read from the frames each brain receives and the broker's own counts.
 *
 *   bun deploy/federated/test-broker.ts
 */
import { spawn } from "node:child_process";
import { normalisedBase as slotsBase } from "../../server-portable/slots.ts";
import { hashKey, normalisedBase, parseRegistry, startBroker, type Broker, type Registry } from "./broker.ts";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, msg: string, detail?: unknown): void => {
  if (cond) pass++;
  else { fail++; console.error(`  ✗ ${msg}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
};
const section = (name: string) => console.log(`\n${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BASE = "http://host.containers.internal:11434/v1";
const KEYS = { stable: "slot_stable-key", canary: "slot_canary-key", third: "slot_third-key" };

function registry(over: { slots?: number; reserve?: number; lease?: number; warm?: number; idle?: number } = {}): Registry {
  const text = `broker:\n  lease_s: ${over.lease ?? 900}\n  warm_s: ${over.warm ?? 0}\n  idle_s: ${over.idle ?? 30}\n`
    + `servers:\n  ollama:\n    bases: [${BASE}, http://localhost:11434/v1]\n    slots: ${over.slots ?? 3}\n    reserve: ${over.reserve ?? 1}\n`
    + `brains:\n${Object.entries(KEYS).map(([n, k]) => `  ${n}:\n    key: "${hashKey(k)}"\n`).join("")}`;
  const { registry: r, problems } = parseRegistry(text);
  if (!r) throw new Error(problems.join("; "));
  return r;
}

type Frame = { op: string; id?: string | null; why?: string; [k: string]: unknown };
type Client = { frames: Frame[]; send(m: object): void; raw(t: string): void; next(op: string, id?: string | null, ms?: number): Promise<Frame | null>; seen(op: string, id: string | null): boolean; close(): Promise<void> };

async function connect(b: Broker, key: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${b.port}/v1/slots`, { headers: { "x-brain-key": key } } as unknown as string[]);
  const frames: Frame[] = [];
  const waiters: (() => void)[] = [];
  ws.onmessage = (e) => { frames.push(JSON.parse(String(e.data))); for (const w of waiters.splice(0)) w(); };
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("no connection")); });
  const find = (op: string, id?: string | null) => frames.find((f) => f.op === op && (id === undefined || f.id === id));
  return {
    frames,
    send: (m) => ws.send(JSON.stringify(m)),
    raw: (t) => ws.send(t),
    async next(op, id, ms = 2000) {
      const end = performance.now() + ms;
      while (!find(op, id)) {
        const left = end - performance.now();
        if (left <= 0) return null;
        await Promise.race([new Promise<void>((r) => waiters.push(r)), sleep(left)]);
      }
      return find(op, id)!;
    },
    seen: (op, id) => !!find(op, id),
    close: () => new Promise<void>((r) => { ws.onclose = () => r(); ws.close(); }),
  };
}

const ask = (c: Client, id: string, cls: "live" | "background", extra: object = {}) => c.send({ op: "ask", id, base: BASE, model: "qwen3:8b", cls, ...extra });
const done = (c: Client, id: string) => c.send({ op: "done", id });
const pool = (b: Broker) => b.snapshot()["ollama/qwen3:8b"] ?? { live: 0, background: 0, waiting: {} };
/** Until `cond` holds or `ms` passes; whether it held. */
async function until(cond: () => boolean, ms = 2000): Promise<boolean> {
  const end = performance.now() + ms;
  while (!cond()) { if (performance.now() > end) return false; await sleep(5); }
  return true;
}

async function withBroker(reg: Registry, fn: (b: Broker, lines: string[]) => Promise<void>): Promise<void> {
  const lines: string[] = [];
  const b = startBroker(reg, { port: 0, log: (l) => lines.push(l) });
  try { await fn(b, lines); } finally { await b.stop(); }
}

section("[1] the door: a key, the hello, health");
await withBroker(registry(), async (b) => {
  const health = await fetch(`http://127.0.0.1:${b.port}/health`);
  ok(health.status === 200 && (await health.text()) === "ok\n", "GET /health answers ok, with no key");
  const none = await fetch(`http://127.0.0.1:${b.port}/v1/slots`);
  ok(none.status === 401, "no key: 401 before any upgrade", none.status);
  const wrong = await fetch(`http://127.0.0.1:${b.port}/v1/slots`, { headers: { "x-brain-key": "slot_nobody" } });
  ok(wrong.status === 401, "an unknown key: 401", wrong.status);
  const query = await fetch(`http://127.0.0.1:${b.port}/v1/slots?key=${KEYS.stable}`);
  ok(query.status === 401, "a key in the query is no key: the header alone", query.status);
  const plain = await fetch(`http://127.0.0.1:${b.port}/v1/slots`, { headers: { "x-brain-key": KEYS.stable } });
  ok(plain.status === 426, "the right key without an upgrade: 426", plain.status);
  ok((await fetch(`http://127.0.0.1:${b.port}/other`)).status === 404, "any other path: 404");
  let refused = false;
  try { await connect(b, "slot_nobody"); } catch { refused = true; }
  ok(refused, "a WebSocket with an unknown key never opens");
  const s = await connect(b, KEYS.stable);
  const hello = await s.next("hello");
  ok(hello?.brain === "stable" && hello?.lease_s === 900, "the hello names the brain and the lease", hello);
  const servers = hello?.servers as { name: string; slots: number; reserve: number; bases: string[] }[];
  ok(servers?.length === 1 && servers[0].name === "ollama" && servers[0].slots === 3 && servers[0].reserve === 1 && servers[0].bases.length === 2, "and each server, its slots and bases", servers);
  ok(!JSON.stringify(hello).includes("canary") && !JSON.stringify(hello).includes("third"), "and no other brain");
  await s.close();
});

section("[2] live at once, always; background within the room live leaves");
await withBroker(registry({ slots: 3, reserve: 1 }), async (b, lines) => {
  const s = await connect(b, KEYS.stable);
  const c = await connect(b, KEYS.canary);
  ask(s, "b1", "background"); ask(s, "b2", "background"); ask(s, "b3", "background");
  ok(!!(await s.next("go", "b1")) && !!(await s.next("go", "b2")), "two background calls are granted on 3 slots, 1 reserved");
  ok(!!(await s.next("queued", "b3")) && !s.seen("go", "b3"), "the third background call queues: the reserve is live's");
  ask(c, "l1", "live");
  ok(!!(await c.next("go", "l1")), "another brain's live call is granted at once");
  ask(c, "l2", "live"); ask(c, "l3", "live"); ask(c, "l4", "live");
  ok(!!(await c.next("go", "l4")), "and a live call past every slot is granted at once too");
  ok(pool(b).live === 4 && pool(b).background === 2, "the counts: 4 live, 2 background", pool(b));
  ok(lines.some((l) => /4 live and 2 background calls run on 3 slots/.test(l) || /live and 2 background calls run on 3 slots/.test(l)), "over the slots is logged", lines);
  ok(lines.some((l) => /brain canary has 4 live calls running, past the server's 3 slots/.test(l)), "one brain's live calls past the slots are logged by name", lines);
  done(s, "b1");
  await sleep(50);
  ok(!s.seen("go", "b3"), "a background slot given back while live fills the server goes to no one: live takes background's room");
  done(c, "l1"); done(c, "l2");
  await sleep(50);
  ok(!s.seen("go", "b3"), "two live and one background on 3 slots: still no room", pool(b));
  done(c, "l3");
  ok(!!(await s.next("go", "b3")), "as live calls end, background's room comes back: 1 live + 1 background < 3");
  ok(pool(b).background === 2 && pool(b).live === 1, "background back at its 2, beside the live call", pool(b));
  done(c, "l4");
  await s.close(); await c.close();
});

await withBroker(registry({ slots: 1, reserve: 1 }), async (b) => {
  const s = await connect(b, KEYS.stable);
  ask(s, "b1", "background");
  ok(!!(await s.next("go", "b1")), "one slot, reserve 1: background still keeps one, with no live call running");
  ask(s, "l1", "live");
  ok(!!(await s.next("go", "l1")), "and live is granted beside it");
  done(s, "b1"); ask(s, "b2", "background");
  ok(!!(await s.next("queued", "b2")) && !s.seen("go", "b2"), "while that live call runs, background waits");
  done(s, "l1");
  ok(!!(await s.next("go", "b2")), "and is granted when it ends");
  await s.close();
});

section("[3] turns across brains");
await withBroker(registry({ slots: 2, reserve: 0 }), async (b) => {
  const s = await connect(b, KEYS.stable);
  const c = await connect(b, KEYS.canary);
  for (let i = 1; i <= 6; i++) ask(s, `s${i}`, "background");
  ok(!!(await s.next("go", "s2")), "a brain alone takes every background slot (reserve 0: both)");
  for (let i = 1; i <= 6; i++) ask(c, `c${i}`, "background");
  await c.next("queued", "c6");
  // Give back the oldest grant each round and read who gets the slot.
  const held = ["s1", "s2"];
  const order: string[] = [];
  const seen = new Set(["s1", "s2"]);
  const goes = () => [...s.frames, ...c.frames].filter((f) => f.op === "go").map((f) => f.id as string);
  for (let round = 0; round < 6; round++) {
    const before = goes().length;
    const give = held.shift();
    if (!give) break;
    done(give.startsWith("s") ? s : c, give);
    await until(() => goes().length > before);
    const fresh = goes().filter((id) => !seen.has(id));
    for (const id of fresh) seen.add(id);
    order.push(...fresh);
    held.push(...fresh);
  }
  ok(order.slice(0, 6).join() === "c1,s3,c2,s4,c3,s5", "two backlogs split the slots in turn, each brain in its own order", order);
  await s.close(); await c.close();
});

await withBroker(registry({ slots: 1, reserve: 0 }), async (b) => {
  const [s, c, t] = [await connect(b, KEYS.stable), await connect(b, KEYS.canary), await connect(b, KEYS.third)];
  ask(s, "s0", "background"); await s.next("go", "s0");
  ask(t, "t1", "background"); ask(c, "c1", "background"); ask(s, "s1", "background");
  await s.next("queued", "s1");
  done(s, "s0");
  ok(!!(await c.next("go", "c1")) && !t.seen("go", "t1"), "the turn goes to the next brain after the one served last, not the first to ask (canary after stable)");
  done(c, "c1");
  ok(!!(await t.next("go", "t1")), "then the third");
  done(t, "t1");
  ok(!!(await s.next("go", "s1")), "then round to stable again");
  await s.close(); await c.close(); await t.close();
});

section("[4] a brain's own order: first, and aging");
await withBroker(registry({ slots: 1, reserve: 0 }), async (b) => {
  const s = await connect(b, KEYS.stable);
  ask(s, "h", "background"); await s.next("go", "h");
  ask(s, "x1", "background"); ask(s, "x2", "background"); ask(s, "f", "background", { first: true }); ask(s, "x3", "background");
  await s.next("queued", "x3");
  done(s, "h");
  ok(!!(await s.next("go", "f")) && !s.seen("go", "x1"), "an ask put first goes before older asks of its brain");
  done(s, "f");
  ok(!!(await s.next("go", "x1")), "then the oldest");
  done(s, "x1");
  ok(!!(await s.next("go", "x2")), "then the next, in the order asked");
  done(s, "x2");
  await s.next("go", "x3");
  ask(s, "a1", "background", { max_wait_s: 30 }); ask(s, "aged", "background", { max_wait_s: 0.2 }); ask(s, "f2", "background", { first: true });
  await sleep(300);
  done(s, "x3");
  const firstGo = await until(() => s.seen("go", "aged") || s.seen("go", "f2") || s.seen("go", "a1"));
  ok(firstGo && s.seen("go", "aged") && !s.seen("go", "f2"), "an ask past its max_wait_s goes before a later one put first: the first of either, oldest first");
  await s.close();
});

section("[5] a socket that closes, or goes silent, gives everything back");
await withBroker(registry({ slots: 2, reserve: 0 }), async (b, lines) => {
  const s = await connect(b, KEYS.stable);
  const c = await connect(b, KEYS.canary);
  ask(s, "s1", "background"); ask(s, "s2", "background"); ask(s, "s3", "background"); ask(s, "l", "live");
  await s.next("queued", "s3");
  ask(c, "c1", "background");
  await c.next("queued", "c1");
  await s.close();
  ok(!!(await c.next("go", "c1")), "a closed socket's grants go to the next brain at once");
  ok(await until(() => pool(b).live === 0 && pool(b).background === 1 && Object.keys(pool(b).waiting).length === 0), "its live grant and its waiting ask are gone with it", pool(b));
  ok(lines.some((l) => /brain stable disconnected .*giving back/.test(l)), "and the close is logged", lines);
  await c.close();
});

await withBroker(registry({ slots: 1, reserve: 0, idle: 8 }), async (b) => {
  // A brain whose process stops answering: a child holding a grant, then SIGSTOPped — its socket stays open, its pings
  // go unanswered, and the broker closes it after idle_s.
  const child = spawn(process.execPath, ["-e", `
    const ws = new WebSocket("ws://127.0.0.1:${b.port}/v1/slots", { headers: { "x-brain-key": ${JSON.stringify(KEYS.third)} } });
    ws.onopen = () => ws.send(JSON.stringify({ op: "ask", id: "z", base: ${JSON.stringify(BASE)}, model: "qwen3:8b", cls: "background" }));
    ws.onmessage = (e) => { if (JSON.parse(String(e.data)).op === "go") console.log("granted"); };
    setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((r) => child.stdout!.on("data", (d) => { if (String(d).includes("granted")) r(); }));
  const c = await connect(b, KEYS.canary);
  ask(c, "c1", "background");
  await c.next("queued", "c1");
  child.kill("SIGSTOP");
  const t0 = performance.now();
  const got = await c.next("go", "c1", 30_000);
  const took = performance.now() - t0;
  ok(!!got && took >= 4000 && took < 25_000, `a silent socket's grant comes back after idle_s (8 s; took ${Math.round(took)} ms)`, took);
  child.kill("SIGKILL");
  await c.close();
});

section("[6] the lease, and the warm-up");
await withBroker(registry({ slots: 1, reserve: 0, lease: 1 }), async (b, lines) => {
  const s = await connect(b, KEYS.stable);
  const c = await connect(b, KEYS.canary);
  ask(s, "long", "background"); await s.next("go", "long");
  ask(c, "c1", "background"); await c.next("queued", "c1");
  ok(!!(await s.next("lapsed", "long", 3000)), "a grant held past lease_s is taken back, and its socket told");
  ok(!!(await c.next("go", "c1", 1000)), "and its slot goes on");
  ok(lines.some((l) => /grant long held past 1 s, taken back/.test(l)), "and it is logged", lines);
  done(s, "long");
  await sleep(50);
  ok(pool(b).background === 1, "a late done for a lapsed grant takes nothing else back", pool(b));
  await s.close(); await c.close();
});

await withBroker(registry({ slots: 2, reserve: 0, warm: 0.6 }), async (b) => {
  const s = await connect(b, KEYS.stable);
  const c = await connect(b, KEYS.canary);
  s.send({ op: "held", id: "h1", base: BASE, model: "qwen3:8b", cls: "background" });
  ok(!!(await s.next("go", "h1")), "in the warm-up a held slot is counted at once");
  ask(c, "c1", "background");
  ok(!!(await c.next("queued", "c1")) && !c.seen("go", "c1"), "a background ask in the warm-up waits, with a slot free");
  ask(c, "l1", "live");
  ok(!!(await c.next("go", "l1")), "a live ask in it does not");
  s.send({ op: "held", id: "h2", base: BASE, model: "qwen3:8b", cls: "background" });
  await s.next("go", "h2");
  done(c, "l1");
  await sleep(700);
  ok(!c.seen("go", "c1"), "after it, the held slots fill the share, so the waiting ask still waits: no over-grant", pool(b));
  done(s, "h1");
  ok(!!(await c.next("go", "c1")), "and is granted once one is given back");
  await s.close(); await c.close();
});

await withBroker(registry({ slots: 2, reserve: 0, warm: 0.4 }), async (b) => {
  const c = await connect(b, KEYS.canary);
  ask(c, "c1", "background");
  await c.next("queued", "c1");
  ok(!!(await c.next("go", "c1", 1500)), "the warm-up's end turns the asks it held, with nothing given back");
  await c.close();
});

section("[7] what is not brokered, and frames that are not asks");
await withBroker(registry(), async (b) => {
  const s = await connect(b, KEYS.stable);
  s.send({ op: "ask", id: "u", base: "http://jev:8000", model: null, cls: "background" });
  ok((await s.next("no", "u"))?.why === "server", "a base no server has: no, server — the brain's own share holds it");
  s.send({ op: "ask", id: "n", base: "http://LOCALHOST:11434/v1/", model: "m", cls: "background" });
  ok(!!(await s.next("go", "n")), "a base written another way, normalised, is the server's");
  s.send({ op: "ask", id: "n", base: BASE, model: "m", cls: "background" });
  ok((await s.next("no", "n"))?.why === "id", "an id in use: no, id");
  s.raw("not json");
  ok((await s.next("no", null))?.why === "bad", "a frame that is not JSON: no, bad, with no id");
  for (const [id, m] of [["c", { cls: "urgent" }], ["w", { max_wait_s: 0 }], ["f", { first: "yes" }], ["m", { model: "" }], ["o", { op: "grab" }]] as const) {
    s.send({ op: "ask", id, base: BASE, model: "x", cls: "background", ...m });
    ok((await s.next("no", id))?.why === "bad", `an ask with ${JSON.stringify(m)}: no, bad`);
  }
  s.send({ op: "done", id: "never-asked" });
  s.send({ op: "ask", id: "after", base: BASE, model: "x", cls: "live" });
  ok(!!(await s.next("go", "after")), "a done for an id never asked is ignored, the socket carries on");
  s.send({ op: "ask", id: "q1", base: BASE, model: null, cls: "background" });
  ok(!!(await s.next("go", "q1")) && "ollama/?" in b.snapshot(), "a model the brain does not name is counted as one, '?'", b.snapshot());
  await s.close();
});

await withBroker(registry({ slots: 1, reserve: 0 }), async (b) => {
  const s = await connect(b, KEYS.stable);
  for (let i = 0; i < 256; i++) ask(s, `k${i}`, "background");
  await s.next("queued", "k255");
  ask(s, "k256", "background");
  ok((await s.next("no", "k256"))?.why === "limit", "past 256 asks and grants at once: no, limit");
  done(s, "k10");
  ask(s, "k256", "background");
  ok(!!(await s.next("queued", "k256")), "a withdrawn ask frees its place");
  await s.close();
});

section("[8] the base is the brain's, read the same way");
for (const base of ["http://Host.Containers.Internal:11434/v1/", "https://openrouter.ai/api/v1", "http://u:p@h:1/v1//", "not a url/", "http://[::1]:11434/v1"]) {
  ok(normalisedBase(base) === slotsBase(base), `normalisedBase matches server-portable/slots.ts's for ${base}`, [normalisedBase(base), slotsBase(base)]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
