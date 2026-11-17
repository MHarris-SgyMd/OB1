#!/usr/bin/env python3
"""test_serve.py (SMD-3326) — serve.py's request path, with the standard library alone: no model, no web framework.

serve.py's `handle` is the whole of POST /decide, free of FastAPI and of the model, so it is driven here with a fake
reader that records how many reads overlap. CI runs it in Portable server beside jev/test-jev.ts (`python3
jev/h2o/test_serve.py`); the real model's burst is the PR's own run against the adapter on a spare port.

  [1] a burst of concurrent requests is read one at a time, and every request is answered
  [2] the event loop is free while a read runs, so /health and /info answer during a decide
  [3] admission by count: past JEV_MAX_QUEUED, a 503 with Retry-After; room again once a request leaves
  [4] admission by bytes: a Content-Length past JEV_MAX_QUEUED_BYTES is refused before its body is read; a body with
      no Content-Length is refused as soon as the bytes read pass it
  [5] a body over 8 MB: a 413, declared or streamed
  [6] a caller that leaves while it waits is dropped (499), never read, its bytes released
  [7] a context over max_state_tokens: the whole request refused with a 422 naming the decision and its token count,
      nothing read
  [8] 400, 409 and 500 as before, and the gate's counts back to zero after every path
  [9] a knob or Content-Length of a non-ASCII digit: the knob refused by name, the length read as undeclared; an unset
      knob is its default
  [10] a request naming the model it serves is read; one cancelled while it waits is never read
  [11] a body that stalls, or trickles past its deadline, is a 408; the token count runs off the event loop; a context
      the tokenizer cannot encode is a 422
  [12] each prompt holds the decision's record
  [13] H2O_ATTENTION's mode, the two-way length limit, and the rules string by mode (SMD-4369)
  [14] serve_config.json's two_way block: read, or refused when absent or not the probes this port asks
  [15] H2O's start-up guard: within the tolerance of the recorded answers, and apart from the one-way ones
  [16] a two-way read is one whole pass a prompt, sharing nothing; the guard reads every probe question both ways
  [17] a context over the two-way limit is a 422 naming the setting
"""
import asyncio, importlib.util, json, math, os, sys, threading, time
from pathlib import Path

spec = importlib.util.spec_from_file_location("h2o_serve", Path(__file__).with_name("serve.py"))
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)

passed = failed = 0


def check(ok, label):
    global passed, failed
    if ok:
        passed += 1
        print(f"  ✓  {label}")
    else:
        failed += 1
        print(f"  ✗  {label}")


