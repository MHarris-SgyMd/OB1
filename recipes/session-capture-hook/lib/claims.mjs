/**
 * lib/claims.mjs — the session hook's work-claim renewal (SMD-3602; moved here
 * by SMD-4338): the token files a worktree keeps, a renewal through the
 * brain's claim key, the markers left beside a token file, the check before a
 * lapsed claim is revived, the claims hook's look at the agent's own claim
 * calls, and --check's lines for a claim key.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, renameSync, openSync, closeSync, statSync, lstatSync, fstatSync, fchmodSync, realpathSync, constants as fsConstants } from "node:fs";
import { join, basename, isAbsolute, dirname } from "node:path";
import { spawn } from "node:child_process";
import { UUID, oneLine, shownUrl } from "./util.mjs";
import { CONFIG_PATH, LOG_PATH, SELF, STATE_DIR, ensureDirs, log, useStateRoot } from "./state.mjs";
import { SDK_ERROR_RE, resultText, rpc, textOfResult } from "./rpc.mjs";
import { CONNECTOR_RE } from "./config.mjs";

// ── Work claims (SMD-3602) ───────────────────────────────────────────────────
//
// An agent claims its ticket on the brain before it makes the branch
// (claim_work, SMD-3598) and keeps the token in `.work-claims/<claim id>.json`
// at its worktree's root, git-ignored, mode 600. The hook renews each claim
// whose token the session's worktree holds, through the config's `claim_key`
// — the very key the agent claims with: at a compaction and a session's end,
// and, with the `--claims` hook pasted, at most hourly while tools run and
// prompts arrive. It never claims (a branch for a ticket and a scratch branch
// look alike) and never releases (a session can end with its PR open): a claim
// ends at its release, or lapses when nothing renews it. The agent renews too;
// the hook is the backstop. What the agent must hear, it leaves beside the token
// file: `<id>.ended.json` when the claim ended, `<id>.blocked.json` when another
// claim covered its work, at a renewal of the hook's or the agent's own (read
// from the claims hook's PostToolUse and PostToolUseFailure), or while it
// lapsed — checked before the hook revives a claim it knows lapsed (lapseCheck).

export const CLAIMS_DIRNAME = ".work-claims";
const CLAIM_TOKEN_RE = /^wc_[0-9a-f]{64}$/i;
const UUID_ONLY_RE = new RegExp(`^${UUID}$`, "i");
const CLAIM_FILE_RE = new RegExp(`^(${UUID})\\.json$`, "i");
/** Any token-shaped run, masked out of what the hook says — a server's words, a ticket, a path (review pass 1: an echo reached the log). */
const scrubTokens = (s) => String(s).replace(/wc\\?_[0-9a-f]{8,}/gi, "wc_[masked]");
/** The server's default lease (migration 115), which a renewal without lease_seconds sets. */
const DEFAULT_LEASE_S = 14_400;
/** How often a working session renews a claim: a quarter of its lease, between one minute and an hour. */
export const renewEveryMs = (leaseS) => Math.min(60, Math.max(1, leaseS / 240)) * 60_000;
/** A checkpoint renews whatever was not attempted in the last minute. */
const CHECKPOINT_RENEW_MS = 60_000;
const CLAIM_STATE_DIR = () => join(STATE_DIR, "claims");
const claimStatePath = (id) => join(CLAIM_STATE_DIR(), `${id}.json`);
function readClaimState(id) { try { return JSON.parse(readFileSync(claimStatePath(id), "utf8")); } catch { return {}; } }
function writeClaimState(id, st) {
  try { mkdirSync(CLAIM_STATE_DIR(), { recursive: true, mode: 0o700 }); writeFileSync(claimStatePath(id), JSON.stringify(st), { mode: 0o600 }); } catch { /* a stamp failure only means an earlier renewal */ }
}
const lstatOf = (p) => { try { return lstatSync(p); } catch { return null; } };

/**
 * The worktree holding `dir`, its symlinks resolved: the nearest directory up
 * with a `.git` (a checkout's directory, a worktree's file); null outside one.
 * The nearest, always: this repo's worktrees live inside its main checkout,
 * and a walk past a worktree's own `.git` renewed the checkout's claims from
 * every sibling session (review pass 2, undoing pass 1's walk past a nested repo).
 */
export function worktreeRoot(dir) {
  if (typeof dir !== "string" || !isAbsolute(dir)) return null;
  let d = dir;
  try { d = realpathSync(dir); } catch { /* gone: walk the path as given */ }
  for (;; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return null;
  }
}

/**
 * The token files a worktree holds: `{ path, claim }`, or `{ path, bad }`
 * naming what is wrong — never the token. Only `<claim id>.json`, a regular
 * file of one link in a real directory, read through a handle opened without
 * following a link: a symlink (review pass 1) or a hardlink (review pass 4)
 * could point the hook's change at another file or send another tree's token.
 * A claim keeps the file's device and inode, so a later change acts on that
 * same file or on none. Markers the hook writes (`.ended.json`,
 * `.blocked.json`) are passed over.
 */
