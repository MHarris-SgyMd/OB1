// One env file is one brain (SMD-2873). Before an `up`, `check` says whether this env file's brain is its
// own — no other env file already makes its project — and whether every host port it would publish is free
// or already its own, and refuses a port another brain's container, another of its own services, a second
// mapping of its own or a process on the host holds, naming the setting to change — where compose's own
// bind failure names none.
//
//   bun --no-env-file deploy/instance.ts check [--env-file PATH …] [-f FILE …] [--profile NAME …] [-p NAME] [--runtime docker|podman]
//   bun deploy/instance.ts --self-check
//
// --no-env-file: Bun loads a `.env` in the working directory (and `--env-file` given to bun itself) into this
// script's environment, where compose would read its values as the shell's, over the brain's own env files —
// another port or project than the up's. Run without it, or with a Bun --env-file, the check refuses, naming
// the command.
//
// The ports are compose's own render of the brain (`config --format json`), under its env files, files, profiles
// and project name, as the `up` will be given them (COMPOSE_PROFILES in the env file counts, as for `up`; a
// COMPOSE_FILE there, which compose's own interpolation reads, asks for the same files with -f). Each port's
// setting is read from the compose files' own mapping, the house form check 13 of
// scripts/check-fork-consistency.ts holds, "${X_BIND:-127.0.0.1}:${X_PORT:-N}:C" (read a little more widely
// here: any names, any default address). Who holds a port is read from every container, stopped ones included
// (one takes its port back when it starts; Docker's stopped ones through their port bindings), of every runtime
// on PATH, by compose's labels: its project, its service, and the env files it was made from — the label compose
// writes for --env-file or COMPOSE_ENV_FILES, or, made with neither, the `.env` of its project's directory. A
// port no container publishes but a connection reaches is a process on the host. Exit 0 when the brain is its
// own and every port free or its own, 2 otherwise. Where compose fails, its own words are never printed, since
// they can quote the env files' values: the check says what failed from a line number, a setting's name and its
// own reading of the files, and names the `compose … config --quiet` that prints compose's words.
import { readFileSync, existsSync, realpathSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import net from "node:net";

const HERE = import.meta.dir;
const USAGE = "usage: bun --no-env-file deploy/instance.ts check [--env-file PATH …] [-f FILE …] [--profile NAME …] [-p NAME] [--runtime docker|podman]\n       bun deploy/instance.ts --self-check";

/** A published port's setting, as a compose file's house-form mapping names it. */
export type Knob = { service: string; target: number; port: string; bind: string };
const HOUSE = /^\$\{([A-Z][A-Z0-9_]*):-[^}]*\}:\$\{([A-Z][A-Z0-9_]*):-\d+\}:(\d+)$/;

/** Each house-form mapping in a compose file's text, by service and container port. */
export function knobsIn(text: string): Knob[] {
  let doc: unknown;
  try { doc = Bun.YAML.parse(text); } catch { return []; }
  const services = (doc as { services?: Record<string, { ports?: unknown }> } | null)?.services ?? {};
  const out: Knob[] = [];
  for (const [service, def] of Object.entries(services)) {
    const ports = Array.isArray(def?.ports) ? def.ports : [];
    for (const p of ports) {
      const m = typeof p === "string" ? HOUSE.exec(p.trim()) : null;
      if (m) out.push({ service, target: Number(m[3]), bind: m[1], port: m[2] });
    }
  }
  return out;
}

/** A host port compose's render publishes, one per port of a range. */
export type Published = { service: string; target: number; hostIp: string; port: number; protocol: string };

/** The published ports in compose's `config --format json`; a range (`9100-9102`) is each of its ports. */
export function publishedIn(rendered: { services?: Record<string, { ports?: { target?: number; published?: string | number; host_ip?: string; protocol?: string }[] }> }): Published[] {
  const out: Published[] = [];
  for (const [service, def] of Object.entries(rendered.services ?? {})) {
    for (const p of def.ports ?? []) {
      if (p.published === undefined || p.published === "") continue;
      const [from, to = from] = String(p.published).split("-").map(Number);
      for (let port = from; port <= to; port++) out.push({ service, target: Number(p.target), hostIp: p.host_ip ?? "", port, protocol: p.protocol ?? "tcp" });
    }
  }
  return out;
}

/** A container: id, name, published ports' text, compose project, service, state, env-file label, project dir. */
export type Container = { id: string; fullId: string; name: string; ports: string; project: string; service: string; state: string; envFile: string; workingDir: string };
/** `ps` lists every container, stopped ones included (-a), in this form, one a line. */
export const PS_ARGS = ["ps", "-a", "--no-trunc", "--format", '{{.ID}}|{{.Names}}|{{.Ports}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}|{{.State}}|{{.Label "com.docker.compose.project.environment_file"}}|{{.Label "com.docker.compose.project.working_dir"}}'];

/** The containers `ps` lists with PS_ARGS. */
export function containersIn(listing: string): Container[] {
  return listing.split("\n").filter((l) => l.includes("|")).map((l) => {
    const [id = "", name = "", ports = "", project = "", service = "", state = "", envFile = "", workingDir = ""] = l.split("|");
    return { id: id.slice(0, 12), fullId: id, name, ports, project, service, state: state.toLowerCase(), envFile, workingDir };
  });
}

/** A stopped container's port bindings (`inspect`'s HostConfig.PortBindings JSON) as `ps` would print them running. */
export function portsFromBindings(json: string): string {
  let b: Record<string, { HostIp?: string; HostPort?: string }[] | null> = {};
  try { b = JSON.parse(json) ?? {}; } catch { return ""; }
  const out: string[] = [];
  for (const [target, binds] of Object.entries(b)) {
    const [port, protocol = "tcp"] = target.split("/");
    for (const x of binds ?? []) {
      if (!x.HostPort) continue;
      const ip = x.HostIp || "0.0.0.0";
      out.push(`${ip.includes(":") ? `[${ip}]` : ip}:${x.HostPort}->${port}/${protocol}`);
    }
  }
  return out.join(", ");
}

/** One host binding of a container's ports text: `127.0.0.1:8010->8000/tcp`, `[::]:9000-9002->…/udp`, podman's `:::8010->…`. */
export type Binding = { ip: string; from: number; to: number; protocol: string };
export function bindingsIn(ports: string): Binding[] {
  const out: Binding[] = [];
  for (const part of ports.split(",")) {
    // The address is everything before the last colon: docker brackets an IPv6 one, podman does not.
    const m = /^(?:\[([^\]]*)\]|(.*)):(\d+)(?:-(\d+))?->[\d-]+\/(\w+)$/.exec(part.trim());
    if (m) out.push({ ip: m[1] ?? m[2] ?? "", from: Number(m[3]), to: Number(m[4] ?? m[3]), protocol: m[5] });
  }
  return out;
}

const WILDCARD = new Set(["", "0.0.0.0", "::"]);
/** Whether two host addresses can collide: either binds every address, or both are the same one. */
export const overlaps = (a: string, b: string) => WILDCARD.has(a) || WILDCARD.has(b) || a === b;
/** Whether a container's ports text holds PORT for a mapping on HOST_IP and PROTOCOL. */
export function holds(ports: string, p: Pick<Published, "hostIp" | "port" | "protocol">): boolean {
  return bindingsIn(ports).some((b) => b.protocol === p.protocol && p.port >= b.from && p.port <= b.to && overlaps(b.ip, p.hostIp));
}

const real = (f: string) => { try { return realpathSync(f); } catch { return resolve(f); } };
/** The env files a container was made from: compose's label (given --env-file or COMPOSE_ENV_FILES), else its project directory's `.env`. */
export function envFilesOf(c: Pick<Container, "envFile" | "workingDir">): string[] {
  const labelled = c.envFile.split(",").map((f) => f.trim()).filter(Boolean);
  return labelled.length ? labelled : c.workingDir ? [join(c.workingDir, ".env")] : [];
}
/** Whether a container was made from exactly these env files; one that says nothing of them (an older compose) is let be. */
export function sameEnvFiles(c: Pick<Container, "envFile" | "workingDir">, envFiles: string[]): boolean {
  const theirs = envFilesOf(c);
  if (!theirs.length) return true;
  const a = new Set(theirs.map(real)), b = new Set(envFiles.map(real));
  return a.size === b.size && [...a].every((f) => b.has(f));
}

