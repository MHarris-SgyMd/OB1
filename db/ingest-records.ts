#!/usr/bin/env bun
/**
 * ingest-records.ts — rebuild the stable brain from the records it derives from.
 *
 * SMD-1806's first premise: the brain is a *derived view* over the fork's
 * records — FORK.md, the Linear board, the memory files, the git history — never
 * the record itself. So the "stable" tier holds nothing that a wipe would lose:
 * its cost is one re-ingest. This is that ingest. It reads the sources below,
 * turns each record into one thought row with a deterministic id and a
 * `metadata.source` label (SMD-1806 rule 5 — an agent-written capture is one
 * source among several, so SMD-1724's trust question has an answer here from day
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
 *   fork     — the fork's changes, one changes/*.md file each (SMD-1917). In the tree; no flag.
 *   commit   — git commit messages since the upstream pin. In the tree; no flag.
 *   linear   — a corpus dump built by evals/build-linear-corpus.ts. Needs --linear.
 *              Each record's `issue` goes through the Linear adapter
 *              (db/ingest-linear.ts, SMD-1867) — the mapping the board sync
 *              feeds its own fetch to, so the two write one text (SMD-1958);
 *              a ticket's dated sections become rows of their own, derived
 *              from the ticket's (SMD-2059).
 *   memory   — the *.md memory files (not MEMORY.md, the index). Needs --memory-dir
 *              or OB1_MEMORY_DIR — they live outside the repo, in the operator's
 *              ~/.claude, so there is no portable default and this tool reads,
 *              never writes, them.
 *   markdown — a Markdown / Obsidian vault, through the Markdown adapter
 *              (db/ingest-markdown.ts). Needs --markdown <root> or OB1_MARKDOWN_DIR.
 *   items    — ingestion-contract items from a file, one JSON object per line,
 *              emitted by a parser in any language (db/ingest-items.ts, SMD-2136):
 *              the import recipes' seam. Needs --items <file.jsonl> (`-` reads
 *              stdin). Each item's row is labelled with ITS system
 *              (`metadata.source`), not `items`; a malformed line refuses the
 *              file whole, naming the line and the field, before any write.
 * `--source all` (the default) ingests every source it has an input for and says
 * on stderr which it skipped for lack of one.
 *
 * The adapter sources are EXTERNAL content and pass SMD-1813's allowlist:
 * every item names a scope (the corpus, a vault root, an export) and only a scope named
 * by `--allow <a,b>` / OB1_INGEST_ALLOW is ingested — default nothing, the
 * refusal counted and said. The fork's own records (fork, commit, memory) are
 * not external and are not gated.
 *
 *   bun db/ingest-records.ts --url … --dry-run             # count per source, write nothing
 *   bun db/ingest-records.ts --url … --source fork         # one source
 *   bun db/ingest-records.ts --url … --linear /tmp/linear-corpus-full.json --allow linear:corpus
 *   bun db/ingest-records.ts --url … --markdown ~/vault --allow ~/vault
 *   bun db/ingest-records.ts --url … --source items --items out.jsonl --allow chatgpt:export
 *   python3 import-x.py export.zip | bun db/ingest-records.ts --url … --source items --items - --allow x:export
 *   bun db/ingest-records.ts --url … --memory-dir ~/.claude/…/memory
 *   bun db/ingest-records.ts --url … --since <ref>         # commit range start (default the pin tag)
 *   bun db/ingest-records.ts --self-check                  # the pure parsers, no DB
 *
 * The row write reuses evals/linear-corpus.ts's shape (metadata `{source, …}`,
 * content_fingerprint_of, the fixed pseudo-UUID per record) so a Linear ticket
 * lands on the SAME id whether ingested here or by the eval corpus loader — one
 * id space across the tooling.
 *
 * The write path is the ingestion contract's pipeline (db/ingest-contract.ts,
 * SMD-1867): the row's metadata is MERGED, never replaced (the board sync's
 * facets and 050's actor marks survive a rebuild — SMD-1958); a record older
 * than the row's watermark (a dump the sync has moved past) is `stale` and
 * writes nothing; a record whose text moved has its vector and chunks
 * cleared so `reembed.ts` pools it; and a
 * record that came through an adapter also writes its canonical
 * (thought_sources), its links (053's `link` facets, as a set) and its
 * structured mentions (record_thought_entities under `source:<system>`), all in
 * the record's own transaction.
 */

import { SQL } from "bun";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { PIPELINE_TIERS } from "./config.mjs";
import { loadLinearCorpus, linearThoughtId, type LinearDoc } from "../evals/linear-corpus.ts";
import { parseFragment, fragmentSection } from "../scripts/fragments.ts";
import { headingOf, ticketsOf } from "../scripts/fork-index.ts";
import { AdapterRefusal, allowlistFrom, scopeRefusal, type Allowlist, type Identity, type Ingested } from "./ingest-contract.ts";
import { LINEAR_SYSTEM, linearAdapter, renderIssue, SAMPLE_ISSUE, WATERMARK_KEY } from "./ingest-linear.ts";
import { markdownAdapter, markdownFiles, MARKDOWN_SYSTEM } from "./ingest-markdown.ts";
import { ItemsRefusal, parseItems, RESERVED_SYSTEMS, SAMPLE_ITEM, SAMPLE_LINE } from "./ingest-items.ts";
import { IdentityHeld, recordStructure, runName as structureRunName, type Structure, type StructureResult } from "./ingest-structure.ts";

// The structure writer lives in ingest-structure.ts so db/sync-linear.ts can
// import it without this file's evals/ and scripts/ imports (its container
// mounts db/ and server-portable/ alone); re-exported here for the callers
// that read it as the pipeline's.
export { IdentityHeld, recordStructure, type Structure, type StructureResult };

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The sources the CLI reads — `items` is a file of items whose rows are labelled with their own systems. */
export const SOURCES = ["fork", "commit", "linear", "memory", "markdown", "items"] as const;
export type Source = (typeof SOURCES)[number];
/** The pipeline tiers, from the one source db/config.mjs owns (SMD-1953) — migration 045's CHECK and preflight/initEnv validate against the same list. */
export const TIERS = PIPELINE_TIERS;
export type Tier = (typeof TIERS)[number];

