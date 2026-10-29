#!/usr/bin/env bun
/**
 * ci-step-times.ts — one CI job's time, and its steps', over a window of runs, with the median of each (SMD-3305).
 *
 * The CI-efficiency tickets' Verify reads a job or step "over a week of main's runs" (SMD-3192's children). This
 * reads those runs through `gh` and prints, per run, the job's wall time and each step's that matches; then, over
 * the runs where the job succeeded, each one's median, p90, min and max. A failed or cancelled job is listed, marked,
 * and left out of the figures: its steps stop early. A skipped step is left out too: it starts and ends at once, and
 * would read 0 s. A run `gh` cannot read is tried three times, then said and passed over (see --shift below).
 *
 *   bun scripts/ci-step-times.ts --job "Portable server"
 *   bun scripts/ci-step-times.ts --job "Portable server" --step "REST core" --days 14
 *   bun scripts/ci-step-times.ts --job "Portable server" --runs 40150766871,40059346321
 *   bun scripts/ci-step-times.ts --shift              # every job and step on main that got slower (SMD-3467)
 *   bun scripts/ci-step-times.ts --self-check         # the parsing, the figures and the shifts, on fixtures
 *
 * --shift reads every job and step of main's push runs instead, each a series over the runs where its job succeeded,
 * and names a shift: all of a series' last 3 runs over its line, the median of the 10 before them plus max(30 s,
 * 20%). A step under 5 s cannot get there without taking 30 s more, so every step is read.
 *
 * A series is armed by 3 runs under its line, and starts so only if 3 in a row of its first 10 are: so a shift is
 * named once, at the run that makes it, and not again until the series has been back under for 3 runs. A step slow
 * every other run is never armed, and a slowdown on top of it goes unnamed. A series whose job or step is in the
 * window's first run, in any state (a step's job there with no steps listed counts), names nothing at its first
 * check, which may be a shift named before the window opened; so a window is at least 20 runs (SHIFT says why).
 *
 * It says where a shift landed: from the run before the first of the 10 over the line with at
 * least half the runs from it on over it too, to the first of the 3, and the pull requests merged there. A step that
 * slows only some of the time leaves runs under the line after its cause; a lone spike among the 10 stretches it
 * only from the last two.
 *
 * Each shift made at the newest run read (or --through's) is a `::warning` (past GitHub's 10 a step, nine and one
 * counting the rest), and a table in $GITHUB_STEP_SUMMARY when that is set; the earlier ones are listed as the window
 * reads them. A run not read, or being re-run, among the window's newest 26 fails it after the report (a warning may
 * have moved); an older one is a warning. .github/workflows/ci-shift.yml runs it after each Fork Checks run on main.
 *
 * Options:
 *   --job <name>          the job, by its exact name (required unless --shift or --self-check)
 *   --step <regex>        steps whose name matches, case-insensitive; default every step of a second or more in
 *                         some run (chosen by name across the runs, so each reads every run it ran in; a step's name
 *                         is taken to be unique in its job, as GitHub's are today)
 *   --workflow <name>     default "Fork Checks"
 *   --branch <name>       default main
 *   --days <n>            runs created in the last n × 24 hours, default 7, at most 400 (GitHub keeps a run 400 days)
 *   --last <n>            the newest n completed runs instead, at most 500; with --shift the newest n up to the
 *                         newest completed, a run being re-run among them as a gap, the default 40 and at least 20
 *   --runs <id,id,…>      these runs instead of a window, each read once, oldest first by id (with --branch, --days,
 *                         --last, --workflow or --through refused: they would be ignored)
 *   --shift               the shifts, above (with --job or --step refused: it reads them all); push runs only, so a
 *                         fork's pull request from a branch named main is not read as main (with --runs, the runs
 *                         named, whatever their event)
 *   --through <run id>    with --shift, the window ends at this run, and its shifts are the warnings; a run being
 *                         re-run is not completed, so nothing is read (exit 0), and its end is read later
 *   --repo <owner/name>   default gh's own (the repository of the current directory)
 *
 * Exits 0 with the report, warnings or none; 1 when `gh` is missing or cannot list the runs, there are none, none can
 * be read, --through's run is not among them, or no run read has the job (the job names the runs do have are
 * listed), and with --shift when fewer than 20 runs are left to read, --through's run could not be read, or one of
 * the newest 26 could not or was being re-run (the report still printed); 2 for a refused option. The per-job report
 * reads a re-run's latest attempt, and marks it. Needs `gh` signed in. Reads only; writes nothing but the step
 * summary.
 */

import { appendFileSync } from "node:fs";

const KNOWN: Record<string, "value" | "flag"> = {
  "--job": "value", "--step": "value", "--workflow": "value", "--branch": "value", "--days": "value", "--last": "value", "--runs": "value",
  "--shift": "flag", "--through": "value", "--repo": "value", "--self-check": "flag",
};
type Opts = { error?: string; [name: string]: string | true | undefined };

