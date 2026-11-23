#!/bin/bash
# What a job read (SMD-2435 PR 3b-1). `reads.sh mark [--watch]` straight
# after a job's checkout, `reads.sh list JOB [CELL]` as its last step but the
# list's upload, which writes the tracked files the job opened and the tracked
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
# `reads.sh mark --watch` also watches (PR 3c-1), for a job whose containers
# are given the checkout: a read through a read-only bind mount moves no
# access time, since the mount may write nothing. The watch is one inotify
# watch on each tracked folder, which the kernel tells of every open of the
# folder or of a file in it, through whatever mount and by whatever process.
# list ends the watch and adds what it saw: a tracked file opened is an f
# row, a tracked folder opened a d row, whether or not its time moved. The
# header then ends watch=ok; watch=lost where the watch ended early, was
# not heard from again, lost events (the kernel's queue filled) or was
# refused a watch on a folder, and watch=none where none began in time (no
# inotify, as off Linux, no python3, or one ten seconds in starting): the
# rows are then those the access times give, and whoever reads the list
# knows it may say less than the job read. The watch sees an open, not a
# read, so it also holds a file opened and only asked after; and a file
# opened and then deleted is both an f row and a g row, where by access
# times it was a g row alone.
#
# What a list does not hold:
# - a read through a container's read-only bind mount, which moves no access
#   time, in a job that does not watch: the jobs that run a compose stack
#   and do not watch read more than their lists say;
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

# The watch (mark --watch): python3, since a runner has it and bash has no
# inotify. Given the state directory, the checkout's top and its own name, it
# watches each folder named in STATE/watch.want (NUL-separated, relative to
# the top, "." the top) for opens, writes how many it watches to
# STATE/watch.ready, and keeps what is opened until STATE/watch.stop is
# there: then it reads what is still queued and writes STATE/watch.files
# (each name opened in a watched folder that is no folder, tracked or not),
# STATE/watch.dirs (each watched folder opened) and, last, STATE/watch.status:
# ok and its name, or lost with why. Ended by a file and not a signal: a
# process number read back from a file may by then be another's. It is the
# watch only while STATE/watch.asked holds its name: with the file gone or
# another name in it (a later marker's, or its own taken back as unheard) it
# ends itself within a moment and writes nothing, as it does after six
# hours, a job's longest.
read -r -d '' WATCH << 'PY' || true
import ctypes, errno, os, select, struct, sys, time

state, top, me = os.fsencode(sys.argv[1]), os.fsencode(sys.argv[2]), os.fsencode(sys.argv[3])
IN_OPEN, IN_Q_OVERFLOW, IN_ISDIR, IN_NONBLOCK = 0x20, 0x4000, 0x40000000, 0o4000
at = lambda name: os.path.join(state, name)


def write(name, data):
    with open(at(name + b'.part'), 'wb') as f:
        f.write(data)
    os.replace(at(name + b'.part'), at(name))


def mine():
    try:
        with open(at(b'watch.asked'), 'rb') as f:
            return f.read().strip() == me
    except OSError:
        return False


libc = ctypes.CDLL(None, use_errno=True)
if not hasattr(libc, 'inotify_init1'):
    sys.exit('no inotify here')
fd = libc.inotify_init1(IN_NONBLOCK)
if fd < 0:
    sys.exit('inotify_init1: ' + os.strerror(ctypes.get_errno()))
lost, folder = b'', {}
with open(at(b'watch.want'), 'rb') as f:
    want = [d for d in f.read().split(b'\0') if d]
for d in want:
    wd = libc.inotify_add_watch(fd, os.path.join(top, d), IN_OPEN)
    if wd >= 0:
        folder[wd] = d
    elif ctypes.get_errno() not in (errno.ENOENT, errno.ENOTDIR):
        # A folder not in the checkout is read by no one; any other refusal (the user's limit on watches) leaves one unwatched.
        lost = b'lost: no watch on ' + d + b': ' + os.strerror(ctypes.get_errno()).encode()
watched, files, dirs = set(folder.values()), set(), set()
if not mine():
    sys.exit(0)
