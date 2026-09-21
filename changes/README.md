# changes/ — release fragments

One file per pull request, `changes/<ticket>.md` (e.g. `changes/smd-1804.md`),
carrying the change as it is written today. The release step assembles the
fragments in merge order into `FORK.md` (as numbered `### N.` sections) and
`CHANGELOG.md` (Keep a Changelog 1.1.0), assigning the change number and the
release version **once**, at assembly — so a merge of `main` while a PR is in
review can no longer renumber a section or its cross-references. See FORK.md's
"Versioning" section for the scheme and `CONTRIBUTING.md` for when a fragment is
required.

## Shape

```markdown
---
type: added        # one of: added | changed | deprecated | removed | fixed | security  (Keep a Changelog's six)
bump: minor        # one of: major | minor | patch  (the version rules in FORK.md; a `patch` that ships a migration is refused)
tickets: [SMD-1804]        # one or more SMD-#### ids
migrations: [044]          # the migration numbers this change adds, or [] for none
---

## Changelog

One to three lines for the changelog page, ending in the ticket and migration
numbers.

## FORK

The FORK.md section as written today — the why, what was measured, what was
declined — **without** a change number. Its FIRST line is the section title (what
follows `### N. ` in FORK.md, ending in the ticket), then a blank line, then the
body. Cite ticket and migration numbers, which are stable; the release step
assigns the change number, so a fragment cannot cite one.
```

`check-fork-consistency` validates every fragment (the six types, a bump the
migrations allow, both bodies present, no change-number citation). `releases.json`
at the repo root is the machine-readable record the release step appends to; a
committed release freezes the shas of the migrations in its range.
