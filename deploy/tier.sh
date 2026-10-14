#!/usr/bin/env bash
# Run db/tier.ts's --refresh and --promote beside a running stack, each half in
# a container on its own brain's network (SMD-2036, SMD-2875).
#
# tier.ts --refresh needs Bun AND a pg_dump / pg_restore at the source server's
# major, and neither the stack's images nor a host carries both. This builds
# db/tier.Dockerfile (bun + postgresql16-client; cached after the first run) as
# <project>-tier:latest, the --to side's project, and runs this checkout's
# tier.ts in it, so the database services are reached by name and nothing is
# published for it.
#
# Each verb runs as two halves (tier.ts --handoff), each in a container of its
# own:
#   - the source half, on the --from side's network alone, with --from's
#     password alone: a refresh's facts and its dump (as pg_read_all_data), or
#     a promote's read of the canary;
#   - the target half, on the --to side's network alone, with --to's password
#     and the settings migrate.ts reads: the guards, then the restore, the
#     settings, the re-migrate and the stamps, or a promote's stamp on stable.
# The source half's hand-off passes from its container to the target's
# through this CLI (`cp`, a tar stream on a pipe; no file on the host). So no
# container joins both brains' networks or holds both their passwords, which
# SMD-2872 rules out. Each half is still its own brain's superuser, inside
# that brain's project.
#
#   # the canary deploy/canary.sh stood up, from stable, each a `postgres` on
#   # its own network: --env-file is the canary's file (its password, its
#   # project, the settings), --from-env-file stable's (its password, its project)
#   deploy/tier.sh --env-file ~/stack/deploy/.env.canary.local --from-env-file ~/stack/deploy/.env \
#     --refresh --from postgres --to postgres --tier canary
#   # the three-tier stack: one project, so both halves on its own network
#   deploy/tier.sh --refresh --from stable-postgres --to canary-postgres --network open-brain-tiers_data
#
# (deploy/canary.sh runs the canary's --refresh itself.) --promote's --from is
# the canary and its --to stable, so there --env-file is stable's. --replay and
# --diff reach the two brains over HTTP, each at its own URL with its own key,
# and need no container: run them as `bun db/tier.ts --diff --from <stable>
# --to <canary>` (deploy/README.md, "Refreshing a tier"). Given here, they are
# refused.
#
# --from / --to take a database on its side's network as HOST[:PORT][/DB] —
# port 5432 and database openbrain unless named — and this builds the URL as
# the stack's own services do, postgres://postgres:$POSTGRES_PASSWORD@HOST:PORT/DB,
# with that side's password. A full postgres:// URL is passed through as given.
# Every other argument goes to the target half's tier.ts unchanged (db/README.md
# has its verbs); the source half gets the verb alone.
#
# Flags of this wrapper's own, all optional:
#   --env-file PATH  the --to side's env file: its POSTGRES_PASSWORD builds a
#                    short-form --to's URL, its project names that side's
#                    network and the image, and its OB1_* settings reach the
#                    target half (default deploy/.env beside this script —
#                    which a branch worktree does not have: it is gitignored)
#   --from-env-file PATH  the --from side's env file, when --from is another
#                    stack's (deploy/canary.sh names stable's, SMD-2583): its
#                    POSTGRES_PASSWORD builds a short-form --from's URL and its
#                    project names that side's network; nothing else is read
#                    from it. Unset, --from is on --env-file's stack
#   --project NAME   the --to side's project (default: the project --env-file
#                    names, COMPOSE_PROJECT_NAME as compose reads it, else
#                    compose.yaml's open-brain; SMD-2873): the image's name,
#                    <project>-tier, and the network, <project>_data, unless
#                    --network names it
#   --network NAME   the --to side's network (default <project>_data,
#                    deploy/compose.yaml's: Postgres is on `data`, internal;
#                    SMD-2583. A stack from before SMD-2583 has one network,
#                    <project>_default). One network: a half joins no other
#   --from-project NAME, --from-network NAME  the same for the --from side
#                    (default: --from-env-file's project when it is given,
#                    else the --to side's network)
#   --runtime CLI    docker or podman (default: docker when on PATH, else podman)
#
# The environment is compose's: `compose config --environment` reads the env
# file as the stack does (quotes, inline comments, `export`, CRLF, a BOM) under
# the shell's own variables, which win there too. Of --env-file's, only what
# tier.ts and migrate.ts read is handed to the target half: the OB1_* knobs
# (migrate.ts's OB1_EMBEDDING_* and OB1_PLUGINS on a refresh) and
# POSTGRES_PASSWORD, which builds the URL. Access keys, OPENROUTER_API_KEY (a
# replay's embed fell back to it before the replay moved onto HTTP, SMD-2875),
# LINEAR_API_KEY, the authorization server's OB1_AUTH_* settings (its signing
# key, client secrets and password; SMD-2285) and the rest stay behind. The
# source half gets its URL alone. Each half's values travel in a mode-600
# temporary env file, so they are not on this command line or the runtime's;
# they are in the half's container environment (`inspect` shows it while it
# runs), and its URL is on the argument lists inside it (bun's, migrate.ts's),
# which a Linux host's `ps` shows (SMD-2119). The hand-off holds the source's
# whole dump: it is on this CLI's pipe, and in the target's container until
# the EXIT trap removes both.
#
# Nothing else reaches a container's environment: the checkout is mounted, and
# its own .env files (evals/.env, .env, deploy/.env, which db/env.ts would read,
# and whatever Bun auto-loads from a working directory) are switched off —
# OB1_ENV_FILES=off, `bun --no-env-file`, and a working directory outside it.
#
# A short-form --to gets OB1_ALLOW_REMOTE_DB=1: tier.ts refuses to reset a
# non-loopback --to without it, and from a container every other container is
# non-loopback. What guards --to in its place is tier.ts: it refuses a --to that
# is the --from database (the two halves compare the identity each server
# reports), and resets only a target an earlier refresh marked
# (ob1.refresh_target on the database), one stamped canary or working, one whose
# public schema holds nothing but what extensions own, or an Open Brain schema
# (schema_migrations, ob1_config and thoughts) with no thoughts. A --to given as
# a URL gets no such opt-in: export OB1_ALLOW_REMOTE_DB=1 to reset one, as with
# tier.ts.
#
# The client major, 16, must be at least both servers' (pg_dump reads the
# source, and --to for the probe before the reset): refreshToolsReady refuses
# the refresh otherwise, and bumping the stack's Postgres means bumping
# the package in db/tier.Dockerfile with it. On a host with SELinux enforcing
# (Fedora, RHEL — podman's default there), the read-only mount of the checkout
# needs a label the container may read; relabel the checkout once (`chcon -Rt
# container_file_t <checkout>`) — this script does not relabel it for you.
#
# Exit status is the first half's to fail, else the target half's; 2 for a
# usage error here, a network that does not exist included.
set -euo pipefail
unset CDPATH # a cd that prints the directory would put two lines in HERE

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//' >&2
  exit 2
}

