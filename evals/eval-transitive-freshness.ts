#!/usr/bin/env bun
/**
 * eval-transitive-freshness.ts — should search_thoughts' prefer_current demote a
 * thought whose REFERENCED tickets are finished, and by which rule? (SMD-2271.)
 *
 * The gap. prefer_current (059, SMD-2255) demotes a thought whose OWN lifecycle
 * is settled — a ticket row, or a note filed under a ticket (node_state, 058) —
 * or that a newer thought supersedes. A session summary has neither: it carries
 * no ticket and nothing supersedes it across sessions (each summary's one
 * supersedes slot holds its own checkpoint chain, SMD-2271's 2026-10-01 note).
 * So a summary that recommends SMD-2074 still ranks first for "what should we
 * work on next" after SMD-2074 went Done, above the correct (Done) ticket row.
 * The fix the ticket proposes is node_state one hop out: a lifecycle-less thought
 * inherits "references settled work" from the tickets it is ABOUT.
 *
 * What this prices, before any SQL is written (eval-supersession.ts's shape: a
 * TypeScript oracle over the shipped functions, the rule pre-registered).
 *
 *   A thought's references are the ticket keys in its text that the brain holds
 *   a ticket head for (ob1_ticket_head, 068). Two kinds:
 *     CENTRAL — a key in its metadata.topics or metadata.action_items (what the
 *               capture-time extractor said the thought is about or asks for), or
 *               the key a session summary's header names (the branch's ticket:
 *               `Session summary — SMD-1234 — …`);
 *     BODY    — any key anywhere in its text (a passing mention included).
 *   A key whose head carries no known status_type (node_lifecycle_types()) is
 *   ignored, as 059 ignores an unknown status: no claim either way.
 *
 *   These are JavaScript's readings (evals/transitive-freshness.ts); migration
 *   077's ticket_references reproduces them in SQL, and --sql-check holds the two
 *   to each other on every thought of a brain at 077. The places they could
 *   part, and how 077 closes each: PostgreSQL's `\m`/`\M` read the locale's
 *   letters as word characters (its `\b` is a backspace), so 077 reads keys
 *   with ASCII lookarounds, which are JS `\b` (no `u` flag) beside an ASCII
 *   letter or digit; jsonb_array_elements_text would stringify an object or
 *   number in topics, so 077 keeps string elements alone, as strings() does;
 *   and the pattern is case-sensitive in both, so a lower-cased topic
 *   (`smd-2074`) is no central reference in either.
 *
 *   The candidate rules, each applied ONLY to a thought with no lifecycle of its
 *   own (node_state's open IS NULL — a ticket row's own status always wins):
 *     none           — prefer_current as shipped (the control);
 *     central        — demote when it has ≥1 known central reference and every
 *                      one is settled (completed or canceled);
 *     central-topics — the same without the header key (topics and action items
 *                      alone: the header parse couples to the session hook's
 *                      format, so its share of the effect is reported apart);
 *     central+share  — central; and for a thought with NO known central
 *                      reference, demote when ≥ SHARE_MIN known body references
 *                      and at least SHARE of them are settled;
 *     share          — the share rule over body references alone (≥1 known).
 *   A demoted row weighs search_demote_weight() (0.25) of its fused score, once
 *   whatever the reasons, and the window is re-sorted as 059 re-sorts it (ties
 *   to the current row, then the hybrid's order).
 *
 * The gold (evals/fixtures/transitive-freshness-labels.json: ids and numbers
 * only, never text). A hit is `stale` — what it puts forward as work to do, or
 * as the state of things, is finished; `current` — something it puts forward is
 * still open, or it states something still true that a planner needs (an open
 * ticket row, the live release plan); `neutral` — neither (a log of a past
 * session that recommends nothing). Each round had two fresh graders, given the
 * rubric, the hits' text and the tickets' statuses and nothing of the rules.
 * Round 1 graded the first registration's top 10s before its verdict; round 2,
 * after it, what the second registration's queries and rules added to the top
 * 10s; round 3, after the first review pass, every row a rule demotes anywhere
 * in a window it is judged on — (b)'s whole reach. Round 1's four disagreements
 * were adjudicated by the author, who knew the rules; round 3's by a third
 * blind grader choosing between the two labels.
 *
 * PRE-REGISTERED decision (written before the first measured run):
 *   1. A rule QUALIFIES only if
 *      (a) the measured case flips: on P1 the SMD-2074 recommendation
 *          (20f6454c) leaves the top 10 or is marked demoted;
 *      (b) it demotes no hit labelled `current` in a planning or control
 *          query's window — AMENDED after the first run: as written it was
 *          checked on each rule's top 10 alone, which cannot see a current hit
 *          demoted OUT of the top 10; it now reads the whole window (W = 40),
 *          rows shipped prefer_current already demotes (superseded) excepted;
 *      (c) the release-plan control (C1) ranks its plan (7eedad78) no worse
 *          than prefer_current as shipped does — AMENDED after the first run:
 *          as written, "keeps its plan first", it failed every rule and the
 *          control alike, because shipped prefer_current ranks the plan second
 *          (7f99233c, labelled current, is first); the premise came from a
 *          search without prefer_current. Every first-registration rule kept
 *          the plan second, so the amendment decides nothing between them;
 *      (d) drop-the-mechanism: with every ticket head read as open, its
 *          ranking is prefer_current's exactly, on every query.
 *      (a) and (c) are "n/a" — no qualification — when prefer_current as
 *      shipped does not hold the row in its own top 10 (nothing measured).
 *   2. Among qualifying rules, the one with the fewest `stale` hits in the
 *      planning top 10s (P1–P4 summed) wins; central+share or share is chosen
 *      over central only if it removes at least 2 more stale hits, since each
 *      demotes knowledge notes central does not (the census states how many).
 *   3. If none qualifies, the ticket's rank arm does not ship as specified; the
 *      verdict says which condition failed.
 *
 *   RESULT of the first registration (2026-10-02): NO rule qualifies. Each
 *   demotes a hit both graders call current, on (b): every one SMD-1846's
 *   session summary (3c346ae2; its own ticket is Done, but it puts forward the
 *   open SMD-2306/2307 in its body), the share rules also a release digest
 *   (008b4199, the open SMD-1805/1806) and the roadmap summary (dc8d9130, the
 *   open SMD-1729/1795 — split by the graders, adjudicated current); with
 *   round 2's labels, the central three also SMD-2131's summary (8f511d57, the
 *   open SMD-1931/2133). Every miss names an open ticket.
 *
 * SECOND registration (written after the first verdict, before these rules
 * were run):
 *     central-veto       — central, and the thought names NO open ticket
 *                          anywhere in its text (the open veto);
 *     central+share-veto — central-veto; and with no known central reference,
 *                          ≥ SHARE_MIN known body references, every one settled.
 *   The held-out queries H1–H4 are new planning phrasings. A rule QUALIFIES on
 *   (a) and (d) as above and (b) over every planning, held-out and control
 *   window; the one with the fewer `stale` hits in H1–H4's top 10s wins,
 *   central+share-veto over central-veto only if it removes at least 2 more.
 *   If neither qualifies, the rank arm does not ship. (c), as amended, is
 *   reported beside it and is not part of it.
 *
 *   What "held out" turned out to mean (the first review pass): the QUERIES are
 *   new, their hits mostly are not — 28 of the 53 hits in H1–H4's top 10s were
 *   already in a P or C top 10, and every stale hit either veto rule leaves in
 *   H1–H4 sits in a P or C window. So the H stale@10 comparison is not
 *   out-of-sample evidence; the program also prints it restricted to hits
 *   outside every P and C window. The out-of-sample evidence is (b): the
 *   current hits only rounds 2 and 3 labelled, none of which a qualifying rule
 *   may demote. And (b) has little power against a veto rule by construction —
 *   it can fail only on a current hit that names no open ticket in its text.
 *
 *   RESULT of the second registration (re-run after the first review pass, with
 *   (b) over every demoted window row and every such row labelled): both
 *   qualify, and central+share-veto wins — H1–H4 stale@10 17 → 8 (central-veto
 *   11); outside every P/C window 1 → 0 for both. evals/README.md has the tables.
 *
 * The census (the ticket's salience bound, Work item 4): per rule, how many
 * thoughts it moves — lifecycle-less and not already superseded (059 already
 * demotes those) — split session summaries / other; each settled ticket's
 * fan-out — how many moved thoughts it helps decide (a key among the deciding
 * set); and the most-mentioned keys with how many of their PASSING (body-only)
 * mentions decide a demotion (0 by construction under the central rules, whose
 * deciding set is the central keys).
 *
 * Read-only against the live brain: every connection opens with
 * default_transaction_read_only on, from a one-off container on its network;
 * DATABASE_URL is built inside it from $POSTGRES_PASSWORD (never on argv). The
 * query is embedded with the brain's own model through the egress gate, as
 * db/tier.ts's replay does.
 *
 *   podman run --rm --network open-brain_default --env-file deploy/.env \
 *     -e OB1_LLM_LOCAL=1 -e OB1_LLM_BASE_URL=http://host.containers.internal:11434/v1 \
 *     -e OB1_EMBEDDING_MODEL=qwen3-embedding:4b \
 *     -v <worktree>:/repo -w /repo oven/bun:1.4.0-alpine \
 *     sh -c 'export DATABASE_URL="postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/openbrain"; bun evals/eval-transitive-freshness.ts'
 *
 *   … eval-transitive-freshness.ts --dump-unlabelled <file>   every hit (b) or a
 *        top 10 needs and the labels lack, with its text, to label from (write
 *        it outside the repo)
 *   … eval-transitive-freshness.ts --sql-check                on a brain at 077:
 *        its SQL equals the rule on every thought, and search_thoughts_current
 *        the oracle's central+share-veto ranking on every panel query
 *   bun eval-transitive-freshness.ts --self-check             the rules, the
 *        oracle, the verdict's arithmetic and the labels' provenance; no database
 */

