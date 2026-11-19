#!/bin/bash
# One headless Claude Code session of TWO user turns against a running probe, the control step run from outside
# between them, then the probe's log of it:
#
#   ./run-claude-code-turns.sh <mcp|legacy|session> <toggle|toggle-quiet|expire|drop|down/N|refuse/N|busy/N|fault/N|cut/N> [seconds between step and turn 2, default 10]
#
# run-claude-code.sh makes the change inside one turn. This asks the other question: does the client fetch the list
# again when a NEW turn starts, with nothing sent to it? The session stays one process throughout; it reconnects
# only where the step makes it (a port closed with `refuse/N`).
# Read the result from the log, not from the model's report.
set -u
cd "$(dirname "$0")" || exit 1
path=${1:?path: mcp, legacy or session}
step=${2:?step: toggle, toggle-quiet, expire, drop, or down/N, refuse/N, busy/N, fault/N, cut/N for N seconds}
wait=${3:-10}
first_turn=${FIRST_TURN_S:-30}
base=${BASE:-http://127.0.0.1:8765}
log=${LOG:-probe.jsonl}

state=$(curl -sf "$base/control/state") || { echo "no probe at $base: start it with 'bun probe.ts'" >&2; exit 1; }
case $state in *'"toolSet":"A"'*) ;; *) curl -sf "$base/control/toggle" > /dev/null ;; esac
first=$(($(wc -l < "$log") + 1))
mark() { printf '{"at":"%s","event":"%s"%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$1" "${2:-}" >> "$log"; }
mark run-start ",\"client\":\"claude-code $(claude --version | cut -d' ' -f1)\",\"path\":\"/$path\",\"step\":\"$step\",\"turns\":2,\"waitS\":$wait"
turn() { printf '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"%s"}]}}\n' "$1"; }

{
  turn "This is a protocol test of an MCP server. Call the tool mcp__probe__probe_time once and quote its reply. Do nothing else."
  sleep "$first_turn"
  curl -s "$base/control/$step" > /dev/null
  sleep "$wait"
  mark turn-2
  turn "Second step of the same test. Say whether a tool named mcp__probe__probe_extra is available to you now; if it is, call it and quote its reply, and if it is not, say 'probe_extra not available'. Then call mcp__probe__probe_time once and quote its reply. Do nothing else."
  sleep "$first_turn"
} | claude -p --input-format stream-json --output-format stream-json --verbose --model haiku --strict-mcp-config --setting-sources project \
  --mcp-config "{\"mcpServers\":{\"probe\":{\"type\":\"http\",\"url\":\"$base/$path\"}}}" \
  --allowedTools "mcp__probe__probe_time" "mcp__probe__probe_extra" 2>&1 \
  | python3 -I -c '
import json, sys
for raw in sys.stdin:
    try:
        d = json.loads(raw)
    except ValueError:
        continue
    if d.get("type") == "result":
        print("--- turn result:", (d.get("result") or "")[:600])
'

mark run-end
echo "=== the probe's log of this run"
python3 -I show.py "$log" "$first"
