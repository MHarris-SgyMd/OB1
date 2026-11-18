#!/bin/bash
# One headless Claude Code session against a running probe, then the probe's log of it:
#
#   ./run-claude-code.sh <mcp|legacy|session> <toggle|toggle-quiet|expire|drop|down/N|refuse/N|busy/N|fault/N|cut/N> [seconds to wait, default 8]
#
# The session calls a tool, calls the control step itself, waits, says whether probe_extra is available and calls it.
# It is connected throughout, so the log shows what the step made the client do. Read the result from the log, not
# from the model's report. A headless session refuses a long sleep in the foreground (110 s was not run; 50 s the model ran in the
# background, and waited): for a longer
# wait use run-claude-code-turns.sh, which waits outside the session. The session runs from this directory with project settings only, so no user hook or
# user MCP server joins it; it spends tokens on the account `claude` is signed in to.
set -u
cd "$(dirname "$0")" || exit 1
path=${1:?path: mcp, legacy or session}
step=${2:?step: toggle, toggle-quiet, expire, drop, or down/N, refuse/N, busy/N, fault/N, cut/N for N seconds}
wait=${3:-8}
base=${BASE:-http://127.0.0.1:8765}
log=${LOG:-probe.jsonl}

state=$(curl -sf "$base/control/state") || { echo "no probe at $base: start it with 'bun probe.ts'" >&2; exit 1; }
# Start from tool set A.
case $state in *'"toolSet":"A"'*) ;; *) curl -sf "$base/control/toggle" > /dev/null ;; esac
first=$(($(wc -l < "$log") + 1))
printf '{"at":"%s","event":"run-start","client":"claude-code %s","path":"/%s","step":"%s","waitS":%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$(claude --version | cut -d' ' -f1)" "$path" "$step" "$wait" >> "$log"

prompt="This is a protocol test of an MCP server. Do exactly these steps in order and report plainly; do nothing else.
1. Call the tool mcp__probe__probe_time and quote its reply.
2. Run with Bash: curl -s $base/control/$step
3. Run with Bash: sleep $wait
4. Say whether a tool named mcp__probe__probe_extra is available to you now. If it is, call it and quote its reply. If it is not, say 'probe_extra not available'.
5. Call mcp__probe__probe_time again and quote its reply, or the error it gave."
claude -p "$prompt" --model haiku --strict-mcp-config --setting-sources project \
  --mcp-config "{\"mcpServers\":{\"probe\":{\"type\":\"http\",\"url\":\"$base/$path\"}}}" \
  --allowedTools "mcp__probe__probe_time" "mcp__probe__probe_extra" "Bash(curl:*)" "Bash(sleep:*)" < /dev/null 2>&1

printf '{"at":"%s","event":"run-end"}\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" >> "$log"
echo "=== the probe's log of this run"
python3 -I show.py "$log" "$first"
