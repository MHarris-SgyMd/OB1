# changes/ — one file per change

[`FORK.md`](../FORK.md) is the front door: the pin, what the fork is for, the
version scheme, changes 1–17 as a table, the standing sections, and a generated
index of the numbered files here. The record of every change from 18 on is one
file in this directory, in one of two states:

- **`NNN-<slug>.md` — a numbered change.** The change number is the one code
  comments cite as "FORK.md change N" and `db/README.md`'s migration map cites as
  "NNN change M". The numbers run contiguously from 18 with no gap and no
  duplicate. Only the release step creates one of these (18–103 predate it).
- **`smd-NNNN.md` — a release fragment** (SMD-1804): what a pull request ships.
  It has no change number yet; the release step assigns one when it assembles a
  release, turning the fragment into `NNN-<slug>.md` in merge order. So a merge of
  `main` while a PR is in review renumbers nothing, and two PRs never collide on a
  number. A fragment needs no FORK.md edit: the index lists numbered files
  alone and says, in one fixed sentence, that the `smd-*.md` files here are
  what has landed since the last release — so two PRs that each add a fragment
  never conflict on FORK.md. The index is the release step's to move
  (SMD-2084).

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

One to three lines for CHANGELOG.md, no leading bullet, naming every ticket the
front matter lists and no other (the release pairing reads a version's tickets
from this line), and the migration numbers.

## FORK

The change's record, to the end of the file. Its FIRST line is the title —
"Thing — consequence (SMD-NNNN)", ending in every ticket the front matter lists,
as "(SMD-1 / 2)" — what will follow `# N. ` once numbered; then a blank line,
then the body in the shape below; `## ` sub-headings of its own are kept. Cite
tickets, migration numbers and existing change numbers; do not give the record
its own number or heading — the release step does.
```

`CONTRIBUTING.md` says when a fragment is required. `check-fork-consistency`
validates every fragment (the six types, a bump the migrations allow, both bodies
present and in that order, the changelog line and the title naming the tickets,
no numbered heading in the FORK body, the line cap below) — the same function
the release step runs before it writes.

## The shape of the record

Bold-led paragraphs, in this order, each only if it applies:

- **What changed.** The mechanism, in the file's own terms.
- **Why.** The measured defect — what was observed, on what, before.
- **Held.** The check, the test, the CI line that fails when it comes back.
- **Measured after.** The numbers on the same setup, after.
- **Review passes.** A table, one row per finding that changed the mechanism:
  pass, finding, who caught it (`cold read` / `run-it` / `mutant` / `CI`), the
  fix commit. Not a paragraph per pass: the prose is in the pass's commit body,
  where `(caught: …)` tags live and `scripts/mechanism-yield.ts` reads them.
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
the shape (470 lines to 119);
[`108-…`](108-fork-md-is-the-front-door-and-every-change.md), SMD-1917's own
record, is the second.

## At a release

`bun scripts/assemble-release.ts` (dry run; `--write` applies) takes the
fragments in merge order — when each arrived on the branch's first-parent line,
the merge that brought it — writes each as the next `NNN-<slug>.md` with its
`# N. <title>` heading, removes the fragment, regenerates FORK.md's index with
`scripts/fork-index.ts`, writes the `CHANGELOG.md` section and appends to
`releases.json`, which freezes the shas of the migrations in the range and records
the change numbers. It runs check 16's rules first and refuses what CI would;
`--write` needs the repository (a full clone, not a shallow one), a clean tree,
committed fragments, and a tree that already says the version — `FORK_VERSION`
bumped and a `NNN_schema_version.sql` writing it as the highest migration, the
cut's first commit (SMD-1860). The PR lands both commits; the tag on the merge
commit runs `.github/workflows/release.yml`, which publishes the images and the
release, the numbered change files attached. FORK.md's "Versioning" section has
the scheme and the cut.

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

`scripts/check-fork-consistency.ts` check 15: file names (numbered or fragment),
contiguous numbers, the `# N.` heading matching the name, the line cap and its
ratchet, FORK.md under its byte ceiling and carrying no numbered section at any
heading level, the index between FORK.md's markers equal to what
`scripts/fork-index.ts` renders from this directory's numbered files (a
fragment changes nothing there), and every "FORK.md change
N" / "FORK change N" / `changes/NNN` / "NNN change M" citation in a file git
tracks or would track — and every "change N" in the record itself — naming a
number with a file (or a row of the 1–17 table). Check 16 holds the fragment
shape; check 17 the changelog, the release pairing and the frozen migrations.
