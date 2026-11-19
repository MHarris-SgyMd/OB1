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
import * as net from "node:net";
import { normalisedBase as slotsBase } from "../../server-portable/slots.ts";
import { hashKey, normalisedBase, parseRegistry, startBroker, type Broker, type Registry, type Snapshot } from "./broker.ts";

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

function registry(over: { slots?: number; reserve?: number; lease?: number; warm?: number; idle?: number; extra?: string } = {}): Registry {
  const text = `broker:\n  lease_s: ${over.lease ?? 900}\n  warm_s: ${over.warm ?? 0}\n  idle_s: ${over.idle ?? 30}\n`
    + `servers:\n  ollama:\n    bases: [${BASE}, http://localhost:11434/v1]\n    slots: ${over.slots ?? 3}\n    reserve: ${over.reserve ?? 1}\n${over.extra ?? ""}`
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
const pool = (b: Broker): Snapshot[string] => b.snapshot()["ollama/qwen3:8b"] ?? { live: 0, background: 0, waiting: {}, used: {} };
/** Until `cond` holds or `ms` passes; whether it held. */
async function until(cond: () => boolean, ms = 2000): Promise<boolean> {
  const end = performance.now() + ms;
  while (!cond()) { if (performance.now() > end) return false; await sleep(5); }
  return true;
}

async function withBroker(reg: Registry, fn: (b: Broker, lines: string[]) => Promise<void>, keepMs = 0, twinLapseMs?: number): Promise<void> {
  const lines: string[] = [];
  // A closed socket's grants given back at once unless a row asks otherwise: [13] reads the keeping itself.
  const b = startBroker(reg, { port: 0, log: (l) => lines.push(l), keepMs, twinLapseMs });
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
  ok(lines.some((l) => /live and 2 background calls run on 3 slots/.test(l)), "over the slots is logged", lines);
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
  const ss = order.slice(0, 6).filter((id) => id.startsWith("s")), cs = order.slice(0, 6).filter((id) => id.startsWith("c"));
  ok(order[0] === "c1" && ss.length >= 2 && cs.length >= 2, "two backlogs split the slots: the first freed goes to the brain with none, and each has its share of six", order);
  ok(ss.join() === ss.slice().sort().join() && cs.join() === cs.slice().sort().join(), "each brain's asks in its own order", order);
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

await withBroker(registry({ slots: 1, reserve: 0 }), async (b) => {
  // A tie — two brains that have had no slot time here — goes round from the brain served last, not from the
  // registry's first: canary served, then stable and third both waiting, third goes next.
  const [s, c, t] = [await connect(b, KEYS.stable), await connect(b, KEYS.canary), await connect(b, KEYS.third)];
  ask(c, "c1", "background"); await c.next("go", "c1");
  ask(s, "s1", "background"); ask(t, "t1", "background");
  await t.next("queued", "t1");
  done(c, "c1");
  ok(!!(await t.next("go", "t1")) && !s.seen("go", "s1"), "a tie goes round from the brain served last (canary), to third before stable");
  await s.close(); await c.close(); await t.close();
});

await withBroker(registry({ slots: 3, reserve: 0 }), async (b) => {
  // Calls still running count against their brain: canary's two have run 200 ms each when stable's one 200 ms call
  // ends, 400 ms against 200, so the slot goes to stable though canary has given none back yet.
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  ask(c, "b1", "background"); ask(c, "b1b", "background"); ask(s, "a1", "background");
  await s.next("go", "a1"); await c.next("go", "b1b");
  ask(c, "b2", "background"); ask(s, "a2", "background");
  await s.next("queued", "a2");
  await sleep(200);
  done(s, "a1");
  ok(!!(await s.next("go", "a2")) && !c.seen("go", "b2"), "a brain's calls still running count against its turn: the slot goes to the brain that has had less");
  await s.close(); await c.close();
});

{
  // On a clock the test moves: remembered slot time halves each USE_HALF_LIFE_S, and a brain coming to a pool where
  // another is at work starts level with it rather than at nothing.
  let t = 1_000_000;
  const b = startBroker(registry({ slots: 2, reserve: 0 }), { port: 0, log: () => {}, now: () => t });
  try {
    const s = await connect(b, KEYS.stable);
    ask(s, "keep", "live"); await s.next("go", "keep");
    ask(s, "g", "background"); await s.next("go", "g");
    t += 10_000; done(s, "g");
    await until(() => (pool(b).used.stable ?? 0) > 0);
    const before = pool(b).used.stable;
    t += 300_000;
    const after = pool(b).used.stable;
    ok(before === 10_000 && Math.abs(after - 5_000) <= 1, `a brain's slot time is charged as held (${before} ms) and halves in 300 s (${after} ms)`, [before, after]);
    t += 300_000;
    ok(Math.abs(pool(b).used.stable - 2_500) <= 1, "and halves again", b.snapshot());
    await s.close();
  } finally { await b.stop(); }
}

{
  let t = 1_000_000;
  const b = startBroker(registry({ slots: 1, reserve: 0 }), { port: 0, log: () => {}, now: () => t });
  try {
    const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
    // stable alone for ten minutes of 60 s calls, one always queued behind the one running.
    ask(s, "a0", "background"); await s.next("go", "a0");
    for (let i = 1; i <= 10; i++) { ask(s, `a${i}`, "background"); await s.next("queued", `a${i}`); t += 60_000; done(s, `a${i - 1}`); await s.next("go", `a${i}`); }
    ask(s, "a11", "background"); await s.next("queued", "a11");
    ask(c, "b1", "background"); ask(c, "b2", "background"); await c.next("queued", "b2");
    t += 60_000; done(s, "a10");
    ok(!!(await c.next("go", "b1")), "canary, arriving, has the next slot");
    t += 60_000; done(c, "b1");
    ok(!!(await s.next("go", "a11")) && !c.seen("go", "b2"), "and stable the one after: canary started level, not at nothing (else it would hold the slot a half-life)");
    await s.close(); await c.close();
  } finally { await b.stop(); }
}

{
  // A live call keeps the pool, and so its remembered slot time, while stable's backlog is gone for a moment; canary
  // comes in that moment with no one at work, so all start level again — stable back is not shut out by its old debt.
  let t = 1_000_000;
  const b = startBroker(registry({ slots: 2, reserve: 0 }), { port: 0, log: () => {}, now: () => t });
  try {
    const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
    ask(s, "keep", "live"); await s.next("go", "keep");
    ask(s, "a0", "background"); await s.next("go", "a0");
    for (let i = 1; i <= 10; i++) { ask(s, `a${i}`, "background"); await s.next("queued", `a${i}`); t += 60_000; done(s, `a${i - 1}`); await s.next("go", `a${i}`); }
    t += 60_000; done(s, "a10");
    await until(() => pool(b).background === 0);
    ask(c, "c1", "background"); await c.next("go", "c1");
    ask(s, "s1", "background"); ask(c, "c2", "background"); await c.next("queued", "c2");
    t += 60_000; done(c, "c1");
    ok(!!(await s.next("go", "s1")) && !c.seen("go", "c2"), "a brain back after a moment with nothing in the pool is not held to its old slot time: canary came to a pool no one worked, so all started level");
    await s.close(); await c.close();
  } finally { await b.stop(); }
}

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

section("[5] a socket that closes, or goes silent, gives everything back (the keeping off: [13] reads it)");
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
  const granted = await Promise.race([new Promise<boolean>((r) => child.stdout!.on("data", (d) => { if (String(d).includes("granted")) r(true); })), sleep(10_000).then(() => false)]);
  ok(granted, "the child brain was granted its slot");
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

await withBroker(registry({ slots: 2, reserve: 0, warm: 1.5 }), async (b) => {
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
  await sleep(1600);
  ok(!c.seen("go", "c1"), "after it, the held slots fill the share, so the waiting ask still waits: no over-grant", pool(b));
  done(s, "h1");
  ok(!!(await c.next("go", "c1")), "and is granted once one is given back");
  await s.close(); await c.close();
});

await withBroker(registry({ slots: 2, reserve: 0, warm: 1.5 }), async (b) => {
  const c = await connect(b, KEYS.canary);
  const hello = await c.next("hello");
  ok(typeof hello?.warm_s_left === "number" && (hello.warm_s_left as number) > 0 && (hello.warm_s_left as number) <= 1.5, "the hello says how much of the warm-up is left", hello);
  ask(c, "c1", "background");
  ok(!!(await c.next("queued", "c1")), "an ask in the warm-up is queued");
  ok(!!(await c.next("go", "c1", 3000)), "the warm-up's end turns the asks it held, with nothing given back");
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
  for (const [id, m] of [["c", { cls: "urgent" }], ["w", { max_wait_s: -1 }], ["v", { waited_s: -1 }], ["f", { first: "yes" }], ["m", { model: "" }], ["o", { op: "grab" }]] as const) {
    s.send({ op: "ask", id, base: BASE, model: "x", cls: "background", ...m });
    ok((await s.next("no", id))?.why === "bad", `an ask with ${JSON.stringify(m)}: no, bad`);
  }
  s.send({ op: "ping", id: "p1" });
  ok(!!(await s.next("pong", "p1")), "a ping is answered pong: a brain's liveness check");
  s.send({ op: "done", id: "never-asked" });
  s.send({ op: "ask", id: "after", base: BASE, model: "x", cls: "live" });
  ok(!!(await s.next("go", "after")), "a done for an id never asked is ignored, the socket carries on");
  s.send({ op: "ask", id: "q1", base: BASE, model: null, cls: "background" });
  ok(!!(await s.next("go", "q1")) && "ollama/?" in b.snapshot(), "a model the brain does not name is counted as one, '?'", b.snapshot());
  await s.close();
});

await withBroker(registry({ slots: 1, reserve: 0 }), async (b) => {
  const s = await connect(b, KEYS.stable);
  for (let i = 0; i <= 1024; i++) ask(s, `k${i}`, "background");
  await s.next("queued", "k1024");
  ask(s, "k1025", "background");
  ok((await s.next("no", "k1025"))?.why === "limit", "past 1024 background asks waiting on a socket: no, limit");
  ask(s, "live", "live");
  ok(!!(await s.next("go", "live")), "a live ask beside them is granted: a backlog never costs a live call its count");
  s.send({ op: "held", id: "h", base: BASE, model: "qwen3:8b", cls: "background" });
  ok(!!(await s.next("go", "h")), "and so is a held one");
  done(s, "k10");
  ask(s, "k1025", "background");
  ok(!!(await s.next("queued", "k1025")), "a withdrawn ask frees its place");
  await s.close();
});

await withBroker(registry(), async (b) => {
  const s = await connect(b, KEYS.stable);
  ok((await s.next("hello"))?.warm_s_left === 0, "no warm-up: the hello says 0 left");
  s.send({ op: "ask", id: 7, base: BASE, model: "m", cls: "live" });
  ok((await s.next("no", null))?.why === "bad", "an id that is no string: no, bad");
  await s.close();
});

section("[8] a close gives back its own (the keeping off), a pool goes once empty, the socket cap");
await withBroker(registry({ slots: 3, reserve: 1 }), async (b) => {
  const s = await connect(b, KEYS.stable);
  for (const id of ["g1", "g2", "a1", "a2", "a3"]) ask(s, id, "background");
  await s.next("queued", "a3");
  ok(s.seen("go", "g1") && s.seen("go", "g2"), "a brain alone holds both background slots, three asks queued");
  await s.close();
  ok(await until(() => !("ollama/qwen3:8b" in b.snapshot())), "its close gives both back and withdraws its asks, none granted to it on the way: the pool is gone", b.snapshot());
  const c = await connect(b, KEYS.canary);
  ask(c, "c1", "background"); ask(c, "c2", "background");
  ok(!!(await c.next("go", "c1")) && !!(await c.next("go", "c2")), "and another brain takes both slots at once");
  await c.close();
});

await withBroker(registry({ slots: 2, reserve: 0 }), async (b) => {
  const s = await connect(b, KEYS.stable);
  for (let i = 0; i < 1000; i++) { ask(s, `m${i}`, "live", { model: `model-${i}` }); done(s, `m${i}`); }
  ask(s, "last", "background", { model: "model-last" });
  await s.next("go", "last");
  done(s, "last");
  ok(await until(() => Object.keys(b.snapshot()).length === 0), "a thousand models asked and done leave no pool behind", Object.keys(b.snapshot()).length);
  await s.close();
});

await withBroker(registry(), async (b) => {
  const held: Client[] = [];
  for (let i = 0; i < 16; i++) held.push(await connect(b, KEYS.third));
  let refused = false;
  try { await connect(b, KEYS.third); } catch { refused = true; }
  ok(refused, "a brain's 17th socket at once is refused");
  const other = await connect(b, KEYS.stable);
  ok(!!(await other.next("hello")), "another brain's is not");
  await held.pop()!.close();
  await sleep(50);
  let reopened = false;
  try { held.push(await connect(b, KEYS.third)); reopened = true; } catch { reopened = false; }
  ok(reopened, "one closed, the brain may open another");
  for (const c of held) await c.close();
  await other.close();
});

section("[9] two backlogs split the slot time, whatever the room");
for (const room of [1, 2, 3]) {
  await withBroker(registry({ slots: room, reserve: 0 }), async (b) => {
    // Two brains backlogged, one's calls 5 ms, the other's 60 ms, each with a worker more than the room.
    const brains = [{ c: await connect(b, KEYS.stable), ms: 5, busy: 0 }, { c: await connect(b, KEYS.canary), ms: 60, busy: 0 }];
    const end = performance.now() + 2000;
    let n = 0;
    await Promise.all(brains.map(async (x, k) => {
      await Promise.all(Array.from({ length: room + 1 }, async () => {
        while (performance.now() < end) {
          const id = `w${k}-${n++}`;
          ask(x.c, id, "background");
          const go = await x.c.next("go", id, 3000);
          if (!go) return;
          const t0 = performance.now();
          await sleep(x.ms);
          x.busy += performance.now() - t0;
          done(x.c, id);
        }
      }));
    }));
    const share = brains[0].busy / (brains[0].busy + brains[1].busy);
    ok(share > 0.35 && share < 0.65, `room ${room}: the 5 ms brain's share of slot time is about half (${share.toFixed(2)}), where turns or grants alone gave it 6–8%`, share);
    for (const x of brains) await x.c.close();
  });
}

section("[10] a socket that stops reading is closed; a quiet one that answers pings is not");
await withBroker(registry({ slots: 1, reserve: 0, idle: 60 }), async (b) => {
  // A brain that asks, then floods frames and stops reading — a raw client in this process, so every byte it writes
  // reaches the broker whatever the load, and its own socket paused, so the broker's replies back up past the
  // kernel's buffers into its own: it is closed long before idle_s (60 s), its grant given back.
  const frame = (text: string) => {
    const body = Buffer.from(text), mask = Buffer.from([1, 2, 3, 4]);
    const head = body.length < 126 ? Buffer.from([0x81, 0x80 | body.length]) : Buffer.from([0x81, 0x80 | 126, body.length >> 8, body.length & 255]);
    return Buffer.concat([head, mask, Buffer.from(body.map((x, i) => x ^ mask[i % 4]))]);
  };
  const raw = net.connect(b.port, "127.0.0.1");
  let got = "";
  raw.on("data", (d: Buffer) => { got += d.toString("latin1"); });
  raw.on("error", () => {});
  await new Promise<void>((r) => raw.on("connect", () => r()));
  raw.write(`GET /v1/slots HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nx-brain-key: ${KEYS.third}\r\n\r\n`);
  ok(await until(() => got.includes(" 101 "), 5000), "the raw brain is upgraded");
  raw.write(frame(JSON.stringify({ op: "ask", id: "z", base: BASE, model: "qwen3:8b", cls: "background" })));
  ok(await until(() => pool(b).background === 1, 5000), "and holds the slot");
  raw.pause();
  const one = frame("x");
  raw.write(Buffer.concat(Array.from({ length: 600_000 }, () => one)));
  const c = await connect(b, KEYS.canary);
  ask(c, "c1", "background");
  const t0 = performance.now();
  const went = await c.next("go", "c1", 30_000);
  ok(!!went && performance.now() - t0 < 20_000, `a brain not reading its frames is closed and its slot handed on, well before idle_s (${Math.round(performance.now() - t0)} ms)`);
  raw.destroy();
  await c.close();
});

await withBroker(registry({ slots: 1, reserve: 0, idle: 8 }), async (b) => {
  const s = await connect(b, KEYS.stable);
  ask(s, "long", "background");
  await s.next("go", "long");
  await sleep(12_000);
  ok(pool(b).background === 1, "a socket silent 12 s past an idle_s of 8, answering pings, keeps its grant");
  done(s, "long");
  ok(await until(() => !("ollama/qwen3:8b" in b.snapshot())), "and its done still lands");
  await s.close();
});

section("[11] held outside the warm-up");
await withBroker(registry({ slots: 2, reserve: 0 }), async (b, lines) => {
  const s = await connect(b, KEYS.stable);
  for (const id of ["h1", "h2", "h3"]) s.send({ op: "held", id, base: BASE, model: "qwen3:8b", cls: "background" });
  await s.next("go", "h3");
  ok(pool(b).background === 3, "a held slot is counted as it is, past the room", pool(b));
  ok(lines.filter((l) => /re-registers held slots outside the warm-up/.test(l)).length === 1, "and said once for the socket", lines);
  await s.close();
});

section("[12] per_model: false, the hello, an ask's age, the logs, the door's Host");
await withBroker(registry({ slots: 1, reserve: 0, extra: `  jev:\n    bases: [http://host.containers.internal:8022]\n    slots: 1\n    reserve: 0\n    per_model: false\n` }), async (b) => {
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  s.send({ op: "ask", id: "d1", base: "http://host.containers.internal:8022", model: "h2o-lightning-4b", cls: "background" });
  await s.next("go", "d1");
  c.send({ op: "ask", id: "d2", base: "http://host.containers.internal:8022", model: null, cls: "background" });
  ok(!!(await c.next("queued", "d2")), "per_model: false — one brain naming its model and another not share the server's one slot");
  ok(Object.keys(b.snapshot()).join() === "jev/*", "one pool, whatever the model", b.snapshot());
  done(s, "d1");
  ok(!!(await c.next("go", "d2")), "and it is handed on");
  await s.close(); await c.close();
});

{
  const reg = registry({ idle: 12 });
  const [b1, b2] = [startBroker(reg, { port: 0, log: () => {} }), startBroker(reg, { port: 0, log: () => {} })];
  try {
    const [h1, h2] = await Promise.all([connect(b1, KEYS.stable).then((c) => c.next("hello")), connect(b2, KEYS.stable).then((c) => c.next("hello"))]);
    ok(typeof h1?.boot === "string" && h1.boot !== h2?.boot, "each start's hello carries a boot id of its own", [h1?.boot, h2?.boot]);
    ok(h1?.idle_s === 12 && h1?.max_waiting === 1024 && h1?.max_held === 4096 && h1?.max_sockets === 16 && h1?.max_frame === 4096, "and the limits a brain must keep to", h1);
    ok((h1?.servers as { per_model: boolean }[])[0].per_model === true, "and each server's per_model");
  } finally { await b1.stop(); await b2.stop(); }
}

await withBroker(registry({ slots: 1, reserve: 0 }), async (b) => {
  const s = await connect(b, KEYS.stable);
  ask(s, "h", "background"); await s.next("go", "h");
  ask(s, "young", "background"); ask(s, "f", "background", { first: true }); ask(s, "old", "background", { waited_s: 120 });
  await s.next("queued", "old");
  done(s, "h");
  ok(!!(await s.next("go", "old")) && !s.seen("go", "f"), "an ask that says it waited past its max_wait_s already goes first: a call asked again after a drop keeps its age");
  done(s, "old");
  ok(!!(await s.next("go", "f")), "then the one put first");
  ask(s, "zero", "background", { max_wait_s: 0 });
  await s.next("queued", "zero");
  done(s, "f");
  ok(!!(await s.next("go", "zero")) && !s.seen("go", "young"), "an ask with max_wait_s 0 goes first at once, before an older one");
  await s.close();
});

await withBroker(registry({ slots: 1, reserve: 0 }), async (b, lines) => {
  const s = await connect(b, KEYS.stable);
  for (let i = 0; i < 200; i++) { ask(s, `a${i}`, "live"); ask(s, `b${i}`, "live"); ask(s, `c${i}`, "live"); done(s, `a${i}`); done(s, `b${i}`); done(s, `c${i}`); }
  ask(s, "end", "live"); await s.next("go", "end");
  ok(lines.filter((l) => /calls run on 1 slots/.test(l)).length === 1, "a server over its slots two hundred times in a second is said once", lines.length);
  ok(lines.filter((l) => /has \d+ live calls running, past/.test(l)).length === 1, "and a brain over them live, once", lines.length);
  await s.close();
});

await withBroker(registry(), async (b) => {
  const answers: string[] = [];
  for (const host of ["a b", "[", "%", "@x"]) {
    const r = await new Promise<string>((res) => {
      const sock = net.connect(b.port, "127.0.0.1", () => sock.write(`GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
      let got = ""; sock.on("data", (d: Buffer) => { got += d; }); sock.on("end", () => res(got.split("\r\n")[0])); sock.on("error", () => res("error"));
    });
    answers.push(r);
  }
  ok(answers.every((a) => !/ 500 /.test(a)), "a Host header no URL reads is no 500", answers);
  ok((await fetch(`http://127.0.0.1:${b.port}/health`)).ok, "and the broker answers on");
});

section("[13] a closed socket's grants kept for the brain's return, moved between its sockets, freed at synced; silent and dead sockets; twins; a brain back with calls running starts level");
await withBroker(registry({ slots: 2, reserve: 0 }), async (b, lines) => {
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  ask(s, "g1", "background"); ask(s, "g2", "background");
  await s.next("go", "g2");
  ask(c, "c1", "background"); await c.next("queued", "c1");
  await s.close();
  await sleep(200);
  ok(!c.seen("go", "c1") && pool(b).background === 2, "a closed socket's grants stay counted: the other brain's ask still waits", pool(b));
  ok(lines.some((l) => /keeping 2 grants 0.4 s for its return/.test(l)), "and the close says so", lines);
  const s2 = await connect(b, KEYS.stable);
  s2.send({ op: "held", id: "g1", base: BASE, model: "qwen3:8b", cls: "background" });
  s2.send({ op: "held", id: "g2", base: BASE, model: "qwen3:8b", cls: "background" });
  ok(!!(await s2.next("go", "g2")) && pool(b).background === 2, "the brain's held on its next socket takes them back, counted once, not twice", pool(b));
  await sleep(600);
  ok(!c.seen("go", "c1"), "taken back, they outlive the keeping");
  done(s2, "g1");
  ok(!!(await c.next("go", "c1")), "and are given back at their done");
  await s2.close(); await c.close();
}, 400);

await withBroker(registry({ slots: 1, reserve: 0 }), async (b) => {
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  ask(s, "g", "background"); await s.next("go", "g");
  ask(c, "c1", "background"); await c.next("queued", "c1");
  await s.close();
  ok(!(await c.next("go", "c1", 200)), "a brain that does not come back keeps its grant counted for the keeping");
  ok(!!(await c.next("go", "c1", 2000)), "then gives it back");
  await c.close();
}, 400);

{
  // On a clock the test moves: canary alone at work for ten minutes; stable, partitioned meanwhile, comes back with a
  // call running (held) and asks — it starts level with canary, not at its old, lower score, so the two alternate.
  let t = 1_000_000;
  const b = startBroker(registry({ slots: 2, reserve: 0 }), { port: 0, log: () => {}, now: () => t, keepMs: 0 });
  try {
    const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
    ask(c, "c0", "background"); await c.next("go", "c0");
    for (let i = 1; i <= 10; i++) { ask(c, `c${i}`, "background"); await c.next("go", `c${i}`); t += 60_000; done(c, `c${i - 1}`); }
    s.send({ op: "held", id: "h", base: BASE, model: "qwen3:8b", cls: "background" }); await s.next("go", "h");
    ask(s, "s1", "background"); ask(s, "s2", "background"); ask(c, "c11", "background");
    await c.next("queued", "c11");
    t += 60_000; done(c, "c10");
    const first = await until(() => s.seen("go", "s1") || c.seen("go", "c11"));
    t += 60_000; done(s, "h");
    await until(() => [s.seen("go", "s1"), s.seen("go", "s2"), c.seen("go", "c11")].filter(Boolean).length >= 2);
    ok(first && !(s.seen("go", "s1") && s.seen("go", "s2") && !c.seen("go", "c11")), "stable back with a held call does not take both turns ahead of canary: it started level", { s1: s.seen("go", "s1"), s2: s.seen("go", "s2"), c11: c.seen("go", "c11") });
    await s.close(); await c.close();
  } finally { await b.stop(); }
}

await withBroker(registry({ slots: 1, reserve: 0 }), async (b) => {
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  ask(s, "n1:g", "background"); await s.next("go", "n1:g");
  ask(c, "c1", "background"); await c.next("queued", "c1");
  await s.close();
  const s2 = await connect(b, KEYS.stable);
  s2.send({ op: "synced", id: "n1" });
  ok(!!(await c.next("go", "c1", 1000)), "its own relay's synced, naming no held, gives them back at once, not at the keeping's end");
  await s2.close();
  // A coordinator replaced: its kept grant (prefix n3) is given back at the new relay's synced (n4), no open socket
  // speaking for n3.
  const s3 = await connect(b, KEYS.stable);
  done(c, "c1");
  ask(s3, "n3:g", "background"); await s3.next("go", "n3:g");
  ask(c, "c2", "background"); await c.next("queued", "c2");
  await s3.close();
  const s4 = await connect(b, KEYS.stable);
  s4.send({ op: "synced", id: "n4" });
  ok(!!(await c.next("go", "c2", 1000)), "a replaced coordinator's kept grants are given back at its successor's synced, not kept 5 s");
  await s4.close();
  await c.close();
}, 5000);

await withBroker(registry({ slots: 1, reserve: 0 }), async (b) => {
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  ask(s, "g", "background"); await s.next("go", "g");
  ask(c, "c1", "background"); await c.next("queued", "c1");
  // A second socket of the same brain, the first still open (half-open, as the broker sees it): its held moves the grant.
  const s2 = await connect(b, KEYS.stable);
  s2.send({ op: "held", id: "g", base: BASE, model: "qwen3:8b", cls: "background" });
  ok(!!(await s2.next("go", "g")) && pool(b).background === 1, "a held naming a grant still on the brain's other open socket moves it: counted once", pool(b));
  await s.close();
  await sleep(100);
  ok(!c.seen("go", "c1") && pool(b).background === 1, "the old socket's close gives nothing back: the grant is the new socket's", pool(b));
  done(s2, "g");
  ok(!!(await c.next("go", "c1")), "and its done on the new socket frees it");
  await s2.close(); await c.close();
}, 5000);

await withBroker(registry({ slots: 1, reserve: 0, lease: 1 }), async (b) => {
  // A one-slot server: stable's grant kept at its close, swept at its lease, the slot then going to canary's ask, which
  // keeps the pool — so stable's held meets the kept grant's own pool again.
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  ask(s, "g", "background"); await s.next("go", "g");
  ask(c, "c1", "background"); await c.next("queued", "c1");
  await s.close();
  ok(!!(await c.next("go", "c1", 2000)), "the kept grant swept at its lease, its slot goes on");
  const s2 = await connect(b, KEYS.stable);
  s2.send({ op: "held", id: "g", base: BASE, model: "qwen3:8b", cls: "background" });
  ok(!!(await s2.next("go", "g", 1000)) && pool(b).background === 2, "a kept grant the lease's sweep already took back is no longer kept: the held is counted afresh, never adopted uncounted", pool(b));
  await s2.close(); await c.close();
}, 5000);

await withBroker(registry({ slots: 2, reserve: 0 }), async (b) => {
  const s = await connect(b, KEYS.stable);
  ask(s, "g", "background"); await s.next("go", "g");
  await s.close();
  const s2 = await connect(b, KEYS.stable);
  s2.send({ op: "held", id: "g", base: BASE, model: "another-model", cls: "background" });
  await s2.next("go", "g");
  ok(pool(b).background === 0 && b.snapshot()["ollama/another-model"]?.background === 1, "a held naming a kept grant's id in another pool gives the kept one back: the call counted once", b.snapshot());
  await s2.close();
}, 5000);

await withBroker(registry({ slots: 2, reserve: 0 }), async (b) => {
  // Two sockets in turn, each with 4096 live grants, closed: no more than MAX_HELD kept for the brain.
  for (const round of [0, 1]) {
    const s = await connect(b, KEYS.stable);
    for (let i = 0; i < 4096; i++) ask(s, `r${round}-${i}`, "live");
    await s.next("go", `r${round}-4095`, 10_000);
    await s.close();
  }
  await sleep(100);
  ok(pool(b).live <= 4096, `a brain's kept grants are held to MAX_HELD, the oldest given back (${pool(b).live} kept)`, pool(b).live);
}, 60_000);

await withBroker(registry({ slots: 1, reserve: 0 }), async (b) => {
  // A grant kept at one close, taken back, and kept again at a later close is the later close's: the first close's
  // timer leaves it.
  const s1 = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  ask(s1, "n1:g", "background"); await s1.next("go", "n1:g");
  ask(c, "c1", "background"); await c.next("queued", "c1");
  await s1.close();
  const s2 = await connect(b, KEYS.stable);
  s2.send({ op: "held", id: "n1:g", base: BASE, model: "qwen3:8b", cls: "background" }); await s2.next("go", "n1:g");
  await sleep(1000);
  await s2.close();
  const closed = performance.now();
  ok(!(await c.next("go", "c1", 1500)), "the first close's timer, firing first, leaves the grant the second close kept");
  ok(!!(await c.next("go", "c1", 2000)) && performance.now() - closed >= 1800, "the second close's own keeping gives it back", Math.round(performance.now() - closed));
  await c.close();
}, 2000);

await withBroker(registry({ slots: 1, reserve: 0 }), async (b) => {
  // A brain's grant on one socket, its ask again on another of its sockets still open (a half-open old one): moved, go.
  const s1 = await connect(b, KEYS.stable), s2 = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  ask(s1, "n1:a", "background"); await s1.next("go", "n1:a");
  ask(c, "c1", "background"); await c.next("queued", "c1");
  ask(s2, "n1:a", "background");
  ok(!!(await s2.next("go", "n1:a")) && pool(b).background === 1, "an ask naming the brain's grant on its other open socket moves it: go, counted once", pool(b));
  // A relay synced on the new socket: the old socket's close gives back what it still holds of that relay at once.
  s2.send({ op: "synced", id: "n1" });
  done(s2, "n1:a");
  ok(!!(await c.next("go", "c1")), "the moved grant's done frees it");
  done(c, "c1");
  ask(s1, "n1:b", "background"); await s1.next("go", "n1:b");
  ask(c, "c2", "background"); await c.next("queued", "c2");
  await s1.close();
  ok(await until(() => c.seen("go", "c2"), 1000), "the old socket's grants of a relay synced on a newer socket are given back at its close, not kept");
  await s2.close(); await c.close();
}, 5000);

await withBroker(registry({ slots: 1, reserve: 0, idle: 8 }), async (b) => {
  // A socket that stops answering (a raw client, no pongs) with an ask queued: no grant goes into it once it has been
  // silent half its idle_s, and it is ended at idle_s, whatever the broker sends it.
  const c = await connect(b, KEYS.canary);
  ask(c, "c0", "background"); await c.next("go", "c0");
  const raw = await rawBrain(b, KEYS.third);
  raw.send({ op: "ask", id: "q", base: BASE, model: "qwen3:8b", cls: "background" });
  await until(() => pool(b).waiting.third === 1, 2000);
  ask(c, "c1", "background"); await c.next("queued", "c1");
  await sleep(4500);
  done(c, "c0");
  ok(!!(await c.next("go", "c1", 1500)), "the slot freed goes past the silent socket's older ask to the brain that answers");
  ok(await until(() => raw.closed(), 6000) && !pool(b).waiting.third, "and the silent socket is ended at idle_s, its ask withdrawn", pool(b));
  raw.destroy();
  await c.close();
});

/** A brain's socket that stops answering when told: a raw client that never answers pings, its frames sent by hand. */
async function rawBrain(b: Broker, key: string) {
  const frame = (text: string) => { const body = Buffer.from(text), mask = Buffer.from([1, 2, 3, 4]); return Buffer.concat([Buffer.from([0x81, 0x80 | 126, body.length >> 8, body.length & 255]), mask, Buffer.from(body.map((x, i) => x ^ mask[i % 4]))]); };
  const sock = net.connect(b.port, "127.0.0.1");
  let got = "", closed = false;
  sock.on("data", (d: Buffer) => { got += d.toString("latin1"); });
  sock.on("close", () => { closed = true; });
  sock.on("error", () => {});
  await new Promise<void>((r) => sock.on("connect", () => r()));
  sock.write(`GET /v1/slots HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nx-brain-key: ${key}\r\n\r\n`);
  await until(() => got.includes(" 101 "), 3000);
  return { send: (m: object) => sock.write(frame(JSON.stringify(m))), saw: (s: string) => got.includes(s), closed: () => closed, destroy: () => sock.destroy() };
}

await withBroker(registry({ slots: 2, reserve: 1, idle: 8 }), async (b) => {
  // A brain's ask moved off its silent old socket (a raw one, skipped once silent) onto a new socket while the pool held
  // nothing else: the pool is kept, the new ask granted there, and the next waits within background's room of one.
  const old = await rawBrain(b, KEYS.third);
  const s = await connect(b, KEYS.third);
  ask(s, "g", "background"); await s.next("go", "g");
  old.send({ op: "ask", id: "x", base: BASE, model: "qwen3:8b", cls: "background" });
  await until(() => pool(b).waiting.third === 1, 2000);
  await sleep(4500);
  done(s, "g");
  await sleep(200);
  ask(s, "x", "background");
  ok(!!(await s.next("go", "x")), "the moved ask is granted on the new socket");
  ask(s, "y", "background");
  ok(!!(await s.next("queued", "y", 1000)) && !s.seen("go", "y") && Object.keys(b.snapshot()).length === 1 && pool(b).background === 1, "one pool for the key, background within its room of one: the next waits", b.snapshot());
  old.destroy(); await s.close();
});

await withBroker(registry({ slots: 1, reserve: 0, idle: 30 }), async (b) => {
  // The dead side of a link a brain replaces: pinged as its new socket opens, ended within PROBE_MS, not at idle_s.
  const old = await rawBrain(b, KEYS.third);
  old.send({ op: "ask", id: "g", base: BASE, model: "qwen3:8b", cls: "background" });
  await until(() => old.saw("go"), 2000);
  const t0 = performance.now();
  const s = await connect(b, KEYS.third);
  ok(await until(() => old.closed(), 5000) && performance.now() - t0 < 4000, `the brain's older socket, unanswering, is ended at its new one's open (${Math.round(performance.now() - t0)} ms)`, performance.now() - t0);
  const c = await connect(b, KEYS.canary);
  ask(c, "c1", "background");
  ok(!!(await c.next("go", "c1", 3000)), "its grant given back for another brain");
  await s.close(); await c.close();
});

{
  // Slot time charged only to a socket's last sign of life: a grant into a socket that then went dead, the test's clock
  // moved 100 s on before it ends, charges its brain nothing past its last frame.
  let t = 1_000_000;
  const b = startBroker(registry({ slots: 2, reserve: 0, idle: 30 }), { port: 0, log: () => {}, now: () => t, keepMs: 0 });
  try {
    const old = await rawBrain(b, KEYS.third);
    old.send({ op: "ask", id: "g", base: BASE, model: "qwen3:8b", cls: "background" });
    await until(() => old.saw("go"), 2000);
    const keep = await connect(b, KEYS.canary);
    ask(keep, "k", "live"); await keep.next("go", "k");
    t += 100_000;
    const s = await connect(b, KEYS.third);
    await until(() => old.closed(), 5000);
    await sleep(100);
    const used = pool(b).used.third ?? 0;
    ok(used < 1000, `the dead socket's grant charged its brain only to its last frame, not the 100 s after (${used} ms)`, used);
    await s.close(); await keep.close();
  } finally { await b.stop(); }
}

await withBroker(registry({ slots: 1, reserve: 0 }), async (b, lines) => {
  // Two relays on one key (a misconfiguration): said once, and each keeps its own grants — one relay's close gives
  // nothing back because the other has synced, so its held on its next socket counts the call once.
  const a = await connect(b, KEYS.stable), z = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  a.send({ op: "synced", id: "A" }); z.send({ op: "synced", id: "Z" });
  ask(a, "A:1", "background"); await a.next("go", "A:1");
  ok(await until(() => lines.some((l) => /two relays speak on its key at once/.test(l))), "two relays on one key are said", lines);
  ask(c, "c1", "background"); await c.next("queued", "c1");
  await a.close();
  ok(!(await c.next("go", "c1", 500)), "one twin's close keeps its grant, the other having synced");
  z.send({ op: "synced", id: "Z" });
  ok(!(await c.next("go", "c1", 500)), "and the other twin's synced, the first between sockets, leaves it kept");
  const a2 = await connect(b, KEYS.stable);
  a2.send({ op: "held", id: "A:1", base: BASE, model: "qwen3:8b", cls: "background" }); await a2.next("go", "A:1");
  a2.send({ op: "synced", id: "A" });
  ok(pool(b).background === 1 && !c.seen("go", "c1"), "and its held takes it back, the call counted once", pool(b));
  await a2.close(); await z.close(); await c.close();
}, 5000);

await withBroker(registry({ slots: 1, reserve: 0 }), async (b, lines) => {
  // Twins steady past the mark's lapse are still twins: the broker looks each tick, not only at a socket's event, so
  // one's close keeps its grant and its held counts the call once (review pass 8: lapsed at the close, 2 calls on 1 slot).
  const a = await connect(b, KEYS.stable), z = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  a.send({ op: "synced", id: "A" }); z.send({ op: "synced", id: "Z" });
  ask(a, "A:1", "background"); await a.next("go", "A:1");
  ask(c, "c1", "background"); await c.next("queued", "c1");
  await sleep(2500);
  await a.close();
  ok(!(await c.next("go", "c1", 500)), "twins steady past the lapse: one's close still keeps its grant");
  const a2 = await connect(b, KEYS.stable);
  a2.send({ op: "held", id: "A:1", base: BASE, model: "qwen3:8b", cls: "background" }); await a2.next("go", "A:1");
  ok(pool(b).background === 1 && !c.seen("go", "c1") && lines.filter((l) => /two relays speak/.test(l)).length === 1, "and its held takes it back, counted once, the twins said once", { p: pool(b), lines });
  await a2.close(); await z.close(); await c.close();
}, 5000, 1500);

await withBroker(registry({ slots: 1, reserve: 0, idle: 30 }), async (b) => {
  // A socket the probe found dead gives its grants back at once, not after the keeping.
  const old = await rawBrain(b, KEYS.third);
  old.send({ op: "ask", id: "g", base: BASE, model: "qwen3:8b", cls: "background" });
  await until(() => old.saw("go"), 2000);
  const c = await connect(b, KEYS.canary);
  ask(c, "c1", "background"); await c.next("queued", "c1");
  const t0 = performance.now();
  const s = await connect(b, KEYS.third);
  ok(!!(await c.next("go", "c1", 4500)) && performance.now() - t0 < 4500, `a probe-ended socket's grant is given back at its end, not kept 5 s (${Math.round(performance.now() - t0)} ms)`, performance.now() - t0);
  // Opens coming fast do not keep a dead socket alive: a second dead socket, new sockets opened every 1.5 s.
  const dead = await rawBrain(b, KEYS.third);
  dead.send({ op: "ask", id: "h", base: BASE, model: "qwen3:8b", cls: "background" });
  await sleep(100);
  const t1 = performance.now();
  const opened: Client[] = [];
  while (!dead.closed() && performance.now() - t1 < 8000) { opened.push(await connect(b, KEYS.third)); await sleep(1500); }
  ok(dead.closed() && performance.now() - t1 < 5000, `a pending probe is not reset by later opens: the dead socket ended within ~2 s of the first (${Math.round(performance.now() - t1)} ms)`, performance.now() - t1);
  for (const o of opened) await o.close();
  old.destroy(); dead.destroy(); await s.close(); await c.close();
}, 5000);

await withBroker(registry({ slots: 1, reserve: 0, idle: 30 }), async (b, lines) => {
  // A coordinator swapped behind a half-open socket is no second coordinator: the old socket, not answering its new
  // one's probe, is not counted toward twins, and its grant is given back as the probe ends it.
  const old = await rawBrain(b, KEYS.third);
  old.send({ op: "synced", id: "X" });
  old.send({ op: "ask", id: "X:g", base: BASE, model: "qwen3:8b", cls: "background" });
  await until(() => old.saw("go"), 2000);
  const c = await connect(b, KEYS.canary);
  ask(c, "c1", "background"); await c.next("queued", "c1");
  const s = await connect(b, KEYS.third);
  s.send({ op: "synced", id: "Y" });
  ok(!!(await c.next("go", "c1", 4500)), "the old socket probed out, its grant goes on");
  ok(!lines.some((l) => /two relays speak/.test(l)), "and the swap is not taken for two coordinators", lines);
  old.destroy(); await s.close(); await c.close();
}, 5000);

section("[14] the base is the brain's, read the same way");
for (const base of ["http://Host.Containers.Internal:11434/v1/", "https://openrouter.ai/api/v1", "http://u:p@h:1/v1//", "not a url/", "http://[::1]:11434/v1"]) {
  ok(normalisedBase(base) === slotsBase(base), `normalisedBase matches server-portable/slots.ts's for ${base}`, [normalisedBase(base), slotsBase(base)]);
}

section("[15] residency: a model not loaded waits its turn, the server's other background drains for a load (PR 3c-1)");
/** A stand-in for a model server's list of its loaded models (Ollama's GET /api/ps), which a row moves. */
function fakeList(models: string[]): { url: string; models: string[]; status: number; body: string | null; delay: number; hits: number; stop(): void } {
  const list = { url: "", models, status: 200, body: null as string | null, delay: 0, hits: 0, stop: () => { void srv.stop(true); } };
  const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/elsewhere") return Response.json({ models: [{ name: "anything:1" }] });
    list.hits++;
    // What it lists is what it held as the request came, however late the answer.
    const now = list.models.slice();
    if (list.delay) await sleep(list.delay);
    if (list.status !== 200) return new Response("the server's own words", { status: list.status, headers: list.status === 302 ? { location: "/elsewhere" } : {} });
    return list.body !== null ? new Response(list.body) : Response.json({ models: now.map((name) => ({ name, model: name, size: 1 })) });
  } });
  list.url = `http://127.0.0.1:${srv.port}/api/ps`;
  return list;
}
const askM = (c: Client, id: string, model: string, cls: "live" | "background", extra: object = {}) => c.send({ op: "ask", id, base: BASE, model, cls, ...extra });
const BIG = "qwen3.8:27b", SMALL = "qwen2.5:7b";
type Res = ReturnType<Broker["residency"]>["ollama"];
/** A broker whose `ollama` names the list, on a clock the row moves (`move` turns it too); the list read once before the row begins. */
async function withResidency(models: string[], fn: (x: { b: Broker; ps: ReturnType<typeof fakeList>; lines: string[]; move(ms: number): void; res(): Res }) => Promise<void>, over: { slots?: number; reserve?: number; staleMs?: number; status?: number; stay?: number; lease?: number; idle?: number; keepMs?: number } = {}): Promise<void> {
  const ps = fakeList(models);
  if (over.status) ps.status = over.status;
  const lines: string[] = [];
  let t = 1_000_000;
  const reg = registry({ slots: over.slots ?? 3, reserve: over.reserve ?? 1, lease: over.lease, idle: over.idle, extra: `    ps: ${ps.url}\n${over.stay === undefined ? "" : `    stay_s: ${over.stay}\n`}` });
  const b = startBroker(reg, { port: 0, log: (l) => lines.push(l), now: () => t, keepMs: over.keepMs ?? 0, psMs: 3_600_000, psStaleMs: over.staleMs ?? 10_000 });
  try { await b.refresh(); await fn({ b, ps, lines, move: (ms) => { t += ms; b.turn(); }, res: () => b.residency().ollama }); } finally { await b.stop(); ps.stop(); }
}
const quiet = () => sleep(40);
/** Within the event, not at the broker's next tick (a second). */
const SOON = 300;

await withResidency([SMALL, "embed:4b"], async ({ b, ps, lines, move, res }) => {
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  const hello = await c.next("hello");
  ok((hello?.servers as { residency?: boolean }[])?.[0]?.residency === true, "the hello says the server's residency is read", hello?.servers);
  ok(lines.some((l) => /ollama: its loaded models read \(2 loaded\): the residency rule is on/.test(l)), "and the broker says the rule is on, with the count", lines);
  ok(res().loaded?.join() === `embed:4b,${SMALL}`, "the list as read", res());
  askM(c, "e1", SMALL, "background"); askM(c, "e2", SMALL, "background"); askM(c, "e3", SMALL, "background");
  ok(!!(await c.next("go", "e1")) && !!(await c.next("go", "e2")) && !!(await c.next("queued", "e3")), "asks for a loaded model go as before: two granted, the third waits for the room");
  askM(c, "k1", BIG, "background");
  ok(!!(await c.next("queued", "k1")), "an ask for a model not loaded queues while the loaded one has background running");
  move(59_000); await quiet();
  ok(!c.seen("go", "k1") && res().want === null, "and is not chosen before its max_wait_s (60 s unset)", res());
  move(2_000);
  ok(res().want === `ollama/${BIG}`, "past it, its model is the one the server drains for", res());
  done(c, "e1"); await quiet();
  ok(!c.seen("go", "e3") && !c.seen("go", "k1"), "the drain: the loaded model is granted no more background though it has the room, and the load waits for the call still running", b.snapshot());
  askM(s, "L1", SMALL, "live");
  ok(!!(await s.next("go", "L1")), "a live call to the loaded model is granted at once through the drain");
  done(s, "L1");
  done(c, "e2");
  ok(!!(await c.next("go", "k1", SOON)), "as the last of the other background ends, the ask is granted — then, not at the broker's next tick");
  ok(res().want === null && res().loading.join() === `ollama/${BIG}`, "and its model is loading: no pool is wanted, one has a call running unlisted", res());
  ok(lines.some((l) => l.includes(`ollama/${BIG}: not loaded, and granted after 61 s — ollama's other background waits while it loads`)), "said, with how long it waited", lines);
  await quiet();
  ok(!c.seen("go", "e3"), "while it loads, the other model's background still waits");
  // A slow load: 55 s before the list names it.
  move(55_000);
  ps.models = [BIG, "embed:4b"]; await b.refresh();
  ok(res().loading.length === 0 && res().loaded?.includes(BIG) === true, "the list names it: the load is over", res());
  await quiet();
  ok(!c.seen("go", "e3"), "the model it put out is not loaded now, and its ask — older than its own max_wait_s — does not go at once");
  move(59_000); await quiet();
  ok(!c.seen("go", "e3") && res().want === null, "nor before stay_s (60 unset) from the load's end, though that is 114 s from its grant: a model just loaded stays that long", res());
  move(2_000);
  ok(res().want === `ollama/${SMALL}`, "then the server drains for it in its turn", res());
  askM(c, "k2", BIG, "background"); await c.next("queued", "k2");
  done(c, "k1");
  ok(!!(await c.next("go", "e3", SOON)) && !c.seen("go", "k2"), "and it goes as the loaded model's call ends, that model's next ask held");
  await s.close(); await c.close();
});

await withResidency([], async ({ b, ps, move, res }) => {
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  askM(s, "x1", "Phi", "background");
  ok(!!(await s.next("go", "x1", SOON)), "with no model loaded, an ask goes at once: there is none to put out");
  askM(c, "y1", SMALL, "background");
  ok(!!(await c.next("queued", "y1")), "one load at a time: another model's ask waits while that one loads");
  ps.models = ["phi:latest"]; await b.refresh();
  ok(res().loading.length === 0, "a name with no tag is the list's :latest, whatever its case", res());
  done(s, "x1"); await quiet(); b.turn(); await quiet();
  ok(!c.seen("go", "y1"), "the loaded model's call just ended: it may have another coming, and is not put out at once");
  move(4_000); await quiet();
  ok(!c.seen("go", "y1"), "nor 4 s after");
  move(1_100);
  ok(!!(await c.next("go", "y1", SOON)), "BG_QUIET_S (5 s) with no background call and no live one lately, the next model goes (stay_s 0 here)", res());
  await s.close(); await c.close();
}, { stay: 0 });

await withResidency([SMALL], async ({ b, ps, move, res }) => {
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  askM(s, "L", SMALL, "live"); await s.next("go", "L"); done(s, "L"); await quiet();
  askM(c, "k", BIG, "background", { max_wait_s: 600 });
  ok(!!(await c.next("queued", "k")), "a loaded model with a live call just now is not put out for background, though it is idle");
  move(119_000); await quiet();
  ok(!c.seen("go", "k"), "nor 119 s after the live call");
  move(2_000);
  ok(!!(await c.next("go", "k", SOON)), "past LIVE_QUIET_S (120 s) with no live call, it goes", res());
  // The server holds no model now — the one a live call just used has gone — so there is none to put out.
  done(c, "k"); ps.models = [SMALL]; await b.refresh();
  askM(s, "L2", SMALL, "live"); await s.next("go", "L2"); done(s, "L2"); await quiet();
  ps.models = []; await b.refresh();
  askM(c, "k2", BIG, "background", { max_wait_s: 600 });
  ok(!!(await c.next("go", "k2", SOON)), "with no model listed, a live call and a background one seconds ago hold nothing back", res());
  await s.close(); await c.close();
});

await withResidency([SMALL], async ({ b, move, res }) => {
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  askM(s, "L", SMALL, "live"); await s.next("go", "L");
  askM(c, "k", BIG, "background", { max_wait_s: 600 }); await c.next("queued", "k");
  move(100_000); await quiet();
  ok(!c.seen("go", "k"), "a live call still running on a loaded model holds it, though no live call has ended lately", res());
  askM(c, "z", BIG, "background", { max_wait_s: 0 }); await c.next("queued", "z");
  b.turn(); await quiet();
  ok(res().want === null && !c.seen("go", "k"), "and no drain begins under it, for an ask come of age: the load might wait on the live call's model (review pass 1)", res());
  done(s, "L");
  ok(!!(await c.next("go", "k", SOON)), "the live call over, an ask whose max_wait_s is 0 has waited it: its model is chosen at once, and the oldest ask for it goes", res());
  await s.close(); await c.close();
});

await withResidency([SMALL], async ({ b, ps, move, res }) => {
  // The stay is the server's, not the asker's (review pass 1): a brain asking with max_wait_s 0 loads its model at
  // once on a server that has not just loaded, and no sooner than stay_s after the last background load.
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  askM(s, "e1", SMALL, "background"); await s.next("go", "e1");
  askM(c, "k1", BIG, "background", { max_wait_s: 0 });
  ok(await until(() => res().want === `ollama/${BIG}`, SOON), "max_wait_s 0, no load lately: chosen at once", res());
  done(s, "e1"); await c.next("go", "k1");
  ps.models = [BIG]; await b.refresh();
  askM(s, "e2", SMALL, "background", { max_wait_s: 0 }); await s.next("queued", "e2");
  move(59_000); await quiet();
  ok(!s.seen("go", "e2") && res().want === null, "max_wait_s 0, 59 s after a background load ended: not chosen — the model loaded stays the server's 60 s", res());
  move(2_000);
  ok(res().want === `ollama/${SMALL}`, "past it, chosen", res());
  // A live call's load does not begin the stay again (review pass 1: live loads 10 s apart kept background for
  // another model waiting 290 s).
  done(c, "k1"); await s.next("go", "e2");
  ps.models = [SMALL]; await b.refresh();
  askM(c, "k2", BIG, "background"); await c.next("queued", "k2");
  move(50_000);
  askM(s, "L", "third:1", "live"); await s.next("go", "L");
  ps.models = [SMALL, "third:1"]; await b.refresh();
  done(s, "L"); await quiet();
  move(11_000);
  ok(res().want === `ollama/${BIG}`, "an ask 61 s old is chosen 11 s after a live call's load: the stay runs from background's last load, 61 s ago", res());
  await s.close(); await c.close();
});

await withResidency([SMALL], async ({ b, ps, move, res }) => {
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  askM(c, "k1", BIG, "background"); await c.next("go", "k1");
  ps.models = [BIG]; await b.refresh();
  askM(s, "e1", SMALL, "background", { max_wait_s: 0 }); await s.next("queued", "e1");
  move(9_000); await quiet();
  ok(res().want === null, "stay_s: 10 in the registry, 9 s after a load: not chosen", res());
  move(1_100);
  ok(res().want === `ollama/${SMALL}`, "and at 10 s, chosen", res());
  // The stay holds for a loaded model gone idle too (review pass 2: put out 5 s after its last call, 85 loads for
  // 86 calls of two passes with 6 s between their calls).
  done(c, "k1"); await s.next("go", "e1");
  ps.models = [SMALL]; await b.refresh();
  done(s, "e1");
  askM(c, "k2", BIG, "background", { max_wait_s: 600 }); await c.next("queued", "k2");
  move(6_000); await quiet();
  ok(!c.seen("go", "k2"), "a loaded model idle 6 s, 6 s after background loaded it: not put out for an ask not yet due", res());
  move(4_100);
  ok(!!(await c.next("go", "k2", SOON)), "past its stay, idle, it is", res());
  await s.close(); await c.close();
}, { stay: 10 });

await withResidency([BIG], async ({ b, ps, lines, res }) => {
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  askM(c, "b1", BIG, "background"); askM(c, "b2", BIG, "background"); await c.next("go", "b2");
  askM(s, "L", SMALL, "live");
  ok(!!(await s.next("go", "L")), "a live call to a model not loaded is granted at once");
  ok(res().loading.join() === `ollama/${SMALL}` && lines.some((l) => l.includes(`ollama/${SMALL}: brain stable's live call to a model not loaded — ollama's other background waits while it loads`)), "and is a load under way, said with its brain", [res(), lines]);
  done(c, "b1"); askM(c, "b3", BIG, "background"); await c.next("queued", "b3"); await quiet();
  ok(!c.seen("go", "b3"), "while it waits to load, the loaded model is granted no more background, though it has the room");
  askM(c, "m1", SMALL, "background");
  ok(!!(await c.next("go", "m1")), "background to the live call's own model goes");
  // The calls to a model the list never named end: what the server holds is not known until a read BEGUN after that
  // ends. One under way as they ended read the list as it was, and frees nothing.
  ps.delay = 300;
  const hits = ps.hits;
  const under = b.refresh();
  await until(() => ps.hits > hits);
  done(s, "L"); done(c, "m1");
  await under;
  await quiet();
  ok(!c.seen("go", "b3"), "its calls ended with the list never naming it: a read under way as they ended frees no background — it listed the server as it was before");
  ok(!!(await c.next("go", "b3", 1500)) && ps.hits >= hits + 2, "the list is read again, unasked, and after that read the other background goes on", ps.hits - hits);
  await s.close(); await c.close();
});

await withResidency([SMALL], async ({ b, ps, move, res }) => {
  // A background load under way, then a live call to a third model not loaded: background to the first stops too.
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  askM(c, "k1", BIG, "background"); await c.next("go", "k1");
  ok(res().loading.join() === `ollama/${BIG}`, "an idle server loads the model asked for", res());
  ps.models = [SMALL, BIG];
  ok(await until(() => res().loading.length === 0, 2500), "while a load is under way the list is read every second, unasked: the load is seen over", res());
  ps.models = [SMALL]; await b.refresh();
  ok(res().loading.join() === `ollama/${BIG}`, "a model put out with its call still running is loading again", res());
  askM(s, "L", "third:1", "live"); await s.next("go", "L");
  askM(c, "k2", BIG, "background"); await c.next("queued", "k2"); await quiet();
  ok(!c.seen("go", "k2"), "a live call's load comes before background's: the model background was loading is granted no more while it waits", res());
  askM(c, "t1", "third:1", "background"); await c.next("go", "t1");
  done(s, "L");
  ok(!!(await c.next("go", "k2", SOON)), "the live call over, its model's background still running unlisted: background's own load goes on, at once", res());
  move(1);
  await s.close(); await c.close();
});

await withResidency([SMALL], async ({ b, ps, res }) => {
  // The pool the server drained for goes — its brain's socket closed — and the others go on; so too where the list
  // comes to name its model, another's live call having loaded it.
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary), t = await connect(b, KEYS.third);
  askM(s, "e1", SMALL, "background"); await s.next("go", "e1");
  askM(c, "k", BIG, "background", { max_wait_s: 0 }); await c.next("queued", "k");
  ok(await until(() => res().want === `ollama/${BIG}`), "the server drains for the model asked", res());
  askM(s, "e2", SMALL, "background"); await s.next("queued", "e2"); await quiet();
  ok(!s.seen("go", "e2"), "the loaded model's next ask held");
  await c.close();
  ok(!!(await s.next("go", "e2", SOON)) && res().want === null, "the asking brain gone, nothing is wanted and the loaded model's background goes on at once", res());
  done(s, "e2");
  askM(t, "k", BIG, "background", { max_wait_s: 0 }); await t.next("queued", "k");
  await until(() => res().want === `ollama/${BIG}`);
  askM(s, "e3", SMALL, "background"); await s.next("queued", "e3");
  ps.models = [SMALL, BIG]; await b.refresh();
  ok(res().want === null && !!(await t.next("go", "k", SOON)) && !!(await s.next("go", "e3", SOON)), "a wanted model the list now names is wanted no more: its ask and the other model's both go by the room", res());
  await s.close(); await t.close();
});

await withResidency([SMALL], async ({ b, lines, move, res }) => {
  // The bounds (review pass 1). A drain waits HOLD_S on background that never ends, then grants; a load holds the
  // server's other background HOLD_S, then its model is left out of the rule.
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  askM(s, "stuck", SMALL, "background"); await s.next("go", "stuck");
  askM(c, "k", BIG, "background", { max_wait_s: 0 }); await c.next("queued", "k");
  await until(() => res().want === `ollama/${BIG}`);
  askM(s, "e2", SMALL, "background"); await s.next("queued", "e2");
  move(119_000); await quiet();
  ok(!c.seen("go", "k") && !s.seen("go", "e2") && res().want === `ollama/${BIG}`, "a drain waits 119 s on a background call never given back", res());
  move(2_000);
  ok(!!(await s.next("go", "e2", SOON)) && res().want === null && !c.seen("go", "k"), "past HOLD_S (120 s) the drain is given up: the loaded model's background goes on, and no load is granted beside a call still running (review pass 2)", res());
  ok(lines.filter((l) => l.includes(`ollama/${BIG}: 1 background call on ollama still running 120 s into the drain for it: given up, and no drain begun for 120 s`)).length === 1, "said", lines);
  move(119_000); await quiet();
  ok(res().want === null, "nor is a drain begun again for 119 s", res());
  done(s, "stuck"); done(s, "e2");
  move(2_000);
  ok(!!(await c.next("go", "k", SOON)), "HOLD_S after, the drain is begun again, and with nothing running now the ask is granted", res());
  askM(s, "e3", SMALL, "background"); await s.next("queued", "e3");
  move(100_000); await quiet();
  askM(s, "L", BIG, "live"); await s.next("go", "L");
  move(19_000); await quiet();
  ok(!s.seen("go", "e3") && res().loading.length === 1, "the load, never listed, holds the other background 119 s — a live call joining it does not begin the count again", res());
  move(2_000);
  ok(!!(await s.next("go", "e3", SOON)) && res().unlisted.join() === BIG && res().loading.length === 0, "past HOLD_S its model is left out of the rule, and the others go on", res());
  ok(lines.filter((l) => l.includes(`ollama/${BIG}: a call to it has run 120 s and the server's loaded models do not name it: left out of the residency rule 120 s, or until it is listed`)).length === 1, "said", lines);
  move(119_000); await quiet();
  ok(res().unlisted.join() === BIG && res().loading.length === 0, "left out 119 s", res());
  move(2_000);
  askM(s, "e4", SMALL, "background"); await s.next("queued", "e4"); await quiet();
  ok(res().unlisted.length === 0 && res().loading.join() === `ollama/${BIG}` && !s.seen("go", "e4"), "then, its calls still running unlisted, held to again: turn about, so a load waiting on a busy model has the server's background out of its way half the time (review pass 2)", res());
  await s.close(); await c.close();
});

await withResidency([SMALL], async ({ b, ps, lines, res }) => {
  // The list unreadable: within psStaleMs the last list holds; past it, no rule, said once; read again, the rule is on.
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  askM(s, "e1", SMALL, "background"); await s.next("go", "e1");
  ps.status = 500; await b.refresh();
  ok(res().loaded?.join() === SMALL, "one failed read leaves the last list standing", res());
  askM(c, "k1", BIG, "background"); await c.next("queued", "k1"); await quiet();
  ok(!c.seen("go", "k1"), "and the rule with it");
  await sleep(120); await b.refresh();
  ok(res().loaded === null && !!(await c.next("go", "k1")), "unreadable past its bound, the server has no residency rule: the ask goes within the room", res());
  ok(lines.filter((l) => /ollama: its loaded models could not be read \(HTTP 500\): no residency rule there until they can/.test(l)).length === 1, "said once, with the status and none of the server's words", lines);
  await b.refresh();
  ok(lines.filter((l) => /could not be read/.test(l)).length === 1 && !lines.some((l) => l.includes("the server's own words")), "and not again at the next failed read");
  ps.status = 302; await b.refresh();
  ok(res().loaded === null && ps.hits > 0, "a redirect is not followed to a list elsewhere", res());
  ps.status = 200; ps.body = "{\"models\": \"many\"}"; await b.refresh();
  ok(res().loaded === null, "a 200 that is no list of models is no list", res());
  ps.body = `{"models":[{"name":"${BIG}"}],"pad":"${"x".repeat(1_100_000)}"}`; await b.refresh();
  ok(res().loaded === null, "a list over 1 MiB is not read to its end, and is no list", res());
  ps.body = null; await b.refresh();
  ok(res().loaded?.join() === SMALL && lines.some((l) => /ollama: its loaded models read again \(1 loaded\): the residency rule is on/.test(l)), "read again, the rule is on again, said", lines);
  await s.close(); await c.close();
}, { staleMs: 100 });

await withResidency([], async ({ b, ps, lines, res }) => {
  const c = await connect(b, KEYS.canary);
  ok(res().loaded === null && lines.some((l) => /could not be read \(a redirect, not followed\)/.test(l)), "a list that never read is no rule from the start, said with why", lines);
  askM(c, "a", SMALL, "background"); askM(c, "k", BIG, "background");
  ok(!!(await c.next("go", "a")) && !!(await c.next("go", "k")), "and every model's asks go by the room alone, as before 3c-1");
  ps.status = 200; ps.delay = 3000;
  const t0 = performance.now();
  await b.refresh();
  ok(lines.length > 0 && res().loaded === null && performance.now() - t0 < 2700, "a list that does not answer in 2 s is given up at 2 s", Math.round(performance.now() - t0));
  await c.close();
}, { status: 302 });

await withResidency([SMALL], async ({ b, ps, lines, move, res }) => {
  // A model the list never names — a name it writes another way — is left out of the rule after its calls ended at
  // three reads running.
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  const said = () => lines.filter((l) => l.includes("ollama/odd-name:latest: its calls ended at 3 reads running, the server's loaded models the same and never naming it — a name it lists another way, or a model it does not know: left out of the residency rule until it is listed")).length;
  const call = async (id: string) => {
    // Past the stay from the last call's end, a background load's, so the idle server is free for it.
    move(61_000);
    askM(c, id, "odd-name", "background");
    ok(!!(await c.next("go", id)), `call ${id} to a model the list never names is granted on the idle server`);
    const hits = ps.hits;
    done(c, id);
    await until(() => ps.hits > hits);
    await b.refresh();
  };
  await call("o1"); await call("o2");
  ok(said() === 0, "two calls ended unlisted, each read once and again: not yet left out", lines);
  ps.models = [SMALL, "odd-name:latest"]; await b.refresh(); ps.models = [SMALL]; await b.refresh();
  await call("o3"); await call("o4");
  ok(said() === 0, "listed once between, the count begins again: two more are not three running", lines);
  await call("o5");
  ok(said() === 1 && res().unlisted.join() === "odd-name:latest", "after three running it is said once, and left out of the rule", lines);
  askM(s, "e1", SMALL, "background"); await s.next("go", "e1");
  askM(c, "o6", "odd-name", "background"); askM(c, "k", BIG, "background");
  ok(!!(await c.next("go", "o6")) && !!(await c.next("queued", "k")) && !c.seen("go", "k"), "its asks go beside a busy loaded model, where another model not loaded waits");
  ps.models = [SMALL, "odd-name:latest"]; await b.refresh();
  ok(lines.some((l) => l.includes("ollama/odd-name:latest: listed now, and under the residency rule again")) && res().unlisted.length === 0, "listed at last, it is under the rule again, said", lines);
  await s.close(); await c.close();
});

await withResidency([SMALL], async ({ b, lines, res }) => {
  // Two streams to such a name overlap, so its pool never empties (review pass 1: counted at the pool's emptying, it
  // was never left out, and the loaded model's brain had 12 calls for 110).
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  askM(c, "o1", "Foo", "background"); askM(c, "o2", "Foo", "background"); await c.next("go", "o2");
  askM(s, "e1", SMALL, "background"); await s.next("queued", "e1");
  for (let i = 3; i <= 5; i++) {
    ok(res().loading.length === 1 && res().unlisted.length === 0 && !s.seen("go", "e1"), `${i - 3} of its calls ended and read: still loading, the loaded model's ask held`, res());
    done(c, `o${i - 2}`);
    askM(c, `o${i}`, "Foo", "background"); await c.next("go", `o${i}`);
    await b.refresh();
  }
  ok(res().unlisted.join() === "foo:latest" && !!(await s.next("go", "e1", SOON)), "its calls ended at three reads with one always running: left out, and the loaded model's ask goes", [res(), lines]);
  await s.close(); await c.close();
});

await withResidency([SMALL], async ({ b, ps, res }) => {
  // What a brain's calls can make the broker do: a read for each call ended unlisted, PS_GAP_MS apart at least; and
  // what it remembers of models named once, MAX_NOTED at most.
  const c = await connect(b, KEYS.canary);
  const hits = ps.hits, t0 = performance.now();
  for (let i = 0; i < 300; i++) {
    c.send({ op: "held", id: `h${i}`, base: BASE, model: `new-${i}`, cls: "background" }); done(c, `h${i}`);
    if (i % 30 === 29) await sleep(60);
  }
  c.send({ op: "ping", id: "end" }); await c.next("pong", "end", 5000);
  await sleep(300);
  const took = performance.now() - t0, reads = ps.hits - hits;
  ok(reads >= 2 && reads <= Math.floor(took / 250) + 1, `300 calls to 300 names ended over ${Math.round(took)} ms, in ten bursts: the list read ${reads} times, 250 ms apart at least`, [reads, took]);
  await b.refresh();
  ok(res().noted <= 256 && res().noted > 200 && res().loading.length === 0, "and of 300 names with a miss each, MAX_NOTED (256) remembered at most", res().noted);
  await c.close();
});

await withResidency([SMALL], async ({ b, res }) => {
  // An ask that names no model: no list could name it, so it is taken for loaded — and counted with the server's
  // background, which a drain waits on.
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  s.send({ op: "ask", id: "u1", base: BASE, cls: "background" });
  ok(!!(await s.next("go", "u1", SOON)) && res().loading.length === 0, "an unnamed model's ask goes by the room, and is no load", res());
  askM(c, "k", BIG, "background", { max_wait_s: 0 }); await c.next("queued", "k");
  await until(() => res().want === `ollama/${BIG}`); await quiet();
  ok(!c.seen("go", "k"), "a load waits for its call to end, as for any loaded model's (review pass 1: it was outside the count)");
  done(s, "u1");
  ok(!!(await c.next("go", "k", SOON)), "and goes as it ends");
  await s.close(); await c.close();
});

await withResidency([SMALL], async ({ b, move, res }) => {
  // Kept grants and the lease, under the rule: a closed socket's background grant is still running for a drain
  // until it is given back, and a load's grant taken back at lease_s ends the load.
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  askM(s, "e1", SMALL, "background"); await s.next("go", "e1");
  askM(c, "k", BIG, "background", { max_wait_s: 0 }); await c.next("queued", "k");
  await until(() => res().want === `ollama/${BIG}`);
  await s.close(); await sleep(150);
  ok(!c.seen("go", "k"), "a closed socket's grant, kept for its brain's return, still holds the drain");
  ok(!!(await c.next("go", "k", 1500)), "given back as the keeping ends, the ask is granted");
  const s2 = await connect(b, KEYS.stable);
  askM(s2, "e2", SMALL, "background"); await s2.next("queued", "e2");
  move(2_100);
  ok(!!(await c.next("lapsed", "k", 1500)) && !!(await s2.next("go", "e2", 1500)) && res().loading.length === 0, "the load's grant taken back at lease_s: the load is over, and after the list's read the other background goes on", res());
  await s2.close(); await c.close();
}, { keepMs: 500, lease: 2 });

await withResidency(Array.from({ length: 70 }, (_, i) => `m${i}:1`), async ({ b, res }) => {
  // A server of more than TURN_NOW pools is turned at the broker's tick, not at each ask.
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  for (let i = 0; i < 70; i++) askM(s, `g${i}`, `m${i}:1`, "background");
  await s.next("go", "g69");
  askM(c, "k", BIG, "background", { max_wait_s: 0 }); await c.next("queued", "k"); await quiet();
  ok(res().want === null, "70 pools: an ask due at once is not chosen at the ask", res().want);
  b.turn();
  ok(res().want === `ollama/${BIG}` && !c.seen("go", "k"), "but at the tick, where the drain for it begins", res().want);
  await s.close(); await c.close();
});

await withResidency([SMALL], async ({ b, res }) => {
  // An ask on a socket not heard from half its idle_s is no ask to drain for: its brain may be gone.
  const s = await connect(b, KEYS.stable);
  const raw = await rawBrain(b, KEYS.third);
  askM(s, "e1", SMALL, "background"); await s.next("go", "e1");
  raw.send({ op: "ask", id: "k", base: BASE, model: BIG, cls: "background", max_wait_s: 0 });
  ok(await until(() => res().want === `ollama/${BIG}`), "a socket just heard from: its ask is drained for", res());
  await sleep(4200); b.turn();
  askM(s, "e2", SMALL, "background");
  ok(res().want === null && !!(await s.next("go", "e2", SOON)), "silent 4 s of its 8 s: nothing is wanted, and the loaded model's background goes on", res());
  raw.destroy(); await s.close();
}, { idle: 8 });

await withResidency([SMALL], async ({ b, ps, lines, move, res }) => {
  // Review pass 2's cases. A live call that loads its model and ends before the list names it is live use of a loaded
  // model all the same.
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  askM(s, "L", "embed:4b", "live"); await s.next("go", "L");
  ps.models = [SMALL, "embed:4b"];
  done(s, "L");
  await until(() => res().loaded?.length === 2 && res().loading.length === 0);
  askM(c, "k", BIG, "background", { max_wait_s: 600 }); await c.next("queued", "k");
  move(119_000); await quiet();
  ok(!c.seen("go", "k"), "a live call that loaded its model and ended before the list named it: the models loaded are not put out for 119 s after", res());
  move(2_000);
  ok(!!(await c.next("go", "k", SOON)), "but at 120 s");
  // Three live calls to a name the list never shows, each read: left out, as background's are.
  for (let i = 1; i <= 3; i++) { askM(s, `o${i}`, "odd", "live"); await s.next("go", `o${i}`); const h = ps.hits; done(s, `o${i}`); await until(() => ps.hits > h); await b.refresh(); }
  ok(res().unlisted.includes("odd:latest"), "a live call's end unlisted is a miss too: three reads running, and the name is left out", res());
  await s.close(); await c.close();
});

await withResidency([SMALL], async ({ b, ps, lines, move, res }) => {
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  // Background waiting for a model goes with a live call to it, at once.
  askM(c, "e1", SMALL, "background"); await c.next("go", "e1");
  askM(c, "x1", "x:1", "background", { max_wait_s: 600 }); await c.next("queued", "x1");
  askM(s, "L", "x:1", "live"); await s.next("go", "L");
  ok(!!(await c.next("go", "x1", SOON)), "background waiting for the model a live call loads goes with it, not at the tick");
  // ...and, joining a live call's load, begins no stay: the next model's ask is not held for one.
  ps.models = [SMALL, "x:1"]; await b.refresh();
  done(s, "L"); done(c, "x1"); done(c, "e1"); await quiet();
  askM(c, "k", BIG, "background", { max_wait_s: 0 });
  ok(!!(await c.next("go", "k", SOON)), "a live call's load, background joining it, begins no stay: an ask due goes at once", res());
  // While that load is under way, a new ask for a model taken for loaded — unnamed, or left out — is held as any other's.
  c.send({ op: "ask", id: "u1", base: BASE, cls: "background" }); await c.next("queued", "u1"); await quiet();
  ok(!c.seen("go", "u1"), "an unnamed model's new ask is held while a load is under way");
  ps.models = [SMALL, "x:1", BIG]; await b.refresh();
  ok(!!(await c.next("go", "u1", SOON)), "and goes when the list names the model loading");
  await s.close(); await c.close();
});

await withResidency([SMALL], async ({ b, ps, move, res }) => {
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary), t = await connect(b, KEYS.third);
  // Of two models due, the one whose ask has waited longest goes first.
  askM(s, "e1", SMALL, "background"); await s.next("go", "e1");
  askM(c, "x", "x:1", "background", { max_wait_s: 30 }); await c.next("queued", "x");
  move(10_000);
  askM(t, "y", "y:1", "background", { max_wait_s: 10 }); await t.next("queued", "y");
  move(21_000);
  ok(res().want === "ollama/x:1", "two models due at once: the server drains for the one asked for first", res());
  // A call re-registered (`held`) on a model not loaded is a load under way, and the drain's choice is made again after.
  t.send({ op: "held", id: "h", base: BASE, model: "z:1", cls: "background" }); await t.next("go", "h");
  ok(res().want === null && res().loading.join() === "ollama/z:1", "a held on a model not loaded: a load under way, and nothing wanted meanwhile", res());
  // A load background began whose calls end with the list never naming it loaded nothing: it begins no stay.
  const h = ps.hits;
  done(t, "h"); await until(() => ps.hits > h); await b.refresh();
  ok(res().want === "ollama/x:1", "a load whose calls ended unlisted begins no stay: the asks long due are drained for at once", res());
  await s.close(); await c.close(); await t.close();
});

await withResidency([SMALL], async ({ b, ps, move, res }) => {
  // A model's hold is counted for each load of it: put out with its call still running, it is loading again, and
  // held to HOLD_S from then.
  const c = await connect(b, KEYS.canary);
  askM(c, "k", BIG, "background"); await c.next("go", "k");
  move(10_000); ps.models = [SMALL, BIG]; await b.refresh();
  move(200_000); ps.models = [SMALL]; await b.refresh();
  ok(res().loading.join() === `ollama/${BIG}`, "listed, then put out with its call running: loading again", res());
  move(119_000); await quiet();
  ok(res().loading.length === 1 && res().unlisted.length === 0, "and 119 s into this load it is not left out, 329 s after its first began", res());
  move(2_000);
  ok(res().unlisted.join() === BIG, "but at 120 s", res());
  // A live call's load is held to the same bound.
  const s = await connect(b, KEYS.stable);
  askM(s, "L", "third:1", "live"); await s.next("go", "L");
  move(119_000); await quiet();
  ok(res().loading.join() === "ollama/third:1", "a live call's load holds the others 119 s", res());
  move(2_000);
  ok(res().unlisted.includes("third:1") && !res().loading.includes("ollama/third:1"), "and is left out at 120 s as background's is", res());
  await s.close(); await c.close();
});

await withResidency([SMALL], async ({ b, lines, res }) => {
  const c = await connect(b, KEYS.canary);
  c.send({ op: "held", id: "h1", base: BASE, model: "junk:1", cls: "background" }); await c.next("go", "h1");
  c.send({ op: "held", id: "h2", base: BASE, model: "junk:2", cls: "background" }); await c.next("go", "h2");
  const said = lines.filter((l) => l.includes("brain canary re-registers a call to a model not loaded — ollama's other background waits while it loads"));
  ok(said.length === 1 && said[0].startsWith("ollama/junk:1:"), "a brain's calls re-registered on models not loaded are said, once a minute a brain", lines);
  const s = await connect(b, KEYS.stable);
  askM(c, "l1", "junk:3", "live"); askM(c, "l2", "junk:4", "live"); askM(s, "l3", "junk:5", "live"); await s.next("go", "l3"); await c.next("go", "l2");
  const live = lines.filter((l) => l.includes("live call to a model not loaded"));
  ok(live.length === 2 && live[0].includes("ollama/junk:3: brain canary's") && live[1].includes("ollama/junk:5: brain stable's"), "and its live calls to such models likewise: each brain's said, a second of the same brain's not", live);
  await s.close(); await c.close();
});

await withResidency([SMALL], async ({ b, ps, lines, move, res }) => {
  // A model whose load changes the list and never shows in it — it put a model out and did not load (review pass 2:
  // left out of the rule, its failed loads came unpaced, each putting out what was idle).
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  const fail = async (id: string) => {
    askM(c, id, "fail:1", "background", { max_wait_s: 600 });
    if (!(await c.next("go", id, SOON))) return false;
    ps.models = [];
    const h = ps.hits;
    done(c, id); await until(() => ps.hits > h); await b.refresh();
    return true;
  };
  ok(await fail("f1"), "an idle server loads a model asked for");
  askM(c, "f2", "fail:1", "background", { max_wait_s: 600 }); await c.next("queued", "f2");
  askM(s, "e1", SMALL, "background");
  ok(!!(await s.next("go", "e1", SOON)) && !c.seen("go", "f2"), "its call ended, the list changed and never naming it: the model it put out is loaded again at once, before its own next ask", res());
  ps.models = [SMALL]; await b.refresh(); done(s, "e1"); await quiet();
  move(59_000); await quiet();
  ok(!c.seen("go", "f2"), "and its next load waits BACKOFF_S: not 59 s after, on an idle server (stay_s 0 here)", res());
  move(2_000);
  ok(!!(await c.next("go", "f2", SOON)), "but at 60 s");
  ps.models = []; { const h = ps.hits; done(c, "f2"); await until(() => ps.hits > h); await b.refresh(); }
  ps.models = [SMALL]; await b.refresh();
  askM(c, "f3", "fail:1", "background", { max_wait_s: 600 }); await c.next("queued", "f3");
  move(119_000); await quiet();
  ok(!c.seen("go", "f3"), "a second such load: the next waits twice that, not 119 s after");
  move(2_000);
  ok(!!(await c.next("go", "f3", SOON)), "but at 120 s");
  ps.models = []; { const h = ps.hits; done(c, "f3"); await until(() => ps.hits > h); await b.refresh(); }
  ok(lines.filter((l) => l.includes("ollama/fail:1: its calls ended 3 times with the server's loaded models changed and never naming it — a model that does not load: its next load waits 180 s, and 60 s more each time")).length === 1 && res().unlisted.length === 0, "the third is said, with the wait; it is not left out of the rule", lines);
  await s.close(); await c.close();
}, { stay: 0 });

await withResidency([SMALL], async ({ b, move, res }) => {
  // A live call never given back: brains give theirs up at 120 s, so one running HOLD_S and more holds back no load
  // (review pass 2: it stopped every background load until lease_s, unsaid).
  const s = await connect(b, KEYS.stable), c = await connect(b, KEYS.canary);
  askM(s, "leak", SMALL, "live"); await s.next("go", "leak");
  askM(c, "k", BIG, "background", { max_wait_s: 0 }); await c.next("queued", "k");
  move(119_000); await quiet();
  ok(res().want === null && !c.seen("go", "k"), "a live call 119 s old holds back the drain for an ask due", res());
  move(2_000);
  ok(!!(await c.next("go", "k", SOON)), "one 121 s old does not");
  await s.close(); await c.close();
});

await withBroker(registry(), async (b) => {
  const c = await connect(b, KEYS.canary);
  const hello = await c.next("hello");
  ok((hello?.servers as { residency?: boolean }[])?.[0]?.residency === false && Object.keys(b.residency()).length === 0, "a server whose registry entry names no list has no residency, and its hello says so", hello?.servers);
  await c.close();
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
