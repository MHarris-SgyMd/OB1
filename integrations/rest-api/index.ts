// MIGRATED OFF SUPABASE: imports compat/supabase-sql instead of @supabase/supabase-js.
// Same API, but it speaks SQL directly. The environment variable NAMES are
// unchanged — set SUPABASE_URL to a postgres:// connection string, and
// SUPABASE_SERVICE_ROLE_KEY is ignored (credentials live in the URL).
// ob1-original-import: @supabase/supabase-js
// Revert with: bun scripts/migrate-to-sql-shim.ts --revert <file>
// ob1-fork (SMD-1228): a thought's content and vector are written through the
// functions that own them — update_thought for an edit, the 3-argument
// upsert_thought for a capture — so the fingerprint (003/018), the model label
// (021) and the chunk rows (022) follow the text and vector, and the actor
// reaches the audit (008). FORK.md change 69; extensions/test-writes.ts drives it
// against Postgres, and scripts/check-fork-consistency.ts check 10 holds it.
// SMD-1541 (change 103): the key's name rides as the actor — p_actor on
// update_thought, actor in upsert_thought's payload — so 008's row names it;
// change 69 passed none, and the clause above was false until then. This server
// holds one key, MCP_ACCESS_KEY, so the name is the variable's (ACTOR_NAME below).
// A capture's, an edit's and an enrich's row; the raw deletes (DELETE /thought/:id,
// the duplicate-resolve merge's) and the merge's raw metadata write on the
// survivor still leave rows naming nobody — SMD-1793.
// ob1-fork (SMD-2054): POST /search drops the restricted tier by the
// sensitivity_tier COLUMN and reads its date bounds as instants, in both
// modes, and GET /recent takes the tier filter its siblings had — the note
// above columnsOf() says what leaked, what answered nothing, and why.
// ob1-fork (SMD-2079): every response carries the request's CORS headers, set
// once on the way out of the main handler (withCors) — json() built them from
// the request only when handed `req`, and forty-five answers were not.
// ob1-fork (SMD-2110): the ingest proxy's upstream is SMART_INGEST_URL, an
// http(s) address of its own, refused at boot under any other scheme; unset,
// POST /ingest and POST /ingestion-jobs/:id/execute answer 503 naming it. Both
// built the URL from SUPABASE_URL — the Postgres DSN here — so every call
// handed fetch() the database credentials and answered 502.
/**
 * rest-api — REST API gateway for Open Brain.
 *
 * Provides simple REST endpoints for non-MCP clients (ChatGPT Actions,
 * Gemini extensions, dashboards, webhooks, and custom integrations).
 *
 * Routes:
 *   POST /search              — search thoughts (semantic or text)
 *   POST /capture             — capture a new thought
 *   GET  /recent              — recent thoughts (paginated)
 *   GET  /thoughts            — browse thoughts with filters
 *   GET  /thought/:id         — get single thought
 *   PUT  /thought/:id         — update thought content
 *   PATCH /thought/:id/enrich — re-enrich thought
 *   DELETE /thought/:id       — delete thought
 *   GET  /thought/:id/connections — related thoughts
 *   GET  /count               — count thoughts with filters
 *   GET  /stats               — brain stats summary
 *   POST /ingest              — proxy to the smart-ingest server (SMART_INGEST_URL)
 *   GET  /ingestion-jobs      — list ingestion jobs
 *   GET  /ingestion-jobs/:id  — get job detail
 *   POST /ingestion-jobs/:id/execute — execute a dry-run job
 *   GET  /duplicates          — find near-duplicate pairs
 *   POST /duplicates/resolve  — merge and resolve a duplicate pair
 *   GET  /entities            — browse/search entities
 *   GET  /entities/:id        — entity detail with thoughts and edges
 *   GET  /health              — health check
 *
 * Auth: x-brain-key header or Authorization: Bearer <key>.
 * Header-only by design — the key is never read from the URL query string,
 * which would leak it into CDN/proxy/server access logs.
 *
 * Dependencies:
 *   - Enhanced thoughts schema (schemas/enhanced-thoughts)
 *   - Optional: Smart ingest tables (schemas/smart-ingest-tables) for /ingest routes
 *   - Optional: Knowledge graph schema (schemas/knowledge-graph) for /entities routes
 */

import { createClient } from "../../compat/supabase-sql/index.ts";
import {
  embedText,
  embeddingModelUsed,
  extractMetadata,
  fallbackMetadata,
  detectSensitivity,
  resolveSensitivityTier,
  mergeUniqueStrings,
  normalizeStringArray,
  prepareThoughtPayload,
  computeContentFingerprint,
  isRecord,
  asString,
  safeEmbedding,
} from "./_shared/helpers.ts";
import {
  SENSITIVITY_TIERS,
  ALLOWED_TYPES,
} from "./_shared/config.ts";

// ── Environment ─────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const MCP_ACCESS_KEY = process.env.MCP_ACCESS_KEY ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/**
 * An HTTP target read from its own variable, or null when unset: never derived from SUPABASE_URL, which on this fork is the
 * Postgres connection string — a URL built on it carries the database credentials into fetch() and fails there
 * (SMD-2110). Any scheme but http(s) is refused at boot; the message names the scheme, not the value.
 */
function httpTargetFrom(name: string): string | null {
  const value = process.env[name]?.trim().replace(/\/+$/, "");
  if (!value) return null;
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):/i)?.[1] ?? "";
  if (!/^https?$/i.test(scheme)) throw new Error(`${name} must be an http(s) URL — it is ${scheme ? `a ${scheme}:// URL` : "not a URL"}`);
  return value;
}
/** The smart-ingest server's address (integrations/smart-ingest), the proxy routes' upstream; unset, they answer 503. */
const SMART_INGEST_URL = httpTargetFrom("SMART_INGEST_URL");

// ob1-fork (SMD-1541): the name 008's audit row records for a write through
// this server. It holds one key, MCP_ACCESS_KEY, compared in place (change 67
// left it off _shared/auth.ts), so the name is the variable's — the name
// auth.ts gives the same legacy key where a server does use the module.
const ACTOR_NAME = "MCP_ACCESS_KEY";
// The actor every write here passes — p_actor on update_thought, `actor` in
// upsert_thought's payload — for 008's audit row (the trigger's body is 046's
// now; 010, 025 and 046 redefined it whole): the key's name, and this server as
// `via`, which the trigger stamps as the row's `origin` column (SMD-1730; it
// kept it in actor_context until then). No source: the row's `source` is its
// own metadata.source, read by the trigger, so the column says where the
// thought came from and origin which door wrote it. Without
// the name the row named nobody. When SMD-1798 moves this file onto
// MCP_ACCESS_KEYS, `name` becomes the principal's — extensions/test-writes.ts
// runs under the legacy key alone and would not notice a stale constant.
const ACTOR = { name: ACTOR_NAME, via: "rest-api" };

// ── CORS ────────────────────────────────────────────────────────────────────

/**
 * CORS allowlist from env (comma-separated). When unset, defaults to "*"
 * for backward compatibility. See README Security section — combining "*"
 * with write methods is unsafe for production; set CORS_ALLOWED_ORIGINS
 * to your dashboard origin(s) to restrict.
 */
const CORS_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * The CORS headers for one request. Access-Control-Allow-Origin is the request's Origin when the allowlist names it,
 * `*` with no list, and absent otherwise: the literal `null` is an opaque origin's own (a sandboxed iframe, a `data:`
 * document), so answering it matched what the list was meant to fail (SMD-2079). Retry-After is exposed for the 429.
 */
