#!/usr/bin/env bash
# Stand a canary brain beside a running stack, and take it down again (SMD-2038).
#
# The canary is this same deploy/compose.yaml run again as its own compose
# project, open-brain-canary, with its own Postgres, volume, network and images,
# its server on 127.0.0.1 at the next port, and OB1_TIER=canary. It reads the
# stack's env file, so the canary's server gets stable's knobs and none is
# copied. The port, the address, the tier and the profiles are the canary's own.
# `down` acts on that project alone, so it cannot reach stable. SMD-1806 calls
# the running stack stable, the record the canary is refreshed from.
#
#   deploy/canary.sh --env-file ~/stack/deploy/.env up --connect
#   deploy/canary.sh --env-file ~/stack/deploy/.env down --volumes
#
# `up` stands the canary up, or brings a standing one level with stable again
# (after stable is redeployed, say). It can be re-run:
#   1. refuses, before changing anything, when:
#      - the canary's server could not reach its provider: an OB1_LLM_BASE_URL,
#        OB1_CHAT_BASE_URL or OB1_JEV_BASE_URL naming a service on stable's
#        network (`ollama`, `jev`, from a compose profile), which the canary's
#        own network does not have;
#      - its port is taken, by another container or a process on the host;
#      - --connect finds another connector under the name;
#      - stable's Postgres is stamped canary or working, or carries a
#        refresh's mark (canary, working): that is a copy, not the record.
#      Stable with no tier stamp is stamped tier=stable;
#   2. starts the canary's Postgres;
#   3. refreshes it from stable through deploy/tier.sh, on both projects'
#      networks. The refresh copies stable's database settings, 014's HNSW
#      bounds among them (SMD-2037), and migrates the copy with this checkout;
#   4. builds the server from this checkout and (re)creates it, so its pool
#      opens on the refreshed database;
#   5. smoke-tests it with OB1_SMOKE_KEY, a raw key whose hash is in the env
#      file's MCP_ACCESS_KEYS (the canary accepts stable's keys). The keyed
#      /health must report tier canary, deploy/smoke.sh must pass, and
#      search_thoughts, given a thought's own text with its literals (SMD
#      keys, dates, paths) taken out so only the vector arm can match, must
#      return that thought first at 50% or more;
#   6. with --connect, registers the Claude Code connector (user scope) under
#      the same key.
#
# `down` removes the canary's containers and network. It deregisters the
# connector when `claude` has it at user scope and at the canary's port, and
# says so when one by that name is anything else, leaving it alone. --volumes
# also deletes the canary's database: when it is stamped canary, marked by a
# refresh, or holds nothing (a first refresh that died before its mark); a
# refusal puts its Postgres back as it was. With no canary volume there is
# nothing to delete, and nothing is created to find out. Once the canary's
# containers are gone its port is known only from --port.
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
case "$PORT" in ''|*[!0-9]*|0*) echo "--port takes a port number, 1-65535: $PORT" >&2; exit 2 ;; esac
[ "$PORT" -le 65535 ] || { echo "--port takes a port number, 1-65535: $PORT" >&2; exit 2; }
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
# port, the address, the tier and an empty profile list are set for these calls
# alone, where the shell wins over the env file; tier.sh, run between them,
# reads the env file without them. The address is loopback whatever
# SERVER_BIND says for stable: a canary is for this host.
canary_compose() {
  SERVER_PORT="$PORT" SERVER_BIND=127.0.0.1 OB1_TIER=canary COMPOSE_PROFILES="" OB1_GIT_SHA="$GIT_SHA" \
    "$RUNTIME" compose -p "$CANARY" --env-file "$ENV_FILE" -f "$HERE/compose.yaml" "$@"
}
GIT_SHA="${OB1_GIT_SHA:-$(git -C "$REPO" describe --always --dirty 2>/dev/null || echo unknown)}"

