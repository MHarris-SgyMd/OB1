#!/usr/bin/env bun
/**
 * test-slot-relay.ts — the coordinator's slot relay (SMD-3379 PR 3b-1), end to end and with no database: the host's
 * broker (deploy/federated/broker.ts) started in this process on a free port, the relay (db/slot-relay.ts) as the
 * coordinator opens it, and passes as child processes started with an IPC channel, as supervise.ts starts them, each
 * installing server-portable/slots.ts's hook and making model calls through the seam. The children's database is one
 * nothing answers, so a call that takes its own share runs at once (the semaphore failing open), uncounted at the
 * broker — which is how a test tells `own` from a broker grant.
 *
 *   bun test-slot-relay.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hashKey, parseRegistry, startBroker, type Broker, type Registry } from "../deploy/federated/broker.ts";
import { startRelay, type Relay, type RelayPort } from "./slot-relay.ts";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, msg: string, detail?: unknown): void => {
  if (cond) pass++;
  else { fail++; console.error(`  ✗ ${msg}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
};
const section = (name: string) => console.log(`\n${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  const end = performance.now() + ms;
  while (!cond()) { if (performance.now() > end) return false; await sleep(5); }
  return true;
}

const BASE = "http://host.containers.internal:11434/v1";
const KEYS = { stable: "slot_relay-stable", canary: "slot_relay-canary" };
const SP = resolve(import.meta.dir, "../server-portable");

function registry(over: { slots?: number; reserve?: number; warm?: number } = {}): Registry {
  const { registry: r, problems } = parseRegistry(`broker:\n  warm_s: ${over.warm ?? 0}\nservers:\n  ollama:\n    bases: [${BASE}]\n    slots: ${over.slots ?? 1}\n    reserve: ${over.reserve ?? 0}\nbrains:\n${Object.entries(KEYS).map(([n, k]) => `  ${n}:\n    key: "${hashKey(k)}"\n`).join("")}`);
  if (!r) throw new Error(problems.join("; "));
  return r;
}
const pool = (b: Broker) => b.snapshot()["ollama/m"] ?? { live: 0, background: 0, waiting: {}, used: {} };

// A pass, as far as its model calls go: the hook installed as a pass's entry installs it, then calls on command.
const DIR = mkdtempSync(join(tmpdir(), "ob1-slot-relay-"));
const CHILD = join(DIR, "pass.ts");
writeFileSync(CHILD, `
import { installBackgroundSlots } from ${JSON.stringify(join(SP, "slots.ts"))};
import { asPass, modelCall, withCallWaits } from ${JSON.stringify(join(SP, "model-call.ts"))};
const send = (m) => process.send?.(m);
installBackgroundSlots({ url: "postgres://nobody@127.0.0.1:1/none", raw: process.argv[3] ?? "chat=1", connectS: 1, log: (l) => send({ ev: "log", line: l }) });
const ends = new Map();
async function call(m) {
  const stop = m.abortAfter ? AbortSignal.timeout(m.abortAfter) : undefined;
  const at = performance.now();
  try {
    await withCallWaits({ waiting: () => send({ ev: "waiting", id: m.id }), running: () => {} }, () => asPass(m.pass ?? "extract", () =>
      modelCall({ type: "chat", model: "m", base: m.base ?? ${JSON.stringify(BASE)}, purpose: "test", cls: m.cls ?? "background", ...(stop ? { signal: stop } : {}) }, async () => {
        send({ ev: "run", id: m.id, ms: Math.round(performance.now() - at) });
        await new Promise((r) => ends.set(m.id, r));
      })));
    send({ ev: "ended", id: m.id });
  } catch (e) { send({ ev: "stopped", id: m.id }); }
}
process.on("message", (m) => {
  if (m?.cmd === "call") void call(m);
  else if (m?.cmd === "raw") process.send(m.frame);
  else if (m?.cmd === "burst") {
    // n calls at once, each ending as it runs: how many ran, and the most at once.
    let ran = 0, now = 0, most = 0;
    void Promise.all(Array.from({ length: m.n }, (_, i) => modelCall({ type: "chat", model: "m", base: ${JSON.stringify(BASE)}, purpose: "test", cls: "background" }, async () => {
      now++; most = Math.max(most, now); ran++;
      await new Promise((r) => setTimeout(r, 1));
      now--;
    }))).then(() => send({ ev: "burst", ran, most }));
  }
  else if (m?.cmd === "end") ends.get(m.id)?.();
  else if (m?.cmd === "once") void call({ id: "once" }).then(() => send({ ev: "onceDone" }));
});
send({ ev: "ready" });
// A follower stays up on its own handles (its database, its timers), not on the relay's channel: so does this one,
// but for "once", which does one call and has nothing else.
if (process.argv[2] === "once") { void call({ id: "once" }); setTimeout(() => ends.get("once")?.(), 50); }
else if (process.argv[2] !== "none") setInterval(() => {}, 1000);
`);

type Ev = { ev: string; id?: string; line?: string; ms?: number };
type Pass = { evs: Ev[]; port: RelayPort | null; proc: ReturnType<typeof Bun.spawn>; cmd(m: object): void; saw(ev: string, id?: string): boolean; wait(ev: string, id?: string, ms?: number): Promise<boolean> };

/** A pass started as supervise.ts starts one under a relay: a channel, OB1_SLOT_RELAY=ipc, the relay's frames to its port. */
async function startPass(port: RelayPort | null, opts: { relayEnv?: boolean; mode?: string; raw?: string } = {}): Promise<Pass> {
  const evs: Ev[] = [];
  const proc = Bun.spawn([process.execPath, "--no-env-file", CHILD, opts.mode ?? "keep", ...(opts.raw ? [opts.raw] : [])], {
    env: { PATH: process.env.PATH ?? "", HOME: DIR, ...(opts.relayEnv === false ? {} : { OB1_SLOT_RELAY: "ipc" }) },
    stdio: ["ignore", "inherit", "inherit"],
    ipc: (m: Ev & { slot?: string }) => { if (m && typeof m === "object" && "slot" in m) port?.onMessage(m); else evs.push(m); },
    serialization: "json",
  });
  port?.attach((m) => { if (proc.exitCode === null && proc.signalCode === null) proc.send(m); });
  void proc.exited.then(() => port?.detach());
  const saw = (ev: string, id?: string) => evs.some((e) => e.ev === ev && (id === undefined || e.id === id));
  const p: Pass = { evs, port, proc, cmd: (m) => proc.send(m), saw, wait: (ev, id, ms = 3000) => until(() => saw(ev, id), ms) };
  await p.wait("ready", undefined, 5000);
  return p;
}
const kill = async (p: Pass) => { if (p.proc.exitCode === null && p.proc.signalCode === null) { p.proc.kill("SIGKILL"); await p.proc.exited; } };

