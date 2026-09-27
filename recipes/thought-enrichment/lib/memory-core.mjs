/**
 * Core hashing, text normalization, and fetch utilities for Open Brain.
 */

import crypto from "node:crypto";

export function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function canonicalizeText(value) {
  return normalizeWhitespace(value).toLowerCase();
}

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

export function buildContentFingerprint(text) {
  return sha256Hex(canonicalizeText(text));
}

/**
 * Default fetch timeout (ms) of an LLM call; FETCH_TIMEOUT_MS overrides it.
 * 60s because providers can legitimately stream for tens of seconds. The
 * brain's reads and writes go through compat/supabase-sql (lib/brain.mjs,
 * SMD-2139) and carry no fetch timeout: a Postgres query is not a stalled
 * HTTP body.
 */
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;

/**
 * Wrap fetch with an AbortController-based timeout. Node 18+'s undici
 * has a 300s headers timeout and no body-read timeout, so without this
 * a stalled upstream can hang a worker indefinitely.
 */
export async function fetchWithTimeout(url, opts = {}, timeoutMs = DEFAULT_LLM_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => {
    ctrl.abort(new Error(`Timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Resolve a timeout value from the FETCH_TIMEOUT_MS env var, falling
 * back to the provided default. Returns a positive integer.
 */
export function resolveTimeoutMs(envValue, fallback) {
  const n = parseInt(envValue, 10);
  if (Number.isFinite(n) && n > 0) return n;
  return fallback;
}
