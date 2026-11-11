#!/usr/bin/env bun
/**
 * test-weekly-digest.ts — db/weekly-digest.ts's pure core (SMD-2239), hermetic.
 *
 * No Postgres, no model, no network. Covers the pick (the most pressing first by
 * effective priority, SMD-4112; among equals a share of each day and writer,
 * newest first; no key's `importance` steers it, SMD-2653), the priority read
 * and its fallbacks over a stub, each pick's reason, the prompt,
 * the Telegram chunking, and the digest's egress subject — including the gate
 * itself: a digest carries no row's source/type/topic, so it declares its own
 * (type:digest, source:weekly-digest) and the worker key is the actor. Under the
 * default deny the send is refused; a matching OB1_EGRESS_ALLOW term lets it
 * through; a local endpoint (the drop-the-gate mutant) always would. The
 * DB-backed behavior (the fail-closed read, the stub that records zero requests)
 * lives in test-live.ts [20b].
 */

import { resolveEgressPolicy, mayLeaveBox, type EgressSubject } from "../server-portable/egress.ts";
import {
  pickForDigest,
  buildUserPrompt,
  chunkForTelegram,
  digestUnits,
  digestSubject,
  telegramEndpoint,
  priorityReason,
  readPriorities,
  type DigestPriority,
  type DigestTerm,
  type DigestThought,
} from "./weekly-digest.ts";
import type { SQL } from "bun";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); }
}

const thought = (o: Partial<DigestThought>): DigestThought => ({
  id: o.id ?? "t",
  content: o.content ?? "",
  created_at: o.created_at ?? "2026-09-01T00:00:00Z",
  metadata: o.metadata ?? null,
  ...(o.turn === undefined ? {} : { turn: o.turn }),
  ...(o.priority === undefined ? {} : { priority: o.priority }),
});

// ---------------------------------------------------------------------------
// pickForDigest — turn by turn, newest first within a turn and in the result.
// ---------------------------------------------------------------------------
{
  const ids = (ts: DigestThought[]) => ts.map((t) => t.id).join();

  // Dates, as the database returns them, across weekdays: Mon Nov 2, Sat Oct 31,
  // Wed Oct 28. Compared as strings they would sort by weekday name.
  const dated = pickForDigest([
    thought({ id: "wed", created_at: new Date("2026-10-28T12:00:00Z") }),
    thought({ id: "mon", created_at: new Date("2026-11-02T12:00:00Z") }),
    thought({ id: "sat", created_at: new Date("2026-10-31T12:00:00Z") }),
  ]);
  ok(ids(dated) === "mon,sat,wed", "Dates order newest first by the instant, not by the weekday their string leads with");
  ok(ids(pickForDigest([
    thought({ id: "a", created_at: "2026-09-01T00:00:00Z" }),
    thought({ id: "c", created_at: "2026-09-03T00:00:00Z" }),
    thought({ id: "b", created_at: "2026-09-02T00:00:00Z" }),
  ])) === "c,b,a", "ISO strings order newest first");
  ok(ids(pickForDigest([
    thought({ id: "bad", created_at: "not a date" }),
    thought({ id: "new", created_at: "2026-09-03T00:00:00Z" }),
    thought({ id: "old", created_at: "2026-09-01T00:00:00Z" }),
  ])) === "new,old,bad", "an unreadable time sorts last, and the rest still order");

  // The cap is filled turn by turn: a busy day's later turns give way to a
  // quiet day's first. Day 2 holds turns 1..5, day 1 holds turn 1 alone.
  const at = (d: number, h: number) => new Date(Date.UTC(2026, 9, d, h)).toISOString();
  const busy = Array.from({ length: 5 }, (_, i) => thought({ id: `busy${i + 1}`, created_at: at(2, 20 - i), turn: i + 1 }));
  const quiet = thought({ id: "quiet", created_at: at(1, 9), turn: 1 });
  ok(ids(pickForDigest([...busy, quiet], 3)) === "busy1,busy2,quiet", "a quiet day's first row comes before a busy day's third, and the pick is newest first");

  // SMD-2653's repro, past the cap: a writer's 80 thoughts, then a capture key's
  // 10, each older than every writer row, carrying importance 9 in metadata and
  // as a column. Neither is read, so the writer's 80 fill the pick.
  const day = (d: number) => new Date(Date.UTC(2026, 9, d, 12)).toISOString();
  const writer = Array.from({ length: 80 }, (_, i) => thought({ id: `w${i}`, created_at: day(20 + (i % 10)) }));
  const capture = Array.from({ length: 10 }, (_, i) =>
    Object.assign(thought({ id: `c${i}`, created_at: day(10 + i), metadata: { importance: 9 } }), { importance: 9 }));
  const pool = pickForDigest([...capture, ...writer]);
  ok(pool.length === 80 && pool.every((t) => t.id.startsWith("w")), "a capture key's importance 9 ranks none of a writer's newer thoughts out");

  const many = Array.from({ length: 250 }, (_, i) => thought({ id: `x${i}`, created_at: day((i % 28) + 1) }));
  ok(pickForDigest(many).length === 80, "the pick is capped at the prompt's 80");
}

