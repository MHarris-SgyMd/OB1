#!/usr/bin/env bun
/**
 * weekly-digest.ts — the week's thoughts, ranked and synthesized into a digest,
 * delivered to Telegram, a file, or stdout — with every hop that leaves the box
 * decided by the egress gate. SMD-2239.
 *
 * This is the `db/` home for what `recipes/weekly-digest/weekly-digest.mjs` did
 * over PostgREST. That recipe was the fork's one true SINK: it paged the week's
 * rows and posted their synthesized text to a third party with no egress
 * handling at all — no OB1_EGRESS_*, no local declaration, no allowlist. Ported
 * onto a shim it would have read the table directly, below the server's egress
 * gate (SMD-1903), and sent whatever it paged. Here it reads through db/connect,
 * resolves an actor through db/worker-bootstrap, and passes BOTH content-leaving
 * hops through the gate:
 *
 *   1. the LLM synthesis — the thoughts leave to the chat provider — through the
 *      gated dialler providerCall (server-portable/embed.ts); and
 *   2. the Telegram send — the digest leaves to api.telegram.org — through
 *      mayLeaveBox against a synthetic endpoint.
 *
 * The gate names content UNITS, not hosts (server-portable/egress.ts): a digest
 * carries no single source/type/topic, so it declares its own —
 * metadata.type = "digest", metadata.source = "weekly-digest" — and the worker
 * key's name is the actor. An operator opts the sink in with one term:
 *
 *   OB1_EGRESS_ALLOW=type:digest        # (or source:weekly-digest, or actor:<key>)
 *
 * Under the default deny with no such term the send is refused, the refusal
 * names the rule, and the digest is printed to stdout instead — nothing reaches
 * Telegram. --output=stdout|file never leaves the box (the synthesis still does).
 *
 *   bun db/weekly-digest.ts --url postgres://…                  # 7-day window → Telegram
 *   bun db/weekly-digest.ts --url … --output stdout            # print only (no delivery hop)
 *   bun db/weekly-digest.ts --url … --output file              # write ./digests/YYYY-MM-DD.md
 *   bun db/weekly-digest.ts --url … --window 14                # last 14 days
 *   bun db/weekly-digest.ts --url … --min-importance 3         # lower the threshold
 *   bun db/weekly-digest.ts --url … --include-personal         # include sensitivity_tier=personal
 *   bun db/weekly-digest.ts --url … --no-sensitivity-filter    # ⚠ send every row (see below)
 *   bun db/weekly-digest.ts --url … --model <id>               # else OB1_DIGEST_MODEL, else the brain's chat model
 *   bun db/weekly-digest.ts --url … --dry-run                  # synthesize + print, deliver nothing
 *
 * The model, chat endpoint, timeout and egress policy come from the same
 * variables the server reads (OB1_CHAT_BASE_URL / OB1_LLM_BASE_URL, OB1_*_LOCAL,
 * OB1_EGRESS_*, OB1_LLM_TIMEOUT, OB1_METADATA_MODEL), resolved by the server's
 * own resolveEmbedConfig. Telegram credentials are TELEGRAM_BOT_TOKEN and
 * TELEGRAM_CHAT_ID; OB1_TELEGRAM_API_BASE overrides the api.telegram.org host
 * (a self-hosted Bot API server, or a proxy), and OB1_TELEGRAM_LOCAL declares
 * that host on the box so the gate does not apply to it.
 *
 * ── Sensitivity, fail-closed ────────────────────────────────────────────────
 * `sensitivity_tier` is an optional TEXT column. Rows tagged `restricted`
 * (always) and `personal` (unless --include-personal) are excluded; NULL and
 * every other tier are kept. If the column is ABSENT the run REFUSES rather than
 * page every row unfiltered — the privacy boundary the recipe promised —
 * unless --no-sensitivity-filter says, in as many words, to send everything.
 */

import { commandLine } from "./cli.ts";
import { databaseUrl, openSql, closeThenExit } from "./connect.ts";
import { providerCall, resolveEmbedConfig, baseUrlOr, type EmbedConfig, type EmbedEnv, type ProviderEndpoint } from "../server-portable/embed.ts";
import { mayLeaveBox, flagOn, type EgressSubject, type EgressUnit } from "../server-portable/egress.ts";
import { egressDescription, egressRefusal, workerIdentity, classifyError, TRANSIENT_PAUSES_MS } from "./worker-bootstrap.ts";
import fs from "node:fs";
import path from "node:path";
import type { SQL } from "bun";

// ── Config ──────────────────────────────────────────────────────────────────

