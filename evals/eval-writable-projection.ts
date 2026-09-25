/**
 * eval-writable-projection.ts — SMD-1999, Spike 2 of the event-sourcing ADR
 * (SMD-1997): can `thoughts` stay writable to its existing callers while every
 * write lands as an event first and a projector writes the row?
 *
 * The run resets a throwaway Postgres to the shipped migrations (053 when this
 * was measured; 055 since SMD-2115 shipped the diff rule, the append and the
 * stamp arms, which the prototype SQL now calls rather than defines) and measures the same
 * scripted writes — the vendored capture as readwise sends it, the 2- and
 * 4-argument forms, the server's and the integrations' update_thought calls,
 * delete_thought plain and refused, a raw INSERT, ingest-records' statement —
 * against four schemas: the shipped schema as it stands; option 2 (the table stays, the
 * three write functions append the event and call one projector, the audit
 * trigger checks a projected write and appends a raw one); option 1 with 053's
 * functions unchanged (the table renamed, a view named `thoughts` with
 * INSTEAD OF triggers); option 1 with option 2's bodies. Then the community
 * DDL verbatim from schemas/, the three concurrency behaviours (SMD-1043 /
 * 1323 / 1462), the trigger counts, read-your-writes with the drop-the-
 * projector control, and the replay of the whole log through the projector.
 * The criteria, the bar and the expected outcome were posted on the ticket
 * before this ran; evals/writable-projection.ts holds the rules pure.
 *
 *   bun eval-writable-projection.ts --self-check     # the rules, no database
 *   ../db/with-postgres.sh bun eval-writable-projection.ts --prototype [--json]
 *   ../db/with-postgres.sh bun eval-writable-projection.ts --check      # the run, held to the recorded matrix (CI, data-layer)
 *
 * --prototype and --check DROP the schema at DATABASE_URL (test-support's
 * reset) and refuse a database holding thoughts unless OB1_FIXTURE_RESET=1.
 * The prototype SQL lives in evals/writable-projection/ — where check 7 does
 * not look, deliberately: the functions are redefined for the measurement,
 * not shipped. No provider: vectors are literals at width 8.
 */
import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { destructiveSqlIn } from "../db/config.mjs";
import { createAssert, resetSchema, substitute } from "../db/test-support.ts";
import { median } from "./lib.ts";
import {
  CRITERIA, CRITERION_IDS, EXPECTED, EXPECTED_PROBES, OPTIONS, comparableEvent, comparableRow, compareImages, compareRows, costLine, driftFrom, fmtUs, judge, recommend, renderReport, verdict,
  type Count, type CriterionId, type EventImage, type Mismatch, type Observation, type OptionId, type Outcome, type Probe, type ReplayDiff, type ReplayRow, type Report, type RowImage, type Timing, type Verdict,
} from "./writable-projection.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(HERE, "writable-projection");
const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);

// The run's constants — this CLI's own, imported by nothing (boyscout: exports with no consumer un-exported).
const DIM = 8;
const MODEL = "proto-model";
const OTHER_MODEL = "other-model";
const KEY = "extract:proto@p1";
const ACTOR = { name: "op-key", via: "mcp" };
const TIMING_N = 200;

export function argumentProblem(argv: readonly string[]): string | null {
  const known = new Set(["--self-check", "--prototype", "--check", "--json"]);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length) return `unknown argument(s): ${unknown.join(" ")}. Modes: --self-check | --prototype [--json] | --check`;
  const modes = ["--self-check", "--prototype", "--check"].filter((m) => argv.includes(m));
  if (modes.length === 0) return "one mode is required: --self-check | --prototype [--json] | --check";
  if (modes.length > 1) return `one mode at a time, got ${modes.join(" and ")}`;
  if (argv.includes("--json") && modes[0] !== "--prototype") return "--json goes with --prototype";
  return null;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();
const vec = (seed: number): string => `[${Array.from({ length: DIM }, (_, i) => (((seed * 7 + i) % 13) / 13 + 0.01).toFixed(3)).join(",")}]`;
const json = (v: unknown): string => JSON.stringify(v);

class Rollback extends Error {}

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The prototype SQL, applied.
// ---------------------------------------------------------------------------

function protoSql(file: string, rows: "thoughts" | "thought_rows"): string {
  // The rows relation is this runner's placeholder; test-support's substitute refuses one it does not know, so it goes first.
  const text = readFileSync(join(SQL_DIR, file), "utf8").replaceAll("{{ROWS}}", rows);
  return substitute(text, { dim: DIM, model: MODEL });
}

async function apply(sql: SQL, file: string, rows: "thoughts" | "thought_rows"): Promise<void> {
  await sql.unsafe(protoSql(file, rows));
}

/**
 * What test-support's reset does not know: a view named thoughts left by an
 * interrupted option-1 run would fail its DROP TABLE, and the prototype's
 * snapshot table (CREATE TABLE IF NOT EXISTS) would keep an earlier width.
 * Both are the prototype's own and go here, before the reset.
 */
async function undoPrototype(sql: SQL): Promise<void> {
  const r = (await sql`SELECT c.relkind::text AS k FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'thoughts'`) as { k: string }[];
  if (r[0]?.k === "v") await apply(sql, "option1-undo.sql", "thoughts");
  await sql`DROP TABLE IF EXISTS ob1_embedding_snapshot`;
}

