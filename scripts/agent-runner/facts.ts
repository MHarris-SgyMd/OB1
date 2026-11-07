/**
 * facts.ts — what the agent runner's dry run reads before it applies the selection rule (SMD-4087 cut 1): the
 * board from Linear, branches and worktrees from git, open pull requests and a branch's PRs from GitHub, and claims
 * from the stable brain's REST core. Every source is a dependency the caller hands in, so the dry run's self-check
 * runs each reader on fixtures, offline. Nothing here writes anywhere.
 *
 * Two rules hold every reader. No request that carries a credential follows a redirect, logs its headers, or
 * relaxes TLS: fetch would carry custom headers, the brain key among them, to the next origin, as
 * rest-client/index.ts found, so a redirect is answered as the failure it is. And git runs with an environment built
 * from nothing, no credential helper, https alone and no redirect, so a remote that answers 401 can never make it
 * read or erase a credential of the maintainer's.
 */

import { strict, type Gql } from "../../db/linear-api.ts";
import { CLAIMS_LIMIT, DEFAULT_BRANCH, type Branch, type BranchPrs, type Claim, type ClaimsRead, type HistoryEntry, type OpenPr, type Ticket, type Worktree } from "./select.ts";

/** Runs a command and answers its exit code and output: dry-run.ts's spawner, or a stub in the self-check. */
export type Runner = (cmd: string[], opts?: { cwd?: string }) => Promise<{ code: number; stdout: string; stderr: string }>;
/** fetch, or a stub. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** SMD-4086's two labels. Their names are fixed, not configured: a config mistake must not make another label the one that approves. */
export const READY_LABEL = "agent-ready";
export const HANDED_BACK_LABEL = "agent-handed-back";

/** The runner's config, as dry-run.ts reads it from its file. The runner's keys live at fixed paths, not here. */
export type Config = {
  team: string;
  initiative: string;
  maintainerLinearId: string;
  /** owner/name of this repo on GitHub. */
  repo: string;
  /** owner/name of the bot's own copy of the repo, once SMD-4089 makes it; null until then. */
  botRepo: string | null;
  mainCheckout: string;
  /** The stable brain's REST core, as the host reaches it (its proxy's /api route); null until it is reachable. */
  restUrl: string | null;
};

/** Linear issues are read this many at a time: a page with its relations and history stays under Linear's query complexity cap. */
export const BOARD_PAGE = 10;
/** History entries read per issue (Linear answers newest first); a longer history is refused, not trusted. */
export const HISTORY_PAGE = 100;
/** Relations read per issue; more than this is refused, since an open blocker could be among the rest. */
export const RELATIONS_PAGE = 50;

/** The request options every credentialed call carries: no redirect followed, no headers logged, TLS checked. Bun reads `verbose` and `tls`. */
export const SAFE_REQUEST = { redirect: "manual", verbose: false, tls: { rejectUnauthorized: true } } as const;

