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
 * the one-outcome-per-pair summary; and what became of a finding posted
 * (SMD-2682): each outcome, its precedence, the window, the rate's terms and
 * the report's line. The database and the stub Linear endpoint
 * are test-live.ts [41]; the census board-sync hands over, its self-check.
 */

import { resolveEgressPolicy } from "../server-portable/egress.ts";
import { acceptance, FINDING_OUTCOMES_SQL, findingOutcome, findingsValue, type FindingRow } from "../server-portable/brain-info.ts";
import { PASS_SETTLED_PREFIX } from "../server-portable/consolidate.ts";
import { egressRefusal } from "./worker-bootstrap.ts";
import {
  commentBody, DEFAULT_CAP, findingGate, findingLine, findingLines, FINDING_UNITS, findingSubject, groupFindings, groupWords,
  boardOf, emptyReport, findingsWanted, reportLine, withoutFindingTerms, markerLine, markerWords, onlyWords, outcomes, passCode, readCap, summaryLine, type Finding, type FindingsReport,
} from "./board-findings.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); }
}

const f = (o: Partial<Finding> & Pick<Finding, "id" | "older" | "newer">): Finding => {
  const [a, b] = o.older < o.newer ? [o.older, o.newer] : [o.newer, o.older];
  return { kind: "relation", word: "related", verdict: null, confidence: null, reason: null, at: "2026-10-01T00:00:00.000Z", a, b, olderClosed: false, newerClosed: false, ...o };
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
  // SMD-2932: a closed newer ticket with an open older one: the comment goes on the open one; otherwise the newer.
  const on = (o: Partial<Finding>) => groupFindings([f({ id: "c", older: "SMD-1", newer: "SMD-2", ...o })])[0].on;
  ok(on({}) === "SMD-2" && on({ newerClosed: true }) === "SMD-1" && on({ olderClosed: true }) === "SMD-2" && on({ newerClosed: true, olderClosed: true }) === "SMD-2",
    "the comment goes on the newer ticket, but on the older when only the newer is closed");
  const mixed = groupFindings([f({ id: "m1", older: "SMD-1", newer: "SMD-2", confidence: 0.9, newerClosed: true }), f({ id: "m2", older: "SMD-2", newer: "SMD-1", confidence: 0.5, olderClosed: true })])[0];
  ok(mixed.on === "SMD-1", `…read on the pair's best finding (${mixed.on})`);
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

  // SMD-2930: the judge relates rows, and a ticket's sections are rows of their own — one relation, one bullet.
  const rows = groupFindings([
    f({ id: "r1", older: "SMD-1", newer: "SMD-2", confidence: 0.84 }), f({ id: "r2", older: "SMD-1", newer: "SMD-2", confidence: 0.99 }),
    f({ id: "r3", older: "SMD-2", newer: "SMD-1", confidence: 0.93 }), f({ id: "r4", older: "SMD-1", newer: "SMD-2", confidence: 0.97 }),
    f({ id: "e1", word: "evolves", older: "SMD-1", newer: "SMD-2", confidence: 0.7 }), f({ id: "e2", word: "evolves", older: "SMD-2", newer: "SMD-1", confidence: 0.6 }),
    f({ id: "e3", word: "evolves", older: "SMD-1", newer: "SMD-2", confidence: 0.5 }),
    p, { ...p, id: "p2", confidence: 0.6 },
  ])[0];
  const bullets = findingLines(rows);
  const heads = bullets.map((b) => /^- \*\*([^*]+)\*\*( \([^)]*\))?/.exec(b)?.slice(1).join("") ?? b);
  ok(JSON.stringify(heads) === JSON.stringify([
      "SMD-2 is related to SMD-1 (confidence 0.99, best of 4 row pairs)",
      "SMD-2 outdates SMD-1 (confidence 0.83)",
      "SMD-2 evolves from SMD-1 (confidence 0.70, best of 3 row pairs, 1 the other way)",
      "SMD-2 outdates SMD-1 (confidence 0.60)",
    ]),
    `each relation word is one bullet, in its best finding's direction, at its rank: related either way round, evolves noting the row pair read the other way; each proposal its own, in rank order (${heads.join(" / ")})`);
  const rowsBody = commentBody(rows);
  const dup = findingLines({ findings: groupFindings([
    f({ id: "d1", word: "duplicate", older: "SMD-1", newer: "SMD-2", confidence: 0.9 }), f({ id: "d2", word: "duplicate", older: "SMD-2", newer: "SMD-1", confidence: 0.5 }),
  ])[0].findings });
  ok(rowsBody.split("\n").filter((l) => l.startsWith("- ")).length === 4 && rowsBody.endsWith("ob1-finding SMD-1 SMD-2 related outdates evolves")
      && rows.findings.length === 9 && JSON.stringify(findingLines({ findings: [f({ id: "x", older: "SMD-1", newer: "SMD-2", confidence: null }), f({ id: "y", older: "SMD-1", newer: "SMD-2", confidence: null })] })) === JSON.stringify(["- **SMD-2 is related to SMD-1** (2 row pairs). If so, link them as related here; board-sync brings the link back on its next pass and the brain stops pairing them."])
      && dup.length === 1 && /^- \*\*SMD-2 duplicates SMD-1\*\* \(confidence 0\.90, best of 2 row pairs, 1 the other way\)\./.test(dup[0]),
    "the comment carries the collapsed bullets and the same marker; the group still names every finding, which the record keeps; with no confidence, just the count; a duplicate read both ways is one bullet saying so");
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

