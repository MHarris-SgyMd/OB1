#!/usr/bin/env bun
/**
 * test-weekly-digest.ts — db/weekly-digest.ts's pure core (SMD-2239), hermetic.
 *
 * No Postgres, no model, no network. Covers the pick (a share of each day and
 * writer, newest first; no key's `importance` steers it, SMD-2653), the prompt,
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
  type DigestThought,
} from "./weekly-digest.ts";

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
// buildUserPrompt — no importance reaches the synthesis model.
// ---------------------------------------------------------------------------
{
  const prompt = buildUserPrompt(
    [Object.assign(thought({ id: "p", content: "shipped it", metadata: { type: "task", importance: 9 } }), { importance: 9 })],
    new Date("2026-10-26T00:00:00Z"), new Date("2026-11-02T00:00:00Z"));
  ok(prompt.includes('"type":"task"') && prompt.includes("shipped it") && !/importance/.test(prompt), "the prompt carries the row's type and text, and no importance");
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
