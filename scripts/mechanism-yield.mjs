#!/usr/bin/env node
/**
 * mechanism-yield.mjs — which review mechanisms pay, read from the commit log.
 *
 * The fork's review loop records each pass as a commit whose body lists its
 * findings as bullets. This script treats every such bullet as one row and
 * tallies two things about it:
 *
 *   mechanism — what CAUGHT it. Read from the tag a bullet ends with:
 *
 *       - <finding>. (caught: <mechanism>)
 *       - <finding>. (caught: <mechanism>; held: <what now holds it>)
 *
 *     where <mechanism> is one of
 *       cold-read    a reviewer reading the diff or the record
 *       run-it       running the suite, bench or tool and reading what it did
 *       mutant       a deliberate break the suite should have failed on
 *       walkthrough  following the documented procedure as an operator or deployer
 *       automated    a gate fired on its own — CI, a check N, preflight, typecheck;
 *                    name it in `held`
 *     Confirmations of no defect and record fixes carry the tag too: the mix
 *     per mechanism is the point. `held` is optional and names the test
 *     section, check or migration that now enforces the finding; it may
 *     contain parentheses. A period after the closing paren is fine. The tag
 *     must be the last thing on the bullet: a bullet that contains "(caught"
 *     but does not end in a readable tag is reported as `tag-unparsed`, and a
 *     mechanism outside the five as `unknown:<name>`, so a typo is seen
 *     rather than counted as untagged. An untagged bullet is `implicit`: the
 *     row says what was wrong and what changed, not what found it. Nothing is
 *     inferred from phrasing — a pass that tried ("mutant", "the reviewer")
 *     found half its hits were mentions, not catches — so before the tag
 *     (SMD-1711) every row is implicit; the baseline is in FORK.md, "Review
 *     passes: what caught a finding is written at the catch".
 *
 *   target — what was WRONG: code | test-teeth | record | confirmed | filed,
 *     by keyword rules stated in TARGET below, precedence in order. Approximate
 *     by design (a defect in a checker that parses comments reads as record);
 *     samples are printed so the rules can be judged, and nothing is decided
 *     on these shares.
 *
 * What is a finding: a bullet ("- " or "* ", at any indent — a nested
 * sub-bullet is its own finding) in the body of a review-pass commit, outside
 * a fenced code block, and not a run result — a bullet under a "Green …" or
 * "Verified …" line, or one that is only suite names and N/N counts, is
 * skipped and counted as such, as is a bullet of twelve characters or fewer.
 * A bullet that carries a `(caught` tag is a finding wherever it sits: the
 * writer said so, and no heuristic overrules the tag. A bullet continues on
 * following non-blank lines at any indent until a blank line or the next
 * bullet, so a tag wrapped onto the next line is read.
 *
 * A review-pass commit is one whose subject says "review" and "pass" in one
 * of the fork's shapes ("Review, second pass", "Review pass 4", "Second review
 * pass", "Review, reproducibility pass"); merges and boyscout commits are not,
 * nor is a subject that merely mentions a pass ("while the third pass was in
 * flight").
 *
 * Also printed: the defect share (code + test-teeth) per pass number, which
 * tests whether later passes run dry, and the passes-per-ticket histogram.
 *
 * Not a CI gate. A maintainer report, run when ten tickets carry tags:
 *
 *   bun scripts/mechanism-yield.mjs                      # whole log
 *   bun scripts/mechanism-yield.mjs --since <sha>        # that commit and everything committed at or after it
 *   bun scripts/mechanism-yield.mjs --since YYYY-MM-DD   # from that calendar day on, by committer date
 *   bun scripts/mechanism-yield.mjs --log dump.txt       # a saved dump (--since then takes a date only)
 *   bun scripts/mechanism-yield.mjs --self-check         # the parser fixtures
 *
 * `--since <sha>` is a window in TIME as well as ancestry — the commit's own
 * commit time onward — so a branch that started before the anchor and merged
 * after it contributes only what it committed in the tagged era. Every date
 * the script cuts on or prints is the COMMITTER date (`%cd`): the anchor's
 * time, a `--since` day and each row's date are one clock, so a saved dump
 * and a live run of the same window tally alike (129 of the log's 1,351
 * commits were authored on a different day than they were committed — every
 * rebase moves the committer date). `--since YYYY-MM-DD` is the whole
 * calendar day on both paths: the script filters rows on their date rather
 * than handing the bare day to git, whose approxidate reads it as that day at
 * the current time of day and silently drops every commit made earlier in it
 * (`--since 2026-09-18` at 03:27 returned 0 commits; the same day's dump, 9).
 * Options take `--name value` or `--name=value`; an unknown option is
 * refused. Others: --samples N (rows shown per class, default 6; 0 shows
 * none), --dump rows.tsv (every row with its classification). A dump is what
 * `git log --format='%x1e%H%x1f%cd%x1f%s%x1f%b' --date=short` prints; one
 * made with `%ad` (before SMD-1728) carries author dates and windows on them.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const KNOWN = { "--since": "value", "--log": "value", "--samples": "value", "--dump": "value", "--self-check": "flag" };

/** `--name value` or `--name=value`; a flag takes none; anything unknown is refused. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const eq = tok.indexOf("=");
    const name = eq > 0 ? tok.slice(0, eq) : tok;
    const kind = KNOWN[name];
    if (!kind) return { error: `unknown option ${tok}; known: ${Object.keys(KNOWN).join(" ")}` };
    if (kind === "flag") {
      if (eq > 0) return { error: `${name} takes no value` };
      out[name] = true;
      continue;
    }
    const value = eq > 0 ? tok.slice(eq + 1) : argv[++i];
    if (value === undefined || value.startsWith("--")) return { error: `${name} needs a value` };
    out[name] = value;
  }
  return out;
}

const OPTS = parseArgs(process.argv.slice(2));
if (OPTS.error) {
  console.error(OPTS.error);
  process.exit(2);
}
const samplesArg = Number(OPTS["--samples"]);
const SAMPLES = OPTS["--samples"] === undefined ? 6 : Number.isInteger(samplesArg) && samplesArg >= 0 ? samplesArg : null;
if (SAMPLES === null) {
  console.error(`--samples takes a non-negative integer, got ${OPTS["--samples"]}`);
  process.exit(2);
}
const DUMP = OPTS["--dump"];
const LOG = OPTS["--log"];
const SINCE = OPTS["--since"];
const SELF_CHECK = OPTS["--self-check"] === true;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
/** The commits dated on or after a calendar day — the one date filter both paths use. */
const sinceDay = (commits, day) => commits.filter((c) => c.date >= day);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
// %cd, the committer date: the clock `--since <sha>` cuts on (%cI) and the one
// a rebase moves. The author date (%ad) is when the work was done and can sit
// a day earlier, so a dump and a live run would window differently on it.
const FORMAT = "%x1e%H%x1f%cd%x1f%s%x1f%b";

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const msg = String(e.stderr ?? e.message).trim().split("\n")[0];
    console.error(`git ${args.slice(0, 2).join(" ")} failed: ${msg}`);
    process.exit(2);
  }
}

