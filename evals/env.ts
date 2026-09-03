/**
 * env.ts — read credentials from a gitignored .env file, so they are not typed
 * into a shell every time.
 *
 * Bun already loads a `.env` automatically, and that is *almost* enough. The
 * catch is that it loads from the current working directory: `bun
 * evals/build-linear-corpus.ts` from the repo root reads `./.env`, while `cd
 * evals && bun build-linear-corpus.ts` reads `evals/.env`. Same command, same
 * machine, different file — and the failure is a missing key rather than an
 * error, so it reads as "my key is wrong" instead of "I was in the wrong
 * directory".
 *
 * This does not replace that, and cannot: Bun's auto-load has already happened
 * by the time this module runs, and its values are indistinguishable from ones
 * the shell exported. What this adds is a search of fixed paths resolved from
 * the module's own location, so the canonical files are found no matter where
 * you were standing. The practical effect is layered rather than exclusive:
 *
 *   Bun auto-loads ./.env for the directory you ran from — a local override
 *   this module then fills any remaining gaps from the paths below
 *
 * So a `.env` in your CWD still wins. That is a reasonable thing for it to do,
 * and it is worth knowing rather than being surprised by.
 *
 * ── Precedence ───────────────────────────────────────────────────────────────
 * A variable already present in the environment always wins. Nothing here
 * overwrites it. That matters because CI and 1Password inject real credentials
 * that way, and a stale `.env` silently overriding an injected secret is a very
 * annoying afternoon. It also means a value Bun auto-loaded from the CWD wins,
 * per the note above — hence `describeEnv` reporting "nothing new" rather than
 * claiming credit for a key it did not supply.
 *
 * Files are then consulted in order, first definition winning:
 *
 *   1. $OB1_ENV_FILE   — explicit, for anything unusual
 *   2. evals/.env      — beside the scripts that use it
 *   3. <repo>/.env     — the obvious place to look
 *   4. deploy/.env     — the fork's existing convention, already gitignored
 *
 * `.gitignore` covers `.env` unanchored, so every one of those is ignored at any
 * depth. Only the `.example` files are committed.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

/**
 * Parse one .env file.
 *
 * Deliberately small, and deliberately does NOT strip trailing `#` comments from
 * unquoted values. Dotenv implementations differ on this, and getting it wrong
 * truncates any secret containing a hash — which is a maddening failure, because
 * the key looks present and simply does not work. Quote the value if it needs a
 * comment beside it.
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;

    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = body.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) value = value.slice(1, -1);

    out[key] = value;
  }
  return out;
}

/** Candidate files, in the order they are consulted. */
export function envFiles(): string[] {
  const explicit = process.env.OB1_ENV_FILE;
  return [
    ...(explicit ? [resolve(explicit)] : []),
    join(HERE, ".env"),
    join(REPO_ROOT, ".env"),
    join(REPO_ROOT, "deploy", ".env"),
  ];
}

/**
 * Load the .env files into process.env without overwriting anything already set.
 *
 * Returns the files that were read and the names of the keys each supplied —
 * names only. A loader that prints values is a loader that puts credentials in a
 * terminal scrollback, a CI log, and eventually a screenshot.
 */
export function loadEnv(): { file: string; keys: string[] }[] {
  const loaded: { file: string; keys: string[] }[] = [];

  for (const file of envFiles()) {
    if (!existsSync(file)) continue;

    let parsed: Record<string, string>;
    try {
      parsed = parseEnv(readFileSync(file, "utf8"));
    } catch (e) {
      // Unreadable is worth saying out loud: silently skipping the file someone
      // just wrote their key into is the least helpful thing this could do.
      console.error(`  ⚠  could not read ${file}: ${(e as Error).message}`);
      continue;
    }

    const applied: string[] = [];
    for (const [k, v] of Object.entries(parsed)) {
      // Already set — by the real environment, or by an earlier file in the
      // order above. Either way it wins.
      if (process.env[k] !== undefined && process.env[k] !== "") continue;
      process.env[k] = v;
      applied.push(k);
    }
    loaded.push({ file, keys: applied });
  }

  return loaded;
}

/** One line naming where configuration came from, with no values in it. */
export function describeEnv(loaded: { file: string; keys: string[] }[]): string {
  if (loaded.length === 0) return "no .env file found; using the environment only";
  return loaded
    .map((l) => `${l.file} (${l.keys.length ? l.keys.join(", ") : "nothing new"})`)
    .join(", ");
}
