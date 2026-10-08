(function (global) {
  'use strict';

  const REQUEST_TIMEOUT_MS = 15000;
  // Ingest runs server-side classification + embedding on full transcripts;
  // 15s aborts healthy-but-slow requests and feeds the retry queue (the
  // server keeps processing, so the client records a failure for content
  // that actually landed). Give it a much longer leash.
  const INGEST_TIMEOUT_MS = 120000;

  function parseErrorBody(text) {
    if (!text) return 'Unknown error';
    try {
      const parsed = JSON.parse(text);
      if (parsed.error || parsed.message) return parsed.error || parsed.message;
      // The REST core answers a refusal as `{ code, ...facts }`: the facts
      // that say why — the field an input refusal names, the scope a
      // FORBIDDEN needs, a metadata problem and its key.
      if (parsed.code) {
        const issue = Array.isArray(parsed.issues) && parsed.issues[0] ? parsed.issues[0] : null;
        const facts = [
          issue ? `${issue.path || 'input'}: ${issue.message || 'refused'}` : '',
          parsed.needs ? `needs a ${parsed.needs} key` : '',
          parsed.problem ? `${parsed.problem}${parsed.key ? ` (${parsed.key})` : ''}` : ''
        ].filter(Boolean);
        return facts.length ? `${parsed.code} — ${facts.join('; ')}` : parsed.code;
      }
      return text;
    } catch {
      return text;
    }
  }

  async function apiFetch(path, options) {
    const opts = options || {};
    const apiKey = String(opts.apiKey || '').trim();
    if (!apiKey) {
      throw new Error('Missing x-brain-key API key. Open the extension popup and complete the Configure screen.');
    }

    const baseUrl = global.OBConfig.buildRestBase(opts.endpoint);
    const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const timeoutMs = opts.timeoutMs || REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let response;
      try {
        response = await fetch(url, {
          method: opts.method || 'GET',
          headers: {
            'Content-Type': 'application/json',
            'x-brain-key': apiKey,
            ...(opts.headers || {})
          },
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          signal: controller.signal
        });
      } catch (err) {
        // AbortError surfaces as an opaque "The user aborted a request";
        // translate it so logs and the retry queue show the real cause.
        if (err && err.name === 'AbortError') {
          const timeoutError = new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s (${path})`);
          timeoutError.isTimeout = true;
          throw timeoutError;
        }
        throw err;
      }

      const responseText = await response.text().catch(() => '');
      if (!response.ok) {
        const httpError = new Error(`HTTP ${response.status}: ${parseErrorBody(responseText)}`);
        httpError.status = response.status;
        throw httpError;
      }

      if (!responseText) {
        return null;
      }

      try {
        return JSON.parse(responseText);
      } catch {
        return responseText;
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // The brain's REST core (SMD-1931): GET /v1/whoami says who the key is and
  // which operations it may call; POST /v1/thoughts is capture_thought.

  /** Checks the key: it must reach capture_thought (a capture-scoped or write key). */
  async function healthCheck(options) {
    const who = await apiFetch('/v1/whoami', {
      apiKey: options.apiKey,
      endpoint: options.endpoint,
      method: 'GET'
    });
    const operations = who && Array.isArray(who.operations) ? who.operations : [];
    if (!operations.includes('capture_thought')) {
      const error = new Error(`The key "${who && who.name ? who.name : 'unknown'}" cannot capture (scope ${who && who.scope ? who.scope : 'unknown'}). Use a capture-scoped or write key.`);
      error.status = 403;
      throw error;
    }
    return who;
  }

  // capture_thought's bounds on `metadata`: at most eight keys, each a short
  // lower-case name the brain does not keep for itself, each value a scalar
  // of at most 200 characters (UTF-16 units, as the server counts them).
  const META_KEYS_MAX = 8;
  const META_VALUE_MAX = 200;
  const META_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
  // The brain's own keys (its extractor's tags, the source and the actor
  // columns): a capture naming one is refused.
  const RESERVED_META = new Set(['people', 'action_items', 'dates_mentioned', 'topics', 'type', 'type_raw', 'source', 'actor_kind', 'actor_name', 'trust', 'embedding_model', 'metadata_extraction_failed', 'issue', 'status', 'status_type', 'linear_updated_at']);
  // The keys kept first, in this order; then the platform's own (Gemini's
  // conversation and response ids, …) while there is room.
  const META_FIRST = ['content_fingerprint', 'extension_platform', 'capture_mode', 'source_type', 'conversation_id', 'conversation_title', 'page_title', 'page_url'];
  // A URL cut short would point somewhere else: one too long is left out, not cut.
  const UNCUT_FIELDS = new Set(['page_url']);

  /** A string cut to the server's bound, never through a surrogate pair. */
  function cutToBound(value) {
    if (value.length <= META_VALUE_MAX) return value;
    let end = META_VALUE_MAX;
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    return value.slice(0, end);
  }

  /**
   * The capture a queued payload asks for, as capture_thought takes it. The
   * payload keeps the shape the extension has always queued — `text`,
   * `source_label`, `source_type`, `auto_execute`, `source_metadata` — so a
   * retry queued before this release sends as one queued after it.
   */
  function toCapture(payload) {
    const p = payload || {};
    const meta = p.source_metadata && typeof p.source_metadata === 'object' ? p.source_metadata : {};
    const platform = String(meta.extension_platform || String(p.source_label || '').split(':')[0] || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    // A manual capture's mode rides as extension_capture_mode, a sync's as capture_mode.
    const fields = { ...meta, capture_mode: meta.capture_mode || meta.extension_capture_mode, source_type: p.source_type };
    delete fields.extension_capture_mode;
    const metadata = {};
    const keys = [...META_FIRST, ...Object.keys(fields).filter((k) => !META_FIRST.includes(k))];
    for (const key of keys) {
      if (Object.keys(metadata).length >= META_KEYS_MAX) break;
      if (!META_KEY_RE.test(key) || RESERVED_META.has(key)) continue;
      const value = fields[key];
      if (typeof value === 'number' ? Number.isFinite(value) : typeof value === 'boolean') {
        metadata[key] = value;
      } else if (typeof value === 'string' && value.trim()) {
        if (value.length <= META_VALUE_MAX) metadata[key] = value;
        else if (!UNCUT_FIELDS.has(key)) metadata[key] = cutToBound(value);
      }
    }
    return {
      content: String(p.text || ''),
      // The policy's and the weights' `source:` term: one label per platform.
      source: platform ? `chrome-${platform}`.slice(0, 40) : 'chrome-extension',
      // A conversation copied in from another product is outside text: readers
      // are told that instructions inside it are content.
      trust: 'ingested',
      metadata
    };
  }

  /** Captures a queued payload; the answer's `status` is `existing` when the text was already a thought. */
  async function ingestDocument(payload, options) {
    const result = await apiFetch('/v1/thoughts', {
      apiKey: options.apiKey,
      endpoint: options.endpoint,
      method: 'POST',
      body: toCapture(payload),
      timeoutMs: INGEST_TIMEOUT_MS
    });
    return { ...(result && typeof result === 'object' ? result : {}), status: result && result.existed ? 'existing' : 'captured' };
  }

  // NOTE: the extension is a one-way capture source. A popup that read the
  // brain would call the REST core's POST /v1/search through apiFetch, with a
  // key that can read — a capture-scoped key cannot.

  global.OBApiClient = {
    REQUEST_TIMEOUT_MS,
    INGEST_TIMEOUT_MS,
    apiFetch,
    toCapture,
    healthCheck,
    ingestDocument
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