/** `--name value` or `--name=value`; a flag takes none; anything unknown is refused. */
export function parseArgs(argv: string[]): Opts {
  const out: Opts = {};
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

type Step = { name: string; startedAt?: string | null; completedAt?: string | null; conclusion?: string | null };
type Job = { name: string; conclusion?: string | null; startedAt?: string | null; completedAt?: string | null; steps?: Step[] };
type Run = { jobs: Job[]; headSha: string; createdAt: string; attempt?: number; status?: string };

/** The most runs one `gh run list` returns here; a window that fills it is said to be cut short. */
const LIST_LIMIT = 500;

/** Seconds from one ISO time to another, or null when either is missing or the order is wrong (a step never run). */
export function seconds(from?: string | null, to?: string | null): number | null {
  if (!from || !to) return null;
  const s = (Date.parse(to) - Date.parse(from)) / 1000;
  return Number.isFinite(s) && s >= 0 ? s : null;
}

/** A job's wall time and its steps with their seconds, skipped and unrun steps left out. */
export function jobRow(job: Job): { job: number | null; steps: { name: string; s: number }[] } {
  const steps = (job.steps ?? [])
    .filter((st) => st.conclusion !== "skipped")
    .map((st) => ({ name: st.name, s: seconds(st.startedAt, st.completedAt) }))
    .filter((st): st is { name: string; s: number } => st.s !== null);
  return { job: seconds(job.startedAt, job.completedAt), steps };
}

/**
 * The steps to report, chosen by name across every run read, failed ones included (a failed run shows the step that
 * failed), so each one's figures read every successful run it ran in: those the pattern matches, or with no pattern
 * those that took a second or more in some run.
 */
export function pickSteps(rows: { steps: { name: string; s: number }[] }[], step?: RegExp): Set<string> {
  const longest = new Map<string, number>();
  for (const row of rows) for (const st of row.steps) longest.set(st.name, Math.max(longest.get(st.name) ?? 0, st.s));
  return new Set([...longest].filter(([name, s]) => (step ? step.test(name) : s >= 1)).map(([name]) => name));
}

/**
 * The figures' inputs from the runs read: the steps chosen (from every run with the job, failed ones included, so a
 * failed run shows its steps) and the job's and each chosen step's seconds over the runs where the job succeeded.
 */
export function figures(runs: { job?: Job }[], step?: RegExp): { names: Set<string>; jobTimes: number[]; stepTimes: Map<string, number[]> } {
  const rows = runs.filter((r) => r.job).map((r) => ({ conclusion: r.job!.conclusion, row: jobRow(r.job!) }));
  const names = pickSteps(rows.map((r) => r.row), step);
  const jobTimes: number[] = [];
  const stepTimes = new Map<string, number[]>([...names].map((n) => [n, []]));
  for (const { conclusion, row } of rows) {
    if (conclusion !== "success") continue;
    if (row.job !== null) jobTimes.push(row.job);
    for (const st of row.steps) stepTimes.get(st.name)?.push(st.s);
  }
  return { names, jobTimes, stepTimes };
}

/** The count, median, p90 (nearest rank), min and max of a list of seconds; null for an empty one. */
export function stats(xs: number[]): { n: number; median: number; p90: number; min: number; max: number } | null {
  if (xs.length === 0) return null;
  const a = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  const median = a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  const p90 = a[Math.min(a.length - 1, Math.ceil(0.9 * a.length) - 1)];
  return { n: a.length, median, p90, min: a[0], max: a[a.length - 1] };
}

/**
 * A shift's terms (SMD-3467): the runs before, the runs after, the line's floor and share over the median before, and
 * the fewest runs a window may hold. A window's first 13 can hold a shift named before it opened, so it names none at
 * a series' first check if the series opens it; over main's 500 push runs to 10-29 a window of 20 to 60 runs warns of
 * exactly what the full history does, 15 misses 1, 14 misses 4 and 13 names nothing.
 */
export const SHIFT = { before: 10, after: 3, floor: 30, share: 0.2, window: 20 };

/** One run of a series: the run, its commit and the job's or step's seconds. */
export type Point = { run: string; sha: string; s: number };

/** Each job's and each step's series over the runs, oldest first, a run counted where its job succeeded; a step is `job › step`. */
export function seriesOf(runs: { id: string; jobs: Job[]; headSha: string }[]): Map<string, Point[]> {
  const out = new Map<string, Point[]>();
  const add = (name: string, p: Point) => (out.get(name) ?? out.set(name, []).get(name)!).push(p);
  for (const run of runs) {
    for (const job of run.jobs) {
      if (job.conclusion !== "success") continue;
      const row = jobRow(job);
      if (row.job !== null) add(job.name, { run: run.id, sha: run.headSha, s: row.job });
      for (const st of row.steps) add(`${job.name} › ${st.name}`, { run: run.id, sha: run.headSha, s: st.s });
    }
  }
  return out;
}

/**
 * Index `fired` is the run whose series' last 3 all went over the line, the median of the 10 before them plus
 * max(30 s, 20%); `to` the first of the 3, and `from` the run before where it landed (see landedFrom; -1 when the
 * series starts there), so the commits after `from` up to `to` hold what slowed it.
 */
export type Shift = { fired: number; before: number; line: number; after: number[]; from: number; to: number };

/**
 * Where a shift landed, as the run before it: the first of the 10 runs before the 3 that is over the line with at
 * least half the runs from it up to the 3 over it too. So the range reaches back past runs under the line after a
 * cause that slows a step only some of the time, and not to a lone spike among the 10 unless it is the 9th or 10th
 * (one over of the last two is half).
 */
function landedFrom(points: Point[], start: number, to: number, line: number): number {
  for (let j = start; j < to; j++) {
    if (points[j].s <= line) continue;
    const span = points.slice(j, to);
    if (span.filter((p) => p.s > line).length * 2 >= span.length) return j - 1;
  }
  return to - 1;
}

/**
 * A series' shifts, oldest first. A series is armed by 3 runs all under its line, and a shift disarms it: so each is
 * named once, and again only after 3 runs back under. It starts armed only if 3 runs in a row among its first 10 are
 * under the line its first check draws: a window can open on a step slow only some of the time, which never comes
 * back under for 3 runs, and is not to be named for it; while a new job slowed at its first check (the sleep cell,
 * split out on 10-21 and slowed by SMD-2679 PR 2 its eleventh run) is. Such a step stays unarmed, so a slowdown on
 * top of it goes unnamed too. With `opensWindow` (its job or step is in the window's first run, in any state, so it
 * has history before the window that is not read) its first check names nothing: its 13 runs can hold a shift named
 * before the window opened, and in a window a few runs longer than 13 it would be named again at each.
 */
export function findShifts(points: Point[], opensWindow = false): Shift[] {
  const out: Shift[] = [];
  const k = SHIFT.after, n = SHIFT.before;
  let armed = false;
  if (points.length >= n + k) {
    const first = stats(points.slice(0, n).map((p) => p.s))!.median;
    const line = first + Math.max(SHIFT.floor, SHIFT.share * first);
    for (let j = 0; j + k <= n && !armed; j++) armed = points.slice(j, j + k).every((p) => p.s <= line);
  }
  for (let i = n + k - 1; i < points.length; i++) {
    const start = i + 1 - k - n, to = i + 1 - k;
    const before = stats(points.slice(start, to).map((p) => p.s))!.median;
    const line = before + Math.max(SHIFT.floor, SHIFT.share * before);
    const after = points.slice(to, i + 1).map((p) => p.s);
    if (after.every((s) => s > line)) {
      if (armed && !(opensWindow && i === n + k - 1)) out.push({ fired: i, before, line, after, from: landedFrom(points, start, to, line), to });
      armed = false;
    } else if (after.every((s) => s <= line)) armed = true;
  }
  return out;
}

/** A run as listed: its id, and its state (`completed`, or `in_progress`, `queued` and the like while it runs). */
export type Listed = { id: string; status: string };

/**
 * The window over runs listed oldest first, whatever their state: up to `through`, or without it up to the newest
 * completed run (one running after that is a push not yet done, not the window's), then its newest `last`. A run in it
 * that is not completed is being re-run, and `running` names it: its jobs are not to be read, and its gap counts as
 * an unread run's does. "running" when `through` itself is not completed; undefined when it is not listed. Without
 * `gaps` (the per-job report) the window is over completed runs alone, so `--last n` is n of them.
 */
export function shiftWindow(listed: Listed[], through?: string, last?: number, gaps = true): { ids: string[]; running: string[] } | "running" | undefined {
  if (!gaps) listed = listed.filter((r) => r.status === "completed");
  let end: number;
  if (through !== undefined) {
    end = listed.findIndex((r) => r.id === through);
    if (end < 0) return undefined;
    if (listed[end].status !== "completed") return "running";
  } else end = listed.map((r) => r.status).lastIndexOf("completed");
  const window = last === undefined ? listed.slice(0, end + 1) : listed.slice(0, end + 1).slice(-last);
  return { ids: window.map((r) => r.id), running: window.filter((r) => r.status !== "completed").map((r) => r.id) };
}

/** A shift found in a window: its series, the run that made it and the commits it landed between. */
export type Found = { name: string; sh: Shift; run: string; from?: string; to: string };

/**
 * The runs read, oldest first by creation, their series, and every shift over them, by the run that made it and then
 * name. A series opens the window (findShifts) when its job or step is in the first run, in any state, or, for a
 * step, its job is there with no steps listed.
 */
export function collectShifts(runs: { id: string; run: Run }[]): { ordered: { id: string; run: Run }[]; series: Map<string, Point[]>; found: Found[] } {
  const ordered = [...runs].sort((a, b) => a.run.createdAt.localeCompare(b.run.createdAt) || Number(a.id) - Number(b.id));
  const series = seriesOf(ordered.map(({ id, run }) => ({ id, jobs: run.jobs, headSha: run.headSha })));
  const order = new Map(ordered.map(({ id }, i) => [id, i]));
  // A series opens the window when its job or step is in the window's first run, whatever it did there: one that
  // failed or was cancelled in it has history before the window too. One first seen later is new.
  const firstJobs = ordered[0]?.run.jobs ?? [];
  const opening = new Set(firstJobs.flatMap((j) => [j.name, ...(j.steps ?? []).map((st) => `${j.name} › ${st.name}`)]));
  // A job there with no steps listed (cancelled while queued, or skipped) opens every step series of its own.
  const bare = firstJobs.filter((j) => !(j.steps ?? []).length).map((j) => `${j.name} › `);
  const opens = (name: string) => opening.has(name) || bare.some((prefix) => name.startsWith(prefix));
  const found: Found[] = [];
  for (const [name, points] of series) {
    for (const sh of findShifts(points, opens(name))) found.push({ name, sh, run: points[sh.fired].run, from: sh.from >= 0 ? points[sh.from].sha : undefined, to: points[sh.to].sha });
  }
  found.sort((a, b) => order.get(a.run)! - order.get(b.run)! || a.name.localeCompare(b.name));
  return { ordered, series, found };
}

/** The pull requests a range's commits merged, `#n branch`, from GitHub's merge commits' subjects. */
export function mergedIn(subjects: string[]): string[] {
  return subjects.flatMap((s) => {
    const m = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/.exec(s);
    return m ? [`#${m[1]} ${m[2]}`] : [];
  });
}

/** A workflow command's message, its %, CR and LF escaped as the runner reads them. */
export function escapeCommand(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** A markdown table cell: a | escaped, a line break a space. */
export function tableCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n|\r/g, " ");
}