class FakeReader:
    """The parts of serve.Reader the request path uses. A read sleeps `delay` seconds on the calling thread and
    records the most reads ever in flight at once."""
    max_state_tokens = 1000
    temperature = {"choice": 1.0, "noul": 1.0, "score": 1.0}
    answer = serve.Reader.answer

    def __init__(self, delay=0.05, fail=False):
        self.delay, self.fail = delay, fail
        self.active = self.peak = self.reads = 0
        self.threads = set()
        self.prompted = []  # each prompt built, so a test can see what the model would read
        self._mu = threading.Lock()

    def encode(self, text):
        return list(range(len(text) // 4 + 1))

    def prompt(self, state, instructions, names, descs):
        text = f"{state}\n{instructions}\n" + "\n".join(f"{n}: {d}" for n, d in zip(names, descs))
        self.prompted.append(text)
        return text

    def state_tokens(self, text):
        n = len(text)  # one token a character, so a test sets a context's length
        return n if n > self.max_state_tokens else None

    def read(self, prompts):
        with self._mu:
            self.active += 1
            self.reads += 1
            self.peak = max(self.peak, self.active)
            self.threads.add(threading.current_thread().name)
        try:
            time.sleep(self.delay)
            if self.fail:
                raise RuntimeError("MPS out of memory")
            return [[0.5, 0.1] + [0.0] * 22 for _ in prompts]
        finally:
            with self._mu:
                self.active -= 1


MODEL = {"name": serve.MODEL_NAME}


def body(n=1, context="THOUGHT A: the backup moved. THOUGHT B: the scheduler runs it.", model=None):
    decisions = [{"id": f"d{i}", "kind": "binary", "context": context, "proposition": "B continues A"} for i in range(n)]
    return json.dumps({**({"model": model} if model else {}), "decisions": decisions}).encode()


async def chunks_of(raw, size=1 << 16, touched=None):
    if touched is not None:
        touched.append(True)
    for i in range(0, len(raw), size):
        yield raw[i:i + size]
        await asyncio.sleep(0)


def headers_for(raw, declare=True):
    return {"content-length": str(len(raw))} if declare else {}


async def post(R, gate, raw, declare=True, gone=None, touched=None):
    return await serve.handle(R, gate, MODEL, headers_for(raw, declare), chunks_of(raw, touched=touched), gone)


async def main():
    print("\n[1] a burst serializes, and every request answers")
    R, gate = FakeReader(delay=0.05), serve.Gate(max_queued=16)
    outs = await asyncio.gather(*(post(R, gate, body(2)) for _ in range(8)))
    check(all(s == 200 for s, _, _ in outs), f"all 8 requests answered 200 ({[s for s, _, _ in outs]})")
    check(R.peak == 1, f"never more than one read in flight (peak {R.peak})")
    check(R.reads == 8 and len(R.threads) == 1, f"8 reads, all on the gate's one worker thread ({R.reads}, {sorted(R.threads)})")
    check(all(len(b["results"]) == 2 and b["results"][0]["truncated"] is False for _, b, _ in outs),
          "each answer carries its two results, truncated false")
    check(gate.admitted == 0 and gate.bytes == 0, f"the gate is empty after the burst ({gate.admitted}, {gate.bytes})")
    # A request cancelled mid-read gives up the lock while its read still runs on the thread: the next read waits for
    # the thread, so the model is still entered once at a time (the worker thread is the guarantee the lock is not).
    R, gate = FakeReader(delay=0.3), serve.Gate()
    cut = asyncio.ensure_future(post(R, gate, body()))
    await asyncio.sleep(0.05)
    cut.cancel()
    try:
        await cut
    except asyncio.CancelledError:
        pass
    s, _, _ = await post(R, gate, body())
    check(s == 200 and R.peak == 1 and R.reads == 2, f"a request cancelled mid-read: the next read waits for it (peak {R.peak}, {R.reads} reads)")
    check(gate.admitted == 0 and gate.bytes == 0, f"and the cancelled request's admission is released ({gate.admitted}, {gate.bytes})")

    print("\n[2] the event loop is free while a read runs")
    R, gate = FakeReader(delay=0.4), serve.Gate()
    task = asyncio.ensure_future(post(R, gate, body()))
    await asyncio.sleep(0.05)
    t = time.monotonic()
    ticks = 0
    while not task.done() and ticks < 5:
        await asyncio.sleep(0.01)  # what /health and /info need: the loop's turn
        ticks += 1
    lag = time.monotonic() - t
    check(R.active == 1 and ticks == 5 and lag < 0.2, f"five 10 ms turns of the loop took {lag * 1000:.0f} ms while a 400 ms read ran")
    s, _, _ = await task
    check(s == 200, "the read still answers")

    print("\n[3] admission by count")
    R, gate = FakeReader(delay=0.3), serve.Gate(max_queued=2)
    first = [asyncio.ensure_future(post(R, gate, body())) for _ in range(2)]
    await asyncio.sleep(0.05)
    s, b, h = await post(R, gate, body())
    check(s == 503 and "JEV_MAX_QUEUED" in b["error"] and int(h["Retry-After"]) >= 1,
          f"a third request past JEV_MAX_QUEUED=2 is 503 with Retry-After ({s}, {h}, {b.get('error')})")
    check(all(x[0] == 200 for x in await asyncio.gather(*first)), "the two admitted still answer")
    s, _, _ = await post(R, gate, body())
    check(s == 200 and gate.admitted == 0, f"once they leave, a request is admitted again ({s})")

    print("\n[4] admission by bytes")
    # The bytes held by a request waiting or being read count against the next: a 503 with Retry-After, refused before
    # the next body is read when its Content-Length shows it, else as soon as its bytes pass the bound.
    R, gate = FakeReader(delay=0.3), serve.Gate(max_queued=8, max_bytes=len(body()) + 10)
    held = asyncio.ensure_future(post(R, gate, body()))
    await asyncio.sleep(0.05)
    touched = []
    s, b, h = await post(R, gate, body(), declare=True, touched=touched)
    check(s == 503 and "JEV_MAX_QUEUED_BYTES" in b["error"] and "Retry-After" in h and not touched,
          f"a Content-Length that, with the bytes held, passes JEV_MAX_QUEUED_BYTES is 503 before its body is read ({s}, read: {bool(touched)})")
    s, b, h = await post(R, gate, body(), declare=False)
    check(s == 503 and "JEV_MAX_QUEUED_BYTES" in b["error"], f"with no Content-Length, it is 503 once the bytes pass the bound ({s})")
    check((await held)[0] == 200 and R.reads == 1 and gate.admitted == 0 and gate.bytes == 0,
          f"the first still answers, nothing else was read, the gate empty ({R.reads}, {gate.admitted}, {gate.bytes})")
    # A body over JEV_MAX_QUEUED_BYTES on its own is a 413: no wait would admit it, so a 503 would be retried for ever
    # (review pass 1).
    R, gate = FakeReader(), serve.Gate(max_queued=8, max_bytes=500)
    big = body(context="x" * 600)
    touched = []
    s, b, h = await post(R, gate, big, declare=True, touched=touched)
    check(s == 413 and "JEV_MAX_QUEUED_BYTES" in b["error"] and "Retry-After" not in h and not touched,
          f"a Content-Length over JEV_MAX_QUEUED_BYTES on its own is 413, before its body is read ({s}, read: {bool(touched)})")
    s, b, _ = await post(R, gate, big, declare=False)
    check(s == 413 and "JEV_MAX_QUEUED_BYTES" in b["error"], f"with no Content-Length, 413 once its bytes alone pass the bound ({s})")
    check(R.reads == 0 and gate.admitted == 0 and gate.bytes == 0, f"nothing read, the gate empty ({R.reads}, {gate.admitted}, {gate.bytes})")

    print("\n[5] a body over 8 MB")
    R, gate = FakeReader(), serve.Gate()
    s, _, _ = await serve.handle(R, gate, MODEL, {"content-length": str(serve.MAX_BODY + 1)}, chunks_of(b""), None)
    check(s == 413, f"a declared Content-Length over 8 MB is 413 ({s})")
    huge = b"x" * (serve.MAX_BODY + 1)
    s, _, _ = await serve.handle(R, gate, MODEL, {}, chunks_of(huge, size=1 << 20), None)
    check(s == 413 and gate.admitted == 0 and gate.bytes == 0, f"a streamed body past 8 MB is 413, the gate empty ({s}, {gate.admitted}, {gate.bytes})")

    print("\n[6] a caller gone while it waits")
    R, gate = FakeReader(delay=0.4), serve.Gate(poll_s=0.02)
    first = asyncio.ensure_future(post(R, gate, body()))
    await asyncio.sleep(0.05)
    left = {"at": time.monotonic() + 0.1}

    async def gone():
        return time.monotonic() >= left["at"]

    t = time.monotonic()
    s, b, _ = await post(R, gate, body(), gone=gone)
    waited = time.monotonic() - t
    check(s == 499 and waited < 0.3, f"it is dropped as its caller leaves, not at its turn ({s}, after {waited * 1000:.0f} ms)")
    check(gate.admitted == 1 and gate.bytes == len(body()), f"its admission and bytes are released at once ({gate.admitted}, {gate.bytes})")
    check((await first)[0] == 200 and R.reads == 1, f"the first answers, and the dropped one was never read ({R.reads} read)")

    async def gone_now():
        return True

    s, _, _ = await post(R, gate, body(), gone=gone_now)
    check(s == 499 and R.reads == 1, f"a caller already gone at its turn is not read either ({s}, {R.reads} read)")

    # A check that raises is read as "still here" (review pass 1): the request is read and answered, not labelled
    # "the model failed".
    async def gone_broken():
        raise RuntimeError("the transport is closed")

    s, _, _ = await post(R, gate, body(), gone=gone_broken)
    check(s == 200 and R.reads == 2, f"a caller check that raises does not skip the read or fail the answer ({s}, {R.reads} read)")

    # A body whose stream breaks — Starlette's ClientDisconnect when the caller leaves mid-body — is a 499, nothing read,
    # the gate empty (review pass 1: it escaped handle as the framework's 500).
    async def breaks_mid_body():
        yield body()[:40]
        raise ConnectionResetError("the caller left mid-body")

    try:
        s, b, _ = await serve.handle(R, gate, MODEL, {"content-length": str(len(body()))}, breaks_mid_body(), None)
    except Exception as e:  # escaping handle is the framework's 500: a failed assertion, not a crashed test
        s, b = f"raised {type(e).__name__}", {}
    check(s == 499 and R.reads == 2 and gate.admitted == 0 and gate.bytes == 0,
          f"a body whose stream breaks is 499, nothing read, the gate empty ({s}, {b.get('error')}, {gate.admitted}, {gate.bytes})")

    print("\n[7] a context over max_state_tokens")
    R, gate = FakeReader(), serve.Gate()
    raw = json.dumps({"decisions": [
        {"kind": "binary", "context": "short record", "proposition": "it holds"},
        {"kind": "binary", "context": "y" * 1500, "proposition": "it holds"}]}).encode()
    s, b, _ = await post(R, gate, raw)
    check(s == 422 and "decision 1" in b["error"] and "1500 tokens" in b["error"] and "1000" in b["error"],
          f"the whole request is 422, naming decision 1 and its token count ({s}, {b.get('error')})")
    check(R.reads == 0 and gate.admitted == 0, f"nothing was read ({R.reads})")
    # Reader.state_tokens encodes every record: NFC can lengthen a text, so a record under the limit in UTF-8 bytes can
    # be over it in tokens (review pass 1: 10,666 x U+FB2C, 31,998 bytes, 42,664 tokens). A tokenizer that reads three
    # tokens a byte stands in for that here.
    probe = object.__new__(serve.Reader)
    probe.max_state_tokens = 1000
    probe.encode = lambda text: list(range(len(text.encode("utf-8")) * 3))
    check(probe.state_tokens("z" * 900) == 2700 and probe.state_tokens("z" * 300) is None,
          f"a record under the limit in bytes and over it in tokens is counted by its tokens ({probe.state_tokens('z' * 900)}, {probe.state_tokens('z' * 300)})")

    print("\n[8] 400, 409, 500, and the gate after each")
    R, gate = FakeReader(), serve.Gate()
    s1 = (await post(R, gate, b"{not json"))[0]
    s2 = (await post(R, gate, json.dumps({"decisions": []}).encode()))[0]
    s3 = (await post(R, gate, body(model="decider-4b")))[0]
    check((s1, s2, s3) == (400, 400, 409), f"not JSON 400, malformed 400, another model 409 ({s1}, {s2}, {s3})")
    R = FakeReader(fail=True)
    s, b, _ = await post(R, gate, body())
    check(s == 500 and "the model failed" in b["error"], f"a model failure is 500 ({s})")
    check(gate.admitted == 0 and gate.bytes == 0, f"the gate is empty after every path ({gate.admitted}, {gate.bytes})")
    s, _, _ = await post(FakeReader(), gate, body())
    check(s == 200, f"and the next request is read ({s})")

    print("\n[9] digits are ASCII digits")
    # str.isdigit() is True for "²", which int() refuses (review pass 2): a knob so set got a traceback, not its
    # refusal, and a Content-Length so set escaped handle as the framework's 500.
    refused = []
    for raw in ("²", "0", "-3", "1.5"):
        os.environ["JEV_TEST_KNOB"] = raw
        try:
            serve.knob("JEV_TEST_KNOB", 8)
            refused.append(False)
        except SystemExit as e:
            refused.append("JEV_TEST_KNOB is a positive whole number" in str(e))
    os.environ["JEV_TEST_KNOB"] = "12"
    kept = serve.knob("JEV_TEST_KNOB", 8)
    del os.environ["JEV_TEST_KNOB"]
    # Unset is the default, not a refusal (review pass 4: else the tier would not start on its defaults).
    try:
        kept = kept if serve.knob("JEV_TEST_KNOB", 8) == 8 else -1
    except SystemExit:
        kept = -1
    check(all(refused) and kept == 12, f"a knob of ², 0, -3 or 1.5 is refused by name, 12 is read, and unset is the default ({refused}, {kept})")
    try:
        s, _, _ = await serve.handle(FakeReader(), gate, MODEL, {"content-length": "²"}, chunks_of(body()), None)
    except Exception as e:
        s = f"raised {type(e).__name__}"
    check(s == 200 and gate.admitted == 0, f"a Content-Length of ² is read as undeclared and the body as it streams ({s})")

    print("\n[10] the requests every caller sends, and a waiter cancelled")
    # Review pass 2's mutants: no case sent the model's own name, which jev.ts sends on every request — a 409 for it
    # would refuse every real request — and none cancelled a request while it WAITED (only while it was read), whose
    # waiter left uncancelled would take the lock with no one to release it, and the tier would answer nothing again.
    R, gate = FakeReader(), serve.Gate()
    s, b, _ = await post(R, gate, body(model=serve.MODEL_NAME))
    check(s == 200 and R.reads == 1, f"a request naming the model this tier serves is read ({s}, {b.get('error')})")
    R, gate = FakeReader(delay=0.4), serve.Gate()
    first = asyncio.ensure_future(post(R, gate, body()))
    await asyncio.sleep(0.1)
    waiting = asyncio.ensure_future(post(R, gate, body()))
    await asyncio.sleep(0.1)
    waiting.cancel()
    try:
        await waiting
    except asyncio.CancelledError:
        pass
    s1 = (await first)[0]
    try:
        s3 = (await asyncio.wait_for(post(R, gate, body()), timeout=5))[0]
    except asyncio.TimeoutError:
        s3 = "no answer in 5 s"
    check(s1 == 200 and s3 == 200 and R.reads == 2 and gate.admitted == 0,
          f"a request cancelled while it waits is never read, and the next request is read after the first ({s1}, {s3}, {R.reads} read, {gate.admitted} admitted)")

    print("\n[11] a body that stalls, and the token count off the loop")
    # Review pass 3, under real uvicorn: a caller that declared a body and sent none held its slot and bytes until its
    # connection closed — eight held the tier at 503 — and the token count ran on the event loop.
    async def stalls():
        yield body()[:40]
        await asyncio.sleep(3600)

    R, gate = FakeReader(), serve.Gate(body_s=0.2)
    try:
        s, b, _ = await asyncio.wait_for(serve.handle(R, gate, MODEL, {"content-length": str(len(body()))}, stalls(), None), timeout=5)
    except asyncio.TimeoutError:
        s, b = "still waiting after 5 s", {}
    check(s == 408 and R.reads == 0 and gate.admitted == 0 and gate.bytes == 0,
          f"a body that stalls past the body deadline is a 408, nothing read, its slot and bytes released ({s}, {b.get('error')}, {gate.admitted}, {gate.bytes})")

    class SlowCount(FakeReader):
        threads = []

        def state_tokens(self, text):
            SlowCount.threads.append(threading.current_thread().name)
            time.sleep(0.3)
            return None

    R, gate = SlowCount(), serve.Gate()
    turns = 0

    async def ticker():
        nonlocal turns
        while True:
            await asyncio.sleep(0.01)
            turns += 1

    tick = asyncio.ensure_future(ticker())
    s, _, _ = await post(R, gate, body())
    tick.cancel()
    check(s == 200 and SlowCount.threads and threading.main_thread().name not in SlowCount.threads and turns >= 10,
          f"a request's contexts are counted off the event loop, which turns meanwhile ({s}, {SlowCount.threads}, {turns} turns)")

    class Unencodable(FakeReader):
        def state_tokens(self, text):
            raise UnicodeEncodeError("utf-8", text, 0, 1, "surrogates not allowed")

    R, gate = Unencodable(), serve.Gate()
    try:
        s, b, _ = await post(R, gate, body())
    except Exception as e:
        s, b = f"raised {type(e).__name__}", {}
    check(s == 422 and "decision 0: its context cannot be encoded" in b.get("error", "") and R.reads == 0 and gate.admitted == 0,
          f"a context the tokenizer cannot encode is that decision's 422, not an escape or a 400 ({s}, {b.get('error')})")

    # The deadline is the whole body's, not each chunk's (review pass 4: a caller sending a byte every 0.1 s would
    # hold its place for good under a per-chunk deadline).
    async def trickles():
        yield body()[:40]
        while True:
            await asyncio.sleep(0.05)
            yield b" "

    R, gate = FakeReader(), serve.Gate(body_s=0.3)
    try:
        s, _, _ = await asyncio.wait_for(serve.handle(R, gate, MODEL, {}, trickles(), None), timeout=5)
    except asyncio.TimeoutError:
        s = "still reading after 5 s"
    check(s == 408 and gate.admitted == 0 and gate.bytes == 0, f"a body that trickles past the deadline is a 408 though each chunk is quick ({s}, {gate.admitted}, {gate.bytes})")

    print("\n[12] what the model reads")
    # Review pass 4's mutants: the prompt could be built without the record and every case passed, the fake reader
    # never looking at what it was handed.
    R, gate = FakeReader(), serve.Gate()
    marked = "THOUGHT A: the quarterly audit moved to March. THOUGHT B: the auditors confirmed it."
    s, _, _ = await post(R, gate, body(context=marked))
    check(s == 200 and R.prompted and all(marked in p for p in R.prompted), f"each prompt holds the decision's record ({s}, {len(R.prompted)} prompts)")

    print("\n[13] the reading mode, its limit and its rules")
    modes = [serve.attention_of(v) for v in (None, "", " One-Way ", "causal", "two-way", "TWO_WAY", "bidirectional")]
    check(modes == ["one-way", "one-way", "one-way", "one-way", "two-way", "two-way", "two-way"], f"unset is one-way, and H2O's words for each mode are read ({modes})")
    refused = []
    for bad in ("both", "2", "two way"):
        try:
            serve.attention_of(bad)
            refused.append(False)
        except SystemExit as e:
            refused.append("H2O_ATTENTION" in str(e) and bad in str(e))
    check(all(refused), f"another word is refused by the setting's name ({refused})")
    limits = (serve.read_limit(32000, "one-way", 8000), serve.read_limit(32000, "two-way", 8000), serve.read_limit(4000, "two-way", 8000), serve.read_limit(0, "two-way", 8000))
    check(limits == (32000, 8000, 4000, 8000), f"one-way keeps the model's limit; two-way takes the smaller, and a model with none still gets one ({limits})")
    check(serve.rules_of("one-way") == serve.RULES and serve.rules_of("two-way") != serve.RULES and "two-way" in serve.rules_of("two-way")
          and "shared context" not in serve.rules_of("two-way") and "shared context read once per request" in serve.RULES,
          "the one-way rules are the string they were, and the two-way rules say two-way and no shared context")
    import hashlib
    hashes = [hashlib.sha256(serve.rules_of(m).encode()).hexdigest()[:16] for m in ("one-way", "two-way")]
    check(hashes == ["198e4c78db4c23dd", "7a682316774558f0"], f"/info's rules value is the one earlier lineage rows carry one-way, and the README's two-way ({hashes})")

    print("\n[14] serve_config.json's two_way block")
    made_up = {2: [0.7, 0.3], 3: [0.7, 0.2, 0.1], 4: [0.7, 0.2, 0.06, 0.04]}   # a distribution per option count
    reference = [{qid: dict(zip(serve.probe_options(typ, crit)[0], made_up[len(serve.probe_options(typ, crit)[0])]))
                  for qid, typ, _, crit in qs} for _, qs in serve.TWO_WAY_PROBES]
    good = {"temperature": {"choice": 0.75, "noul": 0.8, "score": 0.65},
            "two_way": {"probe_reference": reference, "probe_tolerance": 0.05, "temperature": {"choice": 0.5, "noul": 0.6, "score": 0.7}}}
    ref, tol, temps = serve.two_way_config(good, "v9")
    check(ref is reference and tol == 0.05 and temps == {"choice": 0.5, "noul": 0.6, "score": 0.7}, f"the block's reference, tolerance and own temperatures are read ({tol}, {temps})")
    no_temps = {"temperature": good["temperature"], "two_way": {"probe_reference": reference}}
    check(serve.two_way_config(no_temps, "v9")[1:] == (0.05, good["temperature"]), "without its own, the tolerance is 0.05 and the temperatures the one-way ones")

    def config_refused(cfg):
        try:
            serve.two_way_config(cfg, "v1.2.3")
            return None
        except SystemExit as e:
            return str(e)
    missing = config_refused({"temperature": good["temperature"]})
    check(missing is not None and "v1.2.3" in missing and "not trained to read two-way" in missing, f"a release with no two_way block is refused, naming the revision ({missing})")
    short = config_refused({**good, "two_way": {**good["two_way"], "probe_reference": reference[:2]}})
    other = [dict(r) for r in reference]
    other[1] = {**other[1], "next": {"wait": 0.5, "trace": 0.5}}
    wrong_options = config_refused({**good, "two_way": {**good["two_way"], "probe_reference": other}})
    bad_tol = [config_refused({**good, "two_way": {**good["two_way"], "probe_tolerance": t}}) for t in (0, 0.5, "0.05", True)]
    check(short is not None and "2 probes" in short and wrong_options is not None and "'next'" in wrong_options and all(bad_tol),
          f"two probes, a probe question without an answer per option, or a tolerance outside (0, 0.5) is refused ({short}, {wrong_options}, {bad_tol})")

    print("\n[15] H2O's start-up guard")
    def answers(shift):
        out = []
        for (_, qs), r in zip(serve.TWO_WAY_PROBES, reference):
            row = {}
            for qid, typ, _, crit in qs:
                names = serve.probe_options(typ, crit)[0]
                p = [r[qid][n] for n in names]
                row[qid] = [p[0] - shift, p[1] + shift] + p[2:]
            out.append(row)
        return out
    ok, gap, sep, why = serve.two_way_verdict(reference, 0.05, answers(0.09), answers(0.001))
    check(ok and why is None and abs(gap - 0.001) < 1e-9 and abs(sep - 0.089) < 1e-9, f"two-way answers at the reference and apart from the one-way ones pass ({ok}, {gap:.4f}, {sep:.4f})")
    ok, gap, _, why = serve.two_way_verdict(reference, 0.05, answers(0.2), answers(0.06))
    check(not ok and abs(gap - 0.06) < 1e-9 and "0.0600 from the ones H2O recorded" in why, f"two-way answers 0.06 from the reference fail on the reference ({why})")
    ok, _, sep, why = serve.two_way_verdict(reference, 0.05, answers(0.03), answers(0.0))
    check(not ok and abs(sep - 0.03) < 1e-9 and "the mask was not applied" in why, f"two-way answers within 0.03 of the one-way ones fail on the separation ({why})")
    one_apart = answers(0.0)
    one_apart[2]["issue"] = [x + d for x, d in zip(one_apart[2]["issue"], (-0.06, 0.06, 0.0, 0.0))]
    check(serve.two_way_verdict(reference, 0.05, one_apart, answers(0.0))[0], "one question 0.06 apart is enough: the other five may agree")
    check(serve.two_way_verdict(reference, 0.05, answers(0.2), answers(0.049))[0] and not serve.two_way_verdict(reference, 0.05, answers(0.2), answers(0.051))[0]
          and serve.two_way_verdict(reference, 0.05, answers(0.051), answers(0.0))[0] and not serve.two_way_verdict(reference, 0.05, answers(0.049), answers(0.0))[0],
          "each rule turns at its own number: 0.049 from the reference passes and 0.051 fails; 0.051 apart passes and 0.049 fails")

    print("\n[16] a two-way read")
    class Rows:
        def __matmul__(self, h): return Vec([h, h + 1.0])
    class Vec:
        def __init__(self, v): self.v = v
        def tolist(self): return self.v
    class NoGrad:
        def __enter__(self): return self
        def __exit__(self, *a): return False
    class Torch:
        @staticmethod
        def inference_mode(): return NoGrad()
    calls = []
    R = object.__new__(serve.Reader)
    R.torch, R.w, R.share, R.two_way = Torch, Rows(), True, True
    R._run_two_way = lambda ids: calls.append(("two", tuple(ids))) or float(len(ids))
    R._run = lambda ids, cache=None, keep=False: (calls.append(("one", tuple(ids), cache is not None, keep)) or float(len(ids)), "cache" if keep else None)
    prompts = [[1, 2, 3, 4], [1, 2, 3, 5, 6]]
    out = R.read(prompts)
    check(calls == [("two", (1, 2, 3, 4)), ("two", (1, 2, 3, 5, 6))] and out == [[4.0, 5.0], [5.0, 6.0]],
          f"under two-way each prompt is one whole two-way pass, though sharing is on and they share a prefix ({calls})")
    calls.clear()
    R.read(prompts, two_way=False, share=False)
    check(calls == [("one", (1, 2, 3, 4), False, False), ("one", (1, 2, 3, 5, 6), False, False)], f"the guard's one-way read of the same prompts takes the causal path ({calls})")
    calls.clear()
    R.two_way = False
    R.read(prompts)
    check([c[0] for c in calls] == ["one", "one", "one"] and calls[0] == ("one", (1, 2, 3), False, True), f"under one-way the shared prefix is still read once ({calls})")

    # the guard as the Reader runs it: every probe question read both ways, the answers at temperature 1
    R = object.__new__(serve.Reader)
    R.torch, R.probe_reference, R.probe_tolerance, R.temperature = Torch, reference, 0.05, {"choice": 0.75, "noul": 0.8, "score": 0.65}
    R.encode, asked = (lambda text: text), []
    R.prompt = lambda state, instr, names, descs: (state, instr, tuple(names))
    by_instr = {instr: (qid, serve.probe_options(typ, crit)[0]) for _, qs in serve.TWO_WAY_PROBES for qid, typ, instr, crit in qs}
    probe_of = {qid: k for k, (_, qs) in enumerate(serve.TWO_WAY_PROBES) for qid, _, _, _ in qs}
    def fake_read(prompts, share=None, two_way=None):
        (state, instr, names), = prompts
        qid, want = by_instr[instr]
        asked.append((qid, two_way, share, state))
        p = [reference[probe_of[qid]][qid][n] for n in want]
        if not two_way: p = [p[0] - 0.08, p[1] + 0.08] + p[2:]
        return [[math.log(x) for x in p] + [0.0] * 3]   # more logits than options: only the question's own are read
    R.read = fake_read
    ok, gap, sep, why = R.two_way_matches()
    check(ok and gap < 1e-9 and abs(sep - 0.08) < 1e-9, f"a reader whose two-way answers are the recorded ones passes, at temperature 1 whatever the type's own ({ok}, {gap:.6f}, {sep:.4f}, {why})")
    check(len(asked) == 12 and sum(1 for a in asked if a[1]) == 6 and all(a[2] is False for a in asked)
          and asked[0][3] == '{"ticket":"Checkout returns HTTP 500 for every customer since 09:12.","plan":"enterprise"}' and asked[4][3].startswith("The parcel left"),
          f"each of the six questions is read once each way, unshared, a structured record as compact JSON and a string as it is ({len(asked)})")

    print("\n[17] a context over the two-way limit")
    R, gate = FakeReader(), serve.Gate()
    R.two_way, R.model_max_state_tokens, R.max_state_tokens = True, 32000, 1000
    s, b, _ = await post(R, gate, json.dumps({"decisions": [{"kind": "binary", "context": "y" * 1500, "proposition": "it holds"}]}).encode())
    check(s == 422 and "1500 tokens" in b["error"] and "1000" in b["error"] and "H2O_TWO_WAY_MAX_TOKENS" in b["error"] and "head and tail" not in b["error"] and R.reads == 0,
          f"under the model's limit and over the two-way one: a 422 naming the setting, nothing read ({s}, {b.get('error')})")
    R.model_max_state_tokens = 1200
    s, b, _ = await post(R, gate, json.dumps({"decisions": [{"kind": "binary", "context": "y" * 1500, "proposition": "it holds"}]}).encode())
    check(s == 422 and "head and tail" in b["error"] and "H2O_TWO_WAY_MAX_TOKENS" not in b["error"], f"over the model's own limit too: the model's refusal, as one-way gives ({b.get('error')})")


asyncio.run(main())
print(f"\n{passed + failed} assertions: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
