/**
 * chunk.ts — split a long capture into overlapping windows that each embed whole.
 *
 * The problem this solves is measured in evals/README.md: an embedding provider
 * embeds one request in one batch, and Ollama's default batch is 2048 tokens. A
 * longer capture is silently cut, so its second half is absent from the vector and
 * `search_thoughts` cannot find the note by anything said there. The text is
 * stored fine; only its searchability is lost.
 *
 * Two things this deliberately does NOT do:
 *
 *   NO TOKENISER. Pulling one in would tie the server to a specific model family
 *   and add a dependency to a file that has to build for Cloudflare Workers. The
 *   estimate below is intentionally pessimistic instead — over-estimating tokens
 *   produces smaller chunks, which is the safe direction to be wrong in.
 *
 *   NO CHUNKING OF SHORT CONTENT. Nearly every thought is short — both corpora
 *   measured in evals/ average under 500 tokens — and splitting those would double
 *   the storage and the write latency to solve a problem they do not have. Content
 *   that fits in one window returns no chunks at all.
 */

/**
 * Pessimistic token estimate. English prose runs about 4 characters or 1.3 tokens
 * per word; code, URLs and non-Latin scripts run denser. Taking the larger of the
 * two estimates errs toward smaller chunks, and a chunk that is smaller than it
 * needed to be costs a little recall, where one that is larger than the batch is
 * silently truncated — the exact failure being fixed.
 */
export function estimateTokens(text: string): number {
  const chars = text.length / 4;
  const words = (text.trim().match(/\S+/g)?.length ?? 0) * 1.3;
  return Math.ceil(Math.max(chars, words));
}

export type ChunkOptions = {
  /**
   * Target tokens per chunk. The default leaves real headroom under Ollama's
   * 2048-token batch, because the estimate above is an estimate: a chunk that
   * overshoots is truncated silently, which is the bug, not a degradation.
   * Retrieval was also measured perfect at 2000 tokens and at chance by 4000, so
   * there is nothing to gain from crowding the ceiling.
   */
  maxTokens?: number;
  /**
   * Overlap between consecutive chunks. A sentence that straddles a boundary
   * otherwise appears in neither chunk with its context intact, and the
   * conclusion of a long note is exactly the kind of sentence that lands near
   * one.
   */
  overlapTokens?: number;
};

export const DEFAULT_MAX_TOKENS = 1200;
export const DEFAULT_OVERLAP_TOKENS = 150;

/**
 * Split on the largest natural boundary that fits: paragraphs first, then
 * sentences, then whitespace. Splitting mid-sentence produces windows that embed
 * to something meaning neither half, so it is the last resort rather than the
 * default.
 */
function segments(text: string): string[] {
  const paras = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const out: string[] = [];
  for (const para of paras) {
    if (estimateTokens(para) <= DEFAULT_MAX_TOKENS) { out.push(para.trim()); continue; }
    // Keep the terminator with the sentence it ends.
    const sentences = para.match(/[^.!?]+[.!?]+[\s"')\]]*|[^.!?]+$/g) ?? [para];
    for (const s of sentences) {
      if (estimateTokens(s) <= DEFAULT_MAX_TOKENS) { out.push(s.trim()); continue; }
      // A single sentence over the limit — unpunctuated prose, a pasted table, a
      // minified blob. Fall back to words so it is still bounded.
      const words = s.split(/\s+/);
      let buf: string[] = [];
      for (const w of words) {
        buf.push(w);
        if (estimateTokens(buf.join(" ")) >= DEFAULT_MAX_TOKENS) { out.push(buf.join(" ")); buf = []; }
      }
      if (buf.length) out.push(buf.join(" "));
    }
  }
  return out.filter((s) => s.length > 0);
}

export type Chunk = { index: number; content: string };

/**
 * Returns [] when the content fits in one window — the caller then stores a single
 * whole-content embedding exactly as before, and no chunk rows are written.
 */
export function chunkContent(content: string, opts: ChunkOptions = {}): Chunk[] {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlapTokens = Math.min(opts.overlapTokens ?? DEFAULT_OVERLAP_TOKENS, Math.floor(maxTokens / 2));

  if (estimateTokens(content) <= maxTokens) return [];

  const segs = segments(content);
  const chunks: string[] = [];
  let buf: string[] = [];

  const flush = (): void => {
    if (!buf.length) return;
    chunks.push(buf.join(" "));
    // Carry the tail of this chunk into the next one, so a boundary-straddling
    // sentence survives in at least one window with its neighbours.
    const carry: string[] = [];
    for (let i = buf.length - 1; i >= 0; i--) {
      carry.unshift(buf[i]);
      if (estimateTokens(carry.join(" ")) >= overlapTokens) break;
    }
    // Never carry the whole chunk — that would not advance and would loop.
    buf = carry.length < buf.length ? carry : [];
  };

  for (const seg of segs) {
    const candidate = buf.length ? `${buf.join(" ")} ${seg}` : seg;
    if (buf.length && estimateTokens(candidate) > maxTokens) flush();
    buf.push(seg);
    // A segment that alone exceeds the limit cannot be helped by flushing again.
    if (estimateTokens(buf.join(" ")) >= maxTokens) flush();
  }
  if (buf.length) chunks.push(buf.join(" "));

  // No de-duplication here, deliberately. An earlier version dropped a chunk
  // identical to its predecessor as a guard against the carry failing to advance,
  // and silently lost 1846 of 3000 words on repetitive input, where adjacent
  // windows legitimately match. Advancement is already guaranteed structurally:
  // flush() only ever assigns a strictly shorter buffer or an empty one, and each
  // iteration consumes exactly one segment.
  //
  // The size bound, however, is enforced rather than assumed. Carrying an overlap
  // into a buffer that then takes another segment can overshoot: across 400
  // randomised documents the assembly above produced a chunk of 1730 tokens
  // against a 1200 target — 84% of Ollama's batch, close enough that a denser
  // tokeniser would reintroduce the silent truncation this file exists to prevent.
  // A post-condition costs one pass and makes the guarantee unconditional.
  return chunks.flatMap(hardSplit).map((content, index) => ({ index, content }));

  function hardSplit(chunk: string): string[] {
    if (estimateTokens(chunk) <= maxTokens) return [chunk];
    const words = chunk.split(/\s+/).filter(Boolean);
    const out: string[] = [];
    let acc: string[] = [];
    for (const w of words) {
      acc.push(w);
      if (estimateTokens(acc.join(" ")) >= maxTokens) { out.push(acc.join(" ")); acc = []; }
    }
    if (acc.length) out.push(acc.join(" "));
    return out;
  }
}
