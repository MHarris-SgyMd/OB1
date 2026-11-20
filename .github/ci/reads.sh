#!/bin/bash
# What a job read (SMD-2435 PR 3b-1). `reads.sh mark` straight after a job's
# checkout, `reads.sh list JOB [CELL]` as its last step, which writes the
# tracked files the job opened and the tracked folders it listed between the
# two to $RUNNER_TEMP/reads/JOB[.CELL].txt and says how many;
# `reads.sh --self-check` runs its cases.
#
# A runner's checkout is on a filesystem mounted relatime (the probe, OB1 PR
# 835): a file's first read after it is written moves its access time, and a
# folder's first listing moves the folder's. So a marker made after the
# checkout, and then every tracked path whose access time is later than the
# marker's, is what the job read, however it read it: an import, a
# readFileSync, a cat, a walk. Nothing is traced and nothing is slowed.
#
# The lists are recorded and kept on a push to main, and nothing reads them
# yet: PR 3b-2 gathers a run's lists into the map the changes job skips by,
# once main's runs show a job reads the same files from run to run.
#
# What a list does not hold:
# - a read through a container's read-only bind mount, which moves no access
#   time: the jobs that run a compose stack read more than their lists say;
# - a second read, which relatime leaves alone, so only "read at all";
# - a path with a tab or a newline in its name, counted in odd= and left out;
# - a filesystem that records no access times at all: list reads a file of
#   its own first, and says sight=blind when that read does not show.
# What it holds beyond the job's own reads: every file git read back to
# compare (a `git diff` or `git status` re-reads a file written in the same
# second as the index), which only adds.
set -uo pipefail

# The marker and the file list reads to test its own sight, in the checkout's
# .git: the filesystem the tracked files are on, and no path git tracks.
top=$(git rev-parse --show-toplevel 2> /dev/null) || { echo "reads.sh: not in a git checkout" >&2; exit 2; }
state="$top/.git/ob1-reads"

mark() {
  mkdir -p "$state" || return 1
  : > "$state/sight" || return 1
  : > "$state/marker" || return 1
  # A filesystem stamps times by a clock that ticks every few milliseconds:
  # past the tick the marker was made in, so the step after this one reads later.
  sleep 0.05
  echo "reads.sh: marked $(git -C "$top" rev-parse --short HEAD 2> /dev/null || echo 'no commit')"
}

# later_than_marker: of the NUL-separated paths on stdin, relative to the
# checkout's top, those whose access time is later than the marker's, NUL-separated.
later_than_marker() {
  # shellcheck disable=SC2016 # sh expands "$@" and "$0", not this shell
  (cd "$top" && xargs -0 sh -c 'find "$@" -maxdepth 0 -neweram "$0" -print0 2> /dev/null' "$state/marker") || true
}