import { SQL } from "bun";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEmbedder, resolveEmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { egressRefusal } from "../db/worker-bootstrap.ts";
import { DEMOTE_WEIGHT, refsOf, RULES, SHARE_MIN, transitiveDemotion, type Refs, type Rule, type StatusOf } from "./transitive-freshness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LABELS_PATH = join(HERE, "fixtures", "transitive-freshness-labels.json");

// ── The rules (pure) ─────────────────────────────────────────────────────────

type Kind = "planning" | "heldout" | "control" | "topical";
/** A registration: its rules, the narrow ones (a wide rule must beat them by 2), the windows (b) reads, the stale@10 it is decided on, and whether (c) is part of it. */
type Registration = { title: string; rules: readonly Rule[]; narrow: readonly Rule[]; bOver: readonly Kind[]; on: "planning" | "heldout"; withC: boolean };
const FIRST: Registration = { title: "The first registration (P1–P4)", rules: ["central", "central-topics", "central+share", "share"], narrow: ["central", "central-topics"], bOver: ["planning", "control"], on: "planning", withC: true };
const SECOND: Registration = { title: "The second registration (H1–H4)", rules: ["central-veto", "central+share-veto"], narrow: ["central-veto"], bOver: ["planning", "heldout", "control"], on: "heldout", withC: false };

/** One row of the hybrid's window, with what node_state says of it. */
export type WindowRow = { id: string; fused: number; ord: number; settled: boolean; superseded: boolean; lifecycle: boolean };
type Hit = { id: string; demoted: boolean; transitive: boolean };

/**
 * 059's re-sort, with a transitive demotion beside the reflexive one: a row is
 * demoted when settled, superseded or `transitive(row)` says so; its score is
 * fused × DEMOTE_WEIGHT once; ties to the current row, then the hybrid's order;
 * cut to n. `transitive` is consulted only for a row with no lifecycle.
 */
export function rerank(win: WindowRow[], n: number, transitive: (r: WindowRow) => boolean): Hit[] {
  return win
    .map((r) => {
      const t = !r.lifecycle && transitive(r);
      const demoted = r.settled || r.superseded || t;
      return { r, t, demoted, score: r.fused * (demoted ? DEMOTE_WEIGHT : 1) };
    })
    .sort((a, b) => b.score - a.score || Number(a.demoted) - Number(b.demoted) || a.r.ord - b.r.ord)
    .slice(0, n)
    .map((x) => ({ id: x.r.id, demoted: x.demoted, transitive: x.t }));
}

/**
 * The rows a rule demotes that prefer_current as shipped does not — what (b)
 * reads, over the WHOLE window: a current hit demoted out of the top 10 is the
 * case (b) exists to catch. A superseded row is demoted already; a settled one
 * has a lifecycle, so the rule never reads it.
 */
export function transitiveRows(win: WindowRow[], transitive: (r: WindowRow) => boolean): string[] {
  return win.filter((r) => !r.lifecycle && !r.superseded && transitive(r)).map((r) => r.id);
}

type Verdict3 = "yes" | "no" | "n/a";
/** (a): `id` leaves the rule's top 10 or is demoted there; n/a when the baseline's top 10 does not hold it. */
export function flips(none: Hit[], rule: Hit[], id: string): Verdict3 {
  if (!none.some((x) => x.id === id)) return "n/a";
  return !rule.some((x) => x.id === id) || rule.some((x) => x.id === id && x.demoted) ? "yes" : "no";
}
/** (c): `id` ranks no worse under the rule than under the baseline; n/a when the baseline's top 10 does not hold it. */
export function noWorse(none: Hit[], rule: Hit[], id: string): Verdict3 {
  const i = none.findIndex((x) => x.id === id), j = rule.findIndex((x) => x.id === id);
  if (i < 0) return "n/a";
  return j >= 0 && j <= i ? "yes" : "no";
}

