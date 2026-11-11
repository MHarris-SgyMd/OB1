#!/usr/bin/env bun
/**
 * weekly-digest.ts — the week's thoughts, ranked and synthesized into a digest,
 * delivered to Telegram, a file, or stdout — with every hop that leaves the box
 * decided by the egress gate. SMD-2239.
 *
 * This is the `db/` home for what `recipes/weekly-digest/weekly-digest.mjs` did
 * over PostgREST. That recipe was Daemonic Brain's one true SINK: it paged the
 * week's rows and posted their synthesized text to a third party with no egress
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
 * ── What matters first (SMD-4112) ───────────────────────────────────────────
 * Each thought's effective priority (`docs/priority.md` decision 8) is read for
 * the window, and each day and writer's share is taken what matters most first
 * (pickForDigest); each pick's prompt row says why it matters. A brain before
 * migration 122, or a read that fails, leaves the share by recency alone, and
 * the run says so.
 *
 * ── Sensitivity, fail-closed ────────────────────────────────────────────────
 * `sensitivity_tier` is an optional TEXT column. Rows tagged `restricted`
 * (always) and `personal` (unless --include-personal) are excluded, by the
 * column or by `metadata.sensitivity_tier` (the import recipes' facet, under a
 * column left at its default — SMD-2493); NULL and every other tier are kept. If the column is ABSENT the run REFUSES rather than
 * page every row unfiltered — the privacy boundary the recipe promised —
 * unless --no-sensitivity-filter says, in as many words, to send everything.
 */

import { commandLine } from "./cli.ts";
import { databaseUrl, openSql, closeThenExit } from "./connect.ts";
import { providerCall, providerEndpoint, refuseRedirect, resolveEmbedConfig, baseUrlOr, type EmbedConfig, type EmbedEnv, type ProviderEndpoint } from "../server-portable/embed.ts";
import { installBackgroundSlots } from "../server-portable/slots.ts";
import { mayLeaveBox, flagOn, type EgressSubject, type EgressUnit } from "../server-portable/egress.ts";
import { egressDescription, egressRefusal, workerIdentity, classifyError, TRANSIENT_PAUSES_MS } from "./worker-bootstrap.ts";
import { normaliseEffectivePriority, type EffectivePriority } from "../server-portable/store.ts";
import { dueText, LEVEL_WORDS } from "../server-portable/render.ts";
import fs from "node:fs";
import path from "node:path";
import type { SQL } from "bun";

// ── Config ──────────────────────────────────────────────────────────────────

// How many thoughts are serialized into the synthesis prompt: pickForDigest's
// share of the window. Bigger = more context, more tokens.
const SYNTHESIZE_INPUT_CAP = 80;

// The most rows read per run. Every one's priority is read before the turns are
// numbered (SMD-4112), so this is the window the ranking sees: a week is about
// 550 on the canary and 900 over 14 days (2026-11-11). Past it, readThoughts
// keeps each group's newest, so a cut drops the latest turns, never a day or a
// writer.
const FETCH_HARD_CAP = 5000;
// The most effective_priority reads in one call (122's limit): the window is read in chunks of it.
const PRIORITY_READ_MAX = 1000;

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
  // No key — the bot token is in the path — and providerEndpoint's header rule,
  // so a user and password in the base go as Basic, as for every endpoint
  // (SMD-2885). No declaredBy: that is resolveProviderEndpoints' bookkeeping (a
  // closed LocalKnob set this endpoint is not part of); the banner names the knob.
  return providerEndpoint(baseUrlOr(env.OB1_TELEGRAM_API_BASE, DEFAULT_TELEGRAM_BASE), undefined, flagOn(env.OB1_TELEGRAM_LOCAL));
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
  /**
   * The row's place in its day and writer's queue, 1 for the newest: readThoughts
   * numbers each (day, `metadata.actor_name`) group newest first. pickForDigest
   * numbers them again, what matters most first, once priorities are read.
   */
  turn?: number;
  /** The row's (day, writer) group, as readThoughts names it; absent, the row's turn stands. */
  group?: string;
  /** The row's effective priority (readPriorities); absent when it was not read. */
  priority?: DigestPriority;
};

/** What the digest reads of a thought's effective priority (the store's, SMD-3667): the order, the terms behind it, and whether it is settled. */
export type DigestPriority = Pick<EffectivePriority, "effective" | "settled" | "terms">;

type ChatCompletion = { choices?: Array<{ message?: { content?: string } }> };

// ── Ranking (pure) ────────────────────────────────────────────────────────

