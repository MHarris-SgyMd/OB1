#!/bin/bash
# Whether a Brain Checks run's change can affect its code jobs (SMD-2435).
# `changes.sh EVENT BASE_REF DEFAULT_BRANCH` writes code=true|false, skip= and
# why= to $GITHUB_OUTPUT (and says them); `changes.sh --self-check` runs its
# cases; `changes.sh --not-code` prints which of the paths on stdin skip (check
# 47); `changes.sh --blocks FILE` prints how it cuts a workflow (check 51);
# `changes.sh --charges` prints CHARGES (check 53); `changes.sh --map-lists`
# prints MAP_LISTS (check 56).
# The changes job runs the BASE branch's copy of this file (review pass 1), so
# a pull request that edits it is judged by the copy already on its base.
#
# A pull request's checkout is its merge commit, so HEAD^1..HEAD is what it
# changes, read with --raw -z --no-renames: no path is quoted, a rename lists
# its old path too, and each path's modes come with it, so a symlink or a
# submodule at a docs path is code (review pass 2: a symlink looped the walks).
# code=false only for a pull request into the default branch whose every
# changed path is not_code's. Anything else is code=true, and every job runs
# unless skip= names some (below):
# - another event (a push to main always runs everything);
# - a pull request into another branch: stacked on one whose code has not run
#   here, it would keep this green once retargeted (review pass 1);
# - a HEAD with no second parent (not a merge commit, or a shallow fetch);
# - a change git cannot list or that is empty;
# - one path off the list that is neither CHARGES's nor a workflow edit, or a
#   symlink or submodule anywhere.
# No error here stops the step, so the job succeeds with an answer, and a job
# that fails anyway makes every gated job run (their `if:`) and the aggregate red.
#
# brain-checks.yml is read by job (PR 2): a pull request whose only change off
# the list is an edit of that file runs the jobs whose block it changed, and
# skip= names the gated jobs whose block is the same byte for byte. The file
# is cut at its job keys (cut_blocks); an edit above `jobs:` or to a job
# RUN_ALL_JOBS names, or a file the cut cannot read, runs every job. Check 51
# holds the cut to Bun's reading of the file: each block parses alone to its
# job as the whole file does, so no anchor, alias or flow style crosses a block.
#
# A path off the list that CHARGES names (PR 3a) charges the gated jobs it
# gives, none for a path no gated job reads; a pull request whose every path
# off the list is CHARGES's or a workflow edit skips the gated jobs nothing
# charged or edited. Check 53 holds CHARGES to the files and steps naming each
# path. A workflow edit beside HOLDS_THE_CUT's files runs every job.
#
# A path off the list that nothing above names ran every job until PR 3b-2.
# Now the jobs MAP_LISTS names may skip it, by what they read (by_map): each
# keeps a list of the tracked files it opened and the folders it listed
# (.github/ci/reads.sh), and a job that passed on main, reading nothing that
# differs between that commit and this checkout, reads the same bytes here and
# passes again. The lists are those of main's newest green push run, fetched
# here by the base's copy of this file; no lists, or any doubt below, and
# every job runs as before.
set -uo pipefail
WORKFLOW=.github/workflows/brain-checks.yml
# The jobs an edit of which runs every job: the changes job, whose answer the
# gates read, and the job that runs the checker, whose check 51 is what makes
# an unchanged block a safe skip (review pass 2). Check 51 holds this list.
RUN_ALL_JOBS="changes repo-consistency"
# Beside a workflow edit these run every job: the checker, whose check 51
# holds the cut, and this file, whose cut the base's copy applies to the
# head's workflow, unheld by check 51 when the two cuts differ.
HOLDS_THE_CUT="scripts/check-consistency.ts .github/ci/changes.sh"
# The paths off the list a gated job is known to read (PR 3a): each pattern,
# a tab, then the gated jobs it can affect, one space between, or none for a
# path no gated job reads; a path not here runs every job. Check 53 holds
# each entry to the files whose code names it and the jobs whose steps do.
# Kept by hand: by_map counts it beside a job's own list (PR 3b-2), so a job
# it names runs for its paths whatever the list holds. A job written with
# `:list` after it is charged unless its list says otherwise (the maintainer,
# 2026-11-20): where main's lists are read and the job's is whole, the list
# decides, by by_map's rule; with no lists the row counts as any other.
# Check 56 holds the mark to MAP_LISTS's jobs. It was `?` for a day: these
# names are expanded unquoted, where a `?` is a glob, and a file at the top
# named db-schemaX would have taken the job's place (review pass 5).
# changes/* marks db-schema: a step of its names ingest-records.ts, which can
# read a record, and over main's runs its list never held one, so it ran for
# every pull request with a record and read none of them.
CHARGES="changes/*	deploy-stack db-schema:list
scripts/check-consistency.ts	data-layer
.github/ci/typecheck.sh	portable-server
.github/ci/full-stack-up.sh	deploy-stack deploy-stack-brains deploy-stack-auth deploy-stack-observability
.github/ci/auth-settings.sh	deploy-stack deploy-stack-brains deploy-stack-auth deploy-stack-observability
.github/ci/held-cases.sh	deploy-stack
.github/ci/changes.sh
.github/ci/test-counts-page.ts	compat-shim
.github/workflows/release.yml
.github/workflows/release-steps.yml
.github/workflows/ci-shift.yml
db/ci-parity.sh	"

