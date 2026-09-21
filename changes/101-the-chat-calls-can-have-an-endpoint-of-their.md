# 101. The chat calls can have an endpoint of their own — `OB1_CHAT_BASE_URL` and `OB1_CHAT_API_KEY` split `/chat/completions` from `/embeddings`, a credential belongs to an endpoint, and preflight reports and probes each by name (SMD-1902)

`server-portable/embed.ts` held one `llmBase` and one header set, and
`providerCall` appended `/embeddings` or `/chat/completions` to it. So the
embedding of a capture and everything said about it by a chat model — the
metadata extraction, the chunk blurbs of change 27, the entity extraction of
change 30, the supersession judge of SMD-1294 — came from one provider. That
ruled out the configuration people ask for first, local embeddings with a
hosted tagger (the text stays home for the vector and leaves only for tags),
and the one the routing ladder (SMD-1898) is built on: a second local runtime
that serves chat only, beside Ollama — Edge0 (SMD-1880) has no embeddings
endpoint at all.

`EmbedConfig` now carries two `ProviderEndpoint`s, `embeddings` and `chat`,
each `{ base, key, headers }`; `resolveProviderEndpoints` builds them and
`resolveEmbedConfig` spreads them in, so the server, `db/reembed.ts`,
`db/consolidate.ts`, `db/extract-entities.ts` and the evals resolve the pair by
one rule. `providerCall` picks the endpoint by path and every message it
builds names the base it dialled; the judge and the entity extractor, which
keep their own `fetch` for their own deadline, read `cfg.chat`. The old fields
are gone rather than aliased: a reader of `cfg.llmBase` meant "both" without
saying so, and the compiler found each one.

The rule for the credential is the part worth stating. `OB1_LLM_BASE_URL` (key
`OB1_LLM_API_KEY`, else `OPENROUTER_API_KEY`) is the embeddings endpoint and,
unless `OB1_CHAT_BASE_URL` names another, the chat endpoint too, key and all —
a deployment that sets neither chat knob sends byte for byte what it sent
before, which `test-local-provider.ts` [2]–[3] hold at the server and [8]
holds at the resolver (drop the sharing and three assertions fail). A chat base
that IS a different endpoint gets `OB1_CHAT_API_KEY` and nothing else. The
ticket said "each knob falls back to its `OB1_LLM_*` value"; taken literally
that hands a local chat model beside a hosted embedder the hosted provider's
key, and since empty means unset throughout there would be no way to say "no
key here" while `OB1_LLM_API_KEY` is set. A credential belongs to an endpoint,
not to the environment. Two spellings of one base are one endpoint and share
the key; `OB1_CHAT_API_KEY` alone gives the shared endpoint a chat-only
credential. A hosted chat base with no key of its own is not papered over: it
is the configuration preflight fails by name.

`preflight.ts` resolved the base and key a second time by its own copy of the
rule; it now reads `resolveProviderEndpoints`. Unsplit, the `model provider`
row says the endpoint serves "embeddings and chat"; split, it says
"embeddings" and a `chat provider` row names the other base. One
`credentialRow` prints the embeddings credential and, when the chat knobs name
an endpoint, a `chat credential` row — which also says when `OB1_LLM_API_KEY`
is set and NOT sent there, where an operator expecting the inherited key would
look. `--deep` runs two probes in two `try`s: a chat endpoint that is down
fails the `metadata model` row, naming the chat base and its host, while the
`embedding provider` row says what it found — one `try` around both had
reported every chat failure as the embedding provider's, with "network
reachability to openrouter.ai" as the remedy whatever the base was.
`test-preflight.ts` [6] holds the rows, the exit code, that the key's value
never prints, and the split `--deep` outcome against a stub embedder and a
closed port.

`deploy/.env.example` documents the pair as Option C (so check 14 requires
`deploy/compose.yaml` to forward both, which it does), `server-portable/README.md`
and `SETUP.md` carry the "half local" shape and its caveat: under it every
capture's full text still leaves the host, for tagging, and nothing yet decides
which content may — the choice of endpoint is the whole policy until SMD-1903.
The defaults still share one base, so `checkEmbeddingDefaults`' "the three
provider-facing defaults move together" stands. The timeout stays one knob.

Two review passes: the failed-tagging note in `index.ts` named
`env().OPENROUTER_API_KEY` (upstream's text) and now names the chat endpoint
it dialled; the re-embed summary says where blurbs go; and the docs say that
`OPENROUTER_API_KEY` belongs to the embeddings endpoint too, whatever its name
suggests — local embeddings with OpenRouter for chat is `OB1_CHAT_API_KEY`,
which preflight's fix line already said. Boyscout: the resolver builds the chat
endpoint once and hands back the embeddings one when it has no key of its own
and the same base, instead of stripping the slash twice and branching three
ways.

**Upstream status:** not sent — upstream has one provider constant and no
preflight; this is the fork's own provider layer (change 16 and since).
