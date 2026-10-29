#!/usr/bin/env bash
# Stand a canary brain beside a running stack, and take it down again (SMD-2038).
#
# The canary is this same deploy/compose.yaml run again as its own compose
# project, <stable>-canary (open-brain-canary beside the default stable;
# SMD-2873), with its own Postgres, volume, networks and
# images, OB1_TIER=canary, and two servers: the MCP server and the REST core.
# It runs on an env file of its own (SMD-2583), `.env.<canary>.local` beside
# stable's (`.env.canary.local` for open-brain-canary) unless
# --canary-env-file names another; the root .gitignore's
# `.env.*.local` ignores it in any checkout, an old release's included. `up`
# writes it the first time from stable's file as compose reads it: every
# setting, each value as compose read it, but the database password, which is
# a fresh one of the canary's, the secrets of the profiles the canary
# never runs (the authorization server's, n8n's, the import runner's, the
# workers' key), every Linear key (the canary's board-sync reads with a key of
# its own, step 6), stable's keys and the secrets that go with them,
# and the settings that make it the canary: its port, loopback as its
# address, its tier and its profiles (none), which compose is also handed in
# the shell; its own access keys, minted, and its own plugin role password
# where stable sets one (SMD-2874, SMD-3032). It refuses a stable setting that carries stable's
# database password in its value. From then on the file is the canary's: a
# change to stable's does not reach it, and `up` names the settings that
# differ (names, never values). Edit it to carry one across, or delete it to
# make it again. So the canary holds no credential to stable's database: its
# own password, and stable's (12 characters or more; a shorter one would match
# ordinary text) in none of its values, which every `up` checks. The
# database password comes from that file alone: one set only in the shell is
# unset here, since compose would let it win.
#
# Its keys are its own (SMD-2874): MCP_ACCESS_KEYS holds a write key `up`
# mints, named for the canary's project, and none of stable's, so no key of
# stable's opens it and its key opens nothing of stable's. The raw key is the
# file's OB1_CANARY_KEY, which `up` smokes and registers the connector with,
# and which no container is handed. Beside it `up` mints a forward key, named
# <project>-mcp-forwarder, its raw key in OB1_FORWARDER_KEY: the MCP server's own
# for its calls on the REST core (SMD-2287), which grants nothing as a caller.
# Mint another for a client with
# server-portable/keygen.ts and add its line to the file's MCP_ACCESS_KEYS. A
# file made before this holds stable's keys: `up` takes them out, mints the
# canary's, clears a raw key or webhook secret of stable's, and gives the
# plugin role a password of its own, and says so. A refresh copies stable's
# ob1_agents and ob1_agent_keys rows, which grant nothing: a key is accepted
# by MCP_ACCESS_KEYS alone, and those rows can only refuse one.
# `down` acts on the canary's project alone, so it cannot reach stable.
# SMD-1806 calls the running stack stable, the record the canary is
# refreshed from.
#
# Where it answers (SMD-2874): at /mcp behind a proxy of its own, on
# 127.0.0.1 and a port of its own, as any brain does on its own port
# (docs/one-brain-per-stack.md). Its networks are its own project's; it joins
# none of stable's. The port is --port, which the first `up` needs, and from
# then on the canary's env file's SERVER_PORT: a --port that differs is
# written to the file (deploy/env-file.ts: its old line removed, the new one
# at the file's end), read back through compose.
# A canary stood up at /canary/mcp on stable's origin, its servers on stable's
# mesh (SMD-2294 to SMD-2874), moves to its port at its next `up --port N`:
# its servers are recreated on its own networks alone, on the same volume, and
# its env file, which held stable's port, address, tier and profiles, takes
# the canary's own the same way. A connector left at /canary/mcp is stable's
# URL: `up` names it, `up --connect` refuses to replace it, `down` leaves it.
#
#   deploy/canary.sh --env-file ~/stack/deploy/.env --port 8011 up --connect
#   deploy/canary.sh --env-file ~/stack/deploy/.env up
#   deploy/canary.sh --env-file ~/stack/deploy/.env down --volumes
#
# `up` stands the canary up, or brings a standing one level with stable again
# (after stable is redeployed, say). It can be re-run:
#   1. refuses, before changing anything, when:
#      - the canary's servers could not reach their provider: an OB1_LLM_BASE_URL,
#        OB1_CHAT_BASE_URL or OB1_JEV_BASE_URL naming a service on stable's
#        `egress` network (`ollama`, `jev`, from a compose profile), which the
#        canary's own networks do not have;
#      - the canary has no port: no --port, and its env file is absent, made
#        before SMD-2874 (its OB1_TIER is not canary: it holds stable's tier
#        and the port stable had then), or names stable's port; or the port
#        is stable's;
#      - the port is taken, by another container or a process on the host;
#      - --connect finds another connector under the name;
#      - stable's Postgres is stamped canary or working, or carries a
#        refresh's mark (canary, working): that is a copy, not the record;
#      - stable's Postgres is on neither <stable>_data nor <stable>_default,
#        where the refresh would reach it (SMD-2583);
#      - the canary's env file, when it has one, holds no POSTGRES_PASSWORD
#        of its own (or one built from the shell, or spanning lines), or holds
#        stable's database password anywhere;
#      - the canary's env file, when this run makes it, cannot be made as
#        compose reads stable's (a value built from the shell, a byte that is
#        not UTF-8, stable's database password inside a value).
#      Stable with no tier stamp is stamped tier=stable;
#   2. makes the canary's env file if there is none (before stable's stamp,
#      so a file that cannot be made is a refusal like those above), or
#      writes to it the canary's own port, address, tier and profiles where
#      it holds others (a --port that differs, a file from before SMD-2874), its
#      own keys where it holds stable's, and clears from it a LINEAR_API_KEY
#      that is one of stable's Linear keys and every other Linear key (SMD-3312;
#      LINEAR_API_KEY set on two lines is refused), each said; and
#      starts the canary's Postgres; once its standing servers are stopped
#      (4), sets its database's password to that file's, which a canary from
#      before SMD-2583 had as stable's;
#   3. keeps the canary's database where it has one, and brings it level in
#      place: this checkout's migrate run on it, its own rows kept (SMD-3155;
#      SMD-3154 made the path, then behind --no-refresh). Since SMD-3314 a
#      canary holds rows no other brain has (its own captures, edits and
#      keys, its passes' proposals), so a plain `up` never replaces them. A
#      database there but stamped other than canary in ob1_config is refused,
#      naming --refresh: a refresh that died before its last step leaves
#      stable's copy, which an in-place migration would take for the canary.
#      Where it has none (no volume, or a running database holding no
#      relations: a first up, or one that died before its restore), or with
#      --refresh, it refreshes it from stable through deploy/tier.sh, one
#      half in a container on each project's database network alone
#      (SMD-2875):
#      stable's half on stable's — `data` (SMD-2583), or `default` for a
#      stable from before it, read off its Postgres container — with stable's
#      password alone, from stable's env file; the canary's half on the
#      canary's `data` with the canary's password alone, from its own. The
#      refresh copies stable's database settings, 014's HNSW bounds among them
#      (SMD-2037), and migrates the copy with this checkout. --no-refresh
#      keeps the database or refuses: on a canary with no database to keep it
#      is refused before anything changes, where a plain `up` would stand one
#      up from stable. Either way the canary's writers are stopped first, before its
#      Postgres is touched: its servers, and a running coordinator, which
#      comes back on the new build in step 6 (SMD-3476). A container of a
#      service the coordinator replaced (sleep, board-sync, extract,
#      consolidate), left by a canary stood up before it, is stopped and
#      removed, said; where the canary's env file names no OB1_PASSES, the
#      passes those containers were running are written there once, so the
#      coordinator runs them on. A running service of another profile (the
#      import runner, the database monitor) is refused before anything
#      changes: stop it first;
#   4. builds the server image from this checkout (as `api`) and (re)creates
#      the REST core, so its pool opens on the migrated or refreshed database. Standing servers are stopped before the change, so
#      nothing serves or writes a half-restored copy. The canary's own proxy
#      and forwarder are (re)started, its port published on loopback;
#   5. smoke-tests it with its own key, OB1_CANARY_KEY (a write key: smoke.sh
#      checks the whole tool surface, which a read key does not see). The keyed
#      /health must report tier canary, deploy/smoke.sh must pass, and
#      search_thoughts, given a thought's own text with its literals (SMD
#      keys, dates, paths) taken out so only the vector arm can match, must
#      return that thought first at 50% or more, for one of up to five
#      candidates. A canary with no thought to probe is not checked, unless
#      stable had one: then its vectors were emptied, and the smoke fails;
#   6. (re)creates the coordinator on the new build (SMD-3476), running the
#      passes the canary's env file names in OB1_PASSES — its own, never
#      stable's: the file never gets stable's — handed to compose in the
#      shell. board-sync among them keeps the canary's own copy of the
#      board: it is upgraded in place and no longer refreshed, and a refresh
#      was what brought stable's ticket rows (SMD-3312). It runs only with a
#      LINEAR_API_KEY of the canary's own, a Linear personal API key made with
#      Read access: step 2 clears stable's, and every other Linear key, where
#      the file holds one, and canary_compose holds LINEAR_COMMENT_API_KEY
#      empty besides, so a canary never posts a finding to the board. Without
#      a key of its own, board-sync is left out and the run says so. sleep or
#      the workers with no OB1_WORKER_KEY in the file are held by the
#      coordinator, running nothing, and `up` exits 1, said;
#   7. with --connect, registers the Claude Code connector (user scope) under
#      its own key, OB1_CANARY_KEY, at http://127.0.0.1:<port>/mcp; without it, names a
#      connector left at another of the canary's ports, at its port's root
#      (the proxy's 404 since v2.0.0, SMD-2532), or at /canary/mcp on
#      stable's origin.
#
# `down` removes the canary's containers and its own networks. It deregisters
# the connector when `claude` has it at user scope and at a URL of the
# canary's (a port of its proxy, on loopback), and says so when one by that
# name is anything else, leaving it alone: a connector left at /canary/mcp on
# stable's origin is stable's URL, not the canary's. An `up` on another port
# without --connect names a connector left behind.
# --volumes also deletes the canary's database: when it is stamped canary,
# marked by a refresh, or holds nothing (a first refresh that died before its
# mark); a refusal puts its Postgres back as it was. With no canary volume
# there is nothing to delete, and nothing is created to find out. Its sleep
# dumps go with it (the `sleep-dumps` volume, SMD-3203), the coordinator's,
# a default service's since SMD-3476.
# A canary proxy's port is read from the container that publishes it — its
# forwarder since SMD-2583, its proxy before — running or stopped, and from
# the canary's env file.
#
# Options, all optional but --port on the first `up` (and on one whose env
# file was made before SMD-2874):
#   --env-file PATH       the running stack's env file (default deploy/.env beside
#                         this script — which a branch worktree does not have)
#   --canary-env-file PATH  the canary's own env file (default .env.<canary>.local
#                         beside stable's, <canary> the canary's project, and
#                         .env.canary.local for open-brain-canary), made by `up`
#                         when absent; never stable's own file, by any path
#   --runtime CLI         docker or podman (default: docker when on PATH, else podman)
#   --stable-project NAME stable's compose project (default: the project stable's
#                         env file names, COMPOSE_PROJECT_NAME as compose reads
#                         it, else compose.yaml's open-brain; SMD-2873). The
#                         canary's project is <stable>-canary
#   --port N              the canary's port: its own proxy answers on
#                         127.0.0.1:N. Written to its env file as SERVER_PORT,
#                         which later runs read when --port is not given; with
#                         `down`, a port the canary was stood up on
#   --name NAME           the connector's name (default: the canary's project,
#                         open-brain-canary for the default stable)
#   names                 print stable's project, the canary's, the connector
#                         and the canary's env file, and change nothing
#   up --connect          register the connector (after the smoke, unless --no-smoke)
#   up --no-smoke         skip step 5
#   up --refresh          replace the canary's database with stable's: step
#                         3's refresh, its own rows lost (SMD-3155)
#   up --no-refresh       keep the canary's database, migrated in place, as a
#                         plain up does, and refuse where it has none to keep
#                         (SMD-3154)
#   down --volumes        delete the canary's database, and its sleep dumps, as well
#
# The server image is built from this checkout, as compose.yaml builds stable's,
# and OB1_GIT_SHA is this checkout's `git describe` unless the shell sets it.
# Exit status: 0 done; 1 a step failed (a refresh's own usage error
# included); 2 a usage error, or a refusal before anything changed; 130 a
# Ctrl-C, wherever it lands.
set -euo pipefail
unset CDPATH
# A Ctrl-C is a stop wherever it lands: bash runs on after a child that did
# not die of the signal (a docker CLI mid-startup exits 125), and a caller must
# not read an interrupted run as anything but interrupted.
trap 'exit 130' INT
# …and so are a hangup and a TERM, so the EXIT trap below runs and removes
# what is half-made: the canary's env file in the making holds stable's
# settings, its provider keys among them (review pass 1). Not left to bash's own
# handling: bash 5 skipped the EXIT trap on a hangup to the process group (a
# closed terminal) in up to 12 runs of 20 and left the finished temporary
# file, where with these traps it ran in 20 of 20 (review pass 4, measured;
# bash 3.2 ran it either way). A `kill` of this script's pid alone then waits
# for the command in hand to end, however long that is; a signal to its
# process group (a Ctrl-C at the terminal) ends that command too, at once.
trap 'exit 129' HUP
trap 'exit 143' TERM
CONFIG_ERR=""
CANARY_TMP=""
# deploy/env-file.ts writes its own temporary file beside the one it is
# given, <file>.<pid>.tmp, which no .gitignore pattern names (review pass 1).
# A run that dies after stopping the canary's writers, with no advice of its
# own (a Postgres that does not come back healthy, a build, a psql), says what
# it left stopped and how to go on, in the run's own form (SMD-3154).
WRITERS_STOPPED=""
COORD_PENDING=""
ADVISED=""
# The passes canary_compose hands the coordinator (SMD-3476): none until step 6
# sets the canary's own, so an OB1_PASSES exported in the operator's shell
# (stable's) never reaches the canary.
CANARY_PASSES=""
cleanup() {
  local rc=$?
  rm -f ${CONFIG_ERR:+"$CONFIG_ERR"} ${CANARY_TMP:+"$CANARY_TMP"}
  [ -z "$CANARY_TMP" ] || rm -f "$CANARY_TMP".*.tmp
  if [ "$rc" != 0 ] && [ -z "$ADVISED" ]; then
    # The coordinator left stopped, its board-sync with no key of the canary's own: how to give it one.
    local board_more=""
    if [ -n "$COORD_PENDING" ] && [ -n "${BOARD_NAMED:-}" ] && [ -z "${BOARD_KEY:-}" ]; then board_more=" Board-sync has no key of the canary's own to run on: ${BOARD_ADD:-}."; fi
    if [ -n "$WRITERS_STOPPED" ]; then
      local which="servers"
      [ -z "$COORD_PENDING" ] || which="servers and coordinator"
      echo "up stopped (exit $rc) with the canary's $which stopped: fix the cause above and re-run ${RERUN:-up}.$board_more" >&2
    elif [ -n "$COORD_PENDING" ]; then
      echo "up stopped (exit $rc) with the canary's coordinator stopped: fix the cause above and re-run ${RERUN:-up}, which starts it again with the canary's own passes and keys (a compose command of your own would read the shell's settings, stable's among them, over the canary's file).$board_more" >&2
    fi
  fi
  return 0
}
trap cleanup EXIT

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
# Set once stable's project is known (SMD-2873): <stable>-canary.
CANARY=""

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//' >&2
  exit 2
}

