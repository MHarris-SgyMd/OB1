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
# readFileSync, a cat, a walk. Without --watch nothing is traced and nothing
# is slowed.
#
# The lists are recorded and kept on a push to main, and the changes job
# reads them (PR 3b-2): .github/ci/changes.sh's by_map fetches the lists of
# main's newest green run and skips a pull request's job when nothing its
# list holds differs since. So a row is a claim a skip rests on: by_map
# reads the header's job, cell, commit, status, sight and counts, and each
# row's kind and path, and takes a list whose rows are not as many as its
# header counts for no list at all. Of a job its WATCHED names (PR 3c-2) it
# takes only a list whose header ends watch=ok, below; of any other job,
# only one that says nothing of a watch.
#
# A list's rows, under its header line:
#   f<TAB>path    a tracked file opened since the marker;
#   d<TAB>path/   a tracked folder listed since it ("./" the top);
#   g<TAB>path    a tracked file gone by the job's end, opened or not: its
#                 access time went with it, so whoever reads the list takes
#                 it as read.
# In a list with sight this file's own row is always there, when the
# checkout tracks it: the mark step's bash reads it before it can make the
# marker, and a second read moves no access time.
#
# `reads.sh mark --watch` also watches (PR 3c-1), for a job that runs
# containers: one handed a path of the checkout reads it through a read-only
# bind mount, where no access time moves, since the mount may write nothing.
# The watch is one inotify watch on each tracked folder, which the kernel
# tells of each open, to read or to write, of the folder or of a file in it
# by its name there, through whatever mount and by whatever process. list
# ends the watch and adds what it gives:
# - a tracked file opened is an f row and a tracked folder opened a d row,
#   whether or not its time moved;
# - where a tracked folder is another folder by the end (removed and made
#   again, swapped, or made since the marker), every tracked file under it
#   is an f row and it a d row, since the watch stayed with the first;
# - a tracked file changed in itself since the marker (its name, links,
#   mode, owner, or bytes written) is an f row: one given a second name in a
#   folder no watch is on, or moved out and back, can be read where neither
#   witness is told.
# The header then ends watch=ok, whatever its sight, or:
# - watch=lost: the watch ended early, was not heard from again, lost events
#   (the kernel's queue filled), could not read all that was queued in five
#   seconds, was refused a watch on a folder, was told of no opening of this
#   file (the list step's bash opens it before the watch is told to stop: a
#   watch with nothing to show for its ok is not believed), or had been ended
#   by an earlier list;
# - watch=none: none began in time (no inotify, as off Linux, no python3,
#   one ten seconds in starting, tracked folders git could not name, or the
#   watch's name or its word that it began unwritten).
# Lost or none, the rows are those the access times give, and whoever reads
# the list knows it may say less than the job read; a warning says why at
# the list, and at the mark where it is known by then. A watching job's
# marker is not empty, which is how its list knows a watch was asked for
# whatever became of the watch's own files. The list step's summary line
# says how many names the watch was told were opened, tracked or not, and
# how many rows an access time gave that it was not told of: files reached
# by a second name, moved into place or timed without being opened, and
# links read. That count is no test of the watch's hearing. The watch is told
# of an open, not a read, so it also gives a file opened and only asked
# after; and a file opened and then deleted is both an f row and a g row,
# where by access times it was a g row alone.
#
# What a list does not hold:
# - a read through a container's read-only bind mount, which moves no access
#   time, in a job that does not watch: the jobs that run a compose stack
#   and do not watch read more than their lists say;
# - a file only asked after and never opened (existsSync, `[ -f x ]`, a size
#   or a mode read): no access time moves, so a path added, removed or made
#   executable can matter to a job whose list has neither it nor its folder;
# - a second read, which relatime leaves alone, so only "read at all";
# - through a read-only mount, where no time moves and so beyond the watch
#   too: a tracked symbolic link that is followed (the kernel tells of the
#   file it leads to; whoever reads the lists runs every job when a link
#   changes); a file read by a descriptor opened before the marker, which no
#   step holds; and one opened by its handle with no name (open_by_handle_at),
#   which asks a capability no container is given unasked;
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
#   a --separate-git-dir) is not tested, here or by the self-check;
# - anything at all, when a command that names the paths or writes the rows
#   failed (git, a find that died, a sort, a full disk) or the marker went
#   while the list was made: the list then says sight=broken and holds no
#   row, since a list short of rows is the one worse than none. Where the
#   list itself cannot be written there is none, and a warning says so. A
#   find that only could not read a path takes it for gone, as one that is.
# What it holds beyond the job's own reads: every file git read back to
# compare (a `git diff` or `git status` re-reads a file written in the same
# second as the index), which only adds.
set -uo pipefail

SELF=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$(basename "${BASH_SOURCE[0]}")
# The marker, the file list reads to test its own sight and the watch's
# files, in the checkout's git directory (a linked worktree's is its own, and
# its .git a file): no path git tracks, and on a runner the filesystem the
# tracked files are on.
if ! top=$(git rev-parse --show-toplevel 2> /dev/null) || ! gitdir=$(git rev-parse --absolute-git-dir 2> /dev/null); then echo "reads.sh: not in a git checkout" >&2; exit 2; fi
state="$gitdir/ob1-reads"

# The watch (mark --watch): python3, since a runner has it and bash has no
# inotify. Given the state directory, the checkout's top and its own name, it
# watches each folder named in STATE/watch.want (NUL-separated, relative to
# the top, "." the top) for opens, writes how many it watches to
# STATE/watch.ready, and keeps what is opened until STATE/watch.stop is
# there: then it reads what is still queued and writes STATE/watch.files
# (each name opened in a watched folder that is no folder, tracked or not),
# STATE/watch.dirs (each watched folder opened), STATE/watch.under (each that
# is another folder than the one first watched, or is there and was not)
# and, last, STATE/watch.status: ok and its name, or lost with why. A folder
# it could not watch it names at once in STATE/watch.short. Ended by a file
# and not a signal: a process number read back from a file may by then be
# another's. It is the watch only while STATE/watch.asked holds its name:
# with the file gone or another name in it (a later marker's, or its own
# taken back as unheard) it ends itself within a moment and writes nothing,
# as it does after six hours, a job's longest.
read -r -d '' WATCH << 'PY' || true
import ctypes, errno, os, select, struct, sys, time

state, top, me = os.fsencode(sys.argv[1]), os.fsencode(sys.argv[2]), os.fsencode(sys.argv[3])
IN_OPEN, IN_Q_OVERFLOW, IN_IGNORED, IN_ISDIR, IN_NONBLOCK = 0x20, 0x4000, 0x8000, 0x40000000, 0o4000
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


def inode(d):
    try:
        st = os.stat(os.path.join(top, d))
        return st.st_dev, st.st_ino
    except OSError:
        return None


libc = ctypes.CDLL(None, use_errno=True)
if not hasattr(libc, 'inotify_init1'):
    sys.exit('no inotify here')
fd = libc.inotify_init1(IN_NONBLOCK)
if fd < 0:
    sys.exit('inotify_init1: ' + os.strerror(ctypes.get_errno()))
try:
    with open('/proc/sys/fs/inotify/max_queued_events', 'rb') as f:
        queue = f.read().strip()
except OSError:
    queue = b'unknown length'
lost, folder, first = b'', {}, {}
with open(at(b'watch.want'), 'rb') as f:
    want = [d for d in f.read().split(b'\0') if d]
for d in want:
    wd = libc.inotify_add_watch(fd, os.path.join(top, d), IN_OPEN)
    if wd >= 0:
        folder[wd], first[d] = d, inode(d)
    elif ctypes.get_errno() in (errno.ENOENT, errno.ENOTDIR):
        # A folder not in the checkout is read by no one, unless it is there by the end: another folder then.
        first[d] = None
    else:
        # Any other refusal (the user's limit on watches) leaves a folder unwatched.
        lost = b'lost: no watch on ' + d + b': ' + os.strerror(ctypes.get_errno()).encode()
        if ctypes.get_errno() == errno.ENOSPC:
            lost += b' (not the disk: the limit on watches, fs.inotify.max_user_watches)'
        write(b'watch.short', lost[6:] + b'\n')
watched, files, dirs, ended = set(folder.values()), set(), set(), set()
if not mine():
    sys.exit('ended before it began: its name is not in watch.asked')
# With its name: a marker takes only its own watch's word that it has begun.
write(b'watch.ready', str(len(folder)).encode() + b' ' + me + b'\n')
born, stop, looked = time.monotonic(), None, 0.0
while True:
    # Until the stop, a wait; after it, a look. An open is queued before it returns to whoever made it, so all
    # that were made before the stop are queued by the look that follows it, and none can come later.
    quiet = not select.select([fd], [], [], 0.2 if stop is None else 0)[0]
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
                lost = b'lost: the kernel dropped events, its queue of ' + queue + b' full (fs.inotify.max_queued_events)'
            if mask & IN_IGNORED and wd in folder:
                # The kernel has ended this folder's watch: the folder was removed. One made again in its place
                # can be given the same number, so it is known by this and not by its number alone.
                ended.add(folder[wd])
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
            sys.exit('ended: its name is gone from watch.asked, or six hours have passed')
    if stop is None:
        # Seen now, acted on at the next turn: only a wait begun after the stop was seen says nothing more is queued.
        if os.path.exists(at(b'watch.stop')):
            stop = now
    elif quiet:
        break
    elif now - stop > 5:
        # Five seconds on and never a look that found nothing queued: opens that will not pause, or itself held up.
        lost = b'lost: opens were still queued five seconds after the stop'
        break
# A watched folder that is another folder now, or gone, or was not there and is: the watch stayed with the first,
# and what was opened in the second it never saw. Every tracked file under such a folder is taken as opened, and
# the folder as listed.
under = sorted(set(d for d in first if inode(d) != first[d]) | ended)
if mine():
    write(b'watch.files', b''.join(p + b'\0' for p in sorted(files)))
    write(b'watch.dirs', b''.join(p + b'\0' for p in sorted(dirs)))
    write(b'watch.under', b''.join(p + b'\0' for p in under))
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

# watch_wait: how long mark waits to hear from a watch, and list to hear from
# it again, in tenths of a second: a hundred, or READS_WATCH_WAIT's for the
# cases, read as a decimal number whatever zeros it opens with.
watch_wait() {
  local wait=${READS_WATCH_WAIT:-100}
  case "$wait" in '' | *[!0-9]*) wait=100 ;; esac
  echo "$((10#$wait))"
}

# watch_start: the watch, begun under a name of its own (in watch.asked) and
# heard from, by that name, before mark returns, so the step after it is
# watched. It never fails the mark. A watch not heard from in ten seconds may
# yet begin, with steps already run unwatched: its name is taken from it, so
# it ends itself when it looks, and with no watch.heard the list says none
# began (watch=none), its rows the access times'.
watch_start() {
  local pid id said wait
  # none WHY: no watch began. Said here, and kept for the list to say again, where the lists' reader looks.
  none() { echo "::warning title=reads.sh::no watch began ($1): the list will hold what access times show alone"; echo "$1" > "$state/watch.why" 2> /dev/null || true; }
  wait=$(watch_wait)
  id="$$.$RANDOM.$(date +%s)"
  if ! echo "$id" > "$state/watch.asked"; then none "its name could not be written"; return 0; fi
  if ! command -v python3 > /dev/null 2>&1; then none "no python3 here"; return 0; fi
  if ! { printf '.\0'; git -C "$top" ls-tree -r -d --name-only -z HEAD 2> /dev/null; } > "$state/watch.want"; then none "the tracked folders could not be named"; return 0; fi
  # Its output to a file and its input from nowhere: a step waits on whatever still holds its pipes. -I, so
  # python looks for no module in the folder it is started in: it would list the checkout's top, which is then
  # a row of every watched job's, and load a file of the checkout's named as a module is.
  nohup python3 -I -c "$WATCH" "$state" "$top" "$id" < /dev/null > "$state/watch.log" 2>&1 &
  pid=$!
  echo "$pid" > "$state/watch.pid"
  # A watch that ended (no inotify) is not waited for. Only its own watch's word counts: watch.ready ends with
  # the name of the watch that wrote it, and an earlier marker's watch, late to begin, may write one before it
  # ends itself.
  for _ in $(seq 1 "$wait"); do
    said=$(cat "$state/watch.ready" 2> /dev/null || true)
    if [ "${said#* }" = "$id" ] || ! running "$pid"; then break; fi
    sleep 0.1
  done
  said=$(cat "$state/watch.ready" 2> /dev/null || true)
  if [ "${said#* }" = "$id" ]; then
    # Unkept, its word is no word: the list would say none began, of a watch mark called watching and left running.
    if ! : > "$state/watch.heard" 2> /dev/null; then echo "$id unheard" > "$state/watch.asked" 2> /dev/null || true; none "its word that it began could not be kept"; return 0; fi
    echo "reads.sh: watching ${said%% *} folders for opens"
    # Begun, and already short of a folder: its list will say lost. Said now, where the step that caused it is.
    if [ -s "$state/watch.short" ]; then echo "::warning title=reads.sh::the watch began short, and its list will say lost ($(tail -n 1 "$state/watch.short"))"; fi
  else
    echo "$id unheard" > "$state/watch.asked"
    none "$(tail -n 1 "$state/watch.log" 2> /dev/null | grep . || echo "not heard from in $((wait / 10)).$((wait % 10)) s")"
  fi
}

