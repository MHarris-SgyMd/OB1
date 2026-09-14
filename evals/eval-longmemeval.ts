#!/usr/bin/env bun
/**
 * eval-longmemeval.ts — the fork's retrieval on LongMemEval-S, scored the way
 * the field publishes it.
 *
 * Every retrieval number in this directory is measured on one corpus, and
 * SMD-1039 records the consequence: the baseline saturates it, so each add-on
 * came out neutral. LongMemEval (Wu et al., ICLR 2025; arXiv 2410.10813) is a
 * public benchmark with a published field to stand beside — GBrain reports
 * strict recall_all@5 of 93.40% without its reranker and 95.53% with it, on
 * the same 470 questions — and it fails retrievers in ways a tracker corpus
 * cannot: 133 multi-session questions need two or more sessions in the top
 * five, 133 temporal questions ask about dates, 78 knowledge-update questions
 * have an old and a new answer in the history.
 *
 * WHAT IS MEASURED. Retrieval only, no reader model. LongMemEval-S: 500
 * questions, each over its own history of ~40–50 chat sessions (~115k
 * tokens). One thought per session, captured through the SAME PATH the server
 * uses — chunkContent() from server-portable/chunk.ts for the windows, the
 * document prompt from db/config.mjs, the 4-argument upsert_thought with the
 * 021 envelope — so what is scored is the shipped store, not a re-creation of
 * it. The 30 abstention questions (ids ending `_abs`) are skipped, as the
 * official scorer skips them, which leaves 470.
 *
 * ISOLATION. A session appears in many histories (25,112 memberships over
 * 19,829 distinct sessions), so each is stored once and carries every question
 * id it belongs to as `metadata.lme_q`. A question then searches with the
 * filter `{"lme_q": ["<qid>"]}` — jsonb containment on an array element — so
 * the candidate set is exactly that question's history, through the same
 * filter-inside-the-scan path (014) a filtered `search_thoughts` takes. The
 * control below asserts no result came from outside the history.
 *
 * DEDUP. 003's fingerprint makes two session ids with identical text one row.
 * The loader records which ids share a row, and scoring credits a row with
 * every session id it stands for.
 *
 * METRIC. strict recall_all@k: a question counts only when EVERY gold session
 * is among the top-k distinct sessions. any-hit@k is reported beside it as the
 * diagnostic it is. Both per question type and overall.
 *
 * ARMS. `hybrid` is `search_thoughts_hybrid` as the tools call it (017); at
 * threshold 0.5 it is what `search_thoughts` returns today, at −1 the same
 * fusion with no cosine floor. `vector` is `match_thoughts` alone at −1, so the
 * keyword arm's contribution is visible.
 *
 *   OB1_EVAL_LME=/path/longmemeval_s.json DATABASE_URL=postgres://... bun eval-longmemeval.ts
 *   OB1_EVAL_EMBED=qwen3-embedding:0.6b@1024   embedding spec (default: the fork's default model)
 *   OB1_EVAL_PHASE=load|score|both|windows   default both; load and windows are resumable
 *   OB1_EVAL_BATCH=32                        inputs per embedding request
 *   OB1_EVAL_MAX_QUESTIONS=20                score a prefix only (smoke test)
 *   OB1_EVAL_LME_MAP=/path/map.json          where the session→thought map is kept
 *   OB1_EVAL_LME_ARMS=windows                score the windows question (SMD-1305) instead of the floor
 *   OB1_EVAL_LME_CHUNKS=lme_chunks_4096      a side table of windows to score instead of thought_chunks
 *
 * WINDOWS (SMD-1305). A session over chunk.ts's limit is stored as its whole
 * vector plus overlapping windows, and match_thoughts scores it by the best of
 * them. The `windows` arm set asks what the windows buy: `vector@-1` is
 * match_thoughts as shipped; `both@-1` is the same best-of computed directly
 * over the whole vector and the windows table named by OB1_EVAL_LME_CHUNKS
 * (thought_chunks unless set, when it must agree with `vector@-1` to the row —
 * the control); `whole@-1` reads the whole vector alone, which is the store a
 * load at OB1_CHUNK_TOKENS past every session would have written (the whole
 * vector is the same text under the same model either way, so no reload is
 * needed to know it); `windows@-1` reads the windows alone where a thought has
 * them, its whole vector where it does not; `over<N>@-1` is the rule
 * db/config.mjs's resolveChunkTokens derives for the model — the whole vector
 * alone for a session at or under N estimated tokens, best-of above it — exact
 * when the windows table holds windows of the size the rule names. The direct
 * arms rank one exact scan of the filtered rows, so what differs between arms
 * is the vectors, not the plan. A second table slices every arm by the longest gold session's
 * estimated length, which is where a whole vector would wash out if it does.
 *
 * The `windows` PHASE writes the side table: for every loaded session whose
 * estimate exceeds OB1_CHUNK_TOKENS (which it requires), chunk.ts's windows at
 * that limit are embedded and stored under the thought's id in
 * OB1_EVAL_LME_CHUNKS — the store's whole vectors untouched — so windows at
 * another limit can be scored beside the shipped 1200 without a 14-hour
 * reload. Resumable by thought.
 */
