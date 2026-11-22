/**
 * lib/post.mjs — a capture's two halves (SMD-4338): the foreground prepares a
 * payload per episode and queues it; the detached child posts the queue in
 * order, each payload superseding its episode's last capture, and keeps or
 * gives up what does not land, by the brain's verdict (lib/rpc.mjs). Also the
 * queue's ordering between runs, and --check's look at one brain.
 */

import { readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, renameSync, openSync, closeSync, utimesSync } from "node:fs";
import { join, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { UUID, oneLine, sha256, shownUrl } from "./util.mjs";
import { DEAD_DIR, INFLIGHT_DIR, LOG_PATH, PENDING_DIR, PENDING_MAX_AGE_MS, SELF, STATE_DIR, claim, ensureDirs, isAlive, lastAttemptMs, listPayloads, log, moveTo, pruneDead, readState, release, sessionPayloads, statePath, sweepInflight, writeJson, writeState } from "./state.mjs";
import { countRedactions, describeRedactions } from "./secrets.mjs";
import { CaptureError, providerMends, rpc, textOfResult, verdictOf } from "./rpc.mjs";
import { urlSource } from "./config.mjs";
import { HOOK_EVENTS, HOOK_VERSION, VERSION_RE, checkpointOf, eventSpec } from "./hook.mjs";
import { assistantExcerpt, chainOf, cleanEpisode, distinctPrompts, episodeChain, gateFindings, headerTickets, provenanceOf } from "./episode.mjs";
import { summariseTranscript } from "./transcript.mjs";
import { modelStatusLine, modelSummary } from "./model.mjs";

/** The tools a capture-scoped key is given (server-portable/tools.ts's capture group): --check's word for "a capture key". */
const CAPTURE_SURFACE = new Set(["capture_thought", "set_priority", "clear_priority", "open_item", "update_item", "set_item_status", "propose_item_close", "decide_item_close"]);

// ── Posting over MCP ─────────────────────────────────────────────────────────

/**
 * capture_thought over MCP. Returns { id, note, sent } on success. A refusal of a
 * pointer — a derived_from id the server does not know (a thought since
 * deleted, a result this parser misread), or a supersedes the server refuses
 * (the earlier summary deleted; a key that may not replace it) — or of the
 * `metadata` (SMD-2168) drops what was refused and tries again, and the note
 * says so: a summary with no sources, a fresh one beside the old, or one
 * without its redaction count, beats no summary. (First review pass: only
 * derived_from was retried, and a dead supersedes refused every later ending of
 * the session forever, since the state kept naming it.)
 */
export async function postCapture(cfg, payload) {
  // SMD-1724: a session summary is an agent's output — derived from the
  // session, written by the hook or its model — declared so; the server clamps
  // it to the key's kind. A server from before the argument strips it unread.
  const args = { content: payload.text, source: payload.harness, trust: "agent" };
  if (payload.derived_from?.length) args.derived_from = payload.derived_from;
  if (payload.supersedes) args.supersedes = payload.supersedes;
  // What rides in metadata.* beside the row's own source (which stays the
  // harness, so a reader and a per-source weight — SMD-1297 — still tell a model
  // summary from a derived one, and a redacted one from a clean one): the model
  // that wrote the summary if one did (SMD-2014), and the COUNT of secrets
  // blanked from it (SMD-2168) — the count alone, never the reasons or offsets,
  // which the text's markers already name; and where its header's tickets came
  // from, the asks or the place (SMD-3306 PR 7a-3b-2), for the brain's subject
  // rule, which the text alone leaves to guess — not with a model's summary,
  // whose prose has no header for the word to describe (review pass 4: a model
  // echoing the header it was shown would have its tickets keyed); and the
  // version of the hook that prepared it (SMD-4378), so the brain can later
  // tell which rules wrote a header. A payload queued by a hook before 1.11.0 has
  // none, and is sent without it: no hook can say which wrote it. A hook
  // before 1.11.0 sending a payload a later one queued (a rollback) drops it.
  // A stamp not in a version's shape (a hand edit, a corrupt file) is not sent:
  // a long one the server refused cost the summary all its metadata, the
  // redaction count among it (review pass 2).
  const meta = {};
  if (payload.summary_model) meta.summary_model = payload.summary_model;
  if (payload.redactions?.length) meta.redactions = payload.redactions.length;
  if (payload.tickets_from && !payload.summary_model) meta.tickets_from = payload.tickets_from;
  if (typeof payload.hook_version === "string" && VERSION_RE.test(payload.hook_version)) meta.hook_version = payload.hook_version;
  if (Object.keys(meta).length) args.metadata = meta;
  const call = () => rpc(cfg, "tools/call", { name: "capture_thought", arguments: args });
  let result = await call();
  let text = textOfResult(result);
  const notes = [];
  // A mendable refusal (a droppable pointer, whatever its retryable flag) is
  // mended by dropping the pointer the verdict names and trying again; the
  // server's transients (the store away, a pointer it could not judge) name no
  // pointer to mend and fall through to the classification below.
  for (let retry = 0; retry < 5 && result.isError; retry++) {
    const v = verdictOf(result, text);
    if (v.mend === "derived" && args.derived_from) {
      // The POSITIONS the verdict names, dropped exactly (second review pass: a
      // first cut dropped all forty sources over one deleted thought); with
      // none named — a key not told which — the whole list goes.
      const at = v.positions.filter((i) => i < args.derived_from.length);
      if (at.length) {
        notes.push(`${at.length} source id(s) dropped: ${oneLine(text).slice(0, 120)}`);
        args.derived_from = args.derived_from.filter((_, i) => !at.includes(i));
        if (!args.derived_from.length) delete args.derived_from;
      } else { notes.push("provenance dropped: " + oneLine(text).slice(0, 160)); delete args.derived_from; }
    } else if (v.mend === "supersedes" && args.supersedes) { notes.push("supersedes dropped: " + oneLine(text).slice(0, 160)); delete args.supersedes; }
    // A server that refuses `metadata` — a reserved-key clash, or a brain from
    // before it took the argument (SMD-2014) — is met by dropping metadata and
    // posting the summary anyway (SMD-2168): the count is a nicety, the summary
    // is the point, as with a dropped pointer.
    else if (v.mend === "metadata" && args.metadata) { notes.push("metadata dropped: " + oneLine(text).slice(0, 160)); delete args.metadata; }
    else break;
    result = await call();
    text = textOfResult(result);
  }
  // An error saved nothing, whatever id its words name (SMD-3153: the one
  // that did, a save whose vector did not attach, left with its code).
  if (result.isError) {
    // Final vs kept is the verdict's `retryable` (SMD-1978): a refusal is dead,
    // a transient — the store not answering, a pointer it could not judge — is
    // worth keeping (first review pass: every isError was "refused", and a brain
    // whose database was down for a minute lost the session for good).
    const v = verdictOf(result, text);
    // Kept by its code too (SMD-2892): the brain's embedding provider refusing it — a key or a model an operator
    // mends — is final for the call and no fault of the summary's, so the payload waits for the mend as an outage's
    // does (up to PENDING_MAX_AGE_MS), not dead on the first refusal.
    const kept = v.retryable || providerMends(result);
    const err = new CaptureError(kept ? "failed" : "refused", `capture ${kept ? "failed" : "refused"}: ${oneLine(text).slice(0, 200)}`);
    // A pointer the server could not judge: a failure ON the pointer, counted by
    // postPending so the last attempt can drop it (eighth review pass).
    if (v.on === "supersedes") err.on = "supersedes";
    throw err;
  }
  const id = new RegExp(`\\bid (${UUID})`, "i").exec(text)?.[1];
  if (!id) throw new CaptureError("failed", `capture answered without an id: ${oneLine(text).slice(0, 200)}`);
  // `sent`: the pointer the post that landed named — none when a mend dropped
  // it, which is what the captured line reports (SMD-2473 PR 2 review pass 1).
  return { id: id.toLowerCase(), note: notes.join("; "), sent: args.supersedes };
}

// ── The two halves of a hook run ─────────────────────────────────────────────

/** How many payloads a run posts beside its own — the queue's five (SMD-1298); the run's own, one per episode, all post (SMD-2013's second review pass: the oldest of more than five waited for a run that might never come). */
export const RUN_MAX = 5;

let payloadSeq = 0;
/**
 * The foreground: read the transcript, decide, summarise, scan, hand off.
 * Returns { code, message, payloadPaths, payloadPath?, payload? } — the caller
 * prints the message and exits with the code; `payloadPaths` are the payloads
 * the run's child posts, one per episode written, `payloadPath` the newest. One payload per episode whose summary changed
 * (SMD-2013): an episode captured and unchanged is skipped by fingerprint, one
 * whose summary carries a secret has it blanked (`opts.onSecret` `redact`, the
 * default) or is refused alone (`refuse`) — the others still post (SMD-2127).
 */
export function prepare(hook, opts = {}) {
  const event = String(hook.hook_event_name ?? "");
  // An event this hook is not for — a command pasted under SubagentStop or
  // UserPromptSubmit fires mid-session and would post a final-looking summary
  // that supersedes the checkpoint (second review pass). No event at all is a
  // run by hand, an end.
  if (event && !eventSpec(event)) return { code: 0, message: `skip: ${event} is not an event this hook captures on (${HOOK_EVENTS.join(", ")}); nothing captured` };
  if (!hook.transcript_path || !existsSync(hook.transcript_path)) return { code: 0, message: `skip: no transcript for session ${hook.session_id || "?"}` };
  const s = summariseTranscript(hook.transcript_path, opts.harness);
  // ONE id for both halves: the hook's session_id (what a later run of the same
  // session presents again), else the transcript's own — the state, the
  // interval and the payload all key on it (tenth review pass: a hook that sent
  // no session_id read its state under "" and its payload under the
  // transcript's id, and never saw its own capture). Resolved after the
  // transcript is read, since the fallback comes from it; the read costs ~50 ms.
  if (typeof hook.session_id === "string" ? hook.session_id : typeof hook.session_id === "number") s.sessionId = String(hook.session_id); // an object is not an id
  const sessionId = s.sessionId;
  for (const ep of s.episodes) ep.sessionId = sessionId; // the hook's id wins over the transcript's, which segment set
  const episodes = s.episodes;
  if (!episodes.length) return { code: 0, message: `skip: no human prompt in session ${sessionId}` };
  const last = episodes[episodes.length - 1]; // the open episode: where the session is now
  const chainFor = (ep) => episodeChain(sessionId, ep.n);
  const listing = listPayloads(); // the queue walked once for every episode (thirteenth review pass of SMD-1298; SMD-2013's first)
  const states = new Map(episodes.map((ep) => [chainFor(ep), readState(chainFor(ep)) ?? {}]));
  if (eventSpec(event)?.interval && opts.minIntervalMin > 0) {
    // The session's last attempt across its episodes' chains: a new episode
    // inside the interval is not a reason to capture (SMD-2013's first review
    // pass: the gate read the open chain alone, which a new episode has none of).
    const gates = episodes.map((ep) => lastAttemptMs(chainFor(ep), states.get(chainFor(ep)), sessionPayloads(chainFor(ep), {}, listing))).filter(Boolean);
    const gate = gates.length ? gates.reduce((a, b) => (b.at > a.at ? b : a)) : null;
    const ageMin = gate ? (Date.now() - gate.at) / 60_000 : Infinity;
    if (ageMin < opts.minIntervalMin) return { code: 0, message: `skip: last capture ${ageMin.toFixed(0)} min ago${gate.pending ? " (still pending)" : ""}, interval ${opts.minIntervalMin}` };
  }
  if (typeof hook.cwd === "string" && hook.cwd) { for (const x of [s, last]) { x.cwd = hook.cwd; x.roots.add(hook.cwd); } }
  last.checkpoint = checkpointOf(hook); // a checkpoint is the open episode's; a closed one is over
  const written = [], skipped = [], refused = [];
  const onSecret = opts.onSecret ?? "redact";
  for (const ep of episodes) {
    const chain = chainFor(ep);
    // Blanked BEFORE the fingerprint (SMD-2127): the fingerprint is of the text
    // sent, so the same transcript is the same summary, however it was cleaned.
    const cleaned = cleanEpisode(ep, onSecret);
    const { text, redactions } = cleaned;
    const fingerprint = sha256(text);
    const state = states.get(chain);
    if (state.fingerprint === fingerprint) { skipped.push({ ep, as: state.thought_id }); continue; }
    // …or already QUEUED: with the endpoint away, a session resumed and ended
    // again with no new turn would queue the same summary twice, and the run
    // that drains them would dead-letter the first as "obsolete" (eleventh review pass).
    if (sessionPayloads(chain, {}, listing).some((p) => payloadOf(p)?.fingerprint === fingerprint)) { skipped.push({ ep, queued: true }); continue; }
    // The gate, whatever the mode: a multi-line key block is refused, and under
    // `redact` the blanked sources and text are re-scanned — the net under the
    // redaction, so no single-line secret the scan can see is sent (SMD-2127).
    const where = gateFindings(cleaned, text);
    if (where.length) { refused.push({ ep, where: `${where.join(", ")}${redactions.length ? ` after ${countRedactions(redactions.length)}` : ""}` }); continue; }
    const ticketsFrom = headerTickets(cleaned.ep).from;
    const payload = {
      session_id: sessionId, chain_id: chain, episode: ep.n, harness: s.harness, event: ep === last ? event : "", trigger: ep === last ? last.checkpoint?.trigger : undefined, text, fingerprint, // a closed episode's summary is final whatever event the run is: it carries no event, so the log says none (second review pass)
      derived_from: provenanceOf(ep), supersedes: state.thought_id || undefined,
      prompts: distinctPrompts(cleaned.ep.prompts).length, prepared_at: new Date().toISOString(), attempts: 0, // as the text counts them: two asks that differed in a secret alone are one line once blanked (first review pass)
      ...(redactions.length ? { redactions } : {}), // what was blanked, where — the log's and the message's; absent when nothing was
      ...(ticketsFrom ? { tickets_from: ticketsFrom } : {}), // where the header's tickets came from (SMD-3306 PR 7a-3b-2)
      hook_version: HOOK_VERSION, // the hook that prepared the payload (its derived text, or the model's input), whichever later hook drains the queue (SMD-4378)
    };
    // The model's input rides the payload only when the option is on AND the
    // payload is a durable one the model will actually write — not a running
    // checkpoint, which keeps its derived text (the same event-table test
    // modelSummary applies): so a derived-mode payload carries nothing of the
    // model (SMD-2014), and a checkpoint payload never carries the assistant
    // excerpt at rest unread (review pass 2). The fingerprint stays the DERIVED
    // text's, so an episode is asked of the model once — a re-end with the same
    // derived summary is skipped, not re-modelled.
    if (opts.summary === "model" && !eventSpec(payload.event)?.checkpoint) payload.assistant = assistantExcerpt(ep);
    ensureDirs();
    // The name orders the queue: the millisecond, then a per-process sequence
    // (two payloads one process prepares in one millisecond sort as made — third
    // review pass: a random tail decided, and a test flaked), then a random tail
    // so two processes never collide; it ends in the chain's sanitised key.
    const payloadPath = join(PENDING_DIR(), `${Date.now()}-${String(payloadSeq++).padStart(4, "0")}-${randomBytes(3).toString("hex")}-${basename(statePath(chain), ".json")}.json`);
    writeJson(payloadPath, payload);
    written.push({ ep, payloadPath, payload });
  }
  const one = episodes.length === 1;
  const who = `session ${sessionId}${last.checkpoint ? ` (${event}${last.checkpoint.trigger ? ` ${last.checkpoint.trigger}` : ""})` : ""}`;
  const describe = (p) => `${p.prompts} prompt(s), ${p.derived_from.length} source id(s)${p.supersedes ? `, supersedes ${p.supersedes}` : ""}${p.redactions?.length ? `, redacted: ${describeRedactions(p.redactions)}` : ""}`;
  const sentences = [];
  if (refused.length) {
    const carrier = one ? `the summary for session ${sessionId}` : `${refused.length === 1 ? `episode ${refused[0].ep.n}` : `episodes ${refused.map((r) => r.ep.n).join(", ")}`} of session ${sessionId}`;
    const where = refused.map((r) => (one ? r.where : `episode ${r.ep.n}: ${r.where}`)).join("; ");
    sentences.push(`refused — ${carrier} carries what looks like a secret (${where}); ${written.length ? `${refused.length === 1 ? "that episode is" : "those episodes are"} not sent, the other ${written.length === 1 ? "episode posts" : `${written.length} episodes post`}` : "nothing sent"}. Remove it from the conversation before ending the session, or capture by hand.`);
  }
  if (written.length) {
    sentences.push(one ? `prepared: ${who}, ${describe(written[0].payload)}`
      : `prepared: ${who}, episode${written.length === 1 ? "" : "s"} ${written.map((w) => w.ep.n).join(", ")} of ${episodes.length}${skipped.length ? ` (${skipped.length} unchanged)` : ""} — ${written.map((w) => `${w.ep.n}: ${describe(w.payload)}`).join("; ")}`);
    const newest = written[written.length - 1];
    return { code: refused.length ? 1 : 0, message: sentences.join(" | "), payloadPaths: written.map((w) => w.payloadPath), payloadPath: newest.payloadPath, payload: newest.payload };
  }
  if (refused.length) return { code: 1, message: sentences[0], payloadPaths: [] };
  const queuedOnly = skipped.every((k) => k.queued);
  if (one) return { code: 0, message: queuedOnly ? `skip: session ${sessionId} already queued — a payload with this summary is pending` : `skip: session ${sessionId} already captured as ${skipped[0].as}`, payloadPaths: [] };
  const newest = skipped[skipped.length - 1];
  return { code: 0, message: `skip: session ${sessionId}'s ${episodes.length} episodes are already captured${skipped.some((k) => k.queued) ? " or queued" : ""} (the newest ${newest.queued ? "as a pending payload" : `as ${newest.as}`})`, payloadPaths: [] };
}

/**
 * A recorded time as milliseconds, or NaN when it is none or lies in the
 * FUTURE: a clock that was wrong decides nothing (fourth review pass of
 * SMD-1298) — else one skewed payload would make every honest later ending
 * obsolete until the wall clock caught up. The one spelling of that rule, for
 * `recordedAfter` and `momentOf` (SMD-2035's boyscout: it was written twice).
 */
const pastMs = (iso) => { const t = Date.parse(iso ?? ""); return t <= Date.now() ? t : NaN; };
/**
 * Whether the state records a summary NEWER than a payload prepared at
 * `preparedAt`. States from before summary_at carry the post time — close
 * enough. One rule, read before the post and again after it (ninth review
 * pass: it was spelled twice).
 */
function recordedAfter(state, preparedAt) {
  return Boolean(preparedAt && pastMs(state?.summary_at ?? state?.captured_at) > Date.parse(preparedAt));
}

/**
 * What a payload file says of itself, or `undefined` when it cannot be read
 * (mid-write, or gone) — then each reader takes the side that costs least if
 * wrong. A name is matched by a sanitised tail two ids can share ("a.b" and
 * "a_b"), so the file says whose it is (seventh review pass: the sixth had
 * fixed one reader of five); and it says whether it has landed.
 */
const payloadOf = (p) => { try { return JSON.parse(readFileSync(p.path, "utf8")) ?? undefined; } catch (e) { return e?.code === "ENOENT" ? null : undefined; } }; // null: gone between the listing and the read — a claim that has just cleared, nobody's (ninth review pass)
/**
 * The claims a payload steps aside for: payloads of its session that another
 * LIVE child holds under inflight/<pid>/ and that are OLDER than it — a name
 * leads with the millisecond it was prepared, so the names order them —
 * landed or not: one that carries its `captured_id` is over but for its
 * state write, and a sibling posting past it would write the state beside
 * that write, in no order (eighth review pass let it, the ninth undid it). A
 * compaction's child still posting when the session's end spawned its own
 * (`/compact` then `/exit`; an auto-compaction on the last turn) left the
 * end's payload pointing at nothing — the checkpoint had not landed — so the
 * end landed first and the checkpoint after it, a live thought saying
 * "continuing" of a session that had ended, beside the final summary
 * (SMD-2035; SMD-2012's second review pass, the gap SMD-1989 had recorded).
 * A child that is gone holds no one (the next run's sweep returns its claim);
 * only the NEWER of two steps aside, so two children never wait on each other.
 */
export const aheadOf = (sessionId, name) => sessionPayloads(sessionId, { pending: false }).filter((p) => {
  if (p.pid === process.pid || p.name.localeCompare(name) >= 0 || !isAlive(p.pid)) return false;
  const j = payloadOf(p);
  return j === undefined || (j !== null && chainOf(j) === sessionId); // unreadable: ahead, the safe side; gone: not
});
/**
 * Whether a NEWER payload of the session is in another live child's hands:
 * the older one is then obsolete — a summary is cumulative, the newer covers
 * it, and a payload posted beside it would stand as a live "continuing"
 * thought (fourth review pass: a sweep returned an older payload to pending/
 * after the newer's run had looked, a sibling claimed it, and both posted).
 */
export const newerInFlight = (sessionId, name) => sessionPayloads(sessionId, { pending: false }).some((p) => p.pid !== process.pid && p.name.localeCompare(name) > 0 && isAlive(p.pid) && chainOf(payloadOf(p)) === sessionId); // unreadable: not a reason to drop a payload

/**
 * The session's landed payloads whose bookkeeping is still owed — the post
 * answered, `captured_id` written, the state write failed, the file back under
 * pending/ or still in its child's hands — are thoughts the state does not
 * name (first review pass). Each with its moment: the time it was prepared,
 * or the millisecond in its name when a hand-made file has none.
 */
function landedPayloads(sessionId) {
  const out = [];
  for (const p of sessionPayloads(sessionId)) {
    const j = payloadOf(p);
    if (!j) continue;
    // The name's millisecond was written by the same clock as prepared_at: a
    // future one decides nothing either, and the payload ranks last — a clock
    // that ran ahead never puts it over the state (fifth review pass).
    if (j?.captured_id && chainOf(j) === sessionId) out.push({ name: p.name, id: j.captured_id, ms: payloadMoment(j.prepared_at, p.ms) });
  }
  return out;
}
/** The newest of them older than `name`, by name — whatever order the directories were read in. */
export function landedBefore(sessionId, name) {
  return landedPayloads(sessionId).filter((p) => p.name.localeCompare(name) < 0).sort((a, b) => b.name.localeCompare(a.name))[0];
}
/** Whether one newer than `name` has landed: a payload older than it is then obsolete whatever the state says (second review pass). */
export function landedAfter(sessionId, name) {
  return landedPayloads(sessionId).some((p) => p.name.localeCompare(name) > 0);
}
/** A recorded moment for ranking: `pastMs`, else the fallback. */
const momentOf = (iso, fallbackMs) => { const t = pastMs(iso); return Number.isNaN(t) ? fallbackMs : t; };
/** A payload's moment: when it was prepared, else the millisecond in its name — written by the same clock, so a future one decides nothing either and the payload ranks last (fifth review pass; spelled once, eleventh). */
const payloadMoment = (preparedAt, nameMs) => momentOf(preparedAt, nameMs <= Date.now() ? nameMs : 0);
/**
 * The thought a payload supersedes: the session's newest landed one by the
 * time its payload was prepared — what the state records (`summary_at`, the
 * prepare time; `captured_at`, the post time, only for a state from before
 * it), or a landed payload whose bookkeeping is owed. Newest by time, not by
 * source: a run that finished an older payload's bookkeeping named it over
 * the state's newer thought, and two summaries stood (first review pass).
 * What this run itself landed is one or the other: its state write moved the
 * state, or failed and left the payload owed under pending/ — the per-run map
 * SMD-1298's sixth pass added for it was the third spelling of the same fact.
 */
export function pointerFor(sessionId, name, state, landedHere) {
  // A state whose time is in the future or unreadable STANDS (its moment is now): it is the pointer's normal source, and a clock that was wrong is no reason to rank an owed payload — the exception — over it (fourth review pass).
  // What this run itself landed is the last resort: when the landed payload's own id write failed — the disk full, the temp path taken — the file went back to pending/ without it, the state was never written, and a follow-up of the session would post pointerless while the next run posted the landed payload again (eighth review pass; the first pass had dropped this map as redundant, and it is, but for that fault).
  const cands = [state?.thought_id && { id: state.thought_id, ms: momentOf(state.summary_at ?? state.captured_at, Date.now()) }, landedBefore(sessionId, name), landedHere].filter(Boolean);
  cands.sort((a, b) => b.ms - a.ms);
  return cands[0]?.id;
}

/**
 * The background half: post what is pending, OLDEST FIRST — up to four earlier
 * payloads from runs whose post failed, then the one this run prepared — so a
 * session that ended while the server was down lands on the next session's
 * ending, whichever session that is. A summary is cumulative over the
 * transcript, so of two payloads of ONE session only the newest is worth
 * posting: an older one — older than another in this run, or than the summary
 * the session's state already records (`summary_at`, the payload's own
 * prepared_at, not the time it was posted) — is obsolete and goes to dead/
 * unposted (second review pass). Every file this run touches it first CLAIMS
 * by renaming it into inflight/<pid>/, an atomic move exactly one of two
 * children wins, so two sessions ending together never post each other's
 * payload or trip over a file the other moved; a child that dies mid-flight
 * leaves its claims for the next run's sweep (third review pass). The run's
 * own payload is always among the five. After them the run follows up, round
 * after round while a round yields, with up to five payloads of the sessions
 * whose claims it cleared that waited under pending/ — an end deferred behind
 * the checkpoint it has just landed (SMD-2035) — never with one it has itself
 * just returned there.
 */
export async function postPending(cfg, own) {
  ensureDirs();
  sweepInflight();
  const mine = join(INFLIGHT_DIR(), String(process.pid));
  mkdirSync(mine, { recursive: true, mode: 0o700 });
  // The run's own: one payload, or one per episode the run prepared (SMD-2013) — all of them; the five bound what waited from before, taken longest-waiting first.
  const owns = [].concat(own ?? []).filter(Boolean);
  const pending = readdirSync(PENDING_DIR()).filter((f) => f.endsWith(".json")).sort().map((f) => join(PENDING_DIR(), f));
  const earlier = pending.filter((f) => !owns.includes(f)).slice(0, Math.max(0, RUN_MAX - owns.length));
  const wanted = [...earlier, ...owns.filter((f) => existsSync(f))].sort((a, b) => basename(a).localeCompare(basename(b))); // names lead with the millisecond they were made
  // Claim: the payload's home path stays its name in the outcomes and the state.
  // Every session-keyed structure and rule below keys on the CHAIN — the
  // session's id, or an episode's key under it (SMD-2013): each episode's
  // summaries order and supersede among themselves alone.
  const claimed = wanted.map((home) => claim(home, mine)).filter(Boolean);
  const newestOf = new Map(); // chain → the newest payload's home in this run
  for (const { home, payload } of claimed) newestOf.set(chainOf(payload), home);
  const outcomes = [];
  pruneDead();
  const clearedSessions = new Set();
  const landedHere = new Map(); // chain → what this run landed: the pointer's last resort
  const bounced = new Set(); // files the follow-up found to be another session's: read once
  // After the run: payloads left under pending/ of every session whose claim
  // this run cleared — landed, dropped as obsolete beside a newer one, or
  // failed on and returned — are claimed and posted now, with the pointer the
  // state carries, rather than by whichever hook run comes next: an end
  // deferred behind the checkpoint this run has just landed (second review
  // pass), behind an older payload it has just dropped for that end (fourth),
  // or behind one whose post failed (fifth). Round after round while a round
  // yields something — an end deferred behind a checkpoint the first round
  // was posting (fifth review pass) — up to five payloads in all.
  const FOLLOW_UP_MAX = 5;
  const followUps = (room) => {
    // Not what this run has itself returned to pending/ — a failed post, a
    // deferral — which would be retried at once and counted twice (third
    // review pass). Each cleared session's candidates NEWEST first, taken in
    // rounds across the sessions — every session's newest before any
    // session's second — so one session's obsolete older ends never spend
    // the room another's newest needs (fifth and sixth review passes); the
    // older ones left under pending/ are dropped by the next run.
    const done = new Set(outcomes.map((o) => o.file));
    const lists = [...clearedSessions].map((sid) => [sid, sessionPayloads(sid).filter((q) => q.pid === null && !done.has(q.path) && !bounced.has(`${sid}:${q.path}`)).sort((x, y) => y.name.localeCompare(x.name))]);
    const next = [];
    for (let k = 0; next.length < room && lists.some(([, l]) => l.length > k); k++) {
      for (const [sid, l] of lists) {
        const p = l[k];
        if (!p || next.length >= room) continue;
        const c = claim(p.path, mine);
        if (!c) continue;
        // A name is matched by its sanitised tail, which two ids can share
        // ("a.b" and "a_b"): a payload of another session is not this run's
        // to judge (sixth review pass — it was dropped as obsolete beside a
        // session it did not belong to).
        if (chainOf(c.payload) !== sid) { moveTo(c.here, PENDING_DIR()); bounced.add(`${sid}:${p.path}`); continue; } // by session: its own may still follow it up (tenth review pass)
        // The session's newest, across rounds: a later round must not name an older payload newest when the newest was taken before and failed (ninth review pass).
        if (!newestOf.has(sid) || basename(newestOf.get(sid)).localeCompare(p.name) < 0) newestOf.set(sid, p.path);
        next.push({ ...c, followUp: true });
      }
    }
    next.sort((a, b) => basename(a.home).localeCompare(basename(b.home))); // oldest first, as the run posts
    if (next.length) log(`following up: ${next.length} payload(s) of ${[...new Set(next.map((n) => chainOf(n.payload)))].join(", ")} waited under pending/ behind a claim this run cleared`);
    return next;
  };
  const queue = [...claimed];
  let followedUp = 0;
  try {
    for (;;) {
      if (!queue.length) {
        if (followedUp >= FOLLOW_UP_MAX) break;
        const more = followUps(FOLLOW_UP_MAX - followedUp);
        if (!more.length) break;
        queue.push(...more);
      }
      const { home, here, payload, retaken, followUp } = queue.shift();
      const file = home;
      const chain = chainOf(payload);
      const who = "session=" + payload.session_id + (payload.episode > 1 ? ` episode=${payload.episode}` : "");
      // The cap counts what the follow-up posts or defers, not what it drops:
      // five stale ends of one session, four of them obsolete, spent the room
      // another session's deferred end needed (eleventh review pass).
      if (followUp) followedUp++;
      try { const now = new Date(); utimesSync(mine, now, now); } catch { /* the claim is judged by its age; a touch that fails leaves it judged from the last one */ }
      // Whether a newer summary of the session exists anywhere — this run holds
      // a newer payload, the state records a later one, a newer payload has
      // landed owed its bookkeeping, or a newer one is in another live child's
      // hands about to post, cumulative over this one — is ONE question, asked
      // before stepping aside and again before posting (third and fourth review
      // passes: asked in parts, the parts disagreed).
      const newestHere = newestOf.get(chain) === home;
      const outdated = (state) => !newestHere || recordedAfter(state, payload.prepared_at) || landedAfter(chain, basename(here)) || newerInFlight(chain, basename(here));
      // An earlier payload of the session that another child is still posting
      // lands first (SMD-2035): this one steps aside at once — back under
      // pending/, where the run that lands the predecessor follows up with it,
      // and the next hook run failing that — and the pointer it will carry
      // comes from the state that landing writes. It does not wait: the first
      // cut polled for up to a request's timeout under a budget the run shared,
      // and four review passes found their defects in that budget, while the
      // follow-up posts the payload as soon as the wait would have (fourth
      // review pass). A payload that has landed, or that is outdated, steps
      // aside for no one.
      // A payload that has landed steps aside too: its state write must follow
      // an older sibling's, and two children finishing one session's owed
      // bookkeepings at once wrote the state in no order (tenth review pass;
      // the first pass had spared it the wait, which is gone).
      // A landed one consults them whatever its siblings: outdated or not, its
      // state write must follow an older sibling's (eleventh review pass: one
      // beside a newer payload in this run wrote at once, and raced).
      const ahead = !payload.captured_id && outdated(readState(chain)) ? [] : aheadOf(chain, basename(here));
      if (ahead.length) {
        const moved = moveTo(here, PENDING_DIR());
        // Between the look and that move the predecessor may have landed and
        // run its follow-up over a pending/ that did not yet hold this payload
        // (third review pass). One more look: if the claim has cleared, the
        // payload is taken back and posted now — once — unless the landing run
        // got to it first, in which case that run posts it and this one says so.
        let why = `the session's earlier post is in flight (pid ${ahead[0].pid}); ${moved ? "kept under pending/ for the run that lands it" : "pending/ refused the move, so it stays in this run's hands until the run ends"}`;
        if (moved && !retaken && !aheadOf(chain, basename(here)).length) {
          try { renameSync(home, here); queue.unshift({ home, here, payload, retaken: true }); continue; } catch { why = existsSync(mine) ? "the session's earlier post has cleared and its run has taken this payload up" : "this run's claim directory is gone, swept as stale, so the payload waits under pending/ for the next run"; }
        }
        log(`deferred ${who} — ${why}`);
        outcomes.push({ file, ok: false, deferred: true, error: `deferred: ${why}` });
        continue;
      }
      const state = readState(chain);
      const stateIsNewer = recordedAfter(state, payload.prepared_at);
      // A payload that already LANDED is never obsolete: its id must reach the
      // state, and the newer payload behind it must supersede it (sixth review
      // pass: judged obsolete beside a newer one, the id was lost and two
      // summaries stood). One whose session has a NEWER landed payload owed its
      // bookkeeping is obsolete though the state is silent (second review pass:
      // an old checkpoint posted as "continuing" after the end had landed).
      const obsolete = !payload.captured_id && outdated(state);
      if (obsolete) {
        if (followUp) followedUp--; // a drop is no work the cap bounds
        clearedSessions.add(chain);
        moveTo(here, DEAD_DIR());
        log(`obsolete ${who} — a later capture of the session has a summary; this one is not posted`);
        outcomes.push({ file, ok: false, obsolete: true, error: "obsolete: a later capture of the session has a summary" });
        continue;
      }
      // The pointer is decided when the payload POSTS, not when it was prepared:
      // the session's newest landed thought — what the state records NOW, or a
      // landed payload whose bookkeeping is owed — else what prepare saw. The state only moves forward, so a pointer from
      // prepare time is stale the moment the state names another id — a payload
      // prepared before its predecessor landed pointed past it, and two
      // summaries stood (seventh and eighth review passes).
      if (!payload.captured_id) payload.supersedes = pointerFor(chain, basename(here), state, landedHere.get(chain)) ?? payload.supersedes;
      // A pointer the server has kept failing on — its registry away for good,
      // its audit table unreadable — must not take the summary down with it:
      // on the last attempt it is dropped and the summary lands (seventh review
      // pass). Judged by the failures counted ON the pointer, not by the word
      // in the last error: a store error quoting `p_supersedes` dropped it with
      // a note that lied, and a run of pointer failures ending in one outage
      // still died (eighth review pass).
      const attemptsSoFar = payload.attempts ?? 0;
      const onPointer = payload.supersedes_failures ?? 0;
      // How long the payload has waited: prepared_at, else the millisecond in
      // its own name (written by this machine's clock). Read before the post,
      // so the last resort is taken on the payload's LAST chance — a pointer
      // failing once a day died of age at attempt three, never tried without
      // the pointer (twelfth review pass).
      const waited = Date.now() - (pastMs(payload.prepared_at) || Number(basename(here).split("-")[0]));
      let lastResort = "";
      if (!payload.captured_id && payload.supersedes && onPointer > 0 && (attemptsSoFar >= 4 || waited > PENDING_MAX_AGE_MS)) {
        lastResort = `supersedes dropped: ${onPointer} of ${attemptsSoFar} attempts failed on it${waited > PENDING_MAX_AGE_MS ? ", the payload a week old" : ""}: ${oneLine(payload.last_error ?? "").slice(0, 120)}`;
        delete payload.supersedes;
      }
      // The opt-in model summary (SMD-2014), done here in the detached child:
      // rewrite the derived text into what was decided, or keep the derived one.
      // Not for a payload that already landed, and not again once a model wrote
      // it (summary_model set and persisted by a failed post's writeJson below),
      // so a retry re-posts the model's text rather than re-calling the model.
      if (!payload.captured_id && payload.summary_model === undefined) {
        const m = await modelSummary(cfg, payload);
        if (m) { payload.text = m.text; payload.summary_model = m.model; }
      }
      let posted;
      try {
        // A payload that already landed (its bookkeeping failed last time) is not
        // posted again: the id is on the payload (second review pass — a local
        // fault after the capture counted as a failed attempt and re-posted).
        posted = payload.captured_id ? { id: payload.captured_id, note: payload.captured_note ?? "", sent: payload.captured_sent } : await postCapture(cfg, payload);
      } catch (e) {
        payload.attempts = (payload.attempts ?? 0) + 1;
        payload.last_error = String(e.message ?? e).slice(0, 300);
        if (e.on === "supersedes") payload.supersedes_failures = (payload.supersedes_failures ?? 0) + 1;
        // Dead: the server refused the request as shaped, the key is unknown to
        // it, or the payload has waited a week. A connection or store failure is
        // kept however many times it has failed — a cap of five tries, spent one
        // per session end across one outage, lost the earliest sessions for good
        // while the header promised they would wait (eleventh review pass).
        // The key unknown to the server is the JSON-RPC code rpc() names, not the
        // word — a store's own "401 Unauthorized" quoted inside an `Error:` is an
        // outage to wait out (twelfth review pass).
        const dead = e.kind === "refused" || /JSON-RPC -32(?:001|60[12])\b/.test(payload.last_error) || (Number.isFinite(waited) && waited > PENDING_MAX_AGE_MS);
        try { writeJson(here, payload); } catch { /* the claim is gone from under us; nothing to update */ }
        clearedSessions.add(chain); // the claim clears: an end that stepped aside for this payload must not wait for an unrelated run (fifth review pass)
        moveTo(here, dead ? DEAD_DIR() : PENDING_DIR());
        log(`${dead ? "dead" : "pending"} ${who} attempt=${payload.attempts}${dead && waited > PENDING_MAX_AGE_MS ? ` waited=${Math.round(waited / 86_400_000)}d` : ""} error="${payload.last_error}"`);
        outcomes.push({ file, ok: false, error: payload.last_error, dead });
        continue;
      }
      const { id } = posted;
      clearedSessions.add(chain);
      landedHere.set(chain, { id, ms: payloadMoment(payload.prepared_at, Number(basename(here).split("-")[0])) });
      const note = [posted.note, lastResort].filter(Boolean).join("; ");
      // Bookkeeping, apart from the post: the id goes onto the payload first, so a
      // fault here leaves a file the next run finishes without posting twice. A
      // landed payload whose session already records a NEWER summary is finished
      // without moving the state back to it (third review pass). The ORDER is
      // load-bearing: the id goes onto the file, the state is read AGAIN, then
      // written, then the claim removed — a sibling's end steps aside until the
      // claim clears, so its state write follows this one; and a sibling that
      // landed a newer summary meanwhile must not be moved back to this one
      // (eighth review pass of SMD-1298). The state is read after the id write:
      // read before it, a stall between the two let a sibling's state, written
      // meanwhile, be overwritten by this older one (ninth review pass).
      try {
        if (!payload.captured_id) writeJson(here, { ...payload, captured_id: id, captured_note: note, ...(posted.sent ? { captured_sent: posted.sent } : {}) });
        const stateIsNewerNow = stateIsNewer || recordedAfter(readState(chain), payload.prepared_at);
        // summary_at never runs ahead of the clock that will read it back.
        const summaryAt = Number.isNaN(pastMs(payload.prepared_at)) ? new Date().toISOString() : payload.prepared_at;
        if (!stateIsNewerNow) writeState(chain, { chain_id: chain, thought_id: id, fingerprint: payload.fingerprint, captured_at: new Date().toISOString(), summary_at: summaryAt, harness: payload.harness, prompts: payload.prompts, sources: (payload.derived_from ?? []).length });
        unlinkSync(here);
        // `supersedes_sent`: postCapture's `sent`, what the post asked — a
        // capture-only key's server may drop it without a word (SMD-2473).
        log(`captured ${who} harness=${payload.harness}${payload.event && payload.event !== "SessionEnd" ? ` event=${payload.event}${payload.trigger ? ` trigger=${payload.trigger}` : ""}` : ""} id=${id} sources=${(payload.derived_from ?? []).length}${posted.sent ? ` supersedes_sent=${posted.sent}` : ""}${payload.redactions?.length ? ` redactions=${payload.redactions.length}` : ""}${note ? ` note="${note}"` : ""}`);
        outcomes.push({ file, ok: true, id, note });
      } catch (e) {
        moveTo(here, PENDING_DIR());
        log(`captured ${who} id=${id} but the bookkeeping failed: ${String(e.message ?? e).slice(0, 200)} — the payload keeps the id for the next run`);
        outcomes.push({ file, ok: true, id, note: [note, "bookkeeping deferred"].filter(Boolean).join("; ") });
      }
    }
  } finally {
    // Anything still claimed (an unexpected throw) goes back; then the claim directory goes.
    release(mine);
  }
  return outcomes;
}

/** Hand the network half to a child that outlives this process; stdout/stderr go to the log. */
function detachPost(payloadPaths, brain) {
  ensureDirs();
  const fd = openSync(LOG_PATH(), "a", 0o600);
  const child = spawn(process.execPath, [SELF, ...(brain ? ["--brain", brain] : []), ...payloadPaths.flatMap((p) => ["--post", p])], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env },
  });
  child.unref();
  closeSync(fd);
  return child.pid;
}

