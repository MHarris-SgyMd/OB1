"""The kit's stand-in import emitter (SMD-2212): a Python emitter the runner runs
as it will run a converted recipe's (SMD-2147–2150, SMD-2021).

    python3 emit-fixture.py <input dir> [--stray]

Reads every *.json export under <input dir>. Each is a list of entries
{id, title, body, date}, and each entry is printed as one ingestion-contract
item on stdout (db/ingest-items.ts). `--stray` makes the third item claim
another source, which the runner must refuse before anything is written.
Standard library only, as a recipe's emitter should be where it can.
"""
import json
import pathlib
import sys

SYSTEM = "orch-fixture"
SCOPE = "orch-fixture:export"


def main() -> int:
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