/** How a port is told: where it binds, the setting the compose files' house-form mapping names, and its fix. */
export function portWords(p: Published, knobs: Knob[], shown: string): { setting: string; fix: string; where: string } {
  const k = knobs.filter((x) => x.service === p.service && x.target === p.target).at(-1);
  return {
    setting: k ? `${k.port} (${p.service}'s port; ${k.bind} its address)` : `${p.service}'s port ${p.target}, a mapping in the compose files`,
    fix: k ? `set ${k.port} in ${shown} to a free port` : `change ${p.service}'s mapping`,
    where: `${p.hostIp.includes(":") ? `[${p.hostIp}]` : p.hostIp || "0.0.0.0"}:${p.port}${p.protocol === "tcp" ? "" : "/" + p.protocol}`,
  };
}
/** A finding: its line, and whether it lets the up go. */
export type Verdict = { ok: boolean; line: string };
/** A port left to dial, and this brain's own stopped container that takes it when it starts, if one does. */
export type Undecided = Published & { own?: Container };
/** What a check decides before any connection: one line per finding, and which ports are left to dial. */
export function decide(o: { project: string; envFiles: string[]; published: Published[]; containers: Container[]; knobs: Knob[]; nameFrom?: string }): { verdicts: Verdict[]; undecided: Undecided[] } {
  const verdicts: Verdict[] = [];
  const undecided: Undecided[] = [];
  const shown = o.envFiles.join(", ");
  // This brain's containers: its project, made from its env files. Its project made from other env files is
  // another brain under the same name, which an up from these would recreate with these settings.
  const mine = (c: Container) => c.project === o.project && sameEnvFiles(c, o.envFiles);
  const others = [...new Set(o.containers.filter((c) => c.project === o.project && !mine(c)).map((c) => envFilesOf(c).join(", ")))];
  for (const f of others) verdicts.push({ ok: false, line: `✗ project ${o.project} was made from ${f}, not ${shown}: an up from this file would recreate that brain's containers with this file's settings. If this is that brain's env file, moved or renamed, recreate it from here (up -d --force-recreate with this file, the same profiles and --remove-orphans); otherwise ${o.nameFrom ? `give this brain a project name of its own in place of ${o.nameFrom}'s` : "give this file a COMPOSE_PROJECT_NAME of its own"}.` });
  // A holder holds the port now (running, paused, restarting), or takes it when it starts: back, or first.
  const now = (c: Container) => ["running", "paused", "restarting", ""].includes(c.state);
  const state = (c: Container) => now(c) ? " —" : c.state === "created" ? ", created: it takes the port when it first starts — remove it, or" : `, ${c.state}: it takes the port back when it starts (a restart policy, a reboot) — remove it, or`;
  for (const [i, p] of o.published.entries()) {
    const { setting, fix, where } = portWords(p, o.knobs, shown);
    if (p.port === 0) { verdicts.push({ ok: true, line: `✓ ${where}: ${setting} — 0, so compose picks a free port` }); continue; }
    const twin = o.published.find((q, j) => j < i && q.port === p.port && q.protocol === p.protocol && overlaps(q.hostIp, p.hostIp));
    if (twin) { verdicts.push({ ok: false, line: `✗ ${where}: ${setting} — ${twin.service}'s mapping in this same brain asks for it too; ${fix}.` }); continue; }
    const on = o.containers.filter((c) => holds(c.ports, p));
    // Of several of a kind (a replica, a recreate's leftover, two engines), the one holding it now (review pass 7).
    const pick = (of: Container[]) => of.find(now) ?? of[0];
    const own = pick(on.filter((c) => mine(c) && c.service === p.service));
    const sibling = pick(on.filter((c) => mine(c) && c.service !== p.service));
    const other = pick(on.filter((c) => !mine(c)));
    // This brain's own holding it now keeps it: a stopped rival is the rival's start to fail, not this up (review pass 6).
    const rivals = on.filter((c) => c !== own);
    if (own && now(own) && !rivals.some(now)) verdicts.push({ ok: true, line: `✓ ${where}: ${setting} — held by this brain's ${own.service}${rivals.map((c) => `; ${c.name}, of project ${c.project || "(none)"}, ${c.state}, asks for it too and cannot start beside this brain: remove it, or move its port`).join("")}` });
    // Another brain's before this brain's other service, unless only the latter holds it now (review pass 8).
    else if (other && !(sibling && now(sibling) && !now(other))) verdicts.push({ ok: false, line: `✗ ${where}: ${setting} — published by ${other.name}, of project ${other.project || "(none)"}${other.project === o.project ? ` made from ${envFilesOf(other).join(", ")}` : ""}${state(other)} ${fix}.` });
    else if (sibling) verdicts.push({ ok: false, line: `✗ ${where}: ${setting} — published by this brain's own ${sibling.service} (${sibling.name})${state(sibling)} ${fix}.` });
    // Its own, stopped: the port is free for it only if nothing on the host took it meanwhile, so it is dialled.
    else undecided.push(own ? { ...p, own } : p);
  }
  return { verdicts, undecided };
}

/** Whether something accepts a connection on HOST:PORT within a second. */
export function listens(host: string, port: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = net.connect({ host, port });
    const done = (v: boolean) => { s.destroy(); ok(v); };
    s.setTimeout(1000, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

function run(cmd: string[]): { ok: boolean; out: string; err: string } {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString() };
}
/** A runtime's reason (ps, inspect), as its last line: docker's "Run '…' for more information" and colour codes left out. */
export const reason = (err: string) => err.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim()).filter((l) => l && !/^(Run|See) '.*' for more information\.?$/.test(l)).at(-1) ?? "";

/** An env file's parse error, by its kind: compose's own words quote the line, or the value in it. */
const PARSE_KINDS: [RegExp, string][] = [
  [/unterminated quoted value/, "an unterminated quoted value"],
  [/unexpected character .* in variable name/, "an unexpected character in a variable name"],
  [/key cannot contain a space/, "a key with a space in it"],
  [/invalid template/i, "an invalid template (a ${ that does not close)"],
  [/is missing a value/, "a required variable with no value"],
];
/** A compose that did not run at all: a runtime with no compose plugin or provider. */
const NO_COMPOSE = /unknown command|is not a docker command|looking up compose provider failed|executable file not found/i;

/** A setting of an env file as compose's dotenv reads one: its key and line; a one-line value as compose reads it
 *  (an unquoted one cut at " #"); its quote; for a quoted value run over lines, the line its quote closes on (0:
 *  none) and whether another statement, or a failure, follows the close on that line: a quote left open by mistake. */
export type Setting = { key: string; value: string; line: number; quote: string; closes?: number; runOn?: boolean };
/** An env file's settings, read by compose-go's dotenv grammar (dotenv/parser.go): statement by statement, its keys'
 *  characters (letters, digits, _ . - [ ] in any script), `\` escaping in either quote, a value spanning lines, a
 *  statement after a closing quote; to where compose fails, or to the first quote left open, past which what reads
 *  as a setting may be a value's text (review passes 13 and 14). */
export function settingsIn(text: string): Setting[] {
  const src = Array.from(text.startsWith("\uFEFF") ? text.slice(1) : text);
  const lineAt: number[] = [];
  for (let i = 0, n = 1; i <= src.length; i++) { lineAt.push(n); if (src[i] === "\n") n++; }
  const lineSpace = (c: string) => "\t\v\f\r \u0085\u00a0".includes(c);
  const space = (c: string) => c === "\n" || lineSpace(c) || (c !== "\uFEFF" && /\s/u.test(c));
  // Go's unicode.IsSpace, which compose-go trims by: no U+FEFF, which JS's \s counts (review pass 15).
  const trimEnd = (s: string) => s.replace(/[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/u, "");
  const keyChar = (c: string) => "_.-[]".includes(c) || /[\p{L}\p{N}]/u.test(c);
  const out: Setting[] = [];
  let pos = 0, lastClose = -1;
  // A failure, or a statement, on a run-over quote's closing line: that quote was left open.
  const after = (at: number) => { const prev = out.at(-1); if (prev?.closes && lastClose >= 0 && !src.slice(lastClose + 1, at).includes("\n")) { prev.runOn = true; return true; } return false; };
  for (;;) {
    while (pos < src.length && (space(src[pos]) || src[pos] === "#")) { if (src[pos] === "#") while (pos < src.length && src[pos] !== "\n") pos++; else pos++; }
    if (pos >= src.length) return out;
    const start = pos;
    let k = pos;
    if (/^export[\t\n\f\r ]/.test(src.slice(k, k + 7).join(""))) { k += 6; while (k < src.length && lineSpace(src[k])) k++; }
    let key: string | undefined, inherited = false, i = k;
    for (; i < src.length; i++) {
      const c = src[i];
      if (lineSpace(c) || keyChar(c)) continue;
      if (c === "=" || c === ":" || c === "\n") { key = src.slice(k, i).join(""); inherited = c === "\n"; break; }
      after(i); return out;
    }
    if (key === undefined) return out;
    if (after(start)) return out;
    key = trimEnd(key);
    if (key.includes(" ")) return out;
    const line = lineAt[k];
    if (inherited) { pos = i + 1; lastClose = -1; continue; }
    let v = i + 1;
    while (v < src.length && lineSpace(src[v])) v++;
    const q = src[v];
    if (q !== '"' && q !== "'") {
      let end = v; while (end < src.length && src[end] !== "\n") end++;
      const raw = src.slice(v, end).join(""), cut = raw.indexOf(" #");
      out.push({ key, value: trimEnd(cut < 0 ? raw : raw.slice(0, cut)), line, quote: "" });
      pos = end; lastClose = -1; continue;
    }
    let j = v + 1, esc = false;
    for (; j < src.length; j++) { if (esc) esc = false; else if (src[j] === "\\") esc = true; else if (src[j] === q) break; }
    if (j >= src.length) { out.push({ key, value: "", line, quote: q, closes: 0, runOn: true }); return out; }
    const multi = src.slice(v, j).includes("\n");
    out.push({ key, value: multi ? "" : src.slice(v + 1, j).join(""), line, quote: q, ...(multi ? { closes: lineAt[j] } : {}) });
    pos = j + 1; lastClose = j;
  }
}
/** A key the check prints: an ordinary variable's name. Past compose's grammar nothing prints, and an odd key may be
 *  the text of a value read wrong: "a setting" in its place. */
const nameOf = (s: Setting) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.key) ? s.key : "a setting");
/** Where an env file opens a quote left open, or a ${ with no }: names and line numbers alone. */
export function openings(text: string): string[] {
  return settingsIn(text).flatMap((s) =>
    s.runOn ? [`line ${s.line} (${nameOf(s)}) opens a quote ${s.closes ? `that only line ${s.closes} closes, with more after it` : "nothing closes"}, and compose reads on from there`]
    : s.quote !== "'" && s.closes === undefined && /\$\{(?![^}]*\})/.test(s.value) ? [`line ${s.line} (${nameOf(s)}) holds a \${ with no }`] : []);
}

