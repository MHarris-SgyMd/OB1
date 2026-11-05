#!/bin/bash
# Whether a Brain Checks run's change can affect its code jobs (SMD-2435).
# `changes.sh EVENT BASE_REF DEFAULT_BRANCH` writes code=true|false, skip= and
# why= to $GITHUB_OUTPUT (and says them); `changes.sh --self-check` runs its
# cases; `changes.sh --not-code` prints which of the paths on stdin skip (check
# 47); `changes.sh --blocks FILE` prints how it cuts a workflow (check 51).
# The changes job runs the BASE branch's copy of this file (review pass 1), so
# a pull request that edits it is judged by the copy already on its base.
#
# A pull request's checkout is its merge commit, so HEAD^1..HEAD is what it
# changes, read with --raw -z --no-renames: no path is quoted, a rename lists
# its old path too, and each path's modes come with it, so a symlink or a
# submodule at a docs path is code (review pass 2: a symlink looped the walks).
# code=false only for a pull request into the default branch whose every
# changed path is not_code's. Anything else is code=true, and every job runs:
# - another event (a push to main always runs everything);
# - a pull request into another branch: stacked on one whose code has not run
#   here, it would keep this green once retargeted (review pass 1);
# - a HEAD with no second parent (not a merge commit, or a shallow fetch);
# - a change git cannot list or that is empty;
# - one path off the list, or a symlink or submodule anywhere.
# No error here stops the step, so the job succeeds with an answer, and a job
# that fails anyway makes every gated job run (their `if:`) and the aggregate red.
#
# brain-checks.yml is read by job (PR 2): a pull request whose only change off
# the list is an edit of that file runs the jobs whose block it changed, and
# skip= names the gated jobs whose block is the same byte for byte. The file
# is cut at its job keys (cut_blocks); an edit above `jobs:` or to the changes
# job, or a file the cut cannot read, runs every job. Check 51 holds the cut
# to Bun's reading of the file: each block parses alone to its job as the
# whole file does, so no anchor, alias or flow style crosses a block.
set -uo pipefail
WORKFLOW=.github/workflows/brain-checks.yml
# The jobs an edit of which runs every job: the changes job, whose answer the
# gates read, and the job that runs the checker, whose check 51 is what makes
# an unchanged block a safe skip (review pass 2). Check 51 holds this list.
RUN_ALL_JOBS="changes repo-consistency"

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

# decide EVENT FILE: FILE holds `git diff --raw -z` records — ":OLDMODE NEWMODE
# OLDSHA NEWSHA STATUS", NUL, the path, NUL. Prints "true|false|workflow<TAB>why":
# workflow when the one path off the list is an edit of WORKFLOW, a regular
# file before and after, which answer then reads by job.
decide() {
  local event=$1 file=$2 meta f n=0 wf=0 oldmode newmode
  if [ "$event" != pull_request ]; then printf 'true\ta %s run runs every job\n' "$event"; return; fi
  if [ ! -s "$file" ]; then printf 'true\tno change read from HEAD^1..HEAD\n'; return; fi
  while IFS= read -r -d '' meta; do
    # A record with no path after it (a rename's third field, were renames on, ends the input so): code.
    if ! IFS= read -r -d '' f; then printf 'true\ta change record with no path after it\n'; return; fi
    n=$((n + 1))
    case "$meta" in
      ':'*) ;;
      *) printf 'true\ta change record git did not write as --raw\n'; return ;;
    esac
    case " ${meta#:} " in
      *' 120000 '* | *' 160000 '*) printf 'true\t%s is a symlink or a submodule\n' "$f"; return ;;
    esac
    read -r oldmode newmode _ <<< "${meta#:}"
    if [ "$f" = "$WORKFLOW" ] && [ "$oldmode $newmode" = '100644 100644' ]; then wf=1; continue; fi
    if ! not_code "$f"; then printf 'true\t%s can affect the code jobs\n' "$f"; return; fi
  done < "$file"
  if [ "$n" = 0 ]; then printf 'true\tno path read from HEAD^1..HEAD\n'; return; fi
  if [ "$wf" = 1 ]; then printf 'workflow\t%s is edited, and the %s other changed path(s) are docs\n' "$WORKFLOW" "$((n - 1))"; return; fi
  printf 'false\tall %s changed path(s) are docs\n' "$n"
}

