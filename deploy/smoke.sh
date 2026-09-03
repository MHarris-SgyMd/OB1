#!/usr/bin/env bash
# Smoke-test a running Open Brain server over MCP.
#
# Point it at anything that speaks the protocol — the compose stack, a container on
# EKS, a Cloudflare Worker. It only needs the URL and the access key, so the same
# check works for every deployment target.
#
#   ./smoke.sh                                    # reads deploy/.env
#   ./smoke.sh https://ob1.example.com "$KEY"
#
# Exit 0 if the deployment is serving correctly, 1 otherwise. Read-only: it never
# captures a thought, so it is safe against production.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

if [ $# -ge 2 ]; then
  BASE="$1"; KEY="$2"
elif [ -f "$HERE/.env" ]; then
  BASE="http://127.0.0.1:$(grep -E '^SERVER_PORT=' "$HERE/.env" | cut -d= -f2 || echo 8000)"
  # deploy/.env holds key HASHES, not keys — by design. A raw key has to be
  # supplied, so read it from OB1_SMOKE_KEY or take it as an argument.
  KEY="${OB1_SMOKE_KEY:-}"
  if [ -z "$KEY" ]; then
    echo "deploy/.env stores hashes, not keys. Pass the raw key:" >&2
    echo "  ./smoke.sh <base-url> <access-key>" >&2
    echo "  OB1_SMOKE_KEY=<key> ./smoke.sh" >&2
    exit 2
  fi
else
  echo "usage: $0 <base-url> <access-key>   (or create deploy/.env)" >&2
  exit 2
fi

[ -n "${KEY:-}" ] || { echo "No access key." >&2; exit 2; }

pass=0; fail=0
ok()   { echo "  ✓  $1"; pass=$((pass+1)); }
bad()  { echo "  ✗  $1"; fail=$((fail+1)); }

rpc() {
  curl -s --max-time 20 \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H "x-brain-key: $KEY" \
    -d "$1" "$BASE/"
}
# Responses may be raw JSON or an SSE frame.
unwrap() { grep -E '^(data: )?\{' | sed 's/^data: //' | tail -1; }

echo "▸ $BASE"

# 1. Auth failures must stay inside the protocol. A bare 4xx makes strict MCP hosts
#    tear the connection down instead of surfacing the error.
code=$(curl -s --max-time 20 -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' "$BASE/")
[ "$code" = "200" ] && ok "unauthenticated request → HTTP 200 with a JSON-RPC envelope" \
                    || bad "unauthenticated request → HTTP $code (expected 200)"

# 2. Protocol handshake.
pv=$(rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' \
  | unwrap | python3 -c 'import sys,json;print(json.load(sys.stdin).get("result",{}).get("protocolVersion",""))' 2>/dev/null)
[ -n "$pv" ] && ok "initialize (protocol $pv)" || bad "initialize returned no protocolVersion"

# 3. The full documented tool surface.
tools=$(rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | unwrap | python3 -c 'import sys,json;print(",".join(sorted(t["name"] for t in json.load(sys.stdin)["result"]["tools"])))' 2>/dev/null)
# Nine for a write key. update_thought and delete_thought are scope-gated, so a
# read key would legitimately show six — this smoke test authenticates as a writer.
expected="capture_thought,delete_thought,fetch,list_thoughts,search,search_thoughts,search_thoughts_keyword,thought_stats,update_thought"
[ "$tools" = "$expected" ] && ok "all nine tools exposed" || bad "tool surface is '$tools'"

# 4. A read that actually reaches the database. This is the check that catches a
#    server which starts, answers the handshake, and has no working data layer.
stats=$(rpc '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"thought_stats","arguments":{}}}' \
  | unwrap | python3 -c 'import sys,json;d=json.load(sys.stdin);r=d.get("result",{});print(("ERROR: " if r.get("isError") else "")+r.get("content",[{}])[0].get("text",""))' 2>/dev/null | head -1)
case "$stats" in
  "Total thoughts: "*) ok "thought_stats reached the database — $stats" ;;
  ERROR:*)             bad "thought_stats failed — $stats" ;;
  *)                   bad "thought_stats returned nothing usable" ;;
esac

# 5. A filtered read, which exercises a different query path.
listed=$(rpc '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_thoughts","arguments":{"limit":1}}}' \
  | unwrap | python3 -c 'import sys,json;r=json.load(sys.stdin).get("result",{});print(("ERROR" if r.get("isError") else "OK"))' 2>/dev/null)
[ "$listed" = "OK" ] && ok "list_thoughts served" || bad "list_thoughts errored"

# 6. Keyword search, which is the only read path that touches migration 012 and
#    the pg_trgm extension. It needs no embedding provider — the smoke stack has
#    no real OPENROUTER_API_KEY — so unlike search_thoughts it can run here. A
#    needle that cannot plausibly be in a fresh brain: zero hits is the pass, an
#    error is the failure, and "function does not exist" is what an unapplied 012
#    looks like.
kw=$(rpc '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"search_thoughts_keyword","arguments":{"query":"zylotrope-smoke-needle"}}}' \
  | unwrap | python3 -c 'import sys,json;r=json.load(sys.stdin).get("result",{});print(("ERROR: " if r.get("isError") else "")+r.get("content",[{}])[0].get("text",""))' 2>/dev/null | head -1)
case "$kw" in
  ERROR:*)         bad "search_thoughts_keyword failed — $kw" ;;
  "No thoughts contain"*) ok "search_thoughts_keyword reached the database" ;;
  *)               bad "search_thoughts_keyword returned nothing usable — $kw" ;;
esac

echo
echo "$((pass+fail)) checks: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
