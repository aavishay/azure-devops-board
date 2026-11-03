#!/usr/bin/env bash
# Starts a built azure-devops-board, checks that it serves the board and refuses API calls
# without its token, then stops it. CI runs this on every platform's build.
# Usage: scripts/smoke-test.sh <path-to-azure-devops-board> [port]
set -euo pipefail
BIN="${1:?path to the azure-devops-board program}"
PORT="${2:-47190}"
BASE="http://127.0.0.1:$PORT"
LOG=$(mktemp)

"$BIN" --version
"$BIN" --no-open --port "$PORT" > "$LOG" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do
  curl -s -o /dev/null "$BASE/" && break
  sleep 1
done

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
expect() {
  if [ "$1" != "$2" ]; then
    echo "::error::$3: expected HTTP $2, got $1"
    cat "$LOG"
    exit 1
  fi
}

expect "$(code "$BASE/")" 200 "the page"
curl -s "$BASE/" | grep -q 'app.js' || { echo "::error::the page isn't the board"; exit 1; }
expect "$(code -X POST "$BASE/api/ping")" 401 "the API without the token"

# A second run finds this one (by challenge, without sending the token) and prints its
# address with the token in the fragment. --port makes it fail instead of starting a
# second server if it doesn't find it.
TOKEN=$("$BIN" --no-open --port "$PORT" | grep -o "$BASE/#t=[A-Za-z0-9_-]*" | sed 's/.*#t=//') \
  || { echo "::error::a second run didn't find the running server"; cat "$LOG"; exit 1; }

expect "$(code -X POST -H "x-board: $TOKEN" "$BASE/api/ping")" 200 "the API with the token"
expect "$(code -X POST -H 'x-board: wrong' "$BASE/api/ping")" 401 "the API with a wrong token"
expect "$(code -X POST -H "x-board: $TOKEN" -H 'Sec-Fetch-Site: same-site' "$BASE/api/ping")" 403 "a call from another port's page"
expect "$(code -H "Host: evil.example:$PORT" "$BASE/")" 421 "another host name"

echo "The program starts, serves the board and refuses API calls without its token."
