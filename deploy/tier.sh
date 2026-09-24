#!/usr/bin/env bash
# Run db/tier.ts — refresh, replay, diff, promote — beside a running stack (SMD-2036).
#
# tier.ts --refresh needs Bun AND a pg_dump / pg_restore at the source server's
# major, and neither the stack's images nor a host carries both. This builds
# db/tier.Dockerfile (bun + postgresql16-client; cached after the first run) and
# runs this checkout's tier.ts in it, on the stack's network, so the database
# services are reached by name and nothing is published for it.
#
#   deploy/tier.sh --refresh --from postgres --to open-brain-canary-postgres --tier canary
#   deploy/tier.sh --diff    --from postgres --to open-brain-canary-postgres
#   deploy/tier.sh --refresh --from stable-postgres --to canary-postgres --network open-brain-tiers_default
#
# --from / --to take a database on the network as HOST[:PORT][/DB] — port 5432
# and database openbrain unless named — and this builds the URL as the stack's
# own services do, postgres://postgres:$POSTGRES_PASSWORD@HOST:PORT/DB. A full
# postgres:// URL is passed through as given. POSTGRES_PASSWORD is read from the
# environment, else from the env file; the URLs reach the container as
# variables, not arguments, so the password is not on this command line or the
# runtime's. Every other argument goes to tier.ts unchanged (db/README.md has
# its verbs).
#
# Flags of this wrapper's own, all optional:
#   --network NAME   the stack's network (default open-brain_default, deploy/compose.yaml's)
#   --env-file PATH  handed to the container, as the stack's services get it (default deploy/.env):
#                    migrate.ts reads the OB1_EMBEDDING_* knobs from it on a refresh
#   --runtime CLI    docker or podman (default: docker when on PATH, else podman)
#
# OB1_ALLOW_REMOTE_DB=1 is set in the container: tier.ts refuses to reset a
# non-loopback --to without it, and from a container every other container is
# non-loopback. What stands in for that guard here is tier.ts's refusal of a
# --to that names the --from database, and the network: only what is attached
# to it resolves.
#
# The client major, 16, must be at least the source server's: refreshToolsReady
# refuses the refresh otherwise, and bumping the stack's Postgres means bumping
# the package in db/tier.Dockerfile with it.
#
# Exit status is tier.ts's (--diff exits 1 when a ranking moved); 2 for a usage
# error here.
set -euo pipefail

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
PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --network|--env-file|--runtime|--from|--to)
      [ $# -ge 2 ] && [ "${2#--}" = "$2" ] || { echo "$1 takes a value." >&2; exit 2; }
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
[ -f "$ENV_FILE" ] || { echo "no env file at $ENV_FILE — copy deploy/.env.example, or name one with --env-file." >&2; exit 2; }

if [ -z "$RUNTIME" ]; then
  if command -v docker >/dev/null 2>&1; then RUNTIME=docker
  elif command -v podman >/dev/null 2>&1; then RUNTIME=podman
  else echo "neither docker nor podman is on PATH." >&2; exit 2
  fi
fi

# The last POSTGRES_PASSWORD= line wins, as in an env file compose reads; one
# pair of surrounding quotes is dropped.
if [ -z "${POSTGRES_PASSWORD:-}" ]; then
  POSTGRES_PASSWORD="$(grep -E '^POSTGRES_PASSWORD=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  POSTGRES_PASSWORD="${POSTGRES_PASSWORD%\"}"; POSTGRES_PASSWORD="${POSTGRES_PASSWORD#\"}"
  POSTGRES_PASSWORD="${POSTGRES_PASSWORD%\'}"; POSTGRES_PASSWORD="${POSTGRES_PASSWORD#\'}"
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

# HOST[:PORT][/DB] → postgres://postgres:…@HOST:PORT/DB; a URL as given.
to_url() {
  case "$1" in
    postgres://*|postgresql://*) printf '%s' "$1"; return ;;
  esac
  [ -n "$POSTGRES_PASSWORD" ] || { echo "POSTGRES_PASSWORD is not set in the environment or in $ENV_FILE — needed to build the URL for $1." >&2; exit 2; }
  local hostport="${1%%/*}" db="openbrain"
  [ "$hostport" = "$1" ] || db="${1#*/}"
  [ -n "$hostport" ] && [ -n "$db" ] || { echo "not HOST[:PORT][/DB]: $1" >&2; exit 2; }
  case "$hostport" in *:*) ;; *) hostport="$hostport:5432" ;; esac
  printf 'postgres://postgres:%s@%s/%s' "$(urlencode "$POSTGRES_PASSWORD")" "$hostport" "$db"
}

TIER_FROM_URL="$(to_url "$FROM")"
TIER_TO_URL="$(to_url "$TO")"
export TIER_FROM_URL TIER_TO_URL

# Cached after the first build; rebuilt when db/tier.Dockerfile changes. Its
# output goes to stderr, so a --diff's report is the only thing on stdout.
# --load for docker: under a docker-container buildx builder (this Mac's docker
# CLI over podman is one) a build without it stays in the builder's cache and
# `run` then looks the tag up in a registry; the default builder takes it too.
LOAD=()
[ "$RUNTIME" = docker ] && LOAD=(--load)
"$RUNTIME" build -q ${LOAD[@]+"${LOAD[@]}"} -t "$IMAGE" - < "$REPO/db/tier.Dockerfile" >&2

# `-e NAME` with no value takes it from this environment, which is how the URLs
# stay off the argument list. The quoted script appends them to the arguments
# it was given, so tier.ts's own parser sees the one --from and --to it refuses
# twice of.
# shellcheck disable=SC2016 # the container's sh expands them, not this one
exec "$RUNTIME" run --rm \
  --network "$NETWORK" \
  --env-file "$ENV_FILE" \
  -e OB1_ALLOW_REMOTE_DB=1 \
  -e TIER_FROM_URL -e TIER_TO_URL \
  -v "$REPO:/repo:ro" \
  "$IMAGE" \
  sh -c 'exec bun tier.ts "$@" --from "$TIER_FROM_URL" --to "$TIER_TO_URL"' tier ${PASS[@]+"${PASS[@]}"}