async function withBroker(reg: Registry, fn: (b: Broker, logs: string[]) => Promise<void>, port = 0): Promise<void> {
  const logs: string[] = [];
  const b = startBroker(reg, { port, log: (l) => logs.push(l) });
  try { await fn(b, logs); } finally { await b.stop(); }
}
const relayTo = (b: Broker, key: string, logs: string[] = []) => startRelay({ url: `ws://127.0.0.1:${b.port}/v1/slots`, key, log: (l) => logs.push(l), reconnectMs: { first: 50, max: 200 } });
const upOf = (r: Relay) => until(() => r.state().broker === "up", 3000);

section("[1] a pass's background calls take the broker's slots through the relay");
await withBroker(registry({ slots: 1 }), async (b) => {
  const relay = relayTo(b, KEYS.stable);
  ok(await upOf(relay), "the relay reaches the broker");
  const a = await startPass(relay.port("sleep"));
  a.cmd({ cmd: "call", id: "c1" });
  ok(await a.wait("run", "c1"), "a background call runs");
  ok(await until(() => pool(b).background === 1), "on a broker grant, counted there", b.snapshot());
  a.cmd({ cmd: "call", id: "c2" });
  ok(await a.wait("waiting", "c2"), "a second, the slot taken, is told it waits");
  ok(!a.saw("run", "c2") && pool(b).waiting.stable === 1, "and waits at the broker, not on its own share", b.snapshot());
  a.cmd({ cmd: "end", id: "c1" });
  ok(await a.wait("run", "c2"), "the first ended, the second runs");
  a.cmd({ cmd: "end", id: "c2" });
  ok(await a.wait("ended", "c2") && await until(() => pool(b).background === 0), "and its done gives the slot back", b.snapshot());
  ok(relay.state().asks === 0 && relay.state().grants === 0, "the relay holds nothing after", relay.state());
  await kill(a); await relay.stop();
});

