#!/usr/bin/env python3
"""serve.py (SMD-3058) — H2O-Lightning-4B behind the ob1-jev/1 contract.

H2O-Lightning-4B (h2oai/h2o-lightning-4b, Apache-2.0) is a Qwen3.5-4B fine-tune for typed decisions. H2O serves it
through a standard-library shim in front of vLLM: each question is rendered in the prompt the model was trained on, and
read from the next token's log-probabilities over the options' one-letter labels, at a per-type temperature. vLLM does
not run on this Mac, so this process does the same read on PyTorch MPS: the prompt exactly as the shim renders it
(h2o_lightning_shim.py and serve_config.json at v1.2.3, the revision behind the card's routing table), the label logits
at the answer slot, the shipped temperatures. `conformance.py` checks the port against H2O's own per-question
log-probabilities. It serves the contract of jev/serve.ts and jev/decider/serve.py, so a caller switches models by
OB1_JEV_BASE_URL / OB1_JEV_MODEL alone.

  ~/decider-probe/.venv/bin/python jev/h2o/serve.py     # serve 127.0.0.1:8022

How the contract maps onto H2O's questions:
  choice  the question is the instructions, and each option a line `A) id: description`. A description that begins
          with its own id and a colon (the tier's options are worded for decider's "It is …") loses that prefix, so
          the line does not read `A) unrelated: unrelated: …`.
  binary  a yes/no question in the shape of H2O's own: "Answer true or false based only on the record.", true being
          the proposition and false "It is not the case that " + the proposition.
  the tier's INSUFFICIENT_EVIDENCE: H2O has no abstain option, so it is reported at probability 0 (logit -10,000, as
          JSON has no -inf). A caller abstains by its own threshold on the top probability, as H2O's routing table does.
  the yes/no floor (0.801 as shipped, for benchmark runs) is not applied: the tier reports probabilities as read, which
          is H2O's routing mode (SHIM_NOUL_FLOOR=0).
The decisions of one request that share a context read it once: the prompts' common token prefix is computed once
and each question's own tail continues from a copy of that cache, as vLLM's prefix cache does for the shim. Each
question still sees only the record and itself; H2O_SHARE=0 reads every prompt whole. A start-up check compares the
two reads and refuses to serve if they differ.

Serving (SMD-3326). One request's read runs at a time, behind a lock, on one worker thread, so the event loop stays
free: GET /health and GET /info answer while a decide runs, and two requests never interleave on the model. Admission
is bounded (the knobs SMD-2082 defines for the ob1-jev/1 adapters; jev/serve.ts's and decider's bounds are their own
tickets): at most JEV_MAX_QUEUED requests admitted at once, the one being read included, and at most
JEV_MAX_QUEUED_BYTES of their bodies held. Past either, a request is answered 503 with Retry-After before its body is
read when Content-Length shows it, or as soon as the bytes read pass it; a body larger than JEV_MAX_QUEUED_BYTES on its
own is a 413, since no wait would admit it. A request whose caller leaves while it waits, or mid-body, is dropped then
(499), its bytes released, never read. The request path is `handle`, free of the web framework and the model, so
test_serve.py holds it with the standard library alone.

A record this model would read in part gets the contract's 422, naming the decision and its token count (SMD-3326,
decided 2026-11-08): a context over max_state_tokens (32,000 in serve_config.json) is refused, not cut to its head and
tail as H2O's own shim cuts it, so a caller never gets a verdict on a record whose middle went unread. The contract lets
an adapter answer a cut it can read faithfully, `truncated: true`; this adapter reads no cut as faithful, so every
result it answers says `truncated: false`.

Endpoints (ob1-jev/1): GET /health, GET /info, POST /decide.
Knobs: JEV_HOST (127.0.0.1), JEV_PORT (8022), JEV_MAX_QUEUED (8), JEV_MAX_QUEUED_BYTES (33554432, 32 MiB),
H2O_MODEL (h2oai/h2o-lightning-4b), H2O_REVISION (v1.2.3), H2O_DEVICE (mps), H2O_SHARE (1), H2O_DTYPE (float16 on MPS,
as decider runs; bfloat16 elsewhere), H2O_MPS_PATCH (1: decider's MPS kernels for the gated-delta layers, when the
decider package is installed).
"""
import asyncio, copy, hashlib, json, math, os, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

