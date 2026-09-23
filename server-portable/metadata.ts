/**
 * metadata.ts — the tags a capture gets: one chat call over the thought's text,
 * shared by the server's capture path and the tools that write a thought
 * without going through the server (db/sync-linear.ts, SMD-1954).
 *
 * Extracted from index.ts so a second writer does not carry a second copy of
 * the prompt, the fallback vocabulary and the refusal marker — the value
 * defined twice this fork keeps finding. The function is pure over its
 * arguments: the text, whose it is (the egress subject, SMD-1903) and the
 * resolved configuration, so it can be called from a process with no server
 * environment accessor. index.ts passes `embedConfig()`; a worker passes the
 * config it resolved once at start-up, as db/reembed.ts does for the embedder.
 *
 * What it returns is what upsert_thought merges into `metadata`: people,
 * action_items, dates_mentioned, topics, type (coerced to THOUGHT_TYPES —
 * thoughts.ts — with the model's raw answer kept in type_raw), or the failure
 * fallback with `metadata_extraction_failed` naming why.
 */

import { providerCall, ProviderError, type EmbedConfig } from "./embed.ts";
import type { EgressSubject } from "./egress.ts";
import { normaliseType } from "./thoughts.ts";

/**
 * What a capture records when the egress gate did not let its text reach the
 * chat endpoint (SMD-1903): the reason under the key the other failures use,
 * and NO topics and NO type — the call never happened, so it produced none,
 * and "observation" or the "uncategorized" placeholder would be a tag set
 * dressed as an extraction. Nothing here but the marker, also because
 * upsert_thought MERGES a re-capture's metadata over the row's (035): a
 * placeholder topic would have replaced an existing thought's real tags on
 * every re-capture under a refusing policy (first review pass). The capture
 * path writes this without calling extractMetadata; extractMetadata returns
 * it too should a refusal reach providerCall, so no path fabricates a tag set.
 */
export function metadataRefused(): Record<string, unknown> {
  return { metadata_extraction_failed: "egress_denied" };
}

/** The keys extractMetadata writes — the tag set a capture gets, `type_raw` (the model's uncoerced type) among them. */
export const TAG_KEYS = ["people", "action_items", "dates_mentioned", "topics", "type", "type_raw"] as const;

/**
 * What an answer writes over an EXISTING row's tags. A capture has no previous
 * tags, so the answer alone is right there; an edit has the previous text's
 * people, topics and action items on the row, and a shallow merge would leave
 * them standing as the new text's. So: a refusal or a fallback — an answer
 * carrying `metadata_extraction_failed` — nulls every tag key it does not set,
 * or the old tags would stand under a marker that says no extraction happened
 * (the tag set dressed as an extraction the marker exists to prevent); a full
 * answer nulls a stale marker, or fresh tags would stand under one. A merge
 * cannot remove a key; null is the nearest, and a patch compare that treats
 * null and absent as one writes nothing when there was none. One definition
 * for every writer that edits a tagged row (db/sync-linear.ts, SMD-1954; the
 * retag worker SMD-1975 will be the next).
 */
export function tagsOverExisting(answer: Record<string, unknown>): Record<string, unknown> {
  if (!("metadata_extraction_failed" in answer)) return { metadata_extraction_failed: null, ...answer };
  return { ...Object.fromEntries(TAG_KEYS.filter((k) => !(k in answer)).map((k) => [k, null])), ...answer };
}

export async function extractMetadata(text: string, subject: EgressSubject, cfg: EmbedConfig): Promise<Record<string, unknown>> {
  // The original swallowed every failure into the fallback below: an auth error,
  // a rate limit, or a 500 from OpenRouter all produced a thought tagged
  // "uncategorized" and a success message to the user, with no way to tell a
  // genuinely uncategorisable thought from a broken API key. Capture must still
  // succeed — the content matters more than the tags — but the degradation is
  // now recorded on the thought and surfaced in the confirmation.
  const fallback = (reason: string): Record<string, unknown> => ({
    topics: ["uncategorized"],
    type: "observation",
    metadata_extraction_failed: reason,
  });

  // Through the one provider call embed.ts owns, so this is bounded like the
  // embedding calls and by the same setting: a capture awaits this and the
  // embedding together, so a chat call that never returned held the capture —
  // and discarded the embedding that had finished — for as long as the
  // platform allowed. A timeout is one more recorded way the tags can be
  // missing, told apart from a refused status and from a body that is not JSON.
  let d: { choices?: [{ message?: { content?: string } }] };
  try {
    d = await providerCall(cfg, "/chat/completions", {
      model: cfg.metadataModel,
      response_format: { type: "json_object" },
      // Structured extraction has one right answer, so sampling only adds
      // variance. No temperature was sent before, which meant the provider
      // default — 0.8 on Ollama. Measured over three runs of evals/: at the
      // default, scores ranged 79/84 to 82/84 and the same capture could gain or
      // lose a field between runs; at 0 the result was identical every time and
      // above the sampled mean. Determinism also makes a bad capture
      // reproducible, which matters more than the point of score.
      temperature: cfg.metadataTemperature,
      ...cfg.metadataReasoning,
      messages: [
        {
          role: "system",
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
        },
        { role: "user", content: text },
      ],
    }, subject);
  } catch (e) {
    if (e instanceof ProviderError) {
      console.error(`extractMetadata: ${e.message}`);
      if (e.kind === "egress") return metadataRefused();
      return fallback(e.kind === "timeout" ? "provider_timeout" : e.kind === "http" ? `provider_${e.status}` : "invalid_response_body");
    }
    throw e;
  }

  const content = d?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    console.error("extractMetadata: provider response had no message content");
    return fallback("no_message_content");
  }

  try {
    const parsed = JSON.parse(content);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error("extractMetadata: model returned JSON that is not an object");
      return fallback("unexpected_json_shape");
    }

    const out = parsed as Record<string, unknown>;
    const { type, raw } = normaliseType(out.type);
    out.type = type;
    if (raw) out.type_raw = raw;
    return out;
  } catch {
    console.error("extractMetadata: model content was not valid JSON");
    return fallback("unparseable_model_output");
  }
}
