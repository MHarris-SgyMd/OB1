#!/usr/bin/env bun
/**
 * mechanism-yield.ts — which review mechanisms pay, read from the commit log.
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
 *   bun scripts/mechanism-yield.ts                      # whole log
 *   bun scripts/mechanism-yield.ts --since <sha>        # that commit and everything committed at or after it
 *   bun scripts/mechanism-yield.ts --since YYYY-MM-DD   # from that calendar day on, committer time in --zone
 *   bun scripts/mechanism-yield.ts --zone Europe/London # the zone days are read in (default America/Chicago)
 *   bun scripts/mechanism-yield.ts --log dump.txt       # a saved dump (--since then takes a date only)
 *   bun scripts/mechanism-yield.ts --self-check         # the parser fixtures
 *
 * `--since <sha>` is a window in TIME as well as ancestry — the commit's own
 * commit time onward — so a branch that started before the anchor and merged
 * after it contributes only what it committed in the tagged era. Every window
 * is a cut on the COMMITTER instant (`%cI`, the clock a rebase moves; about a
 * tenth of the log's commits were authored on another day than they were
 * committed). `--since YYYY-MM-DD` is resolved once to the instant that day
 * begins in ONE DECLARED ZONE — `--zone <Region/City>`, default
 * America/Chicago, the zone every review pass in the record was committed in
 * — and then filtered like the anchor, so the two spellings are one filter and
 * the zone is applied in one place. The zone is declared rather than taken
 * from the machine or from each commit's own offset because both make the
 * same command tally differently elsewhere: the log carries twelve committer
 * offsets, and a `--since 2026-09-18` run gave one commit set in Chicago,
 * another under UTC and a third in Tokyo. The window label names the zone,
 * and the day a row is shown with is rendered in it. The bare day is never
 * handed to git, whose approxidate reads it as that day at the current time
 * of day and silently drops every commit made earlier in it. The numbers
 * behind all this are in FORK.md, "The window and the attribution, corrected
 * (SMD-1728)". Options take `--name value` or `--name=value`; an unknown
 * option is refused. Others: --samples N (rows shown per class, default 6; 0
 * shows none), --dump rows.tsv (every row with its classification, its
 * committer instant and its day in --zone — not the dump `--log` reads). A
 * `--log` dump is what `git log --format='%x1e%H%x1f%cI%x1f%s%x1f%b'` prints:
 * instants, so it is zone-free and any reader's --zone applies. A dump whose
 * date column is a rendered day (made before this change) is refused by
 * record and must be regenerated; the log it came from still exists.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
// The commit-message grammar is defined once, in commit-grammar.ts, and shared
// with scripts/commitlint.config.ts (SMD-1808) — importing it here rather than
// keeping a second copy. Pure string work, no side effects at import.
import { passNumber, isRunResult, bulletsOf, MECHANISMS, readTag, isReviewPass, REVIEW_RE, BOYSCOUT_RE, MERGE_RE } from "./commit-grammar.ts";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const KNOWN = { "--since": "value", "--log": "value", "--zone": "value", "--samples": "value", "--dump": "value", "--self-check": "flag" };

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

/** A refusal with a reason: printed, and the run stops with exit 2. */
function refuse(msg) {
  console.error(msg);
  process.exit(2);
}

const OPTS = parseArgs(process.argv.slice(2));
if (OPTS.error) refuse(OPTS.error);
const samplesArg = Number(OPTS["--samples"]);
const SAMPLES = OPTS["--samples"] === undefined ? 6 : Number.isInteger(samplesArg) && samplesArg >= 0 ? samplesArg : null;
if (SAMPLES === null) refuse(`--samples takes a non-negative integer, got ${OPTS["--samples"]}`);
const DUMP = OPTS["--dump"];
const LOG = OPTS["--log"];
const SINCE = OPTS["--since"];
const SELF_CHECK = OPTS["--self-check"] === true;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

