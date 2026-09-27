#!/usr/bin/env python3
# decide_entities_2d.py (SMD-1961) — decider-4b in the INTENDED two-decision framing:
# a validity gate (yes/no) + a 6-way type choice, both in one decide() pass, so the
# "not an entity" option no longer competes against the type options. Times each call.
#   ~/decider-probe/.venv/bin/python decide_entities_2d.py <sheet.jsonl> <out.json>
import json, sys, time
from huggingface_hub import snapshot_download
from decider.infer import Decider

sheet, outpath = sys.argv[1], sys.argv[2]
TYPES = ["tool", "topic", "project", "person", "organization", "place"]

path = snapshot_download("Mapika/decider-4b")
t0 = time.time()
d = Decider(path, device="mps")
load_ms = (time.time() - t0) * 1000

items = [json.loads(l) for l in open(sheet).read().splitlines() if l.strip()]
d.decide(items[0]["context"] or items[0]["name"], [{"question": "warmup?", "options": ["a", "b"]}])

results = {}
for i, it in enumerate(items):
    name, ctx = it["name"], (it["context"] or it["name"])
    q = [
        {"question": f'Is "{name}" a specific named entity (a tool, topic, project, person, organization, or place) in this text?', "options": ["yes", "no"]},
        {"question": f'What type of entity is "{name}"?', "options": TYPES},
    ]
    t = time.time()
    r = d.decide(ctx, q)
    ms = (time.time() - t) * 1000
    valid = r[0]["choice"] == "yes"
    type_choice = r[1]["choice"]
    # scorer-compatible: choice is the type when valid, else the sentinel
    results[it["item"]] = {
        "choice": type_choice if valid else "not a named entity",
        "confidence": r[0].get("confidence"),
        "valid_conf": r[0].get("confidence"), "type_choice": type_choice, "type_conf": r[1].get("confidence"),
        "ms": ms,
    }
    if (i + 1) % 50 == 0:
        print(f"  {i+1}/{len(items)}", file=sys.stderr, flush=True)

json.dump({"model": "decider-4b-2d", "device": "mps", "load_ms": load_ms, "n": len(results), "results": results}, open(outpath, "w"))
print(f"[done] {len(results)} two-decision calls, model load {load_ms:.0f} ms -> {outpath}", flush=True)
