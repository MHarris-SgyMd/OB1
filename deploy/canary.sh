#!/usr/bin/env bash
# Stand a canary brain beside a running stack, and take it down again (SMD-2038).
#
# The canary is this same deploy/compose.yaml run again as its own compose
# project, open-brain-canary, with its own Postgres, volume, network and images,
# its server on the next loopback port, and OB1_TIER=canary. It reads the stack's
# env file, so every knob reaches the canary's server as it reaches stable's,
# and none is copied. `down` acts on that project alone, so it cannot reach
# stable. SMD-1806 calls the running stack stable, the record the canary is
# refreshed from.
#
#   deploy/canary.sh --env-file ~/stack/deploy/.env up --connect
#   deploy/canary.sh --env-file ~/stack/deploy/.env down --volumes
#
# `up` stands the canary up, or brings a standing one level with stable again
# (after stable is redeployed, say). It can be re-run:
#   1. finds stable's Postgres by its compose labels and stamps it tier=stable
#      when it has no tier stamp. It refuses one stamped canary or working, or
#      carrying a refresh's mark: that is a copy, not the record;
#   2. starts the canary's Postgres;
#   3. refreshes it from stable through deploy/tier.sh, on both projects'
#      networks. The refresh copies stable's database settings, 014's HNSW
#      bounds among them (SMD-2037), and migrates the copy with this checkout;
#   4. builds the server from this checkout and (re)creates it, so its pool
#      opens on the refreshed database;
#   5. smoke-tests it with OB1_SMOKE_KEY, a raw key whose hash is in the env
#      file's MCP_ACCESS_KEYS (the canary accepts stable's keys). The keyed
#      /health must report tier canary, deploy/smoke.sh must pass, and a vector
#      search must find a thought by its own text;
#   6. with --connect, registers the Claude Code connector (user scope) under
#      the same key.
#
# `down` removes the canary's containers and network, and deregisters the
# connector when `claude` has one by that name at this canary's port (one at
# another URL is left alone). --volumes also deletes the canary's database,
# once it is shown to be stamped or marked canary.
#
# Options, all optional:
#   --env-file PATH       the running stack's env file (default deploy/.env beside
#                         this script — which a branch worktree does not have)
#   --runtime CLI         docker or podman (default: docker when on PATH, else podman)
#   --stable-project NAME stable's compose project (default open-brain)
#   --port N              the canary server's loopback port (default 8011)
#   --name NAME           the connector's name (default open-brain-canary)
#   up --connect          register the connector after the smoke passes
#   up --no-smoke         skip step 5 (no key needed; the connector needs one)
#   down --volumes        delete the canary's database as well
#
# The server image is built from this checkout, as compose.yaml builds stable's,
# and OB1_GIT_SHA is this checkout's `git describe` unless the shell sets it.
# Exit status: 0 done; 1 a step failed; 2 a usage error, or a refusal before
# anything changed.
set -euo pipefail
unset CDPATH

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
CANARY=open-brain-canary

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//' >&2
  exit 2
}

ENV_FILE="$HERE/.env"
RUNTIME=""
STABLE=open-brain
PORT=8011
NAME=open-brain-canary
CMD=""
CONNECT=0
SMOKE=1
VOLUMES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file|--runtime|--stable-project|--port|--name)
      [ $# -ge 2 ] && [ "${2#--}" = "$2" ] || { echo "$1 takes a value." >&2; exit 2; }
      case "$1" in
        --env-file) ENV_FILE="$2" ;;
        --runtime) RUNTIME="$2" ;;
        --stable-project) STABLE="$2" ;;
        --port) PORT="$2" ;;
        --name) NAME="$2" ;;
      esac
      shift 2 ;;
    --connect) CONNECT=1; shift ;;
    --no-smoke) SMOKE=0; shift ;;
    --volumes) VOLUMES=1; shift ;;
    up|down) [ -z "$CMD" ] || { echo "one command: up or down." >&2; exit 2; }; CMD="$1"; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[ -n "$CMD" ] || usage
