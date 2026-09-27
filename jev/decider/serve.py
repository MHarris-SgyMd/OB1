#!/usr/bin/env python3
"""serve.py (SMD-2052) — decider-4b behind the ob1-jev/1 contract.

The typed-decision tier (SMD-2050) serves Verdict v1.4 from jev/serve.ts on
onnxruntime under Bun. SemIf, the ticket's original second model, is gated on
HF (401) and unobtainable; decider-4b (Mapika/decider-4b, an independent Jev
reproduction over Qwen3.5-4B, Apache-2.0) is the obtainable, measured
alternative (SMD-1961: 82.5%/93.1% on the long-doc set). This process serves the
SAME contract (server-portable/jev-contract.ts) over decider's MPS runtime, so a
caller compares decider and Verdict by OB1_JEV_BASE_URL / OB1_JEV_MODEL alone.

  ~/decider-probe/.venv/bin/python jev/decider/serve.py     # serve 127.0.0.1:8021

Endpoints (ob1-jev/1): GET /health, GET /info, POST /decide.
Knobs: JEV_HOST (127.0.0.1), JEV_PORT (8021), DECIDER_MODEL (Mapika/decider-4b).
"""
import hashlib, json, math, os, time
from pathlib import Path
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, PlainTextResponse
import uvicorn
from huggingface_hub import snapshot_download
from decider.infer import Decider

CONTRACT = "ob1-jev/1"
INSUFFICIENT = "__insufficient_evidence__"
INSUFFICIENT_LABEL = "insufficient evidence"
MAX_OPTIONS, MAX_BATCH, MAX_TEXT, MAX_BODY = 24, 64, 20_000, 8 * 2 ** 20
MAX_TOKENS = 32_768  # decider's state limit; our fields (<=20k chars) never truncate
MODEL_NAME = "decider-4b"
REPO = os.environ.get("DECIDER_MODEL", "Mapika/decider-4b")

path = snapshot_download(REPO)
revision = Path(path).name  # snapshots/<commit>/
# weights pin: sha256 of the safetensors index (multi-file model), else the file
idx = Path(path) / "model.safetensors.index.json"
one = Path(path) / "model.safetensors"
wsrc = idx if idx.exists() else one
weights_sha = hashlib.sha256(wsrc.read_bytes()).hexdigest() if wsrc.exists() else "unknown"
# rules fingerprint: the label-building + decider's own per-type calibration (opaque here)
RULES = "decider-ai/1.5.0; labels: binary=[true,false,insufficient], choice=[It is <desc>...,insufficient]; decider applies its own per-type temperature (calibration internal), adapter reports logits=ln(p), temperature=1.0"
rules = hashlib.sha256(RULES.encode()).hexdigest()[:16]

t0 = time.time()
d = Decider(path, device=os.environ.get("DECIDER_DEVICE", "mps"))
d.decide("warmup", [{"question": "warmup?", "options": ["a", "b"]}])  # pay init once
load_ms = (time.time() - t0) * 1000

MODEL_INFO = {
    "name": MODEL_NAME, "source": REPO, "revision": revision,
    "weights_sha256": weights_sha, "calibrator_sha256": "builtin", "rules": rules,
}
INFO = {"contract": CONTRACT, "model": MODEL_INFO, "kinds": ["binary", "choice"],
        "max_options": MAX_OPTIONS, "max_batch": MAX_BATCH, "max_tokens": MAX_TOKENS}

def _text(v):  # the contract's field rule
    return isinstance(v, str) and 0 < len(v.strip()) and len(v) <= MAX_TEXT

