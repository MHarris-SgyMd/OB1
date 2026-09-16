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
#   OB1_PG_KEEP=<name> ./with-postgres.sh bun bench-hnsw.ts
#
# keeps the database instead: the container's data directory is a NAMED volume,
# ob1-pg-keep-<name>, which the removal on exit leaves in place (`rm -v` removes
# anonymous volumes only, on both runtimes). Running again with the same
# OB1_PG_KEEP starts a fresh container on that volume — the image, shared memory
# and port given now apply, as on any run — and hands the command the same
# database, which is how bench-hnsw.ts reuses a ten-million-row corpus it built
# on an earlier pass instead of spending half an hour rebuilding it (SMD-1493).
# The container is named after <name> too, so a second invocation under a name
# whose database is in use is refused rather than sharing it. What was kept is
# the operator's to remove, and the exit line prints the command. Without the
# variable nothing survives a run, as before.
#
# In CI this script is not used: GitHub Actions provides the database as a service
# container and sets DATABASE_URL directly.
set -euo pipefail

IMAGE="${OB1_PG_IMAGE:-pgvector/pgvector:0.8.6-pg16}"
KEEP="${OB1_PG_KEEP:-}"
if [ -n "$KEEP" ] && ! [[ "$KEEP" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
  echo "OB1_PG_KEEP must be a name (letters, digits, '_', '.', '-'), got: $KEEP" >&2
  exit 2
fi
if [ -n "$KEEP" ]; then NAME="ob1-pg-keep-$KEEP"; else NAME="ob1-test-pg-$$"; fi
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

# -v: the postgres image declares a VOLUME for its data directory, so `rm`
# alone leaves an anonymous volume behind every run — 776 of them, 79 GB, had
# accumulated on one machine before the podman VM ran out of disk mid-bench
# (SMD-945 review pass). Both runtimes take -v.
#
# Under OB1_PG_KEEP the same removal runs after a `stop` with time for Postgres
# to checkpoint a large database cleanly (the runtimes' default of 10 s would
# SIGKILL it into crash recovery on the next start); the named volume is not an
# anonymous one, so `rm -v` leaves it, and the exit line says how to remove it.
# Only the container THIS invocation created is touched, and only by the ID
# `create` returned — never by name: under OB1_PG_KEEP the name is shared
# across invocations, so a refusal below must not stop the container another
# owns, and a removal by name could take a container another invocation
# created after ours went. The container is created and started as two steps
# so the ID is known even when the start fails (a port taken between the pick
# and the bind): a created-but-never-started container still holds an
# anonymous volume without OB1_PG_KEEP — the leak the -v is for. A `create`
# that fails leaves nothing, and nothing is cleaned. The removal hint names
# the runtime as this script found it: `/opt/podman/bin/podman` is chosen
# exactly when `podman` is not on PATH, so its basename would not paste.
CID=""
cleanup() {
  # A Ctrl-C during the stop below must not abort the removal and the hint:
  # ignored, not reset — the default disposition would let a second Ctrl-C
  # kill the runtime client and the shell with it, mid-stop.
  trap '' INT TERM
  if [ -z "$CID" ]; then
    # No ID reached the shell. Under OB1_PG_KEEP the name may be another
    # invocation's and nothing is touched; otherwise the per-process name is
    # ours alone, and a `create` the runtime finished after an interrupt cut
    # the substitution short would leave a container and its anonymous volume.
    [ -n "$KEEP" ] || "$RUNTIME" rm -fv "$NAME" >/dev/null 2>&1 || true
    return 0
  fi
  if [ -n "$KEEP" ]; then
    echo
    echo "▸ kept the database in volume $NAME. Reuse: OB1_PG_KEEP=$KEEP ./with-postgres.sh …"
    echo "  Remove: $RUNTIME volume rm $NAME"
    echo -n "  stopping $NAME (a checkpoint; up to two minutes) "
    "$RUNTIME" stop -t 120 "$CID" >/dev/null 2>&1 || true
    "$RUNTIME" rm -fv "$CID" >/dev/null 2>&1 || true
    echo "— done"
  else
    "$RUNTIME" rm -fv "$CID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
# An interrupt is noted, not acted on: the command below sees the signal
# itself (a psql cancelling a query, a bench exiting on Ctrl-C), the script
# exits once through the EXIT trap with the command's own status — or the
# signal's, where the command did not survive it — rather than running
# cleanup for the signal and again for the exit (bash 3.2 does both) or
# replacing a clean exit with 130 (review pass, reproduced).
INTERRUPTED=""
trap 'INTERRUPTED=130' INT
trap 'INTERRUPTED=143' TERM

# /dev/shm: both runtimes give a container 64 MB, and Postgres puts its dynamic
# shared memory there — a parallel HNSW build keeps the whole graph in it, sized
# by maintenance_work_mem, so a build under more than 64 MB fails with "could
# not resize shared memory segment ... No space left on device". bench-hnsw.ts
# builds under 256 MB at its default scales and under gigabytes at a million
# rows and up (SMD-1018). The size is a tmpfs cap, backed only as it is used,
# so 1 GB by default costs nothing the tests notice; a large bench sets
# OB1_PG_SHM_SIZE at least as large as the maintenance_work_mem it builds with
# (the README's commands say how much). It is a cap, not a reservation: the
# pages the build fills are the VM's RAM, so the podman machine or Docker
# Desktop VM must have more memory than the size named here (the published
# ten-million-row run used a 14.8 GB VM; `podman machine init` gives 2 GB).
# Where the VM cannot grow, OB1_BENCH_BUILD_WORKERS=0 builds serially in
# ordinary backend memory and needs no /dev/shm at all.
SHM_SIZE="${OB1_PG_SHM_SIZE:-1g}"

MOUNT_ARGS=()
VOLUME_NOTE=""
if [ -n "$KEEP" ]; then
  # A container of this name still present is one of two things: EXITED, the
  # shell an interrupted run (no trap ran) left behind, whose data is in the
  # volume — removed, and the run goes on; or anything else — running, paused,
  # STOPPING (another invocation's exit checkpointing the database, which
  # reads as not running), or created (another invocation between its
  # `create` and `start`; or a shell whose start failed and whose trap never
  # ran) — refused, since sharing a database would let whichever exits first
  # stop it under the other, and the created case cannot be told from the
  # race, so the refusal names the removal for the operator to judge.
  # One inspect, one snapshot: the status and the ID come from the same read,
  # and the removal goes by that ID — a forced removal by name would take
  # whatever holds the name at that instant, another invocation's freshly
  # created container included. A name that vanished between the two reads
  # (another invocation's removal) is no container at all, and `create`
  # decides who has the name.
  STALE="$("$RUNTIME" container inspect -f '{{.State.Status}} {{.Id}}' "$NAME" 2>/dev/null || true)"
  if [ -n "$STALE" ]; then
    STATUS="${STALE%% *}"
    case "$STATUS" in
      exited|stopped|dead) "$RUNTIME" rm -fv "${STALE#* }" >/dev/null 2>&1 || true ;;
      created)
        # Created and never started: an interrupt that landed between the
        # runtime accepting `create` and the ID reaching the shell (tens of
        # milliseconds, reproduced) left a shell cleanup could not know about,
        # and every later run would refuse it for ever. Another invocation
        # between its own two steps looks the same for about as long; it
        # loses its start with a clear error and nothing else, the volume
        # being shared and untouched. Removed by the inspected ID.
        "$RUNTIME" rm -fv "${STALE#* }" >/dev/null 2>&1 || true
        ;;
      *)
        echo "$NAME is $STATUS: another with-postgres.sh under OB1_PG_KEEP=$KEEP owns that database. Wait for it, use another name, or — if nothing else is running under this name — remove it: $RUNTIME rm -fv $NAME" >&2
        exit 2
        ;;
    esac
  fi
  # The data directory is PINNED, not discovered: PGDATA is set on the
  # container to the path the volume is mounted at, which the official
  # entrypoint honours on every major (the pg18 images moved their default to
  # /var/lib/postgresql/<major>/docker under a VOLUME at /var/lib/postgresql;
  # that one becomes an anonymous volume the removal takes). A discovered path
  # needs a default when the image names none, and a wrong default would keep
  # an empty volume while the corpus went into the anonymous one.
  PGDATA_PATH=/var/lib/postgresql/data
  MOUNT_ARGS=(-e "PGDATA=$PGDATA_PATH" -v "$NAME:$PGDATA_PATH")
  # The stop timeout the exit uses, on the container too, so an operator's own
  # `stop` checkpoints as cleanly. Only here: podman's `rm -f` honours it, and
  # a throwaway container should go at once, as before.
  MOUNT_ARGS+=(--stop-timeout 120)
  if "$RUNTIME" volume inspect "$NAME" >/dev/null 2>&1; then VOLUME_NOTE=", on the kept volume $NAME"; KEPT_VOLUME_EXISTS=1; else VOLUME_NOTE=", new volume $NAME kept"; KEPT_VOLUME_EXISTS=0; fi