/**
 * The registered pick among qualifying rules: the narrow rule with the fewest
 * stale hits, unless a wide rule has at least `margin` fewer; a wide rule when
 * no narrow one qualifies; null when none does. Ties keep the earlier rule.
 */
export function pick(ok: readonly Rule[], stale: (r: Rule) => number, narrowRules: readonly Rule[], margin = 2): Rule | null {
  if (ok.length === 0) return null;
  const best = (rs: Rule[]) => rs.reduce((x, y) => (stale(y) < stale(x) ? y : x));
  const narrow = ok.filter((r) => narrowRules.includes(r)), wide = ok.filter((r) => !narrowRules.includes(r));
  if (narrow.length === 0) return best(wide);
  const n = best(narrow);
  return wide.length && stale(best(wide)) <= stale(n) - margin ? best(wide) : n;
}

// ── The panel ────────────────────────────────────────────────────────────────

type PanelQuery = { name: string; query: string; kind: Kind };

/** The planning queries the ticket and its comments measured, four more held out, the release-plan control, and three topical queries whose cost is displacement. */
const PANEL: PanelQuery[] = [
  { name: "P1", kind: "planning", query: "what should we work on next — highest priority open work on the Open Brain fork" },
  { name: "P2", kind: "planning", query: "most valuable unstarted issue" },
  { name: "P3", kind: "planning", query: "highest value open issue for the open brain project" },
  { name: "P4", kind: "planning", query: "Open Brain projects: status, progress, what work remains" },
  { name: "H1", kind: "heldout", query: "what's next on the Open Brain roadmap" },
  { name: "H2", kind: "heldout", query: "which open brain ticket should I pick up now" },
  { name: "H3", kind: "heldout", query: "what work is left before v2.0.0" },
  { name: "H4", kind: "heldout", query: "top priorities for the fork this week" },
  { name: "C1", kind: "control", query: "what is the Open Brain release plan and what comes next after v1.5.0" },
  { name: "T1", kind: "topical", query: "how does node_state read a ticket's lifecycle" },
  { name: "T2", kind: "topical", query: "prefer_current demote weight for settled and superseded thoughts" },
  { name: "T3", kind: "topical", query: "session capture redacts secrets instead of refusing" },
];
const N = 10;
const MEASURED = "20f6454c-75e1-4c56-baf2-572ec04e7c66"; // the SMD-2074 recommendation (P1's #1, 2026-10-01)
const PLAN = "7eedad78-cad7-46c1-bd49-417a3243e832"; // the release plan captured 2026-10-02

type Label = "stale" | "current" | "neutral";
const LABEL_SET: readonly Label[] = ["stale", "current", "neutral"];
/**
 * The gold: per labelling round, two graders' labels, and `labels`, the
 * adjudicated label of every id (where a round's graders disagreed, one of
 * theirs). Each round's `agreement` is what kappa() computes from its two, held
 * by the self-check.
 */
