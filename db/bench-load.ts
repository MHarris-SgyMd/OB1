/**
 * bench-load.ts — bench-hnsw.ts section F: `match_thoughts` under concurrency
 * (SMD-1500). Every other latency bench-hnsw.ts prints is a median of one call
 * at a time on one connection. The server's own pool is ten connections
 * (`OB1_PG_POOL`), and the figures the fork compares itself to are throughput
 * and p99 under load. Ten concurrent calls are not one call's cost times ten:
 * 014's header prices the walk's memory per backend, and a broad filter's
 * routing count reads a GIN bitmap over half the table. Concurrent calls share
 * the CPUs and the page cache.
 *
 * What the section does, closed-loop:
 * - Each of N connections is its own backend. It issues its next call the
 *   moment its last one returns, for a fixed wall time.
 * - Each connection walks its own cycle over every (tier, query) pair of the
 *   mix. The cycles start spread evenly around it, so at any instant the
 *   connections are asking different queries of different tiers.
 * - Every answer is scored against the exact oracle bench-hnsw.ts computed,
 *   and compared with the answer one call alone gave to the same query.
 *   Concurrency must not change an answer. If it does, that is a finding, not
 *   a tolerance.
 * - The database container's memory is sampled during the run from its
 *   cgroup, read through `pg_read_file` on a connection outside the pool.
 *   Anonymous memory is what the header's arithmetic prices: backends'
 *   private allocations, with the page cache and shared buffers left out.
 * - The machine's load average is read before each run, the same way. Other
 *   containers on the same VM share the CPUs, and the tables should say how
 *   busy it was.
 *
 * Lifted out of bench-hnsw.ts as bench-oracle.ts was. The schedule, the
 * percentiles, the summary and the cgroup parse are pure functions that
 * test-schema.ts drives. The loop and the reads need a server, and
 * test-live.ts holds the loop to N concurrent backends.
 */
import type { SQL } from "bun";

/** One kind of call in a mix: a tier's key, or null for the unfiltered default path. */
export type Slot = { key: string | null; label: string };
/** A fixed query mix: each connection rotates through its slots, every slot asked with every query. */
export type Mix = { name: string; slots: Slot[] };

/**
 * The k-th call of connection c of n: which slot and which query. The pairs
 * are numbered slot-fastest (pair p is slot p mod S, query ⌊p / S⌋), so one
 * connection alternates its tiers call by call and asks every pair once per
 * cycle of S × Q calls. Connection c starts c/n of the way round the cycle.
 */
export function pairAt(c: number, n: number, k: number, slots: number, queries: number): { slot: number; query: number } {
  const cycle = slots * queries;
  const p = (Math.floor((c * cycle) / n) + k) % cycle;
  return { slot: p % slots, query: Math.floor(p / slots) };
}

/** The nearest-rank percentile of an ascending list: the smallest value at least a share p of the list is at or under. NaN for an empty list. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** One call made under load: which pair, how long it took, and the ids it returned in row order. */
export type CallRecord = { slot: number; query: number; ms: number; ids: string[] };

/** One slot's line in the section: calls, latency, recall under load beside one call's recall over the same queries, and the answers that differed from one call's. */
export type SlotLoad = { label: string; calls: number; p50: number; p99: number; recall: number; recallAlone: number; changed: number };

const overlap = (got: string[], want: string[]) => got.filter((id) => want.includes(id)).length;
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));

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
 * The machine's one-minute load average, from the server's /proc/loadavg. A
 * container sees its host's (the VM's, under podman or Docker on a Mac), so
 * this counts every other container sharing the CPUs: what else was running
 * when a run began.
 */
export const LOADAVG_SQL = `SELECT pg_read_file('/proc/loadavg') AS l`;

/** /proc/loadavg's first field, or null where the text is not its shape. */
export function parseLoadAvg(text: string): number | null {
  const m = text.match(/^(\d+\.\d+) \d+\.\d+ \d+\.\d+ /);
  return m ? Number(m[1]) : null;
}

/** The pool's backends, each asked its pid at once: refused unless every connection is a backend of its own, since N calls on fewer backends queue and are not N calls at once. */
export async function assertDistinctBackends(pool: SQL[]): Promise<number[]> {
  const pids = await Promise.all(pool.map(async (sql) => Number((await sql`SELECT pg_backend_pid() AS pid`)[0].pid)));
  if (new Set(pids).size !== pool.length) throw new Error(`the load's ${pool.length} connections reached ${new Set(pids).size} backends (pids ${pids.join(", ")}); its calls would queue rather than run at once`);
  return pids;
}

/** A closed-loop run: every call, the wall time from the first call to the last return, the container's memory at idle and at its peak during the run (each field's own peak) or why it was not read, and the machine's load average just before the first call (null where unread). */
export type LoadRun = { records: CallRecord[]; elapsedMs: number; memory: { idle: CgroupMemory; peak: CgroupMemory; samples: number } | string; loadBefore: number | null };

/**
 * N connections, closed-loop, for `seconds`. Connection c makes its k-th call
 * on `pairAt(c, N, k)`. No call starts after the deadline. A call in flight at
 * the deadline is awaited and counted, so the wall time runs to the last
 * return. The first error stops every connection from starting another call,
 * and is thrown once all of them have returned. Through `memory`, a connection
 * outside the pool, the load average is read once and the container's memory
 * once before the first call, then the memory every `sampleMs` until the last
 * return.
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
  const loadBefore = opts.memory ? await opts.memory.unsafe(LOADAVG_SQL).then(([row]) => parseLoadAvg(String(row.l)), () => null) : null;
  const idle = opts.memory ? await readMemory(opts.memory) : "no connection to read the server's memory through";
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
          records.push({ slot, query, ms: performance.now() - start, ids });
        } catch (err) {
          failed ??= err;
        }
      }
    })
  );
  const elapsedMs = performance.now() - t0;
  running = false;
  await sampler;
  if (failed !== null) throw failed;
  return { records, elapsedMs, memory: typeof idle === "string" ? idle : { idle, peak: peak!, samples }, loadBefore };
}
