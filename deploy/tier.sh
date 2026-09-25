#!/usr/bin/env bash
# Run db/tier.ts — refresh, replay, diff, promote — beside a running stack (SMD-2036).
#
# tier.ts --refresh needs Bun AND a pg_dump / pg_restore at the source server's
# major, and neither the stack's images nor a host carries both. This builds
# db/tier.Dockerfile (bun + postgresql16-client; cached after the first run) and
# runs this checkout's tier.ts in it, on the stack's network, so the database
# services are reached by name and nothing is published for it.
#
#   deploy/tier.sh --env-file ~/stack/deploy/.env --refresh --from postgres --to open-brain-canary-postgres --tier canary
#   deploy/tier.sh --env-file ~/stack/deploy/.env --diff    --from postgres --to open-brain-canary-postgres
#   deploy/tier.sh --refresh --from stable-postgres --to canary-postgres --network open-brain-tiers_default
#
# --from / --to take a database on the network as HOST[:PORT][/DB] — port 5432
# and database openbrain unless named — and this builds the URL as the stack's
# own services do, postgres://postgres:$POSTGRES_PASSWORD@HOST:PORT/DB. A full
# postgres:// URL is passed through as given. Every other argument goes to
# tier.ts unchanged (db/README.md has its verbs).
#
# Flags of this wrapper's own, all optional:
#   --network NAME   the stack's network (default open-brain_default, deploy/compose.yaml's);
#                    NAME,NAME joins more than one, for a --from and a --to that
#                    share none (deploy/canary.sh's two projects, SMD-2038) —
#                    address them by container name then, since each network
#                    may have a `postgres` of its own
#   --env-file PATH  the running stack's env file (default deploy/.env beside this
#                    script — which a branch worktree does not have: it is gitignored)
#   --runtime CLI    docker or podman (default: docker when on PATH, else podman)
#
# The environment is compose's: `compose config --environment` reads the env
# file as the stack does (quotes, inline comments, `export`, CRLF, a BOM) under
# the shell's own variables, which win there too. Of that, only what tier.ts and
# migrate.ts read is handed on — the OB1_* knobs (migrate.ts's OB1_EMBEDDING_*
# on a refresh; the replay's OB1_EVAL_* and OB1_LLM_*), POSTGRES_PASSWORD, which
# builds the URLs, and the provider settings the replay's embed reads
# (OPENROUTER_API_KEY, OLLAMA_BASE). Access keys, LINEAR_API_KEY and the rest
# stay behind. The values travel in a mode-600 temporary env file, so they are
# not on this command line or the runtime's; they are in the container's
# environment (`inspect` shows it while it runs), and the URLs are on the
# argument lists inside it (bun's, pg_dump's, pg_restore's, migrate.ts's), which
# a Linux host's `ps` shows (SMD-2119).
#
# Nothing else reaches the container's environment: the checkout is mounted, and
# its own .env files (evals/.env, .env, deploy/.env, which db/env.ts would read,
# and whatever Bun auto-loads from a working directory) are switched off —
# OB1_ENV_FILES=off, `bun --no-env-file`, and a working directory outside it.
#
# A short-form --to gets OB1_ALLOW_REMOTE_DB=1: tier.ts refuses to reset a
# non-loopback --to without it, and from a container every other container is
# non-loopback. What guards --to in its place is tier.ts: it refuses a --to that
# is the --from database, and resets only a target an earlier refresh marked
# (ob1.refresh_target on the database), one stamped canary or working, one whose
# public schema holds nothing but what extensions own, or an Open Brain schema
# (schema_migrations, ob1_config and thoughts) with no thoughts. A --to given as
# a URL gets no such opt-in: export OB1_ALLOW_REMOTE_DB=1 to reset one, as with
# tier.ts.
#
# The client major, 16, must be at least the source server's: refreshToolsReady
# refuses the refresh otherwise, and bumping the stack's Postgres means bumping
# the package in db/tier.Dockerfile with it. On a host with SELinux enforcing
# (Fedora, RHEL — podman's default there), the read-only mount of the checkout
# needs a label the container may read; relabel the checkout once (`chcon -Rt
# container_file_t <checkout>`) — this script does not relabel it for you.
#
# Exit status is tier.ts's (--diff exits 1 when a ranking moved); 2 for a usage
# error here, a network that does not exist included.
set -euo pipefail
unset CDPATH # a cd that prints the directory would put two lines in HERE

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
IMAGE=open-brain-tier:latest

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//' >&2
  exit 2
}