# watch_stop: ends the watch and says how it stood, in one line: ok, with
# what it saw in watch.files, watch.dirs and watch.under, when its status is
# ok under its own name; "lost: " and why, when it was heard from and then
# ended early, lost events, could not watch a folder, could not read all that
# was queued or is not heard from again in ten seconds; none, when it was not
# heard from as mark made it, with why; lost too for a second list of one
# watch, which the first ended.
watch_stop() {
  local pid said wait
  wait=$(watch_wait)
  if [ ! -f "$state/watch.heard" ]; then echo "none: $(grep . "$state/watch.why" 2> /dev/null || echo 'the mark step says why')"; return 0; fi
  # A list has ended this watch already: what was opened since, it never saw, and its ok is not this list's.
  if [ -e "$state/watch.listed" ]; then echo "lost: an earlier list ended the watch, so nothing opened since is seen"; return 0; fi
  : > "$state/watch.stop"
  pid=$(cat "$state/watch.pid" 2> /dev/null || true)
  for _ in $(seq 1 "$wait"); do
    [ ! -e "$state/watch.status" ] || break
    # Gone with no status written, the watch is lost now and not in ten seconds. Were the number another's by
    # now, the wait would only be the full ten.
    if [ -n "$pid" ] && ! running "$pid"; then break; fi
    sleep 0.1
  done
  said=$(cat "$state/watch.status" 2> /dev/null || true)
  if [ "$said" = "ok $(cat "$state/watch.asked" 2> /dev/null || true)" ]; then echo ok; return 0; fi
  case "$said" in
    lost:*) echo "$said" ;;
    '')
      if [ -n "$pid" ] && running "$pid"; then echo "lost: not heard from again in $((wait / 10)).$((wait % 10)) s"
      else echo "lost: it ended with no status: $(tail -n 1 "$state/watch.log" 2> /dev/null | grep . || echo 'it said nothing')"; fi
      ;;
    *) echo "lost: its status is another watch's" ;;
  esac
}