async function seed(sql: SQL): Promise<void> {
  await sql`SELECT set_agent_kind('op-key', 'operator')`;
  await sql`INSERT INTO ob1_config (key, value) VALUES ('entity_extraction_key', ${KEY}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
}

// ---------------------------------------------------------------------------
// The scripted writes: the same statements against every schema.
// ---------------------------------------------------------------------------

type Step = { step: string; ok: boolean; value?: unknown; error?: string; auditDelta: number };
/** A row as read mid-script, before a later step deletes it (first review pass: C3 had read only returns and the log). */
type Image = (RowImage & { chunks: number }) | null;
type Trace = { steps: Step[]; ids: Record<string, string>; noopBumped: boolean | null; images: Record<string, Image>; planted: string[] };

const TEXTS = {
  A: "The first thought of the spike, captured by readwise.",
  A2: "The first thought of the spike, captured by readwise — edited.",
  B: "A second thought, through the two-argument form.",
  C: "A third thought, long enough to carry two windows through the four-argument form.",
  D: "A raw row written around the functions.",
  E1: "A record the stable-tier ingester wrote.",
  E2: "A record the stable-tier ingester wrote, then rewrote.",
  F: "A thought captured with an actor and kept to the census, so its row's stamp is compared.",
  F2: "A thought captured with an actor and kept to the census — its text moved by a raw UPDATE that left the key stale.",
  G: "A raw row written after a function call in the same transaction, under a hand-set event.",
  G2: "A raw row written after an update_thought that changed nothing, under a hand-set event.",
  G3: "A raw row written after an identical re-capture, under a hand-set event.",
  H: "A thought whose payload says metadata is null.",
  I: "A thought captured with 046's event envelope: a stance, a citation, a valid window, a declared trust.",
};
/** A backdated record, as db/ingest-records.ts writes one (the record's own time, not the write's). */
const E_CREATED = "2024-01-02T03:04:05Z";
/** The ingester's record id, fixed: its statement lands on `ON CONFLICT (id)`, so the first write and the rewrite must name the same one. */
const E_ID = "00000000-0000-4000-8000-00000000e001";

async function runScript(sql: SQL): Promise<Trace> {
  const steps: Step[] = [];
  const ids: Record<string, string> = {};
  const audit = async () => Number(((await sql`SELECT count(*)::int AS n FROM thought_audit`)[0] as { n: number }).n);
  const step = async (name: string, fn: () => Promise<unknown>): Promise<unknown> => {
    const before = await audit();
    try {
      const value = await fn();
      steps.push({ step: name, ok: true, value, auditDelta: (await audit()) - before });
      return value;
    } catch (e) {
      steps.push({ step: name, ok: false, error: msg(e), auditDelta: (await audit()) - before });
      return undefined;
    }
  };
  // A failed step returns undefined; a function's result rides `r`, a RETURNING row is the row itself.
  const r = (rows: unknown): Row | undefined => (Array.isArray(rows) ? ((rows[0] as Row | undefined)?.r as Row | undefined) ?? (rows[0] as Row | undefined) : undefined);
  const images: Record<string, Image> = {};
  const snap = async (label: string, id: string): Promise<void> => {
    if (!id) { images[label] = null; return; }
    const rows = (await sql`
      SELECT content, content_fingerprint, jsonb_typeof(metadata) AS metadata_type, metadata, supersedes::text AS supersedes, derived_from,
             embedding IS NOT NULL AS has_vector, embedding_model,
             (SELECT count(*)::int FROM thought_chunks ch WHERE ch.thought_id = t.id) AS chunks
        FROM thoughts t WHERE t.id = ${id}::uuid`) as (RowImage & { chunks: number })[];
    images[label] = rows[0] ?? null;
  };
  const readwise = (topic: string, extra: Row = {}): Row => ({ metadata: { source: "readwise", readwise_highlight_id: 1, topic }, embedding_model: MODEL, actor: ACTOR, ...extra });

  // When a capture step fails (053's ON CONFLICT against option 1's view), the
  // row is planted raw so the edits and deletes after it are still measured;
  // the failed step stands in C1/C2 and the plant is said in the trace.
  const planted: string[] = [];
  const plant = async (label: string, text: string, withVector: boolean, chunkRows = 0): Promise<string> => {
    const before = await audit();
    const rows = withVector
      ? await sql`INSERT INTO thoughts (content, metadata, embedding, embedding_model) VALUES (${text}, ${{ source: "planted" }}::jsonb, ${vec(1)}::vector, ${MODEL}) RETURNING id::text AS id`
      : await sql`INSERT INTO thoughts (content, metadata) VALUES (${text}, ${{ source: "planted" }}::jsonb) RETURNING id::text AS id`;
    const id = String((rows as Row[])[0]?.id ?? "");
    // What the failed capture would have left beside the row (the 4-argument form's windows), so the edits after it meet the same state.
    for (let i = 0; i < chunkRows && id; i++) await sql`INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding) VALUES (${id}::uuid, ${i}, ${`window ${i + 1}`}, ${vec(31 + i)}::vector)`;
    // Measured, not assumed (third review pass): a raw insert is audited too, through the view under option 1.
    steps.push({ step: `${label} planted raw after its capture failed${chunkRows ? ` (${chunkRows} chunk rows)` : ""}`, ok: true, auditDelta: (await audit()) - before });
    planted.push(label);
    return id;
  };

  const s1 = r(await step("s1 capture A (3-arg, readwise payload, actor)", () => sql`SELECT upsert_thought(${TEXTS.A}, ${readwise("a")}::jsonb, ${vec(1)}::vector) AS r`));
  ids.A = String(s1?.id ?? "") || await plant("A", TEXTS.A, true);
  await snap("A after s1", ids.A);
  await step("s2 re-capture A, metadata changed, no vector", () => sql`SELECT upsert_thought(${TEXTS.A}, ${{ metadata: { topic: "b" }, actor: ACTOR }}::jsonb, NULL::vector) AS r`);
  // As text: a Date's string form is second-grained, and the two writes are milliseconds apart.
  const noopBefore = ids.A ? ((await sql`SELECT updated_at::text AS u FROM thoughts WHERE id = ${ids.A}::uuid`)[0] as Row | undefined)?.u : undefined;
  await step("s3 re-capture A identical", () => sql`SELECT upsert_thought(${TEXTS.A}, ${{ metadata: { topic: "b" }, actor: ACTOR }}::jsonb, NULL::vector) AS r`);
  const noopAfter = ids.A ? ((await sql`SELECT updated_at::text AS u FROM thoughts WHERE id = ${ids.A}::uuid`)[0] as Row | undefined)?.u : undefined;
  const noopBumped = noopBefore === undefined || noopAfter === undefined ? null : String(noopBefore) !== String(noopAfter);

  const s4 = r(await step("s4 capture B (2-arg)", () => sql`SELECT upsert_thought(${TEXTS.B}, ${{ metadata: { source: "recipe" } }}::jsonb) AS r`));
  ids.B = String(s4?.id ?? "") || await plant("B", TEXTS.B, false);
  const chunks = [{ content: "window one", embedding: vec(31), context: null }, { content: "window two", embedding: vec(32), context: "the third thought" }];
  const s5 = r(await step("s5 capture C (4-arg, two chunks)", () => sql`SELECT upsert_thought(${TEXTS.C}, ${readwise("c", { metadata: { source: "mcp" } })}::jsonb, ${vec(3)}::vector, ${chunks}::jsonb) AS r`));
  ids.C = String(s5?.id ?? "") || await plant("C", TEXTS.C, true, 2);

  await step("s6 update A content (9-arg, the server's call)", () =>
    sql`SELECT update_thought(${ids.A}::uuid, ${TEXTS.A2}::text, ${{ edited: true }}::jsonb, NULL::vector, NULL::jsonb, NULL::timestamptz, ${ACTOR}::jsonb, NULL::text, NULL::jsonb) AS r`);
  await snap("A after s6", ids.A);
  await step("s7 update B metadata only (6-arg, the integrations' call)", () =>
    sql`SELECT update_thought(${ids.B}::uuid, NULL::text, ${{ k: 1 }}::jsonb, NULL::vector, NULL::jsonb, NULL::timestamptz) AS r`);
  await step("s8 update B provenance: supersedes A", () =>
    sql`SELECT update_thought(${ids.B}::uuid, NULL::text, NULL::jsonb, NULL::vector, NULL::jsonb, NULL::timestamptz, ${ACTOR}::jsonb, NULL::text, ${{ supersedes: ids.A }}::jsonb) AS r`);
  await step("s9 update C to B's text (DUPLICATE_CONTENT)", () =>
    sql`SELECT update_thought(${ids.C}::uuid, ${TEXTS.B}::text, NULL::jsonb, ${vec(9)}::vector, NULL::jsonb, NULL::timestamptz, ${ACTOR}::jsonb, ${MODEL}::text, NULL::jsonb) AS r`);
  await snap("C after s9", ids.C);
  await step("s10 update A with a stale if_unchanged_since (STALE_READ)", () =>
    sql`SELECT update_thought(${ids.A}::uuid, NULL::text, ${{ late: true }}::jsonb, NULL::vector, NULL::jsonb, ${"2000-01-01T00:00:00Z"}::timestamptz, ${ACTOR}::jsonb, NULL::text, NULL::jsonb) AS r`);
  await step("s11 re-embed C: same text, new vector and label", () =>
    sql`SELECT update_thought(${ids.C}::uuid, ${TEXTS.C}::text, NULL::jsonb, ${vec(4)}::vector, NULL::jsonb, NULL::timestamptz, ${ACTOR}::jsonb, ${OTHER_MODEL}::text, NULL::jsonb) AS r`);
  await snap("C after s11", ids.C);
  await step("s12a B cites A", () => sql`SELECT record_citation(${ids.B}::uuid, ${ids.A}::uuid, ${"the first thought"}::text, ${"stated"}::text) AS r`);
  await step("s12b delete A while cited (CITED)", () => sql`SELECT delete_thought(${ids.A}::uuid, ${ACTOR}::jsonb, false) AS r`);
  await step("s12c delete A detaching the citation", () => sql`SELECT delete_thought(${ids.A}::uuid, ${ACTOR}::jsonb, true) AS r`);
  await step("s13 delete C", () => sql`SELECT delete_thought(${ids.C}::uuid, ${ACTOR}::jsonb, false) AS r`);
  const s14 = r(await step("s14 raw INSERT INTO thoughts (content, metadata)", () => sql`INSERT INTO thoughts (content, metadata) VALUES (${TEXTS.D}, ${{ source: "raw" }}::jsonb) RETURNING id`));
  ids.D = String(s14?.id ?? "");
  const ingest = (text: string) => sql`
    WITH old AS (SELECT content_fingerprint AS fp FROM thoughts WHERE id = ${E_ID}::uuid)
    INSERT INTO thoughts (id, content, metadata, content_fingerprint, created_at, derived_from)
    VALUES (${E_ID}::uuid, ${text}, ${{ source: "linear" }}::jsonb, content_fingerprint_of(${text}), COALESCE(${E_CREATED}::timestamptz, now()), NULL::jsonb)
    ON CONFLICT (id) DO UPDATE
      SET content = CASE WHEN thoughts.content_fingerprint IS DISTINCT FROM EXCLUDED.content_fingerprint THEN EXCLUDED.content ELSE thoughts.content END,
          content_fingerprint = CASE WHEN thoughts.content_fingerprint IS DISTINCT FROM EXCLUDED.content_fingerprint THEN EXCLUDED.content_fingerprint ELSE thoughts.content_fingerprint END,
          metadata = COALESCE(thoughts.metadata, '{}'::jsonb) || (EXCLUDED.metadata - 'actor_kind' - 'actor_name')
    RETURNING (xmax = 0) AS inserted, ((SELECT fp FROM old) IS DISTINCT FROM thoughts.content_fingerprint) AS moved`;
  await step("s15a ingest-records' statement, first write", () => ingest(TEXTS.E1));
  await step("s15b ingest-records' statement, rewrite", () => ingest(TEXTS.E2));
  ids.E = E_ID;
  // Kept to the census: a row captured with an actor, so the differential compares its stamp (first review pass).
  const s16 = r(await step("s16 capture F (3-arg, actor; kept for the census)", () => sql`SELECT upsert_thought(${TEXTS.F}, ${readwise("f", { metadata: { source: "kept" } })}::jsonb, ${vec(6)}::vector) AS r`));
  ids.F = String(s16?.id ?? "");
  await snap("F after s16", ids.F);
  // 046's anti-inheritance rule: a hand-set event, a function call, then a raw write in one transaction — the raw event must not carry the stance.
  const s17 = await step("s17 a hand-set ob1.event, update_thought, then a raw INSERT in one transaction", () => sql.begin(async (tx) => {
    await tx`SELECT set_config('ob1.event', ${JSON.stringify({ stance: "stated" })}, true)`;
    await tx`SELECT update_thought(${ids.B}::uuid, NULL::text, ${{ touched: true }}::jsonb, NULL::vector, NULL::jsonb, NULL::timestamptz, ${ACTOR}::jsonb, NULL::text, NULL::jsonb) AS r`;
    return tx`INSERT INTO thoughts (content, metadata) VALUES (${TEXTS.G}, ${{ source: "raw" }}::jsonb) RETURNING id`;
  }));
  ids.G = String(r(s17)?.id ?? "");
  // A payload whose metadata is JSON null (first review pass): 046 stores jsonb null on the row, not SQL NULL.
  const s18 = r(await step("s18 capture H (2-arg, \"metadata\": null in the payload)", () => sql`SELECT upsert_thought(${TEXTS.H}, ${{ metadata: null }}::jsonb) AS r`));
  ids.H = String(s18?.id ?? "");
  // The per-body clears (second review pass: s17's function call projected, so the projector's clear covered it): a
  // function call that writes NOTHING — an edit whose patch changes nothing, an identical re-capture — then a raw insert.
  const s17b = await step("s17b a hand-set ob1.event, an update_thought that changes nothing, then a raw INSERT", () => sql.begin(async (tx) => {
    await tx`SELECT set_config('ob1.event', ${JSON.stringify({ stance: "stated" })}, true)`;
    await tx`SELECT update_thought(${ids.B}::uuid, NULL::text, ${{}}::jsonb, NULL::vector, NULL::jsonb, NULL::timestamptz, ${ACTOR}::jsonb, NULL::text, NULL::jsonb) AS r`;
    return tx`INSERT INTO thoughts (content, metadata) VALUES (${TEXTS.G2}, ${{ source: "raw" }}::jsonb) RETURNING id`;
  }));
  ids.G2 = String(r(s17b)?.id ?? "");
  const s17c = await step("s17c a hand-set ob1.event, an identical 2-arg re-capture, then a raw INSERT", () => sql.begin(async (tx) => {
    await tx`SELECT set_config('ob1.event', ${JSON.stringify({ stance: "stated" })}, true)`;
    // B's metadata already holds source: recipe, so the merge changes nothing and no event is written.
    await tx`SELECT upsert_thought(${TEXTS.B}, ${{ metadata: { source: "recipe" } }}::jsonb) AS r`;
    return tx`INSERT INTO thoughts (content, metadata) VALUES (${TEXTS.G3}, ${{ source: "raw" }}::jsonb) RETURNING id`;
  }));
  ids.G3 = String(r(s17c)?.id ?? "");
  // 046's envelope through the new bodies (second review pass: no step had sent one): a capture declaring a stance, a
  // citation, a valid window and a trust under the key's ceiling; an edit declaring an actor_kind the key does not support.
  const s19 = r(await step("s19 capture I (3-arg, actor, event: stance, cites, valid window, trust)", () => sql`SELECT upsert_thought(${TEXTS.I}, ${readwise("i", { metadata: { source: "cited" }, event: { stance: "retrieved", cites: [ids.B], valid_from: "2026-01-01T00:00:00Z", valid_until: "2026-06-01T00:00:00Z", trust: "agent" } })}::jsonb, ${vec(19)}::vector) AS r`));
  ids.I = String(s19?.id ?? "");
  await step("s20 update I (10-arg) with an event claiming an actor_kind the key does not support", () =>
    sql`SELECT update_thought(${ids.I}::uuid, NULL::text, ${{ note: 1 }}::jsonb, NULL::vector, NULL::jsonb, NULL::timestamptz, ${ACTOR}::jsonb, NULL::text, NULL::jsonb, ${{ stance: "inferred", trust: "agent", actor_kind: "ingested" }}::jsonb) AS r`);
  // 018's stale-key case (second review pass): a raw content UPDATE around the functions leaves the key and the vector as they were.
  await step("s21 raw UPDATE thoughts SET content on F (the key left stale)", () => sql`UPDATE thoughts SET content = ${TEXTS.F2} WHERE id = ${ids.F}::uuid RETURNING id`);
  await snap("F after s21", ids.F);
  return { steps, ids, noopBumped, images, planted };
}

// ---------------------------------------------------------------------------
// What the schema holds after the script.
// ---------------------------------------------------------------------------

type Census = { rows: RowImage[]; events: EventImage[]; claims: { thought_id: string; n: number }[]; chunks: Record<string, number> };

async function census(sql: SQL): Promise<Census> {
  const rows = (await sql`SELECT content, content_fingerprint, jsonb_typeof(metadata) AS metadata_type, metadata, supersedes::text AS supersedes, derived_from, embedding IS NOT NULL AS has_vector, embedding_model FROM thoughts ORDER BY content`) as RowImage[];
  const events = await readEvents(sql);
  const claims = (await sql`SELECT thought_id::text AS thought_id, count(*)::int AS n FROM thought_work_claims WHERE work_type = ${KEY} GROUP BY thought_id`) as { thought_id: string; n: number }[];
  const chunkRows = (await sql`SELECT thought_id::text AS thought_id, count(*)::int AS n FROM thought_chunks GROUP BY thought_id`) as { thought_id: string; n: number }[];
  return { rows, events, claims, chunks: Object.fromEntries(chunkRows.map((c) => [c.thought_id, Number(c.n)])) };
}

/** ids are random per run: the differential reads them as their step's letter. */
function relabel<T>(value: T, ids: Record<string, string>): T {
  let text = JSON.stringify(value);
  for (const [label, id] of Object.entries(ids)) if (id) text = text.replaceAll(id, `<${label}>`);
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// The probes per criterion, from the trace and the census.
// ---------------------------------------------------------------------------

type Ctx = { sql: SQL; option: OptionId; trace: Trace; census: Census; rows: "thoughts" | "thought_rows"; notes: string[] };

// The step's token, whole: "s1" is not a prefix of "s15a" (first review pass).
const stepOf = (t: Trace, token: string) => t.steps.find((s) => s.step.split(" ")[0] === token);
const val = (s: Step | undefined) => (s?.value as Row[] | undefined)?.[0]?.r as Row | undefined;

/**
 * The audit rows as the differential and the probes read them — one column
 * list (boyscout: the census and both arms of the per-thought read had spelled
 * it three times). `id` narrows to one thought and `action` to one kind;
 * neither given means every row, in log order.
 */
async function readEvents(sql: SQL, id?: string, action?: string): Promise<EventImage[]> {
  return (await sql`
    SELECT action, source, actor_name, actor_kind, trust, origin, stance,
           cites::text[] AS cites, valid_from::text AS valid_from, valid_until::text AS valid_until, actor_context, diff
      FROM thought_audit
     WHERE (${id ?? null}::uuid IS NULL OR thought_id = ${id ?? null}::uuid)
       AND (${action ?? null}::text IS NULL OR action = ${action ?? null}::text)
     ORDER BY created_at, seq`) as EventImage[];
}
/** A thought's events; an empty id (a capture that failed and was not planted) has none. */
const eventsOf = (sql: SQL, id: string, action?: string): Promise<EventImage[]> => (id ? readEvents(sql, id, action) : Promise.resolve([]));

const okStep = (t: Trace, prefix: string, name?: string): Probe => {
  const s = stepOf(t, prefix);
  return { name: name ?? s?.step ?? prefix, ok: !!s?.ok, error: s?.error };
};
const returned = (t: Trace, prefix: string, key: string, expected: unknown): Probe => {
  const s = stepOf(t, prefix);
  const v = val(s);
  const got = v?.[key];
  return { name: `${s?.step ?? prefix} returns ${key} = ${json(expected)}`, ok: !!s?.ok && json(got ?? null) === json(expected), error: s?.ok ? (v ? `got ${json(got ?? null)}` : "no result object") : s?.error };
};
const returnedError = (t: Trace, prefix: string, code: string): Probe => {
  const s = stepOf(t, prefix);
  const v = val(s);
  return { name: `${s?.step ?? prefix} returns error ${code}`, ok: !!s?.ok && v?.ok === false && v?.error === code, error: s?.ok ? `got ${json(v ?? null)}` : s?.error };
};
const delta = (t: Trace, prefix: string, expected: number): Probe => {
  const s = stepOf(t, prefix);
  return { name: `${s?.step ?? prefix} writes ${expected} audit row(s)`, ok: s?.auditDelta === expected, error: `wrote ${s?.auditDelta}` };
};

async function probeC1(c: Ctx): Promise<Probe[]> {
  const { trace: t, sql } = c;
  const s1 = stepOf(t, "s1");
  const v = val(s1);
  const out: Probe[] = [okStep(t, "s1")];
  out.push({ name: "s1 returns {id, fingerprint, existed: false, supersedes: null}", ok: !!v && typeof v.id === "string" && typeof v.fingerprint === "string" && v.existed === false && v.supersedes === null, error: v ? `got ${json(v)}` : s1?.error });
  // A is deleted at s12c; the row as it stood right after s1 is the trace's image.
  const a1 = t.images["A after s1"];
  // A probe reading a planted row says so in its name (third review pass): the row is the eval's, not the capture's.
  const on = (label: string) => (t.planted.includes(label) ? ` (on the planted row — the capture failed)` : "");
  out.push({ name: `A is a row right after s1, with the content, 003's key, the vector and its label${on("A")}`, ok: !!a1 && a1.content === TEXTS.A && typeof a1.content_fingerprint === "string" && a1.has_vector === true && a1.embedding_model === MODEL, error: json(a1) });
  const captures = await eventsOf(sql, t.ids.A, "capture");
  out.push({ name: `exactly one capture event for A${on("A")}`, ok: captures.length === 1, error: `${captures.length} capture event(s)` });
  out.push({ name: `the capture event carries the content${on("A")}`, ok: captures.length === 1 && typeof captures[0].diff?.content === "string" && captures[0].diff?.content === TEXTS.A, error: captures[0] ? `diff keys ${Object.keys(captures[0].diff ?? {}).join(",")}` : "no capture event" });
  out.push({ name: "the capture event names the actor from the key (op-key, operator, via mcp)", ok: captures[0]?.actor_name === "op-key" && captures[0]?.actor_kind === "operator" && captures[0]?.origin === "mcp", error: captures[0] ? json([captures[0].actor_name, captures[0].actor_kind, captures[0].origin]) : "no capture event" });
  return out;
}

