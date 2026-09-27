#!/usr/bin/env python3
# decide_entities.py (SMD-1961) — run decider-4b as an entity validity+type decider
# over the blind grading sheet, timing each decision. Runs on the host via the
# ~/decider-probe venv (MPS). Blind: reads only the sheet, never the gold.
#   ~/decider-probe/.venv/bin/python decide_entities.py <sheet.jsonl> <out.json>
import json, sys, time
from huggingface_hub import snapshot_download
from decider.infer import Decider

sheet, outpath = sys.argv[1], sys.argv[2]
OPTS = ["tool", "topic", "project", "person", "organization", "place", "not a named entity"]

path = snapshot_download("Mapika/decider-4b")
t0 = time.time()
d = Decider(path, device="mps")
load_ms = (time.time() - t0) * 1000

items = [json.loads(l) for l in open(sheet).read().splitlines() if l.strip()]
# warmup (first call pays graph/kernel init; keep it out of the timings)
d.decide(items[0]["context"] or items[0]["name"], [{"question": "warmup?", "options": ["a", "b"]}])

results = {}
for i, it in enumerate(items):
    q = [{"question": f'In this text, what is "{it["name"]}"?', "options": OPTS}]
    ctx = it["context"] or it["name"]
    t = time.time()
    r = d.decide(ctx, q)
    ms = (time.time() - t) * 1000
    o = r[0]
    results[it["item"]] = {"choice": o["choice"], "confidence": o.get("confidence"), "ms": ms}
    if (i + 1) % 50 == 0:
        print(f"  {i+1}/{len(items)}", file=sys.stderr, flush=True)

json.dump({"model": "decider-4b", "device": "mps", "load_ms": load_ms, "n": len(results), "results": results},
          open(outpath, "w"))
print(f"[done] {len(results)} decisions, model load {load_ms:.0f} ms -> {outpath}", flush=True)