type Round = { generated: string; graders: { a: Record<string, Label>; b: Record<string, Label> }; agreement: { raw: number; kappa: number; adjudicated: number } };
type Labels = { version: 1; labels: Record<string, Label>; rounds: Round[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The file stores ids and numbers only (check 9: a committed fixture carries no
 * free string but under generated / origin / note / query): a label is its index
 * in LABEL_SET. Decoded here, every entry checked.
 */
export function decodeLabels(path: string, m: unknown): Record<string, Label> {
  if (m === null || typeof m !== "object" || Array.isArray(m)) throw new Error(`${path}: a label map must be an object`);
  const out: Record<string, Label> = {};
  for (const [id, v] of Object.entries(m)) {
    if (!UUID_RE.test(id) || typeof v !== "number" || !Number.isInteger(v) || LABEL_SET[v] === undefined) throw new Error(`${path}: bad entry ${id}: ${String(v)}`);
    out[id] = LABEL_SET[v];
  }
  return out;
}

/** Cohen's kappa of two graders over the ids both labelled: (observed − expected) / (1 − expected). */
export function kappa(a: Record<string, Label>, b: Record<string, Label>): { n: number; raw: number; kappa: number } {
  const ids = Object.keys(a).filter((id) => b[id] !== undefined);
  const n = ids.length;
  if (n === 0) return { n, raw: 0, kappa: 0 };
  const po = ids.filter((id) => a[id] === b[id]).length / n;
  const pe = LABEL_SET.reduce((acc, l) => acc + (ids.filter((id) => a[id] === l).length / n) * (ids.filter((id) => b[id] === l).length / n), 0);
  return { n, raw: po, kappa: pe === 1 ? 1 : (po - pe) / (1 - pe) };
}

/** The committed labels; a missing file, a missing round list or a malformed entry is an Error naming the file. */
export function readLabels(path = LABELS_PATH): Labels {
  if (!existsSync(path)) throw new Error(`${path}: the labels fixture is missing`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; labels?: unknown; rounds?: unknown };
  if (raw.version !== 1) throw new Error(`${path}: not a version-1 labels file`);
  if (!Array.isArray(raw.rounds) || raw.rounds.length === 0) throw new Error(`${path}: no labelling rounds`);
  const rounds = raw.rounds.map((r: { generated?: unknown; graders?: { a?: unknown; b?: unknown }; agreement?: { raw?: unknown; kappa?: unknown; adjudicated?: unknown } }, i: number) => {
    const ag = r?.agreement;
    if (typeof r?.generated !== "string" || !r.graders || !ag || typeof ag.raw !== "number" || typeof ag.kappa !== "number" || typeof ag.adjudicated !== "number") throw new Error(`${path}: round ${i + 1} lacks generated, graders or agreement`);
    return { generated: r.generated, graders: { a: decodeLabels(path, r.graders.a), b: decodeLabels(path, r.graders.b) }, agreement: { raw: ag.raw, kappa: ag.kappa, adjudicated: ag.adjudicated } };
  });
  return { version: 1, labels: decodeLabels(path, raw.labels), rounds };
}

// ── The measurement ──────────────────────────────────────────────────────────

type Thought = { id: string; content: string; lifecycle: boolean; superseded: boolean; refs: Refs; summary: boolean };

async function measure(url: string, dumpPath: string | undefined) {
  // A startup parameter, so it holds on every connection the pool opens, not
  // only the first.
  const sql = new SQL({ url, max: 1, connection: { default_transaction_read_only: "on" } });

  const [types] = await sql`SELECT node_lifecycle_types() AS known, node_settled_types() AS settled`;
  const known = new Set<string>(types.known), settled = new Set<string>(types.settled);
  const heads = new Map<string, string>();
  for (const h of await sql`SELECT issue, status_type FROM ob1_ticket_head`) if (known.has(h.status_type)) heads.set(h.issue, h.status_type);
  const statusOf: StatusOf = (k) => heads.get(k);
  const openStatus: StatusOf = (k) => (heads.has(k) ? "started" : undefined); // drop-the-mechanism: every head read as open

  const thoughts = new Map<string, Thought>();
  for (const t of await sql`
      SELECT t.id::text AS id, t.content, t.metadata, s.open IS NOT NULL AS lifecycle, s.superseded_by IS NOT NULL AS superseded
        FROM thoughts t LEFT JOIN node_state(NULL) s ON s.thought_id = t.id`) {
    thoughts.set(t.id, { id: t.id, content: t.content, lifecycle: t.lifecycle, superseded: t.superseded, refs: refsOf(t.content, t.metadata), summary: t.content.startsWith("Session summary") });
  }
  const free = [...thoughts.values()].filter((t) => !t.lifecycle);
  const movable = free.filter((t) => !t.superseded);
  const demotes = (rule: Rule, st: StatusOf = statusOf) => (id: string) => { const th = thoughts.get(id); return th !== undefined && transitiveDemotion(th.refs, st, settled, rule) !== null; };

  // ── The census ──
  console.log(`\n# Transitive freshness (SMD-2271) — ${thoughts.size} thoughts, ${free.length} with no lifecycle of their own (${free.filter((t) => t.summary).length} session summaries), ${movable.length} of them not already superseded; ${heads.size} ticket heads with a known status, ${[...heads.values()].filter((s) => settled.has(s)).length} settled\n`);
  console.log(`## Census: what each rule moves (of the ${movable.length} lifecycle-less thoughts nothing supersedes)\n`);
  console.log("| rule | thoughts moved | session summaries | other | max fan-out of one settled key | p50 | p90 |");
  console.log("|---|---:|---:|---:|---:|---:|---:|");
  for (const rule of RULES.filter((r) => r !== "none")) {
    const moved = movable.map((t) => ({ t, by: transitiveDemotion(t.refs, statusOf, settled, rule) })).filter((x) => x.by !== null);
    // A key's fan-out: the moved thoughts it helps decide (it is in the deciding set).
    const fan = new Map<string, number>();
    for (const x of moved) for (const k of x.by!) fan.set(k, (fan.get(k) ?? 0) + 1);
    const f = [...fan.values()].sort((a, b) => a - b);
    const pct = (p: number) => (f.length ? f[Math.max(0, Math.ceil(p * f.length) - 1)] : 0); // nearest rank
    console.log(`| ${rule} | ${moved.length} | ${moved.filter((x) => x.t.summary).length} | ${moved.filter((x) => !x.t.summary).length} | ${f.at(-1) ?? 0} | ${pct(0.5)} | ${pct(0.9)} |`);
  }

  // The hubs: the most-mentioned keys, and how many PASSING (body-only) mentions decide a demotion.
  const bodyCount = new Map<string, number>();
  for (const t of free) for (const k of t.refs.body) if (heads.has(k)) bodyCount.set(k, (bodyCount.get(k) ?? 0) + 1);
  const hubs = [...bodyCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log("\n## The salience bound: the most-mentioned keys\n");
  console.log(`| key | status | lifecycle-less thoughts mentioning it | of which only in passing | passing mentions that decide a demotion: ${RULES.filter((r) => r !== "none").join(" / ")} |`);
  console.log("|---|---|---:|---:|---|");
  for (const [k, c] of hubs) {
    const passing = movable.filter((t) => t.refs.body.includes(k) && !t.refs.central.includes(k));
    // Demoted BECAUSE of the key: it is among the settled keys that decided the
    // demotion. A thought demoted by its own central keys that also names this
    // one in passing is not counted — the passing mention changed nothing.
    const dem = RULES.filter((r) => r !== "none").map((r) => passing.filter((t) => transitiveDemotion(t.refs, statusOf, settled, r)?.includes(k) === true).length);
    console.log(`| ${k} | ${heads.get(k)} | ${c} | ${passing.length} | ${dem.join(" / ")} |`);
  }
  console.log("\nUnder central, central-topics and central-veto a passing key cannot decide a demotion (the deciding set is the central keys): their 0s are by construction; the share rules' are measured.");

  // ── The panel ──
  const embedCfg = resolveEmbedConfig(process.env as EmbedEnv);
  const refused = egressRefusal(embedCfg.embeddings, embedCfg.egress, ["marker"]);
  if (refused) { console.error(`the embeddings endpoint is not available (${refused}); declare it local (OB1_LLM_LOCAL=1)`); process.exit(2); }
  const embedder = createEmbedder(() => embedCfg, { rememberRefusal: false });

  const labels = readLabels().labels;
  const results: Record<string, Record<Rule, Hit[]>> = {};
  const windows: Record<string, WindowRow[]> = {};
  let fidelity = true, dropped = true;
  for (const p of PANEL) {
    const qv = `[${(await embedder.getEmbedding(p.query, { kind: "query", content: p.query }, "query")).join(",")}]`;
    const w = Math.min(100, 4 * N);
    const win = (await sql`
        SELECT h.id::text AS id, h.score AS fused, h.ord::int AS ord,
               coalesce(s.open = false, false) AS settled, s.superseded_by IS NOT NULL AS superseded, s.open IS NOT NULL AS lifecycle
          FROM search_thoughts_hybrid(${qv}::vector, ${p.query}::text, 0::float, ${w}::int, '{}'::jsonb, 0::float, 90::float)
               WITH ORDINALITY AS h(id, content, metadata, created_at, similarity, matched_needles, needles, needle_counts, common_needles, literal_only, score, ord)
          LEFT JOIN node_state(NULL) s ON s.thought_id = h.id
         ORDER BY h.ord`) as WindowRow[];
    const shipped = (await sql`
        SELECT id::text AS id FROM search_thoughts_current(${qv}::vector, ${p.query}::text, 0::float, ${N}::int, '{}'::jsonb, 0::float, 90::float)`).map((r: { id: string }) => r.id);
    windows[p.name] = win;
    results[p.name] = {} as Record<Rule, Hit[]>;
    for (const rule of RULES) {
      results[p.name][rule] = rerank(win, N, (r) => demotes(rule)(r.id));
      const control = rerank(win, N, (r) => demotes(rule, openStatus)(r.id));
      if (control.map((x) => x.id).join() !== results[p.name].none.map((x) => x.id).join()) dropped = false;
    }
    if (shipped.join() !== results[p.name].none.map((x) => x.id).join()) {
      fidelity = false;
      console.error(`oracle ≠ search_thoughts_current on ${p.name}:\n  shipped ${shipped.join(" ")}\n  oracle  ${results[p.name].none.map((x) => x.id).join(" ")}`);
    }
  }
  console.log(`\nThe oracle's "none" equals search_thoughts_current's top ${N} on every panel query: ${fidelity ? "yes" : "NO — the measurement below is not prefer_current's"}`);
  console.log(`Drop-the-mechanism (every ticket head read as open) gives "none" exactly, every rule, every query: ${dropped ? "yes" : "NO"}`);

  // (b) per rule, over its registration's windows: the labelled current rows it
  // demotes, and the rows it demotes that carry no label yet.
  const reg = (rule: Rule) => (FIRST.rules.includes(rule) ? FIRST : SECOND);
  const bOf = (rule: Rule) => {
    const current: string[] = [], unl = new Set<string>();
    for (const p of PANEL) {
      if (!reg(rule).bOver.includes(p.kind)) continue;
      for (const id of transitiveRows(windows[p.name], (r) => demotes(rule)(r.id))) {
        if (labels[id] === "current") current.push(`${p.name}:${id.slice(0, 8)}`);
        else if (labels[id] === undefined) unl.add(id);
      }
    }
    return { current, unl };
  };

  // What labelling needs: every unlabelled hit in a non-topical top 10, and every
  // unlabelled row a rule demotes in its (b) windows — unless the rule already
  // fails (b) on a labelled current hit, which no further label can undo.
  const unlabelled = new Set<string>();
  for (const p of PANEL) if (p.kind !== "topical") for (const rule of RULES) for (const x of results[p.name][rule]) if (labels[x.id] === undefined) unlabelled.add(x.id);
  for (const rule of RULES.filter((r) => r !== "none")) { const b = bOf(rule); if (b.current.length === 0) for (const id of b.unl) unlabelled.add(id); }

  if (dumpPath) {
    const out = [...unlabelled].sort().map((id) => `=== ${id}\n${thoughts.get(id)?.content ?? "(not found)"}\n`).join("\n");
    writeFileSync(dumpPath, out);
    console.log(`\n${unlabelled.size} unlabelled hit(s) written to ${dumpPath}`);
    await sql.end();
    return;
  }
  if (unlabelled.size > 0) console.log(`\nNOTE: ${unlabelled.size} hit(s) the measurement needs carry no label: ${[...unlabelled].map((i) => i.slice(0, 8)).join(" ")}`);

  console.log("\n## The panel: top 10 per rule (stale / current / neutral / unlabelled; ⇣ = demoted)\n");
  // stale@10 per rule over P1–P4 (planning) and H1–H4 (heldout), as occurrences;
  // for H also restricted to hits outside every P and C window, and as distinct thoughts.
  const seen = new Set(PANEL.filter((p) => p.kind === "planning" || p.kind === "control").flatMap((p) => windows[p.name].map((r) => r.id)));
  const tally = new Map<Rule, { planning: number; heldout: number; heldoutNew: number; heldoutDistinct: Set<string> }>();
  for (const rule of RULES) tally.set(rule, { planning: 0, heldout: 0, heldoutNew: 0, heldoutDistinct: new Set() });
  for (const p of PANEL) {
    console.log(`### ${p.name} (${p.kind}): ${p.query}\n`);
    console.log("| rule | stale | current | neutral | unl. | the top 10 |");
    console.log("|---|---:|---:|---:|---:|---|");
    for (const rule of RULES) {
      const top = results[p.name][rule];
      const c = (l: Label | undefined) => top.filter((x) => labels[x.id] === l).length;
      const t = tally.get(rule)!;
      if (p.kind === "planning") t.planning += c("stale");
      if (p.kind === "heldout") for (const x of top) if (labels[x.id] === "stale") { t.heldout++; t.heldoutDistinct.add(x.id); if (!seen.has(x.id)) t.heldoutNew++; }
      const cell = top.map((x) => `${x.id.slice(0, 8)}${x.demoted ? "⇣" : ""}${labels[x.id] ? labels[x.id][0] : "?"}`).join(" ");
      console.log(`| ${rule} | ${c("stale")} | ${c("current")} | ${c("neutral")} | ${top.filter((x) => labels[x.id] === undefined).length} | ${cell} |`);
    }
    if (p.kind === "topical") {
      const base = results[p.name].none.map((x) => x.id);
      console.log(`\nDisplaced from the top 10 vs none: ${RULES.filter((r) => r !== "none").map((r) => `${r} ${base.filter((id) => !results[p.name][r].some((x) => x.id === id)).length}`).join(", ")}`);
      for (const r of SECOND.rules) {
        const gone = base.filter((id) => !results[p.name][r].some((x) => x.id === id));
        if (gone.length) console.log(`  ${r}: ${gone.map((id) => { const th = thoughts.get(id)!; return `${id.slice(0, 8)} (${th.summary ? "summary" : "other"}; deciding ${transitiveDemotion(th.refs, statusOf, settled, r)?.join(",") ?? "— (reflexive)"})`; }).join(", ")}`);
      }
    }
    console.log("");
  }
  const hNew = [...new Set(PANEL.filter((p) => p.kind === "heldout").flatMap((p) => RULES.flatMap((r) => results[p.name][r].map((x) => x.id))))];
  console.log(`Held-out overlap: of the ${hNew.length} distinct hits in H1–H4's top 10s (every rule), ${hNew.filter((id) => seen.has(id)).length} sit in some P or C window.\n`);

  // ── The verdicts ──
  const verdict = (g: Registration) => {
    console.log(`## ${g.title}\n`);
    console.log(`| rule | (a) measured case flips | (b) no current hit demoted (${g.bOver.join(", ")} windows) | (c) plan ranks no worse${g.withC ? "" : " (reported, not registered)"} | (d) drop-the-mechanism | ${g.on} stale@10 | ${g.on === "heldout" ? "of which outside every P/C window | distinct | " : ""}qualifies |`);
    console.log(`|---|---|---|---|---|---:|${g.on === "heldout" ? "---:|---:|" : ""}---|`);
    const ok: Rule[] = [];
    let withheld = false;
    for (const rule of g.rules) {
      const a = flips(results.P1.none, results.P1[rule], MEASURED);
      const c = noWorse(results.C1.none, results.C1[rule], PLAN);
      const b = bOf(rule);
      const bCell = b.current.length ? `no (${b.current.join(", ")})` : b.unl.size ? `withheld (${b.unl.size} unlabelled)` : "yes";
      if (!b.current.length && b.unl.size) withheld = true;
      const q = a === "yes" && bCell === "yes" && (!g.withC || c === "yes") && dropped && fidelity;
      if (q) ok.push(rule);
      const t = tally.get(rule)!;
      console.log(`| ${rule} | ${a} | ${bCell} | ${c} | ${dropped ? "yes" : "no"} | ${t[g.on]} | ${g.on === "heldout" ? `${t.heldoutNew} | ${t.heldoutDistinct.size} | ` : ""}${q ? "yes" : "no"} |`);
    }
    const t0 = tally.get("none")!;
    console.log(`\nprefer_current as shipped (none): ${g.on} stale@10 = ${t0[g.on]}${g.on === "heldout" ? ` (outside every P/C window ${t0.heldoutNew}, distinct ${t0.heldoutDistinct.size})` : ""}`);
    if (withheld || unlabelled.size > 0) { console.log("\nVERDICT withheld: label the unlabelled hits first (--dump-unlabelled).\n"); return; }
    const chosen = pick(ok, (r) => tally.get(r)![g.on], g.narrow);
    if (chosen === null) console.log("\nVERDICT: no rule qualifies — the rank arm does not ship as registered (see the failed column).\n");
    else console.log(`\nVERDICT: ${chosen} — ${g.on} stale@10 ${t0[g.on]} → ${tally.get(chosen)![g.on]}.\n`);
  };
  verdict(FIRST);
  verdict(SECOND);
  await sql.end();
}

// ── --sql-check: migration 077 against the rule, on a brain at 077 ──────────

/**
 * On a brain at 077 (read-only): ticket_references and ticket_references_settled
 * equal refsOf and transitiveDemotion(central+share-veto) on EVERY thought, and
 * search_thoughts_current's top 10 equals the oracle's central+share-veto
 * ranking on every panel query. test-schema [69] holds the two on hand cases
 * and a fuzz; this holds them on a real corpus. Exit 1 on any difference.
 */
async function sqlCheck(url: string) {
  const sql = new SQL({ url, max: 1, connection: { default_transaction_read_only: "on" } });
  const [has] = await sql`SELECT to_regprocedure('ticket_references_settled(text, jsonb)') IS NOT NULL AS ok`;
  if (!has.ok) { console.error("--sql-check needs a brain at migration 077 (ticket_references_settled)"); process.exit(2); }
  const [types] = await sql`SELECT node_lifecycle_types() AS known, node_settled_types() AS settled`;
  const known = new Set<string>(types.known), settled = new Set<string>(types.settled);
  const heads = new Map<string, string>();
  for (const h of await sql`SELECT issue, status_type FROM ob1_ticket_head`) if (known.has(h.status_type)) heads.set(h.issue, h.status_type);
  const statusOf: StatusOf = (k) => heads.get(k);
  const rows = await sql`
      SELECT t.id::text AS id, t.content, t.metadata, s.open IS NOT NULL AS lifecycle,
             (SELECT coalesce(string_agg(r.issue, ',') FILTER (WHERE r.in_body), '') FROM ticket_references(t.content, t.metadata) r) AS body,
             (SELECT coalesce(string_agg(r.issue, ',') FILTER (WHERE r.central), '') FROM ticket_references(t.content, t.metadata) r) AS central,
             ticket_references_settled(t.content, t.metadata) AS settled_keys
        FROM thoughts t LEFT JOIN node_state(NULL) s ON s.thought_id = t.id`;
  const misses: string[] = [];
  let demoted = 0;
  const thoughts = new Map<string, { refs: Refs; lifecycle: boolean }>();
  for (const r of rows) {
    const refs = refsOf(r.content, r.metadata);
    thoughts.set(r.id, { refs, lifecycle: r.lifecycle });
    const js = transitiveDemotion(refs, statusOf, settled, "central+share-veto");
    if (r.settled_keys !== null) demoted++;
    if (r.body !== refs.body.join() || r.central !== refs.central.join() || JSON.stringify(r.settled_keys) !== JSON.stringify(js))
      misses.push(`${r.id.slice(0, 8)}: sql body ${r.body} central ${r.central} → ${JSON.stringify(r.settled_keys)}; js body ${refs.body} central ${refs.central} → ${JSON.stringify(js)}`);
  }
  console.log(`ticket_references / ticket_references_settled against refsOf / transitiveDemotion(central+share-veto): ${rows.length} thoughts, ${misses.length} differing, ${demoted} with settled keys (lifecycle-less or not)`);
  for (const m of misses.slice(0, 10)) console.log(`  ${m}`);

  const embedCfg = resolveEmbedConfig(process.env as EmbedEnv);
  const refused = egressRefusal(embedCfg.embeddings, embedCfg.egress, ["marker"]);
  if (refused) { console.error(`the embeddings endpoint is not available (${refused}); declare it local (OB1_LLM_LOCAL=1)`); process.exit(2); }
  const embedder = createEmbedder(() => embedCfg, { rememberRefusal: false });
  let rankMisses = 0;
  for (const p of PANEL) {
    const qv = `[${(await embedder.getEmbedding(p.query, { kind: "query", content: p.query }, "query")).join(",")}]`;
    const win = (await sql`
        SELECT h.id::text AS id, h.score AS fused, h.ord::int AS ord,
               coalesce(s.open = false, false) AS settled, s.superseded_by IS NOT NULL AS superseded, s.open IS NOT NULL AS lifecycle
          FROM search_thoughts_hybrid(${qv}::vector, ${p.query}::text, 0::float, ${Math.min(100, 4 * N)}::int, '{}'::jsonb, 0::float, 90::float)
               WITH ORDINALITY AS h(id, content, metadata, created_at, similarity, matched_needles, needles, needle_counts, common_needles, literal_only, score, ord)
          LEFT JOIN node_state(NULL) s ON s.thought_id = h.id
         ORDER BY h.ord`) as WindowRow[];
    const shipped = (await sql`SELECT id::text AS id, demoted FROM search_thoughts_current(${qv}::vector, ${p.query}::text, 0::float, ${N}::int, '{}'::jsonb, 0::float, 90::float)`) as { id: string; demoted: string[] | null }[];
    const oracle = rerank(win, N, (r) => { const th = thoughts.get(r.id); return th !== undefined && transitiveDemotion(th.refs, statusOf, settled, "central+share-veto") !== null; });
    const same = shipped.map((x) => x.id).join() === oracle.map((x) => x.id).join()
      && shipped.every((x, i) => (x.demoted !== null) === oracle[i].demoted && (x.demoted ?? []).some((d) => d.startsWith("references settled work (")) === oracle[i].transitive);
    if (!same) rankMisses++;
    console.log(`  ${p.name}: search_thoughts_current ${same ? "=" : "≠"} the oracle's central+share-veto top ${N}${same ? "" : `\n    shipped ${shipped.map((x) => x.id.slice(0, 8)).join(" ")}\n    oracle  ${oracle.map((x) => x.id.slice(0, 8)).join(" ")}`}`);
  }
  await sql.end();
  console.log(misses.length === 0 && rankMisses === 0 ? "sql-check: OK" : `sql-check: ${misses.length} thought(s) and ${rankMisses} quer${rankMisses === 1 ? "y" : "ies"} differ`);
  if (misses.length || rankMisses) process.exit(1);
}

// ── The self-check ───────────────────────────────────────────────────────────

function selfCheck() {
  let failed = 0;
  const ok = (cond: boolean, what: string) => { console.log(`${cond ? "ok  " : "FAIL"} ${what}`); if (!cond) failed++; };
  const throws = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
  const settled = new Set(["completed", "canceled"]);
  const heads: Record<string, string> = { "SMD-1": "completed", "SMD-2": "canceled", "SMD-3": "started", "SMD-4": "completed", "SMD-5": "backlog", "SMD-6": "completed" };
  const st: StatusOf = (k) => heads[k];

  const r = refsOf("Session summary — SMD-1 — claude-code — x\nsee SMD-3 and UTF-8, SMD-4x, xSMD-5, SMD-4. Again SMD-3; not a header: Session summary — SMD-6 —", { topics: ["SMD-2", "ob1", "SMD-2"], action_items: ["Start SMD-3", 7] });
  ok(r.central.join() === "SMD-1,SMD-2,SMD-3" && r.centralTopics.join() === "SMD-2,SMD-3", "central = topics + action items + the header's key, each once (SMD-2 twice in topics, a number skipped); centralTopics leaves the header out");
  ok(r.body.join() === "SMD-1,SMD-3,SMD-4,SMD-6,UTF-8", "body keys are whole words (SMD-4x and xSMD-5 are not keys; SMD-4. is), each once (SMD-3 twice), sorted; UTF-8 is key-shaped and dropped later by having no head");
  ok(refsOf("x\nSession summary — SMD-6 — later line", {}).central.length === 0, "the header key is read only at the start of the text");
  ok(refsOf("no keys here", null).central.length === 0 && refsOf("Session summary — claude-code — OB1 (main)", {}).central.length === 0, "no metadata and a header with no key give no central reference");

  const ref = (central: string[], body: string[] = central, centralTopics: string[] = central): Refs => ({ central, centralTopics, body });
  ok(transitiveDemotion(ref(["SMD-1", "SMD-2"]), st, settled, "central")?.join() === "SMD-1,SMD-2", "central: every known central reference settled demotes, naming the deciding keys");
  ok(transitiveDemotion(ref(["SMD-1", "SMD-3"]), st, settled, "central") === null, "central: one open central reference keeps the thought current (reflexive freshness unaffected)");
  ok(transitiveDemotion(ref(["SMD-1", "SMD-99"]), st, settled, "central")?.join() === "SMD-1", "an unknown key is no claim either way: ignored, as 059 ignores an unknown status");
  ok(transitiveDemotion(ref(["SMD-99"], ["SMD-1", "SMD-2", "SMD-4"]), st, settled, "central") === null, "central: with no KNOWN central reference, body mentions decide nothing");
  ok(transitiveDemotion(ref([], ["SMD-1", "SMD-2", "SMD-3"]), st, settled, "central+share")?.join() === "SMD-1,SMD-2", "central+share: no central reference, 2 of 3 known body keys settled (≥ 2/3, ≥ 3 known) demotes");
  ok(transitiveDemotion(ref([], ["SMD-1", "SMD-2", "SMD-3", "SMD-5"]), st, settled, "central+share") === null, "central+share: 2 of 4 settled is under 2/3");
  ok(transitiveDemotion(ref([], ["SMD-1", "SMD-2"]), st, settled, "central+share") === null, "central+share: fewer than SHARE_MIN known body keys does not demote");
  ok(transitiveDemotion(ref([], ["SMD-1", "SMD-3", "SMD-5"]), st, settled, "central+share") === null, "central+share: 1 of 3 settled is under the share");
  ok(transitiveDemotion(ref(["SMD-3"], ["SMD-1", "SMD-2", "SMD-4", "SMD-3"]), st, settled, "central+share") === null, "central+share: a known central reference that is open wins over a settled body majority");
  ok(transitiveDemotion(ref([], ["SMD-1"]), st, settled, "share")?.join() === "SMD-1" && transitiveDemotion(ref(["SMD-1"]), st, settled, "none") === null, "share reads one known key; none never demotes");
  ok(transitiveDemotion(ref(["SMD-1", "SMD-3"], ["SMD-1", "SMD-3"], ["SMD-1"]), st, settled, "central-topics")?.join() === "SMD-1", "central-topics reads the topics and action items alone");
  ok(transitiveDemotion(ref(["SMD-1"], ["SMD-1", "SMD-5"]), st, settled, "central") !== null && transitiveDemotion(ref(["SMD-1"], ["SMD-1", "SMD-5"]), st, settled, "central-veto") === null, "the open veto: a settled central reference with an open ticket anywhere in the text demotes under central, not under central-veto");
  ok(transitiveDemotion(ref(["SMD-1"], ["SMD-1", "SMD-2", "SMD-99"]), st, settled, "central-veto")?.join() === "SMD-1", "central-veto: an unknown body key does not veto");
  ok(transitiveDemotion(ref(["SMD-1", "SMD-3"], ["SMD-1"]), st, settled, "central-veto") === null, "central-veto: an open central key absent from the text still keeps it current");
  ok(transitiveDemotion(ref([], ["SMD-1", "SMD-2", "SMD-4"]), st, settled, "central+share-veto")?.join() === "SMD-1,SMD-2,SMD-4" && transitiveDemotion(ref([], ["SMD-1", "SMD-2", "SMD-4"]), st, settled, "central-veto") === null, "central+share-veto: no central reference, three known body keys all settled demotes; central-veto never reads the body alone");
  ok(transitiveDemotion(ref([], ["SMD-1", "SMD-2"]), st, settled, "central+share-veto") === null && transitiveDemotion(ref([], ["SMD-1", "SMD-2", "SMD-4", "SMD-3"]), st, settled, "central+share-veto") === null, "central+share-veto: under SHARE_MIN known keys, or one open among them, does not demote");

  // The re-sort. Rows listed out of their hybrid order, so the order is the
  // sort's, not the input's.
  const row = (id: string, fused: number, ord: number, o: Partial<WindowRow> = {}): WindowRow => ({ id, fused, ord, settled: false, superseded: false, lifecycle: false, ...o });
  const win: WindowRow[] = [
    row("e", 0.5, 4, { superseded: true }),
    row("c", 0.2, 3, { lifecycle: true }),
    row("a", 0.6, 1),
    row("b", 0.55, 2, { settled: true, lifecycle: true }),
    row("d", 0.125, 5),
  ];
  const ids = (x: { id: string }[]) => x.map((y) => y.id).join("");
  ok(ids(rerank(win, 5, () => false)) === "acbde", "none: 059's re-sort — a settled (b, 0.55 → 0.1375) and a superseded row (e, 0.5 → 0.125) fall below the current c (0.2); at an equal score the current d (0.125) comes before the superseded e, though e's hybrid rank is higher");
  ok(ids(rerank(win, 5, (r) => r.id === "a")) === "cabde", "a transitive demotion weighs 0.25 like the reflexive one (a: 0.6 → 0.15) and sorts among the demoted by score, then current-first, then the hybrid's order");
  ok(ids(rerank(win, 5, () => true)) === "cabed" && rerank(win, 5, () => true).filter((x) => x.transitive).map((x) => x.id).sort().join("") === "ade", "the transitive rule is never read for a row with a lifecycle (c stays current; b is demoted reflexively, not transitively); a superseded row can be both, weighted once (e stays 0.125)");
  ok(ids(rerank([row("y", 0.3, 2), row("x", 0.3, 1)], 2, () => false)) === "xy", "equal scores, both current: the hybrid's order, whatever order the rows arrive in");
  ok(rerank(win, 2, () => false).length === 2, "cut to n");
  ok(transitiveRows(win, () => true).join("") === "ad", "(b)'s rows: what the rule demotes that prefer_current does not — the superseded e and the lifecycle rows excepted");
  const deep = [...Array.from({ length: 12 }, (_, i) => row(`k${i}`, 0.5 - i * 0.01, i + 1)), row("cur", 0.455, 13)];
  ok(rerank(deep, 10, () => false).some((x) => x.id === "cur") && !rerank(deep, 10, (r) => r.id === "cur").some((x) => x.id === "cur") && transitiveRows(deep, (r) => r.id === "cur").includes("cur"),
    "(b) sees a row the rule demotes OUT of the top 10 (sixth under none, gone under the rule) — the case the rule's top 10 alone cannot show");

  const hit = (id: string, demoted = false): Hit => ({ id, demoted, transitive: demoted });
  ok(flips([hit("m"), hit("x")], [hit("x")], "m") === "yes" && flips([hit("m")], [hit("m", true)], "m") === "yes" && flips([hit("m")], [hit("m")], "m") === "no" && flips([hit("x")], [hit("x")], "m") === "n/a", "(a): out of the top 10 or demoted is a flip; kept undemoted is not; absent from the baseline is n/a, never yes");
  ok(noWorse([hit("x"), hit("p")], [hit("p")], "p") === "yes" && noWorse([hit("p")], [hit("x"), hit("p")], "p") === "no" && noWorse([hit("p")], [hit("x")], "p") === "no" && noWorse([hit("x")], [hit("x")], "p") === "n/a", "(c): no worse a rank is yes, lower or gone is no, absent from the baseline is n/a");
  const sc: Record<string, number> = { "central-veto": 11, "central+share-veto": 9 };
  const s = (x: Rule) => sc[x];
  ok(pick(["central-veto", "central+share-veto"], (x) => ({ "central-veto": 10, "central+share-veto": 9 } as Record<string, number>)[x], ["central-veto"]) === "central-veto", "pick: a wide rule only 1 fewer stale hit does not displace the narrow one");
  ok(pick(["central-veto", "central+share-veto"], s, ["central-veto"]) === "central+share-veto", "pick: a wide rule with 2 fewer stale hits wins over the narrow one");
  ok(pick(["central+share-veto"], s, ["central-veto"]) === "central+share-veto" && pick([], s, ["central-veto"]) === null, "pick: a wide rule wins alone; no qualifier is no pick");

  const ka = kappa({ x: "stale", y: "current", z: "neutral", w: "stale" }, { x: "stale", y: "current", z: "stale", w: "stale" });
  ok(ka.n === 4 && ka.raw === 0.75 && Math.abs(ka.kappa - (0.75 - 0.4375) / (1 - 0.4375)) < 1e-12, "kappa: observed 3/4, expected 7/16 (a: 2 stale, 1 current, 1 neutral; b: 3 stale, 1 current)");
  ok(kappa({ x: "stale" }, { x: "stale" }).kappa === 1 && kappa({}, {}).n === 0 && kappa({}, {}).kappa === 0, "kappa: one shared label agrees fully; no shared id is no measurement (0, not NaN)");

  const U = "10000000-0000-4000-8000-000000000001";
  ok(decodeLabels("x", { [U]: 1 })[U] === "current" && throws(() => decodeLabels("x", { [U]: 3 })) && throws(() => decodeLabels("x", { [U]: "1" })) && throws(() => decodeLabels("x", { "not-a-uuid": 0 })) && throws(() => decodeLabels("x", null)) && throws(() => decodeLabels("x", { [U]: 0.5 })),
    "decodeLabels: an index into [stale, current, neutral]; a label off the set, a string, a non-uuid id, a null map or a fraction is refused");
  ok(throws(() => readLabels(join(HERE, "fixtures", "no-such-labels.json"))), "readLabels refuses a missing fixture");

  const l = readLabels();
  ok(l.labels[MEASURED] === "stale" && l.labels[PLAN] === "current", "the gold means what it says: the SMD-2074 recommendation decodes stale, the live release plan current");
  ok(l.rounds.length >= 1, `the committed labels parse (${Object.keys(l.labels).length} in ${l.rounds.length} rounds)`);
  for (const [i, rd] of l.rounds.entries()) {
    const g = rd.graders, rids = Object.keys(g.a);
    ok(rids.length === Object.keys(g.b).length && rids.every((id) => g.b[id] !== undefined && l.labels[id] !== undefined), `round ${i + 1}: both graders labelled the same ${rids.length} ids, each carrying a committed label`);
    ok(rids.every((id) => l.labels[id] === g.a[id] || l.labels[id] === g.b[id]), `round ${i + 1}: every adjudicated label is one grader's — adjudication picks, it does not invent`);
    const k = kappa(g.a, g.b);
    ok(Math.abs(rd.agreement.raw - k.raw) < 1e-9 && Math.abs(rd.agreement.kappa - k.kappa) < 1e-9 && rd.agreement.adjudicated === rids.filter((id) => g.a[id] !== g.b[id]).length,
      `round ${i + 1}: the recorded agreement is the graders' own (raw ${k.raw.toFixed(3)}, kappa ${k.kappa.toFixed(3)}, ${rd.agreement.adjudicated} adjudicated)`);
  }
  const graded = l.rounds.flatMap((rd) => Object.keys(rd.graders.a));
  ok(new Set(graded).size === graded.length && graded.length === Object.keys(l.labels).length, "every committed label was graded in exactly one round");
  ok(PANEL.filter((p) => p.kind === "planning").length === 4 && PANEL.filter((p) => p.kind === "heldout").length === 4 && PANEL.some((p) => p.name === "C1") && PANEL.some((p) => p.name === "P1"), "the panel holds the four planning queries, the four held out, the measured P1 and the C1 control");
  ok([...FIRST.rules, ...SECOND.rules, "none"].length === RULES.length && RULES.every((x) => x === "none" || FIRST.rules.includes(x) !== SECOND.rules.includes(x)), "every rule but none belongs to exactly one registration");
  ok(FIRST.bOver.join() === "planning,control" && SECOND.bOver.join() === "planning,heldout,control" && FIRST.withC && !SECOND.withC, "each registration's (b) reads the windows it registered, and (c) belongs to the first alone");

  if (failed) { console.error(`self-check: ${failed} FAILED`); process.exit(1); }
  console.log("self-check: OK");
}

// ── Main ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  if (process.argv.includes("--self-check")) selfCheck();
  else {
    let dump: string | undefined;
    const i = process.argv.indexOf("--dump-unlabelled");
    if (i > 0) {
      dump = process.argv[i + 1];
      if (dump === undefined || dump.startsWith("--")) { console.error("--dump-unlabelled needs a file path (outside the repo)"); process.exit(2); }
    }
    const url = process.env.DATABASE_URL;
    if (!url) { console.error("DATABASE_URL required (built inside the container from $POSTGRES_PASSWORD) — or --self-check"); process.exit(2); }
    if (process.argv.includes("--sql-check")) await sqlCheck(url);
    else await measure(url, dump);
  }
}