/** Returns { commits, windowLabel }. */
function readLog() {
  if (LOG) {
    let commits = parseCommits(fs.readFileSync(LOG, "utf8"));
    if (SINCE === undefined) return { commits, windowLabel: "" };
    if (!isDate(SINCE)) {
      console.error(`--since with --log takes a date (YYYY-MM-DD): a dump has no ancestry to resolve ${SINCE} against`);
      process.exit(2);
    }
    return { commits: sinceDay(commits, SINCE), windowLabel: `window ${SINCE} → end of dump: ` };
  }
  const args = ["log", `--format=${FORMAT}`, "--date=short"];
  if (SINCE === undefined) return { commits: parseCommits(git(args)), windowLabel: "" };
  if (isDate(SINCE)) {
    // The whole log, cut by the same filter the --log path applies. Passing the
    // bare day to git as --since would read it as that day at the current time
    // of day and drop every commit made earlier in the day.
    return { commits: sinceDay(parseCommits(git(args)), SINCE), windowLabel: `window ${SINCE} → HEAD: ` };
  }
  // A revision: everything reachable from HEAD that was COMMITTED at or after
  // the anchor's own commit time, the anchor included. Ancestry alone
  // (`<rev>^..HEAD`) would admit a branch merged later whose commits predate
  // the anchor; time alone would admit commits on other branches.
  const committed = git(["log", "-1", "--format=%cI", SINCE]).trim();
  args.push(`--since=${committed}`, `${SINCE}^..HEAD`);
  return { commits: parseCommits(git(args)), windowLabel: `window ${SINCE} (committed ${committed.slice(0, 10)}) → HEAD: ` };
}

