// A supersession proposal's decision (SMD-3338): one guard for both doors —
// db/consolidate.ts's --accept/--reject and the REST core's
// review_supersession_proposal (store-sql.ts). 029's review function checks
// what it checks (a text edited since judged, which is also what a stale row
// is, 063; the direction; a pointer already held or a loop); the checks it
// does not make are this file's, read under its lock: an accept standing on a
// lineage pair (070, SMD-2313) and one flagged WRITER (094, SMD-2707), each
// waived by force alone, as --force waives them. One transaction holds the
// guard, the decision, the read of what its lapse cleared (082) and the
// reviewer the row records (114, SMD-2608), so what is checked is what is
// decided, and a decision racing this one is never what this one answers.

import type { SQL, TransactionSQL } from "bun";
import { WRITERS_MISSING, type ProposalWriter } from "./store.ts";
import { standingFlags, type StandingFlag } from "./render.ts";

/**
 * Who decided a row (114's columns, which its trigger stamps from the key
 * that decided) and, for an agent, the registry's kind now, beside the kind
 * it had when it decided — nothing refreshes the stored one.
 */
export type Reviewer = { name: string | null; agentId: string | null; kind: string | null; kindNow: string | null };

/**
 * The reviewers of these rows, by id; "no-114" on a brain short of the file,
 * found by a probe rather than by the read failing: a decision reads this
 * inside its own transaction, which a failed statement would roll back.
 */
export async function reviewersOf(q: SQL, ids: string[]): Promise<Map<string, Reviewer> | "no-114"> {
  if (!ids.length) return new Map();
  const [{ has }] = (await q`SELECT EXISTS (SELECT 1 FROM information_schema.columns
                                           WHERE table_schema = 'public' AND table_name = 'supersession_proposals' AND column_name = 'reviewed_by_kind') AS has`) as { has: boolean }[];
  if (!has) return "no-114";
  const rows = (await q`SELECT id::text AS id, reviewed_by, reviewed_by_agent_id::text AS agent, reviewed_by_kind,
                               CASE WHEN reviewed_by_agent_id IS NOT NULL THEN ob1_registry_kind(reviewed_by_agent_id, reviewed_by) END AS kind_now
                          FROM supersession_proposals WHERE id = ANY(${q.array(ids, "UUID")}::uuid[])`) as
    { id: string; reviewed_by: string | null; agent: string | null; reviewed_by_kind: string | null; kind_now: string | null }[];
  return new Map(rows.map((r) => [r.id, { name: r.reviewed_by, agentId: r.agent, kind: r.reviewed_by_kind, kindNow: r.kind_now }]));
}

/**
 * An unforced accept's writers (SMD-2707), read as the listing reads them
 * (list_proposal_writers, 094), its takes and lapses in full past the
 * listing's cap (107, SMD-3036) — on a pending, stale or rejected row, each
 * of which 029 accepts. `flags`: its WRITER flags for this accept — on an
 * undirected verdict with no direction, each open side's (`how: "if"`),
 * which defer to 029's request for a direction. `edited`: a text moved since
 * judged, the other check force would also waive; `sides`: what each side's
 * accept would lapse.
 */
export type ReviewWriters = {
  flags: StandingFlag[]; older: ProposalWriter; newer: ProposalWriter; edited: boolean; status: string;
  sides: { older: { lapses: unknown[] }; newer: { lapses: unknown[] } };
};

/** What a decision asks: the proposal, accept or reject, and what 029 takes beside them. `actor`: actorPayload's envelope; `actorName`: its name, the audit rows' actor_name. */
export type ReviewRequest = {
  id: string; decision: "accept" | "reject"; note?: string | null; direction?: "newer" | "older" | null; force?: boolean;
  actor: Record<string, unknown> | null; actorName: string;
};

/**
 * review_supersession_proposal's answer (029/036), with the guard's own
 * refusals — LINEAGE_PAIR (070) and WRITER (094) — and, on a decision
 * written, the pointers its lapse cleared (082) and the reviewer the row
 * records (114). `lineage`: the pair is one, read on an unforced accept;
 * `writers`: what the guard read, null when it read none (a reject, a forced
 * accept, a row 029 answers itself) and "no-094" on a brain short of the
 * file, whose WRITER check did not run.
 */
export type ReviewResult = {
  ok: boolean; error?: string; status?: string; superseding_id?: string; superseded_id?: string; thought_id?: string;
  written?: boolean; cleared?: boolean; current?: string; verdict?: string; older_edited?: boolean; newer_edited?: boolean;
  flags?: StandingFlag[]; lapsed?: { id: string; onto: string }[]; reviewer?: Reviewer | null | "no-114";
  writers: ReviewWriters | "no-094" | null;
};

/** 029's lock, 036's order: taken before the proposal row, by the review function and by delete_thought. */
const REVIEW_LOCK = "ob1:supersession-review";

/**
 * The guard's read of an unforced accept's writers. In a savepoint: a brain
 * short of 094 answers it with an error, which must not end the decision's
 * transaction.
 */