// ---------------------------------------------------------------------------
// The zone. A `--since YYYY-MM-DD` day is resolved ONCE to the instant it
// begins in one declared zone, and every window is then a comparison of
// committer instants — the same comparison the `--since <sha>` anchor makes.
// The zone is declared, not the machine's: the record's passes were all
// committed in this one, and a day cut must give the same set on every machine
// that re-runs the FORK.md command. Rows keep their instant; the calendar day
// a row is shown with is rendered in the same zone and is display only.
// ---------------------------------------------------------------------------
const DEFAULT_ZONE = "America/Chicago";
/** The zone from the options: a Region/City IANA name or UTC. Legacy abbreviations (EST) are refused — they are fixed offsets, not zones. */
function zoneOf(opts) {
  const z = opts["--zone"];
  if (z === undefined) return { zone: DEFAULT_ZONE };
  if (!/^(?:[A-Za-z]+\/[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)?|UTC)$/.test(z)) return { error: `--zone takes an IANA Region/City name such as ${DEFAULT_ZONE}, or UTC; got ${JSON.stringify(z)}` };
  return dayFormatter(z) ? { zone: z } : { error: `--zone: ${JSON.stringify(z)} is not a zone this runtime knows` };
}
/** A YYYY-MM-DD formatter for one IANA zone, or null when the runtime does not know the name. */
function dayFormatter(zone) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return null;
  }
}
/** The zone's offset from UTC at an instant, in ms (Chicago in September: -5 h). */
function offsetMs(t, zone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(t);
  const g = (type) => Number(parts.find((p) => p.type === type).value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - t.getTime();
}
/**
 * The instant a calendar day begins in a zone. Start from the day's UTC
 * midnight, shift by the zone's offset at that instant, and shift once more
 * so a DST change between the two candidate instants is applied.
 */
function startOfDay(day, zone) {
  const [y, m, d] = day.split("-").map(Number);
  const midnightUTC = Date.UTC(y, m - 1, d);
  let t = new Date(midnightUTC);
  for (let i = 0; i < 2; i++) t = new Date(midnightUTC - offsetMs(t, zone));
  return t;
}
/** The commits committed at or after an instant — the one window filter, for a day or a sha anchor alike. */
const sinceInstant = (commits, start) => commits.filter((c) => c.stamp.getTime() >= start.getTime());
/** The calendar day of an instant in a zone, for display. */
const dayOf = (t, formatter) => formatter.format(t);

const zoneRead = zoneOf(OPTS);
if (zoneRead.error) refuse(zoneRead.error);
const ZONE = zoneRead.zone;
const DAY_FORMAT = dayFormatter(ZONE);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
// %cI, the committer instant with its offset: the clock `--since <sha>` cuts
// on and the one a rebase moves. The author date (%ad) is when the work was
// done and can sit a day earlier, so a dump and a live run would window
// differently on it. An instant rather than a rendered day, so a dump is
// zone-free and the reader's --zone decides the day.
const FORMAT = "%x1e%H%x1f%cI%x1f%s%x1f%b";

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const msg = String(e.stderr ?? e.message).trim().split("\n")[0];
    refuse(`git ${args.slice(0, 2).join(" ")} failed: ${msg}`);
  }
}