// ---------------------------------------------------------------------------
// pickForDigest by priority (SMD-4112) — the most pressing first; among equals,
// the turns and the newest first, the order before it.
// ---------------------------------------------------------------------------
{
  const ids = (ts: DigestThought[]) => ts.map((t) => t.id).join();
  const at = (d: number, h = 12) => new Date(Date.UTC(2026, 10, d, h)).toISOString();
  const unknown = (): DigestPriority => ({ effective: 2, settled: false, terms: [{ term: "unknown", value: 2, detail: {} }] });
  const stated = (level: number, more: DigestTerm[] = []): DigestPriority =>
    ({ effective: level + more.reduce((s, t) => s + t.value, 0), settled: false, terms: [{ term: "level", value: level, detail: { level } }, ...more] });
  const overdue: DigestTerm = { term: "overdue", value: 0.6, detail: { due_at: "2026-11-04T00:00:00Z", due_from: "stated" } };

  // The ticket's Verify: an overdue item and an Urgent ticket's row come before newer Low ones and a newer unknown one.
  const week = [
    thought({ id: "low1", created_at: at(9, 20), turn: 1, priority: stated(1) }),
    thought({ id: "low2", created_at: at(9, 19), turn: 2, priority: stated(1) }),
    thought({ id: "plain", created_at: at(9, 18), turn: 3, priority: unknown() }),
    thought({ id: "urgent", created_at: at(5), turn: 4, priority: stated(4) }),
    thought({ id: "late", created_at: at(3), turn: 5, priority: { effective: 2.6, settled: false, terms: [{ term: "unknown", value: 2, detail: {} }, overdue] } }),
  ];
  ok(ids(pickForDigest(week)) === "urgent,late,plain,low1,low2", `an Urgent ticket's row and an overdue item come before newer unknown and Low ones (${ids(pickForDigest(week))})`);
  // Past the cap: an Urgent row at a late turn displaces an early turn's unknown (the drop-the-priority-order mutant's row).
  ok(ids(pickForDigest(week, 2)) === "urgent,late", `the cap keeps the most pressing, whatever their turn (${ids(pickForDigest(week, 2))})`);

  // None stated: every row unknown's 2, so the pick is the turns and the newest first, exactly as with no priority read.
  const busy = Array.from({ length: 5 }, (_, i) => thought({ id: `busy${i + 1}`, created_at: at(2, 20 - i), turn: i + 1 }));
  const quiet = thought({ id: "quiet", created_at: at(1, 9), turn: 1 });
  const flat = [...busy, quiet].map((t) => ({ ...t, priority: unknown() }));
  ok(ids(pickForDigest(flat, 3)) === ids(pickForDigest([...busy, quiet], 3)) && ids(pickForDigest(flat, 3)) === "busy1,busy2,quiet",
    `with no priority stated the pick is the one before SMD-4112 (${ids(pickForDigest(flat, 3))})`);
  // Equals among stated ones keep the turns too: two Highs, the busy day's second turn after the quiet day's first.
  const highs = [
    thought({ id: "busyA", created_at: at(2, 20), turn: 1, priority: stated(3) }),
    thought({ id: "busyB", created_at: at(2, 19), turn: 2, priority: stated(3) }),
    thought({ id: "quietA", created_at: at(1, 9), turn: 1, priority: stated(3) }),
  ];
  ok(ids(pickForDigest(highs, 2)) === "busyA,quietA", `among equal priorities a quiet day's first turn comes before a busy day's second (${ids(pickForDigest(highs, 2))})`);
}