import { SQL } from "bun";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { loadEnv } from "./env.ts";
import { EVAL_BASE, EVAL_HEADERS, applyPrompt, parseSpec } from "./lib.ts";
import { chunkContent, DEFAULT_MAX_TOKENS, estimateTokens } from "../server-portable/chunk.ts";
import { resolveChunkTokens } from "../db/config.mjs";

loadEnv();

const URL_ = process.env.DATABASE_URL;
if (!URL_) { console.error("DATABASE_URL is required."); process.exit(2); }
const DATA = process.env.OB1_EVAL_LME;
if (!DATA || !existsSync(DATA)) { console.error("OB1_EVAL_LME must name longmemeval_s.json."); process.exit(2); }
const EMBED_MODEL = process.env.OB1_EVAL_EMBED ?? "qwen3-embedding:4b@1024";
const spec = parseSpec(EMBED_MODEL);
const DIM = spec.dims ?? 1024;
const PHASE = process.env.OB1_EVAL_PHASE ?? "both";
const BATCH = Number(process.env.OB1_EVAL_BATCH ?? 32);
const MAXQ = Number(process.env.OB1_EVAL_MAX_QUESTIONS ?? 0);
const MAP_PATH = process.env.OB1_EVAL_LME_MAP ?? `/tmp/lme-map-${EMBED_MODEL.replace(/[^A-Za-z0-9.-]+/g, "_")}.json`;
const ARMS = process.env.OB1_EVAL_LME_ARMS ?? "shipped";
if (ARMS !== "shipped" && ARMS !== "windows") { console.error(`OB1_EVAL_LME_ARMS must be shipped or windows, not ${ARMS}.`); process.exit(2); }
if (!["load", "score", "both", "windows"].includes(PHASE)) { console.error(`OB1_EVAL_PHASE must be load, score, both or windows, not ${PHASE}.`); process.exit(2); }
/** The windows table the direct arms read and the windows phase writes; an identifier, interpolated, so it is checked. */
const CHUNKS = process.env.OB1_EVAL_LME_CHUNKS ?? "thought_chunks";
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(CHUNKS)) { console.error(`OB1_EVAL_LME_CHUNKS must be a plain lower-case identifier, not ${CHUNKS}.`); process.exit(2); }

type Turn = { role: string; content: string };
type Question = {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Turn[][];
  answer_session_ids: string[];
};

const questions = JSON.parse(readFileSync(DATA, "utf8")) as Question[];

/**
 * One session as a captured transcript. The date leads, because a pasted
 * transcript carries one and because the temporal questions are unanswerable
 * without it; the turns follow as the harness's own render, role-prefixed.
 */
