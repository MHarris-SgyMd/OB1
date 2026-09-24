/**
 * fetch-model.ts — put the pinned model files in a directory, verified (SMD-2050).
 *
 * The weights are referenced, never vendored: the tree carries the
 * repository, the revision and each file's sha256 (verdict.ts's VERDICT), and
 * this fetches exactly those bytes into a directory the serving process owns —
 * a compose volume, or a cache directory on the host. Every file is hashed on
 * every start, fetched or not (606 MB hashes in about a second), because the
 * question at load is "are these the bytes that were pinned", and a file
 * that was there yesterday answers it no better than one fetched now.
 *
 * A download goes to `<file>.part` and is renamed only after it hashes to the
 * pin, so an interrupted fetch leaves nothing that looks complete, and a file
 * that hashes wrong is removed and named — never loaded.
 */

import { mkdir, rename, rm, stat } from "node:fs/promises";
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
    if (await matchesPin(path, pin)) {
      verified.push(name);
      continue;
    }
    const present = (await sizeOf(path)) !== null;
    // Refused before anything is touched: --no-fetch leaves the directory as it found it.
    if (opts.fetch === false) throw new Error(`${path} is ${present ? "not the pinned file" : "missing"}, and fetching is off`);
    if (present) {
      log(`${name}: present but not the pinned bytes (${pin.sha256.slice(0, 12)}…) — replacing it`);
      await rm(path);
    }
    const url = pins.url ? pins.url(name) : `${hub}/${pins.repo}/resolve/${pins.revision}/${name}`;
    log(`${name}: fetching ${(pin.bytes / 2 ** 20).toFixed(1)} MB from ${url}`);
    const r = await doFetch(url, { redirect: "follow" });
    if (!r.ok || !r.body) throw new Error(`fetching ${name} from ${url} answered ${r.status}`);
    const part = `${path}.part`;
    // Streamed through a sink, never held whole. Not `Bun.write(part, r)`:
    // once `r.body` has been read — as the check above reads it — Bun 1.4's
    // write of the Response never settles (measured; the suite hung here).
    const sink = Bun.file(part).writer();
    for await (const chunk of r.body) sink.write(chunk);
    await sink.end();
    if (!(await matchesPin(part, pin))) {
      const [got, size] = [await sha256File(part), await sizeOf(part)];
      await rm(part, { force: true });
      throw new Error(`${name} from ${url} is ${size} bytes with sha256 ${got}; the pin is ${pin.bytes} bytes, ${pin.sha256} — refused, nothing kept`);
    }
    await rename(part, path);
    fetched.push(name);
  }
  return { fetched, verified, ms: performance.now() - t0 };
}