/**
 * Run ids as named: leading zeros dropped (gh reads 040914574099 as 40914574099), each once, oldest first. Ids grow
 * with creation; they are compared as digit strings, by length and then in order, so a long one is not rounded.
 */
export function runsNamed(named: string[]): string[] {
  const ids = [...new Set(named.map((id) => id.replace(/^0+(?=\d)/, "")))];
  return ids.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
}

/** A whole number written in digits alone, else NaN: Number() would take 0x10, 1e1 and " 20". */
export function whole(v: string | true | undefined): number {
  return typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
}

/** Whether the short list (`last` + 10 runs) holds fewer than `last` runs up to `through`, so the whole list is wanted. */
export function needsWiderList(ids: string[], through: string | undefined, last: number): boolean {
  return through !== undefined && ids.indexOf(through) + 1 < last;
}

/**
 * What the window's gaps mean for the run: a run not read, or being re-run, among its newest 26 (all of a shorter
 * window) can move a warning at its newest run, so the job fails, code 1; an older one is said, code 0. Over main's
 * 461 forty-run windows to 10-29, dropping a run older than the 14th newest moved none, and the 14th moved one.
 * `early` when `through` itself was not read: no shift made there can be named, so there is no report.
 */
export function gapVerdict(ids: string[], unread: string[], running: string[], through?: string): { code: 0 | 1; note: string; early?: true } {
  if (through !== undefined && unread.includes(through)) return { code: 1, note: `run ${through} could not be read, so no shift made there can be named`, early: true };
  const n = Math.min(2 * (SHIFT.before + SHIFT.after), ids.length);
  const newest = new Set(ids.slice(-n));
  const gaps = [...unread.map((id) => `${id} not read`), ...running.map((id) => `${id} being re-run`)];
  const recent = gaps.filter((g) => newest.has(g.split(" ")[0])), older = gaps.filter((g) => !newest.has(g.split(" ")[0]));
  if (recent.length) return { code: 1, note: `${recent.length} of the window's newest ${n} runs could not be read (${recent.join(", ")}): a shift may be missing, or named at another run` };
  if (older.length) return { code: 0, note: `${older.length} older run${older.length === 1 ? "" : "s"} of the window could not be read (${older.join(", ")}); its newest ${n} were` };
  return { code: 0, note: "" };
}

/** GitHub keeps 10 warning annotations a step; past that, 9 and one that counts the rest. */
export const ANNOTATIONS = 10;

/** The `::warning` lines for the shifts made at run `at`, each its text, within GitHub's 10. */
export function warningLines(texts: string[], at: string): string[] {
  const shown = texts.length > ANNOTATIONS ? texts.slice(0, ANNOTATIONS - 1) : texts;
  const lines = shown.map((t) => `::warning title=Slower on main::${escapeCommand(t)}`);
  if (shown.length < texts.length) lines.push(`::warning title=Slower on main::${texts.length - shown.length} more jobs and steps got slower at run ${at}: the step summary (in CI) and this log list them all`);
  return lines;
}

/** What a compare's commits leave out: GitHub lists the newest 250, so a range longer than that says so. */
export function compareNote(total: number | undefined, read: number): string {
  return total !== undefined && total > read ? `; of its ${total} commits the newest ${read} read, so an older pull request may be missing` : "";
}

function refuse(msg: string): never {
  console.error(msg);
  process.exit(2);
}

/** A failure that is not the caller's: gh could not list or read the runs. */
function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/**
 * One `gh` call's JSON, tried three times 3 s apart (GitHub answers a 502 now and then: twice in ~400 calls in the
 * SMD-3467 review); the error's text when all fail. A missing `gh` is refused.
 */
async function gh(args: string[]): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  let error = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await Bun.sleep(3000);
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      fail(`cannot run gh: ${(e as Error).message}`);
    }
    const [out, err, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited]);
    if (code === 0) {
      try {
        return { ok: true, json: JSON.parse(out) };
      } catch (e) {
        error = `gh's answer is not JSON: ${(e as Error).message}`;
        continue;
      }
    }
    error = err.trim();
  }
  return { ok: false, error };
}

/** `f` over `items`, at most `width` at once, the results in the items' order. */
async function pooled<T, R>(items: T[], width: number, f: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]);
    }
  }));
  return out;
}

/** Seconds to a tenth, for a median that can fall between two runs. */
const sec = (s: number) => `${Math.round(s * 10) / 10} s`;

/**
 * The shifts over the runs read: each one in the window listed (as the window reads them: none in its first 13), and
 * those made at `through` (the newest run read when not named) given as `::warning`s and, where the runner sets
 * $GITHUB_STEP_SUMMARY, a table. `unreadNote` says what was not read, in both.
 */
