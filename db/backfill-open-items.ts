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
 * this script names (--as, an agent's key by default). A thought is proposed
 * from once, as a capture proposes once: one that has any item read from it
 * already is passed over, so a re-capture's rewording opens no near-duplicate,
 * and --limit works through the rest batch by batch. Run again, it takes the
 * thoughts written since — which is how board-sync's thoughts, written through
 * db/ and never through the core's capture, gain their items, and how a capture
 * whose items were not proposed (the registry away) gains them. No thought's
 * row is written: open_item reads the thought and writes the item tables alone.
 *
 *   bun db/backfill-open-items.ts --url "$DATABASE_URL" --dry-run    # counts, writes nothing
 *   bun db/backfill-open-items.ts --url "$DATABASE_URL"              # opens them
 *   bun db/backfill-open-items.ts --url … --as board-sync --limit 500
 *
 * Flags:
 *   --url URL        the brain (else DATABASE_URL)
 *   --dry-run        count the thoughts and items it would open, and write nothing
 *   --as NAME        the opener's key name (default backfill-open-items); a name the
 *                    registry has never seen is classified agent, so its items stand at
 *                    agent trust (the ticket's word); a key it knows is left as it is,
 *                    and one it knows with no kind stops the run (classify it first)
 *   --limit N        at most N thoughts (default all), in id order
 *   --per-thought N  at most N items from one thought (default 20, capture's own cap)
 *
 * Exits 0 done, 1 when the brain lacks migration 117, --as names a key the
 * registry knows with no kind, or an item could not be opened (each named, the rest still opened), 2 for a flag it does not take.
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

  // A thought is proposed from once, as a capture proposes once (review pass 1: a re-capture rewords its action items,
  // and proposing again would open near-duplicates): the thoughts holding action items and no item read from them
  // yet, in id order, so --limit works through them batch by batch — and only those holding a text 117 would take
  // (review pass 2: a thought of over-long strings alone opened nothing and was taken again by every run). Each
  // thought's strings as 117 will read them — ob1_work_claim_text cleans — and one past 4000 characters is counted
  // too long before any cleaning (review pass 1: a megabyte's string made the cleaning raise and the whole query fail).
  const rows = await sql`
    WITH t AS (
      SELECT th.id, th.metadata FROM thoughts th
       WHERE jsonb_typeof(th.metadata->'action_items') = 'array' AND jsonb_array_length(th.metadata->'action_items') > 0
         AND NOT EXISTS (SELECT 1 FROM open_items i WHERE i.origin_thought_id = th.id)
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(th.metadata->'action_items') v
                      WHERE jsonb_typeof(v) = 'string'
                        AND CASE WHEN length(v #>> '{}') <= 4000
                                 THEN length(ob1_work_claim_text(v #>> '{}', 4000, 'an action item')) <= 1000 END)
       ORDER BY th.id
       LIMIT ${limit || null}::bigint),
    e AS (
      SELECT t.id AS thought, a.v #>> '{}' AS raw, a.ord
        FROM t CROSS JOIN LATERAL jsonb_array_elements(t.metadata->'action_items') WITH ORDINALITY AS a(v, ord)
       WHERE jsonb_typeof(a.v) = 'string'),
    c AS (
      SELECT thought, ord, length(raw) > 4000 AS long_raw,
             CASE WHEN length(raw) <= 4000 THEN ob1_work_claim_text(raw, 4000, 'an action item') END AS text
        FROM e)
    SELECT thought::text AS thought, COALESCE(text, '') AS text, long_raw OR length(text) > 1000 AS too_long
      FROM c
     WHERE long_raw OR text IS NOT NULL
     ORDER BY thought, ord` as { thought: string; text: string; too_long: boolean }[];

  // Distinct per thought (case aside, as 117's identity), capped as capture caps one capture.
  const seen = new Set<string>();
  const perCount = new Map<string, number>();
  const plan: { thought: string; text: string }[] = [];
  let tooLong = 0, capped = 0;
  for (const r of rows) {
    if (r.too_long) { tooLong++; continue; }
    const key = `${r.thought}:${r.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const n = perCount.get(r.thought) ?? 0;
    if (n >= perThought) { capped++; continue; }
    perCount.set(r.thought, n + 1);
    plan.push({ thought: r.thought, text: r.text });
  }
  console.log(`${perCount.size} thoughts with no item yet hold ${plan.length} action items to open; ${tooLong} past 1000 characters and ${capped} past ${perThought} on one thought left out`);

  // The opener: a name the registry has never seen is made an agent's (set_agent_kind, 046), so its items stand at
  // agent trust. A key the registry knows is the operator's to classify (CLAUDE.md, Keys), never this script's
  // (review pass 1). One it knows with no kind stops the run before anything is written, the dry run's included: an
  // item's trust is stamped as it opens, and a run after the key is classified passes its thoughts over (review
  // pass 2: they stood with no trust for good).
  const [known] = await sql`SELECT kind FROM ob1_agents WHERE label = ${as}` as { kind: string | null }[];
  if (known && !known.kind) {
    console.error(`${as}: the registry knows this key with no kind, and an item's trust is stamped as it opens; classify it first (SELECT set_agent_kind('${as}', 'agent')) or name another key with --as`);
    process.exit(1);
  }
  if (dryRun) {
    console.log(known ? `${as}: opens at ${known.kind} trust` : `${as}: a new name, to be classified agent`);
    console.log("dry run: nothing written");
    process.exit(0);
  }
  if (!known) {
    await sql`SELECT set_agent_kind(${as}, 'agent')`;
    console.log(`${as}: a new name, classified agent in the registry, so its items stand at agent trust`);
  }
  const envelope = { name: as, scope: "write" };

  let opened = 0, unchanged = 0, failed = 0;
  for (const p of plan) {
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
