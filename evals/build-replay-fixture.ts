#!/usr/bin/env bun
/**
 * build-replay-fixture.ts — regenerate the committed CI replay fixture
 * (SMD-1295). Run by a maintainer, never in CI; the fixture it writes is what
 * db/test-replay.ts replays offline, with no model and no key.
 *
 * The CI gate needs a corpus to replay against, and the real corpus is neither
 * committable (content) nor available in CI. So this generates a SYNTHETIC one:
 * seeded random unit vectors for the thoughts, and one query per gold placed
 * near its thought's vector (a small deterministic perturbation), so each query
 * has a known nearest neighbour. No text, no real data — only ids and vectors,
 * regenerable from the seed. That is exactly what a redacted export of a real
 * brain would look like to the vector arm, which is all the gate exercises.
 *
 * The gate asserts a recall@5 floor: at HEAD every gold is rank 1, so mean
 * recall@5 is 1.0; a retrieval change that reorders the candidate scan drops
 * golds below rank 5 and fails the floor. db/test-replay.ts also proves the
 * floor has teeth by replaying random query vectors and watching recall collapse.
 *
 *   bun evals/build-replay-fixture.ts        # writes evals/fixtures/replay-fixture.json
 */

import { seededRandom } from "../db/test-support.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SEED = 1295;
const DIM = 32;
const THOUGHTS = 30;
const RECALL_FLOOR = 0.8;

const { unitVector } = seededRandom(SEED);

// Deterministic ids so a regenerated fixture keeps the same rows.
const idOf = (n: number) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const round = (v: number[]) => v.map((x) => Number(x.toFixed(6)));
const normalise = (v: number[]) => { const m = Math.hypot(...v) || 1; return v.map((x) => x / m); };

const thoughts = Array.from({ length: THOUGHTS }, (_, i) => ({ id: idOf(i), embedding: round(unitVector(DIM)) }));

// One query per gold: the gold's vector nudged by a small random step, so the
// gold stays its nearest neighbour by a clear margin. Plus one two-gold query
// (the midpoint of two thoughts), the multi-hop shape this ticket is about.
const queries: { embedding: number[]; relevant: string[] }[] = [];
for (let i = 0; i < 12; i++) {
  const g = i * 2; // spread the golds across the corpus
  const noise = unitVector(DIM);
  const q = normalise(thoughts[g].embedding.map((x, d) => x + 0.15 * noise[d]));
  queries.push({ embedding: round(q), relevant: [idOf(g)] });
}
// A midpoint query with two relevant thoughts, both expected in the top 5.
{
  const a = 1, b = 3;
  const q = normalise(thoughts[a].embedding.map((x, d) => x + thoughts[b].embedding[d]));
  queries.push({ embedding: round(q), relevant: [idOf(a), idOf(b)] });
}

const fixture = {
  seed: SEED,
  dim: DIM,
  recallFloor: RECALL_FLOOR,
  note: "Synthetic, seeded, content-free (SMD-1295). Regenerate with evals/build-replay-fixture.ts. Replayed offline by db/test-replay.ts — no model, no key. Ids and vectors only.",
  thoughts,
  queries,
};

const OUT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "replay-fixture.json");
await Bun.write(OUT, JSON.stringify(fixture) + "\n");
process.stderr.write(`  wrote ${thoughts.length} thoughts, ${queries.length} queries (dim ${DIM}, floor ${RECALL_FLOOR}) → ${OUT}\n`);