async function shiftReport(runs: { id: string; run: Run }[], through: string | undefined, repo: string[], unread: number, rerun: number, unreadNote: string): Promise<void> {
  const { ordered, series, found: shifts } = collectShifts(runs);
  const at = through ?? ordered[ordered.length - 1].id;
  const created = new Map(ordered.map(({ id, run }) => [id, run.createdAt]));
  let repoName = repo[1];
  if (!repoName) {
    const got = await gh(["repo", "view", "--json", "nameWithOwner"]);
    repoName = got.ok ? (got.json as { nameWithOwner: string }).nameWithOwner : "";
  }
  const found = shifts.map((f) => ({ ...f, prs: "" }));
  // The pull requests in each range, one compare a range; a range gh cannot read is said, not fatal.
  await pooled(found, 6, async (f) => {
    if (!f.from) return void (f.prs = "the series starts there: a new or renamed job or step, or the window's first run");
    if (!repoName) return void (f.prs = "the repository could not be named, so its pull requests were not read");
    const got = await gh(["api", `repos/${repoName}/compare/${f.from}...${f.to}`]);
    if (!got.ok) return void (f.prs = `its pull requests could not be read: ${got.error.split("\n")[0].slice(0, 120)}`);
    const { commits = [], total_commits: total } = got.json as { commits?: { commit: { message: string } }[]; total_commits?: number };
    const prs = mergedIn(commits.map((c) => c.commit.message.split("\n")[0]));
    f.prs = (prs.length ? prs.join(", ") : `${commits.length} commit${commits.length === 1 ? "" : "s"}, no pull request merged`) + compareNote(total, commits.length);
  });
  const text = (f: (typeof found)[number]) =>
    `${f.name}: ${sec(f.sh.before)} → ${f.sh.after.join(", ")} s over the last ${SHIFT.after} runs, its line ${sec(f.sh.line)}; landed in ${f.from ? `${f.from.slice(0, 8)}..` : "..."}${f.to.slice(0, 8)} (${f.prs})`;
  const gapCount = [unread ? `${unread} not read` : "", rerun ? `${rerun} being re-run` : ""].filter(Boolean).join(", ");
  console.log(`\n${series.size} series over ${ordered.length} runs${gapCount ? ` (${gapCount})` : ""}; a line is the median of a series' ${SHIFT.before} runs before its last ${SHIFT.after}, plus max(${SHIFT.floor} s, ${SHIFT.share * 100}%).`);
  console.log(`Shifts in the window, as it reads them: ${found.length}`);
  for (const f of found) console.log(`  ${created.get(f.run)!.slice(0, 16)} run ${f.run}  ${text(f)}`);
  const now = found.filter((f) => f.run === at);
  console.log(now.length ? `\n${now.length} made at run ${at}:` : `\nNone made at run ${at}.`);
  for (const line of warningLines(now.map(text), at)) console.log(line);
  const summary = process.env.GITHUB_STEP_SUMMARY?.trim();
  if (!summary) return;
  const cell = tableCell;
  const range = (f: (typeof found)[number]) =>
    f.from && repoName ? `[${f.from.slice(0, 8)}..${f.to.slice(0, 8)}](https://github.com/${repoName}/compare/${f.from}...${f.to})` : `..${f.to.slice(0, 8)}`;
  const md = now.length
    ? [
      `### A job or step on main got slower at run ${at}`, "",
      `| Job or step | Before | Last ${SHIFT.after} runs | Line | Landed in |`, "|---|---|---|---|---|",
      ...now.map((f) => `| ${cell(f.name)} | ${sec(f.sh.before)} | ${f.sh.after.join(", ")} s | ${sec(f.sh.line)} | ${range(f)}: ${cell(f.prs)} |`), "",
      `Before: the median of the ${SHIFT.before} runs before the last ${SHIFT.after}; the line, that plus max(${SHIFT.floor} s, ${SHIFT.share * 100}%). Landed in: from the run before the first of the ${SHIFT.before} over the line with at least half the runs from it on over it too, to the first of the last ${SHIFT.after}.`,
    ]
    : [`No job or step on main got slower at run ${at} (${series.size} series over ${ordered.length} runs).`];
  if (unreadNote) md.push("", `**${unreadNote}**`);
  // The summary is the warnings again, in a table: one that cannot be written is said, and the run stands.
  try {
    appendFileSync(summary, md.join("\n") + "\n");
  } catch (e) {
    console.error(`the step summary ${summary} could not be written: ${(e as Error).message}`);
  }
}

