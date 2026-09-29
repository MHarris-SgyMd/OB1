/**
 * genre.ts (SMD-2323) — classify a thought's source GENRE: is it a research
 * paper, a project issue, a technical doc, a work log, a blog article, a recipe,
 * or none of these? The brain already stores `source` (the capture channel: a
 * coarse proxy) and `type` (the capture-kind: task/observation/reference/idea),
 * but neither says what KIND of content the text is. A `metadata.genre` facet
 * lets a reader filter and a downstream extractor branch on the content's genre
 * (SMD-2269/2321), the way SMD-2300's carve-out already branches on shape.
 *
 * Two stages, cheapest first — the shape of hybrid-extract.ts:
 *   1. A DETERMINISTIC pre-signal over the metadata already on the thought: a
 *      Linear/tracker row (`source:linear`) is a project-issue by construction;
 *      an arXiv id or an author list is a research paper. No model call, no
 *      egress, always available. An existing valid `genre` is respected, so a
 *      re-derivation and a caller-supplied genre are idempotent.
 *   2. When the pre-signal is silent AND the typed-decision tier is configured
 *      (jev.ts, opt-in via OB1_JEV_BASE_URL), a jevChoose over the genre
 *      vocabulary decides from the content — the CHOICE mechanism the spike
 *      measured at 99-100% on this vocabulary, including genres absent from the
 *      corpus. The options carry rich descriptions, not bare names: the semantic
 *      decider is starved by bare option ids (SMD-2017's lesson).
 *
 * With the tier unset the classifier is pre-signal-only and falls back to
 * `other` — no dependency, no latency. A tier outage falls back to `other` too,
 * flagged in the source, rather than failing the capture. Pure and reusable: the
 * server (index.ts) passes the content, the metadata, a resolved JevConfig or
 * null, and its EgressSubject; the Linear adapter uses presignalGenre alone.
 */
import { jevChoose, type JevConfig } from "./jev.ts";
import type { JevOption, JevResult } from "./jev-contract.ts";
import type { EgressSubject } from "./egress.ts";

/** The genre vocabulary. `other` is both an explicit option and where an abstain or an unknown selection lands. */
export const GENRES = [
  "research-paper",
  "project-issue",
  "technical-doc",
  "work-log",
  "blog-article",
  "recipe",
  "other",
] as const;
export type Genre = (typeof GENRES)[number];

/** The choice's options, with the meaningful descriptions the semantic decider needs (bare names starve it — SMD-2017). */
const GENRE_DESC: Record<Genre, string> = {
  "research-paper": "an academic or scientific paper, preprint, or research article, with an abstract, citations, authors, and findings (for example from arXiv)",
  "project-issue": "a software project ticket, bug report, feature request, or issue-tracker entry describing a unit of work, its status, and its progress",
  "technical-doc": "technical documentation, a reference guide, API docs, a README, a design document, or a how-to explaining how software works",
  "work-log": "a chronological log of work performed, a session transcript, a changelog, a standup note, or a developer's running notes on a task",
  "blog-article": "a blog post, opinion piece, narrative tutorial, or article written for a general audience",
  recipe: "a cooking recipe or food-preparation instructions, with ingredients and steps",
  other: "none of the above: a short note, a message, a fragment, or text that fits no clear genre",
};
const GENRE_OPTIONS: JevOption[] = GENRES.map((g) => ({ id: g, description: GENRE_DESC[g] }));
const GENRE_QUESTION = "What genre of content is this thought?";
/** The content prefix the decider reads; a genre shows in the opening, and a shorter window keeps the call cheap. */
const CTX = 600;

const isGenre = (v: unknown): v is Genre => typeof v === "string" && (GENRES as readonly string[]).includes(v);

/**
 * The deterministic pre-signal: a genre read off the metadata alone, or null
 * when the metadata says nothing. Order is precision-first.
 *   - an existing valid `genre` is kept (idempotent re-derivation, and a caller
 *     may set one — index.ts places the classified value so a valid one round-trips);
 *   - `source:linear` is a Linear tracker row (a ticket head or a dated section
 *     of one), a project-issue by construction — no model can beat the fact;
 *   - an `arxiv_id`, or a non-empty `authors` list, marks a research paper. No
 *     adapter writes these today, so this is defensive: it costs nothing and is
 *     correct the day an ingest source does (SMD-2323 follow-up).
 * Everything else is left to the decider (or, tier unset, to `other`).
 */
export function presignalGenre(metadata: Record<string, unknown> | undefined): Genre | null {
  const m = metadata ?? {};
  if (isGenre(m.genre)) return m.genre;
  if (m.source === "linear") return "project-issue";
  if (typeof m.arxiv_id === "string" && m.arxiv_id.trim() !== "") return "research-paper";
  if (Array.isArray(m.authors) && m.authors.length > 0) return "research-paper";
  return null;
}

/** Where a genre came from: a metadata rule (`presignal`), the tier answering (`decider` — an abstain or an out-of-vocabulary pick counts, both landing on `other`), or the `other` fallback when the tier is unset or unreachable. */
export type GenreOrigin = "presignal" | "decider" | "fallback";
export type GenreResult = { genre: Genre; source: GenreOrigin };

/** The choice call, injectable so a unit test can stub it without a network. Compatible with jevChoose (its extra `model` field is ignored). */
export type ChooseFn = (
  cfg: JevConfig,
  d: { question: string; options: JevOption[]; context: string },
  subject: EgressSubject,
) => Promise<{ result: JevResult }>;

/**
 * Classify a thought's genre: the pre-signal first, then the decider when the
 * tier is configured, then `other`. Never throws and never fails the capture —
 * a tier outage is caught and falls back to `other`, flagged in the source.
 */
export async function classifyGenre(
  content: string,
  metadata: Record<string, unknown> | undefined,
  jev: JevConfig | null,
  subject: EgressSubject,
  opts: { decide?: ChooseFn } = {},
): Promise<GenreResult> {
  const pre = presignalGenre(metadata);
  if (pre) return { genre: pre, source: "presignal" };
  if (!jev) return { genre: "other", source: "fallback" };
  const choose = opts.decide ?? jevChoose;
  const context = content.replace(/\s+/g, " ").trim().slice(0, CTX);
  try {
    const { result } = await choose(jev, { question: GENRE_QUESTION, options: GENRE_OPTIONS, context }, subject);
    if (result.abstained || !isGenre(result.selected)) return { genre: "other", source: "decider" };
    return { genre: result.selected, source: "decider" };
  } catch {
    return { genre: "other", source: "fallback" };
  }
}