case "$PORT" in ''|*[!0-9]*) echo "--port takes a number: $PORT" >&2; exit 2 ;; esac
[ "$STABLE" != "$CANARY" ] || { echo "--stable-project names the canary's own project." >&2; exit 2; }
[ "$CMD" = up ] || { [ $CONNECT = 0 ] && [ $SMOKE = 1 ]; } || { echo "--connect and --no-smoke go with up." >&2; exit 2; }
[ "$CMD" = down ] || [ $VOLUMES = 0 ] || { echo "--volumes goes with down." >&2; exit 2; }
[ $CONNECT = 0 ] || [ $SMOKE = 1 ] || { echo "--connect needs the smoke's key; drop --no-smoke." >&2; exit 2; }
[ -f "$ENV_FILE" ] || { echo "no env file at $ENV_FILE — name the running stack's with --env-file (deploy/.env is gitignored, so a worktree has none)." >&2; exit 2; }
ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"

if [ -z "$RUNTIME" ]; then
  if command -v docker >/dev/null 2>&1; then RUNTIME=docker
  elif command -v podman >/dev/null 2>&1; then RUNTIME=podman
  else echo "neither docker nor podman is on PATH." >&2; exit 2
  fi
fi

say() { printf '▸ %s\n' "$*"; }

# The canary's compose: stable's file under the canary's project name. The
# port, the tier and an empty profile list are set for these calls alone, where
# the shell wins over the env file; tier.sh, run between them, reads the env
# file without them.
canary_compose() {
  SERVER_PORT="$PORT" OB1_TIER=canary COMPOSE_PROFILES="" OB1_GIT_SHA="$GIT_SHA" \
    "$RUNTIME" compose -p "$CANARY" --env-file "$ENV_FILE" -f "$HERE/compose.yaml" "$@"
}
GIT_SHA="${OB1_GIT_SHA:-$(git -C "$REPO" describe --always --dirty 2>/dev/null || echo unknown)}"

# A container of a project's service, by compose's labels: its name, or nothing.
container_of() {
  local id
  id="$("$RUNTIME" ps -q --filter "label=com.docker.compose.project=$1" --filter "label=com.docker.compose.service=$2" | head -n 1)"
  [ -n "$id" ] || return 0
  "$RUNTIME" inspect -f '{{.Name}}' "$id" | sed 's|^/||'
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
# The refresh mark on a database (tier.ts's refreshMark: its own setting), or nothing.
mark_of() {
  psql_in "$1" "SELECT substr(c, length('ob1.refresh_target=') + 1)
    FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase, unnest(s.setconfig) c
    WHERE d.datname = current_database() AND s.setrole = 0 AND c LIKE 'ob1.refresh_target=%'"
}

# The URL the connector NAME is registered at, or nothing. Only that line is
# kept: `claude mcp get` prints the key too.
connector_url() {
  command -v claude >/dev/null 2>&1 || return 0
  # `get` exits non-zero for a name it does not know: under pipefail that
  # would end the script from inside the caller's assignment.
  { claude mcp get "$NAME" 2>/dev/null || true; } | sed -n 's/^ *URL: *//p' | head -n 1
}
# Whether a connector URL is this canary's: its port on this host. Another
# connector under the name is someone else's, and left alone.
ours() { case "$1" in "http://127.0.0.1:$PORT/"|"http://localhost:$PORT/") return 0 ;; esac; return 1; }