export function claimFiles(root) {
  const dir = join(root, CLAIMS_DIRNAME);
  const st = lstatOf(dir);
  if (!st) return [];
  if (!st.isDirectory()) return [{ path: dir, bad: st.isSymbolicLink() ? "a symlink, not a directory: make it a directory of its own" : "not a directory" }];
  let names;
  try { names = readdirSync(dir); } catch (e) { return [{ path: dir, bad: `unreadable (${e?.code ?? "error"})` }]; }
  return names.filter((n) => n.endsWith(".json") && !n.endsWith(".ended.json") && !n.endsWith(".blocked.json")).sort().map((n) => {
    const path = join(dir, n);
    const named = CLAIM_FILE_RE.exec(n)?.[1]?.toLowerCase();
    if (!named) return { path: join(dir, scrubTokens(n)), bad: "not named <claim id>.json" };
    let fd, raw, file;
    try {
      fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
      file = fstatSync(fd);
      if (!file.isFile() || file.nlink !== 1) return { path, id: named, bad: "not a regular file of one link (a symlink or a hardlink?)" };
      raw = readFileSync(fd, "utf8");
    } catch (e) {
      return { path, id: named, bad: e?.code === "ELOOP" || e?.code === "EMLINK" ? "not a regular file of one link (a symlink or a hardlink?)" : `unreadable (${e?.code ?? "error"})` };
    } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
    let c;
    try { c = JSON.parse(raw); } catch { return { path, id: named, bad: "not JSON" }; }
    if (!c || typeof c !== "object" || Array.isArray(c)) return { path, id: named, bad: "not a JSON object" };
    if (typeof c.id !== "string" || !UUID_ONLY_RE.test(c.id)) return { path, id: named, bad: `no claim id (a uuid) in "id"` };
    if (c.id.toLowerCase() !== named) return { path, id: named, bad: `its "id" is not the claim its name says` };
    if (typeof c.token !== "string" || !CLAIM_TOKEN_RE.test(c.token)) return { path, id: named, bad: `no token (wc_ and 64 hex digits) in "token"` };
    if (c.lease_seconds != null && !(Number.isInteger(c.lease_seconds) && c.lease_seconds >= 60 && c.lease_seconds <= 604_800)) return { path, id: named, bad: `a "lease_seconds" that is not 60 to 604800` };
    if (c.server == null) return { path, id: named, bad: `no "server": the MCP server the claim was made through, which picks the brain it is renewed on` };
    if (!(typeof c.server === "string" && CONNECTOR_RE.test(c.server))) return { path, id: named, bad: `a "server" that is no MCP server's name` };
    const text = (v) => (typeof v === "string" && v.trim() ? scrubTokens(oneLine(v)).slice(0, 100) : undefined);
    return { path, claim: { id: named, token: c.token.toLowerCase(), ticket: text(c.ticket), piece: text(c.piece), lease: c.lease_seconds ?? undefined, server: c.server, dev: file.dev, ino: file.ino } };
  });
}

/** A claim as the log names it: its work and its id, never its token. */
const claimLabel = (c) => `${c.ticket ? `${c.ticket}${c.piece ? ` ${c.piece}` : ""} ` : ""}(claim ${c.id})`;
/** The marker beside a token file: `<id>.ended.json`, `<id>.blocked.json`. */
const markerPath = (path, kind) => path.replace(/\.json$/, `.${kind}.json`);

/**
 * The brain a claim is renewed on: the one whose `connector` is the token
 * file's `server`, if it has a claim key — one brain or several, the same
 * rule, so a token goes to no brain that did not issue it. Passes 1 and 2 each
 * special-cased a shape and each leaked or skipped (review pass 3). A skip says
 * which: no brain with that connector, its claim key missing or unreadable
 * (review pass 4), or OB1_BRAIN_URL's brain. `{ brain }` or `{ skip }`.
 */
function brainForClaim(claim, brains) {
  const b = brains.find((x) => x.cfg.connector === claim.server);
  if (b?.cfg.claimKey) return { brain: b };
  if (b) return { skip: b.cfg.claimKeyError ? `claims are off on brain "${b.name}": ${b.cfg.claimKeyError}` : `brain "${b.name}" (connector "${claim.server}") has no claim_key` };
  if (process.env.OB1_BRAIN_URL) return { skip: `OB1_BRAIN_URL is set, and its brain renews no claims (it has no connector to match "${claim.server}")` };
  // Both said at once: fixing the connector should not be what reveals the claim key's own fault (review pass 5).
  const off = brains.find((x) => x.cfg.claimKeyError);
  return { skip: `no brain in ${CONFIG_PATH} has connector "${claim.server}" — give the brain your agents claim through that connector and a claim_key${off ? `; claims are also off on brain "${off.name}": ${off.cfg.claimKeyError}` : ""}` };
}

