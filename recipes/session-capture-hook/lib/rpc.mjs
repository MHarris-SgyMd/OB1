/**
 * lib/rpc.mjs — the session hook's MCP client (SMD-4338): one JSON-RPC call
 * over Streamable HTTP with its timeout, the answer parsed from JSON or SSE,
 * a refusal and the SDK's errors by their words, and a tool's result as text.
 * The capture, the write fan-out and the claims renewal all call through it.
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

export { POST_TIMEOUT_MS, textOfResult };
