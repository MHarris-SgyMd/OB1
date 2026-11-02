#!/bin/bash
# Whether a Fork Checks run's change can affect its code jobs (SMD-2435).
# `changes.sh EVENT BASE_REF DEFAULT_BRANCH` writes code=true|false and why= to
# $GITHUB_OUTPUT (and says both); `changes.sh --self-check` runs its cases;
# `changes.sh --not-code` prints which of the paths on stdin skip (check 47).
# The changes job runs the BASE branch's copy of this file (review pass 1), so
# a pull request that edits it is judged by the copy already on its base.
#
# A pull request's checkout is its merge commit, so HEAD^1..HEAD is what it
# changes, read NUL-separated with --no-renames: no path is quoted, and a
# rename lists its old path too. code=false only for a pull request into the
# default branch whose every changed path is not_code's. Anything else is
# code=true, and every job runs:
# - another event (a push to main always runs everything);
# - a pull request into another branch: stacked on one whose code has not run
#   here, it would keep this green once retargeted (review pass 1);
# - a HEAD with no second parent (not a merge commit, or a shallow fetch);
# - a change git cannot list or that is empty;
# - one path off the list.
# No error here stops the step, so the job succeeds with an answer, and a job
# that fails anyway makes every gated job run (their `if:`) and the aggregate red.
set -uo pipefail

