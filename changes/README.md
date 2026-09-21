# changes/ — one file per numbered change

[`FORK.md`](../FORK.md) is the front door: the pin, what the fork is for, changes
1–17 as a table, the standing sections, and a generated index of everything here.
Every numbered change from 18 on is one file in this directory. Until change 103
(SMD-1917) they were `### N.` sections of one 1.2 MB, 17,700-line FORK.md that no
context window could hold whole; a reviewer verifying one record read it by grep
and paid for the rest by not knowing what was there.

## Naming

`NNN-<slug>.md` — the change number, three digits, then a lower-case ASCII slug of
the title's first clause. The number is the same one code comments cite as
"FORK.md change N" and `db/README.md`'s migration map cites as "NNN change M";
check 15 fails a citation of a number with no file. Numbers run contiguously
from 18 with no gap and no duplicate — two files carrying one number fail the
check on whichever tree holds both, so two branches taking the same number are
caught at the merge instead of renumbered by hand.

A new change takes the next free number in the directory. `changes/smd-NNNN.md`
is SMD-1804's release fragment — a change that has landed and takes its number
when a release is assembled — and is accepted beside the numbered files; the
index lists it by ticket.

## Shape and cap

The first line is `# N. <title>` — "Thing — consequence (SMD-NNNN)", the house
title. Then, as bold-led paragraphs, in this order, each only if it applies:

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

A file is at most **150 lines**. The 46 files that were over it when the split
landed are listed in check 15's `OVERSIZE_AT_SPLIT` with the line count they had
then, rounded up to ten, and may only shrink: a listed file that fits under the
cap fails until its entry is dropped, and a listed file that grows past its
ceiling fails. [`102-…`](102-every-knob-the-server-reads-reaches.md) is the first
record cut to the shape (470 lines to 119); [`103-…`](103-fork-md-is-the-front-door.md)
is the second.

## History

The text of 18–102 is verbatim from FORK.md at the split, the heading level
changed, with two placements moved: the "second vector store beside Postgres"
design (SMD-1038) sat inside change 19's span and is in
[change 79](079-the-store-measured-against-pgvector.md), the
measurement it pre-registered; "The recurring defect in this fork: a value
defined twice" is a house rule and a standing section of FORK.md. Their history
before the split is FORK.md's: `git log -- FORK.md`, or
`git log -S '<a phrase from the file>' -- FORK.md`. Git does not follow a split of
one file into eighty-five, so `git log --follow` on a change file starts at the
split.

## Held by

`scripts/check-fork-consistency.mjs` check 15: file names, contiguous numbers,
the `# N.` heading matching the name, the line cap and its ratchet, FORK.md
under its byte ceiling and carrying no `### N.` section, the index between
FORK.md's markers equal to what `scripts/fork-index.mjs` renders from this
directory, and every "FORK.md change N" / `changes/NNN` citation in the tree
naming a number with a file (or a row of the 1–17 table).
