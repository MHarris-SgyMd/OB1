/**
 * text.ts — what the runner's modules do to a string before they show it, written once (SMD-4325).
 *
 * The helpers here decide what untrusted text reaches a terminal, a record or a PR body, and each was written out in
 * the modules that used it: a rule mended in one copy did not reach the others.
 *
 * Where the others are. Six files are hashed into the probe stamp (profile.ts's PROFILE_FILES): change one and the
 * probes must run again before a real session. They import only each other, brief.ts and record.ts, and this module
 * is not one of them: nothing hashed imports it, so an edit here voids no stamp. What the hashed files need they keep
 * among themselves, and the rest of the runner imports it from them:
 *   - guard.ts: isObject, printable and shownText (hidden code points as <U+XXXX>, the one-line cut by code points);
 *   - session.ts: readNoFollow and writeNoFollow, which record.ts hands on;
 *   - probes.ts: developerGit, which fixture-git.ts wraps for the checks.
 * facts.ts keeps jsonOf and NOT_JSON, for claims.ts beside it.
 */

/**
 * A claim token masked wherever it appears in a text: `wc_` and its hex, and the markdown-escaped `wc\_` a server's
 * error or a model's report can carry (parity with the session hook's scrubber). One rule for every place the runner
 * writes words it did not make — a reply's detail, a hand-back comment, a release's reason, a PR's text. Three of the
 * four sites masked the plain form alone until SMD-4325. A token never reaches an agent session, so this is defence
 * in depth, which publish.ts's scanSecrets also backstops.
 */
export const maskTokens = (s: string): string => s.replace(/wc\\?_[0-9a-f]{6,}/gi, "wc_…");

/** A string on one line: every whitespace run closed to one space, trimmed, and cut at `max` UTF-16 units with an ellipsis. For a fragment of git's or a server's words in a message; text that may hide code points goes through guard.ts's shownText. */
export const oneLine = (s: string, max = 200): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
