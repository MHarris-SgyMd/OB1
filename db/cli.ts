/**
 * cli.ts — the one flag scanner every db/ script reads its arguments through.
 *
 * Until SMD-2134 each script carried its own: extract-entities.ts and
 * consolidate.ts looked flags up with `flag(name)` / `has(name)` over argv, so
 * an argument neither knew was not an error — `--K 10` for `--k 10`, or
 * `--minsim`, ran the shipped default and exited 0, and a trial measured
 * something other than what was asked (SMD-2015); migrate.ts, ingest-records.ts,
 * tier.ts and sync-linear.ts each had a copy of one scanner that did refuse,
 * reembed.ts a larger variant, graph-centrality.ts a pure one of its own, and
 * hnsw-graph.ts and the benches read argv with `includes`. Now there is one,
 * declared per script as a table of what each flag takes, and every script's
 * argv goes through it before anything else runs — before a database URL is
 * resolved, a model is called or a row is claimed.
 *
 * What a flag takes:
 *   none      a switch: `--dry-run`
 *   one       exactly one value: `--url postgres://…`
 *   two       exactly two values: `--compare <a> <b>`
 *   optional  a value if the next argument is not a flag: `--follow [SECONDS]`
 *   many      every value up to the next flag, none included: `--accept-failed <id> <id>`
 *   repeated  one value per occurrence, any number of occurrences: `--query <q> --query <q>`
 *
 * Refused, with exit 2, the script's flag list and its note:
 *   - a flag the script does not have;
 *   - a flag given twice (a lookup reads the first; `--url A --url B` would run
 *     against A), except a `repeated` one;
 *   - a flag that takes a value followed by nothing or by another flag
 *     (`--job --switch-model` once read "--switch-model" as the key);
 *   - an empty or blank value (`--items "$OUT"` with the variable unset would
 *     read as the flag absent and write nothing, exit 0);
 *   - a value joined with "=" (`--url=postgres://…`);
 *   - a value where no flag takes one, beyond the positionals the script
 *     declares;
 *   - a bare `--` — which no script here reads as the end of its flags — after
 *     the first argument (Bun itself consumes a `--` given first).
 *
 * A refusal never repeats what the operator typed: it names the script's own
 * flags and, for an argument no flag accounts for, its position among the
 * script's own arguments (`unknown argument 3` — a wrapper that reorders them,
 * as deploy/tier.sh does, or Bun's consuming a leading `--`, moves the count).
 * An argument can be a password or a key — `--url=postgres://user:PASSWORD@…`,
 * a key typed where no flag takes it, `--a-keySECRET` with the space missed —
 * and a refusal is printed to a log; review pass 1 masked the shapes it could
 * name (a URL, a joined value) and pass 2 found three it could not, so no shape
 * is trusted. A script's own checks after the scan keep the rule for a value a
 * flag takes as-is (reembed's ids, consolidate's --list word, graph-centrality's
 * --types and --status): they name what is allowed, not what was given.
 * `--help` anywhere prints the flag list and exits 0, before any of the above.
 *
 * A number is read by `int` / `number`, which accept decimal digits only —
 * `Number()` would read "0x10", "1e2" and " 7" (graph-centrality.ts's rule,
 * now everyone's) — and an integer past 2^53, which would be rounded, is
 * refused.
 *
 * `scanArgs` and `readNumber` are pure and return the refusal as a value, for
 * the suites; `commandLine` is the scripts' door, which prints it and exits;
 * `scriptArgv` hands the process's arguments, `--help` answered, to a script
 * whose own parser is pure (graph-centrality.ts) or picks between two tables
 * (tier.ts). No other db/ file reads process.argv (test-cli.ts holds it).
 * Each script keeps its own checks of what the values mean — which flags
 * combine, what a --list word may be — after the scan.
 */

export type Takes = "none" | "one" | "two" | "optional" | "many" | "repeated";
export type FlagSpec<K extends string = string> = Readonly<Record<K, Takes>>;

export interface ScanOptions<K extends string = string> {
  /** How many values may stand where no flag takes one (default 0). */
  positionals?: number;
  /** A word shown after a flag in the list: `<postgres://…>` for a value, `(with --baseline)` for a switch. */
  hints?: Partial<Record<K, string>>;
}

