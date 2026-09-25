#!/usr/bin/env bash
# ci-parity.sh — run every database-backed suite the way CI does: in CI's order,
# against ONE shared Postgres — then the suites that need none, and the five
# directories' typechecks (SMD-1932, SMD-1870).
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
# Suites needing a model provider (evals/) are not included — CI does not run
# those either (evals/ is type-checked, not run); nor is db/test-bench-reuse.ts, three minutes of 150,000-row
# builds and exact passes (it would run here — it drops its marker on exit).
set -u
cd "$(dirname "$0")/.."
ROOT="$PWD"

# One row per suite or typecheck: ✓ or ✗, the name, the verdict.
row() {
  local ok="$1" name="$2" verdict="$3"
  if [ "$ok" = ok ]; then printf "  \033[32m✓\033[0m %-26s %s\n" "$name" "$verdict"; else printf "  \033[31m✗\033[0m %-26s %s\n" "$name" "$verdict"; fi
}

run() {
  local dir="$1" script="$2" out res
  out=$(cd "$ROOT/$dir" && bun "$script" 2>&1)
  res=$(printf '%s' "$out" | grep -oE '[0-9]+ assertions: [0-9]+ passed, [0-9]+ failed' | tail -1)
  # Judge the reported tally, not the prose: assertion labels legitimately
  # contain the word "error" (a suite that tests error messages says so), and
  # grepping for it marked test-update-delete failed while it reported 27/27.
  if printf '%s' "$res" | grep -qvE ', 0 failed$' || [ -z "$res" ]; then
    row bad "$script" "${res:-crashed}"
    printf '%s\n' "$out" | grep -E '✗|error:' | head -3 | sed 's/^/        /'
    FAILED=1
  else
    row ok "$script" "${res:-ok}"
  fi
}

# CI's Typecheck steps, one per directory with a tsconfig.json: no tally to
# parse, so the exit code is the verdict. Each directory's own install first,
# as CI does (the pinned tsc and @types/bun live there); db/ and evals/ resolve
# their ../server-portable imports through that directory's install, which the
# suites above have already needed (SMD-1932).
typecheck() {
  local dir="$1" out
  # The install and the compile fail for different reasons and are reported
  # apart: a lockfile out of step with package.json is not a type error.
  if ! out=$(cd "$ROOT/$dir" && bun install --frozen-lockfile 2>&1); then
    row bad "$dir" "bun install --frozen-lockfile"
    printf '%s\n' "$out" | grep -Ev '^\s*$' | tail -3 | sed 's/^/        /'
    FAILED=1
    return
  fi
  if out=$(cd "$ROOT/$dir" && bunx tsc --noEmit 2>&1); then
    row ok "$dir" "tsc --noEmit"
  else
    row bad "$dir" "tsc --noEmit"
    # The first type errors; or, when tsc itself did not run (a bunx
    # resolution failure has no `error TS` line), the tail of what did print.
    if printf '%s\n' "$out" | grep -qE 'error TS'; then
      printf '%s\n' "$out" | grep -E 'error TS' | head -3 | sed 's/^/        /'
    else
      printf '%s\n' "$out" | grep -Ev '^\s*$' | tail -3 | sed 's/^/        /'
    fi
    FAILED=1
  fi
}

main() {
  FAILED=0
  run db                 test-schema.ts
  run db                 test-live.ts
  # CI runs this one beside test-preflight.ts, on a database of its own
  # (SMD-2219); in series here, on the shared one.
  run db                 test-upgrade.ts
  run db                 test-search-path.ts
  run server-portable    test-store-sql.ts
  run server-portable    test-e2e-sql.ts
  run server-portable    test-local-provider.ts
  run server-portable    test-audit.ts
  run server-portable    test-update-delete.ts
  run server-portable    test-agents.ts
  run server-portable    test-store-postgrest.ts
  run server-portable    test-chunking.ts
  run server-portable    test-chunk-context.ts
  run server-portable    test-embedding-dimensions.ts
  run server-portable    test-preflight.ts
  run compat/supabase-sql test-compat.ts
  # The vendored writers of a thought's content or vector (change 69), as
  # CI's data-layer job runs them — last, since the suite applies two vendored
  # sidecar schemas to the shared database and drops them after. Its
  # dependencies are extensions/'s pinned install.
  (cd "$ROOT/extensions" && bun install --frozen-lockfile >/dev/null)
  run extensions         test-writes.ts

  # Suites that need no database. They are here because CI runs them and this
  # script exists to be CI's local equivalent — leaving them out let two stale
  # tool-count assertions reach a pull request while this reported all green.
  run server-portable    test-server.ts
  run server-portable    test-auth.ts
  run server-portable    test-thoughts.ts
  typecheck server-portable
  typecheck compat/supabase-sql
  typecheck db
  typecheck evals
  typecheck scripts
  echo
  [ "$FAILED" -eq 0 ] && echo "  all suites passed" || echo "  FAILURES above"
  return "$FAILED"
}

if [ -n "${DATABASE_URL:-}" ]; then main; else exec "$ROOT/db/with-postgres.sh" "$0"; fi
