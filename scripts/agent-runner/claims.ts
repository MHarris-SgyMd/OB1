/**
 * claims.ts — the runner's claim client over the stable brain's REST core (SMD-4087 cut 2c-1; docs/agent-runner.md,
 * decision 6 and "A run, step by step" steps 3, 8 and the hand-back). The runner — not the agent session — holds the
 * claim: it claims a ticket (or one piece) before it creates the branch, renews while the session runs and before it
 * publishes, and releases at merge or hand-back. Every call goes to the REST core with the runner's agent-kind key in
 * the `x-brain-key` header, hermetic (no redirect followed, TLS verified, a timeout), the same shape cut 1's
 * `readClaims` uses to read. The `fetch` is injected, so the self-check drives every reply offline with no network.
 *
 * The token the brain returns proves the claim to anyone under the runner's key, so it is kept in a 0600 file under the
 * runner's own directory (`<RUNNER_DIR>/claims/<id>.json`, SMD-4089), beside the runner's secrets and outside every
 * clone and every worktree's `.work-claims/` (decision 6): a token in the clone would sit where the sandboxed agent
 * writes, and could be deleted, rewritten or committed and published.
 *
 * This cut is the client and its offline self-check; the orchestrator that calls it on a real run, with the real key
 * and a model, is cut 2c-3 (it needs SMD-4089's keys and stable's `/api`).
 */

