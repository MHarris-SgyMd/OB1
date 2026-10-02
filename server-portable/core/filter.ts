// The metadata filter the search tools take (SMD-1490) and the two writer keys
// folded into it (SMD-1726): validation over a caller's input, transport-free.
// A shape the boundary refuses throws FilterError, which the search operations
// return as a REFUSED_FILTER refusal rather than a jsonb the store would run.

/** The caps on a filter: top-level keys, and its UTF-8 size as JSON. */
export const FILTER_MAX_KEYS = 20;
export const FILTER_MAX_BYTES = 4096;

/** A filter the boundary refuses; the message says which rule, in the words the reply has always carried. */
export class FilterError extends Error {}

/**
 * Normalise and bound a metadata filter from a search tool (SMD-1490). Absent,
 * null or empty is `{}` (unfiltered). Throws FilterError on a shape the
 * boundary should refuse — a non-object, a nested object, a non-scalar value,
 * or a filter over the key/size caps — so the operation refuses it rather than
 * hand jsonb something the store would run.
 */
export function parseFilter(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new FilterError("filter must be an object of metadata keys");
  const isScalar = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > FILTER_MAX_KEYS) throw new FilterError(`filter has too many keys (max ${FILTER_MAX_KEYS})`);
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    if (Array.isArray(v)) {
      if (!v.every(isScalar)) throw new FilterError(`filter.${k} must be an array of strings, numbers or booleans`);
    } else if (!isScalar(v)) {
      throw new FilterError(`filter.${k} must be a scalar or an array of scalars — nested objects are not accepted`);
    }
    out[k] = v;
  }
  // UTF-8 bytes, not JSON.stringify().length (UTF-16 code units) — multibyte
  // content (CJK, accents) is ~2x its code-unit count, so the code-unit check let
  // a filter past ~2x the byte bound the error names. TextEncoder is Workers-safe
  // where Buffer is not (SMD-1953).
  if (new TextEncoder().encode(JSON.stringify(out)).length > FILTER_MAX_BYTES) throw new FilterError(`filter is too large (max ${FILTER_MAX_BYTES} bytes)`);
  return out;
}

// SMD-1726: who wrote a thought's current text, on the read path. Migration 050
// stamps two reserved metadata keys from the write's key — `actor_kind`
// (ob1_agents.kind: operator | agent | ingested) and `actor_name` (the key's
// name) — so "only what the operator said" is the same jsonb containment every
// other filter key takes, on 014's route, and the hit can say who wrote it.
/** The three words the key registry holds (migration 046, `ob1_agents.kind`); `said_by` takes one. */
export const SAID_BY = ["operator", "agent", "ingested"] as const;

/**
 * `said_by` and `actor` folded into the metadata filter (SMD-1726): the two
 * are the keys migration 050 stamps, so the store, the query log and the plan
 * see one filter and the arguments are sugar over it. A `filter` that names
 * the same key with another value is a caller contradicting itself, refused
 * at the boundary as parseFilter refuses a nested object.
 */
export function withActorFilter(filter: Record<string, unknown>, saidBy: string | undefined, actor: string | undefined): Record<string, unknown> {
  const out = { ...filter };
  // The stamp trims the key's name (050), so the argument is trimmed here too —
  // a pasted "op-key " must find the rows op-key wrote (second review pass).
  for (const [key, value, arg] of [["actor_kind", saidBy, "said_by"], ["actor_name", actor?.trim() || undefined, "actor"]] as const) {
    if (value === undefined) continue;
    if (key in out && out[key] !== value) throw new FilterError(`${arg} is "${value}" but filter.${key} is ${JSON.stringify(out[key])} — pass one of the two`);
    out[key] = value;
  }
  // The caps are the filter's, so they hold over the folded object too (first
  // review pass: a 20-key filter plus the two was 22 keys the store ran).
  return parseFilter(out);
}
