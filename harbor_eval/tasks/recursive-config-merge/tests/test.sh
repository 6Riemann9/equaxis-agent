#!/bin/bash
set +e
node /tests/verify.mjs
status=$?
mkdir -p /logs/verifier
if [ "$status" -eq 0 ]; then
  printf '{"reward":1,"functional":1,"immutability":1}\n' > /logs/verifier/reward.json
else
  printf '{"reward":0,"functional":0,"immutability":0}\n' > /logs/verifier/reward.json
fi
exit 0