/** One record as a thought row: its id, its content, its source label and the metadata that goes under it. */
export type Doc = {
  id: string;
  content: string;
  /** The row's `metadata.source` label: one of the CLI's sources, or — for an item from a file (SMD-2136) — the system the item names. */
  source: string;
  meta: Record<string, unknown>;
  /** When the record came to be (a ticket opened, a commit authored); left to now() when a source has none. */
  createdAt?: string;
  /** Present for a record an adapter mapped: written beside the row, in its transaction. */
  structure?: Structure;
  /** The allowlist's unit, for a gated source. */
  scope?: string;
  /** The source's clock for the item (ingest-contract.ts): a stored row whose value under `key` is newer — or the same, written after `asOf` — is not written over; the record is `stale`. */
  watermark?: { key: string; value: string; asOf?: string };
  /** For a record that is a PART of another (a ticket's dated section, SMD-2059): the parent's identity, resolved at the write to whichever writer's row holds it (`source_thought`) and written as the row's `derived_from`. */
  derivedFrom?: Identity;
};

/**
 * A fixed, valid-looking UUID per (source, key), the same construction
 * linearThoughtId uses so the two agree on the linear space: crc32 of the key in
 * the time-low field, xxHash64 of a source-qualified key in the node field, the
 * version/variant nibbles fixed so Postgres accepts it. Deterministic, so a
 * rebuild lands every record on its own id and the upsert can recognise it.
 */
