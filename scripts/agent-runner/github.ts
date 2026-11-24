/**
 * github.ts — the runner's GitHub client, as a GitHub App (SMD-4087 cut 3b-1; docs/agent-runner.md decision 13, as the
 * maintainer amended it 2026-11-24). The App is installed on this repo alone. publish.ts's `GitHubClient` is the seam
 * this module fills: push the one branch, open the draft PR.
 *
 * How it authenticates. The App's private key (`github-app.pem`, 0600, beside the runner's other secrets) signs a
 * ten-minute JWT, and the JWT buys an installation token that lasts an hour. Each token is asked for with the least the
 * publish needs: this repo alone, `contents: write` (the push) and `pull_requests: write` (the PR), and nothing else.
 * A token GitHub hands back with more than that, or for another repository, is refused unused: the App was given more
 * than the design allows, and the maintainer must take it back (README, "The GitHub App").
 *
 * What the App can't do, by GitHub's own rules and not this code's: it holds no `workflows` permission, so a push that
 * touches `.github/workflows/` is refused; a tag ruleset keeps `v*` tags (and so `release.yml`) the maintainer's; and
 * main's ruleset, once SMD-4090 requires an approving review, keeps a merge the maintainer's. Those three are the
 * design's prerequisites for the first live publish, checked by `setup.ts check-github-app`.
 *
 * What this code adds:
 *   - only a branch under the runner's prefix (`agent/smd-<n>-<slug>`) is pushed, by an explicit refspec, with no tags,
 *     no hooks and no force, so a branch already on GitHub at another commit is a refusal, never an overwrite;
 *   - the token never sits in a URL or an argument: git reads it from its environment as an `http.extraheader`, scoped
 *     to `https://github.com/`, and every word that comes back is scrubbed of it before it is returned;
 *   - opening the PR is idempotent: an open PR from this branch, opened by the App, is answered as the PR.
 *
 * Every dependency is injected (the fetch, the clock, the git spawn), so the self-check (github-check.ts) runs it all
 * offline: a stand-in GitHub API, and a real push into a local bare repository.
 */

import { createSign } from "node:crypto";
import { GIT_SAFE, NOT_JSON, SAFE_REQUEST, TIME_LIMITS, gitEnv, jsonOf, type Fetch } from "./facts.ts";
import type { GitHubClient } from "./publish.ts";
import { oneLine } from "./text.ts";

/** The App's private key, beside the runner's other secrets. Not in dry-run.ts's KEY_FILES: it is several lines, and only the publish reads it. */
export const APP_KEY_FILE = "github-app.pem";
/** A private key as GitHub hands it out (PKCS#1) or as openssl converts it (PKCS#8): the armour, then base64 lines. */
export const PEM_SHAPE = /^-----BEGIN (RSA )?PRIVATE KEY-----\n(?:[A-Za-z0-9+/=]{1,80}\n)+-----END (RSA )?PRIVATE KEY-----$/;
/** The only branches the runner pushes: record.ts `branchFor`'s shape. */
export const PUSH_BRANCH = /^agent\/smd-[1-9][0-9]{0,6}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The permissions an installation token is asked for, and all it may come back with (`metadata: read` GitHub adds to every token). */
export const TOKEN_PERMISSIONS = { contents: "write", pull_requests: "write" } as const;
const ALLOWED_BACK: Record<string, string> = { ...TOKEN_PERMISSIONS, metadata: "read" };
/** An installation token's shape. */
const INSTALLATION_TOKEN = /^ghs_[A-Za-z0-9]{36,}$/;
const API = "https://api.github.com";

/** The App, as the runner's config names it: its id, its installation on this repo, and the repo (owner/name). */
export type App = { appId: string; installationId: string; repo: string };

/** Base64url of a string or bytes, as a JWT's parts are written. */
const b64url = (b: Buffer): string => b.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/**
 * The App's JWT (RS256): issued a minute in the past for clock drift, good for nine minutes after that (GitHub's
 * ceiling is ten), with the App's id as its issuer.
 */