/** A call the key may not make, as the server answers it: a JSON-RPC -32602 envelope (what the real server sends, review pass 4) or an isError result in the SDK's words. */
const TOOL_REFUSED_RE = /\bTool \S+ (?:not found|disabled)\b/;
/** A renewal's words when it revived a lapsed claim after claims were made or renewed on its work, or couldn't read them, or couldn't read whether it had lapsed (the server's since SMD-3654). */
const REVIVED_COVERED_RE = /\b(?:It had lapsed at \S+, and (?:since then .* made or renewed on its work|the claims made or renewed on its work since could not be read)|Whether it had lapsed could not be read)\b/;
/** A claim's ticket or piece as 115 compares it: control characters made spaces, soft hyphen and zero-width marks gone, runs of white space one, trimmed, case-folded. */
const cleanWork = (v) => String(v ?? "").replace(/\p{Cc}/gu, " ").replace(/[\u00AD\u200B\u2060\uFEFF]/g, "").replace(/\s+/gu, " ").trim().toLowerCase();
/** A renewal's log note for a lapse nothing was claimed or renewed in, from the reply or the hook's own check; renewOne looks for its head so it is said once. */
const QUIET_LAPSE_HEAD = " (it had lapsed at ";
const quietLapse = (at) => `${QUIET_LAPSE_HEAD}${at}; no other claim was made or renewed on its work meanwhile)`;
/** A marker's words, cut where a marker is, saying so: a cut list of claims read as the whole one (review pass 2; WORK_CLAIMED's too, review pass 3). */
const markerSaid = (s) => s.length <= 600 ? s : `${s.slice(0, 540)}… (cut here: list_claims with include_ended shows every claim)`;
/** A time as the server writes one, and a real one (isTime), nothing else: it goes into the log and the hook's record. */
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const isTime = (v) => typeof v === "string" && ISO_TIME_RE.test(v) && Number.isFinite(Date.parse(v));
/**
 * When CLAIM_UNATTRIBUTED says the claim `id` had lapsed (SMD-3705): its
 * `lapsedAt`, from the reply's facts, else from its words, for a harness that
 * hands a hook the text alone. Undefined for another claim's, or none.
 */
function unattributedLapse(sc, text, id) {
  let at;
  if (sc?.code === "CLAIM_UNATTRIBUTED") at = String(sc.id).toLowerCase() === id ? sc.lapsedAt : undefined;
  else {
    const m = new RegExp(`^Refused: claim (${UUID}) was made under this key's agent id\\b.*? It had lapsed at (\\S+?), and stays lapsed until a renewal lands\\b`, "i").exec(text);
    at = m && m[1].toLowerCase() === id ? m[2] : undefined;
  }
  // Past, give or take five minutes of the two clocks' skew: one further off is no lapse (review pass 3).
  return isTime(at) && Date.parse(at) <= Date.now() + 300_000 ? at : undefined;
}
/** CLAIM_UNATTRIBUTED in the log, from the reply's facts: the brain's words run past markerSaid's cut once a lapse is in them (SMD-3807). */
const unattributedSaid = (cause, lapsedAt) => `CLAIM_UNATTRIBUTED (${cause}): the agent registry ${cause === "registry_away" ? "did not give the claim key's agent id just now; renewals retry" : "cannot give the claim key's agent id until an operator acts (the server's log says why): tell the user"}${lapsedAt ? `; it had lapsed at ${lapsedAt}, and until a renewal lands a claim on exactly its work can take it over` : ""}`;
/** A tool result's structuredContent, from any shape resultText reads; undefined without one. */
function resultFacts(resp) {
  if (typeof resp === "string") { try { return resultFacts(JSON.parse(resp)); } catch { return undefined; } }
  if (!resp || typeof resp !== "object" || Array.isArray(resp)) return undefined;
  const sc = resp.structuredContent ?? resultFacts(resp.result);
  return sc && typeof sc === "object" && !Array.isArray(sc) ? sc : undefined;
}
const toolRefused = (text) => (SDK_ERROR_RE.test(text) || /^JSON-RPC -3260[12]\b/.test(text)) && TOOL_REFUSED_RE.test(text);

/**
 * One renewal through the brain's claim key. `ok` with the new expiry;
 * `ended` — the claim was released, by its holder, an operator, or a takeover
 * after it lapsed (stop work on it); `blocked` — WORK_CLAIMED: lapsed while
 * another claim covers its work, which 115 renews once that claim ends, so the
 * token is kept but the agent must be told before it renews again (review
 * passes 1 and 4); `keep` — anything else, the token kept: the brain away, the
 * registry away, a key that is not the holder's, a claim this brain does not
 * have. Each with a line for the log: the code first, the token never.
 */