/** What argv said, read by flag name. */
export interface Args<K extends string = string> {
  readonly positionals: readonly string[];
  /** The flag was given — a `optional` one with or without its value. */
  has(name: K): boolean;
  /** The value of a `one`, `optional` or `repeated` flag (the first, for `repeated`), or undefined. */
  value(name: K): string | undefined;
  /** Every value of a `two`, `many` or `repeated` flag, in order; [] when absent. */
  values(name: K): readonly string[];
}

export interface IntRule {
  /** What an absent flag reads as. */
  absent: number;
  /** What an `optional` flag given without its value reads as. */
  bare?: number;
  min: number;
  max?: number;
}
export interface NumberRule extends IntRule {
  /** Accept a fraction: `--min-sim 0.8`. */
  fraction?: boolean;
}

export interface CommandLine<K extends string = string> extends Args<K> {
  /** An integer flag, by `rule`; a malformed value is refused with exit 2. */
  int(name: K, rule: IntRule): number;
  /** A numeric flag, by `rule` — `fraction` for a decimal; a malformed value is refused with exit 2. */
  number(name: K, rule: NumberRule): number;
}

/** The flag list a refusal and `--help` print: `  flags: --url <value>, --dry-run, …`. */
export function flagList<K extends string>(spec: FlagSpec<K>, hints: Partial<Record<K, string>> = {}): string {
  const shape: Record<Takes, string> = { none: "", one: " <value>", two: " <a> <b>", optional: " [value]", many: " <value> …", repeated: " <value> (repeatable)" };
  const items = (Object.keys(spec) as K[]).map((name) => {
    const takes = spec[name];
    const hint = hints[name];
    if (hint === undefined) return `--${name}${shape[takes]}`;
    return takes === "none" ? `--${name} ${hint}` : `--${name} ${hint}${takes === "repeated" ? " (repeatable)" : ""}`;
  });
  return `  flags: ${items.length ? items.join(", ") : "none"}`;
}

/** "3", "3 and 5", "3, 5 and 6". */
function positionsOf(ns: readonly number[]): string {
  return ns.length === 1 ? `${ns[0]}` : `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`;
}

/**
 * Scan argv against `spec`: every argument accounted for, or the first reason
 * it is not. Pure — the refusal is returned, not printed. A refusal names the
 * spec's flags and argument positions (from 1), never an argument's text.
 */
export function scanArgs<K extends string>(argv: readonly string[], spec: FlagSpec<K>, options: ScanOptions<K> = {}): Args<K> | { error: string } {
  const values = new Map<string, string[]>();
  const positionals: string[] = [];
  const strays: number[] = [];
  const known = (name: string): name is K => Object.hasOwn(spec, name);
  /** The value at argv[i] for `flag`, or the refusal: `wanted` is "a value" or "two values". */
  const valueAt = (flag: string, i: number, wanted = "a value"): string | { error: string } => {
    const v = argv[i];
    if (v === undefined) return { error: `${flag} needs ${wanted}; nothing follows it` };
    if (v.startsWith("--")) return { error: `${flag} needs ${wanted}; a flag follows it` };
    if (v.trim() === "") return { error: `${flag} is empty; give it ${wanted}` };
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") return { error: `unknown argument ${i + 1}: a bare "--", which no script here reads as the end of its flags` };
    if (!a.startsWith("--")) {
      positionals.push(a);
      if (positionals.length > (options.positionals ?? 0)) strays.push(i + 1);
      continue;
    }
    const name = a.slice(2);
    if (name.includes("=")) {
      const base = name.slice(0, name.indexOf("="));
      if (!known(base)) return { error: `unknown argument ${i + 1}: a flag this script does not have, with a value joined by "="` };
      if (spec[base] === "none") return { error: `argument ${i + 1} gives --${base} a value with "=", and --${base} takes none` };
      return { error: `argument ${i + 1} joins a value to --${base} with "="; give it as --${base} <value>` };
    }
    if (!known(name)) return { error: `unknown argument ${i + 1}: not a flag this script has` };
    const takes = spec[name];
    if (values.has(name) && takes !== "repeated") return { error: `${a} given twice` };
    const got = values.get(name) ?? [];
    values.set(name, got);
    if (takes === "one" || takes === "repeated") {
      const v = valueAt(a, i + 1);
      if (typeof v !== "string") return v;
      got.push(v);
      i++;
    } else if (takes === "two") {
      for (let k = 1; k <= 2; k++) {
        const v = valueAt(a, i + 1, "two values");
        if (typeof v !== "string") return v;
        got.push(v);
        i++;
      }
    } else if (takes === "optional") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        if (next.trim() === "") return { error: `${a} is empty; give it a value or leave it out` };
        got.push(next);
        i++;
      }
    } else if (takes === "many") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        if (argv[i + 1].trim() === "") return { error: `one of ${a}'s values is empty` };
        got.push(argv[++i]);
      }
    }
  }
  if (strays.length) return { error: `unknown argument${strays.length === 1 ? "" : "s"} ${positionsOf(strays)}: ${strays.length === 1 ? "a value" : "values"} where no flag takes one` };
  return {
    positionals,
    has: (name) => values.has(name),
    value: (name) => values.get(name)?.[0],
    values: (name) => values.get(name) ?? [],
  };
}

