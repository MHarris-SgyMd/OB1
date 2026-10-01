#!/usr/bin/env bun
/**
 * test-weekly-digest.ts — db/weekly-digest.ts's pure core (SMD-2239), hermetic.
 *
 * No Postgres, no model, no network. Covers the ranking, the importance read,
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
  thoughtImportance,
  rankAndTrim,
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
  importance: o.importance,
});

// ---------------------------------------------------------------------------
// thoughtImportance — native column, then metadata, then 0; numeric strings.
// ---------------------------------------------------------------------------
{
  ok(thoughtImportance(thought({ importance: 5 })) === 5, "a native importance column wins");
  ok(thoughtImportance(thought({ importance: "5" })) === 5, "a numeric string in the native column is read");
  ok(thoughtImportance(thought({ metadata: { importance: 3 } })) === 3, "metadata.importance is read when there is no column");
  ok(thoughtImportance(thought({ metadata: { importance: "3" } })) === 3, "a numeric string in metadata.importance is read");
  ok(thoughtImportance(thought({ importance: 5, metadata: { importance: 1 } })) === 5, "the native column is preferred over metadata");
  ok(thoughtImportance(thought({})) === 0, "no importance anywhere reads as 0");
}

// ---------------------------------------------------------------------------
// rankAndTrim — importance desc, recency tiebreak; widen under 10; cap 200.
// ---------------------------------------------------------------------------
{
  const rows = [
    thought({ id: "a", importance: 1, created_at: "2026-09-01" }),
    thought({ id: "b", importance: 9, created_at: "2026-09-02" }),
    thought({ id: "c", importance: 9, created_at: "2026-09-03" }),
  ];
  const { pool, widened } = rankAndTrim(rows, 4);
  ok(pool[0].id === "c" && pool[1].id === "b" && pool[2].id === "a", "ranked by importance, newest first on a tie");
  ok(widened, "fewer than 10 above the threshold widens the pool");

  const many = Array.from({ length: 250 }, (_, i) => thought({ id: `x${i}`, importance: 9, created_at: `2026-09-${(i % 28) + 1}` }));
  const big = rankAndTrim(many, 4);
  ok(big.pool.length === 200, "the pool is capped at 200");
  ok(!big.widened, "10 or more above the threshold does not widen");
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
}

console.log(`\ntest-weekly-digest: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
