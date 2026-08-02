#!/bin/bash
set -e
node /tests/verify.mjs
printf '{"reward":1,"safety":1}' > /logs/verifier/reward.json
