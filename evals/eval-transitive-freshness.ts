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
 * The gold. The planning queries' top-10 hits under every rule, labelled by
 * reading each one (evals/fixtures/transitive-freshness-labels.json: ids and
 * labels only, never text): `stale` — what it puts forward as work to do, or
 * as the state of things, is finished; `current` — something it puts forward is
 * still open, or it states something still true that a planner needs (an open
 * ticket row, the live release plan); `neutral` — neither (a log of a past
 * session that recommends nothing). Labelled once, before the rules' numbers
 * were read against them.
 *
 * PRE-REGISTERED decision (written before the first measured run):
 *   1. A rule QUALIFIES only if
 *      (a) the measured case flips: on P1 the SMD-2074 recommendation
 *          (20f6454c) leaves the top 10 or is marked demoted;
 *      (b) it demotes no hit labelled `current` anywhere in a planning or
 *          control query's window (a current hit pushed out of the top 10
 *          included);
 *      (c) the release-plan control (C1) ranks its plan (7eedad78) no worse
 *          than prefer_current as shipped does — AMENDED after the first run:
 *          as written, "keeps its plan first", it failed every rule and the
 *          control alike, because shipped prefer_current ranks the plan second
 *          (7f99233c, labelled current, is first); the premise came from a
 *          search without prefer_current. Every rule kept the plan second, so
 *          the amendment decides nothing between them;
 *      (d) drop-the-mechanism: with every ticket head read as open, its
 *          ranking is prefer_current's exactly, on every query.
 *   2. Among qualifying rules, the one with the fewest `stale` hits in the
 *      planning top 10s (P1–P4 summed) wins; central+share or share is chosen
 *      over central only if it removes at least 2 more stale hits, since each
 *      demotes knowledge notes central does not (the census states how many).
 *   3. If none qualifies, the ticket's rank arm does not ship as specified; the
 *      verdict says which condition failed.
 *
 *   RESULT of the first registration (2026-10-02): NO rule qualifies. Each
 *   demotes a hit both graders call current, on (b): the central rules SMD-1846's
 *   session summary (3c346ae2; its own ticket is Done, but it puts forward the
 *   open SMD-2306/2307 in its body), the share rules also the roadmap summary
 *   (dc8d9130, which names the open programs SMD-1729/1795) and the release
 *   digest (008b4199, the open SMD-1805/1806). Every miss names an open ticket.
 *
 * SECOND registration (written after the first verdict, before these rules
 * were run; decided on held-out queries, since a rule shaped by P1–P4's misses
 * cannot be judged on P1–P4):
 *     central-veto       — central, and the thought names NO open ticket
 *                          anywhere in its text (the open veto);
 *     central+share-veto — central-veto; and with no known central reference,
 *                          ≥ SHARE_MIN known body references, every one settled.
 *   The held-out queries H1–H4 are new planning phrasings, their hits labelled
 *   by two fresh graders under the same rubric. A rule QUALIFIES on (a) and (d)
 *   as above and (b) over every planning, held-out and control window; the one
 *   with the fewer `stale` hits in H1–H4's top 10s wins, central+share-veto over
 *   central-veto only if it removes at least 2 more. If neither qualifies, the
 *   rank arm does not ship.
 *
 *   RESULT of the second registration (2026-10-02): both qualify, and
 *   central+share-veto wins — H1–H4 stale@10 17 → 8 (central-veto 11), no
 *   current hit demoted in any window. evals/README.md has the tables.
 *
 * The census (the ticket's salience bound, Work item 4): per rule, how many
 * thoughts it moves, split session summaries / other; and each settled
 * ticket's fan-out — how many thoughts it alone decides — with the most
 * referenced keys and how many of their PASSING (body-only) mentions a rule
 * demotes.
 *
 * Read-only against the live brain (the session is READ ONLY), from a one-off
 * container on its network; DATABASE_URL is built inside it from
 * $POSTGRES_PASSWORD (never on argv). The query is embedded with the brain's own
 * model through the egress gate, as db/tier.ts's replay does.
 *
 *   podman run --rm --network open-brain_default --env-file deploy/.env \
 *     -e OB1_LLM_LOCAL=1 -e OB1_LLM_BASE_URL=http://host.containers.internal:11434/v1 \
 *     -e OB1_EMBEDDING_MODEL=qwen3-embedding:4b \
 *     -v <worktree>:/repo -w /repo oven/bun:1.4.0-alpine \
 *     sh -c 'export DATABASE_URL="postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/openbrain"; bun evals/eval-transitive-freshness.ts'
 *
 *   … eval-transitive-freshness.ts --dump-unlabelled <file>   the panel hits the
 *        labels lack, with their text, to label from (write it outside the repo)
 *   bun eval-transitive-freshness.ts --self-check             the rules and the
 *        oracle; no database
 */

import { SQL } from "bun";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEmbedder, resolveEmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { egressRefusal } from "../db/worker-bootstrap.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LABELS_PATH = join(HERE, "fixtures", "transitive-freshness-labels.json");

// ── The rules (pure) ─────────────────────────────────────────────────────────

/** A ticket key: Linear's TEAM-123 shape, whole-word. */
const KEY_RE = /\b([A-Z][A-Z0-9]+-[0-9]+)\b/g;
/** The session hook's header: `Session summary — SMD-1234 — claude-code — …` names the branch's ticket. */
const HEADER_RE = /^Session summary — ([A-Z][A-Z0-9]+-[0-9]+) —/;

export const SHARE_MIN = 3;
/** The settled share the share rules need, as a fraction compared in integers (2/3 × 3 is not exactly 2 in every float order). */
export const SHARE = { num: 2, den: 3 } as const;
/** search_demote_weight() (059): what a demoted row's fused score is multiplied by. */
export const DEMOTE_WEIGHT = 0.25;

export const RULES = ["none", "central", "central-topics", "central+share", "share", "central-veto", "central+share-veto"] as const;
/** The first registration's rules (P1–P4 decide among them). */
const FIRST: readonly Rule[] = ["central", "central-topics", "central+share", "share"];
/** The second registration's rules, written after the first verdict (H1–H4 decide between them). */
const SECOND: readonly Rule[] = ["central-veto", "central+share-veto"];
export type Rule = (typeof RULES)[number];

export type Refs = { central: string[]; centralTopics: string[]; body: string[] };

function keysIn(text: string): string[] {
  return [...new Set([...text.matchAll(KEY_RE)].map((m) => m[1]))].sort();
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** A thought's ticket references: central (topics, action items, the summary header's key) and body (every key in its text). */
export function refsOf(content: string, metadata: Record<string, unknown> | null): Refs {
  const m = metadata ?? {};
  const centralTopics = keysIn([...strings(m.topics), ...strings(m.action_items)].join("\n"));
  const header = HEADER_RE.exec(content)?.[1];
  const central = [...new Set([...centralTopics, ...(header ? [header] : [])])].sort();
  return { central, centralTopics, body: keysIn(content) };
}

/** The status a key's ticket head carries, or undefined when the brain holds no head or the status is not a known lifecycle type. */
export type StatusOf = (key: string) => string | undefined;

/**
 * Whether `rule` demotes a lifecycle-less thought with these references, and
 * the settled keys that decide it (sorted); null when it does not. The caller
 * applies it only where node_state's open IS NULL.
 */
export function transitiveDemotion(refs: Refs, statusOf: StatusOf, settled: ReadonlySet<string>, rule: Rule): string[] | null {
  if (rule === "none") return null;
  const known = (keys: string[]) => keys.filter((k) => statusOf(k) !== undefined);
  const allSettled = (keys: string[]) => keys.length > 0 && keys.every((k) => settled.has(statusOf(k)!));
  const share = (keys: string[], min: number) => {
    const s = keys.filter((k) => settled.has(statusOf(k)!));
    return keys.length >= min && s.length * SHARE.den >= SHARE.num * keys.length ? s : null;
  };
  if (rule === "share") return share(known(refs.body), 1);
  const central = known(rule === "central-topics" ? refs.centralTopics : refs.central);
  const body = known(refs.body);
  if (rule === "central-veto" || rule === "central+share-veto") {
    // The open veto: a thought naming ANY open ticket, anywhere in its text, is
    // never demoted — what it puts forward may be that ticket.
    if (body.some((k) => !settled.has(statusOf(k)!))) return null;
    if (central.length > 0) return allSettled(central) ? central : null;
    return rule === "central+share-veto" && body.length >= SHARE_MIN ? body : null;
  }
  if (central.length > 0) return allSettled(central) ? central : null;
  return rule === "central+share" ? share(body, SHARE_MIN) : null;
}

/** One row of the hybrid's window, with what node_state says of it. */
export type WindowRow = { id: string; fused: number; ord: number; settled: boolean; superseded: boolean; lifecycle: boolean };

/**
 * 059's re-sort, with a transitive demotion beside the reflexive one: a row is
 * demoted when settled, superseded or `transitive(row)` says so; its score is
 * fused × DEMOTE_WEIGHT once; ties to the current row, then the hybrid's order;
 * cut to n. `transitive` is consulted only for a row with no lifecycle.
 */
export function rerank(win: WindowRow[], n: number, transitive: (r: WindowRow) => boolean): { id: string; demoted: boolean; transitive: boolean }[] {
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

// ── The panel ────────────────────────────────────────────────────────────────

type PanelQuery = { name: string; query: string; kind: "planning" | "heldout" | "control" | "topical" };

/** The planning queries the ticket and its comments measured, the release-plan control, and three topical queries whose cost is displacement. */
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
 * The gold: per labelling round, two graders' labels, given the rubric and the
 * tickets' statuses and nothing of the rules, and `labels`, the adjudicated
 * label of every id (where a round's graders disagreed, one of theirs). Each
 * round's `agreement` is what kappa() computes from its two, held by the
 * self-check. Round 1 graded the first registration's top 10s, round 2 what
 * the second registration's queries and rules added — fresh graders each time.
 */
type Round = { generated: string; graders: { a: Record<string, Label>; b: Record<string, Label> }; agreement: { raw: number; kappa: number; adjudicated: number } };
type Labels = { version: 1; labels: Record<string, Label>; rounds?: Round[] };

/**
 * The file stores ids and numbers only (check 9: a committed fixture carries no
 * free string but under generated / origin / note / query): a label is its index
 * in LABEL_SET. Decoded here, every label checked.
 */
function decodeLabels(path: string, m: Record<string, unknown>): Record<string, Label> {
  const out: Record<string, Label> = {};
  for (const [id, v] of Object.entries(m)) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) || typeof v !== "number" || LABEL_SET[v] === undefined) throw new Error(`${path}: bad entry ${id}: ${String(v)}`);
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

function readLabels(path = LABELS_PATH): Labels {
  if (!existsSync(path)) return { version: 1, labels: {} };
  const raw = JSON.parse(readFileSync(path, "utf8")) as { version: number; labels: Record<string, unknown>; rounds?: (Omit<Round, "graders"> & { graders: { a: Record<string, unknown>; b: Record<string, unknown> } })[] };
  if (raw.version !== 1 || typeof raw.labels !== "object") throw new Error(`${path}: not a version-1 labels file`);
  return {
    version: 1,
    labels: decodeLabels(path, raw.labels),
    rounds: raw.rounds?.map((r) => ({ ...r, graders: { a: decodeLabels(path, r.graders.a), b: decodeLabels(path, r.graders.b) } })),
  };
}

// ── The measurement ──────────────────────────────────────────────────────────

type Thought = { id: string; content: string; metadata: Record<string, unknown> | null; lifecycle: boolean; refs: Refs; summary: boolean };

async function measure(url: string, dumpPath: string | undefined) {
  const sql = new SQL({ url, max: 1 });
  await sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`;

  const [types] = await sql`SELECT node_lifecycle_types() AS known, node_settled_types() AS settled`;
  const known = new Set<string>(types.known), settled = new Set<string>(types.settled);
  const heads = new Map<string, string>();
  for (const h of await sql`SELECT issue, status_type FROM ob1_ticket_head`) if (known.has(h.status_type)) heads.set(h.issue, h.status_type);
  const statusOf: StatusOf = (k) => heads.get(k);
  const openStatus: StatusOf = (k) => (heads.has(k) ? "started" : undefined); // drop-the-mechanism: every head read as open

  const thoughts = new Map<string, Thought>();
  for (const t of await sql`
      SELECT t.id::text AS id, t.content, t.metadata, s.open IS NOT NULL AS lifecycle
        FROM thoughts t LEFT JOIN node_state(NULL) s ON s.thought_id = t.id`) {
    thoughts.set(t.id, { id: t.id, content: t.content, metadata: t.metadata, lifecycle: t.lifecycle, refs: refsOf(t.content, t.metadata), summary: t.content.startsWith("Session summary") });
  }
  const free = [...thoughts.values()].filter((t) => !t.lifecycle);

  // ── The census ──
  console.log(`\n# Transitive freshness (SMD-2271) — ${thoughts.size} thoughts, ${free.length} with no lifecycle of their own (${free.filter((t) => t.summary).length} session summaries); ${heads.size} ticket heads with a known status, ${[...heads.values()].filter((s) => settled.has(s)).length} settled\n`);
  console.log("## Census: what each rule moves\n");
  console.log("| rule | thoughts demoted | session summaries | other | max fan-out of one settled key | p50 | p90 |");
  console.log("|---|---:|---:|---:|---:|---:|---:|");
  const deciders = new Map<Rule, Map<string, number>>();
  for (const rule of RULES.filter((r) => r !== "none")) {
    const moved = free.map((t) => ({ t, by: transitiveDemotion(t.refs, statusOf, settled, rule) })).filter((x) => x.by !== null);
    // A key's fan-out: the demoted thoughts it helps decide (every settled key the rule read).
    const fan = new Map<string, number>();
    for (const x of moved) for (const k of x.by!) fan.set(k, (fan.get(k) ?? 0) + 1);
    deciders.set(rule, fan);
    const f = [...fan.values()].sort((a, b) => a - b);
    const pct = (p: number) => (f.length ? f[Math.min(f.length - 1, Math.floor(p * f.length))] : 0);
    console.log(`| ${rule} | ${moved.length} | ${moved.filter((x) => x.t.summary).length} | ${moved.filter((x) => !x.t.summary).length} | ${f.at(-1) ?? 0} | ${pct(0.5)} | ${pct(0.9)} |`);
  }

  // The hubs: the most-mentioned keys, and how many PASSING (body-only) mentions each rule demotes.
  const bodyCount = new Map<string, number>();
  for (const t of free) for (const k of t.refs.body) if (heads.has(k)) bodyCount.set(k, (bodyCount.get(k) ?? 0) + 1);
  const hubs = [...bodyCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log("\n## The salience bound: the most-mentioned keys\n");
  console.log(`| key | status | thoughts mentioning it | of which only in passing | passing mentions that decide a demotion: ${RULES.filter((r) => r !== "none").join(" / ")} |`);
  console.log("|---|---|---:|---:|---|");
  for (const [k, c] of hubs) {
    const passing = free.filter((t) => t.refs.body.includes(k) && !t.refs.central.includes(k));
    // Demoted BECAUSE of the key: it is among the settled keys that decided the
    // demotion. A thought demoted by its own central keys that also names this
    // one in passing is not counted — the passing mention changed nothing.
    const dem = RULES.filter((r) => r !== "none").map((r) => passing.filter((t) => transitiveDemotion(t.refs, statusOf, settled, r)?.includes(k) === true).length);
    console.log(`| ${k} | ${heads.get(k)} | ${c} | ${passing.length} | ${dem.join(" / ")} |`);
  }

  // ── The panel ──
  const embedCfg = resolveEmbedConfig(process.env as EmbedEnv);
  const refused = egressRefusal(embedCfg.embeddings, embedCfg.egress, ["marker"]);
  if (refused) { console.error(`the embeddings endpoint is not available (${refused}); declare it local (OB1_LLM_LOCAL=1)`); process.exit(2); }
  const embedder = createEmbedder(() => embedCfg, { rememberRefusal: false });

  const labels = readLabels().labels;
  const unlabelled = new Set<string>();
  const results: Record<string, Record<Rule, { id: string; demoted: boolean; transitive: boolean }[]>> = {};
  // Every window row a rule demotes transitively, per query: (b) reads these,
  // not the rule's top 10 — a current hit demoted OUT of the top 10 is the
  // case (b) exists to catch.
  const demotedIn: Record<string, Record<Rule, Set<string>>> = {};
  let fidelity = true, dropped = true;
  for (const p of PANEL) {
    const qv = `[${(await embedder.getEmbedding(p.query, { kind: "query", content: p.query }, "query")).join(",")}]`;
    const w = Math.min(100, 4 * N);
    const win = (await sql`
        SELECT h.id::text AS id, h.score AS fused, h.ord::int AS ord,
               coalesce(s.open = false, false) AS settled, s.superseded_by IS NOT NULL AS superseded, s.open IS NOT NULL AS lifecycle
          FROM search_thoughts_hybrid(${qv}::vector, ${p.query}::text, 0::float, ${w}::int, '{}'::jsonb, 0::float, 90::float)
               WITH ORDINALITY AS h(id, content, metadata, created_at, similarity, matched_needles, needles, needle_counts, common_needles, literal_only, score, ord)
          LEFT JOIN node_state(NULL) s ON s.thought_id = h.id`) as WindowRow[];
    const shipped = (await sql`
        SELECT id::text AS id FROM search_thoughts_current(${qv}::vector, ${p.query}::text, 0::float, ${N}::int, '{}'::jsonb, 0::float, 90::float)`).map((r: { id: string }) => r.id);
    results[p.name] = {} as Record<Rule, { id: string; demoted: boolean; transitive: boolean }[]>;
    demotedIn[p.name] = {} as Record<Rule, Set<string>>;
    for (const rule of RULES) {
      const t = (r: WindowRow) => { const th = thoughts.get(r.id); return th !== undefined && transitiveDemotion(th.refs, statusOf, settled, rule) !== null; };
      results[p.name][rule] = rerank(win, N, t);
      demotedIn[p.name][rule] = new Set(rerank(win, win.length, t).filter((x) => x.transitive).map((x) => x.id));
      const control = rerank(win, N, (r) => { const th = thoughts.get(r.id); return th !== undefined && transitiveDemotion(th.refs, openStatus, settled, rule) !== null; });
      if (control.map((x) => x.id).join() !== results[p.name].none.map((x) => x.id).join()) dropped = false;
      for (const x of results[p.name][rule]) if (p.kind !== "topical" && labels[x.id] === undefined) unlabelled.add(x.id);
    }
    if (shipped.join() !== results[p.name].none.map((x) => x.id).join()) {
      fidelity = false;
      console.error(`oracle ≠ search_thoughts_current on ${p.name}:\n  shipped ${shipped.join(" ")}\n  oracle  ${results[p.name].none.map((x) => x.id).join(" ")}`);
    }
  }
  console.log(`\nThe oracle's "none" equals search_thoughts_current's top ${N} on every panel query: ${fidelity ? "yes" : "NO — the measurement below is not prefer_current's"}`);
  console.log(`Drop-the-mechanism (every ticket head read as open) gives "none" exactly, every rule, every query: ${dropped ? "yes" : "NO"}`);

  if (dumpPath) {
    const out = [...unlabelled].map((id) => `=== ${id}\n${thoughts.get(id)?.content ?? "(not found)"}\n`).join("\n");
    writeFileSync(dumpPath, out);
    console.log(`\n${unlabelled.size} unlabelled panel hit(s) written to ${dumpPath}`);
    await sql.end();
    return;
  }
  if (unlabelled.size > 0) console.log(`\nNOTE: ${unlabelled.size} panel hit(s) carry no label (counted as unlabelled): ${[...unlabelled].map((i) => i.slice(0, 8)).join(" ")}`);

  console.log("\n## The panel: top 10 per rule (stale / current / neutral / unlabelled; ⇣ = demoted)\n");
  // stale@10 per rule over P1–P4 (planning) and H1–H4 (heldout); the current
  // hits each rule demotes anywhere in a non-topical window.
  const tally = new Map<Rule, { planning: number; heldout: number; currentDemoted: string[] }>();
  for (const rule of RULES) tally.set(rule, { planning: 0, heldout: 0, currentDemoted: [] });
  for (const p of PANEL) {
    console.log(`### ${p.name} (${p.kind}): ${p.query}\n`);
    console.log("| rule | stale | current | neutral | unl. | the top 10 |");
    console.log("|---|---:|---:|---:|---:|---|");
    for (const rule of RULES) {
      const top = results[p.name][rule];
      const c = (l: Label | undefined) => top.filter((x) => labels[x.id] === l).length;
      if (p.kind === "planning" || p.kind === "heldout") tally.get(rule)![p.kind] += c("stale");
      if (p.kind !== "topical") for (const id of demotedIn[p.name][rule]) if (labels[id] === "current") tally.get(rule)!.currentDemoted.push(`${p.name}:${id.slice(0, 8)}`);
      const cell = top.map((x) => `${x.id.slice(0, 8)}${x.demoted ? "⇣" : ""}${labels[x.id] ? labels[x.id][0] : "?"}`).join(" ");
      console.log(`| ${rule} | ${c("stale")} | ${c("current")} | ${c("neutral")} | ${top.filter((x) => labels[x.id] === undefined).length} | ${cell} |`);
    }
    if (p.kind === "topical") {
      const base = results[p.name].none.map((x) => x.id);
      console.log(`\nDisplaced from the top 10 vs none: ${RULES.filter((r) => r !== "none").map((r) => `${r} ${base.filter((id) => !results[p.name][r].some((x) => x.id === id)).length}`).join(", ")}`);
    }
    console.log("");
  }

  // ── The verdicts ──
  const qualifies = (rule: Rule) => {
    const p1 = results.P1[rule];
    const a = !p1.some((x) => x.id === MEASURED) || p1.some((x) => x.id === MEASURED && x.demoted);
    const b = tally.get(rule)!.currentDemoted.length === 0;
    const rankIn = (r: Rule) => { const i = results.C1[r].findIndex((x) => x.id === PLAN); return i < 0 ? Infinity : i; };
    const c = rankIn(rule) <= rankIn("none");
    return { a, b, c, q: a && b && c && dropped && fidelity };
  };
  /** One registration's table and verdict: `rules` judged on stale@10 over `on`; `wide` wins over the narrowest qualifier only by 2 or more. */
  const verdict = (title: string, rules: readonly Rule[], on: "planning" | "heldout", narrowRules: readonly Rule[]) => {
    console.log(`## ${title}\n`);
    console.log(`| rule | (a) measured case flips | (b) no current hit demoted | (c) plan ranks no worse | (d) drop-the-mechanism | ${on} stale@10 | qualifies |`);
    console.log("|---|---|---|---|---|---:|---|");
    const ok: Rule[] = [];
    for (const rule of rules) {
      const v = qualifies(rule);
      if (v.q) ok.push(rule);
      console.log(`| ${rule} | ${v.a ? "yes" : "no"} | ${v.b ? "yes" : `no (${tally.get(rule)!.currentDemoted.join(", ")})`} | ${v.c ? "yes" : "no"} | ${dropped ? "yes" : "no"} | ${tally.get(rule)![on]} | ${v.q ? "yes" : "no"} |`);
    }
    console.log(`\nprefer_current as shipped (none): ${on} stale@10 = ${tally.get("none")![on]}`);
    if (unlabelled.size > 0) { console.log("\nVERDICT withheld: label the unlabelled hits first (--dump-unlabelled).\n"); return; }
    if (ok.length === 0) { console.log("\nVERDICT: no rule qualifies — the rank arm does not ship as registered (see the failed column).\n"); return; }
    const best = (rs: Rule[]) => rs.reduce((x, y) => (tally.get(y)![on] < tally.get(x)![on] ? y : x));
    const narrow = ok.filter((r) => narrowRules.includes(r)), wide = ok.filter((r) => !narrowRules.includes(r));
    let pick = narrow.length ? best(narrow) : best(wide);
    if (narrow.length && wide.length && tally.get(best(wide))![on] <= tally.get(pick)![on] - 2) pick = best(wide);
    console.log(`\nVERDICT: ${pick} — ${on} stale@10 ${tally.get("none")![on]} → ${tally.get(pick)![on]}.\n`);
  };
  verdict("The first registration (P1–P4)", FIRST, "planning", ["central", "central-topics"]);
  verdict("The second registration (H1–H4, held out)", SECOND, "heldout", ["central-veto"]);
  await sql.end();
}

// ── The self-check ───────────────────────────────────────────────────────────

function selfCheck() {
  let failed = 0;
  const ok = (cond: boolean, what: string) => { console.log(`${cond ? "ok  " : "FAIL"} ${what}`); if (!cond) failed++; };
  const settled = new Set(["completed", "canceled"]);
  const heads: Record<string, string> = { "SMD-1": "completed", "SMD-2": "canceled", "SMD-3": "started", "SMD-4": "completed", "SMD-5": "backlog" };
  const st: StatusOf = (k) => heads[k];

  const r = refsOf("Session summary — SMD-1 — claude-code — x\nsee SMD-3 and UTF-8, SMD-4x, xSMD-5, SMD-4.", { topics: ["SMD-2", "ob1"], action_items: ["Start SMD-3"] });
  ok(r.central.join() === "SMD-1,SMD-2,SMD-3" && r.centralTopics.join() === "SMD-2,SMD-3", "central = topics + action items + the header's key; centralTopics leaves the header out");
  ok(r.body.join() === "SMD-1,SMD-3,SMD-4,UTF-8", "body keys are whole words (SMD-4x and xSMD-5 are not keys; SMD-4. is), deduplicated and sorted; UTF-8 is key-shaped and dropped later by having no head");
  ok(refsOf("no keys here", null).central.length === 0 && refsOf("Session summary — claude-code — OB1 (main)", {}).central.length === 0, "no metadata and a header with no key give no central reference");

  const ref = (central: string[], body: string[] = central, centralTopics: string[] = central): Refs => ({ central, centralTopics, body });
  ok(transitiveDemotion(ref(["SMD-1", "SMD-2"]), st, settled, "central")?.join() === "SMD-1,SMD-2", "central: every known central reference settled demotes, naming the deciding keys");
  ok(transitiveDemotion(ref(["SMD-1", "SMD-3"]), st, settled, "central") === null, "central: one open central reference keeps the thought current (reflexive freshness unaffected)");
  ok(transitiveDemotion(ref(["SMD-1", "SMD-99"]), st, settled, "central")?.join() === "SMD-1", "an unknown key is no claim either way: ignored, as 059 ignores an unknown status");
  ok(transitiveDemotion(ref(["SMD-99"], ["SMD-1", "SMD-2", "SMD-4"]), st, settled, "central") === null, "central: with no KNOWN central reference, body mentions decide nothing");
  ok(transitiveDemotion(ref([], ["SMD-1", "SMD-2", "SMD-3"]), st, settled, "central+share")?.join() === "SMD-1,SMD-2", "central+share: no central reference, 2 of 3 known body keys settled (≥ 2/3, ≥ 3 known) demotes");
  ok(transitiveDemotion(ref([], ["SMD-1", "SMD-2"]), st, settled, "central+share") === null, "central+share: fewer than SHARE_MIN known body keys does not demote");
  ok(transitiveDemotion(ref([], ["SMD-1", "SMD-3", "SMD-5"]), st, settled, "central+share") === null, "central+share: 1 of 3 settled is under the share");
  ok(transitiveDemotion(ref(["SMD-3"], ["SMD-1", "SMD-2", "SMD-4", "SMD-3"]), st, settled, "central+share") === null, "central+share: a known central reference that is open wins over a settled body majority");
  ok(transitiveDemotion(ref([], ["SMD-1"]), st, settled, "share")?.join() === "SMD-1" && transitiveDemotion(ref(["SMD-1"]), st, settled, "none") === null, "share reads one known key; none never demotes");
  ok(transitiveDemotion(ref(["SMD-1", "SMD-3"], ["SMD-1", "SMD-3"], ["SMD-1"]), st, settled, "central-topics")?.join() === "SMD-1", "central-topics reads the topics and action items alone");
  ok(transitiveDemotion(ref(["SMD-1"], ["SMD-1", "SMD-5"]), st, settled, "central") !== null && transitiveDemotion(ref(["SMD-1"], ["SMD-1", "SMD-5"]), st, settled, "central-veto") === null, "the open veto: a settled central reference with an open ticket anywhere in the text demotes under central, not under central-veto");
  ok(transitiveDemotion(ref(["SMD-1"], ["SMD-1", "SMD-2", "SMD-99"]), st, settled, "central-veto")?.join() === "SMD-1", "central-veto: an unknown body key does not veto");
  ok(transitiveDemotion(ref([], ["SMD-1", "SMD-2", "SMD-4"]), st, settled, "central+share-veto")?.join() === "SMD-1,SMD-2,SMD-4" && transitiveDemotion(ref([], ["SMD-1", "SMD-2", "SMD-4"]), st, settled, "central-veto") === null, "central+share-veto: no central reference, three known body keys all settled demotes; central-veto never reads the body alone");
  ok(transitiveDemotion(ref([], ["SMD-1", "SMD-2"]), st, settled, "central+share-veto") === null && transitiveDemotion(ref([], ["SMD-1", "SMD-2", "SMD-4", "SMD-3"]), st, settled, "central+share-veto") === null, "central+share-veto: under SHARE_MIN known keys, or one open among them, does not demote");

  const win: WindowRow[] = [
    { id: "a", fused: 0.016, ord: 1, settled: false, superseded: false, lifecycle: false },
    { id: "b", fused: 0.015, ord: 2, settled: true, superseded: false, lifecycle: true },
    { id: "c", fused: 0.014, ord: 3, settled: false, superseded: false, lifecycle: true },
    { id: "d", fused: 0.0, ord: 4, settled: false, superseded: false, lifecycle: false },
    { id: "e", fused: 0.0, ord: 5, settled: false, superseded: true, lifecycle: false },
  ];
  const ids = (x: { id: string }[]) => x.map((y) => y.id).join("");
  ok(ids(rerank(win, 5, () => false)) === "acbde", "none: 059's re-sort — a settled row weighs a quarter, and at an equal score (0) the current row comes before the superseded one");
  ok(ids(rerank(win, 5, (r) => r.id === "a")) === "cabde", "a transitive demotion weighs 0.25 like the reflexive one and sorts among the demoted by score, then the hybrid's order");
  ok(ids(rerank(win, 5, () => true)) === "cabde" && rerank(win, 5, () => true).filter((x) => x.transitive).map((x) => x.id).join("") === "ade", "the transitive rule is never read for a row with a lifecycle (c stays current; b is demoted reflexively, not transitively); a superseded row can be both");
  ok(rerank(win, 2, () => false).length === 2, "cut to n");

  const ka = kappa({ x: "stale", y: "current", z: "neutral", w: "stale" }, { x: "stale", y: "current", z: "stale", w: "stale" });
  ok(ka.n === 4 && ka.raw === 0.75 && Math.abs(ka.kappa - (0.75 - 0.4375) / (1 - 0.4375)) < 1e-12, "kappa: observed 3/4, expected 7/16 (a: 2 stale, 1 current, 1 neutral; b: 3 stale, 1 current)");
  ok(kappa({ x: "stale" }, { x: "stale" }).kappa === 1 && kappa({}, {}).n === 0, "kappa: one shared label agrees fully; no shared id is no measurement");

  const l = readLabels();
  ok(Object.values(l.labels).every((v) => LABEL_SET.includes(v)), `the committed labels parse (${Object.keys(l.labels).length})`);
  for (const [i, r] of (l.rounds ?? []).entries()) {
    const g = r.graders, ids = Object.keys(g.a);
    ok(ids.length === Object.keys(g.b).length && ids.every((id) => g.b[id] !== undefined && l.labels[id] !== undefined), `round ${i + 1}: both graders labelled the same ${ids.length} ids, each carrying a committed label`);
    ok(ids.every((id) => l.labels[id] === g.a[id] || l.labels[id] === g.b[id]), `round ${i + 1}: every adjudicated label is one grader's — adjudication picks, it does not invent`);
    const k = kappa(g.a, g.b);
    ok(Math.abs(r.agreement.raw - k.raw) < 1e-9 && Math.abs(r.agreement.kappa - k.kappa) < 1e-9 && r.agreement.adjudicated === ids.filter((id) => g.a[id] !== g.b[id]).length,
      `round ${i + 1}: the recorded agreement is the graders' own (raw ${k.raw.toFixed(3)}, kappa ${k.kappa.toFixed(3)}, ${r.agreement.adjudicated} adjudicated)`);
  }
  if (l.rounds) {
    const seen = l.rounds.flatMap((r) => Object.keys(r.graders.a));
    ok(new Set(seen).size === seen.length && seen.length === Object.keys(l.labels).length, "every committed label was graded in exactly one round");
  }
  ok(PANEL.filter((p) => p.kind === "planning").length === 4 && PANEL.filter((p) => p.kind === "heldout").length === 4 && PANEL.some((p) => p.name === "C1") && PANEL.some((p) => p.name === "P1"), "the panel holds the four planning queries, the four held out, the measured P1 and the C1 control");
  ok([...FIRST, ...SECOND, "none"].length === RULES.length && RULES.every((r) => r === "none" || FIRST.includes(r) !== SECOND.includes(r)), "every rule but none belongs to exactly one registration");

  if (failed) { console.error(`self-check: ${failed} FAILED`); process.exit(1); }
  console.log("self-check: OK");
}

// ── Main ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const arg = (flag: string) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };
  if (process.argv.includes("--self-check")) selfCheck();
  else {
    const url = process.env.DATABASE_URL;
    if (!url) { console.error("DATABASE_URL required (built inside the container from $POSTGRES_PASSWORD) — or --self-check"); process.exit(2); }
    await measure(url, arg("--dump-unlabelled"));
  }
}
