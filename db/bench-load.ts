/**
 * bench-load.ts — bench-hnsw.ts section F: `match_thoughts` under concurrency
 * (SMD-1500). Every other latency bench-hnsw.ts prints is a median of one call
 * at a time on one connection. The server's own pool is ten connections
 * (`OB1_PG_POOL`), and the figures the fork compares itself to are throughput
 * and p99 under load. Ten concurrent calls are not one call's cost times ten:
 * 014's header prices the walk's memory per backend, and concurrent calls
 * share the CPUs and the page cache.
 *
 * What the section does, closed-loop:
 * - Each of N connections is its own backend. It issues its next call the
 *   moment its last one returns, for a fixed wall time.
 * - Each connection walks its own cycle over every (tier, query) pair of the
 *   mix. The connections start on different tiers and different queries, so
 *   they are not asking the same thing in step.
 * - Every answer is scored against the exact oracle bench-hnsw.ts computed,
 *   and compared with the answer one call alone gave to the same query.
 *   Concurrency should not change an answer. The one-connection run is the
 *   control: a call repeated with nothing beside it.
 * - The database container's memory is sampled during the run from its
 *   cgroup, read through `pg_read_file` on a connection outside the pool.
 *   Anonymous memory is what the header's arithmetic prices: backends'
 *   private allocations, with the page cache and shared buffers left out.
 * - The CPU time the container used and the CPU time the whole machine was
 *   busy are read the same way, before the first call and at the last
 *   return. The difference is everything else busy on the machine during
 *   that run: other containers, the kernel, the network path to the server
 *   (and, on a Linux host with no VM between, this client too).
 *
 * Lifted out of bench-hnsw.ts as bench-oracle.ts was. The schedule, the
 * percentiles, the summary and the parses are pure functions that
 * test-schema.ts drives. The loop and the reads need a server, and
 * test-live.ts holds the loop to N concurrent backends.
 */
import type { SQL } from "bun";

/** One kind of call in a mix: a tier's key, or null for the unfiltered default path. */
export type Slot = { key: string | null; label: string };
/** A fixed query mix: each connection rotates through its slots, one call each in turn, every slot asked with every query. */
export type Mix = { name: string; slots: Slot[] };

/**
 * The k-th call of connection c of n: which slot and which query. A
 * connection takes its slots in turn, one call each, and moves to its next
 * query after every S calls, so it asks every pair once per cycle of S × Q
 * calls. The two offsets are separate: connection c starts on slot c mod S and
 * c/n of the way through the queries. (One offset into the cycle of pairs
 * started every connection on the same slot whenever n divided Q, and the
 * documented run, three slots, 50 queries, ten connections, is one of those:
 * review pass 1.)
 */
export function pairAt(c: number, n: number, k: number, slots: number, queries: number): { slot: number; query: number } {
  return { slot: (k + c) % slots, query: (Math.floor(k / slots) + Math.floor((c * queries) / n)) % queries };
}

/** The nearest-rank percentile of an ascending list: the smallest value at least a share p of the list is at or under. NaN for an empty list. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** One call made under load: which pair, when it started (ms after the run began), how long it took, and the ids it returned in row order. */
export type CallRecord = { slot: number; query: number; at: number; ms: number; ids: string[] };

/** One slot's line in the section: calls, latency, recall under load beside one call's recall over the same queries, and the answers that differed from one call's. */
export type SlotLoad = { label: string; calls: number; p50: number; p99: number; recall: number; recallAlone: number; changed: number };

const overlap = (got: string[], want: string[]) => got.filter((id) => want.includes(id)).length;
const sameSet = (a: string[], b: string[]) => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((id) => y.has(id));
};

/**
 * The slots' lines from the run's calls. The recall is averaged per query
 * first, then across the queries the run reached. A closed loop that stops
 * mid-cycle has asked the first queries once more than the rest, and a mean
 * over calls would weight them so. `recallAlone` is one call's recall over the
 * same queries, so the two columns compare like with like. `changed` counts
 * calls whose ids, as a set, are not the ids one call alone returned for
 * that pair.
 */
export function summarise(
  records: CallRecord[],
  slots: Slot[],
  want: (slot: number, query: number) => string[],
  alone: (slot: number, query: number) => string[]
): SlotLoad[] {
  return slots.map((s, slot) => {
    const mine = records.filter((r) => r.slot === slot);
    const times = mine.map((r) => r.ms).sort((a, b) => a - b);
    const perQuery = new Map<number, number[]>();
    for (const r of mine) perQuery.set(r.query, [...(perQuery.get(r.query) ?? []), overlap(r.ids, want(slot, r.query))]);
    const queries = [...perQuery.keys()];
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
    return {
      label: s.label,
      calls: mine.length,
      p50: percentile(times, 0.5),
      p99: percentile(times, 0.99),
      recall: mean(queries.map((q) => mean(perQuery.get(q)!))),
      recallAlone: mean(queries.map((q) => overlap(alone(slot, q), want(slot, q)))),
      changed: mine.filter((r) => !sameSet(r.ids, alone(slot, r.query))).length,
    };
  });
}

