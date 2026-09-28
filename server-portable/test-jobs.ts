/**
 * test-jobs.ts — the in-memory async job registry (jobs.ts, SMD-2273).
 *
 * A unit suite: jobs.ts is pure in-memory, so the lifecycle (pending → running →
 * succeeded / failed / lost), ownership, the SSE frames, retention and the cap
 * are driven here deterministically — with an injected clock and a `track` that
 * captures the detached run's promise, so no test races a timer. The HTTP and
 * tool integration (a handle from scan_thoughts, the keyed GET /jobs/<id> poll,
 * the SSE route, auth parity) is test-e2e-sql's, against a real database.
 */
import {
  startJob,
  readJob,
  subscribe,
  markRunningLost,
  jobsRunning,
  resetJobsForTest,
  jobCountForTest,
} from "./jobs.ts";
import { createAssert } from "../db/test-support.ts";

const { assert, report } = createAssert();

const OWNER = { keyHash: "owner-hash", name: "owner" };
const OTHER = { keyHash: "other-hash", name: "other" };
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Read an SSE ReadableStream to its close, returning the concatenated text. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  return out;
}

console.log("[1] startJob returns an accepted handle; pending→running→succeeded, progress and result carried");
{
  resetJobsForTest();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let ran!: Promise<unknown>;
  const handle = startJob(OWNER, "demo", async (ctx) => {
    ctx.progress(1, 2);
    await gate;
    ctx.progress(2, 2);
    return { ok: true };
  }, { track: (run) => (ran = run()) });

  assert(handle.status === "accepted", `handle status is "accepted" (${handle.status})`);
  assert(handle.poll === `/jobs/${handle.jobId}`, `handle.poll is /jobs/<id> (${handle.poll})`);
  assert(handle.stream === `/jobs/${handle.jobId}/stream`, `handle.stream is /jobs/<id>/stream (${handle.stream})`);

  // exec runs synchronously up to its first await, so the job is already running.
  const running = readJob(OWNER, handle.jobId);
  assert(running?.status === "running", `job is running before it resolves (${running?.status})`);
  assert(running?.progress?.done === 1 && running?.progress?.total === 2, `progress reported (${JSON.stringify(running?.progress)})`);
  assert(readJob(OWNER, handle.jobId)?.actor === "owner", "actor recorded from the principal");

  release();
  await ran;
  const done = readJob(OWNER, handle.jobId);
  assert(done?.status === "succeeded", `job succeeded after it resolves (${done?.status})`);
  assert(JSON.stringify(done?.result) === JSON.stringify({ ok: true }), `result carried (${JSON.stringify(done?.result)})`);
  assert(done?.progress?.done === 2, "final progress carried");
  assert(done?.endedAt !== undefined && done?.startedAt !== undefined, "startedAt and endedAt stamped");
}

console.log("[2] a job is visible only to the key that started it (ownership)");
{
  resetJobsForTest();
  let ran!: Promise<unknown>;
  const handle = startJob(OWNER, "demo", async () => 1, { track: (run) => (ran = run()) });
  await ran;
  assert(readJob(OWNER, handle.jobId)?.status === "succeeded", "owner sees the job");
  assert(readJob(OTHER, handle.jobId) === null, "another key sees nothing (null, → 404 at the route)");
  assert(readJob(OWNER, "no-such-id") === null, "an unknown id is null");
  assert(subscribe(OTHER, handle.jobId) === null, "another key cannot subscribe");
}

console.log("[3] a throwing run fails the job and carries the error message");
{
  resetJobsForTest();
  let ran!: Promise<unknown>;
  const handle = startJob(OWNER, "demo", async () => { throw new Error("boom"); }, { track: (run) => (ran = run()) });
  await ran;
  const job = readJob(OWNER, handle.jobId);
  assert(job?.status === "failed", `job failed (${job?.status})`);
  assert(job?.error?.message === "boom", `error message carried (${job?.error?.message})`);
  assert(job?.result === undefined, "no result on a failed job");
}

