#!/usr/bin/env bash
# Run a command against a throwaway Postgres + pgvector container.
#
#   ./with-postgres.sh bun test-live.ts
#   ./with-postgres.sh psql "$DATABASE_URL"
#
# Works with podman or docker, whichever is available — podman first, since that
# is what this project's authors run. The container is named distinctly and removed
# on exit, so it will not collide with or outlive anything else you have running.
#
# In CI this script is not used: GitHub Actions provides the database as a service
# container and sets DATABASE_URL directly.
set -euo pipefail

IMAGE="${OB1_PG_IMAGE:-pgvector/pgvector:0.8.6-pg16}"
NAME="ob1-test-pg-$$"
# Pick a free port rather than a fixed one: a leftover container from an
# interrupted run would otherwise fail every later run with "address already in
# use", and two suites cannot run at once.
pick_port() {
  if [ -n "${OB1_PG_PORT:-}" ]; then echo "$OB1_PG_PORT"; return; fi
  for _ in $(seq 1 50); do
    p=$(( 49152 + RANDOM % 15000 ))
    if ! (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null; then echo "$p"; return; fi
    exec 3>&- 2>/dev/null || true
  done
  echo 55432
}
PORT="$(pick_port)"
PASSWORD="ob1test"
DB="ob1test"

if command -v podman >/dev/null 2>&1; then
  RUNTIME=podman
elif [ -x /opt/podman/bin/podman ]; then
  RUNTIME=/opt/podman/bin/podman   # macOS installer location, often not on PATH
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  RUNTIME=docker
else
  echo "No working container runtime found." >&2
  echo "  podman:  podman machine start" >&2
  echo "  docker:  start Docker Desktop, or point DOCKER_HOST at podman's socket" >&2
  exit 2
fi

cleanup() { "$RUNTIME" rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

echo "▸ starting $IMAGE as $NAME on :$PORT (via $(basename "$RUNTIME"))"
"$RUNTIME" run -d --name "$NAME" \
  -e POSTGRES_PASSWORD="$PASSWORD" \
  -e POSTGRES_DB="$DB" \
  -p "$PORT:5432" \
  "$IMAGE" >/dev/null

echo -n "▸ waiting for readiness "
for _ in $(seq 1 60); do
  if "$RUNTIME" exec "$NAME" pg_isready -U postgres -d "$DB" >/dev/null 2>&1; then
    echo "— ready"
    break
  fi
  echo -n "."
  sleep 1
done

if ! "$RUNTIME" exec "$NAME" pg_isready -U postgres -d "$DB" >/dev/null 2>&1; then
  echo >&2
  echo "Postgres did not become ready. Container logs:" >&2
  "$RUNTIME" logs "$NAME" 2>&1 | tail -20 >&2
  exit 1
fi

export DATABASE_URL="postgres://postgres:$PASSWORD@127.0.0.1:$PORT/$DB"
echo "▸ DATABASE_URL=$DATABASE_URL"
echo

"$@"
