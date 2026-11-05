/**
 * propose.ts — deterministic candidate entity spans (SMD-2017).
 *
 * The entity half of extraction never needed a generative model: SMD-1879
 * measured that windowing loses no entities (they are local), and the failure
 * of the 7B is a decoding pathology, not a reading one. This module proposes
 * candidate names from a thought's text with no LLM and no failure class; a
 * Jev-class decider (server-portable/jev.ts) then decides P(named entity) and
 * P(is-a type) over each candidate. The proposer's RECALL is the ceiling of the
 * whole approach — a name it does not propose can never be decided in — so it
 * over-proposes and lets the decider carry precision.
 *
 * Three channels, unioned and de-duplicated by normalised name:
 *   1. identifier — the `extract_search_needles` rule (migration 017): quoted
 *      spans, and tokens shaped like an identifier (a digit or underscore, a
 *      path/dotted run, or an interior capital). High precision, but blind to
 *      ordinary proper nouns.
 *   2. proper-noun — runs of Capitalised tokens (net-new; nothing in the tree
 *      did this). The main recall lever for people, organisations and places
 *      named in prose.
 *   3. gazetteer — optional dictionary match of names the graph already knows
 *      (ob1_entities.name / aliases / merged_from), so a known name is proposed
 *      even when it is neither identifier-shaped nor freshly capitalised.
 *
 * Every candidate is pre-filtered through entity-gate's refusalOf() — a number
 * or a type-vocabulary word is dropped before a decide call is spent on it. The
 * import of entity-gate is the only one (that module imports nothing), keeping
 * this shared by the worker and the eval so the two measure the same rule.
 */
import { refusalOf, normalizeEntityName } from "./entity-gate.ts";

export type ProposalSource = "identifier" | "proper-noun" | "citation" | "org" | "gazetteer";
export type Candidate = { name: string; sources: ProposalSource[] };

/** The token split of `extract_search_needles` (017): whitespace and the brackets/punctuation that never sit inside an identifier. */
const SPLIT_RE = /[\s`"'(){}\[\]<>,;:!?*|]+/;
/** A bare number, or a number with a one-or-two-letter tail (1st, 3pm, 10x) — never an identifier needle. */
const BARE_NUMBER_RE = /^[0-9]+$/;
const NUMBER_TAIL_RE = /^[0-9]+[A-Za-z]{1,2}$/;

/** Channel 1: the identifier + quoted-literal rule of migration 017, ported verbatim (minus the search-time cap of 8). */
export function identifierCandidates(text: string): string[] {
  const out: string[] = [];
  let remainder = text;
  // Quoted spans first, blanked from the remainder so they are not re-tokenised.
  const quoted = /"([^"]+)"|`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = quoted.exec(text)) !== null) {
    const span = (m[1] ?? m[2] ?? "").trim();
    if (span.length >= 3 && span.length <= 64 && /[A-Za-z0-9]/.test(span)) out.push(span);
    remainder = remainder.replace(m[0], " ".repeat(m[0].length));
  }
  for (let tok of remainder.split(SPLIT_RE)) {
    tok = tok.replace(/^[.-]+/, "").replace(/[.-]+$/, ""); // strip leading/trailing . and -, keep interior
    if (tok.length < 3 || tok.length > 64) continue;
    if (BARE_NUMBER_RE.test(tok) || NUMBER_TAIL_RE.test(tok)) continue;
    const identifierShaped = /[0-9_]/.test(tok) || (/[./]/.test(tok) && /[^./]{2}/.test(tok)) || /[a-z][A-Z]/.test(tok);
    if (identifierShaped) out.push(tok);
  }
  return out;
}