// How many ranked thoughts are serialized into the synthesis prompt. The pool
// is ranked above this cap, then trimmed. Bigger = more context, more tokens.
const SYNTHESIZE_INPUT_CAP = 80;

// Hard ceiling on rows read per run — protects a huge window + heavy capture
// volume from blowing past what one synthesis call can reasonably hold.
const FETCH_HARD_CAP = 400;

// Telegram text messages cap at 4096 chars; split below this.
const TELEGRAM_CHUNK_LIMIT = 3800;

const DEFAULT_TELEGRAM_BASE = "https://api.telegram.org";

/**
 * The endpoint the digest's Telegram send is gated against and dialled. Its base
 * is OB1_TELEGRAM_API_BASE (default api.telegram.org — a third party, so never
 * local unless OB1_TELEGRAM_LOCAL declares a self-hosted Bot API server on the
 * box). The gate reflects the CONFIGURED destination, exactly as it does for the
 * chat endpoint.
 */
export const OB1_TELEGRAM_LOCAL = "OB1_TELEGRAM_LOCAL";

export function telegramEndpoint(env: Record<string, string | undefined>): ProviderEndpoint {
  return {
    base: baseUrlOr(env.OB1_TELEGRAM_API_BASE, DEFAULT_TELEGRAM_BASE),
    key: undefined,
    headers: {},
    local: flagOn(env.OB1_TELEGRAM_LOCAL),
    // declaredBy is resolveProviderEndpoints' bookkeeping (a closed LocalKnob set
    // this synthetic endpoint is not part of); the banner names the knob itself.
    declaredBy: undefined,
  };
}

const SYSTEM_PROMPT =
  "You write tight weekly digests for a personal second brain. " +
  "Output plain text formatted for a Telegram chat (NOT markdown). " +
  "Use section headers with emoji, short bullets. Max 1500 characters total. " +
  "Sections: Wins, Key decisions, Open loops, Themes. " +
  "Be specific — name projects and tasks. Skip filler.";

// ── Types ─────────────────────────────────────────────────────────────────

export type DigestThought = {
  id: string;
  content: string;
  created_at: string | Date;
  metadata: Record<string, unknown> | null;
  /** Present only when the install has a native `importance` column. */
  importance?: number | string | null;
};

type ChatCompletion = { choices?: Array<{ message?: { content?: string } }> };

// ── Ranking (pure) ────────────────────────────────────────────────────────

/**
 * The importance score: a native top-level `importance` when the install has
 * one, else `metadata.importance`, else 0. A numeric string in either place is
 * accepted (some capture pipelines stringify the field).
 */
export function thoughtImportance(t: DigestThought): number {
  const read = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return null;
  };
  return read(t.importance) ?? read(t.metadata?.importance) ?? 0;
}

/**
 * Rank the pool by importance, then recency. When too few clear the threshold
 * the digest would come out thin, so the pool widens to the top 60 by
 * importance+recency; either way the result is capped at 200.
 */
export function rankAndTrim(thoughts: DigestThought[], minImportance: number): { pool: DigestThought[]; widened: boolean } {
  const sorted = [...thoughts].sort((a, b) => {
    const d = thoughtImportance(b) - thoughtImportance(a);
    return d !== 0 ? d : String(b.created_at).localeCompare(String(a.created_at));
  });
  const high = sorted.filter((t) => thoughtImportance(t) >= minImportance);
  const widened = high.length < 10;
  const pool = widened ? sorted.slice(0, 60) : high;
  return { pool: pool.slice(0, 200), widened };
}

// ── The digest's egress subject (pure) ──────────────────────────────────────

/** The units the digest carries — for the up-front wholesale refusal. */
export function digestUnits(keyName: string | undefined): EgressUnit[] {
  return keyName ? ["actor", "source", "type", "marker"] : ["source", "type", "marker"];
}

/**
 * The gate's subject for a digest hop: its own source/type (a digest belongs to
 * no single row's), the worker key as the actor, and the text as the marker.
 */
export function digestSubject(content: string, keyName: string | undefined): EgressSubject {
  return {
    kind: "digest",
    ...(keyName ? { actor: keyName } : {}),
    metadata: { type: "digest", source: "weekly-digest" },
    content,
  };
}

// ── The synthesis prompt (pure) ─────────────────────────────────────────────

