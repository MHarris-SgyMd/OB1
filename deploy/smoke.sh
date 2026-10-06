#!/usr/bin/env bash
# Smoke-test a running Open Brain server over MCP.
#
# Point it at anything that speaks the protocol — the compose stack, a container on
# EKS, a Cloudflare Worker. It only needs the URL and the access key, so the same
# check works for every deployment target.
#
#   ./smoke.sh                                    # reads deploy/.env
#   ./smoke.sh https://ob1.example.com/mcp "$KEY"
#
# Given no URL it smokes the compose stack's endpoint, http://127.0.0.1:<SERVER_PORT>/mcp:
# the proxy's port and the server's path on it (SMD-1846). The URL is the
# endpoint a client is given, not the origin: check 2 derives the origin from it.
#
# Exit 0 if the deployment is serving correctly, 1 otherwise. Read-only: it never
# captures a thought, so it is safe against production.
#
# Checks 2, 3, 4 and 10 are the ones a Supabase Edge Function deployment cannot
# pass; FORK.md changes 42 and 75 say why, and why those failures are real (10:
# upstream's server has no keyed health body, SMD-2041).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

own_stack=""
if [ $# -ge 2 ]; then
  BASE="$1"; KEY="$2"
elif [ -f "$HERE/.env" ]; then
  own_stack=1
  BASE="http://127.0.0.1:$(grep -E '^SERVER_PORT=' "$HERE/.env" | cut -d= -f2 || echo 8000)/mcp"
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
authority=${BASE#*://}; authority=${authority%%[/?#]*}
case "$authority" in
  *@*) echo "base-url carries credentials (user@host); pass the key as the second argument, and the URL as clients are given it" >&2; exit 2 ;;
esac
case "$BASE" in
  *\?*) echo "base-url carries a query string; pass the key as the second argument, not in the URL" >&2; exit 2 ;;
  *#*) echo "base-url carries a fragment (#…); pass the URL as clients are given it" >&2; exit 2 ;;
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
#    tear the connection down instead of surfacing the error. The 200 alone proves
#    nothing: a server with no key check answers initialize with a result. So the
#    body must be the Unauthorized error (-32001, JSON_RPC_UNAUTHORIZED_CODE in
#    server-portable/index.ts), asked twice: with no key, and with a key that is
#    not one of the server's, which is the comparison and not only the presence
#    check (SMD-2103, from recipes/brain-smoke-test's Auth category). Asked at
#    "$BASE/", which is never the public resource: a keyless request at exactly
#    <origin>/mcp of a stack advertising OAuth gets a deliberate 401, check 2's.
# Prints the JSON-RPC error code of an initialize sent with these curl arguments,
# or what came back instead.
refusal() {
  local out code
  out=$(curl -s --max-time 20 -w '\n%{http_code}' -H 'Content-Type: application/json' "$@" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' "$BASE/")
  code=${out##*$'\n'}
  [ "$code" = "200" ] || { echo "HTTP $code"; return; }
  printf '%s\n' "${out%$'\n'*}" | unwrap \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["error"]["code"] if "error" in d else "a result, not an error")' 2>/dev/null \
    || echo "HTTP 200 with no JSON-RPC envelope"
}
r=$(refusal)
[ "$r" = "-32001" ] && ok "no key → HTTP 200 with JSON-RPC error -32001" \
                   || bad "no key → $r (expected HTTP 200 with JSON-RPC error -32001)"
r=$(refusal -H 'x-brain-key: ob1-smoke-not-a-configured-key')
[ "$r" = "-32001" ] && ok "a wrong key → HTTP 200 with JSON-RPC error -32001" \
                   || bad "a wrong key → $r (expected HTTP 200 with JSON-RPC error -32001)"

# 2. OAuth discovery: claude.ai fetches this at the ORIGIN root (server path as a
#    suffix) before opening a connector, and proceeds on the key only on a 404.
#    Probed without the key: the SDK copies the connector URL's query onto its
#    first, path-aware discovery GET (the root fallback carries none), but the
#    route answers before authenticate() whether or not a key rides along,
#    so a keyless probe asks the same question. FORK.md
#    change 42 has the rest, including the two deployment shapes that answer
#    this path before the server does.
#
#    Unless OAuth is advertised at this origin (SMD-2382). The document decides,
#    since it is what a connector reads: this server answers it only with a 404
#    or naming <origin>/mcp, its own resource. For a URL at <origin>/mcp or at
#    the origin root (the legacy window's), a document naming exactly
#    <origin>/mcp must come with the challenge on a keyless request there, a
#    404 at the root form, and the authorization server's metadata naming the
#    issuer <origin>/auth. The server's keyed /health is read for one verdict
#    only: when it says it advertises at exactly this origin and a 404 reached
#    smoke instead, the tunnel or proxy in front does not keep the origin's
#    Host, or does not route the document. A URL under another path is asked at
#    its own path form and the root form (a tier at a prefix is reached with
#    keys; OAuth per tier is SMD-2286's).
#    The origin is compared as typed: the server's is canonical, so a URL
#    spelled otherwise (`:443`, upper case) is told the one to use.
origin=$(printf '%s' "$BASE" | sed -E 's#^([A-Za-z]+://[^/]+).*#\1#')
suffix="${BASE#"$origin"}"
disc="$origin/.well-known/oauth-protected-resource"
hj=$(curl -s --max-time 20 -H "x-brain-key: $KEY" "$BASE/health")
# The run's first keyed request: a registry not yet warm can miss the body's
# deadline and answer `ok`. One keyed call warms it, then read again (review
# pass 6 of cut 2); a key it does not show the record to stays `ok`.
viewless=""
case "$hj" in
  "{"*) ;;
  *) rpc '{"jsonrpc":"2.0","id":0,"method":"tools/list","params":{}}' > /dev/null
     hj=$(curl -s --max-time 20 -H "x-brain-key: $KEY" "$BASE/health")
     case "$hj" in "{"*) ;; *) viewless=1 ;; esac ;;