function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-brain-key",
    "Access-Control-Expose-Headers": "Retry-After",
    "Vary": "Origin",
  };
  if (CORS_ALLOWED_ORIGINS.length === 0) {
    headers["Access-Control-Allow-Origin"] = "*"; // Legacy default: permissive. README warns against this for writes.
  } else if (origin && CORS_ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

/**
 * The answer with the request's CORS headers over its own, set once here for every response the exported handler
 * returns — a page, a refusal, the preflight, the 404, the 500 (SMD-2079; the note at the top of the file says what
 * answered without them). A header the route set under the same name is replaced, `Vary` among them: a route that
 * needs another `Vary` token adds it here, not to its answer.
 */
function withCors(req: Request, res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [name, value] of Object.entries(corsHeadersFor(req))) headers.set(name, value);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

// ── Rate Limiting ───────────────────────────────────────────────────────────

/**
 * Simple in-memory per-key rate limiter. Window is 60 seconds; cap from
 * RATE_LIMIT_PER_MIN env var (default 100). State is process-local so it
 * resets on restart — good enough to block naive burn
 * attacks against a leaked key, not a replacement for a durable limiter.
 */
const RATE_LIMIT_PER_MIN = (() => {
  const raw = Number(process.env.RATE_LIMIT_PER_MIN ?? "100");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 100;
})();

const RATE_LIMIT_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Returns null if under limit, or a Response (429) if the key is over. */
async function checkRateLimit(key: string): Promise<Response | null> {
  const hashed = await hashKey(key);
  const now = Date.now();
  const bucket = rateBuckets.get(hashed);
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(hashed, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return null;
  }
  if (bucket.count >= RATE_LIMIT_PER_MIN) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return new Response(
      JSON.stringify({ error: "rate_limited", retry_after_seconds: retryAfter }, null, 2),
      { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(retryAfter) } },
    );
  }
  bucket.count++;
  return null;
}

/** Extract the presented key for rate-limit bucketing. Caller must pass only authenticated keys. */
function presentedKey(req: Request): string {
  return (
    req.headers.get("x-brain-key")?.trim() ||
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim()
  );
}

// ── Auth ────────────────────────────────────────────────────────────────────

/**
 * Constant-time string comparison to prevent timing attacks.
 * Compares byte-by-byte and accumulates differences via XOR so the
 * total runtime depends only on the longer of the two inputs, not on
 * where they first differ.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const ae = encoder.encode(a);
  const be = encoder.encode(b);
  if (ae.byteLength !== be.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < ae.byteLength; i++) diff |= ae[i] ^ be[i];
  return diff === 0;
}

function isAuthorized(req: Request): boolean {
  const key =
    req.headers.get("x-brain-key")?.trim() ||
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!key) return false;
  return timingSafeEqual(key, MCP_ACCESS_KEY.trim());
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Validate a thought id: a UUID (thoughts.id on this fork) or an integer
 * (upstream's enhanced schema). Returns the string as-is — never parsed to a
 * number, for BIGINT safety. Digits only used to be the rule, so every
 * /thought/:id route here answered 404 to a fork's row (upstream #379's class).
 */
function validateId(raw: string): string | null {
  return /^\d+$/.test(raw) || UUID_RE.test(raw) ? raw : null;
}

/**
 * Extract thought ID from upsert_thought RPC response, which may return:
 *   - A scalar number (e.g. 42)
 *   - { thought_id: 42, action: "inserted", content_fingerprint: "..." }
 *   - { id: 42 }
 *   - { id: 42, action: "inserted", content_fingerprint: "..." }
 *   - this fork's (db/migrations/035): { id: "<uuid>", fingerprint: "...", existed: false, supersedes: null }
 * Returns the ID as a string for BIGINT safety, or null if extraction fails.
 */
function extractThoughtId(data: unknown): { id: string; action: string; fingerprint: string | null } | null {
  if (data == null) return null;

  // Scalar number or string
  if (typeof data === "number" || typeof data === "string") {
    const s = String(data);
    return validateId(s) ? { id: s, action: "inserted", fingerprint: null } : null;
  }

  if (!isRecord(data)) return null;
  const rec = data as Record<string, unknown>;

  // Try thought_id first, then id
  const rawId = rec.thought_id ?? rec.id;
  if (rawId == null) return null;
  const idStr = String(rawId);
  if (!validateId(idStr)) return null;

  const fingerprint = rec.content_fingerprint ?? rec.fingerprint;
  return {
    id: idStr,
    action: typeof rec.action === "string" ? rec.action : rec.existed === true ? "updated" : "inserted",
    fingerprint: typeof fingerprint === "string" ? fingerprint : null,
  };
}

function sanitizeType(value: string): string {
  const normalized = value.trim().toLowerCase();
  return ALLOWED_TYPES.has(normalized) ? normalized : "idea";
}

function parseAggregateCounts(
  value: unknown,
  keyName: "type" | "topic",
): Array<{ key: string; count: number }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!isRecord(entry)) return null;
      const key = String(entry[keyName] ?? "").trim();
      const count = Number(entry.count ?? 0);
      if (!key || !Number.isFinite(count)) return null;
      return { key, count };
    })
    .filter((entry): entry is { key: string; count: number } => entry !== null)
    .sort((left, right) => right.count - left.count);
}

// ── Main Handler ────────────────────────────────────────────────────────────

const route = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  if (!MCP_ACCESS_KEY) {
    console.warn("MCP_ACCESS_KEY is not set — all requests will be rejected.");
    return json({ error: "Service misconfigured: auth key not set" }, 503);
  }
  if (!isAuthorized(req)) {
    return json({ error: "Unauthorized" }, 401);
  }

  // Per-key rate limit (applied after auth so unauthenticated probes
  // don't compete for buckets with legitimate traffic).
  const key = presentedKey(req);
  if (key) {
    const limited = await checkRateLimit(key);
    if (limited) return limited;
  }

  const url = new URL(req.url);
  const path = url.pathname
    .replace(/^\/rest-api/, "")
    .replace(/\/+$/, "") || "/";

  try {
    if (path === "/health" || path === "/healthz" || path === "/") {
      return json({ ok: true, service: "open-brain-rest", timestamp: new Date().toISOString() });
    }

    if (path === "/search" && req.method === "POST") return await handleSearch(req);
    if (path === "/capture" && req.method === "POST") return await handleCapture(req);
    if (path === "/recent" && req.method === "GET") return await handleRecent(url);
    if (path === "/thoughts" && req.method === "GET") return await handleBrowseThoughts(url);
    if (path === "/count" && req.method === "GET") return await handleCount(url);
    if (path === "/stats") return await handleStats(url);

    // /thought/:id routes
    const thoughtMatch = path.match(/^\/thought\/([^/]+)$/);
    if (thoughtMatch) {
      const id = validateId(thoughtMatch[1]);
      if (!id) return json({ error: "Invalid thought ID" }, 400);
      if (req.method === "GET") return await handleGetThought(id, url.searchParams.get("exclude_restricted") !== "false");
      if (req.method === "PUT") return await handleUpdateThought(id, req);
      if (req.method === "DELETE") return await handleDeleteThought(id);
    }

    const connectionsMatch = path.match(/^\/thought\/([^/]+)\/connections$/);
    if (connectionsMatch && req.method === "GET") {
      const connId = validateId(connectionsMatch[1]);
      if (!connId) return json({ error: "Invalid thought ID" }, 400);
      return await handleGetConnections(connId, url);
    }

    const enrichMatch = path.match(/^\/thought\/([^/]+)\/enrich$/);
    if (enrichMatch && req.method === "PATCH") {
      const enrichId = validateId(enrichMatch[1]);
      if (!enrichId) return json({ error: "Invalid thought ID" }, 400);
      return await handleEnrichThought(enrichId, url);
    }

    // Smart ingest proxy routes
    if (path === "/ingest" && req.method === "POST") return await handleIngest(req);
    if (path === "/ingestion-jobs" && req.method === "GET") return await handleListJobs(url);

    const executeMatch = path.match(/^\/ingestion-jobs\/(\d+)\/execute$/);
    if (executeMatch && req.method === "POST") {
      const execJobId = validateId(executeMatch[1]);
      if (!execJobId) return json({ error: "Invalid job ID" }, 400);
      return await handleExecuteJob(execJobId);
    }

    const jobDetailMatch = path.match(/^\/ingestion-jobs\/(\d+)$/);
    if (jobDetailMatch && req.method === "GET") {
      const detailJobId = validateId(jobDetailMatch[1]);
      if (!detailJobId) return json({ error: "Invalid job ID" }, 400);
      return await handleGetJob(detailJobId);
    }

    // Duplicates
    if (path === "/duplicates" && req.method === "GET") return await handleFindDuplicates(url);
    if (path === "/duplicates/resolve" && req.method === "POST") return await handleDuplicateResolve(req);

    // Entity routes (knowledge graph)
    if (path === "/entities" && req.method === "GET") return await handleEntities(url);
    const entityMatch = path.match(/^\/entities\/(\d+)$/);
    if (entityMatch && req.method === "GET") {
      const entId = validateId(entityMatch[1]);
      if (!entId) return json({ error: "Invalid entity ID" }, 400);
      return await handleEntityDetail(entId);
    }

    return json({
      error: "Not found",
      routes: ["/search", "/capture", "/recent", "/thoughts", "/thought/:id", "/thought/:id/connections",
        "/thought/:id/enrich", "/ingest", "/ingestion-jobs", "/ingestion-jobs/:id",
        "/ingestion-jobs/:id/execute", "/count", "/duplicates", "/duplicates/resolve",
        "/stats", "/entities", "/entities/:id", "/health"],
    }, 404);
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: "Invalid JSON in request body" }, 400);
    return internalError(error);
  }
};

