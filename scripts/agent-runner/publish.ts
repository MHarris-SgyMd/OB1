/**
 * publish.ts — the publish step (SMD-4087 cut 3a; docs/agent-runner.md, "A run, step by step" steps 8-9 and "What the
 * runner publishes"). On a run that passed the gate, the runner publishes as the bot: it confirms the claim with a
 * day-lease renewal (it must renew clean — no `ticketClosed`, no lapse another claim took over), pushes the one branch
 * from its bare repository to the bot's fork, opens a draft PR on this repo with a body it builds, comments the PR link
 * on the ticket, and only then sets the claim's lease to a week. The maintainer reviews and merges (SMD-4090); the runner never merges.
 *
 * Two pieces, both pure of I/O but for injected dependencies, so the self-check (publish-check.ts) drives them offline:
 *
 *   - `buildPrBody` composes the PR body from the run's own computed fields (the ticket, the diff's stat, the gate, the
 *     sessions) and then, after the secret scan, the worker's report and the review's open findings — each in a code
 *     block whose fence is longer than any run of backticks inside it, so nothing in that model text renders, links or
 *     mentions anyone, and the whole body stays under GitHub's 65,536-character cap (docs, "What the runner publishes").
 *     A section the scanner flags is withheld, not shown.
 *   - `publish` runs the sequence over an injected GitHub client (the push and the draft PR), the claim client's renew
 *     (claims.ts) and the Linear comment (board.ts). It never throws: a push or PR failure, or a renewal that couldn't
 *     land, comes back as a result the caller (cut 3b's live-run wiring) turns into a hand-back or a step left owed.
 *
 * The real GitHub client (git push to the fork, the REST call that opens the PR) and the wiring into the live run are
 * cut 3b, and need SMD-4089's GitHub identity. This cut is the logic and its offline self-check, with no token and no
 * network — the same shape cuts 2c-1 (claims.ts) and 2c-2 (board.ts) were built in before the live run called them.
 */

import { comment } from "./board.ts";
import { claimsDir, renewClaim, writeToken, type ClaimReply } from "./claims.ts";
import type { Fetch } from "./facts.ts";
import type { ScanSecrets } from "./gate.ts";
import { updateRecord, type GateSummary, type OwedStep, type SessionCost } from "./record.ts";
import type { Gql } from "../../db/linear-api.ts";

// ── The PR body ────────────────────────────────────────────────────────────────────────────────────────────────────

/** GitHub's hard cap on a PR body; the whole body the runner builds stays under it. */
export const BODY_CAP = 65_536;
/** Each model-text section (the worker's report, the open findings) is capped before it goes in the body; two full sections together exceed the body cap, where the backstop below drops them whole (a single full section still fits). */
export const SECTION_CAP = 33_000;
/** The diff's stat is derived from the branch (its file names are the agent's), so it too is capped and fenced. */
export const DIFFSTAT_CAP = 8_000;

/** The inputs `buildPrBody` composes, all computed by the runner; the worker report and findings are the only model text. */
export type PrBodyInput = {
  ticket: string;
  branch: string;
  base: string;
  /** `git diff --stat base branch`, as the runner took it. */
  diffStat: string;
  gate: GateSummary;
  sessions: SessionCost[];
  /** The worker session's final message (model text). */
  workerReport: string;
  /** The review's open (unfixed) findings, each a line of model text. */
  openFindings: string[];
};

/** Mask a claim token anywhere it might appear in model text, so a report that quoted one never reaches the PR. The optional backslash matches the markdown-escaped `wc\_` form a server error can carry (parity with the session hook's scrubber); a token never reaches an agent session, so this is defence in depth that `scanSecrets` also backstops. */
const maskTokens = (s: string): string => s.replace(/wc\\?_[0-9a-f]{6,}/gi, "wc_…");