NETWORK=open-brain_default
ENV_FILE="$HERE/.env"
RUNTIME=""
FROM=""
TO=""
SEEN=" "
PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --network|--env-file|--runtime|--from|--to)
      [ $# -ge 2 ] && [ "${2#--}" = "$2" ] || { echo "$1 takes a value." >&2; exit 2; }
      case "$SEEN" in *" $1 "*) echo "$1 given twice." >&2; exit 2 ;; esac
      SEEN="$SEEN$1 "
      case "$1" in
        --network) NETWORK="$2" ;;
        --env-file) ENV_FILE="$2" ;;
        --runtime) RUNTIME="$2" ;;
        --from) FROM="$2" ;;
        --to) TO="$2" ;;
      esac
      shift 2 ;;
    -h|--help) usage ;;
    *) PASS+=("$1"); shift ;;
  esac
done
[ -n "$FROM" ] && [ -n "$TO" ] || { echo "tier.sh needs --from and --to (HOST[:PORT][/DB] on the network, or a postgres:// URL)." >&2; exit 2; }
[ -f "$ENV_FILE" ] || { echo "no env file at $ENV_FILE — name the running stack's with --env-file (deploy/.env is gitignored, so a worktree has none)." >&2; exit 2; }

if [ -z "$RUNTIME" ]; then
  if command -v docker >/dev/null 2>&1; then RUNTIME=docker
  elif command -v podman >/dev/null 2>&1; then RUNTIME=podman
  else echo "neither docker nor podman is on PATH." >&2; exit 2
  fi
fi

# Before anything is built: a mistyped network (open-brain_default against
# open-brain-tiers_default) is a usage error, not the runtime's 125 at the end.
case "$NETWORK" in
  ""|,*|*,|*,,*) echo "--network has an empty name: '$NETWORK'" >&2; exit 2 ;;
  *[[:space:]]*) echo "--network takes NAME[,NAME…] with no spaces: '$NETWORK'" >&2; exit 2 ;;
esac
IFS=, read -r -a NETS <<< "$NETWORK"
SEEN_NETS=" "
for net in "${NETS[@]}"; do
  case "$SEEN_NETS" in *" $net "*) echo "--network names $net twice." >&2; exit 2 ;; esac
  SEEN_NETS="$SEEN_NETS$net "
  "$RUNTIME" network inspect "$net" >/dev/null 2>&1 || {
    echo "no network $net — name the stack's with --network. The runtime has:" >&2
    "$RUNTIME" network ls >&2 || true
    exit 2
  }
done

TMP_ENV="$(mktemp "${TMPDIR:-/tmp}/ob1-tier-env.XXXXXX")"
COMPOSE_ERR_FILE="$(mktemp "${TMPDIR:-/tmp}/ob1-tier-compose.XXXXXX")" # mktemp creates both mode 600
CID=""
trap 'rm -f "$TMP_ENV" "$COMPOSE_ERR_FILE"; [ -z "$CID" ] || "$RUNTIME" rm -f "$CID" >/dev/null 2>&1 || true' EXIT

# The environment as compose builds it for the stack: an empty project, the
# file, the shell. stderr apart, since a delegating `podman compose` prints a
# banner there even when it succeeds. The runtime's compose first, then the
# other's; the first failure is the one reported.
RESOLVED=""
COMPOSE_ERR=""
for c in "$RUNTIME" docker podman; do
  command -v "$c" >/dev/null 2>&1 || continue
  if RESOLVED="$(printf 'services: {}\n' | "$c" compose -p open-brain-tier-env --env-file "$ENV_FILE" -f - config --environment 2>"$COMPOSE_ERR_FILE")"; then break; fi
  [ -n "$COMPOSE_ERR" ] || COMPOSE_ERR="$c compose said: $(cat "$COMPOSE_ERR_FILE")"
  RESOLVED=""
done
[ -n "$RESOLVED" ] || { printf 'could not read %s through compose — tier.sh needs docker compose (or podman compose) with "config --environment".\n%s\n' "$ENV_FILE" "$COMPOSE_ERR" >&2; exit 2; }

# What is handed on, one NAME=value line each, value as compose resolved it (a
# runtime's --env-file takes such a line literally). The wrapper's own variables
# are its to set, below. A quoted value spanning lines is not supported: compose
# prints its lines raw, so the first is carried cut short and a later one shaped
# like an allowed NAME=… reads as that name (none of the stack's knobs is one).
POSTGRES_PASSWORD=""
while IFS= read -r line; do
  name="${line%%=*}"
  case "$name" in
    OB1_ALLOW_REMOTE_DB|OB1_ENV_FILE|OB1_ENV_FILES) continue ;;
    OB1_*|POSTGRES_PASSWORD|OPENROUTER_API_KEY|OLLAMA_BASE) ;;
    *) continue ;;
  esac
  printf '%s\n' "$line" >> "$TMP_ENV"
  [ "$name" = POSTGRES_PASSWORD ] && POSTGRES_PASSWORD="${line#*=}"
