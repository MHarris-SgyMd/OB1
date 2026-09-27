"""The kit's stand-in import emitter (SMD-2212): a Python emitter the runner runs
as it will run a converted recipe's (SMD-2147–2150, SMD-2021).

    python3 emit-fixture.py <input dir> [--stray]
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
abandoned, never killed).
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
    if found:
        print("READABLE: " + ", ".join(found), file=sys.stderr)
        return 3
    if os.path.exists("/usr/bin/env") and hasattr(os, "fork"):
        import subprocess
        subprocess.Popen(["sleep", "900"], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return 0


def main() -> int:
    if "--snoop" in sys.argv:
        return snoop()
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    stray = "--stray" in sys.argv
    if len(args) != 1:
        print("usage: emit-fixture.py <input dir> [--stray]", file=sys.stderr)
        return 2
    root = pathlib.Path(args[0])
    if not root.is_dir():
        print(f"no export directory at {root}", file=sys.stderr)
        return 3
    n = 0
    for path in sorted(root.glob("*.json")):
        for entry in json.loads(path.read_text(encoding="utf-8")):
            n += 1
            item = {
                "identity": {"system": "gmail" if stray and n == 3 else SYSTEM, "key": entry["id"]},
                "scope": SCOPE,
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
