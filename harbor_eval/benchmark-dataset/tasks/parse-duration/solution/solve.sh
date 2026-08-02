#!/bin/bash
cat > /app/solution.mjs <<'EOF'
export function solve(s){const unit=s.endsWith('ms')?'ms':s.at(-1),raw=s.slice(0,-unit.length),n=Number(raw);if(!raw||!Number.isInteger(n)||n<0||!['ms','s','m','h'].includes(unit))throw Error('Invalid duration');return n*({ms:1,s:1000,m:60000,h:3600000}[unit]);}
EOF
