/**
 * A consolidation pass's key (SMD-3248): the rules every door reads it by,
 * in one place — the tool's and the REST core's `judge_key` input
 * (core/schemas.ts), the reply value's guard (render.ts) and
 * `db/consolidate.ts --key` and `--status`.
 *
 * consolidate.ts and consolidate-decide.ts build a key as
 * `consolidate:<model>@p<prompt>`, or under decide mode
 * `consolidate:<decider>+<writer>@p<prompt>d<decide version>`, a model name in
 * Ollama's, Hugging Face's and Cloudflare's characters (letters, digits, `.`,
 * `_`, `:`, `/`, `@`, `-`). A key is anyone's to record, though — 029's door
 * takes any non-empty text — so a reader holds it to these rules rather than
 * trusting it.
 */

/**
 * A key a selection takes: 1–200 of a pass key's own characters. No space, no
 * control character, and none a shell reads (`$ ( ) ; | & > \``), so a key
 * `--status` offers for `--key` can be pasted unquoted (review pass 3: one
 * holding `$(…)` ran in the operator's shell).
 */
export const PASS_KEY_CHARS = /^[A-Za-z0-9._:/@+-]{1,200}$/;

/**
 * A pass key's shape, for the reply value's guard: held to it, a key carries
 * no sentence (a key of another shape — a raw recording's, a model named with
 * `+` — reads null there, its text in the reply's).
 */
export const JUDGE_KEY = /^consolidate:[A-Za-z0-9._:/@-]{1,120}(?:\+[A-Za-z0-9._:/@-]{1,120})?@p\d{1,4}(?:d\d{1,4})?$/;

/** Whether a selection can take this key: PASS_KEY_CHARS. */
export const selectableKey = (key: string): boolean => PASS_KEY_CHARS.test(key);

/**
 * A recorded key as a line of text shows it: whole when a selection can take
 * it, else quoted after the replies' cleaner (`snip`, render.ts's snipText at
 * 200) — a key holding spaces cannot pass for a line's own words ("…, 500
 * judged by <another key>", review pass 3).
 */
export function judgeKeyText(key: string, snip: (text: string, max: number) => string): string {
  return selectableKey(key) ? key : JSON.stringify(snip(key, 200));
}