function sessionText(date: string, turns: Turn[]): string {
  const body = turns.map((t) => `${t.role}: ${t.content}`).join("\n\n");
  return `Session date: ${date}\n\n${body}`;
}

/** Distinct sessions with every question they belong to and the date they carry. */
type Session = { sid: string; date: string; text: string; qids: string[] };
const sessions = new Map<string, Session>();
for (const q of questions) {
  q.haystack_session_ids.forEach((sid, i) => {
    const s = sessions.get(sid);
    if (s) { s.qids.push(q.question_id); return; }
    sessions.set(sid, { sid, date: q.haystack_dates[i], text: sessionText(q.haystack_dates[i], q.haystack_sessions[i]), qids: [q.question_id] });
  });
}

// A smoke run (OB1_EVAL_MAX_QUESTIONS) loads only the histories it will score.
if (MAXQ) {
  const keep = new Set(questions.filter((q) => !q.question_id.endsWith("_abs")).slice(0, MAXQ).map((q) => q.question_id));
  for (const [sid, s] of sessions) if (!s.qids.some((id) => keep.has(id))) sessions.delete(sid);
}

/** `2023/05/20 (Sat) 02:21` → ISO; the benchmark's own format. */
function toIso(d: string): string | null {
  const m = /^(\d{4})\/(\d{2})\/(\d{2}) \(\w{3}\) (\d{2}):(\d{2})$/.exec(d);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z` : null;
}

/** Batched embeddings under the server's own prompt templates. */
async function embedMany(texts: string[], isQuery: boolean): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH).map((t) => applyPrompt(spec, t, isQuery));
    const r = await fetch(`${EVAL_BASE}/embeddings`, {
      method: "POST",
      headers: EVAL_HEADERS,
      body: JSON.stringify({ model: spec.name, input: slice, ...(spec.dims ? { dimensions: spec.dims } : {}) }),
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    const data = (await r.json()) as { data: { index: number; embedding: number[] }[] };
    const sorted = [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    for (const v of sorted) if (v.length !== DIM) throw new Error(`provider returned ${v.length}-wide vectors for a vector(${DIM}) column`);
    out.push(...sorted);
  }
  return out;
}

const toVector = (v: number[]) => `[${v.join(",")}]`;

const sql = new SQL({ url: URL_, max: 4 });

/** session id → thought id, persisted so a load resumes and a score needs no re-derivation. */
type SidMap = Record<string, string>;
function readMap(): SidMap { return existsSync(MAP_PATH) ? (JSON.parse(readFileSync(MAP_PATH, "utf8")) as SidMap) : {}; }
function writeMap(m: SidMap): void { writeFileSync(`${MAP_PATH}.tmp`, JSON.stringify(m)); renameSync(`${MAP_PATH}.tmp`, MAP_PATH); }

async function load(): Promise<void> {
  const map = readMap();
  const todo = [...sessions.values()].filter((s) => !map[s.sid]);
  console.log(`▸ ${sessions.size} distinct sessions, ${Object.keys(map).length} already loaded, ${todo.length} to go — ${EMBED_MODEL}, batch ${BATCH}`);
  const t0 = Date.now();
  let done = 0;
  let tokensSeen = 0;
  // Sessions per round: enough that one embedding request is full of windows.
  const PER_ROUND = Math.max(1, Math.floor(BATCH / 4));
  for (let i = 0; i < todo.length; i += PER_ROUND) {
    const round = todo.slice(i, i + PER_ROUND);
    // The server's shape: the whole content, then the windows chunkContent() cut.
    const items = round.map((s) => ({ s, windows: chunkContent(s.text).map((c) => c.content) }));
    const texts = items.flatMap((it) => [it.s.text, ...it.windows]);
    const vectors = await embedMany(texts, false);
    let k = 0;
    for (const it of items) {
      const whole = vectors[k++];
      const chunks = it.windows.map((content) => ({ content, embedding: toVector(vectors[k++]), context: null }));
      const envelope = {
        metadata: { source: "longmemeval", lme_sid: it.s.sid, lme_q: it.s.qids, session_date: it.s.date },
        embedding_model: spec.name,
      };
      const rows = chunks.length
        ? await sql`SELECT upsert_thought(${it.s.text}::text, ${envelope}::jsonb, ${toVector(whole)}::vector, ${chunks}::jsonb) AS r`
        : await sql`SELECT upsert_thought(${it.s.text}::text, ${envelope}::jsonb, ${toVector(whole)}::vector) AS r`;
      const id = (rows[0]?.r as { id?: string })?.id;
      if (!id) throw new Error(`upsert_thought returned no id for ${it.s.sid}`);
      // A fingerprint twin lands on an existing row whose lme_q lacks this
      // session's questions: merge them so the filter still isolates.
      // Bun serialises a parameter bound as ::jsonb with JSON.stringify, so a
      // pre-stringified value arrives as a JSON *string*; pass the array itself.
      await sql`UPDATE thoughts SET metadata = jsonb_set(metadata, '{lme_q}',
                  (SELECT to_jsonb(array_agg(DISTINCT x)) FROM jsonb_array_elements_text(coalesce(metadata->'lme_q','[]'::jsonb) || ${it.s.qids}::jsonb) AS x))
                WHERE id = ${id}::uuid`;
      const iso = toIso(it.s.date);
      if (iso) await sql`UPDATE thoughts SET created_at = ${iso}::timestamptz WHERE id = ${id}::uuid`;
      map[it.s.sid] = id;
      tokensSeen += Math.round(it.s.text.length / 4);
    }
    done += round.length;
    if (done % (PER_ROUND * 10) === 0 || done === todo.length) {
      writeMap(map);
      const el = (Date.now() - t0) / 1000;
      const rate = done / el;
      console.log(`  ${done}/${todo.length} sessions  ${el.toFixed(0)}s  ${rate.toFixed(2)}/s  ~${Math.round(tokensSeen / el)} content tok/s  eta ${((todo.length - done) / rate / 60).toFixed(0)} min`);
    }
  }
  writeMap(map);
}

/**
 * Windows at another limit, beside the store's (SMD-1305). Needs the load
 * phase's map, OB1_CHUNK_TOKENS for the limit, and OB1_EVAL_LME_CHUNKS naming a
 * table other than thought_chunks, which is the store's own and is not written.
 */
async function loadWindows(): Promise<void> {
  const limit = Number(process.env.OB1_CHUNK_TOKENS);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error("the windows phase needs OB1_CHUNK_TOKENS, the limit to window at.");
  if (CHUNKS === "thought_chunks") throw new Error("the windows phase writes a side table: set OB1_EVAL_LME_CHUNKS to a name other than thought_chunks.");
  const map = readMap();
  const missing = [...sessions.keys()].filter((sid) => !map[sid]);
  if (missing.length) throw new Error(`${missing.length} sessions are not loaded; run the load phase first.`);
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${CHUNKS} (
    thought_id uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    chunk_index int NOT NULL,
    embedding vector(${DIM}) NOT NULL,
    PRIMARY KEY (thought_id, chunk_index))`);
  const done = new Set<string>((await sql.unsafe(`SELECT DISTINCT thought_id FROM ${CHUNKS}`)).map((r: { thought_id: string }) => r.thought_id));
  // By thought, not session: a fingerprint twin is one row, windowed once.
  const todo = new Map<string, Session>();
  for (const s of sessions.values()) {
    const id = map[s.sid];
    if (done.has(id) || todo.has(id) || estimateTokens(s.text) <= limit) continue;
    todo.set(id, s);
  }
  console.log(`▸ windows at ${limit} tokens into ${CHUNKS}: ${todo.size} sessions over the limit to window, ${done.size} already done — ${EMBED_MODEL}, batch ${BATCH}`);
  const items = [...todo.entries()];
  const t0 = Date.now();
  let doneNow = 0, rows = 0, tokens = 0;
  const PER_ROUND = Math.max(1, Math.floor(BATCH / 4));
  for (let i = 0; i < items.length; i += PER_ROUND) {
    const round = items.slice(i, i + PER_ROUND).map(([id, s]) => ({ id, windows: chunkContent(s.text, { maxTokens: limit }).map((c) => c.content) }));
    const vectors = await embedMany(round.flatMap((r) => r.windows), false);
    let k = 0;
    for (const r of round) {
      for (let j = 0; j < r.windows.length; j++) {
        await sql.unsafe(`INSERT INTO ${CHUNKS} (thought_id, chunk_index, embedding) VALUES ($1, $2, $3::vector) ON CONFLICT DO NOTHING`, [r.id, j, toVector(vectors[k++])]);
        tokens += estimateTokens(r.windows[j]);
      }
      rows += r.windows.length;
    }
    doneNow += round.length;
    if (doneNow % (PER_ROUND * 10) === 0 || doneNow === items.length) {
      const el = (Date.now() - t0) / 1000;
      console.log(`  ${doneNow}/${items.length} sessions  ${rows} windows  ${el.toFixed(0)}s  ${(doneNow / el).toFixed(2)}/s  ~${Math.round(tokens / el)} window tok/s  eta ${((items.length - doneNow) / (doneNow / el) / 60).toFixed(0)} min`);
    }
  }
  console.log(`✓ ${rows} windows at ${limit} tokens (${tokens.toLocaleString()} estimated tokens) over ${items.length} sessions in ${CHUNKS}`);
}

