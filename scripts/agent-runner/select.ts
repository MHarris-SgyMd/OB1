/**
 * select.ts — the agent runner's selection rule (SMD-4087 cut 1), pure: over facts the dry run gathers, which
 * ticket a run would take, and why each other one is skipped. docs/agent-runner.md, "Choosing a ticket", is the
 * rule; README.md beside this file holds the criteria SMD-4086's label attests.
 *
 * A ticket passes when every check below does, and the first that passes, in order of priority (urgent first,
 * none last) and then age, is the one a run takes. Nothing here reads the network or the disk: dry-run.ts gathers
 * the facts, and its --self-check holds each check to its fixtures. Where a fact can't be read whole, or placed in
 * time, the check holds the ticket: a rule that reads less than it needs must not pass a ticket it would refuse.
 */

/** A Linear issue as the dry run reads it: its state, assignment, labels, history and blockers. */
export type Ticket = {
  identifier: string;
  title: string;
  /** Linear's priority: 1 urgent, 2 high, 3 medium, 4 low, 0 none. */
  priority: number;
  createdAt: string;
  stateType: string;
  stateName: string;
  assigneeId: string | null;
  delegateId: string | null;
  labelIds: string[];
  /** The issue's history entries the dry run read, in any order. */
  history: HistoryEntry[];
  /** Whether `history` is the whole history (Linear pages it). */
  historyComplete: boolean;
  /** The issues that block this one, with their state type. */
  blockers: { identifier: string; stateType: string }[];
  /** Whether `blockers` came from every relation the issue has (Linear pages those too). */
  blockersComplete: boolean;
};

/**
 * One entry of a Linear issue's history. Linear can update an entry after it writes it (its `updatedAt` moves), so
 * an entry counts as written at its latest write; it can also fold several actors' description edits into one.
 */
export type HistoryEntry = {
  createdAt: string;
  updatedAt: string;
  /** The user who made the change; null for an integration or an automation. */
  actorId: string | null;
  /** Set when a bot (an integration, an assistant, a workflow) made it, even on a user's behalf. */
  botActor: string | null;
  addedLabelIds: string[];
  updatedDescription: boolean;
  /** Whether the entry changed the title. */
  titleChanged: boolean;
};

/** A work claim as the REST core's `list_claims` answers it (server-portable/store.ts, WorkClaim), the fields read here. */
export type Claim = { id: string; issue: string; piece: string | null; holder: string; label: string | null; state: string; expiresAt: string };

/** One ticket's claims, or why they could not be read. */
export type ClaimsRead = { claims: Claim[]; truncated: boolean } | { unreadable: string };

/**
 * The pull requests whose head is one branch: whether any is open, and of those into DEFAULT_BRANCH, whether any
 * merged and the head commits of the merged and closed ones. Null when there is none.
 */
export type BranchPrs = { open: boolean; merged: boolean; closedHeads: string[] };

/**
 * The branch this repo's work lands on. A PR merged or closed into another branch (a stacked PR, or one GitHub
 * closed when its base was deleted) leaves its work short of it, so it frees nothing.
 */
export const DEFAULT_BRANCH = "main";

/** A branch, and the commit it points at (null when it couldn't be read). */
export type Branch = { name: string; sha: string | null };

/** What the dry run found beyond the board: branches and worktrees, open pull requests, claims, and a branch's PRs. */
export type Facts = {
  /** Every branch it read: this repo's, the bot's own copy's (once it exists), and the main checkout's local ones. */
  branches: Branch[];
  /** The main checkout's worktrees: each path, its branch when it has one, and its commit. */
  worktrees: { path: string; branch: string | null; sha: string | null }[];
  openPrs: { number: number; title: string; body: string; head: string; author: string }[];
  /** GitHub accounts, in lower case, whose PR bodies count: the maintainer's and the bot's. */
  trustedAuthors: string[];
  /** Each ticket's claims, by identifier. */
  claims: (identifier: string) => ClaimsRead;
  /** The PRs whose head is `branch`: null when there is none, undefined when they weren't looked up. */
  prsOfBranch: (branch: string) => BranchPrs | null | undefined;
};

