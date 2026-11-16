/**
 * sensitivity.ts — the sensitivity patterns and tiers `db/backfill-metadata.ts`
 * writes and `db/weekly-digest.ts` holds a row back by (SMD-3318).
 *
 * The patterns began as `recipes/thought-enrichment/sensitivity-patterns.json`'s,
 * copied when the recipe's backfill-sensitivity.mjs moved to `db/`, and were
 * widened when weekly-digest came to rely on them (review pass 3): a password
 * after `_`, in JSON or as `passwd`/`pwd`, provider keys with a hyphenated
 * prefix (`sk-proj-`, `sk-ant-`) and GitHub, AWS, Slack and Google shapes, an
 * SSN written with spaces, dots or dashes; and `financial_amount`, which
 * backtracked quadratically over a long run of digits and never matched a
 * `$` after a space, reads `$` and three digits. The text is read NFKC-folded
 * (fullwidth digits and colons as ASCII) with zero-width and soft-hyphen
 * characters dropped, so neither hides a word. A denylist still misses what it
 * does not name (a homoglyph, digits of another script, a secret in prose),
 * and it takes some harmless numbers for an SSN (a ZIP+4, a nine-digit order
 * number): it narrows what leaves the box, it does not prove nothing does.
 * Each entry is [source, flags, label]; none is global, so a test keeps no
 * state between thoughts.
 *
 * A tier's rank: absent, empty and `standard` (any case, any surrounding
 * white space) 0, `personal` 1, `restricted` 2; anything else (a number,
 * `secret`) is no tier this ranks, and a writer leaves it.
 */

export const PATTERNS: { readonly restricted: readonly (readonly [string, string, string])[]; readonly personal: readonly (readonly [string, string, string])[] } = {
  restricted: [
    [String.raw`\b\d{3}[-\s.‐-―]?\d{2}[-\s.‐-―]?\d{4}\b`, "", "ssn_pattern"],
    [String.raw`\b[A-Z]{1,2}\d{6,9}\b`, "", "passport_pattern"],
    [String.raw`\b\d{8,17}\b[^\n]{0,80}\b(account|routing|iban)\b`, "i", "bank_account"],
    [String.raw`\b(account|routing)\b[^\n]{0,80}\b\d{8,17}\b`, "i", "bank_account"],
    [String.raw`\b(sk-|pk_live_|sk_live_|ghp_|gho_|AKIA)[A-Za-z0-9]{10,}`, "i", "api_key"],
    [String.raw`\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}`, "i", "api_key"],
    [String.raw`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})`, "", "api_key"],
    [String.raw`\bpassword\s*[:=]\s*\S+`, "i", "password_value"],
    [String.raw`(?:pass(?:word|wd|phrase)|pwd)[\"']?\s*(?:[:=]|\bis\b)\s*[\"']?[^\s\"']+`, "i", "password_value"],
    [String.raw`\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b`, "", "credit_card"],
  ],
  personal: [
    [String.raw`\b\d+\s*mg\b(?!\s*\/\s*(dL|kg|L|ml))`, "i", "medication_dosage"],
    [String.raw`\b(pregabalin|metoprolol|losartan|lisinopril|aspirin|atorvastatin|sertraline|metformin|gabapentin|prednisone|insulin|warfarin)\b`, "i", "drug_name"],
    [String.raw`\b(glucose|a1c|cholesterol|blood pressure|bp|hrv|bmi)\b[^\n]{0,80}\b\d+`, "i", "health_measurement"],
    [String.raw`\b(diagnosed|diagnosis|prediabetic|diabetic|arrhythmia|ablation)\b`, "i", "medical_condition"],
    [String.raw`\b(salary|income|net worth|401k|ira|portfolio)\b[^\n]{0,80}\b\$?\d`, "i", "financial_detail"],
    [String.raw`\$\d{3,}`, "i", "financial_amount"],
  ],
};
const RESTRICTED = PATTERNS.restricted.map(([source, flags, label]) => [new RegExp(source, flags), label] as const);
const PERSONAL = PATTERNS.personal.map(([source, flags, label]) => [new RegExp(source, flags), label] as const);
/** Zero-width characters and the soft hyphen, which hide inside a word: U+00AD, U+200B–U+200F, U+2060–U+2064, U+FEFF. */
const HIDDEN = new RegExp(`[${[[0xad, 0xad], [0x200b, 0x200f], [0x2060, 0x2064], [0xfeff, 0xfeff]].map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join("")}]`, "g");

export type Tier = "restricted" | "personal" | "standard";

/** Text as the patterns read it: NFKC-folded, zero-width characters and soft hyphens dropped. */
export function sensitivityText(text: string): string {
  return text.normalize("NFKC").replace(HIDDEN, "");
}

/** A thought's tier by the patterns, with the labels that set it: the first restricted match alone, else every personal one. */
export function sensitivityOf(raw: string): { tier: Tier; labels: string[] } {
  const text = sensitivityText(raw);
  for (const [re, label] of RESTRICTED) if (re.test(text)) return { tier: "restricted", labels: [label] };
  const labels = PERSONAL.filter(([re]) => re.test(text)).map(([, label]) => label);
  return labels.length ? { tier: "personal", labels: [...new Set(labels)] } : { tier: "standard", labels: [] };
}

/** A tier's rank: 0 absent, empty or standard (any case, any surrounding white space), 1 personal, 2 restricted; null for anything else, which is left. */
export function tierRank(v: unknown): number | null {
  if (v === null || v === undefined) return 0;
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return t === "" || t === "standard" ? 0 : t === "personal" ? 1 : t === "restricted" ? 2 : null;
}

/** A tier in SQL as tierRank reads it: lower-cased, white space (any, as JavaScript's trim) stripped from both ends. */
export const sqlTier = (expr: string) => `lower(regexp_replace(${expr}, '^[[:space:]]+|[[:space:]]+$', '', 'g'))`;

export const RANK: Readonly<Record<Tier, number>> = { standard: 0, personal: 1, restricted: 2 };
export const TIER_OF_RANK: readonly Tier[] = ["standard", "personal", "restricted"];
