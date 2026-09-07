/**
 * identifiers.ts — which strings in a corpus count as identifiers, and which of
 * those are unique to one document.
 *
 * eval-keyword.ts selects its queries this way (SMD-944), and eval-hybrid.ts
 * (SMD-958) needs the same set — the identifier set is one of the four it
 * scores — and the same shape rule for building its mixed and decoy queries.
 * Two copies of a tokenizer drift, and the control in each harness would then be
 * asking the SQL function about a query set the other harness would not have
 * chosen. One definition.
 *
 * Nothing here is used by the product. `extract_search_needles` (migration 017)
 * is the product's rule, written in SQL so every caller shares it; this module
 * exists to CHOOSE queries, and each harness's control asks the real function
 * whether the choice was right.
 */

/**
 * Tokens, split on whitespace and on the punctuation that surrounds identifiers
 * rather than the punctuation inside them. `SMD-944`, `upsert_thought`,
 * `db/config.mjs` and `PGRST202` survive as single tokens; `(foo)` and `bar,`
 * lose their wrappers.
 */
export function tokenize(text: string): string[] {
  return text
    .split(/[\s`"'(){}\[\]<>,;:!?*|]+/)
    .map((t) => t.replace(/^[.\-]+|[.\-]+$/g, ""))
    .filter((t) => t.length >= 4 && t.length <= 40);
}

/**
 * What kind of string this is, which is reported separately because the three
 * kinds are not equally interesting and an average over them can mislead.
 *
 * `code`  — has a digit or an underscore: SMD-506, temporal_activity, PGRST202.
 *           The case SMD-944 is actually about.
 * `path`  — a slash or a dot joining words: db/config.mjs, but also UI/API and
 *           disabled/replaced, which are two ordinary English words with
 *           punctuation between them. An embedding failing on those is much less
 *           surprising, and they were the deepest-ranked queries in the first
 *           keyword run — so lumping them in would have let the weakest cases
 *           carry the headline.
 * `camel` — interior capitals: getUserById.
 * `word`  — none of the above: an ordinary rare word. Excluded from the default
 *           query set, and only reachable under `--all-hapax`. It has its own
 *           label rather than being folded into one of the others: an earlier
 *           version coerced these to `code`, so `--all-hapax` would have
 *           reported plain English words in the row labelled "digit or
 *           underscore" and produced a table that was wrong rather than noisy.
 */
export type Shape = "code" | "path" | "camel" | "word";
export function shapeOf(t: string): Shape {
  if (/^\d+$/.test(t)) return "word"; // a bare number is not an identifier
  if (/\d/.test(t) || /_/.test(t)) return "code";
  if (/[/.]/.test(t)) return "path";
  if (/[a-z][A-Z]/.test(t)) return "camel";
  return "word";
}

export type Doc = { id: string; text: string };

/** Document frequency by token: which documents contain each token at least once. */
export function documentFrequency(docs: Doc[]): Map<string, Set<string>> {
  const df = new Map<string, Set<string>>();
  for (const d of docs) {
    for (const t of new Set(tokenize(d.text))) {
      if (!df.has(t)) df.set(t, new Set());
      df.get(t)!.add(d.id);
    }
  }
  return df;
}

/**
 * Case-insensitive substring containment over the corpus: which documents
 * contain the string anywhere, not as a token. This duplicates the SQL
 * function's semantics in JavaScript, which is acceptable HERE and only here —
 * its job is to choose queries, and each harness's control asks the real
 * function whether the choice was right.
 */
export function substringContainers(docs: Doc[]): (needle: string) => string[] {
  const lowered = docs.map((d) => ({ id: d.id, text: d.text.toLowerCase() }));
  return (needle: string) => {
    const n = needle.toLowerCase();
    return lowered.filter((d) => d.text.includes(n)).map((d) => d.id);
  };
}

export type IdentifierQuery = { token: string; shape: Shape; want: string };

/**
 * Every `step`-th element, `max` of them, so a capped set is spread over the
 * whole list rather than being its first `max` entries. One definition:
 * eval-hybrid.ts caps its sets with the same stride, and a second copy with
 * the multiplication in a different order picked a different index once the
 * float rounding differed.
 */
export function strideSample<T>(xs: T[], max: number): T[] {
  // `!(max > 0)` rather than `max <= 0`: a NaN cap (a non-numeric env var) is
  // "no cap", as it was before this helper existed, not an empty set.
  if (!(max > 0) || xs.length <= max) return xs;
  const step = xs.length / max;
  return Array.from({ length: max }, (_, i) => xs[Math.floor(i * step)]);
}

/**
 * Tokens that appear in exactly one document BY SUBSTRING and are
 * identifier-shaped; the answer is that document.
 *
 * Hapax by substring, not by token. The first version of eval-keyword.ts
 * selected tokens appearing in exactly one document and stopped there, and its
 * control rejected the run: "SMD-50" is a token in one document and a substring
 * of three, because SMD-500 and SMD-501 exist. So does "risk_level", inside
 * "risk_levels". Token frequency is still the cheap first pass — it removes
 * almost everything for the cost of one map — and substring uniqueness is then
 * checked against the whole corpus.
 *
 * Deterministic sample rather than the first N, which would be the first N
 * documents' vocabulary and nothing else. `max` 0 means all of them.
 */
export function selectIdentifierQueries(docs: Doc[], opts: { allHapax?: boolean; max?: number } = {}): IdentifierQuery[] {
  const df = documentFrequency(docs);
  const containers = substringContainers(docs);
  const out = [...df.entries()]
    .filter(([, ids]) => ids.size === 1)
    .map(([token]) => ({ token, shape: shapeOf(token) }))
    .filter((c) => opts.allHapax || c.shape !== "word")
    .map((c) => ({ ...c, holders: containers(c.token) }))
    .filter((c) => c.holders.length === 1)
    .map((c) => ({ token: c.token, shape: c.shape, want: c.holders[0] }));
  out.sort((a, b) => (a.token < b.token ? -1 : 1));
  return strideSample(out, opts.max ?? 0);
}
