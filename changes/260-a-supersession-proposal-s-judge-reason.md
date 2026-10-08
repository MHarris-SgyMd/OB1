# 260. A supersession proposal's judge reason and review note print on one line each, so neither can forge an `ID:` line (SMD-2533)

**What changed.**
- **`renderSupersessionProposals` in `server-portable/render.ts`.**
  - The reason goes through `snipText`, the one-line cleaner the proposal's two thoughts already go through, and prints behind a `Reason:` label. The judge's words never start a line.
  - The review note goes through `snipText` too, on the status line where it already sat.
  - Both are cut at 400 characters, where `parseJudgement` cuts a reason. The queue's row keeps both whole; the tool's structured value carries neither.
- **`consolidate.ts --list` in `db/consolidate.ts`.** The same text reaches a reviewer's terminal, or an agent reading the CLI's output. Its `snippet` helper is now `snipText`, so a thought's snippet, the reason (behind `reason:`), the review note and `--stale`'s entity names all lose NEL, C1 controls and bidi marks, as the MCP reply does. The reason and the note are cut at the reply's 400 (`PROPOSAL_TEXT_MAX`, now exported); before, `--list` printed a note whole. An entity name is still cut at 50 UTF-16 units with no ellipsis, so the column keeps its width.
- **Why the line breaks got through.** `parseJudgement` (`server-portable/consolidate.ts`) collapses the reason with `cleanForDisplay` and `\s+`. NEL survives both: `\s` does not match it, and `cleanForDisplay` strips the C0 controls but tab, LF and CR, and DEL. A reason recorded by any other caller of `record_supersession_proposal` was never cleaned at all. The review note kept `\n` and `\r`. The reply is now the boundary, whatever the row holds.
- **Readers checked.** The dashboard does not read proposals. `evals/write-path.ts`' `parseProposalIds` reads `ID:` lines, and the e2e checks read words of the reason, not its line. `evals/eval-write-path.ts`' hand-written reply now shows the label.

**Not here.** `parseJudgement` still stores a reason holding a NEL. The renderers clean it on the way out, and the stored text is the judge's own. `--dump` writes the reason into its JSON lines as `JSON.stringify` leaves it, which does not escape NEL; a reader splitting that file with Python's `splitlines()` would break a record. Nothing reads the dump for `ID:` lines. `evals/eval-consolidate.ts` writes the reason raw into the markdown grading sheet a person fills in; nothing reads that sheet for `ID:` lines either.

**Held by**
- **test-server [16j]:** two proposals, one pending and one rejected, under each of the eleven breaks. Each has a reason holding an `ID:` line, a `--- Result 9 ---` line and a proposal line, and the rejected one has a note holding an `ID:` line and an `accept:` line. A third proposal's reason is a break alone. The checks run on the reply split at every break:
  - Each reason is one `Reason:` line, the note sits on the status line, and the break-only reason prints no line at all.
  - Every line starts with one of the reply's own labels.
  - The hook's `RETRIEVED_ID_RE` and the eval's `parseProposalIds` pattern read the pairs' thought ids and no other.
  - With no break at all, a reason of exactly `ID: <uuid>` prints behind its label, and neither reader takes the id.
- **test-live:** a proposal recorded with a reason holding a NEL and a newline, rejected with a `--note` holding the same. `--list rejected` prints the reason on its `reason:` line and the note on the status line, no `ID:` line names the forged id, and both of the pair's own `ID:` lines print.
- **test-live, `--stale`:** the quiet entity's display name, for one call, holds a NEL and an `ID:` line and runs past the column. It lists on one row, cut at 50 with no ellipsis, and no line starts `ID:`. The name is put back after.
- **The mutants** (test-server [16j] holds 12 assertions):

  | Mutant | Assertions that fail |
  |---|---|
  | The reason printed as main printed it | 12 |
  | The reason behind its label, through `cleanForDisplay` | 11 (all but the break-free case) |
  | The reason through `snipText`, with no label | 12 |
  | The note printed as main printed it | 11 (all but the break-free case) |
  | `--list`'s reason printed raw on its own line | 1 (test-live) |
  | `--list`'s note printed raw | 1 (test-live) |
  | `--stale`'s name collapsed with `\s` alone, uncleaned | 1 (test-live) |
  | `--stale` cut at 49 with an ellipsis (pass 1's defect) | 1 (test-live) |
  | `--stale` with no cut | 1 (test-live) |
- **Review pass 1** (a cold reader) found no HIGH or MEDIUM. Its LOWs:
  - `--stale` had moved to a 49-character cut with an ellipsis, measured in code points and padded in UTF-16 units, so a long emoji name ran past the column. It is back to the old cut, with only the cleaning changed, and test-live now holds it.
  - `--list` cut a review note at a literal 400 the fragment did not mention. The bound is now render.ts's exported `PROPOSAL_TEXT_MAX`, named above.
  - This fragment's `cleanForDisplay` wording, a [16j] failure message that showed only the header, and a long README line are fixed.
  - The dump's NEL is named under "Not here".
- **Review pass 2** (a second cold reader) found no HIGH or MEDIUM. Its LOWs:
  - The `--stale` check's name was shorter than the cut, so it held the cleaning and the padding but not the cut. The name now runs past 50.
  - A note cleaned to nothing printed `: ` in `--list` and nothing in the reply. `--list` now tests the cleaned note, as it does the reason.
  - The grading sheet `evals/eval-consolidate.ts` writes is named under "Not here".
- **Tidied after the passes:** the `--list rejected` check named no id of its own; it counted two `ID:` lines, which any other rejected row could supply (pass 1). It now names the pair's two.
