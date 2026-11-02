#!/bin/bash
# Whether a Fork Checks run's change can affect its code jobs (SMD-2435): the
# `changes` job's one step. `changes.sh EVENT` writes code=true|false and why=
# to $GITHUB_OUTPUT (and says both); `changes.sh --self-check` runs its cases.
#
# A pull request's checkout is its merge commit, so HEAD^1..HEAD is what it
# changes, read NUL-separated with --no-renames: no path is quoted, and a
# rename lists its old path too. code=false only when every path changed is
# NOT_CODE's. Anything else is code=true, and every job runs: another event (a
# push to main always runs everything), a HEAD that is not a merge commit, a
# change git cannot list or that is empty, one path off the list. No error
# here stops the step, so the job succeeds with an answer, and a job that
# fails anyway makes every gated job run (their `if:`) and the aggregate red.
set -uo pipefail

# Not code: a path no gated job reads, builds or runs. An allowlist, so a new
# kind of file runs every job until it is shown here not to matter: Markdown
# anywhere and images under docs/, but for the files a gated job reads and the
# directories whose files reach an image or CI's own config. Check 47 holds it:
# a Markdown or image file that code names is denied here, or listed there as
# named and not read.
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

self_check() {
  local dir fails=0 expect event got
  dir=$(mktemp -d)
  # case EXPECT EVENT PATH...: the paths as a pull request's change.
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
  check true pull_request .github/workflows/fork-checks.yml
  check true pull_request "$(printf 'docs/a\nserver-portable/x.ts')"
  check true pull_request
  check true push docs/a.md
  check true merge_group docs/a.md
  check true workflow_dispatch docs/a.md
  rm -rf "$dir"
  if [ "$fails" -gt 0 ]; then echo "changes.sh: $fails case(s) wrong" >&2; return 1; fi
  echo "changes.sh: every case holds"
}

if [ "${1:-}" = --self-check ]; then self_check; exit; fi
# --not-code: of the paths on stdin, one a line, print those not_code allows (check 47 reads it).
if [ "${1:-}" = --not-code ]; then
  while IFS= read -r f; do if not_code "$f"; then printf '%s\n' "$f"; fi; done
  exit 0
fi

event=${1:-}
out=${GITHUB_OUTPUT:-/dev/stdout}
changed=$(mktemp)
if [ "$event" = pull_request ]; then
  if ! git rev-parse -q --verify 'HEAD^2' > /dev/null; then
    : > "$changed"; event=pull_request-not-merge
  elif ! git diff -z --no-renames --name-only 'HEAD^1' HEAD > "$changed"; then
    : > "$changed"
  fi
fi
case "$event" in
  pull_request-not-merge) answer=$(printf 'true\tHEAD is not the pull request'"'"'s merge commit') ;;
  *) answer=$(decide "$event" "$changed") ;;
esac
rm -f "$changed"
code=${answer%%$'\t'*} why=${answer#*$'\t'}
# A path's own newline in why would be a line of its own in GITHUB_OUTPUT, and
# a name like "x<newline>code=false" would set the output the gated jobs read;
# every control character goes, and code is true unless it is exactly false.
why=${why//[[:cntrl:]]/?}
[ "$code" = false ] || code=true
echo "code=$code: $why"
{ echo "code=$code"; echo "why=$why"; } >> "$out"