def problem(body):
    if not isinstance(body, dict): return "the body is not a JSON object"
    model, decisions = body.get("model"), body.get("decisions")
    if model is not None and not _text(model): return "`model`, when given, is a non-empty string"
    if not isinstance(decisions, list) or not decisions: return "`decisions` is a non-empty array"
    if len(decisions) > MAX_BATCH: return f"{len(decisions)} decisions in one request; at most {MAX_BATCH}"
    for i, dd in enumerate(decisions):
        at = f"decision {i}"
        if not isinstance(dd, dict): return f"{at} is not an object"
        if dd.get("id") is not None and (not isinstance(dd["id"], str) or len(dd["id"]) > MAX_TEXT): return f"{at}: `id` is a string of at most {MAX_TEXT} characters"
        if not _text(dd.get("context")): return f"{at}: `context` is a non-empty string of at most {MAX_TEXT} characters"
        kind = dd.get("kind")
        if kind == "binary":
            if not _text(dd.get("proposition")): return f"{at}: a binary decision's `proposition` is a non-empty string"
        elif kind == "choice":
            opts = dd.get("options")
            if not _text(dd.get("question")): return f"{at}: a choice's `question` is a non-empty string"
            if not isinstance(opts, list) or not opts or len(opts) > MAX_OPTIONS: return f"{at}: a choice has 1 to {MAX_OPTIONS} options"
            seen = set()
            for j, o in enumerate(opts):
                if not isinstance(o, dict) or not _text(o.get("id")) or not _text(o.get("description")): return f"{at}, option {j}: `id` and `description` are non-empty strings"
                if o["id"] == INSUFFICIENT: return f"{at}, option {j}: `{INSUFFICIENT}` is the tier's own option"
                if o["id"] in seen: return f"{at}, option {j}: `{o['id']}` is given twice"
                seen.add(o["id"])
        else:
            return f'{at}: `kind` is "binary" or "choice"'
    return None

def labels_ids(dd):
    if dd["kind"] == "binary":
        p = dd["proposition"]
        return [f"true: {p}", f"false: not {p}", INSUFFICIENT_LABEL], ["true", "false", INSUFFICIENT]
    labels = [f"It is {o['description']}" for o in dd["options"]] + [INSUFFICIENT_LABEL]
    ids = [o["id"] for o in dd["options"]] + [INSUFFICIENT]
    return labels, ids

def result_from(dd, ids, probs_list):
    # decider returns calibrated probabilities; report logits=ln(p) with temperature 1.0
    # so a spike can still recalibrate (divide by a new T, softmax).
    s = sum(probs_list) or 1.0
    probs = [p / s for p in probs_list]
    logits = [math.log(max(p, 1e-9)) for p in probs]
    probabilities = {i: p for i, p in zip(ids, probs)}
    sel_i = max(range(len(probs)), key=lambda k: probs[k])
    selected = ids[sel_i]
    res = {
        "id": dd.get("id"), "kind": dd["kind"], "probabilities": probabilities,
        "selected": selected, "abstained": selected == INSUFFICIENT,
        "p_insufficient": probabilities.get(INSUFFICIENT, 0.0),
        "logits": logits, "temperature": 1.0,
        "tokens": 0, "truncated": False,
    }
    if dd["kind"] == "binary":
        pt, pf = probabilities.get("true", 0.0), probabilities.get("false", 0.0)
        res["p_true"] = (pt / (pt + pf)) if (pt + pf) > 0 else None
    return res

app = FastAPI()

@app.get("/health")
@app.head("/health")
def health(): return PlainTextResponse("ok")

@app.get("/info")
def info(): return JSONResponse(INFO)

@app.post("/decide")
async def decide(req: Request):
    raw = await req.body()
    if len(raw) > MAX_BODY: return JSONResponse({"error": f"the body is over {MAX_BODY} bytes"}, status_code=413)
    try:
        body = json.loads(raw)
    except Exception:
        return JSONResponse({"error": "the body is not JSON"}, status_code=400)
    prob = problem(body)
    if prob: return JSONResponse({"error": prob}, status_code=400)
    if body.get("model") is not None and body["model"] != MODEL_NAME:
        return JSONResponse({"error": f"this service serves {MODEL_NAME}, not {body['model']}"}, status_code=409)
    t = time.time()
    results = []
    try:
        for dd in body["decisions"]:
            labels, ids = labels_ids(dd)
            r = d.decide(dd["context"], [{"question": dd.get("proposition") or dd["question"], "options": labels}])
            results.append(result_from(dd, ids, r[0]["probs_list"]))
    except Exception as e:
        # the contract's 500 shape ({error}), as jev/serve.ts returns on a model failure
        return JSONResponse({"error": f"the model failed: {str(e)[:200]}"}, status_code=500)
    return JSONResponse({"contract": CONTRACT, "model": MODEL_INFO, "results": results, "ms": (time.time() - t) * 1000})

if __name__ == "__main__":
    host, port = os.environ.get("JEV_HOST", "127.0.0.1"), int(os.environ.get("JEV_PORT", "8021"))
    print(f"jev-decider: {MODEL_NAME} ({REPO}@{revision[:8]}) loaded in {load_ms:.0f} ms; serving {CONTRACT} on http://{host}:{port}", flush=True)
    uvicorn.run(app, host=host, port=port, log_level="warning")