# Not code: a path no gated job reads, builds or runs. An allowlist, so a new
# kind of file runs every job until it is shown here not to matter: Markdown
# anywhere and images under docs/, but for the files a gated job reads and the
# directories whose files reach an image or CI's own config. Check 47 holds it:
# a Markdown or image file that code names is denied here, or listed there as
# named and not read, by those namers.
not_code() {
  case "$1" in
    # Read by a gated job (SMD-2435's survey): an eval pins this ADR's wording
    # (portable-server); the auth and writes suites assert over these READMEs;
    # the full-stack job's release rehearsal reads changes/ whole.
    docs/subject-anchored-claims.md | integrations/telegram-capture/README.md | integrations/slack-capture/README.md | \
      recipes/vercel-neon-telegram/README.md | recipes/schema-aware-routing/README.md | changes/*) return 1 ;;
    # Copied into an image, mounted into the stack, or CI's own: whatever the file.
    dashboard/* | plugins/* | server-portable/* | deploy/* | db/migrations/* | .github/*) return 1 ;;
    *.md) return 0 ;;
    docs/*.png | docs/*.jpg | docs/*.jpeg | docs/*.gif | docs/*.webp | docs/*.svg) return 0 ;;
  esac
  return 1
}

# decide EVENT FILE: FILE holds the change's paths, NUL-separated. Prints
# "true|false<TAB>why".
decide() {
  local event=$1 file=$2 f n=0
  if [ "$event" != pull_request ]; then printf 'true\ta %s run runs every job\n' "$event"; return; fi
  if [ ! -s "$file" ]; then printf 'true\tno change read from HEAD^1..HEAD\n'; return; fi
  while IFS= read -r -d '' f; do
    n=$((n + 1))
    if ! not_code "$f"; then printf 'true\t%s can affect the code jobs\n' "$f"; return; fi
  done < "$file"
  if [ "$n" = 0 ]; then printf 'true\tno path read from HEAD^1..HEAD\n'; return; fi
  printf 'false\tall %s changed path(s) are docs\n' "$n"
}

# answer EVENT BASE_REF DEFAULT_BRANCH, in a checkout: prints "true|false<TAB>why".
answer() {
  local event=$1 base=$2 default=$3 changed result
  if [ "$event" = pull_request ] && { [ -z "$default" ] || [ "$base" != "$default" ]; }; then
    printf 'true\ta pull request into %s, not %s, runs every job\n' "${base:-no branch}" "${default:-the default branch}"; return
  fi
  if [ "$event" = pull_request ] && ! git rev-parse -q --verify 'HEAD^2' > /dev/null 2>&1; then
    printf 'true\tHEAD has no second parent here: not the merge commit, or a shallow fetch\n'; return
  fi
  changed=$(mktemp) || { printf 'true\tno scratch file for the change\n'; return; }
  if [ "$event" = pull_request ] && ! git diff -z --no-renames --name-only 'HEAD^1' HEAD > "$changed" 2> /dev/null; then : > "$changed"; fi
  result=$(decide "$event" "$changed")
  rm -f "$changed"
  printf '%s\n' "$result"
}

self_check() {
  local dir fails=0 expect event got
  dir=$(mktemp -d)
  # check EXPECT EVENT PATH...: decide on the paths as a pull request's change.
  check() {
    expect=$1 event=$2; shift 2
    if [ "$#" -gt 0 ]; then printf '%s\0' "$@" > "$dir/c"; else : > "$dir/c"; fi
    got=$(decide "$event" "$dir/c"); got=${got%%$'\t'*}
    if [ "$got" != "$expect" ]; then echo "changes.sh: $event $* is code=$got, not $expect" >&2; fails=$((fails + 1)); fi
  }
  check false pull_request docs/01-getting-started.md
  check false pull_request README.md recipes/x/README.md "docs/a b.md" docs/img/shot.png docs/diagram.svg
  check false pull_request db/README.md
  check true pull_request changes/smd-1.md
  check true pull_request docs/a.md docs/subject-anchored-claims.md
  check true pull_request integrations/telegram-capture/README.md
  check true pull_request recipes/schema-aware-routing/README.md
  check true pull_request plugins/example/README.md
  check true pull_request server-portable/core/notes.md
  check true pull_request deploy/imports/README.md
  check true pull_request .github/notes.md
  check true pull_request recipes/x/shot.png
  check true pull_request docs/a.md server-portable/api.ts
  check true pull_request docs/walkthroughs/ob1-agent-dashboard/demo-rest-server.mjs
  check true pull_request dashboard/static/logo.png
  check true pull_request dashboard/README.md
  check true pull_request README.MD
  check true pull_request .github/workflows/fork-checks.yml
  check true pull_request "$(printf 'docs/a\nserver-portable/x.ts')"
  check true pull_request
  check true push docs/a.md
  check true merge_group docs/a.md
  check true workflow_dispatch docs/a.md
  # The run itself, in scratch repositories shaped as a pull request's
  # checkout: a merge commit whose first parent is the base, moved after the
  # branch, and whose second is the pull request's head. Each must write one
  # code= line, and the right one.
  local repo="$dir/repo" out="$dir/out" lines
  g() { git -c user.email=ci@example.invalid -c user.name=ci -c init.defaultBranch=main "$@"; }
  # run EXPECT EVENT BASE OPS: OPS on a branch, main moved, merged --no-ff, then the run.
  run() {
    expect=$1 event=$2 base=$3 ops=$4
    rm -rf "$repo"; mkdir -p "$repo"
    if ! (cd "$repo" && g init -q && mkdir -p docs server-portable && echo b > docs/a.md && echo b > server-portable/api.ts \
        && g add -A && g commit -qm base && g switch -qc pr && eval "$ops" && g add -A && g commit -qm pr \
        && g switch -q main && echo m > docs/main.md && g add -A && g commit -qm main && g merge -q --no-ff -m merge pr) > /dev/null 2>&1; then
      echo "changes.sh: could not make the scratch repository for: $ops" >&2; fails=$((fails + 1)); return
    fi
    : > "$out"
    (cd "$repo" && GITHUB_OUTPUT="$out" bash "$SELF" "$event" "$base" main) > /dev/null 2>&1
    lines=$(grep -c '^code=' "$out"); got=$(sed -n 's/^code=//p' "$out")
    if [ "$lines" != 1 ] || [ "$got" != "$expect" ]; then echo "changes.sh: the run for $event into $base after '$ops' wrote code=$(tr '\n' ',' <<<"$got") ($lines line(s)), not $expect" >&2; fails=$((fails + 1)); fi
  }
  if ! command -v git > /dev/null; then echo "changes.sh: the run's cases need git, and there is none here" >&2; fails=$((fails + 1)); else
    run false pull_request main 'echo x >> docs/a.md'
    run false pull_request main 'echo x > docs/new.md; echo x > README.md'
    run true pull_request main 'echo x >> server-portable/api.ts'
    run true pull_request main 'echo x >> docs/a.md; echo x >> server-portable/api.ts'
    run true pull_request main 'git mv server-portable/api.ts docs/api.md'
    run true pull_request feature 'echo x >> docs/a.md'
    run true push main 'echo x >> docs/a.md'
    # A code file named to forge GITHUB_OUTPUT, and a docs file whose name holds a newline: one line each.
    run true pull_request main "printf x > \"\$(printf 'server-portable/x\ncode=false')\""
    run false pull_request main "printf x > \"\$(printf 'docs/a\nb.md')\""
    # A HEAD with no second parent: the pull request's head itself.
    rm -rf "$repo"; mkdir -p "$repo"; : > "$out"
    (cd "$repo" && g init -q && mkdir docs && echo b > docs/a.md && g add -A && g commit -qm base && echo x >> docs/a.md && g add -A && g commit -qm docs \
      && GITHUB_OUTPUT="$out" bash "$SELF" pull_request main main) > /dev/null 2>&1
    got=$(sed -n 's/^code=//p' "$out")
    if [ "$got" != true ]; then echo "changes.sh: a HEAD with no second parent wrote code=$got, not true" >&2; fails=$((fails + 1)); fi
  fi
  rm -rf "$dir"
  if [ "$fails" -gt 0 ]; then echo "changes.sh: $fails case(s) wrong" >&2; return 1; fi
  echo "changes.sh: every case holds"
}

SELF=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")
if [ "${1:-}" = --self-check ]; then self_check; exit; fi
# --not-code: of the paths on stdin, one a line, print those not_code allows (check 47 reads it).
if [ "${1:-}" = --not-code ]; then
  while IFS= read -r f || [ -n "$f" ]; do if not_code "$f"; then printf '%s\n' "$f"; fi; done
  exit 0
fi

out=${GITHUB_OUTPUT:-/dev/stdout}
result=$(answer "${1:-}" "${2:-}" "${3:-}")
code=${result%%$'\t'*} why=${result#*$'\t'}
# A path's own newline in why would be a line of its own in GITHUB_OUTPUT, and
# a name like "x<newline>code=false" would set the output the gated jobs read;
# every control character goes, and code is true unless it is exactly false.
why=${why//[[:cntrl:]]/?}
[ "$code" = false ] || code=true
echo "code=$code: $why"
{ echo "code=$code"; echo "why=$why"; } >> "$out"
