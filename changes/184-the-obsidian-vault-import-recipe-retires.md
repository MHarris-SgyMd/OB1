# 184. The Obsidian vault import recipe retires — the Markdown adapter is the fork's import, one file one thought with the file kept byte for byte, and what the recipe had that the adapter has not is named, dropped or filed on the adapter's and the connector's tickets, nothing ported (SMD-2137)

**What changed.** `recipes/obsidian-vault-import` — `import-obsidian.py` (947
lines), its README, `metadata.json`, `.env.example`, `requirements.txt` and
`.gitignore` — is deleted. The script read a vault with `python-frontmatter`,
split long notes at headings, distilled sections over a thousand words through
`gpt-4o-mini` over OpenRouter, embedded each thought with
`text-embedding-3-small` there too, and POSTed content and vector to
`${SUPABASE_URL}/rest/v1/thoughts` raw: the shape SMD-1524 closed for the
servers, over a PostgREST this fork does not run, through an egress the PHI
posture forbids. The fork's Obsidian import is `db/ingest-markdown.ts`
(SMD-1867): one file → one thought, the file's bytes the canonical in
`thought_sources`, the frontmatter as facets, `[[wikilinks]]` as `references`
edges, `#tags` and frontmatter tags as topic mentions, the vector left for
`reembed.ts` to write locally. What follows the directory out:

1. The root `README.md` row keeps its name, reads retired, and points at the
   `markdown` row of `db/README.md`'s source table with the two commands —
   each with its `--url`, the vault as a path (a bare name passes `--markdown`
   but is not resolved by `--allow`, so every note is refused with exit 0), and
   the model declaration `reembed.ts` needs before it writes a vector; that row
   says what the walk takes and skips.
2. `docs/connector-registry.json` loses the artifact entry and, with it, the
   `obsidian` connector — check 19 refuses a connector no capability names, and
   SMD-1814's connector registers the vendor again, `writable`. The
   `document/page` family's dividing line no longer cites the recipe for
   `1:many`: the adapter is `1:1`, and the heading split it named is the
   atomizer's, past the seam. `bun scripts/connector-registry.ts` rewrote the
   tables: 21 artifacts, 31 capability rows, 15 connectors; the family's
   instances read `blogger` alone. The spec's hand-written example of a second
   direction moved from Obsidian to Gmail and says how a vendor leaves and
   returns.
3. `docs/vendored-disposition.md`: the PostgREST-scripts row and the rollup's
   strike-through read retired; the section's prose says the directory is gone,
   opens on thirty scripts at the decision and twenty-nine now, and names
   `POSTGREST_EXCEPTIONS` plus the two lib-reached scripts as the remaining
   size; the SMD-1924 inventory row reads `retired (SMD-2137)` as SMD-1800's
   two do and no longer carries the fold-in marker (check 19 read `→ SMD-1867
   candidate` inside its strike-through as a fold-in row and named the
   directory as gone — the first thing the removal tripped).
4. `scripts/check-fork-consistency.ts`: check 24's `POSTGREST_EXCEPTIONS` loses
   the `import-obsidian.py` entry — twenty-seven files with a call site, the
   first entry to leave — and its three comments say so.
5. `docs/open-brain-assistant-gpt-context.md`'s import list no longer names
   Obsidian as a recipe and says where the vault import is.
6. `changes/smd-2137.md`, this record. No migration; `patch`.