export function appJwt(appId: string, pem: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const head = b64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = b64url(Buffer.from(JSON.stringify({ iat, exp: iat + 540, iss: appId })));
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${claims}`);
  return `${head}.${claims}.${b64url(signer.sign(pem))}`;
}

/** A text with the token taken out, in its own form and in the basic-auth form git sends, and any other GitHub token too. */
export function scrubToken(text: string, token: string | null): string {
  let t = text;
  if (token) {
    t = t.split(token).join("ghs_…");
    t = t.split(Buffer.from(`x-access-token:${token}`).toString("base64")).join("…");
  }
  return t.replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "gh…");
}

const init = (method: string, bearer: string, body?: unknown): RequestInit => ({
  ...SAFE_REQUEST,
  method,
  headers: {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agent-runner",
    Authorization: `Bearer ${bearer}`,
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  signal: AbortSignal.timeout(TIME_LIMITS.request),
});

/** GitHub's own words for a refusal, at most a line: its `message`, never the body whole. */
async function refusal(res: Response, what: string): Promise<string> {
  const body = await jsonOf(res);
  const msg = body !== NOT_JSON && body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string" ? `: ${oneLine((body as { message: string }).message, 160)}` : "";
  return `GitHub answered ${res.status} (${what})${msg}`;
}

export type TokenResult = { ok: true; token: string; expiresAt: number } | { ok: false; detail: string };

/**
 * An installation token for this repo alone, with `contents: write` and `pull_requests: write` alone. A token that
 * comes back with any other permission, any write beyond those two, or another repository, is refused unused.
 */
export async function installationToken(fetchImpl: Fetch, app: App, pem: string, nowMs: number): Promise<TokenResult> {
  let jwt: string;
  try {
    jwt = appJwt(app.appId, pem, nowMs);
  } catch {
    return { ok: false, detail: "the App's private key couldn't sign a JWT (is github-app.pem the App's key?)" };
  }
  const name = app.repo.split("/")[1];
  let res: Response;
  try {
    res = await fetchImpl(`${API}/app/installations/${app.installationId}/access_tokens`, init("POST", jwt, { repositories: [name], permissions: TOKEN_PERMISSIONS }));
  } catch (e) {
    return { ok: false, detail: `the installation token request failed: ${oneLine(String((e as Error)?.message ?? e), 160)}` };
  }
  if (res.status !== 201) return { ok: false, detail: await refusal(res, "minting an installation token") };
  const body = await jsonOf(res);
  if (body === NOT_JSON || !body || typeof body !== "object") return { ok: false, detail: "GitHub answered the token request with a body that isn't a JSON object" };
  const b = body as { token?: unknown; expires_at?: unknown; permissions?: unknown; repositories?: unknown };
  if (typeof b.token !== "string" || !INSTALLATION_TOKEN.test(b.token)) return { ok: false, detail: "GitHub's answer carried no installation token of the expected shape" };
  const perms = b.permissions && typeof b.permissions === "object" ? (b.permissions as Record<string, unknown>) : null;
  const extra = perms === null ? ["(none listed)"] : Object.entries(perms).filter(([k, v]) => ALLOWED_BACK[k] !== v).map(([k, v]) => `${k}: ${String(v)}`);
  const missing = perms === null ? [] : Object.entries(TOKEN_PERMISSIONS).filter(([k, v]) => perms[k] !== v).map(([k]) => k);
  if (extra.length || missing.length) {
    return { ok: false, detail: `the installation token's permissions aren't the publish's (${[...extra.map((e) => `more: ${e}`), ...missing.map((m) => `missing: ${m}`)].join(", ")}); refused unused` };
  }
  const repos = Array.isArray(b.repositories) ? (b.repositories as { full_name?: unknown }[]).map((r) => r?.full_name) : null;
  if (!repos || repos.length !== 1 || typeof repos[0] !== "string" || repos[0].toLowerCase() !== app.repo.toLowerCase()) {
    return { ok: false, detail: `the installation token isn't for ${app.repo} alone; refused unused` };
  }
  const exp = typeof b.expires_at === "string" ? Date.parse(b.expires_at) : NaN;
  return { ok: true, token: b.token, expiresAt: Number.isFinite(exp) ? exp : nowMs + 3_000_000 };
}