/**
 * The thoughts the digest reads, at most `cap`, spread over the window's days
 * and writers a turn at a time: the first of every (day, writer) group, then
 * the second of each, and so on. So a quiet day keeps its share beside a busy
 * one, and a key that floods the window gets one row per day per turn, as
 * every other writer does. Stable takes about 60 thoughts a day (2026-11-02):
 * the newest 80 alone would be a day and a half of a "weekly" digest.
 *
 * Within each group the rows go what matters most first, by effective priority
 * (`docs/priority.md` decision 8, SMD-4112), then newest first; within a turn,
 * too. So a group's Urgent ticket is its first turn, and a key that states
 * Urgent on all of its own captures still gets one row per day per turn (the
 * maintainer, 2026-11-11: priority within each share, not over it). The pick
 * is then said what matters most first, newest first among equals. With no
 * priority read, or none stated (every row unknown's 2), that is the turns by
 * recency and the newest first, the order before SMD-4112. A row with no
 * `group` keeps the turn readThoughts gave it.
 *
 * `importance` takes no part. It is retired (SMD-3661, decision 8): any key
 * could set it on its own rows, so ten captures carrying a high value ranked
 * every other key's thought out (SMD-2653). Times compare as instants: a row
 * from the database carries a Date, whose string leads with its weekday. An
 * unreadable time sorts last.
 */
export function pickForDigest(thoughts: DigestThought[], cap = SYNTHESIZE_INPUT_CAP): DigestThought[] {
  const at = (t: DigestThought) => {
    const ms = new Date(t.created_at).getTime();
    return Number.isFinite(ms) ? ms : -Infinity;
  };
  const newestFirst = (a: DigestThought, b: DigestThought) => (at(a) === at(b) ? 0 : at(a) < at(b) ? 1 : -1);
  const effective = (t: DigestThought) => t.priority?.effective ?? 0;
  const mattersMost = (a: DigestThought, b: DigestThought) => effective(b) - effective(a);
  // Each group's rows numbered again, what matters most first, then newest (then by id, as readThoughts breaks a tie).
  const turns = new Map<DigestThought, number>();
  const groups = new Map<string, DigestThought[]>();
  for (const t of thoughts) {
    if (t.group === undefined) continue;
    const g = groups.get(t.group);
    if (g) g.push(t);
    else groups.set(t.group, [t]);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => mattersMost(a, b) || newestFirst(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).forEach((t, i) => turns.set(t, i + 1));
  }
  const turn = (t: DigestThought) => turns.get(t) ?? t.turn ?? 1;
  return [...thoughts]
    .sort((a, b) => turn(a) - turn(b) || mattersMost(a, b) || newestFirst(a, b))
    .slice(0, cap)
    .sort((a, b) => mattersMost(a, b) || newestFirst(a, b));
}

const levelWord = (n: unknown) => LEVEL_WORDS[Number(n)] ?? `level ${Number(n)}`;
const dueWords = (iso: unknown) => (typeof iso === "string" && Number.isFinite(Date.parse(iso)) ? dueText(iso) : "?");

/**
 * Why a pick matters, in words, beside it in the prompt (SMD-4112): its level and where it came from (stated, from
 * its open items, or inherited from the ticket or item it serves), then its due time or overdue, what it unblocks, and
 * whether it is settled, as effective_priority's terms say them; the level's words and a due time's are the MCP
 * replies' (render.ts). Null when the read knows nothing of it beyond unknown's level, settled or not: settled is
 * said beside a known priority, so a brain with none stated gets the prompt it got before.
 */