CONTRACT = "ob1-jev/1"
INSUFFICIENT = "__insufficient_evidence__"
NO_ABSTAIN_LOGIT = -10_000.0
MAX_OPTIONS, MAX_BATCH, MAX_TEXT, MAX_BODY = 24, 64, 20_000, 8 * 2 ** 20
DEFAULT_MAX_QUEUED, DEFAULT_MAX_QUEUED_BYTES = 8, 32 * 2 ** 20
# A body's whole arrival, once admitted: a caller that declares a body and stalls holds a slot and its bytes until then,
# not until its connection closes (review pass 3: eight such held the tier at 503 for good). 8 MB from a local caller
# takes well under a second.
BODY_TIMEOUT_S = 30.0
MODEL_NAME = "h2o-lightning-4b"
REPO = os.environ.get("H2O_MODEL", "h2oai/h2o-lightning-4b")
REVISION = os.environ.get("H2O_REVISION", "v1.2.3")
SHARE = os.environ.get("H2O_SHARE", "1") == "1"

# Qwen3.5's chat template for a system and a user message, the generation prompt with thinking off (the shim's CHATML)
CHATML = {"system": "<|im_start|>system\n{content}<|im_end|>\n",
          "user": "<|im_start|>user\n{content}<|im_end|>\n",
          "generation": "<|im_start|>assistant\n<think>\n\n</think>\n\n"}
BINARY_INSTRUCTIONS = "Answer true or false based only on the record."
RULES = ("h2o_lightning_shim.py v1.2.3 text path: chat template, serve_config system prompt, plain layout, one label per "
         "option, 'Answer:' prefill, label logits at the answer slot, per-type temperature, no yes/no floor; choice = "
         "question + `id: description` (an `id: ` prefix dropped); binary = noul, true = proposition, false = 'It is not "
         "the case that ' + proposition; INSUFFICIENT_EVIDENCE at probability 0; shared context read once per request")


def common_prefix_len(seqs):
    """The length of the longest common prefix of several token id lists."""
    n = min(len(x) for x in seqs)
    for i in range(n):
        if any(x[i] != seqs[0][i] for x in seqs[1:]):
            return i
    return n