export async function renewClaim(cfg, claim) {
  const what = claimLabel(claim);
  const cannot = { keep: true, line: `kept: ${what} — the claim key cannot call renew_claim: a key without write scope, or a brain from before SMD-3598` };
  let result;
  try { result = await rpc({ ...cfg, key: cfg.claimKey }, "tools/call", { name: "renew_claim", arguments: { id: claim.id, token: claim.token, ...(claim.lease ? { lease_seconds: claim.lease } : {}) } }, 15_000); }
  catch (e) {
    const msg = String(e?.message ?? e);
    return toolRefused(msg) ? cannot : { keep: true, line: `kept: ${what} — ${scrubTokens(oneLine(msg)).slice(0, 200)}` };
  }
  const text = textOfResult(result);
  if (!result?.isError) {
    // A time, or none: a brain's words go into the state and the log unmasked (review pass 3).
    const at = [result?.structuredContent?.claim?.expiresAt, /\buntil (\S+)/.exec(text)?.[1]].find(isTime);
    const o = { ok: true, expiresAt: at, line: `renewed ${what}${at ? ` until ${at}` : ""}` };
    // Renewed, but it had lapsed and claims were made on its work meanwhile (or they, or whether it had lapsed, couldn't be read) — the server
    // says so since SMD-3654: renewed, and marked as a covered claim is, so the agent hears it before carrying on.
    const lapsed = result?.structuredContent?.lapsed;
    if (lapsed && (lapsed.at === null || lapsed.claimedSince === null || (Array.isArray(lapsed.claimedSince) && lapsed.claimedSince.length))) {
      const said = markerSaid(`CLAIMED_WHILE_LAPSED: ${scrubTokens(oneLine(text))}`);
      return { ...o, blocked: { code: "CLAIMED_WHILE_LAPSED", message: said }, line: `${o.line} — but ${said.replace(new RegExp(`^CLAIMED_WHILE_LAPSED: Renewed your claim .*?\\(claim ${UUID}\\)\\.\\s*`, "i"), "").replace(/^(It|Whether) /, (w) => w.toLowerCase())} (renewals wait until the .blocked.json beside its token file is deleted)` };
    }
    // A lapse with nothing since is said in the log too: the agent's own renewal after it sees a live claim, and the
    // rule's search after a lapse needs to know there was one (review pass 2).
    if (lapsed && typeof lapsed.at === "string") o.line += quietLapse(lapsed.at);
    return o;
  }
  const code = typeof result?.structuredContent?.code === "string" ? result.structuredContent.code : undefined;
  // Long enough for the server's last sentence (review pass 4: 300 cut "Your claim lapsed before another covered its work").
  const said = markerSaid(`${code ? `${code}: ` : ""}${scrubTokens(oneLine(text))}`);
  if (toolRefused(text)) return cannot;
  if (code === "CLAIM_RELEASED") return { ended: { code, message: said }, line: `ended: ${what} — ${said}` };
  if (code === "WORK_CLAIMED") return { whole: scrubTokens(oneLine(text)), blocked: { code, message: said }, line: `blocked: ${what} — ${said} (stop work and tell the user; a .blocked.json beside its token file says so, and renewals wait until it is deleted)` };
  // The registry away: a lapse it reports is recorded and checked (renewOne, SMD-3807). An error with no facts at all,
  // an SDK's or another server's, is kept below (review pass 1: it threw, and the claims after it went unrenewed).
  const cause = result.structuredContent?.cause;
  if (code === "CLAIM_UNATTRIBUTED" && typeof cause === "string" && /^[a-z_]{1,40}$/.test(cause)) {
    const lapsedAt = unattributedLapse(result.structuredContent, text, claim.id);
    return { keep: true, lapsedAt, cause, line: `kept: ${what} — ${unattributedSaid(cause, lapsedAt)}` };
  }
  if (code === "CLAIM_NOT_YOURS") return { keep: true, line: `kept: ${what} — ${said}${result.structuredContent.ownKey ? "" : " (claim_key must be the very key the agent claimed with — its connector's own)"}` };
  if (code === "CLAIM_NOT_FOUND") return { keep: true, line: `kept: ${what} — ${said} (the brain whose connector is "${claim.server}" has no such claim: was it made through another server?)` };
  return { keep: true, line: `kept: ${what} — ${said}` };
}

/** The token a token file holds now, read through a handle that follows no link and opens only a regular file; "" when it can't be read. */
function tokenNow(path) {
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return "";
    return String(JSON.parse(readFileSync(fd, "utf8"))?.token ?? "").toLowerCase();
  } catch { return ""; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
}

/**
 * A marker beside the token file — `<id>.<kind>.json` with the work, the code,
 * the brain's words and when, never the token — written to a fresh file,
 * created exclusively, and renamed into place, so a symlink planted at either
 * name is refused or replaced, never followed (review pass 1). Only while the
 * token file still holds the token the call was made with, read through a
 * no-follow handle. Not tied to the inode read: an agent rewriting the file
 * mid-call (step 5's lease, `jq … > tmp && mv`) gives it a new one, and a lost
 * blocked marker let the claim be revived silently (review pass 5).
 */
