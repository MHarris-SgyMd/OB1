#!/usr/bin/env bun
// Scratch analysis (SMD-1961/1925/1913/1935) — what the newly-extracted graph says
// about the extraction-quality challenges. Read-only against the live brain.
import { SQL } from "bun";
const sql = new SQL({ url: process.env.DATABASE_URL });
const p = (label: string, rows: unknown) => { console.log(`\n== ${label} ==`); console.table(rows); };

// 1. SMD-1925/1982 — is edge/mention confidence still a dead constant, even with 27B + partial rows?
p("confidence distribution (mentions)", await sql`SELECT confidence, count(*)::int AS n FROM thought_entities GROUP BY 1 ORDER BY 1`);
p("confidence distribution (edges)", await sql`SELECT confidence, count(*)::int AS n FROM ob1_entity_edges GROUP BY 1 ORDER BY 1`);

// 2. The real per-edge weight — support (how many thoughts assert an edge). Shallow?
p("edge support (distinct thoughts asserting the same from→rel→to)", await sql`
  SELECT support, count(*)::int AS edge_groups FROM (
    SELECT from_entity_id, to_entity_id, relation, count(*)::int AS support
    FROM ob1_entity_edges GROUP BY 1,2,3) s GROUP BY 1 ORDER BY 1`);

// 3. SMD-1937/1935 — entity type mix + junk proxies + singletons
p("entity types", await sql`SELECT entity_type, count(*)::int AS n FROM ob1_entities GROUP BY 1 ORDER BY 2 DESC`);
const [junk] = await sql`
  SELECT
    (SELECT count(*)::int FROM ob1_entities WHERE normalized_name ~ '^[0-9][0-9.:_-]*$') AS bare_numeric,
    (SELECT count(*)::int FROM ob1_entities WHERE entity_type='person' AND normalized_name ~ '[0-9]') AS person_with_digit,
    (SELECT count(*)::int FROM ob1_entities e WHERE (SELECT count(*) FROM thought_entities m WHERE m.entity_id=e.id)=1) AS singletons,
    (SELECT count(*)::int FROM ob1_entities) AS total`;
p("junk proxies", [junk]);

// 4. SMD-1913 — near-duplicate fragmentation the exact-name merge leaves
const [dupe] = await sql`
  SELECT count(*)::int AS dup_pairs FROM ob1_entities a JOIN ob1_entities b
   ON a.entity_type=b.entity_type AND a.id<b.id
   AND (similarity(a.normalized_name,b.normalized_name)>=0.6
        OR position(a.normalized_name IN b.normalized_name)>0
        OR position(b.normalized_name IN a.normalized_name)>0)`;
p("near-duplicate entity pairs (SMD-1913)", [dupe]);

// 5. relation mix — did the long docs broaden it beyond within-sentence uses/related_to?
p("relation mix", await sql`SELECT relation, count(*)::int AS n FROM ob1_entity_edges GROUP BY 1 ORDER BY 2 DESC`);

// 6. what the 5 partial research-paper prefixes actually contributed
p("partial-prefix docs — entities/edges yielded", await sql`
  SELECT left(t.id::text,8) AS thought,
         (SELECT count(*)::int FROM thought_entities m WHERE m.thought_id=t.id) AS mentions,
         (SELECT count(*)::int FROM ob1_entity_edges g WHERE g.thought_id=t.id) AS edges,
         length(t.content) AS chars
  FROM thoughts t WHERE t.id::text = ANY(${sql.array([
    "9187184b-0000-4000-8000-79b61dd7a537","69eef971-0000-4000-8000-bc03547ffec4",
    "867c9d37-0000-4000-8000-a9c1df2e824d","60da974c-0000-4000-8000-c4903a1873a6",
    "16868ed9-0000-4000-8000-f224b2e948b2"], "TEXT")})
  ORDER BY chars DESC`);

// 7. top entities (eyeball: signal vs noise among the most-mentioned)
p("top 15 entities by mentions", await sql`
  SELECT e.entity_type AS type, e.name, count(*)::int AS mentions
  FROM thought_entities m JOIN ob1_entities e ON e.id=m.entity_id
  GROUP BY e.id, e.entity_type, e.name ORDER BY 3 DESC LIMIT 15`);

// 8. attribute the NEW confidence variation: 27B-escalated partial docs vs the rest
const partial = ["9187184b-0000-4000-8000-79b61dd7a537","69eef971-0000-4000-8000-bc03547ffec4","867c9d37-0000-4000-8000-a9c1df2e824d","60da974c-0000-4000-8000-c4903a1873a6","16868ed9-0000-4000-8000-f224b2e948b2"];
p("edge confidence: 27B partial docs vs the rest", await sql`
  SELECT CASE WHEN thought_id::text = ANY(${sql.array(partial, "TEXT")}) THEN '27B partial docs' ELSE 'all other edges' END AS cohort,
         count(*)::int AS edges,
         round(avg((confidence < 1.0)::int)::numeric, 3) AS frac_sub_1_00,
         round(avg(confidence)::numeric, 3) AS mean_conf
  FROM ob1_entity_edges GROUP BY 1 ORDER BY 1`);

await sql.close();
