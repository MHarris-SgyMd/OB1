#!/usr/bin/env python3
"""conformance.py (SMD-3058) — does jev/h2o/serve.py read H2O-Lightning-4B as H2O's own shim does?

For the 3,474 questions behind its card's routing table, H2O publishes the questions as the model saw them and each
one's label log-probabilities from the shipped shim over vLLM (h2oai/h2o-lightning-4b, routing_reproducibility/, made
at v1.2.3, the revision serve.py loads). This reads a stratified sample through serve.py's Reader (the prompt, the
readout, the temperatures) and compares the top answers, the probabilities at the shipped temperatures, and the
accuracy on the sample both ways. H2O's own two passes over one vLLM server differ by a median 0.0005 in probability,
a 99th percentile of 0.016 and 9 of 3,474 top answers (its README), so the port passes at 98% of top answers and a
median gap of at most 0.01.

  ~/decider-probe/.venv/bin/python -I jev/h2o/conformance.py <routing_reproducibility dir> [--n 300] [--seed 3058] [--out f.jsonl]
"""
import argparse, importlib.util, json, random, statistics, sys, time
from pathlib import Path

spec = importlib.util.spec_from_file_location("h2o_serve", Path(__file__).with_name("serve.py"))
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)


def desc_text(v):
    return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)


def question(row):
    """(instructions, option names, descriptions) as the shim's options_of builds them, in the row's option order."""
    c, typ = row["criteria"], row["question_type"]
    if typ == "noul":
        t, f = c.get("true", c.get("yes")), c.get("false", c.get("no"))
        return row["instructions"], ["true", "false"], [desc_text(t) if t not in (None, "") else "the statement holds",
                                                        desc_text(f) if f not in (None, "") else "it does not"]
    if typ == "score":
        return row["instructions"], [str(i) for i in range(len(c))], [desc_text(x) for x in c]
    return row["instructions"], list(row["options"]), [desc_text(c[n]) if c[n] is not None else n for n in row["options"]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--seed", type=int, default=3058)
    ap.add_argument("--out")
    a = ap.parse_args()
    d = Path(a.dir)
    preds = {(r["dataset"], r["source_id"], r["converted_row"]): r for r in map(json.loads, open(d / "predictions.jsonl"))}
    rows = [r for f in sorted((d / "questions").glob("*.jsonl")) for r in map(json.loads, open(f))]
    rows = [r for r in rows if (r["dataset"], r["source_id"], r["converted_row"]) in preds]
    groups = {}
    for r in rows: groups.setdefault((r["dataset"], r["question_type"]), []).append(r)
    rng = random.Random(a.seed)
    sample = []
    for k in sorted(groups):  # each group in proportion, at least 10 of it
        g = groups[k]
        sample += rng.sample(g, min(len(g), max(10, round(a.n * len(g) / len(rows)))))
    print(f"{len(rows)} questions with predictions; sampled {len(sample)} across {len(groups)} dataset/type groups", flush=True)

    R = serve.Reader(serve.snapshot(), share=False)
    print(f"reading in {R.dtype}{' with decider MPS kernels' if R.patched else ''}", flush=True)
    out = open(a.out, "w") if a.out else None
    agree, gaps, mine_right, theirs_right, by_type, t0 = 0, [], 0, 0, {}, time.time()
    for j, row in enumerate(sample):
        p = preds[(row["dataset"], row["source_id"], row["converted_row"])]
        instr, names, descs = question(row)
        state, _ = R.truncate_state(row["document"])   # a string state is the record verbatim
        ids = R.encode(R.prompt(state, instr, names, descs))
        typ = row["question_type"]
        raw, probs = R.answer(R.read([ids])[0], len(names), typ)
        theirs = R.answer(p["raw_logprobs_t1"], len(names), typ)[1]   # their raw log-probabilities at the same temperature
        top_m, top_t = probs.index(max(probs)), theirs.index(max(theirs))
        gold = set(p["gold_indices"])
        agree += top_m == top_t
        mine_right += top_m in gold
        theirs_right += top_t in gold
        gap = max(abs(x - y) for x, y in zip(probs, theirs))
        gaps.append(gap)
        bt = by_type.setdefault(typ, [0, 0])
        bt[0] += 1
        bt[1] += top_m == top_t
        if out: out.write(json.dumps({"dataset": row["dataset"], "source_id": row["source_id"], "type": typ, "tokens": len(ids),
                                      "mine": probs, "theirs": theirs, "raw_mine": raw, "raw_theirs": p["raw_logprobs_t1"],
                                      "gap": gap, "agree": top_m == top_t}) + "\n")
        if (j + 1) % 50 == 0: print(f"  {j + 1}/{len(sample)}: {agree} top answers agree; {time.time() - t0:.0f} s", flush=True)
    gaps.sort()
    n = len(sample)
    med, p99 = statistics.median(gaps), gaps[min(n - 1, int(0.99 * n))]
    ok = agree / n >= 0.98 and med <= 0.01
    print(f"top answers agree on {agree}/{n} ({100 * agree / n:.1f}%); largest probability gap per question: median {med:.4f}, "
          f"p99 {p99:.4f}, max {gaps[-1]:.4f}")
    print("  by type: " + ", ".join(f"{t} {v[1]}/{v[0]}" for t, v in sorted(by_type.items())))
    print(f"  accuracy on the sample: this port {mine_right}/{n}, H2O's vLLM read {theirs_right}/{n}; {time.time() - t0:.0f} s")
    print("PASS: the port reads as H2O's shim does" if ok else "FAIL: the port does not read as H2O's shim does")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