/**
 * A number from a flag's value: decimal digits, a sign, and — with `fraction`
 * — a decimal point; nothing `Number()` reads besides. Pure; the refusal names
 * the flag and the rule, not the value.
 */
export function readNumber(flag: string, raw: string, rule: { min: number; max?: number; fraction?: boolean }): number | { error: string } {
  const shape = rule.fraction ? /^-?(\d+(\.\d*)?|\.\d+)$/ : /^-?\d+$/;
  const n = shape.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < rule.min || (rule.max !== undefined && n > rule.max)) {
    const kind = rule.fraction ? "a decimal number" : "a decimal integer";
    return { error: `${flag} must be ${kind} >= ${rule.min}${rule.max !== undefined ? ` and <= ${rule.max}` : ""}` };
  }
  // In range but past 2^53, an integer is not read exactly: "9007199254740993" is 9007199254740992.
  if (!rule.fraction && !Number.isSafeInteger(n)) return { error: `${flag} is too large to read exactly` };
  return n;
}

/**
 * The process's arguments, for a script whose parser is pure and returns its
 * refusal (graph-centrality.ts's `parseArgs`, which the suite drives): `--help`
 * prints `usage` and exits 0 first, as `commandLine` does.
 */
export function scriptArgv(usage: string): string[] {
  const argv = process.argv.slice(2);
  answerHelp(argv, usage);
  return argv;
}

/** `--help` anywhere in argv: print `text` and exit 0 — the one rule both doors share. */
function answerHelp(argv: readonly string[], text: string): void {
  if (!argv.includes("--help")) return;
  console.log(text);
  process.exit(0);
}

/**
 * The scripts' door: scan `argv` (the process's own by default) against
 * `spec`, print the refusal with the flag list and the note and exit 2, or
 * print them for `--help` and exit 0. `script` names the file.
 */
export function commandLine<K extends string>(script: string, spec: FlagSpec<K>, options: ScanOptions<K> & { note?: string } = {}, argv: readonly string[] = process.argv.slice(2)): CommandLine<K> {
  const list = `${flagList(spec, options.hints)}${options.note ? `\n  ${options.note}` : ""}`;
  answerHelp(argv, `usage: bun db/${script} [flags]\n${list}\n  The header of db/${script} says what each does.`);
  const refuse = (error: string): never => {
    console.error(`${error}\n${list}`);
    process.exit(2);
  };
  const scanned = scanArgs(argv, spec, options);
  if ("error" in scanned) return refuse(scanned.error);
  const read = (name: K, rule: NumberRule): number => {
    if (!scanned.has(name)) return rule.absent;
    const raw = scanned.value(name);
    if (raw === undefined) return rule.bare ?? refuse(`--${name} needs a value`);
    const n = readNumber(`--${name}`, raw, rule);
    return typeof n === "number" ? n : refuse(n.error);
  };
  return {
    ...scanned,
    int: (name, rule) => read(name, { ...rule, fraction: false }),
    number: (name, rule) => read(name, rule),
  };
}