/**
 * A 500 that names nothing of the error: PostgREST errors include table, column and constraint names, and under
 * service-role access a constraint error includes data values. Correlate by error_id in the function's logs.
 */
function internalError(error: unknown): Response {
  const errorId = crypto.randomUUID();
  console.error(`rest-api error [${errorId}]`, error);
  return json({ error: "internal_error", code: "GENERIC", error_id: errorId }, 500);
}

/** Every answer carries the request's CORS headers (withCors, SMD-2079): route's, or the 500 for what escaped its try — the preflight, auth, the rate limit and the URL stand before it. */
const handler = async (req: Request): Promise<Response> => withCors(req, await route(req).catch(internalError));

export default {
  port: Number(process.env.PORT || 8000),
  fetch: handler,
};

// ── Search filters ──────────────────────────────────────────────────────────

// ob1-fork (SMD-2054): POST /search hands the database no filter of its own.
// Both functions it calls read that argument as a metadata containment —
// `t.metadata @> filter` in this fork's match_thoughts (db/migrations/014,
// 041's body) and `t.metadata @> coalesce(p_filter, '{}')` in the
// enhanced-thoughts sidecar's search_thoughts_text — so the
// `exclude_restricted: true` text mode folded into p_filter matched no thought
// and every text-mode search answered an empty page with total 0. Semantic
// mode sent `{}` and filtered the rows on `r.sensitivity_tier !== "restricted"`,
// a column match_thoughts does not return (it returns id, content, metadata,
// similarity, created_at and score): undefined !== "restricted" is always
// true, and restricted thoughts' full content came back under the default
// exclude_restricted. The tier is read from the COLUMN — columnsOf below, for
// the ids match_thoughts returned — and the date bounds are instants applied
// to the rows in both modes (text mode read none). The date helpers are
// enhanced-mcp's (SMD-1986): the two servers deploy alone and share only
// _shared/, so the text is copied, and extensions/test-writes.ts holds the two
// copies identical to the character (comments and the row's type aside) and
// drives this route against a restricted twin planted at a captured thought's
// vector.

type ThoughtColumns = { sensitivity_tier: string; type: unknown; source_type: unknown };
/**
 * The enhanced-thoughts columns of each id, one query: `sensitivity_tier`, on
 * which semantic mode drops a restricted row, and `type` and `source_type`,
 * which the semantic projection names — match_thoughts returns none of the
 * three (review pass 1: `row.source_type` was undefined on every semantic
 * result, so the key was missing from the JSON while text mode carried it,
 * and `row.type` was a dead fallback behind metadata.type). The text function
 * returns all three and needs no lookup.
 */
async function columnsOf(ids: string[]): Promise<Map<string, ThoughtColumns>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase.from("thoughts").select("id, sensitivity_tier, type, source_type").in("id", ids);
  if (error) throw new Error(`thoughts column lookup failed: ${error.message}`);
  const rows = (data ?? []) as Record<string, unknown>[];
  return new Map(rows.map((r): [string, ThoughtColumns] => [String(r.id), {
    sensitivity_tier: String(r.sensitivity_tier ?? "standard"), type: r.type ?? null, source_type: r.source_type ?? null,
  }]));
}

/**
 * The caller's date window as instants. A bound is an ISO 8601 date or
 * date-time, held to that shape before it is parsed (`Date.parse` alone would
 * take "Dec 25, 2025"), and read as UTC unless it carries an offset: a
 * date-only value is that day's midnight UTC, a zone-less date-time is UTC
 * too — never the process's zone. Semantic mode compared the strings before:
 * a bound written with a UTC offset sorted against the shim's `Z` rendering
 * by its digits (later digits for an earlier instant), and a bound that did
 * not parse hid every row or was ignored, neither with a word. GET /thoughts
 * and GET /count hand the same string to Postgres, which reads a bare date in
 * the session's time zone and takes shapes this refuses
 * (`yesterday`, an hour-only offset); for a bound both accept, they agree on
 * the instant on a database running in UTC, the container images' default. A
 * bound off the shape, or a window closed before it opens, is a 400 naming the
 * field rather than a comparison.
 */
type DateWindow = { start: number | null; end: number | null };
// An offset carries its minutes (`+02:00`, `+0200`): Bun's Date.parse makes `+02` an Invalid Date.
const ISO_BOUND = /^(?<y>\d{4})-(?<mo>\d{2})-(?<d>\d{2})(?:[T ](?<h>\d{2}):(?<mi>\d{2})(?::(?<s>\d{2})(?:\.\d{1,9})?)?(?<zone>Z|[+-]\d{2}:?\d{2})?)?$/i;
function parseBound(name: string, value: string | null): number | null | { error: string } {
  if (!value) return null;
  const m = ISO_BOUND.exec(value);
  if (!m) return { error: `${name} is not an ISO 8601 date or date-time: ${value}` };
  // The fields in range, as Postgres holds them: Bun's Date.parse rolls `2026-02-30` over to March 2, where
  // Postgres refuses the string — a rolled bound is a silently different day. `24:00`, ISO's end of day, stays.
  const g = m.groups!;
  const [y, mo, d, h, mi, s] = [g.y, g.mo, g.d, g.h ?? "0", g.mi ?? "0", g.s ?? "0"].map(Number);
  const daysIn = new Date(Date.UTC(y, mo, 0)).getUTCDate(); // day 0 of the next month
  const inRange = mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn && mi <= 59 && s <= 60 && (h <= 23 || (h === 24 && mi === 0 && s === 0));
  if (!inRange) return { error: `${name} is not a real date: ${value}` };
  const utc = g.zone || value.length === 10 ? value : `${value}Z`;
  const t = Date.parse(utc.replace(" ", "T"));
  return Number.isNaN(t) ? { error: `${name} is not a real date: ${value}` } : t;
}
function dateWindow(startDate: string | null, endDate: string | null): DateWindow | { error: string } {
  const start = parseBound("start_date", startDate);
  if (typeof start === "object" && start !== null) return start;
  const end = parseBound("end_date", endDate);
  if (typeof end === "object" && end !== null) return end;
  if (start !== null && end !== null && start > end) return { error: `start_date ${startDate} is after end_date ${endDate}` };
  return { start, end };
}

/** Is the row's `created_at` inside the window? A row whose timestamp does not parse is outside any bound. */
function withinDates(row: Record<string, unknown>, w: DateWindow): boolean {
  if (w.start === null && w.end === null) return true;
  const t = Date.parse(String(row.created_at));
  return (w.start === null || t >= w.start) && (w.end === null || t <= w.end);
}