# list JOB [CELL]: the job's reads, to $RUNNER_TEMP/reads/JOB[.CELL].txt: a
# header line, then "f<TAB>path" for a tracked file opened and "d<TAB>path/"
# for a tracked folder listed ("./" the top), sorted. Always exits 0: a job
# is not failed for its list.
list() {
  local job=${1:?list takes the job} cell=${2:-} dir out sight=ok files=0 dirs=0 odd=0 p tmp
  case "$job$cell" in *[!A-Za-z0-9_-]*) echo "reads.sh: a job and a cell are letters, digits, - and _, not '$job' '$cell'" >&2; return 2 ;; esac
  dir=${RUNNER_TEMP:-${TMPDIR:-/tmp}}/reads
  out="$dir/$job${cell:+.$cell}.txt"
  if ! mkdir -p "$dir" || ! tmp=$(mktemp "$dir/.list.XXXXXX"); then echo "reads.sh: no scratch file under $dir" >&2; return 0; fi
  if [ ! -e "$state/marker" ]; then
    sight=unmarked
  else
    # Its own sight first: a file it made before the marker, read now.
    cat "$state/sight" > /dev/null 2>&1
    if [ -z "$(find "$state/sight" -maxdepth 0 -neweram "$state/marker" 2> /dev/null)" ]; then sight=blind; fi
  fi
  if [ "$sight" = ok ]; then
    while IFS= read -r -d '' p; do
      case "$p" in
        *$'\n'* | *$'\t'*) odd=$((odd + 1)) ;;
        *) printf 'f\t%s\n' "$p"; files=$((files + 1)) ;;
      esac
    done < <(git -C "$top" ls-files -z | later_than_marker) > "$tmp.f"
    while IFS= read -r -d '' p; do
      case "$p" in
        *$'\n'* | *$'\t'*) odd=$((odd + 1)) ;;
        .) printf 'd\t./\n'; dirs=$((dirs + 1)) ;;
        *) printf 'd\t%s/\n' "$p"; dirs=$((dirs + 1)) ;;
      esac
    done < <({ printf '.\0'; git -C "$top" ls-tree -r -d --name-only -z HEAD 2> /dev/null; } | later_than_marker) > "$tmp.d"
  else
    : > "$tmp.f"; : > "$tmp.d"
  fi
  {
    printf '# reads v1 job=%s cell=%s commit=%s status=%s sight=%s files=%s dirs=%s odd=%s\n' \
      "$job" "${cell:--}" "$(git -C "$top" rev-parse HEAD 2> /dev/null || echo -)" "${JOB_STATUS:--}" "$sight" "$files" "$dirs" "$odd"
    LC_ALL=C sort "$tmp.f" "$tmp.d"
  } > "$tmp" && mv "$tmp" "$out"
  rm -f "$tmp" "$tmp.f" "$tmp.d"
  case "$sight" in
    blind) echo "::warning title=reads.sh::this filesystem recorded no access time for a file just read, so $job${cell:+ ($cell)}'s list is empty" ;;
    unmarked) echo "::warning title=reads.sh::no marker was made after the checkout, so $job${cell:+ ($cell)}'s list is empty" ;;
  esac
  local left=''
  if [ "$odd" -gt 0 ]; then left=", $odd path(s) with a tab or a newline left out"; fi
  echo "reads.sh: $job${cell:+ ($cell)} opened $files of $(git -C "$top" ls-files | wc -l | tr -d ' ') tracked files and listed $dirs folders (sight $sight$left), digest $(sed 1d "$out" | git hash-object --stdin | cut -c1-12)"
  # Where they are, by top-level folder, most first: a list that grows shows where.
  grep '^f' "$out" | cut -f2- | awk -F/ '{ n[(NF > 1) ? $1 : "(top)"]++ } END { for (d in n) printf "  %5d %s\n", n[d], d }' | LC_ALL=C sort -k1,1nr -k2
  return 0
}

