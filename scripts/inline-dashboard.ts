#!/usr/bin/env bun
/**
 * Writes deploy/observability/dashboard.json into deploy/compose.yaml (SMD-1849 PR 3c): the
 * `grafana-dashboard` config's content (the file, six spaces in, each `$` doubled, since compose
 * reads one as a variable) and lgtm's two labels, each config's sha256 (compose recreates a
 * container for a changed label, not for a changed inline config alone). Check 37 holds all three;
 * run this after changing the file — an edit in Grafana saved as a copy and exported as JSON, say.
 *
 * Run: bun scripts/inline-dashboard.ts            (writes compose.yaml; says what changed)
 *      bun scripts/inline-dashboard.ts --check    (writes nothing; exits 1 where compose.yaml lags the file)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE = join(ROOT, "deploy/compose.yaml");
const FILE = join(ROOT, "deploy/observability/dashboard.json");
const sha256Of = (text: string) => `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`;

/** The file as compose.yaml carries it: line feeds alone, no white space before its first line (a `|` block reads its indent from that line), and exactly one line feed at the end (Grafana's export has none; a `|` block keeps one). */
export function normalised(file: string): string {
  return `${file.replace(/\r\n?/g, "\n").trimStart().replace(/\n+$/, "")}\n`;
}

/** compose.yaml with the file's inline copy and lgtm's labels made the file's (normalised first); throws where the text has not the shape it writes. */
export function inlined(compose: string, given: string): string {
  const file = normalised(given);
  JSON.parse(file);
  const head = "\n  grafana-dashboard:\n    content: |\n";
  const at = compose.indexOf(head);
  if (at < 0 || compose.indexOf(head, at + 1) >= 0) throw new Error("compose.yaml has not one `grafana-dashboard:` config with `content: |` under `configs:`");
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
  let out = compose.slice(0, from) + (body.endsWith("\n") ? body : `${body}\n`) + compose.slice(to);
  const doc = Bun.YAML.parse(out) as { configs?: Record<string, { content?: string }> };
  const provider = doc.configs?.["grafana-dashboard-provider"]?.content;
  if (typeof provider !== "string") throw new Error("compose.yaml has no grafana-dashboard-provider config content");
  for (const [label, text] of [["ob1.grafana-dashboard", file], ["ob1.grafana-dashboard-provider", provider]] as const) {
    const re = new RegExp(`^(      ${label.replace(/\./g, "\\.")}: )"sha256:[0-9a-f]{64}"$`, "m");
    if (!re.test(out)) throw new Error(`compose.yaml's lgtm has no ${label} label of the form "sha256:<64 hex>"`);
    out = out.replace(re, `$1"${sha256Of(text)}"`);
  }
  if (doc.configs?.["grafana-dashboard"]?.content === undefined || (Bun.YAML.parse(out) as typeof doc).configs?.["grafana-dashboard"]?.content !== file.replace(/\$/g, "$$$$")) throw new Error("the written block does not read back as the file with each `$` doubled");
  return out;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const compose = readFileSync(COMPOSE, "utf8");
  const given = readFileSync(FILE, "utf8");
  if (normalised(given) !== given) {
    if (check) { console.error("deploy/observability/dashboard.json has carriage returns, white space before its first line or not exactly one line feed at its end: run `bun scripts/inline-dashboard.ts`"); process.exit(1); }
    writeFileSync(FILE, normalised(given));
    console.log("wrote deploy/observability/dashboard.json: line feeds alone, one at its end (as compose.yaml carries it)");
  }
  const out = inlined(compose, given);
  if (out === compose) { console.log("deploy/compose.yaml already carries deploy/observability/dashboard.json and its labels"); process.exit(0); }
  if (check) { console.error("deploy/compose.yaml lags deploy/observability/dashboard.json: run `bun scripts/inline-dashboard.ts`"); process.exit(1); }
  writeFileSync(COMPOSE, out);
  console.log("wrote deploy/compose.yaml: the grafana-dashboard config and lgtm's labels from deploy/observability/dashboard.json");
}