section("[2] two passes share the brain's slots; two brains split them");
await withBroker(registry({ slots: 1 }), async (b) => {
  const relay = relayTo(b, KEYS.stable);
  await upOf(relay);
  const [x, y] = [await startPass(relay.port("extract")), await startPass(relay.port("consolidate"))];
  x.cmd({ cmd: "call", id: "x1" });
  await x.wait("run", "x1");
  y.cmd({ cmd: "call", id: "y1" });
  ok(await y.wait("waiting", "y1") && !y.saw("run", "y1"), "the brain's second pass waits for the slot its first holds: the brain's calls are one at the broker");
  x.cmd({ cmd: "end", id: "x1" });
  ok(await y.wait("run", "y1"), "and takes it as it is given back");
  y.cmd({ cmd: "end", id: "y1" });
  await y.wait("ended", "y1");
  await kill(x); await kill(y); await relay.stop();
});

await withBroker(registry({ slots: 1 }), async (b) => {
  const [rs, rc] = [relayTo(b, KEYS.stable), relayTo(b, KEYS.canary)];
  await upOf(rs); await upOf(rc);
  const [s, c] = [await startPass(rs.port("sleep")), await startPass(rc.port("sleep"))];
  s.cmd({ cmd: "call", id: "s1" }); await s.wait("run", "s1");
  s.cmd({ cmd: "call", id: "s2" }); c.cmd({ cmd: "call", id: "c1" });
  await s.wait("waiting", "s2"); await c.wait("waiting", "c1");
  await sleep(30);
  s.cmd({ cmd: "end", id: "s1" });
  ok(await c.wait("run", "c1") && !s.saw("run", "s2"), "two brains, each through its own coordinator: the slot goes to the brain that has had less of it");
  c.cmd({ cmd: "end", id: "c1" });
  ok(await s.wait("run", "s2"), "then back");
  s.cmd({ cmd: "end", id: "s2" });
  await kill(s); await kill(c); await rs.stop(); await rc.stop();
});

section("[3] a pass killed mid-call gives back what it held");
await withBroker(registry({ slots: 1 }), async (b) => {
  const relay = relayTo(b, KEYS.stable);
  await upOf(relay);
  const a = await startPass(relay.port("sleep"));
  a.cmd({ cmd: "call", id: "k1" }); await a.wait("run", "k1");
  a.cmd({ cmd: "call", id: "k2" }); await a.wait("waiting", "k2");
  await kill(a);
  ok(await until(() => !("ollama/m" in b.snapshot())), "its grant and its waiting ask are gone from the broker once it ends", b.snapshot());
  ok(relay.state().asks === 0 && relay.state().grants === 0, "and from the relay", relay.state());
  await relay.stop();
});

section("[4] the broker away: a grace, then own shares, and every call running counted on its return");
{
  const reg = registry({ slots: 1 });
  const logs: string[] = [];
  let b = startBroker(reg, { port: 0, log: () => {} });
  const port = b.port;
  const relay = relayTo(b, KEYS.stable, logs);
  await upOf(relay);
  const a = await startPass(relay.port("sleep"));
  a.cmd({ cmd: "call", id: "r1" }); await a.wait("run", "r1");
  a.cmd({ cmd: "call", id: "r2" }); await a.wait("waiting", "r2");
  await b.stop();
  const lostAt = performance.now();
  ok(await until(() => relay.state().broker === "down"), "the relay sees the broker gone", relay.state());
  ok(!(await a.wait("run", "r2", 2000)), "the waiting call waits out the grace for it, not on its own share at once");
  ok(await a.wait("run", "r2", 4000), "then runs on the pass's own share");
  const waitedMs = performance.now() - lostAt;
  ok(waitedMs >= 2500, `after GRACE_MS (${Math.round(waitedMs)} ms)`, waitedMs);
  a.cmd({ cmd: "call", id: "r3" });
  ok(await a.wait("run", "r3"), "a call asked past the grace runs on its own share at once");
  ok(logs.filter((l) => /asks wait 3 s for it/.test(l)).length === 1, "the loss said once for the spell", logs);
  b = startBroker(reg, { port, log: () => {} });
  try {
    ok(await upOf(relay), "the broker back, the relay reconnects");
    ok(await until(() => pool(b).background === 3), "and every call still running is counted there — the grant and the two on the pass's own share", b.snapshot());
    ok(logs.some((l) => /restarted.*3 calls still running re-registered/.test(l)), "saying the broker restarted", logs);
    a.cmd({ cmd: "end", id: "r1" }); a.cmd({ cmd: "end", id: "r2" }); a.cmd({ cmd: "end", id: "r3" });
    ok(await until(() => pool(b).background === 0), "their dones land at the new broker", b.snapshot());
  } finally { await kill(a); await relay.stop(); await b.stop(); }
}