function selfCheck(): number {
  let failed = 0;
  const ok = (cond: boolean, what: string) => {
    if (!cond) failed++;
    console.log(`  ${cond ? "✓" : "✗"} ${what}`);
  };
  ok(parseArgs(["--job", "Portable server", "--days=14"])["--job"] === "Portable server" && parseArgs(["--days=14"])["--days"] === "14", "values by space and by =");
  ok(!!parseArgs(["--jobs", "x"]).error && !!parseArgs(["--job"]).error && !!parseArgs(["--self-check=1"]).error, "an unknown option, a missing value and a flag with a value are refused");
  ok(seconds("2026-10-24T03:41:45Z", "2026-10-24T03:45:12Z") === 207, "seconds between two times");
  ok(seconds(null, "2026-10-24T03:45:12Z") === null && seconds("2026-10-24T03:45:12Z", "2026-10-24T03:41:45Z") === null, "a missing time, or one before the other, is null");
  const at = (s: number) => new Date(Date.UTC(2026, 9, 24) + s * 1000).toISOString();
  const run = (setUp: number) => jobRow({
    name: "Portable server", startedAt: at(0), completedAt: at(207), steps: [
      { name: "Set up job", startedAt: at(0), completedAt: at(setUp) },
      { name: "The REST core's routes and authorization", startedAt: at(60), completedAt: at(76) },
      { name: "Exactly a second", startedAt: at(76), completedAt: at(77) },
      { name: "Sometimes", conclusion: "skipped", startedAt: at(77), completedAt: at(77) },
      { name: "Never ran", startedAt: null, completedAt: null },
    ],
  });
  const rows = [run(0), run(2)];
  ok(rows[0].job === 207 && rows[0].steps.map((s) => s.name).join() === "Set up job,The REST core's routes and authorization,Exactly a second", "a job's time and its steps, the skipped and the unrun left out");
  const picked = pickSteps(rows);
  ok(picked.has("Set up job") && picked.has("Exactly a second") && !picked.has("Sometimes"), "no pattern: steps of a second or more in some run, chosen by name — so a step under a second in one run still reads that run");
  ok([...pickSteps(rows, /rest core/i)].join() === "The REST core's routes and authorization", "a pattern picks its steps by name, case-insensitive");
  const failedRun: Job = { name: "j", conclusion: "failure", startedAt: at(0), completedAt: at(30), steps: [{ name: "The step that failed", startedAt: at(0), completedAt: at(4) }] };
  const goodRun: Job = { name: "j", conclusion: "success", startedAt: at(0), completedAt: at(20), steps: [{ name: "Build", startedAt: at(0), completedAt: at(5) }] };
  const f = figures([{ job: failedRun }, { job: goodRun }, {}]);
  ok(f.names.has("The step that failed") && f.stepTimes.get("The step that failed")!.length === 0 && f.jobTimes.join() === "20" && f.stepTimes.get("Build")!.join() === "5",
    "a failed run's step is chosen, so the run shows it, and counted in no figure; the job's time over the successful run alone");
  const odd = stats([43, 16, 44]), even = stats([16, 17, 18, 44]);
  ok(odd?.median === 43 && odd.min === 16 && odd.max === 44 && even?.median === 17.5, "the median of an odd and an even list");
  const ten = stats(Array.from({ length: 10 }, (_, i) => i + 1)), eleven = stats(Array.from({ length: 11 }, (_, i) => i + 1));
  ok(ten?.p90 === 9 && eleven?.p90 === 10 && stats([]) === null, "p90 by nearest rank, at 10 runs and at 11; no runs, no figures");

  // The shifts (SMD-3467), first on main's own runs of 10-26 → 10-28, each `sha seconds`, from the 2026-10-28 review.
  ok(parseArgs(["--shift", "--through", "41"])["--shift"] === true && parseArgs(["--through=41"])["--through"] === "41", "--shift is a flag and --through takes a run");
  const points = (spec: string): Point[] => spec.split(",").map((x, i) => ({ run: String(i), sha: x.split(" ")[0], s: Number(x.split(" ")[1]) }));
  const flat = (...parts: [number, number][]) => points(parts.flatMap(([s, n]) => Array.from({ length: n }, () => `x ${s}`)).join(","));
  // SMD-2679 PR 4b (2b46a488) took the sleep cell from ~196 s to ~270 s.
  const sleep = points("4bf23b45 198,ea4f9300 198,bbb4356d 196,b74f5653 196,90721887 205,6c1a7c7e 197,1c112152 197,5e718231 195,60605f3f 194,7a2feeaa 193,"
    + "fb9a270e 195,df9968fe 196,5863647c 191,8a0f40e7 197,2b46a488 268,bcc60003 269,f3267523 280,330f9ad5 273,cf3fa56d 275");
  const [s1, ...sMore] = findShifts(sleep);
  ok(sMore.length === 0 && sleep[s1?.fired]?.sha === "f3267523" && sleep[s1.to].sha === "2b46a488" && sleep[s1.from].sha === "8a0f40e7" && s1.before === 195.5 && s1.after.join() === "268,269,280",
    "SMD-2679 PR 4b's sleep cell: named once, at the third run over, landed in 8a0f40e7..2b46a488, the merge itself");
  // SMD-3155 (330f9ad5) left board-sync's stop slow only some of the time: two runs back under the line after it.
  const canary = points("eed85bb3 117,0fc12274 121,67614742 91,e05d4578 115,cb733385 96,7c80fa87 114,4cd99dfd 114,4bf23b45 102,ea4f9300 114,bbb4356d 112,"
    + "b74f5653 115,90721887 119,6c1a7c7e 88,1c112152 124,5e718231 114,60605f3f 120,7a2feeaa 111,fb9a270e 113,df9968fe 113,5863647c 114,8a0f40e7 100,2b46a488 117,"
    + "bcc60003 103,f3267523 101,330f9ad5 155,cf3fa56d 121,08df80e9 150,b3f50fdd 123,b7e784c7 153,32424f81 155,211aaa6f 164,4cff34d3 152,ef5c5151 145");
  const [c1, ...cMore] = findShifts(canary);
  ok(cMore.length === 0 && canary[c1?.fired]?.sha === "211aaa6f" && canary[c1.to].sha === "b7e784c7" && canary[c1.from].sha === "f3267523" && c1.before === 115.5,
    "SMD-3155's canary step: named at 211aaa6f, its range f3267523..b7e784c7 reaching back past the runs under the line to 330f9ad5");
  ok(findShifts(flat([100, 13], [200, 1], [100, 3])).length === 0 && findShifts(flat([100, 13], [200, 2], [100, 2])).length === 0,
    "a one-run spike, and a two-run one, are no shift");
  ok(findShifts(flat([10, 13], [40, 3])).length === 0 && findShifts(flat([10, 13], [41, 3])).length === 1 && findShifts(flat([200, 13], [241, 3])).length === 1 && findShifts(flat([200, 13], [240, 3])).length === 0,
    "the line is max(30 s, 20%) over the median, and a run on it is not over it: 10 s → 40 s, 200 s → 240 s");
  const twice = findShifts(flat([100, 13], [200, 10], [300, 3]));
  ok(twice.length === 2 && twice[0].fired === 15 && twice[1].fired === 25 && findShifts(flat([100, 9], [200, 3])).length === 0,
    "a series back under its line for 3 runs can shift again; fewer than 13 runs, none");
  ok(findShifts(flat([100, 13], [200, 3], [100, 1], [200, 3])).length === 1 && findShifts(flat([100, 13], [200, 3], [100, 2], [200, 3])).length === 1,
    "one or two runs back under the line do not re-arm it: the same slowdown is not named again");
  ok(findShifts(points(Array.from({ length: 40 }, (_, i) => `x ${i % 2 ? 100 : 400}`).concat(["x 500", "x 500", "x 500"]).join(","))).length === 0,
    "a series never 3 runs under its line in the window is never armed: a window opening on a step slow every other run names nothing");
  // The sleep cell as a new job: split out on 10-21, slowed by SMD-2679 PR 2 (fbedb39c) at its eleventh run.
  const newJob = points("a6ce641c 126,9ce3fd81 126,b0f8b2c7 130,efd8941a 129,c4a3577f 132,7b983289 131,ef5e43dc 128,66bd73f3 129,3c2575c7 129,b40c4d12 131,"
    + "fbedb39c 161,6115b1d8 160,a7bc2867 167");
  const [n1] = findShifts(newJob);
  ok(newJob[n1?.fired]?.sha === "a7bc2867" && newJob[n1.to].sha === "fbedb39c" && newJob[n1.from].sha === "b40c4d12",
    "a new job slowed at its first check is named there: its first 10 runs, under the line, arm it");
  const spikeFar = findShifts(flat([100, 1], [400, 1], [100, 13], [200, 3]))[0], spikeNear = findShifts(flat([100, 3], [400, 1], [100, 9], [200, 3]))[0];
  const longAgo = findShifts(flat([300, 13], [100, 13], [200, 3]))[0];
  ok(spikeFar?.from === 14 && spikeNear?.from === 12 && spikeNear.to === 13 && longAgo?.from === 25,
    "a lone spike among the 10, or anything before the 13, does not stretch where the shift landed");
  const sRuns = seriesOf([
    { id: "1", headSha: "a", jobs: [goodRun, failedRun, { ...goodRun, name: "k", steps: [{ name: "Sometimes", conclusion: "skipped", startedAt: at(0), completedAt: at(0) }] }] },
    { id: "2", headSha: "b", jobs: [goodRun] },
  ]);
  ok([...sRuns.keys()].join(";") === "j;j › Build;k" && sRuns.get("j › Build")!.map((p) => `${p.run}${p.sha}${p.s}`).join() === "1a5,2b5",
    "a series a job, and a step as `job › step`, over the runs where the job succeeded, a skipped step left out");
  ok(mergedIn(["Merge pull request #546 from MHarris-SgyMd/michaelharris/smd-3155-canary-up-in-place", "[fork] Merge origin/main (6c6e7d39) into SMD-3466", "Revert \"Merge pull request #9 from a/b\"", "Fix"]).join() === "#546 michaelharris/smd-3155-canary-up-in-place",
    "a range's pull requests from GitHub's merge subjects, a branch's own merges of main and a revert left out");
  ok(escapeCommand("50% of\r\nit") === "50%25 of%0D%0Ait", "a warning's %, CR and LF escaped");
  const five = ["1", "2", "3", "4", "5"];
  // Runs 1–5 done, 3 being re-run, and 6 a push still going.
  // Runs 1–5, 2 waiting to be re-run and 3 being re-run, and 6 a push still queued.
  const listedRuns: Listed[] = [...five.map((id) => ({ id, status: id === "2" ? "queued" : id === "3" ? "in_progress" : "completed" })), { id: "6", status: "queued" }];
  const cut = (through?: string, last?: number, gaps = true) => { const w = shiftWindow(listedRuns, through, last, gaps); return typeof w === "object" ? `${w.ids.join()}/${w.running.join()}` : w; };
  ok(cut("5", 3) === "3,4,5/3" && cut() === "1,2,3,4,5/2,3" && cut(undefined, 2) === "4,5/" && cut("6") === "running" && cut("2") === "running" && cut("9") === undefined
    && cut(undefined, 3, false) === "1,4,5/",
    "the window: cut at --through or the newest completed run, then its newest --last; a run queued or running for a re-run in it named; --through not completed, or not listed; the per-job report's --last n is n completed runs");
  ok(runsNamed(["40914574099", "040914574099", "9", "123456789012345678901", "10", "0"]).join() === "0,9,10,40914574099,123456789012345678901",
    "run ids named: leading zeros dropped, each once, oldest first, a long one not rounded");
  // collectShifts over runs given out of order, as --runs takes them: 13 at 100 s and 3 at 200 s, by creation time.
  const runOf = (i: number, s: number, conclusion = "success", step = false): { id: string; run: Run } =>
    ({ id: String(500 - i), run: { headSha: `c${i}`, createdAt: at(i * 3600), jobs: [{ name: "j", conclusion, startedAt: at(0), completedAt: at(s), steps: step ? [{ name: "s", startedAt: at(0), completedAt: at(s) }] : [] }] } });
  const shuffled = Array.from({ length: 16 }, (_, i) => runOf(i, i < 13 ? 100 : 200)).reverse();
  shuffled.push(runOf(16, 999, "failure"));
  const got = collectShifts(shuffled);
  ok(got.ordered[0].id === "500" && got.found.length === 1 && got.found[0].run === "485" && got.found[0].to === "c13" && got.found[0].from === "c12" && got.series.get("j")!.length === 16,
    "the runs ordered by creation, not as given, and the shift named at the run that made it; a failed job's run not counted");

  // Review pass 2: a series opening the window, the first arm's terms, the range's edges, and the main path's helpers.
  // Schema's live suite from the backtest's first run: slowed at f403293d (SMD-2905's PR), named at its third check.
  const liveSuite = points("e4b36606 178,2b56713e 158,2f571fe7 164,5901152d 159,6e924223 167,d8b81b80 152,312fb93e 133,b1f8ee60 162,e40e2f77 200,"
    + "1f3bd812 134,38ac7537 137,78899cb9 135,f403293d 199,4c1fa373 209,813c3226 211");
  const [l1, ...lMore] = findShifts(liveSuite, true);
  ok(lMore.length === 0 && liveSuite[l1?.fired]?.sha === "813c3226" && liveSuite[l1.to].sha === "f403293d" && liveSuite[l1.from].sha === "78899cb9",
    "Schema's live suite, opening the backtest: armed by its first 10, named at 813c3226, landed in 78899cb9..f403293d");
  ok(findShifts(flat([100, 10], [200, 3]), true).length === 0 && findShifts(flat([100, 10], [200, 3])).length === 1 && findShifts(flat([100, 11], [200, 3]), true)[0]?.fired === 13,
    "a series opening the window names nothing at its first check (it may be a shift named before), and can at its second; a new one does at its first");
  const onLine = findShifts(flat([100, 13], [200, 3], [130, 3], [300, 3]));
  ok(onLine.map((x) => x.fired).join() === "15,21", "3 runs on the line re-arm it, as 3 under do");
  // In a window: job j from its first run, slowed at its first check; job k added at the fourth run, slowed at its own.
  const added = collectShifts(Array.from({ length: 16 }, (_, i) => {
    const r = runOf(i, i < 10 ? 100 : 200, "success", true);
    if (i >= 3) r.run.jobs.push({ name: "k", conclusion: "success", startedAt: at(0), completedAt: at(i < 13 ? 100 : 200), steps: [] });
    return r;
  }));
  ok(added.found.map((f) => `${f.name}@${f.run}`).join() === "k@485",
    "in a window, the job opening it, and its step, are not named at their first check; one added later is, as a new job");
  // Job j cancelled while queued in the window's first run (no steps listed), then 10 runs at 100 s and 3 at 200 s.
  const cancelledFirst = collectShifts(Array.from({ length: 14 }, (_, i) => runOf(i, i <= 10 ? 100 : 200, i === 0 ? "cancelled" : "success", i > 0)).reverse());
  ok(cancelledFirst.found.length === 0 && cancelledFirst.series.get("j")!.length === 13 && cancelledFirst.series.get("j › s")!.length === 13,
    "a job cancelled in the window's first run, with no steps listed there, still opens it and its steps, given in any order: their first check names nothing");
  ok(SHIFT.window === 20, "a window is at least 20 runs: 20 to 60 warn as the full history does over main's 500 push runs, 15 misses 1");
  const firstTen = (spec: number[]) => findShifts(points(spec.concat([200, 200, 200]).map((s) => `x ${s}`).join(","))).length;
  ok(firstTen([140, 100, 100, 140, 100, 100, 140, 100, 100, 100]) === 1 && firstTen([100, 100, 100, 140, 100, 100, 140, 100, 100, 140]) === 1 && firstTen([100, 100, 140, 100, 100, 140, 100, 100, 140, 100]) === 0
    && firstTen([100, 110, 120, 100, 110, 120, 100, 110, 120, 100]) === 1 && firstTen([100, 100, 130, 100, 100, 130, 100, 100, 130, 130]) === 1,
    "the first arm: 3 in a row under, the first 3 or the last 3 of the 10 too; 2 in a row not enough; the line has its margin; a run on it is under");
  ok(findShifts(points([100, 100, 200, 100, 100, 200, 100, 200, 200, 200, 300, 300, 300].map((s) => `x ${s}`).join(","))).length === 0,
    "the first arm's line is drawn over the first 10 runs alone: the 11th, over it, does not raise it to arm the series");
  ok(findShifts(flat([100, 9], [130, 1], [200, 3]))[0]?.from === 9 && findShifts(flat([100, 8], [130, 1], [400, 1], [200, 3]))[0]?.from === 8
    && findShifts(flat([100, 10], [400, 1], [100, 2], [200, 3]))[0]?.from === 12
    && findShifts(flat([100, 11], [400, 1], [100, 1], [200, 3]))[0]?.from === 10 && findShifts(flat([100, 10], [400, 1], [130, 2], [200, 3]))[0]?.from === 12
    && findShifts(points(Array.from({ length: 13 }, () => "x 100").concat(Array.from({ length: 10 }, (_, i) => `x ${i % 2 ? 100 : 300}`), ["x 400", "x 400", "x 400"]).join(",")))[0]?.from === 12,
    "where it landed: a run on the line is not over it, nor counts toward half; a spike third from the end of the 10 does not stretch it, one second from the end does (half of two); the first of the 10 can be it");
  ok(whole("20") === 20 && Number.isNaN(whole("0x10")) && Number.isNaN(whole(" 20")) && Number.isNaN(whole("1e1")) && Number.isNaN(whole(true)),
    "a whole number in digits alone");
  const fifty = Array.from({ length: 50 }, (_, i) => String(i + 1));
  ok(!needsWiderList(fifty, "50", 40) && !needsWiderList(fifty, "40", 40) && needsWiderList(fifty, "39", 40) && needsWiderList(fifty, "x", 40) && !needsWiderList(fifty, undefined, 40),
    "the whole list is read only when the short one holds fewer than --last runs up to --through");
  const forty = fifty.slice(0, 40), twenty = fifty.slice(0, 20);
  const older = gapVerdict(forty, ["14"], []), newer = gapVerdict(forty, ["15"], []), rerun = gapVerdict(forty, [], ["40"]), short = gapVerdict(twenty, ["1"], []);
  ok(older.code === 0 && older.note.includes("14 not read") && newer.code === 1 && rerun.code === 1 && rerun.note.includes("40 being re-run") && short.code === 1 && short.note.includes("newest 20")
    && gapVerdict(forty, ["40"], [], "40").early === true && gapVerdict(forty, [], []).note === "",
    "a gap among the window's newest 26 (all of a shorter one) fails it, a run being re-run too; an older one is said; --through not read, no report");
  const texts = (n: number) => Array.from({ length: n }, (_, i) => `step ${i}`);
  const warn10 = warningLines(texts(10), "7"), warn11 = warningLines(texts(11), "7");
  ok(warn10.length === 10 && warn10[9].endsWith("step 9") && warn11.length === 10 && warn11[9].includes("2 more") && warn11[8].endsWith("step 8"),
    "at most 10 warnings: past 10, nine and one counting the rest");
  ok(compareNote(300, 250).includes("newest 250") && compareNote(28, 28) === "" && compareNote(undefined, 5) === "" && tableCell("a|b\nc\rd") === "a\\|b c d",
    "a compare past GitHub's 250 says the oldest may be missing; a table cell's | and line break");
  console.log(failed ? `${failed} failed` : "all passed");
  return failed ? 1 : 0;
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) refuse(opts.error);
  if (opts["--self-check"]) process.exit(selfCheck());
  const shift = opts["--shift"] === true;
  const jobName = opts["--job"];
  if (shift) {
    for (const f of ["--job", "--step"]) if (opts[f] !== undefined) refuse(`${f} does nothing with --shift: it reads every job and step`);
  } else {
    if (typeof jobName !== "string") refuse("--job <name> is required (the job's exact name, e.g. \"Portable server\")");
    if (opts["--through"] !== undefined) refuse("--through goes with --shift: it names the run whose shifts are the warnings");
  }
  const days = opts["--days"] === undefined ? 7 : whole(opts["--days"]);
  if (!Number.isInteger(days) || days < 1 || days > 400) refuse(`--days takes a whole number from 1 to 400 (GitHub keeps a run 400 days), got ${opts["--days"]}`);
  if (opts["--days"] !== undefined && opts["--last"] !== undefined) refuse("--days and --last are two windows: give one or the other");
  const lastFloor = shift ? SHIFT.window : 1;
  const last = opts["--last"] !== undefined ? whole(opts["--last"]) : shift && opts["--days"] === undefined ? 40 : undefined;
  if (last !== undefined && (!Number.isInteger(last) || last < lastFloor || last > LIST_LIMIT)) {
    refuse(`--last takes a whole number from ${lastFloor} to ${LIST_LIMIT}${shift ? ` (a shift wants a window of ${lastFloor}; see SHIFT)` : ""}, got ${opts["--last"]}`);
  }
  const throughOpt = typeof opts["--through"] === "string" ? opts["--through"] : undefined;
  if (throughOpt !== undefined && !/^\d+$/.test(throughOpt)) refuse(`--through takes a run id, got ${JSON.stringify(throughOpt)}`);
  const through = throughOpt === undefined ? undefined : runsNamed([throughOpt])[0];
  let step: RegExp | undefined;
  try {
    step = typeof opts["--step"] === "string" ? new RegExp(opts["--step"], "i") : undefined;
  } catch (e) {
    refuse(`--step is not a regular expression: ${(e as Error).message}`);
  }
  if (typeof opts["--runs"] === "string") for (const f of ["--branch", "--days", "--last", "--workflow", "--through"]) if (opts[f] !== undefined) refuse(`${f} does nothing with --runs: give one or the other`);
  const repo = typeof opts["--repo"] === "string" ? ["--repo", opts["--repo"]] : [];
  const workflow = String(opts["--workflow"] ?? "Fork Checks"), branch = String(opts["--branch"] ?? "main");
  // A shift reads main's own runs: a fork's pull request from a branch it named main lists as main too.
  const event = shift ? ["--event", "push"] : [];
  const where = `${workflow} on ${branch}${shift ? " (push)" : ""}`;
  let ids: string[] = [];
  let running: string[] = [];
  // Runs listed oldest first whatever their state, for shiftWindow: a run being re-run is in the window, as a gap.
  let listed: Listed[] = [];
  if (typeof opts["--runs"] === "string") {
    const named = opts["--runs"].split(",").map((s) => s.trim()).filter(Boolean);
    if (named.length === 0 || !named.every((id) => /^\d+$/.test(id))) refuse(`--runs takes run ids, comma-separated, got ${JSON.stringify(opts["--runs"])}`);
    // A run named twice would be two points of each of its series; sorted, the ids are oldest first, as a listed
    // window is, whatever order they were named in.
    ids = runsNamed(named);
    console.log(`${ids.length} run${ids.length === 1 ? "" : "s"} named${ids.length < named.length ? ` (${named.length - ids.length} named again, read once)` : ""}`);
  } else if (last !== undefined) {
    const list = async (limit: number) => {
      const got = await gh(["run", "list", ...repo, "--workflow", workflow, "--branch", branch, ...event, "--limit", String(limit), "--json", "databaseId,status"]);
      if (!got.ok) fail(`gh run list failed: ${got.error}`);
      return (got.json as { databaseId: number; status: string }[]).map((r) => ({ id: String(r.databaseId), status: r.status })).reverse();
    };
    // --through names the newest run or near it, as the workflow does; one further back, with fewer than `last` runs
    // up to it in the short list, takes the whole list (~30 s). Runs still going take places in it, so 10 spare.
    listed = await list(Math.min(last + 10, LIST_LIMIT));
    if (needsWiderList(listed.map((r) => r.id), through, last)) listed = await list(LIST_LIMIT);
  } else {
    // gh's --created takes a day; the window is the last n × 24 hours, so a day early is asked and createdAt cut.
    const cutoff = Date.now() - days * 86_400_000;
    const day = new Date(cutoff - 86_400_000).toISOString().slice(0, 10);
    const got = await gh(["run", "list", ...repo, "--workflow", workflow, "--branch", branch, ...event, "--created", `>=${day}`, "--limit", String(LIST_LIMIT), "--json", "databaseId,status,createdAt"]);
    if (!got.ok) fail(`gh run list failed: ${got.error}`);
    const runs = got.json as { databaseId: number; status: string; createdAt: string }[];
    // Cut short only if the oldest run listed is already inside the window: the extra day asked for may fill the limit.
    const oldest = Math.min(...runs.map((r) => Date.parse(r.createdAt)));
    if (runs.length >= LIST_LIMIT && oldest >= cutoff) console.log(`  gh returned its limit of ${LIST_LIMIT} runs, all inside the window: it is cut short; give fewer --days`);
    listed = runs.filter((r) => Date.parse(r.createdAt) >= cutoff).map((r) => ({ id: String(r.databaseId), status: r.status })).reverse();
    console.log(`${where} since ${new Date(cutoff).toISOString().slice(0, 16)}Z: ${listed.filter((r) => r.status === "completed").length} completed runs`);
  }
  if (typeof opts["--runs"] !== "string") {
    // The per-job report reads completed runs alone; with --shift a run being re-run is a gap in the window.
    const window = shiftWindow(listed, through, last, shift);
    if (window === undefined) fail(`run ${through} is not among the ${listed.length} runs of ${where} listed`);
    // A re-run of the run named, started before this listed the runs: its end runs this again.
    if (window === "running") {
      console.log(`run ${through} is not completed (queued, or being re-run): its end runs this again, so nothing is read now`);
      process.exit(0);
    }
    ids = window.ids;
    running = window.running;
    if (ids.length === running.length) fail(`no completed run of ${where}${last === undefined ? ` in the last ${days} days` : ""}: is the branch or workflow named right?`);
    if (last !== undefined || through !== undefined) console.log(`${ids.length}${shift ? "" : " completed"} run${ids.length === 1 ? "" : "s"} of ${where}${through ? ` through ${through}` : ""}${running.length ? `, ${running.length} being re-run` : ""}`);
  }
  // The summary's line for an exit before the report: a red run with an empty summary says nothing.
  const summaryNote = (text: string) => {
    const file = process.env.GITHUB_STEP_SUMMARY?.trim();
    if (!file) return;
    try {
      appendFileSync(file, `**${text}**\n`);
    } catch (e) {
      console.error(`the step summary ${file} could not be written: ${(e as Error).message}`);
    }
  };
  // A window shorter than SHIFT.window misses or repeats shifts: say so rather than "None made".
  if (shift && ids.length < SHIFT.window) {
    summaryNote(`${ids.length} run${ids.length === 1 ? "" : "s"} in the window: a shift wants ${SHIFT.window}, so none is named`);
    fail(`${ids.length} run${ids.length === 1 ? "" : "s"} in the window: a shift wants ${SHIFT.window} (see SHIFT), so none is named`);
  }
  // Six runs read at once: one `gh run view` a run takes about 2 s.
  const viewed = await pooled(ids.filter((id) => !running.includes(id)), 6, async (id) => ({ id, got: await gh(["run", "view", id, ...repo, "--json", "jobs,headSha,createdAt,attempt,status"]) }));
  const read: { id: string; run: Run; job?: Job; row?: ReturnType<typeof jobRow> }[] = [];
  const unreadIds: string[] = [];
  const seen = new Set<string>();
  for (const { id, got } of viewed) {
    if (!got.ok) {
      unreadIds.push(id);
      console.log(`${id}  not read, passed over: ${got.error.split("\n")[0].slice(0, 120)}`);
      continue;
    }
    const run = got.json as Run;
    if (run.status !== undefined && run.status !== "completed") {
      // Re-run since it was listed: its new attempt has nothing to read yet, and it is a gap, as one listed so is.
      running.push(id);
      console.log(`${id}  being re-run since it was listed, passed over`);
      continue;
    }
    for (const j of run.jobs) seen.add(j.name);
    const job = run.jobs.find((j) => j.name === jobName);
    read.push({ id, run, job, row: job ? jobRow(job) : undefined });
  }
  if (ids.length > 0 && read.length === 0) fail(`none of the ${ids.length} runs could be read`);
  const unread = unreadIds.length;
  if (shift) {
    // A run not read, or being re-run, takes a point out of its series and can move a shift off the run that makes
    // it, so a warning could be lost: gapVerdict says which gaps fail the job.
    const verdict = gapVerdict(ids, unreadIds, running, through);
    if (verdict.early) {
      console.log(`::error title=CI shift incomplete::${verdict.note}`);
      summaryNote(verdict.note);
      process.exit(1);
    }
    await shiftReport(read, through, repo, unread, running.length, verdict.note);
    if (verdict.note) console.log(verdict.code ? `::error title=CI shift incomplete::${verdict.note}` : `::warning title=CI shift::${verdict.note}`);
    process.exit(verdict.code);
  }
  if (read.length > 0 && read.every((r) => !r.job)) {
    console.error(`no run read has a job named "${jobName}"; its jobs are named: ${[...seen].sort().join("; ")}`);
    process.exit(1);
  }
  const { names, jobTimes, stepTimes } = figures(read, step);
  if (step && names.size === 0) {
    // Say it, not nothing: a misspelt pattern and a step that is skipped in every run read the same otherwise.
    const skippedOnly = new Set(read.flatMap((r) => (r.job?.steps ?? []).filter((st) => st.conclusion === "skipped" && step!.test(st.name)).map((st) => st.name)));
    console.log(`no step matching ${step} ran in any run read${skippedOnly.size ? `; skipped every time: ${[...skippedOnly].join("; ")}` : ""}`);
  }
  for (const { id, run, job, row } of read) {
    const head = `${id} ${run.headSha.slice(0, 8)} ${run.createdAt.slice(0, 10)}${(run.attempt ?? 1) > 1 ? ` (attempt ${run.attempt})` : ""}`;
    if (!job || !row) {
      console.log(`${head}  no job named "${jobName}"`);
      continue;
    }
    const counted = job.conclusion === "success";
    console.log(`${head}  ${jobName}: ${row.job ?? "?"} s${counted ? "" : `  (${job.conclusion}, not counted)`}`);
    for (const st of row.steps) if (names.has(st.name)) console.log(`    ${String(st.s).padStart(5)} s  ${st.name}`);
  }
  const line = (label: string, xs: number[], none: string) => {
    const f = stats(xs);
    console.log(f ? `  ${label}: median ${f.median} s, p90 ${f.p90} s, min ${f.min} s, max ${f.max} s over ${f.n} runs` : `  ${label}: ${none}`);
  };
  console.log(`\nOver the runs where the job succeeded${unread ? ` (${unread} run${unread === 1 ? "" : "s"} not read)` : ""}:`);
  line(String(jobName), jobTimes, "no successful run");
  for (const [name, xs] of stepTimes) line(name, xs, jobTimes.length ? `ran in none of the ${jobTimes.length} successful runs` : "no successful run");
}
