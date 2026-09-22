# changes/ — one file per change

[`FORK.md`](../FORK.md) is the front door: the pin, what the fork is for, the
version scheme, changes 1–17 as a table, the standing sections, and a generated
index of everything here. The record of every change from 18 on is one file in
this directory, in one of two states:

- **`NNN-<slug>.md` — a numbered change.** The change number is the one code
  comments cite as "FORK.md change N" and `db/README.md`'s migration map cites as
  "NNN change M". The numbers run contiguously from 18 with no gap and no
  duplicate. Only the release step creates one of these (18–103 predate it).
- **`smd-NNNN.md` — a release fragment** (SMD-1804): what a pull request ships.
  It has no change number yet; the release step assigns one when it assembles a
  release, turning the fragment into `NNN-<slug>.md` in merge order. So a merge of
  `main` while a PR is in review renumbers nothing, and two PRs never collide on a
  number. The index lists fragments by ticket under "landed since the last
  release".

Until SMD-1917 these were `### N.` sections of one 1.2 MB, 17,700-line FORK.md
that no context window could hold whole, numbered by hand at PR time and
renumbered at every merge of `main`.

## A fragment (what a PR adds)

```markdown
---
type: added        # one of: added | changed | deprecated | removed | fixed | security  (Keep a Changelog's six)
bump: minor        # one of: major | minor | patch  (the version rules in FORK.md; a `patch` that ships a migration is refused)
tickets: [SMD-1804]        # one or more SMD-#### ids
migrations: [044]          # the migration numbers this change adds, or [] for none
---

## Changelog

One to three lines for CHANGELOG.md, ending in the ticket and migration numbers.

## FORK

The change's record. Its FIRST line is the title — "Thing — consequence
(SMD-NNNN)", what will follow `# N. ` once numbered — then a blank line, then the
body in the shape below. Cite tickets, migration numbers and existing change
numbers; do not give the record its own number or heading — the release step does.
```

`CONTRIBUTING.md` says when a fragment is required. `check-fork-consistency`
validates every fragment (the six types, a bump the migrations allow, both bodies
present, no numbered heading in the FORK body, the line cap below).

## The shape of the record

Bold-led paragraphs, in this order, each only if it applies:

- **What changed.** The mechanism, in the file's own terms.
- **Why.** The measured defect — what was observed, on what, before.
- **Held.** The check, the test, the CI line that fails when it comes back.
- **Measured after.** The numbers on the same setup, after.
- **Review passes.** A table, one row per finding that changed the mechanism:
  pass, finding, who caught it (`cold read` / `run-it` / `mutant` / `CI`), the
  fix commit. Not a paragraph per pass: the prose is in the pass's commit body,
  where `(caught: …)` tags live and `scripts/mechanism-yield.mjs` reads them.
  A finding worth more than a row is worth a follow-up ticket.
- **Not taken.** What was argued and declined, and why.
- **Follow-ups.** The tickets filed.
- **Upstream status.**

A file — fragment or numbered — is at most **150 lines**. The 47 numbered files
that were over it when the split landed (46 from FORK.md, and 103, which reached
`main` as a hand-numbered section while the split was in review) are listed in
check 15's `OVERSIZE_AT_SPLIT` with the line count they had then, rounded up to
ten, and may only shrink: a listed
file that fits under the cap fails until its entry is dropped, and a listed file
that grows past its ceiling fails.
[`102-…`](102-every-knob-the-server-reads-reaches.md) is the first record cut to
the shape (470 lines to 119); [`smd-1917.md`](smd-1917.md) is the second.

## At a release

`bun scripts/assemble-release.mjs` (dry run; `--write` applies) takes the
fragments in merge order, writes each as the next `NNN-<slug>.md` with its
`# N. <title>` heading, removes the fragment, regenerates FORK.md's index with
`scripts/fork-index.mjs`, writes the `CHANGELOG.md` section and appends to
`releases.json`, which freezes the shas of the migrations in the range. FORK.md's
"Versioning" section has the scheme.

## History

The text of 18–102 is verbatim from FORK.md at the split, the heading level
changed, with two placements moved: the "second vector store beside Postgres"
design (SMD-1038) sat inside change 19's span and is in
[change 79](079-the-store-measured-against-pgvector.md), the measurement it
pre-registered; "The recurring defect in this fork: a value defined twice" is a
house rule and a standing section of FORK.md. Their history before the split is
FORK.md's: `git log -- FORK.md`, or `git log -S '<a phrase from the file>' --
FORK.md`. Git does not follow a split of one file into eighty-five, so
`git log --follow` on a change file starts at the split.

## Held by

`scripts/check-fork-consistency.mjs` check 15: file names (numbered or fragment),
contiguous numbers, the `# N.` heading matching the name, the line cap and its
ratchet, FORK.md under its byte ceiling and carrying no numbered section at any
heading level, the index between FORK.md's markers equal to what
`scripts/fork-index.mjs` renders from this directory, and every "FORK.md change
N" / "FORK change N" / `changes/NNN` / "NNN change M" citation in a file git
tracks or would track — and every "change N" in the record itself — naming a
number with a file (or a row of the 1–17 table). Check 16 holds the fragment
shape; check 17 the changelog, the release pairing and the frozen migrations.
