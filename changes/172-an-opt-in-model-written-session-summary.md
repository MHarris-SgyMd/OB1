# 172. An opt-in model-written session summary — what was decided, through the egress gate, with the derived summary as the fallback (SMD-2014)

**What changed.** Two parts, one client and one server.

`recipes/session-capture-hook/session-capture.mjs`: `loadConfig` reads the
model knobs — `summary` (`derived` | `model`), `model_url`, `model`,
`model_key`, `model_local`, `egress`, `model_timeout` — from the config file,
each with an env override (a hook-specific one, then the server's own
`OB1_CHAT_*` / `OB1_LLM_*` / `OB1_EGRESS_POLICY`, for a box that already runs a
model). The parsers keep the episode's assistant messages (a capped window, the
most recent) beside the last one they already kept; `prepare` attaches that
excerpt to a payload only in model mode, so a derived-mode payload is
byte-identical to before. In the DETACHED child that posts — never the 1.5 s
foreground — `modelSummary` shows a local model the derived summary and the
assistant's messages only (never the raw transcript, never tool results),
under an OpenAI `/chat/completions` call, and asks for decisions, what was left
open and what changed. Every way it can go wrong — the option off, no endpoint,
egress refusing a non-local endpoint, a slow, failed or empty call, or a secret
in the model's OWN words (the secret scan runs on its output too) — falls back
to the derived summary the payload already carries, logged; the derived text's
fingerprint and `derived_from` are unchanged, so an episode is asked of the
model once and its provenance never names an id the model invented. A running
checkpoint keeps its DERIVED summary — its `Checkpoint: … continuing` line is
the signal a sibling reads and search marks superseded, and a free rewrite
would drop it — so the model writes the durable summary at the episode's end,
which supersedes it. The egress
gate is the hook's OWN (it is a client on another machine from the server whose
SMD-1903 gate lives in the box): `deny` by default and fail-closed, and "local"
is DECLARED (`model_local`), never guessed from the address. `postCapture`
sends `metadata: { summary_model }` when a model wrote the text; `--check` and
`--dry-run` print the mode and whether egress would let a configured model run,
without calling it.

`server-portable/index.ts`: `capture_thought` gains an optional `metadata`
argument — a small object of caller keys (lower-case, scalar values, at most
eight), merged UNDER the server's own metadata (the extractor's tags, and
`source` from the `source` argument), so a key the server owns is refused
outright, not silently overruled. `upsert_thought` already stores the metadata
jsonb verbatim (migration 046) and the audit trigger records it, so a caller
key lands, replays and reads back with no schema change. Version 1.3.0; the
README gains the model-summary section and the config keys; `metadata.json`
carries the new env and tags.

**Why.** The derived summary is a log entry: deterministic, free, never wrong
about what happened — and unable to say what was decided or why. SMD-1298's
fragment recorded "calling a model in the hook" as not taken; two things have
changed since, both named in this ticket — the egress gate (SMD-1903) makes a
local endpoint a declared, safe place for a transcript's text to go, and the
dogfood box runs one. The sibling tickets it named as prerequisites —
PreCompact checkpoints (SMD-2012) and episode segmentation (SMD-2013) — are
both merged, so a model summary is of one well-segmented piece of work, not a
badly-cut one.

**Scope.** The ticket assumed a `summary_model` metadata key would need a
migration; it does not. `upsert_thought` stores `p_payload.metadata` verbatim,
so the whole change is the tool's schema plus a TypeScript merge — no
migration, no schema-migrations leg, and no contention with SMD-2115's pending
055. The structured metadata arg (the scope chosen over a text footer) is
delivered; the migration it was estimated to need turned out unnecessary.

