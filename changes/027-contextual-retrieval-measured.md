# 27. Contextual retrieval, measured — and the whole-content vector it found

Migration 013 (Linear SMD-951). The issue asked for Anthropic's Contextual
Retrieval: generate a short blurb naming what each window of a long capture is
about, prepend it before embedding, so a window reading "we settled on thirty
minutes, anything longer needs sign-off" carries which system it concerns. Their
published result is roughly a 35% reduction in top-20 retrieval failure.

**It is worse here, and the flag ships off.** `evals/eval-contextual.ts`, 441
real issues, the 15 that reach the 1200-token chunking threshold, 37 queries that
name a document's subject and ask for a detail living in exactly one window:

| arm | MRR | helped | hurt |
| --- | ---: | ---: | ---: |
| bare windows (the server before this change) | 0.904 | — | — |
| a blurb per window (Anthropic) | 0.826 | 1 | 8 |
| a 20-word blurb per window | 0.847 | 0 | 5 |
| one blurb per document | 0.759 | 1 | 13 |

Helped/hurt are paired counts, because at 37 queries a mean can move on one of
them and an average alone would not say which.

**The task in the existing harness could not have found this.** `eval-real.ts`
uses the issue title as the query, and a title describes a whole document, so a
whole-document vector answers it best and every arm lands within a document or
two of every other — 0.917 against 0.922 against 0.956, in the direction that
flatters the change. Building the eval on that would have shipped contextual
retrieval as a small win. The detail query is the one the technique exists for,
and it is generated from the title plus ONE window, never the whole document, so
the detail half comes from the window itself and the bare arm gets the strongest
advantage available. Biased against the change on purpose.

**The mechanism is measured, not inferred.** The same harness compares each query
against the exact window it was written for. A blurb moves that window *away*
from its own query: −0.0338 with a full blurb (lower on 32 of 37), −0.0144 with a
20-word one (27 of 37). The loss tracks blurb length. A fixed-size vector has
less room for the sentence that actually answers. That also explains the 20-word
prompt in `db/config.mjs` — the first run's blurbs ran to a median of 388
characters and every one opened "This chunk outlines…", identical text in front
of every window in the corpus. Tightening it made the technique *less bad*, not
good.

**It ships as a flag anyway, because the sign belongs to the model.** Same
harness, same corpus, same blurbs, on `embeddinggemma`: a blurb per window scores
**+0.041**, helping 5 and hurting 4. 768 dimensions against 1024, and a real
ceiling. A weaker window vector has more to gain from the extra subject signal
than it loses to dilution. So `thought_chunks.context` and `OB1_CHUNK_CONTEXT`
exist, default off, with the table beside them.

**Two premises in the issue turned out to be false, and checking them is what
produced the change that pays.** The issue says the harness is already truncating
those 15 documents at Ollama's 2048-token batch. It is not — not for the
configured model. `eval-contextual.ts` finds the ceiling by bisecting for the
shortest prefix that embeds to a bit-identical vector, no tokeniser involved, and
`qwen3-embedding:4b` read all 15,812 characters of the longest document in the
corpus. `embeddinggemma` stops at ~8,150 and `bge-m3` at ~7,530, so the premise
was true of the model migration 007 was written against and not of the default
that replaced it.

Which exposed the real defect. `embedCapture` set `thoughts.embedding` to the
**first window's** vector for a chunked capture, deliberately, to avoid an
over-batch request. On a provider that reads the whole document that threw away a
better vector for free:

| arm | detail-query MRR | helped | hurt |
| --- | ---: | ---: | ---: |
| MAX over bare windows (before) | 0.904 | — | — |
| whole content AND bare windows (now) | **0.935** | **3** | **0** |

Worth noting that migration 007's own header has said `thoughts.embedding` is
"the whole-content embedding, truncated by the provider exactly as before" since
the day it landed, while `index.ts` stored the head window. The schema's
documentation and the server's behaviour had disagreed for the whole life of the
feature, and neither was wrong enough to fail anything. This change makes the
code match what the migration always claimed.

+0.020 with none worse on `embeddinggemma` too, where the whole-content vector
*is* truncated — a head-truncated vector is a longer head than the first window,
not a worse one. The cost is one extra provider call on the 3.4% of captures long
enough to chunk, and it is best-effort: a provider that REFUSES over-length input
rather than truncating it (hosted APIs do; Ollama does not) falls back to the old
head-window behaviour, and latches so it is not asked again for the life of the
process. `test-chunking.ts` asserts **exactly one** such probe across four long
captures — `<= 1` would pass whether the latch works or the probe never happens.

**Failure policy, and why the column exists.** A blurb that cannot be generated
degrades to a bare window rather than failing the capture: one flaky local model
call must not lose a thought, which is the whole point of migration 008's atomic
capture. The usual objection is that this silently produces an inconsistent
corpus, and the answer is the column rather than the policy —
`thought_chunks.context` is NULL for a bare window, the capture response says how
many went in bare, and `preflight.ts` counts both across the corpus and reports a
brain captured under both settings. Turning the flag on without migration 013 is
a startup **failure**, not a warning: 007 and 009's functions would not select
the key. The blurb still reaches the vector — the server composes the embedded
text before the database sees anything — so what is lost is the record, and with
it any way to tell a contextualized chunk from a bare one ever again.

**A defect the review found next door.** `deploy/compose.yaml` forwards an
explicit whitelist of environment variables, not the whole environment, so a
setting present in `.env` and absent from the `environment:` block reaches
nothing — the operator sets it, restarts, and the stack behaves exactly as
before, with no error and a `.env.example` that documents the setting as real.
Six variables were in that state, including the one added here:
`OB1_CHUNK_CONTEXT`, `OB1_CHUNK_TOKENS`, `OB1_CHUNK_OVERLAP`,
`OB1_EMBEDDING_DIMENSIONS`, `OB1_LLM_API_KEY` and `OB1_AGENT_CACHE_TTL_MS`. All
six are forwarded now, and `scripts/check-fork-consistency.mjs` fails on a
seventh: a variable documented in `.env.example` and mentioned nowhere in
compose. Deliberately one-directional — compose legitimately sets things the
example does not mention, because those are properties of the stack rather than
choices anyone makes in `.env`.

**One harness limit worth recording.** The behavioural half of the migration test
lives in `db/test-live.ts` rather than `test-schema.ts` because PGlite cannot run
it: writing chunk rows through the 4-argument `upsert_thought` crashes the WASM
build in-process — `received invalid response: 0` bound as a parameter, `Out of
bounds memory access` inlined — and it reproduces with migrations 001-012 applied
and no 013, at any position in the file, on a second instance as well as the
shared one. It is the harness, not the migration, and the round trip belongs
against a real server anyway.
