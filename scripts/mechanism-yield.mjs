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
 *     rather than counted as untagged.
 *
 *     A bullet with no tag is classified by a few narrow phrases that name a
 *     catcher ("found by driving …", "the runner", "M-…" mutants), reported as
 *     inferred:<mechanism>; everything else is `implicit` — the row says what
 *     was wrong and what changed, not what found it. On 2026-09-18 that was
 *     nearly every row, which is why the tag exists (SMD-1711; the baseline
 *     is in FORK.md, "Review passes: what caught a finding is written at the
 *     catch").
 *
 *   target — what was WRONG: code | test-teeth | record | confirmed | filed,
 *     by keyword rules stated in TARGET below, precedence in order. This axis
 *     the record does support; samples are printed so the rules can be judged.
 *
 * Also printed: the defect share (code + test-teeth) per pass number, which
 * tests whether later passes run dry, and the passes-per-ticket histogram.
 *
 * A review-pass commit is one whose subject says "review" and "pass" in one
 * of the fork's shapes ("Review, second pass", "Review pass 4", "Second review
 * pass", "Review, reproducibility pass"); merges and boyscout commits are not.
 * A commit that merely mentions a pass ("while the third pass was in flight")
 * is not one either.
 *
 * Not a CI gate. A maintainer report, run when ten tickets carry tags:
 *
 *   bun scripts/mechanism-yield.mjs                      # whole log
 *   bun scripts/mechanism-yield.mjs --since <sha|date>   # from that commit (inclusive) or date
 *   bun scripts/mechanism-yield.mjs --log dump.txt       # a saved dump
 *   bun scripts/mechanism-yield.mjs --self-check         # the parser fixtures
 *
 * Options: --samples N (rows shown per class, default 6; 0 shows none),
 * --dump rows.tsv (every row with its classification). A dump is what
 * `git log --format='%x1e%H%x1f%ad%x1f%s%x1f%b' --date=short` prints.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
/** The token after a flag, unless it is another flag or absent. */
function opt(name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}
const samplesArg = Number(opt("--samples"));
const SAMPLES = Number.isFinite(samplesArg) && samplesArg >= 0 ? samplesArg : 6;
const DUMP = opt("--dump");
const LOG = opt("--log");
const SINCE = opt("--since");
const SELF_CHECK = args.includes("--self-check");

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
const FORMAT = "%x1e%H%x1f%ad%x1f%s%x1f%b";

function readLog() {
  if (LOG) return fs.readFileSync(LOG, "utf8");
  const gitArgs = ["log", `--format=${FORMAT}`, "--date=short"];
  if (SINCE) {
    // A date bounds by time. Anything else is a revision, and the window
    // INCLUDES it: `<rev>^..HEAD`, since the operator passes the first tagged
    // commit and wants its rows counted. (A root commit has no parent and
    // would need `--log`; the fork's history does not start at a review pass.)
    if (/^\d{4}-\d{2}-\d{2}$/.test(SINCE)) gitArgs.push(`--since=${SINCE}`);
    else gitArgs.push(`${SINCE}^..HEAD`);
  }
  return execFileSync("git", gitArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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
// The word "review" is required: a subject that only mentions "the third pass" is not a review pass.
const REVIEW_RE = new RegExp(`\\breview,? ?(?:\\w+ )?pass\\b|\\b(?:${ORDINAL}) review pass\\b`, "i");
const BOYSCOUT_RE = /\bboyscout\b/i;
const MERGE_RE = /^Merge\b/;
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12 };

function passNumber(subject) {
  const m1 = subject.match(new RegExp(`\\b(${ORDINAL})(?: review)? pass\\b`, "i"));
  if (m1) return ORDINALS[m1[1].toLowerCase()];
  const m2 = subject.match(/\bpass (\d+)\b/i);
  if (m2) return Number(m2[1]);
  if (/reproducibility|convergence/i.test(subject)) return 0; // named, not numbered
  return null;
}
const ticketOf = (subject, body) => (subject + " " + body).match(/SMD-\d+/)?.[0] ?? "(none)";

/**
 * A bullet starts with "- " or "* " at any indent — a nested sub-bullet is its
 * own finding — and continues on indented lines that do not start one; a
 * blank or unindented line ends it.
 */
function bulletsOf(body) {
  const out = [];
  let cur = null;
  for (const line of body.split("\n")) {
    if (/^Co-Authored-By:/i.test(line)) break;
    const start = line.match(/^\s*[-*] (.*)$/);
    if (start) {
      if (cur) out.push(cur);
      cur = start[1].trim();
    } else if (cur && /^\s{2,}\S/.test(line)) {
      cur += " " + line.trim();
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out.filter((b) => b.length > 12);
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
 * no "(caught" at all; `{unparsed: true}` when there is one that does not read.
 */
function readTag(text) {
  const idx = text.toLowerCase().lastIndexOf("(caught");
  if (idx < 0) return null;
  const m = text.slice(idx).match(TAG_TAIL_RE);
  if (!m) return { unparsed: true, text };
  const mechanism = m[1].toLowerCase();
  return { mechanism, known: MECHANISMS.includes(mechanism), held: m[2]?.trim() ?? null, text: text.slice(0, idx).trim() };
}

// Narrow phrases that NAME a catcher in an untagged bullet. Deliberately few:
// the point of the tag is that these are rare.
const INFERRED = [
  ["mutant", /\bmutant|\bM-[a-z]\w*\b|\bmutation\b/i],
  ["run-it", /\bfound by (driving|running|re-?running)\b|\bdriving [a-z-]+ for real\b|\bthe runner\b|^Runner\b/i],
  ["automated", /\b(caught|found|flagged) by (check \d+|the checker|preflight|CI|typecheck|the gate|test-[a-z-]+)\b/i],
  ["cold-read", /\b(the reader|a reader|cold reader|the reviewer|a reviewer|cold read|verified false by the reviewer)\b/i],
  ["walkthrough", /\bwalkthrough\b|\bfollowing the (documented|README) (procedure|steps)\b/i],
];

// What was wrong. Precedence: a row that says it filed a ticket is `filed`
// even if it also names a comment; a confirmation is not a defect even if it
// names a test; record before test-teeth before code, since a fix to prose
// about a test is a record fix.
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
    return { text, source: "tag-unparsed", mechanism: "unparsed", held: null, target: classify(TARGET, text, "unclassified") };
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
  const inferred = classify(INFERRED, text, null);
  return {
    text,
    source: inferred ? "inferred" : "implicit",
    mechanism: inferred ? `inferred:${inferred}` : "implicit",
    held: null,
    target: classify(TARGET, text, "unclassified"),
  };
}

// ---------------------------------------------------------------------------
// Self-check: the parser and the tag reader on fixtures
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
    "",
    "Green after: bun test-live.ts 508/508.",
    "",
    "Co-Authored-By: nobody <noreply@example.com>",
  ].join("\n");
  const bullets = bulletsOf(body);
  check(bullets.length === 12, `twelve bullets parsed: continuation lines joined, nested and star bullets their own (${bullets.length})`);
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
  check(rows.filter((x) => x.source === "tagged").length === 5 && rows.filter((x) => x.source === "implicit").length === 4, `tagged 5, implicit 4 (${rows.filter((x) => x.source === "tagged").length}, ${rows.filter((x) => x.source === "implicit").length})`);
  check(passNumber("[fork] Review, second pass: …") === 2 && passNumber("[fork] Review pass 4: …") === 4 && passNumber("[fork] Second review pass, triaged: …") === 2 && passNumber("[fork] Review, reproducibility pass, triaged: …") === 0, "pass numbers from four subject shapes");
  check(REVIEW_RE.test("[fork] Review, first pass: x") && REVIEW_RE.test("[fork] Review pass 6: x") && REVIEW_RE.test("[fork] Third review pass, triaged: x"), "the three review-pass subject shapes are recognised");
  check(!REVIEW_RE.test("[fork] This ticket's section is change 74: … while the third pass was in flight") && !REVIEW_RE.test("[fork] The ten-million-row second pass, measured") && !REVIEW_RE.test("[fork] Tidy the review passes left, while the files were open"), "a subject that only mentions a pass is not a review pass");
  check(BOYSCOUT_RE.test("[fork] Boyscout: tidy") && MERGE_RE.test("Merge origin/main into x: the review pass"), "boyscout and merge subjects told apart");
  console.log(failures ? `\n${failures} self-check failure(s)` : "\nself-check green");
  return failures ? 1 : 0;
}

if (SELF_CHECK) process.exit(selfCheck());

// ---------------------------------------------------------------------------
// Build rows
// ---------------------------------------------------------------------------
const commits = parseCommits(readLog());
const review = commits.filter((c) => REVIEW_RE.test(c.subject) && !MERGE_RE.test(c.subject) && !BOYSCOUT_RE.test(c.subject));
const boyscout = commits.filter((c) => BOYSCOUT_RE.test(c.subject) && !MERGE_RE.test(c.subject));

const rows = [];
let subjectOnly = 0;
for (const c of review) {
  const ticket = ticketOf(c.subject, c.body);
  const pass = passNumber(c.subject);
  const bullets = bulletsOf(c.body);
  if (bullets.length === 0) {
    // Older passes carry their findings in the subject only: one coarse row, kept out of the tables.
    subjectOnly++;
    rows.push({ sha: c.sha, date: c.date, ticket, pass, kind: "subject", ...classifyRow(c.subject.replace(/^\[fork\]\s*/, "")) });
    continue;
  }
  for (const b of bullets) rows.push({ sha: c.sha, date: c.date, ticket, pass, kind: "bullet", ...classifyRow(b) });
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
const ticketsOf = (cs) => new Set(cs.map((c) => ticketOf(c.subject, c.body)).filter((t) => t !== "(none)")).size;

console.log(`${SINCE ? `window ${SINCE} → HEAD: ` : ""}commits ${commits.length}; review-pass commits ${review.length} across ${ticketsOf(review)} tickets (subject-only ${subjectOnly}); boyscout commits ${boyscout.length} (excluded: tidy-ups, not catches)`);
console.log(`finding rows ${bulletRows.length} in ${new Set(bulletRows.map((r) => r.ticket).filter((t) => t !== "(none)")).size} tickets (+ ${subjectOnly} subject-only rows, not tabulated)`);
{
  const by = Object.fromEntries(count(bulletRows, "source"));
  const tagged = (by.tagged ?? 0) + (by["tagged-unknown"] ?? 0);
  console.log(`catcher named: tagged ${tagged} (${pct(tagged, bulletRows.length)}), inferred ${by.inferred ?? 0}, implicit ${by.implicit ?? 0} (${pct(by.implicit ?? 0, bulletRows.length)})`);
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
console.log("implicit = the row names what was wrong and what changed, not what caught it; inferred:* = a phrase named the catcher; the rest are tags.");
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
  const byTicket = new Map();
  for (const c of review) {
    const t = ticketOf(c.subject, c.body);
    const e = byTicket.get(t) ?? { passes: new Set(), lastDefect: 0, rows: 0 };
    const p = passNumber(c.subject);
    if (p) e.passes.add(p);
    byTicket.set(t, e);
  }
  for (const r of bulletRows) {
    const e = byTicket.get(r.ticket);
    if (!e) continue;
    e.rows++;
    if (DEFECTS.has(r.target) && r.pass && r.pass > e.lastDefect) e.lastDefect = r.pass;
  }
  const list = [...byTicket.entries()].filter(([t, e]) => e.rows > 0 && t !== "(none)");
  const hist = new Map();
  for (const [, e] of list) hist.set(e.lastDefect, (hist.get(e.lastDefect) ?? 0) + 1);
  console.log(`tickets with bullet rows: ${list.length}`);
  console.log("last defect at → tickets: " + [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([p, n]) => `${p === 0 ? "none" : "pass " + p}: ${n}`).join(", "));
  const deep = list.filter(([, e]) => e.passes.size && Math.max(...e.passes) >= 5).sort((a, b) => Math.max(...b[1].passes) - Math.max(...a[1].passes));
  if (deep.length) console.log("≥5 passes: " + deep.map(([t, e]) => `${t} (max ${Math.max(...e.passes)}, last defect ${e.lastDefect || "none"})`).join("; "));
}
console.log();

if (bulletRows.some((r) => r.held)) {
  console.log("== What now holds the tagged findings (held:) ==");
  for (const [h, n] of count(bulletRows.filter((r) => r.held), "held").slice(0, 20)) console.log(`${rpad(n, 4)}  ${h}`);
  console.log();
}

const sample = (arr, n) => (n === 0 ? [] : arr.length <= n ? arr : Array.from({ length: n }, (_, i) => arr[Math.floor((i * arr.length) / n)]));
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