/**
 * Scrub a relayed error/detail string before it enters a record field (`owed[].why`, `reason`): both a claim token and a
 * GitHub token shape masked. These strings reach the run record and the stable run summary, and a cut-3b GitHub client's
 * git-push error could echo a token-bearing remote URL. Its errors must be token-free (see `GitHubClient`), but scrub
 * defensively here so one 3b slip can't leak a token onto disk or the brain.
 */
const scrubDetail = (s: string): string =>
  maskTokens(s)
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "gh_…")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_…");

/** A thrown value as a short one-line string for an owed step's `why`; `scrubDetail` is still applied before it is recorded. */
const errText = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 160);

/**
 * A fence of backticks one longer than the longest run of backticks anywhere in the text (at least three). A closing
 * fence must be at least as long as the opening one and sit on its own line, so a fence longer than any run inside the
 * text cannot be reproduced by the text: the model output can't break out of the code block (docs, "What the runner
 * publishes"; the PR-body rule).
 */
export function fenceFor(text: string): string {
  let longest = 0;
  let run = 0;
  for (const ch of text) {
    if (ch === "`") {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/** Wrap text in a code block with a fence long enough to contain it, each fence on its own line. */
function fenced(text: string): string {
  const f = fenceFor(text);
  return `${f}\n${text}\n${f}`;
}

/** Cut text to a cap on code points, marking where it was cut; never splits inside a surrogate pair. */
function cap(text: string, max: number): string {
  const cps = [...text];
  return cps.length > max ? `${cps.slice(0, max).join("")}\n…[truncated at ${max} characters]` : text;
}

/**
 * One section of model text for the PR body: masked of tokens, scanned, and either fenced under a heading that names it
 * unverified, or — if the scanner flagged anything — withheld with a count and no content.
 */
function modelSection(heading: string, text: string, scanSecrets: ScanSecrets): string {
  // Cap first, then scan and show the SAME text. The scanner runs on exactly what the body will show, never on
  // unbounded input — a regex scanner can silently hit a backtrack limit on a huge string and miss a secret
  // (regex-backtrack-limit-silent), and a secret past the cap would be truncated away unseen anyway.
  const shown = cap(maskTokens(text), SECTION_CAP);
  const found = scanSecrets(shown);
  if (found.length > 0) {
    return `### ${heading}\n\n_Withheld: the secret scanner flagged this text (${found.length} finding(s)); it is kept in the run record, not shown here._`;
  }
  return `### ${heading}\n\n_Unverified model output: the runner did not write this and does not vouch for it._\n\n${fenced(shown)}`;
}

/** The facts section and the diff stat — the runner's own computed output, no model text (the diff stat still fenced, its file names being the branch's). */
function factsBlock(input: PrBodyInput): string {
  const parts: string[] = [];
  parts.push("## Agent runner — automated draft");
  parts.push(
    `The agent runner produced this branch for **${input.ticket}** and stopped at a draft PR for review. No person wrote this change; a maintainer reviews and merges it.`,
  );
  const facts = [
    `**Ticket:** ${input.ticket}`,
    `**Base:** \`${input.base}\``,
    `**Branch:** \`${input.branch}\``,
    `**Gate:** ${input.gate.pass ? "passed" : `failed — ${input.gate.failed.join(", ") || "see the run record"}`}`,
  ];
  if (input.gate.ciCheckFiles.length > 0) {
    // Bounded so the facts block can never dominate the body (the backstop drops only model sections): CI-check files
    // are a small, fixed set, but a cap keeps that true if the match set ever grows.
    const files = input.gate.ciCheckFiles.slice(0, 50);
    const more = input.gate.ciCheckFiles.length - files.length;
    facts.push(
      `**CI-relevant files changed:** ${files.map((f) => `\`${f}\``).join(", ")}${more > 0 ? `, and ${more} more` : ""} — CI runs the branch's own copy of these.`,
    );
  }
  parts.push(facts.join("  \n"));
  const sess = input.sessions
    .map((s) => `- ${s.role}: ${s.turns ?? "?"} turns${s.costUsd !== null ? `, $${s.costUsd.toFixed(2)}` : ""}${s.ended !== "result" ? ` (ended ${s.ended})` : ""}`)
    .join("\n");
  if (sess) parts.push(`### Sessions\n\n${sess}`);
  const stat = input.diffStat.trimEnd();
  if (stat !== "") parts.push(`### Changed files\n\n${fenced(cap(stat, DIFFSTAT_CAP))}`);
  return parts.join("\n\n");
}

/**
 * The PR body (docs, "What the runner publishes"). The facts first, then the worker report and the open findings as
 * fenced, scanned model text. If the whole body would pass GitHub's cap, the model sections are dropped (never truncated
 * mid-fence, which could free the text) and a note put in their place, so the body is always well-formed and under cap.
 */
export function buildPrBody(input: PrBodyInput, scanSecrets: ScanSecrets): string {
  const facts = factsBlock(input);
  const worker = modelSection("Worker report", input.workerReport, scanSecrets);
  const open = input.openFindings.filter((f) => f.trim() !== "");
  const findings = open.length > 0 ? `\n\n${modelSection("Open review findings", open.join("\n\n"), scanSecrets)}` : "";
  const full = `${facts}\n\n${worker}${findings}\n`;
  if (full.length <= BODY_CAP) return full;
  // Too large: drop the model sections whole (a mid-fence cut could let the text out) and point at the record.
  const note = "### Model output omitted\n\n_The worker report and any open findings were too large for the PR body; they are kept in the run record._";
  const trimmed = `${facts}\n\n${note}\n`;
  return trimmed.length <= BODY_CAP ? trimmed : `${cap(trimmed, BODY_CAP - 64)}\n`;
}

/** The short, computed comment the runner posts on the ticket with the PR link — no model text. */
export function prLinkComment(ticket: string, pr: { number: number; url: string }): string {
  return `**Agent runner — opened a draft PR for review: [#${pr.number}](${pr.url}).**\n\nThe branch was pushed to the bot's fork and the PR opened against this repo as a draft. CI runs on it; a maintainer reviews and merges (the runner does not merge). ${ticket} stays claimed by the runner while the PR is open.`;
}

// ── The publish sequence ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The GitHub operations the publish step needs, injected so the self-check stubs them; the real client (git push to the
 * fork, the REST call) is cut 3b. Neither operation's `detail`, nor any message it throws (which `publish` records in an
 * owed step), may carry the bot's GitHub token: the cut-3b client must authenticate without a token in a URL that git
 * could echo on a failed push, or scrub the token from its errors. The runner never writes a token to a record.
 */