// ---------------------------------------------------------------------------
// priorityReason — each pick's level and where it came from, its due time,
// what it unblocks, and whether it is settled; nothing for an unknown alone.
// ---------------------------------------------------------------------------
{
  const p = (terms: DigestTerm[], settled = false): DigestPriority => ({ effective: 0, settled, terms });
  ok(priorityReason(undefined) === null, "no priority read: no reason");
  ok(priorityReason(p([{ term: "unknown", value: 2, detail: {} }])) === null, "unknown's level alone: no reason, so the row carries no field");
  ok(priorityReason(p([{ term: "level", value: 4, detail: { level: 4 } }])) === "urgent, stated", "a stated level");
  ok(priorityReason(p([{ term: "level", value: 0, detail: { level: 0 } }])) === "none, stated", "a stated None is a statement");
  ok(priorityReason(p([{ term: "from_items", value: 3, detail: { level: 3, item: "i1" } }])) === "high, from its open item", "a level read from the thought's open items");
  ok(priorityReason(p([{ term: "inherited", value: 3, detail: { from: { kind: "ticket", key: "SMD-1", level: 4, hops: 1 } } }])) === "high, inherited from ticket SMD-1",
    "an inherited level, after its hops, and the ticket it came from");
  ok(priorityReason(p([{ term: "inherited", value: 2.5, detail: { from: { kind: "item", key: "i2" } } }])) === "level 2.5, inherited from open item i2",
    "an operator's fractional hop is said as a number, and an item as an open item");
  ok(priorityReason(p([{ term: "unknown", value: 2, detail: {} }, { term: "overdue", value: 0.6, detail: { due_at: "2026-11-04T00:00:00Z" } }])) === "no level stated; overdue, due by the end of 2026-11-03 (UTC)",
    "an overdue item with no level: said so, its date-only due as its own day");
  ok(priorityReason(p([{ term: "level", value: 3, detail: { level: 3 } }, { term: "urgency", value: 0.4, detail: { due_at: "2026-11-12T15:00:00Z" } }, { term: "unblocks", value: 0.1, detail: { count: 2 } }])) === "high, stated; due 2026-11-12T15:00:00.000Z; unblocks 2",
    "a due time with an hour, and what it unblocks");
  ok(priorityReason(p([{ term: "level", value: 3, detail: { level: 3 } }], true)) === "high, stated; settled", "a settled item keeps its level, said settled");
}