**Why.** SMD-2126 decided the class: an import becomes an adapter of the
contract, a maintenance script moves onto the shim, and a script whose
capability is in core retires. The ticket's comparison, feature by feature,
found each of the recipe's capabilities in the adapter and pipeline (dedup by
fingerprint and deterministic id for the sync log; `--dry-run` for `--limit`,
`--report` and `--verbose`; `reembed.ts` for `--no-embed`; the title line for
the content prefix; a refusal by name where the recipe replaced undecodable
bytes with U+FFFD), past the seam (the heading split with LLM distillation,
which the registry's own dividing line already called an enrichment), or as
vault-level work that is the adapter's and the pipeline's — `--min-words`,
`--skip-folders` and the `templates` exclusion, `--after`, a per-vault label,
an mtime `created_at` — filed as SMD-2228 in pass 4 (pass 1 had handed them to
SMD-1814, the connector's). Two things the comparison called covered are not,
and the record says so: the recipe scanned each thought for key material
before the POST, and the markdown path has no such check — the allowlist
clears a vault whole and a token in a note is stored as written, a regression
taken, SMD-2228's; and the recipe kept two vaults' `Plan.md` apart by folder
and label, where the adapter's identity is the note's name with the vault root
stored nowhere, so a second vault's note overwrites the first's across runs as
`updated` (measured in pass 4: one row, vault B's text, no `held`) — one vault
per brain until SMD-2228 lands, said in `db/README.md`'s row. Nothing is
ported here: the ticket's rule was to file, not port.

**Held.** Check 19: the artifact and its connector go together (a connector no
capability names fails as stale — that rule fires before the table comparison,
so a connector put back is one violation, not two; the regenerated tables must
equal what the registry renders; a fold-in row naming a gone directory fails).
Check 24: an exception naming a file the scan does not reach fails, so the
entry could not have stayed; the directory put back untracked fails four ways
(unregistered, and its three lines with no entry). Checks 1–4 walk 114
contributions; `ingest-markdown.ts --self-check` PASS; `db/` and `scripts/`
typecheck; `test-live.ts` 728 of 728 on the branch, 733 on the merged tree.

**Measured after.** A three-note scratch vault (frontmatter title, tags and
`created`; an inline `#tag`; three wikilinks, one aliased; an image embed; a
sub-folder): `--dry-run` counts three; live on a throwaway Postgres, three rows
under `thought_sources.system = 'markdown'`, three `references` links, two
topic mentions, the frontmatter date as `created_at`; a rerun writes nothing.

**Review passes.**

| pass | finding | caught | fix |
| --- | --- | --- | --- |
| 1 | check 24's block comment still counted twenty-eight — a third copy of the number | cold read | pass 1 |
| 1 | the disposition section opened in the present tense on thirty scripts and called "the table" the remaining size while the retired row stayed | cold read | pass 1 |
| 1 | the GPT context brief listed Obsidian among the import recipes | cold read | pass 1 |
| 1 | the inventory row took a third verdict form; SMD-1800's `retired (…)` is the precedent | cold read | pass 1 |
| 1 | the record called the recipe's encoding handling a skip; it replaced bytes | cold read | pass 1 |
| 1 | a `Templates/` note becomes a thought and no README said so | run-it | pass 1 |
| 1 | the root README row was three times its neighbours' length and named "the fork" as contributor; "Gmail was one" | cold read | pass 1 |
| 1 | the Held paragraph listed two teeth for a connector put back where one fires; the restored directory's four violations named (five mutants killed) | mutant | pass 1 |
| 2 | the README's command lacked `--source markdown`: the default `all` ingests the fork's changes and commit messages beside the vault — 1721 records on a dry run of a five-note vault | run-it | pass 2 |
| 2 | `POSTGREST_EXCEPTIONS`'s size (27) was called the class's remaining size; two scripts reach the gateway through a lib (29) | cold read | pass 2 |
| 2 | this table had seven rows for pass 1's eight findings and listed the mutant run as one | cold read | pass 2 |
| 2 | the rollup's count line still read 30 in 21 as the present count; "the connector ticket (SMD-2137)" read as naming the wrong ticket | cold read | pass 2 |
| 2 | the db README's walk sentence was narrower than the walk: `.MD` is taken, every dot-folder but the four is walked, a symlink is a second identity | run-it | pass 2 |
| 2 | Not taken named the three schemas' rows as the `retired (…)` precedent; they read `remove` — SMD-1800's two are | cold read | pass 2 |
| 3 | a bare vault name passes `--markdown` (resolved) but not `--allow` (resolved only with a separator): every note refused, exit 0 — the placeholder is a path; SMD-2221 has the seam | run-it | pass 3 |
| 3 | neither documented command carried `--url`, while the section they link to spells it on both | run-it | pass 3 |
| 3 | "then `reembed.ts`" refuses every call at the egress gate until the model is declared local; the docs say what to declare | run-it | pass 3 |
| 3 | the row's link landed in a section written for the fork's own brain; two disposition fragments spelled the flag without `--source` | walkthrough | pass 3 |
| 3 | check 24's header kept "the table's size is the remaining size" that pass 2 rewrote in the disposition; the pipeline's own usage header lacked `--source markdown` | cold read | pass 3 |
| 3 | this table lacked pass 2's sixth row; the db README row called `Templates/` a dot-folder; the rollup's "the first" spanned two bullets | cold read | pass 3 |
| 4 | two vaults' `Plan.md` collide across runs — the identity is the name, the root is stored nowhere; vault B's note replaced vault A's as `updated`, no `held` | cold read | pass 4 |
| 4 | the key-material scan's loss read as a hand-off, not a regression taken; four hand-offs were the adapter's, not the connector's — SMD-2228 filed | cold read | pass 4 |
| 4 | live suite 728/728 on HEAD; main moved five PRs with no overlapping hunk; the documented command works from an operator's directory, and skipping the declaration meets the egress gate first — the row says so | run-it | pass 4 |

**Not taken.** A `db/` row in the registry for the adapter — the registry
classifies contributions, and the family's dividing line names the adapter
instead. The landing dashboard's "Obsidian Vault Import" row
(`dashboards/ob1-canonical-landing/index.html`) — it links upstream's tree,
where the recipe lives on, and SMD-1929's purge owns that page. The rollup's
"remove: 8" list and the inventory's other removed rows — the triage's verdicts
stay as written; the inventory row's `retired (…)` is SMD-1800's form, and the
three schemas' rows keep the triage's `remove`. Rows a recipe import already
wrote keep their `obsidian` label and `[Obsidian: …]` prefix — nothing rewrites
them; `source-filtering` and `thought-enrichment` read a label generically.

**Follow-ups.** SMD-2228 (filed in pass 4: one vault per brain, and the
vault-level items — mtime `created_at`, the walk's filters and what it takes,
a per-vault label, a pre-write key-material scan — as the adapter's and the
pipeline's; SMD-1814 keeps the connector's conflict model and writable
direction, with a comment pointing there); SMD-2138 (`local-ollama-embeddings`,
the sibling retirement); SMD-2221 (filed in pass 3: an adapter flag without
`--source` runs every source, and a bare `--allow` name is not resolved as
`--markdown`'s is — zero written, exit 0).

**Upstream status.** Upstream keeps the recipe; the adapter is the fork's.