/** What the rule needs from the runner's config: the two labels' ids and the maintainer's Linear user id. */
export type Rules = { readyLabelId: string; handedBackLabelId: string; maintainerId: string };

/** One ticket's verdict: taken, or skipped with every reason found. */
export type Verdict = { identifier: string; title: string; take: boolean; reasons: string[] };

/** A blocker in one of these states no longer blocks. */
export const SETTLED_STATE_TYPES = ["completed", "canceled", "duplicate"];
/** `list_claims`'s largest page (server-portable/core/schemas.ts): a reply still truncated there hides claims. */
export const CLAIMS_LIMIT = 1000;
/** A ticket id as the brain's claims accept one: a team key (a letter, then letters or digits), a dash, a number. */
export const TICKET_ID = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;
/**
 * Code points that change how text looks, or show as nothing a reader can check: controls, format characters (bidi
 * among them), line and paragraph separators, default-ignorable ones (zero-width spaces, fillers, tag characters),
 * private-use and unassigned ones, whose look depends on the font, and U+2800, the braille blank, which shows
 * nothing yet is neither whitespace nor default-ignorable. dry-run.ts shows each as <U+XXXX>, and a title holding one
 * holds its ticket. (U+2800 is added as a character, so this file holds no escape for it.)
 */
export const HIDDEN_TEXT = new RegExp(String.raw`[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}` + String.fromCodePoint(0x2800) + "]", "u");

/**
 * Whether `text` names the ticket as a whole id: `smd-4087` in `michaelharris/smd-4087-cut1` or `SMD-4087` in a
 * title, never `smd-408` inside `smd-4087`. Case does not matter; a letter or digit right before it, or a digit right
 * after it, means another id. An id that is no ticket id names nothing (workReasons holds such a ticket).
 */
export function mentionsTicket(text: string, identifier: string): boolean {
  const m = TICKET_ID.exec(identifier);
  if (!m) return false;
  return new RegExp(`(^|[^A-Za-z0-9])${m[1]}-${m[2]}(?![0-9])`, "i").test(text);
}

/**
 * The branch a claim's label names for its ticket: the last word with a slash in it that names the ticket, without
 * the brackets, quotes or punctuation around it. CLAUDE.md asks for a label naming the tool, the machine and the
 * branch, and its example ends with the branch. Null when no word does: the claim then has no PR to free it.
 */