/** What compose's failure was, told only from what cannot hold an env file's value: fixed words, a line number, a
 *  variable's name, the env files' own paths, the check's own reading of the env files (where a quote or ${ stays
 *  open, by key and line; a port or address that is none, which are no secrets) and the compose files' own words
 *  for a `${X:?…}`. Compose's words are never printed: they quote the env files' values, escaped, decoded or run on
 *  from a line before, past any cutting of them (review passes 10–12). */
export function explain(err: string, ctx: { envs: string[]; envTexts: string[]; composeTexts: string[]; fromFlag: boolean; unparsed?: string[] }): string {
  const s = err.replace(/\x1b\[[0-9;]*m/g, "");
  // A quote left open runs the next lines into a value, whatever compose then says of it.
  const opens = () => { const o = ctx.envTexts.flatMap((text, i) => openings(text).map((x) => (ctx.envs.length > 1 ? `${ctx.envs[i]}: ${x}` : x))).slice(0, 3); return o.length ? `; ${o.join("; ")}` : ""; };
  if (NO_COMPOSE.test(s)) return "no compose ran: install Docker Compose v2.23.1 or later (the docker compose plugin, or docker-compose for podman compose)";
  if (/failed to read /.test(s)) {
    const at = ctx.envs.findIndex((e) => s.includes(`failed to read ${e}:`));
    // Compose's line for a quote nothing closes is past the end of the file: the opener is named instead.
    const n = /unterminated quoted value/.test(s) ? undefined : /failed to read .*?: line (\d+):/.exec(s)?.[1];
    // A required variable's name is told only where it is a setting's or a compose file's: it is a value's text.
    const asked = /required variable ([A-Za-z0-9_]+) is missing/.exec(s)?.[1];
    const name = asked && ((at >= 0 && settingsIn(ctx.envTexts[at]).some((x) => x.key === asked)) || ctx.composeTexts.some((c) => c.includes(`\${${asked}`))) ? asked : undefined;
    const kind = (PARSE_KINDS.find(([re]) => re.test(s))?.[1] ?? "a line compose could not read") + (name ? ` (${name})` : "");
    const open = at >= 0 ? openings(ctx.envTexts[at]).slice(0, 3) : [];
    return `${at >= 0 ? ctx.envs[at] : "an env file"}${n ? `, line ${n}` : ""}: ${kind}${open.length ? `; ${open.join("; ")}` : ""}`;
  }
  const missing = /required variable ([A-Za-z0-9_]+) is missing a value/.exec(s)?.[1];
  if (missing) {
    const said = ctx.composeTexts.map((c) => new RegExp(`\\$\\{${missing}:?\\?([^}]*)\\}`).exec(c)?.[1]?.trim()).find(Boolean);
    return `${missing} is not set${said ? `: ${said}` : ""}`;
  }
  if (/invalid (host ?port|port|ip address|published)/i.test(s)) {
    // Names alone: a value that is no port may be a line run into it, or a comment (review pass 13).
    // Each key's last setting, as compose keeps it; a value set from another setting is no judge's to make.
    const bad = ctx.envTexts.flatMap((text) => [...new Map(settingsIn(text).map((x) => [x.key, x])).values()].flatMap((x) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*_(PORT|BIND)$/.test(x.key) || x.closes !== undefined) return [];
      if (x.quote !== "'" && /\$(\{|[A-Za-z_])/.test(x.value.replace(/\$\$/g, ""))) return [`${x.key}, set from another setting,`];
      const ok = x.key.endsWith("_PORT") ? /^\d{0,5}$/.test(x.value) && Number(x.value) <= 65535 : x.value === "" || net.isIP(x.value.replace(/^\[(.*)\]$/, "$1")) !== 0;
      return ok ? [] : [`${x.key} is not ${x.key.endsWith("_PORT") ? "a port number" : "an IP address"}`];
    }));
    return (bad.length ? bad.join("; ") : "a port or an address in this brain's mappings is not one compose can read") + opens();
  }
  if (/invalid project name/i.test(s)) return `the project name${ctx.fromFlag ? " given with -p" : " (COMPOSE_PROJECT_NAME, or the compose file's name:)"} must be lowercase letters, digits, - and _, from a letter or digit${opens()}`;
  return `compose could not render this brain${ctx.unparsed?.length ? `: ${ctx.unparsed.join(", ")} ${ctx.unparsed.length > 1 ? "are" : "is"} not YAML` : ""}${opens()}`;
}

/** Why this run's environment may hold values Bun loaded from env files, or nothing: --no-env-file, and no Bun --env-file. */
export function bunEnvProblem(execArgv: string[]): string {
  if (execArgv.some((a) => a === "--env-file" || a.startsWith("--env-file="))) return "bun was given --env-file, which loads that file into this check's environment";
  if (!execArgv.includes("--no-env-file")) return "Bun would load a .env, .env.local or .env.<mode> in the working directory, were one there, into this check's environment";
  return "";
}
/** An argument as a shell would read it back: single-quoted where it holds anything but plain characters. */
export const shellQuote = (a: string) => /^[A-Za-z0-9_./:@%+,-][A-Za-z0-9_./:=@%+,-]*$/.test(a) ? a : `'${a.replace(/'/g, `'"'"'`)}'`;

/** The env files compose reads with no --env-file: COMPOSE_ENV_FILES (comma-separated, as given), else the first file's directory's .env. */
export function defaultEnvFiles(files: string[], composeEnvFiles = "", fallbackDir = ""): string[] {
  if (composeEnvFiles) return composeEnvFiles.split(",").filter((f) => f !== "");
  return [join(files.length ? dirname(resolve(files[0])) : fallbackDir, ".env")];
}