// ── Search ──────────────────────────────────────────────────────────────────

async function handleSearch(req: Request): Promise<Response> {
  const body = await req.json() as Record<string, unknown>;
  const query = String(body.query ?? "").trim();
  const mode = String(body.mode ?? "semantic");
  const limit = Math.min(Math.max(Number(body.limit) || 25, 1), 100);
  const page = Math.max(Number(body.page) || 1, 1);
  const offset = (page - 1) * limit;
  const minSimilarity = Math.min(Math.max(Number(body.min_similarity) || 0.3, 0), 1);
  const excludeRestricted = body.exclude_restricted !== false;
  const startDate = body.start_date ? String(body.start_date).trim() : null;
  const endDate = body.end_date ? String(body.end_date).trim() : null;

  if (query.length < 2) return json({ error: "query must be at least 2 characters" }, 400);
  const window = dateWindow(startDate, endDate);
  if ("error" in window) return json({ error: window.error }, 400);

  if (mode === "text") {
    // p_filter is a metadata containment (the note above columnsOf): none here. The function ranks and pages BEFORE
    // the tier and date filters apply to its page, so `total` and `total_pages` are the function's, hidden rows
    // counted, and `count` is the rows shown — a page the filters emptied is `count: 0` with the pages after it
    // still numbered; the README says so, and SMD-2055 moves the filters into the function.
    const { data, error } = await supabase.rpc("search_thoughts_text", {
      p_query: query, p_limit: limit, p_filter: {}, p_offset: offset,
    });
    if (error) throw new Error(`search failed: ${error.message}`);

    const rows = (data ?? []) as Record<string, unknown>[];
    // total_count rides on every row the function returns (hit_count, non-null); a page past the last hit has none.
    const totalCount = rows.length > 0 ? Number(rows[0].total_count) : 0;
    const results = rows
      .filter((row) => !excludeRestricted || row.sensitivity_tier !== "restricted")
      .filter((row) => withinDates(row, window))
      .map((row) => ({
        id: row.id, content: row.content, type: row.type, source_type: row.source_type,
        importance: row.importance, metadata: row.metadata, created_at: row.created_at, rank: row.rank,
      }));

    return json({ results, count: results.length, total: totalCount, page, per_page: limit,
      total_pages: Math.ceil(totalCount / limit), mode: "text" }, 200);
  }

  // Semantic search (default): match_thoughts returns the top-N by similarity; the tier and the date bounds are
  // applied to the rows here, so over-fetch for headroom (rows ranked below the over-fetch are not seen — the
  // README says when that matters).
  const dateFilterActive = !!(startDate || endDate);
  const fetchCount = (excludeRestricted || dateFilterActive) ? Math.min(limit + (dateFilterActive ? 50 : 20), 200) : limit;
  const { data, error } = await supabase.rpc("match_thoughts", {
    query_embedding: await embedText(query), match_count: fetchCount, match_threshold: minSimilarity, filter: {},
  });
  if (error) throw new Error(`search failed: ${error.message}`);

  const allRows = (data ?? []) as Record<string, unknown>[];
  // The columns by id, one lookup: the tier, on which the filter drops a row — an id the lookup did not return
  // (deleted between the two calls) is treated as restricted, so the filter fails closed; nothing drives that
  // branch, since the lookup reads the table the match just read — and the two the projection names.
  const columns = await columnsOf(allRows.map((r) => String(r.id)));
  const semanticRows = allRows
    .filter((r) => !excludeRestricted || (columns.get(String(r.id))?.sensitivity_tier ?? "restricted") !== "restricted")
    .filter((r) => withinDates(r, window))
    .slice(0, limit);

  const results = semanticRows.map((row) => {
    const own = columns.get(String(row.id));
    return {
      id: row.id, content: row.content, type: (row.metadata as Record<string, unknown>)?.type ?? own?.type ?? null,
      similarity: row.similarity, source_type: own?.source_type ?? null, created_at: row.created_at,
    };
  });

  return json({ results, count: results.length, total: results.length, page: 1, per_page: limit, total_pages: 1, mode: "semantic" }, 200);
}

// ── Capture ─────────────────────────────────────────────────────────────────

async function handleCapture(req: Request): Promise<Response> {
  const body = await req.json() as Record<string, unknown>;
  const content = String(body.content ?? "").trim();
  const source = String(body.source ?? "rest_api").trim();
  const sourceType = String(body.source_type ?? "").trim() || source;

  if (!content) return json({ error: "content is required" }, 400);

  const detectedSensitivity = detectSensitivity(content);
  if (detectedSensitivity.tier === "restricted") {
    return json({ error: "Restricted content cannot be captured through cloud API" }, 403);
  }

  const bodyMetadata = isRecord(body.metadata) ? body.metadata : {};
  const metadataOverrides: Record<string, unknown> = {};
  if (body.type) metadataOverrides.type = body.type;
  if (body.importance !== undefined) metadataOverrides.importance = body.importance;
  if (body.topics) metadataOverrides.topics = body.topics;
  if (body.tags) metadataOverrides.tags = body.tags;
  if (body.quality_score !== undefined) metadataOverrides.quality_score = body.quality_score;

  const prepared = await prepareThoughtPayload(content, {
    source, source_type: sourceType,
    metadata: { ...bodyMetadata, ...metadataOverrides },
    skip_classification: body.skip_classification === true,
  });

  // The 3-argument upsert_thought (db/migrations/004, last redefined by 035):
  // the vector and its label (021) land with the row, the fingerprint with
  // the text, and a re-capture replaces the previous vector's chunk rows
  // (022). The envelope carries what the function reads — `metadata`,
  // `embedding_model` — and the enhanced-thoughts columns follow by a raw
  // update that carries neither content nor vector (the function never read
  // them; upstream's removed schema section did). This used to put the vector
  // inside the payload, where the fork's function does not look, so no
  // capture here stored one.
  const embedding = safeEmbedding(prepared.embedding) ?? null;
  const { data, error } = await supabase.rpc("upsert_thought", {
    p_content: prepared.content,
    p_payload: {
      metadata: prepared.metadata,
      ...(embedding ? { embedding_model: embeddingModelUsed() } : {}),
      actor: ACTOR, // 008's actor, read from the payload into ob1.actor (SMD-1541; ACTOR above)
    },
    p_embedding: embedding,
  });

  if (error) throw new Error(`capture failed: ${error.message}`);
  const result = extractThoughtId(data);
  if (!result) throw new Error("upsert_thought returned no result");

  // For a fresh row only: a re-capture of existing text leaves the enhanced
  // columns as they are — this file's tier rule is escalation-only (see
  // handleUpdateThought), a hand-set importance is the owner's, and the
  // function leaves that row's pointers the same way (db/migrations/035).
  // …and the response reports what the row holds, not what this call detected.
  let held = { type: prepared.type, sensitivity_tier: prepared.sensitivity_tier };
  if (result.action === "inserted") {
    const { error: sidecarErr } = await supabase.from("thoughts").update({
      type: prepared.type, sensitivity_tier: prepared.sensitivity_tier,
      importance: prepared.importance, quality_score: prepared.quality_score,
      source_type: prepared.source_type,
    }).eq("id", result.id);
    if (sidecarErr) throw new Error(`capture stored thought #${result.id} but the enhanced columns failed: ${sidecarErr.message}`);
  } else {
    const { data: kept } = await supabase.from("thoughts").select("type, sensitivity_tier").eq("id", result.id).single();
    if (kept) held = { type: asString(kept.type, prepared.type), sensitivity_tier: asString(kept.sensitivity_tier, prepared.sensitivity_tier) };
  }

  return json({
    thought_id: result.id, action: result.action, type: held.type,
    sensitivity_tier: held.sensitivity_tier, content_fingerprint: result.fingerprint,
    message: `${result.action === "inserted" ? "Captured new" : "Updated"} thought #${result.id} as ${held.type}`,
  });
}

// ── Recent ──────────────────────────────────────────────────────────────────