function writeMarker(path, claim, kind, body) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    if (tokenNow(path) !== claim.token) return false;
    writeFileSync(tmp, `${JSON.stringify({ id: claim.id, ticket: claim.ticket, piece: claim.piece, [kind]: { ...body, at: new Date().toISOString() } }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tmp, markerPath(path, kind));
    return true;
  } catch {
    try { unlinkSync(tmp); } catch { /* none */ }
    return false;
  }
}

/** An ended claim's token file becomes `<id>.ended.json`, the token dropped: it proves nothing now. Whether it was ended. */
function endClaimFile(path, claim, ended) {
  if (!writeMarker(path, claim, "ended", ended)) return false;
  try { unlinkSync(path); } catch { /* gone */ }
  return true;
}

/**
 * Close `p` to `mode` if others can read it, through a handle opened with
 * O_NOFOLLOW and O_NONBLOCK (and `extra`, O_DIRECTORY for the directory):
 * fstat and fchmod act on what was opened — a regular file or a directory,
 * never a symlink's target or a FIFO (review passes 2 and 3) — and a file only
 * when it is the one the claim was read from, one link, same inode (review
 * pass 4: a hardlink swapped in lent it another file). Whether it changed anything.
 */
function closeUp(p, mode, extra, claim) {
  let fd;
  try {
    fd = openSync(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | extra);
    const st = fstatSync(fd);
    if (!(st.isFile() || st.isDirectory()) || !(st.mode & 0o077)) return false;
    if (claim && (st.nlink !== 1 || st.dev !== claim.dev || st.ino !== claim.ino)) return false;
    fchmodSync(fd, mode);
    return true;
  } catch { return false; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
}

/** Two claims' work overlaps: the same piece, or either is the whole ticket — 115's rule, by the pieces' words (case folded, white space collapsed). */
const pieceKey = (p) => (typeof p === "string" ? p.trim().replace(/\s+/g, " ").toLowerCase() : "");
const overlaps = (a, b) => !pieceKey(a.piece) || !pieceKey(b.piece) || pieceKey(a.piece) === pieceKey(b.piece);

/** A note for a blocked line whose claim in the way is this worktree's own (its id among the token files): the rule says release the older one (review pass 5). */
function ownPieceNote(text, root, claimId) {
  const own = new Set(claimFiles(root).map((f) => f.claim?.id).filter(Boolean));
  const mine = [...String(text).matchAll(new RegExp(UUID, "gi"))].map((m) => m[0].toLowerCase()).find((id) => id !== claimId && own.has(id));
  return mine ? ` The claim in the way, ${mine}, is this worktree's own: release the older claim and delete its files.` : "";
}

/**
 * Before reviving a claim the hook's own record shows lapsed — its last known
 * expiry past — list the ticket's claims, ended ones included: a brain from
 * before SMD-3654 revives a lapsed claim without saying so, and the hook's
 * renewal at a resuming prompt would otherwise erase the lapse the rule's check
 * looks for (review pass 5, against a real server). Live (the agent renewed it)
 * or lapsed with no claim on overlapping work made or renewed since: renew. A
 * claim made before the lapse and revived during it counts (review pass 2 of
 * SMD-3654: it was missed). Lapsed with one: `blocked`, the marker written as
 * for WORK_CLAIMED, naming each claim's id and its state so the agent can
 * match it against the claim named after the user's decision. Can't tell:
 * `keep`, its line, and `reason`, why alone, for a line of renewOne's own
 * (SMD-3807 review pass 2: a " — " in a piece split the line). `markerNote`
 * goes into the marker after "not renewed", ahead of its cut: an operator's
 * part, when the renewal just tried met the registry waiting on one.
 */
async function lapseCheck(cfg, claim, knownExpiry, markerNote = "") {
  if (!claim.ticket) return { note: ` (its token file names no ticket, so claims made while it lapsed at ${knownExpiry} were not checked)` };
  const unchecked = (reason) => ({ keep: `kept: ${claimLabel(claim)} — its record shows it lapsed at ${knownExpiry}, and ${reason}`, reason });
  let result;
  try { result = await rpc({ ...cfg, key: cfg.claimKey }, "tools/call", { name: "list_claims", arguments: { ticket: claim.ticket, include_ended: true, limit: 1000 } }, 15_000); }
  catch (e) { return unchecked(`the claims made since could not be listed: ${scrubTokens(oneLine(String(e?.message ?? e))).slice(0, 200)}`); }
  let claims = result?.structuredContent?.claims;
  if (!Array.isArray(claims)) { try { claims = JSON.parse(textOfResult(result)).claims; } catch { claims = undefined; } }
  if (result?.isError || !Array.isArray(claims)) return unchecked(`list_claims gave no list to check: ${scrubTokens(oneLine(textOfResult(result))).slice(0, 200)}`);
  const mine = claims.find((c) => String(c?.id).toLowerCase() === claim.id);
  if (!mine) return unchecked(`list_claims for ${claim.ticket} doesn't list it`);
  if (mine.state !== "lapsed") return {};
  const lapsedAt = Date.parse(mine.expiresAt);
  const since = claims.filter((c) => String(c?.id).toLowerCase() !== claim.id && (Date.parse(c?.claimedAt) > lapsedAt || Date.parse(c?.renewedAt) > lapsedAt) && overlaps(c, mine));
  // Lapsed with nothing since: renewed, and the log says it had lapsed, as a brain since SMD-3654 says it (review pass 3: on an older brain it was a plain renewal).
  if (!since.length) return { quiet: quietLapse(mine.expiresAt) };
  // "not renewed" in the marker itself: the agent reads the file, not the log, to know it must renew after a carry-on (review pass 3).
  const said = markerSaid(scrubTokens(`CLAIMED_WHILE_LAPSED: not renewed${markerNote}; lapsed at ${mine.expiresAt}; since then ${since.map((c) => `${oneLine(String(c.holder ?? "?")).slice(0, 80)} claimed ${claim.ticket}${c.piece ? ` ${JSON.stringify(oneLine(String(c.piece)).slice(0, 100))}` : ""} at ${c.claimedAt}${c.renewedAt ? `, renewed at ${c.renewedAt}` : ""} (now ${c.state}, claim ${String(c.id).toLowerCase()})`).join("; ")}`));
  return { blocked: { code: "CLAIMED_WHILE_LAPSED", message: said }, line: `blocked: ${claimLabel(claim)} — ${said} (not renewed: another agent may have built part of the work; tell the user, and delete the .blocked.json beside its token file on their decision)` };
}