ENV_FILE="$HERE/.env"
CANARY_ENV=""
RUNTIME=""
STABLE=""
PORT=""
NAME=""
CMD=""
CONNECT=0
SMOKE=1
# Unset until the canary's database is looked at (SMD-3155): 1 refresh, 0 keep.
REFRESH=""
VOLUMES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file|--canary-env-file|--runtime|--stable-project|--port|--name)
      [ $# -ge 2 ] && [ -n "${2//[[:space:]]/}" ] && [ "${2#--}" = "$2" ] || { echo "$1 takes a value." >&2; exit 2; }
      case "$1" in
        --env-file) ENV_FILE="$2" ;;
        --canary-env-file) CANARY_ENV="$2" ;;
        --runtime) RUNTIME="$2" ;;
        --stable-project) STABLE="$2" ;;
        --port) PORT="$2" ;;
        --name) NAME="$2" ;;
      esac
      shift 2 ;;
    --connect) CONNECT=1; shift ;;
    --no-smoke) SMOKE=0; shift ;;
    --refresh|--no-refresh)
      want=1; [ "$1" = --refresh ] || want=0
      [ -z "$REFRESH" ] || [ "$REFRESH" = "$want" ] || { echo "--refresh replaces the canary's database and --no-refresh keeps it: one or the other." >&2; exit 2; }
      REFRESH=$want; shift ;;
    --volumes) VOLUMES=1; shift ;;
    up|down|names) [ -z "$CMD" ] || { echo "one command: up, down or names." >&2; exit 2; }; CMD="$1"; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[ -n "$CMD" ] || usage
# Whether a value is a port number, 1-65535, as --port and the env file's
# SERVER_PORT must be.
is_port() { case "$1" in ""|*[!0-9]*|0*) return 1 ;; esac; [ "$1" -le 65535 ]; }
[ -z "$PORT" ] || is_port "$PORT" || { echo "--port takes a port number, 1-65535: $PORT" >&2; exit 2; }
[ "$CMD" = up ] || { [ $CONNECT = 0 ] && [ $SMOKE = 1 ] && [ -z "$REFRESH" ]; } || { echo "--connect, --no-smoke, --refresh and --no-refresh go with up." >&2; exit 2; }
[ "$CMD" = down ] || [ $VOLUMES = 0 ] || { echo "--volumes goes with down." >&2; exit 2; }
# What a failed run tells the operator to run again, set once the run knows
# whether it refreshes (below): a refresh's own form, so advice after a failed
# refresh never sends them into an in-place migration of a half-restored copy,
# and a plain `up` otherwise, which keeps the database (SMD-3155). A connector
# moved after a run that succeeded needs no refresh: `up --connect` keeps.
RERUN="up"
RECONNECT="up --connect"
[ -f "$ENV_FILE" ] || { echo "no env file at $ENV_FILE — name the running stack's with --env-file (deploy/.env is gitignored, so a worktree has none)." >&2; exit 2; }
ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"
# The canary's own env file (SMD-2583) is placed once stable's project is
# known, below: beside stable's unless named, made by `up` from stable's the
# first time. Its directory must exist; the file need not.
# The canary's database password is its env file's. A value in the shell would
# win over that file in compose, and hand the canary stable's.
unset POSTGRES_PASSWORD
# …and so are its keys and the secrets that go with them (SMD-2874 PR 2): a
# shell holding stable's settings (`set -a; . deploy/.env`) would otherwise
# hand the canary's servers stable's MCP_ACCESS_KEYS over the canary's own
# (review pass 1). The worker key too (sleep's and the workers'), and every Linear key, in any
# letter case (SMD-3312 review pass 2): compose reads ${LINEAR_API_KEY} from the
# shell over the canary's file, so a shell exporting stable's would run the
# canary's board-sync on it, while step 6, reading the file, said the canary's.
unset MCP_ACCESS_KEYS MCP_ACCESS_KEY OB1_FORWARDER_KEY OB1_HOOK_SECRETS OB1_PLUGIN_DB_PASSWORD OB1_CANARY_KEY OB1_WORKER_KEY
# Their values are kept first, unexported, a line each: stable's board-sync may
# take its key from such a shell, with no line in stable's file, and env_file
# own-fix (handed them alone, as SHELL_LINEAR) clears that key from the
# canary's file as it does stable's own (review pass 3).
SHELL_LINEAR=""
while IFS= read -r name; do SHELL_LINEAR+="${!name}"$'\n'; unset "$name"; done < <(compgen -e | grep -iE '^LINEAR_' || true)

if [ -z "$RUNTIME" ]; then
  if command -v docker >/dev/null 2>&1; then RUNTIME=docker
  elif command -v podman >/dev/null 2>&1; then RUNTIME=podman
  else echo "neither docker nor podman is on PATH." >&2; exit 2
  fi
fi
command -v "$RUNTIME" >/dev/null 2>&1 || { echo "--runtime $RUNTIME is not on PATH." >&2; exit 2; }

# Stable's project (SMD-2873): one env file is one brain, so the project is the
# one stable's env file names — COMPOSE_PROJECT_NAME as compose reads it, the
# shell's winning as it does for stable's own `up` — else compose.yaml's
# `name:`, open-brain: compose renders a stub carrying that `name:`, so no
# setting is interpolated, and its `name` is the project stable's `up` takes.
# The runtime's compose first, then either other one on PATH, as tier.sh reads
# its env file (compose quotes a name YAML would read otherwise, `"123"`); on
# none, compose's own last word goes to stderr.
read_project() {
  local c out errf
  errf="$(mktemp "${TMPDIR:-/tmp}/ob1-canary-project.XXXXXX")"
  for c in "$RUNTIME" docker podman; do
    command -v "$c" >/dev/null 2>&1 || continue
    out="$(printf 'name: open-brain\nservices: {}\n' | "$c" compose --env-file "$1" -f - config 2>"$errf" | sed -n 's/^name: //p' | head -n 1 | tr -d "\"'")" || true
    if [ -n "$out" ]; then rm -f "$errf"; printf '%s\n' "$out"; return 0; fi
  done
  sed $'s/\x1b\\[[0-9;]*m//g' "$errf" | grep -v -E 'Executing external compose provider|^Error: executing .*compose|^[[:space:]]*$' | tail -n 1 >&2 || true
  rm -f "$errf"
  return 1
}
FROM_WHERE="--stable-project"
if [ -z "$STABLE" ]; then
  if [ -n "${COMPOSE_PROJECT_NAME+set}" ]; then FROM_WHERE="COMPOSE_PROJECT_NAME in the shell, which wins over $ENV_FILE"; else FROM_WHERE="COMPOSE_PROJECT_NAME in $ENV_FILE, or compose.yaml's open-brain"; fi
  STABLE="$(read_project "$ENV_FILE")" || { echo "could not read stable's project from $ENV_FILE through compose (its reason above); name it with --stable-project." >&2; exit 2; }
fi
# Read; from here on the canary's compose takes its project from -p alone.
unset COMPOSE_PROJECT_NAME
# A compose project's name, as compose allows one: anything else would reach the
# runtime's label filter, where a blank value matches every project's containers.
[[ "$STABLE" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo "stable's project ($FROM_WHERE) takes a compose project name (lower-case letters, digits, - and _): '$STABLE'" >&2; exit 2; }
# A canary is <stable>-canary, so a project of that form is a canary's, and has none of its own.
case "$STABLE" in *-canary) echo "stable's project, $STABLE ($FROM_WHERE), is a canary's: name the stable it stands beside." >&2; exit 2 ;; esac
CANARY="$STABLE-canary"
NAME="${NAME:-$CANARY}"
# The canary's env file: beside stable's, named for the canary's project so two
# instances in one directory keep two canaries apart; the dogfood canary's, made
# before SMD-2873 as .env.canary.local, keeps that name.
if [ -z "$CANARY_ENV" ]; then
  if [ "$CANARY" = open-brain-canary ]; then CANARY_ENV="$(dirname "$ENV_FILE")/.env.canary.local"; else CANARY_ENV="$(dirname "$ENV_FILE")/.env.$CANARY.local"; fi
fi
[ -d "$(dirname "$CANARY_ENV")" ] || { echo "no directory for the canary's env file: $(dirname "$CANARY_ENV")" >&2; exit 2; }
CANARY_ENV="$(cd "$(dirname "$CANARY_ENV")" && pwd)/$(basename "$CANARY_ENV")"
[ ! -e "$CANARY_ENV" ] || [ -f "$CANARY_ENV" ] || { echo "the canary's env file, $CANARY_ENV, exists and is not a file." >&2; exit 2; }
# By path or by file (a symlink, /private/tmp for /tmp; review pass 2).
if [ "$CANARY_ENV" = "$ENV_FILE" ] || [ "$CANARY_ENV" -ef "$ENV_FILE" ]; then echo "--canary-env-file names stable's env file; the canary's is its own." >&2; exit 2; fi
if [ "$CMD" = names ]; then
  printf 'stable    %s\ncanary    %s\nconnector %s\nenv file  %s\n' "$STABLE" "$CANARY" "$NAME" "$CANARY_ENV"
  exit 0
fi

say() { printf '▸ %s\n' "$*"; }

# The canary's compose: stable's file under the canary's project name. The
# port, the address, the tier and an empty profile list are set for these
# calls alone, where the shell wins over the env file, which says the same
# once `up` has written it; tier.sh, run between them, reads the env file
# without them. The canary's proxy is on loopback whatever SERVER_BIND says
# for stable. No profiles, so the canary's server advertises no OAuth.
# The env file is the canary's own once `up` has made it (SMD-2583); before
# that — `up`'s refusals, a `down` of a canary from before it — stable's, the
# file the canary's is made from.
# compose.yaml requires OB1_FORWARDER_KEY (SMD-2287), which `up` mints into
# the canary's file only once the file is made or mended (make_canary_env,
# set_canary_own): until then — the model probe below, a `down` of a canary
# from before it, stable's file read before the canary has one — a
# placeholder fills it for that call alone, so compose can read the file at
# all. Never once those have run (OWN_KEYS, below): their read-back has proved
# compose reads the canary's own key, and the shell's value would win over the
# file's in the MCP server, whatever spelling of the line a grep misses
# (review pass 2). Nor before, where the file plainly holds one.
OWN_KEYS=""
# LINEAR_COMMENT_API_KEY is held empty in the shell too, which compose reads
# over the env file: board-sync posts a finding only with it (db/board-findings.ts,
# SMD-2681), and a canary's board-sync never does: the file never gets the key
# (CANARY_DROPPED), every `up` clears one pasted in (env_file own-fix), and
# this holds it empty for every compose call canary.sh makes besides (SMD-3312).
# And OB1_PASSES, the coordinator's (SMD-3476): CANARY_PASSES, empty but in
# step 6, so the shell's never reaches the canary.
canary_compose() {
  local env="$ENV_FILE" fwd=()
  [ ! -f "$CANARY_ENV" ] || env="$CANARY_ENV"
  [ -n "$OWN_KEYS" ] || grep -qE "^[[:space:]]*(export[[:space:]]+)?OB1_FORWARDER_KEY=([^[:space:]#\"']|\"[^\"]|'[^'])" "$env" 2>/dev/null \
    || fwd=(OB1_FORWARDER_KEY=placeholder-until-canary-sh-mints-one)
  env ${fwd[@]+"${fwd[@]}"} SERVER_PORT="${PORT:-8000}" SERVER_BIND=127.0.0.1 OB1_TIER=canary COMPOSE_PROFILES="" OB1_PUBLIC_ORIGIN="" OB1_GIT_SHA="$GIT_SHA" LINEAR_COMMENT_API_KEY="" OB1_PASSES="$CANARY_PASSES" \
    "$RUNTIME" compose -p "$CANARY" --env-file "$env" -f "$HERE/compose.yaml" "$@"
}

# What the canary's env file leaves out of stable's: its database password,
# which is its own, and the secrets of the profiles the canary never runs
# (the authorization server's, n8n's, the import runner's, the workers' key,
# the observability profile's Grafana password and its database monitor's),
# in any letter case — and every Linear key, by prefix: an exact
# LINEAR_API_KEY here once let SMD-2681's LINEAR_COMMENT_API_KEY, a key that
# can comment, through to the canary's file (SMD-2882). The canary's board-sync
# (step 6, SMD-3312) reads with a LINEAR_API_KEY of its own, a read-only key
# the operator puts in its file, never stable's, which may be able to write
# and would be held by the canary's unreleased db/ code; env_file own-fix
# clears stable's, and any other Linear key, from the canary's file. Stable's
# COMPOSE_PROJECT_NAME never reads as a setting here, since every read is under
# the canary's -p, which compose reports as the name; the file names the
# canary's own project instead (SMD-2873, env_file write). OB1_PASSES, the
# passes the coordinator runs (SMD-3476), is the canary's own choice too, so a
# canary runs neither stable's sleep nor its board-sync unless its file says.
#
# …and stable's keys and the secrets that go with them (SMD-2874 PR 2,
# SMD-3032): its access keys (MCP_ACCESS_KEYS, the legacy MCP_ACCESS_KEY),
# the forwarder's key, the plugins' webhook secrets and their role's database
# password. The canary's own are written in their place (env_file own-fix),
# so they are no drift either.
CANARY_DROPPED='POSTGRES_PASSWORD|OB1_AUTH_[A-Z0-9_]*|N8N_[A-Z0-9_]*|OB1_RUNNER_[A-Z0-9_]*|OB1_WORKER_KEY|LINEAR_[A-Z0-9_]*|GRAFANA_[A-Z0-9_]*|OB1_MONITOR_[A-Z0-9_]*|MCP_ACCESS_KEYS|MCP_ACCESS_KEY|OB1_FORWARDER_KEY|OB1_HOOK_SECRETS|OB1_PLUGIN_DB_PASSWORD|OB1_CANARY_KEY|OB1_PASSES'
# What canary_compose sets in the shell for the canary, whatever the file says,
# so a difference there is no drift. The file is written with the canary's own
# values of these (env_file write), OB1_GIT_SHA aside, a build's, and
# OB1_PUBLIC_ORIGIN, which the canary never has: it is loopback alone and never
# configured, and stable's origin would have its operator GUI refuse every
# sign-in on the canary's port, its origin not stable's (SMD-2280 review pass 2).
CANARY_SET='SERVER_PORT|SERVER_BIND|OB1_TIER|COMPOSE_PROFILES|OB1_PUBLIC_ORIGIN|OB1_GIT_SHA'