/** Returns { commits, windowLabel }. */
function readLog() {
  const dayLabel = `window ${SINCE} (${ZONE} days) → `;
  if (LOG) {
    const commits = parseCommits(fs.readFileSync(LOG, "utf8"));
    if (SINCE === undefined) return { commits, windowLabel: "" };
    if (!isDate(SINCE)) refuse(`--since with --log takes a date (YYYY-MM-DD): a dump has no ancestry to resolve ${SINCE} against`);
    return { commits: sinceInstant(commits, startOfDay(SINCE, ZONE)), windowLabel: `${dayLabel}end of dump: ` };
  }
  const args = ["log", `--format=${FORMAT}`];
  if (SINCE === undefined) return { commits: parseCommits(git(args)), windowLabel: "" };
  if (isDate(SINCE)) {
    // The whole log, cut by the same instant filter the --log path applies.
    // Passing the bare day to git as --since would read it as that day at the
    // current time of day and drop every commit made earlier in the day.
    return { commits: sinceInstant(parseCommits(git(args)), startOfDay(SINCE, ZONE)), windowLabel: `${dayLabel}HEAD: ` };
  }
  // A revision: everything reachable from HEAD that was COMMITTED at or after
  // the anchor's own commit time, the anchor included. Ancestry alone
  // (`<rev>^..HEAD`) would admit a branch merged later whose commits predate
  // the anchor; time alone would admit commits on other branches.
  const committed = git(["log", "-1", "--format=%cI", SINCE]).trim();
  args.push(`--since=${committed}`, `${SINCE}^..HEAD`);
  return { commits: parseCommits(git(args)), windowLabel: `window ${SINCE} (committed ${dayOf(new Date(committed), DAY_FORMAT)}) → HEAD: ` };
}

/**
 * Records → commits. Each record is sha, committer instant, subject, body. A
 * record without its fields, or with a stamp that is not an instant — a
 * truncated copy, a hand-edited dump, or one made before SMD-1728 with a
 * rendered day — is refused by position, not skipped and not compared.
 */
function parseCommits(raw, fail = refuse) {
  return raw
    .split("\x1e")
    .filter((r) => r.trim())
    .map((r, i) => {
      const [sha, stamp, subject, body = ""] = r.split("\x1f");
      const id = `record ${i + 1} (${sha.trim().slice(0, 7)})`;
      if (stamp === undefined || subject === undefined) return fail(`${id} has no date or subject column; a dump is what \`git log --format='${FORMAT}'\` prints`);
      const s = stamp.trim();
      const t = new Date(s);
      // A bare day parses as a Date too (UTC midnight), so it is refused by shape, not by parse failure.
      if (isDate(s) || Number.isNaN(t.getTime())) return fail(`${id} has ${JSON.stringify(s)} where a committer instant (%cI) should be; a dump made with a rendered day (before SMD-1728) must be regenerated from the log`);
      return { sha: sha.trim().slice(0, 7), stamp: t, date: dayOf(t, DAY_FORMAT), subject: subject.trim(), body };
    });
}

/**
 * The ticket a commit belongs to: the first ticket in the parenthetical the
 * subject ends with — "(SMD-1607)", and as twelve subjects in the log spell it
 * "(SMD-1643, SMD-1616)", "(SMD-1462, migration 035)" or "(SMD-1463 review
 * pass 1)" — then the first mention in the subject, then the first in the
 * body. A subject often names another ticket before its own ("main took 79
 * for SMD-1037 … (SMD-1607)"), so first-mention-anywhere attributed 13 of the
 * log's review passes wrongly.
 */
const ticketOf = (subject, body) => subject.match(/\((SMD-\d+)[^()]*\)\s*$/)?.[1] ?? subject.match(/SMD-\d+/)?.[0] ?? body.match(/SMD-\d+/)?.[0] ?? "(none)";

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

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
/**
 * Where a ticket's last defect sits, as a label and a sort rank in one place:
 * "pass N" ranked N, then "an unnumbered pass" when only a named or unparsed
 * pass found one, then "none".
 */