if [ "$CMD" = down ]; then
  if [ $VOLUMES = 1 ]; then
    pg="$(container_of "$CANARY" postgres)"
    if [ -z "$pg" ]; then
      canary_compose up -d --wait postgres
      pg="$(container_of "$CANARY" postgres)"
    fi
    # A canary by its stamp, or by the mark a refresh left (one that died
    # after its restore leaves stable's stamp behind).
    stamp="$(stamp_of "$pg")"
    mark="$(mark_of "$pg")"
    [ "$stamp" = canary ] || [ "$mark" = canary ] || {
      echo "the canary's database ($pg) is stamped '${stamp:-nothing}' and marked '${mark:-nothing}', neither canary — refusing to delete its volume. Take it down without --volumes, and look at it first." >&2
      exit 2
    }
  fi
  url="$(connector_url)"
  if [ -n "$url" ] && ours "$url"; then
    claude mcp remove --scope user "$NAME" >/dev/null
    say "connector $NAME removed"
  elif [ -n "$url" ]; then
    say "connector $NAME points at $url, not this canary's port $PORT — left as it is"
  fi
  VOLS=()
  [ $VOLUMES = 0 ] || VOLS=(--volumes)
  canary_compose down --remove-orphans ${VOLS[@]+"${VOLS[@]}"}
  say "canary down${VOLS[*]:+, its database deleted}; $STABLE untouched"
  exit 0
fi

# ── up ──────────────────────────────────────────────────────────────────────
KEY="${OB1_SMOKE_KEY:-}"
[ $SMOKE = 0 ] || [ -n "$KEY" ] || { echo "up smoke-tests the canary with OB1_SMOKE_KEY — a raw key whose hash is in MCP_ACCESS_KEYS. Set it, or pass --no-smoke." >&2; exit 2; }

STABLE_PG="$(container_of "$STABLE" postgres)"
[ -n "$STABLE_PG" ] || { echo "no running Postgres in compose project $STABLE — start the stack first, or name it with --stable-project." >&2; exit 2; }

# The port is the canary's or free: a container of another project on it (a
# canary stood up by hand) would take the canary server's place.
taken="$("$RUNTIME" ps --format '{{.Names}}|{{.Ports}}|{{.Label "com.docker.compose.project"}}' \
  | awk -F'|' -v p=":$PORT->" -v c="$CANARY" 'index($2, p) && $3 != c { print $1 }')"
[ -z "$taken" ] || { echo "port $PORT is published by $taken, outside project $CANARY — remove it, or pick another --port." >&2; exit 2; }

# The record carries no refresh mark and no tier stamp but stable's; a
# database with either is a copy a refresh made (or may reset).
stable_mark="$(mark_of "$STABLE_PG")"
[ -z "$stable_mark" ] || { echo "$STABLE_PG carries the refresh mark '$stable_mark' — it is a tier copy, not the record. Refusing: name stable's project with --stable-project." >&2; exit 2; }
stable_stamp="$(stamp_of "$STABLE_PG")"
case "$stable_stamp" in
  stable) ;;
  "")
    psql_in "$STABLE_PG" "INSERT INTO ob1_config (key, value) VALUES ('tier', 'stable') ON CONFLICT (key) DO NOTHING" >/dev/null
    say "stamped $STABLE_PG tier=stable (it had no tier stamp)" ;;
  *) echo "$STABLE_PG is stamped tier '$stable_stamp' — it is a tier copy, not the record. Refusing: name stable's project with --stable-project." >&2; exit 2 ;;
esac
stable_server="$(container_of "$STABLE" server)"
if [ -n "$stable_server" ] && ! "$RUNTIME" inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$stable_server" | grep -qx 'OB1_TIER=stable'; then
  say "note: $stable_server runs without OB1_TIER=stable — set it in $ENV_FILE and recreate the server, so its query log says which tier answered"
fi

say "canary Postgres"
canary_compose up -d --wait postgres
CANARY_PG="$(container_of "$CANARY" postgres)"

say "refresh $STABLE_PG → $CANARY_PG"
"$HERE/tier.sh" --runtime "$RUNTIME" --env-file "$ENV_FILE" --network "${STABLE}_default,${CANARY}_default" \
  --refresh --from "$STABLE_PG" --to "$CANARY_PG" --tier canary

