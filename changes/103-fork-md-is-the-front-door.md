# 103. FORK.md is the front door, and every numbered change is one file — `changes/NNN-<slug>.md` with a fixed shape and a 150-line cap, an index generated from the directory, and check 15 holding the sizes, the numbering and every citation of a change number (SMD-1917)

**What changed.** The 85 `### N.` sections FORK.md carried for changes 18–102
are one file each under [`changes/`](README.md), named `NNN-<slug>.md`, the
heading level changed and the text otherwise as it was at the split. FORK.md
keeps the pin, what the fork is for, the 1–17 table, "Files we own", the drift
guards and the standing sections, and carries a **generated index** — one row per
change, the title's first clause and its ticket, linked to the file — between two
marker comments that `scripts/fork-index.mjs` rewrites from the directory, so the
count and the list are never kept by hand. A change file has a shape
(`changes/README.md`: what changed, why, held, measured, a review-pass *table*,
not taken, follow-ups) and a **150-line cap**. Two placements moved at the split:
the "second vector store beside Postgres" design written for SMD-1038 sat inside
change 19's span and is change 79's pre-registered shape, so it is in 79's file
(its two citations in `evals/` follow it); "The recurring defect in this fork: a
value defined twice" is a house rule and is a standing section of FORK.md. Two
long paragraphs of the standing sections that were a change's narrative — the
vendored-content audit's four rules, the SMD-1728 window and attribution fixes —
are a paragraph each, pointing at the change files and the pass commits.
[Change 102](102-every-knob-the-server-reads-reaches.md) is the first record cut
to the shape: 470 lines, eight review-pass paragraphs, to 119 lines with a
22-row findings table; this file is the second.

**Why.** FORK.md was 1,237,711 bytes and 17,705 lines at `main` c6fc294 — about
300k tokens, larger than any context window in use, growing ~100 KB per merged
PR as every review pass appended a paragraph whose facts already sat in the
commit body's `(caught: …)` tags (change 100's tooling reads those from commits,
never from FORK.md). No reader took it whole: every agent that "read FORK.md"
took a slice by grep and paid for the rest by not knowing what was there, and a
reviewer verifying one record re-read a 457-line section on each of eight
passes. The one file also made the numbers hand-kept: every merge of `main`
renumbered a section — change 102 was 100 on its branch — and the 231 code
comments and docs citing "FORK.md change N" kept whatever number a section had
when they were written, wrong silently after a renumber. Nothing read FORK.md
in CI; `check-fork-consistency` mentioned it in five comments.

**Held.** Check 15, a pure `forkLayoutProblems({ entries, forkText, citations })`
over in-memory entries with 20 layout probes and 8 citation-reader probes on
every run: a file under `changes/` is `NNN-<slug>.md` or SMD-1804's
`smd-NNNN.md` fragment (or the README); the numbers run contiguously from 18
with no duplicate, so two branches taking one number fail on the tree that holds
both instead of being renumbered by hand; the first line is `# N. <title>` with
the name's number; a file is at most 150 lines, the 46 over it at the split
listed in `OVERSIZE_AT_SPLIT` with a ceiling they may only shrink under, the list
held stale two ways; FORK.md is under 64 KB (56.4 KB at the split), carries no
`### N.` section, and its index equals what `fork-index.mjs` renders — the
tools.json round-trip; and every citation of a change number in a tracked text
file — "FORK.md change N", "changes N and M", "FORK.md §N", a `changes/NNN`
path, `db/README.md`'s "NNN change M" map, and the bare "change N" the record
itself uses — names a number with a file or a row of the 1–17 table. Seventeen
mutants on the real files bite: an upper-case name; a second file numbered 44;
44 removed; 44's heading saying 45; 44 grown to 168 lines; 19 grown past its
ceiling; 19 shrunk under the cap with its entry left; a `### 104.` left in
FORK.md; one index row edited; FORK.md padded past the ceiling; `deploy/README.md`
citing 175 and `db/README.md`'s map citing 145, each reported at its line; the
dangling, duplicate and wrong-number branches each dropped (the probes name
them); the no-heading branch dropped (its probe throws instead of reporting —
the run still fails); the bare-citation reader dropped. The check's own first run
reported this file's citations of change 103 before the file existed — the
dangling rule on the author.

**Measured after.** FORK.md 57,782 bytes and 764 lines, 86 index rows; `changes/`
86 numbered files and a README, 40 under the cap, 46 listed; the whole script
runs in 0.9 s, check 15 not measurable within it. `bun scripts/fork-index.mjs`
twice leaves no diff. The record of one change, for a reviewer, is one file:
under 4k tokens for the two cut to the shape, the largest legacy file (28, 707
lines) about 12k, against a grep into 1.2 MB before.

**Not taken.** Rewriting the 231 "FORK.md change N" citations to `changes/NNN`
paths — the numbers stay the same and the index maps each to its file, so the
check that N has a file is the whole fix. Cutting the 84 legacy files to the
shape — the ratchet holds them where they are and lets each shrink when
touched. Enforcing the shape's paragraphs — a measurement-only change has no
"Held", and the cap is what stops the sink. `git mv`-style history for the
split: git does not follow one file into eighty-five, so the README says where
the history is (`git log -- FORK.md`, `git log -S`). Numbering at PR time versus
at release: the unpushed SMD-1804 branch assigns numbers when a release is
assembled and ships `changes/<ticket>.md` fragments until then; this change
accepts that name beside the numbered files and lists fragments in the index by
ticket, so 1804's assembler has one directory to write into (a fragment becomes
`NNN-<slug>.md`, and FORK.md's index rather than a FORK.md section) — the two
mechanisms are one, and 1804's check 14 ("FORK.md's counts match its sections")
and its assembler's `renderForkSection` need retargeting to the directory when
that branch merges.

**Follow-ups.** SMD-1804 — retarget the assembler and its FORK-count check to
`changes/`, as above. The two branches in flight with a FORK section (SMD-1541 as
§103, SMD-1901 as §102) convert it to a file, numbered 104 and 105 in merge
order; the duplicate rule catches the collision on whichever merges second.
The house memory rule "re-check main's numbering before merge and push" retires
with this change (SMD-1805's table, first row).

**Upstream status:** not sent — FORK.md and `changes/` are this fork's record;
upstream has neither.