async function renewOne(b, path, claim) {
  useStateRoot(b.root);
  // The hook owns the file it renews from: one a Write tool left at 644, or a
  // directory others can list, is closed first (review pass 1).
  const closed = [];
  if (process.platform !== "win32") {
    if (closeUp(dirname(path), 0o700, fsConstants.O_DIRECTORY)) closed.push("its directory was open to others: now mode 700");
    if (closeUp(path, 0o600, 0, claim)) closed.push("its token file was readable by others: now mode 600");
  }
  const known = readClaimState(claim.id).expiresAt;
  let o, check;
  if (typeof known === "string" && Date.parse(known) < Date.now()) {
    check = await lapseCheck(b.cfg, claim, known);
    if (check.blocked || check.keep) o = check.blocked ? { blocked: check.blocked, line: check.line } : { keep: true, line: check.keep };
    else o = await renewClaim(b.cfg, claim);
  } else o = await renewClaim(b.cfg, claim);
  // A lapse the registry's refusal reported (SMD-3807) is checked now, as one the record knew is: list_claims needs no
  // agent id, so a claim made on its work since is marked while the registry is still away (review pass 1: a next
  // renewal up to an hour off let a push go first).
  if (o.lapsedAt && !check) {
    // Waiting on an operator, the marker says so too, ahead of its cut: the user must hear it whatever they decide (review passes 2 and 3).
    check = await lapseCheck(b.cfg, claim, o.lapsedAt, o.cause === "registry_away" ? "" : ` (and the agent registry cannot give the claim key's agent id until an operator acts, ${o.cause}: tell the user that too)`);
    if (check.blocked) o = { blocked: check.blocked, line: check.line, lapsedAt: o.lapsedAt };
    else if (check.keep) o.line += `; the claims made since were not checked (${check.reason}), and the hook renews it only once they are`;
  }
  if (check && !check.blocked && !check.keep) {
    // The lapse time once: the refusal's line already gives it (review pass 4).
    if (check.note) o.line += o.lapsedAt ? " (its token file names no ticket, so the claims made since were not checked)" : check.note;
    if (check.quiet && o.ok && !o.blocked && !o.line.includes(QUIET_LAPSE_HEAD)) o.line += check.quiet;
    if (check.quiet && o.lapsedAt) o.line += "; no other claim was made or renewed on its work since, and each renewal checks again";
  }
  if (o.blocked) o.line += ownPieceNote(o.whole ?? o.blocked.message, dirname(dirname(path)), claim.id);
  // An ended claim's stamp goes with its file; one whose file could not be
  // ended keeps a stamp, or every event would ask again (review pass 1).
  if (o.ended && endClaimFile(path, claim, o.ended)) { try { unlinkSync(claimStatePath(claim.id)); } catch { /* none */ } }
  else {
    if (o.ended) o.line += " (its token file could not be ended now; the next run tries again)"; // the line said "ended" while the file stayed (review pass 5)
    if (o.blocked && !writeMarker(path, claim, "blocked", o.blocked)) o.line += " (the marker could not be written)";
    writeClaimState(claim.id, { ...readClaimState(claim.id), at: Date.now(), ...(o.ok ? { ok: Date.now(), expiresAt: o.expiresAt } : o.lapsedAt ? { expiresAt: o.lapsedAt } : {}), last: o.line });
  }
  if (closed.length) o.line += ` (${closed.join("; ")})`;
  log(`claims: ${o.line}`);
  return o;
}

/**
 * The claims hook's look at the agent's own claim calls (review pass 5,
 * against a real server): a `renew_claim`, or a `claim_work` with a token,
 * through a connector whose name a token file in the worktree gives as its
 * `server`, found by the token the call carried. Answered `WORK_CLAIMED`, the
 * claim gets its `<id>.blocked.json`, as the hook's own renewal would give it
 * — else the agent's next renewal, once the covering claim ends, revives it
 * silently. Renewed, the hook records the new expiry, so its own record never
 * reads a lapse the agent's renewal prevented. Refused CLAIM_UNATTRIBUTED
 * saying it had lapsed, the hook records the lapse and makes the claim due, so
 * the renewal after this checks the claims made since (SMD-3807). Nothing is
 * sent to a brain here. A refusal is an MCP error result, which Claude Code
 * hands to PostToolUseFailure: its `error` is the reply's text, and there is
 * no `tool_response` (SMD-3874, probed on the canary). A success reaches
 * PostToolUse, its `tool_response` the reply's text as a string, never its
 * structuredContent: the facts are read where another harness hands them over.
 */
