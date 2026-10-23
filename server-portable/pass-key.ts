/**
 * A consolidation pass's key (SMD-3248): the one rule every door reads it by —
 * the tool's and the REST core's `judge_key` input (core/schemas.ts), the reply
 * value's guard (render.ts), and `db/consolidate.ts --key` and `--status` — and
 * how a line of text shows a recorded one.
 *
 * consolidate.ts and consolidate-decide.ts build a key as
 * `consolidate:<model>@p<prompt>`, or under decide mode
 * `consolidate:<decider>+<writer>@p<prompt>d<decide version>`, a model name in
 * Ollama's, Hugging Face's and Cloudflare's characters (letters, digits, `.`,
 * `_`, `:`, `/`, `@`, `-`). A key is anyone's to record, though — 029's door
 * takes any non-empty text — so a reader holds it to this rule rather than
 * trusting it.
 */

/**
 * A pass key: 1–200 of a pass key's own characters, the first a letter or a
 * digit. No space, so no sentence — what a reply's value may carry; no control
 * character; none a shell reads (`$ ( ) ; | & > \``), so a key `--status`
 * offers for `--key` can be pasted unquoted (review pass 3: one holding `$(…)`
 * ran in the operator's shell); and no leading `-`, which the CLI's parser
 * reads as a flag (review pass 4). One rule for input, value and selection
 * (review pass 4: a full-shape guard beside it nulled keys the input took).
 */
export const PASS_KEY_CHARS = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

/** Whether a key is one every door takes: PASS_KEY_CHARS. */
export const selectableKey = (key: string): boolean => PASS_KEY_CHARS.test(key);

/**
 * A recorded key as a line of text shows it: whole when it is a pass key, else
 * quoted with everything outside printable ASCII escaped (`\uXXXX`) and cut at
 * 200 code points, the cut marked outside the quotes — the consistency
 * checker's shownName rule. Escaped, not stripped (review pass 4: stripping
 * inside quotes printed `" consolidate:real@p4 "`, a bell or a bidi override
 * after it exactly as the real key), so a space, a line break, a zero-width or
 * look-alike character shows as itself and no key passes for another or for
 * the line's own words.
 */
export function judgeKeyText(key: string): string {
  if (selectableKey(key)) return key;
  const points = [...key];
  const cut = points.length > 200;
  const shown = JSON.stringify((cut ? points.slice(0, 200) : points).join("")).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return cut ? `${shown}…` : shown;
}
