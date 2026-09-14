#!/usr/bin/env python3
"""rerank-llm-reranker.py — the causal-LM (yes/no-token) reranker arm of the
SMD-1304 re-look, for the models Ollama cannot serve and sentence-transformers
does not wrap: Qwen3-Reranker (0.6B/4B/8B) and MemReranker (IAAR-Shanghai,
Apache-2.0, distilled from Qwen3-Reranker to be reasoning/calibration-aware).

These score relevance as P("yes") from the last-token logits over the yes/no
tokens (the official Qwen3-Reranker recipe; MemReranker shares the format). It
reranks a pool dump written by rerank-spike.ts (LongMemEval) or rerank-heldout.ts
(the held-out Linear corpus), takes 5, and reports strict recall_all@5 with
any-hit@5 beside it — the two metrics that, read together, show the depth-vs-
breadth trade (see FORK.md and evals/README.md).

What it found (strict / any-hit @5, LongMemEval 0.6b, multi-session):
    baseline 79.3 / 96.7  ·  Qwen3-Reranker-4B 66.1 / 99.2  ·  MemReranker-4B 89.3 / 99.2
A generic cross-encoder raises any-hit and lowers strict (it concentrates on one
gold); MemReranker's calibration recovers strict — but that +10 does NOT reproduce
on the held-out Linear corpus (rerank-heldout.ts), so it is largely benchmark-fit.

Needs a torch env (Ollama serves no reranker; the fork's Python is too new for
torch wheels — itself part of the finding). Run with uv, off a pool dump:

    # LongMemEval pool from rerank-spike.ts, or held-out pool from rerank-heldout.ts
    RR_POOL_FILE=/tmp/rr-pool.json CE_MODEL=IAAR-Shanghai/MemReranker-4B \
      RANKS_OUT=memrr-ranks.json CE_DOC_CHARS=1500 CE_MAXLEN=768 \
      uv run --no-project --python 3.12 --with sentence-transformers --with accelerate \
      python evals/rerank-llm-reranker.py

CE_MODEL       Qwen/Qwen3-Reranker-4B (default) | IAAR-Shanghai/MemReranker-4B | …
CE_DOC_CHARS   doc chars fed before tokenization (the token cap only binds if the
               doc is that long); CE_MAXLEN the token cap; CE_BATCH the batch.
RANKS_OUT      filename (beside the pool) to write the reranked id lists to.
"""
import json, os, time
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

POOLF = os.environ["RR_POOL_FILE"]
MAPF = os.environ.get("RR_MAP_FILE", POOLF + ".map")
POOL = int(os.environ.get("CE_POOL", "30"))
DOC_CHARS = int(os.environ.get("CE_DOC_CHARS", "1500"))
MAXLEN = int(os.environ.get("CE_MAXLEN", "768"))
BATCH = int(os.environ.get("CE_BATCH", "8"))
MODEL = os.environ.get("CE_MODEL", "Qwen/Qwen3-Reranker-4B")
RANKS_OUT = os.environ.get("RANKS_OUT", "llm-reranker-ranks.json")

pool = json.load(open(POOLF))
id_to_sids = json.load(open(MAPF))  # thought/doc id -> [session id, ...] (identity for a doc corpus)

dev = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
dtype = torch.float16 if dev in ("mps", "cuda") else torch.float32
print(f"model={MODEL} device={dev} dtype={dtype} pool={POOL} doc_chars={DOC_CHARS} maxlen={MAXLEN} batch={BATCH} questions={len(pool)}", flush=True)
tok = AutoTokenizer.from_pretrained(MODEL, padding_side="left")
model = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=dtype).to(dev).eval()
token_false = tok.convert_tokens_to_ids("no")
token_true = tok.convert_tokens_to_ids("yes")

prefix = ('<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the '
          'Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n')
suffix = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
pre_ids = tok.encode(prefix, add_special_tokens=False)
suf_ids = tok.encode(suffix, add_special_tokens=False)
INSTR = "Given a question, retrieve the memory sessions that help answer it"


def fmt(q, doc):
    return f"<Instruct>: {INSTR}\n<Query>: {q}\n<Document>: {doc}"


@torch.no_grad()
def score(pairs):
    enc = tok(pairs, padding=False, truncation="longest_first", return_attention_mask=False,
              max_length=MAXLEN - len(pre_ids) - len(suf_ids))
    for i, e in enumerate(enc["input_ids"]):
        enc["input_ids"][i] = pre_ids + e + suf_ids
    enc = tok.pad(enc, padding=True, return_tensors="pt", max_length=MAXLEN)
    enc = {k: v.to(dev) for k, v in enc.items()}
    logits = model(**enc).logits[:, -1, :]
    s = torch.stack([logits[:, token_false], logits[:, token_true]], dim=1)
    s = torch.nn.functional.log_softmax(s, dim=1)
    return s[:, 1].exp().tolist()


def metrics(ids, p, k=5):
    hay, gold = set(p["hay"]), set(p["gold"])
    sids = []
    for tid in ids:
        for sid in id_to_sids.get(tid, []):
            if sid in hay and sid not in sids:
                sids.append(sid)
    top = set(sids[:k])
    return all(g in top for g in gold), any(g in top for g in gold)


ranks_out, agg, t0 = {}, {}, time.time()
outpath = POOLF.rsplit("/", 1)[0] + "/" + RANKS_OUT
for i, p in enumerate(pool):
    cands = p["cands"][:POOL]
    pairs = [fmt(p["question"], p["contents"][cid][:DOC_CHARS]) for cid in cands]
    scores = []
    for j in range(0, len(pairs), BATCH):
        scores += score(pairs[j:j + BATCH])
    ranked = [cands[j] for j in sorted(range(len(cands)), key=lambda j: scores[j], reverse=True)]
    ranks_out[p["qid"]] = ranked
    strict, anyhit = metrics(ranked, p)
    a = agg.setdefault(p["type"], [0, 0, 0])   # [strict, any, n]
    a[2] += 1
    a[0] += int(strict)
    a[1] += int(anyhit)
    if dev == "mps":
        torch.mps.empty_cache()   # the MPS memory creep otherwise thrashes a long run
    if (i + 1) % 25 == 0:
        json.dump(ranks_out, open(outpath, "w"))
        print(f"  {i+1}/{len(pool)}  {time.time()-t0:.0f}s", flush=True)

json.dump(ranks_out, open(outpath, "w"))
print(f"\n{MODEL} rerank of top-{POOL} -> take 5:", flush=True)
for ty, (s, an, n) in agg.items():
    print(f"  {ty:20s} strict {100*s/n:.1f}% ({s}/{n})   any-hit {100*an/n:.1f}% ({an}/{n})", flush=True)
print(f"  ranks -> {outpath};  {time.time()-t0:.0f}s total on {dev}", flush=True)
