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
    await until(() => (b.snapshot()["ollama/qwen3:8b"]?.used.stable ?? 0) > 0);
    const before = b.snapshot()["ollama/qwen3:8b"].used.stable;
    t += 300_000;
    const after = b.snapshot()["ollama/qwen3:8b"].used.stable;
    ok(before === 10_000 && Math.abs(after - 5_000) <= 1, `a brain's slot time is charged as held (${before} ms) and halves in ${300} s (${after} ms)`, [before, after]);
    t += 300_000;
    ok(Math.abs(b.snapshot()["ollama/qwen3:8b"].used.stable - 2_500) <= 1, "and halves again", b.snapshot());
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
    await until(() => (b.snapshot()["ollama/qwen3:8b"]?.background ?? 1) === 0);
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

section("[8] a close gives back its own, a pool goes once empty, the socket cap");
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
  const net = await import("node:net");
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

section("[12] per_model: false, the hello, a request's age, the logs, the door's Host");
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
      const sock = require("node:net").connect(b.port, "127.0.0.1", () => sock.write(`GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
      let got = ""; sock.on("data", (d: Buffer) => { got += d; }); sock.on("end", () => res(got.split("\r\n")[0])); sock.on("error", () => res("error"));
    });
    answers.push(r);
  }
  ok(answers.every((a) => !/ 500 /.test(a)), "a Host header no URL reads is no 500", answers);
  ok((await fetch(`http://127.0.0.1:${b.port}/health`)).ok, "and the broker answers on");
});

section("[13] the base is the brain's, read the same way");
for (const base of ["http://Host.Containers.Internal:11434/v1/", "https://openrouter.ai/api/v1", "http://u:p@h:1/v1//", "not a url/", "http://[::1]:11434/v1"]) {
  ok(normalisedBase(base) === slotsBase(base), `normalisedBase matches server-portable/slots.ts's for ${base}`, [normalisedBase(base), slotsBase(base)]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