function parseCommits(raw) {
  return raw
    .split("\x1e")
    .filter((r) => r.trim())
    .map((r) => {
      const [sha, date, subject, body = ""] = r.split("\x1f");
      return { sha: sha.trim().slice(0, 7), date: date.trim(), subject: subject.trim(), body };
    });
}

const ORDINAL = "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth";
// "Review, second pass" / "Review pass 4" / "Review, reproducibility pass" / "Second review pass".
// The whole word "review" is required: "reviewed pass" and "the third pass was in flight" are not review passes.
const REVIEW_RE = new RegExp(`\\breview\\b,? ?(?:\\w+ )?pass\\b|\\b(?:${ORDINAL}) review pass\\b`, "i");
const BOYSCOUT_RE = /\bboyscout\b/i;
const MERGE_RE = /^Merge\b/;
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12 };

// One alternation, so the LEFTMOST mention wins whichever spelling it uses: a
// subject names its own pass first and an earlier one after ("Review pass 4:
// the third pass's fix held"); trying the ordinal spelling first would read
// that as pass 3.
const PASS_RE = new RegExp(`\\b(?:pass (\\d+)|(${ORDINAL})(?: review)? pass)\\b`, "i");
function passNumber(subject) {
  const m = subject.match(PASS_RE);
  if (m) return m[1] ? Number(m[1]) : ORDINALS[m[2].toLowerCase()];
  if (/reproducibility|convergence/i.test(subject)) return 0; // named, not numbered
  return null;
}
/**
 * The ticket a commit belongs to: the "(SMD-nnnn)" the subject ends with, then
 * the first mention in the subject, then the first in the body. A subject often
 * names another ticket before its own ("main took 79 for SMD-1037 … (SMD-1607)"),
 * so first-mention-anywhere attributed 13 of the log's review passes wrongly.
 */
const ticketOf = (subject, body) => subject.match(/\((SMD-\d+)\)\s*$/)?.[1] ?? subject.match(/SMD-\d+/)?.[0] ?? body.match(/SMD-\d+/)?.[0] ?? "(none)";

const BULLET_RE = /^\s*[-*] (.*)$/;
const GREEN_HEAD_RE = /^\s*(green|all green|verified)\b/i;
/** Only suite names and N/N counts: "Committed suite 500/500; test-schema 890/890 untouched." */
function isRunResult(text) {
  if (!/\b\d+\/\d+\b/.test(text)) return false;
  const words = text.replace(/\S+\s+\d+\/\d+/g, " ").replace(/\b\d+\/\d+\b/g, " ").match(/[A-Za-z]{3,}/g) ?? [];
  return words.length <= 3;
}

/**
 * Finding bullets of a commit body → { findings, skipped }. A bullet starts
 * with "- " or "* " at any indent and continues on following non-blank lines
 * until a blank line or the next bullet. Fenced code is skipped. Bullets under
 * a "Green …" or "Verified …" line, bullets that are only suite names and N/N
 * counts, and bullets of twelve characters or fewer are run results, counted
 * in `skipped` — unless the bullet carries a `(caught` tag, which makes it a
 * finding wherever it sits: a "Verified:" line may introduce tagged findings,
 * and a tagged bullet may quote the count that proved it.
 */
