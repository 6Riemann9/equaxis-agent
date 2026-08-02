#!/bin/bash
cat > /app/solution.mjs <<'EOF'
export function solve(s){const m=/^(d+)(ms|s|m|h)$/.exec(s);if(!m)throw Error('Invalid duration');return +m[1]*({ms:1,s:1000,m:60000,h:3600000}[m[2]]);}
EOF