say "canary server on 127.0.0.1:$PORT (commit $GIT_SHA)"
canary_compose up -d --build --no-deps --force-recreate server
BASE="http://127.0.0.1:$PORT"
for _ in $(seq 1 60); do
  [ "$(curl -s --max-time 2 "$BASE/health" || true)" = ok ] && break
  sleep 2
done
if [ "$(curl -s --max-time 2 "$BASE/health" || true)" != ok ]; then
  echo "the canary server did not answer /health within 120 s. Its log:" >&2
  canary_compose logs --no-color --tail 40 server >&2 || true
  exit 1
fi

if [ $SMOKE = 1 ]; then
  say "smoke"
  health="$(curl -s --max-time 20 -H "x-brain-key: $KEY" "$BASE/health")"
  tier="$(printf '%s' "$health" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("tier") or "")' 2>/dev/null || true)"
  [ "$tier" = canary ] || { echo "the keyed /health says tier '${tier:-?}', not canary: $(printf '%s' "$health" | head -c 200)" >&2; exit 1; }
  "$HERE/smoke.sh" "$BASE" "$KEY"

  # The vector arm, which smoke.sh leaves out (it runs with no provider): one
  # thought's own text must find it with a similarity, which needs the
  # provider to embed the query and the HNSW walk to reach the row.
  rpc() {
    curl -s --max-time 60 -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
      -H "x-brain-key: $KEY" -d "$1" "$BASE/" | grep -E '^(data: )?\{' | sed 's/^data: //' | tail -n 1
  }
  text_of() { python3 -c 'import sys, json; r = json.load(sys.stdin); print("\n".join(c.get("text", "") for c in (r.get("result") or {}).get("content", [])) or json.dumps(r.get("error") or r))'; }
  listed="$(rpc '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_thoughts","arguments":{"limit":1}}}' | text_of)"
  id="$(printf '%s\n' "$listed" | sed -nE 's/^ *ID: ([0-9a-f-]{36}).*/\1/p' | head -n 1)"
  if [ -z "$id" ]; then
    say "vector search not checked: the canary holds no thought to look for"
  else
    query="$(printf '%s\n' "$listed" | awk '/^1\. /{getline; sub(/^ +/, ""); print; exit}' | cut -c1-300)"
    body="$(python3 -c 'import sys, json; print(json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "search_thoughts", "arguments": {"query": sys.argv[1], "limit": 5, "threshold": 0}}}))' "$query")"
    found="$(rpc "$body" | text_of)"
    if printf '%s\n' "$found" | grep -q "ID: $id" && printf '%s\n' "$found" | grep -qE '^--- Result [0-9]+ \([0-9.]+% match\)'; then
      echo "  ✓  search_thoughts finds thought $id by its own text, with a similarity — the vector arm answers"
    else
      echo "  ✗  search_thoughts did not find thought $id by its own text with a similarity: $(printf '%s' "$found" | head -c 300)" >&2
      exit 1
    fi
  fi
fi

if [ $CONNECT = 1 ]; then
  command -v claude >/dev/null 2>&1 || { echo "--connect needs the claude CLI on PATH." >&2; exit 1; }
  url="$(connector_url)"
  if [ -n "$url" ] && ! ours "$url"; then
    echo "a connector named $NAME already points at $url, not this canary's port $PORT — left as it is. Remove it, or pass --name." >&2
    exit 1
  fi
  [ -z "$url" ] || claude mcp remove --scope user "$NAME" >/dev/null
  # Its confirmation echoes the header, key and all: not printed.
  claude mcp add --transport http --scope user "$NAME" "$BASE/" -H "x-brain-key: $KEY" >/dev/null
  say "connector $NAME → $BASE/ (user scope; a new Claude Code session sees its tools)"
fi

say "canary up: $BASE, tier canary, refreshed from $STABLE_PG"
