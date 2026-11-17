/**
 * sensitivity.ts — the sensitivity patterns and tiers `db/backfill-metadata.ts`
 * writes and `db/weekly-digest.ts` holds a row back by (SMD-3318).
 *
 * The patterns began as `recipes/thought-enrichment/sensitivity-patterns.json`'s,
 * copied when the recipe's backfill-sensitivity.mjs moved to `db/`, and were
 * widened when weekly-digest came to rely on them (review passes 3 and 4): a password
 * after `_`, in JSON or as `passwd`/`pwd`, provider keys with a hyphenated
 * prefix (`sk-proj-`, `sk-ant-`) and GitHub, AWS, Slack and Google shapes, an
 * SSN written with spaces, dots or dashes; and `financial_amount`, which
 * backtracked quadratically over a long run of digits and never matched a
 * `$` after a space, reads `$` and three digits; a password named in prose
 * (`password for gmail:`, `**Password**:`, `wifi pass:`, `pw:`, a table cell)
 * with a value carrying a digit or a symbol; a bare `token:` or `secret:`; an
 * Amex number; GitLab and Telegram tokens; and the session-capture hook's own
 * table (SECRET_SHAPES, below). The text is read NFKC-folded (fullwidth digits
 * and colons as ASCII) with zero-width, bidirectional and filler characters
 * dropped, so none hides a word. A denylist still misses what it
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
    [String.raw`\b3[47]\d{2}[\s-]?\d{6}[\s-]?\d{5}\b`, "", "credit_card"],
    [String.raw`\b(?:pass(?:word|wd|phrase|code)?|pw|pwd|pin|passwort|contrase[nñ]a|mot de passe|wachtwoord|senha)\b[^\n:=|]{0,30}?(?:[:=|]|\b(?:is|was)\b)[\s*"'\`|]*(?=[^\s"'\`*|]*[\d!@#$%^&*])[^\s"'\`*|]{4,}`, "i", "password_value"],
    [String.raw`\b(?:token|secret|client[_ -]?secret|api[_ -]?key)\b["']?\s*[:=]\s*["']?(?=[^\s"']*\d)[^\s"']{12,}`, "i", "api_key"],
    [String.raw`\bglpat-[A-Za-z0-9_-]{20,}`, "", "api_key"],
    [String.raw`\b\d{8,10}:[A-Za-z0-9_-]{35}\b`, "", "api_key"],
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
/**
 * `recipes/session-capture-hook/session-capture.mjs`'s SECRET_PATTERNS, copied
 * whole (2026-11-17, review pass 4): the provider keys, credential and
 * password assignments, URLs that carry a password or a `?key=`, bearer
 * tokens, private-key blocks, work-claim tokens and 64-hex keys the brain's
 * own session capture refuses. Copied, not imported: the hook is pasted into a
 * user's own settings, and `db/` code ships without it. Each is restricted,
 * its name the label. Keep the two in step when either changes.
 */
