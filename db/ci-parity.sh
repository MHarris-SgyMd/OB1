#!/usr/bin/env bash
# ci-parity.sh — run what .github/workflows/fork-checks.yml runs, the way CI does:
# the database-backed suites in CI's order against ONE shared Postgres, then the
# suites and self-checks that need none, then every directory's typecheck
# (SMD-1932, SMD-1870, SMD-2903).
#
# This exists because running the suites individually cannot catch a whole class
# of bug. `with-postgres.sh` starts a fresh container per invocation, so state one
# suite leaves behind is invisible; CI reuses a single Postgres service across
# every step, so it is not. That difference hid a real failure for eight commits:
# `DROP TABLE thoughts CASCADE` removes the foreign-key constraint on
# thought_chunks, not the table, so a stale chunk table survived at the previous
# suite's vector width and the next suite failed on a dimension mismatch.
#
#   ./db/ci-parity.sh
#
# Check 35 in scripts/check-fork-consistency.ts holds this list to the workflow:
# every script a fork-checks.yml step runs is a `run` or `nodb` line here, from
# the same directory, with the same flags and the same environment (a step that
# sets DATABASE_URL is `run`, one that does not is `nodb`), and every directory
# CI runs `bunx tsc --noEmit` in a `typecheck` line, whether by a step of its
# own or one .github/ci/typecheck.sh step names (SMD-3202), as is every
# directory a step runs `bun run check` in (a SvelteKit app, SMD-2280) — or its
# job or script is excused there with why. Not here, so: the full stack and the
# authorization POC (built images and a compose stack), the landing check (a
# pull request's commit range) and the codemod's round-trip (it rewrites tracked
# files). Nor is db/test-bench-reuse.ts, three minutes of 150,000-row builds and
# exact passes (check 34 excuses it; it would run here — it drops its marker on
# exit).
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT="$PWD"

# One row per suite or typecheck: ✓ or ✗, the name, the verdict.
row() {
  local ok="$1" name="$2" verdict="$3"
  if [ "$ok" = ok ]; then printf "  \033[32m✓\033[0m %-48s %s\n" "$name" "$verdict"; else printf "  \033[31m✗\033[0m %-48s %s\n" "$name" "$verdict"; fi
}

# Each directory CI installs, once, from its lockfile. A lockfile out of step
# with package.json is reported here, apart from anything that then fails.
install() {
  local dir="$1" out
  if ! out=$(cd "$ROOT/$dir" && bun install --frozen-lockfile 2>&1); then
    row bad "$dir" "bun install --frozen-lockfile"
    printf '%s\n' "$out" | grep -Ev '^\s*$' | tail -3 | sed 's/^/        /'
    FAILED=1
  fi
}

# suite MODE DIR SCRIPT [FLAG...]: one suite or self-check, run from DIR as its
# CI step runs it. The exit code is the verdict, as it is CI's; a suite that
# prints the house tally (`N assertions: N passed, N failed`) shows it, and a
# tally with failures fails even on exit 0. Judge the tally, not the prose:
# assertion labels legitimately contain the word "error" (a suite that tests
# error messages says so), and grepping for it once marked test-update-delete
# failed while it reported 27/27.
suite() {
  local mode="$1" dir="$2" script="$3"; shift 3
  local name out rc res given
  # What the line set before its verb (OB1_EMBEDDING_DIM=768 …): what is
  # exported now and was not when main() began, so two runs of one suite read
  # apart.
  given=$(LC_ALL=C comm -13 <(printf '%s\n' "$BASE_ENV") <(env | LC_ALL=C sort) | tr '\n' ' ')
  name="${given}$([ "$dir" = . ] || printf '%s/' "$dir")$script${1:+ $*}"
  if [ "$mode" = nodb ]; then
    out=$(cd "$ROOT/$dir" && env -u DATABASE_URL bun "$script" "$@" 2>&1); rc=$?
  else
    out=$(cd "$ROOT/$dir" && bun "$script" "$@" 2>&1); rc=$?
  fi
  res=$(printf '%s' "$out" | grep -oE '[0-9]+ assertions: [0-9]+ passed, [0-9]+ failed' | tail -1)
  if [ "$rc" -ne 0 ] || printf '%s' "$res" | grep -qE ', [1-9][0-9]* failed$'; then
    row bad "$name" "${res:+$res, }exit $rc"
    if printf '%s\n' "$out" | grep -qE '✗|error:'; then
      printf '%s\n' "$out" | grep -E '✗|error:' | head -3 | sed 's/^/        /'
    else
      printf '%s\n' "$out" | grep -Ev '^\s*$' | tail -3 | sed 's/^/        /'
    fi
    FAILED=1
  else
    row ok "$name" "${res:-exit 0}"
  fi
}
# A step that sets DATABASE_URL: the shared Postgres this script started.
run() { suite db "$@"; }
# A step of a job with no database: DATABASE_URL unset, so a suite that reads
# it (test-cli, test-connect) sees what CI's does.
nodb() { suite nodb "$@"; }

