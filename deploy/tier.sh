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
#   --network NAME   the stack's network (default open-brain_default, deploy/compose.yaml's)
#   --env-file PATH  the running stack's env file (default deploy/.env beside this
#                    script — which a branch worktree does not have: it is gitignored)
#   --runtime CLI    docker or podman (default: docker when on PATH, else podman)
#
# The env file is read by compose itself (`compose config --environment`), so a
# quoted value, an inline comment, an `export` line or CRLF reads here as it
# does for the stack, and the environment wins over the file as it does there.
# Each name the file sets is handed to the container with that resolved value:
# migrate.ts reads the OB1_EMBEDDING_* knobs on a refresh, and POSTGRES_PASSWORD
# builds the URLs. The values travel in a mode-600 temporary env file, so they
# are not on this command line or the runtime's. They are on the argument lists
# inside the container (bun's, pg_dump's, pg_restore's, migrate.ts's), which a
# Linux host's `ps` shows.
#
# A short-form --to is set OB1_ALLOW_REMOTE_DB=1: tier.ts refuses to reset a
# non-loopback --to without it, and from a container every other container is
# non-loopback. What guards --to in its place is tier.ts refusing a --to that is
# the --from database or is stamped tier=stable. A --to given as a URL gets no
# such opt-in: export OB1_ALLOW_REMOTE_DB=1 to reset one, as with tier.ts.
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

# The names the file sets. Compose resolves their values below; this only says
# which of compose's interpolation environment (the file over the shell's) to
# hand on. The wrapper's own variables are left out. POSTGRES_PASSWORD is named
# whether or not the file sets it, so the shell's counts when the file has none,
# as it does for the stack.
NAMES=" POSTGRES_PASSWORD $(tr -d '\r' < "$ENV_FILE" \
  | sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\2/p' \
  | { grep -vxE 'OB1_ALLOW_REMOTE_DB|TIER_FROM_URL|TIER_TO_URL|POSTGRES_PASSWORD' || true; } | sort -u | tr '\n' ' ')"

# The file as compose reads it: an empty project, the file, its interpolation
# environment. The runtime's compose first, then the other's.
RESOLVED=""
for c in "$RUNTIME" docker podman; do
  command -v "$c" >/dev/null 2>&1 || continue
  if RESOLVED="$(printf 'services: {}\n' | "$c" compose -p open-brain-tier-env --env-file "$ENV_FILE" -f - config --environment 2>/dev/null)"; then break; fi
  RESOLVED=""
done
[ -n "$RESOLVED" ] || { echo "could not read $ENV_FILE through compose — tier.sh needs docker compose (or podman compose) with \`config --environment\`." >&2; exit 2; }

TMP_ENV="$(mktemp "${TMPDIR:-/tmp}/ob1-tier-env.XXXXXX")"
chmod 600 "$TMP_ENV"
trap 'rm -f "$TMP_ENV"' EXIT

# One NAME=value line per name the file sets, value as compose resolved it; a
# runtime's --env-file takes such a line literally. A value spanning lines is
# not carried (none of the stack's knobs is one).
POSTGRES_PASSWORD=""
while IFS= read -r line; do
  name="${line%%=*}"
  case "$NAMES" in *" $name "*) ;; *) continue ;; esac
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

# HOST[:PORT][/DB] → postgres://postgres:…@HOST:PORT/DB; a URL as given.
to_url() {
  if is_url "$1"; then printf '%s' "$1"; return; fi
  [ -n "$POSTGRES_PASSWORD" ] || { echo "POSTGRES_PASSWORD is not set in $ENV_FILE or the environment — needed to build the URL for $1." >&2; exit 2; }
  local hostport="${1%%/*}" db="openbrain"
  [ "$hostport" = "$1" ] || db="${1#*/}"
  [ -n "$hostport" ] && [ -n "$db" ] || { echo "not HOST[:PORT][/DB]: $1" >&2; exit 2; }
  case "$hostport" in *:*) ;; *) hostport="$hostport:5432" ;; esac
  printf 'postgres://postgres:%s@%s/%s' "$(urlencode "$POSTGRES_PASSWORD")" "$hostport" "$db"
}

{
  printf 'TIER_FROM_URL=%s\n' "$(to_url "$FROM")"
  printf 'TIER_TO_URL=%s\n' "$(to_url "$TO")"
  if ! is_url "$TO"; then echo OB1_ALLOW_REMOTE_DB=1
  elif [ -n "${OB1_ALLOW_REMOTE_DB:-}" ]; then printf 'OB1_ALLOW_REMOTE_DB=%s\n' "$OB1_ALLOW_REMOTE_DB"
  fi
} >> "$TMP_ENV"

# Cached after the first build; rebuilt when db/tier.Dockerfile changes. Its
# output goes to stderr, so a --diff's report is the only thing on stdout.
# --load for docker: under a docker-container buildx builder (this Mac's docker
# CLI over podman is one) a build without it stays in the builder's cache and
# `run` then looks the tag up in a registry; the default builder takes it too.
LOAD=()
[ "$RUNTIME" = docker ] && LOAD=(--load)
"$RUNTIME" build -q ${LOAD[@]+"${LOAD[@]}"} -t "$IMAGE" - < "$REPO/db/tier.Dockerfile" >&2

# --init: bun would otherwise be PID 1, which ignores SIGINT, and Ctrl-C would
# leave a refresh running. The quoted script appends the URLs to the arguments
# it was given, so tier.ts's own parser sees the one --from and --to. Not
# `exec`: the EXIT trap removes the temporary env file, and set -e hands on the
# run's status.
# shellcheck disable=SC2016 # the container's sh expands them, not this one
"$RUNTIME" run --rm --init \
  --network "$NETWORK" \
  --env-file "$TMP_ENV" \
  -v "$REPO:/repo:ro" \
  "$IMAGE" \
  sh -c 'exec bun tier.ts "$@" --from "$TIER_FROM_URL" --to "$TIER_TO_URL"' tier ${PASS[@]+"${PASS[@]}"}