/** The environment git runs with: nothing of the maintainer's, no config but the repo's own, and no prompt. `home` is an empty directory. */
export function gitEnv(home: string): Record<string, string> {
  return { PATH: "/usr/bin:/bin", HOME: home, LANG: "C", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
}
/**
 * Arguments every git call starts with: no credential helper, https as the only transport, no redirect followed,
 * and a transfer slower than 1 kB/s for 20 s given up, so a stalled connection ends the read rather than holding it.
 */
export const GIT_SAFE = [
  "-c", "credential.helper=",
  "-c", "protocol.allow=never",
  "-c", "protocol.https.allow=always",
  "-c", "http.followRedirects=false",
  "-c", "http.lowSpeedLimit=1000",
  "-c", "http.lowSpeedTime=20",
];

type LinearIssue = {
  identifier: string;
  title: string;
  priority: number;
  createdAt: string;
  state: { name: string; type: string };
  assignee: { id: string } | null;
  delegate: { id: string } | null;
  labelIds: string[];
  inverseRelations: { pageInfo: { hasNextPage: boolean }; nodes: { type: string; issue: { identifier: string; state: { type: string } } }[] };
  history: {
    pageInfo: { hasNextPage: boolean };
    nodes: {
      createdAt: string;
      updatedAt: string;
      actorId: string | null;
      botActor: { name: string | null; type: string | null } | null;
      addedLabelIds: string[] | null;
      updatedDescription: boolean | null;
      toTitle: string | null;
    }[];
  };
};

/** The initiative by its exact name: it must exist once. */
export const INITIATIVE_QUERY = `query($name: String!) { initiatives(first: 2, filter: { name: { eq: $name } }) { nodes { id name } } }`;
/** SMD-4086's labels, on the team alone. */
export const LABELS_QUERY = `query($team: String!, $names: [String!]) {
  issueLabels(first: 10, filter: { team: { key: { eq: $team } }, name: { in: $names } }) { nodes { id name } }
}`;
/** The board: every open ticket of the team carrying the ready label, in a project of the initiative. */
export const BOARD_QUERY = `query($team: String!, $label: String!, $initiative: ID!, $after: String) {
  issues(first: ${BOARD_PAGE}, after: $after, filter: {
    team: { key: { eq: $team } },
    labels: { some: { name: { eq: $label } } },
    project: { initiatives: { some: { id: { eq: $initiative } } } },
    state: { type: { nin: ["completed", "canceled", "duplicate"] } }
  }) {
    pageInfo { hasNextPage endCursor }
    nodes {
      identifier title priority createdAt
      state { name type }
      assignee { id }
      delegate { id }
      labelIds
      inverseRelations(first: ${RELATIONS_PAGE}) { pageInfo { hasNextPage } nodes { type issue { identifier state { type } } } }
      history(first: ${HISTORY_PAGE}) {
        pageInfo { hasNextPage }
        nodes { createdAt updatedAt actorId botActor { name type } addedLabelIds updatedDescription toTitle }
      }
    }
  }
}`;

/** One Linear issue as the selection rule reads it. Its blockers are the issues whose relation to it is "blocks". */
export function toTicket(i: LinearIssue): Ticket {
  const history: HistoryEntry[] = i.history.nodes.map((h) => ({
    createdAt: h.createdAt,
    updatedAt: h.updatedAt ?? h.createdAt,
    actorId: h.actorId,
    botActor: h.botActor ? (h.botActor.name ?? h.botActor.type ?? "a bot") : null,
    addedLabelIds: h.addedLabelIds ?? [],
    updatedDescription: h.updatedDescription === true,
    titleChanged: h.toTitle !== null && h.toTitle !== undefined,
  }));
  return {
    identifier: i.identifier,
    title: i.title,
    priority: i.priority,
    createdAt: i.createdAt,
    stateType: i.state.type,
    stateName: i.state.name,
    assigneeId: i.assignee?.id ?? null,
    delegateId: i.delegate?.id ?? null,
    labelIds: i.labelIds ?? [],
    history,
    historyComplete: !i.history.pageInfo.hasNextPage,
    blockers: i.inverseRelations.nodes.filter((r) => r.type === "blocks").map((r) => ({ identifier: r.issue.identifier, stateType: r.issue.state.type })),
    blockersComplete: !i.inverseRelations.pageInfo.hasNextPage,
  };
}

/** The two labels' ids, and every open ticket in the initiative's projects that carries the ready label. */
export async function readBoard(gql: Gql, cfg: Config): Promise<{ readyLabelId: string; handedBackLabelId: string; tickets: Ticket[] }> {
  const initiatives = await strict<{ initiatives: { nodes: { id: string }[] } }>(gql, INITIATIVE_QUERY, { name: cfg.initiative });
  if (initiatives.initiatives.nodes.length !== 1) throw new Error(`Linear has ${initiatives.initiatives.nodes.length} initiatives of the configured name, not one`);
  const initiative = initiatives.initiatives.nodes[0].id;
  const labels = await strict<{ issueLabels: { nodes: { id: string; name: string }[] } }>(gql, LABELS_QUERY, { team: cfg.team, names: [READY_LABEL, HANDED_BACK_LABEL] });
  const idOf = (name: string): string => {
    const hits = labels.issueLabels.nodes.filter((l) => l.name === name);
    if (hits.length !== 1) throw new Error(`team ${cfg.team} has ${hits.length} labels named ${name}, not one (SMD-4086 makes it)`);
    return hits[0].id;
  };
  const readyLabelId = idOf(READY_LABEL);
  const handedBackLabelId = idOf(HANDED_BACK_LABEL);
  const tickets: Ticket[] = [];
  let after: string | null = null;
  for (let page = 0; page < 50; page++) {
    type Page = { issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: LinearIssue[] } };
    const data: Page = await strict<Page>(gql, BOARD_QUERY, { team: cfg.team, label: READY_LABEL, initiative, after });
    tickets.push(...data.issues.nodes.map(toTicket));
    if (!data.issues.pageInfo.hasNextPage) return { readyLabelId, handedBackLabelId, tickets };
    after = data.issues.pageInfo.endCursor;
  }
  throw new Error(`more than ${50 * BOARD_PAGE} labelled tickets: the dry run reads no further`);
}

