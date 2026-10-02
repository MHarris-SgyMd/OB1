/**
 * env-file.ts — writing deploy/.env's secrets (SMD-2210, SMD-2285): each
 * profile's provisioning step writes its keys here, the orchestration
 * profile's (orchestration/provision.ts) and the authorization server's
 * (auth/provision.ts). Dependency-free.
 */
import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";

/**
 * Replace or append one KEY=value line, written beside the file and renamed
 * over it so a crash cannot truncate the operator's secrets. A value holding
 * `$`, `#` or whitespace is single-quoted. Compose reads a quoted value
 * literally, and an unquoted bcrypt hash reached the container mangled
 * (measured). A new file is 0600.
 */
export function setEnvValue(file: string, key: string, value: string): void {
  setEnvValues(file, { [key]: value });
}

/**
 * Several lines in one write, so values that must agree (the key, its id,
 * its scopes, its tag) are never left half-written. A run killed between
 * separate writes left a key beside another key's id, and the next run's
 * sweep deleted the working key (review pass 2, measured). A line to replace
 * may carry `export ` or spaces around `=`.
 */
export function setEnvValues(given: string, values: Record<string, string>): void {
  // Written through a symlink to the file it names, so the link stays a link
  // and the secrets land where the operator keeps them (review pass 4: the
  // rename replaced the link with a regular file, and the target kept a dead
  // key and no encryption key).
  const file = existsSync(given) ? realpathSync(given) : given;
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const keys = Object.keys(values);
  const lines = text.split("\n").filter((l) => !keys.some((k) => new RegExp(`^\\s*(export\\s+)?${k}\\s*=`).test(l)));
  if (lines.at(-1) === "") lines.pop();
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  const added = keys.map((k) => {
    const v = values[k];
    if (v.includes("'") || /[\r\n]/.test(v)) throw new Error(`setEnvValue: ${k}'s value holds a single quote or a line break, which the env file cannot carry`);
    return /[$#\s"]/.test(v) ? `${k}='${v}'` : `${k}=${v}`;
  });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, [...lines, ...added, ""].join("\n"), { mode });
  renameSync(tmp, file);
}

/** Is KEY's line in the env file single-quoted? Compose interpolates a bare or double-quoted value, and a bcrypt hash's `$`s are then read as variables. */
export function singleQuoted(file: string, key: string): boolean {
  // The LAST such line, as parseEnv and compose read it (review pass 3: the first was read, and a later bare line won).
  const line = (existsSync(file) ? readFileSync(file, "utf8") : "").split("\n").filter((l) => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(l)).at(-1);
  return line === undefined || /=\s*'[^']*'\s*$/.test(line);
}
