# 338. The consolidation judge keeps every pair — neither decider-4b nor H2O-Lightning-4B in front of it holds the 7B's accuracy on the pairs it would settle, H2O failing its confirmation on fresh pairs; decider's adapter now reads past 1,536 tokens (SMD-3058)

**What changed.**
- **`evals/eval-judge-decide.ts`** (new) asks a typed-decision model three questions of every pair in `eval-judge.ts`'s export, read as prompt 4 renders the two thoughts:
  - S, a binary "same subject?";
  - T, a choice among related, evolves, duplicate and outdates;
  - C, a choice among all five verdicts.
- **Two ways to ask:** `--packed` asks S and T in one request, and `--clip N` cuts each thought to its first N characters.
- **Scoring.** It scores a cascade in which the decider settles a pair only when the verdict is not `outdates`, and an LLM judge's saved answers (`eval-judge.ts --out`) stand in for every other pair.
  - Bands are picked from the data, then checked on held-out halves.
  - It reports supersessions lost, model time, agreement with the judge and relations dropped.
  - On the labelled pairs it settles, it reports how often the decider is right beside how often the judge it replaces was.
  - **The reopen rule**, fixed before H2O's run: a band at least as accurate as the judge on the labelled pairs it settles (20 or more), losing no supersession, and cheaper on the candidates than the judge alone. It is swept over 6,246 bands, some settling only some verdicts, and the widest passing band is checked on held-out halves.
  - **The outdates gate**, a one-pass band with no cutoff, is in the sweep. The decider's top verdict settles a pair, however unsure, unless it is `outdates` or P(outdates) passes the ceiling, so the judge reads only the possible supersessions.
  - **Beyond the cascade**, as exploration: the decider's top verdict as the judge itself, and P(outdates) as a supersession flag.
- **`jev/decider/serve.py`** passes its 32,768-token window to every `decide()` call, and reports the real token count and whether the context was cut. With `DECIDER_PACK=1` it answers the decisions of one request that share a context in one call. `jev/decider/README.md` says both.
- **`jev/h2o/serve.py`** (new) serves H2O-Lightning-4B v1.2.3 (Apache-2.0) behind `ob1-jev/1` on PyTorch MPS.
  - It is a port of the text path of H2O's shim, which needs vLLM. It reads the same prompt and the label logits at the answer slot, at the shipped temperatures, without the yes/no floor.
  - A shared context is read once per request, and a start-up check holds that to whole reads.
  - `jev/h2o/conformance.py` checks the port against H2O's own published log-probabilities, and `jev/h2o/README.md` gives the mapping.

**Why.** Every candidate pair costs the judge one LLM call with both thoughts' text. Beside a live call, consolidation is the costliest pass (SMD-3024: a capture took 3.4 times as long), and nearly every pair ends in a verdict that proposes nothing. The question was whether the typed-decision tier could settle those pairs cheaply.

