/**
 * sensitivity.ts — the sensitivity patterns and tiers `db/backfill-metadata.ts`
 * writes and `db/weekly-digest.ts` reads (SMD-3318).
 *
 * The patterns are `recipes/thought-enrichment/sensitivity-patterns.json`'s,
 * copied whole when the recipe's backfill-sensitivity.mjs moved to `db/`:
 * [source, flags, label]. None is global, so a test keeps no state between
 * thoughts. Known flaws kept as the recipe shipped them: `financial_amount`
 * backtracks quadratically over a long run of digits after a `$` that follows
 * a word character, and `ssn_pattern` takes any nine digits.
 *
 * A tier's rank: absent, empty and `standard` (any case, trimmed) 0,
 * `personal` 1, `restricted` 2; anything else (a number, `secret`) is no tier
 * this ranks, and a writer leaves it.
 */

export const PATTERNS: { readonly restricted: readonly (readonly [string, string, string])[]; readonly personal: readonly (readonly [string, string, string])[] } = {
  restricted: [
    ["\\b\\d{3}-?\\d{2}-?\\d{4}\\b", "", "ssn_pattern"],
    ["\\b[A-Z]{1,2}\\d{6,9}\\b", "", "passport_pattern"],
    ["\\b\\d{8,17}\\b[^\\n]{0,80}\\b(account|routing|iban)\\b", "i", "bank_account"],
    ["\\b(account|routing)\\b[^\\n]{0,80}\\b\\d{8,17}\\b", "i", "bank_account"],
    ["\\b(sk-|pk_live_|sk_live_|ghp_|gho_|AKIA)[A-Za-z0-9]{10,}", "i", "api_key"],
    ["\\bpassword\\s*[:=]\\s*\\S+", "i", "password_value"],
    ["\\b\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}\\b", "", "credit_card"],
  ],
  personal: [
    ["\\b\\d+\\s*mg\\b(?!\\s*\\/\\s*(dL|kg|L|ml))", "i", "medication_dosage"],
    ["\\b(pregabalin|metoprolol|losartan|lisinopril|aspirin|atorvastatin|sertraline|metformin|gabapentin|prednisone|insulin|warfarin)\\b", "i", "drug_name"],
    ["\\b(glucose|a1c|cholesterol|blood pressure|bp|hrv|bmi)\\b[^\\n]{0,80}\\b\\d+", "i", "health_measurement"],
    ["\\b(diagnosed|diagnosis|prediabetic|diabetic|arrhythmia|ablation)\\b", "i", "medical_condition"],
    ["\\b(salary|income|net worth|401k|ira|portfolio)\\b[^\\n]{0,80}\\b\\$?\\d", "i", "financial_detail"],
    ["\\b\\$\\d{3,}[,\\d]*\\b", "i", "financial_amount"],
  ],
};
const RESTRICTED = PATTERNS.restricted.map(([source, flags, label]) => [new RegExp(source, flags), label] as const);
const PERSONAL = PATTERNS.personal.map(([source, flags, label]) => [new RegExp(source, flags), label] as const);

export type Tier = "restricted" | "personal" | "standard";

/** A thought's tier by the patterns, with the labels that set it: the first restricted match alone, else every personal one. */
export function sensitivityOf(text: string): { tier: Tier; labels: string[] } {
  for (const [re, label] of RESTRICTED) if (re.test(text)) return { tier: "restricted", labels: [label] };
  const labels = PERSONAL.filter(([re]) => re.test(text)).map(([, label]) => label);
  return labels.length ? { tier: "personal", labels: [...new Set(labels)] } : { tier: "standard", labels: [] };
}

/** A tier's rank: 0 absent, empty or standard (any case), 1 personal, 2 restricted; null for anything else, which is left. */
export function tierRank(v: unknown): number | null {
  if (v === null || v === undefined) return 0;
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return t === "" || t === "standard" ? 0 : t === "personal" ? 1 : t === "restricted" ? 2 : null;
}

export const RANK: Readonly<Record<Tier, number>> = { standard: 0, personal: 1, restricted: 2 };
export const TIER_OF_RANK: readonly Tier[] = ["standard", "personal", "restricted"];