# The lists the record of main's reads may skip a job by (PR 3b-2): a job's
# name, or job.cell for each cell of a matrix job, as reads.sh names its
# lists. A job skips by them only when every one of its lists is there, of one
# commit, from a job that succeeded and saw access times. The six here were
# stable over main's runs (SMD-2435's measurement, 2026-11-20). Not here, so
# run by any path off the lists above: the jobs that run a compose stack or
# build an image, whose containers read through mounts no list sees (PR 3c's),
# and compat-shim, which greps the whole tree. Check 56 holds each name to a
# gated job and its cells, and each gated job to this list or to its reason.
MAP_LISTS="portable-server db-schema replay-gate data-layer preflight-rest db-live.rest db-live.sleep db-live.long db-live.extract db-live.sweep db-live.claims"
# The names a runtime or git looks for in each folder above a file it loads,
# without opening what is not there: one added above a file a job read counts
# against the job, though no list could hold it. Beside them by_map counts
# .env and every .env.<name>, which Bun loads from the folder it is run in;
# a file whose name, less one or more of its extensions, is a folder the job
# read through, which an import of that folder would now find first; and
# .gitattributes, whatever becomes of it, an edit too: the checkout applies
# it before any marker is made, so no list holds it, and it sets the bytes
# of every file under it.
MAP_LOOKED_FOR="package.json tsconfig.json jsconfig.json bunfig.toml bun.lock bun.lockb .npmrc .gitignore"

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
    # the full-stack job's release rehearsal reads changes/ whole, and db-schema
    # runs ingest-records.ts, which can.
    docs/subject-anchored-claims.md | integrations/telegram-capture/README.md | integrations/slack-capture/README.md | \
      recipes/vercel-neon-telegram/README.md | recipes/schema-aware-routing/README.md | changes/*) return 1 ;;
    # Copied into an image, mounted into the stack, or CI's own: whatever the file.
    dashboard/* | plugins/* | server-portable/* | deploy/* | db/migrations/* | .github/*) return 1 ;;
    *.md) return 0 ;;
    docs/*.png | docs/*.jpg | docs/*.jpeg | docs/*.gif | docs/*.webp | docs/*.svg) return 0 ;;
  esac
  return 1
}

# charges PATH: the gated jobs CHARGES gives a path, printed (none for a path
# no gated job reads); returns 1 for a path it does not name.
charges() {
  local pat jobs
  while IFS=$'\t' read -r pat jobs; do
    # shellcheck disable=SC2254 # the pattern is CHARGES's own glob
    case "$1" in $pat) printf '%s\n' "$jobs"; return 0 ;; esac
  done <<< "$CHARGES"
  return 1
}

# decide EVENT FILE: FILE holds `git diff --raw -z` records — ":OLDMODE NEWMODE
# OLDSHA NEWSHA STATUS", NUL, the path, NUL. Prints "true|false<TAB>why", or
# "partial<TAB>WF<TAB>JOBS<TAB>why" when every path off the list is an edit of
# WORKFLOW, a regular file before and after (WF 1), or one CHARGES names, JOBS
# the gated jobs those charge; answer then reads the workflow by job. The one
# true that names a path off every list ends "<TAB>map": answer then asks
# by_map which jobs read nothing that differs.
decide() {
  local event=$1 file=$2 meta f n=0 wf=0 oldmode newmode charged='' partial=0 j held=''
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
    if [ "$f" = "$WORKFLOW" ] && [ "$oldmode $newmode" = '100644 100644' ]; then wf=1; partial=1; continue; fi
    not_code "$f" && continue
    case " $HOLDS_THE_CUT " in *" $f "*) held=$f ;; esac
    if j=$(charges "$f"); then charged="$charged $j"; partial=1; continue; fi
    printf 'true\t%s can affect the code jobs\tmap\n' "$f"; return
  done < "$file"
  if [ "$n" = 0 ]; then printf 'true\tno path read from HEAD^1..HEAD\n'; return; fi
  if [ "$wf" = 1 ] && [ -n "$held" ]; then printf 'true\t%s is edited beside %s, which holds how it is read by job\n' "$WORKFLOW" "$held"; return; fi
  if [ "$partial" = 1 ]; then
    # shellcheck disable=SC2086 # split on purpose: one job a line
    charged=$(printf '%s\n' $charged | sort -u | tr '\n' ' '); charged=${charged% }
    printf 'partial\t%s\t%s\tevery path off the list is a workflow edit or one CHARGES names\n' "$wf" "$charged"; return
  fi
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

# changed_ids DIR: the ids whose block differs between DIR/base and DIR/head,
# as cut_blocks wrote them (.top for what lies outside the jobs), one space
# between; a block on one side alone differs.
changed_ids() {
  local d=$1 f id changed=''
  for f in "$d"/base/* "$d"/base/.top "$d"/head/* "$d"/head/.top; do
    [ -e "$f" ] || continue
    id=${f##*/}
    case " $changed " in *" $id "*) continue ;; esac
    cmp -s "$d/base/$id" "$d/head/$id" || changed="$changed $id"
  done
  printf '%s' "${changed# }"
}

# by_job WF CHARGED: in a checkout whose every path off the list is an edit of
# WORKFLOW (WF 1) or one CHARGES names, CHARGED the gated jobs those charge,
# one marked `:list` charged as the rest here (answer asks by_map after it);
# prints "true<TAB>skip<TAB>why". skip names the gated jobs (a block holding
# its own gate on skip) that nothing charged and, with WF 1, whose block is
# unchanged; it is empty when an edit outside the jobs or of a RUN_ALL_JOBS
# job, or an unreadable file, runs every job.
by_job() {
  local wf=$1 charged=${2//:list/} d f id changed='' skip='' rc=0 at=HEAD
  if [ "$wf" = 1 ]; then at='HEAD^1 and HEAD'; fi
  d=$(mktemp -d) || { printf 'true\t\tno scratch directory to read %s by job\n' "$WORKFLOW"; return; }
  mkdir "$d/base" "$d/head"
  # Each a blob fetched when it is read, the workflow being outside the job's sparse cone: bounded, as by_map's are.
  if ! limit 15 git show "HEAD:$WORKFLOW" > "$d/head.yml" 2> /dev/null || { [ "$wf" = 1 ] && ! limit 15 git show "HEAD^1:$WORKFLOW" > "$d/base.yml" 2> /dev/null; }; then
    printf 'true\t\t%s could not be read at %s\n' "$WORKFLOW" "$at"; rc=1
  elif ! cut_blocks "$d/head.yml" "$d/head" 2> /dev/null || { [ "$wf" = 1 ] && ! cut_blocks "$d/base.yml" "$d/base" 2> /dev/null; }; then
    printf 'true\t\t%s is not in the shape its jobs are read apart in\n' "$WORKFLOW"; rc=1
  fi
  if [ "$rc" = 0 ] && [ "$wf" = 1 ]; then
    changed=$(changed_ids "$d")
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
      case " $changed $charged " in *" $id "*) continue ;; esac
      grep -qF "' $id '" "$f" && grep -qF 'needs.changes.outputs.skip' "$f" && skip="$skip $id"
    done
    printf 'true\t%s\tthe change reaches job(s) %s; the other gated jobs skip\n' "${skip# }" "$(printf '%s %s' "$changed" "$charged" | tr -s ' ' | sed 's/^ //; s/ $//; s/^$/none/')"
  fi
  rm -rf "$d"
}

# limit SECONDS COMMAND...: the command, ended at its limit where there is a
# timeout to end it (a runner has one; macOS does not, and runs it unbounded).
limit() { if command -v timeout > /dev/null 2>&1; then timeout "$@"; else shift; "$@"; fi; }