/** --check for one brain: its endpoint, its key's surface, the deprecated routes (SMD-2686, SMD-3057); `tag` prefixes each line ("[canary] "). Returns the exit code. */
async function checkBrain(cfg, tag, onSecret) {
  // An answer from the root through the proxy's legacy route worked until
  // v2.0.0 closed it (SMD-2532), so on an older stack it is a warning, not a failure.
  // A tier's route through stable's proxy closes then too (SMD-3057), and
  // its /mcp is stable's: the tier itself is the url to set. Each route's
  // Deprecation date is its own, stamped by a release and never moved
  // (RFC 9745: when the deprecation began), so it says which answered:
  // the tiers' @1792108800, the root's @1790899200. Another date falls
  // back to the Link's anchor, and with no deprecation Link to the url's
  // tier path, in case as the routers match it. Said on a refused answer
  // too: a tier route with no tier behind it is a 404, and its client is
  // the one to tell.
  const warnDeprecated = () => {
    if (!cfg.deprecation) return;
    const u = new URL(cfg.url); // endpointOf made it, so it parses
    const link = cfg.deprecationLink ?? "";
    const tierRoute = cfg.deprecation === "@1792108800" || (cfg.deprecation !== "@1790899200" && (/rel="deprecation"/.test(link) ? /#a-canary-beside-the-stack>/.test(link) : /^\/(canary|working)\/mcp(\/|$)/.test(u.pathname)));
    if (tierRoute) {
      console.error(`${tag}warning: ${shownUrl(cfg.url)} answered through the proxy's deprecated tier route (Deprecation: ${cfg.deprecation}), which stops answering at v2.0.0 — set the url in ${cfg.where ?? urlSource()} to the tier itself, a canary's own port (deploy/canary.sh), never stable's /mcp (deploy/README.md, "A canary beside the stack")`);
    } else {
      let to = "its /mcp";
      if (u.pathname === "/") to = shownUrl(`${u.origin}/mcp${u.search}`);
      console.error(`${tag}warning: ${shownUrl(cfg.url)} answered through the proxy's deprecated legacy route (Deprecation: ${cfg.deprecation}), which stops answering at v2.0.0 — set the url to ${to} in ${cfg.where ?? urlSource()} (deploy/README.md, "Moving a client to /mcp")`);
    }
  };
  let tools;
  try { tools = ((await rpc(cfg, "tools/list", {}, 15_000)).tools ?? []).map((t) => t.name).sort(); } catch (e) { console.error(`session-capture: ${tag}${shownUrl(cfg.url)} did not answer tools/list — ${e.message}`); warnDeprecated(); return 1; }
  // The summary mode, and whether a configured model would run — read from the
  // config, the model endpoint not called (SMD-2014).
  if (cfg.summary === "model") console.log(`${tag}${modelStatusLine(cfg)}`);
  warnDeprecated();
  // A capture key's surface: capture_thought, since SMD-3664 the priority writers (on a thought it captured alone) and
  // since SMD-3665 the open-item writers (on an item it opened alone) — no read. A server before SMD-3664 lists
  // capture_thought alone.
  if (tools.includes("capture_thought") && tools.every((t) => CAPTURE_SURFACE.has(t))) { console.log(`${tag}ok: ${shownUrl(cfg.url)} answers, and the key sees ${tools.join(", ")} alone (capture scope). On a secret: ${onSecret}. State: ${STATE_DIR}`); return 0; }
  if (!tools.includes("capture_thought")) { console.error(`session-capture: ${tag}the key cannot capture — its surface is [${tools.join(", ")}]. Mint one with: bun server-portable/keygen.ts --name session-hook --scope capture`); return 1; }
  console.error(`${tag}warning: the key can capture, and it can also ${tools.filter((t) => !CAPTURE_SURFACE.has(t)).join(", ")} — a leak of this file reads your brain. Prefer a capture-scoped key: bun server-portable/keygen.ts --name session-hook --scope capture`);
  return 0;
}

export { checkBrain, detachPost };