export type GitHubClient = {
  /** Push the one branch from the runner's bare repository to the bot's fork (explicit refspec, no tags, hooks off). */
  pushBranch: (opts: { branch: string }) => Promise<{ ok: true } | { ok: false; detail: string }>;
  /**
   * Open a draft PR on this repo from the bot's fork, returning its number and URL. Must be idempotent: if a PR already
   * exists for this head, return it as `{ ok: true, number, url }` rather than failing — a publish that fails here is
   * retried whole (owed `publish`), so without this a lost response would loop on "a PR already exists" (422) or open a
   * duplicate. It should also not throw (a transport failure is `{ ok: false }`); `publish` guards a throw regardless.
   */
  openDraftPr: (opts: { title: string; head: string; base: string; body: string }) => Promise<{ ok: true; number: number; url: string } | { ok: false; detail: string }>;
};

/** What `publish` takes from its environment. */
export type PublishDeps = {
  github: GitHubClient;
  /** The hermetic fetch claims.ts uses, for the renew. */
  fetch: Fetch;
  /** The stable brain's REST base, from the brain check (claims.ts `brainReady`). */
  base: string;
  /** The runner's agent-kind brain key, for the renew. */
  brainKey: string;
  /** The runner's own directory; the claim's token is kept under `<runnerDir>/claims/` (claims.ts). */
  runnerDir: string;
  /** The Linear client, for the PR-link comment (board.ts). */
  gql: Gql;
  /** The clock, for the owed steps' timestamps; the self-check pins it. */
  now?: () => Date;
};