# A running container of a project's service, by compose's labels: its name, or nothing.
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
read_connector() {
  CONN_URL=""; CONN_SCOPE=""
  command -v claude >/dev/null 2>&1 || return 0
  local got scope
  got="$({ claude mcp get "$NAME" 2>/dev/null || true; } | sed -nE 's/^ *(URL|Scope): */\1 /p')"
  CONN_URL="$(sed -n 's/^URL //p' <<<"$got" | head -n 1)"
  scope="$(sed -n 's/^Scope //p' <<<"$got" | head -n 1)"
  case "$scope" in
    "") CONN_SCOPE="" ;;
    User*) CONN_SCOPE=user ;; Local*) CONN_SCOPE=local ;; Project*) CONN_SCOPE=project ;;
    *) CONN_SCOPE="$scope" ;;
  esac
  [ -n "$CONN_SCOPE" ] || [ -z "$CONN_URL" ] || CONN_SCOPE=unknown
}
# The ports the canary answers on: --port, and the one its server publishes
# now if that differs (a `down` given no --port for a canary stood up with one).
canary_ports() {
  printf '%s\n' "$PORT"
  { canary_compose port server 8000 2>/dev/null || true; } | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p'
}
# Whether a connector URL is this canary's: http, this host, one of its ports,
# any path or query (`?key=` is the documented form) after it.
ours() {
  local p
  for p in $(canary_ports); do
    case "$1" in "http://127.0.0.1:$p"|"http://127.0.0.1:$p/"*|"http://127.0.0.1:$p?"*|"http://localhost:$p"|"http://localhost:$p/"*|"http://localhost:$p?"*) return 0 ;; esac
  done
  return 1
}

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
  read_connector
  if [ -n "$CONN_URL" ] && ours "$CONN_URL" && [ "$CONN_SCOPE" = user ]; then
    if claude mcp remove --scope user "$NAME" >/dev/null 2>&1; then say "connector $NAME removed"
    else say "connector $NAME: \`claude mcp remove --scope user $NAME\` failed — remove it by hand"
    fi
  elif [ -n "$CONN_URL" ] && ours "$CONN_URL"; then
    say "connector $NAME is in $CONN_SCOPE scope, not user — left as it is (claude mcp remove -s $CONN_SCOPE $NAME)"
  elif [ -n "$CONN_SCOPE" ]; then
    say "connector $NAME points at ${CONN_URL:-no URL (a stdio entry)}, not this canary — left as it is (after its containers are gone, \`down\` knows the canary's port only from --port)"
  fi
  VOLS=()
  [ $VOLUMES = 0 ] || VOLS=(--volumes)
  canary_compose down --remove-orphans ${VOLS[@]+"${VOLS[@]}"}
  if [ $VOLUMES = 0 ]; then say "canary down; $STABLE untouched"
  elif [ -n "$HAS_VOLUME" ]; then say "canary down, its database deleted; $STABLE untouched"
  else say "canary down; no canary volume ($VOLUME), nothing to delete; $STABLE untouched"
  fi
  exit 0
fi

# ── up ──────────────────────────────────────────────────────────────────────
KEY="${OB1_SMOKE_KEY:-}"
[ $SMOKE = 0 ] || [ -n "$KEY" ] || { echo "up smoke-tests the canary with OB1_SMOKE_KEY — a raw key whose hash is in MCP_ACCESS_KEYS. Set it, or pass --no-smoke." >&2; exit 2; }

# Where the canary's server would send its model calls, as compose resolves
# them for it (the fallbacks included). A bare name is a service on the
# network the server is on, and the canary's has none of stable's; an address
# (a dotted name, IPv4 or IPv6) is reached as stable reaches it.
CONFIG_ERR="$(mktemp "${TMPDIR:-/tmp}/ob1-canary-config.XXXXXX")"
trap 'rm -f "$CONFIG_ERR"' EXIT
unreachable="$(canary_compose config --format json 2>"$CONFIG_ERR" | python3 -c '
import json, sys
from urllib.parse import urlparse
env = json.load(sys.stdin)["services"]["server"].get("environment") or {}
for k in ("OB1_LLM_BASE_URL", "OB1_CHAT_BASE_URL", "OB1_JEV_BASE_URL"):
    host = urlparse(env.get(k) or "").hostname or ""
    if host and "." not in host and ":" not in host and host != "localhost":
        print(f"{k}={env[k]}")
