#!/bin/bash
# What a job read (SMD-2435 PR 3b-1). `reads.sh mark` straight after a job's
# checkout, `reads.sh list JOB [CELL]` as its last step but the list's
# upload, which writes the tracked files the job opened and the tracked
# folders it listed between the two to $RUNNER_TEMP/reads/JOB[.CELL].txt and
# says how many; `reads.sh --self-check` runs its cases.
#
# A runner's checkout is on a filesystem mounted relatime (the probe, OB1 PR
# 835): a file's first read after it is written moves its access time, and a
# folder's first listing moves the folder's. So a marker made after the
# checkout, and then every tracked path whose access time is later than the
# marker's, is what the job opened, however it opened it: an import, a
# readFileSync, a cat, a walk. Nothing is traced and nothing is slowed.
#
# The lists are recorded and kept on a push to main, and the changes job
# reads them (PR 3b-2): .github/ci/changes.sh's by_map fetches the lists of
# main's newest green run and skips a pull request's job when nothing its
# list holds differs since. So a row is a claim a skip rests on: by_map
# reads the header's job, cell, commit, status, sight and counts, and each
# row's kind and path, and takes a list whose rows are not as many as its
# header counts for no list at all.
#
# A list's rows, under its header line:
#   f<TAB>path    a tracked file opened since the marker;
#   d<TAB>path/   a tracked folder listed since it ("./" the top);
#   g<TAB>path    a tracked file gone by the job's end, opened or not: its
#                 access time went with it, so whoever reads the list takes
#                 it as read.
# This file's own row is always there: the mark step's bash reads it before
# it can make the marker, and a second read moves no access time.
#
# What a list does not hold:
# - a read through a container's read-only bind mount, which moves no access
#   time: the jobs that run a compose stack read more than their lists say;
# - a file only asked after and never opened (existsSync, `[ -f x ]`, a size
#   or a mode read): no access time moves, so a path added, removed or made
#   executable can matter to a job whose list has neither it nor its folder;
# - a second read, which relatime leaves alone, so only "read at all";
# - a file copied where the filesystem makes the copy as a clone (btrfs, xfs,
#   APFS by `cp -c` and Bun.write): no byte is read and no time moves. A
#   runner's ext4 clones nothing: on one, cp, `cat a > b`, dd and Bun's
#   copyFileSync, cpSync and Bun.write each moved their source's time. The
#   self-check copies a file, and on a runner fails if that does not show;
# - a path with a tab or a newline in its name, counted in odd= and left out;
# - a filesystem that records no access times at all: list reads a file of
#   its own first, and says sight=blind when that read does not show. That
#   file is in the git directory, so the test sees for its filesystem: a
#   checkout whose files are on another (a linked worktree on another volume,
#   a --separate-git-dir) is not tested, here or by the self-check.
# What it holds beyond the job's own reads: every file git read back to
# compare (a `git diff` or `git status` re-reads a file written in the same
# second as the index), which only adds.
set -uo pipefail

SELF=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$(basename "${BASH_SOURCE[0]}")
# The marker and the file list reads to test its own sight, in the checkout's
# git directory (a linked worktree's is its own, and its .git a file): no
# path git tracks, and on a runner the filesystem the tracked files are on.
if ! top=$(git rev-parse --show-toplevel 2> /dev/null) || ! gitdir=$(git rev-parse --absolute-git-dir 2> /dev/null); then echo "reads.sh: not in a git checkout" >&2; exit 2; fi
state="$gitdir/ob1-reads"

mark() {
  mkdir -p "$state" || return 1
  # Not empty: a read of no bytes moves no access time on some filesystems (APFS).
  echo sight > "$state/sight" || return 1
  : > "$state/marker" || return 1
  # A filesystem stamps times by a clock that ticks every few milliseconds:
  # past the tick the marker was made in, so the step after this one reads later.
  sleep 0.05
  echo "reads.sh: marked $(git -C "$top" rev-parse --short HEAD 2> /dev/null || echo 'no commit')"
}

