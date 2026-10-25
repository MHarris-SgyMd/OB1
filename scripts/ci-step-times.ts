#!/usr/bin/env bun
/**
 * ci-step-times.ts — one CI job's time, and its steps', over a window of runs, with the median of each (SMD-3305).
 *
 * The CI-efficiency tickets' Verify reads a job or step "over a week of main's runs" (SMD-3192's children). This
 * reads those runs through `gh` and prints, per run, the job's wall time and each step's that matches; then, over
 * the runs where the job succeeded, each one's median, p90, min and max. A failed or cancelled job is listed, marked,
 * and left out of the figures: its steps stop early. A skipped step is left out too: it starts and ends at once, and
 * would read 0 s. A run `gh` cannot read is retried once, then said and passed over.
 *
 *   bun scripts/ci-step-times.ts --job "Portable server"
 *   bun scripts/ci-step-times.ts --job "Portable server" --step "REST core" --days 14
 *   bun scripts/ci-step-times.ts --job "Portable server" --runs 40150766871,40059346321
 *   bun scripts/ci-step-times.ts --self-check         # the parsing and the figures, on fixtures
 *
 * Options:
 *   --job <name>          the job, by its exact name (required unless --self-check)
 *   --step <regex>        steps whose name matches, case-insensitive; default every step that took a second or more in
 *                         some run (chosen by name across the runs, so each reads every run it ran in)
 *   --workflow <name>     default "Fork Checks"
 *   --branch <name>       default main
 *   --days <n>            runs created in the last n × 24 hours, default 7
 *   --runs <id,id,…>      these runs instead of a window (with --branch, --days or --workflow refused: they would be ignored)
 *   --repo <owner/name>   default gh's own (the repository of the current directory)
 *
 * A job name that no run read has is refused (exit 1), with the job names the runs do have. A re-run shows its
 * latest attempt, marked. Needs `gh` signed in. Reads only; writes nothing.
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
/** The most runs one `gh run list` returns here; a window that fills it is said to be cut short. */
const LIST_LIMIT = 500;
type Job = { name: string; conclusion?: string | null; startedAt?: string | null; completedAt?: string | null; steps?: Step[] };

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
 * The steps to report, chosen by name across every run, so each one's figures read every run it ran in: those the
 * pattern matches, or with no pattern those that took a second or more in some run.
 */