class Reader:
    """The model, its tokenizer and serve_config.json, and the shim's prompt and readout."""

    def __init__(self, path, device="mps", share=True):
        import torch
        from transformers import AutoTokenizer, Qwen3_5ForConditionalGeneration
        self.torch, self.path, self.share = torch, Path(path), share
        # The runtime decider-4b is measured on, so the two models' times compare: float16 on MPS, and decider's MPS
        # kernels for Qwen3.5's gated-delta layers (transformers' reference fallback reads about twice as slowly)
        self.dtype = os.environ.get("H2O_DTYPE", "float16" if device == "mps" else "bfloat16")
        self.patched = False
        if device == "mps" and os.environ.get("H2O_MPS_PATCH", "1") == "1":
            try:
                from decider.mps_ops import patch_mps
                self.patched = bool(patch_mps())
            except ImportError:
                pass
        self.cfg = json.loads((self.path / "serve_config.json").read_text())
        p = self.cfg["prompt"]
        if p.get("enable_thinking") or not p.get("chat_template", True) or p.get("layout", "plain") != "plain":
            raise SystemExit("serve_config.json asks for a prompt this port does not render (thinking, no chat template, or a non-plain layout)")
        self.system, self.prefill = p.get("system") or None, p.get("prefill", "Answer:")
        self.max_state_tokens = int(p.get("max_state_tokens", 32000))
        self.default_instructions = p.get("default_instructions", "Answer the question below.")
        t = self.cfg["temperature"]
        self.temperature = {k: float(t[k] if isinstance(t, dict) else t) for k in ("choice", "noul", "score")}
        self.labels = [str(l) for l in self.cfg["labels"]][: int(self.cfg.get("max_options", len(self.cfg["labels"])))]
        self.tok = AutoTokenizer.from_pretrained(path)
        model = Qwen3_5ForConditionalGeneration.from_pretrained(path, dtype=getattr(torch, self.dtype))
        self.dev = torch.device(device)
        model.to(self.dev).eval()
        self.lm = model.model.language_model                # the text model; no image ever reaches this port
        self.label_ids = self._label_ids()
        self.w = model.lm_head.weight[self.label_ids].float()  # the labels' rows of the output layer, read in float32

    def encode(self, text):
        return self.tok(text, add_special_tokens=False)["input_ids"]

    def prompt(self, state, instructions, names, descs):
        """The shim's prompt for one question: the chat template, the plain layout and the "Answer:" prefill."""
        labels = self.labels[:len(names)]
        body = "\n".join(f"{l}) {n}: {d}" for l, n, d in zip(labels, names, descs))
        instr = instructions.lstrip() or self.default_instructions
        user = f"record: {state}\nquestion: {instr}\noptions:\n{body}"
        out = "" if self.system is None else CHATML["system"].replace("{content}", self.system.strip())
        return out + CHATML["user"].replace("{content}", user.strip()) + CHATML["generation"] + self.prefill

    def _label_ids(self):
        """Each label's token at the answer slot, as the shim reads it: appending " <label>" to a prompt holding every
        label adds exactly one token. Every label must be one distinct token, or the readout is not the shim's."""
        names = [f"o{i}" for i in range(len(self.labels))]
        text = self.prompt('{"x":1}', "Which?", names, [f"d{i}" for i in range(len(names))])
        base, ids, bad = self.encode(text), [], []
        for label in self.labels:
            full = self.encode(text + " " + label)
            if len(full) != len(base) + 1 or full[:len(base)] != base: bad.append(label)
            else: ids.append(full[-1])
        if bad or len(set(ids)) != len(ids):
            raise SystemExit(f"these labels are not one distinct token at the answer slot: {bad[:8]}")
        return ids

    def state_tokens(self, text):
        """The record's token count when it is over max_state_tokens, else None. Every record is encoded: the
        tokenizer normalizes to NFC first, which can lengthen a text, so its UTF-8 length is no bound on its tokens
        (review pass 1: 10,666 x U+FB2C is 31,998 bytes and 42,664 tokens). Over the limit, the shim would keep its
        head and tail around a "..." line; this port refuses it instead (a 422), as `handle` says."""
        mx = self.max_state_tokens
        if not mx: return None
        n = len(self.encode(text))
        return n if n > mx else None

    def truncate_state(self, text):
        """The shim's cut, for conformance.py alone: a record over max_state_tokens keeps its head and tail around a
        "..." line, as H2O's published reads were made. Serving never cuts (state_tokens, a 422). (bool: cut)"""
        mx = self.max_state_tokens
        if not mx or len(text.encode("utf-8", "ignore")) <= mx: return text, False
        ids = self.encode(text)
        if len(ids) <= mx: return text, False
        half = mx // 2
        return self.tok.decode(ids[:half]) + "\n...\n" + self.tok.decode(ids[-half:]), True

    def _run(self, ids, cache=None, keep=False):
        """The final hidden state at the last position, and the cache when `keep`."""
        x = self.torch.tensor([ids], dtype=self.torch.long, device=self.dev)
        out = self.lm(input_ids=x, past_key_values=cache, use_cache=keep or cache is not None)
        return out.last_hidden_state[0, -1].float(), (out.past_key_values if keep else None)

    def read(self, prompts, share=None):
        """The label logits at the answer slot of each prompt (token id lists). With sharing, the prompts' common
        prefix is read once and each tail continues from a copy of its cache."""
        share = self.share if share is None else share
        with self.torch.inference_mode():
            k = common_prefix_len(prompts) if len(prompts) > 1 else 0
            k = min(k, min(len(p) for p in prompts) - 1)
            if not share or k < 1:
                hs = [self._run(p)[0] for p in prompts]
            else:
                _, cache = self._run(prompts[0][:k], keep=True)
                hs = [self._run(p[k:], cache=copy.deepcopy(cache))[0] for p in prompts]
            return [(self.w @ h).tolist() for h in hs]

    def answer(self, logits, n, typ):
        """(the label log-probabilities renormalised over the n options at temperature 1, the probabilities at the
        type's temperature): softmax(logprob / T), the shim's answer without its yes/no floor."""
        v = logits[:n]
        m = max(v)
        lse = m + math.log(sum(math.exp(x - m) for x in v))
        raw = [x - lse for x in v]
        t = max(self.temperature[typ], 1e-3)
        s = [x / t for x in raw]
        m = max(s)
        e = [math.exp(x - m) for x in s]
        z = sum(e)
        return raw, [x / z for x in e]

    def shared_read_matches(self):
        """The start-up check: a shared read gives the answers of whole reads (bf16 noise aside)."""
        state = ("THOUGHT A, captured 2026-01-02: the nightly backup moved from cron to the scheduler service.\n"
                 "THOUGHT B, captured 2026-01-09: the scheduler now runs the nightly backup and the weekly prune.")
        qs = [(BINARY_INSTRUCTIONS, ["true", "false"], ["THOUGHT A and THOUGHT B are about the same subject",
                                                         "It is not the case that THOUGHT A and THOUGHT B are about the same subject"]),
              ("How do THOUGHT A and THOUGHT B relate?", ["unrelated", "related", "evolves"], ["different subjects", "same subject", "one continues the other"])]
        ps = [self.encode(self.prompt(state, i, n, d)) for i, n, d in qs]
        whole, shared = self.read(ps, share=False), self.read(ps, share=True)
        worst = 0.0
        for (_, n, _), a, b in zip(qs, whole, shared):
            ra, rb = self.answer(a, len(n), "choice")[0], self.answer(b, len(n), "choice")[0]
            worst = max(worst, max(abs(x - y) for x, y in zip(ra, rb)))
            if ra.index(max(ra)) != rb.index(max(rb)): return False, worst
        return worst <= 0.05, worst