# later_than_marker: of the NUL-separated paths on stdin, relative to the
# checkout's top, those whose access time is later than the marker's, each
# as ./path, NUL-separated. Each goes to find behind ./, so a name that
# opens with - or is ( or ! is a path and not an expression that fails the
# batch; a path no longer there is find's error, and gone_now's row. In
# batches of 200: the loop makes its arguments again for each path, so a
# whole batch of a checkout's 2,000 took a second in dash, and these 0.13 s.
later_than_marker() {
  # shellcheck disable=SC2016 # sh expands "$@", "$0" and "$p", not this shell
  (cd "$top" && xargs -0 -n 200 sh -c '[ "$#" -gt 0 ] || exit 0; m=$0; for p do set -- "$@" "./$p"; shift; done; find "$@" -maxdepth 0 -neweram "$m" -print0 2> /dev/null' "$state/marker") || true
}
# gone_now: of the NUL-separated paths on stdin, those no longer in the checkout, NUL-separated.
gone_now() {
  # shellcheck disable=SC2016 # as above
  (cd "$top" && xargs -0 sh -c 'for p do [ -e "./$p" ] || [ -L "./$p" ] || printf "%s\0" "$p"; done' sh) || true
}

# list JOB [CELL]: the job's reads, to $RUNNER_TEMP/reads/JOB[.CELL].txt: a
# header line, then the rows above, sorted. It exits 0 whatever it finds, so
# a job is not failed for its list; 2 only as the whole script does outside
# a checkout, or with no job named, which check 55 holds each step from. A
# character in JOB or CELL that is not a letter, a digit, -, _ or . is
# written _, so a matrix value cannot leave the file's name or its header.
list() {
  local job=${1:-} cell=${2:-} dir out sight=ok files=0 dirs=0 odd=0 gone=0 p tmp own='' more=''
  if [ -z "$job" ]; then echo "usage: reads.sh list JOB [CELL]" >&2; return 2; fi
  job=${job//[^A-Za-z0-9_.-]/_} cell=${cell//[^A-Za-z0-9_.-]/_}
  dir=${RUNNER_TEMP:-${TMPDIR:-/tmp}}/reads
  out="$dir/$job${cell:+.$cell}.txt"
  if ! mkdir -p "$dir" || ! tmp=$(mktemp "$dir/.list.XXXXXX"); then echo "reads.sh: no scratch file under $dir" >&2; return 0; fi
  if [ ! -e "$state/marker" ]; then
    sight=unmarked
  else
    # Its own sight first: a file mark made before the marker, read now. One
    # written after the marker would show as read with no read at all, so
    # that is blind too.
    cat "$state/sight" > /dev/null 2>&1
    if [ "$state/sight" -nt "$state/marker" ] || [ -z "$(find "$state/sight" -maxdepth 0 -neweram "$state/marker" 2> /dev/null)" ]; then sight=blind; fi
  fi
  : > "$tmp.f"; : > "$tmp.d"; : > "$tmp.g"
  if [ "$sight" = ok ]; then
    # This file, when the checkout tracks it: read before the marker, so by rule and not by its time.
    case "$SELF" in "$top"/*) own=${SELF#"$top"/} ;; esac
    if [ -n "$own" ] && ! git -C "$top" ls-files --error-unmatch -- "$own" > /dev/null 2>&1; then own=''; fi
    while IFS= read -r -d '' p; do
      p=${p#./}
      case "$p" in
        *$'\n'* | *$'\t'*) odd=$((odd + 1)) ;;
        "$own") ;;
        *) printf 'f\t%s\n' "$p"; files=$((files + 1)) ;;
      esac
    done < <(git -C "$top" ls-files -z | later_than_marker) > "$tmp.f"
    if [ -n "$own" ]; then printf 'f\t%s\n' "$own" >> "$tmp.f"; files=$((files + 1)); fi
    while IFS= read -r -d '' p; do
      p=${p#./}
      case "$p" in
        *$'\n'* | *$'\t'*) odd=$((odd + 1)) ;;
        .) printf 'd\t./\n'; dirs=$((dirs + 1)) ;;
        *) printf 'd\t%s/\n' "$p"; dirs=$((dirs + 1)) ;;
      esac
    done < <({ printf '.\0'; git -C "$top" ls-tree -r -d --name-only -z HEAD 2> /dev/null; } | later_than_marker) > "$tmp.d"
    while IFS= read -r -d '' p; do
      case "$p" in
        *$'\n'* | *$'\t'*) odd=$((odd + 1)) ;;
        *) printf 'g\t%s\n' "$p"; gone=$((gone + 1)) ;;
      esac
    done < <(git -C "$top" ls-files -z | gone_now) > "$tmp.g"
  fi
  {
    printf '# reads v1 job=%s cell=%s commit=%s status=%s sight=%s files=%s dirs=%s gone=%s odd=%s\n' \
      "$job" "${cell:--}" "$(git -C "$top" rev-parse HEAD 2> /dev/null || echo -)" "${JOB_STATUS:--}" "$sight" "$files" "$dirs" "$gone" "$odd"
    LC_ALL=C sort "$tmp.f" "$tmp.d" "$tmp.g"
  } > "$tmp" && mv "$tmp" "$out"
  rm -f "$tmp" "$tmp.f" "$tmp.d" "$tmp.g"
  case "$sight" in
    blind) echo "::warning title=reads.sh::this filesystem recorded no access time for a file just read, so $job${cell:+ ($cell)}'s list is empty" ;;
    unmarked) echo "::warning title=reads.sh::no marker was made after the checkout, so $job${cell:+ ($cell)}'s list is empty" ;;
  esac
  if [ "$gone" -gt 0 ]; then more=", $gone gone by the end"; fi
  if [ "$odd" -gt 0 ]; then more="$more, $odd path(s) with a tab or a newline left out"; fi
  echo "reads.sh: $job${cell:+ ($cell)} opened $files of $(git -C "$top" ls-files | wc -l | tr -d ' ') tracked files and listed $dirs folders (sight $sight$more), digest $(sed 1d "$out" | git hash-object --stdin | cut -c1-12)"
  # Where they are, by top-level folder, most first: a list that grows shows where.
  grep '^f' "$out" | cut -f2- | awk -F/ '{ n[(NF > 1) ? $1 : "(top)"]++ } END { for (d in n) printf "  %5d %s\n", n[d], d }' | LC_ALL=C sort -k1,1nr -k2
  return 0
}

self_check() {
  local dir fails=0 out v under=${GIT_DIR:+yes}
  # The caller's, which a list would write in its header where the cases expect none.
  unset JOB_STATUS
  # git exports GIT_DIR and its like to whatever it runs, a hook above all, and under them every git command
  # below would act on the caller's repository, not the scratch one: `commit` on its branch, `add -A` on its index.
  for v in $(git rev-parse --local-env-vars); do unset "$v"; done
  # On the checkout's own filesystem, whose access times the jobs' lists rest on: /tmp can be another mount.
  dir=$(mktemp -d "$gitdir/ob1-reads-check.XXXXXX") || { echo "reads.sh: no scratch directory in $gitdir" >&2; return 1; }
  # Gone however this ends, an interrupt included: it holds two repositories, inside the caller's git directory.
  # shellcheck disable=SC2064 # $dir as it is now: it is local, and unset by the time the script exits
  trap "rm -rf $(printf '%q' "$dir")" EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  # The scratch commits under no setting of the caller's that could stop one: a signature asked of every commit, a hook.
  g() { git -c user.email=ci@example.invalid -c user.name=ci -c init.defaultBranch=main -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }
  # has LINE / hasnt LINE: the list holds the line, whole; or does not.
  has() { grep -qxF -- "$1" "$out" || { echo "reads.sh: the list lacks '$1' (${2:-})" >&2; fails=$((fails + 1)); }; }
  hasnt() { ! grep -qxF -- "$1" "$out" || { echo "reads.sh: the list holds '$1' (${2:-})" >&2; fails=$((fails + 1)); }; }
  if ! (cd "$dir" && g init -q repo && cd repo && mkdir -p read left walked deep/er gone tool && echo a > read/a.txt && echo b > left/b.txt && echo c > walked/c.txt \
      && echo d > deep/er/d.txt && echo e > top.txt && echo o > "$(printf 'odd\tname.txt')" && echo x > ./-dash.txt && echo r > gone/r.txt && cp "$SELF" tool/reads.sh \
      && g add -A && g commit -qm base && cd .. && g clone -q repo work) > /dev/null 2>&1; then
    echo "reads.sh: could not make the scratch repository" >&2; return 1
  fi
  # The cases run in work, a clone: its files are written by a checkout and
  # not yet read, as a job's are. In repo, where `git add` read each to hash
  # it, relatime would leave a later read's access time where that left it.
  # They run work's own copy of this file, tool/reads.sh, as a job runs its checkout's.
  # fresh: work as a new clone, no file of it read yet, tool/reads.sh included.
  fresh() { rm -rf "$dir/work" && (cd "$dir" && g clone -q repo work) > /dev/null 2>&1; }
  out="$dir/reads/job.cell.txt"
  # With no marker: an empty list that says so, and exit 0.
  (cd "$dir/work" && RUNNER_TEMP="$dir" bash tool/reads.sh list job cell) > /dev/null 2>&1 || { echo "reads.sh: list with no marker did not exit 0" >&2; fails=$((fails + 1)); }
  grep -q '^# reads v1 job=job cell=cell commit=[0-9a-f]\{40\} status=- sight=unmarked files=0 dirs=0 gone=0 odd=0$' "$out" 2> /dev/null || { echo "reads.sh: with no marker the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
  # In a fresh clone, since that list read tool/reads.sh. Marked, then: files read (one named as an option
  # would be, one with a tab in its name), a folder listed, a file deleted unread and one read then deleted.
  fresh
  (cd "$dir/work" && bash tool/reads.sh mark > /dev/null && cat read/a.txt top.txt deep/er/d.txt ./-dash.txt gone/r.txt "$(printf 'odd\tname.txt')" > /dev/null && ls walked > /dev/null \
    && rm left/b.txt gone/r.txt && JOB_STATUS=success RUNNER_TEMP="$dir" bash tool/reads.sh list job cell > "$dir/said" 2>&1) || { echo "reads.sh: mark, reads and list did not all exit 0" >&2; fails=$((fails + 1)); }
  if grep -q 'sight=blind' "$out" 2> /dev/null; then
    # No access times here (a noatime mount): the cases below cannot hold. On a runner that is the news.
    if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "reads.sh: the checkout's filesystem records no access times, so every job's list would be empty" >&2; fails=$((fails + 1))
    else echo "reads.sh: this filesystem records no access times; the cases that need them are not run here"; fi
    grep -q '^::warning title=reads.sh::' "$dir/said" || { echo "reads.sh: a blind list gave no warning" >&2; fails=$((fails + 1)); }
  else
    grep -q '^# reads v1 job=job cell=cell commit=[0-9a-f]\{40\} status=success sight=ok files=5 dirs=1 gone=2 odd=1$' "$out" || { echo "reads.sh: after the reads the header is '$(head -1 "$out")'" >&2; fails=$((fails + 1)); }
    has "$(printf 'f\tread/a.txt')" "a file read"
    has "$(printf 'f\ttop.txt')" "a file read at the top"
    has "$(printf 'f\tdeep/er/d.txt')" "a file read two folders down"
    has "$(printf 'f\t-dash.txt')" "a file read whose name opens with a dash"
    has "$(printf 'f\ttool/reads.sh')" "this file's copy, read before its own marker"
    has "$(printf 'd\twalked/')" "a folder listed"
    has "$(printf 'g\tleft/b.txt')" "a file deleted unread"
    has "$(printf 'g\tgone/r.txt')" "a file read, then deleted"
    hasnt "$(printf 'f\tleft/b.txt')" "a file deleted unread"
    hasnt "$(printf 'f\twalked/c.txt')" "a file in a folder listed, itself unread"
    hasnt "$(printf 'd\tread/')" "a folder whose file was read by name"
    hasnt "$(printf 'd\tdeep/')" "a folder passed through"
    if grep -q 'odd' <(sed 1d "$out"); then echo "reads.sh: a path with a tab in its name is in the list" >&2; fails=$((fails + 1)); fi
    [ "$(sed 1d "$out")" = "$(sed 1d "$out" | LC_ALL=C sort)" ] || { echo "reads.sh: the list is not sorted" >&2; fails=$((fails + 1)); }
    [ "$(sed 1d "$out" | LC_ALL=C sort -u | wc -l)" = "$(sed 1d "$out" | wc -l)" ] || { echo "reads.sh: the list holds a row twice" >&2; fails=$((fails + 1)); }
    grep -q '^reads.sh: job (cell) opened 5 of 9 tracked files and listed 1 folders (sight ok, 2 gone by the end, 1 path(s) with a tab or a newline left out)' "$dir/said" || { echo "reads.sh: the list said '$(head -1 "$dir/said")'" >&2; fails=$((fails + 1)); }
  fi
  # The sight test, where access times are recorded: with its file gone after the marker, so no read of it can
  # show, the list is blind, empty and says so, whatever the job read.
  fresh
  (cd "$dir/work" && bash tool/reads.sh mark > /dev/null && cat top.txt > /dev/null && rm -f .git/ob1-reads/sight \
    && RUNNER_TEMP="$dir" bash tool/reads.sh list job unseen > "$dir/said" 2>&1) || { echo "reads.sh: a list with no sight file did not exit 0" >&2; fails=$((fails + 1)); }
  grep -q '^# reads v1 job=job cell=unseen commit=[0-9a-f]\{40\} status=- sight=blind files=0 dirs=0 gone=0 odd=0$' "$dir/reads/job.unseen.txt" 2> /dev/null \
    || { echo "reads.sh: with no sight file the header is '$(head -1 "$dir/reads/job.unseen.txt" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
  grep -q '^::warning title=reads.sh::this filesystem recorded no access time' "$dir/said" || { echo "reads.sh: a list with no sight file gave no warning" >&2; fails=$((fails + 1)); }
  # …and so is a sight file written after the marker, which a read would then show whether or not reads do.
  fresh
  (cd "$dir/work" && bash tool/reads.sh mark > /dev/null && sleep 1.1 && echo late > .git/ob1-reads/sight \
    && RUNNER_TEMP="$dir" bash tool/reads.sh list job late > /dev/null 2>&1) || { echo "reads.sh: a list with a late sight file did not exit 0" >&2; fails=$((fails + 1)); }
  grep -q '^# reads v1 job=job cell=late .* sight=blind files=0 ' "$dir/reads/job.late.txt" 2> /dev/null \
    || { echo "reads.sh: with a sight file written after the marker the header is '$(head -1 "$dir/reads/job.late.txt" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
  # A copy reads its source, unless the filesystem makes it as a clone (btrfs, xfs), which reads no byte and moves
  # no time: a job's copies would be in no list. A runner's ext4 clones nothing; where one does, that is the news.
  fresh
  (cd "$dir/work" && bash tool/reads.sh mark > /dev/null && cp top.txt "$dir/copied" && RUNNER_TEMP="$dir" bash tool/reads.sh list job copy > /dev/null 2>&1) \
    || { echo "reads.sh: mark, a copy and list did not all exit 0" >&2; fails=$((fails + 1)); }
  if grep -q 'sight=ok' "$dir/reads/job.copy.txt" 2> /dev/null && ! grep -qxF -- "$(printf 'f\ttop.txt')" "$dir/reads/job.copy.txt"; then
    if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "reads.sh: a file copied is not in the list: the checkout's filesystem makes a copy as a clone, so every job's copies would be missing" >&2; fails=$((fails + 1))
    else echo "reads.sh: this filesystem makes a copy as a clone, which reads nothing; the case for a file copied is not run here"; fi
  fi
  # A cell that is no plain name is written with _ for each other character, and the list still exits 0.
  (cd "$dir/work" && RUNNER_TEMP="$dir" bash tool/reads.sh list job 'a/b c') > /dev/null 2>&1 || { echo "reads.sh: list with a cell named 'a/b c' did not exit 0" >&2; fails=$((fails + 1)); }
  grep -q '^# reads v1 job=job cell=a_b_c ' "$dir/reads/job.a_b_c.txt" 2> /dev/null || { echo "reads.sh: a cell named 'a/b c' did not go to job.a_b_c.txt under that name" >&2; fails=$((fails + 1)); }
  # No job named is the one refusal.
  if (cd "$dir/work" && RUNNER_TEMP="$dir" bash tool/reads.sh list) > /dev/null 2>&1; then echo "reads.sh: list took no job" >&2; fails=$((fails + 1)); fi
  # Under an exported GIT_DIR, as a hook runs, and a JOB_STATUS of the caller's: these cases again, from a repository
  # of one commit that must still be of one commit, its files as they were. Not from inside that run, which would have no end.
  if [ -z "$under" ]; then
    (cd "$dir" && g init -q outer && cd outer && echo k > keep.txt && g add -A && g commit -qm outer) > /dev/null 2>&1
    (cd "$dir/outer" && GIT_DIR="$dir/outer/.git" JOB_STATUS=failure bash "$dir/work/tool/reads.sh" --self-check) > "$dir/said" 2>&1 \
      || { echo "reads.sh: under an exported GIT_DIR and JOB_STATUS the cases did not hold: $(tail -1 "$dir/said")" >&2; fails=$((fails + 1)); }
    if [ "$(g -C "$dir/outer" log --format=%s | tr '\n' ' ')" != 'outer ' ] || [ -n "$(g -C "$dir/outer" status --short)" ]; then
      echo "reads.sh: under an exported GIT_DIR the cases wrote to the repository it names: $(g -C "$dir/outer" log --format=%s | tr '\n' ' ')" >&2; fails=$((fails + 1))
    fi
  fi
  if [ "$fails" -gt 0 ]; then echo "reads.sh: $fails case(s) wrong" >&2; return 1; fi
  echo "reads.sh: every case holds"
}

case "${1:-}" in
  --self-check) self_check ;;
  mark) mark ;;
  list) shift; list "$@" ;;
  *) echo "usage: reads.sh mark | list JOB [CELL] | --self-check" >&2; exit 2 ;;
esac
