# 239. Reference-list windows: measure the failure shape and the two candidate fixes (SMD-2269)

The windows left out of a partial row (SMD-2260) are almost all bibliographies; a bigger model does not fix them (SMD-2000). This measures the failure shape and the candidates before either is assumed.

**What it adds (no worker/default change; the two windowing hooks are off unless an eval sets them).**

- **`evals/eval-reference-windows.ts`** — a read-only measurement over the dogfood
  stable brain: (A) the per-window failure shape on the three residual research
  papers — each malformed window classed cut-at-budget / wrong-shape-JSON / prose
  / aborted-loop from its finish reason and a raw-answer sample; (B) whether
  re-answering each malformed window at ×2/×3 the budget recovers it, and at what
  time cost; (C) a deterministic `looksLikeBibliography` classifier's recall cost
  over the SMD-1961 long-doc corpus (gold-valid entities that live only in a
  flagged window) and its false-positive rate on content windows.
- **`server-portable/entities.ts`** — two inert, off-by-default fields on
  `ExtractWindowing`, matching the file's existing measurement-lever idiom
  (`outputBudget`, `escalateModel`): `budgetTimes` scales a budgeted call's
  `max_tokens` (undefined/1 leaves it as `extractOutputBudget` sizes it), and
  `observe` is a per-window diagnostic sink carrying the finish reason and a raw
  sample the merged `Extraction` does not keep. `windowingFor` sets neither, so
  the worker's call is byte-for-byte unchanged.

**Verdict** (recorded in `evals/README.md`, "Reference-list windows"). The failure is
not what was assumed: of 72 windows, 21 fail first-attempt and none is wrong-shape JSON
or prose — every one is a runaway emitting valid JSON a dense author list runs past. The
shipped read-whole retry rescues the false stream-aborts, leaving only 8 actually left
out of the graph. A larger budget wins (×2 recovers 7 of those 8; 3 of 8 recover just by
dropping the retry's frequency penalty); detecting-and-skipping the bibliography does not
(it flags 0 of the 8 and would discard real author entities). The fix — sizing the budget
by a window's name density — is a named follow-up, not built here.
