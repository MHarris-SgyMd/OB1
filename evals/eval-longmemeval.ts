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
 *   OB1_EVAL_PHASE=load|score|both           default both; load is resumable
 *   OB1_EVAL_BATCH=32                        inputs per embedding request
 *   OB1_EVAL_MAX_QUESTIONS=20                score a prefix only (smoke test)
 *   OB1_EVAL_LME_MAP=/path/map.json          where the session→thought map is kept
 */
import { SQL } from "bun";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { loadEnv } from "./env.ts";
import { EVAL_BASE, EVAL_HEADERS, applyPrompt, parseSpec } from "./lib.ts";
import { chunkContent } from "../server-portable/chunk.ts";

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
  const arms: Arm[] = [
    {
      key: "hybrid@0.5", label: "hybrid, threshold 0.5 (what search_thoughts sent before SMD-1300)",
      run: async (qv, q, k) => (await sql`SELECT id FROM search_thoughts_hybrid(${qv}::vector, ${q.question}, 0.5, ${k}, ${filterFor(q)}::jsonb)`).map((r: { id: string }) => r.id),
    },
    {
      // SMD-1300 / migration 027: the tools now send a threshold of 0, and the
      // function admits relative to the top match. This is the SHIPPED arm once
      // 027 is applied; against a pre-027 database it is the plain no-floor call.
      key: "hybrid@0 (027)", label: "hybrid, threshold 0 — the relative cutoff governs (search_thoughts today)",
      run: async (qv, q, k) => (await sql`SELECT id FROM search_thoughts_hybrid(${qv}::vector, ${q.question}, 0.0, ${k}, ${filterFor(q)}::jsonb)`).map((r: { id: string }) => r.id),
    },
    {
      key: "hybrid@-1", label: "hybrid, threshold -1 (pre-027: no floor; post-027: relative cutoff only)",
      run: async (qv, q, k) => (await sql`SELECT id FROM search_thoughts_hybrid(${qv}::vector, ${q.question}, -1.0, ${k}, ${filterFor(q)}::jsonb)`).map((r: { id: string }) => r.id),
    },
    {
      key: "vector@-1", label: "vector only (match_thoughts)",
      run: async (qv, q, k) => (await sql`SELECT id FROM match_thoughts(${qv}::vector, -1.0, ${k}, ${filterFor(q)}::jsonb)`).map((r: { id: string }) => r.id),
    },
  ];
  const KS = [5, 10];

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
          shortByArm.set(arm.key, (shortByArm.get(arm.key) ?? 0) + 1);
          if (!strict) shortLostByArm.set(arm.key, (shortLostByArm.get(arm.key) ?? 0) + 1);
        }
        bump(`${arm.key}|${k}|${q.question_type}`, strict, any);
        bump(`${arm.key}|${k}|ALL`, strict, any);
        if (arm.key === "hybrid@0.5" && k === 5 && !strict) misses.push(`${q.question_type}  ${q.question_id}  ${q.question.slice(0, 80)}`);
      }
    }
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${use.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  if (outside) throw new Error(`CONTROL FAILED: ${outside} results came from outside the question's history; the filter did not isolate.`);
  console.log(`\n✓ control: every result was inside its question's history (${use.length} questions × ${arms.length} arms × ${KS.length} k)`);
  console.log(`  ${(queryMs / (use.length * arms.length * KS.length)).toFixed(1)} ms per search call, mean`);
  console.log(`  short calls (returned < rows asked) — short / of-those-missing-a-gold, per arm, both k:`);
  for (const a of arms) console.log(`    ${a.key}: ${shortByArm.get(a.key) ?? 0} / ${shortLostByArm.get(a.key) ?? 0}`);

  const types = ["single-session-user", "single-session-assistant", "single-session-preference", "multi-session", "temporal-reasoning", "knowledge-update", "ALL"];
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "—");
  for (const k of KS) {
    console.log(`\n## strict recall_all@${k} (any-hit@${k} in parentheses)\n`);
    console.log(`| question type | n | ${arms.map((a) => a.key).join(" | ")} |`);
    console.log(`| --- | --- | ${arms.map(() => "---").join(" | ")} |`);
    for (const t of types) {
      const n = table.get(`${arms[0].key}|${k}|${t}`)?.n ?? 0;
      if (!n) continue;
      const cells = arms.map((a) => { const c = table.get(`${a.key}|${k}|${t}`) ?? cell(); return `${pct(c.strict, c.n)} (${pct(c.any, c.n)})`; });
      console.log(`| ${t} | ${n} | ${cells.join(" | ")} |`);
    }
  }
  console.log(`\narms: ${arms.map((a) => `${a.key} = ${a.label}`).join("; ")}`);
  console.log(`\n${misses.length} misses on hybrid@0.5 at k=5 (first 25):`);
  for (const m of misses.slice(0, 25)) console.log(`  ${m}`);
}

if (PHASE === "load" || PHASE === "both") await load();
if (PHASE === "score" || PHASE === "both") await score();
await sql.end();
