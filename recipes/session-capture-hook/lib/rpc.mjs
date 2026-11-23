/**
 * lib/rpc.mjs — the session hook's MCP client (SMD-4338): one JSON-RPC call
 * over Streamable HTTP with its timeout, the answer parsed from JSON or SSE,
 * a refusal and the SDK's errors by their words, a tool's result as text, and
 * the brain's verdict on a write (`verdictOf`, `providerMends`), which the
 * capture and the write fan-out both keep or give up by. The capture, the
 * write fan-out and the claims renewal all call through it.
 */

import { shownUrl } from "./util.mjs";
import { CONFIG_PATH } from "./state.mjs";

/**
 * Parse a Streamable-HTTP answer: raw JSON, or an SSE stream whose LAST event
 * is the JSON-RPC message. An event's data is every `data:` line joined with
 * newlines, the optional space after the colon dropped — the spec's shape, not
 * only the one-line form the server sends today (first review pass).
 */
export function parseRpcBody(text, wantId) {
  const t = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (t.startsWith("{")) return JSON.parse(t);
  const messages = t.split(/\n\n+/)
    .map((ev) => ev.split("\n").filter((l) => /^data:/.test(l)).map((l) => l.replace(/^data:\s?/, "")).join("\n"))
    .filter((d) => d.length > 0)
    .map((d) => { try { return JSON.parse(d); } catch { return null; } })
    .filter((m) => m && typeof m === "object");
  if (!messages.length) throw new Error(`not a JSON-RPC answer: ${t.slice(0, 80)}`);
  // The reply to THIS request by id; else the last message that is a reply at
  // all — a trailing notification (a ping) is not the answer (second review pass).
  return messages.find((m) => wantId !== undefined && m.id === wantId)
    ?? [...messages].reverse().find((m) => m.result !== undefined || m.error !== undefined)
    ?? messages[messages.length - 1];
}

/** Why a capture did not land: `refused` — the server said no to the request as shaped (nothing will change on a retry); `failed` — the server, the store or the network did not answer (a retry may). */
export class CaptureError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}
// The server's own refusals open with "Refused:" — that alone; a store error
// phrased with "not found" or "must be" is a failure to keep (second review
// pass). The SDK's unknown-tool and invalid-params errors are RESULTS with
// isError set, whose text opens "MCP error -32602" — not JSON-RPC errors
// (thirteenth review pass: a key whose scope had been narrowed retried its
// unknown tool for a week). Both are final.
export const REFUSAL_RE = /^\s*Refused\b/;
export const SDK_ERROR_RE = /^\s*MCP error -3260[12]\b/;

/** One request's ceiling. */
const POST_TIMEOUT_MS = 90_000;

let rpcId = 1;
export async function rpc(cfg, method, params, timeoutMs = POST_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const id = rpcId++;
    const r = await fetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-brain-key": cfg.key },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      redirect: "manual", // a redirect is a page or a front, not the endpoint (sixth review pass: a 301 to a login page was five silent retries)
      signal: ac.signal,
    });
    const text = await r.text();
    // The proxy's legacy root route marks every answer it carries; --check
    // reads it off the config to say the url must move to /mcp (SMD-2686).
    // Its tier routes mark theirs too, with a date of their own; the Link is
    // --check's fallback for a date neither route sent (SMD-3057).
    const deprecation = r.headers.get("deprecation");
    if (deprecation) {
      cfg.deprecation = deprecation;
      cfg.deprecationLink = r.headers.get("link") ?? "";
    }
    // Every url this prints is masked (SMD-2743): a message lands in the log.
    const at = shownUrl(cfg.url);
    const wrongUrl = (what) => new CaptureError("refused", `${what} from ${at} — not the MCP endpoint, or a proxy in front of it; check the url in ${CONFIG_PATH}`);
    // The server answers inside a 200 — a 4xx is a proxy, a login page, or a
    // URL that is not the endpoint: said once and given up, not retried five
    // times as a transient (fifth review pass). A 5xx is the server or its
    // front unwell, and kept; so are 408 and 429, the endpoint asking for
    // patience. A 4xx that carries a JSON-RPC envelope is judged by the
    // envelope — a front mirroring -32001 onto HTTP 401 is a bad KEY, not a
    // bad url (sixth review pass).
    if (r.status >= 300 && r.status < 400) throw wrongUrl(`HTTP ${r.status} redirect to ${r.headers.has("location") ? shownUrl(r.headers.get("location"), cfg.url) : "?"}`);
    if (r.status === 408 || r.status === 429) throw new CaptureError("failed", `HTTP ${r.status} from ${at} — the endpoint asks for patience`);
    if (r.status >= 400 && r.status < 500) {
      let inner = null;
      try { inner = parseRpcBody(text, id); } catch { /* no envelope: a page */ }
      if (inner?.error) throw new Error(`JSON-RPC ${inner.error.code ?? ""}: ${inner.error.message ?? "error"}`.trim());
      throw wrongUrl(`HTTP ${r.status}`);
    }
    if (r.status >= 500) throw new CaptureError("failed", `HTTP ${r.status} from ${at}`);
    if (/text\/html/i.test(r.headers.get("content-type") ?? "") && !text.trimStart().startsWith("{")) throw wrongUrl("an HTML page");
    const body = parseRpcBody(text, id);
    if (body.error) throw new Error(`JSON-RPC ${body.error.code ?? ""}: ${body.error.message ?? "error"}`.trim());
    return body.result ?? {};
  } finally {
    clearTimeout(timer);
  }
}

