#!/usr/bin/env bun
/**
 * ingest-records.ts — rebuild the stable brain from the records it derives from.
 *
 * SMD-1806's first premise: the brain is a *derived view* over the fork's
 * records — FORK.md, the Linear board, the memory files, the git history — never
 * the record itself. So the "stable" tier holds nothing that a wipe would lose:
 * its cost is one re-ingest. This is that ingest. It reads the four sources,
 * turns each record into one thought row with a deterministic id and a
 * `metadata.source` label (SMD-1806 rule 5 — an agent-written capture is one
 * source among four, so SMD-1724's trust question has an answer here from day
 * one), and upserts them so a second run over unchanged records is a no-op and a
 * run over an edited record updates exactly the rows that moved.
 *
 * It writes BARE rows — no embedding, no chunks. Vectors and chunk rows are the
 * owned embedding path's job: after an ingest, `db/reembed.ts` walks the new
 * rows through the claim table (015/031) and embeds them exactly as a capture
 * would, chunking long records through update_thought. The rebuild is two
 * commands:
 *
 *   bun db/ingest-records.ts --url postgres://…            # the records → rows
 *   bun db/reembed.ts        --url postgres://…            # rows → vectors + chunks
 *
 * Sources, and what each needs:
 *   fork    — FORK.md's numbered `### N.` change sections. In the tree; no flag.
 *   commit  — git commit messages since the upstream pin. In the tree; no flag.
 *   linear  — a corpus dump built by evals/build-linear-corpus.ts. Needs --linear.
 *   memory  — the *.md memory files (not MEMORY.md, the index). Needs --memory-dir
 *             or OB1_MEMORY_DIR — they live outside the repo, in the operator's
 *             ~/.claude, so there is no portable default and this tool reads,
 *             never writes, them.
 * `--source all` (the default) ingests every source it has an input for and says
 * on stderr which it skipped for lack of one.
 *
 *   bun db/ingest-records.ts --url … --dry-run             # count per source, write nothing
 *   bun db/ingest-records.ts --url … --source fork         # one source
 *   bun db/ingest-records.ts --url … --linear /tmp/linear-corpus-full.json
 *   bun db/ingest-records.ts --url … --memory-dir ~/.claude/…/memory
 *   bun db/ingest-records.ts --url … --since <ref>         # commit range start (default the pin tag)
 *   bun db/ingest-records.ts --self-check                  # the pure parsers, no DB
 *
 * The row write reuses evals/linear-corpus.ts's shape (metadata `{source, …}`,
 * content_fingerprint_of, the fixed pseudo-UUID per record) so a Linear ticket
 * lands on the SAME id whether ingested here or by the eval corpus loader — one
 * id space across the tooling.
 */

import { SQL } from "bun";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { loadLinearCorpus, linearThoughtId, linearThoughtText, type LinearDoc } from "../evals/linear-corpus.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const SOURCES = ["fork", "commit", "linear", "memory"] as const;
export type Source = (typeof SOURCES)[number];
export const TIERS = ["stable", "canary", "working"] as const;
export type Tier = (typeof TIERS)[number];

/** One record as a thought row: its id, its content, its source label and the metadata that goes under it. */
export type Doc = {
  id: string;
  content: string;
  source: Source;
  meta: Record<string, unknown>;
  /** When the record came to be (a ticket opened, a commit authored); left to now() when a source has none. */
  createdAt?: string;
};

/**
 * A fixed, valid-looking UUID per (source, key), the same construction
 * linearThoughtId uses so the two agree on the linear space: crc32 of the key in
 * the time-low field, xxHash64 of a source-qualified key in the node field, the
 * version/variant nibbles fixed so Postgres accepts it. Deterministic, so a
 * rebuild lands every record on its own id and the upsert can recognise it.
 */
export function recordId(source: Source, key: string): string {
  if (source === "linear") return linearThoughtId(key);
  const qualified = `${source}:${key}`;
  return (
    Bun.hash.crc32(qualified).toString(16).padStart(8, "0") +
    "-0000-4000-8000-" +
    Bun.hash.xxHash64(qualified).toString(16).padStart(16, "0").slice(0, 12)
  );
}

// ---------------------------------------------------------------------------
// Source adapters — each a pure reader that yields Docs; no DB, no embedding.
// ---------------------------------------------------------------------------