# fetch_lists DIR DEFAULT_BRANCH: MAP_LISTS's lists of this workflow's newest
# push run on the default branch that succeeded, into DIR, each as
# reads.sh named it. The run is asked for by event and branch, so no pull
# request's run can be the one found, whatever its branch is named in the
# repository it comes from. Needs gh, unzip and the run's token (GH_TOKEN,
# with GITHUB_REPOSITORY): contents: read is enough of a public repository
# (the probe, OB1 PR 846), and a private one would want actions: read, every
# job running until it had it. Fails with none of them or no such run. Each
# download is tried three times: on the probe one of eleven failed once, and
# its job ran for it; a list that still does not arrive is by_map's to miss.
# Bounded: the gated jobs wait on this job, about two seconds for all of it,
# and every call over the network here and in by_map has a limit, 135 s when
# each runs to its own (15, 15 and 45 here; 30 for the commit and 15 for each
# read of the workflow there), well inside the job's five minutes; by_job's
# two reads of the workflow, 15 each, come before them for a pull request
# of records alone.
fetch_lists() {
  local dir=$1 default=$2 run id arts name ids=''
  if ! command -v gh > /dev/null 2>&1 || ! command -v unzip > /dev/null 2>&1 || [ -z "${GH_TOKEN:-}" ] || [ -z "${GITHUB_REPOSITORY:-}" ] || [ -z "$default" ]; then return 1; fi
  run=$(limit 15 gh api "repos/$GITHUB_REPOSITORY/actions/workflows/${WORKFLOW##*/}/runs?branch=$default&event=push&status=success&per_page=1" --jq '.workflow_runs[0].id' 2> /dev/null) || return 1
  id=${run%%[!0-9]*}
  if [ -z "$id" ] || [ "$id" != "$run" ]; then return 1; fi
  arts=$(limit 15 gh api --paginate "repos/$GITHUB_REPOSITORY/actions/runs/$id/artifacts?per_page=100" --jq '.artifacts[] | select(.expired | not) | "\(.name) \(.id)"' 2> /dev/null) || return 1
  # A run whose failed jobs were run again can hold a name twice, the failed attempt's list and the
  # passing one's: the newest, the highest id, is the one the run's success stands on. Every page of
  # them is read: a run run again whole holds its artifacts over, and a hundred is a page.
  for name in $MAP_LISTS; do
    ids="$ids $(awk -v want="reads-${name//./-}" '$1 == want && $2 ~ /^[0-9]+$/ && $2 + 0 > best { best = $2 + 0; id = $2 } END { if (id != "") print id }' <<< "$arts")"
  done
  # Each artifact is a zip of the one list; all at once, a second or so in all.
  # shellcheck disable=SC2086,SC2016 # ids split on purpose; sh expands $REPO and $DIR
  printf '%s\n' $ids | REPO=$GITHUB_REPOSITORY DIR=$dir limit 45 xargs -P 12 -I '{}' sh -c 'for try in 1 2 3; do
      if gh api "repos/$REPO/actions/artifacts/{}/zip" > "$DIR/{}.zip" 2> /dev/null && unzip -q -o -j -d "$DIR" "$DIR/{}.zip" "*.txt" > /dev/null 2>&1; then exit 0; fi
      sleep 1
    done; exit 1' || true
  return 0
}

# by_map WHY DEFAULT_BRANCH, in a pull request's checkout one of whose paths is
# off every list above (WHY names it): prints "true<TAB>skip<TAB>why", skip the
# jobs MAP_LISTS names that read nothing that differs. X is the commit the
# lists were recorded on, and the change counted is everything between X and
# HEAD, main's own commits since X with the pull request's: a job's list says
# what it read at X, and holds here only if none of that has moved. A job runs
# when its list, or one of its cells', is missing, cut short, short of a path
# it could not write, or not a passing job's that saw access times; or when,
# between X and HEAD:
# - a file its list holds (opened, or gone by its end) is modified or deleted;
# - a path is added or deleted, or a file's mode changes, in a folder the job
#   listed or opened a file in (or, the folder itself new or gone, the nearest
#   one above that is not): what a job asks after without opening leaves no
#   access time, and a job at work in a folder is taken to ask after its files;
# - a MAP_LOOKED_FOR name or an .env is added or deleted in any folder above a
#   file it opened, or a .gitattributes there differs at all;
# - a file is added or deleted whose name, less one or more of its
#   extensions, is a folder above a file it opened;
# - CHARGES names a path that differs, and the job with no `:list` after it;
# - its block of the workflow differs, or it holds no gate on skip.
# Every job runs (skip empty) with no lists to read, lists of more than one
# commit, an X that is not here and cannot be fetched, a symlink, a submodule
# or a path with a control character in the change, a workflow that cannot be
# cut, one that differs outside its jobs or in a RUN_ALL_JOBS job, or one that
# differs beside HOLDS_THE_CUT's files. READS_MAP_DIR, when set, is where the
# lists are read from in place of the fetch: the cases' own, and a replay's.
# With ONLY, the jobs judged are those alone: the ones a CHARGES row marked
# `:list`, in a pull request whose other paths by_job has answered for.
by_map() {
  local why=$1 default=$2 only=${3:-} d x='' name job cell f head re jobs='' bad='' ok='' meta p oldmode newmode s j wf=0 held='' changed='' charged='' id skip='' hit n=0
  d=$(mktemp -d) || { printf 'true\t\t%s\n' "$why"; return; }
  # no_map REASON: every job runs, as before PR 3b-2, and the answer says why.
  no_map() { printf 'true\t\t%s; %s\n' "$why" "$1"; rm -rf "$d"; }
  mkdir "$d/lists" "$d/base" "$d/head"
  if [ -n "${READS_MAP_DIR:-}" ]; then cp "$READS_MAP_DIR"/*.txt "$d/lists/" 2> /dev/null || true
  else fetch_lists "$d/lists" "$default" || true; fi
  for name in $MAP_LISTS; do
    job=${name%%.*} cell=-
    case "$name" in *.*) cell=${name#*.} ;; esac
    f="$d/lists/$name.txt" head=''
    if [ -f "$f" ]; then IFS= read -r head < "$f" || true; fi
    # A list is whole when its rows are as many of each kind as its header counted and its last line is
    # ended: one cut short in its download, a row or part of one, would pass for a job that read less. And
    # when it left no path out: reads.sh counts in odd= the paths it could not write, a tab or a newline in
    # their names, and a list with one says less than its job read.
    re="^# reads v1 job=$job cell=$cell commit=([0-9a-f]{40}) status=success sight=ok files=([0-9]+) dirs=([0-9]+) gone=([0-9]+) odd=0$"
    if [[ "$head" =~ $re ]] && [ "${BASH_REMATCH[2]} ${BASH_REMATCH[3]} ${BASH_REMATCH[4]}" = "$(awk -F '\t' 'NR > 1 { n[$1]++ } END { print n["f"] + 0, n["d"] + 0, n["g"] + 0 }' "$f")" ] && [ -z "$(tail -c 1 "$f")" ]; then
      if [ -n "$x" ] && [ "$x" != "${BASH_REMATCH[1]}" ]; then no_map "main's lists of what its jobs read are of more than one commit"; return; fi
      x=${BASH_REMATCH[1]}
      sed 1d "$f" >> "$d/rows.$job"
      case " $jobs " in *" $job "*) ;; *) jobs="$jobs $job" ;; esac
    else
      bad="$bad $job"
      case " ${only:-$job} " in *" $job "*) echo "changes.sh: $job runs: its list $name is not here, is not whole, or is not one a passing job with sight wrote" >&2 ;; esac
    fi
  done
  for job in $jobs; do case " $bad " in *" $job "*) ;; *) ok="$ok $job" ;; esac; done
  if [ -z "$ok" ]; then no_map "no list of what main's jobs read to skip by"; return; fi
  # X is the base's tip unless main has run since: fetched alone then, one commit deep where the clone is
  # shallow already (the changes job's) and whole where it is not, so no full clone is left shallow. Asked
  # after with lazy fetching off: the job's clone is a partial one, and git would answer for a commit it
  # lacks by fetching it with every commit and tree behind it, 12 MB and no time limit (review pass 1).
  if ! GIT_NO_LAZY_FETCH=1 git cat-file -e "$x^{commit}" 2> /dev/null; then
    f=''
    if [ "$(git rev-parse --is-shallow-repository 2> /dev/null)" = true ]; then f=--depth=1; fi
    # shellcheck disable=SC2086 # $f is one flag or none
    if ! limit 30 git fetch -q --no-tags $f origin "$x" > /dev/null 2>&1 || ! GIT_NO_LAZY_FETCH=1 git cat-file -e "$x^{commit}" 2> /dev/null; then
      no_map "main's jobs read at ${x:0:12}, which is not here to compare with"; return
    fi
  fi
  if ! git diff --raw -z --no-renames --no-abbrev "$x" HEAD > "$d/raw" 2> /dev/null \
    || ! git ls-tree -r -d --name-only -z "$x" 2> /dev/null | tr '\0' '\n' > "$d/xdirs" \
    || ! git ls-tree -r -d --name-only -z HEAD 2> /dev/null | tr '\0' '\n' > "$d/hdirs"; then
    no_map "what differs since ${x:0:12} could not be read"; return
  fi
  : > "$d/changes"
  while IFS= read -r -d '' meta; do
    if ! IFS= read -r -d '' p; then no_map "a change record since ${x:0:12} has no path after it"; return; fi
    n=$((n + 1))
    case " ${meta#:} " in
      *' 120000 '* | *' 160000 '*) no_map "a symlink or a submodule differs since ${x:0:12}"; return ;;
    esac
    case "$p" in
      *[[:cntrl:]]*) no_map "a path with a control character differs since ${x:0:12}"; return ;;
    esac
    read -r oldmode newmode _ _ s <<< "${meta#:}"
    # M: its bytes alone; C: its mode too, which a job can ask after unopened, as it can a path's being there.
    case "$s" in
      A | D) ;;
      *) if [ "$oldmode" = "$newmode" ]; then s=M; else s=C; fi ;;
    esac
    printf '%s\t%s\n' "$s" "$p" >> "$d/changes"
    if [ "$p" = "$WORKFLOW" ]; then wf=1; fi
    case " $HOLDS_THE_CUT " in *" $p "*) held=$p ;; esac
    if j=$(charges "$p"); then charged="$charged $j"; fi
  done < "$d/raw"
  # The workflow is outside the job's sparse cone, a blob fetched when it is read: bounded, as the lists are.
  if ! limit 15 git show "HEAD:$WORKFLOW" > "$d/head.yml" 2> /dev/null || ! cut_blocks "$d/head.yml" "$d/head" 2> /dev/null; then
    no_map "$WORKFLOW could not be read by job"; return
  fi
  if [ "$wf" = 1 ]; then
    if [ -n "$held" ]; then no_map "$WORKFLOW differs since ${x:0:12} beside $held, which holds how it is read by job"; return; fi
    if ! limit 15 git show "$x:$WORKFLOW" > "$d/base.yml" 2> /dev/null || ! cut_blocks "$d/base.yml" "$d/base" 2> /dev/null; then
      no_map "$WORKFLOW at ${x:0:12} could not be read by job"; return
    fi
    changed=$(changed_ids "$d")
    case " $changed " in
      *' .top '*) no_map "$WORKFLOW differs outside its jobs since ${x:0:12}"; return ;;
    esac
    for id in $RUN_ALL_JOBS; do
      case " $changed " in *" $id "*) no_map "$WORKFLOW's job $id, which every skip relies on, differs since ${x:0:12}"; return ;; esac
    done
  fi
  for job in $ok; do
    case " ${only:-$job} " in *" $job "*) ;; *) continue ;; esac
    hit=''
    case " $changed " in *" $job "*) hit="its block of $WORKFLOW differs" ;; esac
    case " $charged " in *" $job "*) hit=${hit:-a path CHARGES gives it differs} ;; esac
    if [ -z "$hit" ] && { [ ! -f "$d/head/$job" ] || ! grep -qF "' $job '" "$d/head/$job" || ! grep -qF 'needs.changes.outputs.skip' "$d/head/$job"; }; then hit='it holds no gate on skip'; fi
    if [ -z "$hit" ]; then
      hit=$(awk -F '\t' -v rows="$d/rows.$job" -v xd="$d/xdirs" -v hd="$d/hdirs" -v looked="$MAP_LOOKED_FOR" '
        function dirname(p,   i) { i = match(p, /\/[^\/]*$/); return i ? substr(p, 1, i - 1) : "" }
        function basename(p) { sub(/^.*\//, "", p); return p }
        function shown(q) { return q == "" ? "the top folder" : q "/" }
        BEGIN {
          while ((getline line < xd) > 0) xdirs[line] = 1
          while ((getline line < hd) > 0) hdirs[line] = 1
          while ((r = (getline line < rows)) > 0) {
            kind = substr(line, 1, 1); p = substr(line, 3)
            if (kind == "d") { sub(/\/$/, "", p); if (p == ".") p = ""; listed[p] = 1; continue }
            opened[p] = 1; q = dirname(p); worked[q] = 1
            for (;;) { above[q] = 1; if (q == "") break; q = dirname(q) }
          }
          if (r < 0) { print "its list could not be read"; exit }
          n = split(looked, name, " "); for (i = 1; i <= n; i++) lookedfor[name[i]] = 1
        }
        {
          s = $1; p = substr($0, 3)
          if (s != "A" && (p in opened)) { print "it read " p ", which differs"; exit }
          q = dirname(p); b = basename(p)
          if (b == ".gitattributes" && (q in above)) { print p " sets how the files it read are checked out, and differs"; exit }
          if (s == "M") next
          if (((b in lookedfor) || b ~ /^\.env(\..*)?$/) && (q in above)) { print p " is looked for above files it read"; exit }
          for (stem = b; match(stem, /\.[^.]*$/); ) {
            stem = substr(stem, 1, RSTART - 1)
            if (stem != "" && (((q == "" ? "" : q "/") stem) in above)) { print p " came or went beside " shown((q == "" ? "" : q "/") stem) ", a folder it read through"; exit }
          }
          for (;;) {
            if (q in listed) { print "it listed " shown(q) ", where " p " came, went or changed mode"; exit }
            if (q in worked) { print "it read files in " shown(q) ", where " p " came, went or changed mode"; exit }
            if (q == "" || (s == "A" ? (q in xdirs) : (q in hdirs))) break
            q = dirname(q)
          }
        }' "$d/changes" 2> /dev/null) || hit=${hit:-its list could not be set against the change}
    fi
    if [ -z "$hit" ]; then skip="$skip $job"; else echo "changes.sh: $job runs: $hit" >&2; fi
  done
  skip=${skip# }
  if [ -n "$only" ]; then
    printf 'true\t%s\t%s; of those CHARGES leaves %s to what it read on main at %s, and job(s) %s read nothing among the %s path(s) that differ since\n' "$skip" "$why" "$only" "${x:0:12}" "${skip:-none}" "$n"
  else
    printf 'true\t%s\t%s; of what main'"'"'s jobs read at %s, job(s) %s read nothing among the %s path(s) that differ since\n' "$skip" "$why" "${x:0:12}" "${skip:-none}" "$n"
  fi
  rm -rf "$d"
}

# answer EVENT BASE_REF DEFAULT_BRANCH, in a checkout: prints
# "true|false<TAB>skip<TAB>why", skip empty but when by_job or by_map fills it.
answer() {
  local event=$1 base=$2 default=$3 changed result rest jobs j marked='' first mapped why
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
  if [ "${result%%$'\t'*}" = partial ]; then
    rest=${result#partial$'\t'}
    jobs=${rest#*$'\t'}; jobs=${jobs%%$'\t'*}
    # The jobs a row marked `:list` and none charged outright: by_job has them run, and by_map may clear them by their lists.
    for j in $jobs; do
      case "$j" in *:list) case " $jobs " in *" ${j%:list} "*) ;; *) marked="$marked ${j%:list}" ;; esac ;; esac
    done
    first=$(by_job "${rest%%$'\t'*}" "$jobs")
    if [ -z "$marked" ]; then printf '%s\n' "$first"; return; fi
    rest=${first#*$'\t'}
    mapped=$(by_map "${rest#*$'\t'}" "$default" "${marked# }")
    mapped=${mapped#*$'\t'}
    # shellcheck disable=SC2086 # split on purpose: one job a line
    jobs=$(printf '%s\n' ${rest%%$'\t'*} ${mapped%%$'\t'*} | sort -u | tr '\n' ' ')
    jobs=${jobs# }
    printf 'true\t%s\t%s\n' "${jobs% }" "${mapped#*$'\t'}"; return
  fi
  if [ "${result%%$'\t'*}" = true ] && [ "${result##*$'\t'}" = map ]; then
    why=${result#true$'\t'}
    by_map "${why%$'\t'map}" "$default"; return
  fi
  printf '%s\t\t%s\n' "${result%%$'\t'*}" "${result#*$'\t'}"
}

self_check() {
  local dir fails=0 expect event got v
  # The caller's, under which a case that expects no lists would fetch main's, or read another's, and
  # every case's answer would go on the run's own summary page (79 lines of them, on repo-consistency's).
  unset GH_TOKEN READS_MAP_DIR GITHUB_STEP_SUMMARY
  # git exports GIT_DIR and its like to whatever it runs, a hook above all, and
  # under them the scratch repository's commits would land on the caller's
  # branch (reads.sh's self-check has a case for its own; SMD-2435 PR 3b-1).
  for v in $(git rev-parse --local-env-vars); do unset "$v"; done
  # With none, the cases below would work at the filesystem's root: `rm -rf /repo`.
  dir=$(mktemp -d) || { echo "changes.sh: no scratch directory" >&2; return 1; }
  # check EXPECT EVENT PATH...: decide on the paths as a pull request's
  # change, each a regular file's edit (OLDMODE=… and MODE=… set its modes).
  check() {
    local p whole jobs
    expect=$1 event=$2; shift 2
    : > "$dir/c"
    for p in "$@"; do printf ':%s %s 0000000 0000000 M\0%s\0' "${OLDMODE:-100644}" "${MODE:-100644}" "$p" >> "$dir/c"; done
    whole=$(decide "$event" "$dir/c"); got=${whole%%$'\t'*}
    if [ "$got" != "$expect" ]; then echo "changes.sh: $event $* is code=$got, not $expect" >&2; fails=$((fails + 1)); fi
    # CHARGED=…: the jobs a partial answer's paths charge (its third field).
    if [ -n "${CHARGED+set}" ] && [ "$got" = partial ]; then
      jobs=${whole#partial$'\t'*$'\t'}; jobs=${jobs%%$'\t'*}
      if [ "$jobs" != "$CHARGED" ]; then echo "changes.sh: $event $* charges '$jobs', not '$CHARGED'" >&2; fails=$((fails + 1)); fi
    fi
  }
  check false pull_request docs/01-getting-started.md
  check false pull_request README.md recipes/x/README.md "docs/a b.md" docs/img/shot.png docs/diagram.svg
  check false pull_request db/README.md
  CHARGED='db-schema:list deploy-stack' check partial pull_request changes/smd-1.md
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
  CHARGED='' check partial pull_request .github/ci/changes.sh
  check true pull_request .github/ci/new-step.sh
  check true pull_request "$(printf 'docs/a\nserver-portable/x.ts')"
  check true pull_request
  check true push docs/a.md
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
  CHARGED='' check partial pull_request .github/workflows/brain-checks.yml
  CHARGED='' check partial pull_request docs/a.md .github/workflows/brain-checks.yml README.md
  check true pull_request .github/workflows/brain-checks.yml server-portable/api.ts
  OLDMODE=000000 check true pull_request .github/workflows/brain-checks.yml
  MODE=000000 check true pull_request .github/workflows/brain-checks.yml
  MODE=100755 check true pull_request .github/workflows/brain-checks.yml
  MODE=120000 check true pull_request .github/workflows/brain-checks.yml
  # The CHARGES map (PR 3a): each path charges its jobs, together the union; a path off the map runs every job.
  CHARGED=data-layer check partial pull_request scripts/check-consistency.ts
  CHARGED='deploy-stack deploy-stack-auth deploy-stack-brains deploy-stack-observability' check partial pull_request .github/ci/full-stack-up.sh
  CHARGED='db-schema:list deploy-stack portable-server' check partial pull_request changes/smd-1.md .github/ci/typecheck.sh docs/a.md
  CHARGED='db-schema:list deploy-stack' check partial pull_request changes/smd-1.md .github/workflows/brain-checks.yml
  check true pull_request changes/smd-1.md server-portable/api.ts
  check true pull_request scripts/check-consistency.ts .github/workflows/brain-checks.yml
  check true pull_request .github/ci/changes.sh .github/workflows/brain-checks.yml
  CHARGED='' check partial pull_request .github/workflows/release.yml
  check true pull_request .github/workflows/other.yml
  # Two names where a record and its path should be (--name-only's shape, or a rename's third field): code.
  printf 'docs/a.md\0docs/b.md\0' > "$dir/c"; got=$(decide pull_request "$dir/c"); got=${got%%$'\t'*}
  if [ "$got" != true ]; then echo "changes.sh: a record not in --raw form is code=$got, not true" >&2; fails=$((fails + 1)); fi
  # The run itself, in scratch repositories shaped as a pull request's
  # checkout: a merge commit whose first parent is the base, moved after the
  # branch, and whose second is the pull request's head. Each must write one
  # code= line, and the right one.
  local repo="$dir/repo" out="$dir/out" lines
  # Under no setting of the caller's that could stop a scratch commit: a signature asked of every commit, a hook.
  g() { git -c user.email=ci@example.invalid -c user.name=ci -c init.defaultBranch=main -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }
  # run EXPECT EVENT BASE OPS: OPS on a branch, main moved (MAIN_OPS=… beside its docs file), merged --no-ff, then the run.
  run() {
    expect=$1 event=$2 base=$3 ops=$4
    rm -rf "$repo"; mkdir -p "$repo"
    if ! (cd "$repo" && g init -q && mkdir -p docs server-portable && echo b > docs/a.md && echo b > server-portable/api.ts \
        && eval "${BASE_OPS:-:}" && g add -A && g commit -qm base && g switch -qc pr && eval "$ops" && g add -A && g commit -qm pr \
        && g switch -q main && echo m > docs/main.md && eval "${MAIN_OPS:-:}" && g add -A && g commit -qm main && g merge -q --no-ff -m merge pr) > /dev/null 2>&1; then
      echo "changes.sh: could not make the scratch repository for: $ops" >&2; fails=$((fails + 1)); return
    fi
    : > "$out"
    # LISTS=…: main's lists for the run, written by list and live (below) in the merged checkout.
    rm -rf "$dir/map"
    if [ -n "${LISTS:-}" ]; then
      mkdir "$dir/map"
      if ! (cd "$repo" && eval "$LISTS") > /dev/null 2>&1; then echo "changes.sh: could not write the lists for: $ops" >&2; fails=$((fails + 1)); return; fi
    fi
    (cd "$repo" && GITHUB_OUTPUT="$out" READS_MAP_DIR="${LISTS:+$dir/map}" bash "$SELF" "$event" "$base" main) > /dev/null 2>&1
    lines=$(grep -c '^code=' "$out"); got=$(sed -n 's/^code=//p' "$out")
    if [ "$lines" != 1 ] || [ "$got" != "$expect" ]; then echo "changes.sh: the run for $event into $base after '$ops' wrote code=$(tr '\n' ',' <<<"$got") ($lines line(s)), not $expect" >&2; fails=$((fails + 1)); fi
    got=$(sed -n 's/^skip=//p' "$out")
    if [ "$(grep -c '^skip=' "$out")" != 1 ] || [ "$got" != "${SKIP:-}" ]; then echo "changes.sh: the run for $event into $base after '$ops' wrote skip=$(tr '\n' ',' <<<"$got"), not '${SKIP:-}'" >&2; fails=$((fails + 1)); fi
  }
  # A workflow for the by-job runs: the changes job, three gated jobs (g, h
  # with a heading of its own, and data-layer, which CHARGES names), and r,
  # which nothing gates.
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
  data-layer:
    needs: changes
    if: ${{ !cancelled() && (needs.changes.result != 'success' || (needs.changes.outputs.code != 'false' && !contains(format(' {0} ', needs.changes.outputs.skip), ' data-layer '))) }}
    steps:
      - run: echo data-layer
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
  add_gated() { awk 'p && /^  [a-z]/ { p = 0 } /^  h:/ { p = 1 } p' "$WF" | sed "s/^  h:/  n:/; s/' h '/' n '/; s/echo h/echo n/" > "$WF.n" && cat "$WF.n" >> "$WF" && rm -f "$WF.n"; }
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
    BASE_OPS=$wfb SKIP='data-layer h' run true pull_request main 'sub "echo g" "echo g2"'
    BASE_OPS=$wfb SKIP='data-layer g h' run true pull_request main 'sub "echo r" "echo r2"'
    BASE_OPS=$wfb SKIP='data-layer h' run true pull_request main 'sub "echo g" "echo g2"; echo x >> docs/a.md'
    # shellcheck disable=SC2016 # as above: $WF expands when run() evals the case
    BASE_OPS=$wfb SKIP='data-layer g h' run true pull_request main 'printf "  n:\n    steps:\n      - run: echo n\n" >> "$WF"'
    # A gated job added runs on the pull request that adds it (review pass 2: the head's side of the compare).
    BASE_OPS=$wfb SKIP='data-layer g h' run true pull_request main 'add_gated'
    BASE_OPS=$wfb run true pull_request main 'sub "bun scripts" "bun  scripts"'
    BASE_OPS=$wfb SKIP='data-layer g' run true pull_request main "sub \"h's heading\" \"h's heading, reworded\""
    BASE_OPS=$wfb run true pull_request main 'sub "name: f" "name: f2"'
    BASE_OPS=$wfb run true pull_request main 'sub "runs-on: x" "runs-on: y"'
    BASE_OPS=$wfb run true pull_request main "sub \"changes' heading\" \"changes' heading, reworded\""
    BASE_OPS=$wfb run true pull_request main 'sub "echo g" "echo g2"; echo x >> server-portable/api.ts'
    BASE_OPS=$wfb run true pull_request main 'sub "  r:" "  - r:"'
    BASE_OPS=$wfb run true pull_request feature 'sub "echo g" "echo g2"'
    BASE_OPS=$wfb run true push main 'sub "echo g" "echo g2"'
    # The CHARGES map (PR 3a): a record charges deploy-stack and db-schema (neither here), the checker data-layer; off the map, every job.
    BASE_OPS=$wfb SKIP='data-layer g h' run true pull_request main 'mkdir -p changes && echo x > changes/smd-1.md'
    BASE_OPS=$wfb SKIP='g h' run true pull_request main 'mkdir -p scripts && echo x > scripts/check-consistency.ts'
    BASE_OPS=$wfb SKIP='data-layer g h' run true pull_request main 'mkdir -p .github/workflows && echo x > .github/workflows/release.yml'
    BASE_OPS=$wfb SKIP='data-layer h' run true pull_request main 'mkdir -p changes && echo x > changes/smd-1.md; sub "echo g" "echo g2"'
    BASE_OPS=$wfb run true pull_request main 'mkdir -p changes && echo x > changes/smd-1.md; echo x >> server-portable/api.ts'
    BASE_OPS=$wfb run true pull_request main 'mkdir -p scripts && echo x > scripts/check-consistency.ts; sub "echo g" "echo g2"'
    # The record of main's reads (PR 3b-2): a path off every list above runs the jobs that read something
    # that differs, and skips the mapped jobs that did not. The workflow here gates g, which no list
    # names, and three MAP_LISTS does: data-layer, db-schema and db-live, a matrix job of six lists.
    {
      printf 'name: f\non: push\njobs:\n  changes:\n    runs-on: x\n'
      for v in g data-layer db-schema db-live; do
        printf "  %s:\n    needs: changes\n    if: \${{ !cancelled() && (needs.changes.result != 'success' || (needs.changes.outputs.code != 'false' && !contains(format(' {0} ', needs.changes.outputs.skip), ' %s '))) }}\n    steps:\n      - run: echo %s\n" "$v" "$v" "$v"
      done
      printf '  repo-consistency:\n    steps:\n      - run: bun scripts/check-consistency.ts\n'
    } > "$dir/wfm.yml"
    # list NAME ROW...: NAME's list, each ROW "f path", "d folder/" or "g path", recorded at AT (HEAD^1, the
    # base's tip, unless set); STATUS, SIGHT, COMMIT, AS (the job its header names), FILES (the files its
    # header counts, where not its rows') and ODD (the paths it left out) say otherwise.
    # shellcheck disable=SC2317,SC2329 # called from the cases' LISTS, which run() evals
    list() {
      local name=$1 cell=- row; shift
      case "$name" in *.*) cell=${name#*.} ;; esac
      local nf=0 nd=0 ng=0
      for row in "$@"; do case "$row" in f\ *) nf=$((nf + 1)) ;; d\ *) nd=$((nd + 1)) ;; g\ *) ng=$((ng + 1)) ;; esac; done
      {
        printf '# reads v1 job=%s cell=%s commit=%s status=%s sight=%s files=%s dirs=%s gone=%s odd=%s\n' "${AS:-${name%%.*}}" "$cell" "${COMMIT:-$(git rev-parse "${AT:-HEAD^1}")}" "${STATUS:-success}" "${SIGHT:-ok}" "${FILES:-$nf}" "$nd" "$ng" "${ODD:-0}"
        for row in "$@"; do printf '%s\t%s\n' "${row%% *}" "${row#* }"; done
      } > "$dir/map/$name.txt"
    }
    # live ROW...: db-live's six lists, each of the rows.
    # shellcheck disable=SC2317,SC2329 # as list
    live() { local c; for c in rest sleep long extract sweep claims; do list "db-live.$c" "$@"; done; }
    # The base: data-layer read server-portable/api.ts and ext/x.ts and listed ext/; db-schema read the one
    # migration and listed its folder; each db-live cell read db/a.ts. No one read db/tool.sh.
    # shellcheck disable=SC2016 # run() evals it in the scratch repository, where $dir and $WF expand
    local mb='mkdir -p .github/workflows db/migrations ext && cp "$dir/wfm.yml" "$WF" && echo a > db/a.ts && echo t > db/tool.sh && echo m > db/migrations/1.sql && echo x > ext/x.ts'
    local std='list data-layer "f server-portable/api.ts" "f ext/x.ts" "d ext/"; list db-schema "f db/migrations/1.sql" "d db/migrations/"; live "f db/a.ts"'
    # A file no job read: the three skip. One job's file: the other two skip. With no lists, none.
    BASE_OPS=$mb LISTS=$std SKIP='db-schema data-layer db-live' run true pull_request main 'echo x >> db/tool.sh'
    BASE_OPS=$mb LISTS=$std SKIP='db-schema db-live' run true pull_request main 'echo x >> server-portable/api.ts'
    BASE_OPS=$mb LISTS=$std SKIP='db-schema data-layer' run true pull_request main 'echo x >> db/a.ts'
    BASE_OPS=$mb run true pull_request main 'echo x >> db/tool.sh'
    BASE_OPS=$mb LISTS=: run true pull_request main 'echo x >> db/tool.sh'
    # Docs alone are code=false still. A record alone charges deploy-stack (no job here) and db-schema, marked `:list`
    # in CHARGES: charged with no lists, cleared by a list that holds nothing of changes/, and kept by one that listed it.
    BASE_OPS=$mb LISTS=$std run false pull_request main 'echo x >> docs/a.md'
    BASE_OPS=$mb SKIP='data-layer db-live g' run true pull_request main 'mkdir -p changes && echo x > changes/smd-1.md'
    BASE_OPS=$mb LISTS=$std SKIP='data-layer db-live db-schema g' run true pull_request main 'mkdir -p changes && echo x > changes/smd-1.md'
    BASE_OPS="$mb && mkdir -p changes && echo o > changes/smd-0.md" LISTS="$std; list db-schema 'f db/migrations/1.sql' 'd db/migrations/' 'd changes/'" SKIP='data-layer db-live g' run true pull_request main 'echo x > changes/smd-1.md'
    BASE_OPS=$mb LISTS="$std; STATUS=failure list db-schema" SKIP='data-layer db-live g' run true pull_request main 'mkdir -p changes && echo x > changes/smd-1.md'
    # A file at the top named as a job and one more character is no job: the names are read as written.
    BASE_OPS="$mb && echo x > db-schemaX && echo x > 'db-schema:list'" SKIP='data-layer db-live g' run true pull_request main 'mkdir -p changes && echo x > changes/smd-1.md'
    # …and a record beside a workflow edit: the job the edit reaches runs, the marked one is its list's.
    BASE_OPS=$mb LISTS=$std SKIP='data-layer db-live db-schema' run true pull_request main 'mkdir -p changes && echo x > changes/smd-1.md; sub "echo g" "echo g2"'
    BASE_OPS=$mb LISTS=$std SKIP='data-layer db-live g' run true pull_request main 'mkdir -p changes && echo x > changes/smd-1.md; sub "echo db-schema" "echo db-schema2"'
    # A list a job did not vouch for skips nothing of that job: one that failed, one blind, one of a matrix
    # job's missing, one whose header names another job.
    BASE_OPS=$mb LISTS="$std; STATUS=failure list db-schema" SKIP='data-layer db-live' run true pull_request main 'echo x >> db/tool.sh'
    BASE_OPS=$mb LISTS="$std; SIGHT=blind list db-live.rest" SKIP='db-schema data-layer' run true pull_request main 'echo x >> db/tool.sh'
    # shellcheck disable=SC2016 # as above
    BASE_OPS=$mb LISTS="$std"'; rm "$dir/map/db-live.sweep.txt"' SKIP='db-schema data-layer' run true pull_request main 'echo x >> db/tool.sh'
    BASE_OPS=$mb LISTS="$std; AS=data-layer list db-schema" SKIP='data-layer db-live' run true pull_request main 'echo x >> db/tool.sh'
    # …nor does one cut short: a header that counts two files over one row.
    BASE_OPS=$mb LISTS="$std; FILES=2 list db-schema 'f db/migrations/1.sql'" SKIP='data-layer db-live' run true pull_request main 'echo x >> db/tool.sh'
    BASE_OPS=$mb LISTS="$std; ODD=1 list db-schema 'f db/migrations/1.sql' 'd db/migrations/'" SKIP='data-layer db-live' run true pull_request main 'echo x >> db/tool.sh'
    # …nor one whose header ends in the word of a watch (reads.sh mark --watch, PR 3c-1), lost or ok: no job here
    # watches, and by_map reads no such word until PR 3c-2 has it ask ok of the jobs that do, by name.
    BASE_OPS=$mb LISTS="$std; ODD='0 watch=lost' list db-schema 'f db/migrations/1.sql' 'd db/migrations/'" SKIP='data-layer db-live' run true pull_request main 'echo x >> db/tool.sh'
    BASE_OPS=$mb LISTS="$std; ODD='0 watch=ok' list db-schema 'f db/migrations/1.sql' 'd db/migrations/'" SKIP='data-layer db-live' run true pull_request main 'echo x >> db/tool.sh'
    # shellcheck disable=SC2016 # as above
    BASE_OPS=$mb LISTS="$std"'; printf %s "$(cat "$dir/map/data-layer.txt")" > "$dir/map/cut" && mv "$dir/map/cut" "$dir/map/data-layer.txt"' SKIP='db-schema db-live' run true pull_request main 'echo x >> db/tool.sh'
    # Lists of two commits, or of one that is not here, skip nothing at all.
    BASE_OPS=$mb LISTS="$std; AT=HEAD^1~1 list db-schema" run true pull_request main 'echo x >> db/tool.sh'
    BASE_OPS=$mb LISTS="COMMIT=0123456789012345678901234567890123456789; $std" run true pull_request main 'echo x >> db/tool.sh'
    # What counts is everything since the lists' commit: recorded one commit before the base's tip, a job
    # that listed docs/ runs for main's own docs/main.md, which the pull request never touched.
    BASE_OPS=$mb LISTS="$std; list db-schema 'd docs/'" SKIP='db-schema data-layer db-live' run true pull_request main 'echo x >> db/tool.sh'
    BASE_OPS=$mb LISTS="AT=HEAD^1~1; $std; list db-schema 'd docs/'" SKIP='data-layer db-live' run true pull_request main 'echo x >> db/tool.sh'
    # A path that comes or goes: in a folder a job listed; in one it read a file in; in a new folder under
    # one; a file gone that it read, as a row of either kind; the last file of a folder, up to where it worked.
    BASE_OPS=$mb LISTS=$std SKIP='data-layer db-live' run true pull_request main 'echo n > db/migrations/2.sql'
    BASE_OPS=$mb LISTS=$std SKIP='db-schema data-layer' run true pull_request main 'echo n > db/b.ts'
    BASE_OPS=$mb LISTS=$std SKIP='db-schema data-layer' run true pull_request main 'mkdir db/new && echo n > db/new/f.ts'
    BASE_OPS=$mb LISTS=$std SKIP='db-schema db-live' run true pull_request main 'git rm -q ext/x.ts'
    BASE_OPS=$mb LISTS="$std; list data-layer 'g ext/x.ts'" SKIP='db-schema db-live' run true pull_request main 'git rm -q ext/x.ts'
    BASE_OPS=$mb LISTS=$std SKIP='data-layer' run true pull_request main 'git rm -q db/migrations/1.sql'
    # A mode alone: no one read db/tool.sh, and db-live, at work in db/, could have asked whether it runs.
    BASE_OPS=$mb LISTS=$std SKIP='db-schema data-layer' run true pull_request main 'chmod +x db/tool.sh'
    # A name tools look for, added above a file read: db-schema's migration is under db/, where db-live works too.
    BASE_OPS=$mb LISTS=$std SKIP='data-layer' run true pull_request main 'echo "{}" > db/package.json'
    BASE_OPS=$mb LISTS=$std run true pull_request main 'echo "{}" > tsconfig.json'
    BASE_OPS=$mb LISTS=$std SKIP='data-layer' run true pull_request main 'echo A=1 > db/.env.test'
    BASE_OPS=$mb LISTS=$std SKIP='db-schema data-layer' run true pull_request main 'echo A=1 > db/env.txt'
    # A .gitattributes above a file read, edited: it sets that file's bytes, and no list could hold it.
    BASE_OPS="$mb && echo '*.md text' > db/.gitattributes" LISTS=$std SKIP='data-layer' run true pull_request main 'echo "*.sql text eol=crlf" >> db/.gitattributes'
    BASE_OPS="$mb && echo '*.md text' > docs/.gitattributes" LISTS=$std SKIP='db-schema data-layer db-live' run true pull_request main 'echo "*.txt text" >> docs/.gitattributes'
    # A file named for a folder a job read through: an import of the folder would find the file first.
    BASE_OPS="$mb && mkdir -p lib/core && echo c > lib/core/index.ts" LISTS="$std; list db-schema 'f db/migrations/1.sql' 'd db/migrations/' 'f lib/core/index.ts'" SKIP='data-layer db-live' run true pull_request main 'echo c > lib/core.ts'
    BASE_OPS="$mb && mkdir -p lib/core && echo c > lib/core/index.ts" LISTS="$std; list db-schema 'f db/migrations/1.sql' 'd db/migrations/' 'f lib/core/index.ts'" SKIP='db-schema data-layer db-live' run true pull_request main 'echo c > lib/other.ts'
    BASE_OPS="$mb && mkdir -p lib/core.v2 && echo c > lib/core.v2/index.ts" LISTS="$std; list db-schema 'f db/migrations/1.sql' 'd db/migrations/' 'f lib/core.v2/index.ts'" SKIP='data-layer db-live' run true pull_request main 'echo c > lib/core.v2.d.ts'
    # The workflow since then: a job's own block, a path CHARGES gives a job, and what stops every skip.
    BASE_OPS=$mb LISTS=$std SKIP='data-layer db-live' run true pull_request main 'echo x >> db/tool.sh; sub "echo db-schema" "echo db-schema2"'
    BASE_OPS=$mb LISTS=$std SKIP='db-schema db-live' run true pull_request main 'echo x >> db/tool.sh; mkdir -p scripts && echo x > scripts/check-consistency.ts'
    BASE_OPS=$mb LISTS=$std SKIP='db-schema data-layer db-live' run true pull_request main 'echo x >> db/tool.sh; mkdir -p changes && echo x > changes/smd-1.md'
    BASE_OPS=$mb LISTS=$std run true pull_request main 'echo x >> db/tool.sh; sub "name: f" "name: f2"'
    BASE_OPS=$mb LISTS=$std run true pull_request main 'echo x >> db/tool.sh; sub "runs-on: x" "runs-on: y"'
    BASE_OPS=$mb LISTS=$std run true pull_request main 'echo x >> db/tool.sh; sub "echo g" "echo g2"; mkdir -p scripts && echo x > scripts/check-consistency.ts'
    # A mapped job with no gate of its own on skip is not named, whatever it read.
    BASE_OPS="$mb && sed -i.bak \"/' db-schema '/d\" \"\$WF\" && rm -f \"\$WF.bak\"" LISTS=$std SKIP='data-layer db-live' run true pull_request main 'echo x >> db/tool.sh'
    # A symlink main itself took in since the lists' commit, none of the pull request's, skips nothing.
    BASE_OPS=$mb MAIN_OPS='ln -s tool.sh db/l.sh' LISTS="AT=HEAD^1~1; $std" run true pull_request main 'echo x >> db/tool.sh'
    BASE_OPS=$mb MAIN_OPS='echo m > docs/more.md' LISTS="AT=HEAD^1~1; $std" SKIP='db-schema data-layer db-live' run true pull_request main 'echo x >> db/tool.sh'
    # A symlink, or a path with a newline in its name, runs every job, lists or no; another event has none read.
    BASE_OPS=$mb LISTS=$std run true pull_request main 'ln -s tool.sh db/link.sh'
    BASE_OPS=$mb LISTS=$std run true pull_request main "printf x > \"\$(printf 'db/x\ncode=false')\""
    BASE_OPS=$mb LISTS=$std run true push main 'echo x >> db/tool.sh'
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
# --charges: CHARGES as it stands, a pattern and its jobs a line (check 53 reads it).
if [ "${1:-}" = --charges ]; then printf '%s\n' "$CHARGES"; exit 0; fi
# --map-lists: MAP_LISTS as it stands, a list a line (check 56 reads it).
# shellcheck disable=SC2086 # split on purpose: one list a line
if [ "${1:-}" = --map-lists ]; then printf '%s\n' $MAP_LISTS; exit 0; fi
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