async function handleRecent(url: URL): Promise<Response> {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
  const source = url.searchParams.get("source")?.trim() || null;
  const type = url.searchParams.get("type")?.trim() || null;
  const topic = url.searchParams.get("topic")?.trim() || null;
  // ob1-fork (SMD-2054, review pass 1): the one route reading thoughts directly with no tier predicate —
  // `GET /recent?limit=100` answered every restricted thought's full content, newest first (GET /duplicates calls
  // find_near_duplicates, defined nowhere on this fork, so it fails rather than answers). exclude_restricted,
  // default true, as its siblings (/thoughts, /count, /thought/:id) take it; the predicate is theirs, `<>` on the
  // column, which also hides a row whose tier is NULL — an explicit write, the column defaults to standard — where
  // the sidecar's functions use IS DISTINCT FROM (review pass 2; the siblings' shape kept, closed either way).
  const excludeRestricted = url.searchParams.get("exclude_restricted") !== "false";

  let query = supabase.from("thoughts")
    .select("id, content, type, source_type, importance, metadata, created_at, updated_at")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (source) query = query.eq("source_type", source);
  if (type) query = query.eq("type", type);
  if (topic) query = query.contains("metadata", { topics: [topic] });
  if (excludeRestricted) query = query.neq("sensitivity_tier", "restricted");

  const { data, error } = await query;
  if (error) throw new Error(`recent query failed: ${error.message}`);
  return json({ results: data ?? [], count: (data ?? []).length, offset, limit, filters: { source, type, topic, exclude_restricted: excludeRestricted } });
}

// ── Get / Update / Delete Thought ───────────────────────────────────────────

async function handleGetThought(id: string, excludeRestricted: boolean): Promise<Response> {
  const { data, error } = await supabase.from("thoughts")
    .select("id, content, type, source_type, importance, quality_score, sensitivity_tier, metadata, created_at, updated_at")
    .eq("id", id).single();
  if (error || !data) return json({ error: `Thought #${id} not found` }, 404);
  if (excludeRestricted && data.sensitivity_tier === "restricted") return json({ error: "restricted" }, 403);
  return json(data);
}

async function handleUpdateThought(id: string, req: Request): Promise<Response> {
  const body = await req.json() as Record<string, unknown>;
  const content = String(body.content ?? "").trim();
  if (!content) return json({ error: "content is required" }, 400);

  const { data: existing, error: fetchErr } = await supabase
    .from("thoughts")
    .select("id, sensitivity_tier, metadata")
    .eq("id", id)
    .single();
  if (fetchErr || !existing) return json({ error: `Thought #${id} not found` }, 404);

  // Re-detect sensitivity on the new content. Use escalation-only
  // semantics (resolveSensitivityTier) so a standard->personal change
  // bumps the tier automatically, while personal->standard can only
  // happen if the caller explicitly requests force_sensitivity — and
  // even then we refuse to downgrade to below what detection returned.
  const detected = detectSensitivity(content);
  const existingTier = asString(existing.sensitivity_tier, "standard") as typeof SENSITIVITY_TIERS[number];
  const force = body.force_sensitivity === true;
  const resolvedTier = force
    ? resolveSensitivityTier(detected.tier)
    : resolveSensitivityTier(detected.tier, existingTier);

  let embedding: number[] | null = null;
  try { embedding = await embedText(content); } catch { /* continue */ }

  // Content, vector and metadata through update_thought (db/migrations/033):
  // the fingerprint follows the text (003/018), the label the vector (021),
  // the previous vector's chunk rows go (022), the patch is shallow-merged.
  // When the embedding call failed, the function sets the vector and its
  // label NULL rather than leaving the old vector under the new text — a
  // stale vector is what a raw update here used to leave, and what 021 calls
  // a raw write's defect; PATCH /thought/:id/enrich?fill=embedding refills it.
  const tierChanged = resolvedTier !== existingTier;
  const { data: edited, error: editErr } = await supabase.rpc("update_thought", {
    p_id: id,
    p_content: content,
    p_metadata_patch: tierChanged ? { sensitivity_reasons: detected.reasons } : null,
    p_embedding: embedding,
    p_embedding_model: embedding ? embeddingModelUsed() : null,
    p_actor: ACTOR, // 008's actor (SMD-1541; ACTOR above)
  });
  if (editErr) throw new Error(`update failed: ${editErr.message}`);
  const edit = (edited ?? {}) as Record<string, unknown>;
  if (edit.ok !== true) {
    const reason = String(edit.error ?? "unknown");
    return json({ error: `update_thought refused: ${reason}` }, reason === "NOT_FOUND" ? 404 : 409);
  }

  // The enhanced-thoughts columns the function does not know: a raw update
  // that carries neither content nor vector, so nothing it writes goes stale.
  const updates: Record<string, unknown> = {};
  if (body.type) updates.type = sanitizeType(String(body.type));
  if (body.importance !== undefined) {
    const rawImp = Number(body.importance);
    updates.importance = Math.min(Math.max(Number.isFinite(rawImp) ? rawImp : 3, 0), 6);
  }
  if (tierChanged) updates.sensitivity_tier = resolvedTier;
  if (Object.keys(updates).length > 0) {
    const { error: updateErr } = await supabase.from("thoughts").update(updates).eq("id", id);
    if (updateErr) throw new Error(`update failed: ${updateErr.message}`);
  }
  // Say so when the row was left without a vector: a 200 that silently
  // removed the thought from semantic search is the failure mode the first
  // review pass named.
  const embedded = embedding !== null;
  return json({
    id,
    action: "updated",
    sensitivity_tier: resolvedTier,
    sensitivity_tier_changed: tierChanged,
    embedding_updated: embedded,
    message: (tierChanged
      ? `Thought #${id} updated (sensitivity ${existingTier} -> ${resolvedTier})`
      : `Thought #${id} updated`) +
      (embedded ? "" : " — the embedding call failed, so the thought has no vector until PATCH /thought/:id/enrich?fill=embedding"),
  });
}

async function handleDeleteThought(id: string): Promise<Response> {
  const { data: existing, error: fetchErr } = await supabase.from("thoughts").select("id").eq("id", id).single();
  if (fetchErr || !existing) return json({ error: `Thought #${id} not found` }, 404);
  const { error: deleteErr } = await supabase.from("thoughts").delete().eq("id", id);
  if (deleteErr) throw new Error(`delete failed: ${deleteErr.message}`);
  return json({ id, action: "deleted", message: `Thought #${id} deleted` });
}

// ── Stats ───────────────────────────────────────────────────────────────────

async function handleStats(url: URL): Promise<Response> {
  const daysParam = url.searchParams.get("days");
  const excludeRestricted = url.searchParams.get("exclude_restricted") !== "false";
  const allTime = !daysParam;
  const sinceDays = allTime ? 0 : Math.max(Number(daysParam) || 30, 1);
  const since = allTime ? null : new Date(Date.now() - (sinceDays * 86_400_000)).toISOString();

  let countQuery = supabase.from("thoughts").select("id", { count: "exact", head: true });
  if (since) countQuery = countQuery.gte("created_at", since);
  if (excludeRestricted) countQuery = countQuery.neq("sensitivity_tier", "restricted");

  const [{ count: totalThoughts, error: countErr }, { data: aggregateData, error: aggregateErr }] =
    await Promise.all([
      countQuery,
      supabase.rpc("brain_stats_aggregate", { p_since_days: sinceDays, p_exclude_restricted: excludeRestricted }),
    ]);

  if (countErr) throw new Error(`stats count failed: ${countErr.message}`);
  if (aggregateErr) throw new Error(`stats aggregate failed: ${aggregateErr.message}`);

  const aggregate = isRecord(aggregateData) ? aggregateData : {};
  const typeCounts = Object.fromEntries(parseAggregateCounts(aggregate.top_types, "type").map(({ key, count }) => [key, count]));
  const topTopics = parseAggregateCounts(aggregate.top_topics, "topic").slice(0, 15).map(({ key, count }) => ({ topic: key, count }));

  return json({ total_thoughts: totalThoughts ?? 0, window_days: allTime ? "all" : sinceDays, types: typeCounts, top_topics: topTopics });
}