/** The database container's memory, in bytes, from its cgroup: the total charged to it (page cache included), and the anonymous, file-backed and shared parts of memory.stat. */
export type CgroupMemory = { current: number; anon: number; file: number; shmem: number };

/** The cgroup v2 files, through the server: a superuser (or pg_read_server_files) on Linux reads them; anything else says why not. */
export const CGROUP_MEMORY_SQL = `SELECT pg_read_file('/sys/fs/cgroup/memory.current') AS current, pg_read_file('/sys/fs/cgroup/memory.stat') AS stat`;

/** memory.current and memory.stat's text into numbers, or null when either is not the cgroup v2 shape. */
export function parseCgroupMemory(current: string, stat: string): CgroupMemory | null {
  const total = Number(current.trim());
  if (!/^\d+$/.test(current.trim()) || !Number.isFinite(total)) return null;
  const field = (name: string) => {
    const m = stat.match(new RegExp(`^${name} (\\d+)$`, "m"));
    return m ? Number(m[1]) : NaN;
  };
  const [anon, file, shmem] = [field("anon"), field("file"), field("shmem")];
  if ([anon, file, shmem].some((x) => Number.isNaN(x))) return null;
  return { current: total, anon, file, shmem };
}

/** One reading of the container's memory, or the reason there is none (not Linux, not cgroup v2, not a role that may read server files). */
export async function readMemory(sql: SQL): Promise<CgroupMemory | string> {
  try {
    const [row] = await sql.unsafe(CGROUP_MEMORY_SQL);
    return parseCgroupMemory(String(row.current), String(row.stat)) ?? "the server's /sys/fs/cgroup is not cgroup v2's memory.current and memory.stat";
  } catch (err) {
    return `the server's cgroup could not be read (${(err as Error).message.split("\n")[0]})`;
  }
}

/**
 * The machine's CPU time and the container's, through the server. A container
 * sees its host's /proc/stat (the VM's, under podman or Docker on a Mac), so
 * that counts every container sharing the CPUs; its cgroup's cpu.stat counts
 * its own processes.
 */
export const CPU_SQL = `SELECT pg_read_file('/proc/stat') AS stat, pg_read_file('/sys/fs/cgroup/cpu.stat') AS cg`;

/**
 * /proc/stat's first line: the seconds every CPU spent busy (user, nice,
 * system, irq, softirq; idle, iowait and steal are not work done here), at
 * Linux's USER_HZ of 100, and the CPU count from its `cpuN` lines. Null where
 * the text is not that shape.
 */
export function parseProcStat(text: string): { busyS: number; cpus: number } | null {
  const m = text.match(/^cpu +(\d+) (\d+) (\d+) \d+ \d+ (\d+) (\d+)/);
  if (!m) return null;
  const cpus = (text.match(/^cpu\d+ /gm) ?? []).length;
  if (cpus === 0) return null;
  return { busyS: (Number(m[1]) + Number(m[2]) + Number(m[3]) + Number(m[4]) + Number(m[5])) / 100, cpus };
}

/** cpu.stat's usage_usec in seconds, or null. */
export function parseCpuStat(text: string): number | null {
  const m = text.match(/^usage_usec (\d+)$/m);
  return m ? Number(m[1]) / 1e6 : null;
}

/** One reading of both clocks, with when it was taken, or the reason there is none. */
type CpuReading = { busyS: number; cpus: number; dbS: number; at: number };
async function readCpu(sql: SQL): Promise<CpuReading | string> {
  try {
    const [row] = await sql.unsafe(CPU_SQL);
    const at = performance.now();
    const vm = parseProcStat(String(row.stat));
    const db = parseCpuStat(String(row.cg));
    return vm && db !== null ? { ...vm, dbS: db, at } : "the server's /proc/stat or cgroup cpu.stat is not the shape read here";
  } catch (err) {
    return `the server's CPU accounting could not be read (${(err as Error).message.split("\n")[0]})`;
  }
}