/** Each non-empty line of `out` as `shape` reads it; a line it can't read is an error, never a branch dropped (a dropped branch would hold nothing). */
function parseLines(out: string, shape: RegExp, what: string): Branch[] {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = shape.exec(l);
      if (!m) throw new Error(`${what} answered a line the dry run can't read: ${l.slice(0, 80)}`);
      return { name: m[2], sha: m[1] };
    });
}

/** `git ls-remote --heads` output: each branch and its commit. */
export function parseLsRemote(out: string): Branch[] {
  return parseLines(out, /^([0-9a-f]+)\trefs\/heads\/(.+)$/, "git ls-remote");
}

/**
 * `git for-each-ref --format='%(objectname) %(refname:lstrip=2)' refs/heads` output: each local branch and its commit.
 * `lstrip=2` gives the name whole; `refname:short` turns it into `heads/<name>` when a tag shares it.
 */
export function parseLocalBranches(out: string): Branch[] {
  return parseLines(out, /^([0-9a-f]+) (.+)$/, "git for-each-ref");
}

/**
 * `git worktree list --porcelain` output: each worktree's path, its branch when it is on one, and its commit. A block
 * with no worktree line is an error, never a worktree dropped.
 */
export function parseWorktrees(out: string): Worktree[] {
  const trees: Worktree[] = [];
  for (const block of out.split(/\n\s*\n/)) {
    if (!block.trim()) continue;
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (!path) throw new Error(`git worktree list answered a block the dry run can't read: ${block.trim().slice(0, 80)}`);
    trees.push({ path, branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null, sha: /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1] ?? null });
  }
  return trees;
}

/**
 * Branches on this repo and the bot's copy, read from GitHub with `ls-remote` from outside any repository (so no
 * repository's config applies) and no local fetch; and the main checkout's local branches and worktrees.
 */
export async function readBranches(run: Runner, cfg: Config): Promise<{ branches: Branch[]; worktrees: Worktree[] }> {
  const must = async (cmd: string[], cwd?: string): Promise<string> => {
    const r = await run(cmd, cwd ? { cwd } : undefined);
    if (r.code !== 0) throw new Error(`git ${cmd.slice(1 + GIT_SAFE.length).join(" ")} exited ${r.code}: ${r.stderr.trim().slice(0, 300)}`);
    return r.stdout;
  };
  const branches: Branch[] = [];
  for (const repo of [cfg.repo, ...(cfg.botRepo ? [cfg.botRepo] : [])]) {
    branches.push(...parseLsRemote(await must(["git", ...GIT_SAFE, "ls-remote", "--heads", `https://github.com/${repo}.git`], "/")));
  }
  branches.push(...parseLocalBranches(await must(["git", ...GIT_SAFE, "-C", cfg.mainCheckout, "for-each-ref", "--format=%(objectname) %(refname:lstrip=2)", "refs/heads"])));
  const worktrees = parseWorktrees(await must(["git", ...GIT_SAFE, "-C", cfg.mainCheckout, "worktree", "list", "--porcelain"]));
  return { branches, worktrees };
}

const githubInit = (token: string | null): RequestInit => ({
  ...SAFE_REQUEST,
  headers: { Accept: "application/vnd.github+json", "User-Agent": "agent-runner-dry-run", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  signal: AbortSignal.timeout(20_000),
});

/** What jsonOf answers for a body that isn't JSON, so a body that is the JSON `null` reads as itself. */
const NOT_JSON = Symbol("not JSON");

/**
 * A response's JSON, or NOT_JSON when its body isn't JSON. Never the parser's message: it quotes the body, which can
 * hold anything a server chose to send back, a key among it.
 */
async function jsonOf(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return NOT_JSON;
  }
}

/** A GitHub answer's list, or an error that says only what came instead: no JSON, or JSON that isn't a list. */
async function githubList(res: Response, what: string): Promise<unknown[]> {
  const body = await jsonOf(res);
  if (body === NOT_JSON) throw new Error(`GitHub answered a body that isn't JSON (${what})`);
  if (!Array.isArray(body)) throw new Error(`GitHub answered JSON that isn't a list (${what})`);
  return body;
}

/** GitHub's refusal as an error, naming a spent rate limit as what it is. */
function githubError(res: Response, what: string): Error {
  if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
    return new Error(`GitHub's rate limit is spent (${what}): a token in the runner's github.token raises it from 60 requests an hour`);
  }
  return new Error(`GitHub answered ${res.status} (${what})`);
}