// ── Browse Thoughts ─────────────────────────────────────────────────────────

/** Columns that are safe to expose as sort keys on /thoughts. */
const ALLOWED_BROWSE_SORT = new Set([
  "id",
  "created_at",
  "updated_at",
  "importance",
  "quality_score",
]);

async function handleBrowseThoughts(url: URL): Promise<Response> {
  const page = Math.max(Number(url.searchParams.get("page")) || 1, 1);
  const perPage = Math.min(Math.max(Number(url.searchParams.get("per_page") || url.searchParams.get("limit")) || 20, 1), 100);
  const type = url.searchParams.get("type")?.trim() || null;
  const sourceType = url.searchParams.get("source_type")?.trim() || null;
  const importanceMin = url.searchParams.get("importance_min") ? Number(url.searchParams.get("importance_min")) : null;
  const startDate = url.searchParams.get("start_date")?.trim() || null;
  const endDate = url.searchParams.get("end_date")?.trim() || null;
  const rawSort = url.searchParams.get("sort");
  if (rawSort && !ALLOWED_BROWSE_SORT.has(rawSort)) {
    return json({
      error: "invalid_sort",
      message: `sort must be one of: ${[...ALLOWED_BROWSE_SORT].join(", ")}`,
    }, 400);
  }
  const sort = rawSort ?? "created_at";
  const order = url.searchParams.get("order") === "asc";
  const excludeRestricted = url.searchParams.get("exclude_restricted") !== "false";
  const offset = (page - 1) * perPage;

  let countQuery = supabase.from("thoughts").select("id", { count: "exact", head: true });
  let dataQuery = supabase.from("thoughts")
    .select("id, content, type, source_type, importance, quality_score, sensitivity_tier, metadata, created_at, updated_at")
    .order(sort as string, { ascending: order })
    .range(offset, offset + perPage - 1);

  // Apply filters to both queries
  for (const q of [countQuery, dataQuery]) {
    if (type) q.eq("type", type);
    if (sourceType) q.eq("source_type", sourceType);
    if (importanceMin !== null) q.gte("importance", importanceMin);
    if (startDate) q.gte("created_at", startDate);
    if (endDate) q.lte("created_at", endDate);
    if (excludeRestricted) q.neq("sensitivity_tier", "restricted");
  }

  const [countRes, dataRes] = await Promise.all([countQuery, dataQuery]);
  if (dataRes.error) throw new Error(`browse failed: ${dataRes.error.message}`);
  return json({ data: dataRes.data ?? [], total: countRes.count ?? 0, page, per_page: perPage });
}

// ── Count ───────────────────────────────────────────────────────────────────

async function handleCount(url: URL): Promise<Response> {
  const type = url.searchParams.get("type")?.trim() || null;
  const sourceType = url.searchParams.get("source_type")?.trim() || null;
  const startDate = url.searchParams.get("start_date")?.trim() || null;
  const endDate = url.searchParams.get("end_date")?.trim() || null;
  const excludeRestricted = url.searchParams.get("exclude_restricted") !== "false";

  let query = supabase.from("thoughts").select("id", { count: "exact", head: true });
  if (type) query = query.eq("type", type);
  if (sourceType) query = query.eq("source_type", sourceType);
  if (startDate) query = query.gte("created_at", startDate);
  if (endDate) query = query.lte("created_at", endDate);
  if (excludeRestricted) query = query.neq("sensitivity_tier", "restricted");

  const { count, error } = await query;
  if (error) throw new Error(`count query failed: ${error.message}`);

  const filters: Record<string, string> = {};
  if (type) filters.type = type;
  if (sourceType) filters.source_type = sourceType;
  if (startDate) filters.start_date = startDate;
  if (endDate) filters.end_date = endDate;

  return json({ count: count ?? 0, filters });
}

// ── Connections ──────────────────────────────────────────────────────────────

async function handleGetConnections(thoughtId: string, url: URL): Promise<Response> {
  const excludeRestricted = url.searchParams.get("exclude_restricted") !== "false";
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 50);

  const { data, error } = await supabase.rpc("get_thought_connections", {
    p_thought_id: thoughtId, p_limit: limit, p_exclude_restricted: excludeRestricted,
  });

  if (error) {
    console.error("get_thought_connections RPC error:", error);
    return json({ connections: [] });
  }

  const connections = (data ?? []).map((row: Record<string, unknown>) => ({
    id: row.id, type: row.type, importance: row.importance, preview: row.preview,
    created_at: row.created_at, shared_topics: row.shared_topics ?? [],
    shared_people: row.shared_people ?? [], overlap_count: row.overlap_count ?? 0,
  }));

  return json({ connections });
}

// ── Enrich Thought ──────────────────────────────────────────────────────────

const VALID_FILLS = new Set(["embedding", "classification", "sensitivity", "all"]);

async function handleEnrichThought(thoughtId: string, url: URL): Promise<Response> {
  const fill = url.searchParams.get("fill") || "all";
  const excludeRestricted = url.searchParams.get("exclude_restricted") !== "false";

  if (!VALID_FILLS.has(fill)) {
    return json({ error: `Invalid fill parameter: "${fill}". Must be one of: embedding, classification, sensitivity, all` }, 400);
  }

  const { data: existing, error: fetchErr } = await supabase
    .from("thoughts").select("*").eq("id", thoughtId).single();
  if (fetchErr || !existing) return json({ error: `Thought #${thoughtId} not found` }, 404);
  if (excludeRestricted && existing.sensitivity_tier === "restricted") return json({ error: "restricted" }, 403);

  const content = String(existing.content ?? "");
  const existingMetadata: Record<string, unknown> = isRecord(existing.metadata) ? { ...existing.metadata as Record<string, unknown> } : {};
  const enriched: Record<string, unknown> = {};
  const fills: string[] = [];

  if (fill === "embedding" || fill === "all") {
    try {
      enriched.embedding = await embedText(content);
      fills.push("embedding");
    } catch (err) {
      console.warn(`Embedding failed for thought #${thoughtId}:`, err);
      enriched.embedding_error = String(err);
    }
  }

  if (fill === "classification" || fill === "all") {
    try {
      const extracted = await extractMetadata(content);
      existingMetadata.topics = mergeUniqueStrings(existingMetadata.topics, normalizeStringArray(extracted.topics));
      existingMetadata.tags = mergeUniqueStrings(existingMetadata.tags, normalizeStringArray(extracted.tags));
      existingMetadata.people = mergeUniqueStrings(existingMetadata.people, normalizeStringArray(extracted.people));
      existingMetadata.action_items = mergeUniqueStrings(existingMetadata.action_items, normalizeStringArray(extracted.action_items));

      const currentType = asString(existing.type, "");
      if (!currentType || currentType === "reference") {
        enriched.type = extracted.type;
        existingMetadata.type = extracted.type;
      }
      if (!asString(existingMetadata.summary, "")) existingMetadata.summary = extracted.summary;
      existingMetadata.confidence = extracted.confidence;
      existingMetadata.enrichment_attempted_at = new Date().toISOString();
      fills.push("classification");
    } catch (err) {
      console.warn(`Classification failed for thought #${thoughtId}:`, err);
      enriched.classification_error = String(err);
    }
  }

  if (fill === "sensitivity" || fill === "all") {
    const detected = detectSensitivity(content);
    const currentTier = asString(existing.sensitivity_tier, "standard") as typeof SENSITIVITY_TIERS[number];
    const newTier = resolveSensitivityTier(detected.tier, currentTier);
    if (SENSITIVITY_TIERS.indexOf(newTier) > SENSITIVITY_TIERS.indexOf(currentTier)) {
      enriched.sensitivity_tier = newTier;
      existingMetadata.sensitivity_reasons = detected.reasons;
    }
    fills.push("sensitivity");
  }

  existingMetadata.last_enriched_at = new Date().toISOString();
  existingMetadata.enrichment_fills = fills;

  // Metadata, and the new vector when one was made, through update_thought
  // (db/migrations/033). A vector arrives only with content, so the row's own
  // text is passed back: an unchanged edit, which 018 never refuses, that sets
  // the vector and its label (021) and replaces the chunk rows (022) — the
  // windows of the previous vector go, which the fill is for. Without a new
  // vector the call is metadata-only and touches neither. A raw update of
  // `embedding` here left the label describing the previous vector and the
  // previous vector's windows in place.
  const { data: edited, error: editErr } = await supabase.rpc("update_thought", {
    p_id: thoughtId,
    p_content: enriched.embedding ? content : null,
    p_metadata_patch: existingMetadata,
    p_embedding: enriched.embedding ?? null,
    p_embedding_model: enriched.embedding ? embeddingModelUsed() : null,
    p_actor: ACTOR, // 008's actor (SMD-1541; ACTOR above)
  });
  if (editErr) throw new Error(`enrich update failed: ${editErr.message}`);
  const edit = (edited ?? {}) as Record<string, unknown>;
  if (edit.ok !== true) throw new Error(`enrich update failed: update_thought refused (${String(edit.error ?? "unknown")})`);

  // The enhanced-thoughts columns the function does not know: a raw update
  // that carries neither content nor vector, so nothing it writes goes stale.
  const columnUpdates: Record<string, unknown> = {};
  if (enriched.type) columnUpdates.type = enriched.type;
  if (enriched.sensitivity_tier) columnUpdates.sensitivity_tier = enriched.sensitivity_tier;
  if (Object.keys(columnUpdates).length > 0) {
    const { error: updateErr } = await supabase.from("thoughts").update(columnUpdates).eq("id", thoughtId);
    if (updateErr) throw new Error(`enrich update failed: ${updateErr.message}`);
  }

  const { data: updated } = await supabase.from("thoughts")
    .select("id, content, type, source_type, importance, quality_score, sensitivity_tier, metadata, created_at, updated_at")
    .eq("id", thoughtId).single();

  return json({ ...(updated ?? { id: thoughtId }), action: "enriched", fills, message: `Thought #${thoughtId} enriched (${fills.join(", ")})` });
}

