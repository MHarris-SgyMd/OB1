// A proposal's WRITER flags (SMD-2707) and 074's trust ladder as a rank: the
// one rule the listing's reply, --list and the decision's guard flag by. Its
// own file, with nothing but the trust words and types behind it, so the guard
// (proposal-review.ts), which the store and so every db/ worker loads, does
// not take render.ts's imports with it (SMD-3338).

import { TRUST } from "./core/filter.ts";
import type { ProposalWriter } from "./store.ts";

/** 074's ladder as a rank — operator 3, agent 2, ingested 1 — and 0 for no trust recorded or a word off it, below every word (filter.ts). */
export function trustRank(t: string | null | undefined): number {
  const i = (TRUST as readonly string[]).indexOf(t ?? "");
  return i < 0 ? 0 : TRUST.length - i;
}

/**
 * Why a proposal is flagged WRITER (SMD-2707): the side that stands, which of
 * the two rules it meets, and how sure the side is — `stood` on an accepted
 * row (its superseding_id), `would` when the verdict or --direction names it,
 * `if` for each side an undirected verdict leaves to the reviewer.
 */
export type StandingFlag = { stands: "newer" | "older"; captureOnly: boolean; lowerTrust: boolean; how: "stood" | "would" | "if"; sameKey?: true };

/**
 * The WRITER flags on a proposal (SMD-2707). The side that stands is the
 * superseding one: on an accepted row the one its superseding_id names;
 * else `direction` when given (review_supersession_proposal takes it over
 * the verdict, 029), else the verdict's, and both sides for an undirected
 * verdict, each the reviewer may pick. It is flagged when its text is a
 * capture-only key's and the accept would pass another's standing to it —
 * the other side's capturer is another, or the accept would take the side
 * (ob1_accept_takes) though one key captured both — or both sides have a
 * trust recorded and its ranks below the other's — a side with none recorded
 * is not flagged for it (the maintainer's choice, review pass 1: an
 * unclassified key's, a raw write's or an unbackfilled row's is not a lower
 * one). Nothing on a row from before 094, which carries no writer. One rule
 * for the reply, `--list` and the CLI's accept guard.
 */
export function standingFlags(
  p: { verdict: string; sameCapturer: boolean; status?: string; supersedingId?: string | null; older: { id?: string; writer: ProposalWriter | null; takes?: boolean }; newer: { id?: string; writer: ProposalWriter | null; takes?: boolean } },
  direction?: "newer" | "older",
): StandingFlag[] {
  const stood = p.status === "accepted" && p.supersedingId ? (p.supersedingId === p.newer.id ? "newer" : p.supersedingId === p.older.id ? "older" : null) : null;
  const named = stood ?? direction ?? (p.verdict === "newer_supersedes_older" ? "newer" : p.verdict === "older_supersedes_newer" ? "older" : null);
  const how: StandingFlag["how"] = stood ? "stood" : named ? "would" : "if";
  const sides: ("newer" | "older")[] = named ? [named] : ["newer", "older"];
  return sides.flatMap((stands) => {
    const me = p[stands].writer, other = p[stands === "newer" ? "older" : "newer"].writer;
    if (!me || !other) return [];
    // One capturer's two thoughts pass nobody's standing — unless the accept
    // would take the side all the same: the other side taken since (a write
    // key's edit, its chain accepted over a third's), as 092 reads it
    // (review pass 4).
    const captureOnly = me.captureOnly && (!p.sameCapturer || p[stands].takes === true);
    const lowerTrust = trustRank(me.trust) > 0 && trustRank(other.trust) > 0 && trustRank(me.trust) < trustRank(other.trust);
    // sameKey: flagged though one key captured both — said, or the two By:
    // lines read alike with no reason shown (review pass 5).
    return captureOnly || lowerTrust ? [{ stands, captureOnly, lowerTrust, how, ...(captureOnly && p.sameCapturer ? { sameKey: true as const } : {}) }] : [];
  });
}
