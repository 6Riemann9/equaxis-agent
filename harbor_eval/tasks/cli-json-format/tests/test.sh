#!/bin/bash
set +e
node /tests/verify.mjs
status=$?
mkdir -p /logs/verifier
if [ "$status" -eq 0 ]; then
  printf '{"reward":1,"json_output":1,"compatibility":1,"error_handling":1}\n' > /logs/verifier/reward.json
else
  printf '{"reward":0,"json_output":0,"compatibility":0,"error_handling":0}\n' > /logs/verifier/reward.json
fi
exit 0
