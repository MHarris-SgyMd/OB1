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
 * it. One deliberate exception since SMD-1305: the loader windows at chunk.ts's
 * constant (1200 above 1200), not at the rule the server derives for the
 * model, so that the whole vector and the 1200-token windows are both stored
 * and every rule — no windows, the constant, the derived threshold — is
 * readable from the one store. The 30 abstention questions (ids ending `_abs`) are skipped, as the
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
 * LOADING. The corpus is read as a STREAM of top-level question objects, not one
 * `readFileSync` — LongMemEval-M is ~2.5 GB and a single string that large
 * exceeds JavaScriptCore's ~2.14 GB cap (bun throws ENOMEM). Streaming holds
 * only one question object plus the deduped session map at a time, so a multi-GB
 * corpus loads with the SAME one command as S. And because a single process
 * still sees every question, each session's `lme_q` is the union of all its
 * questions' ids by construction — no shard-and-complete post-pass (SMD-1438).
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
 *   OB1_EVAL_LME_ARMS=current                score the current-value question (SMD-1720) on the knowledge-update slice
 *   OB1_EVAL_LME_CHUNKS=lme_chunks_4096      a side table of windows to score instead of thought_chunks
 *
 * THE MAP is derived data. Every row the loader writes carries the id of the
 * session that created it as `metadata.lme_sid` (a twin loaded later leaves
 * it alone), and a fingerprint twin's other ids have the row's exact text, so
 * a map lost with /tmp is rebuilt from the store by whichever phase reads it
 * first, instead of by a 14-hour reload (SMD-1720's run found both S maps
 * gone). The rebuild is per model, and it re-runs the question merge for a
 * twin it matches.
 *
 * CURRENT VALUE (SMD-1720). Every knowledge-update question has exactly two
 * gold sessions — one states a value, a later one updates it — and strict
 * recall_all counts the question when BOTH are in the top k. That is the
 * benchmark's frame. MERIT's is the reader's: which of the two is handed over
 * first, because a stale value ranked above its update is the failure an
 * update-on-write store never has, and the slice's 97% strict says nothing
 * about it. The `current` arm set scores both frames over the same calls, on
 * the knowledge-update slice alone: `both` (strict), `current-in` (the current
 * session in the top k), `current-first` (in the top k and above the stale
 * one, or the stale one absent — what a reader that takes the first relevant
 * hit gets right), `stale-only` (the stale one in the top k and the current one
 * not) and `current@1`. Arms: the shipped order; 020's recency blend as a
 * caller can send it today (`recency_weight`, half-life 90 days — on a corpus
 * three years old that is a no-op below weight 1, and the arm shows it), the
 * same blend at a half-life long enough to see a week, and age alone — under
 * the history filter the blend runs over every row of the history, so that
 * arm is the k newest sessions in it; and `resolve`, the ticket's chain-walking read as an
 * ORACLE — the store carries no supersedes pointers (the count is printed; the
 * consolidation pass has not run here, and at one thought per session it
 * would judge whole conversations), so the arm walks each question's gold pair,
 * held in memory, as if a reviewer had accepted exactly the right proposal: a hit that
 * is the stale session is replaced by the current one at the hit's rank, and a
 * session already listed is not listed twice. That is the upper bound of what
 * the read could buy, not a measurement of it. Every arm is paired with the
 * shipped order per question — helped / hurt and McNemar's exact test, the
 * way SMD-1420 reported — not compared as means.
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
 * reload. Resumable by thought. The windows carry chunk.ts's default overlap,
 * which is what the server uses for any explicit OB1_CHUNK_TOKENS and for
 * every derived window of 1200; only a window a small model DERIVES (a
 * 512-token model's 300, overlap 37) differs, and no such model is measured
 * here.
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
if (ARMS !== "shipped" && ARMS !== "windows" && ARMS !== "current") { console.error(`OB1_EVAL_LME_ARMS must be shipped, windows or current, not ${ARMS}.`); process.exit(2); }
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

/**
 * Only the fields scoring reads — the gold set, the question text and type, and
 * the session-id list the isolation control checks against. The heavy
 * `haystack_sessions` transcripts are folded into `sessions` as each question
 * streams by and then dropped, so the whole corpus never sits in memory at once
 * (SMD-1438).
 */
type ScoreQ = Pick<Question, "question_id" | "question_type" | "question" | "answer_session_ids" | "haystack_session_ids">;
const questions: ScoreQ[] = [];
/** The questions an arm set scores: every non-abstention one, or the knowledge-update slice for `current`. One rule for the prune and the score. */
const scorable = (qs: ScoreQ[]) => qs.filter((q) => !q.question_id.endsWith("_abs") && (ARMS !== "current" || q.question_type === "knowledge-update"));

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

/** Concatenate the byte pieces of one streamed object into a single buffer. */
function concatBytes(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Stream the top-level objects of a JSON array file one at a time, so the file
 * is never a single string (LongMemEval-M is past JavaScriptCore's string cap;
 * SMD-1438). Scans bytes for the structural `{ } [ ]` while tracking string
 * state and escapes — those, plus `"` and `\`, are single ASCII bytes that
 * never occur inside a UTF-8 multibyte sequence, so byte scanning is exact —
 * and decodes-then-parses each depth-1 object on its own. Zero dependencies;
 * evals run under bare bun.
 */
async function streamJsonArray<T>(path: string, onItem: (item: T) => void): Promise<void> {
  const reader = Bun.file(path).stream().getReader();
  const decoder = new TextDecoder();
  let depth = 0, inStr = false, esc = false, collecting = false;
  let pieces: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value as Uint8Array;
      // If a prior chunk left an object open, this chunk contributes from byte 0.
      let sliceStart = collecting ? 0 : -1;
      for (let i = 0; i < chunk.length; i++) {
        const b = chunk[i];
        if (inStr) {
          if (esc) esc = false;
          else if (b === 0x5c) esc = true;    // backslash: next char is literal
          else if (b === 0x22) inStr = false; // closing quote
          continue;
        }
        if (b === 0x22) { inStr = true; continue; } // opening quote
        else if (b === 0x7b) {                       // {
          depth++;
          if (depth === 2) { collecting = true; sliceStart = i; } // a top-level object opens
        } else if (b === 0x7d) {                     // }
          depth--;
          if (depth === 1) {                         // the top-level object closed at i
            pieces.push(chunk.slice(sliceStart, i + 1));
            onItem(JSON.parse(decoder.decode(concatBytes(pieces))) as T);
            pieces = [];
            collecting = false;
            sliceStart = -1;
          }
        } else if (b === 0x5b) depth++;              // [
        else if (b === 0x5d) depth--;                // ]
      }
      if (collecting && sliceStart >= 0) pieces.push(chunk.slice(sliceStart, chunk.length));
    }
  } finally {
    reader.releaseLock();
  }
}

/** Build the session map and the slim question list by streaming the corpus. */
async function ingest(): Promise<void> {
  await streamJsonArray<Question>(DATA!, (q) => {
    q.haystack_session_ids.forEach((sid, i) => {
      const s = sessions.get(sid);
      if (s) { s.qids.push(q.question_id); return; }
      sessions.set(sid, { sid, date: q.haystack_dates[i], text: sessionText(q.haystack_dates[i], q.haystack_sessions[i]), qids: [q.question_id] });
    });
    questions.push({ question_id: q.question_id, question_type: q.question_type, question: q.question, answer_session_ids: q.answer_session_ids, haystack_session_ids: q.haystack_session_ids });
  });

  // A smoke run (OB1_EVAL_MAX_QUESTIONS) loads only the histories it will score
  // — the first MAXQ of the questions the arm set scores, so the `current` set
  // keeps knowledge-update histories, not the file's first few of every type
  // (first review pass).
  if (MAXQ) {
    const keep = new Set(scorable(questions).slice(0, MAXQ).map((q) => q.question_id));
    for (const [sid, s] of sessions) if (!s.qids.some((id) => keep.has(id))) sessions.delete(sid);
  }
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
function writeMap(m: SidMap): void { writeFileSync(`${MAP_PATH}.tmp`, JSON.stringify(m)); renameSync(`${MAP_PATH}.tmp`, MAP_PATH); }
/**
 * The map file, or the map rebuilt from the store when the file is gone (the
 * header's THE MAP): every row's `lme_sid`, then the sessions still unmapped
 * looked up by fingerprint — a twin folded onto another session's row. A
 * session in neither is not loaded, which is what the load phase then does.
 * Under OB1_EVAL_MAX_QUESTIONS only the kept histories' sessions are in memory
 * to look up; a pruned twin left out costs a later load one embedding call
 * that lands on its existing row.
 */
async function readMapOrRebuild(): Promise<SidMap> {
  if (existsSync(MAP_PATH)) return JSON.parse(readFileSync(MAP_PATH, "utf8")) as SidMap;
  // The map is per model (MAP_PATH carries the spec), so only rows this model
  // embedded count as loaded; a store under another model rebuilds to nothing
  // and the load phase re-embeds, as the lost map used to make it (first
  // review pass).
  const rows = (await sql`SELECT id, metadata->>'lme_sid' AS sid FROM thoughts WHERE metadata ? 'lme_sid' AND embedding_model = ${spec.name}`) as { id: string; sid: string }[];
  if (!rows.length) {
    // Say which it is — an empty store, or a store under another label —
    // before the load phase re-embeds everything (second review pass).
    const other = ((await sql`SELECT count(*)::int AS n FROM thoughts WHERE metadata ? 'lme_sid'`) as { n: number }[])[0].n;
    if (other) console.log(`▸ no map at ${MAP_PATH}, and no loaded row carries embedding_model ${spec.name} (${other} rows carry another label or none); the load phase starts from nothing`);
    return {};
  }
  const map: SidMap = {};
  for (const r of rows) map[r.sid] = r.id;
  let twins = 0;
  for (const s of sessions.values()) {
    if (map[s.sid]) continue;
    const hit = (await sql`SELECT id FROM thoughts WHERE content_fingerprint = content_fingerprint_of(${s.text}::text) AND metadata ? 'lme_sid' AND embedding_model = ${spec.name}`) as { id: string }[];
    if (hit.length !== 1) continue;
    // A twin's questions reach the row only through the load phase's merge,
    // which a load that died between the upsert and the merge never ran; the
    // merge is idempotent, so run it for every rebuilt twin rather than trust
    // it (first review pass).
    await sql`UPDATE thoughts SET metadata = jsonb_set(metadata, '{lme_q}',
                (SELECT to_jsonb(array_agg(DISTINCT x)) FROM jsonb_array_elements_text(coalesce(metadata->'lme_q','[]'::jsonb) || ${s.qids}::jsonb) AS x))
              WHERE id = ${hit[0].id}::uuid`;
    map[s.sid] = hit[0].id;
    twins++;
  }
  writeMap(map);
  console.log(`▸ no map at ${MAP_PATH}; rebuilt ${Object.keys(map).length} entries from the store's lme_sid under ${spec.name} (${twins} fingerprint twins matched by fingerprint, their questions merged)`);
  return map;
}

async function load(): Promise<void> {
  const map = await readMapOrRebuild();
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
      // The session's ids stay OUT of the envelope: upsert_thought merges
      // metadata key by key (`thoughts.metadata || EXCLUDED.metadata`), so an
      // envelope carrying lme_q / lme_sid onto a fingerprint twin's existing
      // row would REPLACE the first session's questions and id before the
      // merge below could union them — the merge then unioned the new list
      // with itself, and the first twin's questions were gone (second review
      // pass). They are written after the upsert instead: lme_q as a union;
      // lme_sid only where the row has none; created_at only on the row whose
      // lme_sid is this session — the row's first session — so a load that
      // dies between the two writes is repaired by the next one rather than
      // left dated at load time (third review pass). (upsert_thought's
      // `existed` flag is 035's, and a store loaded at 025, as the persisted
      // ones were, does not return it; nothing here reads it.)
      const envelope = {
        metadata: { source: "longmemeval", session_date: it.s.date },
        embedding_model: spec.name,
      };
      const rows = chunks.length
        ? await sql`SELECT upsert_thought(${it.s.text}::text, ${envelope}::jsonb, ${toVector(whole)}::vector, ${chunks}::jsonb) AS r`
        : await sql`SELECT upsert_thought(${it.s.text}::text, ${envelope}::jsonb, ${toVector(whole)}::vector) AS r`;
      const id = (rows[0]?.r as { id?: string } | undefined)?.id;
      if (!id) throw new Error(`upsert_thought returned no id for ${it.s.sid}`);
      // Bun serialises a parameter bound as ::jsonb with JSON.stringify, so a
      // pre-stringified value arrives as a JSON *string*; pass the array itself.
      await sql`UPDATE thoughts SET metadata = jsonb_set(metadata, '{lme_q}',
                  (SELECT to_jsonb(array_agg(DISTINCT x)) FROM jsonb_array_elements_text(coalesce(metadata->'lme_q','[]'::jsonb) || ${it.s.qids}::jsonb) AS x))
                WHERE id = ${id}::uuid`;
      await sql`UPDATE thoughts SET metadata = metadata || jsonb_build_object('lme_sid', ${it.s.sid}::text) WHERE id = ${id}::uuid AND NOT metadata ? 'lme_sid'`;
      const iso = toIso(it.s.date);
      if (iso) await sql`UPDATE thoughts SET created_at = ${iso}::timestamptz WHERE id = ${id}::uuid AND metadata->>'lme_sid' = ${it.s.sid}::text`;
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
  const map = await readMapOrRebuild();
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
      // A thought's windows land together or not at all: the resume reads
      // DISTINCT thought_id, so a thought half-written by an interrupted run
      // would otherwise count as done with windows missing (first review pass).
      const vs = r.windows.map(() => toVector(vectors[k++]));
      await sql.begin(async (tx) => {
        for (let j = 0; j < vs.length; j++) {
          await tx.unsafe(`INSERT INTO ${CHUNKS} (thought_id, chunk_index, embedding) VALUES ($1, $2, $3::vector) ON CONFLICT DO NOTHING`, [r.id, j, vs[j]]);
        }
      });
      for (const w of r.windows) tokens += estimateTokens(w);
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

type Arm = { key: string; label: string; run: (qv: string, q: ScoreQ, k: number) => Promise<string[]> };

/**
 * The isolation filter: this question's history, by id — jsonb array
 * containment through 014's filter-inside-the-scan path. An object, not a
 * JSON string: Bun stringifies a ::jsonb parameter itself, and a string would
 * arrive as a jsonb scalar that nothing contains.
 */
const filterFor = (q: ScoreQ) => ({ lme_q: [q.question_id] });
const KS = [5, 10];

/**
 * The returned thought ids as the distinct session ids of THIS history, in
 * rank order — the control both scorers share. A row the loader did not write
 * is a broken mapping and is thrown, since a 0% would be the harness, not the
 * store; a fingerprint twin stands for session ids in several histories and
 * counts here as the one(s) in this history; a row none of whose ids is in the
 * history is a filter failure, counted for the caller to refuse on.
 */
function sidsInHistory(ids: string[], hay: Set<string>, idToSids: Map<string, string[]>, armKey: string): { sids: string[]; outside: number } {
  const sids: string[] = [];
  let outside = 0;
  for (const id of ids) {
    const own = idToSids.get(id);
    if (!own) throw new Error(`CONTROL FAILED: ${armKey} returned ${id}, which the loader did not record.`);
    const here = own.filter((sid) => hay.has(sid));
    if (!here.length) outside++;
    for (const sid of here) if (!sids.includes(sid)) sids.push(sid);
  }
  return { sids, outside };
}

/**
 * McNemar's exact test, two-sided: the discordant pairs (helped, hurt) under a
 * fair coin. The binomial sum is exact in doubles while 2^n is finite — n at
 * most 1,000, twice the corpus — and refused beyond, rather than printing a
 * p of 0 (third review pass).
 */
function mcnemarExact(helped: number, hurt: number): number {
  const n = helped + hurt;
  if (n === 0) return 1;
  if (n > 1000) throw new Error(`mcnemarExact: ${n} discordant pairs is past the exact sum's range; use a normal approximation.`);
  const lo = Math.min(helped, hurt);
  let c = 1, tail = 0;
  for (let i = 0; i <= lo; i++) { tail += c; c = (c * (n - i)) / (i + 1); }
  return Math.min(1, (2 * tail) / 2 ** n);
}

/** The current-value question (SMD-1720; the header's CURRENT VALUE). */
async function scoreCurrent(map: SidMap, idToSids: Map<string, string[]>): Promise<void> {
  const ku = scorable(questions);
  const use = MAXQ ? ku.slice(0, MAXQ) : ku;
  if (!use.length) throw new Error("CONTROL FAILED: no knowledge-update questions in this run; the current-value question has nothing to score.");
  // CONTROL: the slice's shape — two gold sessions, dated apart, the earlier
  // one stating the value the later one updates. A question outside the shape
  // would make "current" a guess, so the run refuses instead.
  type Pair = { q: ScoreQ; stale: string; current: string; gapDays: number };
  const pairs: Pair[] = use.map((q) => {
    if (q.answer_session_ids.length !== 2) throw new Error(`CONTROL FAILED: ${q.question_id} has ${q.answer_session_ids.length} gold sessions, not the two a knowledge update has.`);
    const [a, b] = q.answer_session_ids.map((sid) => {
      const s = sessions.get(sid);
      const iso = s ? toIso(s.date) : null;
      if (!s || !iso) throw new Error(`CONTROL FAILED: gold session ${sid} of ${q.question_id} has no readable date.`);
      return { sid, t: Date.parse(iso) };
    });
    if (a.t === b.t) throw new Error(`CONTROL FAILED: ${q.question_id}'s gold sessions share a date; neither is the update.`);
    const [stale, current] = a.t < b.t ? [a, b] : [b, a];
    return { q, stale: stale.sid, current: current.sid, gapDays: (current.t - stale.t) / 86_400_000 };
  });
  const gaps = pairs.map((p) => p.gapDays).sort((x, y) => x - y);
  console.log(`▸ the current-value question over ${pairs.length} knowledge-update questions — ${EMBED_MODEL}`);
  const median = gaps.length % 2 ? gaps[(gaps.length - 1) / 2] : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;
  console.log(`  stale → current gap: median ${median.toFixed(0)} days, min ${gaps[0].toFixed(0)}, max ${gaps[gaps.length - 1].toFixed(0)}`);

  // The chain precondition: what a resolving read has to walk. With pointers in
  // the store the arm walks THEM — superseded → superseder, the read as it
  // would run — and only a store with none falls back to the oracle, so the
  // corpus the decision waits for is measured, not re-oracled (first review
  // pass).
  const pointers = ((await sql`SELECT count(supersedes)::int AS n FROM thoughts WHERE metadata ? 'lme_q'`) as { n: number }[])[0].n;
  const oracle = pointers === 0;
  const storeChain = new Map<string, string>();
  if (!oracle) {
    // A row two rows supersede (025's column allows it) has two heads, and a
    // map would keep whichever came last in scan order; refuse rather than
    // pick one silently (second review pass).
    for (const r of (await sql`SELECT id, supersedes FROM thoughts WHERE supersedes IS NOT NULL AND metadata ? 'lme_q'`) as { id: string; supersedes: string }[]) {
      if (storeChain.has(r.supersedes)) throw new Error(`CONTROL FAILED: ${r.supersedes} is superseded by both ${storeChain.get(r.supersedes)} and ${r.id}; the chain forks and the read has no one head to return.`);
      storeChain.set(r.supersedes, r.id);
    }
  }
  console.log(`  supersedes pointers on the corpus: ${pointers}${oracle ? " — a chain-walking read returns every hit unchanged; the resolve arm walks each question's gold pair as an oracle" : " — the resolve arm walks them"}`);

  const vector = async (qv: string, q: ScoreQ, k: number, weight: number, halfLife: number) =>
    ((await sql`SELECT id FROM match_thoughts(${qv}::vector, -1.0, ${k}, ${filterFor(q)}::jsonb, ${weight}::float, ${halfLife}::float)`) as { id: string }[]).map((r) => r.id);
  const pairOf = new Map(pairs.map((p) => [p.q.question_id, p]));
  /**
   * Each hit walked forward to the head of its chain, kept at the hit's rank,
   * listed once — bounded like trace_provenance. The oracle's chain is THIS
   * question's pair alone: a hit that is another question's stale session
   * (sessions are shared across histories) is not walked to that question's
   * update (first review pass). A store chain stops at the edge of the
   * history, as a filtered read would.
   */
  const resolveThrough = (ids: string[], q: ScoreQ): string[] => {
    const p = pairOf.get(q.question_id)!;
    const hay = new Set(q.haystack_session_ids);
    const inHistory = (id: string) => (idToSids.get(id) ?? []).some((sid) => hay.has(sid));
    const next = (id: string): string | undefined => {
      // A twin row is walked only when the stale session is the only one it
      // stands for in this history; otherwise the reader saw another session
      // too, and replacing the row would hide it (second review pass).
      if (oracle) return id === map[p.stale] && (idToSids.get(id) ?? []).filter((sid) => hay.has(sid)).every((sid) => sid === p.stale) ? map[p.current] : undefined;
      const head = storeChain.get(id);
      return head !== undefined && inHistory(head) ? head : undefined;
    };
    const out: string[] = [];
    for (const id of ids) {
      let head = id;
      for (let i = 0; i < 1000; i++) { const n = next(head); if (n === undefined) break; head = n; }
      if (!out.includes(head)) out.push(head);
    }
    return out;
  };
  /** The shipped arm's ids per (question, k): the resolve arm walks these rather than fetching the same list again. */
  const shippedIds = new Map<string, string[]>();
  const arms: Arm[] = [
    {
      key: "vector@-1", label: "match_thoughts as shipped, similarity alone",
      run: async (qv, q, k) => { const ids = await vector(qv, q, k, 0, 90); shippedIds.set(`${q.question_id}|${k}`, ids); return ids; },
    },
    { key: "recency@0.3", label: "020's blend as a caller can send it today: recency_weight 0.3, half-life 90 days", run: (qv, q, k) => vector(qv, q, k, 0.3, 90) },
    { key: "recency@0.3/3650", label: "the blend at a half-life of 3,650 days, so a week of age is visible on a three-year-old corpus", run: (qv, q, k) => vector(qv, q, k, 0.3, 3650) },
    // Under the history filter match_thoughts takes its exact branch: every row
    // of the history is blended and the top k kept, so this arm is the k newest
    // sessions in the history with similarity ignored, and the recency arms
    // reorder the whole history, not a nearest-N window (third review pass).
    { key: "age@1", label: "the k newest sessions in the history, similarity ignored (recency_weight 1)", run: (qv, q, k) => vector(qv, q, k, 1, 90) },
    {
      key: "resolve",
      label: oracle
        ? "the shipped order, every hit walked to the head of its supersedes chain — each question's gold pair as the chain, an oracle (the store has no pointers)"
        : `the shipped order, every hit walked to the head of its supersedes chain — the store's ${pointers} pointers, the read as it would run`,
      run: async (qv, q, k) => resolveThrough(shippedIds.get(`${q.question_id}|${k}`) ?? (await vector(qv, q, k, 0, 90)), q),
    },
  ];

  type Out = { both: boolean; currentIn: boolean; currentFirst: boolean; staleOnly: boolean; currentAt1: boolean; rCur: number; rStale: number };
  const outcomes = new Map<string, Out>(); // `${arm}|${k}|${qid}`
  let outside = 0, queryMs = 0;
  const qvs = await embedMany(pairs.map((p) => p.q.question), true);
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const qv = toVector(qvs[i]);
    const hay = new Set(p.q.haystack_session_ids);
    for (const arm of arms) {
      for (const k of KS) {
        const tq = Date.now();
        const ids = await arm.run(qv, p.q, k);
        queryMs += Date.now() - tq;
        const found = sidsInHistory(ids, hay, idToSids, arm.key);
        outside += found.outside;
        const top = found.sids.slice(0, k);
        const rCur = top.indexOf(p.current), rStale = top.indexOf(p.stale); // −1 when absent
        outcomes.set(`${arm.key}|${k}|${p.q.question_id}`, {
          both: rCur >= 0 && rStale >= 0,
          currentIn: rCur >= 0,
          currentFirst: rCur >= 0 && (rStale < 0 || rCur < rStale),
          staleOnly: rStale >= 0 && rCur < 0,
          currentAt1: rCur === 0,
          rCur, rStale,
        });
      }
    }
  }
  if (outside) throw new Error(`CONTROL FAILED: ${outside} results came from outside the question's history; the filter did not isolate.`);
  console.log(`\n✓ control: every result was inside its question's history (${pairs.length} questions × ${arms.length} arms × ${KS.length} k)`);
  console.log(`  ${(queryMs / (pairs.length * arms.length * KS.length)).toFixed(1)} ms per search call, mean`);

  const pct = (n: number) => `${((100 * n) / pairs.length).toFixed(1)}%`;
  const count = (arm: string, k: number, f: (o: Out) => boolean) => pairs.filter((p) => f(outcomes.get(`${arm}|${k}|${p.q.question_id}`)!)).length;
  /** helped / hurt against the shipped order on one outcome, with McNemar's exact p. */
  const paired = (arm: string, k: number, f: (o: Out) => boolean) => {
    let helped = 0, hurt = 0;
    for (const p of pairs) {
      const base = f(outcomes.get(`${arms[0].key}|${k}|${p.q.question_id}`)!);
      const mine = f(outcomes.get(`${arm}|${k}|${p.q.question_id}`)!);
      if (mine && !base) helped++;
      if (base && !mine) hurt++;
    }
    return arm === arms[0].key ? "—" : `+${helped} / −${hurt}, p=${mcnemarExact(helped, hurt).toFixed(3)}`;
  };
  for (const k of KS) {
    console.log(`\n## the current-value question at k=${k}, ${pairs.length} knowledge-update questions`);
    console.log(`| arm | both (strict) | current-in | current-first | current@1 | stale-only | vs shipped, current-first | vs shipped, both |`);
    console.log(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
    for (const a of arms) {
      console.log(`| ${a.key} | ${pct(count(a.key, k, (o) => o.both))} | ${pct(count(a.key, k, (o) => o.currentIn))} | ${pct(count(a.key, k, (o) => o.currentFirst))} | ${pct(count(a.key, k, (o) => o.currentAt1))} | ${pct(count(a.key, k, (o) => o.staleOnly))} | ${paired(a.key, k, (o) => o.currentFirst)} | ${paired(a.key, k, (o) => o.both)} |`);
    }
  }
  console.log(`\narms: ${arms.map((a) => `${a.key} = ${a.label}`).join("; ")}`);
  console.log(`columns: both = every gold in the top k (strict recall_all); current-in = the current session in the top k; current-first = in the top k and above the stale one, or the stale one absent; current@1 = the top session is the current one; stale-only = the stale one in the top k, the current one not. Paired: questions the arm gets right and the shipped order does not / the reverse, McNemar exact two-sided.`);
  const staleFirst = pairs.filter((p) => !outcomes.get(`${arms[0].key}|5|${p.q.question_id}`)!.currentFirst);
  console.log(`\n${staleFirst.length} questions where the shipped order at k=5 does not put the current session first (rank of current / stale, 0-based, −1 absent; gap in days):`);
  for (const p of staleFirst) {
    const o = outcomes.get(`${arms[0].key}|5|${p.q.question_id}`)!;
    console.log(`  ${p.q.question_id}  cur ${o.rCur} / stale ${o.rStale}  gap ${p.gapDays.toFixed(0)}d  ${p.q.question.slice(0, 80)}`);
  }
}

async function score(): Promise<void> {
  const map = await readMapOrRebuild();
  const missing = [...sessions.keys()].filter((sid) => !map[sid]);
  if (missing.length) throw new Error(`${missing.length} sessions are not loaded; run the load phase first.`);
  const idToSids = new Map<string, string[]>();
  for (const [sid, id] of Object.entries(map)) idToSids.set(id, [...(idToSids.get(id) ?? []), sid]);
  // CONTROL: every gold session's row carries its question in lme_q, else the
  // filter can never return it and a harness fault would score as a retrieval
  // miss — the shape of the twin defect the second review pass found, which
  // the outside-the-history control cannot see (third review pass).
  const qidsOfRow = new Map<string, Set<string>>();
  for (const r of (await sql`SELECT id, metadata->'lme_q' AS q FROM thoughts WHERE metadata ? 'lme_sid'`) as { id: string; q: string[] | null }[]) qidsOfRow.set(r.id, new Set(r.q ?? []));
  const unreachable: string[] = [];
  for (const q of scorable(questions)) for (const sid of q.answer_session_ids) if (map[sid] && !qidsOfRow.get(map[sid])?.has(q.question_id)) unreachable.push(`${q.question_id}/${sid}`);
  if (unreachable.length) throw new Error(`CONTROL FAILED: ${unreachable.length} gold sessions' rows do not carry their question in lme_q, so the filter cannot return them (${unreachable.slice(0, 5).join(", ")}${unreachable.length > 5 ? ", …" : ""}); re-run the load phase, which unions lme_q for every session.`);
  if (ARMS === "current") { await scoreCurrent(map, idToSids); return; }

  const scored = scorable(questions);
  const use = MAXQ ? scored.slice(0, MAXQ) : scored;
  console.log(`▸ scoring ${use.length} questions (${questions.length - scored.length} abstention skipped) — ${EMBED_MODEL}`);

  const idsOf = (rows: { id: string }[]) => rows.map((r) => r.id);
  const shipped: Arm[] = [
    {
      key: "hybrid@0.5", label: "hybrid, threshold 0.5 (what search_thoughts sent before SMD-1300)",
      run: async (qv, q, k) => idsOf(await sql`SELECT id FROM search_thoughts_hybrid(${qv}::vector, ${q.question}, 0.5, ${k}, ${filterFor(q)}::jsonb)`),
    },
    {
      // SMD-1300 / migration 027: the tools now send a threshold of 0, and the
      // function admits relative to the top match. This is the SHIPPED arm once
      // 027 is applied; against a pre-027 database it is the plain no-floor call.
      key: "hybrid@0 (027)", label: "hybrid, threshold 0 — the relative cutoff governs (search_thoughts today)",
      run: async (qv, q, k) => idsOf(await sql`SELECT id FROM search_thoughts_hybrid(${qv}::vector, ${q.question}, 0.0, ${k}, ${filterFor(q)}::jsonb)`),
    },
    {
      key: "hybrid@-1", label: "hybrid, threshold -1 — no floor of any kind (027 treats a negative threshold as the raw ranked list)",
      run: async (qv, q, k) => idsOf(await sql`SELECT id FROM search_thoughts_hybrid(${qv}::vector, ${q.question}, -1.0, ${k}, ${filterFor(q)}::jsonb)`),
    },
    {
      key: "vector@-1", label: "vector only (match_thoughts: best of the whole vector and the windows)",
      run: async (qv, q, k) => idsOf(await sql`SELECT id FROM match_thoughts(${qv}::vector, -1.0, ${k}, ${filterFor(q)}::jsonb)`),
    },
  ];
  // The windows question (SMD-1305; the header explains the arms). One query
  // per question fetches every filtered thought with its whole-vector
  // similarity and its best window's, and each direct arm is a rule over those
  // two numbers, ranked here. The scan is exact by its shape: nothing in it is
  // ordered by distance or limited, so the planner has no index-ordered path
  // to take and no HNSW walk can return short under the filter. These arms
  // measure vectors, and must not measure plans.
  type Scored = { id: string; whole: number | null; win: number | null; est: number };
  const scoredCache = new Map<string, Scored[]>();
  const scoredFor = async (qv: string, q: ScoreQ): Promise<Scored[]> => {
    const hit = scoredCache.get(q.question_id);
    if (hit) return hit;
    const rows = (await sql.unsafe(
      `SELECT t.id, 1 - (t.embedding <=> $1::vector) AS whole,
              (SELECT max(1 - (c.embedding <=> $1::vector)) FROM ${CHUNKS} c WHERE c.thought_id = t.id) AS win
       FROM thoughts t WHERE t.metadata @> $2::jsonb`,
      // The object, as above: Bun stringifies a ::jsonb parameter itself.
      [qv, filterFor(q)])) as { id: string; whole: number | null; win: number | null }[];
    // The thought's estimated length, from the loader's own text. A twin's
    // sessions share it, and under OB1_EVAL_MAX_QUESTIONS only the kept
    // histories' sessions are in memory, so take whichever of the row's ids is
    // (first review pass: the first id could be a pruned one).
    const scored = rows.map((r) => {
      const own = idToSids.get(r.id);
      if (!own) throw new Error(`CONTROL FAILED: the history filter admitted ${r.id}, which the loader did not record.`);
      const sid = own.find((x) => sessions.has(x));
      if (!sid) throw new Error(`CONTROL FAILED: ${r.id} stands for no session in this run (${own.join(", ")}).`);
      return { ...r, est: estimateTokens(sessions.get(sid)!.text) };
    });
    scoredCache.set(q.question_id, scored);
    return scored;
  };
  const rank = (score: (s: Scored) => number | null) => async (qv: string, q: ScoreQ, k: number) =>
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
  const bucketOf = (q: ScoreQ): string => {
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
        const found = sidsInHistory(ids, hay, idToSids, arm.key);
        outside += found.outside;
        const top = new Set(found.sids.slice(0, k));
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
      [`${limit}-token windows above ${limit}${limit === DEFAULT_MAX_TOKENS ? " (the constant before SMD-1305)" : ""}`, limit, limit],
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

await ingest();
if (PHASE === "load" || PHASE === "both") await load();
if (PHASE === "windows") await loadWindows();
if (PHASE === "score" || PHASE === "both") await score();
await sql.end();