self_check() {
  local dir fails=0 out
  dir=$(mktemp -d) || { echo "reads.sh: no scratch directory" >&2; return 1; }
  g() { git -c user.email=ci@example.invalid -c user.name=ci -c init.defaultBranch=main "$@"; }
  # has LINE / hasnt LINE: the list holds the line, whole; or does not.
  has() { grep -qxF "$1" "$out" || { echo "reads.sh: the list lacks '$1' (${2:-})" >&2; fails=$((fails + 1)); }; }
  hasnt() { ! grep -qxF "$1" "$out" || { echo "reads.sh: the list holds '$1' (${2:-})" >&2; fails=$((fails + 1)); }; }
  if ! (cd "$dir" && g init -q repo && cd repo && mkdir -p read left walked deep/er && echo a > read/a.txt && echo b > left/b.txt && echo c > walked/c.txt \
      && echo d > deep/er/d.txt && echo e > top.txt && echo o > "$(printf 'odd\tname.txt')" && g add -A && g commit -qm base \
      && cd .. && g clone -q repo work) > /dev/null 2>&1; then
    echo "reads.sh: could not make the scratch repository" >&2; rm -rf "$dir"; return 1
  fi
  # The cases run in work, a clone: its files are written by a checkout and
  # not yet read, as a job's are. In repo, where `git add` read each to hash
  # it, relatime would leave a later read's access time where that left it.
  out="$dir/reads/job.cell.txt"
  # With no marker: an empty list that says so, and exit 0.
  (cd "$dir/work" && RUNNER_TEMP="$dir" bash "$SELF" list job cell) > /dev/null 2>&1 || { echo "reads.sh: list with no marker did not exit 0" >&2; fails=$((fails + 1)); }
  grep -q '^# reads v1 job=job cell=cell commit=[0-9a-f]\{40\} status=- sight=unmarked files=0 dirs=0 odd=0$' "$out" 2> /dev/null || { echo "reads.sh: with no marker the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
  # Marked, then: a file read, a file left, a folder listed, a file read two folders down, a file deleted, an odd name read.
  (cd "$dir/work" && bash "$SELF" mark > /dev/null && cat read/a.txt top.txt deep/er/d.txt "$(printf 'odd\tname.txt')" > /dev/null && ls walked > /dev/null && rm left/b.txt \
    && JOB_STATUS=success RUNNER_TEMP="$dir" bash "$SELF" list job cell > "$dir/said" 2>&1) || { echo "reads.sh: mark, reads and list did not all exit 0" >&2; fails=$((fails + 1)); }
  if grep -q 'sight=blind' "$out" 2> /dev/null; then
    # No access times here (a noatime mount): the cases below cannot hold. On a runner that is the news.
    if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "reads.sh: the runner's filesystem records no access times, so every job's list would be empty" >&2; fails=$((fails + 1))
    else echo "reads.sh: this filesystem records no access times; the cases that need them are not run here"; fi
    grep -q '^::warning title=reads.sh::' "$dir/said" || { echo "reads.sh: a blind list gave no warning" >&2; fails=$((fails + 1)); }
  else
    grep -q '^# reads v1 job=job cell=cell commit=[0-9a-f]\{40\} status=success sight=ok files=3 dirs=1 odd=1$' "$out" || { echo "reads.sh: after the reads the header is '$(head -1 "$out")'" >&2; fails=$((fails + 1)); }
    has "$(printf 'f\tread/a.txt')" "a file read"
    has "$(printf 'f\ttop.txt')" "a file read at the top"
    has "$(printf 'f\tdeep/er/d.txt')" "a file read two folders down"
    has "$(printf 'd\twalked/')" "a folder listed"
    hasnt "$(printf 'f\tleft/b.txt')" "a file deleted unread"
    hasnt "$(printf 'f\twalked/c.txt')" "a file in a folder listed, itself unread"
    hasnt "$(printf 'd\tread/')" "a folder whose file was read by name"
    hasnt "$(printf 'd\tdeep/')" "a folder passed through"
    if grep -q 'odd' <(sed 1d "$out"); then echo "reads.sh: a path with a tab in its name is in the list" >&2; fails=$((fails + 1)); fi
    [ "$(sed 1d "$out")" = "$(sed 1d "$out" | LC_ALL=C sort)" ] || { echo "reads.sh: the list is not sorted" >&2; fails=$((fails + 1)); }
    grep -q '^reads.sh: job (cell) opened 3 of 6 tracked files and listed 1 folders (sight ok' "$dir/said" || { echo "reads.sh: the list said '$(head -1 "$dir/said")'" >&2; fails=$((fails + 1)); }
  fi
  # A job or a cell that is no plain name is refused.
  if (cd "$dir/work" && RUNNER_TEMP="$dir" bash "$SELF" list 'a/b') > /dev/null 2>&1; then echo "reads.sh: list took a job named a/b" >&2; fails=$((fails + 1)); fi
  rm -rf "$dir"
  if [ "$fails" -gt 0 ]; then echo "reads.sh: $fails case(s) wrong" >&2; return 1; fi
  echo "reads.sh: every case holds"
}

SELF=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")
case "${1:-}" in
  --self-check) self_check ;;
  mark) mark ;;
  list) shift; list "$@" ;;
  *) echo "usage: reads.sh mark | list JOB [CELL] | --self-check" >&2; exit 2 ;;
esac