# CI's typechecks, one line per directory with a tsconfig.json, run one after
# another here where CI runs most side by side (.github/ci/typecheck.sh): no
# tally to parse, so the exit code is the verdict. db/ and evals/ resolve their
# ../server-portable imports through that directory's install (SMD-1932). A
# SvelteKit directory (svelte.config.js) is checked as CI checks it, `bun run
# check` — svelte-kit sync, then svelte-check — since its tsconfig extends the
# one sync generates (SMD-2280 PR 2b; check 35 reads CI's step as its typecheck).
typecheck() {
  local dir="$1" out how="tsc --noEmit"
  [ -f "$ROOT/$dir/svelte.config.js" ] && how="bun run check"
  if out=$(cd "$ROOT/$dir" && if [ "$how" = "bun run check" ]; then bun run check; else bunx tsc --noEmit; fi 2>&1); then
    row ok "$dir" "$how"
  else
    row bad "$dir" "$how"
    # The first type errors — tsc's `error TS` lines, svelte-check's `ERROR`
    # ones; or, when neither ran (a bunx resolution failure has no such line),
    # the tail of what did print.
    if printf '%s\n' "$out" | grep -qE 'error TS| ERROR "'; then
      printf '%s\n' "$out" | grep -E 'error TS| ERROR "' | head -3 | sed 's/^/        /'
    else
      printf '%s\n' "$out" | grep -Ev '^\s*$' | tail -3 | sed 's/^/        /'
    fi
    FAILED=1
  fi
}