import { closeSync, constants, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { SAFE_REQUEST, TIME_LIMITS, type Config, type Fetch } from "./facts.ts";

/** A claim as the REST core returns it. Only the fields the runner reads; the server may send more. */
export type ClaimRow = {
  id: string;
  issue: string;
  piece: string | null;
  holder: string;
  holderKind: string | null;
  label: string;
  claimedAt: string;
  renewedAt: string | null;
  expiresAt: string;
  releasedAt: string | null;
  releasedBy: string | null;
  releasedByKind: string | null;
  releaseReason: string | null;
  state: string;
};

/**
 * A claim named in a WORK_CLAIMED refusal, or made on the work while a claim had lapsed. The REST core sends the fields
 * CLAUDE.md step 2/4 acts on and no token: `ownKey` (the holder is the caller's own key — another session of it, or this
 * one without its token) and `expiresAt` (the lease end). It sends no label or piece.
 */
export type HeldBy = { id: string; holder: string; holderKind: string | null; ownKey: boolean; expiresAt: string | null };

/** A ticket the brain records as closed — Done, Canceled or a Duplicate (core `ClosedTicket`): board-sync releases its claims at its next pass. */
export type ClosedInfo = { status: string | null; statusType: string };

/**
 * A renewal that revived a lapsed claim (SMD-3654, core `ClaimLapse`): when it had lapsed (`lapsedAt`), the claims made
 * or renewed on its work since (`others` — another agent may have built it), whether those couldn't be read
 * (`unreadable`), and how many more there are than named (`more`). CLAUDE.md step 4: with any of these, stop and tell
 * the user before carrying on.
 */
export type Revived = { lapsedAt: string | null; others: HeldBy[]; unreadable: boolean; more: number };

/**
 * One reply from a claim operation, mapped from the REST core's status and body to the cases CLAUDE.md's "Claim your
 * work" step 4 acts on. The orchestrator (cut 2c-3) turns each into an action; this cut only names them.
 */
export type ClaimReply =
  /** A new claim: keep the token. `ticketClosed` is set when the ticket was already closed — the brain still minted the token, so the runner keeps it and releases the claim at once (docs step 3). */
  | { kind: "claimed"; claim: ClaimRow; token: string; ticketClosed: ClosedInfo | null }
  /** A renewed claim. `revived` is set when the renewal brought a lapsed claim back; `ticketClosed` when its ticket has since closed. */
  | { kind: "renewed"; claim: ClaimRow; revived: Revived | null; ticketClosed: ClosedInfo | null }
  /** A released claim. `alreadyEnded` is set when it had already ended (board-sync closed the ticket, or an operator released it). */
  | { kind: "released"; claim: ClaimRow | null; alreadyEnded: boolean; detail: string }
  /** The work is held by another live claim (409 WORK_CLAIMED): its holders are named. */
  | { kind: "work-claimed"; heldBy: HeldBy[]; detail: string }
  /** The claim has ended — released, or lapsed and taken over (409 CLAIM_RELEASED): stop work on it. `ticketClosed` true means board-sync ended it because the ticket closed (done if the work merged, else tell the user). */
  | { kind: "ended"; ticketClosed: boolean; detail: string }
  /** The registry can't attribute the claim to the key (503 CLAIM_UNATTRIBUTED). `retryable` false means an operator must act. `lapsedAt` is set when the claim had also lapsed. */
  | { kind: "unattributed"; retryable: boolean; lapsedAt: string | null; detail: string }
  /** Any other refusal the server coded: CLAIM_NOT_YOURS, FORBIDDEN, REFUSED_CLAIM_KEY, REFUSED_CLAIM_INPUT, REFUSED_INPUT, CLAIM_NOT_FOUND. */
  | { kind: "refused"; code: string; detail: string }
  /** A transport failure, a non-JSON body, or a status the client doesn't map: no claim state can be read from it. */
  | { kind: "error"; detail: string };

/** The token file the runner keeps for a claim, under `<RUNNER_DIR>/claims/`. */
export type StoredToken = { id: string; token: string; ticket: string; piece: string | null; lease_seconds: number };

/** What jsonOf answers for a body that isn't JSON, so a body that is the JSON `null` reads as itself (mirrors facts.ts). */
const NOT_JSON = Symbol("not JSON");

/** A response's JSON, or NOT_JSON. Never the parser's message, which would quote a body that can hold a key. */
async function jsonOf(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return NOT_JSON;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
/** A short, printable one-line fragment of a server message, never a token (`wc_…` masked). */
const detail = (s: string): string => {
  const t = s.replace(/wc_[0-9a-f]{6,}/gi, "wc_…").replace(/\s+/g, " ").trim();
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
};

/** A claim row from a body's field, or null if it isn't shaped like one (only `id` and `issue` are required to trust it). */
function rowOf(v: unknown): ClaimRow | null {
  if (!isObject(v) || typeof v.id !== "string" || typeof v.issue !== "string") return null;
  return v as unknown as ClaimRow;
}

/** A held-claim entry (a WORK_CLAIMED holder, or a claim made while this one lapsed), keeping only the fields the runner acts on and never a token. */
const heldOf = (v: unknown): HeldBy => {
  const h = isObject(v) ? v : {};
  return { id: str(h.id) ?? "", holder: str(h.holder) ?? "", holderKind: str(h.holderKind), ownKey: h.ownKey === true, expiresAt: str(h.expiresAt) };
};

/** The bare brain URL (no trailing slash), or null when the config names none. */
export const brainBase = (cfg: Config): string | null => (cfg.restUrl ? cfg.restUrl.replace(/\/+$/, "") : null);

/** The request init the claim calls share: the key in a header (never the URL), no redirect followed, TLS verified, a timeout. */
function init(key: string, method: "GET" | "POST", body?: unknown): RequestInit {
  return {
    ...SAFE_REQUEST,
    method,
    headers: { "x-brain-key": key, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(TIME_LIMITS.request),
  };
}

/**
 * Whether the stable brain is reachable and says it is stable (docs step 0): `GET /v1/brain` answers, is a JSON object,
 * and its tier is `stable`. The runner claims only once this holds; cut 1's `readClaims` makes the same check to read.
 */
export async function brainReady(fetchImpl: Fetch, cfg: Config, key: string | null): Promise<{ ok: true; base: string } | { ok: false; detail: string }> {
  const base = brainBase(cfg);
  if (!base) return { ok: false, detail: "the config names no REST URL for the stable brain" };
  if (!key) return { ok: false, detail: "there is no brain key in the runner's directory (SMD-4089)" };
  let res: Response;
  try {
    res = await fetchImpl(`${base}/v1/brain`, init(key, "GET"));
  } catch (e) {
    return { ok: false, detail: `GET ${base}/v1/brain failed: ${detail(String((e as Error)?.message ?? e))}` };
  }
  if (!res.ok) return { ok: false, detail: `${base}/v1/brain answered ${res.status}` };
  const body = await jsonOf(res);
  if (body === NOT_JSON) return { ok: false, detail: `${base}/v1/brain answered a body that isn't JSON` };
  if (!isObject(body)) return { ok: false, detail: `${base}/v1/brain answered JSON that isn't an object` };
  const tier = str(body.tier);
  if (tier !== "stable") return { ok: false, detail: `the brain at ${base} says its tier is ${tier ?? "unset"}, not stable` };
  return { ok: true, base };
}

/** Map a claim response the ops didn't take as a success — any non-2xx, or a 200 whose body isn't the shape they expect — to a ClaimReply, by its coded body. */
function refusal(status: number, body: unknown): ClaimReply {
  const b = isObject(body) ? body : {};
  const code = str(b.code) ?? "";
  const message = str(b.message) ?? str(b.problem) ?? `status ${status}`;
  if (code === "WORK_CLAIMED") {
    const heldBy = Array.isArray(b.heldBy) ? b.heldBy.map(heldOf) : [];
    return { kind: "work-claimed", heldBy, detail: detail(message) };
  }
  if (code === "CLAIM_RELEASED") return { kind: "ended", ticketClosed: b.ticketClosed === true, detail: detail(message) };
  if (code === "CLAIM_UNATTRIBUTED") return { kind: "unattributed", retryable: b.retryable === true, lapsedAt: str(b.lapsedAt), detail: detail(message) };
  if (code === "CLAIM_NOT_YOURS" || code === "FORBIDDEN" || code === "REFUSED_CLAIM_KEY" || code === "REFUSED_CLAIM_INPUT" || code === "REFUSED_INPUT" || code === "CLAIM_NOT_FOUND") {
    return { kind: "refused", code, detail: detail(message) };
  }
  return { kind: "error", detail: detail(code ? `${code}: ${message}` : `the brain answered ${status}: ${message}`) };
}

/** The `ticketClosed` field of a 2xx claim/renew result, as the core serializes it (`{status, statusType}`), or null. */
function closedOf(v: unknown): ClosedInfo | null {
  if (!isObject(v)) return null;
  const statusType = str(v.statusType);
  if (statusType === null) return null;
  return { status: str(v.status), statusType };
}

/** The revived-lapse from a 2xx renew result's `lapsed` field (core `ClaimLapse` `{at, claimedSince, moreSince}`), or null for a renewal of a live claim. */
function revivedOf(v: unknown): Revived | null {
  if (!isObject(v)) return null;
  const since = v.claimedSince;
  const others = Array.isArray(since) ? since.map(heldOf) : [];
  return { lapsedAt: str(v.at), others, unreadable: since === null, more: typeof v.moreSince === "number" ? v.moreSince : 0 };
}

/** Perform one claim request and read its reply, never throwing: a transport failure is an `error` reply. */
async function call(fetchImpl: Fetch, url: string, requestInit: RequestInit): Promise<{ status: number; body: unknown } | { error: string }> {
  try {
    const res = await fetchImpl(url, requestInit);
    return { status: res.status, body: await jsonOf(res) };
  } catch (e) {
    return { error: detail(String((e as Error)?.message ?? e)) };
  }
}

/**
 * Claim a ticket, or one piece of it, before the branch is made (docs step 3). `piece` is omitted for the whole ticket.
 * Returns the claim and its token to keep, or the reason it was refused. The caller writes the token file (`writeToken`).
 */
export async function claimWork(fetchImpl: Fetch, base: string, key: string, input: { ticket: string; piece?: string; lease_seconds: number; label: string }): Promise<ClaimReply> {
  const body = { ticket: input.ticket, ...(input.piece === undefined ? {} : { piece: input.piece }), lease_seconds: input.lease_seconds, label: input.label };
  const r = await call(fetchImpl, `${base}/v1/claims`, init(key, "POST", body));
  if ("error" in r) return { kind: "error", detail: `claim_work failed: ${r.error}` };
  if (r.status === 200 && isObject(r.body)) {
    const claim = rowOf(r.body.claim);
    const token = str(r.body.token);
    // A ticket already closed still mints a token (the claim is made): keep it and release at once (docs step 3), never drop it unreleased.
    if (claim && token) return { kind: "claimed", claim, token, ticketClosed: closedOf(r.body.ticketClosed) };
    return { kind: "error", detail: "claim_work answered 200 in a shape the runner doesn't know" };
  }
  return refusal(r.status, r.body);
}

/**
 * Renew a claim's lease (docs steps 5 and 8): the id and the token, and the lease to renew with. A reply that revived a
 * lapsed claim names when it had lapsed and any claim made or renewed on its work since (CLAUDE.md step 4).
 */
export async function renewClaim(fetchImpl: Fetch, base: string, key: string, input: { id: string; token: string; lease_seconds: number }): Promise<ClaimReply> {
  const r = await call(fetchImpl, `${base}/v1/claims/${encodeURIComponent(input.id)}/renew`, init(key, "POST", { token: input.token, lease_seconds: input.lease_seconds }));
  if ("error" in r) return { kind: "error", detail: `renew_claim failed: ${r.error}` };
  if (r.status === 200 && isObject(r.body)) {
    const claim = rowOf(r.body.claim);
    if (!claim) return { kind: "error", detail: "renew_claim answered 200 in a shape the runner doesn't know" };
    return { kind: "renewed", claim, revived: revivedOf(r.body.lapsed), ticketClosed: closedOf(r.body.ticketClosed) };
  }
  return refusal(r.status, r.body);
}

/**
 * Release a claim at merge or hand-back (docs steps 9 and 12): the id, the token, and a reason. A claim board-sync
 * already ended answers `already_released`, which is the release done; the caller then deletes the token file.
 */
export async function releaseClaim(fetchImpl: Fetch, base: string, key: string, input: { id: string; token: string; reason: string }): Promise<ClaimReply> {
  const r = await call(fetchImpl, `${base}/v1/claims/${encodeURIComponent(input.id)}/release`, init(key, "POST", { token: input.token, reason: input.reason }));
  if ("error" in r) return { kind: "error", detail: `release_claim failed: ${r.error}` };
  if (r.status === 200 && isObject(r.body)) {
    const outcome = str(r.body.outcome);
    if (outcome === "released" || outcome === "already_released") {
      return { kind: "released", claim: rowOf(r.body.claim), alreadyEnded: outcome === "already_released", detail: detail(str(r.body.message) ?? outcome) };
    }
    return { kind: "error", detail: "release_claim answered 200 in a shape the runner doesn't know" };
  }
  return refusal(r.status, r.body);
}

// ── The token files, under <RUNNER_DIR>/claims/ (decision 6) ──────────────────────────────────────────────────────

/** The directory the runner keeps its claim tokens in, beside its secrets. */
export const claimsDir = (runnerDir: string): string => join(runnerDir, "claims");

/** The token's file path. The id is a uuid from the brain, so it is a safe file name; a stored file's name is never trusted as one. */
const tokenFile = (dir: string, id: string): string => join(dir, `${id}.json`);

/**
 * Write a claim's token to `<claimsDir>/<id>.json`, owner-only, never through a link. The directory is made 0700 first.
 * Called as soon as the brain answers `claimed` (docs step 3), and again when the lease changes (a week at the PR).
 */
export function writeToken(dir: string, t: StoredToken): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openSync(tokenFile(dir, t.id), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, `${JSON.stringify(t)}\n`);
  } finally {
    closeSync(fd);
  }
}

/** Read a claim's token file, never through a link; throws if it isn't there or isn't a token. */
export function readToken(dir: string, id: string): StoredToken {
  const fd = openSync(tokenFile(dir, id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let text: string;
  try {
    text = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  const parsed: unknown = JSON.parse(text);
  if (!isObject(parsed) || typeof parsed.id !== "string" || typeof parsed.token !== "string" || typeof parsed.ticket !== "string" || typeof parsed.lease_seconds !== "number") {
    throw new Error(`not a claim token file: ${tokenFile(dir, id)}`);
  }
  return { id: parsed.id, token: parsed.token, ticket: parsed.ticket, piece: str(parsed.piece), lease_seconds: parsed.lease_seconds };
}

/** Every stored token, read on resume to renew or release each (docs step 0). An unreadable or malformed file is skipped, its name returned. */
export function listTokens(dir: string): { tokens: StoredToken[]; unreadable: string[] } {
  const tokens: StoredToken[] = [];
  const unreadable: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { tokens, unreadable };
  }
  for (const name of names) {
    const m = /^(.+)\.json$/.exec(name);
    if (!m) continue;
    try {
      tokens.push(readToken(dir, m[1]));
    } catch {
      unreadable.push(name);
    }
  }
  return { tokens, unreadable };
}

/** Delete a claim's token file once its release has landed (CLAUDE.md step 6). A missing file is already gone, not an error. */
export function deleteToken(dir: string, id: string): void {
  try {
    unlinkSync(tokenFile(dir, id));
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
  }
}
