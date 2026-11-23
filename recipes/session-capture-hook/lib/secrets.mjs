/**
 * lib/secrets.mjs — the session hook's secret scan and its redaction of a text
 * (SMD-2127; moved here by SMD-4338): the named patterns, the entropy rule, a
 * hit's span, a key block grown over its lines, the marker a span becomes, and
 * OB1_CAPTURE_ON_SECRET read as a mode. It imports nothing: the agent runner's
 * gate and the brain's sensitivity table read the same patterns. An episode's
 * redaction, which renders the summary, stays with the summary.
 */

// ── Secret scan ──────────────────────────────────────────────────────────────

function entropyBits(token) {
  const counts = new Map();
  for (const ch of token) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / token.length; h -= p * Math.log2(p); }
  return h;
}

/**
 * The span a high-entropy token's redaction takes (SMD-2127; its first review
 * pass found the token a proper subset of the secret, so a fragment was sent
 * where the episode used to be refused). The token is widened over `/`-joined
 * runs that read as more of it — base64 carries `/`, which the token class
 * leaves out so a path splits into segments — a run of four or more with a
 * digit or a capital and not word-shaped, so a path's `Projects/x/` beside a
 * token stays. Then, `=` and `_` being in the class, `LINEAR_API_KEY=lin_api_…`
 * is ONE token: the span starts after a snake-case `NAME=` — an underscore
 * required, since a base64 body carries `=` too and never `_` — so the marker
 * keeps the name, as the assignment rule's does. The judgement is the token's
 * as matched; only the span moves.
 */
function tokenSpan(text, at, end) {
  const RUN = /[A-Za-z0-9+_=-]/;
  // A run reads as more of the token when it is four or more, carries a digit
  // or both cases, has no hyphen (`SMD-2127`) and is not word-shaped —
  // `HEAD`, `README` are words, not base64 (second review pass).
  const tokenish = (run) => run.length >= 4 && !run.includes("-") && (/[0-9]/.test(run) || (/[a-z]/.test(run) && /[A-Z]/.test(run))) && (run.match(/[a-z]{3,}/g) ?? []).join("").length / run.length < 0.6;
  const leftRun = (slash) => { let i = slash; while (i > 0 && RUN.test(text[i - 1])) i--; return i; };
  const rightRun = (slash) => { let i = slash + 1; while (i < text.length && RUN.test(text[i])) i++; return i; };
  // A run that does not read as token joins too when the run beyond it does:
  // a base64 body's own short or lowercase run sits between two longer ones,
  // and stopping at it left a fragment (second review pass: 2% of random keys).
  for (;;) {
    if (text[at - 1] !== "/") break;
    const i = leftRun(at - 1);
    if (tokenish(text.slice(i, at - 1))) { at = i; continue; }
    if (text[i - 1] === "/") { const j = leftRun(i - 1); if (tokenish(text.slice(j, i - 1))) { at = j; continue; } }
    break;
  }
  for (;;) {
    if (text[end] !== "/") break;
    const i = rightRun(end);
    if (tokenish(text.slice(end + 1, i))) { end = i; continue; }
    if (text[i] === "/") { const j = rightRun(i); if (tokenish(text.slice(i + 1, j))) { end = j; continue; } }
    break;
  }
  const t = text.slice(at, end);
  const eq = t.indexOf("=");
  if (eq > 0 && t.length - eq - 1 >= 16 && /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/.test(t.slice(0, eq))) at += eq + 1;
  return [at, end];
}