fi

echo "▸ starting $IMAGE as $NAME on :$PORT (via $(basename "$RUNTIME")), /dev/shm $SHM_SIZE$VOLUME_NOTE"
CID="$("$RUNTIME" create --name "$NAME" \
  -e POSTGRES_PASSWORD="$PASSWORD" \
  -e POSTGRES_DB="$DB" \
  -p "$PORT:5432" \
  --shm-size "$SHM_SIZE" \
  ${MOUNT_ARGS[@]+"${MOUNT_ARGS[@]}"} \
  "$IMAGE")"
"$RUNTIME" start "$CID" >/dev/null

# A fresh data directory is ready in seconds. A kept one may start into crash
# recovery (a host that slept, a machine restarted) and replay WAL for minutes
# at ten million rows, during which pg_isready reports it as starting; giving
# up at a minute would stop it mid-replay and the next run would start over.
# A container that has EXITED — a kept data directory this image cannot open,
# a bad parameter — is not waited for at all: its logs say why, at once.
# The long wait is for a kept data directory that already exists (WAL to
# replay); a new one initialises in seconds and gets the ordinary minute.
if [ -n "$KEEP" ] && [ "${KEPT_VOLUME_EXISTS:-0}" = 1 ]; then READY_TRIES=1800; else READY_TRIES=60; fi
# Readiness is TCP readiness: over the unix socket, pg_isready is answered for
# a moment by the entrypoint's initdb-time temporary server (listening on no
# TCP address) before the real one is up, and a client that connected in that
# window failed; under OB1_PG_KEEP the exit that followed stopped the
# container mid-initialisation and left a volume the entrypoint then treated
# as initialised (review pass, reproduced at ~200 ms).
ready() { "$RUNTIME" exec "$CID" pg_isready -h 127.0.0.1 -U postgres -d "$DB" >/dev/null 2>&1; }
echo -n "▸ waiting for readiness "
for _ in $(seq 1 "$READY_TRIES"); do
  if ready; then
    echo "— ready"
    break
  fi
  # Not ready. Whether the container is still running is asked of the runtime
  # on every miss — a non-running container's exec fails with 125 on podman
  # but 1 on docker, the same code pg_isready gives for "starting", so the
  # exit code cannot tell them apart — and only an explicit "false" ends the
  # wait: a failed inspect (a transient runtime error) prints nothing and must
  # not read as an exit, or one bad call would stop a thirty-minute recovery.
  if [ "$("$RUNTIME" container inspect -f '{{.State.Running}}' "$CID" 2>/dev/null || true)" = "false" ]; then
    echo " — the container exited"
    break
  fi
  echo -n "."
  sleep 1
done

if ! ready; then
  echo >&2
  echo "Postgres did not become ready. Container logs:" >&2
  "$RUNTIME" logs "$CID" 2>&1 | tail -20 >&2
  exit 1
fi

export DATABASE_URL="postgres://postgres:$PASSWORD@127.0.0.1:$PORT/$DB"
echo "▸ DATABASE_URL=$DATABASE_URL"
echo

# The command's own status is the script's; a signal that reached the wrapper
# while the command ran is reported only where the command did not survive it.
STATUS=0
"$@" || STATUS=$?
if [ "$STATUS" != 0 ] && [ -n "$INTERRUPTED" ]; then STATUS="$INTERRUPTED"; fi
exit "$STATUS"
