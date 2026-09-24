/**
 * fetch-model.ts — put the pinned model files in a directory, verified (SMD-2050).
 *
 * The weights are referenced, never vendored: the tree carries the
 * repository, the revision and each file's sha256 (verdict.ts's VERDICT), and
 * this fetches exactly those bytes into a directory the serving process owns —
 * a compose volume, or a cache directory on the host. Every file is hashed on
 * every start, fetched or not (606 MB in 0.2–0.7 s measured), because the
 * question at load is "are these the bytes that were pinned", and a file
 * that was there yesterday answers it no better than one fetched now.
 *
 * A download goes to `<file>.part-<pid>-<random>` — its own name, so two
 * processes fetching into one directory (serve.ts and conformance.ts on the
 * host cache) cannot write one file between them, and a stale part cannot be
 * appended to (first review pass: both happened, measured) — and is renamed
 * only after it hashes to the pin. An interrupted fetch leaves nothing that
 * looks complete; a part no one has written for STALE_PART_MS is removed at
 * the next start. A file that hashes wrong is named and never loaded: replaced
 * when fetching is on, left where it is (and refused) under --no-fetch.
 */

import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { VERDICT } from "./verdict.ts";

export const DEFAULT_HUB = "https://huggingface.co";

/** sha256 of a file, streamed. */
export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

/**
 * The parts this process is writing now, so a signal handler that exits
 * mid-fetch (serve.ts) can remove them — process.exit runs no catch or
 * finally, and the part would otherwise wait out STALE_PART_MS.
 */
export const openParts = new Set<string>();

/** A part file untouched this long belongs to a fetch that died; a live one is written continuously. */
export const STALE_PART_MS = 10 * 60_000;

/** Remove the parts of `name` in `dir` that no fetch has written for STALE_PART_MS. */
async function removeStaleParts(dir: string, name: string, log: (line: string) => void): Promise<void> {
  for (const f of await readdir(dir)) {
    if (!f.startsWith(`${name}.part`)) continue;
    const at = `${dir}/${f}`;
    const s = await stat(at).catch(() => null);
    if (s && Date.now() - s.mtimeMs > STALE_PART_MS) {
      log(`${f}: a part from a fetch that did not finish — removed`);
      await rm(at, { force: true });
    }
  }
}

/** Whether `path` is the pinned file: size first (cheap), then the hash. */
async function matchesPin(path: string, pin: { bytes: number; sha256: string }): Promise<boolean> {
  return (await sizeOf(path)) === pin.bytes && (await sha256File(path)) === pin.sha256;
}

/**
 * What is fetched: a repository at a revision, and each file's size and
 * sha256. VERDICT is one; conformance.ts's receipt is another, on GitHub,
 * whose raw URLs are not the hub's `resolve/` shape — hence `url`.
 */
export type ModelPins = {
  repo: string;
  revision: string;
  files: Readonly<Record<string, { bytes: number; sha256: string }>>;
  /** Where a file is fetched from; default the hub's `<repo>/resolve/<revision>/<name>`. */
  url?: (name: string) => string;
};

export type EnsureResult = { fetched: string[]; verified: string[]; ms: number };

/**
 * Every pinned file present and verified in `dir`, fetching what is missing
 * or wrong from `hub` at the pinned revision. Throws, naming the file, when a
 * fetch fails or a fetched file does not hash to its pin; `fetch: false`
 * throws instead of fetching (an operator who wants no network at start).
 * `pins` defaults to the served model's; the suite passes its own.
 */
export async function ensureModel(
  dir: string,
  opts: { pins?: ModelPins; hub?: string; fetch?: boolean; fetchImpl?: typeof fetch; log?: (line: string) => void } = {},
): Promise<EnsureResult> {
  const pins: ModelPins = opts.pins ?? VERDICT;
  const hub = (opts.hub ?? DEFAULT_HUB).replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});
  const t0 = performance.now();
  await mkdir(dir, { recursive: true });
  const fetched: string[] = [];
  const verified: string[] = [];
  for (const [name, pin] of Object.entries(pins.files)) {
    const path = `${dir}/${name}`;
    await removeStaleParts(dir, name, log);
    if (await matchesPin(path, pin)) {
      verified.push(name);
      continue;
    }
    const present = (await sizeOf(path)) !== null;
    // Refused before anything is touched: --no-fetch leaves the directory as it found it.
    if (opts.fetch === false) throw new Error(`${path} is ${present ? "not the pinned file" : "missing"}, and fetching is off`);
    if (present) {
      log(`${name}: present but not the pinned bytes (${pin.sha256.slice(0, 12)}…) — replacing it`);
      await rm(path, { force: true }); // another process may have replaced it since
    }
    const url = pins.url ? pins.url(name) : `${hub}/${pins.repo}/resolve/${pins.revision}/${name}`;
    log(`${name}: fetching ${(pin.bytes / 2 ** 20).toFixed(1)} MB from ${url}`);
    // A fetch that never connects names the file and the URL too, not only
    // Bun's own words (fifth review pass: an unreachable JEV_HUB said only
    // "Unable to connect").
    const r = await doFetch(url, { redirect: "follow" }).catch((e: unknown) => {
      const said = e instanceof Error ? e.message : String(e);
      throw new Error(`fetching ${name} from ${url} failed: ${said.replace(/\.?\s*Is the computer able to access the url\?$/, "")} — nothing kept`);
    });
    if (!r.ok || !r.body) throw new Error(`fetching ${name} from ${url} answered ${r.status}`);
    const part = `${path}.part-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    // Streamed through a sink, never held whole. Not `Bun.write(part, r)`:
    // once `r.body` has been read — as the check above reads it — Bun 1.4's
    // write of the Response never settles (measured; the suite hung here).
    // A fetch that fails midway removes its own part and names the file
    // (second review pass: each failed attempt left its own part, up to
    // 606 MB, and the error was the runtime's bare "connection reset").
    openParts.add(part);
    const sink = Bun.file(part).writer();
    let received = 0;
    try {
      for await (const chunk of r.body) {
        sink.write(chunk);
        received += chunk.byteLength;
      }
      await sink.end();
    } catch (e) {
      await Promise.resolve(sink.end()).catch(() => {});
      await rm(part, { force: true });
      openParts.delete(part);
      throw new Error(`fetching ${name} from ${url} failed after ${received} of ${pin.bytes} bytes: ${(e as Error).message} — nothing kept`);
    }
    if (!(await matchesPin(part, pin))) {
      const [got, size] = [await sha256File(part), await sizeOf(part)];
      await rm(part, { force: true });
      openParts.delete(part);
      throw new Error(`${name} from ${url} is ${size} bytes with sha256 ${got}; the pin is ${pin.bytes} bytes, ${pin.sha256} — refused, nothing kept`);
    }
    await rename(part, path);
    openParts.delete(part);
    fetched.push(name);
  }
  return { fetched, verified, ms: performance.now() - t0 };
}
