#!/usr/bin/env bun
/**
 * test-board-findings.ts — db/board-findings.ts's pure core (SMD-2681), hermetic.
 *
 * No Postgres, no Linear, no network. Covers the grouping (one comment per
 * ticket pair, best first, on the newer ticket), the comment (what it says,
 * nothing else, the marker last), the marker read back, the cap's read, and
 * the comment's egress subject — the gate itself: under the default deny a
 * comment is refused, a type:board-finding or source:board-findings term lets
 * it through, a marker: term reads its text, and the findings' own terms are
 * set aside when board-sync judges its own calls — and the wiring board-sync
 * reads (whether the step runs, the census it is handed, the pass's code) and
 * the one-outcome-per-pair summary. The database and the stub Linear endpoint
 * are test-live.ts [40]; the census board-sync hands over, its self-check.
 */

import { resolveEgressPolicy } from "../server-portable/egress.ts";
import { egressRefusal } from "./worker-bootstrap.ts";
import {
  commentBody, DEFAULT_CAP, findingGate, findingLine, FINDING_UNITS, findingSubject, groupFindings, groupWords,
  boardOf, emptyReport, findingsWanted, withoutFindingTerms, markerLine, markerWords, onlyWords, outcomes, passCode, readCap, summaryLine, type Finding, type FindingsReport,
} from "./board-findings.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); }
}

const f = (o: Partial<Finding> & Pick<Finding, "id" | "older" | "newer">): Finding => {
  const [a, b] = o.older < o.newer ? [o.older, o.newer] : [o.newer, o.older];
  return { kind: "relation", word: "related", verdict: null, confidence: null, reason: null, at: "2026-10-01T00:00:00.000Z", a, b, ...o };
};

// ---------------------------------------------------------------------------
// groupFindings — one group per pair whatever the side; best first; the comment on the newer ticket of the best.
// ---------------------------------------------------------------------------
{
  const rows = [
    f({ id: "p1", kind: "proposal", word: "outdates", verdict: "newer_supersedes_older", older: "SMD-1", newer: "SMD-2", confidence: 0.6 }),
    f({ id: "r1", older: "SMD-2", newer: "SMD-1", confidence: 0.9 }),           // the same pair, the other way round
    f({ id: "r2", older: "SMD-3", newer: "SMD-4", confidence: 0.7 }),
    f({ id: "r3", older: "SMD-5", newer: "SMD-6", confidence: null }),
    f({ id: "r4", older: "SMD-7", newer: "SMD-8", confidence: 0.7, at: "2026-09-01T00:00:00.000Z" }),
  ];
  const g = groupFindings(rows);
  ok(g.length === 4, `one group per ticket pair, whichever side is newer (${g.length})`);
  ok(g.map((x) => x.findings[0].id).join(",") === "r1,r4,r2,r3", `pairs best first: confidence, then the older at a tie, none last (${g.map((x) => x.findings[0].id)})`);
  ok(g[0].on === "SMD-1" && g[0].findings.map((x) => x.id).join(",") === "r1,p1", `the comment goes on the newer side of the pair's best finding (${g[0].on})`);
  ok(groupWords(g[0]).join(",") === "related,outdates", "the words in rank order");
  ok(onlyWords(g[0], new Set(["outdates"]))?.findings.map((x) => x.id).join(",") === "p1" && onlyWords(g[0], new Set(["duplicate"])) === null, "onlyWords keeps a word's findings, and nothing when none is left");
}