export function priorityReason(p: DigestPriority | undefined): string | null {
  if (!p) return null;
  const parts: string[] = [];
  for (const t of p.terms) {
    const d = t.detail ?? {};
    if (t.term === "level") parts.push(`${levelWord(d.level)}, stated`);
    else if (t.term === "from_items") parts.push(`${levelWord(d.level)}, from its open item`);
    else if (t.term === "inherited") {
      const f = (d.from ?? {}) as { kind?: string; key?: string };
      parts.push(`${levelWord(t.value)}, inherited from ${f.kind === "item" ? "open item" : f.kind ?? "?"} ${f.key ?? "?"}`);
    } else if (t.term === "overdue") parts.push(`overdue, due ${dueWords(d.due_at)}`);
    else if (t.term === "urgency") parts.push(`due ${dueWords(d.due_at)}`);
    else if (t.term === "unblocks") parts.push(`unblocks ${Number(d.count)}`);
  }
  if (parts.length === 0) return null;
  // A due time or an unblock on an item with no level of its own: said as such, so the words never read as a level.
  if (p.terms[0]?.term === "unknown") parts.unshift("no level stated");
  if (p.settled) parts.push("settled");
  return parts.join("; ");
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
  const rows = thoughts.slice(0, SYNTHESIZE_INPUT_CAP).map((t) => {
    const why = priorityReason(t.priority);
    return {
      id: t.id,
      date: String(t.created_at instanceof Date ? t.created_at.toISOString() : t.created_at).slice(0, 10),
      type: t.metadata?.type ?? null,
      content: String(t.content ?? "").slice(0, 280),
      topics: (Array.isArray(t.metadata?.topics) ? (t.metadata!.topics as unknown[]) : []).slice(0, 5),
      tags: (Array.isArray(t.metadata?.tags) ? (t.metadata!.tags as unknown[]) : []).slice(0, 5),
      // Only where the brain knows a priority (SMD-4112): a prompt with none stated is the one before it.
      ...(why ? { priority: why } : {}),
    };
  });
  const source = rows.some((r) => "priority" in r)
    ? `Source: ${rows.length} thoughts, a share of each day and writer in the window, what matters most taken first from each, listed what matters most first (a row's priority says why, and whether it is settled).`
    : `Source: ${rows.length} thoughts, a share of each day and writer in the window.`;
  return (
    `Weekly digest for ${fmt(startDate)} – ${fmt(endDate)}.\n` +
    `${source}\n\n` +
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
 * The window's rows, each numbered by its turn (pickForDigest), in turn order and
 * capped, so a cap reached on a busy window drops later turns, not whole
 * days or writers. `restricted` (always) and
 * `personal` (unless includePersonal) are excluded when the column exists, by
 * the column or the row's `metadata.sensitivity_tier`. Returns the rows, or
 * `{ failClosed: true }` when the sensitivity column is missing and the filter
 * was not waived.
 */
export async function readThoughts(
  sql: SQL,
  opts: { windowDays: number; includePersonal: boolean; noSensitivityFilter: boolean },
): Promise<{ failClosed: true } | { failClosed: false; rows: DigestThought[] }> {
  const [cols] = await sql`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'thoughts' AND column_name = 'sensitivity_tier') AS has_sensitivity`;
  const hasSensitivity = Boolean(cols.has_sensitivity);
  const filter = !opts.noSensitivityFilter;

  if (filter && !hasSensitivity) return { failClosed: true };

  // Column names are fixed strings gated by the existence probe above — never
  // caller input — so building the select list is safe. Values go as $-params.
  const selectCols = ["id", "content", "created_at", "metadata"];
  if (filter && hasSensitivity) selectCols.push("sensitivity_tier");

  const params: unknown[] = [opts.windowDays];
  let where = "created_at >= now() - make_interval(days => $1::int)";
  if (filter && hasSensitivity) {
    const excluded = opts.includePersonal ? ["restricted"] : ["restricted", "personal"];
    // The tier a row's metadata carries counts as the column's does: an import
    // through the ingestion pipeline sets the facet, and the column keeps its
    // default 'standard' (SMD-2493).
    where += " AND (sensitivity_tier IS NULL OR sensitivity_tier <> ALL($2)) AND (metadata->>'sensitivity_tier' IS NULL OR metadata->>'sensitivity_tier' <> ALL($2))";
    params.push(sql.array(excluded, "TEXT"));
  }

  // `group` names the row's (day, writer), for pickForDigest to number again once priorities are read (SMD-4112).
  const rows = (await sql.unsafe(
    `SELECT ${selectCols.join(", ")}, turn, "group" FROM (
       SELECT ${selectCols.join(", ")},
              (row_number() OVER (PARTITION BY created_at::date, metadata->>'actor_name' ORDER BY created_at DESC, id))::int AS turn,
              jsonb_build_array(created_at::date, metadata->>'actor_name')::text AS "group"
         FROM thoughts WHERE ${where}) w
      ORDER BY turn, created_at DESC LIMIT ${FETCH_HARD_CAP}`,
    params,
  )) as DigestThought[];
  return { failClosed: false, rows };
}

/**
 * The window's effective priorities (SMD-4112): each thought by its id, a ticket's own row read as its ticket, under
 * the brain's weights (the operator's setting over the built-in ones, since 132), in calls of effective_priority's
 * 1,000, each row read as the store reads it (normaliseEffectivePriority). `why` instead when they cannot be read, and
 * the digest keeps the order before SMD-4112: a brain before migration 122 (no read), or a read that fails — a server
 * role without the priority group's grants, an operator's setting the brain refuses (132's 22000), a row the store
 * cannot read — the database's words kept. A digest still goes out; the run says why it is unranked.
 */
export async function readPriorities(
  sql: SQL,
  ids: string[],
): Promise<{ read: Map<string, DigestPriority> } | { read: null; why: string; failed: boolean }> {
  try {
    const [probe] = await sql`SELECT to_regprocedure('public.effective_priority(jsonb,jsonb,timestamptz)') IS NOT NULL AS has`;
    if (!probe?.has) return { read: null, why: "the brain is before migration 122, which adds effective_priority", failed: false };
    const read = new Map<string, DigestPriority>();
    for (let i = 0; i < ids.length; i += PRIORITY_READ_MAX) {
      const items = JSON.stringify(ids.slice(i, i + PRIORITY_READ_MAX).map((key) => ({ kind: "thought", key })));
      // The store's columns, named, never `*` (SMD-3302).
      const rows = await sql`
        SELECT item_kind, item_key, effective, level, inherited_from, due_at, due_from, urgency, overdue, unblocks, settled,
               not_before, waiting, terms, winner, passed_over
          FROM effective_priority((${items}::text)::jsonb, NULL::jsonb, now())` as unknown[];
      for (const r of rows) {
        const p = normaliseEffectivePriority(r, "effective_priority");
        read.set(p.item.key, { effective: p.effective, settled: p.settled, terms: p.terms });
      }
    }
    return { read };
  } catch (e) {
    return { read: null, why: oneLine(String((e as Error)?.message ?? e)), failed: true };
  }
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 500);

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

/**
 * The digest's text to Telegram, in chunks. Exported for test-local-provider.ts [13]: a redirect is refused, never
 * followed, and the token in its path is never printed (SMD-2908).
 */
export async function deliverTelegram(at: ProviderEndpoint, token: string, chatId: string, text: string): Promise<number[]> {
  const url = `${at.base}/bot${token}/sendMessage`;
  const ids: number[] = [];
  for (const chunk of chunkForTelegram(text)) {
    const res = await withProviderRetry("telegram", async () => {
      const r = await fetch(url, {
        method: "POST",
        headers: at.headers,
        body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true }),
        // Never followed: the gate judged this base, not where a 3xx points (SMD-2908).
        redirect: "manual",
      });
      // The target's host alone: a redirect to the same path elsewhere carries the token in it, in any spelling a
      // server picks, so no mask of the path holds (review pass 2).
      const redirected = refuseRedirect("Telegram sendMessage", at.base, r, { hostOnly: true });
      if (redirected) throw redirected;
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
    `weekly-digest: window=${args.windowDays}d model=${model} ` +
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

  // The priorities, once for the window (SMD-4112); unread, the order before it.
  const priorities = await readPriorities(sql, read.rows.map((t) => String(t.id)));
  if (priorities.read === null) {
    if (priorities.failed) console.error(`  ⚠ the window's priorities could not be read, so the picks are not ranked by them: ${priorities.why}`);
    else console.log(`  priorities not read: ${priorities.why}`);
  } else {
    for (const t of read.rows) {
      const p = priorities.read.get(String(t.id));
      if (p) t.priority = p;
    }
  }
  const pool = pickForDigest(read.rows);
  const known = pool.filter((t) => priorityReason(t.priority) !== null).length;
  console.log(`  picked ${pool.length} thought(s) across the window's days and writers${priorities.read === null ? "" : `, what matters most first in each (${known} with a known priority)`}`);

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
    console.log(`  wrote ${deliverFile(digest, startDate, endDate, model, { used: pool.length, poolSize: read.rows.length })}`);
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
    const ids = await deliverTelegram(telegram, token, chatId, digest);
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
        model: "<id — else OB1_DIGEST_MODEL, else the brain's chat model>",
        output: "<telegram|stdout|file> (telegram)",
      },
    },
  );

  const url = databaseUrl(cli.value("url"));
  // Background calls held to their share, once for the process (SMD-3379 PR 2b-1): a local model server's by default (PR 2b-2b), OB1_BACKGROUND_SLOTS' own, or none under `off`.
  installBackgroundSlots({ url, raw: process.env.OB1_BACKGROUND_SLOTS, modelSlots: process.env.OB1_MODEL_SLOTS });
  const outputRaw = (cli.value("output") ?? "telegram").trim();
  if (outputRaw !== "telegram" && outputRaw !== "stdout" && outputRaw !== "file") {
    console.error(`--output must be telegram|stdout|file, got: ${outputRaw}`);
    process.exit(2);
  }
  const args: RunArgs = {
    windowDays: cli.int("window", { absent: 7, min: 1, max: 3660 }),
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
