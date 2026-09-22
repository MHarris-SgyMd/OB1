/**
 * commit-grammar.mjs — the fork's commit-message grammar, in one place.
 *
 * The pieces that read a commit subject and body: the review-pass number, the
 * finding bullets of a body, and the `(caught: …; held: …)` tag on a bullet.
 * scripts/mechanism-yield.mjs counts review yield with these, and
 * scripts/commitlint.config.mjs enforces them (SMD-1808) — so they live here,
 * imported by both, rather than defined twice. Pure string work: no git, no
 * process state, safe to import (mechanism-yield.mjs runs a CLI on load; this
 * does not). The rule the fork already applies to SQL: call the function that
 * owns a rule.
 *
 *   bun scripts/commit-grammar.mjs --self-check
 */

export const ORDINAL = "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth";
export const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12 };

// One alternation, so the LEFTMOST mention wins whichever spelling it uses: a
// subject names its own pass first and an earlier one after ("Review pass 4:
// the third pass's fix held"); trying the ordinal spelling first would read
// that as pass 3.
export const PASS_RE = new RegExp(`\\b(?:pass (\\d+)|(${ORDINAL})(?: review)? pass)\\b`, "i");
export function passNumber(subject) {
  const m = subject.match(PASS_RE);
  if (m) return m[1] ? Number(m[1]) : ORDINALS[m[2].toLowerCase()];
  if (/reproducibility|convergence/i.test(subject)) return 0; // named, not numbered
  return null;
}

// "Review, second pass" / "Review pass 4" / "Review, reproducibility pass" /
// "Second review pass". The whole word "review" is required: "reviewed pass" and
// "the third pass was in flight" are NOT review passes — so a subject that merely
// mentions a "pass" (passNumber !== null) is not enough on its own.
export const REVIEW_RE = new RegExp(`\\breview\\b,? ?(?:\\w+ )?pass\\b|\\b(?:${ORDINAL}) review pass\\b`, "i");
export const BOYSCOUT_RE = /\bboyscout\b/i;
export const MERGE_RE = /^Merge\b/;

/**
 * Is this subject a review pass — the commits the caught-tag rule holds to their
 * tags, and mechanism-yield counts yield over? A review pass (REVIEW_RE), and not
 * a merge or a boyscout commit. NOT bare passNumber: "the ten-million-row second
 * pass, measured" names a pass but is not a review pass.
 */
export function isReviewPass(subject) {
  return REVIEW_RE.test(subject) && !MERGE_RE.test(subject) && !BOYSCOUT_RE.test(subject);
}

export const BULLET_RE = /^\s*[-*] (.*)$/;
export const GREEN_HEAD_RE = /^\s*(green|all green|verified)\b/i;
/** Only suite names and N/N counts: "Committed suite 500/500; test-schema 890/890 untouched." */
export function isRunResult(text) {
  if (!/\b\d+\/\d+\b/.test(text)) return false;
  const words = text.replace(/\S+\s+\d+\/\d+/g, " ").replace(/\b\d+\/\d+\b/g, " ").match(/[A-Za-z]{3,}/g) ?? [];
  return words.length <= 3;
}

/**
 * Finding bullets of a commit body → { findings, skipped }, both lists, so a
 * bullet the run-result rules drop can be shown and judged. A bullet starts
 * with "- " or "* " at any indent and continues on following non-blank lines
 * until a blank line or the next bullet. Fenced code is skipped. Bullets under
 * a "Green …" or "Verified …" line, bullets that are only suite names and N/N
 * counts, and bullets of twelve characters or fewer are run results, counted
 * in `skipped` — unless the bullet carries a `(caught` tag, which makes it a
 * finding wherever it sits: a "Verified:" line may introduce tagged findings,
 * and a tagged bullet may quote the count that proved it.
 */
export function bulletsOf(body) {
  const findings = [];
  const skipped = [];
  let cur = null;
  let fenced = false;
  let green = false;
  const flush = () => {
    if (cur === null) return;
    const tagged = /\(caught/i.test(cur);
    (!tagged && (green || isRunResult(cur) || cur.length <= 12) ? skipped : findings).push(cur);
    cur = null;
  };
  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line)) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (/^Co-Authored-By:/i.test(line)) break;
    if (line.trim() === "") {
      flush();
      green = false;
      continue;
    }
    const start = line.match(BULLET_RE);
    if (start) {
      flush();
      cur = start[1].trim();
    } else if (cur !== null) {
      cur += " " + line.trim();
    } else if (GREEN_HEAD_RE.test(line)) {
      green = true;
    }
  }
  flush();
  return { findings, skipped };
}