// ---------------------------------------------------------------------------
// What became of a finding posted (SMD-2682): findingOutcome's table, first match wins.
// ---------------------------------------------------------------------------
{
  const D = 86_400;
  const prop = (o: Partial<NonNullable<FindingRow["proposals"]>> = {}) => ({ accepted: 0, rejected: 0, settled: 0, reopened: 0, stale: 0, pending: 0, acceptedS: null, rejectedS: null, ...o });
  const row = (o: Partial<FindingRow>): FindingRow => ({ a: "SMD-1", b: "SMD-2", word: "related", postedOn: "SMD-2", origin: "posted", postedAt: "2026-10-01T00:00:00.000Z", ageS: 5 * D, linkedS: null, proposals: null, stands: true, withdrawnS: null, ...o });
  const out = (o: Partial<FindingRow>, days?: number) => { const v = findingOutcome(row(o), days); return `${v.outcome}/${v.how}/${v.answeredS}`; };
  const outd = (p: Partial<NonNullable<FindingRow["proposals"]>>, o: Partial<FindingRow> = {}) => out({ word: "outdates", stands: null, proposals: prop(p), ...o });
  ok(outd({ accepted: 1, acceptedS: D }) === `accepted/proposal/${D}` && outd({ accepted: 1, pending: 1, acceptedS: D }, { linkedS: 3 * D }) === `accepted/proposal/${D}`,
    "an accepted proposal is accepted through the proposal, before a link and beside one still pending");
  ok(outd({ rejected: 1, rejectedS: 2 * D }) === `rejected/proposal/${2 * D}` && outd({ rejected: 2, rejectedS: 2 * D }, { linkedS: D }) === `rejected/proposal/${2 * D}`,
    "none pending and one rejected is rejected, a link on the board since notwithstanding");
  ok(outd({ rejected: 1, stale: 1 }) === "open/null/null" && outd({ rejected: 1, stale: 1 }, { ageS: 31 * D }) === "unanswered/null/null" && outd({ rejected: 1, stale: 1 }, { linkedS: D }) === `accepted/linked/${D}`,
    "a rejection beside a stale proposal waiting on its re-judge is not yet an answer (review pass 1)");
  ok(outd({ rejected: 1, pending: 1 }) === "open/null/null" && outd({ rejected: 1, pending: 1 }, { linkedS: D }) === `accepted/linked/${D}`,
    "a rejection beside a pending proposal is not yet an answer; the board linking the pair then is");
  ok(outd({ pending: 2 }, { linkedS: 0 }) === "accepted/linked/0" && outd({ stale: 1 }, { linkedS: D }) === `accepted/linked/${D}`, "a pending or stale proposal on a pair the board links is accepted by the link");
  ok(outd({}, { withdrawnS: 3 * D }) === "withdrawn/null/null" && outd({}, { withdrawnS: 31 * D, ageS: 40 * D }) === "unanswered/null/null"
      && outd({}, { withdrawnS: 3 * D, linkedS: 2 * D }) === `accepted/linked/${2 * D}` && outd({ rejected: 1, rejectedS: D }, { withdrawnS: 3 * D }) === `rejected/proposal/${D}`
      && outd({ stale: 1 }) === "open/null/null" && outd({}, { withdrawnS: 3 * D, ageS: 40 * D }) === "withdrawn/null/null",
    "the pass's settle is no reviewer's no: withdrawn within the window, unanswered after it, a link and a person's rejection before it, a stale one never settled since the post still open (review pass 2)");
  ok(outd({ reopened: 1 }, { withdrawnS: 5 * D, ageS: 40 * D }) === "withdrawn/null/null" && outd({ reopened: 1 }, { withdrawnS: 31 * D, ageS: 40 * D }) === "unanswered/null/null"
      && outd({ reopened: 1 }, { withdrawnS: 5 * D, linkedS: 6 * D }) === `accepted/linked/${6 * D}` && outd({ accepted: 1, acceptedS: 9 * D }, { withdrawnS: 5 * D }) === `accepted/proposal/${9 * D}`
      && outd({ reopened: 1 }, { withdrawnS: -60 }) === "withdrawn/null/null",
    "a settle a text move reopened since stays a take-back, withdrawn within the window and unanswered past it; an acceptance or a link still answers; one settled before its comment was posted is withdrawn (SMD-2913)");
  ok(outd({ rejected: 1, rejectedS: 3 * D, reopened: 1 }) === `rejected/proposal/${3 * D}` && outd({ rejected: 1, reopened: 1, stale: 1 }) === "open/null/null",
    "a proposal the pass took back and a text move reopened does not hold off a person's rejection beside it; one waiting on its re-judge does (review pass 2)");
  ok(out({ stands: true, ageS: 40 * D }) === "unanswered/null/null" && out({ stands: true, ageS: 10 * D }) === "open/null/null",
    "a relation the judge says again is its verdict once more: open, then unanswered — not a take-back (review pass 1)");
  ok(outd({}, { ageS: 31 * D }) === "unanswered/null/null" && out({ stands: false, ageS: 31 * D }) === "unanswered/null/null",
    "gone with its thought, no time left: the comment's age decides, past the window unanswered (review pass 2)");
  ok(outd({ stale: 2 }) === "open/null/null" && outd({ stale: 2 }, { ageS: 31 * D }) === "unanswered/null/null" && outd({}) === "withdrawn/null/null",
    "a stale proposal waits on a re-judge or a reviewer, open and then unanswered; only every proposal gone is withdrawn (review pass 1)");
  ok(outd({ pending: 1 }, { ageS: 30 * D }) === "open/null/null" && outd({ pending: 1 }, { ageS: 30 * D + 1 }) === "unanswered/null/null" && outd({ pending: 1 }, { ageS: 15 * D }, ) === "open/null/null",
    "open through the thirtieth day, unanswered after it");
  ok(out({ ageS: 15 * D }, 14) === "unanswered/null/null" && out({ ageS: 15 * D }) === "open/null/null", "the window is the caller's");
  ok(out({ linkedS: 4 * D }) === `accepted/linked/${4 * D}` && out({ linkedS: 4 * D, stands: false }) === `accepted/linked/${4 * D}`, "a relation the board linked is accepted, standing or not");
  ok(out({}) === "open/null/null" && out({ ageS: 31 * D }) === "unanswered/null/null" && out({ stands: false }) === "withdrawn/null/null" && out({ stands: false, ageS: 31 * D, withdrawnS: 30 * D }) === "withdrawn/null/null",
    "a relation standing unlinked is open, then unanswered; one the judge stopped saying within the window is withdrawn");
  ok(out({ stands: false, ageS: 45 * D, withdrawnS: 30 * D + 1 }) === "unanswered/null/null" && out({ stands: false, ageS: 45 * D, withdrawnS: 44 * D }, 50) === "withdrawn/null/null",
    "…and one it stopped saying after the window stays unanswered: the board had the window (review pass 1)");
  ok(outd({ accepted: 1, acceptedS: -5 }) === "accepted/proposal/0", "an answer timed before the post (a clock moved back) is 0, not negative");

  // findingsValue: this brain's rows by outcome, the found apart, comments by (pair, posted_at), the median answer.
  const rows = [
    row({ linkedS: 3 * D }),
    row({ word: "outdates", stands: null, proposals: prop({ accepted: 1, acceptedS: D }) }),
    row({ a: "SMD-3", b: "SMD-4", word: "outdates", stands: null, postedAt: "2026-10-02T00:00:00.000Z", proposals: prop({ rejected: 1, rejectedS: 2 * D }) }),
    row({ a: "SMD-5", b: "SMD-6", ageS: 40 * D }),
    row({ a: "SMD-7", b: "SMD-8", stands: false }),
    row({ a: "SMD-9", b: "SMD-10", origin: "found", linkedS: D }),
  ];
  const v = findingsValue(rows);
  ok(JSON.stringify(v) === JSON.stringify({ posted: 5, comments: 4, found: 1, accepted: 2, rejected: 1, withdrawn: 1, open: 0, unanswered: 1, windowDays: 30, medianAnswerS: 2 * D }),
    `the record counts this brain's rows by outcome, two words in one comment as one comment, a found row only as found (${JSON.stringify(v)})`);
  ok(JSON.stringify(acceptance(v)) === JSON.stringify({ accepted: 2, counted: 4 }), "the rate is accepted over accepted, rejected and unanswered — withdrawn and open are left out");
  ok(findingsValue(rows.slice(0, 2)).medianAnswerS === 2 * D && findingsValue([]).medianAnswerS === null, "an even count's median is the mean of the middle two; none answered, null");

  // The settle marker in the read is consolidate.ts's PASS_SETTLED_PREFIX, which brain-info.ts may not import (review pass 4).
  const readText = String((await FINDING_OUTCOMES_SQL(((parts: TemplateStringsArray) => Promise.resolve([parts.join("?")])) as never))[0]);
  const marked = readText.split(`'${PASS_SETTLED_PREFIX}%'`);
  ok(marked.length === 2 && !/settled by/.test(marked.join("")), "the read's settle marker is PASS_SETTLED_PREFIX, once, and no other spelling of it");
  // --report's line: the pair, the word, where and when, and what became of it.
  const lines = [
    reportLine(row({ linkedS: 3 * D, ageS: 12 * D, a: "SMD-12", b: "SMD-40", postedOn: "SMD-40" })),
    reportLine(row({ word: "outdates", stands: null, proposals: prop({ accepted: 1, acceptedS: 2 * D }) })),
    reportLine(row({ word: "outdates", stands: null, proposals: prop({ rejected: 1, rejectedS: null }) })),
    reportLine(row({ word: "outdates", stands: null, proposals: prop({}) })),
    reportLine(row({ word: "outdates", stands: null, proposals: prop({}), withdrawnS: 4 * D })),
    reportLine(row({ word: "outdates", stands: null, proposals: prop({ reopened: 1 }), withdrawnS: 4 * D })),
    reportLine(row({ word: "outdates", stands: null, proposals: prop({ settled: 1 }) })),
    reportLine(row({ word: "outdates", stands: null, proposals: prop({ settled: 1 }), withdrawnS: -600 })),
    reportLine(row({ word: "evolves", stands: false })),
    reportLine(row({ origin: "found" })),
    reportLine(row({ word: "evolves", stands: false, withdrawnS: 2 * D })),
    reportLine(row({ word: "evolves", stands: false, withdrawnS: -3 })),
    reportLine(row({ ageS: 31 * D })),
    reportLine(row({ ageS: 12 * D })),
  ];
  ok(lines.join("\n") === [
    "    SMD-12 ~ SMD-40        related   posted 12 d ago on SMD-40 — accepted: the board linked them 3 d after",
    "    SMD-1 ~ SMD-2          outdates  posted 5 d ago on SMD-2 — accepted: its proposal was accepted 2 d after",
    "    SMD-1 ~ SMD-2          outdates  posted 5 d ago on SMD-2 — rejected: its proposal was rejected",
    "    SMD-1 ~ SMD-2          outdates  posted 5 d ago on SMD-2 — withdrawn: its proposal is gone",
    "    SMD-1 ~ SMD-2          outdates  posted 5 d ago on SMD-2 — withdrawn: the pass settled its proposal 4 d after",
    "    SMD-1 ~ SMD-2          outdates  posted 5 d ago on SMD-2 — withdrawn: the pass settled its proposal 4 d after (reopened since)",
    "    SMD-1 ~ SMD-2          outdates  posted 5 d ago on SMD-2 — withdrawn: the pass settled its proposal",
    "    SMD-1 ~ SMD-2          outdates  posted 5 d ago on SMD-2 — withdrawn: the pass settled its proposal 0 s after",
    "    SMD-1 ~ SMD-2          evolves   posted 5 d ago on SMD-2 — withdrawn: its relation is gone with a thought",
    "    SMD-1 ~ SMD-2          related   posted 5 d ago on SMD-2 — open",
    "    SMD-1 ~ SMD-2          evolves   posted 5 d ago on SMD-2 — withdrawn: the judge stopped saying evolves 2 d after",
    "    SMD-1 ~ SMD-2          evolves   posted 5 d ago on SMD-2 — withdrawn: the judge stopped saying evolves 0 s after",
    "    SMD-1 ~ SMD-2          related   posted 31 d ago on SMD-2 — unanswered: open past 30 d",
    "    SMD-1 ~ SMD-2          related   posted 12 d ago on SMD-2 — open: 18 d before it counts as unanswered",
  ].join("\n"), `--report's lines say each outcome (${lines.join(" / ")})`);
}

console.log(`test-board-findings: ${pass} passed, ${fail} failed`);
if (fail) { console.error("FAIL"); process.exit(1); }
console.log("PASS");