/** One git invocation's result. */
export type GitOut = { code: number; stdout: string; stderr: string };
/** Run git with argv and env, from no repository's working directory; injected so the self-check can push to a local bare repository. */
export type GitSpawn = (argv: string[], env: Record<string, string>) => Promise<GitOut>;

/** The real spawn: /usr/bin/git, from `/`, ended at the request time limit's triple. */
export const realGitSpawn: GitSpawn = async (argv, env) => {
  const p = Bun.spawn(["/usr/bin/git", ...argv], { cwd: "/", env, stdout: "pipe", stderr: "pipe", timeout: TIME_LIMITS.request * 3 });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: (await p.exited) ?? -1, stdout, stderr };
};

/**
 * The push's argv and environment. The token rides in the environment as an `http.extraheader` scoped to
 * `https://github.com/` (git ≥ 2.31's GIT_CONFIG_COUNT), so it is in no URL git could echo and no argument `ps` shows.
 * GIT_SAFE: https only, no credential helper, no redirect. Hooks off; no tags; no force; one explicit refspec.
 */
export function pushCommand(opts: { bareRepo: string; remote: string; branch: string; token: string; home: string }): { argv: string[]; env: Record<string, string> } {
  const ref = `refs/heads/${opts.branch}`;
  return {
    argv: [...GIT_SAFE, "-c", "core.hooksPath=/dev/null", "-c", "push.followTags=false", "-c", "push.gpgSign=false", "-C", opts.bareRepo, "push", "--porcelain", "--no-verify", "--no-follow-tags", opts.remote, `${ref}:${ref}`],
    env: {
      ...gitEnv(opts.home),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${opts.token}`).toString("base64")}`,
    },
  };
}

/**
 * Read `git push --porcelain`'s line for the ref: pushed (`*` a new branch, ` ` a fast-forward) or already there (`=`).
 * A rejection (`!`) is final: the branch is on GitHub at a commit this push doesn't descend from, which only a person
 * can sort out.
 */
export function pushOutcome(out: GitOut, branch: string): { ok: true } | { ok: false; final: boolean; detail: string } {
  const ref = `refs/heads/${branch}`;
  const line = out.stdout.split("\n").find((l) => l.split("\t")[1] === `${ref}:${ref}`);
  const flag = line?.[0];
  if (out.code === 0 && (flag === "*" || flag === " " || flag === "=")) return { ok: true };
  if (flag === "!") return { ok: false, final: true, detail: `GitHub refused the push of ${branch}: ${oneLine(line?.split("\t")[2] ?? "rejected", 120)}` };
  return { ok: false, final: false, detail: `git push of ${branch} exited ${out.code}: ${oneLine(out.stderr || out.stdout, 200)}` };
}

type PrRow = { number?: unknown; html_url?: unknown; user?: { login?: unknown } | null; head?: { ref?: unknown; repo?: { full_name?: unknown } | null } | null };

/** A PR row as `{number, url}`, when it is a PR of this repo from `branch` in this repo, opened by the App. */
function ourPr(row: PrRow, app: App & { botLogin: string }, branch: string): { number: number; url: string } | null {
  if (typeof row?.number !== "number" || !Number.isInteger(row.number) || row.number <= 0) return null;
  if (typeof row.html_url !== "string" || !row.html_url.startsWith(`https://github.com/${app.repo}/pull/`)) return null;
  if (row.head?.ref !== branch || typeof row.head?.repo?.full_name !== "string" || row.head.repo.full_name.toLowerCase() !== app.repo.toLowerCase()) return null;
  if (typeof row.user?.login !== "string" || row.user.login.toLowerCase() !== app.botLogin.toLowerCase()) return null;
  return { number: row.number, url: row.html_url };
}