export function branchOfLabel(label: string | null, identifier: string): string | null {
  if (!label) return null;
  const words = label
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/^[(\[{<"'`]+/, "").replace(/[)\]}>"'`,;:.!?]+$/, ""))
    .filter((w) => w.includes("/") && mentionsTicket(w, identifier));
  return words.length ? words[words.length - 1] : null;
}

const time = (iso: string): number => Date.parse(iso);
/** When an entry was last written: its creation, or Linear's later update of it. */
const lastWrite = (h: HistoryEntry): number => Math.max(time(h.createdAt), time(h.updatedAt));

/**
 * The label checks. agent-ready is present and agent-handed-back isn't; the history is read whole, and every time in
 * it can be read. Then, of the entries written at or after the label's last add (by an entry's creation, or by
 * Linear's later update of it): every add of the label is the maintainer's own, made directly, with no bot; and none
 * changes the description or the title, whoever made it, the maintainer included. An entry that adds the label and
 * edits the text at once is refused too; the maintainer adds the label again, on its own. Other changes, such as the
 * priority, the project or a relation, leave the label standing: it vouches for the text.
 */
export function labelReasons(t: Ticket, rules: Rules): string[] {
  const out: string[] = [];
  const labelled = t.labelIds.includes(rules.readyLabelId);
  if (!labelled) out.push("not labelled agent-ready");
  if (t.labelIds.includes(rules.handedBackLabelId)) out.push("handed back to a person (agent-handed-back): the maintainer removes that label and adds agent-ready again");
  if (!t.historyComplete) return [...out, "its history runs past what the dry run reads, so who added agent-ready, and what changed after, can't be checked whole"];
  if (t.history.some((h) => !Number.isFinite(time(h.createdAt)) || !Number.isFinite(time(h.updatedAt)))) return [...out, "its history holds a time the dry run can't read"];
  const adds = t.history.filter((h) => h.addedLabelIds.includes(rules.readyLabelId));
  if (!adds.length) {
    if (labelled) out.push("its history shows no one adding agent-ready (Linear logs nothing in an issue's first minutes), so the maintainer adds it again");
    return out;
  }
  const lastAdd = Math.max(...adds.map((h) => time(h.createdAt)));
  const found = new Set<string>();
  for (const h of t.history.filter((e) => lastWrite(e) >= lastAdd)) {
    if (h.addedLabelIds.includes(rules.readyLabelId)) {
      if (h.actorId !== rules.maintainerId) found.add(`agent-ready was added by ${h.actorId ?? "an integration or automation"}, not the maintainer`);
      else if (h.botActor) found.add(`agent-ready was added through ${h.botActor}, not by the maintainer directly`);
    }
    if (h.updatedDescription) found.add("its description changed in the entry of agent-ready's last add, or after it: the maintainer adds the label again, on its own, to approve the text");
    if (h.titleChanged) found.add("its title changed in the entry of agent-ready's last add, or after it: the maintainer adds the label again, on its own, to approve the text");
  }
  return [...out, ...found];
}

/** The board checks: state Backlog, assigned to no one and delegated to no agent, every blocker settled, and a title with nothing hidden in it. */
export function boardReasons(t: Ticket): string[] {
  const out: string[] = [];
  if (t.stateType !== "backlog" || t.stateName !== "Backlog") out.push(`in ${t.stateName}, not Backlog`);
  if (t.assigneeId) out.push("assigned to someone");
  if (t.delegateId) out.push("delegated to an agent");
  if (!t.blockersComplete) out.push("it has more relations than the dry run reads, so an open blocker could be among the rest");
  const open = t.blockers.filter((b) => !SETTLED_STATE_TYPES.includes(b.stateType));
  if (open.length) out.push(`blocked by ${open.map((b) => b.identifier).join(", ")}`);
  if (HIDDEN_TEXT.test(t.title)) out.push("its title holds characters that don't show, so what it says can't be seen whole");
  return out;
}

/** The checks that need nothing beyond the board: the label's and the board's. A ticket failing them needs no other read. */
export function firstReasons(t: Ticket, rules: Rules): string[] {
  return [...labelReasons(t, rules), ...boardReasons(t)];
}

/**
 * The "nobody's work" checks (CLAUDE.md step 1). No branch or worktree naming the ticket is unmerged work: a branch
 * is done with only when a PR from it merged or closed into DEFAULT_BRANCH at the commit it points at now, and none
 * of its PRs is open; newer commits, or none of that, may be work not merged or not pushed. Each reason says why the
 * branch holds, and a branch whose PRs weren't looked up says so. No open PR names it: by its head branch or title
 * from anyone, or by its body when the maintainer or the bot wrote it. Its claims hold nothing: a live claim always
 * holds the work, and one whose PR merged or closed is stale and named for the maintainer; a lapsed claim never
 * released holds it unless its PR merged or closed, since it may be work paused on another machine. A claim's PR is
 * found by the branch its label names for the ticket (branchOfLabel). A claim in a state the rule doesn't know holds
 * it. Claims that can't be read hold the ticket too.
 */
export function workReasons(identifier: string, facts: Facts): string[] {
  if (!TICKET_ID.test(identifier)) return [`its id ${identifier} is no ticket id the rule can match against branches and claims`];
  const out: string[] = [];
  /** Why a branch at `sha` still holds the ticket, or null when it is done with. */
  const holds = (name: string | null, sha: string | null): string | null => {
    if (name === null) return "detached";
    const prs = facts.prsOfBranch(name);
    if (prs === undefined) return "its PRs not looked up";
    if (prs === null) return "no PR";
    if (prs.open) return "a PR open";
    if (sha !== null && prs.closedHeads.includes(sha)) return null;
    return `no PR of it merged or closed into ${DEFAULT_BRANCH} at its commit`;
  };
  const branches = [
    ...new Set(
      facts.branches
        .filter((b) => mentionsTicket(b.name, identifier))
        .map((b) => [b.name, holds(b.name, b.sha)] as const)
        .filter(([, why]) => why !== null)
        .map(([name, why]) => `${name} (${why})`),
    ),
  ];
  if (branches.length) out.push(`${branches.length > 1 ? "branches" : "branch"} ${branches.join(", ")}`);
  const trees = facts.worktrees
    .filter((w) => mentionsTicket(w.path, identifier) || (w.branch !== null && mentionsTicket(w.branch, identifier)))
    .map((w) => [w, holds(w.branch, w.sha)] as const)
    .filter(([, why]) => why !== null)
    .map(([w, why]) => (w.branch === null ? `${w.path} (detached)` : `${w.path} (on ${w.branch}: ${why})`));
  if (trees.length) out.push(`${trees.length > 1 ? "worktrees" : "worktree"} ${trees.join(", ")}`);
  const trusted = new Set(facts.trustedAuthors.map((a) => a.toLowerCase()));
  const prs = facts.openPrs.filter((p) => mentionsTicket(p.head, identifier) || mentionsTicket(p.title, identifier) || (trusted.has(p.author.toLowerCase()) && mentionsTicket(p.body, identifier)));
  if (prs.length) out.push(`open PR ${prs.map((p) => `${p.number} by ${p.author}`).join(", ")}`);
  const read = facts.claims(identifier);
  if ("unreadable" in read) {
    out.push(`claims can't be read: ${read.unreadable}`);
    return out;
  }
  if (read.truncated) out.push(`its claim list was cut at ${CLAIMS_LIMIT}, and the list has no cursor until SMD-3606`);
  for (const c of read.claims) {
    if (c.state === "released") continue;
    const who = c.label ? `${c.holder} (${c.label})` : c.holder;
    if (c.piece) {
      out.push(`a ${c.state} claim on its piece "${c.piece}" by ${who}`);
      continue;
    }
    const branch = branchOfLabel(c.label, identifier);
    const prsOf = branch ? (facts.prsOfBranch(branch) ?? null) : null;
    const prDone = !!prsOf && !prsOf.open && (prsOf.merged || prsOf.closedHeads.length > 0);
    if (c.state === "live") out.push(prDone ? `a stale live claim by ${who}, its PR ${prsOf?.merged ? "merged" : "closed"}: tell the maintainer` : `a live claim by ${who}, until ${c.expiresAt}`);
    else if (c.state === "lapsed") {
      if (!prDone) out.push(`a lapsed claim by ${who}, never released, ${prsOf?.open ? "its PR open" : "with no merged or closed PR found"}: maybe work paused on another machine`);
    } else out.push(`a claim by ${who} in a state the rule doesn't know (${c.state})`);
  }
  return out;
}

/** Urgent first and none last, then the oldest first. */
export function byPriorityThenAge(a: Ticket, b: Ticket): number {
  const rank = (p: number) => (p >= 1 && p <= 4 ? p : 5);
  return rank(a.priority) - rank(b.priority) || time(a.createdAt) - time(b.createdAt);
}

/**
 * Every ticket's verdict, in the order a run considers them. A ticket that fails the label or board checks is
 * skipped for those; one that passes them is held to the work checks. The first that passes everything is taken,
 * and each later one that does is skipped for that reason alone.
 */
export function select(tickets: Ticket[], facts: Facts, rules: Rules): Verdict[] {
  let taken: string | null = null;
  return [...tickets].sort(byPriorityThenAge).map((t) => {
    const first = firstReasons(t, rules);
    const reasons = first.length ? first : workReasons(t.identifier, facts);
    if (reasons.length === 0 && taken !== null) reasons.push(`a run takes one ticket, and ${taken} comes first`);
    const take = reasons.length === 0;
    if (take) taken = t.identifier;
    return { identifier: t.identifier, title: t.title, take, reasons };
  });
}
