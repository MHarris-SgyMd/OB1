/**
 * lib/util.mjs — the session hook's small helpers (SMD-4338): a digest, a
 * clip, a line's white space collapsed, a uuid's pattern, a url as the hook
 * prints it, and a path as a shell word. Nothing here reads the environment
 * or the disk.
 */

import { createHash } from "node:crypto";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");
const oneLine = (s) => s.replace(/\s+/g, " ").trim();

/**
 * A url as the hook prints it: origin and path, every query value masked, the
 * way the server's own logs drop query strings (SMD-1849). A value there may
 * be a credential, and what is printed lands in a terminal or the log
 * (SMD-2743). `base` resolves a relative one, a redirect's Location. Scheme
 * and host rather than `origin`, which is "null" for a scheme not http(s).
 */
export function shownUrl(url, base) {
  try {
    const u = new URL(url, base);
    const q = [...new Set(u.searchParams.keys())].map((k) => `${encodeURIComponent(k)}=…`).join("&");
    return `${u.host ? `${u.protocol}//${u.host}` : u.protocol}${u.pathname}${q ? `?${q}` : ""}`;
  } catch { return "(a url that does not parse)"; }
}

/** A path as a shell word: quoted when it carries anything the shell would split or expand. */
export function shellWord(p) {
  return /^[A-Za-z0-9_./+:@%,=-]+$/.test(p) ? p : `'${String(p).replace(/'/g, `'\\''`)}'`;
}

export { UUID, clip, oneLine, sha256 };