# ------------------------------------------------------------------------------------------------- the contract
def _text(v):  # the contract's field rule
    return isinstance(v, str) and 0 < len(v.strip()) and len(v) <= MAX_TEXT


def problem(body):
    """The contract's validation rule (server-portable/jev-contract.ts), as jev/decider/serve.py applies it."""
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


def description_of(o):
    """An option's description without a leading `id:`, which the layout already writes; the whole text otherwise."""
    d, head = o["description"], o["id"] + ":"
    rest = d[len(head):].lstrip() if d.startswith(head) else ""
    return rest if rest.strip() else d


def question_of(dd):
    """(instructions, option names, descriptions, H2O's type, the contract's ids) for one decision."""
    if dd["kind"] == "binary":
        p = dd["proposition"]
        return BINARY_INSTRUCTIONS, ["true", "false"], [p, f"It is not the case that {p}"], "noul", ["true", "false"]
    names = [o["id"] for o in dd["options"]]
    return dd["question"], names, [description_of(o) for o in dd["options"]], "choice", names


def result_of(dd, ids, typ, raw, probs, tokens, truncated, temperature):
    probabilities = {i: p for i, p in zip(ids, probs)}
    probabilities[INSUFFICIENT] = 0.0
    # The decision's id only when it has one: the contract's `id` is an optional string, and the client reads a
    # null beside an absent id as another decision's result (SMD-3115, every canary pair failed on it).
    res = {**({"id": dd["id"]} if dd.get("id") is not None else {}), "kind": dd["kind"], "probabilities": probabilities,
           "selected": ids[probs.index(max(probs))], "abstained": False, "p_insufficient": 0.0,
           "logits": raw + [NO_ABSTAIN_LOGIT], "temperature": temperature, "tokens": tokens, "truncated": truncated}
    if dd["kind"] == "binary": res["p_true"] = probabilities["true"]
    return res