/** The open PR from `branch`, opened by the App, if there is one. */
async function findOpenPr(fetchImpl: Fetch, app: App & { botLogin: string }, token: string, branch: string): Promise<{ found: { number: number; url: string } | null } | { error: string }> {
  const owner = app.repo.split("/")[0];
  const res = await fetchImpl(`${API}/repos/${app.repo}/pulls?state=open&per_page=10&head=${encodeURIComponent(`${owner}:${branch}`)}`, init("GET", token));
  if (!res.ok) return { error: await refusal(res, `the open PRs of ${branch}`) };
  const body = await jsonOf(res);
  if (!Array.isArray(body)) return { error: "GitHub answered the PR lookup with something that isn't a list" };
  for (const row of body as PrRow[]) {
    const pr = ourPr(row, app, branch);
    if (pr) return { found: pr };
  }
  return { found: null };
}

/** What the App client needs. `botLogin` is `<app slug>[bot]`, the login its PRs carry. */
export type AppClientDeps = {
  app: App & { botLogin: string };
  pem: string;
  fetch: Fetch;
  git: GitSpawn;
  /** The runner's bare repository, the branch's source. */
  bareRepo: string;
  /** An empty directory, git's HOME. */
  home: string;
  /** Where the branch goes; this repo on GitHub unless the self-check points it at a local bare repository. */
  remote?: string;
  now?: () => number;
};

/**
 * publish.ts's GitHubClient over the App. Each call mints its own token (an hour's, of which a publish uses seconds), so
 * no token outlives its step in memory. Neither call throws, and nothing either returns carries the token.
 */
export function appClient(d: AppClientDeps): GitHubClient & { mintToken: () => Promise<TokenResult> } {
  const now = d.now ?? Date.now;
  const remote = d.remote ?? `https://github.com/${d.app.repo}.git`;
  const mintToken = () => installationToken(d.fetch, d.app, d.pem, now());
  return {
    mintToken,
    async pushBranch({ branch }) {
      if (!PUSH_BRANCH.test(branch)) return { ok: false, final: true, detail: `refusing to push ${JSON.stringify(oneLine(branch, 80))}: the runner pushes only agent/smd-<n>-<slug>` };
      const t = await mintToken();
      if (!t.ok) return { ok: false, detail: t.detail };
      try {
        const cmd = pushCommand({ bareRepo: d.bareRepo, remote, branch, token: t.token, home: d.home });
        const out = await d.git(cmd.argv, cmd.env);
        const r = pushOutcome(out, branch);
        return r.ok ? r : { ...r, detail: scrubToken(r.detail, t.token) };
      } catch (e) {
        return { ok: false, detail: scrubToken(`git push threw: ${oneLine(String((e as Error)?.message ?? e), 160)}`, t.token) };
      }
    },
    async openDraftPr({ title, head, base, body }) {
      if (!PUSH_BRANCH.test(head)) return { ok: false, final: true, detail: "refusing a PR whose head isn't an agent/smd-<n>-<slug> branch of this repo" };
      const t = await mintToken();
      if (!t.ok) return { ok: false, detail: t.detail };
      try {
        const before = await findOpenPr(d.fetch, d.app, t.token, head);
        if ("error" in before) return { ok: false, detail: scrubToken(before.error, t.token) };
        if (before.found) return { ok: true, ...before.found };
        const res = await d.fetch(`${API}/repos/${d.app.repo}/pulls`, init("POST", t.token, { title, head, base, body, draft: true }));
        if (res.status === 201) {
          const pr = ourPr((await jsonOf(res)) as PrRow, d.app, head);
          return pr ? { ok: true, ...pr } : { ok: false, detail: "GitHub opened a PR but answered with one that isn't the App's from this branch" };
        }
        const why = scrubToken(await refusal(res, "opening the draft PR"), t.token);
        if (res.status === 422) {
          // A lost answer to an earlier try: the PR exists. Anything else at 422 (no commits between, a bad base) is final.
          const after = await findOpenPr(d.fetch, d.app, t.token, head);
          if (!("error" in after) && after.found) return { ok: true, ...after.found };
          return { ok: false, final: true, detail: why };
        }
        return { ok: false, detail: why };
      } catch (e) {
        return { ok: false, detail: scrubToken(`the PR request failed: ${oneLine(String((e as Error)?.message ?? e), 160)}`, t.token) };
      }
    },
  };
}