NETWORK=""
PROJECT=""
FROM_NETWORK=""
FROM_PROJECT=""
ENV_FILE="$HERE/.env"
FROM_ENV_FILE=""
RUNTIME=""
FROM=""
TO=""
SEEN=" "
PASS=()
VERBS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --network|--project|--from-network|--from-project|--env-file|--from-env-file|--runtime|--from|--to)
      [ $# -ge 2 ] && [ "${2#--}" = "$2" ] || { echo "$1 takes a value." >&2; exit 2; }
      # An empty network or project would fall through to the env file's project.
      case "$1" in --network|--project|--from-network|--from-project) [ -n "${2//[[:space:]]/}" ] || { echo "$1 takes a value." >&2; exit 2; } ;; esac
      # One network a half: a container on two would reach both brains (SMD-2875).
      case "$1" in --network|--from-network) case "$2" in *,*|*[[:space:]]*) echo "$1 takes one network name, with no comma or space: each half runs on its own side's network alone (SMD-2875). '$2'" >&2; exit 2 ;; esac ;; esac
      case "$SEEN" in *" $1 "*) echo "$1 given twice." >&2; exit 2 ;; esac
      SEEN="$SEEN$1 "
      case "$1" in
        --network) NETWORK="$2" ;;
        --project) PROJECT="$2" ;;
        --from-network) FROM_NETWORK="$2" ;;
        --from-project) FROM_PROJECT="$2" ;;
        --env-file) ENV_FILE="$2" ;;
        --from-env-file) FROM_ENV_FILE="$2" ;;
        --runtime) RUNTIME="$2" ;;
        --from) FROM="$2" ;;
        --to) TO="$2" ;;
      esac
      shift 2 ;;
    -h|--help) usage ;;
    --replay|--diff)
      echo "$1 runs over HTTP now, each brain at its own URL with its own key, and needs no container (SMD-2875): bun db/tier.ts $1 --from <stable's MCP URL or connector> --to <the canary's>." >&2
      exit 2 ;;
    --refresh|--promote) VERBS+=("$1"); PASS+=("$1"); shift ;;
    *) PASS+=("$1"); shift ;;
  esac
