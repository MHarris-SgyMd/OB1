#!/usr/bin/env bun
/**
 * ci-step-times.ts — one CI job's time, and its steps', over a window of runs, with the median of each (SMD-3305).
 *
 * The CI-efficiency tickets' Verify reads a job or step "over a week of main's runs" (SMD-3192's children). This
 * reads those runs through `gh` and prints, per run, the job's wall time and each step's that matches; then, over
 * the runs where the job succeeded, each one's median, p90, min and max. A failed or cancelled job is listed, marked,
 * and left out of the figures: its steps stop early.
 *
 *   bun scripts/ci-step-times.ts --job "Portable server"
 *   bun scripts/ci-step-times.ts --job "Portable server" --step "REST core" --days 14
 *   bun scripts/ci-step-times.ts --job "Portable server" --runs 40150766871,40059346321
 *   bun scripts/ci-step-times.ts --self-check         # the parsing and the figures, on fixtures
 *
 * Options:
 *   --job <name>          the job, by its exact name (required unless --self-check)
 *   --step <regex>        steps whose name matches, case-insensitive; default every step that took a second or more
 *   --workflow <name>     default "Fork Checks"
 *   --branch <name>       default main
 *   --days <n>            runs created in the last n days, default 7
 *   --runs <id,id,…>      these runs instead of a window
 *   --repo <owner/name>   default gh's own (the repository of the current directory)
 *
 * Needs `gh` signed in. Reads only; writes nothing.
 */

const KNOWN: Record<string, "value" | "flag"> = {
  "--job": "value", "--step": "value", "--workflow": "value", "--branch": "value", "--days": "value", "--runs": "value", "--repo": "value", "--self-check": "flag",
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

/** Seconds from one ISO time to another, or null when either is missing or the order is wrong (a step never run). */
export function seconds(from?: string | null, to?: string | null): number | null {
  if (!from || !to) return null;
  const s = (Date.parse(to) - Date.parse(from)) / 1000;
  return Number.isFinite(s) && s >= 0 ? s : null;
}

/** A job's wall time and the steps the pattern picks, each with its seconds (null steps left out). No pattern: every step of a second or more. */
export function jobRow(job: Job, step?: RegExp): { job: number | null; steps: { name: string; s: number }[] } {
  const steps = (job.steps ?? [])
    .map((st) => ({ name: st.name, s: seconds(st.startedAt, st.completedAt) }))
    .filter((st): st is { name: string; s: number } => st.s !== null && (step ? step.test(st.name) : st.s >= 1));
  return { job: seconds(job.startedAt, job.completedAt), steps };
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

function refuse(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function gh(args: string[]): unknown {
  const r = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) refuse(`gh ${args.slice(0, 3).join(" ")} … failed: ${new TextDecoder().decode(r.stderr).trim()}`);
  return JSON.parse(new TextDecoder().decode(r.stdout));
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
  const job: Job = {
    name: "Portable server", startedAt: "2026-10-24T00:00:00Z", completedAt: "2026-10-24T00:03:27Z", steps: [
      { name: "Set up job", startedAt: "2026-10-24T00:00:00Z", completedAt: "2026-10-24T00:00:00.5Z" },
      { name: "The REST core's routes and authorization", startedAt: "2026-10-24T00:01:00Z", completedAt: "2026-10-24T00:01:16Z" },
      { name: "Test against the real server", startedAt: "2026-10-24T00:01:16Z", completedAt: "2026-10-24T00:02:04Z" },
      { name: "Never ran", startedAt: null, completedAt: null },
    ],
  };
  const all = jobRow(job);
  ok(all.job === 207 && all.steps.map((s) => s.s).join() === "16,48", "no pattern: the job's time and every step of a second or more");
  const rest = jobRow(job, /rest core/i);
  ok(rest.steps.length === 1 && rest.steps[0].s === 16, "a pattern picks its steps, case-insensitive");
  const odd = stats([43, 16, 44]), even = stats([16, 17, 18, 44]);
  ok(odd?.median === 43 && odd.min === 16 && odd.max === 44 && even?.median === 17.5, "the median of an odd and an even list");
  ok(stats(Array.from({ length: 10 }, (_, i) => i + 1))?.p90 === 9 && stats([])  === null, "p90 by nearest rank; no runs, no figures");
  console.log(failed ? `${failed} failed` : "all passed");
  return failed ? 1 : 0;
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) refuse(opts.error);
  if (opts["--self-check"]) process.exit(selfCheck());
  const jobName = opts["--job"];
  if (typeof jobName !== "string") refuse("--job <name> is required (the job's exact name, e.g. \"Portable server\")");
  const days = Number(opts["--days"] ?? 7);
  if (!Number.isInteger(days) || days < 1) refuse(`--days takes a whole number of at least 1, got ${opts["--days"]}`);
  let step: RegExp | undefined;
  try {
    step = typeof opts["--step"] === "string" ? new RegExp(opts["--step"], "i") : undefined;
  } catch (e) {
    refuse(`--step is not a regular expression: ${(e as Error).message}`);
  }
  const repo = typeof opts["--repo"] === "string" ? ["--repo", opts["--repo"]] : [];
  const workflow = String(opts["--workflow"] ?? "Fork Checks"), branch = String(opts["--branch"] ?? "main");
  let ids: string[];
  if (typeof opts["--runs"] === "string") {
    ids = opts["--runs"].split(",").map((s) => s.trim()).filter(Boolean);
    if (!ids.every((id) => /^\d+$/.test(id))) refuse(`--runs takes run ids, comma-separated, got ${opts["--runs"]}`);
  } else {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const runs = gh(["run", "list", ...repo, "--workflow", workflow, "--branch", branch, "--created", `>=${since}`, "--limit", "500", "--json", "databaseId,status"]) as { databaseId: number; status: string }[];
    ids = runs.filter((r) => r.status === "completed").map((r) => String(r.databaseId)).reverse();
    console.log(`${workflow} on ${branch} since ${since}: ${ids.length} completed runs`);
  }
  const jobTimes: number[] = [];
  const stepTimes = new Map<string, number[]>();
  for (const id of ids) {
    const run = gh(["run", "view", id, ...repo, "--json", "jobs,headSha,createdAt"]) as { jobs: Job[]; headSha: string; createdAt: string };
    const job = run.jobs.find((j) => j.name === jobName);
    if (!job) {
      console.log(`${id} ${run.headSha.slice(0, 8)} ${run.createdAt.slice(0, 10)}  no job named "${jobName}"`);
      continue;
    }
    const row = jobRow(job, step);
    const counted = job.conclusion === "success";
    console.log(`${id} ${run.headSha.slice(0, 8)} ${run.createdAt.slice(0, 10)}  ${jobName}: ${row.job ?? "?"} s${counted ? "" : `  (${job.conclusion}, not counted)`}`);
    for (const st of row.steps) console.log(`    ${String(st.s).padStart(5)} s  ${st.name}`);
    if (!counted) continue;
    if (row.job !== null) jobTimes.push(row.job);
    for (const st of row.steps) stepTimes.set(st.name, [...(stepTimes.get(st.name) ?? []), st.s]);
  }
  const line = (label: string, xs: number[]) => {
    const f = stats(xs);
    console.log(f ? `  ${label}: median ${f.median} s, p90 ${f.p90} s, min ${f.min} s, max ${f.max} s over ${f.n} runs` : `  ${label}: no successful run`);
  };
  console.log("\nOver the runs where the job succeeded:");
  line(jobName, jobTimes);
  for (const [name, xs] of stepTimes) line(name, xs);
}
