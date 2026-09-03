#!/usr/bin/env bash
# ci-parity.sh — run every database-backed suite the way CI does: in CI's order,
# against ONE shared Postgres.
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
# those either.
set -u
cd "$(dirname "$0")/.."
ROOT="$PWD"

run() {
  local dir="$1" script="$2" out res
  out=$(cd "$ROOT/$dir" && bun "$script" 2>&1)
  res=$(printf '%s' "$out" | grep -oE '[0-9]+ assertions: [0-9]+ passed, [0-9]+ failed' | tail -1)
  # Judge the reported tally, not the prose: assertion labels legitimately
  # contain the word "error" (a suite that tests error messages says so), and
  # grepping for it marked test-update-delete failed while it reported 27/27.
  if printf '%s' "$res" | grep -qvE ', 0 failed$' || [ -z "$res" ]; then
    printf "  \033[31m✗\033[0m %-26s %s\n" "$script" "${res:-crashed}"
    printf '%s\n' "$out" | grep -E '✗|error:' | head -3 | sed 's/^/        /'
    FAILED=1
  else
    printf "  \033[32m✓\033[0m %-26s %s\n" "$script" "${res:-ok}"
  fi
}

main() {
  FAILED=0
  run db                 test-schema.ts
  run db                 test-live.ts
  run server-portable    test-store-sql.ts
  run server-portable    test-e2e-sql.ts
  run server-portable    test-local-provider.ts
  run server-portable    test-audit.ts
  run server-portable    test-update-delete.ts
  run server-portable    test-agents.ts
  run server-portable    test-store-postgrest.ts
  run server-portable    test-chunking.ts
  run server-portable    test-embedding-dimensions.ts
  run server-portable    test-preflight.ts
  run compat/supabase-sql test-compat.ts

  # Suites that need no database. They are here because CI runs them and this
  # script exists to be CI's local equivalent — leaving them out let two stale
  # tool-count assertions reach a pull request while this reported all green.
  run server-portable    test-server.ts
  run server-portable    test-auth.ts
  run server-portable    test-thoughts.ts
  echo
  [ "$FAILED" -eq 0 ] && echo "  all suites passed" || echo "  FAILURES above"
  return "$FAILED"
}

if [ -n "${DATABASE_URL:-}" ]; then main; else exec "$ROOT/db/with-postgres.sh" "$0"; fi