/**
 * FORK.md's numbered change sections. A change is a heading `### N. Title`; its
 * body runs to the next `## `/`### ` heading or the end. The section text
 * (heading included) is the content; the change number and the first ticket it
 * cites are the metadata. Prose sections without a leading number (`### Versioning`,
 * `### Deploying`) are design front-matter, not changes, and are skipped.
 *
 * SMD-1917 (unpushed) replaces these sections with changes/*.md fragments; when
 * it lands, this adapter reads that directory instead. Until then FORK.md is the
 * source of record for the fork's changes.
 */
export function forkDocs(forkMd: string): Doc[] {
  const lines = forkMd.split("\n");
  const docs: Doc[] = [];
  let cur: { num: number; buf: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const content = cur.buf.join("\n").trim();
    const ticket = content.match(/\bSMD-\d+\b/)?.[0] ?? null;
    docs.push({ id: recordId("fork", String(cur.num)), content, source: "fork", meta: { change: cur.num, ticket } });
    cur = null;
  };
  for (const line of lines) {
    const head = line.match(/^### (\d+)\.\s/);
    if (head) {
      flush();
      cur = { num: Number(head[1]), buf: [line] };
    } else if (/^##\s|^### /.test(line)) {
      // Any other heading at ## or ### depth ends the current change.
      flush();
    } else if (cur) {
      cur.buf.push(line);
    }
  }
  flush();
  return docs;
}

/**
 * The frontmatter a memory file carries — the fields this ingester reads. A
 * minimal reader over the leading `--- … ---` fence: `name`, `description`, and
 * `modified` (an ISO timestamp under `metadata:`). Not a full YAML parser; the
 * memory files are flat and machine-written.
 */
export function memoryFrontmatter(md: string): { name?: string; description?: string; modified?: string; body: string } {
  if (!md.startsWith("---\n")) return { body: md };
  const end = md.indexOf("\n---", 4);
  if (end < 0) return { body: md };
  const fm = md.slice(4, end);
  // The newline after the closing `---` line; -1 when the fence is the last line
  // with no trailing newline (a frontmatter-only file) — then the body is empty,
  // not the whole file.
  const afterFence = md.indexOf("\n", end + 1);
  const body = afterFence < 0 ? "" : md.slice(afterFence + 1);
  const field = (name: string) => fm.match(new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, "m"))?.[1]?.replace(/^["']|["']$/g, "");
  return { name: field("name"), description: field("description"), modified: field("modified"), body };
}

/** A frontmatter `modified` value the timestamptz cast will accept, or nothing. */
const ISO_TS_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d/;

/** One memory `.md` file as a Doc: a title line (its description, else name, else slug) then the body. */
export function memoryDoc(slug: string, md: string, mtime?: string): Doc {
  const { name, description, modified, body } = memoryFrontmatter(md);
  const title = description ?? name ?? slug;
  // `modified` is used only when it looks like an ISO timestamp; a malformed one
  // would otherwise reach the row's timestamptz cast and abort the whole ingest.
  // The file's mtime is always valid, so it is the fallback.
  return {
    id: recordId("memory", slug),
    content: `${title}\n\n${body.trim()}`,
    source: "memory",
    meta: { file: slug },
    createdAt: modified && ISO_TS_RE.test(modified) ? modified : mtime,
  };
}

/** Every memory file in a directory, MEMORY.md (the index this pipeline exists to beat) excluded. */
export function memoryDocs(dir: string): Doc[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
    .map((f) => {
      const path = join(dir, f);
      return memoryDoc(f.replace(/\.md$/, ""), readFileSync(path, "utf8"), statSync(path).mtime.toISOString());
    });
}

/** A Linear corpus dump (evals/build-linear-corpus.ts output) as Docs, on the shared linear id space. */
export function linearDocs(path: string): Doc[] {
  return loadLinearCorpus(path).docs.map((d: LinearDoc) => ({
    id: linearThoughtId(d.id),
    content: linearThoughtText(d),
    source: "linear",
    meta: { issue: d.id },
    createdAt: d.createdAt,
  }));
}

/**
 * The fork's commit messages since the pin — its whole delta from upstream, the
 * same span FORK.md documents. Each commit is one Doc: the full message
 * (subject + body), the sha and author date. Records separated by 0x1e, fields
 * by 0x00, so a message's own newlines and blank lines survive.
 */
export function commitDocs(since: string, cwd: string = REPO_ROOT): Doc[] {
  const out = execFileSync("git", ["log", `${since}..HEAD`, "--no-color", "--format=%H%x00%aI%x00%B%x1e"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const docs: Doc[] = [];
  for (const rec of out.split("\x1e")) {
    const trimmed = rec.replace(/^\n+/, "");
    if (!trimmed) continue;
    const [sha, date, ...rest] = trimmed.split("\x00");
    const message = rest.join("\x00").trim();
    if (!sha || !message) continue;
    docs.push({ id: recordId("commit", sha), content: message, source: "commit", meta: { sha }, createdAt: date });
  }
  return docs;
}

// ---------------------------------------------------------------------------
// Write path — bare rows, idempotent by id, safe on a duplicate-content record.
// ---------------------------------------------------------------------------

export type UpsertResult = "inserted" | "updated" | "unchanged" | "skipped";

function isFingerprintCollision(e: unknown): boolean {
  // Bun's PostgresError carries the SQLSTATE in `errno` (`code` is the generic
  // ERR_POSTGRES_SERVER_ERROR); the violated index is idx_thoughts_fingerprint.
  // The only unique constraint an ON CONFLICT (id) insert can still trip is the
  // partial-unique fingerprint index — id conflicts are absorbed above — so a
  // 23505 that names the fingerprint is a duplicate-content record, skipped.
  const err = e as { errno?: string; code?: string; constraint?: string; message?: string };
  const sqlstate = err?.errno ?? err?.code;
  return sqlstate === "23505" && /fingerprint/i.test(`${err?.constraint ?? ""} ${err?.message ?? ""}`);
}

/**
 * Upsert one bare row. Keyed on the record's deterministic id: same id + same
 * content (fingerprint) is a no-op ("unchanged"), an edited record updates in
 * place ("updated"), a new record inserts ("inserted"). `xmax = 0` on the
 * RETURNING row distinguishes an insert from an update; no row back means the
 * ON CONFLICT WHERE guard held — the content was identical, nothing changed.
 *
 * A different record whose content is byte-identical to one already stored
 * collides on the partial-unique content_fingerprint index (23505), not on id;
 * that is "skipped" — the content already exists as another record. Each upsert
 * is its own statement (no surrounding transaction) so one such skip does not
 * poison the rest of the run, which is idempotent and re-runnable regardless.
 */
export async function upsertRecord(sql: SQL, doc: Doc): Promise<UpsertResult> {
  const meta = { source: doc.source, ...doc.meta };
  const created = doc.createdAt ?? null;
  try {
    const rows = await sql`
      INSERT INTO thoughts (id, content, metadata, content_fingerprint, created_at)
      VALUES (${doc.id}::uuid, ${doc.content}, ${meta}::jsonb, content_fingerprint_of(${doc.content}), COALESCE(${created}::timestamptz, now()))
      ON CONFLICT (id) DO UPDATE
        SET content = EXCLUDED.content,
            metadata = EXCLUDED.metadata,
            content_fingerprint = EXCLUDED.content_fingerprint
        WHERE thoughts.content_fingerprint IS DISTINCT FROM EXCLUDED.content_fingerprint
      RETURNING (xmax = 0) AS inserted`;
    if (rows.length === 0) return "unchanged";
    return rows[0].inserted ? "inserted" : "updated";
  } catch (e) {
    if (isFingerprintCollision(e)) return "skipped";
    throw e;
  }
}

/**
 * Drop records whose content is byte-identical to one already kept in this run,
 * keeping the first — the pre-filter that spares most cross-record fingerprint
 * collisions a round trip. Keyed on the content itself, not a hash of it: a hash
 * collision here would silently drop a distinct record before the database's
 * (stronger) content_fingerprint ever saw it. Returns the kept docs and the
 * count dropped.
 */
export function dedupeByContent(docs: Doc[]): { docs: Doc[]; dropped: number } {
  const seen = new Set<string>();
  const kept: Doc[] = [];
  let dropped = 0;
  for (const d of docs) {
    if (seen.has(d.content)) { dropped++; continue; }
    seen.add(d.content);
    kept.push(d);
  }
  return { docs: kept, dropped };
}

/** Record the tier's identity and this ingest's time in ob1_config — what preflight's `tier` check reads back. */
export async function stampTier(sql: SQL, tier: Tier): Promise<void> {
  await sql`INSERT INTO ob1_config (key, value) VALUES ('tier', ${tier})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  await sql`INSERT INTO ob1_config (key, value) VALUES ('last_ingest', ${new Date().toISOString()})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

// ---------------------------------------------------------------------------
// Self-check — the pure parsers, no database.
// ---------------------------------------------------------------------------

function selfCheck(): number {
  let bad = 0;
  const ok = (cond: boolean, label: string) => { if (!cond) { console.error(`FAIL ${label}`); bad++; } };

  const fork = forkDocs([
    "## The pin",
    "not a change",
    "### Versioning",
    "prose, no number — skipped",
    "### 18. Long captures stay searchable",
    "the body of eighteen (SMD-1175)",
    "more of eighteen",
    "### 19. Default embedding model",
    "the body of nineteen",
    "## Drift guards",
    "trailing prose",
  ].join("\n"));
  ok(fork.length === 2, `two numbered changes parsed, got ${fork.length}`);
  ok(fork[0].meta.change === 18 && fork[0].meta.ticket === "SMD-1175", "change 18 number + first ticket");
  ok(/\(SMD-1175\)\nmore of eighteen/.test(fork[0].content), "a change keeps its whole body");
  ok(fork[1].meta.change === 19 && fork[1].meta.ticket === null, "a change with no ticket carries null");
  ok(!fork.some((d) => /prose, no number/.test(d.content)), "un-numbered prose sections are not changes");

  const fm = memoryFrontmatter("---\nname: a-slug\ndescription: a one-line summary\nmetadata:\n  modified: 2026-09-22T03:00:00.000Z\n---\n\nthe body\nline two\n");
  ok(fm.name === "a-slug" && fm.description === "a one-line summary" && fm.modified === "2026-09-22T03:00:00.000Z", "frontmatter fields read");
  ok(fm.body.trim() === "the body\nline two", "body is what follows the fence");
  const md = memoryDoc("a-slug", "---\ndescription: the summary\n---\nbody\n");
  ok(md.content.startsWith("the summary\n\n") && md.meta.file === "a-slug", "memory doc = description title + body");
  ok(memoryFrontmatter("no frontmatter here").body === "no frontmatter here", "a file without a fence is all body");
  ok(memoryFrontmatter("---\nname: x\n---").body === "", "a frontmatter-only file (fence at EOF) has an empty body, not the whole file");
  ok(memoryDoc("s", "---\nmetadata:\n  modified: not-a-date\n---\nbody\n", "2026-01-01T00:00:00.000Z").createdAt === "2026-01-01T00:00:00.000Z", "a malformed `modified` falls back to the file mtime, never reaching the timestamptz cast");
  ok(memoryDoc("s", "---\nmetadata:\n  modified: 2026-09-22T03:00:00.000Z\n---\nbody\n", "2026-01-01T00:00:00.000Z").createdAt === "2026-09-22T03:00:00.000Z", "a valid ISO `modified` is used over the mtime");

  ok(recordId("fork", "18") === recordId("fork", "18"), "recordId is stable");
  ok(recordId("fork", "18") !== recordId("commit", "18"), "the source qualifies the id");
  ok(recordId("linear", "SMD-1806") === linearThoughtId("SMD-1806"), "linear ids match the eval space");
  ok(/^[0-9a-f]{8}-0000-4000-8000-[0-9a-f]{12}$/.test(recordId("memory", "x")), "recordId is a valid-looking uuid");

  const { docs: deduped, dropped } = dedupeByContent([
    { id: "a", content: "same", source: "fork", meta: {} },
    { id: "b", content: "same", source: "commit", meta: {} },
    { id: "c", content: "other", source: "fork", meta: {} },
  ]);
  ok(deduped.length === 2 && dropped === 1, "identical content across records is de-duped, first kept");

  if (bad === 0) console.log("ingest-records.ts self-check PASS");
  return bad === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (name: string) => args.includes(`--${name}`);

  // Every argument accounted for, the way migrate.ts does it: a flag the runner
  // does not have, a value where none is expected, a one-value flag with nothing
  // after it, or a flag given twice, is refused rather than silently dropped.
  {
    const TAKES_ONE = new Set(["url", "source", "linear", "memory-dir", "tier", "since"]);
    const TAKES_NONE = new Set(["dry-run", "self-check"]);
    const USAGE = "  flags: --url <postgres://…>, --source <all|fork|commit|linear|memory>, --linear <dump.json>, --memory-dir <path>, --tier <stable|canary|working>, --since <ref>, --dry-run, --self-check";
    const seen = new Set<string>();
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const name = a.startsWith("--") ? a.slice(2) : null;
      if (name !== null && (TAKES_ONE.has(name) || TAKES_NONE.has(name))) {
        if (seen.has(name)) { console.error(`--${name} given twice.\n${USAGE}`); process.exit(2); }
        seen.add(name);
      }
      if (name !== null && TAKES_ONE.has(name)) {
        if (i + 1 >= args.length || args[i + 1].startsWith("--")) { console.error(`--${name} takes a value.\n${USAGE}`); process.exit(2); }
        i++;
        continue;
      }
      if (name !== null && TAKES_NONE.has(name)) continue;
      const shown = name !== null ? a : /:\/\//.test(a) ? "<a URL>" : a;
      console.error(`unknown argument: ${shown}${name === null ? " (a value where no flag takes one)" : ""}\n${USAGE}`);
      process.exit(2);
    }
  }

  if (has("self-check")) process.exit(selfCheck());

  const dryRun = has("dry-run");
  const sourceArg = flag("source") ?? "all";
  if (sourceArg !== "all" && !SOURCES.includes(sourceArg as Source)) {
    console.error(`--source must be all or one of ${SOURCES.join(", ")}.`);
    process.exit(2);
  }
  const wanted = sourceArg === "all" ? new Set<Source>(SOURCES) : new Set<Source>([sourceArg as Source]);

  // Empty or whitespace is unset (the fork's string-knob rule), defaulting to stable.
  const tier = ((flag("tier") ?? process.env.OB1_TIER)?.trim() || "stable") as Tier;
  if (!TIERS.includes(tier)) {
    console.error(`--tier / OB1_TIER must be one of ${TIERS.join(", ")}.`);
    process.exit(2);
  }

  const since = flag("since") ?? "upstream-pin-9543c29";
  const linearPath = flag("linear");
  const memoryDir = flag("memory-dir") ?? process.env.OB1_MEMORY_DIR;

  // Gather. A source in the wanted set with no input to read is skipped with a
  // word on stderr, not an error — `--source all` on a bare checkout ingests
  // fork + commit and says linear/memory had no source given.
  const collected: Doc[] = [];
  const perSource: Record<string, number> = {};
  const note = (s: Source, msg: string) => console.error(`  ${s}: ${msg}`);

  if (wanted.has("fork")) {
    const docs = forkDocs(readFileSync(join(REPO_ROOT, "FORK.md"), "utf8"));
    perSource.fork = docs.length;
    collected.push(...docs);
  }
  if (wanted.has("commit")) {
    const docs = commitDocs(since);
    perSource.commit = docs.length;
    collected.push(...docs);
  }
  if (wanted.has("linear")) {
    if (!linearPath) note("linear", "skipped — pass --linear <dump.json> (built by evals/build-linear-corpus.ts)");
    else if (!existsSync(linearPath)) { console.error(`--linear: no such file: ${linearPath}`); process.exit(2); }
    else { const docs = linearDocs(linearPath); perSource.linear = docs.length; collected.push(...docs); }
  }
  if (wanted.has("memory")) {
    if (!memoryDir) note("memory", "skipped — pass --memory-dir <path> or set OB1_MEMORY_DIR (the *.md memory files)");
    else if (!existsSync(memoryDir)) { console.error(`--memory-dir: no such directory: ${memoryDir}`); process.exit(2); }
    else { const docs = memoryDocs(memoryDir); perSource.memory = docs.length; collected.push(...docs); }
  }

  const { docs, dropped } = dedupeByContent(collected);

  if (dryRun) {
    for (const s of SOURCES) if (perSource[s] !== undefined) console.log(`  ${s}: ${perSource[s]} record(s)`);
    console.log(`  total: ${docs.length} to write${dropped ? `, ${dropped} duplicate-content dropped` : ""} (dry run — nothing written)`);
    return;
  }

  const url = flag("url") ?? process.env.DATABASE_URL;
  if (!url) { console.error("No database URL. Pass --url or set DATABASE_URL."); process.exit(2); }

  const sql = new SQL({ url, max: 1 });
  const tally: Record<UpsertResult, number> = { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
  try {
    for (const doc of docs) tally[await upsertRecord(sql, doc)]++;
    await stampTier(sql, tier);
  } finally {
    await sql.close();
  }

  for (const s of SOURCES) if (perSource[s] !== undefined) console.log(`  ${s}: ${perSource[s]} record(s)`);
  console.log(`  tier=${tier}  inserted ${tally.inserted}  updated ${tally.updated}  unchanged ${tally.unchanged}  skipped ${tally.skipped}${dropped ? `  (+${dropped} duplicate-content dropped)` : ""}`);
  console.log(`  next: bun db/reembed.ts --url … — embed the new rows (vectors + chunks) through the claim path.`);
}

if (import.meta.main) await main();