esac
# The server's view, when the body is its record: advertised, at which origin,
# configured. Anything else (`ok` for a key it does not show the record to, a
# server from before SMD-2382) reads as not advertised and not configured.
view=$(printf '%s' "$hj" | python3 -c '
import sys, json
d = json.load(sys.stdin)
o = d.get("oauth") if isinstance(d, dict) else None
o = o if isinstance(o, dict) else {}
print("\x1f".join(["yes" if o.get("advertised") is True else "no", o.get("origin") or "", "yes" if o.get("configured") is True else "no"]))' 2>/dev/null)
IFS=$'\x1f' read -r advertised adv_origin configured <<<"${view:-no}"
mine=""
[ "${advertised:-no}" = yes ] && [ "$adv_origin" = "$origin" ] && mine=1
# The same origin spelled otherwise: lower case, the scheme's default port
# dropped. No more than that — the server's spelling is the one to give.
spelled() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's#^(https://[^/]+):443$#\1#; s#^(http://[^/]+):80$#\1#'; }
respell=""
[ "${advertised:-no}" = yes ] && [ -z "$mine" ] && [ "$(spelled "$adv_origin")" = "$(spelled "$origin")" ] && respell=1
note=""
if [ "${advertised:-no}" = yes ] && [ -z "$mine" ]; then note="; the server advertises OAuth at ${adv_origin}/mcp, not at this origin"
elif [ "${configured:-no}" = yes ] && [ "${advertised:-no}" != yes ]; then note="; the stack is configured, but its authorization server did not answer the server's probe, so nothing is advertised"; fi
root_form=$(status "$disc")
case "$suffix" in
  ""|/mcp)
    doc=$(curl -sL --max-redirs 5 --max-time 20 -w '\n%{http_code}' "$disc/mcp")
    doc_code=${doc##*$'\n'}
    resource=$(printf '%s' "${doc%$'\n'*}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("resource") or "")' 2>/dev/null)
    if [ "$doc_code" = 200 ] && [ "$resource" = "$origin/mcp" ]; then
      ch=$(curl -s --max-time 20 -D - -o /dev/null -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
        -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' "$origin/mcp" | tr -d '\r')
      ch_code=$(printf '%s\n' "$ch" | sed -n '1s/^HTTP\/[0-9.]* \([0-9]*\).*/\1/p')
      challenge=$(printf '%s\n' "$ch" | sed -n 's/^[Ww][Ww][Ww]-[Aa]uthenticate: *//p' | head -1)
      wrong=""
      [ "$challenge" = "Bearer resource_metadata=\"$disc/mcp\"" ] || wrong="; a keyless request at $origin/mcp answered HTTP ${ch_code:-none} with the challenge '${challenge:-none}'"
      [ "$root_form" = 404 ] || wrong="$wrong; the root form answered HTTP $root_form, not 404"
      # The authorization server's metadata through the same front: one that
      # routes /mcp and the document but not /auth leaves every sign-in to
      # fail (review pass 6). Its issuer is built from the same origin, exactly.
      as=$(curl -sL --max-redirs 5 --max-time 20 -w '\n%{http_code}' "$origin/.well-known/oauth-authorization-server/auth")
      as_code=${as##*$'\n'}
      issuer=$(printf '%s' "${as%$'\n'*}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("issuer") or "")' 2>/dev/null)
      if [ "$as_code" != 200 ]; then wrong="$wrong; the authorization server's metadata at $origin/.well-known/oauth-authorization-server/auth answered HTTP $as_code"
      elif [ "$issuer" != "$origin/auth" ]; then wrong="$wrong; the authorization server's metadata named the issuer '$issuer', not $origin/auth"; fi
      at=""
      [ -z "$suffix" ] && at="; judged at $origin/mcp: a connector given the root URL asks only the root form, a 404, and proceeds on its key"
      if [ -z "$wrong" ]; then
        ok "OAuth advertised at $origin/mcp: the document names it, a keyless request there gets the challenge, the root form is a 404, the authorization server answers as $issuer (the origin's Host reaches the server$at; SMD-2382)"
      else
        bad "OAuth is advertised at $origin/mcp, but${wrong#;} (SMD-2382)"
      fi
    elif [ -n "$respell" ]; then
      bad "OAuth is advertised at $adv_origin/mcp, which this URL spells otherwise — give smoke the URL as the server spells it, $adv_origin$suffix, so its Host is the one the server matches (SMD-2382)"
    elif [ -n "$mine" ]; then
      bad "OAuth is advertised at $origin/mcp (the server's keyed /health says so), but the document answered HTTP $doc_code${resource:+ naming $resource} — the tunnel or proxy in front does not deliver the origin's Host, or does not route the document (SMD-2382)"
    elif [ "$doc_code" = 200 ] && [ -n "$resource" ]; then
      bad "OAuth discovery: $disc/mcp → HTTP 200 naming '$resource' — give smoke the URL at the origin the document names (SMD-2382)"
    elif [ "$doc_code" = 404 ] && [ "$root_form" = 404 ]; then
      [ -n "$viewless" ] && note="$note; the keyed /health gave no record (a key it does not show it to), so a front that drops the Host could not be told from no OAuth"
      ok "OAuth discovery → HTTP 404 at $disc and $disc/mcp (no OAuth here; the connector proceeds on the key$note)"
    else
      miss="$disc → HTTP $root_form"
      [ "$doc_code" = 404 ] || miss="$disc/mcp → HTTP $doc_code"
      bad "OAuth discovery: $miss (expected 404 — route /.well-known/ to the server or 404 it at the proxy; FORK.md change 42$note)"
    fi ;;
  *)
    [ -n "$mine" ] && note="; the server advertises OAuth at $origin/mcp, not at this path"
    path_form=$(status "$disc$suffix")
    if [ "$path_form" = 404 ] && [ "$root_form" = 404 ]; then
      ok "OAuth discovery → HTTP 404 at $disc and $disc$suffix (no OAuth here; the connector proceeds on the key$note)"
    else
      miss="$disc → HTTP $root_form"
      [ "$path_form" = 404 ] || miss="$disc$suffix → HTTP $path_form"
      bad "OAuth discovery: $miss (expected 404 — route /.well-known/ to the server or 404 it at the proxy; FORK.md change 42$note)"
    fi ;;
esac
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

# 6. The full documented tool surface, read from server-portable/tools.json —
#    generated from the typed source server-portable/tools.ts, which the test
#    suites read too, so this check and they stay one source (SMD-1805). A write
#    key sees every tool; capture_thought,
#    update_thought and delete_thought are scope-gated, so a read key would
#    legitimately show fewer — this smoke test authenticates as a writer.
#    Run standalone against a remote with no checkout, the manifest is absent:
#    the surface is reported rather than asserted, so the other checks still run.
tools=$(rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | unwrap | python3 -c 'import sys,json;print(",".join(sorted(t["name"] for t in json.load(sys.stdin)["result"]["tools"])))' 2>/dev/null)
manifest="$HERE/../server-portable/tools.json"
if [ -r "$manifest" ]; then
  expected=$(python3 -c 'import sys,json;print(",".join(sorted(t["name"] for t in json.load(open(sys.argv[1]))["tools"])))' "$manifest" 2>/dev/null)
  { [ -n "$expected" ] && [ "$tools" = "$expected" ]; } \
    && ok "tool surface matches the manifest ($expected)" \
    || bad "tool surface is '$tools' (manifest expects '$expected')"
else
  [ -n "$tools" ] && ok "tool surface exposed (no manifest present to assert against): $tools" \
                  || bad "tools/list returned no tools"
fi

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

# 10. What the brain is (SMD-2041): GET /health WITH the key answers the
#     brain_info tool's record as JSON — check 4's keyless probe still gets
#     `ok`. Printed: the version, the commit the image was built from, the
#     ledger's highest migration and how it stands against the server's tree.
#     With OB1_SMOKE_COMMIT set — CI sets the commit it built this image from —
#     asserted: the commit, and the version and the tree's last migration are
#     this checkout's (server-portable/version.ts; the version alone does not
#     move between cuts). Without it they are printed beside the checkout's,
#     not asserted: smoke.sh is pointed at pinned deployments from any
#     checkout. No -L: curl forwards a custom header to whatever host a
#     redirect names, and this one carries the key.
#     A Supabase Edge Function fails here too: upstream has no such body.
#     Read at check 2, which reads the edge's view from it and reads it again
#     after one warming call when the first read gave no record (SMD-2382);
#     once more here if it still gave none, now that checks 5–9 have run.
case "$hj" in "{"*) ;; *) hj=$(curl -s --max-time 20 -H "x-brain-key: $KEY" "$BASE/health") ;; esac
facts=$(printf '%s' "$hj" | python3 -c '
import sys, json
d = json.load(sys.stdin); db = d.get("database") or {}
hi = ("error: " + db["error"][:80]) if "error" in db else ("%03d" % db["highestMigration"] if db.get("highestMigration") is not None else "none")
print("\x1f".join([d.get("version", ""), d.get("commit", ""), hi, d.get("ledgerStatus") or "not judged", str(d.get("latestMigration", ""))]))' 2>/dev/null)
# \x1f, not a tab: read collapses runs of an IFS whitespace character, so an
# empty field would shift the ones after it (review pass 1).
IFS=$'\x1f' read -r hv hc hm hl hlast <<<"$facts"
vfile="$HERE/../server-portable/version.ts"
want=""; wantLast=""
[ -r "$vfile" ] && want=$(sed -nE 's/^export const FORK_VERSION = "([^"]+)";$/\1/p' "$vfile")
[ -r "$vfile" ] && wantLast=$(sed -nE 's/^export const LATEST_MIGRATION = ([0-9]+);$/\1/p' "$vfile")
if [ -z "${hv:-}" ]; then
  # The body is `ok` for every key that may not see the record: a server from
  # before SMD-2041 (or an Edge Function), a revoked key, a key without read
  # scope, an agent registry that has not answered within the health
  # deadline, and one locked past the lookup's retries (busy, SMD-2072) — the
  # MCP checks above then fail too, with JSON-RPC -32003.
  bad "GET /health with the key → '$(printf '%s' "$hj" | head -c 60)' (expected the brain's record as JSON: a server from before SMD-2041, a revoked or read-less key, or an agent registry that did not answer within the deadline or was locked past the lookup's retries)"
elif [ -n "${OB1_SMOKE_COMMIT:-}" ] && [ -n "$want" ] && [ "$hv" != "$want" ]; then
  bad "GET /health with the key → version $hv, but this checkout is $want (the image was not built from it)"
elif [ -n "${OB1_SMOKE_COMMIT:-}" ] && [ -n "$wantLast" ] && [ "$hlast" != "$wantLast" ]; then
  bad "GET /health with the key → the server's tree ends at migration $hlast, but this checkout's ends at $wantLast (the image was not built from it)"
elif [ -n "${OB1_SMOKE_COMMIT:-}" ] && [ "$hc" != "$OB1_SMOKE_COMMIT" ]; then
  bad "GET /health with the key → commit $hc, expected $OB1_SMOKE_COMMIT (the build arg did not reach the image)"
else
  checkout=""
  if [ -z "${OB1_SMOKE_COMMIT:-}" ] && [ -n "$want" ]; then
    { [ "$hv" = "$want" ] && [ "$hlast" = "$wantLast" ]; } && checkout=" (the checkout's)" || checkout=" (this checkout: $want, tree to $wantLast)"
  fi
  ok "GET /health with the key → version $hv, tree to $hlast$checkout, commit $hc, highest migration $hm (ledger: $hl)"
fi

# 11. The old root URL (SMD-2306). Behind this stack's proxy the root still
#     answers for a window that closes with v2.0.0, and every answer says so:
#     a Deprecation header and a Link to the upgrade guide. From 2.0.0 it is
#     the proxy's 404 (SMD-2532). Judged only when no URL was given, so the
#     target is this stack's own proxy: told apart by its body alone, any
#     Traefik in front (a user's own, k3s's ingress) would pass for it, and a
#     server with no proxy in front rightly answers at every path with no
#     header. Given a URL, the answer is reported, not counted. No key: the
#     refusal carries the headers too (measured), and a keyed probe would put
#     the smoke key's name in the server's "old root URL" log, where an
#     operator looks for clients still to move (review pass 1).
root_h=$(curl -s --max-time 20 -D - -o /dev/null -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":11,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' \
  "$origin/" | tr -d '\r')
root_code=$(printf '%s\n' "$root_h" | sed -n '1s/^HTTP\/[0-9.]* \([0-9]*\).*/\1/p')
root_dep=$(printf '%s\n' "$root_h" | sed -n 's/^[Dd]eprecation: *//p' | head -1)
root_link=$(printf '%s\n' "$root_h" | grep -i '^link:' | grep -c 'rel="deprecation"')
said="POST $origin/ → HTTP ${root_code:-none}, Deprecation '${root_dep}', $root_link deprecation Link"
if [ -z "$own_stack" ]; then
  echo "  ·  $said (reported, not counted: run with no URL to judge this stack's own proxy; SMD-2306)"
elif [ "$root_code" = "200" ] && [ -n "$root_dep" ] && [ "$root_link" -ge 1 ]; then
  ok "POST $origin/ → 200, deprecated (Deprecation: $root_dep, Link rel=deprecation): move its clients to $origin/mcp before v2.0.0 (SMD-2306)"
elif [ "$root_code" = "404" ] && [ "${hv%%.*}" -ge 2 ] 2>/dev/null; then
  ok "POST $origin/ → the proxy's 404 at $hv: the old root URL is retired; clients use $origin/mcp (SMD-2532)"
elif [ "$root_code" = "502" ] || [ "${root_code:-000}" = "000" ]; then
  bad "$said: the legacy route got no answer from the server (a 502 or no connection), so the window could not be judged"
else
  bad "$said (expected 200 with both, the legacy route's window, until 2.0.0, and the proxy's 404 from it; SMD-2306)"
fi

echo
echo "$((pass+fail)) checks: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