export function buildUserPrompt(thoughts: DigestThought[], startDate: Date, endDate: Date): string {
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const rows = thoughts.slice(0, SYNTHESIZE_INPUT_CAP).map((t) => ({
    id: t.id,
    date: String(t.created_at instanceof Date ? t.created_at.toISOString() : t.created_at).slice(0, 10),
    type: t.metadata?.type ?? null,
    importance: thoughtImportance(t) || null,
    content: String(t.content ?? "").slice(0, 280),
    topics: (Array.isArray(t.metadata?.topics) ? (t.metadata!.topics as unknown[]) : []).slice(0, 5),
    tags: (Array.isArray(t.metadata?.tags) ? (t.metadata!.tags as unknown[]) : []).slice(0, 5),
  }));
  return (
    `Weekly digest for ${fmt(startDate)} – ${fmt(endDate)}.\n` +
    `Source: ${rows.length} high-signal thoughts.\n\n` +
    `INPUT:\n${JSON.stringify(rows)}\n\n` +
    `Produce the digest now.`
  );
}

// ── Telegram chunking (pure) ────────────────────────────────────────────────

/**
 * Split a digest that exceeds Telegram's message cap, preferring a paragraph
 * break, then a newline, then a word boundary, then — last resort — a hard cut.
 */
export function chunkForTelegram(text: string, limit = TELEGRAM_CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.5) cut = remaining.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = remaining.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

// ── Read (raw SQL; sensitivity fail-closed) ─────────────────────────────────

const FAIL_CLOSED =
  "\n  public.thoughts has no sensitivity_tier column, so restricted/personal rows cannot be excluded.\n" +
  "  Refusing to read the corpus unfiltered — every row (including anything you would tag restricted or\n" +
  "  personal) would be synthesized and could leave the box. Add a sensitivity-tiers migration, or pass\n" +
  "  --no-sensitivity-filter to accept sending ALL rows in the window.";

/**
 * The week's rows, ordered newest first and capped. `restricted` (always) and
 * `personal` (unless includePersonal) are excluded when the column exists;
 * `importance` is selected only when the column exists (else read from
 * metadata). Returns the rows, or `{ failClosed: true }` when the sensitivity
 * column is missing and the filter was not waived.
 */
export async function readThoughts(
  sql: SQL,
  opts: { windowDays: number; includePersonal: boolean; noSensitivityFilter: boolean },
): Promise<{ failClosed: true } | { failClosed: false; rows: DigestThought[] }> {
  const [cols] = await sql`
    SELECT
      EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'thoughts' AND column_name = 'sensitivity_tier') AS has_sensitivity,
      EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'thoughts' AND column_name = 'importance') AS has_importance`;
  const hasSensitivity = Boolean(cols.has_sensitivity);
  const hasImportance = Boolean(cols.has_importance);
  const filter = !opts.noSensitivityFilter;

  if (filter && !hasSensitivity) return { failClosed: true };

  // Column names are fixed strings gated by the existence probe above — never
  // caller input — so building the select list is safe. Values go as $-params.
  const selectCols = ["id", "content", "created_at", "metadata"];
  if (hasImportance) selectCols.push("importance");
  if (filter && hasSensitivity) selectCols.push("sensitivity_tier");

  const params: unknown[] = [opts.windowDays];
  let where = "created_at >= now() - make_interval(days => $1::int)";
  if (filter && hasSensitivity) {
    const excluded = opts.includePersonal ? ["restricted"] : ["restricted", "personal"];
    where += " AND (sensitivity_tier IS NULL OR sensitivity_tier <> ALL($2))";
    params.push(sql.array(excluded, "TEXT"));
  }

  const rows = (await sql.unsafe(
    `SELECT ${selectCols.join(", ")} FROM thoughts WHERE ${where} ORDER BY created_at DESC LIMIT ${FETCH_HARD_CAP}`,
    params,
  )) as DigestThought[];
  return { failClosed: false, rows };
}

// ── Synthesis (gated) + delivery ────────────────────────────────────────────

/** Retry a provider hop while its failure is transient (429/5xx/connection). */
async function withProviderRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (classifyError(e) === "transient" && attempt < TRANSIENT_PAUSES_MS.length) {
        const pause = TRANSIENT_PAUSES_MS[attempt];
        console.error(`  ${label}: transient failure (${(e as Error).message}); retrying in ${pause / 1000}s`);
        await Bun.sleep(pause);
        continue;
      }
      throw e;
    }
  }
}

async function synthesize(cfg: EmbedConfig, model: string, userPrompt: string, keyName: string | undefined): Promise<string> {
  const subject = digestSubject(userPrompt, keyName);
  const body = {
    model,
    max_tokens: 1024,
    temperature: cfg.metadataTemperature,
    ...cfg.metadataReasoning,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  };
  const d = await withProviderRetry("synthesis", () => providerCall<ChatCompletion>(cfg, "/chat/completions", body, subject));
  const text = d.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) throw new Error("the model returned an empty digest");
  return text;
}

