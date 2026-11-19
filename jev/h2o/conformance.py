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
passes at the bar above, over the whole sample and in each of the two long strata on its own, each full, with every
read a probability per option. Yes/no questions are left out: that run applied the shim's yes/no floor (0.801), which
this port never applies. So is a row answered from more than one read.

  H2O_REVISION=v1.4.2 ~/decider-probe/.venv/bin/python -I jev/h2o/conformance.py --two-way results.jsonl.gz [--n 60] [--seed 4369] [--out f.jsonl]
"""
import argparse, gzip, importlib.util, json, random, statistics, sys, time, unicodedata
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


# The two-way sample's strata, by the prompt's count in this tokenizer's tokens: (name, from, below). The last runs to
# the tier's own two-way limit and takes a prompt of exactly that length, which the tier reads. The last two are the
# lengths decide mode's pairs run to, and each must pass on its own, full.
TWO_WAY_FLOORS = (0, 500, 2000, 4300)
TWO_WAY_CHUNK = 2000    # rows fetched at a time, in the shuffled order: the file is read again for each, never held whole
TWO_WAY_MIN_EACH = 50   # the fewest questions a stratum that the bar can be asked of: at 98%, fewer allow no miss at all


def two_way_strata(limit):
    """[(name, from, below)] up to the tier's two-way limit (H2O_TWO_WAY_MAX_TOKENS, as the tier itself reads it), so
    the arm compares reads as long as the tier will make and none it will not (review pass 3: a fixed 8,000 passed a
    tier set to 12,000 on reads no longer than 8,000)."""
    if limit <= TWO_WAY_FLOORS[-1]:
        sys.exit(f"the two-way limit is {limit} tokens; the arm's long strata start at {TWO_WAY_FLOORS[-1]}, the length of the pairs it is for")
    bounds = TWO_WAY_FLOORS + (limit,)
    return [("under 500" if lo == 0 else f"{lo:,} to {hi:,}", lo, hi) for lo, hi in zip(bounds, bounds[1:])]


def passes(n, agree, median):
    """The bar of both arms: at least 98% of top answers agree, and the median largest gap is at most 0.01."""
    return n > 0 and agree / n >= 0.98 and median <= 0.01


def probabilities_of(v, names):
    """The answer's probability per option in the options' order, or None when it is not one: a missing or extra
    option, or a value that is no number in [0, 1] (a NaN among them, which JSON as Python reads it allows)."""
    if not isinstance(v, dict) or sorted(v) != sorted(names): return None
    if not all(serve.is_probability(v[k]) for k in names): return None   # serve.py's own rule for a recorded answer
    return [float(v[k]) for k in names]


def rendered(q):
    """(instructions, option names, descriptions) of one of a request's questions as the shim's options_of and
    render_instr build them, or None for a question that is no object or of a shape this port does not render."""
    if not isinstance(q, dict): return None
    c, typ = q.get("criteria"), q.get("type", "choice")
    instr = q.get("instructions", "")   # render_instr, to the letter: a string as it is, else json.dumps(v, indent=1)
    instr = instr if isinstance(instr, str) else json.dumps(instr, indent=1)
    if typ == "noul":
        c = c if isinstance(c, dict) else {}
        t, f = c.get("true", c.get("yes")), c.get("false", c.get("no"))
        return instr, ["true", "false"], [desc_text(t) if t not in (None, "") else "the statement holds", desc_text(f) if f not in (None, "") else "it does not"]
    if typ == "score" and isinstance(c, list) and c:
        return instr, [str(i) for i in range(len(c))], [desc_text(x) for x in c]
    if typ == "choice" and isinstance(c, dict) and len(c) >= 2:
        names = list(c)
        return instr, names, [desc_text(c[k]) if c[k] is not None else k for k in names]
    return None


def two_way_question(row):
    """What the arm compares of one of H2O's result rows, or the reason it is left out: (question id, instructions,
    option names, descriptions, H2O's probabilities, the tokens H2O's engine read for the whole request or None, the
    request's other questions rendered, or None when one cannot be).

    A row's first choice question whose answer is a probability per option: answered two-way, from one read, of a
    record and question H2O read whole, and of texts a tokenizer can be handed."""
    if not isinstance(row, dict):
        return "not a row"
    resp, payload = row.get("response"), row.get("payload")
    if row.get("status") != "ok" or not isinstance(resp, dict) or not isinstance(payload, dict):
        return "not answered"
    if resp.get("attention_mode") != "bidirectional":
        return "a one-way row"
    questions, answers, effort = payload.get("questions"), resp.get("answers"), resp.get("effort_used")
    if not isinstance(questions, dict) or not isinstance(answers, dict):
        return "not answered"
    # The shim says when it cut or selected a record or a question to fit (effort_used.state_selection, absent on a
    # request that fits). Its token counts do not: usage.input_tokens stays the full input's (review pass 3).
    if isinstance(effort, dict) and effort.get("state_selection"):
        return "a record or question H2O cut to fit"
    # ... and which questions it answered from two reads blended, the Decision Index profile's re-read:
    # effort_used.reread.questions. passes_per_decision is 1 on every response and says nothing (review pass 3).
    reread = effort.get("reread") if isinstance(effort, dict) else None
    blended = reread.get("questions") if isinstance(reread, dict) else reread
    for qid, q in questions.items():
        if not isinstance(q, dict) or q.get("type", "choice") != "choice": continue
        got, ans = rendered(q), answers.get(qid)
        if got is None or not isinstance(ans, dict): continue
        instr, names, descs = got
        theirs = probabilities_of(ans.get("probabilities"), names)
        if theirs is None: continue
        if blended and (not isinstance(blended, (list, tuple, set, dict)) or qid in blended):
            return "answered from more than one read"
        others = [rendered(o) for k, o in questions.items() if k != qid]
        texts = [serve.probe_state(payload.get("state")), instr, *names, *descs]
        for o in others:
            if o is not None: texts += [o[0], *o[1], *o[2]]
        # a lone surrogate, which JSON lets through, is nothing a tokenizer reads: the row is left out here, not met
        # as a crash once the model has loaded (review pass 2)
        if not all(serve.encodable(t) for t in texts):
            return "cannot be encoded"
        usage = resp.get("usage")
        count = usage.get("processed_input_tokens") if isinstance(usage, dict) else None
        return (qid, instr, names, descs, theirs, count if isinstance(count, int) and not isinstance(count, bool) else None,
                None if any(o is None for o in others) else others)
    return "no choice question"


def two_way_index(path):
    """(the line numbers of the rows the arm can compare, how many it leaves out by reason). The file is read through
    once and nothing of it is kept. It needs no model, so it runs before one is loaded: a path that is not there, a
    download cut short or a file that is not this one stops the run here."""
    lines, skipped = [], {}
    try:
        with gzip.open(path, "rt", encoding="utf-8") as f:
            for line_no, line in enumerate(f):
                try:
                    got = two_way_question(json.loads(line))
                except ValueError:   # a blank line, or one that is not JSON
                    got = "not a row"
                if isinstance(got, str): skipped[got] = skipped.get(got, 0) + 1
                else: lines.append(line_no)
    except (OSError, EOFError, UnicodeDecodeError) as e:
        sys.exit(f"{path} cannot be read as H2O's results.jsonl.gz ({type(e).__name__}: {str(e)[:120]})")
    return lines, skipped


def two_way_rows(path, wanted):
    """{line number: (the record as the shim renders it, *two_way_question's seven)} for the wanted lines, each one a
    line two_way_index kept."""
    out = {}
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line_no, line in enumerate(f):
            if line_no in wanted:
                row = json.loads(line)
                out[line_no] = (serve.probe_state(row["payload"].get("state")), *two_way_question(row))
                if len(out) == len(wanted): break
    return out


def stratum_of(tokens, limit, strata):
    """The stratum a prompt of this many tokens falls in, or None over the limit. The last stratum takes a prompt of
    exactly its upper bound when that is the limit: the tier reads one."""
    if tokens > limit: return None
    for name, lo, hi in strata:
        if lo <= tokens < hi or (tokens == hi == limit): return name
    return None


def stratify(order, fetch, prompt_of, encode, n_each, limit, strata, chunk=TWO_WAY_CHUNK):
    """Fill each stratum with the first n_each prompts of its length, taking the rows in `order`: ({stratum: [(line,
    question id, option names, token ids, H2O's probabilities, the tokens H2O's engine read for the request, the
    tokens this port counts for it)]}, prompts over the limit, prompts tokenized).

    A prompt is tokenized unless it cannot reach any stratum still short: a token is at least one byte of the text
    the tokenizer reads, so a prompt of fewer bytes than the lowest such stratum's floor has fewer tokens than it. The
    tokenizer normalizes to NFC first, which can lengthen a text (serve.py's state_tokens: U+FB2C is three bytes and
    four tokens), so the bytes counted are the NFC text's (review pass 2: the raw text's passed such a prompt by). So
    a record of digits or CJK, or a short record under a long question, is counted like any other (review pass 1: a
    guess of three to six characters a token, on the record alone, kept such rows out of the long strata).

    A row taken is counted whole, as H2O's two-way engine read it: every question of the request is a prompt of its
    own, the record read again for each. A request with a question this port cannot render has no count (None)."""
    take = {name: [] for name, _, _ in strata}
    over_limit = counted = 0
    for at in range(0, len(order), chunk):
        if all(len(v) >= n_each for v in take.values()): break
        part = order[at:at + chunk]
        rows = fetch(set(part))
        for line_no in part:
            short = [lo for name, lo, _ in strata if len(take[name]) < n_each]
            if not short: break
            state, qid, instr, names, descs, theirs, their_count, others = rows[line_no]
            text = prompt_of(state, instr, names, descs)
            if len(unicodedata.normalize("NFC", text).encode("utf-8")) < min(short): continue
            ids = encode(text)
            counted += 1
            name = stratum_of(len(ids), limit, strata)
            if name is None: over_limit += 1
            elif len(take[name]) < n_each:
                mine = None if others is None else len(ids) + sum(len(encode(prompt_of(state, *o))) for o in others)
                take[name].append((line_no, qid, names, ids, theirs, their_count, mine))
    return take, over_limit, counted


def two_way_verdicts(report, overall, n_each, unread, uncounted, miscounted, long):
    """{what: passed} for the arm, from {stratum: (questions, top answers agreeing, median gap)} and the same three
    over the whole sample: the whole sample; each long stratum on its own, which must be full (a stratum of one
    question would pass on it); no read that was not a probability per option (a NaN's gap sorts anywhere and its
    top answer can agree by accident); and every request read counted, in tokens, as H2O's engine counted what it
    read. A request the port renders differently, or a record the engine read in part, is no read to compare, and one
    with no count to compare is not shown to be either (review pass 3: a sample with no counts passed on none)."""
    out = {"every read a probability per option": unread == 0,
           "every request counted as H2O's engine read it": uncounted == 0 and miscounted == 0,
           "all": passes(*overall)}
    for name in long:
        r = report.get(name)
        out[f"{name}, {n_each} questions"] = r is not None and r[0] >= n_each and passes(*r)
    return out


def two_way(a):
    """The two-way arm: exit 0 when the read matches H2O's published two-way reads at the bar, over the whole sample
    and in each long stratum."""
    n_each, seed = 60 if a.n is None else a.n, 4369 if a.seed is None else a.seed
    if n_each < TWO_WAY_MIN_EACH:
        sys.exit(f"--n is at least {TWO_WAY_MIN_EACH} a stratum for the two-way arm: the bar asks 98% of top answers, and a long stratum of fewer could pass on a handful")
    limit = serve.knob("H2O_TWO_WAY_MAX_TOKENS", serve.DEFAULT_TWO_WAY_MAX_TOKENS)
    strata = two_way_strata(limit)
    long = [name for name, _, _ in strata[-2:]]
    try:
        serve.two_way_revision_check()   # another revision stops here, on a few kilobytes, before its weights or the file are read
    except SystemExit as e:
        sys.exit(f"{e}\nThe two-way arm reads a revision trained for it: set H2O_REVISION (v1.4.2 is the one H2O's results file was read with).")
    order, skipped = two_way_index(a.two_way)   # and the file before the model: it needs none
    print(f"{len(order)} rows with a two-way choice answer; left out: {skipped}", flush=True)
    t0 = time.time()
    R = serve.Reader(serve.snapshot(), share=False, attention="two-way", two_way_max=limit)
    print(f"revision {serve.REVISION}, {R.dtype}{' with decider MPS kernels' if R.patched else ''}, two-way limit {R.prompt_limit}; loaded in {time.time() - t0:.0f} s", flush=True)
    ok, gap, sep, why = R.two_way_matches()
    print(f"H2O's probes: {'matched' if ok else 'NOT matched: ' + str(why)} (gap {gap:.4f}, separation {sep:.4f})", flush=True)
    if not ok:
        sys.exit(2)
    random.Random(seed).shuffle(order)
    take, over_limit, counted = stratify(order, lambda wanted: two_way_rows(a.two_way, wanted), R.prompt, R.encode, n_each, R.prompt_limit, strata)
    print("sampled: " + ", ".join(f"{name} {len(v)}" for name, v in take.items()) + f"; {over_limit} prompts over the limit not read; {counted} prompts counted", flush=True)

    out = open(a.out, "w") if a.out else None
    report, all_gaps, unread, uncounted, miscounted = {}, [], 0, 0, 0
    try:
        for name, _, _ in strata:
            gaps, agree, secs = [], 0, 0.0
            for line_no, qid, names, ids, theirs, their_count, mine_count in take[name]:
                uncounted += their_count is None or mine_count is None
                miscounted += their_count is not None and mine_count is not None and their_count != mine_count
                t = time.time()
                probs = R.answer(R.read([ids])[0], len(names), "choice")[1]
                secs += time.time() - t
                read = serve.is_read(probs, len(names))
                if not read:
                    unread += 1   # counted against the stratum as a wrong answer at the largest gap there is
                    g, same = 1.0, False
                else:
                    g = max(abs(x - y) for x, y in zip(probs, theirs))
                    same = probs.index(max(probs)) == theirs.index(max(theirs))
                gaps.append(g)
                agree += same
                # a read that is no probability is written as null: a NaN is not JSON, and this is the line to read
                if out: out.write(json.dumps({"stratum": name, "line": line_no, "question": qid, "tokens": len(ids), "options": len(names),
                                              "request_tokens": mine_count, "their_request_tokens": their_count,
                                              "mine": probs if read else None, "theirs": theirs, "gap": g, "agree": same}) + "\n")
            if gaps:
                gaps.sort()
                n = len(gaps)
                report[name] = (n, agree, statistics.median(gaps))
                all_gaps += gaps
                print(f"  {name:>15} tokens: {agree}/{n} top answers agree ({100 * agree / n:.1f}%); gap median {report[name][2]:.4f}, "
                      f"max {gaps[-1]:.4f}; {secs / n:.2f} s a read", flush=True)
    finally:
        if out: out.close()
    if not all_gaps:
        print("FAIL: no question was read")
        sys.exit(1)
    all_gaps.sort()
    n, med = len(all_gaps), statistics.median(all_gaps)
    all_agree = sum(r[1] for r in report.values())
    print(f"all {n}: {all_agree}/{n} top answers agree ({100 * all_agree / n:.1f}%); gap median {med:.4f}, max {all_gaps[-1]:.4f}"
          + (f", 99th percentile {all_gaps[int(0.99 * n)]:.4f}" if n >= 200 else ""))
    print(f"the requests: {n - uncounted - miscounted} of {n} count, in tokens, what H2O's engine read"
          + (f"; {miscounted} count otherwise" if miscounted else "") + (f"; {uncounted} have no count to compare" if uncounted else ""))
    verdicts = two_way_verdicts(report, (n, all_agree, med), n_each, unread, uncounted, miscounted, long)
    print("the bar (98% of top answers, median gap at most 0.01): " + "; ".join(f"{k}: {'PASS' if v else 'FAIL'}" for k, v in verdicts.items()))
    ok = all(verdicts.values())
    print("PASS: the port's two-way read is H2O's, at length" if ok else "FAIL: the port's two-way read is not shown to be H2O's at length")
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
    a.n, a.seed = 300 if a.n is None else a.n, 3058 if a.seed is None else a.seed
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