type Arm = { key: string; label: string; run: (qv: string, q: Question, k: number) => Promise<string[]> };

async function score(): Promise<void> {
  const map = readMap();
  const missing = [...sessions.keys()].filter((sid) => !map[sid]);
  if (missing.length) throw new Error(`${missing.length} sessions are not loaded; run the load phase first.`);
  const idToSids = new Map<string, string[]>();
  for (const [sid, id] of Object.entries(map)) idToSids.set(id, [...(idToSids.get(id) ?? []), sid]);

  const scored = questions.filter((q) => !q.question_id.endsWith("_abs"));
  const use = MAXQ ? scored.slice(0, MAXQ) : scored;
  console.log(`▸ scoring ${use.length} questions (${questions.length - scored.length} abstention skipped) — ${EMBED_MODEL}`);

  // An object, not a JSON string: Bun stringifies a ::jsonb parameter itself,
  // and a string would arrive as a jsonb scalar that nothing contains.
  const filterFor = (q: Question) => ({ lme_q: [q.question_id] });
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
  const shipped: Arm[] = [
    {
      key: "hybrid@0.5", label: "hybrid, threshold 0.5 (what search_thoughts sent before SMD-1300)",
      run: async (qv, q, k) => ids(await sql`SELECT id FROM search_thoughts_hybrid(${qv}::vector, ${q.question}, 0.5, ${k}, ${filterFor(q)}::jsonb)`),
    },
    {
      // SMD-1300 / migration 027: the tools now send a threshold of 0, and the
      // function admits relative to the top match. This is the SHIPPED arm once
      // 027 is applied; against a pre-027 database it is the plain no-floor call.
      key: "hybrid@0 (027)", label: "hybrid, threshold 0 — the relative cutoff governs (search_thoughts today)",
      run: async (qv, q, k) => ids(await sql`SELECT id FROM search_thoughts_hybrid(${qv}::vector, ${q.question}, 0.0, ${k}, ${filterFor(q)}::jsonb)`),
    },
    {
      key: "hybrid@-1", label: "hybrid, threshold -1 — no floor of any kind (027 treats a negative threshold as the raw ranked list)",
      run: async (qv, q, k) => ids(await sql`SELECT id FROM search_thoughts_hybrid(${qv}::vector, ${q.question}, -1.0, ${k}, ${filterFor(q)}::jsonb)`),
    },
    {
      key: "vector@-1", label: "vector only (match_thoughts: best of the whole vector and the windows)",
      run: async (qv, q, k) => ids(await sql`SELECT id FROM match_thoughts(${qv}::vector, -1.0, ${k}, ${filterFor(q)}::jsonb)`),
    },
  ];
  // The windows question (SMD-1305; the header explains the arms). One query
  // per question fetches every filtered thought with its whole-vector
  // similarity and its best window's — an exact scan, OFFSET 0 the planner
  // fence so it cannot become an HNSW walk that returns short under a
  // filter — and each direct arm is a rule over those two numbers, ranked
  // here. These arms measure vectors, and must not measure plans.
  type Scored = { id: string; whole: number | null; win: number | null; est: number };
  const scoredCache = new Map<string, Scored[]>();
  const scoredFor = async (qv: string, q: Question): Promise<Scored[]> => {
    const hit = scoredCache.get(q.question_id);
    if (hit) return hit;
    const rows = (await sql.unsafe(
      `SELECT t.id, 1 - (t.embedding <=> $1::vector) AS whole,
              (SELECT max(1 - (c.embedding <=> $1::vector)) FROM ${CHUNKS} c WHERE c.thought_id = t.id) AS win
       FROM thoughts t WHERE t.metadata @> $2::jsonb OFFSET 0`,
      // The object, as above: Bun stringifies a ::jsonb parameter itself.
      [qv, filterFor(q)])) as { id: string; whole: number | null; win: number | null }[];
    // The thought's estimated length, from the loader's own text; a twin's
    // sessions share it.
    const scored = rows.map((r) => ({ ...r, est: estimateTokens(sessions.get(idToSids.get(r.id)![0])!.text) }));
    scoredCache.set(q.question_id, scored);
    return scored;
  };
  const rank = (score: (s: Scored) => number | null) => async (qv: string, q: Question, k: number) =>
    (await scoredFor(qv, q))
      .map((s) => ({ id: s.id, sim: score(s) }))
      .filter((s): s is { id: string; sim: number } => s.sim !== null)
      .sort((a, b) => b.sim - a.sim || (a.id < b.id ? -1 : 1))
      .slice(0, k)
      .map((s) => s.id);
  const best = (s: Scored) => (s.whole === null ? s.win : s.win === null ? s.whole : Math.max(s.whole, s.win));
  // The rule the server derives for this model (db/config.mjs), unpinned.
  const derived = resolveChunkTokens(undefined, spec.name, DEFAULT_MAX_TOKENS);
  const windows: Arm[] = [
    shipped.find((a) => a.key === "vector@-1")!,
    { key: "both@-1", label: `best of the whole vector and the windows in ${CHUNKS}`, run: rank(best) },
    { key: "whole@-1", label: "the whole-content vector alone (what a load with no windows stores)", run: rank((s) => s.whole) },
    { key: "windows@-1", label: `the windows in ${CHUNKS} alone where a thought has them, its whole vector where it does not`, run: rank((s) => s.win ?? s.whole) },
    {
      key: `over${derived.threshold}@-1`,
      label: `the whole vector alone for a session at or under ${derived.threshold} estimated tokens, best of it and the windows in ${CHUNKS} above — the rule resolveChunkTokens derives for ${spec.name} (${derived.tokens}-token windows)`,
      run: rank((s) => (s.est <= derived.threshold ? s.whole : best(s))),
    },
  ];
  const arms = ARMS === "windows" ? windows : shipped;
  /** The arm whose misses are listed: the one each set exists to examine. */
  const missArm = ARMS === "windows" ? "whole@-1" : "hybrid@0.5";
  const KS = [5, 10];

  // The length slice: a question sits in the bucket of its LONGEST gold
  // session, since that is the vector with the most to wash out. Estimated
  // tokens, as chunk.ts estimates them, so the first bucket is exactly the
  // sessions that were never windowed.
  const BUCKETS: [string, (t: number) => boolean][] = [
    [`≤${DEFAULT_MAX_TOKENS} (no windows)`, (t) => t <= DEFAULT_MAX_TOKENS],
    [`${DEFAULT_MAX_TOKENS + 1}–2048`, (t) => t > DEFAULT_MAX_TOKENS && t <= 2048],
    ["2049–4096", (t) => t > 2048 && t <= 4096],
    [">4096", (t) => t > 4096],
  ];
  const bucketOf = (q: Question): string => {
    const longest = Math.max(...q.answer_session_ids.map((sid) => estimateTokens(sessions.get(sid)!.text)));
    return BUCKETS.find(([, fits]) => fits(longest))![0];
  };

  type Cell = { strict: number; any: number; n: number };
  const cell = (): Cell => ({ strict: 0, any: 0, n: 0 });
  const table = new Map<string, Cell>(); // `${arm}|${k}|${type}`
  const bump = (key: string, strict: boolean, any: boolean) => {
    const c = table.get(key) ?? cell();
    c.n++; if (strict) c.strict++; if (any) c.any++;
    table.set(key, c);
  };
  const misses: string[] = [];
  let outside = 0;
  /**
   * Calls that returned fewer rows than asked, per arm. Under the old absolute
   * floor this was the bug's signature (the floor cut the history to nothing).
   * Under 027's relative cutoff a short call is usually the cutoff trimming
   * filler, so `shortLost` — short calls that ALSO missed a gold session — is
   * the honest one to watch: it should stay near zero while `short` need not.
   */
  const shortByArm = new Map<string, number>();
  const shortLostByArm = new Map<string, number>();
  let queryMs = 0;
  const t0 = Date.now();

  const qvs = await embedMany(use.map((q) => q.question), true);
  for (let i = 0; i < use.length; i++) {
    const q = use[i];
    const qv = toVector(qvs[i]);
    const hay = new Set(q.haystack_session_ids);
    const gold = new Set(q.answer_session_ids);
    for (const arm of arms) {
      for (const k of KS) {
        const tq = Date.now();
        const ids = await arm.run(qv, q, k);
        queryMs += Date.now() - tq;
        const sids: string[] = [];
        for (const id of ids) {
          const own = idToSids.get(id);
          // CONTROL: every returned row is one the loader wrote, else the
          // mapping is broken and a 0% would be the harness, not the store.
          if (!own) throw new Error(`CONTROL FAILED: ${arm.key} returned ${id}, which the loader did not record.`);
          // A fingerprint twin stands for session ids in several histories;
          // in this question it is the one(s) in this history. A row none of
          // whose ids is in the history is a filter failure, counted below.
          const here = own.filter((sid) => hay.has(sid));
          if (!here.length) outside++;
          for (const sid of here) if (!sids.includes(sid)) sids.push(sid);
        }
        const top = new Set(sids.slice(0, k));
        const strict = [...gold].every((g) => top.has(g));
        const any = [...gold].some((g) => top.has(g));
        if (ids.length < Math.min(k, hay.size)) {
          const sk = `${arm.key}|${k}`;
          shortByArm.set(sk, (shortByArm.get(sk) ?? 0) + 1);
          if (!strict) shortLostByArm.set(sk, (shortLostByArm.get(sk) ?? 0) + 1);
        }
        bump(`${arm.key}|${k}|${q.question_type}`, strict, any);
        bump(`${arm.key}|${k}|ALL`, strict, any);
        bump(`${arm.key}|${k}|len:${bucketOf(q)}`, strict, any);
        if (arm.key === missArm && k === 5 && !strict) misses.push(`${q.question_type}  ${q.question_id}  ${q.question.slice(0, 80)}`);
      }
    }
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${use.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  if (outside) throw new Error(`CONTROL FAILED: ${outside} results came from outside the question's history; the filter did not isolate.`);
  console.log(`\n✓ control: every result was inside its question's history (${use.length} questions × ${arms.length} arms × ${KS.length} k)`);
  console.log(`  ${(queryMs / (use.length * arms.length * KS.length)).toFixed(1)} ms per search call, mean`);
  console.log(`  short calls (returned < rows asked) — short / of-those-missing-a-gold, per arm per k:`);
  for (const k of KS) for (const a of arms) console.log(`    k=${k} ${a.key}: ${shortByArm.get(`${a.key}|${k}`) ?? 0} / ${shortLostByArm.get(`${a.key}|${k}`) ?? 0}`);

  const types = ["single-session-user", "single-session-assistant", "single-session-preference", "multi-session", "temporal-reasoning", "knowledge-update", "ALL"];
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "—");
  const printTable = (k: number, head: string, rows: string[]) => {
    console.log(`\n| ${head} | n | ${arms.map((a) => a.key).join(" | ")} |`);
    console.log(`| --- | --- | ${arms.map(() => "---").join(" | ")} |`);
    for (const t of rows) {
      const n = table.get(`${arms[0].key}|${k}|${t}`)?.n ?? 0;
      if (!n) continue;
      const cells = arms.map((a) => { const c = table.get(`${a.key}|${k}|${t}`) ?? cell(); return `${pct(c.strict, c.n)} (${pct(c.any, c.n)})`; });
      console.log(`| ${t.replace(/^len:/, "")} | ${n} | ${cells.join(" | ")} |`);
    }
  };
  for (const k of KS) {
    console.log(`\n## strict recall_all@${k} (any-hit@${k} in parentheses)`);
    printTable(k, "question type", types);
    printTable(k, "longest gold session, est. tokens", BUCKETS.map(([name]) => `len:${name}`));
  }
  console.log(`\narms: ${arms.map((a) => `${a.key} = ${a.label}`).join("; ")}`);
  if (ARMS === "windows") {
    // The write cost of two rules over the sessions this run scored, in the
    // loader's own estimate: windows at OB1_CHUNK_TOKENS (the shipped 1200
    // unless the run names another), and the rule derived for this model —
    // what a load under each embeds beyond the whole vectors.
    const cost = (threshold: number, size: number) => {
      let whole = 0, win = 0, rows = 0, chunked = 0;
      for (const s of sessions.values()) {
        whole += estimateTokens(s.text);
        const w = chunkContent(s.text, { maxTokens: size, threshold });
        if (w.length) chunked++;
        rows += w.length;
        for (const c of w) win += estimateTokens(c.content);
      }
      return { whole, win, rows, chunked };
    };
    const limit = Number(process.env.OB1_CHUNK_TOKENS) || DEFAULT_MAX_TOKENS;
    const rules: [string, number, number][] = [
      [`${limit}-token windows above ${limit}${limit === DEFAULT_MAX_TOKENS ? " (shipped)" : ""}`, limit, limit],
      [`${derived.tokens}-token windows above ${derived.threshold} (derived for ${spec.name})`, derived.threshold, derived.tokens],
    ];
    console.log(`\ntokens embedded, estimated as chunk.ts estimates them, over ${sessions.size.toLocaleString()} sessions:`);
    for (const [name, threshold, size] of rules) {
      const c = cost(threshold, size);
      console.log(`  ${name}: whole ${c.whole.toLocaleString()} + windows ${c.win.toLocaleString()} over ${c.rows.toLocaleString()} rows from ${c.chunked.toLocaleString()} sessions = ${((c.whole + c.win) / c.whole).toFixed(2)}× a load with no windows`);
    }
  }
  console.log(`\n${misses.length} misses on ${missArm} at k=5 (first 25):`);
  for (const m of misses.slice(0, 25)) console.log(`  ${m}`);
}

if (PHASE === "load" || PHASE === "both") await load();
if (PHASE === "windows") await loadWindows();
if (PHASE === "score" || PHASE === "both") await score();
await sql.end();
