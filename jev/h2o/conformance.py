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

The two-way read (SMD-4369) has a reference of its own. H2O publishes its per-row results on the Decision Index 0.3
public suite (the dataset h2oai/h2o-lightning-4b-decision-index, runs/h2o-lightning-4b/results.jsonl.gz): each request
as sent and the probabilities answered, read two-way on vLLM at v1.4.1, whose weights v1.4.2 keeps. `--two-way` draws
choice questions from it by seed in four strata of prompt length, up to the adapter's two-way limit, reads each two-way
through serve.py's Reader, and compares the probabilities at the shipped temperature. serve.py's start-up guard holds
the read on three probes of about a hundred tokens; this holds it at the length of the pairs decide mode sends. It
passes at the bar above, over the whole sample and in each of the two long strata on its own. Yes/no questions are left
out: that run applied the shim's yes/no floor (0.801), which this port never applies.

  H2O_REVISION=v1.4.2 ~/decider-probe/.venv/bin/python -I jev/h2o/conformance.py --two-way results.jsonl.gz [--n 60] [--seed 4369] [--out f.jsonl]
"""
import argparse, gzip, importlib.util, json, random, statistics, sys, time
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


# The two-way sample's strata, by the prompt's count in this tokenizer's tokens: (name, from, below). The last two are
# the lengths decide mode's pairs run to, and each must pass on its own.
TWO_WAY_STRATA = [("under 500", 0, 500), ("500 to 2,000", 500, 2000), ("2,000 to 4,300", 2000, 4300), ("4,300 to 8,000", 4300, 8000)]
TWO_WAY_LONG = ("2,000 to 4,300", "4,300 to 8,000")


def passes(n, agree, median):
    """The bar of both arms: at least 98% of top answers agree, and the median largest gap is at most 0.01."""
    return n > 0 and agree / n >= 0.98 and median <= 0.01


def two_way_candidates(path):
    """(the rows with a two-way choice answer, what was left out and why), from H2O's results file: a row's first choice
    question whose answer gives a probability per option. (line, the record's characters, the record, question id,
    the question, the answer)"""
    cands, skipped = [], {"no choice question": 0, "not answered": 0, "one-way row": 0}
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line_no, line in enumerate(f):
            row = json.loads(line)
            resp, payload = row.get("response"), row.get("payload") or {}
            if row.get("status") != "ok" or not isinstance(resp, dict):
                skipped["not answered"] += 1
                continue
            if resp.get("attention_mode") != "bidirectional":
                skipped["one-way row"] += 1
                continue
            pick = None
            for qid, q in (payload.get("questions") or {}).items():
                ans, c = (resp.get("answers") or {}).get(qid) or {}, q.get("criteria")
                if (q.get("type", "choice") == "choice" and isinstance(c, dict) and len(c) >= 2
                        and isinstance(ans.get("probabilities"), dict) and sorted(ans["probabilities"]) == sorted(c)):
                    pick = (qid, q, ans)
                    break
            if pick is None:
                skipped["no choice question"] += 1
                continue
            state = serve.probe_state(payload.get("state"))   # the shim's rendering of a record: a string, or compact JSON
            cands.append((line_no, len(state), state, *pick))
    return cands, skipped


def two_way(a):
    """The two-way arm: exit 0 when the read matches H2O's published two-way reads at the bar, over the whole sample
    and in each long stratum."""
    n_each, seed = a.n or 60, 4369 if a.seed is None else a.seed
    cands, skipped = two_way_candidates(a.two_way)
    print(f"{len(cands)} rows with a two-way choice answer; left out: {skipped}", flush=True)
    t0 = time.time()
    R = serve.Reader(serve.snapshot(), share=False, attention="two-way")
    print(f"revision {serve.REVISION}, {R.dtype}{' with decider MPS kernels' if R.patched else ''}, two-way limit {R.prompt_limit}; loaded in {time.time() - t0:.0f} s", flush=True)
    ok, gap, sep, why = R.two_way_matches()
    print(f"H2O's probes: {'matched' if ok else 'NOT matched: ' + str(why)} (gap {gap:.4f}, separation {sep:.4f})", flush=True)
    if not ok:
        sys.exit(2)

    # The rows shuffled by seed, then taken in that order until each stratum is full. A prompt is counted in tokens
    # only when its record's characters leave it a chance of a stratum still short (a token is three to six of them).
    random.Random(seed).shuffle(cands)
    take = {name: [] for name, _, _ in TWO_WAY_STRATA}
    over_limit = counted = 0
    for line_no, nchars, state, qid, q, ans in cands:
        if all(len(v) >= n_each for v in take.values()):
            break
        if not any(len(take[name]) < n_each and nchars / 3.0 >= lo * 0.5 and nchars / 6.0 < hi for name, lo, hi in TWO_WAY_STRATA):
            continue
        names = list(q["criteria"])
        descs = [desc_text(q["criteria"][k]) if q["criteria"][k] is not None else k for k in names]
        instr = q.get("instructions") or ""
        ids = R.encode(R.prompt(state, instr if isinstance(instr, str) else json.dumps(instr, indent=1), names, descs))
        counted += 1
        if len(ids) > R.prompt_limit:
            over_limit += 1
            continue
        for name, lo, hi in TWO_WAY_STRATA:
            if lo <= len(ids) < hi and len(take[name]) < n_each:
                take[name].append((line_no, qid, names, ids, [float(ans["probabilities"][k]) for k in names]))
    print("sampled: " + ", ".join(f"{name} {len(v)}" for name, v in take.items()) + f"; {over_limit} prompts over the limit not read; {counted} prompts counted", flush=True)

    out = open(a.out, "w") if a.out else None
    report, all_gaps, all_agree = {}, [], 0
    for name, _, _ in TWO_WAY_STRATA:
        gaps, agree, secs = [], 0, 0.0
        for line_no, qid, names, ids, theirs in take[name]:
            t = time.time()
            probs = R.answer(R.read([ids])[0], len(names), "choice")[1]
            secs += time.time() - t
            g = max(abs(x - y) for x, y in zip(probs, theirs))
            same = probs.index(max(probs)) == theirs.index(max(theirs))
            gaps.append(g)
            agree += same
            if out: out.write(json.dumps({"stratum": name, "line": line_no, "question": qid, "tokens": len(ids), "options": len(names),
                                          "mine": probs, "theirs": theirs, "gap": g, "agree": same}) + "\n")
        if gaps:
            gaps.sort()
            n = len(gaps)
            report[name] = (n, agree, statistics.median(gaps))
            all_gaps += gaps
            all_agree += agree
            print(f"  {name:>15} tokens: {agree}/{n} top answers agree ({100 * agree / n:.1f}%); gap median {report[name][2]:.4f}, "
                  f"p99 {gaps[min(n - 1, int(0.99 * n))]:.4f}, max {gaps[-1]:.4f}; {secs / n:.2f} s a read", flush=True)
    if not all_gaps:
        print("FAIL: no question was read")
        sys.exit(1)
    all_gaps.sort()
    n, med = len(all_gaps), statistics.median(all_gaps)
    print(f"all {n}: {all_agree}/{n} top answers agree ({100 * all_agree / n:.1f}%); gap median {med:.4f}, p99 {all_gaps[min(n - 1, int(0.99 * n))]:.4f}, max {all_gaps[-1]:.4f}")
    verdicts = {"all": passes(n, all_agree, med)}
    for name in TWO_WAY_LONG:   # a long stratum with no question read fails: the length is what this arm is for
        verdicts[name] = name in report and passes(*report[name])
    print("the bar (98% of top answers, median gap at most 0.01): " + ", ".join(f"{k} {'PASS' if v else 'FAIL'}" for k, v in verdicts.items()))
    ok = all(verdicts.values())
    print("PASS: the port's two-way read is H2O's, at length" if ok else "FAIL: the port's two-way read is not H2O's at length")
    sys.exit(0 if ok else 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir", nargs="?", help="H2O's routing_reproducibility directory (the one-way arm)")
    ap.add_argument("--two-way", metavar="RESULTS", help="H2O's Decision Index results.jsonl.gz (the two-way arm)")
    ap.add_argument("--n", type=int, help="questions to sample: 300 one-way, 60 a stratum two-way")
    ap.add_argument("--seed", type=int, help="3058 one-way, 4369 two-way")
    ap.add_argument("--out")
    a = ap.parse_args()
    if a.two_way:
        if a.dir: ap.error("give the routing_reproducibility directory or --two-way, not both")
        return two_way(a)
    if not a.dir: ap.error("give H2O's routing_reproducibility directory, or --two-way with its Decision Index results file")
    a.n, a.seed = a.n or 300, 3058 if a.seed is None else a.seed
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
    ok = passes(n, agree, med)
    print(f"top answers agree on {agree}/{n} ({100 * agree / n:.1f}%); largest probability gap per question: median {med:.4f}, "
          f"p99 {p99:.4f}, max {gaps[-1]:.4f}")
    print("  by type: " + ", ".join(f"{t} {v[1]}/{v[0]}" for t, v in sorted(by_type.items())))
    print(f"  accuracy on the sample: this port {mine_right}/{n}, H2O's vLLM read {theirs_right}/{n}; {time.time() - t0:.0f} s")
    print("PASS: the port reads as H2O's shim does" if ok else "FAIL: the port does not read as H2O's shim does")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