export const MECHANISMS = ["cold-read", "run-it", "mutant", "walkthrough", "automated"];
// Applied to the bullet's tail from its LAST "(caught": mechanism, an optional
// held clause that may itself hold parentheses, the closing paren, an optional
// period, end of bullet.
export const TAG_TAIL_RE = /^\((?:caught|caught-by):\s*([a-z_-]+)\s*(?:;\s*held(?:-by)?:\s*(.+?))?\s*\)\s*\.?\s*$/i;

/**
 * Reads the `(caught: …; held: …)` tag off a bullet. Returns null when there is
 * no "(caught" at all; `{unparsed: true, head}` when there is one that does not
 * read — `head` is the finding before it, so the target is classified over the
 * finding and not over whatever the broken tag names.
 */
export function readTag(text) {
  const idx = text.toLowerCase().lastIndexOf("(caught");
  if (idx < 0) return null;
  const m = text.slice(idx).match(TAG_TAIL_RE);
  if (!m) return { unparsed: true, text, head: text.slice(0, idx).trim() };
  const mechanism = m[1].toLowerCase();
  return { mechanism, known: MECHANISMS.includes(mechanism), held: m[2]?.trim() ?? null, text: text.slice(0, idx).trim() };
}

// ---------------------------------------------------------------------------
// Self-check — the grammar mechanism-yield.mjs and commitlint both depend on.
// ---------------------------------------------------------------------------
function selfCheck() {
  let bad = 0;
  const ok = (cond, label) => { if (!cond) { console.error(`FAIL ${label}`); bad++; } };

  ok(passNumber("[fork] Review pass 4: the third pass's fix held (SMD-1)") === 4, "leftmost pass number wins over an earlier one");
  ok(passNumber("[fork] Third review pass, triaged (SMD-1)") === 3, "ordinal review pass");
  ok(passNumber("[fork] Review, reproducibility pass (SMD-1)") === 0, "a named (not numbered) pass is 0");
  ok(passNumber("[fork] A plain change (SMD-1)") === null, "a non-review subject is null");

  ok(isReviewPass("[fork] Review pass 2: a thing (SMD-1)") === true, "a review pass is one");
  ok(isReviewPass("[fork] Third review pass, triaged (SMD-1)") === true, "an ordinal review pass is one");
  ok(isReviewPass("[fork] The ten-million-row second pass, measured (SMD-1)") === false, "a subject that only NAMES a pass is not a review pass (caught-tag must not fire on it)");
  ok(isReviewPass("[fork] Boyscout: tidy the review passes left (SMD-1)") === false, "a boyscout commit is not a review pass");
  ok(isReviewPass("Merge origin/main into x: the second review pass") === false, "a merge is not a review pass");

  const t = readTag("a masked failure (caught: self-review; held: --write is never run in CI)");
  ok(t && t.mechanism === "self-review" && t.known === false && /never run in CI/.test(t.held), "a tag with an unknown (single-token) mechanism and a held clause reads, known:false");
  ok(readTag("no tag here") === null, "no (caught → null");
  // A multi-word mechanism the record uses ("CI, SQL data layer job") does not
  // read as a mechanism, so it is unparsed — which the caught-tag rule treats as
  // "carries a tag" (present) all the same.
  ok(readTag("a bug (caught: CI, SQL data layer job; held: x)").unparsed === true, "a multi-word mechanism is a present-but-unparsed tag");
  ok(readTag("a finding (caught but broken").unparsed === true, "a (caught that does not parse is unparsed");
  ok(readTag("cite (caught: self-review)").mechanism === "self-review", "a bare tag reads its mechanism");
  ok(readTag("held may nest (caught: mutant; held: the guard (two of them) bites)").held === "the guard (two of them) bites", "held may hold parens");

  const b = bulletsOf("- a real finding (caught: mutant)\n- 500/500 suites pass\n- a bare finding\n\nVerified: all green\n- toothless\nCo-Authored-By: x");
  ok(b.findings.length === 2 && /real finding/.test(b.findings[0]) && /bare finding/.test(b.findings[1]), "finding bullets kept; a run-result bullet skipped");
  ok(b.skipped.some((s) => /500\/500/.test(s)), "a suite/count bullet is skipped");
  ok(isRunResult("test-schema 890/890 untouched") && !isRunResult("[9]'s 20/20 with the trigger dropped is toothless"), "a run result is names + counts only");

  if (bad === 0) console.log("commit-grammar.mjs self-check PASS");
  return bad === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(selfCheck());