')" || { echo "could not read the canary's configuration through \`$RUNTIME compose config --format json\` (Docker Compose v2): $(head -c 400 "$CONFIG_ERR")" >&2; exit 2; }
[ -z "$unreachable" ] || {
  echo "the canary's server would dial $(tr '\n' ' ' <<<"$unreachable")— a service on stable's network (a compose profile's), which the canary's network does not have. Name one it can reach for the canary alone, in the shell, which wins over the env file for the canary's server and leaves stable's as it is: OB1_LLM_BASE_URL=http://host.docker.internal:11434/v1 deploy/canary.sh … up (an Ollama on the host, podman: host.containers.internal), or a remote provider." >&2
  exit 2
}

STABLE_PG="$(container_of "$STABLE" postgres)"
[ -n "$STABLE_PG" ] || { echo "no running Postgres in compose project $STABLE — start the stack first, or name it with --stable-project." >&2; exit 2; }

# The port is the canary's or free: a container of another project on it (a
# canary stood up by hand) would take the canary server's place.
taken="$("$RUNTIME" ps --format '{{.Names}}|{{.Ports}}|{{.Label "com.docker.compose.project"}}' \
  | awk -F'|' -v p=":$PORT->" -v c="$CANARY" 'index($2, p) && $3 != c { print $1 }')"
[ -z "$taken" ] || { echo "port $PORT is published by $taken, outside project $CANARY — remove it, or pick another --port." >&2; exit 2; }
# … or a process on the host, which no container list shows: a connection to
# the port succeeds while the canary's own server does not publish it.
own="$({ canary_compose port server 8000 2>/dev/null || true; } | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p')"
if [ "$own" != "$PORT" ] && (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  echo "something on this host already listens on 127.0.0.1:$PORT — stop it, or pick another --port." >&2
  exit 2
fi

if [ $CONNECT = 1 ]; then
  command -v claude >/dev/null 2>&1 || { echo "--connect needs the claude CLI on PATH." >&2; exit 2; }
  read_connector
  if [ -n "$CONN_SCOPE" ] && { [ -z "$CONN_URL" ] || ! ours "$CONN_URL" || [ "$CONN_SCOPE" != user ]; }; then
    echo "a connector named $NAME is already registered ($CONN_SCOPE scope, ${CONN_URL:-no URL}), and is not this canary's at user scope — left as it is. Remove it, or pass --name." >&2
    exit 2
  fi
fi

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
  health="$(curl -s --max-time 20 -H "x-brain-key: $KEY" "$BASE/health" || true)"
  tier="$(python3 -c 'import sys, json; print(json.load(sys.stdin).get("tier") or "")' <<<"$health" 2>/dev/null || true)"
  [ "$tier" = canary ] || { echo "the keyed /health says tier '${tier:-?}', not canary: ${health:0:200}" >&2; exit 1; }
  "$HERE/smoke.sh" "$BASE" "$KEY"

  # The vector arm, which smoke.sh leaves out (it runs with no provider). A
  # thought's own text, with every literal that search matches exactly taken
  # out, is searched for, and that thought must be Result 1 at a similarity a
  # thought's own text scores. Taking the literals out matters: search_thoughts
  # is hybrid, and a keyword hit is scored by cosine too, so a probe holding an
  # SMD key, a date or a path was found by the keyword arm at 0.2% under a
  # provider answering random vectors (review pass 2). Result 1, because only
  # the first header comes before any thought's content, which is printed raw.
  #
  # The probe is the newest thought with a vector whose opening 300 characters,
  # digits aside, no other thought shares — so a template, a session summary's
  # header stamped with another date, cannot outrank it — and with 20 letters
  # or more left once its literals are out.
  #
  # needle_free TEXT: TEXT less the database's own extract_search_needles (as
  # search_thoughts reads a query) and the quote marks around a span; up to
  # three rounds, and nothing when literals remain.
  needle_free() {
    local q="$1" n
    for _ in 1 2 3; do
      n="$(printf '%s\n' "SELECT coalesce(array_to_json(extract_search_needles(:'q'))::text, '[]')" \
        | "$RUNTIME" exec -i "$CANARY_PG" psql -U postgres -d openbrain -tAq -v q="$q")"
      [ "$n" != "[]" ] || { printf '%s' "$q"; return 0; }
      q="$(python3 -c $'import json, sys\nq = sys.argv[1]\nfor x in json.loads(sys.argv[2]):\n    q = q.replace(x, " ")\nprint(q.replace(chr(34), " "))' "$q" "$n")"
    done
  }
  FLOOR=50
  probe=""
  query=""
  for id in $(psql_in "$CANARY_PG" "WITH once AS (SELECT md5(regexp_replace(left(content, 300), '[0-9]', '', 'g')) AS h FROM thoughts GROUP BY 1 HAVING count(*) = 1)
    SELECT t.id FROM thoughts t JOIN once ON once.h = md5(regexp_replace(left(t.content, 300), '[0-9]', '', 'g'))
    WHERE t.embedding IS NOT NULL ORDER BY t.created_at DESC NULLS LAST LIMIT 10"); do
    q="$(needle_free "$(psql_in "$CANARY_PG" "SELECT left(content, 1000) FROM thoughts WHERE id = '$id'")")"
    letters="${q//[^[:alpha:]]/}"
    if [ "${#letters}" -ge 20 ]; then probe="$id"; query="$q"; break; fi
  done
  if [ -z "$probe" ]; then
    say "vector search not checked: no recent thought has a vector, an opening of its own, and text left once its literals are out"
  else
    body="$(python3 -c 'import sys, json; print(json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "search_thoughts", "arguments": {"query": sys.argv[1], "limit": 5, "threshold": 0}}}))' "$query")"
    reply="$(curl -s --max-time 120 -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
      -H "x-brain-key: $KEY" -d "$body" "$BASE/" || true)"
    # The reply's last JSON frame (raw, or an SSE `data:` line), its text,
    # and its first result: `ok <similarity>`, or `no <why>`. Never fails
    # itself, so every outcome is said.
    verdict="$(python3 -c '
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
        sys.exit(print("no no result: " + text[:200].replace("\n", " ")))
    if m.group(3) != probe:
        sys.exit(print(f"no Result {m.group(1)} is {m.group(3)} ({m.group(2)}), not the probe"))
    sim = re.match(r"([0-9.]+)% match", m.group(2))
    if not sim:
        sys.exit(print(f"no Result 1 has no similarity: {m.group(2)}"))
    if float(sim.group(1)) < floor:
        sys.exit(print(f"no Result 1 at {sim.group(1)}%, under the {floor:g}% a thought scores against its own text (a provider serving another model?)"))
    print(f"ok {sim.group(1)}%")
except Exception as e:
    print(f"no the reply did not parse ({type(e).__name__}: {e}): " + raw[:200].replace("\n", " "))
' "$probe" "$FLOOR" <<<"$reply")"
    if [ "${verdict%% *}" = ok ]; then
      echo "  ✓  search_thoughts, given thought $probe's own text less its literals, returns it first at ${verdict#ok } — the vector arm answers"
    else
      echo "  ✗  search_thoughts, given thought $probe's own text less its literals, did not return it first at ${FLOOR}% or more: ${verdict#no }" >&2
      exit 1
    fi
  fi
fi

if [ $CONNECT = 1 ]; then
  [ -z "$CONN_SCOPE" ] || claude mcp remove --scope user "$NAME" >/dev/null
  # Its confirmation echoes the header, key and all: not printed.
  claude mcp add --transport http --scope user "$NAME" "$BASE/" -H "x-brain-key: $KEY" >/dev/null
  say "connector $NAME → $BASE/ (user scope; a new Claude Code session sees its tools)"
fi

say "canary up: $BASE, tier canary, refreshed from $STABLE_PG"