async function probeC2(c: Ctx): Promise<Probe[]> {
  const { trace: t, census: cs } = c;
  const out: Probe[] = [okStep(t, "s4"), returned(t, "s5", "existed", false)];
  const s4 = val(stepOf(t, "s4"));
  out.push({ name: "s4 returns {id, fingerprint}", ok: typeof s4?.id === "string" && typeof s4?.fingerprint === "string", error: json(s4 ?? null) });
  const rowB = cs.rows.find((r) => r.content === TEXTS.B);
  out.push({ name: `B is a row with 003's key${t.planted.includes("B") ? " (on the planted row — the capture failed)" : ""}`, ok: !!rowB && typeof rowB.content_fingerprint === "string", error: rowB ? "no fingerprint" : "no row" });
  const s5 = val(stepOf(t, "s5"));
  out.push({ name: "s5 returns chunks: 2", ok: Number(s5?.chunks) === 2, error: json(s5 ?? null) });
  return out;
}

async function probeC3(c: Ctx): Promise<Probe[]> {
  const { trace: t, sql } = c;
  const out: Probe[] = [returned(t, "s6", "ok", true), returned(t, "s7", "ok", true), returned(t, "s8", "ok", true), returnedError(t, "s9", "DUPLICATE_CONTENT"), returnedError(t, "s10", "STALE_READ"), returned(t, "s11", "ok", true)];
  const updatesA = await eventsOf(sql, t.ids.A, "update");
  const edit = updatesA.find((e) => (e.diff?.content as Row | undefined)?.after === TEXTS.A2);
  out.push({ name: "s6 leaves an update event with content before/after", ok: !!edit && (edit.diff?.content as Row).before === TEXTS.A, error: `${updatesA.length} update event(s) for A` });
  const updatesB = await eventsOf(sql, t.ids.B, "update");
  out.push({ name: "s7 leaves an update event with metadata before/after", ok: updatesB.some((e) => (e.diff?.metadata as Row | undefined)?.after !== undefined), error: `${updatesB.length} update event(s) for B` });
  out.push({ name: "s8 leaves an update event with supersedes → A", ok: updatesB.some((e) => (e.diff?.supersedes as Row | undefined)?.after === t.ids.A), error: json(updatesB.map((e) => e.diff)) });
  // The rows as they stood after each edit, before s12c/s13 delete them (first review pass).
  const a6 = t.images["A after s6"];
  out.push({ name: "s6 landed on A's row: the edited content, 003's key on it, no vector (none was passed) and no label", ok: !!a6 && a6.content === TEXTS.A2 && typeof a6.content_fingerprint === "string" && a6.has_vector === false && a6.embedding_model === null && a6.metadata?.edited === true, error: json(a6) });
  const c9 = t.images["C after s9"];
  out.push({ name: "s9 (DUPLICATE_CONTENT) left C's row as it was: its text, its key, its vector and two chunks", ok: !!c9 && c9.content === TEXTS.C && typeof c9.content_fingerprint === "string" && c9.has_vector === true && c9.chunks === 2, error: json(c9) });
  const c11 = t.images["C after s11"];
  out.push({ name: "s11 landed on C's row: the vector present under the new label, the same key, and 022 dropped its two chunks (another model vouches for nothing)", ok: !!c11 && c11.has_vector === true && c11.embedding_model === OTHER_MODEL && c11.content_fingerprint === c9?.content_fingerprint && c11.chunks === 0, error: json(c11) });
  return out;
}

async function probeC4(c: Ctx): Promise<Probe[]> {
  const { trace: t, sql } = c;
  const out: Probe[] = [returnedError(t, "s12b", "CITED"), returned(t, "s12c", "ok", true), returned(t, "s13", "ok", true)];
  const delA = await eventsOf(sql, t.ids.A, "delete");
  out.push({ name: "the refused delete left no event and the detaching one left exactly one", ok: delA.length === 1, error: `${delA.length} delete event(s) for A` });
  out.push({ name: "the delete event carries the previous content", ok: delA[0]?.diff?.previous_content === TEXTS.A2, error: json(delA[0]?.diff ?? null) });
  out.push(delta(t, "s12b", 0));
  const delC = await eventsOf(sql, t.ids.C, "delete");
  out.push({ name: "C's delete event carries its previous content", ok: delC[0]?.diff?.previous_content === TEXTS.C, error: json(delC[0]?.diff ?? null) });
  return out;
}

async function probeC5(c: Ctx): Promise<Probe[]> {
  const { trace: t, sql } = c;
  const out: Probe[] = [okStep(t, "s14")];
  const capD = await eventsOf(sql, t.ids.D, "capture");
  out.push({ name: "the raw insert is audited once", ok: capD.length === 1, error: `${capD.length} capture event(s)` });
  const rowD = c.census.rows.find((r) => r.content === TEXTS.D);
  out.push({ name: "the raw row is present", ok: !!rowD, error: "no row" });
  if (rowD) c.notes.push(`${c.option}: the raw insert's key is ${rowD.content_fingerprint === null ? "NULL (003's rule lives in the functions)" : "filled (the view's trigger applied 003's rule)"}`);
  const s15a = stepOf(t, "s15a"); const s15b = stepOf(t, "s15b");
  const a = (s15a?.value as Row[] | undefined)?.[0]; const b = (s15b?.value as Row[] | undefined)?.[0];
  out.push({ name: "ingest-records' first write: inserted = true", ok: !!s15a?.ok && a?.inserted === true, error: s15a?.ok ? json(a ?? null) : s15a?.error });
  out.push({ name: "ingest-records' rewrite: inserted = false, moved = true", ok: !!s15b?.ok && b?.inserted === false && b?.moved === true, error: s15b?.ok ? json(b ?? null) : s15b?.error });
  // 018's stale-key case (second review pass): the raw content UPDATE moved the text and left the vector and its label.
  const f16 = t.images["F after s16"]; const f21 = t.images["F after s21"];
  out.push({ name: "s21's raw content UPDATE on F: the new text, the vector and its label kept", ok: !!f21 && f21.content === TEXTS.F2 && f21.has_vector === true && f21.embedding_model === MODEL, error: json(f21) });
  if (f16 && f21) c.notes.push(`${c.option}: after the raw content UPDATE F's key ${f21.content_fingerprint === f16.content_fingerprint ? "stayed stale (018's case: 003's rule lives in the functions)" : "was refreshed by the writer's door"}`);
  return out;
}