// ---------------------------------------------------------------------------
// readPriorities — one read for the window; a brain before 122, or a failed
// read, leaves the order before SMD-4112 and says why. A stub stands for SQL.
// ---------------------------------------------------------------------------
{
  const stub = (o: { has: boolean; fail?: string; rows?: unknown[] }) => {
    const asked: string[] = [];
    const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = strings.join("$");
      if (/to_regprocedure/.test(q)) return Promise.resolve([{ has: o.has }]);
      if (/effective_priority\(/.test(q)) {
        asked.push(String(values[0]));
        return o.fail ? Promise.reject(new Error(o.fail)) : Promise.resolve(o.rows ?? []);
      }
      return Promise.reject(new Error(`unexpected query: ${q}`));
    };
    return { sql: fn as unknown as SQL, asked };
  };
  const old = stub({ has: false });
  const before = await readPriorities(old.sql, ["a"]);
  ok(before.read === null && !before.failed && /before migration 122/.test(before.why) && old.asked.length === 0, "a brain before 122: not read, said so, and no read is tried");

  const refused = stub({ has: true, fail: "permission denied for table\n  priority_assertions" });
  // A read that throws would stop the digest: caught here so that is a failed row, not a crash.
  const failed = await readPriorities(refused.sql, ["a"]).catch((e: Error) => ({ read: null, failed: false, why: `threw: ${e.message}` }));
  ok(failed.read === null && failed.failed && failed.why === "permission denied for table priority_assertions", `a failed read: not read, the database's words on one line (${failed.read === null ? failed.why : ""})`);

  // The read's own shape (122's terms are flat: term, value, and what it read beside them), as SQL answers it.
  const good = stub({ has: true, rows: [
    { item_key: "a", effective: "2.6", settled: false, terms: JSON.stringify([{ term: "unknown", value: 2 }, { term: "overdue", value: 0.6, due_at: "2026-11-04T00:00:00+00:00", due_from: "stated" }]) },
    { item_key: "b", effective: 4, settled: true, terms: [{ term: "level", value: "4", level: 4, tier: 1, maker: "op" }] },
  ] });
  const read = await readPriorities(good.sql, ["a", "b"]);
  const a = read.read?.get("a"), b = read.read?.get("b");
  ok(a?.effective === 2.6 && a.terms[0]?.term === "unknown" && b?.settled === true && b.terms[0]?.term === "level" && b.terms[0]?.value === 4,
    "each thought's priority by its id, a numeric and a jsonb as text read too");
  ok(priorityReason(a) === "no level stated; overdue, due by the end of 2026-11-03 (UTC)" && priorityReason(b) === "urgent, stated; settled",
    `the read's flat terms are said as the reason says them (${priorityReason(a)}; ${priorityReason(b)})`);
  ok(JSON.stringify(JSON.parse(good.asked[0] ?? "[]")) === JSON.stringify([{ kind: "thought", key: "a" }, { kind: "thought", key: "b" }]), `one read, every thought asked by its id (${good.asked[0]})`);

  const none = stub({ has: true });
  ok((await readPriorities(none.sql, [])).read?.size === 0 && none.asked.length === 0, "an empty window: nothing read");
  let threw = "";
  try { await readPriorities(stub({ has: true }).sql, Array.from({ length: 1001 }, (_, i) => `t${i}`)); } catch (e) { threw = (e as Error).message; }
  ok(/at most 1000/.test(threw), "more than one read takes is refused, never cut quietly");
}

