#!/usr/bin/env bun
/**
 * test-weekly-digest.ts — db/weekly-digest.ts's pure core (SMD-2239), hermetic.
 *
 * No Postgres, no model, no network. Covers the pick (a share of each day and
 * writer a turn at a time, each share taken what matters most first by
 * effective priority, then newest, SMD-4112; no key's `importance` or own
 * Urgent captures take more than their share, SMD-2653), the priority read
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
  readThoughts,
  type DigestPriority,
  type DigestThought,
} from "./weekly-digest.ts";
import type { PriorityTerm } from "../server-portable/store.ts";
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
  ...(o.group === undefined ? {} : { group: o.group }),
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
// pickForDigest by priority (SMD-4112) — within each (day, writer) share, what
// matters most first; the shares still taken a turn at a time (the maintainer,
// 2026-11-11), and the pick listed what matters most first.
// ---------------------------------------------------------------------------
{
  const ids = (ts: DigestThought[]) => ts.map((t) => t.id).join();
  const at = (d: number, h = 12) => new Date(Date.UTC(2026, 10, d, h)).toISOString();
  const unknown = (): DigestPriority => ({ effective: 2, settled: false, terms: [{ term: "unknown", value: 2, detail: {} }] });
  const stated = (level: number, more: PriorityTerm[] = []): DigestPriority =>
    ({ effective: level + more.reduce((s, t) => s + t.value, 0), settled: false, terms: [{ term: "level", value: level, detail: { level } }, ...more] });
  const overdue: PriorityTerm = { term: "overdue", value: 0.6, detail: { due_at: "2026-11-04T00:00:00Z", due_from: "stated" } };
  // readThoughts' turns: each group's rows newest first.
  const grouped = (rows: { id: string; group: string; created_at: string; priority?: DigestPriority }[]) => {
    const n = new Map<string, number>();
    return [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((r) => {
      const turn = (n.get(r.group) ?? 0) + 1;
      n.set(r.group, turn);
      return thought({ ...r, turn });
    });
  };

  // The ticket's Verify: an overdue item and an Urgent ticket's row come before newer Low ones and a newer unknown one.
  // board-sync's day: a newer Low ticket row, then an older Urgent one; a session's day: a newer note and an older
  // item overdue; a third writer's two newer Low captures.
  const week = grouped([
    { id: "lowTicket", group: "board|9", created_at: at(9, 20), priority: stated(1) },
    { id: "urgent", group: "board|9", created_at: at(9, 8), priority: stated(4) },
    { id: "plain", group: "session|9", created_at: at(9, 18), priority: unknown() },
    { id: "late", group: "session|9", created_at: at(9, 7), priority: { effective: 2.6, settled: false, terms: [{ term: "unknown", value: 2, detail: {} }, overdue] } },
    { id: "low1", group: "other|9", created_at: at(9, 21), priority: stated(1) },
    { id: "low2", group: "other|9", created_at: at(9, 19), priority: stated(1) },
  ]);
  ok(ids(pickForDigest(week)) === "urgent,late,plain,low1,lowTicket,low2", `an Urgent ticket's row and an overdue item come before newer unknown and Low ones (${ids(pickForDigest(week))})`);
  // Past the cap: each share's first turn is what matters most in it, not its newest (the drop-the-priority-order mutant's row).
  ok(ids(pickForDigest(week, 3)) === "urgent,late,low1", `the first turn of each share is what matters most in it (${ids(pickForDigest(week, 3))})`);

  // SMD-2653's shape, with priority: a key states Urgent on its own 100 captures, newer than every other row. It gets
  // one row per day per turn, as every other writer does; the Urgent ticket and the notes keep their shares.
  const flood = Array.from({ length: 100 }, (_, i) => ({ id: `flood${i}`, group: "flooder|9", created_at: at(9, 23) .replace(":00.000Z", `:${String(i % 60).padStart(2, "0")}.000Z`), priority: stated(4) }));
  const flooded = grouped([
    ...flood,
    { id: "urgentT", group: "board|9", created_at: at(9, 8), priority: stated(4) },
    ...Array.from({ length: 5 }, (_, i) => ({ id: `note${i}`, group: "session|9", created_at: at(9, 10 + i), priority: unknown() })),
  ]);
  const floodPick = pickForDigest(flooded, 5);
  const floodTaken = floodPick.filter((t) => t.id.startsWith("flood")).length;
  ok(floodTaken === 2 && floodPick.some((t) => t.id === "urgentT") && floodPick.filter((t) => t.id.startsWith("note")).length === 2,
    `a key's 100 Urgent captures take a turn's share, not the digest: 2 of 5 over two turns (${ids(floodPick)})`);

  // None stated: every row unknown's 2, so the turns are readThoughts' (newest first) and the pick is the one before.
  const plainWeek = grouped([
    ...Array.from({ length: 5 }, (_, i) => ({ id: `busy${i + 1}`, group: "w|2", created_at: at(2, 20 - i) })),
    { id: "quiet", group: "w|1", created_at: at(1, 9) },
  ]);
  const flat = plainWeek.map((t) => ({ ...t, priority: unknown() }));
  const before = plainWeek.map(({ group: _g, ...t }) => t);
  ok(ids(pickForDigest(flat, 3)) === ids(pickForDigest(before, 3)) && ids(pickForDigest(flat, 3)) === "busy1,busy2,quiet",
    `with no priority stated the pick is the one before SMD-4112 (${ids(pickForDigest(flat, 3))})`);
  // Within a turn, what matters most first: two shares' first turns, a High and an unknown, the cap taking one.
  const within = grouped([
    { id: "newUnknown", group: "a|2", created_at: at(2, 20), priority: unknown() },
    { id: "oldHigh", group: "b|1", created_at: at(1, 9), priority: stated(3) },
  ]);
  ok(ids(pickForDigest(within, 1)) === "oldHigh", `within a turn what matters most is taken first (${ids(pickForDigest(within, 1))})`);
  // Equals keep readThoughts' own turn: Postgres orders to the microsecond, then by id, where a Date keeps milliseconds.
  // Two rows in one millisecond, the larger id newer by microseconds, so readThoughts made it turn 1.
  const sameMs = [
    thought({ id: "b-newer", group: "g|1", created_at: at(1, 9), turn: 1, priority: stated(3) }),
    thought({ id: "a-older", group: "g|1", created_at: at(1, 9), turn: 2, priority: stated(3) }),
  ];
  ok(ids(pickForDigest(sameMs, 1)) === "b-newer", `a tie in priority keeps readThoughts' turn, not the millisecond and the id (${ids(pickForDigest(sameMs, 1))})`);
  // No turn at all: newest, then by id.
  const tie = [
    thought({ id: "b-same", group: "g|1", created_at: at(1, 9), priority: stated(3) }),
    thought({ id: "a-same", group: "g|1", created_at: at(1, 9), priority: stated(3) }),
  ];
  ok(ids(pickForDigest(tie, 1)) === "a-same", `with no turn, a tie in priority and time goes by id (${ids(pickForDigest(tie, 1))})`);
}

// ---------------------------------------------------------------------------
// priorityReason — each pick's level and where it came from, its due time,
// what it unblocks, and whether it is settled; nothing for an unknown alone.
// ---------------------------------------------------------------------------
{
  const p = (terms: PriorityTerm[], settled = false): DigestPriority => ({ effective: 0, settled, terms });
  ok(priorityReason(undefined) === null, "no priority read: no reason");
  ok(priorityReason(p([{ term: "unknown", value: 2, detail: {} }])) === null, "unknown's level alone: no reason, so the row carries no field");
  ok(priorityReason(p([{ term: "unknown", value: 2, detail: {} }], true)) === null, "a settled item with no priority known: no reason either, so a brain with none stated gets the prompt before");
  ok(priorityReason(p([{ term: "level", value: 4, detail: { level: 4 } }])) === "urgent, stated", "a stated level");
  ok(priorityReason(p([{ term: "level", value: 0, detail: { level: 0 } }])) === "none, stated", "a stated None is a statement");
  ok(priorityReason(p([{ term: "from_items", value: 3, detail: { level: 3, item: "i1" } }])) === "high, from its open item", "a level read from the thought's open items");
  ok(priorityReason(p([{ term: "inherited", value: 3, detail: { from: { kind: "ticket", key: "SMD-1", level: 4, hops: 1 } } }])) === "high, inherited from urgent ticket SMD-1",
    "an inherited level, after its hops, and the ticket it came from at its own level");
  ok(priorityReason(p([{ term: "level", value: 4, detail: { level: 4, as: { kind: "ticket", key: "SMD-7" } } }])) === "ticket SMD-7's own row; urgent, stated",
    "a ticket's own row says the statement is its ticket's, not the note's");
  ok(priorityReason(p([{ term: "unknown", value: 2, detail: { as: { kind: "ticket", key: "SMD-8" } } }])) === null, "a ticket's row with no priority known: no reason");
  ok(priorityReason(p([{ term: "unknown", value: 2, detail: {} }, { term: "urgency", value: 0.4, detail: { due_at: "2026-11-12T15:00:00Z", due_from: "from_items", item: "i9" } }])) === "no level stated; due 2026-11-12T15:00:00Z (from its open item)",
    "a due time read from the thought's open items is said as theirs");
  ok(priorityReason(p([{ term: "inherited", value: 2.5, detail: { from: { kind: "item", key: "i2" } } }])) === "level 2.5, inherited from open item i2",
    "an operator's fractional hop is said as a number, and an item as an open item");
  ok(priorityReason(p([{ term: "unknown", value: 2, detail: {} }, { term: "overdue", value: 0.6, detail: { due_at: "2026-11-04T00:00:00Z" } }])) === "no level stated; overdue, due by the end of 2026-11-03 (UTC)",
    "an overdue item with no level: said so, its date-only due as its own day, as the MCP replies say it");
  ok(priorityReason(p([{ term: "level", value: 3, detail: { level: 3 } }, { term: "urgency", value: 0.4, detail: { due_at: "2026-11-12T15:00:00Z" } }, { term: "unblocks", value: 0.1, detail: { count: 2 } }])) === "high, stated; due 2026-11-12T15:00:00Z; unblocks 2",
    "a due time with an hour, and what it unblocks");
  ok(priorityReason(p([{ term: "level", value: 3, detail: { level: 3 } }], true)) === "high, stated; settled", "a settled item keeps its level, said settled");
}

// ---------------------------------------------------------------------------
// readPriorities — the window in chunks of the read's 1,000, each row read as
// the store reads it; a brain before 122, or a failed read, leaves the order
// before SMD-4112 and says why. A stub stands for SQL.
// ---------------------------------------------------------------------------
{
  // One row of the read, as SQL answers it (122's terms flat: term, value, and what it read beside them).
  const row = (key: string, o: { effective: unknown; settled?: boolean; terms: unknown }) => ({
    item_kind: "thought", item_key: key, effective: o.effective, level: null, inherited_from: null, due_at: null, due_from: null,
    urgency: 0, overdue: false, unblocks: 0, settled: o.settled ?? false, not_before: null, waiting: false, terms: o.terms, winner: null, passed_over: [],
  });
  const stub = (o: { has: boolean; fail?: string; probeFails?: boolean; rows?: (keys: string[]) => unknown[] }) => {
    const asked: string[][] = [];
    const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = strings.join("$");
      if (/to_regprocedure/.test(q)) return o.probeFails ? Promise.reject(new Error("canceling statement due to statement timeout")) : Promise.resolve([{ has: o.has }]);
      if (/effective_priority\(/.test(q)) {
        const keys = (JSON.parse(String(values[0])) as { key: string }[]).map((i) => i.key);
        asked.push(keys);
        return o.fail ? Promise.reject(new Error(o.fail)) : Promise.resolve(o.rows ? o.rows(keys) : []);
      }
      return Promise.reject(new Error(`unexpected query: ${q}`));
    };
    return { sql: fn as unknown as SQL, asked };
  };
  const ida = "00000000-0000-4000-8000-00000000000a", idb = "00000000-0000-4000-8000-00000000000b";
  const old = stub({ has: false });
  const before = await readPriorities(old.sql, [ida]);
  ok(before.read === null && !before.failed && /before migration 122/.test(before.why) && old.asked.length === 0, "a brain before 122: not read, said so, and no read is tried");

  // A read that throws would stop the digest: caught here so that is a failed row, not a crash.
  const guard = (p: ReturnType<typeof readPriorities>) => p.catch((e: Error) => ({ read: null, failed: false, why: `threw: ${e.message}` }));
  const failed = await guard(readPriorities(stub({ has: true, fail: "permission denied for table\n  priority_assertions" }).sql, [ida]));
  ok(failed.read === null && failed.failed && failed.why === "permission denied for table priority_assertions", `a failed read: not read, the database's words on one line (${failed.read === null ? failed.why : ""})`);
  const probeFailed = await guard(readPriorities(stub({ has: true, probeFails: true }).sql, [ida]));
  ok(probeFailed.read === null && probeFailed.failed && /statement timeout/.test(probeFailed.why), `the probe failing is a failed read too, not a crash (${probeFailed.read === null ? probeFailed.why : ""})`);
  const garbled = await guard(readPriorities(stub({ has: true, rows: (keys) => keys.map((k) => row(k, { effective: "2", terms: [{ term: "a term no server knows", value: 1 }] })) }).sql, [ida]));
  ok(garbled.read === null && garbled.failed && /cannot read/.test(garbled.why), `a row the store cannot read is a failed read, not words said wrongly (${garbled.read === null ? garbled.why : ""})`);

  const good = stub({ has: true, rows: (keys) => keys.map((k) => k === ida
    ? row(k, { effective: "2.6", terms: [{ term: "unknown", value: 2 }, { term: "overdue", value: 0.6, due_at: "2026-11-04T00:00:00+00:00", due_from: "stated" }] })
    : row(k, { effective: 4, settled: true, terms: [{ term: "level", value: "4", level: 4, tier: 1, maker: "op" }] })) });
  const read = await readPriorities(good.sql, [ida, idb]);
  const a = read.read?.get(ida), b = read.read?.get(idb);
  ok(a?.effective === 2.6 && a.terms[0]?.term === "unknown" && b?.settled === true && b.terms[0]?.term === "level" && b.terms[0]?.value === 4,
    "each thought's priority by its id, a numeric read as text too");
  ok(priorityReason(a) === "no level stated; overdue, due by the end of 2026-11-03 (UTC)" && priorityReason(b) === "urgent, stated; settled",
    `the read's flat terms are folded as the store folds them, and said (${priorityReason(a)}; ${priorityReason(b)})`);
  ok(good.asked.length === 1 && good.asked[0]!.join() === [ida, idb].join(), `one read, every thought asked by its id (${good.asked.map((k) => k.length).join()})`);

  const none = stub({ has: true });
  ok((await readPriorities(none.sql, [])).read?.size === 0 && none.asked.length === 0, "an empty window: nothing read");
  const short = await guard(readPriorities(stub({ has: true, rows: (keys) => keys.slice(1).map((k) => row(k, { effective: 2, terms: [{ term: "unknown", value: 2 }] })) }).sql, [ida, idb]));
  ok(short.read === null && short.failed && /answered 1 of the 2/.test(short.why), `a thought left out of the answer is a failed read, not a None (${short.read === null ? short.why : ""})`);
  const many = Array.from({ length: 2500 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  const chunked = stub({ has: true, rows: (keys) => keys.map((k) => row(k, { effective: 2, terms: [{ term: "unknown", value: 2 }] })) });
  const all = await readPriorities(chunked.sql, many);
  ok(all.read?.size === 2500 && chunked.asked.map((k) => k.length).join() === "1000,1000,500", `a window past the read's 1,000 is read in chunks, every row ranked (${chunked.asked.map((k) => k.length).join()})`);
}

// ---------------------------------------------------------------------------
// readThoughts' cap (review pass 2) — the text cut to the prompt's 280, one row
// past the cap read to say the window held more. A stub stands for SQL.
// ---------------------------------------------------------------------------
{
  const window = (n: number) => {
    const asked: string[] = [];
    const fn = Object.assign(
      (strings: TemplateStringsArray) => (/information_schema/.test(strings.join("$")) ? Promise.resolve([{ has_sensitivity: true }]) : Promise.reject(new Error("unexpected"))),
      {
        unsafe: (q: string) => {
          asked.push(q);
          const limit = Number(/LIMIT (\d+)/.exec(q)?.[1]);
          return Promise.resolve(Array.from({ length: Math.min(n, limit) }, (_, i) => ({ id: `t${i}`, content: "x", created_at: "2026-11-01T00:00:00Z", metadata: null, turn: 1, group: "g" })));
        },
        array: (v: unknown) => v,
      });
    return { sql: fn as unknown as SQL, asked };
  };
  const opts = { windowDays: 7, includePersonal: false, noSensitivityFilter: false };
  const full = window(5001);
  const over = await readThoughts(full.sql, opts);
  ok(!over.failClosed && over.rows.length === 5000 && over.more === true, `a window past 5,000 is read to 5,000 and said to hold more (${over.failClosed ? "" : `${over.rows.length}, ${over.more}`})`);
  ok(/left\(content, 280\) AS content/.test(full.asked[0] ?? "") && /LIMIT 5001\b/.test(full.asked[0] ?? ""), "the text is read only as far as the prompt reads it");
  const under = await readThoughts(window(5000).sql, opts);
  ok(!under.failClosed && under.rows.length === 5000 && under.more === false, "a window of exactly 5,000 is all read, with nothing more said");
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
  ok(ranked.includes('"priority":"urgent, stated"') && /a share of each day and writer in the window, what matters most taken first from each, listed what matters most first \(a row's priority says why, and whether it is settled\)/.test(ranked) && (ranked.match(/"priority"/g) ?? []).length === 1,
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