mark() {
  local watch=${1:-}
  if [ "$#" -gt 1 ] || { [ -n "$watch" ] && [ "$watch" != --watch ]; }; then echo "usage: reads.sh mark [--watch]" >&2; return 2; fi
  mkdir -p "$state" || return 1
  # Not empty: a read of no bytes moves no access time on some filesystems (APFS).
  echo sight > "$state/sight" || return 1
  # The marker of a job that watches says so itself, by not being empty: the list learns a watch was asked for
  # from the one file there must be, and says watch=none or lost when the watch's own files could not be made.
  if [ -n "$watch" ]; then echo watch > "$state/marker" || return 1; else : > "$state/marker" || return 1; fi
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
# It fails only when a batch could not be read at all. find's exit 1 is a
# path no longer there, which is no failure, so the batch ends 0 for it: BSD
# xargs says 1 for any batch that does not, where GNU's says 123 and 124
# apart. A find that died (above 125) ends its batch 255, and so the run:
# a list made without those paths would be short and look whole.
later_than_marker() {
  local rc=0
  # shellcheck disable=SC2016 # sh expands "$@", "$0" and "$p", not this shell
  (cd "$top" && xargs -0 -n 200 sh -c '[ "$#" -gt 0 ] || exit 0; m=$0; for p do set -- "$@" "./$p"; shift; done; find "$@" -maxdepth 0 -neweram "$m" -print0 2> /dev/null; [ "$?" -le 125 ] || exit 255; exit 0' "$state/marker") || rc=$?
  [ "$rc" = 0 ]
}
# changed_since_marker: as later_than_marker, by the time a file last changed
# in itself (its name, links, mode, owner or bytes) and not by when it was
# read. For a watched list: a file given a second name elsewhere (ln, cp -al)
# or moved out and back can be read through a read-only mount under a name in
# no watched folder, where neither its access time nor the watch shows it;
# the link or the move does show, here. It also holds a file a step only
# chmods or chowns.
changed_since_marker() {
  local rc=0
  # shellcheck disable=SC2016 # as above
  (cd "$top" && xargs -0 -n 200 sh -c '[ "$#" -gt 0 ] || exit 0; m=$0; for p do set -- "$@" "./$p"; shift; done; find "$@" -maxdepth 0 -newercm "$m" -print0 2> /dev/null; [ "$?" -le 125 ] || exit 255; exit 0' "$state/marker") || rc=$?
  [ "$rc" = 0 ]
}
# gone_now: of the NUL-separated paths on stdin, those no longer in the checkout, NUL-separated.
gone_now() {
  local rc=0
  # shellcheck disable=SC2016 # as above
  (cd "$top" && xargs -0 sh -c 'for p do [ -e "./$p" ] || [ -L "./$p" ] || printf "%s\0" "$p"; done; exit 0' sh) || rc=$?
  [ "$rc" = 0 ]
}

# list JOB [CELL]: the job's reads, to $RUNNER_TEMP/reads/JOB[.CELL].txt: a
# header line, then the rows above, sorted. It exits 0 whatever it finds, so
# a job is not failed for its list; 2 only as the whole script does outside
# a checkout, or with no job named, which check 55 holds each step from. A
# character in JOB or CELL that is not a letter, a digit, -, _ or . is
# written _, so a matrix value cannot leave the file's name or its header.
list() {
  local job=${1:-} cell=${2:-} dir out sight=ok files=0 dirs=0 odd=0 gone=0 tmp own='' more='' watch='' why='' alone=0 changed=0 heard=0 unheard=0 bad='' f
  if [ -z "$job" ]; then echo "usage: reads.sh list JOB [CELL]" >&2; return 2; fi
  job=${job//[^A-Za-z0-9_.-]/_} cell=${cell//[^A-Za-z0-9_.-]/_}
  dir=${RUNNER_TEMP:-${TMPDIR:-/tmp}}/reads
  out="$dir/$job${cell:+.$cell}.txt"
  # This file, when the checkout tracks it: a row by rule and not by its time, and what a watch must have heard.
  case "$SELF" in "$top"/*) own=${SELF#"$top"/} ;; esac
  if [ -n "$own" ] && ! git -C "$top" ls-files --error-unmatch -- "$own" > /dev/null 2>&1; then own=''; fi
  # The watch ends first, before anything here can fail: what this step opens is none of the job's, and a list
  # that cannot be written leaves no watch running. Asked for by the marker, which a watching job's mark wrote
  # into (or, the marker gone, by the watch's name still there). A watch asked for that says nothing of itself
  # is lost, not left out of the header as if none were.
  if [ -s "$state/marker" ] || [ -e "$state/watch.asked" ]; then
    watch=$(watch_stop)
    why=${watch#*: } watch=${watch%%:*}
    case "$watch" in ok | none | lost) ;; *) watch=lost why='it could not be asked how it stood' ;; esac
    : > "$state/watch.listed"
    # The watch's own sign that it hears. The bash that runs this step opened this file, in a tracked folder,
    # before the watch was told to stop. A watch that was told of no opening of this file since the marker shows
    # nothing for its ok, which would stand over every read it missed: so it is lost. With no exception: a job
    # that made this file's folder again would lose its watch for it, and none does; and a watch whose list is
    # made by a script the checkout does not track has no such sign to show at all.
    if [ "$watch" = ok ]; then
      if [ -z "$own" ]; then watch=lost why="this file is no tracked file of the checkout, so nothing shows the watch hears"
      elif ! grep -zqxF -- "$own" "$state/watch.files" 2> /dev/null; then watch=lost why="it was told of no opening of this file, so nothing shows it hears"; fi
    fi
  fi
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
  # rows KIND FILE: the NUL-separated paths on stdin, each with or without a
  # leading ./, as KIND's rows on FILE; one with a tab or a newline in it goes
  # to $tmp.o, NUL-ended, and into no row. Two witnesses can name one path, so
  # rows and odd paths are counted once sorted, each once. It fails when a row
  # could not be written, and under pipefail so does the pipeline it ends when
  # git could not name the paths: a list short of rows it should hold is the
  # one list worse than none, so either makes the list a broken one, empty.
  rows() {
    local p rc=0
    while IFS= read -r -d '' p; do
      p=${p#./}
      case "$1:$p" in
        *$'\n'* | *$'\t'*) printf '%s\0' "$p" >> "$tmp.o" || rc=1 ;;
        d:*) printf 'd\t%s/\n' "$p" || rc=1 ;;
        *) printf '%s\t%s\n' "$1" "$p" || rc=1 ;;
      esac
    done >> "$2" || rc=1
    return "$rc"
  }
  : > "$tmp.a"; : > "$tmp.w"; : > "$tmp.c"; : > "$tmp.o"
  if [ "$sight" = ok ]; then
    # By access time. This file first: the mark step's bash read it before the marker, so by rule and not by its time.
    if [ -n "$own" ]; then printf '%s\0' "$own" | rows f "$tmp.a" || bad=${bad:-this file\'s own row}; fi
    git -C "$top" ls-files -z | later_than_marker | rows f "$tmp.a" || bad=${bad:-the files read}
    { printf '.\0'; git -C "$top" ls-tree -r -d --name-only -z HEAD 2> /dev/null; } | later_than_marker | rows d "$tmp.a" || bad=${bad:-the folders listed}
    git -C "$top" ls-files -z | gone_now | rows g "$tmp.a" || bad=${bad:-the files gone}
    # By the watch: of the names it saw opened, those git tracks, each asked after as the one path it is; every
    # tracked file under a folder that was another by the watch's end, which ls-files names for the folder; and
    # the tracked folders it saw opened, with those that were another. With no names xargs is not run: ls-files,
    # given none, would name every file.
    if [ "$watch" = ok ]; then
      for f in "$state/watch.files" "$state/watch.under"; do
        if [ -s "$f" ]; then (cd "$top" && xargs -0 git --literal-pathspecs ls-files -z -- < "$f") | rows f "$tmp.w" || bad=${bad:-the files the watch saw}; fi
      done
      cat "$state/watch.dirs" "$state/watch.under" | rows d "$tmp.w" || bad=${bad:-the folders the watch saw}
      # And each tracked file changed in itself since the marker: see changed_since_marker.
      git -C "$top" ls-files -z | changed_since_marker | rows f "$tmp.c" || bad=${bad:-the files changed since the marker}
    fi
    # The marker gone while the list was made: every test against it failed as a path gone would.
    [ -e "$state/marker" ] || bad=${bad:-the marker, gone meanwhile}
  fi
  LC_ALL=C sort -u "$tmp.a" "$tmp.w" "$tmp.c" > "$tmp.s" || bad=${bad:-the sort of the rows}
  odd=$(LC_ALL=C sort -zu "$tmp.o" | tr -cd '\0' | wc -c | tr -d ' ') || bad=${bad:-the count of paths left out}
  if [ -n "$bad" ]; then sight=broken odd=0; : > "$tmp.s"; : > "$tmp.w"; : > "$tmp.c"; : > "$tmp.o"; fi
  files=$(grep -c "^f$(printf '\t')" "$tmp.s"); dirs=$(grep -c "^d$(printf '\t')" "$tmp.s"); gone=$(grep -c "^g$(printf '\t')" "$tmp.s")
  # What the watch alone gave: the rows no access time gave. And what a change to the file alone gave: the rows
  # neither of the two did. Said apart, so a list that grows by either shows which. The three counts are of rows
  # one witness alone gave; a row two gave, and a g row, is in none of them.
  alone=$(LC_ALL=C sort -u "$tmp.w" | LC_ALL=C comm -13 <(LC_ALL=C sort -u "$tmp.a") - | tee "$tmp.x" | wc -l | tr -d ' ')
  changed=$(LC_ALL=C sort -u "$tmp.c" | LC_ALL=C comm -13 <(LC_ALL=C sort -u "$tmp.a" "$tmp.w") - | tee "$tmp.y" | wc -l | tr -d ' ')
  # And the other way: the names the watch was told were opened, tracked or not; and the rows of files and
  # folders an access time gave and it was not told of. Those are no test of its hearing (the sign above is):
  # a file reached by a second name, moved into place, timed without being opened, or a link read, is one, with
  # the watch whole. A job that opens each file by its tracked name has none but its links.
  if [ "$watch" = ok ] && [ "$sight" = ok ]; then
    heard=$(cat "$state/watch.files" "$state/watch.dirs" 2> /dev/null | tr -cd '\0' | wc -c | tr -d ' ')
    unheard=$(grep -v "^g$(printf '\t')" "$tmp.a" | LC_ALL=C sort -u | LC_ALL=C comm -23 - <(LC_ALL=C sort -u "$tmp.w") | wc -l | tr -d ' ')
  fi
  if ! {
    printf '# reads v1 job=%s cell=%s commit=%s status=%s sight=%s files=%s dirs=%s gone=%s odd=%s%s\n' \
      "$job" "${cell:--}" "$(git -C "$top" rev-parse -q --verify HEAD 2> /dev/null || echo -)" "${JOB_STATUS:--}" "$sight" "$files" "$dirs" "$gone" "$odd" "${watch:+ watch=$watch}" \
      && cat "$tmp.s"
  } > "$tmp" || ! mv "$tmp" "$out"; then
    # No room for the header, or none to move it into place: there is no list, and what follows would speak of one.
    echo "::warning title=reads.sh::$job${cell:+ ($cell)}'s list could not be written under $dir, so there is none"
    rm -f "$tmp" "$tmp.a" "$tmp.w" "$tmp.c" "$tmp.o" "$tmp.s" "$tmp.x" "$tmp.y"
    return 0
  fi
  case "$sight" in
    blind) echo "::warning title=reads.sh::this filesystem recorded no access time for a file just read, so $job${cell:+ ($cell)}'s list is empty" ;;
    unmarked) echo "::warning title=reads.sh::no marker was made after the checkout, so $job${cell:+ ($cell)}'s list is empty" ;;
    broken) echo "::warning title=reads.sh::a command that names the paths or writes the rows failed ($bad), so $job${cell:+ ($cell)}'s list is empty, not short" ;;
  esac
  case "$watch" in
    lost) echo "::warning title=reads.sh::the watch was lost ($why), so $job${cell:+ ($cell)}'s list holds what access times show alone" ;;
    none) echo "::warning title=reads.sh::no watch began ($why), so $job${cell:+ ($cell)}'s list holds what access times show alone" ;;
  esac
  if [ "$gone" -gt 0 ]; then more=", $gone gone by the end"; fi
  if [ "$odd" -gt 0 ]; then more="$more, $odd path(s) with a tab or a newline left out"; fi
  if [ -n "$watch" ]; then more="$more, watch $watch"; fi
  if [ "$watch" = ok ] && [ "$sight" = ok ]; then more="$more: it heard $heard name(s) opened; $unheard row(s) by access times alone, $alone row(s) by the watch alone, $changed by a change to the file alone"; fi
  echo "reads.sh: $job${cell:+ ($cell)} opened $files of $(git -C "$top" ls-files | wc -l | tr -d ' ') tracked files and listed $dirs folders (sight $sight$more), digest $(sed 1d "$out" | git hash-object --stdin | cut -c1-12)"
  # Where they are, by top-level folder, most first: a list that grows shows where.
  grep '^f' "$out" | cut -f2- | awk -F/ '{ n[(NF > 1) ? $1 : "(top)"]++ } END { for (d in n) printf "  %5d %s\n", n[d], d }' | LC_ALL=C sort -k1,1nr -k2
  # The rows the watch alone gave, the first forty: what a list by access times would have lacked.
  if [ "$alone" -gt 0 ]; then echo "  by the watch alone:"; head -n 40 "$tmp.x" | sed 's/^/    /'; if [ "$alone" -gt 40 ]; then echo "    … and $((alone - 40)) more"; fi; fi
  if [ "$changed" -gt 0 ]; then echo "  by a change to the file alone (its name, links, mode, owner or bytes):"; head -n 40 "$tmp.y" | sed 's/^/    /'; if [ "$changed" -gt 40 ]; then echo "    … and $((changed - 40)) more"; fi; fi
  # Rows the watch alone gave are not all opens it heard: every tracked file under a folder that was another
  # by the end is one, opened or not. Named, so nobody looks for a container that read them.
  if [ "$watch" = ok ] && [ "$sight" = ok ] && [ -s "$state/watch.under" ]; then echo "  folders that were another by the end, every tracked file under them taken as opened: $(tr '\0' ' ' < "$state/watch.under")"; fi
  # Either kind of row is news in a job that binds no path its steps do not also read: said where a run's page shows it.
  if [ "$alone" -gt 0 ] || [ "$changed" -gt 0 ]; then echo "::notice title=reads.sh::$job${cell:+ ($cell)}: $alone row(s) by the watch alone and $changed by a change to the file alone; this step's log names them"; fi
  rm -f "$tmp" "$tmp.a" "$tmp.w" "$tmp.c" "$tmp.o" "$tmp.s" "$tmp.x" "$tmp.y"
  return 0
}

self_check() {
  local dir fails=0 out v w under=${GIT_DIR:+yes} watched='' as
  # The caller's, which a list would write in its header where the cases expect none.
  unset JOB_STATUS
  # git exports GIT_DIR and its like to whatever it runs, a hook above all, and under them every git command
  # below would act on the caller's repository, not the scratch one: `commit` on its branch, `add -A` on its index.
  for v in $(git rev-parse --local-env-vars); do unset "$v"; done
  # On the checkout's own filesystem, whose access times the jobs' lists rest on: /tmp can be another mount.
  dir=$(mktemp -d "$gitdir/ob1-reads-check.XXXXXX") || { echo "reads.sh: no scratch directory in $gitdir" >&2; return 1; }
  # Gone however this ends, an interrupt included: it holds two repositories, inside the caller's git directory.
  # A watch a case holds stopped is let go first: stopped, it would never see its files gone, and would stay.
  # shellcheck disable=SC2064 # $dir as it is now: it is local, and unset by the time the script exits
  trap "kill -CONT \"\$(cat $(printf '%q' "$dir/work/.git/ob1-reads/watch.pid") 2> /dev/null)\" 2> /dev/null; rm -rf $(printf '%q' "$dir")" EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  # The scratch commits under no setting of the caller's that could stop one: a signature asked of every commit, a hook.
  g() { git -c user.email=ci@example.invalid -c user.name=ci -c init.defaultBranch=main -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }
  # gone_soon PID: waits, three seconds at the most, for a process to end.
  gone_soon() { for _ in $(seq 1 30); do running "$1" || return 0; sleep 0.1; done; return 0; }
  # has LINE / hasnt LINE: the list holds the line, whole; or does not.
  has() { grep -qxF -- "$1" "$out" || { echo "reads.sh: the list lacks '$1' (${2:-})" >&2; fails=$((fails + 1)); }; }
  hasnt() { ! grep -qxF -- "$1" "$out" || { echo "reads.sh: the list holds '$1' (${2:-})" >&2; fails=$((fails + 1)); }; }
  # wrong WHAT: a case that did not hold, said and counted.
  wrong() { echo "reads.sh: $1" >&2; fails=$((fails + 1)); }
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
  fresh() { { rm -rf "$dir/work" && (cd "$dir" && g clone -q repo work) > /dev/null 2>&1; } || { echo "reads.sh: could not make the cases' fresh clone" >&2; fails=$((fails + 1)); }; }
  out="$dir/reads/job.cell.txt"
  # With no marker: an empty list that says so, and exit 0.
  (cd "$dir/work" && RUNNER_TEMP="$dir" bash tool/reads.sh list job cell) > /dev/null 2>&1 || { echo "reads.sh: list with no marker did not exit 0" >&2; fails=$((fails + 1)); }
  grep -q '^# reads v1 job=job cell=cell commit=[0-9a-f]\{40\} status=- sight=unmarked files=0 dirs=0 gone=0 odd=0$' "$out" 2> /dev/null || { echo "reads.sh: with no marker the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
  # In a fresh clone, since that list read tool/reads.sh. Marked, then: files read (one named as an option
  # would be, one with a tab in its name), folders listed (one inside another, and the top), a file only made
  # executable, a file deleted unread and one read then deleted.
  fresh
  (cd "$dir/work" && bash tool/reads.sh mark > /dev/null && cat read/a.txt top.txt deep/er/d.txt ./-dash.txt gone/r.txt "$(printf 'odd\tname.txt')" > /dev/null && ls walked deep/er . > /dev/null \
    && chmod +x walked/c.txt && rm left/b.txt gone/r.txt && JOB_STATUS=success RUNNER_TEMP="$dir" bash tool/reads.sh list job cell > "$dir/said" 2>&1) || { echo "reads.sh: mark, reads and list did not all exit 0" >&2; fails=$((fails + 1)); }
  [ ! -e "$dir/work/.git/ob1-reads/watch.pid" ] || wrong "P12: a marker without --watch began a watch"
  if grep -q 'sight=blind' "$out" 2> /dev/null; then
    # No access times here (a noatime mount): the cases below cannot hold. On a runner that is the news.
    if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "reads.sh: the checkout's filesystem records no access times, so every job's list would be empty" >&2; fails=$((fails + 1))
    else echo "reads.sh: this filesystem records no access times; the cases that need them are not run here"; fi
    grep -q '^::warning title=reads.sh::' "$dir/said" || { echo "reads.sh: a blind list gave no warning" >&2; fails=$((fails + 1)); }
  else
    grep -q '^# reads v1 job=job cell=cell commit=[0-9a-f]\{40\} status=success sight=ok files=5 dirs=3 gone=2 odd=1$' "$out" || { echo "reads.sh: after the reads the header is '$(head -1 "$out")'" >&2; fails=$((fails + 1)); }
    has "$(printf 'f\tread/a.txt')" "a file read"
    has "$(printf 'f\ttop.txt')" "a file read at the top"
    has "$(printf 'f\tdeep/er/d.txt')" "a file read two folders down"
    has "$(printf 'f\t-dash.txt')" "a file read whose name opens with a dash"
    has "$(printf 'f\ttool/reads.sh')" "this file's copy, read before its own marker"
    has "$(printf 'd\twalked/')" "a folder listed"
    has "$(printf 'd\tdeep/er/')" "Pe: a folder inside a folder listed"
    has "$(printf 'd\t./')" "Pe: the top listed"
    has "$(printf 'g\tleft/b.txt')" "a file deleted unread"
    has "$(printf 'g\tgone/r.txt')" "a file read, then deleted"
    hasnt "$(printf 'f\tleft/b.txt')" "a file deleted unread"
    hasnt "$(printf 'f\twalked/c.txt')" "a file in a folder listed, itself unread"
    hasnt "$(printf 'd\tread/')" "a folder whose file was read by name"
    hasnt "$(printf 'd\tdeep/')" "a folder passed through"
    if grep -q 'odd' <(sed 1d "$out"); then echo "reads.sh: a path with a tab in its name is in the list" >&2; fails=$((fails + 1)); fi
    [ "$(sed 1d "$out")" = "$(sed 1d "$out" | LC_ALL=C sort)" ] || { echo "reads.sh: the list is not sorted" >&2; fails=$((fails + 1)); }
    [ "$(sed 1d "$out" | LC_ALL=C sort -u | wc -l)" = "$(sed 1d "$out" | wc -l)" ] || { echo "reads.sh: the list holds a row twice" >&2; fails=$((fails + 1)); }
    grep -q '^reads.sh: job (cell) opened 5 of 9 tracked files and listed 3 folders (sight ok, 2 gone by the end, 1 path(s) with a tab or a newline left out)' "$dir/said" || { echo "reads.sh: the list said '$(head -1 "$dir/said")'" >&2; fails=$((fails + 1)); }
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
  # The cases of a real watch, once: not again in the second run of these cases, under an exported GIT_DIR,
  # which is there for what git's environment could reach and would only double the time they take. The cases
  # further down whose watch is a stand-in, or never begins, run both times.
  if [ -z "$under" ]; then
    # The watch (mark --watch). A file read and a folder listed before the marker, then again after it: no access
    # time moves for the second, and the watch has both. An untracked file opened in a tracked folder is no row,
    # one named `:!top.txt` among them: asked after as a pattern, that name would take top.txt out of git's answer.
    # The first read is a tick after the clone wrote the file: in the same tick it would leave the time where the
    # write put it, and the second read would move it.
    fresh
    out="$dir/reads/job.watched.txt"
    (cd "$dir/work" && sleep 0.05 && cat top.txt deep/er/d.txt > /dev/null && ls walked > /dev/null && sleep 0.05 && bash tool/reads.sh mark --watch > "$dir/said" 2>&1 && cat top.txt read/a.txt deep/er/d.txt "$(printf 'odd\tname.txt')" > /dev/null && ls walked > /dev/null \
      && echo u > read/untracked.txt && cat read/untracked.txt > /dev/null && mkdir read/made && ls read/made > /dev/null && echo x > ':!top.txt' && cat ':!top.txt' > /dev/null \
      && JOB_STATUS=success RUNNER_TEMP="$dir" bash tool/reads.sh list job watched >> "$dir/said" 2>&1) \
      || { echo "reads.sh: mark --watch, reads and list did not all exit 0" >&2; fails=$((fails + 1)); }
    case "$(head -1 "$out" 2> /dev/null)" in
      *' sight=ok '*' watch=ok')
        watched=yes
        has "$(printf 'f\ttop.txt')" "a file read a second time, under the watch"
        has "$(printf 'f\tread/a.txt')" "a file read, under the watch"
        has "$(printf 'f\tdeep/er/d.txt')" "Pa: a file two folders down read a second time, under the watch"
        grep -q ' odd=1 watch=ok$' "$out" || wrong "Pa: a path with a tab in its name that both witnesses gave is not counted once: $(head -1 "$out")"
        if grep -q '^::warning' "$dir/said"; then wrong "Pa: a watch that began whole and stood ok warned: $(grep -m 1 '^::warning' "$dir/said")"; fi
        grep -q ', watch ok: it heard [1-9][0-9]* name(s) opened; ' "$dir/said" || wrong "Pa: the list's line did not say the watch stood ok and had heard names: $(grep -m 1 '^reads.sh: job' "$dir/said")"
        if grep -v -E '^(::warning|::notice|reads\.sh: |  )' "$dir/said" | grep . > /dev/null; then wrong "P25: mark --watch and its list said more than their lines: $(grep -v -E '^(::warning|::notice|reads\.sh: |  )' "$dir/said" | head -1)"; fi
        grep -q '^reads.sh: watching 8 folders for opens$' "$dir/said" || wrong "Pa: the mark did not say it watched the top and the seven tracked folders: $(head -1 "$dir/said")"
        has "$(printf 'f\ttool/reads.sh')" "this file's copy, under the watch"
        has "$(printf 'd\twalked/')" "a folder listed a second time, under the watch"
        hasnt "$(printf 'f\tread/untracked.txt')" "an untracked file opened"
        hasnt "$(printf 'd\tread/made/')" "an untracked folder listed"
        hasnt "$(printf 'f\twalked/c.txt')" "a file in a folder listed, itself unopened, under the watch"
        hasnt "$(printf 'f\tleft/b.txt')" "a file never opened, under the watch"
        hasnt "$(printf 'd\t./')" "the top, which only the watch's own start could have listed"
        # The watch heard, and said so: no row of a file or folder came by an access time that it had not heard opened.
        grep -q ' name(s) opened; 0 row(s) by access times alone, ' "$dir/said" || { echo "reads.sh: a list under the watch did not say the watch had heard every row an access time gave: $(grep -m 1 '^reads.sh: job' "$dir/said")" >&2; fails=$((fails + 1)); }
        grep -q '^::notice title=reads.sh::job (watched): ' "$dir/said" || { echo "reads.sh: rows by the watch alone were not said where a run's page shows them" >&2; fails=$((fails + 1)); }
        # A second list of one watch is lost: the first ended it, and what was opened since no watch saw.
        (cd "$dir/work" && cat left/b.txt > /dev/null && RUNNER_TEMP="$dir" bash tool/reads.sh list job again > "$dir/said2" 2>&1) || { echo "reads.sh: a second list did not exit 0" >&2; fails=$((fails + 1)); }
        grep -q ' odd=1 watch=lost$' "$dir/reads/job.again.txt" 2> /dev/null || { echo "reads.sh: a second list's header is '$(head -1 "$dir/reads/job.again.txt" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
        grep -q '^::warning title=reads.sh::the watch was lost (an earlier list ended the watch' "$dir/said2" || { echo "reads.sh: a second list did not say the first had ended the watch" >&2; fails=$((fails + 1)); }
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
  fi
  if [ -n "$watched" ]; then
    # Through a read-only bind mount in a mount namespace of its own, as a container is handed a path: the file's
    # time cannot move, and the watch has it. A folder mounted, and a file mounted alone, which is opened by no
    # name in its folder and is the watch's all the same. Where mounting is allowed: as root, or by sudo with no
    # password, a runner's.
    as=()
    if [ "$(id -u)" != 0 ]; then as=(sudo -n); fi
    fresh
    mkdir -p "$dir/mnt" && : > "$dir/mnt.file"
    out="$dir/reads/job.mounted.txt"
    # shellcheck disable=SC2016 # sh expands "$1" to "$4", not this shell
    if (cd "$dir/work" && bash tool/reads.sh mark --watch > /dev/null 2>&1 \
        && ${as[@]+"${as[@]}"} unshare -m --propagation private sh -c 'mount --bind "$1" "$2" && mount -o remount,bind,ro "$2" && cat "$2/c.txt" > /dev/null \
          && mount --bind "$3" "$4" && mount -o remount,bind,ro "$4" && cat "$4" > /dev/null' sh "$dir/work/walked" "$dir/mnt" "$dir/work/deep/er/d.txt" "$dir/mnt.file") > /dev/null 2> "$dir/mount.err"; then
      (cd "$dir/work" && RUNNER_TEMP="$dir" bash tool/reads.sh list job mounted > "$dir/said" 2>&1) || { echo "reads.sh: the list after a read through a mount did not exit 0" >&2; fails=$((fails + 1)); }
      has "$(printf 'f\twalked/c.txt')" "a file read through a read-only bind mount"
      grep -qxF -- "$(printf '    f\twalked/c.txt')" "$dir/said" || { echo "reads.sh: a file read through a read-only bind mount is not among the rows the watch alone gave: its access time moved, so the mount was not read-only" >&2; fails=$((fails + 1)); }
      has "$(printf 'f\tdeep/er/d.txt')" "a file mounted alone, read-only, and read"
      grep -qxF -- "$(printf '    f\tdeep/er/d.txt')" "$dir/said" || wrong "a file mounted alone, read-only, and read is not among the rows the watch alone gave"
    elif [ -n "${GITHUB_ACTIONS:-}" ]; then echo "reads.sh: could not read a file through a read-only bind mount on this runner, the case the watch is for: $(tail -n 1 "$dir/mount.err" 2> /dev/null | grep . || echo 'no word of why')" >&2; fails=$((fails + 1))
    else
      (cd "$dir/work" && RUNNER_TEMP="$dir" bash tool/reads.sh list job mounted) > /dev/null 2>&1
      echo "reads.sh: no mount can be made here (not root and no sudo without a password, or no unshare); the case for a read through a read-only bind mount is not run"
    fi
    # A watch that ended early is lost: the list says so, holds what the access times give, warns and exits 0.
    fresh
    out="$dir/reads/job.lost.txt"
    (cd "$dir/work" && bash tool/reads.sh mark --watch > /dev/null 2>&1 && cat top.txt > /dev/null && kill -KILL "$(cat .git/ob1-reads/watch.pid)" \
      && RUNNER_TEMP="$dir" bash tool/reads.sh list job lost > "$dir/said" 2>&1) || { echo "reads.sh: a list whose watch was killed did not exit 0" >&2; fails=$((fails + 1)); }
    grep -q '^# reads v1 job=job cell=lost .* sight=ok .* odd=0 watch=lost$' "$out" 2> /dev/null || { echo "reads.sh: with its watch killed the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
    has "$(printf 'f\ttop.txt')" "a file read, its watch killed"
    grep -q '(sight ok, watch lost), digest ' "$dir/said" || wrong "Pc: the list's line did not say the watch was lost: $(grep -m 1 '^reads.sh: job' "$dir/said")"
    grep -q '^::warning title=reads.sh::the watch was lost (it ended with no status' "$dir/said" || { echo "reads.sh: a list whose watch was killed did not say so: $(grep -m 1 'title=reads.sh' "$dir/said")" >&2; fails=$((fails + 1)); }
    if grep -v -E '^(::warning|::notice|reads\.sh: |  )' "$dir/said" | grep . > /dev/null; then echo "reads.sh: a list whose watch was killed said more than its lines: $(grep -v -E '^(::warning|::notice|reads\.sh: |  )' "$dir/said" | head -1)" >&2; fails=$((fails + 1)); fi
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
    case "$v" in '' | *[!0-9]*) v=0 ;; esac
    if [ "$v" -gt 0 ] && [ "$v" -le 600000 ]; then
      fresh
      out="$dir/reads/job.dropped.txt"
      (cd "$dir/work" && bash tool/reads.sh mark --watch > /dev/null 2>&1 && kill -STOP "$(cat .git/ob1-reads/watch.pid)" \
        && for _ in $(seq 1 $((v / 2 + 1000))); do : < top.txt; : < read/a.txt; done && kill -CONT "$(cat .git/ob1-reads/watch.pid)" \
        && RUNNER_TEMP="$dir" bash tool/reads.sh list job dropped > "$dir/said" 2>&1) || { echo "reads.sh: a list whose watch dropped events did not exit 0" >&2; fails=$((fails + 1)); }
      grep -q '^# reads v1 job=job cell=dropped .* odd=0 watch=lost$' "$out" 2> /dev/null || { echo "reads.sh: with more opens than the kernel queues the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
      grep -q "^::warning title=reads.sh::the watch was lost (the kernel dropped events, its queue of $v full" "$dir/said" || wrong "P24: a watch that dropped events did not say how long the queue is: $(grep -m 1 'title=reads.sh' "$dir/said")"
      grep -q '^::warning title=reads.sh::the watch was lost (the kernel dropped events' "$dir/said" || { echo "reads.sh: a watch that dropped events did not say so: $(grep -m 1 'title=reads.sh' "$dir/said")" >&2; fails=$((fails + 1)); }
    else echo "reads.sh: the kernel's queue of opens is $v long here, or cannot be read; the case for a watch whose events it dropped is not run"; fi
    # What is still queued when the watch is told to stop is read to the end: held still, five thousand opens, more
    # than two reads of the queue take, then one of a file read before the marker, which only the watch can show.
    # The case tells the watch to stop itself, before its list begins: so it opens the list's script first, as the
    # list would.
    if [ "$v" -ge 6000 ]; then
      fresh
      out="$dir/reads/job.queued.txt"
      (cd "$dir/work" && sleep 0.05 && cat walked/c.txt > /dev/null && sleep 0.05 && bash tool/reads.sh mark --watch > /dev/null 2>&1 && kill -STOP "$(cat .git/ob1-reads/watch.pid)" \
        && for _ in $(seq 1 2500); do : < top.txt; : < read/a.txt; done && : < walked/c.txt && : < tool/reads.sh && : > .git/ob1-reads/watch.stop && kill -CONT "$(cat .git/ob1-reads/watch.pid)" \
        && RUNNER_TEMP="$dir" bash tool/reads.sh list job queued > /dev/null 2>&1) || { echo "reads.sh: a list whose watch had opens queued at its stop did not exit 0" >&2; fails=$((fails + 1)); }
      grep -q ' odd=0 watch=ok$' "$out" 2> /dev/null || { echo "reads.sh: with opens queued at the stop the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
      has "$(printf 'f\twalked/c.txt')" "the last open queued when the watch was told to stop"
    else echo "reads.sh: the kernel's queue of opens is $v long here, or cannot be read; the case for opens queued at the stop is not run"; fi
    # With a python3 that cannot watch, as off Linux: no watch begins, mark says so and exits 0, and the list says watch=none.
    fresh
    out="$dir/reads/job.none.txt"
    mkdir -p "$dir/stub" && printf '#!/bin/sh\necho "no inotify here" >&2\nexit 1\n' > "$dir/stub/python3" && chmod +x "$dir/stub/python3"
    (cd "$dir/work" && PATH="$dir/stub:$PATH" bash tool/reads.sh mark --watch > "$dir/said" 2>&1 && cat top.txt > /dev/null \
      && RUNNER_TEMP="$dir" bash tool/reads.sh list job none >> "$dir/said" 2>&1) || { echo "reads.sh: mark --watch and list with no watch to start did not exit 0" >&2; fails=$((fails + 1)); }
    grep -q '^# reads v1 job=job cell=none .* sight=ok .* odd=0 watch=none$' "$out" 2> /dev/null || { echo "reads.sh: with no watch to start the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
    has "$(printf 'f\ttop.txt')" "a file read, with no watch to start"
    [ "$(grep -c '^::warning title=reads.sh::no watch began (no inotify here)' "$dir/said")" = 2 ] || { echo "reads.sh: with no watch to start, mark and list did not each say why: $(grep -m 2 'title=reads.sh' "$dir/said" | tr '\n' '|')" >&2; fails=$((fails + 1)); }
    # A watch that begins after mark has stopped waiting for it is no watch: steps have run unwatched by then.
    # A python3 that starts only once mark has given it up, after a wait of half a second: mark says so, the
    # late watch ends itself, and the list says watch=none, though the watch did come up before it.
    fresh
    out="$dir/reads/job.tardy.txt"
    # shellcheck disable=SC2016 # the stub's sh expands "$4" and "$@", not this shell
    printf '#!/bin/sh\nn=0\nwhile ! grep unheard "$4/watch.asked" > /dev/null 2>&1; do n=$((n + 1)); [ "$n" -lt 100 ] || exit 1; sleep 0.1; done\nexec "%s" "$@"\n' "$(command -v python3)" > "$dir/stub/python3"
    (w=''; cd "$dir/work" && PATH="$dir/stub:$PATH" READS_WATCH_WAIT=5 bash tool/reads.sh mark --watch > "$dir/said" 2>&1 && w=$(cat .git/ob1-reads/watch.pid) \
      && cat top.txt > /dev/null && gone_soon "$w" && { ! running "$w" || { echo "reads.sh: a watch that began too late is still running" >&2; exit 1; }; } \
      && RUNNER_TEMP="$dir" bash tool/reads.sh list job tardy >> "$dir/said" 2>&1) || { echo "reads.sh: mark --watch with a watch late to start, and its list, did not hold" >&2; fails=$((fails + 1)); }
    grep -q '^# reads v1 job=job cell=tardy .* sight=ok .* odd=0 watch=none$' "$out" 2> /dev/null || { echo "reads.sh: with a watch late to start the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
    grep -q '^::warning title=reads.sh::no watch began (not heard from in 0.5 s)' "$dir/said" || { echo "reads.sh: mark did not say its watch was late: $(grep -m 1 'title=reads.sh' "$dir/said")" >&2; fails=$((fails + 1)); }
    # Word that a watch has begun, under another watch's name, as the watch of a marker before this one could
    # leave, late to begin, before it ends itself: not this watch's word, so none began.
    fresh
    out="$dir/reads/job.others.txt"
    # shellcheck disable=SC2016 # the stub's sh expands "$4", not this shell
    printf '#!/bin/sh\nprintf "5 another\\n" > "$4/watch.ready"\nsleep 2\n' > "$dir/stub/python3"
    (cd "$dir/work" && PATH="$dir/stub:$PATH" READS_WATCH_WAIT=08 bash tool/reads.sh mark --watch > "$dir/said" 2>&1 \
      && RUNNER_TEMP="$dir" bash tool/reads.sh list job others >> "$dir/said" 2>&1) || { echo "reads.sh: mark --watch beside another watch's word, and its list, did not exit 0" >&2; fails=$((fails + 1)); }
    grep -q ' odd=0 watch=none$' "$out" 2> /dev/null || { echo "reads.sh: with another watch's word that it had begun the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
    # The wait was written 08, a decimal number and no octal one: mark waited its eight tenths and said so.
    grep -q '^::warning title=reads.sh::no watch began (not heard from in 0.8 s)' "$dir/said" || { echo "reads.sh: a wait written 08 was not read as eight tenths of a second: $(head -1 "$dir/said")" >&2; fails=$((fails + 1)); }
    # A watch refused on a tracked folder (here one that is a link to itself; on a runner, the user's limit on
    # watches) is lost: what was opened in that folder it could not see.
    fresh
    out="$dir/reads/job.refused.txt"
    (cd "$dir/work" && rm -rf left && ln -s left left && bash tool/reads.sh mark --watch > "$dir/said" 2>&1 \
      && RUNNER_TEMP="$dir" bash tool/reads.sh list job refused >> "$dir/said" 2>&1) || { echo "reads.sh: a list whose watch was refused a folder did not exit 0" >&2; fails=$((fails + 1)); }
    grep -q ' odd=0 watch=lost$' "$out" 2> /dev/null || { echo "reads.sh: with a watch refused a folder the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
    grep -q '^::warning title=reads.sh::the watch began short, and its list will say lost (no watch on left: ' "$dir/said" || { echo "reads.sh: a watch refused a folder was not said at the mark: $(head -1 "$dir/said")" >&2; fails=$((fails + 1)); }
    grep -q '^::warning title=reads.sh::the watch was lost (no watch on left: ' "$dir/said" || { echo "reads.sh: a watch refused a folder did not say so: $(grep -m 1 'title=reads.sh' "$dir/said")" >&2; fails=$((fails + 1)); }
    grep -q '^reads.sh: watching 7 folders for opens$' "$dir/said" || wrong "Pd: a watch refused one folder of eight did not say it watches seven: $(head -1 "$dir/said")"
    if grep -q 'fs.inotify.max_user_watches' "$dir/said"; then wrong "Pd: a refusal that is not the limit on watches was given that limit's hint"; fi
    # A watch still there and saying nothing when its list asks is lost, and said to be unheard, not ended.
    fresh
    out="$dir/reads/job.silent.txt"
    (w=''; cd "$dir/work" && bash tool/reads.sh mark --watch > /dev/null 2>&1 && w=$(cat .git/ob1-reads/watch.pid) && kill -STOP "$w" \
      && READS_WATCH_WAIT=5 RUNNER_TEMP="$dir" bash tool/reads.sh list job silent > "$dir/said" 2>&1; rc=$?; { [ -z "$w" ] || { kill -CONT "$w" 2> /dev/null; gone_soon "$w"; }; }; exit "$rc") \
      || { echo "reads.sh: a list whose watch said nothing did not exit 0" >&2; fails=$((fails + 1)); }
    grep -q ' odd=0 watch=lost$' "$out" 2> /dev/null || { echo "reads.sh: with a watch that said nothing the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
    grep -q '^::warning title=reads.sh::the watch was lost (not heard from again in 0.5 s)' "$dir/said" || { echo "reads.sh: a watch that said nothing was not called unheard: $(grep -m 1 'title=reads.sh' "$dir/said")" >&2; fails=$((fails + 1)); }
    # A tracked folder that is another folder by the job's end, the first moved aside and so still watched, here for
    # one holding the same file by a second link, so with its old access time: the watch stayed with the first, and
    # every tracked file under it is taken as opened.
    fresh
    out="$dir/reads/job.swapped.txt"
    (cd "$dir/work" && bash tool/reads.sh mark --watch > /dev/null 2>&1 && mkdir swap && ln walked/c.txt swap/c.txt && mv walked aside && mv swap walked \
      && : < walked/c.txt && RUNNER_TEMP="$dir" bash tool/reads.sh list job swapped > "$dir/said" 2>&1) || { echo "reads.sh: a list after a folder was swapped for another did not exit 0" >&2; fails=$((fails + 1)); }
    grep -q ' odd=0 watch=ok$' "$out" 2> /dev/null || { echo "reads.sh: after a folder was swapped for another the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
    has "$(printf 'f\twalked/c.txt')" "a file opened in a folder swapped for another under the watch"
    has "$(printf 'd\twalked/')" "a folder swapped for another under the watch"
    tr '\0' '\n' < "$dir/work/.git/ob1-reads/watch.under" 2> /dev/null | grep -x walked > /dev/null || { echo "reads.sh: the watch did not say a folder swapped for another was another" >&2; fails=$((fails + 1)); }
    grep -q '^  folders that were another by the end, every tracked file under them taken as opened: walked ' "$dir/said" || { echo "reads.sh: the list did not name the folder that was another" >&2; fails=$((fails + 1)); }
    # And a tracked folder that was not there at the marker and is by the end: no watch was ever on it.
    fresh
    (cd "$dir/work" && rm -rf left && bash tool/reads.sh mark --watch > /dev/null 2>&1 && mkdir left && RUNNER_TEMP="$dir" bash tool/reads.sh list job absent > /dev/null 2>&1) \
      || { echo "reads.sh: a list after a folder not there at the marker was made did not exit 0" >&2; fails=$((fails + 1)); }
    tr '\0' '\n' < "$dir/work/.git/ob1-reads/watch.under" 2> /dev/null | grep -x left > /dev/null || { echo "reads.sh: the watch did not say a folder made after the marker was another" >&2; fails=$((fails + 1)); }
    # The same with the folder removed and then made again: ext4 gives the new one the old one's number, so it is
    # known as another by its watch having ended.
    fresh
    out="$dir/reads/job.remade.txt"
    (cd "$dir/work" && bash tool/reads.sh mark --watch > /dev/null 2>&1 && mkdir keep && mv walked/c.txt keep/c.txt && rmdir walked && mkdir walked && mv keep/c.txt walked/c.txt \
      && : < walked/c.txt && RUNNER_TEMP="$dir" bash tool/reads.sh list job remade > "$dir/said" 2>&1) || { echo "reads.sh: a list after a folder was removed and made again did not exit 0" >&2; fails=$((fails + 1)); }
    grep -q ' odd=0 watch=ok$' "$out" 2> /dev/null || { echo "reads.sh: after a folder was removed and made again the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
    has "$(printf 'f\twalked/c.txt')" "a file opened in a folder removed and made again under the watch"
    tr '\0' '\n' < "$dir/work/.git/ob1-reads/watch.under" 2> /dev/null | grep -x walked > /dev/null || { echo "reads.sh: the watch did not say a folder removed and made again was another" >&2; fails=$((fails + 1)); }
    # The watch's sign that it hears has no exception: with this script's own folder made again, the list's
    # opening of it was in a folder no watch was on, and the watch is lost though it heard all else.
    fresh
    out="$dir/reads/job.moved.txt"
    (cd "$dir/work" && bash tool/reads.sh mark --watch > /dev/null 2>&1 && mkdir tool2 && mv tool/reads.sh tool2/reads.sh && rmdir tool && mv tool2 tool \
      && RUNNER_TEMP="$dir" bash tool/reads.sh list job moved > /dev/null 2>&1) || { echo "reads.sh: a list after this script's folder was made again did not exit 0" >&2; fails=$((fails + 1)); }
    grep -q ' odd=0 watch=lost$' "$out" 2> /dev/null || { echo "reads.sh: with this script's folder made again the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
    has "$(printf 'f\ttool/reads.sh')" "this script, its folder made again under the watch"
    # And where it has no sign to give: a list made by a script the checkout does not track. Lost, and said why.
    fresh
    out="$dir/reads/job.outside.txt"
    cp "$dir/work/tool/reads.sh" "$dir/outside.sh"
    (cd "$dir/work" && bash "$dir/outside.sh" mark --watch > /dev/null 2>&1 && cat top.txt > /dev/null && RUNNER_TEMP="$dir" bash "$dir/outside.sh" list job outside > "$dir/said" 2>&1) \
      || { echo "reads.sh: a watched list made by a script outside the checkout did not exit 0" >&2; fails=$((fails + 1)); }
    grep -q ' odd=0 watch=lost$' "$out" 2> /dev/null || { echo "reads.sh: made by a script outside the checkout, a watched list's header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
    grep -q '^::warning title=reads.sh::the watch was lost (this file is no tracked file of the checkout' "$dir/said" || { echo "reads.sh: a watched list made by a script outside the checkout did not say why it was lost" >&2; fails=$((fails + 1)); }
    # The same for a copy of this script inside the checkout that git does not track: it is no row, and no sign.
    fresh
    out="$dir/reads/job.copied.txt"
    (cd "$dir/work" && cp tool/reads.sh tool/copy.sh && bash tool/copy.sh mark --watch > /dev/null 2>&1 && RUNNER_TEMP="$dir" bash tool/copy.sh list job copied > /dev/null 2>&1) \
      || { echo "reads.sh: a watched list made by an untracked copy of this script did not exit 0" >&2; fails=$((fails + 1)); }
    grep -q ' odd=0 watch=lost$' "$out" 2> /dev/null || { echo "reads.sh: made by an untracked copy of this script, a watched list's header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
    hasnt "$(printf 'f\ttool/copy.sh')" "an untracked copy of this script, run"
    # A tracked file given a second name in a folder no watch is on, and opened by that name: no access time
    # moves for an open, and the watch is not told of it under the tracked name. The second name's making shows.
    fresh
    out="$dir/reads/job.linked.txt"
    (cd "$dir/work" && bash tool/reads.sh mark --watch > /dev/null 2>&1 && mkdir build && ln walked/c.txt build/c.txt && : < build/c.txt && chmod +x read/a.txt && : < read/a.txt \
      && RUNNER_TEMP="$dir" bash tool/reads.sh list job linked > "$dir/said" 2>&1) || { echo "reads.sh: a list after a file was given a second name did not exit 0" >&2; fails=$((fails + 1)); }
    grep -q ' odd=0 watch=ok$' "$out" 2> /dev/null || { echo "reads.sh: after a file was given a second name the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
    has "$(printf 'f\twalked/c.txt')" "a file opened by a second name in a folder no watch is on"
    grep -q ' by the watch alone, 1 by a change to the file alone)' "$dir/said" || { echo "reads.sh: a file given a second name was not said to be a row by its own change alone: $(grep -m 1 '^reads.sh: ' "$dir/said")" >&2; fails=$((fails + 1)); }
    hasnt "$(printf 'f\tleft/b.txt')" "a file whose name, links and mode did not change"
    grep -qxF -- "$(printf '    f\twalked/c.txt')" "$dir/said" || wrong "Pb: the row a change to the file alone gave is not named in the step's log"
    if grep -qxF -- "$(printf '    f\tread/a.txt')" <(sed -n '/by a change to the file alone (/,$p' "$dir/said"); then wrong "Pb: a file the watch heard opened is named as a row by its change alone"; fi
    grep -q '^::notice title=reads.sh::job (linked): .* and 1 by a change to the file alone' "$dir/said" || wrong "Pb: a row by a change to the file alone gave no notice"
    # Opens that go on while the list is made do not lose the watch: it reads what was queued when it was told to
    # stop, and does not wait for a pause.
    fresh
    out="$dir/reads/job.busy.txt"
    (w=''; cd "$dir/work" && sleep 0.05 && cat walked/c.txt > /dev/null && sleep 0.05 && bash tool/reads.sh mark --watch > /dev/null 2>&1 && : < walked/c.txt \
      && { while :; do : < top.txt; : < read/a.txt; sleep 0.05; done & } && w=$! && RUNNER_TEMP="$dir" bash tool/reads.sh list job busy > "$dir/said" 2>&1; rc=$?; { [ -z "$w" ] || kill "$w" 2> /dev/null; }; exit "$rc") \
      || { echo "reads.sh: a list made while opens went on did not exit 0" >&2; fails=$((fails + 1)); }
    grep -q ' odd=0 watch=ok$' "$out" 2> /dev/null || { echo "reads.sh: with opens going on while the list was made the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
    has "$(printf 'f\twalked/c.txt')" "a file opened before a list made while opens went on"
    # P1: a folder that stands in for a watched one, made before the marker with a copy of its file. No access time
    # and no change time moves and no open is told to the watch: only the folder being another shows the read.
    fresh
    out="$dir/reads/job.standin.txt"
    (cd "$dir/work" && mkdir spare && cp walked/c.txt spare/c.txt && sleep 0.05 && bash tool/reads.sh mark --watch > /dev/null 2>&1 && mv walked aside && mv spare walked \
      && : < walked/c.txt && RUNNER_TEMP="$dir" bash tool/reads.sh list job standin > "$dir/said" 2>&1) || wrong "P1: a list after a stand-in folder took a watched one's place did not exit 0"
    grep -q ' odd=0 watch=ok$' "$out" 2> /dev/null || wrong "P1: with a stand-in folder the header is '$(head -1 "$out" 2> /dev/null)'"
    has "$(printf 'f\twalked/c.txt')" "P1: a file opened in a stand-in folder made before the marker"
    has "$(printf 'd\twalked/')" "P1: a stand-in folder made before the marker"
    # P2: a find that dies while asking which files changed in themselves breaks the list, as one that dies asking
    # after access times.
    fresh
    # shellcheck disable=SC2016
    mkdir -p "$dir/stub6" && printf '#!/bin/sh\ncase "$*" in *-newercm*) kill -KILL $$ ;; esac\nexec "%s" "$@"\n' "$(command -v find)" > "$dir/stub6/find" && chmod +x "$dir/stub6/find"
    (cd "$dir/work" && bash tool/reads.sh mark --watch > /dev/null 2>&1 && cat top.txt > /dev/null && PATH="$dir/stub6:$PATH" RUNNER_TEMP="$dir" bash tool/reads.sh list job changedied > /dev/null 2>&1) \
      || wrong "P2: a list made while the find for changed names died did not exit 0"
    grep -q ' sight=broken files=0 dirs=0 gone=0 odd=0 watch=ok$' "$dir/reads/job.changedied.txt" 2> /dev/null || wrong "P2: with a find that died asking what changed the header is '$(head -1 "$dir/reads/job.changedied.txt" 2> /dev/null)'"
    # P3: a git that cannot name the files the watch saw breaks the list.
    fresh
    # shellcheck disable=SC2016
    mkdir -p "$dir/stub7" && printf '#!/bin/sh\ncase " $* " in *" --literal-pathspecs "*) exit 1 ;; esac\nexec "%s" "$@"\n' "$(command -v git)" > "$dir/stub7/git" && chmod +x "$dir/stub7/git"
    (cd "$dir/work" && bash tool/reads.sh mark --watch > /dev/null 2>&1 && cat top.txt > /dev/null && PATH="$dir/stub7:$PATH" RUNNER_TEMP="$dir" bash tool/reads.sh list job watchdied > /dev/null 2>&1) \
      || wrong "P3: a list whose watch's files git could not name did not exit 0"
    grep -q ' sight=broken files=0 dirs=0 gone=0 odd=0 watch=ok$' "$dir/reads/job.watchdied.txt" 2> /dev/null || wrong "P3: with a git that could not name the watch's files the header is '$(head -1 "$dir/reads/job.watchdied.txt" 2> /dev/null)'"
    # P4: a file opened and still held open when the list is made: the watch has the open, and does not wait for a close.
    fresh
    out="$dir/reads/job.held.txt"
    (cd "$dir/work" && sleep 0.05 && cat walked/c.txt > /dev/null && sleep 0.05 && bash tool/reads.sh mark --watch > /dev/null 2>&1 && exec 9< walked/c.txt \
      && RUNNER_TEMP="$dir" bash tool/reads.sh list job held > /dev/null 2>&1) || wrong "P4: a list made while a file was held open did not exit 0"
    grep -q ' odd=0 watch=ok$' "$out" 2> /dev/null || wrong "P4: with a file held open the header is '$(head -1 "$out" 2> /dev/null)'"
    has "$(printf 'f\twalked/c.txt')" "P4: a file opened and still held open when the list is made"
    # P5: a tracked folder gone before the marker and still gone is no other folder, and its files are gone, not opened;
    # one whose parent was a file at the marker (ENOTDIR, not ENOENT) and is a folder by the end is another.
    fresh
    out="$dir/reads/job.stillgone.txt"
    (cd "$dir/work" && rm -rf gone deep && echo x > deep && bash tool/reads.sh mark --watch > /dev/null 2>&1 && rm deep && mkdir -p deep/er \
      && RUNNER_TEMP="$dir" bash tool/reads.sh list job stillgone > /dev/null 2>&1) || wrong "P5: a list after a folder stayed gone and another came where a file was did not exit 0"
    grep -q ' odd=0 watch=ok$' "$out" 2> /dev/null || wrong "P5: with a folder gone throughout and one that was under a file the header is '$(head -1 "$out" 2> /dev/null)'"
    hasnt "$(printf 'f\tgone/r.txt')" "P5: a file in a folder gone before the marker and ever since"
    has "$(printf 'g\tgone/r.txt')" "P5: a file in a folder gone before the marker and ever since"
    tr '\0' '\n' < "$dir/work/.git/ob1-reads/watch.under" 2> /dev/null | grep -x deep/er > /dev/null || wrong "P5: a folder whose parent was a file at the marker was not called another"
    if tr '\0' '\n' < "$dir/work/.git/ob1-reads/watch.under" 2> /dev/null | grep -x gone > /dev/null; then wrong "P5: a folder gone before the marker and ever since was called another"; fi
    # P6: a second watching marker after a list begins its own watch clear of the first's files.
    fresh
    out="$dir/reads/job.relisted.txt"
    (cd "$dir/work" && bash tool/reads.sh mark --watch > /dev/null 2>&1 && RUNNER_TEMP="$dir" bash tool/reads.sh list job first > /dev/null 2>&1 && bash tool/reads.sh mark --watch > /dev/null 2>&1 \
      && : < walked/c.txt && RUNNER_TEMP="$dir" bash tool/reads.sh list job relisted > /dev/null 2>&1) || wrong "P6: a watching marker, a list, and both again did not exit 0"
    grep -q ' odd=0 watch=ok$' "$out" 2> /dev/null || wrong "P6: after a second watching marker that followed a list the header is '$(head -1 "$out" 2> /dev/null)'"
    has "$(printf 'f\twalked/c.txt')" "P6: a file opened under a second watching marker that followed a list"
    # P7: a second list of a job whose watch never began still says none, not lost. Its python3 is still the stand-in
    # from the case of another watch's word, above: it begins no watch.
    fresh
    (cd "$dir/work" && PATH="$dir/stub:$PATH" READS_WATCH_WAIT=3 bash tool/reads.sh mark --watch > /dev/null 2>&1 && RUNNER_TEMP="$dir" bash tool/reads.sh list job none1 > /dev/null 2>&1 \
      && RUNNER_TEMP="$dir" bash tool/reads.sh list job none2 > /dev/null 2>&1) || wrong "P7: two lists of a job whose watch never began did not exit 0"
    grep -q ' odd=0 watch=none$' "$dir/reads/job.none2.txt" 2> /dev/null || wrong "P7: the second list of a job whose watch never began has the header '$(head -1 "$dir/reads/job.none2.txt" 2> /dev/null)'"
    # The marker gone with a watch still named: the list says there is no marker, and still ends the watch and says how it stood.
    fresh
    (w=''; cd "$dir/work" && bash tool/reads.sh mark --watch > /dev/null 2>&1 && w=$(cat .git/ob1-reads/watch.pid) && rm .git/ob1-reads/marker \
      && RUNNER_TEMP="$dir" bash tool/reads.sh list job unmarked > /dev/null 2>&1 && gone_soon "$w" && { ! running "$w" || { echo "reads.sh: a watch is still running after a list with no marker" >&2; exit 1; }; }) \
      || { echo "reads.sh: a list with its marker gone and a watch named did not hold" >&2; fails=$((fails + 1)); }
    grep -q ' sight=unmarked files=0 dirs=0 gone=0 odd=0 watch=ok$' "$dir/reads/job.unmarked.txt" 2> /dev/null || { echo "reads.sh: with its marker gone and a watch named the header is '$(head -1 "$dir/reads/job.unmarked.txt" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
    # P15: a list that has nowhere to write still ends its watch.
    fresh
    (w=''; cd "$dir/work" && bash tool/reads.sh mark --watch > /dev/null 2>&1 && w=$(cat .git/ob1-reads/watch.pid) && RUNNER_TEMP=/dev/null bash tool/reads.sh list job nowhere > /dev/null 2>&1 \
      && gone_soon "$w" && { ! running "$w" || { echo "reads.sh: P15: a list that could not be written left its watch running" >&2; exit 1; }; }) || wrong "P15: a list with nowhere to write, and the end of its watch, did not hold"
    # P16: another watch's word that it is ready, and then this watch's own: mark waits for its own.
    fresh
    out="$dir/reads/job.otherfirst.txt"
    # shellcheck disable=SC2016
    printf '#!/bin/sh\nprintf "5 another\\n" > "$4/watch.ready"\nsleep 0.5\nexec "%s" "$@"\n' "$(command -v python3)" > "$dir/stub/python3"
    (cd "$dir/work" && PATH="$dir/stub:$PATH" bash tool/reads.sh mark --watch > /dev/null 2>&1 && : < walked/c.txt && RUNNER_TEMP="$dir" bash tool/reads.sh list job otherfirst > /dev/null 2>&1) \
      || wrong "P16: mark --watch after another watch's word, and its list, did not exit 0"
    grep -q ' odd=0 watch=ok$' "$out" 2> /dev/null || wrong "P16: with another watch's word before its own the header is '$(head -1 "$out" 2> /dev/null)'"
    # P17: a watch with nothing to hear waits; it does not spin.
    fresh
    # shellcheck disable=SC2086 # $s is split on purpose, into the fields of the watch's stat line
    (cd "$dir/work" && bash tool/reads.sh mark --watch > /dev/null 2>&1 && sleep 1 && s=$(cat "/proc/$(cat .git/ob1-reads/watch.pid)/stat") && s=${s##*) } && set -- $s && [ "$((${12} + ${13}))" -le 30 ] \
      && RUNNER_TEMP="$dir" bash tool/reads.sh list job idle > /dev/null 2>&1) || wrong "P17: a watch with nothing to hear used more than 0.3 s of processor in its first second, or its list did not exit 0"
    # P18: a file whose mode alone changed, never opened: a row, by its own change alone, and a notice though the
    # watch alone gave no row.
    fresh
    out="$dir/reads/job.chmodded.txt"
    (cd "$dir/work" && bash tool/reads.sh mark --watch > /dev/null 2>&1 && chmod +x left/b.txt && RUNNER_TEMP="$dir" bash tool/reads.sh list job chmodded > "$dir/said" 2>&1) \
      || wrong "P18: a list after a file's mode changed did not exit 0"
    has "$(printf 'f\tleft/b.txt')" "P18: a file whose mode changed under the watch"
    grep -q '^::notice title=reads.sh::job (chmodded): 0 row(s) by the watch alone and 1 by a change to the file alone' "$dir/said" || wrong "P18: a row by a change to the file alone gave no notice: $(grep -m 1 '^reads.sh: job' "$dir/said")"
    # A marker without --watch over a live watch is of a job that does not watch: the watch ends itself, and the
    # list's header names none.
    fresh
    (w=''; cd "$dir/work" && bash tool/reads.sh mark --watch > /dev/null 2>&1 && w=$(cat .git/ob1-reads/watch.pid) && bash tool/reads.sh mark > /dev/null 2>&1 \
      && gone_soon "$w" && { ! running "$w" || { echo "reads.sh: a watch is still running after a plain mark" >&2; exit 1; }; } \
      && RUNNER_TEMP="$dir" bash tool/reads.sh list job plain > /dev/null 2>&1) || { echo "reads.sh: a plain mark over a live watch, and its list, did not hold" >&2; fails=$((fails + 1)); }
    grep -q ' odd=0$' "$dir/reads/job.plain.txt" 2> /dev/null || { echo "reads.sh: after a plain mark the header is '$(head -1 "$dir/reads/job.plain.txt" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
    # A second marker that watches takes the watch over: the first ends itself and writes nothing, and the list is the second's.
    fresh
    out="$dir/reads/job.second.txt"
    (w=''; cd "$dir/work" && sleep 0.05 && cat top.txt > /dev/null && ls . > /dev/null && sleep 0.05 && bash tool/reads.sh mark --watch > /dev/null 2>&1 && w=$(cat .git/ob1-reads/watch.pid) \
      && bash tool/reads.sh mark --watch > /dev/null 2>&1 && gone_soon "$w" && { ! running "$w" || { echo "reads.sh: the first of two watches is still running" >&2; exit 1; }; } \
      && cat top.txt > /dev/null && ls . > /dev/null && RUNNER_TEMP="$dir" bash tool/reads.sh list job second > "$dir/said" 2>&1) || { echo "reads.sh: two watched marks and a list did not hold" >&2; fails=$((fails + 1)); }
    grep -q ' odd=0 watch=ok$' "$out" 2> /dev/null || { echo "reads.sh: after two watched marks the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
    has "$(printf 'f\ttop.txt')" "a file read a second time, under the second of two watches"
    has "$(printf 'd\t./')" "Pe: the top listed a second time, under the second of two watches"
    if grep -v -E '^(::warning|::notice|reads\.sh: |  )' "$dir/said" | grep . > /dev/null; then echo "reads.sh: the list after two watched marks said more than its lines: $(grep -v -E '^(::warning|::notice|reads\.sh: |  )' "$dir/said" | head -1)" >&2; fails=$((fails + 1)); fi
  fi
  # A watch that says ok and heard nothing, here a python3 that keeps every word of the watch's and watches no
  # folder: it was not told of the list's own script being opened, so the list says lost. Needs no inotify.
  fresh
  mkdir -p "$dir/stub5"
  # shellcheck disable=SC2016 # the stub's sh expands its own "$4" and "$6", not this shell
  printf '#!/bin/sh\necho "0 $6" > "$4/watch.ready"\nn=0\nwhile [ ! -e "$4/watch.stop" ]; do n=$((n + 1)); [ "$n" -lt 100 ] || exit 1; sleep 0.1; done\n: > "$4/watch.files"; : > "$4/watch.dirs"; : > "$4/watch.under"\necho "ok $6" > "$4/watch.status"\n' > "$dir/stub5/python3" && chmod +x "$dir/stub5/python3"
  (cd "$dir/work" && PATH="$dir/stub5:$PATH" bash tool/reads.sh mark --watch > /dev/null 2>&1 && cat top.txt > /dev/null && RUNNER_TEMP="$dir" bash tool/reads.sh list job deaf > "$dir/said" 2>&1) \
    || { echo "reads.sh: mark --watch and list with a watch that hears nothing did not exit 0" >&2; fails=$((fails + 1)); }
  grep -q ' odd=0 watch=lost$' "$dir/reads/job.deaf.txt" 2> /dev/null || { echo "reads.sh: with a watch that says ok and heard nothing the header is '$(head -1 "$dir/reads/job.deaf.txt" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
  grep -q "^::warning title=reads.sh::the watch was lost (it was told of no opening of this file" "$dir/said" || { echo "reads.sh: a watch that heard nothing was not said to: $(grep -m 1 'title=reads.sh' "$dir/said")" >&2; fails=$((fails + 1)); }
  # A list whose paths git could not name, here by a git that fails to list the files: broken, empty and not
  # short, and exit 0. A list short of rows it should hold is the one list worse than none.
  fresh
  out="$dir/reads/job.broken.txt"
  mkdir -p "$dir/stub2" && printf '#!/bin/sh\ncase " $* " in *" ls-files -z "*) exit 1 ;; esac\nexec "%s" "$@"\n' "$(command -v git)" > "$dir/stub2/git" && chmod +x "$dir/stub2/git"
  (cd "$dir/work" && bash tool/reads.sh mark > /dev/null 2>&1 && cat top.txt > /dev/null && PATH="$dir/stub2:$PATH" RUNNER_TEMP="$dir" bash tool/reads.sh list job broken > "$dir/said" 2>&1) \
    || { echo "reads.sh: a list whose paths git could not name did not exit 0" >&2; fails=$((fails + 1)); }
  if grep -q 'sight=blind' "$out" 2> /dev/null; then :
  else
    grep -q '^# reads v1 job=job cell=broken commit=[0-9a-f]\{40\} status=- sight=broken files=0 dirs=0 gone=0 odd=0$' "$out" 2> /dev/null || { echo "reads.sh: with paths git could not name the header is '$(head -1 "$out" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
    [ "$(wc -l < "$out" 2> /dev/null | tr -d ' ')" = 1 ] || { echo "reads.sh: a broken list holds rows" >&2; fails=$((fails + 1)); }
    grep -q '^::warning title=reads.sh::a command that names the paths or writes the rows failed (the files read), so job (broken)' "$dir/said" || { echo "reads.sh: a broken list gave no warning" >&2; fails=$((fails + 1)); }
    # So is one made while a find died of a signal, as one killed for memory would: its batch of paths is in no
    # row. (The find that tests the list's own sight is let through.) And one whose rows could not be sorted.
    fresh
    # shellcheck disable=SC2016 # the stub's sh expands its own "$*", "$1", "$@" and $$, not this shell
    mkdir -p "$dir/stub3" && printf '#!/bin/sh\ncase "$*" in *ob1-reads/sight*) exec "%s" "$@" ;; esac\nkill -KILL $$\n' "$(command -v find)" > "$dir/stub3/find" && chmod +x "$dir/stub3/find"
    (cd "$dir/work" && bash tool/reads.sh mark > /dev/null 2>&1 && cat top.txt > /dev/null && PATH="$dir/stub3:$PATH" RUNNER_TEMP="$dir" bash tool/reads.sh list job killed > /dev/null 2>&1) \
      || { echo "reads.sh: a list made while a find died did not exit 0" >&2; fails=$((fails + 1)); }
    grep -q ' sight=broken files=0 dirs=0 gone=0 odd=0$' "$dir/reads/job.killed.txt" 2> /dev/null || { echo "reads.sh: with a find that died the header is '$(head -1 "$dir/reads/job.killed.txt" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
    fresh
    # shellcheck disable=SC2016 # the stub's sh expands its own "$*", "$1", "$@" and $$, not this shell
    mkdir -p "$dir/stub4" && printf '#!/bin/sh\ncase "$1" in -u) exit 1 ;; esac\nexec "%s" "$@"\n' "$(command -v sort)" > "$dir/stub4/sort" && chmod +x "$dir/stub4/sort"
    (cd "$dir/work" && bash tool/reads.sh mark > /dev/null 2>&1 && cat top.txt > /dev/null && PATH="$dir/stub4:$PATH" RUNNER_TEMP="$dir" bash tool/reads.sh list job unsorted > /dev/null 2>&1) \
      || { echo "reads.sh: a list whose rows could not be sorted did not exit 0" >&2; fails=$((fails + 1)); }
    grep -q ' sight=broken files=0 dirs=0 gone=0 odd=0$' "$dir/reads/job.unsorted.txt" 2> /dev/null || { echo "reads.sh: with rows that could not be sorted the header is '$(head -1 "$dir/reads/job.unsorted.txt" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
  fi
  # P8: a watch that heard this file opened and nothing else stands ok, and the list's summary line counts the rows
  # of files and folders it did not hear, a file gone not among them. Needs no inotify.
  fresh
  mkdir -p "$dir/stub8"
  # shellcheck disable=SC2016
  printf '#!/bin/sh\necho "1 $6" > "$4/watch.ready"\nn=0\nwhile [ ! -e "$4/watch.stop" ]; do n=$((n + 1)); [ "$n" -lt 100 ] || exit 1; sleep 0.1; done\nprintf "tool/reads.sh\\0" > "$4/watch.files"; : > "$4/watch.dirs"; : > "$4/watch.under"\necho "ok $6" > "$4/watch.status"\n' > "$dir/stub8/python3" && chmod +x "$dir/stub8/python3"
  (cd "$dir/work" && PATH="$dir/stub8:$PATH" bash tool/reads.sh mark --watch > /dev/null 2>&1 && cat top.txt > /dev/null && ls walked > /dev/null && rm left/b.txt \
    && RUNNER_TEMP="$dir" bash tool/reads.sh list job halfdeaf > "$dir/said" 2>&1) || wrong "P8: mark --watch and list with a watch that heard one name did not exit 0"
  if grep -q 'sight=blind' "$dir/reads/job.halfdeaf.txt" 2> /dev/null; then :
  else
    grep -q ' gone=1 odd=0 watch=ok$' "$dir/reads/job.halfdeaf.txt" 2> /dev/null || wrong "P8: with a watch that heard one name the header is '$(head -1 "$dir/reads/job.halfdeaf.txt" 2> /dev/null)'"
    grep -q ': it heard 1 name(s) opened; 2 row(s) by access times alone, 0 row(s) by the watch alone, 0 by a change to the file alone)' "$dir/said" || wrong "P8: a watch that heard one name of three rows: $(grep -m 1 '^reads.sh: job' "$dir/said")"
    # P9: a watch that says ok and left no list of the folders it heard: broken, not a list without them.
    fresh
    # shellcheck disable=SC2016
    printf '#!/bin/sh\necho "1 $6" > "$4/watch.ready"\nn=0\nwhile [ ! -e "$4/watch.stop" ]; do n=$((n + 1)); [ "$n" -lt 100 ] || exit 1; sleep 0.1; done\nprintf "tool/reads.sh\\0" > "$4/watch.files"\necho "ok $6" > "$4/watch.status"\n' > "$dir/stub8/python3"
    (cd "$dir/work" && PATH="$dir/stub8:$PATH" bash tool/reads.sh mark --watch > /dev/null 2>&1 && cat top.txt > /dev/null && RUNNER_TEMP="$dir" bash tool/reads.sh list job nodirs > /dev/null 2>&1) \
      || wrong "P9: a list whose watch left no list of folders did not exit 0"
    grep -q ' sight=broken files=0 dirs=0 gone=0 odd=0 watch=ok$' "$dir/reads/job.nodirs.txt" 2> /dev/null || wrong "P9: with a watch that left no list of folders the header is '$(head -1 "$dir/reads/job.nodirs.txt" 2> /dev/null)'"
    # P10: each command that names paths, failing alone, breaks the list: the find for the files, the find for the
    # folders, the xargs that asks which files are gone; and so does the marker going while the list is made.
    for w in files dirs gone marker; do
      fresh
      mkdir -p "$dir/stub9.$w"
      # shellcheck disable=SC2016
      case "$w" in
        files) printf '#!/bin/sh\ncase "$*" in *"./top.txt "*) kill -KILL $$ ;; esac\nexec "%s" "$@"\n' "$(command -v find)" > "$dir/stub9.$w/find" ;;
        dirs) printf '#!/bin/sh\ncase "$*" in *"./walked -maxdepth"*) kill -KILL $$ ;; esac\nexec "%s" "$@"\n' "$(command -v find)" > "$dir/stub9.$w/find" ;;
        gone) printf '#!/bin/sh\ncase "$2" in sh) cat > /dev/null; exit 1 ;; esac\nexec "%s" "$@"\n' "$(command -v xargs)" > "$dir/stub9.$w/xargs" ;;
        marker) printf '#!/bin/sh\ncase " $* " in *" ls-tree "*) rm -f .git/ob1-reads/marker ;; esac\nexec "%s" "$@"\n' "$(command -v git)" > "$dir/stub9.$w/git" ;;
      esac
      chmod +x "$dir/stub9.$w"/*
      (cd "$dir/work" && bash tool/reads.sh mark > /dev/null 2>&1 && cat top.txt > /dev/null && PATH="$dir/stub9.$w:$PATH" RUNNER_TEMP="$dir" bash tool/reads.sh list job "alone.$w" > /dev/null 2>&1) \
        || wrong "P10: a list made while the command for the $w failed did not exit 0"
      grep -q ' sight=broken files=0 dirs=0 gone=0 odd=0$' "$dir/reads/job.alone.$w.txt" 2> /dev/null || wrong "P10: with the command for the $w failing alone the header is '$(head -1 "$dir/reads/job.alone.$w.txt" 2> /dev/null)'"
    done
  fi
  # P11: tracked folders that could not be named: no watch, and said so; not a watch on the top alone that says ok.
  fresh
  # shellcheck disable=SC2016
  mkdir -p "$dir/stub11" && printf '#!/bin/sh\ncase " $* " in *" ls-tree "*) exit 1 ;; esac\nexec "%s" "$@"\n' "$(command -v git)" > "$dir/stub11/git" && chmod +x "$dir/stub11/git"
  (cd "$dir/work" && PATH="$dir/stub11:$PATH" bash tool/reads.sh mark --watch > "$dir/said" 2>&1 && RUNNER_TEMP="$dir" bash tool/reads.sh list job unnamedfolders >> "$dir/said" 2>&1) \
    || wrong "P11: mark --watch and list with tracked folders that could not be named did not exit 0"
  grep -q ' watch=none$' "$dir/reads/job.unnamedfolders.txt" 2> /dev/null || wrong "P11: with tracked folders that could not be named the header is '$(head -1 "$dir/reads/job.unnamedfolders.txt" 2> /dev/null)'"
  grep -q '^::warning title=reads.sh::no watch began (the tracked folders could not be named)' "$dir/said" || wrong "P11: the mark did not say the tracked folders could not be named: $(grep -m 1 'title=reads.sh' "$dir/said")"
  # P14: a watch that says ok and heard only a name that holds this file's: not proof that it hears.
  fresh
  mkdir -p "$dir/stub14"
  # shellcheck disable=SC2016
  printf '#!/bin/sh\necho "1 $6" > "$4/watch.ready"\nn=0\nwhile [ ! -e "$4/watch.stop" ]; do n=$((n + 1)); [ "$n" -lt 100 ] || exit 1; sleep 0.1; done\nprintf "tool/reads.sh.bak\\0" > "$4/watch.files"; : > "$4/watch.dirs"; : > "$4/watch.under"\necho "ok $6" > "$4/watch.status"\n' > "$dir/stub14/python3" && chmod +x "$dir/stub14/python3"
  (cd "$dir/work" && PATH="$dir/stub14:$PATH" bash tool/reads.sh mark --watch > /dev/null 2>&1 && RUNNER_TEMP="$dir" bash tool/reads.sh list job nearly > /dev/null 2>&1) \
    || wrong "P14: mark --watch and list with a watch that heard a name like this file's did not exit 0"
  grep -q ' watch=lost$' "$dir/reads/job.nearly.txt" 2> /dev/null || wrong "P14: with a watch that heard only a name like this file's the header is '$(head -1 "$dir/reads/job.nearly.txt" 2> /dev/null)'"
  # P22: a watch that was heard from and then died saying why: lost, with its last word. Needs no inotify.
  fresh
  mkdir -p "$dir/stub22"
  # shellcheck disable=SC2016
  printf '#!/bin/sh\necho "1 $6" > "$4/watch.ready"\nsleep 0.3\necho "the watch fell over" >&2\nexit 3\n' > "$dir/stub22/python3" && chmod +x "$dir/stub22/python3"
  (cd "$dir/work" && PATH="$dir/stub22:$PATH" bash tool/reads.sh mark --watch > /dev/null 2>&1 && sleep 0.5 && RUNNER_TEMP="$dir" bash tool/reads.sh list job fell > "$dir/said" 2>&1) \
    || wrong "P22: mark --watch and list with a watch that died did not exit 0"
  grep -q ' watch=lost$' "$dir/reads/job.fell.txt" 2> /dev/null || wrong "P22: with a watch that died the header is '$(head -1 "$dir/reads/job.fell.txt" 2> /dev/null)'"
  grep -q '^::warning title=reads.sh::the watch was lost (it ended with no status: the watch fell over)' "$dir/said" || wrong "P22: a watch that died was not said to have, with its last word: $(grep -m 1 'title=reads.sh' "$dir/said")"
  # A list that could not be put in its place, here by an mv that fails: no list, and said, where a line about
  # its rows would speak of a file that is not there.
  fresh
  mkdir -p "$dir/stub6" && printf '#!/bin/sh\nexit 1\n' > "$dir/stub6/mv" && chmod +x "$dir/stub6/mv"
  (cd "$dir/work" && bash tool/reads.sh mark > /dev/null 2>&1 && PATH="$dir/stub6:$PATH" RUNNER_TEMP="$dir" bash tool/reads.sh list job unplaced > "$dir/said" 2>&1) \
    || { echo "reads.sh: a list that could not be put in its place did not exit 0" >&2; fails=$((fails + 1)); }
  if [ -e "$dir/reads/job.unplaced.txt" ]; then echo "reads.sh: a list that could not be put in its place is there all the same" >&2; fails=$((fails + 1)); fi
  [ "$(cat "$dir/said")" = "::warning title=reads.sh::job (unplaced)'s list could not be written under $dir/reads, so there is none" ] || { echo "reads.sh: a list that could not be put in its place said '$(head -3 "$dir/said" | tr '\n' '|')'" >&2; fails=$((fails + 1)); }
  # In a repository with no commit the header is still one line, its commit a dash, and the list broken: the
  # folders cannot be named there.
  (cd "$dir" && rm -rf bare && g init -q bare && cd bare && mkdir tool && cp "$SELF" tool/reads.sh && g add -A && bash tool/reads.sh mark > /dev/null 2>&1 \
    && RUNNER_TEMP="$dir" bash tool/reads.sh list job uncommitted > /dev/null 2>&1) || { echo "reads.sh: mark and list in a repository with no commit did not exit 0" >&2; fails=$((fails + 1)); }
  if ! grep -q 'sight=blind' "$dir/reads/job.uncommitted.txt" 2> /dev/null; then
    [ "$(cat "$dir/reads/job.uncommitted.txt" 2> /dev/null)" = '# reads v1 job=job cell=uncommitted commit=- status=- sight=broken files=0 dirs=0 gone=0 odd=0' ] \
      || { echo "reads.sh: in a repository with no commit the list is '$(head -3 "$dir/reads/job.uncommitted.txt" 2> /dev/null | tr '\n' '|')'" >&2; fails=$((fails + 1)); }
  fi
  # mark takes --watch and nothing else.
  if (cd "$dir/work" && bash tool/reads.sh mark --wach) > /dev/null 2>&1; then echo "reads.sh: mark took a word that is not --watch" >&2; fails=$((fails + 1)); fi
  if (cd "$dir/work" && bash tool/reads.sh mark --watch more) > /dev/null 2>&1; then echo "reads.sh: mark took a word after --watch" >&2; fails=$((fails + 1)); fi
  # A watch whose name could not be written (a folder stands where its file goes): the marker still says a watch
  # was asked for, so the list says none began, and does not read as the list of a job that never watched.
  fresh
  (cd "$dir/work" && mkdir -p .git/ob1-reads/watch.asked && bash tool/reads.sh mark --watch > /dev/null 2>&1 && RUNNER_TEMP="$dir" bash tool/reads.sh list job unnamed > /dev/null 2>&1) \
    || { echo "reads.sh: mark --watch and list with a watch that could not be named did not exit 0" >&2; fails=$((fails + 1)); }
  grep -q ' odd=0 watch=none$' "$dir/reads/job.unnamed.txt" 2> /dev/null || { echo "reads.sh: with a watch that could not be named the header is '$(head -1 "$dir/reads/job.unnamed.txt" 2> /dev/null)'" >&2; fails=$((fails + 1)); }
  # …and a watch that began, whose word that it had could not be kept (a folder there too): mark says none began
  # and not that it watches, the watch ends itself, its name taken back, and the list says none.
  if [ -n "$watched" ]; then
    fresh
    (w=''; cd "$dir/work" && mkdir -p .git/ob1-reads/watch.heard && bash tool/reads.sh mark --watch > "$dir/said" 2>&1 && w=$(cat .git/ob1-reads/watch.pid) \
      && gone_soon "$w" && { ! running "$w" || { echo "reads.sh: a watch whose word could not be kept was left running" >&2; exit 1; }; } \
      && RUNNER_TEMP="$dir" bash tool/reads.sh list job unkept >> "$dir/said" 2>&1) || wrong "mark --watch and list with a watch whose word could not be kept, and the end of that watch, did not hold"
    grep -q ' odd=0 watch=none$' "$dir/reads/job.unkept.txt" 2> /dev/null || wrong "with a watch whose word could not be kept the header is '$(head -1 "$dir/reads/job.unkept.txt" 2> /dev/null)'"
    [ "$(grep -c '^::warning title=reads.sh::no watch began (its word that it began could not be kept)' "$dir/said")" = 2 ] || wrong "mark and list did not each say the watch's word could not be kept: $(grep -m 2 'title=reads.sh' "$dir/said" | tr '\n' '|')"
    if grep -q '^reads.sh: watching ' "$dir/said"; then wrong "mark said it was watching, of a watch whose word could not be kept"; fi
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
  v=$(find "$dir/reads" -maxdepth 1 -name '.list.*' 2> /dev/null | tr '\n' ' ')
  if [ -n "$v" ]; then wrong "P20: a list left scratch files beside the lists: $v"; fi
  if [ "$fails" -gt 0 ]; then echo "reads.sh: $fails case(s) wrong" >&2; return 1; fi
  echo "reads.sh: every case holds"
}

case "${1:-}" in
  --self-check) self_check ;;
  mark) shift; mark "$@" ;;
  list) shift; list "$@" ;;
  *) echo "usage: reads.sh mark [--watch] | list JOB [CELL] | --self-check" >&2; exit 2 ;;
esac