async function ddl(sql: SQL, name: string, statements: string[]): Promise<Probe> {
  try {
    await sql.begin(async (tx) => {
      for (const s of statements) await tx.unsafe(s);
      throw new Rollback("probe done");
    });
  } catch (e) {
    if (!(e instanceof Rollback) && !msg(e).includes("probe done")) return { name, ok: false, error: msg(e) };
  }
  return { name, ok: true };
}

async function probeC6(c: Ctx): Promise<Probe[]> {
  const { sql, trace: t } = c;
  return [
    await ddl(sql, "schemas/workflow-status: ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS status …, and the sidecar UPDATE thoughts SET status", [
      "ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT NULL",
      "ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ DEFAULT now()",
      `UPDATE thoughts SET status = 'new', status_updated_at = now() WHERE id = '${t.ids.B}'::uuid`,
    ]),
    await ddl(sql, "schemas/workflow-status: CREATE INDEX IF NOT EXISTS idx_thoughts_status ON thoughts (status) WHERE status IS NOT NULL", [
      "ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT NULL",
      "CREATE INDEX IF NOT EXISTS idx_thoughts_status ON thoughts (status) WHERE status IS NOT NULL",
    ]),
    await ddl(sql, "schemas/agent-memory: thought_id UUID REFERENCES public.thoughts(id) ON DELETE SET NULL", [
      "CREATE TABLE IF NOT EXISTS public.agent_memories_probe (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), thought_id UUID REFERENCES public.thoughts(id) ON DELETE SET NULL, workspace_id TEXT NOT NULL)",
    ]),
    await ddl(sql, "schemas/entity-extraction: CREATE TRIGGER … AFTER INSERT OR UPDATE OF content, metadata ON public.thoughts FOR EACH ROW", [
      "CREATE TRIGGER trg_queue_entity_extraction_probe AFTER INSERT OR UPDATE OF content, metadata ON public.thoughts FOR EACH ROW EXECUTE FUNCTION update_updated_at()",
    ]),
  ];
}

// The three behaviours, each with two sessions and a watcher on pg_locks.
const gate = () => { let open!: () => void; const p = new Promise<void>((res) => (open = res)); return { p, open }; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The waiter's own backend, not any ungranted advisory lock in the cluster (first review pass). */
async function advisoryWaiters(w: SQL, pid: number): Promise<number> {
  return Number(((await w`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND pid = ${pid}`)[0] as { n: number }).n);
}
const backendPid = async (conn: SQL): Promise<number> => Number(((await conn`SELECT pg_backend_pid()::int AS p`)[0] as { p: number }).p);
/** A probe whose own plumbing throws is a failed probe, not a dead run (first review pass: a mutant aborted the eval with a raw stack and no report). */
async function guarded(label: string, fn: () => Promise<Probe[]>): Promise<Probe[]> {
  try { return await fn(); } catch (e) { return [{ name: `${label}: the probe itself failed`, ok: false, error: msg(e) }]; }
}
async function waitFor(pred: () => Promise<boolean>, ticks = 200): Promise<boolean> {
  for (let i = 0; i < ticks; i++) { if (await pred()) return true; await sleep(25); }
  return false;
}

async function probeC7(c: Ctx, url: string): Promise<Probe[]> {
  const a = new SQL({ url, max: 1 }); const b = new SQL({ url, max: 1 }); const w = new SQL({ url, max: 1 });
  const out: Probe[] = [];
  const text = `Two sessions capture this text at once (${c.option}).`;
  const payload = { metadata: { source: "race" }, embedding_model: MODEL, actor: ACTOR };
  try {
    const hold = gate();
    let first: Row | undefined;
    let aError: string | null = null;
    const aRun = a.begin(async (tx) => {
      first = ((await tx`SELECT upsert_thought(${text}, ${payload}::jsonb, ${vec(71)}::vector) AS r`) as Row[])[0]?.r as Row;
      await hold.p;
    }).catch((e: unknown) => { aError = msg(e); });
    await waitFor(async () => first !== undefined || aError !== null);
    out.push({ name: "the first capture holds its transaction open", ok: first !== undefined && aError === null, error: aError ?? "no result" });
    const bpid = await backendPid(b);
    const bRun = b`SELECT upsert_thought(${text}, ${payload}::jsonb, ${vec(72)}::vector) AS r`.then((rows) => ({ ok: true as const, r: (rows as Row[])[0]?.r as Row }), (e: unknown) => ({ ok: false as const, error: msg(e) }));
    const waited = await waitFor(async () => (await advisoryWaiters(w, bpid)) > 0);
    out.push({ name: "the second capture waits on the advisory lock the first holds (pg_locks, its own backend)", ok: waited, error: "no advisory waiter seen" });
    hold.open();
    await aRun;
    const second = await bRun;
    out.push({ name: "both captures return, the second as existed", ok: second.ok && second.r?.existed === true && String(second.r?.id) === String(first?.id), error: second.ok ? json(second.r) : second.error });
    const n = Number(((await w`SELECT count(*)::int AS n FROM thoughts WHERE content = ${text}`)[0] as { n: number }).n);
    out.push({ name: "one row for the text, no 23505", ok: n === 1, error: `${n} row(s)` });
  } finally { await a.end(); await b.end(); await w.end(); }
  return out;
}

async function twoRows(sql: SQL, tag: string): Promise<{ x: string; y: string }> {
  const x = ((await sql`SELECT upsert_thought(${`X of ${tag}`}, ${{ metadata: { source: "race" }, actor: ACTOR }}::jsonb) AS r`) as Row[])[0].r as Row;
  const y = ((await sql`SELECT upsert_thought(${`Y of ${tag}`}, ${{ metadata: { source: "race" }, actor: ACTOR }}::jsonb) AS r`) as Row[])[0].r as Row;
  return { x: String(x.id), y: String(y.id) };
}

async function probeC8(c: Ctx, url: string): Promise<Probe[]> {
  const a = new SQL({ url, max: 1 }); const b = new SQL({ url, max: 1 });
  const out: Probe[] = [];
  try {
    const { x, y } = await twoRows(c.sql, `C8 ${c.option}`);
    const hold = gate();
    let held = false;
    let aRes: Row | undefined;
    let aError: string | null = null;
    const aRun = a.begin(async (tx) => {
      aRes = ((await tx`SELECT update_thought(${y}::uuid, ${`Y of C8 ${c.option}, edited`}::text, NULL::jsonb, NULL::vector, NULL::jsonb, NULL::timestamptz, ${ACTOR}::jsonb, NULL::text, NULL::jsonb) AS r`) as Row[])[0]?.r as Row;
      held = true;
      await hold.p;
    }).catch((e: unknown) => { aError = msg(e); });
    await waitFor(async () => held || aError !== null);
    out.push({ name: "the edit of the target succeeded and holds its row lock", ok: aRes?.ok === true && aError === null, error: aError ?? json(aRes ?? null) });
    const started = performance.now();
    const res = await b.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '4s'`;
      return ((await tx`SELECT update_thought(${x}::uuid, NULL::text, NULL::jsonb, NULL::vector, NULL::jsonb, NULL::timestamptz, ${ACTOR}::jsonb, NULL::text, ${{ supersedes: y }}::jsonb) AS r`) as Row[])[0]?.r as Row;
    }).then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, error: msg(e) }));
    const took = performance.now() - started;
    hold.open();
    await aRun;
    out.push({ name: "the edit naming supersedes completes while the target's row lock is held (FOR NO KEY UPDATE vs KEY SHARE)", ok: res.ok && res.r?.ok === true && took < 3500, error: res.ok ? `${json(res.r)} in ${took.toFixed(0)} ms` : res.error });
    const sup = ((await c.sql`SELECT supersedes::text AS s FROM thoughts WHERE id = ${x}::uuid`) as Row[])[0]?.s;
    out.push({ name: "X.supersedes = Y afterwards", ok: sup === y, error: String(sup) });
  } finally { await a.end(); await b.end(); }
  return out;
}

async function probeC9(c: Ctx, url: string): Promise<Probe[]> {
  const a = new SQL({ url, max: 1 }); const b = new SQL({ url, max: 1 }); const w = new SQL({ url, max: 1 });
  const out: Probe[] = [];
  try {
    const { x, y } = await twoRows(c.sql, `C9 ${c.option}`);
    const hold = gate();
    let held = false;
    let aRes: Row | undefined;
    let aError: string | null = null;
    const aRun = a.begin(async (tx) => {
      aRes = ((await tx`SELECT update_thought(${x}::uuid, NULL::text, NULL::jsonb, NULL::vector, NULL::jsonb, NULL::timestamptz, ${ACTOR}::jsonb, NULL::text, ${{ supersedes: y }}::jsonb) AS r`) as Row[])[0]?.r as Row;
      held = true;
      await hold.p;
    }).catch((e: unknown) => { aError = msg(e); });
    await waitFor(async () => held || aError !== null);
    out.push({ name: "the edit naming supersedes succeeded and holds the supersession lock", ok: aRes?.ok === true && aError === null, error: aError ?? json(aRes ?? null) });
    const bpid = await backendPid(b);
    const bRun = b.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '6s'`;
      return ((await tx`SELECT delete_thought(${y}::uuid, ${ACTOR}::jsonb, false) AS r`) as Row[])[0]?.r as Row;
    }).then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, error: msg(e) }));
    const waited = await waitFor(async () => (await advisoryWaiters(w, bpid)) > 0);
    out.push({ name: "delete_thought waits on the supersession lock update_thought holds", ok: waited, error: "no advisory waiter seen" });
    hold.open();
    await aRun;
    const res = await bRun;
    out.push({ name: "both finish, no deadlock: the delete returns ok", ok: res.ok && res.r?.ok === true, error: res.ok ? json(res.r) : res.error });
    const sup = ((await c.sql`SELECT supersedes::text AS s FROM thoughts WHERE id = ${x}::uuid`) as Row[])[0]?.s ?? null;
    out.push({ name: "X's pointer is nulled by the cascade", ok: sup === null, error: String(sup) });
  } finally { await a.end(); await b.end(); await w.end(); }
  return out;
}