{
  // A link lost and back within the grace: the waiting ask is asked again, its time carried — never its own share.
  const reg = registry({ slots: 1 });
  let b = startBroker(reg, { port: 0, log: () => {} });
  const port = b.port;
  const relay = relayTo(b, KEYS.stable);
  await upOf(relay);
  const a = await startPass(relay.port("sleep"));
  a.cmd({ cmd: "call", id: "q1" }); await a.wait("run", "q1");
  a.cmd({ cmd: "call", id: "q2" }); await a.wait("waiting", "q2");
  await b.stop();
  await until(() => relay.state().broker === "down");
  b = startBroker(reg, { port, log: () => {} });
  try {
    ok(await upOf(relay), "the broker back within the grace");
    ok(await until(() => pool(b).background === 1 && pool(b).waiting.stable === 1), "the running call re-registered and the waiting ask asked again", b.snapshot());
    ok(!a.saw("run", "q2"), "the waiting call never ran on its own share");
    a.cmd({ cmd: "end", id: "q1" });
    ok(await a.wait("run", "q2"), "it runs on the broker's grant once the slot is given back");
    a.cmd({ cmd: "end", id: "q2" });
    ok(await until(() => pool(b).background === 0), "and its done lands", b.snapshot());
  } finally { await kill(a); await relay.stop(); await b.stop(); }
}

{
  // An ask parked over a lost link carries its time waited to the next socket: aged there (max_wait_s 1, parked 1.2 s), it
  // goes before an ask of the same brain put first after the reconnect — asked afresh it would not have aged.
  const reg = registry({ slots: 1 });
  let b = startBroker(reg, { port: 0, log: () => {} });
  const port0 = b.port;
  const relay = relayTo(b, KEYS.stable);
  await upOf(relay);
  const got: { slot: string; id: string }[] = [];
  const port = relay.port("probe");
  port.attach((m) => got.push(m));
  port.onMessage({ slot: "ask", id: "hold", base: BASE, model: "m", cls: "background" });
  await until(() => got.some((m) => m.slot === "go" && m.id === "hold"));
  await b.stop();
  await until(() => relay.state().broker === "down");
  port.onMessage({ slot: "ask", id: "aged", base: BASE, model: "m", cls: "background", max_wait_s: 1 });
  await sleep(1200);
  b = startBroker(reg, { port: port0, log: () => {} });
  try {
    await upOf(relay);
    await until(() => pool(b).background === 1 && pool(b).waiting.stable === 1);
    port.onMessage({ slot: "ask", id: "first", base: BASE, model: "m", cls: "background", first: true });
    await until(() => pool(b).waiting.stable === 2);
    port.onMessage({ slot: "done", id: "hold" });
    ok(await until(() => got.some((m) => m.slot === "go" && (m.id === "aged" || m.id === "first"))) && got.some((m) => m.slot === "go" && m.id === "aged") && !got.some((m) => m.slot === "go" && m.id === "first"),
      "an ask parked over a lost link keeps its age at the next broker (waited_s): aged, it goes before a later ask put first", got);
    port.detach();
  } finally { await relay.stop(); await b.stop(); }
}

section("[7] past the broker's limit: asks wait in the relay, never on their own share");
await withBroker(registry({ slots: 1 }), async (b) => {
  const relay = relayTo(b, KEYS.stable);
  await upOf(relay);
  const a = await startPass(relay.port("sleep"));
  let most = 0;
  const watch = setInterval(() => { most = Math.max(most, pool(b).background); }, 2);
  a.cmd({ cmd: "burst", n: 1100 });
  ok(await a.wait("burst", undefined, 60_000), "1100 calls at once all run");
  clearInterval(watch);
  const burst = a.evs.find((e) => e.ev === "burst") as unknown as { ran: number; most: number };
  ok(burst.ran === 1100 && burst.most === 1 && most <= 1, `one at a time on the one slot, none on its own share beside it (ran ${burst.ran}, most at once ${burst.most}, the broker's most ${most})`);
  ok(relay.state().parked === 0 && relay.state().asks === 0, "the relay holds nothing after", relay.state());
  await kill(a); await relay.stop();
});