// ── Smart Ingest Proxy ──────────────────────────────────────────────────────

const PROXY_BODY_MAX_BYTES = 1_000_000; // 1 MB
const PROXY_TIMEOUT_MS = 60_000;

/**
 * Read an incoming request body safely: enforce a 1 MB cap before
 * JSON-parsing. Returns either a parsed record or a Response to return
 * to the caller (413 over-size, or 400 malformed JSON).
 */
async function readJsonWithCap(
  req: Request,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; resp: Response }> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > PROXY_BODY_MAX_BYTES) {
    return { ok: false, resp: json({ error: "payload_too_large", max_bytes: PROXY_BODY_MAX_BYTES }, 413) };
  }
  const text = await req.text();
  if (text.length > PROXY_BODY_MAX_BYTES) {
    return { ok: false, resp: json({ error: "payload_too_large", max_bytes: PROXY_BODY_MAX_BYTES }, 413) };
  }
  if (!text.trim()) return { ok: true, body: {} };
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) {
      return { ok: false, resp: json({ error: "Body must be a JSON object" }, 400) };
    }
    return { ok: true, body: parsed };
  } catch {
    return { ok: false, resp: json({ error: "Invalid JSON in request body" }, 400) };
  }
}

/**
 * Proxy an upstream POST with a bounded timeout and defensive response
 * handling. Differentiates between upstream timeout (504), upstream
 * unreachable (502), upstream-returned-non-JSON (surfaces raw text plus
 * upstream status), and upstream-returned-JSON (forwards verbatim).
 */
async function proxyFetchJson(
  url: string,
  body: unknown,
  timeoutMs = PROXY_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-brain-key": MCP_ACCESS_KEY },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await upstream.text();
    const contentType = upstream.headers.get("content-type") ?? "";
    if (contentType.includes("application/json") && text.trim()) {
      try {
        return json(JSON.parse(text), upstream.status);
      } catch {
        return json(
          { error: "upstream_invalid_json", upstream_status: upstream.status, raw: text.slice(0, 2000) },
          502,
        );
      }
    }
    // Non-JSON upstream response (HTML error page, empty 502, text/plain, etc.)
    return json(
      {
        error: upstream.ok ? "upstream_empty" : "upstream_error",
        upstream_status: upstream.status,
        raw: text.slice(0, 2000),
      },
      upstream.ok ? 502 : upstream.status,
    );
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return json({ error: "upstream_timeout", timeout_ms: timeoutMs }, 504);
    }
    return json({ error: "upstream_unreachable" }, 502);
  } finally {
    clearTimeout(timer);
  }
}

/** The two proxy routes' answer with no upstream configured: a 503 naming the variable, not a 502 from a dead fetch. */
function smartIngestNotConfigured(): Response {
  return json({
    error: "smart_ingest_not_configured",
    variable: "SMART_INGEST_URL",
    hint: "Set SMART_INGEST_URL to the smart-ingest server's http(s) address (integrations/smart-ingest) and restart.",
  }, 503);
}

async function handleIngest(req: Request): Promise<Response> {
  if (!SMART_INGEST_URL) return smartIngestNotConfigured();
  const read = await readJsonWithCap(req);
  if (!read.ok) return read.resp;
  const body = read.body;
  if (body.auto_execute) { body.dry_run = false; delete body.auto_execute; }
  return await proxyFetchJson(SMART_INGEST_URL, body);
}

async function handleExecuteJob(jobId: string): Promise<Response> {
  if (!SMART_INGEST_URL) return smartIngestNotConfigured();
  return await proxyFetchJson(`${SMART_INGEST_URL}/execute`, { job_id: jobId });
}

async function handleListJobs(url: URL): Promise<Response> {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
  const status = url.searchParams.get("status")?.trim() || null;
  let query = supabase.from("ingestion_jobs")
    .select("id, source_label, status, extracted_count, added_count, skipped_count, appended_count, revised_count, created_at, completed_at")
    .order("created_at", { ascending: false }).limit(limit);
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) throw new Error(`list_ingestion_jobs failed: ${error.message}`);
  return json({ jobs: data ?? [], count: (data ?? []).length });
}

async function handleGetJob(jobId: string): Promise<Response> {
  const [jobRes, itemsRes] = await Promise.all([
    supabase.from("ingestion_jobs").select("*").eq("id", jobId).single(),
    supabase.from("ingestion_items").select("*").eq("job_id", jobId).order("id"),
  ]);
  if (jobRes.error || !jobRes.data) return json({ error: `Job #${jobId} not found` }, 404);
  return json({ job: jobRes.data, items: itemsRes.data ?? [] });
}

// ── Duplicates ──────────────────────────────────────────────────────────────

async function handleFindDuplicates(url: URL): Promise<Response> {
  const threshold = Math.min(Math.max(Number(url.searchParams.get("threshold")) || 0.85, 0.5), 0.99);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  const { data, error } = await supabase.rpc("find_near_duplicates", { p_threshold: threshold, p_limit: limit, p_offset: offset });
  if (error) throw new Error(`find_near_duplicates failed: ${error.message}`);
  return json({ pairs: data ?? [], threshold, limit, offset });
}

