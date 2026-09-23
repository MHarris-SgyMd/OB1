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
 *   fork     — the fork's changes, one changes/*.md file each (SMD-1917). In the tree; no flag.
 *   commit   — git commit messages since the upstream pin. In the tree; no flag.
 *   linear   — a corpus dump built by evals/build-linear-corpus.ts. Needs --linear,
 *              through the Linear adapter (db/ingest-linear.ts, SMD-1867).
 *   memory   — the *.md memory files (not MEMORY.md, the index). Needs --memory-dir
 *              or OB1_MEMORY_DIR — they live outside the repo, in the operator's
 *              ~/.claude, so there is no portable default and this tool reads,
 *              never writes, them.
 *   markdown — a Markdown / Obsidian vault, through the Markdown adapter
 *              (db/ingest-markdown.ts). Needs --markdown <root> or OB1_MARKDOWN_DIR.
 * `--source all` (the default) ingests every source it has an input for and says
 * on stderr which it skipped for lack of one.
 *
 * The two adapter sources are EXTERNAL content and pass SMD-1813's allowlist:
 * every item names a scope (the corpus, a vault root) and only a scope named
 * by `--allow <a,b>` / OB1_INGEST_ALLOW is ingested — default nothing, the
 * refusal counted and said. The fork's own records (fork, commit, memory) are
 * not external and are not gated.
 *
 *   bun db/ingest-records.ts --url … --dry-run             # count per source, write nothing
 *   bun db/ingest-records.ts --url … --source fork         # one source
 *   bun db/ingest-records.ts --url … --linear /tmp/linear-corpus-full.json --allow linear:corpus
 *   bun db/ingest-records.ts --url … --markdown ~/vault --allow ~/vault
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
 * facets and 050's actor marks survive a rebuild — SMD-1958); a record whose
 * text moved has its vector and chunks cleared so `reembed.ts` pools it; and a
 * record that came through an adapter also writes its canonical
 * (thought_sources), its links (051's `link` facets, as a set) and its
 * structured mentions (record_thought_entities under `source:<system>`), all in
 * the record's own transaction.
 */

import { SQL } from "bun";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { PIPELINE_TIERS } from "./config.mjs";
import { loadLinearCorpus, linearThoughtId, linearThoughtText, type LinearDoc } from "../evals/linear-corpus.ts";
import { parseFragment, fragmentSection } from "../scripts/fragments.ts";
import { headingOf, ticketsOf } from "../scripts/fork-index.ts";
import { AdapterRefusal, allowlistFrom, normaliseLinks, normaliseMentions, scopeRefusal, stableJson, type Allowlist, type Identity, type Ingested } from "./ingest-contract.ts";
import { autolinkTargets, LINEAR_SYSTEM, stripAutolinks } from "./ingest-linear.ts";
import { markdownAdapter, markdownFiles, MARKDOWN_SYSTEM } from "./ingest-markdown.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const SOURCES = ["fork", "commit", "linear", "memory", "markdown"] as const;
export type Source = (typeof SOURCES)[number];
/** The sources that are external content, gated by the allowlist; the rest are the fork's own records. */
export const GATED_SOURCES: readonly Source[] = ["linear", "markdown"];
/** The pipeline tiers, from the one source db/config.mjs owns (SMD-1953) — migration 045's CHECK and preflight/initEnv validate against the same list. */
export const TIERS = PIPELINE_TIERS;
export type Tier = (typeof TIERS)[number];

/** What a record that came through an adapter carries beside its row: the canonical, the links and the structured mentions (SMD-1867). */
export type Structure = Pick<Ingested, "identity" | "canonical" | "links" | "mentions">;

/** One record as a thought row: its id, its content, its source label and the metadata that goes under it. */
export type Doc = {
  id: string;
  content: string;
  source: Source;
  meta: Record<string, unknown>;
  /** When the record came to be (a ticket opened, a commit authored); left to now() when a source has none. */
  createdAt?: string;
  /** Present for a record an adapter mapped: written beside the row, in its transaction. */
  structure?: Structure;
  /** The allowlist's unit, for a gated source. */
  scope?: string;
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
  const source = system as Source;
  return {
    id: recordId(source, key),
    content: ingested.text,
    source,
    meta: { ...ingested.facets },
    createdAt: ingested.createdAt,
    structure: { identity: ingested.identity, canonical: ingested.canonical, links: ingested.links, mentions: ingested.mentions },
    scope: ingested.scope,
  };
}

/** The scope a corpus dump's records carry: the dump is one deliberate export, cleared as one. */
export const LINEAR_CORPUS_SCOPE = "linear:corpus";
export const LINEAR_CORPUS_MEDIA_TYPE = "application/vnd.ob1.linear-corpus+json";

/**
 * One corpus record (evals/build-linear-corpus.ts) through the contract. The
 * text keeps the eval's shape — `title\n\ntext` (eval-real.ts uses the title as
 * the query and the text as the document) — with Linear's autolink markup
 * stripped (SMD-1865); the cross-references it named become `references`
 * links, the labels topic mentions, the record itself the canonical. The dump
 * carries no state, project or relations (SMD-1958 extends it), so those
 * links and facets arrive from the board sync alone until it does.
 */
export function corpusIngested(d: LinearDoc): Ingested {
  const raw = linearThoughtText(d);
  return {
    identity: { system: LINEAR_SYSTEM, key: d.id },
    scope: LINEAR_CORPUS_SCOPE,
    canonical: { form: stableJson(d), mediaType: LINEAR_CORPUS_MEDIA_TYPE },
    text: stripAutolinks(raw),
    links: normaliseLinks(autolinkTargets(raw).map((target) => ({ relation: "references" as const, target })), d.id).links,
    mentions: normaliseMentions((d.labels ?? []).map((name) => ({ name, type: "topic" as const }))),
    facets: { issue: d.id },
    createdAt: d.createdAt,
  };
}

/** A Linear corpus dump as Docs, on the shared linear id space, through the adapter. */
export function linearDocs(path: string): Doc[] {
  return loadLinearCorpus(path).docs.map((d: LinearDoc) => docOf(corpusIngested(d)));
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
  // name, and the fix is a frontmatter id.
  const holders = new Map<string, string>();
  for (const f of markdownFiles(scope)) {
    try {
      const doc = docOf(markdownAdapter.map({ ...f, root: scope }));
      const key = doc.structure!.identity.key;
      const holder = holders.get(key);
      if (holder !== undefined) { refused.push({ path: f.path, reason: `identity "${key}" is already ${holder}'s — two notes of one name; give one a frontmatter id` }); continue; }
      holders.set(key, f.path);
      docs.push(doc);
    } catch (e) {
      if (!(e instanceof AdapterRefusal)) throw e;
      refused.push({ path: f.path, reason: e.message });
    }
  }
  return { docs, refused };
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

/** inserted: a new row. updated: the text moved (vector and chunks cleared). patched: the text stood and metadata moved. unchanged: nothing to write. skipped: another record already holds this text. held: another thought already IS this source item (thought_sources), nothing written. */
export type UpsertResult = "inserted" | "updated" | "patched" | "unchanged" | "skipped" | "held";

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

/** A run's name for thought_sources.ingest_run — the tool and the moment it started. */
export function runName(tool: string = INGEST_ACTOR.via, at: Date = new Date()): string {
  return `${tool}@${at.toISOString()}`;
}

/** What one record's write said: the row's outcome, and the structure's counts when the record carried one. */
export type RecordResult = {
  outcome: UpsertResult;
  structure?: { canonical: string; links: { added: number; closed: number; kept: number; dropped: number }; mentions: number };
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
 */
export async function upsertRecord(sql: SQL, doc: Doc, run: string = runName()): Promise<RecordResult> {
  const meta = { ...doc.meta, source: doc.source };
  for (const k of ACTOR_KEYS) delete (meta as Record<string, unknown>)[k];
  const created = doc.createdAt ?? null;
  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT set_config('ob1.actor', ${JSON.stringify(INGEST_ACTOR)}, true)`;
      // `old` is read before the write so RETURNING can say whether the text
      // moved — an UPDATE's RETURNING sees only the new row. The two actor
      // keys are removed from EXCLUDED on both sides: 050's BEFORE INSERT
      // trigger stamps them onto the proposed row, and a kind the operator
      // classified since the last run would otherwise re-write every row once.
      const rows = (await tx`
        WITH old AS (SELECT content_fingerprint AS fp FROM thoughts WHERE id = ${doc.id}::uuid)
        INSERT INTO thoughts (id, content, metadata, content_fingerprint, created_at)
        VALUES (${doc.id}::uuid, ${doc.content}, ${meta}::jsonb, content_fingerprint_of(${doc.content}), COALESCE(${created}::timestamptz, now()))
        ON CONFLICT (id) DO UPDATE
          SET content = CASE WHEN thoughts.content_fingerprint IS DISTINCT FROM EXCLUDED.content_fingerprint THEN EXCLUDED.content ELSE thoughts.content END,
              content_fingerprint = CASE WHEN thoughts.content_fingerprint IS DISTINCT FROM EXCLUDED.content_fingerprint THEN EXCLUDED.content_fingerprint ELSE thoughts.content_fingerprint END,
              embedding = CASE WHEN thoughts.content_fingerprint IS DISTINCT FROM EXCLUDED.content_fingerprint THEN NULL ELSE thoughts.embedding END,
              embedding_model = CASE WHEN thoughts.content_fingerprint IS DISTINCT FROM EXCLUDED.content_fingerprint THEN NULL ELSE thoughts.embedding_model END,
              metadata = COALESCE(thoughts.metadata, '{}'::jsonb) || (EXCLUDED.metadata - 'actor_kind' - 'actor_name')
          WHERE thoughts.content_fingerprint IS DISTINCT FROM EXCLUDED.content_fingerprint
             OR (COALESCE(thoughts.metadata, '{}'::jsonb) || (EXCLUDED.metadata - 'actor_kind' - 'actor_name')) IS DISTINCT FROM thoughts.metadata
        RETURNING (xmax = 0) AS inserted, ((SELECT fp FROM old) IS DISTINCT FROM thoughts.content_fingerprint) AS moved`) as { inserted: boolean; moved: boolean }[];
      // The guard asks "would the merge change the row" — the merged value
      // against the stored one — not containment: `@>` holds when an array
      // facet SHRANK (a label removed: ["a","b"] contains ["a"]), and the row
      // would have kept the stale list for good (first review pass).
      let outcome: UpsertResult = "unchanged";
      if (rows.length) outcome = rows[0].inserted ? "inserted" : rows[0].moved ? "updated" : "patched";
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

/** record_thought_source refused: another thought holds the (system, identity). */
export class IdentityHeld extends Error {
  constructor(public readonly identity: Identity, public readonly thoughtId: string, public readonly heldBy: string) {
    super(`${identity.system} ${identity.key} is held by thought ${heldBy}; not written on ${thoughtId}`);
    this.name = "IdentityHeld";
  }
}

/**
 * The structure beside a row, as 051 records it: the canonical
 * (record_thought_source — unchanged when it stands), the links as a set
 * (record_source_links — the same set twice writes nothing, a link the source
 * no longer states is closed) and the structured mentions
 * (record_thought_entities under `source:<system>`, confidence 1, replacing
 * only that key's rows — the resolution rule). Runs on the caller's
 * connection or transaction; db/sync-linear.ts calls it on the head row it
 * has just written, with `take`: a ticket's head row moves when an older
 * paste becomes the chain's head, and the identity follows it. Without
 * `take`, an identity another thought holds is thrown as IdentityHeld: two
 * thoughts claiming one source item is the caller's to resolve.
 */
export async function recordStructure(sql: SQL, thoughtId: string, s: Structure, run: string = runName(), opts: { take?: boolean } = {}): Promise<NonNullable<RecordResult["structure"]>> {
  const [src] = (await sql`SELECT record_thought_source(${thoughtId}::uuid, ${s.identity.system}, ${s.identity.key}, ${s.canonical.form}, ${s.canonical.mediaType}, ${run}, ${opts.take === true}) AS r`) as { r: { ok: boolean; outcome?: string; error?: string; held_by?: string } }[];
  if (!src.r.ok && src.r.error === "IDENTITY_HELD" && src.r.held_by) throw new IdentityHeld(s.identity, thoughtId, src.r.held_by);
  if (!src.r.ok) throw new Error(`record_thought_source(${s.identity.system} ${s.identity.key}) on ${thoughtId}: ${src.r.error}`);
  // The JSON goes over as TEXT and is cast in SQL: a JS string bound straight
  // to a `::jsonb` parameter is serialised as a JSON string — the function saw
  // `"[…]"`, a string, not an array (test-live, first review pass; db/README.md
  // "The double-encoding trap"). A JS array bound directly would be a Postgres
  // array literal, not JSON.
  const [lnk] = (await sql`SELECT record_source_links(${thoughtId}::uuid, ${s.identity.system}, ${JSON.stringify(s.links)}::text::jsonb) AS r`) as { r: { ok: boolean; added: number; closed: number; kept: number; dropped: number; error?: string } }[];
  if (!lnk.r.ok) throw new Error(`record_source_links on ${thoughtId}: ${lnk.r.error}`);
  const entities = s.mentions.map((m) => ({ name: m.name, type: m.type, confidence: 1 }));
  const [ent] = (await sql`SELECT record_thought_entities(${thoughtId}::uuid, ${`source:${s.identity.system}`}, ${JSON.stringify(entities)}::text::jsonb, '[]'::jsonb, NULL, NULL) AS r`) as { r: { ok: boolean; mentions?: number; error?: string } }[];
  if (!ent.r.ok) throw new Error(`record_thought_entities(source:${s.identity.system}) on ${thoughtId}: ${ent.r.error}`);
  return { canonical: src.r.outcome ?? "unchanged", links: { added: lnk.r.added, closed: lnk.r.closed, kept: lnk.r.kept, dropped: lnk.r.dropped }, mentions: ent.r.mentions ?? 0 };
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

  const { docs: deduped, dropped } = dedupeByContent([
    { id: "a", content: "same", source: "fork", meta: {} },
    { id: "b", content: "same", source: "commit", meta: {} },
    { id: "c", content: "other", source: "fork", meta: {} },
  ]);
  ok(deduped.length === 2 && dropped === 1, "identical content across records is de-duped, first kept");

  // The contract's pipeline (SMD-1867): a corpus record through the Linear
  // adapter — the eval's text shape kept, the markup gone, the structure out.
  const corpus = corpusIngested({ id: "SMD-10", title: "A title", text: "Body naming <issue id=\"a\" href=\"h\">SMD-11</issue> and <issue id=\"b\" href=\"h\">SMD-10</issue>.", labels: ["Bug", "infra"], createdAt: "2026-09-01T00:00:00.000Z" });
  ok(corpus.text === "A title\n\nBody naming SMD-11 and SMD-10.", `the corpus text keeps title + blank + text with autolinks stripped (${JSON.stringify(corpus.text)})`);
  ok(JSON.stringify(corpus.links) === '[{"relation":"references","target":"SMD-11"}]', "a cross-reference is a references link; the record's own identifier is not");
  ok(corpus.mentions.map((m) => `${m.type}:${m.name}`).join(",") === "topic:Bug,topic:infra" && corpus.scope === LINEAR_CORPUS_SCOPE, "labels are topic mentions; the scope is the corpus");
  ok(/<issue id=/.test(corpus.canonical.form), "the canonical keeps the record as dumped, markup included");
  const doc = docOf(corpus);
  ok(doc.id === linearThoughtId("SMD-10") && doc.source === "linear" && doc.meta.issue === "SMD-10" && doc.content === corpus.text && doc.structure?.identity.key === "SMD-10" && doc.scope === LINEAR_CORPUS_SCOPE, "docOf: the eval's id space, the source, the facets, the structure carried");
  ok(docOf({ ...corpus, identity: { system: "markdown", key: "Note" } }).id === recordId("markdown", "Note"), "…and a markdown record lands on its own source-qualified id");

  // The allowlist (SMD-1813): gated sources refuse by scope, one line per scope; the fork's own records pass.
  const gated = applyAllowlist([doc, { ...doc, id: "x" }, { id: "f", content: "c", source: "fork", meta: {} }], allowlistFrom(""));
  ok(gated.docs.length === 1 && gated.docs[0].source === "fork" && gated.refused.length === 2 && gated.reasons.length === 1 && /^linear: scope "linear:corpus" is not on the allowlist/.test(gated.reasons[0]) && /--allow "linear:corpus"/.test(gated.reasons[0]), `an empty allowlist refuses every gated record, says so once per scope, names the knob (${gated.reasons[0]})`);
  ok(applyAllowlist([doc], allowlistFrom(" linear:corpus , other ")).docs.length === 1, "a cleared scope passes (list trimmed)");
  ok(applyAllowlist([doc], allowlistFrom("linear")).docs.length === 0, "a prefix is not a clearance — exact scope only");
  ok(applyAllowlist([{ ...doc, source: "future" as Source }], allowlistFrom("")).docs.length === 0, "a record an adapter mapped is gated whatever its source label — the structure is the tell, not a list of names");
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
    const TAKES_ONE = new Set(["url", "source", "linear", "memory-dir", "markdown", "allow", "tier", "since"]);
    const TAKES_NONE = new Set(["dry-run", "self-check"]);
    const USAGE = "  flags: --url <postgres://…>, --source <all|fork|commit|linear|memory|markdown>, --linear <dump.json>, --memory-dir <path>, --markdown <vault root>, --allow <scope,scope> (or OB1_INGEST_ALLOW), --tier <stable|canary|working>, --since <ref>, --dry-run, --self-check";
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
  const markdownDir = flag("markdown") ?? process.env.OB1_MARKDOWN_DIR;
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
    else { const docs = linearDocs(linearPath); perSource.linear = docs.length; collected.push(...docs); }
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

  // The allowlist before the dedupe, so a refused record never claims a text
  // a cleared one carries; the refusals are counted per source and said once
  // per scope, with the knob that clears it.
  const gate = applyAllowlist(collected, allow);
  for (const line of gate.reasons) console.error(`  ${line}`);
  const refusedPerSource: Record<string, number> = {};
  for (const d of gate.refused) refusedPerSource[d.source] = (refusedPerSource[d.source] ?? 0) + 1;

  const { docs, dropped } = dedupeByContent(gate.docs);
  const printCounts = () => {
    for (const s of SOURCES) {
      if (perSource[s] === undefined) continue;
      const refused = refusedPerSource[s] ?? 0;
      console.log(`  ${s}: ${perSource[s]} record(s)${refused ? ` — ${refused} REFUSED by the allowlist (${basename(s === "markdown" ? resolve(markdownDir!) : LINEAR_CORPUS_SCOPE)} not cleared)` : ""}`);
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
  const tally: Record<UpsertResult, number> = { inserted: 0, updated: 0, patched: 0, unchanged: 0, skipped: 0, held: 0 };
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
  console.log(`  tier=${tier}  inserted ${tally.inserted}  updated ${tally.updated}  patched ${tally.patched}  unchanged ${tally.unchanged}  skipped ${tally.skipped}  held ${tally.held}${dropped ? `  (+${dropped} duplicate-content dropped)` : ""}`);
  for (const [source, n] of heldBy) console.log(`  ${source}: ${n} record(s) HELD — another thought already is that source item (the board sync's row for a ticket, on a brain it keeps); nothing written for them. db/README.md, "Two writers of one identity".`);
  if (structure.records) {
    console.log(`  structure (${structure.records} record(s), run ${run}): canonical inserted ${structure.canonical.inserted ?? 0} updated ${structure.canonical.updated ?? 0} unchanged ${structure.canonical.unchanged ?? 0}; links added ${structure.links.added} closed ${structure.links.closed} kept ${structure.links.kept} dropped ${structure.links.dropped}; structured mentions ${structure.mentions}`);
  }
  console.log(`  next: bun db/reembed.ts --url … — embed the new rows (vectors + chunks) through the claim path.`);
}

if (import.meta.main) await main();
