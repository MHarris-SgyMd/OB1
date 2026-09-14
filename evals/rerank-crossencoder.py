#!/usr/bin/env python3
"""rerank-crossencoder.py — the purpose-built cross-encoder arm of the SMD-1304
reranker re-look, kept out of rerank-spike.ts on purpose.

BAAI/bge-reranker-v2-m3 is the local analog of the hosted Voyage rerank-2.5 that
GBrain uses. It scores (question, candidate) pairs directly (a cross-encoder,
unlike the fork's bi-encoder retrieval), reorders the candidate pool, takes 5,
and reports strict recall_all@5 for the multi-session + temporal slices.

The result, on the LongMemEval load with headroom (oracle@30 is 99.2% / 95.3%):
the cross-encoder is flat-to-NEGATIVE, and worse with more context —

    reranker of the top-30 pool          multi-session @5   temporal @5
    baseline (qwen3-embedding:0.6b)          79.3%             79.5%
    bge-reranker-v2-m3, max_length 512       73.6%             79.5%
    bge-reranker-v2-m3, max_length 2048      66.9%             71.7%

because the misses are multi-hop counting/comparison questions ("how many
projects have I led", "how many days between X and Y"): every session on the
topic is equally relevant, so per-document reranking cannot pick the gold
instances, and a longer window only surfaces more spurious topical matches that
demote the true golds. See evals/README.md and FORK.md.

That this needs a torch env at all — Ollama serves no reranker, and the fork's
Python is too new for torch wheels — is itself part of the finding: a real
reranker is not in the local-by-default stack. Run it with uv, off the pool dump
that rerank-spike.ts writes:

    OB1_RERANK_POOL_OUT=/tmp/rr-pool.json OB1_RERANK_ARMS=baseline OB1_RERANK_POOL=30 \
      DATABASE_URL=... OB1_EVAL_LME=... OB1_EVAL_LME_MAP=... bun evals/rerank-spike.ts
    # The 512-token row above: short doc window (~500 tokens fed).
    RR_POOL_FILE=/tmp/rr-pool.json CE_MAXLEN=512 CE_DOC_CHARS=2000 \
      uv run --no-project --python 3.12 --with sentence-transformers \
      python evals/rerank-crossencoder.py
    # The 2048-token row: near-whole session fed (CE_DOC_CHARS=9000 ≈ 2200 tokens),
    # so max_length actually binds. This is the run that drops MS to 66.9%.
    RR_POOL_FILE=/tmp/rr-pool.json CE_MAXLEN=2048 CE_DOC_CHARS=9000 \
      uv run --no-project --python 3.12 --with sentence-transformers \
      python evals/rerank-crossencoder.py

CE_MAXLEN caps the (query+doc) pair in TOKENS; CE_DOC_CHARS caps the doc in CHARS
BEFORE tokenization. The 512-token result feeds only ~500 tokens, so raising only
CE_MAXLEN changes nothing — the doc window has to grow with it for more context to
reach the model, which is why the two rows above set both.
"""
import json, os, time

POOLF = os.environ["RR_POOL_FILE"]                 # written by rerank-spike.ts
MAPF = os.environ.get("RR_MAP_FILE", POOLF + ".map")
DOC_CHARS = int(os.environ.get("CE_DOC_CHARS", "2000"))
MAXLEN = int(os.environ.get("CE_MAXLEN", "512"))
MODEL = os.environ.get("CE_MODEL", "BAAI/bge-reranker-v2-m3")

pool = json.load(open(POOLF))
id_to_sids = json.load(open(MAPF))  # thought id -> [session id, ...]
# The dump already holds exactly OB1_RERANK_POOL candidates per question; rerank
# all of them so the depth is the dump's, never a second, uncoupled CE_POOL that
# could silently rerank a different number than the printed label. A CE_POOL env
# is intentionally not read.
POOL = max(len(p["cands"]) for p in pool)

from sentence_transformers import CrossEncoder
import torch
dev = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
print(f"model={MODEL} device={dev} pool={POOL} max_length={MAXLEN} doc_chars={DOC_CHARS} questions={len(pool)}", flush=True)
model = CrossEncoder(MODEL, max_length=MAXLEN, device=dev)


def strict_top(ids, p, k=5):
    hay, gold = set(p["hay"]), set(p["gold"])
    sids = []
    for tid in ids:
        for sid in id_to_sids.get(tid, []):
            if sid in hay and sid not in sids:
                sids.append(sid)
    top = set(sids[:k])
    return all(g in top for g in gold)


agg, t0 = {}, time.time()
for i, p in enumerate(pool):
    cands = p["cands"][:POOL]
    pairs = [[p["question"], p["contents"][cid][:DOC_CHARS]] for cid in cands]
    scores = model.predict(pairs, batch_size=8, show_progress_bar=False)
    order = sorted(range(len(cands)), key=lambda j: float(scores[j]), reverse=True)
    ranked = [cands[j] for j in order]
    a = agg.setdefault(p["type"], [0, 0])
    a[1] += 1
    if strict_top(ranked, p):
        a[0] += 1
    if (i + 1) % 25 == 0:
        print(f"  {i+1}/{len(pool)}  {time.time()-t0:.0f}s", flush=True)

print(f"\n{MODEL} cross-encoder rerank of top-{POOL} -> take 5, strict recall_all@5:", flush=True)
for t, (hit, n) in agg.items():
    print(f"  {t:20s} {100*hit/n:.1f}% ({hit}/{n})", flush=True)
print("  (baseline MS 79.3%, temporal 79.5%; oracle@30 MS 99.2%, temporal 95.3%)", flush=True)
print(f"  {time.time()-t0:.0f}s total for {len(pool)} questions on {dev}", flush=True)