async function writersOf(q: TransactionSQL, id: string, direction: "newer" | "older" | undefined): Promise<ReviewWriters | "no-094" | null> {
  let rows: Record<string, unknown>[];
  try {
    rows = await q.savepoint(async (sp) => (await sp`
      SELECT p.verdict, p.status AS proposal_status,
             p.older_fingerprint IS NOT NULL AND p.older_fingerprint IS DISTINCT FROM content_fingerprint_of(o.content) AS older_moved,
             p.newer_fingerprint IS NOT NULL AND p.newer_fingerprint IS DISTINCT FROM content_fingerprint_of(n.content) AS newer_moved,
             w.older_actor_name, w.older_actor_kind, w.older_trust, w.older_capture_only,
             w.newer_actor_name, w.newer_actor_kind, w.newer_trust, w.newer_capture_only, w.same_capturer,
             -- 107 (SMD-3036): the listing caps its walks; the guard reads its
             -- one row's in full, so its refusal and the pointers it names are
             -- never the cap's.
             ob1_accept_takes(p.older_id, p.newer_id) AS older_takes, ob1_accept_lapses(p.older_id, p.newer_id) AS older_lapses,
             ob1_accept_takes(p.newer_id, p.older_id) AS newer_takes, ob1_accept_lapses(p.newer_id, p.older_id) AS newer_lapses
        FROM supersession_proposals p JOIN thoughts o ON o.id = p.older_id JOIN thoughts n ON n.id = p.newer_id
        CROSS JOIN LATERAL list_proposal_writers(ARRAY[p.id]) w
       WHERE p.id = ${id}::uuid AND p.status IN ('pending', 'stale', 'rejected')`) as Record<string, unknown>[]);
  } catch (e) {
    if (WRITERS_MISSING.test((e as Error).message)) return "no-094";
    throw e;
  }
  if (!rows.length) return null;
  const r = rows[0];
  const text = (v: unknown) => (v == null ? null : String(v));
  const w = (side: "older" | "newer"): ProposalWriter =>
    ({ name: text(r[`${side}_actor_name`]), kind: text(r[`${side}_actor_kind`]), trust: text(r[`${side}_trust`]), captureOnly: r[`${side}_capture_only`] === true });
  const older = w("older"), newer = w("newer");
  const flags = standingFlags({ verdict: String(r.verdict), sameCapturer: r.same_capturer === true, older: { writer: older, takes: r.older_takes === true }, newer: { writer: newer, takes: r.newer_takes === true } }, direction);
  // A row goes stale when a text moved under its verdict (063), and what
  // force waives there is that move, 029's edit check.
  const arr = (v: unknown): unknown[] => { const a = typeof v === "string" ? JSON.parse(v) : v; return Array.isArray(a) ? a : []; };
  return { flags, older, newer, edited: r.older_moved === true || r.newer_moved === true, status: String(r.proposal_status),
    sides: { older: { lapses: arr(r.older_lapses) }, newer: { lapses: arr(r.newer_lapses) } } };
}

/**
 * Decide a proposal: the guard, 029's review, and on a decision written what
 * its lapse cleared and the reviewer the row records — one transaction, under
 * 029's lock from its first statement. A refusal writes nothing.
 */
export async function reviewProposal(sql: SQL, r: ReviewRequest): Promise<ReviewResult> {
  const guarded = r.decision === "accept" && r.force !== true;
  return await sql.begin(async (q) => {
    // Re-entrant: 029 takes it again, and update_thought for the pointer.
    await q`SELECT pg_advisory_xact_lock(hashtext(${REVIEW_LOCK}))`;
    // 070 (SMD-2313): an accept on a lineage pair — one side's derived_from
    // names the other — is the harm 066 exists to prevent (the derivation
    // archives its input while still naming it). Read from the row's own
    // predicate, and only while the row is unreviewed: a decided row is
    // 029's to answer (ALREADY_ACCEPTED on an accepted one).
    const lineage = guarded
      ? ((await q`SELECT (COALESCE(n.derived_from @> jsonb_build_array(o.id::text), false) OR COALESCE(o.derived_from @> jsonb_build_array(n.id::text), false)) AS lineage
                    FROM supersession_proposals p JOIN thoughts o ON o.id = p.older_id JOIN thoughts n ON n.id = p.newer_id
                   WHERE p.id = ${r.id}::uuid AND p.status IN ('pending', 'stale', 'rejected')`) as { lineage: boolean }[])[0]?.lineage === true
      : false;
    // SMD-2707: an accept whose standing side is a capture-only key's text,
    // or of lower trust than the other, takes force — read on a lineage pair
    // too, so its refusal names a flag the force would also waive.
    const writers = guarded ? await writersOf(q, r.id, r.direction ?? undefined) : null;
    if (lineage) return { ok: false, error: "LINEAGE_PAIR", writers };
    if (writers && writers !== "no-094" && writers.flags.some((f) => f.how !== "if")) return { ok: false, error: "WRITER", flags: writers.flags, writers };
    const res = { ...((await q`
      SELECT review_supersession_proposal(${r.id}::uuid, ${r.decision}::text, ${r.note ?? null}::text, ${r.direction ?? null}::text, ${r.actor}::jsonb, ${r.force === true}::boolean) AS r`)[0].r as Omit<ReviewResult, "writers">), writers };
    if (!res.ok) return res;
    if (r.decision === "accept") {
      // SMD-2707: 082's lapse writes each cleared pointer as an update event
      // of this transaction's, under this actor — this transaction's own
      // (xmin: two accepts under one actor name sharing now() each read the
      // other's), in the order the lapse cleared them, which is the order the
      // listing named them (SMD-3035's one walk).
      res.lapsed = (await q`
        SELECT thought_id::text AS id, diff->'supersedes'->>'before' AS onto FROM thought_audit
         WHERE created_at = now() AND action = 'update' AND actor_name = ${r.actorName}
           AND xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text
           AND diff ? 'supersedes' AND diff->'supersedes'->>'after' IS NULL
         ORDER BY seq`) as { id: string; onto: string }[];
    }
    const reviewers = await reviewersOf(q, [r.id]);
    res.reviewer = reviewers === "no-114" ? "no-114" : reviewers.get(r.id) ?? null;
    return res;
  });
}
