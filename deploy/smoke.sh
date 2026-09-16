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
#
# Checks 2, 3 and 4 are the ones a Supabase Edge Function deployment cannot
# pass; FORK.md changes 42 and 75 say why, and why those failures are real.
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

# The base URL must be a URL: check 2 derives the origin from it, and a scheme-less
# or query-carrying value would silently probe the wrong place.
case "$BASE" in
  *\?*) echo "base-url carries a query string; pass the key as the second argument, not in the URL" >&2; exit 2 ;;
  [Hh][Tt][Tt][Pp]://[!/]*|[Hh][Tt][Tt][Pp][Ss]://[!/]*) ;;
  *) echo "base-url must be http://host[/path] or https://host[/path] (got: $BASE)" >&2; exit 2 ;;
esac
# No trailing slashes: "$BASE/" must be one slash for the POST checks, and check
# 2's path suffix must not end in "/" or it probes a slash variant of the document.
while [ "${BASE%/}" != "$BASE" ]; do BASE="${BASE%/}"; done

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
# HTTP status of a GET, following redirects as the MCP SDK client does.
status() { curl -sL --max-redirs 5 --max-time 20 -o /dev/null -w '%{http_code}' "$@"; }

echo "▸ $BASE"

# 1. Auth failures must stay inside the protocol. A bare 4xx makes strict MCP hosts
#    tear the connection down instead of surfacing the error.
code=$(curl -s --max-time 20 -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' "$BASE/")
[ "$code" = "200" ] && ok "unauthenticated request → HTTP 200 with a JSON-RPC envelope" \
                    || bad "unauthenticated request → HTTP $code (expected 200)"

# 2. OAuth discovery: claude.ai fetches this at the ORIGIN root (server path as a
#    suffix) before opening a connector, and proceeds on the key only on a 404.
#    Probed without the key: the SDK copies the connector URL's query onto its
#    first, path-aware discovery GET (the root fallback carries none), but the
#    route answers 404 before authenticate() whether or not a key rides along,
#    so a keyless probe asks the same question. FORK.md
#    change 42 has the rest, including the two deployment shapes that answer
#    this path before the server does.
origin=$(printf '%s' "$BASE" | sed -E 's#^([A-Za-z]+://[^/]+).*#\1#')
suffix="${BASE#"$origin"}"
disc="$origin/.well-known/oauth-protected-resource"
miss=""
for u in "$disc" ${suffix:+"$disc$suffix"}; do
  code=$(status "$u")
  [ "$code" = "404" ] || { miss="$u → HTTP $code"; break; }
done
[ -z "$miss" ] && ok "OAuth discovery at the origin root → HTTP 404 (no OAuth here; the connector proceeds on the key)" \
               || bad "OAuth discovery: $miss (expected 404 — route /.well-known/ to the server or 404 it at the proxy; FORK.md change 42)"

# 3. GET at the endpoint is 405: it serves POST only (FORK.md change 75; before
#    it, a keyed GET hung on an SSE stream the per-request transport never
#    closed). Probed with NO key — the answer comes before authenticate(), and
#    status() follows redirects, on which curl forwards a custom header to
#    whatever host comes next. A 200 is the method guard missing, or a front
#    proxy answering GET / itself. A Supabase Edge Function fails here:
#    upstream's server has no method guard (#424, their PR #425).
code=$(status "$BASE/")
[ "$code" = "405" ] && ok "GET the endpoint → HTTP 405 (POST only; the SDK client's expected answer to its stream probe)" \
                    || bad "GET the endpoint → HTTP $code (expected 405: the method guard is missing, or a front proxy answers GET / itself — forward GET to the server; FORK.md change 75)"

# 4. GET /health is 200 with the body `ok`: the liveness target for a platform
#    probe that can only GET. "$BASE/health" is right whether or not the proxy
#    strips its prefix; the match rule is the HEALTH_PATH comment in
#    server-portable/index.ts. No key, for the same reasons as check 3. The body
#    is asserted because a 200 alone proves nothing here: upstream's server has
#    no such route and answers a keyless GET with a 200 JSON-RPC refusal, and a
#    proxy that redirects unknown paths to a landing page answers 200 too.
hb=$(curl -sL --max-redirs 5 --max-time 20 "$BASE/health")
[ "$hb" = "ok" ] && ok "GET /health → 200 ok (the liveness target for GET-only probes)" \
                 || bad "GET /health → '$(printf '%s' "$hb" | head -c 60)' (expected the body 'ok': route GET /health to the server as you route POST; FORK.md change 75)"

# 5. Protocol handshake.
pv=$(rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' \
  | unwrap | python3 -c 'import sys,json;print(json.load(sys.stdin).get("result",{}).get("protocolVersion",""))' 2>/dev/null)
[ -n "$pv" ] && ok "initialize (protocol $pv)" || bad "initialize returned no protocolVersion"

# 6. The full documented tool surface.
tools=$(rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | unwrap | python3 -c 'import sys,json;print(",".join(sorted(t["name"] for t in json.load(sys.stdin)["result"]["tools"])))' 2>/dev/null)
# Ten for a write key. capture_thought, update_thought and delete_thought are
# scope-gated, so a read key would legitimately show seven — this smoke test
# authenticates as a writer.
expected="capture_thought,delete_thought,fetch,list_supersession_proposals,list_thoughts,search,search_thoughts,search_thoughts_keyword,thought_stats,update_thought"
[ "$tools" = "$expected" ] && ok "all ten tools exposed" || bad "tool surface is '$tools'"

# 7. A read that actually reaches the database. This is the check that catches a
#    server which starts, answers the handshake, and has no working data layer.
stats=$(rpc '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"thought_stats","arguments":{}}}' \
  | unwrap | python3 -c 'import sys,json;d=json.load(sys.stdin);r=d.get("result",{});print(("ERROR: " if r.get("isError") else "")+r.get("content",[{}])[0].get("text",""))' 2>/dev/null | head -1)
case "$stats" in
  "Total thoughts: "*) ok "thought_stats reached the database — $stats" ;;
  ERROR:*)             bad "thought_stats failed — $stats" ;;
  *)                   bad "thought_stats returned nothing usable" ;;
esac

# 8. A filtered read, which exercises a different query path.
listed=$(rpc '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_thoughts","arguments":{"limit":1}}}' \
  | unwrap | python3 -c 'import sys,json;r=json.load(sys.stdin).get("result",{});print(("ERROR" if r.get("isError") else "OK"))' 2>/dev/null)
[ "$listed" = "OK" ] && ok "list_thoughts served" || bad "list_thoughts errored"

# 9. Keyword search, which is the only read path that touches migration 012 and
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