section("[8] a broker frozen, a bad frame, a refused key, `off`");
{
  // The broker as a process of its own, frozen (SIGSTOP) with its socket open: the relay drops it once it has said
  // nothing for idle_s, and the waiting call runs on its own share after the grace.
  const brokerFile = resolve(import.meta.dir, "../deploy/federated/broker.ts");
  const regFile = join(DIR, "frozen.yaml");
  const port = 18_400 + Math.floor(Math.random() * 400);
  writeFileSync(regFile, `broker:\n  port: ${port}\n  idle_s: 8\n  warm_s: 0\nservers:\n  ollama:\n    bases: [${BASE}]\n    slots: 1\n    reserve: 0\nbrains:\n  stable:\n    key: "${hashKey(KEYS.stable)}"\n`);
  const bp = Bun.spawn([process.execPath, "--no-env-file", brokerFile, "--registry", regFile], { stdio: ["ignore", "ignore", "inherit"] });
  const logs: string[] = [];
  const relay = startRelay({ url: `ws://127.0.0.1:${port}/v1/slots`, key: KEYS.stable, log: (l) => logs.push(l), reconnectMs: { first: 50, max: 200 } });
  try {
    ok(await until(() => relay.state().broker === "up", 8000), "the relay reaches a broker of its own process");
    const a = await startPass(relay.port("sleep"));
    a.cmd({ cmd: "call", id: "f1" }); await a.wait("run", "f1");
    a.cmd({ cmd: "call", id: "f2" }); await a.wait("waiting", "f2");
    bp.kill("SIGSTOP");
    const t0 = performance.now();
    ok(await a.wait("run", "f2", 25_000), "the broker frozen, the waiting call runs on its own share");
    const took = performance.now() - t0;
    ok(took > 6000 && took < 20_000, `after the relay heard nothing for idle_s and the grace (${Math.round(took)} ms)`, took);
    ok(logs.some((l) => /silent for 8 s/.test(l)), "saying the broker went silent", logs);
    a.cmd({ cmd: "end", id: "f1" }); a.cmd({ cmd: "end", id: "f2" });
    await kill(a);
  } finally {
    bp.kill("SIGCONT"); bp.kill("SIGKILL"); await bp.exited;
    await relay.stop();
  }
}

