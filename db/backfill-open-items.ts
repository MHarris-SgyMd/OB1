#!/usr/bin/env bun
/**
 * backfill-open-items.ts — the thoughts' existing action items as proposed open
 * items (SMD-3665 PR 3a, the ticket's Work item 4).
 *
 * Every thought whose metadata holds `action_items` (a JSON array) gets one
 * open item per distinct non-blank string in it, through migration 117's
 * open_item: read from that thought (so the item is noted at the thought's
 * capture time, and an old to-do reads as old), `proposed` (a write key
 * confirms one, the maintainer's decision of 2026-11-03), opened by the key
 * this script names (--as, an agent's key by default). The same thought and text
 * again is the item already there (117's identity), so a second run opens
 * nothing twice — which is how board-sync's thoughts, written through db/ and
 * never through the core's capture, gain their items: run it again. No
 * thought's row is written: open_item reads the thought and writes the item
 * tables alone.
 *
 *   bun db/backfill-open-items.ts --url "$DATABASE_URL" --dry-run    # counts, writes nothing
 *   bun db/backfill-open-items.ts --url "$DATABASE_URL"              # opens them
 *   bun db/backfill-open-items.ts --url … --as board-sync --limit 500
 *
 * Flags:
 *   --url URL        the brain (else DATABASE_URL)
 *   --dry-run        count the thoughts and items it would open, and write nothing
 *   --as NAME        the opener's key name (default backfill-open-items); classified
 *                    agent in the registry when it has no kind yet, so its items stand
 *                    at agent trust (the ticket's word)
 *   --limit N        at most N thoughts (default all), in id order
 *   --per-thought N  at most N items from one thought (default 20, capture's own cap)
 *
 * Exits 0 done, 1 when the brain lacks migration 117 or an item could not be
 * opened (each named, the rest still opened), 2 for a flag it does not take.
 */
import { commandLine } from "./cli.ts";
import { databaseUrl, openSql } from "./connect.ts";

const cli = commandLine("backfill-open-items.ts", { url: "one", "dry-run": "none", as: "one", limit: "one", "per-thought": "one" },
  { note: "it reads DATABASE_URL when --url is absent" });
const url = databaseUrl(cli.value("url"));
const dryRun = cli.has("dry-run");
const as = (cli.value("as") ?? "backfill-open-items").trim();
if (!as || as.length > 200) { console.error("--as names a key: 1 to 200 characters"); process.exit(2); }
const limit = cli.int("limit", { absent: 0, min: 1, max: 10_000_000 });
const perThought = cli.int("per-thought", { absent: 20, min: 1, max: 1000 });

const sql = openSql(url);
try {
  const [{ ready }] = await sql`SELECT to_regprocedure('open_item(text, text, text, uuid, text, boolean, jsonb)') IS NOT NULL AS ready` as { ready: boolean }[];
  if (!ready) {
    console.error("backfill-open-items: this brain has no open_item (migration 117); apply it first (cd db && bun migrate.ts --url …)");
    process.exit(1);
  }

  // Each thought's distinct non-blank strings, in id order, as 117 will read them: ob1_work_claim_text cleans (and a
  // text past 1000 characters after it is counted, never sent: 117 would refuse it).
  const rows = await sql`
    WITH t AS (
      SELECT id FROM thoughts
       WHERE jsonb_typeof(metadata->'action_items') = 'array' AND jsonb_array_length(metadata->'action_items') > 0
       ORDER BY id
       LIMIT ${limit || null}::bigint),
    e AS (
      SELECT t.id AS thought, a.v AS raw, a.ord
        FROM t JOIN thoughts th ON th.id = t.id
        CROSS JOIN LATERAL jsonb_array_elements(th.metadata->'action_items') WITH ORDINALITY AS a(v, ord)
       WHERE jsonb_typeof(a.v) = 'string'),
    c AS (
      SELECT thought, ord, ob1_work_claim_text(raw #>> '{}', 1000000, 'an action item') AS text FROM e)
    SELECT thought::text AS thought, text,
           length(text) > 1000 AS too_long,
           EXISTS (SELECT 1 FROM open_items i WHERE i.origin_key = md5(c.thought::text || ':' || lower(text))) AS present
      FROM c
     WHERE text IS NOT NULL
     ORDER BY thought, ord` as { thought: string; text: string; too_long: boolean; present: boolean }[];

  // Distinct per thought (case aside, as 117's identity), capped as capture caps one capture.
  const seen = new Set<string>();
  const perCount = new Map<string, number>();
  const plan: { thought: string; text: string; present: boolean }[] = [];
  let tooLong = 0, capped = 0;
  for (const r of rows) {
    const key = `${r.thought}:${r.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.too_long) { tooLong++; continue; }
    const n = perCount.get(r.thought) ?? 0;
    if (n >= perThought) { capped++; continue; }
    perCount.set(r.thought, n + 1);
    plan.push({ thought: r.thought, text: r.text, present: r.present });
  }
  const thoughts = perCount.size;
  const already = plan.filter((p) => p.present).length;
  console.log(`${thoughts} thoughts hold ${plan.length} action items to propose: ${already} already items, ${plan.length - already} to open; ${tooLong} past 1000 characters and ${capped} past ${perThought} on one thought left out`);
  if (dryRun) {
    console.log("dry run: nothing written");
    process.exit(0);
  }

  // The opener: an agent's key unless the registry already says otherwise (set_agent_kind, 046 — what an operator
  // runs by hand; here only for a name with no kind yet, which the default always is on first run).
  const [kind] = await sql`SELECT kind FROM ob1_agents WHERE label = ${as}` as { kind: string | null }[];
  if (!kind?.kind) {
    await sql`SELECT set_agent_kind(${as}, 'agent')`;
    console.log(`${as}: classified agent in the registry, so its items stand at agent trust`);
  }
  const envelope = { name: as, scope: "write" };

  let opened = 0, unchanged = 0, failed = 0;
  for (const p of plan) {
    if (p.present) { unchanged++; continue; }
    try {
      const [{ r }] = await sql`SELECT open_item(${p.text}::text, NULL::text, NULL::text, ${p.thought}::uuid, NULL::text, true, ${envelope}::jsonb) AS r` as { r: { outcome: string; message: string | null } }[];
      if (r.outcome === "opened") opened++;
      else if (r.outcome === "unchanged") unchanged++;
      else { failed++; console.error(`thought ${p.thought}: ${r.outcome}${r.message ? `: ${r.message}` : ""}`); }
    } catch (e) {
      failed++;
      console.error(`thought ${p.thought}: ${(e as Error)?.message ?? e}`);
    }
  }
  console.log(`opened ${opened}, ${unchanged} already items${failed ? `, ${failed} not opened (named above)` : ""}`);
  process.exit(failed ? 1 : 0);
} finally {
  await sql.close();
}