done
# The source half is handed the verb alone, so the wrapper must know it.
[ "${#VERBS[@]}" = 1 ] || { echo "tier.sh runs one of --refresh and --promote, each as two halves (db/README.md has the verbs; --replay and --diff run over HTTP)." >&2; exit 2; }
VERB="${VERBS[0]}"
[ -n "$FROM" ] && [ -n "$TO" ] || { echo "tier.sh needs --from and --to (HOST[:PORT][/DB] on its side's network, or a postgres:// URL)." >&2; exit 2; }
[ -f "$ENV_FILE" ] || { echo "no env file at $ENV_FILE — name the running stack's with --env-file (deploy/.env is gitignored, so a worktree has none)." >&2; exit 2; }
case "$SEEN" in *" --from-env-file "*)
  # An empty value would read as unset, and --from would quietly take
  # --env-file's password; and a password in the shell wins over both
  # files in compose's reading, so the two databases would share it (review
  # pass 1).
  [ -n "$FROM_ENV_FILE" ] || { echo "--from-env-file takes a file." >&2; exit 2; }
  [ -f "$FROM_ENV_FILE" ] || { echo "no env file at $FROM_ENV_FILE (--from-env-file)." >&2; exit 2; }
  [ -z "${POSTGRES_PASSWORD+set}" ] || { echo "POSTGRES_PASSWORD is set in the shell, where it wins over both env files and would give --from and --to one password: unset it to use --from-env-file." >&2; exit 2; }
  ;;
esac

if [ -z "$RUNTIME" ]; then
  if command -v docker >/dev/null 2>&1; then RUNTIME=docker
  elif command -v podman >/dev/null 2>&1; then RUNTIME=podman
  else echo "neither docker nor podman is on PATH." >&2; exit 2
  fi
fi
command -v "$RUNTIME" >/dev/null 2>&1 || { echo "--runtime $RUNTIME is not on PATH." >&2; exit 2; }

