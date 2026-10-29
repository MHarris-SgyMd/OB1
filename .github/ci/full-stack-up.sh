#!/usr/bin/env bash
# The full-stack jobs' stack, brought up on a GitHub Actions runner (SMD-3051):
# four scoped keys minted, their raw values handed to the job's later steps
# through $GITHUB_ENV; a provider stub on the runner's port 11434; deploy/.env
# written; and compose.yaml built and up. The step body this replaces, moved
# verbatim; it runs from deploy/ whatever the caller's directory is.
#
#   - name: Bring up the compose stack
#     run: .github/ci/full-stack-up.sh
#
# CI only: it writes deploy/.env over whatever is there, and leaves the stub
# running for the job's life. Actions runs a step's `run:` under bash -e -o
# pipefail (the workflow's default shell), and so does this.
set -eo pipefail
: "${GITHUB_ENV:?GITHUB_ENV is not set: this runs as a GitHub Actions step}"
cd "$(dirname "$0")/../../deploy"

# Mint a real scoped key: the config holds only the hash, so the raw
# key has to be captured here for smoke.sh to authenticate with.
KEY=$(openssl rand -hex 32)
HASH=$(printf '%s' "$KEY" | shasum -a 256 | cut -d' ' -f1)
echo "OB1_SMOKE_KEY=$KEY" >> "$GITHUB_ENV"
# And a read-scoped key beside it, for deploy-stack's dashboard smoke
# (SMD-1801): a read key must get a read-only dashboard.
READ_KEY=$(openssl rand -hex 32)
READ_HASH=$(printf '%s' "$READ_KEY" | shasum -a 256 | cut -d' ' -f1)
echo "OB1_SMOKE_READ_KEY=$READ_KEY" >> "$GITHUB_ENV"
# And a capture-only key (SMD-1298), which the dashboard must refuse at sign-in.
CAPTURE_KEY=$(openssl rand -hex 32)
CAPTURE_HASH=$(printf '%s' "$CAPTURE_KEY" | shasum -a 256 | cut -d' ' -f1)
echo "OB1_SMOKE_CAPTURE_KEY=$CAPTURE_KEY" >> "$GITHUB_ENV"
# And a forwarder (SMD-2284): grants nothing; the REST core reads it
# beside a caller's key on the mesh, and /api deletes it. The MCP server
# built on the REST core holds it as OB1_FORWARDER_KEY (SMD-2287), which
# compose requires.
FORWARD_KEY=$(openssl rand -hex 32)
FORWARD_HASH=$(printf '%s' "$FORWARD_KEY" | shasum -a 256 | cut -d' ' -f1)
echo "OB1_SMOKE_FORWARD_KEY=$FORWARD_KEY" >> "$GITHUB_ENV"
# No OPENROUTER_API_KEY: the provider is a local endpoint, which
# needs no credential (preflight decides). Preflight dials it
# (GET /models, SMD-1875), and the steps that seed or search thoughts
# embed through it (POST /v1/embeddings: deploy-stack-brains' tier and
# canary steps, deploy-stack-auth's stream probe, the observability job's
# traffic, whose capture's metadata call is the stub's 404 that its
# provider panels and alert read); smoke.sh captures nothing and preflight
# runs without --deep, so a listener on the runner answering those
# two is the whole provider: the runner is the container's
# host.docker.internal (compose.yaml's extra_hosts host-gateway), and
# the listener binds every interface because host-gateway is the
# bridge address, not loopback. The address is neither the code's
# default nor the compose fallback, so the log line deploy-stack's
# .env step reads can only come from this file (SMD-1843); the query
# log likewise. OB1_LLM_LOCAL declares the endpoint to the egress gate
# (SMD-1903), which reads the flag and never the address; that step's
# line holds the forward. The embeddings (SMD-2038) are a bag of words
# hashed into dimensions 1–1023 of the stack's 1024, the model's
# query instruction left off as the model reads it, so a text is
# near itself and far from another; the probe thoughts are seeded
# with the stub's own vectors for their text. While
# /tmp/provider-stub-wrong exists it is a provider serving another
# model: each vector turned mostly onto dimension 0, which no word
# reaches, so a text still ranks its own thought first but at about
# 30%, under the canary smoke's 50% floor, on every run. While
# /tmp/provider-stub-slow exists GET /models answers after 2 s, inside
# preflight's 2.5 s probe, so a server started then is still in
# preflight 2 s on (deploy-stack's SIGTERM step, SMD-2250). While
# /tmp/provider-stub-slow-embed exists an embedding answers after
# 6 s, so a search's SSE stream carries the server's 5 s keepalive
# frame before its result (deploy-stack-auth's proxy step, SMD-1846).
nohup python3 - <<'PY' > /tmp/provider-stub.log 2>&1 &
import json, math, os, re, time, zlib
from http.server import BaseHTTPRequestHandler, HTTPServer
def embed(text):
    text = (text or "").split("\nQuery: ", 1)[-1]
    v = [0.0] * 1024
    for w in re.findall(r"[a-z]+", text.lower()):
        v[1 + zlib.crc32(w.encode()) % 1023] += 1.0
    n = math.sqrt(sum(x * x for x in v))
    return [x / n for x in v] if n else [0.0, 1.0] + [0.0] * 1022