console.log("[4] markRunningLost cuts running jobs to lost; a finished job is untouched");
{
  resetJobsForTest();
  // A job that never resolves on its own — only the stop ends it.
  startJob(OWNER, "forever", () => new Promise<never>(() => {}), { track: (run) => { void run(); } });
  let ranDone!: Promise<unknown>;
  const done = startJob(OWNER, "quick", async () => "done", { track: (run) => (ranDone = run()) });
  await ranDone;
  assert(jobsRunning() === 1, `one job still running before the stop (${jobsRunning()})`);
  const lost = markRunningLost();
  assert(lost === 1, `markRunningLost cut exactly the running one (${lost})`);
  assert(jobsRunning() === 0, "nothing running after the stop");
  assert(readJob(OWNER, done.jobId)?.status === "succeeded", "the finished job is left succeeded");
  // A freshly-cut job carries status "lost" and the SERVER_STOPPING code.
  const handle2 = startJob(OWNER, "forever2", () => new Promise<never>(() => {}), { track: (run) => { void run(); } });
  markRunningLost();
  const j = readJob(OWNER, handle2.jobId);
  assert(j?.status === "lost" && j?.error?.code === "SERVER_STOPPING", `a lost job carries status "lost" and code SERVER_STOPPING (${JSON.stringify(j?.error)})`);
}

console.log("[5] the SSE stream carries a status snapshot, progress events, then a terminal event, and closes");
{
  resetJobsForTest();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let ran!: Promise<unknown>;
  const handle = startJob(OWNER, "demo", async (ctx) => { await gate; ctx.progress(1, 1); return { n: 42 }; }, { track: (run) => (ran = run()) });
  const stream = subscribe(OWNER, handle.jobId);
  assert(stream !== null, "owner gets a stream");
  const collected = drain(stream!);
  release();
  await ran;
  const text = await collected;
  assert(/event: status\b/.test(text), "a status event opens the stream");
  assert(/event: progress\b/.test(text), "a progress event is emitted");
  assert(/event: done\b/.test(text), "a terminal done event closes a succeeded job");
  assert(/"n":42/.test(text), "the terminal event carries the result");
}

console.log("[6] subscribing to an already-terminal job replays its status and terminal event, then closes");
{
  resetJobsForTest();
  let ran!: Promise<unknown>;
  const handle = startJob(OWNER, "demo", async () => "ok", { track: (run) => (ran = run()) });
  await ran;
  const text = await drain(subscribe(OWNER, handle.jobId)!);
  assert(/event: status\b/.test(text) && /event: done\b/.test(text), "a finished job's stream is snapshot + terminal");
}

console.log("[7] a failed job's stream terminates with an error event");
{
  resetJobsForTest();
  let ran!: Promise<unknown>;
  const handle = startJob(OWNER, "demo", async () => { throw new Error("nope"); }, { track: (run) => (ran = run()) });
  await ran;
  const text = await drain(subscribe(OWNER, handle.jobId)!);
  assert(/event: error\b/.test(text), "a failed job's terminal event is `error`");
  assert(/nope/.test(text), "the error message is carried");
}

console.log("[8] terminal records are evicted after their retention, and the cap drops the oldest terminal first");
{
  resetJobsForTest();
  // Retention: a tiny window, then the record is gone (a poll gets not-found).
  let ran!: Promise<unknown>;
  const handle = startJob(OWNER, "demo", async () => 1, { retentionMs: 20, track: (run) => (ran = run()) });
  await ran;
  assert(readJob(OWNER, handle.jobId) !== null, "the record is readable right after it ends");
  await new Promise((r) => setTimeout(r, 40));
  assert(readJob(OWNER, handle.jobId) === null, "the record is evicted after its retention window");

  // Cap: with maxJobs 2, a third terminal job drops the oldest.
  resetJobsForTest();
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    let r!: Promise<unknown>;
    const h = startJob(OWNER, "demo", async () => i, { maxJobs: 2, retentionMs: 60_000, track: (run) => (r = run()) });
    ids.push(h.jobId);
    await r;
    await tick();
  }
  assert(jobCountForTest() <= 2, `the cap holds the registry to 2 (${jobCountForTest()})`);
  assert(readJob(OWNER, ids[0]) === null, "the oldest terminal job was evicted first");
  assert(readJob(OWNER, ids[2]) !== null, "the newest job is kept");
}

console.log("[9] a running job is never evicted by the cap");
{
  resetJobsForTest();
  const running = startJob(OWNER, "forever", () => new Promise<never>(() => {}), { maxJobs: 1, track: (run) => { void run(); } });
  // Start two more terminal jobs; the running one must survive the cap.
  for (let i = 0; i < 2; i++) {
    let r!: Promise<unknown>;
    startJob(OWNER, "demo", async () => i, { maxJobs: 1, retentionMs: 60_000, track: (run) => (r = run()) });
    await r;
    await tick();
  }
  assert(readJob(OWNER, running.jobId)?.status === "running", "the running job is not evicted by the cap");
  markRunningLost();
}

report();