/** The patterns, named so a refusal can say WHAT kind of thing it saw without showing it. */
export const SECRET_PATTERNS = [
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
  // with `[` is a placeholder — `[YOUR_API_KEY]`, `[redacted]`, the hook's
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
  // SMD-4542: a second keyword is no value (`password: password = <it>` takes the second's); a getter's call is
  // stepped over to its default (`os.environ.get("X", "<it>")`); and after an opening quote a value that reads as a
  // token — a digit in it, no whole word of three letters or more — runs to its closing quote on the line, spaces and
  // all, though its first word is short (`password="Kp7m Wq2z R9x"`).
  // - Review pass 1: `${…}` stays a value, as before, since an exclusion sent `${PG_PW:-<it>}`'s default; and quoted
  //   prose or a placeholder (`"Enter your password"`, `"<your password>"`) is read as before, not blanked.
  // - Review pass 2: nor does the quoted branch start a value at a placeholder's `{`, `<` or `$` (`"{{ db_pass_2 }}"`,
  //   `"<pw 1>"`), which db/sensitivity.ts's own password rule skips too.
  // - Review pass 3: a bare reference (`process.env.X`, `os.environ[…]`, `getenv(…)`) stays a value, as before.
  //   Excluding it left `password = process.env.X || "<it>"` with no finding, so refuse sent it whole, the model's
  //   excerpt carried it, and the brain read `PGPASSWORD=process.env.X` standard. The getter's receiver is dotted names
  //   of letters (`os.`, `process.`), so a password glued onto the getter (`<it>getenv(`) is not taken for one.
  // - Review pass 4: a getter's call whose default is already a whole marker, the argument's last, is no value, or the
  //   second scan would find the call once the first had blanked its default.
  // - Review pass 5: the step-over applies only when the default ends the argument, a literal or a name then `,` or
  //   `)`. A nested call or an expression there (`getenv("A", getenv("B"))`, `"<it>" + SUFFIX`) is read as before, the
  //   outer call blanked, not half-blanked into a line the second scan would refuse.
  ["password assignment", /\b(?:passw(?:or)?d|[A-Z_]*PASSWORD|PGPASSWORD)\b["']?\s*[:=]\s*(?:(?:[A-Za-z_]+\.)*(?:environ\.get|getenv|env\.get|ENV\.fetch)\s*\(\s*["'`][^"'`\n]*["'`]\s*,\s*(?=["'`‘“«][^"'`‘’“”«»\n]*["'`’”»]\s*[,)]|[^\s"'`‘’“”«»,()\[\]]+\s*[,)]))?(?<q>["'`‘“«])?(?<v>(?!\[|(?:passw(?:or)?d|[A-Z_]*PASSWORD|PGPASSWORD)\b["']?\s*[:=]|(?:[A-Za-z_]+\.)*(?:environ\.get|getenv|env\.get|ENV\.fetch)\s*\(\s*["'`][^"'`\n]*["'`]\s*,\s*["'`‘“«]?\[redacted:[^\]\n]*\]["'`’”»]?\s*[,)])(?:(?<=["'`‘“«])(?=[^"'`‘’“”«»\n]*\d)(?![^"'`‘’“”«»\n]*\b[a-z]{3,}\b)[^\s"'`‘’“”«»{<$][^"'`‘’“”«»\n]{5,}(?=["'`’”»])|[^\s"'`‘’“”«»]{6,}))/di],
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

/** The patterns that read the URL-blanked text: shapes, not prefixes. */
const URL_BLIND = new Set(["64-hex token (a raw key, or a digest out of its context)"]);
/** Each pattern once more with the `g` flag, for matchAll — the table's own objects stay stateless for exec. */
const GLOBAL = new Map();
const globalOf = (re) => { let g = GLOBAL.get(re); if (!g) { g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`); GLOBAL.set(re, g); } return g; };

/**
 * Scan a text. Returns [] when clean, else one entry per finding: the pattern's
 * name and where — `at`, a 0-based character offset, to `end` — never the
 * matched text; the FIRST match of each pattern, or every match with
 * `{ every: true }`, which a redaction needs (SMD-2127). Besides
 * the patterns: a 32+ character token of mixed case and digits with high
 * entropy — a key or token by shape. What is NOT a token: hex (a sha, a digest, a uuid —
 * no mixed case), a path (split at its slashes), a URL's path or query (a
 * document id), a base64 data URI, a file name, and a word-shaped identifier
 * (`getUserAccountBalanceById2026Version3`: mostly lowercase runs). The bar is
 * 4.5 bits per character under 48 characters and 4.2 from there — a real key
 * measures 5 and up; an identifier 4.4 (first review pass: six realistic
 * false positives, each of which would have refused a whole session). `skip`
 * lists `[at, end)` spans another scan has judged whole: a hit wholly inside one
 * is passed over (SMD-4502).
 */
export function scanForSecrets(text, { every = false, skip = [] } = {}) {
  const findings = [];
  // URLs and base64 payloads blanked in place (offsets kept) for the shape
  // rules — the 64-hex rule and the token scan: a hex id in a URL's path (a
  // sha256 repository's commit, a blob) is an address, not a pasted key (third
  // review pass). The named patterns run over the full text — a key inside a
  // URL's query is caught by its prefix or by the `?key=` rule above.
  const blanked = text
    .replace(/\bhttps?:\/\/[^\s)>\]"']+/gi, (u) => " ".repeat(u.length))
    .replace(/\bbase64,[A-Za-z0-9+/=]+/g, (b) => " ".repeat(b.length));
  for (const [name, re] of SECRET_PATTERNS) {
    for (const m of (URL_BLIND.has(name) ? blanked : text).matchAll(globalOf(re))) {
      // The span: the `v` group's indices where the rule names a value, else the match.
      let [at, end] = m.indices?.groups?.v ?? [m.index, m.index + m[0].length];
      if (m.groups?.q) {
        // The rule consumed an OPENING quote, so the value runs to its close,
        // spaces included — `password: "correct horse battery"` — where the
        // class stopped at the first space and the tail was sent (second
        // review pass). No close on the line: the class's stop stands.
        const close = m.input.indexOf(QUOTE_CLOSE[m.groups.q] ?? m.groups.q, end), line = m.input.indexOf("\n", end);
        if (close !== -1 && (line === -1 || close < line)) end = close;
      } else if (m.indices?.groups?.v) {
        // A value class of `[^\s"']` runs to the next space: a closing bracket,
        // backtick or full stop after the value is the sentence's, not the
        // secret's, and stays in the text — two characters at most, `x).`; a
        // longer run is the value's own (first and second review passes).
        for (let n = 0; n < 2 && end > at + 1 && /[.,;:)\]}`>]/.test(m.input[end - 1]); n++) end--;
      }
      // A hit wholly inside a span another scan judged is that scan's (SMD-4502): passed over, so the rule's next
      // match, outside it, is still this scan's first.
      if (judgedElsewhere({ at, end }, skip)) continue;
      findings.push({ reason: name, at, end });
      if (!every) break;
    }
  }
  for (const m of blanked.matchAll(/[A-Za-z0-9+_=-]{32,}/g)) {
    const t = m[0];
    if (!/[a-z]/.test(t) || !/[A-Z]/.test(t) || !/[0-9]/.test(t)) continue;
    if (/^[\w.-]+\.(?:md|ts|mjs|js|json|sql|yml|yaml|txt|sh)$/.test(t)) continue; // a file name
    const wordish = (t.match(/[a-z]{3,}/g) ?? []).join("").length / t.length;
    if (wordish >= 0.6) continue; // an identifier, not a key
    if (entropyBits(t) < (t.length >= 48 ? 4.2 : 4.5)) continue;
    const [at, end] = tokenSpan(blanked, m.index, m.index + t.length); // the span, the token widened and its name dropped (SMD-2127)
    if (judgedElsewhere({ at, end }, skip)) continue;
    findings.push({ reason: "high-entropy token", at, end });
  }
  return findings.sort((a, b) => a.at - b.at || a.end - b.end);
}

// ── Redaction (SMD-2127) ─────────────────────────────────────────────────────

/** How a hit is met: `redact` (the default) blanks the span and sends the rest; `refuse` drops the episode, as every hit was met before SMD-2127. */
export const SECRET_MODES = ["redact", "refuse"];
/**
 * OB1_CAPTURE_ON_SECRET as a mode, or an error naming what it takes — read once
 * by main() for the hook path, --dry-run and --check: a misspelling takes
 * neither mode in silence (a hook that took `refuse` for a typo would drop
 * sessions its operator meant to keep; one that took `redact` would send what
 * its operator meant to hold back).
 */
export function secretMode(env = process.env) {
  const raw = env.OB1_CAPTURE_ON_SECRET;
  if (raw === undefined || raw === "") return { mode: "redact" };
  if (SECRET_MODES.includes(raw)) return { mode: raw };
  return { error: `OB1_CAPTURE_ON_SECRET takes ${SECRET_MODES.join(" or ")}, not "${raw}"` };
}
/** A typographic quote or a guillemet closes with its partner; the straight quotes and the backtick with themselves (third review pass: pass 2's extension knew `"` and `'`, and a value in curly quotes still sent its tail). */
const QUOTE_CLOSE = { "‘": "’", "“": "”", "«": "»" };
/** The reasons whose span is KEY MATERIAL — what a block of base64 lines is made of. */
const KEY_MATERIAL = new Set(["high-entropy token", "private key block", "64-hex token (a raw key, or a digest out of its context)"]);
/**
 * A whitespace-delimited run that reads as a line of a key block: base64
 * characters alone, thirty-two or more (or four or more ending in `=`, a
 * block's padded last line), with a digit or both cases, and not word-shaped
 * — a long word or a camel-case identifier beside a token is not key material.
 */
const blockLine = (run) => /^[A-Za-z0-9+/=]+$/.test(run) && (run.length >= 32 || (run.length >= 4 && run.endsWith("="))) && (/[0-9]/.test(run) || (/[a-z]/.test(run) && /[A-Z]/.test(run))) && (run.match(/[a-z]{3,}/g) ?? []).join("").length / run.length < 0.6;
/**
 * A run that is contiguous key material — base64 characters alone, four or
 * more, with a digit or both cases. NO word-shape guard (fifth review pass): a
 * real key line can read word-shaped by chance, and a run adjacent to a
 * CONFIRMED block line is key material whatever its shape — contiguity beats
 * the per-run heuristic, and the coarse backstop must not share the detector's
 * word-shape blind spot. Taken only once a full block line is in hand, so a
 * lone word is never absorbed.
 */
const contiguousKey = (run) => run.length >= 4 && /^[A-Za-z0-9+/=]+$/.test(run) && (/[0-9]/.test(run) || (/[a-z]/.test(run) && /[A-Z]/.test(run)));
/**
 * A key-material span grown over the block it sits in. The hit's own
 * whitespace-run is re-taken when it reads as a block line — the `/tail`
 * `tokenSpan` left out of a bare token to spare a path — then the runs on
 * either side that read as block lines, and one short base64 run at each end.
 * A block of base64 — a PEM body, PGP armor, a wrapped blob — was blanked run
 * by run, and a `/` at the span's edge (base64 carries `/`, which the token
 * class leaves out) stopped the growth, so an interior line with no run of
 * thirty-two, or a short trailing line, went out verbatim, the second scan
 * clean, where the episode used to be refused (third and fourth review
 * passes). A run that is not a block line — a token in a path or a sentence, a
 * `NAME=value` — keeps its tight span; a block split by such a run leaves key
 * material the growth cannot reach; a span that ends up crossing a newline is
 * a multi-line blob the caller REFUSES (SMD-2127 scope call), so the block need
 * not be blanked precisely — only detected.
 */
function growBlock(text, at, end) {
  const runStart = (i) => { let j = i; while (j > 0 && !/\s/.test(text[j - 1])) j--; return j; };
  const runEnd = (i) => { let j = i; while (j < text.length && !/\s/.test(text[j])) j++; return j; };
  let anchored = false;
  {
    // The hit's own LINE, snapped to only when it is a single block-shaped run
    // — a wrapped blob's line, its `/tail` included — never a path or a
    // sentence, which carry spaces or short word segments (fourth review pass:
    // a run-boundary snap swallowed `/Users/.../` and a trailing `/HEAD`).
    const ls = text.lastIndexOf("\n", at - 1) + 1;
    let le = text.indexOf("\n", end); if (le === -1) le = text.length;
    const line = text.slice(ls, le), trimmed = line.trim();
    if (trimmed && !/\s/.test(trimmed) && blockLine(trimmed)) { at = ls + (line.length - line.trimStart().length); end = at + trimmed.length; anchored = true; }
  }
  const grow = (up) => {
    let full = anchored;
    for (;;) {
      const ws = up ? /\s+$/.exec(text.slice(0, at)) : /^\s+/.exec(text.slice(end));
      if (!ws) break;
      const s = up ? runStart(at - ws[0].length) : end + ws[0].length;
      const e = up ? at - ws[0].length : runEnd(end + ws[0].length);
      const run = text.slice(s, e);
      if (blockLine(run)) { if (up) at = s; else end = e; full = true; continue; }
      if (full && contiguousKey(run)) { if (up) at = s; else end = e; continue; }
      break;
    }
  };
  grow(true); grow(false);
  return [at, end];
}
/** Whether a finding lies wholly inside one of the `[at, end)` spans another scan has judged (SMD-4502). */
export const judgedElsewhere = (f, skip) => skip.some(([at, end]) => f.at >= at && f.end <= end);
/** The marker a span becomes: what kind of thing was there — never how long, never what. */
export const redactionMarker = (reasons) => `[redacted:${reasons.join(", ")}]`;
/**
 * Every span the scan finds, blanked in place. Overlapping and adjacent spans
 * are ONE — the live case was a credential assignment, a linear key and a
 * high-entropy token at one site — sorted by start and replaced RIGHT TO LEFT,
 * so an earlier offset stays true after a later span has changed the length.
 * Returns { text, spans, blocks }: `spans` are the single-line redactions taken,
 * each its reasons and its offset in the text returned (where its marker sits);
 * `blocks` are the spans that cross a newline — a multi-line key blob the caller
 * refuses rather than trust a precise blanking (SMD-2127). Nothing of the match.
 * `skip` lists `[at, end)` spans of the text another scan has already judged
 * whole: a finding wholly inside one is left as it is (SMD-4502, the summary's
 * listed prompts and title, which the scan of each whole prompt judged).
 */
export function redactSecrets(text, { skip = [] } = {}) {
  const spans = [];
  // Key material grown over its block first (third review pass). Growth never
  // reorders: findings come sorted by start; a key-material span grows left
  // only over base64 block lines, and any earlier finding in that block is key
  // material too and grows to the same block start, while a named hit's
  // `name=value` run is not a block line and stops the growth — so the array
  // stays sorted for the coalescing below.
  const found = scanForSecrets(text, { every: true, skip }).map((f) => { if (!KEY_MATERIAL.has(f.reason)) return f; const [at, end] = growBlock(text, f.at, f.end); return { ...f, at, end }; });
  for (const f of found) {
    const last = spans[spans.length - 1];
    if (last && f.at <= last.end) { last.end = Math.max(last.end, f.end); if (!last.reasons.includes(f.reason)) last.reasons.push(f.reason); continue; }
    spans.push({ reasons: [f.reason], at: f.at, end: f.end });
  }
  // A span crossing a newline is MULTI-LINE key material — a pasted key block.
  // The scope call (SMD-2127): a blob is REFUSED, not redacted, since a precise
  // blanking of a block leaked over four review passes (a fragment the second
  // scan could not see); only a secret confined to one line is blanked and
  // sent. Marked before the offsets shift; the span is blanked here too (so the
  // text a bug might still send is best-effort clean), but a block makes the
  // caller refuse.
  for (const span of spans) span.multiline = text.slice(span.at, span.end).includes("\n");
  let out = text;
  for (let i = spans.length - 1; i >= 0; i--) out = out.slice(0, spans[i].at) + redactionMarker(spans[i].reasons) + out.slice(spans[i].end);
  // The spans as they sit in the text RETURNED — each marker's place, where a
  // reader of the blanked text looks — an earlier marker having moved every
  // later one (second review pass: the offsets were the input's).
  let delta = 0;
  for (const span of spans) { const taken = span.end - span.at; span.at += delta; span.end = span.at + redactionMarker(span.reasons).length; delta += span.end - span.at - taken; }
  return { text: out, spans: spans.filter((x) => !x.multiline), blocks: spans.filter((x) => x.multiline) };
}
/**
 * `<reason> at char N in <source>` per span, for the message, the log and the
 * dry run — one entry per reason and source, its offsets listed to three and
 * counted past that, eight entries then a count (first review pass: a password
 * in each of thirty prompts was thirty identical entries and a 1.4 KB line).
 * The offset is into the prompt, the outcome or the title named — `--dry-run`
 * prints each — or into the text as rendered.
 */
export function describeRedactions(rs) {
  const groups = new Map();
  for (const r of rs) { const k = `${r.reason}\u0000${r.in}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r.at); }
  const entries = [...groups].map(([k, ats]) => { const [reason, place] = k.split("\u0000"); return `${reason} at char${ats.length === 1 ? "" : "s"} ${ats.slice(0, 3).join(", ")}${ats.length > 3 ? ` and ${ats.length - 3} more` : ""} in ${place}`; });
  return entries.slice(0, 8).join("; ") + (entries.length > 8 ? `; and ${entries.length - 8} more` : "");
}
const countRedactions = (n) => `${n} redaction${n === 1 ? "" : "s"}`;

export { countRedactions };
