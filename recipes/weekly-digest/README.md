# Weekly Digest

> **On this fork (SMD-2126, SMD-2239) — retired.** The live mode now lives in
> [`db/weekly-digest.ts`](../../db/weekly-digest.ts), a `db/` verb on SMD-2134's
> harness, behind the server's egress gate (SMD-1903). The original
> `weekly-digest.mjs` reached the brain as a PostgREST client
> (`${SUPABASE_URL}/rest/v1/…` with a service-role key) and posted the digest to
> Telegram with no egress handling at all — a **sink** that would read the
> database and send its content from below the gate. This fork's stack runs no
> PostgREST (SETUP.md), so that script never ran here; rather than port a sink
> onto `compat/supabase-sql`, SMD-2239 rebuilt it as the `db/` verb, where the
> synthesis and the Telegram send each pass the egress gate. This page is kept as
> a pointer; the script is gone.

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Original recipe by [@alanshurafa](https://github.com/alanshurafa)** — the
importance-ranked weekly synthesis it introduced is preserved in the `db/` verb.

## Where it went

Run the digest from a checkout (or the orchestration runner image) with the
brain's own connection and egress policy:

```bash
# Print to stdout (no delivery hop)
bun db/weekly-digest.ts --url "$DATABASE_URL" --output stdout

# Post to Telegram — the send is refused unless the digest is named in the
# egress policy; declare it with one term, set the bot credentials
OB1_EGRESS_ALLOW=type:digest \
TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… \
  bun db/weekly-digest.ts --url "$DATABASE_URL"
```

The verb keeps the recipe's behaviour — a `--window` of days, importance ranking
(from `metadata.importance`, widening when a quiet week clears too few), the
`restricted`/`personal` sensitivity exclusion (fail-closed when the column is
absent, unless `--no-sensitivity-filter`), and `--output telegram|stdout|file` —
and adds the gate: both the LLM synthesis and the Telegram send are decided by
the egress policy, so brain content leaves only when an operator opts the digest
in (`OB1_EGRESS_ALLOW=type:digest`, or `source:weekly-digest`, or `actor:<key>`).
See the header of [`db/weekly-digest.ts`](../../db/weekly-digest.ts) and
`db/README.md` for the flags and the egress model.