const lastDefect = (e) => (e.lastDefect ? { rank: e.lastDefect, label: `pass ${e.lastDefect}` } : e.hadDefect ? { rank: 1e3, label: "an unnumbered pass" } : { rank: 1e6, label: "none" });

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
    "- bun scripts/check-fork-consistency.ts PASS, with a sentence long enough to look like a finding",
    "",
    "Verified against the container, and two things came of it:",
    "- test-live 17/17 (caught: run-it)",
    "- the migration applied twice and left one row, as an untagged line under a Verified heading",
    "",
    "Co-Authored-By: nobody <noreply@example.com>",
  ].join("\n");
  const { findings: bullets, skipped } = bulletsOf(body);
  check(bullets.length === 14, `fourteen finding bullets: continuation lines joined, nested and star bullets their own, the fenced example and the run results not among them, the tagged count under a Verified line in (${bullets.length})`);
  check(skipped.length === 5 && skipped.includes("ok.") && skipped.includes("bun db/test-schema.ts 907/907"), `five bullets skipped and kept for the samples: a run result by shape, two under a Green line, an untagged one under a Verified line, one too short to be a finding on its own (${skipped.length})`);
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
  check(ticketOf("[fork] Review, second pass: that field is SMD-1730's, not this one's (SMD-1719)", "Body mentions SMD-1000 first.") === "SMD-1719" && ticketOf("[fork] Review pass 2: the probe beside SMD-1498's, re-run on the fixed table", "") === "SMD-1498" && ticketOf("[fork] Review pass 1: the header re-read (SMD-1463 review pass 1)", "SMD-1526 first in the body") === "SMD-1463" && ticketOf("[fork] Review, first pass", "Filed as SMD-1462.") === "SMD-1462" && ticketOf("[fork] Review, first pass", "no ticket") === "(none)" && ticketOf("[fork] Bump, and SMD-1616's probe re-run (SMD-1643, SMD-1616)", "") === "SMD-1643", "ticket: the first in the subject's trailing parenthetical, then its first mention, then the body");
  check(FORMAT.includes("%x1f%cI%x1f") && !FORMAT.includes("%ad") && !FORMAT.includes("%cd"), "rows carry the committer instant, the clock the anchor cuts on, not a rendered day");
  {
    const iso = (t) => t.toISOString();
    check(iso(startOfDay("2026-09-18", "America/Chicago")) === "2026-09-18T05:00:00.000Z" && iso(startOfDay("2026-09-18", "UTC")) === "2026-09-18T00:00:00.000Z" && iso(startOfDay("2026-09-18", "Asia/Tokyo")) === "2026-09-17T15:00:00.000Z", "a day begins at a different instant in each declared zone");
    check(iso(startOfDay("2026-03-08", "America/Chicago")) === "2026-03-08T06:00:00.000Z" && iso(startOfDay("2026-11-01", "America/Chicago")) === "2026-11-01T05:00:00.000Z" && iso(startOfDay("2026-07-01", "America/Chicago")) === "2026-07-01T05:00:00.000Z", "the day DST starts still begins on standard time, the day it ends on daylight time");
    // Lebanon moves its clocks at midnight, so 2026-03-29 has no 00:00 there: the day begins at 01:00 EEST = 22:00Z the evening before. One shift from UTC midnight lands an hour early; the second corrects it.
    check(iso(startOfDay("2026-03-29", "Asia/Beirut")) === "2026-03-28T22:00:00.000Z", "a zone whose DST change falls at midnight still gets the day's true first instant");
    const parseErr = (raw) => {
      try {
        parseCommits(raw, (m) => { throw new Error(m); });
        return null;
      } catch (e) {
        return e.message;
      }
    };
    const rec = (...f) => "\x1e" + f.join("\x1f");
    const ok = rec("aaaaaaa1234", "2026-09-18T02:24:12-05:00", "s", "b");
    check(parseErr(ok) === null && /^record 2 \(bbbbbbb\) has "2026-09-18" where a committer instant/.test(parseErr(ok + rec("bbbbbbb1234", "2026-09-18", "s", "b"))) && /^record 2 \(ccccccc\) has "garbage"/.test(parseErr(ok + rec("ccccccc1234", "garbage", "s", "b"))) && /^record 2 \(ddddddd\) has no date or subject column/.test(parseErr(ok + "\x1eddddddd1234\n")), "a rendered day, an unreadable stamp and a record without fields are each refused by record, never compared");
    const cs = sinceInstant(
      [{ stamp: new Date("2026-09-18T04:59:59Z") }, { stamp: new Date("2026-09-18T05:00:00Z") }, { stamp: new Date("2026-09-18T20:30:00-05:00") }],
      startOfDay("2026-09-18", "America/Chicago"),
    );
    check(cs.length === 2, `a --since day keeps the commits from its first instant in the zone on: 23:59:59 Chicago the night before is out, midnight is in (${cs.length})`);
    check(sinceInstant([{ stamp: new Date("2026-09-18T20:30:00-05:00") }], startOfDay("2026-09-19", "UTC")).length === 1 && sinceInstant([{ stamp: new Date("2026-09-18T20:30:00-05:00") }], startOfDay("2026-09-19", "America/Chicago")).length === 0, "one instant is inside the 19th under UTC and outside it in Chicago — the zone decides, once");
    const chicago = dayFormatter("America/Chicago"), tokyo = dayFormatter("Asia/Tokyo");
    check(dayOf(new Date("2026-09-18T20:30:00-05:00"), chicago) === "2026-09-18" && dayOf(new Date("2026-09-18T20:30:00-05:00"), tokyo) === "2026-09-19", "the day a row is shown with is rendered in the declared zone");
    check(zoneOf({}).zone === DEFAULT_ZONE && zoneOf({ "--zone": "UTC" }).zone === "UTC" && zoneOf({ "--zone": "Europe/London" }).zone === "Europe/London" && zoneOf({ "--zone": "America/Argentina/Buenos_Aires" }).zone === "America/Argentina/Buenos_Aires", "the zone comes from --zone, else the default");
    check(!!zoneOf({ "--zone": "EST" }).error && !!zoneOf({ "--zone": "" }).error && !!zoneOf({ "--zone": "Not/AZone" }).error && /""/.test(zoneOf({ "--zone": "" }).error), "a legacy abbreviation, an empty value and an unknown name are refused, the empty one visibly");
    check(ZONE === (OPTS["--zone"] ?? DEFAULT_ZONE) && DAY_FORMAT.resolvedOptions().timeZone === ZONE, `the running zone is the one the options named and the formatter is built on it (${ZONE})`);
    const parsed = parseCommits("\x1e" + ["abcdef0123", "2026-09-18T20:30:00-05:00", "s", "b"].join("\x1f"));
    check(parsed.length === 1 && parsed[0].stamp.getTime() === Date.parse("2026-09-18T20:30:00-05:00") && parsed[0].date === dayOf(parsed[0].stamp, DAY_FORMAT) && parsed[0].sha === "abcdef0", "a parsed commit keeps its instant, and its shown day is that instant in the running zone");
  }
  {
    const s = ticketSummary([
      { ticket: "SMD-1", pass: 0, kind: "bullet", target: "code" },
      { ticket: "SMD-2", pass: 2, kind: "bullet", target: "code" },
      { ticket: "SMD-2", pass: 3, kind: "bullet", target: "record" },
      { ticket: "SMD-3", pass: 1, kind: "bullet", target: "confirmed" },
    ]);
    const l = (t) => lastDefect(s.get(t));
    check(l("SMD-1").label === "an unnumbered pass" && l("SMD-2").label === "pass 2" && l("SMD-3").label === "none" && l("SMD-2").rank < l("SMD-1").rank && l("SMD-1").rank < l("SMD-3").rank, "a defect found by a named pass is a defect the ticket had, not 'none'; ranks order numbered, unnumbered, none");
  }
  check(REVIEW_RE.test("[fork] Review, first pass: x") && REVIEW_RE.test("[fork] Review pass 6: x") && REVIEW_RE.test("[fork] Third review pass, triaged: x"), "the three review-pass subject shapes are recognised");
  check(!REVIEW_RE.test("[fork] This ticket's section is change 74: … while the third pass was in flight") && !REVIEW_RE.test("[fork] The ten-million-row second pass, measured") && !REVIEW_RE.test("[fork] Tidy the review passes left, while the files were open") && !REVIEW_RE.test("[fork] The reviewed pass over the bench, measured"), "a subject that only mentions a pass, or says reviewed, is not a review pass");
  check(BOYSCOUT_RE.test("[fork] Boyscout: tidy") && MERGE_RE.test("Merge origin/main into x: the review pass"), "boyscout and merge subjects told apart");
  const a1 = parseArgs(["--since=abc", "--samples", "0", "--zone", "UTC", "--self-check"]);
  const a2 = parseArgs(["--dump", "--self-check"]);
  const a3 = parseArgs(["--window", "x"]);
  const a4 = parseArgs(["--self-check=1"]);
  check(a1["--since"] === "abc" && a1["--samples"] === "0" && a1["--zone"] === "UTC" && a1["--self-check"] === true, "options read in both spellings");
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
const review = commits.filter((c) => isReviewPass(c.subject));
const boyscout = commits.filter((c) => BOYSCOUT_RE.test(c.subject) && !MERGE_RE.test(c.subject));

