/**
 * lib/model.mjs — the opt-in model summary (SMD-2014; moved here by SMD-4338):
 * the egress rule a model endpoint is held to, --check's line for it, and the
 * call that rewrites an episode's derived summary into what was decided,
 * falling back to the derived text on every failure.
 */

import { log } from "./state.mjs";
import { scanForSecrets } from "./secrets.mjs";
import { eventSpec } from "./hook.mjs";
import { LIMITS, chainOf } from "./episode.mjs";

// ── The opt-in model summary (SMD-2014) ──────────────────────────────────────

/** One model call's ceiling. The detached child has no 1.5 s hook budget, but a summary is not worth a long wait; a slower model falls back to the derived one. */
const MODEL_TIMEOUT_MS = 30_000;

/** The model's brief: Daemonic Brain's plain register, what to write, the caps, and the guards. */
const MODEL_SYSTEM = [
  "You are writing a memory of one piece of a coding session's work, to be stored and retrieved later by any AI.",
  "From the derived summary and the assistant's own messages below, write plain, direct prose covering:",
  "- what was DECIDED, and why;",
  "- what was left OPEN;",
  "- what CHANGED.",
  "Rules: at most ~200 words; no preamble, no headings, no lists, no markdown; name no thought ids and no file paths you were not given; include no keys, tokens or secrets; if the messages do not say, do not invent — write only what they support. Write about this one piece of work alone.",
].join("\n");

/**
 * May the model endpoint be called under the hook's egress policy (SMD-2014,
 * mirroring the server's SMD-1903 gate)? "Local" is DECLARED (`model_local`),
 * never guessed from the address — a loopback URL behind a forwarding proxy is
 * not local, and a LAN model a box declares local is. Under deny (the default
 * and the fail-closed value) only a declared-local endpoint may be called;
 * allow and off permit any. Returns null when allowed, else the reason.
 */
export function egressRefusalForModel(cfg) {
  if (cfg.egress === "off" || cfg.egress === "allow") return null;
  if (cfg.modelLocal) return null;
  return `egress policy "${cfg.egress}" and the model endpoint is not declared local — set "model_local": true in the config for a model on this machine, or "egress" to "allow"`;
}

/** One line for --check and --dry-run: what the summary will be, and if a model is configured, whether egress would let it run — without calling it. */
export function modelStatusLine(cfg) {
  if (cfg.summary !== "model") return `summary: derived (the default; set "summary": "model" for a local model to write what was decided)`;
  if (!cfg.modelUrl || !cfg.model) return `summary: model — but no model_url/model is configured, so the derived summary is sent`;
  const refusal = egressRefusalForModel(cfg);
  if (refusal) return `summary: model at ${cfg.modelUrl} (${cfg.model}) — but egress would refuse it (${refusal}), so the derived summary is sent`;
  return `summary: model at ${cfg.modelUrl} (${cfg.model}); egress ${cfg.egress}${cfg.modelLocal ? ", endpoint declared local" : ""}`;
}

/**
 * The model summary of one episode, or null to keep the derived one already in
 * the payload (SMD-2014). Runs in the DETACHED child, never the foreground:
 * the hook's budget is 1.5 s, this is seconds. Every way it can go wrong — the
 * option off, no endpoint declared, egress refusing a non-local endpoint, a
 * slow or failed or empty call, or a secret in the model's OWN words — falls
 * back to the derived summary and logs why: a well-formed memory beats none.
 * The model is shown the derived summary and the assistant's messages only,
 * never tool results or the raw transcript, and it names no ids — `derived_from`
 * stays the derived summary's provenance whichever text is sent.
 */
export async function modelSummary(cfg, payload, fetchImpl = fetch) {
  if (cfg.summary !== "model" || typeof payload.assistant !== "string") return null; // derived: the option is off, or the payload was prepared before it was on
  const chain = chainOf(payload);
  // A running checkpoint keeps its DERIVED summary: its `Checkpoint: …
  // continuing` line is the signal a sibling session reads and search marks
  // superseded, and a free rewrite would drop it. The model writes the durable
  // summary at the episode's end (a compaction that CLOSES the episode, so its
  // payload carries no event, or the session's end), which supersedes the
  // checkpoint's derived text (SMD-2014). Read from the event table that
  // renderSummary's Checkpoint line derives from, not the rendered text (first
  // review pass: matching the rendered wording was fragile and untested).
  if (eventSpec(payload.event)?.checkpoint) return null;
  if (!cfg.modelUrl || !cfg.model) { log(`model summary skipped for ${chain}: summary=model but no model_url/model configured — derived summary sent`); return null; }
  // The assistant messages are scanned before they leave the box, as the
  // derived text was at prepare and the model's own output is below: a key in a
  // message that is not the last outcome is absent from the derived summary,
  // so the summary's scan never saw it (first review pass: both reviewers found
  // the excerpt left the box unscanned). Since 1.11.4 prepare scans whole each
  // message the excerpt reaches and withholds the excerpt on a hit (SMD-3656);
  // this scan is the net under that one, and the only gate for a payload a
  // hook before 1.11.4 queued. A hit keeps the derived summary; nothing is
  // sent to the model.
  const leak = scanForSecrets(payload.assistant);
  if (leak.length) { log(`model summary refused for ${chain}: ${leak[0].reason} at char ${leak[0].at} in the assistant messages — nothing sent to the model, derived summary sent`); return null; }
  const refusal = egressRefusalForModel(cfg);
  if (refusal) { log(`model summary refused for ${chain}: ${refusal} — derived summary sent`); return null; }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.modelTimeout ?? MODEL_TIMEOUT_MS);
  try {
    const r = await fetchImpl(`${cfg.modelUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cfg.modelKey ? { Authorization: `Bearer ${cfg.modelKey}` } : cfg.modelBasic ? { Authorization: `Basic ${cfg.modelBasic}` } : {}) },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        messages: [
          { role: "system", content: MODEL_SYSTEM },
          { role: "user", content: `Derived summary:\n${payload.text}\n\nThe assistant's messages for this piece of work:\n${payload.assistant || "(none)"}` },
        ],
      }),
      redirect: "manual", // a redirect is a proxy or a login page, not the model
      signal: ac.signal,
    });
    if (!r.ok) { log(`model summary failed for ${chain}: HTTP ${r.status} from the model endpoint — derived summary sent`); return null; }
    let body; try { body = await r.json(); } catch { log(`model summary failed for ${chain}: the model endpoint did not answer JSON — derived summary sent`); return null; }
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) { log(`model summary empty for ${chain} — derived summary sent`); return null; }
    const out = text.trim().slice(0, LIMITS.textChars);
    // The scan runs on the model's OWN words too: it can quote a key the derived
    // summary would not have (SMD-2014). A hit keeps the derived text, which the
    // prepare-time scan already cleared, rather than refusing the episode.
    const findings = scanForSecrets(out);
    if (findings.length) { log(`model summary refused for ${chain}: ${findings[0].reason} at char ${findings[0].at} in the model's output — derived summary sent`); return null; }
    return { text: out, model: cfg.model };
  } catch (e) {
    log(`model summary failed for ${chain}: ${String(e?.message ?? e).slice(0, 120)} — derived summary sent`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