# The project an env file names (SMD-2873), read as compose reads it: a stub
# carrying compose.yaml's `name: open-brain`, which an env file's or the
# shell's COMPOSE_PROJECT_NAME overrides. The runtime's compose, then either
# other one, as resolve_env below reads the file (compose quotes a name YAML
# would read otherwise, `"123"`). FILE FLAG, the flag that names it instead.
# Called as an assignment, so its exit 2 ends the script under set -e.
project_of() {
  local c name="" errf
  errf="$(mktemp "${TMPDIR:-/tmp}/ob1-tier-project.XXXXXX")"
  for c in "$RUNTIME" docker podman; do
    command -v "$c" >/dev/null 2>&1 || continue
    name="$(printf 'name: open-brain\nservices: {}\n' | "$c" compose --env-file "$1" -f - config 2>"$errf" | sed -n 's/^name: //p' | head -n 1 | tr -d "\"'")" || true
    [ -z "$name" ] || break
  done
  if [ -z "$name" ]; then
    sed $'s/\x1b\\[[0-9;]*m//g' "$errf" | grep -v -E 'Executing external compose provider|^Error: executing .*compose|^[[:space:]]*$' | tail -n 1 >&2 || true
    rm -f "$errf"
    echo "could not read the stack's project from $1 through compose (its reason above); name it with $2." >&2; exit 2
  fi
  rm -f "$errf"
  printf '%s' "$name"
}
# Where a project came from, for a refusal that names it. FILE
where_of() {
  if [ -n "${COMPOSE_PROJECT_NAME+set}" ]; then printf 'COMPOSE_PROJECT_NAME in the shell'; else printf "COMPOSE_PROJECT_NAME in %s, or compose.yaml's open-brain" "$1"; fi
}
valid_project() { [[ "$1" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo "the project ($2) takes a compose project name (lower-case letters, digits, - and _): '$1'" >&2; exit 2; }; }

# The --to side: its project names the image and, unless --network names it,
# the network.
TO_WHERE="--project"
if [ -z "$PROJECT" ]; then TO_WHERE="$(where_of "$ENV_FILE")"; PROJECT="$(project_of "$ENV_FILE" --project)"; fi
valid_project "$PROJECT" "$TO_WHERE"
IMAGE="$PROJECT-tier:latest"
# Where each side's network came from, for the refusal when it is missing.
TO_NET_WHERE=""
[ -n "$NETWORK" ] || { NETWORK="${PROJECT}_data"; TO_NET_WHERE="the project $PROJECT, from $TO_WHERE"; }
# The --from side: its own project's when --from-env-file or --from-project
# names one, else the --to side's network.
FROM_NET_WHERE=""
if [ -z "$FROM_NETWORK" ]; then
  if [ -n "$FROM_PROJECT" ]; then FROM_WHERE="--from-project"
  elif [ -n "$FROM_ENV_FILE" ]; then FROM_WHERE="$(where_of "$FROM_ENV_FILE")"; FROM_PROJECT="$(project_of "$FROM_ENV_FILE" --from-project)"
  fi
  if [ -n "$FROM_PROJECT" ]; then
    valid_project "$FROM_PROJECT" "$FROM_WHERE"
    FROM_NETWORK="${FROM_PROJECT}_data" FROM_NET_WHERE="the project $FROM_PROJECT, from $FROM_WHERE"
  else
    FROM_NETWORK="$NETWORK" FROM_NET_WHERE="the --to side's"
  fi
fi

# Before anything is built: a mistyped network (open-brain_data against
# open-brain-tiers_data) is a usage error, not the runtime's 125 at the end.
missing_network() {
  "$RUNTIME" network inspect "$1" >/dev/null 2>&1 && return
  echo "no network $1 for the $2 side${3:+ ($3)} — name it with $4. The runtime has:" >&2
  "$RUNTIME" network ls >&2 || true
  exit 2
}
missing_network "$NETWORK" --to "$TO_NET_WHERE" "--project or --network"
missing_network "$FROM_NETWORK" --from "$FROM_NET_WHERE" "--from-project or --from-network"

TMP_ENV="$(mktemp "${TMPDIR:-/tmp}/ob1-tier-env.XXXXXX")"
TMP_ENV_FROM="$(mktemp "${TMPDIR:-/tmp}/ob1-tier-env-from.XXXXXX")"
COMPOSE_ERR_FILE="$(mktemp "${TMPDIR:-/tmp}/ob1-tier-compose.XXXXXX")" # mktemp creates all three mode 600
SRC_CID=""
DST_CID=""
trap 'rm -f "$TMP_ENV" "$TMP_ENV_FROM" "$COMPOSE_ERR_FILE"; for c in "$SRC_CID" "$DST_CID"; do [ -z "$c" ] || "$RUNTIME" rm -f "$c" >/dev/null 2>&1 || true; done' EXIT
# A Ctrl-C is a stop, wherever it lands: bash lets a script run on after a
# child that did not die of the signal (the buildx probe below, say), and a
# caller must not read an interrupted run as done.
trap 'exit 130' INT
# …and so are a hangup and a TERM, so the EXIT trap above runs: bash 5 skipped
# it on a hangup to the process group (a closed terminal) in deploy/canary.sh's
# measurement, which would leave the containers, whose environments hold the
# databases' URLs, the target's the dump, and the env files (SMD-2583 review
# pass 5).
trap 'exit 129' HUP
trap 'exit 143' TERM

# The environment as compose builds it for the stack: an empty project, the
# file, the shell. stderr apart, since a delegating `podman compose` prints a
# banner there even when it succeeds. The runtime's compose first, then the
# other's; the first failure is the one reported.
# Called as an assignment, so its exit 2 ends the script under set -e.
resolve_env() {
  local c out err=""
  for c in "$RUNTIME" docker podman; do
    command -v "$c" >/dev/null 2>&1 || continue
    if out="$(printf 'services: {}\n' | "$c" compose -p open-brain-tier-env --env-file "$1" -f - config --environment 2>"$COMPOSE_ERR_FILE")" && [ -n "$out" ]; then printf '%s\n' "$out"; return; fi
    [ -n "$err" ] || err="$c compose said: $(cat "$COMPOSE_ERR_FILE")"
  done
  printf 'could not read %s through compose — tier.sh needs docker compose (or podman compose) with "config --environment".\n%s\n' "$1" "$err" >&2
  exit 2
}
RESOLVED="$(resolve_env "$ENV_FILE")"

# What the target half is handed, one NAME=value line each, value as compose
# resolved it (a runtime's --env-file takes such a line literally). The
# wrapper's own variables are its to set, below. A quoted value spanning lines
# is not supported: compose prints its lines raw, so the first is carried cut
# short and a later one shaped like an allowed NAME=… reads as that name (none
# of the stack's knobs is one).
POSTGRES_PASSWORD=""
while IFS= read -r line; do
  name="${line%%=*}"
  case "$name" in
    OB1_ALLOW_REMOTE_DB|OB1_ENV_FILE|OB1_ENV_FILES) continue ;;
    # The authorization server's settings (its signing key, client secrets and
    # the operator's password) are not tier.ts's, and stay behind (SMD-2285;
    # deploy/auth/provision.ts --self-check runs this loop). A line of its
    # own: db/test-connect.ts reads the one above as names alone.
    OB1_AUTH_*) continue ;;
    OB1_*|POSTGRES_PASSWORD) ;;
    *) continue ;;
  esac
  printf '%s\n' "$line" >> "$TMP_ENV"
  [ "$name" = POSTGRES_PASSWORD ] && POSTGRES_PASSWORD="${line#*=}"
