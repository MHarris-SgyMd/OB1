# 253. The pass's report beside a review is refused — `--accept <id> --dry-run` accepted the proposal (SMD-2405)

**What changed.** In `reviewProblem`, the pure rule the CLI and `run()` share since SMD-2304:
- **`--dry-run` or `--status` beside `--accept` or `--reject`** is refused: "--dry-run writes nothing, and --accept writes a decision; pass one (--list shows the proposal without deciding it)." Before, `WRITES` was true for a decision, the review branch ran, and `review_supersession_proposal` wrote the pointer and its audit row. `DRY_RUN` and `STATUS_ONLY` are only read on the pass's report path, which a review never reaches.
- **`--dry-run` or `--status` beside `--list` or `--stale`** is refused too: "--status reports on the pass, and --list takes the pass's place, so --status would be dropped without a word; pass one." It wrote nothing, but the flag was dropped silently, the class `reviewProblem` already refuses for `--limit` beside `--list` (SMD-2015).
- **`--list` and `--stale` beside a decision** still combine (the ticket's item 3). Both only read, and they run after the decision, so the listing shows it.
- **Option 2, a dry-run decision that reports what it would write, is not taken.** `review_supersession_proposal` has no dry mode, so its checks (`ALREADY_SUPERSEDES`, `WOULD_CYCLE`, `EDITED_SINCE`, the lineage guard) would have to be copied. `--list` already shows each proposal, its flags and the command that decides it.

**Held by:**
- **test-engines.** Four new `run()`-vs-CLI cases, each exit 2 in the same words on both streams, before connecting: `--accept` with `--dry-run`, `--reject` with `--status`, `--status` beside `--list`, and `--dry-run` beside `--stale`. `reviewProblem` admits a decision beside `--list` or `--stale`, and refuses the report beside a decision ahead of a listing beside it.
  - The existing case of a decision beside `--dry-run` under an aborted signal now expects the refusal (2), not 130.
  - On main's `consolidate.ts` the first new case gets past every check and connects to the test listener, which crashes the run.
- **test-live [16].** `--accept <id> --direction newer --dry-run`, and the same with `--status`, each exit 2 with nothing on stdout. The proposal stays `pending`, with no pointer and no audit row; the same accept without the flag is made next and is written.