def decide_all(R, decs):
    """Every decision's result, the decisions sharing a context read together (the shared prefix read once). It runs on
    the gate's worker thread, never the event loop. A context over max_state_tokens never reaches it: `handle` refuses
    it first, so nothing here is cut and every result says `truncated: false`."""
    results = [None] * len(decs)
    groups = {}
    for i, dd in enumerate(decs):
        groups.setdefault(dd["context"], []).append(i)
    for ctx, idxs in groups.items():
        asked = [(i, *question_of(decs[i])) for i in idxs]
        prompts = [R.encode(R.prompt(ctx, instr, names, descs)) for _, instr, names, descs, _, _ in asked]
        for (i, _, names, _, typ, ids), p, lg in zip(asked, prompts, R.read(prompts)):
            rawlp, probs = R.answer(lg, len(names), typ)
            results[i] = result_of(decs[i], ids, typ, rawlp, probs, len(p), False, R.temperature[typ])
    return results


class Busy(Exception):
    """Admission refused: past JEV_MAX_QUEUED requests or JEV_MAX_QUEUED_BYTES held. A 503, with Retry-After."""

    def __init__(self, why, retry_after):
        super().__init__(why)
        self.retry_after = retry_after


GONE = object()  # what Gate.run returns for a caller that left before its turn


class Gate:
    """Admission and serialization for /decide (SMD-3326, to SMD-2082's knobs).

    Admission: at most `max_queued` requests at once, the one being read included, holding at most `max_bytes` of
    body between them; past either, Busy. Serialization: `run` reads one request at a time, behind a lock, on a single
    worker thread, so the event loop (and /health, /info) stays free. The thread is the hard guarantee: the model is
    never entered by two reads at once, even when a request's caller leaves mid-read and the lock passes on."""

    def __init__(self, max_queued=DEFAULT_MAX_QUEUED, max_bytes=DEFAULT_MAX_QUEUED_BYTES, poll_s=0.25, body_s=BODY_TIMEOUT_S):
        self.max_queued, self.max_bytes, self.poll_s, self.body_s = max_queued, max_bytes, poll_s, body_s
        self.admitted = 0
        self.bytes = 0
        self.mean_s = 1.0  # a read's seconds, smoothed; Retry-After is the admitted requests' expected wait
        self._lock = asyncio.Lock()
        self._worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="h2o-read")

    def retry_after(self):
        """Whole seconds a refused caller should wait: the admitted requests at the recent read time, at least 1."""
        return max(1, math.ceil(self.admitted * self.mean_s))

    def enter(self):
        if self.admitted >= self.max_queued:
            raise Busy(f"{self.admitted} requests are already admitted; this tier admits at most {self.max_queued} (JEV_MAX_QUEUED)", self.retry_after())
        self.admitted += 1

    def hold(self, n):
        """Reserve n more bytes of body for an admitted request, or Busy past max_bytes."""
        if self.bytes + n > self.max_bytes:
            raise Busy(f"the admitted requests would hold {self.bytes + n} bytes; this tier holds at most {self.max_bytes} (JEV_MAX_QUEUED_BYTES)", self.retry_after())
        self.bytes += n

    def leave(self, held):
        self.admitted -= 1
        self.bytes -= held

    @staticmethod
    async def _left(gone):
        """Whether the caller has left: gone()'s answer, and False when asking raises, so a failed check neither skips
        a read nor turns a request's answer into "the model failed" (review pass 1)."""
        if gone is None:
            return False
        try:
            return bool(await gone())
        except Exception:
            return False

    async def run(self, fn, gone=None):
        """fn() on the worker thread at this request's turn, or GONE when `gone()` says its caller left first."""
        waiter = asyncio.ensure_future(self._lock.acquire())
        try:
            while not (await asyncio.wait({waiter}, timeout=self.poll_s))[0]:
                if await self._left(gone):
                    waiter.cancel()
                    try:
                        await waiter
                    except asyncio.CancelledError:
                        return GONE
                    self._lock.release()  # it took the lock just as it was cancelled
                    return GONE
        except BaseException:
            if not waiter.done():
                waiter.cancel()
            elif not waiter.cancelled() and waiter.exception() is None:
                self._lock.release()
            raise
        try:
            if await self._left(gone):
                return GONE
            t = time.monotonic()
            try:
                return await asyncio.get_running_loop().run_in_executor(self._worker, fn)
            finally:
                self.mean_s = 0.8 * self.mean_s + 0.2 * (time.monotonic() - t)
        finally:
            self._lock.release()