function bulletsOf(body) {
  const findings = [];
  let skipped = 0;
  let cur = null;
  let fenced = false;
  let green = false;
  const flush = () => {
    if (cur === null) return;
    const tagged = /\(caught/i.test(cur);
    if (!tagged && (green || isRunResult(cur) || cur.length <= 12)) skipped++;
    else findings.push(cur);
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

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
const MECHANISMS = ["cold-read", "run-it", "mutant", "walkthrough", "automated"];
// Applied to the bullet's tail from its LAST "(caught": mechanism, an optional
// held clause that may itself hold parentheses, the closing paren, an optional
// period, end of bullet.
const TAG_TAIL_RE = /^\((?:caught|caught-by):\s*([a-z_-]+)\s*(?:;\s*held(?:-by)?:\s*(.+?))?\s*\)\s*\.?\s*$/i;

/**
 * Reads the `(caught: …; held: …)` tag off a bullet. Returns null when there is
 * no "(caught" at all; `{unparsed: true, head}` when there is one that does not
 * read — `head` is the finding before it, so the target is classified over the
 * finding and not over whatever the broken tag names.
 */
function readTag(text) {
  const idx = text.toLowerCase().lastIndexOf("(caught");
  if (idx < 0) return null;
  const m = text.slice(idx).match(TAG_TAIL_RE);
  if (!m) return { unparsed: true, text, head: text.slice(0, idx).trim() };
  const mechanism = m[1].toLowerCase();
  return { mechanism, known: MECHANISMS.includes(mechanism), held: m[2]?.trim() ?? null, text: text.slice(0, idx).trim() };
}

// What was wrong. Precedence: a row that says it filed a ticket is `filed`
// even if it also names a comment; a confirmation is not a defect even if it
// names a test; record before test-teeth before code, since a fix to prose
// about a test is a record fix. Known skew: a code defect in a checker that
// parses comments or names reads as record.
const TARGET = [
  ["filed", /\bfiled\b|\bticket(ed)?\b|\bfollow-?up\b/i],
  ["confirmed", /\b(confirmed|as it must|as designed|as intended|no defect|not vacuous|unaffected|keeps its teeth|holds\b|checks out|both correct|is correct|are correct|not a defect|not a live defect|does NOT occur|verified:)/i],
  ["record", /\bFORK\b|§|\bREADME\b|\bcomment\b|\bheader\b|\bprose\b|\bcaption\b|\bwording\b|\bsaid\b|\bstated\b|\bstates\b|\bwrite-?up\b|\bdoc(s|umented|umentation|block)?\b|\brenumber|\bcross-?ref|\bcredit\b|\bname[ds]? (as|the)\b|\bcount(ed)? (said|says)|Verified line|\bknown-issues\b|\bnote\b|\bsentence\b|\bparagraph\b|\btable\b.*\b(said|read)\b/i],
  ["test-teeth", /\btest-[a-z-]+\.ts|\[\d+[a-z]?\]|\bassert(ion)?s?\b|\bvacuous|\btoothless|\bfixture|\bflak|\bskip(s|ped)?\b|\bsuite\b|\bteeth\b|\bgate[sd]?\b|\bthreshold|\bmargin\b|eval-[a-z-]+\.ts|\bbench-[a-z-]+\.ts|\bprobe\b/i],
  ["code", /\b(refuse[sd]?|wrong|silent(ly)?|never|race|hang|leak|regress|fix(ed|es)?|bug|defect|broke|fails?|failed|crash|deadlock|double|twice|missing|absent|leaked|ignored|unbounded|off by|overflow|null|undefined|dangl|split|parsed?|returned|printed|counted|accepted|trusted|buried|gone|dropped|stripped|quoted|cache|key|flag|loop|error|refusal|banner)\b|\.(ts|sql|mjs|sh)\b|\bmigration \d{3}\b|\b0\d\d\b|→/i],
];
const classify = (rules, text, fallback) => rules.find(([, re]) => re.test(text))?.[0] ?? fallback;
const DEFECTS = new Set(["code", "test-teeth"]);

/** One finding → one row with its two classifications. */
function classifyRow(text) {
  const tag = readTag(text);
  if (tag?.unparsed) {
    return { text, source: "tag-unparsed", mechanism: "unparsed", held: null, target: classify(TARGET, tag.head, "unclassified") };
  }
  if (tag) {
    return {
      text: tag.text,
      source: tag.known ? "tagged" : "tagged-unknown",
      mechanism: tag.known ? tag.mechanism : `unknown:${tag.mechanism}`,
      held: tag.held,
      target: classify(TARGET, tag.text, "unclassified"),
    };
  }
  return { text, source: "implicit", mechanism: "implicit", held: null, target: classify(TARGET, text, "unclassified") };
}

/**
 * Per ticket: the passes run (every review commit contributes its number,
 * subject-only ones too), the bullet rows, whether any row was a code/teeth
 * defect, and the highest-numbered pass that found one. `hadDefect` is kept
 * apart from `lastDefect` because a named pass (0) or an unparsed one (null)
 * can find a defect that no pass number can carry.
 */
function ticketSummary(rows) {
  const byTicket = new Map();
  for (const r of rows) {
    const e = byTicket.get(r.ticket) ?? { passes: new Set(), lastDefect: 0, hadDefect: false, rows: 0 };
    if (r.pass) e.passes.add(r.pass);
    if (r.kind === "bullet") {
      e.rows++;
      if (DEFECTS.has(r.target)) {
        e.hadDefect = true;
        if (r.pass && r.pass > e.lastDefect) e.lastDefect = r.pass;
      }
    }
    byTicket.set(r.ticket, e);
  }
  return byTicket;
}
/** "pass N", or where the defects sit when no numbered pass found one. */
const lastDefectLabel = (e) => (e.lastDefect ? `pass ${e.lastDefect}` : e.hadDefect ? "an unnumbered pass" : "none");

// ---------------------------------------------------------------------------
// Self-check: the parsers and the tag reader on fixtures
// ---------------------------------------------------------------------------
function selfCheck() {
  let failures = 0;
  const check = (ok, label) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
    if (!ok) failures++;
  };
  const body = [
    "A cold reader and a runner; findings triaged.",
    "",
    "- The count line said 507/507; the synthetic assertion made it 508. Fixed",
    "  in FORK §79. (caught: cold-read)",
    "- M-sound did NOT fail the soundness sample in three runs; closed with a",
    "  synthetic-graph assertion. (caught: mutant; held: test-live [17])",
    "- The version check trips on a changed version and does not false-trip.",
    "- A typo in the tag is kept and flagged. (caught: cold-reed)",
    "- A period after the tag, as a writer types it (caught: run-it).",
    "- Held with parentheses inside it (caught: automated; held: check 7 (owned set)).",
    "- A tag that is not last on the bullet (caught: cold-read) (SMD-1234)",
    "- No tag; ends with a ticket in parentheses and stays implicit (SMD-1462).",
    "- A parent bullet with two children:",
    "  - the first child finding, tagged (caught: walkthrough)",
    "  - the second child finding, untagged and long enough to count",
    "* A star bullet with an underscore typo (Caught-By: run_it; Held-By: x)",
    "- A bullet whose wrapped tag sits on a flush-left continuation line",
    "(caught: run-it)",
    "",
    "- ok.",
    "",
    "The convention, for the record:",
    "```",
    "- <finding>. (caught: <mechanism>)",
    "```",
    "",
    "- Committed suite 500/500; test-schema 890/890 untouched.",
    "",
    "Green after:",
    "- bun db/test-schema.ts 907/907",
    "- bun scripts/check-fork-consistency.mjs PASS, with a sentence long enough to look like a finding",
    "",
    "Verified against the container, and two things came of it:",
    "- test-live 17/17 (caught: run-it)",
    "- the migration applied twice and left one row, as an untagged line under a Verified heading",
    "",
    "Co-Authored-By: nobody <noreply@example.com>",
  ].join("\n");
  const { findings: bullets, skipped } = bulletsOf(body);
  check(bullets.length === 14, `fourteen finding bullets: continuation lines joined, nested and star bullets their own, the fenced example and the run results not among them, the tagged count under a Verified line in (${bullets.length})`);
  check(skipped === 5, `five bullets skipped: a run result by shape, two under a Green line, an untagged one under a Verified line, one too short to be a finding on its own (${skipped})`);
  check(bullets[13] === "test-live 17/17 (caught: run-it)" && isRunResult("test-live 17/17 (caught: run-it)"), "a bullet the run-result rule would skip is a finding once it carries a tag");
  const rows = bullets.map(classifyRow);
  const r = (i) => rows[i] ?? {};
  check(r(0).source === "tagged" && r(0).mechanism === "cold-read" && r(0).held === null, "tag without held read");
  check(r(0).target === "record", `tagged row still classified by target (${r(0).target})`);
  check(!/\(caught:/.test(r(0).text), "tag stripped from the finding text");
  check(r(1).source === "tagged" && r(1).mechanism === "mutant" && r(1).held === "test-live [17]", "tag with held read, brackets inside held survive");
  check(r(2).source === "implicit", "untagged bullet is implicit");
  check(r(3).source === "tagged-unknown" && r(3).mechanism === "unknown:cold-reed", "unknown mechanism kept and flagged");
  check(r(4).source === "tagged" && r(4).mechanism === "run-it", "a period after the closing paren is fine");
  check(r(5).source === "tagged" && r(5).mechanism === "automated" && r(5).held === "check 7 (owned set)", `parentheses inside held survive (${r(5).held})`);
  check(r(6).source === "tag-unparsed", "a tag that is not last on the bullet is reported unparsed, not implicit");
  check(r(7).source === "implicit" && r(7).target === "filed", "a trailing ticket in parentheses is not a tag");
  check(r(8).source === "implicit" && r(9).source === "tagged" && r(9).mechanism === "walkthrough" && r(10).source === "implicit", "nested sub-bullets are separate rows with their own tags");
  check(r(11).source === "tagged-unknown" && r(11).mechanism === "unknown:run_it", "star bullet parsed; underscore typo flagged as unknown");
  check(r(12).source === "tagged" && r(12).mechanism === "run-it", "a tag wrapped onto a flush-left line is read");
  check(rows.filter((x) => x.source === "tagged").length === 7 && rows.filter((x) => x.source === "implicit").length === 4, `tagged 7, implicit 4 (${rows.filter((x) => x.source === "tagged").length}, ${rows.filter((x) => x.source === "implicit").length})`);
  check(classifyRow("The header said five (caught: cold-read) trailing").target === "record" && classifyRow("Nothing classifiable (caught: cold-read; held: eval-x.ts) trailing").target === "unclassified", "an unparsed tag's row is classified over the finding, not over the tag's tail");
  check(passNumber("[fork] Review, second pass: …") === 2 && passNumber("[fork] Review pass 4: …") === 4 && passNumber("[fork] Second review pass, triaged: …") === 2 && passNumber("[fork] Review, reproducibility pass, triaged: …") === 0, "pass numbers from four subject shapes");
  check(passNumber("[fork] Review pass 4: the third pass's fix held, and …") === 4 && passNumber("[fork] Review, third pass: pass 2's RETURNING moved a test anchor …") === 3, "a subject that names two passes is attributed to the leftmost, whichever spelling");
  check(ticketOf("[fork] Review, second pass: that field is SMD-1730's, not this one's (SMD-1719)", "Body mentions SMD-1000 first.") === "SMD-1719" && ticketOf("[fork] Review pass 2: the figure is this ticket's probe, not SMD-1498's", "") === "SMD-1498" && ticketOf("[fork] Review, first pass", "Filed as SMD-1462.") === "SMD-1462" && ticketOf("[fork] Review, first pass", "no ticket") === "(none)", "ticket: the subject's trailing (SMD-n), then its first mention, then the body");
  check(FORMAT.includes("%x1f%cd%x1f") && !FORMAT.includes("%ad"), "rows carry the committer date, the clock the window is cut on");
  check(sinceDay([{ date: "2026-09-17" }, { date: "2026-09-18" }, { date: "2026-09-19" }], "2026-09-18").length === 2, "a --since day keeps that day and later, on the row's own date");
  {
    const s = ticketSummary([
      { ticket: "SMD-1", pass: 0, kind: "bullet", target: "code" },
      { ticket: "SMD-2", pass: 2, kind: "bullet", target: "code" },
      { ticket: "SMD-2", pass: 3, kind: "bullet", target: "record" },
      { ticket: "SMD-3", pass: 1, kind: "bullet", target: "confirmed" },
    ]);
    check(lastDefectLabel(s.get("SMD-1")) === "an unnumbered pass" && lastDefectLabel(s.get("SMD-2")) === "pass 2" && lastDefectLabel(s.get("SMD-3")) === "none", "a defect found by a named pass is a defect the ticket had, not 'none'");
  }
  check(REVIEW_RE.test("[fork] Review, first pass: x") && REVIEW_RE.test("[fork] Review pass 6: x") && REVIEW_RE.test("[fork] Third review pass, triaged: x"), "the three review-pass subject shapes are recognised");
  check(!REVIEW_RE.test("[fork] This ticket's section is change 74: … while the third pass was in flight") && !REVIEW_RE.test("[fork] The ten-million-row second pass, measured") && !REVIEW_RE.test("[fork] Tidy the review passes left, while the files were open") && !REVIEW_RE.test("[fork] The reviewed pass over the bench, measured"), "a subject that only mentions a pass, or says reviewed, is not a review pass");
  check(BOYSCOUT_RE.test("[fork] Boyscout: tidy") && MERGE_RE.test("Merge origin/main into x: the review pass"), "boyscout and merge subjects told apart");
  const a1 = parseArgs(["--since=abc", "--samples", "0", "--self-check"]);
  const a2 = parseArgs(["--dump", "--self-check"]);
  const a3 = parseArgs(["--window", "x"]);
  const a4 = parseArgs(["--self-check=1"]);
  check(a1["--since"] === "abc" && a1["--samples"] === "0" && a1["--self-check"] === true, "options read in both spellings");
  check(!!a2.error && !!a3.error && !!a4.error, "a flag is never a value, an unknown option is refused, a flag takes no value");
  check(isRunResult("Committed suite 500/500; test-schema 890/890 untouched.") && !isRunResult("[9]'s >= passed 20/20 runs with the trigger dropped — toothless"), "a run result is suite names and counts only; a finding that quotes a count is not one");
  console.log(failures ? `\n${failures} self-check failure(s)` : "\nself-check green");
  return failures ? 1 : 0;
}

if (SELF_CHECK) process.exit(selfCheck());

// ---------------------------------------------------------------------------
// Build rows
// ---------------------------------------------------------------------------
const { commits, windowLabel } = readLog();
const review = commits.filter((c) => REVIEW_RE.test(c.subject) && !MERGE_RE.test(c.subject) && !BOYSCOUT_RE.test(c.subject));
const boyscout = commits.filter((c) => BOYSCOUT_RE.test(c.subject) && !MERGE_RE.test(c.subject));

const rows = [];
let subjectOnly = 0;
let runResults = 0;
for (const c of review) {
  const ticket = ticketOf(c.subject, c.body);
  const pass = passNumber(c.subject);
  const { findings, skipped } = bulletsOf(c.body);
  runResults += skipped;
  const row = (kind, text) => ({ sha: c.sha, date: c.date, ticket, pass, kind, ...classifyRow(text) });
  if (findings.length === 0) {
    // Older passes carry their findings in the subject only: one coarse row, kept out of the tables.
    subjectOnly++;
    rows.push(row("subject", c.subject.replace(/^\[fork\]\s*/, "")));
    continue;
  }
  for (const b of findings) rows.push(row("bullet", b));
}
const bulletRows = rows.filter((r) => r.kind === "bullet");

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : "-");
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const count = (arr, key) => {
  const m = new Map();
  for (const r of arr) m.set(r[key], (m.get(r[key]) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const distinctTickets = (tickets) => new Set(tickets.filter((t) => t !== "(none)")).size;

console.log(`${windowLabel}commits ${commits.length}; review-pass commits ${review.length} across ${distinctTickets(review.map((c) => ticketOf(c.subject, c.body)))} tickets (subject-only ${subjectOnly}); boyscout commits ${boyscout.length} (excluded: tidy-ups, not catches)`);
console.log(`finding rows ${bulletRows.length} in ${distinctTickets(bulletRows.map((r) => r.ticket))} tickets (+ ${subjectOnly} subject-only rows, not tabulated; ${runResults} run-result bullets skipped)`);
{
  const by = Object.fromEntries(count(bulletRows, "source"));
  const tagged = (by.tagged ?? 0) + (by["tagged-unknown"] ?? 0);
  console.log(`catcher named: tagged ${tagged} (${pct(tagged, bulletRows.length)}), implicit ${by.implicit ?? 0} (${pct(by.implicit ?? 0, bulletRows.length)})`);
  if (by["tagged-unknown"]) console.log(`  WARN ${by["tagged-unknown"]} tag(s) name a mechanism outside {${MECHANISMS.join(", ")}} — listed as unknown:<name> below`);
  if (by["tag-unparsed"]) console.log(`  WARN ${by["tag-unparsed"]} bullet(s) contain "(caught" but do not end in a readable tag — listed as unparsed below; the tag must be the last thing on the bullet`);
}
console.log();

const targets = ["code", "test-teeth", "record", "confirmed", "filed", "unclassified"];
const mechs = count(bulletRows, "mechanism").map(([m]) => m);
console.log("== Mechanism × target ==");
console.log(pad("mechanism", 22) + targets.map((t) => rpad(t, 13)).join("") + rpad("total", 8) + rpad("defect%", 9));
const line = (label, rs) => {
  const defects = rs.filter((r) => DEFECTS.has(r.target)).length;
  console.log(pad(label, 22) + targets.map((t) => rpad(rs.filter((r) => r.target === t).length, 13)).join("") + rpad(rs.length, 8) + rpad(pct(defects, rs.length), 9));
};
for (const m of mechs) line(m, bulletRows.filter((r) => r.mechanism === m));
line("all", bulletRows);
console.log("implicit = untagged: the row names what was wrong and what changed, not what caught it. Target shares are approximate by design.");
console.log();

console.log("== Defect rows (code + test-teeth) per mechanism, ranked ==");
{
  const total = bulletRows.filter((r) => DEFECTS.has(r.target)).length;
  let cum = 0;
  for (const m of mechs) {
    const n = bulletRows.filter((r) => r.mechanism === m && DEFECTS.has(r.target)).length;
    cum += n;
    console.log(pad(m, 22) + rpad(n, 6) + rpad(pct(n, total), 7) + rpad("cum " + pct(cum, total), 12));
  }
}
console.log();

console.log("== By pass number ==");
console.log(pad("pass", 6) + rpad("rows", 6) + rpad("code", 7) + rpad("teeth", 7) + rpad("record", 8) + rpad("confirm", 9) + rpad("filed", 7) + rpad("uncl", 6) + rpad("defect%", 9) + rpad("commits", 9));
{
  // Every pass number the rows carry: numbered ones ascending, then the named (0) and the unparsed (null).
  const passes = [...new Set(bulletRows.map((r) => r.pass))].sort((a, b) => (a === null) - (b === null) || (a === 0) - (b === 0) || a - b);
  for (const p of passes) {
    const rs = bulletRows.filter((r) => r.pass === p);
    const n = (t) => rs.filter((r) => r.target === t).length;
    console.log(pad(p === 0 ? "named" : p ?? "?", 6) + rpad(rs.length, 6) + rpad(n("code"), 7) + rpad(n("test-teeth"), 7) + rpad(n("record"), 8) + rpad(n("confirmed"), 9) + rpad(n("filed"), 7) + rpad(n("unclassified"), 6) + rpad(pct(n("code") + n("test-teeth"), rs.length), 9) + rpad(new Set(rs.map((r) => r.sha)).size, 9));
  }
}
console.log();

console.log("== Per ticket: passes run, and the last pass that found a code/teeth defect ==");
{
  const list = [...ticketSummary(rows).entries()].filter(([t, e]) => e.rows > 0 && t !== "(none)");
  // Numbered passes ascending, then the tickets whose defects sit only in an unnumbered pass, then none.
  const order = (e) => (e.lastDefect ? e.lastDefect : e.hadDefect ? 1e3 : 1e6);
  const hist = new Map();
  for (const [, e] of list.sort((a, b) => order(a[1]) - order(b[1]))) hist.set(lastDefectLabel(e), (hist.get(lastDefectLabel(e)) ?? 0) + 1);
  console.log(`tickets with bullet rows: ${list.length}`);
  console.log("last defect at → tickets: " + [...hist.entries()].map(([p, n]) => `${p}: ${n}`).join(", "));
  const deep = list.filter(([, e]) => e.passes.size && Math.max(...e.passes) >= 5).sort((a, b) => Math.max(...b[1].passes) - Math.max(...a[1].passes));
  if (deep.length) console.log("≥5 passes: " + deep.map(([t, e]) => `${t} (max ${Math.max(...e.passes)}, last defect ${lastDefectLabel(e)})`).join("; "));
}
console.log();

if (bulletRows.some((r) => r.held)) {
  console.log("== What now holds the tagged findings (held:) ==");
  for (const [h, n] of count(bulletRows.filter((r) => r.held), "held").slice(0, 20)) console.log(`${rpad(n, 4)}  ${h}`);
  console.log();
}

const sample = (arr, n) => (arr.length <= n ? arr : Array.from({ length: n }, (_, i) => arr[Math.floor((i * arr.length) / n)]));
if (SAMPLES > 0) {
  console.log("== Samples per mechanism ==");
  for (const m of mechs) {
    console.log(`-- ${m}`);
    for (const r of sample(bulletRows.filter((r) => r.mechanism === m), SAMPLES)) console.log(`   [${r.target}] ${r.ticket} p${r.pass ?? "?"}: ${r.text.slice(0, 150)}`);
  }
  console.log();
  console.log("== Samples per target ==");
  for (const t of targets) {
    const rs = bulletRows.filter((r) => r.target === t);
    if (!rs.length) continue;
    console.log(`-- ${t} (${rs.length})`);
    for (const r of sample(rs, SAMPLES)) console.log(`   [${r.mechanism}] ${r.ticket} p${r.pass ?? "?"}: ${r.text.slice(0, 150)}`);
  }
}

if (DUMP) {
  fs.writeFileSync(
    DUMP,
    ["sha\tdate\tticket\tpass\tkind\tsource\tmechanism\theld\ttarget\ttext", ...rows.map((r) => [r.sha, r.date, r.ticket, r.pass ?? "", r.kind, r.source, r.mechanism, r.held ?? "", r.target, r.text.replace(/\t/g, " ")].join("\t"))].join("\n") + "\n",
  );
  console.log(`\nrows written to ${DUMP}`);
}