await withBroker(registry({ slots: 1 }), async (b) => {
  const logs: string[] = [];
  const relay = relayTo(b, KEYS.stable, logs);
  await upOf(relay);
  const boot = relay.state().boot;
  const a = await startPass(relay.port("sleep"));
  a.cmd({ cmd: "call", id: "g1" }); await a.wait("run", "g1");
  const owns: unknown[] = [];
  const port = relay.port("probe");
  port.attach((m) => owns.push(m));
  port.onMessage({ slot: "ask", id: "big", base: "h".repeat(5000), model: "m", cls: "background" });
  port.onMessage({ slot: "ask", id: "neg", base: BASE, model: "m", cls: "background", max_wait_s: -1 });
  await sleep(200);
  ok(JSON.stringify(owns) === JSON.stringify([{ slot: "own", id: "big" }, { slot: "own", id: "neg" }]), "a frame the broker would refuse is answered own, never passed on", owns);
  ok(relay.state().broker === "up" && relay.state().boot === boot && !logs.some((l) => /was lost|the broker refused/.test(l)) && pool(b).background === 1, "and the brain's socket stays up, the pass's grant with it, the broker never asked", { s: relay.state(), logs });
  port.onMessage({ slot: "running", id: "own1", base: BASE, model: "m", cls: "background" });
  ok(await until(() => pool(b).background === 2), "a call a pass runs on its own share, the broker up, is counted there at once", b.snapshot());
  port.onMessage({ slot: "done", id: "own1" });
  ok(await until(() => pool(b).background === 1), "and given back at its done", b.snapshot());
  a.cmd({ cmd: "end", id: "g1" });
  await kill(a); await relay.stop();

  const refusedLogs: string[] = [];
  const refused = relayTo(b, "slot_not-a-brain", refusedLogs);
  ok(await until(() => refusedLogs.some((l) => /refused this brain's key \(401\)/.test(l)), 5000), "a key the broker refuses is named, not read as an outage", refusedLogs);
  await refused.stop();

  const relay2 = relayTo(b, KEYS.stable);
  await upOf(relay2);
  const off = await startPass(relay2.port("sleep"), { raw: "off" });
  off.cmd({ cmd: "call", id: "o1" });
  ok(await off.wait("run", "o1") && await until(() => pool(b).background === 1), "OB1_BACKGROUND_SLOTS=off holds nothing to the pass's own shares but leaves the broker in", b.snapshot());
  off.cmd({ cmd: "end", id: "o1" });
  await kill(off); await relay2.stop();
});

section("[5] what the broker does not broker, a live call, a stop while waiting");
await withBroker(registry({ slots: 1 }), async (b) => {
  const relay = relayTo(b, KEYS.stable);
  await upOf(relay);
  const a = await startPass(relay.port("sleep"));
  a.cmd({ cmd: "call", id: "u1", base: "https://api.example.invalid/v1" });
  ok(await a.wait("run", "u1") && !("ollama/m" in b.snapshot()), "a base the broker has no server for runs on the pass's own share");
  const u1 = a.evs.find((e) => e.ev === "run" && e.id === "u1")?.ms ?? Infinity;
  ok(u1 < 500, `at once, on the broker's word, not after RELAY_ANSWER_MS (${u1} ms)`, u1);
  a.cmd({ cmd: "end", id: "u1" });
  a.cmd({ cmd: "call", id: "bg" }); await a.wait("run", "bg");
  a.cmd({ cmd: "call", id: "lv", cls: "live" });
  ok(await a.wait("run", "lv"), "a live call runs at once, the slot taken by a background one");
  ok(await until(() => pool(b).live === 1), "and is counted at the broker while it runs", b.snapshot());
  a.cmd({ cmd: "end", id: "lv" });
  ok(await until(() => pool(b).live === 0), "and its done lands", b.snapshot());
  a.cmd({ cmd: "call", id: "ab", abortAfter: 200 });
  await a.wait("waiting", "ab");
  ok(await a.wait("stopped", "ab") && !a.saw("run", "ab"), "a stop while it waits ends the call");
  ok(await until(() => !pool(b).waiting.stable), "and withdraws its ask at the broker", b.snapshot());
  a.cmd({ cmd: "end", id: "bg" });
  await kill(a); await relay.stop();
});

section("[6] no relay, a silent relay, a pass that exits");
await withBroker(registry({ slots: 1 }), async (b) => {
  const relay = relayTo(b, KEYS.stable);
  await upOf(relay);
  const port = relay.port("sleep");
  const frames: unknown[] = [];
  const watched: RelayPort = { onMessage: (m) => { frames.push(m); port.onMessage(m); }, attach: port.attach, detach: port.detach };
  const plain = await startPass(watched, { relayEnv: false });
  plain.cmd({ cmd: "call", id: "p1" });
  ok(await plain.wait("run", "p1") && frames.length === 0, "a pass not told OB1_SLOT_RELAY=ipc asks no relay, its channel or not", frames);
  plain.cmd({ cmd: "end", id: "p1" });
  await kill(plain);
  const deaf: RelayPort = { onMessage: () => {}, attach: () => {}, detach: () => {} };
  const s = await startPass(deaf);
  s.cmd({ cmd: "call", id: "d1" });
  const t0 = performance.now();
  ok(await s.wait("run", "d1", 3000), "a relay that never answers: the call runs on its own share");
  const took = performance.now() - t0;
  ok(took >= 900 && took < 2500, `after RELAY_ANSWER_MS (${Math.round(took)} ms)`, took);
  s.cmd({ cmd: "end", id: "d1" });
  s.cmd({ cmd: "call", id: "dl", cls: "live" });
  ok(await s.wait("run", "dl", 3000), "a live call beside that relay runs");
  const dl = s.evs.find((e) => e.ev === "run" && e.id === "dl")?.ms ?? Infinity;
  ok(dl < 300, `at once: a live call never waits on the relay (${dl} ms)`, dl);
  s.cmd({ cmd: "end", id: "dl" });
  await kill(s);
  const once = await startPass(relay.port("board-sync"), { mode: "once" });
  const code = await Promise.race([once.proc.exited, sleep(8000).then(() => "still running")]);
  ok(code === 0, "a pass whose work is done exits on its own, its channel to the relay open", code);
  await kill(once);
  const idle = await startPass(relay.port("extract"), { mode: "none" });
  const idleCode = await Promise.race([idle.proc.exited, sleep(8000).then(() => "still running")]);
  ok(idleCode === 0, "and so does one that never asked: the channel is let go from the start", idleCode);
  await kill(idle);
  await relay.stop();
});

section("[9] live calls counted whatever the broker's state; dials that hang; a broker back in 2 s");
{
  const reg = registry({ slots: 1 });
  let b = startBroker(reg, { port: 0, log: () => {} });
  const port0 = b.port;
  const relay = startRelay({ url: `ws://127.0.0.1:${port0}/v1/slots`, key: KEYS.stable, log: () => {}, reconnectMs: { first: 50, max: 200 }, graceMs: 300 });
  await upOf(relay);
  const port = relay.port("probe");
  const got: { slot: string; id: string }[] = [];
  port.attach((m) => got.push(m));
  await b.stop();
  await until(() => relay.state().broker === "down");
  await sleep(500);
  port.onMessage({ slot: "ask", id: "lv", base: BASE, model: "m", cls: "live" });
  ok(!got.some((m) => m.id === "lv" && m.slot === "own") && relay.state().own === 1, "a live call past the grace is kept as running, not answered own and forgotten", { got, s: relay.state() });
  b = startBroker(reg, { port: port0, log: () => {} });
  try {
    await upOf(relay);
    ok(await until(() => pool(b).live === 1), "and counted live at the broker once it is back", b.snapshot());
    port.onMessage({ slot: "done", id: "lv" });
    ok(await until(() => pool(b).live === 0), "its done lands", b.snapshot());
    // Behind the cap: the broker's max_waiting asks waiting, then a live call — asked past the cap at once.
    for (let i = 0; i < 1025; i++) port.onMessage({ slot: "ask", id: `bg${i}`, base: BASE, model: "m", cls: "background" });
    await until(() => relay.state().parked >= 1);
    port.onMessage({ slot: "ask", id: "lv2", base: BASE, model: "m", cls: "live" });
    ok(await until(() => pool(b).live === 1), "a live call behind the relay's cap is counted at once, not parked behind background asks", { snap: b.snapshot(), s: relay.state() });
    port.detach();
  } finally { await relay.stop(); await b.stop(); }
}

{
  // A peer that takes the TCP connection and never answers: the dial is dropped at the hello's bound and said.
  const silent = Bun.listen({ port: 0, socket: { data() {} }, hostname: "127.0.0.1" });
  const logs: string[] = [];
  const relay = startRelay({ url: `ws://127.0.0.1:${silent.port}/v1/slots`, key: KEYS.stable, log: (l) => logs.push(l), reconnectMs: { first: 50, max: 200 }, helloMs: 400 });
  ok(await until(() => logs.some((l) => /no hello from the broker within 0.4 s of dialling/.test(l)), 3000), "a dial that never completes is dropped at the hello's bound, and said", logs);
  await relay.stop();
  silent.stop(true);
  const http = Bun.serve({ port: 0, fetch: () => new Response("hi"), hostname: "127.0.0.1" });
  const httpLogs: string[] = [];
  const r2 = startRelay({ url: `ws://127.0.0.1:${http.port}/v1/slots`, key: KEYS.stable, log: (l) => httpLogs.push(l), reconnectMs: { first: 50, max: 200 } });
  ok(await until(() => httpLogs.some((l) => /no WebSocket there \(HTTP 200\)/.test(l)), 3000), "a plain HTTP server is named as no WebSocket, not an outage", httpLogs);
  await r2.stop();
  await http.stop(true);
}

{
  // Gone 2 s, under the 3 s grace: the relay finds it again inside the grace, and its waiting ask never takes its own share.
  const reg = registry({ slots: 1 });
  let b = startBroker(reg, { port: 0, log: () => {} });
  const port0 = b.port;
  const relay = startRelay({ url: `ws://127.0.0.1:${port0}/v1/slots`, key: KEYS.stable, log: () => {} });
  await upOf(relay);
  const port = relay.port("probe");
  const got: { slot: string; id: string }[] = [];
  port.attach((m) => got.push(m));
  port.onMessage({ slot: "ask", id: "h", base: BASE, model: "m", cls: "background" });
  await until(() => got.some((m) => m.slot === "go" && m.id === "h"));
  port.onMessage({ slot: "ask", id: "w", base: BASE, model: "m", cls: "background" });
  await until(() => got.some((m) => m.slot === "queued" && m.id === "w"));
  await b.stop();
  await sleep(2000);
  b = startBroker(reg, { port: port0, log: () => {} });
  try {
    await sleep(1500);
    ok(!got.some((m) => m.slot === "own"), "a broker gone 2 s is found again within the 3 s grace: no ask takes its own share", got);
    ok(pool(b).background === 1 && pool(b).waiting.stable === 1, "the grant re-registered and the ask asked again", b.snapshot());
    port.detach();
  } finally { await relay.stop(); await b.stop(); }
}

{
  // The link cut under a running call (a TCP proxy between relay and broker): the broker keeps the grant, the relay's
  // held on its next socket takes it back, and the other brain's ask is never handed the slot meanwhile.
  await withBroker(registry({ slots: 1 }), async (b) => {
    const pairs: { a: { end(): void }; z: { end(): void } }[] = [];
    // Each client's far side and what it sent before that side was open, by the client's socket.
    const sides = new Map<unknown, { peer?: { write(d: Uint8Array): number; end(): void }; buf: Uint8Array[] }>();
    const proxy = Bun.listen({
      port: 0,
      socket: {
        open(cli) {
          const side: { peer?: { write(d: Uint8Array): number; end(): void }; buf: Uint8Array[] } = { buf: [] };
          sides.set(cli, side);
          void Bun.connect({ hostname: "127.0.0.1", port: b.port, socket: {
            open(srv) { side.peer = srv; for (const d of side.buf) srv.write(d); pairs.push({ a: cli, z: srv }); },
            data(_srv, d) { cli.write(d); },
            close() { cli.end(); },
          } });
        },
        data(cli, d) { const side = sides.get(cli); if (side?.peer) side.peer.write(d); else side?.buf.push(new Uint8Array(d)); },
        close(cli) { sides.get(cli)?.peer?.end(); sides.delete(cli); },
      },
      hostname: "127.0.0.1",
    });
    const relay = startRelay({ url: `ws://127.0.0.1:${proxy.port}/v1/slots`, key: KEYS.stable, log: () => {}, reconnectMs: { first: 50, max: 200 } });
    const other = relayTo(b, KEYS.canary);
    try {
      await upOf(relay); await upOf(other);
      const a = await startPass(relay.port("sleep"));
      const c = await startPass(other.port("sleep"));
      a.cmd({ cmd: "call", id: "run" }); await a.wait("run", "run");
      c.cmd({ cmd: "call", id: "wait" }); await c.wait("waiting", "wait");
      for (const p of pairs.splice(0)) { p.a.end(); p.z.end(); }
      await until(() => relay.state().broker === "down", 2000);
      ok(await upOf(relay), "the relay is back through the proxy");
      await sleep(300);
      ok(!c.saw("run", "wait") && pool(b).background === 1, "the other brain is never handed the slot the call still holds: the broker kept it, the held took it back", b.snapshot());
      a.cmd({ cmd: "end", id: "run" });
      ok(await c.wait("run", "wait"), "and it goes on at the call's done");
      c.cmd({ cmd: "end", id: "wait" });
      await kill(a); await kill(c);
    } finally { await relay.stop(); await other.stop(); proxy.stop(true); }
  });
}

{
  // A live ask caught mid-ask by a loss (a broker that says hello and never answers it): kept as running, for `held`
  // on the next socket, not parked and answered own.
  const port0 = 18_800 + Math.floor(Math.random() * 150);
  const mute = Bun.serve({ port: port0, fetch: (req, srv) => srv.upgrade(req) ? undefined : new Response(null, { status: 400 }), websocket: { open(ws) { ws.send(JSON.stringify({ op: "hello", boot: "mute", idle_s: 30, max_waiting: 1024 })); }, message() {} }, hostname: "127.0.0.1" });
  const relay = startRelay({ url: `ws://127.0.0.1:${port0}/v1/slots`, key: KEYS.stable, log: () => {}, reconnectMs: { first: 50, max: 200 }, graceMs: 300 });
  await upOf(relay);
  const port = relay.port("probe");
  port.attach(() => {});
  port.onMessage({ slot: "ask", id: "lv", base: BASE, model: "m", cls: "live" });
  await sleep(50);
  await mute.stop(true);
  await until(() => relay.state().broker === "down");
  await sleep(600);
  const b = startBroker(registry({ slots: 1 }), { port: port0, log: () => {} });
  try {
    await upOf(relay);
    ok(await until(() => pool(b).live === 1), "a live ask caught mid-ask by a loss is counted once a broker is back", { snap: b.snapshot(), s: relay.state() });
    port.detach();
  } finally { await relay.stop(); await b.stop(); }
}

{
  // A refused key met only after an outage was said: named all the same.
  const port0 = 18_950 + Math.floor(Math.random() * 40);
  const logs: string[] = [];
  const relay = startRelay({ url: `ws://127.0.0.1:${port0}/v1/slots`, key: "slot_not-a-brain", log: (l) => logs.push(l), reconnectMs: { first: 50, max: 200 } });
  await until(() => logs.some((l) => /did not answer/.test(l)), 3000);
  const b = startBroker(registry({ slots: 1 }), { port: port0, log: () => {} });
  try {
    ok(await until(() => logs.some((l) => /refused this brain's key \(401\)/.test(l)), 5000), "a key refused only after an outage was said is named all the same", logs);
  } finally { await relay.stop(); await b.stop(); }
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