async function deliverTelegram(base: string, token: string, chatId: string, text: string): Promise<number[]> {
  const url = `${base}/bot${token}/sendMessage`;
  const ids: number[] = [];
  for (const chunk of chunkForTelegram(text)) {
    const res = await withProviderRetry("telegram", async () => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true }),
      });
      if (!r.ok) {
        const err = new Error(`Telegram sendMessage failed: ${r.status} ${await r.text()}`) as Error & { status?: number };
        err.status = r.status;
        throw err;
      }
      return r.json() as Promise<{ result?: { message_id?: number } }>;
    });
    if (res.result?.message_id) ids.push(res.result.message_id);
  }
  return ids;
}

function deliverFile(text: string, startDate: Date, endDate: Date, model: string, counts: { used: number; poolSize: number }): string {
  const dir = path.resolve(process.cwd(), "digests");
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, `${endDate.toISOString().slice(0, 10)}.md`);
  const frontmatter = [
    "---",
    `title: Weekly Digest ${endDate.toISOString().slice(0, 10)}`,
    "type: weekly-digest",
    `period_start: ${startDate.toISOString().slice(0, 10)}`,
    `period_end: ${endDate.toISOString().slice(0, 10)}`,
    `generated_at: ${new Date().toISOString()}`,
    `generated_by_model: ${model}`,
    `source_thought_count_used: ${counts.used}`,
    `source_pool_size: ${counts.poolSize}`,
    "tags: [weekly-digest, synthesis]",
    "---",
    "",
  ].join("\n");
  fs.writeFileSync(filepath, frontmatter + text + "\n", "utf8");
  return filepath;
}

// ── Run ─────────────────────────────────────────────────────────────────────

type RunArgs = {
  windowDays: number;
  minImportance: number;
  model: string | undefined;
  output: "telegram" | "stdout" | "file";
  includePersonal: boolean;
  noSensitivityFilter: boolean;
  dryRun: boolean;
};

