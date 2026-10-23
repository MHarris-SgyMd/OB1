#!/usr/bin/env bash
# `bunx tsc --noEmit` in each directory named, side by side (SMD-3202): each
# run's output to a log of its own, then every log in the order named — a
# passing one folded, a failing one open, naming its directory — and exit 1 if
# any failed. Seven runs one after another were 25–49 s of Portable server,
# one of the run's two slowest jobs; a tsc is one process, and the runner has
# four CPUs.
#
#   - name: Typecheck …
#     run: .github/ci/typecheck.sh server-portable rest-client …
#
# Each directory is relative to the repository root, whatever the caller's
# directory, and must already be installed: its tsc and types are its own
# node_modules'. Check 18 (scripts/check-fork-consistency.ts tscStepsIn) reads
# the directories a step names here as one tsc step each, and check 35 holds
# them to db/ci-parity.sh's `typecheck` lines. Check 18 also runs this script
# against a stub bunx, from another directory, and holds it to: `bunx tsc
# --noEmit`, exactly, once in each directory, side by side; exit non-zero if
# any fails, 0 if none; each failing directory's line starting `::error
# title=Typecheck::tsc --noEmit in DIR failed (exit N)`, N its tsc's own code,
# in the order named; under it, its output, stdout and stderr, and no other
# directory's, not folded.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
[ "$#" -gt 0 ] || { echo "usage: $0 DIR…" >&2; exit 2; }
logs=$(mktemp -d)
trap 'rm -rf "$logs"' EXIT
dirs=("$@")
# Every directory first, so a refusal starts no tsc.
for d in "${dirs[@]}"; do
  [ -f "$d/tsconfig.json" ] || { echo "::error title=Typecheck::$d has no tsconfig.json — nothing to type-check there" >&2; exit 2; }
done
pids=()
for i in "${!dirs[@]}"; do
  (cd "${dirs[$i]}" && exec bunx tsc --noEmit) > "$logs/$i.log" 2>&1 &
  pids+=($!)
done
failed=0
for i in "${!dirs[@]}"; do
  rc=0
  wait "${pids[$i]}" || rc=$?
  if [ "$rc" = 0 ]; then
    echo "::group::tsc --noEmit in ${dirs[$i]} — passed"
    cat "$logs/$i.log"
    echo "::endgroup::"
  else
    failed=1
    echo "::error title=Typecheck::tsc --noEmit in ${dirs[$i]} failed (exit $rc) — its output follows"
    cat "$logs/$i.log"
  fi
done
exit "$failed"