/** Function/sentence words that a lone Capitalised token at a sentence start is, not an entity — dropped to keep the candidate count (and the decide bill) sane without touching recall. */
const LEAD_STOPWORDS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "it", "we", "i", "he", "she", "they", "you",
  "in", "on", "at", "of", "to", "for", "and", "or", "but", "so", "if", "as", "by", "with", "from",
  "when", "where", "while", "then", "there", "here", "our", "their", "its", "his", "her", "your", "my",
  "is", "are", "was", "were", "be", "been", "will", "would", "can", "could", "should", "may", "might",
  "not", "no", "yes", "each", "every", "some", "any", "all", "both", "one", "two", "three", "first",
  "next", "last", "also", "however", "thus", "therefore", "because", "since", "after", "before", "during",
]);
/** A word that may sit inside a proper-noun run in lower case (Bank of England, Carnegie & Co), and the dashes a project name uses (Open Brain — Memory Quality & Claim Log). */
const INNER_CONNECTORS = new Set(["of", "and", "the", "for", "de", "van", "von", "del", "la", "di", "da", "&", "—", "–", "-"]);
/** A run token: a Capitalised word (Postgres, McKinsey), an ALL-CAPS acronym (ACL, NASDAQ), an initial (B.), or a hyphenated/aposed name (Stoltz-Taylor, O'Neil). */
const CAP_TOKEN_RE = /^[A-Z][A-Za-z0-9'’.&/-]*$/;

/**
 * Channel 2: runs of Capitalised tokens. Walks the whitespace tokens of each
 * line, joining a Capitalised token to the next across a lower-case connector,
 * and emits the run trimmed of a trailing connector or stray punctuation. A
 * lone Capitalised token is dropped when it is a sentence-lead function word
 * (the recall it would add is none — those are never entities).
 */
const MAX_RUN = 10; // a project name (Open Brain — Memory Quality & Claim Log) runs long; still caps the walk
const strip = (t: string) => t.replace(/^[("'`\[{]+/, "").replace(/[.,;:!?)"'`\]}]+$/, "");
export function properNounCandidates(text: string): string[] {
  const out: string[] = [];
  const toks = text.split(/\s+/);
  let i = 0;
  while (i < toks.length) {
    const w = strip(toks[i]);
    if (w.length > 64 || !CAP_TOKEN_RE.test(w)) { i++; continue; }
    const run = [w];
    let j = i + 1;
    while (j < toks.length && run.length < MAX_RUN) {
      const nw = strip(toks[j]);
      if (nw.length <= 64 && CAP_TOKEN_RE.test(nw)) { run.push(nw); j++; continue; }
      // a connector counts only when a Capitalised token follows it
      if (INNER_CONNECTORS.has(nw.toLowerCase()) && j + 1 < toks.length) {
        const after = strip(toks[j + 1]);
        if (after.length <= 64 && CAP_TOKEN_RE.test(after)) { run.push(nw); j++; continue; }
      }
      break;
    }
    while (run.length && INNER_CONNECTORS.has(run[run.length - 1].toLowerCase())) run.pop();
    if (run.length) {
      const name = run.join(" ");
      const isAcronym = /^[A-Z0-9&.-]{2,}$/.test(name);
      if (run.length >= 2 || isAcronym || (i > 0 && !LEAD_STOPWORDS.has(name.toLowerCase()))) out.push(name);
    }
    i = Math.max(j, i + 1);
  }
  return out;
}

/**
 * Channel 3: dictionary match of names the graph already knows. Takes a Set of
 * NORMALISED known names (normalizeEntityName of each) and slides 1..maxN token
 * windows over the text, emitting the raw span wherever a window normalises to a
 * known name — O(words × maxN), not O(dictionary × text). This recovers a name
 * that is neither identifier-shaped nor freshly capitalised (a lowercase tool
 * like `pgvector`, a recurring product `PostgreSQL`) when the graph has seen it
 * elsewhere. The eval builds the Set leave-one-out (excluding the thought's own
 * entities) so it measures recall from the graph's OTHER knowledge, not itself.
 */
export function citationCandidates(text: string): string[] {
  const out: string[] = [];
  const grp = /\b([A-Z][A-Za-z'’.-]+ (?:et al\.|and [A-Z][A-Za-z'’.-]+))(?:,? \(?(\d{4}[a-z]?)\)?)?/g;
  let m: RegExpExecArray | null;
  while ((m = grp.exec(text)) !== null) { out.push(m[1].trim()); if (m[2]) out.push(`${m[1].trim()}, ${m[2]}`); }
  const single = /\b([A-Z][A-Za-z'’.-]+), (\d{4}[a-z]?)\b/g;
  while ((m = single.exec(text)) !== null) out.push(`${m[1]}, ${m[2]}`);
  return out;
}

export function orgCandidates(text: string): string[] {
  const out: string[] = [];
  const suffix = /\b([A-Z][A-Za-z'’&.-]+(?:[ ,]+(?:of|and|the|for|[A-Z][A-Za-z'’&.-]+)){0,5}[ ,]+(?:Inc|Incorporated|Ltd|LLC|Corp|Corporation|GmbH|University|Institute|Laboratory|Labs|Foundation|Ventures))\.?/g;
  let m: RegExpExecArray | null;
  while ((m = suffix.exec(text)) !== null) out.push(m[1].replace(/\s+/g, " ").trim());
  return out;
}

/** Channel 3: dictionary match of names the graph already knows (see below). */
export function gazetteerCandidates(text: string, normDict: ReadonlySet<string>, maxN = 8): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= maxN && i + n <= words.length; n++) {
      const span = words.slice(i, i + n).join(" ");
      const norm = normalizeEntityName(span);
      if (norm && normDict.has(norm)) out.push(span);
    }
  }
  return out;
}

/**
 * Propose candidate names from a thought's text: the three channels unioned,
 * de-duplicated by normalised name (the first spelling seen kept), each carrying
 * which channels found it, and every candidate a name entity-gate would not
 * refuse outright (a number, an empty name, a type-vocabulary word).
 */
export function proposeCandidates(text: string, opts: { gazetteer?: ReadonlySet<string> } = {}): Candidate[] {
  const byNorm = new Map<string, Candidate>();
  const add = (name: string, source: ProposalSource) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (refusalOf(trimmed) !== null) return; // a number or a type word: no decide call spent
    const key = normalizeEntityName(trimmed);
    if (!key) return;
    const existing = byNorm.get(key);
    if (existing) { if (!existing.sources.includes(source)) existing.sources.push(source); return; }
    byNorm.set(key, { name: trimmed, sources: [source] });
  };
  for (const n of identifierCandidates(text)) add(n, "identifier");
  for (const n of properNounCandidates(text)) add(n, "proper-noun");
  for (const n of citationCandidates(text)) add(n, "citation");
  for (const n of orgCandidates(text)) add(n, "org");
  if (opts.gazetteer) for (const n of gazetteerCandidates(text, opts.gazetteer)) add(n, "gazetteer");
  return [...byNorm.values()];
}
