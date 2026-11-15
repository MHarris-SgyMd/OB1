# Prints the probe's log from line N on, one line an event: python3 -I show.py <probe.jsonl> [first line]
import json
import sys

path = sys.argv[1]
first = int(sys.argv[2]) if len(sys.argv) > 2 else 1
for n, raw in enumerate(open(path), 1):
    if n < first:
        continue
    d = json.loads(raw)
    at = d["at"][11:23]
    if d["event"] == "request":
        mcp = {k: v for k, v in d["headers"].items() if k.startswith("mcp") or k == "last-event-id"}
        said = []
        for m in d["messages"]:
            bits = [str(m.get("method"))]
            for key in ("protocolVersion", "name", "notifications"):
                if key in m:
                    bits.append(f"{key}={m[key]}")
            if "clientInfo" in m:
                bits.append(f"clientInfo={json.dumps(m['clientInfo'])}")
            if "capabilities" in m:
                bits.append(f"capabilities={json.dumps(m['capabilities'])}")
            if "envelope" in m:
                bits.append(f"envelope={json.dumps(m['envelope'])}")
            said.append(" ".join(bits))
        print(at, d["path"], d["http"], d["era"], mcp, "|", "; ".join(said), "| ua:", d["headers"].get("user-agent"))
    elif d["event"] == "response":
        print(at, "    ->", d["status"], d.get("type"), ("sid " + d["sid"][:8]) if d.get("sid") else "")
    else:
        print(at, "  *", d["event"], {k: v for k, v in d.items() if k not in ("at", "event")})