done <<< "$RESOLVED"

# The --from database's password: --from-env-file's, read the same way, when
# --from is another stack's with a password of its own (deploy/canary.sh's
# stable, SMD-2583); only that one value is taken from the file, and only the
# source half is handed it.
FROM_PASSWORD="$POSTGRES_PASSWORD"
if [ -n "$FROM_ENV_FILE" ]; then
  FROM_PASSWORD="$(resolve_env "$FROM_ENV_FILE" | sed -n 's/^POSTGRES_PASSWORD=//p' | head -n 1)"
fi

# Percent-encode for the userinfo part of a URL: a password holding @, / or :
# would otherwise end the userinfo early and name another host.
urlencode() {
  local s="$1" out="" c i
  local LC_ALL=C
  for (( i = 0; i < ${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      [A-Za-z0-9._~-]) out+="$c" ;;
      # A byte past 0x7F reads back negative from "'c" (sign-extended); the mask keeps it one byte.
      *) out+="$(printf '%%%02X' "$(( $(printf '%d' "'$c") & 255 ))")" ;;
    esac
  done
  printf '%s' "$out"
}

is_url() { case "$1" in postgres://*|postgresql://*) return 0 ;; esac; return 1; }

# HOST[:PORT][/DB] PASSWORD FILE → postgres://postgres:…@HOST:PORT/DB, FILE
# named when PASSWORD is empty; a URL as given. Called as an assignment, so its
# exit 2 ends the script under set -e.
to_url() {
  if is_url "$1"; then printf '%s' "$1"; return; fi
  [ -n "$2" ] || { echo "POSTGRES_PASSWORD is not set in $3 or the environment — needed to build the URL for $1." >&2; exit 2; }
  local hostport="${1%%/*}" db="openbrain"
  [ "$hostport" = "$1" ] || db="${1#*/}"
  [ -n "$hostport" ] && [ -n "$db" ] || { echo "not HOST[:PORT][/DB]: $1" >&2; exit 2; }
  case "$hostport" in *:*) ;; *) hostport="$hostport:5432" ;; esac
  printf 'postgres://postgres:%s@%s/%s' "$(urlencode "$2")" "$hostport" "$db"
}

FROM_URL="$(to_url "$FROM" "$FROM_PASSWORD" "${FROM_ENV_FILE:-$ENV_FILE}")"
TO_URL="$(to_url "$TO" "$POSTGRES_PASSWORD" "$ENV_FILE")"
{
  printf 'TIER_FROM_URL=%s\n' "$FROM_URL"
  echo OB1_ENV_FILES=off
} >> "$TMP_ENV_FROM"
{
  printf 'TIER_TO_URL=%s\n' "$TO_URL"
  echo OB1_ENV_FILES=off
  if ! is_url "$TO"; then echo OB1_ALLOW_REMOTE_DB=1
  elif [ -n "${OB1_ALLOW_REMOTE_DB:-}" ]; then printf 'OB1_ALLOW_REMOTE_DB=%s\n' "$OB1_ALLOW_REMOTE_DB"
  fi
} >> "$TMP_ENV"