/** The publish step's input: the claim to renew, the PR to open, and the pre-publish check the caller runs (step 8). */
export type PublishInput = {
  /** The run's directory, so the PR number is recorded. */
  dir: string;
  ticket: string;
  claimId: string;
  token: string;
  piece?: string | null;
  /** The day's lease the claim already holds, renewed at step 8 to confirm the claim is clean before publishing (86400). */
  leaseDaySeconds: number;
  /** The week's lease, set only after the PR opens (step 9, CLAUDE.md step 5; 604800), so a failed publish doesn't over-hold. */
  leaseWeekSeconds: number;
  /** The branch to push, `agent/smd-<n>-<slug>`. */
  branch: string;
  /** The PR's head, `<bot account>:<branch>`, and base branch on this repo. */
  head: string;
  baseBranch: string;
  /** The PR title. It must be runner-computed or gate-scanned text (e.g. the commit subject, which the gate's secret scan covers) — never raw model output. GitHub renders a title as plain text and fires no mentions, and `publish` masks tokens in it, but it does not scan it. */
  title: string;
  /** The body, already built by `buildPrBody` (masked, scanned and fenced there); `publish` forwards it unchanged. */
  body: string;
  /**
   * The step-8 re-checks the caller runs against Linear and the claims (the ticket is still In Progress, still
   * labelled, its description unedited since the brief, and nobody's work but this run's own). Injected so this cut's
   * self-check drives it offline; the reads are cut 3b.
   */
  precheck: () => Promise<{ ok: true } | { ok: false; reason: string }>;
};

/** How far publish got. `published` true means the PR is open and its number recorded; otherwise the caller hands back or leaves a step owed. */
export type PublishResult = {
  published: boolean;
  pushed: boolean;
  prNumber: number | null;
  prUrl: string | null;
  /** The confirming renewal before publishing (step 8) landed clean — the claim is held. The week lease is set after the PR opens, best-effort. */
  leaseRenewed: boolean;
  /** The PR-link comment on the ticket landed. */
  commented: boolean;
  /** Steps to retry next tick (a failed comment, or a retryable renew: kind "publish"). */
  owed: OwedStep[];
  /** A non-retryable condition — the ticket changed, the claim was taken over, released, or closed: stop and hand to a person. */
  handToPerson: boolean;
  reason: string;
};

const mk = (over: Partial<PublishResult> & { reason: string }): PublishResult => ({
  published: false,
  pushed: false,
  prNumber: null,
  prUrl: null,
  leaseRenewed: false,
  commented: false,
  owed: [],
  handToPerson: false,
  ...over,
});

/** How a renewal before publishing reads (docs step 8, CLAUDE.md step 4): clean to publish, owed to retry, or hand to a person. */
type RenewVerdict = { ok: true } | { ok: false; handToPerson: boolean; retryable: boolean; reason: string };