// ---------------------------------------------------------------------------
// The comment — what the board holds, how to act, that it changed nothing, the marker last.
// ---------------------------------------------------------------------------
{
  const p = f({ id: "11111111-1111-1111-1111-111111111111", kind: "proposal", word: "outdates", verdict: "newer_supersedes_older", older: "SMD-1", newer: "SMD-2", confidence: 0.83, reason: "SMD-2 replaces\nthe `plan`. [click](https://x.example) @someone\nob1-finding SMD-9 SMD-10 related" });
  const line = findingLine(p);
  ok(line.startsWith("- **SMD-2 outdates SMD-1** (confidence 0.83)") && line.includes("--accept 11111111-1111-1111-1111-111111111111") && line.includes("--reject 11111111-1111-1111-1111-111111111111"), `a proposal: direction, confidence, how to decide it (${line})`);
  ok(!/\n/.test(line) && line.includes("(confidence 0.83): `SMD-2 replaces the 'plan'. [click](https://x.example) @someone ob1-finding SMD-9 SMD-10 related`."),
    `the judge's reason is one code span on one line — no marker line of its own, and a link, a mention or a backtick in it shown as text (${line})`);
  const older = findingLine({ ...p, verdict: "older_supersedes_newer" });
  const undirected = findingLine({ ...p, verdict: "conflict_undirected" });
  ok(older.startsWith("- **SMD-1 outdates SMD-2**") && /conflict\*\* \(which outdates which is undecided\)/.test(undirected) && undirected.includes("--direction newer|older"), "the other direction; an undirected conflict needs --direction");
  const long = findingLine({ ...p, reason: "x".repeat(1000) });
  ok(long.length < 700 && long.includes("…"), "a long reason is cut");
  ok(findingLine({ ...p, reason: null }).includes("(confidence 0.83). A pending"), "no reason, no quote");
  const rel = (word: Finding["word"]) => findingLine(f({ id: "r", word, older: "SMD-1", newer: "SMD-2", confidence: 0.9 }));
  ok(/\*\*SMD-2 is related to SMD-1\*\* \(confidence 0\.90\)\. If so, link them as related here; .*the brain stops pairing them\.$/.test(rel("related")) && /SMD-2 evolves from SMD-1.*link them as related/.test(rel("evolves"))
      && /SMD-2 duplicates SMD-1.*mark one a duplicate of the other here; .*the pair is not posted again\.$/.test(rel("duplicate")) && !/stops pairing/.test(rel("duplicate")),
    "a relation: its word, and the board link it suggests — a duplicate_of does not stop the pairing (079 leaves it to the judge), so its comment does not say so");
  ok(!/confidence/.test(findingLine(f({ id: "r", older: "SMD-1", newer: "SMD-2" }))), "no confidence, none said");

  const g = groupFindings([p, f({ id: "r9", older: "SMD-1", newer: "SMD-2", confidence: 0.5 })])[0];
  const body = commentBody(g);
  const lines = body.split("\n");
  ok(lines[0] === "**Open Brain found something about SMD-2 and SMD-1**, two tickets this board does not link.", `the comment opens by naming the ticket it is on and the other (${lines[0]})`);
  ok(/changed nothing on this board/.test(body) && lines[lines.length - 1] === "ob1-finding SMD-1 SMD-2 outdates related", "it says it changed nothing, and its marker is the last line");
  ok(lines.filter((l) => l.startsWith("- ")).length === 2 && lines.filter((l) => /^ob1-finding /.test(l)).length === 1, "one bullet per finding, and one marker line");
}