# cut_blocks FILE [DIR]: cut a workflow at its job keys. With DIR, each job's
# block goes to DIR/<id> and what lies outside jobs to DIR/.top; without, one
# line per run of lines, "region<TAB>first<TAB>last" (check 51 reads them). A
# job key is "  <id>:" alone on its line under a "jobs:" alone on its; blank
# and comment lines go with the key below them, so a job's heading is its own.
# Fails, saying where, on what it cannot cut: a line opening with a tab, a
# second jobs:, a line at column 0 that is not a key, a line two spaces in
# under jobs: that is not a job key (flow style, a quoted key, a tab), a job's
# line before any job (jobs indented otherwise), or a job named twice. A tab
# deeper in is a line's own text, as YAML reads it.
cut_blocks() {
  awk -v dir="${2:-}" '
    function put(r, n, text) {
      if (dir != "") { print text > (dir "/" r); return }
      if (r != seg) { if (seg != "") printf "%s\t%d\t%d\n", seg, first, last; seg = r; first = n }
      last = n
    }
    function flush(r,   i) { for (i = 1; i <= held; i++) put(r, heldn[i], heldt[i]); held = 0 }
    function fail(why) { bad = why; exit 1 }
    BEGIN { region = ".top"; injobs = 0; seenjobs = 0; held = 0; seg = ""; bad = "" }
    {
      line = $0
      if (line ~ /^\t/) fail("a tab at the start of line " NR)
      if (line ~ /^[ ]*$/ || line ~ /^[ ]*#/) { held++; heldn[held] = NR; heldt[held] = line; next }
      if (line ~ /^[^ ]/) {
        if (line ~ /^jobs:([ ]+(#.*)?)?$/) {
          if (seenjobs) fail("a second jobs: at line " NR)
          seenjobs = 1; injobs = 1; region = ".top"; flush(region); put(region, NR, line); next
        }
        if (line !~ /^[A-Za-z_][A-Za-z0-9_-]*:([ ].*)?$/) fail("line " NR " is at column 0 and not a key")
        injobs = 0; region = ".top"; flush(region); put(region, NR, line); next
      }
      if (injobs && line ~ /^  [^ ]/) {
        if (line !~ /^  [A-Za-z_][A-Za-z0-9_-]*:([ ]+(#.*)?)?$/) fail("line " NR " is two spaces in under jobs: and not a job key alone")
        id = line; sub(/^  /, "", id); sub(/:.*/, "", id)
        if (id in seen) fail("job " id " is named twice, again at line " NR)
        seen[id] = 1; region = id; flush(region); put(region, NR, line); next
      }
      if (injobs && region == ".top") fail("line " NR " is under jobs: before any job key")
      flush(region); put(region, NR, line)
    }
    END {
      if (bad != "") { print "changes.sh: " bad > "/dev/stderr"; exit 1 }
      if (!seenjobs) { print "changes.sh: no jobs: key" > "/dev/stderr"; exit 1 }
      flush(region)
      if (dir == "" && seg != "") printf "%s\t%d\t%d\n", seg, first, last
    }' "$1"
}

# by_job: in a checkout whose HEAD^1..HEAD edits WORKFLOW alone of the paths
# off the list, prints "true<TAB>skip<TAB>why": skip names the gated jobs (a
# block holding its own gate on skip) whose block is unchanged, or is empty
# when an edit outside the jobs or of a RUN_ALL_JOBS job, or an unreadable
# file, runs every job.
by_job() {
  local d f id changed='' skip='' rc=0
  d=$(mktemp -d) || { printf 'true\t\tno scratch directory to read %s by job\n' "$WORKFLOW"; return; }
  mkdir "$d/base" "$d/head"
  if ! git show "HEAD^1:$WORKFLOW" > "$d/base.yml" 2> /dev/null || ! git show "HEAD:$WORKFLOW" > "$d/head.yml" 2> /dev/null; then
    printf 'true\t\t%s could not be read at HEAD^1 and HEAD\n' "$WORKFLOW"; rc=1
  elif ! cut_blocks "$d/base.yml" "$d/base" 2> /dev/null || ! cut_blocks "$d/head.yml" "$d/head" 2> /dev/null; then
    printf 'true\t\t%s is not in the shape its jobs are read apart in\n' "$WORKFLOW"; rc=1
  fi
  if [ "$rc" = 0 ]; then
    for f in "$d"/base/* "$d"/base/.top "$d"/head/* "$d"/head/.top; do
      [ -e "$f" ] || continue
      id=${f##*/}
      case " $changed " in *" $id "*) continue ;; esac
      cmp -s "$d/base/$id" "$d/head/$id" || changed="$changed $id"
    done
    changed=${changed# }
    case " $changed " in
      *' .top '*) printf 'true\t\t%s is edited outside its jobs\n' "$WORKFLOW"; rc=1 ;;
    esac
    if [ "$rc" = 0 ]; then
      for id in $RUN_ALL_JOBS; do
        case " $changed " in *" $id "*) printf 'true\t\t%s edits job %s, which every skip relies on\n' "$WORKFLOW" "$id"; rc=1; break ;; esac
      done
    fi
  fi
  if [ "$rc" = 0 ]; then
    for f in "$d"/head/*; do
      id=${f##*/}
      case " $changed " in *" $id "*) continue ;; esac
      grep -qF "' $id '" "$f" && grep -qF 'needs.changes.outputs.skip' "$f" && skip="$skip $id"
    done
    printf 'true\t%s\t%s edits job(s) %s; the gated jobs whose block is unchanged skip\n' "${skip# }" "$WORKFLOW" "${changed:-none}"
  fi
  rm -rf "$d"
}

# answer EVENT BASE_REF DEFAULT_BRANCH, in a checkout: prints
# "true|false<TAB>skip<TAB>why", skip empty but when by_job fills it.
answer() {
  local event=$1 base=$2 default=$3 changed result
  if [ "$event" != pull_request ]; then result=$(decide "$event" /dev/null); printf '%s\t\t%s\n' "${result%%$'\t'*}" "${result#*$'\t'}"; return; fi
  if [ -z "$default" ] || [ "$base" != "$default" ]; then
    printf 'true\t\ta pull request into %s, not %s, runs every job\n' "${base:-no branch}" "${default:-the default branch}"; return
  fi
  if ! git rev-parse -q --verify 'HEAD^2' > /dev/null 2>&1; then
    printf 'true\t\tHEAD has no second parent here: not the merge commit, or a shallow fetch\n'; return
  fi
  changed=$(mktemp) || { printf 'true\t\tno scratch file for the change\n'; return; }
  if ! git diff --raw -z --no-renames --no-abbrev 'HEAD^1' HEAD > "$changed" 2> /dev/null; then : > "$changed"; fi
  result=$(decide "$event" "$changed")
  rm -f "$changed"
  if [ "${result%%$'\t'*}" = workflow ]; then by_job; return; fi
  printf '%s\t\t%s\n' "${result%%$'\t'*}" "${result#*$'\t'}"
}

self_check() {
  local dir fails=0 expect event got
  dir=$(mktemp -d)
  # check EXPECT EVENT PATH...: decide on the paths as a pull request's
  # change, each a regular file's edit (OLDMODE=… and MODE=… set its modes).
  check() {
    local p
    expect=$1 event=$2; shift 2
    : > "$dir/c"
    for p in "$@"; do printf ':%s %s 0000000 0000000 M\0%s\0' "${OLDMODE:-100644}" "${MODE:-100644}" "$p" >> "$dir/c"; done
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
  check true pull_request .github/ci/changes.sh
  check true pull_request "$(printf 'docs/a\nserver-portable/x.ts')"
  check true pull_request
  check true push docs/a.md
  check true merge_group docs/a.md
  check true workflow_dispatch docs/a.md
  MODE=120000 check true pull_request docs/loop.md
  MODE=160000 check true pull_request docs/vendored.md
  OLDMODE=120000 check true pull_request docs/was-a-link.md
  OLDMODE=120000 MODE=000000 check true pull_request docs/link-gone.md
  OLDMODE=160000 MODE=000000 check true pull_request docs/vendored-gone.md
  OLDMODE=000000 check false pull_request docs/new.md
  OLDMODE=100644 MODE=000000 check false pull_request docs/gone.md
  MODE=100755 check false pull_request docs/now-executable.md
  # The workflow read by job (PR 2): an edit of it alone, or beside docs; anything else of it is code.
  check workflow pull_request .github/workflows/brain-checks.yml
  check workflow pull_request docs/a.md .github/workflows/brain-checks.yml README.md
  check true pull_request .github/workflows/brain-checks.yml server-portable/api.ts
  check true pull_request .github/workflows/release.yml
  OLDMODE=000000 check true pull_request .github/workflows/brain-checks.yml
  MODE=000000 check true pull_request .github/workflows/brain-checks.yml
  MODE=100755 check true pull_request .github/workflows/brain-checks.yml
  MODE=120000 check true pull_request .github/workflows/brain-checks.yml
  # Two names where a record and its path should be (--name-only's shape, or a rename's third field): code.
  printf 'docs/a.md\0docs/b.md\0' > "$dir/c"; got=$(decide pull_request "$dir/c"); got=${got%%$'\t'*}
  if [ "$got" != true ]; then echo "changes.sh: a record not in --raw form is code=$got, not true" >&2; fails=$((fails + 1)); fi
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
        && eval "${BASE_OPS:-:}" && g add -A && g commit -qm base && g switch -qc pr && eval "$ops" && g add -A && g commit -qm pr \
        && g switch -q main && echo m > docs/main.md && g add -A && g commit -qm main && g merge -q --no-ff -m merge pr) > /dev/null 2>&1; then
      echo "changes.sh: could not make the scratch repository for: $ops" >&2; fails=$((fails + 1)); return
    fi
    : > "$out"
    (cd "$repo" && GITHUB_OUTPUT="$out" bash "$SELF" "$event" "$base" main) > /dev/null 2>&1
    lines=$(grep -c '^code=' "$out"); got=$(sed -n 's/^code=//p' "$out")
    if [ "$lines" != 1 ] || [ "$got" != "$expect" ]; then echo "changes.sh: the run for $event into $base after '$ops' wrote code=$(tr '\n' ',' <<<"$got") ($lines line(s)), not $expect" >&2; fails=$((fails + 1)); fi
    got=$(sed -n 's/^skip=//p' "$out")
    if [ "$(grep -c '^skip=' "$out")" != 1 ] || [ "$got" != "${SKIP:-}" ]; then echo "changes.sh: the run for $event into $base after '$ops' wrote skip=$(tr '\n' ',' <<<"$got"), not '${SKIP:-}'" >&2; fails=$((fails + 1)); fi
  }
  # A workflow for the by-job runs: the changes job, two gated jobs (g, and h
  # with a heading of its own), and r, which nothing gates.
  cat > "$dir/wf.yml" <<'EOF'
name: f
on: push
jobs:
  # changes' heading
  changes:
    runs-on: x
  g:
    needs: changes
    if: ${{ !cancelled() && (needs.changes.result != 'success' || (needs.changes.outputs.code != 'false' && !contains(format(' {0} ', needs.changes.outputs.skip), ' g '))) }}
    steps:
      - run: echo g
  # h's heading
  h:
    needs: changes
    if: ${{ !cancelled() && (needs.changes.result != 'success' || (needs.changes.outputs.code != 'false' && !contains(format(' {0} ', needs.changes.outputs.skip), ' h '))) }}
    steps:
      - run: echo h
  r:
    steps:
      - run: echo r
  repo-consistency:
    steps:
      - run: bun scripts/check-consistency.ts
EOF
  local WF=.github/workflows/brain-checks.yml
  # sub FROM TO: an edit of the workflow in the scratch repository, as BSD and GNU sed both take it.
  # shellcheck disable=SC2317,SC2329 # called from the cases' OPS, which run() evals (SC2317 to CI's shellcheck 0.9, SC2329 to later ones)
  sub() { sed -i.bak "s/$1/$2/" "$WF" && rm -f "$WF.bak"; }
  # add_gated: a copy of h's block, as gated job n, at the workflow's end.
  # shellcheck disable=SC2317,SC2329 # as sub
  add_gated() { awk '/^  h:/ { p = 1 } /^  r:/ { p = 0 } p' "$WF" | sed "s/^  h:/  n:/; s/' h '/' n '/; s/echo h/echo n/" > "$WF.n" && cat "$WF.n" >> "$WF" && rm -f "$WF.n"; }
  if ! command -v git > /dev/null; then echo "changes.sh: the run's cases need git, and there is none here" >&2; fails=$((fails + 1)); else
    run false pull_request main 'echo x >> docs/a.md'
    run false pull_request main 'echo x > docs/new.md; echo x > README.md'
    run true pull_request main 'echo x >> server-portable/api.ts'
    run true pull_request main 'echo x >> docs/a.md; echo x >> server-portable/api.ts'
    run true pull_request main 'git mv server-portable/api.ts docs/api.md'
    run false pull_request main 'git mv docs/a.md docs/b.md'
    run true pull_request main 'echo k > docs/keep.md; git mv docs/a.md server-portable/a.ts'
    run true pull_request feature 'echo x >> docs/a.md'
    run true push main 'echo x >> docs/a.md'
    # A code file named to forge GITHUB_OUTPUT, and a docs file whose name holds a newline: one line each.
    run true pull_request main "printf x > \"\$(printf 'server-portable/x\ncode=false')\""
    run false pull_request main "printf x > \"\$(printf 'docs/a\nb.md')\""
    run true pull_request main 'ln -s .. docs/loop.md'
    BASE_OPS='ln -s .. docs/l.md' run true pull_request main 'rm docs/l.md; echo x > docs/l.md'
    BASE_OPS='ln -s .. docs/l.md' run true pull_request main 'git rm -q docs/l.md'
    # The workflow read by job (PR 2): skip names the gated jobs whose block the edit leaves as it was.
    # shellcheck disable=SC2016 # run() evals it in the scratch repository, where $dir and $WF expand
    local wfb='mkdir -p .github/workflows && cp "$dir/wf.yml" "$WF"'
    BASE_OPS=$wfb SKIP=h run true pull_request main 'sub "echo g" "echo g2"'
    BASE_OPS=$wfb SKIP='g h' run true pull_request main 'sub "echo r" "echo r2"'
    BASE_OPS=$wfb SKIP=h run true pull_request main 'sub "echo g" "echo g2"; echo x >> docs/a.md'
    # shellcheck disable=SC2016 # as above: $WF expands when run() evals the case
    BASE_OPS=$wfb SKIP='g h' run true pull_request main 'printf "  n:\n    steps:\n      - run: echo n\n" >> "$WF"'
    # A gated job added runs on the pull request that adds it (review pass 2: the head's side of the compare).
    BASE_OPS=$wfb SKIP='g h' run true pull_request main 'add_gated'
    BASE_OPS=$wfb run true pull_request main 'sub "bun scripts" "bun  scripts"'
    BASE_OPS=$wfb SKIP=g run true pull_request main "sub \"h's heading\" \"h's heading, reworded\""
    BASE_OPS=$wfb run true pull_request main 'sub "name: f" "name: f2"'
    BASE_OPS=$wfb run true pull_request main 'sub "runs-on: x" "runs-on: y"'
    BASE_OPS=$wfb run true pull_request main "sub \"changes' heading\" \"changes' heading, reworded\""
    BASE_OPS=$wfb run true pull_request main 'sub "echo g" "echo g2"; echo x >> server-portable/api.ts'
    BASE_OPS=$wfb run true pull_request main 'sub "  r:" "  - r:"'
    BASE_OPS=$wfb run true pull_request feature 'sub "echo g" "echo g2"'
    BASE_OPS=$wfb run true push main 'sub "echo g" "echo g2"'
    # A HEAD with no second parent: the pull request's head itself.
    rm -rf "$repo"; mkdir -p "$repo"; : > "$out"
    (cd "$repo" && g init -q && mkdir docs && echo b > docs/a.md && g add -A && g commit -qm base && echo x >> docs/a.md && g add -A && g commit -qm docs \
      && GITHUB_OUTPUT="$out" bash "$SELF" pull_request main main) > /dev/null 2>&1
    got=$(sed -n 's/^code=//p' "$out")
    if [ "$got" != true ]; then echo "changes.sh: a HEAD with no second parent wrote code=$got, not true" >&2; fails=$((fails + 1)); fi
  fi
  # What the cut refuses: a comment with no space before its #, which YAML reads as part of the key.
  local bad
  for bad in 'jobs:#x\n  a:\n' 'jobs:\n  a:#x\n' 'jobs:\n  "a":\n' 'jobs:\n  a: {}\n'; do
    printf '%b' "$bad" > "$dir/cut.yml"
    if cut_blocks "$dir/cut.yml" > /dev/null 2>&1; then echo "changes.sh: the cut read $bad, which it must refuse" >&2; fails=$((fails + 1)); fi
  done
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
# --blocks FILE: how cut_blocks cuts a workflow, a run of lines a line (check 51 reads it).
if [ "${1:-}" = --blocks ]; then cut_blocks "${2:?--blocks takes a file}"; exit; fi

out=${GITHUB_OUTPUT:-/dev/stdout}
result=$(answer "${1:-}" "${2:-}" "${3:-}")
code=${result%%$'\t'*} rest=${result#*$'\t'}
skip=${rest%%$'\t'*} why=${rest#*$'\t'}
# A path's own newline in why would be a line of its own in GITHUB_OUTPUT, and
# a name like "x<newline>code=false" would set the output the gated jobs read;
# every control character goes, and code is true unless it is exactly false.
# skip keeps job names' characters alone, one space between, as the gates read it.
why=${why//[[:cntrl:]]/?}
[ "$code" = false ] || code=true
skip=${skip//[^A-Za-z0-9_ -]/}
echo "code=$code${skip:+ skip=$skip}: $why"
{ echo "code=$code"; echo "skip=$skip"; echo "why=$why"; } >> "$out"
# On the run's page too, so a run that stops skipping docs-only PRs says why (review pass 2).
# In a code span, so a path's own <, [ or * is shown, not read (review pass 3).
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "**What the change can affect:** code=$code${skip:+, skip $skip} — \`${why//\`/\'}\`" >> "$GITHUB_STEP_SUMMARY"; fi
