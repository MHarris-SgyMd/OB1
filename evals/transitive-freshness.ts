/**
 * transitive-freshness.ts — the pure rules of SMD-2271: which tickets a thought
 * references, and whether a rule demotes a thought because every ticket it is
 * about is finished. No imports: evals/eval-transitive-freshness.ts prices the
 * rules with them, and db/test-schema.ts holds migration 077's SQL
 * (ticket_references, ticket_references_settled) to them row for row.
 *
 * The SQL reads keys with ASCII lookarounds, `(?<![A-Za-z0-9_])…(?![A-Za-z0-9_])`,
 * which is what JavaScript's `\b` (no `u` flag) is beside an ASCII letter or
 * digit: a key next to `é` is a key in both. PostgreSQL's own `\m`/`\M` would
 * read the locale's letters as word characters, and its `\b` is a backspace.
 */

/** A ticket key: Linear's TEAM-123 shape, whole-word. */
const KEY_RE = /\b([A-Z][A-Z0-9]+-[0-9]+)\b/g;
/** The session hook's header: `Session summary — SMD-1234 — claude-code — …` names the branch's ticket. */
const HEADER_RE = /^Session summary — ([A-Z][A-Z0-9]+-[0-9]+) —/;

export const SHARE_MIN = 3;
/** The settled share the share rules need, as a fraction compared in integers (2/3 × 3 is not exactly 2 in every float order). */
export const SHARE = { num: 2, den: 3 } as const;
/** search_demote_weight() (059): what a demoted row's fused score is multiplied by. */
export const DEMOTE_WEIGHT = 0.25;

export const RULES = ["none", "central", "central-topics", "central+share", "share", "central-veto", "central+share-veto"] as const;
export type Rule = (typeof RULES)[number];

export type Refs = { central: string[]; centralTopics: string[]; body: string[] };

function keysIn(text: string): string[] {
  return [...new Set([...text.matchAll(KEY_RE)].map((m) => m[1]))].sort();
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** A thought's ticket references: central (topics, action items, the summary header's key) and body (every key in its text). */
export function refsOf(content: string, metadata: Record<string, unknown> | null): Refs {
  const m = metadata ?? {};
  const centralTopics = keysIn([...strings(m.topics), ...strings(m.action_items)].join("\n"));
  const header = HEADER_RE.exec(content)?.[1];
  const central = [...new Set([...centralTopics, ...(header ? [header] : [])])].sort();
  return { central, centralTopics, body: keysIn(content) };
}

/** The status a key's ticket head carries, or undefined when the brain holds no head or the status is not a known lifecycle type. */
export type StatusOf = (key: string) => string | undefined;

/**
 * Whether `rule` demotes a lifecycle-less thought with these references, and
 * the settled keys that decide it (sorted); null when it does not. The caller
 * applies it only where node_state's open IS NULL.
 */
export function transitiveDemotion(refs: Refs, statusOf: StatusOf, settled: ReadonlySet<string>, rule: Rule): string[] | null {
  if (rule === "none") return null;
  const known = (keys: string[]) => keys.filter((k) => statusOf(k) !== undefined);
  const allSettled = (keys: string[]) => keys.every((k) => settled.has(statusOf(k)!));
  const share = (keys: string[], min: number) => {
    const s = keys.filter((k) => settled.has(statusOf(k)!));
    return keys.length >= min && s.length * SHARE.den >= SHARE.num * keys.length ? s : null;
  };
  if (rule === "share") return share(known(refs.body), 1);
  const central = known(rule === "central-topics" ? refs.centralTopics : refs.central);
  const body = known(refs.body);
  if (rule === "central-veto" || rule === "central+share-veto") {
    // The open veto: a thought naming ANY open ticket, anywhere in its text, is
    // never demoted — what it puts forward may be that ticket.
    if (body.some((k) => !settled.has(statusOf(k)!))) return null;
    if (central.length > 0) return allSettled(central) ? central : null;
    return rule === "central+share-veto" && body.length >= SHARE_MIN ? body : null;
  }
  if (central.length > 0) return allSettled(central) ? central : null;
  return rule === "central+share" ? share(body, SHARE_MIN) : null;
}