function noteAgentClaimCall(hook, brains) {
  const event = String(hook.hook_event_name ?? "");
  if (event !== "PostToolUse" && event !== "PostToolUseFailure") return;
  const m = /^mcp__([A-Za-z0-9_-]+)__(renew_claim|claim_work)$/.exec(String(hook.tool_name ?? ""));
  const token = String(hook.tool_input?.token ?? "").toLowerCase();
  if (!m || !CLAIM_TOKEN_RE.test(token)) return;
  const root = worktreeRoot(hook.cwd);
  if (!root) return;
  const f = claimFiles(root).find((x) => x.claim && x.claim.token === token && x.claim.server === m[1]);
  if (!f) return;
  const brain = brains.find((x) => x.cfg.connector === f.claim.server) ?? brains[0];
  useStateRoot(brain.root);
  // What the call answered: a failure's is its `error`, a string in Claude Code; any other shape, or none with the
  // answer left in tool_response, is read as a result is, its words and its facts alike (review passes 1 and 2).
  const answer = event === "PostToolUseFailure" ? hook.error ?? hook.tool_response : hook.tool_response;
  const text = event === "PostToolUseFailure" && typeof answer === "string" ? answer : resultText(answer);
  // The first `until … (claim <id>).`, not the last: a piece named later in the reply is another key's words (review pass 1).
  const renewed = new RegExp(`^Renewed your claim on .*? until (\\S+) \\(claim (${UUID})\\)\\.`, "i").exec(text);
  if (renewed && renewed[2].toLowerCase() === f.claim.id) {
    const until = isTime(renewed[1]) ? renewed[1] : undefined; // a time, or none (review pass 3)
    writeClaimState(f.claim.id, { ...readClaimState(f.claim.id), at: Date.now(), ok: Date.now(), expiresAt: until, last: `the agent renewed ${claimLabel(f.claim)}${until ? ` until ${until}` : ""}` });
    // A renewal that revived a lapsed claim after claims were made or renewed on its work meanwhile, or couldn't read them or the lapse (the server says so since SMD-3654): marked as a covered claim is.
    if (REVIVED_COVERED_RE.test(text) && !existsSync(markerPath(f.path, "blocked"))) {
      const said = markerSaid(`CLAIMED_WHILE_LAPSED: ${scrubTokens(oneLine(text))}`);
      const wrote = writeMarker(f.path, f.claim, "blocked", { code: "CLAIMED_WHILE_LAPSED", message: said });
      log(`claims: blocked: ${claimLabel(f.claim)} — the agent's own ${m[2]} revived it: ${said}${wrote ? "" : " (the marker could not be written)"}`);
    }
    return;
  }
  // CLAIM_UNATTRIBUTED on its own lapsed claim (SMD-3807): the lapse recorded, and the claim made due, so this run's
  // renewal checks the claims made since at once, as the hook's own renewal does (review pass 1).
  const lapsedAt = unattributedLapse(resultFacts(answer), text, f.claim.id);
  if (lapsedAt) {
    const line = `the agent's own ${m[2]} met CLAIM_UNATTRIBUTED: ${claimLabel(f.claim)} had lapsed at ${lapsedAt}; ${f.claim.ticket ? "made due, so the hook's renewal checks the claims made or renewed on its work since" : "its token file names no ticket, so the claims made since are not checked"}`;
    writeClaimState(f.claim.id, { ...readClaimState(f.claim.id), at: 0, expiresAt: lapsedAt, last: line });
    log(`claims: ${line}`);
    return;
  }
  // One claim in the way or several: render.ts says "a live claim" or "N live claims" (review pass 3: several went
  // unmarked). Only a call on the token file's own work — renew_claim of its id, or claim_work of its ticket and piece
  // — marks it: a claim_work for other work carrying the token met a claim of its own, not this one's end (review pass 4).
  // The ticket and piece cleaned as 115's ob1_work_claim_text cleans them (review pass 5: inner spaces and zero-width
  // marks read as other work); a token file naming no ticket is taken as this work, the side that marks.
  const input = hook.tool_input ?? {};
  const itsWork = m[2] === "renew_claim"
    ? String(input.id ?? "").toLowerCase() === f.claim.id
    : (!f.claim.ticket || cleanWork(input.ticket) === cleanWork(f.claim.ticket)) && cleanWork(input.piece) === cleanWork(f.claim.piece);
  if (itsWork && /\bis covered by (?:a live claim|\d+ live claims)\b/.test(text) && !existsSync(markerPath(f.path, "blocked"))) {
    const said = markerSaid(`WORK_CLAIMED: ${scrubTokens(oneLine(text))}`);
    const wrote = writeMarker(f.path, f.claim, "blocked", { code: "WORK_CLAIMED", message: said });
    log(`claims: blocked: ${claimLabel(f.claim)} — the agent's own ${m[2]} met ${said}${wrote ? "" : " (the marker could not be written)"}${ownPieceNote(text, root, f.claim.id)}`);
  }
}

/**
 * Renew the claims whose tokens the worktree holding `cwd` keeps: those due —
 * a quarter lease since the last attempt, or, with `force` (a checkpoint), a
 * minute — or, with `now` (a run by hand, the hook's child), every claim, or
 * the claims `only` names by id. Each is stamped before its call, so a run
 * that starts after the stamp finds it not due. A claim with a
 * `<id>.blocked.json` beside it waits until the agent deletes it (review pass
 * 4). A file that cannot be renewed (unreadable, no brain for it, blocked) is
 * logged under `force` or `now` alone: a quiet hook on every tool would log it
 * every time. With `detach` the calls go to a child, told the claims by id (an
 * id is no secret, a path might be), as the capture's do. Returns the outcomes.
 */
