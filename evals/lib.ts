/**
 * lib.ts — the embedding call every harness was reimplementing, and drifting on.
 *
 * Four harnesses had their own `embed`, and by the time anyone looked they were
 * sending three DIFFERENT query instructions:
 *
 *   eval-real.ts      "Given a search query, retrieve the issue that matches it"
 *   eval-retrieval.ts "Given a search query, retrieve the note that answers it"
 *   eval-longctx.ts   "Given a question, retrieve the note that answers it"
 *
 * None of which was what the server sends. That is not cosmetic — the same model
 * scores 0.938 prompted and 0.860 bare on the retrieval corpus, so the instruction
 * text is a bigger lever than most of the models being compared. Numbers produced
 * under three different prompts were never comparable to each other, and none of
 * them measured production.
 *
 * The templates now come from `db/config.mjs`, the table the SERVER uses, so a
 * benchmark cannot flatter a model the server prompts differently.
 */

import { EMBEDDING_PROMPTS } from "../db/config.mjs";

export const EVAL_BASE =
  process.env.OB1_EVAL_BASE ?? process.env.OLLAMA_BASE ?? "http://127.0.0.1:11434/v1";

const KEY = process.env.OB1_EVAL_KEY ?? process.env.OPENROUTER_API_KEY ?? "";
export const EVAL_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}),
};

export type Spec = {
  /** Model name as the provider knows it, suffixes stripped. */
  name: string;
  /** Requested output width, for Matryoshka truncation. */
  dims?: number;
  /** `auto` uses the server's table; `bare` sends nothing; `gemma` is a one-off. */
  mode: "auto" | "bare" | "gemma";
};

/**
 * `model[!bare|!gemma][@dims]`.
 *
 * `!bare` forces prompting off, which is how the cost of omitting it was measured.
 * `!gemma` applies EmbeddingGemma's documented format, which is deliberately NOT
 * in the server's table — it is worth +0.002, so the server does not send it, and
 * the flag exists only so that fact stays reproducible.
 * `!instruct` is accepted and ignored: prompting is now the default for any model
 * the server prompts, so the flag is redundant rather than wrong.
 */
export function parseSpec(model: string): Spec {
  const [head, dimsRaw] = model.split("@");
  const mode: Spec["mode"] = head.endsWith("!bare")
    ? "bare"
    : head.endsWith("!gemma")
      ? "gemma"
      : "auto";
  return {
    name: head.replace(/!(instruct|gemma|bare)$/, ""),
    dims: dimsRaw ? Number(dimsRaw) : undefined,
    mode,
  };
}

/** Apply whichever prompt the spec calls for. Documents and queries differ. */
export function applyPrompt(spec: Spec, input: string, isQuery: boolean): string {
  if (spec.mode === "bare") return input;
  if (spec.mode === "gemma") {
    return isQuery ? `task: search result | query: ${input}` : `title: none | text: ${input}`;
  }
  const tpl = (EMBEDDING_PROMPTS as Record<string, { query: string; document: string } | undefined>)[
    spec.name
  ];
  if (!tpl) return input;
  return isQuery ? tpl.query.replace("{q}", input) : tpl.document.replace("{d}", input);
}

/** One embedding. `isQuery` selects the query template over the document one. */
export async function embed(model: string, input: string, isQuery = false): Promise<number[]> {
  const spec = parseSpec(model);
  const r = await fetch(`${EVAL_BASE}/embeddings`, {
    method: "POST",
    headers: EVAL_HEADERS,
    body: JSON.stringify({
      model: spec.name,
      input: applyPrompt(spec, input, isQuery),
      ...(spec.dims ? { dimensions: spec.dims } : {}),
    }),
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 100)}`);
  return ((await r.json()) as { data: [{ embedding: number[] }] }).data[0].embedding;
}

/**
 * Cosine similarity. Written out rather than normalised-then-dotted because the
 * harnesses compare raw provider output, and not every provider returns unit
 * vectors — Ollama does not normalise after Matryoshka truncation.
 */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
