# 104. A version for the fork, reported by the brain, with a changelog beside the design record (SMD-1804)

The fork shipped continuously from `main` and nothing named what shipped: one tag
(the upstream pin), no releases, and a brain identified only by the highest
migration its ledger recorded plus whichever server was checked out. This gives it
`MAJOR.MINOR.PATCH+upstream.<sha>` — the build metadata carrying the pin — with the
bump rules derived from the contracts the fork already enforces (a shipped
signature or visible name change is MAJOR, an additive migration or tool is MINOR,
no schema change is PATCH), written into FORK.md's "Versioning" and checked by
`check-fork-consistency`, not remembered.

`db/version.mjs` is the one definition of the current version (`FORK_VERSION`) and
the release manifest (`releases.json`), kept out of `config.mjs` so the Workers
bundle stays free of `node:crypto`. Migration 044 upserts `schema_version` into
`ob1_config` at the pre-release baseline `0.0.0+upstream.9543c29`; `preflight`
prints it beside the ledger's highest migration and warns when a brain is past its
version's range or a server is older than the brain it serves; `migrate.ts
--dry-run` names the release each pending migration belongs to.

A release is a tag naming the migration range it closes, the server commit, and
the pin; migrations inside a released range are frozen, and `check-fork-consistency`
refuses an edit to one at review time (the append-only rule the ledger's sha check
already enforces at apply time). The hand-assigned change counter retires: a PR
ships a `changes/<ticket>.md` fragment citing ticket and migration numbers, and the
release step assembles fragments into numbered change files (`changes/NNN-<slug>.md`,
since SMD-1917) and `CHANGELOG.md` (Keep a Changelog 1.1.0) in one commit,
assigning the numbers once. Changes 1–103 keep their numbers.

Not in this cut: the inaugural tag and the published images and release job wait on
the enforcement half (SMD-1805) and are gated on approval. The orphaned
`.github/release-drafter.yml` is removed so there is one release mechanism.