/** Map a renew reply to the publish decision. A renewal that revived a lapsed claim another claim took over, a closed ticket, or any final refusal hands the ticket to a person; a retryable refusal or a transport error leaves the publish owed. */
export function renewVerdict(reply: ClaimReply): RenewVerdict {
  if (reply.kind === "renewed") {
    if (reply.ticketClosed) return { ok: false, handToPerson: true, retryable: false, reason: `the ticket closed (${reply.ticketClosed.statusType}) before publishing` };
    if (reply.revived && (reply.revived.others.length > 0 || reply.revived.unreadable || reply.revived.more > 0)) {
      return { ok: false, handToPerson: true, retryable: false, reason: `the claim had lapsed and another claim was made or renewed on its work${reply.revived.unreadable ? " (unreadable)" : ""}` };
    }
    return { ok: true };
  }
  if (reply.kind === "unattributed") {
    return reply.retryable
      ? { ok: false, handToPerson: false, retryable: true, reason: "the registry can't attribute the key yet (retry next tick)" }
      : { ok: false, handToPerson: true, retryable: false, reason: "the registry can't attribute the key (an operator must act)" };
  }
  if (reply.kind === "error") return { ok: false, handToPerson: false, retryable: true, reason: `the renewal couldn't reach the brain: ${reply.detail}` };
  if (reply.kind === "ended") return { ok: false, handToPerson: true, retryable: false, reason: `the claim has ended${reply.ticketClosed ? " (the ticket closed)" : ""}` };
  if (reply.kind === "work-claimed") return { ok: false, handToPerson: true, retryable: false, reason: "the work is held by another claim" };
  if (reply.kind === "refused") return { ok: false, handToPerson: true, retryable: false, reason: `${reply.code}: ${reply.detail}` };
  // A `claimed`/`released` reply to a renew is a shape the runner doesn't expect: hand to a person.
  return { ok: false, handToPerson: true, retryable: false, reason: `unexpected renew reply: ${reply.kind}` };
}

/**
 * Publish a passed run as the bot (docs steps 8-9): confirm the claim with a day-lease renewal (clean), push the branch
 * to the bot's fork, open the draft PR, record its number, set the lease to a week now the PR is open, and comment the
 * PR link on the ticket. Never throws — a throwing precheck or renewal, a push or PR failure, and a failed comment each
 * come back as a result (owed to retry, or handed to a person), never a rejection, so a tick can't crash with the claim
 * orphaned. The pre-publish re-checks (the ticket read and "nobody's work") are the injected `precheck`; the real GitHub
 * client and the wiring that turns a non-published result into a hand-back are cut 3b.
 */