main() {
  FAILED=0
  BASE_ENV=$(env | LC_ALL=C sort)
  for dir in server-portable rest-client mcp-server db evals jev deploy/auth extensions scripts compat/supabase-sql dashboard; do install "$dir"; done

  # The schema on PGlite, at the default width and at 768, as db-schema runs it.
  nodb db                 test-schema.ts
  OB1_EMBEDDING_DIM=768 OB1_EMBEDDING_MODEL=nomic-embed-text nodb db test-schema.ts

  # Against the shared Postgres, in CI's order.
  # CI runs test-live.ts's four shards side by side, one matrix cell each,
  # each on a fresh database (SMD-3048, SMD-3169). Here they run in series on
  # the shared one, each dropping its schema first, which takes the rows and
  # config keys the one before left; cluster roles and any table dropSchema
  # does not list stay. A section broken by another's rows shows only in a
  # full run.
  OB1_LIVE_SHARD=rest run db test-live.ts
  OB1_LIVE_SHARD=sleep run db test-live.ts
  OB1_LIVE_SHARD=long run db test-live.ts
  OB1_LIVE_SHARD=extract run db test-live.ts
  # CI runs this one and test-preflight.ts in the background from the
  # data-layer job's start, on a Postgres of their own, beside that job's suites
  # below (SMD-2219, SMD-3195); here, in their places and in series, on the
  # shared one, test-preflight.ts where CI ran it before SMD-3195.
  run db                 test-upgrade.ts
  run db                 test-search-path.ts
  run server-portable    test-store-sql.ts
  run server-portable    test-e2e-sql.ts
  run server-portable    test-rest-sql.ts
  run server-portable    test-plugins-sql.ts
  run server-portable    test-local-provider.ts
  run evals              eval-write-path.ts --gate
  # The check drops the schema and refuses a database holding thoughts unless
  # told; this one is the throwaway with-postgres.sh started, as CI's is.
  OB1_FIXTURE_RESET=1 run evals eval-projection-replay.ts --fixture-check
  run server-portable    test-egress.ts
  run server-portable    test-audit.ts
  run server-portable    test-update-delete.ts
  run server-portable    test-agents.ts
  run server-portable    test-chunking.ts
  run server-portable    test-chunk-context.ts
  run server-portable    test-embedding-dimensions.ts
  run server-portable    test-preflight.ts
  run compat/supabase-sql test-compat.ts
  # The vendored writers of a thought's content or vector (change 69), then
  # every extension tool on the SQL shim, as CI's data-layer job runs them —
  # last, since each applies vendored schemas to the shared database and drops
  # them after.
  run extensions         test-writes.ts
  run extensions         test-tools.ts

  # Suites and self-checks that need no database, by CI job. They are here
  # because CI runs them and this script exists to be CI's local equivalent —
  # leaving them out let two stale tool-count assertions reach a pull request
  # while this reported all green.
  nodb .                 scripts/check-fork-consistency.ts
  nodb .                 recipes/session-capture-hook/test-session-capture.mjs
  nodb dashboard          test-oauth.ts
  nodb .                 deploy/forwarder.ts --self-check
  nodb .                 deploy/instance.ts --self-check
  nodb .                 deploy/edge/edge.ts --self-check
  nodb .                 scripts/ci-step-times.ts --self-check
  nodb .                 scripts/suite-sections.ts --self-check
  nodb .                 deploy/test-tier-sh.ts
  nodb server-portable    test-server.ts
  nodb server-portable    test-auth.ts
  nodb server-portable    test-rest.ts
  nodb server-portable    test-plugins.ts
  nodb server-portable    test-thoughts.ts
  nodb server-portable    test-jobs.ts
  nodb rest-client        test-client.ts
  nodb mcp-server         test-mcp.ts
  nodb jev                test-jev.ts
  nodb evals              eval-thought-kinds.ts --self-check
  nodb evals              eval-calibration.ts --self-check
  nodb evals              eval-write-path.ts --self-check
  nodb evals              eval-judge.ts --self-check
  nodb evals              eval-judge-decide.ts --self-check
  nodb evals              eval-judge-propose.ts --self-check
  nodb evals              eval-mediated-pairs.ts --self-check
  nodb evals              eval-projection-replay.ts --self-check
  nodb evals              eval-jev-gate.ts --self-check
  nodb evals              eval-transitive-freshness.ts --self-check
  nodb evals              eval-stated-status.ts --self-check
  nodb deploy/orchestration   provision.ts --self-check
  nodb deploy/orchestration   runner.ts --self-check
  nodb evals              eval-orchestration.ts --self-check
  nodb evals              eval-auth.ts --self-check
  nodb deploy/auth        store.ts --self-check
  nodb deploy/auth        provision.ts --self-check
  nodb deploy/auth        limits.ts --self-check
  nodb deploy/auth        target.ts --self-check
  nodb deploy/auth        admin.ts --self-check
  nodb extensions         test-auth.ts
  nodb db                 sync-linear.ts --self-check
  nodb db                 ingest-linear.ts --self-check
  nodb db                 ingest-markdown.ts --self-check
  nodb db                 ingest-items.ts --self-check
  nodb db                 ingest-records.ts --self-check
  nodb db                 bench-live.ts --self-check
  nodb db                 test-replay.ts
  nodb db                 test-brain-compare.ts
  nodb db                 test-cli.ts
  nodb db                 test-connect.ts
  nodb db                 test-engines.ts
  nodb db                 test-worker-bootstrap.ts
  nodb db                 test-board-findings.ts
  nodb db                 test-weekly-digest.ts
  nodb db                 test-coordinator.ts

  typecheck scripts
  typecheck server-portable
  typecheck rest-client
  typecheck mcp-server
  typecheck db
  typecheck evals
  typecheck jev
  typecheck deploy/auth
  typecheck compat/supabase-sql
  typecheck dashboard
  echo
  [ "$FAILED" -eq 0 ] && echo "  all suites passed" || echo "  FAILURES above"
  return "$FAILED"
}

if [ -n "${DATABASE_URL:-}" ]; then main; else exec "$ROOT/db/with-postgres.sh" "$0"; fi