async function handleDuplicateResolve(req: Request): Promise<Response> {
  const body = await req.json() as Record<string, unknown>;
  const thoughtIdA = body.thought_id_a != null ? String(body.thought_id_a) : "";
  const thoughtIdB = body.thought_id_b != null ? String(body.thought_id_b) : "";
  const action = String(body.action ?? "");

  if (!validateId(thoughtIdA) || !validateId(thoughtIdB)) return json({ error: "Both thought_id_a and thought_id_b are required and must be valid integer IDs" }, 400);
  if (!["keep_a", "keep_b", "keep_both"].includes(action)) return json({ error: "action must be keep_a, keep_b, or keep_both" }, 400);
  if (action === "keep_both") return json({ action, survivor_id: null, loser_id: null, reattached: { thought_entities: 0 } });

  const survivorId = action === "keep_a" ? thoughtIdA : thoughtIdB;
  const loserId = action === "keep_a" ? thoughtIdB : thoughtIdA;

  const [{ data: survivor, error: sErr }, { data: loser, error: lErr }] = await Promise.all([
    supabase.from("thoughts").select("id, metadata").eq("id", survivorId).single(),
    supabase.from("thoughts").select("id, metadata").eq("id", loserId).single(),
  ]);
  if (sErr || !survivor) return json({ error: `Survivor thought #${survivorId} not found` }, 404);
  if (lErr || !loser) return json({ error: `Loser thought #${loserId} not found` }, 404);

  // Reattach thought_entities
  let entitiesReattached = 0;
  const { data: loserEntities } = await supabase.from("thought_entities").select("thought_id, entity_id, mention_role").eq("thought_id", loserId);
  if (loserEntities) {
    for (const te of loserEntities) {
      const { error } = await supabase.from("thought_entities")
        .update({ thought_id: survivorId }).eq("thought_id", loserId).eq("entity_id", te.entity_id).eq("mention_role", te.mention_role);
      if (!error) entitiesReattached++;
    }
  }

  // Merge metadata arrays
  const survivorMeta = (isRecord(survivor.metadata) ? survivor.metadata : {}) as Record<string, unknown>;
  const loserMeta = (isRecord(loser.metadata) ? loser.metadata : {}) as Record<string, unknown>;
  const updatedMeta = {
    ...survivorMeta,
    tags: mergeUniqueStrings(normalizeStringArray(survivorMeta.tags), normalizeStringArray(loserMeta.tags)),
    topics: mergeUniqueStrings(normalizeStringArray(survivorMeta.topics), normalizeStringArray(loserMeta.topics)),
    people: mergeUniqueStrings(normalizeStringArray(survivorMeta.people), normalizeStringArray(loserMeta.people)),
  };

  await supabase.from("thoughts").update({ metadata: updatedMeta }).eq("id", survivorId);

  // Log to consolidation_log (best-effort)
  await supabase.from("consolidation_log").insert({
    operation: "dedup_merge", survivor_id: survivorId, loser_id: loserId,
    details: { action, entities_reattached: entitiesReattached },
  }).then(() => {}, () => {});

  // Delete loser
  const { error: deleteErr } = await supabase.from("thoughts").delete().eq("id", loserId);
  if (deleteErr) throw new Error(`delete failed: ${deleteErr.message}`);

  return json({ action, survivor_id: survivorId, loser_id: loserId, reattached: { thought_entities: entitiesReattached } });
}

// ── Entities (Knowledge Graph) ──────────────────────────────────────────────

async function handleEntities(url: URL): Promise<Response> {
  const searchQuery = url.searchParams.get("q")?.trim() || null;
  const entityType = url.searchParams.get("type")?.trim() || null;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 50);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  let q = supabase.from("entities")
    .select("id, entity_type, canonical_name, aliases, metadata, first_seen_at, last_seen_at", { count: "exact" })
    .order("last_seen_at", { ascending: false }).range(offset, offset + limit - 1);
  if (searchQuery) q = q.ilike("canonical_name", `%${searchQuery}%`);
  if (entityType) q = q.eq("entity_type", entityType);

  const { data: entities, count, error } = await q;
  if (error) throw new Error(`entities query failed: ${error.message}`);
  if (!entities || entities.length === 0) return json({ results: [], total: count ?? 0, limit, offset });

  const entityIds = entities.map((e: Record<string, unknown>) => e.id as number);
  const { data: countRows } = await supabase.from("thought_entities").select("entity_id").in("entity_id", entityIds);

  const countMap = new Map<number, number>();
  if (countRows) {
    for (const row of countRows) {
      const eid = (row as Record<string, unknown>).entity_id as number;
      countMap.set(eid, (countMap.get(eid) ?? 0) + 1);
    }
  }

  const results = entities.map((e: Record<string, unknown>) => ({ ...e, thought_count: countMap.get(e.id as number) ?? 0 }));
  return json({ results, total: count ?? 0, limit, offset });
}

async function handleEntityDetail(entityId: string): Promise<Response> {
  const { data: entity, error: entityError } = await supabase.from("entities").select("*").eq("id", entityId).maybeSingle();
  if (entityError) throw new Error(`entity fetch failed: ${entityError.message}`);
  if (!entity) return json({ error: "Entity not found" }, 404);

  // Fetch linked thoughts
  const { data: thoughtLinks } = await supabase.from("thought_entities")
    .select("thought_id, mention_role, confidence").eq("entity_id", entityId).limit(100);

  let thoughts: Record<string, unknown>[] = [];
  if (thoughtLinks && thoughtLinks.length > 0) {
    const thoughtIds = (thoughtLinks as Record<string, unknown>[]).map((tl) => tl.thought_id as number);
    const { data: thoughtRows } = await supabase.from("thoughts")
      .select("id, content, type, created_at, sensitivity_tier").in("id", thoughtIds)
      .neq("sensitivity_tier", "restricted").order("created_at", { ascending: false }).limit(20);

    if (thoughtRows) {
      const roleMap = new Map<number, string>();
      for (const tl of thoughtLinks as Record<string, unknown>[]) roleMap.set(tl.thought_id as number, tl.mention_role as string);
      thoughts = (thoughtRows as Record<string, unknown>[]).map((t) => ({
        id: t.id, content: (t.content as string)?.length > 500 ? (t.content as string).slice(0, 500) + "..." : t.content,
        type: t.type, created_at: t.created_at, mention_role: roleMap.get(t.id as number) ?? "mentioned",
      }));
    }
  }

  // Fetch edges (both directions)
  const [{ data: edgesFrom }, { data: edgesTo }] = await Promise.all([
    supabase.from("edges").select("id, to_entity_id, relation, support_count, confidence").eq("from_entity_id", entityId),
    supabase.from("edges").select("id, from_entity_id, relation, support_count, confidence").eq("to_entity_id", entityId),
  ]);

  // Resolve connected entity names
  const connectedIds = new Set<number>();
  for (const e of (edgesFrom ?? []) as Record<string, unknown>[]) connectedIds.add(e.to_entity_id as number);
  for (const e of (edgesTo ?? []) as Record<string, unknown>[]) connectedIds.add(e.from_entity_id as number);

  const nameMap = new Map<number, { name: string; type: string }>();
  if (connectedIds.size > 0) {
    const { data: connEntities } = await supabase.from("entities").select("id, canonical_name, entity_type").in("id", Array.from(connectedIds));
    if (connEntities) {
      for (const ce of connEntities as Record<string, unknown>[]) nameMap.set(ce.id as number, { name: ce.canonical_name as string, type: ce.entity_type as string });
    }
  }

  const edges = [
    ...((edgesFrom ?? []) as Record<string, unknown>[]).map((e) => ({
      edge_id: e.id, direction: "outgoing", relation: e.relation, other_entity_id: e.to_entity_id,
      other_entity_name: nameMap.get(e.to_entity_id as number)?.name ?? "unknown",
      other_entity_type: nameMap.get(e.to_entity_id as number)?.type ?? "unknown",
      support_count: e.support_count, confidence: e.confidence,
    })),
    ...((edgesTo ?? []) as Record<string, unknown>[]).map((e) => ({
      edge_id: e.id, direction: "incoming", relation: e.relation, other_entity_id: e.from_entity_id,
      other_entity_name: nameMap.get(e.from_entity_id as number)?.name ?? "unknown",
      other_entity_type: nameMap.get(e.from_entity_id as number)?.type ?? "unknown",
      support_count: e.support_count, confidence: e.confidence,
    })),
  ];

  return json({ entity, thoughts, edges });
}