def wrong(text):
    v = [0.3 * x for x in embed(text)]
    v[0] = 0.95
    n = math.sqrt(sum(x * x for x in v))
    return [x / n for x in v]
class H(BaseHTTPRequestHandler):
    def reply(self, body):
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if os.path.exists("/tmp/provider-stub-slow"): time.sleep(2)
        self.reply(b'{"object":"list","data":[]}')
    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if not self.path.endswith("/embeddings"):
            self.send_error(404); return
        if os.path.exists("/tmp/provider-stub-slow-embed"): time.sleep(6)
        inputs = req.get("input"); inputs = inputs if isinstance(inputs, list) else [inputs]
        f = wrong if os.path.exists("/tmp/provider-stub-wrong") else embed
        data = [{"object": "embedding", "index": i, "embedding": f(t)} for i, t in enumerate(inputs)]
        self.reply(json.dumps({"object": "list", "data": data, "model": req.get("model")}).encode())
HTTPServer(("0.0.0.0", 11434), H).serve_forever()
PY
# OB1_GIT_SHA reaches the image as compose's build arg (SMD-2041),
# and the smoke step asserts the health body reports it. The quoted
# password and the commented OB1_EMBEDDING_DIM are shapes an operator
# writes; compose reads them as the bare values, and deploy/tier.sh
# must too (SMD-2036): a literal read hands pg_dump a quoted password
# and migrate.ts a width of "1024   # …", and the tier step fails.
cat > .env <<EOF
POSTGRES_PASSWORD="$(openssl rand -hex 24)"
OB1_EMBEDDING_DIM=1024   # the stack's default, written out as an operator would
MCP_ACCESS_KEYS=ci:write:$HASH,ci-read:read:$READ_HASH,ci-capture:capture:$CAPTURE_HASH,ci-forwarder:forward:$FORWARD_HASH
OB1_LLM_BASE_URL=http://host.docker.internal:11434/v1
OB1_LLM_LOCAL=1
OB1_QUERY_LOG=on
SERVER_PORT=8010
OB1_GIT_SHA=$GITHUB_SHA
OB1_FORWARDER_KEY=$FORWARD_KEY
EOF
# The pull beside the build (SMD-3466): `up --build` pulled its images and
# only then built, 6–13 s of pull and 13–20 s of build one after the other.
# The pulled services are those with no build of their own whose image no
# service builds. mcp and app run api's image: `pull`, even with
# --ignore-buildable, asks the registry for it and is refused, so they are
# left out, as up leaves them out. --quiet keeps the pull's progress out of
# the build's log (each service's Pulling and Pulled lines and any error
# still show); a failed pull fails the step at its wait, after the build, and
# a failed build takes the pull down with it.
mapfile -t pulled < <(docker compose -f compose.yaml config --format json | jq -r '
  [.services[] | select(.build) | .image] as $built
  | .services | to_entries[] | select(.value.build == null)
  | select(.value.image as $i | $built | index($i) | not) | .key')
[ ${#pulled[@]} -gt 0 ] || { echo "compose config failed (above) or names no service to pull" >&2; exit 1; }
docker compose -f compose.yaml pull --quiet "${pulled[@]}" &
pull_pid=$!
trap 'kill "$pull_pid" 2> /dev/null || true' EXIT
docker compose -f compose.yaml build
trap - EXIT
wait "$pull_pid"
docker compose -f compose.yaml up -d --no-build --wait --wait-timeout 240