const rows = [];
let subjectOnly = 0;
const runResults = []; // the bullets the run-result rules dropped, printed in full at the end so a lost finding is visible
for (const c of review) {
  const ticket = ticketOf(c.subject, c.body);
  const pass = passNumber(c.subject);
  const { findings, skipped } = bulletsOf(c.body);
  for (const s of skipped) runResults.push({ sha: c.sha, ticket, pass, text: s });
  const row = (kind, text) => ({ sha: c.sha, stamp: c.stamp, date: c.date, ticket, pass, kind, ...classifyRow(text) });
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

// Every review commit has at least one row (a subject-only one when it has no bullets), so the ticket count is read from the rows, once.
console.log(`${windowLabel}commits ${commits.length}; review-pass commits ${review.length} across ${distinctTickets(rows.map((r) => r.ticket))} tickets (subject-only ${subjectOnly}); boyscout commits ${boyscout.length} (excluded: tidy-ups, not catches)`);
console.log(`finding rows ${bulletRows.length} in ${distinctTickets(bulletRows.map((r) => r.ticket))} tickets (+ ${subjectOnly} subject-only rows, not tabulated; ${runResults.length} run-result bullets skipped)`);
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
  // Each ticket's last defect computed once, then sorted and labelled from that.
  const list = [...ticketSummary(rows).entries()]
    .filter(([t, e]) => e.rows > 0 && t !== "(none)")
    .map(([t, e]) => ({ t, e, last: lastDefect(e) }))
    .sort((a, b) => a.last.rank - b.last.rank);
  const hist = new Map();
  for (const { last } of list) hist.set(last.label, (hist.get(last.label) ?? 0) + 1);
  console.log(`tickets with bullet rows: ${list.length}`);
  console.log("last defect at → tickets: " + [...hist.entries()].map(([p, n]) => `${p}: ${n}`).join(", "));
  const deep = list.filter(({ e }) => e.passes.size && Math.max(...e.passes) >= 5).sort((a, b) => Math.max(...b.e.passes) - Math.max(...a.e.passes));
  if (deep.length) console.log("≥5 passes: " + deep.map(({ t, e, last }) => `${t} (max ${Math.max(...e.passes)}, last defect ${last.label})`).join("; "));
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
// Every dropped bullet, not a sample and not subject to --samples 0: the section
// exists to show the rare finding a rule lost, and there are few (one in the log).
if (runResults.length) {
  console.log();
  console.log(`== Skipped as run results (all ${runResults.length}) — a finding here is a rule that needs a tag or a fix ==`);
  for (const r of runResults) console.log(`   ${r.ticket} p${r.pass ?? "?"} ${r.sha}: ${r.text.slice(0, 150)}`);
}

if (DUMP) {
  fs.writeFileSync(
    DUMP,
    // The committer instant and the day it was read as in --zone, so two row files made under different zones explain themselves.
    [`sha\tcommitted\tday (${ZONE})\tticket\tpass\tkind\tsource\tmechanism\theld\ttarget\ttext`, ...rows.map((r) => [r.sha, r.stamp.toISOString(), r.date, r.ticket, r.pass ?? "", r.kind, r.source, r.mechanism, r.held ?? "", r.target, r.text.replace(/\t/g, " ")].join("\t"))].join("\n") + "\n",
  );
  console.log(`\nrows written to ${DUMP}`);
}