// ---------------------------------------------------------------------------
// buildUserPrompt — no importance reaches the synthesis model.
// ---------------------------------------------------------------------------
{
  const prompt = buildUserPrompt(
    [Object.assign(thought({ id: "p", content: "shipped it", metadata: { type: "task", importance: 9 } }), { importance: 9 })],
    new Date("2026-10-26T00:00:00Z"), new Date("2026-11-02T00:00:00Z"));
  ok(prompt.includes('"type":"task"') && prompt.includes("shipped it") && !/importance/.test(prompt), "the prompt carries the row's type and text, and no importance");

  // SMD-4112: a row the brain knows a priority of says why; with none stated the prompt is the one before.
  const start = new Date("2026-11-02T00:00:00Z"), end = new Date("2026-11-09T00:00:00Z");
  const plain = [thought({ id: "u", content: "a note" })];
  const unknownOnly = [thought({ id: "u", content: "a note", priority: { effective: 2, settled: false, terms: [{ term: "unknown", value: 2, detail: {} }] } })];
  ok(buildUserPrompt(unknownOnly, start, end) === buildUserPrompt(plain, start, end) && !/priority/.test(buildUserPrompt(plain, start, end)),
    "with no priority known the prompt is the one before SMD-4112, no priority field and no word of it");
  const ranked = buildUserPrompt([thought({ id: "r", content: "renew the passport", priority: { effective: 4, settled: false, terms: [{ term: "level", value: 4, detail: { level: 4 } }] } }), ...plain], start, end);
  ok(ranked.includes('"priority":"urgent, stated"') && /the most pressing first \(a row's priority says why it matters\)/.test(ranked) && (ranked.match(/"priority"/g) ?? []).length === 1,
    "a row with a known priority says why, the source line says the order, and a row with none carries no field");
}

// ---------------------------------------------------------------------------
// chunkForTelegram — short stays whole; long splits within the limit.
// ---------------------------------------------------------------------------
{
  ok(chunkForTelegram("hi", 10).length === 1, "text within the limit is one chunk");
  const paras = (`${"a".repeat(30)}\n\n`).repeat(6);
  const chunked = chunkForTelegram(paras, 40);
  ok(chunked.length > 1 && chunked.every((c) => c.length <= 40), "a long text splits into chunks each within the limit");
  const wall = "w".repeat(200);
  ok(chunkForTelegram(wall, 40).every((c) => c.length <= 40), "a wall with no boundary is hard-cut within the limit");
}

// ---------------------------------------------------------------------------
// digestUnits / digestSubject — the digest's own source/type, the key as actor.
// ---------------------------------------------------------------------------
{
  ok(JSON.stringify(digestUnits("dig")) === JSON.stringify(["actor", "source", "type", "marker"]), "with a key the digest carries an actor unit");
  ok(JSON.stringify(digestUnits(undefined)) === JSON.stringify(["source", "type", "marker"]), "keyless, the digest carries no actor unit");

  const s = digestSubject("the digest text", "dig");
  ok(s.kind === "digest", "the subject kind is digest");
  ok(s.metadata?.type === "digest" && s.metadata?.source === "weekly-digest", "the subject declares its own type and source");
  ok(s.actor === "dig" && s.content === "the digest text", "the key is the actor and the text is the marker");
  ok(digestSubject("x", undefined).actor === undefined, "keyless, the subject carries no actor");
}

// ---------------------------------------------------------------------------
// The gate over a digest hop — the crux. api.telegram.org is never local, so it
// leaves only under a matching allow term.
// ---------------------------------------------------------------------------
{
  const telegram = { base: "https://api.telegram.org", local: false };
  const local = { base: "https://api.telegram.org", local: true };
  const subject: EgressSubject = digestSubject("the week in review", "dig");
  const deny = resolveEgressPolicy({});

  ok(!mayLeaveBox(subject, telegram, deny).allowed, "default deny, no term: the digest is refused (nothing reaches Telegram)");
  ok(/deny \(the default\)/.test(mayLeaveBox(subject, telegram, deny).reason), "the refusal names the policy");

  // Drop-the-gate mutant: were the endpoint local, the same subject would pass.
  ok(mayLeaveBox(subject, local, deny).allowed, "a local endpoint always passes (drop-the-gate mutant)");

  const byType = resolveEgressPolicy({ OB1_EGRESS_ALLOW: "type:digest" });
  ok(mayLeaveBox(subject, telegram, byType).allowed, "OB1_EGRESS_ALLOW=type:digest lets the digest post");
  const bySource = resolveEgressPolicy({ OB1_EGRESS_ALLOW: "source:weekly-digest" });
  ok(mayLeaveBox(subject, telegram, bySource).allowed, "OB1_EGRESS_ALLOW=source:weekly-digest lets the digest post");
  const byActor = resolveEgressPolicy({ OB1_EGRESS_ALLOW: "actor:dig" });
  ok(mayLeaveBox(subject, telegram, byActor).allowed, "OB1_EGRESS_ALLOW=actor:<key> lets the digest post");
  ok(!mayLeaveBox(digestSubject("x", undefined), telegram, byActor).allowed, "keyless, an actor: term cannot name the digest — still refused");

  const wrong = resolveEgressPolicy({ OB1_EGRESS_ALLOW: "type:capture" });
  ok(!mayLeaveBox(subject, telegram, wrong).allowed, "a term for another type does not let the digest post");
}

// ---------------------------------------------------------------------------
// telegramEndpoint — the default host, remote unless declared local.
// ---------------------------------------------------------------------------
{
  const def = telegramEndpoint({});
  ok(def.base === "https://api.telegram.org" && !def.local, "the default Telegram endpoint is api.telegram.org and not local");
  const proxied = telegramEndpoint({ OB1_TELEGRAM_API_BASE: "https://tg.internal/", OB1_TELEGRAM_LOCAL: "1" });
  ok(proxied.base === "https://tg.internal" && proxied.local,
    "OB1_TELEGRAM_API_BASE overrides the host (trailing slash off) and OB1_TELEGRAM_LOCAL declares it local");
  ok(def.headers.Authorization === undefined, "the default endpoint sends no Authorization: the bot token is in the path");
  const fronted = telegramEndpoint({ OB1_TELEGRAM_API_BASE: "https://bot:s3cret@tg.internal/" });
  ok(fronted.base === "https://tg.internal" && fronted.headers.Authorization === `Basic ${btoa("bot:s3cret")}`,
    "a user and password in OB1_TELEGRAM_API_BASE leave the base and are sent as Basic, as for every endpoint (SMD-2885)");
}

console.log(`\ntest-weekly-digest: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