done <<< "$RESOLVED"

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

# HOST[:PORT][/DB] → postgres://postgres:…@HOST:PORT/DB; a URL as given. Called
# as an assignment, so its exit 2 ends the script under set -e.
to_url() {
  if is_url "$1"; then printf '%s' "$1"; return; fi
  [ -n "$POSTGRES_PASSWORD" ] || { echo "POSTGRES_PASSWORD is not set in $ENV_FILE or the environment — needed to build the URL for $1." >&2; exit 2; }
  local hostport="${1%%/*}" db="openbrain"
  [ "$hostport" = "$1" ] || db="${1#*/}"
  [ -n "$hostport" ] && [ -n "$db" ] || { echo "not HOST[:PORT][/DB]: $1" >&2; exit 2; }
  case "$hostport" in *:*) ;; *) hostport="$hostport:5432" ;; esac
  printf 'postgres://postgres:%s@%s/%s' "$(urlencode "$POSTGRES_PASSWORD")" "$hostport" "$db"
}

FROM_URL="$(to_url "$FROM")"
TO_URL="$(to_url "$TO")"
{
  printf 'TIER_FROM_URL=%s\n' "$FROM_URL"
  printf 'TIER_TO_URL=%s\n' "$TO_URL"
  echo OB1_ENV_FILES=off
  if ! is_url "$TO"; then echo OB1_ALLOW_REMOTE_DB=1
  elif [ -n "${OB1_ALLOW_REMOTE_DB:-}" ]; then printf 'OB1_ALLOW_REMOTE_DB=%s\n' "$OB1_ALLOW_REMOTE_DB"
  fi
} >> "$TMP_ENV"

# Cached after the first build; rebuilt when db/tier.Dockerfile changes. Its
# output goes to stderr, so a --diff's report is the only thing on stdout.
# --load for docker with buildx: under a docker-container builder (this Mac's
# docker CLI over podman is one) a build without it stays in the builder's
# cache and `run` then looks the tag up in a registry. A docker with no buildx
# plugin (the legacy builder, Debian's docker.io) has no such flag and loads
# anyway.
LOAD=()
if [ "$RUNTIME" = docker ] && docker buildx version >/dev/null 2>&1; then LOAD=(--load); fi
"$RUNTIME" build -q ${LOAD[@]+"${LOAD[@]}"} -t "$IMAGE" - < "$REPO/db/tier.Dockerfile" >&2

# --init: bun would otherwise be PID 1, which ignores SIGINT, and Ctrl-C would
# leave a refresh running. -w /tmp: Bun auto-loads .env files from the working
# directory (so does the migrate.ts it spawns), and /tmp has none. The quoted
# script appends the URLs to the arguments it was given, so tier.ts's own parser
# sees the one --from and --to.
#
# Created on the first network, connected to the rest, then started attached
# (which forwards signals, as run does): `run --network A --network B` needs
# Docker Engine 25, and Ubuntu 24.04's docker.io is 24. One path for one
# network or several. No --rm: the status is read back from the container,
# not taken from `start -a`, which under the docker CLI over podman returns 0
# when the container dies of the Ctrl-C it forwarded (measured; `run` returned
# 130), and a refresh stopped mid-restore must not read as done to the script
# that called this one. The EXIT trap removes the container and the
# temporary files. Not `exec`, for the trap.
# shellcheck disable=SC2016 # the container's sh expands them, not this one
CID="$("$RUNTIME" create --init \
  --network "${NETS[0]}" \
  --env-file "$TMP_ENV" \
  -v "$REPO:/repo:ro" \
  -w /tmp \
  "$IMAGE" \
  sh -c 'exec bun --no-env-file /repo/db/tier.ts "$@" --from "$TIER_FROM_URL" --to "$TIER_TO_URL"' tier ${PASS[@]+"${PASS[@]}"})"
for net in "${NETS[@]:1}"; do "$RUNTIME" network connect "$net" "$CID" >/dev/null; done
start_rc=0
"$RUNTIME" start -a "$CID" || start_rc=$?
case "$("$RUNTIME" inspect -f '{{.State.Status}}' "$CID" 2>/dev/null || echo gone)" in
  # never ran: start's own failure (a network removed since the check, say)
  created|gone) exit $(( start_rc ? start_rc : 1 )) ;;
  # the CLI came back first (a Ctrl-C): the container's own end decides
  running) status="$("$RUNTIME" wait "$CID")" ;;
  *) status="$("$RUNTIME" inspect -f '{{.State.ExitCode}}' "$CID")" ;;
esac
exit "$status"