async def handle(R, gate, model_info, headers, chunks, gone=None):
    """POST /decide, free of the web framework: (status, JSON body, extra headers). `headers` lower-cased, `chunks` the
    body as an async iterator of bytes, `gone` an async callable saying whether the caller has left.

    In order: 413 for a Content-Length over 8 MB, or over JEV_MAX_QUEUED_BYTES on its own; 503 when admission is full,
    or when the body (its Content-Length, or the bytes as they arrive) would pass the held-bytes bound; 413 for a body
    that runs past either limit; 499 for a caller gone mid-body; 400 malformed; 409 another model; 422 for a context
    the model would read only in part; 499 for a caller gone before its turn; the result, or 500 when the model
    fails."""
    # A body no wait could admit is a 413, not a 503 a caller would retry for ever (review pass 1): over 8 MB, or over
    # the held-bytes bound on its own (a JEV_MAX_QUEUED_BYTES set below a valid body).
    def too_big(n):
        if n > MAX_BODY:
            return 413, {"error": f"the body is over {MAX_BODY} bytes"}, {}
        if n > gate.max_bytes:
            return 413, {"error": f"the body is over the {gate.max_bytes} bytes this tier holds at once (JEV_MAX_QUEUED_BYTES); no wait would admit it"}, {}
        return None
    cl = headers.get("content-length")
    declared = int(cl) if cl is not None and cl.strip().isascii() and cl.strip().isdigit() else None
    if declared is not None and too_big(declared):
        return too_big(declared)
    try:
        gate.enter()
    except Busy as e:
        return 503, {"error": str(e)}, {"Retry-After": str(e.retry_after)}
    held = 0
    try:
        try:
            if declared is not None:
                gate.hold(declared)
                held = declared
            parts, size = [], 0
            stream, deadline = chunks.__aiter__(), time.monotonic() + gate.body_s
            while True:
                try:
                    c = await asyncio.wait_for(stream.__anext__(), timeout=max(deadline - time.monotonic(), 0))
                except StopAsyncIteration:
                    break
                size += len(c)
                if too_big(size):
                    return too_big(size)
                if size > held:  # no Content-Length, or a body longer than it said
                    gate.hold(size - held)
                    held = size
                parts.append(c)
        except Busy as e:
            return 503, {"error": str(e)}, {"Retry-After": str(e.retry_after)}
        except asyncio.TimeoutError:
            return 408, {"error": f"the body did not arrive within {gate.body_s:g} s; nothing was read"}, {}
        except Exception:
            # The body's stream broke: the caller left mid-body (Starlette's ClientDisconnect), or the connection did.
            # Nothing was read, and the admission and bytes go back in the finally (review pass 1: it escaped as a 500).
            return 499, {"error": "the caller left before its body was read; nothing was read"}, {}
        try:
            body = json.loads(b"".join(parts))
        except Exception:
            return 400, {"error": "the body is not JSON"}, {}
        prob = problem(body)
        if prob:
            return 400, {"error": prob}, {}
        if body.get("model") is not None and body["model"] != MODEL_NAME:
            return 409, {"error": f"this service serves {MODEL_NAME}, not {body['model']}"}, {}
        decs = body["decisions"]
        # The whole request is refused, naming the first decision the model would read only in part (the contract's
        # 422): each distinct context measured once, before the request queues for the model.
        # Measured on a thread of the default pool, not the event loop, so /health and /info answer while a request's
        # contexts are tokenized (review pass 3: 64 contexts of 20,000 characters took 1.35 s on the loop), and not on
        # the read's worker, so a request measures while another is read. A context the tokenizer cannot encode (a lone
        # surrogate, which JSON lets through) is that decision's 400, not the framework's bare 500.
        def first_unreadable():
            seen = {}
            for i, dd in enumerate(decs):
                ctx = dd["context"]
                if ctx not in seen:
                    try:
                        seen[ctx] = R.state_tokens(ctx)
                    except Exception as e:
                        return 400, {"error": f"decision {i}: its context cannot be encoded ({type(e).__name__})"}, {}
                if seen[ctx] is not None:
                    return 422, {"error": f"decision {i}: its context is {seen[ctx]} tokens, over the {R.max_state_tokens} this "
                                          f"model reads whole; a cut to its head and tail is not a faithful read, so it is refused"}, {}
            return None
        refused = await asyncio.to_thread(first_unreadable)
        if refused:
            return refused
        t = time.time()
        try:
            results = await gate.run(lambda: decide_all(R, decs), gone)
        except Exception as e:
            # the contract's 500 shape ({error}), as jev/serve.ts returns on a model failure
            return 500, {"error": f"the model failed: {str(e)[:200]}"}, {}
        if results is GONE:
            return 499, {"error": "the caller left before its turn; nothing was read"}, {}
        return 200, {"contract": CONTRACT, "model": model_info, "results": results, "ms": (time.time() - t) * 1000}, {}
    finally:
        gate.leave(held)