# Env files as compose reads them, by value (review pass 2: copying stable's
# file line by line, less the left-out lines, kept a left-out value's
# comment-shaped tail, broke on a BOM and cut a quoted value in two). Every
# value is rendered through a service's environment and read back as JSON,
# with compose run on a bare environment — the container runtime's own
# variables (DOCKER_*, PODMAN_*, CONTAINER(S)_*, the ssh agent, PATH, HOME,
# USER, LOGNAME, TMPDIR, XDG_*) and nothing else — so the files are compared as files and the
# shell's variables, which compose would otherwise print and let win, play no
# part. The names are those `config --environment` prints for the file and
# not for an empty one: a superset, since a quoted value's second line can
# read as a name, which then renders unset on both sides.
#   env_file write STABLE OUT   writes OUT, which must exist (it is never
#                               created here, so a file the EXIT trap removed
#                               is not made again by a writer still running;
#                               review pass 3): every setting of STABLE's but
#                               CANARY_DROPPED's and CANARY_SET's, each
#                               "double-quoted" with
#                               \\ \" \$ \n escaped, which compose reads back
#                               exactly (measured), then POSTGRES_PASSWORD as
#                               $CANARY_PW (the environment's, never argv),
#                               COMPOSE_PROJECT_NAME as the canary's project, so
#                               the file names its own brain (SMD-2873), and
#                               CANARY_SET's as the canary's (SERVER_PORT as
#                               $CANARY_PORT; SMD-2874), but OB1_GIT_SHA and
#                               OB1_PUBLIC_ORIGIN, which get no line. A
#                               value STABLE builds from the shell (`${X}`),
#                               which reads otherwise with the shell's
#                               variables than without, is refused, not
#                               frozen
#   env_file made STABLE OUT    exit 0 when OUT reads as STABLE but for
#                               CANARY_DROPPED's names, each unset there but
#                               POSTGRES_PASSWORD, which is $CANARY_PW, and
#                               CANARY_SET's, SERVER_PORT $CANARY_PORT among
#                               them; it names the canary's project, and the
#                               guard below holds
#   env_file guard STABLE OUT   exit 0 when OUT's POSTGRES_PASSWORD is set,
#                               reads alike with and without the shell's
#                               variables, spans no lines, and neither is nor
#                               holds STABLE's (read with and without the
#                               shell); and no value of OUT's holds STABLE's
#                               (one of 12 characters or more; a shorter one
#                               would match ordinary text) or a line setting
#                               POSTGRES_PASSWORD; and it names no project but
#                               the canary's. Every `up` that finds the
#                               file runs it first, as an edit can undo it
#   env_file drift STABLE OUT   the names whose values differ, CANARY_DROPPED's
#                               and CANARY_SET's aside, on one line
#   env_file value OUT NAME     OUT's NAME, exactly, on stdout (nothing when unset)
#   env_file values OUT NAME…   each NAME's value on a line of its own, a
#                               backslash and a line feed in it escaped, so
#                               one value is one line
#   env_file own-fix STABLE OUT what OUT must be given to be the canary's own,
#                               as JSON {"values": {NAME: value}, "said": [...]}
#                               ("said" names values, never a secret's): its
#                               CANARY_SET (SERVER_PORT $CANARY_PORT), no
#                               access key of STABLE's in MCP_ACCESS_KEYS and a
#                               write key of its own (minted when it has none,
#                               the raw key in OB1_CANARY_KEY) and a forward key
#                               of its own for the MCP server (likewise, in
#                               OB1_FORWARDER_KEY; SMD-2287), no raw key or
#                               webhook secret of STABLE's, and a plugin role
#                               password of its own when STABLE sets one
#                               (SMD-2874, SMD-3032); no LINEAR_API_KEY that
#                               is STABLE's and no other Linear key, each
#                               cleared (SMD-3312). Empty values when OUT
#                               already is
#   env_file project OUT        the project OUT names (COMPOSE_PROJECT_NAME, read
#                               without -p), or nothing
# A refusal names the setting, never its value.
env_file() {
  # shellcheck disable=SC2016 # Python's text, which the shell must not expand
  RT="$RUNTIME" PROJ="$CANARY-env" OWN_PROJECT="$CANARY" DROPPED="$CANARY_DROPPED" SET_BY_CANARY="$CANARY_SET" FROM="$ENV_FILE" python3 -c '
import datetime, json, os, re, subprocess, sys
mode, args = sys.argv[1], sys.argv[2:]
dropped = re.compile("(?:%s)" % os.environ["DROPPED"], re.I)
set_by_canary = re.compile("(?:%s)" % os.environ["SET_BY_CANARY"])
runtime_var = re.compile(r"(?:DOCKER|PODMAN|CONTAINERS?)_[A-Za-z0-9_]*|PATH|HOME|USER|LOGNAME|TMPDIR|SSH_AUTH_SOCK|XDG_[A-Z_]+")
bare = {k: v for k, v in os.environ.items() if runtime_var.fullmatch(k)}
UNSET = "OB1-CANARY-UNSET-7f3a9c"
STRONG = 12
# The canary'"'"'s own values of what canary_compose sets in the shell (CANARY_SET,
# but OB1_GIT_SHA, a build'"'"'s), which env_file write puts in its file.
OWN = {"SERVER_PORT": os.environ.get("CANARY_PORT", ""), "SERVER_BIND": "127.0.0.1", "OB1_TIER": "canary", "COMPOSE_PROFILES": ""}
if mode in ("write", "made", "own-fix") and not OWN["SERVER_PORT"].isdigit():
    sys.exit("no CANARY_PORT, the canary'"'"'s port, for %s" % mode)
def compose(env_file, text, *cmd, env=bare):
    # On the shell'"'"'s environment, a variable of the shell'"'"'s that is not
    # UTF-8 is not the file'"'"'s fault: read past it (review pass 4).
    try:
        r = subprocess.run([os.environ["RT"], "compose", "-p", os.environ["PROJ"], "--env-file", env_file, "-f", "-", *cmd], input=text, capture_output=True, text=True, env=env, errors="strict" if env is bare else "surrogateescape", timeout=120)
    except UnicodeError:
        sys.exit("%s, or a container runtime variable in the environment, holds bytes that are not UTF-8" % env_file)
    except subprocess.TimeoutExpired:
        sys.exit("compose did not answer in 120 s reading %s" % env_file)
    if r.returncode:
        sys.exit("compose could not read %s" % env_file)
    return r.stdout
def names(env_file, env=bare):
    return set(re.findall(r"^([A-Za-z_][A-Za-z0-9_]*)=", compose(env_file, "services: {}\n", "config", "--environment", env=env), re.M))
def values(env_file, cand, env=bare):
    # Unset renders as UNSET and reads as None: a name read off a value'"'"'s
    # second line is no setting, and is neither written nor compared as one.
    body = "".join("      \"%s\": \"${%s-%s}\"\n" % (n, n, UNSET) for n in cand)
    doc = json.loads(compose(env_file, "services:\n  probe:\n    image: probe\n" + ("    environment:\n" + body if cand else ""), "config", "--format", "json", env=env))
    got = doc["services"]["probe"].get("environment") or {}
    # compose writes a value'"'"'s $ as $$ in its output, on both sides alike.
    raw = {n: got.get(n) or "" for n in cand}
    return {n: None if raw[n] == UNSET else raw[n].replace("$$", "$") for n in cand}
def file_names(env_file):
    return sorted(names(env_file) - names(os.devnull))
UNNAMED = "ob1-canary-unnamed-7f3a9c"
def project_of(env_file, env=bare):
    # The project the file names: compose renders a stub carrying a name of its
    # own, under no -p (a -p is what every other read here reports as the name).
    try:
        r = subprocess.run([os.environ["RT"], "compose", "--env-file", env_file, "-f", "-", "config"], input="name: %s\nservices: {}\n" % UNNAMED, capture_output=True, text=True, env=env, timeout=120)
    except (UnicodeError, subprocess.TimeoutExpired):
        sys.exit("compose could not read %s for its project" % env_file)
    m = re.search(r"^name: (.*)$", r.stdout, re.M) if r.returncode == 0 else None
    if not m:
        sys.exit("compose could not read %s for its project" % env_file)
    name = m.group(1).strip().strip("\"'"'"'")
    return None if name == UNNAMED else name
def guard(stable, out):
    # Stable'"'"'s password as compose reads it on its own and with the shell
    # (one stable builds from a shell variable; review pass 4).
    pws = {v for v in (values(stable, ["POSTGRES_PASSWORD"], env)["POSTGRES_PASSWORD"] for env in (bare, os.environ)) if v}
    cand = file_names(out)
    c = values(out, cand)
    mine = c.get("POSTGRES_PASSWORD") or ""
    mine_with_shell = values(out, ["POSTGRES_PASSWORD"], os.environ)["POSTGRES_PASSWORD"] or ""
    problems = []
    if not mine and mine_with_shell:
        problems.append("its POSTGRES_PASSWORD reads otherwise with the shell'"'"'s variables")
    elif not mine:
        problems.append("it sets no POSTGRES_PASSWORD")
    elif mine in pws:
        problems.append("its POSTGRES_PASSWORD is stable'"'"'s")
    elif any(len(pw) >= STRONG and pw in mine for pw in pws):
        problems.append("its POSTGRES_PASSWORD holds stable'"'"'s")
    # The password ALTER ROLE sets is the one compose hands the servers: not
    # built from the shell (compose reads it otherwise there), and with no
    # newline, which the shell'"'"'s $(…) would cut from its end (review pass 4).
    if mine and mine_with_shell != mine:
        problems.append("its POSTGRES_PASSWORD reads otherwise with the shell'"'"'s variables")
    if "\n" in mine:
        problems.append("its POSTGRES_PASSWORD spans lines")
    for n in cand:
        v = c[n] or ""
        if n != "POSTGRES_PASSWORD" and any(len(pw) >= STRONG and pw in v for pw in pws):
            problems.append("%s holds stable'"'"'s database password" % n)
        if "\nPOSTGRES_PASSWORD=" in v:
            problems.append("%s holds a line setting POSTGRES_PASSWORD" % n)
    named = project_of(out)
    if named is not None and named != os.environ["OWN_PROJECT"]:
        problems.append("COMPOSE_PROJECT_NAME names %s, not the canary'"'"'s project, %s" % (named, os.environ["OWN_PROJECT"]))
    # Compose run by hand with the file reads it under the shell'"'"'s variables:
    # a name built from them (${X}) names another brain there (review pass 2).
    shell_env = {k: v for k, v in os.environ.items() if k != "COMPOSE_PROJECT_NAME"}
    if project_of(out, shell_env) != named:
        problems.append("its COMPOSE_PROJECT_NAME reads otherwise with the shell'"'"'s variables")
    return problems
if mode == "value":
    sys.stdout.write(values(args[0], [args[1]])[args[1]] or "")
    sys.exit(0)
if mode == "values":
    got = values(args[0], args[1:])
    print("\n".join((got[n] or "").replace("\\", "\\\\").replace("\n", "\\n") for n in args[1:]))
    sys.exit(0)
if mode == "project":
    sys.stdout.write(project_of(args[0]) or "")
    sys.exit(0)
quote = lambda v: "\"" + v.replace("\\", "\\\\").replace("\"", "\\\"").replace("$", "\\$").replace("\n", "\\n") + "\""
stable, out = args
if mode == "own-fix":
    import hashlib, secrets
    sha = lambda raw: hashlib.sha256(raw.encode()).hexdigest()
    def entries(spec):
        # MCP_ACCESS_KEYS as server-portable/auth.ts parseKeyRecords reads it:
        # name:scope:sha256, by commas or newlines, blanks and comments skipped.
        got = []
        for e in re.split(r"[,\n]", spec or ""):
            e = e.strip()
            if not e or e.startswith("#"):
                continue
            parts = [x.strip() for x in e.split(":")]
            got.append((e, parts[0] if len(parts) == 3 else "", parts[1] if len(parts) == 3 else "", parts[2].lower() if len(parts) == 3 else ""))
        return got
    s = values(stable, ["MCP_ACCESS_KEYS", "MCP_ACCESS_KEY", "OB1_HOOK_SECRETS", "OB1_PLUGIN_DB_PASSWORD", "OB1_WORKER_KEY", "OB1_FORWARDER_KEY"])
    c = values(out, list(OWN) + ["MCP_ACCESS_KEYS", "MCP_ACCESS_KEY", "OB1_CANARY_KEY", "OB1_HOOK_SECRETS", "OB1_PLUGIN_DB_PASSWORD", "OB1_WORKER_KEY", "OB1_FORWARDER_KEY"])
    # deploy/env-file.ts replaces a setting by its line: one whose quote opens
    # on its line and closes on a later one would leave its continuation
    # behind (review pass 1). Read off the file'"'"'s own lines, not its value: a
    # value holding \n written on one line (canary.sh'"'"'s own `write` escapes a
    # line break so) is replaced whole (review pass 2).
    file_lines = open(out, encoding="utf-8", errors="replace").read().split("\n")
    def spans_lines(name):
        for line in file_lines:
            m = re.match(r"\s*(?:export\s+)?%s\s*=\s*(.*)$" % name, line)
            if not m or m.group(1)[:1] not in ("\"", "'"'"'"):
                continue
            q, rest, i = m.group(1)[0], m.group(1)[1:], 0
            while i < len(rest):
                if q == "\"" and rest[i] == "\\":
                    i += 2
                    continue
                if rest[i] == q:
                    break
                i += 1
            else:
                return True
        return False
    # The Linear names the canary'"'"'s file sets, in any letter case (SMD-3312).
    linear = [n for n in file_names(out) if re.fullmatch(r"LINEAR_[A-Z0-9_]*", n, re.I)]
    spans = [n for n in list(OWN) + ["MCP_ACCESS_KEYS", "MCP_ACCESS_KEY", "OB1_CANARY_KEY", "OB1_HOOK_SECRETS", "OB1_PLUGIN_DB_PASSWORD", "OB1_WORKER_KEY", "OB1_FORWARDER_KEY"] + linear if spans_lines(n)]
    # Stable'"'"'s keys: its MCP_ACCESS_KEYS entries, its legacy key, and its
    # MCP server'"'"'s forward key, listed there or not (SMD-2287 review pass 3).
    stable_fwd = (s["OB1_FORWARDER_KEY"] or "").strip()
    stable_digests = {d for _, _, _, d in entries(s["MCP_ACCESS_KEYS"]) if d} | ({sha(s["MCP_ACCESS_KEY"])} if s["MCP_ACCESS_KEY"] else set()) | ({sha(stable_fwd)} if stable_fwd else set())
    fix, said = {}, []
    # The canary'"'"'s port, address, tier and profiles (SMD-2874 PR 1).
    for n, v in OWN.items():
        if c[n] != v:
            fix[n] = v
            said.append("%s=%s%s" % (n, quote(v), " (it said %s)" % c[n] if n == "SERVER_PORT" and c[n] else ""))
    # Its access keys (SMD-2874 PR 2): none of stable'"'"'s, and one of its own,
    # minted here, its raw key in OB1_CANARY_KEY for the smoke and the
    # connector. Acceptance is MCP_ACCESS_KEYS alone, so a key stable accepts
    # opens the canary only through it.
    have = entries(c["MCP_ACCESS_KEYS"])
    kept = [x for x in have if x[3] not in stable_digests]
    raw = c["OB1_CANARY_KEY"] or ""
    own_ok = bool(raw) and sha(raw) not in stable_digests and any(d == sha(raw) and scope == "write" for _, _, scope, d in kept)
    if len(kept) < len(have):
        said.append("removed %d of stable'"'"'s access keys from MCP_ACCESS_KEYS" % (len(have) - len(kept)))
    def unused(base):
        # A name no kept entry holds (parseKeyRecords refuses one twice): an
        # operator'"'"'s own entry under the canary'"'"'s name stays (code review).
        taken = {x[1] for x in kept}
        name, n = base, 2
        while name in taken:
            name = "%s-%d" % (base, n)
            n += 1
        return name
    if not own_ok:
        raw = secrets.token_hex(32)
        name = unused(os.environ["OWN_PROJECT"])
        kept = kept + [("%s:write:%s" % (name, sha(raw)), name, "write", sha(raw))]
        fix["OB1_CANARY_KEY"] = raw
        said.append("minted the canary'"'"'s own write key, %s (its hash in MCP_ACCESS_KEYS, the raw key in OB1_CANARY_KEY)" % name)
    # Its forward key (SMD-2287): the MCP server calls the REST core with it
    # beside each client'"'"'s key, and refuses to start without one. Minted as
    # the write key is, in place of stable'"'"'s (whose entries went with
    # stable'"'"'s keys above), or of one no forward entry here holds. Trimmed,
    # as the MCP server reads it (review pass 1). Named for the MCP server,
    # since the REST core records the name as who carried each request, and
    # `forwarder` alone is the stack'"'"'s port forwarder (review pass 3).
    fwd = (c["OB1_FORWARDER_KEY"] or "").strip()
    fwd_stable = bool(fwd) and sha(fwd) in stable_digests
    fwd_ok = bool(fwd) and not fwd_stable and any(d == sha(fwd) and scope == "forward" for _, _, scope, d in kept)
    if not fwd_ok:
        # The forward entries an earlier mint here made, whose raw key this
        # file no longer holds, go with the one it replaces (review pass 1).
        # Another name'"'"'s forward entry is the operator'"'"'s, and stays; so does
        # any other scope'"'"'s under any name (review pass 2).
        base = os.environ["OWN_PROJECT"] + "-mcp-forwarder"
        minted_here = re.compile(re.escape(base) + r"(?:-(?:[2-9]|[1-9][0-9]+))?")
        before = len(kept)
        kept = [x for x in kept if not (x[2] == "forward" and minted_here.fullmatch(x[1]))]
        if len(kept) < before:
            said.append("removed %d forward entr%s an earlier up minted (%s, %s-2 and on) from MCP_ACCESS_KEYS: the file no longer holds %s" % (before - len(kept), "y" if before - len(kept) == 1 else "ies", base, base, "its raw key" if before - len(kept) == 1 else "their raw keys"))
        was = ", in place of stable'"'"'s" if fwd_stable else ", in place of one MCP_ACCESS_KEYS does not hold as a forward key" if fwd else ""
        fwd = secrets.token_hex(32)
        name = unused(base)
        kept = kept + [("%s:forward:%s" % (name, sha(fwd)), name, "forward", sha(fwd))]
        fix["OB1_FORWARDER_KEY"] = fwd
        said.append("minted the canary'"'"'s own forward key, %s (its hash in MCP_ACCESS_KEYS, the raw key in OB1_FORWARDER_KEY%s)" % (name, was))
    if len(kept) < len(have) or not own_ok or not fwd_ok:
        fix["MCP_ACCESS_KEYS"] = ",".join(e for e, _, _, _ in kept)
    # Raw keys and secrets of stable'"'"'s the canary never needs.
    for n in ("MCP_ACCESS_KEY", "OB1_WORKER_KEY"):
        if c[n] and (sha(c[n]) in stable_digests or c[n] == s.get(n)):
            fix[n] = ""
            said.append("cleared %s (a key of stable'"'"'s)%s" % (n, "; a canary worker needs one of its own: bun server-portable/keygen.ts --name canary-workers --scope capture, its line in MCP_ACCESS_KEYS and its key here" if n == "OB1_WORKER_KEY" else ""))
    # Linear (SMD-3312): the canary'"'"'s board-sync reads the board with a
    # LINEAR_API_KEY of its own, never stable'"'"'s, which may be able to write
    # and which the canary'"'"'s unreleased db/ code would hold; and it never
    # comments, so any other Linear key (the comment key, pasted in) goes too,
    # beside canary_compose holding it empty, so a board-sync started by hand
    # from this file cannot post either. The exact name alone is a read key:
    # compose reads ${LINEAR_API_KEY} by its case. Stable'"'"'s is any of stable'"'"'s
    # Linear keys, its comment key among them, by value, spaces aside (review
    # pass 2: its comment key pasted as the canary'"'"'s read key passed).
    if linear:
        # Compose reads a name set on two lines from the last, so a value on an
        # earlier one is neither read nor compared, and a clearing removes
        # every line of it, the canary'"'"'s own key with stable'"'"'s: two lines
        # that each hold a value (= or :, as compose reads either) are refused,
        # named, before anything is written (review pass 2). An empty one, as a
        # clearing leaves, is no second key (review pass 3). (Any other Linear
        # name is cleared whatever its lines hold, every one.)
        def valued(line):
            m = re.match(r"\s*(?:export\s+)?LINEAR_API_KEY\s*[=:](.*)$", line)
            return bool(m) and bool(m.group(1).strip().strip("\"" + "'"'"'").strip())
        if "LINEAR_API_KEY" in linear and sum(1 for line in file_lines if valued(line)) > 1:
            sys.exit("LINEAR_API_KEY is set on more than one line in %s, and compose reads only the last: keep one line, with the canary'"'"'s own key (or none)" % (os.environ.get("SHOWN") or out))
        lv = values(out, linear)
        # A key that reads otherwise with the shell'"'"'s variables (${X:-…}) is not
        # the one compared here, nor the one step 6 reads, but compose hands the
        # container that reading: refused, as guard refuses such a database
        # password (review pass 3).
        if "LINEAR_API_KEY" in linear and (values(out, ["LINEAR_API_KEY"], os.environ)["LINEAR_API_KEY"] or "").strip() != (lv["LINEAR_API_KEY"] or "").strip():
            sys.exit("LINEAR_API_KEY in %s reads otherwise with the shell'"'"'s variables: write the canary'"'"'s key itself, no ${...}" % (os.environ.get("SHOWN") or out))
        # Stable'"'"'s Linear keys: its file'"'"'s, read without the shell and with it (a
        # value built from a shell variable; review pass 3), and the values
        # canary.sh found exported in its own shell and unset (SHELL_LINEAR),
        # which stable'"'"'s board-sync may run on with no line in its file.
        stable_linear = [n for n in file_names(stable) if re.fullmatch(r"LINEAR_[A-Z0-9_]*", n, re.I)]
        stable_by_value = {}
        for env in (bare, os.environ):
            for n, v in (values(stable, stable_linear, env) if stable_linear else {}).items():
                if (v or "").strip():
                    stable_by_value.setdefault(v.strip(), "stable'"'"'s %s" % n)
        for v in os.environ.get("SHELL_LINEAR", "").split("\n"):
            if v.strip():
                stable_by_value.setdefault(v.strip(), "a Linear key exported in canary.sh'"'"'s shell")
        for n in linear:
            v = (lv[n] or "").strip()
            if not v:
                continue
            if n != "LINEAR_API_KEY":
                fix[n] = ""
                said.append("cleared %s (a Linear key the canary never holds: its board-sync reads the board with a LINEAR_API_KEY of its own and never comments)" % n)
            elif v in stable_by_value:
                fix[n] = ""
                said.append("cleared LINEAR_API_KEY (%s): the canary'"'"'s board-sync reads with a key of its own, a Linear personal API key made with Read access alone" % stable_by_value[v])
    # plugin=secret pairs separated by spaces, the first = the separator, as
    # server-portable/core/plugins.ts hookSecrets reads them: any secret of
    # stable'"'"'s, under any plugin'"'"'s name (review pass 1: split on commas, it
    # matched only the whole value).
    hooks = lambda v: {x.split("=", 1)[1] for x in (v or "").split() if "=" in x and x.split("=", 1)[0] and x.split("=", 1)[1]}
    stable_hooks = hooks(s["OB1_HOOK_SECRETS"])
    pairs = (c["OB1_HOOK_SECRETS"] or "").split()
    own_pairs = [x for x in pairs if not ("=" in x and x.split("=", 1)[1] in stable_hooks)]
    if len(own_pairs) < len(pairs):
        # Stable'"'"'s pairs out, the canary'"'"'s own kept.
        fix["OB1_HOOK_SECRETS"] = " ".join(own_pairs)
        said.append("cleared OB1_HOOK_SECRETS of stable'"'"'s webhook secrets (%d); a webhook OB1_HOOKS serves with no secret of the canary'"'"'s answers 503 until it has one" % (len(pairs) - len(own_pairs)))
    # The plugin role'"'"'s password (SMD-3032): its own wherever stable sets one;
    # the canary'"'"'s migrate sets the role to it.
    sp, cp = s["OB1_PLUGIN_DB_PASSWORD"], c["OB1_PLUGIN_DB_PASSWORD"]
    if sp and (not cp or cp == sp or (len(sp) >= STRONG and sp in cp)):
        fix["OB1_PLUGIN_DB_PASSWORD"] = secrets.token_hex(24)
        said.append("OB1_PLUGIN_DB_PASSWORD, a fresh one (up sets the plugin role to it before the refresh)")
    # A setting spanning lines is refused only when it must be rewritten: one
    # the server reads (parseKeyRecords takes entries a line each) and that
    # needs nothing is left as it is (code review).
    blocked = [n for n in spans if n in fix]
    if blocked:
        # A Linear key is cleared, not rewritten: its lines go (review pass 2).
        lin = [n for n in blocked if n in linear]
        other = [n for n in blocked if n not in linear]
        sys.exit("; ".join(([("%s in %s spans lines: write it on one line, its entries separated by commas" % (", ".join(other), os.environ.get("SHOWN") or out))] if other else [])
                           + ([("%s in %s spans lines, and the canary never holds it: delete its lines" % (", ".join(lin), os.environ.get("SHOWN") or out))] if lin else [])))
    print(json.dumps({"values": fix, "said": said}))
    sys.exit(0)
if mode == "write":
    cand = file_names(stable)
    s = values(stable, cand)
    shell = names(os.devnull, os.environ)
    live = values(stable, [n for n in cand if n not in shell], os.environ)
    built = [n for n in live if not dropped.fullmatch(n) and not set_by_canary.fullmatch(n) and live[n] != s[n]]
    if built:
        sys.exit("%s in %s take part of their value from the shell (${...}); write the canary'"'"'s file yourself, with the values it should have" % (", ".join(built), stable))
    with os.fdopen(os.open(out, os.O_WRONLY | os.O_TRUNC), "w") as f:
        f.write("# The canary'"'"'s own env file (deploy/canary.sh, SMD-2583), written by `up`\n# on %s from %s as compose read it: every setting but\n# its database password, port, address, tier and profiles, which are its own,\n# the public origin, which it has none of, and the other profiles'"'"' secrets.\n# Edit it to carry a change of stable'"'"'s across, or delete it to make it\n# again at the next `up`.\n" % (datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), os.environ["FROM"]))
        for n in cand:
            if not dropped.fullmatch(n) and not set_by_canary.fullmatch(n) and s[n] is not None:
                f.write("%s=%s\n" % (n, quote(s[n])))
        f.write("POSTGRES_PASSWORD=%s\n" % quote(os.environ["CANARY_PW"]))
        f.write("COMPOSE_PROJECT_NAME=%s\n" % quote(os.environ["OWN_PROJECT"]))
        for n, v in OWN.items():
            f.write("%s=%s\n" % (n, quote(v)))
    sys.exit(0)
if mode == "guard":
    problems = guard(stable, out)
    if problems:
        sys.exit("; ".join(problems))
    sys.exit(0)
cand = sorted(set(file_names(stable)) | set(file_names(out)))
s, c = values(stable, cand), values(out, cand)
if mode == "drift":
    print(" ".join(n for n in cand if not dropped.fullmatch(n) and not set_by_canary.fullmatch(n) and s[n] != c[n]))
    sys.exit(0)
problems = []
if c.get("POSTGRES_PASSWORD") != os.environ["CANARY_PW"]:
    problems.append("POSTGRES_PASSWORD is not the one written")
own = values(out, list(OWN))
problems += ["%s is not the canary'"'"'s" % n for n, v in OWN.items() if own[n] != v]
if project_of(out) != os.environ["OWN_PROJECT"]:
    problems.append("COMPOSE_PROJECT_NAME is not the canary'"'"'s project")
for n in cand:
    if n == "POSTGRES_PASSWORD":
        continue
    if dropped.fullmatch(n):
        if c[n]:
            problems.append("%s, a left-out setting, is set" % n)
    elif set_by_canary.fullmatch(n):
        continue
    elif c[n] != s[n]:
        problems.append("%s reads otherwise than in stable'"'"'s" % n)
problems += [g for g in guard(stable, out) if g not in problems]
if problems:
    sys.exit("; ".join(problems))
' "$@"
}

# Makes the canary's env file from stable's (env_file write), checks it
# (env_file made), and only then puts it in place, mode 600: written whole
# or not at all. The file in the making, beside it, is made with noclobber
# (O_EXCL) under a name ending in .local, as the final one does: the root
# .gitignore has ignored `.env.*.local` since before this script made one,
# so stable's checkout, whatever its age, ignores both. CANARY_TMP names it
# before it exists, so the EXIT trap removes it however the run ends.
make_canary_env() {
  local pw
  pw="$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
  # In the directory the file's path resolves to, as deploy/env-file.ts
  # resolves it to name its own temporary file, so the EXIT trap's glob
  # finds that one too (code review).
  CANARY_TMP="$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$(dirname "$CANARY_ENV")")/.env.canary-$$-$RANDOM.local"
  (umask 077 && set -o noclobber && : > "$CANARY_TMP") || { CANARY_TMP=""; echo "could not create a temporary file beside $CANARY_ENV." >&2; exit 1; }
  local why=""
  if ! why="$(CANARY_PW="$pw" CANARY_PORT="$PORT" env_file write "$ENV_FILE" "$CANARY_TMP" 2>&1 && CANARY_PW="$pw" CANARY_PORT="$PORT" env_file made "$ENV_FILE" "$CANARY_TMP" 2>&1)"; then
    rm -f "$CANARY_TMP"
    CANARY_TMP=""
    echo "could not make the canary's env file from $ENV_FILE: ${why:-compose did not answer} (read back through compose). Write $CANARY_ENV yourself — stable's settings with a POSTGRES_PASSWORD and a SERVER_PORT of the canary's own and without the other profiles' secrets — and re-run up." >&2
    exit 2
  fi
  apply_own "$CANARY_TMP" || { rm -f "$CANARY_TMP"; CANARY_TMP=""; echo "could not give the canary's env file its own keys and settings (deploy/env-file.ts, read back through compose): $(head -c 300 <<<"$OWN_WHY")" >&2; exit 2; }
  mv "$CANARY_TMP" "$CANARY_ENV"
  CANARY_TMP=""
}

# Gives FILE, a copy being made ready, what env_file own-fix says it lacks to
# be the canary's own (SMD-2874, SMD-3032): its port, address, tier and
# profiles, its own access keys, none of stable's keys or webhook secrets, and
# a plugin role password of its own. Written by deploy/env-file.ts's
# setEnvValues, one line a setting: its old lines removed and the new one at
# the file's end, the rest of the file as it was; the values reach
# it on stdin, never argv. Then read back through compose, which must find
# nothing left to fix. OWN_SAID says what was written (names, and the values
# that are no secret); empty when there was nothing to write. Returns 1, with
# OWN_WHY, when it could not.
OWN_SAID=""
OWN_WHY=""
apply_own() {
  local fix left
  OWN_SAID=""
  # SHOWN names the canary's env file in a refusal, not the copy (review pass 2).
  fix="$(SHELL_LINEAR="$SHELL_LINEAR" SHOWN="$CANARY_ENV" CANARY_PORT="$PORT" env_file own-fix "$ENV_FILE" "$1" 2>&1)" || { OWN_WHY="$fix"; return 1; }
  # One parse: what was said on the first line (joined, so one line), the
  # values as JSON on the second, held in the shell and piped, never argv.
  local said_values values
  said_values="$(printf '%s' "$fix" | python3 -c 'import json, sys; d = json.load(sys.stdin); print("; ".join(d["said"])); print(json.dumps(d["values"]))')" || { OWN_WHY="env_file own-fix gave no answer"; return 1; }
  OWN_SAID="$(printf '%s\n' "$said_values" | head -n 1)"
  [ -n "$OWN_SAID" ] || return 0
  values="$(printf '%s\n' "$said_values" | sed -n 2p)"
  OWN_WHY="$(printf '%s' "$values" | bun --no-env-file "$HERE/env-file.ts" set "$1" 2>&1)" || return 1
  left="$(SHELL_LINEAR="$SHELL_LINEAR" CANARY_PORT="$PORT" env_file own-fix "$ENV_FILE" "$1" 2>&1 | python3 -c 'import json, sys; print(" ".join(json.load(sys.stdin)["values"]))' 2>&1)" || { OWN_WHY="compose could not read it back"; return 1; }
  [ -z "$left" ] || { OWN_WHY="compose read $left otherwise back"; return 1; }
}

# The same for the canary's standing env file, on every `up`: a `--port` that
# differs, or a file made before SMD-2874 (stable's port, address, tier,
# profiles and keys) or before SMD-3032 (stable's plugin role password). Made
# ready on a copy beside the file it names, through a symlink (code review),
# written mode 600, and put in its place only once read back.
set_canary_own() {
  local target
  target="$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$CANARY_ENV")"
  CANARY_TMP="$(dirname "$target")/.env.canary-$$-$RANDOM.local"
  (umask 077 && set -o noclobber && cat "$target" > "$CANARY_TMP") || { CANARY_TMP=""; echo "could not copy $target beside it." >&2; exit 1; }
  if ! apply_own "$CANARY_TMP"; then
    rm -f "$CANARY_TMP"
    CANARY_TMP=""
    # A Linear line's refusal says its own fix; the general advice is for the rest.
    local advice="set them there yourself (its own SERVER_PORT, SERVER_BIND, OB1_TIER, COMPOSE_PROFILES, and an MCP_ACCESS_KEYS holding none of stable's keys)"
    case "$OWN_WHY" in *LINEAR_*|*linear_*) advice="fix that line there" ;; esac
    echo "could not give the canary's env file, $CANARY_ENV, its own keys and settings: $(head -c 300 <<<"$OWN_WHY") — $advice, and re-run ${RERUN:-up}." >&2
    exit 2
  fi
  if [ -z "$OWN_SAID" ]; then rm -f "$CANARY_TMP"; CANARY_TMP=""; return 0; fi
  mv "$CANARY_TMP" "$target"
  CANARY_TMP=""
  say "wrote to the canary's env file, $CANARY_ENV: $OWN_SAID"
}

# Sets the canary database's postgres password to its env file's, through
# psql on the container's own socket. The value reaches psql in the exec's
# environment, never on a command line. Every `up` runs it: a canary volume
# made before SMD-2583 holds stable's password, and the one written later
# is the file's own.
#
# The plugins' login role (db/config.mjs PLUGIN_LOGIN_ROLE, ob1_plugins) the
# same way, where the canary's Postgres has one and its file sets
# OB1_PLUGIN_DB_PASSWORD (SMD-3032): migrate.ts makes the role with that
# password when it is absent and never changes it after (its "keeps the
# password it was made with"), so a canary whose role was made on stable's
# password, and whose file now holds one of its own, would fail its plugins'
# logins (review pass 1). A role is the cluster's, which the refresh leaves.
set_canary_password() {
  local pw plugin_pw
  # By value: a value spanning lines in the file could hold a line that reads
  # POSTGRES_PASSWORD= in `config --environment`'s output (review pass 3).
  pw="$(env_file value "$CANARY_ENV" POSTGRES_PASSWORD)"
  [ -n "$pw" ] || { echo "$CANARY_ENV sets no POSTGRES_PASSWORD." >&2; exit 1; }
  plugin_pw="$(env_file value "$CANARY_ENV" OB1_PLUGIN_DB_PASSWORD)"
  OB1_CANARY_PW="$pw" OB1_CANARY_PLUGIN_PW="$plugin_pw" "$RUNTIME" exec -i -e OB1_CANARY_PW -e OB1_CANARY_PLUGIN_PW "$1" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qX >/dev/null <<'SQL'
\getenv pw OB1_CANARY_PW
ALTER ROLE postgres PASSWORD :'pw';
\getenv plugin_pw OB1_CANARY_PLUGIN_PW
SELECT :'plugin_pw' <> '' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob1_plugins') AS set_plugin \gset
\if :set_plugin
ALTER ROLE ob1_plugins PASSWORD :'plugin_pw';
\endif
SQL
}
GIT_SHA="${OB1_GIT_SHA:-$(git -C "$REPO" describe --always --dirty 2>/dev/null || echo unknown)}"

# A running container of a project's service, by compose's labels: its name, or nothing.
container_of() {
  local id
  id="$("$RUNTIME" ps -q --filter "label=com.docker.compose.project=$1" --filter "label=com.docker.compose.service=$2" | head -n 1)"
  [ -n "$id" ] || return 0
  "$RUNTIME" inspect -f '{{.Name}}' "$id" | sed 's|^/||'
}

# The network a project's Postgres container is reached on: the project's
# `data` (SMD-2583), or `default` for a stack from before it; nothing when it
# is on neither. Never the other networks it may join, compose.host-ports.yaml's
# outward one among them.
db_network_of() {
  local nets
  # shellcheck disable=SC2016 # a Go template's variables, not the shell's
  nets="$("$RUNTIME" inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$1")"
  if grep -qxF "$2_data" <<<"$nets"; then echo "$2_data"
  elif grep -qxF "$2_default" <<<"$nets"; then echo "$2_default"
  fi
}

# One value from a database, through psql in its own container (the image's
# local socket; no password, nothing published).
psql_in() { "$RUNTIME" exec "$1" psql -U postgres -d openbrain -tAqc "$2"; }

# A database's ob1_config.tier, or nothing. Two statements, since a database
# with no ob1_config fails to parse one that names it.
stamp_of() {
  [ "$(psql_in "$1" "SELECT to_regclass('public.ob1_config') IS NOT NULL")" = t ] || return 0
  psql_in "$1" "SELECT value FROM ob1_config WHERE key = 'tier'"
}
# The refresh mark on a database, as tier.ts's refreshMark reads it: the
# database's own setting, and only a value a refresh writes (canary, working).
# `stable` or `off` there is an operator protecting it, not a mark.
mark_of() {
  psql_in "$1" "SELECT substr(c, length('ob1.refresh_target=') + 1)
    FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase, unnest(s.setconfig) c
    WHERE d.datname = current_database() AND s.setrole = 0
      AND c IN ('ob1.refresh_target=canary', 'ob1.refresh_target=working')"
}
# How many relations the public schema holds that no extension owns — tier.ts
# targetRefusal's "empty": 0 for a database nothing was restored into.
relations_in() {
  psql_in "$1" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')"
}

# The connector registered under NAME: CONN_SCOPE (user, local, project, or
# what `claude mcp get` said) and CONN_URL, empty for one with no URL (a stdio
# entry); both empty when there is none. Only those two lines are read, each by
# its label: `get` prints the key too. It exits non-zero for a name it does not
# know, which under pipefail would end the script here. `get` shows the entry
# that wins for this directory, so a local one hides a user one behind it.
CONN_URL=""
CONN_SCOPE=""
#
# CONN_KEY is the key the connector sends, its `x-brain-key` header or its
# URL's ?key=, or nothing: held in memory, never printed or written (piped
# through builtins, not a here-string, which bash 3.2 keeps in a temporary
# file), so `up` can say when the connector holds a key the canary does not
# take, however long ago that began (code review).
CONN_KEY=""
read_connector() {
  CONN_URL=""; CONN_SCOPE=""; CONN_KEY=""
  command -v claude >/dev/null 2>&1 || return 0
  local all got scope
  all="$({ claude mcp get "$NAME" 2>/dev/null || true; })"
  got="$(printf '%s\n' "$all" | sed -nE 's/^ *(URL|Scope): */\1 /p')"
  CONN_KEY="$(printf '%s\n' "$all" | sed -nE 's/^ *[Xx]-[Bb]rain-[Kk]ey: *//p' | head -n 1 | tr -d '\r' | sed 's/[[:space:]]*$//')"
  CONN_URL="$(sed -n 's/^URL //p' <<<"$got" | head -n 1)"
  [ -n "$CONN_KEY" ] || CONN_KEY="$(printf '%s\n' "$CONN_URL" | sed -nE 's/.*[?&]key=([^&]*).*/\1/p')"
  scope="$(sed -n 's/^Scope //p' <<<"$got" | head -n 1)"
  case "$scope" in
    "") CONN_SCOPE="" ;;
    User*) CONN_SCOPE=user ;; Local*) CONN_SCOPE=local ;; Project*) CONN_SCOPE=project ;;
    *) CONN_SCOPE="$scope" ;;
  esac
  [ -n "$CONN_SCOPE" ] || [ -z "$CONN_URL" ] || CONN_SCOPE=unknown
}
# The host port a container is bound to, running or stopped, or nothing.
port_of() {
  # shellcheck disable=SC2016 # a Go template's variables, not the shell's
  "$RUNTIME" inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}}{{"\n"}}{{end}}{{end}}' "$1" | head -n 1
}
# The canary's published container in any state, or nothing: its forwarder,
# the one container of the project that publishes a port (none for a canary
# still standing on stable's origin) — or the proxy of a canary stood
# up before the forwarder (SMD-2583), or the server of one stood up before
# the proxy (SMD-1846), each of which published the port itself until `up`
# recreates it, so that `up` and `down` know its port. Another project's
# (stable's) when one is named.
published_id() {
  local svc id
  for svc in forwarder proxy server; do
    id="$("$RUNTIME" ps -aq --filter "label=com.docker.compose.project=${1:-$CANARY}" --filter "label=com.docker.compose.service=$svc" | head -n 1)"
    if [ -n "$id" ] && [ -n "$(port_of "$id")" ]; then printf '%s\n' "$id"; return 0; fi
  done
}
# The host port the canary's published container is bound to, running or
# stopped (a reboot can leave it stopped: deploy/README.md, "After a reboot"),
# or nothing; another project's when one is named.
published_port() {
  local id
  id="$(published_id "${1:-}")"
  [ -n "$id" ] || return 0
  port_of "$id"
}
# The ports a canary proxy of this project answers on, or did: --port (or the
# env file's, which `up` takes when none is given), the env file's own, and the
# one its published container is bound to (a `down` given no --port). Never
# stable's: a canary file made while the canary answered on stable's origin
# names stable's port, and a connector there (stable's /mcp, or /canary/mcp)
# is stable's, not the canary's to replace or remove (review pass 1).
#
# The port its container published when this run began counts too: an `up`
# that moves the forwarder to the file's new port (a retry after a failed
# `--port` run, a hand edit of SERVER_PORT) would otherwise lose the old one
# before naming a connector left there (code review).
canary_ports() {
  local p
  for p in "$PORT" "$FILE_PORT" "$WAS_PUBLISHED" "$(published_port)"; do
    if [ -n "$p" ] && ! stable_port "$p"; then printf '%s\n' "$p"; fi
  done
}
# Whether a port is stable's: its env file's, or the one it publishes.
stable_port() { [ "$1" = "$STABLE_SERVER_PORT" ] || [ "$1" = "${STABLE_PUBLISHED:-$STABLE_SERVER_PORT}" ]; }
# A connector URL as printed: without its query, where the documented form
# carries the key (`?key=`).
shown() { case "$1" in *\?*) printf '%s?…' "${1%%\?*}" ;; *) printf '%s' "$1" ;; esac; }
# A URL's port and path, its query and a trailing slash dropped: where it
# reaches, whichever spelling of the host it uses.
ENDPOINT_URL='^http://(\[[^]]*\]|[^:/]+):([0-9]+)(/.*)?$'
endpoint_of() {
  local u="${1%%\?*}"
  if [[ "$u" =~ $ENDPOINT_URL ]]; then printf '%s %s' "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]%/}"; else printf '%s' "$u"; fi
}
# Whether a connector URL is this canary's: http on one of its proxy's
# loopback ports, with any path and any query (`?key=` is the documented form).
# A URL at /canary/mcp on stable's origin, where a canary answered from
# SMD-2294 to SMD-2874, is stable's port, and not the canary's to remove.
# OURS_PORTS, when set, is canary_ports read once (`down`).
ours() {
  local p ports
  if [ -n "${OURS_PORTS+set}" ]; then ports="$OURS_PORTS"; else ports="$(canary_ports)"; fi
  for p in $ports; do
    case "$1" in "http://127.0.0.1:$p"|"http://127.0.0.1:$p/"*|"http://127.0.0.1:$p?"*|"http://localhost:$p"|"http://localhost:$p/"*|"http://localhost:$p?"*) return 0 ;; esac
  done
  return 1
}

# Every runtime call below, and every compose read of an env file, assumes the
# runtime answers: said once here, first, rather than as a bare `ps` failure
# under set -e or a compose read waiting out its timeout (code review).
"$RUNTIME" ps -q > /dev/null 2>&1 || { echo "$RUNTIME does not answer (\`$RUNTIME ps\` failed): start it (podman machine start, or Docker's daemon) and re-run." >&2; exit 2; }
# The port the canary's env file names (SMD-2874), when it names one: `up`
# takes it when no --port is given, and `down` counts a connector there as
# the canary's. Only from a file that holds the canary's own tier, which `up`
# writes with the port: a file made before SMD-2874 holds stable's tier and
# the port stable had then, which a stable that has moved since would no
# longer name as its own (code review). FILE_PORT_SAID is what the file says,
# for messages. A file compose cannot read names none here; `up`'s guard
# below refuses it.
FILE_PORT=""
FILE_PORT_SAID=""
if [ -f "$CANARY_ENV" ]; then
  file_tier=""
  { IFS= read -r FILE_PORT_SAID || true; IFS= read -r file_tier || true; } < <(env_file values "$CANARY_ENV" SERVER_PORT OB1_TIER 2>/dev/null || true)
  if [ "$file_tier" = canary ] && is_port "$FILE_PORT_SAID"; then FILE_PORT="$FILE_PORT_SAID"; fi
fi
# Stable's port: the one stable's env file names (SERVER_PORT, else
# compose.yaml's 8000). `up` refuses it as the canary's, and no connector at it
# is the canary's.
STABLE_SERVER_PORT="$(env_file value "$ENV_FILE" SERVER_PORT 2>/dev/null)" || STABLE_SERVER_PORT=""
STABLE_SERVER_PORT="${STABLE_SERVER_PORT:-8000}"
# …and the one stable's forwarder (its proxy, before SMD-2583) publishes,
# running or stopped, should the shell or an overlay have given it another
# (review pass 2).
STABLE_PUBLISHED="$(published_port "$STABLE")"
# The canary's own published port as this run begins (canary_ports).
WAS_PUBLISHED="$(published_port)"

if [ "$CMD" = down ]; then
  # compose's name for the file's `pgdata` volume, which `down --volumes`
  # removes by name, labelled or not: so it is looked for by name here too.
  VOLUME="${CANARY}_pgdata"
  HAS_VOLUME=""
  ! "$RUNTIME" volume inspect "$VOLUME" >/dev/null 2>&1 || HAS_VOLUME=1
  if [ $VOLUMES = 1 ] && [ -n "$HAS_VOLUME" ]; then
    pg="$(container_of "$CANARY" postgres)"
    FOUND=running
    if [ -z "$pg" ]; then
      # Stopped, or removed by a plain `down`: started on its volume to be
      # read, and put back as it was if the answer is no.
      if [ -n "$("$RUNTIME" ps -aq --filter "label=com.docker.compose.project=$CANARY" --filter "label=com.docker.compose.service=postgres")" ]; then FOUND=stopped; else FOUND=absent; fi
      canary_compose up -d --wait postgres >&2
      pg="$(container_of "$CANARY" postgres)"
    fi
    # A canary by its stamp, by the mark a refresh left (one that died after
    # its restore leaves stable's stamp behind), or by holding nothing.
    stamp="$(stamp_of "$pg")"
    mark="$(mark_of "$pg")"
    held="$(relations_in "$pg")"
    [ "$stamp" = canary ] || [ -n "$mark" ] || [ "$held" = 0 ] || {
      case "$FOUND" in
        stopped) canary_compose stop postgres >/dev/null 2>&1 || true ;;
        absent) canary_compose down >/dev/null 2>&1 || true ;;
      esac
      echo "the canary's database ($pg) is stamped '${stamp:-nothing}', carries no refresh mark and holds $held relations — refusing to delete its volume. Take it down without --volumes, and look at it first." >&2
      exit 2
    }
  fi
  VOLS=()
  [ $VOLUMES = 0 ] || VOLS=(--volumes)
  # The connector is judged now, while the proxy container still says the
  # canary's port, and removed after the compose down, so a down that fails
  # leaves it registered.
  read_connector
  OURS_PORTS="$(canary_ports | sort -un)"
  SEEN_PORTS="$(tr '\n' ' ' <<<"$OURS_PORTS" | sed 's/ $//')"
  CONN_ACTION=""
  if [ -n "$CONN_URL" ] && ours "$CONN_URL" && [ "$CONN_SCOPE" = user ]; then CONN_ACTION=remove
  elif [ -n "$CONN_URL" ] && ours "$CONN_URL"; then CONN_ACTION=other-scope
  elif [ -n "$CONN_SCOPE" ]; then CONN_ACTION=foreign
  fi
  # The coordinator and its dump volume are default services' since
  # SMD-3476, so a down with no profile counts both; --remove-orphans takes a
  # container of a service it replaced (sleep, board-sync, extract,
  # consolidate) left by a canary from before it.
  canary_compose down --remove-orphans ${VOLS[@]+"${VOLS[@]}"}
  # A canary from before SMD-2583 made a default network, which compose.yaml
  # no longer names, so `down` leaves it: removed here when compose made it
  # for this project and nothing is on it.
  old_net="${CANARY}_default"
  if [ "$("$RUNTIME" network inspect -f '{{index .Labels "com.docker.compose.project"}}' "$old_net" 2>/dev/null || true)" = "$CANARY" ] \
    && [ -z "$("$RUNTIME" ps -aq --filter "network=$old_net")" ]; then
    if "$RUNTIME" network rm "$old_net" >/dev/null 2>&1; then say "removed $old_net, the canary's network from before SMD-2583"; fi
  fi
  case "$CONN_ACTION" in
    remove)
      if claude mcp remove --scope user "$NAME" >/dev/null 2>&1; then say "connector $NAME removed"
      else say "connector $NAME: \`claude mcp remove --scope user $NAME\` failed — remove it by hand"
      fi ;;
    other-scope) say "connector $NAME is in $CONN_SCOPE scope, not user — left as it is (claude mcp remove -s $CONN_SCOPE $NAME)" ;;
    foreign)
      at="$(endpoint_of "$CONN_URL")"
      if [ "${at#* }" = /canary/mcp ] && stable_port "${at%% *}"; then
        say "connector $NAME points at $(shown "$CONN_URL"), on $STABLE's origin, where the canary answered before SMD-2874 — stable's URL now, left as it is: claude mcp remove --scope $CONN_SCOPE $NAME removes it"
      else
        say "connector $NAME points at $(shown "${CONN_URL:-no URL (a stdio entry)}"), not this canary's (a port of its proxy on loopback${SEEN_PORTS:+: $SEEN_PORTS}) — left as it is (if it is a canary proxy's, pass the --port it was stood up with)"
      fi ;;
  esac
  if [ $VOLUMES = 0 ]; then say "canary down; $STABLE untouched"
  elif [ -n "$HAS_VOLUME" ]; then say "canary down, its database deleted; $STABLE untouched"
  else say "canary down; no canary volume ($VOLUME), nothing to delete; $STABLE untouched"
  fi
  exit 0
fi

# ── up ──────────────────────────────────────────────────────────────────────
# The canary's own env file, when it has one, on every `up` (an edit can undo
# it; review pass 3), first: before anything changes, and before compose
# reads it below, whose own message for a broken file names deploy/.env
# (pass 5). A POSTGRES_PASSWORD of its own and nothing of stable's database
# password. A file this run makes is checked as it is made (env_file made).
if [ -f "$CANARY_ENV" ] && ! why="$(env_file guard "$ENV_FILE" "$CANARY_ENV" 2>&1)"; then
  echo "the canary's env file, $CANARY_ENV: ${why:-compose did not answer} — it must hold a POSTGRES_PASSWORD of the canary's own and nothing of stable's. Fix it, or delete it to make it again." >&2
  exit 2
fi
# A file made before SMD-2873 names no project, so a compose command given it
# alone acts on compose.yaml's default, open-brain, not the canary.
if [ -f "$CANARY_ENV" ] && [ -z "$(env_file project "$CANARY_ENV" 2>/dev/null)" ]; then
  say "note: the canary's env file, $CANARY_ENV, names no project: add COMPOSE_PROJECT_NAME=$CANARY to it, so a compose command given that file alone acts on the canary, not on compose.yaml's default (open-brain)"
fi

# The canary's port (SMD-2874): --port, else its env file's — never stable's,
# which a canary file made while it answered on stable's origin names as its
# own.
if [ -z "$PORT" ]; then
  if [ -n "$FILE_PORT" ] && ! stable_port "$FILE_PORT"; then PORT="$FILE_PORT"
  elif [ -f "$CANARY_ENV" ]; then
    echo "the canary's env file, $CANARY_ENV, names no port of its own (its SERVER_PORT: ${FILE_PORT_SAID:-none}, and a file made before SMD-2874 holds stable's; stable's: $STABLE_SERVER_PORT${STABLE_PUBLISHED:+, published $STABLE_PUBLISHED}) — name one with --port N, a free port on this host's loopback, which up writes there." >&2
    exit 2
  else
    echo "the canary answers on a port of its own: name it with --port N, a free port on this host's loopback. up writes it to the canary's env file ($CANARY_ENV), which later runs read." >&2
    exit 2
  fi
fi
! stable_port "$PORT" || { echo "port $PORT is stable's (SERVER_PORT in $ENV_FILE, or compose.yaml's 8000, or the port its forwarder publishes): the canary answers on one of its own." >&2; exit 2; }

# The canary's env file is written with deploy/env-file.ts (SMD-2874 PR 2).
command -v bun > /dev/null 2>&1 || { echo "up needs bun on PATH: deploy/env-file.ts writes the canary's own keys and settings to its env file." >&2; exit 2; }

# Where the canary's REST core would send its model calls, as compose
# resolves them for it (the fallbacks included), and its telemetry: the REST
# core holds both, the server's model knobs and the OTEL block (`server`, which
# held none from SMD-2287 PR 5b, retired in PR 6b). A bare name is a service on the
# network the server is on, and the canary's has none of stable's; an address
# (a dotted name, IPv4 or IPv6) is reached as stable reaches it.
CONFIG_ERR="$(mktemp "${TMPDIR:-/tmp}/ob1-canary-config.XXXXXX")"
said="$(canary_compose config --format json 2>"$CONFIG_ERR" | python3 -c '
import json, sys
from urllib.parse import urlparse
env = json.load(sys.stdin)["services"]["api"].get("environment") or {}
for k in ("OB1_LLM_BASE_URL", "OB1_CHAT_BASE_URL", "OB1_JEV_BASE_URL"):
    host = urlparse(env.get(k) or "").hostname or ""
    if host and "." not in host and ":" not in host and host != "localhost":
        print(f"{k}={env[k]}")
print("OTLP=" + (env.get("OTEL_EXPORTER_OTLP_ENDPOINT") or ""))
')" || { echo "could not read the canary's configuration through \`$RUNTIME compose config --format json\` (Docker Compose v2): $(head -c 400 "$CONFIG_ERR")" >&2; exit 2; }
unreachable="$(grep -v -e '^OTLP=' <<<"$said" || true)"
# Stable's observability collector, by its name on stable's mesh (SMD-1849
# PR 3a), in any case: the canary is not on that mesh, so each of its servers
# would say ENOTFOUND once a minute per signal.
OTLP_ENDPOINT="$(sed -n 's/^OTLP=//p' <<<"$said")"
case "$(tr '[:upper:]' '[:lower:]' <<<"$OTLP_ENDPOINT")" in
  *lgtm.ob1.internal*) say "note: the canary's servers would send their telemetry to $OTLP_ENDPOINT, stable's collector, which the canary's networks cannot reach — each would say ENOTFOUND once a minute per signal; OTEL_EXPORTER_OTLP_ENDPOINT= deploy/canary.sh … up, an empty one in the shell, keeps it out" ;;
esac
[ -z "$unreachable" ] || {
  echo "the canary's server would dial $(tr '\n' ' ' <<<"$unreachable")— a bare name, which on the canary's network resolves to nothing: stable's compose services (a profile's ollama or jev) are on stable's network. Name an endpoint it can reach for the canary alone, in the shell, which wins over the env file for the canary's server and leaves stable's as it is: OB1_LLM_BASE_URL=http://host.docker.internal:11434/v1 deploy/canary.sh … up for an Ollama on the host (podman: host.containers.internal), a host's full name for one on the LAN. It must serve the brain's embedding model. A remote provider also needs OB1_LLM_LOCAL= cleared there, or the egress gate takes it for local." >&2
  exit 2
}

STABLE_PG="$(container_of "$STABLE" postgres)"
[ -n "$STABLE_PG" ] || { echo "no running Postgres in compose project $STABLE ($FROM_WHERE) — start the stack first, or name it with --stable-project." >&2; exit 2; }
# Whether `up` keeps the canary's database or refreshes it from stable
# (SMD-3155), decided before anything changes. Its volume is compose's name
# for the file's `pgdata`, as `down --volumes` reads it. A running Postgres
# there is asked now: a database holding no relations has nothing to keep, so
# a plain `up` stands it up from stable, and one stamped other than canary is
# refused, naming --refresh (a refresh that died before its last step leaves
# stable's copy, stamped stable). A stopped one is asked once it is started,
# below, after the writers stop. --no-refresh keeps or refuses (SMD-3154).
# The volume list must answer: a failed one read as "no volume" would refresh
# a canary that has one (review pass 1). A running database holding relations
# is kept by default whatever the list says.
volumes="$("$RUNTIME" volume ls --format '{{.Name}}')" \
  || { echo "$RUNTIME volume ls failed, so up cannot tell whether the canary has a database to keep — re-run up once it answers. Nothing changed." >&2; exit 2; }
HAS_VOLUME=0
grep -qxF "${CANARY}_pgdata" <<<"$volumes" && HAS_VOLUME=1
if [ "$REFRESH" = 0 ] && [ $HAS_VOLUME = 0 ]; then
  echo "--no-refresh keeps the canary's database, and $CANARY has none (no volume ${CANARY}_pgdata) — run up without it, which stands one up from stable." >&2
  exit 2
fi
HELD=""
LIVE_PG="$(container_of "$CANARY" postgres)"
if [ -n "$LIVE_PG" ]; then
  HELD="$(relations_in "$LIVE_PG" 2>/dev/null)" || HELD=""
fi
KEPT_BY_DEFAULT=0
if [ -z "$REFRESH" ]; then
  if { [ -z "$HELD" ] || [ "$HELD" = 0 ]; } && { [ $HAS_VOLUME = 0 ] || [ "$HELD" = 0 ]; }; then
    REFRESH=1
    say "no canary database to keep (${CANARY}_pgdata $([ $HAS_VOLUME = 0 ] && echo "does not exist" || echo "holds no relations")): it is stood up from stable"
  else
    REFRESH=0
    KEPT_BY_DEFAULT=1
  fi
fi
if [ $REFRESH = 0 ] && [ -n "$HELD" ] && [ "$HELD" != 0 ]; then
  held_stamp="$(stamp_of "$LIVE_PG" 2>/dev/null)" || held_stamp="?"
  [ "$held_stamp" = canary ] || { echo "the canary's database ($LIVE_PG) is stamped '${held_stamp:-nothing}', not canary — a refresh that died before its last step leaves stable's copy, and migrating it in place would keep that as the canary's. Run up --refresh to finish one. Nothing changed." >&2; exit 2; }
fi
# Said once the database has been asked: here where its Postgres runs, after
# the checks below where it was stopped.
[ $KEPT_BY_DEFAULT = 0 ] || [ -z "$HELD" ] || say "the canary's database is kept and migrated in place, its own rows with it (--refresh replaces it with stable's)"
[ $REFRESH = 0 ] || RERUN="up --refresh"
# The writers `up` stops are its servers and its coordinator (SMD-3476), and
# it removes the containers of the services the coordinator replaced; one of
# another profile (the import runner, the database monitor) would write
# through the refresh or the migration, so it is refused here, before
# anything changes (SMD-3154).
running="$("$RUNTIME" ps --filter "label=com.docker.compose.project=$CANARY" --format '{{.Label "com.docker.compose.service"}}')" \
  || { echo "$RUNTIME ps failed, so up cannot tell which of the canary's services write — re-run $RERUN once it answers." >&2; exit 2; }
others="$(grep -xE 'orchestration-runner|orchestration-runner-role|pg-monitor-role' <<<"$running" | sort -u | tr '\n' ' ')" || others=""
[ -z "${others// /}" ] || { echo "the canary runs ${others% }, which would write while up changes its database — stop it first ($RUNTIME compose -p $CANARY stop ${others% }), then re-run $RERUN." >&2; exit 2; }
STABLE_DB_NET="$(db_network_of "$STABLE_PG" "$STABLE")"
[ -n "$STABLE_DB_NET" ] || [ $REFRESH = 0 ] || { echo "$STABLE_PG is on neither ${STABLE}_data nor ${STABLE}_default, so the refresh could not reach it — recreate stable's Postgres (compose up -d postgres)." >&2; exit 2; }

# The port is the canary's or free: a container of another project on it
# would take the canary proxy's place.
taken="$("$RUNTIME" ps --format '{{.Names}}|{{.Ports}}|{{.Label "com.docker.compose.project"}}' \
  | awk -F'|' -v p=":$PORT->" -v c="$CANARY" 'index($2, p) && $3 != c { print $1 }')"
[ -z "$taken" ] || { echo "port $PORT is published by $taken, outside project $CANARY — pick another --port (or, if $taken is a canary stood up by hand, remove it: this canary keeps its own database, or is stood up from stable where it has none)." >&2; exit 2; }
# … or a process on the host, which no container list shows: a connection to
# the port succeeds while the canary's own proxy does not publish it.
# Its own proxy's port is read from the container while it runs or is still
# stopping (podman finishes a stop a Ctrl-C interrupted, answering meanwhile).
own=""
own_id="$(published_id)"
if [ -n "$own_id" ]; then
  case "$("$RUNTIME" inspect -f '{{.State.Status}}' "$own_id" 2>/dev/null || true)" in
    running|stopping|restarting) own="$(published_port)" ;;
  esac
fi
if [ "$own" != "$PORT" ] && (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  echo "something on this host already listens on 127.0.0.1:$PORT — stop it, or pick another --port." >&2
  exit 2
fi

if [ $CONNECT = 1 ]; then
  command -v claude >/dev/null 2>&1 || { echo "--connect needs the claude CLI on PATH." >&2; exit 2; }
  read_connector
  if [ -n "$CONN_SCOPE" ] && { [ -z "$CONN_URL" ] || ! ours "$CONN_URL" || [ "$CONN_SCOPE" != user ]; }; then
    echo "a connector named $NAME is already registered ($CONN_SCOPE scope, $(shown "${CONN_URL:-no URL}")), and is not this canary's at user scope — left as it is. Remove it, or pass --name." >&2
    # One left at /canary/mcp, where the canary answered on stable's origin
    # from SMD-2294 to SMD-2874: stable's port, which the canary no longer is.
    at="$(endpoint_of "$CONN_URL")"
    if [ "${at#* }" = /canary/mcp ] && stable_port "${at%% *}"; then
      echo "(it is where the canary answered on $STABLE's origin before SMD-2874; it moves to its own port: claude mcp remove --scope $CONN_SCOPE $NAME, then this up --connect again)" >&2
    elif [ "${at#* }" = /mcp ] && ! stable_port "${at%% *}"; then
      # A port the canary has moved off, in a run that failed after the move
      # (code review): no longer the canary's to replace.
      echo "(if it is this canary's at a port it has since moved off, remove it: claude mcp remove --scope $CONN_SCOPE $NAME, then this up --connect again)" >&2
    fi
    exit 2
  fi
fi

# The record carries no refresh mark and no tier stamp but stable's; a
# database with either is a copy a refresh made (or may reset).
stable_mark="$(mark_of "$STABLE_PG")"
[ -z "$stable_mark" ] || { echo "$STABLE_PG carries the refresh mark '$stable_mark' — it is a tier copy, not the record. Refusing: name stable's project with --stable-project." >&2; exit 2; }
stable_stamp="$(stamp_of "$STABLE_PG")"
case "$stable_stamp" in
  stable|"") ;;
  *) echo "$STABLE_PG is stamped tier '$stable_stamp' — it is a tier copy, not the record. Refusing: name stable's project with --stable-project." >&2; exit 2 ;;
esac

# The canary's own env file (SMD-2583), made from stable's the first time —
# after every other refusal and before stable's stamp, the first change, so a
# file that cannot be made is a refusal like the rest (review pass 5). After
# that it is the canary's, and `up` names what differs from stable's (names
# only), since a change to stable's no longer reaches the canary.
if [ ! -f "$CANARY_ENV" ]; then
  make_canary_env
  OWN_KEYS=1
  say "made the canary's env file, $CANARY_ENV, from $ENV_FILE: its database password, its port, $PORT, and its access keys are its own — $OWN_SAID"
else
  drift="$(env_file drift "$ENV_FILE" "$CANARY_ENV" 2>/dev/null)" || drift=""
  [ -z "$drift" ] || say "note: the canary's env file ($CANARY_ENV) differs from stable's on $drift — it is the canary's own since its first up; edit it to carry a change across"
  # A --port that is not the file's is the canary's port from now on, and a
  # file made before SMD-2874 takes the canary's own address, tier, profiles
  # and keys where it held stable's.
  set_canary_own
  OWN_KEYS=1
fi
# Whether the canary has a key of its own (SMD-3312), read once, its file being
# final now (step 2 has cleared stable's), and before anything stops, so a read
# that fails leaves nothing down (review pass 3) and stops the run, never
# reading as no key: as compose reads the file, spaces aside, so a key of only
# spaces starts nothing that can only fail (review pass 2).
BOARD_ADD="set the LINEAR_API_KEY line in $CANARY_ENV (one line) to a key of the canary's own — a Linear personal API key made with Read access alone, never stable's — and re-run $RERUN"
BOARD_KEY=""
board_value=""
if ! board_value="$(env_file value "$CANARY_ENV" LINEAR_API_KEY)"; then
  echo "could not read LINEAR_API_KEY from $CANARY_ENV through compose: fix the file, then re-run $RERUN." >&2
  exit 1
fi
[ -z "$(printf '%s' "$board_value" | tr -d '[:space:]')" ] || BOARD_KEY=1
board_value=""
# The canary's own write key (SMD-2874 PR 2), for the smoke and the
# connector: stable's keys open it no more.
KEY="$(env_file value "$CANARY_ENV" OB1_CANARY_KEY)"
[ -n "$KEY" ] || { echo "the canary's env file, $CANARY_ENV, holds no OB1_CANARY_KEY after it was given one." >&2; exit 1; }

if [ -z "$stable_stamp" ]; then
  psql_in "$STABLE_PG" "INSERT INTO ob1_config (key, value) VALUES ('tier', 'stable') ON CONFLICT (key) DO NOTHING" >/dev/null
  say "stamped $STABLE_PG tier=stable (it had no tier stamp)"
fi
stable_server="$(container_of "$STABLE" api)"
if [ -n "$stable_server" ] && ! "$RUNTIME" inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$stable_server" | grep -qx 'OB1_TIER=stable'; then
  say "note: $stable_server runs without OB1_TIER=stable — set it in $ENV_FILE and recreate the REST core (up -d api), so its query log says which tier answered"
fi

# A standing canary's servers would serve the copy mid-restore (through the
# registered connector, stamped stable by the restore until the refresh
# stamps it), and write rows the restore then collides with; both are
# recreated below either way. They, and a running coordinator, stop before
# the canary's Postgres is touched: compose recreates it when its own
# configuration changed, and a writer's transaction then dies mid-flight
# (SMD-3154).
# The images first, while the canary still serves: a build that fails leaves
# nothing stopped, and the writers stay down only for the change itself
# (SMD-3154).
say "canary images (commit $GIT_SHA)"
canary_compose build api
[ $REFRESH = 1 ] || canary_compose build migrate
FOR="the refresh"
[ $REFRESH = 1 ] || FOR="the migration"
WRITERS_STOPPED=1
# The canary's `server`, the MCP server server-portable/index.ts was, retired in
# SMD-2287 PR 6b: a canary stood up before then keeps its container, which this
# compose.yaml no longer names, so compose would leave it running beside the
# stack, an orphan holding connections to the canary's database. Found by its
# project's and service's labels, running or stopped; stopped first, within the
# canary's own grace (OB1_STOP_GRACE in its env file, 10 unless set; passed
# explicitly, as the coordinator's is below, rather than trusted to the
# runtime's reading of compose's StopTimeout, which podman's is not measured
# here), so a call in flight drains and its stop writes its own jobs lost
# (review passes 6b·4 to 6b·6), then removed.
retired="$("$RUNTIME" ps -aq --filter "label=com.docker.compose.project=$CANARY" --filter "label=com.docker.compose.service=server")"
if [ -n "$retired" ]; then
  grace="$(env_file value "$CANARY_ENV" OB1_STOP_GRACE 2>/dev/null || true)"
  [[ "$grace" =~ ^[0-9]+$ ]] || grace=10
  printf '%s\n' "$retired" | xargs "$RUNTIME" stop -t "$grace" >/dev/null 2>&1 || true
  printf '%s\n' "$retired" | xargs "$RUNTIME" rm -f >/dev/null
  say "the canary's server container, retired in SMD-2287 PR 6b, removed"
fi
STOPPED_API=""
if [ -n "$(container_of "$CANARY" api)" ]; then
  say "canary REST core stopped for $FOR"
  canary_compose stop api >/dev/null
  STOPPED_API=1
fi
# The coordinator writes as its passes run (sleep, the workers, board-sync),
# so it stops too, and step 6 brings it back on the new build once the smoke
# has passed (SMD-3476; the sleep worker's rule, SMD-3154, and board-sync's,
# SMD-3312). Stopped as the containers they are, by name, within the
# service's 120 s grace: compose's own stop finds only a container this
# compose file made. Every running one, not the first alone: a second (a
# `compose run`) would write through the change too (SMD-3312 review pass 3).
COORD_RUNNING="$("$RUNTIME" ps -q --filter "label=com.docker.compose.project=$CANARY" --filter "label=com.docker.compose.service=coordinator")"
COORD_SAID=""
if [ -n "$COORD_RUNNING" ]; then
  say "canary coordinator stopped for $FOR"
  printf '%s\n' "$COORD_RUNNING" | xargs "$RUNTIME" stop -t 120 >/dev/null
  COORD_PENDING=1
fi
# The services the coordinator replaced (SMD-3476): a canary stood up before
# it keeps their containers, which this compose.yaml no longer names, so
# compose would leave them beside the stack, writing. Each, running or
# stopped, is stopped within the longest grace and removed, said, as the
# retired `server` is above; which ones were running is kept for OB1_PASSES.
RETIRED_RAN=""
RETIRED_IDLE=""
for retired_svc in sleep board-sync extract consolidate; do
  retired_cts="$("$RUNTIME" ps -aq --filter "label=com.docker.compose.project=$CANARY" --filter "label=com.docker.compose.service=$retired_svc")"
  [ -n "$retired_cts" ] || continue
  if [ -n "$("$RUNTIME" ps -q --filter "label=com.docker.compose.project=$CANARY" --filter "label=com.docker.compose.service=$retired_svc")" ]; then RETIRED_RAN="$RETIRED_RAN $retired_svc"; else RETIRED_IDLE="$RETIRED_IDLE $retired_svc"; fi
  printf '%s\n' "$retired_cts" | xargs "$RUNTIME" stop -t 120 >/dev/null 2>&1 || true
  printf '%s\n' "$retired_cts" | xargs "$RUNTIME" rm -f >/dev/null
  say "the canary's $retired_svc container, retired in SMD-3476 (the coordinator runs its pass), removed"
done
# Once, for a canary from before the coordinator: the passes its retired
# containers were running, written to its env file where it names none, so
# the coordinator runs them on (deploy/env-file.ts, the value on stdin).
# A stopped one is not carried — it may be stopped on purpose — but said, so its pass is not lost unseen.
[ -z "$RETIRED_IDLE" ] || say "note: the canary's${RETIRED_IDLE} container(s) were stopped, so their passes are not carried into OB1_PASSES: name them in $CANARY_ENV's OB1_PASSES to run them"
# The file's OB1_PASSES, read once: here when the carry-over needs it, below otherwise.
PASSES_RAW=""
PASSES_READ=""
if [ -n "$RETIRED_RAN" ]; then
  COORD_PENDING=1
  # Read first, a failed read stopping the run: in the test's own substitution it would read as none and overwrite the line.
  passes_now=""
  if ! passes_now="$(env_file value "$CANARY_ENV" OB1_PASSES)"; then
    echo "could not read OB1_PASSES from $CANARY_ENV through compose: fix the file, then re-run $RERUN." >&2
    exit 1
  fi
  PASSES_RAW="$passes_now"
  PASSES_READ=1
  if [ -z "$(printf '%s' "$passes_now" | tr -d '[:space:]')" ]; then
    carried=""
    case " $RETIRED_RAN " in *" sleep "*) carried="sleep" ;; *" extract "*|*" consolidate "*) carried="workers" ;; esac
    case " $RETIRED_RAN " in *" board-sync "*) carried="${carried:+$carried,}board-sync" ;; esac
    if [ -n "$carried" ]; then
      printf '{"OB1_PASSES": "%s"}' "$carried" | bun --no-env-file "$HERE/env-file.ts" set "$CANARY_ENV" >/dev/null \
        || { echo "could not write OB1_PASSES=$carried to $CANARY_ENV: set it there yourself and re-run $RERUN." >&2; exit 1; }
      say "wrote to the canary's env file, $CANARY_ENV: OB1_PASSES=\"$carried\" (the passes its retired containers were running, which the coordinator runs now)"
      PASSES_RAW="$carried"
    fi
  fi
fi
[ -z "$COORD_PENDING" ] || COORD_SAID=" The coordinator is stopped too: the next run that passes starts it again."
# The canary's passes as its file now holds them, board-sync's among them
# read here, the file final now, for the advice of a run that fails.
if [ -z "$PASSES_READ" ] && ! PASSES_RAW="$(env_file value "$CANARY_ENV" OB1_PASSES)"; then
  echo "could not read OB1_PASSES from $CANARY_ENV through compose: fix the file, then re-run $RERUN." >&2
  exit 1
fi
BOARD_NAMED=""
case ",$(printf '%s' "$PASSES_RAW" | tr -s ' \t' ',,')," in *,board-sync,*) BOARD_NAMED=1 ;; esac

say "canary Postgres"
canary_compose up -d --wait postgres
CANARY_PG="$(container_of "$CANARY" postgres)"
# A volume whose database holds nothing (a first up that died before its
# restore, a hand-run postgres) is no canary to keep (SMD-3154), nor one
# stamped other than canary (SMD-3155): asked here where its Postgres was
# stopped when the run began.
if [ $REFRESH = 0 ] && [ "$(relations_in "$CANARY_PG")" = 0 ]; then
  ADVISED=1
  echo "the canary's database ($CANARY_PG) holds no relations, so there is nothing to keep — run up --refresh, which stands one up from stable.$COORD_SAID" >&2
  exit 1
fi
if [ $REFRESH = 0 ] && [ "$(stamp_of "$CANARY_PG")" != canary ]; then
  ADVISED=1
  echo "the canary's database ($CANARY_PG) is stamped '$(stamp_of "$CANARY_PG")', not canary — a refresh that died before its last step leaves stable's copy, and migrating it in place would keep that as the canary's. Run up --refresh to finish one.$COORD_SAID" >&2
  exit 1
fi
[ $KEPT_BY_DEFAULT = 0 ] || [ -n "$HELD" ] || say "the canary's database is kept and migrated in place, its own rows with it (--refresh replaces it with stable's)"
# With its servers stopped, the canary's database takes its env file's
# password; they come back below on that file.
set_canary_password "$CANARY_PG"
# Whether stable holds a thought the probe could use (a vector from the
# brain's model), read before the refresh: a canary with none after it is a
# migration that emptied them or a model switch, not an empty brain.
# In place, the canary's own vectors before its migration stand in for
# stable's (SMD-3154).
VECTORS_FROM="$STABLE_PG"
[ $REFRESH = 1 ] || VECTORS_FROM="$CANARY_PG"
stable_vectors="$(psql_in "$VECTORS_FROM" "SELECT count(*) FROM (SELECT 1 FROM thoughts WHERE embedding IS NOT NULL
  AND coalesce(embedding_model = (SELECT value FROM ob1_config WHERE key = 'embedding_model'), true) LIMIT 1) t")"
if [ $REFRESH = 1 ]; then
  say "refresh $STABLE_PG → $CANARY_PG"
  refresh_rc=0
  # Each half on its own project's network (SMD-2875); the canary's project
  # names the image tier.sh builds, so stable's own tier runs keep theirs.
  "$HERE/tier.sh" --runtime "$RUNTIME" --env-file "$CANARY_ENV" --from-env-file "$ENV_FILE" \
    --project "$CANARY" --network "${CANARY}_data" --from-network "$STABLE_DB_NET" \
    --refresh --from "$STABLE_PG" --to "$CANARY_PG" --tier canary || refresh_rc=$?
  if [ "$refresh_rc" != 0 ]; then
    # tier.sh's own usage errors exit 2, which from here would read as "refused
    # before anything changed" — stable may be stamped by now, a server stopped.
    ADVISED=1
    [ -z "$STOPPED_API" ] || echo "the canary's servers are stopped (for the refresh), so a connector registered for it answers nothing until \`up\` succeeds." >&2
    echo "the refresh failed (tier.sh exit $refresh_rc). Re-run $RERUN once that is fixed: the canary carries the refresh mark, so the retry resets it; a plain up refuses the copy it left.$COORD_SAID" >&2
    exit 1
  fi
  # The copy is stamped canary now: a later failure's re-run keeps it, and
  # another refresh would lose what was written since (review pass 1).
  RERUN="up"
else
  # In place (SMD-3154): this checkout's migrate on the canary's own database,
  # its rows kept. A one-shot run, not `up`, which would stay attached.
  say "migrate $CANARY_PG in place (commit $GIT_SHA): its rows kept, nothing copied from $STABLE_PG"
  migrate_rc=0
  canary_compose run --rm --no-deps migrate || migrate_rc=$?
  if [ "$migrate_rc" != 0 ]; then
    ADVISED=1
    left=""
    [ -z "$COORD_PENDING" ] || left=" The coordinator is stopped too: leave it so until a run succeeds, since this checkout's passes expect the new schema."
    echo "the canary's migration failed (exit $migrate_rc), and its servers are stopped: fix the cause above and re-run $RERUN.$left" >&2
    exit 1
  fi
fi

say "canary servers, MCP and REST core (commit $GIT_SHA)"
# The REST core builds the server image the MCP server and the GUI run by name:
# recreated, it runs the build just made, not the one it was stopped on.
canary_compose up -d --no-deps --force-recreate api
# And the MCP server built on it (SMD-2287), which /mcp reaches, on the same
# image: recreated last, on the build just made and the env file's own
# OB1_FORWARDER_KEY. It writes nothing, so it was not stopped for the refresh.
canary_compose up -d --no-deps --force-recreate mcp
# And the operator GUI at /dashboard (SMD-2280), on the same image for the same
# reason; it holds only sessions, which a recreate ends.
canary_compose up -d --no-deps --force-recreate app
# Its own proxy (SMD-1846) and the forwarder that publishes its port
# (SMD-2583), left running across a refresh: while the server is stopped the
# proxy answers 502, and the server's new container is the same name on the
# network. Recreated only when their own configuration changed (another port),
# the proxy first, so a canary from before the forwarder hands its port over.
canary_compose up -d --no-deps proxy
canary_compose up -d --no-deps forwarder
BASE="http://127.0.0.1:$PORT/mcp"
say "canary at $BASE"
# Up when its keyed /health is the REST core's record: the MCP server built on
# it answers keyless liveness on its own, and a key's /health is `ok` until the
# REST core behind it answers (SMD-2287), so the key's JSON is both up.
ready() { [ "$(curl -s --max-time 5 -H "x-brain-key: $KEY" "$BASE/health" 2>/dev/null | head -c 1 || true)" = "{" ]; }
for _ in $(seq 1 60); do
  ready && break
  sleep 2
done
if ! ready; then
  echo "the canary did not answer its keyed $BASE/health with the REST core's record in 60 tries (2 to 7 minutes). The logs of its REST core and MCP server, then of its proxy:" >&2
  canary_compose logs --no-color --tail 40 api mcp >&2 || true
  canary_compose logs --no-color --tail 10 proxy forwarder >&2 || true
  # restart: unless-stopped would otherwise restart them without end (hundreds
  # of times a minute under podman), and a registered connector points at them.
  canary_compose stop api mcp app >/dev/null 2>&1 || true
  ADVISED=1
  echo "the canary's REST core, MCP server and operator GUI are stopped; fix the cause above and re-run $RERUN.$COORD_SAID" >&2
  exit 1
fi

WRITERS_STOPPED=""

if [ $SMOKE = 1 ]; then
  say "smoke"
  health="$(curl -s --max-time 20 -H "x-brain-key: $KEY" "$BASE/health" || true)"
  tier="$(python3 -c 'import sys, json; print(json.load(sys.stdin).get("tier") or "")' <<<"$health" 2>/dev/null || true)"
  [ "$tier" = canary ] || { echo "the keyed /health says tier '${tier:-?}', not canary: ${health:0:200}" >&2; exit 1; }
  "$HERE/smoke.sh" "$BASE" "$KEY"

  # The vector arm, which smoke.sh leaves out (it runs with no provider). A
  # thought's own text, with every literal that search matches exactly taken
  # out, is searched for, and must come back as Result 1 at 50% or more, a
  # similarity a thought scores against its own text (78–94% on the dogfood's
  # brain; about 0 from a provider answering random vectors or another model).
  # - Taking the literals out matters: search_thoughts is hybrid and scores a
  #   keyword hit by cosine too, so a probe holding an SMD key, a date or a
  #   path was found by the keyword arm at 0.2% under random vectors (review
  #   pass 2). With none left, only match_thoughts can find it.
  # - Result 1, because only the first header comes before any thought's
  #   content, which is printed raw.
  # - Up to five candidates, the first that passes deciding: the vector arm
  #   rightly ranks a sibling first when the literals were all that told two
  #   thoughts apart (two session summaries of one template, say), which one
  #   candidate in three hit on the dogfood's brain (review pass 3). A broken
  #   provider or index fails every candidate.
  # Candidates are the newest thoughts embedded with the brain's model whose
  # opening 300 characters, digits aside, no other thought shares, with 20
  # letters or more left once their literals are out.
  #
  # needle_free TEXT: TEXT less the database's own extract_search_needles (as
  # search_thoughts reads a query, eight at a time) and the quote marks around
  # a span, until none is left, over up to six rounds; nothing if some remain.
  needle_free() {
    local q="$1" n
    for _ in 1 2 3 4 5 6; do
      n="$(printf '%s\n' "SELECT coalesce(array_to_json(extract_search_needles(:'q'))::text, '[]')" \
        | "$RUNTIME" exec -i "$CANARY_PG" psql -U postgres -d openbrain -tAq -v q="$q")"
      [ "$n" != "[]" ] || { printf '%s' "$q"; return 0; }
      q="$(python3 -c $'import json, sys\nq = sys.argv[1]\nfor x in json.loads(sys.argv[2]):\n    q = q.replace(x, " ")\nprint(q.replace(chr(34), " "))' "$q" "$n")"
    done
  }
  # probe_verdict ID QUERY: `ok <similarity>` when search_thoughts returns ID
  # first at FLOOR or more, `no <why>` otherwise. Never fails itself.
  FLOOR=50
  probe_verdict() {
    local body reply
    body="$(python3 -c 'import sys, json; print(json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "search_thoughts", "arguments": {"query": sys.argv[1], "limit": 5, "threshold": 0}}}))' "$2")"
    reply="$(curl -s --max-time 120 -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
      -H "x-brain-key: $KEY" -d "$body" "$BASE/" || true)"
    python3 -c '
import json, re, sys
probe, floor, raw = sys.argv[1], float(sys.argv[2]), sys.stdin.read()
try:
    frames = [l[6:] if l.startswith("data: ") else l for l in raw.splitlines()]
    frames = [f for f in frames if f.startswith("{")]
    if not frames:
        sys.exit(print("no reply was not JSON: " + raw[:200].replace("\n", " ")))
    r = json.loads(frames[-1])
    if "error" in r:
        sys.exit(print("no " + json.dumps(r["error"])[:200]))
    text = "\n".join(c.get("text", "") for c in (r.get("result") or {}).get("content", []))
    m = re.search(r"(?m)^--- Result (\d+) \(([^)\n]*)\) ---\nID: (\S+)", text)
    if not m:
        sys.exit(print("no no result: " + text[:160].replace("\n", " ")))
    if m.group(3) != probe:
        sys.exit(print(f"no Result {m.group(1)} is {m.group(3)} ({m.group(2)})"))
    sim = re.match(r"([0-9.]+)% match", m.group(2))
    if not sim:
        sys.exit(print(f"no Result 1 has no similarity: {m.group(2)}"))
    if float(sim.group(1)) < floor:
        sys.exit(print(f"no Result 1 at {sim.group(1)}%, under {floor:g}%"))
    print(f"ok {sim.group(1)}%")
except Exception as e:
    print(f"no the reply did not parse ({type(e).__name__}: {e}): " + raw[:160].replace("\n", " "))
' "$1" "$FLOOR" <<<"$reply"
  }
  # An assignment, so a failing query ends the script here rather than
  # reading as "no candidates".
  candidates="$(psql_in "$CANARY_PG" "WITH once AS (SELECT md5(regexp_replace(left(content, 300), '[0-9]', '', 'g')) AS h FROM thoughts GROUP BY 1 HAVING count(*) = 1)
    SELECT t.id FROM thoughts t JOIN once ON once.h = md5(regexp_replace(left(t.content, 300), '[0-9]', '', 'g'))
    WHERE t.embedding IS NOT NULL
      AND coalesce(t.embedding_model = (SELECT value FROM ob1_config WHERE key = 'embedding_model'), true)
    ORDER BY t.created_at DESC NULLS LAST LIMIT 20")"
  tried=0
  passed=""
  misses=""
  for id in $candidates; do
    q="$(needle_free "$(psql_in "$CANARY_PG" "SELECT left(content, 1000) FROM thoughts WHERE id = '$id'")")"
    letters="${q//[^[:alpha:]]/}"
    [ "${#letters}" -ge 20 ] || continue
    tried=$((tried + 1))
    verdict="$(probe_verdict "$id" "$q")"
    if [ "${verdict%% *}" = ok ]; then passed="$id at ${verdict#ok }"; break; fi
    misses="$misses
       $id: ${verdict#no }"
    [ "$tried" -lt 5 ] || break
  done
  canary_vectors="$(psql_in "$CANARY_PG" "SELECT count(*) FROM (SELECT 1 FROM thoughts WHERE embedding IS NOT NULL
    AND coalesce(embedding_model = (SELECT value FROM ob1_config WHERE key = 'embedding_model'), true) LIMIT 1) t")"
  if [ "$tried" = 0 ] && [ "$stable_vectors" = 1 ] && [ "$canary_vectors" = 0 ]; then
    if [ $REFRESH = 1 ]; then
      echo "  ✗  stable holds thoughts with vectors from the brain's model and the canary none after the refresh: a migration emptied them, or the model changed without a reembed" >&2
    else
      echo "  ✗  the canary held thoughts with vectors from the brain's model before its migration and none after it: the migration emptied them, or the model changed without a reembed" >&2
    fi
    exit 1
  elif [ "$tried" = 0 ]; then
    say "vector search not checked: no recent thought has a vector from the brain's model, an opening of its own, and text left once its literals are out"
  elif [ -n "$passed" ]; then
    echo "  ✓  search_thoughts, given a thought's own text less its literals, returns it first: $passed (candidate $tried of up to 5) — the vector arm answers"
  else
    echo "  ✗  search_thoughts returned none of $tried candidates first at ${FLOOR}% or more, given each one's own text less its literals:$misses" >&2
    exit 1
  fi
fi

# Step 6: the coordinator on the new build, after the smoke, so a canary the
# smoke rejects is not written to (SMD-3476; the sleep worker's rule,
# SMD-3154, and board-sync's, SMD-3312). Its passes are the canary file's
# OB1_PASSES, handed through canary_compose's shell: board-sync among them
# only with a key of the canary's own (BOARD_KEY, read above, after step 2
# cleared stable's), since a canary upgraded in place has no other way to keep
# its board current, and with LINEAR_COMMENT_API_KEY held empty, so it never
# posts. Recreated, running before this run or not, so it runs the server
# image step 4 built from this checkout, with the file as it is now; every
# coordinator container of the canary's project goes first (one compose did
# not make, by hand, would collide with the name). A start that then fails
# says so itself, since an earlier advice silences the trap.
read -ra named_passes <<<"$(printf '%s' "$PASSES_RAW" | tr ',' ' ')"
CANARY_PASSES=""
for pass in ${named_passes[@]+"${named_passes[@]}"}; do
  [ "$pass" != board-sync ] || [ -n "$BOARD_KEY" ] || continue
  CANARY_PASSES="${CANARY_PASSES:+$CANARY_PASSES,}$pass"
done
coord_cts="$("$RUNTIME" ps -aq --filter "label=com.docker.compose.project=$CANARY" --filter "label=com.docker.compose.service=coordinator")"
say "canary coordinator, on the new build (OB1_PASSES: ${CANARY_PASSES:-none}; the passes run from the canary's server image)"
[ -z "$coord_cts" ] || printf '%s\n' "$coord_cts" | xargs "$RUNTIME" rm -f >/dev/null
if ! canary_compose up -d --no-deps --force-recreate coordinator; then
  ADVISED=1
  echo "the canary's coordinator did not start (above)${coord_cts:+, and its old container is removed}: fix the cause and re-run $RERUN." >&2
  exit 1
fi
COORD_PENDING=""
if [ -n "$BOARD_NAMED" ] && [ -n "$BOARD_KEY" ]; then
  say "canary board-sync, on the new build (its own copy of the board; it reads Linear with the canary's key and never comments)"
elif [ -n "$BOARD_NAMED" ]; then
  say "canary board-sync off, left out of the coordinator's passes: $CANARY_ENV holds no LINEAR_API_KEY of the canary's own — $BOARD_ADD to run it again"
elif [ -n "$BOARD_KEY" ]; then
  say "note: the canary runs no board-sync (its OB1_PASSES does not name it), so its copy of the board stays as of its last refresh or sync — add board-sync to OB1_PASSES in $CANARY_ENV and re-run $RERUN to keep it current (SMD-3312)"
else
  say "note: the canary runs no board-sync, so its copy of the board stays as of its last refresh or sync — add board-sync to OB1_PASSES in $CANARY_ENV and $BOARD_ADD to keep it current (SMD-3312)"
fi
# sleep, or the workers, name themselves by OB1_WORKER_KEY: with none in the
# file the coordinator holds the pass, running nothing until a recreate
# (SMD-3214), so the run says so and exits 1 at its end.
HELD_PASS=""
case ",$CANARY_PASSES," in
  *,sleep,*) HELD_PASS="sleep" ;;
  *,workers,*) HELD_PASS="workers" ;;
esac
if [ -n "$HELD_PASS" ]; then
  worker_key=""
  if ! worker_key="$(env_file value "$CANARY_ENV" OB1_WORKER_KEY)"; then
    echo "could not read OB1_WORKER_KEY from $CANARY_ENV through compose, so whether the coordinator holds $HELD_PASS is unknown: fix the file, then re-run $RERUN." >&2
    exit 1
  fi
  [ -z "$worker_key" ] || HELD_PASS=""
  worker_key=""
fi
if [ -n "$HELD_PASS" ]; then
  ADVISED=1
  say "canary $HELD_PASS held by the coordinator, running nothing: $CANARY_ENV holds no OB1_WORKER_KEY (this up cleared stable's) — mint one (cd server-portable && bun keygen.ts --name canary-workers --scope capture), add its line to MCP_ACCESS_KEYS and the raw key as OB1_WORKER_KEY, then re-run $RERUN"
fi

if [ $CONNECT = 1 ]; then
  [ -z "$CONN_SCOPE" ] || claude mcp remove --scope user "$NAME" >/dev/null
  # Its confirmation echoes the header, key and all: not printed.
  claude mcp add --transport http --scope user "$NAME" "$BASE" -H "x-brain-key: $KEY" >/dev/null
  say "connector $NAME → $BASE (user scope; a new Claude Code session sees its tools)"
else
  # Without --connect a connector at another of the canary's ports is left as
  # it was, at a URL this canary no longer answers on: by port and path, so
  # another spelling of this host (localhost) is no move. The port's root is
  # one: its legacy route went with v2.0.0, and the proxy answers it 404
  # (SMD-2532). So is one left at /canary/mcp on stable's origin, where the
  # canary answered before SMD-2874.
  read_connector
  at="$(endpoint_of "$CONN_URL")"
  if [ -n "$CONN_URL" ] && ours "$CONN_URL"; then
    if [ "${at%% *}" = "$PORT" ] && [ "$at" != "$(endpoint_of "$BASE")" ]; then
      say "connector $NAME still points at $(shown "$CONN_URL"), where this canary no longer answers: re-run $RECONNECT"
    elif [ "$at" != "$(endpoint_of "$BASE")" ]; then
      # Another port, the canary's until this run: from the next one it is
      # not, so --connect there refuses it (review pass 1).
      say "connector $NAME still points at $(shown "$CONN_URL"), a port this canary no longer answers on: move it with claude mcp remove --scope $CONN_SCOPE $NAME, then up --connect (an up that changes the port with --connect moves it)"
    fi
    # A key minted this run (a file made before SMD-2874 PR 2, or one whose
    # key was taken out of MCP_ACCESS_KEYS): the connector holds another one,
    # which the canary no longer takes (review pass 1).
    # Only at the canary's own URL: one elsewhere is told to move, and the
    # --connect that moves it gives it the key (review pass 2). By the key it
    # sends, on every run, so a run that failed after giving the canary its
    # own keys does not leave it unsaid (code review); by this run's changes
    # when the connector's key cannot be read.
    if [ "$at" = "$(endpoint_of "$BASE")" ]; then
      if [ -n "$CONN_KEY" ]; then
        # Taken when its digest is in the canary's MCP_ACCESS_KEYS: a key the
        # operator minted and added for it is the connector's to keep (code
        # review). The key reaches shasum on stdin, never argv.
        conn_sha="$(printf '%s' "$CONN_KEY" | shasum -a 256 | cut -d' ' -f1)"
        case ",$(env_file value "$CANARY_ENV" MCP_ACCESS_KEYS | tr '\n' ',' | tr -d ' ' | tr '[:upper:]' '[:lower:]')," in
          *":$conn_sha,"*) ;;
          *) say "connector $NAME sends a key this canary does not take (none in its MCP_ACCESS_KEYS): re-run $RECONNECT to give it OB1_CANARY_KEY" ;;
        esac
      else
        case "$OWN_SAID" in *"minted the canary's own write key"*|*"of stable's access keys"*) say "connector $NAME may hold a key this canary no longer takes (this up gave it keys of its own): re-run $RECONNECT to give it OB1_CANARY_KEY" ;; esac
      fi
    fi
  elif [ "${at#* }" = /canary/mcp ] && stable_port "${at%% *}"; then
    say "connector $NAME points at $(shown "$CONN_URL"), on $STABLE's origin, where the canary answered before SMD-2874: move it with claude mcp remove --scope $CONN_SCOPE $NAME, then up --connect"
  fi
fi

if [ $REFRESH = 1 ]; then
  say "canary up: $BASE, tier canary, refreshed from $STABLE_PG"
else
  say "canary up: $BASE, tier canary, migrated in place (its own rows kept)"
fi
[ -z "$HELD_PASS" ] || { echo "the canary's coordinator holds $HELD_PASS: it has no OB1_WORKER_KEY (above)." >&2; exit 1; }