export async function publish(input: PublishInput, deps: PublishDeps): Promise<PublishResult> {
  const at = (): string => (deps.now ? deps.now() : new Date()).toISOString();
  const owedPublish = (why: string): PublishResult => mk({ owed: [{ kind: "publish", why: scrubDetail(why), at: at() }], reason: scrubDetail(why) });

  // Step 8 — the ticket is still In Progress, labelled, unedited since the brief, and nobody's work but this run's own.
  // The check reads Linear and the claims (cut 3b), which can throw; a throw is transient, so the publish is left owed to
  // retry, never propagated — an uncaught throw here would crash the tick with the claim still held (orphaned).
  let pre: { ok: true } | { ok: false; reason: string };
  try {
    pre = await input.precheck();
  } catch (e) {
    return owedPublish(`the pre-publish check threw: ${errText(e)}`);
  }
  if (!pre.ok) return mk({ handToPerson: true, reason: `pre-publish check failed: ${pre.reason}` });

  // Step 8 — confirm the claim with a day-lease renewal; publish only on a clean renewal (the week lease waits for the PR).
  let renewReply: ClaimReply;
  try {
    renewReply = await renewClaim(deps.fetch, deps.base, deps.brainKey, { id: input.claimId, token: input.token, lease_seconds: input.leaseDaySeconds });
  } catch (e) {
    return owedPublish(`the renewal before publishing threw: ${errText(e)}`);
  }
  const verdict = renewVerdict(renewReply);
  if (!verdict.ok) {
    return mk({ handToPerson: verdict.handToPerson, owed: verdict.retryable ? [{ kind: "publish", why: `renew before publishing: ${verdict.reason}`, at: at() }] : [], reason: `renew before publishing: ${verdict.reason}` });
  }

  // Step 9 — push the branch to the bot's fork. The GitHub client does a real git push and REST call in cut 3b, so guard
  // a throw (a dropped connection) as well as a returned failure: either leaves the publish owed to retry, the claim
  // still held at the day lease the step-8 renewal confirmed (`leaseRenewed` true) — never a thrown rejection.
  let push: { ok: true } | { ok: false; detail: string };
  try {
    push = await deps.github.pushBranch({ branch: input.branch });
  } catch (e) {
    return mk({ leaseRenewed: true, owed: [{ kind: "publish", why: `the push to the bot's fork threw: ${scrubDetail(errText(e))}`, at: at() }], reason: "the push to the bot's fork threw" });
  }
  if (!push.ok) return mk({ leaseRenewed: true, owed: [{ kind: "publish", why: `the push to the bot's fork failed: ${scrubDetail(push.detail)}`, at: at() }], reason: `the push to the bot's fork failed: ${scrubDetail(push.detail)}` });

  // Step 9 — open the draft PR on this repo from the fork, guarded the same way. `openDraftPr` is idempotent (see its
  // type), so the owed retry re-runs the step without duplicating the PR. The title is masked of tokens (it must already
  // be runner-computed or gate-scanned, per PublishInput.title); the body was masked, scanned and fenced by buildPrBody.
  let pr: { ok: true; number: number; url: string } | { ok: false; detail: string };
  try {
    pr = await deps.github.openDraftPr({ title: maskTokens(input.title), head: input.head, base: input.baseBranch, body: input.body });
  } catch (e) {
    return mk({ leaseRenewed: true, pushed: true, owed: [{ kind: "publish", why: `opening the draft PR threw: ${scrubDetail(errText(e))}`, at: at() }], reason: "opening the draft PR threw" });
  }
  if (!pr.ok) return mk({ leaseRenewed: true, pushed: true, owed: [{ kind: "publish", why: `the branch was pushed but the draft PR couldn't be opened: ${scrubDetail(pr.detail)}`, at: at() }], reason: `the branch was pushed but the draft PR couldn't be opened: ${scrubDetail(pr.detail)}` });

  // Record the PR number as soon as it exists. A record-write throw is swallowed (the PR is open regardless), so step 0's
  // reconcile (cut 3b) must confirm a run's PR from GitHub, not from the record alone.
  try {
    updateRecord(input.dir, (r) => { r.step = "publish"; r.pr = pr.number; });
  } catch {
    // The PR is open; don't unpublish over a record-write failure.
  }

  const owed: OwedStep[] = [];

  // Step 9 / CLAUDE.md step 5 — the PR is open, so bump the claim to a week. Write the token to the week lease regardless
  // of the renewal below landing: a transport failure here must not leave the token at the day lease, which step 0 would
  // then keep renewing with and let an open-PR claim lapse over a weekend (the runner ticks only in business hours). The
  // brain is live at the day lease the step-8 renewal set, so the renewal here is a best-effort immediate bump.
  try {
    writeToken(claimsDir(deps.runnerDir), { id: input.claimId, token: input.token, ticket: input.ticket, piece: input.piece ?? null, lease_seconds: input.leaseWeekSeconds });
  } catch {
    // The resume/reconcile rewrites the token file; step 0 renews from whatever lease it reads.
  }
  try {
    await renewClaim(deps.fetch, deps.base, deps.brainKey, { id: input.claimId, token: input.token, lease_seconds: input.leaseWeekSeconds });
  } catch {
    // Best-effort: the token now targets the week lease, so step 0's next renewal bumps the brain to it.
  }

  // Step 9 — comment the PR link on the ticket. A Linear outage leaves the comment owed (step 0 retries), not fatal.
  const cm = await comment(deps.gql, input.ticket, prLinkComment(input.ticket, pr));
  if (!cm.ok) owed.push({ kind: "comment", why: `comment the PR link on ${input.ticket}: ${scrubDetail(cm.detail)}`, at: at() });

  return mk({ published: true, pushed: true, prNumber: pr.number, prUrl: pr.url, leaseRenewed: true, commented: cm.ok, owed, reason: `published draft PR #${pr.number}` });
}
