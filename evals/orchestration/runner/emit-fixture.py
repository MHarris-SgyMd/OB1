"""The kit's stand-in import emitter (SMD-2212): a Python emitter the runner runs
as it will run a converted recipe's (SMD-2147–2150, SMD-2021).

    python3 emit-fixture.py <input dir> [--stray] [--system S --scope C]
    python3 emit-fixture.py --snoop

Reads every *.json export under <input dir>. Each is a list of entries
{id, title, body, date}, and each entry is printed as one ingestion-contract
item on stdout (db/ingest-items.ts). `--stray` makes the third item claim
another source, which the runner must refuse before anything is written.
`--snoop` is an emitter an export has taken over. It tries to read every
process's environment (/proc/<pid>/environ): the runner's, init's, and any
other pipeline's. If one it can read holds DATABASE_URL or OB1_RUNNER_KEY, it
says so and exits 3. Otherwise it prints nothing, which the runner answers as
a run with nothing emitted. Before exiting it leaves a detached child
(`sleep 900`), which the runner must stop (review pass 2: leftovers were
abandoned, never killed). It also fails if its HOME is writable or Python's
user site is on: a shared writable HOME let one emitter plant code another
ran (review pass 3). And it fails if it can reach anything on the network
(SMD-2289): a DNS answer, the host's Ollama through the host alias, Postgres,
n8n, the internet, or the runner's own port.
`--vendor` is a live-API emitter whose pipeline names one host, server:8000
(SMD-2289). Through the proxy the runner puts in HTTPS_PROXY it must reach
that host, and have a CONNECT to Postgres refused, which the run's report
names; a direct connection must fail. It prints nothing either way, and
exits 3 naming what went wrong.
Standard library only, as a recipe's emitter should be where it can.
"""
import json
import os
import pathlib
import sys

SYSTEM = "orch-fixture"
SCOPE = "orch-fixture:export"


def snoop() -> int:
    found = []
    pids = sorted(int(p) for p in os.listdir("/proc") if p.isdigit()) if os.path.isdir("/proc") else []
    for pid in pids:
        if pid == os.getpid():
            continue
        try:
            with open(f"/proc/{pid}/environ", "rb") as fh:
                names = [kv.split(b"=", 1)[0].decode() for kv in fh.read().split(b"\0") if kv]
        except OSError:
            continue
        found += [f"pid {pid}: {n}" for n in names if n in ("DATABASE_URL", "OB1_RUNNER_KEY")]
    found += reachable()
    home = os.environ.get("HOME", "/")
    import site
    if os.access(home, os.W_OK):
        found.append(f"HOME {home} is writable")
    if site.ENABLE_USER_SITE:
        found.append("the Python user site is on")
    if found:
        print("SNOOP found: " + ", ".join(found), file=sys.stderr)
        return 3
    if os.path.exists("/usr/bin/env") and hasattr(os, "fork"):
        import subprocess
        subprocess.Popen(["sleep", "900"], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return 0


def connects(host: str, port: int) -> str | None:
    """Whether a TCP connection opens: None when it does not (refused, reset, no route, a name that does not resolve)."""
    import socket
    try:
        socket.create_connection((host, port), timeout=3).close()
        return f"reached {host}:{port}"
    except OSError:
        return None


def reachable() -> list:
    """What an emitter with no network must not reach (SMD-2289). The host
    alias is in /etc/hosts, and 1.1.1.1 and the runner's port are addresses,
    so those three are refused by address, not by a failed lookup."""
    import socket
    found = []
    try:
        socket.getaddrinfo("postgres", 5432)
        found.append("resolved postgres: DNS answered")
    except OSError:
        pass
    for host, port in (("host.docker.internal", 11434), ("postgres", 5432), ("n8n", 5678), ("1.1.1.1", 443), ("127.0.0.1", 8090)):
        hit = connects(host, port)
        if hit:
            found.append(hit)
    return found


def tunnel(proxy: str, target: str, then: bytes = b"") -> bytes:
    """A CONNECT through the proxy, and what came back (after `then`, sent in the same write)."""
    import socket
    import urllib.parse
    u = urllib.parse.urlsplit(proxy)
    s = socket.create_connection((u.hostname, u.port), timeout=10)
    s.sendall(f"CONNECT {target} HTTP/1.1\r\nhost: {target}\r\n\r\n".encode() + then)
    out = b""
    try:
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            out += chunk
    except OSError:
        pass
    s.close()
    return out


def vendor() -> int:
    proxy = os.environ.get("HTTPS_PROXY")
    wrong = []
    if not proxy:
        wrong.append("no HTTPS_PROXY in the environment")
    else:
        named = tunnel(proxy, "server:8000", b"GET /health HTTP/1.1\r\nhost: server\r\nconnection: close\r\n\r\n")
        if not named.startswith(b"HTTP/1.1 200") or named.count(b"HTTP/1.1 ") < 2:
            wrong.append(f"the named host through the proxy: {named[:120]!r}")
        other = tunnel(proxy, "postgres:5432")
        if not other.startswith(b"HTTP/1.1 403"):
            wrong.append(f"a CONNECT to a host it does not name was not refused: {other[:120]!r}")
    hit = connects("host.docker.internal", 11434) or connects("1.1.1.1", 443)
    if hit:
        wrong.append(f"a direct connection opened: {hit}")
    if wrong:
        print("VENDOR: " + "; ".join(wrong), file=sys.stderr)
        return 3
    return 0


def main() -> int:
    if "--snoop" in sys.argv:
        return snoop()
    if "--vendor" in sys.argv:
        return vendor()
    argv = sys.argv[1:]
    def option(name: str, default: str) -> str:
        return argv[argv.index(name) + 1] if name in argv and argv.index(name) + 1 < len(argv) else default
    system, scope = option("--system", SYSTEM), option("--scope", SCOPE)
    values = {option("--system", ""), option("--scope", "")}
    args = [a for a in argv if not a.startswith("--") and a not in values]
    stray = "--stray" in argv
    if len(args) != 1:
        print("usage: emit-fixture.py <input dir> [--stray]", file=sys.stderr)
        return 2
    root = pathlib.Path(args[0])
    if not root.is_dir():
        print(f"no export directory at {root}", file=sys.stderr)
        return 3
    # An unreadable directory globs to nothing, which would read as "no export"
    # (review pass 4); a converted recipe copying this should refuse it too.
    if not os.access(root, os.R_OK | os.X_OK):
        print(f"cannot read the export directory {root} as uid {os.getuid()}", file=sys.stderr)
        return 3
    n = 0
    for path in sorted(root.glob("*.json")):
        for entry in json.loads(path.read_text(encoding="utf-8")):
            n += 1
            item = {
                "identity": {"system": "gmail" if stray and n == 3 else system, "key": entry["id"]},
                "scope": scope,
                "canonical": {"form": json.dumps(entry, sort_keys=True, ensure_ascii=False), "mediaType": "application/json"},
                "text": f"{entry['title']} — {entry['body']}",
                "links": [],
                "mentions": [],
                "facets": {"title": entry["title"], "type": "fixture"},
                "createdAt": entry["date"],
            }
            print(json.dumps(item, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