write(b'watch.ready', str(len(folder)).encode() + b'\n')
born, stop, looked = time.monotonic(), None, 0.0
while True:
    quiet = not select.select([fd], [], [], 0.2)[0]
    if not quiet:
        try:
            buf = os.read(fd, 1 << 16)
        except BlockingIOError:
            buf = b''
        i = 0
        while i + 16 <= len(buf):
            wd, mask, _, n = struct.unpack_from('iIII', buf, i)
            name = buf[i + 16:i + 16 + n].split(b'\0', 1)[0]
            i += 16 + n
            if mask & IN_Q_OVERFLOW:
                lost = b'lost: the kernel dropped events, its queue full'
            if not mask & IN_OPEN or wd not in folder:
                continue
            d = folder[wd]
            path = d if not name else name if d == b'.' else d + b'/' + name
            if mask & IN_ISDIR:
                if path in watched:
                    dirs.add(path)
            else:
                files.add(path)
    now = time.monotonic()
    if now - looked >= 0.2:
        looked = now
        if not mine() or now - born > 6 * 3600:
            sys.exit(0)
    if stop is None:
        # Seen now, acted on at the next turn: only a wait begun after the stop was seen says nothing more is queued.
        if os.path.exists(at(b'watch.stop')):
            stop = now
    elif quiet or now - stop > 5:
        # Asked to stop: once nothing is queued, or five seconds on if opens never pause.
        break
if mine():
    write(b'watch.files', b''.join(p + b'\0' for p in sorted(files)))
    write(b'watch.dirs', b''.join(p + b'\0' for p in sorted(dirs)))
    write(b'watch.status', (lost or b'ok ' + me) + b'\n')
PY

# running PID: a process is there, and not one that has ended and waits only
# to be taken up: where nothing takes up an orphan (a container whose first
# process does not), kill -0 answers for it for good. Signal 0 sends nothing.
running() {
  local s
  kill -0 "$1" 2> /dev/null || return 1
  if [ -r "/proc/$1/stat" ]; then
    s=$(cat "/proc/$1/stat" 2> /dev/null) || return 1
    s=${s##*) }
    [ "${s%% *}" != Z ] || return 1
  fi
  return 0
}

# watch_start: the watch, begun under a name of its own (in watch.asked) and
# heard from before mark returns, so the step after it is watched. It never
# fails the mark. A watch not heard from in ten seconds (READS_WATCH_WAIT
# tenths of one, for the cases) may yet begin, with steps already run
# unwatched: its name is taken from it, so it ends itself when it looks, and
# with no watch.heard the list says none began (watch=none), its rows the
# access times'.
watch_start() {
  local pid id wait=${READS_WATCH_WAIT:-100}
  case "$wait" in '' | *[!0-9]*) wait=100 ;; esac
  id="$$.$RANDOM.$(date +%s)"
  echo "$id" > "$state/watch.asked" || return 0
  if ! command -v python3 > /dev/null 2>&1; then echo "::warning title=reads.sh::no python3 here, so no watch: the list will hold what access times show alone"; return 0; fi
  { printf '.\0'; git -C "$top" ls-tree -r -d --name-only -z HEAD 2> /dev/null; } > "$state/watch.want" || return 0
  # Its output to a file and its input from nowhere: a step waits on whatever still holds its pipes. -I, so
  # python looks for no module in the folder it is started in: it would list the checkout's top, which is then
  # a row of every watched job's, and load a file of the checkout's named as a module is.
  nohup python3 -I -c "$WATCH" "$state" "$top" "$id" < /dev/null > "$state/watch.log" 2>&1 &
  pid=$!
  echo "$pid" > "$state/watch.pid"
  # A watch that ended (no inotify) is not waited for.
  for _ in $(seq 1 "$wait"); do
    if [ -e "$state/watch.ready" ] || ! running "$pid"; then break; fi
    sleep 0.1
  done
  if [ -e "$state/watch.ready" ]; then
    : > "$state/watch.heard"
    echo "reads.sh: watching $(tr -d '\n' < "$state/watch.ready") folders for opens"
  else
    echo "$id unheard" > "$state/watch.asked"
    echo "::warning title=reads.sh::the watch did not start ($(tail -n 1 "$state/watch.log" 2> /dev/null | grep . || echo "not heard from in $((wait / 10)).$((wait % 10)) s")): the list will hold what access times show alone"
  fi
}

