#!/usr/bin/env bash
# M2 end-to-end verification: serve (webhook + worker) with isolated HOME.
# Run from the repo root:  bash scripts/companion-e2e-m2.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${1:-7899}"

echo "== resetting researcher's private HOME =="
rm -rf .pi/companion/home/researcher

echo "== starting companion serve on :$PORT =="
node scripts/companion.mjs serve --port "$PORT" > /tmp/companion-e2e.log 2>&1 &
SERVE_PID=$!
trap 'kill $SERVE_PID 2>/dev/null || true' EXIT
sleep 2

CRED=$(cat .pi/companion/webhook-token)
echo "== healthz =="
curl -s "http://127.0.0.1:$PORT/healthz"; echo

echo "== webhook: submit task (must report sandbox + isolated HOME) =="
curl -s -X POST "http://127.0.0.1:$PORT/task/researcher" \
  -H "authorization: Bearer $CRED" -H "content-type: application/json" \
  -d '{"instruction":"Run: echo $HOME. In one sentence confirm which HOME directory you run in, then RESULT with the path."}'; echo

echo "== waiting for the task to finish (check every 10s, max 3min) =="
for i in $(seq 1 18); do
  sleep 10
  if node scripts/companion.mjs status --all | grep -q "HOME directory you run in"; then
    echo "== result =="
    node scripts/companion.mjs status --all | grep -A4 "HOME directory you run in"
    echo
    echo "== expected: \$HOME = <repo>/.pi/companion/home/researcher  →  isolated HOME is LIVE =="
    exit 0
  fi
done
echo "TIMEOUT — task did not finish in 3 minutes; inspect /tmp/companion-e2e.log and: node scripts/companion.mjs status --all"
exit 1
