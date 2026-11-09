/**
 * claims-check.ts — the offline self-check of cut 2c-1 (SMD-4087): the runner's REST claim client (claims.ts), on a
 * stubbed `fetch` and a temp directory, with no network and no key. CI runs it
 * (`bun scripts/agent-runner/claims-check.ts --self-check`). The stub answers each claim path — the brain/tier check,
 * claim/renew/release and every coded refusal — so each `ClaimReply` case is exercised, and the token files are
 * round-tripped on disk (owner-only, never through a link). The orchestrator that calls this on a real run is cut 2c-3.
 *
 *   bun scripts/agent-runner/claims-check.ts --self-check
 */

import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainBase, brainReady, claimWork, claimsDir, deleteToken, listTokens, readToken, releaseClaim, renewClaim, writeToken, type ClaimReply } from "./claims.ts";
import type { Config, Fetch } from "./facts.ts";

/** A minimal Config with a REST URL, enough for the claim calls (the rest is unused here). */
const CFG = { restUrl: "https://brain.example/api" } as unknown as Config;
const KEY = "a-brain-key";
const BASE = brainBase(CFG) as string;

/** One stubbed response: a status with a JSON body, a raw (non-JSON) body, or a thrown transport error. */
type Route = { status?: number; body?: unknown; raw?: string; fail?: boolean };