def knob(name, default):
    """A positive whole-number setting, or a refusal to start naming it."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    if not (raw.isascii() and raw.isdigit()) or int(raw) < 1:
        raise SystemExit(f"{name} is a positive whole number, not {raw!r}")
    return int(raw)


def build_app(R, model_info, gate):
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse, PlainTextResponse
    info = {"contract": CONTRACT, "model": model_info, "kinds": ["binary", "choice"],
            "max_options": MAX_OPTIONS, "max_batch": MAX_BATCH, "max_tokens": R.max_state_tokens}
    app = FastAPI()

    # Both answer from the event loop, which a read never holds: it runs on the gate's worker thread
    @app.get("/health")
    @app.head("/health")
    async def health(): return PlainTextResponse("ok")

    @app.get("/info")
    async def get_info(): return JSONResponse(info)

    @app.post("/decide")
    async def decide(req: Request):
        headers = {k.lower(): v for k, v in req.headers.items()}
        status, body, extra = await handle(R, gate, model_info, headers, req.stream(), req.is_disconnected)
        return JSONResponse(body, status_code=status, headers=extra)

    return app


def snapshot():
    """The revision's weights, configuration and tokenizer; never the repository's code."""
    from huggingface_hub import snapshot_download
    return snapshot_download(REPO, revision=REVISION, allow_patterns=[
        "model.safetensors", "config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json",
        "vocab.json", "merges.txt", "chat_template.jinja", "serve_config.json"])


def main():
    import uvicorn
    gate = Gate(knob("JEV_MAX_QUEUED", DEFAULT_MAX_QUEUED), knob("JEV_MAX_QUEUED_BYTES", DEFAULT_MAX_QUEUED_BYTES))
    t0 = time.time()
    path = snapshot()
    weights = Path(path) / "model.safetensors"
    h = hashlib.sha256()
    with open(weights, "rb") as f:
        for chunk in iter(lambda: f.read(8 << 20), b""): h.update(chunk)
    R = Reader(path, os.environ.get("H2O_DEVICE", "mps"), SHARE)
    if SHARE:
        ok, worst = R.shared_read_matches()
        if not ok: raise SystemExit(f"a shared read differs from whole reads (worst log-probability gap {worst:.3f}); set H2O_SHARE=0")
    model_info = {"name": MODEL_NAME, "source": REPO, "revision": Path(path).name, "weights_sha256": h.hexdigest(),
                  "calibrator_sha256": hashlib.sha256((Path(path) / "serve_config.json").read_bytes()).hexdigest(),
                  "rules": hashlib.sha256(RULES.encode()).hexdigest()[:16]}
    host, port = os.environ.get("JEV_HOST", "127.0.0.1"), int(os.environ.get("JEV_PORT", "8022"))
    print(f"jev-h2o: {MODEL_NAME} ({REPO}@{REVISION} = {Path(path).name[:8]}, weights {h.hexdigest()[:12]}) ready in "
          f"{time.time() - t0:.0f} s; {R.dtype}{', decider MPS kernels' if R.patched else ''}; T {R.temperature}; serving {CONTRACT} on http://{host}:{port}; "
          f"{'a shared context read once per request (checked)' if SHARE else 'every prompt read whole'}; "
          f"one read at a time, at most {gate.max_queued} requests and {gate.max_bytes} bytes admitted", flush=True)
    uvicorn.run(build_app(R, model_info, gate), host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