/** Every open pull request on this repo, with its number, title, body, head branch and author; a public repo needs no token. */
export async function readOpenPrs(fetchImpl: Fetch, cfg: Config, token: string | null): Promise<OpenPr[]> {
  const prs: OpenPr[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetchImpl(`https://api.github.com/repos/${cfg.repo}/pulls?state=open&per_page=100&page=${page}`, githubInit(token));
    if (!res.ok) throw githubError(res, "listing open pull requests");
    const rows = (await githubList(res, "listing open pull requests")) as { number: number; title: string; body: string | null; head: { ref: string }; user: { login: string } | null }[];
    prs.push(...rows.map((r) => ({ number: r.number, title: r.title, body: r.body ?? "", head: r.head.ref, author: r.user?.login ?? "" })));
    if (rows.length < 100) return prs;
  }
  throw new Error("more than 1,000 open pull requests: the dry run reads no further");
}

/** A pull request as a branch's lookup reads it. */
type PrRow = { state: string; merged_at: string | null; head: { sha: string }; base: { ref: string } };

/**
 * The pull requests whose head is `branch` in this repo's owner's account, read page by page: whether any is open,
 * and of those into DEFAULT_BRANCH, whether any merged and the head commits of the merged and closed ones; null when
 * there is none. GitHub ignores a `head` filter with no owner and lists every PR, so the owner is always given. A PR
 * from another account's copy reads as none, which holds the work.
 */
export async function readBranchPrs(fetchImpl: Fetch, cfg: Config, token: string | null, branch: string): Promise<BranchPrs | null> {
  const owner = cfg.repo.split("/")[0];
  const rows: PrRow[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetchImpl(`https://api.github.com/repos/${cfg.repo}/pulls?state=all&per_page=100&head=${encodeURIComponent(`${owner}:${branch}`)}&page=${page}`, githubInit(token));
    if (!res.ok) throw githubError(res, `the pull requests of ${branch}`);
    const got = (await githubList(res, `the pull requests of ${branch}`)) as PrRow[];
    rows.push(...got);
    if (got.length < 100) {
      if (!rows.length) return null;
      const intoDefault = rows.filter((r) => r.state !== "open" && r.base?.ref === DEFAULT_BRANCH);
      return {
        open: rows.some((r) => r.state === "open"),
        merged: intoDefault.some((r) => r.merged_at),
        closedHeads: intoDefault.map((r) => r.head.sha),
      };
    }
  }
  throw new Error(`more than 1,000 pull requests from ${branch}: the dry run reads no further`);
}

/**
 * Each ticket's claims from the stable brain's REST core, or one reason none can be read: no REST URL or key yet,
 * a brain that doesn't say it is stable, or one with no claim operations (before v2.0.0). The key goes in the
 * `x-brain-key` header, never the URL, and no request follows a redirect.
 */
export async function readClaims(fetchImpl: Fetch, cfg: Config, key: string | null, tickets: string[]): Promise<Map<string, ClaimsRead> | { unreadable: string }> {
  if (!cfg.restUrl) return { unreadable: "the config names no REST URL for the stable brain" };
  if (!key) return { unreadable: "there is no brain key in the runner's directory (SMD-4089)" };
  const base = cfg.restUrl.replace(/\/+$/, "");
  const init = (): RequestInit => ({ ...SAFE_REQUEST, headers: { "x-brain-key": key, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  const brain = await fetchImpl(`${base}/v1/brain`, init());
  if (!brain.ok) return { unreadable: `${base}/v1/brain answered ${brain.status}` };
  const brainBody = await jsonOf(brain);
  if (brainBody === NOT_JSON) return { unreadable: `${base}/v1/brain answered a body that isn't JSON` };
  if (brainBody === null || typeof brainBody !== "object") return { unreadable: `${base}/v1/brain answered JSON that isn't an object` };
  const tier = (brainBody as { tier?: string | null }).tier ?? null;
  if (tier !== "stable") return { unreadable: `the brain at ${base} says its tier is ${tier ?? "unset"}, not stable` };
  const out = new Map<string, ClaimsRead>();
  for (const ticket of tickets) {
    const res = await fetchImpl(`${base}/v1/claims?ticket=${encodeURIComponent(ticket)}&include_ended=true&limit=${CLAIMS_LIMIT}`, init());
    if (res.status === 404) return { unreadable: `${base} has no claim operations (stable before v2.0.0)` };
    if (!res.ok) {
      out.set(ticket, { unreadable: `list_claims answered ${res.status}` });
      continue;
    }
    const body = await jsonOf(res);
    const read = body !== NOT_JSON && body !== null && typeof body === "object" ? (body as { claims?: Claim[]; truncated?: boolean }) : null;
    out.set(ticket, read && Array.isArray(read.claims) && typeof read.truncated === "boolean" ? { claims: read.claims, truncated: read.truncated } : { unreadable: body === NOT_JSON ? "list_claims answered a body that isn't JSON" : "list_claims answered in a shape the dry run doesn't know" });
  }
  return out;
}