/** A fetch that routes each call through `routeFor`, recording the calls, so a test drives any reply with no network. */
function stub(routeFor: (url: string, method: string, body: unknown) => Route): { fetch: Fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: Fetch = async (url, initArg) => {
    const i = (initArg ?? {}) as RequestInit;
    calls.push({ url, init: i });
    const method = (i.method as string) ?? "GET";
    const body = typeof i.body === "string" ? JSON.parse(i.body) : undefined;
    const r = routeFor(url, method, body);
    if (r.fail) throw new Error("the network is down");
    const text = r.raw !== undefined ? r.raw : JSON.stringify(r.body ?? {});
    return new Response(text, { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
  };
  return { fetch, calls };
}

/** A claim row for a stubbed body. */
const row = (over: Partial<Record<string, unknown>> = {}) => ({ id: "11111111-1111-4111-8111-111111111111", issue: "SMD-9", piece: null, holder: "claude-code", holderKind: "agent", label: "l", claimedAt: "t", renewedAt: null, expiresAt: "t2", releasedAt: null, releasedBy: null, releasedByKind: null, releaseReason: null, state: "live", ...over });

export async function selfCheck(): Promise<number> {
  let passed = 0;
  let failed = 0;
  const ok = (cond: unknown, what: string): void => {
    if (cond) passed++;
    else failed++;
    console.log(`  ${cond ? "✓" : "✗"} ${what}`);
  };
  const section = async (name: string, body: () => void | Promise<void>): Promise<void> => {
    console.log(name);
    try {
      await body();
    } catch (e) {
      failed++;
      console.log(`  ✗ ${name}: it threw (${String((e as Error)?.stack ?? (e as Error)?.message ?? e).slice(0, 300)})`);
    }
  };
  const kind = (r: ClaimReply): string => r.kind;

  const fixture = mkdtempSync(join(tmpdir(), "obr-claims-"));
  try {
    await section("brainReady accepts a stable brain and refuses every other answer", async () => {
      ok((await brainReady(stub(() => ({ body: { tier: "stable" } })).fetch, CFG, KEY)).ok === true, "a brain answering tier=stable is ready");
      const noUrl = await brainReady(stub(() => ({})).fetch, { restUrl: null } as unknown as Config, KEY);
      ok(noUrl.ok === false && noUrl.detail.includes("no REST URL"), "no REST URL in the config is refused");
      const noKey = await brainReady(stub(() => ({})).fetch, CFG, null);
      ok(noKey.ok === false && noKey.detail.includes("SMD-4089"), "no brain key is refused, naming SMD-4089");
      const canary = await brainReady(stub(() => ({ body: { tier: "canary" } })).fetch, CFG, KEY);
      ok(canary.ok === false && canary.detail.includes("not stable"), "a canary brain is refused — the claim domain is stable's");
      ok((await brainReady(stub(() => ({ status: 503, body: {} })).fetch, CFG, KEY)).ok === false, "a non-200 /v1/brain is refused");
      ok((await brainReady(stub(() => ({ raw: "<html>" })).fetch, CFG, KEY)).ok === false, "a non-JSON /v1/brain is refused");
      ok((await brainReady(stub(() => ({ body: [] })).fetch, CFG, KEY)).ok === false, "a JSON array (not an object) is refused");
      ok((await brainReady(stub(() => ({ fail: true })).fetch, CFG, KEY)).ok === false, "a transport failure is refused, not thrown");
    });

    await section("claimWork maps each reply", async () => {
      const claimed = await claimWork(stub(() => ({ body: { outcome: "claimed", claim: row(), token: "wc_" + "a".repeat(64) } })).fetch, BASE, KEY, { ticket: "SMD-9", lease_seconds: 86400, label: "l" });
      ok(claimed.kind === "claimed" && claimed.token.startsWith("wc_") && claimed.claim.issue === "SMD-9" && claimed.ticketClosed === null, "a 200 claimed reply carries the claim and token, no ticketClosed");
      const held = await claimWork(stub(() => ({ status: 409, body: { code: "WORK_CLAIMED", heldBy: [{ id: "x", holder: "someone", holderKind: "agent", expiresAt: "t-end", ownKey: false, piece: "PR 1", token: "wc_secret" }] } })).fetch, BASE, KEY, { ticket: "SMD-9", lease_seconds: 86400, label: "l" });
      ok(held.kind === "work-claimed" && held.heldBy[0].holder === "someone" && held.heldBy[0].expiresAt === "t-end" && held.heldBy[0].ownKey === false, "409 WORK_CLAIMED names the holder, the lease end and whether it is the runner's own key");
      ok(held.kind === "work-claimed" && !("token" in held.heldBy[0]) && !("piece" in held.heldBy[0]), "the held-by entry carries no token (nor piece): only the fields the runner acts on");
      const closed = await claimWork(stub(() => ({ body: { outcome: "claimed", claim: row(), token: "wc_" + "e".repeat(64), ticketClosed: { status: "Done", statusType: "completed" } } })).fetch, BASE, KEY, { ticket: "SMD-9", lease_seconds: 86400, label: "l" });
      ok(closed.kind === "claimed" && closed.token.startsWith("wc_") && closed.ticketClosed?.statusType === "completed", "a claim on a closed ticket keeps its token and carries the ticketClosed object — never dropped unreleased");
      const forbidden = await claimWork(stub(() => ({ status: 403, body: { code: "FORBIDDEN" } })).fetch, BASE, KEY, { ticket: "SMD-9", lease_seconds: 86400, label: "l" });
      ok(forbidden.kind === "refused" && forbidden.code === "FORBIDDEN", "403 FORBIDDEN (a read key) is a refusal with its code");
      const ingest = await claimWork(stub(() => ({ status: 403, body: { code: "REFUSED_CLAIM_KEY" } })).fetch, BASE, KEY, { ticket: "SMD-9", lease_seconds: 86400, label: "l" });
      ok(ingest.kind === "refused" && ingest.code === "REFUSED_CLAIM_KEY", "403 REFUSED_CLAIM_KEY (an ingested key) is a refusal");
      const badInput = await claimWork(stub(() => ({ status: 400, body: { code: "REFUSED_CLAIM_INPUT", problem: "ticket" } })).fetch, BASE, KEY, { ticket: "bad", lease_seconds: 86400, label: "l" });
      ok(badInput.kind === "refused" && badInput.code === "REFUSED_CLAIM_INPUT" && badInput.detail.includes("ticket"), "400 REFUSED_CLAIM_INPUT names the problem field");
      const una = await claimWork(stub(() => ({ status: 503, body: { code: "CLAIM_UNATTRIBUTED", retryable: false } })).fetch, BASE, KEY, { ticket: "SMD-9", lease_seconds: 86400, label: "l" });
      ok(una.kind === "unattributed" && una.retryable === false, "503 CLAIM_UNATTRIBUTED with retryable=false (an operator must act)");
      const transport = await claimWork(stub(() => ({ fail: true })).fetch, BASE, KEY, { ticket: "SMD-9", lease_seconds: 86400, label: "l" });
      ok(transport.kind === "error" && transport.detail.includes("claim_work failed"), "a transport failure is an error reply, not a throw");
      const junk = await claimWork(stub(() => ({ raw: "not json" })).fetch, BASE, KEY, { ticket: "SMD-9", lease_seconds: 86400, label: "l" });
      ok(junk.kind === "error", "a 200 with a non-JSON body is an error reply");
    });

    await section("renewClaim maps each reply", async () => {
      const renewed = await renewClaim(stub(() => ({ body: { claim: row() } })).fetch, BASE, KEY, { id: "i", token: "wc_x", lease_seconds: 86400 });
      ok(renewed.kind === "renewed" && renewed.revived === null && renewed.ticketClosed === null, "a plain renewal has no revived or ticketClosed marker");
      const revived = await renewClaim(stub(() => ({ body: { claim: row(), lapsed: { at: "t0", claimedSince: [{ id: "o", holder: "other", ownKey: true, expiresAt: "t-end" }], moreSince: 2 } } })).fetch, BASE, KEY, { id: "i", token: "wc_x", lease_seconds: 86400 });
      ok(revived.kind === "renewed" && revived.revived?.lapsedAt === "t0" && revived.revived.others[0].holder === "other" && revived.revived.others[0].ownKey === true && revived.revived.others[0].expiresAt === "t-end" && revived.revived.unreadable === false && revived.revived.more === 2, "a revived lapse reads body.lapsed: when, the claims made meanwhile (holder, own-key, lease end), and how many more");
      const unread = await renewClaim(stub(() => ({ body: { claim: row(), lapsed: { at: "t0", claimedSince: null } } })).fetch, BASE, KEY, { id: "i", token: "wc_x", lease_seconds: 86400 });
      ok(unread.kind === "renewed" && unread.revived?.unreadable === true && unread.revived.others.length === 0, "a revived lapse whose meanwhile-claims are null is marked unreadable");
      const ended = await renewClaim(stub(() => ({ status: 409, body: { code: "CLAIM_RELEASED", ticketClosed: true } })).fetch, BASE, KEY, { id: "i", token: "wc_x", lease_seconds: 86400 });
      ok(ended.kind === "ended" && ended.ticketClosed === true, "409 CLAIM_RELEASED with ticketClosed=true means board-sync closed the ticket");
      const notYours = await renewClaim(stub(() => ({ status: 403, body: { code: "CLAIM_NOT_YOURS" } })).fetch, BASE, KEY, { id: "i", token: "wc_x", lease_seconds: 86400 });
      ok(notYours.kind === "refused" && notYours.code === "CLAIM_NOT_YOURS", "403 CLAIM_NOT_YOURS is a refusal");
      const notFound = await renewClaim(stub(() => ({ status: 404, body: { code: "CLAIM_NOT_FOUND" } })).fetch, BASE, KEY, { id: "i", token: "wc_x", lease_seconds: 86400 });
      ok(notFound.kind === "refused" && notFound.code === "CLAIM_NOT_FOUND", "404 CLAIM_NOT_FOUND is a refusal");
      const una = await renewClaim(stub(() => ({ status: 503, body: { code: "CLAIM_UNATTRIBUTED", retryable: true, lapsedAt: "t9" } })).fetch, BASE, KEY, { id: "i", token: "wc_x", lease_seconds: 86400 });
      ok(una.kind === "unattributed" && una.retryable === true && una.lapsedAt === "t9", "503 CLAIM_UNATTRIBUTED carries retryable and any lapsedAt");
    });

    await section("releaseClaim maps each reply", async () => {
      const released = await releaseClaim(stub(() => ({ body: { outcome: "released", claim: row({ state: "released" }) } })).fetch, BASE, KEY, { id: "i", token: "wc_x", reason: "merged" });
      ok(released.kind === "released" && released.alreadyEnded === false, "a 200 released reply");
      const already = await releaseClaim(stub(() => ({ body: { outcome: "already_released", claim: row({ state: "released" }) } })).fetch, BASE, KEY, { id: "i", token: "wc_x", reason: "merged" });
      ok(already.kind === "released" && already.alreadyEnded === true, "already_released is the release done (board-sync beat it)");
      // Release never answers CLAIM_RELEASED (an ended claim is 200 already_released, above); its real refusals are
      // CLAIM_NOT_FOUND/CLAIM_NOT_YOURS/REFUSED_CLAIM_INPUT/CLAIM_UNATTRIBUTED. The `ended` mapping is covered under renew.
      const una = await releaseClaim(stub(() => ({ status: 503, body: { code: "CLAIM_UNATTRIBUTED", retryable: false } })).fetch, BASE, KEY, { id: "i", token: "wc_x", reason: "merged" });
      ok(una.kind === "unattributed" && una.retryable === false, "503 CLAIM_UNATTRIBUTED on release (an operator must act): the release is left owed");
      const notYours = await releaseClaim(stub(() => ({ status: 403, body: { code: "CLAIM_NOT_YOURS" } })).fetch, BASE, KEY, { id: "i", token: "wc_x", reason: "merged" });
      ok(notYours.kind === "refused" && notYours.code === "CLAIM_NOT_YOURS", "403 CLAIM_NOT_YOURS on release is a refusal");
      const transport = await releaseClaim(stub(() => ({ fail: true })).fetch, BASE, KEY, { id: "i", token: "wc_x", reason: "merged" });
      ok(transport.kind === "error", "a transport failure on release is an error reply");
    });

    await section("the request carries the key in a header, never the URL, and follows no redirect", async () => {
      const s = stub(() => ({ body: { outcome: "claimed", claim: row(), token: "wc_x" } }));
      await claimWork(s.fetch, BASE, KEY, { ticket: "SMD-9", piece: "PR 1", lease_seconds: 86400, label: "lbl" });
      const call = s.calls[0];
      ok(call.url === `${BASE}/v1/claims` && !call.url.includes(KEY), "the key is not in the URL");
      ok((call.init.headers as Record<string, string>)["x-brain-key"] === KEY, "the key is in the x-brain-key header");
      ok(call.init.redirect === "manual", "the request does not follow a redirect (SAFE_REQUEST)");
      ok(call.init.method === "POST" && JSON.parse(String(call.init.body)).piece === "PR 1", "the body carries the claim's fields");
    });

    await section("a server message is masked and shortened: no token leaks into a reply detail", async () => {
      const r = await claimWork(stub(() => ({ status: 400, body: { code: "REFUSED_CLAIM_INPUT", message: "leaked wc_" + "d".repeat(64) } })).fetch, BASE, KEY, { ticket: "SMD-9", lease_seconds: 86400, label: "l" });
      ok(r.kind === "refused" && r.detail.includes("wc_…") && !/wc_[0-9a-f]{10}/.test(r.detail), "a wc_ token in a server message is masked in the detail");
    });

    await section("the token files round-trip, owner-only, never through a link", () => {
      const dir = claimsDir(fixture);
      const t = { id: "22222222-2222-4222-8222-222222222222", token: "wc_" + "b".repeat(64), ticket: "SMD-9", piece: "PR 1", lease_seconds: 86400 };
      writeToken(dir, t);
      ok(JSON.stringify(readToken(dir, t.id)) === JSON.stringify(t), "a token written is read back whole");
      ok((statSync(join(dir, `${t.id}.json`)).mode & 0o777) === 0o600, "the token file is 0600");
      writeToken(dir, { ...t, lease_seconds: 604800 });
      ok(readToken(dir, t.id).lease_seconds === 604800, "writing again updates the lease in place");

      const t2 = { id: "33333333-3333-4333-8333-333333333333", token: "wc_" + "c".repeat(64), ticket: "SMD-9", piece: null, lease_seconds: 86400 };
      writeToken(dir, t2);
      writeFileSync(join(dir, "44444444-not-a-token.json"), "{}\n", { mode: 0o600 });
      writeFileSync(join(dir, "notes.txt"), "ignored\n", { mode: 0o600 });
      const listed = listTokens(dir);
      ok(listed.tokens.length === 2 && listed.tokens.every((x) => x.token.startsWith("wc_")), "listTokens reads the valid tokens");
      ok(listed.unreadable.includes("44444444-not-a-token.json") && !listed.unreadable.includes("notes.txt"), "a malformed .json is reported, a non-.json file ignored");

      deleteToken(dir, t.id);
      ok(!existsSync(join(dir, `${t.id}.json`)), "deleteToken removes the file");
      deleteToken(dir, t.id);
      ok(true, "deleting a missing token file is a no-op, not an error");

      const linkId = "55555555-5555-4555-8555-555555555555";
      writeFileSync(join(fixture, "elsewhere.json"), JSON.stringify({ id: linkId, token: "wc_x", ticket: "SMD-9", lease_seconds: 1 }), { mode: 0o600 });
      symlinkSync(join(fixture, "elsewhere.json"), join(dir, `${linkId}.json`));
      let threw = false;
      try {
        readToken(dir, linkId);
      } catch {
        threw = true;
      }
      ok(threw, "readToken refuses a token file that is a symlink (O_NOFOLLOW)");
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }

  console.log(`${passed} passed, ${failed} failed`);
  console.log(failed ? `${failed} failed` : "all passed");
  return failed ? 1 : 0;
}

if (import.meta.main) {
  if (!process.argv.slice(2).includes("--self-check")) {
    console.error("usage: bun scripts/agent-runner/claims-check.ts --self-check");
    process.exit(2);
  }
  process.exit(await selfCheck());
}