/**
 * The CPUs busy on average between two readings: the container's own, and
 * the rest of the machine's (other containers, the kernel, the network path).
 * Under podman or Docker on a Mac the bench's client runs on the host,
 * outside the VM, and is in neither; on a Linux host with no VM between, the
 * client's CPU is the machine's and lands in `others`. Not clamped: /proc/stat
 * is sampled by ticks and usage_usec is exact, so a small negative `others` is
 * the two clocks' skew, printed rather than hidden (review pass 2).
 */
export function cpuShare(before: { busyS: number; dbS: number; at: number }, after: { busyS: number; dbS: number; at: number }): { db: number; others: number } {
  const s = (after.at - before.at) / 1000;
  const db = (after.dbS - before.dbS) / s;
  return { db, others: (after.busyS - before.busyS) / s - db };
}

/** The pool's backends, each asked its pid at once: refused unless every connection is a backend of its own, since N calls on fewer backends queue and are not N calls at once. */
export async function assertDistinctBackends(pool: SQL[]): Promise<number[]> {
  const pids = await Promise.all(pool.map(async (sql) => Number((await sql`SELECT pg_backend_pid() AS pid`)[0].pid)));
  if (new Set(pids).size !== pool.length) throw new Error(`the load's ${pool.length} connections reached ${new Set(pids).size} backends (pids ${pids.join(", ")}); its calls would queue rather than run at once`);
  return pids;
}

/**
 * A closed-loop run: every call, the wall time from the run's start to the
 * last return, the container's memory at idle and at its peak during the run
 * (each field's own peak) or why it was not read, and the CPUs busy during the
 * run, the container's and the rest of the machine's, of how many, or why not.
 */
export type LoadRun = {
  records: CallRecord[];
  elapsedMs: number;
  memory: { idle: CgroupMemory; peak: CgroupMemory; samples: number } | string;
  cpu: { db: number; others: number; cpus: number } | string;
};

/**
 * N connections, closed-loop, for `seconds`. Connection c makes its k-th call
 * on `pairAt(c, N, k)`. No call starts after the deadline. A call in flight at
 * the deadline is awaited and counted, so the wall time runs to the last
 * return. The first error stops every connection from starting another call,
 * and is thrown once the calls in flight have returned. Through `memory`, a
 * connection outside the pool, the CPU clocks and the container's memory are
 * read before the first call, the memory every `sampleMs` until the last
 * return, and the CPU clocks again at it.
 */
export async function closedLoop(opts: {
  pool: SQL[];
  seconds: number;
  slots: number;
  queries: number;
  call: (sql: SQL, slot: number, query: number) => Promise<string[]>;
  memory?: SQL;
  sampleMs?: number;
}): Promise<LoadRun> {
  const { pool, slots, queries, call } = opts;
  const unread = "no connection to read the server through";
  const cpuBefore = opts.memory ? await readCpu(opts.memory) : unread;
  const idle = opts.memory ? await readMemory(opts.memory) : unread;
  let peak: CgroupMemory | null = typeof idle === "string" ? null : { ...idle };
  let samples = 0;
  let running = true;
  const sampler = (async () => {
    if (!opts.memory || peak === null) return;
    while (running) {
      const m = await readMemory(opts.memory);
      if (typeof m !== "string") {
        samples++;
        peak = { current: Math.max(peak!.current, m.current), anon: Math.max(peak!.anon, m.anon), file: Math.max(peak!.file, m.file), shmem: Math.max(peak!.shmem, m.shmem) };
      }
      await Bun.sleep(opts.sampleMs ?? 100);
    }
  })();
  const records: CallRecord[] = [];
  let failed: unknown = null;
  const t0 = performance.now();
  const deadline = t0 + opts.seconds * 1000;
  await Promise.all(
    pool.map(async (sql, c) => {
      for (let k = 0; failed === null && performance.now() < deadline; k++) {
        const { slot, query } = pairAt(c, pool.length, k, slots, queries);
        const start = performance.now();
        try {
          const ids = await call(sql, slot, query);
          records.push({ slot, query, at: start - t0, ms: performance.now() - start, ids });
        } catch (err) {
          failed ??= err;
        }
      }
    })
  );
  const elapsedMs = performance.now() - t0;
  running = false;
  // At the last return, not after the sampler's last sleep: the window is the
  // run's, give or take one memory read queued ahead on the same connection.
  const cpuAfter = opts.memory && failed === null ? await readCpu(opts.memory) : unread;
  await sampler;
  if (failed !== null) throw failed;
  const cpu = typeof cpuBefore === "string" ? cpuBefore : typeof cpuAfter === "string" ? cpuAfter : { ...cpuShare(cpuBefore, cpuAfter), cpus: cpuAfter.cpus };
  return { records, elapsedMs, memory: typeof idle === "string" ? idle : { idle, peak: peak!, samples }, cpu };
}