async function check(args: string[]) {
  const loaded = bunEnvProblem(process.execArgv);
  if (loaded) { console.error(`${loaded}, where compose reads its values as the shell's, over the brain's own env files. Run it as: bun --no-env-file ${[process.argv[1] ?? "deploy/instance.ts", "check", ...args].map(shellQuote).join(" ")}`); process.exit(2); }
  const envFiles: string[] = [];
  const files: string[] = [];
  const profiles: string[] = [];
  let runtime = "", projectName = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i], v = args[i + 1];
    const value = () => { if (v === undefined || v.startsWith("-") || !v.trim()) { console.error(`${a} takes a value.`); process.exit(2); } i++; return v; };
    if (a === "--env-file") envFiles.push(value());
    else if (a === "-f" || a === "--file") files.push(value());
    else if (a === "--profile") profiles.push(value());
    else if (a === "-p" || a === "--project-name") projectName = value();
    else if (a === "--runtime") runtime = value();
    else if (a === "-h" || a === "--help") { console.log(USAGE); process.exit(0); }
    else { console.error(`unknown argument: ${a}\n${USAGE}`); process.exit(2); }
  }
  const given = [...files];
  // COMPOSE_DISABLE_ENV_FILE leaves compose reading no env file at all, which no check here mirrors.
  if (!envFiles.length && /^(1|t|true)$/i.test(process.env.COMPOSE_DISABLE_ENV_FILE ?? "")) { console.error("COMPOSE_DISABLE_ENV_FILE is set, so compose reads no env file: give the check the one the brain runs from with --env-file."); process.exit(2); }
  // With no --env-file, compose reads COMPOSE_ENV_FILES, else the .env of the project's directory: the first
  // -f file's (review pass 4: deploy/.env was read for a compose file elsewhere), or deploy/'s with none.
  if (!envFiles.length) envFiles.push(...defaultEnvFiles(given, process.env.COMPOSE_ENV_FILES ?? "", HERE));
  if (!envFiles.length) { console.error("COMPOSE_ENV_FILES names no file."); process.exit(2); }
  for (const f of envFiles) if (!existsSync(f)) { console.error(`no file at ${f}`); process.exit(2); }
  const envs = envFiles.map((f) => resolve(f));
  if (runtime && runtime !== "docker" && runtime !== "podman") { console.error(`--runtime takes docker or podman, not ${runtime}.`); process.exit(2); }
  if (runtime && !Bun.which(runtime)) { console.error(`--runtime ${runtime} is not on PATH.`); process.exit(2); }
  const envTexts = envs.map((f) => { try { return readFileSync(f, "utf8"); } catch (e) { console.error(`cannot read ${f}: ${(e as NodeJS.ErrnoException).code ?? e}`); process.exit(2); } });
  // Every runtime on PATH runs containers of its own, which hold ports alike; --runtime reads one alone.
  const runtimes = runtime ? [runtime] : ["docker", "podman"].filter((r) => Bun.which(r));
  if (!runtimes.length) { console.error("neither docker nor podman is on PATH."); process.exit(2); }
  const compose = (extra: string[], fs: string[], rt = runtimes[0]) => [rt, "compose", ...envs.flatMap((f) => ["--env-file", f]), ...(projectName ? ["-p", projectName] : []), ...fs.flatMap((f) => ["-f", f]), ...profiles.flatMap((p) => ["--profile", p]), ...extra];
  // A compose failure, told without compose's words (explain), of the first runtime whose compose ran, and the
  // command that prints compose's own words for the operator who would read them.
  const fail = (errs: string[], fs: string[], what: string): never => {
    const i = Math.max(0, errs.findIndex((e) => !NO_COMPOSE.test(e)));
    const read = fs.map((f) => { try { return readFileSync(f, "utf8"); } catch { return null; } });
    const composeTexts = read.filter((x): x is string => x !== null);
    // A compose file that is no YAML is named: its text is the compose file's, no env file's.
    const unparsed = fs.filter((_, k) => { try { Bun.YAML.parse(read[k] ?? ""); return false; } catch { return true; } });
    console.error(`${explain(errs[i] ?? "", { envs, envTexts, composeTexts, fromFlag: Boolean(projectName), unparsed })}\n${what} Its own words are left out, since they can quote the env files' values; they are printed by: ${compose(["config", "--quiet"], fs, runtimes[i]).map(shellQuote).join(" ")}`);
    process.exit(2);
  };
  if (!given.length) {
    // A COMPOSE_FILE in the env files or the shell picks the files an `up` with no -f reads; the check is given
    // them with -f. Compose's own interpolation of it into a stub says which, on any compose, each runtime's in
    // turn (review pass 10: `config --environment`, missing before 2.28, printed a multi-line value's lines).
    const stubFile = 'name: x\nservices:\n  s:\n    image: x\n    labels:\n      f: "${COMPOSE_FILE:-}"\n';
    const probe = (rt: string) => Bun.spawnSync(compose(["config", "--format", "json"], ["-"], rt), { stdin: new TextEncoder().encode(stubFile), stdout: "pipe", stderr: "pipe" });
    const tried = [probe(runtimes[0])];
    for (const rt of runtimes.slice(1)) if (tried.at(-1)!.exitCode !== 0) tried.push(probe(rt));
    const stub = tried.at(-1)!;
    if (stub.exitCode !== 0) fail(tried.map((s) => s.stderr.toString()), [join(HERE, "compose.yaml")], "compose could not read this brain's settings.");
    let picked: string | undefined;
    try { picked = (JSON.parse(stub.stdout.toString()) as { services?: { s?: { labels?: { f?: string } } } }).services?.s?.labels?.f; } catch { /* left undefined */ }
    if (picked === undefined) { console.error("compose's render of a stub said nothing of COMPOSE_FILE: give the check its files with -f."); process.exit(2); }
    // Any value, blank too, is one an up reads (compose refuses a blank one itself). Not printed: a quote left open
    // above it runs other settings into it, or it interpolates one (review pass 12).
    if (picked !== "") { console.error(`COMPOSE_FILE is set${process.env.COMPOSE_FILE !== undefined ? " in the shell" : ` in ${envs.join(", ")}`} and names the files an up of this brain reads: give the check the same files with -f.`); process.exit(2); }
    files.push(join(HERE, "compose.yaml"));
  }
  for (const f of files) if (!existsSync(f)) { console.error(`no file at ${f}`); process.exit(2); }

  // The runtime's compose, then the other's: one runtime may lack the compose plugin (review pass 5).
  const renders = [run(compose(["config", "--format", "json"], files))];
  for (const rt of runtimes.slice(1)) if (!renders.at(-1)!.ok) renders.push(run(compose(["config", "--format", "json"], files, rt)));
  const r = renders.at(-1)!;
  if (!r.ok) fail(renders.map((x) => x.err), files, `compose could not render the brain from ${envs.join(", ")}.`);
  const rendered = JSON.parse(r.out) as { name: string } & Parameters<typeof publishedIn>[0];
  const project = rendered.name;
  const knobs = files.flatMap((f) => knobsIn(readFileSync(f, "utf8")));

  const seen = new Set<string>();
  const containers: Container[] = [];
  const failed: [string, string][] = [];
  const unreadable: string[] = [];
  for (const rt of runtimes) {
    const ps = run([rt, ...PS_ARGS]);
    if (!ps.ok) { failed.push([rt, reason(ps.err)]); continue; }
    const listed = containersIn(ps.out).filter((c) => !seen.has(c.id));
    // Docker prints no ports for a stopped container: its bindings are read from its config.
    const quiet = listed.filter((c) => c.state !== "running" && !c.ports);
    if (quiet.length) {
      const insp = run([rt, "inspect", "-f", "{{.Id}}|{{json .HostConfig.PortBindings}}", ...quiet.map((c) => c.fullId)]);
      const printed = new Set<Container>();
      for (const line of insp.out.split("\n")) {
        const [id = "", json = ""] = line.split("|");
        const c = quiet.find((q) => q.fullId === id || (q.fullId.length < id.length && id.startsWith(q.fullId)));
        if (c) { c.ports = portsFromBindings(json); printed.add(c); }
      }
      // One inspect printed nothing for was removed since `ps`, and holds nothing, or is there unread, with ports
      // nobody knows: a fresh list tells which, and with no list, each is unread (review pass 6).
      const missed = quiet.filter((q) => !printed.has(q));
      if (missed.length) {
        const again = run([rt, "ps", "-aq", "--no-trunc"]);
        const still = again.ok ? again.out.split("\n").map((l) => l.trim()).filter(Boolean) : null;
        const unread = missed.filter((q) => !still || still.some((s) => s.startsWith(q.fullId) || q.fullId.startsWith(s)));
        if (unread.length) unreadable.push(`${rt} inspect: ${reason(insp.err) || "no bindings printed"} — the ports of ${unread.map((c) => c.name).join(", ")} (stopped) could not be read`);
      }
    }
    // docker and podman may read the same engine (podman's docker socket): a container, by its id, once.
    for (const c of listed) { seen.add(c.id); containers.push(c); }
  }
  if (failed.length === runtimes.length) { console.error(`${failed.map(([rt, why]) => `${rt} ps: ${why}`).join("\n")}\nno container list could be read, so who holds each port is not known. Start the runtime that runs the brains (podman machine start, or the Docker daemon) and rerun.`); process.exit(2); }
  for (const [rt, why] of failed) console.log(`· ${rt} ps: ${why} — ${rt}'s containers were not read, so a stopped one of its would go unseen; --runtime ${runtimes.find((r) => r !== rt)} reads the other alone`);

  const published = publishedIn(rendered);
  if (!published.length) console.log(`${project}: publishes no host port`);
  // A project taken down keeps its volumes and no container to say which env file made it (review pass 5).
  if (!containers.some((c) => c.project === project)) {
    const vols = [...new Set(runtimes.flatMap((rt) => run([rt, "volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`]).out.split("\n").filter(Boolean)))];
    if (vols.length) console.log(`· project ${project} has volumes (${vols.join(", ")}) and no container: an up from this env file mounts them. Be sure this env file is that brain's.`);
  }
  const nameFrom = projectName ? "-p" : process.env.COMPOSE_PROJECT_NAME ? "the shell's COMPOSE_PROJECT_NAME" : "";
  const { verdicts, undecided } = decide({ project, envFiles: envs, published, containers, knobs, nameFrom });
  // With unread holders, a port no container read holds is not known to be free: refused, unknown.
  if (published.length) for (const u of unreadable) verdicts.push({ ok: false, line: `✗ ${u}: a port they take back when they start may be one of these. Rerun the check.` });
  for (const p of undecided) {
    const { setting, fix, where } = portWords(p, knobs, envs.join(", "));
    // A process no container list shows answers a connection; a wildcard bind meets one on loopback. UDP is not dialled.
    if (p.protocol === "tcp" && await listens(WILDCARD.has(p.hostIp) ? "127.0.0.1" : p.hostIp, p.port)) {
      verdicts.push({ ok: false, line: `✗ ${where}: ${setting} — something on this host that is no container already listens there. Stop it, or ${fix}.` });
    } else if (unreadable.length) verdicts.push({ ok: false, line: `? ${where}: ${setting} — unknown: some stopped containers could not be read, and may take it when they start` });
    else verdicts.push({ ok: true, line: `✓ ${where}: ${setting} — free${p.own ? `, for this brain's ${p.own.service} (${p.own.name}, ${p.own.state}) to take when it starts` : ""}` });
  }
  for (const v of verdicts) (v.ok ? console.log : console.error)(v.line);
  const refused = verdicts.filter((v) => !v.ok).length;
  if (refused) { console.error(`${project}: ${refused} refusal${refused === 1 ? "" : "s"} — its up would fail, or act on another brain.`); process.exit(2); }
}

async function selfCheck() {
  const compose = `services:
  forwarder:
    ports:
      - "\${SERVER_BIND:-127.0.0.1}:\${SERVER_PORT:-8000}:8000"
  n8n:
    ports:
      - "\${N8N_BIND:-127.0.0.1}:\${N8N_PORT:-5678}:5678"
  odd:
    ports:
      - "9000:9000"
`;
  const knobs = knobsIn(compose);
  const env = "/srv/ob1/deploy/.env.ob1b.local";
  const c = (name: string, ports: string, project: string, service: string, state = "running", envFile = env, workingDir = "/srv/ob1/deploy"): Container => ({ id: name, fullId: name, name, ports, project, service, state, envFile, workingDir });
  const cs = [
    c("open-brain-forwarder-1", "127.0.0.1:8010->8000/tcp", "open-brain", "forwarder", "running", "", "/srv/ob1/deploy"),
    c("ob1b-forwarder-1", "127.0.0.1:8040->8000/tcp", "ob1b", "forwarder"),
    c("ob1b-n8n-1", "127.0.0.1:5678->5678/tcp", "ob1b", "n8n"),
    c("squat", "0.0.0.0:8080->80/tcp, [::]:8080->80/tcp", "", ""),
    c("old", "127.0.0.1:8090->8000/tcp", "oldbrain", "forwarder", "exited", "/x/.env"),
  ];
  const pub = (port: number, service = "forwarder", hostIp = "127.0.0.1", protocol = "tcp", target = 8000): Published => ({ service, target, hostIp, port, protocol });
  const one = (project: string, published: Published[], containers = cs, envFiles = [env]) => decide({ project, envFiles, published, containers, knobs });
  const line = (d: ReturnType<typeof decide>) => d.verdicts.map((v) => v.line).join(" | ");
  const realFiles = readdirSync(HERE).filter((f) => /^compose.*\.ya?ml$/.test(f)).map((f) => join(HERE, f));
  const realMappings = realFiles.flatMap((f) => {
    const doc = Bun.YAML.parse(readFileSync(f, "utf8")) as { services?: Record<string, { ports?: unknown[] }> };
    return Object.values(doc.services ?? {}).flatMap((s) => (Array.isArray(s?.ports) ? s.ports : []));
  });
  const realKnobs = realFiles.flatMap((f) => knobsIn(readFileSync(f, "utf8")));
  // A real file and a symlink to it, for the env-file identity read through realpath.
  const { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync, chmodSync } = await import("node:fs");
  const tmp = mkdtempSync(join((await import("node:os")).tmpdir(), "ob1-instance-"));
  // Scratch goes whatever ends the run: a throw in a row too (review pass 9).
  const scratch = [tmp];
  process.once("exit", () => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });
  writeFileSync(join(tmp, ".env.a.local"), "X=1\n");
  symlinkSync(join(tmp, ".env.a.local"), join(tmp, "link.env"));
  writeFileSync(join(tmp, ".env"), "X=1\n");
  const viaLink = sameEnvFiles({ envFile: join(tmp, "link.env"), workingDir: "" }, [join(tmp, ".env.a.local")]);
  const comma = sameEnvFiles({ envFile: `${join(tmp, ".env")},${join(tmp, ".env.a.local")}`, workingDir: "" }, [join(tmp, ".env.a.local"), join(tmp, ".env")]);
  const commaPart = sameEnvFiles({ envFile: `${join(tmp, ".env")},${join(tmp, ".env.a.local")}`, workingDir: "" }, [join(tmp, ".env.a.local")]);
  const commaMore = sameEnvFiles({ envFile: join(tmp, ".env"), workingDir: "" }, [join(tmp, ".env"), join(tmp, ".env.a.local")]);
  const implied = sameEnvFiles({ envFile: "", workingDir: tmp }, [join(tmp, ".env")]) && !sameEnvFiles({ envFile: "", workingDir: tmp }, [join(tmp, ".env.a.local")]);
  rmSync(tmp, { recursive: true, force: true });
  // check() run as a user runs it, with no COMPOSE_* of this shell's: the guard's refusal, and the env file it asks for.
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COMPOSE_")));
  const runCheck = (argv: string[], cwd: string, env: Record<string, string | undefined> = clean) => { const r = Bun.spawnSync([process.execPath, ...argv], { cwd, env, stdout: "pipe", stderr: "pipe", timeout: 30000 }); return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }; };
  const elsewhereDir = mkdtempSync(join((await import("node:os")).tmpdir(), "ob1-instance-elsewhere-"));
  scratch.push(elsewhereDir);
  writeFileSync(join(elsewhereDir, "compose.yaml"), "services: {}\n");
  const guardRun = runCheck([import.meta.path, "check", "--profile", "a b"], elsewhereDir);
  const elsewhereRun = runCheck(["--no-env-file", import.meta.path, "check", "-f", join(elsewhereDir, "compose.yaml")], elsewhereDir);
  const disabledRun = runCheck(["--no-env-file", import.meta.path, "check"], elsewhereDir, { ...clean, COMPOSE_DISABLE_ENV_FILE: "T" });
  const helpRun = runCheck(["--no-env-file", import.meta.path, "check", "--help"], elsewhereDir);
  const badArgRun = runCheck(["--no-env-file", import.meta.path, "check", "--nope"], elsewhereDir);
  const notDisabled = runCheck(["--no-env-file", import.meta.path, "check", "-f", join(elsewhereDir, "compose.yaml")], elsewhereDir, { ...clean, COMPOSE_DISABLE_ENV_FILE: "false" });
  // check() against a stub docker and podman (shell builtins alone, PATH only theirs): which compose runs, what
  // inspect prints, whether a fresh list can be read. Three exited containers: `mig` portless, and `gone` the one some runs remove since `ps`.
  const stubBin = join(elsewhereDir, "bin");
  mkdirSync(stubBin);
  const stubScript = `#!/bin/sh
rt=\${0##*/}
case "$*" in
  "compose "*" -f - "*"config --format json") [ "$rt" = "$STUB_COMPOSE" ] || { printf '%s: unknown command: %s compose\\n\\nRun '"'"'%s --help'"'"' for more information\\n' "$rt" "$rt" "$rt" >&2; exit 1; }; [ -z "$STUB_PROBE_ERR" ] || { printf '%s\\n' "$STUB_PROBE_ERR" >&2; exit 1; }; [ -z "$STUB_PROBE_JUNK" ] || { echo "not json"; exit 0; }; printf '{"name":"x","services":{"s":{"labels":{"f":"%s"}}}}\\n' "$STUB_COMPOSE_FILE"; exit 0;;
  "compose "*"config --format json") [ "$rt" = "$STUB_COMPOSE" ] || { printf '%s: unknown command: %s compose\\n\\nRun '"'"'%s --help'"'"' for more information\\n' "$rt" "$rt" "$rt" >&2; exit 1; }; [ -z "$STUB_RENDER_ERR" ] || { printf '%s\\n' "$STUB_RENDER_ERR" >&2; exit 1; }; [ -z "$STUB_ARGV" ] || echo "$*" > "$STUB_ARGV"; printf '%s\\n' "$STUB_RENDER"; exit 0;;
  "ps -a --no-trunc --format"*) [ -n "$STUB_PS_FAIL" ] && { echo "$rt: cannot connect" >&2; exit 1; }; { [ "$rt" = docker ] || [ -n "$STUB_PS_BOTH" ]; } && printf '%s\\n' "$STUB_PS"; exit 0;;
  "inspect "*) [ "$rt" = docker ] && printf '%s\\n' "$STUB_INSPECT"; exit \${STUB_INSPECT_EXIT:-0};;
  "ps -aq --no-trunc") [ -n "$STUB_AGAIN_FAIL" ] && exit 1; [ "$rt" = docker ] && printf '%s\\n' "$STUB_AGAIN"; exit 0;;
  "volume ls"*) exit 0;;
esac
echo "stub $rt: $*" >&2; exit 1
`;
  for (const rt of ["docker", "podman"]) { writeFileSync(join(stubBin, rt), stubScript); chmodSync(join(stubBin, rt), 0o755); }
  writeFileSync(join(elsewhereDir, "stub.env"), "X=1\n");
  const free = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => free.once("listening", r));
  const freePort = (free.address() as net.AddressInfo).port;
  await new Promise((r) => free.close(r));
  const render = (port: number | null) => JSON.stringify({ name: "stub", services: { forwarder: { ports: port ? [{ target: 8000, published: String(port), host_ip: "127.0.0.1" }] : [] } } });
  // A port this brain's forwarder holds, answering, as a running one's does.
  const held = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => held.once("listening", r));
  const heldPort = (held.address() as net.AddressInfo).port;
  const stubEnv = join(elsewhereDir, "stub.env");
  const stubPs = ["aaaaaaaaaaaa0001|stub-x-1|||x|exited||", "bbbbbbbbbbbb0002|mig|||migrate|exited||", "cccccccccccc0003|gone|||y|exited||"].join("\n");
  const stubRun = (s: Record<string, string>, args = ["--env-file", join(elsewhereDir, "stub.env")]) => runCheck(["--no-env-file", import.meta.path, "check", ...args], elsewhereDir, { HOME: process.env.HOME, PATH: stubBin, STUB_COMPOSE: "docker", STUB_RENDER: render(freePort), STUB_PS: stubPs, STUB_INSPECT: "aaaaaaaaaaaa0001|{}\nbbbbbbbbbbbb0002|null\ncccccccccccc0003|{}", STUB_AGAIN: "aaaaaaaaaaaa0001\nbbbbbbbbbbbb0002\ncccccccccccc0003", ...s });
  const fellBack = stubRun({ STUB_COMPOSE: "podman" });
  const noCompose = stubRun({ STUB_COMPOSE: "none" });
  writeFileSync(join(elsewhereDir, "secret.env"), 'X=1\nAPI_KEY="FAKE-MARKER-4242\nSERVER_PORT=18000\n');
  const leakQuote = stubRun({ STUB_PROBE_ERR: `failed to read ${join(elsewhereDir, "secret.env")}: line 2: unterminated quoted value "FAKE-MARKER-4242` }, ["--env-file", join(elsewhereDir, "secret.env")]);
  const leakValue = stubRun({ STUB_PROBE_ERR: "invalid hostPort: FAKE-MARKER-4242" }, ["--env-file", join(elsewhereDir, "secret.env")]);
  const leakRender = stubRun({ STUB_RENDER_ERR: "invalid hostPort: FAKE-MARKER-4242" }, ["--env-file", join(elsewhereDir, "secret.env")]);
  const leakRenderPodman = stubRun({ STUB_COMPOSE: "podman", STUB_RENDER_ERR: "invalid hostPort: FAKE-MARKER-4242" }, ["--env-file", join(elsewhereDir, "secret.env")]);
  const probeJunk = stubRun({ STUB_PROBE_JUNK: "1" });
  writeFileSync(join(elsewhereDir, "badport.env"), 'SERVER_PORT=80x0\nAPI_KEY=FAKE-MARKER-4242\n');
  const badPort = stubRun({ STUB_RENDER_ERR: "invalid hostPort: 80x0" }, ["--env-file", join(elsewhereDir, "badport.env")]);
  writeFileSync(join(elsewhereDir, "bad.yaml"), "services: [unclosed\n");
  const notYaml = stubRun({ STUB_RENDER_ERR: "yaml: line 1: did not find expected node content" }, ["--env-file", join(elsewhereDir, "stub.env"), "-f", join(elsewhereDir, "bad.yaml")]);
  mkdirSync(join(elsewhereDir, "dir.yaml"));
  const notYamlDir = stubRun({ STUB_RENDER_ERR: "yaml: line 1: did not find expected node content" }, ["--env-file", join(elsewhereDir, "stub.env"), "-f", join(elsewhereDir, "dir.yaml"), "-f", join(elsewhereDir, "bad.yaml")]);
  const unset = stubRun({ STUB_RENDER_ERR: "required variable MCP_ACCESS_KEYS is missing a value: FAKE-MARKER-4242" }, ["--env-file", join(elsewhereDir, "secret.env")]);
  const twoEnvs = stubRun({ STUB_RENDER_ERR: "boom FAKE-MARKER-4242 boom" }, ["--env-file", join(elsewhereDir, "stub.env"), "--env-file", join(elsewhereDir, "secret.env")]);
  const probePodman = stubRun({ STUB_COMPOSE: "podman", STUB_PROBE_ERR: 'invalid project name "FAKE-MARKER-4242": must be lowercase' }, ["--env-file", join(elsewhereDir, "secret.env")]);
  mkdirSync(join(elsewhereDir, "dir.env"));
  const dirEnv = stubRun({}, ["--env-file", join(elsewhereDir, "dir.env")]);
  const filesBlank = stubRun({ STUB_COMPOSE_FILE: " " });
  // A runtime that is neither, harmless were it run (`true`): refused before anything runs.
  const otherRuntime = runCheck(["--no-env-file", import.meta.path, "check", "--env-file", join(elsewhereDir, "stub.env"), "--runtime", "true"], elsewhereDir);
  const gone = stubRun({ STUB_INSPECT: "aaaaaaaaaaaa0001|{}\nbbbbbbbbbbbb0002|null", STUB_INSPECT_EXIT: "1", STUB_AGAIN: "aaaaaaaaaaaa0001\nbbbbbbbbbbbb0002" });
  const unread = stubRun({ STUB_INSPECT: "bbbbbbbbbbbb0002|null", STUB_INSPECT_EXIT: "1" });
  const noList = stubRun({ STUB_INSPECT: "aaaaaaaaaaaa0001|{}\nbbbbbbbbbbbb0002|null", STUB_INSPECT_EXIT: "1", STUB_AGAIN: "aaaaaaaaaaaa0001\nbbbbbbbbbbbb0002", STUB_AGAIN_FAIL: "1" });
  const unreadNoPorts = stubRun({ STUB_INSPECT: "bbbbbbbbbbbb0002|null", STUB_INSPECT_EXIT: "1", STUB_RENDER: render(null) });
  const bothList = stubRun({ STUB_PS_BOTH: "1", STUB_RENDER: render(heldPort), STUB_PS: `dddddddddddd0004|stub-forwarder-1|127.0.0.1:${heldPort}->8000/tcp|stub|forwarder|running|${stubEnv}|` });
  const shellNamed = stubRun({ COMPOSE_PROJECT_NAME: "stub", STUB_PS: "eeeeeeeeeeee0005|stub-forwarder-1||stub|forwarder|running|/elsewhere/.env|" });
  const noPs = stubRun({ STUB_PS_FAIL: "1" });
  const disabledGiven = stubRun({ COMPOSE_DISABLE_ENV_FILE: "1" });
  const hostHeld = stubRun({ STUB_RENDER: render(heldPort), STUB_PS: "" });
  const filesSet = stubRun({ STUB_COMPOSE_FILE: "a.yaml:b.yaml" });
  const argvFile = join(elsewhereDir, "argv");
  stubRun({ STUB_ARGV: argvFile }, ["--env-file", stubEnv, "-p", "stubp", "--profile", "local-models"]);
  const argvOf = () => { const a = existsSync(argvFile) ? readFileSync(argvFile, "utf8") : ""; rmSync(argvFile, { force: true }); return a; };
  const argvGiven = argvOf();
  stubRun({ STUB_ARGV: argvFile, COMPOSE_ENV_FILES: stubEnv }, []);
  const argvEnvFiles = argvOf();
  await new Promise((r) => held.close(r));
  rmSync(elsewhereDir, { recursive: true, force: true });
  const server = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as net.AddressInfo).port;
  const listening = await listens("127.0.0.1", port);
  await new Promise((r) => server.close(r));
  const closed = await listens("127.0.0.1", port);
  // explain() against one env file holding a ${ left open and a quote run on: nothing of a value in what it says.
  const exCtx = { envs: ["/x/a.env"], envTexts: ['A=1\nT=x${OPEN\nSERVER_PORT=80x0\nSERVER_BIND=127.0.0.1\nB="pw-FAKE\n# note "x\n'], composeTexts: ["x: ${MCP_ACCESS_KEYS:?set it in deploy/.env}"], fromFlag: false };
  const exTail = "; line 2 (T) holds a ${ with no }; line 5 (B) opens a quote that only line 6 closes, with more after it, and compose reads on from there";
  const exSaid: string[] = [];
  const ex = (e: string, ctx = exCtx) => { const s = explain(e, ctx); exSaid.push(s); return s; };
  const u = (n: number) => String.fromCharCode(n);
  const keysOf = (x: string) => settingsIn(x).map((s) => s.key).join();
  const cases: [string, boolean][] = [
    ["a house-form mapping names its port and address settings", knobs.some((k) => k.service === "forwarder" && k.target === 8000 && k.port === "SERVER_PORT" && k.bind === "SERVER_BIND")],
    ["a mapping not in the house form names no setting", knobs.length === 2 && !knobs.some((k) => k.service === "odd")],
    ["every port mapping in deploy/'s compose files is in the house form, so names its setting", realMappings.length > 0 && realMappings.length === realKnobs.length],
    ["compose's render: each published port, a range as each of its ports, protocol kept", JSON.stringify(publishedIn({ services: { f: { ports: [{ target: 8000, published: "8040", host_ip: "127.0.0.1" }, { target: 80, published: "9100-9101", protocol: "udp" }] }, api: { ports: [{ target: 8000 }] } } }).map((p) => `${p.service}:${p.port}/${p.protocol}`)) === JSON.stringify(["f:8040/tcp", "f:9100/udp", "f:9101/udp"])],
    ["ps lists stopped containers too, and each one's id, state, env-file label and project directory", PS_ARGS.includes("-a") && containersIn("abcdef0123456789|a|p|ob1b|forwarder|Exited|/e|/w").map((x) => x.id + x.state + x.envFile + x.workingDir).join() === "abcdef012345exited/e/w"],
    ["bindings: docker's address and IPv6, podman's IPv6, a range, a protocol, and an exposed port with none", JSON.stringify(bindingsIn("127.0.0.1:8010->8000/tcp, [::]:9000-9002->9000-9002/udp, ::1:18653->80/tcp, :::18652->80/tcp, 8000/tcp")) === JSON.stringify([{ ip: "127.0.0.1", from: 8010, to: 8010, protocol: "tcp" }, { ip: "::", from: 9000, to: 9002, protocol: "udp" }, { ip: "::1", from: 18653, to: 18653, protocol: "tcp" }, { ip: "::", from: 18652, to: 18652, protocol: "tcp" }])],
    ["a stopped container's port bindings read as ps prints a running one's", portsFromBindings('{"8000/tcp":[{"HostIp":"127.0.0.1","HostPort":"8010"}],"53/udp":[{"HostIp":"","HostPort":"5353"}],"9/tcp":null}') === "127.0.0.1:8010->8000/tcp, 0.0.0.0:5353->53/udp"],
    ["port 80 is not 8080, a range holds its middle, a UDP holder no TCP port, another address no loopback one, every address (docker's or podman's IPv6) the loopback one", holds("0.0.0.0:8097->80/tcp", pub(8097)) && holds(":::8098->80/tcp", pub(8098)) && !holds("0.0.0.0:8080->80/tcp", pub(80)) && holds("127.0.0.1:18700-18702->80-82/tcp", pub(18701)) && !holds("127.0.0.1:8095->53/udp", pub(8095)) && !holds("192.168.1.5:8096->80/tcp", pub(8096)) && holds("192.168.1.5:8096->80/tcp", pub(8096, "forwarder", "0.0.0.0"))],
    ["env files: through a symlink, several, all of them, and a project directory's .env where no --env-file was given", viaLink && comma && !commaPart && !commaMore && implied],
    ["a port this brain's own service holds is its own", one("ob1b", [pub(8040)]).verdicts[0]?.ok === true && one("ob1b", [pub(8040)]).undecided.length === 0],
    ["a port another brain's container holds is refused, naming it and the setting", /✗.*SERVER_PORT.*published by open-brain-forwarder-1, of project open-brain — set SERVER_PORT/.test(line(one("ob1b", [pub(8010)])))],
    ["a port another of this brain's services holds is refused", /✗.*SERVER_PORT.*this brain's own n8n/.test(line(one("ob1b", [pub(5678)])))],
    ["a stopped container of another brain still holds its port; a paused one holds it now", /✗.*published by old, of project oldbrain, exited: it takes the port back/.test(line(one("ob1b", [pub(8090)]))) && /published by old, of project oldbrain — set/.test(line(one("ob1b", [pub(8090)], [{ ...cs[4], state: "paused" }])))],
    ["a container of no project holds its port, for every brain", /published by squat, of project \(none\)/.test(line(one("ob1b", [pub(8080, "forwarder", "0.0.0.0")])))],
    ["two of this brain's mappings on one port: the second is refused; on two addresses or protocols, neither", one("ob1b", [pub(18999), pub(18999, "n8n", "127.0.0.1", "tcp", 5678)], []).verdicts.length === 1 && one("ob1b", [pub(18998), pub(18998, "n8n", "10.0.0.5", "tcp", 5678), pub(18998, "n8n", "127.0.0.1", "udp", 5678)], []).verdicts.length === 0],
    ["a port no container holds is left to dial; port 0 is compose's to pick", one("ob1b", [pub(18555)]).undecided.length === 1 && one("ob1b", [pub(0)]).verdicts[0]?.ok === true],
    ["this project made from another env file is refused once, its fix named, and its port is that brain's, not this one's", (() => { const d = one("open-brain", [pub(8010)], [...cs, c("open-brain-server-1", "", "open-brain", "server", "running", "", "/srv/ob1/deploy")]); if (d.verdicts.filter((v) => v.line.includes("was made from")).length !== 1) return false; return d.verdicts.some((v) => !v.ok && v.line.includes("was made from /srv/ob1/deploy/.env, not /srv/ob1/deploy/.env.ob1b.local") && v.line.includes("--force-recreate")) && !d.verdicts.some((v) => v.ok && v.line.includes("held by this brain's")); })()],
    ["this project made from this env file is its own; one an older compose made, saying nothing of its env files, is let be", one("ob1b", [pub(18557)]).verdicts.length === 0 && one("ob1b", [pub(18557)], [c("x", "", "ob1b", "forwarder", "running", "", "")]).verdicts.length === 0],
    ["a listener answers the connection test, and a closed port does not", listening && !closed],
    ["the check runs only under --no-env-file, and never beside a Bun --env-file", bunEnvProblem(["--no-env-file"]) === "" && bunEnvProblem([]) !== "" && bunEnvProblem(["--no-env-file", "--env-file=x"]) !== "" && bunEnvProblem(["--env-file", "x"]) !== ""],
    ["the command it names reads back as typed, check included", ["/srv/deploy/instance.ts", "check", "--profile", "a b", "--env-file", "it's.env"].map(shellQuote).join(" ") === `/srv/deploy/instance.ts check --profile 'a b' --env-file 'it'"'"'s.env'`],
    ["with no --env-file: COMPOSE_ENV_FILES as given, else the first compose file's directory's .env, else deploy/'s", JSON.stringify(defaultEnvFiles(["/srv/other/compose.yaml", "/srv/deploy/x.yaml"], "", "/srv/deploy")) === JSON.stringify(["/srv/other/.env"]) && JSON.stringify(defaultEnvFiles([], "", "/srv/deploy")) === JSON.stringify(["/srv/deploy/.env"]) && JSON.stringify(defaultEnvFiles([], "a.env,b.env", "/srv/deploy")) === JSON.stringify(["a.env", "b.env"]) && defaultEnvFiles([], ",", "/srv/deploy").length === 0],
    ["check() itself: refused without --no-env-file, naming the command it was given, check and quoting included", guardRun.code === 2 && guardRun.err.includes(`Run it as: bun --no-env-file ${shellQuote(import.meta.path)} check --profile 'a b'`)],
    ["check() itself: with -f elsewhere and no --env-file, that directory's .env is the one asked for", elsewhereRun.code === 2 && elsewhereRun.err.includes(`no file at ${join(elsewhereDir, ".env")}`)],
    ["check() itself: COMPOSE_DISABLE_ENV_FILE (as Go reads a bool) with no --env-file is refused", disabledRun.code === 2 && disabledRun.err.includes("COMPOSE_DISABLE_ENV_FILE is set")],
    ["check() itself: COMPOSE_DISABLE_ENV_FILE false is not set, and set beside an --env-file is no refusal", !notDisabled.err.includes("COMPOSE_DISABLE_ENV_FILE") && notDisabled.err.includes(`no file at ${join(elsewhereDir, ".env")}`) && disabledGiven.code === 0],
    ["check() on a stub runtime: a port no container holds that something answers is refused as a host process", hostHeld.code === 2 && hostHeld.err.includes(`127.0.0.1:${heldPort}: SERVER_PORT`) && hostHeld.err.includes("something on this host that is no container already listens there")],
    ["check() on a stub runtime: COMPOSE_FILE that compose reads is refused without -f, where it is set said and its value not", filesSet.code === 2 && filesSet.err.includes(`COMPOSE_FILE is set in ${join(elsewhereDir, "stub.env")}`) && filesSet.err.includes("give the check the same files with -f") && !filesSet.err.includes("a.yaml")],
    ["check() on a stub runtime: compose renders from the env files, project name and profiles given, or COMPOSE_ENV_FILES's", argvGiven.includes(`--env-file ${stubEnv} -p stubp -f ${join(HERE, "compose.yaml")} --profile local-models config --format json`) && argvEnvFiles.includes(`--env-file ${stubEnv} -f`)],
    ["check() on a stub runtime: docker and podman listing one engine's containers, this brain's forwarder is read once, its own", bothList.code === 0 && bothList.out.includes("held by this brain's forwarder")],
    ["check() on a stub runtime: a project named by the shell is told to name it apart there", shellNamed.code === 2 && shellNamed.err.includes("in place of the shell's COMPOSE_PROJECT_NAME's")],
    ["check() on a stub runtime: no runtime's containers read is refused, not read as none, and says to start one", noPs.code === 2 && noPs.err.includes("no container list could be read") && noPs.err.includes("podman machine start")],
    ["check() itself: --help prints the usage, and an unknown argument it too", helpRun.code === 0 && helpRun.out.startsWith("usage: bun --no-env-file deploy/instance.ts check") && badArgRun.code === 2 && badArgRun.err.includes("unknown argument: --nope\nusage:")],
    ["check() on a stub runtime: docker's compose missing, podman's both says COMPOSE_FILE is unset and renders", fellBack.code === 0 && fellBack.out.includes(`127.0.0.1:${freePort}: SERVER_PORT`) && fellBack.out.includes("— free")],
    ["check() on a stub runtime: no compose that runs is said so, with what to install", noCompose.code === 2 && noCompose.err.includes("no compose ran: install Docker Compose v2.23.1 or later")],
    ["check() on a stub runtime: an env file's parse error told by file, line, kind and the key that opens a quote, its value not", leakQuote.code === 2 && leakQuote.err.includes(`${join(elsewhereDir, "secret.env")}: an unterminated quoted value; line 2 (API_KEY) opens a quote`) && leakValue.code === 2 && leakValue.err.includes("not one compose can read") && !(leakQuote.err + leakValue.err).includes("FAKE-MARKER")],
    ["an env file's parse error told by file, line, kind and where a quote or ${ stays open, no value of it", ex(String.raw`failed to read /x/a.env: line 6: unexpected character "\"" in variable name "pw-FAKE\" # note"`) === "/x/a.env, line 6: an unexpected character in a variable name" + exTail && ex('failed to read /x/a.env: Invalid template: "FAKE\\SEC${"') === "/x/a.env: an invalid template (a ${ that does not close)" + exTail && ex('failed to read /x/a.env: line 9: a wording compose has not used "FAKE"') === "/x/a.env, line 9: a line compose could not read" + exTail && ex("failed to read /x/a.env: line 1: required variable MCP_ACCESS_KEYS is missing a value").startsWith("/x/a.env, line 1: a required variable with no value (MCP_ACCESS_KEYS)") && ex("failed to read /x/a.env: line 1: required variable FAKE_NAME is missing a value").startsWith("/x/a.env, line 1: a required variable with no value;") && ex("failed to read /x/a.env.local: line 2: unterminated quoted value", { ...exCtx, envs: ["/x/a.env", "/x/a.env.local"], envTexts: ["A=1\n", 'B="FAKE\n'] }).startsWith("/x/a.env.local: an unterminated quoted value")],
    ["any other failure told without compose's words: a suffix split over lines, an unknown network, a name compose refuses, a project name, a bad port", ex("services[postgres].shm_size: invalid suffix: '\"1g\nB=FAKE-pre'") === "compose could not render this brain" + exTail && ex('service "s" refers to undefined network FAKE hotline 42: invalid') === "compose could not render this brain" + exTail && ex("required variable FAKE-X is missing a value: y") === "compose could not render this brain" + exTail && ex('invalid project name "FAKE": must be lowercase').startsWith("the project name (COMPOSE_PROJECT_NAME") && ex("invalid hostPort: FAKE") === "SERVER_PORT is not a port number" + exTail],
    ["an unset variable told by the compose file's words; a runtime with no compose, by docker's words or podman's, said so", ex("required variable MCP_ACCESS_KEYS is missing a value: FAKE") === "MCP_ACCESS_KEYS is not set: set it in deploy/.env" && ex("docker: unknown command: docker compose").startsWith("no compose ran") && ex("Error: looking up compose provider failed\n* exec: x").startsWith("no compose ran")],
    ["nothing explain() said of these failures holds a value of the env file's", exSaid.length === 14 && !exSaid.join("|").includes("FAKE")],
    ["the env file read by compose's grammar: a single-quoted escape, keys in any script, brackets, an empty key, a lone CR, U+2028 and NEL, a statement after a close", keysOf("P=1\nW='C:\\temp\\'\nS_PORT=8010\n") === "P,W" && keysOf("N='it\\'s\nX_PORT=zz\n'\nP=1\n") === "N,P" && keysOf("CL" + u(0xc9) + "=\"x\nF_PORT=abc\n\"\nP=1\n") === "CL" + u(0xc9) + ",P" && keysOf("C[0]='b\nM=${t\n'\nP=1\n") === "C[0],P" && keysOf("='b\nM=${t\n'\nP=1\n") === ",P" && keysOf("A=\"x\ry\nF_PORT=abc\n\"\nP=1\n") === "A,P" && keysOf("A=\"x" + u(0x2028) + "y\nF_PORT=abc\n\"\nP=1\n") === "A,P" && keysOf("C=" + u(0x85) + "'b\nM=${t\n'\nP=1\n") === "C,P" && keysOf("A='x' C='b\nM=${t\n'\nP=1\n") === "A,C,P" && keysOf("A=\"x\" B_PORT=9\n") === "A,B_PORT"],
    ["what the grammar reads told: a comment only at a space and #, an odd key as a setting, a quote run on at a failure, a single-quoted ${ none, ports by last setting, reference and U+FEFF", settingsIn("X_PORT=#8010\nY_PORT=8010\t# c\n").map((s) => s.value).join("|") === "#8010|8010\t# c" && openings("C[0]=\"x${y\n").join() === "line 1 (a setting) opens a quote nothing closes, and compose reads on from there" && openings("M=\"qwen\nPW=\"FAKE\" # c\n").join() === "line 1 (M) opens a quote that only line 2 closes, with more after it, and compose reads on from there" && openings("T='x${y'\n").length === 0 && explain("invalid hostPort: x", { envs: ["/x/a.env"], envTexts: ["P=8010\nX_PORT=$P\nZ_PORT=abc\nZ_PORT=18000\nW_PORT=#8010\na.b_PORT=zz\n"], composeTexts: [], fromFlag: false }) === "X_PORT, set from another setting,; W_PORT is not a port number" && explain("invalid hostPort: x", { envs: ["/x/a.env"], envTexts: ["S_PORT=18735" + u(0xfeff) + "\n"], composeTexts: [], fromFlag: false }) === "S_PORT is not a port number"],
    ["the env file read as compose reads it: a value spanning lines no setting, no hint, a port's comment, brackets, quotes, export and colon read, names alone", (() => { const tls = 'TLS="MIIB\nFAKEaGVsbG8="\nP=1\n'; const ports = 'SERVER_PORT=64220 # pw FAKE\nSERVER_BIND=[::1]\nX_BIND=999.1.1.1x\nQ_PORT="8010"\nexport E_PORT=80x0\nC_PORT: 99999\nI_BIND=::1\nS_PORT=${OTHER}\n'; const said = explain("invalid IP address: x", { envs: ["/x/a.env"], envTexts: [ports], composeTexts: [], fromFlag: false }); return openings(tls).length === 0 && settingsIn(tls).map((s) => s.key).join() === "TLS,P" && openings('NOTE="first\ntoken_FAKE="x\nFAKE.part=\'y\nend"\n').join() === "line 1 (NOTE) opens a quote that only line 2 closes, with more after it, and compose reads on from there" && openings('A="x\\"\n').join() === "line 1 (A) opens a quote nothing closes, and compose reads on from there" && openings("A='it\nB=1\n").join() === "line 1 (A) opens a quote nothing closes, and compose reads on from there" && said === "X_BIND is not an IP address; E_PORT is not a port number; C_PORT is not a port number; S_PORT, set from another setting," && !said.includes("FAKE"); })()],
    ["check() on a stub runtime: a bad port named by its setting, an unset variable by the compose file's words, compose's own command given, no value", badPort.code === 2 && badPort.err.includes("SERVER_PORT is not a port number") && !badPort.err.includes("80x0") && unset.err.includes("MCP_ACCESS_KEYS is not set: set MCP_ACCESS_KEYS in deploy/.env") && unset.err.includes(`config --quiet`) && unset.err.includes(`--env-file ${join(elsewhereDir, "secret.env")}`) && !(badPort.err + unset.err).includes("FAKE-MARKER") && notYaml.err.includes(`compose could not render this brain: ${join(elsewhereDir, "bad.yaml")} is not YAML`) && notYamlDir.err.includes(`compose could not render this brain: ${join(elsewhereDir, "bad.yaml")} is not YAML`)],
    ["check() on a stub runtime: no value printed from a second env file, nor from podman's probe when docker has no compose", twoEnvs.code === 2 && twoEnvs.err.includes("compose could not render this brain") && probePodman.code === 2 && probePodman.err.includes("the project name (COMPOSE_PROJECT_NAME") && !(twoEnvs.err + probePodman.err).includes("FAKE-MARKER")],
    ["check() on a stub runtime: an env file that cannot be read is refused, plainly; a blank COMPOSE_FILE too", dirEnv.code === 2 && dirEnv.err.startsWith(`cannot read ${join(elsewhereDir, "dir.env")}: EISDIR`) && filesBlank.code === 2 && filesBlank.err.includes("COMPOSE_FILE is set")],
    ["check() itself: --runtime takes docker or podman alone", otherRuntime.code === 2 && otherRuntime.err.includes("--runtime takes docker or podman, not true")],
    ["check() on a stub runtime: a render's failure prints no env-file value, docker's or podman's, and names the runtime whose compose ran; a probe compose answers unreadably is refused", leakRender.code === 2 && leakRender.err.includes("not one compose can read") && leakRender.err.includes("printed by: docker compose") && leakRenderPodman.err.includes("not one compose can read; line 2 (API_KEY) opens a quote nothing closes, and compose reads on from there\ncompose could not render") && leakRenderPodman.err.includes("printed by: podman compose") && !(leakRender.err + leakRenderPodman.err).includes("FAKE-MARKER") && probeJunk.code === 2 && probeJunk.err.includes("said nothing of COMPOSE_FILE")],
    ["check() on a stub runtime: a container removed since ps holds nothing, and one read with no bindings is read", gone.code === 0 && gone.out.includes("— free") && !gone.err.includes("could not be read")],
    ["check() on a stub runtime: one there and unread is refused, its name given, and the port is unknown, not free", unread.code === 2 && unread.err.includes("the ports of stub-x-1, gone (stopped) could not be read") && unread.err.includes(`? 127.0.0.1:${freePort}: SERVER_PORT`) && !unread.out.includes("— free")],
    ["check() on a stub runtime: with no fresh list, each container inspect missed is unread", noList.code === 2 && noList.err.includes("the ports of gone (stopped) could not be read")],
    ["check() on a stub runtime: unread containers refuse no brain that publishes no port", unreadNoPorts.code === 0 && unreadNoPorts.out.includes("publishes no host port")],
    ["this brain's own, holding a port now, keeps it beside another's stopped container, which is named; its own stopped is dialled", (() => { const d = one("ob1b", [pub(8040)], [cs[1], c("ob1c-forwarder-1", "127.0.0.1:8040->8000/tcp", "ob1c", "forwarder", "created", "/x/.env")]); const s = one("ob1b", [pub(8040)], [{ ...cs[1], state: "exited" }]); return d.verdicts.length === 1 && d.verdicts[0].ok && d.verdicts[0].line.includes("ob1c-forwarder-1, of project ob1c, created, asks for it too") && s.verdicts.length === 0 && s.undecided[0]?.own?.name === "ob1b-forwarder-1"; })()],
    ["of this brain's own, the one holding the port now decides: a recreate's leftover listed first, or one restarting", (() => { const left = c("aaaaaaaaaaaa_ob1b-forwarder-1", "127.0.0.1:8040->8000/tcp", "ob1b", "forwarder", "created"); const d = one("ob1b", [pub(8040)], [left, cs[1]]); const r = one("ob1b", [pub(8040)], [left, { ...cs[1], state: "restarting" }]); return d.verdicts.length === 1 && d.verdicts[0].ok && d.verdicts[0].line.includes("held by this brain's forwarder") && r.verdicts[0]?.ok === true; })()],
    ["another brain's stopped container beside this brain's other service holding the port now: the latter is named", /this brain's own n8n \(ob1b-n8n-1\) —/.test(line(one("ob1b", [pub(5678)], [c("ob1c-n8n", "127.0.0.1:5678->5678/tcp", "ob1c", "n8n", "exited", "/x/.env"), cs[2]])))],
    ["of another brain's, the one holding it now is named", /published by ob1c-up, of project ob1c —/.test(line(one("ob1b", [pub(8040)], [c("ob1c-down", "127.0.0.1:8040->8000/tcp", "ob1c", "forwarder", "exited", "/x/.env"), c("ob1c-up", "127.0.0.1:8040->8000/tcp", "ob1c", "forwarder", "running", "/x/.env")])))],
    ["a stopped rival with no own holder running is refused; a created one takes the port when it first starts", /ob1c-forwarder-1, of project ob1c, created: it takes the port when it first starts/.test(line(one("ob1b", [pub(8040)], [{ ...cs[1], state: "exited" }, c("ob1c-forwarder-1", "127.0.0.1:8040->8000/tcp", "ob1c", "forwarder", "created", "/x/.env")])))],
    ["a project named by -p is told to take a name of its own there, not in the file", decide({ project: "open-brain", envFiles: [env], published: [], containers: cs, knobs, nameFrom: "-p" }).verdicts[0]?.line.includes("in place of -p's")],
    ["a runtime's reason: its last line, without docker's help hint or colour codes", reason("WARNING: config file not read\n\x1b[31mCannot connect to the Docker daemon at unix:///var/run/docker.sock\x1b[0m\n\nRun 'docker ps --help' for more information\n") === "Cannot connect to the Docker daemon at unix:///var/run/docker.sock"],
  ];
  for (const [name, ok] of cases) console.log((ok ? "ok   " : "FAIL ") + name);
  process.exit(cases.every(([, ok]) => ok) ? 0 : 1);
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--self-check") await selfCheck();
  else if (cmd === "check") await check(rest);
  else { console.error(USAGE); process.exit(2); }
}
