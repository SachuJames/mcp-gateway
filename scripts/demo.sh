#!/usr/bin/env bash
# End-to-end demo: starts the gateway with two demo MCP servers and
# exercises routing, authz, guardrails, and rate limiting over real
# local processes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${MCP_GW_PORT:-8099}"
ADMIN_TOKEN="demo-admin-token"
export MCP_GW_ADMIN_TOKEN="$ADMIN_TOKEN"
export MCP_GW_PORT="$PORT"
export MCP_GW_HOST="127.0.0.1"
export MCP_GW_LOG_DIR="$ROOT/logs"

PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); echo "  PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1"; exit 1; }; }
need node; need npm; need curl; need python3

echo "== building =="
npm run build --prefix "$ROOT" >/dev/null 2>&1 && ok "gateway builds" || { bad "gateway build"; exit 1; }

echo "== starting gateway on :$PORT =="
node "$ROOT/dist/index.js" >"$ROOT/logs/demo-gateway.log" 2>&1 &
GW_PID=$!
trap 'kill $GW_PID 2>/dev/null || true' EXIT

for i in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null || { bad "gateway did not start"; exit 1; }
ok "gateway is up"

ADMIN=(-H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json")

echo "== registering demo upstream servers =="
CALC_ID=$(curl -sf "${ADMIN[@]}" -d '{"name":"calc","transport":{"type":"stdio","command":"node","args":["demo-servers/calc.ts"],"cwd":"'"$ROOT"'"}}' \
  "http://127.0.0.1:$PORT/admin/servers" | python3 -c "import json,sys; print(json.load(sys.stdin)['server']['id'])")
[ -n "$CALC_ID" ] && ok "calc server registered ($CALC_ID)" || bad "calc registration"

NOTES_ID=$(curl -sf "${ADMIN[@]}" -d '{"name":"notes","transport":{"type":"stdio","command":"node","args":["demo-servers/notes.ts"],"cwd":"'"$ROOT"'"}}' \
  "http://127.0.0.1:$PORT/admin/servers" | python3 -c "import json,sys; print(json.load(sys.stdin)['server']['id'])")
[ -n "$NOTES_ID" ] && ok "notes server registered ($NOTES_ID)" || bad "notes registration"

echo "== creating api keys =="
FULL_KEY=$(curl -sf "${ADMIN[@]}" -d '{"name":"demo-full","servers":["*"]}' \
  "http://127.0.0.1:$PORT/admin/keys" | python3 -c "import json,sys; print(json.load(sys.stdin)['secret'])")
CALC_KEY=$(curl -sf "${ADMIN[@]}" -d '{"name":"demo-calc-only","servers":["calc"]}' \
  "http://127.0.0.1:$PORT/admin/keys" | python3 -c "import json,sys; print(json.load(sys.stdin)['secret'])")
TINY_KEY=$(curl -sf "${ADMIN[@]}" -d '{"name":"demo-tiny","servers":["calc"],"rateLimit":{"capacity":2,"refillPerSecond":0.001}}' \
  "http://127.0.0.1:$PORT/admin/keys" | python3 -c "import json,sys; print(json.load(sys.stdin)['secret'])")
ok "three api keys created"

echo "== tools/list through the gateway =="
TOOLS=$(curl -sf -H "Authorization: Bearer $FULL_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "http://127.0.0.1:$PORT/mcp" \
  | python3 -c "import json,sys; print(' '.join(t['name'] for t in json.load(sys.stdin)['result']['tools']))")
echo "  tools: $TOOLS"
case "$TOOLS" in
  *calc__add*notes__note_set*) ok "qualified tool names listed" ;;
  *) bad "tool listing" ;;
esac

echo "== tools/call calc__add =="
RESULT=$(curl -sf -H "Authorization: Bearer $FULL_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"calc__add","arguments":{"a":40,"b":2}}}' \
  "http://127.0.0.1:$PORT/mcp" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['content'][0]['text'])")
[ "$RESULT" = "42" ] && ok "calc__add returned 42" || bad "calc__add returned: $RESULT"

echo "== authz denial: calc-only key calling notes =="
DENIED=$(curl -sf -H "Authorization: Bearer $CALC_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"notes__note_get","arguments":{"key":"x"}}}' \
  "http://127.0.0.1:$PORT/mcp" | python3 -c "import json,sys; print(json.load(sys.stdin)['error']['code'])")
[ "$DENIED" = "-32005" ] && ok "out-of-scope call denied (-32005)" || bad "denial code: $DENIED"

echo "== rate limiting: 3 rapid calls on a 2-token bucket =="
CODES=""
for i in 1 2 3; do
  CODE=$(curl -sf -H "Authorization: Bearer $TINY_KEY" -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":'$i',"method":"tools/call","params":{"name":"calc__now","arguments":{}}}' \
    "http://127.0.0.1:$PORT/mcp" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d['error']['code'] if 'error' in d else 0)")
  CODES="$CODES $CODE"
done
echo "  codes:$CODES"
[ "$CODES" = " 0 0 -32003" ] && ok "third call rate limited (-32003)" || bad "rate limit codes:$CODES"

echo "== audit log =="
LOGS=$(curl -sf "${ADMIN[@]}" "http://127.0.0.1:$PORT/admin/logs?limit=5" \
  | python3 -c "import json,sys; print(len(json.load(sys.stdin)['logs']))")
[ "$LOGS" -ge 5 ] && ok "audit log captured $LOGS entries" || bad "audit log has $LOGS entries"

echo
echo "DEMO RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
