#!/usr/bin/env bash
# The hold steps' cases, side by side (SMD-3365). Sourced from deploy/ by the
# coordinator's workers and sleep steps, which SMD-3214 made hold a refusal
# rather than exit: each case starts the coordinator's own command (SMD-3476),
# detached, with OB1_PASSES naming its passes and one setting wrong; its
# refusal must be logged, the container still running after it — it does not
# exit, so `unless-stopped` has nothing to restart in a loop — and a stop must
# end it with 0 within 15 s.
#
# Run one case after another, each polling its log every 2 s and then sleeping
# a fixed 2 s, the two steps took ~83 s of "Full stack, no Supabase", the
# slowest Fork Checks job. Here a batch's cases start together, each log is
# polled every 0.2 s under one 60 s bound for the batch, and the 2 s settle is
# the batch's, not each case's: every case is still running at least 2 s after
# its line, as before. A step whose cases read shared state (heartbeat:sleep)
# runs them as batches of their own.
#
#   held_case <id> <passes> <line> [compose run args…]   start one, detached
#   held_wait                                            wait for the batch, check it, stop it
#   held_also <id> <line>                                after held_wait: another line that case logged
#   held_never <id> <line>                               after held_wait: a line that case must not have logged
#
# Every failing case is reported with its log, not only the first; then the
# step fails. A case's log stays in "$HELD_DIR/<id>.out" for held_also; its
# container's name and its line are files there too, not associative arrays,
# so a rehearsal under macOS's bash 3.2 runs what CI's bash 5 runs.
# Under bash -e -o pipefail, the workflow's default shell. No `grep -q` on a
# pipe: under pipefail it can exit 141 when grep stops reading before
# `docker logs` has written everything (SMD-3334).

HELD_DIR=$(mktemp -d)
HELD_IDS=()

held_case() {
  local id=$1 passes=$2 want=$3
  shift 3
  local ct="ci-held-$id-$RANDOM"
  # A name used again in a later batch reads nothing of its last run.
  rm -f "$HELD_DIR/$id".*
  printf '%s' "$ct" > "$HELD_DIR/$id.ct"
  printf '%s' "$want" > "$HELD_DIR/$id.want"
  HELD_IDS+=("$id")
  # Started in the background, each its own container; a start that fails is
  # recorded and reported by held_wait, where the batch is waited on.
  ( docker compose -f compose.yaml run -d --no-deps --name "$ct" -e "OB1_PASSES=$passes" "$@" coordinator > /dev/null 2> "$HELD_DIR/$id.start" || touch "$HELD_DIR/$id.unstarted" ) &
}

held_wait() {
  local id ct want failed=0 deadline running code took
  wait
  deadline=$((SECONDS + 60))
  # Each case's line, polled every 0.2 s, the batch under one bound. A case
  # that never logs it is found below, from its log.
  for id in "${HELD_IDS[@]}"; do
    ct=$(cat "$HELD_DIR/$id.ct")
    want=$(cat "$HELD_DIR/$id.want")
    (
      until docker logs "$ct" 2>&1 | grep -F -- "$want" > /dev/null; do
        [ "$SECONDS" -lt "$deadline" ] || exit 0
        sleep 0.2
      done
    ) &
  done
  wait
  # The batch's settle: every case still running 2 s after its line is held, not exited.
  sleep 2
  for id in "${HELD_IDS[@]}"; do
    ct=$(cat "$HELD_DIR/$id.ct")
    docker logs "$ct" > "$HELD_DIR/$id.out" 2>&1 || true
    docker inspect -f '{{.State.Running}}' "$ct" > "$HELD_DIR/$id.running" 2>&1 || true
  done
  # Stopped together, each timed.
  for id in "${HELD_IDS[@]}"; do
    ct=$(cat "$HELD_DIR/$id.ct")
    ( t=$(date +%s); docker stop -t 30 "$ct" > /dev/null 2>&1 || true; echo $(( $(date +%s) - t )) > "$HELD_DIR/$id.took" ) &
  done
  wait
  for id in "${HELD_IDS[@]}"; do
    ct=$(cat "$HELD_DIR/$id.ct")
    want=$(cat "$HELD_DIR/$id.want")
    running=$(cat "$HELD_DIR/$id.running")
    code=$(docker inspect -f '{{.State.ExitCode}}' "$ct" 2>&1 || true)
    took=$(cat "$HELD_DIR/$id.took")
    docker rm "$ct" > /dev/null 2>&1 || true
    if [ -e "$HELD_DIR/$id.unstarted" ]; then
      echo "--- $id: the container did not start: ---" >&2; cat "$HELD_DIR/$id.start" >&2; failed=1
    elif ! grep -F -- "$want" "$HELD_DIR/$id.out" > /dev/null || [ "$running" != true ] || [ "$code" != 0 ] || [ "$took" -gt 15 ]; then
      echo "--- $id: expected \"$want\", still running after it, then exit 0 within 15 s of a stop; got running=$running, exit $code after ${took} s: ---" >&2
      cat "$HELD_DIR/$id.out" >&2
      failed=1
    fi
  done
  HELD_IDS=()
  if [ "$failed" != 0 ]; then exit 1; fi
}

held_also() {
  if ! grep -F -- "$2" "$HELD_DIR/$1.out" > /dev/null; then
    echo "--- $1: expected \"$2\" too: ---" >&2
    cat "$HELD_DIR/$1.out" >&2
    exit 1
  fi
}

held_never() {
  if grep -F -- "$2" "$HELD_DIR/$1.out" > /dev/null; then
    echo "--- $1: expected no \"$2\": ---" >&2
    cat "$HELD_DIR/$1.out" >&2
    exit 1
  fi
}