export function pickSteps(rows: { steps: { name: string; s: number }[] }[], step?: RegExp): Set<string> {
  const longest = new Map<string, number>();
  for (const row of rows) for (const st of row.steps) longest.set(st.name, Math.max(longest.get(st.name) ?? 0, st.s));
  return new Set([...longest].filter(([name, s]) => (step ? step.test(name) : s >= 1)).map(([name]) => name));
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

/** One `gh` call's JSON, tried twice; the error's text when both fail. A missing `gh` is refused. */
async function gh(args: string[]): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  let error = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      refuse(`cannot run gh: ${(e as Error).message}`);
    }
    const [out, err, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited]);
    if (code === 0) return { ok: true, json: JSON.parse(out) };
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
  const odd = stats([43, 16, 44]), even = stats([16, 17, 18, 44]);
  ok(odd?.median === 43 && odd.min === 16 && odd.max === 44 && even?.median === 17.5, "the median of an odd and an even list");
  const ten = stats(Array.from({ length: 10 }, (_, i) => i + 1)), eleven = stats(Array.from({ length: 11 }, (_, i) => i + 1));
  ok(ten?.p90 === 9 && eleven?.p90 === 10 && stats([]) === null, "p90 by nearest rank, at 10 runs and at 11; no runs, no figures");
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
  if (typeof opts["--runs"] === "string") for (const f of ["--branch", "--days", "--workflow"]) if (opts[f] !== undefined) refuse(`${f} does nothing with --runs: give one or the other`);
  const repo = typeof opts["--repo"] === "string" ? ["--repo", opts["--repo"]] : [];
  const workflow = String(opts["--workflow"] ?? "Fork Checks"), branch = String(opts["--branch"] ?? "main");
  let ids: string[];
  if (typeof opts["--runs"] === "string") {
    ids = opts["--runs"].split(",").map((s) => s.trim()).filter(Boolean);
    if (!ids.every((id) => /^\d+$/.test(id))) refuse(`--runs takes run ids, comma-separated, got ${opts["--runs"]}`);
    console.log(`${ids.length} runs named`);
  } else {
    // gh's --created takes a day; the window is the last n × 24 hours, so a day early is asked and createdAt cut.
    const cutoff = Date.now() - days * 86_400_000;
    const day = new Date(cutoff - 86_400_000).toISOString().slice(0, 10);
    const listed = await gh(["run", "list", ...repo, "--workflow", workflow, "--branch", branch, "--created", `>=${day}`, "--limit", String(LIST_LIMIT), "--json", "databaseId,status,createdAt"]);
    if (!listed.ok) refuse(`gh run list failed: ${listed.error}`);
    const runs = listed.json as { databaseId: number; status: string; createdAt: string }[];
    if (runs.length >= LIST_LIMIT) console.log(`  gh returned its limit of ${LIST_LIMIT} runs: the window is cut short; give fewer --days`);
    ids = runs.filter((r) => r.status === "completed" && Date.parse(r.createdAt) >= cutoff).map((r) => String(r.databaseId)).reverse();
    console.log(`${workflow} on ${branch} since ${new Date(cutoff).toISOString().slice(0, 16)}Z: ${ids.length} completed runs`);
  }
  // Six runs read at once: one `gh run view` a run takes about 2 s.
  const viewed = await pooled(ids, 6, async (id) => ({ id, got: await gh(["run", "view", id, ...repo, "--json", "jobs,headSha,createdAt,attempt"]) }));
  type Run = { jobs: Job[]; headSha: string; createdAt: string; attempt?: number };
  const read: { id: string; run: Run; job?: Job; row?: ReturnType<typeof jobRow> }[] = [];
  let unread = 0;
  const seen = new Set<string>();
  for (const { id, got } of viewed) {
    if (!got.ok) {
      unread++;
      console.log(`${id}  not read, passed over: ${got.error.split("\n")[0].slice(0, 120)}`);
      continue;
    }
    const run = got.json as Run;
    for (const j of run.jobs) seen.add(j.name);
    const job = run.jobs.find((j) => j.name === jobName);
    read.push({ id, run, job, row: job ? jobRow(job) : undefined });
  }
  if (read.length > 0 && read.every((r) => !r.job)) {
    console.error(`no run read has a job named "${jobName}"; its jobs are named: ${[...seen].sort().join(", ")}`);
    process.exit(1);
  }
  const names = pickSteps(read.filter((r) => r.job?.conclusion === "success").map((r) => r.row!), step);
  const jobTimes: number[] = [];
  const stepTimes = new Map<string, number[]>([...names].map((n) => [n, []]));
  for (const { id, run, job, row } of read) {
    const head = `${id} ${run.headSha.slice(0, 8)} ${run.createdAt.slice(0, 10)}${(run.attempt ?? 1) > 1 ? ` (attempt ${run.attempt})` : ""}`;
    if (!job || !row) {
      console.log(`${head}  no job named "${jobName}"`);
      continue;
    }
    const counted = job.conclusion === "success";
    console.log(`${head}  ${jobName}: ${row.job ?? "?"} s${counted ? "" : `  (${job.conclusion}, not counted)`}`);
    for (const st of row.steps) if (names.has(st.name)) console.log(`    ${String(st.s).padStart(5)} s  ${st.name}`);
    if (!counted) continue;
    if (row.job !== null) jobTimes.push(row.job);
    for (const st of row.steps) stepTimes.get(st.name)?.push(st.s);
  }
  const line = (label: string, xs: number[]) => {
    const f = stats(xs);
    console.log(f ? `  ${label}: median ${f.median} s, p90 ${f.p90} s, min ${f.min} s, max ${f.max} s over ${f.n} runs` : `  ${label}: no successful run`);
  };
  console.log(`\nOver the runs where the job succeeded${unread ? ` (${unread} run${unread === 1 ? "" : "s"} not read)` : ""}:`);
  line(jobName, jobTimes);
  for (const [name, xs] of stepTimes) line(name, xs);
}