async function run(sql: SQL, url: string, args: RunArgs): Promise<number> {
  const cfg = resolveEmbedConfig(process.env as unknown as EmbedEnv);
  const model = (args.model ?? process.env.OB1_DIGEST_MODEL ?? "").trim() || cfg.metadataModel;

  const id = await workerIdentity(url, process.env, {
    noKeyWarning: "  note: OB1_WORKER_KEY is not set — the digest runs without an actor; grant it by type:digest or source:weekly-digest, not actor:<key>.",
  });
  if (!id.ok) {
    console.error(id.message);
    return 2;
  }
  const keyName = id.identity.keyName;

  console.log(
    `weekly-digest: window=${args.windowDays}d min-importance=${args.minImportance} model=${model} ` +
      `output=${args.output} include-personal=${args.includePersonal}`,
  );
  console.log(`  synthesis egress: ${egressDescription(cfg.chat, cfg.egress, cfg.chat.declaredBy ?? "OB1_LLM_LOCAL")}`);
  const telegram = telegramEndpoint(process.env);
  const wantTelegram = args.output === "telegram" && !args.dryRun;
  // The blanket gate, up front, before the read and the LLM spend: when the
  // policy would refuse the digest whatever its text (no allow term names a unit
  // it carries), say so now — the digest still prints to stdout, but will not
  // post. A null defers to the per-send gate at delivery; when it will post, the
  // credentials are required now, not after a synthesis that is then wasted.
  let telegramBlanket: string | null = null;
  if (wantTelegram) {
    console.log(`  Telegram egress: ${egressDescription(telegram, cfg.egress, OB1_TELEGRAM_LOCAL)}`);
    telegramBlanket = egressRefusal(telegram, cfg.egress, digestUnits(keyName));
    if (telegramBlanket) {
      console.error(`  the digest will not be posted to Telegram: ${telegramBlanket}. Name it in OB1_EGRESS_ALLOW (type:digest, source:weekly-digest${keyName ? `, or actor:${keyName}` : ""}), or set OB1_EGRESS_POLICY — it is printed to stdout below instead.`);
    } else if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
      console.error("  --output telegram needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (or use --output stdout|file, or --dry-run).");
      return 2;
    }
  }

  const read = await readThoughts(sql, args);
  if (read.failClosed) {
    console.error(FAIL_CLOSED);
    return 1;
  }
  if (args.noSensitivityFilter) {
    console.error(
      "  ⚠  --no-sensitivity-filter: every row in the window (including any restricted/personal) will be synthesized and may leave the box.",
    );
  }
  console.log(`  read ${read.rows.length} thought(s) in the window`);
  if (read.rows.length === 0) {
    console.log("  nothing in the window; no digest");
    return 0;
  }

  const { pool, widened } = rankAndTrim(read.rows, args.minImportance);
  if (widened) {
    console.error(
      `  note: fewer than 10 thoughts at or above --min-importance=${args.minImportance}; widened to the top 60 by importance+recency (stock installs score importance in metadata.importance — pass --min-importance 0 if none is scored).`,
    );
  }
  console.log(`  ranked pool: ${pool.length} thought(s)`);

  const endDate = new Date();
  const startDate = new Date(Date.now() - args.windowDays * 86_400_000);
  const userPrompt = buildUserPrompt(pool, startDate, endDate);

  let digest: string;
  try {
    digest = await synthesize(cfg, model, userPrompt, keyName);
  } catch (e) {
    const kind = classifyError(e);
    console.error(`  synthesis ${kind === "transient" ? "failed (transient, gave up)" : "failed"}: ${(e as Error).message}`);
    if ((e as { kind?: string }).kind === "egress") {
      console.error(`  the thoughts were not sent. Declare the chat endpoint local (OB1_LLM_LOCAL=1), or allow it in OB1_EGRESS_POLICY, to synthesize the digest.`);
    }
    return 1;
  }
  console.log(`  synthesized ${digest.length} chars`);
  console.log("───── DIGEST ─────");
  console.log(digest);
  console.log("───── END ─────");

  if (args.dryRun) {
    console.log("  --dry-run: nothing delivered");
    return 0;
  }
  if (args.output === "stdout") return 0;
  if (args.output === "file") {
    const used = Math.min(pool.length, SYNTHESIZE_INPUT_CAP);
    console.log(`  wrote ${deliverFile(digest, startDate, endDate, model, { used, poolSize: pool.length })}`);
    return 0;
  }

  // Telegram — the sink hop. The blanket gate already refused it up front (the
  // digest is on stdout); nothing reaches Telegram.
  if (telegramBlanket) return 0;
  // The per-send gate decides on the digest's own text — the backstop for a
  // marker: term the blanket (units only) could not judge.
  const gate = mayLeaveBox(digestSubject(digest, keyName), telegram, cfg.egress);
  if (!gate.allowed) {
    console.error(`  not posted to Telegram: ${gate.reason}`);
    console.error(
      `  name the digest in OB1_EGRESS_ALLOW (type:digest, source:weekly-digest${keyName ? `, or actor:${keyName}` : ""}), or set OB1_EGRESS_POLICY. The digest is printed above.`,
    );
    return 0;
  }
  // Credentials were required up front when the send was not blanket-refused.
  const token = process.env.TELEGRAM_BOT_TOKEN!;
  const chatId = process.env.TELEGRAM_CHAT_ID!;
  try {
    const ids = await deliverTelegram(telegram.base, token, chatId, digest);
    console.log(`  posted to Telegram (${ids.length} message${ids.length === 1 ? "" : "s"})`);
  } catch (e) {
    console.error(`  Telegram delivery failed: ${(e as Error).message}`);
    return 1;
  }
  return 0;
}

// ── CLI ───────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const cli = commandLine(
    "weekly-digest.ts",
    {
      url: "one",
      window: "one",
      "min-importance": "one",
      model: "one",
      output: "one",
      "include-personal": "none",
      "no-sensitivity-filter": "none",
      "dry-run": "none",
    },
    {
      hints: {
        url: "<postgres://…>",
        window: "<days> (7)",
        "min-importance": "<n> (4)",
        model: "<id — else OB1_DIGEST_MODEL, else the brain's chat model>",
        output: "<telegram|stdout|file> (telegram)",
      },
    },
  );

  const url = databaseUrl(cli.value("url"));
  const outputRaw = (cli.value("output") ?? "telegram").trim();
  if (outputRaw !== "telegram" && outputRaw !== "stdout" && outputRaw !== "file") {
    console.error(`--output must be telegram|stdout|file, got: ${outputRaw}`);
    process.exit(2);
  }
  const args: RunArgs = {
    windowDays: cli.int("window", { absent: 7, min: 1, max: 3660 }),
    minImportance: cli.number("min-importance", { absent: 4, min: 0, fraction: true }),
    model: cli.value("model"),
    output: outputRaw,
    includePersonal: cli.has("include-personal"),
    noSensitivityFilter: cli.has("no-sensitivity-filter"),
    dryRun: cli.has("dry-run"),
  };

  const sql = openSql(url, { max: 1 });
  await closeThenExit(sql, async () => {
    return run(sql, url, args);
  });
}