const textOfResult = (result) => (result?.content ?? []).map((c) => c?.text ?? "").join("\n");

/**
 * A tool's result as the harness hands it to a PostToolUse hook, as text. The
 * shape of an MCP tool's `tool_response` is not documented, so every shape a
 * result takes is read: a string (or the JSON of one of the others), a list of
 * content blocks, or an object carrying them.
 */
export function resultText(resp) {
  if (resp == null) return "";
  if (typeof resp === "string") {
    const t = resp.trim();
    if (t.startsWith("[") || t.startsWith("{")) { try { return resultText(JSON.parse(t)); } catch { /* not JSON: the text itself */ } }
    return resp;
  }
  if (Array.isArray(resp)) return resp.map((c) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : "")).join("\n");
  if (typeof resp === "object") {
    if (Array.isArray(resp.content)) return resultText(resp.content);
    if (typeof resp.text === "string") return resp.text;
    if (typeof resp.structuredContent?.text === "string") return resp.structuredContent.text;
    if (resp.result && typeof resp.result === "object") return resultText(resp.result);
  }
  return "";
}

/**
 * Whether a refusal is the brain's embedding provider refusing the call (SMD-2892): EMBEDDING_PROVIDER_ERROR, any
 * status. Its key, its model, its address, a gateway's answer, or a request it refuses — a 400 included, which a
 * hosted provider answers to every call for a setting it will not take (the maintainer's call, 2026-11-12: kept, as
 * before the code, rather than lose every summary to a misconfigured brain). Such a payload is kept, as a transient
 * is, until the mend lands it or the week is up.
 */
export function providerMends(result) {
  return result?.structuredContent?.code === "EMBEDDING_PROVIDER_ERROR";
}

/**
 * The server's machine-readable verdict on a result (SMD-1978), read from the
 * MCP result's `structuredContent` — `{ code, retryable, positions? }` — and,
 * for a server from before that field, derived from the prose rules unchanged.
 * `retryable` is the transient/final split (a kept payload vs a dead one);
 * `mend` names a pointer a retry should drop to mend the capture; `positions`
 * the derived_from indices to drop (absent for a key that may not know a source
 * exists — the existence-oracle rule); `on` marks a pointer the server could not
 * judge, which postPending counts. The hook keys on this, not on English.
 */
export function verdictOf(result, text) {
  const sc = result?.structuredContent;
  if (sc && typeof sc.code === "string") {
    // Valid indices only: a non-array, or a float, string or NEGATIVE element
    // from a non-conforming server, is dropped — a negative would otherwise pass
    // the retry loop's upper bound and drop nothing while burning a retry (review
    // pass 2). An empty result falls to the drop-all salvage, as a capture key's
    // position-less refusal does.
    const positions = Array.isArray(sc.positions) ? sc.positions.filter((n) => Number.isInteger(n) && n >= 0) : [];
    // The shape refusals took a code in SMD-2283 (before it they were prose the
    // rules below read): each mends the pointer its prose named, so the hook
    // drops and retries exactly what it did before.
    const mend = (sc.code === "DERIVED_FROM_MISSING" || sc.code === "REFUSED_DERIVED_FROM_SHAPE") ? "derived"
      : (sc.code === "REFUSED_SUPERSEDES_UNKNOWN" || sc.code === "REFUSED_SUPERSEDES_OWNERSHIP" || sc.code === "REFUSED_SUPERSEDES_SHAPE") ? "supersedes"
      : sc.code === "REFUSED_METADATA_SHAPE" ? "metadata"
        : (sc.retryable !== true && sc.code !== "EMBEDDING_PROVIDER_ERROR" && /metadata/.test(text)) ? "metadata" // a coded metadata REFUSAL a later server might send — mended by the prose beside the code; gated on non-retryable so a transient that merely mentions metadata is kept whole, as the prose path is (SMD-2168 review passes 1–2), and never on EMBEDDING_PROVIDER_ERROR, whose provider's words may say metadata (SMD-2892)
          : null;
    return { code: sc.code, retryable: sc.retryable === true, mend, positions, on: sc.code === "SUPERSEDES_UNJUDGED" ? "supersedes" : undefined };
  }
  // A server from before SMD-1978: the prose rules, unchanged. A "Refused:" is
  // final and may be mended by dropping the pointer it names; an "Error:" (the
  // store away, a pointer it could not judge) is a transient the payload keeps.
  const isRefused = REFUSAL_RE.test(text);
  const refused = isRefused || SDK_ERROR_RE.test(text);
  const mend = isRefused ? (/derived_from/.test(text) ? "derived" : /supersedes/.test(text) ? "supersedes" : /metadata/.test(text) ? "metadata" : null) : null;
  return {
    code: null, retryable: !refused, mend,
    positions: [...text.matchAll(/derived_from\[(\d+)\]/g)].map((m) => Number(m[1])),
    on: /this key's `supersedes` could not be (?:checked|attributed)/.test(text) ? "supersedes" : undefined,
  };
}

export { POST_TIMEOUT_MS, textOfResult };