**Measured.** On 444 pairs exported from stable (62 true supersessions, 120 candidates), on the dogfood Mac:
- **The judges.** The 7B catches 2 of 62 at 3.6 s a pair, the 27B 23 at 13.0 s. They give the same verdict on 50% of the candidates.
- **Reading the pair is the cost,** about 1 ms a token for decider-4b and the 7B alike (Ollama's timing: the 7B reads judge prompts at 0.84 ms a token). At full length, a decision costs what the 7B spends reading the same pair, so behind the 7B the cascade costs 4.7 s a pair against 3.6 s.
- **Packing** S and T took 1.97 s against 4.38 s. **Clipping** to 1,500, 600 or 300 characters brings a decision to 0.8, 0.5 or 0.4 s, and the two-pass cascade to 2.7, 2.2 or 1.9 s behind the 7B, and 8.4, 7.5 or 7.1 s behind the 27B.
- **For decider-4b, accuracy is the binding problem.** On every variant, on the labelled pairs it settles, it is right 18–30 points less often than the 7B it replaces, and 35–53 less often than the 27B. Clipping widens the gap. Its errors are "unrelated" for pairs the board links (27 of 39 relates_to at full length) and "duplicate" for true supersessions. Only its 1,500-character run has bands meeting the reopen rule, two, saving 1%, and neither holds on the held-out halves.
- **H2O-Lightning-4B.**
  - **The port.** It matches H2O's own top answers on all 302 sampled questions, with a median probability gap of 0.0009. It reads at 0.69 ms a token in float16 with decider's MPS kernels.
  - **Accuracy.** On the 170 labelled pairs its loosest confident band settles, it is right on 140, against the 7B's 143 and the 27B's 156.
  - **Gated on its confidence, it fails the rule behind the 7B.** A read costs 1.41 s a candidate against 3.76, and the bands that need it to be confident settle at most 18% at the 7B's accuracy.
  - **The outdates gate meets the rule behind the 7B on these pairs**, at ceilings of 0.3 to 0.5. At 0.5 it settles 93% of the candidates, is right on 207 of 240 settled labelled pairs as the 7B is, loses nothing, and costs 1.69 s a candidate, 55% less. On held-out halves it sits on the line: picked on one half, it is a pair short on the other.
  - **Behind the 27B**, a gate settling only evolves, related and duplicate saves 27% at the 27B's accuracy. It holds on one held-out half and loses a supersession on the other.
  - **The confirmation fails.** It was fixed in advance: the gate at 0.5 behind the 7B, on 533 pairs neither spike had seen (179 true supersessions, 234 links, 120 candidates).
    - It is right on 175 of 277 settled labelled pairs against the 7B's 185, at 1.65 s a candidate against 2.86.
    - Ceilings of 0.2–0.5 all trail by 10, and no band meets the rule.
    - The gap is all relates_to links: H2O answers unrelated on 46 of 78, the 7B on 33.
- **The decision.** Both models are declined: neither holds the 7B's accuracy on the pairs it would settle. The same fresh run backs SMD-3114: the 7B proposes none of the 179 true supersessions, and H2O's top verdict proposes 127, with 9 false proposals across the 234 links. `evals/README.md` has the tables.
- **H2O as the judge itself** (exploration after the run). It is right on 259 of 324 labelled pairs (the 7B 239, the 27B 263). It proposes 52 of the 62 true supersessions (2 and 23), with 32 false proposals (3 and 17), at 1.41 s a candidate. On pointer pairs whose newer thought names no supersession, it still answers outdates on 36 of 38.

**Held.**
- `bun eval-judge-decide.ts --self-check`, run in fork-checks.yml ("Judge cascade rules") and `db/ci-parity.sh`, covers:
  - the settle rules: `outdates` never settled, whatever the band; an abstention or the middle band sent on; a band settling only some verdicts;
  - the outdates gate: an unsure top settles, and a P(outdates) over the ceiling, or an `outdates` on top, sends the pair on;
  - the time each framing pays, packed or not, and on the candidates;
  - the pair context, cut from prompt 4's own rendering even when a thought quotes its rules, and `--clip`;
  - the scoring: a settled supersession is lost, and the judge's agreement, relations dropped and added, and the judge's own accuracy on the settled pairs are counted;
  - the reopen rule, each of its four conditions at its edge (a tie with the judge meets it, the judge's own cost misses it), its grid with the gate, and its sweep;
  - the decider as a judge, and the flag at exactly its threshold.
- **Mutants:** twenty-six, each undoing one of those, all fail it.
- **The adapter fix,** checked by hand: a 2,730-token context whose one decisive sentence came last answered "insufficient evidence" (p 0.985) before the fix, and the right answer (p 0.997, 2,731 tokens read) after. 354 of the 444 pairs (80%) are longer than 1,536 tokens.
- **Decider's adapter is deterministic:** C, asked alone in two runs, gave the same answers on all 444 pairs.
- **H2O's port:** `jev/h2o/conformance.py` against H2O's routing set, and the start-up check that a shared read gives the answers of whole reads.

**Not taken.**
- **Building `consolidate.ts --decide`.** Both models are declined.
- **Packing all three questions.** C, packed after T, kept its answer on 5 of 10 trial pairs, so it is always asked alone.
- **Packing on by default.** It moves the second question's answers (T kept its answer on 63% of pairs), so it is opt-in.
- **Running H2O's own shim.** It needs vLLM, which does not run on the Mac; the port reads its prompt and checks against its answers instead.

**Follow-ups.**
- **SMD-2265** (deploying decider-4b) takes the adapter fix and `DECIDER_PACK` as given. Its runtime question no longer decides this one.
- **SMD-3114** measures H2O deciding supersession, with an LLM writing only the proposal. The fresh pairs this gate failed on were exported for its confirmation run.