export function recordId(source: string, key: string): string {
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
 * One changes/*.md file as a fork Doc. SMD-1917 moved the fork's changes out of
 * FORK.md into one file each, in two shapes this reader handles through the
 * fragment parser they share with the release step (scripts/fragments.ts):
 *
 *   - A rendered, numbered change (`NNN-slug.md`, e.g. 018-…): no front matter,
 *     the file opens `# N. Title` and the whole file is the change. The number
 *     comes from the filename, the ticket from the text.
 *   - A pending fragment (`smd-NNNN.md`): front matter + `## Changelog` + `## FORK`.
 *     The `## FORK` body is the change as written; the ticket(s) come from the
 *     front matter, and the change number is not assigned until release (null).
 *
 * FORK.md itself is now an index and design record, not the changes, so it is no
 * longer read here (SMD-1806 / SMD-1917).
 */
export function forkDocFromFile(slug: string, text: string): Doc {
  const parsed = parseFragment(text);
  if (parsed) {
    const fork = fragmentSection(parsed.body, "FORK") ?? parsed.body.trim();
    const tickets = Array.isArray(parsed.fm.tickets) ? (parsed.fm.tickets as string[]) : [];
    return { id: recordId("fork", slug), content: fork, source: "fork", meta: { change: null, ticket: tickets[0] ?? null, file: slug } };
  }
  // A numbered rendered change: the fork's own parsers read the number and the
  // owning ticket from the `# N. Title (SMD-…)` heading — the canonical pair the
  // changes index shows — rather than the first SMD id anywhere in the body,
  // which could be an incidental cross-reference ("superseded by", "unlike").
  const heading = headingOf(text);
  const change = heading?.n ?? (Number(slug.match(/^(\d+)-/)?.[1]) || null);
  const ticket = heading ? ticketsOf(heading.title)[0] ?? null : null;
  return { id: recordId("fork", slug), content: text.trim(), source: "fork", meta: { change, ticket, file: slug } };
}

/** Every fork change in the changes/ directory (its README aside). */
export function forkDocs(changesDir: string): Doc[] {
  return readdirSync(changesDir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => forkDocFromFile(f.replace(/\.md$/, ""), readFileSync(join(changesDir, f), "utf8")));
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

/**
 * An adapter's output as a Doc: the row on the deterministic id for its
 * (system, key) — the linear space shared with the eval loader — its text as
 * content, its facets as metadata, and the structure the write records beside
 * the row.
 */
export function docOf(ingested: Ingested): Doc {
  const { system, key } = ingested.identity;
  const source = system;
  // The watermark IS one of the facets — written by the pipeline, not trusted
  // to the adapter: a key the row never carried would leave the clock guard
  // inert, silently (first review pass, independent read).
  const wm = ingested.watermark;
  return {
    id: recordId(source, key),
    content: ingested.text,
    source,
    meta: { ...ingested.facets, ...(wm ? { [wm.key]: wm.value } : {}) },
    createdAt: ingested.createdAt,
    structure: { identity: ingested.identity, canonical: ingested.canonical, links: ingested.links, mentions: ingested.mentions },
    scope: ingested.scope,
    ...(ingested.watermark ? { watermark: ingested.watermark } : {}),
  };
}

/**
 * An item and its parts (SMD-2059) as Docs: the item's own Doc first, then one
 * per derived part — under the item's scope and watermark (the allowlist and
 * the clock judge the parts as they judge the whole), on the part's own
 * identity, and `derivedFrom` the item's identity, which the write resolves to
 * the row that holds it. The parent first, so a derived row finds its parent
 * in the same run.
 */
export function docsOf(ingested: Ingested): Doc[] {
  const parent = docOf(ingested);
  const parts = (ingested.derived ?? []).map((d) => ({
    ...docOf({ ...d, scope: ingested.scope, watermark: ingested.watermark }),
    derivedFrom: ingested.identity,
  }));
  return [parent, ...parts];
}

/** The scope a corpus dump's records carry: the dump is one deliberate export, cleared as one. */
export const LINEAR_CORPUS_SCOPE = "linear:corpus";
/** What a dump built before the `issue` field is refused with — once per run, with the way out. */
export const DUMP_WITHOUT_ISSUE = "the dump carries no `issue` object (built before 2026-09-24); rebuild it — bun evals/build-linear-corpus.ts — so the ingester and the board sync render one text (SMD-1958)";

/**
 * One corpus record (evals/build-linear-corpus.ts) through the Linear adapter
 * — the SAME mapping db/sync-linear.ts feeds its fetch to, over the same input
 * (the dump's `issue` is the issue as the API gave it, the sync's field
 * selection), so the ingester and the sync write one text, one facet set, one
 * canonical, the same links and mentions for a ticket, and on a brain both
 * touch the second writer finds nothing to write (SMD-1958). The eval's own
 * text (`title` / `text`, the title outside the document) is the harnesses'
 * and is not what is stored. The scope is the dump's, not the project's: the
 * dump is one export, cleared as one. A dump without `issue` is refused, not
 * rendered some other way — one renderer.
 */
export function corpusIngested(d: LinearDoc): Ingested {
  if (!d.issue) throw new AdapterRefusal({ system: LINEAR_SYSTEM, key: d.id }, DUMP_WITHOUT_ISSUE);
  if (d.issue.identifier !== d.id) throw new AdapterRefusal({ system: LINEAR_SYSTEM, key: d.id }, `the record's id and its issue's identifier (${d.issue.identifier}) disagree`);
  const mapped = linearAdapter.map(d.issue);
  // The dump's build instant is the second clock (ingest-contract.ts `asOf`): a
  // rename Linear does not stamp is ordered against the brain's last write.
  return { ...mapped, scope: LINEAR_CORPUS_SCOPE, ...(mapped.watermark && d.fetchedAt ? { watermark: { ...mapped.watermark, asOf: d.fetchedAt } } : {}) };
}

/** A Linear corpus dump as Docs, on the shared linear id space, through the adapter; the records the adapter refused are counted, with the first reason. */
export function linearDocs(path: string): { docs: Doc[]; refused: number; reason: string | null } {
  const docs: Doc[] = [];
  let refused = 0;
  let reason: string | null = null;
  for (const d of loadLinearCorpus(path).docs) {
    try { docs.push(...docsOf(corpusIngested(d))); }
    catch (e) {
      if (!(e instanceof AdapterRefusal)) throw e;
      refused++;
      reason ??= e.message;
    }
  }
  return { docs, refused, reason };
}

/**
 * A Markdown / Obsidian vault as Docs through its adapter. A file the adapter
 * refuses (not UTF-8, a NUL byte) is returned under `refused` with the reason,
 * so the run says which files it did not take and why, and takes the rest.
 */
export function markdownDocs(root: string): { docs: Doc[]; refused: { path: string; reason: string }[] } {
  const docs: Doc[] = [];
  const refused: { path: string; reason: string }[] = [];
  const scope = resolve(root);
  // Two notes of one identity — the same name in two folders, with no
  // frontmatter id — would map to ONE deterministic row id, and the second
  // would silently overwrite the first's text (first review pass: the limits
  // list promised IDENTITY_HELD, which the id construction never reaches).
  // The first file, in walk order, keeps the identity; the rest are refused by
  // name, and the fix is a rename — the name IS the identity (sixth review
  // pass: the message said "give one a frontmatter id", which since the third
  // pass changes nothing).
  const holders = new Map<string, string>();
  for (const f of markdownFiles(scope)) {
    try {
      const doc = docOf(markdownAdapter.map({ ...f, root: scope }));
      const key = doc.structure!.identity.key;
      const holder = holders.get(key);
      if (holder !== undefined) { refused.push({ path: f.path, reason: `identity "${key}" is already ${holder}'s — two notes of one name; rename one (the name is the identity, as a wikilink names it)` }); continue; }
      holders.set(key, f.path);
      docs.push(doc);
    } catch (e) {
      if (!(e instanceof AdapterRefusal)) throw e;
      refused.push({ path: f.path, reason: e.message });
    }
  }
  return { docs, refused };
}

/** What a file of items yields as Docs: one per line, on `recordId(system, key)`, labelled with the item's system; the systems counted; the links normaliseLinks set aside. Throws ItemsRefusal for a malformed line — the file whole. Given the file's BYTES, a line that is not UTF-8 is refused rather than repaired. */
export function itemDocs(input: string | Uint8Array, label: string): { docs: Doc[]; systems: Record<string, number>; linksDropped: number } {
  const parsed = parseItems(input, label);
  return { docs: parsed.items.map(docOf), systems: parsed.systems, linksDropped: parsed.linksDropped };
}

/**
 * The allowlist applied to a set of records: every record an adapter mapped
 * (it carries a structure — external content, whatever its source label) whose
 * scope is not cleared is set aside with the refusal's words (one line per
 * scope, not per record); the rest pass. The fork's own records carry no
 * structure and always pass. Gating on the structure, not on a list of source
 * names, so an adapter added later cannot slip past the gate by its name
 * (first review pass).
 */
export function applyAllowlist(docs: Doc[], allow: Allowlist): { docs: Doc[]; refused: Doc[]; reasons: string[] } {
  const kept: Doc[] = [];
  const refused: Doc[] = [];
  const reasons = new Map<string, string>();
  for (const d of docs) {
    if (d.structure === undefined) { kept.push(d); continue; }
    const why = scopeRefusal(allow, { identity: d.structure.identity, scope: d.scope ?? "" }, d.source);
    if (why === null) { kept.push(d); continue; }
    refused.push(d);
    if (!reasons.has(d.scope ?? "")) reasons.set(d.scope ?? "", why);
  }
  return { docs: kept, refused, reasons: [...reasons.values()] };
}

/**
 * `--allow` / OB1_INGEST_ALLOW as scopes: an entry that names a path (it holds
 * a separator) is resolved the way the markdown scope is, so `--markdown
 * ./vault --allow ./vault` clears the vault; every other entry is taken as
 * written (first review pass: a relative path never matched its resolved scope).
 */
export function allowlistOf(value: string | undefined): Allowlist {
  return new Set([...allowlistFrom(value)].map((s) => (s.includes("/") ? resolve(s) : s)));
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

/** inserted: a new row. updated: the text moved (vector and chunks cleared). patched: the text stood and metadata moved. unchanged: nothing to write. skipped: another record already holds this text. held: another thought already IS this source item (thought_sources), nothing written. stale: the row carries a newer watermark than the record — an older dump over a brain kept current — nothing written. */
export type UpsertResult = "inserted" | "updated" | "patched" | "unchanged" | "skipped" | "held" | "stale";

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
 * The ingester's envelope: 050's stamp reads it, so every record carries
 * actor_name `ingest-records` (and the kind once the operator has said
 * `SELECT set_agent_kind('ingest-records', 'ingested')` — the ingester does
 * not classify itself; 046's rule is that the operator does), and 046's audit
 * rows carry the door. Without it every record named nobody and a re-ingest
 * stripped the mark an operator's edit had placed (run-it, SMD-1726's first
 * review pass). It rides each record's own transaction, set locally beside
 * the INSERT: a session-level setting died with the connection, and Bun's
 * pool reopens one silently, after which every record named nobody again
 * (run-it, second review pass).
 */
export const INGEST_ACTOR = { name: "ingest-records", via: "ingest-records" } as const;

/** The two keys 050's trigger owns: never compared, never merged — the trigger stamps them from the envelope. */
const ACTOR_KEYS = ["actor_kind", "actor_name"] as const;

/** A run's name for thought_sources.ingest_run — this tool and the moment it started (ingest-structure.ts's rule, the ingester's name). */
export function runName(tool: string = INGEST_ACTOR.via, at: Date = new Date()): string {
  return structureRunName(tool, at);
}

/** What one record's write said: the row's outcome, and the structure's counts when the record carried one. */
export type RecordResult = {
  outcome: UpsertResult;
  structure?: StructureResult;
  /** For `held`: the thought that holds the identity. */
  heldBy?: string;
};

/**
 * Upsert one bare row and, for a record an adapter mapped, its structure —
 * one transaction per record: the envelope, the row, the canonical, the
 * links, the mentions; a skipped record's error aborts its own transaction
 * only, so the run is idempotent and re-runnable whatever one record did.
 *
 * The row is keyed on the record's deterministic id. Same id, same text
 * (003's fingerprint) and no new metadata is "unchanged" — no UPDATE runs,
 * updated_at does not move. A text that moved is "updated": content and
 * fingerprint replaced, and the vector, its label and the chunk rows CLEARED —
 * the vector was the old text's, and reembed.ts pools rows without one, where
 * a stale vector under new text was pooled by nothing (SMD-1958). A text that
 * stood while the metadata gained keys is "patched". Metadata is MERGED
 * (`thoughts.metadata || record`), never replaced: the board sync's facets,
 * the extractor's tags and 050's marks on a row survive a rebuild over it;
 * the two actor keys are left to 050's trigger on both sides of the compare.
 *
 * A different record whose content is byte-identical to one already stored
 * collides on the partial-unique content_fingerprint index (23505), not on
 * id; that is "skipped" — the content already exists as another record.
 *
 * A record with a watermark (the source's clock, as a facet — Linear's
 * `linear_updated_at`) is written only when the row's stored value is not
 * newer; a row the board sync moved past the dump is left as it is, structure
 * included, and the record is "stale" (SMD-1958: a Monday dump on Friday would
 * otherwise put every moved ticket back to Monday, and the next sync pass
 * forward again). The values compare as text, in the same clause that guards
 * the write, so the read and the decision are one statement. When the two
 * values are EQUAL the source's clock has not settled it — Linear renames a
 * project, a state or a label without touching `updatedAt`, and the sync
 * re-renders the ticket from the census — so the brain's clock does: a row
 * written after the record's view was taken (`asOf`, the dump's build
 * instant) is left as it is, and the record is "stale" too; without an
 * `asOf` the record writes, as before (first review pass, independent read:
 * the guard let a Monday dump undo Tuesday's rename). `updated_at` is the
 * brain's LAST WRITE by anyone — the sync's re-render, but also a facet
 * patch, a re-embed, a retag, a hand edit — so a rename the dump saw and such
 * a write followed reads "stale" for a reason that is not a later view; the
 * sync's next pass lands the rename from its census, so the cost is a delay
 * and an overstated count, never a lost write (second review pass).
 */
export async function upsertRecord(sql: SQL, doc: Doc, run: string = runName()): Promise<RecordResult> {
  const meta = { ...doc.meta, source: doc.source };
  for (const k of ACTOR_KEYS) delete (meta as Record<string, unknown>)[k];
  const created = doc.createdAt ?? null;
  const wmKey = doc.watermark?.key ?? null;
  const wmValue = doc.watermark?.value ?? null;
  const asOf = doc.watermark?.asOf ?? null;
  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT set_config('ob1.actor', ${JSON.stringify(INGEST_ACTOR)}, true)`;
      // Another thought already IS this item — the board sync's row for a
      // ticket, found by identity (thought_sources; on a brain the sync filled
      // before 053, its metadata.issue claim). Asked BEFORE the write: with one
      // renderer the sync's row holds the same text, so the insert would trip
      // the fingerprint index first and read `skipped` — true, and the wrong
      // word for a row that is this very ticket (run-it, test-live [22]).
      // record_thought_source's IDENTITY_HELD stays the backstop for the race
      // between this look and the write.
      if (doc.structure) {
        const [h] = (await tx`SELECT source_thought(${doc.structure.identity.system}, ${doc.structure.identity.key})::text AS t`) as { t: string | null }[];
        if (h?.t && h.t !== doc.id) return { outcome: "held", heldBy: h.t };
      }
      // A part's parent (SMD-2059): the row that holds the parent's identity
      // NOW — this run's own row, or the board sync's — so `derived_from` names
      // whichever writer's ticket row stands. A parent no row holds (refused,
      // or not in this run) leaves the column NULL rather than name nothing.
      let derivedFrom: string[] | null = null;
      if (doc.derivedFrom) {
        const [p] = (await tx`SELECT source_thought(${doc.derivedFrom.system}, ${doc.derivedFrom.key})::text AS t`) as { t: string | null }[];
        if (p?.t) derivedFrom = [p.t];
      }
      // `old` is read before the write so RETURNING can say whether the text
      // moved — an UPDATE's RETURNING sees only the new row. The two actor
      // keys are removed from EXCLUDED on both sides: 050's BEFORE INSERT
      // trigger stamps them onto the proposed row, and a kind the operator
      // classified since the last run would otherwise re-write every row once.
      const rows = (await tx`
        WITH old AS (SELECT content_fingerprint AS fp FROM thoughts WHERE id = ${doc.id}::uuid)
        INSERT INTO thoughts (id, content, metadata, content_fingerprint, created_at, derived_from)
        VALUES (${doc.id}::uuid, ${doc.content}, ${meta}::jsonb, content_fingerprint_of(${doc.content}), COALESCE(${created}::timestamptz, now()), ${derivedFrom}::jsonb)
        ON CONFLICT (id) DO UPDATE
          SET content = CASE WHEN thoughts.content_fingerprint IS DISTINCT FROM EXCLUDED.content_fingerprint THEN EXCLUDED.content ELSE thoughts.content END,
              content_fingerprint = CASE WHEN thoughts.content_fingerprint IS DISTINCT FROM EXCLUDED.content_fingerprint THEN EXCLUDED.content_fingerprint ELSE thoughts.content_fingerprint END,
              embedding = CASE WHEN thoughts.content_fingerprint IS DISTINCT FROM EXCLUDED.content_fingerprint THEN NULL ELSE thoughts.embedding END,
              embedding_model = CASE WHEN thoughts.content_fingerprint IS DISTINCT FROM EXCLUDED.content_fingerprint THEN NULL ELSE thoughts.embedding_model END,
              metadata = COALESCE(thoughts.metadata, '{}'::jsonb) || (EXCLUDED.metadata - 'actor_kind' - 'actor_name'),
              derived_from = COALESCE(EXCLUDED.derived_from, thoughts.derived_from)
          WHERE (${wmValue}::text IS NULL OR thoughts.metadata->>(${wmKey}::text) IS NULL
                 OR thoughts.metadata->>(${wmKey}::text) < ${wmValue}::text
                 OR (thoughts.metadata->>(${wmKey}::text) = ${wmValue}::text AND (${asOf}::timestamptz IS NULL OR thoughts.updated_at <= ${asOf}::timestamptz)))
            AND (thoughts.content_fingerprint IS DISTINCT FROM EXCLUDED.content_fingerprint
              OR (COALESCE(thoughts.metadata, '{}'::jsonb) || (EXCLUDED.metadata - 'actor_kind' - 'actor_name')) IS DISTINCT FROM thoughts.metadata
              OR COALESCE(EXCLUDED.derived_from, thoughts.derived_from) IS DISTINCT FROM thoughts.derived_from)
        RETURNING (xmax = 0) AS inserted, ((SELECT fp FROM old) IS DISTINCT FROM thoughts.content_fingerprint) AS moved`) as { inserted: boolean; moved: boolean }[];
      // The guard asks "would the merge change the row" — the merged value
      // against the stored one — not containment: `@>` holds when an array
      // facet SHRANK (a label removed: ["a","b"] contains ["a"]), and the row
      // would have kept the stale list for good (first review pass).
      let outcome: UpsertResult = "unchanged";
      if (rows.length) outcome = rows[0].inserted ? "inserted" : rows[0].moved ? "updated" : "patched";
      // No row written and a watermark to compare: was it a clock that said
      // no, to a record that had something to write? Then the structure is not
      // recorded either — the record's links and mentions are the older
      // state's, and would close what the sync wrote. A record with nothing to
      // write is `unchanged` whatever the clocks say (the same dump twice).
      if (!rows.length && wmValue !== null) {
        const [w] = (await tx`
          SELECT ((metadata->>(${wmKey}::text)) > ${wmValue}::text
                  OR ((metadata->>(${wmKey}::text)) = ${wmValue}::text AND updated_at > ${asOf}::timestamptz)) AS blocked,
                 (content_fingerprint IS DISTINCT FROM content_fingerprint_of(${doc.content})
                  OR (COALESCE(metadata, '{}'::jsonb) || (${meta}::jsonb - 'actor_kind' - 'actor_name')) IS DISTINCT FROM metadata
                  OR COALESCE(${derivedFrom}::jsonb, derived_from) IS DISTINCT FROM derived_from) AS pending
          FROM thoughts WHERE id = ${doc.id}::uuid`) as { blocked: boolean | null; pending: boolean | null }[];
        if (w?.blocked === true && w.pending === true) return { outcome: "stale" };
      }
      // The chunk rows were the old text's windows (022's rule: nothing vouches
      // for them now); reembed.ts writes the new ones with the vector.
      if (outcome === "updated") await tx`DELETE FROM thought_chunks WHERE thought_id = ${doc.id}::uuid`;
      if (!doc.structure) return { outcome };
      return { outcome, structure: await recordStructure(tx, doc.id, doc.structure, run) };
    });
  } catch (e) {
    if (isFingerprintCollision(e)) return { outcome: "skipped" };
    // The transaction rolled back with it: no second row for an item another
    // thought already is. The ingester's ids are deterministic, so this is a
    // real second writer (the board sync's row for a ticket — db/README.md,
    // "Two writers of one identity"), reported, not taken over.
    if (e instanceof IdentityHeld) return { outcome: "held", heldBy: e.heldBy };
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
export function dedupeByContent(docs: Doc[]): { docs: Doc[]; dropped: number; duplicates: { doc: Doc; of: Doc }[] } {
  const seen = new Map<string, Doc>();
  const kept: Doc[] = [];
  const duplicates: { doc: Doc; of: Doc }[] = [];
  for (const d of docs) {
    const holder = seen.get(d.content);
    if (holder) { duplicates.push({ doc: d, of: holder }); continue; }
    seen.set(d.content, d);
    kept.push(d);
  }
  return { docs: kept, dropped: duplicates.length, duplicates };
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

  const numbered = forkDocFromFile("042-a-change", "# 42. A change — the thing (SMD-1300)\n\nthe body\nmore body");
  ok(numbered.source === "fork" && numbered.meta.change === 42 && numbered.meta.ticket === "SMD-1300", "a numbered change: number and owning ticket from the `# N. Title (SMD-…)` heading");
  ok(/# 42\. A change/.test(numbered.content) && /more body/.test(numbered.content), "…and its whole file is the content");
  const noTitleTicket = forkDocFromFile("018-long-captures", "# 18. Long captures — `thought_chunks`\n\nbody unlike SMD-968's approach");
  ok(noTitleTicket.meta.change === 18 && noTitleTicket.meta.ticket === null, "…and a title with no ticket carries null, not an incidental body reference (SMD-968)");
  const pending = forkDocFromFile("smd-1806", "---\ntype: added\nbump: minor\ntickets: [SMD-1806]\nmigrations: []\n---\n\n## Changelog\n\none line (SMD-1806)\n\n## FORK\n\nThe title line (SMD-1806)\n\nthe record body.");
  ok(pending.meta.change === null && pending.meta.ticket === "SMD-1806", "a pending fragment: no change number yet, ticket from the front matter");
  ok(pending.content.startsWith("The title line (SMD-1806)") && /the record body/.test(pending.content) && !/## Changelog/.test(pending.content), "…and the content is the `## FORK` body alone");

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

  const { docs: deduped, dropped, duplicates } = dedupeByContent([
    { id: "a", content: "same", source: "fork", meta: {} },
    { id: "b", content: "same", source: "commit", meta: {} },
    { id: "c", content: "other", source: "fork", meta: {} },
  ]);
  ok(deduped.length === 2 && dropped === 1 && duplicates.length === 1 && duplicates[0].doc.id === "b" && duplicates[0].of.id === "a", "identical content across records is de-duped, first kept, the dropped record named with the one that holds its text");

  // The contract's pipeline (SMD-1867) and the one renderer (SMD-1958): a
  // corpus record is its `issue` through the Linear adapter — the text the
  // board sync writes, byte for byte; the eval's own title/text are not stored.
  const issue = { ...SAMPLE_ISSUE, identifier: "SMD-10", description: "Body naming <issue id=\"a\" href=\"h\">SMD-11</issue> and <issue id=\"b\" href=\"h\">SMD-10</issue>.", labels: { nodes: [{ name: "infra" }, { name: "Bug" }] } };
  const record: LinearDoc = { id: "SMD-10", title: "A title", text: "the eval's document", labels: ["infra", "Bug"], createdAt: issue.createdAt, issue };
  const corpus = corpusIngested(record);
  ok(corpus.text === renderIssue(issue) && /^SMD-10 — /.test(corpus.text) && !/the eval's document/.test(corpus.text), `the text is the adapter's render of the issue — the sync's text — not the eval's title + text (${JSON.stringify(corpus.text.split("\n")[0])})`);
  ok(JSON.stringify(corpus.links) === '[{"relation":"references","target":"SMD-11"}]', "a cross-reference is a references link; the record's own identifier is not");
  ok(corpus.mentions.map((m) => `${m.type}:${m.name}`).join(",") === `project:${issue.project!.name},topic:Bug,topic:infra` && corpus.scope === LINEAR_CORPUS_SCOPE, `project and labels are mentions as the sync's are; the scope is the corpus, not the project (${corpus.mentions.map((m) => m.name).join(",")})`);
  ok(/<issue id=/.test(corpus.canonical.form) && corpus.canonical.form === linearAdapter.map(issue).canonical.form, "the canonical is the issue as the API gave it, markup included — the same bytes the sync stores, so a rebuild over a synced brain reads it unchanged");
  ok(corpus.facets.status === "Backlog" && corpus.facets[WATERMARK_KEY] === issue.updatedAt && corpus.watermark?.value === issue.updatedAt && corpus.watermark.asOf === undefined, "the facets are the sync's, the watermark the issue's updatedAt; a dump without a build instant carries no asOf");
  ok(corpusIngested({ ...record, fetchedAt: "2026-09-24T00:00:00.000Z" }).watermark?.asOf === "2026-09-24T00:00:00.000Z", "…and the dump's build instant is the watermark's asOf — the second clock");
  const doc = docOf(corpus);
  ok(doc.id === linearThoughtId("SMD-10") && doc.source === "linear" && doc.meta.issue === "SMD-10" && doc.content === corpus.text && doc.structure?.identity.key === "SMD-10" && doc.scope === LINEAR_CORPUS_SCOPE && doc.watermark?.key === WATERMARK_KEY, "docOf: the eval's id space, the source, the facets, the structure and the watermark carried");
  ok(docOf({ ...corpus, facets: { issue: "SMD-10" }, watermark: { key: "clock", value: "v1" } }).meta.clock === "v1", "…and the watermark is written into the row's metadata by the pipeline, so the clock guard is never inert for an adapter that forgot the facet");
  // A ticket's dated sections as records of their own (SMD-2059): the parent
  // first, then each part on its own identity under the parent's scope and
  // clock, derived from the parent's identity.
  const sectioned = corpusIngested({ ...record, fetchedAt: "2026-09-24T00:00:00.000Z", issue: { ...issue, description: "## Problem\n\nx\n\n## Update 2026-09-19 (board audit)\n\nStill open." } });
  const family = docsOf(sectioned);
  ok(family.length === 2 && family[0].id === linearThoughtId("SMD-10") && family[0].derivedFrom === undefined, "the parent is the first Doc, on the ticket's id, derived from nothing");
  const part = family[1];
  ok(part.id === recordId("linear", "SMD-10#update-2026-09-19-board-audit") && part.source === "linear" && part.derivedFrom?.key === "SMD-10" && part.scope === LINEAR_CORPUS_SCOPE && part.watermark?.value === issue.updatedAt && part.watermark.asOf === "2026-09-24T00:00:00.000Z", `a part is a Doc on its own id, derived from the parent's identity, under the parent's scope and clock (${part.id})`);
  ok(part.meta.type === "observation" && part.meta.ticket === "SMD-10" && part.meta.issue === undefined && part.meta.observed_at === "2026-09-19" && part.createdAt === "2026-09-19T00:00:00.000Z" && part.structure?.identity.key === "SMD-10#update-2026-09-19-board-audit", "…an observation naming the ticket under `ticket`, dated by its heading, with a structure of its own");
  ok(applyAllowlist(family, allowlistFrom("")).refused.length === 2 && applyAllowlist(family, allowlistFrom(LINEAR_CORPUS_SCOPE)).docs.length === 2, "the allowlist judges the parts with the whole");
  ok(docOf({ ...corpus, identity: { system: "markdown", key: "Note" } }).id === recordId("markdown", "Note"), "…and a markdown record lands on its own source-qualified id");
  let refusal = "";
  try { corpusIngested({ id: "SMD-10", title: "A title", text: "old dump" }); } catch (e) { refusal = e instanceof AdapterRefusal ? e.message : `wrong: ${(e as Error).name}`; }
  ok(/built before 2026-09-24/.test(refusal) && /build-linear-corpus/.test(refusal), `a dump without \`issue\` is refused with the rebuild command, not rendered another way (${refusal.slice(0, 60)})`);
  refusal = "";
  try { corpusIngested({ ...record, id: "SMD-99" }); } catch (e) { refusal = e instanceof AdapterRefusal ? e.message : "wrong"; }
  ok(/disagree/.test(refusal), "a record whose id and issue identifier disagree is refused");

  // Items from a file (SMD-2136): a line is a Doc on its system's id space, labelled with the system, structure and scope carried; a malformed line refuses the file in the flag's words.
  ok(JSON.stringify([...RESERVED_SYSTEMS].sort()) === JSON.stringify([...SOURCES].sort()), `the systems a file may not claim are exactly the pipeline's own sources (${RESERVED_SYSTEMS.join(",")} vs ${SOURCES.join(",")})`);
  const fromFile = itemDocs(`${SAMPLE_LINE}\n${JSON.stringify({ ...SAMPLE_ITEM, identity: { system: "readwise", key: "h-1" }, scope: "readwise:export", text: "a highlight" })}\n`, "--items out.jsonl");
  ok(fromFile.docs.length === 2 && fromFile.docs[0].id === recordId("chatgpt", "conv-8f3a") && fromFile.docs[0].source === "chatgpt" && fromFile.docs[1].source === "readwise" && fromFile.systems.chatgpt === 1 && fromFile.systems.readwise === 1, "an item is a Doc on recordId(system, key), labelled with its own system, the systems counted");
  ok(fromFile.docs[0].content === SAMPLE_ITEM.text && fromFile.docs[0].structure?.canonical.form === SAMPLE_ITEM.canonical.form && fromFile.docs[0].structure.links.length === 1 && fromFile.docs[0].structure.mentions.length === 1 && fromFile.docs[0].scope === SAMPLE_ITEM.scope && fromFile.docs[0].createdAt === SAMPLE_ITEM.createdAt, "…its text, canonical, links, mentions, scope and createdAt carried into the Doc");
  ok(fromFile.docs[0].watermark?.key === "chatgpt_updated_at" && fromFile.docs[0].meta.chatgpt_updated_at === "2026-09-02T00:00:00Z" && fromFile.docs[0].meta.title === "Postgres pooling", "…the watermark and the facets are the row's metadata");
  ok(applyAllowlist(fromFile.docs, allowlistFrom("")).refused.length === 2 && applyAllowlist(fromFile.docs, allowlistFrom(SAMPLE_ITEM.scope)).docs.length === 1, "an item is gated by its scope as an adapter's record is — the structure is the tell; one scope cleared passes one");
  let fileRefusal = "";
  try { itemDocs(`${SAMPLE_LINE}\n${JSON.stringify({ ...SAMPLE_ITEM, identity: { system: "chatgpt", key: "k2" } })}\n${JSON.stringify({ ...SAMPLE_ITEM, identity: 1 })}\n`, "--items out.jsonl"); } catch (e) { fileRefusal = e instanceof ItemsRefusal ? e.message : `wrong: ${(e as Error).name}`; }
  ok(/^--items out\.jsonl: line 3: identity: /.test(fileRefusal), `a malformed third line refuses the file, naming the flag, the line and the field (${fileRefusal.slice(0, 60)})`);

  // The allowlist (SMD-1813): gated sources refuse by scope, one line per scope; the fork's own records pass.
  const gated = applyAllowlist([doc, { ...doc, id: "x" }, { id: "f", content: "c", source: "fork", meta: {} }], allowlistFrom(""));
  ok(gated.docs.length === 1 && gated.docs[0].source === "fork" && gated.refused.length === 2 && gated.reasons.length === 1 && /^linear: scope "linear:corpus" is not on the allowlist/.test(gated.reasons[0]) && /--allow "linear:corpus"/.test(gated.reasons[0]), `an empty allowlist refuses every gated record, says so once per scope, names the knob (${gated.reasons[0]})`);
  ok(applyAllowlist([doc], allowlistFrom(" linear:corpus , other ")).docs.length === 1, "a cleared scope passes (list trimmed)");
  ok(applyAllowlist([doc], allowlistFrom("linear")).docs.length === 0, "a prefix is not a clearance — exact scope only");
  ok(applyAllowlist([{ ...doc, source: "future" }], allowlistFrom("")).docs.length === 0, "a record an adapter mapped is gated whatever its source label — the structure is the tell, not a list of names");
  ok(allowlistOf("./vault, linear:corpus").has(resolve("./vault")) && allowlistOf("./vault, linear:corpus").has("linear:corpus"), "an allow entry that names a path is resolved as the markdown scope is; the rest are taken as written");
  ok(runName("t", new Date("2026-09-23T00:00:00.000Z")) === "t@2026-09-23T00:00:00.000Z", "a run is named by tool and moment");

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
    const TAKES_ONE = new Set(["url", "source", "linear", "memory-dir", "markdown", "items", "allow", "tier", "since"]);
    const TAKES_NONE = new Set(["dry-run", "self-check"]);
    const USAGE = "  flags: --url <postgres://…>, --source <all|fork|commit|linear|memory|markdown|items>, --linear <dump.json>, --memory-dir <path>, --markdown <vault root>, --items <file.jsonl | ->, --allow <scope,scope> (or OB1_INGEST_ALLOW), --tier <stable|canary|working>, --since <ref>, --dry-run, --self-check";
    const seen = new Set<string>();
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const name = a.startsWith("--") ? a.slice(2) : null;
      if (name !== null && (TAKES_ONE.has(name) || TAKES_NONE.has(name))) {
        if (seen.has(name)) { console.error(`--${name} given twice.\n${USAGE}`); process.exit(2); }
        seen.add(name);
      }
      if (name !== null && TAKES_ONE.has(name)) {
        // An empty value is no value: `--items "$OUT"` with the variable unset would otherwise read as the flag absent and the run would write nothing, exit 0 (third review pass, cold read).
        if (i + 1 >= args.length || args[i + 1].startsWith("--") || args[i + 1] === "") { console.error(`--${name} takes a value${i + 1 < args.length && args[i + 1] === "" ? " (an empty one was given)" : ""}.\n${USAGE}`); process.exit(2); }
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
  const markdownDir = flag("markdown") ?? process.env.OB1_MARKDOWN_DIR;
  const itemsPath = flag("items");
  // SMD-1813's allowlist: the flag, else the environment; empty clears nothing.
  const allow = allowlistOf(flag("allow") ?? process.env.OB1_INGEST_ALLOW);

  // Gather. A source in the wanted set with no input to read is skipped with a
  // word on stderr, not an error — `--source all` on a bare checkout ingests
  // fork + commit and says linear/memory/markdown had no source given.
  const collected: Doc[] = [];
  const perSource: Record<string, number> = {};
  const note = (s: Source, msg: string) => console.error(`  ${s}: ${msg}`);

  if (wanted.has("fork")) {
    const docs = forkDocs(join(REPO_ROOT, "changes"));
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
    else {
      const { docs, refused, reason } = linearDocs(linearPath);
      // A dump refused WHOLE is a wrong input, as a missing file is — exit 2,
      // not a stderr note beside a run that ingests the other sources and
      // exits 0 (first review pass, independent read).
      if (refused && docs.length === 0) { console.error(`--linear: every record of ${linearPath} was refused — ${reason}`); process.exit(2); }
      perSource.linear = docs.length;
      collected.push(...docs);
      if (refused) note("linear", `${refused} record(s) refused — ${reason}`);
    }
  }
  if (wanted.has("memory")) {
    if (!memoryDir) note("memory", "skipped — pass --memory-dir <path> or set OB1_MEMORY_DIR (the *.md memory files)");
    else if (!existsSync(memoryDir)) { console.error(`--memory-dir: no such directory: ${memoryDir}`); process.exit(2); }
    else { const docs = memoryDocs(memoryDir); perSource.memory = docs.length; collected.push(...docs); }
  }
  if (wanted.has("markdown")) {
    if (!markdownDir) note("markdown", "skipped — pass --markdown <vault root> or set OB1_MARKDOWN_DIR (a Markdown / Obsidian vault)");
    else if (!existsSync(markdownDir)) { console.error(`--markdown: no such directory: ${markdownDir}`); process.exit(2); }
    else {
      const { docs, refused } = markdownDocs(markdownDir);
      perSource.markdown = docs.length;
      collected.push(...docs);
      for (const r of refused) note("markdown", `refused ${r.path} — ${r.reason}`);
    }
  }
  // The items' systems are their own labels; the refusal count below finds
  // them by id, since `d.source` names the system, not this source.
  const itemIds = new Set<string>();
  let itemSystems: Record<string, number> = {};
  if (itemsPath && !wanted.has("items")) note("items", `--items given but items is not in --source ${sourceArg}; the file was not read`);
  if (wanted.has("items")) {
    if (!itemsPath) note("items", "skipped — pass --items <file.jsonl> (one ingestion-contract item per line; `-` reads stdin)");
    else {
      // The BYTES, not a decoded string: a byte that is not UTF-8 is a line
      // to refuse, where an encoding here would have repaired it to U+FFFD
      // and the canonical would no longer be the source's (SMD-2136, first
      // review pass, run-it).
      let text: Uint8Array;
      if (itemsPath === "-") text = await Bun.stdin.bytes();
      else if (!existsSync(itemsPath)) { console.error(`--items: no such file: ${itemsPath}`); process.exit(2); }
      // A directory is refused by name (readFileSync would die with EISDIR); a
      // pipe — `<(python3 emit.py)`, a FIFO — reads to its end as a file does
      // (second review pass: the first pass refused everything but a plain file).
      else if (statSync(itemsPath).isDirectory()) { console.error(`--items: a directory, not a file: ${itemsPath}`); process.exit(2); }
      else {
        try { text = readFileSync(itemsPath); }
        catch (e) { console.error(`--items: cannot read ${itemsPath}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`); process.exit(2); }
      }
      // A malformed line is a wrong input, as a missing file is: exit 2 with the
      // line and the field, the file refused WHOLE, before any write — the
      // gather precedes every write, so no row of a refused file is ever half
      // in (SMD-2136).
      let parsed: ReturnType<typeof itemDocs>;
      try { parsed = itemDocs(text, `--items ${itemsPath}`); }
      catch (e) {
        if (!(e instanceof ItemsRefusal)) throw e;
        console.error(`${e.message} — the file is refused whole; nothing written. Fix the line and run again.`);
        process.exit(2);
      }
      perSource.items = parsed.docs.length;
      itemSystems = parsed.systems;
      for (const d of parsed.docs) itemIds.add(d.id);
      collected.push(...parsed.docs);
      if (parsed.linksDropped) note("items", `${parsed.linksDropped} link(s) set aside — a link to the item itself, a duplicate, or an empty target (ingest-contract.ts normaliseLinks)`);
    }
  }

  // The allowlist before the dedupe, so a refused record never claims a text
  // a cleared one carries; the refusals are counted per source and said once
  // per scope, with the knob that clears it.
  const gate = applyAllowlist(collected, allow);
  for (const line of gate.reasons) console.error(`  ${line}`);
  const refusedPerSource: Record<string, number> = {};
  for (const d of gate.refused) { const s = itemIds.has(d.id) ? "items" : d.source; refusedPerSource[s] = (refusedPerSource[s] ?? 0) + 1; }

  const { docs, dropped, duplicates } = dedupeByContent(gate.docs);
  // An emitter cannot see which of its lines fell to another's text: named,
  // one per dropped item, with the record that holds the text.
  for (const { doc, of } of duplicates) {
    if (!itemIds.has(doc.id)) continue;
    const name = (d: Doc) => d.structure ? `${d.structure.identity.system} ${JSON.stringify(d.structure.identity.key)}` : `${d.source} ${d.id}`;
    note("items", `${name(doc)} dropped — its text is byte-identical to ${name(of)}'s, which holds it; one text is one row (no canonical, links or mentions are written for the dropped item)`);
  }
  const printCounts = () => {
    for (const s of SOURCES) {
      if (perSource[s] === undefined) continue;
      const refused = refusedPerSource[s] ?? 0;
      const systems = s === "items" && perSource[s] ? ` (${Object.entries(itemSystems).map(([k, n]) => `${k} ${n}`).join(", ")})` : "";
      console.log(`  ${s}: ${perSource[s]} record(s)${systems}${refused ? ` — ${refused} REFUSED by the allowlist (the scope and the knob that clears it are said above)` : ""}`);
    }
  };

  if (dryRun) {
    printCounts();
    console.log(`  total: ${docs.length} to write${dropped ? `, ${dropped} duplicate-content dropped` : ""} (dry run — nothing written)`);
    return;
  }

  const url = flag("url") ?? process.env.DATABASE_URL;
  if (!url) { console.error("No database URL. Pass --url or set DATABASE_URL."); process.exit(2); }

  const sql = new SQL({ url, max: 1 });
  const run = runName();
  const tally: Record<UpsertResult, number> = { inserted: 0, updated: 0, patched: 0, unchanged: 0, skipped: 0, held: 0, stale: 0 };
  const structure = { canonical: { inserted: 0, updated: 0, unchanged: 0 } as Record<string, number>, links: { added: 0, closed: 0, kept: 0, dropped: 0 }, mentions: 0, records: 0 };
  const heldBy = new Map<string, number>();
  try {
    for (const doc of docs) {
      const r = await upsertRecord(sql, doc, run);
      tally[r.outcome]++;
      if (r.outcome === "held") heldBy.set(doc.source, (heldBy.get(doc.source) ?? 0) + 1);
      if (r.structure) {
        structure.records++;
        structure.canonical[r.structure.canonical] = (structure.canonical[r.structure.canonical] ?? 0) + 1;
        for (const k of ["added", "closed", "kept", "dropped"] as const) structure.links[k] += r.structure.links[k];
        structure.mentions += r.structure.mentions;
      }
    }
    await stampTier(sql, tier);
  } finally {
    await sql.close();
  }

  printCounts();
  const parts = docs.filter((d) => d.derivedFrom).length;
  console.log(`  tier=${tier}  inserted ${tally.inserted}  updated ${tally.updated}  patched ${tally.patched}  unchanged ${tally.unchanged}  skipped ${tally.skipped}  held ${tally.held}  stale ${tally.stale}${dropped ? `  (+${dropped} duplicate-content dropped)` : ""}${parts ? `  (${parts} of the records are derived parts — a ticket's dated sections, SMD-2059)` : ""}`);
  for (const [source, n] of heldBy) console.log(`  ${source}: ${n} record(s) HELD — another thought already is that source item (the board sync's row for a ticket, on a brain it keeps); nothing written for them. db/README.md, "Two writers of one identity".`);
  if (tally.stale) console.log(`  ${tally.stale} record(s) STALE — the row carries a newer watermark than the record (the board sync moved the ticket past this dump); nothing written for them. Rebuild the dump, or let the sync keep the board.`);
  if (structure.records) {
    console.log(`  structure (${structure.records} record(s), run ${run}): canonical inserted ${structure.canonical.inserted ?? 0} updated ${structure.canonical.updated ?? 0} unchanged ${structure.canonical.unchanged ?? 0}; links added ${structure.links.added} closed ${structure.links.closed} kept ${structure.links.kept} dropped ${structure.links.dropped}; structured mentions ${structure.mentions}`);
  }
  console.log(`  next: bun db/reembed.ts --url … — embed the new rows (vectors + chunks) through the claim path.`);
}

if (import.meta.main) await main();