async function probeC10(c: Ctx, withProjector: boolean): Promise<Probe[]> {
  const { trace: t, census: cs, sql } = c;
  // A step that failed (C5 says so) wrote nothing; its count is not a second finding — but it is said (first review pass: the cell read 19/19 beside 21/21).
  const notCounted: string[] = [];
  const counted = (prefix: string, expected: number): Probe[] => {
    if (stepOf(t, prefix)?.ok === false) { notCounted.push(prefix); return []; }
    return [delta(t, prefix, expected)];
  };
  const out: Probe[] = [
    ...counted("s1", 1), ...counted("s2", 1), ...counted("s3", 0), ...counted("s4", 1), ...counted("s5", 1),
    ...counted("s6", 1), ...counted("s7", 1), ...counted("s8", 1), ...counted("s9", 0), ...counted("s10", 0), ...counted("s11", 0),
    ...counted("s12b", 0), ...counted("s12c", 2), ...counted("s13", 1), ...counted("s14", 1), ...counted("s15a", 1), ...counted("s15b", 1),
    ...counted("s16", 1), ...counted("s17", 2), ...counted("s18", 1), ...counted("s17b", 1), ...counted("s17c", 1),
    ...counted("s19", 1), ...counted("s20", 1), ...counted("s21", 1),
  ];
  if (notCounted.length) c.notes.push(`${c.option}: C10 counted no audit rows for ${notCounted.join(", ")} — the step itself failed (C5)`);
  // 016's trigger: a claim for every thought written (the functions', the raw insert's, the ingester's), none for a deleted one (the FK cascade).
  const claimed = new Set(cs.claims.map((k) => k.thought_id));
  // The live rows among them — under option 1 the ingester's statement fails (C5) and E was never written.
  const liveText: Record<string, string[]> = { B: [TEXTS.B], D: [TEXTS.D], E: [TEXTS.E1, TEXTS.E2], F: [TEXTS.F, TEXTS.F2], G: [TEXTS.G], G2: [TEXTS.G2], G3: [TEXTS.G3], I: [TEXTS.I] };
  const want = Object.keys(liveText).filter((l) => t.ids[l] && cs.rows.some((r) => liveText[l].includes(r.content)));
  out.push({ name: `an extraction claim for every live thought written (${want.join(", ")}) and none for the deleted (A, C)`, ok: want.every((l) => claimed.has(t.ids[l])) && !claimed.has(t.ids.A) && !claimed.has(t.ids.C), error: json([...claimed].map((id) => Object.entries(t.ids).find(([, v]) => v === id)?.[0] ?? id.slice(0, 8))) });
  const rowB = cs.rows.find((r) => r.content === TEXTS.B);
  out.push({ name: "the actor stamp on the row (050): B carries no stamp (no envelope)", ok: !!rowB && rowB.metadata?.actor_name === undefined, error: json(rowB?.metadata ?? null) });
  // The stamp on a ROW that survives to the census — the prototype's callable stamp against 050's trigger (first review pass: only events and deleted rows had been read).
  const rowF = t.images["F after s16"];
  out.push({ name: "F's row carries the stamp (actor_name op-key, actor_kind operator) — the row, not the event", ok: rowF?.metadata?.actor_name === "op-key" && rowF?.metadata?.actor_kind === "operator", error: json(rowF?.metadata ?? null) });
  // 050's rule on a raw content edit with no envelope: the actor follows the content, and a writer with no key leaves no mark.
  const rowF21 = cs.rows.find((r) => r.content === TEXTS.F2);
  out.push({ name: "after s21's raw content UPDATE with no envelope, F's stamp is gone (050: the actor follows the content)", ok: !!rowF21 && rowF21.metadata?.actor_name === undefined && rowF21.metadata?.actor_kind === undefined, error: json(rowF21?.metadata ?? null) });
  const capA = await eventsOf(sql, t.ids.A, "capture");
  out.push({ name: "A's capture event metadata carries the stamp (actor_name op-key, actor_kind operator)", ok: (capA[0]?.diff?.metadata as Row | undefined)?.actor_name === "op-key" && (capA[0]?.diff?.metadata as Row | undefined)?.actor_kind === "operator", error: json(capA[0]?.diff?.metadata ?? null) });
  const bump = ((await sql`SELECT updated_at > created_at AS bumped FROM thoughts WHERE id = ${t.ids.B}::uuid`) as Row[])[0]?.bumped;
  out.push({ name: "updated_at bumped on B by its edits", ok: bump === true, error: String(bump) });
  // 046's anti-inheritance rule (first review pass): s17 hand-set ob1.event, called update_thought, then INSERTed raw in one transaction.
  const capG = await eventsOf(sql, t.ids.G, "capture");
  out.push({ name: "a raw insert after a function call in one transaction inherits no hand-set stance (046's rule)", ok: capG.length === 1 && capG[0].stance === null, error: capG[0] ? `stance ${json(capG[0].stance)}` : "no capture event for G" });
  // The per-body clears, each on a path where the function projected nothing (second review pass).
  const capG2 = await eventsOf(sql, t.ids.G2, "capture");
  out.push({ name: "…nor after an update_thought that changed nothing (the body's own clear)", ok: capG2.length === 1 && capG2[0].stance === null, error: capG2[0] ? `stance ${json(capG2[0].stance)}` : "no capture event for G2" });
  const capG3 = await eventsOf(sql, t.ids.G3, "capture");
  out.push({ name: "…nor after an identical re-capture (the 2-argument body's own clear)", ok: capG3.length === 1 && capG3[0].stance === null, error: capG3[0] ? `stance ${json(capG3[0].stance)}` : "no capture event for G3" });
  // 046's envelope through the bodies (second review pass): the capture's declarations on its event, the edit's over-claim recorded, not copied.
  const capI = await eventsOf(sql, t.ids.I, "capture");
  out.push({ name: "I's capture event carries the declared stance, citation, valid window and trust (agent, under the key's ceiling)", ok: capI[0]?.stance === "retrieved" && json(capI[0]?.cites) === json([t.ids.B]) && capI[0]?.trust === "agent" && capI[0]?.actor_kind === "operator" && typeof capI[0]?.valid_from === "string" && typeof capI[0]?.valid_until === "string", error: json(capI[0] ? { stance: capI[0].stance, cites: capI[0].cites, trust: capI[0].trust, kind: capI[0].actor_kind, from: capI[0].valid_from, until: capI[0].valid_until } : null) });
  const updI = await eventsOf(sql, t.ids.I, "update");
  out.push({ name: "I's edit event keeps the key's kind (operator), takes the lower trust, and files the claimed actor_kind under actor_context.claimed", ok: updI[0]?.actor_kind === "operator" && updI[0]?.trust === "agent" && updI[0]?.stance === "inferred" && (updI[0]?.actor_context?.claimed as Row | undefined)?.actor_kind === "ingested", error: json(updI[0] ? { kind: updI[0].actor_kind, trust: updI[0].trust, stance: updI[0].stance, context: updI[0].actor_context } : null) });
  c.notes.push(`${c.option}: an identical re-capture (s3) ${t.noopBumped === null ? "could not be measured" : t.noopBumped ? "bumps updated_at with no audit row (053's ON CONFLICT DO UPDATE)" : "leaves updated_at as it was — no event, no write"}`);
  if (withProjector) {
    // The check itself (first review pass: the mechanism the report leans on had no probe): a row moved under an
    // event that does not name the change must be refused. The base relation by name — under option 1 an UPDATE
    // of the view is legitimately intercepted and given its own event.
    // Two arms, two forgeries (second review pass: one forgery had hit the divergence arm alone). B's latest metadata
    // event names metadata and not supersedes: a metadata forgery DIVERGES from it, a supersedes forgery moves a column
    // it DOES NOT NAME.
    const ev = ((await sql`SELECT id::text AS id FROM thought_audit WHERE thought_id = ${t.ids.B}::uuid AND action = 'update' AND diff ? 'metadata' AND NOT diff ? 'supersedes' ORDER BY created_at DESC, seq DESC LIMIT 1`) as Row[])[0]?.id as string | undefined;
    const forge = async (statement: string): Promise<string | null> => {
      try {
        await sql.begin(async (tx) => {
          await tx`SELECT set_config('ob1.projecting', ${ev ?? ""}, true)`;
          await tx.unsafe(statement);
        });
        return null;
      } catch (e) { return msg(e); }
    };
    const diverged = await forge(`UPDATE ${c.rows} SET metadata = metadata || '{"forged": true}'::jsonb WHERE id = '${t.ids.B}'::uuid`);
    out.push({ name: "the check: a metadata forged under an event whose metadata differs is refused as a divergence (OB002)", ok: diverged !== null && /diverges from its update event/.test(diverged), error: diverged ?? "the write went through unrefused" });
    const unnamed = await forge(`UPDATE ${c.rows} SET supersedes = '${t.ids.F}'::uuid WHERE id = '${t.ids.B}'::uuid`);
    out.push({ name: "the check: a pointer moved under an event that does not name supersedes is refused (OB002)", ok: unnamed !== null && /does not name/.test(unnamed), error: unnamed ?? "the write went through unrefused" });
    const landed = ((await sql`SELECT metadata ? 'forged' AS f, supersedes::text AS s FROM thoughts WHERE id = ${t.ids.B}::uuid`) as Row[])[0];
    out.push({ name: "and nothing of either landed", ok: landed?.f === false && landed?.s === null, error: json(landed ?? null) });
    // The vector's presence (third review pass: the rule reached no probe): F's latest event is s21's raw content
    // edit, which names no flip — dropping F's vector under it must be refused.
    const evF = ((await sql`SELECT id::text AS id FROM thought_audit WHERE thought_id = ${t.ids.F}::uuid ORDER BY created_at DESC, seq DESC LIMIT 1`) as Row[])[0]?.id as string | undefined;
    let dropped: string | null = null;
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('ob1.projecting', ${evF ?? ""}, true)`;
        await tx.unsafe(`UPDATE ${c.rows} SET embedding = NULL WHERE id = '${t.ids.F}'::uuid`);
      });
    } catch (e) { dropped = msg(e); }
    out.push({ name: "the check: a vector dropped under an event that names no presence flip is refused (OB002)", ok: dropped !== null && /vector's presence/.test(dropped), error: dropped ?? "the write went through unrefused" });
  }
  return out;
}

async function probeC11(c: Ctx, withProjector: boolean): Promise<Probe[]> {
  const { sql } = c;
  const out: Probe[] = [];
  const word = `zyxwvutsr${c.option.replace(/[^a-z0-9]/g, "")}`;
  const r = ((await sql`SELECT upsert_thought(${`Read your writes: ${word} appears once.`}, ${{ metadata: { source: "ryw" }, embedding_model: MODEL, actor: ACTOR }}::jsonb, ${vec(11)}::vector) AS r`) as Row[])[0]?.r as Row;
  const id = String(r?.id ?? "");
  const seen = Number(((await sql`SELECT count(*)::int AS n FROM thoughts WHERE id = ${id}::uuid`)[0] as { n: number }).n);
  out.push({ name: "a capture is visible to a SELECT on thoughts in the same session, no delay", ok: seen === 1, error: `${seen} row(s)` });
  const hits = (await sql`SELECT id::text AS id FROM search_thoughts_keyword(${word}, 5, 0, '{}'::jsonb)`) as Row[];
  out.push({ name: "and to search_thoughts_keyword", ok: hits.some((h) => h.id === id), error: `${hits.length} hit(s)` });
  if (!withProjector) return out;
  // The control: the event appended, the projector not run.
  const word2 = `${word}control`;
  const gid = ((await sql`SELECT gen_random_uuid()::text AS id`) as Row[])[0].id as string;
  const diff = { content: `The control: ${word2} exists only as an event until the projector runs.`, metadata: { source: "control" } };
  await sql.begin(async (tx) => {
    const ev = ((await tx`SELECT ob1_append_thought_event(${gid}::uuid, 'capture', 'control', ${diff}::jsonb, NULL::jsonb) AS ev`) as Row[])[0].ev as string;
    const absent = Number(((await tx`SELECT count(*)::int AS n FROM thoughts WHERE id = ${gid}::uuid`)[0] as { n: number }).n);
    const miss = (await tx`SELECT id::text AS id FROM search_thoughts_keyword(${word2}, 5, 0, '{}'::jsonb)`) as Row[];
    out.push({ name: "drop-the-projector control: the event exists and no row does", ok: absent === 0 && miss.length === 0, error: `${absent} row(s), ${miss.length} hit(s)` });
    await tx`SELECT ob1_project_thought_event(${ev}::uuid)`;
    const present = Number(((await tx`SELECT count(*)::int AS n FROM thoughts WHERE id = ${gid}::uuid`)[0] as { n: number }).n);
    const hit = (await tx`SELECT id::text AS id FROM search_thoughts_keyword(${word2}, 5, 0, '{}'::jsonb)`) as Row[];
    out.push({ name: "the projector run on that event makes the row appear and the search hit", ok: present === 1 && hit.some((h) => h.id === gid), error: `${present} row(s), ${hit.length} hit(s)` });
  });
  return out;
}

async function replayRows(sql: SQL, rows: "thoughts" | "thought_rows"): Promise<ReplayRow[]> {
  return (await sql.unsafe(`SELECT id::text AS id, content, content_fingerprint, metadata, supersedes::text AS supersedes, derived_from, created_at::text AS created_at, updated_at::text AS updated_at, embedding::text AS embedding, embedding_model FROM ${rows} ORDER BY id`)) as ReplayRow[];
}

async function probeC12(c: Ctx): Promise<{ probes: Probe[]; diffs: ReplayDiff[] }> {
  const { sql, rows } = c;
  const before = await replayRows(sql, rows);
  const eventsBefore = Number(((await sql`SELECT count(*)::int AS n FROM thought_audit`)[0] as { n: number }).n);
  await sql.unsafe(`ALTER TABLE ${rows} DISABLE TRIGGER USER`);
  await sql.unsafe(`DELETE FROM ${rows} WHERE true`);
  await sql.unsafe(`ALTER TABLE ${rows} ENABLE TRIGGER USER`);
  const wiped = Number(((await sql.unsafe(`SELECT count(*)::int AS n FROM ${rows}`))[0] as { n: number }).n);
  const probes: Probe[] = [{ name: "the projection wiped (triggers held off) — no row", ok: wiped === 0, error: `${wiped} row(s)` }];
  let replayError: string | null = null;
  try {
    await sql.unsafe(`DO $$ DECLARE r record; BEGIN FOR r IN SELECT id FROM thought_audit ORDER BY created_at, seq LOOP PERFORM ob1_project_thought_event(r.id, NULL, NULL, true); END LOOP; END $$`);
  } catch (e) { replayError = msg(e); }
  probes.push({ name: `every event replayed in (created_at, seq) order through the projector (${eventsBefore} events)`, ok: replayError === null, error: replayError ?? undefined });
  const eventsAfter = Number(((await sql`SELECT count(*)::int AS n FROM thought_audit`)[0] as { n: number }).n);
  probes.push({ name: "the replay appended nothing to the log", ok: eventsAfter === eventsBefore, error: `${eventsBefore} → ${eventsAfter}` });
  const after = await replayRows(sql, rows);
  // A replay the projector aborted rebuilt nothing: every row would read "absent", which is one fact, not one per row (third review pass).
  const diffs = replayError === null ? compareRows(before, after) : [];
  const hard = diffs.filter((d) => !d.tolerated);
  probes.push({ name: `the rebuilt rows equal the copy (${before.length} rows; content, key, metadata, provenance, stamps, vector, label)`, ok: replayError === null && hard.length === 0, error: replayError !== null ? `not compared: the replay raised — ${replayError}` : hard.map((d) => `${d.id.slice(0, 8)}.${d.column}`).join(", ") });
  // The drop-the-content mutant.
  let refused: string | null = null;
  try {
    await sql.begin(async (tx) => {
      const ev = ((await tx`INSERT INTO thought_audit (thought_id, action, diff) VALUES (gen_random_uuid(), 'capture', ${{ metadata: { source: "old" } }}::jsonb) RETURNING id::text AS id`) as Row[])[0].id as string;
      await tx`SELECT ob1_project_thought_event(${ev}::uuid, NULL, NULL, true)`;
    });
  } catch (e) { refused = msg(e); }
  probes.push({ name: "a capture event without content (008's shape) is refused by the projector", ok: refused !== null && refused.includes("carries no content"), error: refused ?? "projected without complaint" });
  return { probes, diffs };
}

async function timeCalls(sql: SQL, tag: string): Promise<{ captureUs: number; editUs: number }> {
  const captures: number[] = []; const edits: number[] = [];
  const ids: string[] = [];
  for (let i = 0; i < TIMING_N; i++) {
    const text = `Timing ${tag} ${i}: a capture of ordinary length for the cost line.`;
    const t0 = performance.now();
    const r = ((await sql`SELECT upsert_thought(${text}, ${{ metadata: { source: "timing" }, embedding_model: MODEL, actor: ACTOR }}::jsonb, ${vec(i)}::vector) AS r`) as Row[])[0].r as Row;
    captures.push((performance.now() - t0) * 1000);
    ids.push(String(r.id));
  }
  for (let i = 0; i < TIMING_N; i++) {
    const t0 = performance.now();
    await sql`SELECT update_thought(${ids[i]}::uuid, ${`Timing ${tag} ${i}: the capture, edited once.`}::text, NULL::jsonb, ${vec(i + 1)}::vector, NULL::jsonb, NULL::timestamptz, ${ACTOR}::jsonb, ${MODEL}::text, NULL::jsonb) AS r`;
    edits.push((performance.now() - t0) * 1000);
  }
  return { captureUs: median(captures), editUs: median(edits) };
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

type OptionRun = { option: OptionId; observations: Observation[]; trace: Trace; census: Census; replay?: ReplayDiff[]; timing?: { captureUs: number; editUs: number } };

async function runOption(url: string, option: OptionId, notes: string[]): Promise<OptionRun> {
  const sql = new SQL({ url, max: 1 });
  try {
    await undoPrototype(sql);
    await resetSchema(url, { dim: DIM, model: MODEL });
    const rows: "thoughts" | "thought_rows" = option.startsWith("option1") ? "thought_rows" : "thoughts";
    if (option === "option2") { await apply(sql, "common.sql", "thoughts"); await apply(sql, "option2-functions.sql", "thoughts"); }
    if (option === "option1-unchanged") { await apply(sql, "option1-view.sql", "thought_rows"); await apply(sql, "common.sql", "thought_rows"); }
    if (option === "option1") { await apply(sql, "option1-view.sql", "thought_rows"); await apply(sql, "common.sql", "thought_rows"); await apply(sql, "option2-functions.sql", "thought_rows"); }
    // The stages before the probes (second review pass): a throw here is a FAIL on every gating criterion with the
    // error named, not a dead run with no verdict.
    let trace: Trace; let cs: Census;
    try {
      await seed(sql);
      trace = await runScript(sql);
      cs = await census(sql);
    } catch (e) {
      const failed: Probe[] = [{ name: "the scripted writes or the census could not run", ok: false, error: msg(e) }];
      return {
        option, observations: CRITERIA.filter((x) => x.gating !== "informative").map((x) => judge(x.id, option, failed)),
        trace: { steps: [], ids: {}, noopBumped: null, images: {}, planted: [] }, census: { rows: [], events: [], claims: [], chunks: {} },
      };
    }
    const c: Ctx = { sql, option, trace, census: cs, rows, notes };
    const obs: Observation[] = [];
    const add = (id: CriterionId, probes: Probe[]) => obs.push(judge(id, option, probes));
    add("C1", await guarded("C1", () => probeC1(c))); add("C2", await guarded("C2", () => probeC2(c))); add("C3", await guarded("C3", () => probeC3(c)));
    add("C4", await guarded("C4", () => probeC4(c))); add("C5", await guarded("C5", () => probeC5(c))); add("C6", await guarded("C6", () => probeC6(c)));
    const full = option !== "option1-unchanged";
    let replay: ReplayDiff[] | undefined;
    let timing: { captureUs: number; editUs: number } | undefined;
    if (full) {
      add("C7", await guarded("C7", () => probeC7(c, url))); add("C8", await guarded("C8", () => probeC8(c, url))); add("C9", await guarded("C9", () => probeC9(c, url)));
      add("C10", await guarded("C10", () => probeC10(c, option !== "baseline")));
      add("C11", await guarded("C11", () => probeC11(c, option !== "baseline")));
      if (option !== "baseline") {
        let diffs: ReplayDiff[] = [];
        add("C12", await guarded("C12", async () => { const r = await probeC12(c); diffs = r.diffs; return r.probes; }));
        replay = diffs;
      } else {
        add("C12", []);
        notes.push("baseline: no projector and no content in a capture event — the log cannot rebuild the rows (SMD-1998); C12 is not measurable");
      }
      if (option === "baseline" || option === "option2") {
        try { timing = await timeCalls(sql, option); } catch (e) { notes.push(`${option}: the cost line could not be measured — ${msg(e)}`); }
      }
    } else {
      for (const id of ["C7", "C8", "C9", "C10", "C11", "C12"] as CriterionId[]) add(id, []);
    }
    return { option, observations: obs, trace, census: cs, replay, timing };
  } finally {
    // Whatever happened above, the view (if option 1 got that far) is undone and the handle closed (first review pass).
    try { await undoPrototype(sql); } finally { await sql.end(); }
  }
}

async function prototype(): Promise<{ report: Report; observations: Observation[] }> {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is not set. Try: ../db/with-postgres.sh bun eval-writable-projection.ts --prototype"); process.exit(2); }
  const probe = new SQL({ url, max: 1 });
  const exists = ((await probe`SELECT (to_regclass('thoughts') IS NOT NULL) AS present`)[0] as { present: boolean }).present;
  const held = exists ? Number(((await probe`SELECT count(*)::int AS n FROM thoughts`)[0] as { n: number }).n) : 0;
  const pg = ((await probe`SELECT version() AS v`)[0] as { v: string }).v.replace(/ on .*$/, "");
  await probe.end();
  if (held > 0 && process.env.OB1_FIXTURE_RESET !== "1") {
    console.error(`the database at DATABASE_URL holds ${held} thought(s) and this run DROPS the schema. Point it at a throwaway (../db/with-postgres.sh), or set OB1_FIXTURE_RESET=1 if you mean it.`);
    process.exit(2);
  }
  const notes: string[] = [];
  const runs: OptionRun[] = [];
  try {
    for (const o of OPTIONS) runs.push(await runOption(url, o.id, notes));
  } finally {
    // The shared data-layer database is left at the shipped schema whether or not the run completed (first review pass).
    await teardown(url);
  }
  const observations = runs.flatMap((r) => r.observations);
  const verdicts: Verdict[] = OPTIONS.map((o) => verdict(o.id, observations));
  const deltas = Object.fromEntries(OPTIONS.map((o) => [o.id, observations
    .filter((x) => x.option === o.id && ["C1", "C2", "C3", "C4", "C5", "C6"].includes(x.criterion) && x.outcome === "FAIL")
    .flatMap((x) => x.failed.map((p) => `${x.criterion} ${p.name}${p.error ? ` — ${p.error}` : ""}`))])) as Record<OptionId, string[]>;
  const base = runs.find((r) => r.option === "baseline")!;
  const two = runs.find((r) => r.option === "option2")!;
  const differential: Mismatch[] = [
    ...compareImages(relabel(base.census.events, base.trace.ids), relabel(two.census.events, two.trace.ids), "event", comparableEvent),
    ...compareImages(relabel(base.census.rows, base.trace.ids), relabel(two.census.rows, two.trace.ids), "row", comparableRow),
    ...compareImages(base.trace.steps.map((s) => relabel({ step: s.step, ok: s.ok, value: s.value, error: s.error }, base.trace.ids)), two.trace.steps.map((s) => relabel({ step: s.step, ok: s.ok, value: s.value, error: s.error }, two.trace.ids)), "return", (s) => ({ ...s, value: stripStamps(s.value) })),
  ];
  const timings: Timing[] = base.timing && two.timing
    ? [{ label: `3-argument capture with a vector, ${TIMING_N} each`, baselineUs: base.timing.captureUs, optionUs: two.timing.captureUs },
       { label: `content edit with a vector, ${TIMING_N} each`, baselineUs: base.timing.editUs, optionUs: two.timing.editUs }]
    : [];
  const replay: Partial<Record<OptionId, ReplayDiff[]>> = {};
  for (const r of runs) if (r.replay) replay[r.option] = r.replay;
  for (const r of runs) {
    for (const s of r.trace.steps) if (!s.ok || s.step.includes("planted")) notes.push(`${r.option}: ${s.step}${s.error ? ` — ${s.error}` : ""}`);
  }
  notes.push("option2 / option1: a vector arriving on a row that already has one is a projection refresh — no event, and updated_at is left as it was (053 bumps it through update_thought); the vector's own time is ob1_embedding_snapshot.taken_at");
  const recommendation = recommend(verdicts, deltas);
  const report: Report = { postgres: pg, observations, verdicts, deltas, timings, differential, replay, notes, recommendation };
  return { report, observations };
}

/**
 * The data-layer job runs its suites back to back on one database, and
 * test-support's reset knows the migrations' objects, not the prototype's:
 * its functions, its snapshot table and its trigger would outlive this run.
 * Dropped here, then a plain reset, so the next suite starts from the shipped schema.
 */
async function teardown(url: string): Promise<void> {
  const sql = new SQL({ url, max: 1 });
  await undoPrototype(sql);
  await sql`DROP TRIGGER IF EXISTS thoughts_snapshot_embedding ON thoughts`;
  for (const fn of [
    // (ob1_thought_diff, ob1_append_thought_event, ob1_actor_stamp and
    // ob1_actor_stamp_kept were the prototype's until 055 shipped them —
    // SMD-2115; test-support's reset owns them now.)
    "ob1_snapshot_embedding()", "ob1_project_thought_event(uuid, vector, text, boolean)", "ob1_refresh_thought_vector(uuid, vector, text)",
    "ob1_thoughts_view_insert()", "ob1_thoughts_view_update()", "ob1_thoughts_view_delete()",
  ]) await sql.unsafe(`DROP FUNCTION IF EXISTS ${fn}`);
  await sql.end();
  await resetSchema(url, { dim: DIM, model: MODEL });
}

/** Return values carry ids the relabelling did not name (a facet's), fingerprints and stamps; the shape and the flags are what is compared. */
function stripStamps(v: unknown): unknown {
  if (v === undefined) return v;
  const text = JSON.stringify(v)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g, "<ts>")
    .replace(/\b[0-9a-f]{64}\b/g, "<fp>");
  return JSON.parse(text) as unknown;
}

// ---------------------------------------------------------------------------
// --self-check: the rules, no database.
// ---------------------------------------------------------------------------

function selfCheck(): void {
  const { assert, report } = createAssert();
  const P = (name: string, ok: boolean, error?: string): Probe => ({ name, ok, error });

  console.log("\n[1] the contract");
  assert(OPTIONS.length === 4 && OPTIONS.map((o) => o.id).join() === "baseline,option2,option1-unchanged,option1", "four options in the measured order");
  assert(CRITERIA.length === 14 && CRITERION_IDS[0] === "C1" && CRITERION_IDS[13] === "C14", "fourteen criteria, C1–C14");
  assert(CRITERIA.filter((c) => c.gating === "contract").map((c) => c.id).join() === "C1,C2,C3,C4,C5,C6,C10,C11,C12", "the contract criteria are C1–C6 and C10–C12");
  assert(CRITERIA.filter((c) => c.gating === "behaviour").map((c) => c.id).join() === "C7,C8,C9", "the behaviour criteria are C7–C9");
  assert(CRITERIA.filter((c) => c.gating === "informative").map((c) => c.id).join() === "C13,C14", "C13 and C14 inform, never gate");

  console.log("\n[2] judge");
  assert(judge("C1", "option2", []).outcome === "N/A", "no probe → N/A");
  assert(judge("C1", "option2", [P("a", true), P("b", true)]).outcome === "PASS", "every probe ok → PASS");
  const j = judge("C1", "option2", [P("a", true), P("b", false, "boom")]);
  assert(j.outcome === "FAIL" && j.failed.length === 1 && j.failed[0].name === "b" && j.probes === 2, "one probe failed → FAIL naming it, the count kept");

  console.log("\n[3] verdict");
  const allPass = (opt: OptionId): Observation[] => CRITERIA.filter((c) => c.gating !== "informative").map((c) => judge(c.id, opt, [P("x", true)]));
  assert(verdict("option2", allPass("option2")).go === true, "every gating criterion PASS → GO");
  const withFail = allPass("option2").map((o) => (o.criterion === "C6" ? judge("C6", "option2", [P("ADD COLUMN", false, "not supported for views")]) : o));
  const v1 = verdict("option2", withFail);
  assert(v1.go === false && v1.reasons.length === 1 && v1.reasons[0].startsWith("C6 FAIL: ADD COLUMN — not supported"), "one contract FAIL → NO-GO with the probe and its error named");
  const withNa = allPass("option2").filter((o) => o.criterion !== "C12");
  const v2 = verdict("option2", withNa);
  assert(v2.go === false && v2.reasons.join() === "C12 not measured", "an unmeasured contract criterion is not a PASS");
  const behaviourFail = allPass("option2").map((o) => (o.criterion === "C8" ? judge("C8", "option2", [P("no block", false, "timeout")]) : o));
  assert(verdict("option2", behaviourFail).go === false, "a behaviour that does not hold → NO-GO");
  assert(verdict("option1", [...allPass("option1"), judge("C13", "option1", [P("cost", false, "slower")]), judge("C14", "option1", [P("delta", false, "one change")])]).go === true, "informative criteria never enter the verdict: C13 and C14 failing leave a GO");

  console.log("\n[4] recommend");
  const V = (option: OptionId, go: boolean): Verdict => ({ option, go, reasons: go ? [] : ["x"] });
  const D0: Record<OptionId, string[]> = { baseline: [], option2: [], "option1-unchanged": ["a", "b"], option1: ["a"] };
  const r1 = recommend([V("baseline", true), V("option2", true), V("option1-unchanged", false), V("option1", false)], D0);
  assert(r1.option === "option2" && r1.why.includes("empty contributor delta") && r1.why.includes("the only GO option"), "one GO option → it, with an empty delta said");
  const r2 = recommend([V("baseline", true), V("option2", true), V("option1-unchanged", false), V("option1", true)], D0);
  assert(r2.option === "option2", "two GO options → the shorter delta");
  const r3 = recommend([V("baseline", true), V("option2", true), V("option1-unchanged", false), V("option1", true)], { ...D0, option1: [] });
  assert(r3.option === "option2" && r3.why.includes("fewer moved objects"), "a tied delta → fewer moved objects, said");
  const r4 = recommend([V("baseline", true), V("option2", false), V("option1-unchanged", false), V("option1", false)], D0);
  assert(r4.option === null && r4.why.includes("zero contributor-visible break") , "no GO option → none, and SMD-1997 is told the premise is false");
  assert(recommend([V("baseline", true), V("option2", false), V("option1-unchanged", false), V("option1", false)], D0).option !== "baseline", "the baseline is never the recommendation");

  console.log("\n[5] the differential's normalisation");
  const ev = (action: string, diff: Record<string, unknown>): EventImage => ({ action, source: "s", actor_name: null, actor_kind: null, trust: null, origin: null, stance: null, cites: null, valid_from: null, valid_until: null, actor_context: null, diff });
  assert(JSON.stringify(comparableEvent(ev("capture", { content: "x", metadata: { a: 1 } })).diff) === JSON.stringify({ metadata: { a: 1 } }), "a capture's content is set aside");
  assert(JSON.stringify(comparableEvent(ev("capture", { content: "x", created_at: "2024-01-02T03:04:05+00:00", metadata: { a: 1 } })).diff) === JSON.stringify({ metadata: { a: 1 } }), "a capture's created_at — the third addition — is set aside too");
  assert(JSON.stringify(comparableEvent(ev("capture", { metadata: { a: 1 }, supersedes: "u" })).diff) === JSON.stringify({ metadata: { a: 1 }, supersedes: "u" }), "046's own capture keys stay");
  assert(compareImages([ev("capture", { metadata: {} })], [{ ...ev("capture", { metadata: {} }), stance: "stated" }], "event", comparableEvent).length === 1 && compareImages([ev("update", {})], [{ ...ev("update", {}), actor_context: { claimed: { actor_kind: "agent" } } }], "event", comparableEvent).length === 1, "the envelope's columns — stance, cites, the window, the context's claim — are compared");
  assert(JSON.stringify(comparableEvent(ev("update", { content: { before: "a", after: "b" }, content_fingerprint: { before: "1", after: "2" } })).diff) === JSON.stringify({ content: { before: "a", after: "b" } }), "an update's key move is set aside");
  assert(JSON.stringify(comparableEvent(ev("delete", { previous_content: "x" })).diff) === JSON.stringify({ previous_content: "x" }), "a delete's diff is compared whole");
  assert(comparableEvent(ev("capture", { content: "x" })).diff !== undefined && ev("capture", { content: "x" }).diff?.content === "x", "the normalisation copies, it does not mutate");
  const m0 = compareImages([ev("capture", { content: "x", metadata: {} })], [ev("capture", { content: "y", metadata: {} })], "event", comparableEvent);
  assert(m0.length === 0, "two captures differing only in content compare equal");
  const m1 = compareImages([ev("update", { metadata: { before: 1, after: 2 } })], [ev("update", { metadata: { before: 1, after: 3 } })], "event", comparableEvent);
  assert(m1.length === 1 && m1[0].at === "event[0]", "a differing after is one mismatch at its index");
  const m2 = compareImages([ev("capture", {}), ev("capture", {})], [ev("capture", {})], "event", comparableEvent);
  assert(m2.length === 1 && m2[0].at === "event count" && m2[0].baseline === "2" && m2[0].option === "1", "a length difference is one mismatch on the count");
  const rowImg = (c: string, fp: string | null, mt: string | null = "object"): RowImage => ({ content: c, content_fingerprint: fp, metadata_type: mt, metadata: {}, supersedes: null, derived_from: null, has_vector: true, embedding_model: MODEL });
  assert(compareImages([rowImg("a", "1")], [rowImg("a", "1")], "row", comparableRow).length === 0 && compareImages([rowImg("a", "1")], [rowImg("a", null)], "row", comparableRow).length === 1, "rows compare on every caller-visible column");
  assert(compareImages([rowImg("a", "1", "null")], [rowImg("a", "1", null)], "row", comparableRow).length === 1, "a JSON null and an SQL NULL metadata are told apart by the type");

  console.log("\n[6] the replay rule");
  const rr = (id: string, o: Partial<ReplayRow> = {}): ReplayRow => ({ id, content: "c", content_fingerprint: "fp", metadata: { a: 1 }, supersedes: null, derived_from: null, created_at: "t0", updated_at: "t1", embedding: "[1,2]", embedding_model: MODEL, ...o });
  assert(compareRows([rr("1"), rr("2")], [rr("2"), rr("1")]).length === 0, "equal rows in any order → no difference");
  const d1 = compareRows([rr("1", { content_fingerprint: null })], [rr("1")]);
  assert(d1.length === 1 && d1[0].column === "content_fingerprint" && d1[0].tolerated, "a NULL key the projector filled is the one tolerated difference");
  const d2 = compareRows([rr("1")], [rr("1", { content_fingerprint: null })]);
  assert(d2.length === 1 && !d2[0].tolerated, "a key lost on replay is not tolerated");
  const d3 = compareRows([rr("1"), rr("2")], [rr("1")]);
  assert(d3.length === 1 && d3[0].column === "presence" && d3[0].after === "absent", "a row missing after replay is a presence difference");
  const d4 = compareRows([rr("1")], [rr("1"), rr("3")]);
  assert(d4.length === 1 && d4[0].column === "presence" && d4[0].before === "absent", "a row that appears is one too");
  const d5 = compareRows([rr("1")], [rr("1", { updated_at: "t9", embedding: "[9,9]" })]);
  assert(d5.length === 2 && d5.map((d) => d.column).join() === "updated_at,embedding" && d5.every((d) => !d.tolerated), "updated_at and the vector are compared, column by column");
  assert(compareRows([rr("1", { content: "x".repeat(100) })], [rr("1", { content: "y".repeat(100) })])[0].before.length <= 60, "a long value is cut in the record");

  console.log("\n[7] the cost line");
  assert(fmtUs(950) === "950 µs" && fmtUs(1500) === "1.50 ms" && fmtUs(NaN) === "n/a", "microseconds under a millisecond, milliseconds above, n/a for none");
  assert(costLine({ label: "x", baselineUs: 1000, optionUs: 1500 }) === "x: baseline 1.00 ms, option 2 1.50 ms (×1.50)", "the ratio beside the two medians");
  assert(!costLine({ label: "x", baselineUs: 0, optionUs: 1 }).includes("×"), "no ratio over a zero baseline");

  console.log("\n[8] the recorded matrix");
  assert(Object.keys(EXPECTED).join() === "baseline,option2,option1-unchanged,option1", "a row per option");
  assert(Object.values(EXPECTED).every((row) => Object.keys(row).every((k) => CRITERION_IDS.includes(k as CriterionId) && k !== "C13" && k !== "C14")), "cells only for gating criteria");
  assert(EXPECTED.option2.C6 === "PASS" && EXPECTED.option1.C6 === "FAIL" && EXPECTED["option1-unchanged"].C1 === "FAIL", "the record: option 2 keeps the community DDL, option 1 breaks it, 053's functions fail through the view");
  assert(EXPECTED.baseline.C1 === "PASS" && EXPECTED.baseline.C12 === "N/A", "the record: the shipped capture event carries the content since 055 (SMD-2115; at 053 the baseline failed C1's last clause), and the baseline still cannot be replayed — no projector");
  const obsAll: Observation[] = (Object.keys(EXPECTED) as OptionId[]).flatMap((opt) => (Object.entries(EXPECTED[opt]) as [CriterionId, Outcome][]).map(([c, o]) => {
    const count = EXPECTED_PROBES[opt][c];
    const probes = count ? count[1] : o === "N/A" ? 0 : 1;
    const failedN = count ? count[1] - count[0] : o === "FAIL" ? 1 : 0;
    return { criterion: c, option: opt, outcome: o, failed: Array.from({ length: failedN }, (_, i) => P(`f${i}`, false)), probes };
  }));
  assert(obsAll.every((o) => (o.outcome === "FAIL") === (o.failed.length > 0) && (o.outcome === "N/A") === (o.probes === 0)), "the recorded counts agree with the recorded outcomes: a FAIL has a failed probe, a PASS none, an N/A no probe");
  assert(driftFrom(EXPECTED, obsAll).length === 0, "a run equal to the record drifts nowhere");
  const moved = obsAll.map((o) => (o.option === "option2" && o.criterion === "C6" ? { ...o, outcome: "FAIL" as Outcome } : o));
  const drift = driftFrom(EXPECTED, moved);
  assert(drift.length === 1 && drift[0] === "option2/C6: recorded PASS, observed FAIL", "a moved cell is named with both values");
  assert(driftFrom(EXPECTED, obsAll.filter((o) => !(o.option === "option1" && o.criterion === "C12"))).join() === "option1/C12: recorded PASS, observed N/A", "a cell not measured reads N/A against the record");
  assert((Object.keys(EXPECTED_PROBES) as OptionId[]).every((opt) => (Object.entries(EXPECTED_PROBES[opt]) as [CriterionId, Count][]).every(([k, c]) => c[1] > 0 && c[0] <= c[1] && EXPECTED[opt][k] !== "N/A")), "a count is recorded only for a measured cell, never zero, passed never above run");
  const shrunk = obsAll.map((o) => (o.option === "option2" && o.criterion === "C10" ? { ...o, probes: o.probes - 2 } : o));
  const c10 = EXPECTED_PROBES.option2.C10!;
  assert(driftFrom(EXPECTED, shrunk).join() === `option2/C10: recorded ${c10[0]}/${c10[1]} probes, observed ${c10[0] - 2}/${c10[1] - 2}`, "a suite that shrank by two probes is drift, though every outcome stands");
  const flipped = obsAll.map((o) => (o.option === "option1" && o.criterion === "C5" ? { ...o, failed: [...o.failed, P("s21", false)] } : o));
  const c5 = EXPECTED_PROBES.option1.C5!;
  assert(driftFrom(EXPECTED, flipped).join() === `option1/C5: recorded ${c5[0]}/${c5[1]} probes, observed ${c5[0] - 1}/${c5[1]} probes`.replace(/ probes$/, ""), "a probe flipping inside a cell that already reads FAIL is drift (third review pass)");

  console.log("\n[9] the report");
  const rep: Report = {
    postgres: "PostgreSQL 16.x", observations: obsAll, verdicts: OPTIONS.map((o) => verdict(o.id, obsAll)),
    deltas: { baseline: [], option2: [], "option1-unchanged": ["C1 s1 — ON CONFLICT"], option1: ["C6 ADD COLUMN — views"] },
    timings: [{ label: "capture", baselineUs: 1000, optionUs: 1200 }], differential: [], replay: { option2: [] }, notes: ["a note"],
    recommendation: { option: "option2", why: "because" },
  };
  const text = renderReport(rep);
  assert(/^criterion\s+baseline\s+option2/m.test(text) && text.includes("\nC1         ") && text.includes("option1-unchanged"), "the matrix has a row per gating criterion and a column per option, the label and the ids one width apart");
  assert(text.includes("option2: GO") && text.includes("option1: NO-GO") && text.includes("C6 FAIL"), "each option's verdict with its reasons");
  assert(text.includes("C14 contributor delta: none") && text.includes("- C6 ADD COLUMN — views"), "the contributor delta per option, none said as none");
  assert(text.includes("capture: baseline 1.00 ms, option 2 1.20 ms (×1.20)"), "the cost lines");
  assert(text.includes("identical") && text.includes("C12 replay under option2: every column of every row equal"), "the differential and the replay, each summarised");
  assert(text.trim().endsWith("Recommendation: option2 — because"), "the recommendation closes the report");
  assert(!text.includes("C13  ") && !text.includes("C14  "), "informative criteria are not matrix rows");

  console.log("\n[10] the arguments");
  assert(argumentProblem(["--self-check"]) === null && argumentProblem(["--prototype"]) === null && argumentProblem(["--check"]) === null && argumentProblem(["--prototype", "--json"]) === null, "the three modes, --json with --prototype");
  assert(argumentProblem([]) !== null && argumentProblem(["--self-check", "--check"]) !== null && argumentProblem(["--check", "--json"]) !== null && argumentProblem(["--bogus"]) !== null, "no mode, two modes, --json elsewhere and an unknown flag are refused");
  assert(protoSql("common.sql", "thought_rows").includes("ON thought_rows") && !protoSql("common.sql", "thought_rows").includes("{{") && protoSql("option2-functions.sql", "thoughts").includes(`vector(${DIM})`), "the prototype SQL substitutes the width and the rows relation, leaving no placeholder");
  // The rule's owner, not a copy of it (boyscout): check 21 reads every .sql through destructiveSqlIn, this file included.
  const destructive = ["common.sql", "option1-view.sql", "option1-undo.sql", "option2-functions.sql"].flatMap((f) => destructiveSqlIn(readFileSync(join(SQL_DIR, f), "utf8")).map((h) => `${f}:${h.line} ${h.rule}`));
  assert(destructive.length === 0, `no prototype file destroys rows by check 21's own rule${destructive.length ? ` — ${destructive.join("; ")}` : ""}`);

  report();
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const problem = argumentProblem(args);
  if (problem) { console.error(problem); process.exit(2); }
  if (has("--self-check")) { selfCheck(); return; }  // report() exits; the return says so without leaning on it
  const { report, observations } = await prototype();
  if (has("--json")) {
    console.log(JSON.stringify({ report, observations }, null, 2));
  } else {
    console.log(renderReport(report));
  }
  if (has("--check")) {
    const { assert, report: done } = createAssert();
    console.log("\n[check] the run against the recorded matrix");
    const drift = driftFrom(EXPECTED, observations);
    assert(drift.length === 0, `no cell moved${drift.length ? `: ${drift.join("; ")}` : ""}`);
    assert(report.recommendation.option === "option2", "the recommendation is option 2");
    assert(report.verdicts.find((v) => v.option === "option2")?.go === true && report.verdicts.find((v) => v.option === "option1")?.go === false, "option 2 GO, option 1 NO-GO");
    assert((report.replay.option2 ?? []).every((d) => d.tolerated), "option 2's replay differs from the copy only where tolerated");
    assert(report.differential.length === 0, `the baseline's log and rows equal option 2's for the same writes${report.differential.length ? ` (${report.differential.length} mismatch(es))` : ""}`);
    assert(report.deltas.option2.length === 0, "option 2's contributor delta is empty");
    done();
  }
  process.exit(report.recommendation.option ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