export async function renewClaims(cwd, brains, { force = false, now: atOnce = false, detach = false, only } = {}) {
  const root = worktreeRoot(cwd);
  if (!root) return [];
  const now = Date.now();
  const work = [], outcomes = [];
  const skip = (line) => { outcomes.push({ skipped: true, line }); if (force || atOnce) { useStateRoot(brains[0].root); log(`claims: ${line}`); } };
  const files = claimFiles(root);
  // An id asked for by hand that no file holds is said, not passed over (review pass 3).
  for (const id of only ?? []) if (!files.some((f) => (f.claim?.id ?? f.id) === id)) skip(`skipped claim ${id}: no token file for it in ${join(root, CLAIMS_DIRNAME)}`);
  for (const f of files) {
    if (only && !only.includes(f.claim?.id ?? f.id)) continue;
    if (f.bad) { skip(`skipped ${f.path}: ${f.bad}`); continue; }
    if (existsSync(markerPath(f.path, "blocked"))) { skip(`blocked: ${claimLabel(f.claim)} — another claim covered its work; delete ${basename(markerPath(f.path, "blocked"))} once the user has decided, and renewals resume`); continue; }
    const { brain, skip: why } = brainForClaim(f.claim, brains);
    if (!brain) { skip(`skipped ${claimLabel(f.claim)}: ${why}`); continue; }
    useStateRoot(brain.root);
    const st = readClaimState(f.claim.id);
    if (!atOnce && now - (st.at ?? 0) < (force ? CHECKPOINT_RENEW_MS : renewEveryMs(f.claim.lease ?? DEFAULT_LEASE_S))) continue;
    writeClaimState(f.claim.id, { ...st, at: now });
    work.push({ brain, f });
  }
  if (!work.length) return outcomes;
  if (detach) {
    useStateRoot(work[0].brain.root);
    ensureDirs();
    const fd = openSync(LOG_PATH(), "a", 0o600);
    // --from-hook: the child's stdout is the log, so it prints nothing there; a run by hand always prints (review pass 4).
    const child = spawn(process.execPath, [SELF, "--renew-claims", "--from-hook", "--cwd", root, ...work.flatMap((w) => ["--claim", w.f.claim.id])], { detached: true, stdio: ["ignore", fd, fd], env: { ...process.env } });
    child.unref();
    closeSync(fd);
    return [...outcomes, { detached: child.pid }];
  }
  for (const { brain, f } of work) outcomes.push(await renewOne(brain, f.path, f.claim));
  return outcomes;
}

/**
 * --check's lines for a brain's claim key: claims off (a key file it can't
 * read, an empty key), a key that renews nothing (no connector), a key file
 * others can read, one OB1_BRAIN_URL leaves unused, and that the key can renew
 * — naming where the key came from and its connector (review pass 4). Returns
 * the exit code.
 */
async function checkClaims(brain, tag) {
  const cfg = brain.cfg;
  if (cfg.claimKeyIgnored) console.error(`${tag}warning: OB1_BRAIN_URL is set, so the claim key in ${CONFIG_PATH} is not used — the variable's brain renews no claims`);
  if (cfg.claimKeyError) { console.error(`session-capture: ${tag}claims are off: ${cfg.claimKeyError}`); return 1; }
  if (!cfg.claimKey) return 0;
  if (!cfg.connector) { console.error(`session-capture: ${tag}the claim key renews nothing: this brain has no "connector" — set it to the MCP server your agents claim through (open-brain), the "server" their token files name`); return 1; }
  if (cfg.claimKeyFile && process.platform !== "win32") {
    try { if (statSync(cfg.claimKeyFile).mode & 0o077) console.error(`${tag}warning: ${cfg.claimKeyFile} (the claim key) is readable by others — chmod 600 it`); } catch { /* read at load; gone since */ }
  }
  let names;
  try { names = ((await rpc({ ...cfg, key: cfg.claimKey }, "tools/list", {}, 15_000)).tools ?? []).map((t) => t.name); } catch (e) { console.error(`session-capture: ${tag}the claim key: ${shownUrl(cfg.url)} did not answer tools/list — ${e.message}`); return 1; }
  if (!names.includes("renew_claim")) { console.error(`session-capture: ${tag}the claim key cannot call renew_claim — ${names.includes("list_claims") || names.includes("capture_thought") ? "give claim_key the write key your agents claim with" : "this brain's server is from before SMD-3598: upgrade it"}`); return 1; }
  console.log(`${tag}claim key (${cfg.claimKeySource}): ok for connector ${cfg.connector} — it can renew claims. The claims renewed are those whose tokens a session's worktree keeps in ${CLAIMS_DIRNAME}/ with "server": "${cfg.connector}"; the key must be the very key the agent claims with (its connector's own: a server takes one key per name)`);
  return 0;
}

export { UUID_ONLY_RE, checkClaims, noteAgentClaimCall, scrubTokens };
