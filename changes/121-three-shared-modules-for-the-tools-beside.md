# 121. Three shared modules for the tools beside the server — the tag extraction, the `.env` reader and the Linear client move out of the server and the evals, unchanged (SMD-1985)

**What changed.** `server-portable/index.ts`'s private `extractMetadata` and
`metadataRefused` are `server-portable/metadata.ts`, the function taking the
resolved `EmbedConfig` instead of reading the server's lazy accessors; `index.ts`
keeps a one-line lazy reader over `embedConfig()`, and the three per-field
accessors it no longer needs are gone. Beside them, `TAG_KEYS` (the keys the
extraction writes, `type_raw` among them) and `tagsOverExisting(answer)`: what an
answer writes over an EXISTING row's tags — a refusal or a fallback nulls every
tag key it does not set, so the previous text's people, topics and action items
do not stand on the new text under a marker that says no extraction happened; a
full answer nulls a stale marker. `evals/env.ts` (`parseEnv`, `envFiles`,
`loadEnv`, `describeEnv`) is `db/env.ts`, its search path — `$OB1_ENV_FILE`,
`evals/.env`, `<repo>/.env`, `deploy/.env` — spelled from the repo root so the
move changed no file it looks at; `evals/env.ts` re-exports it and the seventeen
evals keep their import. The Linear GraphQL client inside
`evals/build-linear-corpus.ts` — the endpoint, the raw-vs-Bearer authorization,
errors arriving beside data with HTTP 200 — is `db/linear-api.ts`
(`linearClient`, returning `{ data, errors }`, and `strict` for a caller that
refuses a partial answer), and the corpus builder calls it.

**Why.** SMD-1954's board sync writes thoughts from outside the server and needs
all three; SMD-1975's retag worker will need two. Each would have been copied —
the value defined twice this fork keeps finding. Split out of SMD-1954's branch
as its own change so the sync's record is the mechanism alone.

**Held.** `tsc` in `server-portable/`, `db/` and `evals/`; `test-server.ts`,
`test-egress.ts` and `test-local-provider.ts` unchanged and green — the moved
body is the old one byte for byte but for the config argument.

**Upstream status:** not sent — upstream has no tools beside its server.