const SECRET_SHAPES: readonly (readonly [string, RegExp])[] = [
  ["anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai key", /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/], // not an anthropic key, which the rule above names — a marker naming both would say what was not there (SMD-2127)
  ["aws access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["github token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/],
  ["slack token", /\bxox[aboprs]-[A-Za-z0-9-]{10,}/],
  ["google api key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["stripe key", /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}/],
  ["sendgrid key", /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/],
  ["linear key", /\blin_api_[A-Za-z0-9]{20,}/],
  ["hugging face token", /\bhf_[A-Za-z0-9]{30,}/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,}){2,4}/], // three segments, or a JWE's five — the tail went out with three (third review pass)
  // The whole block when its footer is there, so a redaction takes the body
  // with the header (SMD-2127); the header alone is still a hit.
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----)?/], // PGP's armor says BLOCK (third review pass)
  // A rule with a `v` group names the VALUE as the span a redaction takes and
  // the offset a refusal prints — `LINEAR_API_KEY=[redacted:…]` keeps the name;
  // the `d` flag records the group's indices (SMD-2127). A value that begins
  // with `[` is a placeholder — `[YOUR_API_KEY]`, `[redacted]`, this script's
  // own marker — not a value: the marker must not be a hit on the second scan.
  ["url with a password", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:(?<v>(?!\[)[^\s/]{4,})@/di],
  ["slack webhook url", /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{16,}/],
  // The connector form SETUP.md documents, `…/mcp?key=<raw key>` (and the root's `…/?key=` clients
  // set up before the proxy still hold), on any path: URLs are blanked
  // before the hex rule runs, so this one reads the full text (fourth review pass).
  ["access key in a URL", /[?&](?:key|api[_-]?key|access[_-]?token|token|secret|sig|signature|x-amz-signature)=(?<v>[A-Za-z0-9._~%+/=-]{16,})/di],
  ["bearer token", /\b[Bb]earer\s+(?<v>[A-Za-z0-9._~+/=-]{20,})/d],
  // A credential ASSIGNED: `x-brain-key: <hex>`, `MCP_ACCESS_KEY=…`, `api_key = "…"`. Not DATABASE_URL:
  // a URL without a password is an address, and one with is caught above.
  // Not MCP_ACCESS_KEYS (plural): that value holds name:scope:DIGEST records by construction (keygen.ts), and a session quoting deploy/.env's line is not leaking a key (third review pass).
  // The name may carry an env-var prefix (`AWS_SECRET_ACCESS_KEY=`, `MY_API_KEY=`,
  // `SECRET_KEY_BASE=`, `GITHUB_TOKEN=`): `\b` never sits between `_` and a
  // letter, so a rule that began at the word let every prefixed spelling by
  // (eleventh review pass). Bare `token` needs a prefix — "a token of appreciation".
  // The VALUE must be a value: `${VAR}`, `$VAR`, `<placeholder>`, `process.env.X`,
  // `os.environ[...]`, `session.accessToken,` are references, and a session that
  // quoted compose.yaml's own `OB1_LLM_API_KEY=${OB1_LLM_API_KEY:-}` refused
  // itself (twelfth review pass). A value with no digit is a placeholder or a
  // name — `your-api-key-goes-here`, `REPLACE_WITH_YOUR_KEY`, `********`,
  // `get_random_secret_key()` — each refused a whole session (thirteenth); a
  // real key without a digit is rare, and the entropy rule reads one of 32+.
  ["credential assignment", /(?<![A-Za-z0-9])(?:x-brain-key|MCP_ACCESS_KEY|OB1_[A-Z_]*KEY|OB1_SMOKE_KEY|(?:[A-Z0-9]+_)*(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret(?:[_-]?(?:access[_-]?)?key)?(?:[_-]?base)?)|(?:[A-Z0-9]+_)+token|bearer)\b["']?\s*[:=]\s*(?<q>["'`‘“«])?(?<v>(?!\$|<|%|\{|\[|process\.env\b|os\.environ\b|Deno\.env\b|import\.meta\.env\b|[A-Za-z_]\w*(?:\.\w+)+[,;)]?(?:\s|$))(?=[^\s"'`‘’“”«»]*\d)[^\s"'`‘’“”«»]{16,})/di],
  // A credential handed to a command by flag: `--api-key <value>` has no `=`
  // (twelfth review pass). Hyphenated compounds (`--client-secret`,
  // `--refresh-token`), `=` as well as a space; not a path, a `%VAR%`, or
  // docker's `--secret id=…,src=…` spec, and the value carries a digit
  // (thirteenth). A password's floor is six, as in the assignment rule.
  ["credential flag", /(?<![\w-])--(?:[a-z]+-)*(?:api-?key|access-?token|auth-?token|client-?secret|refresh-?token|token|secret(?:-?key)?)(?:\s+|=)(?<q>["'`‘“«])?(?<v>(?!\$|<|%|\[|[\/~.]|\w+=)(?=[^\s"'`‘’“”«»]*\d)[^\s"'`‘’“”«»]{16,})/di],
  ["password flag", /(?<![\w-])--(?:[a-z]+-)*password(?:\s+|=)(?<q>["'`‘“«])?(?<v>(?!\$|<|%|\[|[\/~.]|\w+=)[^\s"'`‘’“”«»]{6,})/di],
  // A password can be short — `POSTGRES_PASSWORD=hunter2` reached the brain under the 16-character floor (first review pass).
  ["password assignment", /\b(?:passw(?:or)?d|[A-Z_]*PASSWORD|PGPASSWORD)\b["']?\s*[:=]\s*(?<q>["'`‘“«])?(?<v>(?!\[)[^\s"'`‘’“”«»]{6,})/di],
  // Daemonic Brain's own access keys are 64 hex characters (keygen.ts), as are
  // their digests — told apart only by where they sit: a digest follows
  // `name:scope:` in MCP_ACCESS_KEYS or `sha256:`; a bare 64-hex run is a key
  // until proven otherwise (second review pass: the mixed-case rule let every
  // hex string by). …and not the everyday spellings of a digest:
  // `SHA256=<hex>`, `--sha256 <hex>`, `sha256: <hex>`,
  // and `sha256sum`'s own output shape, `<hex>  file` — two spaces then the name (fifth review pass:
  // an actionlint pin line refused a session; sixth: a lookbehind on the WORD sha256sum excused any
  // hex later on that line, a key included).
  // A work claim's token (migration 115, SMD-3598): `wc_` and 64 lowercase hex digits, which proves a claim to any
  // agent under the key that holds it. The 64-hex rule never sees it — its lookbehind refuses a run after `_` — and
  // the entropy rule skips hex (SMD-3615). Read on the raw text, a URL's included. An underscore beside it does not
  // excuse it (markdown's `_…_`, a `claim_` prefix), nor upper case (a model may echo one so): the token is the run.
  ["work-claim token", /(?<![A-Za-z0-9])wc\\?_[0-9a-f]{64}(?![0-9a-f])/i], // `wc\_` as markdown escapes it (SMD-3602)
  ["64-hex token (a raw key, or a digest out of its context)", /(?<![0-9a-f])(?<!:(?:read|write|capture|forward):)(?<!sha-?256\s*[:=]\s*)(?<!--sha-?256\s+)(?<![A-Za-z0-9_-])(?:0x)?[0-9a-f]{64}(?![0-9a-f])(?!(?<=(?:^|\n)[ \t]*(?:0x)?[0-9a-f]{64})\s{2}\S)/i],
];
const RESTRICTED = [
  ...PATTERNS.restricted.map(([source, flags, label]) => [new RegExp(source, flags), label] as const),
  ...SECRET_SHAPES.map(([name, re]) => [new RegExp(re.source, re.flags.replace("d", "")), name] as const),
];
const PERSONAL = PATTERNS.personal.map(([source, flags, label]) => [new RegExp(source, flags), label] as const);
/**
 * Characters that show nothing and hide inside a word: the soft hyphen, the combining grapheme joiner, the Hangul
 * fillers, the Mongolian vowel separator, zero-width and bidirectional controls, variation selectors, the BOM.
 */
const HIDDEN_RANGES: readonly (readonly [number, number])[] = [
  [0xad, 0xad], [0x34f, 0x34f], [0x115f, 0x1160], [0x180e, 0x180e], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0],
];
const HIDDEN = new RegExp(`[${HIDDEN_RANGES.map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join("")}]`, "g");

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

/** A tier in SQL as tierRank reads it: lower-cased, JavaScript's white space (its trim's: the no-break and Unicode spaces and the BOM too) stripped from both ends. */
export const sqlTier = (expr: string) => `lower(regexp_replace(${expr}, '^[[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$', '', 'g'))`;

export const RANK: Readonly<Record<Tier, number>> = { standard: 0, personal: 1, restricted: 2 };
export const TIER_OF_RANK: readonly Tier[] = ["standard", "personal", "restricted"];
