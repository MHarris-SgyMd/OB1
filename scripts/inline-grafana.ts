#!/usr/bin/env bun
/**
 * Writes the observability profile's Grafana files into deploy/compose.yaml (SMD-1849 PR 3c, SMD-3050):
 * deploy/observability/dashboard.json as the `grafana-dashboard` config's content and
 * deploy/observability/alert-rules.yaml as the `grafana-alert-rules` config's (each file six spaces
 * in, each `$` doubled, since compose reads one as a variable), and lgtm's labels, each config's
 * sha256 (compose recreates a container for a changed label, not for a changed inline config
 * alone). Checks 37 and 38 hold them all; run this after changing either file — an edit in Grafana
 * saved as a copy and exported, say.
 *
 * Run: bun scripts/inline-grafana.ts            (writes compose.yaml; says what changed)
 *      bun scripts/inline-grafana.ts --check    (writes nothing; exits 1 where compose.yaml lags a file)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE = join(ROOT, "deploy/compose.yaml");
const sha256Of = (text: string) => `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`;

/** Each file compose.yaml carries inline, by its config's name, and how it must parse. */
export const INLINE_FILES = [
  { config: "grafana-dashboard", path: "deploy/observability/dashboard.json", parse: (text: string): unknown => JSON.parse(text) },
  { config: "grafana-alert-rules", path: "deploy/observability/alert-rules.yaml", parse: (text: string): unknown => Bun.YAML.parse(text) },
] as const;
export type InlineConfig = (typeof INLINE_FILES)[number]["config"];

/** A file as compose.yaml carries it: line feeds alone, no white space before its first line (a `|` block reads its indent from that line), and exactly one line feed at the end (Grafana's export has none; a `|` block keeps one). */
export function normalised(file: string): string {
  return `${file.replace(/\r\n?/g, "\n").trimStart().replace(/\n+$/, "")}\n`;
}

/** compose.yaml with the `content: |` block of `config` made `file`; throws where there is not exactly one. */
function withBlock(compose: string, config: string, file: string): string {
  const head = `\n  ${config}:\n    content: |\n`;
  const at = compose.indexOf(head);
  if (at < 0 || compose.indexOf(head, at + 1) >= 0) throw new Error(`compose.yaml has not one \`${config}:\` config with \`content: |\` under \`configs:\``);
  const from = at + head.length;
  let to = from;
  // The block runs while its lines are blank or six spaces in.
  let last = from; // the end of the block's last line that is not blank: blank lines after it stay the file's
  while (to < compose.length) {
    const end = compose.indexOf("\n", to);
    const line = compose.slice(to, end < 0 ? compose.length : end);
    if (line !== "" && !line.startsWith("      ")) break;
    to = end < 0 ? compose.length : end + 1;
    if (line !== "") last = to;
  }
  to = last;
  const body = file.replace(/\$/g, "$$$$").split("\n").map((l) => (l === "" ? l : `      ${l}`)).join("\n");
  return compose.slice(0, from) + (body.endsWith("\n") ? body : `${body}\n`) + compose.slice(to);
}

/** compose.yaml with each file's inline copy and lgtm's labels made the files' (each normalised first); throws where a file does not parse or the text has not the shape this writes. */
export function inlined(compose: string, given: Record<InlineConfig, string>): string {
  let out = compose;
  const files = {} as Record<InlineConfig, string>;
  for (const { config, path, parse } of INLINE_FILES) {
    files[config] = normalised(given[config]);
    // A tab, a no-break space, a line separator: compose.yaml holds none (check 28's rule on its text, since compose and
    // Bun.YAML part lines and comments differently around them), so this says which file and line, not check 28 later.
    const odd = /(?![ \n])[\p{Cc}\p{Cf}\p{Z}]/u.exec(files[config]);
    if (odd) throw new Error(`${path} holds U+${odd[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")} at line ${files[config].slice(0, odd.index).split("\n").length}, which compose.yaml may not (check 28): write a space, or the escape the file's format has`);
    try { parse(files[config]); } catch (e) { throw new Error(`${path} does not parse: ${(e as Error).message}`); }
    out = withBlock(out, config, files[config]);
  }
  const doc = Bun.YAML.parse(out) as { configs?: Record<string, { content?: string }> };
  const provider = doc.configs?.["grafana-dashboard-provider"]?.content;
  if (typeof provider !== "string") throw new Error("compose.yaml has no grafana-dashboard-provider config content");
  for (const [label, text] of [...INLINE_FILES.map(({ config }) => [`ob1.${config}`, files[config]]), ["ob1.grafana-dashboard-provider", provider]]) {
    const re = new RegExp(`^(      ${label.replace(/\./g, "\\.")}: )"sha256:[0-9a-f]{64}"$`, "m");
    if (!re.test(out)) throw new Error(`compose.yaml's lgtm has no ${label} label of the form "sha256:<64 hex>"`);
    out = out.replace(re, `$1"${sha256Of(text)}"`);
  }
  const back = (Bun.YAML.parse(out) as typeof doc).configs;
  for (const { config, path } of INLINE_FILES) if (back?.[config]?.content !== files[config].replace(/\$/g, "$$$$")) throw new Error(`the written ${config} block does not read back as ${path} with each \`$\` doubled`);
  return out;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const compose = readFileSync(COMPOSE, "utf8");
  const given = {} as Record<InlineConfig, string>;
  for (const { config, path } of INLINE_FILES) {
    given[config] = readFileSync(join(ROOT, path), "utf8");
    if (normalised(given[config]) === given[config]) continue;
    if (check) { console.error(`${path} has carriage returns, white space before its first line or not exactly one line feed at its end: run \`bun scripts/inline-grafana.ts\``); process.exit(1); }
    writeFileSync(join(ROOT, path), normalised(given[config]));
    console.log(`wrote ${path}: line feeds alone, one at its end (as compose.yaml carries it)`);
  }
  let out: string;
  try { out = inlined(compose, given); } catch (e) { console.error((e as Error).message); process.exit(1); }
  const paths = INLINE_FILES.map(({ path }) => path).join(" and ");
  if (out === compose) { console.log(`deploy/compose.yaml already carries ${paths} and lgtm's labels`); process.exit(0); }
  if (check) { console.error(`deploy/compose.yaml lags ${paths}: run \`bun scripts/inline-grafana.ts\``); process.exit(1); }
  writeFileSync(COMPOSE, out);
  console.log(`wrote deploy/compose.yaml: the ${INLINE_FILES.map(({ config }) => config).join(" and ")} configs and lgtm's labels from ${paths}`);
}