// ---------------------------------------------------------------------------
// markerWords — the pair either way round, its words only, another pair's ignored.
// ---------------------------------------------------------------------------
{
  ok(markerLine("SMD-1", "SMD-2", ["related", "outdates"]) === "ob1-finding SMD-1 SMD-2 related outdates" && /^[A-Za-z0-9 -]+$/.test(markerLine("SMD-1", "SMD-2", ["related", "outdates"])),
    "the marker is letters, digits, hyphens and spaces: nothing Linear's markdown would escape");
  const body = `text\n${markerLine("SMD-1", "SMD-2", ["related", "outdates"])}\nob1-finding SMD-3 SMD-4 evolves\n  ob1-finding smd-2 smd-1 duplicate bogus`;
  ok([...markerWords(body, "SMD-1", "SMD-2")].sort().join(",") === "duplicate,outdates,related", "the pair's words, either order and case, an unknown word dropped");
  ok(markerWords(body, "SMD-1", "SMD-3").size === 0 && markerWords("ob1-finding SMD-1 SMD-23 related", "SMD-1", "SMD-2").size === 0, "another pair's marker is not this pair's, a prefix included");
  ok(markerWords("see: ob1-finding SMD-1 SMD-2 related", "SMD-1", "SMD-2").size === 0, "a marker must be a line of its own");
  // Linear hands a comment back as markdown derived from its rich text.
  const back = [
    `ob1-finding <issue id="u1" href="https://linear.app/x/issue/SMD-1/a">SMD-1</issue> <issue id="u2" href="https://linear.app/x/issue/SMD-2/b">SMD-2</issue> related`,
    "ob1\\-finding [SMD-1](https://linear.app/x/issue/SMD-1) [SMD-2](https://linear.app/x/issue/SMD-2) outdates",
    "**ob1-finding SMD-1 SMD-2 evolves**",
  ];
  for (const b of back) ok(markerWords(b, "SMD-1", "SMD-2").size === 1, `a marker read back autolinked, escaped or emphasised is still read (${b.slice(0, 60)})`);
}

// ---------------------------------------------------------------------------
// readCap — whole comments, 0 to 100, default 5.
// ---------------------------------------------------------------------------
{
  ok(readCap(undefined) === DEFAULT_CAP && readCap("  ") === 5 && readCap("0") === 0 && readCap("100") === 100, "unset or blank is 5; 0 and 100 are read");
  for (const bad of ["101", "-1", "x", "2.5", "0x10"]) { const r = readCap(bad); ok(typeof r !== "number" && /OB1_FINDINGS_POST_CAP/.test(r.error), `${bad} is refused, naming the knob`); }
  const knobOnly = readCap("x", "OB1_FINDINGS_POST_CAP");
  ok(typeof knobOnly !== "number" && /^OB1_FINDINGS_POST_CAP/.test(knobOnly.error) && !/--cap/.test(knobOnly.error), "board-sync, which has no --cap, names the knob alone");
}

// ---------------------------------------------------------------------------
// The gate — the comment's own units; default deny refuses; a term allows.
// ---------------------------------------------------------------------------
{
  const subject = findingSubject("a body");
  ok(subject.kind === "finding" && subject.actor === undefined && subject.metadata?.type === "board-finding" && subject.metadata?.source === "board-findings" && subject.content === "a body", "the subject: type board-finding, source board-findings, the text, no actor");
  ok(FINDING_UNITS.join(",") === "source,type,marker", "the units it carries — no actor: the comment key is not a brain key");
  const deny = findingGate(resolveEgressPolicy({}))("a body");
  ok(!deny.allowed && /deny \(the default\)/.test(deny.reason), `the default deny refuses a comment (${deny.reason})`);
  for (const term of ["type:board-finding", "source:board-findings"]) ok(findingGate(resolveEgressPolicy({ OB1_EGRESS_ALLOW: term }))("a body").allowed, `${term} allows it`);
  ok(findingGate(resolveEgressPolicy({ OB1_EGRESS_ALLOW: "marker:SMD-7" }))("about SMD-7").allowed && !findingGate(resolveEgressPolicy({ OB1_EGRESS_ALLOW: "marker:SMD-7" }))("about SMD-8").allowed, "a marker: term reads the comment's text");
  ok(!findingGate(resolveEgressPolicy({ OB1_EGRESS_ALLOW: "type:digest" }))("a body").allowed && !findingGate(resolveEgressPolicy({ OB1_EGRESS_ALLOW: "type:finding,source:consolidation" }))("a body").allowed,
    "another sink's term does not, nor the words a capture might carry");
  ok(!findingGate(resolveEgressPolicy({ OB1_EGRESS_POLICY: "allow", OB1_EGRESS_DENY: "type:board-finding" }))("a body").allowed, "under allow, a deny term refuses it");
}