# watch_stop: ends the watch and says how it stood: ok, with what it saw in
# watch.files and watch.dirs, when its status is ok under its own name; lost,
# when it was heard from and then ended early, lost events, could not watch a
# folder or is not heard from again in ten seconds, with why in watch.why;
# none, when it was not heard from as mark made it.
watch_stop() {
  local pid said
  if [ ! -e "$state/watch.heard" ]; then echo none; return 0; fi
  : > "$state/watch.stop"
  pid=$(cat "$state/watch.pid" 2> /dev/null || true)
  for _ in $(seq 1 100); do
    [ ! -e "$state/watch.status" ] || break
    # Gone with no status written, the watch is lost now and not in ten seconds. Were the number another's by
    # now, the wait would only be the full ten.
    if [ -n "$pid" ] && ! running "$pid"; then break; fi
    sleep 0.1
  done
  said=$(cat "$state/watch.status" 2> /dev/null || true)
  if [ -n "$said" ] && [ "$said" = "ok $(cat "$state/watch.asked" 2> /dev/null || true)" ]; then echo ok; return 0; fi
  case "$said" in
    lost:*) echo "${said#lost: }" ;;
    '') echo "it ended with no status: $(tail -n 1 "$state/watch.log" 2> /dev/null | grep . || echo 'it said nothing')" ;;
    *) echo "its status is another watch's" ;;
  esac > "$state/watch.why"
  echo lost
}
mark() {
  local watch=${1:-}
  if [ -n "$watch" ] && [ "$watch" != --watch ]; then echo "usage: reads.sh mark [--watch]" >&2; return 2; fi
  mkdir -p "$state" || return 1
  # Not empty: a read of no bytes moves no access time on some filesystems (APFS).
  echo sight > "$state/sight" || return 1
  : > "$state/marker" || return 1
  # A marker without --watch is of a job that does not watch: nothing a marker before it left says otherwise.
  # And a watch a marker before it began ends itself, its name gone with these files, and writes nothing more.
  rm -f "$state"/watch.*
  if [ -n "$watch" ]; then watch_start; fi
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
  local job=${1:-} cell=${2:-} dir out sight=ok files=0 dirs=0 odd=0 gone=0 tmp own='' more='' watch='' alone=0
  if [ -z "$job" ]; then echo "usage: reads.sh list JOB [CELL]" >&2; return 2; fi
  job=${job//[^A-Za-z0-9_.-]/_} cell=${cell//[^A-Za-z0-9_.-]/_}
  dir=${RUNNER_TEMP:-${TMPDIR:-/tmp}}/reads
  out="$dir/$job${cell:+.$cell}.txt"
  if ! mkdir -p "$dir" || ! tmp=$(mktemp "$dir/.list.XXXXXX"); then echo "reads.sh: no scratch file under $dir" >&2; return 0; fi
  # The watch ends first: what this step opens is none of the job's.
  if [ -e "$state/watch.asked" ]; then watch=$(watch_stop); fi
  if [ ! -e "$state/marker" ]; then
    sight=unmarked
  else
    # Its own sight first: a file mark made before the marker, read now. One
    # written after the marker would show as read with no read at all, so
    # that is blind too.
    cat "$state/sight" > /dev/null 2>&1
    if [ "$state/sight" -nt "$state/marker" ] || [ -z "$(find "$state/sight" -maxdepth 0 -neweram "$state/marker" 2> /dev/null)" ]; then sight=blind; fi
  fi
  # rows KIND FILE: the NUL-separated paths on stdin, each with or without a
  # leading ./, as KIND's rows on FILE; one with a tab or a newline in it goes
  # to $tmp.o, NUL-ended, and into no row. Two witnesses can name one path, so
  # rows and odd paths are counted once sorted, each once.
  rows() {
    local p
    while IFS= read -r -d '' p; do
      p=${p#./}
      case "$1:$p" in
        *$'\n'* | *$'\t'*) printf '%s\0' "$p" >> "$tmp.o" ;;
        d:.) printf 'd\t./\n' ;;
        d:*) printf 'd\t%s/\n' "$p" ;;
        *) printf '%s\t%s\n' "$1" "$p" ;;
      esac
    done >> "$2"
  }
  : > "$tmp.a"; : > "$tmp.w"; : > "$tmp.o"
  if [ "$sight" = ok ]; then
    # By access time. This file first, when the checkout tracks it: read before the marker, so by rule and not by its time.
    case "$SELF" in "$top"/*) own=${SELF#"$top"/} ;; esac
    if [ -n "$own" ] && git -C "$top" ls-files --error-unmatch -- "$own" > /dev/null 2>&1; then printf '%s\0' "$own" | rows f "$tmp.a"; fi
    git -C "$top" ls-files -z | later_than_marker | rows f "$tmp.a"
    { printf '.\0'; git -C "$top" ls-tree -r -d --name-only -z HEAD 2> /dev/null; } | later_than_marker | rows d "$tmp.a"
    git -C "$top" ls-files -z | gone_now | rows g "$tmp.a"
    # By the watch: of the names it saw opened, those git tracks, each asked after as the one path it is; and the
    # tracked folders it saw opened. xargs is given nothing to run on no names: with none, ls-files would name every file.
    if [ "$watch" = ok ]; then
      if [ -s "$state/watch.files" ]; then (cd "$top" && xargs -0 git --literal-pathspecs ls-files -z -- < "$state/watch.files") | rows f "$tmp.w"; fi
      rows d "$tmp.w" < "$state/watch.dirs"
    fi
  fi
  LC_ALL=C sort -u "$tmp.a" "$tmp.w" > "$tmp.s"
  files=$(grep -c "^f$(printf '\t')" "$tmp.s"); dirs=$(grep -c "^d$(printf '\t')" "$tmp.s"); gone=$(grep -c "^g$(printf '\t')" "$tmp.s")
  odd=$(LC_ALL=C sort -zu "$tmp.o" | tr -cd '\0' | wc -c | tr -d ' ')
  # What the watch alone saw: the rows no access time gave.
  alone=$(LC_ALL=C sort -u "$tmp.w" | LC_ALL=C comm -13 <(LC_ALL=C sort -u "$tmp.a") - | tee "$tmp.x" | wc -l | tr -d ' ')
  {
    printf '# reads v1 job=%s cell=%s commit=%s status=%s sight=%s files=%s dirs=%s gone=%s odd=%s%s\n' \
      "$job" "${cell:--}" "$(git -C "$top" rev-parse HEAD 2> /dev/null || echo -)" "${JOB_STATUS:--}" "$sight" "$files" "$dirs" "$gone" "$odd" "${watch:+ watch=$watch}"
    cat "$tmp.s"
  } > "$tmp" && mv "$tmp" "$out"
  case "$sight" in
    blind) echo "::warning title=reads.sh::this filesystem recorded no access time for a file just read, so $job${cell:+ ($cell)}'s list is empty" ;;
    unmarked) echo "::warning title=reads.sh::no marker was made after the checkout, so $job${cell:+ ($cell)}'s list is empty" ;;
  esac
  case "$watch" in
    lost) echo "::warning title=reads.sh::the watch was lost ($({ tr -d '\n' < "$state/watch.why"; } 2> /dev/null)), so $job${cell:+ ($cell)}'s list holds what access times show alone" ;;
    none) echo "::warning title=reads.sh::no watch began, so $job${cell:+ ($cell)}'s list holds what access times show alone" ;;
  esac
  if [ "$gone" -gt 0 ]; then more=", $gone gone by the end"; fi
  if [ "$odd" -gt 0 ]; then more="$more, $odd path(s) with a tab or a newline left out"; fi
  if [ -n "$watch" ]; then more="$more, watch $watch"; fi
  if [ "$watch" = ok ]; then more="$more: $alone row(s) by the watch alone"; fi
  echo "reads.sh: $job${cell:+ ($cell)} opened $files of $(git -C "$top" ls-files | wc -l | tr -d ' ') tracked files and listed $dirs folders (sight $sight$more), digest $(sed 1d "$out" | git hash-object --stdin | cut -c1-12)"
  # Where they are, by top-level folder, most first: a list that grows shows where.
  grep '^f' "$out" | cut -f2- | awk -F/ '{ n[(NF > 1) ? $1 : "(top)"]++ } END { for (d in n) printf "  %5d %s\n", n[d], d }' | LC_ALL=C sort -k1,1nr -k2
  # The rows the watch alone gave, the first forty: what a list by access times would have lacked.
  if [ "$alone" -gt 0 ]; then echo "  by the watch alone:"; head -n 40 "$tmp.x" | sed 's/^/    /'; if [ "$alone" -gt 40 ]; then echo "    … and $((alone - 40)) more"; fi; fi
  rm -f "$tmp" "$tmp.a" "$tmp.w" "$tmp.o" "$tmp.s" "$tmp.x"
  return 0
}

self_check() {
  local dir fails=0 out v under=${GIT_DIR:+yes} watched='' as
  # The caller's, which a list would write in its header where the cases expect none.
  unset JOB_STATUS
  # git exports GIT_DIR and its like to whatever it runs, a hook above all, and under them every git command
  # below would act on the caller's repository, not the scratch one: `commit` on its branch, `add -A` on its index.
  for v in $(git rev-parse --local-env-vars); do unset "$v"; done
  # On the checkout's own filesystem, whose access times the jobs' lists rest on: /tmp can be another mount.
  dir=$(mktemp -d "$gitdir/ob1-reads-check.XXXXXX") || { echo "reads.sh: no scratch directory in $gitdir" >&2; return 1; }
  # Gone however this ends, an interrupt included: it holds two repositories, inside the caller's git directory.
  # shellcheck disable=SC2064 # $dir as it is now: it is local, and unset by the time the script exits
  # A watch a case holds stopped is let go first: stopped, it would never see its files gone, and would stay.
  trap "kill -CONT \"\$(cat $(printf '%q' "$dir/work/.git/ob1-reads/watch.pid") 2> /dev/null)\" 2> /dev/null; rm -rf $(printf '%q' "$dir")" EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  # The scratch commits under no setting of the caller's that could stop one: a signature asked of every commit, a hook.
  g() { git -c user.email=ci@example.invalid -c user.name=ci -c init.defaultBranch=main -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }
  # has LINE / hasnt LINE: the list holds the line, whole; or does not.
  # gone_soon PID: waits, three seconds at the most, for a process to end.
  gone_soon() { for _ in $(seq 1 30); do running "$1" || return 0; sleep 0.1; done; return 0; }
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
  # The watch (mark --watch). A file read and a folder listed before the marker, then again after it: no access
  # time moves for the second, and the watch has both. An untracked file opened in a tracked folder is no row.
  # The first read is a tick after the clone wrote the file: in the same tick it would leave the time where the
  # write put it, and the second read would move it.
  fresh
  out="$dir/reads/job.watched.txt"
  (cd "$dir/work" && sleep 0.05 && cat top.txt > /dev/null && ls walked > /dev/null && sleep 0.05 && bash tool/reads.sh mark --watch > "$dir/said" 2>&1 && cat top.txt read/a.txt > /dev/null && ls walked > /dev/null \
    && echo u > read/untracked.txt && cat read/untracked.txt > /dev/null && mkdir read/made && ls read/made > /dev/null \
    && JOB_STATUS=success RUNNER_TEMP="$dir" bash tool/reads.sh list job watched >> "$dir/said" 2>&1) \
    || { echo "reads.sh: mark --watch, reads and list did not all exit 0" >&2; fails=$((fails + 1)); }
  case "$(head -1 "$out" 2> /dev/null)" in
    *' sight=ok '*' watch=ok')
      watched=yes
      has "$(printf 'f\ttop.txt')" "a file read a second time, under the watch"
      has "$(printf 'f\tread/a.txt')" "a file read, under the watch"
      has "$(printf 'f\ttool/reads.sh')" "this file's copy, under the watch"
      has "$(printf 'd\twalked/')" "a folder listed a second time, under the watch"
      hasnt "$(printf 'f\tread/untracked.txt')" "an untracked file opened"
      hasnt "$(printf 'd\tread/made/')" "an untracked folder listed"
      hasnt "$(printf 'f\twalked/c.txt')" "a file in a folder listed, itself unopened, under the watch"
      hasnt "$(printf 'f\tleft/b.txt')" "a file never opened, under the watch"
      hasnt "$(printf 'd\t./')" "the top, which only the watch's own start could have listed"
      [ "$(sed 1d "$out" | LC_ALL=C sort -u)" = "$(sed 1d "$out")" ] || { echo "reads.sh: a watched list is not sorted, or holds a row twice" >&2; fails=$((fails + 1)); }
      [ "$(sed 1d "$out" | grep -c "^f$(printf '\t')")" = "$(sed -n '1s/.* files=\([0-9]*\) .*/\1/p' "$out")" ] || { echo "reads.sh: a watched list's file rows are not as many as its header counts" >&2; fails=$((fails + 1)); }
      # Where a second read moves no time (relatime, a runner's), the watch alone gave that row, and the list says so.
      if ! grep -qxF -- "$(printf '    f\ttop.txt')" "$dir/said"; then
        if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "reads.sh: a second read moved the file's access time, so the case for the watch shows nothing on this runner" >&2; fails=$((fails + 1))
        else echo "reads.sh: this filesystem moves a file's access time on every read; the watch's case shows nothing more here"; fi
      fi
      # The watch is over once its list is written.
      gone_soon "$(cat "$dir/work/.git/ob1-reads/watch.pid" 2> /dev/null)"
      if running "$(cat "$dir/work/.git/ob1-reads/watch.pid" 2> /dev/null)"; then echo "reads.sh: the watch is still running after its list" >&2; fails=$((fails + 1)); fi
      ;;
    *' sight=blind '*' watch='*) ;;
    *' watch=none')
      # No inotify (off Linux) or no python3. On a runner that is the news: the watched jobs' lists would say less than they read.
      if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "reads.sh: no watch began on this runner: $(grep -m 1 'title=reads.sh' "$dir/said")" >&2; fails=$((fails + 1))
      else echo "reads.sh: no watch can run here (no inotify, or no python3); its cases are not run"; fi
      gone_soon "$(cat "$dir/work/.git/ob1-reads/watch.pid" 2> /dev/null)"
      [ "$(grep -c '^::warning title=reads.sh::' "$dir/said")" = 2 ] || { echo "reads.sh: with no watch, mark and list did not each warn" >&2; fails=$((fails + 1)); }
      has "$(printf 'f\tread/a.txt')" "a file read, with no watch"
      ;;
    *) echo "reads.sh: after mark --watch the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)) ;;
  esac
  if [ -n "$watched" ]; then
    # Through a read-only bind mount in a mount namespace of its own, as a container is handed a path: the file's
    # time cannot move, and the watch has it. Where mounting is allowed: as root, or by sudo with no password, a runner's.
    as=()
    if [ "$(id -u)" != 0 ]; then as=(sudo -n); fi
    fresh
    mkdir -p "$dir/mnt"
    out="$dir/reads/job.mounted.txt"
    # shellcheck disable=SC2016 # sh expands "$1" and "$2", not this shell
    if (cd "$dir/work" && bash tool/reads.sh mark --watch > /dev/null 2>&1 \
        && ${as[@]+"${as[@]}"} unshare -m --propagation private sh -c 'mount --bind "$1" "$2" && mount -o remount,bind,ro "$2" && cat "$2/c.txt" > /dev/null' sh "$dir/work/walked" "$dir/mnt") > /dev/null 2>&1; then
      (cd "$dir/work" && RUNNER_TEMP="$dir" bash tool/reads.sh list job mounted > "$dir/said" 2>&1) || { echo "reads.sh: the list after a read through a mount did not exit 0" >&2; fails=$((fails + 1)); }
      has "$(printf 'f\twalked/c.txt')" "a file read through a read-only bind mount"
      grep -qxF -- "$(printf '    f\twalked/c.txt')" "$dir/said" || { echo "reads.sh: a file read through a read-only bind mount is not among the rows the watch alone gave: its access time moved, so the mount was not read-only" >&2; fails=$((fails + 1)); }
    elif [ -n "${GITHUB_ACTIONS:-}" ]; then echo "reads.sh: could not read a file through a read-only bind mount on this runner, the case the watch is for" >&2; fails=$((fails + 1))
    else
      (cd "$dir/work" && RUNNER_TEMP="$dir" bash tool/reads.sh list job mounted) > /dev/null 2>&1
      echo "reads.sh: no mount can be made here (not root, and no sudo without a password); the case for a read through a read-only bind mount is not run"
    fi
    # A watch that ended early is lost: the list says so, holds what the access times give, warns and exits 0.
    fresh
    out="$dir/reads/job.lost.txt"
    (cd "$dir/work" && bash tool/reads.sh mark --watch > /dev/null 2>&1 && cat top.txt > /dev/null && kill -KILL "$(cat .git/ob1-reads/watch.pid)" \
      && RUNNER_TEMP="$dir" bash tool/reads.sh list job lost > "$dir/said" 2>&1) || { echo "reads.sh: a list whose watch was killed did not exit 0" >&2; fails=$((fails + 1)); }
    grep -q '^# reads v1 job=job cell=lost .* sight=ok .* odd=0 watch=lost$' "$out" 2> /dev/null || { echo "reads.sh: with its watch killed the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
    has "$(printf 'f\ttop.txt')" "a file read, its watch killed"
    grep -q '^::warning title=reads.sh::the watch was lost (it ended with no status' "$dir/said" || { echo "reads.sh: a list whose watch was killed did not say so: $(grep -m 1 'title=reads.sh' "$dir/said")" >&2; fails=$((fails + 1)); }
    if grep -v -E '^(::warning|reads\.sh: |  )' "$dir/said" | grep . > /dev/null; then echo "reads.sh: a list whose watch was killed said more than its lines: $(grep -v -E '^(::warning|reads\.sh: |  )' "$dir/said" | head -1)" >&2; fails=$((fails + 1)); fi
    # So is one whose status is there under another watch's name, as an earlier watch's would be: not taken for this one's.
    fresh
    out="$dir/reads/job.other.txt"
    (cd "$dir/work" && bash tool/reads.sh mark --watch > /dev/null 2>&1 && kill -KILL "$(cat .git/ob1-reads/watch.pid)" && echo 'ok another' > .git/ob1-reads/watch.status \
      && : > .git/ob1-reads/watch.files && : > .git/ob1-reads/watch.dirs && RUNNER_TEMP="$dir" bash tool/reads.sh list job other > "$dir/said" 2>&1) || { echo "reads.sh: a list beside another watch's status did not exit 0" >&2; fails=$((fails + 1)); }
    grep -q ' odd=0 watch=lost$' "$out" 2> /dev/null || { echo "reads.sh: with another watch's status the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
    grep -q "^::warning title=reads.sh::the watch was lost (its status is another watch's)" "$dir/said" || { echo "reads.sh: a list beside another watch's status did not say so: $(grep -m 1 'title=reads.sh' "$dir/said")" >&2; fails=$((fails + 1)); }
    # So is one whose events the kernel dropped: held still while more opens than the kernel queues go by, two
    # files by turns, since the same open twice running is queued once. Where the queue is very long, not tried, and said.
    v=$(cat /proc/sys/fs/inotify/max_queued_events 2> /dev/null || echo 0)
    if [ "$v" -gt 0 ] && [ "$v" -le 600000 ]; then
      fresh
      out="$dir/reads/job.dropped.txt"
      (cd "$dir/work" && bash tool/reads.sh mark --watch > /dev/null 2>&1 && kill -STOP "$(cat .git/ob1-reads/watch.pid)" \
        && for _ in $(seq 1 $((v / 2 + 1000))); do : < top.txt; : < read/a.txt; done && kill -CONT "$(cat .git/ob1-reads/watch.pid)" \
        && RUNNER_TEMP="$dir" bash tool/reads.sh list job dropped > "$dir/said" 2>&1) || { echo "reads.sh: a list whose watch dropped events did not exit 0" >&2; fails=$((fails + 1)); }
      grep -q '^# reads v1 job=job cell=dropped .* odd=0 watch=lost$' "$out" 2> /dev/null || { echo "reads.sh: with more opens than the kernel queues the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
      grep -q '^::warning title=reads.sh::the watch was lost (the kernel dropped events' "$dir/said" || { echo "reads.sh: a watch that dropped events did not say so: $(grep -m 1 'title=reads.sh' "$dir/said")" >&2; fails=$((fails + 1)); }
    else echo "reads.sh: the kernel queues $v opens here; the case for a watch whose events it dropped is not run"; fi
    # What is still queued when the watch is told to stop is read to the end: held still, five thousand opens, more
    # than two reads of the queue take, then one of a file read before the marker, which only the watch can show.
    if [ "$v" -ge 6000 ]; then
      fresh
      out="$dir/reads/job.queued.txt"
      (cd "$dir/work" && sleep 0.05 && cat walked/c.txt > /dev/null && sleep 0.05 && bash tool/reads.sh mark --watch > /dev/null 2>&1 && kill -STOP "$(cat .git/ob1-reads/watch.pid)" \
        && for _ in $(seq 1 2500); do : < top.txt; : < read/a.txt; done && : < walked/c.txt && : > .git/ob1-reads/watch.stop && kill -CONT "$(cat .git/ob1-reads/watch.pid)" \
        && RUNNER_TEMP="$dir" bash tool/reads.sh list job queued > /dev/null 2>&1) || { echo "reads.sh: a list whose watch had opens queued at its stop did not exit 0" >&2; fails=$((fails + 1)); }
      grep -q ' odd=0 watch=ok$' "$out" 2> /dev/null || { echo "reads.sh: with opens queued at the stop the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
      has "$(printf 'f\twalked/c.txt')" "the last open queued when the watch was told to stop"
    fi
    # With a python3 that cannot watch, as off Linux: no watch begins, mark says so and exits 0, and the list says watch=none.
    fresh
    out="$dir/reads/job.none.txt"
    mkdir -p "$dir/stub" && printf '#!/bin/sh\necho "no inotify here" >&2\nexit 1\n' > "$dir/stub/python3" && chmod +x "$dir/stub/python3"
    (cd "$dir/work" && PATH="$dir/stub:$PATH" bash tool/reads.sh mark --watch > "$dir/said" 2>&1 && cat top.txt > /dev/null \
      && RUNNER_TEMP="$dir" bash tool/reads.sh list job none >> "$dir/said" 2>&1) || { echo "reads.sh: mark --watch and list with no watch to start did not exit 0" >&2; fails=$((fails + 1)); }
    grep -q '^# reads v1 job=job cell=none .* sight=ok .* odd=0 watch=none$' "$out" 2> /dev/null || { echo "reads.sh: with no watch to start the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
    has "$(printf 'f\ttop.txt')" "a file read, with no watch to start"
    [ "$(grep -c '^::warning title=reads.sh::' "$dir/said")" = 2 ] || { echo "reads.sh: with no watch to start, mark and list did not each warn" >&2; fails=$((fails + 1)); }
    # A watch that begins after mark has stopped waiting for it is no watch: steps have run unwatched by then.
    # A python3 two seconds in starting, a wait of half a second: mark says so, the late watch ends itself, and
    # the list says watch=none, though the watch did come up before it.
    fresh
    out="$dir/reads/job.late.txt"
    printf '#!/bin/sh\nsleep 2\nexec "%s" "$@"\n' "$(command -v python3)" > "$dir/stub/python3"
    (cd "$dir/work" && PATH="$dir/stub:$PATH" READS_WATCH_WAIT=5 bash tool/reads.sh mark --watch > "$dir/said" 2>&1 && v=$(cat .git/ob1-reads/watch.pid) \
      && cat top.txt > /dev/null && sleep 2 && gone_soon "$v" && { ! running "$v" || { echo "reads.sh: a watch that began too late is still running" >&2; exit 1; }; } \
      && RUNNER_TEMP="$dir" bash tool/reads.sh list job late >> "$dir/said" 2>&1) || { echo "reads.sh: mark --watch with a watch late to start, and its list, did not hold" >&2; fails=$((fails + 1)); }
    grep -q '^# reads v1 job=job cell=late .* sight=ok .* odd=0 watch=none$' "$out" 2> /dev/null || { echo "reads.sh: with a watch late to start the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
    grep -q '^::warning title=reads.sh::the watch did not start (not heard from in 0.5 s)' "$dir/said" || { echo "reads.sh: mark did not say its watch was late: $(grep -m 1 'title=reads.sh' "$dir/said")" >&2; fails=$((fails + 1)); }
    # A marker without --watch over a live watch is of a job that does not watch: the watch ends itself, and the
    # list's header names none.
    fresh
    (cd "$dir/work" && bash tool/reads.sh mark --watch > /dev/null 2>&1 && v=$(cat .git/ob1-reads/watch.pid) && bash tool/reads.sh mark > /dev/null 2>&1 \
      && gone_soon "$v" && { ! running "$v" || { echo "reads.sh: a watch is still running after a plain mark" >&2; exit 1; }; } \
      && RUNNER_TEMP="$dir" bash tool/reads.sh list job plain > /dev/null 2>&1) || { echo "reads.sh: a plain mark over a live watch, and its list, did not hold" >&2; fails=$((fails + 1)); }
    grep -q ' odd=0$' "$dir/reads/job.plain.txt" 2> /dev/null || { echo "reads.sh: after a plain mark the header is '$(head -1 "$dir/reads/job.plain.txt" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
    # A second marker that watches takes the watch over: the first ends itself and writes nothing, and the list is the second's.
    fresh
    out="$dir/reads/job.second.txt"
    (cd "$dir/work" && sleep 0.05 && cat top.txt > /dev/null && sleep 0.05 && bash tool/reads.sh mark --watch > /dev/null 2>&1 && v=$(cat .git/ob1-reads/watch.pid) \
      && bash tool/reads.sh mark --watch > /dev/null 2>&1 && gone_soon "$v" && { ! running "$v" || { echo "reads.sh: the first of two watches is still running" >&2; exit 1; }; } \
      && cat top.txt > /dev/null && RUNNER_TEMP="$dir" bash tool/reads.sh list job second > "$dir/said" 2>&1) || { echo "reads.sh: two watched marks and a list did not hold" >&2; fails=$((fails + 1)); }
    grep -q ' odd=0 watch=ok$' "$out" 2> /dev/null || { echo "reads.sh: after two watched marks the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
    has "$(printf 'f\ttop.txt')" "a file read a second time, under the second of two watches"
    if grep -v -E '^(::warning|reads\.sh: |  )' "$dir/said" | grep . > /dev/null; then echo "reads.sh: the list after two watched marks said more than its lines: $(grep -v -E '^(::warning|reads\.sh: |  )' "$dir/said" | head -1)" >&2; fails=$((fails + 1)); fi
  fi
  # mark takes --watch and nothing else.
  if (cd "$dir/work" && bash tool/reads.sh mark --wach) > /dev/null 2>&1; then echo "reads.sh: mark took a word that is not --watch" >&2; fails=$((fails + 1)); fi
  out="$dir/reads/job.cell.txt"
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
  mark) shift; mark "$@" ;;
  list) shift; list "$@" ;;
  *) echo "usage: reads.sh mark [--watch] | list JOB [CELL] | --self-check" >&2; exit 2 ;;
esac