**Held.** `bun recipes/session-capture-hook/test-session-capture.mjs`, 518
assertions (from 484, extended across the five review passes): the egress rule
(local declared not guessed; deny, allow, off); `loadConfig` reading the knobs
and failing egress closed; `modelSummary` returning the model's text on the happy
path — shown a system brief, the derived summary and the assistant's messages,
no tool results or ids — and the derived text on every fallback (off, no excerpt,
unconfigured, egress-refused before anything is sent, a planted key in the input
or the output, empty, an HTTP error, a timeout); `prepare` attaching the excerpt
only for durable model-mode payloads; the child end to end posting the model's
text with `metadata.summary_model`, `source` still the harness, and off sending
the derived text with no metadata. `server-portable/test-e2e-sql.ts` (real
Postgres, 224 assertions): a caller `metadata.summary_model` stored beside the
server's source and tags it did not overwrite, and a reserved, over-long or
badly-shaped key refused before either model call. Server typecheck clean.

**Review passes.**

| Pass | Finding | Caught by | Fix |
| --- | --- | --- | --- |
| 5 | No correctness or security defect — the confirming pass for pass 4. A fresh cold read traced the clamp timeline (worst-case iteration 330 s model + 540 s post = 870 s < the 900 s claim window, each payload re-touched, so multi-payload and follow-up rounds stay bounded) and enumerated the URL/key tiers, both correct and complete; run-it killed 18/20 (the two survivors — the fetch `redirect: "manual"` mode and the unreachable-fetch skip guard — change only a log line, not what lands). Note only: `modelTimeoutMax` has no positive floor, so a future change lowering `CLAIM_MAX_AGE_MS` or raising `POST_TIMEOUT_MS` could make it non-positive (which degrades safely to always-fallback, no double-post) | cold-read + run-it + mutant | none needed — the pass-4 fixes hold; the floor and the two cosmetic survivors recorded in Not-taken |
| 4 | A real defect all three prior passes missed: the model `await` widened the inflight-claim critical section — the child touches its claim mtime once per queue iteration, then runs the model call and up to six post attempts (~9 min) with no refresh, so under an elevated `model_timeout` (pass 3's clamp allowed ~24.8 days) a sibling run's sweep, which reclaims a claim older than 15 min even when the owning pid is ALIVE, could reclaim and DOUBLE-POST the episode with a broken supersedes chain; and the server's own LLM key fell through to a hook-overridden `model_url`, a partial-override credential leak | cold-read + run-it + mutant | `model_timeout` is clamped so the model call plus the worst-case post fit one claim window (`CLAIM_MAX_AGE_MS − 6·POST_TIMEOUT_MS`); the URL and its key are read as a pair per tier, so the server key is never sent to a hook-specific endpoint; a tooth that a payload which already landed does not re-call the model. Run-it killed 11/12 — the two survivors were the already-landed reuse-guard clause (now the tooth) and the inert merge order (a documented no-op) |
| 3 | No correctness defect — the confirming pass; both reviewers reached the stop signal and verified every pass-1/2 fix holds (the checkpoint gate is load-bearing and tested in both prepare and modelSummary, every byte that leaves the box is scanned, no log line prints a key). Low/cosmetic only: a `model_timeout` above the 32-bit setTimeout ceiling was truncated by the runtime to a near-zero abort, so a generous timeout became the shortest; the model's own output-length cap and the excerpt's between-turn formatting had no teeth | cold-read + run-it + mutant | the timeout is clamped to the ceiling; two teeth (the clamp, the output cap); the cosmetic model-input formatting left unpinned as no correctness risk |
| 2 | No correctness defect — both reviewers reached "land as-is"; only Low config and coverage items: a full `/chat/completions` model_url doubled the path into a silent 404-then-fallback; a negative `model_timeout` was truthy and aborted the fetch at once; a running-checkpoint payload carried the assistant excerpt at rest though the model never reads it; the tail-clip, the per-episode message window and the metadata caps (200 chars, 8 keys) had no test with teeth | cold-read + run-it + mutant | model_url is trimmed to its base and a non-positive timeout falls to the default; the excerpt is attached only to durable payloads; five teeth (URL/timeout normalisation, the tail-clip, the message window, the two caps); the two surviving mutants and the unpinned caps now killed |
| 1 | The assistant excerpt the model is shown left the box UNSCANNED — only the derived text (at prepare) and the model's output were scanned, so a key in an assistant message that was not the last outcome reached the model, off-box under egress allow/off (both reviewers proved it with a probe); the checkpoint gate matched renderSummary's `Checkpoint:` wording, fragile and with no test with teeth (a stale reply left the model call failing regardless of the gate); the `!r.ok` status branch and the retry re-call guard were unpinned; the metadata merge-order flip survived but is benign — reserved keys are refused before the merge, so the order is unobservable | cold-read + run-it + mutant | the assistant excerpt is scanned before the call, a hit keeping the derived summary; the checkpoint gate reads the event table `eventSpec(payload.event)?.checkpoint` that renderSummary's line derives from; three teeth (the leak, a 5xx with a valid-looking body for the status branch, a payload a model already wrote not re-modelled); four mutants killed |

**Not taken.** A migration for `summary_model` (the ticket's premise and the
scope estimate): the metadata jsonb is stored verbatim, so none is needed, and a
COMMENT-only migration would contend with SMD-2115's pending 055 for no
behaviour. Showing the model the previous summary to write a delta (the ticket's
open question): kept stateless in v1 — the derived summary already carries the
checkpoint context; a follow-up if a delta reads better. A per-term egress
config on the hook (the server's `actor:`/`source:` terms): the hook is a
client with one endpoint, so a mode and a declared-local flag are its whole
policy. A metadata namespace for caller keys: the reserved-set refusal is
clearer than a prefix, and `summary_model` is a top-level key SMD-1297 can
weight on. `update_thought` taking `metadata` too: the hook does not edit, and
capture is the surface this needs. Refusing a whole episode on a secret in the
model's output rather than falling back: a memory beats none, and the derived
text already passed the scan. Ordering the metadata merge against a caller
clobbering a server key (a pass raised the flip): `refuseMetadataShape` refuses
every reserved key before the merge, so the spread order is unobservable — the
mutation survives and correctly cannot be caught. Marking a fallen-back payload
so a later drain skips the model: a retry may succeed once a down model is back,
which is the point; the guard only skips a payload it already wrote. Guarding a
second live thought on a LOST state file with non-deterministic model text: it
needs the loss plus a content-deduping server, and the model text survives the
ordinary retries the state does. Rejecting a non-finite metadata number: a
client's `JSON.stringify` sends `1e400` as `null`, which stores benignly.
Skipping the model for an empty excerpt: rare, and the model can still shape the
derived text — a wasted detached call, not a defect. Trimming a `/chat/completions`
that a query string follows (review pass 3): a query on a chat BASE URL is
unusual, the README documents a base, and matching it adds regex weight for an
absurd input. Pinning the excerpt's between-turn formatting — the `\n\n----\n\n`
separator, the empty-turn filter, the `(none)` placeholder for an empty excerpt
(review pass 3 survivors): these shape the model's INPUT only, with no
correctness or egress effect, so a surviving mutation on them is left unpinned.
A positive floor on `modelTimeoutMax` (review pass 5): it is 330 s today, and a
future change making it non-positive degrades safely (every model call aborts and
the derived summary is sent, never a double-post), so a `Math.max` floor that
guards only a hypothetical edit and can carry no test under the present constants
is noted, not added. The fetch `redirect: "manual"` mode and the skip when no
model is configured (pass 5 mutation survivors): each changes only a log line and
a doomed request — a followed redirect still meets the `!r.ok`, JSON and
secret-scan gates — so neither alters what lands, and both are left unpinned.

**Boyscout.** After the stop signal, two cut-for-space tidy-ups in the touched
files, no behaviour change (the suite holds at 518): `modelSummary` reads the
`chainOf` helper for a payload's chain key rather than respelling
`chain_id ?? session_id` as the rest of the queue does; and the five `loadConfig`
probes in the test fold into one `withEnv({…}, loadConfig)` that sets, runs and
restores, in place of three copies of the save/restore loop.

**Follow-ups.** None filed yet.

**Upstream status.** Not upstream.