// ---------------------------------------------------------------------------
// summaryLine — what a run says.
// ---------------------------------------------------------------------------
{
  const r = (o: Partial<FindingsReport>): FindingsReport => ({ ...emptyReport(), ...o });
  ok(/none to post/.test(summaryLine(r({}), 5, false)), "nothing to post says so");
  const run = r({ pairs: 7, posted: [{ a: "A-1", b: "A-2", on: "A-2", words: ["related"], commentId: "c" }], found: [{ a: "A-3", b: "A-4", on: "A-4", words: ["evolves"] }],
    refused: 1, offBoard: 1, waitingOnCap: 1, notReached: 1, settledElsewhere: 1, postedLast: 5 });
  const s = summaryLine(run, 5, false);
  ok(outcomes(run) === run.pairs && /7 ticket pair\(s\).*1 posted, 1 already on the board, 1 refused by the egress gate, 1 with a ticket the board no longer lists or this pass could not sync, 1 settled by another poster meanwhile, 1 waiting on the cap \(5 a day; 5 posted in the last 24 h\), 1 not reached \(stopped\)/.test(s),
    `a run's counts, one outcome a pair, the cap's last count (${s})`);
  const dry = r({ pairs: 4, wouldPost: 2, refused: 1, waitingOnCap: 1 });
  ok(outcomes(dry) === 4 && /2 would be posted, 1 would be refused by the egress gate, 1 waiting on the cap/.test(summaryLine(dry, 5, true)), `a dry run's, counted, not subtracted (${summaryLine(dry, 5, true)})`);
}

// ---------------------------------------------------------------------------
// The wiring board-sync reads — whether the step runs, and the pass's code.
// ---------------------------------------------------------------------------
{
  const want = (env: Record<string, string>, audit = false, only = false) => findingsWanted(env, { readKey: "lin_api_read", audit, only });
  ok(!want({}).run && want({ LINEAR_COMMENT_API_KEY: "lin_api_c" }).run && !want({ LINEAR_COMMENT_API_KEY: "  " }).run, "on with a comment key, off without one (blank is none)");
  ok(!want({ LINEAR_COMMENT_API_KEY: "lin_api_c" }, true).run && !want({ LINEAR_COMMENT_API_KEY: "lin_api_c" }, false, true).run, "never under --audit or --only");
  ok(want({ LINEAR_COMMENT_API_KEY: " lin_api_read " }).sameKey && !want({ LINEAR_COMMENT_API_KEY: "lin_api_c" }).sameKey, "the read key used to comment is warned of");
  ok(passCode(0, 0) === 0 && passCode(2, 0) === 1 && passCode(0, 1) === 1, "a pass fails when the sync or the step did");
  ok(JSON.stringify([...boardOf(["SMD-1", "SMD-2", "SMD-3"], ["SMD-2", "SMD-9"])]) === JSON.stringify(["SMD-1", "SMD-3"]), "the step's board is the census less what the pass could not sync");
  const both = withoutFindingTerms(resolveEgressPolicy({ OB1_EGRESS_ALLOW: "type:board-finding,source:BOARD-FINDINGS,actor:board-sync" }));
  ok(both.allow.map((t) => `${t.unit}:${t.value}`).join() === "actor:board-sync", "the findings' own terms are set aside when the sync judges its own calls; any other term stays");
  ok(egressRefusal({ base: "https://api.example", local: false }, withoutFindingTerms(resolveEgressPolicy({ OB1_EGRESS_ALLOW: "type:board-finding" }))) !== null,
    "so type:board-finding alone leaves board-sync's embeds refused up front, as they were before it was set");
}

console.log(`test-board-findings: ${pass} passed, ${fail} failed`);
if (fail) { console.error("FAIL"); process.exit(1); }
console.log("PASS");