# Cached after the first build; rebuilt when db/tier.Dockerfile changes. Named
# for the --to side's project, so a second brain's or a scratch run never
# re-tags the image another brain's runs use (SMD-2537, SMD-2875). The image
# id it prints is dropped, and a build's errors go to stderr, so tier.ts's own
# words are the only thing on stdout.
# --load for docker with buildx: under a docker-container builder (this Mac's
# docker CLI over podman is one) a build without it stays in the builder's
# cache and `run` then looks the tag up in a registry. A docker with no buildx
# plugin (the legacy builder, Debian's docker.io) has no such flag and loads
# anyway.
LOAD=()
if [ "$RUNTIME" = docker ] && docker buildx version >/dev/null 2>&1; then LOAD=(--load); fi
"$RUNTIME" build -q ${LOAD[@]+"${LOAD[@]}"} -t "$IMAGE" - < "$REPO/db/tier.Dockerfile" >/dev/null

# Each half in a container of its own, on its side's network alone, with its
# side's env file alone. --init: bun would otherwise be PID 1, which ignores
# SIGINT, and Ctrl-C would leave a refresh running. -w /tmp: Bun auto-loads
# .env files from the working directory (so does the migrate.ts it spawns),
# and /tmp has none. The quoted scripts append the URL and the hand-off to
# the arguments they were given, so tier.ts's own parser sees each once.
# Created, then started attached (which forwards signals, as run does). No
# --rm: the status is read back from the container, not taken from `start
# -a`, which under the docker CLI over podman returns 0 when the container
# dies of the Ctrl-C it forwarded (measured; `run` returned 130), and a
# refresh stopped mid-restore must not read as done to the script that called
# this one. The EXIT trap removes both containers and the temporary files.
# shellcheck disable=SC2016 # the container's sh expands them, not this one
SRC_CID="$("$RUNTIME" create --init \
  --network "$FROM_NETWORK" \
  --env-file "$TMP_ENV_FROM" \
  -v "$REPO:/repo:ro" \
  -w /tmp \
  "$IMAGE" \
  sh -c 'exec bun --no-env-file /repo/db/tier.ts "$@" --from "$TIER_FROM_URL" --handoff /tmp/handoff' tier "$VERB")"
# shellcheck disable=SC2016 # the container's sh expands them, not this one
DST_CID="$("$RUNTIME" create --init \
  --network "$NETWORK" \
  --env-file "$TMP_ENV" \
  -v "$REPO:/repo:ro" \
  -w /tmp \
  "$IMAGE" \
  sh -c 'exec bun --no-env-file /repo/db/tier.ts "$@" --handoff /tmp/handoff --to "$TIER_TO_URL"' tier ${PASS[@]+"${PASS[@]}"})"

# Start one half attached and wait for its end; the script ends there unless
# it ended 0. CID
run_half() {
  local start_rc=0 status
  "$RUNTIME" start -a "$1" || start_rc=$?
  case "$("$RUNTIME" inspect -f '{{.State.Status}}' "$1" 2>/dev/null || echo gone)" in
    exited|stopped) status="$("$RUNTIME" inspect -f '{{.State.ExitCode}}' "$1")" ;;
    # the CLI came back first (a Ctrl-C): the container's own end decides
    running|stopping) status="$("$RUNTIME" wait "$1")" ;;
    # never ran (docker's created, podman's configured: start's own failure,
    # a network removed since the check), or a state this does not know
    # (dead, paused): not done, whatever start said
    *) exit $(( start_rc ? start_rc : 1 )) ;;
  esac
  [ "$status" = 0 ] || exit "$status"
}
run_half "$SRC_CID"
# The source half's container is stopped and the target's not yet started:
# the hand-off passes between them as a tar stream through this CLI, under
# /tmp, which the image's user (bun) may write. -a keeps that user's
# ownership: Docker Engine's cp makes a copy root's without it, and the
# directory is mode 700 (podman's cp keeps it either way; measured).
"$RUNTIME" cp "$SRC_CID:/tmp/handoff" - | "$RUNTIME" cp -a - "$DST_CID:/tmp/" || { echo "could not pass the hand-off from the source half's container to the target half's." >&2; exit 1; }
run_half "$DST_CID"
